import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { Readable, Writable } from 'stream';
import zlib from 'zlib';
import Docker from 'dockerode';
import type { DbEngine, DbFamily, DbxImportStatus, DbxQueryResponse } from '@oblimint/shared';
import { dbFamilyOf } from '@oblimint/shared';
import type { AppError } from '../../../middleware/errorHandler';
import type { DbDatabaseRow, DbInstanceRow } from '../rows';

// ─────────────────────────────────────────────────────────────────────────────
// END-TO-END test of the SQL explorer against REAL engines (throw-away
// containers named like instance containers, oblimint-db-<id>), driven by the
// e2e harness on a Linux Docker host — never run by default:
//   DBX_E2E_DOCKER=127.0.0.1:2375
//   DBX_E2E_MARIADB=<instanceId>:<host>:<port>:<rootPassword>
//   DBX_E2E_PG=<instanceId>:<host>:<port>:<rootPassword>
// The explorer runs with its real drivers (TCP instead of the socket), its
// real ephemeral-user model (createUserSql / dropUserSql through the instance's
// SQL client as in production) and the real dump path (the engine dump tool in
// the container, as the session user). Covers: DDL per engine, objects,
// export → re-import round trip (SQL, CSV), read-only query_database refusing
// writes, cancellation, statement timeout, search, maintenance.
// ─────────────────────────────────────────────────────────────────────────────

interface Target { id: number; host: string; port: number; root: string; engine: DbEngine }

function parseTarget(v: string | undefined, engine: DbEngine): Target | null {
  if (!v) return null;
  const [id, host, port, ...root] = v.split(':');
  return { id: Number(id), host, port: Number(port), root: root.join(':'), engine };
}

class FakeRes extends Writable {
  chunks: Buffer[] = [];
  headers: Record<string, string> = {};
  statusCode = 0;
  headersSent = false;
  _write(c: Buffer, _e: BufferEncoding, cb: () => void) { this.headersSent = true; this.chunks.push(Buffer.from(c)); cb(); }
  status(n: number) { this.statusCode = n; return this; }
  setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; }
  removeHeader(k: string) { delete this.headers[k.toLowerCase()]; }
  body() { return Buffer.concat(this.chunks); }
}

const targets = [parseTarget(process.env.DBX_E2E_MARIADB, 'mariadb'), parseTarget(process.env.DBX_E2E_PG, 'postgresql')].filter((t): t is Target => !!t);

test('SQL explorer end to end on real engines', { timeout: 600_000 }, async (t: TestContext) => {
  if (!process.env.DBX_E2E_DOCKER || !targets.length) {
    t.skip('no e2e engines (DBX_E2E_DOCKER / DBX_E2E_MARIADB / DBX_E2E_PG)');
    return;
  }
  const [dh, dp] = process.env.DBX_E2E_DOCKER.split(':');
  const docker = new Docker({ host: dh, port: Number(dp) });
  const { runSql } = await import('../instances');
  const { createDatabaseSql, createUserSql, dropUserSql } = await import('../sql');
  const { dbExec } = await import('../exec');
  const { passwordEnv } = await import('../engines');
  const { dbInstanceContainer } = await import('../../hosting/naming');
  const { connectMysql, connectPostgres } = await import('./drivers');
  const { explorerDumpArgv } = await import('./transfer');
  const { explorerService, setExplorerDeps, closeAllExplorerSessions } = await import('./explorer.service');

  for (const tg of targets) {
    const family: DbFamily = dbFamilyOf(tg.engine);
    const my = family === 'mysql';
    const row = { id: tg.id, engine: tg.engine, root_secret: '' } as Pick<DbInstanceRow, 'id' | 'engine' | 'root_secret'>;
    const sql = (script: { sql: string; database?: string | null }) => runSql(docker, row, script, { password: tg.root });
    const instance = { id: tg.id, account_id: 1, node_id: 1, engine: tg.engine, status: 'running', tenant_id: 1, name: 'e2e' } as DbInstanceRow;
    const mkDb = async (id: number, name: string) => {
      await sql(createDatabaseSql(family, { id, name }));
      return { id, name, instance_id: tg.id } as DbDatabaseRow;
    };
    const users: string[] = [];
    const open = (database: DbDatabaseRow, user: string, password: string) => (my
      ? connectMysql({ host: tg.host, port: tg.port, user, password, database: database.name, mariadb: tg.engine === 'mariadb' })
      : connectPostgres({ host: tg.host, port: tg.port, user, password, database: database.name }));
    setExplorerDeps({
      async connect(_i, database) {
        const username = `oblsso_${crypto.randomBytes(4).toString('hex')}`;
        const password = crypto.randomBytes(18).toString('hex');
        await sql(createUserSql(family, username, password, [{ databaseId: database.id, databaseName: database.name, level: 'all' }]));
        users.push(username);
        return { driver: await open(database, username, password), username, password };
      },
      open: (_i, database, u, p) => open(database, u, p),
      async dump(_i, database, username, password, o, out, signal) {
        const r = await dbExec(docker, dbInstanceContainer(tg.id), explorerDumpArgv(tg.engine, database.name, username, o), {
          env: [passwordEnv(family, password)], stdout: out, timeoutMs: 300_000, signal,
        });
        if (r.exitCode !== 0) throw new Error(`dump: ${r.stderr}`);
      },
      async release(_i, username) { await sql(dropUserSql(family, username, [{ id: 801, name: 'shop' }, { id: 802, name: 'shop2' }])); },
      caps: async () => ({ importMax: 64 * 1024 * 1024, exportMax: 64 * 1024 * 1024 }),
    });
    const shop = await mkDb(801, 'shop');
    const shop2 = await mkDb(802, 'shop2');
    const U = 7;
    const q = async (text: string, db: DbDatabaseRow = shop, owner: number = U): Promise<DbxQueryResponse> => explorerService.query(instance, db, owner, text);
    const ok = async (text: string, db: DbDatabaseRow = shop) => {
      const r = await q(text, db);
      assert.equal(r.stopped, false, `${text}: ${r.results.at(-1)?.error}`);
      return r;
    };
    const ddl = async (request: Parameters<typeof explorerService.ddlApply>[3], db: DbDatabaseRow = shop) => {
      const r = await explorerService.ddlApply(instance, db, U, request);
      assert.equal(r.stopped, false, `${request.op}: ${r.results.at(-1)?.error} — ${r.statements.join('; ')}`);
      return r;
    };
    const info = (id: string, db: DbDatabaseRow = shop) => explorerService.table(instance, db, U, id);

    await t.test(`${tg.engine}: structure editing through the generated DDL`, async () => {
      assert.equal((await explorerService.info(instance, shop, U)).database, 'shop');
      await ddl({ op: 'createTable', name: 'customers', columns: [
        { name: 'id', type: my ? 'int' : 'integer', nullable: false, autoIncrement: true },
        { name: 'name', type: 'varchar(80)', nullable: false, comment: "client's name" },
      ], primaryKey: ['id'], comment: 'the customers' });
      await ddl({ op: 'createTable', name: 'orders', columns: [
        { name: 'id', type: my ? 'bigint' : 'bigint', nullable: false, autoIncrement: true },
        { name: 'customer_id', type: my ? 'int' : 'integer', nullable: true },
        { name: 'label', type: 'varchar(40)', nullable: true, default: { kind: 'literal', value: "it's new" } },
        { name: 'qty', type: 'int', nullable: false, default: { kind: 'literal', value: '1' } },
        { name: 'at', type: my ? 'datetime' : 'timestamp', nullable: true, default: { kind: 'expression', value: 'CURRENT_TIMESTAMP' } },
        { name: 'bin', type: my ? 'blob' : 'bytea', nullable: true },
      ], primaryKey: ['id'] });
      await ddl({ op: 'addColumn', table: 'orders', column: { name: 'note', type: 'text', nullable: true, comment: 'free text' }, ...(my ? { after: 'label' } : {}) });
      await ddl({ op: 'modifyColumn', table: 'orders', column: 'label', def: { name: 'title', type: 'varchar(120)', nullable: false, default: { kind: 'literal', value: 'none' } } });
      await ddl({ op: 'createIndex', table: 'orders', name: 'ux_orders_title', columns: ['title', 'customer_id'], unique: true });
      await ddl({ op: 'addForeignKey', table: 'orders', name: 'fk_orders_customer', columns: ['customer_id'], refTable: 'customers', refColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' });
      let o = await info('orders');
      const title = o.columns.find((c) => c.name === 'title')!;
      assert.match(title.type, /varchar\(120\)|character varying\(120\)/);
      assert.equal(title.nullable, false);
      assert.ok(o.columns.find((c) => c.name === 'id')!.autoIncrement);
      assert.equal(o.columns.find((c) => c.name === 'note')!.comment, 'free text');
      assert.ok(o.indexes.some((i) => i.name === 'ux_orders_title' && i.unique));
      assert.deepEqual(o.foreignKeys.map((f) => [f.name, f.refTable, f.onDelete]), [['fk_orders_customer', 'customers', 'SET NULL']]);
      const c = await info('customers');
      assert.deepEqual(c.incoming?.map((k) => [k.table, k.columns[0]]), [['orders', 'customer_id']]);
      // Identity / auto-increment toggled off then on again; NOT NULL relaxed.
      await ddl({ op: 'modifyColumn', table: 'orders', column: 'qty', def: { name: 'qty', type: 'int', nullable: true, default: { kind: 'literal', value: '2' } } });
      o = await info('orders');
      assert.equal(o.columns.find((c2) => c2.name === 'qty')!.nullable, true);
      // A bad request never reaches the engine.
      await assert.rejects(explorerService.ddlPreview(instance, shop, U, { op: 'addColumn', table: 'orders', column: { name: 'x', type: 'int; DROP TABLE customers', nullable: true } }), (e: AppError) => e.code === 'invalidDdl');
      await ddl({ op: 'createTable', name: 'tmp', columns: [{ name: 'a', type: 'int', nullable: true }, { name: 'b', type: 'int', nullable: true }] });
      await ddl({ op: 'setPrimaryKey', table: 'tmp', columns: ['a'] });
      await ddl({ op: 'dropColumn', table: 'tmp', column: 'b' });
      await ddl({ op: 'renameTable', table: 'tmp', newName: 'tmp2' });
      await ddl({ op: 'truncateTable', table: 'tmp2', confirm: 'tmp2' });
      await ddl({ op: 'dropTable', table: 'tmp2', confirm: 'tmp2' });
      await ddl({ op: 'dropIndex', table: 'orders', name: 'ux_orders_title' });
      await ddl({ op: 'createIndex', table: 'orders', name: 'ix_orders_title', columns: ['title'], unique: false });
    });

    await t.test(`${tg.engine}: data, objects (view, routine, trigger), multiple result sets`, async () => {
      await ok("INSERT INTO customers (name) VALUES ('Ada'), ('Bob ''the'' builder'), ('Zoë 🚀')");
      await ok(my
        ? "INSERT INTO orders (customer_id, title, qty, bin, note) VALUES (1, 'a;b', 3, X'00FF10', 'line1\\nline2'), (2, 'tab\\there', 1, NULL, NULL), (NULL, 'quote''s \\\\ back', 5, X'', 'x')"
        : "INSERT INTO orders (customer_id, title, qty, bin, note) VALUES (1, 'a;b', 3, '\\x00ff10', E'line1\\nline2'), (2, E'tab\\there', 1, NULL, NULL), (NULL, 'quote''s \\ back', 5, '\\x', 'x')");
      await ok(my
        ? 'CREATE SQL SECURITY INVOKER VIEW v_orders AS SELECT o.id, c.name FROM orders o LEFT JOIN customers c ON c.id = o.customer_id'
        : 'CREATE VIEW v_orders AS SELECT o.id, c.name FROM orders o LEFT JOIN customers c ON c.id = o.customer_id');
      await ok(my
        ? 'DELIMITER $$\nCREATE PROCEDURE two_sets() SQL SECURITY INVOKER BEGIN SELECT 1 AS a; SELECT 2 AS b, 3 AS c; END$$\nCREATE FUNCTION add1(x INT) RETURNS INT DETERMINISTIC SQL SECURITY INVOKER RETURN x + 1$$\nDELIMITER ;'
        : 'CREATE FUNCTION add1(x integer) RETURNS integer LANGUAGE sql AS $$ SELECT x + 1 $$; CREATE PROCEDURE noop() LANGUAGE plpgsql AS $$ BEGIN END; $$');
      await ok(my
        ? "CREATE TRIGGER trg_orders BEFORE INSERT ON orders FOR EACH ROW SET NEW.note = COALESCE(NEW.note, 'auto')"
        : "CREATE FUNCTION trg_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.note := COALESCE(NEW.note, 'auto'); RETURN NEW; END $$; CREATE TRIGGER trg_orders BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION trg_fn()");
      await ok("INSERT INTO orders (customer_id, title) VALUES (3, 'trig')");
      const r = await ok("SELECT note FROM orders WHERE title = 'trig'");
      assert.deepEqual(r.results[0].rows, [['auto']]);
      const objs = await explorerService.objects(instance, shop, U);
      const kinds = objs.map((o) => `${o.kind}:${o.name}`).sort();
      for (const k of ['view:v_orders', 'function:add1', 'trigger:trg_orders']) assert.ok(kinds.includes(k), `${k} in ${kinds.join(', ')}`);
      const view = objs.find((o) => o.kind === 'view')!;
      assert.match((await explorerService.objectDefinition(instance, shop, U, 'view', view.id)).ddl, /SELECT/i);
      const fn = objs.find((o) => o.name === 'add1')!;
      assert.match((await explorerService.objectDefinition(instance, shop, U, 'function', fn.id)).ddl, /add1/);
      if (my) {
        const sets = await ok('CALL two_sets()');
        assert.deepEqual(sets.results.filter((x) => x.columns).map((x) => [x.resultSet ?? 1, x.columns, x.rows]), [[1, ['a'], [[1]]], [2, ['b', 'c'], [[2, 3]]]]);
      }
      const proc = objs.find((o) => o.kind === 'procedure')!;
      await ddl({ op: 'dropObject', kind: 'procedure', id: proc.id, confirm: proc.name });
      assert.ok(!(await explorerService.objects(instance, shop, U)).some((o) => o.kind === 'procedure'));
    });

    await t.test(`${tg.engine}: SQL export → import round trip, CSV export → import, query export`, async () => {
      const ticket = await explorerService.prepareExport(instance, shop, U, { format: 'sql', gzip: true }, '/x');
      const res = new FakeRes();
      const what = await explorerService.runExport(instance, shop, U, ticket.token, res as never);
      assert.equal(what.ok, true, JSON.stringify(what));
      const dump = zlib.gunzipSync(res.body()).toString('utf8');
      assert.match(dump, /CREATE TABLE/);
      assert.ok(!/root|postgres@/.test(dump.split('\n').filter((l) => /DEFINER|OWNER/.test(l)).join('\n')), 'no superuser definer / owner');
      const st = await explorerService.startImport(instance, shop2, U, Readable.from([res.body()]), 'application/gzip', res.body().length, { format: 'sql' });
      assert.equal(st.state, 'done', JSON.stringify(st.errors));
      if (my) assert.match(st.message ?? '', /trg_orders[\s\S]*DEFINER/, 'the definer note of a MySQL-family import');
      for (const table of ['customers', 'orders']) {
        const sum = my ? `SELECT COUNT(*), MD5(GROUP_CONCAT(CONCAT_WS('|', ${table === 'orders' ? 'id, customer_id, title, qty, HEX(bin), note' : 'id, name'}) ORDER BY id)) FROM ${table}`
          : `SELECT COUNT(*), md5(string_agg(concat_ws('|', ${table === 'orders' ? 'id, customer_id, title, qty, encode(bin, \'hex\'), note' : 'id, name'}), ',' ORDER BY id)) FROM ${table}`;
        const a = (await ok(sum, shop)).results[0].rows;
        const b = (await ok(sum, shop2)).results[0].rows;
        assert.deepEqual(b, a, `${table} identical after the round trip`);
      }
      assert.ok((await explorerService.objects(instance, shop2, U)).some((o) => o.kind === 'trigger'), 'triggers follow the dump');
      // Next id continues after the imported ones (sequence / AUTO_INCREMENT restored).
      await ok("INSERT INTO customers (name) VALUES ('after')", shop2);
      assert.deepEqual((await ok("SELECT id FROM customers WHERE name = 'after'", shop2)).results[0].rows, [[my ? 4 : '4']]);

      // CSV of a table → emptied copy.
      const ct = await explorerService.prepareExport(instance, shop, U, { format: 'csv', tables: ['orders'], csvDelimiter: ';' }, '/x');
      const cres = new FakeRes();
      await explorerService.runExport(instance, shop, U, ct.token, cres as never);
      const csv = cres.body().toString('utf8');
      assert.match(csv.split('\r\n')[0], /^id;customer_id;title;note;qty;at;bin$|^id;customer_id;title;qty;at;bin;note$/);
      await ddl({ op: 'truncateTable', table: 'orders', confirm: 'orders' }, shop2);
      await ok('DROP TRIGGER trg_orders' + (my ? '' : ' ON orders'), shop2);
      const header = csv.split('\r\n')[0].split(';');
      const ci = await explorerService.startImport(instance, shop2, U, Readable.from([Buffer.from(csv)]), 'application/octet-stream', csv.length, {
        format: 'csv', table: 'orders', csvDelimiter: ';', csvHeader: true, columns: header, csvEmptyNull: true,
      });
      assert.equal(ci.state, 'done', JSON.stringify(ci));
      assert.equal(ci.rows, 4);
      const cmp = my ? "SELECT id, customer_id, title, qty, HEX(bin), note FROM orders WHERE note IS NULL OR note <> '' ORDER BY id"
        : "SELECT id, customer_id, title, qty, encode(bin, 'hex'), note FROM orders ORDER BY id";
      assert.deepEqual((await ok(cmp, shop2)).results[0].rows, (await ok(cmp, shop)).results[0].rows, 'CSV round trip (binary as 0x…)');

      // JSON of a query, read-only.
      const jt = await explorerService.prepareExport(instance, shop, U, { format: 'json', sql: 'SELECT id, name FROM customers ORDER BY id' }, '/x');
      const jres = new FakeRes();
      await explorerService.runExport(instance, shop, U, jt.token, jres as never);
      const json = JSON.parse(jres.body().toString('utf8')) as Array<{ name: string }>;
      assert.deepEqual(json.map((x) => x.name), ['Ada', "Bob 'the' builder", 'Zoë 🚀']);

      // Import errors: stop with the line, or continue.
      const bad = 'INSERT INTO customers (name) VALUES (\'x1\');\n\nINSERT INTO nope VALUES (1);\nINSERT INTO customers (name) VALUES (\'x2\');\n';
      const s1: DbxImportStatus = await explorerService.startImport(instance, shop2, U, Readable.from([Buffer.from(bad)]), 'application/sql', bad.length, { format: 'sql' });
      assert.equal(s1.state, 'failed');
      assert.equal(s1.errors[0].line, 3);
      assert.equal(s1.statements, 2);
      const s2 = await explorerService.startImport(instance, shop2, U, Readable.from([Buffer.from(bad)]), 'application/sql', bad.length, { format: 'sql', continueOnError: true });
      assert.equal(s2.state, 'done');
      assert.equal(s2.statements, 3);
      assert.equal(s2.errorCount, 1);
    });

    await t.test(`${tg.engine}: query_database is read-only unless write: true`, async () => {
      const K = 'k42' as const;
      const before = (await explorerService.keyQuery(instance, shop, K, 'SELECT COUNT(*) AS n FROM customers', { write: false })).rows;
      // Writes hidden inside reading statements fail in the read-only transaction.
      await ok(my
        ? "DELIMITER $$\nCREATE FUNCTION sneaky() RETURNS INT MODIFIES SQL DATA SQL SECURITY INVOKER BEGIN INSERT INTO customers (name) VALUES ('sneaky'); RETURN 1; END$$\nDELIMITER ;"
        : "CREATE FUNCTION sneaky() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN INSERT INTO customers (name) VALUES ('sneaky'); RETURN 1; END $$");
      const attempts = my
        ? ['SELECT sneaky()', 'DELETE FROM customers', 'CREATE TABLE evil (a int)', 'SELECT 1; DELETE FROM customers', 'CALL two_sets()', 'TRUNCATE customers', 'SET SESSION TRANSACTION READ WRITE']
        : ['SELECT sneaky()', 'WITH d AS (DELETE FROM customers RETURNING *) SELECT * FROM d', "SELECT nextval(pg_get_serial_sequence('orders', 'id'))", 'DELETE FROM customers',
          'CREATE TABLE evil (a int)', 'SELECT 1; DELETE FROM customers', "SELECT set_config('transaction_read_only', 'off', true), (SELECT 1)", 'EXPLAIN ANALYZE DELETE FROM customers', 'SELECT a$b$; DELETE FROM customers; $b$'];
      for (const a of attempts) {
        await assert.rejects(explorerService.keyQuery(instance, shop, K, a, { write: false }), (e: AppError) => ['readOnlyStatement', 'oneStatement', 'sqlError'].includes(e.code ?? ''), a);
      }
      assert.deepEqual((await explorerService.keyQuery(instance, shop, K, 'SELECT COUNT(*) AS n FROM customers', { write: false })).rows, before, 'nothing written');
      assert.equal((await ok('SELECT COUNT(*) FROM information_schema.tables WHERE table_name = \'evil\'')).results[0].rows![0][0] + '', '0');
      // The session stays read-write for the next write call, and a read-only call after a write is read-only again.
      const w = await explorerService.keyQuery(instance, shop, K, "INSERT INTO customers (name) VALUES ('by key')", { write: true });
      assert.equal(w.affectedRows, 1);
      await assert.rejects(explorerService.keyQuery(instance, shop, K, 'SELECT sneaky()', { write: false }));
      const big = await explorerService.keyQuery(instance, shop, K, my ? 'SELECT REPEAT(\'x\', 1000) FROM information_schema.columns a, information_schema.columns b LIMIT 2000' : "SELECT repeat('x', 1000) FROM generate_series(1, 2000)", { write: false, maxRows: 500 });
      assert.equal(big.truncated, true);
      assert.ok(big.rowCount < 500 && big.rowCount > 100, `byte cap: ${big.rowCount} rows`);
      await explorerService.close(instance, shop, K);
    });

    await t.test(`${tg.engine}: cancel, statement timeout, search, maintenance`, async () => {
      const t0 = Date.now();
      const running = explorerService.query(instance, shop, U, my ? 'SELECT SLEEP(20)' : 'SELECT pg_sleep(20)', 60);
      await new Promise((r) => setTimeout(r, 1500));
      assert.deepEqual(await explorerService.cancel(instance, shop, U), { cancelled: true });
      const r = await running;
      assert.ok(Date.now() - t0 < 10_000, 'cancelled well before 20 s');
      if (!my) assert.match(r.results[0].error ?? '', /cancel/i);
      const t1 = Date.now();
      const slow = await explorerService.query(instance, shop, U, my ? 'SELECT SLEEP(5)' : 'SELECT pg_sleep(5)', 1);
      assert.ok(Date.now() - t1 < 4000, 'statement timeout of the run');
      assert.ok(slow.results[0].error || (my && String(slow.results[0].rows?.[0]?.[0]) === '1'));
      assert.ok((await ok('SELECT 1')).results[0].rows, 'the session works after the cancel and the timeout');
      const found = await explorerService.search(instance, shop, U, { term: 'builder', mode: 'contains' });
      assert.deepEqual(found.hits.map((h) => h.table), ['customers', 'v_orders'], 'tables and views');
      const pct = await explorerService.search(instance, shop, U, { term: '%', mode: 'contains' });
      assert.equal(pct.hits.length, 0, 'LIKE wildcards escaped');
      for (const op of my ? ['optimize', 'analyze', 'check', 'repair'] as const : ['vacuum', 'vacuumAnalyze', 'analyze', 'reindex'] as const) {
        const m = await explorerService.maintenance(instance, shop, U, op, ['customers', 'orders']);
        assert.equal(m.stopped, false, `${op}: ${m.results.at(-1)?.error}`);
      }
      const sch = await explorerService.schema(instance, shop, U);
      assert.ok(sch.tables.orders.includes('title'));
    });

    await closeAllExplorerSessions();
    setExplorerDeps(null);
    // Every ephemeral user was dropped.
    const left = my
      ? (await sql({ sql: "SELECT COUNT(*) FROM mysql.user WHERE user LIKE 'oblsso\\_%';\n" })) // eslint-disable-line no-await-in-loop
      : (await sql({ sql: "SELECT COUNT(*) FROM pg_roles WHERE rolname LIKE 'oblsso\\_%';\n" }));
    assert.match(left.stdout, /\b0\b/, `ephemeral users dropped (${users.length} created)`);
  }
});
