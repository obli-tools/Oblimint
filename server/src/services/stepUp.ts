import type { Request, Response } from 'express';
import { RECOVERY_LOGIN_GRACE_MINUTES } from '@oblimint/shared';
import { db } from '../db';
import { comparePassword } from '../utils/crypto';
import { acceptTotpStep, hashSessionId, twoFactorService } from './twoFactor.service';

// Step-up for adding / replacing / removing a second factor (Obliance P2,
// simplified: no trusted IPs, no device keys, no Obligate TOTP in P0):
//   - the account has a local TOTP → a CURRENT code, never seen before
//     (strict anti-replay), sent as `twoFactorCode`;
//   - otherwise a local account → its CURRENT password, sent as
//     `stepUpPassword`;
//   - an SSO account without local TOTP → refused (managed in Obligate).
// The 401 bodies are the ones the Obliance client interceptor understands
// (twoFactorRequired / passwordRequired → prompt → same request + proof).

export type StepUpOutcome =
  | { ok: true; via: 'totp' | 'password' | 'recovery' }
  | { ok: false; status: number; body: Record<string, unknown> };

/** Step-ups a recent recovery sign-in satisfies: the second factor itself only (never the e-mail, never a password). */
const RECOVERY_GRACE_ACTIONS = new Set(['profile.totp_manage', 'profile.recovery_codes']);

/** The session signed in with a 2FA recovery code less than RECOVERY_LOGIN_GRACE_MINUTES ago. */
export function recoveryGraceActive(req: Request, now: number = Date.now()): boolean {
  const at = Number(req.session?.recoveryLoginAt);
  return Number.isFinite(at) && at > 0 && now - at >= 0 && now - at < RECOVERY_LOGIN_GRACE_MINUTES * 60_000;
}

export async function checkFactorManagement(req: Request, actionKey: string): Promise<StepUpOutcome> {
  const userId = req.session?.userId;
  if (!userId) return { ok: false, status: 401, body: { success: false, error: 'Authentication required' } };
  const row = await db('users').where({ id: userId })
    .first('totp_enabled', 'totp_secret', 'password_hash', 'foreign_source') as {
      totp_enabled: boolean; totp_secret: string | null; password_hash: string | null; foreign_source: string | null;
    } | undefined;
  if (!row) return { ok: false, status: 401, body: { success: false, error: 'Authentication required' } };
  const proof = req.stepUpProof ?? {};

  if (row.totp_enabled && row.totp_secret) {
    // Lost authenticator: a session signed in with a recovery code a few
    // minutes ago may remove / replace it (and regenerate its codes) without
    // a TOTP code it no longer has. Never for an SSO account (no local codes).
    if (!proof.twoFactorCode && RECOVERY_GRACE_ACTIONS.has(actionKey) && recoveryGraceActive(req) && row.foreign_source !== 'obligate') {
      return { ok: true, via: 'recovery' };
    }
    if (!proof.twoFactorCode) {
      return {
        ok: false, status: 401,
        body: { success: false, error: 'twoFactorCode required', twoFactorRequired: true, action: actionKey, trustIpAllowed: false, codeMustBeNew: true },
      };
    }
    const step = twoFactorService.verifyTotpStep(row.totp_secret, proof.twoFactorCode);
    if (step === null) return { ok: false, status: 401, body: { success: false, error: 'Invalid 2FA code' } };
    if (!(await acceptTotpStep(userId, step, hashSessionId(req.sessionID)))) {
      return { ok: false, status: 401, body: { success: false, error: 'This code was already used', codeUsed: true } };
    }
    return { ok: true, via: 'totp' };
  }

  if (row.foreign_source === 'obligate' || !row.password_hash) {
    return {
      ok: false, status: 403,
      body: { success: false, error: 'The two-factor authentication of an SSO account is managed in Obligate.', code: 'ssoTwoFactorManaged' },
    };
  }
  if (!proof.stepUpPassword) {
    return { ok: false, status: 401, body: { success: false, error: 'Current password required', passwordRequired: true, action: actionKey } };
  }
  if (!(await comparePassword(proof.stepUpPassword, row.password_hash))) {
    return { ok: false, status: 401, body: { success: false, error: 'Invalid password', passwordInvalid: true } };
  }
  return { ok: true, via: 'password' };
}

export function sendStepUpFailure(res: Response, outcome: { status: number; body: Record<string, unknown> }): void {
  res.status(outcome.status).json(outcome.body);
}
