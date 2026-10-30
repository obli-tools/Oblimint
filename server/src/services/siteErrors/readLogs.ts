import type { Readable } from 'stream';
import { LogDemuxer } from '../logs/dockerLogs';
import { tsKey } from './parse';

// ─────────────────────────────────────────────────────────────────────────────
// Bounded read of one container's `docker logs` STREAM (siteErrors collector).
// The collector runs every minute on every live site, unattended: the
// response is never buffered whole. Bytes are counted as they arrive, the
// stream is destroyed past the byte budget (per container, and what is left
// of the pass budget), and on abort (timeout) — so a slow or huge read really
// stops instead of buffering on behind a rejected promise. Only COMPLETE
// lines are kept (the line cut by the budget is dropped and read again next
// pass): the cursor is the last complete line read.
// ─────────────────────────────────────────────────────────────────────────────

export interface ByteBudget { left: number }

export interface StderrRead {
  lines: Array<{ at: string; text: string }>;
  /** Cursor after this read (tsKey of the last complete line kept), or the cursor given. */
  last: string | null;
  bytes: number;
  /** Stopped by the byte budget (the rest is read on a later pass). */
  truncated: boolean;
}

/**
 * `since` of `docker logs` (Unix "seconds.nanoseconds", which the Engine API
 * accepts; lines AT that time included): the cursor to the nanosecond, so a
 * read cut by the byte budget resumes at its last line instead of re-reading
 * — and re-charging — the whole second (a flood within one second would
 * otherwise never progress). No usable cursor: `fallbackMs`, whole seconds.
 */
export function sinceParam(cursor: string | null, fallbackMs: number): string {
  const m = cursor ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{9})Z$/.exec(cursor) : null;
  const sec = m ? Date.parse(`${m[1]}Z`) / 1000 : Number.NaN;
  if (m && Number.isFinite(sec) && sec >= 0) return `${sec}.${m[2]}`;
  return String(Math.max(0, Math.floor(fallbackMs / 1000)));
}

export class LogReadAborted extends Error {
  constructor(message = 'logs read aborted') { super(message); this.name = 'LogReadAborted'; }
}

/**
 * Reads a multiplexed (non-TTY) log stream: stderr lines with a Docker
 * timestamp strictly after `cursor`. `maxBytes` caps this container, `pass`
 * (shared by every read of a pass) caps the pass; both are charged.
 */
export function readStderrAfter(
  stream: Readable, cursor: string | null, o: { maxBytes: number; pass?: ByteBudget; signal?: AbortSignal },
): Promise<StderrRead> {
  return new Promise((resolve, reject) => {
    const lines: Array<{ at: string; text: string }> = [];
    let last = cursor;
    let bytes = 0;
    let settled = false;
    const demux = new LogDemuxer((l) => {
      if (l.stream !== 'stderr') return;
      const k = tsKey(l.at);
      if (!k || (cursor && k <= cursor)) return;
      if (!last || k > last) last = k;
      lines.push({ at: l.at, text: l.text });
    });

    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      o.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (truncated: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (truncated) stream.destroy();
      resolve({ lines, last, bytes, truncated });
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      stream.destroy();
      reject(err);
    };
    const room = () => Math.max(0, Math.min(o.maxBytes - bytes, o.pass ? o.pass.left : Number.POSITIVE_INFINITY));

    function onData(chunk: Buffer | string) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const r = room();
      const take = buf.length <= r ? buf : buf.subarray(0, r);
      bytes += take.length;
      if (o.pass) o.pass.left -= take.length;
      // Only complete lines come out of the demuxer: a line cut here is not kept.
      if (take.length) demux.push(take);
      if (take.length < buf.length) finish(true);
    }
    function onEnd() {
      demux.end();
      finish(false);
    }
    function onError(err: Error) { fail(err); }
    function onAbort() { fail(new LogReadAborted()); }

    if (o.signal?.aborted) { fail(new LogReadAborted()); return; }
    if (room() <= 0) { finish(true); return; }
    o.signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}
