import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

// Dashboard overview on a real PostgreSQL (DASHBOARD_TEST_DATABASE_URL, default
// the harness on port 55490; skipped when nothing listens): scoping of every
// block (a client sees its accounts only, no audit activity), counts.

const DB_URL = process.env.DASHBOARD_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55490/postgres';

function reachable(url: string): Promise<boolean> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 5432) });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(1500, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

test('dashboard overview scoping', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) { t.skip(`no PostgreSQL at ${DB_URL}`); return; }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-dash-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'dash-test-secret-0123456789abcdef';
  const { db } = await import('../db');
  const { actorForUser } = await import('./hosting/access');
  const { dashboardOverview } = await import('./dashboardOverview');
  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  const suffix = Date.now().toString(36);
  const [ta] = await db('tenants').insert({ name: `D ${suffix}`, slug: `d-${suffix}` }).returning('id');
  const tA = Number(ta.id ?? ta);
  const user = async (name: string, kind: 'staff' | 'client') => {
    const [row] = await db('users').insert({ username: `${name}-${suffix}`, kind, role: 'user', is_active: true }).returning('id');
    const id = Number(row.id ?? row);
    if (kind === 'staff') await db('user_tenants').insert({ user_id: id, tenant_id: tA, role: 'admin' });
    return id;
  };
  const staff = await user('staff', 'staff');
  const client = await user('client', 'client');
  const node = (await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined;
  const nodeId = node?.id ?? Number((await db('nodes').insert({ name: `n-${suffix}`, is_local: true }).returning('id'))[0].id);
  const mkAccount = async (name: string) => {
    const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${name}-${suffix}`, limits: JSON.stringify({}) }).returning('id');
    const uid = 20000 + Math.floor(Math.random() * 30000);
    const [a] = await db('hosting_accounts').insert({
      tenant_id: tA, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
    }).returning('id');
    return Number(a.id ?? a);
  };
  const mine = await mkAccount('mine');
  const other = await mkAccount('other');
  await db('account_users').insert({ user_id: client, account_id: mine, capabilities: JSON.stringify([]) });
  const mkSite = async (accountId: number, slug: string, status: string) => {
    const [s] = await db('sites').insert({
      tenant_id: tA, account_id: accountId, name: slug, slug, base: 'nginx-static', docroot: '', base_path: '/', publish_mode: 'manual',
      publish_debounce_sec: 30, healthcheck_path: '/', status, status_message: status === 'error' ? 'boom' : null, php_settings: JSON.stringify({}),
    }).returning('id');
    return Number(s.id ?? s);
  };
  const a1 = await mkSite(mine, 'a1', 'active');
  await mkSite(mine, 'a2', 'error');
  const b1 = await mkSite(other, 'b1', 'error');
  await db('releases').insert([
    { site_id: a1, number: 1, status: 'ready', trigger: 'manual' },
    { site_id: a1, number: 2, status: 'awaiting_approval', trigger: 'api' },
    { site_id: b1, number: 1, status: 'failed', trigger: 'manual' },
  ]);
  await db('uptime_monitors').insert([
    { tenant_id: tA, account_id: mine, name: 'mine-up', kind: 'http', url: 'https://example.com', status: 'up' },
    { tenant_id: tA, account_id: other, name: 'other-down', kind: 'http', url: 'https://example.org', status: 'down', last_error: 'timeout' },
  ]);

  const asClient = await dashboardOverview(await actorForUser(client, tA));
  assert.equal(asClient.sites.total, 2);
  assert.deepEqual(asClient.sites.byStatus, { active: 1, stopped: 0, error: 1, provisioning: 0 });
  assert.deepEqual(asClient.sites.problems.map((p) => p.name), ['a2']);
  assert.equal(asClient.pending.approvals, 1);
  assert.equal(asClient.pending.failedReleases, 0, 'the other account failure is not visible');
  assert.deepEqual(asClient.releases.map((r) => `${r.siteName}#${r.number}`).sort(), ['a1#1', 'a1#2']);
  assert.deepEqual(asClient.uptime.downList, []);
  assert.equal(asClient.uptime.up, 1);
  assert.deepEqual(asClient.activity, [], 'no audit for a client');

  const asStaff = await dashboardOverview(await actorForUser(staff, tA));
  assert.ok(asStaff.sites.total >= 3);
  assert.ok(asStaff.sites.problems.some((p) => p.name === 'b1'));
  assert.ok(asStaff.pending.failedReleases >= 1);
  assert.ok(asStaff.uptime.downList.some((m) => m.name === 'other-down'));
});
