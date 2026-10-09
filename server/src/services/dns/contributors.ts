import type { Knex } from 'knex';
import { logger } from '../../utils/logger';
import type { GeneratedRecord } from './records';

// ─────────────────────────────────────────────────────────────────────────────
// P4 extension point of the DNS auto records (docs/P4-PLAN.md §7) — ARCHITECT
// FILE (frozen). The dns module (store.ts generatedAuto) passes the generic
// auto records of an ACCOUNT zone (A / AAAA of the domains, and — P2 — the
// placeholder MX / SPF / DMARC of an internal mail engine) through every
// registered contributor, in registration order; the result is what the zone
// gets as origin='auto' (manual / template records still override it,
// applyOverrides). Platform zones (account_id null) are not passed.
//
// Contributor: mail-dns-tls (services/mail/dns/zoneContributor.ts), registered
// by mailDnsService.start(): replaces the P2 placeholders by the real mail
// records of the zone's mail domains (MX, SPF, DKIM, DMARC, MTA-STS, TLS-RPT,
// autoconfig / autodiscover, SRV, webmail.<domain>) and strips them for
// domains without mail.
//
// Rules: a contributor is fast (DB reads only, no network), deterministic
// (same rows → same records, else the zone serial churns), returns records
// that pass records.validateRecord for the zone, and never throws on purpose
// (a throw keeps the input list and is logged). `conn` is the caller's
// connection — often a transaction (zone creation / regeneration): every read
// goes through it, never through a second pool connection (integration fix).
// ─────────────────────────────────────────────────────────────────────────────

export interface DnsZoneRef {
  id: number;
  /** Apex FQDN, lower case, no trailing dot. */
  name: string;
  tenantId: number;
  accountId: number;
  /** Domain the zone was created for (null: manual zone). */
  domainId: number | null;
  defaultTtl: number;
  kind: 'hosted' | 'external';
}

export interface ZoneRecordContributor {
  id: string;
  contribute(zone: DnsZoneRef, base: GeneratedRecord[], conn?: Knex | Knex.Transaction): Promise<GeneratedRecord[]>;
}

const contributors: ZoneRecordContributor[] = [];

/** Registers (or replaces, same id) a contributor. */
export function registerZoneRecordContributor(c: ZoneRecordContributor): void {
  const i = contributors.findIndex((x) => x.id === c.id);
  if (i >= 0) contributors[i] = c;
  else contributors.push(c);
}

export function unregisterZoneRecordContributor(id: string): void {
  const i = contributors.findIndex((x) => x.id === id);
  if (i >= 0) contributors.splice(i, 1);
}

/** Tests. */
export function clearZoneRecordContributorsForTests(): void {
  contributors.splice(0, contributors.length);
}

/** Runs every contributor (store.ts generatedAuto). Never throws. */
export async function applyZoneContributors(zone: DnsZoneRef, base: GeneratedRecord[], conn?: Knex | Knex.Transaction): Promise<GeneratedRecord[]> {
  let out = base;
  for (const c of contributors) {
    try {
      const next = await c.contribute(zone, out, conn);
      if (Array.isArray(next)) out = next;
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, contributor: c.id, zone: zone.name }, 'DNS zone record contributor failed: its records are skipped');
    }
  }
  return out;
}
