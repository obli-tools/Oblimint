import type { GeoInfo } from './security';

// =============================================================================
// Oblimint — P4b monitoring + automation (docs/P4b-PLAN.md §10, §11). ARCHITECT
// FILE (frozen during the phase). Module monitoring-automation (server),
// ui-apps (uptime / status pages / workflows / maintenance windows pages) and
// ui-proxy (traffic page).
// =============================================================================

// ─── Traffic per proxy host (edge access log → per-minute aggregates) ────────

export type ProxyTrafficRange = '1h' | '6h' | '24h' | '7d' | '30d' | '90d';

export interface ProxyTrafficPoint {
  /** Bucket start (minute for ≤ 24 h, hour beyond). */
  at: string;
  requests: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  bytesIn: number;
  bytesOut: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  /** 502 / 503 / 504 produced by the edge (upstream down). */
  upstreamErrors: number;
}

export interface ProxyTrafficSummary {
  proxyHostId: number;
  range: ProxyTrafficRange;
  requests: number;
  bytesIn: number;
  bytesOut: number;
  /** (4xx + 5xx) / requests, 0 … 1. */
  errorRate: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  status: { s2xx: number; s3xx: number; s4xx: number; s5xx: number };
}

export interface ProxyTrafficTopEntry {
  key: string;
  requests: number;
  bytes: number;
  errors: number;
  geo?: GeoInfo | null;
}

export interface ProxyTrafficSample {
  at: string;
  ip: string;
  method: string;
  uri: string;
  status: number;
  requestTimeMs: number;
  upstreamStatus: string | null;
  userAgent: string | null;
}

/** GET /monitoring/traffic/:proxyHostId?range&status=4xx|5xx */
export interface ProxyTrafficReport {
  summary: ProxyTrafficSummary;
  series: ProxyTrafficPoint[];
  topIps: ProxyTrafficTopEntry[];
  topUris: ProxyTrafficTopEntry[];
  countries: ProxyTrafficTopEntry[];
  errorSamples: ProxyTrafficSample[];
  slowSamples: ProxyTrafficSample[];
}

/** GET /monitoring/traffic?accountId&tenantId&range — one row per proxy host. */
export interface ProxyTrafficOverviewRow {
  proxyHostId: number;
  name: string;
  accountId: number;
  requests: number;
  errorRate: number;
  bytesOut: number;
  p95Ms: number | null;
}

// ─── Uptime monitors + status pages ──────────────────────────────────────────

export type UptimeMonitorKind = 'http' | 'tcp' | 'keyword';
export type UptimeStatus = 'up' | 'down' | 'pending' | 'paused';

export interface UptimeMonitor {
  id: number;
  tenantId: number;
  /** null = platform monitor (staff). */
  accountId: number | null;
  name: string;
  kind: UptimeMonitorKind;
  /** http / keyword: https:// or http:// URL (public addresses only unless staff). */
  url: string | null;
  /** tcp */
  host: string | null;
  port: number | null;
  keyword: string | null;
  /** keyword must NOT be present. */
  keywordInvert: boolean;
  method: 'GET' | 'HEAD';
  expectedStatus: number[];
  intervalSec: number;
  timeoutMs: number;
  /** Consecutive failures before 'down'. */
  retries: number;
  proxyHostId: number | null;
  /** Created / kept in sync by the proxy host's autoMonitor. */
  auto: boolean;
  notify: boolean;
  enabled: boolean;
  status: UptimeStatus;
  consecutiveFailures: number;
  lastCheckedAt: string | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  uptime24h: number | null;
  uptime30d: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface UptimeMonitorInput {
  accountId: number | null;
  name: string;
  kind: UptimeMonitorKind;
  url?: string | null;
  host?: string | null;
  port?: number | null;
  keyword?: string | null;
  keywordInvert?: boolean;
  method?: 'GET' | 'HEAD';
  expectedStatus?: number[];
  intervalSec?: number;
  timeoutMs?: number;
  retries?: number;
  proxyHostId?: number | null;
  notify?: boolean;
  enabled?: boolean;
}

export type UptimeMonitorUpdate = Partial<Omit<UptimeMonitorInput, 'accountId'>>;

export interface UptimeCheckPoint {
  at: string;
  ok: boolean;
  latencyMs: number | null;
  statusCode: number | null;
  error: string | null;
}

export interface StatusPage {
  id: number;
  tenantId: number;
  accountId: number | null;
  /** Public URL: https://<panel>/status/<slug> — [a-z0-9][a-z0-9-]{2,62}, unique platform-wide. */
  slug: string;
  title: string;
  description: string | null;
  monitorIds: number[];
  /** Sanitized CSS (no @import / url() / expression), ≤ 16 KiB. */
  customCss: string | null;
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StatusPageInput {
  accountId: number | null;
  slug: string;
  title: string;
  description?: string | null;
  monitorIds?: number[];
  customCss?: string | null;
  published?: boolean;
}

export type StatusPageUpdate = Partial<Omit<StatusPageInput, 'accountId'>>;

/** GET /api/public/status-pages/:slug (no session; 404 when not published). */
export interface PublicStatusPage {
  slug: string;
  title: string;
  description: string | null;
  customCss: string | null;
  generatedAt: string;
  overall: 'up' | 'degraded' | 'down' | 'unknown';
  monitors: Array<{
    name: string;
    status: UptimeStatus;
    uptime24h: number | null;
    uptime30d: number | null;
    latencyMs: number | null;
    /** Last 90 days, oldest first. */
    history: Array<{ day: string; uptime: number | null }>;
  }>;
}

// ─── Container stats of an app stack ─────────────────────────────────────────

export interface ContainerStatsPoint {
  at: string;
  cpuPct: number;
  memBytes: number;
}

/** GET /monitoring/apps/:stackId/stats?range */
export interface AppStatsResponse {
  stackId: number;
  services: Array<{
    service: string;
    container: string;
    current: { cpuPct: number; memBytes: number; memLimitBytes: number | null; pids: number | null } | null;
    series: ContainerStatsPoint[];
  }>;
}

// ─── Workflows ───────────────────────────────────────────────────────────────

export type WorkflowTriggerKind = 'cert-renewal' | 'interval' | 'cron' | 'manual';

export interface WorkflowTrigger {
  kind: WorkflowTriggerKind;
  /** interval: minutes (≥ 5). */
  intervalMinutes?: number | null;
  /** cron: 5-field expression (UTC unless timezone). */
  cron?: string | null;
  timezone?: string | null;
  /** cert-renewal: names watched (empty = any certificate of the account). */
  certificateNames?: string[];
}

export type WorkflowActionKind = 'export-certificate' | 'restart-app';

export interface WorkflowAction {
  kind: WorkflowActionKind;
  /** export-certificate */
  certificate?: { kind: 'acme' | 'imported'; id: number } | null;
  sftpTargetId?: number | null;
  /** Relative to the target's base path. */
  remotePath?: string | null;
  format?: 'pem-split' | 'pem-bundle';
  /** restart-app */
  stackId?: number | null;
  services?: string[];
}

export type WorkflowRunStatus = 'running' | 'succeeded' | 'failed';

export interface Workflow {
  id: number;
  tenantId: number;
  accountId: number | null;
  name: string;
  enabled: boolean;
  trigger: WorkflowTrigger;
  actions: WorkflowAction[];
  lastRunAt: string | null;
  lastStatus: WorkflowRunStatus | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowInput {
  accountId: number | null;
  name: string;
  enabled?: boolean;
  trigger: WorkflowTrigger;
  actions: WorkflowAction[];
}

export type WorkflowUpdate = Partial<Omit<WorkflowInput, 'accountId'>>;

export interface WorkflowRun {
  id: number;
  workflowId: number;
  trigger: string;
  status: WorkflowRunStatus;
  log: string[];
  startedAt: string;
  finishedAt: string | null;
}

export interface AutomationSshKey {
  id: number;
  tenantId: number;
  accountId: number | null;
  name: string;
  publicKey: string;
  fingerprint: string;
  createdAt: string;
}

export interface AutomationSshKeyCreate {
  accountId: number | null;
  name: string;
  /** Import an OpenSSH private key (sealed, never returned); absent = generate ed25519. */
  privateKey?: string | null;
}

export interface SftpTarget {
  id: number;
  tenantId: number;
  accountId: number | null;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: 'key' | 'password';
  sshKeyId: number | null;
  hasPassword: boolean;
  basePath: string;
  /** SHA256 host key fingerprint pinned at the first successful test (TOFU). */
  hostKeyFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SftpTargetInput {
  accountId: number | null;
  name: string;
  host: string;
  port?: number;
  username: string;
  authMethod: 'key' | 'password';
  sshKeyId?: number | null;
  /** password auth; sealed, never returned; absent = keep. */
  password?: string;
  basePath?: string;
  /** Re-pin the host key at the next test. */
  resetHostKey?: boolean;
}

export type SftpTargetUpdate = Partial<Omit<SftpTargetInput, 'accountId'>>;

export interface SftpTargetTestResult {
  ok: boolean;
  fingerprint: string | null;
  error: string | null;
}

// ─── Maintenance windows of app auto-updates ─────────────────────────────────

export interface AppMaintenanceSchedule {
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** HH:MM, local time of `timezone`. */
  start: string;
  durationMinutes: number;
  /** IANA name, e.g. Europe/Paris. */
  timezone: string;
}

export interface AppMaintenanceWindow {
  id: number;
  tenantId: number;
  /** null = platform / tenant default window (staff). */
  accountId: number | null;
  name: string;
  schedule: AppMaintenanceSchedule;
  enabled: boolean;
  /** Default window of the account (or of the tenant when accountId is null) for stacks without an explicit one. */
  isDefault: boolean;
  openNow: boolean;
  nextOpenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppMaintenanceWindowInput {
  accountId: number | null;
  name: string;
  schedule: AppMaintenanceSchedule;
  enabled?: boolean;
  isDefault?: boolean;
}

export type AppMaintenanceWindowUpdate = Partial<Omit<AppMaintenanceWindowInput, 'accountId'>>;

/** HostingSocketEvents.MONITORING_UPDATED */
export interface MonitoringUpdatedPayload {
  entity: 'monitor' | 'statusPage' | 'workflow' | 'workflowRun' | 'maintenanceWindow' | 'sshKey' | 'sftpTarget';
  id: number;
  accountId: number | null;
  action: 'created' | 'updated' | 'deleted' | 'status';
}
