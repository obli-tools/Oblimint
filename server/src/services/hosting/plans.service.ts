import type { Request } from 'express';
import type { Plan, PlanLimits } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import type { PlanInputBody, PlanUpdateBody } from '../../validators/hosting.schema';
import { auditService } from '../audit.service';
import { reconcileService } from '../docker/reconcile.service';
import { actorCan, assertNeedSomewhere, assertStaff, type HostingActor, type HostingNeed } from './access';
import { envelopeService, withTenantLock } from './envelope.service';
import { emitHosting } from './events';
import { isUniqueViolation } from './hostingValidation.service';
import { planLimits, toPlan, type PlanRow } from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// Plans (packages) of a tenant — staff only. A plan is checked against the
// tenant envelope on creation and on every update (envelope.service.ts).
// ─────────────────────────────────────────────────────────────────────────────

function selectPlans() {
  return db('plans as p')
    .join('tenants as t', 't.id', 'p.tenant_id')
    .select('p.*', 't.name as tenant_name',
      db.raw('(SELECT COUNT(*) FROM hosting_accounts a WHERE a.plan_id = p.id) AS account_count'));
}

function notFound(): AppError {
  return new AppError(404, 'Plan not found', 'notFound');
}

function emitPlan(plan: { id: number; tenant_id: number }, action: 'created' | 'updated' | 'deleted'): void {
  emitHosting(HostingSocketEvents.HOSTING_CHANGED, { entity: 'plan', id: plan.id, action }, { tenantId: plan.tenant_id });
}

/** One plan visible to a STAFF actor (god view: any tenant), with `need`. 404 / 403 otherwise. */
async function loadPlan(actor: HostingActor, planId: number, need: HostingNeed): Promise<PlanRow> {
  assertStaff(actor);
  const row = await selectPlans().where('p.id', planId).first() as PlanRow | undefined;
  if (!row || (!actor.globalView && row.tenant_id !== actor.tenantId)) throw notFound();
  if (!actorCan(actor, need, { tenantId: row.tenant_id, accountId: null })) throw new AppError(403, 'Insufficient permissions');
  return row;
}

function nameTaken(): AppError {
  return new AppError(409, 'A plan with this name already exists', 'planNameTaken');
}

export const plansService = {
  async list(actor: HostingActor, filterTenantId?: number | null): Promise<Plan[]> {
    assertStaff(actor);
    assertNeedSomewhere(actor, 'read');
    const q = selectPlans().orderBy([{ column: 't.name' }, { column: 'p.name' }]);
    if (!actor.globalView) q.where('p.tenant_id', actor.tenantId);
    else if (filterTenantId && Number.isInteger(filterTenantId)) q.where('p.tenant_id', filterTenantId);
    return (await q as PlanRow[]).map(toPlan);
  },

  async get(actor: HostingActor, planId: number): Promise<Plan> {
    return toPlan(await loadPlan(actor, planId, 'read'));
  },

  /** Raw row (account creation / plan change): plan of `tenantId`, else 404. */
  async rowInTenant(planId: number, tenantId: number): Promise<PlanRow> {
    const row = await db('plans').where({ id: planId, tenant_id: tenantId }).first() as PlanRow | undefined;
    if (!row) throw notFound();
    return row;
  },

  /** POST /plans — created in the caller's current tenant. */
  async create(req: Request, actor: HostingActor, body: PlanInputBody): Promise<Plan> {
    assertStaff(actor);
    assertNeedSomewhere(actor, 'plans.manage');
    const tenantId = actor.tenantId;
    const limits: PlanLimits = body.limits;
    if (await db('plans').where({ tenant_id: tenantId, name: body.name }).first('id')) throw nameTaken();
    await envelopeService.assertPlanFits(tenantId, limits, null);
    let id: number;
    try {
      const [row] = await db('plans').insert({
        tenant_id: tenantId,
        name: body.name,
        description: body.description ?? null,
        limits: JSON.stringify(limits),
        is_active: body.isActive ?? true,
      }).returning('id') as Array<{ id: number }>;
      id = row.id;
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
    await auditService.logReqAs(req, tenantId, 'plan.create', { resourceType: 'plan', resourcePath: String(id), details: { name: body.name, limits } });
    emitPlan({ id, tenant_id: tenantId }, 'created');
    return this.get(actor, id);
  },

  async update(req: Request, actor: HostingActor, planId: number, body: PlanUpdateBody): Promise<Plan> {
    const row = await loadPlan(actor, planId, 'plans.manage');
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined && body.name !== row.name) {
      if (await db('plans').where({ tenant_id: row.tenant_id, name: body.name }).whereNot({ id: row.id }).first('id')) throw nameTaken();
      patch.name = body.name;
    }
    if (body.description !== undefined) patch.description = body.description;
    if (body.isActive !== undefined) patch.is_active = body.isActive;
    const before = planLimits(row.limits);
    let limitsChanged = false;
    let next: PlanLimits = before;
    if (body.limits !== undefined) {
      next = { ...before, ...body.limits };
      limitsChanged = JSON.stringify(next) !== JSON.stringify(before);
      if (limitsChanged) patch.limits = JSON.stringify(next);
    }
    if (Object.keys(patch).length > 0) {
      patch.updated_at = db.fn.now();
      try {
        // Envelope check + write under the tenant lock (no concurrent account
        // creation / plan change can slip between them). `before` released:
        // only the dimensions that grow are checked.
        await withTenantLock(row.tenant_id, async (trx) => {
          if (limitsChanged) await envelopeService.assertPlanFits(row.tenant_id, next, row.id, before, trx);
          await trx('plans').where({ id: row.id, tenant_id: row.tenant_id }).update(patch);
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw nameTaken();
        throw err;
      }
      await auditService.logReqAs(req, row.tenant_id, 'plan.update', {
        resourceType: 'plan', resourcePath: String(row.id),
        details: { name: (patch.name as string | undefined) ?? row.name, fields: Object.keys(patch).filter((k) => k !== 'updated_at') },
      });
      emitPlan(row, 'updated');
    }
    // New quota / CPU / memory / bases: every account on the plan converges.
    if (limitsChanged) {
      const accounts = await db('hosting_accounts').where({ plan_id: row.id, tenant_id: row.tenant_id }).select('id') as Array<{ id: number }>;
      for (const a of accounts) reconcileService.requestAccount(a.id, 'plan-updated');
    }
    return this.get(actor, row.id);
  },

  async remove(req: Request, actor: HostingActor, planId: number): Promise<void> {
    const row = await loadPlan(actor, planId, 'plans.manage');
    const used = Number(row.account_count ?? 0);
    if (used > 0) throw new AppError(409, `The plan is used by ${used} account(s)`, 'planInUse', { accountCount: used });
    // The FK (RESTRICT) still guards a race with an account creation.
    try {
      await db('plans').where({ id: row.id, tenant_id: row.tenant_id }).del();
    } catch (err) {
      if ((err as { code?: string }).code === '23503') throw new AppError(409, 'The plan is used by an account', 'planInUse');
      throw err;
    }
    await auditService.logReqAs(req, row.tenant_id, 'plan.delete', { resourceType: 'plan', resourcePath: String(row.id), details: { name: row.name } });
    emitPlan(row, 'deleted');
  },
};
