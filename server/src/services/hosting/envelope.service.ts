import type { EnvelopeDimension, EnvelopeViolation, PlanLimits, TenantEnvelopeUsage, TenantLimits } from '@oblimint/shared';
import { DEFAULT_TENANT_LIMITS } from '@oblimint/shared';
import type { Knex } from 'knex';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { json, planLimits } from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// Tenant envelope (ARCHITECTURE §4): what a reseller may hand out through the
// plans of its accounts, checked
//   - at ALLOCATION (sum of the plans of the tenant's accounts ≤ envelope),
//     skipped when the tenant may oversell;
//   - at USAGE (real counts of sites / domains vs plan AND tenant), ALWAYS.
// The allocation rule is a pure function (checkAllocation) so every combination
// is unit-tested; the rest is a thin DB loader.
// ─────────────────────────────────────────────────────────────────────────────

/** Plan dimensions summed against the tenant envelope (maxAccounts is a count). */
export const PLAN_ENVELOPE_DIMENSIONS = [
  'diskMb', 'trafficMbPerMonth', 'maxSites', 'maxDomains', 'maxMailboxes', 'maxDatabases', 'cpuCores', 'memoryMb',
] as const satisfies ReadonlyArray<EnvelopeDimension & keyof PlanLimits>;

export interface AllocationChange {
  /** Plan(s) being allocated (a new account, the new plan of N accounts…). */
  add?: PlanLimits | PlanLimits[];
  /** Plan(s) being released (the old plan of the account(s)). */
  remove?: PlanLimits | PlanLimits[];
}

const list = (v: PlanLimits | PlanLimits[] | undefined): PlanLimits[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Finite sum and number of unlimited (null) values of one dimension. */
function tally(plans: readonly PlanLimits[], dim: typeof PLAN_ENVELOPE_DIMENSIONS[number]): { sum: number; unlimited: number } {
  let sum = 0;
  let unlimited = 0;
  for (const p of plans) {
    const v = p[dim];
    if (v === null || v === undefined) unlimited++;
    else sum += v;
  }
  return { sum, unlimited };
}

/** Sum of one dimension, Infinity when any plan is unlimited (null). */
function total(plans: readonly PlanLimits[], dim: typeof PLAN_ENVELOPE_DIMENSIONS[number]): number {
  const t = tally(plans, dim);
  return t.unlimited > 0 ? Infinity : t.sum;
}

/** Floating sums of cpuCores (0.1 + 0.2…) compared with a small tolerance. */
const EPSILON = 1e-9;

/**
 * Envelope violations caused by `change` on top of the plans already
 * allocated to the tenant's accounts (`remove` entries are among them). A
 * dimension is reported only when the change GROWS it and the new total
 * exceeds a finite tenant limit (a tenant already over its envelope can still
 * downgrade). An unlimited (null) plan value against a finite limit is a
 * violation with `requested: null`. `accountCountDelta` (+1 on creation) is
 * checked against maxAccounts. allowOversell → never any violation.
 */
export function checkAllocation(
  tenantLimits: TenantLimits,
  existingPlans: readonly PlanLimits[],
  change: AllocationChange,
  accountCountDelta = 0,
): EnvelopeViolation[] {
  if (tenantLimits.allowOversell) return [];
  const add = list(change.add);
  const remove = list(change.remove);
  const out: EnvelopeViolation[] = [];

  for (const dim of PLAN_ENVELOPE_DIMENSIONS) {
    const limit = tenantLimits[dim];
    if (limit === null || limit === undefined) continue;
    const a = tally(add, dim);
    const r = tally(remove, dim);
    const grows = a.unlimited > r.unlimited || (a.unlimited === r.unlimited && a.sum - r.sum > EPSILON);
    if (!grows) continue;
    const e = tally(existingPlans, dim);
    const unlimitedAfter = Math.max(0, e.unlimited - r.unlimited) + a.unlimited;
    const sumAfter = Math.max(0, e.sum - r.sum) + a.sum;
    if (unlimitedAfter > 0) out.push({ dimension: dim, limit, requested: null });
    else if (sumAfter - limit > EPSILON) out.push({ dimension: dim, limit, requested: roundDim(sumAfter) });
  }

  const maxAccounts = tenantLimits.maxAccounts;
  if (maxAccounts !== null && maxAccounts !== undefined && accountCountDelta > 0) {
    const after = existingPlans.length + accountCountDelta;
    if (after > maxAccounts) out.push({ dimension: 'maxAccounts', limit: maxAccounts, requested: after });
  }
  return out;
}

const roundDim = (v: number): number => Math.round(v * 1000) / 1000;

/** Throws 409 envelopeExceeded (details: the violations) when there is any. */
export function assertNoViolation(violations: EnvelopeViolation[]): void {
  if (violations.length > 0) {
    throw new AppError(409, 'The tenant envelope does not allow this allocation', 'envelopeExceeded', violations);
  }
}

// ── DB loaders ───────────────────────────────────────────────────────────────

/** Query runner: the shared pool or the transaction of the caller. */
type Conn = Knex | Knex.Transaction;

/**
 * Serialises every envelope / usage check of a tenant with the write it
 * guards: `SELECT … FOR UPDATE` on the tenant row, held until `trx` ends.
 * Without it two concurrent creations both read N < limit and both insert
 * (maxAccounts, plan / tenant maxSites / maxDomains, summed disk / CPU /
 * memory). One lock per tenant also covers the per-account limits (an account
 * belongs to exactly one tenant) and the account deletion flag.
 */
export async function lockTenant(trx: Knex.Transaction, tenantId: number): Promise<void> {
  const row = await trx('tenants').where({ id: tenantId }).forUpdate().first('id');
  if (!row) throw new AppError(404, 'Tenant not found', 'notFound');
}

/** Runs `fn` in a transaction holding the tenant lock (lockTenant). */
export function withTenantLock<T>(tenantId: number, fn: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (trx) => {
    await lockTenant(trx, tenantId);
    return fn(trx);
  });
}

/** Envelope of a tenant (every key present; unknown / missing → defaults). */
export async function loadTenantLimits(tenantId: number, conn: Conn = db): Promise<TenantLimits> {
  const row = await conn('tenants').where({ id: tenantId }).first('limits') as { limits: unknown } | undefined;
  if (!row) throw new AppError(404, 'Tenant not found', 'notFound');
  const raw = json<Record<string, unknown>>(row.limits, {});
  const out: TenantLimits = { ...DEFAULT_TENANT_LIMITS };
  for (const key of Object.keys(DEFAULT_TENANT_LIMITS) as Array<keyof TenantLimits>) {
    const v = raw[key];
    if (key === 'allowOversell') out.allowOversell = v === true;
    else if (typeof v === 'number' && Number.isFinite(v)) (out as unknown as Record<string, number | null>)[key] = v;
    else if (v === null) (out as unknown as Record<string, number | null>)[key] = null;
  }
  return out;
}

/** Plans of the tenant's accounts, one entry per account (accounts being deleted excluded). */
export async function loadAllocatedPlans(tenantId: number, conn: Conn = db): Promise<Array<{ accountId: number; planId: number; limits: PlanLimits }>> {
  const rows = await conn('hosting_accounts as a')
    .join('plans as p', 'p.id', 'a.plan_id')
    .where('a.tenant_id', tenantId)
    .whereNot('a.status', 'deleting')
    .select('a.id as account_id', 'a.plan_id', 'p.limits') as Array<{ account_id: number; plan_id: number; limits: unknown }>;
  return rows.map((r) => ({ accountId: Number(r.account_id), planId: Number(r.plan_id), limits: planLimits(r.limits) }));
}

export const envelopeService = {
  /** 409 envelopeExceeded unless a new account on `plan` fits the tenant envelope. */
  async assertAccountFits(tenantId: number, plan: PlanLimits, conn: Conn = db): Promise<void> {
    const limits = await loadTenantLimits(tenantId, conn);
    const allocated = await loadAllocatedPlans(tenantId, conn);
    assertNoViolation(checkAllocation(limits, allocated.map((a) => a.limits), { add: plan }, 1));
  },

  /** 409 unless moving `accountId` from its current plan to `next` fits. */
  async assertPlanChangeFits(tenantId: number, accountId: number, next: PlanLimits, conn: Conn = db): Promise<void> {
    const limits = await loadTenantLimits(tenantId, conn);
    const allocated = await loadAllocatedPlans(tenantId, conn);
    const mine = allocated.find((a) => a.accountId === accountId);
    const existing = allocated.map((a) => a.limits);
    assertNoViolation(checkAllocation(limits, existing, { add: next, remove: mine?.limits }, 0));
  },

  /**
   * Plan creation / update: the plan alone must fit (a single account on it),
   * and when accounts already use it the new tenant sums must fit too. On an
   * update `previous` (the plan's current limits) is released first, so only
   * the dimensions that GROW are checked: a plan left over a since-lowered
   * envelope can still be brought down, or have an unrelated limit edited.
   */
  async assertPlanFits(tenantId: number, next: PlanLimits, planId: number | null, previous: PlanLimits | null = null, conn: Conn = db): Promise<void> {
    const limits = await loadTenantLimits(tenantId, conn);
    if (limits.allowOversell) return;
    const single = checkAllocation(limits, [], previous ? { add: next, remove: previous } : { add: next }, 0);
    assertNoViolation(single);
    if (planId === null) return;
    const allocated = await loadAllocatedPlans(tenantId, conn);
    const existing = allocated.map((a) => a.limits);
    const users = allocated.filter((a) => a.planId === planId).map((a) => a.limits);
    if (users.length === 0) return;
    assertNoViolation(checkAllocation(limits, existing, { remove: users, add: users.map(() => next) }, 0));
  },

  /** GET /plans/envelope */
  async usage(tenantId: number): Promise<TenantEnvelopeUsage> {
    const [limits, allocated, sites, domains, disk] = await Promise.all([
      loadTenantLimits(tenantId),
      loadAllocatedPlans(tenantId),
      count(db('sites').where({ tenant_id: tenantId })),
      count(db('domains').where({ tenant_id: tenantId })),
      db('hosting_accounts').where({ tenant_id: tenantId }).whereNotNull('disk_used_bytes')
        .first(db.raw('COALESCE(SUM(disk_used_bytes), 0) AS bytes'), db.raw('COUNT(*) AS n')) as Promise<{ bytes: string | number; n: string | number } | undefined>,
    ]);
    const plans = allocated.map((a) => a.limits);
    const allocatedSums = {} as Record<EnvelopeDimension, number | null>;
    for (const dim of PLAN_ENVELOPE_DIMENSIONS) {
      const t = total(plans, dim);
      allocatedSums[dim] = t === Infinity ? null : roundDim(t);
    }
    allocatedSums.maxAccounts = plans.length;
    const measured = Number(disk?.n ?? 0) > 0;
    return {
      tenantId,
      limits,
      allocated: allocatedSums,
      used: {
        accounts: plans.length,
        sites,
        domains,
        diskMb: measured ? Math.round(Number(disk?.bytes ?? 0) / 1048576) : null,
      },
    };
  },

  /**
   * Real usage before creating a site / domain (ALWAYS checked, even with
   * oversell): count(account) < plan limit (409 planLimit), count(tenant) <
   * tenant limit (409 envelopeExceeded).
   */
  async assertRoomFor(kind: 'sites' | 'domains', account: { id: number; tenant_id: number; plan_id: number }, conn: Conn = db): Promise<void> {
    const table = kind;
    const dim = kind === 'sites' ? 'maxSites' : 'maxDomains';
    // Sequential: inside a transaction every query shares ONE connection.
    const plan = await conn('plans').where({ id: account.plan_id }).first('limits') as { limits: unknown } | undefined;
    const limits = await loadTenantLimits(account.tenant_id, conn);
    const inAccount = await count(conn(table).where({ account_id: account.id }));
    const inTenant = await count(conn(table).where({ tenant_id: account.tenant_id }));
    const planMax = plan ? planLimits(plan.limits)[dim] : null;
    if (planMax !== null && inAccount >= planMax) {
      throw new AppError(409, `The plan allows at most ${planMax} ${kind} for this account`, 'planLimit', { dimension: dim, limit: planMax });
    }
    const tenantMax = limits[dim];
    if (tenantMax !== null && inTenant >= tenantMax) {
      throw new AppError(409, `The tenant envelope allows at most ${tenantMax} ${kind}`, 'envelopeExceeded',
        [{ dimension: dim, limit: tenantMax, requested: inTenant + 1 } satisfies EnvelopeViolation]);
    }
  },
};

async function count(q: Knex.QueryBuilder): Promise<number> {
  const row = await q.count('* as c').first() as { c?: unknown } | undefined;
  return Number(row?.c ?? 0);
}
