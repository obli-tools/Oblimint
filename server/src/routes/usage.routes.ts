import { Router, type Request } from 'express';
import { idParam, resolveActor } from '../services/hosting/access';
import { usageQueryService } from '../services/usage/usage.service';

// /api/usage — OWNED BY MODULE `usage` (docs/P2-PLAN.md §6.5).
//   GET  /accounts/:id      ?month=YYYY-MM → AccountUsage     (read)
//   GET  /sites/:id         ?days=1..90 → SiteUsage           (read)
//   GET  /tenant            ?tenantId=&month= → TenantUsage   (staff read; tenantId: god view)
//   GET  /platform          ?month= → PlatformUsage           (platform admin)
//   GET  /alerts            ?accountId=&open=1 → UsageAlert[] (read; scoped)
const router = Router();

const monthQuery = (req: Request): string | null => (typeof req.query.month === 'string' ? req.query.month.slice(0, 16) : null);

const optionalId = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

router.get('/accounts/:id', async (req, res, next) => {
  try {
    const data = await usageQueryService.account(await resolveActor(req), idParam(req), monthQuery(req));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.get('/sites/:id', async (req, res, next) => {
  try {
    const days = typeof req.query.days === 'string' ? Number(req.query.days) : null;
    const data = await usageQueryService.site(await resolveActor(req), idParam(req), days);
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.get('/tenant', async (req, res, next) => {
  try {
    const data = await usageQueryService.tenant(await resolveActor(req), optionalId(req.query.tenantId), monthQuery(req));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.get('/platform', async (req, res, next) => {
  try {
    const data = await usageQueryService.platform(await resolveActor(req), monthQuery(req));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.get('/alerts', async (req, res, next) => {
  try {
    const open = req.query.open === '1' || req.query.open === 'true';
    const data = await usageQueryService.alerts(await resolveActor(req), { accountId: optionalId(req.query.accountId), open });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

export default router;
