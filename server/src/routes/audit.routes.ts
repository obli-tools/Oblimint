import { Router, type Request } from 'express';
import { isMasterTenant } from '@oblimint/shared';
import { requireAnyTenantCapability } from '../middleware/rbac';
import { auditService } from '../services/audit.service';
import { db } from '../db';

// /api/audit-log (Obliance path) and /api/audit (P0-PLAN alias), tenant router.
// Read: platform admin, or the `audit.read` capability. Append-only: no DELETE.
const router = Router();
router.use(requireAnyTenantCapability('audit.read'));

// Cross-tenant feed: platform admin on the master tenant only (N1).
const globalView = (req: Request): boolean => req.session.role === 'admin' && isMasterTenant(req.tenantId);
const int = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const date = (v: unknown): Date | undefined => {
  if (!v || typeof v !== 'string') return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : undefined);

// GET ?action=user.&userId=&apiKeyId=&since=&until=&search=&resourceType=&limit=100&offset=0&filterTenantId=
router.get('/', async (req, res, next) => {
  try {
    const { items, total } = await auditService.list({
      tenantId: req.tenantId,
      action: str(req.query.action),
      userId: int(req.query.userId),
      apiKeyId: int(req.query.apiKeyId),
      resourceType: str(req.query.resourceType),
      search: str(req.query.search),
      since: date(req.query.since),
      until: date(req.query.until),
      limit: int(req.query.limit) ?? 100,
      offset: int(req.query.offset) ?? 0,
      filterTenantId: int(req.query.filterTenantId),
      globalView: globalView(req),
    });
    res.json({ success: true, data: { items, total } });
  } catch (err) { next(err); }
});

router.get('/distinct-actions', async (req, res, next) => {
  try {
    const q = db('audit_logs').distinct('action').orderBy('action', 'asc');
    const filter = int(req.query.filterTenantId);
    if (!globalView(req)) q.where({ tenant_id: req.tenantId });
    else if (filter !== undefined) q.where({ tenant_id: filter });
    const rows = await q;
    res.json({ success: true, data: rows.map((r: any) => r.action) });
  } catch (err) { next(err); }
});

// Access keys seen in the log, for the "Key" filter.
router.get('/distinct-keys', async (req, res, next) => {
  try {
    const data = await auditService.distinctApiKeys({
      tenantId: req.tenantId,
      filterTenantId: int(req.query.filterTenantId),
      globalView: globalView(req),
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

export default router;
