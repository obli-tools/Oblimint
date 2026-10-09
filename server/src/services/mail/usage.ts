import { db } from '../../db';
import { notify } from '../usage/notifications.service';
import type { MailDriver } from './driver';

// ─────────────────────────────────────────────────────────────────────────────
// Mailbox usage (docs/P4-PLAN.md §9.1): driver.usage() every 15 min ⇒
// mailboxes.used_bytes / usage_checked_at, mail_domains.used_bytes (sum of
// its measured mailboxes). A mailbox at ≥ 90 % of its quota ⇒
// notify('mail.quotaWarning') once (quota_warned_at); re-armed under 80 %.
// ─────────────────────────────────────────────────────────────────────────────

export const QUOTA_WARN_RATIO = 0.9;
export const QUOTA_REARM_RATIO = 0.8;

/** What to do with the warning flag of one mailbox: 'warn' (notify + set), 'rearm' (clear), null (nothing). */
export function quotaWarningAction(usedBytes: number, quotaMb: number | null, warned: boolean): 'warn' | 'rearm' | null {
  if (quotaMb === null || quotaMb <= 0) return warned ? 'rearm' : null;
  const ratio = usedBytes / (quotaMb * 1024 * 1024);
  if (ratio >= QUOTA_WARN_RATIO && !warned) return 'warn';
  if (ratio < QUOTA_REARM_RATIO && warned) return 'rearm';
  return null;
}

export async function pollMailUsage(driver: MailDriver, now = new Date()): Promise<{ updated: number; warned: number }> {
  if (!driver.capabilities.quotaUsage) return { updated: 0, warned: 0 };
  const usage = await driver.usage();
  const byAddress = new Map(usage.map((u) => [u.address.toLowerCase(), u]));
  if (byAddress.size === 0) return { updated: 0, warned: 0 };
  const rows = await db('mailboxes as m')
    .join('mail_domains as md', 'md.id', 'm.mail_domain_id')
    .select('m.id', 'm.tenant_id', 'm.account_id', 'm.mail_domain_id', 'm.address', 'm.quota_mb', 'm.quota_warned_at') as Array<{
      id: number; tenant_id: number; account_id: number; mail_domain_id: number; address: string; quota_mb: number | null; quota_warned_at: Date | string | null;
    }>;
  let updated = 0;
  let warned = 0;
  const perDomain = new Map<number, number>();
  for (const r of rows) {
    const u = byAddress.get(r.address);
    if (!u) continue;
    const used = Math.max(0, Math.round(Number(u.usedBytes) || 0));
    perDomain.set(r.mail_domain_id, (perDomain.get(r.mail_domain_id) ?? 0) + used);
    const action = quotaWarningAction(used, r.quota_mb, r.quota_warned_at !== null);
    const patch: Record<string, unknown> = { used_bytes: used, usage_checked_at: now };
    if (action === 'warn') {
      patch.quota_warned_at = now;
      const pct = Math.round((used / ((r.quota_mb ?? 1) * 1048576)) * 100);
      notify('mail.quotaWarning', {
        tenantId: r.tenant_id,
        accountId: r.account_id,
        key: `mail:quota:${r.id}`,
        title: `Boîte mail presque pleine : ${r.address}`,
        message: `La boîte ${r.address} utilise ${pct} % de son quota (${r.quota_mb} Mio).`,
        severity: 'warning',
        link: `/mail/mailboxes/${r.id}`,
      });
      warned++;
    } else if (action === 'rearm') {
      patch.quota_warned_at = null;
    }
    await db('mailboxes').where({ id: r.id }).update(patch);
    updated++;
  }
  for (const [domainId, bytes] of perDomain) {
    await db('mail_domains').where({ id: domainId }).update({ used_bytes: bytes });
  }
  return { updated, warned };
}
