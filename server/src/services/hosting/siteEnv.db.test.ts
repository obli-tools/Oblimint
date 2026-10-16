import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

// Site environment variables on a real PostgreSQL (SITEENV_TEST_DATABASE_URL,
// default the harness on 55490; skipped when nothing listens): sealed at rest,
// secrets write-only, validation, reconcile planner input (docker Env).

const DB_URL = process.env.SITEENV_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55490/postgres';

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

test('site environment variables', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) { t.skip(`no PostgreSQL at ${DB_URL}`); return; }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-env-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'env-test-secret-0123456789abcdef';
  const { db } = await import('../../db');
  const { actorForUser } = await import('./access');
  const { siteEnvService, siteEnvFor } = await import('./siteEnv.service');
  const { siteContainerSpec } = await import('../docker/specs');
  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  const suffix = Date.now().toString(36);
  const [ta] = await db('tenants').insert({ name: `E ${suffix}`, slug: `e-${suffix}` }).returning('id');
  const tA = Number(ta.id ?? ta);
  const [u] = await db('users').insert({ username: `c-${suffix}`, kind: 'client', role: 'user', is_active: true }).returning('id');
  const [r] = await db('users').insert({ username: `r-${suffix}`, kind: 'client', role: 'user', is_active: true }).returning('id');
  const owner = Number(u.id ?? u);
  const reader = Number(r.id ?? r);
  const node = (await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined;
  const nodeId = node?.id ?? Number((await db('nodes').insert({ name: `n-${suffix}`, is_local: true }).returning('id'))[0].id);
  const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify({}) }).returning('id');
  const [acct] = await db('hosting_accounts').insert({
    tenant_id: tA, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: `e${suffix}`.slice(0, 30), uid: 21000, gid: 21000, status: 'active', filesrv_mode: 'off',
  }).returning('id');
  const accountId = Number(acct.id ?? acct);
  const [s] = await db('sites').insert({
    tenant_id: tA, account_id: accountId, name: 'app', slug: 'app', base: 'apache-php8.3', docroot: '', base_path: '/', publish_mode: 'manual',
    publish_debounce_sec: 30, healthcheck_path: '/', status: 'active', php_settings: JSON.stringify({}),
  }).returning('id');
  const siteId = Number(s.id ?? s);
  await db('account_users').insert([
    { user_id: owner, account_id: accountId, capabilities: JSON.stringify(['sites.manage']) },
    { user_id: reader, account_id: accountId, capabilities: JSON.stringify([]) },
  ]);
  const req = { headers: {}, session: { userId: owner }, socket: { remoteAddress: '203.0.113.9' } } as never;
  const actor = await actorForUser(owner, tA);

  await assert.rejects(siteEnvService.list(await actorForUser(reader, tA), siteId), (e: { statusCode: number }) => e.statusCode === 403);
  await assert.rejects(siteEnvService.replace(req, actor, siteId, [{ name: 'PHP_INI_SCAN_DIR', value: '/tmp' }]), (e: { code: string }) => e.code === 'envNameReserved');
  await assert.rejects(siteEnvService.replace(req, actor, siteId, [{ name: '1BAD', value: 'x' }]), (e: { code: string }) => e.code === 'envNameInvalid');
  await assert.rejects(siteEnvService.replace(req, actor, siteId, [{ name: 'NEW_SECRET', secret: true }]), (e: { code: string }) => e.code === 'envValueRequired');

  const first = await siteEnvService.replace(req, actor, siteId, [
    { name: 'APP_ENV', value: 'production' },
    { name: 'TWITCH_SECRET', value: 'abc"; rm -rf / #=', secret: true },
  ]);
  assert.equal(first.changed, true);
  assert.deepEqual(first.vars.map((v) => [v.name, v.value, v.secret]), [['APP_ENV', 'production', false], ['TWITCH_SECRET', null, true]], 'secret never sent back');
  const stored = await db('site_env_vars').where({ site_id: siteId, name: 'TWITCH_SECRET' }).first('value_sealed');
  assert.ok(!String(stored.value_sealed).includes('abc'), 'sealed at rest');

  // Secret left empty: kept. Same set: nothing changed.
  const again = await siteEnvService.replace(req, actor, siteId, [{ name: 'APP_ENV', value: 'production' }, { name: 'TWITCH_SECRET', secret: true }]);
  assert.equal(again.changed, false);
  const env = (await siteEnvFor([siteId])).get(siteId);
  assert.deepEqual(env, [['APP_ENV', 'production'], ['TWITCH_SECRET', 'abc"; rm -rf / #=']]);

  // Docker Env of the site container: the variables follow the config path, values verbatim.
  const spec = siteContainerSpec({
    siteId, accountId, uid: 21000, gid: 21000, slug: 'app', role: 'primary', runtimeId: null, base: 'apache-php8.3', limits: {} as never,
    releasesDir: '/r', dataDir: '/d', runtimeConfigFile: '/c/primary.json', env,
  });
  assert.deepEqual(spec.Env?.slice(1), ['APP_ENV=production', 'TWITCH_SECRET=abc"; rm -rf / #=']);

  // Removing a variable.
  const removed = await siteEnvService.replace(req, actor, siteId, [{ name: 'TWITCH_SECRET', secret: true }]);
  assert.deepEqual(removed.vars.map((v) => v.name), ['TWITCH_SECRET']);
  const audit = await db('audit_logs').where({ action: 'site.env.update', tenant_id: tA }).count('* as c').first();
  assert.equal(Number(audit?.c), 2);
});
