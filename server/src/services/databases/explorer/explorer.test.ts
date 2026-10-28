import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DbxTable, DbxTableInfo } from '@oblimint/shared';
import { AppError } from '../../../middleware/errorHandler';
import type { DbDatabaseRow, DbInstanceRow } from '../rows';
import { binaryCell, longText, myCell, type ExplorerDriver } from './drivers';
import { closeAllExplorerSessions, explorerService, setExplorerDeps } from './explorer.service';
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
    search: async (i, cols, term) => { calls.push(`search:${i.table.id}:${cols.join(',')}:${term}`); return { columns: ['id', 'label'], rows: [[1, term]] }; },
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
