import type { CwpDnsRecord, CwpDnsZone, DnsRecordType, PlannedDnsRecord } from '@oblimint/shared';
import { DNS_RECORD_TYPES } from '@oblimint/shared';
import { MAX_TTL, MIN_TTL, RecordValidationError, parseTxtInput, validateRecord } from '../../dns/records';
import { canonicalIp, inZone, ipFamily, lower } from './util';

// ─────────────────────────────────────────────────────────────────────────────
// D-DNS (docs/P5-PLAN.md §4): a CWP zone (journal applied) → the records the
// mail-dns executor writes into PowerDNS, ALREADY rewritten:
//   - SOA and apex NS dropped (the platform owns them), delegation NS kept;
//   - only A / AAAA / CNAME / MX / TXT / SRV / CAA / NS (others dropped);
//   - EXACT source IPs → platform IPs in A / AAAA and in the ip4: / ip6:
//     tokens of SPF (other addresses kept: zoneForeignIp); a source IP whose
//     family has NO platform IP is never kept pointing at the old server: the
//     A / AAAA record is dropped (noTargetIp) and the SPF token removed, both
//     counted in `missingTarget` (computePlan: zoneTargetIpMissing);
//   - cpanel. / cwp. / localhost. names dropped (CWP services);
//   - records the P4 mail DNS contributor publishes for a migrated mail domain
//     (apex MX, apex SPF, _dmarc, <imported selector>._domainkey,
//     autoconfig / autodiscover) dropped (mailManaged);
//   - TTL clamped to 60…604800, optionally forced (importTtl);
//   - every kept record validated by the dns module's own validator.
// Record names follow the dns service convention (services/dns/records.ts
// relativeName / DnsRecord.name): RELATIVE to the zone, '@' for the apex,
// lower case, no trailing dot; targets (CNAME / MX / NS / SRV) absolute WITH
// their trailing dot; TXT unquoted; MX / SRV priority in `priority`.
// ─────────────────────────────────────────────────────────────────────────────

export type ZoneDropReason =
  | 'soa' | 'apexNs' | 'unsupportedType' | 'outsideZone' | 'cwpService' | 'mailManaged' | 'invalid' | 'duplicate' | 'noTargetIp';

export interface MailManagedDomain {
  /** Mail domain (fqdn) whose DNS the P4 contributor publishes. */
  name: string;
  /** DKIM selectors imported for it (their TXT is republished by P4). */
  dkimSelectors: string[];
}

export interface RewriteZoneOptions {
  /** Addresses of the CWP server (exact match only). */
  sourceIps: readonly string[];
  targetIpv4: string | null;
  targetIpv6: string | null;
  /** false = A / AAAA / SPF left untouched (per-zone choice). */
  rewriteIps?: boolean;
  /** TTL forced on every record (null = keep, clamped). */
  importTtl?: number | null;
  mailManaged?: readonly MailManagedDomain[];
}

export interface RewrittenZone {
  defaultTtl: number;
  records: PlannedDnsRecord[];
  dropped: Array<{ record: CwpDnsRecord; reason: ZoneDropReason }>;
  /** A / AAAA contents + SPF tokens rewritten. */
  rewritten: number;
  /** Addresses of A / AAAA kept as they are (other machines). */
  foreignIps: string[];
  /** Source-IP A / AAAA records dropped + SPF tokens removed because the platform has no IP of that family. */
  missingTarget: { v4: number; v6: number };
}

const CWP_SERVICE_LABELS = new Set(['cpanel', 'cwp', 'localhost']);

export function clampTtl(ttl: number | null | undefined, fallback = 3600): number {
  const n = Number.isFinite(ttl as number) ? Math.trunc(ttl as number) : fallback;
  return Math.min(MAX_TTL, Math.max(MIN_TTL, n));
}

/** Absolute target from a zone-file target (relative single labels are completed with the zone). */
function absoluteTarget(raw: string, zone: string): string {
  const s = raw.trim().toLowerCase();
  if (s === '@') return `${zone}.`;
  if (s === '.' || s.endsWith('.')) return s;
  if (inZone(s, zone) || s.includes('.')) return `${s}.`;
  return `${s}.${zone}.`;
}

/** Splits presentation content into (priority, content) for MX / SRV when the priority is inline. */
function splitPriority(r: CwpDnsRecord): { priority: number | null; content: string } {
  const content = r.content.trim();
  if (r.priority !== null && r.priority !== undefined) return { priority: r.priority, content };
  const parts = content.split(/\s+/);
  if (r.type.toUpperCase() === 'MX' && parts.length === 2 && /^\d+$/.test(parts[0])) return { priority: Number(parts[0]), content: parts[1] };
  if (r.type.toUpperCase() === 'SRV' && parts.length === 4 && /^\d+$/.test(parts[0])) return { priority: Number(parts[0]), content: parts.slice(1).join(' ') };
  return { priority: null, content };
}

function rewriteAddress(ip: string, opts: RewriteZoneOptions, sources: Set<string>): string | null {
  const c = canonicalIp(ip);
  if (!c || !sources.has(c)) return null;
  const target = ipFamily(c) === 4 ? canonicalIp(opts.targetIpv4) : canonicalIp(opts.targetIpv6);
  return target && ipFamily(target) === ipFamily(c) ? target : null;
}

/** Family (4 / 6) of a source IP whose family has no platform IP, else null. */
function missingTargetFamily(ip: string, opts: RewriteZoneOptions, sources: Set<string>): 4 | 6 | null {
  const c = canonicalIp(ip);
  if (!c || !sources.has(c)) return null;
  const fam = ipFamily(c) === 4 ? 4 : 6;
  const target = canonicalIp(fam === 4 ? opts.targetIpv4 : opts.targetIpv6);
  return target && ipFamily(target) === fam ? null : fam;
}

/**
 * ip4: / ip6: tokens of an SPF record whose address is a source IP (no CIDR, or /32 / /128) → target; a source
 * token whose family has no platform IP is REMOVED (counted in `missing`), never left authorising the old server.
 */
export function rewriteSpf(
  text: string, opts: RewriteZoneOptions, sources: Set<string>,
): { text: string; count: number; missing: { v4: number; v6: number } } {
  const missing = { v4: 0, v6: 0 };
  if (!/^v=spf1(\s|$)/i.test(text.trim())) return { text, count: 0, missing };
  let count = 0;
  const out: string[] = [];
  for (const tok of text.split(/(\s+)/)) {
    const m = /^([+?~-]?)(ip4|ip6):([^/]+)(\/\d{1,3})?$/i.exec(tok);
    if (!m) { out.push(tok); continue; }
    const fam = m[2].toLowerCase() === 'ip4' ? 4 : 6;
    if (m[4] && m[4] !== (fam === 4 ? '/32' : '/128')) { out.push(tok); continue; }
    const target = rewriteAddress(m[3], opts, sources);
    if (target && ipFamily(target) === fam) {
      count++;
      out.push(`${m[1]}${m[2]}:${target}`);
      continue;
    }
    if (missingTargetFamily(m[3], opts, sources) === fam) {
      if (fam === 4) missing.v4++; else missing.v6++;
      // Removed with the separator before it.
      if (out.length && /^\s+$/.test(out[out.length - 1])) out.pop();
      continue;
    }
    out.push(tok);
  }
  return { text: missing.v4 + missing.v6 ? out.join('').trim() : out.join(''), count, missing };
}

function relative(fqdn: string, zone: string): string {
  return fqdn === zone ? '@' : fqdn.slice(0, -(zone.length + 1));
}

/** Is the record published by the P4 mail DNS contributor for a migrated mail domain? */
function mailManaged(owner: string, type: string, text: string, managed: readonly MailManagedDomain[]): boolean {
  for (const d of managed) {
    if (owner === d.name && type === 'MX') return true;
    if (owner === d.name && type === 'TXT' && /^v=spf1(\s|$)/i.test(text.trim())) return true;
    if (owner === `_dmarc.${d.name}` && type === 'TXT') return true;
    if (type === 'TXT' && d.dkimSelectors.some((s) => owner === `${s.toLowerCase()}._domainkey.${d.name}`)) return true;
    if (owner === `autoconfig.${d.name}` || owner === `autodiscover.${d.name}`) return true;
  }
  return false;
}

export function rewriteZone(zone: CwpDnsZone, opts: RewriteZoneOptions): RewrittenZone {
  const zoneName = lower(zone.name);
  const defaultTtl = opts.importTtl ? clampTtl(opts.importTtl) : clampTtl(zone.defaultTtl ?? 3600);
  const sources = new Set(opts.sourceIps.map((ip) => canonicalIp(ip)).filter((ip): ip is string => !!ip));
  const rewriteIps = opts.rewriteIps !== false;
  const managed = opts.mailManaged ?? [];
  const records: PlannedDnsRecord[] = [];
  const dropped: RewrittenZone['dropped'] = [];
  const foreign = new Set<string>();
  const seen = new Set<string>();
  let rewritten = 0;
  const missingTarget = { v4: 0, v6: 0 };

  for (const rec of zone.records) {
    const type = String(rec.type ?? '').toUpperCase();
    const owner = lower(rec.name);
    if (type === 'SOA') { dropped.push({ record: rec, reason: 'soa' }); continue; }
    if (!inZone(owner, zoneName)) { dropped.push({ record: rec, reason: 'outsideZone' }); continue; }
    const rel = relative(owner, zoneName);
    if (type === 'NS' && rel === '@') { dropped.push({ record: rec, reason: 'apexNs' }); continue; }
    if (!(DNS_RECORD_TYPES as readonly string[]).includes(type)) { dropped.push({ record: rec, reason: 'unsupportedType' }); continue; }
    if (CWP_SERVICE_LABELS.has(rel.split('.')[0])) { dropped.push({ record: rec, reason: 'cwpService' }); continue; }

    const { priority, content: raw } = splitPriority(rec);
    let content = raw;
    if (type === 'TXT') content = parseTxtInput(raw);
    if (mailManaged(owner, type, content, managed)) { dropped.push({ record: rec, reason: 'mailManaged' }); continue; }

    if (type === 'A' || type === 'AAAA') {
      const target = rewriteIps ? rewriteAddress(raw, opts, sources) : null;
      const miss = rewriteIps && !target ? missingTargetFamily(raw, opts, sources) : null;
      if (miss !== null) {
        if (miss === 4) missingTarget.v4++; else missingTarget.v6++;
        dropped.push({ record: rec, reason: 'noTargetIp' });
        continue;
      }
      if (target) { content = target; rewritten++; } else {
        const c = canonicalIp(raw);
        if (c && !sources.has(c)) foreign.add(c);
      }
    } else if (type === 'TXT' && rewriteIps) {
      const spf = rewriteSpf(content, opts, sources);
      content = spf.text;
      rewritten += spf.count;
      missingTarget.v4 += spf.missing.v4;
      missingTarget.v6 += spf.missing.v6;
    } else if (type === 'CNAME' || type === 'NS' || type === 'MX') {
      content = content === '.' ? '.' : absoluteTarget(content, zoneName);
    } else if (type === 'SRV') {
      const parts = content.split(/\s+/);
      if (parts.length === 3) content = `${parts[0]} ${parts[1]} ${parts[2] === '.' ? '.' : absoluteTarget(parts[2], zoneName)}`;
    }

    try {
      const n = validateRecord({
        name: rel, type: type as DnsRecordType, content, ttl: opts.importTtl ? clampTtl(opts.importTtl) : clampTtl(rec.ttl, defaultTtl), priority,
      }, { zone: zoneName, defaultTtl });
      if (n.type === 'CNAME' && n.name === '@') { dropped.push({ record: rec, reason: 'invalid' }); continue; }
      const k = `${n.name}|${n.type}|${n.content}|${n.priority ?? ''}`;
      if (seen.has(k)) { dropped.push({ record: rec, reason: 'duplicate' }); continue; }
      seen.add(k);
      records.push({ name: n.name, type: n.type, content: n.content, ttl: n.ttl, priority: n.priority });
    } catch (err) {
      if (!(err instanceof RecordValidationError)) throw err;
      dropped.push({ record: rec, reason: 'invalid' });
    }
  }
  return { defaultTtl, records, dropped, rewritten, foreignIps: [...foreign].sort(), missingTarget };
}
