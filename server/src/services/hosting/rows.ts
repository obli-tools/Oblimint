import type {
  AccessMode, DnsZoneKind, DomainVerificationMethod, DomainVerificationStatus, OverQuotaState,
  AccountSshKey, AppProfileId, CertificateSummary, ClientCapability, DataPathPolicy, Domain, HostingAccount, PhpSettings,
  Plan, PlanLimits, Release, ReleaseDetail, ReleaseLogLine, ScanSummary, Site, SiteBaseId, SiteDataPath, SiteRoute,
} from '@oblimint/shared';
import { CLIENT_CAPABILITIES, DEFAULT_PLAN_LIMITS } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Raw rows of the P1 tables (migration 002_hosting_core) and their mappers to
// the @oblimint/shared API shapes. Every module maps through these functions
// so a given object always has the same shape whatever the route.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanRow {
  id: number; tenant_id: number; name: string; description: string | null; limits: unknown;
  is_active: boolean; created_at: Date | string; updated_at: Date | string;
  /** joined */ tenant_name?: string | null; account_count?: number | string | null;
}

export interface AccountRow {
  id: number; tenant_id: number; node_id: number; plan_id: number; username: string; display_name: string | null;
  status: HostingAccount['status']; status_message: string | null; uid: number; gid: number;
  disk_used_bytes: number | string | null; quota_mode: 'xfs' | 'measured' | null; usage_checked_at: Date | string | null;
  filesrv_mode: 'always' | 'on-demand' | 'off'; filesrv_port: number | null; filesrv_active_until: Date | string | null;
  filesrv_password_hash: string | null;
  /** P2 (migration 003) */
  access_mode?: AccessMode; access_grant_ttl_min?: number; access_applied_at?: Date | string | null;
  access_apply_error?: string | null; over_quota_state?: OverQuotaState; over_quota_since?: Date | string | null;
  created_at: Date | string; updated_at: Date | string;
  /** joined */ tenant_name?: string | null; plan_name?: string | null; plan_limits?: unknown;
  site_count?: number | string | null; domain_count?: number | string | null; primary_domain?: string | null;
}

export interface SiteRow {
  id: number; tenant_id: number; account_id: number; name: string; slug: string; base: SiteBaseId;
  app_profile: AppProfileId | null; docroot: string; base_path: string; publish_mode: Site['publishMode'];
  publish_debounce_sec: number; healthcheck_path: string; status: Site['status']; status_message: string | null;
  current_release_id: number | null; preview_base: SiteBaseId | null; php_settings: unknown; custom_nginx: string | null;
  created_at: Date | string; updated_at: Date | string;
  /** joined */ account_username?: string; current_release_number?: number | null; primary_domain?: string | null;
}

export interface SiteRuntimeRow { id: number; site_id: number; base: SiteBaseId; created_at: Date | string }

export interface DataPathRow {
  id: number; site_id: number; path: string; policy: DataPathPolicy; allowed_extensions: unknown;
  source: 'profile' | 'manual'; created_at: Date | string;
}

export interface DomainRow {
  id: number; tenant_id: number; account_id: number; name: string; kind: Domain['kind']; include_www: boolean;
  tls_mode: Domain['tlsMode']; force_https: boolean; created_at: Date | string; updated_at: Date | string;
  /** P2 (migration 003) */
  wildcard?: boolean; verification_status?: DomainVerificationStatus; verification_method?: DomainVerificationMethod | null;
  verification_token?: string; verified_at?: Date | string | null; verification_checked_at?: Date | string | null;
  verification_next_check_at?: Date | string | null; verification_error?: string | null;
  /** joined */ account_username?: string;
}

/** DNS zone holding a domain name (toDomain 4th argument). */
export interface DomainZoneRef { id: number; name: string; kind: DnsZoneKind }

export interface RouteRow {
  id: number; account_id: number; domain_id: number; path_prefix: string; site_id: number; runtime_id: number | null;
  created_at: Date | string;
  /** joined */ domain_name?: string; site_name?: string; runtime_base?: SiteBaseId | null;
}

export interface ReleaseRow {
  id: number; site_id: number; number: number; commit_sha: string | null; status: Release['status'];
  trigger: Release['trigger']; message: string | null; author_user_id: number | null;
  files_added: number; files_modified: number; files_deleted: number; scan: unknown; error: string | null;
  log: unknown; on_disk: boolean; approved_by: number | null; approved_at: Date | string | null;
  published_at: Date | string | null; created_at: Date | string; updated_at: Date | string;
  /** P3 (migration 005): origin of a window / adapter release, staff override of a blocked scan. */
  window_id?: number | null; adapter_run_id?: number | null; scan_override_by?: number | null; scan_override_at?: Date | string | null;
  /** joined */ author_name?: string | null; approver_name?: string | null; is_current?: boolean;
}

export interface CertificateRow {
  id: number; domain_id: number | null; site_id: number | null; primary_name: string; names: unknown;
  status: CertificateSummary['status']; issuer: CertificateSummary['issuer']; not_before: Date | string | null;
  not_after: Date | string | null; last_error: string | null; log: unknown; failure_count: number;
  last_attempt_at: Date | string | null; created_at: Date | string; updated_at: Date | string;
}

export interface SshKeyRow {
  id: number; account_id: number; name: string; public_key: string; fingerprint: string; algorithm: string;
  created_at: Date | string;
}

// ── helpers ──────────────────────────────────────────────────────────────────

export function iso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function isoReq(v: Date | string): string {
  return iso(v) as string;
}

export function json<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T; } catch { return fallback; }
  }
  return v as T;
}

function num(v: number | string | null | undefined): number {
  return v === null || v === undefined ? 0 : Number(v);
}

/** Plan limits with every key present (older / partial rows get the defaults). */
export function planLimits(v: unknown): PlanLimits {
  return { ...DEFAULT_PLAN_LIMITS, ...json<Partial<PlanLimits>>(v, {}) };
}

export function clientCapabilities(v: unknown): ClientCapability[] {
  const arr = json<unknown[]>(v, []);
  return Array.isArray(arr) ? arr.filter((c): c is ClientCapability => (CLIENT_CAPABILITIES as readonly unknown[]).includes(c)) : [];
}

// ── mappers ──────────────────────────────────────────────────────────────────

export function toPlan(r: PlanRow): Plan {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    tenantName: r.tenant_name ?? null,
    name: r.name,
    description: r.description,
    limits: planLimits(r.limits),
    isActive: !!r.is_active,
    accountCount: num(r.account_count),
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
  };
}

export function toHostingAccount(r: AccountRow): HostingAccount {
  const limits = r.plan_limits !== undefined ? planLimits(r.plan_limits) : null;
  return {
    id: r.id,
    tenantId: r.tenant_id,
    tenantName: r.tenant_name ?? null,
    nodeId: r.node_id,
    planId: r.plan_id,
    planName: r.plan_name ?? null,
    username: r.username,
    displayName: r.display_name,
    status: r.status,
    statusMessage: r.status_message,
    uid: r.uid,
    gid: r.gid,
    diskQuotaMb: limits ? limits.diskMb : null,
    allowedBases: limits ? limits.allowedBases : null,
    diskUsedMb: r.disk_used_bytes === null || r.disk_used_bytes === undefined ? null : Math.round(Number(r.disk_used_bytes) / 1048576),
    quotaMode: r.quota_mode,
    usageCheckedAt: iso(r.usage_checked_at),
    siteCount: num(r.site_count),
    domainCount: num(r.domain_count),
    primaryDomain: r.primary_domain ?? null,
    accessMode: r.access_mode ?? 'open',
    overQuota: r.over_quota_state ?? 'ok',
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
  };
}

export function toSite(r: SiteRow, extras: { previewUrl?: string | null } = {}): Site {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    accountId: r.account_id,
    accountUsername: r.account_username ?? '',
    name: r.name,
    slug: r.slug,
    base: r.base,
    appProfile: r.app_profile,
    docroot: r.docroot,
    basePath: r.base_path,
    publishMode: r.publish_mode,
    publishDebounceSec: r.publish_debounce_sec,
    healthcheckPath: r.healthcheck_path,
    status: r.status,
    statusMessage: r.status_message,
    currentReleaseId: r.current_release_id,
    currentReleaseNumber: r.current_release_number ?? null,
    previewBase: r.preview_base,
    previewUrl: extras.previewUrl ?? null,
    php: json<PhpSettings>(r.php_settings, {}),
    customNginx: r.custom_nginx,
    primaryDomain: r.primary_domain ?? null,
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
  };
}

export function toSiteDataPath(r: DataPathRow): SiteDataPath {
  const ext = json<string[] | null>(r.allowed_extensions, null);
  return {
    id: r.id,
    siteId: r.site_id,
    path: r.path,
    policy: r.policy,
    allowedExtensions: Array.isArray(ext) ? ext : null,
    source: r.source,
    createdAt: isoReq(r.created_at),
  };
}

export function toSiteRoute(r: RouteRow): SiteRoute {
  return {
    id: r.id,
    domainId: r.domain_id,
    domainName: r.domain_name ?? '',
    pathPrefix: r.path_prefix,
    siteId: r.site_id,
    siteName: r.site_name ?? '',
    runtimeId: r.runtime_id,
    runtimeBase: r.runtime_base ?? null,
    createdAt: isoReq(r.created_at),
  };
}

export function toCertificateSummary(r: CertificateRow): CertificateSummary {
  return {
    id: r.id,
    status: r.status,
    issuer: r.issuer,
    names: json<string[]>(r.names, []),
    notBefore: iso(r.not_before),
    notAfter: iso(r.not_after),
    lastError: r.last_error,
    updatedAt: isoReq(r.updated_at),
  };
}

export function toDomain(r: DomainRow, routes: SiteRoute[], cert: CertificateSummary | null, zone: DomainZoneRef | null = null): Domain {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    accountId: r.account_id,
    accountUsername: r.account_username ?? '',
    name: r.name,
    kind: r.kind,
    includeWww: !!r.include_www,
    tlsMode: r.tls_mode,
    forceHttps: !!r.force_https,
    certificate: cert,
    routes,
    wildcard: !!r.wildcard,
    verification: {
      status: r.verification_status ?? 'pending',
      method: r.verification_method ?? null,
      verifiedAt: iso(r.verified_at),
    },
    zone,
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
  };
}

export function toRelease(r: ReleaseRow): Release {
  return {
    id: r.id,
    siteId: r.site_id,
    number: r.number,
    commitSha: r.commit_sha,
    status: r.status,
    trigger: r.trigger,
    message: r.message,
    authorUserId: r.author_user_id,
    authorName: r.author_name ?? null,
    filesAdded: r.files_added,
    filesModified: r.files_modified,
    filesDeleted: r.files_deleted,
    isCurrent: !!r.is_current,
    onDisk: !!r.on_disk,
    scan: json<ScanSummary | null>(r.scan, null),
    error: r.error,
    approvedBy: r.approver_name ?? null,
    approvedAt: iso(r.approved_at),
    publishedAt: iso(r.published_at),
    createdAt: isoReq(r.created_at),
  };
}

export function toReleaseDetail(r: ReleaseRow): ReleaseDetail {
  return { ...toRelease(r), log: json<ReleaseLogLine[]>(r.log, []) };
}

export function toSshKey(r: SshKeyRow): AccountSshKey {
  return { id: r.id, name: r.name, fingerprint: r.fingerprint, algorithm: r.algorithm, createdAt: isoReq(r.created_at) };
}
