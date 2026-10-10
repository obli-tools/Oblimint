import type { Request } from 'express';
import type { Knex } from 'knex';
import type {
  CwpInventory, MigrationAccountChoice, MigrationPlan, MigrationPlanChoices, MigrationPlanCreate, MigrationPlanResult,
  MigrationPlanStatus, MigrationPlanSummary, MigrationTargetCatalog,
} from '@oblimint/shared';
import { db } from '../../../db';
import { AppError } from '../../../middleware/errorHandler';
import { auditService } from '../../audit.service';
import { isUniqueViolation } from '../../hosting/hostingValidation.service';
import { json } from '../../hosting/rows';
import { emitMigration } from '../events';
import type { PlanTargetContext } from './context';
import { computePlan, pruneChoices } from './compute';
import { defaultChoices } from './defaults';
import { loadTargetCatalog, loadTargetContext } from './targetContext';
import { choicesHash } from './util';

// ─────────────────────────────────────────────────────────────────────────────
// Migration plans (docs/P5-PLAN.md §8). OWNED BY MODULE `planner`. A plan =
// staff choices (MigrationPlanChoices) + the computed MigrationPlanResult
// (pure function of inventory × choices × target context = the dry-run).
// Every write recomputes against a freshly read target context; `compute`
// re-reads it on demand (names taken since, plans, engines). Platform tables
// (no tenant scope): the routes are platform-admin-on-master only (MG4).
// Audit (tenant 1): migration.plan.{create,update,rebase,delete} with ids and
// counts only — never inventory content (MG2: there is no secret in it
// anyway). Status: 'draft' until removed with runs ('archived'); the engine
// reads the result; loadForExecution refuses an archived plan (planArchived).
// ─────────────────────────────────────────────────────────────────────────────

const AUDIT_TENANT = 1;

export interface PlanForExecution {
  plan: MigrationPlan;
  inventory: CwpInventory;
}

interface PlanRow {
  id: number;
  source_id: number;
  discovery_id: number;
  name: string;
  status: MigrationPlanStatus;
  choices: unknown;
  choices_hash: string;
  result: unknown;
  computed_at: Date | string | null;
  created_by: number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface DiscoveryRow {
  id: number;
  source_id: number;
  status: string;
  inventory: unknown;
}

const iso = (v: Date | string | null): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString());

function notFound(what = 'Migration plan'): AppError {
  return new AppError(404, `${what} not found`, 'notFound');
}

function toPlan(r: PlanRow): MigrationPlan {
  const result = json<MigrationPlanResult | null>(r.result, null);
  return {
    id: Number(r.id),
    sourceId: Number(r.source_id),
    discoveryId: Number(r.discovery_id),
    name: r.name,
    status: r.status,
    computedAt: iso(r.computed_at),
    stale: result?.choicesHash !== r.choices_hash,
    totals: result?.totals ?? null,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    choices: json<MigrationPlanChoices>(r.choices, { global: undefined as never, packages: {}, accounts: {} }),
    result,
  };
}

async function loadRow(id: number, conn: Knex | Knex.Transaction = db, lock = false): Promise<PlanRow> {
  const q = conn('migration_plans').where({ id });
  if (lock) q.forUpdate();
  const row = await q.first() as PlanRow | undefined;
  if (!row) throw notFound();
  return row;
}

async function loadDiscovery(id: number, conn: Knex | Knex.Transaction = db): Promise<DiscoveryRow> {
  const row = await conn('migration_discoveries').where({ id }).first('id', 'source_id', 'status', 'inventory') as DiscoveryRow | undefined;
  if (!row) throw notFound('Discovery');
  return row;
}

/** Inventory of a finished discovery (409 discoveryNotDone otherwise). */
function inventoryOf(d: DiscoveryRow): CwpInventory {
  const inv = d.status === 'done' ? json<CwpInventory | null>(d.inventory, null) : null;
  if (!inv) throw new AppError(409, 'The discovery is not finished', 'discoveryNotDone');
  return inv;
}

function auditDetails(row: { id: number; source_id: number; discovery_id: number }, result: MigrationPlanResult | null, extra: Record<string, unknown> = {}) {
  return {
    planId: Number(row.id),
    sourceId: Number(row.source_id),
    discoveryId: Number(row.discovery_id),
    accounts: result?.totals.accounts ?? 0,
    selected: result?.totals.selected ?? 0,
    blocked: result?.totals.blocked ?? 0,
    ...extra,
  };
}

function emitPlan(row: { id: number; source_id: number; status?: string }): void {
  emitMigration({ entity: 'plan', id: Number(row.id), sourceId: Number(row.source_id), planId: Number(row.id), status: row.status ?? null });
}

/** Prunes the choices against the inventory and computes the result. */
function evaluate(inventory: CwpInventory, raw: MigrationPlanChoices, ctx: PlanTargetContext, discoveryId: number) {
  const choices = pruneChoices(inventory, raw);
  const result = computePlan(inventory, choices, ctx, discoveryId);
  return { choices, result };
}

/**
 * Read-modify-write of a plan: the target context is read BEFORE the transaction (no second pool connection
 * while the transaction holds one), the row is locked, `mutate` gives the new choices / discovery, the result is
 * recomputed and saved.
 */
async function rewrite(
  id: number,
  mutate: (row: PlanRow, choices: MigrationPlanChoices, trx: Knex.Transaction) => { choices: MigrationPlanChoices; discoveryId?: number } | Promise<{ choices: MigrationPlanChoices; discoveryId?: number }>,
): Promise<{ before: PlanRow; after: PlanRow; result: MigrationPlanResult }> {
  const first = await loadRow(id);
  const ctx = await loadTargetContext(Number(first.source_id));
  return db.transaction(async (trx) => {
    const before = await loadRow(id, trx, true);
    const { choices: raw, discoveryId } = await mutate(before, json<MigrationPlanChoices>(before.choices, { global: undefined as never, packages: {}, accounts: {} }), trx);
    const discId = discoveryId ?? Number(before.discovery_id);
    const inventory = inventoryOf(await loadDiscovery(discId, trx));
    const { choices, result } = evaluate(inventory, raw, ctx, discId);
    const now = new Date();
    const [after] = await trx('migration_plans').where({ id }).update({
      discovery_id: discId,
      choices: JSON.stringify(choices),
      choices_hash: result.choicesHash,
      result: JSON.stringify(result),
      computed_at: now,
      updated_at: now,
    }).returning('*') as PlanRow[];
    return { before, after, result };
  });
}

export const migrationPlansService = {
  async list(q: { sourceId?: number | null }): Promise<MigrationPlanSummary[]> {
    const query = db('migration_plans').select(
      'id', 'source_id', 'discovery_id', 'name', 'status', 'choices_hash', 'computed_at', 'created_by', 'created_at', 'updated_at',
      db.raw(`result->'totals' AS totals`), db.raw(`result->>'choicesHash' AS result_hash`),
    ).orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]);
    if (q.sourceId) query.where({ source_id: q.sourceId });
    const rows = await query as Array<PlanRow & { totals: unknown; result_hash: string | null }>;
    return rows.map((r) => ({
      id: Number(r.id),
      sourceId: Number(r.source_id),
      discoveryId: Number(r.discovery_id),
      name: r.name,
      status: r.status,
      computedAt: iso(r.computed_at),
      stale: r.result_hash !== r.choices_hash,
      totals: json<MigrationPlanResult['totals'] | null>(r.totals, null),
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
    }));
  },

  /** Default choices from the inventory, computed at once (201). 409 discoveryNotDone / nameTaken. */
  async create(req: Request, body: MigrationPlanCreate): Promise<MigrationPlan> {
    const disc = await loadDiscovery(body.discoveryId);
    const inventory = inventoryOf(disc);
    const name = body.name.trim();
    const nameTaken = () => new AppError(409, 'A plan with this name already exists for this source', 'nameTaken');
    if (await db('migration_plans').where({ source_id: disc.source_id, name }).first('id')) throw nameTaken();
    const ctx = await loadTargetContext(Number(disc.source_id));
    const { choices, result } = evaluate(inventory, defaultChoices(inventory, ctx), ctx, Number(disc.id));
    let row: PlanRow;
    try {
      const now = new Date();
      [row] = await db('migration_plans').insert({
        source_id: disc.source_id,
        discovery_id: disc.id,
        name,
        status: 'draft',
        choices: JSON.stringify(choices),
        choices_hash: result.choicesHash,
        result: JSON.stringify(result),
        computed_at: now,
        created_by: req.session?.userId ?? null,
        created_at: now,
        updated_at: now,
      }).returning('*') as PlanRow[];
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
    await auditService.logReqAs(req, AUDIT_TENANT, 'migration.plan.create', {
      resourceType: 'migration_plan', resourcePath: String(row.id), details: auditDetails(row, result, { name }),
    });
    emitPlan(row);
    return toPlan(row);
  },

  async get(id: number): Promise<MigrationPlan> {
    return toPlan(await loadRow(id));
  },

  /** Full replace of the choices (validated by the route) + recompute. */
  async setChoices(req: Request, id: number, choices: MigrationPlanChoices): Promise<MigrationPlan> {
    const { after, result } = await rewrite(id, () => ({ choices }));
    await auditService.logReqAs(req, AUDIT_TENANT, 'migration.plan.update', {
      resourceType: 'migration_plan', resourcePath: String(id), details: auditDetails(after, result, { scope: 'choices' }),
    });
    emitPlan(after);
    return toPlan(after);
  },

  /** Replace the choice of ONE account + recompute. 404 unknown account. */
  async setAccountChoice(req: Request, id: number, cwpUsername: string, choice: MigrationAccountChoice): Promise<MigrationPlan> {
    const { after, result } = await rewrite(id, async (row, current, trx) => {
      const inventory = inventoryOf(await loadDiscovery(Number(row.discovery_id), trx));
      if (!inventory.accounts.some((a) => a.username === cwpUsername)) throw notFound('Account');
      return { choices: { ...current, accounts: { ...(current.accounts ?? {}), [cwpUsername]: choice } } };
    });
    await auditService.logReqAs(req, AUDIT_TENANT, 'migration.plan.update', {
      resourceType: 'migration_plan', resourcePath: String(id), details: auditDetails(after, result, { scope: 'account', account: cwpUsername }),
    });
    emitPlan(after);
    return toPlan(after);
  },

  /** Dry-run against the CURRENT target state. */
  async compute(req: Request, id: number): Promise<MigrationPlan> {
    const { after, result } = await rewrite(id, (_row, current) => ({ choices: current }));
    // The result is what the engine executes: every rewrite of it is audited.
    await auditService.logReqAs(req, AUDIT_TENANT, 'migration.plan.update', {
      resourceType: 'migration_plan', resourcePath: String(id), details: auditDetails(after, result, { scope: 'compute' }),
    });
    emitPlan(after);
    return toPlan(after);
  },

  /** Moves the plan onto a newer discovery of the same source (choices kept, unknown keys dropped) + recompute. */
  async rebase(req: Request, id: number, discoveryId: number): Promise<MigrationPlan> {
    const { before, after, result } = await rewrite(id, async (row, current, trx) => {
      const disc = await loadDiscovery(discoveryId, trx);
      if (Number(disc.source_id) !== Number(row.source_id)) {
        throw new AppError(409, 'The discovery belongs to another source', 'discoveryOtherSource');
      }
      inventoryOf(disc);
      return { choices: current, discoveryId: Number(disc.id) };
    });
    await auditService.logReqAs(req, AUDIT_TENANT, 'migration.plan.rebase', {
      resourceType: 'migration_plan', resourcePath: String(id), details: auditDetails(after, result, { fromDiscoveryId: Number(before.discovery_id) }),
    });
    emitPlan(after);
    return toPlan(after);
  },

  /** Archive when runs exist (the report stays), delete otherwise. */
  async remove(req: Request, id: number): Promise<{ deleted: boolean; archived: boolean }> {
    const out = await db.transaction(async (trx) => {
      const row = await loadRow(id, trx, true);
      const runs = await trx('migration_runs').where({ plan_id: id }).first('id');
      if (runs) {
        await trx('migration_plans').where({ id }).update({ status: 'archived', updated_at: new Date() });
        return { row, deleted: false, archived: true };
      }
      await trx('migration_plans').where({ id }).del();
      return { row, deleted: true, archived: false };
    });
    await auditService.logReqAs(req, AUDIT_TENANT, 'migration.plan.delete', {
      resourceType: 'migration_plan', resourcePath: String(id),
      details: { planId: id, sourceId: Number(out.row.source_id), discoveryId: Number(out.row.discovery_id), archived: out.archived },
    });
    emitPlan({ id, source_id: out.row.source_id, status: out.archived ? 'archived' : 'deleted' });
    return { deleted: out.deleted, archived: out.archived };
  },

  async targets(): Promise<MigrationTargetCatalog> {
    return loadTargetCatalog();
  },

  /** For the engine: plan (result fresh, 409 planStale otherwise) + inventory of its discovery. */
  async loadForExecution(id: number): Promise<PlanForExecution> {
    const row = await loadRow(id);
    const plan = toPlan(row);
    // An archived plan was removed by the staff (kept only for its runs' report): no new run from it.
    if (plan.status === 'archived') throw new AppError(409, 'The plan is archived', 'planArchived');
    if (!plan.result || plan.result.choicesHash !== choicesHash(plan.choices, plan.discoveryId) || plan.result.discoveryId !== plan.discoveryId) {
      throw new AppError(409, 'The plan changed since its last computation: compute it again', 'planStale');
    }
    const inventory = inventoryOf(await loadDiscovery(plan.discoveryId));
    return { plan, inventory };
  },
};
