// ─────────────────────────────────────────────────────────────────────────────
// fake-cwp — in-memory description of everything the image build writes:
// directories, files, symlinks (with owner / group / mode, by NAME: resolved
// at apply time once the Linux users exist), SQL scripts and Linux users.
// Pure data: built identically on Windows (check/check-dataset.mjs) and on the
// build host (build/generate.mjs apply).
// ─────────────────────────────────────────────────────────────────────────────

import path from 'node:path';

const posix = path.posix;

function normalize(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) throw new Error(`plan: absolute path expected, got ${String(p)}`);
  if (posix.normalize(p) !== p || (p.length > 1 && p.endsWith('/'))) throw new Error(`plan: non-normalized path ${p}`);
  return p;
}

export class Plan {
  constructor() {
    /** path → entry ({ type: dir | file | symlink, path, owner, group, mode, content | target }). */
    this.entries = new Map();
    /** Ordered SQL scripts: { name, sql } (loaded by build/seed.sh, in order). */
    this.sqlScripts = [];
    /** Linux groups / users created before the files (in order). */
    this.groups = [];
    this.users = [];
  }

  dir(p, { owner = 'root', group = owner, mode = 0o755 } = {}) {
    const key = normalize(p);
    const prev = this.entries.get(key);
    if (prev && prev.type !== 'dir') throw new Error(`plan: ${key} declared as ${prev.type} and dir`);
    this.entries.set(key, { type: 'dir', path: key, owner, group, mode });
    return key;
  }

  /** Declares every missing parent of p as a directory with the given ownership (explicit ones are kept). */
  parents(p, { owner = 'root', group = owner, mode = 0o755, stopAt = '/' } = {}) {
    let cur = posix.dirname(normalize(p));
    const chain = [];
    while (cur !== '/' && cur !== stopAt) {
      chain.push(cur);
      cur = posix.dirname(cur);
    }
    for (const d of chain.reverse()) {
      if (!this.entries.has(d)) this.dir(d, { owner, group, mode });
    }
  }

  file(p, content, { owner = 'root', group = owner, mode = 0o644 } = {}) {
    const key = normalize(p);
    if (this.entries.has(key)) throw new Error(`plan: ${key} declared twice`);
    if (typeof content !== 'string' && !Buffer.isBuffer(content)) throw new Error(`plan: ${key}: content must be a string or a Buffer`);
    this.entries.set(key, { type: 'file', path: key, owner, group, mode, content });
    return key;
  }

  symlink(p, target, { owner = 'root', group = owner } = {}) {
    const key = normalize(p);
    if (this.entries.has(key)) throw new Error(`plan: ${key} declared twice`);
    this.entries.set(key, { type: 'symlink', path: key, owner, group, target });
    return key;
  }

  sql(name, sql) {
    this.sqlScripts.push({ name, sql });
  }

  group(name, gid) {
    this.groups.push({ name, gid });
  }

  user(spec) {
    this.users.push(spec);
  }

  get(p) {
    return this.entries.get(posix.normalize(p)) ?? null;
  }

  has(p) {
    return this.entries.has(posix.normalize(p));
  }

  /** Entries sorted for application: directories by depth, then files, then symlinks. */
  ordered() {
    const rank = { dir: 0, file: 1, symlink: 2 };
    return [...this.entries.values()].sort((a, b) => {
      if (rank[a.type] !== rank[b.type]) return rank[a.type] - rank[b.type];
      const da = a.path.split('/').length;
      const db = b.path.split('/').length;
      return da !== db ? da - db : a.path.localeCompare(b.path);
    });
  }

  /** Every text the image will contain (files + SQL), for the static checks. */
  *texts() {
    for (const e of this.entries.values()) {
      if (e.type === 'file') yield { where: e.path, text: Buffer.isBuffer(e.content) ? null : e.content };
      if (e.type === 'symlink') yield { where: e.path, text: e.target };
    }
    for (const s of this.sqlScripts) yield { where: `sql:${s.name}`, text: s.sql };
  }
}
