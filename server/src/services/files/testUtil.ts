import { Readable } from 'stream';
import { HostdError } from '../hostd/client';
import type { hostdFiles, HostdFileEntry } from '../hostd/files';

// ─────────────────────────────────────────────────────────────────────────────
// Tests only: an in-memory hostd file API (hostd/api_files.go contract) for
// the explorer and the file tools of the keys — files, folders, links, the
// size / mtime headers of a read, Range, upload begin / chunk / commit.
// ─────────────────────────────────────────────────────────────────────────────

export interface MemFile { data: Buffer; mtime: number; mode: number }

export interface MemHostd {
  hostd: typeof hostdFiles;
  files: Map<string, MemFile>;
  dirs: Set<string>;
  links: Map<string, string>;
  /** Writes a file (and its folders); a new mtime each time. */
  put(rel: string, content: string | Buffer, mode?: number): void;
  text(rel: string): string | undefined;
  /** Called after a file was opened for reading (e.g. a concurrent SFTP write). */
  onOpen: ((rel: string) => void) | null;
  /** Bytes per chunk of a read (small: chunk boundaries inside characters / lines). */
  chunkSize: number;
  opened: string[];
}

const parentOf = (rel: string) => rel.split('/').slice(0, -1).join('/');

export function memHostd(): MemHostd {
  const files = new Map<string, MemFile>();
  const dirs = new Set<string>(['staging', 'data']);
  const links = new Map<string, string>();
  const temps = new Map<string, Buffer>();
  let clock = 1_700_000_000_000;
  const mkdirs = (rel: string) => {
    const segs = rel.split('/');
    for (let i = 1; i <= segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
  };
  const notFound = (rel: string) => new HostdError(404, `hostd GET /v1/accounts/1/files: ${rel}: not found`, 'notFound');
  const m: MemHostd = {
    files, dirs, links, onOpen: null, chunkSize: 64 * 1024, opened: [],
    put(rel, content, mode = 0o644) {
      mkdirs(parentOf(rel));
      files.set(rel, { data: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), mtime: ++clock, mode });
    },
    text: (rel) => files.get(rel)?.data.toString('utf8'),
    hostd: {
      list: async (_t, rel) => {
        if (!dirs.has(rel)) throw notFound(rel);
        const entries: HostdFileEntry[] = [];
        const kids = (all: Iterable<string>) => [...all].filter((p) => parentOf(p) === rel);
        for (const d of kids(dirs)) entries.push({ name: d.slice(rel.length + 1), kind: 'dir', size: 0, mtime: 1, mode: 0o750, uid: 10007 });
        for (const f of kids(files.keys())) {
          const x = files.get(f)!;
          entries.push({ name: f.slice(rel.length + 1), kind: 'file', size: x.data.length, mtime: x.mtime, mode: x.mode, uid: 10007 });
        }
        for (const l of kids(links.keys())) entries.push({ name: l.slice(rel.length + 1), kind: 'symlink', size: 0, mtime: 1, mode: 0o777, uid: 10007, target: links.get(l) });
        return { path: rel, uid: 10007, entries, truncated: false };
      },
      openContent: async (_t, rel, range) => {
        const f = files.get(rel);
        if (!f) throw notFound(rel);
        m.opened.push(rel);
        let data = f.data;
        let status = 200;
        const r = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
        if (r) {
          const from = Number(r[1]);
          const to = r[2] ? Math.min(Number(r[2]), data.length - 1) : data.length - 1;
          data = data.subarray(from, to + 1);
          status = 206;
        }
        const chunks: Buffer[] = [];
        for (let i = 0; i < data.length; i += m.chunkSize) chunks.push(data.subarray(i, i + m.chunkSize));
        const headers = { 'x-oblimint-size': String(f.data.length), 'x-oblimint-mtime': String(f.mtime), 'content-length': String(data.length) };
        m.onOpen?.(rel);
        return { status, headers, body: Readable.from(chunks) as never };
      },
      openZip: async () => { throw new Error('unused'); },
      openTar: async () => { throw new Error('unused'); },
      untar: async () => { throw new Error('unused'); },
      extract: async () => { throw new Error('unused'); },
      mkdir: async (_t, _o, rel) => { mkdirs(rel); },
      remove: async (_t, _o, rel) => { files.delete(rel); },
      move: async () => { throw new Error('unused'); },
      copy: async () => { throw new Error('unused'); },
      uploadBegin: async (_t, _o, rel, id, _size, overwrite) => {
        if (!dirs.has(parentOf(rel))) throw notFound(parentOf(rel));
        if (files.has(rel) && !overwrite) throw new HostdError(409, `hostd POST x: ${rel} already exists`, 'exists');
        temps.set(id, Buffer.alloc(0));
      },
      uploadChunk: async (_t, _o, _rel, id, offset, _length, body) => {
        const parts: Buffer[] = [];
        for await (const c of body as AsyncIterable<Buffer>) parts.push(Buffer.from(c));
        const cur = temps.get(id) ?? Buffer.alloc(0);
        const data = Buffer.concat(parts);
        const out = Buffer.alloc(Math.max(cur.length, offset + data.length));
        cur.copy(out);
        data.copy(out, offset);
        temps.set(id, out);
      },
      uploadCommit: async (_t, _o, rel, id, size, overwrite) => {
        const data = temps.get(id);
        if (!data || data.length !== size) throw new HostdError(400, 'size mismatch', 'invalid');
        if (files.has(rel) && !overwrite) throw new HostdError(409, `hostd POST x: ${rel} already exists`, 'exists');
        temps.delete(id);
        files.set(rel, { data, mtime: ++clock, mode: 0o644 });
      },
      uploadAbort: async (_t, _o, _rel, id) => { temps.delete(id); },
    },
  };
  return m;
}
