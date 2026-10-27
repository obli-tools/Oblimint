import type { Request } from 'express';
import type { Knex } from 'knex';
import type {
  EdgeUnitState, ProxyHost, ProxyHostAuth, ProxyHostHoneypot, ProxyHostInput, ProxyHostOptions, ProxyHostSsl, ProxyHostUpdate,
  ProxyQuickSetupRequest, ProxyRoute, ProxyRouteInput, ProxyTarget,
} from '@oblimint/shared';
import { DEFAULT_PROXY_HOST_OPTIONS } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { assertNeedSomewhere, loadAccount, type HostingActor } from '../hosting/access';
import { assertUsable, scopeOwned } from '../hosting/p4bAccess';
import { loadProxyHost } from './access';
import {
  assertForwardAuthCompatible, assertHostReferencesLocked, accountLimits, auditProxy, bindDomains, boundDomains, edgeSettings, emitProxy, isPlatformAdmin, lockAccount, assertPlanRoom, normalizeTarget,
  targetLabel, unbindAll,
} from './common';
import { normalizeBaitPath } from '../security/honeypotRender';
import { proxyDeps } from './deps';
import { proxyHostUnitId } from './render/proxyHost';
import { proxyUnitProblem } from './provider';
import {
  isoNow, numberArray, toAuthExtras, toHoneypot, toOptions, toSsl, toTarget, type ProxyHostDbRow, type ProxyRouteDbRow,
} from './rows';
import { isValidRewritePrefix, isValidRoutePath, uniq } from './validation';

// ─────────────────────────────────────────────────────────────────────────────
// Proxy hosts (docs/P4b-PLAN.md §6.3, §8.1, §8.8). Read = member / staff read;
// changes = proxy.manage on the host's account; advancedConfig = platform
// staff (settings edge.allowAdvancedConfig, linted), allowPrivate targets =
// platform staff. Every referenced id (domain, stack, site, list, page,
// provider, certificate) belongs to the host's account. Every change:
// audit, PROXY_UPDATED, edge sync, segmentation policy (targets), auto
// monitor, forward-auth sidecars (providers).
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_DOMAINS_PER_OBJECT = 20;
export const MAX_ROUTES_PER_HOST = 50;
export const MAX_HONEYPOT_PATHS = 100;
export const ADVANCED_CONFIG_MAX_BYTES = 16 * 1024;

export interface ProxyListQuery {
  accountId?: number | null;
  tenantId?: number | null;
  search?: string | null;
}

const CLIENT_EDGE_ERROR = 'The edge refused this configuration (contact support)';

/** A6: a client sees a generic label instead of the nginx / probe output. */
export function edgeStateView(state: EdgeUnitState | undefined | null, actor: HostingActor): EdgeUnitState | null {
  if (!state) return null;
  if (actor.kind === 'staff') return state;
  return {
    ...state,
    error: state.error ? CLIENT_EDGE_ERROR : null,
    upstreams: state.upstreams.map((u) => ({ ...u, error: u.error ? 'unreachable' : null })),
  };
}

/**
 * Edge state of an object + the problem of its unit at the last provider pass
 * (dropped server names, render error, external target refused / no longer
 * allowed — provider.ts renderProblems), so that it is visible on the object
 * (ED1). A client sees the public problems only (else the generic label, A6).
 */
export function edgeView(state: EdgeUnitState | undefined | null, actor: HostingActor,
  unit: { unitId: string; ownerKind: EdgeUnitState['ownerKind']; ownerId: number; accountId: number | null }): EdgeUnitState | null {
  const view = edgeStateView(state, actor);
  const p = proxyUnitProblem(unit.unitId);
  if (!p) return view;
  const message = actor.kind === 'staff' || p.public ? p.message : CLIENT_EDGE_ERROR;
  if (!view) {
    return {
      unitId: unit.unitId, ownerKind: unit.ownerKind, ownerId: unit.ownerId, accountId: unit.accountId, status: 'pending', error: message,
      upstreams: [], desiredHash: null, activeHash: null, checkedAt: null, appliedAt: null,
    };
  }
  return { ...view, error: view.error && view.error !== message ? `${message} — ${view.error}` : message };
}

function selectHosts(conn: Knex | Knex.Transaction = db) {
  return conn('proxy_hosts as h').join('hosting_accounts as a', 'a.id', 'h.account_id').select('h.*', 'a.username as account_username');
}

function toRoute(r: ProxyRouteDbRow): ProxyRoute {
  return {
    id: Number(r.id),
    path: r.path,
    rewritePrefix: r.rewrite_prefix,
    target: toTarget(r.target),
    authMode: r.auth_mode === 'none' ? 'none' : 'inherit',
    accessListMode: r.access_list_mode === 'none' || r.access_list_mode === 'override' ? r.access_list_mode : 'inherit',
    accessListIds: numberArray(r.access_list_ids),
    websocket: r.websocket,
    buffering: r.buffering,
    sortOrder: Number(r.sort_order),
  };
}

async function labelsFor(targets: ProxyTarget[]): Promise<{ stacks: Map<number, string>; sites: Map<number, string> }> {
  const stacks = new Map<number, string>();
  const sites = new Map<number, string>();
  const stackIds = uniq(targets.filter((t) => t.kind === 'app' && t.stackId).map((t) => Number(t.stackId)));
  const siteIds = uniq(targets.filter((t) => t.kind === 'site' && t.siteId).map((t) => Number(t.siteId)));
  for (const id of stackIds) {
    try {
      const s = await proxyDeps().stackSummary(id);
      if (s) stacks.set(id, s.displayName || s.name);
    } catch { /* apps-core unavailable: id label */ }
  }
  if (siteIds.length) {
    for (const s of await db('sites').whereIn('id', siteIds).select('id', 'name') as Array<{ id: number; name: string }>) sites.set(Number(s.id), s.name);
  }
  return { stacks, sites };
}

async function monitorIds(hostIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!hostIds.length) return out;
  try {
    const rows = await db('uptime_monitors').whereIn('proxy_host_id', hostIds).where({ auto: true }).select('id', 'proxy_host_id') as
      Array<{ id: number; proxy_host_id: number }>;
    for (const r of rows) out.set(Number(r.proxy_host_id), Number(r.id));
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'proxy: monitor lookup failed');
  }
  return out;
}

export async function mapHosts(rows: ProxyHostDbRow[], actor: HostingActor): Promise<ProxyHost[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => Number(r.id));
  const [domains, routeRows, aclRows, states, monitors] = await Promise.all([
    boundDomains(db, 'proxy', ids),
    db('proxy_routes').whereIn('proxy_host_id', ids).orderBy([{ column: 'sort_order' }, { column: 'id' }]) as Promise<ProxyRouteDbRow[]>,
    db('proxy_host_access_lists').whereIn('proxy_host_id', ids).select('proxy_host_id', 'access_list_id') as
      Promise<Array<{ proxy_host_id: number; access_list_id: number }>>,
    proxyDeps().unitStates('proxy-host', ids),
    monitorIds(ids),
  ]);
  const routes = routeRows.map((r) => ({ hostId: Number(r.proxy_host_id), route: toRoute(r) }));
  const labels = await labelsFor([...rows.map((r) => toTarget(r.target)), ...routes.map((r) => r.route.target)]);
  return rows.map((r) => {
    const target = toTarget(r.target);
    const extras = toAuthExtras(r.auth);
    const auth: ProxyHostAuth = {
      accessListIds: aclRows.filter((a) => Number(a.proxy_host_id) === Number(r.id)).map((a) => Number(a.access_list_id)).sort((a, b) => a - b),
      authProviderId: r.auth_provider_id === null ? null : Number(r.auth_provider_id),
      allowedGroups: extras.allowedGroups,
      allowedEmails: extras.allowedEmails,
    };
    return {
      id: Number(r.id),
      tenantId: Number(r.tenant_id),
      accountId: Number(r.account_id),
      accountUsername: r.account_username ?? '',
      name: r.name,
      enabled: !!r.enabled,
      domains: domains.get(Number(r.id)) ?? [],
      target,
      targetLabel: targetLabel(target, {
        stack: target.stackId ? labels.stacks.get(Number(target.stackId)) : null, site: target.siteId ? labels.sites.get(Number(target.siteId)) : null,
      }),
      ssl: toSsl(r.ssl, r.imported_certificate_id === null ? null : Number(r.imported_certificate_id)),
      options: toOptions(r.options),
      auth,
      honeypot: toHoneypot(r.honeypot),
      routes: routes.filter((x) => x.hostId === Number(r.id)).map((x) => x.route),
      advancedConfig: actor.kind === 'staff' ? (r.advanced_config ?? null) : null,
      hasAdvancedConfig: !!(r.advanced_config && r.advanced_config.trim()),
      autoMonitor: !!r.auto_monitor,
      monitorId: monitors.get(Number(r.id)) ?? null,
      edge: edgeView(states.get(Number(r.id)), actor, { unitId: proxyHostUnitId(Number(r.id)), ownerKind: 'proxy-host', ownerId: Number(r.id), accountId: Number(r.account_id) }),
      createdAt: isoNow(r.created_at),
      updatedAt: isoNow(r.updated_at),
    };
  });
}

async function fetchHost(id: number, actor: HostingActor): Promise<ProxyHost> {
  const row = await selectHosts().where('h.id', id).first() as ProxyHostDbRow | undefined;
  if (!row) throw new AppError(404, 'Proxy host not found', 'notFound');
  return (await mapHosts([row], actor))[0];
}

// ── body normalization ───────────────────────────────────────────────────────

interface HostState {
  name: string;
  enabled: boolean;
  domainIds: number[];
  target: ProxyTarget;
  ssl: ProxyHostSsl;
  options: ProxyHostOptions;
  auth: ProxyHostAuth;
  honeypot: ProxyHostHoneypot;
  routes: ProxyRouteInput[];
  advancedConfig: string | null;
  autoMonitor: boolean;
}

async function assertSameAccount(table: string, ids: number[], accountId: number, what: string): Promise<void> {
  if (!ids.length) return;
  const found = await db(table).whereIn('id', ids).where({ account_id: accountId }).pluck('id') as number[];
  const set = new Set(found.map(Number));
  for (const id of ids) if (!set.has(id)) throw new AppError(404, `${what} not found`, 'notFound', { id });
}

/**
 * Validates the full desired state of a host (create, or update merged on
 * the stored one). `previous` = stored state (unchanged staff-only values
 * pass a client's edit). Returns the normalized state.
 */
async function normalizeState(actor: HostingActor, account: { id: number; tenant_id: number }, s: HostState, previous: HostState | null): Promise<HostState> {
  const limits = await accountLimits(db, account.id);
  const settings = await edgeSettings();
  if (!s.domainIds.length || s.domainIds.length > MAX_DOMAINS_PER_OBJECT) {
    throw new AppError(400, `Between 1 and ${MAX_DOMAINS_PER_OBJECT} domains`, 'validation');
  }
  const target = await normalizeTarget(s.target, { actor, accountId: account.id, tenantId: account.tenant_id, limits, protocol: 'http', previous: previous?.target });

  // SSL
  const ssl: ProxyHostSsl = { ...s.ssl, importedCertificateId: s.ssl.mode === 'imported' ? s.ssl.importedCertificateId : null };
  if (ssl.mode === 'imported') {
    if (!ssl.importedCertificateId) throw new AppError(400, 'Choose the imported certificate', 'validation');
    await assertSameAccount('imported_certificates', [ssl.importedCertificateId], account.id, 'Certificate');
  }

  // Options
  const options: ProxyHostOptions = { ...s.options, corsOrigins: uniq(s.options.corsOrigins ?? []) };
  if (options.bodySizeMb !== null && options.bodySizeMb > settings.maxBodySizeMb) {
    throw new AppError(400, `The body size is limited to ${settings.maxBodySizeMb} MiB`, 'validation', { max: settings.maxBodySizeMb });
  }
  for (const pageId of [options.errorPageId, options.wakingPageId]) {
    if (pageId !== null && pageId !== previousPage(previous, pageId)) await assertUsable(actor, 'custom_pages', pageId, account.id, 'Custom page');
  }

  // Auth
  const accessListIds = uniq(s.auth.accessListIds.map(Number));
  await assertSameAccount('access_lists', accessListIds, account.id, 'Access list');
  if (s.auth.authProviderId !== null) await assertSameAccount('auth_providers', [s.auth.authProviderId], account.id, 'Auth provider');
  const auth: ProxyHostAuth = { ...s.auth, accessListIds, allowedGroups: uniq(s.auth.allowedGroups), allowedEmails: uniq(s.auth.allowedEmails.map((e) => e.toLowerCase())) };

  // Honeypot
  const honeypot: ProxyHostHoneypot = { ...s.honeypot, paths: uniq(s.honeypot.paths) };
  if (honeypot.paths.length > MAX_HONEYPOT_PATHS) throw new AppError(400, `At most ${MAX_HONEYPOT_PATHS} bait paths`, 'validation');
  // Same rule as the renderer (honeypot-bans): refused here instead of silently dropped at render time.
  const badBait = honeypot.paths.find((p) => normalizeBaitPath(p) === null);
  if (badBait !== undefined) {
    throw new AppError(400, `Invalid or reserved bait path: ${badBait.slice(0, 200)}`, 'validation', { field: 'honeypot.paths', path: badBait.slice(0, 200) });
  }

  // Routes
  if (s.routes.length > MAX_ROUTES_PER_HOST) throw new AppError(400, `At most ${MAX_ROUTES_PER_HOST} routes`, 'validation');
  const seen = new Set<string>();
  const routes: ProxyRouteInput[] = [];
  for (const [i, r] of s.routes.entries()) {
    if (!isValidRoutePath(r.path)) throw new AppError(400, `Invalid route path ${r.path}`, 'validation', { path: r.path });
    if (seen.has(r.path)) throw new AppError(400, `Duplicate route path ${r.path}`, 'validation', { path: r.path });
    seen.add(r.path);
    if (r.rewritePrefix !== null && r.rewritePrefix !== undefined && !isValidRewritePrefix(r.rewritePrefix)) {
      throw new AppError(400, 'Invalid rewrite prefix', 'validation', { path: r.path });
    }
    const prevRoute = previous?.routes.find((p) => p.path === r.path) ?? null;
    const rTarget = await normalizeTarget(r.target, {
      actor, accountId: account.id, tenantId: account.tenant_id, limits, protocol: 'http', previous: prevRoute?.target ?? null,
    });
    const ids = r.accessListMode === 'override' ? uniq((r.accessListIds ?? []).map(Number)) : [];
    await assertSameAccount('access_lists', ids, account.id, 'Access list');
    routes.push({
      path: r.path, rewritePrefix: r.rewritePrefix ?? null, target: rTarget, authMode: r.authMode === 'none' ? 'none' : 'inherit',
      accessListMode: r.accessListMode, accessListIds: ids, websocket: r.websocket ?? null, buffering: r.buffering ?? null, sortOrder: i,
    });
  }

  // Forward-auth catches every 401 (sign-in redirect): no basic-auth users under it (else an endless loop).
  await assertForwardAuthCompatible(db, { authProviderId: auth.authProviderId, accessListIds: auth.accessListIds, routes });

  // advancedConfig: platform staff only, setting on, ≤ 16 KiB, linted.
  let advancedConfig = s.advancedConfig && s.advancedConfig.trim() ? s.advancedConfig.replace(/\r\n?/g, '\n') : null;
  const prevAdvanced = previous?.advancedConfig ?? null;
  if (advancedConfig !== prevAdvanced) {
    if (!isPlatformAdmin(actor)) throw new AppError(403, 'The advanced configuration is reserved to the platform staff', 'advancedConfigForbidden');
    if (advancedConfig !== null) {
      if (!settings.allowAdvancedConfig) throw new AppError(403, 'The advanced configuration is disabled on this platform', 'advancedConfigForbidden');
      if (Buffer.byteLength(advancedConfig) > ADVANCED_CONFIG_MAX_BYTES) {
        throw new AppError(400, 'The advanced configuration is too long (16 KiB max)', 'advancedConfigInvalid', { issues: [{ line: 1, directive: null, code: 'tooLong', message: 'too long' }] });
      }
      const lint = proxyDeps().lintAdvancedConfig(advancedConfig);
      if (!lint.ok) throw new AppError(400, 'The advanced configuration is invalid', 'advancedConfigInvalid', { issues: lint.issues });
    }
  } else if (advancedConfig !== null && !isPlatformAdmin(actor)) {
    advancedConfig = prevAdvanced; // kept as is (a client never sees nor changes it)
  }

  return { ...s, name: s.name.trim(), target, ssl, options, auth, honeypot, routes, advancedConfig };
}

function previousPage(previous: HostState | null, id: number): number | null {
  if (!previous) return null;
  return previous.options.errorPageId === id || previous.options.wakingPageId === id ? id : null;
}

function stateFromBody(body: ProxyHostInput): HostState {
  return {
    name: body.name,
    enabled: body.enabled ?? true,
    domainIds: uniq(body.domainIds.map(Number)),
    target: body.target,
    ssl: { ...toSsl({}, null), ...(body.ssl ?? {}) },
    options: { ...DEFAULT_PROXY_HOST_OPTIONS, ...(body.options ?? {}) },
    auth: { accessListIds: [], authProviderId: null, allowedGroups: [], allowedEmails: [], ...(body.auth ?? {}) },
    honeypot: { ...toHoneypot({}), ...(body.honeypot ?? {}) },
    routes: body.routes ?? [],
    advancedConfig: body.advancedConfig ?? null,
    autoMonitor: body.autoMonitor ?? false,
  };
}

function stateFromHost(h: ProxyHost, advancedConfig: string | null): HostState {
  return {
    name: h.name,
    enabled: h.enabled,
    domainIds: h.domains.map((d) => d.domainId),
    target: h.target,
    ssl: h.ssl,
    options: h.options,
    auth: h.auth,
    honeypot: h.honeypot,
    routes: h.routes.map(({ id: _id, ...r }) => r),
    advancedConfig,
    autoMonitor: h.autoMonitor,
  };
}

function rowValues(s: HostState) {
  return {
    name: s.name,
    enabled: s.enabled,
    target: JSON.stringify(s.target),
    target_stack_id: s.target.kind === 'app' ? s.target.stackId : null,
    target_site_id: s.target.kind === 'site' ? s.target.siteId : null,
    ssl: JSON.stringify({ mode: s.ssl.mode, forceSsl: s.ssl.forceSsl, http2: s.ssl.http2, hsts: s.ssl.hsts, hstsSubdomains: s.ssl.hstsSubdomains }),
    imported_certificate_id: s.ssl.mode === 'imported' ? s.ssl.importedCertificateId : null,
    options: JSON.stringify(s.options),
    auth: JSON.stringify({ allowedGroups: s.auth.allowedGroups, allowedEmails: s.auth.allowedEmails }),
    auth_provider_id: s.auth.authProviderId,
    honeypot: JSON.stringify(s.honeypot),
    advanced_config: s.advancedConfig,
    auto_monitor: s.autoMonitor,
  };
}

async function writeChildren(trx: Knex.Transaction, hostId: number, s: HostState): Promise<void> {
  await trx('proxy_host_access_lists').where({ proxy_host_id: hostId }).del();
  if (s.auth.accessListIds.length) {
    await trx('proxy_host_access_lists').insert(s.auth.accessListIds.map((access_list_id) => ({ proxy_host_id: hostId, access_list_id })));
  }
  await trx('proxy_routes').where({ proxy_host_id: hostId }).del();
  if (s.routes.length) {
    await trx('proxy_routes').insert(s.routes.map((r, i) => ({
      proxy_host_id: hostId,
      path: r.path,
      rewrite_prefix: r.rewritePrefix,
      target: JSON.stringify(r.target),
      target_stack_id: r.target.kind === 'app' ? r.target.stackId : null,
      auth_mode: r.authMode,
      access_list_mode: r.accessListMode,
      access_list_ids: JSON.stringify(r.accessListIds),
      websocket: r.websocket,
      buffering: r.buffering,
      sort_order: i,
    })));
  }
}

/** Under the account lock: references still there (FOR SHARE) and still compatible (lists changed meanwhile). */
async function assertSavedReferences(trx: Knex.Transaction, accountId: number, s: HostState): Promise<void> {
  await assertHostReferencesLocked(trx, accountId, {
    authProviderId: s.auth.authProviderId,
    importedCertificateId: s.ssl.mode === 'imported' ? s.ssl.importedCertificateId : null,
    accessListIds: uniq([...s.auth.accessListIds, ...s.routes.flatMap((r) => r.accessListIds ?? [])]),
  });
  await assertForwardAuthCompatible(trx, { authProviderId: s.auth.authProviderId, accessListIds: s.auth.accessListIds, routes: s.routes.map((r) => ({
    path: r.path, authMode: r.authMode ?? 'inherit', accessListMode: r.accessListMode ?? 'inherit', accessListIds: r.accessListIds ?? [],
  })) });
}

function afterChange(hostId: number, reason: string, opts: { targets?: boolean; auth?: boolean; certDomains?: number[] }): void {
  const deps = proxyDeps();
  deps.scheduleEdgeSync(reason);
  if (opts.targets) deps.requestPolicySync(reason);
  if (opts.auth) deps.authChanged(reason);
  deps.syncAutoMonitor(hostId);
  for (const d of opts.certDomains ?? []) deps.ensureCertificate(d);
}

function targetsKey(s: HostState): string {
  return JSON.stringify([s.enabled, s.target, s.routes.map((r) => r.target)]);
}

export const proxyHostsService = {
  async list(actor: HostingActor, q: ProxyListQuery): Promise<ProxyHost[]> {
    if (actor.kind === 'staff') assertNeedSomewhere(actor, 'read');
    const qb = selectHosts();
    scopeOwned(actor, qb, 'h', { filterTenantId: q.tenantId ?? null });
    if (q.accountId) qb.where('h.account_id', q.accountId);
    const search = q.search?.trim().toLowerCase();
    if (search) {
      const like = `%${search.replace(/[%_\\]/g, '\\$&')}%`;
      qb.where((b) => {
        b.whereRaw('lower(h.name) like ?', [like])
          .orWhereExists(db('edge_domain_bindings as b').join('domains as d', 'd.id', 'b.domain_id')
            .whereRaw("b.kind = 'proxy' AND b.ref_id = h.id").where('d.name', 'like', like));
      });
    }
    return mapHosts(await qb.orderBy('h.name') as ProxyHostDbRow[], actor);
  },

  async get(actor: HostingActor, id: number): Promise<ProxyHost> {
    await loadProxyHost(actor, id, 'read');
    return fetchHost(id, actor);
  },

  async create(req: Request, actor: HostingActor, body: ProxyHostInput): Promise<ProxyHost> {
    const account = await loadAccount(actor, body.accountId, 'proxy.manage');
    const state = await normalizeState(actor, account, stateFromBody(body), null);
    const hostId = await db.transaction(async (trx) => {
      const locked = await lockAccount(trx, account.id);
      await assertPlanRoom(trx, account.id, locked.limits, 'proxyHosts');
      await assertSavedReferences(trx, account.id, state);
      const [row] = await trx('proxy_hosts').insert({ tenant_id: account.tenant_id, account_id: account.id, ...rowValues(state) }).returning('id') as
        Array<{ id: number }>;
      const id = Number(row.id);
      await bindDomains(trx, actor, account.id, 'proxy', id, state.domainIds);
      await writeChildren(trx, id, state);
      return id;
    });
    await auditProxy(req, account.tenant_id, 'proxy.host.create', 'proxy_host', hostId, {
      accountId: account.id, name: state.name, domainIds: state.domainIds, target: state.target.kind,
    });
    emitProxy('host', hostId, { tenantId: account.tenant_id, accountId: account.id }, 'created');
    afterChange(hostId, `proxy host ${hostId} created`, {
      targets: true, auth: state.auth.authProviderId !== null, certDomains: state.ssl.mode === 'auto' ? state.domainIds : [],
    });
    return fetchHost(hostId, actor);
  },

  async update(req: Request, actor: HostingActor, id: number, body: ProxyHostUpdate): Promise<ProxyHost> {
    const row = await loadProxyHost(actor, id, 'proxy.manage');
    const current = await fetchHost(id, { kind: 'staff', userId: 0, tenantId: row.tenant_id, globalView: true, caps: '*' });
    const stored = await db('proxy_hosts').where({ id }).first('advanced_config') as { advanced_config: string | null };
    const prev = stateFromHost(current, stored.advanced_config ?? null);
    const merged: HostState = {
      name: body.name ?? prev.name,
      enabled: body.enabled ?? prev.enabled,
      domainIds: body.domainIds ? uniq(body.domainIds.map(Number)) : prev.domainIds,
      target: body.target ?? prev.target,
      ssl: { ...prev.ssl, ...(body.ssl ?? {}) },
      options: { ...prev.options, ...(body.options ?? {}) },
      auth: { ...prev.auth, ...(body.auth ?? {}) },
      honeypot: { ...prev.honeypot, ...(body.honeypot ?? {}) },
      routes: body.routes ?? prev.routes,
      advancedConfig: body.advancedConfig === undefined ? prev.advancedConfig : body.advancedConfig,
      autoMonitor: body.autoMonitor ?? prev.autoMonitor,
    };
    const account = { id: Number(row.account_id), tenant_id: Number(row.tenant_id) };
    const state = await normalizeState(actor, account, merged, prev);
    await db.transaction(async (trx) => {
      await lockAccount(trx, account.id);
      await assertSavedReferences(trx, account.id, state);
      await trx('proxy_hosts').where({ id, tenant_id: account.tenant_id }).update({ ...rowValues(state), updated_at: trx.fn.now() });
      await bindDomains(trx, actor, account.id, 'proxy', id, state.domainIds);
      await writeChildren(trx, id, state);
    });
    await auditProxy(req, account.tenant_id, 'proxy.host.update', 'proxy_host', id, {
      accountId: account.id, fields: Object.keys(body), ...(state.advancedConfig !== prev.advancedConfig ? { advancedConfigChanged: true } : {}),
    });
    emitProxy('host', id, { tenantId: account.tenant_id, accountId: account.id }, 'updated');
    const newDomains = state.domainIds.filter((d) => !prev.domainIds.includes(d) || state.ssl.mode !== prev.ssl.mode);
    afterChange(id, `proxy host ${id} updated`, {
      targets: targetsKey(state) !== targetsKey(prev),
      auth: state.auth.authProviderId !== prev.auth.authProviderId || state.auth.authProviderId !== null,
      certDomains: state.ssl.mode === 'auto' ? newDomains : [],
    });
    return fetchHost(id, actor);
  },

  async remove(req: Request, actor: HostingActor, id: number): Promise<void> {
    const row = await loadProxyHost(actor, id, 'proxy.manage');
    const host = await db('proxy_hosts').where({ id }).first('auth_provider_id', 'name') as { auth_provider_id: number | null; name: string };
    let domainIds: number[] = [];
    await db.transaction(async (trx) => {
      await lockAccount(trx, Number(row.account_id));
      domainIds = await unbindAll(trx, 'proxy', id);
      await trx('proxy_hosts').where({ id, tenant_id: row.tenant_id }).del();
    });
    await auditProxy(req, Number(row.tenant_id), 'proxy.host.delete', 'proxy_host', id, { accountId: row.account_id, name: host.name, domainIds });
    emitProxy('host', id, { tenantId: Number(row.tenant_id), accountId: Number(row.account_id) }, 'deleted');
    afterChange(id, `proxy host ${id} deleted`, { targets: true, auth: host.auth_provider_id !== null });
  },

  /** POST /hosts/:id/retry: re-validate + apply the unit now (edge-robustness), else a sync. */
  async retry(req: Request, actor: HostingActor, id: number): Promise<ProxyHost> {
    const row = await loadProxyHost(actor, id, 'proxy.manage');
    try {
      await proxyDeps().retryUnit(req, proxyHostUnitId(id));
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 501) {
        proxyDeps().scheduleEdgeSync(`proxy host ${id} retry`);
      } else if (err instanceof AppError && err.statusCode < 500) {
        throw err;
      } else {
        logger.warn({ err: (err as Error)?.message, id }, 'proxy: unit retry failed');
        throw new AppError(502, actor.kind === 'client' ? 'The edge is unavailable, try again later' : `Edge retry failed: ${(err as Error)?.message}`,
          'edgeUnavailable');
      }
    }
    await auditProxy(req, Number(row.tenant_id), 'edge.unit.retry', 'proxy_host', id, { unitId: proxyHostUnitId(id) });
    emitProxy('host', id, { tenantId: Number(row.tenant_id), accountId: Number(row.account_id) }, 'status');
    return fetchHost(id, actor);
  },

  /** POST /hosts/quick-setup (from an app stack): host + certificates (letsencrypt) + auto monitor. */
  async quickSetup(req: Request, actor: HostingActor, body: ProxyQuickSetupRequest): Promise<ProxyHost> {
    const info = await proxyDeps().targetInfo(body.stackId, body.service);
    if (!info) throw new AppError(404, 'Application not found', 'notFound');
    // The actor must see the stack (same account, read) and manage the proxy objects of its account.
    await loadAccount(actor, Number(info.accountId), 'read');
    const account = await loadAccount(actor, Number(info.accountId), 'proxy.manage');
    let stackName = `#${body.stackId}`;
    try { stackName = (await proxyDeps().stackSummary(body.stackId))?.name ?? stackName; } catch { /* label only */ }
    const letsencrypt = body.letsencrypt !== false;
    const domainIds = uniq(body.domainIds.map(Number));
    // TLS turned on through the domain module (its checks, its domain.update audit, its certificate request):
    // the actor must manage the domains too — checked BEFORE the host exists.
    const toSwitch = letsencrypt
      ? (await db('domains').whereIn('id', domainIds).where({ account_id: account.id }).whereNot({ tls_mode: 'letsencrypt' }).pluck('id') as number[]).map(Number)
      : [];
    if (toSwitch.length) await loadAccount(actor, account.id, 'domains.manage');
    const host = await this.create(req, actor, {
      accountId: account.id,
      name: `${stackName}-${body.service}`.slice(0, 128),
      domainIds,
      target: { kind: 'app', stackId: body.stackId, service: body.service, port: body.port, scheme: 'http' },
      ssl: { mode: 'auto', forceSsl: true, http2: true, hsts: letsencrypt, hstsSubdomains: false, importedCertificateId: null },
      options: { websocket: true, blockExploits: true },
      autoMonitor: body.autoMonitor !== false,
    });
    if (letsencrypt) {
      const { domainsService } = await import('../hosting/domains.service');
      for (const d of toSwitch) await domainsService.update(req, actor, d, { tlsMode: 'letsencrypt' });
      for (const d of domainIds) proxyDeps().ensureCertificate(d);
      if (toSwitch.length) return fetchHost(host.id, actor);
    }
    return host;
  },
};
