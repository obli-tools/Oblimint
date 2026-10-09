import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { DiffFileStatus } from '@oblimint/shared';
import { EMPTY_TREE, identityEnv, runGit, splitZ, type GitIdentity } from './git';

// ─────────────────────────────────────────────────────────────────────────────
// Operations on the bare repository of a site (repo.git) with the staging
// directory as work tree. Pure git + filesystem: no database, so every
// function is tested against real git in a temp dir (repo.test.ts).
// ─────────────────────────────────────────────────────────────────────────────

/** Idempotent: `git init --bare` (0700) when repo.git has no HEAD yet. Returns true when created. */
export async function initBareRepo(repoDir: string): Promise<boolean> {
  if (fs.existsSync(path.join(repoDir, 'HEAD'))) return false;
  fs.mkdirSync(repoDir, { recursive: true, mode: 0o700 });
  await runGit(['init', '--bare', '-q'], { gitDir: repoDir });
  // Sample hooks are inert (core.hooksPath points elsewhere) — drop them anyway.
  fs.rmSync(path.join(repoDir, 'hooks'), { recursive: true, force: true });
  try { fs.chmodSync(repoDir, 0o700); } catch { /* Windows */ }
  return true;
}

/**
 * repo.git/info/exclude: the staging's own .git, every data path (never
 * versioned: its content lives in data/<slug>/) and nested repositories.
 * Patterns are anchored and WITHOUT trailing slash so they match a file as
 * well as a directory of that name.
 */
export function writeExclude(repoDir: string, dataPaths: string[], extra: string[] = []): void {
  const lines = ['# Managed by Oblimint — rewritten at each publication', '/.git/'];
  for (const p of [...dataPaths, ...extra]) lines.push(`/${escapeExcludePattern(p)}`);
  lines.push('.sftpgo-upload.*'); // in-progress atomic uploads of the file server (images/filesrv), any depth
  const dir = path.join(repoDir, 'info');
  fs.mkdirSync(dir, { recursive: true });
  // Atomic (tmp + rename): a concurrent `git add -A` never reads a truncated / partial file.
  const tmp = path.join(dir, `exclude.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${lines.join('\n')}\n`, { flag: 'wx' });
    fs.renameSync(tmp, path.join(dir, 'exclude'));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Removes the lock files a killed git (timeout SIGKILL, panel crash) leaves
 * in a bare repository: index.lock, HEAD.lock, config.lock, packed-refs.lock,
 * shallow.lock, refs/** /*.lock, plus info/exclude.*.tmp leftovers.
 * ONLY call it when no git process can be running on this repository (under
 * the per-site lock, or at boot). Returns the removed paths (relative, '/').
 */
export function clearStaleGitLocks(repoDir: string): string[] {
  const removed: string[] = [];
  const rm = (rel: string): void => {
    const p = path.join(repoDir, rel);
    try {
      if (!fs.lstatSync(p).isFile()) return;
    } catch { return; }
    fs.rmSync(p, { force: true });
    removed.push(rel);
  };
  for (const f of ['index.lock', 'HEAD.lock', 'config.lock', 'packed-refs.lock', 'shallow.lock']) rm(f);
  const walk = (rel: string, depth: number): void => {
    if (depth > 32) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(repoDir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child, depth + 1);
      else if (e.isFile() && e.name.endsWith('.lock')) rm(child);
    }
  };
  walk('refs', 0);
  try {
    for (const e of fs.readdirSync(path.join(repoDir, 'info'), { withFileTypes: true })) {
      if (e.isFile() && /^exclude\..*\.tmp$/.test(e.name)) rm(`info/${e.name}`);
    }
  } catch { /* no info/ */ }
  return removed;
}

/** Escapes gitignore glob metacharacters so a path is matched literally. */
export function escapeExcludePattern(rel: string): string {
  return rel.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`).replace(/^ | $/g, (c) => `\\${c}`);
}

// ── staging walk (lstat only, never follows a symlink — R1) ─────────────────

export interface StagingScan {
  /** Regular files outside data paths / nested repositories. */
  fileCount: number;
  /** Relative dirs that contain their own .git (excluded from the commit). */
  nestedRepos: string[];
  /** Symbolic links found (relative paths). */
  symlinks: string[];
  /** The walk stopped at maxEntries. */
  truncated: boolean;
}

export function scanStaging(stagingDir: string, dataPaths: string[], maxEntries = 200_000): StagingScan {
  const out: StagingScan = { fileCount: 0, nestedRepos: [], symlinks: [], truncated: false };
  const skip = new Set(dataPaths);
  let seen = 0;
  const walk = (rel: string): void => {
    const abs = rel ? path.join(stagingDir, rel) : stagingDir;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    if (rel && entries.some((e) => e.name === '.git')) {
      out.nestedRepos.push(rel);
      return;
    }
    for (const e of entries) {
      if (out.truncated) return;
      if (++seen > maxEntries) { out.truncated = true; return; }
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && e.name === '.git') continue;
      if (skip.has(childRel)) continue;
      // Dirent types come from readdir (d_type) = lstat semantics: a symlink is never a directory here.
      if (e.isSymbolicLink()) { if (out.symlinks.length < 100) out.symlinks.push(childRel); continue; }
      if (e.isDirectory()) walk(childRel);
      else if (e.isFile()) out.fileCount++;
    }
  };
  let st: fs.Stats;
  try { st = fs.lstatSync(stagingDir); } catch { return out; }
  if (!st.isDirectory()) return out;
  walk('');
  return out;
}

// ── commit ───────────────────────────────────────────────────────────────────

export interface CommitInput {
  repoDir: string;
  stagingDir: string;
  dataPaths: string[];
  nestedRepos: string[];
  message: string;
  author: GitIdentity;
}

/** Commits the staging (data paths + nested repos excluded) and returns the new HEAD sha. */
export async function commitStaging(input: CommitInput): Promise<string> {
  const { repoDir, stagingDir } = input;
  writeExclude(repoDir, input.dataPaths, input.nestedRepos);
  const opts = { gitDir: repoDir, workTree: stagingDir };
  // A path that became a data path (or a nested repo) after being committed stays
  // tracked despite info/exclude: drop it from the index first.
  const untrack = [...input.dataPaths, ...input.nestedRepos];
  if (untrack.length) await runGit(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...untrack], opts);
  await runGit(['add', '-A'], opts);
  await runGit(
    ['commit', '-q', '--allow-empty', '--allow-empty-message', '--no-verify', '--no-gpg-sign', '--cleanup=verbatim', '-F', '-'],
    { ...opts, input: input.message, env: identityEnv(input.author) },
  );
  return headCommit(repoDir) as Promise<string>;
}

export interface TreeMatchInput {
  repoDir: string;
  stagingDir: string;
  dataPaths: string[];
  nestedRepos: string[];
  /** Commit to compare with (the live release). */
  commit: string;
  /** Throw-away index file (removed on return). */
  tmpIndex: string;
}

/**
 * Would committing the staging NOW produce exactly the tree of `commit`?
 * Same rules as commitStaging (info/exclude, data paths and nested repos
 * untracked) but on a throw-away index built from `commit`: neither the
 * publication index nor HEAD moves. Caller holds the site lock (info/exclude
 * is rewritten).
 */
export async function stagingMatchesCommit(input: TreeMatchInput): Promise<boolean> {
  const { repoDir, stagingDir, commit, tmpIndex } = input;
  writeExclude(repoDir, input.dataPaths, input.nestedRepos);
  const env = { GIT_INDEX_FILE: tmpIndex };
  const opts = { gitDir: repoDir, workTree: stagingDir, env };
  try {
    await runGit(['read-tree', commit], { gitDir: repoDir, env });
    const untrack = [...input.dataPaths, ...input.nestedRepos];
    if (untrack.length) await runGit(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...untrack], opts);
    await runGit(['add', '-A'], opts);
    const tree = (await runGit(['write-tree'], { gitDir: repoDir, env })).stdout.toString('utf8').trim();
    const base = (await runGit(['rev-parse', '--verify', `${commit}^{tree}`], { gitDir: repoDir })).stdout.toString('utf8').trim();
    return tree.length > 0 && tree === base;
  } finally {
    fs.rmSync(tmpIndex, { force: true });
    fs.rmSync(`${tmpIndex}.lock`, { force: true });
  }
}

/** Sha of HEAD, null when the repository has no commit yet. */
export async function headCommit(repoDir: string): Promise<string | null> {
  const r = await runGit(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { gitDir: repoDir, okCodes: [1, 128] });
  const sha = r.stdout.toString('utf8').trim();
  return r.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/** Does `sha` name a commit of this repository? */
export async function commitExists(repoDir: string, sha: string): Promise<boolean> {
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return false;
  const r = await runGit(['cat-file', '-e', `${sha}^{commit}`], { gitDir: repoDir, okCodes: [1, 128] });
  return r.code === 0;
}

// ── tree listing ─────────────────────────────────────────────────────────────

export interface TreeEntry { mode: string; type: 'blob' | 'commit' | 'tree'; oid: string; path: string }

/** `ls-tree -r -z --full-tree` of a commit (blobs, symlinks 120000, gitlinks 160000). */
export async function lsTree(repoDir: string, commit: string): Promise<TreeEntry[]> {
  const r = await runGit(['ls-tree', '-r', '-z', '--full-tree', commit], { gitDir: repoDir, maxBuffer: 256 * 1024 * 1024 });
  return parseLsTree(r.stdout);
}

export function parseLsTree(buf: Buffer | string): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (const rec of splitZ(buf)) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, oid] = rec.slice(0, tab).split(' ');
    out.push({ mode, type: type as TreeEntry['type'], oid, path: rec.slice(tab + 1) });
  }
  return out;
}

// ── diffs ────────────────────────────────────────────────────────────────────

export interface NameStatusEntry { status: DiffFileStatus; path: string; oldPath: string | null }

const STATUS_LETTER: Record<string, DiffFileStatus> = {
  A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'added', T: 'typechange',
};

/** Parses `diff --name-status -z` (renames: `R100\0old\0new\0`). */
export function parseNameStatus(buf: Buffer | string): NameStatusEntry[] {
  const f = splitZ(buf);
  const out: NameStatusEntry[] = [];
  for (let i = 0; i < f.length;) {
    const code = f[i++];
    const letter = code.charAt(0);
    if (letter === 'R' || letter === 'C') {
      const oldPath = f[i++];
      const newPath = f[i++];
      out.push({ status: STATUS_LETTER[letter], path: newPath, oldPath: letter === 'R' ? oldPath : null });
    } else {
      const p = f[i++];
      out.push({ status: STATUS_LETTER[letter] ?? 'modified', path: p, oldPath: null });
    }
  }
  return out;
}

export interface NumstatEntry { path: string; oldPath: string | null; additions: number; deletions: number; binary: boolean }

/** Parses `diff --numstat -z` (renames: `a\td\t\0old\0new\0`; binary: `-\t-\t`). */
export function parseNumstat(buf: Buffer | string): NumstatEntry[] {
  const f = splitZ(buf);
  const out: NumstatEntry[] = [];
  for (let i = 0; i < f.length;) {
    const rec = f[i++];
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    const binary = m[1] === '-' && m[2] === '-';
    let p = m[3];
    let oldPath: string | null = null;
    if (p === '') { oldPath = f[i++]; p = f[i++]; }
    out.push({ path: p, oldPath, additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary });
  }
  return out;
}

const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color'];

export async function diffNameStatus(repoDir: string, from: string, to: string, renames: boolean): Promise<NameStatusEntry[]> {
  const r = await runGit(['diff', ...DIFF_FLAGS, renames ? '-M' : '--no-renames', '--name-status', '-z', from, to], { gitDir: repoDir });
  return parseNameStatus(r.stdout);
}

export async function diffNumstat(repoDir: string, from: string, to: string): Promise<NumstatEntry[]> {
  const r = await runGit(['diff', ...DIFF_FLAGS, '-M', '--numstat', '-z', from, to], { gitDir: repoDir });
  return parseNumstat(r.stdout);
}

/** Files added / modified / deleted between two commits (renames = delete + add). */
export async function diffStats(repoDir: string, from: string | null, to: string): Promise<{ added: number; modified: number; deleted: number; changed: string[] }> {
  const entries = await diffNameStatus(repoDir, from ?? EMPTY_TREE, to, false);
  const stats = { added: 0, modified: 0, deleted: 0, changed: [] as string[] };
  for (const e of entries) {
    if (e.status === 'added') { stats.added++; stats.changed.push(e.path); }
    else if (e.status === 'deleted') stats.deleted++;
    else { stats.modified++; stats.changed.push(e.path); }
  }
  return stats;
}

/** Unified patch of ONE file between two commits, capped (truncated flag). */
export async function filePatch(repoDir: string, from: string, to: string, file: string, oldPath: string | null, cap: number): Promise<{ patch: string; truncated: boolean }> {
  const paths = oldPath && oldPath !== file ? [oldPath, file] : [file];
  const r = await runGit(['diff', ...DIFF_FLAGS, '-M', from, to, '--', ...paths], { gitDir: repoDir, maxBuffer: cap, allowTruncate: true });
  return { patch: r.stdout.toString('utf8'), truncated: r.truncated };
}

// ── staging status ───────────────────────────────────────────────────────────

/** Parses `status --porcelain=v1 -z` (renames: `R  new\0old\0`). */
export function parsePorcelain(buf: Buffer | string): Array<{ path: string; status: DiffFileStatus }> {
  const f = splitZ(buf);
  const out: Array<{ path: string; status: DiffFileStatus }> = [];
  for (let i = 0; i < f.length;) {
    const rec = f[i++];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const p = rec.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // skip the origin path
    let status: DiffFileStatus;
    if (xy === '??' || xy.includes('A')) status = 'added';
    else if (xy.includes('D')) status = 'deleted';
    else if (xy[0] === 'R') status = 'renamed';
    else if (xy.includes('T')) status = 'typechange';
    else status = 'modified';
    out.push({ path: p, status });
  }
  return out;
}

/**
 * Pending changes of the staging vs HEAD. Uses a throw-away index built from
 * HEAD (GIT_INDEX_FILE) so a status never touches the publication index.
 */
export async function stagingChanges(
  repoDir: string, stagingDir: string, dataPaths: string[], nestedRepos: string[], tmpIndex: string, rewriteExclude = true,
): Promise<Array<{ path: string; status: DiffFileStatus }>> {
  // rewriteExclude=false while a publication runs: its commit owns info/exclude.
  if (rewriteExclude) writeExclude(repoDir, dataPaths, nestedRepos);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    const head = await headCommit(repoDir);
    if (head) await runGit(['read-tree', head], { gitDir: repoDir, env });
    else await runGit(['read-tree', '--empty'], { gitDir: repoDir, env });
    const r = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all'], {
      gitDir: repoDir, workTree: stagingDir, env, maxBuffer: 128 * 1024 * 1024,
    });
    return parsePorcelain(r.stdout);
  } finally {
    fs.rmSync(tmpIndex, { force: true });
    fs.rmSync(`${tmpIndex}.lock`, { force: true });
  }
}
