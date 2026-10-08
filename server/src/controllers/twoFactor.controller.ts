import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { regenerateSession } from '../utils/session';
import { clientIp } from '../utils/clientIp';
import { twoFactorService, acceptTotpStep, hashSessionId } from '../services/twoFactor.service';
import { checkFactorManagement, sendStepUpFailure } from '../services/stepUp';
import { authService } from '../services/auth.service';
import { auditService } from '../services/audit.service';
import { tenantService, refuseSignInWithoutTenant } from '../services/tenant.service';
import { AppError } from '../middleware/errorHandler';

// TOTP only in P0 (no e-mail codes, no device keys). Same routes and shapes
// as Obliance (/api/profile/2fa/*); the e-mail routes answer 400.

async function auditSelf(req: Request, action: string, details?: Record<string, unknown>): Promise<void> {
  const userId = req.session.userId;
  const tenantId = (req as any).tenantId ?? req.session.currentTenantId;
  if (!userId || !tenantId) return;
  await auditService.log({
    tenantId, userId, action, resourceType: 'user', resourcePath: String(userId), details, ipAddress: clientIp(req) || undefined,
  });
}

function clearPendingTotp(req: Request): void {
  delete req.session.pendingTotpSecret;
  delete req.session.pendingTotpExpiresAt;
  delete req.session.pendingTotpReplaces;
}

export const twoFactorController = {
  async status(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await authService.getUserById(req.session.userId!);
      if (!user) throw new AppError(401, 'User not found');
      res.json({ success: true, data: { totpEnabled: user.totpEnabled, emailOtpEnabled: false, email: user.email ?? null } });
    } catch (err) { next(err); }
  },

  /** Step 1: secret + QR kept in the session (10 min). Needs the step-up proof. */
  async totpSetup(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const row = await db('users').where({ id: req.session.userId! })
        .first('username', 'totp_enabled', 'totp_secret') as { username: string; totp_enabled: boolean; totp_secret: string | null } | undefined;
      if (!row) throw new AppError(401, 'User not found');
      const step = await checkFactorManagement(req, 'profile.totp_manage');
      if (!step.ok) { sendStepUpFailure(res, step); return; }
      const { secret, uri } = twoFactorService.generateTotpSecret(row.username);
      const qrDataUrl = await twoFactorService.generateTotpQr(uri);
      req.session.pendingTotpSecret = secret;
      req.session.pendingTotpExpiresAt = Date.now() + 10 * 60 * 1000;
      req.session.pendingTotpReplaces = !!(row.totp_enabled && row.totp_secret);
      res.json({ success: true, data: { secret, qrDataUrl } });
    } catch (err) { next(err); }
  },

  /** Step 2: a code of the new secret enables it (its step is recorded: never reusable). */
  async totpEnable(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const code = String((req.body as { code?: unknown })?.code ?? '');
      const secret = req.session.pendingTotpSecret;
      if (!secret) throw new AppError(400, 'No pending TOTP setup. Call /setup first.');
      if (Date.now() > (req.session.pendingTotpExpiresAt ?? 0)) {
        clearPendingTotp(req);
        throw new AppError(400, 'TOTP setup expired. Call /setup again.');
      }
      const step = twoFactorService.verifyTotpStep(secret, code);
      if (step === null) throw new AppError(400, 'Invalid code');
      const sh = hashSessionId(req.sessionID);
      const upd = db('users').where({ id: req.session.userId });
      // A setup started without a live TOTP must not overwrite one enabled meanwhile.
      if (!req.session.pendingTotpReplaces) {
        upd.where((q) => q.where('totp_enabled', false).orWhereNull('totp_secret'));
      }
      const updated = await upd.update({
        totp_secret: secret,
        totp_enabled: true,
        totp_last_session: db.raw('CASE WHEN totp_last_step IS NULL OR totp_last_step < ? THEN ? ELSE totp_last_session END', [step, sh]),
        totp_last_step: db.raw('GREATEST(COALESCE(totp_last_step, ?), ?)', [step, step]),
        updated_at: new Date(),
      });
      const replaced = !!req.session.pendingTotpReplaces;
      clearPendingTotp(req);
      if (!updated) throw new AppError(409, 'Two-factor authentication was enabled in the meantime. Start the setup again.');
      await auditSelf(req, replaced ? 'user.totp_replaced' : 'user.totp_enabled');
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /** DELETE /totp (Obliance) and POST /totp/disable: a current code is required. */
  async totpDisable(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const row = await db('users').where({ id: req.session.userId }).first('totp_enabled', 'totp_secret');
      const hadTotp = !!(row?.totp_enabled && row?.totp_secret);
      if (!hadTotp) { res.json({ success: true }); return; }
      const step = await checkFactorManagement(req, 'profile.totp_manage');
      if (!step.ok) { sendStepUpFailure(res, step); return; }
      await db('users').where({ id: req.session.userId }).update({ totp_secret: null, totp_enabled: false, updated_at: new Date() });
      await auditSelf(req, 'user.totp_disabled');
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  emailUnavailable(_req: Request, _res: Response, next: NextFunction): void {
    next(new AppError(400, 'E-mail codes are not available on this server'));
  },

  /** POST /verify {code, method:'totp'} — completes a pending sign-in. */
  async verify(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code, method } = (req.body ?? {}) as { code?: unknown; method?: unknown };
      const userId = req.session.pendingMfaUserId;
      if (!userId) throw new AppError(400, 'No pending 2FA session');
      if (method !== undefined && method !== 'totp') throw new AppError(401, 'Invalid code');
      const row = await db('users').where({ id: userId, is_active: true })
        .first('id', 'username', 'role', 'totp_secret', 'totp_enabled') as
        { id: number; username: string; role: string; totp_secret: string | null; totp_enabled: boolean } | undefined;
      if (!row) throw new AppError(400, 'User not found');
      if (!row.totp_enabled || !row.totp_secret) throw new AppError(401, 'Invalid code');

      const preLoginHash = hashSessionId(req.sessionID);
      const step = twoFactorService.verifyTotpStep(row.totp_secret, String(code ?? ''));
      const valid = step !== null && await acceptTotpStep(row.id, step, preLoginHash);
      if (!valid) throw new AppError(401, 'Invalid code');

      const sessionTenantId = await tenantService.sessionTenantFor(row.id, row.role);
      if (sessionTenantId === null) {
        await regenerateSession(req);
        throw await refuseSignInWithoutTenant(req, row, 'password+totp');
      }
      // Complete the session under a NEW id (session fixation).
      await regenerateSession(req);
      req.session.userId = row.id;
      req.session.username = row.username;
      req.session.role = row.role;
      req.session.currentTenantId = sessionTenantId;
      await db('users').where({ id: row.id, totp_last_step: step, totp_last_session: preLoginHash })
        .update({ totp_last_session: hashSessionId(req.sessionID) });
      await auditSelf(req, 'auth.login', { username: row.username, via: 'password+totp' });
      const user = await authService.getUserById(row.id);
      res.json({ success: true, data: { user } });
    } catch (err) { next(err); }
  },
};
