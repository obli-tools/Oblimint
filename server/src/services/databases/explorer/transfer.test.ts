import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'stream';
import type { DbxImportStatus, DbxTableInfo } from '@oblimint/shared';
import type { AppError } from '../../../middleware/errorHandler';
import { CsvReader, csvLine } from './csv';
import type { ExplorerDriver, RowSink } from './drivers';
import { maskSqlLiterals, SqlSplitter, splitStatements, type SplitItem } from './sqlStream';
import { copyField, copyRow, explorerDumpArgv, exportRows, parseCopy, pgTablePattern, runCsvImport, runSqlImport } from './transfer';
import { firstKeyword, singleStatement } from './explorer.service';

// Streaming splitter, CSV, COPY decoding, dump argv, import / export runners (fake driver).

/** Feeds `text` in chunks of `size` characters. */
function chunked(s: SqlSplitter, text: string, size: number): SplitItem[] {
  const out: SplitItem[] = [];
  for (let i = 0; i < text.length; i += size) out.push(...s.push(text.slice(i, i + size)));
  out.push(...s.end());
  return out;
}

const DUMP_MY = [
  '/*M!999999\\- enable the sandbox mode */ ',
  '-- MariaDB dump',
  '/*!40101 SET NAMES utf8mb4 */;',
  '/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;',
  'CREATE TABLE `t` (`id` int, `s` text);',
  "INSERT INTO `t` VALUES (1,'a;b'),(2,'it\\'s'),(3,'x\\\\');",
  'DELIMITER ;;',
  "/*!50003 CREATE*/ /*!50003 TRIGGER `tg` BEFORE INSERT ON `t` FOR EACH ROW BEGIN SET NEW.s = CONCAT(NEW.s, ';'); END */;;",
  'DELIMITER ;',
  '# done',
  'SELECT 1',
].join('\n');

test('splitter (MySQL dump): executable comments, DELIMITER, escapes, lines — any chunk size', () => {
  for (const size of [1, 2, 3, 7, 64, 100_000]) {
    const items = chunked(new SqlSplitter({ family: 'mysql' }), DUMP_MY, size);
    const st = items.filter((x) => x.kind === 'statement') as Array<{ sql: string; line: number }>;
    assert.equal(st.length, 6, `size ${size}`);
    assert.match(st[0].sql, /^\/\*M!999999[\s\S]*SET NAMES utf8mb4 \*\/$/);
    assert.equal(st[0].line, 1);
    assert.equal(st[2].sql, 'CREATE TABLE `t` (`id` int, `s` text)');
    assert.equal(st[2].line, 5);
    assert.equal(st[3].sql, "INSERT INTO `t` VALUES (1,'a;b'),(2,'it\\'s'),(3,'x\\\\')");
    assert.match(st[4].sql, /^\/\*!50003 CREATE\*\/[\s\S]*END \*\/$/);
    assert.equal(st[4].line, 8);
    assert.equal(st[5].sql, '# done\nSELECT 1');
    assert.equal(st[5].line, 11);
    assert.deepEqual(items.filter((x) => x.kind === 'meta').map((x) => (x as { text: string }).text), ['DELIMITER ;;', 'DELIMITER ;']);
  }
});

const DUMP_PG = [
  '\\restrict abc123',
  'SET statement_timeout = 0;',
  "SELECT pg_catalog.set_config('search_path', '', false);",
  'CREATE FUNCTION public.f() RETURNS int AS $body$ BEGIN RETURN 1; END $body$ LANGUAGE plpgsql;',
  'CREATE TABLE public."T" (id integer, s text, b bytea);',
  'COPY public."T" (id, s, b) FROM stdin;',
  '1\ta;b\t\\\\x00ff',
  '2\t\\N\t\\N',
  '3\tline\\nbreak\\ttab \\303\\251\t\\\\x',
  '\\.',
  "SELECT E'it\\'s;' AS x, a$b$ FROM t;",
  '\\unrestrict abc123',
].join('\n');

test('splitter (pg_dump): psql meta-commands, dollar quotes, COPY data, E-strings, identifiers with $', () => {
  for (const size of [1, 5, 13, 100_000]) {
    const items = chunked(new SqlSplitter({ family: 'postgresql', psql: true }), DUMP_PG, size);
    const kinds = items.map((x) => x.kind).filter((k, i, a) => !(k === 'copyData' && a[i - 1] === 'copyData'));
    assert.deepEqual(kinds, ['meta', 'statement', 'statement', 'statement', 'statement', 'copy', 'copyData', 'copyEnd', 'statement', 'meta'], `size ${size}`);
    const rows = items.filter((x) => x.kind === 'copyData').flatMap((x) => (x as { rows: string[] }).rows);
    assert.deepEqual(rows, ['1\ta;b\t\\\\x00ff', '2\t\\N\t\\N', '3\tline\\nbreak\\ttab \\303\\251\t\\\\x']);
    const st = items.filter((x) => x.kind === 'statement') as Array<{ sql: string; line: number }>;
    assert.match(st[2].sql, /RETURN 1; END \$body\$ LANGUAGE plpgsql$/);
    assert.equal(st[4].sql, "SELECT E'it\\'s;' AS x, a$b$ FROM t");
    assert.equal(st[4].line, 11);
  }
});

test('splitter: console rules kept (comments, empty statements), a $ inside an identifier is no dollar quote', () => {
  assert.deepEqual(splitStatements('SELECT a$b$; SELECT 2; $b$', 'postgresql').map((s) => s.sql), ['SELECT a$b$', 'SELECT 2', '$b$']);
  assert.deepEqual(splitStatements("DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nCALL p();", 'mysql').map((s) => s.sql),
    ['CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END', 'CALL p()']);
  assert.deepEqual(splitStatements('SELECT 1 --x\n; -- c\n', 'mysql').map((s) => s.sql), ['SELECT 1 --x']);
  assert.deepEqual(splitStatements('/* a; */ /* b */', 'postgresql'), []);
  assert.deepEqual(splitStatements('SELECT /* nested /* x; */ ; */ 1', 'postgresql').map((s) => s.sql), ['SELECT /* nested /* x; */ ; */ 1']);
});

test('read-only gate: one statement, first keyword after comments / parentheses', () => {
  assert.equal(firstKeyword('-- c\n/* d */ ((SELECT 1))', 'mysql'), 'select');
  assert.equal(firstKeyword('/*!40000 DELETE */', 'mysql'), '');
  assert.equal(singleStatement('postgresql', 'WITH x AS (SELECT 1) SELECT * FROM x;', true), 'WITH x AS (SELECT 1) SELECT * FROM x');
  for (const bad of ['UPDATE t SET a = 1', 'SET TRANSACTION READ WRITE', 'COMMIT', 'CREATE TABLE x (a int)', 'LOCK TABLES t WRITE', 'DO $$ BEGIN END $$', 'COPY t TO STDOUT']) {
    assert.throws(() => singleStatement('postgresql', bad, true), (e) => (e as AppError).code === 'readOnlyStatement', bad);
  }
  assert.throws(() => singleStatement('mysql', 'SELECT 1; SELECT 2', true), (e) => (e as AppError).code === 'oneStatement');
  assert.throws(() => singleStatement('postgresql', "SELECT 'x'; DELETE FROM t", true), (e) => (e as AppError).code === 'oneStatement');
  assert.equal(singleStatement('mysql', 'DELETE FROM t WHERE id = 1', false), 'DELETE FROM t WHERE id = 1');
});

test('CSV: quoting on write, incremental reading (quotes, line breaks, CRLF, BOM, blank lines)', () => {
  assert.equal(csvLine(['a', 'b,c', 'say "hi"', null, 'l1\nl2'], ','), 'a,"b,c","say ""hi""",,"l1\nl2"\r\n');
  assert.equal(csvLine(['a;b', 'c'], ';'), '"a;b";c\r\n');
  const text = '﻿id;name;note\r\n1;"A; B";"x ""y"""\r\n\r\n2;plain;"multi\nline"\n3;;last';
  for (const size of [1, 2, 5, 1000]) {
    const r = new CsvReader({ delimiter: ';' });
    const recs = [];
    for (let i = 0; i < text.length; i += size) recs.push(...r.push(text.slice(i, i + size)));
    recs.push(...r.end());
    assert.deepEqual(recs.map((x) => x.fields), [['id', 'name', 'note'], ['1', 'A; B', 'x "y"'], ['2', 'plain', 'multi\nline'], ['3', '', 'last']], `size ${size}`);
    assert.deepEqual(recs.map((x) => x.line), [1, 2, 4, 6]);
  }
  const r = new CsvReader({ delimiter: ',' });
  r.push('"open');
  assert.throws(() => r.end(), (e) => (e as AppError).code === 'csvError');
  assert.throws(() => new CsvReader({ delimiter: '"' }), (e) => (e as AppError).code === 'validation');
});

test('COPY text format: target / columns parsed, fields decoded (NULL, escapes, octal UTF-8 bytes)', () => {
  assert.deepEqual(parseCopy('COPY public."T" (id, "s s", b) FROM stdin;'), { target: 'public."T"', columns: 'id, "s s", b', count: 3 });
  assert.deepEqual(parseCopy('COPY t FROM stdin'), { target: 't', columns: null, count: null });
  assert.equal(parseCopy("COPY t FROM stdin WITH (FORMAT csv)"), null);
  assert.equal(parseCopy("COPY t (a); DROP TABLE x; -- FROM stdin"), null);
  assert.equal(copyField('\\N'), null);
  assert.equal(copyField('line\\nbreak\\ttab \\303\\251'), 'line\nbreak\ttab é');
  assert.equal(copyField('\\\\x00ff'), '\\x00ff');
  assert.deepEqual(copyRow('1\t\\N\t\\x41'), ['1', null, 'A']);
});

test('dump argv: the session user, never the superuser; table names as patterns / refused when option-like', () => {
  const my = explorerDumpArgv('mariadb', 'shop', 'oblsso_ab', { tables: [{ name: 'a b', schema: null }], structure: true, data: false, routines: true });
  assert.ok(my.includes('--user=oblsso_ab') && my.includes('--no-data') && my.includes('--triggers') && !my.includes('--routines'));
  assert.deepEqual(my.slice(-2), ['shop', 'a b']);
  assert.ok(!my.some((a) => a.includes('root')));
  const whole = explorerDumpArgv('mysql', 'shop', 'oblsso_ab', { tables: [], structure: true, data: true, routines: true });
  assert.ok(whole.includes('--routines') && whole.includes('--events') && whole.includes('--set-gtid-purged=OFF'));
  assert.throws(() => explorerDumpArgv('mariadb', 'shop', 'u', { tables: [{ name: '--all-databases', schema: null }], structure: true, data: true, routines: false }));
  const pgArgs = explorerDumpArgv('postgresql', 'shop', 'oblsso_ab', { tables: [{ name: 'we"ird*', schema: 'public' }], structure: false, data: true, routines: true });
  assert.ok(pgArgs.includes('-U') && pgArgs[pgArgs.indexOf('-U') + 1] === 'oblsso_ab' && pgArgs.includes('--data-only'));
  assert.ok(pgArgs.includes(`--table=${pgTablePattern({ name: 'we"ird*', schema: 'public' })}`));
  assert.equal(pgTablePattern({ name: 'we"ird*', schema: 'public' }), '"public"."we""ird*"');
});

// ── runners with a fake driver ──

function fakeDriver(fail: (sql: string) => string | null = () => null) {
  const log: string[] = [];
  const d = {
    exec: async (sql: string) => { log.push(`exec:${sql}`); const e = fail(sql); if (e) throw Object.assign(new Error(e), sql.includes('EMPTY') ? { errno: 1065 } : {}); return 0; },
    insertRows: async (target: string, cols: string | null, rows: unknown[][]) => {
      log.push(`insert:${target}:${cols}:${JSON.stringify(rows.map((r) => r.map((v) => (Buffer.isBuffer(v) ? `buf:${v.toString('hex')}` : v))))}`);
      const e = fail(JSON.stringify(rows)); if (e) throw new Error(e);
      return rows.length;
    },
    stream: async (_sql: string, sink: RowSink) => {
      await sink.columns(['id', 'txt', 'bin']);
      await sink.row([1, 'a,"b"', Buffer.from([1, 255])]);
      await sink.row([2, null, null]);
      return 2;
    },
  };
  return { d: d as unknown as ExplorerDriver, log };
}

const status = (): DbxImportStatus => ({ id: 'x', state: 'running', format: 'sql', table: null, bytesRead: 0, totalBytes: null, statements: 0, rows: 0, errorCount: 0, errors: [], startedAt: '', finishedAt: null, message: null });
const input = (text: string, size = 7) => Readable.from(Array.from({ length: Math.ceil(text.length / size) }, (_, i) => Buffer.from(text.slice(i * size, (i + 1) * size))));

test('SQL import: statements in order, COPY replayed as INSERT batches, stop at the first error with its line', async () => {
  const { d, log } = fakeDriver((sql) => (sql.startsWith('SELECT E') ? 'syntax error at or near "x"' : null));
  const st = status();
  await runSqlImport(d, 'postgresql', input(DUMP_PG), { status: st, cancelled: () => false }, false);
  assert.equal(st.errorCount, 1);
  assert.equal(st.errors[0].line, 11);
  assert.match(st.message ?? '', /line 11/);
  assert.equal(st.rows, 3);
  const prefix = 'insert:public."T":id, s, b:';
  const ins = log.filter((l) => l.startsWith('insert:'));
  assert.ok(ins.every((l) => l.startsWith(prefix)));
  assert.deepEqual(ins.flatMap((l) => JSON.parse(l.slice(prefix.length))), [['1', 'a;b', '\\x00ff'], ['2', null, null], ['3', 'line\nbreak\ttab é', '\\x']]);
  assert.ok(!log.some((l) => l.includes('restrict')), 'psql meta-commands never reach the server');

  // continue on error: every statement tried, errors counted.
  const f2 = fakeDriver((sql) => (sql.includes('bad') ? 'nope' : null));
  const st2 = status();
  await runSqlImport(f2.d, 'mysql', input('SELECT bad;\nSELECT 2;\nSELECT bad2;\n/*M!999999 EMPTY */;'), { status: st2, cancelled: () => false }, true);
  assert.equal(st2.statements, 4);
  assert.equal(st2.errorCount, 2);
  assert.deepEqual(st2.errors.map((e) => e.line), [1, 3]);
});

test('SQL import: cancellation stops before the next statement and still drains the upload', async () => {
  const { d, log } = fakeDriver();
  let n = 0;
  const st = status();
  const src = input('SELECT 1; SELECT 2; SELECT 3; SELECT 4;', 3);
  await runSqlImport(d, 'mysql', src, { status: st, cancelled: () => { n++; return log.length >= 2; } }, false);
  assert.ok(n > 2, 'checked per statement and per chunk');
  assert.equal(log.length, 2);
  assert.equal(src.readableEnded, true);
});

const itemsTable: DbxTableInfo = {
  table: { id: 'items', name: 'items', schema: null, kind: 'table', rows: 0, bytes: 0, engine: null, comment: null },
  columns: [
    { name: 'id', type: 'int', nullable: false, default: null, primary: true, autoIncrement: true, comment: null, binary: false },
    { name: 'label', type: 'text', nullable: true, default: null, primary: false, autoIncrement: false, comment: null, binary: false },
    { name: 'data', type: 'blob', nullable: true, default: null, primary: false, autoIncrement: false, comment: null, binary: true },
  ],
  indexes: [], foreignKeys: [], primaryKey: ['id'], ddl: null,
};

test('CSV import: mapping, header, empty = NULL, binary 0x…, one transaction rolled back on error', async () => {
  const { d, log } = fakeDriver();
  const st = status();
  await runCsvImport(d, 'mysql', itemsTable, input('skip,label,data\n1,"a,b",0x01ff\n2,,\n'), { status: st, cancelled: () => false }, {
    delimiter: ',', header: true, columns: [null, 'label', 'data'], emptyNull: true, continueOnError: false,
  });
  assert.equal(st.rows, 2);
  assert.deepEqual(log, ['exec:START TRANSACTION', 'insert:`items`:`label`, `data`:[["a,b","buf:01ff"],[null,null]]', 'exec:COMMIT']);

  const bad = fakeDriver((rows) => (rows.includes('boom') ? 'Duplicate entry' : null));
  const st2 = status();
  await runCsvImport(bad.d, 'postgresql', { ...itemsTable, table: { ...itemsTable.table, schema: 'public' } }, input('1,ok\n2,boom\n'), { status: st2, cancelled: () => false }, {
    delimiter: ',', header: false, columns: ['id', 'label'], emptyNull: false, continueOnError: false,
  });
  assert.equal(st2.rows, 0, 'rolled back');
  assert.equal(st2.errorCount, 1);
  assert.deepEqual(bad.log.at(-1), 'exec:ROLLBACK');

  const st3 = status();
  const third = fakeDriver((rows) => (rows.includes('boom') ? 'Duplicate entry' : null));
  await runCsvImport(third.d, 'mysql', itemsTable, input('1,ok\n2,boom\n3,fine\n4\n'), { status: st3, cancelled: () => false }, {
    delimiter: ',', header: false, columns: ['id', 'label'], emptyNull: false, continueOnError: true,
  });
  assert.equal(st3.rows, 2, 'the good rows kept one by one');
  // Line 4 (wrong field count) is reported while reading, line 2 when its batch is retried row by row.
  assert.deepEqual(st3.errors.map((e) => e.line), [4, 2]);
  await assert.rejects(runCsvImport(third.d, 'mysql', itemsTable, input('1\n'), { status: status(), cancelled: () => false }, {
    delimiter: ',', header: false, columns: ['id', 'id'], emptyNull: false, continueOnError: true,
  }), (e) => (e as AppError).code === 'validation');
});

test('export rows: CSV and JSON written with backpressure, binary as 0x…', async () => {
  const { d } = fakeDriver();
  const collect = () => {
    const parts: string[] = [];
    const w = new Writable({ highWaterMark: 4, write(c, _e, cb) { parts.push(String(c)); setImmediate(cb); } });
    return { w, text: () => parts.join('') };
  };
  const a = collect();
  assert.equal(await exportRows(d, 'SELECT', a.w, { format: 'csv', readOnly: true, timeoutS: 1, delimiter: ',', header: true }), 2);
  assert.equal(a.text(), 'id,txt,bin\r\n1,"a,""b""",0x01ff\r\n2,,\r\n');
  const b = collect();
  await exportRows(d, 'SELECT', b.w, { format: 'json', readOnly: true, timeoutS: 1, delimiter: ',', header: true });
  assert.deepEqual(JSON.parse(b.text()), [{ id: 1, txt: 'a,"b"', bin: '0x01ff' }, { id: 2, txt: null, bin: null }]);
});

// ── security review: linear time, bounded memory, read-only gate, audit masking ──

const BS = String.fromCharCode(92);
const CHUNK = 64 * 1024;

/** Pushes head, then `total` characters of `fill` in 64 KiB chunks, then tail: time, error code, items. */
function feed(r: { push(t: string): unknown[]; end(): unknown[] }, head: string, fill: string, total: number, tail = '') {
  const block = fill.repeat(Math.ceil(CHUNK / fill.length)).slice(0, CHUNK);
  const t0 = process.hrtime.bigint();
  let code: string | null = null;
  let items = 0;
  try {
    items += r.push(head).length;
    for (let n = 0; n < total; n += CHUNK) items += r.push(block).length;
    items += r.push(tail).length + r.end().length;
  } catch (e) { code = (e as AppError).code ?? 'error'; }
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, code, items };
}

test('splitter / CSV: pathological 64 MiB inputs fail fast; big statements and records in linear time', () => {
  const M = 64 * 1024 * 1024 + CHUNK;
  const my = () => new SqlSplitter({ family: 'mysql' });
  const pgDump = () => new SqlSplitter({ family: 'postgresql', psql: true });
  const cases: Array<[string, ReturnType<typeof feed>, string]> = [
    ['DELIMITER line without a line break', feed(my(), 'delimiter ;', 'x', M), 'statementTooLarge'],
    ['psql meta-command without a line break', feed(pgDump(), `${BS}restrict `, 'x', M), 'statementTooLarge'],
    ['COPY statement line never ending', feed(pgDump(), 'COPY t FROM stdin;', 'x', M), 'statementTooLarge'],
    ['COPY data line without a line break', feed(pgDump(), 'COPY t FROM stdin;\n', 'x', M), 'statementTooLarge'],
    ['statement over the cap', feed(my(), 'SELECT ', 'x', M), 'statementTooLarge'],
    ['unterminated string over the cap', feed(my(), "SELECT '", 'x', M), 'statementTooLarge'],
    ['CSV: unterminated quoted field', feed(new CsvReader({ delimiter: ',' }), '"', 'x', M), 'csvError'],
    ['CSV: endless unquoted record', feed(new CsvReader({ delimiter: ',' }), '', 'x,', M), 'csvError'],
  ];
  for (const [what, r, code] of cases) {
    assert.equal(r.code, code, what);
    assert.ok(r.ms < 2500, `${what}: ${Math.round(r.ms)} ms`);
  }
  // A big legitimate statement / record: whole, and 4× the size costs about 4× the time (never 16×).
  const timeOf = (make: () => { push(t: string): unknown[]; end(): unknown[] }, head: string, size: number, tail: string) => {
    let best = Infinity;
    for (let k = 0; k < 2; k++) {
      const r = feed(make(), head, 'ab', size, tail);
      assert.equal(r.code, null);
      assert.equal(r.items, 1);
      best = Math.min(best, r.ms);
    }
    return best;
  };
  const s8 = timeOf(my, "INSERT INTO t VALUES ('", 8 * 1024 * 1024, "');");
  const s32 = timeOf(my, "INSERT INTO t VALUES ('", 32 * 1024 * 1024, "');");
  assert.ok(s32 < 2500 && s32 < Math.max(8 * s8, 300), `statement: 8 MiB ${Math.round(s8)} ms, 32 MiB ${Math.round(s32)} ms`);
  const csv = () => new CsvReader({ delimiter: ',' });
  const c2 = timeOf(csv, '"', 2 * 1024 * 1024, '"\n');
  const c8 = timeOf(csv, '"', 8 * 1024 * 1024, '"\n');
  assert.ok(c8 < 2500 && c8 < Math.max(8 * c2, 300), `CSV record: 2 MiB ${Math.round(c2)} ms, 8 MiB ${Math.round(c8)} ms`);
  // The text of an item split over many chunks is exact.
  const s = new SqlSplitter({ family: 'mysql' });
  const body = 'x'.repeat(200_000);
  const out = chunked(s, `-- c\n  DELIMITER $$\nSELECT '${body}' $$\nDELIMITER ;\nSELECT 2;`, 4093);
  assert.deepEqual(out.filter((x) => x.kind === 'statement').map((x) => (x as { sql: string }).sql), [`SELECT '${body}'`, 'SELECT 2']);
});

test('SQL import: cancellation is seen per chunk even when chunks yield no statement', async () => {
  const { d, log } = fakeDriver();
  const st = status();
  let cancelled = false;
  let chunks = 0;
  const src = Readable.from((function* gen() {
    for (let k = 0; k < 64; k++) { chunks++; if (k === 3) cancelled = true; yield Buffer.from(`SELECT '${'y'.repeat(CHUNK)}`); }
  })());
  await runSqlImport(d, 'mysql', src, { status: st, cancelled: () => cancelled }, false);
  assert.equal(log.length, 0);
  assert.equal(chunks, 64, 'upload drained');
  assert.equal(st.errorCount, 0, 'stopped by the cancellation, before the statement cap');
});

test('CSV import into a non-transactional table: the rows kept are reported, never « rolled back »', async () => {
  const bad = fakeDriver((rows) => (rows.includes('boom') ? 'Duplicate entry' : null));
  // The table is counted before and after: a failed multi-row INSERT kept part of its rows (no affected count for those).
  let count = 7;
  const counts: string[] = [];
  Object.assign(bad.d, { runOne: async (sql: string) => { counts.push(sql); const n = count; count = 7 + 500 + 40; return { columns: ['n'], rows: [[n]], truncated: false, affectedRows: null }; } });
  const st = status();
  await runCsvImport(bad.d, 'mysql', { ...itemsTable, table: { ...itemsTable.table, engine: 'MyISAM' } }, input('1,ok\n'.repeat(600) + '2,boom\n'), { status: st, cancelled: () => false }, {
    delimiter: ',', header: false, columns: ['id', 'label'], emptyNull: false, continueOnError: false, transactional: false,
  });
  assert.deepEqual(counts, ['SELECT COUNT(*) FROM `items`', 'SELECT COUNT(*) FROM `items`']);
  assert.equal(st.rows, 540, 'what the table really kept');
  assert.match(st.message ?? '', /540 row\(s\).*KEPT/);
});

test('read-only gate: nested PostgreSQL comments, MySQL comment rules, session-changing statements refused', () => {
  assert.equal(firstKeyword('/* /* */ SELECT 1 */ DELETE FROM t', 'postgresql'), 'delete');
  assert.throws(() => singleStatement('postgresql', '/* /* */ SELECT 1 */ DELETE FROM t', true), (e) => (e as AppError).code === 'readOnlyStatement');
  assert.equal(firstKeyword('/* a /* b */ c */ (SELECT 1)', 'postgresql'), 'select');
  assert.equal(firstKeyword('/* /* */ DELETE FROM t', 'mysql'), 'delete', 'no nesting on MySQL');
  assert.equal(firstKeyword('# c\nSELECT 1', 'mysql'), 'select');
  assert.equal(firstKeyword('# c\nSELECT 1', 'postgresql'), '', '# is no comment on PostgreSQL');
  assert.equal(firstKeyword('--x\nSELECT 1', 'mysql'), '', 'MySQL: -- without a blank is no comment');
  assert.equal(firstKeyword('( /* c */ ( -- d\n SELECT 1))', 'postgresql'), 'select');
  for (const [family, sql] of [
    ['postgresql', 'PREPARE p AS DELETE FROM t'], ['postgresql', 'EXECUTE p'], ['postgresql', 'DEALLOCATE ALL'], ['postgresql', 'COMMIT'], ['postgresql', 'ROLLBACK'],
    ['postgresql', "SET statement_timeout = 0"], ['postgresql', 'LOCK TABLE t'], ['postgresql', 'LISTEN c'], ['postgresql', "NOTIFY c, 'x'"], ['postgresql', 'DO $$ BEGIN END $$'],
    ['postgresql', 'CALL p()'], ['mysql', 'PREPARE p FROM \'DELETE FROM t\''], ['mysql', 'EXECUTE p'], ['mysql', 'DEALLOCATE PREPARE p'], ['mysql', 'COMMIT'],
    ['mysql', 'SET SESSION max_statement_time = 0'], ['mysql', 'LOCK TABLES t READ'], ['mysql', 'DO SLEEP(1)'], ['mysql', 'CALL p()'], ['mysql', 'HANDLER t OPEN'],
  ] as const) {
    assert.throws(() => singleStatement(family, sql, true), (e) => (e as AppError).code === 'readOnlyStatement' && /never runs read-only/.test((e as AppError).message), `${family}: ${sql}`);
    assert.equal(singleStatement(family, sql, false), sql, 'allowed with write: true');
  }
});

test('audit: literals masked (strings, numbers, dollar bodies), identifiers and keywords kept, comments dropped', () => {
  assert.equal(maskSqlLiterals("UPDATE `users` SET pass = 'secret', n = 42 WHERE id = 7 AND t1.c2 = -3.5e2", 'mysql'), 'UPDATE `users` SET pass = ?, n = ? WHERE id = ? AND t1.c2 = -?');
  assert.equal(maskSqlLiterals("SELECT \"col1\", E'it\\'s', X'ff', 0x1F, 1abc FROM t2 -- token=abc\nWHERE a = $$x$$ /* p */", 'postgresql'),
    'SELECT "col1", ?, ?, ?, 1abc FROM t2  \nWHERE a = ?  ');
  assert.equal(maskSqlLiterals("SELECT \"a\" # c\n, 'it\\'s'", 'mysql'), 'SELECT ?  \n, ?');
  assert.equal(maskSqlLiterals("SELECT 'unterminated secret", 'postgresql'), 'SELECT ?');
  assert.equal(maskSqlLiterals('/*!40101 SET NAMES 4 */', 'mysql'), '/*!40101 SET NAMES ? */');
});
