// =============================================================================
// Oblimint — IP security of the access keys and MCP connectors (spec §5).
//
// Owner rules: every key may list its allowed addresses; a platform switch
// (overridable per tenant) makes the list mandatory; when EVERY active key
// is closed (non-empty list), the union of the lists becomes the platform's
// allow-list for /mcp, /api/v1 and /oauth/token, and any other address that
// knocks there is banned at once, without end (strict mode). Repeated bad
// keys from an allowed address: escalating bans. The outbound ranges
// published by Anthropic (claude.ai connectors) are always allowed and never
// banned. Strict mode first ships in log-only for 48 h (counted from the
// first run of the guard on the install), then turns on by itself unless a
// platform admin chose otherwise.
// =============================================================================

/** Outbound addresses of Anthropic (claude.ai connectors), platform.claude.com/docs/en/api/ip-addresses. */
export const ANTHROPIC_OUTBOUND_RANGES: readonly string[] = ['160.79.104.0/21'];

/**
 * auto  log-only until autoStrictAt (first run + 48 h), then on;
 * off   never bans an address outside the allow-list (failures still count);
 * log   journals "would have banned" only;
 * on    strict.
 */
export type KeyStrictMode = 'auto' | 'off' | 'log' | 'on';

export const KEY_STRICT_MODES: readonly KeyStrictMode[] = ['auto', 'off', 'log', 'on'];

/** Hours of log-only before 'auto' becomes strict. */
export const KEY_STRICT_LOG_HOURS = 48;

export interface KeySecuritySettings {
  /** Platform default of "an IP is mandatory on the keys" (tenants.key_require_ip overrides). */
  requireIp: boolean;
  strictMode: KeyStrictMode;
  /** ISO time 'auto' switches to strict (set at the first run of the guard); null: not started yet. */
  autoStrictAt: string | null;
  /** Bad keys tolerated from an allowed address in the window before an (escalating) ban. */
  maxFailures: number;
  failureWindowMinutes: number;
  /** Addresses / CIDR never banned ("trusted IPs"). */
  trustedIps: string[];
  /** Source ranges of the connectors (always allowed for a connector, never banned). */
  connectorSourceRanges: string[];
}

export const DEFAULT_KEY_SECURITY_SETTINGS: KeySecuritySettings = {
  requireIp: false,
  strictMode: 'auto',
  autoStrictAt: null,
  maxFailures: 5,
  failureWindowMinutes: 15,
  trustedIps: [],
  connectorSourceRanges: [...ANTHROPIC_OUTBOUND_RANGES],
};

export type KeyStrictEffective = 'off' | 'log' | 'on';

/** What the strict mode amounts to right now. */
export function effectiveKeyStrictMode(s: Pick<KeySecuritySettings, 'strictMode' | 'autoStrictAt'>, now: number = Date.now()): KeyStrictEffective {
  if (s.strictMode !== 'auto') return s.strictMode;
  if (!s.autoStrictAt) return 'log';
  const at = Date.parse(s.autoStrictAt);
  return Number.isFinite(at) && now >= at ? 'on' : 'log';
}

/** Regime of the key surfaces: strict (allow-list = union of the closed keys) or watch (an open key, or no key). */
export type KeySurfaceRegime = 'strict' | 'watch';

export interface KeySecurityOpenKey {
  id: number;
  name: string;
  kind: 'key' | 'connector';
  tenantId: number;
  tenantName: string | null;
  accountId: number;
  accountUsername: string | null;
  owner: string | null;
}

/** GET /api/system/key-security/status */
export interface KeySecurityStatus {
  regime: KeySurfaceRegime;
  strictMode: KeyStrictEffective;
  autoStrictAt: string | null;
  openKeys: KeySecurityOpenKey[];
  /** Active keys / connectors counted (expired, deleting accounts, inactive owners and idle connectors left out). */
  activeKeys: number;
  allowListSize: number;
  currentIp: string | null;
  currentIpCovered: boolean;
  /** Why the current address is covered (allow-list, trusted, connector range, platform-admin session, never banned). */
  currentIpCoverage: KeyIpCoverage | null;
  staffSessionIps: string[];
  lastBan: { ip: string; source: string; at: string } | null;
  /** strictMode log: addresses that would have been banned (latest first). */
  wouldHaveBanned: Array<{ ip: string; surface: string; at: string }>;
}

export type KeyIpCoverage = 'allowList' | 'trusted' | 'connectorRange' | 'adminSession' | 'neverBanned';

/** Surfaces watched by the guard (/mcp, /api/v1, /oauth/token). */
export type KeySurface = 'mcp' | 'key-api' | 'oauth-token';

/** PUT /api/system/key-security (autoStrictAt is the guard's own). */
export type KeySecuritySettingsUpdate = Partial<Omit<KeySecuritySettings, 'autoStrictAt'>>;

/** Why a key was refused (verify / verifyAccessToken / contextFor). */
export type ApiKeyVerifyFailure =
  | 'unknown' | 'malformed' | 'expired' | 'revoked' | 'ipNotAllowed' | 'ipRequired' | 'ownerInactive' | 'accountDeleting';
