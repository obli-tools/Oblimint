import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { heavyOpLimiter } from '../middleware/rateLimiter';
import { idParam, resolveActor } from '../services/hosting/access';
import { loadOwned, type P4bTable } from '../services/hosting/p4bAccess';
import { SLUG_RE, statusPageService } from '../services/monitoring/statusPages.service';
import { uptimeService } from '../services/monitoring/uptime.service';

// /api/uptime — OWNED BY MODULE `monitoring-automation` (docs/P4b-PLAN.md §6.6). Tenant router.
// read = member / staff read; changes = monitoring.manage on the account (accountId null: staff, platform rows).
//   GET    /monitors?accountId&tenantId&status                  → UptimeMonitor[]
//   POST   /monitors               UptimeMonitorInput           → UptimeMonitor (201)
//   GET    /monitors/:id                                        → UptimeMonitor
//   PUT    /monitors/:id           UptimeMonitorUpdate          → UptimeMonitor
//   DELETE /monitors/:id                                        → { deleted: true }
//   GET    /monitors/:id/checks?range=24h|7d|30d                → UptimeCheckPoint[]
//   POST   /monitors/:id/check-now                              → UptimeCheckPoint   (1 / 10 s / monitor)
//   POST   /sync-proxy-hosts       { accountId }                → { created, removed } (auto monitors of the account's hosts)
//   GET    /status-pages?accountId&tenantId                     → StatusPage[]
//   POST   /status-pages           StatusPageInput              → StatusPage (201)   (409 slugTaken)
//   GET    /status-pages/:id                                    → StatusPage
//   PUT    /status-pages/:id       StatusPageUpdate             → StatusPage
//   DELETE /status-pages/:id                                    → { deleted: true }
// Codes: planLimit (409, dimension uptimeMonitors), targetNotAllowed (403: private address), intervalTooShort (400),
// slugTaken (409), monitorNotInAccount (400: a status page lists monitors of its own account / platform only).
// Also: autoMonitor (409: target fields of a monitor managed by its proxy host), rateLimited (429: check-now).
// Notes: expectedStatus [] = any 2xx / 3xx (auto monitors); access is checked BEFORE a body is validated (no
// existence oracle through 400 vs 404).

const router = Router();

const optId = z.coerce.number().int().positive().optional();
const listQuery = z.object({ accountId: optId, tenantId: optId });

/** Access guard run before the body validation: 404 invisible, 403 without the need. */
function guard(table: P4bTable, what: string, need: 'read' | 'monitoring.manage' = 'monitoring.manage') {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      await loadOwned(await resolveActor(req), table, idParam(req), need, what);
      next();
    } catch (err) { next(err); }
  };
}

// ── monitors ─────────────────────────────────────────────────────────────────

const monitorFields = {
  name: z.string().trim().min(1).max(128),
  kind: z.enum(['http', 'tcp', 'keyword']),
  url: z.string().trim().max(2048).nullable().optional(),
  host: z.string().trim().max(253).nullable().optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  keyword: z.string().min(1).max(255).nullable().optional(),
  keywordInvert: z.boolean().optional(),
  method: z.enum(['GET', 'HEAD']).optional(),
  expectedStatus: z.array(z.number().int().min(100).max(599)).max(20).optional(),
  intervalSec: z.number().int().min(1).max(86_400).optional(),
  timeoutMs: z.number().int().min(500).max(60_000).optional(),
  retries: z.number().int().min(0).max(10).optional(),
  proxyHostId: z.number().int().positive().nullable().optional(),
  notify: z.boolean().optional(),
  enabled: z.boolean().optional(),
};
const monitorInput = z.object({ accountId: z.number().int().positive().nullable(), ...monitorFields }).strict();
const monitorUpdate = z.object({ ...monitorFields, name: monitorFields.name.optional(), kind: monitorFields.kind.optional() }).strict();
const monitorListQuery = listQuery.extend({ status: z.enum(['up', 'down', 'pending', 'paused']).optional() });

router.get('/monitors', validate(monitorListQuery, 'query'), async (req, res, next) => {
  try {
    res.json({ success: true, data: await uptimeService.list(await resolveActor(req), req.query as unknown as z.infer<typeof monitorListQuery>) });
  } catch (err) { next(err); }
});

router.post('/monitors', validate(monitorInput), async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await uptimeService.create(req, await resolveActor(req), req.body) });
  } catch (err) { next(err); }
});

router.get('/monitors/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await uptimeService.get(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.put('/monitors/:id', guard('uptime_monitors', 'Monitor'), validate(monitorUpdate), async (req, res, next) => {
  try {
    res.json({ success: true, data: await uptimeService.update(req, await resolveActor(req), idParam(req), req.body) });
  } catch (err) { next(err); }
});

router.delete('/monitors/:id', async (req, res, next) => {
  try {
    await uptimeService.remove(req, await resolveActor(req), idParam(req));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

const checksQuery = z.object({ range: z.enum(['24h', '7d', '30d']).default('24h') });

router.get('/monitors/:id/checks', validate(checksQuery, 'query'), async (req, res, next) => {
  try {
    const q = req.query as unknown as z.infer<typeof checksQuery>;
    res.json({ success: true, data: await uptimeService.checks(await resolveActor(req), idParam(req), q.range) });
  } catch (err) { next(err); }
});

router.post('/monitors/:id/check-now', heavyOpLimiter, async (req, res, next) => {
  try {
    res.json({ success: true, data: await uptimeService.checkNow(req, await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/sync-proxy-hosts', heavyOpLimiter, validate(z.object({ accountId: z.number().int().positive() }).strict()), async (req, res, next) => {
  try {
    res.json({ success: true, data: await uptimeService.syncProxyHosts(req, await resolveActor(req), req.body.accountId) });
  } catch (err) { next(err); }
});

// ── status pages ─────────────────────────────────────────────────────────────

const pageFields = {
  slug: z.string().trim().toLowerCase().regex(SLUG_RE, 'lowercase letters, digits and dashes (3 … 63)'),
  title: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2000).nullable().optional(),
  monitorIds: z.array(z.number().int().positive()).max(100).optional(),
  // Size checked again in bytes by the service (≤ 16 KiB).
  customCss: z.string().max(32 * 1024).nullable().optional(),
  published: z.boolean().optional(),
};
const pageInput = z.object({ accountId: z.number().int().positive().nullable(), ...pageFields }).strict();
const pageUpdate = z.object({ ...pageFields, slug: pageFields.slug.optional(), title: pageFields.title.optional() }).strict();

router.get('/status-pages', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    res.json({ success: true, data: await statusPageService.list(await resolveActor(req), req.query as unknown as z.infer<typeof listQuery>) });
  } catch (err) { next(err); }
});

router.post('/status-pages', validate(pageInput), async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await statusPageService.create(req, await resolveActor(req), req.body) });
  } catch (err) { next(err); }
});

router.get('/status-pages/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await statusPageService.get(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.put('/status-pages/:id', guard('status_pages', 'Status page'), validate(pageUpdate), async (req, res, next) => {
  try {
    res.json({ success: true, data: await statusPageService.update(req, await resolveActor(req), idParam(req), req.body) });
  } catch (err) { next(err); }
});

router.delete('/status-pages/:id', async (req, res, next) => {
  try {
    await statusPageService.remove(req, await resolveActor(req), idParam(req));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

export default router;
