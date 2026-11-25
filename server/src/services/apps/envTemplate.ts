import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import {
  APP_ENV_EXAMPLE_MAX_BYTES, dotenvExampleKeys, envExampleCandidates, type AppEnvTemplate, type AppEnvTemplateProbe,
} from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { loadAccount, type HostingActor } from '../hosting/access';
import { localPaths } from '../hosting/paths';
import { platformSettings } from '../platformSettings';
import { loadStack } from './access';
import { envKeysOf, type StackRow } from './rows';
import { appsDeps } from './deps';
import { kindNoFollow, mkdirNoFollow, readTextNoFollow, removeTreeNoFollow } from './fsSafe';
import {
  assertBranch, gitDetail, gitEnv, gitFailure, normalizeComposePath, normalizeRepoUrl, parseLsTree, probeCatBlobArgs, probeCloneArgs,
  probeLsTreeArgs, repoPinArgs,
} from './git';
import { gitToken, stackDir } from './sources';

// ─────────────────────────────────────────────────────────────────────────────
// .env example of an application (`.env.example`, `.env.sample`, `.env.dist`,
// `example.env`, in the directory of the compose file then at the root):
//  - existing stack: read in its source tree (src/, no link followed), or —
//    a git stack whose tree is not there — fetched from the repository;
//  - git repository of an application not created yet: a bounded lookup
//    (same URL rules, token, anti-SSRF pinning and hardening as the git
//    source, blob-less shallow clone in a temporary directory of the account
//    apps/ tree, one blob of at most 64 KiB read, 60 s per git step, one
//    lookup per account at a time, directory removed afterwards).
// The example is never applied by itself (its values are examples): the
// client merges the missing keys on request (shared mergeEnvExample). Its
// content is not secret; the audit keeps only the names of its keys.
// ─────────────────────────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 60_000;
const probing = new Set<number>();

/** The example of a tree read through `read` (relative to the source root), null when none. */
export function findEnvExample(read: (rel: string) => string | null, composePath: string | null): { file: string; content: string } | null {
  for (const file of envExampleCandidates(composePath)) {
    const content = read(file);
    if (content !== null) return { file, content };
  }
  return null;
}

/** API shape of an example found (or not) against the keys the stack .env already sets. */
export function envTemplateOf(found: { file: string; content: string } | null, currentKeys: readonly string[]): AppEnvTemplate {
  if (!found) return { file: null, content: null, keys: [], missingKeys: [] };
  const keys = dotenvExampleKeys(found.content);
  const have = new Set(currentKeys);
  return { file: found.file, content: found.content, keys, missingKeys: keys.filter((k) => !have.has(k)) };
}

/** Reads the example in the source tree of a stack (src/, no link followed), null when none / no tree. */
function readLocal(stack: StackRow): { found: { file: string; content: string } | null; tree: boolean } {
  const dir = stackDir(stack);
  if (kindNoFollow(dir, 'src') !== 'dir') return { found: null, tree: false };
  const composePath = stack.source_type === 'git' ? stack.git_compose_path : null;
  return { found: findEnvExample((rel) => readTextNoFollow(dir, `src/${rel}`, APP_ENV_EXAMPLE_MAX_BYTES), composePath), tree: true };
}

/**
 * Looks for the example in a repository without keeping anything: blob-less shallow clone under
 * accounts/<id>/apps/.probe-<random> (inside the account quota), `ls-tree` of the candidates, `cat-file`
 * of the first regular file found (≤ 64 KiB), directory removed. 400 / 502 like the git source.
 */
export async function probeRepository(accountId: number, repo: { url: string; branch: string; composePath: string; token: string | null }): Promise<{ file: string; content: string } | null> {
  if (probing.has(accountId)) throw new AppError(409, 'A repository lookup is already running for this account', 'stackBusy');
  probing.add(accountId);
  const appsRoot = localPaths.apps(accountId);
  let dir: string | null = null;
  try {
    const deps = appsDeps();
    const pin = await repoPinArgs(repo.url, deps.lookup, await deps.nodeAddresses());
    fs.mkdirSync(appsRoot, { recursive: true, mode: 0o711 });
    const st = fs.lstatSync(appsRoot);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`refusing ${appsRoot}: not a directory`);
    dir = mkdirNoFollow(appsRoot, `.probe-${crypto.randomBytes(6).toString('hex')}`, 0o700);
    const env = gitEnv(repo.token);
    const clone = await deps.git(probeCloneArgs(repo.url, repo.branch, 'repo', pin), { cwd: dir, env, timeoutMs: PROBE_TIMEOUT_MS });
    if (clone.code !== 0) {
      logger.info({ accountId, detail: gitDetail(clone, repo.token) }, 'apps: env example lookup, git clone failed');
      throw gitFailure(clone, repo.token);
    }
    const work = path.join(dir, 'repo');
    if (kindNoFollow(dir, 'repo') !== 'dir') return null;
    const candidates = envExampleCandidates(repo.composePath);
    const ls = await deps.git(probeLsTreeArgs(candidates, pin), { cwd: work, env, timeoutMs: PROBE_TIMEOUT_MS });
    if (ls.code !== 0) {
      logger.info({ accountId, detail: gitDetail(ls, repo.token) }, 'apps: env example lookup, git ls-tree failed');
      throw gitFailure(ls, repo.token);
    }
    const blobs = parseLsTree(ls.stdout);
    const file = candidates.find((c) => blobs.has(c));
    if (!file) return null;
    const blob = await deps.git(probeCatBlobArgs(blobs.get(file)!, pin), { cwd: work, env, timeoutMs: PROBE_TIMEOUT_MS });
    if (blob.code !== 0) {
      logger.info({ accountId, detail: gitDetail(blob, repo.token) }, 'apps: env example lookup, git cat-file failed');
      throw gitFailure(blob, repo.token);
    }
    // The runner caps its output at 64 KiB: a larger example is refused rather than truncated.
    if (Buffer.byteLength(blob.stdout, 'utf8') >= APP_ENV_EXAMPLE_MAX_BYTES) throw new AppError(400, `${file} is larger than ${APP_ENV_EXAMPLE_MAX_BYTES / 1024} KiB`, 'validation');
    if (blob.stdout.includes('\0')) return null;
    return { file, content: blob.stdout };
  } finally {
    if (dir) {
      try { removeTreeNoFollow(dir, appsRoot); } catch (err) { logger.warn({ err: (err as Error).message, accountId }, 'apps: env example lookup directory not removed'); }
    }
    probing.delete(accountId);
  }
}

function auditKeys(req: Request, tenantId: number, action: string, resource: { type: string; path: string }, details: Record<string, unknown>): Promise<void> {
  return auditService.logReqAs(req, tenantId, action, { resourceType: resource.type, resourcePath: resource.path, details });
}

export const envTemplateService = {
  /**
   * GET /apps/stacks/:id/env-template (apps.manage): the example of the stack source (git or ZIP tree;
   * editor and catalog stacks have none). Read in src/; a git stack without a tree fetches it (audited,
   * key names only).
   */
  async forStack(req: Request, actor: HostingActor, id: number): Promise<AppEnvTemplate> {
    const stack = await loadStack(actor, id, 'apps.manage') as StackRow;
    if (stack.source_type !== 'git' && stack.source_type !== 'zip') return envTemplateOf(null, []);
    const local = readLocal(stack);
    let found = local.found;
    if (!local.tree && stack.source_type === 'git' && stack.git_repo_url) {
      found = await probeRepository(stack.account_id, {
        url: stack.git_repo_url, branch: stack.git_branch ?? 'main', composePath: stack.git_compose_path ?? 'docker-compose.yml', token: gitToken(stack),
      });
      const out = envTemplateOf(found, envKeysOf(stack));
      await auditKeys(req, stack.tenant_id, 'apps.stack.envTemplate.fetch', { type: 'app_stack', path: String(stack.id) }, { file: out.file, keys: out.keys });
      return out;
    }
    return envTemplateOf(found, envKeysOf(stack));
  },

  /** POST /apps/git/env-template (apps.manage on the account): the example of a repository before the application exists. */
  async probe(req: Request, actor: HostingActor, input: AppEnvTemplateProbe): Promise<AppEnvTemplate> {
    const account = await loadAccount(actor, input.accountId, 'apps.manage');
    if (account.status === 'suspended' || account.status === 'deleting') throw new AppError(409, 'The hosting account is suspended', 'accountSuspended');
    if (!(await platformSettings.section('apps')).enabled) throw new AppError(409, 'Applications are disabled on this platform', 'appsDisabled');
    const url = normalizeRepoUrl(input.repoUrl);
    const repo = {
      url, branch: assertBranch(input.branch?.trim() || 'main'), composePath: normalizeComposePath(input.composePath), token: input.token?.trim() || null,
    };
    const out = envTemplateOf(await probeRepository(account.id, repo), []);
    await auditKeys(req, account.tenant_id, 'apps.git.envTemplate.fetch', { type: 'hosting_account', path: String(account.id) }, { repoUrl: url, file: out.file, keys: out.keys });
    return out;
  },
};
