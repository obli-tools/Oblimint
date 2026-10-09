import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { MailPasswordScheme } from '@oblimint/shared';
import { MAIL_PASSWORD_SCHEMES } from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';

// ─────────────────────────────────────────────────────────────────────────────
// Mail password hashes, Dovecot-compatible (docs/P4-PLAN.md §9.2) — ARCHITECT
// FILE, IMPLEMENTED (consumed by mail-core, webmail, outbound-security; owned
// by mail-core for fixes / additions, signatures frozen).
//
// Storage format = Dovecot's: '{SCHEME}<hash>'. New passwords are always
// {SHA512-CRYPT}$6$rounds=…$<salt>$<hash> (crypt(3), Drepper's SHA-crypt),
// which Postfix (via Dovecot SASL), Dovecot and Stalwart all verify. Imported
// hashes (CWP keeps MD5-CRYPT / SHA512-CRYPT in its postfix DB, other panels
// bcrypt or SSHA) are stored AS IS with their scheme: no reset needed.
// The clear password is never stored, never logged, never returned except the
// generated one, once.
// ─────────────────────────────────────────────────────────────────────────────

const B64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const SHA_CRYPT_DEFAULT_ROUNDS = 5000;
const ROUNDS_MIN = 1000;
const ROUNDS_MAX = 999_999_999;
/** Length bounds of a clear mail password (UTF-8 bytes for the upper one). */
export const MAIL_PASSWORD_MIN = 10;
export const MAIL_PASSWORD_MAX_BYTES = 256;

function b64From24(b2: number, b1: number, b0: number, n: number): string {
  let w = (b2 << 16) | (b1 << 8) | b0;
  let out = '';
  for (let i = 0; i < n; i++) {
    out += B64[w & 0x3f];
    w >>>= 6;
  }
  return out;
}

function repeatTo(src: Buffer, len: number): Buffer {
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = src[i % src.length];
  return out;
}

/** Drepper's SHA-crypt ($5$ / $6$). `salt` ≤ 16 chars from the crypt alphabet. */
function shaCrypt(variant: 256 | 512, password: string, salt: string, rounds: number | null): string {
  const algo = variant === 512 ? 'sha512' : 'sha256';
  const hashLen = variant === 512 ? 64 : 32;
  const key = Buffer.from(password, 'utf8');
  const s = Buffer.from(salt.slice(0, 16), 'utf8');
  const r = rounds === null ? SHA_CRYPT_DEFAULT_ROUNDS : Math.min(ROUNDS_MAX, Math.max(ROUNDS_MIN, rounds));

  const db = crypto.createHash(algo).update(key).update(s).update(key).digest();
  const a = crypto.createHash(algo).update(key).update(s);
  a.update(repeatTo(db, key.length));
  for (let n = key.length; n > 0; n >>= 1) a.update(n & 1 ? db : key);
  let da = a.digest();

  const dpH = crypto.createHash(algo);
  for (let i = 0; i < key.length; i++) dpH.update(key);
  const p = repeatTo(dpH.digest(), key.length);

  const dsH = crypto.createHash(algo);
  for (let i = 0; i < 16 + da[0]; i++) dsH.update(s);
  const sb = repeatTo(dsH.digest(), s.length);

  for (let i = 0; i < r; i++) {
    const c = crypto.createHash(algo);
    c.update(i & 1 ? p : da);
    if (i % 3) c.update(sb);
    if (i % 7) c.update(p);
    c.update(i & 1 ? da : p);
    da = c.digest();
  }

  let enc = '';
  if (variant === 512) {
    const order = [
      [0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26], [6, 27, 48], [28, 49, 7], [50, 8, 29], [9, 30, 51],
      [31, 52, 10], [53, 11, 32], [12, 33, 54], [34, 55, 13], [56, 14, 35], [15, 36, 57], [37, 58, 16], [59, 17, 38], [18, 39, 60],
      [40, 61, 19], [62, 20, 41],
    ];
    for (const [x, y, z] of order) enc += b64From24(da[x], da[y], da[z], 4);
    enc += b64From24(0, 0, da[63], 2);
  } else {
    const order = [[0, 10, 20], [21, 1, 11], [12, 22, 2], [3, 13, 23], [24, 4, 14], [15, 25, 5], [6, 16, 26], [27, 7, 17], [18, 28, 8], [9, 19, 29]];
    for (const [x, y, z] of order) enc += b64From24(da[x], da[y], da[z], 4);
    enc += b64From24(0, da[31], da[30], 3);
  }
  void hashLen;
  const prefix = variant === 512 ? '$6$' : '$5$';
  return `${prefix}${rounds === null ? '' : `rounds=${r}$`}${s.toString('utf8')}$${enc}`;
}

/** crypt(3) MD5 ($1$), verification of imported CWP hashes. */
function md5Crypt(password: string, salt: string): string {
  const key = Buffer.from(password, 'utf8');
  const s = Buffer.from(salt.slice(0, 8), 'utf8');
  const magic = Buffer.from('$1$');
  const alt = crypto.createHash('md5').update(key).update(s).update(key).digest();
  const ctx = crypto.createHash('md5').update(key).update(magic).update(s);
  for (let pl = key.length; pl > 0; pl -= 16) ctx.update(alt.subarray(0, Math.min(16, pl)));
  for (let i = key.length; i; i >>= 1) ctx.update(i & 1 ? Buffer.from([0]) : key.subarray(0, 1));
  let fin = ctx.digest();
  for (let i = 0; i < 1000; i++) {
    const c = crypto.createHash('md5');
    c.update(i & 1 ? key : fin);
    if (i % 3) c.update(s);
    if (i % 7) c.update(key);
    c.update(i & 1 ? fin : key);
    fin = c.digest();
  }
  let enc = '';
  for (const [x, y, z] of [[0, 6, 12], [1, 7, 13], [2, 8, 14], [3, 9, 15], [4, 10, 5]]) enc += b64From24(fin[x], fin[y], fin[z], 4);
  enc += b64From24(0, 0, fin[11], 2);
  return `$1$${s.toString('utf8')}$${enc}`;
}

/** SHA512-CRYPT of `password` with `salt` ('$6$…' form). rounds null = implicit 5000 (no rounds= field). */
export function sha512Crypt(password: string, salt: string, rounds: number | null = null): string {
  return shaCrypt(512, password, salt, rounds);
}

export function sha256Crypt(password: string, salt: string, rounds: number | null = null): string {
  return shaCrypt(256, password, salt, rounds);
}

export { md5Crypt };

function randomSalt(len = 16): string {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += B64[bytes[i] & 0x3f];
  return out;
}

/** New stored hash: '{SHA512-CRYPT}$6$rounds=5000$<16-char salt>$<86 chars>'. */
export function hashMailPassword(password: string): { hash: string; scheme: MailPasswordScheme } {
  return { hash: `{SHA512-CRYPT}${sha512Crypt(password, randomSalt(16), SHA_CRYPT_DEFAULT_ROUNDS)}`, scheme: 'SHA512-CRYPT' };
}

/** Random password for a mailbox / relay / webmail session (base64url, ≥ 128 bits). */
export function generateMailPassword(bytes = 18): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** 400 weakPassword / passwordTooLong; refuses control characters (they would break passwd-file / config formats). */
export function assertMailPasswordAcceptable(password: string): void {
  if (typeof password !== 'string' || password.length < MAIL_PASSWORD_MIN) {
    throw new AppError(400, `The password must have at least ${MAIL_PASSWORD_MIN} characters`, 'weakPassword', { min: MAIL_PASSWORD_MIN });
  }
  if (Buffer.byteLength(password, 'utf8') > MAIL_PASSWORD_MAX_BYTES) throw new AppError(400, 'The password is too long', 'passwordTooLong');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(password)) throw new AppError(400, 'The password contains control characters', 'invalidPassword');
}

const CRYPT_SALT = '[./0-9A-Za-z]{1,16}';
const SCHEME_PATTERNS: Array<[MailPasswordScheme, RegExp]> = [
  ['SHA512-CRYPT', new RegExp(`^\\$6\\$(rounds=\\d{4,9}\\$)?${CRYPT_SALT}\\$[./0-9A-Za-z]{86}$`)],
  ['SHA256-CRYPT', new RegExp(`^\\$5\\$(rounds=\\d{4,9}\\$)?${CRYPT_SALT}\\$[./0-9A-Za-z]{43}$`)],
  ['MD5-CRYPT', /^\$1\$[./0-9A-Za-z]{1,8}\$[./0-9A-Za-z]{22}$/],
  ['BLF-CRYPT', /^\$2[abxy]\$\d{2}\$[./0-9A-Za-z]{53}$/],
  ['SSHA512', /^[A-Za-z0-9+/]{88,}={0,2}$/],
  ['SSHA256', /^[A-Za-z0-9+/]{44,}={0,2}$/],
  ['SSHA', /^[A-Za-z0-9+/]{28,}={0,2}$/],
];

/**
 * Validates an imported hash and returns it in storage form. Accepts
 * '{SCHEME}hash' (Dovecot) or a bare crypt(3) hash ($6$ / $5$ / $1$ / $2y$:
 * scheme inferred). {PLAIN} / {CLEARTEXT} / unknown schemes → 400
 * invalidPasswordHash (never stored).
 */
export function normalizeImportedHash(input: string): { hash: string; scheme: MailPasswordScheme } {
  const raw = String(input ?? '').trim();
  const bad = () => new AppError(400, 'Unsupported or malformed password hash', 'invalidPasswordHash', { schemes: MAIL_PASSWORD_SCHEMES });
  if (!raw || raw.length > 512 || /\s/.test(raw)) throw bad();
  const m = /^\{([A-Z0-9-]+)\}(.+)$/.exec(raw);
  if (m) {
    // Dovecot {CRYPT}: a crypt(3) hash whose scheme is its own $id$ prefix.
    if (m[1] === 'CRYPT' && m[2].startsWith('$')) return normalizeImportedHash(m[2]);
    let scheme = m[1] as MailPasswordScheme;
    // Dovecot aliases.
    if ((m[1] as string) === 'CRYPT' || (m[1] as string) === 'BLF') scheme = m[2].startsWith('$2') ? 'BLF-CRYPT' : scheme;
    const pattern = SCHEME_PATTERNS.find(([s]) => s === scheme);
    if (!pattern || !pattern[1].test(m[2])) throw bad();
    return { hash: `{${scheme}}${m[2]}`, scheme };
  }
  for (const scheme of ['SHA512-CRYPT', 'SHA256-CRYPT', 'MD5-CRYPT', 'BLF-CRYPT'] as const) {
    const pattern = SCHEME_PATTERNS.find(([s]) => s === scheme)!;
    if (pattern[1].test(raw)) return { hash: `{${scheme}}${raw}`, scheme };
  }
  throw bad();
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function sshaVerify(algo: 'sha1' | 'sha256' | 'sha512', password: string, b64: string): boolean {
  const raw = Buffer.from(b64, 'base64');
  const len = algo === 'sha1' ? 20 : algo === 'sha256' ? 32 : 64;
  if (raw.length <= len) return false;
  const digest = raw.subarray(0, len);
  const salt = raw.subarray(len);
  const computed = crypto.createHash(algo).update(Buffer.from(password, 'utf8')).update(salt).digest();
  return crypto.timingSafeEqual(digest, computed);
}

/**
 * Verifies a clear password against a stored '{SCHEME}hash' (tests, CWP import
 * checks, future panel-side logins). Engines verify on their own at login.
 */
export function verifyMailPassword(password: string, stored: string): boolean {
  const m = /^\{([A-Z0-9-]+)\}(.+)$/.exec(String(stored ?? ''));
  if (!m) return false;
  const [, scheme, hash] = m;
  try {
    switch (scheme) {
      case 'SHA512-CRYPT':
      case 'SHA256-CRYPT': {
        const p = /^\$([56])\$(?:rounds=(\d+)\$)?([^$]{0,16})\$/.exec(hash);
        if (!p) return false;
        const rounds = p[2] ? Number(p[2]) : null;
        const out = shaCrypt(p[1] === '6' ? 512 : 256, password, p[3], rounds);
        return constantTimeEqual(out, hash);
      }
      case 'MD5-CRYPT': {
        const p = /^\$1\$([^$]{0,8})\$/.exec(hash);
        return !!p && constantTimeEqual(md5Crypt(password, p[1]), hash);
      }
      case 'BLF-CRYPT':
        return bcrypt.compareSync(password, hash.replace(/^\$2y\$/, '$2b$'));
      case 'SSHA512': return sshaVerify('sha512', password, hash);
      case 'SSHA256': return sshaVerify('sha256', password, hash);
      case 'SSHA': return sshaVerify('sha1', password, hash);
      default: return false;
    }
  } catch {
    return false;
  }
}
