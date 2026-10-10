import type { Request } from 'express';
import type {
  ProxyDeadHost, ProxyDeadHostInput, ProxyDeadHostUpdate, ProxyRedirection, ProxyRedirectionInput, ProxyRedirectionUpdate,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { isValidServerName } from '../edge/nginxConfig';
import { assertNeedSomewhere, loadAccount, type HostingActor } from '../hosting/access';
import { assertUsable, loadOwned, scopeOwned } from '../hosting/p4bAccess';
import { domainServerNames } from '../edge/vhostPlan';
import { auditProxy, bindDomains, boundDomains, emitProxy, lockAccount, assertPlanRoom, unbindAll } from './common';
import { proxyDeps } from './deps';
import { edgeView, MAX_DOMAINS_PER_OBJECT, type ProxyListQuery } from './hosts.service';
import { isoNow, type DeadHostDbRow, type RedirectionDbRow } from './rows';
import { normalizeIp } from './targets';
import { isValidTargetPath, uniq } from './validation';
import { json } from '../hosting/rows';

// ─────────────────────────────────────────────────────────────────────────────
// Redirections and dead hosts (docs/P4b-PLAN.md §6.3, §8.8). Same domain rules
// as the proxy hosts (verified, same account, one consumer); plan limit
// maxRedirections counts both kinds (409 planLimit, dimension redirections).
// ─────────────────────────────────────────────────────────────────────────────

type RedirSsl = ProxyRedirection['ssl'];
type DeadSsl = ProxyDeadHost['ssl'];

function redirSsl(v: unknown): RedirSsl {
  const s = json<Partial<RedirSsl>>(v, {});
  return { forceSsl: s.forceSsl ?? true, http2: s.http2 ?? true, hsts: s.hsts ?? false };
}

function deadSsl(v: unknown): DeadSsl {
  const s = json<Partial<DeadSsl>>(v, {});
  return { forceSsl: s.forceSsl ?? false, http2: s.http2 ?? true };
}

function checkDomainCount(ids: number[]): void {
  if (!ids.length || ids.length > MAX_DOMAINS_PER_OBJECT) throw new AppError(400, `Between 1 and ${MAX_DOMAINS_PER_OBJECT} domains`, 'validation');
}

async function mapRedirections(rows: RedirectionDbRow[], actor: HostingActor): Promise<ProxyRedirection[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => Number(r.id));
  const [domains, states] = await Promise.all([boundDomains(db, 'redirect', ids), proxyDeps().unitStates('redirection', ids)]);
  return rows.map((r) => ({
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    accountId: Number(r.account_id),
    accountUsername: r.account_username ?? '',
    enabled: !!r.enabled,
    domains: domains.get(Number(r.id)) ?? [],
    targetScheme: r.target_scheme === 'http' || r.target_scheme === 'https' ? r.target_scheme : 'auto',
    targetDomain: r.target_domain,
    targetPath: r.target_path,
    preservePath: !!r.preserve_path,
    statusCode: ([301, 302, 307, 308].includes(Number(r.status_code)) ? Number(r.status_code) : 301) as ProxyRedirection['statusCode'],
    ssl: redirSsl(r.ssl),
    edge: edgeView(states.get(Number(r.id)), actor, { unitId: `rd-${Number(r.id)}`, ownerKind: 'redirection', ownerId: Number(r.id), accountId: Number(r.account_id) }),
    createdAt: isoNow(r.created_at),
    updatedAt: isoNow(r.updated_at),
  }));
}

async function mapDeadHosts(rows: DeadHostDbRow[], actor: HostingActor): Promise<ProxyDeadHost[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => Number(r.id));
  const [domains, states] = await Promise.all([boundDomains(db, 'dead', ids), proxyDeps().unitStates('dead-host', ids)]);
  return rows.map((r) => ({
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    accountId: Number(r.account_id),
    accountUsername: r.account_username ?? '',
    enabled: !!r.enabled,
    domains: domains.get(Number(r.id)) ?? [],
    ssl: deadSsl(r.ssl),
    customPageId: r.custom_page_id === null ? null : Number(r.custom_page_id),
    edge: edgeView(states.get(Number(r.id)), actor, { unitId: `dh-${Number(r.id)}`, ownerKind: 'dead-host', ownerId: Number(r.id), accountId: Number(r.account_id) }),
    createdAt: isoNow(r.created_at),
    updatedAt: isoNow(r.updated_at),
  }));
}

const selectRedirections = () => db('proxy_redirections as r').join('hosting_accounts as a', 'a.id', 'r.account_id').select('r.*', 'a.username as account_username');
const selectDeadHosts = () => db('proxy_dead_hosts as r').join('hosting_accounts as a', 'a.id', 'r.account_id').select('r.*', 'a.username as account_username');

interface RedirState {
  enabled: boolean;
  domainIds: number[];
  targetScheme: 'http' | 'https' | 'auto';
  targetDomain: string;
  targetPath: string | null;
  preservePath: boolean;
  statusCode: 301 | 302 | 307 | 308;
  ssl: RedirSsl;
}

/** Target checks + a trivial self-loop refusal (same name, no path). */
async function checkRedirection(s: RedirState): Promise<RedirState> {
  const domain = s.targetDomain.trim().toLowerCase().replace(/\.$/, '');
  const ip = normalizeIp(domain);
  if (!ip && !isValidServerName(domain)) throw new AppError(400, 'Invalid target domain', 'targetInvalid');
  if (s.targetPath !== null && !isValidTargetPath(s.targetPath)) throw new AppError(400, 'Invalid target path', 'targetInvalid');
  const own = await db('domains').whereIn('id', s.domainIds).select('name', 'include_www', 'wildcard') as
    Array<{ name: string; include_www: boolean; wildcard: boolean }>;
  const names = own.flatMap((d) => domainServerNames(d, { wildcard: false }));
  if (names.includes(domain) && (s.targetPath === null || s.targetPath === '/') && s.preservePath) {
    throw new AppError(400, 'This redirection would loop on itself', 'targetInvalid');
  }
  return { ...s, targetDomain: ip ?? domain };
}

function redirValues(s: RedirState) {
  return {
    enabled: s.enabled, target_scheme: s.targetScheme, target_domain: s.targetDomain, target_path: s.targetPath, preserve_path: s.preservePath,
    status_code: s.statusCode, ssl: JSON.stringify(s.ssl),
  };
}

export const redirectionsService = {
  async list(actor: HostingActor, q: ProxyListQuery): Promise<ProxyRedirection[]> {
    if (actor.kind === 'staff') assertNeedSomewhere(actor, 'read');
    const qb = selectRedirections();
    scopeOwned(actor, qb, 'r', { filterTenantId: q.tenantId ?? null });
    if (q.accountId) qb.where('r.account_id', q.accountId);
    return mapRedirections(await qb.orderBy('r.id') as RedirectionDbRow[], actor);
  },

  async get(actor: HostingActor, id: number): Promise<ProxyRedirection> {
    await loadOwned(actor, 'proxy_redirections', id, 'read', 'Redirection');
    return (await mapRedirections([await selectRedirections().where('r.id', id).first() as RedirectionDbRow], actor))[0];
  },

  async create(req: Request, actor: HostingActor, body: ProxyRedirectionInput): Promise<ProxyRedirection> {
    const account = await loadAccount(actor, body.accountId, 'proxy.manage');
    const domainIds = uniq(body.domainIds.map(Number));
    checkDomainCount(domainIds);
    const state = await checkRedirection({
      enabled: body.enabled ?? true, domainIds, targetScheme: body.targetScheme ?? 'auto', targetDomain: body.targetDomain,
      targetPath: body.targetPath ?? null, preservePath: body.preservePath ?? true, statusCode: body.statusCode ?? 301,
      ssl: { ...redirSsl({}), ...(body.ssl ?? {}) },
    });
    const id = await db.transaction(async (trx) => {
      const locked = await lockAccount(trx, account.id);
      await assertPlanRoom(trx, account.id, locked.limits, 'redirections');
      const [row] = await trx('proxy_redirections').insert({ tenant_id: account.tenant_id, account_id: account.id, ...redirValues(state) })
        .returning('id') as Array<{ id: number }>;
      await bindDomains(trx, account.id, 'redirect', Number(row.id), domainIds);
      return Number(row.id);
    });
    await auditProxy(req, account.tenant_id, 'proxy.redirection.create', 'proxy_redirection', id, { accountId: account.id, domainIds, target: state.targetDomain });
    emitProxy('redirection', id, { tenantId: account.tenant_id, accountId: account.id }, 'created');
    proxyDeps().scheduleEdgeSync(`redirection ${id} created`);
    for (const d of domainIds) proxyDeps().ensureCertificate(d);
    return this.get(actor, id);
  },

  async update(req: Request, actor: HostingActor, id: number, body: ProxyRedirectionUpdate): Promise<ProxyRedirection> {
    const row = await loadOwned(actor, 'proxy_redirections', id, 'proxy.manage', 'Redirection') as unknown as RedirectionDbRow;
    const current = (await mapRedirections([row], actor))[0];
    const domainIds = body.domainIds ? uniq(body.domainIds.map(Number)) : current.domains.map((d) => d.domainId);
    checkDomainCount(domainIds);
    const state = await checkRedirection({
      enabled: body.enabled ?? current.enabled, domainIds, targetScheme: body.targetScheme ?? current.targetScheme,
      targetDomain: body.targetDomain ?? current.targetDomain, targetPath: body.targetPath === undefined ? current.targetPath : body.targetPath,
      preservePath: body.preservePath ?? current.preservePath, statusCode: body.statusCode ?? current.statusCode, ssl: { ...current.ssl, ...(body.ssl ?? {}) },
    });
    const accountId = Number(row.account_id);
    await db.transaction(async (trx) => {
      await lockAccount(trx, accountId);
      await trx('proxy_redirections').where({ id, tenant_id: row.tenant_id }).update({ ...redirValues(state), updated_at: trx.fn.now() });
      await bindDomains(trx, accountId, 'redirect', id, domainIds);
    });
    await auditProxy(req, Number(row.tenant_id), 'proxy.redirection.update', 'proxy_redirection', id, { accountId, fields: Object.keys(body) });
    emitProxy('redirection', id, { tenantId: Number(row.tenant_id), accountId }, 'updated');
    proxyDeps().scheduleEdgeSync(`redirection ${id} updated`);
    for (const d of domainIds.filter((x) => !current.domains.some((c) => c.domainId === x))) proxyDeps().ensureCertificate(d);
    return this.get(actor, id);
  },

  async remove(req: Request, actor: HostingActor, id: number): Promise<void> {
    const row = await loadOwned(actor, 'proxy_redirections', id, 'proxy.manage', 'Redirection');
    let domainIds: number[] = [];
    await db.transaction(async (trx) => {
      await lockAccount(trx, Number(row.account_id));
      domainIds = await unbindAll(trx, 'redirect', id);
      await trx('proxy_redirections').where({ id, tenant_id: row.tenant_id }).del();
    });
    await auditProxy(req, Number(row.tenant_id), 'proxy.redirection.delete', 'proxy_redirection', id, { accountId: row.account_id, domainIds });
    emitProxy('redirection', id, { tenantId: Number(row.tenant_id), accountId: Number(row.account_id) }, 'deleted');
    proxyDeps().scheduleEdgeSync(`redirection ${id} deleted`);
  },
};

export const deadHostsService = {
  async list(actor: HostingActor, q: ProxyListQuery): Promise<ProxyDeadHost[]> {
    if (actor.kind === 'staff') assertNeedSomewhere(actor, 'read');
    const qb = selectDeadHosts();
    scopeOwned(actor, qb, 'r', { filterTenantId: q.tenantId ?? null });
    if (q.accountId) qb.where('r.account_id', q.accountId);
    return mapDeadHosts(await qb.orderBy('r.id') as DeadHostDbRow[], actor);
  },

  async get(actor: HostingActor, id: number): Promise<ProxyDeadHost> {
    await loadOwned(actor, 'proxy_dead_hosts', id, 'read', 'Dead host');
    return (await mapDeadHosts([await selectDeadHosts().where('r.id', id).first() as DeadHostDbRow], actor))[0];
  },

  async create(req: Request, actor: HostingActor, body: ProxyDeadHostInput): Promise<ProxyDeadHost> {
    const account = await loadAccount(actor, body.accountId, 'proxy.manage');
    const domainIds = uniq(body.domainIds.map(Number));
    checkDomainCount(domainIds);
    const pageId = body.customPageId ?? null;
    if (pageId !== null) await assertUsable(actor, 'custom_pages', pageId, account.id, 'Custom page');
    const ssl = { ...deadSsl({}), ...(body.ssl ?? {}) };
    const id = await db.transaction(async (trx) => {
      const locked = await lockAccount(trx, account.id);
      await assertPlanRoom(trx, account.id, locked.limits, 'redirections');
      const [row] = await trx('proxy_dead_hosts').insert({
        tenant_id: account.tenant_id, account_id: account.id, enabled: body.enabled ?? true, ssl: JSON.stringify(ssl), custom_page_id: pageId,
      }).returning('id') as Array<{ id: number }>;
      await bindDomains(trx, account.id, 'dead', Number(row.id), domainIds);
      return Number(row.id);
    });
    await auditProxy(req, account.tenant_id, 'proxy.deadHost.create', 'proxy_dead_host', id, { accountId: account.id, domainIds });
    emitProxy('deadHost', id, { tenantId: account.tenant_id, accountId: account.id }, 'created');
    proxyDeps().scheduleEdgeSync(`dead host ${id} created`);
    for (const d of domainIds) proxyDeps().ensureCertificate(d);
    return this.get(actor, id);
  },

  async update(req: Request, actor: HostingActor, id: number, body: ProxyDeadHostUpdate): Promise<ProxyDeadHost> {
    const row = await loadOwned(actor, 'proxy_dead_hosts', id, 'proxy.manage', 'Dead host') as unknown as DeadHostDbRow;
    const current = (await mapDeadHosts([row], actor))[0];
    const accountId = Number(row.account_id);
    const domainIds = body.domainIds ? uniq(body.domainIds.map(Number)) : current.domains.map((d) => d.domainId);
    checkDomainCount(domainIds);
    const pageId = body.customPageId === undefined ? current.customPageId : body.customPageId;
    if (pageId !== null && pageId !== current.customPageId) await assertUsable(actor, 'custom_pages', pageId, accountId, 'Custom page');
    const ssl = { ...current.ssl, ...(body.ssl ?? {}) };
    await db.transaction(async (trx) => {
      await lockAccount(trx, accountId);
      await trx('proxy_dead_hosts').where({ id, tenant_id: row.tenant_id }).update({
        enabled: body.enabled ?? current.enabled, ssl: JSON.stringify(ssl), custom_page_id: pageId, updated_at: trx.fn.now(),
      });
      await bindDomains(trx, accountId, 'dead', id, domainIds);
    });
    await auditProxy(req, Number(row.tenant_id), 'proxy.deadHost.update', 'proxy_dead_host', id, { accountId, fields: Object.keys(body) });
    emitProxy('deadHost', id, { tenantId: Number(row.tenant_id), accountId }, 'updated');
    proxyDeps().scheduleEdgeSync(`dead host ${id} updated`);
    return this.get(actor, id);
  },

  async remove(req: Request, actor: HostingActor, id: number): Promise<void> {
    const row = await loadOwned(actor, 'proxy_dead_hosts', id, 'proxy.manage', 'Dead host');
    let domainIds: number[] = [];
    await db.transaction(async (trx) => {
      await lockAccount(trx, Number(row.account_id));
      domainIds = await unbindAll(trx, 'dead', id);
      await trx('proxy_dead_hosts').where({ id, tenant_id: row.tenant_id }).del();
    });
    await auditProxy(req, Number(row.tenant_id), 'proxy.deadHost.delete', 'proxy_dead_host', id, { accountId: row.account_id, domainIds });
    emitProxy('deadHost', id, { tenantId: Number(row.tenant_id), accountId: Number(row.account_id) }, 'deleted');
    proxyDeps().scheduleEdgeSync(`dead host ${id} deleted`);
  },
};
