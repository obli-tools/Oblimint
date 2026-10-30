import type { Request } from 'express';
import { MASTER_TENANT_ID, type RestrictableActionKey } from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';
import { db } from '../../db';
import { loadAccount, loadDomain, loadSite, resolveActor, type HostingNeed } from '../hosting/access';
import type { AccountRow, DomainRow, SiteRow } from '../hosting/rows';
import type { ApiKeyContext } from '../apiKeys/apiKeys.service';
import { gateAction, runGated, type GateResult, type GateSpec } from './gate';
import type { RestrictionTarget } from './restriction.service';

// ─────────────────────────────────────────────────────────────────────────────
// Gate points (spec §2, §3.1): the target of an action is always the REAL
// object, loaded with the right the route needs (404 invisible / 403 no right
// come first, never a 2FA prompt for something the user may not do), then
// gateAction, then the handler — which reloads and re-checks by its own code.
// ─────────────────────────────────────────────────────────────────────────────

/** Rest of a gate spec (describe, secrets, approval id). */
export type GateExtra = Omit<GateSpec, 'action' | 'target' | 'params'>;

export const siteTarget = (s: Pick<SiteRow, 'tenant_id' | 'account_id' | 'id'>): RestrictionTarget => ({
  tenantId: Number(s.tenant_id), accountId: Number(s.account_id), siteId: Number(s.id),
});

export const accountTarget = (a: Pick<AccountRow, 'tenant_id' | 'id'>): RestrictionTarget => ({
  tenantId: Number(a.tenant_id), accountId: Number(a.id), siteId: null,
});

/** A tenant-level action (users, matrix): the request's tenant. */
export function tenantTarget(req: Request): RestrictionTarget {
  const tenantId = Number(req.tenantId);
  if (!Number.isInteger(tenantId) || tenantId <= 0) throw new AppError(400, 'No current tenant', 'validation');
  return { tenantId, accountId: null, siteId: null };
}

/** A platform action: the master tenant's map (restriction.service reads it whatever the target). */
export const platformTarget = (): RestrictionTarget => ({ tenantId: MASTER_TENANT_ID, accountId: null, siteId: null });

/** Panel: loads the site with `need`, gates `action` on it, returns the row. */
export async function gateSite(
  req: Request, action: RestrictableActionKey, siteId: number, need: HostingNeed, params: Record<string, unknown> = {}, extra: GateExtra = {},
): Promise<SiteRow> {
  const site = await loadSite(await resolveActor(req), siteId, need);
  await gateAction(req, { action, target: siteTarget(site), params, ...extra });
  return site;
}

/** Panel: loads the account with `need`, gates `action` on it, returns the row. */
export async function gateAccount(
  req: Request, action: RestrictableActionKey, accountId: number, need: HostingNeed, params: Record<string, unknown> = {}, extra: GateExtra = {},
): Promise<AccountRow> {
  const account = await loadAccount(await resolveActor(req), accountId, need);
  await gateAction(req, { action, target: accountTarget(account), params, ...extra });
  return account;
}

/** Panel: loads the domain with `need`, gates `action` on its account and the sites it serves, returns the row. */
export async function gateDomain(
  req: Request, action: RestrictableActionKey, domainId: number, need: HostingNeed, params: Record<string, unknown> = {}, extra: GateExtra = {},
): Promise<DomainRow> {
  const domain = await loadDomain(await resolveActor(req), domainId, need);
  const siteIds = (await db('site_routes').where({ domain_id: domain.id }).pluck('site_id') as number[]).map(Number);
  await gateAction(req, {
    action, target: { tenantId: Number(domain.tenant_id), accountId: Number(domain.account_id), siteId: null, siteIds: [...new Set(siteIds)] },
    params: { domain: domain.name, ...params }, ...extra,
  });
  return domain;
}

/** Panel: a tenant-level action of the request's tenant. */
export function gateTenant(req: Request, action: RestrictableActionKey, params: Record<string, unknown> = {}, extra: GateExtra = {}): Promise<GateResult> {
  return gateAction(req, { action, target: tenantTarget(req), params, ...extra });
}

/** Panel: a platform action (master map, approved by another platform admin). */
export function gatePlatform(req: Request, action: RestrictableActionKey, params: Record<string, unknown> = {}, extra: GateExtra = {}): Promise<GateResult> {
  return gateAction(req, { action, target: platformTarget(), params, ...extra });
}

/**
 * The request as the access key `ctx` (the key surfaces' functions are shared
 * by REST v1 and MCP, and called by tests with a bare request): the gate always
 * sees the key — its principal, its 428, its `via: keys` entries.
 */
export function asKeyRequest(req: Request, ctx: ApiKeyContext): Request {
  if (req.apiKey === ctx) return req;
  const r = Object.create(req) as Request;
  r.apiKey = ctx;
  return r;
}

/** Key surfaces: gate (the strictest of `spec` when several), run, keep an execution error on the consumed request. */
export function keyGated<T>(ctx: ApiKeyContext, req: Request, spec: GateSpec | GateSpec[], fn: () => Promise<T>): Promise<T> {
  return runGated(asKeyRequest(req, ctx), spec, fn);
}
