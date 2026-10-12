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
    run: async (sql) => { calls.push(`run:${sql}`); return { results: [], stopped: false }; },
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
    connect: async () => { connects++; return { driver: fakeDriver(), username: `oblsso_${connects}` }; },
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
