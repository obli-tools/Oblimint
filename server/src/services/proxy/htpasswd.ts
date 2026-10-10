import crypto from 'crypto';
import { sha512Crypt } from '../mail/passwords';

// ─────────────────────────────────────────────────────────────────────────────
// Basic-auth users of the access lists (invariant PX4): only a SHA512-CRYPT
// hash (`$6$<salt>$<86 chars>`, implicit 5000 rounds — the form glibc and
// musl crypt(3) both accept: nginx alpine, risk R-HTPASSWD-HASH) is stored,
// never the password, and the hash is never returned by the API.
// ─────────────────────────────────────────────────────────────────────────────

const SALT_ALPHABET = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const ACCESS_PASSWORD_MIN = 8;
export const ACCESS_PASSWORD_MAX = 256;

export function hashAccessPassword(password: string): string {
  const bytes = crypto.randomBytes(16);
  let salt = '';
  for (let i = 0; i < 16; i++) salt += SALT_ALPHABET[bytes[i] & 0x3f];
  return sha512Crypt(password, salt, null);
}

/** Verify (tests / future login checks): recompute with the stored salt. */
export function verifyAccessPassword(password: string, hash: string): boolean {
  const m = /^\$6\$((?:rounds=[0-9]+\$)?[./0-9A-Za-z]{1,16})\$/.exec(hash);
  if (!m) return false;
  const roundsMatch = /^rounds=([0-9]+)\$(.*)$/.exec(m[1]);
  const computed = roundsMatch ? sha512Crypt(password, roundsMatch[2], Number(roundsMatch[1])) : sha512Crypt(password, m[1], null);
  const a = Buffer.from(computed);
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
