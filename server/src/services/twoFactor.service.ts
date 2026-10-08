import crypto from 'crypto';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { config } from '../config';
import { db } from '../db';
import { logger } from '../utils/logger';

/** TOTP period (s) and accepted drift, in steps (±30 s). */
export const TOTP_PERIOD_S = 30;
export const TOTP_WINDOW = 1;

/** sha256 of the session id — the only form ever stored. */
export function hashSessionId(sessionId: string | undefined | null): string {
  const sid = sessionId ? String(sessionId) : crypto.randomBytes(16).toString('hex');
  return crypto.createHash('sha256').update(sid).digest('hex');
}

/**
 * TOTP anti-replay (Obliance acceptTotpStep, 'strict' mode): one atomic
 * UPDATE that accepts `step` only if it is newer than every step already
 * accepted for this user. A code can therefore never be used twice (sign-in,
 * enabling, disabling, step-ups). totp_last_step never goes backwards.
 */
export async function acceptTotpStep(userId: number, step: number, sessionHash: string): Promise<boolean> {
  if (!Number.isSafeInteger(step) || step <= 0) return false;
  const r = await db.raw(
    `UPDATE users SET totp_last_step = ?, totp_last_session = ?
      WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)
      RETURNING id`,
    [step, sessionHash, userId, step],
  ) as { rows: unknown[] };
  return r.rows.length > 0;
}

export const twoFactorService = {
  generateTotpSecret(username: string): { secret: string; uri: string } {
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({ issuer: config.appName, label: username, algorithm: 'SHA1', digits: 6, period: TOTP_PERIOD_S, secret });
    return { secret: secret.base32, uri: totp.toString() };
  },

  async generateTotpQr(uri: string): Promise<string> {
    return QRCode.toDataURL(uri);
  },

  /** ABSOLUTE time step the code matched (feeds acceptTotpStep), or null. */
  verifyTotpStep(secret: string, code: string, window: number = TOTP_WINDOW, nowMs: number = Date.now()): number | null {
    const token = String(code ?? '').trim();
    if (!/^\d{6}$/.test(token)) return null;
    try {
      const totp = new OTPAuth.TOTP({
        issuer: config.appName, algorithm: 'SHA1', digits: 6, period: TOTP_PERIOD_S,
        secret: OTPAuth.Secret.fromBase32(secret.trim()),
      });
      const delta = totp.validate({ token, timestamp: nowMs, window });
      if (delta === null) return null;
      return Math.floor(nowMs / 1000 / TOTP_PERIOD_S) + delta;
    } catch (err) {
      logger.warn({ err }, 'TOTP verification threw (secret may be malformed)');
      return null;
    }
  },
};
