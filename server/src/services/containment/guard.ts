import crypto from 'crypto';
import { ACCOUNT_CONTAINED_CODE } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';

// The barrier of a contained account (containment.service.ts). Kept apart from
// the service: the credential checks and the access layer import it, and it
// imports nothing of theirs.

export function accountContained(): AppError {
  return new AppError(423, 'This account is contained after a security incident: access is suspended until the staff lifts the containment', ACCOUNT_CONTAINED_CODE);
}

export async function isAccountContained(accountId: number): Promise<boolean> {
  const row = await db('hosting_accounts').where({ id: accountId }).first('contained_at') as { contained_at: Date | string | null } | undefined;
  return !!row?.contained_at;
}

/** 423 while contained, whoever asks: nothing that opens a way in is created during an incident (staff included: lift first). */
export async function assertNotContained(accountId: number): Promise<void> {
  if (await isAccountContained(accountId)) throw accountContained();
}

export function credentialHash(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Is this raw credential one that a containment still in force revoked? Its
 * holder gets 423 instead of 401: an agent stops and tells its human, it does
 * not retry nor count as an attack on the key surfaces. Only a holder of the
 * real secret can learn it.
 */
export async function credentialContained(raw: string): Promise<boolean> {
  if (!raw || raw.length > 256) return false;
  const row = await db('containment_credentials as c')
    .join('account_containments as k', 'k.id', 'c.containment_id')
    .where('c.token_hash', credentialHash(raw)).whereNot('k.status', 'lifted')
    .first('c.containment_id');
  return !!row;
}
