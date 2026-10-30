import fs from 'fs';
import path from 'path';
import { runGit, splitZ } from '../releases/git';
import { initBareRepo } from '../releases/repo';

// ─────────────────────────────────────────────────────────────────────────────
// Release history in the account backups (docs/P6-PLAN.md §5.3 « repos »,
// §6.5): `git bundle create --all` of sites/<id>/repo.git — every release
// commit, candidate and backup ref — and its in-place restore. Same hardened
// git runner as the release pipeline (no hooks, no system / global config).
// ─────────────────────────────────────────────────────────────────────────────

const BUNDLE_TIMEOUT_MS = 30 * 60_000;

export type BundleOutcome = 'bundled' | 'missing' | 'empty';

/** Writes the bundle of `repoDir` to `outFile`: 'missing' (no repo yet) / 'empty' (no ref) write nothing. */
export async function bundleRepo(repoDir: string, outFile: string): Promise<BundleOutcome> {
  if (!fs.existsSync(path.join(repoDir, 'HEAD'))) return 'missing';
  const refs = await runGit(['for-each-ref', '--count=1', '--format=%(refname)'], { gitDir: repoDir });
  if (!refs.stdout.toString('utf8').trim()) return 'empty';
  await runGit(['bundle', 'create', '-q', outFile, '--all'], { gitDir: repoDir, timeoutMs: BUNDLE_TIMEOUT_MS });
  return 'bundled';
}

/** References a bundle carries (`bundle list-heads`), HEAD excluded. */
export async function bundleRefs(repoDir: string, bundleFile: string): Promise<string[]> {
  const r = await runGit(['bundle', 'list-heads', bundleFile], { gitDir: repoDir });
  return r.stdout.toString('utf8').split('\n')
    .map((l) => l.trim().split(/\s+/)[1])
    .filter((ref): ref is string => !!ref && ref.startsWith('refs/'));
}

/**
 * Puts the bundle back IN PLACE in `repoDir` (created when missing): every
 * object fetched, every reference set to its backed-up value, references the
 * backup did not have removed (--prune), HEAD re-pointed like the backup's.
 * The bundle is verified first (complete history, no prerequisite). Caller
 * holds the site lock (no publication meanwhile).
 */
export async function restoreRepoFromBundle(repoDir: string, bundleFile: string): Promise<{ refs: number }> {
  await initBareRepo(repoDir);
  await runGit(['bundle', 'verify', '-q', bundleFile], { gitDir: repoDir, timeoutMs: BUNDLE_TIMEOUT_MS });
  const refs = await bundleRefs(repoDir, bundleFile);
  if (!refs.length) throw new Error('the repository bundle holds no reference');
  await runGit(
    ['fetch', '-q', '--force', '--prune', '--update-head-ok', '--no-write-fetch-head', '--no-tags', bundleFile, 'refs/*:refs/*'],
    { gitDir: repoDir, timeoutMs: BUNDLE_TIMEOUT_MS },
  );
  // HEAD of the backed-up repo: the symbolic target when the bundle names it (refs/heads/main…).
  const heads = (await runGit(['bundle', 'list-heads', bundleFile], { gitDir: repoDir })).stdout.toString('utf8').split('\n');
  const headSha = heads.map((l) => l.trim().split(/\s+/)).find((p) => p[1] === 'HEAD')?.[0];
  if (headSha) {
    const branch = heads.map((l) => l.trim().split(/\s+/)).find((p) => p[0] === headSha && p[1]?.startsWith('refs/heads/'))?.[1];
    if (branch) await runGit(['symbolic-ref', 'HEAD', branch], { gitDir: repoDir });
  }
  return { refs: refs.length };
}

/** Every reference of a repository with its value (tests, checks). */
export async function repoRefs(repoDir: string): Promise<Record<string, string>> {
  const r = await runGit(['for-each-ref', '--format=%(refname)%00%(objectname)%00'], { gitDir: repoDir });
  const out: Record<string, string> = {};
  const f = splitZ(r.stdout.toString('utf8').replace(/\n/g, ''));
  for (let i = 0; i + 1 < f.length; i += 2) out[f[i]] = f[i + 1];
  return out;
}
