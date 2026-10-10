import type { Request } from 'express';
import type { AppRegistryCredential, AppRegistryCredentialInput, AppRegistryCredentialUpdate } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { open, seal } from '../../utils/secretBox';
import { auditService } from '../audit.service';
import { loadAccount, type HostingActor } from '../hosting/access';
import { loadOwned, scopeOwned } from '../hosting/p4bAccess';
import { toCredential, type CredentialRow } from './rows';

// Private registry credentials of an account (docs/P4b-PLAN.md §5.5). OWNED BY MODULE `apps-core`.
// Passwords sealed with secretBox('apps'), never returned, never logged nor audited (AP4).

export const REGISTRY_HOST_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/;
const DOCKER_HUB = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io', 'registry.hub.docker.com']);

/** Canonical registry host (docker.io for every Docker Hub alias). 400 when invalid. */
export function normalizeRegistry(raw: string): string {
  const r = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!REGISTRY_HOST_RE.test(r)) throw new AppError(400, 'Invalid registry host', 'validation');
  return DOCKER_HUB.has(r) ? 'docker.io' : r;
}

export interface RegistryAuth {
  registry: string;
  username: string;
  password: string;
}

/** Credentials linked to a stack (opened), by registry. Unreadable ones (rotated secret) are skipped. */
export async function stackRegistryAuths(stackId: number): Promise<Map<string, RegistryAuth>> {
  const rows = await db('app_stack_credentials as sc')
    .join('app_registry_credentials as c', function joinOn() { this.on('c.id', 'sc.credential_id').andOn('c.account_id', 'sc.account_id'); })
    .where('sc.stack_id', stackId)
    .select('c.registry', 'c.username', 'c.password_sealed') as Array<{ registry: string; username: string; password_sealed: string }>;
  const out = new Map<string, RegistryAuth>();
  for (const r of rows) {
    try {
      out.set(r.registry, { registry: r.registry, username: r.username, password: open('apps', r.password_sealed) });
    } catch { /* sealed with another SESSION_SECRET: ignored (re-enter the password) */ }
  }
  return out;
}

export const registryCredentialService = {
  async list(actor: HostingActor, q: { accountId?: number | null; tenantId?: number | null }): Promise<AppRegistryCredential[]> {
    const qb = db('app_registry_credentials as c').orderBy('c.id');
    scopeOwned(actor, qb, 'c', { filterTenantId: q.tenantId ?? null });
    if (q.accountId) qb.where('c.account_id', q.accountId);
    const rows = await qb.select('c.*') as CredentialRow[];
    return rows.map(toCredential);
  },

  async create(req: Request, actor: HostingActor, input: AppRegistryCredentialInput): Promise<AppRegistryCredential> {
    const account = await loadAccount(actor, input.accountId, 'apps.manage');
    const registry = normalizeRegistry(input.registry);
    const username = input.username.trim();
    if (!username || username.length > 255) throw new AppError(400, 'Invalid username', 'validation');
    if (!input.password || input.password.length > 4096) throw new AppError(400, 'Invalid password', 'validation');
    const exists = await db('app_registry_credentials').where({ account_id: account.id, registry, username }).first('id');
    if (exists) throw new AppError(409, 'These credentials already exist for this account', 'registryCredentialExists');
    const [row] = await db('app_registry_credentials').insert({
      tenant_id: account.tenant_id, account_id: account.id, registry, username, password_sealed: seal('apps', input.password),
    }).returning('*') as CredentialRow[];
    await auditService.logReqAs(req, account.tenant_id, 'apps.registry.create', {
      resourceType: 'account', resourcePath: String(account.id), details: { credentialId: row.id, registry, username },
    });
    return toCredential(row);
  },

  async update(req: Request, actor: HostingActor, id: number, input: AppRegistryCredentialUpdate): Promise<AppRegistryCredential> {
    const row = await loadOwned<CredentialRow & { account_id: number }>(actor, 'app_registry_credentials', id, 'apps.manage', 'Registry credential');
    const patch: Record<string, unknown> = { updated_at: db.fn.now() };
    if (input.username !== undefined) {
      const u = input.username.trim();
      if (!u || u.length > 255) throw new AppError(400, 'Invalid username', 'validation');
      const clash = await db('app_registry_credentials').where({ account_id: row.account_id, registry: row.registry, username: u }).whereNot({ id }).first('id');
      if (clash) throw new AppError(409, 'These credentials already exist for this account', 'registryCredentialExists');
      patch.username = u;
    }
    if (input.password !== undefined) {
      if (!input.password || input.password.length > 4096) throw new AppError(400, 'Invalid password', 'validation');
      patch.password_sealed = seal('apps', input.password);
    }
    const [updated] = await db('app_registry_credentials').where({ id }).update(patch).returning('*') as CredentialRow[];
    await auditService.logReqAs(req, row.tenant_id, 'apps.registry.update', {
      resourceType: 'account', resourcePath: String(row.account_id),
      details: { credentialId: id, username: input.username !== undefined ? patch.username : undefined, passwordChanged: input.password !== undefined },
    });
    return toCredential(updated);
  },

  async remove(req: Request, actor: HostingActor, id: number): Promise<{ deleted: true }> {
    const row = await loadOwned<CredentialRow & { account_id: number }>(actor, 'app_registry_credentials', id, 'apps.manage', 'Registry credential');
    await db('app_registry_credentials').where({ id }).delete();
    await auditService.logReqAs(req, row.tenant_id, 'apps.registry.delete', {
      resourceType: 'account', resourcePath: String(row.account_id), details: { credentialId: id, registry: row.registry, username: row.username },
    });
    return { deleted: true };
  },
};
