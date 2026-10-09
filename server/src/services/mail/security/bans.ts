import type { MailBanService } from '@oblimint/shared';
import { MAIL_PUBLIC_PORTS } from '@oblimint/shared';
import type { HostdMailFirewallState } from '../../hostd/client';
import { banKey, cidrContains, isPublicAddress, normalizeAddress } from '../../firewall/addresses';

// ─────────────────────────────────────────────────────────────────────────────
// Bans on the shared mail ports, PURE part (docs/P4-PLAN.md §8, §9.6, MA8) —
// bans.test.ts. hostd validates the pushed state again (hostd/mail.go).
//
//  - key: the IPv4 address, or the /64 of an IPv6 address;
//  - never banned: loopback, link-local, private / ULA (the Docker networks
//    of the mail service, of the accounts and of the panel, a LAN), CGNAT,
//    multicast, unspecified, the node's own public addresses, and any address
//    inside a protected subnet (the Docker subnets read at run time);
//  - state pushed to hostd: the live bans, latest expiry first, capped.
//
// DELIBERATE (docs/P4-PLAN.md §9.6, wider than the plan's first wording "the
// Docker networks"): EVERY non-public address is exempt, a LAN client
// included (RFC 1918 10.0.0.151 brute-forcing over the LAN is not banned —
// observed on the Linux test host). Behind such an address there is usually a NAT, a
// proxy or the Docker userland-proxy gateway shared by every client: one ban
// would cut them all. hostd refuses those addresses too (validMailBanAddr in
// hostd/mail.go), so allowing them here would only produce rejected pushes.
// ─────────────────────────────────────────────────────────────────────────────

/** Live bans pushed to hostd (hostd refuses a state above 10 000 entries). */
export const MAX_MAIL_BANS = 5000;

export const MAIL_BAN_SERVICES: readonly MailBanService[] = ['smtp', 'submission', 'imap', 'pop3', 'sieve', 'webmail'];

export interface BanGuard {
  /** Docker subnets (mail, account, panel networks): never banned. */
  protectedNets: readonly string[];
  /** The node's public IPv4 / IPv6 (app_config public_ipv4 / public_ipv6). */
  nodeAddresses: readonly string[];
}

/**
 * The ban key of a client address, or null when the address must never be
 * banned (see above) or is invalid.
 */
export function mailBanKey(ip: string, guard: BanGuard): string | null {
  const a = normalizeAddress(ip);
  if (!a) return null;
  if (!isPublicAddress(a.ip)) return null;
  for (const n of guard.nodeAddresses) {
    const node = normalizeAddress(n);
    if (!node) continue;
    if (node.ip === a.ip) return null;
    // The node's own /64 (its other addresses, the Docker IPv6 range routed from it).
    if (a.family === 6 && node.family === 6 && banKey(node.ip) === banKey(a.ip)) return null;
  }
  for (const net of guard.protectedNets) {
    if (cidrContains(net, a.ip)) return null;
  }
  return banKey(a.ip);
}

export function isMailBanService(s: unknown): s is MailBanService {
  return typeof s === 'string' && (MAIL_BAN_SERVICES as readonly string[]).includes(s);
}

/** French label of a service (ban reason). */
export function serviceLabel(s: MailBanService): string {
  switch (s) {
    case 'smtp': return 'SMTP';
    case 'submission': return 'SMTP (soumission)';
    case 'imap': return 'IMAP';
    case 'pop3': return 'POP3';
    case 'sieve': return 'ManageSieve';
    case 'webmail': return 'webmail';
    default: return s;
  }
}

const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

/** hostd PUT /v1/firewall/mail body: the public mail ports and the live bans. */
export function buildMailFirewallState(
  bans: ReadonlyArray<{ ip: string; expiresAt: Date | string }>,
  now: Date,
  ports: readonly number[] = Object.values(MAIL_PUBLIC_PORTS),
): HostdMailFirewallState {
  const live = bans
    .map((b) => ({ ip: b.ip, at: toDate(b.expiresAt) }))
    .filter((b) => Number.isFinite(b.at.getTime()) && b.at.getTime() - now.getTime() >= 1000)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const seen = new Set<string>();
  const out: HostdMailFirewallState['bans'] = [];
  for (const b of live) {
    if (seen.has(b.ip)) continue;
    seen.add(b.ip);
    out.push({ cidr: b.ip, expiresAt: b.at.toISOString() });
    if (out.length >= MAX_MAIL_BANS) break;
  }
  return { ports: [...new Set(ports)].sort((a, b) => a - b), bans: out };
}
