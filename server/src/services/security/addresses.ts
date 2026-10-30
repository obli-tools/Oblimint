import { banKey, cidrContains, isPublicAddress, normalizeAddress, normalizeCidr } from '../firewall/addresses';

// ─────────────────────────────────────────────────────────────────────────────
// Web ban keys and the never-ban rules (docs/P4b-PLAN.md §9.5, BN1) — PURE
// (addresses.test.ts). Same classification as the mail bans
// (mail/security/bans.ts mailBanKey) and as hostd (validWebBanAddr in
// hostd/webbans.go, which refuses the same ranges again):
//
//  - key: the IPv4 address, or the /64 of an IPv6 address (a subscriber holds
//    a whole /64 and rotates through it at will);
//  - never banned: every non-public address (loopback, unspecified, RFC 1918,
//    link-local, CGNAT 100.64/10, ULA fc00::/7, multicast, broadcast — a NAT,
//    a LAN proxy or a Docker gateway is shared by everybody behind it), an
//    address inside a Docker subnet of the node, the node's own public
//    addresses (and its own IPv6 /64), and settings bans.neverBan (an IPv6
//    key is refused when its /64 OVERLAPS a never-ban range).
// ─────────────────────────────────────────────────────────────────────────────

export interface WebBanGuard {
  /** Docker subnets of the node (every network): never banned. */
  protectedNets: readonly string[];
  /** The node's public IPv4 / IPv6 (app_config public_ipv4 / public_ipv6). */
  nodeAddresses: readonly string[];
  /** settings bans.neverBan (addresses / CIDRs). */
  neverBan: readonly string[];
}

export type BanKeyRefusal = 'invalid' | 'notPublic' | 'node' | 'protected' | 'neverBan';

/** Network address of a key ('1.2.3.4' or '2001:db8:1:2::/64'). */
function keyAddress(key: string): string {
  const slash = key.indexOf('/');
  return slash === -1 ? key : key.slice(0, slash);
}

/** Do a key and a (normalized-or-not) CIDR overlap? */
export function keyOverlaps(key: string, cidr: string): boolean {
  return overlaps(key, cidr);
}

function overlaps(key: string, cidr: string): boolean {
  let net: string;
  try {
    net = normalizeCidr(cidr, { 4: 0, 6: 0 }).cidr;
  } catch {
    return false;
  }
  return cidrContains(net, keyAddress(key)) || cidrContains(key, keyAddress(net));
}

/**
 * Parses what a user typed for a manual ban: an address (IPv6 → its /64) or
 * exactly a /32 (v4) or /64 (v6) CIDR. null when malformed / wider.
 */
export function parseBanInput(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text || text.length > 64) return null;
  if (!text.includes('/')) return banKey(text);
  let n;
  try {
    n = normalizeCidr(text, { 4: 32, 6: 64 });
  } catch {
    return null;
  }
  if (n.family === 4) return n.bits === 32 ? n.cidr : null;
  return n.bits === 64 ? n.cidr : null;
}

/**
 * Classifies a ban key (from banKey / parseBanInput): null when it may be
 * banned, else the reason it may not (BN1).
 */
export function refuseBanKey(key: string, guard: WebBanGuard): BanKeyRefusal | null {
  const addr = normalizeAddress(keyAddress(key));
  if (!addr) return 'invalid';
  if (!isPublicAddress(addr.ip)) return 'notPublic';
  for (const n of guard.nodeAddresses) {
    const node = normalizeAddress(n);
    if (!node) continue;
    if (node.ip === addr.ip) return 'node';
    // The node's own /64 (its other addresses, the Docker IPv6 range routed from it).
    if (node.family === 6 && addr.family === 6 && banKey(node.ip) === key) return 'node';
  }
  for (const net of guard.protectedNets) if (overlaps(key, net)) return 'protected';
  for (const net of guard.neverBan) if (overlaps(key, net)) return 'neverBan';
  return null;
}

/** The ban key of a client address seen in the edge log, or null when it must never be banned. */
export function webBanKey(ip: string, guard: WebBanGuard): string | null {
  const key = banKey(ip);
  if (!key) return null;
  return refuseBanKey(key, guard) === null ? key : null;
}
