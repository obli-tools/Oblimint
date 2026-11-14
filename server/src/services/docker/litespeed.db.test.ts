import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

// litespeed bases on a real PostgreSQL (LITESPEED_TEST_DATABASE_URL, skipped
// when nothing listens): migration 045 (sites.lscache_enabled), the site
// setting (service + rights), the runtime config written for the containers,
// the purge of the page cache (409 on a base without one, docker exec
// `oblimint-reload --cache-only` on the running litespeed containers only),
// and the
// reserved environment names of lsphp.

const DB_URL = process.env.LITESPEED_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55465/postgres';

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

test('litespeed bases: LSCache setting, runtime config, purge, API view, installer option', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) { t.skip(`no PostgreSQL at ${DB_URL}`); return; }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-lsws-db-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'lsws-test-secret-0123456789abcdef';

  const { db } = await import('../../db');
  const { actorForUser } = await import('../hosting/access');
  const { sitesService } = await import('../hosting/sites.service');
  const { siteEnvService } = await import('../hosting/siteEnv.service');
  const { runtimeService } = await import('./runtime.service');
  const { loadSiteContext, runtimeConfigInput } = await import('./siteOps');
  const { buildRuntimeConfigs } = await import('./runtimeConfig');
  const { setEngineFactoryForTests } = await import('./engine');
  const { FakeDocker } = await import('./testing/fakeDocker');
  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // ── migration 045 ──
  const cols = await db('information_schema.columns').where({ table_name: 'sites', column_name: 'lscache_enabled' }).first('data_type', 'column_default', 'is_nullable');
  assert.equal(cols?.data_type, 'boolean');
  assert.equal(cols?.is_nullable, 'NO');

  const suffix = Date.now().toString(36);
  const [ta] = await db('tenants').insert({ name: `L ${suffix}`, slug: `l-${suffix}` }).returning('id');
  const tA = Number(ta.id ?? ta);
  const [u] = await db('users').insert({ username: `lc-${suffix}`, kind: 'client', role: 'user', is_active: true }).returning('id');
  const [r] = await db('users').insert({ username: `lr-${suffix}`, kind: 'client', role: 'user', is_active: true }).returning('id');
  const owner = Number(u.id ?? u);
  const reader = Number(r.id ?? r);
  const node = (await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined;
  const nodeId = node?.id ?? Number((await db('nodes').insert({ name: `n-${suffix}`, is_local: true }).returning('id'))[0].id);
  const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify({}) }).returning('id');
  const [acct] = await db('hosting_accounts').insert({
    tenant_id: tA, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: `l${suffix}`.slice(0, 30), uid: 52000 + (Date.now() % 1000), gid: 52000 + (Date.now() % 1000), status: 'active', filesrv_mode: 'off',
  }).returning('id');
  const accountId = Number(acct.id ?? acct);
  const site = async (slug: string, base: string) => {
    const [s] = await db('sites').insert({
      tenant_id: tA, account_id: accountId, name: slug, slug, base, docroot: '', base_path: '/', publish_mode: 'manual',
      publish_debounce_sec: 30, healthcheck_path: '/', status: 'active', php_settings: JSON.stringify({}),
    }).returning('id');
    return Number(s.id ?? s);
  };
  const lsId = await site('fast', 'litespeed-php8.3');
  const apId = await site('classic', 'apache-php8.3');
  await db('account_users').insert([
    { user_id: owner, account_id: accountId, capabilities: JSON.stringify(['sites.manage']) },
    { user_id: reader, account_id: accountId, capabilities: JSON.stringify([]) },
  ]);
  const req = { headers: {}, session: { userId: owner }, socket: { remoteAddress: '203.0.113.9' } } as never;
  const actor = await actorForUser(owner, tA);

  // ── the setting: default on, sites.manage to change it, rendered into the litespeed config only ──
  assert.equal((await db('sites').where({ id: lsId }).first('lscache_enabled')).lscache_enabled, true);
  assert.equal((await sitesService.get(actor, lsId)).lscacheEnabled, true);
  await assert.rejects(sitesService.update(req, await actorForUser(reader, tA), lsId, { lscacheEnabled: false }), (e: { statusCode: number }) => e.statusCode === 403);
  const updated = await sitesService.update(req, actor, lsId, { lscacheEnabled: false });
  assert.equal(updated.lscacheEnabled, false);
  const audit = await db('audit_logs').where({ action: 'site.update', tenant_id: tA }).orderBy('id', 'desc').first('details');
  assert.ok(JSON.stringify(audit?.details).includes('lscache_enabled'));
  const lsCtx = (await loadSiteContext(lsId))!;
  assert.deepEqual(buildRuntimeConfigs(runtimeConfigInput(lsCtx))[0].config.lscache, { enabled: false });
  await sitesService.update(req, actor, apId, { lscacheEnabled: false });
  const apCfg = buildRuntimeConfigs(runtimeConfigInput((await loadSiteContext(apId))!))[0].config;
  assert.equal('lscache' in apCfg, false, 'an Apache site keeps its exact config');

  // ── purge: 409 without a page cache; exec on the running litespeed container only ──
  const docker = new FakeDocker();
  setEngineFactoryForTests(() => docker.asDocker(), nodeId);
  await assert.rejects(runtimeService.purgeCache(apId), (e: { statusCode: number; code: string }) => e.statusCode === 409 && e.code === 'noPageCache');
  const name = `oblimint-site-${lsId}`;
  // Not running: nothing to purge (the next start has an empty cache anyway).
  const fake = docker.addContainer({ name, labels: { 'oblimint.site': String(lsId) }, state: 'exited' });
  assert.deepEqual(await runtimeService.purgeCache(lsId), { purged: 0 });
  fake.state = 'running';
  docker.execResults.set(name, { exitCode: 0, stdout: 'purged lscache\n' });
  assert.deepEqual(await runtimeService.purgeCache(lsId), { purged: 1 });
  assert.deepEqual(docker.calls.filter((c) => c.startsWith('exec ')), [`exec ${name} oblimint-reload --cache-only`]);
  docker.execResults.set(name, { exitCode: 1, stderr: 'boom' });
  await assert.rejects(runtimeService.purgeCache(lsId), (e: { statusCode: number }) => e.statusCode === 502);

  // ── .htaccess access rules of the live release (litespeed: enforced; Apache site: reported, not applied) ──
  const { localPaths } = await import('../hosting/paths');
  const relDir = localPaths.release(accountId, lsId, 1);
  fs.mkdirSync(path.join(relDir, 'private'), { recursive: true });
  fs.mkdirSync(path.join(relDir, 'admin'), { recursive: true });
  fs.writeFileSync(path.join(relDir, '.htaccess'), 'RewriteEngine On\n<Files xmlrpc.php>\nDeny from all\n</Files>\n');
  fs.writeFileSync(path.join(relDir, 'private', '.htaccess'), 'Require all denied\n');
  fs.writeFileSync(path.join(relDir, 'admin', '.htaccess'), 'AuthType Basic\nRequire valid-user\n');
  const [rel] = await db('releases').insert({ site_id: lsId, number: 1, status: 'ready', trigger: 'manual', commit_sha: 'a'.repeat(40), on_disk: true }).returning('id');
  await db('sites').where({ id: lsId }).update({ current_release_id: Number(rel.id ?? rel) });
  const report = await runtimeService.htaccessAccess(lsId);
  assert.equal(report.applies, true);
  assert.equal(report.releaseNumber, 1);
  assert.deepEqual(report.rules.map((r) => [r.dir, r.files?.pattern ?? null, r.action]), [['', 'xmlrpc.php', 'deny'], ['admin', null, 'closed'], ['private', null, 'deny']]);
  const apReport = await runtimeService.htaccessAccess(apId);
  assert.deepEqual([apReport.applies, apReport.releaseNumber, apReport.rules], [false, null, []]);

  // ── lsphp settings are never a site variable ──
  for (const name of ['LSPHP_ENABLE_USER_INI', 'LSAPI_CHILDREN', 'PHP_LSAPI_CHILDREN', 'LSWS_HOME']) {
    await assert.rejects(siteEnvService.replace(req, actor, lsId, [{ name, value: '1' }]), (e: { code: string }) => e.code === 'envNameReserved', name);
  }

  // ── stored for any base (a base switch keeps it) ──
  const view = await db('sites').where({ id: lsId }).first('base', 'lscache_enabled');
  assert.deepEqual(view, { base: 'litespeed-php8.3', lscache_enabled: false });
});
