import { Router } from 'express';
import { heavyOpLimiter } from '../middleware/rateLimiter';
import { auditService } from '../services/audit.service';
import { dnsService } from '../services/dns/dns.service';

// /api/system/dns — OWNED BY MODULE `dns` (docs/P2-PLAN.md §6.1). Platform admin only
// (mounted behind requireAuth + requireRole('admin')).
//   GET  /       → DnsServerStatus
//   POST /sync   → DnsServerStatus (re-render and push every zone)
const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await dnsService.status() });
  } catch (err) { next(err); }
});

router.post('/sync', heavyOpLimiter, async (req, res, next) => {
  try {
    const data = await dnsService.syncAllNow('manual');
    await auditService.logReq(req, 'dns.server.sync', { resourceType: 'dnsServer', details: { lastSyncError: data.lastSyncError } });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

export default router;
