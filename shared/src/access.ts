// =============================================================================
// Oblimint — P2 access allow-list per account (docs/P2-PLAN.md §Pare-feu,
// ARCHITECTURE §3.3–§3.4). Applies to the account's own ports only (file
// server SFTP port, external database ports), enforced by hostd (nftables +
// the userspace gateway that also does socket activation of the file server).
// =============================================================================

/**
 * open      everyone, with bans after repeated authentication failures;
 * allowlist only the addresses / ranges of the account rules (bans still apply);
 * auto-2fa  the rules + the addresses of the account's client sessions that
 *           passed 2FA (grant with TTL, refreshed while the session is active).
 */
export type AccessMode = 'open' | 'allowlist' | 'auto-2fa';

export const ACCESS_MODES: readonly AccessMode[] = ['open', 'allowlist', 'auto-2fa'];

export interface AccessRule {
  id: number;
  accountId: number;
  /** Address or CIDR, IPv4 or IPv6, normalized ('203.0.113.4/32' → '203.0.113.4'). */
  cidr: string;
  label: string | null;
  expiresAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface AccessRuleInput {
  cidr: string;
  label?: string | null;
  /** Optional expiry (ISO), ≥ now + 5 min. */
  expiresAt?: string | null;
}

export type AccessGrantSource = 'session-2fa' | 'probe';

/** Address added automatically (auto-2fa mode). */
export interface AccessGrant {
  id: number;
  accountId: number;
  userId: number;
  username: string | null;
  ip: string;
  family: 4 | 6;
  source: AccessGrantSource;
  expiresAt: string;
  refreshedAt: string;
  createdAt: string;
}

export type BanService = 'sftp' | 'db';

export interface AccessBan {
  id: number;
  accountId: number;
  ip: string;
  service: BanService;
  failures: number;
  reason: string | null;
  expiresAt: string;
  createdAt: string;
}

export type AccountPortKind = 'filesrv' | 'db';

export interface AccountPort {
  kind: AccountPortKind;
  port: number;
  /** db: the instance. */
  dbInstanceId: number | null;
  label: string;
}

/** GET /api/accounts/:id/access */
export interface AccountAccessInfo {
  accountId: number;
  mode: AccessMode;
  /** auto-2fa grant lifetime (minutes, 15 … 1440). */
  grantTtlMinutes: number;
  rules: AccessRule[];
  grants: AccessGrant[];
  bans: AccessBan[];
  ports: AccountPort[];
  /** hostd applied the current state (false: pending / hostd unreachable). */
  applied: boolean;
  appliedAt: string | null;
  /**
   * Last failure of hostd to apply the state (W1: visible, never silent). Raw
   * backend text for staff; a fixed sentence for client users (A6).
   */
  applyError: string | null;
}

export interface AccountAccessUpdate {
  mode?: AccessMode;
  grantTtlMinutes?: number;
}

/** POST /api/access/probe → nonce for the v4-only / v6-only probe hosts. */
export interface IpProbeTicket {
  nonce: string;
  /** https://<v4 probe host>/api/ip-probe?nonce=… (null: not configured). */
  v4Url: string | null;
  v6Url: string | null;
  expiresAt: string;
}

/** GET <probe host>/api/ip-probe?nonce= (public, CORS from the panel origin). */
export interface IpProbeResult {
  ip: string;
  family: 4 | 6;
}

/** GET /api/access/my-ips */
export interface MyIpsInfo {
  /** Address of this request as the panel sees it. */
  seen: string | null;
  /** Addresses recorded by the probes for this session (last 30 min). */
  ipv4: string | null;
  ipv6: string | null;
  /** The session passed 2FA (auto-2fa grants are possible). */
  mfa: boolean;
}

/** GET /api/system/firewall */
export interface FirewallStatus {
  enabled: boolean;
  backend: 'nftables' | 'none';
  lastApplyAt: string | null;
  lastApplyError: string | null;
  gatewayListeners: number;
  egressFilter: 'off' | 'metadata' | 'strict';
}
