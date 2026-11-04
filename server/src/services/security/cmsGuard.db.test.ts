import { test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { Request } from 'express';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of the CMS login guard (audit item 15) on PostgreSQL:
// CMS_GUARD_TEST_DATABASE_URL (default port 55433). Skipped cleanly when
// nothing listens. hostd / Docker / Obliguard / the edge = fakes
// (setWebBanBackendsForTests), GeoIP off. Covers: migration 039 (source,
// web_bans.site_id, sites.cms_guard_*), the edge log → account ban path with
// the real site settings and the real panel sessions, the escalation ladder
// shared with the honeypot, the exclusions (never-ban, node, private, open
// sessions of an admin / of a client user of the account), the per-site
// switch and thresholds (rights: relaxing takes proxy.manage), the list API
// (siteId / siteName, source filter), the stats, the promotion on three
// independent owners.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.CMS_GUARD_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55433/postgres';

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

async function rejectsWith(p: Promise<unknown>, status: number, code?: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    const e = err as { statusCode?: number; code?: string; message?: string };
    assert.equal(e.statusCode, status, `expected HTTP ${status}, got ${e.statusCode} (${e.message})`);
    if (code !== undefined) assert.equal(e.code, code);
    return;
  }
  assert.fail(`expected a ${status} rejection`);
}

test('CMS login guard on PostgreSQL', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-cmsguard-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'cmsguard-test-secret-0123456789abcdef';

  const { db } = await import('../../db');
  const { platformSettings } = await import('../platformSettings');
  const { MASTER_TENANT_ID } = await import('@oblimint/shared');
  const svc = await import('./bans.service');
  const { cmsGuard } = await import('./cmsGuard.service');
  const { ObliguardClient } = await import('./obliguard');
  const { setGeoBackendsForTests } = await import('./geoip.service');
  const { actorForUser } = await import('../hosting/access');
  const { sitesService } = await import('../hosting/sites.service');
  const { reconcileService } = await import('../docker/reconcile.service');
  const { edgeService } = await import('../edge/edge.service');
  type EdgeLogEntry = import('../usage/edgeLog').EdgeLogEntry;

  mock.method(reconcileService, 'requestAccount', () => {});
  mock.method(reconcileService, 'requestSite', () => {});
  mock.method(edgeService, 'scheduleSync', () => {});

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // 039: the CHECK accepts the new source, the columns exist with their defaults.
  const check = await db.raw(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'web_bans_source_check'`);
  assert.match(check.rows[0].def, /cms-bruteforce/);
  assert.match(check.rows[0].def, /key-bruteforce/, 'the sources of 029 are kept');

  await db('web_bans').delete();
  await db('web_ban_offenses').delete();
  await platformSettings.update({
    bans: { enabled: true, geoipProvider: 'off', obliguardEnabled: false, neverBan: ['198.51.100.0/24'], cmsGuardMode: 'on', cmsGuardMaxFailures: 4, cmsGuardWindowMinutes: 5 },
  });
  setGeoBackendsForTests({ fetch: async () => { throw new Error('no network in tests'); } });

  let clock = new Date('2026-11-04T10:00:00Z');
  svc.setWebBanBackendsForTests({
    now: () => clock,
    setWebFirewall: async () => {},
    dockerSubnets: async () => ['172.17.0.0/16'],
    nodeAddresses: async () => ['203.0.113.250'],
    scheduleEdgeSync: () => {},
    obliguard: new ObliguardClient(async () => ({ manualUrl: null, obligate: null, connectedApps: async () => [] }), async () => new Response(null, { status: 503 })),
  });
  // Real settings, sites, sessions and bans; only the clock is faked.
  cmsGuard.setDepsForTests({ now: () => clock.getTime() });
  t.after(() => { cmsGuard.setDepsForTests(null); svc.webBanService.stop(); svc.setWebBanBackendsForTests(null); setGeoBackendsForTests(null); });

  // ── fixtures ───────────────────────────────────────────────────────────────
  const suffix = Date.now().toString(36);
  const idOf = (r: unknown) => Number((r as { id?: number }).id ?? r);
  const mkTenant = async (n: string) => idOf((await db('tenants').insert({ name: `${n} ${suffix}`, slug: `${n}-${suffix}` }).returning('id'))[0]);
  const tA = await mkTenant('a');
  const tB = await mkTenant('b');
  const tC = await mkTenant('c');
  const user = async (name: string, kind: 'staff' | 'client', role: 'admin' | 'user', tenantId: number) => {
    const id = idOf((await db('users').insert({ username: `${name}-${suffix}`, kind, role, is_active: true }).returning('id'))[0]);
    if (kind === 'staff') await db('user_tenants').insert({ user_id: id, tenant_id: tenantId, role: 'admin' });
    return id;
  };
  const platformAdmin = await user('pa', 'staff', 'admin', MASTER_TENANT_ID);
  const owner = await user('owner', 'client', 'user', tA);
  const siteManager = await user('sm', 'client', 'user', tA);
  const outsider = await user('out', 'client', 'user', tB);
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number };
  const mkAccount = async (tenantId: number, name: string) => {
    const plan = idOf((await db('plans').insert({ tenant_id: tenantId, name: `p-${name}-${suffix}`, limits: JSON.stringify({}) }).returning('id'))[0]);
    const uid = 20000 + Math.floor(Math.random() * 30000);
    return idOf((await db('hosting_accounts').insert({
      tenant_id: tenantId, node_id: localNode.id, plan_id: plan, username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
    }).returning('id'))[0]);
  };
  const acme = await mkAccount(tA, 'acme');
  const bee = await mkAccount(tB, 'bee');
  const cee = await mkAccount(tC, 'cee');
  const mkSite = async (tenantId: number, accountId: number, slug: string) => idOf((await db('sites').insert({
    tenant_id: tenantId, account_id: accountId, name: slug, slug, base: 'nginx-static', docroot: '', base_path: '/', publish_mode: 'manual',
    publish_debounce_sec: 30, healthcheck_path: '/', status: 'active', php_settings: JSON.stringify({}),
  }).returning('id'))[0]);
  const shop = await mkSite(tA, acme, 'shop');
  const blog = await mkSite(tA, acme, 'blog');
  const beeSite = await mkSite(tB, bee, 'bees');
  const ceeSite = await mkSite(tC, cee, 'cees');
  await db('account_users').insert([
    { user_id: owner, account_id: acme, capabilities: JSON.stringify(['sites.manage', 'proxy.manage']) },
    { user_id: siteManager, account_id: acme, capabilities: JSON.stringify(['sites.manage']) },
    { user_id: outsider, account_id: bee, capabilities: JSON.stringify(['sites.manage']) },
  ]);
  const def = await db('sites').where({ id: shop }).first('cms_guard_enabled', 'cms_guard_max_failures', 'cms_guard_window_minutes');
  assert.deepEqual(def, { cms_guard_enabled: true, cms_guard_max_failures: null, cms_guard_window_minutes: null });

  const session = async (userId: number, ip: string) => {
    await db('session').insert({ sid: `s-${userId}-${ip}-${suffix}`, sess: JSON.stringify({ userId, ip, cookie: {} }), expire: new Date(Date.now() + 3_600_000) });
  };

  const entry = (siteId: number, ip: string, over: Partial<EdgeLogEntry> = {}): EdgeLogEntry => ({
    time: clock.toISOString(), host: 'shop.example.com', remoteAddr: ip, method: 'POST', uri: '/wp-login.php', status: 200, bytes: 0, bytesOut: 0,
    bytesIn: 0, requestTime: 0, upstream: null, upstreamStatus: null, userAgent: 'bot', referer: null, siteId, accountId: null, tenantId: null, kind: 'site', ...over,
  });
  const feed = async (n: number, siteId: number, ip: string, over: Partial<EdgeLogEntry> = {}) => {
    for (let i = 0; i < n; i++) cmsGuard.onEdgeLogEntry(entry(siteId, ip, over));
    await cmsGuard.idle();
  };
  const active = (ip: string, accountId: number | null) => db('web_bans').where({ ip, is_active: true })
    .andWhere((q) => (accountId === null ? q.whereNull('account_id') : q.where('account_id', accountId))).first();
  const count = async () => Number((await db('web_bans').count<{ n: string }[]>({ n: '*' }))[0].n);

  // ── edge log → account ban ─────────────────────────────────────────────────
  await feed(3, shop, '203.0.113.9');
  assert.equal(await count(), 0, '3 < 4');
  await feed(1, shop, '203.0.113.9');
  let row = await active('203.0.113.9', acme);
  assert.ok(row, 'account ban created');
  assert.equal(row.scope, 'account');
  assert.equal(row.source, 'cms-bruteforce');
  assert.equal(Number(row.site_id), shop);
  assert.equal(Number(row.tenant_id), tA);
  assert.equal(row.hit_count, 4);
  assert.equal(row.offense_level, 1);
  assert.equal(row.proxy_host_id, null);
  assert.equal(row.obliguard_status, 'disabled', 'an account ban never goes to Obliguard');
  assert.equal(row.reason, '4 échecs de connexion WordPress en 5 min sur shop.example.com/wp-login.php');
  assert.equal(new Date(row.banned_until).getTime() - clock.getTime(), 60 * 60_000, 'first step of the ladder');
  const audit = await db('audit_logs').where({ action: 'bans.cmsBruteforce' }).orderBy('id', 'desc').first('tenant_id', 'details');
  assert.equal(Number(audit.tenant_id), tA);
  const [unit] = await svc.webBanWorkerForTests.provider.units();
  assert.match(unit.config, new RegExp(`203\\.0\\.113\\.9 "\\|${acme}\\|";`), 'enforced on the hosts of the account (g-bans)');

  // Repeat on the active ban (another site of the account): hit_count, same level.
  await feed(4, blog, '203.0.113.9', { host: 'blog.example.com', uri: '/xmlrpc.php' });
  row = await active('203.0.113.9', acme);
  assert.equal(row.hit_count, 8);
  assert.equal(row.offense_level, 1);

  // Escalation: after expiry the next burst is level 2 (1440 min).
  clock = new Date(clock.getTime() + 61 * 60_000);
  assert.equal(await svc.webBanWorkerForTests.expireNow(), 1);
  await feed(4, shop, '203.0.113.9', { uri: '/user/login' });
  row = await active('203.0.113.9', acme);
  assert.equal(row.offense_level, 2);
  assert.equal(new Date(row.banned_until).getTime() - clock.getTime(), 1440 * 60_000);
  assert.match(row.reason, /Drupal/);

  // IPv6 by /64.
  await feed(2, shop, '2001:db8:aa:1::1');
  await feed(2, shop, '2001:db8:aa:1::2');
  assert.ok(await active('2001:db8:aa:1::/64', acme), 'IPv6 banned by /64');

  // ── exclusions ─────────────────────────────────────────────────────────────
  const before = await count();
  for (const ip of ['198.51.100.7', '203.0.113.250', '10.0.0.5', '172.17.0.9', 'fd00::1', 'garbage']) await feed(4, shop, ip);
  assert.equal(await count(), before, 'never-ban, node, private, Docker, garbage: never banned');
  // Open panel sessions: a platform admin anywhere, a client user of the account.
  await session(platformAdmin, '203.0.113.60');
  await session(siteManager, '2001:db8:bb:2::9');
  await session(outsider, '203.0.113.62');
  clock = new Date(clock.getTime() + 16_000); // the guard caches the session addresses 15 s
  await feed(4, shop, '203.0.113.60');
  await feed(4, shop, '2001:db8:bb:2::77');
  assert.equal(await count(), before, 'admin session / client user of the account (by /64): never banned');
  await feed(4, shop, '203.0.113.62');
  assert.ok(await active('203.0.113.62', acme), 'a client of another account is not exempt');

  // ── per-site settings and rights ───────────────────────────────────────────
  const fakeReq = (userId: number, tenantId: number) => ({
    session: { userId }, sessionID: `sid-${userId}`, tenantId, headers: {}, socket: { remoteAddress: '127.0.0.1' }, query: {}, params: {}, body: {}, method: 'PUT', path: '/api/sites',
  }) as unknown as Request;
  const asManager = fakeReq(siteManager, tA);
  const managerActor = await actorForUser(siteManager, tA);
  const ownerActor = await actorForUser(owner, tA);
  // Tightening needs sites.manage only.
  let site = await sitesService.update(asManager, managerActor, shop, { cmsGuard: { maxFailures: 3 } });
  assert.deepEqual(site.cmsGuard, { enabled: true, maxFailures: 3, windowMinutes: null });
  // Relaxing (off, more failures, shorter window) also needs proxy.manage.
  await rejectsWith(sitesService.update(asManager, managerActor, shop, { cmsGuard: { enabled: false } }), 403, 'cmsGuardRelaxForbidden');
  await rejectsWith(sitesService.update(asManager, managerActor, shop, { cmsGuard: { maxFailures: 50 } }), 403, 'cmsGuardRelaxForbidden');
  await rejectsWith(sitesService.update(asManager, managerActor, shop, { cmsGuard: { windowMinutes: 1 } }), 403, 'cmsGuardRelaxForbidden');
  site = await sitesService.update(asManager, managerActor, shop, { cmsGuard: { windowMinutes: 30 } });
  assert.equal(site.cmsGuard.windowMinutes, 30, 'a longer window is stricter');
  // The guard reads the new threshold at once (siteChanged).
  await new Promise((r) => setTimeout(r, 50));
  await feed(3, shop, '203.0.113.70');
  assert.ok(await active('203.0.113.70', acme), 'site threshold 3 applied');
  // The owner (proxy.manage) switches it off: nothing counted any more.
  site = await sitesService.update(fakeReq(owner, tA), ownerActor, shop, { cmsGuard: { enabled: false } });
  assert.equal(site.cmsGuard.enabled, false);
  await new Promise((r) => setTimeout(r, 50));
  await feed(10, shop, '203.0.113.71');
  assert.equal(await active('203.0.113.71', acme), undefined, 'site switched off');
  const auditUpd = await db('audit_logs').where({ action: 'site.update' }).orderBy('id', 'desc').first('details');
  const det = typeof auditUpd.details === 'string' ? JSON.parse(auditUpd.details) : auditUpd.details;
  assert.deepEqual(det.fields, ['cms_guard_enabled']);
  // Out of range: refused by the CHECK even if a caller skipped the validator.
  await assert.rejects(db('sites').where({ id: blog }).update({ cms_guard_max_failures: 1 }));

  // ── platform mode log: journal only ────────────────────────────────────────
  await platformSettings.update({ bans: { cmsGuardMode: 'log' } });
  await feed(4, blog, '203.0.113.80', { host: 'blog.example.com' });
  assert.equal(await active('203.0.113.80', acme), undefined, 'log: no ban');
  const would = await db('audit_logs').where({ action: 'cmsGuard.wouldBan' }).orderBy('id', 'desc').first('tenant_id', 'resource_path', 'details');
  assert.equal(Number(would.tenant_id), tA);
  assert.equal(would.resource_path, `/sites/${blog}`);
  await platformSettings.update({ bans: { cmsGuardMode: 'on' } });

  // ── list API: site shown, filter by source / site, stats ───────────────────
  const adminActor = await actorForUser(platformAdmin, MASTER_TENANT_ID);
  const list = await svc.webBanService.list(adminActor, { source: 'cms-bruteforce', limit: 50 });
  assert.ok(list.items.length >= 4);
  const first = list.items.find((b) => b.ip === '203.0.113.9')!;
  assert.equal(first.siteId, shop);
  assert.equal(first.siteName, 'shop');
  assert.equal(first.source, 'cms-bruteforce');
  const bySite = await svc.webBanService.list(adminActor, { siteId: shop, limit: 50 });
  assert.ok(bySite.items.every((b) => b.siteId === shop));
  const asClient = await svc.webBanService.list(ownerActor, { limit: 50 });
  assert.ok(asClient.items.some((b) => b.siteName === 'shop'), 'the client sees its account bans with the site');
  const stats = await svc.webBanService.stats(adminActor, {});
  assert.ok(stats.bySource['cms-bruteforce'] >= 4);

  // ── promotion: the same address on 3 accounts of 3 independent owners ─────
  await feed(4, beeSite, '203.0.113.90', { host: 'bees.example.com' });
  await feed(4, ceeSite, '203.0.113.90', { host: 'cees.example.com' });
  assert.equal(await active('203.0.113.90', null), undefined, '2 accounts: no promotion');
  await feed(4, blog, '203.0.113.90', { host: 'blog.example.com' });
  const promoted = await active('203.0.113.90', null);
  assert.ok(promoted, '3 owners: platform ban');
  assert.equal(promoted.source, 'promotion');

});
