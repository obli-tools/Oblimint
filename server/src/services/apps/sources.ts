import fs from 'fs';
import path from 'path';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { open, SecretBoxError } from '../../utils/secretBox';
import { localPaths } from '../hosting/paths';
import { platformSettings } from '../platformSettings';
import { appsDeps } from './deps';
import { kindNoFollow, mkdirNoFollow, readTextNoFollow, remappedInspector, removeTreeNoFollow } from './fsSafe';
import type { SourceInspector } from './compose/validate';
import { assertNoSymlinks, SourceTreeError } from './snapshots';
import { logger } from '../../utils/logger';
import { cloneArgs, gitDetail, gitEnv, gitFailure, lsRemoteArgs, parseLsRemote, redactGit, repoPinArgs } from './git';
import type { StackRow } from './rows';
import { extractZip, findComposeRoot, spoolUpload } from './zip';

// Source trees of the stacks (docs/P4b-PLAN.md §5.3) under accounts/<id>/apps/<stackId>/src (inside the
// account quota): a new tree is prepared in src.new, CHECKED there (no symbolic link nor special file
// anywhere — git runs with core.symlinks=false, the ZIP extractor refuses links — and, when the caller gives
// a validator, the compose validated against the staged tree), and only then swapped in (src.old removed
// without following links). A tree that fails is removed, src/ is left untouched. Running containers never
// bind src/: each deployment binds its own immutable snapshot (snapshots.ts). Reads of tenant content never
// follow a link (R1).

/** Validates the compose of a STAGED tree (paths under src/ are looked up in src.new/). Throws to refuse it. */
export type StagedValidator = (composeYaml: string, inspector: SourceInspector) => Promise<void>;

/** Refuses a staged tree holding a symbolic link / special file (400 composeInvalid, issue symlinkInPath). */
function assertStagedTree(dir: string, fresh: string): void {
  try {
    assertNoSymlinks(fresh);
  } catch (err) {
    removeTreeNoFollow(fresh, dir);
    if (err instanceof SourceTreeError) {
      throw new AppError(400, `The source contains a symbolic link or a special file (${err.rel.slice(0, 120) || '/'}): not allowed`, 'composeInvalid', {
        issues: [{ severity: 'error', code: 'symlinkInPath', service: null, path: '', message: err.message, line: null }],
      });
    }
    throw err;
  }
}

/** Runs the caller's validator on the staged tree; on refusal the staged tree is removed. */
async function validateStaged(dir: string, fresh: string, composeYaml: string, validate: StagedValidator | undefined): Promise<void> {
  if (!validate) return;
  try {
    await validate(composeYaml, remappedInspector(dir, 'src', path.basename(fresh)));
  } catch (err) {
    removeTreeNoFollow(fresh, dir);
    throw err;
  }
}

const GIT_TIMEOUT_MS = 5 * 60_000;

/**
 * One source operation per stack at a time (manual pull, git poll, ZIP upload, initial clone): they all
 * stage into the fixed src.new / src.inner, so two of them would delete or swap each other's tree.
 * Taken synchronously (no await between the check and the add). 409 stackBusy when held.
 */
const sourceOps = new Set<number>();

export function isSourceBusy(stackId: number): boolean {
  return sourceOps.has(stackId);
}

async function withSourceLock<T>(stackId: number, fn: () => Promise<T>): Promise<T> {
  if (sourceOps.has(stackId)) throw new AppError(409, 'A source operation is already running on this application', 'stackBusy');
  sourceOps.add(stackId);
  try {
    return await fn();
  } finally {
    sourceOps.delete(stackId);
  }
}
const LS_REMOTE_TIMEOUT_MS = 60_000;

export function stackDir(stack: { account_id: number; id: number }): string {
  return localPaths.appStack(stack.account_id, stack.id);
}

/** accounts/<id>/apps/<stackId>/ exists (root-owned 0711 dirs, created by the panel). */
export function ensureStackDir(stack: { account_id: number; id: number }): string {
  const apps = localPaths.apps(stack.account_id);
  fs.mkdirSync(apps, { recursive: true, mode: 0o711 });
  const st = fs.lstatSync(apps);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`refusing ${apps}: not a directory`);
  return mkdirNoFollow(apps, String(stack.id), 0o711);
}

/** Replaces src/ by the prepared tree `fresh` (absolute path inside the stack dir). */
function swapSource(dir: string, fresh: string): void {
  const src = path.join(dir, 'src');
  const old = path.join(dir, `src.old-${Date.now()}`);
  let hadOld = false;
  try {
    const st = fs.lstatSync(src);
    if (st.isSymbolicLink()) fs.rmSync(src, { force: true });
    else { fs.renameSync(src, old); hadOld = true; }
  } catch { /* no previous tree */ }
  fs.renameSync(fresh, src);
  if (hadOld) removeTreeNoFollow(old, dir);
}

function gitToken(stack: StackRow): string | null {
  if (!stack.git_token_sealed) return null;
  try {
    return open('apps', stack.git_token_sealed);
  } catch (err) {
    if (err instanceof SecretBoxError) throw new AppError(409, 'The git token can no longer be read (the panel secret changed): enter it again', 'gitAuthFailed');
    throw err;
  }
}

/** Latest commit of the branch (ls-remote). 502 gitUnreachable / gitAuthFailed. */
export async function remoteCommit(stack: StackRow): Promise<string> {
  const token = gitToken(stack);
  const pin = await repoPinArgs(stack.git_repo_url!, appsDeps().lookup, await appsDeps().nodeAddresses());
  const res = await appsDeps().git(lsRemoteArgs(stack.git_repo_url!, stack.git_branch ?? 'main', pin), { env: gitEnv(token), timeoutMs: LS_REMOTE_TIMEOUT_MS });
  if (res.code !== 0) {
    logger.info({ stackId: stack.id, detail: gitDetail(res, token) }, 'apps: git ls-remote failed');
    throw gitFailure(res, token);
  }
  const sha = parseLsRemote(res.stdout, stack.git_branch ?? 'main');
  if (!sha) throw new AppError(502, `Branch ${stack.git_branch} not found in the repository`, 'gitUnreachable');
  return sha;
}

/**
 * Fetches the git source when the remote commit differs from the last one (or no tree yet): shallow clone
 * into src.new, .git removed, compose read (no-follow), stack row updated. Returns the commit + change.
 */
export async function pullGitSource(stack: StackRow, force = false, opts: { validate?: StagedValidator } = {}): Promise<{ commit: string; changed: boolean; composeYaml: string }> {
  return withSourceLock(stack.id, () => pullGitSourceLocked(stack, force, opts.validate));
}

async function pullGitSourceLocked(stack: StackRow, force: boolean, validate: StagedValidator | undefined): Promise<{ commit: string; changed: boolean; composeYaml: string }> {
  if (stack.source_type !== 'git' || !stack.git_repo_url) throw new AppError(409, 'This application has no git source', 'sourceTypeMismatch');
  const token = gitToken(stack);
  let commit: string;
  try {
    commit = await remoteCommit(stack);
  } catch (err) {
    await db('app_stacks').where({ id: stack.id }).update({ git_last_checked_at: db.fn.now(), git_last_error: (err as Error).message.slice(0, 500) });
    throw err;
  }
  const dir = ensureStackDir(stack);
  const composeRel = `src/${stack.git_compose_path ?? 'docker-compose.yml'}`;
  if (!force && commit === stack.git_last_commit && kindNoFollow(dir, composeRel) === 'file') {
    await db('app_stacks').where({ id: stack.id }).update({ git_last_checked_at: db.fn.now(), git_last_error: null });
    return { commit, changed: false, composeYaml: stack.compose_yaml };
  }
  const fresh = path.join(dir, 'src.new');
  removeTreeNoFollow(fresh, dir);
  const pin = await repoPinArgs(stack.git_repo_url, appsDeps().lookup, await appsDeps().nodeAddresses());
  const res = await appsDeps().git(cloneArgs(stack.git_repo_url, stack.git_branch ?? 'main', 'src.new', pin), { cwd: dir, env: gitEnv(token), timeoutMs: GIT_TIMEOUT_MS });
  if (res.code !== 0) {
    removeTreeNoFollow(fresh, dir);
    logger.info({ stackId: stack.id, detail: gitDetail(res, token) }, 'apps: git clone failed');
    const failure = gitFailure(res, token);
    await db('app_stacks').where({ id: stack.id }).update({ git_last_checked_at: db.fn.now(), git_last_error: redactGit(failure.message, token) });
    throw failure;
  }
  removeTreeNoFollow(path.join(fresh, '.git'), dir);
  const refuse = async (err: unknown): Promise<never> => {
    await db('app_stacks').where({ id: stack.id }).update({ git_last_checked_at: db.fn.now(), git_last_error: (err as Error).message.slice(0, 500) });
    throw err;
  };
  try { assertStagedTree(dir, fresh); } catch (err) { return refuse(err); }
  const composeYaml = readTextNoFollow(dir, `src.new/${stack.git_compose_path ?? 'docker-compose.yml'}`);
  if (composeYaml === null) {
    removeTreeNoFollow(fresh, dir);
    const msg = `Compose file ${stack.git_compose_path} not found in the repository (or it is a symbolic link)`;
    await db('app_stacks').where({ id: stack.id }).update({ git_last_checked_at: db.fn.now(), git_last_error: msg });
    throw new AppError(400, msg, 'composeInvalid', { issues: [{ severity: 'error', code: 'noServices', service: null, path: '', message: msg, line: null }] });
  }
  try { await validateStaged(dir, fresh, composeYaml, validate); } catch (err) { return refuse(err); }
  swapSource(dir, fresh);
  await db('app_stacks').where({ id: stack.id }).update({
    git_last_commit: commit, git_last_checked_at: db.fn.now(), git_last_error: null, compose_yaml: composeYaml, updated_at: db.fn.now(),
  });
  return { commit, changed: true, composeYaml };
}

/** ZIP source: spooled, extracted with limits into src.new, then swapped in. Returns the compose text. */
export async function uploadZipSource(stack: StackRow, body: NodeJS.ReadableStream, opts: { validate?: StagedValidator } = {}): Promise<string> {
  return withSourceLock(stack.id, () => uploadZipSourceLocked(stack, body, opts.validate));
}

async function uploadZipSourceLocked(stack: StackRow, body: NodeJS.ReadableStream, validate: StagedValidator | undefined): Promise<string> {
  const settings = await platformSettings.section('apps');
  const dir = ensureStackDir(stack);
  const zipFile = path.join(dir, `upload-${Date.now()}.zip`);
  const fresh = path.join(dir, 'src.new');
  try {
    await spoolUpload(body, zipFile, settings.zipMaxMb * 1048576);
    removeTreeNoFollow(fresh, dir);
    try {
      await extractZip(zipFile, fresh, { maxCompressedBytes: settings.zipMaxMb * 1048576, maxExpandedBytes: settings.zipMaxExpandedMb * 1048576 });
    } catch (err) {
      removeTreeNoFollow(fresh, dir);
      throw err;
    }
    const found = findComposeRoot(fresh);
    if (!found) {
      removeTreeNoFollow(fresh, dir);
      throw new AppError(400, 'No compose.yaml / docker-compose.yml at the root of the archive', 'zipInvalid');
    }
    let root = fresh;
    if (found.root) {
      // Single top directory: it becomes the source root.
      const inner = path.join(dir, 'src.inner');
      removeTreeNoFollow(inner, dir);
      fs.renameSync(path.join(fresh, found.root), inner);
      removeTreeNoFollow(fresh, dir);
      fs.renameSync(inner, fresh);
      root = fresh;
    }
    assertStagedTree(dir, fresh);
    const composeYaml = readTextNoFollow(dir, `src.new/${found.file}`);
    if (composeYaml === null) {
      removeTreeNoFollow(fresh, dir);
      throw new AppError(400, 'The compose file of the archive cannot be read', 'zipInvalid');
    }
    void root;
    await validateStaged(dir, fresh, composeYaml, validate);
    swapSource(dir, fresh);
    return composeYaml;
  } finally {
    fs.rmSync(zipFile, { force: true });
  }
}

/** Deletes the whole stack directory, or everything but volumes/ (returned for a tombstone). */
export function removeStackTree(stack: { account_id: number; id: number }, keepVolumes: boolean): string | null {
  const dir = stackDir(stack);
  const appsRoot = localPaths.apps(stack.account_id);
  let st: fs.Stats;
  try { st = fs.lstatSync(dir); } catch { return null; }
  if (st.isSymbolicLink() || !st.isDirectory()) { fs.rmSync(dir, { force: true }); return null; }
  if (!keepVolumes) { removeTreeNoFollow(dir, appsRoot); return null; }
  for (const name of fs.readdirSync(dir)) if (name !== 'volumes') removeTreeNoFollow(path.join(dir, name), dir);
  return kindNoFollow(dir, 'volumes') === 'dir' ? path.join(dir, 'volumes') : null;
}
