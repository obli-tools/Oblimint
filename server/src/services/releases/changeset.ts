import { normalizeRelPath } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { dataPathForbiddenError } from '../hosting/hostingValidation.service';
import { localPaths } from '../hosting/paths';
import type { CandidateCommit, ChangedPath, ContentTree, GitAuthor } from '../maintenance/contracts';
import type { HostdChangeSource, HostdSiteSpec } from '../hostd/client';
import { releaseDeps } from './deps';
import { commitExists } from './repo';
import { buildCandidate, commitWholeTree, conflictsWithStaging, dropCandidateRef, fileDiffBetween } from './candidate';

// ─────────────────────────────────────────────────────────────────────────────
// Change sets → git (docs/P3-PLAN.md §6.4). OWNED BY MODULE `windows` (which
// owns services/releases/** in P3).
//
// A window (export of its overlay) or an adapter run (workspace) produces a
// CANDIDATE COMMIT in the site's repo.git: tree = base release tree + the
// changes, parent = the base release commit, author = 'window #n' /
// 'adapter <id> #n', kept alive by refs/oblimint/candidates/<kind>-<id> (HEAD
// untouched until published). The review diff is plain git between the base
// commit and the candidate; validation publishes the candidate through
// releaseService.publishCommit; reflectToStaging copies the same changes into
// staging/<slug> through hostd (uid:gid, no symlink followed) so the client
// sees them in SFTP.
//
// This file resolves the site (repo.git, staging, data paths, hostd spec) and
// delegates the git work to candidate.ts (repository level, tested with real
// git). Hardening (R4): see candidate.ts / git.ts.
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildCandidateInput {
  siteId: number;
  /** Commit of the base release. */
  baseCommit: string;
  /** NEW content of the written paths. */
  tree: ContentTree;
  changes: ChangedPath[];
  message: string;
  author: GitAuthor;
  /** refs/oblimint/candidates/window-<id> | adapter-<id> */
  refName: string;
}

interface SiteRefs {
  repo: string;
  staging: string;
  dataPaths: string[];
  spec: HostdSiteSpec;
  nodeId: number;
}

async function siteRefs(siteId: number): Promise<SiteRefs> {
  const site = await db('sites').where({ id: siteId }).first('id', 'account_id', 'slug') as { id: number; account_id: number; slug: string } | undefined;
  if (!site) throw new AppError(404, 'Site not found', 'notFound');
  const account = await db('hosting_accounts').where({ id: site.account_id }).first('id', 'node_id', 'uid', 'gid') as
    { id: number; node_id: number; uid: number; gid: number } | undefined;
  if (!account) throw new AppError(404, 'Account not found', 'notFound');
  const rows = await db('site_data_paths').where({ site_id: siteId }).pluck('path') as string[];
  return {
    repo: localPaths.repo(account.id, site.id),
    staging: localPaths.siteStaging(account.id, site.slug),
    // Same filter as the pipeline: a malformed / forbidden row is no data path (never a reason to keep content out).
    dataPaths: rows.filter((p) => normalizeRelPath(p) === p && dataPathForbiddenError(p) === null),
    spec: { accountId: account.id, siteId: site.id, slug: site.slug, uid: account.uid, gid: account.gid },
    nodeId: account.node_id,
  };
}

/** Candidate commit from an explicit change list (window export). Data paths of the site are excluded here too. */
export async function buildCandidateCommit(input: BuildCandidateInput): Promise<CandidateCommit> {
  const s = await siteRefs(input.siteId);
  return buildCandidate({
    repoDir: s.repo, baseCommit: input.baseCommit, tree: input.tree, changes: input.changes, dataPaths: s.dataPaths,
    message: input.message, author: input.author, refName: input.refName,
  });
}

export interface CommitWorkTreeInput {
  siteId: number;
  baseCommit: string;
  /** Local directory holding the WHOLE new tree (adapter workspace). */
  workTree: string;
  message: string;
  author: GitAuthor;
  refName: string;
}

/** Candidate commit of a whole tree (adapter workspace): `git add -A` into a temp index, data paths excluded. */
export async function commitWorkTree(input: CommitWorkTreeInput): Promise<CandidateCommit> {
  const s = await siteRefs(input.siteId);
  return commitWholeTree({
    repoDir: s.repo, baseCommit: input.baseCommit, workTree: input.workTree, dataPaths: s.dataPaths,
    message: input.message, author: input.author, refName: input.refName,
  });
}

/** Unified diff of one path between two commits of the site (null patch: binary). */
export async function candidateFileDiff(siteId: number, fromCommit: string, toCommit: string, path: string, maxBytes: number): Promise<{
  patch: string | null; truncated: boolean; binary: boolean; oldSize: number | null; newSize: number | null;
}> {
  const s = await siteRefs(siteId);
  // A missing repo / commit (candidate ref dropped, storage repaired) must be a coded 409, never a git usage error
  // (git diff without a repository falls back to --no-index and fails with a 500).
  if (!(await commitExists(s.repo, fromCommit)) || !(await commitExists(s.repo, toCommit))) {
    throw new AppError(409, 'The candidate commit of this change set is no longer available', 'candidateNotFound');
  }
  return fileDiffBetween(s.repo, fromCommit, toCommit, path, maxBytes);
}

/** Paths whose staging content differs from the base commit (a validation would overwrite them). */
export async function stagingConflicts(siteId: number, baseCommit: string, paths: string[]): Promise<string[]> {
  const s = await siteRefs(siteId);
  return conflictsWithStaging(s.repo, s.staging, baseCommit, paths.filter((p) => !s.dataPaths.some((d) => p === d || p.startsWith(`${d}/`))));
}

/** Applies the written / deleted paths to staging/<slug> through hostd (source: window export or workspace). */
export async function reflectToStaging(siteId: number, source: HostdChangeSource, changes: ChangedPath[]): Promise<{ written: number; deleted: number; conflicts: string[] }> {
  const s = await siteRefs(siteId);
  const list = changes
    .filter((c) => !c.ignored && c.type !== 'dir' && !s.dataPaths.some((d) => c.path === d || c.path.startsWith(`${d}/`)))
    .map((c) => ({ path: c.path, op: c.change === 'deleted' ? 'delete' as const : 'write' as const }));
  if (!list.length) return { written: 0, deleted: 0, conflicts: [] };
  const r = await releaseDeps().applyToStaging(s.nodeId, s.spec, source, list);
  return { written: r.written, deleted: r.deleted, conflicts: (r.conflicts ?? []).map((c) => c.path) };
}

/** Drops a candidate ref (rejected window / failed run); objects are left to git gc. Never throws. */
export async function deleteCandidateRef(siteId: number, refName: string): Promise<void> {
  try {
    const s = await siteRefs(siteId);
    await dropCandidateRef(s.repo, refName);
  } catch (err) {
    logger.warn({ err, siteId, refName }, 'Changeset: cannot drop a candidate ref');
  }
}
