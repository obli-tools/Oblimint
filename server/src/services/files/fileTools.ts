import crypto from 'crypto';
import { Readable } from 'stream';
import { StringDecoder } from 'string_decoder';
import { Worker } from 'worker_threads';
import {
  FILE_EDIT_MAX_BYTES, FILE_HASH_MAX_BYTES, FILE_LIST_HASH_MAX_BYTES, FILE_LIST_HASH_MAX_FILES, FILE_READ_MAX_CHARS, FILE_READ_MAX_LINES,
  FILE_READ_MAX_RANGE, FILE_SEARCH_DEFAULT_RESULTS, FILE_SEARCH_MAX_BYTES, FILE_SEARCH_MAX_FILE_BYTES, FILE_SEARCH_MAX_FILES, FILE_SEARCH_MAX_MS,
  FILE_SEARCH_MAX_PER_FILE, FILE_SEARCH_MAX_RESULTS, FILE_SEARCH_VENDOR_DIRS,
  type FileEdit, type FileEditResult, type FileEntry, type FileRange, type FileSearchMatch, type FileSearchResult, type FileSearchStop,
} from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';
import type { HostdFileEntry, HostdFileStream } from '../hostd/files';
import type { AccountRow } from '../hosting/rows';
import { assertWritable, fileError, filesBackend, filesService, joinVirtual, splitVirtual } from './files.service';

// ─────────────────────────────────────────────────────────────────────────────
// Fine file tools of the access keys (shared/src/files.ts « Fine file tools »):
// bounded search, partial reads, exact edits, SHA-256 preconditions. Every
// disk access goes through hostd like the explorer (no link followed); paths
// are virtual (/staging/<slug>/…). The precondition (content hash) is checked
// before the write, which is then pinned to the mtime seen (expectedMtime +
// mustExist): checked again once the whole body is in, right before hostd's
// rename (putSmall, the last chunk of a session). Only a change landing between
// that last stat and the rename (one hostd round trip) can slip by.
// ─────────────────────────────────────────────────────────────────────────────

const NUL_SNIFF_BYTES = 8192;
const SHA256_RE = /^[0-9a-f]{64}$/;

const invalidPath = () => new AppError(400, 'Invalid path', 'invalidPath');
const notFound = (p: string) => new AppError(404, `${p}: no such file`, 'fileNotFound');

/** A caller's expected hash: 64 hex characters (case ignored), else 400. */
export function normalizeSha256(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().toLowerCase().replace(/^"|"$/g, '') : '';
  if (!SHA256_RE.test(s)) throw new AppError(400, 'expectedSha256 must be the 64 hexadecimal characters of a SHA-256', 'invalidSha256');
  return s;
}

/** The entry of a file in its parent folder (null when absent). */
async function entryOf(a: AccountRow, segs: string[]): Promise<HostdFileEntry | null> {
  if (segs.length < 3) throw invalidPath();
  try {
    const l = await filesBackend.hostd().list(filesBackend.target(a), segs.slice(0, -1).join('/'));
    return l.entries.find((e) => e.name === segs[segs.length - 1]) ?? null;
  } catch (err) {
    const e = fileError(err);
    if (e.code === 'fileNotFound') return null;
    throw e;
  }
}

async function openFile(a: AccountRow, segs: string[], range?: string): Promise<HostdFileStream> {
  if (segs.length < 3) throw invalidPath();
  try {
    return await filesBackend.hostd().openContent(filesBackend.target(a), segs.join('/'), range);
  } catch (err) { throw fileError(err); }
}

interface Streamed { sha256: string; size: number; mtime: number }

/** Reads a whole file through `onChunk`, hashing it (the caller checked its size). */
async function stream(s: HostdFileStream, onChunk?: (c: Buffer) => void): Promise<Streamed> {
  const h = crypto.createHash('sha256');
  let size = 0;
  try {
    for await (const c of s.body as AsyncIterable<Buffer>) {
      h.update(c);
      size += c.length;
      if (size > FILE_HASH_MAX_BYTES) throw new AppError(413, 'The file grew beyond the hashing limit while being read', 'fileTooLarge');
      onChunk?.(c);
    }
  } catch (err) {
    s.body.destroy();
    throw err instanceof AppError ? err : new AppError(503, 'The file could not be read', 'backendUnavailable');
  }
  return { sha256: h.digest('hex'), size, mtime: Number(s.headers['x-oblimint-mtime'] ?? 0) };
}

const sizeOf = (s: HostdFileStream) => Number(s.headers['x-oblimint-size'] ?? s.headers['content-length'] ?? 0);

/** Whole content + hash of a file (≤ max bytes, else 413 fileTooLarge). */
async function readWhole(a: AccountRow, segs: string[], max: number): Promise<Streamed & { buf: Buffer }> {
  const s = await openFile(a, segs);
  if (sizeOf(s) > max) {
    s.body.destroy();
    throw new AppError(413, `The file is larger than ${Math.round(max / 1024 / 1024)} MB`, 'fileTooLarge');
  }
  const chunks: Buffer[] = [];
  let n = 0;
  const r = await stream(s, (c) => {
    n += c.length;
    if (n > max) throw new AppError(413, `The file is larger than ${Math.round(max / 1024 / 1024)} MB`, 'fileTooLarge');
    chunks.push(c);
  });
  return { ...r, buf: Buffer.concat(chunks) };
}

/** SHA-256 of a whole file (null above FILE_HASH_MAX_BYTES). */
async function hashFile(a: AccountRow, segs: string[]): Promise<{ sha256: string | null; size: number; mtime: number }> {
  const s = await openFile(a, segs);
  const size = sizeOf(s);
  if (size > FILE_HASH_MAX_BYTES) {
    s.body.destroy();
    return { sha256: null, size, mtime: Number(s.headers['x-oblimint-mtime'] ?? 0) };
  }
  return stream(s);
}

function changed(path: string, current: { sha256: string | null; size: number | null; mtime: number | null }): AppError {
  return new AppError(409, `${path} was changed since you read it (another user, SFTP or another agent): read it again, then redo your change on the current content`,
    'fileChanged', { currentSha256: current.sha256, size: current.size, mtime: current.mtime });
}

/**
 * The precondition of a write: the file exists, is a regular file and its
 * content hashes to `expected` (409 fileChanged with the current hash
 * otherwise, currentSha256 null when it does not exist). Returns its mtime
 * (the write is pinned to it).
 */
async function assertSha256(a: AccountRow, rawPath: unknown, expected: unknown): Promise<number> {
  const want = normalizeSha256(expected);
  const segs = splitVirtual(rawPath);
  const path = joinVirtual(segs);
  const e = await entryOf(a, segs);
  if (!e) throw changed(path, { sha256: null, size: null, mtime: null });
  if (e.kind !== 'file') throw new AppError(409, `${path} is not a regular file`, 'notRegular');
  const cur = await hashFile(a, segs);
  if (cur.sha256 === null) throw new AppError(413, 'The file is too large to be hashed: write it without expectedSha256', 'fileTooLarge');
  if (cur.sha256 !== want) throw changed(path, cur);
  return cur.mtime;
}

/**
 * A bare fileChanged (the mtime pin of putSmall / an upload's commit) →
 * the same error with the current state (currentSha256 null: the file is
 * gone or no longer a regular file). Any other error is returned unchanged.
 */
async function withCurrent(a: AccountRow, rawPath: unknown, err: unknown, shownPath?: string): Promise<unknown> {
  if (!(err instanceof AppError) || err.code !== 'fileChanged' || (err.details && 'currentSha256' in (err.details as object))) return err;
  const segs = splitVirtual(rawPath);
  const path = shownPath ?? joinVirtual(segs);
  try {
    const e = await entryOf(a, segs);
    if (!e || e.kind !== 'file') return changed(path, { sha256: null, size: null, mtime: null });
    return changed(path, await hashFile(a, segs));
  } catch {
    return changed(path, { sha256: null, size: null, mtime: null }); // vanished meanwhile
  }
}

// ── Partial read ─────────────────────────────────────────────────────────────

export interface ReadRangeOptions {
  /** Lines mode (default): 1-based, inclusive. */
  startLine?: number;
  endLine?: number;
  /** Bytes mode as soon as one is given. */
  offset?: number;
  length?: number;
  /** Bytes mode: utf8 (default) or base64. */
  encoding?: 'utf8' | 'base64';
  /** Lines mode: characters returned at most (≤ FILE_READ_MAX_CHARS; MCP answers are smaller). */
  maxChars?: number;
}

const intOpt = (v: unknown, min: number, name: string): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw new AppError(400, `${name} must be an integer ≥ ${min}`, 'invalid');
  return v;
};

async function readRange(a: AccountRow, rawPath: unknown, opts: ReadRangeOptions = {}): Promise<FileRange> {
  const segs = splitVirtual(rawPath);
  const path = joinVirtual(segs);
  const offset = intOpt(opts.offset, 0, 'offset');
  const length = intOpt(opts.length, 1, 'length');
  const startLine = intOpt(opts.startLine, 1, 'startLine');
  const endLine = intOpt(opts.endLine, 1, 'endLine');
  const bytesMode = offset !== undefined || length !== undefined;
  if (bytesMode && (startLine !== undefined || endLine !== undefined)) throw new AppError(400, 'Give a line range or a byte range, not both', 'invalid');
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) throw new AppError(400, 'endLine is before startLine', 'invalid');
  const base: FileRange = {
    path, mode: bytesMode ? 'bytes' : 'lines', size: 0, mtime: 0, sha256: null, totalLines: null, startLine: null, endLine: null, nextLine: null,
    offset: null, length: null, nextOffset: null, encoding: bytesMode ? (opts.encoding ?? 'utf8') : 'utf8', content: null, binary: false, tooLarge: false, truncated: false,
  };
  if (bytesMode) return readBytes(a, segs, base, offset ?? 0, Math.min(length ?? FILE_READ_MAX_RANGE, FILE_READ_MAX_RANGE));

  const first = startLine ?? 1;
  const last = Math.min(endLine ?? Number.MAX_SAFE_INTEGER, first + FILE_READ_MAX_LINES - 1);
  const asked = endLine ?? Number.MAX_SAFE_INTEGER;
  const s = await openFile(a, segs);
  const size = sizeOf(s);
  if (size > FILE_HASH_MAX_BYTES) {
    s.body.destroy();
    return { ...base, size, mtime: Number(s.headers['x-oblimint-mtime'] ?? 0), tooLarge: true };
  }
  const maxChars = Math.max(1, Math.min(opts.maxChars ?? FILE_READ_MAX_CHARS, FILE_READ_MAX_CHARS));
  const decoder = new StringDecoder('utf8');
  const out: string[] = [];
  let chars = 0;
  let lineNo = 0; // completed lines
  let pieces: string[] = [];
  let curLen = 0;
  let stoppedAt: number | null = null; // first line NOT returned because of the caps
  let sniffed = 0;
  let binary = false;
  let cutLine = false;
  const keeping = () => stoppedAt === null && !binary && lineNo + 1 >= first && lineNo + 1 <= last;
  const endLineNow = () => {
    lineNo++;
    if (stoppedAt === null && !binary && lineNo >= first && lineNo <= last) {
      let line = pieces.join('');
      if (chars + line.length > maxChars) {
        if (out.length) {
          stoppedAt = lineNo;
        } else {
          line = line.slice(0, maxChars); // one huge line: cut, continue after it
          cutLine = true;
          out.push(line);
          chars += line.length;
          stoppedAt = lineNo + 1;
        }
      } else {
        out.push(line);
        chars += line.length;
      }
    }
    pieces = [];
    curLen = 0;
  };
  const feed = (text: string) => {
    let pos = 0;
    for (;;) {
      const i = text.indexOf('\n', pos);
      const part = i === -1 ? text.slice(pos) : text.slice(pos, i);
      if (keeping() && curLen <= maxChars) { pieces.push(part); curLen += part.length; }
      else if (part.length) curLen += part.length;
      if (i === -1) return;
      endLineNow();
      pos = i + 1;
    }
  };
  const r = await stream(s, (c) => {
    if (sniffed < NUL_SNIFF_BYTES) {
      if (c.subarray(0, NUL_SNIFF_BYTES - sniffed).includes(0)) binary = true;
      sniffed += c.length;
    }
    if (!binary) feed(decoder.write(c));
  });
  if (!binary) {
    feed(decoder.end());
    if (curLen > 0) endLineNow();
  }
  const total = binary ? null : lineNo;
  if (binary) return { ...base, size: r.size, mtime: r.mtime, sha256: r.sha256, binary: true };
  const lastReturned = first + out.length - 1;
  // More lines asked than returned (caps), or the default window stopped before the end.
  const next = stoppedAt !== null ? stoppedAt : (lastReturned < Math.min(asked, lineNo) ? lastReturned + 1 : null);
  return {
    ...base, size: r.size, mtime: r.mtime, sha256: r.sha256, totalLines: total, startLine: first, endLine: lastReturned,
    nextLine: next !== null && next <= lineNo ? next : null, content: out.join('\n'),
    truncated: cutLine || (next !== null && next <= Math.min(asked, lineNo)),
  };
}

async function readBytes(a: AccountRow, segs: string[], base: FileRange, offset: number, length: number): Promise<FileRange> {
  const s = await openFile(a, segs);
  const size = sizeOf(s);
  const mtime = Number(s.headers['x-oblimint-mtime'] ?? 0);
  let window: Buffer;
  let sha256: string | null = null;
  if (size <= FILE_HASH_MAX_BYTES) {
    const parts: Buffer[] = [];
    let pos = 0;
    const r = await stream(s, (c) => {
      const from = Math.max(offset - pos, 0);
      const to = Math.min(offset + length - pos, c.length);
      if (to > from) parts.push(c.subarray(from, to));
      pos += c.length;
    });
    sha256 = r.sha256;
    window = Buffer.concat(parts);
  } else {
    // Too large to hash: only the window is read (Range).
    s.body.destroy();
    if (offset >= size) {
      window = Buffer.alloc(0);
    } else {
      const part = await openFile(a, segs, `bytes=${offset}-${offset + length - 1}`);
      const chunks: Buffer[] = [];
      for await (const c of part.body as AsyncIterable<Buffer>) chunks.push(c);
      window = Buffer.concat(chunks).subarray(0, length);
    }
  }
  const end = offset + window.length;
  const binary = base.encoding === 'utf8' && window.includes(0);
  return {
    ...base, size, mtime, sha256, offset, length: window.length, nextOffset: end < size ? end : null,
    content: binary ? null : window.toString(base.encoding), binary,
  };
}

// ── Exact edits ──────────────────────────────────────────────────────────────

/** Replacements of one edit_file call at most (each costs CPU on the event loop). */
const EDIT_MAX_REPLACEMENTS = 100_000;

/** Non-overlapping occurrences, counting stops past `limit`. */
function countOf(hay: string, needle: string, limit = Number.MAX_SAFE_INTEGER): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1 && n <= limit; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * Applies exact replacements to a text file, all or nothing: each oldString
 * must occur exactly once (or replaceAll) in the content as left by the
 * previous edits. expectedSha256: the content must still be the one read.
 */
async function edit(a: AccountRow, rawPath: unknown, edits: FileEdit[], expectedSha256?: unknown): Promise<FileEditResult> {
  const segs = splitVirtual(rawPath);
  if (segs.length < 3) throw invalidPath();
  const path = joinVirtual(segs);
  if (!Array.isArray(edits) || !edits.length) throw new AppError(400, 'Give at least one edit', 'invalid');
  const want = expectedSha256 === undefined || expectedSha256 === null ? null : normalizeSha256(expectedSha256);
  await assertWritable(a);
  const e = await entryOf(a, segs);
  if (!e) throw want ? changed(path, { sha256: null, size: null, mtime: null }) : notFound(path);
  if (e.kind !== 'file') throw new AppError(409, `${path} is not a regular file`, 'notRegular');
  const cur = await readWhole(a, segs, FILE_EDIT_MAX_BYTES);
  if (want && cur.sha256 !== want) throw changed(path, cur);
  if (cur.buf.subarray(0, NUL_SNIFF_BYTES).includes(0)) throw new AppError(400, `${path} is a binary file: write it whole`, 'binaryFile');
  let text = cur.buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(cur.buf)) throw new AppError(400, `${path} is not valid UTF-8: write it whole`, 'notUtf8');
  let replacements = 0;
  let bytes = cur.buf.length;
  edits.forEach((ed, index) => {
    if (typeof ed?.oldString !== 'string' || typeof ed?.newString !== 'string' || ed.oldString === '') {
      throw new AppError(400, `Edit ${index}: oldString must be a non-empty string, newString a string`, 'invalid');
    }
    if (ed.oldString === ed.newString) throw new AppError(400, `Edit ${index}: oldString and newString are the same`, 'editNoChange', { index });
    const n = countOf(text, ed.oldString, EDIT_MAX_REPLACEMENTS - replacements);
    if (replacements + n > EDIT_MAX_REPLACEMENTS) {
      throw new AppError(400, `Edit ${index}: more than ${EDIT_MAX_REPLACEMENTS} replacements in one call: write the file whole`, 'tooManyReplacements', { index });
    }
    if (n === 0) throw new AppError(409, `Edit ${index}: oldString was not found (read the file again: exact text, spaces and line endings included)`, 'editNotFound', { index, currentSha256: cur.sha256 });
    if (n > 1 && ed.replaceAll !== true) {
      throw new AppError(409, `Edit ${index}: oldString occurs ${n} times: add surrounding lines to make it unique, or replaceAll`, 'editNotUnique', { index, occurrences: n, currentSha256: cur.sha256 });
    }
    // The size the content will have, BEFORE building it (chained replaceAll can grow it exponentially).
    bytes += n * (Buffer.byteLength(ed.newString, 'utf8') - Buffer.byteLength(ed.oldString, 'utf8'));
    if (bytes > FILE_EDIT_MAX_BYTES) throw new AppError(413, `Edit ${index}: the edited file would be larger than 8 MB`, 'fileTooLarge', { index });
    text = text.split(ed.oldString).join(ed.newString); // literal ("$&" / "$1" stay as is)
    replacements += n;
  });
  const out = Buffer.from(text, 'utf8');
  if (out.length > FILE_EDIT_MAX_BYTES) throw new AppError(413, 'The edited file would be larger than 8 MB', 'fileTooLarge');
  // Pinned to the mtime of the content just read (409 fileChanged when it moved, or vanished, since).
  try {
    await filesService.putSmall(a, { path, size: out.length, expectedMtime: cur.mtime, mustExist: true }, Readable.from([out]));
  } catch (err) {
    throw await withCurrent(a, path, err);
  }
  return {
    path, size: out.length, sha256: crypto.createHash('sha256').update(out).digest('hex'), previousSha256: cur.sha256, replacements,
    executableBitLost: (e.mode & 0o111) !== 0,
  };
}

// ── Listing with hashes ──────────────────────────────────────────────────────

/** Answers of `items`, in order, at most `limit` running at once (a worker stops when `stop()`). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>, stop: () => boolean = () => false): Promise<Array<R | undefined>> {
  const out = new Array<R | undefined>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Adds sha256 to the regular files of a listing (FILE_LIST_HASH_MAX_FILES / _BYTES budget; the rest null). */
async function hashListing(a: AccountRow, dirVirtual: string, entries: FileEntry[]): Promise<{ entries: FileEntry[]; skipped: number }> {
  const dir = splitVirtual(dirVirtual);
  let files = 0;
  let bytes = 0;
  const picked: FileEntry[] = [];
  const out = entries.map((e) => {
    if (e.kind !== 'file') return e;
    const x: FileEntry = { ...e, sha256: null };
    if (dir.length >= 2 && files < FILE_LIST_HASH_MAX_FILES && bytes + e.size <= FILE_LIST_HASH_MAX_BYTES) {
      files++;
      bytes += e.size;
      picked.push(x);
    }
    return x;
  });
  await mapLimit(picked, 4, async (x) => {
    try {
      x.sha256 = (await hashFile(a, [...dir, x.name])).sha256;
    } catch {
      x.sha256 = null; // vanished or replaced meanwhile: no hash rather than a failed listing
    }
  });
  return { entries: out, skipped: out.filter((e) => e.kind === 'file' && e.sha256 === null).length };
}

// ── Search ───────────────────────────────────────────────────────────────────

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tif', 'tiff', 'psd', 'heic', 'svgz',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'tar', 'jar', 'war', 'phar',
  'mp3', 'mp4', 'm4a', 'm4v', 'wav', 'ogg', 'oga', 'webm', 'mov', 'avi', 'mkv', 'flac', 'aac',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  'so', 'dll', 'exe', 'bin', 'dat', 'db', 'sqlite', 'sqlite3', 'mo', 'class', 'pyc', 'wasm', 'swf',
]);

// Globs are matched by a dynamic program over (glob token, path character):
// O(tokens × length) whatever the glob, never a backtracking RegExp (a glob
// like "*a*a*a*a*a*b" against a long name would hold the event loop).
const enum Tok { Char, One, Star, Globstar, GlobstarSlash }
type GlobToken = { t: Tok; c?: number };
const SLASH = 47;
const GLOB_MAX_ALTERNATIVES = 16;
const GLOB_MAX_TOKENS = 4000; // all globs of one search, alternatives included

function tokenize(g: string): GlobToken[] {
  const out: GlobToken[] = [];
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    const last = out[out.length - 1]?.t;
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/';
        i += slash ? 2 : 1;
        if (slash || last !== Tok.Globstar) out.push({ t: slash ? Tok.GlobstarSlash : Tok.Globstar });
      } else if (last !== Tok.Globstar) out.push({ t: Tok.Star }); // "***…": one "**" covers the run
    } else if (c === '?') out.push({ t: Tok.One });
    else out.push({ t: Tok.Char, c: g.charCodeAt(i) });
  }
  return out;
}

function tokensMatch(toks: GlobToken[], s: string): boolean {
  const n = s.length;
  let prev = new Uint8Array(n + 1);
  let cur = new Uint8Array(n + 1);
  prev[0] = 1;
  for (const tk of toks) {
    cur.fill(0);
    let anyOn = false;
    let seen = 0; // some prev[k] with k < j
    for (let j = 0; j <= n; j++) {
      let v = 0;
      switch (tk.t) {
        case Tok.Char: v = j > 0 && prev[j - 1] && s.charCodeAt(j - 1) === tk.c ? 1 : 0; break;
        case Tok.One: v = j > 0 && prev[j - 1] && s.charCodeAt(j - 1) !== SLASH ? 1 : 0; break;
        case Tok.Star: v = prev[j] || (j > 0 && cur[j - 1] && s.charCodeAt(j - 1) !== SLASH) ? 1 : 0; break;
        case Tok.Globstar: v = prev[j] || (j > 0 && cur[j - 1]) ? 1 : 0; break;
        case Tok.GlobstarSlash: v = prev[j] || (j > 0 && seen && s.charCodeAt(j - 1) === SLASH) ? 1 : 0; break; // (?:.*\/)?
      }
      seen |= prev[j];
      cur[j] = v;
      if (v) anyOn = true;
    }
    if (!anyOn) return false;
    [prev, cur] = [cur, prev];
  }
  return prev[n] === 1;
}

/** "{a,b}" groups (not nested) → the plain globs (at most GLOB_MAX_ALTERNATIVES). */
function expandBraces(glob: string, g: string): string[] {
  let outs = [''];
  for (let i = 0; i < g.length; i++) {
    if (g[i] !== '{') { outs = outs.map((o) => o + g[i]); continue; }
    const end = g.indexOf('}', i + 1);
    if (end === -1) throw new AppError(400, `Invalid glob: ${glob}`, 'invalid');
    const alts = g.slice(i + 1, end).split(',');
    if (outs.length * alts.length > GLOB_MAX_ALTERNATIVES) throw new AppError(400, `Glob ${glob}: at most ${GLOB_MAX_ALTERNATIVES} alternatives`, 'invalid');
    outs = outs.flatMap((o) => alts.map((x) => o + x));
    i = end;
  }
  return outs;
}

/** A glob ("*.php", "wp-content/**", "src/{a,b}/*.js") → a matcher of a slash-separated relative path. */
export function compileGlob(glob: string): { test: (s: string) => boolean; tokens: number } {
  const alts = expandBraces(glob, glob.trim().replace(/^\/+/, '')).map(tokenize);
  return { test: (s) => alts.some((t) => tokensMatch(t, s)), tokens: alts.reduce((n, t) => n + t.length, 0) };
}

/** A glob without "/" matches the file name, otherwise the path relative to the area root. */
function globMatcher(globs: string[] | undefined): ((rel: string) => boolean) | null {
  if (!globs?.length) return null;
  const list = globs.map((g) => ({ m: compileGlob(g), base: !g.replace(/^\/+/, '').includes('/') }));
  if (list.reduce((n, x) => n + x.m.tokens, 0) > GLOB_MAX_TOKENS) throw new AppError(400, 'The include / exclude globs are too long', 'invalid');
  return (rel) => list.some(({ m, base }) => m.test(base ? rel.slice(rel.lastIndexOf('/') + 1) : rel));
}

export interface SearchOptions {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  /** Globs on the path relative to the area root (a glob without "/" matches the file name). */
  include?: string[];
  exclude?: string[];
  /** Also search vendor, node_modules, .git… */
  includeVendor?: boolean;
  maxResults?: number;
  maxPerFile?: number;
}

export interface SearchLimits { files: number; bytes: number; ms: number; fileBytes: number }
const DEFAULT_LIMITS: SearchLimits = { files: FILE_SEARCH_MAX_FILES, bytes: FILE_SEARCH_MAX_BYTES, ms: FILE_SEARCH_MAX_MS, fileBytes: FILE_SEARCH_MAX_FILE_BYTES };

/**
 * Regular expressions run in a worker thread (one per regex search), never on
 * the event loop: a slow or catastrophic one only costs that worker, which is
 * terminated when a file takes longer than its time. Lines lose one trailing
 * "\r" first (CRLF files: "…;$" matches like on LF files).
 */
const REGEX_WORKER = `
const { parentPort } = require('worker_threads');
let re = null;
parentPort.on('message', (m) => {
  if (m.src !== undefined) { re = new RegExp(m.src, m.flags); return; }
  const out = [];
  const lines = m.text.split('\\n');
  for (let i = 0; i < lines.length && out.length < m.max * 2; i++) {
    const l = lines[i].endsWith('\\r') ? lines[i].slice(0, -1) : lines[i];
    const r = re.exec(l);
    if (r) out.push(i + 1, r.index);
  }
  parentPort.postMessage(out);
});`;

class RegexRunner {
  private w: Worker | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly src: string, private readonly flags: string) {}

  /** [line, index] pairs of a text, 'timeout' past `timeoutMs` (calls run one after the other). */
  run(text: string, max: number, timeoutMs: () => number): Promise<number[] | 'timeout'> {
    const p = this.tail.then(() => this.exec(text, max, timeoutMs));
    this.tail = p.catch(() => undefined);
    return p;
  }

  private async exec(text: string, max: number, timeoutMs: () => number): Promise<number[] | 'timeout'> {
    if (this.closed) return 'timeout';
    if (!this.w) {
      const w = new Worker(REGEX_WORKER, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 } });
      w.postMessage({ src: this.src, flags: this.flags });
      this.w = w;
      // Its start-up is not the regex's time.
      await new Promise<void>((resolve, reject) => {
        w.once('online', () => resolve());
        w.once('error', reject);
      });
    }
    const w = this.w;
    const ms = timeoutMs();
    if (this.closed || !w || ms <= 0) return 'timeout';
    return new Promise((resolve, reject) => {
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        w.off('message', onMessage);
        w.off('error', onError);
        w.off('exit', onExit);
        fn();
      };
      const onMessage = (out: number[]) => settle(() => resolve(out));
      const onError = (err: Error) => settle(() => { this.kill(); reject(err); });
      const onExit = () => settle(() => { this.w = null; reject(new Error('The regular expression worker stopped')); });
      const timer = setTimeout(() => settle(() => { this.kill(); resolve('timeout'); }), ms);
      w.on('message', onMessage);
      w.on('error', onError);
      w.on('exit', onExit);
      w.postMessage({ text, max });
    });
  }

  private kill(): void {
    const w = this.w;
    this.w = null;
    if (w) void w.terminate().catch(() => undefined);
  }

  close(): void {
    this.closed = true;
    this.kill();
  }
}

/** Searches running at once per account (each holds hostd reads). */
const MAX_SEARCHES_PER_ACCOUNT = 2;
const running = new Map<number, number>();
/** Regex searches running at once on the whole server (one worker thread each). */
const MAX_REGEX_SEARCHES = 4;
let regexRunning = 0;
/** Per file: a regex still running past this is too slow (smaller when the search's whole budget is smaller). */
const REGEX_FILE_MS = 2000;
/** Walk: the event loop is given back every so many entries (long folders, many globs). */
const WALK_YIELD_EVERY = 64;

const LINE_SHOWN = 300;
function shown(line: string, col: number): string {
  const l = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (l.length <= LINE_SHOWN) return l;
  const from = Math.max(0, Math.min(col - 100, l.length - LINE_SHOWN));
  return `${from > 0 ? '…' : ''}${l.slice(from, from + LINE_SHOWN)}${from + LINE_SHOWN < l.length ? '…' : ''}`;
}

/**
 * Searches the text files under a folder (virtual path, inside a site area).
 * Links are never followed, binary files (extension or a NUL byte) and files
 * over limits.fileBytes are skipped, vendor folders unless includeVendor;
 * bounded in results, files, bytes and time (stoppedBy). `rootRel` maps a
 * virtual path to what the caller shows.
 */
async function search(a: AccountRow, rawDir: unknown, opts: SearchOptions, rootRel: (virtual: string) => string, limits: SearchLimits = DEFAULT_LIMITS): Promise<FileSearchResult> {
  const t0 = Date.now();
  const root = splitVirtual(rawDir);
  if (root.length < 2) throw invalidPath();
  const query = typeof opts.query === 'string' ? opts.query : '';
  if (!query || query.length > 1000) throw new AppError(400, 'query: 1 to 1000 characters', 'invalid');
  if (query.includes('\n')) throw new AppError(400, 'query: one line (the search is line by line)', 'invalid');
  const maxResults = Math.min(Math.max(1, Math.floor(opts.maxResults ?? FILE_SEARCH_DEFAULT_RESULTS)), FILE_SEARCH_MAX_RESULTS);
  const maxPerFile = Math.min(Math.max(1, Math.floor(opts.maxPerFile ?? 20)), FILE_SEARCH_MAX_PER_FILE);
  const flags = opts.caseSensitive === true ? '' : 'i';
  if (opts.regex) {
    try { new RegExp(query, flags); } catch (err) {
      throw new AppError(400, `Invalid regular expression: ${(err as Error).message}`, 'invalidRegex');
    }
  }
  if ((opts.include?.length ?? 0) > 20 || (opts.exclude?.length ?? 0) > 20) throw new AppError(400, 'At most 20 include / exclude globs', 'invalid');
  const include = globMatcher(opts.include);
  const exclude = globMatcher(opts.exclude);
  // Globs see the path relative to the site area (/staging/<slug>/…).
  const relOfSegs = (segs: string[]) => segs.slice(2).join('/');

  const busy = running.get(a.id) ?? 0;
  if (busy >= MAX_SEARCHES_PER_ACCOUNT) throw new AppError(429, 'Searches already running for this account: retry in a few seconds', 'searchBusy');
  if (opts.regex && regexRunning >= MAX_REGEX_SEARCHES) throw new AppError(429, 'Too many regular expression searches running: retry in a few seconds, or search a literal text', 'searchBusy');
  running.set(a.id, busy + 1);
  if (opts.regex) regexRunning++;
  const runner = opts.regex ? new RegexRunner(query, flags) : null;
  try {
    const hostd = filesBackend.hostd();
    const t = filesBackend.target(a);
    const skipped = { binary: 0, tooLarge: 0, links: 0, dirs: [] as string[] };
    let stoppedBy: FileSearchStop | null = null;
    const overTime = () => Date.now() - t0 > limits.ms;
    // 1. Walk (listings only), breadth first, sorted: the files to read.
    const files: Array<{ segs: string[]; size: number }> = [];
    let bytes = 0;
    const queue: string[][] = [root];
    let seen = 0;
    walk: while (queue.length) {
      if (overTime()) { stoppedBy = 'time'; break; }
      const dir = queue.shift() as string[];
      let entries: HostdFileEntry[];
      try {
        entries = (await hostd.list(t, dir.join('/'))).entries;
      } catch (err) {
        if (dir === root) throw fileError(err); // the folder asked does not exist
        continue; // vanished, or not readable: skipped
      }
      for (const e of [...entries].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
        if (++seen % WALK_YIELD_EVERY === 0) {
          await new Promise((r) => setImmediate(r));
          if (overTime()) { stoppedBy = 'time'; break walk; }
        }
        const segs = [...dir, e.name];
        if (e.kind === 'dir') {
          if (!opts.includeVendor && (FILE_SEARCH_VENDOR_DIRS as readonly string[]).includes(e.name)) {
            if (skipped.dirs.length < 20) skipped.dirs.push(rootRel(joinVirtual(segs)));
            continue;
          }
          queue.push(segs);
          continue;
        }
        if (e.kind !== 'file') { skipped.links++; continue; }
        const rel = relOfSegs(segs);
        if (include && !include(rel)) continue;
        if (exclude && exclude(rel)) continue;
        const dot = e.name.lastIndexOf('.');
        if (dot > 0 && BINARY_EXT.has(e.name.slice(dot + 1).toLowerCase())) { skipped.binary++; continue; }
        if (e.size > limits.fileBytes) { skipped.tooLarge++; continue; }
        if (files.length >= limits.files) { stoppedBy = 'files'; break walk; }
        if (bytes + e.size > limits.bytes) { stoppedBy = 'bytes'; break walk; }
        files.push({ segs, size: e.size });
        bytes += e.size;
      }
    }

    // 2. Read and match, in order (several reads at once).
    // A file's regex time: REGEX_FILE_MS (less with a small budget), cut by what is left of the budget.
    const fileCap = Math.min(REGEX_FILE_MS, Math.max(50, Math.floor(limits.ms / 2)));
    const needle = opts.caseSensitive === true ? query : query.toLowerCase();
    let found = 0;
    let scanned = 0;
    let failed = false;
    const halt = () => failed || stoppedBy === 'time' || found >= maxResults;
    const perFile = await mapLimit(files, 6, async (f): Promise<FileSearchMatch[]> => {
      if (overTime()) { stoppedBy ??= 'time'; return []; }
      let buf: Buffer;
      try {
        const s = await hostd.openContent(t, f.segs.join('/'));
        const chunks: Buffer[] = [];
        let n = 0;
        for await (const c of s.body as AsyncIterable<Buffer>) {
          n += c.length;
          if (n > limits.fileBytes) { s.body.destroy(); break; }
          chunks.push(c);
        }
        if (n > limits.fileBytes) { skipped.tooLarge++; return []; }
        buf = Buffer.concat(chunks);
      } catch {
        return []; // vanished meanwhile
      }
      scanned++;
      if (buf.subarray(0, NUL_SNIFF_BYTES).includes(0)) { skipped.binary++; return []; }
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      const hits: Array<[number, number]> = [];
      if (runner) {
        let given = 0;
        let nums: number[] | 'timeout';
        try {
          nums = await runner.run(text, maxPerFile, () => {
            given = Math.min(fileCap, limits.ms - (Date.now() - t0));
            return given;
          });
        } catch {
          failed = true;
          throw new AppError(400, 'The regular expression could not be run on this content: simplify it, or search a literal text', 'regexTooSlow');
        }
        if (nums === 'timeout') {
          // Too slow on its own (it had its full time): the pattern. Otherwise the search's budget ran out.
          if (given >= fileCap) {
            failed = true;
            throw new AppError(400, 'The regular expression is too slow on this content (catastrophic backtracking): simplify it, or search a literal text', 'regexTooSlow');
          }
          stoppedBy ??= 'time';
          return [];
        }
        for (let i = 0; i + 1 < nums.length; i += 2) hits.push([nums[i], nums[i + 1]]);
      } else {
        for (let i = 0; i < lines.length && hits.length < maxPerFile; i++) {
          const col = (opts.caseSensitive === true ? lines[i] : lines[i].toLowerCase()).indexOf(needle);
          if (col !== -1) hits.push([i + 1, col]);
        }
      }
      if (!hits.length) return [];
      found += hits.length;
      const path = rootRel(joinVirtual(f.segs));
      return hits.map(([line, col]) => ({ path, line, column: col + 1, text: shown(lines[line - 1] ?? '', col) }));
    }, halt);

    const all = perFile.filter((m): m is FileSearchMatch[] => m !== undefined);
    const matches = all.flat();
    let truncated = stoppedBy !== null;
    if (matches.length > maxResults || (found >= maxResults && all.length < files.length)) {
      stoppedBy = 'maxResults';
      truncated = true;
    }
    if (perFile.some((m, i) => m === undefined && i < files.length) && stoppedBy === null) { stoppedBy = 'time'; truncated = true; }
    return {
      path: rootRel(joinVirtual(root)),
      matches: matches.slice(0, maxResults),
      filesScanned: scanned,
      filesMatched: all.filter((m) => m.length).length,
      truncated, stoppedBy, skipped,
      durationMs: Date.now() - t0,
    };
  } finally {
    runner?.close();
    if (opts.regex) regexRunning--;
    const n = (running.get(a.id) ?? 1) - 1;
    if (n > 0) running.set(a.id, n); else running.delete(a.id);
  }
}

export const fileTools = { readRange, edit, assertSha256, withCurrent, hashListing, search };
