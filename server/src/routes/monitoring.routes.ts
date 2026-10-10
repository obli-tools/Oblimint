import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { idParam, resolveActor } from '../services/hosting/access';
import { appStatsService, type AppStatsRange } from '../services/monitoring/appStats.service';
import { trafficService } from '../services/monitoring/traffic/traffic.service';

// /api/monitoring — OWNED BY MODULE `monitoring-automation` (docs/P4b-PLAN.md §6.6). Tenant router.
//   GET    /traffic?accountId&tenantId&range                   → ProxyTrafficOverviewRow[]  (read, scoped)
//   GET    /traffic/:proxyHostId?range&status=4xx|5xx          → ProxyTrafficReport         (read on the host)
//   GET    /apps/:stackId/stats?range=1h|6h|24h|7d             → AppStatsResponse           (read on the stack)

const router = Router();

const optId = z.coerce.number().int().positive().optional();
const trafficRange = z.enum(['1h', '6h', '24h', '7d', '30d', '90d']).default('24h');

const overviewQuery = z.object({ accountId: optId, tenantId: optId, range: trafficRange });

router.get('/traffic', validate(overviewQuery, 'query'), async (req, res, next) => {
  try {
    const q = req.query as unknown as z.infer<typeof overviewQuery>;
    res.json({ success: true, data: await trafficService.overview(await resolveActor(req), q) });
  } catch (err) { next(err); }
});

const reportQuery = z.object({ range: trafficRange, status: z.enum(['4xx', '5xx']).optional() });

router.get('/traffic/:proxyHostId', validate(reportQuery, 'query'), async (req, res, next) => {
  try {
    const q = req.query as unknown as z.infer<typeof reportQuery>;
    res.json({ success: true, data: await trafficService.report(await resolveActor(req), idParam(req, 'proxyHostId'), q.range, q.status ?? null) });
  } catch (err) { next(err); }
});

const statsQuery = z.object({ range: z.enum(['1h', '6h', '24h', '7d']).default('1h') });

router.get('/apps/:stackId/stats', validate(statsQuery, 'query'), async (req, res, next) => {
  try {
    const q = req.query as unknown as { range: AppStatsRange };
    res.json({ success: true, data: await appStatsService.stats(await resolveActor(req), idParam(req, 'stackId'), q.range) });
  } catch (err) { next(err); }
});

export default router;
