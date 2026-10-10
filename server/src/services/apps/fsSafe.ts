import fs from 'fs';
import path from 'path';
import type { SourceInspector } from './compose/validate';

// ─────────────────────────────────────────────────────────────────────────────
// Panel-side access to a stack tree (accounts/<id>/apps/<stackId>/), invariant
// R1 / AP3: tenant-controlled content (git checkouts, ZIP extracts, volumes
// written by containers) is NEVER read or traversed through a symbolic link.
// Every component of a path is lstat'ed; files are opened O_NOFOLLOW.
// ─────────────────────────────────────────────────────────────────────────────

const O_NOFOLLOW = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
export const MAX_TEXT_FILE = 256 * 1024;

function splitRel(rel: string): string[] {
  const norm = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (norm.startsWith('../') || norm === '..' || path.posix.isAbsolute(norm)) throw new Error(`path escapes the stack directory: ${rel}`);
  return norm.split('/').filter((s) => s && s !== '.');
}

/** Kind of `rel` under `root`, walking every component with lstat (a link anywhere → 'symlink'). */
export function kindNoFollow(root: string, rel: string): 'file' | 'dir' | 'missing' | 'symlink' {
  let cur = root;
  const parts = splitRel(rel);
  if (parts.length === 0) {
    try { return fs.lstatSync(root).isDirectory() ? 'dir' : 'missing'; } catch { return 'missing'; }
  }
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return 'missing';
    }
    if (st.isSymbolicLink()) return 'symlink';
    if (i < parts.length - 1 && !st.isDirectory()) return 'missing';
    if (i === parts.length - 1) return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'missing';
  }
  return 'missing';
}

/** Reads a small regular file without following links (null when missing / a link / too large). */
export function readTextNoFollow(root: string, rel: string, max = MAX_TEXT_FILE): string | null {
  if (kindNoFollow(root, rel) !== 'file') return null;
  const full = path.join(root, ...splitRel(rel));
  let fd: number | null = null;
  try {
    fd = fs.openSync(full, fs.constants.O_RDONLY | O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** SourceInspector of the compose validator for a stack directory (paths relative to it). */
export function stackInspector(stackDir: string): SourceInspector {
  return {
    kind: (rel) => kindNoFollow(stackDir, rel),
    readText: (rel) => readTextNoFollow(stackDir, rel),
  };
}

/**
 * Inspector of a tree staged under another name: paths under `from` (e.g. 'src') are looked up under `to`
 * (e.g. 'src.new'), anything else is 'missing'. Lets a new source tree be validated BEFORE it replaces the
 * current one.
 */
export function remappedInspector(stackDir: string, from: string, to: string): SourceInspector {
  const map = (rel: string): string | null => {
    const norm = path.posix.normalize(rel.replace(/\\/g, '/'));
    if (norm === from) return to;
    if (norm.startsWith(`${from}/`)) return `${to}/${norm.slice(from.length + 1)}`;
    return null;
  };
  return {
    kind: (rel) => { const m = map(rel); return m === null ? 'missing' : kindNoFollow(stackDir, m); },
    readText: (rel) => { const m = map(rel); return m === null ? null : readTextNoFollow(stackDir, m); },
  };
}

/**
 * mkdir -p of `rel` under `root`, refusing to traverse a symbolic link or a
 * non-directory (a container may have replaced a directory by a link).
 */
export function mkdirNoFollow(root: string, rel: string, mode = 0o755): string {
  let cur = root;
  fs.mkdirSync(root, { recursive: true, mode });
  for (const part of splitRel(rel)) {
    cur = path.join(cur, part);
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(cur); } catch { /* missing */ }
    if (st?.isSymbolicLink()) throw new Error(`refusing to follow a symbolic link: ${cur}`);
    if (st && !st.isDirectory()) throw new Error(`not a directory: ${cur}`);
    if (!st) fs.mkdirSync(cur, { mode });
  }
  return cur;
}

/**
 * Removes a tree without following any link (links are unlinked, never
 * traversed). `expectedPrefix`: the absolute path must live under it.
 */
export function removeTreeNoFollow(target: string, expectedPrefix: string): void {
  const abs = path.resolve(target);
  const prefix = path.resolve(expectedPrefix);
  if (abs === prefix || !abs.startsWith(prefix + path.sep)) throw new Error(`refusing to remove ${abs}: outside ${prefix}`);
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch { return; }
  if (!st.isDirectory() || st.isSymbolicLink()) { fs.rmSync(abs, { force: true }); return; }
  // Node has no openat(): the walk is path-based, so it must only run on trees no
  // container can write into (security audit P4b). Bind sources are always
  // read-only (compose/validate.ts, specs.ts) and volumes/ is removed only after
  // the stack's containers. Defence in depth: every directory's identity
  // (dev+ino, still a real directory) is re-checked before its listing is used
  // and before each removal inside it, so a directory swapped for a link aborts.
  const same = (p: string, ref: fs.Stats): boolean => {
    let s: fs.Stats;
    try { s = fs.lstatSync(p); } catch { return false; }
    return s.isDirectory() && !s.isSymbolicLink() && s.dev === ref.dev && s.ino === ref.ino;
  };
  const guard = (p: string, ref: fs.Stats) => {
    if (!same(p, ref)) throw new Error(`refusing to remove ${p}: the directory changed during removal`);
  };
  const walk = (dir: string, ref: fs.Stats) => {
    const names = fs.readdirSync(dir);
    guard(dir, ref);
    for (const name of names) {
      const p = path.join(dir, name);
      let s: fs.Stats;
      try { s = fs.lstatSync(p); } catch { continue; }
      if (s.isDirectory() && !s.isSymbolicLink()) walk(p, s);
      else { guard(dir, ref); fs.rmSync(p, { force: true }); }
    }
    guard(dir, ref);
    fs.rmdirSync(dir);
  };
  walk(abs, st);
}

/** Writes a file atomically (tmp + rename) after checking its directory chain has no link. */
export function writeFileNoFollow(root: string, rel: string, content: string | Buffer, mode = 0o644): void {
  const parts = splitRel(rel);
  const dir = mkdirNoFollow(root, parts.slice(0, -1).join('/') || '.');
  const full = path.join(dir, parts[parts.length - 1]);
  try {
    if (fs.lstatSync(full).isSymbolicLink()) fs.rmSync(full, { force: true });
  } catch { /* missing */ }
  const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, full);
}
