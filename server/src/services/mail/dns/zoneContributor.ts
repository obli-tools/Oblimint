import type { Knex } from 'knex';
import { db } from '../../../db';
import { logger } from '../../../utils/logger';
import type { DnsZoneRef, ZoneRecordContributor } from '../../dns/contributors';
import { inZone, type GeneratedRecord } from '../../dns/records';
import { expectedRecordsOf, loadMailPlatformContext, mailDomainViews, type MailDomainView } from './domains';
import { mergeRecords, stripP2Placeholders, zoneRecordsOf } from './records';

// ─────────────────────────────────────────────────────────────────────────────
// DNS zone contributor 'mail' (docs/P4-PLAN.md §7, §9.3), registered by
// mailDnsService.start() on dns/contributors.ts. For every ACCOUNT zone:
//   - the P2 placeholders (apex MX / `v=spf1 mx -all` / `_dmarc` p=none) go;
//   - every ACTIVE mail domain whose closest zone of its account is this one
//     (apex or a subdomain without its own zone) gets its records, relative
//     to the zone, zone TTL, each one through dns/records.validateRecord (D2:
//     an invalid record is dropped and logged, never published).
// A domain without mail, disabled, unverified (D1 / MA10) or of an account
// being deleted gets no mail record at all. DB reads only, deterministic.
// ─────────────────────────────────────────────────────────────────────────────

/** Mail domains whose records live in `zone` (same account; closest zone of that account). */
export async function mailDomainsOfZone(zone: Pick<DnsZoneRef, 'name' | 'accountId'>, conn: Knex | Knex.Transaction = db): Promise<MailDomainView[]> {
  const escaped = zone.name.replace(/[\\%_]/g, (c) => `\\${c}`);
  const views = await mailDomainViews((q) => q.where('md.account_id', zone.accountId)
    .andWhere((w) => w.where('md.name', zone.name).orWhere('md.name', 'like', `%.${escaped}`)), conn);
  if (views.length === 0) return [];
  const accountZones = (await conn('dns_zones').where({ account_id: zone.accountId }).select('name') as Array<{ name: string }>).map((z) => z.name);
  return views.filter((v) => {
    if (!inZone(v.name, zone.name)) return false;
    const closest = accountZones.filter((z) => inZone(v.name, z)).sort((a, b) => b.length - a.length)[0];
    return closest === undefined || closest === zone.name;
  });
}

export const mailZoneContributor: ZoneRecordContributor = {
  id: 'mail',
  async contribute(zone: DnsZoneRef, base: GeneratedRecord[], conn?: Knex | Knex.Transaction): Promise<GeneratedRecord[]> {
    // Often called inside the zone transaction of the dns module: read through `conn` only.
    const stripped = stripP2Placeholders(base);
    const views = (await mailDomainsOfZone(zone, conn ?? db)).filter((v) => v.active);
    if (views.length === 0) return stripped;
    const ctx = await loadMailPlatformContext(conn);
    const expected = await expectedRecordsOf(views, ctx, conn ?? db);
    const ours: GeneratedRecord[] = [];
    for (const v of views) {
      const { records, rejected } = zoneRecordsOf(expected.get(v.id) ?? [], zone.name, zone.defaultTtl);
      for (const r of rejected) {
        logger.warn({ zone: zone.name, mailDomain: v.name, record: `${r.spec.fqdn} ${r.spec.type}`, err: r.error }, 'mail dns: record refused by validation (not published)');
      }
      ours.push(...records);
    }
    return mergeRecords(stripped, ours);
  },
};
