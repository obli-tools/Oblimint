import { Router, type Request } from 'express';
import { z } from 'zod';
import type { NetworkLinkCreate, NetworkLinkUpdate } from '@oblimint/shared';
import { AppError } from '../middleware/errorHandler';
import { parseBody } from '../services/docker/parseBody';
import { idParam, resolveActor } from '../services/hosting/access';
import { loadOwned } from '../services/hosting/p4bAccess';
import { segmentService } from '../services/network/segments.service';

// /api/network (tenant) + /api/system/network (platform admin) — OWNED BY MODULE `segmentation`
// (docs/P4b-PLAN.md §6.2).
//
// Tenant router (requireAuth + requireTenant):
//   GET    /segments?accountId                                  → NetworkSegmentInfo[]   (read)
//   GET    /links?accountId&tenantId                            → NetworkLink[]          (read, scoped)
//   POST   /links                      NetworkLinkCreate        → NetworkLink (201)      (apps.manage on accountId; both ends in that account)
//   PUT    /links/:id                  NetworkLinkUpdate        → NetworkLink            (apps.manage)
//   DELETE /links/:id                                           → { deleted: true }      (apps.manage)
// Platform admin (mounted on /system/network behind requireRole('admin')):
//   GET    /                                                    → NetworkSystemStatus
//   POST   /sync                                                → NetworkSystemStatus    (push the policy now)
//   POST   /migrate                    NetworkMigrateRequest    → NetworkSystemStatus    (audited)
//   GET    /flows?accountId                                     → NetworkFlowView[]      (troubleshooting)
//
// Codes: linkInvalidEndpoint (400: unknown / other account / same segment / site as target), linkPortNotExposed (400:
// app target port not exposed), linkExists (409), planLimit (409, details.dimension networkLinks — 100 per account),
// poolExhausted (507), hostdUnavailable (502, A6).

const router = Router();

const serviceName = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/);
const segmentRef = z.object({
  kind: z.enum(['site', 'app', 'db']),
  id: z.number().int().positive(),
  service: serviceName.nullable().optional(),
}).strict();

export const linkCreateSchema = z.object({
  accountId: z.number().int().positive(),
  source: segmentRef,
  target: segmentRef,
  protocol: z.enum(['tcp', 'udp']).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  description: z.string().trim().max(255).nullable().optional(),
}).strict();

export const linkUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  description: z.string().trim().max(255).nullable().optional(),
  port: z.number().int().min(1).max(65535).optional(),
}).strict();

export const migrateSchema = z.object({
  accountId: z.number().int().positive().optional(),
}).strict();

/** Optional positive integer query parameter (absent / empty = null; anything else invalid = 400). */
function queryId(req: Request, name: string): number | null {
  const raw = req.query[name];
  if (raw === undefined || raw === '') return null;
  const v = Number(raw);
  if (!Number.isInteger(v) || v <= 0) throw new AppError(400, `Invalid ${name}`, 'validation');
  return v;
}

router.get('/segments', async (req, res, next) => {
  try {
    const accountId = queryId(req, 'accountId');
    if (accountId === null) throw new AppError(400, 'accountId is required', 'validation');
    res.json({ success: true, data: await segmentService.segments(await resolveActor(req), accountId) });
  } catch (err) { next(err); }
});

router.get('/links', async (req, res, next) => {
  try {
    res.json({ success: true, data: await segmentService.listLinks(await resolveActor(req), { accountId: queryId(req, 'accountId'), tenantId: queryId(req, 'tenantId') }) });
  } catch (err) { next(err); }
});

router.post('/links', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    // The account is in the body: the service loads it (404 / 403) before resolving the ends.
    const input = parseBody(linkCreateSchema, req.body) as NetworkLinkCreate;
    res.status(201).json({ success: true, data: await segmentService.createLink(req, actor, input) });
  } catch (err) { next(err); }
});

router.put('/links/:id', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const id = idParam(req);
    // Access check BEFORE the body (an invisible link is a 404 whatever the body).
    await loadOwned(actor, 'network_links', id, 'apps.manage', 'Network link');
    const input = parseBody(linkUpdateSchema, req.body) as NetworkLinkUpdate;
    res.json({ success: true, data: await segmentService.updateLink(req, actor, id, input) });
  } catch (err) { next(err); }
});

router.delete('/links/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await segmentService.deleteLink(req, await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

export const systemNetworkRoutes = Router();

systemNetworkRoutes.get('/', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await segmentService.systemStatus() });
  } catch (err) { next(err); }
});

systemNetworkRoutes.post('/sync', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await segmentService.syncNow() });
  } catch (err) { next(err); }
});

systemNetworkRoutes.post('/migrate', async (req, res, next) => {
  try {
    res.json({ success: true, data: await segmentService.migrate(req, parseBody(migrateSchema, req.body)) });
  } catch (err) { next(err); }
});

systemNetworkRoutes.get('/flows', async (req, res, next) => {
  try {
    res.json({ success: true, data: await segmentService.flows(queryId(req, 'accountId') ?? 0) });
  } catch (err) { next(err); }
});

export default router;
