import crypto from 'crypto';
import { config } from '../config';

// ─────────────────────────────────────────────────────────────────────────────
// Sealed secrets stored in the panel database (docs/P2-PLAN.md §Secrets):
// database instance superuser passwords, notification channel secrets
// (SMTP password, webhook header, Discord URL, Telegram token), the PowerDNS
// API key. AES-256-GCM, key = HKDF-SHA256(SESSION_SECRET, info = purpose).
// Format: 'v1:' + base64url(iv[12] | tag[16] | ciphertext).
//
// Rotating SESSION_SECRET makes every sealed value unreadable: open() then
// throws SecretBoxError and the owning module must regenerate (DB instances:
// reset the superuser password through the container; channels: ask again).
// ─────────────────────────────────────────────────────────────────────────────

export type SecretPurpose = 'db-root' | 'notification' | 'pdns-api' | 'dbadmin'
  // P3: shared key of the scanner API (scand, X-Oblimint-Scanner-Key).
  | 'scanner';

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

function keyFor(purpose: SecretPurpose): Buffer {
  // The public fallback is for development / tests only: in production a
  // value sealed without SESSION_SECRET (e.g. during the setup wizard, before
  // the config step) would be protected by a known key and lost at the next
  // boot — refuse instead.
  if (!config.sessionSecret && !config.isDev) throw new SecretBoxError('SESSION_SECRET is not set: nothing can be sealed or opened yet');
  const secret = config.sessionSecret || 'oblimint-dev';
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('oblimint-secretbox-v1', 'utf8'),
    Buffer.from(`oblimint:${purpose}`, 'utf8'), 32));
}

/** Seals a UTF-8 string for `purpose` (a value sealed for one purpose never opens for another). */
export function seal(purpose: SecretPurpose, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(purpose), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url')}`;
}

/** Opens a sealed value. Throws SecretBoxError (wrong purpose, rotated secret, tampering). */
export function open(purpose: SecretPurpose, sealed: string): string {
  if (typeof sealed !== 'string' || !sealed.startsWith('v1:')) throw new SecretBoxError('not a sealed value');
  const raw = Buffer.from(sealed.slice(3), 'base64url');
  if (raw.length < 28) throw new SecretBoxError('sealed value too short');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(purpose), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretBoxError('sealed value cannot be opened (rotated SESSION_SECRET or tampering)');
  }
}

/** Seals a JSON value. */
export function sealJson(purpose: SecretPurpose, value: unknown): string {
  return seal(purpose, JSON.stringify(value));
}

/** Opens a JSON value sealed with sealJson. */
export function openJson<T>(purpose: SecretPurpose, sealed: string): T {
  return JSON.parse(open(purpose, sealed)) as T;
}
