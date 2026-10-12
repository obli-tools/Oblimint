import mysql from 'mysql2';
import pg from 'pg';
import type {
  DbFamily, DbxCell, DbxColumn, DbxFilter, DbxForeignKey, DbxIndex, DbxQueryResult, DbxRowKey, DbxRows, DbxRowsRequest, DbxTable, DbxTableInfo,
} from '@oblimint/shared';
import { DBX_BINARY_PREVIEW, DBX_MAX_QUERY_ROWS, DBX_STATEMENT_TIMEOUT_S, DBX_TEXT_MAX, DBX_TEXT_PREVIEW } from '@oblimint/shared';
import { splitSql } from './splitSql';

// ─────────────────────────────────────────────────────────────────────────────
// SQL drivers of the database explorer: one connection per explorer session,
// over the instance's local socket, as the session's ephemeral user. Every
// statement is time-limited (engine setting), result rows are capped
// (DBX_MAX_QUERY_ROWS: the rest is read and discarded), big values are cut
// (DBX_TEXT_MAX / DBX_BINARY_PREVIEW). Identifiers come from the catalog
// (the caller resolves a table id against tables() first) and are quoted;
// values are always bound parameters.
// ─────────────────────────────────────────────────────────────────────────────

export interface ExplorerDriver {
  family: DbFamily;
  version(): Promise<string | null>;
  tables(): Promise<DbxTable[]>;
  table(t: DbxTable): Promise<DbxTableInfo>;
  rows(info: DbxTableInfo, req: DbxRowsRequest): Promise<DbxRows>;
  insert(info: DbxTableInfo, values: Record<string, string | null>): Promise<void>;
  update(info: DbxTableInfo, key: DbxRowKey, values: Record<string, string | null>): Promise<number>;
  remove(info: DbxTableInfo, keys: DbxRowKey[]): Promise<number>;
  run(sql: string): Promise<{ results: DbxQueryResult[]; stopped: boolean }>;
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

interface StreamResult {
  columns: string[] | null;
  rows: DbxCell[][];
  truncated: boolean;
  affectedRows: number | null;
  insertId: string | null;
}

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

export async function connectMysql(opts: { socketPath: string; user: string; password: string; database: string; mariadb: boolean }): Promise<ExplorerDriver> {
  const conn = mysql.createConnection({
    socketPath: opts.socketPath, user: opts.user, password: opts.password, database: opts.database,
    multipleStatements: false, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, connectTimeout: 10_000, charset: 'utf8mb4',
  });
  // A fatal error (server gone) must never be an unhandled 'error' event: the next query fails, the session is recreated.
  conn.on('error', () => { /* see above */ });
  await new Promise<void>((resolve, reject) => conn.connect((err) => (err ? reject(err) : resolve())));
  const run1 = (sql: string, values: unknown[] = [], cap = DBX_MAX_QUERY_ROWS) => new Promise<StreamResult>((resolve, reject) => {
    const res: StreamResult = { columns: null, rows: [], truncated: false, affectedRows: null, insertId: null };
    const q = conn.query({ sql, values, rowsAsArray: true });
    q.on('error', reject);
    q.on('fields', (fields?: Array<{ name: string }>) => { if (fields && !res.columns) res.columns = fields.map((f) => f.name); });
    q.on('result', (row: unknown) => {
      if (Array.isArray(row)) {
        if (res.rows.length < cap) res.rows.push(row.map(myCell));
        else res.truncated = true;
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
  await run1(opts.mariadb ? `SET SESSION max_statement_time = ${DBX_STATEMENT_TIMEOUT_S}` : `SET SESSION max_execution_time = ${DBX_STATEMENT_TIMEOUT_S * 1000}`);

  const where = (info: DbxTableInfo, filters: DbxFilter[] | undefined, values: unknown[]) => {
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

  return {
    family: 'mysql',
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
      const cols = await rows<[string, string, string, string | null, string, string, string, string]>(
        'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [t.name]);
      const columns: DbxColumn[] = cols.map(([name, type, nullable, def, key, extra, comment, dataType]) => ({
        name, type, nullable: nullable === 'YES', default: def, primary: key === 'PRI', autoIncrement: /auto_increment/i.test(extra),
        comment: comment || null, binary: MY_BINARY_TYPES.has(dataType.toLowerCase()),
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
      let ddl: string | null = null;
      try {
        const r = await rows<string[]>(`SHOW CREATE ${t.kind === 'view' ? 'VIEW' : 'TABLE'} ${qMy(t.name)}`);
        ddl = r[0]?.[1] ? String(r[0][1]) : null;
      } catch { /* no SHOW VIEW privilege: no DDL */ }
      const primaryKey = byIndex.get('PRIMARY')?.columns ?? [];
      return { table: t, columns, indexes: [...byIndex.values()], foreignKeys: [...byFk.values()], primaryKey, ddl };
    }),

    rows: (info, req) => exclusive(async () => {
      const values: unknown[] = [];
      const w = where(info, req.filters, values);
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

    run: (sql) => exclusive(async () => runStatements(splitSql(sql, 'mysql'), (s) => run1(s))),

    close: () => new Promise<void>((resolve) => conn.end(() => resolve())),
  };
}

// ── PostgreSQL ───────────────────────────────────────────────────────────────

export const qPg = (id: string) => `"${id.replace(/"/g, '""')}"`;
const qPgTable = (t: DbxTable) => `${qPg(t.schema ?? 'public')}.${qPg(t.name)}`;
const PG_RULES: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
const BYTEA_OID = 17;
const BOOL_OID = 16;

export async function connectPostgres(opts: { socketDir: string; user: string; password: string; database: string }): Promise<ExplorerDriver> {
  const types = {
    getTypeParser: (oid: number) => {
      if (oid === BYTEA_OID) return (v: string) => (v.startsWith('\\x') ? binaryCell(Buffer.from(v.slice(2), 'hex')) : longText(v));
      if (oid === BOOL_OID) return (v: string) => v === 't';
      return (v: string) => longText(v);
    },
  };
  const client = new pg.Client({
    host: opts.socketDir, port: 5432, user: opts.user, password: opts.password, database: opts.database,
    connectionTimeoutMillis: 10_000, types: types as unknown as pg.CustomTypesConfig, application_name: 'oblimint-explorer',
  });
  await client.connect();
  client.on('error', () => { /* a dropped connection fails the next query; the session is then recreated */ });
  await client.query(`SET statement_timeout = '${DBX_STATEMENT_TIMEOUT_S}s'`);

  const run1 = (text: string, values: unknown[] = [], cap = DBX_MAX_QUERY_ROWS) => new Promise<StreamResult>((resolve, reject) => {
    const res: StreamResult = { columns: null, rows: [], truncated: false, affectedRows: null, insertId: null };
    const q = new pg.Query({ text, values, rowMode: 'array', types: types as unknown as pg.CustomTypesConfig } as pg.QueryConfig);
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

  return {
    family: 'postgresql',
    version: () => exclusive(async () => str((await rows<unknown[]>('SHOW server_version'))[0]?.[0])),

    tables: () => exclusive(async () => {
      const r = await rows<unknown[]>(`
        SELECT n.nspname, c.relname, c.relkind, c.reltuples::bigint,
               CASE WHEN c.relkind IN ('r','m','p') THEN pg_total_relation_size(c.oid) END, obj_description(c.oid, 'pg_class')
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r','v','m','p','f') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
           AND has_table_privilege(c.oid, 'SELECT')
         ORDER BY n.nspname = 'public' DESC, n.nspname, c.relname`);
      return r.map(([schema, name, kind, n, bytes, comment]) => {
        const s = str(schema)!;
        const nm = str(name)!;
        const est = n === null ? null : Number(str(n));
        return {
          id: s === 'public' ? nm : `${s}.${nm}`, name: nm, schema: s, kind: str(kind) === 'v' || str(kind) === 'm' ? 'view' : 'table',
          rows: est !== null && est >= 0 ? est : null, bytes: bytes === null ? null : Number(str(bytes)), engine: null, comment: str(comment),
        } satisfies DbxTable;
      });
    }),

    table: (t) => exclusive(async () => {
      const rel = qPgTable(t);
      const cols = await rows<unknown[]>(`
        SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, pg_get_expr(d.adbin, d.adrelid),
               col_description(a.attrelid, a.attnum), a.atttypid = ${BYTEA_OID},
               a.attidentity <> '' OR COALESCE(pg_get_expr(d.adbin, d.adrelid), '') LIKE 'nextval(%'
          FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [rel]);
      const pk = (await rows<unknown[]>(`
        SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`, [rel])).map((r) => str(r[0])!);
      const columns: DbxColumn[] = cols.map(([name, type, nullable, def, comment, bin, auto]) => ({
        name: str(name)!, type: str(type)!, nullable: nullable === true, default: str(def), primary: pk.includes(str(name)!),
        autoIncrement: auto === true, comment: str(comment), binary: bin === true,
      }));
      const idx = await rows<unknown[]>(`
        SELECT ic.relname, i.indisunique, i.indisprimary, pg_get_indexdef(i.indexrelid),
               array_to_string(ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY k(n, o)
                 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n ORDER BY k.o), chr(31))
          FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid WHERE i.indrelid = $1::regclass ORDER BY ic.relname`, [rel]);
      const indexes: DbxIndex[] = idx.map(([name, unique, primary, def, cols2]) => ({
        name: str(name)!, unique: unique === true, primary: primary === true, definition: str(def), columns: (str(cols2) ?? '').split('\u001f').filter(Boolean),
      }));
      const fks = await rows<unknown[]>(`
        SELECT c.conname,
               array_to_string(ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.o), chr(31)),
               rn.nspname || '.' || rc.relname,
               array_to_string(ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.o), chr(31)),
               c.confdeltype, c.confupdtype
          FROM pg_constraint c JOIN pg_class rc ON rc.oid = c.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
         WHERE c.conrelid = $1::regclass AND c.contype = 'f' ORDER BY c.conname`, [rel]);
      const foreignKeys: DbxForeignKey[] = fks.map(([name, cs, ref, rcs, del, upd]) => ({
        name: str(name)!, columns: (str(cs) ?? '').split('\u001f').filter(Boolean), refTable: (str(ref) ?? '').replace(/^public\./, ''),
        refColumns: (str(rcs) ?? '').split('\u001f').filter(Boolean), onDelete: PG_RULES[str(del) ?? ''] ?? null, onUpdate: PG_RULES[str(upd) ?? ''] ?? null,
      }));
      return { table: t, columns, indexes, foreignKeys, primaryKey: pk, ddl: null };
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

    run: (sql) => exclusive(async () => runStatements(splitSql(sql, 'postgresql'), (s) => run1(s))),

    close: () => client.end().catch(() => undefined),
  };
}

/** Runs console statements in order; stops at the first error. */
export async function runStatements(statements: string[], exec: (s: string) => Promise<StreamResult>): Promise<{ results: DbxQueryResult[]; stopped: boolean }> {
  const results: DbxQueryResult[] = [];
  for (const statement of statements) {
    const t0 = Date.now();
    try {
      const r = await exec(statement);
      results.push(r.columns
        ? { statement, columns: r.columns, rows: r.rows, truncated: r.truncated, durationMs: Date.now() - t0 }
        : { statement, affectedRows: r.affectedRows, insertId: r.insertId, durationMs: Date.now() - t0 });
    } catch (err) {
      results.push({ statement, error: errMessage(err), durationMs: Date.now() - t0 });
      return { results, stopped: true };
    }
  }
  return { results, stopped: false };
}
