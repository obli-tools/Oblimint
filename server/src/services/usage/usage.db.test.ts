import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';
import type { Request } from 'express';

// ─────────────────────────────────────────────────────────────────────────────
// Usage module on PostgreSQL (PGlite):
//   PG_PORT=55445 node <scratchpad>/pg/pgserver.mjs
// USAGE_TEST_DATABASE_URL overrides the URL; skipped cleanly when nothing
// listens. Docker / hostd / reconcile / edge are never touched (enforcement
// side effects and the database usage source are fakes); webhooks go to a
// local HTTP server through injected resolver deps.
//   - traffic upsert (additive, status codes merged, tenant from the account);
//   - queries scoped per actor (client: its accounts; staff: its tenant;
//     platform: admin only);
//   - alerts: one per (scope, dimension, period, level), cleared / reopened;
//   - enforcement: block-uploads, suspend once per period, staff
//     unsuspension respected, monthly reset;
//   - notification channels: CRUD isolation (id AND tenant_id), secrets
//     sealed and masked, SSRF refusal, test, notify fan-out / dedup / retries;
//   - dashboard: database instances counted per actor.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.USAGE_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55445/postgres';

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

function fakeReq(userId: number, tenantId: number): Request {
  return {
    session: { userId }, sessionID: `sid-${userId}-${Math.random()}`, tenantId, headers: {}, socket: { remoteAddress: '127.0.0.1' },
    query: {}, params: {}, body: {}, method: 'GET', path: '/api/usage',
  } as unknown as Request;
}

async function rejectsWith(p: Promise<unknown>, status: number, code?: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    const e = err as { statusCode?: number; code?: string; message?: string };
    assert.equal(e.statusCode, status, `expected HTTP ${status}, got ${e.statusCode} (${e.message})`);
    if (code !== undefined) assert.equal(e.code, code, `expected code ${code}, got ${e.code} (${e.message})`);
    return;
  }
  assert.fail(`expected a ${status}${code ? ` ${code}` : ''} rejection`);
}

test('usage module on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55445)`);
    return;
  }
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.SESSION_SECRET ||= 'usage-test-secret-0123456789abcdef';

  const { db } = await import('../../db');
  const { resolveActor } = await import('../hosting/access');
  const { flushTraffic } = await import('./traffic');
  const { usageQueryService, enforcementService } = await import('./usage.service');
  const enforcement = await import('./enforcement');
  const notif = await import('./notifications.service');
  const { resolvePublicHttpsTarget } = await import('./notifications/ssrf');
  const { dashboardService } = await import('../dashboard.service');
  const { recordDailyDisk } = await import('../hosting/usage.service');
  const { monthOf, dayOf } = await import('./gauges');
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');

  // ── local webhook receiver ──
  const hits: Array<{ url: string; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }> = [];
  let failNext = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (failNext > 0) { failNext--; res.writeHead(503); res.end(); return; }
      hits.push({ url: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'), headers: req.headers });
      res.writeHead(200); res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const PUBLIC_DNS = async (host: string) => {
    if (host === 'internal-hooks.example.com') return [{ address: '10.0.0.8', family: 4 }];
    return [{ address: '93.184.216.34', family: 4 }];
  };
  notif.setNotificationDepsForTests({
    // Write-time and send-time checks use the real guard on a fake DNS, then connect to the local receiver.
    resolveTarget: async (url) => {
      const pinned = await resolvePublicHttpsTarget(url, PUBLIC_DNS);
      const u = new URL(pinned.url.toString());
      u.protocol = 'http:';
      u.port = String(port);
      return { url: u, address: '127.0.0.1', family: 4 };
    },
    lookup: PUBLIC_DNS,
    retryDelaysMs: [5, 5],
    timeoutMs: 2000,
  });

  const statusEvents: Array<[number, boolean]> = [];
  const sessionDrops: number[] = [];
  enforcement.setEnforcementEffectsForTests({
    async statusChanged(id, suspended) { statusEvents.push([id, suspended]); },
    async uploadsBlocked(id) { sessionDrops.push(id); },
  });
  const dbUsage = new Map<number, { instances: number; databases: number; sizeBytes: number | null }>();
  enforcement.setDbUsageSourceForTests(async (id) => dbUsage.get(id) ?? { instances: 0, databases: 0, sizeBytes: 0 });

  try {
    await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
    await db.raw('CREATE SCHEMA public');
    await db.migrate.latest();

    const MIB = 1048576;
    const [tA] = await db('tenants').insert({ name: 'Reseller A', slug: 'reseller-a', limits: JSON.stringify({ diskMb: 1, trafficMbPerMonth: null }) }).returning('id');
    const [tB] = await db('tenants').insert({ name: 'Reseller B', slug: 'reseller-b' }).returning('id');
    const tenantA = Number(tA.id ?? tA);
    const tenantB = Number(tB.id ?? tB);
    const mkUser = async (username: string, role: 'admin' | 'user', kind: 'staff' | 'client' = 'staff') =>
      Number((await db('users').insert({ username, role, kind, is_active: true, password_hash: 'x' }).returning('id'))[0].id);
    const admin = await mkUser('platform-admin', 'admin');
    const staffA = await mkUser('staff-a', 'user');
    const viewerA = await mkUser('viewer-a', 'user');
    const staffB = await mkUser('staff-b', 'user');
    const alice = await mkUser('alice', 'user', 'client');
    await db('user_tenants').insert([
      { user_id: admin, tenant_id: 1, role: 'admin' },
      { user_id: staffA, tenant_id: tenantA, role: 'admin' },
      { user_id: viewerA, tenant_id: tenantA, role: 'viewer' },
      { user_id: staffB, tenant_id: tenantB, role: 'admin' },
    ]);
    await db('app_config').insert({ key: 'panel_hostname', value: 'panel.example.com' }).onConflict('key').merge();
    const node = Number((await db('nodes').first('id')).id);
    const mkPlan = async (tenantId: number, name: string, limits: Record<string, unknown>) =>
      Number((await db('plans').insert({ tenant_id: tenantId, name, limits: JSON.stringify({ ...DEFAULT_PLAN_LIMITS, ...limits }) }).returning('id'))[0].id);
    const planBlock = await mkPlan(tenantA, 'Block', { diskMb: 100, trafficMbPerMonth: 1, overQuotaAction: 'block-uploads', maxDatabases: 2, dbMaxSizeMb: 10 });
    const planSuspend = await mkPlan(tenantA, 'Suspend', { diskMb: 100, trafficMbPerMonth: 1, overQuotaAction: 'suspend' });
    const planB = await mkPlan(tenantB, 'B', { diskMb: 100, trafficMbPerMonth: null });
    let uid = 20000;
    const mkAccount = async (tenantId: number, planId: number, username: string, extra: Record<string, unknown> = {}) => {
      uid++;
      return Number((await db('hosting_accounts').insert({
        tenant_id: tenantId, node_id: node, plan_id: planId, username, status: 'active', uid, gid: uid, ...extra,
      }).returning('id'))[0].id);
    };
    const shop = await mkAccount(tenantA, planBlock, 'shop', { disk_used_bytes: 10 * MIB });
    const blog = await mkAccount(tenantA, planSuspend, 'blog');
    const other = await mkAccount(tenantB, planB, 'other');
    await db('account_users').insert({ user_id: alice, account_id: shop, capabilities: JSON.stringify(['sites.manage']) });
    const mkSite = async (accountId: number, tenantId: number, slug: string) =>
      Number((await db('sites').insert({ tenant_id: tenantId, account_id: accountId, name: slug.toUpperCase(), slug, base: 'nginx-static' }).returning('id'))[0].id);
    const shopSite = await mkSite(shop, tenantA, 'shop');
    const blogSite = await mkSite(blog, tenantA, 'blog');

    const actor = async (userId: number, tenantId: number) => resolveActor(fakeReq(userId, tenantId));
    const asAdmin = await actor(admin, 1);
    const asStaffA = await actor(staffA, tenantA);
    const asViewerA = await actor(viewerA, tenantA);
    const asStaffB = await actor(staffB, tenantB);
    const asAlice = await actor(alice, tenantA);
    const today = dayOf();
    const month = monthOf();

    await t.test('traffic: additive upsert, status codes merged, tenant from the account, unknown accounts dropped', async () => {
      const b = (o: Record<string, unknown>) => ({ day: today, accountId: shop, siteId: shopSite, tenantId: 999, requests: 2, bytesOut: 300 * 1024, bytesIn: 100, statusCodes: { 200: 2 }, ...o });
      assert.equal(await flushTraffic([b({}), b({ accountId: 999_999 })]), 1);
      await flushTraffic([b({ requests: 1, bytesOut: 100, statusCodes: { 200: 1, 404: 1 } }), b({ siteId: 0, requests: 1, bytesOut: 5, statusCodes: { 301: 1 } })]);
      const rows = await db('usage_traffic_daily').where({ account_id: shop }).orderBy('site_id');
      assert.equal(rows.length, 2);
      assert.equal(rows[0].site_id, 0);
      const r = rows[1];
      assert.equal(Number(r.tenant_id), tenantA);
      assert.equal(Number(r.requests), 3);
      assert.equal(Number(r.bytes_out), 300 * 1024 + 100);
      assert.equal(Number(r.bytes_in), 200);
      assert.deepEqual(r.status_codes, { 200: 3, 404: 1 });
    });

    await t.test('account / site usage: scoped per actor', async () => {
      const u = await usageQueryService.account(asAlice, shop, null);
      assert.equal(u.month, month);
      const day = u.traffic.find((p) => p.day === today)!;
      assert.equal(day.requests, 4);
      assert.equal(day.bytesOut, 300 * 1024 + 105);
      assert.deepEqual(u.sites.map((s) => [s.siteId, s.requests]), [[shopSite, 3], [0, 1]]);
      assert.equal(u.disk.usedBytes, 10 * MIB);
      assert.equal(u.disk.quotaBytes, 100 * MIB);
      assert.deepEqual(u.gauges.map((g) => [g.dimension, g.level]), [['disk', null], ['traffic', null], ['databases', null], ['dbSize', null]]);
      await rejectsWith(usageQueryService.account(asAlice, blog, null), 404);
      await rejectsWith(usageQueryService.account(asStaffB, shop, null), 404);
      await rejectsWith(usageQueryService.account(asStaffA, shop, '2026-13'), 400, 'validation');
      assert.equal((await usageQueryService.account(asAdmin, shop, null)).accountId, shop);
      const s = await usageQueryService.site(asAlice, shopSite, 7);
      assert.equal(s.traffic.length, 7);
      assert.deepEqual(s.statusCodes, { 200: 3, 404: 1 });
      await rejectsWith(usageQueryService.site(asAlice, blogSite, 7), 404);
      await rejectsWith(usageQueryService.site(asStaffB, shopSite, 7), 404);
    });

    await t.test('tenant / platform usage: staff and platform admin only', async () => {
      const tu = await usageQueryService.tenant(asStaffA, null, null);
      assert.equal(tu.tenantId, tenantA);
      assert.equal(tu.totals.accounts, 2);
      assert.equal(tu.totals.trafficBytes, 300 * 1024 + 105);
      assert.equal(tu.topAccounts[0].username, 'shop');
      assert.deepEqual(tu.envelope, { trafficMbPerMonth: null, diskMb: 1 });
      assert.equal(tu.gauges.find((g) => g.dimension === 'disk')!.level, 100, '10 MiB used of a 1 MiB envelope');
      // A tenant staff member cannot look at another tenant; god view can.
      assert.equal((await usageQueryService.tenant(asStaffB, tenantA, null)).tenantId, tenantB);
      assert.equal((await usageQueryService.tenant(asAdmin, tenantA, null)).tenantId, tenantA);
      await rejectsWith(usageQueryService.tenant(asAlice, null, null), 403);
      const p = await usageQueryService.platform(asAdmin, null);
      assert.equal(p.totals.tenants, 3);
      assert.equal(p.tenants[0].tenantId, tenantA);
      await rejectsWith(usageQueryService.platform(asStaffA, null), 403);
      await rejectsWith(usageQueryService.platform(asAlice, null), 403);
    });

    // ── notification channels ──
    let channelA = 0;
    await t.test('channels: create with a sealed, masked secret; validation; isolation', async () => {
      const created = await notif.notificationService.create(fakeReq(staffA, tenantA), asStaffA, {
        name: 'Ops hook', events: ['quota.warning', 'quota.exceeded', 'quota.action'],
        config: { type: 'webhook', url: 'https://hooks.example.com/oblimint', method: 'POST', headerName: 'X-Token', headerValue: 'top-secret' },
      });
      channelA = created.id;
      assert.equal(created.tenantId, tenantA);
      assert.equal((created.config as { headerValue?: unknown }).headerValue, null);
      assert.deepEqual(created.secretsSet, ['headerValue']);
      const raw = await db('notification_channels').where({ id: channelA }).first();
      assert.ok(String(raw.secrets).startsWith('v1:'));
      assert.ok(!JSON.stringify(raw).includes('top-secret'));
      // null keeps the secret
      const upd = await notif.notificationService.update(fakeReq(staffA, tenantA), asStaffA, channelA, {
        config: { type: 'webhook', url: 'https://hooks.example.com/oblimint2', method: 'POST', headerName: 'X-Token', headerValue: null },
      });
      assert.deepEqual(upd.secretsSet, ['headerValue']);
      const test1 = await notif.notificationService.test(fakeReq(staffA, tenantA), asStaffA, channelA);
      assert.deepEqual(test1, { ok: true, error: null });
      assert.equal(hits.at(-1)!.headers['x-token'], 'top-secret');
      assert.equal(hits.at(-1)!.url, '/oblimint2');

      await rejectsWith(notif.notificationService.create(fakeReq(staffA, tenantA), asStaffA, {
        name: 'ops HOOK', events: [], config: { type: 'discord', webhookUrl: 'https://discord.com/api/webhooks/1/x' },
      }), 409, 'channelNameTaken');
      await rejectsWith(notif.notificationService.create(fakeReq(staffA, tenantA), asStaffA, {
        name: 'Bad', events: ['nope' as never], config: { type: 'telegram', botToken: '1:x', chatId: '1' },
      }), 400, 'channelInvalid');
      await rejectsWith(notif.notificationService.create(fakeReq(staffA, tenantA), asStaffA, {
        name: 'Discord no url', events: [], config: { type: 'discord', webhookUrl: null },
      }), 400, 'channelInvalid');
      await rejectsWith(notif.notificationService.create(fakeReq(staffA, tenantA), asStaffA, {
        name: 'Fake discord', events: [], config: { type: 'discord', webhookUrl: 'https://evil.example.com/api/webhooks/1/x' },
      }), 400, 'channelInvalid');
      for (const url of ['https://internal-hooks.example.com/x', 'https://169.254.169.254/', 'http://hooks.example.com/', 'https://localhost/']) {
        await rejectsWith(notif.notificationService.create(fakeReq(staffA, tenantA), asStaffA, {
          name: `SSRF ${url}`, events: [], config: { type: 'webhook', url, method: 'POST' },
        }), 400, 'webhookForbidden');
      }
      await rejectsWith(notif.notificationService.create(fakeReq(staffA, tenantA), asStaffA, {
        name: 'Private relay', events: [], config: { type: 'smtp', host: '10.1.2.3', port: 25, secure: false, username: null, from: 'a@b.cd', to: ['x@y.zz'] },
      }), 400, 'webhookForbidden');

      // isolation: other tenant → 404, staff without 'settings' / client → 403
      await rejectsWith(notif.notificationService.update(fakeReq(staffB, tenantB), asStaffB, channelA, { name: 'x' }), 404);
      await rejectsWith(notif.notificationService.remove(fakeReq(staffB, tenantB), asStaffB, channelA), 404);
      await rejectsWith(notif.notificationService.test(fakeReq(staffB, tenantB), asStaffB, channelA), 404);
      assert.deepEqual(await notif.notificationService.list(asStaffB), []);
      await rejectsWith(notif.notificationService.list(asViewerA), 403);
      await rejectsWith(notif.notificationService.list(asAlice), 403);
      assert.deepEqual((await notif.notificationService.list(asStaffA)).map((c) => c.id), [channelA]);
      // The platform admin (god view) reaches it by id.
      assert.equal((await notif.notificationService.update(fakeReq(admin, 1), asAdmin, channelA, { enabled: true })).id, channelA);
      const audits = await db('audit_logs').where({ tenant_id: tenantA }).where('action', 'like', 'notification.channel.%').pluck('action');
      assert.ok(audits.includes('notification.channel.create') && audits.includes('notification.channel.update') && audits.includes('notification.channel.test'));
    });

    await t.test('notify: tenant + master channels, dedup, retries, last_error', async () => {
      const master = await notif.notificationService.create(fakeReq(admin, 1), asAdmin, {
        name: 'Platform', events: ['quota.exceeded'], config: { type: 'webhook', url: 'https://hooks.example.com/platform', method: 'POST' },
      });
      hits.length = 0;
      notif.notify('quota.exceeded', { tenantId: tenantA, key: 'k1', title: 'T', message: 'M', severity: 'critical', platform: true, link: '/usage' });
      notif.notify('quota.exceeded', { tenantId: tenantA, key: 'k1', title: 'T', message: 'M', severity: 'critical', platform: true });
      await notif.notificationQueueIdle();
      assert.deepEqual(hits.map((h) => h.url).sort(), ['/oblimint2', '/platform']);
      assert.equal(hits[0].body.url, 'https://panel.example.com/usage');
      // not subscribed: nothing
      hits.length = 0;
      notif.notify('dns.syncFailed', { tenantId: tenantA, key: 'k2', title: 'T', message: 'M', severity: 'warning' });
      // without platform: tenant channel only; 2 failures then success (3 attempts)
      failNext = 2;
      notif.notify('quota.warning', { tenantId: tenantA, key: 'k3', title: 'T', message: 'M', severity: 'warning' });
      await notif.notificationQueueIdle();
      assert.deepEqual(hits.map((h) => h.url), ['/oblimint2']);
      assert.equal((await db('notification_channels').where({ id: channelA }).first()).last_error, null);
      // 3 failures: last_error recorded
      failNext = 3;
      notif.notify('quota.warning', { tenantId: tenantA, key: 'k4', title: 'T', message: 'M', severity: 'warning' });
      await notif.notificationQueueIdle();
      assert.match(String((await db('notification_channels').where({ id: channelA }).first()).last_error), /HTTP 503/);
      // test of a failing channel
      failNext = 1;
      const res = await notif.notificationService.test(fakeReq(admin, 1), asAdmin, master.id);
      assert.equal(res.ok, false);
      assert.match(String(res.error), /HTTP 503/);
      await notif.notificationService.remove(fakeReq(admin, 1), asAdmin, master.id);
    });

    // ── alerts + enforcement ──
    await t.test('alerts: one per (scope, dimension, period, level), cleared and reopened', async () => {
      // shop: traffic 300 KiB of 1 MiB; push it to 85 %.
      await db('usage_traffic_daily').where({ account_id: shop, site_id: shopSite }).update({ bytes_out: Math.round(0.85 * MIB) - 105 });
      hits.length = 0;
      await enforcement.evaluateAccount(shop);
      await enforcement.evaluateAccount(shop);
      await notif.notificationQueueIdle();
      let alerts = await db('usage_alerts').where({ account_id: shop });
      assert.equal(alerts.length, 1);
      assert.deepEqual([alerts[0].dimension, alerts[0].level, alerts[0].period, alerts[0].scope], ['traffic', 80, month, 'account']);
      assert.equal(hits.length, 1, 'notified once');
      assert.equal(hits[0].body.event, 'quota.warning');
      // databases: 2 of 2 → 100 % (no action: not an action dimension)
      dbUsage.set(shop, { instances: 1, databases: 2, sizeBytes: 1 });
      await enforcement.evaluateAccount(shop);
      alerts = await db('usage_alerts').where({ account_id: shop }).orderBy('id');
      assert.deepEqual(alerts.map((a) => [a.dimension, a.level]), [['traffic', 80], ['databases', 100]]);
      assert.equal((await db('hosting_accounts').where({ id: shop }).first()).over_quota_state, 'ok');
      // back under → cleared; again over → reopened (same row)
      dbUsage.set(shop, { instances: 1, databases: 1, sizeBytes: 1 });
      await enforcement.evaluateAccount(shop);
      const cleared = await db('usage_alerts').where({ account_id: shop, dimension: 'databases' }).first();
      assert.ok(cleared.cleared_at);
      dbUsage.set(shop, { instances: 1, databases: 2, sizeBytes: 1 });
      await enforcement.evaluateAccount(shop);
      const reopened = await db('usage_alerts').where({ account_id: shop, dimension: 'databases' });
      assert.equal(reopened.length, 1);
      assert.equal(reopened[0].cleared_at, null);
      // client view: its account's alerts; other tenant's staff: none; open filter
      assert.equal((await usageQueryService.alerts(asAlice, {})).length, 2);
      assert.equal((await usageQueryService.alerts(asStaffB, {})).length, 0);
      await rejectsWith(usageQueryService.alerts(asStaffB, { accountId: shop }), 404);
      assert.equal((await usageQueryService.alerts(asStaffA, { accountId: shop, open: true })).length, 2);
    });

    await t.test('enforcement: block-uploads at 100 %, lifted back under', async () => {
      await db('usage_traffic_daily').where({ account_id: shop, site_id: shopSite }).update({ bytes_out: 2 * MIB });
      assert.equal(await enforcementService.uploadsBlocked(shop), false);
      await enforcement.evaluateAccount(shop);
      const row = await db('hosting_accounts').where({ id: shop }).first();
      assert.equal(row.over_quota_state, 'blocked');
      assert.equal(row.status, 'active', 'publishing unaffected');
      assert.deepEqual(sessionDrops, [shop], 'open SFTP sessions dropped: they log in again read + delete only');
      assert.equal(await enforcementService.uploadsBlocked(shop), true);
      assert.equal(await enforcementService.uploadsBlocked(999_999), false);
      const levels = (await db('usage_alerts').where({ account_id: shop, dimension: 'traffic' }).orderBy('level')).map((a) => [a.level, a.cleared_at === null]);
      assert.deepEqual(levels, [[80, true], [100, true]], 'an alert stays open while its threshold is reached');
      // plan raised → under quota → lifted
      await db('plans').where({ id: planBlock }).update({ limits: JSON.stringify({ ...DEFAULT_PLAN_LIMITS, diskMb: 100, trafficMbPerMonth: 100, overQuotaAction: 'block-uploads', maxDatabases: 2 }) });
      await enforcement.evaluateAccount(shop);
      assert.equal((await db('hosting_accounts').where({ id: shop }).first()).over_quota_state, 'ok');
      assert.equal(await enforcementService.uploadsBlocked(shop), false);
      assert.deepEqual(sessionDrops, [shop], 'only on entering blocked');
      const audit = await db('audit_logs').where({ tenant_id: tenantA, action: 'account.over_quota', resource_path: String(shop) }).orderBy('id').select('details');
      assert.deepEqual(audit.map((a) => [a.details.from, a.details.to]), [['ok', 'blocked'], ['blocked', 'ok']]);
    });

    await t.test('enforcement: suspend once per period, staff unsuspension respected, monthly reset', async () => {
      await db('usage_traffic_daily').insert({ day: today, tenant_id: tenantA, account_id: blog, site_id: blogSite, requests: 1, bytes_out: 2 * MIB, bytes_in: 0 });
      await enforcement.evaluateAccount(blog);
      let row = await db('hosting_accounts').where({ id: blog }).first();
      assert.deepEqual([row.status, row.over_quota_state], ['suspended', 'suspended']);
      assert.match(String(row.status_message), /trafic/);
      assert.deepEqual(statusEvents, [[blog, true]]);
      const suspendAudit = await db('audit_logs').where({ tenant_id: tenantA, action: 'account.suspend', resource_path: String(blog) }).first();
      assert.deepEqual([suspendAudit.details.reason, suspendAudit.details.dimension, suspendAudit.user_id], ['overQuota', 'traffic', null]);
      // evaluated again: nothing more
      await enforcement.evaluateAccount(blog);
      assert.equal(statusEvents.length, 1);
      // a staff member reactivates it (same effect as accountsService.setSuspended): not re-suspended this month
      await db('hosting_accounts').where({ id: blog }).update({ status: 'active', status_message: null });
      await enforcement.evaluateAccount(blog);
      row = await db('hosting_accounts').where({ id: blog }).first();
      assert.deepEqual([row.status, row.over_quota_state], ['active', 'suspended']);
      assert.equal(statusEvents.length, 1);
      // re-suspended by us, then the month changes → reactivated (monthly reset)
      await db('hosting_accounts').where({ id: blog }).update({ over_quota_state: 'ok', over_quota_since: null });
      await enforcement.evaluateAccount(blog);
      assert.equal((await db('hosting_accounts').where({ id: blog }).first()).status, 'suspended');
      const next = new Date();
      next.setUTCDate(1);
      next.setUTCMonth(next.getUTCMonth() + 1);
      await enforcement.evaluateAccount(blog, db, next);
      row = await db('hosting_accounts').where({ id: blog }).first();
      assert.deepEqual([row.status, row.over_quota_state, row.status_message], ['active', 'ok', null]);
      assert.deepEqual(statusEvents.at(-1), [blog, false]);
      const unsuspend = await db('audit_logs').where({ tenant_id: tenantA, action: 'account.unsuspend', resource_path: String(blog) }).first();
      assert.equal(unsuspend.details.reason, 'monthlyReset');
      // past traffic alerts are closed by the monthly pass
      await enforcement.clearPastTrafficAlerts(monthOf(next));
      assert.equal(await db('usage_alerts').where({ account_id: blog, dimension: 'traffic' }).whereNull('cleared_at').first(), undefined);
    });

    await t.test('enforcement: a staff suspension is never lifted by the quota', async () => {
      // auto-suspended, then the staff suspends it again by hand after reactivating it
      await enforcement.evaluateAccount(blog);
      assert.equal((await db('hosting_accounts').where({ id: blog }).first()).status, 'suspended');
      await db('audit_logs').insert({ tenant_id: tenantA, user_id: staffA, action: 'account.suspend', resource_type: 'account', resource_path: String(blog), details: JSON.stringify({ username: 'blog' }) });
      await db('usage_traffic_daily').where({ account_id: blog }).delete();
      await enforcement.evaluateAccount(blog);
      const row = await db('hosting_accounts').where({ id: blog }).first();
      assert.deepEqual([row.status, row.over_quota_state], ['suspended', 'ok']);
    });

    await t.test('enforcement: a disk suspension lifted in a new month is not a monthly traffic reset', async () => {
      await db('hosting_accounts').where({ id: blog }).update({ status: 'suspended', over_quota_state: 'suspended', over_quota_since: db.fn.now() });
      await db('audit_logs').insert({ tenant_id: tenantA, user_id: null, action: 'account.suspend', resource_type: 'account', resource_path: String(blog), details: JSON.stringify({ username: 'blog', reason: 'overQuota', dimension: 'disk' }) });
      const next = new Date();
      next.setUTCDate(1);
      next.setUTCMonth(next.getUTCMonth() + 1);
      await enforcement.evaluateAccount(blog, db, next);
      const row = await db('hosting_accounts').where({ id: blog }).first();
      assert.deepEqual([row.status, row.over_quota_state], ['active', 'ok']);
      const unsuspend = await db('audit_logs').where({ tenant_id: tenantA, action: 'account.unsuspend', resource_path: String(blog) }).orderBy('id', 'desc').first();
      assert.equal(unsuspend.details.reason, 'underQuota');
    });

    await t.test('tenant envelope alerts (scope tenant) on a full pass', async () => {
      hits.length = 0;
      await enforcement.evaluateAll();
      await notif.notificationQueueIdle();
      const ta = await db('usage_alerts').where({ scope: 'tenant', tenant_id: tenantA });
      assert.deepEqual(ta.map((a) => [a.dimension, a.level, a.account_id]), [['disk', 100, null]]);
      assert.equal((await db('usage_alerts').where({ scope: 'tenant', tenant_id: tenantB })).length, 0);
      // clients never see tenant alerts; the tenant staff does
      assert.ok((await usageQueryService.alerts(asAlice, {})).every((a) => a.scope === 'account'));
      assert.ok((await usageQueryService.alerts(asStaffA, {})).some((a) => a.scope === 'tenant'));
      // second pass: no duplicate
      await enforcement.evaluateAll();
      assert.equal((await db('usage_alerts').where({ scope: 'tenant', tenant_id: tenantA })).length, 1);
    });

    await t.test('disk: daily point keeps the largest measurement of the day', async () => {
      await recordDailyDisk(shop, 5 * MIB);
      await recordDailyDisk(shop, 7 * MIB);
      await recordDailyDisk(shop, 6 * MIB);
      const rows = await db('usage_disk_daily').where({ account_id: shop });
      assert.equal(rows.length, 1);
      assert.equal(Number(rows[0].used_bytes), 7 * MIB);
      const u = await usageQueryService.account(asStaffA, shop, null);
      assert.deepEqual(u.disk.history, [{ day: today, usedBytes: 7 * MIB }]);
    });

    await t.test('dashboard: database instances counted per actor', async () => {
      await db('db_instances').insert([
        { tenant_id: tenantA, account_id: shop, node_id: node, name: 'main', engine: 'mariadb', version: '11.4', root_secret: 'v1:x' },
        { tenant_id: tenantA, account_id: blog, node_id: node, name: 'main', engine: 'postgresql', version: '17', root_secret: 'v1:x' },
        { tenant_id: tenantB, account_id: other, node_id: node, name: 'main', engine: 'mysql', version: '8.4', root_secret: 'v1:x' },
      ]);
      assert.equal((await dashboardService.summary(asStaffA)).databases, 2);
      assert.equal((await dashboardService.summary(asAlice)).databases, 1);
      assert.equal((await dashboardService.summary(asStaffB)).databases, 1);
      assert.equal((await dashboardService.summary(asAdmin)).databases, 3);
      assert.equal((await usageQueryService.tenant(asStaffA, null, null)).totals.dbInstances, 2);
    });
  } finally {
    notif.setNotificationDepsForTests(null);
    enforcement.setEnforcementEffectsForTests(null);
    enforcement.setDbUsageSourceForTests(null);
    await new Promise<void>((r) => server.close(() => r()));
    await db.destroy();
  }
});
