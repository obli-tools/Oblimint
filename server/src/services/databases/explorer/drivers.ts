import mysql from 'mysql2';
import pg from 'pg';
import type {
  DbFamily, DbxCell, DbxColumn, DbxFilter, DbxForeignKey, DbxIncomingKey, DbxIndex, DbxObject, DbxObjectKind, DbxQueryResult, DbxRowKey, DbxRows,
  DbxRowsRequest, DbxTable, DbxTableInfo,
} from '@oblimint/shared';
import { DBX_BINARY_PREVIEW, DBX_MAX_QUERY_ROWS, DBX_STATEMENT_TIMEOUT_S, DBX_TEXT_MAX, DBX_TEXT_PREVIEW } from '@oblimint/shared';
import { SSO_USER_PREFIX } from '../sql';
import { splitSql } from './splitSql';

// ─────────────────────────────────────────────────────────────────────────────
// SQL drivers of the database explorer: one connection per explorer session
// (plus short-lived side connections of the same ephemeral user for exports,
// imports and query cancellation), over the instance's local socket. Every
// statement is time-limited (engine setting), result rows are capped
// (DBX_MAX_QUERY_ROWS: the rest is read and discarded), big values are cut
// (DBX_TEXT_MAX / DBX_BINARY_PREVIEW) except in exports (raw values).
// Identifiers come from the catalog (the caller resolves a table id against
// tables() first) and are quoted; values are always bound parameters.
// ─────────────────────────────────────────────────────────────────────────────

export interface RunOptions {
  /** Statement time limit of this run (seconds; default DBX_STATEMENT_TIMEOUT_S). */
  timeoutS?: number;
}

export interface RunOneOptions extends RunOptions {
  /** Read-only transaction (rolled back), whatever the statement. */
  readOnly: boolean;
  maxRows: number;
  /** Rows stop being kept past this many bytes of JSON. */
  maxBytes: number;
}

export interface RunOneResult {
  columns: string[] | null;
  rows: DbxCell[][];
  truncated: boolean;
  affectedRows: number | null;
}

/** Export rows: raw values (strings, numbers, booleans, Buffers for binary), never cut. */
export interface RowSink {
  columns(names: string[]): void | Promise<void>;
  /** A promise = backpressure (reading pauses until it resolves). */
  row(values: unknown[]): void | Promise<void>;
}

export type SessionObject = DbxObject;

export interface ColumnOverview {
  name: string;
  type: string;
}

export interface ExplorerDriver {
  family: DbFamily;
  /** Connection / backend id (MySQL thread id, PostgreSQL backend pid). */
  connectionId(): number | null;
  version(): Promise<string | null>;
  tables(): Promise<DbxTable[]>;
  table(t: DbxTable): Promise<DbxTableInfo>;
  /** Every column of every table (autocomplete, search), one query. */
  columns(): Promise<Map<string, ColumnOverview[]>>;
  rows(info: DbxTableInfo, req: DbxRowsRequest): Promise<DbxRows>;
  insert(info: DbxTableInfo, values: Record<string, string | null>): Promise<void>;
  update(info: DbxTableInfo, key: DbxRowKey, values: Record<string, string | null>): Promise<number>;
  remove(info: DbxTableInfo, keys: DbxRowKey[]): Promise<number>;
  /** Console input (split, run in order, stops at the first error). */
  run(sql: string, opts?: RunOptions): Promise<{ results: DbxQueryResult[]; stopped: boolean }>;
  /** Statements built by the server (DDL, maintenance): same behaviour as run(). */
  runList(statements: string[], opts?: RunOptions): Promise<{ results: DbxQueryResult[]; stopped: boolean }>;
  /** ONE statement (API keys): optionally in a read-only transaction rolled back; PostgreSQL extended protocol (one statement only). */
  runOne(sql: string, opts: RunOneOptions): Promise<RunOneResult>;
  /** Objects: views, routines, triggers, events. */
  objects(): Promise<DbxObject[]>;
  objectDefinition(o: DbxObject): Promise<string | null>;
  /** Up to `limit` rows of `info` where a text column matches. */
  search(info: DbxTableInfo, columns: string[], term: string, mode: 'contains' | 'exact', limit: number): Promise<{ columns: string[]; rows: DbxCell[][] }>;
  /** Streams the rows of a SELECT (readOnly: in a read-only transaction). Side connections only (holds the connection). */
  stream(sql: string, sink: RowSink, opts: { readOnly: boolean; timeoutS: number }): Promise<number>;
  /** Import: one statement, rows discarded. */
  exec(sql: string): Promise<number | null>;
  /** Import: INSERT INTO target (columns) VALUES … for a batch (values bound). `target` / `columnsSql` already quoted. */
  insertRows(target: string, columnsSql: string | null, rows: unknown[][]): Promise<number>;
  /** Sets the statement time limit of the connection (seconds, 0 = none). */
  setTimeout(seconds: number): Promise<void>;
  /** Cancels the running statement of another connection of the same user (KILL QUERY / pg_cancel_backend). */
  cancel(connectionId: number): Promise<boolean>;
  close(): Promise<void>;
}

/** Exact counts below this estimate (above: the engine estimate, approximate). */
const EXACT_COUNT_BELOW = 200_000;

export function longText(s: string): DbxCell {
  return s.length > DBX_TEXT_MAX ? { long: true, text: s.slice(0, DBX_TEXT_PREVIEW), size: s.length } : s;
}

export function binaryCell(buf: Buffer): DbxCell {
  return { binary: true, hex: buf.subarray(0, DBX_BINARY_PREVIEW).toString('hex'), size: buf.length, truncated: buf.length > DBX_BINARY_PREVIEW };
}

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Serializes the operations of a session (one connection). */
function serial() {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => undefined);
    return p;
  };
}

interface ResultSet {
  columns: string[];
  rows: DbxCell[][];
  truncated: boolean;
}

export interface StreamResult {
  columns: string[] | null;
  rows: DbxCell[][];
  truncated: boolean;
  affectedRows: number | null;
  insertId: string | null;
  /** Further result sets of the same statement (MySQL CALL). */
  more?: ResultSet[];
}

/** LIKE pattern of a text: \ % _ escaped (both engines use \ as the default escape). */
export function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Approximate JSON size of a row (byte caps). */
export function rowBytes(row: DbxCell[]): number {
  let n = 2;
  for (const c of row) {
    if (c === null) n += 5;
    else if (typeof c === 'string') n += c.length + 3;
    else if (typeof c === 'object') n += ('hex' in c ? c.hex.length : c.text.length) + 48;
    else n += 8;
  }
  return n;
}

const isEphemeral = (definer: string | null) => !!definer && definer.replace(/^[`'"]/, '').startsWith(SSO_USER_PREFIX);

// ── MySQL / MariaDB ──────────────────────────────────────────────────────────

export const qMy = (id: string) => `\`${id.replace(/`/g, '``')}\``;

const MY_BINARY_TYPES = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'geometry', 'point', 'linestring', 'polygon',
  'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection', 'bit']);

/** mysql2 values → cells: Buffers (BLOB, BINARY, BIT) as hex, parsed JSON / geometry back to text. */
export function myCell(v: unknown): DbxCell {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return binaryCell(v);
  if (typeof v === 'string') return longText(v);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return longText(JSON.stringify(v));
}

/** Raw export value of mysql2 (Buffers kept). */
const myRaw = (v: unknown): unknown => (v === null || v === undefined || Buffer.isBuffer(v) || typeof v !== 'object' ? v ?? null : JSON.stringify(v));

export interface MysqlConnectOptions {
  socketPath?: string;
  host?: string;
  port?: number;
  user: string;
  password: string;
  database: string;
  mariadb: boolean;
}

export async function connectMysql(opts: MysqlConnectOptions): Promise<ExplorerDriver> {
  const conn = mysql.createConnection({
    ...(opts.socketPath ? { socketPath: opts.socketPath } : { host: opts.host, port: opts.port }),
    user: opts.user, password: opts.password, database: opts.database,
    multipleStatements: false, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, connectTimeout: 10_000, charset: 'utf8mb4',
  });
  // A fatal error (server gone) must never be an unhandled 'error' event: the next query fails, the session is recreated.
  conn.on('error', () => { /* see above */ });
  await new Promise<void>((resolve, reject) => conn.connect((err) => (err ? reject(err) : resolve())));
  const run1 = (sql: string, values: unknown[] = [], cap = DBX_MAX_QUERY_ROWS) => new Promise<StreamResult>((resolve, reject) => {
    const res: StreamResult = { columns: null, rows: [], truncated: false, affectedRows: null, insertId: null };
    let current: ResultSet | null = null;
    const q = conn.query({ sql, values, rowsAsArray: true });
    q.on('error', reject);
    q.on('fields', (fields?: Array<{ name: string }>) => {
      if (!fields) return;
      if (!res.columns) { res.columns = fields.map((f) => f.name); current = null; return; }
      current = { columns: fields.map((f) => f.name), rows: [], truncated: false };
      (res.more ??= []).push(current);
    });
    q.on('result', (row: unknown) => {
      if (Array.isArray(row)) {
        const target = current ?? res;
        if (target.rows.length < cap) target.rows.push(row.map(myCell));
        else target.truncated = true;
      } else if (row && typeof row === 'object') {
        const h = row as { affectedRows?: number; insertId?: number | string };
        res.affectedRows = h.affectedRows ?? null;
        res.insertId = h.insertId ? String(h.insertId) : null;
      }
    });
    q.on('end', () => resolve(res));
  });
  const exclusive = serial();
  const rows = <T = unknown[]>(sql: string, values: unknown[] = []) => run1(sql, values, 100_000).then((r) => r.rows as unknown as T[]);
  let timeoutNow = -1;
  const setTimeoutS = async (s: number) => {
    if (s === timeoutNow) return;
    await run1(opts.mariadb ? `SET SESSION max_statement_time = ${Math.max(0, Math.floor(s))}` : `SET SESSION max_execution_time = ${Math.max(0, Math.floor(s)) * 1000}`);
    timeoutNow = s;
  };
  await setTimeoutS(DBX_STATEMENT_TIMEOUT_S);
  const withTimeout = async <T>(o: RunOptions | undefined, fn: () => Promise<T>): Promise<T> => {
    const want = o?.timeoutS ?? DBX_STATEMENT_TIMEOUT_S;
    await setTimeoutS(want);
    try { return await fn(); } finally { if (want !== DBX_STATEMENT_TIMEOUT_S) await setTimeoutS(DBX_STATEMENT_TIMEOUT_S).catch(() => undefined); }
  };

  const where = (filters: DbxFilter[] | undefined, values: unknown[]) => {
    const parts: string[] = [];
    for (const f of filters ?? []) {
      const c = qMy(f.column);
      if (f.op === 'null') parts.push(`${c} IS NULL`);
      else if (f.op === 'not null') parts.push(`${c} IS NOT NULL`);
      else { parts.push(`${c} ${f.op.toUpperCase()} ?`); values.push(f.value ?? ''); }
    }
    return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
  };
  const keyWhere = (info: DbxTableInfo, key: DbxRowKey, values: unknown[]) => info.primaryKey.map((c) => {
    const v = key[c];
    if (v === null || v === undefined) return `${qMy(c)} IS NULL`;
    values.push(v);
    return `${qMy(c)} = ?`;
  }).join(' AND ');

  const SHOW_CREATE: Record<DbxObjectKind, { what: string; field: string }> = {
    view: { what: 'VIEW', field: 'Create View' },
    procedure: { what: 'PROCEDURE', field: 'Create Procedure' },
    function: { what: 'FUNCTION', field: 'Create Function' },
    trigger: { what: 'TRIGGER', field: 'SQL Original Statement' },
    event: { what: 'EVENT', field: 'Create Event' },
  };

  const driver: ExplorerDriver = {
    family: 'mysql',
    connectionId: () => conn.threadId ?? null,
    version: () => exclusive(async () => String((await rows<[string]>('SELECT VERSION()'))[0]?.[0] ?? '') || null),

    tables: () => exclusive(async () => {
      const r = await rows<[string, string, string | null, string | null, string | null, string | null]>(
        'SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH, ENGINE, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME');
      return r.map(([name, type, n, bytes, engine, comment]) => ({
        id: name, name, schema: null, kind: type === 'VIEW' ? 'view' : 'table',
        rows: n === null ? null : Number(n), bytes: bytes === null ? null : Number(bytes), engine: engine || null, comment: comment || null,
      }));
    }),

    table: (t) => exclusive(async () => {
      const cols = await rows<[string, string, string, string | null, string, string, string, string, string | null]>(
        'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT, DATA_TYPE, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [t.name]);
      const columns: DbxColumn[] = cols.map(([name, type, nullable, def, key, extra, comment, dataType, collation]) => ({
        name, type, nullable: nullable === 'YES', default: def, primary: key === 'PRI', autoIncrement: /auto_increment/i.test(extra),
        comment: comment || null, binary: MY_BINARY_TYPES.has(dataType.toLowerCase()), collation: collation || null, extra: extra || null,
      }));
      const idx = await rows<[string, string | number, string]>(
        'SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX', [t.name]);
      const byIndex = new Map<string, DbxIndex>();
      for (const [name, nonUnique, col] of idx) {
        const i = byIndex.get(name) ?? { name, columns: [], unique: Number(nonUnique) === 0, primary: name === 'PRIMARY', definition: null };
        i.columns.push(col);
        byIndex.set(name, i);
      }
      const fk = await rows<[string, string, string, string, string, string]>(
        `SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE, r.UPDATE_RULE
           FROM information_schema.KEY_COLUMN_USAGE k
           JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
          WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
          ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, [t.name]);
      const byFk = new Map<string, DbxForeignKey>();
      for (const [name, col, refTable, refCol, onDelete, onUpdate] of fk) {
        const f = byFk.get(name) ?? { name, columns: [], refTable, refColumns: [], onDelete, onUpdate };
        f.columns.push(col);
        f.refColumns.push(refCol);
        byFk.set(name, f);
      }
      const inc = await rows<[string, string, string, string]>(
        `SELECT CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = ?
          ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`, [t.name]);
      const byInc = new Map<string, DbxIncomingKey>();
      for (const [name, table, col, refCol] of inc) {
        const k = `${table}\u0000${name}`;
        const f = byInc.get(k) ?? { name, table, columns: [], refColumns: [] };
        f.columns.push(col);
        f.refColumns.push(refCol);
        byInc.set(k, f);
      }
      let ddl: string | null = null;
      try {
        const r = await rows<string[]>(`SHOW CREATE ${t.kind === 'view' ? 'VIEW' : 'TABLE'} ${qMy(t.name)}`);
        ddl = r[0]?.[1] ? String(r[0][1]) : null;
      } catch { /* no SHOW VIEW privilege: no DDL */ }
      const primaryKey = byIndex.get('PRIMARY')?.columns ?? [];
      return { table: t, columns, indexes: [...byIndex.values()], foreignKeys: [...byFk.values()], primaryKey, ddl, incoming: [...byInc.values()] };
    }),

    columns: () => exclusive(async () => {
      const r = await rows<[string, string, string]>(
        'SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION');
      const m = new Map<string, ColumnOverview[]>();
      for (const [t, c, type] of r) {
        const l = m.get(t) ?? [];
        l.push({ name: c, type });
        m.set(t, l);
      }
      return m;
    }),

    rows: (info, req) => exclusive(async () => {
      const values: unknown[] = [];
      const w = where(req.filters, values);
      const order = req.sort ? ` ORDER BY ${qMy(req.sort)} ${req.dir === 'desc' ? 'DESC' : 'ASC'}` : info.primaryKey.length ? ` ORDER BY ${info.primaryKey.map(qMy).join(', ')}` : '';
      const r = await run1(`SELECT * FROM ${qMy(info.table.name)}${w}${order} LIMIT ? OFFSET ?`, [...values, req.limit, req.offset], req.limit);
      let total: number | null = null;
      let approximate = false;
      const estimate = info.table.rows;
      if (!w && estimate !== null && estimate >= EXACT_COUNT_BELOW && info.table.kind === 'table') { total = estimate; approximate = true; }
      else {
        try { total = Number((await rows<[string]>(`SELECT COUNT(*) FROM ${qMy(info.table.name)}${w}`, values))[0]?.[0] ?? 0); } catch { total = estimate; approximate = true; }
      }
      return { columns: r.columns ?? info.columns.map((c) => c.name), rows: r.rows, total, approximate, offset: req.offset, limit: req.limit };
    }),

    insert: (info, vals) => exclusive(async () => {
      const cols = Object.keys(vals);
      const sql = cols.length
        ? `INSERT INTO ${qMy(info.table.name)} (${cols.map(qMy).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
        : `INSERT INTO ${qMy(info.table.name)} () VALUES ()`;
      await run1(sql, cols.map((c) => vals[c]));
    }),

    update: (info, key, vals) => exclusive(async () => {
      const values: unknown[] = Object.values(vals);
      const set = Object.keys(vals).map((c) => `${qMy(c)} = ?`).join(', ');
      const r = await run1(`UPDATE ${qMy(info.table.name)} SET ${set} WHERE ${keyWhere(info, key, values)} LIMIT 1`, values);
      return r.affectedRows ?? 0;
    }),

    remove: (info, keys) => exclusive(async () => {
      let n = 0;
      await run1('START TRANSACTION');
      try {
        for (const key of keys) {
          const values: unknown[] = [];
          const r = await run1(`DELETE FROM ${qMy(info.table.name)} WHERE ${keyWhere(info, key, values)} LIMIT 1`, values);
          n += r.affectedRows ?? 0;
        }
        await run1('COMMIT');
      } catch (err) {
        await run1('ROLLBACK').catch(() => undefined);
        throw err;
      }
      return n;
    }),

    run: (sql, o) => driver.runList(splitSql(sql, 'mysql'), o),

    runList: (statements, o) => exclusive(() => withTimeout(o, () => runStatements(statements, (s) => run1(s)))),

    runOne: (sql, o) => exclusive(() => withTimeout(o, async () => {
      if (o.readOnly) {
        // Session characteristic too: a statement that ends the transaction cannot leave read-only mode.
        await run1('SET SESSION TRANSACTION READ ONLY');
        await run1('START TRANSACTION READ ONLY');
      }
      try {
        const r = await run1(sql, [], o.maxRows + 1);
        return capRows(r, o);
      } finally {
        if (o.readOnly) {
          await run1('ROLLBACK').catch(() => undefined);
          await run1('SET SESSION TRANSACTION READ WRITE').catch(() => undefined);
        }
      }
    })),

    objects: () => exclusive(async () => {
      const out: DbxObject[] = [];
      const base = { schema: null, table: null, args: null };
      for (const [name, definer, security] of await rows<[string, string, string]>(
        'SELECT TABLE_NAME, DEFINER, SECURITY_TYPE FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME')) {
        out.push({ ...base, kind: 'view', id: name, name, detail: `SQL SECURITY ${security}`, definer, ephemeralDefiner: security === 'DEFINER' && isEphemeral(definer) });
      }
      for (const [name, type, definer, returns, security] of await rows<[string, string, string, string | null, string]>(
        'SELECT ROUTINE_NAME, ROUTINE_TYPE, DEFINER, DTD_IDENTIFIER, SECURITY_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() ORDER BY ROUTINE_TYPE, ROUTINE_NAME')) {
        const kind = type === 'FUNCTION' ? 'function' : 'procedure';
        out.push({ ...base, kind, id: name, name, detail: [returns ? `RETURNS ${returns}` : null, `SQL SECURITY ${security}`].filter(Boolean).join(' · '), definer, ephemeralDefiner: security === 'DEFINER' && isEphemeral(definer) });
      }
      for (const [name, event, timing, table, definer] of await rows<[string, string, string, string, string]>(
        'SELECT TRIGGER_NAME, EVENT_MANIPULATION, ACTION_TIMING, EVENT_OBJECT_TABLE, DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME')) {
        out.push({ ...base, kind: 'trigger', id: name, name, table, detail: `${timing} ${event}`, definer, ephemeralDefiner: isEphemeral(definer) });
      }
      try {
        for (const [name, definer, ivalue, ifield, at, status] of await rows<[string, string, string | null, string | null, string | null, string]>(
          'SELECT EVENT_NAME, DEFINER, INTERVAL_VALUE, INTERVAL_FIELD, EXECUTE_AT, STATUS FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE() ORDER BY EVENT_NAME')) {
          out.push({ ...base, kind: 'event', id: name, name, detail: `${ivalue ? `EVERY ${ivalue} ${ifield}` : `AT ${at}`} · ${status}`, definer, ephemeralDefiner: isEphemeral(definer) });
        }
      } catch { /* no EVENT privilege */ }
      return out;
    }),

    objectDefinition: (o) => exclusive(async () => {
      const s = SHOW_CREATE[o.kind];
      const r = await run1(`SHOW CREATE ${s.what} ${qMy(o.name)}`, [], 1);
      const i = r.columns?.indexOf(s.field) ?? -1;
      const v = i >= 0 ? r.rows[0]?.[i] : null;
      return typeof v === 'string' ? v : v && typeof v === 'object' && 'text' in v ? v.text : null;
    }),

    search: (info, columns, term, mode, limit) => exclusive(async () => {
      const values: unknown[] = [];
      const cond = columns.map((c) => { values.push(mode === 'exact' ? term : likeContains(term)); return `${qMy(c)} ${mode === 'exact' ? '=' : 'LIKE'} ?`; }).join(' OR ');
      const r = await run1(`SELECT * FROM ${qMy(info.table.name)} WHERE ${cond} LIMIT ${Math.floor(limit)}`, values, limit);
      return { columns: r.columns ?? [], rows: r.rows };
    }),

    stream: (sql, sink, o) => exclusive(async () => {
      await setTimeoutS(o.timeoutS);
      if (o.readOnly) await run1('START TRANSACTION READ ONLY');
      try {
        return await new Promise<number>((resolve, reject) => {
          let n = 0;
          let failed = false;
          let pending: Promise<void> = Promise.resolve();
          const q = conn.query({ sql, rowsAsArray: true, typeCast: true });
          const fail = (e: unknown) => { if (!failed) { failed = true; reject(e); } };
          q.on('error', fail);
          q.on('fields', (fields?: Array<{ name: string }>) => {
            if (!fields) return;
            const p = sink.columns(fields.map((f) => f.name));
            if (p) { conn.pause(); pending = p.then(() => conn.resume(), fail); }
          });
          q.on('result', (row: unknown) => {
            if (!Array.isArray(row) || failed) return;
            n++;
            const p = sink.row(row.map(myRaw));
            if (p) { conn.pause(); pending = p.then(() => conn.resume(), (e) => { fail(e); conn.resume(); }); }
          });
          q.on('end', () => { void pending.then(() => { if (!failed) resolve(n); }); });
        });
      } finally {
        if (o.readOnly) await run1('ROLLBACK').catch(() => undefined);
      }
    }),

    exec: (sql) => exclusive(async () => (await run1(sql, [], 0)).affectedRows),

    insertRows: (target, columnsSql, rws) => exclusive(async () => {
      if (!rws.length) return 0;
      const values: unknown[] = [];
      const tuples = rws.map((r) => { values.push(...r); return `(${r.map(() => '?').join(', ')})`; }).join(', ');
      const res = await run1(`INSERT INTO ${target}${columnsSql ? ` (${columnsSql})` : ''} VALUES ${tuples}`, values, 0);
      return res.affectedRows ?? rws.length;
    }),

    setTimeout: (s) => exclusive(() => setTimeoutS(s)),

    cancel: (id) => exclusive(async () => {
      try { await run1('KILL QUERY ?', [id]); return true; } catch { return false; }
    }),

    close: () => new Promise<void>((resolve) => conn.end(() => resolve())),
  };
  return driver;
}

// ── PostgreSQL ───────────────────────────────────────────────────────────────

export const qPg = (id: string) => `"${id.replace(/"/g, '""')}"`;
const qPgTable = (t: Pick<DbxTable, 'schema' | 'name'>) => `${qPg(t.schema ?? 'public')}.${qPg(t.name)}`;
const PG_RULES: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
const BYTEA_OID = 17;
const BOOL_OID = 16;
const pgId = (schema: string, name: string) => (schema === 'public' ? name : `${schema}.${name}`);

export interface PostgresConnectOptions {
  socketDir?: string;
  host?: string;
  port?: number;
  user: string;
  password: string;
  database: string;
}

export async function connectPostgres(opts: PostgresConnectOptions): Promise<ExplorerDriver> {
  const types = {
    getTypeParser: (oid: number) => {
      if (oid === BYTEA_OID) return (v: string) => (v.startsWith('\\x') ? binaryCell(Buffer.from(v.slice(2), 'hex')) : longText(v));
      if (oid === BOOL_OID) return (v: string) => v === 't';
      return (v: string) => longText(v);
    },
  };
  // Exports: raw values (bytea as a Buffer, the rest as text).
  const rawTypes = {
    getTypeParser: (oid: number) => {
      if (oid === BYTEA_OID) return (v: string) => (v.startsWith('\\x') ? Buffer.from(v.slice(2), 'hex') : v);
      if (oid === BOOL_OID) return (v: string) => v === 't';
      return (v: string) => v;
    },
  };
  const client = new pg.Client({
    ...(opts.socketDir ? { host: opts.socketDir, port: 5432 } : { host: opts.host, port: opts.port }),
    user: opts.user, password: opts.password, database: opts.database,
    connectionTimeoutMillis: 10_000, types: types as unknown as pg.CustomTypesConfig, application_name: 'oblimint-explorer',
  });
  await client.connect();
  client.on('error', () => { /* a dropped connection fails the next query; the session is then recreated */ });
  const pid = (client as unknown as { processID?: number }).processID ?? null;

  const run1 = (text: string, values: unknown[] = [], cap = DBX_MAX_QUERY_ROWS, extended = false) => new Promise<StreamResult>((resolve, reject) => {
    const res: StreamResult = { columns: null, rows: [], truncated: false, affectedRows: null, insertId: null };
    const q = new pg.Query({ text, values, rowMode: 'array', types: types as unknown as pg.CustomTypesConfig, ...(extended ? { queryMode: 'extended' } : {}) } as pg.QueryConfig);
    q.on('row', (row: DbxCell[], result?: { fields?: Array<{ name: string }> }) => {
      if (!res.columns && result?.fields) res.columns = result.fields.map((f) => f.name);
      if (res.rows.length < cap) res.rows.push(row); else res.truncated = true;
    });
    q.on('error', reject);
    q.on('end', (result: { fields?: Array<{ name: string }>; rowCount?: number | null; command?: string }) => {
      if (!res.columns && result?.fields?.length) res.columns = result.fields.map((f) => f.name);
      if (!res.columns) res.affectedRows = result?.rowCount ?? null;
      resolve(res);
    });
    client.query(q as unknown as pg.QueryConfig);
  });
  const exclusive = serial();
  const rows = <T = unknown[]>(text: string, values: unknown[] = []) => run1(text, values, 100_000).then((r) => r.rows as unknown as T[]);
  const str = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'object' && v && 'text' in v ? String((v as { text: string }).text) : String(v));
  let timeoutNow = -1;
  const setTimeoutS = async (s: number) => {
    if (s === timeoutNow) return;
    await run1(`SET statement_timeout = '${Math.max(0, Math.floor(s))}s'`);
    timeoutNow = s;
  };
  await setTimeoutS(DBX_STATEMENT_TIMEOUT_S);
  const withTimeout = async <T>(o: RunOptions | undefined, fn: () => Promise<T>): Promise<T> => {
    const want = o?.timeoutS ?? DBX_STATEMENT_TIMEOUT_S;
    await setTimeoutS(want);
    try { return await fn(); } finally { if (want !== DBX_STATEMENT_TIMEOUT_S) await setTimeoutS(DBX_STATEMENT_TIMEOUT_S).catch(() => undefined); }
  };

  const where = (filters: DbxFilter[] | undefined, values: unknown[]) => {
    const parts: string[] = [];
    for (const f of filters ?? []) {
      const c = qPg(f.column);
      if (f.op === 'null') parts.push(`${c} IS NULL`);
      else if (f.op === 'not null') parts.push(`${c} IS NOT NULL`);
      else if (f.op === 'like' || f.op === 'not like') { values.push(f.value ?? ''); parts.push(`${c}::text ${f.op === 'like' ? 'ILIKE' : 'NOT ILIKE'} $${values.length}`); }
      else { values.push(f.value ?? ''); parts.push(`${c}::text ${f.op} $${values.length}`); }
    }
    return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
  };
  const keyWhere = (info: DbxTableInfo, key: DbxRowKey, values: unknown[]) => info.primaryKey.map((c) => {
    const v = key[c];
    if (v === null || v === undefined) return `${qPg(c)} IS NULL`;
    values.push(v);
    return `${qPg(c)}::text = $${values.length}`;
  }).join(' AND ');
  const USER_SCHEMAS = `n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'`;

  const driver: ExplorerDriver = {
    family: 'postgresql',
    connectionId: () => pid,
    version: () => exclusive(async () => str((await rows<unknown[]>('SHOW server_version'))[0]?.[0])),

    tables: () => exclusive(async () => {
      const r = await rows<unknown[]>(`
        SELECT n.nspname, c.relname, c.relkind, c.reltuples::bigint,
               CASE WHEN c.relkind IN ('r','m','p') THEN pg_total_relation_size(c.oid) END, obj_description(c.oid, 'pg_class')
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r','v','m','p','f') AND ${USER_SCHEMAS}
           AND has_table_privilege(c.oid, 'SELECT')
         ORDER BY n.nspname = 'public' DESC, n.nspname, c.relname`);
      return r.map(([schema, name, kind, n, bytes, comment]) => {
        const s = str(schema)!;
        const nm = str(name)!;
        const est = n === null ? null : Number(str(n));
        const k = str(kind);
        return {
          id: pgId(s, nm), name: nm, schema: s, kind: k === 'v' || k === 'm' ? 'view' : 'table', ...(k === 'm' ? { materialized: true } : {}),
          rows: est !== null && est >= 0 ? est : null, bytes: bytes === null ? null : Number(str(bytes)), engine: null, comment: str(comment),
        } satisfies DbxTable;
      });
    }),

    table: (t) => exclusive(async () => {
      const rel = qPgTable(t);
      const cols = await rows<unknown[]>(`
        SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, pg_get_expr(d.adbin, d.adrelid),
               col_description(a.attrelid, a.attnum), a.atttypid = ${BYTEA_OID},
               a.attidentity <> '' OR COALESCE(pg_get_expr(d.adbin, d.adrelid), '') LIKE 'nextval(%', a.attidentity <> ''
          FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [rel]);
      const pk = (await rows<unknown[]>(`
        SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`, [rel])).map((r) => str(r[0])!);
      const columns: DbxColumn[] = cols.map(([name, type, nullable, def, comment, bin, auto, identity]) => ({
        name: str(name)!, type: str(type)!, nullable: nullable === true, default: str(def), primary: pk.includes(str(name)!),
        autoIncrement: auto === true, comment: str(comment), binary: bin === true, identity: identity === true,
      }));
      const idx = await rows<unknown[]>(`
        SELECT ic.relname, i.indisunique, i.indisprimary, pg_get_indexdef(i.indexrelid),
               array_to_string(ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY k(n, o)
                 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n ORDER BY k.o), chr(31)),
               EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid AND c.conrelid = i.indrelid AND c.contype IN ('p','u','x'))
          FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid WHERE i.indrelid = $1::regclass ORDER BY ic.relname`, [rel]);
      const indexes: DbxIndex[] = idx.map(([name, unique, primary, def, cols2, constraint]) => ({
        name: str(name)!, unique: unique === true, primary: primary === true, definition: str(def), columns: (str(cols2) ?? '').split('\u001f').filter(Boolean),
        constraint: constraint === true,
      }));
      const colsOf = (keyCol: string, relCol: string) =>
        `array_to_string(ARRAY(SELECT a.attname FROM unnest(c.${keyCol}) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = c.${relCol} AND a.attnum = k.n ORDER BY k.o), chr(31))`;
      const fks = await rows<unknown[]>(`
        SELECT c.conname, ${colsOf('conkey', 'conrelid')}, rn.nspname, rc.relname, ${colsOf('confkey', 'confrelid')}, c.confdeltype, c.confupdtype
          FROM pg_constraint c JOIN pg_class rc ON rc.oid = c.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
         WHERE c.conrelid = $1::regclass AND c.contype = 'f' ORDER BY c.conname`, [rel]);
      const split = (v: unknown) => (str(v) ?? '').split('\u001f').filter(Boolean);
      const foreignKeys: DbxForeignKey[] = fks.map(([name, cs, rs, rname, rcs, del, upd]) => ({
        name: str(name)!, columns: split(cs), refTable: pgId(str(rs)!, str(rname)!),
        refColumns: split(rcs), onDelete: PG_RULES[str(del) ?? ''] ?? null, onUpdate: PG_RULES[str(upd) ?? ''] ?? null,
      }));
      const inc = await rows<unknown[]>(`
        SELECT c.conname, n.nspname, t.relname, ${colsOf('conkey', 'conrelid')}, ${colsOf('confkey', 'confrelid')}
          FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE c.confrelid = $1::regclass AND c.contype = 'f' ORDER BY n.nspname, t.relname, c.conname`, [rel]);
      const incoming: DbxIncomingKey[] = inc.map(([name, s, tn, cs, rcs]) => ({ name: str(name)!, table: pgId(str(s)!, str(tn)!), columns: split(cs), refColumns: split(rcs) }));
      return { table: t, columns, indexes, foreignKeys, primaryKey: pk, ddl: null, incoming };
    }),

    columns: () => exclusive(async () => {
      const r = await rows<unknown[]>(`
        SELECT n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod)
          FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r','v','m','p','f') AND ${USER_SCHEMAS} AND a.attnum > 0 AND NOT a.attisdropped
           AND has_table_privilege(c.oid, 'SELECT')
         ORDER BY n.nspname, c.relname, a.attnum`);
      const m = new Map<string, ColumnOverview[]>();
      for (const [s, t, c, type] of r) {
        const id = pgId(str(s)!, str(t)!);
        const l = m.get(id) ?? [];
        l.push({ name: str(c)!, type: str(type)! });
        m.set(id, l);
      }
      return m;
    }),

    rows: (info, req) => exclusive(async () => {
      const values: unknown[] = [];
      const w = where(req.filters, values);
      const order = req.sort ? ` ORDER BY ${qPg(req.sort)} ${req.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST` : info.primaryKey.length ? ` ORDER BY ${info.primaryKey.map(qPg).join(', ')}` : '';
      const r = await run1(`SELECT * FROM ${qPgTable(info.table)}${w}${order} LIMIT ${Math.floor(req.limit)} OFFSET ${Math.floor(req.offset)}`, values, req.limit);
      let total: number | null = null;
      let approximate = false;
      const estimate = info.table.rows;
      if (!w && estimate !== null && estimate >= EXACT_COUNT_BELOW && info.table.kind === 'table') { total = estimate; approximate = true; }
      else {
        try { total = Number(str((await rows<unknown[]>(`SELECT count(*) FROM ${qPgTable(info.table)}${w}`, values))[0]?.[0]) ?? 0); } catch { total = estimate; approximate = true; }
      }
      return { columns: r.columns ?? info.columns.map((c) => c.name), rows: r.rows, total, approximate, offset: req.offset, limit: req.limit };
    }),

    insert: (info, vals) => exclusive(async () => {
      const cols = Object.keys(vals);
      const sql = cols.length
        ? `INSERT INTO ${qPgTable(info.table)} (${cols.map(qPg).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`
        : `INSERT INTO ${qPgTable(info.table)} DEFAULT VALUES`;
      await run1(sql, cols.map((c) => vals[c]));
    }),

    update: (info, key, vals) => exclusive(async () => {
      const values: unknown[] = [];
      const set = Object.entries(vals).map(([c, v]) => { values.push(v); return `${qPg(c)} = $${values.length}`; }).join(', ');
      const r = await run1(`UPDATE ${qPgTable(info.table)} SET ${set} WHERE ${keyWhere(info, key, values)}`, values);
      return r.affectedRows ?? 0;
    }),

    remove: (info, keys) => exclusive(async () => {
      let n = 0;
      await run1('BEGIN');
      try {
        for (const key of keys) {
          const values: unknown[] = [];
          const r = await run1(`DELETE FROM ${qPgTable(info.table)} WHERE ${keyWhere(info, key, values)}`, values);
          n += r.affectedRows ?? 0;
        }
        await run1('COMMIT');
      } catch (err) {
        await run1('ROLLBACK').catch(() => undefined);
        throw err;
      }
      return n;
    }),

    run: (sql, o) => driver.runList(splitSql(sql, 'postgresql'), o),

    runList: (statements, o) => exclusive(() => withTimeout(o, () => runStatements(statements, (s) => run1(s)))),

    runOne: (sql, o) => exclusive(async () => {
      const t = Math.max(1, Math.floor(o.timeoutS ?? DBX_STATEMENT_TIMEOUT_S));
      if (o.readOnly) {
        await run1('BEGIN READ ONLY');
        try {
          await run1(`SET LOCAL statement_timeout = '${t}s'`);
          // Extended protocol: the server refuses more than one statement.
          return capRows(await run1(sql, [], o.maxRows + 1, true), o);
        } finally {
          await run1('ROLLBACK').catch(() => undefined);
        }
      }
      return withTimeout({ timeoutS: t }, async () => capRows(await run1(sql, [], o.maxRows + 1, true), o));
    }),

    objects: () => exclusive(async () => {
      const out: DbxObject[] = [];
      const none = { definer: null, ephemeralDefiner: false };
      for (const [s, name, kind] of await rows<unknown[]>(`
        SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('v','m') AND ${USER_SCHEMAS} ORDER BY n.nspname, c.relname`)) {
        out.push({ ...none, kind: 'view', id: pgId(str(s)!, str(name)!), name: str(name)!, schema: str(s), table: null, args: null, detail: str(kind) === 'm' ? 'MATERIALIZED' : null });
      }
      for (const [s, name, kind, args, result] of await rows<unknown[]>(`
        SELECT n.nspname, p.proname, p.prokind, pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid)
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE ${USER_SCHEMAS} AND p.prokind IN ('f','p')
           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
         ORDER BY n.nspname, p.proname`)) {
        const a = str(args) ?? '';
        out.push({
          ...none, kind: str(kind) === 'p' ? 'procedure' : 'function', id: `${pgId(str(s)!, str(name)!)}(${a})`, name: str(name)!, schema: str(s), table: null,
          args: a, detail: str(kind) === 'p' ? `(${a})` : `(${a}) RETURNS ${str(result) ?? ''}`,
        });
      }
      for (const [s, tname, name, def] of await rows<unknown[]>(`
        SELECT n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid)
          FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE NOT t.tgisinternal AND ${USER_SCHEMAS} ORDER BY n.nspname, c.relname, t.tgname`)) {
        const m = /\s(BEFORE|AFTER|INSTEAD OF)\s(.+?)\sON\s/.exec(str(def) ?? '');
        const table = pgId(str(s)!, str(tname)!);
        out.push({ ...none, kind: 'trigger', id: `${table}:${str(name)}`, name: str(name)!, schema: str(s), table: str(tname), args: null, detail: m ? `${m[1]} ${m[2]}` : null });
      }
      return out;
    }),

    objectDefinition: (o) => exclusive(async () => {
      const schema = o.schema ?? 'public';
      if (o.kind === 'view') {
        const r = await rows<unknown[]>(`SELECT c.relkind, pg_get_viewdef(c.oid, true) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`, [schema, o.name]);
        if (!r[0]) return null;
        const mat = str(r[0][0]) === 'm';
        return `CREATE ${mat ? 'MATERIALIZED VIEW' : 'OR REPLACE VIEW'} ${qPg(schema)}.${qPg(o.name)} AS\n${str(r[0][1]) ?? ''}`;
      }
      if (o.kind === 'function' || o.kind === 'procedure') {
        const r = await rows<unknown[]>(`
          SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = $1 AND p.proname = $2 AND pg_get_function_identity_arguments(p.oid) = $3`, [schema, o.name, o.args ?? '']);
        return str(r[0]?.[0]);
      }
      if (o.kind === 'trigger') {
        const r = await rows<unknown[]>(`
          SELECT pg_get_triggerdef(t.oid, true) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relname = $2 AND t.tgname = $3`, [schema, o.table ?? '', o.name]);
        return str(r[0]?.[0]);
      }
      return null;
    }),

    search: (info, columns, term, mode, limit) => exclusive(async () => {
      const values: unknown[] = [mode === 'exact' ? term : likeContains(term)];
      const cond = columns.map((c) => `${qPg(c)}::text ${mode === 'exact' ? '=' : 'ILIKE'} $1`).join(' OR ');
      const r = await run1(`SELECT * FROM ${qPgTable(info.table)} WHERE ${cond} LIMIT ${Math.floor(limit)}`, values, limit);
      return { columns: r.columns ?? [], rows: r.rows };
    }),

    stream: (sql, sink, o) => exclusive(async () => {
      await run1(o.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      try {
        await run1(`SET LOCAL statement_timeout = '${Math.max(0, Math.floor(o.timeoutS))}s'`);
        // Extended protocol: one statement only inside the cursor.
        await run1(`DECLARE oblimint_export NO SCROLL CURSOR FOR ${sql}`, [], 0, true);
        let n = 0;
        let first = true;
        for (;;) {
          const batch = await new Promise<{ fields: string[]; rows: unknown[][] }>((resolve, reject) => {
            client.query({ text: 'FETCH FORWARD 1000 FROM oblimint_export', rowMode: 'array', types: rawTypes as unknown as pg.CustomTypesConfig } as pg.QueryConfig, (err, r) => {
              if (err) reject(err); else resolve({ fields: (r.fields ?? []).map((f) => f.name), rows: r.rows as unknown[][] });
            });
          });
          if (first) { await sink.columns(batch.fields); first = false; }
          for (const r of batch.rows) {
            n++;
            const p = sink.row(r);
            if (p) await p;
          }
          if (batch.rows.length < 1000) break;
        }
        return n;
      } finally {
        await run1('ROLLBACK').catch(() => undefined);
      }
    }),

    exec: (sql) => exclusive(async () => (await run1(sql, [], 0)).affectedRows),

    insertRows: (target, columnsSql, rws) => exclusive(async () => {
      if (!rws.length) return 0;
      const values: unknown[] = [];
      const tuples = rws.map((r) => `(${r.map((v) => { values.push(v); return `$${values.length}`; }).join(', ')})`).join(', ');
      const res = await run1(`INSERT INTO ${target}${columnsSql ? ` (${columnsSql})` : ''} VALUES ${tuples}`, values, 0);
      return res.affectedRows ?? rws.length;
    }),

    setTimeout: (s) => exclusive(() => setTimeoutS(s)),

    cancel: (id) => exclusive(async () => {
      // The session user itself (the connection otherwise runs as the database owner role: no right on the session's backend).
      try { await run1('SET ROLE NONE'); const r = await rows<unknown[]>('SELECT pg_cancel_backend($1)', [id]); return r[0]?.[0] === true; } catch { return false; }
    }),

    close: () => client.end().catch(() => undefined),
  };
  return driver;
}

/** Keeps at most maxRows rows and maxBytes of them (API keys). */
function capRows(r: StreamResult, o: RunOneOptions): RunOneResult {
  if (!r.columns) return { columns: null, rows: [], truncated: false, affectedRows: r.affectedRows };
  const out: DbxCell[][] = [];
  let bytes = 0;
  let truncated = r.truncated || r.rows.length > o.maxRows;
  for (const row of r.rows.slice(0, o.maxRows)) {
    bytes += rowBytes(row);
    if (bytes > o.maxBytes) { truncated = true; break; }
    out.push(row);
  }
  return { columns: r.columns, rows: out, truncated, affectedRows: null };
}

/** Runs console statements in order; stops at the first error. */
export async function runStatements(statements: string[], exec: (s: string) => Promise<StreamResult>): Promise<{ results: DbxQueryResult[]; stopped: boolean }> {
  const results: DbxQueryResult[] = [];
  for (const statement of statements) {
    const t0 = Date.now();
    try {
      const r = await exec(statement);
      const durationMs = Date.now() - t0;
      results.push(r.columns
        ? { statement, columns: r.columns, rows: r.rows, truncated: r.truncated, durationMs }
        : { statement, affectedRows: r.affectedRows, insertId: r.insertId, durationMs });
      (r.more ?? []).forEach((set, k) => results.push({ statement, resultSet: k + 2, columns: set.columns, rows: set.rows, truncated: set.truncated, durationMs }));
    } catch (err) {
      results.push({ statement, error: errMessage(err), durationMs: Date.now() - t0 });
      return { results, stopped: true };
    }
  }
  return { results, stopped: false };
}
