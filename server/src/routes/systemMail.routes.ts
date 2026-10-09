import { Router } from 'express';
import { z } from 'zod';
import { MAIL_ENGINES, MASTER_TENANT_ID, type MailEngine } from '@oblimint/shared';
import { validate } from '../middleware/validate';
import { auditService } from '../services/audit.service';
import { mailService } from '../services/mail/mail.service';

// /api/system/mail — OWNED BY MODULE `mail-core` (docs/P4-PLAN.md §6.2).
// Platform admin only (mounted behind requireAuth + requireRole('admin')). NO
// catch-all (systemMailSecurity.routes.ts shares the prefix).
//   GET  /                             → MailSystemStatus
//   POST /sync     { force?: boolean } → MailSystemStatus   (audit mail.sync when force)
//   PUT  /engine   MailEngineChangeRequest → MailSystemStatus (409 mailEngineInUse, 400 mailEngineNotSupported; audit mail.engine)
const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await mailService.systemStatus() });
  } catch (err) { next(err); }
});

router.post('/sync', validate(z.object({ force: z.boolean().optional() }).strict()), async (req, res, next) => {
  try {
    const force = !!req.body.force;
    const data = await mailService.syncNow({ force });
    if (force) await auditService.logReqAs(req, MASTER_TENANT_ID, 'mail.sync', { resourceType: 'mail', resourcePath: 'engine', details: { force } });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.put('/engine', validate(z.object({ engine: z.enum(MAIL_ENGINES as unknown as [MailEngine, ...MailEngine[]]) }).strict()), async (req, res, next) => {
  try {
    res.json({ success: true, data: await mailService.changeEngine(req, req.body.engine) });
  } catch (err) { next(err); }
});

export default router;
