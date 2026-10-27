import type { Knex } from 'knex';
import type { PlanLimits } from '@oblimint/shared';
import { MASTER_TENANT_ID } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { assertOwnedAccess, scopeOwned, type OwnedRow } from '../hosting/p4bAccess';
import { loadAccount, type HostingActor, type HostingNeed } from '../hosting/access';
import { planLimits } from '../hosting/rows';

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers of the monitoring-automation module (docs/P4b-PLAN.md §12):
// owner of a new row (account with the need, or a platform row of the
// staff's tenant), list scoping, plan limits under the account lock.
// ─────────────────────────────────────────────────────────────────────────────

export function notFound(what: string): AppError {
  return new AppError(404, `${what} not found`, 'notFound');
}

export type MonitoringLimitDimension = 'uptimeMonitors' | 'workflows';

export function planLimitError(dimension: MonitoringLimitDimension, limit: number | null, message: string): AppError {
  return new AppError(409, message, 'planLimit', { dimension, limit });
}

export interface RowOwner {
  tenantId: number;
  /** null = platform row (staff of the tenant). */
  accountId: number | null;
}

/**
 * Owner of a row the actor creates: an account on which it holds `need`
 * (404 / 403 otherwise), or — accountId null — a platform row of the staff
 * member's own tenant (clients: 404, as an invisible object).
 */
export async function ownerForCreate(actor: HostingActor, accountId: number | null, need: HostingNeed = 'monitoring.manage'): Promise<RowOwner> {
  if (accountId === null) {
    if (actor.kind !== 'staff') throw notFound('Account');
    assertOwnedAccess(actor, { tenantId: actor.tenantId, accountId: null }, need, 'Account');
    return { tenantId: actor.tenantId, accountId: null };
  }
  const account = await loadAccount(actor, accountId, need);
  return { tenantId: Number(account.tenant_id), accountId: Number(account.id) };
}

export function ownerOf(row: OwnedRow): RowOwner {
  return { tenantId: Number(row.tenant_id), accountId: row.account_id === null ? null : Number(row.account_id) };
}

/** Same owner (tenant + account, platform = null) — every id referenced by a body must pass this (§12, MO4). */
export function sameOwner(a: RowOwner, b: RowOwner): boolean {
  return a.tenantId === b.tenantId && a.accountId === b.accountId;
}

/**
 * Platform row of the MASTER tenant: the only rows that may reach private
 * addresses (with settings.monitoring.allowPrivateTargets). A reseller
 * tenant's platform rows never do: they would probe the panel's own network.
 */
export function mayUsePrivateTargets(owner: RowOwner): boolean {
  return owner.accountId === null && owner.tenantId === MASTER_TENANT_ID;
}

export interface ListFilter {
  accountId?: number;
  tenantId?: number;
}

/** Scopes a list query of a monitoring table (alias `alias`) to the actor; staff see the platform rows too (403 without the read need: scopeOwned). */
export function scopeList<T extends Knex.QueryBuilder>(actor: HostingActor, qb: T, alias: string, filter: ListFilter): T {
  scopeOwned(actor, qb, alias, { filterTenantId: filter.tenantId ?? null, includePlatform: actor.kind === 'staff' });
  if (filter.accountId) qb.where(`${alias}.account_id`, filter.accountId);
  return qb;
}

/** Plan limits of an account (defaults merged). */
export async function accountPlanLimits(accountId: number, conn: Knex | Knex.Transaction = db): Promise<PlanLimits> {
  const row = await conn('hosting_accounts as a').leftJoin('plans as p', 'p.id', 'a.plan_id').where('a.id', accountId)
    .first('p.limits as plan_limits') as { plan_limits: unknown } | undefined;
  if (!row) throw notFound('Account');
  return planLimits(row.plan_limits);
}

/**
 * Inside `trx`: locks the account row (concurrent creations serialize) and
 * throws 409 planLimit when `count` rows already reach the plan's `key`.
 * Platform rows (accountId null) have no plan limit.
 */
export async function assertPlanRoom(
  trx: Knex.Transaction, accountId: number | null, key: 'maxUptimeMonitors' | 'maxWorkflows', table: string, adding = 1,
): Promise<void> {
  if (accountId === null) return;
  await trx('hosting_accounts').where({ id: accountId }).forUpdate().first('id');
  const limits = await accountPlanLimits(accountId, trx);
  const limit = limits[key];
  if (limit === null || limit === undefined) return;
  const row = await trx(table).where({ account_id: accountId }).count<{ count: string }[]>('* as count').first();
  const used = Number(row?.count ?? 0);
  if (used + adding > limit) {
    const dimension: MonitoringLimitDimension = key === 'maxUptimeMonitors' ? 'uptimeMonitors' : 'workflows';
    throw planLimitError(dimension, limit, `The plan allows at most ${limit} ${dimension === 'uptimeMonitors' ? 'uptime monitors' : 'workflows'}`);
  }
}

/**
 * Inside `trx`: serializes the writers of one owner scope — the account row
 * (account rows) or the tenant row (platform rows) is locked FOR UPDATE.
 */
export async function lockOwnerScope(trx: Knex.Transaction, owner: RowOwner): Promise<void> {
  if (owner.accountId !== null) await trx('hosting_accounts').where({ id: owner.accountId }).forUpdate().first('id');
  else await trx('tenants').where({ id: owner.tenantId }).forUpdate().first('id');
}

/** At most this many platform monitors (accountId null) per tenant: platform rows have no plan. */
export const MAX_PLATFORM_MONITORS_PER_TENANT = 200;

/** Master-tenant platform admin (staff '*' with the god view). */
export function isPlatformAdmin(actor: HostingActor): boolean {
  return actor.kind === 'staff' && actor.globalView && actor.caps === '*';
}

export function toIso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function jsonValue<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try { return JSON.parse(v) as T; } catch { return fallback; }
  }
  return v as T;
}
