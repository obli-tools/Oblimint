// =============================================================================
// Oblimint — P2 cron jobs per site and site logs (docs/P2-PLAN.md §Cron, §Logs).
// =============================================================================

// ─── CRON ────────────────────────────────────────────────────────────────────

export type CronRunStatus = 'running' | 'success' | 'failed' | 'timeout' | 'skipped';
export type CronRunTrigger = 'schedule' | 'manual';

export interface CronJob {
  id: number;
  siteId: number;
  accountId: number;
  name: string;
  /** 5-field crontab expression (minute hour day month weekday), UTC; @hourly/@daily/@weekly/@monthly accepted. */
  schedule: string;
  /** Shell command run with `sh -c` in the site's primary container, cwd /srv/releases/current, as the account uid. */
  command: string;
  /** 10 … 3600 s (default 300). */
  timeoutSec: number;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: CronRunStatus | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CronJobInput {
  name: string;
  schedule: string;
  command: string;
  timeoutSec?: number;
  enabled?: boolean;
}

export interface CronRun {
  id: number;
  jobId: number;
  siteId: number;
  status: CronRunStatus;
  trigger: CronRunTrigger;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /** First line of the output (list view). */
  summary: string | null;
}

/** GET /api/sites/:id/cron/runs/:runId */
export interface CronRunDetail extends CronRun {
  /** stdout + stderr interleaved, truncated to 64 KiB. */
  output: string;
  outputTruncated: boolean;
}

/** Plan limits applied to cron (PlanLimits.maxCronJobs / cronMinIntervalMin). */
export const CRON_OUTPUT_CAP = 64 * 1024;
export const CRON_DEFAULT_TIMEOUT_SEC = 300;
export const CRON_MAX_TIMEOUT_SEC = 3600;

// ─── LOGS ────────────────────────────────────────────────────────────────────

/**
 * access  edge access log of the site (JSON, persisted per day, retention);
 * error   stderr of the site containers (Apache / nginx error log, php-fpm);
 * app     stdout of the site containers (engine access log inside the container).
 */
export type LogSource = 'access' | 'error' | 'app';

export interface AccessLogEntry {
  time: string;
  host: string;
  remoteAddr: string;
  method: string;
  uri: string;
  status: number;
  bytes: number;
  requestTime: number;
  userAgent: string;
  referer?: string;
}

export interface LogLine {
  /** ISO timestamp (Docker timestamp for container logs). */
  at: string;
  source: LogSource;
  /** stderr / stdout for container logs. */
  stream?: 'stdout' | 'stderr';
  /** Container role for container logs: primary / secondary-<rid> / preview. */
  container?: string;
  /** Raw line (container logs) or the JSON line (access). */
  text: string;
  /** Parsed access entry (source access). */
  access?: AccessLogEntry;
}

/** GET /api/sites/:id/logs?source=&since=&until=&q=&status=&limit= */
export interface LogQueryResult {
  siteId: number;
  source: LogSource;
  lines: LogLine[];
  truncated: boolean;
}

/** GET /api/sites/:id/logs/files — persisted access log days. */
export interface LogFileInfo {
  date: string;
  source: LogSource;
  sizeBytes: number;
}

/** Socket.io: client → server 'logs:subscribe' payload (ack: { ok, error? }). */
export interface LogSubscribeRequest {
  siteId: number;
  source: LogSource;
}

/** Socket.io: server → the subscribing socket only. */
export interface LogLinesPayload {
  siteId: number;
  source: LogSource;
  lines: LogLine[];
}

export const LogSocketEvents = {
  SUBSCRIBE: 'logs:subscribe',
  UNSUBSCRIBE: 'logs:unsubscribe',
  LINES: 'LOG_LINES',
} as const;
