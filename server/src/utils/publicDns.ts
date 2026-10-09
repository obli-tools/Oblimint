import { promises as dnsPromises } from 'dns';

// ─────────────────────────────────────────────────────────────────────────────
// Public DNS lookups through EXPLICIT public resolvers (settings
// dns.resolvers), never the container's resolver (Docker's embedded DNS
// would answer for container names and could see a split-horizon view).
// ARCHITECT FILE (P2, frozen) — shared by the ownership verification
// (edge-ownership) and the delegation check (dns). Injectable for tests.
// ─────────────────────────────────────────────────────────────────────────────

export interface PublicDnsLookup {
  /** TXT strings of `name` (chunks joined), [] when NXDOMAIN / NODATA. Throws PublicDnsError on resolver failure. */
  txt(name: string): Promise<string[]>;
  /** NS host names of `name`, lower case without trailing dot, [] when none. Throws PublicDnsError. */
  ns(name: string): Promise<string[]>;
}

export class PublicDnsError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'PublicDnsError';
  }
}

const EMPTY_CODES = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);
const TIMEOUT_MS = 5_000;

/** Lookup against the given resolvers (first answering wins; ENODATA / NXDOMAIN = empty). */
export function createPublicDns(resolvers: string[]): PublicDnsLookup {
  const servers = resolvers.filter(Boolean);
  const make = () => {
    const r = new dnsPromises.Resolver({ timeout: TIMEOUT_MS, tries: 2 });
    if (servers.length) r.setServers(servers);
    return r;
  };
  const run = async <T>(what: string, fn: (r: dnsPromises.Resolver) => Promise<T>, empty: T): Promise<T> => {
    try {
      return await fn(make());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
      if (EMPTY_CODES.has(code)) return empty;
      throw new PublicDnsError(`${what}: ${code}`, code);
    }
  };
  return {
    txt: (name) => run(`TXT ${name}`, async (r) => (await r.resolveTxt(name)).map((chunks) => chunks.join('')), [] as string[]),
    ns: (name) => run(`NS ${name}`, async (r) => (await r.resolveNs(name)).map((n) => n.toLowerCase().replace(/\.$/, '')), [] as string[]),
  };
}

let override: PublicDnsLookup | null = null;

/** Tests: replace every lookup (null restores the real resolvers). */
export function setPublicDnsForTests(fake: PublicDnsLookup | null): void {
  override = fake;
}

/** Lookup with the resolvers of the platform settings (dns.resolvers). */
export async function publicDns(): Promise<PublicDnsLookup> {
  if (override) return override;
  const { platformSettings } = await import('../services/platformSettings');
  const { resolvers } = await platformSettings.section('dns');
  return createPublicDns(resolvers);
}
