import type { DomainPendingZone, DomainPendingZoneReason } from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { inZone } from './records';
import { domainRow, loadContext, type DnsContext, type Db, type ZoneDomainRow, type ZoneRow } from './store';

// ─────────────────────────────────────────────────────────────────────────────
// Pending zones (module dns). A domain verifies by a TXT record at its current
// DNS host, or by its delegation to our name servers (NS proof). Some
// registrars refuse to switch a domain to name servers that do not already
// serve its zone with matching NS records — while D1 kept the zone off our
// PowerDNS until the domain was verified: deadlock.
//
// So while a domain is NOT verified, its OWN zone may be served as a PENDING
// zone: SOA + apex NS (our name servers, from the settings) ONLY — no
// address, no mail record, no wildcard, nothing the user typed in the zone
// editor (kept, not published). A squatter gains nothing from it: no traffic,
// no mail, no certificate (ACME needs an ACTIVE zone of a verified domain).
//
// Never for (guard, pendingZoneGuard — TXT method only):
//   - a name that is, or lies inside, a domain / zone of ANOTHER account
//     (shop.example.com when example.com belongs to another account);
//   - a parent of another account's VERIFIED domain or fully served zone;
//   - a name that is, covers or lies inside a platform name (platform zones,
//     panel / preview / DB admin / probe hosts, our name servers).
// Only when the NS proof is on and name servers are configured (the pending
// zone exists for that proof), and within a window: PENDING_ZONE_WINDOW_MS
// from the creation of the domain or from its last manual check (the full
// pass of the DNS worker removes an expired one; a manual check re-opens it).
//
// On verification the full zone replaces it through the normal sync (PATCH,
// serial bumped); on deletion the zone row goes and the queue removes it from
// PowerDNS; the full pass removes any zone D1 no longer publishes.
// ─────────────────────────────────────────────────────────────────────────────

/** How long a pending zone is served after the creation / the last manual check of its domain. */
export const PENDING_ZONE_WINDOW_MS = 30 * 24 * 3600_000;

export type PendingZoneRefusal = 'insideOtherAccount' | 'coversOtherAccount' | 'platformName';

const REFUSALS: ReadonlySet<DomainPendingZoneReason> = new Set<DomainPendingZoneReason>(['insideOtherAccount', 'coversOtherAccount', 'platformName']);

/** What surrounds a candidate name on the platform (other accounts, platform). */
export interface PendingZoneNeighbours {
  /** Candidate zone name (the unverified domain). */
  name: string;
  /** Account of the candidate. */
  accountId: number;
  /** Domains related to the name (any account: the candidate's own are ignored). */
  domains: Array<{ name: string; accountId: number; verified: boolean }>;
  /** Zones related to the name, the candidate's own zone excluded (accountId null = platform zone). */
  zones: Array<{ name: string; accountId: number | null; servedFull: boolean }>;
  /** Host names of the platform (panel, client space, preview domain, DB admin, probes, our name servers). */
  platformHosts: Array<string | null | undefined>;
}

const host = (h: string | null | undefined): string => String(h ?? '').trim().toLowerCase().replace(/\.$/, '');

/**
 * Why a pending zone must never be served for `n.name` (null = allowed).
 * Pure (tests). Platform first, then names inside another account, then names
 * that would cover another account's verified domain / served zone.
 */
export function pendingZoneGuard(n: PendingZoneNeighbours): PendingZoneRefusal | null {
  const name = host(n.name);
  if (!name) return 'platformName';
  const related = (other: string) => !!other && (inZone(name, other) || inZone(other, name));
  for (const h of n.platformHosts) if (related(host(h))) return 'platformName';
  for (const z of n.zones) if (z.accountId === null && related(host(z.name))) return 'platformName';
  const foreignZones = n.zones.filter((z) => z.accountId !== null && z.accountId !== n.accountId);
  const foreignDomains = n.domains.filter((d) => d.accountId !== n.accountId);
  if (foreignZones.some((z) => inZone(name, host(z.name)))) return 'insideOtherAccount';
  if (foreignDomains.some((d) => inZone(name, host(d.name)))) return 'insideOtherAccount';
  if (foreignZones.some((z) => z.servedFull && inZone(host(z.name), name))) return 'coversOtherAccount';
  if (foreignDomains.some((d) => d.verified && inZone(host(d.name), name))) return 'coversOtherAccount';
  return null;
}

/** End of the pending zone window: the creation or the last manual check, whichever is later, + the window. */
export function pendingZoneWindowEnd(createdAt: Date | string, requestedAt: Date | string | null | undefined): Date {
  const created = new Date(createdAt).getTime();
  const requested = requestedAt ? new Date(requestedAt).getTime() : Number.NaN;
  const start = Math.max(Number.isFinite(created) ? created : 0, Number.isFinite(requested) ? requested : 0);
  return new Date(start + PENDING_ZONE_WINDOW_MS);
}

export interface PendingZoneDecision {
  allowed: boolean;
  /** Why not (null when allowed). */
  reason: DomainPendingZoneReason | null;
  /** End of the window (null when the window does not apply). */
  expiresAt: Date | null;
}

export interface EligibilityInput {
  dnsEnabled: boolean;
  allowNsProof: boolean;
  nameservers: string[];
  /** Kind of the domain's OWN zone; null = it has none here. */
  zoneKind: 'hosted' | 'external' | null;
  accountDeleting: boolean;
  guard: PendingZoneRefusal | null;
  windowEnd: Date;
  now: Date;
}

/** May an unverified domain's zone be served as a pending zone? Pure (tests). */
export function pendingZoneEligibility(i: EligibilityInput): PendingZoneDecision {
  const no = (reason: DomainPendingZoneReason, expiresAt: Date | null = null): PendingZoneDecision => ({ allowed: false, reason, expiresAt });
  if (!i.dnsEnabled) return no('dnsDisabled');
  if (!i.allowNsProof || i.nameservers.length === 0) return no('nsProofDisabled');
  if (i.guard) return no(i.guard);
  if (i.zoneKind === null) return no('noZone');
  if (i.zoneKind === 'external') return no('externalZone');
  if (i.accountDeleting) return no('accountDeleting');
  if (i.now.getTime() >= i.windowEnd.getTime()) return no('expired', i.windowEnd);
  return { allowed: true, reason: null, expiresAt: i.windowEnd };
}

/** French label of a refusal / expiry, appended to the zone status message (no ' : ': clients see it whole). */
export function pendingZoneRefusalLabel(reason: DomainPendingZoneReason | null): string | null {
  switch (reason) {
    case 'insideOtherAccount': return "zone d'attente refusée, le nom relève d'un autre compte";
    case 'coversOtherAccount': return "zone d'attente refusée, le nom couvre un domaine vérifié d'un autre compte";
    case 'platformName': return "zone d'attente refusée, nom de la plateforme";
    case 'expired': return "zone d'attente expirée, une vérification manuelle la rouvre";
    default: return null;
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The name and its parents (≥ 2 labels). */
function selfAndParents(name: string): string[] {
  const labels = name.split('.');
  const out: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/** Platform names a pending zone must stay clear of. */
export function platformHostsOf(ctx: DnsContext): string[] {
  const h = ctx.hosts;
  return [h.panelHostname, h.clientPanelHostname ?? null, h.previewDomain, h.dbAdminHostname, h.probeHostV4, h.probeHostV6, ...ctx.settings.nameservers]
    .map(host).filter(Boolean);
}

/** Guard of `name` for `accountId` against the DB (other accounts' domains / zones, platform zones and hosts). */
export async function guardFor(name: string, accountId: number, ownZoneId: number | null, ctx: DnsContext, conn: Db = db): Promise<PendingZoneRefusal | null> {
  const n = host(name);
  const names = selfAndParents(n);
  const below = `%.${escapeLike(n)}`;
  const domains = await conn('domains')
    .where((b) => { b.whereIn('name', names).orWhere('name', 'like', below); })
    .whereNot('account_id', accountId)
    .select('name', 'account_id', 'verification_status') as Array<{ name: string; account_id: number; verification_status: string | null }>;
  const zq = conn('dns_zones')
    .where((b) => { b.whereIn('name', names).orWhere('name', 'like', below); })
    .where((b) => { b.whereNull('account_id').orWhereNot('account_id', accountId); });
  if (ownZoneId !== null) zq.whereNot('id', ownZoneId);
  const zones = await zq.select('name', 'account_id', 'served') as Array<{ name: string; account_id: number | null; served: string | null }>;
  return pendingZoneGuard({
    name: n,
    accountId,
    domains: domains.map((d) => ({ name: d.name, accountId: d.account_id, verified: d.verification_status === 'verified' })),
    zones: zones.map((z) => ({ name: z.name, accountId: z.account_id, servedFull: z.served === 'full' })),
    platformHosts: platformHostsOf(ctx),
  });
}

/**
 * Decision for an unverified domain (`domain`) whose own zone is `zone`
 * (null: none here). Fails closed: a DB error refuses the pending zone.
 */
export async function pendingZoneDecision(
  domain: Pick<ZoneDomainRow, 'id' | 'name' | 'account_id' | 'created_at' | 'verification_requested_at'>,
  zone: Pick<ZoneRow, 'id' | 'kind'> | null,
  ctx: DnsContext,
  opts: { accountStatus: string | null; now?: Date },
  conn: Db = db,
): Promise<PendingZoneDecision> {
  try {
    const guard = await guardFor(domain.name, domain.account_id, zone?.id ?? null, ctx, conn);
    return pendingZoneEligibility({
      dnsEnabled: ctx.settings.enabled,
      allowNsProof: !!ctx.settings.allowNsProof,
      nameservers: ctx.settings.nameservers ?? [],
      zoneKind: zone?.kind ?? null,
      accountDeleting: opts.accountStatus === 'deleting',
      guard,
      windowEnd: pendingZoneWindowEnd(domain.created_at, domain.verification_requested_at),
      now: opts.now ?? new Date(),
    });
  } catch (err) {
    logger.warn({ domain: domain.name, err: (err as Error)?.message }, 'dns: pending zone guard failed, pending zone refused');
    return { allowed: false, reason: null, expiresAt: null };
  }
}

/**
 * Decision for a zone row (sync.ts, rule D1): only the OWN zone of an
 * unverified domain (zone.domain_id, same name) can be a pending zone.
 */
export async function pendingZoneDecisionForZone(zone: ZoneRow, ctx: DnsContext, accountStatus: string | null): Promise<PendingZoneDecision> {
  if (zone.account_id === null || !zone.domain_id) return { allowed: false, reason: 'noZone', expiresAt: null };
  const domain = await domainRow(zone.domain_id);
  if (!domain || domain.name.toLowerCase() !== zone.name || domain.account_id !== zone.account_id) {
    return { allowed: false, reason: 'noZone', expiresAt: null };
  }
  return pendingZoneDecision(domain, zone, ctx, { accountStatus });
}

/** Pending zone view of a domain (DomainVerification.pendingZone): null once verified. Never throws. */
export async function pendingZoneForDomain(
  domain: Pick<ZoneDomainRow, 'id' | 'name' | 'account_id' | 'created_at' | 'verification_requested_at'> & { verification_status: string | null },
): Promise<DomainPendingZone | null> {
  if (domain.verification_status === 'verified') return null;
  try {
    const ctx = await loadContext();
    const zone = await db('dns_zones').where({ domain_id: domain.id, account_id: domain.account_id }).first('id', 'kind', 'status', 'served') as
      Pick<ZoneRow, 'id' | 'kind' | 'status' | 'served'> | undefined;
    const account = await db('hosting_accounts').where({ id: domain.account_id }).first('status') as { status: string } | undefined;
    const d = await pendingZoneDecision(domain, zone ?? null, ctx, { accountStatus: account?.status ?? null });
    const expiresAt = d.expiresAt ? d.expiresAt.toISOString() : null;
    if (d.allowed) {
      if (zone?.served === 'pending') return { state: 'served', reason: null, expiresAt };
      return { state: 'waiting', reason: zone?.status === 'error' ? 'syncError' : null, expiresAt };
    }
    return { state: d.reason && REFUSALS.has(d.reason) ? 'refused' : 'unavailable', reason: d.reason, expiresAt };
  } catch (err) {
    logger.warn({ domainId: domain.id, err: (err as Error)?.message }, 'dns: pending zone view failed');
    return { state: 'unavailable', reason: null, expiresAt: null };
  }
}
