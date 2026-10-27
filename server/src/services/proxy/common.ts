import type { Request } from 'express';
import type { Knex } from 'knex';
import {
  HostingSocketEvents, SITE_CONTAINER_PORT, type CertificateStatus, type PlanLimits, type ProxyBoundDomain, type ProxyTarget,
  type ProxyUpdatedPayload,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { auditService } from '../audit.service';
import { actorCan, type HostingActor } from '../hosting/access';
import { accountDeleting } from '../hosting/accounts.service';
import { emitHosting } from '../hosting/events';
import { isUniqueViolation } from '../hosting/hostingValidation.service';
import { planLimits } from '../hosting/rows';
import { platformSettings } from '../platformSettings';
import { proxyDeps } from './deps';
import { forbiddenCidrs } from './externalTargets';
import { assertExternalHost } from './targets';
import { numberArray, toUsers, type BoundDomainDbRow } from './rows';

type Conn = Knex | Knex.Transaction;

export type BindingKind = 'proxy' | 'redirect' | 'dead';

/** Socket event (ids only; clients refetch through the API). */
export function emitProxy(entity: ProxyUpdatedPayload['entity'], id: number | string, scope: { tenantId: number; accountId: number | null },
  action: ProxyUpdatedPayload['action']): void {
  const payload: ProxyUpdatedPayload = { entity, id, accountId: scope.accountId, action };
  emitHosting(HostingSocketEvents.PROXY_UPDATED, payload as unknown as Record<string, unknown>, scope);
}

/** Audit in the tenant of the object (never a secret in details). */
export async function auditProxy(req: Request, tenantId: number, action: string, resourceType: string, id: number,
  details: Record<string, unknown> = {}): Promise<void> {
  await auditService.logReqAs(req, tenantId, action, { resourceType, resourcePath: String(id), details });
}

export function isPlatformAdmin(actor: HostingActor): boolean {
  return actor.kind === 'staff' && actor.caps === '*';
}

export async function edgeSettings() {
  return platformSettings.section('edge');
}

/**
 * Locks the account row (FOR UPDATE) — every binding / count runs under it,
 * like domains.service assertRouteRoom — and returns its plan limits.
 */
export async function lockAccount(trx: Knex.Transaction, accountId: number): Promise<{ tenantId: number; status: string; limits: PlanLimits }> {
  const locked = await trx('hosting_accounts').where({ id: accountId }).forUpdate().first('id', 'status', 'tenant_id', 'plan_id') as
    { id: number; status: string; tenant_id: number; plan_id: number } | undefined;
  if (!locked) throw new AppError(404, 'Account not found', 'notFound');
  if (locked.status === 'deleting') throw accountDeleting();
  const plan = await trx('plans').where({ id: locked.plan_id }).first('limits') as { limits: unknown } | undefined;
  return { tenantId: Number(locked.tenant_id), status: locked.status, limits: planLimits(plan?.limits ?? {}) };
}

export async function accountLimits(conn: Conn, accountId: number): Promise<PlanLimits> {
  const row = await conn('hosting_accounts as a').join('plans as p', 'p.id', 'a.plan_id').where('a.id', accountId).first('p.limits') as
    { limits: unknown } | undefined;
  return planLimits(row?.limits ?? {});
}

/** 409 planLimit (details.dimension proxyHosts | redirections) when the account is full. */
export async function assertPlanRoom(trx: Knex.Transaction, accountId: number, limits: PlanLimits, dimension: 'proxyHosts' | 'redirections'): Promise<void> {
  const limit = dimension === 'proxyHosts' ? limits.maxProxyHosts : limits.maxRedirections;
  if (limit === null || limit === undefined) return;
  const count = async (table: string) => Number(((await trx(table).where({ account_id: accountId }).count('* as c').first()) as { c: unknown }).c);
  const used = dimension === 'proxyHosts' ? await count('proxy_hosts') : (await count('proxy_redirections')) + (await count('proxy_dead_hosts'));
  if (used >= limit) {
    throw new AppError(409, `The plan allows at most ${limit} ${dimension === 'proxyHosts' ? 'proxy hosts' : 'redirections / dead hosts'}`,
      'planLimit', { dimension, limit });
  }
}

// ── domain bindings (docs §8.1, PX1) ────────────────────────────────────────

function domainInUse(servedBy: string): AppError {
  return new AppError(409, 'This domain is already served (site routes, proxy host, redirection or dead host)', 'domainInUse', { servedBy });
}

/**
 * Binds `domainIds` to (kind, refId), unbinding the domains of `previous`
 * no longer listed (served_by back to 'sites'). Under the account row lock
 * (caller). Domains: same account (404 domainNotInAccount), VERIFIED (409
 * domainNotVerified), no site route, no other consumer (409 domainInUse).
 * Binding a domain takes it from the sites of the account: an ADDED domain
 * needs domains.manage too (403 domainsManageRequired, L1); proxy.manage
 * alone only keeps or releases the domains already bound.
 */
export async function bindDomains(
  trx: Knex.Transaction, actor: HostingActor, accountId: number, kind: BindingKind, refId: number, domainIds: number[],
): Promise<void> {
  const wanted = [...new Set(domainIds)];
  const current = await trx('edge_domain_bindings').where({ kind, ref_id: refId }).pluck('domain_id') as number[];
  const added = wanted.filter((id) => !current.map(Number).includes(id));
  const removed = current.map(Number).filter((id) => !wanted.includes(id));
  if (added.length) {
    const rows = await trx('domains').whereIn('id', added).forUpdate().select('id', 'tenant_id', 'account_id', 'verification_status', 'served_by') as
      Array<{ id: number; tenant_id: number; account_id: number; verification_status: string; served_by: string }>;
    for (const id of added) {
      const d = rows.find((r) => Number(r.id) === id);
      if (!d || Number(d.account_id) !== accountId) throw new AppError(404, 'Domain not found in this account', 'domainNotInAccount', { domainId: id });
      if (!actorCan(actor, 'domains.manage', { tenantId: Number(d.tenant_id), accountId })) {
        throw new AppError(403, 'Binding a domain needs the right to manage the domains', 'domainsManageRequired', { domainId: id });
      }
      if (d.verification_status !== 'verified') throw new AppError(409, 'The ownership of this domain is not verified', 'domainNotVerified', { domainId: id });
      if (d.served_by !== 'sites') throw domainInUse(d.served_by);
    }
    const routed = await trx('site_routes').whereIn('domain_id', added).first('domain_id') as { domain_id: number } | undefined;
    if (routed) throw domainInUse('sites');
  }
  if (removed.length) {
    await trx('edge_domain_bindings').where({ kind, ref_id: refId }).whereIn('domain_id', removed).del();
    await trx('domains').whereIn('id', removed).update({ served_by: 'sites', updated_at: trx.fn.now() });
  }
  if (added.length) {
    try {
      await trx('edge_domain_bindings').insert(added.map((domain_id) => ({ domain_id, account_id: accountId, kind, ref_id: refId })));
    } catch (err) {
      if (isUniqueViolation(err)) throw domainInUse(kind);
      throw err;
    }
    await trx('domains').whereIn('id', added).update({ served_by: kind, updated_at: trx.fn.now() });
  }
}

/** Removes every binding of (kind, refId) (served_by back to 'sites'). */
export async function unbindAll(trx: Knex.Transaction, kind: BindingKind, refId: number): Promise<number[]> {
  const ids = (await trx('edge_domain_bindings').where({ kind, ref_id: refId }).pluck('domain_id') as number[]).map(Number);
  if (ids.length) {
    await trx('edge_domain_bindings').where({ kind, ref_id: refId }).del();
    await trx('domains').whereIn('id', ids).update({ served_by: 'sites', updated_at: trx.fn.now() });
  }
  return ids;
}

/** Bound domains of several objects of one kind, with their certificate summary. */
export async function boundDomains(conn: Conn, kind: BindingKind, refIds: number[]): Promise<Map<number, ProxyBoundDomain[]>> {
  const out = new Map<number, ProxyBoundDomain[]>();
  if (!refIds.length) return out;
  const rows = await conn('edge_domain_bindings as b').join('domains as d', 'd.id', 'b.domain_id')
    .where('b.kind', kind).whereIn('b.ref_id', refIds)
    .select('b.domain_id', 'b.kind', 'b.ref_id', 'd.name', 'd.include_www', 'd.wildcard', 'd.tls_mode', 'd.verification_status', 'd.account_id',
      'd.tenant_id')
    .orderBy('d.name') as BoundDomainDbRow[];
  const certs = rows.length
    ? await conn('certificates').whereIn('domain_id', rows.map((r) => r.domain_id)).select('domain_id', 'status', 'not_after') as
      Array<{ domain_id: number; status: CertificateStatus; not_after: Date | string | null }>
    : [];
  for (const r of rows) {
    const c = certs.find((x) => Number(x.domain_id) === Number(r.domain_id));
    const list = out.get(Number(r.ref_id)) ?? [];
    list.push({
      domainId: Number(r.domain_id),
      name: r.name,
      includeWww: !!r.include_www,
      wildcard: !!r.wildcard,
      verified: r.verification_status === 'verified',
      certificate: c ? { status: c.status, notAfter: c.not_after ? new Date(c.not_after).toISOString() : null } : null,
    });
    out.set(Number(r.ref_id), list);
  }
  return out;
}

// ── targets (docs §8.8, PX2) ────────────────────────────────────────────────

const SERVICE_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export interface TargetContext {
  actor: HostingActor;
  /** null = platform object (streams). */
  accountId: number | null;
  tenantId: number;
  limits: PlanLimits | null;
  protocol: 'tcp' | 'udp' | 'http';
  /**
   * Previously stored target: an unchanged target keeps its staff-only allowPrivate through a client edit and
   * is not resolved again (the edge re-validates it at every pass) — the plan ∧ tenant policy IS re-checked.
   */
  previous?: ProxyTarget | null;
}

function sameTarget(a: ProxyTarget | null | undefined, b: ProxyTarget): boolean {
  if (!a) return false;
  const k = (t: ProxyTarget) => JSON.stringify([t.kind, t.stackId ?? null, t.service ?? null, t.siteId ?? null, t.host ?? null, t.port, t.scheme,
    !!t.allowPrivate]);
  return k(a) === k(b);
}

/** Validates + normalizes a target for its account (PX2). Throws 400 / 403 / 404 (never accepts another account's id). */
export async function normalizeTarget(input: ProxyTarget, ctx: TargetContext): Promise<ProxyTarget> {
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError(400, 'Invalid target port', 'targetInvalid');
  const scheme = input.scheme === 'https' ? 'https' : 'http';
  if (input.kind === 'app') {
    const stackId = Number(input.stackId);
    const service = String(input.service ?? '');
    if (!Number.isInteger(stackId) || stackId <= 0 || !SERVICE_RE.test(service)) throw new AppError(400, 'Invalid app target', 'targetInvalid');
    if (ctx.accountId === null) throw new AppError(400, 'A platform stream targets an external address only', 'targetInvalid');
    const info = await proxyDeps().targetInfo(stackId, service);
    if (!info || Number(info.accountId) !== ctx.accountId) throw new AppError(404, 'Application not found', 'notFound');
    const proto = ctx.protocol === 'udp' ? 'udp' : 'tcp';
    if (!info.exposedPorts.some((p) => p.port === port && p.protocol === proto)) {
      throw new AppError(400, 'This port is not exposed by the service', 'targetPortNotExposed', { exposed: info.exposedPorts });
    }
    return { kind: 'app', stackId, service, siteId: null, host: null, port, scheme, allowPrivate: false };
  }
  if (input.kind === 'site') {
    const siteId = Number(input.siteId);
    if (!Number.isInteger(siteId) || siteId <= 0) throw new AppError(400, 'Invalid site target', 'targetInvalid');
    if (ctx.accountId === null || ctx.protocol !== 'http') throw new AppError(400, 'A site is only a proxy host target', 'targetInvalid');
    const site = await db('sites').where({ id: siteId, account_id: ctx.accountId }).first('id');
    if (!site) throw new AppError(404, 'Site not found', 'notFound');
    return { kind: 'site', stackId: null, service: null, siteId, host: null, port: SITE_CONTAINER_PORT, scheme: 'http', allowPrivate: false };
  }
  if (input.kind !== 'external') throw new AppError(400, 'Invalid target kind', 'targetInvalid');
  const allowPrivate = !!input.allowPrivate;
  const candidate: ProxyTarget = { kind: 'external', stackId: null, service: null, siteId: null, host: String(input.host ?? '').trim().toLowerCase(), port, scheme, allowPrivate };
  const unchanged = sameTarget(ctx.previous, candidate);
  if (allowPrivate && !unchanged && !isPlatformAdmin(ctx.actor)) {
    throw new AppError(403, 'Only the platform staff may allow a private target', 'targetNotAllowed', { reason: 'allowPrivate' });
  }
  if (ctx.accountId !== null) {
    // PX2: plan ∧ tenant policy, ALWAYS (a downgrade / policy change also blocks the edit of an existing external target).
    let allowed = !!ctx.limits?.proxyExternalTargets;
    if (allowed) allowed = await proxyDeps().allowExternalTargets(ctx.tenantId);
    if (!allowed) throw new AppError(403, 'External targets are not allowed for this account', 'targetNotAllowed', { reason: 'policy' });
  } else if (!unchanged && !isPlatformAdmin(ctx.actor)) {
    throw new AppError(403, 'Insufficient permissions', 'targetNotAllowed', { reason: 'platform' });
  }
  if (unchanged) return candidate;
  const forbidden = forbiddenCidrs(await proxyDeps().dockerSubnets(), await proxyDeps().nodeAddresses());
  const host = await assertExternalHost(candidate.host ?? '', { allowPrivate, forbiddenCidrs: forbidden }, proxyDeps().lookup);
  return { ...candidate, host };
}

/** Readable target label. */
export function targetLabel(t: ProxyTarget, names: { stack?: string | null; site?: string | null } = {}): string {
  if (t.kind === 'app') return `${names.stack ?? `#${t.stackId}`}/${t.service}:${t.port}`;
  if (t.kind === 'site') return names.site ?? `site #${t.siteId}`;
  const h = t.host ?? '';
  return `${t.scheme}://${h.includes(':') ? `[${h}]` : h}:${t.port}`;
}

// ── forward-auth × basic auth (docs §8.8) ───────────────────────────────────

/** 400 forwardAuthWithUsers: the server-level `error_page 401` of forward-auth would loop on the basic-auth challenge. */
export function forwardAuthWithUsers(details: Record<string, unknown> = {}): AppError {
  return new AppError(400, 'Forward-auth cannot be combined with access lists that have users (basic auth)', 'forwardAuthWithUsers', details);
}

/** Ids among `ids` of the access lists that hold basic-auth users. */
export async function listsWithUsers(conn: Conn, ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  const rows = await conn('access_lists').whereIn('id', ids).select('id', 'users') as Array<{ id: number; users: unknown }>;
  return rows.filter((r) => toUsers(r.users).length > 0).map((r) => Number(r.id));
}

/**
 * A host with forward-auth: neither its own lists nor the override lists of a
 * route still under forward-auth (authMode inherit) may hold users. Throws 400
 * forwardAuthWithUsers.
 */
export async function assertForwardAuthCompatible(conn: Conn, s: {
  authProviderId: number | null;
  accessListIds: number[];
  routes: Array<{ path: string; authMode: string; accessListMode: string; accessListIds: number[] }>;
}): Promise<void> {
  if (s.authProviderId === null) return;
  const host = await listsWithUsers(conn, s.accessListIds);
  if (host.length) throw forwardAuthWithUsers({ accessListIds: host });
  for (const r of s.routes) {
    if (r.authMode === 'none' || r.accessListMode !== 'override') continue;
    const bad = await listsWithUsers(conn, r.accessListIds);
    if (bad.length) throw forwardAuthWithUsers({ path: r.path, accessListIds: bad });
  }
}

/**
 * An access list that gets users must not protect a forward-auth host (its
 * own lists, or a route override under forward-auth). Throws 409
 * forwardAuthWithUsers.
 */
export async function assertListUsersAllowed(conn: Conn, listId: number): Promise<void> {
  const viaHost = await conn('proxy_host_access_lists as l').join('proxy_hosts as h', 'h.id', 'l.proxy_host_id')
    .where('l.access_list_id', listId).whereNotNull('h.auth_provider_id').first('h.id') as { id: number } | undefined;
  const routes = viaHost ? [] : await conn('proxy_routes as r').join('proxy_hosts as h', 'h.id', 'r.proxy_host_id')
    .where('r.access_list_mode', 'override').whereNot('r.auth_mode', 'none').whereNotNull('h.auth_provider_id')
    .select('r.access_list_ids', 'h.id') as Array<{ access_list_ids: unknown; id: number }>;
  const viaRoute = routes.find((r) => numberArray(r.access_list_ids).includes(listId));
  const hostId = viaHost?.id ?? viaRoute?.id;
  if (hostId !== undefined) {
    throw new AppError(409, 'This access list protects a proxy host with forward-auth: it cannot hold users (basic auth)', 'forwardAuthWithUsers',
      { proxyHostId: Number(hostId) });
  }
}

/**
 * Inside the account-locked transaction of a host save: the referenced
 * provider / imported certificate / access lists still exist in the account
 * (FOR SHARE: a concurrent delete waits, then sees the reference — never an
 * ON DELETE SET NULL that would silently drop forward-auth or TLS). 404.
 */
export async function assertHostReferencesLocked(trx: Knex.Transaction, accountId: number, refs: {
  authProviderId: number | null; importedCertificateId: number | null; accessListIds: number[];
}): Promise<void> {
  const check = async (table: string, ids: number[], what: string) => {
    if (!ids.length) return;
    const found = new Set((await trx(table).whereIn('id', ids).where({ account_id: accountId }).forShare().pluck('id') as number[]).map(Number));
    for (const id of ids) if (!found.has(id)) throw new AppError(404, `${what} not found`, 'notFound', { id });
  };
  await check('auth_providers', refs.authProviderId !== null ? [refs.authProviderId] : [], 'Auth provider');
  await check('imported_certificates', refs.importedCertificateId !== null ? [refs.importedCertificateId] : [], 'Certificate');
  await check('access_lists', refs.accessListIds, 'Access list');
}
