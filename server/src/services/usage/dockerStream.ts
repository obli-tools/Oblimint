// ─────────────────────────────────────────────────────────────────────────────
// Docker log stream helpers (module usage): incremental demultiplexer of the
// multiplexed `docker logs` body (8-byte frame headers when the container has
// no TTY) and a line splitter with a per-line cap. Pure (no I/O), unit-tested
// with byte-level fixtures; the edge log follower feeds them chunk by chunk.
// ─────────────────────────────────────────────────────────────────────────────

/** Docker stream types of a multiplexed frame header (byte 0). */
export const STREAM_STDIN = 0;
export const STREAM_STDOUT = 1;
export const STREAM_STDERR = 2;

const HEADER_BYTES = 8;
/** A frame larger than this is not a Docker frame header (corrupted stream): treated as raw. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export type FrameHandler = (stream: number, payload: Buffer) => void;

/**
 * Incremental demultiplexer. `push` accepts arbitrary chunk boundaries (a
 * header split across chunks, several frames in one chunk). `tty: true`
 * passes everything through as stdout (no framing).
 */
export function createDockerDemuxer(onFrame: FrameHandler, opts: { tty?: boolean } = {}): { push(chunk: Buffer): void } {
  if (opts.tty) return { push: (chunk) => { if (chunk.length) onFrame(STREAM_STDOUT, chunk); } };
  let pending: Buffer = Buffer.alloc(0);
  return {
    push(chunk: Buffer): void {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      while (pending.length - offset >= HEADER_BYTES) {
        const type = pending[offset];
        const size = pending.readUInt32BE(offset + 4);
        const valid = type <= STREAM_STDERR && pending[offset + 1] === 0 && pending[offset + 2] === 0 && pending[offset + 3] === 0
          && size <= MAX_FRAME_BYTES;
        if (!valid) {
          // Not a framed stream (TTY container answered raw): hand the rest over as stdout.
          onFrame(STREAM_STDOUT, pending.subarray(offset));
          offset = pending.length;
          break;
        }
        if (pending.length - offset - HEADER_BYTES < size) break;
        const start = offset + HEADER_BYTES;
        if (size > 0) onFrame(type, pending.subarray(start, start + size));
        offset = start + size;
      }
      pending = offset >= pending.length ? Buffer.alloc(0) : Buffer.from(pending.subarray(offset));
    },
  };
}

/**
 * Splits a byte stream into UTF-8 lines (\n, optional \r). A line longer than
 * `maxLineBytes` is truncated (the rest up to the next newline is dropped):
 * one hostile request cannot make the follower buffer without bound.
 */
export function createLineSplitter(onLine: (line: string) => void, maxLineBytes = 64 * 1024): { push(chunk: Buffer): void; flush(): void } {
  let parts: Buffer[] = [];
  let size = 0;
  let overflow = false;
  const emit = () => {
    let buf = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    if (buf.length && buf[buf.length - 1] === 0x0d) buf = buf.subarray(0, buf.length - 1);
    parts = [];
    size = 0;
    overflow = false;
    if (buf.length) onLine(buf.toString('utf8'));
  };
  const append = (b: Buffer) => {
    if (overflow || b.length === 0) return;
    const room = maxLineBytes - size;
    if (b.length > room) {
      if (room > 0) parts.push(Buffer.from(b.subarray(0, room)));
      size = maxLineBytes;
      overflow = true;
      return;
    }
    parts.push(Buffer.from(b));
    size += b.length;
  };
  return {
    push(chunk: Buffer): void {
      let start = 0;
      for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, start)) {
        append(chunk.subarray(start, i));
        emit();
        start = i + 1;
      }
      if (start < chunk.length) append(chunk.subarray(start));
    },
    flush(): void {
      if (size > 0) emit();
    },
  };
}

// ── Docker timestamps (`docker logs --timestamps`, RFC 3339 nano) ───────────

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/** Nanoseconds since the epoch of a Docker RFC 3339 timestamp, null when malformed. */
export function dockerTimestampNs(ts: string): bigint | null {
  const m = TS_RE.exec(ts);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}${m[3]}`);
  if (!Number.isFinite(ms)) return null;
  const frac = (m[2] ?? '').padEnd(9, '0');
  return BigInt(Math.floor(ms / 1000)) * 1_000_000_000n + BigInt(frac);
}

/** Docker API `since` value ("<seconds>.<nanoseconds>") of a position in ns. */
export function sinceParam(ns: bigint): string {
  const sec = ns / 1_000_000_000n;
  const frac = ns % 1_000_000_000n;
  return `${sec}.${frac.toString().padStart(9, '0')}`;
}

/** Inverse of sinceParam (checkpoint stored in app_config); null when malformed. */
export function parseSinceParam(v: string | null | undefined): bigint | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,12})\.(\d{9})$/.exec(v.trim());
  if (!m) return null;
  return BigInt(m[1]) * 1_000_000_000n + BigInt(m[2]);
}

/** Splits "<timestamp> <rest>" (a --timestamps line). ts null when the line has no timestamp prefix. */
export function splitTimestamp(line: string): { ts: bigint | null; rest: string } {
  const sp = line.indexOf(' ');
  if (sp > 0 && sp <= 40) {
    const ts = dockerTimestampNs(line.slice(0, sp));
    if (ts !== null) return { ts, rest: line.slice(sp + 1) };
  }
  return { ts: null, rest: line };
}
