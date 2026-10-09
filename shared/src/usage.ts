// =============================================================================
// Oblimint — P2 usage, quotas, traffic, alerts and notification channels
// (docs/P2-PLAN.md §Usage). Traffic comes from the edge JSON access log,
// resources from the Docker (cgroup) stats of each container, disk from hostd.
// =============================================================================

/** 'YYYY-MM-DD' (UTC). */
export type IsoDay = string;
/** 'YYYY-MM' (UTC calendar month). */
export type IsoMonth = string;

export interface TrafficPoint {
  day: IsoDay;
  requests: number;
  bytesOut: number;
  bytesIn: number;
}

export interface ResourcePoint {
  /** ISO timestamp of the bucket start. */
  at: string;
  cpuPct: number;
  memBytes: number;
  /** Max over the bucket (hourly series). */
  cpuPctMax?: number;
  memBytesMax?: number;
}

export type QuotaDimension = 'disk' | 'traffic' | 'databases' | 'dbSize';

export interface QuotaGauge {
  dimension: QuotaDimension;
  used: number;
  /** null = unlimited. Units: bytes for disk/traffic/dbSize, count for databases. */
  limit: number | null;
  /** used / limit × 100, null when unlimited. */
  pct: number | null;
  /** Highest threshold reached (80 / 100), null below the first one. */
  level: number | null;
}

/** State of an account regarding its quotas (hosting_accounts.over_quota_state). */
export type OverQuotaState = 'ok' | 'warn' | 'blocked' | 'suspended';
/** What a plan does when an account reaches 100 % (PlanLimits.overQuotaAction). */
export type OverQuotaAction = 'warn' | 'block-uploads' | 'suspend';

export interface SiteTraffic {
  siteId: number;
  siteName: string;
  requests: number;
  bytesOut: number;
}

/** GET /api/usage/accounts/:id?month=YYYY-MM */
export interface AccountUsage {
  accountId: number;
  month: IsoMonth;
  overQuota: OverQuotaState;
  gauges: QuotaGauge[];
  /** Daily traffic of the month. */
  traffic: TrafficPoint[];
  sites: SiteTraffic[];
  disk: { usedBytes: number | null; quotaBytes: number | null; checkedAt: string | null; history: Array<{ day: IsoDay; usedBytes: number }> };
  databases: { instances: number; databases: number; sizeBytes: number | null };
  /** Last 24 h, 5-min buckets, all containers of the account summed. */
  resources: ResourcePoint[];
}

/** GET /api/usage/sites/:id?days=30 */
export interface SiteUsage {
  siteId: number;
  traffic: TrafficPoint[];
  resources: ResourcePoint[];
  statusCodes: Record<string, number>;
}

export interface AccountUsageRow {
  accountId: number;
  username: string;
  tenantId: number;
  diskUsedBytes: number | null;
  diskQuotaBytes: number | null;
  trafficBytes: number;
  trafficQuotaBytes: number | null;
  overQuota: OverQuotaState;
}

/** GET /api/usage/tenant?tenantId= (staff) */
export interface TenantUsage {
  tenantId: number;
  month: IsoMonth;
  traffic: TrafficPoint[];
  totals: { trafficBytes: number; diskUsedBytes: number; accounts: number; sites: number; dbInstances: number };
  envelope: { trafficMbPerMonth: number | null; diskMb: number | null };
  gauges: QuotaGauge[];
  topAccounts: AccountUsageRow[];
}

/** GET /api/usage/platform (platform admin) */
export interface PlatformUsage {
  month: IsoMonth;
  traffic: TrafficPoint[];
  totals: { trafficBytes: number; diskUsedBytes: number; tenants: number; accounts: number; sites: number; dbInstances: number };
  tenants: Array<{ tenantId: number; name: string; trafficBytes: number; diskUsedBytes: number; accounts: number }>;
  /** Host: last 24 h of all tenant containers. */
  resources: ResourcePoint[];
}

export type UsageAlertScope = 'account' | 'tenant';

export interface UsageAlert {
  id: number;
  tenantId: number;
  accountId: number | null;
  scope: UsageAlertScope;
  dimension: QuotaDimension;
  /** Threshold reached (80 / 100). */
  level: number;
  /** Month for traffic, 'current' for the others. */
  period: string;
  used: number;
  limit: number;
  notifiedAt: string | null;
  clearedAt: string | null;
  createdAt: string;
}

// ─── NOTIFICATION CHANNELS (plugins ported from Obliance) ───────────────────

export type NotificationChannelType = 'smtp' | 'webhook' | 'discord' | 'telegram';

export const NOTIFICATION_CHANNEL_TYPES: readonly NotificationChannelType[] = ['smtp', 'webhook', 'discord', 'telegram'];

/** Events a channel subscribes to. */
export type NotificationEvent =
  | 'quota.warning'        // 80 %
  | 'quota.exceeded'       // 100 %
  | 'quota.action'         // uploads blocked / account suspended by enforcement
  | 'certificate.failed'
  | 'dns.syncFailed'
  | 'db.instanceFailed'
  | 'cron.failed'
  | 'security.banned';

export const NOTIFICATION_EVENTS: readonly NotificationEvent[] = [
  'quota.warning', 'quota.exceeded', 'quota.action', 'certificate.failed', 'dns.syncFailed', 'db.instanceFailed', 'cron.failed', 'security.banned',
];

/**
 * Channel configuration. Secret fields (password, botToken, webhook secret
 * header value) are WRITE-ONLY: the API returns them masked ('••••' + set flag)
 * and keeps the stored value when the client sends them back unchanged (null).
 */
export type NotificationChannelConfig =
  | { type: 'smtp'; host: string; port: number; secure: boolean; username: string | null; password?: string | null; from: string; to: string[] }
  | { type: 'webhook'; url: string; method: 'POST' | 'PUT'; headerName?: string | null; headerValue?: string | null }
  | { type: 'discord'; webhookUrl?: string | null }
  | { type: 'telegram'; botToken?: string | null; chatId: string };

export interface NotificationChannel {
  id: number;
  tenantId: number;
  name: string;
  type: NotificationChannelType;
  /** Secrets masked (password / headerValue / webhookUrl / botToken → null) — see secretsSet. */
  config: NotificationChannelConfig;
  /** Which secret fields are stored. */
  secretsSet: string[];
  events: NotificationEvent[];
  enabled: boolean;
  lastSentAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationChannelInput {
  name: string;
  config: NotificationChannelConfig;
  events: NotificationEvent[];
  enabled?: boolean;
}

/** POST /api/notifications/channels/:id/test */
export interface NotificationTestResult {
  ok: boolean;
  error: string | null;
}
