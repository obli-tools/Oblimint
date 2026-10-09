import ipaddr from 'ipaddr.js';
import { AppError } from '../../middleware/errorHandler';

// ─────────────────────────────────────────────────────────────────────────────
// Address / CIDR helpers of the allow-list (module hostd-firewall). Every
// address that reaches hostd went through here (hostd validates again, R2).
// IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are always stored as IPv4.
// ─────────────────────────────────────────────────────────────────────────────

/** Narrowest accepted prefixes of a rule (plan §6.4 cidrTooWide): /8 in IPv4, /32 in IPv6. */
export const MIN_RULE_BITS = { 4: 8, 6: 32 } as const;

export interface NormalizedCidr {
  /** Canonical text: bare address for a single host, network/bits otherwise. */
  cidr: string;
  family: 4 | 6;
  bits: number;
}

type Addr = ipaddr.IPv4 | ipaddr.IPv6;

function unmap(a: Addr): Addr {
  return a.kind() === 'ipv6' && (a as ipaddr.IPv6).isIPv4MappedAddress() ? (a as ipaddr.IPv6).toIPv4Address() : a;
}

function familyOf(a: Addr): 4 | 6 {
  return a.kind() === 'ipv4' ? 4 : 6;
}

function maxBits(f: 4 | 6): number {
  return f === 4 ? 32 : 128;
}

/** Network address of a/bits (host bits cleared). */
function network(a: Addr, bits: number): Addr {
  const bytes = a.toByteArray();
  for (let i = 0; i < bytes.length; i++) {
    const keep = Math.max(0, Math.min(8, bits - i * 8));
    bytes[i] &= keep === 0 ? 0 : (0xff << (8 - keep)) & 0xff;
  }
  return ipaddr.fromByteArray(bytes);
}

function strictParse(text: string): Addr | null {
  // No zone ids, no IPv4 shorthands ("10.1" / "0x0a…"): ipaddr.isValidFourPartDecimal for v4.
  if (text.includes('%')) return null;
  if (ipaddr.IPv4.isValidFourPartDecimal(text)) return ipaddr.IPv4.parse(text);
  if (ipaddr.IPv6.isValid(text) && text.includes(':')) {
    try { return ipaddr.IPv6.parse(text); } catch { return null; }
  }
  return null;
}

/** A single address (v4 or v6), normalized; null when invalid. */
export function normalizeAddress(input: unknown): { ip: string; family: 4 | 6 } | null {
  if (typeof input !== 'string') return null;
  const text = input.trim().replace(/^\[(.*)\]$/, '$1');
  if (!text || text.length > 64) return null;
  const a = strictParse(text);
  if (!a) return null;
  const u = unmap(a);
  return { ip: u.toString(), family: familyOf(u) };
}

/**
 * Parses a rule address / CIDR: 400 `invalidCidr` when malformed, 400
 * `cidrTooWide` under /8 (v4) or /32 (v6). Host bits are cleared
 * ('10.1.2.3/8' → '10.0.0.0/8'); a full-length prefix becomes the bare address.
 */
export function normalizeCidr(input: unknown, minBits: { 4: number; 6: number } = MIN_RULE_BITS): NormalizedCidr {
  const invalid = () => new AppError(400, 'Invalid IP address or CIDR range', 'invalidCidr');
  if (typeof input !== 'string') throw invalid();
  const text = input.trim();
  if (!text || text.length > 64) throw invalid();
  const slash = text.indexOf('/');
  const addrText = slash === -1 ? text : text.slice(0, slash);
  const bitsText = slash === -1 ? null : text.slice(slash + 1);
  const parsed = strictParse(addrText);
  if (!parsed) throw invalid();
  let family = familyOf(parsed);
  let bits = maxBits(family);
  if (bitsText !== null) {
    if (!/^\d{1,3}$/.test(bitsText)) throw invalid();
    bits = Number(bitsText);
    if (bits > maxBits(family)) throw invalid();
  }
  let addr: Addr = parsed;
  if (family === 6 && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    if (bits < 96) throw invalid();
    addr = (parsed as ipaddr.IPv6).toIPv4Address();
    bits -= 96;
    family = 4;
  }
  if (bits < minBits[family]) {
    throw new AppError(400, `The range is too wide (at least /${minBits[family]} in IPv${family})`, 'cidrTooWide', { minBits: minBits[family], family });
  }
  const net = network(addr, bits);
  return { cidr: bits === maxBits(family) ? net.toString() : `${net.toString()}/${bits}`, family, bits };
}

/** Does `cidr` (address or network/bits, already normalized) contain `ip`? */
export function cidrContains(cidr: string, ip: string): boolean {
  const a = normalizeAddress(ip);
  if (!a) return false;
  try {
    const n = normalizeCidr(cidr, { 4: 0, 6: 0 });
    if (n.family !== a.family) return false;
    const addr = ipaddr.parse(a.ip);
    const [net] = n.cidr.split('/');
    return (addr as Addr).match(ipaddr.parse(net) as never, n.bits);
  } catch {
    return false;
  }
}

/**
 * Ban key of a client address: the IPv4 address itself, or the /64 of an
 * IPv6 address (one subscriber holds a whole /64).
 */
export function banKey(ip: string): string | null {
  const a = normalizeAddress(ip);
  if (!a) return null;
  if (a.family === 4) return a.ip;
  return `${network(ipaddr.parse(a.ip) as Addr, 64).toString()}/64`;
}

/** Wider ban of an IPv6 address: its /48 (a site's allocation); null for IPv4. */
export function wideBanKey(ip: string): string | null {
  const a = normalizeAddress(ip);
  if (!a || a.family === 4) return null;
  return `${network(ipaddr.parse(a.ip) as Addr, 48).toString()}/48`;
}

/** Loopback / unspecified: never a remote client worth a grant or a ban. */
export function isLocalAddress(ip: string): boolean {
  const a = normalizeAddress(ip);
  if (!a) return true;
  const range = (ipaddr.parse(a.ip) as Addr).range();
  return range === 'loopback' || range === 'unspecified';
}

/** ipaddr.js ranges that are never the public address of a client (shared relays, LAN, plumbing). */
const NON_PUBLIC_RANGES = new Set([
  'unspecified', 'loopback', 'private', 'linkLocal', 'carrierGradeNat', 'uniqueLocal', 'multicast', 'broadcast',
]);

/**
 * A public client address: not loopback, RFC 1918, CGNAT, link-local, ULA,
 * multicast… (a Docker bridge gateway or a LAN proxy is shared by everyone
 * behind it: never allow-listed as "my address"). Invalid → false.
 */
export function isPublicAddress(ip: string): boolean {
  const a = normalizeAddress(ip);
  if (!a) return false;
  return !NON_PUBLIC_RANGES.has((ipaddr.parse(a.ip) as Addr).range());
}
