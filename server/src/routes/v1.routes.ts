import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import { parseBody } from '../services/docker/parseBody';
import { keyApi, type SiteArea } from '../services/apiKeys/keyApi';
import { apiKeyAuth, apiKeyAuthLimiter, apiKeyLimiter } from '../services/apiKeys/middleware';
import type { ApiKeyContext } from '../services/apiKeys/apiKeys.service';
import { siteCreateSchema } from '../validators/hosting.schema';

// /api/v1 — API of the access keys (shared/src/apiKeys.ts), `Authorization: Bearer obk_…`.
// One account; the key's sites only (others: 404); its scopes (missing: 403 keyScope).
// File paths are relative to the site's area: ?area=staging (default: the code, published
// as releases) or ?area=data (the files the site writes).
//   GET    /me                                          → ApiV1Me
//   GET    /sites                                       → ApiV1Site[]
//   POST   /sites                SiteCreate − accountId → ApiV1Site (201)              sites.create
//   GET    /sites/:id                                   → ApiV1Site
//   GET    /sites/:id/files?path=&area=                 → FileListing                  files.read
//   GET    /sites/:id/files/text?path=&area=            → FileText (≤ 2 MiB)           files.read
//   GET    /sites/:id/files/content?path=&area=         → the file (Range)             files.read
//   PUT    /sites/:id/files/content?path=&area=&overwrite=1  raw body ≤ 8 MiB → {path} files.write
//   POST   /sites/:id/uploads   {path, size, area?, overwrite?} → FileUploadSession    files.write (bigger files)
//   PUT    /uploads/:uid/:index raw chunk               → FileUploadChunkResult         files.write
//   POST   /sites/:id/files/mkdir   {path, area?}       → {path}                       files.write
//   POST   /sites/:id/files/delete  {paths, area?}      → FileOpResult[]               files.write
//   POST   /sites/:id/files/move    {items, overwrite?, area?} → FileOpResult[]        files.write
//   POST   /sites/:id/files/copy    {items, area?}      → FileOpResult[]               files.write
//   POST   /sites/:id/files/extract {path, to?, overwrite?, area?} → FileExtractResult files.write
//   GET    /sites/:id/staging                           → StagingStatus (unpublished changes) files.read
//   POST   /sites/:id/publish   {message?}              → Release (201)                releases.publish
//   GET    /sites/:id/releases?limit=&offset=           → { items: Release[]; total }
//   POST   /sites/:id/releases/:rid/rollback            → { rolledBack: true }         releases.publish
//   GET    /sites/:id/logs?source=access|error|app&q=&limit= → LogQueryResult          logs.read

const router = Router();
router.use(apiKeyAuthLimiter, apiKeyAuth, apiKeyLimiter);

const ctxOf = (req: Request): ApiKeyContext => {
  if (!req.apiKey) throw new AppError(401, 'API key required', 'invalidKey');
  return req.apiKey;
};
const siteId = (req: Request) => Number(req.params.id);
const area = z.enum(['staging', 'data']).default('staging');
const areaOf = (v: unknown): SiteArea => area.parse(v ?? undefined);
const relPath = z.string().max(4096);
const qPath = (req: Request) => relPath.parse(typeof req.query.path === 'string' ? req.query.path : '/');

const createSchema = siteCreateSchema.omit({ accountId: true });
const pathBody = z.object({ path: relPath.min(1), area: area.optional() }).strict();
const pathsBody = z.object({ paths: z.array(relPath.min(1)).min(1).max(1000), area: area.optional() }).strict();
const itemsBody = z.object({
  items: z.array(z.object({ from: relPath.min(1), to: relPath.min(1) }).strict()).min(1).max(1000),
  overwrite: z.boolean().optional(),
  area: area.optional(),
}).strict();
const extractBody = z.object({ path: relPath.min(1), to: relPath.optional(), overwrite: z.boolean().optional(), area: area.optional() }).strict();
const uploadBody = z.object({ path: relPath.min(1), size: z.number().int().min(0), overwrite: z.boolean().optional(), area: area.optional() }).strict();
const publishBody = z.object({ message: z.string().max(500).nullable().optional() }).strict();

type Handler = (req: Request, res: Response) => Promise<void>;
const h = (fn: Handler) => (req: Request, res: Response, next: (err?: unknown) => void) => { fn(req, res).catch(next); };
const ok = (res: Response, data: unknown, status = 200) => { res.status(status).json({ success: true, data }); };

router.get('/me', h(async (req, res) => ok(res, await keyApi.me(ctxOf(req)))));
router.get('/sites', h(async (req, res) => ok(res, await keyApi.listSites(ctxOf(req)))));
router.post('/sites', h(async (req, res) => ok(res, await keyApi.createSite(ctxOf(req), req, parseBody(createSchema, req.body)), 201)));
router.get('/sites/:id', h(async (req, res) => ok(res, await keyApi.getSite(ctxOf(req), siteId(req)))));

router.get('/sites/:id/files', h(async (req, res) => ok(res, await keyApi.listFiles(ctxOf(req), siteId(req), areaOf(req.query.area), qPath(req)))));
router.get('/sites/:id/files/text', h(async (req, res) => ok(res, await keyApi.readText(ctxOf(req), siteId(req), areaOf(req.query.area), qPath(req)))));

router.get('/sites/:id/files/content', h(async (req, res) => {
  const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  const { stream } = await keyApi.open(ctxOf(req), siteId(req), areaOf(req.query.area), qPath(req), range);
  res.status(stream.status);
  for (const k of ['content-length', 'content-range', 'accept-ranges', 'last-modified']) {
    const v = stream.headers[k];
    if (typeof v === 'string') res.setHeader(k, v);
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  req.on('close', () => stream.body.destroy());
  stream.body.pipe(res);
}));

router.put('/sites/:id/files/content', (req, res, next) => {
  (async () => {
    const size = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(size) || size < 0) throw new AppError(411, 'Content-Length is required', 'invalidChunk');
    const path = await keyApi.putFile(ctxOf(req), siteId(req), areaOf(req.query.area), qPath(req), size, req, req.query.overwrite === '1' || req.query.overwrite === 'true');
    ok(res, { path });
  })().catch((err) => { req.resume(); next(err); });
});

router.post('/sites/:id/uploads', h(async (req, res) => {
  const b = parseBody(uploadBody, req.body);
  ok(res, await keyApi.uploadStart(ctxOf(req), siteId(req), areaOf(b.area), b.path, b.size, b.overwrite === true));
}));

router.put('/uploads/:uid/:index', (req, res, next) => {
  (async () => {
    const uid = String(req.params.uid);
    if (!/^[0-9a-f]{32}$/.test(uid)) throw new AppError(404, 'Upload not found or expired', 'uploadNotFound');
    const length = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(length) || length < 0) throw new AppError(411, 'Content-Length is required', 'invalidChunk');
    ok(res, await keyApi.uploadChunk(ctxOf(req), uid, Number(req.params.index), length, req));
  })().catch((err) => { req.resume(); next(err); });
});

router.post('/sites/:id/files/mkdir', h(async (req, res) => {
  const b = parseBody(pathBody, req.body);
  ok(res, { path: await keyApi.mkdir(ctxOf(req), siteId(req), areaOf(b.area), b.path) });
}));
router.post('/sites/:id/files/delete', h(async (req, res) => {
  const b = parseBody(pathsBody, req.body);
  ok(res, await keyApi.remove(ctxOf(req), siteId(req), areaOf(b.area), b.paths));
}));
router.post('/sites/:id/files/move', h(async (req, res) => {
  const b = parseBody(itemsBody, req.body);
  ok(res, await keyApi.move(ctxOf(req), siteId(req), areaOf(b.area), b.items, b.overwrite === true));
}));
router.post('/sites/:id/files/copy', h(async (req, res) => {
  const b = parseBody(itemsBody, req.body);
  ok(res, await keyApi.move(ctxOf(req), siteId(req), areaOf(b.area), b.items, false, true));
}));
router.post('/sites/:id/files/extract', h(async (req, res) => {
  const b = parseBody(extractBody, req.body);
  ok(res, await keyApi.extract(ctxOf(req), siteId(req), areaOf(b.area), b.path, b.to, b.overwrite === true));
}));

router.get('/sites/:id/staging', h(async (req, res) => ok(res, await keyApi.stagingStatus(ctxOf(req), siteId(req)))));
router.post('/sites/:id/publish', h(async (req, res) => {
  const b = parseBody(publishBody, req.body ?? {});
  ok(res, await keyApi.publish(ctxOf(req), req, siteId(req), b.message ?? null), 201);
}));
router.get('/sites/:id/releases', h(async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  ok(res, await keyApi.releases(ctxOf(req), siteId(req), limit, offset));
}));
router.post('/sites/:id/releases/:rid/rollback', h(async (req, res) => {
  await keyApi.rollback(ctxOf(req), req, siteId(req), Number(req.params.rid));
  ok(res, { rolledBack: true });
}));
router.get('/sites/:id/logs', h(async (req, res) => {
  const q = req.query;
  ok(res, await keyApi.logs(ctxOf(req), siteId(req), {
    source: String(q.source ?? 'error'), q: typeof q.q === 'string' ? q.q : null,
    limit: q.limit ? Number(q.limit) : null, since: typeof q.since === 'string' ? q.since : null,
    until: typeof q.until === 'string' ? q.until : null, status: typeof q.status === 'string' ? q.status : null,
  }));
}));

router.use((_req, res) => { res.status(404).json({ success: false, error: 'Not found', code: 'notFound' }); });

export default router;
