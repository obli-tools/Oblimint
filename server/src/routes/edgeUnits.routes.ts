import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import { edgeUnitsService, type EdgeUnitQuery } from '../services/edge/edgeUnits.service';
import { EDGE_UNIT_OWNER_KINDS, EDGE_UNIT_STATUSES } from '../services/edge/unitTypes';
import { resolveActor } from '../services/hosting/access';
import { UNIT_ID_RE } from '../services/edge/units';

// Edge configuration units — OWNED BY MODULE `edge-robustness` (docs/P4b-PLAN.md §6.4).
//
// Tenant router, mounted on /edge:
//   GET    /units?accountId&tenantId&status        → EdgeUnitState[]   (read: units of the visible accounts; errors as a
//                                                                        generic label for a client, A6)
// Platform admin, mounted on /system/edge AFTER edge.routes.ts (no catch-all there):
//   GET    /units?status&accountId                 → EdgeUnitState[]   (full nginx -t / lint / probe output)
//   POST   /units/:unitId/retry                    → EdgeUnitState     (re-validate + apply that unit now)
//   GET    /applies?limit                          → EdgeApplyRecord[]
//   POST   /rollback                               → EdgeApplyRecord   (back to the previous good snapshot, audited)

const router = Router();

const optionalId = z.preprocess((v) => (v === undefined || v === '' ? undefined : Number(v)), z.number().int().positive().optional());

const querySchema = z.object({
  accountId: optionalId,
  tenantId: optionalId,
  status: z.enum(EDGE_UNIT_STATUSES as [string, ...string[]]).optional(),
  ownerKind: z.enum(EDGE_UNIT_OWNER_KINDS as [string, ...string[]]).optional(),
}).passthrough();

function parseQuery(raw: unknown): EdgeUnitQuery {
  const parsed = querySchema.safeParse(raw ?? {});
  if (!parsed.success) throw new AppError(400, 'Invalid query', 'validation');
  const q = parsed.data;
  return {
    accountId: q.accountId ?? null,
    tenantId: q.tenantId ?? null,
    status: (q.status ?? null) as EdgeUnitQuery['status'],
    ownerKind: (q.ownerKind ?? null) as EdgeUnitQuery['ownerKind'],
  };
}

router.get('/units', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await edgeUnitsService.listUnits(actor, parseQuery(req.query)) });
  } catch (err) { next(err); }
});

export const systemEdgeUnitsRoutes = Router();

systemEdgeUnitsRoutes.get('/units', async (req, res, next) => {
  try {
    res.json({ success: true, data: await edgeUnitsService.listUnits(null, parseQuery(req.query)) });
  } catch (err) { next(err); }
});

systemEdgeUnitsRoutes.post('/units/:unitId/retry', async (req, res, next) => {
  try {
    const unitId = String(req.params.unitId ?? '');
    if (!UNIT_ID_RE.test(unitId)) throw new AppError(404, 'Edge unit not found', 'notFound');
    res.json({ success: true, data: await edgeUnitsService.retry(req, unitId) });
  } catch (err) { next(err); }
});

systemEdgeUnitsRoutes.get('/applies', async (req, res, next) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    res.json({ success: true, data: await edgeUnitsService.listApplies(Number.isFinite(limit) ? limit : 50) });
  } catch (err) { next(err); }
});

systemEdgeUnitsRoutes.post('/rollback', async (req, res, next) => {
  try {
    res.json({ success: true, data: await edgeUnitsService.rollback(req) });
  } catch (err) { next(err); }
});

export default router;
