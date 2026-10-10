import type { Request } from 'express';
import type {
  MigrationAccountReport, MigrationAccountStatus, MigrationPlanResult, MigrationReport, MigrationResyncPart, MigrationRun, MigrationRunDetail,
  MigrationRunEvent, MigrationRunRequest, MigrationRunStatus, PlannedPackage,
} from '@oblimint/shared';
import { db } from '../../../db';
import { AppError } from '../../../middleware/errorHandler';
import { logger } from '../../../utils/logger';
import { auditService } from '../../audit.service';
import { runRunFinishedHooks } from '../contracts/execution';
import { emitMigration } from '../events';
import { migrationObjectMap } from '../objectMap';
import { migrationPlansService } from '../plan/plans.service';
import { cutoverDomainSwitched } from '../cutover/store';
import { logRunEvent, worker } from './engine';
import * as reports from './report';
import {
  ACTIVE_STATUSES, FROZEN_STEP_KEY, isUniqueViolation, json, runRow, runSteps, toEvent, toRun, toStep, type FrozenRunPlan, type RunRow,
} from './store';
// The providers register themselves at import time (contracts/execution.ts).
import './webDb/provider';
import './mailDns/provider';

// ─────────────────────────────────────────────────────────────────────────────
// Migration runs + engine entry points (docs/P5-PLAN.md §9). OWNED BY MODULE
// `executor-web-db`. The engine (lease, steps, resume, pause / cancel) is in
// engine.ts, the reports in report.ts, the providers in webDb/ and mailDns/.
// Every call comes from a platform admin on the master tenant (route guard);
// a run then acts as migrationActor(creator, target tenant), re-resolved at
// each start (MG4).
// ─────────────────────────────────────────────────────────────────────────────

const ALL_PARTS: MigrationResyncPart[] = ['files', 'data', 'databases', 'maildirs'];

export interface RunListQuery {
  planId?: number | null;
  status?: MigrationRunStatus | null;
  account?: string | null;
}

function emitRun(run: MigrationRun): void {
  emitMigration({
    entity: 'run', id: run.id, sourceId: run.sourceId, planId: run.planId, runId: run.id, status: run.status,
    progress: { done: run.progress.done, total: run.progress.total },
  });
}

async function audit(req: Request, action: string, run: Pick<MigrationRun, 'id' | 'planId' | 'cwpUsername' | 'kind'>, details: Record<string, unknown> = {}): Promise<void> {
  await auditService.logReq(req, action, {
    resourceType: 'migration_run', resourcePath: String(run.id), details: { planId: run.planId, account: run.cwpUsername, kind: run.kind, ...details },
  });
}

async function finished(id: number): Promise<MigrationRun> {
  const run = toRun(await runRow(id));
  emitRun(run);
  return run;
}

export const migrationRunsService = {
  /**
   * Queues one run per account (202). 409 planStale (choices changed since compute), planBlocked (account blocked /
   * not selected), runActive (a run of the account is queued / running / paused), initialRequired (resync before a
   * successful initial run), switchedNoMirror (mirrorDeletes on maildirs of a switched domain).
   */
  async startRuns(req: Request, planId: number, body: MigrationRunRequest): Promise<MigrationRun[]> {
    const { plan } = await migrationPlansService.loadForExecution(planId);
    const result: MigrationPlanResult | null = plan.result;
    if (!result || plan.stale) throw new AppError(409, 'The plan changed since its last computation: compute it again', 'planStale');
    const kind = body.kind;
    if (!['initial', 'resync', 'final-sync'].includes(kind)) throw new AppError(400, 'Unknown run kind', 'validation', { field: 'kind' });
    const usernames = [...new Set(body.accounts)];
    if (usernames.length === 0) throw new AppError(400, 'Select at least one account', 'validation', { field: 'accounts' });
    const parts = kind === 'initial' ? [] : [...new Set(body.parts?.length ? body.parts : ALL_PARTS)].filter((p) => ALL_PARTS.includes(p));
    const mirrorDeletes = kind !== 'initial' && !!body.mirrorDeletes;

    const blocked = usernames.filter((u) => {
      const a = result.accounts.find((x) => x.cwpUsername === u);
      return !a || !a.selected || a.blocked;
    });
    if (blocked.length) throw new AppError(409, 'Some accounts are blocked or not selected in the plan', 'planBlocked', { accounts: blocked });

    const sourceId = Number(plan.sourceId);
    if (kind !== 'initial') {
      const done = await db('migration_runs').where({ source_id: sourceId, kind: 'initial', status: 'done' }).whereIn('cwp_username', usernames)
        .distinct('cwp_username').pluck('cwp_username') as string[];
      const missing = usernames.filter((u) => !done.includes(u));
      if (missing.length) throw new AppError(409, 'A successful initial run is required first', 'initialRequired', { accounts: missing });
      if (mirrorDeletes && parts.includes('maildirs')) {
        // Same rule as the maildir step (mailDns/maildir.ts): a domain switched once (even rolled back since), in any
        // plan of the source, or covered by a switched ns-delegation zone, never gets its maildirs mirrored.
        const switched = new Set(await db('migration_cutover_domains').where({ source_id: sourceId }).whereIn('cwp_username', usernames)
          .andWhere((w) => w.where({ state: 'switched' }).orWhereNotNull('switched_at'))
          .distinct('cwp_username').pluck('cwp_username') as string[]);
        for (const u of usernames) {
          if (switched.has(u)) continue;
          const account = result.accounts.find((x) => x.cwpUsername === u);
          for (const md of account?.mailDomains ?? []) {
            if (await cutoverDomainSwitched(planId, md.name)) { switched.add(u); break; }
          }
        }
        if (switched.size) {
          throw new AppError(409, 'Mirroring deletions is refused for the mailboxes of a switched domain', 'switchedNoMirror', { accounts: [...switched] });
        }
      }
    }
    const active = await db('migration_runs').where({ source_id: sourceId }).whereIn('status', ACTIVE_STATUSES).whereIn('cwp_username', usernames)
      .distinct('cwp_username').pluck('cwp_username') as string[];
    if (active.length) throw new AppError(409, 'A run of this account is already queued, running or paused', 'runActive', { accounts: active });

    const createdBy = req.session?.userId ?? null;
    const ids: number[] = [];
    try {
      await db.transaction(async (trx) => {
        for (const username of usernames) {
          const account = result.accounts.find((a) => a.cwpUsername === username)!;
          const mapped = await migrationObjectMap.resolve(sourceId, 'account', username, trx);
          const packages: PlannedPackage[] = result.packages.filter((p) => p.key === account.packageKey);
          const frozen: FrozenRunPlan = { account, packages, computedAt: result.computedAt, choicesHash: result.choicesHash, discoveryId: result.discoveryId };
          const [row] = await trx('migration_runs').insert({
            plan_id: planId, source_id: sourceId, cwp_username: username, kind, parts: JSON.stringify(parts), mirror_deletes: mirrorDeletes,
            status: 'queued', target_tenant_id: account.tenantId, target_account_id: mapped ?? account.existingAccountId ?? null,
            progress: JSON.stringify({ done: 0, total: 0, bytes: null }), created_by: createdBy,
          }).returning('id') as Array<{ id: number }>;
          const id = Number(row.id);
          await trx('migration_run_steps').insert({
            run_id: id, key: FROZEN_STEP_KEY, provider: 'web-db', phase: 0, position: 0, label: JSON.stringify({ code: 'steps.frozenPlan' }),
            status: 'done', result: JSON.stringify(frozen), warnings: JSON.stringify([]),
          });
          ids.push(id);
        }
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'A run of this account is already queued, running or paused', 'runActive', { accounts: usernames });
      throw err;
    }
    const runs = (await db('migration_runs').whereIn('id', ids).orderBy('id') as RunRow[]).map(toRun);
    for (const run of runs) {
      await audit(req, 'migration.run.start', run, { parts, mirrorDeletes });
      emitRun(run);
    }
    worker.kick();
    return runs;
  },

  async list(q: RunListQuery): Promise<MigrationRun[]> {
    const query = db('migration_runs').orderBy('id', 'desc').limit(500);
    if (q.planId) query.where({ plan_id: q.planId });
    if (q.status) query.where({ status: q.status });
    if (q.account) query.where({ cwp_username: q.account });
    return (await query as RunRow[]).map(toRun);
  },

  async get(id: number): Promise<MigrationRunDetail> {
    const run = toRun(await runRow(id));
    return { ...run, steps: (await runSteps(id)).map(toStep) };
  },

  async pause(req: Request, id: number): Promise<MigrationRun> {
    const row = await runRow(id);
    if (row.status === 'running') {
      await db('migration_runs').where({ id, status: 'running' }).update({ requested_action: 'pause', updated_at: db.fn.now() });
      worker.interrupt(id, 'pause');
    } else if (row.status === 'queued') {
      const n = await db('migration_runs').where({ id, status: 'queued' }).update({ status: 'paused', updated_at: db.fn.now() });
      if (!n) throw new AppError(409, 'This run cannot be paused now', 'runNotPausable');
    } else throw new AppError(409, 'Only a queued or running run can be paused', 'runNotPausable');
    const run = await finished(id);
    await audit(req, 'migration.run.pause', run);
    return run;
  },

  async resume(req: Request, id: number): Promise<MigrationRun> {
    const n = await db('migration_runs').where({ id, status: 'paused' })
      .update({ status: 'queued', requested_action: null, lease_owner: null, lease_until: null, updated_at: db.fn.now() });
    if (!n) {
      await runRow(id);
      throw new AppError(409, 'Only a paused run can be resumed', 'runNotResumable');
    }
    const run = await finished(id);
    await audit(req, 'migration.run.resume', run);
    worker.kick();
    return run;
  },

  async cancel(req: Request, id: number): Promise<MigrationRun> {
    const row = await runRow(id);
    if (row.status === 'running') {
      await db('migration_runs').where({ id, status: 'running' }).update({ requested_action: 'cancel', updated_at: db.fn.now() });
      worker.interrupt(id, 'cancel');
      const run = await finished(id);
      await audit(req, 'migration.run.cancel', run);
      return run;
    }
    if (row.status !== 'queued' && row.status !== 'paused') throw new AppError(409, 'This run has already ended', 'runNotCancellable');
    const n = await db('migration_runs').where({ id }).whereIn('status', ['queued', 'paused'])
      .update({ status: 'cancelled', requested_action: null, lease_owner: null, lease_until: null, finished_at: db.fn.now(), updated_at: db.fn.now() });
    if (!n) throw new AppError(409, 'This run has already ended', 'runNotCancellable');
    // Same journal line as a cancel of a running run (engine.ts), so the run page shows why it stopped.
    await logRunEvent(id, null, 'warn', 'runCancelled', { step: row.current_step ?? null });
    const run = await finished(id);
    await audit(req, 'migration.run.cancel', run);
    try { await runRunFinishedHooks(run); } catch (err) { logger.warn({ err, runId: id }, 'run-finished hooks failed'); }
    return run;
  },

  /** failed / cancelled → queued again: done steps are kept, the failed one runs again. */
  async retry(req: Request, id: number): Promise<MigrationRun> {
    const row = await runRow(id);
    if (row.status !== 'failed' && row.status !== 'cancelled') throw new AppError(409, 'Only a failed or cancelled run can be retried', 'runNotRetryable');
    try {
      await db.transaction(async (trx) => {
        const n = await trx('migration_runs').where({ id }).whereIn('status', ['failed', 'cancelled']).update({
          status: 'queued', error: null, finished_at: null, requested_action: null, lease_owner: null, lease_until: null, updated_at: trx.fn.now(),
        });
        if (!n) throw new AppError(409, 'Only a failed or cancelled run can be retried', 'runNotRetryable');
        await trx('migration_run_steps').where({ run_id: id }).whereIn('status', ['failed', 'running']).update({ status: 'pending', error: null, finished_at: null });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'Another run of this account is already queued, running or paused', 'runActive', { accounts: [row.cwp_username] });
      throw err;
    }
    const run = await finished(id);
    await audit(req, 'migration.run.retry', run);
    worker.kick();
    return run;
  },

  async events(id: number, q: { after?: number | null; limit: number; stepKey?: string | null }): Promise<MigrationRunEvent[]> {
    await runRow(id);
    const query = db('migration_run_events').where({ run_id: id }).orderBy('id').limit(Math.min(500, Math.max(1, q.limit || 100)));
    if (q.after) query.where('id', '>', q.after);
    if (q.stepKey) query.where({ step_key: q.stepKey });
    return (await query).map(toEvent);
  },

  async accountStatuses(planId: number): Promise<MigrationAccountStatus[]> {
    const plan = await db('migration_plans').where({ id: planId }).first('id', 'source_id', 'result') as { id: number; source_id: number; result: unknown } | undefined;
    if (!plan) throw new AppError(404, 'Plan not found', 'notFound');
    const sourceId = Number(plan.source_id);
    const result = json<MigrationPlanResult | null>(plan.result, null);
    const runs = (await db('migration_runs').where({ source_id: sourceId }).orderBy('id') as RunRow[]).map(toRun);
    const cutovers = await db('migration_cutover_domains').where({ plan_id: planId }).select('cwp_username', 'state') as Array<{ cwp_username: string; state: string }>;
    const out: MigrationAccountStatus[] = [];
    for (const a of result?.accounts ?? []) {
      const mine = runs.filter((r) => r.cwpUsername === a.cwpUsername);
      const targetAccountId = await migrationObjectMap.resolve(sourceId, 'account', a.cwpUsername);
      let targetUsername: string | null = null;
      if (targetAccountId) {
        const acc = await db('hosting_accounts').where({ id: targetAccountId }).first('username') as { username: string } | undefined;
        targetUsername = acc?.username ?? null;
      }
      const done = mine.filter((r) => r.status === 'done');
      const lastSync = done.map((r) => r.finishedAt).filter((v): v is string => !!v).sort().at(-1) ?? null;
      const cut = cutovers.filter((c) => c.cwp_username === a.cwpUsername);
      out.push({
        cwpUsername: a.cwpUsername,
        targetAccountId,
        targetUsername,
        lastRun: mine.at(-1) ?? null,
        initialDone: done.some((r) => r.kind === 'initial'),
        lastSyncAt: lastSync,
        cutover: { domains: cut.length, switched: cut.filter((c) => c.state === 'switched').length },
      });
    }
    return out;
  },

  async runReport(id: number): Promise<MigrationAccountReport> {
    return reports.runReport(id);
  },

  async planReport(planId: number): Promise<MigrationReport> {
    return reports.planReport(planId);
  },

  /** French Markdown rendering of planReport (download). */
  async planReportMarkdown(planId: number): Promise<string> {
    return reports.planReportMarkdown(planId);
  },

  /** Worker: resumes runs whose lease expired (panel restart), executes queued runs (concurrency). Never throws. */
  start(): void {
    try { worker.start(); } catch (err) { logger.error({ err }, 'migration worker not started'); }
  },

  stop(): void {
    try { worker.stop(); } catch (err) { logger.warn({ err }, 'migration worker stop failed'); }
  },
};
