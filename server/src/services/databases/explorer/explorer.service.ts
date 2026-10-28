import crypto from 'crypto';
import path from 'path';
import zlib from 'zlib';
import { Transform, type Readable, type Writable } from 'stream';
import type { Response } from 'express';
import type {
  ApiV1DbQueryResult, DbFamily, DbxDdlPreview, DbxDdlRequest, DbxExportRequest, DbxExportTicket, DbxImportOptions, DbxImportStatus, DbxInfo,
  DbxMaintenanceOp, DbxObject, DbxObjectDefinition, DbxQueryResponse, DbxRowKey, DbxRows, DbxRowsRequest, DbxSchema, DbxSearchHit, DbxSearchRequest,
  DbxSearchResponse, DbxTable, DbxTableInfo,
} from '@oblimint/shared';
import {
  DBX_EXPORT_DEFAULT_MAX_MB, DBX_EXPORT_TICKET_S, DBX_IMPORT_DEFAULT_MAX_MB, DBX_KEY_MAX_BYTES, DBX_KEY_MAX_ROWS, DBX_KEY_MAX_TIMEOUT_S,
  DBX_MAINTENANCE_OPS, DBX_MAX_PAGE, DBX_MAX_TIMEOUT_S, DBX_MIN_TIMEOUT_S, DBX_SEARCH_BUDGET_S, DBX_SEARCH_MAX_BYTES, DBX_SEARCH_MAX_TABLES,
  DBX_SEARCH_ROWS_PER_TABLE, DBX_STATEMENT_TIMEOUT_S, DBX_TEXT_PREVIEW, dbFamilyOf, dbxTransactionalEngine,
} from '@oblimint/shared';
import { AppError } from '../../../middleware/errorHandler';
import { logger } from '../../../utils/logger';
import { engineFor } from '../../docker/engine';
import { hostdSocketFor } from '../../hostd/client';
import { dbInstanceContainer } from '../../hosting/naming';
import { localPaths } from '../../hosting/paths';
import { platformSettings } from '../../platformSettings';
import { DB_SOCKET_FILE, passwordEnv } from '../engines';
import { dbExec } from '../exec';
import { createRestoreRewriter, restoreSqlStream } from '../restore';
import type { DbDatabaseRow, DbInstanceRow } from '../rows';
import { createEphemeralUser, releaseEphemeralUser } from '../sso';
import { buildDdl, tableRef, type DdlContext } from './ddl';
import { connectMysql, connectPostgres, RowBudget, type ExplorerDriver } from './drivers';
import { firstKeyword, maskSqlLiterals, splitStatements } from './sqlStream';
import { byteCap, explorerDumpArgv, exportFilename, exportRows, runCsvImport, runSqlImport, type DumpOptions } from './transfer';

// ─────────────────────────────────────────────────────────────────────────────
// Database explorer sessions (shared/src/dbExplorer.ts). One session per
// (owner, database) — owner = a panel user, or an API key ("k<id>") — an
// ephemeral SQL user with ALL on that database only (never the instance
// superuser) and one connection over the instance's local socket; exports,
// imports and query cancellation open short-lived SIDE connections of the
// same user (its password lives in memory only, for the session). A session
// idle for SESSION_IDLE_MS is closed (connections ended, SQL user dropped);
// it is renewed before the user's validity ends. The catalog (tables, table
// structure) is cached briefly and dropped after any console / DDL statement.
// ─────────────────────────────────────────────────────────────────────────────

const SESSION_IDLE_MS = 10 * 60_000;
/** Renewed after this (the ephemeral user is valid a little longer). */
const SESSION_MAX_MS = 100 * 60_000;
const USER_TTL_MS = SESSION_MAX_MS + 20 * 60_000;
const MAX_SESSIONS_PER_ACCOUNT = 5;
const CATALOG_TTL_MS = 15_000;
/** Side connections of a session at once (exports, an import, a cancellation). */
const MAX_SIDE_CONNECTIONS = 3;
const EXPORT_TIMEOUT_S = 30 * 60;
/** Per statement of an import. */
const IMPORT_STATEMENT_TIMEOUT_S = 600;
/** Export tickets not yet used, per session (the oldest is dropped past it). */
const MAX_TICKETS_PER_SESSION = 5;
const SCHEMA_MAX_TABLES = 2000;

/** Owner of a session: a panel user id, or `k<keyId>` for an API key. */
export type SessionOwner = number | `k${number}`;

interface ImportJob {
  status: DbxImportStatus;
  cancel: boolean;
}

interface Session {
  key: string;
  accountId: number;
  instance: DbInstanceRow;
  database: DbDatabaseRow;
  family: DbFamily;
  username: string;
  password: string;
  driver: ExplorerDriver;
  createdAt: number;
  lastUsed: number;
  busy: number;
  side: number;
  /** Connection id of the console statement running (cancellation). */
  running: number | null;
  importJob: ImportJob | null;
  tables: { at: number; list: DbxTable[] } | null;
  infos: Map<string, { at: number; info: DbxTableInfo }>;
  version: string | null;
}

export interface ExplorerDeps {
  connect(instance: DbInstanceRow, database: DbDatabaseRow): Promise<{ driver: ExplorerDriver; username: string; password: string }>;
  /** A side connection of the session's user. */
  open(instance: DbInstanceRow, database: DbDatabaseRow, username: string, password: string): Promise<ExplorerDriver>;
  /** Runs the engine dump tool as the session's user into `out`. */
  dump(instance: DbInstanceRow, database: DbDatabaseRow, username: string, password: string, o: DumpOptions, out: Writable, signal: AbortSignal): Promise<void>;
  release(instance: DbInstanceRow, username: string): Promise<void>;
  /** Import / export caps (bytes): platform settings. */
  caps(): Promise<{ importMax: number; exportMax: number }>;
  now(): number;
}

async function connectDriver(instance: DbInstanceRow, database: DbDatabaseRow, user: string, password: string): Promise<ExplorerDriver> {
  const dir = localPaths.dbSocketInstance(instance.account_id, instance.id);
  return dbFamilyOf(instance.engine) === 'mysql'
    ? connectMysql({ socketPath: path.posix.join(dir, DB_SOCKET_FILE.mysql), user, password, database: database.name, mariadb: instance.engine === 'mariadb' })
    : connectPostgres({ socketDir: dir, user, password, database: database.name });
}

const defaultDeps: ExplorerDeps = {
  async connect(instance, database) {
    await hostdSocketFor(instance.node_id); // the socket is reachable on the local node only (501 otherwise)
    const docker = await engineFor(instance.node_id);
    const { username, password } = await createEphemeralUser(docker, instance, [database], USER_TTL_MS);
    try {
      return { driver: await connectDriver(instance, database, username, password), username, password };
    } catch (err) {
      await releaseEphemeralUser(instance, username);
      throw err;
    }
  },
  open: (instance, database, username, password) => connectDriver(instance, database, username, password),
  async dump(instance, database, username, password, o, out, signal) {
    const docker = await engineFor(instance.node_id);
    const r = await dbExec(docker, dbInstanceContainer(instance.id), explorerDumpArgv(instance.engine, database.name, username, o), {
      env: [passwordEnv(dbFamilyOf(instance.engine), password)], stdout: out, timeoutMs: EXPORT_TIMEOUT_S * 1000, signal,
    });
    if (r.exitCode !== 0) throw new AppError(502, `Dump: ${r.stderr.slice(0, 1000)}`, 'dumpFailed');
  },
  release: (instance, username) => releaseEphemeralUser(instance, username),
  caps: () => importCaps(),
  now: () => Date.now(),
};

let deps: ExplorerDeps = defaultDeps;
/**
 * Sessions by key. The entry is set SYNCHRONOUSLY when a session starts being created (before any await),
 * so concurrent first calls share one creation; accountId counts it against the account limit meanwhile.
 */
interface SessionEntry { accountId: number; p: Promise<Session> }
const sessions = new Map<string, SessionEntry>();
let sweeper: NodeJS.Timeout | null = null;

interface Ticket {
  sessionKey: string;
  expires: number;
  filename: string;
  format: DbxExportRequest['format'];
  gzip: boolean;
  /** csv / json: the SELECT; sql: the dump options. */
  sql: string | null;
  readOnly: boolean;
  dump: DumpOptions | null;
  delimiter: string;
  header: boolean;
  /** Audit: what was exported. */
  what: Record<string, unknown>;
}
const tickets = new Map<string, Ticket>();

/** Tests: replace the dependencies (null restores). */
export function setExplorerDeps(d: Partial<ExplorerDeps> | null): void {
  deps = d ? { ...defaultDeps, ...d } : defaultDeps;
  sessions.clear();
  tickets.clear();
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
const sessionKey = (owner: SessionOwner, i: DbInstanceRow, d: DbDatabaseRow) => `${owner}:${i.id}:${d.id}`;

/** Closes the session of `key` (only that entry when given: a newer one created meanwhile is left alone). */
async function closeSession(key: string, only?: SessionEntry): Promise<void> {
  const e = sessions.get(key);
  if (!e || (only && e !== only)) return;
  sessions.delete(key);
  let s: Session;
  try { s = await e.p; } catch { return; }
  if (s.importJob?.status.state === 'running') s.importJob.cancel = true;
  try { await s.driver.close(); } catch { /* already gone */ }
  await deps.release(s.instance, s.username);
}

async function sweep(): Promise<void> {
  const now = deps.now();
  for (const [key, e] of [...sessions]) {
    const s = await e.p.catch(() => null);
    if (!s) { if (sessions.get(key) === e) sessions.delete(key); continue; }
    if (s.busy === 0 && s.side === 0 && (now - s.lastUsed > SESSION_IDLE_MS || now - s.createdAt > SESSION_MAX_MS)) await closeSession(key, e);
  }
  for (const [k, t] of tickets) if (t.expires < now) tickets.delete(k);
  if (!sessions.size && sweeper) { clearInterval(sweeper); sweeper = null; }
}

/** Tests / shutdown: closes every session. */
export async function closeAllExplorerSessions(): Promise<void> {
  for (const key of [...sessions.keys()]) await closeSession(key);
}

async function session(instance: DbInstanceRow, database: DbDatabaseRow, owner: SessionOwner): Promise<Session> {
  if (instance.status !== 'running') throw new AppError(409, 'The database instance is not running', 'instanceNotRunning');
  const key = sessionKey(owner, instance, database);
  for (;;) {
    const existing = sessions.get(key);
    if (!existing) break;
    const s = await existing.p.catch(() => null);
    if (s && (deps.now() - s.createdAt < SESSION_MAX_MS || s.busy > 0 || s.side > 0)) return s;
    await closeSession(key, existing);
    // Another call may have started a new session meanwhile: checked again.
  }
  // From here to sessions.set: no await (one creation per key, the account count stays exact).
  let count = 0;
  for (const e of sessions.values()) if (e.accountId === instance.account_id) count++;
  if (count >= MAX_SESSIONS_PER_ACCOUNT) throw new AppError(429, 'Too many explorer sessions on this account: close another one or try again in a few minutes', 'tooManySessions');
  const p = (async (): Promise<Session> => {
    const { driver, username, password } = await deps.connect(instance, database);
    const now = deps.now();
    return {
      key, accountId: instance.account_id, instance, database, family: dbFamilyOf(instance.engine), username, password, driver,
      createdAt: now, lastUsed: now, busy: 0, side: 0, running: null, importJob: null, tables: null, infos: new Map(), version: null,
    };
  })();
  const entry: SessionEntry = { accountId: instance.account_id, p };
  sessions.set(key, entry);
  p.catch(() => { if (sessions.get(key) === entry) sessions.delete(key); });
  if (!sweeper) { sweeper = setInterval(() => { void sweep(); }, 60_000); sweeper.unref(); }
  try {
    return await p;
  } catch (err) {
    logger.warn({ err, instanceId: instance.id }, 'Explorer: session failed');
    throw sqlError(err);
  }
}

/** Runs fn on the session; a lost connection ends the session (the next call reconnects). */
async function withSession<T>(instance: DbInstanceRow, database: DbDatabaseRow, owner: SessionOwner, fn: (s: Session) => Promise<T>): Promise<T> {
  const s = await session(instance, database, owner);
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

/** One of the session's transfer slots (exports, an import, a cancellation) for the time of fn. */
async function withSlot<T>(s: Session, fn: () => Promise<T>): Promise<T> {
  if (s.side >= MAX_SIDE_CONNECTIONS) throw new AppError(429, 'Too many exports / imports running on this database: wait for one to end', 'tooManyTransfers');
  s.side++;
  try {
    return await fn();
  } finally {
    s.side--;
    s.lastUsed = deps.now();
  }
}

/** A side connection of the session's user for the time of fn. */
function withSide<T>(s: Session, fn: (d: ExplorerDriver) => Promise<T>): Promise<T> {
  return withSlot(s, async () => {
    const d = await deps.open(s.instance, s.database, s.username, s.password).catch((err) => { throw sqlError(err); });
    try { return await fn(d); } finally { await d.close().catch(() => undefined); }
  });
}

function dropCatalog(s: Session): void {
  s.tables = null;
  s.infos.clear();
}

async function tablesOf(s: Session): Promise<DbxTable[]> {
  if (s.tables && deps.now() - s.tables.at < CATALOG_TTL_MS) return s.tables.list;
  const list = await s.driver.tables();
  s.tables = { at: deps.now(), list };
  return list;
}

async function tableOf(s: Session, tableId: string): Promise<DbxTable> {
  const t = (await tablesOf(s)).find((x) => x.id === tableId);
  if (!t) throw new AppError(404, 'Table not found', 'tableNotFound');
  return t;
}

/** A table of the catalog (identifiers never come from the request as such). */
async function infoOf(s: Session, tableId: string): Promise<DbxTableInfo> {
  const cached = s.infos.get(tableId);
  if (cached && deps.now() - cached.at < CATALOG_TTL_MS) return cached.info;
  const info = await s.driver.table(await tableOf(s, tableId));
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

const clampTimeout = (s: number | undefined, max = DBX_MAX_TIMEOUT_S) => Math.min(max, Math.max(DBX_MIN_TIMEOUT_S, Math.floor(s ?? DBX_STATEMENT_TIMEOUT_S)));

/** A statement as audited: literals masked (sqlStream maskSqlLiterals), cut. */
export function auditSql(family: DbFamily, sql: string, max = 500): string {
  // Masked on a bounded prefix (an unterminated literal at the cut is masked whole).
  const m = maskSqlLiterals(sql.length > max * 4 ? sql.slice(0, max * 4) : sql, family);
  return m.length > max ? `${m.slice(0, max)}…` : m;
}

// ── read-only statements (API keys, query exports) ───────────────────────────

const READ_KEYWORDS: Record<DbFamily, Set<string>> = {
  mysql: new Set(['select', 'with', 'show', 'describe', 'desc', 'explain', 'table', 'values']),
  postgresql: new Set(['select', 'with', 'show', 'explain', 'table', 'values']),
};

export { firstKeyword };

/**
 * Never read-only, whatever the engine accepts in a read-only transaction: they would outlive the
 * rollback (PREPARE, LISTEN, session settings, locks) or end / leave the transaction. Outside
 * READ_KEYWORDS anyway: listed so that the refusal says why, and kept refused if that list grows.
 */
const NEVER_READ_ONLY = new Set(['prepare', 'execute', 'deallocate', 'commit', 'rollback', 'abort', 'begin', 'start', 'end', 'savepoint', 'release', 'set',
  'reset', 'lock', 'unlock', 'listen', 'unlisten', 'notify', 'do', 'call', 'handler', 'load', 'discard', 'declare', 'fetch', 'move', 'close', 'xa']);

/**
 * ONE statement, and (readOnly) a reading one: a statement that would end the
 * read-only transaction (DDL and other implicit commits, CALL of a procedure
 * that commits, SET TRANSACTION…) never starts.
 */
export function singleStatement(family: DbFamily, sql: string, readOnly: boolean): string {
  const list = splitStatements(sql, family);
  if (list.length !== 1) throw new AppError(400, list.length ? 'One statement at a time' : 'No statement', 'oneStatement');
  const st = list[0].sql;
  const kw = firstKeyword(st, family);
  if (readOnly && NEVER_READ_ONLY.has(kw)) {
    throw new AppError(400, `Read-only: ${kw.toUpperCase()} never runs read-only (pass write: true to run it)`, 'readOnlyStatement');
  }
  if (readOnly && !READ_KEYWORDS[family].has(kw)) {
    throw new AppError(400, `Read-only: only ${[...READ_KEYWORDS[family]].map((k) => k.toUpperCase()).join(', ')} statements (pass write: true to change data)`, 'readOnlyStatement');
  }
  return st;
}

const TEXT_TYPES: Record<DbFamily, RegExp> = {
  mysql: /^(var)?char\b|text\b|^enum\b|^set\b|^json\b/i,
  postgresql: /^(character|text|citext|name|json|jsonb|uuid|xml)\b|^"?char"?\b/i,
};

function maintenanceStatements(family: DbFamily, op: DbxMaintenanceOp, tables: DbxTable[]): string[] {
  if (!DBX_MAINTENANCE_OPS[family].includes(op)) throw new AppError(400, `Not available on this engine: ${op}`, 'validation');
  const refs = tables.map((t) => tableRef(family, t));
  if (family === 'mysql') return [`${op.toUpperCase()} TABLE ${refs.join(', ')}`];
  const tpl: Record<string, (r: string) => string> = {
    vacuum: (r) => `VACUUM ${r}`, vacuumAnalyze: (r) => `VACUUM (ANALYZE) ${r}`, analyze: (r) => `ANALYZE ${r}`, reindex: (r) => `REINDEX TABLE ${r}`,
  };
  return refs.map(tpl[op]);
}

async function ddlContext(s: Session, req: DbxDdlRequest): Promise<DdlContext> {
  const ctx: DdlContext = { family: s.family };
  if ('table' in req && typeof req.table === 'string') ctx.table = await infoOf(s, req.table);
  if (req.op === 'addForeignKey') ctx.refTable = await infoOf(s, req.refTable);
  if (req.op === 'dropObject') {
    const o = (await s.driver.objects()).find((x) => x.kind === req.kind && x.id === req.id);
    if (!o) throw new AppError(404, 'Object not found', 'notFound');
    ctx.object = o;
  }
  return ctx;
}

async function importCaps(): Promise<{ importMax: number; exportMax: number }> {
  const s = await platformSettings.section('dbAdmin').catch(() => null);
  return {
    importMax: (s?.explorerImportMaxMb ?? DBX_IMPORT_DEFAULT_MAX_MB) * 1024 * 1024,
    exportMax: (s?.explorerExportMaxMb ?? DBX_EXPORT_DEFAULT_MAX_MB) * 1024 * 1024,
  };
}

/** Counts the uploaded bytes on their way to the import. */
function counter(onBytes: (n: number) => void): Transform {
  let n = 0;
  return new Transform({ transform(c: Buffer, _e, cb) { n += c.length; onBytes(n); cb(null, c); } });
}

export const explorerService = {
  info: (i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner): Promise<DbxInfo> => withSession(i, d, owner, async (s) => {
    s.version ??= await s.driver.version();
    return {
      engine: i.engine, version: s.version, database: d.name, user: s.username, maintenance: DBX_MAINTENANCE_OPS[s.family],
      importMaxBytes: (await deps.caps()).importMax,
    };
  }),

  tables: (i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner, refresh = false) => withSession(i, d, owner, async (s) => {
    if (refresh) dropCatalog(s);
    return tablesOf(s);
  }),

  table: (i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner, tableId: string) => withSession(i, d, owner, (s) => infoOf(s, tableId)),

  schema: (i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner): Promise<DbxSchema> => withSession(i, d, owner, async (s) => {
    const cols = await s.driver.columns();
    const tables: Record<string, string[]> = {};
    let n = 0;
    for (const [t, list] of cols) {
      if (++n > SCHEMA_MAX_TABLES) break;
      tables[t] = list.map((c) => c.name);
    }
    return { tables, truncated: cols.size > SCHEMA_MAX_TABLES };
  }),

  rows: (i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner, tableId: string, req: DbxRowsRequest): Promise<DbxRows> => withSession(i, d, owner, async (s) => {
    const info = await infoOf(s, tableId);
    const cols = [...(req.sort ? [req.sort] : []), ...(req.filters ?? []).map((f) => f.column)];
    checkColumns(info, cols, 'sort / filter');
    return s.driver.rows(info, { ...req, limit: Math.min(Math.max(1, req.limit), DBX_MAX_PAGE), offset: Math.max(0, req.offset) });
  }),

  insert: (i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner, tableId: string, values: Record<string, string | null>) => withSession(i, d, owner, async (s) => {
    const info = await infoOf(s, tableId);
    if (info.table.kind !== 'table') throw new AppError(409, 'A view cannot be edited from the grid', 'notEditable');
    checkValues(info, values);
    await s.driver.insert(info, values);
  }),

  update: (i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner, tableId: string, key: DbxRowKey, values: Record<string, string | null>) => withSession(i, d, owner, async (s) => {
    const info = await infoOf(s, tableId);
    editable(info);
    checkKey(info, key);
    checkValues(info, values);
    if (!Object.keys(values).length) return 0;
    return s.driver.update(info, key, values);
  }),

  remove: (i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner, tableId: string, keys: DbxRowKey[]) => withSession(i, d, owner, async (s) => {
    const info = await infoOf(s, tableId);
    editable(info);
    keys.forEach((k) => checkKey(info, k));
    return s.driver.remove(info, keys);
  }),

  query: (i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner, sql: string, timeoutS?: number): Promise<DbxQueryResponse> => withSession(i, d, owner, async (s) => {
    s.running = s.driver.connectionId();
    try {
      return await s.driver.run(sql, { timeoutS: clampTimeout(timeoutS) });
    } finally {
      s.running = null;
      dropCatalog(s); // the console may have changed the schema
    }
  }),

  /** Cancels the console statement running in the session (KILL QUERY / pg_cancel_backend from a side connection). */
  cancel: (i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner): Promise<{ cancelled: boolean }> => withSession(i, d, owner, async (s) => {
    const id = s.running;
    if (id === null) return { cancelled: false };
    return { cancelled: await withSide(s, (side) => side.cancel(id)) };
  }),

  ddlPreview: (i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner, req: DbxDdlRequest): Promise<DbxDdlPreview> => withSession(i, d, owner, async (s) => buildDdl(req, await ddlContext(s, req))),

  /** Regenerates the DDL from the request (never the client's text) and runs it. */
  ddlApply: (i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner, req: DbxDdlRequest) => withSession(i, d, owner, async (s) => {
    const preview = buildDdl(req, await ddlContext(s, req));
    try {
      const r = await s.driver.runList(preview.statements);
      return { ...r, statements: preview.statements };
    } finally {
      dropCatalog(s);
    }
  }),

  objects: (i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner): Promise<DbxObject[]> => withSession(i, d, owner, (s) => s.driver.objects()),

  objectDefinition: (i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner, kind: DbxObject['kind'], id: string): Promise<DbxObjectDefinition> => withSession(i, d, owner, async (s) => {
    const o = (await s.driver.objects()).find((x) => x.kind === kind && x.id === id);
    if (!o) throw new AppError(404, 'Object not found', 'notFound');
    const ddl = await s.driver.objectDefinition(o);
    if (ddl === null) throw new AppError(403, 'The definition of this object is not readable by the session user', 'definitionHidden');
    return { object: o, ddl };
  }),

  search: (i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner, req: DbxSearchRequest): Promise<DbxSearchResponse> => withSession(i, d, owner, async (s) => {
    const term = req.term;
    if (!term || term.length > 200) throw new AppError(400, 'Search: 1 to 200 characters', 'validation', { field: 'term' });
    const wanted = req.tables?.length ? new Set(req.tables) : null;
    const all = (await tablesOf(s)).filter((t) => !wanted || wanted.has(t.id));
    const cols = await s.driver.columns();
    const deadline = deps.now() + DBX_SEARCH_BUDGET_S * 1000;
    const hits: DbxSearchHit[] = [];
    // One byte budget for the whole search (every table), values cut to previews.
    const budget = new RowBudget(DBX_SEARCH_MAX_BYTES, DBX_TEXT_PREVIEW);
    let searched = 0;
    let skipped = 0;
    let timedOut = false;
    await s.driver.setTimeout(5);
    try {
      for (const [k, t] of all.entries()) {
        if (k >= DBX_SEARCH_MAX_TABLES) { skipped += all.length - k; break; }
        if (deps.now() > deadline) { timedOut = true; skipped += all.length - k; break; }
        const text = (cols.get(t.id) ?? []).filter((c) => TEXT_TYPES[s.family].test(c.type)).map((c) => c.name);
        if (!text.length) { skipped++; continue; }
        searched++;
        try {
          const r = await s.driver.search({ table: t } as DbxTableInfo, text, term, req.mode, DBX_SEARCH_ROWS_PER_TABLE, budget);
          if (r.rows.length) hits.push({ table: t.id, searchedColumns: text, columns: r.columns, rows: r.rows, more: r.truncated });
        } catch (err) {
          if (isConnectionError(sqlError(err))) throw err;
          skipped++; // timeout or unreadable table: skipped
          searched--;
        }
      }
    } finally {
      await s.driver.setTimeout(DBX_STATEMENT_TIMEOUT_S).catch(() => undefined);
    }
    return { hits, tablesSearched: searched, tablesSkipped: skipped, timedOut };
  }),

  maintenance: (i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner, op: DbxMaintenanceOp, tableIds: string[]) => withSession(i, d, owner, async (s) => {
    const tables = await Promise.all(tableIds.map((id) => tableOf(s, id)));
    if (!tables.length) throw new AppError(400, 'Select at least one table', 'validation', { field: 'tables' });
    try {
      return await s.driver.runList(maintenanceStatements(s.family, op, tables), { timeoutS: DBX_MAX_TIMEOUT_S });
    } finally {
      dropCatalog(s);
    }
  }),

  // ── export ─────────────────────────────────────────────────────────────────

  /** Checks the request and hands out a one-shot download ticket (the download itself is a plain GET). */
  prepareExport: (i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner, req: DbxExportRequest, urlBase: string): Promise<DbxExportTicket> => withSession(i, d, owner, async (s) => {
    const gzip = req.gzip === true;
    const delimiter = req.csvDelimiter ?? ',';
    const tables = await Promise.all((req.tables ?? []).map((id) => tableOf(s, id)));
    let t: Omit<Ticket, 'sessionKey' | 'expires'>;
    if (req.format === 'sql') {
      if (req.sql) throw new AppError(400, 'An SQL export dumps tables, not a query (use CSV or JSON)', 'validation', { field: 'sql' });
      const dump: DumpOptions = { tables, structure: req.structure !== false, data: req.data !== false, routines: req.routines !== false };
      explorerDumpArgv(i.engine, d.name, s.username, dump); // validates now (a GET cannot answer JSON errors well)
      t = {
        filename: exportFilename(d.name, tables.length === 1 ? tables[0].id : null, 'sql', gzip), format: 'sql', gzip, sql: null, readOnly: true, dump,
        delimiter, header: true, what: { tables: tables.map((x) => x.id), structure: dump.structure, data: dump.data },
      };
    } else {
      let sql: string;
      let readOnly = true;
      if (req.sql) {
        if (tables.length) throw new AppError(400, 'A table or a query, not both', 'validation', { field: 'sql' });
        sql = singleStatement(s.family, req.sql, true);
      } else {
        if (tables.length !== 1) throw new AppError(400, 'CSV / JSON: exactly one table', 'validation', { field: 'tables' });
        sql = `SELECT * FROM ${tableRef(s.family, tables[0])}`;
        readOnly = false; // a plain SELECT of a table
      }
      t = {
        filename: exportFilename(d.name, req.sql ? 'query' : tables[0].id, req.format, gzip), format: req.format, gzip, sql, readOnly, dump: null,
        delimiter, header: req.csvHeader !== false,
        what: req.sql ? { query: auditSql(s.family, req.sql) } : { tables: [tables[0].id] },
      };
    }
    // Unused tickets of the session stay few: the oldest goes.
    const mine = [...tickets].filter(([, x]) => x.sessionKey === s.key);
    for (const [k] of mine.slice(0, Math.max(0, mine.length - MAX_TICKETS_PER_SESSION + 1))) tickets.delete(k);
    const token = crypto.randomBytes(24).toString('hex');
    tickets.set(token, { ...t, sessionKey: s.key, expires: deps.now() + DBX_EXPORT_TICKET_S * 1000 });
    return { token, filename: t.filename, url: `${urlBase}/${token}` };
  }),

  /** Streams the export of a ticket to `res` (headers set here). Returns what to audit. */
  async runExport(i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner, token: string, res: Response): Promise<Record<string, unknown>> {
    const t = tickets.get(token);
    tickets.delete(token);
    if (!t || t.expires < deps.now() || t.sessionKey !== sessionKey(owner, i, d)) throw new AppError(404, 'Export link expired: start the export again', 'exportExpired');
    return withSession(i, d, owner, async (s) => {
      const { exportMax } = await deps.caps();
      const abort = new AbortController();
      const onClose = () => { if (!res.writableFinished) abort.abort(); };
      res.on('close', onClose);
      let bytes = 0;
      const cap = byteCap(exportMax, (n) => { bytes = n; });
      const sink: Writable = t.gzip ? cap.pipe(zlib.createGzip({ level: 6 })) as unknown as Writable : cap;
      const tail = t.gzip ? (sink as unknown as Transform) : cap;
      res.status(200);
      res.setHeader('Content-Type', t.gzip ? 'application/gzip' : t.format === 'sql' ? 'application/sql; charset=utf-8' : t.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${t.filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      tail.pipe(res);
      let rows: number | null = null;
      try {
        if (t.dump) await withSlot(s, () => deps.dump(i, d, s.username, s.password, t.dump!, cap, abort.signal));
        else {
          rows = await withSide(s, (side) => exportRows(side, t.sql!, cap, {
            format: t.format as 'csv' | 'json', readOnly: t.readOnly, timeoutS: EXPORT_TIMEOUT_S, delimiter: t.delimiter, header: t.header,
          }));
        }
        await new Promise<void>((resolve) => { res.once('finish', () => resolve()); res.once('close', () => resolve()); cap.end(); });
      } catch (err) {
        tail.unpipe(res);
        cap.destroy();
        if (!res.headersSent && !abort.signal.aborted) {
          res.removeHeader('Content-Disposition');
          res.removeHeader('Content-Type');
          throw sqlError(err);
        }
        logger.warn({ instanceId: i.id, err: (err as Error).message }, 'Explorer export cut');
        res.destroy();
        return { ...t.what, format: t.format, ok: false, bytes };
      } finally {
        res.off('close', onClose);
      }
      return { ...t.what, format: t.format, ok: true, bytes, ...(rows !== null ? { rows } : {}) };
    });
  },

  // ── import ─────────────────────────────────────────────────────────────────

  async startImport(i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner, body: Readable, contentType: string | undefined, contentLength: number | null, o: DbxImportOptions): Promise<DbxImportStatus> {
    return withSession(i, d, owner, async (s) => {
      if (s.importJob?.status.state === 'running') throw new AppError(409, 'An import is already running on this database', 'importRunning');
      // The job is the session's at once (no await since the check): a concurrent start sees it running.
      const previous = s.importJob;
      const status: DbxImportStatus = {
        id: crypto.randomBytes(8).toString('hex'), state: 'running', format: o.format, table: null, bytesRead: 0, totalBytes: contentLength,
        statements: 0, rows: 0, errorCount: 0, errors: [], startedAt: new Date(deps.now()).toISOString(), finishedAt: null, message: null,
      };
      const job: ImportJob = { status, cancel: false };
      s.importJob = job;
      let importMax: number;
      let info: DbxTableInfo | null;
      try {
        ({ importMax } = await deps.caps());
        if (contentLength !== null && contentLength > importMax) throw new AppError(413, `File larger than the import limit (${Math.round(importMax / 1048576)} MiB)`, 'importTooLarge');
        info = o.format === 'csv' ? await infoOf(s, o.table ?? '') : null;
        if (info && info.table.kind !== 'table') throw new AppError(409, 'CSV goes into a table, not a view', 'notEditable');
      } catch (err) {
        if (s.importJob === job) s.importJob = previous;
        throw err;
      }
      status.table = info?.table.id ?? null;
      if (info && s.family === 'mysql' && !dbxTransactionalEngine(info.table.engine)) {
        status.message = `${info.table.engine} table: not transactional, the rows inserted before an error are kept`;
      }
      const ctl = { status, cancelled: () => job.cancel };
      const counted = body.pipe(counter((n) => { status.bytesRead = n; }));
      body.on('error', (err) => counted.destroy(err));
      // The limit is the SQL / CSV text processed: a compressed upload buys no more (a small .gz of a huge
      // file would otherwise run for hours under the same limit).
      let input: Readable = restoreSqlStream(counted, contentType, { maxBytes: importMax, maxInflatedBytes: importMax });
      if (o.format === 'sql' && s.family === 'mysql') {
        // DEFINER clauses removed: the session user may not name another definer.
        const src = input;
        input = src.pipe(createRestoreRewriter('mysql'));
        src.on('error', (err) => input.destroy(err));
      }
      try {
        await withSide(s, async (side) => {
          await side.setTimeout(IMPORT_STATEMENT_TIMEOUT_S);
          if (o.format === 'sql') await runSqlImport(side, s.family, input, ctl, o.continueOnError === true);
          else {
            await runCsvImport(side, s.family, info!, input, ctl, {
              delimiter: o.csvDelimiter ?? ',', header: o.csvHeader !== false, columns: o.columns ?? null, emptyNull: o.csvEmptyNull === true,
              continueOnError: o.continueOnError === true, transactional: s.family === 'postgresql' || dbxTransactionalEngine(info!.table.engine),
            });
          }
        });
        status.state = job.cancel ? 'cancelled' : status.errorCount && !o.continueOnError ? 'failed' : 'done';
        if (o.format === 'sql' && s.family === 'mysql') {
          // DEFINER clauses were removed: views / routines in SQL SECURITY DEFINER, triggers and events now run as this
          // session's temporary user, and break once it is dropped. Said, never silently.
          let orphans: DbxObject[] = [];
          try { orphans = (await s.driver.objects()).filter((x) => x.ephemeralDefiner && !!x.definer?.includes(s.username)); } catch { /* catalog not readable: no note */ }
          if (orphans.length) {
            status.message = `${status.message ? `${status.message}. ` : ''}${orphans.length} object(s) (${orphans.slice(0, 5).map((x) => x.name).join(', ')}${orphans.length > 5 ? '…' : ''}) have the temporary SQL user of this session as DEFINER and will stop working when the session ends: recreate them with SQL SECURITY INVOKER, or restore the dump from the database page (permanent definer).`;
          }
        }
      } catch (err) {
        status.state = 'failed';
        status.message = err instanceof AppError ? err.message : sqlError(err).message;
        input.resume();
      } finally {
        status.finishedAt = new Date(deps.now()).toISOString();
        dropCatalog(s);
      }
      return status;
    });
  },

  importStatus: async (i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner): Promise<DbxImportStatus | null> => {
    const p = sessions.get(sessionKey(owner, i, d));
    const s = p ? await p.p.catch(() => null) : null;
    return s?.importJob?.status ?? null;
  },

  cancelImport: async (i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner): Promise<boolean> => {
    const p = sessions.get(sessionKey(owner, i, d));
    const s = p ? await p.p.catch(() => null) : null;
    if (!s?.importJob || s.importJob.status.state !== 'running') return false;
    s.importJob.cancel = true;
    return true;
  },

  // ── API keys ───────────────────────────────────────────────────────────────

  /** ONE statement for an API key: read-only (transaction rolled back) unless write; rows / bytes capped. */
  keyQuery: (i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner, sql: string, o: { write: boolean; maxRows?: number; timeoutS?: number }): Promise<ApiV1DbQueryResult & { statement: string }> => withSession(i, d, owner, async (s) => {
    const statement = singleStatement(s.family, sql, !o.write);
    const t0 = Date.now();
    try {
      const r = await s.driver.runOne(statement, {
        readOnly: !o.write, maxRows: Math.min(DBX_KEY_MAX_ROWS, Math.max(1, Math.floor(o.maxRows ?? DBX_KEY_MAX_ROWS))), maxBytes: DBX_KEY_MAX_BYTES,
        timeoutS: clampTimeout(o.timeoutS ?? 15, DBX_KEY_MAX_TIMEOUT_S),
      });
      return {
        statement, readOnly: !o.write, columns: r.columns, rows: r.columns ? r.rows : null, rowCount: r.rows.length, truncated: r.truncated,
        affectedRows: r.affectedRows, durationMs: Date.now() - t0,
      };
    } finally {
      if (o.write) dropCatalog(s);
    }
  }),

  close: (i: DbInstanceRow, d: DbDatabaseRow, owner: SessionOwner) => closeSession(sessionKey(owner, i, d)),
};
