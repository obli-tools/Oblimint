import path from 'path';
import type {
  DbxInfo, DbxQueryResponse, DbxRowKey, DbxRows, DbxRowsRequest, DbxTable, DbxTableInfo,
} from '@oblimint/shared';
import { DBX_MAX_PAGE, dbFamilyOf } from '@oblimint/shared';
import { AppError } from '../../../middleware/errorHandler';
import { logger } from '../../../utils/logger';
import { engineFor } from '../../docker/engine';
import { hostdSocketFor } from '../../hostd/client';
import { localPaths } from '../../hosting/paths';
import { DB_SOCKET_FILE } from '../engines';
import type { DbDatabaseRow, DbInstanceRow } from '../rows';
import { createEphemeralUser, releaseEphemeralUser } from '../sso';
import { connectMysql, connectPostgres, type ExplorerDriver } from './drivers';

// ─────────────────────────────────────────────────────────────────────────────
// Database explorer sessions (shared/src/dbExplorer.ts). One session per
// (panel user, database): an ephemeral SQL user with ALL on that database only
// (never the instance superuser) and one connection over the instance's local
// socket. A session idle for SESSION_IDLE_MS is closed (connection ended, SQL
// user dropped); it is renewed before the user's validity ends. The catalog
// (tables, table structure) is cached briefly and dropped after any console
// statement (DDL).
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_IDLE_MS = 10 * 60_000;
/** Renewed after this (the ephemeral user is valid a little longer). */
const SESSION_MAX_MS = 100 * 60_000;
const USER_TTL_MS = SESSION_MAX_MS + 20 * 60_000;
const MAX_SESSIONS_PER_ACCOUNT = 5;
const CATALOG_TTL_MS = 15_000;

interface Session {
  key: string;
  accountId: number;
  instance: DbInstanceRow;
  database: DbDatabaseRow;
  username: string;
  driver: ExplorerDriver;
  createdAt: number;
  lastUsed: number;
  busy: number;
  tables: { at: number; list: DbxTable[] } | null;
  infos: Map<string, { at: number; info: DbxTableInfo }>;
  version: string | null;
}

export interface ExplorerDeps {
  connect(instance: DbInstanceRow, database: DbDatabaseRow): Promise<{ driver: ExplorerDriver; username: string }>;
  release(instance: DbInstanceRow, username: string): Promise<void>;
  now(): number;
}

const defaultDeps: ExplorerDeps = {
  async connect(instance, database) {
    await hostdSocketFor(instance.node_id); // the socket is reachable on the local node only (501 otherwise)
    const docker = await engineFor(instance.node_id);
    const { username, password } = await createEphemeralUser(docker, instance, [database], USER_TTL_MS);
    try {
      const dir = localPaths.dbSocketInstance(instance.account_id, instance.id);
      const family = dbFamilyOf(instance.engine);
      const driver = family === 'mysql'
        ? await connectMysql({ socketPath: path.posix.join(dir, DB_SOCKET_FILE.mysql), user: username, password, database: database.name, mariadb: instance.engine === 'mariadb' })
        : await connectPostgres({ socketDir: dir, user: username, password, database: database.name });
      return { driver, username };
    } catch (err) {
      await releaseEphemeralUser(instance, username);
      throw err;
    }
  },
  release: (instance, username) => releaseEphemeralUser(instance, username),
  now: () => Date.now(),
};

let deps: ExplorerDeps = defaultDeps;
const sessions = new Map<string, Promise<Session>>();
let sweeper: NodeJS.Timeout | null = null;

/** Tests: replace the dependencies (null restores). */
export function setExplorerDeps(d: Partial<ExplorerDeps> | null): void {
  deps = d ? { ...defaultDeps, ...d } : defaultDeps;
  sessions.clear();
}

function sqlError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const e = err as { message?: string; code?: string; errno?: number };
  const msg = e?.message ?? String(err);
  if (/ECONNREFUSED|ENOENT|ECONNRESET|PROTOCOL_CONNECTION_LOST|Connection terminated|EPIPE/i.test(`${e?.code ?? ''} ${msg}`)) {
    return new AppError(503, 'The database server is unreachable (restarting?). Try again.', 'dbUnreachable');
  }
  return new AppError(400, msg, 'sqlError');
}

const isConnectionError = (err: unknown) => err instanceof AppError && err.code === 'dbUnreachable';

async function closeSession(key: string): Promise<void> {
  const p = sessions.get(key);
  sessions.delete(key);
  if (!p) return;
  let s: Session;
  try { s = await p; } catch { return; }
  try { await s.driver.close(); } catch { /* already gone */ }
  await deps.release(s.instance, s.username);
}

async function sweep(): Promise<void> {
  const now = deps.now();
  for (const [key, p] of [...sessions]) {
    const s = await p.catch(() => null);
    if (!s) { sessions.delete(key); continue; }
    if (s.busy === 0 && (now - s.lastUsed > SESSION_IDLE_MS || now - s.createdAt > SESSION_MAX_MS)) await closeSession(key);
  }
  if (!sessions.size && sweeper) { clearInterval(sweeper); sweeper = null; }
}

/** Tests / shutdown: closes every session. */
export async function closeAllExplorerSessions(): Promise<void> {
  for (const key of [...sessions.keys()]) await closeSession(key);
}

async function session(instance: DbInstanceRow, database: DbDatabaseRow, userId: number): Promise<Session> {
  if (instance.status !== 'running') throw new AppError(409, 'The database instance is not running', 'instanceNotRunning');
  const key = `${userId}:${instance.id}:${database.id}`;
  const existing = sessions.get(key);
  if (existing) {
    const s = await existing.catch(() => null);
    if (s && deps.now() - s.createdAt < SESSION_MAX_MS) return s;
    await closeSession(key);
  }
  let count = 0;
  for (const p of sessions.values()) {
    const s = await p.catch(() => null);
    if (s?.accountId === instance.account_id) count++;
  }
  if (count >= MAX_SESSIONS_PER_ACCOUNT) throw new AppError(429, 'Too many explorer sessions on this account: close another one or try again in a few minutes', 'tooManySessions');
  const p = (async (): Promise<Session> => {
    const { driver, username } = await deps.connect(instance, database);
    const now = deps.now();
    return {
      key, accountId: instance.account_id, instance, database, username, driver, createdAt: now, lastUsed: now, busy: 0,
      tables: null, infos: new Map(), version: null,
    };
  })();
  sessions.set(key, p);
  p.catch(() => { if (sessions.get(key) === p) sessions.delete(key); });
  if (!sweeper) { sweeper = setInterval(() => { void sweep(); }, 60_000); sweeper.unref(); }
  try {
    return await p;
  } catch (err) {
    logger.warn({ err, instanceId: instance.id }, 'Explorer: session failed');
    throw sqlError(err);
  }
}

/** Runs fn on the session; a lost connection ends the session (the next call reconnects). */
async function withSession<T>(instance: DbInstanceRow, database: DbDatabaseRow, userId: number, fn: (s: Session) => Promise<T>): Promise<T> {
  const s = await session(instance, database, userId);
  s.busy++;
  s.lastUsed = deps.now();
  try {
    return await fn(s);
  } catch (err) {
    const e = sqlError(err);
    if (isConnectionError(e)) void closeSession(s.key);
    throw e;
  } finally {
    s.busy--;
    s.lastUsed = deps.now();
  }
}

async function tablesOf(s: Session): Promise<DbxTable[]> {
  if (s.tables && deps.now() - s.tables.at < CATALOG_TTL_MS) return s.tables.list;
  const list = await s.driver.tables();
  s.tables = { at: deps.now(), list };
  return list;
}

/** A table of the catalog (identifiers never come from the request as such). */
async function infoOf(s: Session, tableId: string): Promise<DbxTableInfo> {
  const cached = s.infos.get(tableId);
  if (cached && deps.now() - cached.at < CATALOG_TTL_MS) return cached.info;
  const t = (await tablesOf(s)).find((x) => x.id === tableId);
  if (!t) throw new AppError(404, 'Table not found', 'tableNotFound');
  const info = await s.driver.table(t);
  s.infos.set(tableId, { at: deps.now(), info });
  return info;
}

function checkColumns(info: DbxTableInfo, names: string[], what: string): void {
  const known = new Set(info.columns.map((c) => c.name));
  for (const n of names) if (!known.has(n)) throw new AppError(400, `Unknown column in ${what}: ${n}`, 'unknownColumn');
}

function editable(info: DbxTableInfo): void {
  if (info.table.kind !== 'table') throw new AppError(409, 'A view cannot be edited from the grid', 'notEditable');
  if (!info.primaryKey.length) throw new AppError(409, 'This table has no primary key: edit it with SQL', 'noPrimaryKey');
}

function checkValues(info: DbxTableInfo, values: Record<string, string | null>): void {
  checkColumns(info, Object.keys(values), 'values');
  for (const c of info.columns) {
    if (c.binary && c.name in values) throw new AppError(400, `Binary column ${c.name} cannot be edited from the grid`, 'binaryColumn');
  }
}

function checkKey(info: DbxTableInfo, key: DbxRowKey): void {
  for (const c of info.primaryKey) if (!(c in key)) throw new AppError(400, `Missing primary key column ${c}`, 'invalidKey');
}

export const explorerService = {
  info: (i: DbInstanceRow, d: DbDatabaseRow, userId: number): Promise<DbxInfo> => withSession(i, d, userId, async (s) => {
    s.version ??= await s.driver.version();
    return { engine: i.engine, version: s.version, database: d.name, user: s.username };
  }),

  tables: (i: DbInstanceRow, d: DbDatabaseRow, userId: number, refresh = false) => withSession(i, d, userId, async (s) => {
    if (refresh) { s.tables = null; s.infos.clear(); }
    return tablesOf(s);
  }),

  table: (i: DbInstanceRow, d: DbDatabaseRow, userId: number, tableId: string) => withSession(i, d, userId, (s) => infoOf(s, tableId)),

  rows: (i: DbInstanceRow, d: DbDatabaseRow, userId: number, tableId: string, req: DbxRowsRequest): Promise<DbxRows> => withSession(i, d, userId, async (s) => {
    const info = await infoOf(s, tableId);
    const cols = [...(req.sort ? [req.sort] : []), ...(req.filters ?? []).map((f) => f.column)];
    checkColumns(info, cols, 'sort / filter');
    return s.driver.rows(info, { ...req, limit: Math.min(Math.max(1, req.limit), DBX_MAX_PAGE), offset: Math.max(0, req.offset) });
  }),

  insert: (i: DbInstanceRow, d: DbDatabaseRow, userId: number, tableId: string, values: Record<string, string | null>) => withSession(i, d, userId, async (s) => {
    const info = await infoOf(s, tableId);
    if (info.table.kind !== 'table') throw new AppError(409, 'A view cannot be edited from the grid', 'notEditable');
    checkValues(info, values);
    await s.driver.insert(info, values);
  }),

  update: (i: DbInstanceRow, d: DbDatabaseRow, userId: number, tableId: string, key: DbxRowKey, values: Record<string, string | null>) => withSession(i, d, userId, async (s) => {
    const info = await infoOf(s, tableId);
    editable(info);
    checkKey(info, key);
    checkValues(info, values);
    if (!Object.keys(values).length) return 0;
    return s.driver.update(info, key, values);
  }),

  remove: (i: DbInstanceRow, d: DbDatabaseRow, userId: number, tableId: string, keys: DbxRowKey[]) => withSession(i, d, userId, async (s) => {
    const info = await infoOf(s, tableId);
    editable(info);
    keys.forEach((k) => checkKey(info, k));
    return s.driver.remove(info, keys);
  }),

  query: (i: DbInstanceRow, d: DbDatabaseRow, userId: number, sql: string): Promise<DbxQueryResponse> => withSession(i, d, userId, async (s) => {
    try {
      return await s.driver.run(sql);
    } finally {
      s.tables = null; // the console may have changed the schema
      s.infos.clear();
    }
  }),

  close: (i: DbInstanceRow, d: DbDatabaseRow, userId: number) => closeSession(`${userId}:${i.id}:${d.id}`),
};
