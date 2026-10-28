import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import zlib from 'zlib';
import type { ChangeIgnoreReason, ChangeKind } from '@oblimint/shared';
import { isSafeRelPath, localContentTree, type CandidateCommit, type ChangedPath, type ContentTree, type GitAuthor } from '../maintenance/contracts';
import { identityEnv, runGit } from './git';
import { commitExists, filePatch, lsTree, parseNameStatus, scanStaging, escapeExcludePattern, type TreeEntry } from './repo';

// ─────────────────────────────────────────────────────────────────────────────
// Candidate commits (docs/P3-PLAN.md §5.1, §7) at the REPOSITORY level: pure
// git + filesystem, no database (changeset.ts resolves the site's paths and
// calls these). Tested against real git in a temp dir (candidate.test.ts).
//
// A candidate = tree of the base release commit + a change set, parent = the
// base commit, kept alive by refs/oblimint/candidates/<kind>-<id>. HEAD and
// the publication index are never touched (temporary index file).
//
// Hardening (R4, as git.ts): runGit (no shell, hardened env, no hooks),
// literal pathspecs after '--'; tenant content read through ContentTree only
// (never a followed symlink, R1); blobs written as loose objects by the panel
// itself (zlib, tmp + rename) — no `--stdin-paths` that would open tenant
// paths through git. Files above STREAM_BLOB_BYTES are hashed and deflated as
// a stream (bounded memory, asynchronous zlib): a 250 MiB file in a window
// never holds several copies in memory nor blocks the event loop.
// ─────────────────────────────────────────────────────────────────────────────

/** Candidate refs the panel may create / delete. */
export const CANDIDATE_REF_RE = /^refs\/oblimint\/candidates\/(window|adapter|preview)-[1-9]\d{0,9}$/;

/** Git's empty tree: the "from" side of the diff of a root candidate (feature B: staging snapshot of a site never published). */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Largest blob a candidate may carry (bigger files are listed as tooLarge). */
export const CANDIDATE_MAX_BLOB_BYTES = 512 * 1024 * 1024;

const NULL_OID = '0000000000000000000000000000000000000000';

/** Files larger than this are streamed (hash + deflate by chunks) instead of read into memory. */
export const STREAM_BLOB_BYTES = 8 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 1024 * 1024;
const deflateAsync = promisify(zlib.deflate);
const O_NOFOLLOW = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;

/** In-progress atomic upload of the file server (images/filesrv): never versioned. */
export function isTempUpload(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  return base.startsWith('.sftpgo-upload.');
}

/** True when `rel` is `p` or below `p`. */
export function isUnderPath(rel: string, p: string): boolean {
  return rel === p || rel.startsWith(`${p}/`);
}

/**
 * Roots of nested git repositories in a change set: the directory holding a
 * `.git` segment ('a/b/.git/HEAD' → 'a/b'). A top-level '.git' is the
 * staging's own repository (root '').
 */
export function nestedRepoRoots(paths: Iterable<string>): Set<string> {
  const roots = new Set<string>();
  for (const p of paths) {
    const segs = p.split('/');
    const i = segs.indexOf('.git');
    if (i >= 0) roots.add(segs.slice(0, i).join('/'));
  }
  return roots;
}

/**
 * Why a changed path does not go into a release (null: it does). Order:
 * invalid path, data path (and below), nested repository (a `.git` segment or
 * below a nested root), in-progress upload, then what hostd reported
 * (tooLarge / special).
 */
export function ignoreReasonOf(
  entry: { path: string; skipped?: 'tooLarge' | 'special' | null },
  dataPaths: readonly string[],
  nestedRoots: ReadonlySet<string>,
): ChangeIgnoreReason | null {
  const p = entry.path;
  if (!isSafeRelPath(p)) return 'invalidPath';
  if (dataPaths.some((d) => isUnderPath(p, d))) return 'dataPath';
  if (p.split('/').includes('.git')) return 'nestedRepo';
  for (const root of nestedRoots) {
    if (root === '' ? false : isUnderPath(p, root)) return 'nestedRepo';
  }
  if (isTempUpload(p)) return 'special';
  if (entry.skipped === 'tooLarge') return 'tooLarge';
  if (entry.skipped === 'special') return 'special';
  return null;
}

/** Applies ignoreReasonOf to a change list (ChangedPath.ignored set, an existing reason kept). */
export function classifyChanges<T extends ChangedPath & { skipped?: 'tooLarge' | 'special' | null }>(changes: T[], dataPaths: readonly string[]): T[] {
  const roots = nestedRepoRoots(changes.map((c) => c.path));
  return changes.map((c) => ({ ...c, ignored: c.ignored ?? ignoreReasonOf(c, dataPaths, roots) }));
}

// ── loose objects ────────────────────────────────────────────────────────────

/** Git object id (SHA-1) of a blob. */
export function blobOid(content: Buffer): string {
  return crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

/** Writes a blob as a loose object of the bare repository (idempotent, atomic). Returns its id. */
export function writeBlob(repoDir: string, content: Buffer): string {
  const oid = blobOid(content);
  const dir = path.join(repoDir, 'objects', oid.slice(0, 2));
  const file = path.join(dir, oid.slice(2));
  if (fs.existsSync(file)) return oid;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `tmp_obj_${process.pid}_${crypto.randomBytes(6).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, zlib.deflateSync(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content])), { flag: 'wx', mode: 0o444 });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (!fs.existsSync(file)) throw err;
  }
  return oid;
}

/** writeBlob without blocking the event loop (deflate in the libuv pool). */
export async function writeBlobAsync(repoDir: string, content: Buffer): Promise<string> {
  const oid = blobOid(content);
  const dir = path.join(repoDir, 'objects', oid.slice(0, 2));
  const file = path.join(dir, oid.slice(2));
  if (fs.existsSync(file)) return oid;
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `tmp_obj_${process.pid}_${crypto.randomBytes(6).toString('hex')}`);
  try {
    const header = Buffer.from(`blob ${content.length}\0`);
    await fs.promises.writeFile(tmp, await deflateAsync(Buffer.concat([header, content])), { flag: 'wx', mode: 0o444 });
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    if (!fs.existsSync(file)) throw err;
  }
  return oid;
}

/**
 * Opens `rel` under `root` for reading like localContentTree does (every parent
 * a real directory, lstat; the file itself a regular file, O_NOFOLLOW): null
 * when absent / not a regular file / not reachable that way (R1).
 */
export async function openRegularNoFollow(root: string, rel: string): Promise<{ fh: fs.promises.FileHandle; size: number } | null> {
  if (!root || !isSafeRelPath(rel)) return null;
  const segs = rel.split('/');
  let cur = root;
  try {
    for (let i = 0; i < segs.length - 1; i++) {
      cur = path.join(cur, segs[i]);
      if (!(await fs.promises.lstat(cur)).isDirectory()) return null;
    }
    const abs = path.join(cur, segs[segs.length - 1]);
    if (!(await fs.promises.lstat(abs)).isFile()) return null;
    const fh = await fs.promises.open(abs, fs.constants.O_RDONLY | O_NOFOLLOW);
    const st = await fh.stat().catch(() => null);
    if (!st?.isFile()) {
      await fh.close().catch(() => {});
      return null;
    }
    return { fh, size: st.size };
  } catch {
    return null;
  }
}

/** Chunks of an open file, exactly `size` bytes (a file that changes size meanwhile is an error). */
async function* fileChunks(fh: fs.promises.FileHandle, size: number, onChunk: (b: Buffer) => void): AsyncGenerator<Buffer> {
  let pos = 0;
  while (pos < size) {
    const buf = Buffer.allocUnsafe(Math.min(STREAM_CHUNK_BYTES, size - pos));
    const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
    if (bytesRead === 0) break;
    const chunk = bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
    pos += bytesRead;
    onChunk(chunk);
    yield chunk;
  }
  if (pos !== size) throw new Error('file changed while it was read');
}

/** Git blob id of an open file of `size` bytes, read by chunks. */
export async function blobOidStream(fh: fs.promises.FileHandle, size: number): Promise<string> {
  const hash = crypto.createHash('sha1').update(`blob ${size}\0`);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _chunk of fileChunks(fh, size, (b) => hash.update(b))) { /* hashed in onChunk */ }
  return hash.digest('hex');
}

/**
 * Writes an open file of `size` bytes as a loose object, streamed: one pass
 * hashes and deflates by chunks into a temp file, renamed to its object path
 * once the id is known (idempotent, atomic). Returns the blob id.
 */
export async function writeBlobStream(repoDir: string, fh: fs.promises.FileHandle, size: number): Promise<string> {
  const objects = path.join(repoDir, 'objects');
  await fs.promises.mkdir(objects, { recursive: true });
  const tmp = path.join(objects, `tmp_obj_${process.pid}_${crypto.randomBytes(6).toString('hex')}`);
  const header = Buffer.from(`blob ${size}\0`);
  const hash = crypto.createHash('sha1').update(header);
  try {
    await pipeline(
      async function* source() {
        yield header;
        yield* fileChunks(fh, size, (b) => hash.update(b));
      },
      zlib.createDeflate(),
      fs.createWriteStream(tmp, { flags: 'wx', mode: 0o444 }),
    );
    const oid = hash.digest('hex');
    const dir = path.join(objects, oid.slice(0, 2));
    const file = path.join(dir, oid.slice(2));
    if (fs.existsSync(file)) return oid;
    await fs.promises.mkdir(dir, { recursive: true });
    try {
      await fs.promises.rename(tmp, file);
    } catch (err) {
      if (!fs.existsSync(file)) throw err;
    }
    return oid;
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
}

// ── candidate from a change list (window export) ─────────────────────────────

export interface BuildCandidateRepoInput {
  repoDir: string;
  baseCommit: string;
  /** NEW content of the written paths. */
  tree: ContentTree;
  changes: Array<ChangedPath & { skipped?: 'tooLarge' | 'special' | null }>;
  dataPaths: string[];
  message: string;
  author: GitAuthor;
  refName: string;
  maxBlobBytes?: number;
}

function tmpIndexPath(tag: string): string {
  return path.join(os.tmpdir(), `oblimint-${tag}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.index`);
}

function cleanupIndex(file: string): void {
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.lock`, { force: true });
}

function assertCandidateRef(refName: string): void {
  if (!CANDIDATE_REF_RE.test(refName)) throw new Error(`invalid candidate ref: ${refName}`);
}

const KIND_OF: Record<string, ChangeKind> = { added: 'added', modified: 'modified', deleted: 'deleted', typechange: 'typechange', renamed: 'modified' };

/** Files changed between two commits (no renames). */
export async function commitChanges(repoDir: string, from: string, to: string): Promise<Array<{ path: string; change: ChangeKind }>> {
  const r = await runGit(['diff-tree', '-r', '-z', '--no-renames', '--name-status', from, to], { gitDir: repoDir, maxBuffer: 128 * 1024 * 1024 });
  return parseNameStatus(r.stdout).map((e) => ({ path: e.path, change: KIND_OF[e.status] ?? 'modified' }));
}

/** baseCommit null (feature B only): ROOT commit (no parent), changes counted from the empty tree. */
async function finishCandidate(repoDir: string, baseCommit: string | null, tree: string, message: string, author: GitAuthor, refName: string, ignored: CandidateCommit['ignored']): Promise<CandidateCommit> {
  const parents = baseCommit ? ['-p', baseCommit] : [];
  const commit = (await runGit(['commit-tree', tree, ...parents, '-F', '-'], {
    gitDir: repoDir, input: message, env: identityEnv(author),
  })).stdout.toString('utf8').trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('git commit-tree returned no commit id');
  await runGit(['update-ref', '-m', 'oblimint candidate', refName, commit], { gitDir: repoDir });
  const files = await commitChanges(repoDir, baseCommit ?? EMPTY_TREE_OID, commit);
  const count = (k: ChangeKind) => files.filter((f) => f.change === k).length;
  return {
    commit, baseCommit: baseCommit ?? '', refName, files,
    added: count('added'), modified: count('modified') + count('typechange'), deleted: count('deleted'),
    ignored,
  };
}

/**
 * Candidate commit from an explicit change list: base tree, then deletions
 * (path and everything below), then writes (a file replacing a directory
 * drops the directory's entries; a file under a former file drops that file).
 * Content of a written path that cannot be read (absent from the export,
 * larger than maxBlobBytes) is listed in `ignored`, never guessed.
 */
export async function buildCandidate(input: BuildCandidateRepoInput): Promise<CandidateCommit> {
  const { repoDir, baseCommit } = input;
  assertCandidateRef(input.refName);
  if (!(await commitExists(repoDir, baseCommit))) throw new Error(`base commit not found: ${baseCommit}`);
  const maxBlob = input.maxBlobBytes ?? CANDIDATE_MAX_BLOB_BYTES;

  const classified = classifyChanges(input.changes, input.dataPaths);
  const ignored: CandidateCommit['ignored'] = [];
  for (const c of classified) if (c.ignored) ignored.push({ path: c.path, reason: c.ignored });

  const entries = new Map<string, TreeEntry>();
  for (const e of await lsTree(repoDir, baseCommit)) entries.set(e.path, e);
  const removed = new Set<string>();
  const remove = (p: string): void => {
    if (entries.delete(p)) removed.add(p);
  };
  const removeBelow = (p: string): void => {
    const prefix = `${p}/`;
    for (const k of [...entries.keys()]) if (k.startsWith(prefix)) remove(k);
  };
  const removeFileAncestors = (p: string): void => {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) {
      const a = segs.slice(0, i).join('/');
      const e = entries.get(a);
      if (e && e.type !== 'tree') remove(a);
    }
  };

  const effective = classified.filter((c) => !c.ignored).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // Deletions first (a deleted directory takes its subtree), then writes.
  for (const c of effective) {
    if (c.change !== 'deleted') continue;
    remove(c.path);
    removeBelow(c.path);
  }
  const writes: Array<{ path: string; mode: string; oid: string }> = [];
  for (const c of effective) {
    if (c.change === 'deleted') continue;
    if (c.type === 'dir') {
      // A directory replacing a file: the file goes, the children come as their own entries.
      const e = entries.get(c.path);
      if (e && e.type !== 'tree') remove(c.path);
      continue;
    }
    let content: Buffer | null = null;
    let streamedOid: string | null = null;
    let mode = '100644';
    if (c.type === 'symlink') {
      const target = await input.tree.readlink(c.path);
      if (target !== null && target.length > 0 && !target.includes('\0')) content = Buffer.from(target, 'utf8');
      mode = '120000';
    } else {
      const st = await input.tree.stat(c.path);
      if (st && st.type === 'file' && st.size > maxBlob) {
        ignored.push({ path: c.path, reason: 'tooLarge' });
        continue;
      }
      let tooLarge = false;
      if (st && st.type === 'file' && st.size > STREAM_BLOB_BYTES) {
        // Large file: hashed + deflated as a stream from the tree's directory (same no-follow rules).
        const h = await openRegularNoFollow(input.tree.root, c.path);
        if (h) {
          try {
            if (h.size > maxBlob) tooLarge = true;
            else streamedOid = await writeBlobStream(repoDir, h.fh, h.size);
          } finally {
            await h.fh.close().catch(() => {});
          }
        }
      }
      if (tooLarge) {
        ignored.push({ path: c.path, reason: 'tooLarge' });
        continue;
      }
      if (streamedOid === null) {
        const r = await input.tree.read(c.path, maxBlob + 1);
        if (r && !r.truncated) content = r.data;
      }
      const bits = c.mode ?? st?.mode ?? 0o644;
      if (bits & 0o111) mode = '100755';
    }
    if (content === null && streamedOid === null) {
      ignored.push({ path: c.path, reason: 'special' });
      continue;
    }
    removeBelow(c.path);
    removeFileAncestors(c.path);
    const oid = streamedOid ?? await writeBlobAsync(repoDir, content as Buffer);
    writes.push({ path: c.path, mode, oid });
    removed.delete(c.path);
    entries.set(c.path, { mode, type: 'blob', oid, path: c.path });
  }

  const index = tmpIndexPath('cand');
  try {
    const env = { GIT_INDEX_FILE: index };
    await runGit(['read-tree', baseCommit], { gitDir: repoDir, env });
    const lines: string[] = [];
    for (const p of removed) lines.push(`0 ${NULL_OID}\t${p}\0`);
    for (const w of writes) lines.push(`${w.mode} ${w.oid}\t${w.path}\0`);
    if (lines.length) await runGit(['update-index', '-z', '--index-info'], { gitDir: repoDir, env, input: lines.join('') });
    const tree = (await runGit(['write-tree'], { gitDir: repoDir, env })).stdout.toString('utf8').trim();
    return await finishCandidate(repoDir, baseCommit, tree, input.message, input.author, input.refName, ignored);
  } finally {
    cleanupIndex(index);
  }
}

// ── candidate from a whole tree (adapter workspace) ──────────────────────────

export interface CommitWorkTreeRepoInput {
  repoDir: string;
  /** null (feature B: staging snapshot of a site without any commit) = root commit from an empty index. */
  baseCommit: string | null;
  workTree: string;
  dataPaths: string[];
  message: string;
  author: GitAuthor;
  refName: string;
}

/**
 * Candidate of a WHOLE tree (adapter workspace): temp index from the base
 * commit, data paths and nested repositories untracked, `add -A` with an
 * extra excludes file (data paths, nested repos, .sftpgo-upload.*), then
 * write-tree / commit-tree / update-ref. Symlinks stay symlinks (git never
 * follows them).
 */
export async function commitWholeTree(input: CommitWorkTreeRepoInput): Promise<CandidateCommit> {
  const { repoDir, baseCommit, workTree } = input;
  assertCandidateRef(input.refName);
  if (baseCommit !== null && !(await commitExists(repoDir, baseCommit))) throw new Error(`base commit not found: ${baseCommit}`);
  const scan = scanStaging(workTree, input.dataPaths);
  const index = tmpIndexPath('wt');
  const excludes = path.join(os.tmpdir(), `oblimint-wt-${process.pid}-${crypto.randomBytes(6).toString('hex')}.exclude`);
  try {
    const lines = ['/.git/', '.sftpgo-upload.*', ...[...input.dataPaths, ...scan.nestedRepos].map((p) => `/${escapeExcludePattern(p)}`)];
    fs.writeFileSync(excludes, `${lines.join('\n')}\n`, { mode: 0o600 });
    const env = { GIT_INDEX_FILE: index };
    const opts = { gitDir: repoDir, workTree, env };
    await runGit(baseCommit !== null ? ['read-tree', baseCommit] : ['read-tree', '--empty'], { gitDir: repoDir, env });
    const untrack = [...input.dataPaths, ...scan.nestedRepos];
    if (untrack.length) await runGit(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...untrack], opts);
    await runGit(['-c', `core.excludesFile=${excludes.replace(/\\/g, '/')}`, 'add', '-A'], opts);
    const tree = (await runGit(['write-tree'], { gitDir: repoDir, env })).stdout.toString('utf8').trim();
    const ignored: CandidateCommit['ignored'] = scan.nestedRepos.map((p) => ({ path: p, reason: 'nestedRepo' as const }));
    return await finishCandidate(repoDir, baseCommit, tree, input.message, input.author, input.refName, ignored);
  } finally {
    cleanupIndex(index);
    fs.rmSync(excludes, { force: true });
  }
}

// ── review: one file's diff, staging conflicts ───────────────────────────────

async function blobSize(repoDir: string, commit: string, rel: string): Promise<number | null> {
  const r = await runGit(['cat-file', '-s', `${commit}:${rel}`], { gitDir: repoDir, okCodes: [1, 128] });
  if (r.code !== 0) return null;
  const n = Number(r.stdout.toString('utf8').trim());
  return Number.isFinite(n) ? n : null;
}

/** Unified diff of ONE path between two commits (patch null: binary). */
export async function fileDiffBetween(repoDir: string, from: string, to: string, rel: string, maxBytes: number): Promise<{
  patch: string | null; truncated: boolean; binary: boolean; oldSize: number | null; newSize: number | null;
}> {
  if (!isSafeRelPath(rel)) throw new Error('invalid path');
  const num = await runGit(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--numstat', '-z', from, to, '--', rel], { gitDir: repoDir });
  const binary = /^-\t-\t/.test(num.stdout.toString('utf8'));
  const [oldSize, newSize] = await Promise.all([blobSize(repoDir, from, rel), blobSize(repoDir, to, rel)]);
  if (binary) return { patch: null, truncated: false, binary: true, oldSize, newSize };
  const p = await filePatch(repoDir, from, to, rel, null, maxBytes);
  return { patch: p.patch, truncated: p.truncated, binary: false, oldSize, newSize };
}

/**
 * Paths whose content in the staging differs from the base commit (a
 * validation would overwrite a change the client made in SFTP since). Read
 * through ContentTree (no symlink followed); blob ids compared (sizes first).
 */
export async function conflictsWithStaging(repoDir: string, stagingDir: string, baseCommit: string, paths: string[], maxBytes = CANDIDATE_MAX_BLOB_BYTES): Promise<string[]> {
  const safe = [...new Set(paths.filter(isSafeRelPath))];
  if (!safe.length) return [];
  const base = new Map<string, { mode: string; oid: string; size: number | null }>();
  for (let i = 0; i < safe.length; i += 500) {
    const chunk = safe.slice(i, i + 500);
    const r = await runGit(['ls-tree', '-r', '-l', '-z', '--full-tree', baseCommit, '--', ...chunk], { gitDir: repoDir, maxBuffer: 64 * 1024 * 1024 });
    for (const rec of r.stdout.toString('utf8').split('\0')) {
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const [mode, , oid, size] = rec.slice(0, tab).trim().split(/\s+/);
      base.set(rec.slice(tab + 1), { mode, oid, size: size === '-' ? null : Number(size) });
    }
  }
  const tree = localContentTree(stagingDir);
  const out: string[] = [];
  for (const p of safe) {
    const b = base.get(p);
    const st = await tree.stat(p);
    if (!b) {
      if (st && st.type !== 'dir') out.push(p);
      continue;
    }
    if (!st) { out.push(p); continue; }
    if (b.mode === '120000') {
      const target = st.type === 'symlink' ? await tree.readlink(p) : null;
      if (target === null || blobOid(Buffer.from(target, 'utf8')) !== b.oid) out.push(p);
      continue;
    }
    if (st.type !== 'file' || (b.size !== null && st.size !== b.size)) { out.push(p); continue; }
    if (st.size > STREAM_BLOB_BYTES) {
      const h = st.size <= maxBytes ? await openRegularNoFollow(stagingDir, p) : null;
      if (!h) { out.push(p); continue; }
      try {
        if ((await blobOidStream(h.fh, h.size).catch(() => null)) !== b.oid) out.push(p);
      } finally {
        await h.fh.close().catch(() => {});
      }
      continue;
    }
    const r = await tree.read(p, maxBytes);
    if (!r || r.truncated || blobOid(r.data) !== b.oid) out.push(p);
  }
  return out.sort();
}

/** Drops a candidate ref (objects are left to git gc). */
export async function dropCandidateRef(repoDir: string, refName: string): Promise<void> {
  assertCandidateRef(refName);
  await runGit(['update-ref', '-d', refName], { gitDir: repoDir, okCodes: [1, 128] });
}

/** HEAD moved to `commit` only when it still points at `parent` (fast-forward, compare-and-swap). */
export async function fastForwardHead(repoDir: string, commit: string, parent: string): Promise<boolean> {
  const r = await runGit(['update-ref', '-m', 'oblimint publish candidate', 'HEAD', commit, parent], { gitDir: repoDir, okCodes: [1, 128] });
  return r.code === 0;
}

/** First parent of a commit, null for a root commit. */
export async function parentOf(repoDir: string, commit: string): Promise<string | null> {
  const r = await runGit(['rev-parse', '-q', '--verify', `${commit}^1`], { gitDir: repoDir, okCodes: [1, 128] });
  const sha = r.stdout.toString('utf8').trim();
  return r.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}
