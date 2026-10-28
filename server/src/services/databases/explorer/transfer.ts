import { StringDecoder } from 'string_decoder';
import { Transform, type Writable } from 'stream';
import type { DbEngine, DbFamily, DbxImportError, DbxImportStatus, DbxTable, DbxTableInfo } from '@oblimint/shared';
import { DBX_IMPORT_MAX_ERRORS, dbFamilyOf } from '@oblimint/shared';
import { AppError } from '../../../middleware/errorHandler';
import { DB_CLIENTS, DB_CONTAINER_PATHS, DB_CONTAINER_PORT } from '../engines';
import { CsvReader, csvLine, exportCellText, jsonCell } from './csv';
import { qMyId, qPgId, tableRef } from './ddl';
import type { ExplorerDriver, RowSink } from './drivers';
import { SqlSplitter, type SplitItem } from './sqlStream';

// ─────────────────────────────────────────────────────────────────────────────
// Export / import of the database explorer. Everything runs as the session's
// EPHEMERAL SQL user (never the instance superuser):
//   - SQL export: the engine's own dump tool (mariadb-dump / mysqldump /
//     pg_dump) in the instance container, authenticated as that user — engine
//     native, re-importable by the console import or by any client;
//   - CSV / JSON: rows streamed from a side connection (cursor), written with
//     backpressure (never held whole);
//   - import: the upload streamed through the statement splitter (DELIMITER,
//     COPY … FROM stdin replayed as INSERT batches), one statement at a time
//     on a side connection; CSV records inserted by batches (bound values).
// ─────────────────────────────────────────────────────────────────────────────

export interface DumpOptions {
  /** Tables to dump (none: the whole database). */
  tables: Array<Pick<DbxTable, 'name' | 'schema'>>;
  structure: boolean;
  data: boolean;
  /** Whole database only: routines, triggers, events (MySQL family). */
  routines: boolean;
}

/** pg_dump --table pattern matching exactly one table (double quotes: no wildcard, no case folding). */
export function pgTablePattern(t: Pick<DbxTable, 'name' | 'schema'>): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return `${q(t.schema ?? 'public')}.${q(t.name)}`;
}

/** Argv of the dump tool as `user` (password in the environment, never on the command line). */
export function explorerDumpArgv(engine: DbEngine, database: string, user: string, o: DumpOptions): string[] {
  if (!o.structure && !o.data) throw new AppError(400, 'Nothing to export: structure and / or data', 'validation');
  const bin = DB_CLIENTS[engine];
  if (dbFamilyOf(engine) === 'postgresql') {
    return [
      bin.dump, '-h', DB_CONTAINER_PATHS.postgresql.socketDir, '-p', String(DB_CONTAINER_PORT.postgresql), '-U', user,
      '--no-owner', '--no-privileges', '--encoding=UTF8',
      ...(o.structure && !o.data ? ['--schema-only'] : []),
      ...(o.data && !o.structure ? ['--data-only'] : []),
      ...o.tables.map((t) => `--table=${pgTablePattern(t)}`),
      `--dbname=${database}`,
    ];
  }
  for (const t of o.tables) {
    // A name read as an option by the dump tool (argv, no shell): refused rather than guessed.
    if (t.name.startsWith('-')) throw new AppError(400, `Table ${t.name}: export the whole database instead`, 'validation');
  }
  const whole = !o.tables.length;
  return [
    bin.dump, '--no-defaults', `--socket=${DB_CONTAINER_PATHS.mysql.socket}`, `--user=${user}`,
    '--single-transaction', '--no-tablespaces', '--default-character-set=utf8mb4', '--hex-blob',
    ...(engine === 'mysql' ? ['--set-gtid-purged=OFF'] : []),
    ...(o.structure ? [] : ['--no-create-info']),
    ...(o.data ? [] : ['--no-data']),
    ...(o.structure && whole && o.routines ? ['--routines', '--events', '--triggers'] : o.structure ? ['--triggers'] : ['--skip-triggers']),
    database,
    ...o.tables.map((t) => t.name),
  ];
}

export function exportFilename(database: string, what: string | null, ext: string, gzip: boolean): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 60);
  return `${safe(database)}${what ? `-${safe(what)}` : ''}-${stamp}.${ext}${gzip ? '.gz' : ''}`;
}

/** Counts bytes, fails past `max` (the download is cut: a truncated file is a visible failure). */
export function byteCap(max: number, onBytes?: (n: number) => void): Transform {
  let n = 0;
  return new Transform({
    transform(chunk: Buffer, _e, cb) {
      n += chunk.length;
      onBytes?.(n);
      if (n > max) { cb(new AppError(413, 'Export larger than the platform limit', 'exportTooLarge')); return; }
      cb(null, chunk);
    },
  });
}

/** write() with backpressure: resolves at once, or on 'drain'; rejects when the stream closes. */
export function writeOrWait(out: Writable, data: string): void | Promise<void> {
  if (out.destroyed) return Promise.reject(new Error('Output closed'));
  if (out.write(data)) return undefined;
  return new Promise<void>((resolve, reject) => {
    const done = (err?: Error) => { out.off('drain', ok); out.off('close', closed); out.off('error', done); if (err) reject(err); else resolve(); };
    const ok = () => done();
    const closed = () => done(new Error('Output closed'));
    out.once('drain', ok);
    out.once('close', closed);
    out.once('error', done);
  });
}

/** Streams the rows of a SELECT as CSV or JSON into `out`. Returns the row count. */
export async function exportRows(driver: ExplorerDriver, sql: string, out: Writable, o: {
  format: 'csv' | 'json'; readOnly: boolean; timeoutS: number; delimiter: string; header: boolean;
}): Promise<number> {
  let cols: string[] = [];
  let first = true;
  let opened = false;
  const sink: RowSink = {
    columns: (names) => {
      cols = names;
      if (o.format === 'json') { opened = true; return writeOrWait(out, '['); }
      return o.header ? writeOrWait(out, csvLine(names, o.delimiter)) : undefined;
    },
    row: (values) => {
      if (o.format === 'csv') return writeOrWait(out, csvLine(values.map((v) => (v === null || v === undefined ? null : exportCellText(v))), o.delimiter));
      const obj: Record<string, unknown> = {};
      cols.forEach((c, i) => { obj[c] = jsonCell(values[i]); });
      const s = `${first ? '\n' : ',\n'}${JSON.stringify(obj)}`;
      first = false;
      return writeOrWait(out, s);
    },
  };
  const n = await driver.stream(sql, sink, { readOnly: o.readOnly, timeoutS: o.timeoutS });
  if (o.format === 'json') await writeOrWait(out, `${opened ? '' : '['}${first ? '' : '\n'}]\n`);
  return n;
}

// ── import ───────────────────────────────────────────────────────────────────

export interface ImportControl {
  status: DbxImportStatus;
  cancelled(): boolean;
}

const STATEMENT_SHOWN = 500;
const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

function recordError(status: DbxImportStatus, e: DbxImportError): void {
  status.errorCount++;
  if (status.errors.length < DBX_IMPORT_MAX_ERRORS) {
    status.errors.push({ ...e, statement: e.statement.length > STATEMENT_SHOWN ? `${e.statement.slice(0, STATEMENT_SHOWN)}…` : e.statement });
  }
}

const COPY_TARGET = /^copy\s+((?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\.(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*))?)\s*(?:\(((?:\s*(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s*,?)+)\))?\s+from\s+stdin\s*;?\s*$/i;

/** COPY t (a, b) FROM stdin → its target and column list (text format only, no options). */
export function parseCopy(sql: string): { target: string; columns: string | null; count: number | null } | null {
  const m = COPY_TARGET.exec(sql.replace(/^(\s*--[^\n]*\n)+/, '').trim());
  if (!m) return null;
  const cols = m[2] ? m[2].split(',').map((c) => c.trim()).filter(Boolean) : null;
  return { target: m[1], columns: cols ? cols.join(', ') : null, count: cols ? cols.length : null };
}

/** One field of COPY text format: \N = NULL, backslash escapes (\t \n \r \b \f \v \\ \ooo \xhh) decoded as UTF-8 bytes. */
export function copyField(raw: string): string | null {
  if (raw === '\\N') return null;
  if (!raw.includes('\\')) return raw;
  const bytes: number[] = [];
  const pushText = (s: string) => { for (const b of Buffer.from(s, 'utf8')) bytes.push(b); };
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c !== '\\') {
      const next = raw.indexOf('\\', i);
      const end = next < 0 ? raw.length : next;
      pushText(raw.slice(i, end));
      i = end;
      continue;
    }
    const e = raw[i + 1];
    if (e === undefined) { i++; continue; }
    const simple: Record<string, number> = { t: 9, n: 10, r: 13, b: 8, f: 12, v: 11 };
    if (e in simple) { bytes.push(simple[e]); i += 2; continue; }
    if (/[0-7]/.test(e)) {
      const m = /^[0-7]{1,3}/.exec(raw.slice(i + 1))![0];
      bytes.push(parseInt(m, 8) & 0xff);
      i += 1 + m.length;
      continue;
    }
    if (e === 'x' && /[0-9a-fA-F]/.test(raw[i + 2] ?? '')) {
      const m = /^[0-9a-fA-F]{1,2}/.exec(raw.slice(i + 2))![0];
      bytes.push(parseInt(m, 16));
      i += 2 + m.length;
      continue;
    }
    pushText(e);
    i += 2;
  }
  return Buffer.from(bytes).toString('utf8');
}

export const copyRow = (line: string): Array<string | null> => line.split('\t').map(copyField);

/** Rows per INSERT: bound values stay far below the protocols' 65 535 parameters. */
const batchRows = (cols: number) => Math.max(1, Math.min(500, Math.floor(30_000 / Math.max(1, cols))));

/** MySQL: a statement made of comments only once the version comments are skipped. */
const EMPTY_QUERY = 1065;

/** Runs a streamed SQL file. Stops at the first error unless continueOnError. Returns when the input is consumed. */
export async function runSqlImport(driver: ExplorerDriver, family: DbFamily, input: AsyncIterable<Buffer | string>, ctl: ImportControl, continueOnError: boolean): Promise<void> {
  const st = ctl.status;
  const splitter = new SqlSplitter({ family, psql: true });
  const decoder = new StringDecoder('utf8');
  let stop = false;
  let copy: { target: string; columns: string | null; count: number | null; failed: boolean } | null = null;

  const fail = (e: DbxImportError) => {
    recordError(st, e);
    if (!continueOnError) {
      stop = true;
      st.message = `Stopped at line ${e.line}`;
    }
  };

  const handle = async (item: SplitItem): Promise<void> => {
    switch (item.kind) {
      case 'statement':
        st.statements++;
        try {
          await driver.exec(item.sql);
        } catch (err) {
          if ((err as { errno?: number }).errno === EMPTY_QUERY) return;
          fail({ line: item.line, statement: item.sql, error: errMessage(err) });
        }
        return;
      case 'copy': {
        st.statements++;
        const c = parseCopy(item.sql);
        if (!c) {
          fail({ line: item.line, statement: item.sql, error: 'Only COPY … FROM stdin in text format is supported here (or dump with --inserts)' });
          copy = { target: '', columns: null, count: null, failed: true };
          return;
        }
        copy = { ...c, failed: false };
        return;
      }
      case 'copyData': {
        if (!copy || copy.failed) return;
        const rows = item.rows.map(copyRow);
        const width = copy.count ?? rows[0]?.length ?? 1;
        const per = batchRows(width);
        for (let k = 0; k < rows.length; k += per) {
          const part = rows.slice(k, k + per);
          try {
            st.rows += await driver.insertRows(copy.target, copy.columns, part);
          } catch (err) {
            copy.failed = true;
            fail({ line: item.line + k, statement: `COPY ${copy.target} (data)`, error: errMessage(err) });
            return;
          }
        }
        return;
      }
      case 'copyEnd':
        copy = null;
        return;
      default:
    }
  };

  const processItems = async (next: () => SplitItem[]) => {
    let items: SplitItem[];
    try {
      items = next();
    } catch (err) {
      // A statement over the size limit: reported, the rest of the upload drained (never a broken request).
      if (!(err instanceof AppError) || err.code !== 'statementTooLarge') throw err;
      recordError(st, { line: 0, statement: '', error: err.message });
      st.message = err.message;
      stop = true;
      return;
    }
    for (const it of items) {
      if (it.kind === 'meta') continue; // client commands: nothing to run (no await per line)
      if (stop || ctl.cancelled()) { stop = true; return; }
      await handle(it);
    }
  };

  for await (const chunk of input) {
    if (!stop && ctl.cancelled()) stop = true; // checked per chunk too: a chunk may yield no item
    if (stop) continue; // drain the upload
    await processItems(() => splitter.push(typeof chunk === 'string' ? chunk : decoder.write(chunk)));
  }
  if (!stop) await processItems(() => [...splitter.push(decoder.end()), ...splitter.end()]);
}

/** CSV into an existing table: the file's columns mapped onto table columns, batches of bound INSERTs. */
export async function runCsvImport(driver: ExplorerDriver, family: DbFamily, info: DbxTableInfo, input: AsyncIterable<Buffer | string>, ctl: ImportControl, o: {
  delimiter: string; header: boolean; columns: Array<string | null> | null; emptyNull: boolean; continueOnError: boolean;
  /** The table rolls back (false: MyISAM & co, the rows inserted before an error stay). Default true. */
  transactional?: boolean;
}): Promise<void> {
  const st = ctl.status;
  const mapping = o.columns ?? info.columns.map((c) => c.name);
  const used = mapping.filter((c): c is string => c !== null);
  if (!used.length) throw new AppError(400, 'Map at least one column', 'validation', { field: 'columns' });
  if (new Set(used).size !== used.length) throw new AppError(400, 'A table column is mapped twice', 'validation', { field: 'columns' });
  const byName = new Map(info.columns.map((c) => [c.name, c]));
  for (const c of used) if (!byName.has(c)) throw new AppError(400, `Unknown column: ${c}`, 'unknownColumn');
  const q = family === 'postgresql' ? qPgId : qMyId;
  const target = tableRef(family, info.table);
  const columnsSql = used.map(q).join(', ');
  const per = batchRows(used.length);
  const reader = new CsvReader({ delimiter: o.delimiter });
  const decoder = new StringDecoder('utf8');
  const tx = !o.continueOnError;
  let stop = false;
  let headerSkipped = !o.header;
  let batch: { values: unknown[][]; lines: number[] } = { values: [], lines: [] };

  const toValue = (raw: string, col: string): unknown => {
    if (raw === '' && o.emptyNull) return null;
    if (byName.get(col)!.binary && /^0x[0-9a-fA-F]*$/.test(raw)) return family === 'postgresql' ? `\\x${raw.slice(2)}` : Buffer.from(raw.slice(2), 'hex');
    return raw;
  };
  const flush = async () => {
    if (!batch.values.length) return;
    const b = batch;
    batch = { values: [], lines: [] };
    try {
      st.rows += await driver.insertRows(target, columnsSql, b.values);
    } catch (err) {
      if (!o.continueOnError) {
        recordError(st, { line: b.lines[0], statement: `INSERT INTO ${info.table.name} (rows ${b.lines[0]}–${b.lines[b.lines.length - 1]})`, error: (err as Error).message });
        stop = true;
        return;
      }
      // One by one: the failing rows are reported, the others kept.
      for (let k = 0; k < b.values.length; k++) {
        try { st.rows += await driver.insertRows(target, columnsSql, [b.values[k]]); } catch (e) {
          recordError(st, { line: b.lines[k], statement: `INSERT INTO ${info.table.name} (line ${b.lines[k]})`, error: (e as Error).message });
        }
      }
    }
  };
  const take = async (records: Array<{ fields: string[]; line: number }>) => {
    for (const r of records) {
      if (stop || ctl.cancelled()) { stop = true; return; }
      if (!headerSkipped) { headerSkipped = true; continue; }
      if (r.fields.length !== mapping.length) {
        recordError(st, { line: r.line, statement: '', error: `${r.fields.length} field(s), ${mapping.length} expected` });
        if (!o.continueOnError) { stop = true; return; }
        continue;
      }
      st.statements++;
      const vals: unknown[] = [];
      mapping.forEach((c, i) => { if (c !== null) vals.push(toValue(r.fields[i], c)); });
      batch.values.push(vals);
      batch.lines.push(r.line);
      if (batch.values.length >= per) await flush();
    }
  };

  const parse = (next: () => Array<{ fields: string[]; line: number }>) => {
    try {
      return next();
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'csvError') throw err;
      recordError(st, { line: 0, statement: '', error: err.message });
      st.message = err.message;
      stop = true;
      return [];
    }
  };

  // Not transactional (MyISAM & co): a failed multi-row INSERT may have kept part of its rows, which no
  // affected-row count reports — the table is counted before and after instead.
  const countRows = async (): Promise<number | null> => {
    try {
      const r = await driver.runOne(`SELECT COUNT(*) FROM ${target}`, { readOnly: false, maxRows: 1, maxBytes: 4096 });
      const n = Number(r.rows[0]?.[0]);
      return Number.isFinite(n) ? n : null;
    } catch { return null; }
  };
  const before = o.transactional === false ? await countRows() : null;
  if (tx) await driver.exec(family === 'postgresql' ? 'BEGIN' : 'START TRANSACTION');
  let ok = false;
  try {
    for await (const chunk of input) {
      if (!stop && ctl.cancelled()) stop = true;
      if (stop) continue; // drain the upload
      await take(parse(() => reader.push(typeof chunk === 'string' ? chunk : decoder.write(chunk))));
    }
    if (!stop) await take(parse(() => [...reader.push(decoder.end()), ...reader.end()]));
    if (!stop) await flush();
    ok = !stop && !ctl.cancelled();
  } finally {
    if (tx) {
      if (!ok) {
        await driver.exec('ROLLBACK').catch(() => undefined);
        if (o.transactional === false) {
          // ROLLBACK is a no-op on such a table: what was inserted is said, never hidden.
          const after = before === null ? null : await countRows();
          if (after !== null) st.rows = Math.max(0, after - before!);
          if (st.rows) st.message = `Stopped: ${st.rows} row(s) inserted before the stop are KEPT (the table's engine is not transactional)`;
        } else {
          if (st.rows) st.message = `Rolled back: ${st.rows} row(s) not kept`;
          st.rows = 0;
        }
      } else await driver.exec('COMMIT');
    }
  }
}
