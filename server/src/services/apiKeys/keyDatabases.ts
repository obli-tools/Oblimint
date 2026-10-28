import type { Request, Response } from 'express';
import type { Readable } from 'stream';
import type {
  ApiV1Database, ApiV1DbCredentials, ApiV1DbEnvTarget, ApiV1DbInstance, ApiV1DbQueryResult, ApiV1DbUser, DbCatalog, DbDatabase, DbEngine, DbGrantInput,
  DbInstance, DbUser, DbxTable, DbxTableInfo,
} from '@oblimint/shared';
import { dbFamilyOf } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { auditService } from '../audit.service';
import { databaseService, loadDatabaseRow, loadInstance } from '../databases/databases.service';
import { auditSql, explorerService } from '../databases/explorer/explorer.service';
import type { DbDatabaseRow, DbInstanceRow } from '../databases/rows';
import { requireScope, type ApiKeyContext } from './apiKeys.service';
import { keyApi, type SiteArea } from './keyApi';
import { keyEnv } from './keyEnv';

// ─────────────────────────────────────────────────────────────────────────────
// Databases through an API key (scope databases.manage), on top of the
// databases service (its own checks, plan limits and audit apply):
//   - instances: every database server of the account; a key may create one
//     (plan limits), never stop, reconfigure nor delete one;
//   - databases / users: a key on every site (siteScope 'all') reaches all of
//     the account's; a key limited to some sites only the ones it created
//     (api_key_db_objects) — so it never reads another site's data;
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

const reaches = (ctx: ApiKeyContext, own: Set<number>, id: number) => ctx.siteScope === 'all' || own.has(id);

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
  if (!row || !reaches(ctx, await created(ctx, 'database'), row.id)) throw notFound('Database');
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
  const [ownDb, ownUser] = await Promise.all([created(ctx, 'database'), created(ctx, 'user')]);
  return {
    id: d.id, name: d.name, engine: d.engine, version: d.version, family: d.family, status: d.status, isDefault: d.isDefault,
    connection: d.connection,
    databases: d.databases.filter((x) => reaches(ctx, ownDb, x.id)).map((x): ApiV1Database => ({ ...x, createdByKey: ownDb.has(x.id) })),
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
  await keyEnv.update(ctx, req, target.siteId, vars);
  return vars.map((v) => v.name);
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

  async createDatabase(ctx: ApiKeyContext, req: Request, instanceId: number, body: { name: string; charset?: string | null; collation?: string | null }): Promise<ApiV1Database> {
    const row = await keyInstance(ctx, instanceId);
    const d: DbDatabase = await databaseService.createDatabase(req, ctx.actor, row.id, body);
    await record(ctx, 'database', d.id);
    return { ...d, createdByKey: true };
  },

  async deleteDatabase(ctx: ApiKeyContext, req: Request, instanceId: number, dbId: number, confirm: string): Promise<void> {
    const row = await keyInstance(ctx, instanceId);
    const target = await databaseOf(ctx, row.id, dbId);
    if (!(await created(ctx, 'database')).has(target.id)) throw new AppError(403, 'A key deletes only the databases it created', 'keyNotCreator');
    await databaseService.deleteDatabase(req, ctx.actor, row.id, target.id, confirm);
  },

  async createUser(ctx: ApiKeyContext, req: Request, instanceId: number, body: { username: string; password?: string | null; grants?: DbGrantInput[]; env?: ApiV1DbEnvTarget }): Promise<ApiV1DbCredentials> {
    const row = await keyInstance(ctx, instanceId);
    await assertGrants(ctx, row.id, body.grants);
    await checkEnvTarget(ctx, body.env);
    const r = await databaseService.createUser(req, ctx.actor, row.id, { username: body.username, password: body.password, grants: body.grants });
    await record(ctx, 'user', r.user.id);
    return credentials(ctx, req, row.id, r.user, r.password, body.env);
  },

  async setGrants(ctx: ApiKeyContext, req: Request, instanceId: number, userId: number, grants: DbGrantInput[]): Promise<ApiV1DbUser> {
    const row = await keyInstance(ctx, instanceId);
    const user = await userOf(ctx, row.id, userId);
    await assertGrants(ctx, row.id, grants);
    // The grants it keeps on databases the key does not reach are not its to remove.
    const hidden = (await db('db_grants as g').where({ 'g.user_id': user.id }).select('g.database_id', 'g.level') as Array<{ database_id: number; level: DbGrantInput['level'] }>)
      .filter((g) => ctx.siteScope !== 'all' && !grants.some((w) => w.databaseId === g.database_id));
    const ownDb = await created(ctx, 'database');
    const keep = hidden.filter((g) => !ownDb.has(g.database_id)).map((g) => ({ databaseId: g.database_id, level: g.level }));
    const u = await databaseService.updateUser(req, ctx.actor, row.id, user.id, { grants: [...grants, ...keep] });
    return viewUser(u, await created(ctx, 'user'));
  },

  async resetPassword(ctx: ApiKeyContext, req: Request, instanceId: number, userId: number, body: { password?: string | null; env?: ApiV1DbEnvTarget }): Promise<ApiV1DbCredentials> {
    const row = await keyInstance(ctx, instanceId);
    const user = await userOf(ctx, row.id, userId);
    await checkEnvTarget(ctx, body.env);
    const r = await databaseService.resetPassword(req, ctx.actor, row.id, user.id, body.password);
    return credentials(ctx, req, row.id, r.user, r.password, body.env);
  },

  async deleteUser(ctx: ApiKeyContext, req: Request, instanceId: number, userId: number): Promise<void> {
    const row = await keyInstance(ctx, instanceId);
    const user = await userOf(ctx, row.id, userId);
    if (!(await created(ctx, 'user')).has(user.id)) throw new AppError(403, 'A key deletes only the database users it created', 'keyNotCreator');
    await databaseService.deleteUser(req, ctx.actor, row.id, user.id);
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
  },

  /** gzip SQL dump streamed to `res`. */
  async dump(ctx: ApiKeyContext, req: Request, res: Response, instanceId: number, dbId: number): Promise<void> {
    const row = await keyInstance(ctx, instanceId);
    const target = await databaseOf(ctx, row.id, dbId);
    await databaseService.dump(req, res, ctx.actor, row.id, target.id);
  },

  /** Runs an SQL dump (plain or gzip) into a database: the request body, or `source` (a file of a site). */
  async importSql(ctx: ApiKeyContext, req: Request, instanceId: number, dbId: number, source?: { stream: Readable; contentType: string }): Promise<{ restored: true }> {
    const row = await keyInstance(ctx, instanceId);
    const target = await databaseOf(ctx, row.id, dbId);
    return databaseService.restore(req, ctx.actor, row.id, target.id, source);
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
      return await databaseService.restore(req, ctx.actor, row.id, target.id, { stream: stream.body, contentType: 'application/octet-stream' });
    } finally {
      stream.body.destroy();
    }
  },
};
