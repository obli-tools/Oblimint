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
