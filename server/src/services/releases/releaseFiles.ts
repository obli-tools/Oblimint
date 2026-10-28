import type { Readable } from 'stream';
import type { ReleaseFileEntry } from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';
import { isSafeRelPath } from '../maintenance/contracts';
import { runGit, spawnGit, splitZ } from './git';

// ─────────────────────────────────────────────────────────────────────────────
// Files of a release, read from git (Feature A: an agent inspects the release
// a human rolled back to, or from). Pure git, no database: a path is only ever
// resolved by an exact lookup in the commit's tree, never turned into a
// filesystem path. Trees are cached (commits are immutable) under a global
// entry budget.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReleaseTreeEntry { path: string; type: 'file' | 'symlink'; mode: '100644' | '100755' | '120000'; size: number; sha: string }
export interface ReleaseTree { entries: ReleaseTreeEntry[]; byPath: Map<string, ReleaseTreeEntry>; gitlinks: number }

/** A tree bigger than this is not listed (409 releaseTooLarge). */
export const RELEASE_TREE_MAX = 200_000;
/** Entries kept in the cache, all trees together. */
export const RELEASE_TREE_CACHE_BUDGET = 300_000;
let budget = RELEASE_TREE_CACHE_BUDGET;

const cache = new Map<string, ReleaseTree>();
let cached = 0;

function remember(key: string, tree: ReleaseTree): void {
  cache.delete(key);
  cache.set(key, tree);
  cached = [...cache.values()].reduce((n, t) => n + t.entries.length, 0);
  for (const [k, t] of cache) {
    if (cached <= budget || k === key) break;
    cache.delete(k);
    cached -= t.entries.length;
  }
}

/** Tests: cache state. */
export const __releaseTreeCache = {
  keys: () => [...cache.keys()], entries: () => cached, clear: () => { cache.clear(); cached = 0; },
  setBudget: (n: number | null) => { budget = n ?? RELEASE_TREE_CACHE_BUDGET; },
};

const hasGitSegment = (p: string) => p.split('/').some((s) => s.toLowerCase() === '.git');

/** Parses `ls-tree -r -l -z --full-tree` (`<mode> <type> <oid> <size padded>\t<path>`). */
export function parseLsTreeLong(buf: Buffer | string): { entries: ReleaseTreeEntry[]; gitlinks: number } {
  const entries: ReleaseTreeEntry[] = [];
  let gitlinks = 0;
  for (const rec of splitZ(buf)) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, oid, size] = rec.slice(0, tab).trim().split(/ +/);
    const p = rec.slice(tab + 1);
    if (mode === '160000' || type === 'commit') { gitlinks++; continue; }
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755' && mode !== '120000')) continue;
    if (!isSafeRelPath(p) || hasGitSegment(p)) continue;
    entries.push({ path: p, type: mode === '120000' ? 'symlink' : 'file', mode, size: Number(size) || 0, sha: oid });
  }
  return { entries, gitlinks };
}

export async function releaseTree(repoDir: string, commit: string): Promise<ReleaseTree> {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new AppError(409, 'This release has no commit', 'releaseNotReady');
  const key = `${repoDir}#${commit}`;
  const hit = cache.get(key);
  if (hit) { remember(key, hit); return hit; }
  const r = await runGit(['ls-tree', '-r', '-l', '-z', '--full-tree', commit], { gitDir: repoDir, maxBuffer: 512 * 1024 * 1024 });
  const { entries, gitlinks } = parseLsTreeLong(r.stdout);
  if (entries.length > RELEASE_TREE_MAX) throw new AppError(409, `This release holds more than ${RELEASE_TREE_MAX} files: it cannot be listed here`, 'releaseTooLarge');
  const tree: ReleaseTree = { entries, byPath: new Map(entries.map((e) => [e.path, e])), gitlinks };
  remember(key, tree);
  return tree;
}

/** Bytes [offset, offset + maxBytes) of a blob (a symlink: its target). */
export async function readReleaseBlob(repoDir: string, entry: ReleaseTreeEntry, opts: { offset: number; maxBytes: number }): Promise<{ data: Buffer; truncated: boolean }> {
  const offset = Math.max(0, Math.trunc(opts.offset) || 0);
  const maxBytes = Math.max(1, Math.trunc(opts.maxBytes) || 1);
  if (offset >= entry.size) return { data: Buffer.alloc(0), truncated: false };
  const r = await runGit(['cat-file', 'blob', entry.sha], { gitDir: repoDir, maxBuffer: offset + maxBytes, allowTruncate: true });
  const data = r.stdout.subarray(offset, offset + maxBytes);
  return { data, truncated: offset + data.length < entry.size };
}

/** The whole blob as a stream (REST /content); kill() stops git when the client goes away. */
export function streamReleaseBlob(repoDir: string, sha: string): { stream: Readable; kill(): void } {
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new AppError(404, 'File not found in this release', 'notFound');
  const child = spawnGit(['cat-file', 'blob', sha], { gitDir: repoDir });
  return { stream: child.stdout, kill: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
}

/** Drops a trailing incomplete UTF-8 sequence (a window cut in the middle of a character). */
export function utf8SafeCut(buf: Buffer): Buffer {
  let i = buf.length - 1;
  let back = 0;
  while (i >= 0 && back < 4 && (buf[i] & 0xc0) === 0x80) { i--; back++; }
  if (i < 0) return buf;
  const lead = buf[i];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return buf.length - i < need ? buf.subarray(0, i) : buf;
}

/**
 * A path of a release as an agent gives it: trimmed, "\" → "/", leading and
 * trailing "/" dropped. '' (the root) only when allowRoot. Any file name a
 * tree may hold (spaces, accents, #, ~…) — no character whitelist: the lookup
 * is exact. null: invalid (.., empty segment, .git, too long).
 */
export function cleanReleasePath(input: unknown, allowRoot: boolean): string | null {
  if (input === undefined || input === null) return allowRoot ? '' : null;
  if (typeof input !== 'string') return null;
  const p = input.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (p === '') return allowRoot ? '' : null;
  if (p.length > 4096 || !isSafeRelPath(p) || hasGitSegment(p)) return null;
  return p;
}

export const toFileEntry = (e: ReleaseTreeEntry): ReleaseFileEntry => ({ path: e.path, type: e.type, size: e.size, executable: e.mode === '100755' });

/**
 * One page of entries from `offset`: at most `limit` entries and, with
 * maxChars, stopped once their JSON would pass it (at least one entry).
 */
export function pageEntries<T>(all: T[], offset: number, limit: number, maxChars?: number): { page: T[]; nextOffset: number | null } {
  const start = Math.max(0, Math.trunc(offset) || 0);
  const page: T[] = [];
  let chars = 0;
  for (let i = start; i < all.length && page.length < limit; i++) {
    const cost = JSON.stringify(all[i]).length + 8;
    if (maxChars !== undefined && page.length > 0 && chars + cost > maxChars) break;
    chars += cost;
    page.push(all[i]);
  }
  const next = start + page.length;
  return { page, nextOffset: next < all.length ? next : null };
}
