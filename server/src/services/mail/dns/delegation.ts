import type { DnsSettings, MailDnsDelegationStatus } from '@oblimint/shared';
import type { PublicDnsLookup } from '../../../utils/publicDns';

// ─────────────────────────────────────────────────────────────────────────────
// Public delegation of the zone of a mail domain (who serves it: our name
// servers or another DNS host). Pure apart from the injected NS lookup —
// used by the mail DNS check (stored in mail_domains.dns_check) and by the
// Fix preview (mailDns.service.ts).
// ─────────────────────────────────────────────────────────────────────────────

export const normHost = (n: string): string => String(n ?? '').trim().toLowerCase().replace(/\.$/, '');

/** Our name servers: settings dns.nameservers, none when the DNS module is off. */
export function ourNameservers(s: Pick<DnsSettings, 'enabled' | 'nameservers'>): string[] {
  if (!s.enabled) return [];
  return [...new Set((s.nameservers ?? []).map(normHost).filter(Boolean))];
}

/**
 * ours: every public NS is ours; elsewhere: none is; mixed: both;
 * unknown: no NS found (nothing to classify).
 */
export function classifyDelegation(found: string[], expected: string[]): MailDnsDelegationStatus {
  const ns = [...new Set(found.map(normHost).filter(Boolean))];
  if (ns.length === 0) return 'unknown';
  const ours = new Set(expected.map(normHost).filter(Boolean));
  const mine = ns.filter((n) => ours.has(n)).length;
  if (mine === ns.length) return 'ours';
  return mine === 0 ? 'elsewhere' : 'mixed';
}

/** `name` then its parents, down to two labels (example.com): the walk-up candidates of the zone apex. */
export function apexCandidates(name: string): string[] {
  const labels = normHost(name).split('.').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i + 2 <= labels.length; i++) out.push(labels.slice(i).join('.'));
  return out;
}

export interface DelegationLookup {
  zone: string;
  found: string[];
  status: MailDnsDelegationStatus;
  /** The resolvers failed (status unknown). */
  failed: boolean;
}

/**
 * Public NS of the zone apex: `zone` when given (the zone hosted here), else
 * the first of `name` and its parents that has NS records. Never throws: a
 * resolver failure gives status 'unknown' (failed = true).
 */
export async function lookupDelegation(
  lookup: Pick<PublicDnsLookup, 'ns'>,
  opts: { zone: string | null; name: string; expected: string[] },
): Promise<DelegationLookup> {
  const candidates = opts.zone ? [normHost(opts.zone)] : apexCandidates(opts.name);
  const fallback = opts.zone ? normHost(opts.zone) : (candidates[candidates.length - 1] ?? normHost(opts.name));
  for (const c of candidates) {
    let ns: string[];
    try {
      ns = [...new Set((await lookup.ns(c)).map(normHost).filter(Boolean))].sort();
    } catch {
      return { zone: c, found: [], status: 'unknown', failed: true };
    }
    if (ns.length > 0) return { zone: c, found: ns, status: classifyDelegation(ns, opts.expected), failed: false };
  }
  return { zone: fallback, found: [], status: 'unknown', failed: false };
}
