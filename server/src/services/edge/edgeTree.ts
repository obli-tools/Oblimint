import fs from 'fs';
import path from 'path';
import { isValidAuxName } from './unitCheck';
import { UNIT_ID_RE } from './units';

// ─────────────────────────────────────────────────────────────────────────────
// Files of the edge configuration (docs/P4b-PLAN.md §8.2–§8.3), host side.
//
//   edge/conf.d/<id>.conf     http server units   (mounted RO in the edge)
//   edge/global.d/<id>.conf   http global units   (mounted RO)
//   edge/stream.d/<id>.conf   stream units        (mounted RO)
//   edge/aux/<id>/<name>      aux files           (mounted RO)
//   edge/good/{conf.d,global.d,stream.d,aux}/ + .oblimint-good
//                             last-known-good copy (mounted RO at
//                             /etc/nginx/oblimint/good: the entrypoint falls
//                             back to it, ED4). Aux paths are rewritten to
//                             /etc/nginx/oblimint/good/aux/ in that copy so it
//                             is self-contained; read back, they are restored.
//   edge/good.prev/           previous good copy (admin rollback), not mounted
//
// The bind-mounted directories themselves are never replaced (the container
// would keep the old inode): files are written `<file>.tmp` + rename, stale
// files are removed. Symbolic links are never followed: a link found where a
// directory or file is expected is removed, links are never read.
// ─────────────────────────────────────────────────────────────────────────────

export type ConfDirName = 'conf.d' | 'global.d' | 'stream.d';
export const CONF_DIRS: readonly ConfDirName[] = ['global.d', 'conf.d', 'stream.d'];

export interface EdgeDirs {
  confD: string;
  globalD: string;
  streamD: string;
  aux: string;
  sandbox: string;
  good: string;
  goodPrev: string;
}

/** Unit files (id → content) per configuration directory, aux files per unit (id → name → content). */
export interface EdgeTree {
  conf: Record<ConfDirName, Map<string, Buffer>>;
  aux: Map<string, Map<string, Buffer>>;
}

export const GOOD_MARKER = '.oblimint-good';
export const CONTAINER_AUX_PREFIX = '/etc/nginx/oblimint/aux/';
export const CONTAINER_GOOD_AUX_PREFIX = '/etc/nginx/oblimint/good/aux/';

export function emptyTree(): EdgeTree {
  return { conf: { 'conf.d': new Map(), 'global.d': new Map(), 'stream.d': new Map() }, aux: new Map() };
}

export function cloneTree(t: EdgeTree): EdgeTree {
  const out = emptyTree();
  for (const d of CONF_DIRS) for (const [k, v] of t.conf[d]) out.conf[d].set(k, v);
  for (const [id, files] of t.aux) out.aux.set(id, new Map(files));
  return out;
}

export function liveDirOf(dirs: EdgeDirs, d: ConfDirName): string {
  return d === 'conf.d' ? dirs.confD : d === 'global.d' ? dirs.globalD : dirs.streamD;
}

function lstatOrNull(p: string): fs.Stats | null {
  try { return fs.lstatSync(p); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function removePath(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

/** `dir` exists as a real directory (a link / file in its place is removed). The directory itself is never replaced. */
function ensureRealDir(dir: string): void {
  const st = lstatOrNull(dir);
  if (st && st.isDirectory() && !st.isSymbolicLink()) return;
  if (st) removePath(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
}

function writeAtomic(file: string, content: Buffer): void {
  const st = lstatOrNull(file);
  if (st && (st.isDirectory() || st.isSymbolicLink())) removePath(file);
  const tmp = `${file}.tmp`;
  removePath(tmp);
  fs.writeFileSync(tmp, content, { mode: 0o644, flag: 'wx' });
  fs.renameSync(tmp, file);
}

/** *.conf unit files of a directory (id → content); links, invalid names and other files are ignored. */
export function readConfFiles(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw err;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.conf')) continue;
    const id = e.name.slice(0, -'.conf'.length);
    if (!UNIT_ID_RE.test(id)) continue;
    out.set(id, fs.readFileSync(path.join(dir, e.name)));
  }
  return out;
}

/** Makes `dir` hold exactly `files` as <id>.conf (other files untouched, leftover *.tmp removed). Returns the number of changes. */
export function writeConfFiles(dir: string, files: Map<string, Buffer>): number {
  ensureRealDir(dir);
  const current = readConfFiles(dir);
  let changed = 0;
  for (const [id, content] of files) {
    if (!UNIT_ID_RE.test(id)) continue;
    if (current.get(id)?.equals(content)) continue;
    writeAtomic(path.join(dir, `${id}.conf`), content);
    changed++;
  }
  for (const id of current.keys()) {
    if (files.has(id)) continue;
    removePath(path.join(dir, `${id}.conf`));
    changed++;
  }
  for (const e of fs.readdirSync(dir)) if (e.endsWith('.conf.tmp')) removePath(path.join(dir, e));
  return changed;
}

/** Regular files under aux/<id>/ (relative name → content); links and invalid names skipped. */
function readAuxUnit(unitDir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const name = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), name, depth + 1);
      else if (e.isFile() && isValidAuxName(name)) out.set(name, fs.readFileSync(path.join(dir, e.name)));
    }
  };
  const st = lstatOrNull(unitDir);
  if (st?.isDirectory() && !st.isSymbolicLink()) walk(unitDir, '', 0);
  return out;
}

export function readAuxRoot(root: string): Map<string, Map<string, Buffer>> {
  const out = new Map<string, Map<string, Buffer>>();
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || !UNIT_ID_RE.test(e.name)) continue;
    const files = readAuxUnit(path.join(root, e.name));
    if (files.size) out.set(e.name, files);
  }
  return out;
}

function mapsEqual(a: Map<string, Buffer> | undefined, b: Map<string, Buffer> | undefined): boolean {
  const x = a ?? new Map<string, Buffer>();
  const y = b ?? new Map<string, Buffer>();
  if (x.size !== y.size) return false;
  for (const [k, v] of x) if (!y.get(k)?.equals(v)) return false;
  return true;
}

export function auxEqual(a: Map<string, Buffer> | undefined, b: Map<string, Buffer> | undefined): boolean {
  return mapsEqual(a, b);
}

/** Makes aux/<id>/ hold exactly `files` (no link followed). Returns the number of changes. */
function writeAuxUnit(root: string, id: string, files: Map<string, Buffer>): number {
  const unitDir = path.join(root, id);
  const current = readAuxUnit(unitDir);
  if (mapsEqual(current, files) && lstatOrNull(unitDir)?.isDirectory()) return 0;
  ensureRealDir(unitDir);
  let changed = 0;
  for (const [name, content] of files) {
    if (!isValidAuxName(name)) continue;
    if (current.get(name)?.equals(content)) continue;
    const segs = name.split('/');
    let dir = unitDir;
    for (const s of segs.slice(0, -1)) {
      dir = path.join(dir, s);
      ensureRealDir(dir);
    }
    writeAtomic(path.join(dir, segs[segs.length - 1]), content);
    changed++;
  }
  // Anything else under the unit directory goes (stale files, links, invalid names).
  const prune = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) {
        prune(full, name);
        if (fs.readdirSync(full).length === 0) removePath(full);
      } else if (!files.has(name) || !e.isFile()) {
        removePath(full);
        changed++;
      }
    }
  };
  prune(unitDir, '');
  return changed;
}

/** Makes the aux root hold exactly `aux` (unit directories only, the root itself is never replaced). */
export function writeAuxRoot(root: string, aux: Map<string, Map<string, Buffer>>): number {
  ensureRealDir(root);
  let changed = 0;
  for (const [id, files] of aux) {
    if (!UNIT_ID_RE.test(id) || files.size === 0) continue;
    changed += writeAuxUnit(root, id, files);
  }
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const keep = UNIT_ID_RE.test(e.name) && (aux.get(e.name)?.size ?? 0) > 0 && e.isDirectory() && !e.isSymbolicLink();
    if (!keep) {
      removePath(path.join(root, e.name));
      changed++;
    }
  }
  return changed;
}

/** The live configuration (what the edge reads). */
export function readLiveTree(dirs: EdgeDirs): EdgeTree {
  const t = emptyTree();
  for (const d of CONF_DIRS) t.conf[d] = readConfFiles(liveDirOf(dirs, d));
  t.aux = readAuxRoot(dirs.aux);
  return t;
}

/** Writes the live configuration (exact sets). Returns the number of files changed. */
export function writeLiveTree(dirs: EdgeDirs, tree: EdgeTree): number {
  let changed = 0;
  // Aux first: a unit never references a file that does not exist yet.
  changed += writeAuxRoot(dirs.aux, tree.aux);
  for (const d of CONF_DIRS) changed += writeConfFiles(liveDirOf(dirs, d), tree.conf[d]);
  return changed;
}

export function treesEqual(a: EdgeTree, b: EdgeTree): boolean {
  for (const d of CONF_DIRS) if (!mapsEqual(a.conf[d], b.conf[d])) return false;
  const ids = new Set([...a.aux.keys(), ...b.aux.keys()]);
  for (const id of ids) if (!mapsEqual(a.aux.get(id), b.aux.get(id))) return false;
  return true;
}

const rewrite = (buf: Buffer, from: string, to: string): Buffer => {
  const s = buf.toString('utf8');
  return s.includes(from) ? Buffer.from(s.split(from).join(to), 'utf8') : buf;
};

/** A complete snapshot (marker present), or null. `goodPaths`: aux paths were rewritten to the good/ mount. */
export function readSnapshot(dir: string, opts: { goodPaths: boolean }): EdgeTree | null {
  if (!lstatOrNull(path.join(dir, GOOD_MARKER))?.isFile()) return null;
  const t = emptyTree();
  for (const d of CONF_DIRS) {
    const files = readConfFiles(path.join(dir, d));
    t.conf[d] = opts.goodPaths ? new Map([...files].map(([k, v]) => [k, rewrite(v, CONTAINER_GOOD_AUX_PREFIX, CONTAINER_AUX_PREFIX)])) : files;
  }
  t.aux = readAuxRoot(path.join(dir, 'aux'));
  return t;
}

/** Records a complete snapshot: marker removed first, written LAST (a crash never leaves a half copy marked good). */
export function writeSnapshot(dir: string, tree: EdgeTree, opts: { goodPaths: boolean }): void {
  ensureRealDir(dir);
  removePath(path.join(dir, GOOD_MARKER));
  for (const d of CONF_DIRS) {
    const files = opts.goodPaths ? new Map([...tree.conf[d]].map(([k, v]) => [k, rewrite(v, CONTAINER_AUX_PREFIX, CONTAINER_GOOD_AUX_PREFIX)])) : tree.conf[d];
    writeConfFiles(path.join(dir, d), files);
  }
  writeAuxRoot(path.join(dir, 'aux'), tree.aux);
  fs.writeFileSync(path.join(dir, GOOD_MARKER), `${new Date().toISOString()}\n`);
}

// ── unit file header ──────────────────────────────────────────────────────────

/** What a unit file holds: the unit itself, its 503 stub, or the fallback of a global unit. */
export type UnitFileKind = 'unit' | 'stub' | 'disabled' | 'fallback';

const HEADER_RE = /^# oblimint-unit id=([a-z0-9][a-z0-9-]{0,63}) hash=([0-9a-f]{64}|-) kind=(unit|stub|disabled|fallback)\n/;

export function unitFileContent(id: string, hash: string | null, kind: UnitFileKind, config: string): Buffer {
  const body = config.endsWith('\n') ? config : `${config}\n`;
  return Buffer.from(`# oblimint-unit id=${id} hash=${hash ?? '-'} kind=${kind}\n${body}`, 'utf8');
}

/** Header of a unit file (null: no header — a P1 vhost file written before P4b, or a foreign file). */
export function parseUnitHeader(buf: Buffer | undefined): { id: string; hash: string | null; kind: UnitFileKind } | null {
  if (!buf) return null;
  const m = HEADER_RE.exec(buf.subarray(0, 200).toString('utf8'));
  if (!m) return null;
  return { id: m[1], hash: m[2] === '-' ? null : m[2], kind: m[3] as UnitFileKind };
}
