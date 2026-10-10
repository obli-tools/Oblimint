import crypto from 'crypto';
import os from 'os';
import type { CwpInventory, MigrationEventLevel, MigrationPlanResult, MigrationRun, MigrationRunStatus, MigrationWarning } from '@oblimint/shared';
import { MASTER_TENANT_ID } from '@oblimint/shared';
import { config } from '../../../config';
import { db } from '../../../db';
import { AppError } from '../../../middleware/errorHandler';
import { logger } from '../../../utils/logger';
import { auditService } from '../../audit.service';
import {
  MigrationInterruptedError, migrationStepProviders, runRunFinishedHooks,
  type MigrationProviderId, type MigrationStepContext, type MigrationStepPlanningInput, type MigrationStepSpec,
} from '../contracts/execution';
import { SourceConnectionError, type SessionContext, type SourceSession } from '../contracts/source';
import { emitMigration } from '../events';
import { migrationActor, migrationRequest } from '../jobContext';
import { errorCode, scrubSecrets, stepErrorMessage, StepError } from './errors';
import { frozenPlan, json, runRow, toRecord, toRun, type FrozenRunPlan, type RunRow, type StepRow } from './store';

// ─────────────────────────────────────────────────────────────────────────────
// Execution engine of the migration runs (docs/P5-PLAN.md §9.1, MG4, MG9).
//
// Worker (start / stop, every 2 s): claims up to migrationConcurrency runs —
// queued ones, and 'running' ones whose lease expired (panel restart) — with
// ONE atomic UPDATE … WHERE id IN (… FOR UPDATE SKIP LOCKED) RETURNING, sets
// the lease (<host>:<pid>:<boot>, 90 s, renewed every 30 s) and executes them.
//
// A run: actor re-resolved (migrationActor of its creator on the target
// tenant: a demoted admin migrates nothing), steps built from the providers
// and PERSISTED (insert-or-keep by key: a done step is never re-run; a
// 'running' one left by a crash goes back to pending and runs again — every
// step is idempotent), executed in (phase, provider, position) order. Pause /
// cancel: requested_action + AbortSignal + checkpoint(); shutdown leaves the
// run 'running' with an expired lease (resumed at the next start).
// ─────────────────────────────────────────────────────────────────────────────

const TICK_MS = 2_000;
const LEASE_SEC = 90;
const RENEW_MS = 30_000;
const ACTION_CACHE_MS = 1_000;
const PROGRESS_WRITE_MS = 2_000;
const PROVIDER_ORDER: MigrationProviderId[] = ['web-db', 'mail-dns'];

export interface EngineDeps {
  openSession(sourceId: number, ctx: SessionContext): Promise<SourceSession>;
  concurrency(): number;
  /** Back-off before reopening a lost source connection (tests: immediate). */
  reconnectDelaysMs?(): number[];
}

/** Back-off between the attempts to reopen a lost source session (then the step / run fails). */
const RECONNECT_DELAYS_MS = [2_000, 10_000, 30_000];

/** A connection-level failure worth reopening the SSH session for (not a key / credential refusal). */
export function transientSourceError(err: unknown): boolean {
  return err instanceof SourceConnectionError && (err.code === 'connectFailed' || err.code === 'timeout');
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) { resolve(); return; }
    const t = setTimeout(() => { signal.removeEventListener('abort', done); resolve(); }, ms);
    const done = () => { clearTimeout(t); resolve(); };
    signal.addEventListener('abort', done, { once: true });
  });
}

const realDeps: EngineDeps = {
  async openSession(sourceId, ctx) {
    const { sourceExecutor } = await import('../source/executor');
    return sourceExecutor.session(sourceId, ctx);
  },
  concurrency: () => config.hosting.migrationConcurrency,
};

let deps: EngineDeps = realDeps;

/** Test seam (null restores the real executor / config). */
export function setEngineDepsForTests(override: Partial<EngineDeps> | null): void {
  deps = override ? { ...realDeps, ...override } : realDeps;
}

export interface OrderedSpec {
  spec: MigrationStepSpec;
  position: number;
}

/** Global order: phase, then provider (web-db, mail-dns), then the provider's own order. */
export function orderSteps(lists: Array<{ provider: MigrationProviderId; specs: MigrationStepSpec[] }>): OrderedSpec[] {
  const all: Array<OrderedSpec & { p: number }> = [];
  for (const { provider, specs } of lists) {
    specs.forEach((spec, position) => all.push({ spec: { ...spec, provider }, position, p: PROVIDER_ORDER.indexOf(provider) }));
  }
  all.sort((a, b) => a.spec.phase - b.spec.phase || a.p - b.p || a.position - b.position);
  const seen = new Set<string>();
  return all.filter((s) => (seen.has(s.spec.key) ? false : (seen.add(s.spec.key), true))).map(({ spec, position }) => ({ spec, position }));
}

function emitRun(row: Pick<RunRow, 'id' | 'source_id' | 'plan_id' | 'status'>, progress: { done: number; total: number } | null, throttle = false): void {
  emitMigration({
    entity: 'run', id: Number(row.id), sourceId: Number(row.source_id), planId: Number(row.plan_id), runId: Number(row.id),
    status: row.status, progress,
  }, { throttle });
}

/** Persisted run event (never throws: an event must not break a run). Texts are scrubbed (MG2). */
export async function logRunEvent(runId: number, stepKey: string | null, level: MigrationEventLevel, code: string,
  params: Record<string, string | number | boolean | null> | null = null, message: string | null = null): Promise<void> {
  try {
    const clean = params
      ? Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'string' ? scrubSecrets(v).slice(0, 1000) : v]))
      : null;
    await db('migration_run_events').insert({
      run_id: runId, step_key: stepKey, level, code: code.slice(0, 100),
      params: clean ? JSON.stringify(clean) : null, message: message ? scrubSecrets(message).slice(0, 4000) : null,
    });
  } catch (err) {
    logger.debug({ err, runId, code }, 'migration run event not written');
  }
}

async function auditRun(row: RunRow, action: string, details: Record<string, unknown>): Promise<void> {
  await auditService.log({
    tenantId: MASTER_TENANT_ID, userId: row.created_by ?? undefined, action, resourceType: 'migration_run', resourcePath: String(row.id),
    details: { planId: Number(row.plan_id), account: row.cwp_username, kind: row.kind, ...details },
  });
}

async function finishHooks(runId: number): Promise<void> {
  try {
    const run: MigrationRun = toRun(await runRow(runId));
    await runRunFinishedHooks(run);
  } catch (err) {
    logger.warn({ err, runId }, 'migration run-finished hooks failed');
  }
}

async function loadInventory(discoveryId: number): Promise<CwpInventory> {
  const row = await db('migration_discoveries').where({ id: discoveryId }).first('inventory') as { inventory: unknown } | undefined;
  const inv = json<CwpInventory | null>(row?.inventory, null);
  if (!inv) throw new StepError(`Inventaire de la découverte #${discoveryId} introuvable : relancez une découverte et recalculez le plan`, 'inventoryMissing');
  return inv;
}

function planResultOf(frozen: FrozenRunPlan): MigrationPlanResult {
  return {
    computedAt: frozen.computedAt,
    choicesHash: frozen.choicesHash,
    discoveryId: frozen.discoveryId,
    packages: frozen.packages,
    accounts: [frozen.account],
    warnings: [],
    followUps: [],
    totals: { accounts: 1, selected: 1, blocked: 0, ...frozen.account.estimates },
  };
}

/** Insert-or-keep of the step rows: existing keys keep their status (a 'running' one left by a crash → pending). */
async function persistSteps(runId: number, ordered: OrderedSpec[]): Promise<StepRow[]> {
  await db.transaction(async (trx) => {
    const existing = new Map((await trx('migration_run_steps').where({ run_id: runId }).select('id', 'key', 'status') as
      Array<{ id: number; key: string; status: string }>).map((r) => [r.key, r]));
    for (const { spec, position } of ordered) {
      const row = existing.get(spec.key);
      const values = { provider: spec.provider, phase: spec.phase, position, label: JSON.stringify(spec.label) };
      if (row) {
        await trx('migration_run_steps').where({ id: row.id })
          .update({ ...values, ...(row.status === 'running' ? { status: 'pending', started_at: null } : {}) });
      } else {
        await trx('migration_run_steps').insert({ run_id: runId, key: spec.key, ...values, status: 'pending', warnings: JSON.stringify([]) });
      }
    }
  });
  return await db('migration_run_steps').where({ run_id: runId }).whereIn('key', ordered.map((o) => o.spec.key)) as StepRow[];
}

const FINISHED_STEP = new Set(['done', 'warning', 'skipped']);

interface Inflight {
  controller: AbortController;
  promise: Promise<void>;
}

class Worker {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopping = false;
  readonly owner = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`.slice(0, 64);
  readonly inflight = new Map<number, Inflight>();

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const f of this.inflight.values()) f.controller.abort(new MigrationInterruptedError('shutdown'));
  }

  /** Test helper: waits for the runs in flight. */
  async drain(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight.values()].map((f) => f.promise));
  }

  /** Pause / cancel of a run executing in THIS process: its signal aborts at once. */
  interrupt(runId: number, action: 'pause' | 'cancel'): void {
    this.inflight.get(runId)?.controller.abort(new MigrationInterruptedError(action));
  }

  /** Immediate pass after a state change (only when the worker runs: OBLIMINT_MIGRATION_WORKERS=off keeps runs queued). */
  kick(): void {
    if (this.timer) void this.tick();
  }

  async tick(): Promise<void> {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      await this.forwardRequestedActions();
      await this.claim();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'migration worker tick failed');
    } finally {
      this.busy = false;
    }
  }

  private async forwardRequestedActions(): Promise<void> {
    if (!this.inflight.size) return;
    const rows = await db('migration_runs').whereIn('id', [...this.inflight.keys()]).whereNotNull('requested_action')
      .select('id', 'requested_action') as Array<{ id: number; requested_action: 'pause' | 'cancel' }>;
    for (const r of rows) this.interrupt(Number(r.id), r.requested_action);
  }

  /** Claims runs atomically (queued, or running with an expired lease = interrupted by a restart). */
  async claim(): Promise<number[]> {
    const slots = Math.max(0, deps.concurrency() - this.inflight.size);
    if (slots === 0 || this.stopping) return [];
    const exclude = [...this.inflight.keys(), 0];
    const res = await db.raw(`
      UPDATE migration_runs SET status = 'running', lease_owner = ?, lease_until = now() + interval '${LEASE_SEC} seconds',
        started_at = COALESCE(started_at, now()), finished_at = NULL, attempts = attempts + 1, updated_at = now()
      WHERE id IN (
        SELECT id FROM migration_runs
        WHERE (status = 'queued' OR (status = 'running' AND (lease_until IS NULL OR lease_until < now())))
          AND id NOT IN (${exclude.map(() => '?').join(', ')})
        ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED)
      RETURNING *`, [this.owner, ...exclude, slots]) as { rows: RunRow[] };
    const claimed = res.rows ?? [];
    for (const row of claimed) {
      const controller = new AbortController();
      const promise = executeRun(row, controller, this.owner)
        .catch((err) => logger.error({ err, runId: row.id }, 'migration run crashed'))
        .finally(() => { this.inflight.delete(Number(row.id)); });
      this.inflight.set(Number(row.id), { controller, promise });
    }
    return claimed.map((r) => Number(r.id));
  }
}

export const worker = new Worker();

/** Executes one claimed run until it ends, pauses, is cancelled or the process stops. Never throws. */
export async function executeRun(claimed: RunRow, controller: AbortController, owner: string): Promise<void> {
  const runId = Number(claimed.id);
  let row = claimed;
  let currentKey: string | null = null;
  let sessionPromise: Promise<SourceSession> | null = null;
  let targetAccountId = row.target_account_id === null ? null : Number(row.target_account_id);
  let actionCache: { at: number; action: 'pause' | 'cancel' | null } = { at: 0, action: null };
  let totalWeight = 0;
  let doneWeight = 0;
  let doneBytes = 0;
  let stepBytes = 0;
  let lastProgressWrite = 0;

  const signal = controller.signal;
  const interruption = (err: unknown): 'pause' | 'cancel' | 'shutdown' | null => {
    if (err instanceof MigrationInterruptedError) return err.action;
    if (signal.aborted && signal.reason instanceof MigrationInterruptedError) return signal.reason.action;
    return null;
  };

  // Lease renewal (+ pause / cancel requested from another process). The lease is held until
  // leaseValidUntil (local clock, with a margin): past it, another process may have claimed the run,
  // so this one stops at once instead of running the same step concurrently (MG9).
  let leaseValidUntil = Date.now() + (LEASE_SEC - 15) * 1000;
  const renew = setInterval(() => {
    void (async () => {
      const sentAt = Date.now();
      try {
        const updated = await db('migration_runs').where({ id: runId, lease_owner: owner })
          .update({ lease_until: db.raw(`now() + interval '${LEASE_SEC} seconds'`) }).returning(['requested_action']) as Array<{ requested_action: 'pause' | 'cancel' | null }>;
        if (updated.length === 0) controller.abort(new MigrationInterruptedError('shutdown'));
        else {
          leaseValidUntil = sentAt + (LEASE_SEC - 15) * 1000;
          if (updated[0].requested_action) controller.abort(new MigrationInterruptedError(updated[0].requested_action));
        }
      } catch (err) {
        if (Date.now() >= leaseValidUntil) {
          logger.warn({ err: (err as Error)?.message, runId }, 'migration lease lost (renewal failing): run stopped, resumed by the next claim');
          controller.abort(new MigrationInterruptedError('shutdown'));
        } else logger.debug({ err, runId }, 'migration lease renewal failed');
      }
    })();
  }, RENEW_MS);
  renew.unref?.();

  /** Run row still leased by this process (writes of a process that lost the lease are dropped). */
  const owned = () => db('migration_runs').where({ id: runId, lease_owner: owner });

  const progressNow = () => ({ done: Math.round(doneWeight), total: Math.round(totalWeight), bytes: doneBytes + stepBytes });
  const writeProgress = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressWrite < PROGRESS_WRITE_MS) return;
    lastProgressWrite = now;
    const p = progressNow();
    try {
      await db('migration_runs').where({ id: runId }).update({ progress: JSON.stringify(p), updated_at: db.fn.now() });
    } catch { /* next write */ }
    emitRun(row, { done: p.done, total: p.total }, !force);
  };

  /** Final / paused state, only while this process holds the lease (false = lost: the new owner's state is kept). */
  const setStatus = async (status: MigrationRunStatus, patch: Record<string, unknown> = {}): Promise<boolean> => {
    const n = await owned().update({ status, updated_at: db.fn.now(), ...patch });
    if (!n) {
      logger.warn({ runId, status }, 'migration run state not written: lease held by another process');
      return false;
    }
    row = await runRow(runId);
    emitRun(row, { done: Math.round(doneWeight), total: Math.round(totalWeight) });
    return true;
  };

  /** Step row update, only while this process holds the run's lease. */
  const updateStep = (stepId: number, patch: Record<string, unknown>) => db('migration_run_steps')
    .where({ id: stepId })
    .whereExists((qb) => { qb.select(db.raw('1')).from('migration_runs').where({ id: runId, lease_owner: owner }); })
    .update(patch);

  const releaseLease = { lease_owner: null, lease_until: null, requested_action: null };

  const fail = async (message: string, code: string) => {
    if (!(await setStatus('failed', { error: message.slice(0, 4000), finished_at: db.fn.now(), current_step: currentKey, progress: JSON.stringify(progressNow()), ...releaseLease }))) return;
    await logRunEvent(runId, currentKey, 'error', 'runFailed', { code }, message);
    await auditRun(row, 'migration.run.failed', { step: currentKey, code });
    await finishHooks(runId);
  };

  try {
    if (row.attempts > 1) await logRunEvent(runId, null, 'info', 'runResumed', { attempt: Number(row.attempts) });
    else await logRunEvent(runId, null, 'info', 'runStarted', { kind: row.kind });
    emitRun(row, null);

    // ── identity (MG4): re-resolved at each start ──
    if (!row.created_by) throw new AppError(403, 'The migration runs with the rights of a platform administrator', 'migrationAdminRequired');
    const createdBy = Number(row.created_by);
    const tenantId = Number(row.target_tenant_id);
    const actor = await migrationActor(createdBy, tenantId);

    // ── frozen plan + inventory ──
    const frozen = await frozenPlan(runId);
    if (!frozen) throw new StepError("Copie figée du plan absente : relancez l'exécution depuis le plan", 'frozenPlanMissing');
    const inventory = await loadInventory(frozen.discoveryId);
    const record = toRecord(row);
    const input: MigrationStepPlanningInput = { run: record, account: frozen.account, plan: planResultOf(frozen), inventory };

    // ── steps: built, ordered, persisted ──
    const providers = migrationStepProviders();
    const ordered = orderSteps(providers.map((p) => ({ provider: p.id, specs: p.steps(input) })));
    const stepRows = new Map((await persistSteps(runId, ordered)).map((s) => [s.key, s]));
    totalWeight = ordered.reduce((n, o) => n + Math.max(1, o.spec.weight ?? 1), 0);
    for (const o of ordered) {
      const s = stepRows.get(o.spec.key);
      if (s && FINISHED_STEP.has(s.status)) {
        doneWeight += Math.max(1, o.spec.weight ?? 1);
        doneBytes += Number(json<Record<string, unknown> | null>(s.result, null)?.bytes ?? 0) || 0;
      }
    }
    await writeProgress(true);

    const checkpoint = async (): Promise<void> => {
      if (signal.aborted) throw signal.reason instanceof MigrationInterruptedError ? signal.reason : new MigrationInterruptedError('shutdown');
      const now = Date.now();
      if (now >= leaseValidUntil) {
        // Renewals stuck / failing: another process may claim the run now.
        const e = new MigrationInterruptedError('shutdown');
        controller.abort(e);
        throw e;
      }
      if (now - actionCache.at > ACTION_CACHE_MS) {
        const r = await db('migration_runs').where({ id: runId }).first('requested_action') as { requested_action: 'pause' | 'cancel' | null } | undefined;
        actionCache = { at: now, action: r?.requested_action ?? null };
      }
      if (actionCache.action) {
        const e = new MigrationInterruptedError(actionCache.action);
        controller.abort(e);
        throw e;
      }
    };

    const openSessionWithRetry = async (): Promise<SourceSession> => {
      const delays = deps.reconnectDelaysMs?.() ?? RECONNECT_DELAYS_MS;
      for (let attempt = 0; ; attempt++) {
        try {
          return await deps.openSession(record.sourceId, { phase: 'transfer', runId, signal });
        } catch (err) {
          if (!transientSourceError(err) || attempt >= delays.length || signal.aborted) throw err;
          await logRunEvent(runId, currentKey, 'warn', 'sourceReconnect', { attempt: attempt + 1 }, null);
          await abortableSleep(delays[attempt], signal);
        }
      }
    };

    const ctx: MigrationStepContext = {
      ...input,
      actor,
      get req() { return migrationRequest(createdBy, tenantId); },
      session: async () => {
        // One SSH session per run, REOPENED when it was lost (sshd restart, NAT timeout during a long import, a
        // keepalive miss) or its opening failed: a blip never fails every remaining step of a multi-hour run.
        const cachedPromise = sessionPromise;
        if (cachedPromise) {
          const cached = await cachedPromise.catch(() => null);
          if (cached && (cached.alive?.() ?? true)) return cached;
          if (sessionPromise === cachedPromise) {
            if (cached) { try { await cached.close(); } catch { /* already gone */ } }
            sessionPromise = null;
          }
        }
        sessionPromise ??= openSessionWithRetry();
        return sessionPromise;
      },
      targetAccountId: () => targetAccountId,
      setTargetAccountId: async (accountId: number) => {
        targetAccountId = accountId;
        record.targetAccountId = accountId;
        await db('migration_runs').where({ id: runId }).update({ target_account_id: accountId, updated_at: db.fn.now() });
      },
      log: async (level, code, params, message) => {
        await logRunEvent(runId, currentKey, level, code, params ?? null, message ?? null);
        emitRun(row, { done: Math.round(doneWeight), total: Math.round(totalWeight) }, true);
      },
      progress: (p) => {
        if (typeof p.bytes === 'number' && Number.isFinite(p.bytes)) stepBytes = p.bytes;
        void writeProgress();
      },
      signal,
      checkpoint,
      stepResult: async (key: string) => {
        const own = await db('migration_run_steps').where({ run_id: runId, key }).whereIn('status', ['done', 'warning']).first('result') as { result: unknown } | undefined;
        if (own) return json<Record<string, unknown> | null>(own.result, null);
        const prev = await db('migration_run_steps as s').join('migration_runs as r', 'r.id', 's.run_id')
          .where({ 'r.source_id': record.sourceId, 'r.cwp_username': record.cwpUsername, 'r.status': 'done', 's.key': key })
          .whereIn('s.status', ['done', 'warning']).whereNot('r.id', runId)
          .orderBy('r.id', 'desc').first('s.result') as { result: unknown } | undefined;
        return prev ? json<Record<string, unknown> | null>(prev.result, null) : null;
      },
    };

    const byProvider = new Map(providers.map((p) => [p.id, p]));
    for (const { spec } of ordered) {
      const stepRow = stepRows.get(spec.key)!;
      if (FINISHED_STEP.has(stepRow.status)) continue;
      await checkpoint();
      currentKey = spec.key;
      stepBytes = 0;
      const started = await updateStep(stepRow.id, { status: 'running', attempts: db.raw('attempts + 1'), started_at: db.fn.now(), finished_at: null, error: null });
      if (!started) throw new MigrationInterruptedError('shutdown'); // lease taken over by another process
      await db('migration_runs').where({ id: runId }).update({ current_step: spec.key, updated_at: db.fn.now() });
      emitMigration({ entity: 'step', id: Number(stepRow.id), runId, planId: Number(row.plan_id), sourceId: Number(row.source_id), status: 'running' });
      await logRunEvent(runId, spec.key, 'info', 'stepStarted', { step: spec.key });

      try {
        const provider = byProvider.get(spec.provider);
        if (!provider) throw new StepError(`Fournisseur ${spec.provider} indisponible`, 'providerMissing');
        let outcome;
        try {
          outcome = await provider.run(spec, ctx);
        } catch (first) {
          // Connection lost DURING the step: retried once on a fresh session (steps are idempotent, MG5).
          if (!transientSourceError(first) || signal.aborted) throw first;
          await logRunEvent(runId, spec.key, 'warn', 'stepRetried', { step: spec.key, reason: (first as SourceConnectionError).code });
          await checkpoint();
          outcome = await provider.run(spec, ctx);
        }
        const warnings: MigrationWarning[] = outcome.warnings ?? [];
        const result = outcome.result ?? null;
        await updateStep(stepRow.id, {
          status: outcome.status, result: result ? JSON.stringify(result) : null, warnings: JSON.stringify(warnings), finished_at: db.fn.now(), error: null,
        });
        stepRow.status = outcome.status;
        for (const w of warnings) await logRunEvent(runId, spec.key, w.severity === 'info' ? 'info' : 'warn', w.code, w.params ?? null);
        await logRunEvent(runId, spec.key, 'info', outcome.status === 'skipped' ? 'stepSkipped' : 'stepDone', {
          step: spec.key, status: outcome.status, ...(outcome.status === 'skipped' && typeof result?.reason === 'string' ? { reason: result.reason } : {}),
        });
        emitMigration({ entity: 'step', id: Number(stepRow.id), runId, planId: Number(row.plan_id), sourceId: Number(row.source_id), status: outcome.status });
        doneWeight += Math.max(1, spec.weight ?? 1);
        doneBytes += Number(result?.bytes ?? 0) || 0;
        stepBytes = 0;
        await writeProgress(true);
      } catch (err) {
        const action = interruption(err);
        if (action) {
          await updateStep(stepRow.id, { status: 'pending', finished_at: null });
          throw new MigrationInterruptedError(action);
        }
        const message = stepErrorMessage(err);
        await updateStep(stepRow.id, { status: 'failed', error: message, finished_at: db.fn.now() });
        emitMigration({ entity: 'step', id: Number(stepRow.id), runId, planId: Number(row.plan_id), sourceId: Number(row.source_id), status: 'failed' });
        if (!(err instanceof StepError) && !(err instanceof AppError)) logger.warn({ runId, step: spec.key, err: scrubSecrets(String((err as Error)?.stack ?? err)).slice(0, 2000) }, 'migration step failed');
        await fail(`Étape ${spec.key} : ${message}`, errorCode(err));
        return;
      }
    }

    currentKey = null;
    doneWeight = totalWeight;
    if (await setStatus('done', { finished_at: db.fn.now(), current_step: null, error: null, progress: JSON.stringify(progressNow()), ...releaseLease })) {
      await logRunEvent(runId, null, 'info', 'runDone', { kind: row.kind });
      await auditRun(row, 'migration.run.done', {});
      await finishHooks(runId);
    }
  } catch (err) {
    const action = interruption(err);
    try {
      if (action === 'pause') {
        if (await setStatus('paused', { ...releaseLease, progress: JSON.stringify(progressNow()) })) {
          await logRunEvent(runId, currentKey, 'info', 'runPaused', { step: currentKey });
        }
      } else if (action === 'cancel') {
        if (await setStatus('cancelled', { ...releaseLease, finished_at: db.fn.now(), progress: JSON.stringify(progressNow()) })) {
          await logRunEvent(runId, currentKey, 'warn', 'runCancelled', { step: currentKey });
          await finishHooks(runId);
        }
      } else if (action === 'shutdown') {
        // Resumable at the next start: the lease is released now instead of expiring.
        if (await owned().update({ lease_until: db.fn.now(), progress: JSON.stringify(progressNow()), updated_at: db.fn.now() })) {
          await logRunEvent(runId, currentKey, 'info', 'runInterrupted', { step: currentKey });
        }
      } else {
        await fail(stepErrorMessage(err), errorCode(err));
      }
    } catch (inner) {
      logger.error({ err: inner, runId }, 'migration run state not saved');
    }
  } finally {
    clearInterval(renew);
    if (sessionPromise) {
      try { await (await sessionPromise).close(); } catch { /* connection already gone */ }
    }
  }
}
