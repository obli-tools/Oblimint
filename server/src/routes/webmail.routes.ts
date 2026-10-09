import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { idParam, resolveActor } from '../services/hosting/access';
import { webmailService } from '../services/mail/webmail/webmail.service';

// /api/mail (webmail part) — OWNED BY MODULE `webmail` (docs/P4-PLAN.md §6.7). NO catch-all.
//   POST /mailboxes/:id/webmail-session   → WebmailSsoTicket   (mail.manage on the mailbox's account; 10 / min / user; audit mail.webmail.sso)
// Codes: webmailUnavailable (409: settings mail.webmail = none / container down / no webmail host),
// mailboxDisabled (409), accountSuspended (409), mailEngineNoMailboxes (409).
const router = Router();

const ssoLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `u${(req.session as unknown as { userId?: number } | undefined)?.userId ?? req.ip}`,
});

router.post('/mailboxes/:id/webmail-session', ssoLimiter, async (req, res, next) => {
  try {
    res.json({ success: true, data: await webmailService.openSession(req, await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

export default router;
