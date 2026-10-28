import type { MailDnsFixItem } from '@oblimint/shared';
import { db } from '../../../db';
import { generatedAuto, zoneForName, zoneRecords, type Db, type DnsContext, type ZoneRow } from '../../dns/store';
import { expectedRecordsOf, loadMailPlatformContext, type MailDomainView } from './domains';
import { buildFixPlan } from './fixPlan';

// ─────────────────────────────────────────────────────────────────────────────
// DB reads of the mail DNS fix (fixPlan.ts is the pure part): the zone holding
// the mail domain (closest zone of its account, as the zone contributor), its
// stored rows, the auto records the contributors generate for it, and the
// expected records of the mail domain. Every read goes through `conn` (the
// apply runs it inside the zone transaction).
// ─────────────────────────────────────────────────────────────────────────────

export interface FixState {
  zone: ZoneRow | null;
  /** Empty when there is no zone or it is not hosted here. */
  items: MailDnsFixItem[];
}

export async function fixState(v: MailDomainView, dnsCtx: DnsContext, conn: Db = db): Promise<FixState> {
  const zone = await zoneForName(v.name, v.accountId, conn);
  if (!zone || zone.kind !== 'hosted') return { zone, items: [] };
  const mctx = await loadMailPlatformContext(conn === db ? undefined : conn);
  const specs = (await expectedRecordsOf([v], mctx, conn)).get(v.id) ?? [];
  const rows = await zoneRecords(zone.id, conn);
  const generated = await generatedAuto(zone, dnsCtx, conn);
  const items = buildFixPlan({
    zone: zone.name,
    defaultTtl: zone.default_ttl,
    domain: v.name,
    specs,
    rows: rows.map((r) => ({
      id: r.id, name: r.name, type: r.type, content: r.content, ttl: r.ttl, priority: r.priority, origin: r.origin, disabled: !!r.disabled, expiresAt: r.expires_at,
    })),
    generated,
  });
  return { zone, items };
}
