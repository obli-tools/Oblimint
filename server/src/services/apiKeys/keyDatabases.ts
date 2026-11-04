import crypto from 'crypto';
import type { Request, Response } from 'express';
import type { Readable } from 'stream';
import type {
  ApiV1Database, ApiV1DbCredentials, ApiV1DbEnvTarget, ApiV1DbInstance, ApiV1DbQueryResult, ApiV1DbUser, ApiV1SiteDatabase, DbAttachGrant,
  DbAttachmentResult, DbCatalog, DbDatabase, DbEngine, DbFamily, DbGrantInput, DbInstance, DbSiteRef, DbUser, DbxTable, DbxTableInfo,
} from '@oblimint/shared';
import { dbFamilyOf } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { auditService } from '../audit.service';
import { databasesAttachedTo, databasesOfSites, sitesOfDatabases } from '../databases/attachments';
import { databaseService, loadDatabaseRow, loadInstance } from '../databases/databases.service';
import { createAttachParams, siteCreateTarget, siteDatabaseService } from '../databases/siteDatabases.service';
import { auditSql, explorerService } from '../databases/explorer/explorer.service';
import type { DbDatabaseRow, DbInstanceRow } from '../databases/rows';
import { keyAllowsSite, requireScope, type ApiKeyContext } from './apiKeys.service';
import { keyApi, keySite, type SiteArea } from './keyApi';
import { keyEnv } from './keyEnv';
import { actionLevel, type GateSpec } from '../restrictions/gate';
import { spoolHashed } from '../restrictions/content';
import { classifySql } from '../restrictions/sqlClass';
import { splitStatements } from '../databases/explorer/sqlStream';
import { asKeyRequest, keyGated, siteTarget } from '../restrictions/targets';

// ─────────────────────────────────────────────────────────────────────────────
// Databases through an API key (scope databases.manage), on top of the
// databases service (its own checks, plan limits and audit apply):
//   - instances: every database server of the account; a key may create one
//     (plan limits), never stop, reconfigure nor delete one;
//   - databases / users: a key on every site (siteScope 'all') reaches all of
//     the account's; a key limited to some sites only the ones it created
//     (api_key_db_objects) and the databases owned by / shared with its sites
//     (migration 030 site_databases) — so it never reads another site's data;
//     the other sites of the account stay hidden in the owner / shared lists;
//   - attachments (owner site, sharing): db.attach / db.share gated on the
//     sites concerned (a database created owned by a site: db.attach); a key
//     limited to some sites never takes a database from a site outside its
//     selection, never shares one owned outside it, nor makes one shared
//     across the account;
//   - a grant only on a database the key reaches; deletion only of what the
//     key created;
//   - credentials of a new user (or a reset) may go straight into a site's
//     environment variables (sites.manage) instead of back to the caller.
// ─────────────────────────────────────────────────────────────────────────────

type ObjKind = 'database' | 'user';

const notFound = (what: string) => new AppError(404, `${what} not found`, 'notFound');
const ENV_PREFIX_RE = /^[A-Z][A-Z0-9_]{0,31}$/;

async function created(ctx: ApiKeyContext, kind: ObjKind): Promise<Set<number>> {
  return new Set((await db('api_key_db_objects').where({ key_id: ctx.id, kind }).pluck('object_id') as number[]).map(Number));
}

async function record(ctx: ApiKeyContext, kind: ObjKind, id: number): Promise<void> {
  await db('api_key_db_objects').insert({ key_id: ctx.id, kind, object_id: id, account_id: ctx.accountId }).onConflict(['key_id', 'kind', 'object_id']).ignore();
}

/** A database object made for this key by another service (application installer): within its reach, deletable by it. */
export const recordKeyDbObject = record;

const reaches = (ctx: ApiKeyContext, own: Set<number>, id: number) => ctx.siteScope === 'all' || own.has(id);

/**
 * The databases a key limited to some sites reaches: the ones it created, and
 * (migration 030) the ones owned by / shared with its sites. A key on every
 * site reaches them all (`reaches`).
 */
export async function keyReachableDatabases(ctx: ApiKeyContext): Promise<Set<number>> {
  const own = await created(ctx, 'database');
  if (ctx.siteScope === 'all') return own;
  for (const id of await databasesAttachedTo(ctx.siteIds, ctx.accountId)) own.add(id);
  return own;
}

/** A key limited to some sites never sees the other sites of the account (names): out of its selection = hidden. */
function maskSites<T extends { ownerSite?: DbSiteRef | null; sharedSites?: DbSiteRef[] }>(ctx: ApiKeyContext, d: T): T & { ownedElsewhere?: boolean } {
  if (ctx.siteScope === 'all') return d;
  const owner = d.ownerSite ?? null;
  const outside = !!owner && !keyAllowsSite(ctx, owner.id);
  return {
    ...d,
    ownerSite: outside ? null : owner,
    sharedSites: (d.sharedSites ?? []).filter((s) => keyAllowsSite(ctx, s.id)),
    ...(outside ? { ownedElsewhere: true } : {}),
  };
}

function maskResult(ctx: ApiKeyContext, r: DbAttachmentResult): DbAttachmentResult {
  return {
    ...r,
    database: maskSites(ctx, r.database),
    network: ctx.siteScope === 'all' ? r.network : r.network.filter((n) => keyAllowsSite(ctx, n.siteId)),
  };
}

/** An instance of the key's account (404 otherwise). */
async function keyInstance(ctx: ApiKeyContext, id: number): Promise<DbInstanceRow> {
  requireScope(ctx, 'databases.manage');
  if (!Number.isInteger(id) || id <= 0) throw notFound('Database instance');
  const row = await loadInstance(ctx.actor, id, 'read');
  if (row.account_id !== ctx.accountId) throw notFound('Database instance');
  return row;
}

async function databaseOf(ctx: ApiKeyContext, instanceId: number, dbId: number): Promise<{ id: number; name: string }> {
  const row = await db('db_databases').where({ id: dbId, instance_id: instanceId, account_id: ctx.accountId }).first('id', 'name') as { id: number; name: string } | undefined;
  if (!row || !reaches(ctx, await keyReachableDatabases(ctx), row.id)) throw notFound('Database');
  return row;
}

/**
 * The SQL explorer through a key: databases.manage on the instance for the key's
 * user (as in the panel) and the database within the key's reach. The key gets
 * its own explorer session (ephemeral SQL user, that database only).
 */
async function explorerTarget(ctx: ApiKeyContext, instanceId: number, dbId: number): Promise<{ instance: DbInstanceRow; database: DbDatabaseRow }> {
  await keyInstance(ctx, instanceId);
  const instance = await loadInstance(ctx.actor, instanceId, 'databases.manage');
  const reached = await databaseOf(ctx, instance.id, dbId);
  return { instance, database: await loadDatabaseRow(instance, reached.id) };
}

const keyOwner = (ctx: ApiKeyContext): `k${number}` => `k${ctx.id}`;

async function userOf(ctx: ApiKeyContext, instanceId: number, userId: number): Promise<{ id: number; username: string }> {
  const row = await db('db_users').where({ id: userId, instance_id: instanceId, account_id: ctx.accountId }).first('id', 'username') as { id: number; username: string } | undefined;
  if (!row || !reaches(ctx, await created(ctx, 'user'), row.id)) throw notFound('Database user');
  return row;
}

async function assertGrants(ctx: ApiKeyContext, instanceId: number, grants: DbGrantInput[] | undefined): Promise<void> {
  for (const g of grants ?? []) await databaseOf(ctx, instanceId, g.databaseId);
}

function viewUser(u: DbUser, own: Set<number>): ApiV1DbUser {
  return { ...u, createdByKey: own.has(u.id) };
}

async function instanceView(ctx: ApiKeyContext, id: number): Promise<ApiV1DbInstance> {
  const d = await databaseService.getInstance(ctx.actor, id);
  const [ownDb, ownUser, reach] = await Promise.all([created(ctx, 'database'), created(ctx, 'user'), keyReachableDatabases(ctx)]);
  return {
    id: d.id, name: d.name, engine: d.engine, version: d.version, family: d.family, status: d.status, isDefault: d.isDefault,
    connection: d.connection,
    databases: d.databases.filter((x) => reaches(ctx, reach, x.id)).map((x): ApiV1Database => maskSites(ctx, { ...x, createdByKey: ownDb.has(x.id) })),
    users: d.users.filter((u) => reaches(ctx, ownUser, u.id)).map((u) => viewUser(u, ownUser)),
  };
}

/** The credentials into a site's environment (DB_HOST, DB_SOCKET, DB_NAME, DB_USER, DB_PASSWORD). */
async function credentialsToEnv(ctx: ApiKeyContext, req: Request, inst: ApiV1DbInstance, user: DbUser, password: string, target: ApiV1DbEnvTarget): Promise<string[]> {
  const prefix = target.prefix ?? 'DB_';
  if (!ENV_PREFIX_RE.test(prefix)) throw new AppError(400, 'Prefix: upper-case letters, digits and _', 'validation', { field: 'prefix' });
  const dbId = target.databaseId ?? user.grants[0]?.databaseId;
  const database = dbId ? await databaseOf(ctx, inst.id, dbId) : null;
  const socket = inst.connection.socketPath;
  // Sites reach the default MySQL-family instance as localhost; any other through its socket
  // (PostgreSQL: the socket directory is the host).
  const host = inst.family === 'postgresql' ? socket.replace(/\/[^/]+$/, '') : 'localhost';
  const vars = [
    { name: `${prefix}HOST`, value: host, secret: false },
    { name: `${prefix}SOCKET`, value: socket, secret: false },
    ...(database ? [{ name: `${prefix}NAME`, value: database.name, secret: false }] : []),
    { name: `${prefix}USER`, value: user.username, secret: false },
    { name: `${prefix}PASSWORD`, value: password, secret: true },
  ];
  // Gated before the user / password was made (envGate): written as is here.
  await keyEnv.apply(ctx, req, await keyEnv.prepare(ctx, target.siteId, vars, []));
  return vars.map((v) => v.name);
}

/**
 * site.env_write of credentials going into a site's environment, as the gate
 * sees it BEFORE the user or the password exists: the variable names and
 * where they come from (a generated password is never part of the
 * fingerprint — it does not exist yet; a given one enters it as a secret).
 */
async function envGate(ctx: ApiKeyContext, env: ApiV1DbEnvTarget, origin: Record<string, unknown>, password?: string | null): Promise<GateSpec> {
  requireScope(ctx, 'sites.manage');
  const site = await keySite(ctx, env.siteId);
  const prefix = env.prefix ?? 'DB_';
  if (!ENV_PREFIX_RE.test(prefix)) throw new AppError(400, 'Prefix: upper-case letters, digits and _', 'validation', { field: 'prefix' });
  return {
    action: 'site.env_write', target: siteTarget(site),
    params: { ...origin, set: ['HOST', 'SOCKET', 'NAME', 'USER', 'PASSWORD'].map((n) => `${prefix}${n}`), databaseId: env.databaseId ?? null },
    secretParams: password ? { password } : {},
  };
}

/**
 * db.import: free → streamed as before. Protected → the dump is copied to a
 * private temporary file while hashed (sha256 + size enter the fingerprint:
 * an approval never serves another dump), gated, then imported from THAT copy
 * — never re-read from its source, which could have changed meanwhile.
 */
async function gatedImport(
  ctx: ApiKeyContext, req: Request, row: DbInstanceRow, target: { id: number; name: string },
  source: { stream: Readable; contentType: string } | undefined, origin: Record<string, unknown>,
): Promise<{ restored: true }> {
  if (await actionLevel(asKeyRequest(req, ctx), 'db.import', instanceTarget(row)) === 'none') {
    return databaseService.restore(req, ctx.actor, row.id, target.id, source);
  }
  const contentType = source ? source.contentType : String(req.headers['content-type'] ?? '');
  // One copy at a time per key (and a few in all): parallel dumps never fill the panel's disk.
  const copy = await spoolHashed(source?.stream ?? req, `key:${ctx.id}`);
  try {
    return await keyGated(ctx, req, {
      action: 'db.import', target: instanceTarget(row),
      params: { database: target.name, databaseId: target.id, instanceId: row.id, ...origin, size: copy.size, contentSha256: copy.sha256 },
    }, () => databaseService.restore(req, ctx.actor, row.id, target.id, { stream: copy.open(), contentType }));
  } finally {
    await copy.cleanup();
  }
}

/** The database's instance as a restriction target (its account). */
const instanceTarget = (row: DbInstanceRow) => ({ tenantId: Number(row.tenant_id), accountId: Number(row.account_id), siteId: null });

/** A site of the instance's account as a restriction target (the previous owner may be outside the key). */
const siteOfRow = (row: DbInstanceRow, siteId: number) => ({ tenantId: Number(row.tenant_id), accountId: Number(row.account_id), siteId });

const keySiteScope = (message: string) => new AppError(403, message, 'keySiteScope');

/** db.user_grants when an attachment also grants an existing user. */
function grantGate(row: DbInstanceRow, dbId: number, grant: DbAttachGrant | null | undefined): GateSpec[] {
  return grant ? [{ action: 'db.user_grants', target: instanceTarget(row), params: { userId: grant.userId, instanceId: row.id, grants: [{ databaseId: dbId, level: grant.level }], from: 'attachment' } }] : [];
}

async function credentials(ctx: ApiKeyContext, req: Request, instanceId: number, user: DbUser, password: string, env: ApiV1DbEnvTarget | undefined): Promise<ApiV1DbCredentials> {
  const own = await created(ctx, 'user');
  if (!env) return { user: viewUser(user, own), password };
  const names = await credentialsToEnv(ctx, req, await instanceView(ctx, instanceId), user, password, env);
  return { user: viewUser(user, own), password: null, env: { siteId: env.siteId, names } };
}

/** Before creating anything: a site the credentials go to must be reachable with sites.manage. */
async function checkEnvTarget(ctx: ApiKeyContext, env: ApiV1DbEnvTarget | undefined): Promise<void> {
  if (env) await keyEnv.list(ctx, env.siteId);
}

export const keyDatabases = {
  async catalog(ctx: ApiKeyContext): Promise<DbCatalog> {
    requireScope(ctx, 'databases.manage');
    return databaseService.catalog(ctx.actor, ctx.accountId);
  },

  async list(ctx: ApiKeyContext): Promise<ApiV1DbInstance[]> {
    requireScope(ctx, 'databases.manage');
    const instances = await databaseService.listInstances(ctx.actor, { accountId: ctx.accountId });
    return Promise.all(instances.filter((i) => i.status !== 'deleting').map((i) => instanceView(ctx, i.id)));
  },

  async get(ctx: ApiKeyContext, instanceId: number): Promise<ApiV1DbInstance> {
    const row = await keyInstance(ctx, instanceId);
    return instanceView(ctx, row.id);
  },

  /** A new database server (plan limits; minutes before it runs: status provisioning → running). */
  async createInstance(ctx: ApiKeyContext, req: Request, body: { name: string; engine: DbEngine; version: string }): Promise<DbInstance> {
    requireScope(ctx, 'databases.manage');
    return databaseService.createInstance(req, ctx.actor, { accountId: ctx.accountId, name: body.name, engine: body.engine, version: body.version });
  },

  /** `siteId` (a site of the key): the new database belongs to that site. */
  async createDatabase(ctx: ApiKeyContext, req: Request, instanceId: number, body: { name: string; charset?: string | null; collation?: string | null; siteId?: number | null }): Promise<ApiV1Database> {
    const row = await keyInstance(ctx, instanceId);
    const site = body.siteId ? await keySite(ctx, body.siteId) : null;
    const run = async (): Promise<ApiV1Database> => {
      const d: DbDatabase = await databaseService.createDatabase(req, ctx.actor, row.id, { name: body.name, charset: body.charset, collation: body.collation, siteId: site?.id ?? null });
      await record(ctx, 'database', d.id);
      return maskSites(ctx, { ...d, createdByKey: true });
    };
    if (!site) return run();
    // Owned by the site from its creation: an attachment (db.attach on the site).
    return keyGated(ctx, req, { action: 'db.attach', target: siteTarget(site), params: createAttachParams(row, site.id, body.name) }, run);
  },

  // ── databases ↔ sites (migration 030) ──

  /** The databases of one of the key's sites (owned, then shared with it). */
  async siteDatabases(ctx: ApiKeyContext, siteId: number): Promise<ApiV1SiteDatabase[]> {
    requireScope(ctx, 'databases.manage');
    const site = await keySite(ctx, siteId);
    const own = await created(ctx, 'database');
    const list = (await databasesOfSites([site.id])).get(site.id) ?? [];
    return list.map((d) => maskSites(ctx, { ...d, createdByKey: own.has(d.id) }));
  },

  /** A new database owned by the site, on the account's default instance of `family`. */
  async createForSite(ctx: ApiKeyContext, req: Request, siteId: number, body: { name: string; family: DbFamily; charset?: string | null; collation?: string | null }): Promise<ApiV1SiteDatabase> {
    requireScope(ctx, 'databases.manage');
    const site = await keySite(ctx, siteId);
    const { instance } = await siteCreateTarget(ctx.actor, site.id, { family: body.family });
    if (Number(instance.account_id) !== ctx.accountId) throw notFound('Database instance');
    // Owned by the site from its creation: an attachment (db.attach on the site), on the instance it lands on.
    return keyGated(ctx, req, { action: 'db.attach', target: siteTarget(site), params: createAttachParams(instance, site.id, body.name) }, async () => {
      const d = await siteDatabaseService.createForSite(req, ctx.actor, site.id, {
        name: body.name, family: body.family, instanceId: instance.id, charset: body.charset, collation: body.collation,
      });
      await record(ctx, 'database', d.id);
      return maskSites(ctx, { ...d, createdByKey: true });
    });
  },

  /**
   * Sets (siteId, a site of the key) or removes (null) the owner site. A key
   * limited to some sites never takes a database from a site outside its
   * selection, and never makes one shared across the account (every site of
   * the account would reach its server): 403 keySiteScope.
   */
  async setOwner(ctx: ApiKeyContext, req: Request, instanceId: number, dbId: number, body: { siteId: number | null; grantUser?: DbAttachGrant | null }): Promise<DbAttachmentResult> {
    const row = await keyInstance(ctx, instanceId);
    const target = await databaseOf(ctx, row.id, dbId);
    const site = body.siteId ? await keySite(ctx, body.siteId) : null;
    const prev = (await sitesOfDatabases([target.id])).get(target.id)?.owner ?? null;
    if (ctx.siteScope !== 'all') {
      if (!site) throw keySiteScope('A key limited to some sites cannot make a database shared across the account');
      const mine = prev ? keyAllowsSite(ctx, prev.id) : (await created(ctx, 'database')).has(target.id);
      if (!mine) throw keySiteScope('This database does not belong to a site of this key');
    }
    if (body.grantUser) await userOf(ctx, row.id, body.grantUser.userId);
    const changes = (site?.id ?? null) !== (prev?.id ?? null);
    const params = { database: target.name, databaseId: target.id, instanceId: row.id, ownerSiteId: site?.id ?? null, previousOwnerSiteId: prev?.id ?? null };
    const gates: GateSpec[] = [
      ...(changes ? [...new Set([site?.id, prev?.id].filter((s): s is number => !!s))].map((s) => ({ action: 'db.attach', target: siteOfRow(row, s), params })) : []),
      ...grantGate(row, target.id, body.grantUser),
    ];
    // Only while the owner is still the one checked and gated above (409 otherwise).
    const run = () => siteDatabaseService.setOwner(req, ctx.actor, row.id, target.id, { siteId: site?.id ?? null, grantUser: body.grantUser ?? null }, { expectedOwnerId: prev?.id ?? null });
    return maskResult(ctx, gates.length ? await keyGated(ctx, req, gates, run) : await run());
  },

  /**
   * Shares a database with one of the key's sites. A key limited to some
   * sites shares only a database owned by one of its sites, or one it created
   * that has no owner — never one owned by a site outside its selection (it
   * may reach it because it is shared with one of its sites, but exposing it
   * further is the owner's call): 403 keySiteScope. db.share is gated on the
   * receiving site and on the owner site.
   */
  async share(ctx: ApiKeyContext, req: Request, instanceId: number, dbId: number, body: { siteId: number; grantUser?: DbAttachGrant | null }): Promise<DbAttachmentResult> {
    const row = await keyInstance(ctx, instanceId);
    const target = await databaseOf(ctx, row.id, dbId);
    const site = await keySite(ctx, body.siteId);
    const owner = (await sitesOfDatabases([target.id])).get(target.id)?.owner ?? null;
    if (ctx.siteScope !== 'all') {
      const mine = owner ? keyAllowsSite(ctx, owner.id) : (await created(ctx, 'database')).has(target.id);
      if (!mine) throw keySiteScope('This database does not belong to a site of this key');
    }
    if (body.grantUser) await userOf(ctx, row.id, body.grantUser.userId);
    const params = { database: target.name, databaseId: target.id, instanceId: row.id, siteId: site.id, ownerSiteId: owner?.id ?? null, share: true };
    return maskResult(ctx, await keyGated(ctx, req, [
      { action: 'db.share', target: siteTarget(site), params },
      ...(owner && owner.id !== site.id ? [{ action: 'db.share' as const, target: siteOfRow(row, owner.id), params }] : []),
      ...grantGate(row, target.id, body.grantUser),
    ], () => siteDatabaseService.share(req, ctx.actor, row.id, target.id, { siteId: site.id, grantUser: body.grantUser ?? null }, { expectedOwnerId: owner?.id ?? null })));
  },

  /** Detaches a database from one of the key's sites (owner: keys on every site only, see setOwner). SQL rights kept. */
  async detach(ctx: ApiKeyContext, req: Request, instanceId: number, dbId: number, siteId: number): Promise<DbAttachmentResult> {
    const row = await keyInstance(ctx, instanceId);
    const target = await databaseOf(ctx, row.id, dbId);
    const site = await keySite(ctx, siteId);
    const sites = (await sitesOfDatabases([target.id])).get(target.id);
    const owner = sites?.owner?.id === site.id;
    if (!owner && !sites?.shared.some((s) => s.id === site.id)) throw new AppError(404, 'The database is not attached to this site', 'notFound');
    if (owner && ctx.siteScope !== 'all') throw keySiteScope('A key limited to some sites cannot make a database shared across the account');
    return maskResult(ctx, await keyGated(ctx, req, {
      action: owner ? 'db.attach' : 'db.share', target: siteTarget(site),
      params: { database: target.name, databaseId: target.id, instanceId: row.id, siteId: site.id, detach: true },
    }, () => siteDatabaseService.detach(req, ctx.actor, row.id, target.id, site.id)));
  },

  async deleteDatabase(ctx: ApiKeyContext, req: Request, instanceId: number, dbId: number, confirm: string): Promise<void> {
    const row = await keyInstance(ctx, instanceId);
    const target = await databaseOf(ctx, row.id, dbId);
    if (!(await created(ctx, 'database')).has(target.id)) throw new AppError(403, 'A key deletes only the databases it created', 'keyNotCreator');
    // A wrong confirmation is refused before anything is asked of a human.
    if (confirm !== target.name) throw new AppError(400, 'Type the database name to confirm', 'confirmMismatch');
    await keyGated(ctx, req, { action: 'db.drop', target: instanceTarget(row), params: { database: target.name, databaseId: target.id, instanceId: row.id } },
      () => databaseService.deleteDatabase(req, ctx.actor, row.id, target.id, confirm));
  },

  async createUser(ctx: ApiKeyContext, req: Request, instanceId: number, body: { username: string; password?: string | null; grants?: DbGrantInput[]; env?: ApiV1DbEnvTarget }): Promise<ApiV1DbCredentials> {
    const row = await keyInstance(ctx, instanceId);
    await assertGrants(ctx, row.id, body.grants);
    await checkEnvTarget(ctx, body.env);
    const run = async () => {
      const r = await databaseService.createUser(req, ctx.actor, row.id, { username: body.username, password: body.password, grants: body.grants });
      await record(ctx, 'user', r.user.id);
      return credentials(ctx, req, row.id, r.user, r.password, body.env);
    };
    if (!body.env) return run();
    // Credentials written into a site's environment: site.env_write, gated before the user exists.
    return keyGated(ctx, req, await envGate(ctx, body.env, {
      from: 'database user', instanceId: row.id, username: body.username, grants: body.grants ?? [],
    }, body.password), run);
  },

  async setGrants(ctx: ApiKeyContext, req: Request, instanceId: number, userId: number, grants: DbGrantInput[]): Promise<ApiV1DbUser> {
    const row = await keyInstance(ctx, instanceId);
    const user = await userOf(ctx, row.id, userId);
    await assertGrants(ctx, row.id, grants);
    // A key limited to some sites: the grants it does not list are kept, except on the databases it created.
    const hidden = (await db('db_grants as g').where({ 'g.user_id': user.id }).select('g.database_id', 'g.level') as Array<{ database_id: number; level: DbGrantInput['level'] }>)
      .filter((g) => ctx.siteScope !== 'all' && !grants.some((w) => w.databaseId === g.database_id));
    // Only the rights on the databases the key CREATED are its to remove: a right on a database it merely reaches
    // (owned by / shared with its sites, migration 030) is kept — attaching / sharing never revokes a grant.
    const ownDb = await created(ctx, 'database');
    const keep = hidden.filter((g) => !ownDb.has(Number(g.database_id))).map((g) => ({ databaseId: Number(g.database_id), level: g.level }));
    const u = await keyGated(ctx, req, {
      action: 'db.user_grants', target: instanceTarget(row), params: { username: user.username, userId: user.id, instanceId: row.id, grants },
    }, () => databaseService.updateUser(req, ctx.actor, row.id, user.id, { grants: [...grants, ...keep] }));
    return viewUser(u, await created(ctx, 'user'));
  },

  async resetPassword(ctx: ApiKeyContext, req: Request, instanceId: number, userId: number, body: { password?: string | null; env?: ApiV1DbEnvTarget }): Promise<ApiV1DbCredentials> {
    const row = await keyInstance(ctx, instanceId);
    const user = await userOf(ctx, row.id, userId);
    await checkEnvTarget(ctx, body.env);
    const origin = { username: user.username, userId: user.id, instanceId: row.id };
    // db.user_password_reset, and site.env_write when the password goes into a site: one gate, the strictest.
    const gates: GateSpec[] = [
      { action: 'db.user_password_reset', target: instanceTarget(row), params: { ...origin, env: body.env ?? null }, secretParams: body.password ? { password: body.password } : {} },
      ...(body.env ? [await envGate(ctx, body.env, { from: 'database password reset', ...origin }, body.password)] : []),
    ];
    return keyGated(ctx, req, gates, async () => {
      const r = await databaseService.resetPassword(req, ctx.actor, row.id, user.id, body.password);
      return credentials(ctx, req, row.id, r.user, r.password, body.env);
    });
  },

  async deleteUser(ctx: ApiKeyContext, req: Request, instanceId: number, userId: number): Promise<void> {
    const row = await keyInstance(ctx, instanceId);
    const user = await userOf(ctx, row.id, userId);
    if (!(await created(ctx, 'user')).has(user.id)) throw new AppError(403, 'A key deletes only the database users it created', 'keyNotCreator');
    await keyGated(ctx, req, { action: 'db.user_delete', target: instanceTarget(row), params: { username: user.username, userId: user.id, instanceId: row.id } },
      () => databaseService.deleteUser(req, ctx.actor, row.id, user.id));
  },

  /** Tables and views of a database (estimated rows, size). */
  async tables(ctx: ApiKeyContext, instanceId: number, dbId: number): Promise<DbxTable[]> {
    const t = await explorerTarget(ctx, instanceId, dbId);
    return explorerService.tables(t.instance, t.database, keyOwner(ctx), true);
  },

  /** Columns, keys, indexes, foreign keys (and the CREATE statement on MySQL / MariaDB) of a table. */
  async describeTable(ctx: ApiKeyContext, instanceId: number, dbId: number, table: string): Promise<DbxTableInfo> {
    const t = await explorerTarget(ctx, instanceId, dbId);
    return explorerService.table(t.instance, t.database, keyOwner(ctx), table);
  },

  /**
   * ONE SQL statement. Read-only by default: a reading statement only, in a
   * read-only transaction rolled back; write: true runs it for real. Rows and
   * bytes capped, time-limited, audited (statement cut, never the results).
   */
  async query(ctx: ApiKeyContext, req: Request, instanceId: number, dbId: number, body: { sql: string; write?: boolean; maxRows?: number; timeoutS?: number }): Promise<ApiV1DbQueryResult> {
    const t = await explorerTarget(ctx, instanceId, dbId);
    const write = body.write === true;
    // Literals masked (the statement's shape, never the values it carries), cut.
    const cut = auditSql(dbFamilyOf(t.instance.engine), body.sql);
    const log = (details: Record<string, unknown>) => auditService.logReqAs(req, t.instance.tenant_id, 'db.key.query', {
      resourceType: 'database', resourcePath: `${t.instance.id}/${t.database.id}`, details: { database: t.database.name, write, sql: cut, ...details },
    });
    const run = async (): Promise<ApiV1DbQueryResult> => {
      try {
        const { statement: _statement, ...r } = await explorerService.keyQuery(t.instance, t.database, keyOwner(ctx), body.sql, {
          write, maxRows: body.maxRows, timeoutS: body.timeoutS,
        });
        await log({ ok: true, rows: r.rowCount, affectedRows: r.affectedRows, truncated: r.truncated });
        return r;
      } catch (err) {
        await log({ ok: false, code: err instanceof AppError ? err.code : null });
        throw err;
      }
    };
    if (!write) return run();
    // db.query_write (open by default, protectable for the keys only), and what the statement amounts to (DROP /
    // TRUNCATE: db.ddl, rows changed: db.rows_write…), gated once on the strictest. The decider
    // reads the statement with its literals masked (as the audit); the exact one is bound by its digest.
    const params = {
      database: t.database.name, databaseId: t.database.id, instanceId: t.instance.id, sql: cut, write: true,
      sqlSha256: crypto.createHash('sha256').update(body.sql).digest('hex'),
    };
    const family = dbFamilyOf(t.instance.engine);
    const actions = classifySql(splitStatements(body.sql, family).map((s) => s.sql), family).actions;
    return keyGated(ctx, req, (actions.length ? actions : ['db.query_write' as const]).map((action) => ({ action, target: instanceTarget(t.instance), params })), run);
  },

  /** gzip SQL dump streamed to `res`. */
  async dump(ctx: ApiKeyContext, req: Request, res: Response, instanceId: number, dbId: number): Promise<void> {
    const row = await keyInstance(ctx, instanceId);
    const target = await databaseOf(ctx, row.id, dbId);
    await keyGated(ctx, req, { action: 'db.dump', target: instanceTarget(row), params: { database: target.name, databaseId: target.id, instanceId: row.id } },
      () => databaseService.dump(req, res, ctx.actor, row.id, target.id));
  },

  /** Runs an SQL dump (plain or gzip) into a database: the request body, or `source` (a file of a site). */
  async importSql(ctx: ApiKeyContext, req: Request, instanceId: number, dbId: number, source?: { stream: Readable; contentType: string }): Promise<{ restored: true }> {
    const row = await keyInstance(ctx, instanceId);
    const target = await databaseOf(ctx, row.id, dbId);
    return gatedImport(ctx, req, row, target, source, { from: 'request body' });
  },

  /** Imports an SQL dump (.sql or .sql.gz) that is a file of one of the key's sites (needs files.read too). */
  async importFromSite(ctx: ApiKeyContext, req: Request, instanceId: number, dbId: number, siteId: number, area: SiteArea, path: string): Promise<{ restored: true }> {
    const row = await keyInstance(ctx, instanceId);
    const target = await databaseOf(ctx, row.id, dbId);
    const { stream } = await keyApi.open(ctx, siteId, area, path);
    if (stream.status !== 200) {
      stream.body.destroy();
      throw new AppError(404, 'File not found', 'notFound');
    }
    try {
      return await gatedImport(ctx, req, row, target, { stream: stream.body, contentType: 'application/octet-stream' }, { from: 'site file', siteId, area, path });
    } finally {
      stream.body.destroy();
    }
  },
};
