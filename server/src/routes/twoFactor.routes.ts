import { Router } from 'express';
import { twoFactorController } from '../controllers/twoFactor.controller';
import { requireAuth } from '../middleware/auth';
import { attachSessionTenant } from '../middleware/tenant';
import { mfaLimiter, mfaAccountLimiter, stepUpLimiter } from '../middleware/rateLimiter';

const router = Router({ caseSensitive: true }); // force_2fa allow-list (sessionUserGuard.ts): exact paths
router.use(attachSessionTenant);

// Signed-in: manage one's own TOTP.
router.get('/status', requireAuth, twoFactorController.status);
router.post('/totp/setup', requireAuth, stepUpLimiter, twoFactorController.totpSetup);
router.post('/totp/enable', requireAuth, stepUpLimiter, twoFactorController.totpEnable);
router.delete('/totp', requireAuth, stepUpLimiter, twoFactorController.totpDisable);       // Obliance path
router.post('/totp/disable', requireAuth, stepUpLimiter, twoFactorController.totpDisable); // P0-PLAN alias
// One-time recovery codes (lost authenticator): count, new batch (step-up).
router.get('/recovery-codes', requireAuth, twoFactorController.recoveryStatus);
router.post('/recovery-codes', requireAuth, stepUpLimiter, twoFactorController.recoveryGenerate);
// E-mail codes are not offered by Oblimint (P0).
router.post('/email/setup', requireAuth, twoFactorController.emailUnavailable);
router.post('/email/enable', requireAuth, twoFactorController.emailUnavailable);
router.delete('/email', requireAuth, twoFactorController.emailUnavailable);
router.post('/resend-email', mfaLimiter, twoFactorController.emailUnavailable);

// Pending sign-in (session has pendingMfaUserId).
router.post('/verify', mfaLimiter, mfaAccountLimiter, twoFactorController.verify);

export default router;
