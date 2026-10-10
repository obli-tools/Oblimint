import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of edge-robustness on a PGlite server (docs/P4b-PLAN.md §15:
// edge-robustness = port 55474):  PG_PORT=55474 node <scratchpad>/pg/pgserver.mjs
// EDGEUNITS_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. Migrations 001–007 replayed. Fake edge (setEdgeRuntimeForTests):
// sandbox / live `nginx -t` read the files written and fail on "BROKEN".
// Covers: edge_units / edge_applies persistence, quarantine notification
// deduplication, EdgeStatus units + lastApply, the routes (tenant list with
// isolation + A6 labels, admin list / retry / applies / rollback + audit),
// statesForOwners, the built-in g-bans when no ban provider is registered.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.EDGEUNITS_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55474/postgres';

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

test('edge units on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55474)`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-edgeunits-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'edge-units-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const edgeUnitsRoutes = (await import('../../routes/edgeUnits.routes')).default;
  const { systemEdgeUnitsRoutes } = await import('../../routes/edgeUnits.routes');
  const { edgeService, setEdgeRuntimeForTests } = await import('./edge.service');
  const { edgeUnitsService } = await import('./edgeUnits.service');
  const { clearEdgeUnitProvidersForTests, registerEdgeUnitProvider } = await import('./units');
  const { localPaths } = await import('../hosting/paths');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });
  // 007 replayed: the edge tables and their CHECK exist.
  const cols = await db('information_schema.columns').where({ table_name: 'edge_units' }).pluck('column_name');
  for (const c of ['unit_id', 'owner_kind', 'status', 'upstreams', 'desired_hash', 'active_hash', 'notified_at']) assert.ok(cols.includes(c), c);

  // ── fake edge ──
  const calls: string[][] = [];
  let reloads = 0;
  const confDirOf = (cmd: string[]) => (cmd[2] === '-c'
    ? path.join(localPaths.edgeSandbox(), cmd[3].slice('/etc/nginx/oblimint/sandbox/'.length).replace(/\/nginx\.conf$/, ''))
    : null);
  const broken = (dir: string): string | null => {
    for (const sub of ['global.d', 'conf.d', 'stream.d']) {
      const d = path.join(dir, sub);
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d)) {
        const lines = fs.readFileSync(path.join(d, f), 'utf8').split('\n');
        const i = lines.findIndex((l) => l.includes('BROKEN'));
        if (i >= 0) return `nginx: [emerg] unknown directive "BROKEN" in /etc/nginx/oblimint/${sub}/${f}:${i + 1}`;
      }
    }
    return null;
  };
  setEdgeRuntimeForTests({
    isRunning: async () => true,
    isAppSleeping: async () => false,
    sleep: async () => {},
    exec: async (cmd) => {
      calls.push(cmd);
      if (cmd[0] === 'nginx' && cmd[1] === '-t') {
        const err = broken(confDirOf(cmd) ?? path.dirname(localPaths.edgeConfD()));
        return err ? { exitCode: 1, stdout: '', stderr: err } : { exitCode: 0, stdout: '', stderr: '' };
      }
      if (cmd[0] === 'oblimint-edge-reload') { reloads++; return { exitCode: 0, stdout: '', stderr: '' }; }
      if (cmd[0] === 'oblimint-edge-probe') return { exitCode: 0, stdout: '200\n', stderr: '' };
      throw new Error(`unexpected exec ${cmd.join(' ')}`);
    },
  });
  clearEdgeUnitProvidersForTests();
  t.after(() => { setEdgeRuntimeForTests(null); clearEdgeUnitProvidersForTests(); edgeService.stop(); });

  // ── fixtures ──
  const suffix = Date.now().toString(36);
  const [tenantA] = await db('tenants').insert({ name: `EA ${suffix}`, slug: `ea-${suffix}` }).returning('id');
  const [tenantB] = await db('tenants').insert({ name: `EB ${suffix}`, slug: `eb-${suffix}` }).returning('id');
  const tA = Number(tenantA.id ?? tenantA);
  const tB = Number(tenantB.id ?? tenantB);
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number };
  const [plan] = await db('plans').insert({ tenant_id: tA, name: `ep-${suffix}`, limits: JSON.stringify({}) }).returning('id');
  const mkAccount = async (name: string, tenantId: number) => {
    const uid = 20000 + Math.floor(Math.random() * 30000);
    const [a] = await db('hosting_accounts').insert({
      tenant_id: tenantId, node_id: localNode.id, plan_id: Number(plan.id ?? plan), username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active',
    }).returning('id');
    return Number(a.id ?? a);
  };
  const acct = await mkAccount('eu', tA);
  const other = await mkAccount('eo', tA);
  const [dom] = await db('domains').insert({ tenant_id: tA, account_id: acct, name: `shop-${suffix}.example.com`, verification_status: 'verified', verification_method: 'admin' }).returning('id');
  const domId = Number(dom.id ?? dom);
  const user = async (username: string, kind: 'staff' | 'client', tenantId: number) => {
    const [row] = await db('users').insert({ username: `${username}-${suffix}`, kind, role: 'user', is_active: true }).returning('id');
    const id = Number(row.id ?? row);
    if (kind === 'staff') await db('user_tenants').insert({ user_id: id, tenant_id: tenantId, role: 'admin' });
    return id;
  };
  const client = await user('ec', 'client', tA);
  const staffB = await user('esb', 'staff', tB);
  const [admin] = await db('users').insert({ username: `ea-${suffix}`, kind: 'staff', role: 'admin', is_active: true }).returning('id');
  const adminId = Number(admin.id ?? admin);
  await db('user_tenants').insert({ user_id: adminId, tenant_id: 1, role: 'admin' });
  await db('account_users').insert({ user_id: client, account_id: acct, capabilities: JSON.stringify([]) });

  // A provider (proxy-hosts stand-in): one healthy unit of `acct`, one broken unit of `other`.
  let phBody = '        BROKEN;';
  const proxyUnit = (id: number, accountId: number, body: string) => ({
    id: `ph-${id}`, scope: 'http' as const, level: 'server' as const,
    owner: { kind: 'proxy-host' as const, id, accountId, tenantId: tA, label: `p${id}-${suffix}.example.org` },
    serverNames: [`p${id}-${suffix}.example.org`], listen: [], tls: null,
    config: `server {\n    listen 80;\n    server_name p${id}-${suffix}.example.org;\n    location / {\n        set $up http://app-1-web:80;\n        proxy_pass $up;\n${body}\n    }\n}\n`,
    files: {}, upstreams: [], rawSnippets: [],
  });
  let providerUnits = () => [proxyUnit(1, acct, ''), proxyUnit(2, other, phBody)];
  registerEdgeUnitProvider({ id: 'proxy-test', units: async () => providerUnits() });

  // ── first apply ──
  const r1 = await edgeService.syncNow();
  assert.equal(r1.ok, false, 'one unit refused → partial');
  assert.match(r1.error ?? '', /ph-2/);
  const rows = new Map((await db('edge_units').select('*')).map((r: { unit_id: string }) => [r.unit_id, r as Record<string, unknown>]));
  assert.equal(rows.get(`d-${domId}`)?.status, 'active');
  assert.equal(rows.get(`d-${domId}`)?.owner_kind, 'site-domain');
  assert.equal(Number(rows.get(`d-${domId}`)?.owner_id), domId);
  assert.equal(rows.get('ph-1')?.status, 'active');
  assert.equal(rows.get('ph-2')?.status, 'stub');
  assert.match(String(rows.get('ph-2')?.error), /unknown directive "BROKEN"/);
  assert.ok(rows.get('ph-2')?.notified_at, 'quarantine notified');
  assert.equal(rows.get('g-bans')?.status, 'active', 'built-in g-bans (no ban provider registered)');
  assert.ok(rows.get('ph-1')?.applied_at && rows.get('ph-1')?.desired_hash === rows.get('ph-1')?.active_hash);
  assert.equal(reloads, 1);
  const notifiedAt = String(rows.get('ph-2')?.notified_at);
  const applies = await db('edge_applies').orderBy('id');
  assert.equal(applies.length, 1);
  assert.equal(applies[0].result, 'partial');
  assert.equal(applies[0].units_quarantined, 1);

  const status = await edgeService.status();
  assert.equal(status.units?.stub, 1);
  assert.ok((status.units?.active ?? 0) >= 3);
  assert.equal(status.lastApply?.result, 'partial');

  // ── second pass, nothing changed: no new apply row, no new notification ──
  await edgeService.syncNow({ force: false });
  assert.equal((await db('edge_applies')).length, 1);
  assert.equal(String((await db('edge_units').where({ unit_id: 'ph-2' }).first()).notified_at), notifiedAt);

  // ── routes ──
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: Number(req.header('x-user')), currentTenantId: Number(req.header('x-tenant')) };
    (req as unknown as { tenantId: number }).tenantId = Number(req.header('x-tenant'));
    next();
  });
  app.use('/api/edge', edgeUnitsRoutes);
  app.use('/api/system/edge', systemEdgeUnitsRoutes);
  app.use(errorHandler);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, p: string, userId: number, tenantId: number) => {
    const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', 'x-user': String(userId), 'x-tenant': String(tenantId) } });
    return { status: res.status, body: await res.json() as { success: boolean; data: any; error?: string; code?: string } };
  };

  // Client: only its account's units, generic labels (A6).
  const mine = await call('GET', '/edge/units', client, tA);
  assert.equal(mine.status, 200);
  const ids = (mine.body.data as Array<{ unitId: string }>).map((u) => u.unitId).sort();
  assert.deepEqual(ids, [`d-${domId}`, 'ph-1'].sort());
  // Staff of another tenant: nothing of tenant A.
  const foreign = await call('GET', '/edge/units', staffB, tB);
  assert.deepEqual(foreign.body.data, []);
  // Admin view: everything, raw errors.
  const all = await call('GET', '/system/edge/units?status=stub', adminId, 1);
  assert.deepEqual((all.body.data as Array<{ unitId: string }>).map((u) => u.unitId), ['ph-2']);
  assert.match(all.body.data[0].error, /BROKEN/);
  // A client of the broken unit's account sees the generic label only.
  await db('account_users').insert({ user_id: client, account_id: other, capabilities: JSON.stringify([]) });
  const theirs = (await call('GET', '/edge/units?status=stub', client, tA)).body.data as Array<{ error: string }>;
  assert.equal(theirs.length, 1);
  assert.doesNotMatch(theirs[0].error, /BROKEN|nginx/);
  assert.equal((await call('GET', '/edge/units?status=bogus', client, tA)).status, 400);

  // statesForOwners (proxy-hosts).
  const states = await edgeUnitsService.statesForOwners('proxy-host', [1, 2, 999]);
  assert.deepEqual([...states.keys()].sort(), [1, 2]);
  assert.equal(states.get(2)?.status, 'stub');
  assert.equal(await edgeUnitsService.stateForOwner('proxy-host', 999), null);

  // Retry: the same broken version is re-tested (and still refused), audited.
  const sandboxTests = () => calls.filter((c) => c[1] === '-t' && c[2] === '-c').length;
  const before = sandboxTests();
  const retry = await call('POST', '/system/edge/units/ph-2/retry', adminId, 1);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.status, 'stub');
  assert.ok(sandboxTests() > before, 're-tested');
  assert.ok(await db('audit_logs').where({ action: 'edge.unit.retry', tenant_id: tA, resource_path: 'ph-2' }).first());
  assert.equal((await call('POST', '/system/edge/units/nope-1/retry', adminId, 1)).status, 404);
  assert.equal((await call('POST', '/system/edge/units/..%2Fx/retry', adminId, 1)).status, 404);

  // Fixed: active, applied.
  phBody = '        add_header X-Fixed 1;';
  await edgeService.syncNow({ force: false });
  assert.equal((await db('edge_units').where({ unit_id: 'ph-2' }).first()).status, 'active');
  assert.equal((await db('edge_units').where({ unit_id: 'ph-2' }).first()).notified_at, null);

  // Applies.
  const list = await call('GET', '/system/edge/applies?limit=10', adminId, 1);
  assert.equal(list.status, 200);
  assert.ok(list.body.data.length >= 2);
  assert.equal(list.body.data[0].result, 'ok');

  // Rollback: back to the previous good copy, the restored units held back, audited + recorded.
  const rb = await call('POST', '/system/edge/rollback', adminId, 1);
  assert.equal(rb.status, 200, JSON.stringify(rb.body));
  assert.equal(rb.body.data.result, 'rolledBack');
  const held = await db('edge_units').where({ unit_id: 'ph-2' }).first();
  assert.equal(held.status, 'stub', 'the previous good copy served its stub');
  assert.match(held.error, /^rolled back: /);
  assert.ok(await db('audit_logs').where({ action: 'edge.rollback' }).first());
  assert.match(fs.readFileSync(path.join(localPaths.edgeConfD(), 'ph-2.conf'), 'utf8'), /kind=stub/);
  // Held: the next sync keeps it, a retry re-applies it.
  await edgeService.syncNow({ force: false });
  assert.equal((await db('edge_units').where({ unit_id: 'ph-2' }).first()).status, 'stub');
  await call('POST', '/system/edge/units/ph-2/retry', adminId, 1);
  assert.equal((await db('edge_units').where({ unit_id: 'ph-2' }).first()).status, 'active');

  // A unit that disappears: its row and file go.
  providerUnits = () => [proxyUnit(1, acct, '')];
  await edgeService.syncNow({ force: false });
  assert.equal(await db('edge_units').where({ unit_id: 'ph-2' }).first(), undefined);
  assert.equal(fs.existsSync(path.join(localPaths.edgeConfD(), 'ph-2.conf')), false);

  // A provider that throws: its units keep their last applied version (file + row).
  registerEdgeUnitProvider({ id: 'proxy-test', units: async () => { throw new Error('db pool exhausted'); } });
  await edgeService.syncNow({ force: false });
  assert.ok(fs.existsSync(path.join(localPaths.edgeConfD(), 'ph-1.conf')));
  assert.ok(await db('edge_units').where({ unit_id: 'ph-1' }).first());

});
