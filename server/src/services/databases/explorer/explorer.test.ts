import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DbxCell, DbxTable, DbxTableInfo } from '@oblimint/shared';
import { DBX_TEXT_PREVIEW } from '@oblimint/shared';
import { AppError } from '../../../middleware/errorHandler';
import type { DbDatabaseRow, DbInstanceRow } from '../rows';
import { binaryCell, byteaCell, createWatchdog, fitRow, keepRow, longText, myCell, RowBudget, rowBytes, type ExplorerDriver } from './drivers';
import { auditSql, closeAllExplorerSessions, explorerService, setExplorerDeps } from './explorer.service';
import { splitSql } from './splitSql';

// Database explorer: statement splitting, cells, sessions (fake driver; the
// real drivers are validated against MariaDB / MySQL / PostgreSQL on a host).

test('splitSql: quotes, comments, dollar quoting', () => {
  assert.deepEqual(splitSql("SELECT 'a;b'; SELECT \"c;d\"; -- x;y\nSELECT `e;f`;", 'mysql'), ["SELECT 'a;b'", 'SELECT "c;d"', '-- x;y\nSELECT `e;f`']);
  assert.deepEqual(splitSql("SELECT 'it''s;'; # c;\nSELECT 2 /* ; */", 'mysql'), ["SELECT 'it''s;'", '# c;\nSELECT 2 /* ; */']);
  assert.deepEqual(splitSql("SELECT 'a\\';b'; SELECT 1", 'mysql'), ["SELECT 'a\\';b'", 'SELECT 1']);
  assert.deepEqual(splitSql('CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql; SELECT $tag$;$tag$', 'postgresql'),
    ['CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql', 'SELECT $tag$;$tag$']);
  assert.deepEqual(splitSql(' ; -- only a comment\n ;; ', 'postgresql'), []);
});

test('cells: long text cut, binary as hex, JSON / geometry as text', () => {
  assert.equal(longText('abc'), 'abc');
  const l = longText('x'.repeat(70_000)) as { long: true; text: string; size: number };
  assert.equal(l.long, true);
  assert.equal(l.size, 70_000);
  assert.equal(l.text.length, 4096);
  assert.deepEqual(binaryCell(Buffer.from([0xde, 0xad])), { binary: true, hex: 'dead', size: 2, truncated: false });
  assert.equal(myCell({ a: 1 }), '{"a":1}');
  assert.equal(myCell(null), null);
  assert.equal(myCell(3), 3);
});

const instance = { id: 4, account_id: 9, node_id: 1, engine: 'mariadb', status: 'running', tenant_id: 2 } as DbInstanceRow;
const database = { id: 12, name: 'shop' } as DbDatabaseRow;
const items: DbxTable = { id: 'items', name: 'items', schema: null, kind: 'table', rows: 3, bytes: 100, engine: 'InnoDB', comment: null };
const view: DbxTable = { ...items, id: 'v', name: 'v', kind: 'view' };
let connects: number;
let released: string[];
let now: number;
let calls: string[];
let failNext: Error | null;

function fakeDriver(): ExplorerDriver {
  const info = (t: DbxTable): DbxTableInfo => ({
    table: t, primaryKey: t.kind === 'table' ? ['id'] : [], indexes: [], foreignKeys: [], ddl: null,
    columns: [
      { name: 'id', type: 'int', nullable: false, default: null, primary: true, autoIncrement: true, comment: null, binary: false },
      { name: 'label', type: 'text', nullable: false, default: null, primary: false, autoIncrement: false, comment: null, binary: false },
      { name: 'data', type: 'blob', nullable: true, default: null, primary: false, autoIncrement: false, comment: null, binary: true },
    ],
  });
  return {
    family: 'mysql',
    version: async () => '11.4',
    tables: async () => { calls.push('tables'); return [items, view]; },
    table: async (t) => { calls.push(`table:${t.id}`); return info(t); },
    rows: async (i, req) => {
      if (failNext) { const e = failNext; failNext = null; throw e; }
      calls.push(`rows:${i.table.id}:${req.limit}:${req.sort ?? ''}`);
      return { columns: ['id'], rows: [[1]], total: 1, approximate: false, offset: req.offset, limit: req.limit };
    },
    insert: async () => { calls.push('insert'); },
    update: async (_i, key) => { calls.push(`update:${key.id}`); return 1; },
    remove: async (_i, keys) => { calls.push(`delete:${keys.length}`); return keys.length; },
    run: async (sql, o) => { calls.push(`run:${sql}:${o?.timeoutS ?? ''}`); return { results: [], stopped: false }; },
    runList: async (st) => { calls.push(`runList:${st.join(' | ')}`); return { results: [], stopped: false }; },
    runOne: async (sql, o) => { calls.push(`runOne:${o.readOnly ? 'ro' : 'rw'}:${o.maxRows}:${o.timeoutS}:${sql}`); return { columns: ['n'], rows: [[1]], truncated: false, affectedRows: null }; },
    connectionId: () => 77,
    columns: async () => new Map([['items', [{ name: 'id', type: 'int' }, { name: 'label', type: 'varchar(20)' }]], ['v', [{ name: 'n', type: 'int' }]]]),
    objects: async () => [],
    objectDefinition: async () => null,
    search: async (i, cols, term) => { calls.push(`search:${i.table.id}:${cols.join(',')}:${term}`); return { columns: ['id', 'label'], rows: [[1, term]], truncated: false }; },
    stream: async () => 0,
    exec: async () => 0,
    insertRows: async (_t, _c, r) => r.length,
    setTimeout: async () => undefined,
    cancel: async (id) => { calls.push(`cancel:${id}`); return true; },
    close: async () => { calls.push('close'); },
  };
}

beforeEach(() => {
  connects = 0;
  released = [];
  now = 1_000_000;
  calls = [];
  failNext = null;
  setExplorerDeps({
    connect: async () => { connects++; return { driver: fakeDriver(), username: `oblsso_${connects}`, password: 'pw' }; },
    open: async () => fakeDriver(),
    caps: async () => ({ importMax: 1e6, exportMax: 1e6 }),
    release: async (_i, u) => { released.push(u); },
    now: () => now,
  });
});

afterEach(async () => {
  await closeAllExplorerSessions();
  setExplorerDeps(null);
});

test('one session per (user, database), reused; the catalog is cached and resolves table ids', async () => {
  assert.equal((await explorerService.info(instance, database, 5)).user, 'oblsso_1');
  await explorerService.rows(instance, database, 5, 'items', { offset: 0, limit: 9999, sort: 'label' });
  await explorerService.rows(instance, database, 5, 'items', { offset: 0, limit: 10 });
  assert.equal(connects, 1);
  assert.deepEqual(calls, ['tables', 'table:items', 'rows:items:500:label', 'rows:items:10:']);
  await assert.rejects(explorerService.rows(instance, database, 5, 'nope', { offset: 0, limit: 10 }), (e: AppError) => e.code === 'tableNotFound');
  await assert.rejects(explorerService.rows(instance, database, 5, 'items', { offset: 0, limit: 10, sort: 'x`; DROP' }), (e: AppError) => e.code === 'unknownColumn');
  await explorerService.info(instance, database, 6); // another panel user: its own SQL user
  assert.equal(connects, 2);
});

test('editing: views and binary columns refused, keys required; console clears the catalog', async () => {
  await assert.rejects(explorerService.update(instance, database, 5, 'v', { id: 1 }, { label: 'x' }), (e: AppError) => e.code === 'notEditable');
  await assert.rejects(explorerService.update(instance, database, 5, 'items', { id: 1 }, { data: 'x' }), (e: AppError) => e.code === 'binaryColumn');
  await assert.rejects(explorerService.update(instance, database, 5, 'items', {}, { label: 'x' }), (e: AppError) => e.code === 'invalidKey');
  assert.equal(await explorerService.update(instance, database, 5, 'items', { id: 7 }, { label: 'x' }), 1);
  assert.equal(await explorerService.remove(instance, database, 5, 'items', [{ id: 1 }, { id: 2 }]), 2);
  await explorerService.query(instance, database, 5, 'ALTER TABLE items ADD c int');
  calls = [];
  await explorerService.table(instance, database, 5, 'items');
  assert.deepEqual(calls, ['tables', 'table:items'], 'catalog reloaded after the console');
});

test('idle sessions are closed (connection ended, SQL user dropped); a lost connection ends the session', async () => {
  await explorerService.info(instance, database, 5);
  failNext = Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST' });
  await assert.rejects(explorerService.rows(instance, database, 5, 'items', { offset: 0, limit: 10 }), (e: AppError) => e.code === 'dbUnreachable');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(released, ['oblsso_1']);
  await explorerService.info(instance, database, 5);
  assert.equal(connects, 2, 'reconnected');
  await explorerService.close(instance, database, 5);
  assert.deepEqual(released, ['oblsso_1', 'oblsso_2']);
  await assert.rejects(explorerService.info({ ...instance, status: 'stopped' } as DbInstanceRow, database, 5), (e: AppError) => e.code === 'instanceNotRunning');
});

test('SQL errors become 400 sqlError with the engine message', async () => {
  failNext = new Error("Unknown column 'nope' in 'field list'");
  await assert.rejects(explorerService.rows(instance, database, 5, 'items', { offset: 0, limit: 10 }),
    (e: AppError) => e.statusCode === 400 && e.code === 'sqlError' && e.message.includes('nope'));
});

test('API keys: one statement, read-only unless write, caps clamped; key sessions are their own', async () => {
  const r = await explorerService.keyQuery(instance, database, 'k9', 'SELECT 1', { write: false, maxRows: 99_999, timeoutS: 999 });
  assert.equal(r.readOnly, true);
  assert.deepEqual(calls.filter((c) => c.startsWith('runOne')), ['runOne:ro:500:60:SELECT 1']);
  await assert.rejects(explorerService.keyQuery(instance, database, 'k9', 'SELECT 1; DELETE FROM items', { write: false }), (e: AppError) => e.code === 'oneStatement');
  await assert.rejects(explorerService.keyQuery(instance, database, 'k9', 'DELETE FROM items', { write: false }), (e: AppError) => e.code === 'readOnlyStatement');
  await assert.rejects(explorerService.keyQuery(instance, database, 'k9', '/*!50000 DELETE FROM items */', { write: false }), (e: AppError) => e.code === 'readOnlyStatement');
  await assert.rejects(explorerService.keyQuery(instance, database, 'k9', 'CALL p()', { write: false }), (e: AppError) => e.code === 'readOnlyStatement');
  await assert.rejects(explorerService.keyQuery(instance, database, 'k9', 'START TRANSACTION', { write: false }), (e: AppError) => e.code === 'readOnlyStatement');
  await explorerService.keyQuery(instance, database, 'k9', '-- why\n(SELECT 2)', { write: false });
  await explorerService.keyQuery(instance, database, 'k9', 'DELETE FROM items WHERE id = 1', { write: true });
  assert.ok(calls.includes('runOne:rw:500:15:DELETE FROM items WHERE id = 1'));
  assert.equal(connects, 1);
  await explorerService.info(instance, database, 5);
  assert.equal(connects, 2, 'a panel user and a key never share a session');
});

test('console: timeout clamped, cancellation through a side connection; DDL regenerated server-side', async () => {
  await explorerService.query(instance, database, 5, 'SELECT 1', 9999);
  assert.ok(calls.includes('run:SELECT 1:300'));
  assert.deepEqual(await explorerService.cancel(instance, database, 5), { cancelled: false }, 'nothing running');
  const preview = await explorerService.ddlPreview(instance, database, 5, { op: 'addColumn', table: 'items', column: { name: 'qty', type: 'int', nullable: false, default: { kind: 'literal', value: '0' } } });
  assert.deepEqual(preview.statements, ["ALTER TABLE `items` ADD COLUMN `qty` int NOT NULL DEFAULT '0'"]);
  await explorerService.ddlApply(instance, database, 5, { op: 'dropTable', table: 'items', confirm: 'items' });
  assert.ok(calls.includes('runList:DROP TABLE `items`'));
  await assert.rejects(explorerService.ddlApply(instance, database, 5, { op: 'dropTable', table: 'items', confirm: 'nope' }), (e: AppError) => e.code === 'confirmMismatch');
  await assert.rejects(explorerService.ddlPreview(instance, database, 5, { op: 'dropColumn', table: 'nope', column: 'x' }), (e: AppError) => e.code === 'tableNotFound');
});

test('search: text columns only, bounded; maintenance statements built from the catalog', async () => {
  const r = await explorerService.search(instance, database, 5, { term: 'abc', mode: 'contains' });
  assert.equal(r.hits.length, 1);
  assert.deepEqual(r.hits[0].searchedColumns, ['label']);
  assert.equal(r.tablesSkipped, 1, 'the view has no text column');
  assert.ok(calls.includes('search:items:label:abc'));
  await explorerService.maintenance(instance, database, 5, 'optimize', ['items']);
  assert.ok(calls.includes('runList:OPTIMIZE TABLE `items`'));
  await assert.rejects(explorerService.maintenance(instance, database, 5, 'vacuum', ['items']), (e: AppError) => e.code === 'validation');
});

test('exports: one-shot tickets bound to the session; a query export must be one reading statement', async () => {
  const tk = await explorerService.prepareExport(instance, database, 5, { format: 'csv', tables: ['items'] }, '/x');
  assert.match(tk.token, /^[0-9a-f]{48}$/);
  assert.match(tk.filename, /^shop-items-\d{8}-\d{4}\.csv$/);
  await assert.rejects(explorerService.prepareExport(instance, database, 5, { format: 'csv', sql: 'DELETE FROM items' }, '/x'), (e: AppError) => e.code === 'readOnlyStatement');
  await assert.rejects(explorerService.prepareExport(instance, database, 5, { format: 'csv', tables: ['items', 'v'] }, '/x'), (e: AppError) => e.code === 'validation');
  await assert.rejects(explorerService.prepareExport(instance, database, 5, { format: 'sql', tables: ['items'], structure: false, data: false }, '/x'), (e: AppError) => e.code === 'validation');
  // Another owner cannot use the ticket; a ticket is consumed by the first attempt.
  await assert.rejects(explorerService.runExport(instance, database, 6, tk.token, {} as never), (e: AppError) => e.code === 'exportExpired');
  await assert.rejects(explorerService.runExport(instance, database, 5, tk.token, {} as never), (e: AppError) => e.code === 'exportExpired');
});

// ── security review ──

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** Deps whose connect() takes a while (the window where concurrent calls used to create two sessions). */
function slowConnect(ms = 20) {
  setExplorerDeps({
    connect: async () => { connects++; const n = connects; await tick(ms); return { driver: fakeDriver(), username: `oblsso_${n}`, password: 'pw' }; },
    open: async () => fakeDriver(),
    caps: async () => { await tick(); return { importMax: 1e6, exportMax: 1e6 }; },
    release: async (_i, u) => { released.push(u); },
    now: () => now,
  });
}

test('concurrent first calls share ONE session (no orphan connection / SQL user); the account limit counts creations in progress', async () => {
  slowConnect();
  const infos = await Promise.all([1, 2, 3].map(() => explorerService.info(instance, database, 5)));
  assert.equal(connects, 1);
  assert.deepEqual(infos.map((x) => x.user), ['oblsso_1', 'oblsso_1', 'oblsso_1']);
  // A session past its maximum age, renewed by concurrent calls: one new session, the old one released once.
  now += 101 * 60_000;
  const renewed = await Promise.all([1, 2, 3].map(() => explorerService.info(instance, database, 5)));
  assert.equal(connects, 2);
  assert.deepEqual(renewed.map((x) => x.user), ['oblsso_2', 'oblsso_2', 'oblsso_2']);
  assert.deepEqual(released, ['oblsso_1']);
  // 7 databases at once on one account: 5 sessions at most, every created user is released at the end.
  await closeAllExplorerSessions();
  const results = await Promise.allSettled([1, 2, 3, 4, 5, 6, 7].map((k) => explorerService.info(instance, { ...database, id: 100 + k }, 9)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 5);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => ((r as PromiseRejectedResult).reason as AppError).code === 'tooManySessions'));
  await closeAllExplorerSessions();
  assert.equal(released.length, connects, `every SQL user created was released (${connects} connects)`);
});

test('imports: a second concurrent start is refused (job set before any await); a refused start leaves no job behind', async () => {
  slowConnect(1);
  const { Readable } = await import('stream');
  const body = () => Readable.from([Buffer.from('SELECT 1;')]);
  const [a, b] = await Promise.allSettled([
    explorerService.startImport(instance, database, 5, body(), 'application/sql', 9, { format: 'sql' }),
    explorerService.startImport(instance, database, 5, body(), 'application/sql', 9, { format: 'sql' }),
  ]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status === 'rejected' && (b.reason as AppError).code, 'importRunning');
  const done = await explorerService.importStatus(instance, database, 5);
  await assert.rejects(explorerService.startImport(instance, database, 5, body(), 'application/sql', 1e9, { format: 'sql' }), (e: AppError) => e.code === 'importTooLarge');
  assert.equal(await explorerService.importStatus(instance, database, 5), done, 'the previous status is kept');
});

test('exports: at most 5 unused tickets per session (the oldest go)', async () => {
  const tokens: string[] = [];
  for (let k = 0; k < 7; k++) tokens.push((await explorerService.prepareExport(instance, database, 5, { format: 'csv', tables: ['items'] }, '/x')).token);
  for (const t of tokens.slice(0, 2)) await assert.rejects(explorerService.runExport(instance, database, 5, t, {} as never), (e: AppError) => e.code === 'exportExpired');
  // Still valid (fails later, on the fake response, not on the ticket).
  await assert.rejects(explorerService.runExport(instance, database, 5, tokens[2], {} as never), (e: AppError) => e.code !== 'exportExpired');
});

test('rows: a byte budget per response; the first row too big comes back cut, never 0 rows; key cells cut to the preview', () => {
  const big = 'x'.repeat(65_000);
  const row: DbxCell[] = Array.from({ length: 20 }, () => big);
  const set = { rows: [] as DbxCell[][], truncated: false };
  const budget = new RowBudget(256 * 1024);
  keepRow(set, row, budget);
  keepRow(set, row, budget);
  assert.equal(set.rows.length, 1, 'only the first, cut');
  assert.equal(set.truncated, true);
  assert.ok(rowBytes(set.rows[0]) <= 256 * 1024 + 20 * 64, `first row cut to the budget (${rowBytes(set.rows[0])} B)`);
  assert.deepEqual(set.rows[0][0], { long: true, text: big.slice(0, (set.rows[0][0] as { text: string }).text.length), size: 65_000 });
  // Once spent, another result set of the same response keeps nothing.
  const other = { rows: [] as DbxCell[][], truncated: false };
  keepRow(other, ['a'], budget);
  assert.deepEqual(other, { rows: [], truncated: true });
  // Small rows: kept until the budget, then the set stops (no gap).
  const small = new RowBudget(1000);
  const s2 = { rows: [] as DbxCell[][], truncated: false };
  for (let k = 0; k < 100; k++) keepRow(s2, ['y'.repeat(40)], small);
  assert.ok(s2.rows.length > 10 && s2.rows.length < 30 && s2.truncated);
  // API keys: text cut to DBX_TEXT_PREVIEW (myCell / longText with the key's limit), bytea decoded no further than the preview.
  assert.deepEqual(myCell('z'.repeat(5000), DBX_TEXT_PREVIEW), { long: true, text: 'z'.repeat(DBX_TEXT_PREVIEW), size: 5000 });
  assert.equal(longText('z'.repeat(5000)), 'z'.repeat(5000), 'the grid keeps values up to DBX_TEXT_MAX');
  assert.deepEqual(byteaCell(`\\x${'ab'.repeat(1000)}`), { binary: true, hex: 'ab'.repeat(64), size: 1000, truncated: true });
  assert.equal(fitRow([1, null, true, 'short'], 10).length, 4);
});

test('watchdog: past limit + grace the statement is killed, unless it ended (or the kill finds it ended)', async () => {
  const killed: string[] = [];
  const wd = createWatchdog(async (still) => { killed.push(still() ? 'kill' : 'late'); }, 20);
  const done = wd.arm(0.01);
  await tick(60);
  done();
  assert.deepEqual(killed, ['kill']);
  const done2 = wd.arm(0.01);
  done2();
  await tick(60);
  assert.deepEqual(killed, ['kill'], 'ended in time: nothing killed');
  wd.arm(0)();
  assert.equal(wd.kills, 1);
});

test('audit: statements of the console / keys / query exports with their literals masked', async () => {
  assert.equal(auditSql('mysql', "UPDATE users SET password = 'hunter2' WHERE id = 12"), 'UPDATE users SET password = ? WHERE id = ?');
  assert.equal(auditSql('postgresql', `SELECT '${'s'.repeat(5000)}`), 'SELECT ?', 'masked before being cut');
  assert.ok(auditSql('mysql', `SELECT ${'a, '.repeat(400)}b`).endsWith('…'));
  const tk = await explorerService.prepareExport(instance, database, 5, { format: 'json', sql: "SELECT * FROM items WHERE label = 'private'" }, '/x');
  assert.match(tk.filename, /query/);
});
