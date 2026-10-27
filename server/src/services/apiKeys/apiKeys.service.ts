import crypto from 'crypto';
import type { Request } from 'express';
import type { ApiKey, ApiKeyConnection, ApiKeyCreate, ApiKeyCreated, ApiKeyDomainScope, ApiKeyKind, ApiKeyScope, ApiKeySiteScope, ApiKeyUpdate, ClientCapability } from '@oblimint/shared';
import { API_KEY_SCOPES, MAX_API_KEYS_PER_ACCOUNT } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { cidrContains, normalizeCidr } from '../firewall/addresses';
import { actorCan, actorForUser, loadAccount, type HostingActor, type HostingNeed } from '../hosting/access';

// ─────────────────────────────────────────────────────────────────────────────
// API access keys of a hosting account (shared/src/apiKeys.ts).
//
// Key format: obk_<id>_<43 chars base64url (32 random bytes)>; only
// sha256(key) is stored, compared in constant time. verify() resolves a key
// into an ApiKeyContext:
//   - the creator's CURRENT actor on the key's tenant (actorForUser): a scope
//     the creator no longer holds is dropped; no read access at all = no key;
//   - a client-like actor limited to the key's account and to the
//     capabilities of its effective scopes — the services' own checks
//     (loadSite, loadAccount…) apply to it unchanged;
//   - the site restriction (siteScope 'selected' + api_key_sites), enforced
//     by the key API (routes/v1) on top of the services;
//   - the domains given to it (domainScope + api_key_domains created_by_key
//     false): with routes.manage, it routes them to its sites. A grant needs
//     domains.manage, and stops counting when the user no longer holds it.
// Managing the keys of an account needs sites.manage on it, and creating /
// widening a key needs every scope's right (no one hands out rights he lacks).
//
// A key of kind 'connector' (« Connecteur Claude ») has no bearer secret: it
// is an OAuth client (oauth.ts). Its access tokens (oba_…) resolve through
// verifyAccessToken() into the same context, acting for the panel user who
// authorized the connection instead of the creator.
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiKeyContext {
  id: number;
  name: string;
  tenantId: number;
  accountId: number;
  creatorId: number;
  scopes: ReadonlySet<ApiKeyScope>;
  siteScope: ApiKeySiteScope;
  siteIds: ReadonlySet<number>;
  domainScope: ApiKeyDomainScope;
  /** Domains given to the key (while its user holds domains.manage) and the subdomains it created. */
  domainIds: ReadonlySet<number>;
  /** Actor the services check (client-like, this account only). */
  actor: HostingActor;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by apiKeyAuth (/api/v1, /mcp). */
    apiKey?: ApiKeyContext;
  }
}

/** Right the creator must hold for each scope. */
export const SCOPE_NEED: Record<ApiKeyScope, HostingNeed> = {
  'files.read': 'files.manage',
  'files.write': 'files.manage',
  'releases.publish': 'releases.publish',
  'sites.manage': 'sites.manage',
  'sites.create': 'sites.manage',
  'logs.read': 'read',
  'domains.subdomain': 'domains.manage',
  'cron.manage': 'sites.manage',
  'databases.manage': 'databases.manage',
  'routes.manage': 'domains.manage',
};

/** Client capability each scope gives the key's actor. */
const SCOPE_CAP: Record<ApiKeyScope, ClientCapability | null> = {
  'files.read': 'files.manage',
  'files.write': 'files.manage',
  'releases.publish': 'releases.publish',
  'sites.manage': 'sites.manage',
  'sites.create': 'sites.manage',
  'logs.read': null,
  'domains.subdomain': 'domains.manage',
  'cron.manage': 'sites.manage',
  'databases.manage': 'databases.manage',
  'routes.manage': 'domains.manage',
};

const KEY_RE = /^obk_([1-9]\d{0,9})_([A-Za-z0-9_-]{43})$/;
const MIN_TTL_MS = 60 * 60 * 1000;
const LAST_USED_EVERY_MS = 60_000;
const MAX_ALLOWED_IPS = 32;

export function hashKey(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function generateKey(id: number): { key: string; hash: string; prefix: string } {
  const secret = crypto.randomBytes(32).toString('base64url');
  const key = `obk_${id}_${secret}`;
  return { key, hash: hashKey(key), prefix: `obk_${id}_${secret.slice(0, 6)}` };
}

export function parseKey(raw: unknown): number | null {
  const m = KEY_RE.exec(typeof raw === 'string' ? raw : '');
  return m ? Number(m[1]) : null;
}

function keyMatches(raw: string, storedHash: string): boolean {
  const valid = typeof storedHash === 'string' && /^[0-9a-f]{64}$/.test(storedHash);
  const a = Buffer.from(hashKey(raw), 'hex');
  const b = Buffer.from(valid ? storedHash : '0'.repeat(64), 'hex');
  return crypto.timingSafeEqual(a, b) && valid;
}

interface KeyRow {
  id: number; tenant_id: number; account_id: number; kind: ApiKeyKind; oauth_client_id: string | null; name: string; token_hash: string; prefix: string;
  scopes: unknown; site_scope: ApiKeySiteScope; domain_scope?: ApiKeyDomainScope; allowed_ips: unknown; created_by: number | null;
  last_used_at: Date | string | null; last_used_ip: string | null; expires_at: Date | string | null;
  created_at: Date | string; updated_at: Date | string;
  /** joined */ created_by_name?: string | null;
}

const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

function jsonArray(raw: unknown): unknown[] {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = []; } }
  return Array.isArray(v) ? v : [];
}

export function scopesOf(raw: unknown): ApiKeyScope[] {
  return jsonArray(raw).filter((s): s is ApiKeyScope => (API_KEY_SCOPES as readonly unknown[]).includes(s));
}

const ipsOf = (raw: unknown): string[] => jsonArray(raw).filter((s): s is string => typeof s === 'string');

/** Scopes the actor holds on the account. */
function heldScopes(actor: HostingActor, target: { tenantId: number; accountId: number }, scopes: ApiKeyScope[]): ApiKeyScope[] {
  return scopes.filter((s) => actorCan(actor, SCOPE_NEED[s], target));
}

async function siteRows(keyIds: number[]): Promise<Array<{ key_id: number; site_id: number; created_by_key: boolean }>> {
  if (!keyIds.length) return [];
  return db('api_key_sites').whereIn('key_id', keyIds).select('key_id', 'site_id', 'created_by_key');
}

async function domainRows(keyIds: number[]): Promise<Array<{ key_id: number; domain_id: number; created_by_key: boolean }>> {
  if (!keyIds.length) return [];
  return db('api_key_domains').whereIn('key_id', keyIds).select('key_id', 'domain_id', 'created_by_key');
}

/** Live authorizations of connectors: one per family holding an unexpired, unused refresh token. */
async function connectionRows(keyIds: number[]): Promise<Array<ApiKeyConnection & { key_id: number }>> {
  if (!keyIds.length) return [];
  const rows = await db('api_key_oauth_tokens as t')
    .leftJoin('users as u', 'u.id', 't.user_id')
    .whereIn('t.key_id', keyIds).where('t.kind', 'refresh').whereNull('t.used_at').where('t.expires_at', '>', db.fn.now())
    .select('t.key_id', 't.family', db.raw('COALESCE(u.display_name, u.username) as user_name'),
      db.raw('(SELECT MIN(f.created_at) FROM api_key_oauth_tokens f WHERE f.family = t.family) AS connected_at'),
      db.raw("(SELECT MAX(f.created_at) FROM api_key_oauth_tokens f WHERE f.family = t.family AND f.kind = 'access') AS last_used_at")) as
    Array<{ key_id: number; family: string; user_name: string | null; connected_at: Date | string; last_used_at: Date | string | null }>;
  return rows.map((r) => ({ key_id: r.key_id, id: r.family, userName: r.user_name, connectedAt: iso(r.connected_at) as string, lastUsedAt: iso(r.last_used_at) }));
}

async function toApiKeys(rows: KeyRow[]): Promise<ApiKey[]> {
  const sites = await siteRows(rows.map((r) => r.id));
  const doms = await domainRows(rows.map((r) => r.id));
  const connections = await connectionRows(rows.filter((r) => r.kind === 'connector').map((r) => r.id));
  const out: ApiKey[] = [];
  for (const r of rows) {
    const scopes = scopesOf(r.scopes);
    let inactive: ApiKeyScope[] = scopes;
    if (r.created_by) {
      try {
        const creator = await actorForUser(r.created_by, r.tenant_id);
        const held = new Set(heldScopes(creator, { tenantId: r.tenant_id, accountId: r.account_id }, scopes));
        inactive = scopes.filter((s) => !held.has(s));
      } catch { /* creator gone: every scope inactive */ }
    }
    const mine = sites.filter((s) => s.key_id === r.id);
    const myDoms = doms.filter((d) => d.key_id === r.id);
    out.push({
      id: r.id, accountId: r.account_id, kind: r.kind ?? 'key', name: r.name, prefix: r.prefix, scopes, siteScope: r.site_scope,
      siteIds: mine.map((s) => s.site_id).sort((a, b) => a - b),
      createdSiteIds: mine.filter((s) => s.created_by_key).map((s) => s.site_id).sort((a, b) => a - b),
      domainScope: r.domain_scope ?? 'selected',
      domainIds: myDoms.filter((d) => !d.created_by_key).map((d) => d.domain_id).sort((a, b) => a - b),
      createdDomainIds: myDoms.filter((d) => d.created_by_key).map((d) => d.domain_id).sort((a, b) => a - b),
      allowedIps: ipsOf(r.allowed_ips), createdByName: r.created_by_name ?? null, createdAt: iso(r.created_at) as string,
      lastUsedAt: iso(r.last_used_at), lastUsedIp: r.last_used_ip, expiresAt: iso(r.expires_at), inactiveScopes: inactive,
      oauthClientId: r.kind === 'connector' ? r.oauth_client_id : null,
      connections: connections.filter((c) => c.key_id === r.id).map(({ key_id: _k, ...c }) => c).sort((a, b) => a.connectedAt.localeCompare(b.connectedAt)),
    });
  }
  return out;
}

function keyQuery() {
  return db('api_keys as k').leftJoin('users as u', 'u.id', 'k.created_by').select('k.*', db.raw('COALESCE(u.display_name, u.username) as created_by_name'));
}

interface Normalized {
  name?: string;
  scopes?: ApiKeyScope[];
  siteScope?: ApiKeySiteScope;
  siteIds?: number[];
  domainScope?: ApiKeyDomainScope;
  domainIds?: number[];
  allowedIps?: string[];
  expiresAt?: Date | null;
}

async function normalize(actor: HostingActor, account: { id: number; tenant_id: number }, body: ApiKeyUpdate, creating: boolean): Promise<Normalized> {
  const out: Normalized = {};
  if (body.name !== undefined || creating) {
    const name = String(body.name ?? '').trim().slice(0, 100);
    if (!name) throw new AppError(400, 'A key needs a name', 'validation');
    out.name = name;
  }
  if (body.scopes !== undefined || creating) {
    const scopes = [...new Set(body.scopes ?? [])];
    if (scopes.some((s) => !(API_KEY_SCOPES as readonly string[]).includes(s))) throw new AppError(400, 'Unknown scope', 'validation');
    const missing = scopes.filter((s) => !actorCan(actor, SCOPE_NEED[s], { tenantId: account.tenant_id, accountId: account.id }));
    if (missing.length) throw new AppError(403, `You cannot grant rights you do not hold (${missing.join(', ')})`, 'capabilityNotHeld', { missing });
    out.scopes = API_KEY_SCOPES.filter((s) => scopes.includes(s));
  }
  if (body.siteScope !== undefined || creating) {
    if (body.siteScope !== 'all' && body.siteScope !== 'selected') throw new AppError(400, 'siteScope is all or selected', 'validation');
    out.siteScope = body.siteScope;
  }
  if (body.siteIds !== undefined) {
    const ids = [...new Set(body.siteIds.map(Number))];
    if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new AppError(400, 'Invalid site id', 'validation');
    if (ids.length) {
      const found = await db('sites').where({ account_id: account.id }).whereIn('id', ids).pluck('id') as number[];
      if (found.length !== ids.length) throw new AppError(400, 'A selected site does not belong to the account', 'validation');
    }
    out.siteIds = ids;
  }
  if (body.domainScope !== undefined) {
    if (body.domainScope !== 'all' && body.domainScope !== 'selected') throw new AppError(400, 'domainScope is all or selected', 'validation');
    out.domainScope = body.domainScope;
  }
  if (body.domainIds !== undefined) {
    const ids = [...new Set(body.domainIds.map(Number))];
    if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new AppError(400, 'Invalid domain id', 'validation');
    if (ids.length) {
      const found = await db('domains').where({ account_id: account.id }).whereIn('id', ids).pluck('id') as number[];
      if (found.length !== ids.length) throw new AppError(400, 'A selected domain does not belong to the account', 'validation');
    }
    out.domainIds = ids;
  }
  if ((out.domainScope === 'all' || (out.domainIds?.length ?? 0) > 0)
    && !actorCan(actor, 'domains.manage', { tenantId: account.tenant_id, accountId: account.id })) {
    throw new AppError(403, 'Giving domains to a key needs the domain management right', 'capabilityNotHeld', { missing: ['domains.manage'] });
  }
  if (body.allowedIps !== undefined) {
    if (body.allowedIps.length > MAX_ALLOWED_IPS) throw new AppError(400, `At most ${MAX_ALLOWED_IPS} addresses`, 'validation');
    out.allowedIps = [...new Set(body.allowedIps.map((ip) => normalizeCidr(String(ip).trim(), { 4: 8, 6: 16 }).cidr))];
  }
  if (body.expiresAt !== undefined) {
    if (body.expiresAt === null || body.expiresAt === '') out.expiresAt = null;
    else {
      const d = new Date(body.expiresAt);
      if (Number.isNaN(d.getTime()) || d.getTime() < Date.now() + MIN_TTL_MS) throw new AppError(400, 'A key expires at least one hour from now', 'validation');
      out.expiresAt = d;
    }
  }
  return out;
}

export const apiKeysService = {
  async list(actor: HostingActor, accountId: number): Promise<ApiKey[]> {
    const account = await loadAccount(actor, accountId, 'sites.manage');
    return toApiKeys(await keyQuery().where('k.account_id', account.id).orderBy('k.id') as KeyRow[]);
  },

  async create(req: Request, actor: HostingActor, accountId: number, body: ApiKeyCreate): Promise<ApiKeyCreated> {
    const account = await loadAccount(actor, accountId, 'sites.manage');
    if (account.status === 'deleting') throw new AppError(409, 'The account is being deleted', 'accountDeleting');
    if (body.kind !== undefined && body.kind !== 'key' && body.kind !== 'connector') throw new AppError(400, 'kind is key or connector', 'validation');
    const kind: ApiKeyKind = body.kind === 'connector' ? 'connector' : 'key';
    const n = await normalize(actor, account, body, true);
    const created = await db.transaction(async (trx) => {
      await trx('hosting_accounts').where({ id: account.id }).forUpdate().first('id');
      const count = await trx('api_keys').where({ account_id: account.id }).count<{ n: string }[]>('* as n');
      if (Number(count[0]?.n ?? 0) >= MAX_API_KEYS_PER_ACCOUNT) {
        throw new AppError(409, `At most ${MAX_API_KEYS_PER_ACCOUNT} keys per account`, 'keyLimit', { max: MAX_API_KEYS_PER_ACCOUNT });
      }
      if (await trx('api_keys').where({ account_id: account.id, name: n.name }).first('id')) {
        throw new AppError(409, 'A key of this account already has this name', 'keyNameTaken');
      }
      const client = kind === 'connector' ? generateClient() : null;
      const [row] = await trx('api_keys').insert({
        tenant_id: account.tenant_id, account_id: account.id, name: n.name, kind,
        oauth_client_id: client?.clientId ?? null, oauth_secret_hash: client?.secretHash ?? null,
        token_hash: hashKey(crypto.randomBytes(32).toString('hex')), prefix: client ? client.clientId.slice(0, 32) : 'obk_',
        scopes: JSON.stringify(n.scopes ?? []), site_scope: n.siteScope ?? 'selected', domain_scope: n.domainScope ?? 'selected',
        allowed_ips: JSON.stringify(n.allowedIps ?? []), created_by: actor.userId, expires_at: n.expiresAt ?? null,
      }).returning('id');
      const id = Number(typeof row === 'object' ? row.id : row);
      // A connector keeps its unusable random token_hash: it never works as a bearer key.
      const g = client ? null : generateKey(id);
      if (g) await trx('api_keys').where({ id }).update({ token_hash: g.hash, prefix: g.prefix });
      if (n.siteIds?.length) await trx('api_key_sites').insert(n.siteIds.map((s) => ({ key_id: id, account_id: account.id, site_id: s })));
      if (n.domainIds?.length) await trx('api_key_domains').insert(n.domainIds.map((d) => ({ key_id: id, account_id: account.id, domain_id: d, created_by_key: false })));
      return { id, key: g?.key ?? null, clientSecret: client?.secret ?? null };
    });
    await auditService.logReqAs(req, account.tenant_id, 'apiKey.create', {
      resourceType: 'account', resourcePath: String(account.id),
      details: { keyId: created.id, kind, name: n.name, scopes: n.scopes, siteScope: n.siteScope, siteIds: n.siteIds ?? [], domainScope: n.domainScope ?? 'selected', domainIds: n.domainIds ?? [], allowedIps: n.allowedIps ?? [], expiresAt: n.expiresAt?.toISOString() ?? null },
    });
    const [key] = await toApiKeys(await keyQuery().where('k.id', created.id) as KeyRow[]);
    return { ...key, key: created.key, clientSecret: created.clientSecret };
  },

  /** Connector: new client secret (the old one stops at once; live connections stay). */
  async rotateSecret(req: Request, actor: HostingActor, accountId: number, keyId: number): Promise<ApiKeyCreated> {
    const account = await loadAccount(actor, accountId, 'sites.manage');
    const row = await db('api_keys').where({ id: keyId, account_id: account.id, kind: 'connector' }).first('id', 'name') as { id: number; name: string } | undefined;
    if (!row) throw new AppError(404, 'Connector not found', 'notFound');
    const secret = generateClientSecret();
    await db('api_keys').where({ id: row.id }).update({ oauth_secret_hash: hashKey(secret), updated_at: db.fn.now() });
    await auditService.logReqAs(req, account.tenant_id, 'apiKey.rotateSecret', { resourceType: 'account', resourcePath: String(account.id), details: { keyId: row.id, name: row.name } });
    const [key] = await toApiKeys(await keyQuery().where('k.id', row.id) as KeyRow[]);
    return { ...key, key: null, clientSecret: secret };
  },

  /** Connector: ends one authorization (family) or all of them; the client must authorize again. */
  async disconnect(req: Request, actor: HostingActor, accountId: number, keyId: number, family: string | null): Promise<number> {
    const account = await loadAccount(actor, accountId, 'sites.manage');
    const row = await db('api_keys').where({ id: keyId, account_id: account.id, kind: 'connector' }).first('id', 'name') as { id: number; name: string } | undefined;
    if (!row) throw new AppError(404, 'Connector not found', 'notFound');
    const q = db('api_key_oauth_tokens').where({ key_id: row.id });
    if (family) q.andWhere({ family });
    const n = Number(await q.del());
    await auditService.logReqAs(req, account.tenant_id, 'apiKey.disconnect', { resourceType: 'account', resourcePath: String(account.id), details: { keyId: row.id, name: row.name, family, tokens: n } });
    return n;
  },

  async update(req: Request, actor: HostingActor, accountId: number, keyId: number, body: ApiKeyUpdate): Promise<ApiKey> {
    const account = await loadAccount(actor, accountId, 'sites.manage');
    const row = await db('api_keys').where({ id: keyId, account_id: account.id }).first('id') as { id: number } | undefined;
    if (!row) throw new AppError(404, 'Key not found', 'notFound');
    const n = await normalize(actor, account, body, false);
    await db.transaction(async (trx) => {
      const patch: Record<string, unknown> = { updated_at: trx.fn.now() };
      if (n.name !== undefined) {
        if (await trx('api_keys').where({ account_id: account.id, name: n.name }).whereNot({ id: row.id }).first('id')) {
          throw new AppError(409, 'A key of this account already has this name', 'keyNameTaken');
        }
        patch.name = n.name;
      }
      if (n.scopes !== undefined) patch.scopes = JSON.stringify(n.scopes);
      if (n.siteScope !== undefined) patch.site_scope = n.siteScope;
      if (n.domainScope !== undefined) patch.domain_scope = n.domainScope;
      if (n.allowedIps !== undefined) patch.allowed_ips = JSON.stringify(n.allowedIps);
      if (n.expiresAt !== undefined) patch.expires_at = n.expiresAt;
      await trx('api_keys').where({ id: row.id }).update(patch);
      if (n.siteIds !== undefined) {
        // The sites the key created stay in its selection.
        await trx('api_key_sites').where({ key_id: row.id, created_by_key: false }).whereNotIn('site_id', n.siteIds).del();
        const have = new Set(await trx('api_key_sites').where({ key_id: row.id }).pluck('site_id') as number[]);
        const add = n.siteIds.filter((s) => !have.has(s));
        if (add.length) await trx('api_key_sites').insert(add.map((s) => ({ key_id: row.id, account_id: account.id, site_id: s })));
      }
      if (n.domainIds !== undefined) {
        // The subdomains the key created stay its own; a given domain it created is never downgraded.
        await trx('api_key_domains').where({ key_id: row.id, created_by_key: false }).whereNotIn('domain_id', n.domainIds).del();
        const haveDoms = new Set(await trx('api_key_domains').where({ key_id: row.id }).pluck('domain_id') as number[]);
        const addDoms = n.domainIds.filter((d) => !haveDoms.has(d));
        if (addDoms.length) await trx('api_key_domains').insert(addDoms.map((d) => ({ key_id: row.id, account_id: account.id, domain_id: d, created_by_key: false })));
      }
    });
    await auditService.logReqAs(req, account.tenant_id, 'apiKey.update', {
      resourceType: 'account', resourcePath: String(account.id),
      details: { keyId: row.id, ...Object.fromEntries(Object.entries(n).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])) },
    });
    const [key] = await toApiKeys(await keyQuery().where('k.id', row.id) as KeyRow[]);
    return key;
  },

  async remove(req: Request, actor: HostingActor, accountId: number, keyId: number): Promise<void> {
    const account = await loadAccount(actor, accountId, 'sites.manage');
    const row = await db('api_keys').where({ id: keyId, account_id: account.id }).first('id', 'name') as { id: number; name: string } | undefined;
    if (!row) throw new AppError(404, 'Key not found', 'notFound');
    await db('api_keys').where({ id: row.id }).del();
    await auditService.logReqAs(req, account.tenant_id, 'apiKey.delete', {
      resourceType: 'account', resourcePath: String(account.id), details: { keyId: row.id, name: row.name },
    });
  },

  /**
   * Resolves a raw key (null: unknown / bad format / expired / address not
   * allowed / account being deleted / creator without any right left).
   */
  async verify(raw: string, ip: string): Promise<ApiKeyContext | null> {
    const id = parseKey(raw);
    if (id === null) return null;
    const row = await keyWithAccount().where('k.id', id).first() as KeyWithAccount | undefined;
    const ok = keyMatches(raw, row?.token_hash ?? ''); // same work whatever the id
    if (!row || !ok || row.kind === 'connector') return null;
    if (!row.created_by) return null;
    return contextFor(row, row.created_by, ip);
  },

  /** Resolves an OAuth access token of a connector (oba_…), acting for the user who authorized it. */
  async verifyAccessToken(raw: string, ip: string): Promise<ApiKeyContext | null> {
    if (!ACCESS_TOKEN_RE.test(raw)) return null;
    const tok = await db('api_key_oauth_tokens').where({ token_hash: hashKey(raw), kind: 'access' }).first('key_id', 'user_id', 'expires_at') as
      { key_id: number; user_id: number; expires_at: Date | string } | undefined;
    if (!tok || new Date(tok.expires_at).getTime() <= Date.now()) return null;
    const row = await keyWithAccount().where('k.id', tok.key_id).first() as KeyWithAccount | undefined;
    if (!row || row.kind !== 'connector') return null;
    return contextFor(row, tok.user_id, ip);
  },

  /** A site created through the key joins its selection. */
  async recordCreatedSite(ctx: ApiKeyContext, siteId: number): Promise<void> {
    await db('api_key_sites').insert({ key_id: ctx.id, account_id: ctx.accountId, site_id: siteId, created_by_key: true })
      .onConflict(['key_id', 'site_id']).merge({ created_by_key: true });
  },
};

/** OAuth access token of a connector: oba_<43 chars base64url>. */
export const ACCESS_TOKEN_RE = /^oba_[A-Za-z0-9_-]{43}$/;

type KeyWithAccount = KeyRow & { account_status: string };

function keyWithAccount() {
  return db('api_keys as k')
    .join('hosting_accounts as a', function joinAccount() { this.on('a.id', '=', 'k.account_id').andOn('a.tenant_id', '=', 'k.tenant_id'); })
    .select('k.*', 'a.status as account_status');
}

/**
 * Context of a key (or connector) acting for `userId` (the creator of a key,
 * the authorizing user of a connector): expiry, account, allowed addresses,
 * the user's CURRENT rights on the account (scopes he no longer holds drop).
 */
async function contextFor(row: KeyWithAccount, userId: number, ip: string): Promise<ApiKeyContext | null> {
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;
  if (row.account_status === 'deleting') return null;
  const ips = ipsOf(row.allowed_ips);
  if (ips.length && !ips.some((c) => cidrContains(c, ip))) return null;
  let user: HostingActor;
  try { user = await actorForUser(userId, row.tenant_id); } catch { return null; }
  const target = { tenantId: row.tenant_id, accountId: row.account_id };
  if (!actorCan(user, 'read', target)) return null;
  const scopes = heldScopes(user, target, scopesOf(row.scopes));
  const caps = new Set<ClientCapability>();
  for (const s of scopes) { const c = SCOPE_CAP[s]; if (c) caps.add(c); }
  const sites = await db('api_key_sites').where({ key_id: row.id }).pluck('site_id') as number[];
  // Domains: the subdomains it created always; the given ones while the user may manage domains.
  const domainManager = actorCan(user, 'domains.manage', target);
  const doms = await db('api_key_domains').where({ key_id: row.id }).select('domain_id', 'created_by_key') as Array<{ domain_id: number; created_by_key: boolean }>;
  const domainIds = doms.filter((d) => d.created_by_key || domainManager).map((d) => Number(d.domain_id));
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > LAST_USED_EVERY_MS || row.last_used_ip !== ip) {
    db('api_keys').where({ id: row.id }).update({ last_used_at: db.fn.now(), last_used_ip: ip.slice(0, 64) })
      .catch((err: unknown) => logger.warn({ err, keyId: row.id }, 'API key: last use not recorded'));
  }
  return {
    id: row.id, name: row.name, tenantId: row.tenant_id, accountId: row.account_id, creatorId: userId,
    scopes: new Set(scopes), siteScope: row.site_scope, siteIds: new Set(sites.map(Number)),
    domainScope: domainManager && row.domain_scope === 'all' ? 'all' : 'selected', domainIds: new Set(domainIds),
    actor: { kind: 'client', userId, tenantId: row.tenant_id, accounts: new Map([[row.account_id, caps]]) },
  };
}

/** Scopes of a connector `userId` holds / lacks on its account (consent page); null: no access to the account. */
export async function scopesHeldBy(userId: number, key: { tenant_id: number; account_id: number; scopes: unknown }): Promise<{ held: ApiKeyScope[]; missing: ApiKeyScope[] } | null> {
  let user: HostingActor;
  try { user = await actorForUser(userId, key.tenant_id); } catch { return null; }
  const target = { tenantId: key.tenant_id, accountId: key.account_id };
  if (!actorCan(user, 'read', target)) return null;
  const all = scopesOf(key.scopes);
  const held = heldScopes(user, target, all);
  return { held, missing: all.filter((s) => !held.includes(s)) };
}

/** Connector client id (public) + secret (shown once, sha256 stored). */
export function generateClient(): { clientId: string; secret: string; secretHash: string } {
  const secret = generateClientSecret();
  return { clientId: `oblimint-${crypto.randomBytes(12).toString('base64url')}`, secret, secretHash: hashKey(secret) };
}

export function generateClientSecret(): string {
  return `obs_${crypto.randomBytes(32).toString('base64url')}`;
}

/** Constant-time check of a connector's client secret. */
export function clientSecretMatches(raw: string, storedHash: string | null): boolean {
  return keyMatches(raw, storedHash ?? '');
}

/** A domain given to the key (or a subdomain it created). */
export function keyAllowsDomain(ctx: ApiKeyContext, domainId: number): boolean {
  return ctx.domainScope === 'all' || ctx.domainIds.has(domainId);
}

export function keyAllowsSite(ctx: ApiKeyContext, siteId: number): boolean {
  return ctx.siteScope === 'all' || ctx.siteIds.has(siteId);
}

export function requireScope(ctx: ApiKeyContext, scope: ApiKeyScope): void {
  if (!ctx.scopes.has(scope)) throw new AppError(403, `This key does not have the ${scope} scope`, 'keyScope', { scope });
}
