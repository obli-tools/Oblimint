import { promises as dnsPromises } from 'dns';
import ipaddr from 'ipaddr.js';

// ─────────────────────────────────────────────────────────────────────────────
// Anti-SSRF guard of the notification channels (invariant N1, docs/P2-PLAN.md
// §9.5 / §11). Ported from Obliance utils/ssrfGuard.ts and tightened:
//   - webhook / Discord URLs: https only, no credentials, host must not be a
//     single label nor an internal suffix (.local, .internal, .localhost,
//     .lan, .home.arpa, .localdomain), EVERY resolved address must be global
//     unicast (no loopback / RFC 1918 / link local incl. 169.254.169.254 /
//     ULA / CGNAT / multicast / reserved / IPv4-mapped of those / 6to4 /
//     Teredo); the address checked is PINNED for the request (no DNS
//     rebinding between the check and the connection), redirects are never
//     followed (http.ts);
//   - SMTP host: may be a private relay of the operator (master tenant or
//     platform admin), never link local / unspecified / multicast; loopback
//     only for the platform admin.
// ─────────────────────────────────────────────────────────────────────────────

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export type LookupFn = (host: string) => Promise<Array<{ address: string; family: number }>>;

export const systemLookup: LookupFn = async (host) => dnsPromises.lookup(host, { all: true, verbatim: true });

const INTERNAL_SUFFIXES = ['.local', '.internal', '.localhost', '.lan', '.home.arpa', '.localdomain', '.intranet', '.corp'];

/** ipaddr.js range of an address; IPv4-mapped IPv6 is classified as its IPv4. null when not an IP. */
export function addressRange(ip: string): string | null {
  const raw = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!ipaddr.isValid(raw)) return null;
  let addr = ipaddr.parse(raw);
  if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) addr = (addr as ipaddr.IPv6).toIPv4Address();
  return addr.range();
}

/** Global unicast only (what a public webhook may resolve to). */
export function isPublicAddress(ip: string): boolean {
  return addressRange(ip) === 'unicast';
}

/** Why a host name is refused before any resolution (null = acceptable). */
export function hostNameProblem(host: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h) return 'empty host';
  if (addressRange(h) !== null) return null; // IP literal: judged by its range
  if (h === 'localhost' || !h.includes('.')) return 'single-label / internal host name';
  if (INTERNAL_SUFFIXES.some((s) => h.endsWith(s))) return 'internal host name';
  if (!/^[a-z0-9.-]+$/.test(h)) return 'invalid host name';
  return null;
}

export interface PinnedTarget {
  url: URL;
  /** Address checked and to connect to. */
  address: string;
  family: 4 | 6;
}

/**
 * Validates a webhook URL and resolves it to ONE pinned public address.
 * Throws SsrfError (→ 400 webhookForbidden at write time, delivery failure at send time).
 */
export async function resolvePublicHttpsTarget(raw: string, lookup: LookupFn = systemLookup): Promise<PinnedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('invalid URL');
  }
  if (url.protocol !== 'https:') throw new SsrfError('only https:// URLs are allowed');
  if (url.username || url.password) throw new SsrfError('credentials in the URL are not allowed');
  if (url.port && url.port !== '443') {
    // Non-standard ports stay allowed on a public address (some webhook relays use 8443).
    const p = Number(url.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new SsrfError('invalid port');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const problem = hostNameProblem(host);
  if (problem) throw new SsrfError(`refused destination (${problem})`);

  if (addressRange(host) !== null) {
    if (!isPublicAddress(host)) throw new SsrfError(`refused destination (${addressRange(host)} address)`);
    return { url, address: host, family: host.includes(':') ? 6 : 4 };
  }
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await lookup(host);
  } catch (err) {
    throw new SsrfError(`cannot resolve ${host} (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  if (!answers.length) throw new SsrfError(`cannot resolve ${host}`);
  for (const a of answers) {
    if (!isPublicAddress(a.address)) throw new SsrfError(`refused destination (${host} resolves to a ${addressRange(a.address) ?? 'invalid'} address)`);
  }
  const first = answers.find((a) => a.family === 4) ?? answers[0];
  return { url, address: first.address, family: first.family === 6 ? 6 : 4 };
}

const SMTP_PRIVATE_RANGES = new Set(['private', 'uniqueLocal', 'carrierGradeNat']);

/**
 * Resolves an SMTP host to one pinned address. `allowPrivate`: operator's
 * relay on a private network (master tenant / platform admin);
 * `allowLoopback`: platform admin only.
 */
export async function resolveSmtpHost(
  host: string,
  opts: { allowPrivate: boolean; allowLoopback: boolean; lookup?: LookupFn },
): Promise<{ address: string; family: 4 | 6 }> {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const check = (addr: string) => {
    const range = addressRange(addr);
    if (range === 'unicast') return;
    if (range === 'loopback' && opts.allowLoopback) return;
    if (range && SMTP_PRIVATE_RANGES.has(range) && opts.allowPrivate) return;
    throw new SsrfError(`refused SMTP destination (${range ?? 'invalid'} address)`);
  };
  if (addressRange(h) !== null) {
    check(h);
    return { address: h, family: h.includes(':') ? 6 : 4 };
  }
  if (h === 'localhost' && opts.allowLoopback) return { address: '127.0.0.1', family: 4 };
  const problem = hostNameProblem(h);
  // Single-label names would be Docker service names of the panel network: refused unless private relays are allowed.
  if (problem && !(opts.allowPrivate && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(h))) throw new SsrfError(`refused SMTP destination (${problem})`);
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await (opts.lookup ?? systemLookup)(h);
  } catch (err) {
    throw new SsrfError(`cannot resolve ${h} (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  if (!answers.length) throw new SsrfError(`cannot resolve ${h}`);
  for (const a of answers) check(a.address);
  const first = answers.find((a) => a.family === 4) ?? answers[0];
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}
