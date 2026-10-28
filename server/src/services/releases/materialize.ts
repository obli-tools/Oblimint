import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import { CONTAINER_PATHS } from '../hosting/paths';
import { gitBaseArgs, gitEnv, GitError } from './git';
import { lsTree, type TreeEntry } from './repo';

// ─────────────────────────────────────────────────────────────────────────────
// Release trees (docs/P1-PLAN.md §4, §9 step 4–5; invariants R1, R3).
//
// Materialization strategy: `ls-tree -r -z` of the commit, then every needed
// blob is streamed by ONE `git cat-file --batch` process and written by us:
//   - no tar / archive extractor needed (the panel image only has git);
//   - each file is created with O_CREAT|O_EXCL|O_NOFOLLOW inside a directory
//     we created ourselves (never written through a link);
//   - symlink entries (120000) become symlinks with their stored target, never
//     resolved; gitlinks (160000) are skipped with a warning;
//   - modes are normalized (files 0644, executable entries 100755 0755, dirs 0755);
//   - a file whose blob equals the one of the SAME path in the base release
//     (normally the current one) is HARDLINKED to it instead of rewritten:
//     release trees are never modified after creation (R3), so sharing inodes
//     is safe and keeps N releases cheap on disk.
// Everything is built in releases/<n>.tmp and renamed to releases/<n> at the end.
// Durability: every written file and every directory of the tree is fsynced
// BEFORE that rename, releases/ after it and after each `current` switch
// (XFS delayed allocation would otherwise leave zero-length files in a live,
// immutable release after a power loss).
// ─────────────────────────────────────────────────────────────────────────────

/** Symlink primitives (injectable: Windows boxes without the symlink privilege use an emulation in tests). */
export interface LinkOps {
  symlink(target: string, linkPath: string): void;
  readlink(linkPath: string): string;
  /** lstat-level: is this path a symbolic link? (never follows) */
  isLink(p: string): boolean;
}

export const realLinkOps: LinkOps = {
  symlink: (target, linkPath) => fs.symlinkSync(target, linkPath, 'dir'),
  readlink: (p) => fs.readlinkSync(p),
  isLink: (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } },
};

export interface MaterializeInput {
  repoDir: string;
  /** releases/ of the site. */
  releasesDir: string;
  number: number;
  commit: string;
  /** Data paths (normalized, relative): tree entries under them are dropped, links created instead. */
  dataPaths: string[];
  /**
   * `typed` data paths (subset of dataPaths): a release symlink reaching one of
   * them is skipped — through it the web server would serve the typed
   * directory WITHOUT its extension whitelist (images/siteconf only guards the
   * data path at its own location).
   */
  typedDataPaths?: string[];
  /** Base release to hardlink unchanged files from (on disk), null for none. */
  base: { number: number; commit: string } | null;
  /**
   * Directory of the base tree to hardlink from (default <releasesDir>/<base.number>).
   * Feature B: a preview builds under previews/<id>/releases from the live tree releases/<n>.
   */
  baseDir?: string;
  links?: LinkOps;
  log?: (level: 'info' | 'warn', message: string) => void;
}

export interface MaterializeResult { dir: string; files: number; linked: number; written: number; symlinks: number; skipped: number }

const O_NOFOLLOW = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;
const CREATE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW;

export class MaterializeError extends Error {
  constructor(message: string) { super(message); this.name = 'MaterializeError'; }
}

/**
 * Lexical resolution of a release symlink, as the CONTAINER sees it
 * (`/srv/releases/<n>/<linkPath>`, data links `<p>` → `/srv/data/<p>`):
 * returns the data-relative path it reaches ('' = the whole data root), or
 * null when it does not reach /srv/data. Chained links are not followed.
 */
export function symlinkDataTarget(linkPath: string, target: string, number: number, dataPaths: string[]): string | null {
  const releaseRoot = `${CONTAINER_PATHS.releases}/${number}`;
  const abs = path.posix.resolve(releaseRoot, path.posix.dirname(linkPath), target);
  const data = CONTAINER_PATHS.data;
  if (abs === data) return '';
  if (abs.startsWith(`${data}/`)) return abs.slice(data.length + 1);
  for (const root of [releaseRoot, `${CONTAINER_PATHS.releases}/current`]) {
    const rel = abs === root ? '' : abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null;
    if (rel === null) continue;
    // Inside the release: it reaches data only through a data link (or a parent of one).
    if (rel === '') return dataPaths.length ? '' : null;
    if (isUnder(dataPaths, rel)) return rel;
    return dataPaths.some((d) => d.startsWith(`${rel}/`)) ? rel : null;
  }
  return null;
}

/** True when serving `rel` (data-relative) would expose a typed data path (itself, inside it, or a parent of it). */
export function exposesTypedPath(rel: string, typed: string[]): boolean {
  return typed.some((t) => rel === '' || rel === t || rel.startsWith(`${t}/`) || t.startsWith(`${rel}/`));
}

/** 'a/b/c' → ['a', 'a/b'] */
function parentDirs(rel: string): string[] {
  const parts = rel.split('/');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

function isUnder(dataPaths: string[], rel: string): boolean {
  return dataPaths.some((d) => rel === d || rel.startsWith(`${d}/`));
}

/** Rejects absolute, '..' or empty segments (a well-formed git tree never has them). */
function safeRel(rel: string): boolean {
  if (!rel || rel.startsWith('/') || rel.includes('\0') || rel.includes('\\')) return false;
  return rel.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && s !== '.git');
}

/**
 * fsync of a directory (its entries: created files, links, renames). No-op
 * where directories cannot be opened (Windows dev boxes).
 */
export function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    /* EISDIR / EPERM on Windows: nothing to sync there */
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** Removes a directory strictly inside `root` (no symlink followed by fs.rm). */
export function removeUnder(root: string, target: string): void {
  const r = path.resolve(root);
  const t = path.resolve(target);
  if (!t.startsWith(r + path.sep) || t === r) throw new Error(`refusing to remove ${target}: not under ${root}`);
  fs.rmSync(t, { recursive: true, force: true });
}

/** Builds releases/<n> from a commit (see header). Throws MaterializeError / GitError. */
export async function materializeRelease(input: MaterializeInput): Promise<MaterializeResult> {
  const links = input.links ?? realLinkOps;
  const log = input.log ?? (() => {});
  const finalDir = path.posix.join(input.releasesDir, String(input.number));
  const tmpDir = `${finalDir}.tmp`;
  if (fs.existsSync(tmpDir) || links.isLink(tmpDir)) removeUnder(input.releasesDir, tmpDir);
  if (fs.existsSync(finalDir) || links.isLink(finalDir)) removeUnder(input.releasesDir, finalDir);
  fs.mkdirSync(tmpDir, { mode: 0o755 });

  const res: MaterializeResult = { dir: finalDir, files: 0, linked: 0, written: 0, symlinks: 0, skipped: 0 };
  try {
    const entries = await lsTree(input.repoDir, input.commit);

    // Blobs of the base release, per path (regular files only).
    const baseBlobs = new Map<string, string>();
    const baseDir = input.base ? (input.baseDir ?? path.posix.join(input.releasesDir, String(input.base.number))) : null;
    if (input.base && baseDir && fs.existsSync(baseDir) && !links.isLink(baseDir)) {
      for (const e of await lsTree(input.repoDir, input.base.commit)) {
        if (e.type === 'blob' && (e.mode === '100644' || e.mode === '100755')) baseBlobs.set(e.path, `${e.mode}:${e.oid}`);
      }
    }

    const files: TreeEntry[] = [];
    const symlinks: TreeEntry[] = [];
    const dirs = new Set<string>();
    for (const e of entries) {
      if (!safeRel(e.path)) { log('warn', `entrée ignorée (chemin invalide) : ${e.path}`); res.skipped++; continue; }
      if (isUnder(input.dataPaths, e.path)) { res.skipped++; continue; }
      if (e.type === 'commit' || e.mode === '160000') { log('warn', `sous-module ignoré : ${e.path}`); res.skipped++; continue; }
      if (e.type !== 'blob') continue;
      if (e.mode === '120000') symlinks.push(e);
      else files.push(e);
      const parts = e.path.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }

    // Directories first (sorted: parents before children), all real dirs we create.
    for (const d of [...dirs].sort()) fs.mkdirSync(path.posix.join(tmpDir, d), { mode: 0o755 });

    // Hardlinks for unchanged blobs, the rest through cat-file.
    const toWrite = new Map<string, string[]>(); // oid → paths
    const executable = new Set(files.filter((e) => e.mode === '100755').map((e) => e.path));
    const realDirs = new Map<string, boolean>(); // base-relative dir → every component is a real directory
    for (const e of files) {
      const dest = path.posix.join(tmpDir, e.path);
      if (baseDir && baseBlobs.get(e.path) === `${e.mode}:${e.oid}` && parentsAreRealDirs(baseDir, e.path, links, realDirs)) {
        const src = path.posix.join(baseDir, e.path);
        try {
          const st = fs.lstatSync(src);
          // Same mode on disk too (a tree materialized before the executable bit was kept has 0644).
          if (st.isFile() && ((st.mode & 0o100) !== 0) === executable.has(e.path)) {
            fs.linkSync(src, dest);
            res.linked++;
            res.files++;
            continue;
          }
        } catch { /* fall back to a fresh copy */ }
      }
      const list = toWrite.get(e.oid);
      if (list) list.push(e.path); else toWrite.set(e.oid, [e.path]);
      res.files++;
    }
    if (toWrite.size) res.written += await writeBlobs(input.repoDir, tmpDir, toWrite, executable);

    // Symlink targets: read in one batch too, then created (never resolved).
    if (symlinks.length) {
      const targets = await readBlobs(input.repoDir, [...new Set(symlinks.map((s) => s.oid))]);
      for (const s of symlinks) {
        const target = targets.get(s.oid);
        if (target === undefined || target.includes('\0') || target.length === 0) {
          log('warn', `lien symbolique ignoré (cible invalide) : ${s.path}`);
          res.skipped++;
          continue;
        }
        const typed = input.typedDataPaths ?? [];
        if (typed.length) {
          const reached = symlinkDataTarget(s.path, target, input.number, input.dataPaths);
          if (reached !== null && exposesTypedPath(reached, typed)) {
            log('warn', `lien symbolique ignoré (vise un chemin de données typé, liste blanche contournée) : ${s.path}`);
            res.skipped++;
            continue;
          }
        }
        links.symlink(target, path.posix.join(tmpDir, s.path));
        res.symlinks++;
      }
    }

    createDataLinks(tmpDir, input.dataPaths, links);
    try { fs.chmodSync(tmpDir, 0o755); } catch { /* Windows */ }
    // Files were fsynced as written (writeBlobs); now every directory entry
    // (deepest first), then the rename itself through releases/.
    for (const d of [...dirs, ...input.dataPaths.flatMap(parentDirs)].sort().reverse()) fsyncDir(path.posix.join(tmpDir, d));
    fsyncDir(tmpDir);
    fs.renameSync(tmpDir, finalDir);
    fsyncDir(input.releasesDir);
    return res;
  } catch (err) {
    try { removeUnder(input.releasesDir, tmpDir); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * R1 for hardlink reuse: every parent component of `rel` under `root` must be
 * a real directory (lstat, never a symlink — a data link of the base release
 * like `D → /srv/data/D` would otherwise resolve in the panel's namespace).
 * Results are cached per directory.
 */
function parentsAreRealDirs(root: string, rel: string, links: LinkOps, cache: Map<string, boolean>): boolean {
  const parts = rel.split('/');
  let cur = '';
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur ? `${cur}/${parts[i]}` : parts[i];
    let ok = cache.get(cur);
    if (ok === undefined) {
      const abs = path.posix.join(root, cur);
      try {
        const st = fs.lstatSync(abs);
        ok = st.isDirectory() && !st.isSymbolicLink() && !links.isLink(abs);
      } catch {
        ok = false;
      }
      cache.set(cur, ok);
    }
    if (!ok) return false;
  }
  return true;
}

/**
 * Do the data links of an existing release tree match `dataPaths` exactly?
 * A data link is a symlink at <p> whose target is `/srv/data/<p>`. The walk
 * uses lstat only and never descends into a link (R1). Used by a rollback to
 * an on-disk tree built when the site had other data paths.
 */
export function dataLinksMatch(releaseDir: string, dataPaths: string[], links: LinkOps = realLinkOps): boolean {
  const found = new Set(releaseSymlinks(releaseDir, links).filter((l) => l.dataLink).map((l) => l.rel));
  const want = new Set(dataPaths);
  if (found.size !== want.size) return false;
  for (const p of want) if (!found.has(p)) return false;
  return true;
}

/**
 * Every symlink of a release tree (lstat walk, never descending into a link —
 * R1). dataLink = the link at <p> targets `/srv/data/<p>` (a data link).
 */
export function releaseSymlinks(releaseDir: string, links: LinkOps = realLinkOps): Array<{ rel: string; target: string; dataLink: boolean }> {
  const out: Array<{ rel: string; target: string; dataLink: boolean }> = [];
  const walk = (rel: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(rel ? path.posix.join(releaseDir, rel) : releaseDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.posix.join(releaseDir, childRel);
      if (e.isDirectory() && !e.isSymbolicLink() && !links.isLink(abs)) { walk(childRel); continue; }
      if (!e.isSymbolicLink() && !links.isLink(abs)) continue;
      let target: string;
      try { target = links.readlink(abs); } catch { continue; }
      out.push({ rel: childRel, target, dataLink: target === `${CONTAINER_PATHS.data}/${childRel}` });
    }
  };
  walk('');
  return out;
}

/**
 * Would this release tree, served with these data paths, break an invariant
 * the web-server rules rely on? Returns the reasons (empty = the tree may stay live):
 *   - a data link to a path that is no longer a data path (its directory
 *     would be served with the CODE rules: .htaccess honored, PHP executed);
 *   - a code symlink reaching a `typed` data path (bypasses its extension
 *     whitelist — materializeRelease skips those, but only for the paths that
 *     were typed when the tree was built).
 * Missing links for NEW data paths are not a reason: the new rules are
 * stricter, and the links follow at the next publication.
 */
export function staleDataExposure(releaseDir: string, number: number, dataPaths: string[], typed: string[], links: LinkOps = realLinkOps): string[] {
  const reasons: string[] = [];
  const want = new Set(dataPaths);
  for (const l of releaseSymlinks(releaseDir, links)) {
    if (l.dataLink) {
      if (!want.has(l.rel)) reasons.push(`lien de données obsolète : ${l.rel}`);
      continue;
    }
    if (!typed.length) continue;
    const reached = symlinkDataTarget(l.rel, l.target, number, dataPaths);
    if (reached !== null && exposesTypedPath(reached, typed)) reasons.push(`lien symbolique vers un chemin de données typé : ${l.rel}`);
  }
  return reasons;
}

/**
 * Leftovers of an interrupted build / switch under releases/: `<n>.tmp` and
 * `current.tmp`. Only call it when no pipeline runs for the site. Returns the removed names.
 */
export function removeTmpEntries(releasesDir: string): string[] {
  const removed: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(releasesDir, { withFileTypes: true }); } catch { return removed; }
  for (const e of entries) {
    if (e.name !== 'current.tmp' && !/^\d+\.tmp$/.test(e.name)) continue;
    removeUnder(releasesDir, path.posix.join(releasesDir, e.name));
    removed.push(e.name);
  }
  return removed;
}

/**
 * Data links inside a release being built: <path> → /srv/data/<path>
 * (absolute CONTAINER path). Each parent component is checked with lstat
 * (R1): a symlink or a file in the way is a conflict, never written through.
 */
export function createDataLinks(releaseDir: string, dataPaths: string[], links: LinkOps = realLinkOps): void {
  for (const p of [...dataPaths].sort()) {
    const parts = p.split('/');
    let cur = releaseDir;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = path.posix.join(cur, parts[i]);
      let st: fs.Stats | null = null;
      try { st = fs.lstatSync(cur); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (!st) { fs.mkdirSync(cur, { mode: 0o755 }); continue; }
      if (st.isSymbolicLink() || links.isLink(cur) || !st.isDirectory()) throw new MaterializeError(`chemin de données en conflit: ${p}`);
    }
    const leaf = path.posix.join(releaseDir, p);
    let exists = links.isLink(leaf);
    if (!exists) { try { fs.lstatSync(leaf); exists = true; } catch { /* absent */ } }
    if (exists) throw new MaterializeError(`chemin de données en conflit: ${p}`);
    links.symlink(`${CONTAINER_PATHS.data}/${p}`, leaf);
  }
}

// ── cat-file --batch streaming ───────────────────────────────────────────────

/** Streams `git cat-file --batch` for `oids`, calling onObject for each content chunk. */
function catFileBatch(
  repoDir: string,
  oids: string[],
  onStart: (oid: string, size: number) => void,
  onChunk: (chunk: Buffer) => void,
  onEnd: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.hosting.gitBinary, [...gitBaseArgs(), `--git-dir=${repoDir}`, 'cat-file', '--batch'], {
      env: gitEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
    });
    let stderr = '';
    let failed: Error | null = null;
    let header = Buffer.alloc(0);
    let remaining = -1; // -1 = reading a header; ≥0 bytes of content left (+1 trailing LF)
    let done = 0;
    const timer = setTimeout(() => { failed = new GitError('git cat-file: timeout', null, stderr); child.kill('SIGKILL'); }, 30 * 60_000);

    child.stdout.on('data', (buf: Buffer) => {
      if (failed) return;
      let off = 0;
      try {
        while (off < buf.length) {
          if (remaining < 0) {
            const nl = buf.indexOf(0x0a, off);
            if (nl < 0) { header = Buffer.concat([header, buf.subarray(off)]); return; }
            const line = Buffer.concat([header, buf.subarray(off, nl)]).toString('utf8');
            header = Buffer.alloc(0);
            off = nl + 1;
            const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(line);
            if (!m) throw new GitError(`git cat-file: ${line}`, null, stderr);
            onStart(m[1], Number(m[3]));
            remaining = Number(m[3]) + 1;
          } else {
            const take = Math.min(remaining, buf.length - off);
            const contentLeft = remaining - 1;
            const contentTake = Math.min(take, contentLeft);
            if (contentTake > 0) onChunk(buf.subarray(off, off + contentTake));
            remaining -= take;
            off += take;
            if (remaining === 0) { remaining = -1; onEnd(); done++; }
          }
        }
      } catch (err) {
        failed = err as Error;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (b: Buffer) => { if (stderr.length < 8192) stderr += b.toString('utf8'); });
    child.on('error', (err) => { failed = failed ?? err; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failed) return reject(failed);
      if (code !== 0) return reject(new GitError(`git cat-file failed (${code}): ${stderr.trim()}`, code, stderr));
      if (done !== oids.length) return reject(new GitError(`git cat-file: ${done}/${oids.length} objects read`, code, stderr));
      resolve();
    });
    child.stdin.on('error', () => { /* reported by close */ });
    // Write requests with back-pressure.
    let i = 0;
    const pump = (): void => {
      while (i < oids.length) {
        if (!child.stdin.write(`${oids[i++]}\n`)) { child.stdin.once('drain', pump); return; }
      }
      child.stdin.end();
    };
    pump();
  });
}

/**
 * Writes each blob to its first path (O_EXCL|O_NOFOLLOW, 0644 or 0755 for an
 * executable entry), the other paths hardlinked to it (same mode) or copied
 * (the same content with the other mode).
 */
async function writeBlobs(repoDir: string, root: string, byOid: Map<string, string[]>, executable: Set<string> = new Set()): Promise<number> {
  const oids = [...byOid.keys()];
  let fd: number | null = null;
  let written = 0;
  let currentPaths: string[] = [];
  try {
    await catFileBatch(
      repoDir,
      oids,
      (oid) => {
        currentPaths = byOid.get(oid) ?? [];
        if (!currentPaths.length) throw new Error(`unexpected object ${oid}`);
        fd = fs.openSync(path.posix.join(root, currentPaths[0]), CREATE_FLAGS, 0o644);
      },
      (chunk) => { if (fd !== null) fs.writeSync(fd, chunk); },
      () => {
        // Durable before the tree is renamed into place (see header).
        if (fd !== null) { fs.fsyncSync(fd); fs.closeSync(fd); fd = null; }
        const first = path.posix.join(root, currentPaths[0]);
        const firstExec = executable.has(currentPaths[0]);
        try { fs.chmodSync(first, firstExec ? 0o755 : 0o644); } catch { /* Windows */ }
        for (const p of currentPaths.slice(1)) {
          const dest = path.posix.join(root, p);
          if (executable.has(p) === firstExec) { fs.linkSync(first, dest); continue; }
          fs.copyFileSync(first, dest, fs.constants.COPYFILE_EXCL);
          try { fs.chmodSync(dest, executable.has(p) ? 0o755 : 0o644); } catch { /* Windows */ }
          const cfd = fs.openSync(dest, 'r');
          try { fs.fsyncSync(cfd); } finally { fs.closeSync(cfd); }
        }
        written += currentPaths.length;
      },
    );
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  return written;
}

/** Small blobs (symlink targets) read into memory. */
async function readBlobs(repoDir: string, oids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let cur = '';
  let parts: Buffer[] = [];
  await catFileBatch(repoDir, oids, (oid) => { cur = oid; parts = []; }, (c) => { parts.push(Buffer.from(c)); }, () => {
    out.set(cur, Buffer.concat(parts).toString('utf8'));
  });
  return out;
}

// ── current switch ───────────────────────────────────────────────────────────

/** Atomic switch: current.tmp → '<n>' (RELATIVE target) then rename over `current`. null removes it. */
export function switchCurrent(releasesDir: string, number: number | null, links: LinkOps = realLinkOps): void {
  const current = path.posix.join(releasesDir, 'current');
  const tmp = path.posix.join(releasesDir, 'current.tmp');
  fs.rmSync(tmp, { force: true });
  if (number === null) {
    fs.rmSync(current, { force: true });
    fsyncDir(releasesDir);
    return;
  }
  links.symlink(String(number), tmp);
  fs.renameSync(tmp, current);
  fsyncDir(releasesDir);
}

/** Number `current` points to, null when absent / not a release link. */
export function readCurrent(releasesDir: string, links: LinkOps = realLinkOps): number | null {
  try {
    const t = links.readlink(path.posix.join(releasesDir, 'current'));
    return /^\d+$/.test(t) ? Number(t) : null;
  } catch {
    return null;
  }
}
