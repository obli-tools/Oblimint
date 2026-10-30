import type { Request, Response } from 'express';
import { RECOVERY_LOGIN_GRACE_MINUTES } from '@oblimint/shared';
import { db } from '../db';
import { comparePassword } from '../utils/crypto';
import { clientAddress } from '../utils/clientIp';
import { tfaTrustService } from './tfaTrust.service';
import { acceptTotpStep, hashSessionId, TOTP_PERIOD_S, twoFactorService } from './twoFactor.service';
import { isLocalAccount } from './userRow';

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
    if (!proof.twoFactorCode && RECOVERY_GRACE_ACTIONS.has(actionKey) && recoveryGraceActive(req) && isLocalAccount(row)) {
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

  if (!isLocalAccount(row) || !row.password_hash) {
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

// ── Sensitive actions (services/restrictions/gate.ts) ────────────────────────
//
// A FRESH second factor of the user of the session, never a password:
//   - local TOTP: a code never seen before (acceptTotpStep, strict);
//   - Obligate SSO staff without local TOTP: the code is checked by Obligate
//     (owner decision 3); a code accepted this way marks the next step as used
//     locally, so the same code cannot serve twice here. Only while Obligate
//     can check codes (URL + key stored) and the account is not known to lack
//     a TOTP there (users.sso_totp_enabled false); Obligate answering "TOTP
//     not configured" records it and answers twoFactorNotEnrolled;
//   - no factor at all: 403 twoFactorNotEnrolled, inviting to enable it (never
//     a silent block; recovery codes are never a proof here);
//   - wrong codes are capped per user whatever the route (files routes skip
//     the API limiter): STEP_UP_MAX_FAILURES in STEP_UP_FAILURE_WINDOW_MS,
//     then 429 stepUpLocked until the window ends;
//   - trusted IP (24 h, owner decision 6): only when the caller allows it
//     (a 'sensitive' panel action), never for a confirmation, an approval, an
//     access key, nor a 'restricted' action carrying a secret.

export type ActionStepUpOutcome =
  | { ok: true; via: 'totp' | 'obligate_totp' | 'trusted_ip' }
  | { ok: false; status: number; body: Record<string, unknown> };

export interface ActionStepUpOptions {
  allowTrustedIp?: boolean;
}

export const TWO_FACTOR_NOT_ENROLLED_MESSAGE =
  'This action needs two-factor authentication: enable it in your profile (Profile > Security), then try again.';

export const SSO_TWO_FACTOR_NOT_ENROLLED_MESSAGE =
  'This action needs two-factor authentication: enable it on your Obligate account (or in your profile here), then try again.';

// ── wrong-code cap of the action step-ups (in memory: one panel process) ─────

export const STEP_UP_MAX_FAILURES = 10;
export const STEP_UP_FAILURE_WINDOW_MS = 15 * 60_000;
const failures = new Map<number, { count: number; resetAt: number }>();

function lockedFor(userId: number, now = Date.now()): number {
  const f = failures.get(userId);
  if (!f) return 0;
  if (f.resetAt <= now) { failures.delete(userId); return 0; }
  return f.count >= STEP_UP_MAX_FAILURES ? Math.ceil((f.resetAt - now) / 1000) : 0;
}

function noteFailure(userId: number, now = Date.now()): void {
  const f = failures.get(userId);
  if (!f || f.resetAt <= now) failures.set(userId, { count: 1, resetAt: now + STEP_UP_FAILURE_WINDOW_MS });
  else f.count += 1;
  if (failures.size > 10_000) {
    for (const [k, v] of failures) if (v.resetAt <= now) failures.delete(k);
  }
}

/** Tests: forget every wrong-code count. */
export function resetStepUpFailuresForTests(): void {
  failures.clear();
}

function lockedOutcome(retryAfterSec: number): ActionStepUpOutcome {
  return {
    ok: false, status: 429,
    body: { success: false, error: 'Too many invalid 2FA codes, try again later', code: 'stepUpLocked', retryAfterSec },
  };
}

function invalidCode(userId: number): ActionStepUpOutcome {
  noteFailure(userId);
  return { ok: false, status: 401, body: { success: false, error: 'Invalid 2FA code' } };
}

function notEnrolledOutcome(actionKey: string, sso: boolean): ActionStepUpOutcome {
  return {
    ok: false, status: 403,
    body: {
      success: false, error: sso ? SSO_TWO_FACTOR_NOT_ENROLLED_MESSAGE : TWO_FACTOR_NOT_ENROLLED_MESSAGE, code: 'twoFactorNotEnrolled',
      action: actionKey, details: { action: actionKey, enrollPath: '/profile' },
    },
  };
}

async function noteSsoTotp(userId: number, enabled: boolean): Promise<void> {
  try { await db('users').where({ id: userId }).update({ sso_totp_enabled: enabled }); } catch { /* informational */ }
}

export async function checkActionStepUp(req: Request, actionKey: string, opts: ActionStepUpOptions = {}): Promise<ActionStepUpOutcome> {
  const userId = req.session?.userId;
  if (!userId || req.apiKey) return { ok: false, status: 401, body: { success: false, error: 'Authentication required' } };
  const user = await db('users').where({ id: userId })
    .first('is_active', 'kind', 'totp_enabled', 'totp_secret', 'foreign_source', 'foreign_id', 'sso_totp_enabled') as {
      is_active: boolean; kind: string; totp_enabled: boolean; totp_secret: string | null; foreign_source: string | null; foreign_id: number | null;
      sso_totp_enabled: boolean | null;
    } | undefined;
  if (!user || !user.is_active) return { ok: false, status: 401, body: { success: false, error: 'Authentication required' } };
  const hasLocalTotp = !!(user.totp_enabled && user.totp_secret);
  const ssoAccount = user.kind !== 'client' && user.foreign_source === 'obligate' && Number(user.foreign_id) > 0;
  let obligateId: number | null = null;
  if (!hasLocalTotp && ssoAccount && user.sso_totp_enabled !== false) {
    const { obligateTotpVerifierReady } = await import('./obligate.service');
    if (await obligateTotpVerifierReady()) obligateId = Number(user.foreign_id);
  }
  if (!hasLocalTotp && obligateId === null) return notEnrolledOutcome(actionKey, ssoAccount);

  // A relay address (our proxy, Docker plumbing) is shared by everyone behind it: never trusted.
  const { ip, relay } = clientAddress(req);
  const allowTrust = opts.allowTrustedIp === true && !!ip && !relay;
  if (allowTrust && await tfaTrustService.isTrusted(userId, ip)) return { ok: true, via: 'trusted_ip' };

  const proof = req.stepUpProof ?? {};
  const code = typeof proof.twoFactorCode === 'string' ? proof.twoFactorCode.trim() : '';
  if (!code) {
    return {
      ok: false, status: 401,
      body: {
        success: false, error: 'twoFactorCode required', twoFactorRequired: true, action: actionKey,
        currentIp: ip || undefined, trustIpAllowed: allowTrust, codeMustBeNew: true,
      },
    };
  }
  const locked = lockedFor(Number(userId));
  if (locked > 0) return lockedOutcome(locked);

  let via: 'totp' | 'obligate_totp';
  if (hasLocalTotp) {
    const step = twoFactorService.verifyTotpStep(user.totp_secret as string, code);
    if (step === null) return invalidCode(Number(userId));
    if (!(await acceptTotpStep(userId, step, hashSessionId(req.sessionID)))) {
      return { ok: false, status: 401, body: { success: false, error: 'This code was already used', codeUsed: true } };
    }
    via = 'totp';
  } else {
    if (!/^\d{6}$/.test(code)) return invalidCode(Number(userId));
    const { obligateService } = await import('./obligate.service');
    const r = await obligateService.verifyTotpDetailed(obligateId as number, code);
    if (r === 'unavailable') {
      return { ok: false, status: 503, body: { success: false, error: 'Two-factor verification is temporarily unavailable', verifierUnavailable: true } };
    }
    if (r === 'notEnrolled') {
      await noteSsoTotp(Number(userId), false);
      return notEnrolledOutcome(actionKey, true);
    }
    if (r !== 'valid') return invalidCode(Number(userId));
    if (user.sso_totp_enabled !== true) await noteSsoTotp(Number(userId), true);
    // Local anti-replay of the Obligate code: the step after the current one is
    // marked used (the code's ±1-step validity), so it never serves twice here.
    if (!(await acceptTotpStep(userId, Math.floor(Date.now() / 1000 / TOTP_PERIOD_S) + 1, hashSessionId(req.sessionID)))) {
      return { ok: false, status: 401, body: { success: false, error: 'This code was already used', codeUsed: true } };
    }
    via = 'obligate_totp';
  }
  if (allowTrust && proof.trustIp === true) await tfaTrustService.grant(userId, ip);
  return { ok: true, via };
}

export function sendStepUpFailure(res: Response, outcome: { status: number; body: Record<string, unknown> }): void {
  res.status(outcome.status).json(outcome.body);
}
