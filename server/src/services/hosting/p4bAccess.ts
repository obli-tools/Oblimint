import type { Knex } from 'knex';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { actorCan, actorSees, scopeToActor, type HostingActor, type HostingNeed } from './access';

// ─────────────────────────────────────────────────────────────────────────────
// Access to the P4b objects (docs/P4b-PLAN.md §12) — ARCHITECT FILE (frozen,
// implemented). Same rules as access.ts (A1–A6): 404 when invisible (never
// 403: no existence oracle), 403 when visible without the need.
//
// Account rows (account_id set): the hosting rules (staff of the tenant with
// the capability / god view; clients: their accounts with the client
// capability). Platform rows (account_id NULL — custom pages, streams,
// monitors, status pages, workflows, SSH keys, SFTP targets, maintenance
// windows, platform bans): STAFF only — read = staff of the row's tenant
// (god view: every tenant); a change needs the staff capability of the need
// (platform admin: everything). A client never sees a platform row through
// these loaders (a module that lets a client USE a platform row — e.g. a
// platform custom page on its proxy host — checks it with assertUsable()).
// ─────────────────────────────────────────────────────────────────────────────

export type P4bTable =
  | 'app_stacks' | 'app_registry_credentials' | 'network_links'
  | 'proxy_hosts' | 'proxy_redirections' | 'proxy_dead_hosts' | 'proxy_streams' | 'access_lists' | 'custom_pages'
  | 'auth_providers' | 'imported_certificates'
  | 'uptime_monitors' | 'status_pages' | 'workflows' | 'automation_ssh_keys' | 'sftp_targets' | 'app_maintenance_windows'
  | 'web_bans';

export interface OwnedRow {
  id: number;
  tenant_id: number;
  account_id: number | null;
  [column: string]: unknown;
}

function notFound(what: string): AppError {
  return new AppError(404, `${what} not found`, 'notFound');
}

function forbidden(): AppError {
  return new AppError(403, 'Insufficient permissions');
}

/** Visibility + need on (tenantId, accountId|null). Throws 404 / 403. */
export function assertOwnedAccess(actor: HostingActor, target: { tenantId: number; accountId: number | null }, need: HostingNeed, what: string): void {
  if (target.accountId !== null) {
    if (!actorSees(actor, { tenantId: target.tenantId, accountId: target.accountId })) throw notFound(what);
    if (!actorCan(actor, need, { tenantId: target.tenantId, accountId: target.accountId })) throw forbidden();
    return;
  }
  // Platform row: staff only.
  if (actor.kind !== 'staff') throw notFound(what);
  if (!actor.globalView && actor.tenantId !== target.tenantId) throw notFound(what);
  if (!actorCan(actor, need, { tenantId: target.tenantId, accountId: null })) throw forbidden();
}

/**
 * One row of `table` visible to the actor with `need` (404 / 403 otherwise).
 * `conn` lets a caller read inside its transaction.
 */
export async function loadOwned<T extends OwnedRow = OwnedRow>(
  actor: HostingActor, table: P4bTable, id: number, need: HostingNeed, what: string, conn: Knex | Knex.Transaction = db,
): Promise<T> {
  if (!Number.isInteger(id) || id <= 0) throw notFound(what);
  const row = await conn(table).where({ id }).first() as T | undefined;
  if (!row) throw notFound(what);
  assertOwnedAccess(actor, { tenantId: Number(row.tenant_id), accountId: row.account_id === null ? null : Number(row.account_id) }, need, what);
  return row;
}

/**
 * A client may USE (reference) a platform row of its tenant without seeing it
 * through the loaders (platform custom pages, platform default maintenance
 * window): 404 unless the row is a platform row of the actor's tenant, or an
 * account row of `accountId`.
 */
export async function assertUsable(actor: HostingActor, table: P4bTable, id: number, accountId: number, what: string): Promise<OwnedRow> {
  if (!Number.isInteger(id) || id <= 0) throw notFound(what);
  const row = await db(table).where({ id }).first() as OwnedRow | undefined;
  if (!row) throw notFound(what);
  const account = await db('hosting_accounts').where({ id: accountId }).first('tenant_id') as { tenant_id: number } | undefined;
  if (!account) throw notFound(what);
  if (row.account_id === null) {
    if (Number(row.tenant_id) !== Number(account.tenant_id) && Number(row.tenant_id) !== 1) throw notFound(what);
    return row;
  }
  if (Number(row.account_id) !== accountId) throw notFound(what);
  if (!actorSees(actor, { tenantId: Number(row.tenant_id), accountId })) throw notFound(what);
  return row;
}

/**
 * Restricts a list query to the rows the actor may READ. `alias` = table
 * alias of the query. Platform rows (account_id NULL) are included for staff
 * when `includePlatform`, never for a client.
 */
export function scopeOwned<T extends Knex.QueryBuilder>(
  actor: HostingActor, qb: T, alias: string, opts: { filterTenantId?: number | null; includePlatform?: boolean } = {},
): T {
  const tenant = `${alias}.tenant_id`;
  const account = `${alias}.account_id`;
  if (actor.kind === 'client') return scopeToActor(actor, qb.whereNotNull(account) as T, { tenant, account });
  if (!actor.globalView) qb.where(tenant, actor.tenantId);
  else if (opts.filterTenantId && Number.isInteger(opts.filterTenantId)) qb.where(tenant, opts.filterTenantId);
  if (!opts.includePlatform) qb.whereNotNull(account);
  return qb;
}
