import crypto from 'crypto';
import { RECOVERY_CODE_COUNT } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Secrets of the self-service identity flows. Pure (unit tested in
// secrets.test.ts):
//   - e-mailed links carry a 256-bit random token (base64url); only its
//     sha256 is stored (user_action_tokens.token_hash);
//   - recovery codes: 10 characters of a 31-symbol alphabet without look-alikes
//     (≈ 49.5 bits each, rate limited at sign-in), shown as xxxxx-xxxxx; the
//     stored hash is bound to the user (sha256 of "user id : normalised code").
// ─────────────────────────────────────────────────────────────────────────────

export function newLinkToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** sha256 hex of a link token; null when it cannot be one of ours (no lookup is made). */
export function linkTokenHash(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(t)) return null;
  return crypto.createHash('sha256').update(t).digest('hex');
}

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const RECOVERY_LENGTH = 10;

export function newRecoveryCode(): string {
  let s = '';
  for (let i = 0; i < RECOVERY_LENGTH; i++) s += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

export function newRecoveryCodes(n: number = RECOVERY_CODE_COUNT): string[] {
  const out = new Set<string>();
  while (out.size < n) out.add(newRecoveryCode());
  return [...out];
}

/** Lower case, spaces and dashes removed; null when it cannot be a recovery code. */
export function normalizeRecoveryCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.toLowerCase().replace(/[\s-]+/g, '');
  if (s.length !== RECOVERY_LENGTH) return null;
  for (const ch of s) if (!RECOVERY_ALPHABET.includes(ch)) return null;
  return s;
}

export function recoveryCodeHash(userId: number, raw: unknown): string | null {
  const code = normalizeRecoveryCode(raw);
  if (code === null) return null;
  return crypto.createHash('sha256').update(`${userId}:${code}`).digest('hex');
}

/** Does this look like a recovery code rather than a 6-digit TOTP code? */
export function looksLikeRecoveryCode(raw: unknown): boolean {
  return normalizeRecoveryCode(raw) !== null;
}
