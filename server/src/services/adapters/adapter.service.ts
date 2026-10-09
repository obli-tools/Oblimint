import fs from 'fs';
import type { Request } from 'express';
import {
  ADAPTER_IDS, ADAPTER_RUN_FINAL_STATUSES, siteBaseDef,
  type AdapterAction, type AdapterDetection, type AdapterId, type AdapterRun, type AdapterRunDetail, type AdapterRunOptions, type AdapterRunRequest,
  type AdapterRunStatus, type AdapterSchedule, type AdapterScheduleInput, type SiteAdaptersInfo,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { errText } from '../setup/docker';
import { localNodeId } from '../docker/engine';
import { actorCan, loadSite, type HostingActor } from '../hosting/access';
import { siteDeletions } from '../hosting/deletions';
import { hostPaths, localPaths } from '../hosting/paths';
import { json, planLimits, type DataPathRow, type SiteRow } from '../hosting/rows';
import { clientStatusMessage } from '../hosting/statusMessage';
import { localContentTree } from '../maintenance/contracts';
import { platformSettings } from '../platformSettings';
import { userCanPublish } from '../windows/guarantor';
import { safeDocroot } from './common';
import { adapterDeps } from './deps';
import { adapterFor, ADAPTERS } from './registry';
import {
  availableOf, runDetailForActor, runForActor, toAdapterRun, toAdapterRunDetail, toAdapterSchedule,
  type AdapterRunRow, type AdapterScheduleRow,
} from './rows';
import {
  candidateRefName, continueApprovedRun, executeRun, failureText, INTERRUPTED_ERROR, PENDING_REFLECT_KEY, type RunJob, type RunLogLine,
} from './runMachine';
import { nextAdapterRunAt, validateAdapterSchedule } from './schedule';
import { removeToolsContainers } from './toolsRunner';

// ─────────────────────────────────────────────────────────────────────────────
// Application adapters (ARCHITECTURE §2.3, docs/P3-PLAN.md §11). OWNED BY
// MODULE `adapters`.
//
// A run never touches the live release: hostd copies releases/<current> into
// work/<runId>/tree (uid:gid), the CLI runs in an ephemeral hardened tools
// container (meejay/oblimint-tools-php<v>) on that copy, the result becomes a
// candidate commit (changeset.commitWorkTree) → analysis (scan + checksums) →
// releaseService.publishCommit (normal pipeline: healthcheck + auto-rollback)
// → post-deploy DB migrations → healthcheck → rollback code (revertTo) + DB
// (snapshotService.restore) on failure → staging reflection. The machine
// itself lives in runMachine.ts; this file: access, refusals, the one-run-
// per-site claim, schedules (worker tick 60 s) and the boot recovery.
//
// Access (A1–A6): read → info / runs / run; releases.publish → start a run;
// releases.publish + sites.manage → create / change a schedule (a scheduled
// update publishes on its own), sites.manage → delete one. A due schedule only
// fires while its author (created_by, the last user who saved it) may still
// publish on the site (windows/guarantor.ts). Audit in the tenant of the site. A6: rows.ts.
// R-DATA-LIVE (documented risk): the tools container mounts the site's LIVE
// data directory (rw) — the release's data links point there and the CLI
// needs it (WordPress uploads, Drupal files); only the databases are
// protected by the snapshot, files written there by the CLI stay.
// ─────────────────────────────────────────────────────────────────────────────

const IN_FLIGHT: readonly AdapterRunStatus[] = ['queued', 'preparing', 'running', 'analyzing', 'publishing', 'post_deploy'];
const RELEASE_IN_FLIGHT = ['queued', 'scanning', 'publishing'];
const TICK_MS = 60_000;
const DUE_BATCH = 20;
/** Scheduled runs started concurrently by this process. */
const MAX_SCHEDULED_CONCURRENT = 4;
/** Runs in flight (any trigger) on one node / for one account: 409 adapterBusy beyond (each holds a tools container of adapterMemoryMb). */
const MAX_RUNS_IN_FLIGHT_PER_NODE = 6;
const MAX_RUNS_IN_FLIGHT_PER_ACCOUNT = 2;
const RECENT_RUNS = 10;

interface AccountCtx { id: number; status: string; node_id: number; uid: number; gid: number; plan_limits: unknown }
interface ReleaseCtx { id: number; number: number; commit_sha: string | null; status: string; on_disk: boolean }

// ── in-process state ─────────────────────────────────────────────────────────

/** Runs executed by THIS process (never failed by the recovery, their workspaces / containers kept). */
const ownRuns = new Set<number>();
const inflight = new Set<Promise<unknown>>();
let scheduledActive = 0;
let tickTimer: NodeJS.Timeout | null = null;
let ticking = false;
let resuming = false;
let recovered = false;
/** start() time: the boot recovery only fails runs created before it. */
let bootedAt: Date | null = null;

/** Waits for the runs started by this process (tests). */
export async function drainRunsForTests(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function conflict(message: string, code: string, details?: Record<string, unknown>): AppError {
  return new AppError(409, message, code, details);
}

async function accountOf(accountId: number): Promise<AccountCtx | undefined> {
  return await db('hosting_accounts as a')
    .join('plans as p', 'p.id', 'a.plan_id')
    .where('a.id', accountId)
    .first('a.id', 'a.status', 'a.node_id', 'a.uid', 'a.gid', 'p.limits as plan_limits') as AccountCtx | undefined;
}

async function currentRelease(site: SiteRow): Promise<ReleaseCtx | null> {
  if (!site.current_release_id) return null;
  const r = await db('releases').where({ id: site.current_release_id, site_id: site.id })
    .first('id', 'number', 'commit_sha', 'status', 'on_disk') as ReleaseCtx | undefined;
  return r ?? null;
}

async function maintenanceSettings() {
  return platformSettings.section('maintenance');
}

/** Detection of every adapter on the live release tree (read through ContentTree, R1 / M12). */
async function detectAll(site: SiteRow, release: ReleaseCtx | null): Promise<AdapterDetection[]> {
  const php = siteBaseDef(site.base).php;
  if (!release || !release.on_disk || php === null) {
    return ADAPTER_IDS.map((adapter) => ({ adapter, detected: false, version: null, detail: php === null ? 'base statique' : 'aucune release en ligne' }));
  }
  const tree = localContentTree(localPaths.release(site.account_id, site.id, release.number));
  const docroot = safeDocroot(site.docroot);
  return Promise.all(ADAPTER_IDS.map(async (adapter) => {
    try {
      return { adapter, ...(await ADAPTERS[adapter].detectIn(tree, docroot)) };
    } catch (err) {
      logger.warn({ err, siteId: site.id, adapter }, 'Adapters: detection failed');
      return { adapter, detected: false, version: null, detail: 'détection impossible' };
    }
  }));
}

function runsQuery() {
  return db('adapter_runs as r')
    .leftJoin('releases as rel', 'rel.id', 'r.result_release_id')
    .leftJoin('users as u', 'u.id', 'r.created_by');
}

/** List columns (no output / log / analysis). */
const LIST_COLUMNS = [
  'r.id', 'r.tenant_id', 'r.account_id', 'r.site_id', 'r.adapter', 'r.action', 'r.trigger', 'r.status', 'r.options', 'r.base_release_id',
  'r.result_release_id', 'r.updates', 'r.counts', 'r.risk_score', 'r.risk_level', 'r.error', 'r.created_by', 'r.started_at', 'r.finished_at',
  'r.created_at', 'r.updated_at', 'rel.number as result_release_number',
];

function selectList<T extends ReturnType<typeof runsQuery>>(q: T) {
  return q.select(...LIST_COLUMNS, db.raw('coalesce(u.display_name, u.username) as created_by_name'));
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

function emitQueued(site: { tenant_id: number; account_id: number; id: number }, runId: number): void {
  adapterDeps().emitRun({ tenantId: site.tenant_id, accountId: site.account_id }, { siteId: site.id, runId, status: 'queued' });
}

// ── starting a run ───────────────────────────────────────────────────────────

/**
 * Refusals of P3-PLAN §6.5, in order, then the claim (one run in flight per
 * site: pre-check + the partial unique index). Returns the queued row and the
 * job (launched by the caller).
 */
async function claimRun(site: SiteRow, adapter: AdapterId, action: AdapterAction, options: AdapterRunOptions,
  trigger: 'manual' | 'scheduled', createdBy: number | null): Promise<{ row: AdapterRunRow; job: RunJob }> {
  const settings = await maintenanceSettings();
  if (!settings.adaptersEnabled) throw conflict('Application adapters are disabled on this platform', 'adaptersDisabled');
  if (siteDeletions.has(site.id)) throw conflict('The site is being deleted', 'siteDeleting');
  const account = await accountOf(site.account_id);
  if (!account) throw new AppError(404, 'Site not found', 'notFound');
  if (account.status === 'suspended') throw conflict('The hosting account is suspended', 'accountSuspended');
  if (account.status === 'deleting') throw conflict('The hosting account is being deleted', 'accountDeleting');
  if (site.status === 'stopped' || account.status !== 'active') throw conflict('The site is not running', 'siteStopped');
  const php = siteBaseDef(site.base).php;
  if (php === null) throw conflict('Adapters need a PHP base (static site)', 'adapterNotDetected', { adapter, reason: 'staticBase' });
  const release = await currentRelease(site);
  if (!release || release.status !== 'ready' || !release.on_disk || !release.commit_sha) {
    throw conflict('The site has no live release', 'noRelease');
  }
  const docroot = safeDocroot(site.docroot);
  const detection = await adapterFor(adapter).detectIn(localContentTree(localPaths.release(site.account_id, site.id, release.number)), docroot)
    .catch(() => ({ detected: false, version: null, detail: null }));
  if (!detection.detected) throw conflict(`${adapterFor(adapter).label} is not detected on the live release`, 'adapterNotDetected', { adapter });
  // A window shows its uncommitted writes over releases/<n>: neither a copy nor a publication while one is active.
  if (await adapterDeps().blocksPublish(site.id)) throw conflict('A modification window is active on this site', 'windowActive');
  if (action === 'update' && await db('releases').where({ site_id: site.id }).whereIn('status', RELEASE_IN_FLIGHT).first('id')) {
    throw conflict('A publication is already in progress for this site', 'publishInProgress');
  }
  if (await db('adapter_runs').where({ site_id: site.id }).whereIn('status', IN_FLIGHT).first('id')) {
    throw conflict('An adapter run is already in progress for this site', 'adapterBusy');
  }
  // A deferred run (its release awaiting approval) still holds the site: a second deferred release would
  // make each approval refuse the other (assertNoAdapterRun) and pile up one more per schedule.
  if (action === 'update' && await deferredRunsQuery().where('r.site_id', site.id).first('r.id')) {
    throw conflict('An adapter update of this site is waiting for the approval of its release', 'adapterBusy', { reason: 'awaitingApproval' });
  }

  const busy = await capacityRefusal(account);
  if (busy) throw busy;

  let row: AdapterRunRow;
  try {
    [row] = await db('adapter_runs').insert({
      tenant_id: site.tenant_id, account_id: site.account_id, site_id: site.id, adapter, action, trigger, status: 'queued',
      options: JSON.stringify(options), base_release_id: release.id, created_by: createdBy,
      log: JSON.stringify([{ at: new Date().toISOString(), level: 'info', message: trigger === 'scheduled' ? 'run planifié en file' : 'run en file' }]),
    }).returning('*') as AdapterRunRow[];
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('An adapter run is already in progress for this site', 'adapterBusy');
    throw err;
  }
  // Ours from the insert on: the boot recovery never fails it (no await before this line).
  const runId = Number(row.id);
  ownRuns.add(runId);
  try {
    const job = await buildJob(site, account, settings, {
      runId, adapter, action, trigger, options, createdBy,
      base: { releaseId: release.id, number: Number(release.number), commit: release.commit_sha },
    });
    return { row, job };
  } catch (err) {
    // Never launched: the row must not stay queued (it holds the one-run-per-site slot).
    ownRuns.delete(runId);
    await db('adapter_runs').where({ id: runId, status: 'queued' })
      .update({ status: 'failed', error: failureText('run non lancé', err), finished_at: db.fn.now(), updated_at: db.fn.now() })
      .catch(() => {});
    throw err;
  }
}

/**
 * Node-wide and per-account caps on the runs in flight (each one starts a
 * tools container of adapterMemoryMb): 409 adapterBusy {reason}. Soft caps
 * (count then insert), enough to keep many sites from exhausting the host.
 */
async function capacityRefusal(account: AccountCtx): Promise<AppError | null> {
  const [node, acc] = await Promise.all([
    db('adapter_runs as r').join('hosting_accounts as a', 'a.id', 'r.account_id')
      .where('a.node_id', account.node_id).whereIn('r.status', IN_FLIGHT).count<{ n: string }[]>('r.id as n'),
    db('adapter_runs').where({ account_id: account.id }).whereIn('status', IN_FLIGHT).count<{ n: string }[]>('id as n'),
  ]);
  if (Number(node[0]?.n ?? 0) >= MAX_RUNS_IN_FLIGHT_PER_NODE) {
    return conflict('Too many adapter runs in progress on this node, try again later', 'adapterBusy', { reason: 'nodeBusy' });
  }
  if (Number(acc[0]?.n ?? 0) >= MAX_RUNS_IN_FLIGHT_PER_ACCOUNT) {
    return conflict('Too many adapter runs in progress for this account, try again later', 'adapterBusy', { reason: 'accountBusy' });
  }
  return null;
}

/** The job of a run (claim, or continuation of a deferred run): everything the machine needs, loaded once. */
async function buildJob(
  site: SiteRow, account: AccountCtx, settings: Awaited<ReturnType<typeof maintenanceSettings>>,
  run: Pick<RunJob, 'runId' | 'adapter' | 'action' | 'trigger' | 'options' | 'createdBy' | 'base'>,
): Promise<RunJob> {
  const php = siteBaseDef(site.base).php;
  if (php === null) throw conflict('Adapters need a PHP base (static site)', 'adapterNotDetected', { adapter: run.adapter, reason: 'staticBase' });
  const dataPaths = await db('site_data_paths').where({ site_id: site.id }).orderBy('path') as DataPathRow[];
  return {
    ...run,
    site: {
      id: site.id, tenantId: site.tenant_id, accountId: site.account_id, name: site.name, slug: site.slug, docroot: safeDocroot(site.docroot),
      appProfile: site.app_profile, healthcheckPath: site.healthcheck_path, php,
    },
    account: { id: account.id, nodeId: Number(account.node_id), uid: Number(account.uid), gid: Number(account.gid), limits: planLimits(account.plan_limits) },
    dataPaths: dataPaths.map((d) => ({
      path: d.path, policy: d.policy,
      allowedExtensions: json<string[] | null>(d.allowed_extensions, null),
    })),
    paths: {
      workspaceLocal: localPaths.workspaceTree(site.account_id, site.id, run.runId),
      workspaceHost: hostPaths.workspaceTree(site.account_id, site.id, run.runId),
      dataHost: hostPaths.siteData(site.account_id, site.slug),
      dbSockets: {
        root: hostPaths.dbSockets(site.account_id),
        mysql: hostPaths.dbSocketDefault(site.account_id, 'mysql'),
        postgresql: hostPaths.dbSocketDefault(site.account_id, 'postgresql'),
      },
    },
    settings: { stepTimeoutMs: Math.max(1, settings.adapterTimeoutMinutes) * 60_000, memoryMb: settings.adapterMemoryMb },
  };
}

function track(runId: number, work: () => Promise<unknown>, onDone?: () => void): void {
  ownRuns.add(runId);
  const p = work()
    .catch((err) => logger.error({ err, runId }, 'Adapters: run crashed'))
    .finally(() => {
      ownRuns.delete(runId);
      inflight.delete(p);
      onDone?.();
    });
  inflight.add(p);
}

function launch(job: RunJob, onDone?: () => void): void {
  track(job.runId, () => executeRun(job, adapterDeps()), onDone);
}

// ── scheduler ────────────────────────────────────────────────────────────────

interface DueRow extends AdapterScheduleRow { site_status: string }

/** A scheduled occurrence that could not start: a failed run row carries the reason (visible in the history). */
async function recordRefused(site: SiteRow, adapter: AdapterId, options: AdapterRunOptions, err: unknown): Promise<number | null> {
  try {
    const error = failureText('run planifié non lancé', err);
    const [row] = await db('adapter_runs').insert({
      tenant_id: site.tenant_id, account_id: site.account_id, site_id: site.id, adapter, action: 'update', trigger: 'scheduled',
      status: 'failed', options: JSON.stringify(options), base_release_id: site.current_release_id ?? null, error,
      log: JSON.stringify([{ at: new Date().toISOString(), level: 'warn', message: error }]),
      started_at: db.fn.now(), finished_at: db.fn.now(),
    }).returning('id') as Array<{ id: number }>;
    return Number(row.id);
  } catch (e) {
    logger.warn({ err: e, siteId: site.id }, 'Adapters: cannot record a refused scheduled run');
    return null;
  }
}

/** One scheduler pass (exported for tests): due schedules start a 'scheduled' update run (createdBy null). */
export async function schedulerTick(now: Date = new Date()): Promise<number> {
  if (ticking) return 0;
  ticking = true;
  let started = 0;
  try {
    const room = MAX_SCHEDULED_CONCURRENT - scheduledActive;
    if (room <= 0) return 0;
    const due = await db('adapter_schedules as sc')
      .join('sites as s', function joinSite() { this.on('s.id', '=', 'sc.site_id').andOn('s.account_id', '=', 'sc.account_id'); })
      .where('sc.enabled', true)
      .andWhere('sc.next_run_at', '<=', now)
      .orderBy('sc.next_run_at', 'asc')
      .limit(Math.min(room, DUE_BATCH))
      .select('sc.*', 's.status as site_status') as DueRow[];
    for (const sc of due) {
      // Node / account at capacity: the occurrence stays due and is retried at the next tick.
      const acc = await accountOf(sc.account_id);
      if (acc && await capacityRefusal(acc)) continue;
      // Advanced BEFORE the run starts: a crash never fires it twice.
      await db('adapter_schedules').where({ id: sc.id }).update({ next_run_at: nextAdapterRunAt(sc.cron, sc.timezone, now), updated_at: db.fn.now() });
      const site = await db('sites').where({ id: sc.site_id, account_id: sc.account_id }).first() as SiteRow | undefined;
      if (!site) continue;
      const options = json<AdapterRunOptions>(sc.options, {});
      let lastRunId: number | null = null;
      try {
        // The author of the schedule must still be allowed to publish on the site (a scheduled update publishes).
        if (!(await userCanPublish(sc.created_by, { tenantId: site.tenant_id, accountId: site.account_id }))) {
          throw new AppError(403, 'the author of this schedule may no longer publish on this site', 'scheduleAuthorRevoked');
        }
        const { row, job } = await claimRun(site, sc.adapter, 'update', options, 'scheduled', null);
        lastRunId = Number(row.id);
        scheduledActive++;
        // §19 adapter.run: a scheduled run publishes and touches the databases like a manual one (no user).
        await auditService.log({
          tenantId: site.tenant_id, action: 'adapter.run', resourceType: 'site', resourcePath: String(site.id),
          details: { siteId: site.id, accountId: site.account_id, runId: lastRunId, adapter: sc.adapter, action: 'update', options, trigger: 'scheduled' },
        });
        emitQueued(site, lastRunId);
        launch(job, () => { scheduledActive--; });
        started++;
      } catch (err) {
        if ((err as { code?: string }).code === 'adaptersDisabled') {
          logger.info({ siteId: site.id, adapter: sc.adapter }, 'Adapters: scheduled run skipped (adapters disabled)');
        } else {
          lastRunId = await recordRefused(site, sc.adapter, options, err);
          if (!(err instanceof AppError)) logger.warn({ err, siteId: site.id }, 'Adapters: scheduled run could not start');
        }
      }
      if (lastRunId !== null) await db('adapter_schedules').where({ id: sc.id }).update({ last_run_id: lastRunId });
    }
  } catch (err) {
    logger.error({ err }, 'Adapters: scheduler tick failed');
  } finally {
    ticking = false;
  }
  return started;
}

// ── boot recovery ────────────────────────────────────────────────────────────

/**
 * Runs left in flight by a previous process ⇒ failed ('interrompu par un
 * redémarrage'), their workspace removed, candidate ref dropped (kept when a
 * release was created), snapshots released; then every orphan workspace
 * (work/<id> of a run this process does not execute) and every orphan tools
 * container (label oblimint.role=tools) removed. Exported for tests. Returns
 * the number of runs failed. Throws only when the database is unreachable.
 */
export async function recoverInterruptedRuns(): Promise<number> {
  const deps = adapterDeps();
  const q = db('adapter_runs as r')
    .join('sites as s', 's.id', 'r.site_id')
    .join('hosting_accounts as a', 'a.id', 'r.account_id')
    .whereIn('r.status', IN_FLIGHT);
  // Only runs of a previous process (a run of this one is in ownRuns from its insert on; belt and braces).
  if (bootedAt) q.where('r.created_at', '<', bootedAt);
  const rows = await q.select('r.id', 'r.status', 'r.site_id', 'r.account_id', 'r.tenant_id', 'r.action', 'r.result_release_id', 's.slug', 'a.node_id', 'a.uid', 'a.gid') as Array<{
      id: number; status: AdapterRunStatus; site_id: number; account_id: number; tenant_id: number; action: AdapterAction;
      result_release_id: number | null; slug: string; node_id: number; uid: number; gid: number;
    }>;
  let failed = 0;
  for (const r of rows) {
    const id = Number(r.id);
    if (ownRuns.has(id)) continue;
    const published = r.status === 'publishing' || r.status === 'post_deploy';
    const error = published
      ? `${INTERRUPTED_ERROR} : la release a pu être publiée sans migrations de base, à vérifier`
      : INTERRUPTED_ERROR;
    const n = await db('adapter_runs').where({ id }).whereIn('status', IN_FLIGHT).update({
      status: 'failed', error, finished_at: db.fn.now(), updated_at: db.fn.now(),
      log: db.raw(`log || ?::jsonb`, [JSON.stringify([{ at: new Date().toISOString(), level: 'error', message: error }])]),
    });
    if (!n) continue;
    failed++;
    deps.emitRun({ tenantId: Number(r.tenant_id), accountId: Number(r.account_id) }, { siteId: Number(r.site_id), runId: id, status: 'failed' });
    const spec = { accountId: Number(r.account_id), siteId: Number(r.site_id), slug: r.slug, uid: Number(r.uid), gid: Number(r.gid), workspaceId: id };
    await deps.removeWorkspace(Number(r.node_id), spec).catch((err) => logger.warn({ runId: id, err: errText(err) }, 'Adapters: interrupted run workspace not removed'));
    if (!published && r.result_release_id === null) await deps.deleteCandidateRef(Number(r.site_id), `refs/oblimint/candidates/adapter-${id}`).catch(() => {});
    if (r.action === 'update') await deps.releaseSnapshots({ adapterRunId: id }).catch(() => {});
  }

  // Orphan workspaces (work/<id>/ left by a crash between ensureWorkspace and the cleanup),
  // except those of the deferred runs (release awaiting approval: the continuation reflects from them).
  const deferredIds = new Set((await deferredRunsQuery().select('r.id') as Array<{ id: number }>).map((r) => Number(r.id)));
  const sites = await db('sites as s').join('hosting_accounts as a', 'a.id', 's.account_id')
    .select('s.id', 's.account_id', 's.slug', 'a.node_id', 'a.uid', 'a.gid') as Array<{ id: number; account_id: number; slug: string; node_id: number; uid: number; gid: number }>;
  for (const s of sites) {
    let names: string[];
    try {
      names = await fs.promises.readdir(localPaths.workspaces(Number(s.account_id), Number(s.id)));
    } catch {
      continue; // no work/ directory
    }
    for (const name of names) {
      if (!/^\d{1,10}$/.test(name) || ownRuns.has(Number(name)) || deferredIds.has(Number(name))) continue;
      await deps.removeWorkspace(Number(s.node_id), {
        accountId: Number(s.account_id), siteId: Number(s.id), slug: s.slug, uid: Number(s.uid), gid: Number(s.gid), workspaceId: Number(name),
      }).catch((err) => logger.warn({ siteId: s.id, workspaceId: name, err: errText(err) }, 'Adapters: orphan workspace not removed'));
    }
  }

  // Orphan tools containers (local node: P1–P3 run everything there).
  try {
    const docker = await deps.docker(await localNodeId());
    const removed = await removeToolsContainers(docker, ownRuns);
    if (removed > 0) logger.info({ removed }, 'Adapters: orphan tools containers removed');
  } catch (err) {
    logger.warn({ err: errText(err) }, 'Adapters: orphan tools containers not swept (Docker unreachable)');
  }
  return failed;
}

// ── deferred runs (release awaiting approval) ────────────────────────────────

/** Runs ended in awaiting_approval with their workspace / ref / snapshots kept (runMachine: pendingReflect). */
function deferredRunsQuery() {
  return db('adapter_runs as r')
    .where('r.status', 'awaiting_approval')
    .whereRaw(`r.analysis -> '${PENDING_REFLECT_KEY}' is not null`);
}

interface DeferredRow {
  id: number; tenant_id: number; account_id: number; site_id: number; adapter: AdapterId; action: AdapterAction; trigger: 'manual' | 'scheduled';
  options: unknown; created_by: number | null; base_release_id: number | null; result_release_id: number | null;
  log: unknown; output: string | null; output_truncated: boolean; analysis: unknown;
  release_status: string | null; release_number: number | null; current_number: number | null;
}

/** A deferred run whose release will never be published by it: cleanup, failed with the reason. */
async function abandonDeferred(r: DeferredRow, reason: string): Promise<void> {
  const deps = adapterDeps();
  const id = Number(r.id);
  const n = await db('adapter_runs').where({ id, status: 'awaiting_approval' }).update({
    status: 'failed', error: reason, finished_at: db.fn.now(), updated_at: db.fn.now(),
    analysis: db.raw(`analysis - '${PENDING_REFLECT_KEY}'`),
    log: db.raw(`log || ?::jsonb`, [JSON.stringify([{ at: new Date().toISOString(), level: 'warn', message: reason }])]),
  });
  if (!n) return;
  deps.emitRun({ tenantId: Number(r.tenant_id), accountId: Number(r.account_id) }, { siteId: Number(r.site_id), runId: id, status: 'failed' });
  const s = await db('sites as s').join('hosting_accounts as a', 'a.id', 's.account_id').where('s.id', r.site_id)
    .first('s.slug', 'a.node_id', 'a.uid', 'a.gid') as { slug: string; node_id: number; uid: number; gid: number } | undefined;
  if (s) {
    await deps.removeWorkspace(Number(s.node_id), {
      accountId: Number(r.account_id), siteId: Number(r.site_id), slug: s.slug, uid: Number(s.uid), gid: Number(s.gid), workspaceId: id,
    }).catch((err) => logger.warn({ runId: id, err: errText(err) }, 'Adapters: deferred run workspace not removed'));
  }
  await deps.deleteCandidateRef(Number(r.site_id), candidateRefName(id)).catch(() => {});
  await deps.releaseSnapshots({ adapterRunId: id }).catch(() => {});
}

/**
 * One pass over the deferred runs (exported for tests): release now ready ⇒
 * claim (status post_deploy, the one-run-per-site index) and continue in the
 * background (migrations, healthcheck, staging reflection); release
 * rejected / failed / gone / superseded by a newer live release ⇒ abandoned.
 * A run whose claim collides with another run in flight waits for the next tick.
 */
export async function resumeDeferredRuns(): Promise<number> {
  if (resuming) return 0;
  resuming = true;
  let resumed = 0;
  try {
    const rows = await deferredRunsQuery()
      .leftJoin('releases as rel', 'rel.id', 'r.result_release_id')
      .join('sites as s', 's.id', 'r.site_id')
      .leftJoin('releases as cur', 'cur.id', 's.current_release_id')
      .orderBy('r.id')
      .limit(DUE_BATCH)
      .select('r.*', 'rel.status as release_status', 'rel.number as release_number', 'cur.number as current_number') as DeferredRow[];
    for (const r of rows) {
      const id = Number(r.id);
      if (ownRuns.has(id)) continue;
      const relNo = r.release_number === null ? null : Number(r.release_number);
      if (r.release_status === 'awaiting_approval' || (r.release_status !== null && ['queued', 'scanning', 'publishing'].includes(r.release_status))) {
        if (relNo !== null && r.current_number !== null && Number(r.current_number) > relNo) {
          await abandonDeferred(r, `une release plus récente a été publiée : la release #${relNo} ne sera pas mise en ligne par ce run`);
        }
        continue;
      }
      if (r.release_status !== 'ready') {
        await abandonDeferred(r, r.release_status === 'rejected' ? `la release #${relNo ?? '?'} a été rejetée : mise à jour non appliquée`
          : r.release_status === 'failed' ? `la publication de la release #${relNo ?? '?'} a échoué : mise à jour non appliquée`
            : 'la release du run n\'existe plus : mise à jour non appliquée');
        continue;
      }
      if (siteDeletions.has(Number(r.site_id))) continue;
      const started = await resumeOne(r).catch((err) => {
        logger.warn({ err, runId: id }, 'Adapters: deferred run not resumed (retried at the next tick)');
        return false;
      });
      if (started) resumed++;
    }
  } catch (err) {
    logger.error({ err }, 'Adapters: deferred runs pass failed');
  } finally {
    resuming = false;
  }
  return resumed;
}

async function resumeOne(r: DeferredRow): Promise<boolean> {
  const id = Number(r.id);
  const site = await db('sites').where({ id: r.site_id, account_id: r.account_id }).first() as SiteRow | undefined;
  const account = site ? await accountOf(site.account_id) : undefined;
  if (!site || !account) return false;
  const base = r.base_release_id === null ? undefined
    : await db('releases').where({ id: r.base_release_id, site_id: site.id }).first('id', 'number', 'commit_sha') as { id: number; number: number; commit_sha: string | null } | undefined;
  const release = await adapterDeps().waitForRelease(site.id, Number(r.result_release_id), 0);
  if (release.status !== 'ready') return false;
  const job = await buildJob(site, account, await maintenanceSettings(), {
    runId: id, adapter: r.adapter, action: r.action, trigger: r.trigger, options: json<AdapterRunOptions>(r.options, {}), createdBy: r.created_by,
    // Base gone (pruned row): a rollback is then reported incomplete.
    base: { releaseId: base ? Number(base.id) : 0, number: base ? Number(base.number) : 0, commit: base?.commit_sha ?? '' },
  });
  // Claim: back in flight (the partial unique index keeps one run per site; 23505 ⇒ next tick).
  ownRuns.add(id);
  let n: number;
  try {
    n = await db('adapter_runs').where({ id, status: 'awaiting_approval' }).update({ status: 'post_deploy', finished_at: null, updated_at: db.fn.now() });
  } catch (err) {
    ownRuns.delete(id);
    if (isUniqueViolation(err)) return false;
    throw err;
  }
  if (!n) {
    ownRuns.delete(id);
    return false;
  }
  adapterDeps().emitRun({ tenantId: site.tenant_id, accountId: site.account_id }, { siteId: site.id, runId: id, status: 'post_deploy' });
  track(id, () => continueApprovedRun(job, adapterDeps(), {
    release,
    log: json<RunLogLine[]>(r.log, []),
    output: r.output,
    outputTruncated: !!r.output_truncated,
    analysis: json<Record<string, unknown> | null>(r.analysis, null),
  }));
  return true;
}

async function bootRecovery(): Promise<void> {
  try {
    const n = await recoverInterruptedRuns();
    recovered = true;
    if (n > 0) logger.warn({ runs: n }, 'Adapters: runs interrupted by a restart marked failed');
    // Enabled schedules without a next run (written while the worker was off…).
    const missing = await db('adapter_schedules').where({ enabled: true }).whereNull('next_run_at').select('id', 'cron', 'timezone') as Array<{ id: number; cron: string; timezone: string }>;
    for (const m of missing) await db('adapter_schedules').where({ id: m.id }).update({ next_run_at: nextAdapterRunAt(m.cron, m.timezone, new Date()) });
  } catch (err) {
    logger.error({ err }, 'Adapters: boot recovery failed (retried at the next tick)');
  }
}

// ── service ──────────────────────────────────────────────────────────────────

async function scheduleRows(siteId: number): Promise<AdapterScheduleRow[]> {
  return await db('adapter_schedules as sc')
    .leftJoin('adapter_runs as lr', 'lr.id', 'sc.last_run_id')
    .where('sc.site_id', siteId)
    .orderBy('sc.adapter')
    .select('sc.*', 'lr.status as last_run_status') as AdapterScheduleRow[];
}

export const adapterService = {
  async info(actor: HostingActor, siteId: number): Promise<SiteAdaptersInfo> {
    const site = await loadSite(actor, siteId, 'read');
    const [settings, release] = await Promise.all([maintenanceSettings(), currentRelease(site)]);
    const detections = await detectAll(site, release);
    const lastChecks = await selectList(runsQuery()
      .where('r.site_id', site.id).andWhere('r.action', 'check').whereIn('r.status', ADAPTER_RUN_FINAL_STATUSES as AdapterRunStatus[])
      .distinctOn('r.adapter').orderBy('r.adapter').orderBy('r.created_at', 'desc').orderBy('r.id', 'desc')) as AdapterRunRow[];
    const byAdapter = new Map(lastChecks.map((r) => [r.adapter, runForActor(actor, toAdapterRun(r))]));
    const available = ADAPTER_IDS
      .filter((a) => byAdapter.has(a) || detections.find((d) => d.adapter === a)?.detected)
      .map((a) => availableOf(a, byAdapter.get(a) ?? null));
    const recent = await selectList(runsQuery().where('r.site_id', site.id).orderBy('r.created_at', 'desc').orderBy('r.id', 'desc').limit(RECENT_RUNS)) as AdapterRunRow[];
    const running = await db('adapter_runs').where({ site_id: site.id }).whereIn('status', IN_FLIGHT).first('id');
    return {
      siteId: site.id,
      appProfile: site.app_profile,
      enabled: settings.adaptersEnabled && siteBaseDef(site.base).php !== null,
      detections,
      available: actor.kind === 'client' ? available.map((a) => ({ ...a, error: clientStatusMessage(a.error) })) : available,
      schedules: (await scheduleRows(site.id)).map(toAdapterSchedule),
      recentRuns: recent.map((r) => runForActor(actor, toAdapterRun(r))),
      running: !!running,
    };
  },

  /** Starts a run (check or update) in the background; 409 adapterBusy / windowActive / publishInProgress… */
  async run(req: Request, actor: HostingActor, siteId: number, body: AdapterRunRequest): Promise<AdapterRun> {
    const site = await loadSite(actor, siteId, 'releases.publish');
    if (!(ADAPTER_IDS as readonly string[]).includes(body.adapter)) throw new AppError(400, 'Unknown adapter', 'validation');
    const options = body.options ?? {};
    const { row, job } = await claimRun(site, body.adapter, body.action, options, 'manual', actor.userId);
    await auditService.logReqAs(req, site.tenant_id, 'adapter.run', {
      resourceType: 'site', resourcePath: String(site.id),
      details: { siteId: site.id, accountId: site.account_id, runId: row.id, adapter: body.adapter, action: body.action, options },
    });
    emitQueued(site, Number(row.id));
    launch(job);
    return runForActor(actor, toAdapterRun(row));
  },

  async runs(actor: HostingActor, siteId: number, opts: { limit: number; offset: number }): Promise<{ items: AdapterRun[]; total: number }> {
    const site = await loadSite(actor, siteId, 'read');
    const limit = Math.min(100, Math.max(1, Math.floor(opts.limit) || 20));
    const offset = Math.max(0, Math.floor(opts.offset) || 0);
    const [rows, count] = await Promise.all([
      selectList(runsQuery().where('r.site_id', site.id).orderBy('r.created_at', 'desc').orderBy('r.id', 'desc').limit(limit).offset(offset)) as Promise<AdapterRunRow[]>,
      db('adapter_runs').where({ site_id: site.id }).count<{ n: string }[]>('id as n'),
    ]);
    return { items: rows.map((r) => runForActor(actor, toAdapterRun(r))), total: Number(count[0]?.n ?? 0) };
  },

  async getRun(actor: HostingActor, siteId: number, runId: number): Promise<AdapterRunDetail> {
    const site = await loadSite(actor, siteId, 'read');
    if (!Number.isInteger(runId) || runId <= 0) throw new AppError(404, 'Adapter run not found', 'notFound');
    const row = await runsQuery().where('r.id', runId).andWhere('r.site_id', site.id)
      .first('r.*', 'rel.number as result_release_number', db.raw('coalesce(u.display_name, u.username) as created_by_name')) as AdapterRunRow | undefined;
    if (!row) throw new AppError(404, 'Adapter run not found', 'notFound');
    let snapshots: AdapterRunDetail['snapshots'] = [];
    try {
      const { snapshotService } = await import('../snapshots/snapshot.service');
      snapshots = await snapshotService.listForAdapterRun(Number(row.id));
    } catch (err) {
      logger.debug({ err, runId }, 'Adapters: snapshots of the run unavailable');
    }
    return runDetailForActor(actor, toAdapterRunDetail(row, snapshots), { tenantId: site.tenant_id, accountId: site.account_id });
  },

  async putSchedule(req: Request, actor: HostingActor, siteId: number, adapter: AdapterId, body: AdapterScheduleInput): Promise<AdapterSchedule> {
    // A scheduled update publishes on its own: the right to publish, on top of sites.manage.
    const site = await loadSite(actor, siteId, 'releases.publish');
    if (!actorCan(actor, 'sites.manage', { tenantId: site.tenant_id, accountId: site.account_id })) throw new AppError(403, 'Insufficient permissions');
    if (siteBaseDef(site.base).php === null) throw conflict('Adapters need a PHP base (static site)', 'adapterNotDetected', { adapter, reason: 'staticBase' });
    const { cron, timezone, next } = validateAdapterSchedule(body.cron, body.timezone);
    const enabled = !!body.enabled;
    const values = {
      cron, timezone, options: JSON.stringify(body.options ?? {}), enabled, next_run_at: enabled ? next : null, updated_at: db.fn.now(),
      // The author vouches for the schedule (checked each time it fires).
      created_by: actor.userId,
    };
    await db('adapter_schedules')
      .insert({ account_id: site.account_id, site_id: site.id, adapter, ...values })
      .onConflict(['site_id', 'adapter'])
      .merge(values);
    const row = (await scheduleRows(site.id)).find((r) => r.adapter === adapter);
    if (!row) throw new AppError(404, 'Schedule not found', 'notFound');
    await auditService.logReqAs(req, site.tenant_id, 'adapter.schedule', {
      resourceType: 'site', resourcePath: String(site.id),
      details: { siteId: site.id, accountId: site.account_id, adapter, cron, timezone, enabled, options: body.options ?? {} },
    });
    return toAdapterSchedule(row);
  },

  async deleteSchedule(req: Request, actor: HostingActor, siteId: number, adapter: AdapterId): Promise<void> {
    const site = await loadSite(actor, siteId, 'sites.manage');
    const n = await db('adapter_schedules').where({ site_id: site.id, adapter }).del();
    if (!n) throw new AppError(404, 'Schedule not found', 'notFound');
    await auditService.logReqAs(req, site.tenant_id, 'adapter.schedule.delete', {
      resourceType: 'site', resourcePath: String(site.id), details: { siteId: site.id, accountId: site.account_id, adapter },
    });
  },

  /**
   * Scheduler (tick 60 s) + continuation of the deferred runs whose release was approved (same tick)
   * + boot recovery (runs left in flight → failed, workspaces / tools containers removed). Never throws.
   */
  start(): void {
    if (tickTimer) return;
    bootedAt = new Date();
    void bootRecovery();
    tickTimer = setInterval(() => {
      if (!recovered) {
        void bootRecovery();
        return;
      }
      void schedulerTick();
      void resumeDeferredRuns();
    }, TICK_MS);
    tickTimer.unref?.();
  },

  stop(): void {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  },
};
