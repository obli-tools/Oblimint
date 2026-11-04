// ─── DEEP HEALTH + OUTBOUND HEARTBEAT ────────────────────────────────────────
// GET /health/deep (token-protected, for an external monitor) and the
// optional heartbeat URL called every minute while every check is green.
// Settings: GET/PUT /api/system/health-monitor (platform admin).

/** One check of the deep health report. */
export type DeepHealthCheckId = 'postgres' | 'hostd' | 'edge' | 'dns' | 'mail' | 'workers' | 'disk';

export const DEEP_HEALTH_CHECK_IDS: readonly DeepHealthCheckId[] = ['postgres', 'hostd', 'edge', 'dns', 'mail', 'workers', 'disk'];

export interface DeepHealthCheck {
  id: DeepHealthCheckId;
  /** 'skipped': component not deployed / workers disabled — never counts as a failure. */
  status: 'ok' | 'fail' | 'skipped';
  /** Short reason (failure, or why it was skipped). */
  detail: string | null;
  durationMs: number;
}

/** Body of GET /health/deep: HTTP 200 when status = ok, 503 otherwise. */
export interface DeepHealthReport {
  status: 'ok' | 'fail';
  version: string;
  checkedAt: string;
  checks: DeepHealthCheck[];
}

/** GET /api/system/health-monitor */
export interface HealthMonitorSettings {
  /** A deep health token exists (only its hash is stored; shown once at creation). */
  tokenSet: boolean;
  tokenCreatedAt: string | null;
  /** Heartbeat URL configured (sealed at rest; only its origin is shown back). */
  heartbeatSet: boolean;
  /** scheme://host[:port] of the heartbeat URL, never its path / query (they often carry a secret). */
  heartbeatOrigin: string | null;
  lastHeartbeatAt: string | null;
  /** Why the last minute sent nothing / failed (a red check, the URL refused, an HTTP error). */
  lastHeartbeatError: string | null;
  /** Workers off (OBLIMINT_WORKERS=off): the heartbeat is never sent. */
  workersEnabled: boolean;
  /** Last deep report computed (heartbeat or endpoint), null before the first. */
  lastReport: DeepHealthReport | null;
}

/** PUT /api/system/health-monitor — null removes the heartbeat URL. */
export interface HealthMonitorUpdate {
  heartbeatUrl: string | null;
}

/** POST /api/system/health-monitor/token — the token, shown once. */
export interface HealthMonitorTokenResult {
  token: string;
  settings: HealthMonitorSettings;
}

export const HEARTBEAT_URL_MAX = 2048;

// ─── HEALTH CENTER (platform admins) ─────────────────────────────────────────
// A worker re-uses the deep checks every minute and notifies the platform
// admins (bell, e-mail per their preferences, channels of the master tenant
// subscribed to the event) once per TRANSITION: a component that fails
// `confirmChecks` checks in a row goes down, the same count of green checks
// brings it back; the data disk of the node under its threshold; a backup
// target (an account, the panel) whose run fails, then succeeds again.
// The confirmed state survives a restart (table platform_health_state).
// API: GET /api/system/health-monitor/center, PUT …/center/settings.

/** The components the health center follows (the disk has its own events). */
export type HealthCenterComponentId = Exclude<DeepHealthCheckId, 'disk'>;

export const HEALTH_CENTER_COMPONENT_IDS: readonly HealthCenterComponentId[] = ['postgres', 'hostd', 'edge', 'dns', 'mail', 'workers'];

/** Notification events of the health center (family 'platform'). */
export type HealthCenterEvent =
  | 'backup.failed'
  | 'backup.recovered'
  | 'platform.componentDown'
  | 'platform.componentUp'
  | 'node.diskLow'
  | 'node.diskOk';

export const HEALTH_CENTER_EVENTS: readonly HealthCenterEvent[] = [
  'platform.componentDown', 'platform.componentUp', 'node.diskLow', 'node.diskOk', 'backup.failed', 'backup.recovered',
];

/** Settings of the health center (app_config `health_center`). */
export interface HealthCenterSettings {
  /** Notifications on (the states are followed in any case). */
  enabled: boolean;
  /** Consecutive checks (one a minute) before a component / the disk changes state. */
  confirmChecks: number;
  /** The disk is low under this free share (%)… */
  diskMinFreePercent: number;
  /** …or under this free space (GiB, 0 = no absolute floor). */
  diskMinFreeGiB: number;
  /** Per event: notify or not. */
  events: Record<HealthCenterEvent, boolean>;
}

export const HEALTH_CENTER_CONFIRM_MIN = 1;
export const HEALTH_CENTER_CONFIRM_MAX = 10;
export const HEALTH_CENTER_DISK_PERCENT_MAX = 50;
export const HEALTH_CENTER_DISK_GIB_MAX = 10_000;

export const DEFAULT_HEALTH_CENTER_SETTINGS: HealthCenterSettings = {
  enabled: true,
  confirmChecks: 2,
  diskMinFreePercent: 10,
  diskMinFreeGiB: 5,
  events: {
    'platform.componentDown': true,
    'platform.componentUp': true,
    'node.diskLow': true,
    'node.diskOk': true,
    'backup.failed': true,
    'backup.recovered': true,
  },
};

/** PUT /api/system/health-monitor/center/settings — any subset. */
export interface HealthCenterSettingsInput {
  enabled?: boolean;
  confirmChecks?: number;
  diskMinFreePercent?: number;
  diskMinFreeGiB?: number;
  events?: Partial<Record<HealthCenterEvent, boolean>>;
}

/**
 * Confirmed state of a followed item. 'unknown': never observed (or not yet
 * confirmed after the start); 'skipped': the component is not deployed.
 */
export type HealthTrackStatus = 'unknown' | 'ok' | 'fail' | 'skipped';

export interface HealthCenterComponentState {
  id: HealthCenterComponentId;
  status: HealthTrackStatus;
  /** Last detail of the check (admin reason). */
  detail: string | null;
  /** Checks in a row that disagree with `status` (a change being confirmed). */
  pending: number;
  /** Last confirmed transition (null: none yet). */
  since: string | null;
  lastCheckedAt: string | null;
}

export interface HealthCenterDiskState {
  /** 'fail' = low disk space. */
  status: HealthTrackStatus;
  totalBytes: number | null;
  availableBytes: number | null;
  pending: number;
  since: string | null;
  lastCheckedAt: string | null;
}

/** A backup target (an account or the panel) whose last run failed. */
export interface HealthCenterBackupTarget {
  scope: 'account' | 'panel';
  accountId: number | null;
  accountUsername: string | null;
  /** Failed runs in a row. */
  failures: number;
  /** First failure of the streak. */
  since: string | null;
  lastRunId: number | null;
  lastError: string | null;
}

export interface HealthCenterBackupFailure {
  runId: number;
  scope: 'account' | 'panel';
  accountId: number | null;
  accountUsername: string | null;
  status: 'failed' | 'partial';
  destinationName: string | null;
  finishedAt: string | null;
  error: string | null;
}

/** GET /api/system/health-monitor/center */
export interface HealthCenterStatus {
  settings: HealthCenterSettings;
  /** Workers off (OBLIMINT_WORKERS=off): nothing is followed. */
  workersEnabled: boolean;
  lastTickAt: string | null;
  components: HealthCenterComponentState[];
  disk: HealthCenterDiskState;
  backups: {
    /** Targets whose last run failed (confirmed state). */
    failing: HealthCenterBackupTarget[];
    /** Most recent failed / partial run (backup_runs), whatever came after. */
    lastFailure: HealthCenterBackupFailure | null;
  };
}
