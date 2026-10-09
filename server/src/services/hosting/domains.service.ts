import type { Request } from 'express';
import type { Knex } from 'knex';
import type { CertificateSummary, Domain, SiteRoute } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import type { DomainCreateBody, DomainUpdateBody, RouteInputBody } from '../../validators/hosting.schema';
import { appConfigService } from '../appConfig.service';
import { auditService } from '../audit.service';
import { reconcileService } from '../docker/reconcile.service';
import { certificateService } from '../edge/certificate.service';
import { certificateSummaryView, viewerOf, type CertificateViewer } from '../edge/certificateMessages';
import { edgeService } from '../edge/edge.service';
import { assertNeedSomewhere, loadAccount, loadDomain, scopeToActor, type HostingActor } from './access';
import { accountDeleting } from './accounts.service';
import { envelopeService, lockTenant } from './envelope.service';
import { emitHosting } from './events';
import {
  MAX_ROUTES_PER_ACCOUNT, MAX_ROUTES_PER_DOMAIN, MAX_SERVED_PREFIXES_PER_RUNTIME, isPlatformReservedDomain, isUniqueViolation, parentDomains,
} from './hostingValidation.service';
import { toCertificateSummary, toDomain, toSiteRoute, type CertificateRow, type DomainRow, type RouteRow } from './rows';
import { selectRoutes } from './sites.service';

// ─────────────────────────────────────────────────────────────────────────────
// Domains of a hosting account + the route table (domain + path prefix →
// site [+ secondary runtime], ARCHITECTURE §3.1 bis). Names are validated and
// normalised (punycode) before they ever reach the edge configuration (H5).
// Every change schedules an edge sync; Let's Encrypt domains get a
// certificate request (module edge, queued).
// ─────────────────────────────────────────────────────────────────────────────

function selectDomains() {
  return db('domains as d')
    .join('hosting_accounts as a', 'a.id', 'd.account_id')
    .select('d.*', 'a.username as account_username');
}

/**
 * Maps domain rows with their routes and certificate summary (two batched
 * queries). viewer 'client': the certificate's raw error text is replaced (A6).
 */
async function mapDomains(rows: DomainRow[], viewer: CertificateViewer): Promise<Domain[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [routes, certs] = await Promise.all([
    selectRoutes().whereIn('sr.domain_id', ids).orderBy([{ column: 'sr.path_prefix' }]) as Promise<RouteRow[]>,
    db('certificates').whereIn('domain_id', ids) as Promise<CertificateRow[]>,
  ]);
  return rows.map((r) => {
    const cert = certs.find((c) => c.domain_id === r.id);
    const summary: CertificateSummary | null = cert ? certificateSummaryView(toCertificateSummary(cert), viewer) : null;
    return toDomain(r, routes.filter((x) => x.domain_id === r.id).map(toSiteRoute), summary);
  });
}

export async function fetchDomain(domainId: number, viewer: CertificateViewer = 'staff'): Promise<Domain> {
  const row = await selectDomains().where('d.id', domainId).first() as DomainRow | undefined;
  if (!row) throw new AppError(404, 'Domain not found', 'notFound');
  return (await mapDomains([row], viewer))[0];
}

async function fetchRoute(routeId: number): Promise<SiteRoute> {
  const row = await selectRoutes().where('sr.id', routeId).first() as RouteRow | undefined;
  if (!row) throw new AppError(404, 'Route not found', 'notFound');
  return toSiteRoute(row);
}

function emitDomain(domain: { id: number; tenant_id: number; account_id: number }, action: 'created' | 'updated' | 'deleted'): void {
  emitHosting(HostingSocketEvents.HOSTING_CHANGED, { entity: 'domain', id: domain.id, accountId: domain.account_id, action },
    { tenantId: domain.tenant_id, accountId: domain.account_id });
}

function scheduleEdgeSync(reason: string): void {
  try { edgeService.scheduleSync(reason); } catch (err) { logger.warn({ err, reason }, 'edgeService.scheduleSync failed'); }
}

/**
 * Routes feed the runtime configs (servedPrefixes of the secondary runtimes):
 * any route change re-reconciles the account so the site containers get it.
 */
function requestReconcile(accountId: number, reason: string): void {
  try { reconcileService.requestAccount(accountId, reason); } catch (err) { logger.warn({ err, accountId, reason }, 'reconcileService.requestAccount failed'); }
}

/** A secondary runtime serves at most MAX_SERVED_PREFIXES_PER_RUNTIME prefixes (images/siteconf maxPrefixes). */
async function assertRuntimePrefixRoom(runtimeId: number | null | undefined, prefix: string, exceptRouteId: number | null): Promise<void> {
  if (!runtimeId) return;
  const q = db('site_routes').where({ runtime_id: runtimeId }).whereNot('path_prefix', prefix);
  if (exceptRouteId) q.whereNot('id', exceptRouteId);
  const rows = await q.distinct('path_prefix') as Array<{ path_prefix: string }>;
  if (rows.length >= MAX_SERVED_PREFIXES_PER_RUNTIME) {
    throw new AppError(409, `A runtime serves at most ${MAX_SERVED_PREFIXES_PER_RUNTIME} path prefixes`, 'runtimePrefixLimit', { max: MAX_SERVED_PREFIXES_PER_RUNTIME });
  }
}

function ensureCertificate(domainId: number, tlsMode: string): void {
  if (tlsMode !== 'letsencrypt') return;
  try { certificateService.ensureForDomain(domainId); } catch (err) { logger.warn({ err, domainId }, 'certificateService.ensureForDomain failed'); }
}

function domainTaken(name: string): AppError {
  return new AppError(409, `The domain ${name} is already in use`, 'domainTaken', { name });
}

async function panelHostname(): Promise<string | null> {
  try { return (await appConfigService.get('panel_hostname'))?.trim() || null; } catch { return null; }
}

/**
 * Host names a domain would serve must not collide with another domain:
 * `name` itself, and `www.<name>` when includeWww; conversely a `www.x`
 * domain collides with `x` serving its www.
 */
async function assertNamesFree(name: string, includeWww: boolean, exceptId: number | null): Promise<void> {
  const others = (q: Knex.QueryBuilder) => (exceptId ? q.whereNot('id', exceptId) : q);
  if (await others(db('domains').where({ name })).first('id')) throw domainTaken(name);
  if (includeWww && await others(db('domains').where({ name: `www.${name}` })).first('id')) throw domainTaken(`www.${name}`);
  if (name.startsWith('www.') && await others(db('domains').where({ name: name.slice(4), include_www: true })).first('id')) {
    throw domainTaken(name);
  }
}

/**
 * Subdomains of a domain belong to the account holding it: a name whose
 * parent domain is held by ANOTHER account is refused (www.<name> has the
 * same foreign parents as <name>) — e.g. shop.victim.com, or www.victim.com when victim.com's
 * owner left includeWww off. Without it any tenant could claim names of
 * another tenant's zone (wildcard / www records already point at the edge)
 * and get a trusted certificate for them. Same answer as an exact clash.
 */
async function assertNoForeignParent(name: string, accountId: number): Promise<void> {
  const parents = parentDomains(name);
  if (parents.length === 0) return;
  const foreign = await db('domains').whereIn('name', parents).whereNot('account_id', accountId).first('name') as { name: string } | undefined;
  if (foreign) throw domainTaken(name);
}

/** Route count limits (each route is a location of the shared edge config). Run under the account row lock. */
async function assertRouteRoom(trx: Knex.Transaction, domain: { id: number; account_id: number }): Promise<void> {
  const perDomain = await trx('site_routes').where({ domain_id: domain.id }).count('* as c').first() as { c: string | number };
  if (Number(perDomain.c) >= MAX_ROUTES_PER_DOMAIN) {
    throw new AppError(409, `A domain has at most ${MAX_ROUTES_PER_DOMAIN} routes`, 'routeLimit', { max: MAX_ROUTES_PER_DOMAIN, scope: 'domain' });
  }
  const perAccount = await trx('site_routes').where({ account_id: domain.account_id }).count('* as c').first() as { c: string | number };
  if (Number(perAccount.c) >= MAX_ROUTES_PER_ACCOUNT) {
    throw new AppError(409, `An account has at most ${MAX_ROUTES_PER_ACCOUNT} routes`, 'routeLimit', { max: MAX_ROUTES_PER_ACCOUNT, scope: 'account' });
  }
}

async function audit(req: Request, domain: { id: number; tenant_id: number; name: string; account_id: number }, action: string, details: Record<string, unknown> = {}): Promise<void> {
  await auditService.logReqAs(req, domain.tenant_id, action, {
    resourceType: 'domain', resourcePath: String(domain.id), details: { name: domain.name, accountId: domain.account_id, ...details },
  });
}

/** Route target checks: the site belongs to the domain's account (else 404), the runtime to the site (else 400). */
async function assertRouteTarget(domain: DomainRow, input: RouteInputBody): Promise<void> {
  const site = await db('sites').where({ id: input.siteId, account_id: domain.account_id }).first('id');
  if (!site) throw new AppError(404, 'Site not found', 'notFound');
  if (input.runtimeId) {
    const rt = await db('site_runtimes').where({ id: input.runtimeId, site_id: input.siteId }).first('id');
    if (!rt) throw new AppError(400, 'This runtime does not belong to the site', 'runtimeMismatch');
  }
}

function routeTaken(prefix: string): AppError {
  return new AppError(409, `A route already exists for ${prefix}`, 'routeTaken', { pathPrefix: prefix });
}

export const domainsService = {
  async list(actor: HostingActor, filters: { accountId?: number | null; search?: string }): Promise<Domain[]> {
    // Staff: 'read' needs a hosting capability or overview.read (§8).
    if (actor.kind === 'staff') assertNeedSomewhere(actor, 'read');
    const q = selectDomains();
    scopeToActor(actor, q, { tenant: 'd.tenant_id', account: 'd.account_id' });
    if (filters.accountId) q.where('d.account_id', filters.accountId);
    const search = filters.search?.trim();
    if (search) {
      const like = `%${search.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`;
      q.where((b) => { b.where('d.name', 'like', like).orWhere('a.username', 'ilike', like); });
    }
    return mapDomains(await q.orderBy('d.name') as DomainRow[], viewerOf(actor));
  },

  async get(actor: HostingActor, domainId: number): Promise<Domain> {
    await loadDomain(actor, domainId, 'read');
    return fetchDomain(domainId, viewerOf(actor));
  },

  async create(req: Request, actor: HostingActor, body: DomainCreateBody): Promise<Domain> {
    const account = await loadAccount(actor, body.accountId, 'domains.manage');
    if (account.status === 'deleting') throw accountDeleting();
    const name = body.name;
    const platformAdmin = actor.kind === 'staff' && actor.caps === '*';
    if (isPlatformReservedDomain(name, await panelHostname(), { platformAdmin })) {
      throw new AppError(400, 'This name belongs to the panel', 'domainReserved');
    }
    const includeWww = body.includeWww ?? false;
    await assertNamesFree(name, includeWww, null);
    await assertNoForeignParent(name, account.id);
    await envelopeService.assertRoomFor('domains', account); // early answer, re-checked under the lock
    if (body.siteId) {
      const site = await db('sites').where({ id: body.siteId, account_id: account.id }).first('id');
      if (!site) throw new AppError(404, 'Site not found', 'notFound');
    }
    const tlsMode = body.tlsMode ?? 'letsencrypt';
    let domainId: number;
    try {
      domainId = await db.transaction(async (trx) => {
        // Limits re-checked under the tenant lock (concurrent creations cannot
        // both pass maxDomains); an account deletion started meanwhile is seen.
        await lockTenant(trx, account.tenant_id);
        const current = await trx('hosting_accounts').where({ id: account.id }).first('status', 'plan_id') as
          { status: string; plan_id: number } | undefined;
        if (!current || current.status === 'deleting') throw accountDeleting();
        await envelopeService.assertRoomFor('domains', { id: account.id, tenant_id: account.tenant_id, plan_id: current.plan_id }, trx);
        const [row] = await trx('domains').insert({
          tenant_id: account.tenant_id,
          account_id: account.id,
          name,
          kind: body.kind ?? 'addon',
          include_www: includeWww,
          tls_mode: tlsMode,
          force_https: body.forceHttps ?? true,
        }).returning('id') as Array<{ id: number }>;
        if (body.siteId) {
          await trx('site_routes').insert({ account_id: account.id, domain_id: row.id, path_prefix: '/', site_id: body.siteId, runtime_id: null });
        }
        return row.id;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw domainTaken(name);
      throw err;
    }
    const domain = { id: domainId, tenant_id: account.tenant_id, account_id: account.id, name };
    await audit(req, domain, 'domain.create', { kind: body.kind ?? 'addon', includeWww, tlsMode, siteId: body.siteId ?? null });
    emitDomain(domain, 'created');
    scheduleEdgeSync(`domain ${domainId} created`);
    ensureCertificate(domainId, tlsMode);
    return fetchDomain(domainId, viewerOf(actor));
  },

  async update(req: Request, actor: HostingActor, domainId: number, body: DomainUpdateBody): Promise<Domain> {
    const row = await loadDomain(actor, domainId, 'domains.manage');
    const patch: Record<string, unknown> = {};
    if (body.kind !== undefined && body.kind !== row.kind) patch.kind = body.kind;
    if (body.includeWww !== undefined && body.includeWww !== row.include_www) {
      if (body.includeWww) {
        await assertNamesFree(row.name, true, row.id);
        const panel = await panelHostname();
        const platformAdmin = actor.kind === 'staff' && actor.caps === '*';
        if (isPlatformReservedDomain(`www.${row.name}`, panel, { platformAdmin })) {
          throw new AppError(400, 'This name belongs to the panel', 'domainReserved');
        }
      }
      patch.include_www = body.includeWww;
    }
    if (body.tlsMode !== undefined && body.tlsMode !== row.tls_mode) patch.tls_mode = body.tlsMode;
    if (body.forceHttps !== undefined && body.forceHttps !== row.force_https) patch.force_https = body.forceHttps;
    if (Object.keys(patch).length > 0) {
      patch.updated_at = db.fn.now();
      await db('domains').where({ id: row.id, tenant_id: row.tenant_id }).update(patch);
      await audit(req, row, 'domain.update', { fields: Object.keys(patch).filter((k) => k !== 'updated_at') });
      emitDomain(row, 'updated');
      scheduleEdgeSync(`domain ${row.id} updated`);
      // New names (www) or TLS turned on: the certificate follows.
      ensureCertificate(row.id, (patch.tls_mode as string | undefined) ?? row.tls_mode);
    }
    return fetchDomain(row.id, viewerOf(actor));
  },

  async remove(req: Request, actor: HostingActor, domainId: number): Promise<void> {
    const row = await loadDomain(actor, domainId, 'domains.manage');
    try { await certificateService.removeForDomain(row.id); } catch (err) { logger.warn({ err, domainId: row.id }, 'certificateService.removeForDomain failed'); }
    await db('domains').where({ id: row.id, tenant_id: row.tenant_id }).del();
    scheduleEdgeSync(`domain ${row.id} deleted`);
    requestReconcile(row.account_id, `domain ${row.id} deleted`);
    await audit(req, row, 'domain.delete');
    emitDomain(row, 'deleted');
  },

  // ── Routes ─────────────────────────────────────────────────────────────────

  async addRoute(req: Request, actor: HostingActor, domainId: number, input: RouteInputBody): Promise<SiteRoute> {
    const domain = await loadDomain(actor, domainId, 'domains.manage');
    await assertRouteTarget(domain, input);
    if (await db('site_routes').where({ domain_id: domain.id, path_prefix: input.pathPrefix }).first('id')) throw routeTaken(input.pathPrefix);
    await assertRuntimePrefixRoom(input.runtimeId, input.pathPrefix, null);
    let routeId: number;
    try {
      routeId = await db.transaction(async (trx) => {
        // Counted under the account row lock: concurrent adds cannot overshoot.
        await trx('hosting_accounts').where({ id: domain.account_id }).forUpdate().first('id');
        await assertRouteRoom(trx, domain);
        const [row] = await trx('site_routes').insert({
          account_id: domain.account_id, domain_id: domain.id, path_prefix: input.pathPrefix, site_id: input.siteId, runtime_id: input.runtimeId ?? null,
        }).returning('id') as Array<{ id: number }>;
        return row.id;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw routeTaken(input.pathPrefix);
      throw err;
    }
    await audit(req, domain, 'route.create', { routeId, pathPrefix: input.pathPrefix, siteId: input.siteId, runtimeId: input.runtimeId ?? null });
    emitDomain(domain, 'updated');
    scheduleEdgeSync(`route ${routeId} created`);
    requestReconcile(domain.account_id, `route ${routeId} created`);
    return fetchRoute(routeId);
  },

  async updateRoute(req: Request, actor: HostingActor, domainId: number, routeId: number, input: RouteInputBody): Promise<SiteRoute> {
    const domain = await loadDomain(actor, domainId, 'domains.manage');
    const route = await db('site_routes').where({ id: routeId, domain_id: domain.id }).first() as RouteRow | undefined;
    if (!route) throw new AppError(404, 'Route not found', 'notFound');
    await assertRouteTarget(domain, input);
    if (await db('site_routes').where({ domain_id: domain.id, path_prefix: input.pathPrefix }).whereNot('id', route.id).first('id')) {
      throw routeTaken(input.pathPrefix);
    }
    await assertRuntimePrefixRoom(input.runtimeId, input.pathPrefix, route.id);
    try {
      await db('site_routes').where({ id: route.id, domain_id: domain.id })
        .update({ path_prefix: input.pathPrefix, site_id: input.siteId, runtime_id: input.runtimeId ?? null });
    } catch (err) {
      if (isUniqueViolation(err)) throw routeTaken(input.pathPrefix);
      throw err;
    }
    await audit(req, domain, 'route.update', {
      routeId: route.id, from: { pathPrefix: route.path_prefix, siteId: route.site_id, runtimeId: route.runtime_id },
      to: { pathPrefix: input.pathPrefix, siteId: input.siteId, runtimeId: input.runtimeId ?? null },
    });
    emitDomain(domain, 'updated');
    scheduleEdgeSync(`route ${route.id} updated`);
    requestReconcile(domain.account_id, `route ${route.id} updated`);
    return fetchRoute(route.id);
  },

  async deleteRoute(req: Request, actor: HostingActor, domainId: number, routeId: number): Promise<void> {
    const domain = await loadDomain(actor, domainId, 'domains.manage');
    const route = await db('site_routes').where({ id: routeId, domain_id: domain.id }).first() as RouteRow | undefined;
    if (!route) throw new AppError(404, 'Route not found', 'notFound');
    await db('site_routes').where({ id: route.id, domain_id: domain.id }).del();
    await audit(req, domain, 'route.delete', { routeId: route.id, pathPrefix: route.path_prefix, siteId: route.site_id });
    emitDomain(domain, 'updated');
    scheduleEdgeSync(`route ${route.id} deleted`);
    requestReconcile(domain.account_id, `route ${route.id} deleted`);
  },
};
