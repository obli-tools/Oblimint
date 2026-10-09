import { promises as dnsPromises } from 'dns';
import ipaddr from 'ipaddr.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public DNS lookups of the mail checks (docs/P4-PLAN.md §9.3) through the
// EXPLICIT resolvers of the platform settings (dns.resolvers) — never the
// container resolver (Docker's embedded DNS, split horizon). Same rules as
// utils/publicDns.ts (P2), with the record types mail needs. Injectable for
// tests (setMailDnsLookupForTests).
// ─────────────────────────────────────────────────────────────────────────────

export interface MailMx { exchange: string; priority: number }
export interface MailSrv { priority: number; weight: number; port: number; name: string }

/** Every method returns [] for NXDOMAIN / NODATA and throws MailDnsLookupError on a resolver failure. Names lower case, no trailing dot. */
export interface MailDnsLookup {
  mx(name: string): Promise<MailMx[]>;
  /** TXT strings (chunks joined). */
  txt(name: string): Promise<string[]>;
  a(name: string): Promise<string[]>;
  aaaa(name: string): Promise<string[]>;
  srv(name: string): Promise<MailSrv[]>;
  /** Reverse DNS of an address. */
  ptr(ip: string): Promise<string[]>;
}

export class MailDnsLookupError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'MailDnsLookupError';
  }
}

const EMPTY_CODES = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);
const TIMEOUT_MS = 5_000;

const host = (n: string) => String(n ?? '').trim().toLowerCase().replace(/\.$/, '');

function normalizeIp(v: string): string {
  try {
    return ipaddr.parse(v).toString();
  } catch {
    return v;
  }
}

/** Lookup against the given resolvers (ENODATA / NXDOMAIN = empty). */
export function createMailDnsLookup(resolvers: string[]): MailDnsLookup {
  const servers = resolvers.filter(Boolean);
  const make = () => {
    const r = new dnsPromises.Resolver({ timeout: TIMEOUT_MS, tries: 2 });
    if (servers.length) r.setServers(servers);
    return r;
  };
  const run = async <T>(what: string, fn: (r: dnsPromises.Resolver) => Promise<T[]>): Promise<T[]> => {
    try {
      return await fn(make());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
      if (EMPTY_CODES.has(code)) return [];
      throw new MailDnsLookupError(`${what}: ${code}`, code);
    }
  };
  return {
    mx: (name) => run(`MX ${name}`, async (r) => (await r.resolveMx(name)).map((m) => ({ exchange: host(m.exchange), priority: m.priority }))),
    txt: (name) => run(`TXT ${name}`, async (r) => (await r.resolveTxt(name)).map((chunks) => chunks.join(''))),
    a: (name) => run(`A ${name}`, async (r) => (await r.resolve4(name)).map(normalizeIp)),
    aaaa: (name) => run(`AAAA ${name}`, async (r) => (await r.resolve6(name)).map(normalizeIp)),
    srv: (name) => run(`SRV ${name}`, async (r) => (await r.resolveSrv(name)).map((s) => ({ priority: s.priority, weight: s.weight, port: s.port, name: host(s.name) }))),
    ptr: (ip) => run(`PTR ${ip}`, async (r) => (await r.reverse(ip)).map(host)),
  };
}

let override: MailDnsLookup | null = null;

/** Tests: replace every lookup (null restores the real resolvers). */
export function setMailDnsLookupForTests(fake: MailDnsLookup | null): void {
  override = fake;
}

/** Lookup with the resolvers of the platform settings (dns.resolvers). */
export async function mailDnsLookup(): Promise<MailDnsLookup> {
  if (override) return override;
  const { platformSettings } = await import('../../platformSettings');
  const { resolvers } = await platformSettings.section('dns');
  return createMailDnsLookup(resolvers);
}
