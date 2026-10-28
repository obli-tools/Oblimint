import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of the SQL explorer routes on PostgreSQL (panel database):
//   DBX_TEST_DATABASE_URL (default: the PGlite harness on port 55492).
// The SQL engine side is a fake driver (explorer deps seam; the real drivers
// run in explorer.e2e.test.ts). Covers: rights (databases.manage on the
// instance, other account → 404), saved queries scoped to (tenant, user,
// database) and deleted with the database, DDL validation through the route,
// raw-body import (status, audit without content), one-shot export tickets.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.DBX_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55492/postgres';

function reachable(url: string): Promise<boolean> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 5432) });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(1000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

test('SQL explorer routes on PostgreSQL', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-dbx-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'explorer-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../../db');
  const { errorHandler } = await import('../../../middleware/errorHandler');
  const routes = (await import('../../../routes/dbExplorer.routes')).default;
  const { setExplorerDeps, closeAllExplorerSessions } = await import('./explorer.service');
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');
  await db.migrate.latest();
  t.after(async () => { await closeAllExplorerSessions(); setExplorerDeps(null); await db.destroy(); });

  // ── fake engine side ───────────────────────────────────────────────────────
  const execs: string[] = [];
  const driver = {
    family: 'mysql', connectionId: () => 1, version: async () => '11.4', close: async () => undefined, setTimeout: async () => undefined,
    tables: async () => [{ id: 'items', name: 'items', schema: null, kind: 'table', rows: 2, bytes: 10, engine: 'InnoDB', comment: null }],
    table: async (tb: { id: string }) => ({
      table: tb, primaryKey: ['id'], indexes: [], foreignKeys: [], ddl: null,
      columns: [{ name: 'id', type: 'int', nullable: false, default: null, primary: true, autoIncrement: true, comment: null, binary: false },
        { name: 'label', type: 'text', nullable: true, default: null, primary: false, autoIncrement: false, comment: null, binary: false }],
    }),
    run: async (sql: string) => ({ results: [{ statement: sql, affectedRows: 1, insertId: null, durationMs: 1 }], stopped: false }),
    update: async () => 1,
    exec: async (sql: string) => { execs.push(sql); if (sql.includes('boom')) throw new Error('syntax error near boom'); return 1; },
    insertRows: async (_t: string, _c: string | null, rows: unknown[][]) => rows.length,
    stream: async (_sql: string, sink: { columns(n: string[]): unknown; row(v: unknown[]): unknown }) => { await sink.columns(['id', 'label']); await sink.row([1, 'a,b']); return 1; },
  };
  setExplorerDeps({
    connect: async () => ({ driver: driver as never, username: 'oblsso_test', password: 'pw' }),
    open: async () => driver as never,
    release: async () => undefined,
    caps: async () => ({ importMax: 1024 * 1024, exportMax: 1024 * 1024 }),
  });

  // ── fixtures ───────────────────────────────────────────────────────────────
  const suffix = Date.now().toString(36);
  const [tenant] = await db('tenants').insert({ name: `X ${suffix}`, slug: `x-${suffix}` }).returning('id');
  const tA = Number(tenant.id ?? tenant);
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number };
  const user = async (name: string) => {
    const [row] = await db('users').insert({ username: `${name}-${suffix}`, kind: 'client', role: 'user', is_active: true }).returning('id');
    return Number(row.id ?? row);
  };
  const reader = await user('rd');
  const manager = await user('mg');
  const manager2 = await user('mg2');
  const outsider = await user('out');
  const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify({ ...DEFAULT_PLAN_LIMITS }) }).returning('id');
  const account = async (name: string) => {
    const uid = 20000 + Math.floor(Math.random() * 30000);
    const [a] = await db('hosting_accounts').insert({
      tenant_id: tA, node_id: localNode.id, plan_id: Number(plan.id ?? plan), username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
    }).returning('id');
    return Number(a.id ?? a);
  };
  const acme = await account('acme');
  const other = await account('other');
  await db('account_users').insert([
    { user_id: reader, account_id: acme, capabilities: JSON.stringify([]) },
    { user_id: manager, account_id: acme, capabilities: JSON.stringify(['databases.manage']) },
    { user_id: manager2, account_id: acme, capabilities: JSON.stringify(['databases.manage']) },
    { user_id: outsider, account_id: other, capabilities: JSON.stringify(['databases.manage']) },
  ]);
  const [inst] = await db('db_instances').insert({
    tenant_id: tA, account_id: acme, node_id: localNode.id, name: `db-${suffix}`.slice(0, 32), engine: 'mariadb', version: '11.4', profile: 'S', status: 'running', is_default: true, root_secret: 'x',
  }).returning('id');
  const instId = Number(inst.id ?? inst);
  const [d1] = await db('db_databases').insert({ instance_id: instId, account_id: acme, name: 'shop', charset: 'utf8mb4' }).returning('id');
  const [d2] = await db('db_databases').insert({ instance_id: instId, account_id: acme, name: 'blog', charset: 'utf8mb4' }).returning('id');
  const shop = Number(d1.id ?? d1);
  const blog = Number(d2.id ?? d2);

  // ── app ────────────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: Number(req.header('x-user')) };
    (req as unknown as { tenantId: number }).tenantId = tA;
    next();
  });
  app.use('/databases', routes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/databases/instances/${instId}/databases`;
  const call = async (method: string, url: string, who: number, body?: unknown, raw?: { type: string; data: string }) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'content-type': raw?.type ?? 'application/json', 'x-user': String(who) },
      body: raw ? raw.data : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, body: json, text, headers: res.headers };
  };

  await t.test('rights: databases.manage on the instance, never another account', async () => {
    assert.equal((await call('GET', `/${shop}/explorer`, reader)).status, 403);
    assert.equal((await call('GET', `/${shop}/explorer`, outsider)).status, 404);
    const ok = await call('GET', `/${shop}/explorer`, manager);
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.data.user, 'oblsso_test');
    assert.deepEqual(ok.body.data.maintenance, ['optimize', 'analyze', 'check', 'repair']);
    assert.equal((await call('GET', `/999999/explorer`, manager)).status, 404);
  });

  await t.test('saved queries: per user and database, deleted with the database', async () => {
    const a = await call('POST', `/${shop}/explorer/queries`, manager, { name: ' Top ', sql: 'SELECT 1' });
    assert.equal(a.status, 200, a.text);
    assert.equal(a.body.data.name, 'Top');
    await call('POST', `/${blog}/explorer/queries`, manager, { name: 'Blog', sql: 'SELECT 2' });
    assert.deepEqual((await call('GET', `/${shop}/explorer/queries`, manager)).body.data.map((q: { name: string }) => q.name), ['Top']);
    assert.deepEqual((await call('GET', `/${shop}/explorer/queries`, manager2)).body.data, [], 'another user sees none');
    assert.equal((await call('PUT', `/${shop}/explorer/queries/${a.body.data.id}`, manager2, { name: 'stolen' })).status, 404);
    assert.equal((await call('DELETE', `/${blog}/explorer/queries/${a.body.data.id}`, manager)).status, 404, 'not on another database');
    const up = await call('PUT', `/${shop}/explorer/queries/${a.body.data.id}`, manager, { sql: 'SELECT 3' });
    assert.equal(up.body.data.sql, 'SELECT 3');
    assert.equal((await call('POST', `/${shop}/explorer/queries`, manager, { name: '', sql: 'x' })).status, 400);
    await db('db_databases').where({ id: blog }).del();
    assert.equal(Number((await db('db_explorer_queries').where({ database_id: blog }).count<{ n: string }[]>({ n: '*' }))[0].n), 0, 'cascade');
    assert.equal((await call('DELETE', `/${shop}/explorer/queries/${a.body.data.id}`, manager)).status, 200);
  });

  await t.test('DDL: validated from the structured request; unknown operations refused', async () => {
    const bad = await call('POST', `/${shop}/explorer/ddl/preview`, manager, { request: { op: 'addColumn', table: 'items', column: { name: 'x', type: 'int; DROP TABLE items', nullable: true } } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'invalidDdl');
    const ok = await call('POST', `/${shop}/explorer/ddl/preview`, manager, { request: { op: 'addColumn', table: 'items', column: { name: 'qty', type: 'int', nullable: false } } });
    assert.deepEqual(ok.body.data.statements, ['ALTER TABLE `items` ADD COLUMN `qty` int NOT NULL']);
    assert.equal((await call('POST', `/${shop}/explorer/ddl/apply`, manager, { request: { op: 'raw', sql: 'DROP DATABASE x' } })).status, 400);
  });

  await t.test('import: raw body, statements run, first error with its line, audited without content', async () => {
    const r = await call('POST', `/${shop}/explorer/import?options=${encodeURIComponent(JSON.stringify({ format: 'sql' }))}`, manager, undefined,
      { type: 'application/octet-stream', data: "INSERT INTO items VALUES (1, 'secret-value');\nSELECT boom;\nSELECT 3;" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.data.state, 'failed');
    assert.deepEqual(r.body.data.errors.map((e: { line: number }) => e.line), [2]);
    assert.equal(r.body.data.statements, 2);
    const status = await call('GET', `/${shop}/explorer/import`, manager);
    assert.equal(status.body.data.id, r.body.data.id);
    assert.equal((await call('POST', `/${shop}/explorer/import?options=${encodeURIComponent('{"format":"csv"}')}`, manager, undefined, { type: 'application/octet-stream', data: 'a' })).status, 400, 'CSV needs a table');
    const audit = await db('audit_logs').where({ action: 'db.explorer.import', tenant_id: tA }).first('details');
    assert.equal(audit.details.statements, 2);
    assert.ok(!JSON.stringify(audit.details).includes('secret-value'));
  });

  await t.test('audit: console statements with their literals masked; grid edits without the key values', async () => {
    const r = await call('POST', `/${shop}/explorer/query`, manager, { sql: "UPDATE items SET label = 'secret-value' WHERE id = 4242" });
    assert.equal(r.status, 200, r.text);
    const q = await db('audit_logs').where({ action: 'db.explorer.query', tenant_id: tA }).orderBy('id', 'desc').first('details');
    assert.deepEqual(q.details.sql, ['UPDATE items SET label = ? WHERE id = ?']);
    assert.equal(q.details.write, true);
    const u = await call('POST', `/${shop}/explorer/update`, manager, { table: 'items', key: { id: 4242 }, values: { label: 'secret-value' } });
    assert.equal(u.status, 200, u.text);
    const ua = await db('audit_logs').where({ action: 'db.explorer.update', tenant_id: tA }).orderBy('id', 'desc').first('details');
    assert.deepEqual(ua.details.columns, ['label']);
    assert.equal(ua.details.affected, 1);
    assert.ok(!JSON.stringify(q.details).includes('secret-value') && !JSON.stringify(ua.details).includes('4242') && !JSON.stringify(ua.details).includes('secret-value'));
  });

  await t.test('export: one-shot ticket, streamed, owner-bound', async () => {
    const tk = await call('POST', `/${shop}/explorer/export`, manager, { format: 'csv', tables: ['items'] });
    assert.equal(tk.status, 200, tk.text);
    assert.match(tk.body.data.url, new RegExp(`^/api/databases/instances/${instId}/databases/${shop}/explorer/export/[0-9a-f]{48}$`));
    const token = tk.body.data.token;
    assert.equal((await call('GET', `/${shop}/explorer/export/${token}`, manager2)).status, 404, 'another user');
    const tk2 = await call('POST', `/${shop}/explorer/export`, manager, { format: 'csv', tables: ['items'] });
    const file = await call('GET', `/${shop}/explorer/export/${tk2.body.data.token}`, manager);
    assert.equal(file.status, 200);
    assert.equal(file.text, 'id,label\r\n1,"a,b"\r\n');
    assert.match(file.headers.get('content-disposition') ?? '', /attachment; filename="shop-items-/);
    assert.equal((await call('GET', `/${shop}/explorer/export/${tk2.body.data.token}`, manager)).status, 404, 'one shot');
    const audit = await db('audit_logs').where({ action: 'db.explorer.export', tenant_id: tA }).first('details');
    assert.equal(audit.details.rows, 1);
  });
});
