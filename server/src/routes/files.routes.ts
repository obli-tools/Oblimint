import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { auditService } from '../services/audit.service';
import { idParam, loadAccount, resolveActor, type HostingNeed } from '../services/hosting/access';
import type { AccountRow } from '../services/hosting/rows';
import { parseBody } from '../services/docker/parseBody';
import { MAX_BATCH, filesService } from '../services/files/files.service';
import { AppError } from '../middleware/errorHandler';
import { filesLimiter } from '../middleware/rateLimiter';

// /api/accounts/:id/files* — web file explorer (shared/src/files.ts), the
// account's SFTP tree (/staging/<site>/…, /data/<site>/…). Every route needs
// files.manage (the same right as the SFTP credentials). Mounted on /accounts.
//   GET    /:id/files?path=                     → FileListing
//   GET    /:id/files/download?path=&inline=1   → the file (Range supported; inline only for safe media types)
//   GET    /:id/files/text?path=                → FileText (integrated editor, ≤ 2 MiB)
//   POST   /:id/files/mkdir   {path}            → {path}
//   POST   /:id/files/delete  {paths}           → FileOpResult[]
//   POST   /:id/files/move    {items, overwrite}→ FileOpResult[]
//   POST   /:id/files/copy    {items}           → FileOpResult[]
//   POST   /:id/files/extract {path, to?, overwrite} → FileExtractResult (zip, tar, tar.gz)
//   GET    /:id/files/zip?path=<dir>&name=a&name=b   → application/zip (folders recursively, links skipped)
//   PUT    /:id/files/put?path=&overwrite=1&expectedMtime= raw small file (≤ 8 MiB) in one request → {path}
//   POST   /:id/files/uploads FileUploadRequest → FileUploadSession
//   GET    /:id/files/uploads/:uid              → FileUploadStatus (resume)
//   PUT    /:id/files/uploads/:uid/:index       raw chunk (application/octet-stream) → FileUploadChunkResult
//   DELETE /:id/files/uploads/:uid              → cancel

const router = Router();
const NEED: HostingNeed = 'files.manage';
// Its own budget (a folder upload is thousands of requests): see rateLimiter.ts.
router.use('/:id/files', filesLimiter);

const pathField = z.string().min(1).max(4096);
const mkdirSchema = z.object({ path: pathField }).strict();
const deleteSchema = z.object({ paths: z.array(pathField).min(1).max(MAX_BATCH) }).strict();
const moveSchema = z.object({
  items: z.array(z.object({ from: pathField, to: pathField }).strict()).min(1).max(MAX_BATCH),
  overwrite: z.boolean().optional(),
}).strict();
const extractSchema = z.object({ path: pathField, to: pathField.optional(), overwrite: z.boolean().optional() }).strict();
const uploadSchema = z.object({
  path: pathField,
  size: z.number().int().min(0),
  overwrite: z.boolean().optional(),
  expectedMtime: z.number().int().min(0).optional(),
}).strict();

async function account(req: Request): Promise<{ row: AccountRow; userId: number }> {
  const actor = await resolveActor(req);
  return { row: await loadAccount(actor, idParam(req), NEED), userId: actor.userId };
}

function uploadIdParam(req: Request): string {
  const id = String(req.params.uid ?? '');
  if (!/^[0-9a-f]{32}$/.test(id)) throw new AppError(404, 'Upload not found or expired', 'uploadNotFound');
  return id;
}

/** Shown in the browser only for types that cannot run script (never HTML / SVG / XML). */
const INLINE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
};

function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function audit(req: Request, row: AccountRow, action: string, details: Record<string, unknown>) {
  return auditService.logReqAs(req, row.tenant_id, action, {
    resourceType: 'account', resourcePath: String(row.id), details: { username: row.username, ...details },
  });
}

/** Paths in an audit entry: the first 50 of a batch. */
const sample = (paths: string[]) => (paths.length > 50 ? [...paths.slice(0, 50), `… +${paths.length - 50}`] : paths);

router.get('/:id/files', async (req, res, next) => {
  try {
    const { row } = await account(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: await filesService.list(row, req.query.path ?? '/') });
  } catch (err) { next(err); }
});

router.get('/:id/files/download', async (req: Request, res: Response, next) => {
  try {
    const { row } = await account(req);
    const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    const { stream, name } = await filesService.open(row, req.query.path, range);
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
    const inlineType = req.query.inline === '1' ? INLINE_TYPES[ext] : undefined;
    res.status(stream.status);
    for (const h of ['content-length', 'content-range', 'accept-ranges', 'last-modified']) {
      const v = stream.headers[h];
      if (typeof v === 'string') res.setHeader(h, v);
    }
    res.setHeader('Content-Type', inlineType ?? 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(inlineType ? 'inline' : 'attachment', name));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The browser PDF viewer does not run in a sandboxed document: PDF is the only inline type without it.
    res.setHeader('Content-Security-Policy', inlineType === 'application/pdf'
      ? "frame-ancestors 'self'"
      : "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    req.on('close', () => stream.body.destroy());
    stream.body.pipe(res);
  } catch (err) { next(err); }
});

router.get('/:id/files/text', async (req, res, next) => {
  try {
    const { row } = await account(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: await filesService.readText(row, req.query.path) });
  } catch (err) { next(err); }
});

router.post('/:id/files/mkdir', async (req, res, next) => {
  try {
    const { row } = await account(req);
    const { path } = parseBody(mkdirSchema, req.body);
    const created = await filesService.mkdir(row, path);
    await audit(req, row, 'files.mkdir', { path: created });
    res.json({ success: true, data: { path: created } });
  } catch (err) { next(err); }
});

router.post('/:id/files/delete', async (req, res, next) => {
  try {
    const { row } = await account(req);
    const { paths } = parseBody(deleteSchema, req.body);
    const data = await filesService.remove(row, paths);
    const done = data.filter((r) => r.ok).map((r) => r.path);
    if (done.length) await audit(req, row, 'files.delete', { paths: sample(done) });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/:id/files/move', async (req, res, next) => {
  try {
    const { row } = await account(req);
    const { items, overwrite } = parseBody(moveSchema, req.body);
    const data = await filesService.move(row, items, overwrite === true);
    const done = items.filter((_, i) => data[i]?.ok).map((i) => `${i.from} → ${i.to}`);
    if (done.length) await audit(req, row, 'files.move', { items: sample(done), overwrite: overwrite === true });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/:id/files/copy', async (req, res, next) => {
  try {
    const { row } = await account(req);
    const { items } = parseBody(moveSchema.omit({ overwrite: true }), req.body);
    const data = await filesService.copy(row, items);
    const done = items.filter((_, i) => data[i]?.ok).map((i) => `${i.from} → ${i.to}`);
    if (done.length) await audit(req, row, 'files.copy', { items: sample(done) });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/:id/files/extract', async (req, res, next) => {
  try {
    const { row } = await account(req);
    const { path, to, overwrite } = parseBody(extractSchema, req.body);
    const data = await filesService.extract(row, path, to, overwrite === true);
    await audit(req, row, 'files.extract', { path, to: to ?? null, overwrite: overwrite === true, files: data.files, bytes: data.bytes });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.get('/:id/files/zip', async (req: Request, res: Response, next) => {
  try {
    const { row } = await account(req);
    const raw = req.query.name;
    const names = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(String);
    const stream = await filesService.zip(row, req.query.path, names);
    const base = names.length === 1 ? names[0] : (String(req.query.path ?? '').split('/').filter(Boolean).pop() || 'files');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', contentDisposition('attachment', `${base}.zip`));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    req.on('close', () => stream.body.destroy());
    stream.body.on('error', () => res.destroy());
    stream.body.on('aborted', () => res.destroy());
    stream.body.pipe(res);
  } catch (err) { next(err); }
});

router.post('/:id/files/uploads', async (req, res, next) => {
  try {
    const { row, userId } = await account(req);
    const body = parseBody(uploadSchema, req.body);
    res.json({ success: true, data: await filesService.uploadStart(row, userId, body) });
  } catch (err) { next(err); }
});

router.put('/:id/files/put', async (req, res, next) => {
  try {
    const { row } = await account(req);
    const q = req.query;
    const size = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(size) || size < 0) throw new AppError(411, 'Content-Length is required', 'invalidChunk');
    const expected = q.expectedMtime === undefined ? undefined : Number(q.expectedMtime);
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) throw new AppError(400, 'Invalid expectedMtime', 'invalid');
    const path = await filesService.putSmall(row, { path: String(q.path ?? ''), size, overwrite: q.overwrite === '1', ...(expected !== undefined ? { expectedMtime: expected } : {}) }, req);
    await audit(req, row, 'files.upload', { path, size });
    res.json({ success: true, data: { path } });
  } catch (err) {
    req.resume();
    next(err);
  }
});

router.get('/:id/files/uploads/:uid', async (req, res, next) => {
  try {
    const { row, userId } = await account(req);
    res.json({ success: true, data: filesService.uploadStatus(row, userId, uploadIdParam(req)) });
  } catch (err) { next(err); }
});

router.put('/:id/files/uploads/:uid/:index', async (req, res, next) => {
  try {
    const { row, userId } = await account(req);
    const id = uploadIdParam(req);
    const index = Number(req.params.index);
    const length = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(length) || length < 0) throw new AppError(411, 'Content-Length is required', 'invalidChunk');
    const info = filesService.uploadInfo(id);
    const data = await filesService.uploadChunk(row, userId, id, index, length, req);
    if (data.done && info) {
      // One entry per uploaded file (the chunk that completed it).
      await audit(req, row, 'files.upload', info);
    }
    res.json({ success: true, data });
  } catch (err) {
    req.resume(); // drain the refused body: the connection stays usable
    next(err);
  }
});

router.delete('/:id/files/uploads/:uid', async (req, res, next) => {
  try {
    const { row, userId } = await account(req);
    await filesService.uploadAbort(row, userId, uploadIdParam(req));
    res.json({ success: true, data: null });
  } catch (err) { next(err); }
});

export default router;
