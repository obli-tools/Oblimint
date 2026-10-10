import type {
  MigrationAccountPlan, MigrationMessage, MigrationResyncPart, MigrationRun, MigrationRunEvent, MigrationRunKind, MigrationRunStatus,
  MigrationRunStep, MigrationStepStatus, MigrationWarning, PlannedPackage,
} from '@oblimint/shared';
import { db } from '../../../db';
import { AppError } from '../../../middleware/errorHandler';
import type { MigrationRunRecord } from '../contracts/execution';

// ─────────────────────────────────────────────────────────────────────────────
// Rows of the engine tables (migration 008): migration_runs,
// migration_run_steps, migration_run_events — mapping and small queries.
// The frozen copy of the account plan a run was started with lives in the
// synthetic step FROZEN_STEP_KEY (status done, never executed, hidden from
// the API): no extra column (MG2: it holds no secret, like the plan itself).
// ─────────────────────────────────────────────────────────────────────────────

export const FROZEN_STEP_KEY = '_plan';
export const ACTIVE_STATUSES: MigrationRunStatus[] = ['queued', 'running', 'paused'];

export interface RunRow {
  id: number;
  plan_id: number;
  source_id: number;
  cwp_username: string;
  kind: MigrationRunKind;
  parts: unknown;
  mirror_deletes: boolean;
  status: MigrationRunStatus;
  target_tenant_id: number;
  target_account_id: number | null;
  current_step: string | null;
  progress: unknown;
  error: string | null;
  attempts: number;
  lease_owner: string | null;
  lease_until: Date | string | null;
  requested_action: 'pause' | 'cancel' | null;
  created_by: number | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface StepRow {
  id: number;
  run_id: number;
  key: string;
  provider: 'web-db' | 'mail-dns';
  phase: number;
  position: number;
  label: unknown;
  status: MigrationStepStatus;
  attempts: number;
  result: unknown;
  warnings: unknown;
  error: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

interface EventRow {
  id: number | string;
  run_id: number;
  step_key: string | null;
  level: MigrationRunEvent['level'];
  code: string;
  params: unknown;
  message: string | null;
  created_at: Date | string;
}

/** Frozen copy of what a run executes (written by startRuns). */
export interface FrozenRunPlan {
  account: MigrationAccountPlan;
  packages: PlannedPackage[];
  computedAt: string;
  choicesHash: string;
  discoveryId: number;
}

export function json<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T; } catch { return fallback; }
  }
  return v as T;
}

export const iso = (v: Date | string | null | undefined): string | null =>
  (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString());

export function toRun(r: RunRow): MigrationRun {
  const p = json<{ done?: number; total?: number; bytes?: number | null }>(r.progress, {});
  return {
    id: Number(r.id),
    planId: Number(r.plan_id),
    sourceId: Number(r.source_id),
    cwpUsername: r.cwp_username,
    kind: r.kind,
    parts: json<MigrationResyncPart[]>(r.parts, []),
    mirrorDeletes: !!r.mirror_deletes,
    status: r.status,
    targetTenantId: Number(r.target_tenant_id),
    targetAccountId: r.target_account_id === null ? null : Number(r.target_account_id),
    currentStep: r.current_step,
    progress: { done: Number(p.done ?? 0), total: Number(p.total ?? 0), bytes: p.bytes === undefined || p.bytes === null ? null : Number(p.bytes) },
    error: r.error,
    createdBy: r.created_by === null ? null : Number(r.created_by),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

export function toRecord(r: RunRow): MigrationRunRecord {
  return {
    id: Number(r.id),
    planId: Number(r.plan_id),
    sourceId: Number(r.source_id),
    cwpUsername: r.cwp_username,
    kind: r.kind,
    parts: json<MigrationResyncPart[]>(r.parts, []),
    mirrorDeletes: !!r.mirror_deletes,
    targetTenantId: Number(r.target_tenant_id),
    targetAccountId: r.target_account_id === null ? null : Number(r.target_account_id),
    createdBy: r.created_by === null ? null : Number(r.created_by),
  };
}

export function toStep(r: StepRow): MigrationRunStep {
  return {
    id: Number(r.id),
    runId: Number(r.run_id),
    key: r.key,
    provider: r.provider,
    phase: Number(r.phase),
    label: json<MigrationMessage>(r.label, { code: 'steps.unknown' }),
    status: r.status,
    attempts: Number(r.attempts),
    result: json<Record<string, unknown> | null>(r.result, null),
    warnings: json<MigrationWarning[]>(r.warnings, []),
    error: r.error,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

export function toEvent(r: EventRow): MigrationRunEvent {
  return {
    id: Number(r.id),
    runId: Number(r.run_id),
    stepKey: r.step_key,
    level: r.level,
    code: r.code,
    params: json<Record<string, string | number | boolean | null> | null>(r.params, null),
    message: r.message,
    createdAt: iso(r.created_at)!,
  };
}

export async function runRow(id: number): Promise<RunRow> {
  const row = await db('migration_runs').where({ id }).first() as RunRow | undefined;
  if (!row) throw new AppError(404, 'Run not found', 'notFound');
  return row;
}

/** Steps of a run in execution order (phase, provider web-db then mail-dns, position), frozen copy excluded. */
export async function runSteps(runId: number): Promise<StepRow[]> {
  return await db('migration_run_steps').where({ run_id: runId }).whereNot('key', FROZEN_STEP_KEY)
    .orderBy('phase').orderByRaw(`CASE provider WHEN 'web-db' THEN 0 ELSE 1 END`).orderBy('position').orderBy('id') as StepRow[];
}

export async function frozenPlan(runId: number): Promise<FrozenRunPlan | null> {
  const row = await db('migration_run_steps').where({ run_id: runId, key: FROZEN_STEP_KEY }).first('result') as { result: unknown } | undefined;
  const v = json<FrozenRunPlan | null>(row?.result, null);
  return v && v.account ? v : null;
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return !!e && (e.code === '23505' || /duplicate key|unique constraint/i.test(e.message ?? ''));
}
