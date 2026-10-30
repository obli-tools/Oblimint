// =============================================================================
// Oblimint — Shared Types
// =============================================================================

// ─── USERS ────────────────────────────────────────────────────────────────────

/**
 * `staff`  = panel operators (platform or tenant staff), may sign in through Obligate.
 * `client` = end customers of a hosting account, local accounts only (no SSO).
 */
export type UserKind = 'staff' | 'client';

export type UserRole = 'admin' | 'user';

export interface User {
  id: number;
  username: string;
  displayName: string | null;
  role: UserRole;
  kind: UserKind;
  isActive: boolean;
  email: string | null;
  /** GET /api/profile only: the address is proven (a password reset link can go to it). */
  emailVerified?: boolean;
  preferredLanguage: string;
  preferences: UserPreferences;
  totpEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  // SSO
  foreignSource: string | null;
  foreignId: number | null;
  foreignSourceUrl: string | null;
  hasPassword: boolean;
  avatar: string | null;
}

/**
 * Web theme ids — identical to the other Obli apps (the choice is owned by
 * Obligate and applied through `preferences.preferredTheme`).
 */
export type AppTheme = 'obli-operator' | 'modern' | 'neon' | 'obli-daylight' | 'obli-dim';

export interface UserPreferences {
  toastEnabled?: boolean;
  toastPosition?: 'top-center' | 'bottom-right';
  sidebarFloating?: boolean;
  preferredTheme?: AppTheme;
  anonymousMode?: boolean;
}

// ─── TENANTS (= reseller workspaces) ─────────────────────────────────────────

/**
 * Resource envelope granted to a tenant (reseller). `null` = unlimited.
 * Sizes in MiB, traffic in MiB per calendar month.
 */
export interface TenantLimits {
  diskMb: number | null;
  trafficMbPerMonth: number | null;
  maxAccounts: number | null;
  maxSites: number | null;
  maxDomains: number | null;
  maxMailboxes: number | null;
  maxDatabases: number | null;
  cpuCores: number | null;
  /** Site containers of the accounts PLUS their database instances (plan maxDbInstances × DB_PROFILE_MEMORY_MB[dbProfile]). */
  memoryMb: number | null;
  /** Allow the tenant to allocate more than its envelope through plans. */
  allowOversell: boolean;
}

export interface Tenant {
  id: number;
  name: string;
  slug: string;
  limits: TenantLimits;
  /** "An IP is mandatory on the access keys" for this workspace; null = the platform setting (keySecurity.requireIp). */
  keyRequireIp?: boolean | null;
  createdAt: string;
  updatedAt: string;
}

export interface TenantWithRole extends Tenant {
  /** Permission-set slug of the caller on this tenant (admin, user, viewer, custom…). */
  role: string;
}

// ─── PERMISSION SETS ─────────────────────────────────────────────────────────

export interface PermissionSet {
  id: number;
  name: string;
  slug: string;
  capabilities: string[];
  isDefault: boolean;
  /** Capabilities fixed by the server ('admin': everything, 'client': nothing). */
  locked: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── NODES (§3.7 — v1 has a single local node) ───────────────────────────────

export type NodeEngineType = 'local' | 'ssh' | 'tls';

export interface PanelNode {
  id: number;
  name: string;
  engineType: NodeEngineType;
  isLocal: boolean;
  createdAt: string;
}

// ─── API ─────────────────────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  details?: unknown;
}

export interface ObligateConfig {
  url: string | null;
  apiKeySet: boolean;
  enabled: boolean;
  inboundSecretSet?: boolean;
  inboundSecretFromEnv?: boolean;
}

// ─── FIRST-RUN SETUP (docs/P0-PLAN.md §Setup) ────────────────────────────────

export type SetupMode = 'setup' | 'normal';

export type HostCheckStatus = 'ok' | 'warn' | 'fail';

export interface HostCheck {
  id: string;
  /** i18n key of the check label, e.g. `setup.checks.docker`. */
  labelKey: string;
  status: HostCheckStatus;
  /** Short factual finding (technical, not translated: versions, paths…). */
  detail: string;
  /** i18n key of the remediation hint shown when status !== 'ok'. */
  fixKey?: string;
  /** Copy-pasteable command(s) that fix the issue, when there is one. */
  fixCommand?: string;
}

export type MailEngine = 'postfix-dovecot' | 'stalwart' | 'docker-mailserver' | 'maddy' | 'external';

export interface SetupApplyRequest {
  panelHostname: string;
  publicIpv4: string | null;
  publicIpv6: string | null;
  nameservers: string[];
  acmeEmail: string;
  mailEngine: MailEngine;
  /** P2: registrable domain dedicated to previews (never under the panel host), optional. */
  previewDomain?: string | null;
  admin: { username: string; password: string; email: string | null };
  obligate: { url: string; apiKey: string } | null;
}

export type SetupStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';

export interface SetupStep {
  id: string;
  labelKey: string;
  status: SetupStepStatus;
  log: string[];
}

export interface SetupProgress {
  started: boolean;
  done: boolean;
  error: string | null;
  steps: SetupStep[];
}

// ─── DASHBOARD ───────────────────────────────────────────────────────────────

export interface DashboardSummary {
  accounts: number;
  sites: number;
  domains: number;
  mailboxes: number;
  databases: number;
  tenants: number;
  users: number;
  nodes: number;
}

/** GET /api/dashboard/overview — health and activity, scoped to the caller like the summary. */
export interface DashboardOverview {
  sites: {
    total: number;
    byStatus: { active: number; stopped: number; error: number; provisioning: number };
    /** Sites in error (first 8). */
    problems: Array<{ id: number; name: string; primaryDomain: string | null; statusMessage: string | null }>;
  };
  /** Waiting for someone (counts). */
  pending: {
    approvals: number;
    windowsToReview: number;
    quarantined: number;
    /** Releases failed in the last 24 h. */
    failedReleases: number;
    domainsUnverified: number;
  };
  /** Latest publications (8). */
  releases: Array<{
    id: number; siteId: number; siteName: string; number: number; status: string; trigger: string;
    message: string | null; createdAt: string; publishedAt: string | null;
  }>;
  certificates: {
    /** Valid certificates ending within 14 days. */
    expiring: Array<{ name: string; notAfter: string }>;
    failed: Array<{ name: string; error: string | null }>;
  };
  uptime: {
    up: number; down: number; paused: number; pending: number;
    downList: Array<{ id: number; name: string; lastError: string | null; lastCheckedAt: string | null }>;
  };
  /** Staff only: latest audit events of the workspace (god view: every workspace). */
  activity: Array<{ id: number; action: string; username: string | null; resourceType: string | null; resourceName: string | null; createdAt: string; tenantName: string | null }>;
}

// ─── AUTH / PERMISSIONS (ported from Obliance, same shapes) ──────────────────

export interface LoginRequest {
  username: string;
  password: string;
  totpCode?: string;
}

/**
 * Sent by `GET /api/auth/me` and `GET /api/auth/permissions`. Oblimint has no
 * teams: `teams` is always empty and `permissions` always `{}` (kept for
 * shape compatibility with the Obliance client modules).
 */
export interface UserPermissions {
  canCreate: boolean;
  teams: number[];
  permissions: Record<string, 'ro' | 'rw'>;
  /** Capabilities of the caller's permission set on the current tenant.
   *  Always empty for platform admins — they bypass every gate. */
  tenantCapabilities: string[];
}

/** One row of `GET /api/users/:id/tenants`. */
export interface UserTenantAssignment {
  tenantId: number;
  tenantName: string;
  tenantSlug: string;
  isMember: boolean;
  /** 'admin' or a permission set slug ('user' by default). */
  role: string;
}

/** `GET /api/permission-sets/capabilities` item. */
export interface CapabilityDef {
  key: string;
  label: string;
}

/** `GET /api/admin/config` (string values, like Obliance). */
export interface AppConfigData {
  allow_2fa: string;
  force_2fa: string;
  app_name: string;
  default_language: string;
  obligate_url: string | null;
  obligate_enabled: string;
  panel_hostname: string | null;
  /** Optional client space host name (same panel, clients only, own certificate). */
  client_panel_hostname: string | null;
  public_ipv4: string | null;
  public_ipv6: string | null;
  /** JSON array of nameserver host names, as a string. */
  nameservers: string | null;
  acme_email: string | null;
  mail_engine: string | null;
}

// ─── AUDIT ───────────────────────────────────────────────────────────────────

/** One row of `GET /api/audit-log` (alias `GET /api/audit`). */
export interface AuditLogRow {
  id: number;
  tenantId: number;
  tenantName: string | null;
  userId: number | null;
  username: string | null;
  action: string;
  resourceType: string | null;
  resourcePath: string | null;
  resourceName: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  /** Access key that performed the action (/api/v1 or /mcp), from `details.apiKey`. */
  apiKeyId: number | null;
  apiKeyName: string | null;
  createdAt: string;
}

/** One entry of `GET /api/audit/distinct-keys`: a key seen in the log. */
export interface AuditApiKeyRef {
  id: number;
  name: string;
}

// ─── SOCKET.IO ───────────────────────────────────────────────────────────────

export const SocketEvents = {
  /** Server → client: a setting / the tenant list changed, refetch. */
  TENANTS_CHANGED: 'TENANTS_CHANGED',
  /** Server → client: the session was ended server-side. */
  SESSION_ENDED: 'SESSION_ENDED',
} as const;
export type SocketEventName = typeof SocketEvents[keyof typeof SocketEvents];

/** Accent colour of Oblimint, announced to Obligate (self-info). Provisional. */
export const APP_COLOR = '#98E8C8';
