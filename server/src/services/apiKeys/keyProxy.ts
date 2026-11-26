import type { Request } from 'express';
import type { ApiV1ProxyHost, ApiV1ProxyTarget, ClientCapability, ProxyHost, ProxyHostOptions, ProxyHostSsl, ProxyHostUpdate, ProxyRouteInput, ProxyScheme, ProxyTarget } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { appsService } from '../apps/apps.service';
import { assertNotContained } from '../containment/guard';
import type { HostingActor } from '../hosting/access';
import { loadProxyHost } from '../proxy/access';
import { acmeDomainsToSwitch, proxyHostsService, switchDomainsToAcme } from '../proxy/hosts.service';
import { asKeyRequest, keyGated } from '../restrictions/targets';
import { keyAllowsDomain, requireScope, type ApiKeyContext } from './apiKeys.service';
import { createKeySubdomain } from './keyApi';
import { keyStackId } from './keyStacks';

// ─────────────────────────────────────────────────────────────────────────────
// Proxy hosts through an access key (scope proxy.manage, opt-in: never in a
// preset): REST /api/v1/proxy-hosts…, MCP list_proxy_hosts, create_proxy_host,
// update_proxy_host, delete_proxy_host. « domain → application:internal port »
// with its Let's Encrypt certificate and the HTTPS redirection, exactly as the
// panel's quick setup does it (proxyHostsService.create, then the domains'
// TLS switched to Let's Encrypt through the domain module: acmeDomainsToSwitch
// / switchDomainsToAcme of hosts.service.ts). No parallel path: the proxy
// service keeps every check (plan maxProxyHosts, verified domain of the
// account, domain free of sites and other hosts, target of the account and a
// port the service exposes, external targets per plan and tenant policy +
// SSRF rules, audit, PROXY_UPDATED, edge sync, segmentation policy, monitor).
//
// Perimeter: the proxy hosts of the key's account; it may bind only the
// domains given to the key (or every domain for a key on every domain), and
// the subdomains it creates on the fly with domains.subdomain (under its
// parents, serving nothing yet). Binding a domain takes it from the sites: the
// panel asks domains.manage for it (L1); the key's creator holds it (SCOPE_NEED
// of proxy.manage), and keyProxy lends it to the proxy service for those
// domains only (bindingActor). A host is changed or deleted only when every
// domain it serves is the key's (manageable). Targets: an application of the
// account (any of them: apps belong to the account) or an external address
// (plan); never a site (routes are for that), never advancedConfig nor
// access lists / sign-in providers (kept as the panel set them).
// Deletion: gate proxy.host_delete (the key's owner confirms by default).
// ─────────────────────────────────────────────────────────────────────────────

export interface KeyProxyTargetInput {
  /** An application of the account (id or name) and its service; or host for an external address. */
  appId?: number;
  appName?: string;
  service?: string;
  host?: string;
  port: number;
  scheme?: ProxyScheme;
}

export interface KeyProxyHostInput {
  name?: string;
  enabled?: boolean;
  /** Domain names: given to the key, or a new subdomain under one of its parents (domains.subdomain). */
  domains: string[];
  target: KeyProxyTargetInput;
  /** Let's Encrypt certificate + http → https redirection (default true). */
  ssl?: boolean;
  http2?: boolean;
  hsts?: boolean;
  websocket?: boolean;
  gzip?: boolean;
  cache?: boolean;
  blockExploits?: boolean;
  bodySizeMb?: number | null;
  readTimeoutSec?: number;
  /** Path routes towards other targets (e.g. /api/ → the api service); replaces them all on an update. */
  routes?: Array<{ path: string; target: KeyProxyTargetInput; rewritePrefix?: string | null }>;
}

export type KeyProxyHostUpdate = Partial<KeyProxyHostInput>;

const normalizeName = (raw: unknown) => String(raw ?? '').trim().toLowerCase().replace(/\.$/, '');

/** A change of the account's proxy: the scope, then nothing that opens a way in during a containment. */
async function writable(ctx: ApiKeyContext): Promise<void> {
  requireScope(ctx, 'proxy.manage');
  await assertNotContained(ctx.accountId);
}

/**
 * The key's actor with domains.manage on its account, for the proxy service only: the domains it binds were
 * checked first (keyAllowsDomain or created by this very call), and the creator holds domains.manage
 * (SCOPE_NEED of proxy.manage) — the panel's rule L1, never wider.
 */
function bindingActor(ctx: ApiKeyContext): HostingActor {
  const a = ctx.actor;
  if (a.kind !== 'client') return a;
  const caps = new Set<ClientCapability>(a.accounts.get(ctx.accountId) ?? []);
  caps.add('domains.manage');
  return { ...a, accounts: new Map([[ctx.accountId, caps]]) };
}

/** A proxy target of the caller → the panel's ProxyTarget (an application of the account, or an external address). */
async function targetOf(ctx: ApiKeyContext, t: KeyProxyTargetInput): Promise<ProxyTarget> {
  const app = t.appId !== undefined || t.appName !== undefined;
  if (t.host !== undefined && t.host !== null && t.host !== '') {
    if (app || t.service) throw new AppError(400, 'A target is an application (app and service) or an external host, not both', 'targetInvalid');
    return { kind: 'external', host: t.host, port: t.port, scheme: t.scheme ?? 'http' };
  }
  if (!app) throw new AppError(400, 'A target needs an application (app_id or app_name) and its service, or an external host', 'targetInvalid');
  const stackId = await keyStackId(ctx, t.appId !== undefined ? { id: t.appId } : { name: t.appName! });
  let service = t.service?.trim() || null;
  if (!service) {
    const names = (await appsService.get(ctx.actor, stackId)).services.map((s) => s.name);
    if (names.length !== 1) throw new AppError(400, `Name the service of the application (${names.join(', ') || 'none'})`, 'targetInvalid', { services: names });
    service = names[0];
  }
  return { kind: 'app', stackId, service, port: t.port, scheme: t.scheme ?? 'http' };
}

/**
 * Domain names → ids of the account the key may bind. A name the account does not have yet is created as a
 * subdomain of one of the key's parents when it holds domains.subdomain (`created`: removed again if the host
 * cannot be saved). Existing domains are all checked before anything is created.
 */
async function domainIdsOf(ctx: ApiKeyContext, req: Request, names: string[], created: number[]): Promise<number[]> {
  const wanted = [...new Set(names.map(normalizeName).filter(Boolean))];
  if (!wanted.length) throw new AppError(400, 'At least one domain', 'validation', { field: 'domains' });
  const rows = await db('domains').where({ account_id: ctx.accountId, tenant_id: ctx.tenantId }).whereIn('name', wanted).select('id', 'name') as Array<{ id: number; name: string }>;
  const byName = new Map(rows.map((r) => [r.name, Number(r.id)]));
  const ids: number[] = [];
  const missing: string[] = [];
  for (const n of wanted) {
    const id = byName.get(n);
    if (id === undefined) { missing.push(n); continue; }
    if (!keyAllowsDomain(ctx, id) && !created.includes(id)) {
      throw new AppError(403, `${n} is not given to this key: give it to the key in the panel (Access keys › Domains)`, 'keyDomainNotManageable', { domain: n });
    }
    ids.push(id);
  }
  if (missing.length && !ctx.scopes.has('domains.subdomain')) {
    throw new AppError(404, `${missing[0]} is not a domain of the account (a new subdomain needs the domains.subdomain scope)`, 'domainNotInAccount', { domain: missing[0] });
  }
  for (const n of missing) {
    const d = await createKeySubdomain(ctx, asKeyRequest(req, ctx), n, null);
    created.push(d.id);
    ids.push(d.id);
  }
  return ids;
}

/** Subdomains this call created, removed after a failed save (best effort, audited by the domain module). */
async function dropCreated(ctx: ApiKeyContext, req: Request, created: number[]): Promise<void> {
  if (!created.length) return;
  const { domainsService } = await import('../hosting/domains.service');
  for (const id of created) {
    try { await domainsService.remove(asKeyRequest(req, ctx), ctx.actor, id); } catch (err) {
      logger.warn({ err: (err as Error)?.message, domainId: id }, 'keyProxy: subdomain created for a failed host not removed');
    }
  }
}

function sslOf(ssl: boolean, b: { http2?: boolean; hsts?: boolean }, prev?: ProxyHostSsl): ProxyHostSsl {
  if (!ssl) return { mode: 'none', importedCertificateId: null, forceSsl: false, http2: false, hsts: false, hstsSubdomains: false };
  return {
    mode: 'auto', importedCertificateId: null, forceSsl: true,
    http2: b.http2 ?? prev?.http2 ?? true, hsts: b.hsts ?? prev?.hsts ?? true, hstsSubdomains: prev?.hstsSubdomains ?? false,
  };
}

function optionsOf(b: KeyProxyHostUpdate): Partial<ProxyHostOptions> {
  return {
    ...(b.websocket !== undefined ? { websocket: b.websocket } : {}),
    ...(b.gzip !== undefined ? { gzip: b.gzip } : {}),
    ...(b.cache !== undefined ? { cache: b.cache } : {}),
    ...(b.blockExploits !== undefined ? { blockExploits: b.blockExploits } : {}),
    ...(b.bodySizeMb !== undefined ? { bodySizeMb: b.bodySizeMb } : {}),
    ...(b.readTimeoutSec !== undefined ? { readTimeoutSec: b.readTimeoutSec } : {}),
  };
}

async function routesOf(ctx: ApiKeyContext, routes: NonNullable<KeyProxyHostInput['routes']>): Promise<ProxyRouteInput[]> {
  const out: ProxyRouteInput[] = [];
  for (const [i, r] of routes.entries()) {
    out.push({
      path: r.path, rewritePrefix: r.rewritePrefix ?? null, target: await targetOf(ctx, r.target), authMode: 'inherit', accessListMode: 'inherit', accessListIds: [],
      websocket: null, buffering: null, sortOrder: i,
    });
  }
  return out;
}

const manageable = (ctx: ApiKeyContext, h: Pick<ProxyHost, 'domains'>) => h.domains.length > 0 && h.domains.every((d) => keyAllowsDomain(ctx, d.domainId));

async function appNames(ctx: ApiKeyContext, hosts: ProxyHost[]): Promise<Map<number, string>> {
  const ids = [...new Set(hosts.flatMap((h) => [h.target, ...h.routes.map((r) => r.target)]).filter((t) => t.kind === 'app' && t.stackId).map((t) => Number(t.stackId)))];
  if (!ids.length) return new Map();
  const rows = await db('app_stacks').where({ account_id: ctx.accountId }).whereIn('id', ids).select('id', 'name') as Array<{ id: number; name: string }>;
  return new Map(rows.map((r) => [Number(r.id), r.name]));
}

function targetView(t: ProxyTarget, names: Map<number, string>): ApiV1ProxyTarget {
  const appId = t.kind === 'app' && t.stackId ? Number(t.stackId) : null;
  return {
    kind: t.kind, appId, appName: appId !== null ? names.get(appId) ?? null : null, service: t.kind === 'app' ? t.service ?? null : null,
    siteId: t.kind === 'site' ? t.siteId ?? null : null, host: t.kind === 'external' ? t.host ?? null : null, port: t.port, scheme: t.scheme,
  };
}

function hostView(ctx: ApiKeyContext, h: ProxyHost, names: Map<number, string>): ApiV1ProxyHost {
  const https = h.ssl.mode !== 'none';
  return {
    id: h.id, name: h.name, enabled: h.enabled, manageable: manageable(ctx, h),
    domains: h.domains.map((d) => ({ name: d.name, verified: d.verified, certificate: d.certificate })),
    target: targetView(h.target, names), targetLabel: h.targetLabel,
    ssl: { mode: h.ssl.mode, forceSsl: h.ssl.forceSsl, http2: h.ssl.http2, hsts: h.ssl.hsts },
    options: {
      websocket: h.options.websocket, gzip: h.options.gzip, cache: h.options.cache, blockExploits: h.options.blockExploits,
      bodySizeMb: h.options.bodySizeMb, readTimeoutSec: h.options.readTimeoutSec,
    },
    routes: h.routes.map((r) => ({ path: r.path, rewritePrefix: r.rewritePrefix, target: targetView(r.target, names) })),
    protectedByAuth: h.auth.accessListIds.length > 0 || h.auth.authProviderId !== null,
    edge: h.edge ? { status: h.edge.status, error: h.edge.error } : null,
    urls: h.domains.map((d) => `${https ? 'https' : 'http'}://${d.name}/`),
    createdAt: h.createdAt, updatedAt: h.updatedAt,
  };
}

async function viewOf(ctx: ApiKeyContext, h: ProxyHost): Promise<ApiV1ProxyHost> {
  return hostView(ctx, h, await appNames(ctx, [h]));
}

/** A proxy host of the key's account that it may change: every domain it serves is the key's. */
async function manageableHost(ctx: ApiKeyContext, id: number): Promise<ProxyHost> {
  if (!Number.isInteger(id) || id <= 0) throw new AppError(404, 'Proxy host not found', 'notFound');
  const row = await loadProxyHost(ctx.actor, id, 'proxy.manage');
  if (Number(row.account_id) !== ctx.accountId) throw new AppError(404, 'Proxy host not found', 'notFound');
  const host = await proxyHostsService.get(ctx.actor, id);
  if (!manageable(ctx, host)) {
    throw new AppError(403, 'This proxy host serves a domain that is not given to this key: change it in the panel', 'keyDomainNotManageable', {
      domains: host.domains.filter((d) => !keyAllowsDomain(ctx, d.domainId)).map((d) => d.name),
    });
  }
  return host;
}

export const keyProxy = {
  /** The proxy hosts of the account (manageable: every domain is the key's). */
  async list(ctx: ApiKeyContext): Promise<ApiV1ProxyHost[]> {
    requireScope(ctx, 'proxy.manage');
    const hosts = (await proxyHostsService.list(ctx.actor, { accountId: ctx.accountId })).filter((h) => h.accountId === ctx.accountId);
    const names = await appNames(ctx, hosts);
    return hosts.map((h) => hostView(ctx, h, names));
  },

  async get(ctx: ApiKeyContext, id: number): Promise<ApiV1ProxyHost> {
    requireScope(ctx, 'proxy.manage');
    if (!Number.isInteger(id) || id <= 0) throw new AppError(404, 'Proxy host not found', 'notFound');
    const row = await loadProxyHost(ctx.actor, id, 'read');
    if (Number(row.account_id) !== ctx.accountId) throw new AppError(404, 'Proxy host not found', 'notFound');
    return viewOf(ctx, await proxyHostsService.get(ctx.actor, id));
  },

  /**
   * domain(s) → an application's internal port (or an external address), with Let's Encrypt and the redirection
   * to https by default — the panel's quick setup: proxy host first, then the domains' TLS turned to Let's Encrypt.
   */
  async create(ctx: ApiKeyContext, req: Request, body: KeyProxyHostInput): Promise<ApiV1ProxyHost> {
    await writable(ctx);
    const kreq = asKeyRequest(req, ctx);
    const target = await targetOf(ctx, body.target);
    const routes = body.routes ? await routesOf(ctx, body.routes) : undefined;
    const created: number[] = [];
    const actor = bindingActor(ctx);
    let host: ProxyHost;
    let domainIds: number[];
    let toSwitch: number[];
    const ssl = body.ssl !== false;
    try {
      domainIds = await domainIdsOf(ctx, req, body.domains, created);
      toSwitch = ssl ? await acmeDomainsToSwitch(actor, ctx.accountId, domainIds) : [];
      host = await proxyHostsService.create(kreq, actor, {
        accountId: ctx.accountId,
        name: (body.name?.trim() || normalizeName(body.domains[0])).slice(0, 128),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        domainIds,
        target,
        ssl: sslOf(ssl, body),
        options: { websocket: true, blockExploits: true, ...optionsOf(body) },
        ...(routes ? { routes } : {}),
        autoMonitor: true,
      });
    } catch (err) {
      // Nothing was saved: the subdomains made for it go away again.
      await dropCreated(ctx, req, created);
      throw err;
    }
    if (ssl) await switchDomainsToAcme(kreq, actor, toSwitch, domainIds);
    return viewOf(ctx, toSwitch.length ? await proxyHostsService.get(ctx.actor, host.id) : host);
  },

  /** Changes a proxy host of the key (only the fields given; routes replaced when given). */
  async update(ctx: ApiKeyContext, req: Request, id: number, body: KeyProxyHostUpdate): Promise<ApiV1ProxyHost> {
    await writable(ctx);
    const kreq = asKeyRequest(req, ctx);
    const current = await manageableHost(ctx, id);
    const patch: ProxyHostUpdate = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.target !== undefined) patch.target = await targetOf(ctx, body.target);
    if (body.routes !== undefined) patch.routes = await routesOf(ctx, body.routes);
    const options = optionsOf(body);
    if (Object.keys(options).length) patch.options = options;
    const wantsSsl = body.ssl !== undefined ? body.ssl : current.ssl.mode !== 'none';
    if (body.ssl !== undefined || body.http2 !== undefined || body.hsts !== undefined) {
      // An imported certificate (set in the panel) stays as it is unless ssl is given.
      if (body.ssl !== undefined || current.ssl.mode !== 'imported') patch.ssl = sslOf(wantsSsl, body, current.ssl);
    }
    const created: number[] = [];
    const actor = bindingActor(ctx);
    const acme = (patch.ssl?.mode ?? current.ssl.mode) === 'auto';
    let host: ProxyHost;
    let domainIds: number[];
    let toSwitch: number[];
    try {
      if (body.domains !== undefined) patch.domainIds = await domainIdsOf(ctx, req, body.domains, created);
      domainIds = patch.domainIds ?? current.domains.map((d) => d.domainId);
      toSwitch = acme ? await acmeDomainsToSwitch(actor, ctx.accountId, domainIds) : [];
      host = await proxyHostsService.update(kreq, actor, id, patch);
    } catch (err) {
      await dropCreated(ctx, req, created);
      throw err;
    }
    if (acme && (toSwitch.length || patch.domainIds || patch.ssl)) await switchDomainsToAcme(kreq, actor, toSwitch, domainIds);
    return viewOf(ctx, toSwitch.length ? await proxyHostsService.get(ctx.actor, host.id) : host);
  },

  /** Deletes a proxy host of the key (its domains go back to the sites). Gate proxy.host_delete: the key's owner confirms by default. */
  async remove(ctx: ApiKeyContext, req: Request, id: number): Promise<{ deleted: true; id: number; name: string }> {
    await writable(ctx);
    const host = await manageableHost(ctx, id);
    await keyGated(ctx, req, {
      // The panel's own gate (routes/proxy.routes.ts): the same parameters.
      action: 'proxy.host_delete', target: { tenantId: host.tenantId, accountId: host.accountId, siteId: null }, params: { name: host.name, hostId: host.id },
    }, () => proxyHostsService.remove(asKeyRequest(req, ctx), ctx.actor, id));
    return { deleted: true, id: host.id, name: host.name };
  },
};
