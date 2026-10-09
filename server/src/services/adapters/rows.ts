import type {
  AdapterAction, AdapterId, AdapterRun, AdapterRunDetail, AdapterRunOptions, AdapterRunStatus, AdapterSchedule, AdapterUpdate,
  ChangeAnalysisSummary, ChecksumReport, DbSnapshot, ReleaseLogLine, RiskLevel, WindowChangeCounts,
} from '@oblimint/shared';
import { iso, json } from '../hosting/rows';
import { actorCan, type HostingActor } from '../hosting/access';
import { clientStatusMessage } from '../hosting/statusMessage';

// Rows of adapter_runs / adapter_schedules and their API shapes (A6 below).

export interface AdapterRunRow {
  id: number; tenant_id: number; account_id: number; site_id: number; adapter: AdapterId; action: AdapterAction;
  trigger: 'manual' | 'scheduled'; status: AdapterRunStatus; options: unknown; base_release_id: number | null;
  result_release_id: number | null; candidate_commit: string | null; updates: unknown; counts: unknown;
  risk_score: number | null; risk_level: string | null; analysis: unknown; checksums: unknown; output: string | null;
  output_truncated: boolean; log: unknown; error: string | null; created_by: number | null;
  started_at: Date | string | null; finished_at: Date | string | null; created_at: Date | string; updated_at: Date | string;
  /** joined */ result_release_number?: number | null; created_by_name?: string | null;
}

export interface AdapterScheduleRow {
  id: number; account_id: number; site_id: number; adapter: AdapterId; cron: string; timezone: string; options: unknown;
  enabled: boolean; next_run_at: Date | string | null; last_run_id: number | null; created_by: number | null;
  created_at: Date | string; updated_at: Date | string;
  /** joined */ last_run_status?: AdapterRunStatus | null;
}

export function toAdapterRun(r: AdapterRunRow): AdapterRun {
  return {
    id: Number(r.id),
    siteId: Number(r.site_id),
    accountId: Number(r.account_id),
    adapter: r.adapter,
    action: r.action,
    trigger: r.trigger,
    status: r.status,
    options: json<AdapterRunOptions>(r.options, {}),
    baseReleaseId: r.base_release_id === null ? null : Number(r.base_release_id),
    resultReleaseId: r.result_release_id === null ? null : Number(r.result_release_id),
    resultReleaseNumber: r.result_release_number === null || r.result_release_number === undefined ? null : Number(r.result_release_number),
    updates: json<AdapterUpdate[]>(r.updates, []),
    counts: json<WindowChangeCounts | null>(r.counts, null),
    risk: r.risk_score === null || r.risk_score === undefined ? null : { score: Number(r.risk_score), level: (r.risk_level ?? 'none') as RiskLevel },
    error: r.error,
    createdByName: r.created_by_name ?? null,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    createdAt: iso(r.created_at) as string,
  };
}

/** Stored log line: `raw` marks a message carrying a raw cause after " : " (runMachine.RunLogLine). */
type StoredLogLine = ReleaseLogLine & { raw?: boolean };

/** adapter_runs.analysis without the machine's private keys (pendingReflect of a deferred run). */
function analysisOf(raw: unknown): ChangeAnalysisSummary | null {
  const a = json<(ChangeAnalysisSummary & Record<string, unknown>) | null>(raw, null);
  if (!a || typeof a !== 'object') return null;
  const { pendingReflect: _private, ...summary } = a;
  return summary as ChangeAnalysisSummary;
}

/** The detail as stored; the `raw` flag of each log line is stripped by runDetailForActor. */
export function toAdapterRunDetail(r: AdapterRunRow, snapshots: DbSnapshot[]): AdapterRunDetail {
  return {
    ...toAdapterRun(r),
    log: json<StoredLogLine[]>(r.log, []),
    output: r.output,
    outputTruncated: !!r.output_truncated,
    analysis: analysisOf(r.analysis),
    checksums: json<ChecksumReport | null>(r.checksums, null),
    snapshots,
  };
}

export function toAdapterSchedule(r: AdapterScheduleRow): AdapterSchedule {
  return {
    siteId: Number(r.site_id),
    adapter: r.adapter,
    cron: r.cron,
    timezone: r.timezone,
    options: json<AdapterRunOptions>(r.options, {}),
    enabled: !!r.enabled,
    nextRunAt: iso(r.next_run_at),
    lastRunId: r.last_run_id === null ? null : Number(r.last_run_id),
    lastRunStatus: r.last_run_status ?? null,
    updatedAt: iso(r.updated_at) as string,
  };
}

// ── A6 ───────────────────────────────────────────────────────────────────────
//
// `error` and the log lines flagged `raw` are written "<French label> : <raw
// cause>" (Docker, hostd, CLI tail, host paths): a CLIENT user gets the labels
// only (clientStatusMessage). The other log lines are the machine's own French
// text (plugin names, versions, analysis verdict), shown as written. The CLI output (`output`) is the account's own
// application talking about its own code (plugin names, versions, PHP
// notices of its code): shown to the staff and to the client users holding
// releases.publish on the account (those who may run the adapter); null for
// the other client users.

export function runForActor<T extends AdapterRun>(actor: HostingActor, run: T): T {
  if (actor.kind !== 'client') return run;
  return { ...run, error: clientStatusMessage(run.error) };
}

export function runDetailForActor(actor: HostingActor, run: AdapterRunDetail, target: { tenantId: number; accountId: number }): AdapterRunDetail {
  const lines = run.log as StoredLogLine[];
  const strip = (l: StoredLogLine): ReleaseLogLine => ({ at: l.at, level: l.level, message: l.message });
  if (actor.kind !== 'client') return { ...run, log: lines.map(strip) };
  const out = runForActor(actor, run);
  out.log = lines.map((l) => ({ ...strip(l), message: l.raw ? clientStatusMessage(l.message) ?? '' : l.message }));
  if (!actorCan(actor, 'releases.publish', target)) {
    out.output = null;
    out.outputTruncated = false;
  }
  return out;
}

/** Last check result of an adapter, as SiteAdaptersInfo.available shows it (A6 applied by the caller). */
export function availableOf(adapter: AdapterId, run: AdapterRun | null): { adapter: AdapterId; checkedAt: string | null; updates: AdapterUpdate[]; error: string | null } {
  if (!run) return { adapter, checkedAt: null, updates: [], error: null };
  return {
    adapter,
    checkedAt: run.finishedAt ?? run.createdAt,
    updates: run.status === 'succeeded' ? run.updates : [],
    error: run.status === 'succeeded' ? null : run.error,
  };
}
