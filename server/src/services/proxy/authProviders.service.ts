import crypto from 'crypto';
import type { Request } from 'express';
import type { AuthProvider, AuthProviderInput, AuthProviderUpdate } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { seal } from '../../utils/secretBox';
import { domainServerNames } from '../edge/vhostPlan';
import { assertNeedSomewhere, loadAccount, type HostingActor } from '../hosting/access';
import { isUniqueViolation } from '../hosting/hostingValidation.service';
import { loadOwned, scopeOwned } from '../hosting/p4bAccess';
import { sidecarStateOf } from './authInfra';
import { auditProxy, emitProxy, lockAccount } from './common';
import { proxyDeps } from './deps';
import type { ProxyListQuery } from './hosts.service';
import { isoNow, stringArray, type AuthProviderDbRow } from './rows';
import { uniq } from './validation';

// ─────────────────────────────────────────────────────────────────────────────
// Forward-auth providers (Azure AD / Entra ID through an oauth2-proxy sidecar,
// docs/P4b-PLAN.md §8.8, PX4 / PX5). The client secret and the generated
// cookie secret are sealed (secretBox 'proxy-auth') and never returned
// (hasSecret only). redirectUris = https://<each name of the protected
// domains>/oauth2/callback, to register in Azure. Every change asks the
// sidecars to converge (authInfra).
// ─────────────────────────────────────────────────────────────────────────────

/** 32 ASCII characters: one of the lengths oauth2-proxy accepts for its cookie secret. */
export function generateCookieSecret(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** Protected host names of each provider (bound domains of the hosts using it). */
export async function providerHostNames(providerIds: number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (!providerIds.length) return out;
  const rows = await db('proxy_hosts as h')
    .join('edge_domain_bindings as b', function joinB() { this.on('b.ref_id', '=', 'h.id').andOnVal('b.kind', '=', 'proxy'); })
    .join('domains as d', 'd.id', 'b.domain_id')
    .whereIn('h.auth_provider_id', providerIds)
    .select('h.auth_provider_id', 'd.name', 'd.include_www') as Array<{ auth_provider_id: number; name: string; include_www: boolean }>;
  for (const r of rows) {
    const list = out.get(Number(r.auth_provider_id)) ?? [];
    list.push(...domainServerNames({ name: r.name, include_www: r.include_www, wildcard: false }, { wildcard: false }));
    out.set(Number(r.auth_provider_id), uniq(list).sort());
  }
  return out;
}

async function mapProviders(rows: AuthProviderDbRow[]): Promise<AuthProvider[]> {
  const ids = rows.map((r) => Number(r.id));
  const names = await providerHostNames(ids);
  const usage = new Map<number, number>();
  if (ids.length) {
    const counts = await db('proxy_hosts').whereIn('auth_provider_id', ids).groupBy('auth_provider_id').select('auth_provider_id', db.raw('COUNT(*) AS n')) as
      Array<{ auth_provider_id: number; n: unknown }>;
    for (const c of counts) usage.set(Number(c.auth_provider_id), Number(c.n));
  }
  return rows.map((r) => ({
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    accountId: Number(r.account_id),
    name: r.name,
    kind: 'azure-ad',
    azureTenantId: r.azure_tenant_id,
    clientId: r.client_id,
    hasSecret: !!r.client_secret_sealed,
    allowedEmailDomains: stringArray(r.allowed_email_domains),
    allowedGroups: stringArray(r.allowed_groups),
    redirectUris: (names.get(Number(r.id)) ?? []).map((n) => `https://${n}/oauth2/callback`),
    sidecar: sidecarStateOf(Number(r.id)),
    usedBy: usage.get(Number(r.id)) ?? 0,
    createdAt: isoNow(r.created_at),
    updatedAt: isoNow(r.updated_at),
  }));
}

function nameTaken(): AppError {
  return new AppError(409, 'This name is already used in the account', 'nameTaken');
}

export const authProvidersService = {
  async list(actor: HostingActor, q: ProxyListQuery): Promise<AuthProvider[]> {
    if (actor.kind === 'staff') assertNeedSomewhere(actor, 'read');
    const qb = db('auth_providers as p').select('p.*');
    scopeOwned(actor, qb, 'p', { filterTenantId: q.tenantId ?? null });
    if (q.accountId) qb.where('p.account_id', q.accountId);
    return mapProviders(await qb.orderBy('p.name') as AuthProviderDbRow[]);
  },

  async get(actor: HostingActor, id: number): Promise<AuthProvider> {
    const row = await loadOwned(actor, 'auth_providers', id, 'read', 'Auth provider') as unknown as AuthProviderDbRow;
    return (await mapProviders([row]))[0];
  },

  async create(req: Request, actor: HostingActor, body: AuthProviderInput): Promise<AuthProvider> {
    const account = await loadAccount(actor, body.accountId, 'proxy.manage');
    if (!body.clientSecret) throw new AppError(400, 'The client secret is required', 'validation');
    let id: number;
    try {
      const [row] = await db('auth_providers').insert({
        tenant_id: account.tenant_id, account_id: account.id, name: body.name.trim(), kind: 'azure-ad',
        azure_tenant_id: body.azureTenantId, client_id: body.clientId.toLowerCase(),
        client_secret_sealed: seal('proxy-auth', body.clientSecret), cookie_secret_sealed: seal('proxy-auth', generateCookieSecret()),
        allowed_email_domains: JSON.stringify(uniq(body.allowedEmailDomains ?? [])), allowed_groups: JSON.stringify(uniq(body.allowedGroups ?? [])),
      }).returning('id') as Array<{ id: number }>;
      id = Number(row.id);
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
    await auditProxy(req, account.tenant_id, 'proxy.authProvider.create', 'auth_provider', id, { accountId: account.id, name: body.name, clientId: body.clientId });
    emitProxy('authProvider', id, { tenantId: account.tenant_id, accountId: account.id }, 'created');
    proxyDeps().authChanged(`auth provider ${id} created`);
    return this.get(actor, id);
  },

  async update(req: Request, actor: HostingActor, id: number, body: AuthProviderUpdate): Promise<AuthProvider> {
    const row = await loadOwned(actor, 'auth_providers', id, 'proxy.manage', 'Auth provider');
    const patch: Record<string, unknown> = { updated_at: db.fn.now() };
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.azureTenantId !== undefined) patch.azure_tenant_id = body.azureTenantId;
    if (body.clientId !== undefined) patch.client_id = body.clientId.toLowerCase();
    if (body.clientSecret) patch.client_secret_sealed = seal('proxy-auth', body.clientSecret);
    if (body.allowedEmailDomains !== undefined) patch.allowed_email_domains = JSON.stringify(uniq(body.allowedEmailDomains));
    if (body.allowedGroups !== undefined) patch.allowed_groups = JSON.stringify(uniq(body.allowedGroups));
    try {
      await db('auth_providers').where({ id, tenant_id: row.tenant_id }).update(patch);
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
    await auditProxy(req, Number(row.tenant_id), 'proxy.authProvider.update', 'auth_provider', id, {
      accountId: row.account_id, fields: Object.keys(body).filter((k) => k !== 'clientSecret'), secretChanged: !!body.clientSecret,
    });
    emitProxy('authProvider', id, { tenantId: Number(row.tenant_id), accountId: Number(row.account_id) }, 'updated');
    proxyDeps().authChanged(`auth provider ${id} updated`);
    return this.get(actor, id);
  },

  async remove(req: Request, actor: HostingActor, id: number): Promise<void> {
    const row = await loadOwned(actor, 'auth_providers', id, 'proxy.manage', 'Auth provider');
    // Under the account lock (like every host save, which re-checks its provider FOR SHARE in the same lock):
    // a host saved concurrently is either counted here or refused there — never an ON DELETE SET NULL that would
    // silently remove the forward-auth of a host.
    await db.transaction(async (trx) => {
      await lockAccount(trx, Number(row.account_id));
      await trx('auth_providers').where({ id }).forUpdate().first('id');
      const used = Number(((await trx('proxy_hosts').where({ auth_provider_id: id }).count('* as c').first()) as { c: unknown }).c);
      if (used > 0) throw new AppError(409, 'This provider protects proxy hosts', 'authProviderInUse', { usedBy: used });
      await trx('auth_providers').where({ id, tenant_id: row.tenant_id }).del();
    });
    await auditProxy(req, Number(row.tenant_id), 'proxy.authProvider.delete', 'auth_provider', id, { accountId: row.account_id });
    emitProxy('authProvider', id, { tenantId: Number(row.tenant_id), accountId: Number(row.account_id) }, 'deleted');
    proxyDeps().authChanged(`auth provider ${id} deleted`);
  },
};
