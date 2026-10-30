import { Router, type Request, type Response, type NextFunction } from 'express';
import { PASSWORD_RESET_TTL_MINUTES, type PasswordResetRequested } from '@oblimint/shared';
import { authController } from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { authLimiter, identityLinkLimiter, passwordResetRequestLimiter } from '../middleware/rateLimiter';
import { loginSchema } from '../validators/auth.schema';
import { identityService } from '../services/identity/identity.service';
import { clientIp } from '../utils/clientIp';
import { logger } from '../utils/logger';

const router = Router({ caseSensitive: true }); // like every router of /auth and /api (app.ts)

router.post('/login', authLimiter, validate(loginSchema), authController.login);
router.post('/logout', requireAuth, authController.logout);
router.get('/me', requireAuth, authController.me);
router.get('/permissions', requireAuth, authController.permissions);

// ── Self-service identity (public: no session needed) ───────────────────────

/** Fixed answer time of a reset request, whatever happens behind (no enumeration through timing). */
let resetAnswerDelay = (): number => 400 + Math.floor(Math.random() * 200);
/** Tests: answer immediately (null restores). */
export function setResetAnswerDelayForTests(fn: (() => number) | null): void {
  resetAnswerDelay = fn ?? (() => 400 + Math.floor(Math.random() * 200));
}

/**
 * POST /api/auth/password-reset { email } — always the same 200 after the
 * same delay: the lookup, the link and the e-mail run behind the answer
 * (local accounts with a verified address only; never an Obligate account).
 */
router.post('/password-reset', passwordResetRequestLimiter, (req: Request, res: Response) => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  identityService.requestPasswordReset(email, clientIp(req) || null)
    .catch((err) => logger.warn({ err: (err as Error).message }, 'password reset request failed'));
  const data: PasswordResetRequested = { accepted: true, ttlMinutes: PASSWORD_RESET_TTL_MINUTES };
  setTimeout(() => res.json({ success: true, data }), resetAnswerDelay());
});

/** POST /api/auth/password-reset/validate { token } → { valid } (the link is not used up). */
router.post('/password-reset/validate', identityLinkLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const state = await identityService.passwordResetTokenState((req.body as { token?: unknown } | undefined)?.token);
    // A wrong token counts against the limiter (skipSuccessfulRequests).
    res.status(state.valid ? 200 : 400).json({ success: state.valid, data: state, ...(state.valid ? {} : { error: 'This link is invalid or has expired', code: 'invalidToken' }) });
  } catch (err) { next(err); }
});

/** POST /api/auth/password-reset/confirm { token, newPassword } — every session of the account ends. */
router.post('/password-reset/confirm', identityLinkLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as { token?: unknown; newPassword?: unknown };
    const r = await identityService.confirmPasswordReset(body.token, body.newPassword, clientIp(req) || null);
    res.json({ success: true, data: r });
  } catch (err) { next(err); }
});

/** POST /api/auth/email-change/confirm { token } — the link sent to a new address (or to an unverified one). */
router.post('/email-change/confirm', identityLinkLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await identityService.confirmEmailChange((req.body as { token?: unknown } | undefined)?.token, clientIp(req) || null);
    res.json({ success: true, data: r });
  } catch (err) { next(err); }
});

export default router;
