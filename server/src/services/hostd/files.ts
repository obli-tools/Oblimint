import http from 'http';
import type { Readable } from 'stream';
import { HostdError, hostdSocketFor, request } from './client';

// ─────────────────────────────────────────────────────────────────────────────
// hostd web file explorer API (contract: hostd/api_files.go, hostd/files.go).
// Paths are relative to the account directory, under staging/ or data/
// ("staging/<slug>/a/b"); hostd walks them without following any link and only
// changes directories owned by the account's uid.
// ─────────────────────────────────────────────────────────────────────────────

export interface HostdFileEntry {
  name: string;
  kind: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  /** Milliseconds since the epoch. */
  mtime: number;
  mode: number;
  uid: number;
  target?: string;
}

export interface HostdFileListing {
  path: string;
  /** Owner of the directory (writable when it is the account's uid). */
  uid: number;
  entries: HostdFileEntry[];
  truncated: boolean;
}

export interface HostdFileTarget {
  nodeId: number;
  accountId: number;
}

export interface HostdFileOwner {
  uid: number;
  gid: number;
}

const TIMEOUT_MS = 60_000;
/** Copies / deletions of large trees. */
const TREE_TIMEOUT_MS = 30 * 60_000;
const CHUNK_TIMEOUT_MS = 10 * 60_000;
/** A listing of 20 000 entries stays far below this. */
const MAX_LISTING_BYTES = 32 * 1024 * 1024;

function accountPath(t: HostdFileTarget, suffix = ''): string {
  if (!Number.isSafeInteger(t.accountId) || t.accountId <= 0) throw new HostdError(400, `hostd: invalid account id ${t.accountId}`, 'invalid');
  return `/v1/accounts/${t.accountId}/files${suffix}`;
}

function uploadPath(t: HostdFileTarget, uploadId: string, suffix = ''): string {
  if (!/^[0-9a-f]{32}$/.test(uploadId)) throw new HostdError(400, 'hostd: invalid upload id', 'invalid');
  return accountPath(t, `/uploads/${uploadId}${suffix}`);
}

async function call<T>(t: HostdFileTarget, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, timeout = TIMEOUT_MS, max?: number): Promise<T> {
  return request<T>(await hostdSocketFor(t.nodeId), method, path, body, timeout, max);
}

export interface HostdFileStream {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: http.IncomingMessage;
}

/** Streams a file; `range` is the client's Range header (206 / 416 passed through). */
async function openContent(t: HostdFileTarget, relPath: string, range?: string): Promise<HostdFileStream> {
  const socketPath = await hostdSocketFor(t.nodeId);
  const path = `${accountPath(t, '/content')}?path=${encodeURIComponent(relPath)}`;
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method: 'GET', path, headers: { Host: 'hostd', ...(range ? { Range: range } : {}) } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 400 && status !== 416) {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => { if (chunks.length < 64) chunks.push(c); });
        res.on('end', () => {
          let json: { error?: unknown; code?: unknown } | undefined;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
          reject(new HostdError(status, `hostd GET content: ${typeof json?.error === 'string' ? json.error : `HTTP ${status}`}`,
            typeof json?.code === 'string' ? json.code : undefined));
        });
        res.on('error', () => reject(new HostdError(503, 'hostd GET content: connection lost', 'hostdUnavailable')));
        return;
      }
      resolve({ status, headers: res.headers, body: res });
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', (err: NodeJS.ErrnoException) => reject(new HostdError(503, `hostd unreachable: ${err.code ?? err.message}`, 'hostdUnavailable')));
    req.end();
  });
}

/** Sends one chunk (exactly `length` bytes of `body`) at `offset` of the upload's temporary file. */
async function uploadChunk(t: HostdFileTarget, o: HostdFileOwner, relPath: string, uploadId: string, offset: number, length: number, body: Readable): Promise<void> {
  const socketPath = await hostdSocketFor(t.nodeId);
  const q = new URLSearchParams({ path: relPath, uid: String(o.uid), gid: String(o.gid), offset: String(offset) });
  const path = `${uploadPath(t, uploadId)}?${q}`;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve();
    };
    const req = http.request({
      socketPath, method: 'PUT', path,
      headers: { Host: 'hostd', 'Content-Type': 'application/octet-stream', 'Content-Length': length },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => { if (chunks.length < 64) chunks.push(c); });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) { done(); return; }
        let json: { error?: unknown; code?: unknown } | undefined;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        done(new HostdError(status, `hostd PUT chunk: ${typeof json?.error === 'string' ? json.error : `HTTP ${status}`}`,
          typeof json?.code === 'string' ? json.code : undefined));
      });
    });
    req.setTimeout(CHUNK_TIMEOUT_MS, () => { req.destroy(); done(new HostdError(504, 'hostd PUT chunk: timeout', 'hostdTimeout')); });
    req.on('error', (err: NodeJS.ErrnoException) => done(new HostdError(503, `hostd unreachable: ${err.code ?? err.message}`, 'hostdUnavailable')));
    body.on('error', (err) => { req.destroy(); done(new HostdError(400, `upload interrupted: ${err.message}`, 'uploadInterrupted')); });
    body.on('aborted', () => { req.destroy(); done(new HostdError(400, 'upload interrupted', 'uploadInterrupted')); });
    body.pipe(req);
  });
}

export const hostdFiles = {
  list: (t: HostdFileTarget, relPath: string) =>
    call<HostdFileListing>(t, 'GET', `${accountPath(t)}?path=${encodeURIComponent(relPath)}`, undefined, TIMEOUT_MS, MAX_LISTING_BYTES),

  openContent,

  mkdir: (t: HostdFileTarget, o: HostdFileOwner, relPath: string) =>
    call(t, 'POST', accountPath(t, '/mkdir'), { ...o, path: relPath }).then((): void => undefined),

  remove: (t: HostdFileTarget, o: HostdFileOwner, relPath: string) =>
    call(t, 'POST', accountPath(t, '/delete'), { ...o, path: relPath }, TREE_TIMEOUT_MS).then((): void => undefined),

  move: (t: HostdFileTarget, o: HostdFileOwner, from: string, to: string, overwrite: boolean) =>
    call(t, 'POST', accountPath(t, '/move'), { ...o, from, to, overwrite }).then((): void => undefined),

  copy: (t: HostdFileTarget, o: HostdFileOwner, from: string, to: string) =>
    call(t, 'POST', accountPath(t, '/copy'), { ...o, from, to }, TREE_TIMEOUT_MS).then((): void => undefined),

  uploadBegin: (t: HostdFileTarget, o: HostdFileOwner, relPath: string, uploadId: string, size: number, overwrite: boolean) =>
    call(t, 'POST', uploadPath(t, uploadId), { ...o, path: relPath, size, overwrite }).then((): void => undefined),

  uploadChunk,

  uploadCommit: (t: HostdFileTarget, o: HostdFileOwner, relPath: string, uploadId: string, size: number, overwrite: boolean) =>
    call(t, 'POST', uploadPath(t, uploadId, '/commit'), { ...o, path: relPath, size, overwrite }).then((): void => undefined),

  uploadAbort: (t: HostdFileTarget, o: HostdFileOwner, relPath: string, uploadId: string) =>
    call(t, 'DELETE', uploadPath(t, uploadId), { ...o, path: relPath }).then((): void => undefined),
};
