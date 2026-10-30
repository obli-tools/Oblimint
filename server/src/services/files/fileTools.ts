import crypto from 'crypto';
import { Readable } from 'stream';
import { StringDecoder } from 'string_decoder';
import vm from 'vm';
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
// are virtual (/staging/<slug>/…). The precondition is checked right before
// the write and the write itself is pinned to the mtime seen (putSmall's
// expectedMtime): only a change landing within that last instant can slip by.
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

function countOf(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
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
  edits.forEach((ed, index) => {
    if (typeof ed?.oldString !== 'string' || typeof ed?.newString !== 'string' || ed.oldString === '') {
      throw new AppError(400, `Edit ${index}: oldString must be a non-empty string, newString a string`, 'invalid');
    }
    if (ed.oldString === ed.newString) throw new AppError(400, `Edit ${index}: oldString and newString are the same`, 'editNoChange', { index });
    const n = countOf(text, ed.oldString);
    if (n === 0) throw new AppError(409, `Edit ${index}: oldString was not found (read the file again: exact text, spaces and line endings included)`, 'editNotFound', { index, currentSha256: cur.sha256 });
    if (n > 1 && ed.replaceAll !== true) {
      throw new AppError(409, `Edit ${index}: oldString occurs ${n} times: add surrounding lines to make it unique, or replaceAll`, 'editNotUnique', { index, occurrences: n, currentSha256: cur.sha256 });
    }
    text = text.split(ed.oldString).join(ed.newString);
    replacements += n;
  });
  const out = Buffer.from(text, 'utf8');
  if (out.length > FILE_EDIT_MAX_BYTES) throw new AppError(413, 'The edited file would be larger than 8 MB', 'fileTooLarge');
  // Pinned to the mtime of the content just read (409 fileChanged when it moved since).
  await filesService.putSmall(a, { path, size: out.length, expectedMtime: cur.mtime }, Readable.from([out]));
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

/** A glob ("*.php", "wp-content/**", "src/{a,b}/*.js") → RegExp on a slash-separated relative path. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.trim().replace(/^\/+/, '');
  let re = '';
  let inBraces = false;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{' && !inBraces) { re += '(?:'; inBraces = true; }
    else if (c === '}' && inBraces) { re += ')'; inBraces = false; }
    else if (c === ',' && inBraces) re += '|';
    else re += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
  }
  if (inBraces) throw new AppError(400, `Invalid glob: ${glob}`, 'invalid');
  return new RegExp(`^${re}$`);
}

/** A glob without "/" matches the file name, otherwise the path relative to the area root. */
function globMatcher(globs: string[] | undefined): ((rel: string) => boolean) | null {
  if (!globs?.length) return null;
  const list = globs.map((g) => ({ re: globToRegExp(g), base: !g.replace(/^\/+/, '').includes('/') }));
  return (rel) => list.some(({ re, base }) => re.test(base ? rel.slice(rel.lastIndexOf('/') + 1) : rel));
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

/** Regular expressions run in a separate V8 context with a time limit (no catastrophic backtracking can hold the server). */
const REGEX_SCRIPT = new vm.Script(`(function () {
  var re = new RegExp(src, flags);
  var out = [];
  var lines = text.split('\\n');
  for (var i = 0; i < lines.length && out.length < max * 2; i++) {
    var m = re.exec(lines[i]);
    if (m) out.push(i + 1, m.index);
  }
  return out.join(',');
})()`);

/** Searches running at once per account (each holds hostd reads). */
const MAX_SEARCHES_PER_ACCOUNT = 2;
const running = new Map<number, number>();

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
  running.set(a.id, busy + 1);
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
    const ctx = opts.regex ? vm.createContext({ src: query, flags, text: '', max: maxPerFile }) : null;
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
      if (ctx) {
        ctx.text = text;
        let raw: string;
        try {
          raw = REGEX_SCRIPT.runInContext(ctx, { timeout: Math.max(50, Math.min(2000, limits.ms - (Date.now() - t0))) }) as string;
        } catch (err) {
          failed = true;
          if ((err as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
            throw new AppError(400, 'The regular expression is too slow on this content (catastrophic backtracking): simplify it, or search a literal text', 'regexTooSlow');
          }
          throw err;
        }
        const nums = raw ? raw.split(',').map(Number) : [];
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
    const n = (running.get(a.id) ?? 1) - 1;
    if (n > 0) running.set(a.id, n); else running.delete(a.id);
  }
}

export const fileTools = { readRange, edit, assertSha256, hashListing, search };
