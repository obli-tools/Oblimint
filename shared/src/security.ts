// =============================================================================
// Oblimint — P4b honeypot + web bans (docs/P4b-PLAN.md §9). ARCHITECT FILE
// (frozen during the phase). Module honeypot-bans (server + hostd web bans),
// ui-proxy (Bans page).
//
// Bans of the HTTP edge (ports 80 / 443). Scope:
//   account   produced by the honeypot / ACL trap of ONE account's hosts (or
//             manual by that account): enforced by nginx on that account's
//             hosts only (sites + proxy objects);
//   platform  decided by platform staff (manual, Obliguard sync, promotion of
//             an account ban): enforced by nginx on EVERY vhost AND by
//             nftables (hostd PUT /v1/firewall/web) on 80/443.
// Never a private / loopback / link-local / CGNAT / ULA address, nor one of
// settings bans.neverBan, nor the node's own addresses.
// =============================================================================

export type WebBanSource = 'honeypot-path' | 'honeypot-acl' | 'manual' | 'obliguard-sync' | 'promotion'
  // IP security of the access keys / MCP: an address outside every key (strict mode, permanent),
  // repeated bad keys from an allowed address (escalating).
  | 'key-intrusion' | 'key-bruteforce';
export type WebBanScope = 'account' | 'platform';
export type ObliguardSyncStatus = 'disabled' | 'pending' | 'sent' | 'failed';

export interface GeoInfo {
  countryCode: string | null;
  countryName: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  org: string | null;
}

export interface WebBan {
  id: number;
  /** IPv4 address, or IPv6 /64 (CIDR form). */
  ip: string;
  scope: WebBanScope;
  tenantId: number;
  accountId: number | null;
  accountUsername: string | null;
  source: WebBanSource;
  /** `<uri> on <host>` for honeypot bans (sanitized, ≤ 300 chars). */
  reason: string | null;
  proxyHostId: number | null;
  proxyHostName: string | null;
  /** null = permanent. */
  bannedUntil: string | null;
  hitCount: number;
  /** Escalation level reached (1 = first offence). */
  offenseLevel: number;
  firstSeenAt: string;
  lastSeenAt: string;
  active: boolean;
  obliguardStatus: ObliguardSyncStatus;
  createdBy: string | null;
  geo: GeoInfo | null;
  createdAt: string;
}

export interface WebBanQuery {
  scope?: WebBanScope;
  accountId?: number;
  tenantId?: number;
  active?: boolean;
  source?: WebBanSource;
  proxyHostId?: number;
  /** Search: IP, reason, city, org. */
  q?: string;
  limit?: number;
  offset?: number;
}

export interface WebBanList {
  items: WebBan[];
  total: number;
}

export interface WebBanCreate {
  ip: string;
  scope: WebBanScope;
  /** account scope: the account (proxy.manage on it). platform scope: platform admin only. */
  accountId?: number | null;
  /** null = permanent; absent = escalation default. */
  durationMinutes?: number | null;
  reason?: string | null;
}

export interface WebBanStats {
  active: number;
  platform: number;
  account: number;
  last24h: number;
  bySource: Record<WebBanSource, number>;
}

export type HoneypotPresetCategory = 'wordpress' | 'secrets' | 'vcs' | 'admin' | 'java' | 'php' | 'iot' | 'other';

export interface HoneypotPreset {
  path: string;
  category: HoneypotPresetCategory;
}

/** Ports + platform bans pushed to hostd PUT /v1/firewall/web (server/src/services/hostd/client.ts). */
export interface WebFirewallSummary {
  ports: number[];
  bans: number;
  lastPushAt: string | null;
  lastPushError: string | null;
}
