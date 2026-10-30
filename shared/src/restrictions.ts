// =============================================================================
// Oblimint — sensitive actions (three-level restrictions), ported from
// Obliance (server/src/services/restriction.service.ts) and adapted:
//
//   none        the action runs freely;
//   sensitive   a FRESH second factor of the acting user (panel: TOTP, or the
//               Obligate code of an SSO staff account; a trusted IP of the
//               last 24 h is honoured in the panel only). Through an access
//               key / connector: a CONFIRMATION by the key's owner, with his
//               code, in the panel (428 to the agent);
//   restricted  an APPROVAL by another authorised person (who also types his
//               own code). Panel: 202 pendingApproval; keys: 428.
//
// One map per tenant (tenants.action_restrictions), scoped by hosting
// accounts / sites (include / exclude) and by surface (`via`: all / keys /
// panel), plus an optional platform floor set by the master tenant
// (platformSettings.restrictions.floor) that no reseller can lower.
// Effective level = max(floor, target tenant's map, request tenant's map in
// god view). An approved request is a single-use token bound to the
// requester, the action and the HMAC of the frozen parameters: the requester
// (human or agent) sends the very same request again and consumes it.
// =============================================================================

export type RestrictionLevel = 'none' | 'restricted' | 'sensitive';
export type RestrictionScopeMode = 'all' | 'include' | 'exclude';
export type RestrictionVia = 'all' | 'keys' | 'panel';

export interface RestrictionScope {
  mode: RestrictionScopeMode;
  accountIds?: number[];
  siteIds?: number[];
}

export interface RestrictionEntry {
  level: Exclude<RestrictionLevel, 'none'>;
  scope: RestrictionScope;
  via: RestrictionVia;
}

export type RestrictionMap = Record<string, RestrictionEntry>;

/** Platform floor: minimal level per action, every tenant (no scope, every surface). */
export type RestrictionFloor = Record<string, Exclude<RestrictionLevel, 'none'>>;

/** Rank of the levels (Obliance restriction.service.ts): none < sensitive < restricted. */
export const RESTRICTION_LEVEL_RANK: Readonly<Record<RestrictionLevel, number>> = { none: 0, sensitive: 1, restricted: 2 };

export const RESTRICTION_LEVELS: readonly RestrictionLevel[] = ['none', 'sensitive', 'restricted'];
export const RESTRICTION_VIAS: readonly RestrictionVia[] = ['all', 'keys', 'panel'];

/** The stricter of two levels. */
export function maxRestrictionLevel(a: RestrictionLevel, b: RestrictionLevel): RestrictionLevel {
  return RESTRICTION_LEVEL_RANK[b] > RESTRICTION_LEVEL_RANK[a] ? b : a;
}

export type RestrictionCategory =
  | 'sites' | 'releases' | 'files' | 'databases' | 'domains' | 'mail' | 'cron' | 'keys' | 'tenant' | 'platform';

export const RESTRICTION_CATEGORIES: readonly RestrictionCategory[] = [
  'sites', 'releases', 'files', 'databases', 'domains', 'mail', 'cron', 'keys', 'tenant', 'platform',
];

/** What the scope of an action targets ('none': tenant / platform action, the scope is ignored). */
export type RestrictionScopable = 'site' | 'account' | 'none';
export type RestrictionSurface = 'panel' | 'keys';

export interface RestrictableActionDef {
  key: string;
  category: RestrictionCategory;
  /**
   * Right an approver must hold on the target: a hosting need
   * (services/hosting/access.ts HostingNeed) for an account / site action,
   * the staff capability (permission set) for a staffOnly one ('platform':
   * platform admins only).
   */
  need: string;
  /** Second right an approver must also hold (mail.dns_fix: mail.manage + dns.manage). */
  alsoNeed?: string;
  scopable: RestrictionScopable;
  /** Where the gate point exists: the panel (session) and / or the access keys (REST v1, MCP). */
  surfaces: readonly RestrictionSurface[];
  /** Staff only: never a client among the approvers. */
  staffOnly?: boolean;
  /** Platform action: read from the master tenant's map only, approved by another platform admin. */
  platform?: boolean;
  /** The action may carry a secret (password, secret env value): only its HMAC is ever kept. */
  secret?: boolean;
}

const P: readonly RestrictionSurface[] = ['panel'];
const K: readonly RestrictionSurface[] = ['keys'];
const PK: readonly RestrictionSurface[] = ['panel', 'keys'];

/** Catalogue of the restrictable actions (spec §2). Labels: i18n restrictions.actions.<key>. */
export const RESTRICTABLE_ACTIONS: readonly RestrictableActionDef[] = [
  // ── Sites and accounts ──
  { key: 'site.delete', category: 'sites', need: 'sites.manage', scopable: 'site', surfaces: P },
  { key: 'site.stop', category: 'sites', need: 'sites.manage', scopable: 'site', surfaces: P },
  { key: 'site.publish_mode_change', category: 'sites', need: 'releases.approve', scopable: 'site', surfaces: PK },
  { key: 'site.data_path_remove', category: 'sites', need: 'sites.manage', scopable: 'site', surfaces: PK },
  { key: 'site.runtime_remove', category: 'sites', need: 'sites.manage', scopable: 'site', surfaces: PK },
  { key: 'site.env_write', category: 'sites', need: 'sites.manage', scopable: 'site', surfaces: PK, secret: true },
  { key: 'account.suspend', category: 'sites', need: 'accounts.manage', scopable: 'account', surfaces: P, staffOnly: true },
  { key: 'account.delete', category: 'sites', need: 'accounts.manage', scopable: 'account', surfaces: P, staffOnly: true },
  { key: 'account.client_users', category: 'sites', need: 'accounts.manage', scopable: 'account', surfaces: P, staffOnly: true },
  { key: 'account.sftp_credentials', category: 'sites', need: 'files.manage', scopable: 'account', surfaces: P, secret: true },
  // ── Releases, windows, backups ──
  { key: 'release.publish', category: 'releases', need: 'releases.publish', scopable: 'site', surfaces: PK },
  { key: 'release.publish_override_rollback', category: 'releases', need: 'releases.publish', scopable: 'site', surfaces: PK },
  { key: 'release.rollback', category: 'releases', need: 'releases.publish', scopable: 'site', surfaces: PK },
  { key: 'release.approve_override_scan', category: 'releases', need: 'sites.manage', scopable: 'site', surfaces: P, staffOnly: true },
  { key: 'release.restore_to_staging', category: 'releases', need: 'files.manage', scopable: 'site', surfaces: PK },
  { key: 'window.reject_db_restore', category: 'releases', need: 'databases.manage', scopable: 'site', surfaces: P },
  { key: 'backup.restore', category: 'releases', need: 'files.manage', scopable: 'account', surfaces: P },
  { key: 'backup.disable', category: 'releases', need: 'accounts.manage', scopable: 'account', surfaces: P, staffOnly: true },
  { key: 'snapshot.restore', category: 'releases', need: 'databases.manage', scopable: 'site', surfaces: P },
  { key: 'snapshot.delete', category: 'releases', need: 'databases.manage', scopable: 'site', surfaces: P },
  // ── Files ──
  { key: 'files.delete', category: 'files', need: 'files.manage', scopable: 'account', surfaces: PK },
  { key: 'files.write', category: 'files', need: 'files.manage', scopable: 'account', surfaces: PK },
  // ── Databases ──
  { key: 'db.instance_drop', category: 'databases', need: 'databases.manage', scopable: 'account', surfaces: P },
  { key: 'db.external_access', category: 'databases', need: 'databases.manage', scopable: 'account', surfaces: P },
  { key: 'db.drop', category: 'databases', need: 'databases.manage', scopable: 'account', surfaces: PK },
  { key: 'db.import', category: 'databases', need: 'databases.manage', scopable: 'account', surfaces: PK },
  { key: 'db.user_password_reset', category: 'databases', need: 'databases.manage', scopable: 'account', surfaces: PK, secret: true },
  { key: 'db.user_delete', category: 'databases', need: 'databases.manage', scopable: 'account', surfaces: PK },
  { key: 'db.user_grants', category: 'databases', need: 'databases.manage', scopable: 'account', surfaces: PK },
  { key: 'db.query_write', category: 'databases', need: 'databases.manage', scopable: 'account', surfaces: PK },
  { key: 'db.ddl', category: 'databases', need: 'databases.manage', scopable: 'account', surfaces: P },
  { key: 'db.rows_write', category: 'databases', need: 'databases.manage', scopable: 'account', surfaces: P },
  { key: 'db.dump', category: 'databases', need: 'databases.manage', scopable: 'account', surfaces: K },
  // ── Domains, DNS, proxy, firewall ──
  { key: 'domain.delete', category: 'domains', need: 'domains.manage', scopable: 'account', surfaces: P },
  { key: 'domain.route_change', category: 'domains', need: 'domains.manage', scopable: 'account', surfaces: PK },
  { key: 'subdomain.remove', category: 'domains', need: 'domains.manage', scopable: 'account', surfaces: K },
  { key: 'dns.zone_delete', category: 'domains', need: 'dns.manage', scopable: 'account', surfaces: P },
  { key: 'dns.zone_reset', category: 'domains', need: 'dns.manage', scopable: 'account', surfaces: P },
  { key: 'dns.template_apply', category: 'domains', need: 'dns.manage', scopable: 'account', surfaces: P },
  { key: 'dns.record_write', category: 'domains', need: 'dns.manage', scopable: 'account', surfaces: P },
  { key: 'mail.dns_fix', category: 'domains', need: 'mail.manage', alsoNeed: 'dns.manage', scopable: 'account', surfaces: P },
  { key: 'proxy.host_delete', category: 'domains', need: 'proxy.manage', scopable: 'account', surfaces: P },
  { key: 'firewall.mode_change', category: 'domains', need: 'files.manage', scopable: 'account', surfaces: P },
  { key: 'firewall.rules_write', category: 'domains', need: 'files.manage', scopable: 'account', surfaces: P },
  // ── Mail ──
  { key: 'mail.domain_delete', category: 'mail', need: 'mail.manage', scopable: 'account', surfaces: P },
  { key: 'mail.mailbox_delete', category: 'mail', need: 'mail.manage', scopable: 'account', surfaces: P },
  { key: 'mail.mailbox_password', category: 'mail', need: 'mail.manage', scopable: 'account', surfaces: P, secret: true },
  { key: 'mail.dkim_rotate', category: 'mail', need: 'mail.manage', scopable: 'account', surfaces: P },
  // ── Cron, previews ──
  { key: 'cron.write', category: 'cron', need: 'sites.manage', scopable: 'site', surfaces: PK },
  { key: 'cron.delete', category: 'cron', need: 'sites.manage', scopable: 'site', surfaces: PK },
  { key: 'cron.run', category: 'cron', need: 'sites.manage', scopable: 'site', surfaces: PK },
  { key: 'preview.db_clone', category: 'cron', need: 'databases.manage', scopable: 'site', surfaces: PK },
  { key: 'preview.share_link_with_db', category: 'cron', need: 'sites.manage', scopable: 'site', surfaces: PK },
  // ── Access keys and connectors ──
  { key: 'apikey.create', category: 'keys', need: 'sites.manage', scopable: 'account', surfaces: P },
  { key: 'apikey.widen', category: 'keys', need: 'sites.manage', scopable: 'account', surfaces: P },
  { key: 'connector.authorize', category: 'keys', need: 'sites.manage', scopable: 'account', surfaces: P },
  { key: 'apikey.revoke', category: 'keys', need: 'sites.manage', scopable: 'account', surfaces: P },
  { key: 'connector.rotate', category: 'keys', need: 'sites.manage', scopable: 'account', surfaces: P, secret: true },
  // ── Tenant and users (staff) ──
  { key: 'restrictions.manage', category: 'tenant', need: 'settings', scopable: 'none', surfaces: P, staffOnly: true },
  { key: 'user.create', category: 'tenant', need: 'users.manage', scopable: 'none', surfaces: P, staffOnly: true, secret: true },
  { key: 'user.update', category: 'tenant', need: 'users.manage', scopable: 'none', surfaces: P, staffOnly: true },
  { key: 'user.delete', category: 'tenant', need: 'users.manage', scopable: 'none', surfaces: P, staffOnly: true },
  { key: 'user.password_reset', category: 'tenant', need: 'users.manage', scopable: 'none', surfaces: P, staffOnly: true, secret: true },
  { key: 'user.2fa_reset', category: 'tenant', need: 'users.manage', scopable: 'none', surfaces: P, staffOnly: true },
  { key: 'user.tenants_set', category: 'tenant', need: 'users.manage', scopable: 'none', surfaces: P, staffOnly: true },
  // ── Platform (master tenant's map only) ──
  { key: 'platform.tenant_delete', category: 'platform', need: 'platform', scopable: 'none', surfaces: P, staffOnly: true, platform: true },
  { key: 'platform.permission_sets', category: 'platform', need: 'platform', scopable: 'none', surfaces: P, staffOnly: true, platform: true },
  { key: 'platform.hosting_settings', category: 'platform', need: 'platform', scopable: 'none', surfaces: P, staffOnly: true, platform: true },
  { key: 'platform.app_config', category: 'platform', need: 'platform', scopable: 'none', surfaces: P, staffOnly: true, platform: true, secret: true },
  { key: 'platform.key_security', category: 'platform', need: 'platform', scopable: 'none', surfaces: P, staffOnly: true, platform: true },
  { key: 'platform.ban_lift', category: 'platform', need: 'platform', scopable: 'none', surfaces: P, staffOnly: true, platform: true },
  { key: 'platform.update_apply', category: 'platform', need: 'platform', scopable: 'none', surfaces: P, staffOnly: true, platform: true },
  { key: 'platform.migration_cutover', category: 'platform', need: 'platform', scopable: 'none', surfaces: P, staffOnly: true, platform: true },
  { key: 'platform.backup_destinations', category: 'platform', need: 'platform', scopable: 'none', surfaces: P, staffOnly: true, platform: true, secret: true },
] as const;

export type RestrictableActionKey = string;

const ACTION_INDEX: ReadonlyMap<string, RestrictableActionDef> = new Map(RESTRICTABLE_ACTIONS.map((a) => [a.key, a]));

/** Catalogue entry of an action key, or null. */
export function restrictableAction(key: string): RestrictableActionDef | null {
  return ACTION_INDEX.get(key) ?? null;
}

/** An action key of the matrix: forward-compatible, never an arbitrary field name (Obliance isActionKey). */
export function isActionKey(key: string): boolean {
  return typeof key === 'string' && key.length <= 100 && /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(key);
}

/**
 * Recommended defaults (spec §2), seeded into every tenant whose map is empty
 * (migration 027) and into every new tenant. 'none' is never stored.
 */
export const DEFAULT_RESTRICTIONS: Readonly<RestrictionMap> = {
  'site.delete': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'site.publish_mode_change': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'account.delete': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'release.publish_override_rollback': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'release.approve_override_scan': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'window.reject_db_restore': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'backup.restore': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'backup.disable': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'snapshot.restore': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'db.instance_drop': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'db.external_access': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'db.drop': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'db.import': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  // Free SQL in write mode: only in the hands of an agent (the panel's explorer stays free).
  'db.query_write': { level: 'sensitive', scope: { mode: 'all' }, via: 'keys' },
  'db.ddl': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'domain.delete': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'dns.zone_delete': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'dns.zone_reset': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'firewall.mode_change': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'mail.domain_delete': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'mail.mailbox_delete': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'preview.share_link_with_db': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'apikey.create': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'apikey.widen': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'connector.authorize': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'user.2fa_reset': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'platform.tenant_delete': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'platform.key_security': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
  'platform.migration_cutover': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' },
};

/** Defaults a tenant map is seeded with: the master keeps the platform entries, the others never get them. */
export function defaultRestrictionsFor(tenantIsMaster: boolean): RestrictionMap {
  const out: RestrictionMap = {};
  for (const [k, v] of Object.entries(DEFAULT_RESTRICTIONS)) {
    if (!tenantIsMaster && restrictableAction(k)?.platform) continue;
    out[k] = { level: v.level, scope: { ...v.scope }, via: v.via };
  }
  return out;
}

// ── API ──────────────────────────────────────────────────────────────────────

/** GET /api/restrictions */
export interface RestrictionsView {
  map: RestrictionMap;
  floor: RestrictionFloor;
  /** Catalogue entries this viewer can edit (platform ones on the master tenant for a platform admin only). */
  actions: RestrictableActionDef[];
  /** The viewer is a platform admin on the master tenant: platform actions and floor editable. */
  canEditPlatform: boolean;
  pendingTtlMinutes: number;
  stats: {
    /** Active members of the tenant (staff) and client logins of its accounts without any second factor. */
    withoutTotp: { staff: number; clients: number };
  };
}

/** PUT /api/restrictions */
export interface RestrictionsUpdate {
  map: Record<string, RestrictionEntry | Exclude<RestrictionLevel, 'none'>>;
}

/** PUT /api/restrictions/floor (platform admin on the master tenant). */
export interface RestrictionsFloorUpdate {
  floor: RestrictionFloor;
}

// ── Pending actions (confirmations / approvals) ──────────────────────────────

export type PendingActionStatus = 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired' | 'consumed';
export type PendingActionKind = 'confirm' | 'approve';
export type PendingActionVia = 'panel' | 'key' | 'connector';
export type PendingActionDecidedVia = 'totp' | 'second_person';

export const PENDING_ACTION_STATUSES: readonly PendingActionStatus[] = ['pending', 'approved', 'denied', 'cancelled', 'expired', 'consumed'];

/** Machine codes of the gate's refusals (AppError.code). */
export const PENDING_ACTION_CODES = ['twoFactorRequired', 'approvalRequired', 'twoFactorNotEnrolled', 'noEligibleApprover', 'approvalMismatch'] as const;
export type PendingActionCode = typeof PENDING_ACTION_CODES[number];

/** Default lifetime of a pending request, and of an approved one before it is consumed (minutes). */
export const PENDING_ACTION_TTL_MINUTES = 30;
export const PENDING_ACTION_CONSUME_MINUTES = 15;
/** Resolved requests kept this long, then purged. */
export const PENDING_ACTION_RETENTION_DAYS = 90;
/** "Trust this IP" window of a panel step-up (sensitive actions only, never keys). */
export const ACTION_TRUSTED_IP_HOURS = 24;

/** Header of a panel / REST re-submission naming its approval (optional: the HMAC finds it). */
export const PENDING_ACTION_HEADER = 'X-Oblimint-Approval';

/** Message given to the agent (428) — French, as asked by the owner. */
export const PENDING_ACTION_USER_MESSAGE_FR = 'Autoriser l\'action avec un 2FA téléphone ou un code via l\'interface';
export const PENDING_ACTION_USER_MESSAGE_EN = 'Authorise the action with a phone 2FA or a code in the panel';

export interface PendingActionUserRef {
  id: number;
  username: string;
  displayName: string | null;
}

export interface PendingAction {
  id: number;
  tenantId: number;
  accountId: number | null;
  siteId: number | null;
  action: string;
  level: Exclude<RestrictionLevel, 'none'>;
  kind: PendingActionKind;
  status: PendingActionStatus;
  via: PendingActionVia;
  requestedBy: PendingActionUserRef | null;
  apiKey: { id: number; name: string } | null;
  requestIp: string | null;
  userAgent: string | null;
  /** Parameters shown to the decider (secret-named fields masked; secrets never stored). */
  params: Record<string, unknown>;
  /** French text of what will run. */
  description: string;
  decidedBy: PendingActionUserRef | null;
  decidedAt: string | null;
  decidedVia: PendingActionDecidedVia | null;
  reason: string | null;
  executionError: string | null;
  expiresAt: string;
  consumeBy: string | null;
  consumedAt: string | null;
  createdAt: string;
  /** What the viewer may do on it. */
  can: { confirm: boolean; approve: boolean; deny: boolean; cancel: boolean };
}

export type PendingActionTab = 'todo' | 'mine' | 'history';

/** GET /api/pending-actions?tab= */
export interface PendingActionList {
  items: PendingAction[];
  /** Requests waiting for this viewer (confirmations + approvals he may give). */
  todoCount: number;
}

/** 202 of a panel request at the restricted level. */
export interface PendingApprovalResponse {
  status: 'pendingApproval';
  pendingActionId: number;
  expiresAt: string;
  description: string;
}

/** details of the 428 given to an access key / connector. */
export interface PendingActionRequiredDetails {
  pendingActionId: number;
  status: PendingActionStatus;
  level: Exclude<RestrictionLevel, 'none'>;
  action: string;
  description: string;
  expiresAt: string;
  approveUrl: string;
  userMessage: string;
  next: string;
}

/** Socket events (rooms user:<id> of the requester and of the deciders). */
export const PendingActionSocketEvents = {
  /** { tenantId, pendingAction: { id, status, action, level, kind } } */
  UPDATED: 'PENDING_ACTION_UPDATED',
} as const;
