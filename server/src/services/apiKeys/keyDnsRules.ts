import { API_KEY_DNS_TYPES, OWNERSHIP_TXT_LABEL, type ApiV1DnsReadOnlyReason, type DnsRecordOrigin, type DnsRecordType } from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';
import { applyOverrides, inZone, relativeTo, txtKind, type GeneratedRecord, type PlatformHosts } from '../dns/records';

// ─────────────────────────────────────────────────────────────────────────────
// Which DNS records an access key may write (pure → keyDnsRules.test.ts).
// The platform's own records stay out of reach of a key, whatever its rights:
//   - the records it generates (dns/store generatedAuto: A / AAAA of the
//     domains and subdomains served by the sites, www / wildcard, the mail
//     records of a hosted mail — MX, SPF, DMARC, DKIM, autoconfig… — through
//     the zone contributors), any record that would override one of them
//     (same rule as the panel's overrides: dns/records applyOverrides), any
//     address record (A / AAAA / CNAME) on a name holding a generated address
//     (an AAAA beside a generated A takes the dual-stack visitors), a name
//     answered by a generated wildcard, and any name that would stop being
//     answered by it (a record of any type, or the empty non-terminals it
//     creates, hides the wildcard below it — RFC 4592);
//   - the platform host names falling in an account zone (panel, client space,
//     preview domain and its wildcard, DB admin, probes): any type;
//   - when the mail is hosted in the zone: every MX and every mail TXT (SPF,
//     DKIM, DMARC, MTA-STS, TLS-RPT), whatever the name;
//   - a human's record in the panel on such a name or use (panel only);
//   - SOA / NS (NS is not a key type; the SOA is never a record row), the ACME
//     and ownership challenge names, and every wildcard name (a wildcard TXT /
//     CNAME would answer the challenge names);
//   - a CAA record other than one authorizing the platform's certificate
//     authority (it would stop the certificates of the served names).
// A key writes the other records of the types API_KEY_DNS_TYPES: what points
// elsewhere (another server, a game server's SRV, a site verification TXT…).
// A record written by a key never overrides a generated record later either:
// dns/store regenerateAuto disables it when its name becomes served.
// ─────────────────────────────────────────────────────────────────────────────

/** Labels of the challenge records (ACME DNS-01, domain ownership): never written by a key. */
export const KEY_RESERVED_LABELS: readonly string[] = ['_acme-challenge', OWNERSHIP_TXT_LABEL];

/** The certificate authority of the platform (edge/acmeIssuer): the only issuer a key's CAA record names. */
export const KEY_CAA_ISSUER = 'letsencrypt.org';

const ADDRESS_TYPES: ReadonlySet<DnsRecordType> = new Set<DnsRecordType>(['A', 'AAAA', 'CNAME']);
const MAIL_TXT_KINDS: ReadonlySet<string> = new Set(['spf', 'dkim', 'dmarc', 'mta-sts', 'tls-rpt']);

export interface KeyRecordLike {
  /** Relative to the zone ('@' = apex), normalized. */
  name: string;
  type: DnsRecordType;
  content?: string;
}

/** What the guard knows of the zone besides its generated records. */
export interface KeyZoneFacts {
  /**
   * Owner names of the records the zone publishes (relative; the record being changed aside). The generated
   * names always count. Decides whether a record would create a name hiding a generated wildcard.
   */
  existing?: Iterable<string>;
  /** Platform host names falling in the zone (platformNamesIn). */
  platformNames?: readonly string[];
}

/** `name` and the names above it, the apex aside ('a.b.c' → ['a.b.c', 'b.c', 'c']). */
function selfAndAncestors(name: string): string[] {
  if (name === '@') return [];
  const labels = name.split('.');
  return labels.map((_, i) => labels.slice(i).join('.'));
}

/** Base of a wildcard owner ('*' → '', '*.shop' → 'shop'), null when it is not one. */
function wildcardBase(name: string): string | null {
  if (name === '*') return '';
  return name.startsWith('*.') ? name.slice(2) : null;
}

/** Is `name` strictly below `base` ('' = the apex)? */
const below = (name: string, base: string) => name !== '@' && (base === '' || name.endsWith(`.${base}`));

/** Relative names of the platform host names that fall in `zone` (the preview wildcard included). */
export function platformNamesIn(zone: string, hosts: PlatformHosts): string[] {
  const out = new Set<string>();
  const add = (host: string | null | undefined) => {
    const h = host?.trim().toLowerCase().replace(/\.$/, '');
    if (h && inZone(h.replace(/^\*\./, ''), zone)) out.add(h.startsWith('*.') && h.slice(2) === zone ? '*' : relativeTo(h, zone));
  };
  add(hosts.panelHostname);
  add(hosts.clientPanelHostname);
  if (hosts.previewDomain) {
    add(hosts.previewDomain);
    add(`*.${hosts.previewDomain.trim()}`);
  }
  add(hosts.dbAdminHostname);
  add(hosts.probeHostV4);
  add(hosts.probeHostV6);
  return [...out];
}

/** The mail of the zone is hosted here: a generated MX or mail TXT. */
function hostedMail(generated: readonly GeneratedRecord[]): boolean {
  return generated.some((g) => g.type === 'MX' || (g.type === 'TXT' && MAIL_TXT_KINDS.has(txtKind(g.name, g.content))));
}

/** A CAA record a key may write: an iodef, or an issue / issuewild naming the platform's authority alone. */
function caaAllowed(content: string | undefined): boolean {
  const m = /^\d+\s+(\S+)\s+"?([^"]*)"?$/.exec(String(content ?? '').trim());
  if (!m) return false;
  const tag = m[1].toLowerCase();
  if (tag !== 'issue' && tag !== 'issuewild') return true;
  return m[2].trim().toLowerCase() === KEY_CAA_ISSUER;
}

/**
 * Why a key may not write `rec` (a new record, or what an existing one becomes), null when it may.
 * `generated`: the zone's generated records before overrides (dns/store generatedAuto).
 */
export function keyWriteGuard(rec: KeyRecordLike, generated: readonly GeneratedRecord[], facts: KeyZoneFacts = {}): ApiV1DnsReadOnlyReason | null {
  if (!API_KEY_DNS_TYPES.includes(rec.type)) return 'type';
  const labels = rec.name.split('.');
  if (labels.some((l) => l === '*' || KEY_RESERVED_LABELS.includes(l))) return 'reserved';
  for (const p of facts.platformNames ?? []) {
    const base = wildcardBase(p);
    if (rec.name === p || (base !== null && below(rec.name, base))) return 'generated';
  }
  if (applyOverrides([...generated], [rec]).length < generated.length) return 'generated';
  const address = ADDRESS_TYPES.has(rec.type);
  if (address && generated.some((g) => g.name === rec.name && ADDRESS_TYPES.has(g.type))) return 'generated';
  if (hostedMail(generated) && (rec.type === 'MX' || (rec.type === 'TXT' && MAIL_TXT_KINDS.has(txtKind(rec.name, rec.content ?? ''))))) return 'generated';
  const wildcards = generated.filter((g) => ADDRESS_TYPES.has(g.type)).map((g) => wildcardBase(g.name)).filter((b): b is string => b !== null);
  if (wildcards.length) {
    const existing = new Set<string>();
    for (const n of [...generated.map((g) => g.name), ...(facts.existing ?? [])]) for (const a of selfAndAncestors(n)) existing.add(a);
    for (const base of wildcards) {
      if (!below(rec.name, base)) continue;
      // An address answered by the wildcard of a site: never repointed.
      if (address) return 'generated';
      // A new name between the record and the wildcard (the record's own, or an empty non-terminal above it) stops
      // the wildcard answering it and the names below it. Service labels (_tcp, _dmarc…) are never site names.
      const created = selfAndAncestors(rec.name).filter((n) => below(n, base) && !existing.has(n) && !n.startsWith('_'));
      if (created.length) return 'generated';
    }
  }
  if (rec.type === 'CAA' && !caaAllowed(rec.content)) return 'caa';
  return null;
}

/**
 * Why a stored record is read-only for a key (null: a free record it may change or delete).
 * `byKey`: written by an access key (dns_records.api_key_id).
 */
export function storedReadOnly(
  row: KeyRecordLike & { origin: DnsRecordOrigin; byKey?: boolean },
  generated: readonly GeneratedRecord[],
  facts: KeyZoneFacts = {},
): ApiV1DnsReadOnlyReason | null {
  if (row.origin === 'auto' || row.origin === 'system') return 'generated';
  const r = keyWriteGuard(row, generated, { ...facts, existing: [...(facts.existing ?? []), row.name] });
  // A manual / template record on a name or a use the platform manages: a human's choice in the panel.
  return r === 'generated' && !row.byKey ? 'override' : r;
}

const REASON_TEXT: Record<ApiV1DnsReadOnlyReason, string> = {
  generated: 'This record is managed by the platform (a name served by a site, a subdomain or the platform, the names its wildcard answers, or the hosted mail of the domain): a key never changes it. '
    + 'Point a name at a site with routes / subdomains; use DNS records only for what is hosted elsewhere',
  override: 'A human set this record in the panel on a name or a use the platform manages: only the panel changes it',
  type: `A key writes ${API_KEY_DNS_TYPES.join(', ')} records only (SOA and NS are managed by the platform, delegations in the panel)`,
  reserved: 'ACME and domain ownership challenge records, and wildcard names, are managed in the panel',
  caa: `A key's CAA record may only authorize the platform's certificate authority (issue / issuewild "${KEY_CAA_ISSUER}", or an iodef): the other ones are set in the panel`,
};

/** 403 dnsRecordProtected with the reason (details.reason). */
export function protectedRecordError(reason: ApiV1DnsReadOnlyReason, rec: KeyRecordLike): AppError {
  return new AppError(403, REASON_TEXT[reason], 'dnsRecordProtected', { reason, name: rec.name, type: rec.type });
}
