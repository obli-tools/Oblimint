import { ACTION_TRUSTED_IP_HOURS } from '@oblimint/shared';
import { db } from '../db';

// ─────────────────────────────────────────────────────────────────────────────
// "Trust this IP for 24 h" (Obliance 069_tfa_trusted_sessions /
// tfaTrust.service.ts, owner decision 6): after a successful code for a
// SENSITIVE panel action, with the box ticked, the (user, ip) pair skips the
// prompt of the next sensitive panel actions for 24 h. Never honoured for an
// access key / connector, a confirmation of a pending action, an approval,
// nor a 'restricted' action carrying a secret. Per (user, ip), not per tenant:
// the code proves who is at the keyboard. Revoked with the user's sessions.
// ─────────────────────────────────────────────────────────────────────────────

/** IPv4-mapped IPv6 normalised so v4 and v6 hits of one machine share an entry. */
export function normalizeTrustIp(ip: string): string {
  const s = String(ip ?? '').trim().toLowerCase();
  return s.startsWith('::ffff:') && s.includes('.') ? s.slice(7) : s;
}

export const tfaTrustService = {
  async isTrusted(userId: number, ip: string): Promise<boolean> {
    const addr = normalizeTrustIp(ip);
    if (!userId || !addr) return false;
    try {
      const row = await db('tfa_trusted_sessions').where({ user_id: userId, ip_address: addr }).andWhere('trusted_until', '>', new Date()).first('id');
      return !!row;
    } catch {
      return false;
    }
  },

  async grant(userId: number, ip: string, hours: number = ACTION_TRUSTED_IP_HOURS): Promise<void> {
    const addr = normalizeTrustIp(ip);
    if (!userId || !addr || hours <= 0) return;
    const until = new Date(Date.now() + hours * 3600_000);
    try {
      await db('tfa_trusted_sessions').insert({ user_id: userId, ip_address: addr.slice(0, 64), trusted_until: until })
        .onConflict(['user_id', 'ip_address']).merge({ trusted_until: until });
    } catch { /* re-prompted next time */ }
  },

  /** Every trust entry of a user (2FA changed, password reset, sign-out everywhere). */
  async revokeAllForUser(userId: number): Promise<void> {
    try { await db('tfa_trusted_sessions').where({ user_id: userId }).delete(); } catch { /* best effort */ }
  },

  async sweepExpired(): Promise<number> {
    try { return Number(await db('tfa_trusted_sessions').where('trusted_until', '<', new Date()).delete()) || 0; } catch { return 0; }
  },
};
