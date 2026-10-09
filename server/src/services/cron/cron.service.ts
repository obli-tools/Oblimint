import type { Request } from 'express';
import type { Knex } from 'knex';
import {
  CRON_DEFAULT_TIMEOUT_SEC, CRON_MAX_TIMEOUT_SEC, HostingSocketEvents,
  type CronJob, type CronJobInput, type CronRun, type CronRunDetail, type CronRunStatus, type CronRunTrigger,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { clientIp } from '../../utils/clientIp';
import { auditService } from '../audit.service';
import { engineFor } from '../docker/engine';
import { loadSite, type HostingActor } from '../hosting/access';
import { emitHosting } from '../hosting/events';
import { siteContainer } from '../hosting/naming';
import { iso, planLimits, type SiteRow } from '../hosting/rows';
import { notify } from '../usage/notifications.service';
import {
  containerState, execCron, newRunMarker, SAFETY_MARGIN_MS, sweepInterruptedRun, type CronExecOutcome,
} from './executor';
import { ScheduleError, nextRunAt, validateSchedule } from './schedule';

// ─────────────────────────────────────────────────────────────────────────────
// Cron jobs per site (module cron-logs, docs/P2-PLAN.md §6.6, §9.6, C1').
//
// CRUD (routes/cron.routes.ts) with the plan limits (maxCronJobs per ACCOUNT,
// counted under a row lock on the account; cronMinIntervalMin on the next
// occurrences), and the panel scheduler: tick every 15 s, due jobs of active
// accounts / running sites, one run at a time per job (a run still 'running'
// ⇒ a 'skipped' run is recorded), execution in the site's PRIMARY container
// as the account uid (executor.ts), history capped (100 runs per job, 30
// days), CRON_RUN_UPDATED, notify('cron.failed') after 3 consecutive
// failures. At boot, rows left 'running' by a previous process are failed
// once their processes are known dead (marker sweep, or past their timeout):
// until then the job keeps its 'running' run, so no second run starts (C1').
// ─────────────────────────────────────────────────────────────────────────────

const TICK_MS = 15_000;
const RETENTION_EVERY_MS = 60 * 60_000;
const RETENTION_RUNS_PER_JOB = 100;
const RETENTION_DAYS = 30;
const MAX_CONCURRENT_RUNS = 32;
const DUE_BATCH = 100;
const FAILURE_STREAK_NOTIFY = 3;
export const COMMAND_MAX_LENGTH = 1000;
export const INTERRUPTED_OUTPUT = 'interrompu (redémarrage du panel)';

interface CronJobRow {
  id: number; account_id: number; site_id: number; name: string; schedule: string; command: string;
  timeout_sec: number; enabled: boolean; last_run_at: Date | string | null; last_status: CronRunStatus | null;
  next_run_at: Date | string | null; created_by: number | null; created_at: Date | string; updated_at: Date | string;
}

interface CronRunRow {
  id: number; job_id: number; site_id: number; status: CronRunStatus; trigger: CronRunTrigger; exit_code: number | null;
  output: string | null; output_truncated: boolean; started_at: Date | string; finished_at: Date | string | null;
  /** OBLIMINT_CRON_RUN of the run (null: runs from before migration 004). */
  run_marker?: string | null;
}

/** What the executor needs about the job's site / account. */
interface RunContext {
  job: CronJobRow;
  tenantId: number;
  nodeId: number;
  uid: number;
  gid: number;
}

// ── mappers ──────────────────────────────────────────────────────────────────

export function toCronJob(r: CronJobRow): CronJob {
  return {
    id: Number(r.id),
    siteId: Number(r.site_id),
    accountId: Number(r.account_id),
    name: r.name,
    schedule: r.schedule,
    command: r.command,
    timeoutSec: Number(r.timeout_sec),
    enabled: !!r.enabled,
    lastRunAt: iso(r.last_run_at),
    lastStatus: r.last_status ?? null,
    nextRunAt: iso(r.next_run_at),
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
  };
}

/** First non-empty line of the output (list view), at most 200 characters. */
export function summaryOf(output: string | null): string | null {
  if (!output) return null;
  const line = output.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

export function toCronRun(r: CronRunRow): CronRun {
  const started = iso(r.started_at) as string;
  const finished = iso(r.finished_at);
  return {
    id: Number(r.id),
    jobId: Number(r.job_id),
    siteId: Number(r.site_id),
    status: r.status,
    trigger: r.trigger,
    exitCode: r.exit_code === null || r.exit_code === undefined ? null : Number(r.exit_code),
    startedAt: started,
    finishedAt: finished,
    durationMs: finished ? Math.max(0, new Date(finished).getTime() - new Date(started).getTime()) : null,
    summary: summaryOf(r.output),
  };
}

function toCronRunDetail(r: CronRunRow): CronRunDetail {
  return { ...toCronRun(r), output: r.output ?? '', outputTruncated: !!r.output_truncated };
}

// ── validation ───────────────────────────────────────────────────────────────

/** 400 commandTooLong / validation unless 1 … 1000 characters without NUL. */
export function assertCommand(command: unknown): string {
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new AppError(400, 'The command is required', 'validation', { command: ['required'] });
  }
  if (command.length > COMMAND_MAX_LENGTH) {
    throw new AppError(400, `The command is longer than ${COMMAND_MAX_LENGTH} characters`, 'commandTooLong', { max: COMMAND_MAX_LENGTH });
  }
  if (command.includes('\0')) throw new AppError(400, 'The command contains a NUL character', 'validation', { command: ['nul'] });
  return command;
}

function assertTimeout(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 10 || n > CRON_MAX_TIMEOUT_SEC) {
    throw new AppError(400, `The timeout must be between 10 and ${CRON_MAX_TIMEOUT_SEC} s`, 'validation', { timeoutSec: ['range'] });
  }
  return n;
}

function assertName(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length === 0 || s.length > 100 || /[\u0000-\u001f\u007f]/.test(s)) {
    throw new AppError(400, 'The name must be 1 to 100 printable characters', 'validation', { name: ['invalid'] });
  }
  return s;
}

/** Schedule against the plan's minimum interval → AppError 400 / 409. */
export function checkSchedule(schedule: unknown, minIntervalMin: number, from: Date = new Date()): string {
  try {
    return validateSchedule(String(schedule ?? ''), minIntervalMin, from);
  } catch (err) {
    if (err instanceof ScheduleError) {
      if (err.reason === 'tooFrequent') {
        throw new AppError(409, err.message, 'cronTooFrequent', { minIntervalMin: Math.max(1, Math.floor(minIntervalMin)) });
      }
      throw new AppError(400, err.message, 'cronInvalidSchedule');
    }
    throw err;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function notFound(): AppError {
  return new AppError(404, 'Cron job not found', 'notFound');
}

async function jobOfSite(siteId: number, jobId: number, trx: Knex | Knex.Transaction = db): Promise<CronJobRow> {
  if (!Number.isInteger(jobId) || jobId <= 0) throw notFound();
  const row = await trx('cron_jobs').where({ id: jobId, site_id: siteId }).first() as CronJobRow | undefined;
  if (!row) throw notFound();
  return row;
}

async function accountOf(accountId: number, trx: Knex | Knex.Transaction = db) {
  return await trx('hosting_accounts as a')
    .join('plans as p', 'p.id', 'a.plan_id')
    .where('a.id', accountId)
    .first('a.id', 'a.status', 'a.node_id', 'a.uid', 'a.gid', 'p.limits as plan_limits') as
    { id: number; status: string; node_id: number; uid: number; gid: number; plan_limits: unknown } | undefined;
}

function audit(req: Request, actor: HostingActor, site: SiteRow, action: string, jobId: number, details: Record<string, unknown>): Promise<void> {
  return auditService.log({
    tenantId: site.tenant_id,
    userId: actor.userId,
    action,
    resourceType: 'site',
    resourcePath: String(site.id),
    details: { jobId, siteId: site.id, accountId: site.account_id, ...details },
    ipAddress: clientIp(req) || undefined,
  });
}

function emitJobChanged(site: { tenant_id: number; account_id: number }, jobId: number, action: 'created' | 'updated' | 'deleted'): void {
  emitHosting(HostingSocketEvents.HOSTING_CHANGED, { entity: 'cronJob', id: jobId, accountId: site.account_id, action },
    { tenantId: site.tenant_id, accountId: site.account_id });
}

function emitRun(ctx: { tenantId: number; accountId: number }, jobId: number, runId: number, siteId: number, status: CronRunStatus): void {
  emitHosting(HostingSocketEvents.CRON_RUN_UPDATED, { jobId, runId, siteId, status }, { tenantId: ctx.tenantId, accountId: ctx.accountId });
}

/** Is a unique violation on (site_id, name)? (race after the pre-check) */
function isNameConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505';
}

// ── runs: claim / finalize ───────────────────────────────────────────────────

/**
 * Inserts a 'running' run unless one is already running for the job (row
 * lock on the job: the scheduler and a manual run cannot both start one).
 * Returns the new run, or null when another run is in progress.
 */
async function claimRun(jobId: number, siteId: number, trigger: CronRunTrigger): Promise<CronRunRow | null> {
  return db.transaction(async (trx) => {
    const job = await trx('cron_jobs').where({ id: jobId }).forUpdate().first('id') as { id: number } | undefined;
    if (!job) return null;
    const running = await trx('cron_runs').where({ job_id: jobId, status: 'running' }).first('id');
    if (running) return null;
    // The marker is persisted BEFORE the exec: a restarted panel can then kill the run (recoverInterruptedRuns).
    const [row] = await trx('cron_runs').insert({ job_id: jobId, site_id: siteId, status: 'running', trigger, run_marker: newRunMarker() })
      .returning('*') as CronRunRow[];
    return row;
  });
}

/** Records a run that did not execute (overlap, container down, Docker unreachable). */
async function recordSkipped(ctx: RunContext, trigger: CronRunTrigger, reason: string, touchJob: boolean): Promise<void> {
  const [row] = await db('cron_runs').insert({
    job_id: ctx.job.id, site_id: ctx.job.site_id, status: 'skipped', trigger, output: reason, finished_at: db.fn.now(),
  }).returning('*') as CronRunRow[];
  if (touchJob) {
    await db('cron_jobs').where({ id: ctx.job.id }).update({ last_run_at: row.started_at, last_status: 'skipped', updated_at: db.fn.now() });
  }
  emitRun({ tenantId: ctx.tenantId, accountId: ctx.job.account_id }, ctx.job.id, row.id, ctx.job.site_id, 'skipped');
}

async function finalizeRun(ctx: RunContext, run: CronRunRow, outcome: CronExecOutcome): Promise<void> {
  const updated = await db('cron_runs').where({ id: run.id, status: 'running' }).update({
    status: outcome.status,
    exit_code: outcome.exitCode,
    output: outcome.output,
    output_truncated: outcome.outputTruncated,
    finished_at: db.fn.now(),
  });
  if (!updated) return; // job deleted meanwhile (cascade), or recovered by a boot pass
  await db('cron_jobs').where({ id: ctx.job.id }).update({ last_run_at: run.started_at, last_status: outcome.status, updated_at: db.fn.now() });
  emitRun({ tenantId: ctx.tenantId, accountId: ctx.job.account_id }, ctx.job.id, run.id, ctx.job.site_id, outcome.status);
  if (outcome.status === 'failed' || outcome.status === 'timeout') await maybeNotifyFailures(ctx);
}

/** Number of consecutive failed / timed-out runs, most recent first (skipped runs ignored). */
export function failureStreak(statuses: CronRunStatus[]): number {
  let n = 0;
  for (const s of statuses) {
    if (s === 'failed' || s === 'timeout') n++;
    else break;
  }
  return n;
}

async function maybeNotifyFailures(ctx: RunContext): Promise<void> {
  const rows = await db('cron_runs')
    .where({ job_id: ctx.job.id })
    .whereNotIn('status', ['running', 'skipped'])
    .orderBy('started_at', 'desc').orderBy('id', 'desc')
    .limit(FAILURE_STREAK_NOTIFY)
    .select('status') as Array<{ status: CronRunStatus }>;
  const streak = failureStreak(rows.map((r) => r.status));
  if (streak < FAILURE_STREAK_NOTIFY) return;
  const site = await db('sites').where({ id: ctx.job.site_id }).first('name') as { name: string } | undefined;
  notify('cron.failed', {
    tenantId: ctx.tenantId,
    accountId: ctx.job.account_id,
    key: `cron:failed:job:${ctx.job.id}`,
    title: `Tâche cron en échec : ${ctx.job.name}`,
    message: `La tâche cron « ${ctx.job.name} » du site « ${site?.name ?? ctx.job.site_id} » a échoué ${streak} fois de suite.`,
    // Never the command itself: it often carries credentials (mysqldump -p…, Authorization
    // headers) and this message leaves the panel (SMTP, webhook, Discord, Telegram).
    severity: 'warning',
    link: `/sites/${ctx.job.site_id}?tab=cron`,
  });
}

/** Runs a claimed run to completion. Never throws. */
async function execute(ctx: RunContext, run: CronRunRow): Promise<void> {
  const container = siteContainer(ctx.job.site_id);
  const skipped = (output: string): CronExecOutcome => ({ status: 'skipped', exitCode: null, outputTruncated: false, output });
  let outcome: CronExecOutcome;
  let docker: Awaited<ReturnType<typeof engineFor>> | null = null;
  let state: 'missing' | 'stopped' | 'running' | null = null;
  try {
    docker = await engineFor(ctx.nodeId);
    state = await containerState(docker, container);
  } catch (err) {
    logger.warn({ err, jobId: ctx.job.id }, 'Cron: Docker unreachable, run skipped');
  }
  if (!docker || state === null) {
    outcome = skipped('Docker injoignable : exécution ignorée');
  } else if (state !== 'running') {
    outcome = skipped(state === 'missing' ? 'conteneur du site absent : exécution ignorée' : 'conteneur du site arrêté : exécution ignorée');
  } else {
    try {
      outcome = await execCron(docker, {
        container, user: `${ctx.uid}:${ctx.gid}`, command: ctx.job.command, timeoutSec: ctx.job.timeout_sec, marker: run.run_marker ?? undefined,
      });
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      outcome = { status: 'failed', exitCode: null, outputTruncated: false, output: `[oblimint] exécution impossible : ${msg.slice(0, 500)}` };
      logger.warn({ err, jobId: ctx.job.id }, 'Cron execution failed');
    }
  }
  try {
    await finalizeRun(ctx, run, outcome);
  } catch (err) {
    logger.error({ err, jobId: ctx.job.id, runId: run.id }, 'Cron: cannot record the run outcome');
  }
}

// ── scheduler ────────────────────────────────────────────────────────────────

let tickTimer: NodeJS.Timeout | null = null;
let retentionTimer: NodeJS.Timeout | null = null;
let ticking = false;
/** The boot recovery must complete before the first tick (it fails every 'running' row). */
let recovered = false;
const active = new Set<number>(); // job ids executing in this process
const inflight = new Set<Promise<void>>();

interface DueRow extends CronJobRow {
  tenant_id: number; site_status: string; account_status: string; node_id: number; uid: number; gid: number;
}

/**
 * One scheduler pass (exported for tests). Due jobs: enabled, next_run_at ≤
 * now. Jobs of a suspended / non-active account or a stopped site get their
 * next_run_at advanced and a 'skipped' run with the reason, once per episode
 * (no execution, no catch-up burst at reactivation).
 * next_run_at is advanced BEFORE the run starts: a crash never re-fires it.
 */
export async function schedulerTick(now: Date = new Date()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const room = MAX_CONCURRENT_RUNS - active.size;
    if (room <= 0) return;
    const due = await db('cron_jobs as j')
      .join('sites as s', function joinSite() { this.on('s.id', '=', 'j.site_id').andOn('s.account_id', '=', 'j.account_id'); })
      .join('hosting_accounts as a', 'a.id', 'j.account_id')
      .where('j.enabled', true)
      .andWhere('j.next_run_at', '<=', now)
      .orderBy('j.next_run_at', 'asc')
      .limit(Math.min(room, DUE_BATCH))
      .select('j.*', 's.tenant_id', 's.status as site_status', 'a.status as account_status', 'a.node_id', 'a.uid', 'a.gid') as DueRow[];

    for (const row of due) {
      const next = nextRunAt(row.schedule, now);
      await db('cron_jobs').where({ id: row.id }).update({ next_run_at: next, updated_at: db.fn.now() });
      const ctx: RunContext = { job: row, tenantId: Number(row.tenant_id), nodeId: Number(row.node_id), uid: Number(row.uid), gid: Number(row.gid) };
      const inactive = inactiveReason(row);
      if (inactive) {
        await recordInactiveSkip(ctx, inactive);
        continue;
      }
      await startRun(ctx, 'schedule');
    }
  } catch (err) {
    logger.error({ err }, 'Cron scheduler tick failed');
  } finally {
    ticking = false;
  }
}

/** Why a due job of this account / site does not run (null: it runs). */
export function inactiveReason(row: { account_status: string; site_status: string }): string | null {
  if (row.account_status === 'suspended') return 'compte suspendu : passage ignoré';
  if (row.account_status !== 'active') return 'compte inactif : passage ignoré';
  if (row.site_status === 'stopped') return 'site arrêté : passage ignoré';
  return null;
}

/**
 * §9.6 « site arrêté / compte suspendu ⇒ skipped »: records a 'skipped' run
 * with the reason, ONCE per episode (not when the job's latest run already
 * is the same skip: a suspended account with a every-minute job does not
 * flood the history). Never throws (the tick goes on with the other jobs).
 */
async function recordInactiveSkip(ctx: RunContext, reason: string): Promise<void> {
  try {
    const last = await db('cron_runs').where({ job_id: ctx.job.id })
      .orderBy('started_at', 'desc').orderBy('id', 'desc').first('status', 'output') as { status: CronRunStatus; output: string | null } | undefined;
    if (last?.status === 'skipped' && last.output === reason) return;
    await recordSkipped(ctx, 'schedule', reason, true);
  } catch (err) {
    logger.warn({ err, jobId: ctx.job.id }, 'Cron: cannot record a skipped run');
  }
}

/** Claims and launches a run (overlap ⇒ a 'skipped' run). Returns the claimed run, if any. */
async function startRun(ctx: RunContext, trigger: CronRunTrigger): Promise<CronRunRow | null> {
  const run = await claimRun(ctx.job.id, ctx.job.site_id, trigger);
  if (!run) {
    await recordSkipped(ctx, trigger, 'exécution précédente toujours en cours : passage ignoré', false);
    return null;
  }
  launch(ctx, run);
  return run;
}

/** Announces a claimed run and executes it in the background. */
function launch(ctx: RunContext, run: CronRunRow): void {
  emitRun({ tenantId: ctx.tenantId, accountId: ctx.job.account_id }, ctx.job.id, run.id, ctx.job.site_id, 'running');
  active.add(ctx.job.id);
  ownRuns.add(Number(run.id));
  const p = execute(ctx, run).finally(() => {
    active.delete(ctx.job.id);
    ownRuns.delete(Number(run.id));
    inflight.delete(p);
  });
  inflight.add(p);
}

// ── recovery of the runs of a previous process (C1') ─────────────────────────

/**
 * After timeout_sec + this margin since started_at, a run of a previous
 * process cannot be running any more (container-side `timeout -s KILL`).
 */
export const RECOVERY_MARGIN_MS = SAFETY_MARGIN_MS + 60_000;

export type InterruptedRunSweep = (target: { nodeId: number; container: string; user: string; marker: string | null }) =>
  Promise<'none' | 'killed' | 'unknown'>;

const defaultSweep: InterruptedRunSweep = async (target) => {
  try {
    return await sweepInterruptedRun(await engineFor(target.nodeId), target);
  } catch {
    return 'unknown';
  }
};
let sweep: InterruptedRunSweep = defaultSweep;

/** Tests: replace the sweep of the interrupted runs (null restores). */
export function setInterruptedRunSweepForTests(fn: InterruptedRunSweep | null): void {
  sweep = fn ?? defaultSweep;
}

/** Runs executed by THIS process: never swept nor failed by the recovery. */
const ownRuns = new Set<number>();
/** Interrupted runs still possibly alive: the recovery is retried at every tick. */
let orphansPending = false;

/**
 * Runs left 'running' by a previous process (exported for tests). Their exec
 * outlives the process, so each one is first killed in its site container
 * (marker sweep, as the account uid). Failed once known dead (sweep done,
 * container missing / stopped, or past timeout_sec + RECOVERY_MARGIN_MS);
 * otherwise left 'running' — claimRun then refuses a second run of the job —
 * and retried at the next tick. Returns the number of runs failed.
 */
export async function recoverInterruptedRuns(now: Date = new Date()): Promise<number> {
  const candidates = await db('cron_runs as r')
    .join('cron_jobs as j', 'j.id', 'r.job_id')
    .join('hosting_accounts as a', 'a.id', 'j.account_id')
    .where('r.status', 'running')
    .select('r.id', 'r.site_id', 'r.run_marker', 'r.started_at', 'j.timeout_sec', 'a.node_id', 'a.uid', 'a.gid') as Array<{
      id: number; site_id: number; run_marker: string | null; started_at: Date | string; timeout_sec: number; node_id: number; uid: number; gid: number;
    }>;
  const dead: number[] = [];
  let alive = 0;
  for (const r of candidates) {
    const id = Number(r.id);
    if (ownRuns.has(id)) continue;
    const deadline = new Date(r.started_at).getTime() + Number(r.timeout_sec) * 1000 + RECOVERY_MARGIN_MS;
    const swept = await sweep({ nodeId: Number(r.node_id), container: siteContainer(Number(r.site_id)), user: `${r.uid}:${r.gid}`, marker: r.run_marker });
    if (swept !== 'unknown' || now.getTime() >= deadline) dead.push(id);
    else alive++;
  }
  orphansPending = alive > 0;
  if (alive > 0) logger.warn({ runs: alive }, 'Cron: runs of a previous process still possibly alive: kept running (no overlap) until killed or past their timeout');
  const rows = dead.length === 0 ? [] : await db('cron_runs').whereIn('id', dead).andWhere({ status: 'running' }).update({
    status: 'failed',
    output: db.raw(`CASE WHEN coalesce(output, '') = '' THEN ? ELSE output || E'\\n' || ? END`, [INTERRUPTED_OUTPUT, INTERRUPTED_OUTPUT]),
    finished_at: db.fn.now(),
  }).returning(['job_id']) as Array<{ job_id: number }>;
  const jobIds = [...new Set(rows.map((r) => Number(r.job_id)))];
  if (jobIds.length > 0) {
    await db('cron_jobs').whereIn('id', jobIds).update({ last_status: 'failed', updated_at: db.fn.now() });
  }
  // Enabled jobs without a next run (created while the scheduler was down…).
  const missing = await db('cron_jobs').where({ enabled: true }).whereNull('next_run_at').select('id', 'schedule') as Array<{ id: number; schedule: string }>;
  const at = new Date();
  for (const j of missing) await db('cron_jobs').where({ id: j.id }).update({ next_run_at: nextRunAt(j.schedule, at) });
  return rows.length;
}

async function bootRecovery(): Promise<void> {
  try {
    const n = await recoverInterruptedRuns();
    recovered = true;
    if (n > 0) logger.warn({ runs: n }, 'Cron: runs interrupted by a restart marked failed');
  } catch (err) {
    logger.error({ err }, 'Cron: boot recovery failed (retried at the next tick)');
  }
}

/** History retention: 100 runs per job and 30 days (exported for tests). */
export async function purgeRuns(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  const old = await db('cron_runs').whereNot({ status: 'running' }).andWhere('started_at', '<', cutoff).del();
  const extra = await db.raw(`
    DELETE FROM cron_runs WHERE id IN (
      SELECT id FROM (
        SELECT id, row_number() OVER (PARTITION BY job_id ORDER BY started_at DESC, id DESC) AS rn
        FROM cron_runs WHERE status <> 'running'
      ) ranked WHERE ranked.rn > ?
    )`, [RETENTION_RUNS_PER_JOB]) as { rowCount?: number };
  return Number(old) + Number(extra?.rowCount ?? 0);
}

/** Waits for the executions started by this process (tests). */
export async function drainRunsForTests(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
}

// ── service ──────────────────────────────────────────────────────────────────

export const cronService = {
  async list(actor: HostingActor, siteId: number): Promise<CronJob[]> {
    const site = await loadSite(actor, siteId, 'read');
    const rows = await db('cron_jobs').where({ site_id: site.id }).orderBy('name', 'asc').orderBy('id', 'asc') as CronJobRow[];
    return rows.map(toCronJob);
  },

  async create(req: Request, actor: HostingActor, siteId: number, input: CronJobInput): Promise<CronJob> {
    const site = await loadSite(actor, siteId, 'sites.manage');
    const name = assertName(input.name);
    const command = assertCommand(input.command);
    const timeoutSec = input.timeoutSec === undefined || input.timeoutSec === null ? CRON_DEFAULT_TIMEOUT_SEC : assertTimeout(input.timeoutSec);
    const enabled = input.enabled !== false;

    const row = await db.transaction(async (trx) => {
      // Row lock on the account: concurrent creations count the same jobs (maxCronJobs per ACCOUNT).
      await trx('hosting_accounts').where({ id: site.account_id }).forUpdate().first('id');
      const account = await accountOf(site.account_id, trx);
      if (!account) throw new AppError(404, 'Site not found', 'notFound');
      const limits = planLimits(account.plan_limits);
      const schedule = checkSchedule(input.schedule, limits.cronMinIntervalMin);
      if (limits.maxCronJobs !== null) {
        const [{ n }] = await trx('cron_jobs').where({ account_id: site.account_id }).count<{ n: string }[]>('id as n');
        if (Number(n) >= limits.maxCronJobs) {
          throw new AppError(409, `The plan allows ${limits.maxCronJobs} cron job(s) per account`, 'planLimit',
            { limit: 'maxCronJobs', max: limits.maxCronJobs });
        }
      }
      if (await trx('cron_jobs').where({ site_id: site.id, name }).first('id')) {
        throw new AppError(409, `A cron job named "${name}" already exists on this site`, 'cronNameTaken');
      }
      const [inserted] = await trx('cron_jobs').insert({
        account_id: site.account_id, site_id: site.id, name, schedule, command, timeout_sec: timeoutSec, enabled,
        next_run_at: enabled ? nextRunAt(schedule, new Date()) : null, created_by: actor.userId,
      }).returning('*') as CronJobRow[];
      return inserted;
    }).catch((err) => {
      if (isNameConflict(err)) throw new AppError(409, `A cron job named "${name}" already exists on this site`, 'cronNameTaken');
      throw err;
    });

    await audit(req, actor, site, 'cron.create', row.id, { name: row.name, schedule: row.schedule, enabled: row.enabled });
    emitJobChanged(site, row.id, 'created');
    return toCronJob(row);
  },

  async update(req: Request, actor: HostingActor, siteId: number, jobId: number, input: Partial<CronJobInput>): Promise<CronJob> {
    const site = await loadSite(actor, siteId, 'sites.manage');
    const job = await jobOfSite(site.id, jobId);
    const patch: Record<string, unknown> = {};
    const changed: string[] = [];

    if (input.name !== undefined) {
      const name = assertName(input.name);
      if (name !== job.name) {
        if (await db('cron_jobs').where({ site_id: site.id, name }).whereNot({ id: job.id }).first('id')) {
          throw new AppError(409, `A cron job named "${name}" already exists on this site`, 'cronNameTaken');
        }
        patch.name = name;
        changed.push('name');
      }
    }
    if (input.command !== undefined) {
      patch.command = assertCommand(input.command);
      if (patch.command !== job.command) changed.push('command');
    }
    if (input.timeoutSec !== undefined && input.timeoutSec !== null) {
      patch.timeout_sec = assertTimeout(input.timeoutSec);
      if (patch.timeout_sec !== job.timeout_sec) changed.push('timeoutSec');
    }
    let schedule = job.schedule;
    if (input.schedule !== undefined) {
      const account = await accountOf(site.account_id);
      schedule = checkSchedule(input.schedule, planLimits(account?.plan_limits).cronMinIntervalMin);
      patch.schedule = schedule;
      if (schedule !== job.schedule) changed.push('schedule');
    }
    const enabled = input.enabled === undefined ? !!job.enabled : !!input.enabled;
    if (enabled !== !!job.enabled) changed.push('enabled');
    patch.enabled = enabled;
    if (schedule !== job.schedule || enabled !== !!job.enabled || (enabled && !job.next_run_at)) {
      patch.next_run_at = enabled ? nextRunAt(schedule, new Date()) : null;
    }

    let row: CronJobRow;
    try {
      [row] = await db('cron_jobs').where({ id: job.id, site_id: site.id }).update({ ...patch, updated_at: db.fn.now() }).returning('*') as CronJobRow[];
    } catch (err) {
      if (isNameConflict(err)) throw new AppError(409, 'A cron job with this name already exists on this site', 'cronNameTaken');
      throw err;
    }
    if (!row) throw notFound();
    await audit(req, actor, site, 'cron.update', row.id, { name: row.name, changed });
    emitJobChanged(site, row.id, 'updated');
    return toCronJob(row);
  },

  async remove(req: Request, actor: HostingActor, siteId: number, jobId: number): Promise<void> {
    const site = await loadSite(actor, siteId, 'sites.manage');
    const job = await jobOfSite(site.id, jobId);
    await db('cron_jobs').where({ id: job.id, site_id: site.id }).del();
    await audit(req, actor, site, 'cron.delete', job.id, { name: job.name });
    emitJobChanged(site, job.id, 'deleted');
  },

  async runNow(req: Request, actor: HostingActor, siteId: number, jobId: number): Promise<CronRun> {
    const site = await loadSite(actor, siteId, 'sites.manage');
    const job = await jobOfSite(site.id, jobId);
    const account = await accountOf(site.account_id);
    if (!account || account.status !== 'active' || site.status === 'stopped') {
      throw new AppError(409, 'The site is not running', 'siteNotRunning');
    }
    if (await db('cron_runs').where({ job_id: job.id, status: 'running' }).first('id')) {
      throw new AppError(409, 'This cron job is already running', 'cronRunning');
    }
    let state: 'missing' | 'stopped' | 'running';
    try {
      state = await containerState(await engineFor(Number(account.node_id)), siteContainer(site.id));
    } catch (err) {
      logger.warn({ err, siteId: site.id }, 'Cron run: Docker unreachable');
      throw new AppError(502, 'The container engine is unreachable', 'backendUnavailable');
    }
    if (state !== 'running') throw new AppError(409, 'The site is not running', 'siteNotRunning');

    const ctx: RunContext = { job, tenantId: site.tenant_id, nodeId: Number(account.node_id), uid: Number(account.uid), gid: Number(account.gid) };
    const run = await claimRun(job.id, site.id, 'manual');
    if (!run) throw new AppError(409, 'This cron job is already running', 'cronRunning');
    launch(ctx, run);
    await audit(req, actor, site, 'cron.run', job.id, { name: job.name, runId: run.id });
    return toCronRun(run);
  },

  async runs(actor: HostingActor, siteId: number, jobId: number, page: { limit: number; offset: number }): Promise<{ items: CronRun[]; total: number }> {
    const site = await loadSite(actor, siteId, 'read');
    const job = await jobOfSite(site.id, jobId);
    const limit = Math.min(100, Math.max(1, Math.floor(page.limit) || 20));
    const offset = Math.max(0, Math.floor(page.offset) || 0);
    const [{ n }] = await db('cron_runs').where({ job_id: job.id, site_id: site.id }).count<{ n: string }[]>('id as n');
    const rows = await db('cron_runs').where({ job_id: job.id, site_id: site.id })
      .orderBy('started_at', 'desc').orderBy('id', 'desc')
      .limit(limit).offset(offset)
      // The list never carries whole outputs: the first line is enough for the summary.
      .select('id', 'job_id', 'site_id', 'status', 'trigger', 'exit_code', 'output_truncated', 'started_at', 'finished_at',
        db.raw(`left(output, 400) as output`)) as CronRunRow[];
    return { items: rows.map(toCronRun), total: Number(n) };
  },

  async run(actor: HostingActor, siteId: number, runId: number): Promise<CronRunDetail> {
    const site = await loadSite(actor, siteId, 'read');
    if (!Number.isInteger(runId) || runId <= 0) throw new AppError(404, 'Cron run not found', 'notFound');
    const row = await db('cron_runs').where({ id: runId, site_id: site.id }).first() as CronRunRow | undefined;
    if (!row) throw new AppError(404, 'Cron run not found', 'notFound');
    return toCronRunDetail(row);
  },

  /** Scheduler (tick every 15 s), recovery of 'running' rows at boot, run retention. */
  start(): void {
    if (tickTimer) return;
    void (async () => {
      // Retried by the tick until it succeeds (database not ready yet…).
      await bootRecovery();
      try { await purgeRuns(); } catch (err) { logger.error({ err }, 'Cron: run retention failed'); }
    })();
    tickTimer = setInterval(() => {
      if (!recovered) void bootRecovery();
      else {
        if (orphansPending) void recoverInterruptedRuns().catch((err) => logger.warn({ err }, 'Cron: interrupted runs recovery failed'));
        void schedulerTick();
      }
    }, TICK_MS);
    tickTimer.unref?.();
    retentionTimer = setInterval(() => {
      purgeRuns().catch((err) => logger.error({ err }, 'Cron: run retention failed'));
    }, RETENTION_EVERY_MS);
    retentionTimer.unref?.();
  },

  stop(): void {
    if (tickTimer) clearInterval(tickTimer);
    if (retentionTimer) clearInterval(retentionTimer);
    tickTimer = null;
    retentionTimer = null;
  },
};
