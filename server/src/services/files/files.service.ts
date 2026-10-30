import crypto from 'crypto';
import type { Readable } from 'stream';
import type {
  FileExtractResult, FileEntry, FileListing, FileOpResult, FileText, FileUploadChunkResult, FileUploadRequest, FileUploadSession, FileUploadStatus,
} from '@oblimint/shared';
import { FILE_TEXT_MAX_BYTES } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { HostdError } from '../hostd/client';
import { hostdFiles, type HostdFileListing, type HostdFileOwner, type HostdFileStream, type HostdFileTarget } from '../hostd/files';
import type { AccountRow } from '../hosting/rows';

// ─────────────────────────────────────────────────────────────────────────────
// Web file explorer of an account (shared/src/files.ts). Every disk access is
// hostd's (hostd/files.go: no link followed, changes only in directories the
// account owns, created entries uid:gid); this service maps the virtual tree
// (/staging/<slug>/…, /data/<slug>/…), keeps the chunked upload sessions,
// applies the quota block (read + delete only, like SFTP) and triggers the
// publish scheduler of the sites whose staging changed (like an SFTP event).
// ─────────────────────────────────────────────────────────────────────────────

export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
export const UPLOAD_PARALLEL = 4;
/** Chunks of one session in flight at once (above: 429, the client retries). */
const UPLOAD_MAX_INFLIGHT = 8;
const UPLOAD_MAX_SESSIONS_PER_ACCOUNT = 256;
/** A session without any chunk for this long is abandoned (temporary file removed). */
const UPLOAD_IDLE_MS = 30 * 60_000;
const MAX_UPLOAD_BYTES = 1024 ** 4; // 1 TiB (the quota is the real limit)
/** Batch operations (delete / move / copy): items per request. */
export const MAX_BATCH = 1000;
const MAX_PATH = 4096;
const BINARY_SNIFF_BYTES = 8192;

export interface FilesDeps {
  hostd: typeof hostdFiles;
  uploadsBlocked(accountId: number): Promise<boolean>;
  sitesOf(accountId: number): Promise<Array<{ id: number; slug: string; label: string }>>;
  notifyChange(siteId: number): void;
  now(): number;
}

const defaultDeps: FilesDeps = {
  hostd: hostdFiles,
  async uploadsBlocked(accountId) {
    try {
      const { enforcementService } = await import('../usage/usage.service');
      return await enforcementService.uploadsBlocked(accountId);
    } catch (err) {
      logger.warn({ err, accountId }, 'uploadsBlocked check failed');
      return false;
    }
  },
  async sitesOf(accountId) {
    const rows = await db('sites as s').where('s.account_id', accountId).select('s.id', 's.slug', 's.name',
      db.raw(`(SELECT d.name FROM site_routes sr JOIN domains d ON d.id = sr.domain_id
               WHERE sr.site_id = s.id ORDER BY (sr.path_prefix = '/') DESC, sr.id ASC LIMIT 1) AS primary_domain`)) as
      Array<{ id: number; slug: string; name: string; primary_domain: string | null }>;
    return rows.map((r) => ({ id: r.id, slug: r.slug, label: r.primary_domain || r.name || r.slug }));
  },
  notifyChange(siteId) {
    void import('../releases/publishScheduler')
      .then(({ publishScheduler }) => publishScheduler.notifyChange(siteId))
      .catch((err) => logger.warn({ err, siteId }, 'publishScheduler.notifyChange failed'));
  },
  now: () => Date.now(),
};

let deps: FilesDeps = defaultDeps;

/** Tests: replace the dependencies (null restores). */
export function setFilesDeps(d: Partial<FilesDeps> | null): void {
  deps = d ? { ...defaultDeps, ...d } : defaultDeps;
  sessions.clear();
}

// ── Paths ────────────────────────────────────────────────────────────────────

/** Components of a virtual path ("/" → []); 400 when malformed. */
export function splitVirtual(p: unknown): string[] {
  if (typeof p !== 'string' || p.length > MAX_PATH || p.includes('\0') || p.includes('\\')) throw invalidPath();
  const segs = p.split('/').filter((s) => s !== '');
  if (segs.length > 64) throw invalidPath();
  for (const s of segs) {
    if (s === '.' || s === '..' || Buffer.byteLength(s) > 255) throw invalidPath();
  }
  if (segs.length && segs[0] !== 'staging' && segs[0] !== 'data') throw invalidPath();
  return segs;
}

export function joinVirtual(segs: string[]): string {
  return `/${segs.join('/')}`;
}

/** A path hostd accepts (under staging/ or data/); 400 for the virtual root. */
function rel(segs: string[]): string {
  if (!segs.length) throw invalidPath();
  return segs.join('/');
}

/** Name of a file or directory created by the explorer (no slash, no dot names). */
export function validName(name: string): boolean {
  return name.length > 0 && Buffer.byteLength(name) <= 255 && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);
}

function invalidPath(): AppError {
  return new AppError(400, 'Invalid path', 'invalidPath');
}

/** hostd refusal → panel error (the message keeps only the account-relative path). */
export function fileError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof HostdError) {
    const msg = err.message.replace(/^hostd [A-Z]+ [^:]*: /, '');
    // hostd older than the panel: the file routes do not exist there yet (never "file not found").
    if (err.code === 'notFound' && /^no route /.test(msg)) {
      return new AppError(503, 'The host daemon (hostd) is older than the panel: apply the platform update of hostd (Nodes > Updates)', 'hostdOutdated');
    }
    switch (err.code) {
      case 'invalid': return new AppError(400, msg, 'invalidPath');
      case 'notFound': return new AppError(404, msg, 'fileNotFound');
      case 'forbidden': return new AppError(403, msg, 'fileForbidden');
      case 'exists': return new AppError(409, msg, 'fileExists');
      case 'notRegular': return new AppError(409, msg, 'notRegular');
      case 'unsafePath': return new AppError(409, msg, 'unsafePath');
      case 'quotaExceeded': return new AppError(507, 'Disk quota exceeded', 'quotaExceeded');
      case 'nodeNotSupported': return new AppError(501, msg, 'nodeNotSupported');
      default: return new AppError(503, err.message, 'backendUnavailable');
    }
  }
  return new AppError(500, err instanceof Error ? err.message : String(err), 'backendUnavailable');
}

const target = (a: AccountRow): HostdFileTarget => ({ nodeId: a.node_id, accountId: a.id });
const owner = (a: AccountRow): HostdFileOwner => ({ uid: a.uid, gid: a.gid });

/** The file tools of the keys (fileTools.ts): the current hostd (faked by the tests) and the account's target. */
export const filesBackend = {
  hostd: (): typeof hostdFiles => deps.hostd,
  target,
  now: (): number => deps.now(),
};

export async function assertWritable(a: AccountRow): Promise<void> {
  if (a.status !== 'active') throw new AppError(409, 'The account is not active', 'accountNotActive');
  if (await deps.uploadsBlocked(a.id)) throw new AppError(507, 'Disk quota exceeded: uploads are blocked (read and delete only)', 'uploadsBlocked');
}

/** Sites whose staging a set of paths touches → publish scheduler. */
async function notifyStaging(a: AccountRow, paths: string[][]): Promise<void> {
  const slugs = new Set(paths.filter((s) => s[0] === 'staging' && s.length >= 2).map((s) => s[1]));
  if (!slugs.size) return;
  try {
    for (const site of await deps.sitesOf(a.id)) if (slugs.has(site.slug)) deps.notifyChange(site.id);
  } catch (err) {
    logger.warn({ err, accountId: a.id }, 'Files: site lookup for the publish scheduler failed');
  }
}

function toEntry(e: HostdFileListing['entries'][number]): FileEntry {
  return { name: e.name, kind: e.kind, size: e.size, mtime: e.mtime, mode: e.mode, ...(e.target !== undefined ? { target: e.target } : {}) };
}

// ── Listing / reading ────────────────────────────────────────────────────────

async function list(a: AccountRow, rawPath: unknown): Promise<FileListing> {
  const segs = splitVirtual(rawPath ?? '/');
  const uploadsBlocked = await deps.uploadsBlocked(a.id);
  if (!segs.length) {
    return {
      path: '/', writable: false, truncated: false, uploadsBlocked,
      entries: (['staging', 'data'] as const).map((name) => ({ name, kind: 'dir', size: 0, mtime: 0, mode: 0o750 })),
    };
  }
  let l: HostdFileListing;
  try {
    l = await deps.hostd.list(target(a), rel(segs));
  } catch (err) { throw fileError(err); }
  const entries = l.entries.map(toEntry);
  if (segs.length === 1) {
    const sites = new Map((await deps.sitesOf(a.id)).map((s) => [s.slug, s]));
    for (const e of entries) {
      const s = sites.get(e.name);
      if (s) e.site = { id: s.id, label: s.label };
    }
  }
  return {
    path: joinVirtual(segs),
    writable: segs.length >= 2 && l.uid === a.uid && a.status === 'active' && !uploadsBlocked,
    entries, truncated: l.truncated, uploadsBlocked,
  };
}

async function open(a: AccountRow, rawPath: unknown, range?: string): Promise<{ stream: HostdFileStream; name: string }> {
  const segs = splitVirtual(rawPath);
  if (segs.length < 2) throw new AppError(409, 'Not a file', 'notRegular');
  try {
    return { stream: await deps.hostd.openContent(target(a), rel(segs), range), name: segs[segs.length - 1] };
  } catch (err) { throw fileError(err); }
}

async function readText(a: AccountRow, rawPath: unknown): Promise<FileText> {
  const { stream } = await open(a, rawPath);
  const size = Number(stream.headers['x-oblimint-size'] ?? 0);
  const mtime = Number(stream.headers['x-oblimint-mtime'] ?? 0);
  const path = joinVirtual(splitVirtual(rawPath));
  if (size > FILE_TEXT_MAX_BYTES) {
    stream.body.destroy();
    return { path, size, mtime, content: null, binary: false, tooLarge: true };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of stream.body as AsyncIterable<Buffer>) {
    total += c.length;
    if (total > FILE_TEXT_MAX_BYTES) {
      stream.body.destroy();
      return { path, size: total, mtime, content: null, binary: false, tooLarge: true };
    }
    chunks.push(c);
  }
  const buf = Buffer.concat(chunks);
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { path, size, mtime, content: null, binary: true, tooLarge: false };
  return { path, size, mtime, content: buf.toString('utf8'), binary: false, tooLarge: false };
}

// ── Changes ──────────────────────────────────────────────────────────────────

async function mkdir(a: AccountRow, rawPath: unknown): Promise<string> {
  const segs = splitVirtual(rawPath);
  if (segs.length < 3 || !validName(segs[segs.length - 1])) throw invalidPath();
  await assertWritable(a);
  try {
    await deps.hostd.mkdir(target(a), owner(a), rel(segs));
  } catch (err) { throw fileError(err); }
  await notifyStaging(a, [segs]);
  return joinVirtual(segs);
}

/** Runs one operation per item; a failed item never stops the others. */
async function batch<T>(items: T[], label: (item: T) => string, run: (item: T) => Promise<void>): Promise<FileOpResult[]> {
  const out: FileOpResult[] = [];
  for (const item of items) {
    try {
      await run(item);
      out.push({ path: label(item), ok: true });
    } catch (err) {
      const e = fileError(err);
      out.push({ path: label(item), ok: false, code: e.code, error: e.message });
    }
  }
  return out;
}

async function remove(a: AccountRow, paths: unknown[]): Promise<FileOpResult[]> {
  // Deleting stays possible over quota (like SFTP): only the account status is checked.
  if (a.status !== 'active') throw new AppError(409, 'The account is not active', 'accountNotActive');
  const touched: string[][] = [];
  const res = await batch(paths, String, async (p) => {
    const segs = splitVirtual(p);
    if (segs.length < 3) throw new AppError(403, 'This folder cannot be deleted', 'fileForbidden');
    await deps.hostd.remove(target(a), owner(a), rel(segs));
    touched.push(segs);
  });
  await notifyStaging(a, touched);
  return res;
}

async function moveOrCopy(a: AccountRow, kind: 'move' | 'copy', items: Array<{ from: unknown; to: unknown }>, overwrite: boolean): Promise<FileOpResult[]> {
  await assertWritable(a);
  const touched: string[][] = [];
  const res = await batch(items, (i) => String(i.from), async (i) => {
    const from = splitVirtual(i.from);
    const to = splitVirtual(i.to);
    if (from.length < 3 || to.length < 3 || !validName(to[to.length - 1])) throw invalidPath();
    if (kind === 'move') await deps.hostd.move(target(a), owner(a), rel(from), rel(to), overwrite);
    else await deps.hostd.copy(target(a), owner(a), rel(from), rel(to));
    touched.push(from, to);
  });
  await notifyStaging(a, touched);
  return res;
}

/** Extracts an archive of the account into a folder (default: the archive's folder). */
async function extract(a: AccountRow, rawArchive: unknown, rawTo: unknown, overwrite: boolean): Promise<FileExtractResult> {
  const archive = splitVirtual(rawArchive);
  if (archive.length < 3) throw invalidPath();
  const to = rawTo === undefined || rawTo === null ? archive.slice(0, -1) : splitVirtual(rawTo);
  if (to.length < 2) throw new AppError(403, 'Archives cannot be extracted here', 'fileForbidden');
  await assertWritable(a);
  let res: FileExtractResult;
  try {
    res = await deps.hostd.extract(target(a), owner(a), rel(archive), rel(to), overwrite);
  } catch (err) { throw fileError(err); }
  await notifyStaging(a, [to]);
  return res;
}

/** Zip of entries of one folder (streamed). */
async function zip(a: AccountRow, rawDir: unknown, names: string[]): Promise<HostdFileStream> {
  const dir = splitVirtual(rawDir);
  if (!dir.length) throw invalidPath();
  if (!names.length || names.length > MAX_BATCH || names.some((n) => !validName(n))) throw invalidPath();
  try {
    return await deps.hostd.openZip(target(a), rel(dir), names);
  } catch (err) { throw fileError(err); }
}

// ── Chunked uploads ──────────────────────────────────────────────────────────

interface UploadSession {
  id: string;
  accountId: number;
  userId: number;
  account: AccountRow;
  segs: string[];
  size: number;
  count: number;
  overwrite: boolean;
  received: Set<number>;
  inflight: number;
  touchedAt: number;
  committing: boolean;
  done: boolean;
}

const sessions = new Map<string, UploadSession>();
let sweeper: NodeJS.Timeout | null = null;

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => { void sweep(); }, 60_000);
  sweeper.unref();
}

/** Abandoned sessions: temporary file removed (hostd also drops day-old temporaries on listing). */
export async function sweep(): Promise<void> {
  const now = deps.now();
  for (const s of [...sessions.values()]) {
    if (s.inflight > 0 || s.committing || now - s.touchedAt < UPLOAD_IDLE_MS) continue;
    sessions.delete(s.id);
    if (s.done) continue;
    try {
      await deps.hostd.uploadAbort(target(s.account), owner(s.account), rel(s.segs), s.id);
    } catch (err) {
      logger.warn({ err, accountId: s.accountId }, 'Files: abandoned upload cleanup failed');
    }
  }
  if (!sessions.size && sweeper) { clearInterval(sweeper); sweeper = null; }
}

function chunkLength(s: UploadSession, index: number): number {
  return Math.max(0, Math.min(UPLOAD_CHUNK_SIZE, s.size - index * UPLOAD_CHUNK_SIZE));
}

function session(a: AccountRow, userId: number, id: string): UploadSession {
  const s = sessions.get(id);
  // Another account's / user's session is invisible (same 404 as an unknown one).
  if (!s || s.accountId !== a.id || s.userId !== userId) throw new AppError(404, 'Upload not found or expired', 'uploadNotFound');
  return s;
}

/** Editor save: the file must not have changed since it was opened (409 fileChanged). */
async function assertUnchanged(a: AccountRow, segs: string[], expectedMtime: number): Promise<void> {
  let current: number | null = null;
  try {
    const parent = await deps.hostd.list(target(a), rel(segs.slice(0, -1)));
    current = parent.entries.find((e) => e.name === segs[segs.length - 1] && e.kind === 'file')?.mtime ?? null;
  } catch (err) { throw fileError(err); }
  if (current !== null && current !== expectedMtime) throw new AppError(409, 'The file was changed since it was opened', 'fileChanged');
}

async function uploadStart(a: AccountRow, userId: number, req: FileUploadRequest): Promise<FileUploadSession> {
  const segs = splitVirtual(req.path);
  if (segs.length < 3 || !validName(segs[segs.length - 1])) throw invalidPath();
  if (!Number.isSafeInteger(req.size) || req.size < 0 || req.size > MAX_UPLOAD_BYTES) throw new AppError(400, 'Invalid size', 'invalid');
  await assertWritable(a);
  if ([...sessions.values()].filter((s) => s.accountId === a.id && !s.done).length >= UPLOAD_MAX_SESSIONS_PER_ACCOUNT) {
    throw new AppError(429, 'Too many uploads in progress for this account', 'tooManyUploads');
  }
  if (req.expectedMtime !== undefined) await assertUnchanged(a, segs, req.expectedMtime);
  const id = crypto.randomBytes(16).toString('hex');
  const overwrite = req.overwrite === true || req.expectedMtime !== undefined;
  try {
    await deps.hostd.uploadBegin(target(a), owner(a), rel(segs), id, req.size, overwrite);
  } catch (err) { throw fileError(err); }
  const count = Math.max(1, Math.ceil(req.size / UPLOAD_CHUNK_SIZE));
  sessions.set(id, {
    id, accountId: a.id, userId, account: a, segs, size: req.size, count, overwrite,
    received: new Set(), inflight: 0, touchedAt: deps.now(), committing: false, done: false,
  });
  startSweeper();
  return { id, chunkSize: UPLOAD_CHUNK_SIZE, count, parallel: UPLOAD_PARALLEL };
}

function uploadStatus(a: AccountRow, userId: number, id: string): FileUploadStatus {
  const s = session(a, userId, id);
  return { received: [...s.received].sort((x, y) => x - y), count: s.count, chunkSize: UPLOAD_CHUNK_SIZE };
}

/**
 * One chunk (raw body of exactly its length). The chunk that completes the
 * file commits it (rename onto the target) and answers done: true.
 */
async function uploadChunk(a: AccountRow, userId: number, id: string, index: number, contentLength: number, body: Readable): Promise<FileUploadChunkResult> {
  const s = session(a, userId, id);
  if (s.done) return { done: true, received: s.count };
  if (!Number.isInteger(index) || index < 0 || index >= s.count) throw new AppError(400, 'Invalid chunk index', 'invalid');
  const length = chunkLength(s, index);
  if (contentLength !== length) throw new AppError(400, `Chunk ${index} must be ${length} bytes`, 'invalidChunk');
  if (s.inflight >= UPLOAD_MAX_INFLIGHT) throw new AppError(429, 'Too many chunks in flight', 'tooManyChunks');
  s.inflight++;
  s.touchedAt = deps.now();
  try {
    if (!s.received.has(index)) {
      await deps.hostd.uploadChunk(target(a), owner(a), rel(s.segs), id, index * UPLOAD_CHUNK_SIZE, length, body);
      s.received.add(index);
    } else {
      body.resume(); // replayed chunk: already written
    }
  } catch (err) {
    throw fileError(err);
  } finally {
    s.inflight--;
    s.touchedAt = deps.now();
  }
  if (s.received.size === s.count && !s.committing && !s.done) {
    s.committing = true;
    try {
      await deps.hostd.uploadCommit(target(a), owner(a), rel(s.segs), id, s.size, s.overwrite);
      s.done = true;
    } catch (err) {
      throw fileError(err);
    } finally {
      s.committing = false;
    }
    await notifyStaging(a, [s.segs]);
  }
  return { done: s.done, received: s.received.size };
}

async function uploadAbort(a: AccountRow, userId: number, id: string): Promise<void> {
  const s = session(a, userId, id);
  sessions.delete(id);
  if (s.done) return;
  try {
    await deps.hostd.uploadAbort(target(a), owner(a), rel(s.segs), id);
  } catch (err) { throw fileError(err); }
}

/**
 * One-request upload of a small file (≤ UPLOAD_CHUNK_SIZE): begin, the whole
 * body as one chunk, commit — a folder of many small files costs one request
 * per file. Same rules as uploadStart (quota block, conflicts, editor mtime).
 */
async function putSmall(a: AccountRow, req: FileUploadRequest, body: Readable): Promise<string> {
  const segs = splitVirtual(req.path);
  if (segs.length < 3 || !validName(segs[segs.length - 1])) throw invalidPath();
  if (!Number.isSafeInteger(req.size) || req.size < 0 || req.size > UPLOAD_CHUNK_SIZE) throw new AppError(400, 'Invalid size', 'invalid');
  await assertWritable(a);
  if (req.expectedMtime !== undefined) await assertUnchanged(a, segs, req.expectedMtime);
  const id = crypto.randomBytes(16).toString('hex');
  const overwrite = req.overwrite === true || req.expectedMtime !== undefined;
  try {
    await deps.hostd.uploadBegin(target(a), owner(a), rel(segs), id, req.size, overwrite);
  } catch (err) { throw fileError(err); }
  try {
    await deps.hostd.uploadChunk(target(a), owner(a), rel(segs), id, 0, req.size, body);
    await deps.hostd.uploadCommit(target(a), owner(a), rel(segs), id, req.size, overwrite);
  } catch (err) {
    await deps.hostd.uploadAbort(target(a), owner(a), rel(segs), id).catch(() => undefined);
    throw fileError(err);
  }
  await notifyStaging(a, [segs]);
  return joinVirtual(segs);
}

/** The upload session's target (audit). */
function uploadInfo(id: string): { path: string; size: number } | null {
  const s = sessions.get(id);
  return s ? { path: joinVirtual(s.segs), size: s.size } : null;
}

export const filesService = {
  list, open, readText, mkdir, remove, extract, zip,
  move: (a: AccountRow, items: Array<{ from: unknown; to: unknown }>, overwrite: boolean) => moveOrCopy(a, 'move', items, overwrite),
  copy: (a: AccountRow, items: Array<{ from: unknown; to: unknown }>) => moveOrCopy(a, 'copy', items, false),
  uploadStart, uploadStatus, uploadChunk, uploadAbort, uploadInfo, putSmall,
};
