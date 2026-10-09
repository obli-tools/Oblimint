import type { NextFunction, Request, Response } from 'express';
import type { Knex } from 'knex';
import type { ClientCapability } from '@oblimint/shared';
import { isMasterTenant } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { permissionService } from '../permission.service';
import { clientCapabilities, type AccountRow, type DomainRow, type SiteRow } from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// Hosting access control (docs/P1-PLAN.md §Sécurité, invariants A1–A6).
//
// EVERY P1 route that touches a plan / account / site / domain / release /
// runtime / file server goes through this file:
//   - resolveActor(req)           who is calling (staff or client), cached per request;
//   - scopeToActor(actor, qb, …)  restricts a LIST query to what the actor may read;
//   - loadAccount/loadSite/loadDomain(actor, id, need)
//                                 fetches ONE object: 404 when invisible (never
//                                 403: no existence oracle), 403 when visible but
//                                 the need is not granted.
//
// Staff: platform admin on the master tenant = god view (no tenant filter);
// anyone else is filtered on `tenant_id = req.tenantId` and needs the staff
// capability mapped from the need (permission set of its membership).
// Client (users.kind = 'client'): filtered on tenant_id = req.tenantId AND the
// accounts of account_users; capabilities per account; never 'accounts.manage'
// nor 'plans.manage'.
// ─────────────────────────────────────────────────────────────────────────────

export type HostingNeed =
  | 'read'
  | 'plans.manage'
  | 'accounts.manage'
  | 'sites.manage'
  | 'domains.manage'
  | 'files.manage'
  | 'releases.publish'
  | 'releases.approve';

export type HostingActor =
  | {
      kind: 'staff';
      userId: number;
      tenantId: number;
      /** Platform admin on the master tenant: every tenant is visible. */
      globalView: boolean;
      /** '*' = platform admin (every capability). */
      caps: '*' | ReadonlySet<string>;
    }
  | {
      kind: 'client';
      userId: number;
      tenantId: number;
      /** account id → capabilities (only accounts of req.tenantId). */
      accounts: ReadonlyMap<number, ReadonlySet<ClientCapability>>;
    };

/** Staff capability (permission set) granting each need. */
const STAFF_CAPS: Record<HostingNeed, readonly string[]> = {
  read: ['overview.read', 'accounts.manage', 'sites.manage', 'domains.manage', 'files.manage', 'plans.manage'],
  'plans.manage': ['plans.manage'],
  'accounts.manage': ['accounts.manage'],
  'sites.manage': ['sites.manage'],
  'domains.manage': ['domains.manage'],
  'files.manage': ['files.manage'],
  'releases.publish': ['sites.manage'],
  'releases.approve': ['sites.manage'],
};

/** Client capability granting each need (null = never for a client). */
const CLIENT_CAP: Record<HostingNeed, ClientCapability | 'member' | null> = {
  read: 'member',
  'plans.manage': null,
  'accounts.manage': null,
  'sites.manage': 'sites.manage',
  'domains.manage': 'domains.manage',
  'files.manage': 'files.manage',
  'releases.publish': 'releases.publish',
  'releases.approve': 'releases.approve',
};

const actorCache = new WeakMap<Request, Promise<HostingActor>>();

/** Who is calling. Must run after requireAuth + requireTenant (req.tenantId set). Cached per request. */
export function resolveActor(req: Request): Promise<HostingActor> {
  let p = actorCache.get(req);
  if (!p) {
    p = buildActor(req);
    actorCache.set(req, p);
  }
  return p;
}

async function buildActor(req: Request): Promise<HostingActor> {
  const userId = Number(req.session?.userId);
  const tenantId = Number(req.tenantId);
  if (!Number.isInteger(userId) || userId <= 0) throw new AppError(401, 'Authentication required');
  if (!Number.isInteger(tenantId) || tenantId <= 0) throw new AppError(400, 'No tenant selected');
  const user = await db('users').where({ id: userId }).first('kind', 'role', 'is_active') as
    { kind: string; role: string; is_active: boolean } | undefined;
  if (!user || !user.is_active) throw new AppError(401, 'Authentication required');

  if (user.kind === 'client') {
    const rows = await db('account_users as au')
      .join('hosting_accounts as a', 'a.id', 'au.account_id')
      .where('au.user_id', userId)
      .andWhere('a.tenant_id', tenantId)
      .select('au.account_id', 'au.capabilities') as Array<{ account_id: number; capabilities: unknown }>;
    const accounts = new Map<number, ReadonlySet<ClientCapability>>();
    for (const r of rows) accounts.set(Number(r.account_id), new Set(clientCapabilities(r.capabilities)));
    return { kind: 'client', userId, tenantId, accounts };
  }

  if (user.role === 'admin') {
    return { kind: 'staff', userId, tenantId, globalView: isMasterTenant(tenantId), caps: '*' };
  }
  const caps = new Set(await permissionService.listUserTenantCapabilities(userId, tenantId));
  return { kind: 'staff', userId, tenantId, globalView: false, caps };
}

/** Does the actor hold `need` on an object of (tenantId, accountId)? Visibility included. */
export function actorCan(actor: HostingActor, need: HostingNeed, target: { tenantId: number; accountId: number | null }): boolean {
  if (actor.kind === 'staff') {
    if (!actor.globalView && target.tenantId !== actor.tenantId) return false;
    if (actor.caps === '*') return true;
    const caps = actor.caps;
    return STAFF_CAPS[need].some((c) => caps.has(c));
  }
  if (target.tenantId !== actor.tenantId || target.accountId === null) return false;
  const caps = actor.accounts.get(target.accountId);
  if (!caps) return false;
  const required = CLIENT_CAP[need];
  if (required === null) return false;
  return required === 'member' || caps.has(required);
}

/** Visible at all (read)? */
export function actorSees(actor: HostingActor, target: { tenantId: number; accountId: number | null }): boolean {
  if (actor.kind === 'staff') return actor.globalView || target.tenantId === actor.tenantId;
  return target.tenantId === actor.tenantId && target.accountId !== null && actor.accounts.has(target.accountId);
}

/** Tenant-level need (lists, creation): staff capability, or for a client any account granting it. */
export function actorHasNeedSomewhere(actor: HostingActor, need: HostingNeed): boolean {
  if (actor.kind === 'staff') {
    if (actor.caps === '*') return true;
    const caps = actor.caps;
    return STAFF_CAPS[need].some((c) => caps.has(c));
  }
  const required = CLIENT_CAP[need];
  if (required === null) return false;
  for (const caps of actor.accounts.values()) if (required === 'member' || caps.has(required)) return true;
  return false;
}

/** Throws 403 unless actorHasNeedSomewhere. */
export function assertNeedSomewhere(actor: HostingActor, need: HostingNeed): void {
  if (!actorHasNeedSomewhere(actor, need)) throw new AppError(403, 'Insufficient permissions');
}

/** Throws 403 for client users (account creation, plans, infra…). */
export function assertStaff(actor: HostingActor): asserts actor is Extract<HostingActor, { kind: 'staff' }> {
  if (actor.kind !== 'staff') throw new AppError(403, 'Insufficient permissions');
}

/**
 * Restricts a list query to what the actor may READ. `cols` names the
 * tenant and account columns of the query (e.g. { tenant: 's.tenant_id',
 * account: 's.account_id' }; for hosting_accounts itself account = 'a.id').
 * `filterTenantId`: god view only — narrow to one tenant (?tenantId=).
 */
export function scopeToActor<T extends Knex.QueryBuilder>(
  actor: HostingActor,
  qb: T,
  cols: { tenant: string; account: string },
  filterTenantId?: number | null,
): T {
  if (actor.kind === 'staff') {
    if (!actor.globalView) qb.where(cols.tenant, actor.tenantId);
    else if (filterTenantId && Number.isInteger(filterTenantId)) qb.where(cols.tenant, filterTenantId);
    return qb;
  }
  const ids = [...actor.accounts.keys()];
  qb.where(cols.tenant, actor.tenantId);
  if (ids.length === 0) qb.whereRaw('false');
  else qb.whereIn(cols.account, ids);
  return qb;
}

function notFound(what: string): AppError {
  return new AppError(404, `${what} not found`, 'notFound');
}

function forbidden(): AppError {
  return new AppError(403, 'Insufficient permissions');
}

/** One hosting account visible to the actor, with `need` granted. 404 / 403 otherwise. */
export async function loadAccount(actor: HostingActor, accountId: number, need: HostingNeed = 'read'): Promise<AccountRow> {
  if (!Number.isInteger(accountId) || accountId <= 0) throw notFound('Account');
  const row = await db('hosting_accounts').where({ id: accountId }).first() as AccountRow | undefined;
  if (!row || !actorSees(actor, { tenantId: row.tenant_id, accountId: row.id })) throw notFound('Account');
  if (!actorCan(actor, need, { tenantId: row.tenant_id, accountId: row.id })) throw forbidden();
  return row;
}

/** One site visible to the actor, with `need` granted (joined: account_username). */
export async function loadSite(actor: HostingActor, siteId: number, need: HostingNeed = 'read'): Promise<SiteRow> {
  if (!Number.isInteger(siteId) || siteId <= 0) throw notFound('Site');
  const row = await db('sites as s')
    .join('hosting_accounts as a', 'a.id', 's.account_id')
    .where('s.id', siteId)
    .first('s.*', 'a.username as account_username') as SiteRow | undefined;
  if (!row || !actorSees(actor, { tenantId: row.tenant_id, accountId: row.account_id })) throw notFound('Site');
  if (!actorCan(actor, need, { tenantId: row.tenant_id, accountId: row.account_id })) throw forbidden();
  return row;
}

/** One domain visible to the actor, with `need` granted (joined: account_username). */
export async function loadDomain(actor: HostingActor, domainId: number, need: HostingNeed = 'read'): Promise<DomainRow> {
  if (!Number.isInteger(domainId) || domainId <= 0) throw notFound('Domain');
  const row = await db('domains as d')
    .join('hosting_accounts as a', 'a.id', 'd.account_id')
    .where('d.id', domainId)
    .first('d.*', 'a.username as account_username') as DomainRow | undefined;
  if (!row || !actorSees(actor, { tenantId: row.tenant_id, accountId: row.account_id })) throw notFound('Domain');
  if (!actorCan(actor, need, { tenantId: row.tenant_id, accountId: row.account_id })) throw forbidden();
  return row;
}

/** Parses a positive integer route param, else 404 (never 400: same answer as an invisible id). */
export function idParam(req: Request, name = 'id'): number {
  const v = Number(req.params[name]);
  if (!Number.isInteger(v) || v <= 0) throw notFound('Resource');
  return v;
}

/** Express guard: resolves the actor and requires `need` somewhere (list / create routes). */
export function requireHostingNeed(need: HostingNeed) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      assertNeedSomewhere(await resolveActor(req), need);
      next();
    } catch (err) { next(err); }
  };
}

/** Express guard: staff only (resolves the actor). */
export async function requireStaffActor(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    assertStaff(await resolveActor(req));
    next();
  } catch (err) { next(err); }
}
