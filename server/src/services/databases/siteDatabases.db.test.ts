import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// Databases ↔ sites (migration 030) on PostgreSQL:
//   SITEDB_TEST_DATABASE_URL (default port 55449).
// Covers: 030 objects + pinning of the edited default links, the owner backfill
// from the site environments (owner / shared / ambiguous / nothing breaks),
// the panel routes (list, site databases, create for a site, owner, share,
// detach, grantUser, isolation, gates), the default site → DB links following
// the attachments, cascades, and the access keys (reach, masking, scope rules).
// Docker = FakeDocker, SQL clients = a recording fake.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.SITEDB_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55449/postgres';

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

test('databases ↔ sites on PostgreSQL', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-sitedb-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'sitedb-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const routes = (await import('../../routes/databases.routes')).default;
  const { setEngineFactoryForTests } = await import('../docker/engine');
  const { FakeDocker } = await import('../docker/testing/fakeDocker');
  const { setDbExecForTests } = await import('./exec');
  const { seal } = await import('../../utils/secretBox');
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');
  const { reconcileDefaultDbLinks } = await import('../network/defaultLinks');
  const { setSegmentBackendsForTests } = await import('../network/deps');
  const { resetSegmentSyncForTests } = await import('../network/sync');
  const { runSiteDatabasesBackfill } = await import('./siteDbBackfill');
  const { sitesService } = await import('../hosting/sites.service');
  const { actorForUser } = await import('../hosting/access');
  const { apiKeysService } = await import('../apiKeys/apiKeys.service');
  const { keyDatabases } = await import('../apiKeys/keyDatabases');

  await db.migrate.latest();
  await db('tenants').update({ action_restrictions: '{}' });
  t.after(async () => { await db.destroy(); });

  // ── fakes ──────────────────────────────────────────────────────────────────
  const docker = new FakeDocker();
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number };
  setEngineFactoryForTests(() => docker.asDocker(), localNode.id);
  const sqls: string[] = [];
  setDbExecForTests(async (_docker, _container, _cmd, opts = {}) => {
    const sqlEnv = (opts.env ?? []).find((e) => e.startsWith('OBLIMINT_SQL='));
    if (sqlEnv) sqls.push(sqlEnv.slice('OBLIMINT_SQL='.length));
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  // The policy push requested after each change runs on a node without accounts (it would reconcile the
  // links in the background, racing the assertions): hostd accepts, Docker has no networks.
  setSegmentBackendsForTests({
    docker: async () => ({ listNetworks: async () => [], listContainers: async () => [], getNetwork: () => ({ inspect: async () => { throw Object.assign(new Error('no'), { statusCode: 404 }); } }) }) as never,
    localNode: async () => 999_999,
    hostd: () => ({ setSegments: async () => undefined }) as never,
    proxyTargets: async () => [],
  });
  t.after(() => { setEngineFactoryForTests(null); setDbExecForTests(null); setSegmentBackendsForTests(null); resetSegmentSyncForTests(); });

  // ── fixtures ───────────────────────────────────────────────────────────────
  const suffix = Date.now().toString(36);
  const [tenantA] = await db('tenants').insert({ name: `A ${suffix}`, slug: `a-${suffix}` }).returning('id');
  const [tenantB] = await db('tenants').insert({ name: `B ${suffix}`, slug: `b-${suffix}` }).returning('id');
  const tA = Number(tenantA.id ?? tenantA);
  const tB = Number(tenantB.id ?? tenantB);
  const user = async (username: string, kind: 'staff' | 'client', tenantId: number) => {
    const [row] = await db('users').insert({ username: `${username}-${suffix}`, kind, role: kind === 'staff' ? 'admin' : 'user', is_active: true }).returning('id');
    const id = Number(row.id ?? row);
    if (kind === 'staff') await db('user_tenants').insert({ user_id: id, tenant_id: tenantId, role: 'admin' });
    return id;
  };
  const clientRead = await user('cr', 'client', tA);
  const clientManage = await user('cm', 'client', tA);
  const clientOther = await user('co', 'client', tA);
  const staffB = await user('stb', 'staff', tB);
  const limits = { ...DEFAULT_PLAN_LIMITS, maxDatabases: 50, maxDbInstances: 5, dbEngines: null };
  const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify(limits) }).returning('id');
  const planId = Number(plan.id ?? plan);
  const mkAccount = async (name: string, model: 'segmented' | 'legacy') => {
    const uid = 20000 + Math.floor(Math.random() * 30000);
    const [a] = await db('hosting_accounts').insert({
      tenant_id: tA, node_id: localNode.id, plan_id: planId, username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off', network_model: model,
    }).returning('id');
    return Number(a.id ?? a);
  };
  const acct = await mkAccount('acme', 'segmented');
  const other = await mkAccount('other', 'segmented');
  await db('account_users').insert([
    { user_id: clientRead, account_id: acct, capabilities: JSON.stringify([]) },
    { user_id: clientManage, account_id: acct, capabilities: JSON.stringify(['databases.manage', 'sites.manage']) },
    { user_id: clientOther, account_id: other, capabilities: JSON.stringify(['databases.manage', 'sites.manage']) },
  ]);
  const mkSite = async (accountId: number, slug: string) => {
    const [s] = await db('sites').insert({ tenant_id: tA, account_id: accountId, name: `Site ${slug}`, slug, base: 'php-8.3' }).returning('id');
    return Number(s.id ?? s);
  };
  const s1 = await mkSite(acct, 'one');
  const s2 = await mkSite(acct, 'two');
  const s3 = await mkSite(acct, 'three');
  const sOther = await mkSite(other, 'oth');
  const mkInstance = async (accountId: number, name: string, engine: string, version: string) => {
    const [i] = await db('db_instances').insert({
      tenant_id: tA, account_id: accountId, node_id: localNode.id, name, engine, version, root_secret: seal('db-root', 'rootpw'), status: 'running', is_default: true,
    }).returning('id');
    return Number(i.id ?? i);
  };
  const m = await mkInstance(acct, 'maria', 'mariadb', '11.4');
  const p = await mkInstance(acct, 'pg', 'postgresql', '17');
  const mOther = await mkInstance(other, 'othdb', 'mariadb', '11.4');
  const mkDb = async (instanceId: number, accountId: number, name: string) => {
    const [d] = await db('db_databases').insert({ instance_id: instanceId, account_id: accountId, name }).returning('id');
    return Number(d.id ?? d);
  };
  const shop = await mkDb(m, acct, 'shop');
  const blog = await mkDb(m, acct, 'blog');
  const stats = await mkDb(p, acct, 'stats');
  await mkDb(mOther, other, 'shop'); // same name, another account: never matched
  const env = async (siteId: number, accountId: number, vars: Record<string, string>) => {
    for (const [name, value] of Object.entries(vars)) {
      await db('site_env_vars').insert({ site_id: siteId, account_id: accountId, name, value_sealed: seal('site-env', value), secret: name.includes('URL') });
    }
  };
  await env(s1, acct, { DB_NAME: 'shop', DB_HOST: 'localhost' });
  await env(s2, acct, { MYSQL_DATABASE: 'shop', DATABASE_URL: `postgres://app:pw@db-${p}:5432/stats` });
  await env(s3, acct, { APP_NAME: 'shop' }); // not a database variable: matches nothing
  await env(sOther, other, { DB_NAME: 'shop' });

  // Default links as before 030: every pair of the segmented accounts.
  await reconcileDefaultDbLinks([{ accountId: acct, tenantId: tA }, { accountId: other, tenantId: tA }]);
  const links = async (accountId = acct) => (await db('network_links').where({ account_id: accountId, source_kind: 'site', target_kind: 'db' })
    .orderBy(['source_id', 'target_id']).select('id', 'source_id', 'target_id', 'enabled', 'pinned', 'origin')) as Array<{ id: number; source_id: number; target_id: number; enabled: boolean; pinned: boolean; origin: string }>;
  const linkOf = async (siteId: number, instanceId: number) => (await links()).find((l) => l.source_id === siteId && l.target_id === instanceId);
  assert.equal((await links()).length, 6, '3 sites × 2 instances');

  // ── 030: objects, and the default links that already carry a choice get pinned ──
  // Re-run 030 on links edited before it: disabled, another port, edited description.
  // 032 (public ports) and 031 (network_addresses) sit above 030: rolled back first, then 030 itself.
  await db.migrate.down();
  await db.migrate.down();
  await db.migrate.down();
  assert.equal(await db.schema.hasTable('site_databases'), false);
  const l12 = (await db('network_links').where({ source_id: s1, target_id: p }).first('id')) as { id: number };
  const l22 = (await db('network_links').where({ source_id: s2, target_id: p }).first('id')) as { id: number };
  const l32 = (await db('network_links').where({ source_id: s3, target_id: m }).first('id')) as { id: number };
  await db('network_links').where({ id: l12.id }).update({ enabled: false });
  await db('network_links').where({ id: l22.id }).update({ description: 'mine' });
  await db('network_links').where({ id: l32.id }).update({ port: 3307 });
  await db.migrate.latest();
  assert.ok(await db.schema.hasTable('site_databases'));
  assert.deepEqual((await links()).filter((l) => l.pinned).map((l) => l.id).sort((a, b) => a - b), [l12.id, l22.id, l32.id].sort((a, b) => a - b));
  // Back to the defaults for what follows.
  await db('network_links').whereIn('id', [l12.id, l22.id, l32.id]).update({ enabled: true, pinned: false, port: db.raw(`CASE WHEN target_id = ${p} THEN 5432 ELSE 3306 END`), description: 'x' });
  assert.equal((await db('app_config').where({ key: 'site_databases_backfill' }).first('value'))?.value, 'pending');

  // FK isolation: a site of another account cannot own a database of this one.
  await assert.rejects(db('site_databases').insert({ tenant_id: tA, account_id: acct, site_id: sOther, database_id: shop, role: 'owner' }));
  await assert.rejects(db('site_databases').insert({ tenant_id: tB, account_id: acct, site_id: s1, database_id: shop, role: 'owner' }), 'tenant of the account');
  await db('site_databases').insert({ tenant_id: tA, account_id: acct, site_id: s1, database_id: blog, role: 'owner' });
  await assert.rejects(db('site_databases').insert({ tenant_id: tA, account_id: acct, site_id: s2, database_id: blog, role: 'owner' }), 'one owner per database');
  await db('site_databases').where({ database_id: blog }).del();

  // ── backfill ───────────────────────────────────────────────────────────────
  await runSiteDatabasesBackfill();
  const rows = async () => (await db('site_databases').where({ account_id: acct }).orderBy(['database_id', 'site_id']).select('site_id', 'database_id', 'role'))
    .map((r: { site_id: number; database_id: number; role: string }) => [r.database_id, r.site_id, r.role]);
  assert.deepEqual(await rows(), [[shop, s1, 'owner'], [shop, s2, 'shared'], [stats, s2, 'owner']], 'first by id owns, the others share; blog stays account-wide');
  assert.deepEqual((await db('site_databases').where({ account_id: other }).select('site_id', 'database_id', 'role')).map((r: { site_id: number }) => r.site_id), [sOther], 'same name in another account: its own database');
  assert.match((await db('app_config').where({ key: 'site_databases_backfill' }).first('value'))?.value ?? '', /^done /);
  // Instance m still holds blog (account-wide): every site keeps its link. Instance p: stats belongs to s2 only.
  assert.deepEqual((await links()).map((l) => [l.source_id, l.target_id, l.enabled, l.pinned]), [
    [s1, m, true, false], [s1, p, true, true], // s1 matched (shop) but may reach p by a config file: kept (pinned)
    [s2, m, true, false], [s2, p, true, false],
    [s3, m, true, false], [s3, p, true, true], // s3 matched NOTHING: its link is kept (pinned)
  ]);
  // Unpinned (the panel manages it again): the rule applies, s1 has nothing on p.
  await db('network_links').where({ source_id: s1, target_id: p }).update({ pinned: false });
  await reconcileDefaultDbLinks([{ accountId: acct, tenantId: tA }]);
  assert.equal((await linkOf(s1, p))?.enabled, false, 'unpinned: follows the rule');
  const backfillAudit = await db('audit_logs').where({ action: 'db.database.backfill', tenant_id: tA }).orderBy('id').select('details');
  assert.equal(backfillAudit.length, 2, 'one entry per account');
  assert.ok(!JSON.stringify(backfillAudit).includes('pw@'), 'no variable value in the audit');
  // Once only.
  await db('site_databases').where({ database_id: stats }).del();
  await runSiteDatabasesBackfill();
  assert.equal((await db('site_databases').where({ database_id: stats }).count('* as n'))[0].n, '0', 'not run twice');
  await db('site_databases').insert({ tenant_id: tA, account_id: acct, site_id: s2, database_id: stats, role: 'owner' });

  // ── app ────────────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: Number(req.header('x-user')) };
    (req as unknown as { tenantId: number }).tenantId = Number(req.header('x-tenant'));
    next();
  });
  app.use('/databases', routes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  type Who = { user: number; tenant: number };
  const call = async (method: string, url: string, who: Who, body?: unknown) => {
    const res = await fetch(`${base}${url}`, {
      method, headers: { 'content-type': 'application/json', 'x-user': String(who.user), 'x-tenant': String(who.tenant) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as { success: boolean; data?: any; code?: string; error?: string } };
  };
  const asReader: Who = { user: clientRead, tenant: tA };
  const asManager: Who = { user: clientManage, tenant: tA };
  const asOther: Who = { user: clientOther, tenant: tA };
  const asStaffB: Who = { user: staffB, tenant: tB };

  // ── lists ──────────────────────────────────────────────────────────────────
  let r = await call('GET', `/databases/databases?accountId=${acct}`, asReader);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const byName = (list: any[]) => Object.fromEntries(list.map((d) => [d.name, d]));
  let list = byName(r.body.data);
  assert.deepEqual(Object.keys(list).sort(), ['blog', 'shop', 'stats']);
  assert.deepEqual(list.shop.ownerSite, { id: s1, name: 'Site one', slug: 'one' });
  assert.deepEqual(list.shop.sharedSites.map((s: { id: number }) => s.id), [s2]);
  assert.equal(list.blog.ownerSite, null, 'shared across the account');
  assert.equal(list.stats.family, 'postgresql');
  r = await call('GET', `/databases/databases?siteId=${s2}`, asReader);
  assert.deepEqual(r.body.data.map((d: { name: string }) => d.name).sort(), ['shop', 'stats'], 'filtered by site');
  r = await call('GET', '/databases/databases', asOther);
  assert.deepEqual(r.body.data.map((d: { accountId: number }) => d.accountId), [other], 'a client sees only his accounts');
  r = await call('GET', `/databases/databases?siteId=${s1}`, asStaffB);
  assert.equal(r.status, 404, 'staff of another tenant');
  r = await call('GET', `/databases/sites/${s2}/databases`, asReader);
  assert.deepEqual(r.body.data.map((d: { name: string; role: string }) => [d.name, d.role]), [['stats', 'owner'], ['shop', 'shared']], 'owned first');
  r = await call('GET', `/databases/sites/${s1}/databases`, asOther);
  assert.equal(r.status, 404);
  const detail = await sitesService.get(await actorForUser(clientRead, tA), s1);
  assert.deepEqual(detail.databases?.map((d) => [d.name, d.role]), [['shop', 'owner']], 'site detail carries its databases');
  r = await call('GET', `/databases/instances/${m}`, asReader);
  assert.equal(byName(r.body.data.databases).shop.ownerSite.id, s1, 'instance detail too');

  // ── owner / share / detach ─────────────────────────────────────────────────
  r = await call('PUT', `/databases/instances/${m}/databases/${blog}/owner`, asReader, { siteId: s3 });
  assert.equal(r.status, 403, 'databases.manage needed');
  r = await call('PUT', `/databases/instances/${m}/databases/${blog}/owner`, asOther, { siteId: s3 });
  assert.equal(r.status, 404, 'another account');
  r = await call('PUT', `/databases/instances/${m}/databases/${blog}/owner`, asManager, { siteId: sOther });
  assert.ok([400, 404].includes(r.status), 'a site of another account');
  r = await call('PUT', `/databases/instances/${m}/databases/${blog}/owner`, asManager, { siteId: s3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.database.ownerSite.id, s3);
  assert.deepEqual(r.body.data.network, [], 'every site still has a reason to reach m');
  assert.ok(await db('audit_logs').where({ action: 'db.database.attach', tenant_id: tA }).first('id'));

  // s2 stops sharing shop: on m everything belongs to s1 / s3 → its default link goes.
  r = await call('DELETE', `/databases/instances/${m}/databases/${shop}/sites/${s2}`, asManager);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.network.map((n: { siteId: number; instanceId: number; change: string }) => [n.siteId, n.instanceId, n.change]), [[s2, m, 'disabled']]);
  assert.equal((await linkOf(s2, m))?.enabled, false);
  r = await call('DELETE', `/databases/instances/${m}/databases/${shop}/sites/${s2}`, asManager);
  assert.equal(r.status, 404, 'not attached any more');

  // Shared again, with a grant for an existing user of m: the link comes back, the right is added.
  const [u] = await db('db_users').insert({ instance_id: m, account_id: acct, username: 'two_app' }).returning('id');
  const uid = Number(u.id ?? u);
  await db('db_grants').insert({ instance_id: m, user_id: uid, database_id: blog, level: 'all' });
  r = await call('POST', `/databases/instances/${m}/databases/${shop}/shares`, asManager, { siteId: s1 });
  assert.equal(r.status, 409, 'the owner is not shared with');
  assert.equal(r.body.code, 'siteOwnsDatabase');
  r = await call('POST', `/databases/instances/${m}/databases/${shop}/shares`, asManager, { siteId: s2, grantUser: { userId: 999999, level: 'readonly' } });
  assert.equal(r.status, 404, 'unknown user: nothing done');
  assert.equal((await db('site_databases').where({ database_id: shop, site_id: s2 }).first()), undefined);
  sqls.length = 0;
  r = await call('POST', `/databases/instances/${m}/databases/${shop}/shares`, asManager, { siteId: s2, grantUser: { userId: uid, level: 'readonly' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.network.map((n: { siteId: number; change: string }) => [n.siteId, n.change]), [[s2, 'enabled']]);
  assert.deepEqual(r.body.data.grantedUser.grants.map((g: { databaseName: string; level: string }) => [g.databaseName, g.level]), [['blog', 'all'], ['shop', 'readonly']], 'added, the other right kept');
  assert.ok(sqls.some((s) => /GRANT SELECT/i.test(s) && s.includes('shop')), sqls.join('\n'));
  // Already 'all' on blog: a readonly request never lowers it.
  r = await call('POST', `/databases/instances/${m}/databases/${blog}/shares`, asManager, { siteId: s2, grantUser: { userId: uid, level: 'readonly' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.grantedUser.grants.find((g: { databaseName: string }) => g.databaseName === 'blog').level, 'all');

  // New owner: the previous owner keeps it as shared.
  r = await call('PUT', `/databases/instances/${m}/databases/${shop}/owner`, asManager, { siteId: s2 });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.data.database.ownerSite.id, r.body.data.database.sharedSites.map((s: { id: number }) => s.id)], [s2, [s1]]);
  // No owner any more: stats is shared across the account → s1 reaches p again (s3's pinned link untouched).
  r = await call('PUT', `/databases/instances/${p}/databases/${stats}/owner`, asManager, { siteId: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.database.ownerSite, null);
  assert.deepEqual(r.body.data.database.sharedSites.map((s: { id: number }) => s.id), [s2], 'the previous owner stays attached');
  assert.deepEqual(r.body.data.network.map((n: { siteId: number; instanceId: number; change: string }) => [n.siteId, n.instanceId, n.change]), [[s1, p, 'enabled']]);

  // A user link and a pinned link are never touched by the rule.
  await db('site_databases').insert({ tenant_id: tA, account_id: acct, site_id: s2, database_id: stats, role: 'owner' }).onConflict(['site_id', 'database_id']).merge({ role: 'owner' });
  await db('network_links').where({ source_id: s1, target_id: p }).update({ pinned: true });
  await reconcileDefaultDbLinks([{ accountId: acct, tenantId: tA }]);
  assert.equal((await linkOf(s1, p))?.enabled, true, 'pinned: kept enabled');
  await db('network_links').where({ source_id: s1, target_id: p }).update({ pinned: false });
  await reconcileDefaultDbLinks([{ accountId: acct, tenantId: tA }]);
  assert.equal((await linkOf(s1, p))?.enabled, false, 'unpinned: follows the rule');

  // ── create for a site ──────────────────────────────────────────────────────
  r = await call('POST', `/databases/sites/${s1}/databases`, asReader, { name: 'one_pg', family: 'postgresql' });
  assert.equal(r.status, 403);
  r = await call('POST', `/databases/sites/${s1}/databases`, asManager, { name: 'one_pg', family: 'postgresql' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.data.instanceId, r.body.data.role, r.body.data.ownerSite.id], [p, 'owner', s1], 'default instance of the family');
  const onePg = r.body.data.id as number;
  assert.equal((await linkOf(s1, p))?.enabled, true, 'its own database: s1 reaches p again');
  r = await call('POST', `/databases/sites/${sOther}/databases`, asOther, { name: 'x', family: 'postgresql' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'noDefaultInstance');
  r = await call('POST', `/databases/sites/${s1}/databases`, asManager, { name: 'x', family: 'mysql', instanceId: p });
  assert.equal(r.status, 400, 'instance of another family');
  r = await call('POST', `/databases/instances/${m}/databases`, asManager, { name: 'cross', siteId: sOther });
  assert.ok([400, 404].includes(r.status), 'owner in another account');
  r = await call('POST', `/databases/instances/${m}/databases`, asManager, { name: 'three_db', siteId: s3 });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.ownerSite.id, s3);
  const threeDb = r.body.data.id as number;

  // ── cascades ───────────────────────────────────────────────────────────────
  r = await call('DELETE', `/databases/instances/${p}/databases/${onePg}`, asManager, { confirm: 'one_pg' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await db('site_databases').where({ database_id: onePg }).first(), undefined);
  assert.equal((await linkOf(s1, p))?.enabled, false, 'its last reason on p went with it');

  // ── gates ──────────────────────────────────────────────────────────────────
  await db('tenants').where({ id: tA }).update({ action_restrictions: JSON.stringify({ 'db.attach': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' } }) });
  r = await call('PUT', `/databases/instances/${m}/databases/${threeDb}/owner`, asManager, { siteId: s1 });
  assert.ok(r.status === 403 || r.status === 428, `protected: ${r.status} ${r.body.code}`);
  assert.equal((await db('site_databases').where({ database_id: threeDb, role: 'owner' }).first('site_id'))?.site_id, s3, 'nothing changed');
  r = await call('POST', `/databases/instances/${m}/databases/${threeDb}/shares`, asManager, { siteId: s1 });
  assert.equal(r.status, 200, 'db.share stays free');
  // A database created owned by a site is an attachment: gated the same, nothing created.
  r = await call('POST', `/databases/sites/${s1}/databases`, asManager, { name: 'gated_one', family: 'mysql' });
  assert.ok(r.status === 403 || r.status === 428, `create for a site: ${r.status} ${r.body.code}`);
  r = await call('POST', `/databases/instances/${m}/databases`, asManager, { name: 'gated_two', siteId: s1 });
  assert.ok(r.status === 403 || r.status === 428, `create with siteId: ${r.status} ${r.body.code}`);
  assert.equal(await db('db_databases').whereIn('name', ['gated_one', 'gated_two']).first('id'), undefined, 'nothing created');
  r = await call('POST', `/databases/instances/${m}/databases`, asManager, { name: 'free_db' });
  assert.equal(r.status, 201, 'without an owner: no attachment, free');
  const freeDb = r.body.data.id as number;
  // db.share protected on the OWNER site only (s3): sharing its database with another site is gated too.
  await db('tenants').where({ id: tA }).update({ action_restrictions: JSON.stringify({ 'db.share': { level: 'sensitive', scope: { mode: 'include', siteIds: [s3] }, via: 'all' } }) });
  r = await call('POST', `/databases/instances/${m}/databases/${threeDb}/shares`, asManager, { siteId: s2 });
  assert.ok(r.status === 403 || r.status === 428, `owner site protected: ${r.status} ${r.body.code}`);
  assert.equal(await db('site_databases').where({ database_id: threeDb, site_id: s2 }).first(), undefined, 'not shared');
  r = await call('POST', `/databases/instances/${m}/databases/${freeDb}/shares`, asManager, { siteId: s2 });
  assert.equal(r.status, 200, 'no owner, receiving site not protected: free');
  await db('tenants').where({ id: tA }).update({ action_restrictions: '{}' });

  // ── access keys ────────────────────────────────────────────────────────────
  const fakeReq = () => ({ headers: {}, session: { userId: clientManage }, socket: { remoteAddress: '203.0.113.7' } }) as never;
  const ownerActor = await actorForUser(clientManage, tA);
  const k1 = await apiKeysService.create(fakeReq(), ownerActor, acct, { name: 'one', scopes: ['databases.manage'], siteScope: 'selected', siteIds: [s1] });
  const kAll = await apiKeysService.create(fakeReq(), ownerActor, acct, { name: 'all', scopes: ['databases.manage'], siteScope: 'all' });
  const c1 = (await apiKeysService.verify(k1.key!, '203.0.113.7'))!;
  const cAll = (await apiKeysService.verify(kAll.key!, '203.0.113.7'))!;
  assert.ok(c1 && cAll);
  // s1: shop (shared with it, owned by s2 — hidden) and three_db (shared with it); never blog / stats.
  const seen = (await keyDatabases.list(c1)).flatMap((i) => i.databases);
  assert.deepEqual(seen.map((d) => d.name).sort(), ['shop', 'three_db']);
  const shopSeen = seen.find((d) => d.name === 'shop')!;
  assert.equal(shopSeen.ownerSite, null);
  assert.equal(shopSeen.ownedElsewhere, true, 'owner outside the key: hidden');
  assert.deepEqual(shopSeen.sharedSites?.map((s) => s.id), [s1], 'only the key\'s sites');
  assert.deepEqual((await keyDatabases.siteDatabases(c1, s1)).map((d) => [d.name, d.role]), [['shop', 'shared'], ['three_db', 'shared']]);
  await assert.rejects(keyDatabases.siteDatabases(c1, s2), (e: { statusCode: number }) => e.statusCode === 404);
  await assert.rejects(keyDatabases.setOwner(c1, fakeReq(), m, blog, { siteId: s1 }), (e: { statusCode: number }) => e.statusCode === 404, 'out of reach');
  await assert.rejects(keyDatabases.setOwner(c1, fakeReq(), m, shop, { siteId: s1 }), (e: { code: string }) => e.code === 'keySiteScope', 'owned by a site outside the key');
  await assert.rejects(keyDatabases.setOwner(c1, fakeReq(), m, shop, { siteId: null }), (e: { code: string }) => e.code === 'keySiteScope');
  await assert.rejects(keyDatabases.share(c1, fakeReq(), m, shop, { siteId: s2 }), (e: { statusCode: number }) => e.statusCode === 404, 'a site outside the key');
  const created = await keyDatabases.createForSite(c1, fakeReq(), s1, { name: 'key_db', family: 'mysql' });
  assert.deepEqual([created.instanceId, created.role, created.ownerSite?.id, created.createdByKey], [m, 'owner', s1, true]);
  await assert.rejects(keyDatabases.detach(c1, fakeReq(), m, created.id, s1), (e: { code: string }) => e.code === 'keySiteScope', 'would become shared across the account');
  const viaInst = await keyDatabases.createDatabase(c1, fakeReq(), m, { name: 'key_db2', siteId: s1 });
  assert.equal(viaInst.ownerSite?.id, s1);
  await assert.rejects(keyDatabases.createDatabase(c1, fakeReq(), m, { name: 'key_db3', siteId: s2 }), (e: { statusCode: number }) => e.statusCode === 404);
  // setGrants of a limited key never revokes a right on a database it only REACHES (shared with its site):
  // the panel's grant on shop stays, only the databases the key created are its to change.
  const kUser = await keyDatabases.createUser(c1, fakeReq(), m, { username: 'k1_app', grants: [{ databaseId: created.id, level: 'all' }] });
  await db('db_grants').insert({ instance_id: m, user_id: kUser.user.id, database_id: shop, level: 'readonly' });
  await keyDatabases.setGrants(c1, fakeReq(), m, kUser.user.id, [{ databaseId: created.id, level: 'readonly' }]);
  assert.deepEqual((await db('db_grants').where({ user_id: kUser.user.id }).orderBy('database_id').select('database_id', 'level')).map((g: { database_id: number; level: string }) => [g.database_id, g.level]),
    [[shop, 'readonly'], [created.id, 'readonly']].sort((a, b) => Number(a[0]) - Number(b[0])), 'the grant on shop is kept');
  // A key on s1 + s3 reaches shop (shared with s1) but never shares it further: its owner (s2) is outside the key.
  const k13 = await apiKeysService.create(fakeReq(), ownerActor, acct, { name: 'one-three', scopes: ['databases.manage'], siteScope: 'selected', siteIds: [s1, s3] });
  const c13 = (await apiKeysService.verify(k13.key!, '203.0.113.7'))!;
  await assert.rejects(keyDatabases.share(c13, fakeReq(), m, shop, { siteId: s3 }), (e: { statusCode: number; code: string }) => e.statusCode === 403 && e.code === 'keySiteScope');
  assert.equal(await db('site_databases').where({ database_id: shop, site_id: s3 }).first(), undefined, 'not shared');
  // Its own site's database: shared with its other site.
  const sharedOwn = await keyDatabases.share(c13, fakeReq(), m, created.id, { siteId: s3 });
  assert.deepEqual(sharedOwn.database.sharedSites.map((s) => s.id), [s3]);
  // Creating a database owned by a site through a key: db.attach gated too.
  await db('tenants').where({ id: tA }).update({ action_restrictions: JSON.stringify({ 'db.attach': { level: 'sensitive', scope: { mode: 'all' }, via: 'all' } }) });
  await assert.rejects(keyDatabases.createForSite(c1, fakeReq(), s1, { name: 'key_gated', family: 'mysql' }), (e: { code: string }) => ['twoFactorNotEnrolled', 'twoFactorRequired'].includes(e.code));
  await assert.rejects(keyDatabases.createDatabase(c1, fakeReq(), m, { name: 'key_gated2', siteId: s1 }), (e: { code: string }) => ['twoFactorNotEnrolled', 'twoFactorRequired'].includes(e.code));
  assert.equal(await db('db_databases').whereIn('name', ['key_gated', 'key_gated2']).first('id'), undefined, 'nothing created');
  await db('tenants').where({ id: tA }).update({ action_restrictions: '{}' });
  // Its own database: the owner may move between its sites (only s1 here) — and a key on every site may do anything.
  const res = await keyDatabases.setOwner(cAll, fakeReq(), m, created.id, { siteId: null });
  assert.equal(res.database.ownerSite, null);
  const res2 = await keyDatabases.setOwner(c1, fakeReq(), m, created.id, { siteId: s1 });
  assert.equal(res2.database.ownerSite?.id, s1, 'created by the key: it may own it again');
  assert.deepEqual((await keyDatabases.detach(cAll, fakeReq(), m, shop, s1)).database.sharedSites.map((s) => s.id), []);
  assert.ok(!(await keyDatabases.list(c1)).flatMap((i) => i.databases).some((d) => d.name === 'shop'), 'no longer shared with s1: out of the key\'s reach');
  const keyAudit = await db('audit_logs').where({ action: 'db.database.detach', tenant_id: tA }).orderBy('id', 'desc').first('details');
  assert.ok(keyAudit);

  // ── a deleted site takes its attachments with it ───────────────────────────
  await db('sites').where({ id: s3 }).del();
  assert.equal(await db('site_databases').where({ site_id: s3 }).first(), undefined);
});
