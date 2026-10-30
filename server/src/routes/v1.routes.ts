import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import { heavyOpLimiter } from '../middleware/rateLimiter';
import { idParam } from '../services/hosting/access';
import { parseBody } from '../services/docker/parseBody';
import { keyApi, PUBLISH_WAIT_MAX_MS, RELEASE_WAIT_MAX_MS, type SiteArea } from '../services/apiKeys/keyApi';
import { apiKeyAuth, apiKeyAuthLimiter, apiKeyLimiter } from '../services/apiKeys/middleware';
import type { ApiKeyContext } from '../services/apiKeys/apiKeys.service';
import {
  CRON_MAX_TIMEOUT_SEC, DB_ENGINE_VERSIONS, PREVIEW_FETCH_MAX_BYTES, PREVIEW_FETCH_MIN_BYTES, PREVIEW_PATH_MAX, SITE_ENV_MAX_VALUE, SITE_ENV_MAX_VARS,
  DBX_KEY_MAX_ROWS, DBX_KEY_MAX_TIMEOUT_S, FILE_EDIT_MAX_EDITS, FILE_READ_MAX_RANGE, FILE_SEARCH_MAX_PER_FILE, FILE_SEARCH_MAX_RESULTS,
  NOTIFICATION_FAMILIES,
} from '@oblimint/shared';
import type { NotificationFamily } from '@oblimint/shared';
import { keyDatabases } from '../services/apiKeys/keyDatabases';
import { keyEnv } from '../services/apiKeys/keyEnv';
import { keyPending, pendingIdOf, PENDING_WAIT_MAX_MS, statusOf } from '../services/apiKeys/keyPending';
import { errorListQuery, errorListShape } from '../services/siteErrors/siteErrors.service';
import type { SiteBaseId } from '@oblimint/shared';
import { dataPathInputSchema, dataPathUpdateSchema, routeInputSchema, runtimeInputSchema, siteCreateSchema, siteUpdateSchema } from '../validators/hosting.schema';

// /api/v1 — API of the access keys (shared/src/apiKeys.ts), `Authorization: Bearer obk_…`.
// One account; the key's sites only (others: 404); its scopes (missing: 403 keyScope).
// File paths are relative to the site's area: ?area=staging (default: the code, published
// as releases) or ?area=data (the files the site writes).
//   GET    /me                                          → ApiV1Me
//   GET    /guide?lang=en|fr                            → this API's guide (text/markdown)
//   GET    /notifications?unread=1&family=&before=&limit= → UserNotificationPage (the creator's, this account only; read-only)
//   GET    /sites                                       → ApiV1Site[]
//   POST   /sites                SiteCreate − accountId → ApiV1Site (201)              sites.create
//   GET    /sites/:id                                   → ApiV1Site
//   PATCH  /sites/:id   {name?, docroot?, publishMode?, publishDebounceSec?, healthcheckPath?, php?} → ApiV1Site  sites.manage
//   GET    /sites/:id/files?path=&area=&sha256=1        → FileListing (sha256: hashes of the files) files.read
//   GET    /sites/:id/files/text?path=&area=            → FileText (≤ 2 MiB)           files.read
//   GET    /sites/:id/files/read?path=&area=&startLine=&endLine= | &offset=&length=&encoding= → FileRange (sha256 of the whole file) files.read
//   POST   /sites/:id/files/search {query, path?, area?, regex?, caseSensitive?, include?, exclude?, includeVendor?, maxResults?, maxPerFile?}
//                                                        → FileSearchResult (bounded)  files.read
//   POST   /sites/:id/files/edit {path, area?, edits: [{oldString, newString, replaceAll?}], expectedSha256?} → FileEditResult
//                                                        (all or nothing; 409 fileChanged {currentSha256} | editNotFound | editNotUnique) files.write
//   GET    /sites/:id/files/content?path=&area=         → the file (Range)             files.read
//   PUT    /sites/:id/files/content?path=&area=&overwrite=1&expectedSha256= (or If-Match / If-None-Match: *)
//                                                        raw body ≤ 8 MiB → FileWriteResult {path, size, sha256} files.write
//   POST   /sites/:id/uploads   {path, size, area?, overwrite?, expectedSha256?} → FileUploadSession files.write (bigger files)
//   PUT    /uploads/:uid/:index raw chunk               → FileUploadChunkResult         files.write
//   POST   /sites/:id/files/mkdir   {path, area?}       → {path}                       files.write
//   POST   /sites/:id/files/delete  {paths, area?}      → FileOpResult[]               files.write
//   POST   /sites/:id/files/move    {items, overwrite?, area?} → FileOpResult[]        files.write
//   POST   /sites/:id/files/copy    {items, area?}      → FileOpResult[]               files.write
//   POST   /sites/:id/files/extract {path, to?, overwrite?, area?} → FileExtractResult files.write
//   GET    /sites/:id/staging                           → StagingStatus (unpublished changes, base vs live, rollback pending) files.read
//   GET    /sites/:id/leak-check                        → ApiV1LeakCheck (leak guard on the staging: file:line + rule, never the secret) files.read (+ code right)
//   POST   /sites/:id/publish   {message?, overrideRollback?, wait?: true | seconds ≤ 25} → Release (+ outcome with wait) (201; 409 liveRolledBack
//                                                        {liveRelease, rolledBackFrom, count, paths}) releases.publish
//   GET    /sites/:id/releases?limit=&offset=           → { items: Release[]; total }
//   GET    /sites/:id/releases/:rid                     → ApiV1ReleaseDetail (log without staff names / backend details, outcome)
//   GET    /sites/:id/releases/:rid/wait?timeout=≤60    → ApiV1ReleaseDetail once settled (outcome.timedOut otherwise;
//                                                        429 rateLimited over 3 waits at once per key, publish with wait included)
//   GET    /sites/:id/releases/:rid/diff?against=previous|live|empty|<rid>&file= → ReleaseDiff (file: one patch ≤ 256 KiB) files.read (+ code right)
//   POST   /sites/:id/releases/:rid/rollback            → { rolledBack: true }         releases.publish
//   GET    /sites/:id/releases/:rid/files?path=&limit=&offset= → ReleaseFileList (limit ≤ 5000)  files.read (+ code right)
//   GET    /sites/:id/releases/:rid/files/text?path=&encoding=utf8|base64&offset= → ReleaseFileContent (≤ 2 MiB text / 8 MiB base64) files.read
//   GET    /sites/:id/releases/:rid/files/content?path=   → the file, streamed (Content-Length; ≤ 64 MiB, 413 fileTooLarge) files.read
//   POST   /sites/:id/releases/:rid/restore-staging {discardPending?} → StagingRestoreResult (200) | {status:'running'} (202)  files.write
//                                                        (409 stagingHasPendingChanges | restoreInProgress | stagingTooLarge | releaseNotReady)
//   POST   /sites/:id/preview  {release_id? | staging?: true, ttl_minutes?, wait?, include_key?, database?, database_ids?} → PreviewStartResult (202)
//                                                        previews.manage + files.read (staging: + releases.publish; database clone: + databases.manage)
//   GET    /sites/:id/preview                           → SitePreview | null                       previews.manage
//   DELETE /sites/:id/preview                           → { stopped: true }                        previews.manage + files.read
//   POST   /sites/:id/preview/link                      → PreviewLink (one-shot interstitial page)  previews.manage + files.read (creator: sites.manage)
//   GET    /sites/:id/preview/fetch?path=&compare=1&host=&max_bytes=&method= → PreviewFetchResult previews.manage + files.read (compare: + sites.manage)
//   GET    /sites/:id/logs?source=access|error|app&q=&limit=&since=&until=&status= → LogQueryResult  logs.read
//   GET    /sites/:id/errors?release_id=&since_release_id=&new_only=1&level=&limit= → SiteErrorList (PHP errors grouped by release)  logs.read
//   GET    /sites/:id/errors/:gid                       → SiteErrorGroupDetail (sample + stack, other releases)  logs.read
//   GET    /sites/:id/env                               → SiteEnvVar[] (secrets: value null)        sites.manage
//   PATCH  /sites/:id/env  {set?: [{name, value?, secret?}], remove?: [name]} → {vars, changed} (others kept; restarts the site) sites.manage
//   GET    /sites/:id/data-paths                        → SiteDataPath[]
//   POST   /sites/:id/data-paths  SiteDataPathInput     → SiteDataPath (201)                        sites.manage
//   PUT    /sites/:id/data-paths/:pid {policy?, allowedExtensions?} → SiteDataPath                sites.manage
//   DELETE /sites/:id/data-paths/:pid                   → { deleted: true }                        sites.manage
//   GET    /sites/:id/cron                              → CronJob[]                                 cron.manage
//   POST   /sites/:id/cron        CronJobInput          → CronJob (201)                             cron.manage
//   PUT    /sites/:id/cron/:jobId Partial<CronJobInput> → CronJob                                   cron.manage
//   DELETE /sites/:id/cron/:jobId                       → { deleted: true }                        cron.manage
//   POST   /sites/:id/cron/:jobId/run                   → CronRun (202)                             cron.manage
//   GET    /sites/:id/cron/:jobId/runs?limit=&offset=   → { items: CronRun[]; total }              cron.manage
//   GET    /sites/:id/cron/runs/:runId                  → CronRunDetail (output)                    cron.manage
//   GET    /databases/catalog                           → DbCatalog (engines, plan limits)          databases.manage
//   GET    /databases                                   → ApiV1DbInstance[]                         databases.manage
//   POST   /databases             {name, engine, version} → DbInstance (201, provisioning)          databases.manage
//   GET    /databases/:iid                              → ApiV1DbInstance                           databases.manage
//   POST   /databases/:iid/databases {name, charset?, collation?} → ApiV1Database (201)           databases.manage
//   DELETE /databases/:iid/databases/:dbId {confirm: name} → { deleted: true } (its own only)      databases.manage
//   GET    /databases/:iid/databases/:dbId/dump         → application/gzip                          databases.manage
//   POST   /databases/:iid/databases/:dbId/import       raw SQL (plain / gzip), or JSON {siteId, path, area?} → { restored: true } databases.manage
//   GET    /databases/:iid/databases/:dbId/tables       → DbxTable[]                                databases.manage
//   GET    /databases/:iid/databases/:dbId/tables/:table → DbxTableInfo                             databases.manage
//   POST   /databases/:iid/databases/:dbId/query {sql, write?, maxRows?, timeoutS?} → ApiV1DbQueryResult (read-only unless write) databases.manage
//   POST   /databases/:iid/users  {username, password?, grants?, env?} → ApiV1DbCredentials (201) databases.manage (+ sites.manage for env)
//   PUT    /databases/:iid/users/:uid {grants}          → ApiV1DbUser                               databases.manage
//   POST   /databases/:iid/users/:uid/password {password?, env?} → ApiV1DbCredentials             databases.manage
//   DELETE /databases/:iid/users/:uid                   → { deleted: true } (its own only)         databases.manage
//   GET    /routes                                      → ApiV1RouteDomain[] (domains, their path routes) routes.manage
//   POST   /routes   {domain, pathPrefix, siteId, runtimeId?} → ApiV1Route (201)                 routes.manage
//   PUT    /routes/:rid {pathPrefix?, siteId?, runtimeId?} → ApiV1Route                         routes.manage
//   GET    /sites/:id/runtimes                          → SiteRuntime[]
//   POST   /sites/:id/runtimes {base}                   → SiteRuntime (201)                         sites.manage
//   DELETE /sites/:id/runtimes/:rtid                    → { deleted: true } (409 runtimeInUse)    sites.manage
//   DELETE /routes/:rid                                 → { deleted: true }                        routes.manage
//   GET    /domains                                     → ApiV1ParentDomain[] (parents allowed)   domains.subdomain
//   GET    /subdomains                                  → ApiV1Subdomain[] (created by the key)   domains.subdomain
//   POST   /sites/:id/subdomains {name}                 → ApiV1Subdomain (201)                    domains.subdomain
//   DELETE /subdomains/:name                            → { deleted: true } (its own only)       domains.subdomain
//   GET    /pending-actions?status=                     → KeyPendingAction[] (this key's requests for protected actions)
//   GET    /pending-actions/:pid                        → KeyPendingAction
//   GET    /pending-actions/:pid/wait?timeout=≤60       → KeyPendingAction once decided (timedOut otherwise; one of the 3 wait slots)
//   DELETE /pending-actions/:pid                        → KeyPendingAction (withdrawn)
// Protected actions (shared/src/restrictions.ts): a gated route may answer 428 twoFactorRequired | approvalRequired
// {details.pendingActionId, description, userMessage, next}, 403 twoFactorNotEnrolled, 409 noEligibleApprover; once
// approved, the SAME request again runs once (optional header X-Oblimint-Approval: <pendingActionId>; 409 approvalMismatch).

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
// The platform-only settings (custom nginx, base path, profile) stay in the panel.
const updateSchema = siteUpdateSchema.pick({ name: true, docroot: true, publishMode: true, publishDebounceSec: true, healthcheckPath: true, php: true });
const pathBody = z.object({ path: relPath.min(1), area: area.optional() }).strict();
const pathsBody = z.object({ paths: z.array(relPath.min(1)).min(1).max(1000), area: area.optional() }).strict();
const itemsBody = z.object({
  items: z.array(z.object({ from: relPath.min(1), to: relPath.min(1) }).strict()).min(1).max(1000),
  overwrite: z.boolean().optional(),
  area: area.optional(),
}).strict();
const extractBody = z.object({ path: relPath.min(1), to: relPath.optional(), overwrite: z.boolean().optional(), area: area.optional() }).strict();
const sha256Field = z.string().max(80);
const uploadBody = z.object({ path: relPath.min(1), size: z.number().int().min(0), overwrite: z.boolean().optional(), expectedSha256: sha256Field.optional(), area: area.optional() }).strict();
const readQuery = z.object({
  path: relPath.min(1), area: area.optional(),
  startLine: z.coerce.number().int().min(1).optional(), endLine: z.coerce.number().int().min(1).optional(),
  offset: z.coerce.number().int().min(0).optional(), length: z.coerce.number().int().min(1).max(FILE_READ_MAX_RANGE).optional(),
  encoding: z.enum(['utf8', 'base64']).optional(),
}).strict();
const globs = z.array(z.string().min(1).max(200)).max(20);
const searchBody = z.object({
  query: z.string().min(1).max(1000), path: relPath.optional(), area: area.optional(), regex: z.boolean().optional(), caseSensitive: z.boolean().optional(),
  include: globs.optional(), exclude: globs.optional(), includeVendor: z.boolean().optional(),
  maxResults: z.number().int().min(1).max(FILE_SEARCH_MAX_RESULTS).optional(), maxPerFile: z.number().int().min(1).max(FILE_SEARCH_MAX_PER_FILE).optional(),
}).strict();
const editBody = z.object({
  path: relPath.min(1), area: area.optional(), expectedSha256: sha256Field.optional(),
  edits: z.array(z.object({ oldString: z.string().min(1), newString: z.string(), replaceAll: z.boolean().optional() }).strict()).min(1).max(FILE_EDIT_MAX_EDITS),
}).strict();
const publishBody = z.object({
  message: z.string().max(500).nullable().optional(), overrideRollback: z.boolean().optional(),
  // true = the longest wait (25 s), a number = seconds.
  wait: z.union([z.boolean(), z.number().int().min(0).max(PUBLISH_WAIT_MAX_MS / 1000)]).optional(),
}).strict();
const diffQuery = z.object({
  against: z.union([z.enum(['previous', 'live', 'empty']), z.coerce.number().int().positive()]).default('previous'),
  file: z.string().min(1).max(4096).optional(),
}).strict();
const waitQuery = z.object({ timeout: z.coerce.number().int().min(0).max(RELEASE_WAIT_MAX_MS / 1000).default(30) }).strict();
const waitMsOf = (w: boolean | number | undefined) => (w === true ? PUBLISH_WAIT_MAX_MS : typeof w === 'number' ? w * 1000 : 0);
const restoreBody = z.object({ discardPending: z.boolean().optional() }).strict();
const releaseFilesQuery = z.object({
  path: relPath.optional(), limit: z.coerce.number().int().min(1).max(5000).default(200), offset: z.coerce.number().int().min(0).default(0),
}).passthrough();
const releaseTextQuery = z.object({ path: relPath, encoding: z.enum(['utf8', 'base64']).default('utf8'), offset: z.coerce.number().int().min(0).default(0) }).passthrough();

const previewStartBody = z.object({
  release_id: z.number().int().positive().nullable().optional(),
  staging: z.boolean().optional(),
  ttl_minutes: z.number().int().min(1).max(1440).nullable().optional(),
  wait: z.boolean().optional(),
  include_key: z.boolean().optional(),
  database: z.enum(['none', 'clone']).optional(),
  database_ids: z.array(z.number().int().positive()).max(8).optional(),
}).strict();
const previewFetchQuery = z.object({
  path: z.string().min(1).max(PREVIEW_PATH_MAX),
  compare: z.enum(['0', '1', 'true', 'false']).optional(),
  host: z.enum(['preview', 'live']).optional(),
  max_bytes: z.coerce.number().int().min(PREVIEW_FETCH_MIN_BYTES).max(PREVIEW_FETCH_MAX_BYTES).optional(),
  method: z.enum(['GET', 'HEAD']).optional(),
}).strict();

const notificationsQuery = z.object({
  unread: z.enum(['0', '1', 'true', 'false']).optional(),
  family: z.enum(NOTIFICATION_FAMILIES as unknown as [NotificationFamily, ...NotificationFamily[]]).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
}).strict();

type Handler = (req: Request, res: Response) => Promise<void>;
const h = (fn: Handler) => (req: Request, res: Response, next: (err?: unknown) => void) => { fn(req, res).catch(next); };
const ok = (res: Response, data: unknown, status = 200) => { res.status(status).json({ success: true, data }); };

router.get('/me', h(async (req, res) => ok(res, await keyApi.me(ctxOf(req)))));
router.get('/guide', h(async (req, res) => {
  ctxOf(req);
  res.type('text/markdown; charset=utf-8').send(await keyApi.guide(req, req.query.lang === 'fr' ? 'fr' : 'en'));
}));
router.get('/notifications', h(async (req, res) => {
  const ctx = ctxOf(req);
  const q = parseBody(notificationsQuery, req.query);
  ok(res, await keyApi.notifications(ctx, { unread: q.unread === '1' || q.unread === 'true', family: q.family ?? null, before: q.before ?? null, limit: q.limit }));
}));
router.get('/sites', h(async (req, res) => ok(res, await keyApi.listSites(ctxOf(req)))));
router.post('/sites', h(async (req, res) => ok(res, await keyApi.createSite(ctxOf(req), req, parseBody(createSchema, req.body)), 201)));
router.get('/sites/:id', h(async (req, res) => ok(res, await keyApi.getSite(ctxOf(req), siteId(req)))));
router.patch('/sites/:id', h(async (req, res) => ok(res, await keyApi.updateSite(ctxOf(req), req, siteId(req), parseBody(updateSchema, req.body)))));

const flag = (v: unknown) => v === '1' || v === 'true';
router.get('/sites/:id/files', h(async (req, res) => ok(res, await keyApi.listFiles(ctxOf(req), siteId(req), areaOf(req.query.area), qPath(req), { sha256: flag(req.query.sha256) }))));
router.get('/sites/:id/files/text', h(async (req, res) => ok(res, await keyApi.readText(ctxOf(req), siteId(req), areaOf(req.query.area), qPath(req)))));
router.get('/sites/:id/files/read', h(async (req, res) => {
  const q = parseBody(readQuery, req.query);
  ok(res, await keyApi.readRange(ctxOf(req), siteId(req), areaOf(q.area), q.path, {
    startLine: q.startLine, endLine: q.endLine, offset: q.offset, length: q.length, encoding: q.encoding,
  }));
}));
router.post('/sites/:id/files/search', heavyOpLimiter, h(async (req, res) => {
  const b = parseBody(searchBody, req.body);
  ok(res, await keyApi.search(ctxOf(req), siteId(req), areaOf(b.area), b.path ?? '/', {
    query: b.query, regex: b.regex === true, caseSensitive: b.caseSensitive === true, include: b.include, exclude: b.exclude,
    includeVendor: b.includeVendor === true, maxResults: b.maxResults, maxPerFile: b.maxPerFile,
  }));
}));
router.post('/sites/:id/files/edit', h(async (req, res) => {
  const b = parseBody(editBody, req.body);
  ok(res, await keyApi.edit(ctxOf(req), req, siteId(req), areaOf(b.area), b.path, b.edits, b.expectedSha256 ?? null));
}));

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
    // Precondition: ?expectedSha256= or If-Match: "<sha256>" (409 fileChanged); If-None-Match: * = create only.
    const ifMatch = typeof req.headers['if-match'] === 'string' && req.headers['if-match'].trim() !== '*' ? req.headers['if-match'] : undefined;
    const expected = typeof req.query.expectedSha256 === 'string' ? req.query.expectedSha256 : ifMatch;
    const createOnly = typeof req.headers['if-none-match'] === 'string' && req.headers['if-none-match'].trim() === '*';
    if (expected !== undefined && createOnly) throw new AppError(400, 'Give expectedSha256 (If-Match) or If-None-Match: *, not both', 'validation');
    ok(res, await keyApi.putFile(ctxOf(req), req, siteId(req), areaOf(req.query.area), qPath(req), size, req,
      !createOnly && flag(req.query.overwrite), expected ?? null));
  })().catch((err) => { req.resume(); next(err); });
});

router.post('/sites/:id/uploads', h(async (req, res) => {
  const b = parseBody(uploadBody, req.body);
  ok(res, await keyApi.uploadStart(ctxOf(req), req, siteId(req), areaOf(b.area), b.path, b.size, b.overwrite === true, b.expectedSha256 ?? null));
}));

router.put('/uploads/:uid/:index', (req, res, next) => {
  (async () => {
    const uid = String(req.params.uid);
    if (!/^[0-9a-f]{32}$/.test(uid)) throw new AppError(404, 'Upload not found or expired', 'uploadNotFound');
    const length = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(length) || length < 0) throw new AppError(411, 'Content-Length is required', 'invalidChunk');
    ok(res, await keyApi.uploadChunk(ctxOf(req), req, uid, Number(req.params.index), length, req));
  })().catch((err) => { req.resume(); next(err); });
});

router.post('/sites/:id/files/mkdir', h(async (req, res) => {
  const b = parseBody(pathBody, req.body);
  ok(res, { path: await keyApi.mkdir(ctxOf(req), req, siteId(req), areaOf(b.area), b.path) });
}));
router.post('/sites/:id/files/delete', h(async (req, res) => {
  const b = parseBody(pathsBody, req.body);
  ok(res, await keyApi.remove(ctxOf(req), req, siteId(req), areaOf(b.area), b.paths));
}));
router.post('/sites/:id/files/move', h(async (req, res) => {
  const b = parseBody(itemsBody, req.body);
  ok(res, await keyApi.move(ctxOf(req), req, siteId(req), areaOf(b.area), b.items, b.overwrite === true));
}));
router.post('/sites/:id/files/copy', h(async (req, res) => {
  const b = parseBody(itemsBody, req.body);
  ok(res, await keyApi.move(ctxOf(req), req, siteId(req), areaOf(b.area), b.items, false, true));
}));
router.post('/sites/:id/files/extract', h(async (req, res) => {
  const b = parseBody(extractBody, req.body);
  ok(res, await keyApi.extract(ctxOf(req), req, siteId(req), areaOf(b.area), b.path, b.to, b.overwrite === true));
}));

router.get('/sites/:id/staging', h(async (req, res) => ok(res, await keyApi.stagingStatus(ctxOf(req), siteId(req)))));
router.get('/sites/:id/leak-check', heavyOpLimiter, h(async (req, res) => ok(res, await keyApi.checkLeaks(ctxOf(req), siteId(req)))));
router.post('/sites/:id/publish', h(async (req, res) => {
  const b = parseBody(publishBody, req.body ?? {});
  ok(res, await keyApi.publish(ctxOf(req), req, siteId(req), b.message ?? null, { overrideRollback: b.overrideRollback === true, waitMs: waitMsOf(b.wait) }), 201);
}));
router.get('/sites/:id/releases', h(async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  ok(res, await keyApi.releases(ctxOf(req), siteId(req), limit, offset));
}));
router.get('/sites/:id/releases/:rid', h(async (req, res) => ok(res, await keyApi.release(ctxOf(req), siteId(req), req.params.rid))));
router.get('/sites/:id/releases/:rid/wait', h(async (req, res) => {
  const q = parseBody(waitQuery, req.query);
  ok(res, await keyApi.waitRelease(ctxOf(req), req, siteId(req), req.params.rid, q.timeout * 1000));
}));
router.get('/sites/:id/releases/:rid/diff', heavyOpLimiter, h(async (req, res) => {
  const q = parseBody(diffQuery, req.query);
  ok(res, await keyApi.diffRelease(ctxOf(req), siteId(req), req.params.rid, q.against, q.file ?? null));
}));
router.post('/sites/:id/releases/:rid/rollback', h(async (req, res) => {
  await keyApi.rollback(ctxOf(req), req, siteId(req), idParam(req, 'rid'));
  ok(res, { rolledBack: true });
}));
router.get('/sites/:id/releases/:rid/files', h(async (req, res) => {
  const q = parseBody(releaseFilesQuery, req.query);
  ok(res, await keyApi.releaseFiles(ctxOf(req), siteId(req), idParam(req, 'rid'), q.path ?? '', q.limit, q.offset));
}));
router.get('/sites/:id/releases/:rid/files/text', h(async (req, res) => {
  const q = parseBody(releaseTextQuery, req.query);
  ok(res, await keyApi.releaseFile(ctxOf(req), siteId(req), idParam(req, 'rid'), q.path, { encoding: q.encoding, offset: q.offset }));
}));
router.get('/sites/:id/releases/:rid/files/content', h(async (req, res) => {
  const f = await keyApi.releaseFileStream(ctxOf(req), siteId(req), idParam(req, 'rid'), qPath(req));
  const { stream, kill } = f.open();
  res.status(200);
  res.setHeader('Content-Length', String(f.entry.size));
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.entry.path.split('/').pop() ?? 'file')}`);
  req.on('close', kill);
  stream.on('error', () => { kill(); res.destroy(); });
  stream.pipe(res);
}));
router.post('/sites/:id/releases/:rid/restore-staging', heavyOpLimiter, h(async (req, res) => {
  const b = parseBody(restoreBody, req.body ?? {});
  const r = await keyApi.restoreReleaseToStaging(ctxOf(req), req, siteId(req), idParam(req, 'rid'), { discardPending: b.discardPending === true });
  ok(res, r, r.status === 'running' ? 202 : 200);
}));
// Feature B: live previews (previews.manage + files.read; staging: + releases.publish; compare: + sites.manage).
router.post('/sites/:id/preview', heavyOpLimiter, h(async (req, res) => {
  const b = parseBody(previewStartBody, req.body ?? {});
  ok(res, await keyApi.previewStart(ctxOf(req), req, siteId(req), {
    releaseId: b.release_id ?? null, staging: b.staging === true, ttlMinutes: b.ttl_minutes ?? null, wait: b.wait !== false, includeKey: b.include_key === true,
    database: b.database ?? 'none', databaseIds: b.database_ids ?? null,
  }), 202);
}));
router.get('/sites/:id/preview', h(async (req, res) => ok(res, await keyApi.previewGet(ctxOf(req), siteId(req)))));
router.delete('/sites/:id/preview', h(async (req, res) => ok(res, await keyApi.previewStop(ctxOf(req), req, siteId(req)))));
router.post('/sites/:id/preview/link', h(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  ok(res, await keyApi.previewLink(ctxOf(req), req, siteId(req)));
}));
router.get('/sites/:id/preview/fetch', heavyOpLimiter, h(async (req, res) => {
  const q = parseBody(previewFetchQuery, req.query);
  ok(res, await keyApi.previewFetch(ctxOf(req), siteId(req), {
    path: q.path, compare: q.compare === '1' || q.compare === 'true', host: q.host ?? null, maxBytes: q.max_bytes ?? null, method: q.method ?? null,
  }));
}));
router.get('/sites/:id/logs', h(async (req, res) => {
  const q = req.query;
  ok(res, await keyApi.logs(ctxOf(req), siteId(req), {
    source: String(q.source ?? 'error'), q: typeof q.q === 'string' ? q.q : null,
    limit: q.limit ? Number(q.limit) : null, since: typeof q.since === 'string' ? q.since : null,
    until: typeof q.until === 'string' ? q.until : null, status: typeof q.status === 'string' ? q.status : null,
  }));
}));
router.get('/sites/:id/errors', h(async (req, res) => {
  ok(res, await keyApi.errors(ctxOf(req), siteId(req), errorListQuery(parseBody(errorListShape, req.query))));
}));
router.get('/sites/:id/errors/:gid', h(async (req, res) => {
  ok(res, await keyApi.error(ctxOf(req), siteId(req), Number(req.params.gid)));
}));

router.get('/domains', h(async (req, res) => ok(res, await keyApi.parentDomains(ctxOf(req)))));
router.get('/subdomains', h(async (req, res) => ok(res, await keyApi.subdomains(ctxOf(req)))));
router.post('/sites/:id/subdomains', h(async (req, res) => {
  const b = parseBody(z.object({ name: z.string().min(4).max(253) }).strict(), req.body);
  ok(res, await keyApi.addSubdomain(ctxOf(req), req, siteId(req), b.name), 201);
}));
router.delete('/subdomains/:name', h(async (req, res) => {
  await keyApi.removeSubdomain(ctxOf(req), req, String(req.params.name));
  ok(res, { deleted: true });
}));

// ── path routes ──
const prefix = z.string().min(1).max(255);
/** "/uploads" or "uploads" → "/uploads/", checked like the panel routes. */
const routePrefix = (v: string) => {
  const inner = v.trim().replace(/^\/+|\/+$/g, '');
  return parseBody(z.object({ p: routeInputSchema.shape.pathPrefix }), { p: inner ? `/${inner}/` : '/' }).p;
};
router.get('/routes', h(async (req, res) => ok(res, await keyApi.routes(ctxOf(req)))));
router.post('/routes', h(async (req, res) => {
  const b = parseBody(z.object({ domain: z.string().min(1).max(253), pathPrefix: prefix, siteId: z.number().int().positive(), runtimeId: z.number().int().positive().nullable().optional() }).strict(), req.body);
  ok(res, await keyApi.addRoute(ctxOf(req), req, b.domain, routePrefix(b.pathPrefix), b.siteId, b.runtimeId ?? null), 201);
}));
router.put('/routes/:rid', h(async (req, res) => {
  const b = parseBody(z.object({ pathPrefix: prefix.optional(), siteId: z.number().int().positive().optional(), runtimeId: z.number().int().positive().nullable().optional() }).strict(), req.body);
  ok(res, await keyApi.updateRoute(ctxOf(req), req, Number(req.params.rid), {
    ...(b.pathPrefix ? { pathPrefix: routePrefix(b.pathPrefix) } : {}), ...(b.siteId ? { siteId: b.siteId } : {}), ...(b.runtimeId !== undefined ? { runtimeId: b.runtimeId } : {}),
  }));
}));
router.get('/sites/:id/runtimes', h(async (req, res) => ok(res, await keyApi.runtimes(ctxOf(req), siteId(req)))));
router.post('/sites/:id/runtimes', h(async (req, res) => {
  const b = parseBody(runtimeInputSchema, req.body);
  ok(res, await keyApi.addRuntime(ctxOf(req), req, siteId(req), b.base as SiteBaseId), 201);
}));
router.delete('/sites/:id/runtimes/:rtid', h(async (req, res) => {
  await keyApi.deleteRuntime(ctxOf(req), req, siteId(req), Number(req.params.rtid));
  ok(res, { deleted: true });
}));
router.delete('/routes/:rid', h(async (req, res) => {
  await keyApi.deleteRoute(ctxOf(req), req, Number(req.params.rid));
  ok(res, { deleted: true });
}));

// ── environment variables, data paths ──
const envBody = z.object({
  set: z.array(z.object({ name: z.string().min(1).max(128), value: z.string().max(SITE_ENV_MAX_VALUE).nullable().optional(), secret: z.boolean().optional() }).strict()).max(SITE_ENV_MAX_VARS).optional(),
  remove: z.array(z.string().min(1).max(128)).max(SITE_ENV_MAX_VARS).optional(),
}).strict();
router.get('/sites/:id/env', h(async (req, res) => { res.setHeader('Cache-Control', 'no-store'); ok(res, await keyEnv.list(ctxOf(req), siteId(req))); }));
router.patch('/sites/:id/env', h(async (req, res) => {
  const b = parseBody(envBody, req.body);
  res.setHeader('Cache-Control', 'no-store');
  ok(res, await keyEnv.update(ctxOf(req), req, siteId(req), b.set ?? [], b.remove ?? []));
}));
router.get('/sites/:id/data-paths', h(async (req, res) => ok(res, await keyApi.dataPaths(ctxOf(req), siteId(req)))));
router.post('/sites/:id/data-paths', h(async (req, res) => ok(res, await keyApi.addDataPath(ctxOf(req), req, siteId(req), parseBody(dataPathInputSchema, req.body)), 201)));
router.put('/sites/:id/data-paths/:pid', h(async (req, res) => ok(res, await keyApi.updateDataPath(ctxOf(req), req, siteId(req), Number(req.params.pid), parseBody(dataPathUpdateSchema, req.body)))));
router.delete('/sites/:id/data-paths/:pid', h(async (req, res) => {
  await keyApi.deleteDataPath(ctxOf(req), req, siteId(req), Number(req.params.pid));
  ok(res, { deleted: true });
}));

// ── cron ──
const cronFields = {
  name: z.string().min(1).max(100),
  schedule: z.string().min(1).max(100),
  command: z.string().min(1).max(100_000),
  timeoutSec: z.number().int().min(10).max(CRON_MAX_TIMEOUT_SEC).optional(),
  enabled: z.boolean().optional(),
};
const cronCreate = z.object(cronFields).strict();
const cronUpdate = z.object(cronFields).partial().strict();
router.get('/sites/:id/cron', h(async (req, res) => ok(res, await keyApi.cronJobs(ctxOf(req), siteId(req)))));
router.post('/sites/:id/cron', h(async (req, res) => ok(res, await keyApi.createCronJob(ctxOf(req), req, siteId(req), parseBody(cronCreate, req.body)), 201)));
// Before /sites/:id/cron/:jobId/* ("runs" is not a job id).
router.get('/sites/:id/cron/runs/:runId', h(async (req, res) => ok(res, await keyApi.cronRun(ctxOf(req), siteId(req), Number(req.params.runId)))));
router.put('/sites/:id/cron/:jobId', h(async (req, res) => ok(res, await keyApi.updateCronJob(ctxOf(req), req, siteId(req), Number(req.params.jobId), parseBody(cronUpdate, req.body)))));
router.delete('/sites/:id/cron/:jobId', h(async (req, res) => {
  await keyApi.deleteCronJob(ctxOf(req), req, siteId(req), Number(req.params.jobId));
  ok(res, { deleted: true });
}));
router.post('/sites/:id/cron/:jobId/run', h(async (req, res) => ok(res, await keyApi.runCronJob(ctxOf(req), req, siteId(req), Number(req.params.jobId)), 202)));
router.get('/sites/:id/cron/:jobId/runs', h(async (req, res) => {
  const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
  ok(res, await keyApi.cronRuns(ctxOf(req), siteId(req), Number(req.params.jobId), q.limit, q.offset));
}));

// ── databases ──
const engines = [...new Set(DB_ENGINE_VERSIONS.map((v) => v.engine))] as [string, ...string[]];
const grants = z.array(z.object({ databaseId: z.number().int().positive(), level: z.enum(['all', 'readonly']) }).strict()).max(500);
const envTarget = z.object({ siteId: z.number().int().positive(), prefix: z.string().min(1).max(32).optional(), databaseId: z.number().int().positive().optional() }).strict();
const iid = (req: Request) => Number(req.params.iid);
router.get('/databases/catalog', h(async (req, res) => ok(res, await keyDatabases.catalog(ctxOf(req)))));
router.get('/databases', h(async (req, res) => ok(res, await keyDatabases.list(ctxOf(req)))));
router.post('/databases', h(async (req, res) => {
  const b = parseBody(z.object({ name: z.string().min(1).max(32), engine: z.enum(engines), version: z.string().min(1).max(16) }).strict(), req.body);
  ok(res, await keyDatabases.createInstance(ctxOf(req), req, b as Parameters<typeof keyDatabases.createInstance>[2]), 201);
}));
router.get('/databases/:iid', h(async (req, res) => ok(res, await keyDatabases.get(ctxOf(req), iid(req)))));
router.post('/databases/:iid/databases', h(async (req, res) => {
  const b = parseBody(z.object({ name: z.string().min(1).max(64), charset: z.string().max(32).nullable().optional(), collation: z.string().max(64).nullable().optional() }).strict(), req.body);
  ok(res, await keyDatabases.createDatabase(ctxOf(req), req, iid(req), b), 201);
}));
router.delete('/databases/:iid/databases/:dbId', h(async (req, res) => {
  const b = parseBody(z.object({ confirm: z.string().max(128) }).strict(), req.body ?? {});
  await keyDatabases.deleteDatabase(ctxOf(req), req, iid(req), Number(req.params.dbId), b.confirm);
  ok(res, { deleted: true });
}));
router.get('/databases/:iid/databases/:dbId/dump', h(async (req, res) => {
  await keyDatabases.dump(ctxOf(req), req, res, iid(req), Number(req.params.dbId));
}));
router.post('/databases/:iid/databases/:dbId/import', h(async (req, res) => {
  const ctx = ctxOf(req);
  const dbId = Number(req.params.dbId);
  if (req.is('application/json')) {
    // An SQL file already in one of the key's sites (uploaded with the file routes).
    const b = parseBody(z.object({ siteId: z.number().int().positive(), path: relPath.min(1), area: area.optional() }).strict(), req.body);
    ok(res, await keyDatabases.importFromSite(ctx, req, iid(req), dbId, b.siteId, b.area ?? 'staging', b.path));
    return;
  }
  ok(res, await keyDatabases.importSql(ctx, req, iid(req), dbId));
}));
router.get('/databases/:iid/databases/:dbId/tables', h(async (req, res) => {
  ok(res, await keyDatabases.tables(ctxOf(req), iid(req), Number(req.params.dbId)));
}));
router.get('/databases/:iid/databases/:dbId/tables/:table', h(async (req, res) => {
  ok(res, await keyDatabases.describeTable(ctxOf(req), iid(req), Number(req.params.dbId), z.string().min(1).max(512).parse(req.params.table)));
}));
router.post('/databases/:iid/databases/:dbId/query', h(async (req, res) => {
  const b = parseBody(z.object({
    sql: z.string().min(1).max(256 * 1024), write: z.boolean().optional(),
    maxRows: z.number().int().min(1).max(DBX_KEY_MAX_ROWS).optional(), timeoutS: z.number().int().min(1).max(DBX_KEY_MAX_TIMEOUT_S).optional(),
  }).strict(), req.body);
  ok(res, await keyDatabases.query(ctxOf(req), req, iid(req), Number(req.params.dbId), b));
}));
router.post('/databases/:iid/users', h(async (req, res) => {
  const b = parseBody(z.object({ username: z.string().min(1).max(32), password: z.string().max(128).nullable().optional(), grants: grants.optional(), env: envTarget.optional() }).strict(), req.body);
  ok(res, await keyDatabases.createUser(ctxOf(req), req, iid(req), b), 201);
}));
router.put('/databases/:iid/users/:uid', h(async (req, res) => {
  const b = parseBody(z.object({ grants }).strict(), req.body);
  ok(res, await keyDatabases.setGrants(ctxOf(req), req, iid(req), Number(req.params.uid), b.grants));
}));
router.post('/databases/:iid/users/:uid/password', h(async (req, res) => {
  const b = parseBody(z.object({ password: z.string().max(128).nullable().optional(), env: envTarget.optional() }).strict(), req.body ?? {});
  ok(res, await keyDatabases.resetPassword(ctxOf(req), req, iid(req), Number(req.params.uid), b));
}));
router.delete('/databases/:iid/users/:uid', h(async (req, res) => {
  await keyDatabases.deleteUser(ctxOf(req), req, iid(req), Number(req.params.uid));
  ok(res, { deleted: true });
}));

// ── protected actions: this key's pending actions (read-only follow-up; a key never confirms nor approves) ──
const pendingWaitQuery = z.object({ timeout: z.coerce.number().int().min(0).max(PENDING_WAIT_MAX_MS / 1000).default(30) }).strict();
router.get('/pending-actions', h(async (req, res) => ok(res, await keyPending.list(ctxOf(req), statusOf(req.query.status)))));
router.get('/pending-actions/:pid', h(async (req, res) => ok(res, await keyPending.get(ctxOf(req), pendingIdOf(req.params.pid)))));
router.get('/pending-actions/:pid/wait', h(async (req, res) => {
  const q = parseBody(pendingWaitQuery, req.query);
  ok(res, await keyPending.wait(ctxOf(req), req, pendingIdOf(req.params.pid), q.timeout * 1000));
}));
router.delete('/pending-actions/:pid', h(async (req, res) => ok(res, await keyPending.cancel(ctxOf(req), req, pendingIdOf(req.params.pid)))));

router.use((_req, res) => { res.status(404).json({ success: false, error: 'Not found', code: 'notFound' }); });

export default router;
