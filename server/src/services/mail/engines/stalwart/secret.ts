import crypto from 'crypto';
import { appConfigService } from '../../../appConfig.service';
import { logger } from '../../../../utils/logger';
import { openJson, sealJson, SecretBoxError } from '../../../../utils/secretBox';
import { sha512Crypt } from '../../passwords';
import { ADMIN_SECRET_CONFIG } from './constants';

// ─────────────────────────────────────────────────────────────────────────────
// Admin credentials of the Stalwart API (MA4): a random 256-bit secret
// generated once, sealed with secretBox('mail-admin') in app_config
// `mail.stalwart_admin` together with its SHA512-CRYPT hash (the only form the
// container ever sees, through its environment). Never logged, never returned
// by any route. A value that cannot be unsealed (rotated SESSION_SECRET) is
// replaced: the next ensure() recreates the container with the new hash.
// ─────────────────────────────────────────────────────────────────────────────

export interface StalwartAdminSecret {
  secret: string;
  hash: string;
}

const SALT_ALPHABET = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function newSalt(): string {
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (const b of bytes) out += SALT_ALPHABET[b & 0x3f];
  return out;
}

/** Fresh credentials (not stored). */
export function generateAdminSecret(): StalwartAdminSecret {
  const secret = crypto.randomBytes(32).toString('base64url');
  return { secret, hash: sha512Crypt(secret, newSalt(), 5000) };
}

/** The stored credentials, or null (never created / unreadable). */
export async function readAdminSecret(): Promise<StalwartAdminSecret | null> {
  const raw = await appConfigService.get(ADMIN_SECRET_CONFIG);
  if (!raw) return null;
  try {
    const v = openJson<StalwartAdminSecret>('mail-admin', raw);
    if (typeof v?.secret === 'string' && v.secret.length >= 32 && typeof v.hash === 'string' && v.hash.startsWith('$6$')) return v;
    return null;
  } catch (err) {
    if (err instanceof SecretBoxError) {
      logger.warn('mail: the Stalwart admin secret cannot be unsealed (SESSION_SECRET changed?): a new one is generated at the next deployment');
      return null;
    }
    return null;
  }
}

/** Existing credentials, or new ones (sealed and stored). */
export async function ensureAdminSecret(): Promise<StalwartAdminSecret> {
  const existing = await readAdminSecret();
  if (existing) return existing;
  const fresh = generateAdminSecret();
  await appConfigService.set(ADMIN_SECRET_CONFIG, sealJson('mail-admin', fresh));
  return fresh;
}
