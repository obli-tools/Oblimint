import crypto from 'crypto';
import { PassThrough, Transform, type Readable, type Writable } from 'stream';
import zlib from 'zlib';
import type { DbFamily } from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';

// ─────────────────────────────────────────────────────────────────────────────
// Restore body handling (module databases, docs/P2-PLAN.md §6.3 / §9.3) —
// the only non-JSON body of the API (middleware/originGuard RAW_UPLOAD_PATHS
// lets application/sql | application/gzip | application/x-gzip |
// application/octet-stream through, after the origin check). The body is
// STREAMED: never buffered nor written to disk; gzip is recognised by its
// magic bytes (1f 8b) whatever the declared type, and inflated on the fly.
// Limits: 2 GiB of request body, 16 GiB once inflated (gzip bomb).
// ─────────────────────────────────────────────────────────────────────────────

export const RESTORE_MAX_BYTES = 2 * 1024 ** 3;
export const RESTORE_MAX_INFLATED_BYTES = 16 * 1024 ** 3;
export const RESTORE_CONTENT_TYPES = ['application/sql', 'application/gzip', 'application/x-gzip', 'application/octet-stream'] as const;

/** Media type without parameters, lower-cased ('' when absent). */
export function mediaType(contentType: string | undefined | null): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

/** 415 unless the declared type is one of RESTORE_CONTENT_TYPES. */
export function assertRestoreContentType(contentType: string | undefined | null): void {
  const t = mediaType(contentType);
  if (!(RESTORE_CONTENT_TYPES as readonly string[]).includes(t)) {
    throw new AppError(415, `Restore body must be one of ${RESTORE_CONTENT_TYPES.join(', ')}`, 'validation', { field: 'content-type' });
  }
}

/**
 * Plain SQL or gzip, from the declared type and the first bytes. A body
 * declared gzip without the gzip magic is refused (400); any other type is
 * sniffed (a .sql.gz sent as octet-stream / sql is inflated).
 */
export function detectRestoreEncoding(contentType: string | undefined | null, head: Buffer): 'gzip' | 'plain' {
  const magic = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
  const t = mediaType(contentType);
  if ((t === 'application/gzip' || t === 'application/x-gzip') && !magic) {
    throw new AppError(400, 'The body is declared gzip but is not a gzip stream', 'validation', { field: 'body' });
  }
  return magic ? 'gzip' : 'plain';
}

export class RestoreLimitError extends AppError {
  constructor(what: string) {
    super(413, `Restore too large (${what})`, 'validation', { field: 'body' });
  }
}

/**
 * Turns the raw request into the SQL stream fed to the client: byte limit,
 * gzip detection on the first bytes, inflate, inflated limit. Errors destroy
 * the returned stream (AppError: 400 / 413).
 */
export function restoreSqlStream(
  input: Readable,
  contentType: string | undefined | null,
  limits: { maxBytes?: number; maxInflatedBytes?: number } = {},
): Readable {
  const maxBytes = limits.maxBytes ?? RESTORE_MAX_BYTES;
  const maxInflated = limits.maxInflatedBytes ?? RESTORE_MAX_INFLATED_BYTES;
  const out = new PassThrough();
  let received = 0;
  let produced = 0;
  let head: Buffer | null = Buffer.alloc(0);
  let sink: Writable | null = null;
  let failed = false;

  const fail = (err: Error) => {
    if (failed) return;
    failed = true;
    input.unpipe?.();
    input.pause();
    input.resume(); // drain the rest of the request without keeping it
    out.destroy(err);
  };

  const countOut = (chunk: Buffer) => {
    produced += chunk.length;
    if (produced > maxInflated) fail(new RestoreLimitError('inflated size'));
  };

  const decide = (): boolean => {
    if (sink) return true;
    try {
      const enc = detectRestoreEncoding(contentType, head!);
      if (enc === 'gzip') {
        const gunzip = zlib.createGunzip();
        gunzip.on('data', (c: Buffer) => {
          countOut(c);
          if (!failed && !out.write(c)) {
            gunzip.pause();
            out.once('drain', () => gunzip.resume());
          }
        });
        gunzip.on('end', () => { if (!failed) out.end(); });
        gunzip.on('error', () => fail(new AppError(400, 'The gzip stream is corrupt', 'validation', { field: 'body' })));
        sink = gunzip;
      } else {
        sink = new PassThrough();
        sink.on('data', (c: Buffer) => {
          countOut(c);
          if (!failed && !out.write(c)) {
            (sink as PassThrough).pause();
            out.once('drain', () => (sink as PassThrough).resume());
          }
        });
        sink.on('end', () => { if (!failed) out.end(); });
      }
      return true;
    } catch (err) {
      fail(err as Error);
      return false;
    }
  };

  const write = (chunk: Buffer) => {
    if (!sink!.write(chunk)) {
      input.pause();
      sink!.once('drain', () => input.resume());
    }
  };

  input.on('data', (raw: Buffer | string) => {
    if (failed) return;
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    received += chunk.length;
    if (received > maxBytes) { fail(new RestoreLimitError('request body')); return; }
    if (!sink) {
      head = Buffer.concat([head!, chunk]);
      if (head.length < 2) return;
      if (!decide()) return;
      const buffered = head;
      head = null;
      write(buffered);
      return;
    }
    write(chunk);
  });
  input.on('end', () => {
    if (failed) return;
    if (!sink) {
      if (!head || head.length === 0) { fail(new AppError(400, 'Empty restore body', 'validation', { field: 'body' })); return; }
      if (!decide()) return;
      sink!.write(head);
      head = null;
    }
    sink!.end();
  });
  input.on('error', (err) => fail(err));
  input.on('aborted', () => fail(new AppError(400, 'Upload aborted', 'validation')));
  return out;
}

// ── restore content rewriting (the dump is tenant content) ───────────────────
//
// The restore runs as a NON-superuser (databases.service): what is left to
// neutralise is client-side.
//  - PostgreSQL: psql has no flag against its meta-commands (\! = a shell
//    in the instance container, \connect, \copy … program …), so the stream
//    starts with `\restrict <random key>` (psql 15.14 / 16.10 / 17.6+): every
//    backslash command but `\unrestrict <that key>` is refused. The dump's own
//    \restrict / \unrestrict lines (pg_dump 17.6+ emits them) are removed —
//    psql would refuse them once restricted.
//  - MySQL family: DEFINER=… clauses are removed (a non-superuser may only
//    name itself): views / triggers / routines / events get the database's
//    restore account as definer (sql.ts mysqlRestoreUser*).
// Bytes are handled as latin1 (1:1, a UTF-8 sequence is never split), lines
// kept intact across chunks; memory stays bounded whatever the line length.

const REWRITE_CARRY = 4096;
/** A "\restrict …" / "\unrestrict …" line WITH the line break before it (the one after it stays). */
const PSQL_RESTRICT_RE = /\r?\n\\(?:un)?restrict(?:[ \t][^\r\n]{0,250})?(?=\r?\n)/g;
const PSQL_RESTRICT_END_RE = /\r?\n\\(?:un)?restrict(?:[ \t][^\r\n]{0,250})?(?=\r?\n|$)/g;
/** A MySQL user / host part: `quoted`, 'quoted', "quoted" or bare. */
const MYSQL_ID = String.raw`(?:` + '`' + String.raw`(?:[^` + '`' + String.raw`\n]|` + '``' + String.raw`){0,300}` + '`'
  + String.raw`|'(?:[^'\\\n]|\\.){0,300}'|"[^"\n]{0,300}"|[A-Za-z0-9_.%$-]{1,300})`;
const MYSQL_DEFINER_RE = new RegExp(String.raw`DEFINER[ \t]{0,10}=[ \t]{0,10}` + MYSQL_ID + String.raw`[ \t]{0,10}@[ \t]{0,10}` + MYSQL_ID, 'gi');

/** Restrict key for psql (alphanumeric). */
export function psqlRestrictKey(): string {
  return crypto.randomBytes(24).toString('hex');
}

export function createRestoreRewriter(family: DbFamily, opts: { restrictKey?: string } = {}): Transform {
  if (family === 'postgresql' && !opts.restrictKey) throw new Error('restrictKey required');
  const prefix = family === 'postgresql' ? `\\restrict ${opts.restrictKey}\n` : '';
  const pattern = family === 'postgresql' ? PSQL_RESTRICT_RE : MYSQL_DEFINER_RE;
  const patternAtEnd = family === 'postgresql' ? PSQL_RESTRICT_END_RE : MYSQL_DEFINER_RE;
  // A virtual "\n" makes the start of the stream a line start; the leading
  // "\n" of the first output is dropped (that one, or — when the first line
  // was removed — that line's own line break).
  let carry = '\n';
  let first = true;
  const emit = (t: Transform, text: string): void => {
    if (first) {
      if (text.startsWith('\n')) text = text.slice(1);
      text = prefix + text;
      first = false;
    }
    if (text) t.push(Buffer.from(text, 'latin1'));
  };
  return new Transform({
    transform(chunk: Buffer | string, _enc, cb) {
      // `carry` is RAW text (never rewritten twice).
      const buf = carry + (Buffer.isBuffer(chunk) ? chunk.toString('latin1') : chunk);
      if (buf.length <= 2 * REWRITE_CARRY) {
        carry = buf;
        cb();
        return;
      }
      // Emit up to a line break leaving at least REWRITE_CARRY bytes behind
      // (the patterns never span a line break), or inside one long line.
      let cut = buf.lastIndexOf('\n', buf.length - REWRITE_CARRY);
      if (cut <= 0) cut = buf.length - REWRITE_CARRY;
      let out = '';
      let pos = 0;
      pattern.lastIndex = 0;
      for (let m = pattern.exec(buf); m; m = pattern.exec(buf)) {
        const start = m.index;
        const end = start + m[0].length;
        if (start >= cut) break;
        if (end >= buf.length) { cut = start; break; } // may grow with the next bytes: decided later
        out += buf.slice(pos, start);
        pos = end;
        if (end > cut) { cut = end; break; } // straddles the cut: the cut moves after it
        if (m[0].length === 0) pattern.lastIndex++;
      }
      out += buf.slice(pos, Math.max(pos, cut));
      carry = buf.slice(Math.max(pos, cut));
      emit(this, out);
      cb();
    },
    flush(cb) {
      emit(this, carry.replace(patternAtEnd, ''));
      cb();
    },
  });
}
