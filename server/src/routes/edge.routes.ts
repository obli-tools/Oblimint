import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import { auditService } from '../services/audit.service';
import { certificateService } from '../services/edge/certificate.service';
import { edgeService } from '../services/edge/edge.service';
import { logger } from '../utils/logger';

// /api/system/edge — OWNED BY MODULE `edge` (docs/P1-PLAN.md §API).
// Platform admin only (mounted behind requireAuth + requireRole('admin')).
//   GET  /         → EdgeStatus
//   POST /sync     → EdgeSyncResult
//   PUT  /settings { acmeDirectory: 'production' | 'staging' } → EdgeStatus
//        (switch to production → renewal pass replacing staging certificates)
const router = Router();

const settingsSchema = z.object({ acmeDirectory: z.enum(['production', 'staging']) }).strict();

router.get('/', async (_req, res, next) => {
  try { res.json({ success: true, data: await edgeService.status() }); } catch (err) { next(err); }
});

router.post('/sync', async (req, res, next) => {
  try {
    const result = await edgeService.syncNow({ force: true });
    await auditService.logReq(req, 'edge.sync', { resourceType: 'settings', details: { ok: result.ok, vhostCount: result.vhostCount } });
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

router.put('/settings', async (req, res, next) => {
  try {
    const parsed = settingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new AppError(400, 'acmeDirectory must be "production" or "staging"');
    const before = await edgeService.acmeDirectory();
    await edgeService.setAcmeDirectory(parsed.data.acmeDirectory);
    if (before !== parsed.data.acmeDirectory) {
      await auditService.logReq(req, 'settings.changed', {
        resourceType: 'settings', resourcePath: 'acme_directory', details: { from: before, to: parsed.data.acmeDirectory },
      });
      // staging → production: replace the (untrusted) staging certificates now
      // (domains, panel, previews) instead of waiting for their renewal window.
      // production → staging never replaces a trusted certificate.
      if (parsed.data.acmeDirectory === 'production') {
        certificateService.checkRenewals().catch((err) => logger.warn({ err: (err as Error).message }, 'edge: renewal pass after ACME directory switch failed'));
      }
    }
    res.json({ success: true, data: await edgeService.status() });
  } catch (err) { next(err); }
});

export default router;
