import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { idParam } from '../services/hosting/access';
import { mailSecurityService } from '../services/mail/security/mailSecurity.service';

// /api/system/mail (security part) — OWNED BY MODULE `outbound-security`
// (docs/P4-PLAN.md §6.6). Platform admin only (requireAuth + requireRole('admin')).
// NO catch-all (systemMail.routes.ts shares the prefix).
//   GET    /bans          → MailBan[]
//   DELETE /bans/:id      → { deleted: true }        (audit mail.unban)
//   POST   /relay-test    → OpenRelayTestResult      (2 / min; audit mail.relayTest)
const router = Router();

const relayTestLimiter = rateLimit({ windowMs: 60_000, limit: 2, standardHeaders: true, legacyHeaders: false });

router.get('/bans', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await mailSecurityService.listBans() });
  } catch (err) { next(err); }
});

router.delete('/bans/:id', async (req, res, next) => {
  try {
    await mailSecurityService.unban(req, idParam(req));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

router.post('/relay-test', relayTestLimiter, async (req, res, next) => {
  try {
    res.json({ success: true, data: await mailSecurityService.relayTest(req) });
  } catch (err) { next(err); }
});

export default router;
