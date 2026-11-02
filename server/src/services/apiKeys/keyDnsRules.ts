import { API_KEY_DNS_TYPES, OWNERSHIP_TXT_LABEL, type ApiV1DnsReadOnlyReason, type DnsRecordOrigin, type DnsRecordType } from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';
import { applyOverrides, type GeneratedRecord } from '../dns/records';

// ─────────────────────────────────────────────────────────────────────────────
// Which DNS records an access key may write (pure → keyDnsRules.test.ts).
// The platform's own records stay out of reach of a key, whatever its rights:
//   - the records it generates (dns/store generatedAuto: A / AAAA of the
//     domains and subdomains served by the sites, www / wildcard, the mail
//     records of a hosted mail — MX, SPF, DMARC, DKIM, autoconfig… — through
//     the zone contributors), and any record that would override one of them
//     (same rule as the panel's overrides: dns/records applyOverrides), or a
//     name answered by a generated wildcard;
//   - a human's override of a generated record (panel only);
//   - SOA / NS (NS is not a key type; the SOA is never a record row), the ACME
//     and ownership challenge names.
// A key writes the other records of the types API_KEY_DNS_TYPES: what points
// elsewhere (another server, a game server's SRV, a site verification TXT…).
// ─────────────────────────────────────────────────────────────────────────────

/** Labels of the challenge records (ACME DNS-01, domain ownership): never written by a key. */
export const KEY_RESERVED_LABELS: readonly string[] = ['_acme-challenge', OWNERSHIP_TXT_LABEL];

const ADDRESS_TYPES: ReadonlySet<DnsRecordType> = new Set<DnsRecordType>(['A', 'AAAA', 'CNAME']);

export interface KeyRecordLike {
  /** Relative to the zone ('@' = apex), normalized. */
  name: string;
  type: DnsRecordType;
  content?: string;
}

/** A generated wildcard ('*', '*.shop') answers for `name` (a name below it, never the apex). */
function underGeneratedWildcard(name: string, generated: readonly GeneratedRecord[]): boolean {
  if (name === '@') return false;
  return generated.some((g) => {
    if (!ADDRESS_TYPES.has(g.type) || !g.name.startsWith('*')) return false;
    const base = g.name === '*' ? '' : g.name.slice(2);
    return base === '' || name.endsWith(`.${base}`);
  });
}

/**
 * Why a key may not write `rec` (a new record, or what an existing one becomes), null when it may.
 * `generated`: the zone's generated records before overrides (dns/store generatedAuto).
 */
export function keyWriteGuard(rec: KeyRecordLike, generated: readonly GeneratedRecord[]): ApiV1DnsReadOnlyReason | null {
  if (!API_KEY_DNS_TYPES.includes(rec.type)) return 'type';
  if (rec.name.split('.').some((l) => KEY_RESERVED_LABELS.includes(l))) return 'reserved';
  if (applyOverrides([...generated], [rec]).length < generated.length) return 'generated';
  if (ADDRESS_TYPES.has(rec.type) && underGeneratedWildcard(rec.name, generated)) return 'generated';
  return null;
}

/** Why a stored record is read-only for a key (null: a free record it may change or delete). */
export function storedReadOnly(row: KeyRecordLike & { origin: DnsRecordOrigin }, generated: readonly GeneratedRecord[]): ApiV1DnsReadOnlyReason | null {
  if (row.origin === 'auto' || row.origin === 'system') return 'generated';
  const r = keyWriteGuard(row, generated);
  // A manual / template record taking the place of a generated one: a human's choice in the panel.
  return r === 'generated' ? 'override' : r;
}

const REASON_TEXT: Record<ApiV1DnsReadOnlyReason, string> = {
  generated: 'This record is managed by the platform (a name served by a site or a subdomain, or the hosted mail of the domain): a key never changes it. '
    + 'Point a name at a site with routes / subdomains; use DNS records only for what is hosted elsewhere',
  override: 'A human replaced the platform record of this name in the panel: only the panel changes it',
  type: `A key writes ${API_KEY_DNS_TYPES.join(', ')} records only (SOA and NS are managed by the platform, delegations in the panel)`,
  reserved: 'ACME and domain ownership challenge records are managed by the platform',
};

/** 403 dnsRecordProtected with the reason (details.reason). */
export function protectedRecordError(reason: ApiV1DnsReadOnlyReason, rec: KeyRecordLike): AppError {
  return new AppError(403, REASON_TEXT[reason], 'dnsRecordProtected', { reason, name: rec.name, type: rec.type });
}
