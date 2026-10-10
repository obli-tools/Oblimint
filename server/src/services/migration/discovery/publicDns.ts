import { promises as dnsPromises } from 'dns';
import type { CwpDomain, CwpPublicDns } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Public DNS of the discovered domains (docs/P5-PLAN.md D1 / D-DNS): what the
// world resolves for each name, seen from the panel. The planner only
// defaults a domain to a FORCED ownership verification when this proves the
// domain is really served by the source (A / AAAA = a source IP, or NS = the
// source's name servers): a zone on the CWP server alone proves nothing (any
// CWP client can add any domain). Read-only lookups, bounded (timeout, tries,
// concurrency); a failure is "no proof" (resolved false), never an error.
// ─────────────────────────────────────────────────────────────────────────────

export type PublicDnsLookup = (fqdn: string) => Promise<CwpPublicDns>;

interface ResolverLike {
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
  resolveNs(name: string): Promise<string[]>;
}

const NO_DATA = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);
const MAX_NS_WALK = 4;

async function records(fn: () => Promise<string[]>): Promise<{ values: string[]; failed: boolean }> {
  try {
    return { values: (await fn()).map((v) => v.toLowerCase().replace(/[.]$/, '')), failed: false };
  } catch (err) {
    return { values: [], failed: !NO_DATA.has((err as NodeJS.ErrnoException)?.code ?? '') };
  }
}

/** Lookups of one name through `resolver` (A, AAAA, NS of the closest enclosing zone that has some). */
export async function lookupPublicDns(fqdn: string, resolver: ResolverLike): Promise<CwpPublicDns> {
  const name = fqdn.toLowerCase().replace(/[.]$/, '');
  const [a, aaaa] = await Promise.all([records(() => resolver.resolve4(name)), records(() => resolver.resolve6(name))]);
  let ns: string[] = [];
  let nsFailed = false;
  const labels = name.split('.');
  for (let i = 0; i < Math.min(MAX_NS_WALK, labels.length - 1); i++) {
    const r = await records(() => resolver.resolveNs(labels.slice(i).join('.')));
    if (r.failed) { nsFailed = true; break; }
    if (r.values.length) { ns = r.values; break; }
  }
  const resolved = !(a.failed && aaaa.failed && nsFailed);
  return { a: a.values, aaaa: aaaa.values, ns, resolved };
}

/** Default lookup: the panel's resolver, 3 s per query, one retry. */
export function defaultPublicDnsLookup(): PublicDnsLookup {
  const resolver = new dnsPromises.Resolver({ timeout: 3000, tries: 2 });
  return (fqdn) => lookupPublicDns(fqdn, resolver);
}

/** Annotates every domain with its public DNS (bounded concurrency, abortable between names). */
export async function annotatePublicDns(domains: CwpDomain[], lookup: PublicDnsLookup, opts: { concurrency?: number; checkAbort?: () => void } = {}): Promise<void> {
  const queue = [...domains];
  const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 8, queue.length)) }, async () => {
    for (let d = queue.shift(); d; d = queue.shift()) {
      opts.checkAbort?.();
      try {
        d.publicDns = await lookup(d.fqdn);
      } catch {
        d.publicDns = { a: [], aaaa: [], ns: [], resolved: false };
      }
    }
  });
  await Promise.all(workers);
}
