import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of honeypot-bans on a PGlite server (docs/P4b-PLAN.md §15:
// honeypot-bans = port 55475):  PG_PORT=55475 node <scratchpad>/pg/pgserver.mjs
// BANS_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. hostd / Docker / Obliguard / the edge = fakes (setWebBanBackendsForTests),
// GeoIP off. Covers: migrations 001–007, honeypot detection through the edge
// log listener (tagging, never-ban, coalescing, escalation ladder + host floor
// + window, repeat on an active ban, promotion on 3 independent owners, nftables push,
// Obliguard), the g-bans provider, routes + isolation (account bans of an
// account / tenant staff / platform admin, redacted platform bans), manual
// ban / unban / promote rights and codes, audit, unique active index, expiry,
// retention.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.BANS_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55475/postgres';

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

test('honeypot-bans on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55475)`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-bans-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'bans-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const bansRoutes = (await import('../../routes/bans.routes')).default;
  const { platformSettings } = await import('../platformSettings');
  const { MASTER_TENANT_ID } = await import('@oblimint/shared');
  const svc = await import('./bans.service');
  const { ObliguardClient } = await import('./obliguard');
  const { setGeoBackendsForTests } = await import('./geoip.service');
  const { resolveActor } = await import('../hosting/access');
  type EdgeLogEntry = import('../usage/edgeLog').EdgeLogEntry;

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });
  // 007 replayed: the partial unique index and the CHECKs exist.
  const idx = await db.raw(`SELECT indexdef FROM pg_indexes WHERE indexname = 'web_bans_active_unique'`);
  assert.match(idx.rows[0].indexdef, /WHERE is_active/);

  // The tables of this module start empty (the harness DB may be reused between runs).
  await db('web_bans').delete();
  await db('web_ban_offenses').delete();
  await platformSettings.update({ bans: { geoipProvider: 'off', obliguardEnabled: true, neverBan: ['45.1.1.0/24'] } });
  setGeoBackendsForTests({ fetch: async () => { throw new Error('no network in tests'); } });

  // ── fakes ──────────────────────────────────────────────────────────────────
  let clock = new Date('2026-10-10T12:00:00Z');
  const pushes: Array<{ ports: number[]; bans: Array<{ cidr: string; expiresAt: string | null }> }> = [];
  const edgeSyncs: string[] = [];
  const guardCalls: Array<{ method: string; url: string; body: unknown }> = [];
  let guardDown = false;
  let duringPost: (() => Promise<unknown>) | null = null;
  const obliguard = new ObliguardClient(
    async () => ({ manualUrl: 'https://guard.test', obligate: { url: 'https://obligate.test', apiKey: 'k' }, connectedApps: async () => [] }),
    async (url, init) => {
      if (url.endsWith('/api/delegation/token')) return Response.json({ success: true, data: { token: 'tok' } });
      guardCalls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (init?.method === 'POST' && duringPost) await duringPost();
      return new Response(null, { status: guardDown ? 503 : 201 });
    },
  );
  svc.setWebBanBackendsForTests({
    now: () => clock,
    setWebFirewall: async (s) => { pushes.push(JSON.parse(JSON.stringify(s))); },
    dockerSubnets: async () => ['172.17.0.0/16', '198.51.100.0/24'],
    nodeAddresses: async () => ['203.0.113.10'],
    scheduleEdgeSync: (r) => { edgeSyncs.push(r); },
    obliguard,
  });
  t.after(() => { svc.webBanService.stop(); svc.setWebBanBackendsForTests(null); setGeoBackendsForTests(null); });
  const advance = (minutes: number) => { clock = new Date(clock.getTime() + minutes * 60_000); };

  // ── fixtures ───────────────────────────────────────────────────────────────
  const suffix = Date.now().toString(36);
  const [ta] = await db('tenants').insert({ name: `A ${suffix}`, slug: `a-${suffix}` }).returning('id');
  const [tb] = await db('tenants').insert({ name: `B ${suffix}`, slug: `b-${suffix}` }).returning('id');
  const tA = Number(ta.id ?? ta);
  const tB = Number(tb.id ?? tb);
  const [tc] = await db('tenants').insert({ name: `C ${suffix}`, slug: `c-${suffix}` }).returning('id');
  const tC = Number(tc.id ?? tc);
  const user = async (name: string, kind: 'staff' | 'client', role: 'admin' | 'user', tenantId: number) => {
    const [row] = await db('users').insert({ username: `${name}-${suffix}`, kind, role, is_active: true }).returning('id');
    const id = Number(row.id ?? row);
    if (kind === 'staff') await db('user_tenants').insert({ user_id: id, tenant_id: tenantId, role: 'admin' });
    return id;
  };
  const platformAdmin = await user('pa', 'staff', 'admin', MASTER_TENANT_ID);
  const staffA = await user('sta', 'staff', 'admin', tA);
  const staffB = await user('stb', 'staff', 'admin', tB);
  const clientManage = await user('cm', 'client', 'user', tA);
  const clientRead = await user('cr', 'client', 'user', tA);
  const clientOther = await user('co', 'client', 'user', tA);
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number };
  const mkAccount = async (tenantId: number, name: string) => {
    const [plan] = await db('plans').insert({ tenant_id: tenantId, name: `p-${name}-${suffix}`, limits: JSON.stringify({}) }).returning('id');
    const uid = 20000 + Math.floor(Math.random() * 30000);
    const [acct] = await db('hosting_accounts').insert({
      tenant_id: tenantId, node_id: localNode.id, plan_id: Number(plan.id ?? plan), username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
    }).returning('id');
    return Number(acct.id ?? acct);
  };
  const acme = await mkAccount(tA, 'acme');
  const other = await mkAccount(tA, 'other');
  const bAcct = await mkAccount(tB, 'bee');
  const cAcct = await mkAccount(tC, 'cee');
  await db('account_users').insert([
    { user_id: clientManage, account_id: acme, capabilities: JSON.stringify(['proxy.manage']) },
    { user_id: clientRead, account_id: acme, capabilities: JSON.stringify([]) },
    { user_id: clientOther, account_id: other, capabilities: JSON.stringify(['proxy.manage']) },
  ]);
  const mkHost = async (tenantId: number, accountId: number, name: string, banDurationMinutes: number | null) => {
    const [h] = await db('proxy_hosts').insert({
      tenant_id: tenantId, account_id: accountId, name, target: JSON.stringify({ kind: 'external', host: 'example.com', port: 80 }),
      honeypot: JSON.stringify({ enabled: true, paths: ['/wp-login.php'], banAclViolations: true, banDurationMinutes }),
    }).returning('id');
    return Number(h.id ?? h);
  };
  const hAcme = await mkHost(tA, acme, 'acme-site', 120);
  const hOther = await mkHost(tA, other, 'other-site', null);
  const hB = await mkHost(tB, bAcct, 'bee-site', null);
  const hC = await mkHost(tC, cAcct, 'cee-site', null);

  // ── app ────────────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: Number(req.header('x-user')) };
    (req as unknown as { tenantId: number }).tenantId = Number(req.header('x-tenant'));
    next();
  });
  app.use('/bans', bansRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  type Who = { user: number; tenant: number };
  const call = async (method: string, url: string, who: Who, body?: unknown) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-user': String(who.user), 'x-tenant': String(who.tenant) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as { success: boolean; data?: any; code?: string; details?: any } };
  };
  const asAdmin: Who = { user: platformAdmin, tenant: MASTER_TENANT_ID };
  const asStaffA: Who = { user: staffA, tenant: tA };
  const asStaffB: Who = { user: staffB, tenant: tB };
  const asManager: Who = { user: clientManage, tenant: tA };
  const asReader: Who = { user: clientRead, tenant: tA };
  const asOther: Who = { user: clientOther, tenant: tA };

  const entry = (ip: string, hostId: number, hp: 'path' | 'acl', uri = '/wp-login.php?x=1', host = 'a.test'): EdgeLogEntry => ({
    time: clock.toISOString(), host, remoteAddr: ip, method: 'GET', uri, status: 404, bytes: 0, bytesOut: 0, bytesIn: 0, requestTime: 0,
    upstream: null, upstreamStatus: null, userAgent: 'scanner', referer: null, siteId: null, accountId: null, tenantId: null, kind: 'proxy',
    proxyHostId: hostId, honeypot: hp,
  });
  const hit = async (...entries: EdgeLogEntry[]) => {
    for (const e of entries) svc.onEdgeLogEntry(e);
    await svc.whenBansIdle();
  };
  const activeRow = (ip: string, accountId: number | null) => db('web_bans').where({ ip, is_active: true })
    .andWhere((q) => (accountId === null ? q.whereNull('account_id') : q.where('account_id', accountId))).first();

  // ── detection, tagging, never-ban ──────────────────────────────────────────
  await hit(entry('8.8.8.8', hAcme, 'path'), entry('8.8.8.8', hAcme, 'path'), { ...entry('8.8.8.8', hAcme, 'path'), honeypot: null });
  let row = await activeRow('8.8.8.8', acme);
  assert.ok(row, 'account ban created');
  assert.equal(row.scope, 'account');
  assert.equal(row.source, 'honeypot-path');
  assert.equal(row.reason, '/wp-login.php on a.test', 'path only, no query string');
  assert.equal(row.hit_count, 2, 'coalesced hits');
  assert.equal(row.offense_level, 1);
  assert.equal(row.proxy_host_id, hAcme);
  assert.equal(Number(row.tenant_id), tA);
  assert.equal(new Date(row.banned_until).getTime() - clock.getTime(), 120 * 60_000, 'host floor 120 min > first step 60');
  assert.equal(row.obliguard_status, 'disabled', 'account bans never go to Obliguard');

  await hit(entry('2a00:1450:4007:80e::1', hOther, 'acl', '/admin', 'b.test'));
  row = await activeRow('2a00:1450:4007:80e::/64', other);
  assert.ok(row, 'IPv6 banned by /64');
  assert.equal(row.source, 'honeypot-acl', 'ACL trap tagged honeypot-acl (Oblihub bug fixed)');
  assert.equal(new Date(row.banned_until).getTime() - clock.getTime(), 60 * 60_000);

  for (const ip of ['10.0.0.5', '100.64.1.1', '203.0.113.10', '198.51.100.7', '45.1.1.9', 'fd00::1', 'garbage']) await hit(entry(ip, hAcme, 'path'));
  assert.equal(await db('web_bans').count<{ n: string }[]>({ n: '*' }).then((r) => Number(r[0].n)), 2, 'never-ban addresses ignored (BN1)');

  // Repeat on an active ban: hit_count, no level climb, extension only when longer.
  advance(10);
  await hit(entry('8.8.8.8', hAcme, 'path'));
  row = await activeRow('8.8.8.8', acme);
  assert.equal(row.hit_count, 3);
  assert.equal(row.offense_level, 1);
  assert.equal(new Date(row.banned_until).getTime() - clock.getTime(), 120 * 60_000, 'extended: now + 120 min');

  // g-bans provider (account bans only so far).
  let [unit] = await svc.webBanWorkerForTests.provider.units();
  assert.equal(unit.id, 'g-bans');
  assert.match(unit.config, new RegExp(`8\\.8\\.8\\.8 "\\|${acme}\\|";`));
  assert.match(unit.config, new RegExp(`2a00:1450:4007:80e::/64 "\\|${other}\\|";`));
  assert.match(unit.config, /\$oblimint_ban_p \{\n {4}default 0;\n\}/);

  // Expiry, then escalation to level 2 (1440 min > floor).
  advance(121);
  assert.equal(await svc.webBanWorkerForTests.expireNow(), 2, 'both account bans ended');
  assert.equal(await activeRow('8.8.8.8', acme), undefined);
  await hit(entry('8.8.8.8', hAcme, 'path'));
  row = await activeRow('8.8.8.8', acme);
  assert.equal(row.offense_level, 2);
  assert.equal(new Date(row.banned_until).getTime() - clock.getTime(), 1440 * 60_000);
  // Window passed: the ladder restarts.
  await db('web_ban_offenses').where({ ip: '8.8.8.8', account_id: acme }).update({ last_offense_at: new Date(clock.getTime() - 40 * 86_400_000) });
  await db('web_bans').where({ id: row.id }).update({ is_active: false, deactivated_at: clock });
  await hit(entry('8.8.8.8', hAcme, 'path'));
  assert.equal((await activeRow('8.8.8.8', acme)).offense_level, 1, 'offences older than the window forgotten');

  // ── promotion: same IP on 3 accounts of 3 independent owners within the window ──
  pushes.length = 0;
  await hit(entry('8.8.8.8', hOther, 'path'));
  assert.equal(await activeRow('8.8.8.8', null), undefined, '2 accounts: no promotion');
  await hit(entry('8.8.8.8', hC, 'path', '/.env', 'cee.test'));
  assert.ok(await activeRow('8.8.8.8', cAcct), 'account ban on the third account');
  assert.equal(await activeRow('8.8.8.8', null), undefined, '3 accounts but 2 owners (acme + other = tenant A): no promotion');
  await hit(entry('8.8.8.8', hB, 'path', '/.env', 'bee.test'));
  const promoted = await activeRow('8.8.8.8', null);
  assert.ok(promoted, '3 owners: platform ban');
  assert.equal(promoted.scope, 'platform');
  assert.equal(promoted.source, 'promotion');
  assert.equal(Number(promoted.tenant_id), MASTER_TENANT_ID);
  assert.match(promoted.reason, /^banned on 4 accounts \(3 owners\) within 30 days/);
  await new Promise((r) => setTimeout(r, 1300)); // debounced hostd push + Obliguard (fire and forget)
  assert.deepEqual(pushes.at(-1), { ports: [80, 443], bans: [{ cidr: '8.8.8.8', expiresAt: new Date(promoted.banned_until).toISOString() }] });
  assert.equal(guardCalls.at(-1)?.method, 'POST');
  assert.deepEqual(Object.keys(guardCalls.at(-1)!.body as object).sort(), ['banned_until', 'first_seen_at', 'hit_count', 'ip', 'proxy_host_domain', 'reason', 'source', 'source_type'].sort());
  assert.equal((await db('web_bans').where({ id: promoted.id }).first()).obliguard_status, 'sent');
  [unit] = await svc.webBanWorkerForTests.provider.units();
  assert.match(unit.config, /\n {4}8\.8\.8\.8 1;\n/);
  assert.ok(!/8\.8\.8\.8 "\|/.test(unit.config), 'platform ban supersedes the account entries');
  assert.ok(edgeSyncs.length === 0 || edgeSyncs.every((r) => r === 'bans'));

  // ── unique active index ────────────────────────────────────────────────────
  // (No failing statement on purpose: PGlite's socket server attributes a statement error to the NEXT query of the
  // connection. The unique index is asserted on the catalog above and through the API — 409 banExists — below.)
  assert.ok(idx.rows[0].indexdef.includes('(ip, scope, COALESCE(account_id, 0))'), idx.rows[0].indexdef);
  await db('web_bans').insert({ ip: '8.8.8.8', scope: 'platform', tenant_id: MASTER_TENANT_ID, source: 'manual', is_active: false });
  // CHECKs, on the catalog too.
  const checks = (await db.raw(`SELECT conname FROM pg_constraint WHERE conrelid = 'web_bans'::regclass AND contype = 'c' ORDER BY conname`)).rows
    .map((x: { conname: string }) => x.conname);
  assert.deepEqual(checks, ['web_bans_scope_check', 'web_bans_source_check']);

  // ── routes: list isolation ─────────────────────────────────────────────────
  let r = await call('GET', '/bans', asManager);
  assert.equal(r.status, 200);
  assert.ok(r.body.data.items.length > 0 && r.body.data.items.every((b: any) => b.accountId === acme && b.scope === 'account'), 'client: its account only, no platform ban');
  r = await call('GET', '/bans', asOther);
  assert.ok(r.body.data.items.every((b: any) => b.accountId === other));
  r = await call('GET', `/bans?accountId=${acme}`, asOther);
  assert.equal(r.status, 404, 'another account: invisible');
  r = await call('GET', '/bans', asStaffB);
  const itemsB = r.body.data.items as any[];
  assert.ok(itemsB.every((b) => b.scope === 'platform' || b.accountId === bAcct), 'tenant staff: its tenant + platform');
  const platformSeenByB = itemsB.find((b) => b.scope === 'platform' && b.active);
  assert.ok(platformSeenByB);
  assert.equal(platformSeenByB.proxyHostId, hB, 'the platform ban came from its own host: detail kept');
  r = await call('GET', '/bans', asStaffA);
  const platformSeenByA = (r.body.data.items as any[]).find((b) => b.scope === 'platform' && b.active);
  assert.equal(platformSeenByA.reason, null, 'another tenant\'s detail redacted');
  assert.equal(platformSeenByA.proxyHostId, null);
  assert.equal(platformSeenByA.obliguardStatus, 'sent');
  r = await call('GET', '/bans?scope=platform', asManager);
  assert.deepEqual(r.body.data, { items: [], total: 0 });
  r = await call('GET', '/bans', asAdmin);
  assert.ok(r.body.data.total >= 5);
  r = await call('GET', `/bans?tenantId=${tB}&scope=account`, asAdmin);
  assert.ok(r.body.data.items.every((b: any) => b.tenantId === tB));
  r = await call('GET', '/bans?q=.env&active=true', asAdmin);
  assert.ok(r.body.data.items.length >= 1 && r.body.data.items.every((b: any) => (b.reason ?? '').includes('.env')));
  r = await call('GET', '/bans?q=2a00:1450', asAdmin);
  assert.equal(r.body.data.items[0].ip, '2a00:1450:4007:80e::/64');
  r = await call('GET', '/bans?limit=1&offset=1', asAdmin);
  assert.equal(r.body.data.items.length, 1);
  r = await call('GET', `/bans?source=honeypot-acl`, asAdmin);
  assert.ok(r.body.data.items.every((b: any) => b.source === 'honeypot-acl'));
  r = await call('GET', '/bans?limit=9999', asAdmin);
  assert.equal(r.status, 400);

  r = await call('GET', '/bans/stats', asAdmin);
  assert.equal(r.body.data.platform, 1);
  assert.equal(r.body.data.bySource.promotion, 1);
  assert.ok(r.body.data.account >= 3);
  r = await call('GET', '/bans/stats', asManager);
  assert.equal(r.body.data.platform, 0);
  assert.equal(r.body.data.account, 1);

  r = await call('GET', '/bans/honeypot-presets', asReader);
  assert.equal(r.status, 200);
  assert.ok(r.body.data.length >= 45);
  r = await call('GET', '/bans/firewall', asStaffA);
  assert.equal(r.status, 403);
  r = await call('GET', '/bans/firewall', asAdmin);
  assert.deepEqual({ ports: r.body.data.ports, bans: r.body.data.bans, err: r.body.data.lastPushError }, { ports: [80, 443], bans: 1, err: null });

  // ── manual ban ─────────────────────────────────────────────────────────────
  r = await call('POST', '/bans', asReader, { ip: '9.9.9.9', scope: 'account', accountId: acme });
  assert.equal(r.status, 403, 'member without proxy.manage');
  r = await call('POST', '/bans', asOther, { ip: '9.9.9.9', scope: 'account', accountId: acme });
  assert.equal(r.status, 404, 'another account');
  r = await call('POST', '/bans', asStaffB, { ip: '9.9.9.9', scope: 'account', accountId: acme });
  assert.equal(r.status, 404, 'another tenant');
  r = await call('POST', '/bans', asManager, { ip: '9.9.9.9', scope: 'platform' });
  assert.equal(r.status, 403, 'platform ban: platform admin only');
  r = await call('POST', '/bans', asStaffA, { ip: '9.9.9.9', scope: 'platform' });
  assert.equal(r.status, 403);
  for (const [ip, reason] of [['192.168.1.1', 'notPublic'], ['203.0.113.10', 'node'], ['45.1.1.200', 'neverBan'], ['172.17.0.4', 'notPublic'], ['9.9.9.0/24', 'invalid']] as const) {
    r = await call('POST', '/bans', asManager, { ip, scope: 'account', accountId: acme });
    assert.equal(r.status, 400, ip);
    assert.equal(r.body.code, 'banNotAllowed');
    assert.equal(r.body.details.reason, reason, ip);
  }
  r = await call('POST', '/bans', asManager, { ip: '9.9.9.9', scope: 'account', accountId: acme, reason: 'scan\nmanuel', durationMinutes: null });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const manual = r.body.data;
  assert.equal(manual.source, 'manual');
  assert.equal(manual.bannedUntil, null, 'permanent');
  assert.equal(manual.reason, 'scan manuel');
  assert.equal(manual.createdBy, `cm-${suffix}`);
  assert.equal(manual.obliguardStatus, 'disabled', 'clients never see the Obliguard state');
  r = await call('POST', '/bans', asManager, { ip: '9.9.9.9', scope: 'account', accountId: acme });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'banExists');
  const audit = await db('audit_logs').where({ action: 'bans.create', tenant_id: tA }).first();
  assert.ok(audit, 'bans.create audited in the account tenant');
  // Own address refused (service level: the caller's address).
  const fakeReq = { socket: { remoteAddress: '8.8.4.4' }, headers: {}, session: { userId: platformAdmin }, tenantId: MASTER_TENANT_ID } as never;
  const adminActor = await resolveActor(fakeReq);
  await assert.rejects(svc.webBanService.create(fakeReq, adminActor, { ip: '8.8.4.4', scope: 'platform' }), (e: any) => e.code === 'banNotAllowed' && e.details.reason === 'ownAddress');

  // Platform manual ban → nftables push.
  pushes.length = 0;
  r = await call('POST', '/bans', asAdmin, { ip: '2a01:4f8:1:2::5', scope: 'platform', durationMinutes: 30 });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.ip, '2a01:4f8:1:2::/64');
  assert.equal(r.body.data.scope, 'platform');
  const platformManual = r.body.data;
  await new Promise((res) => setTimeout(res, 1300));
  assert.ok(pushes.at(-1)!.bans.some((b) => b.cidr === '2a01:4f8:1:2::/64'));

  // ── unban ──────────────────────────────────────────────────────────────────
  r = await call('DELETE', `/bans/${manual.id}`, asReader);
  assert.equal(r.status, 403);
  r = await call('DELETE', `/bans/${manual.id}`, asOther);
  assert.equal(r.status, 404);
  r = await call('DELETE', `/bans/${manual.id}`, asManager);
  assert.deepEqual(r.body, { success: true, data: { deleted: true } });
  r = await call('DELETE', `/bans/${manual.id}`, asManager);
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'banNotFound');
  r = await call('DELETE', `/bans/${promoted.id}`, asStaffA);
  assert.equal(r.status, 403, 'tenant staff never lift a platform ban');
  r = await call('DELETE', `/bans/${promoted.id}`, asManager);
  assert.equal(r.status, 404, 'a client never sees a platform ban');
  guardCalls.length = 0;
  r = await call('DELETE', `/bans/${promoted.id}`, asAdmin);
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 300));
  assert.deepEqual(guardCalls.map((c) => [c.method, c.url]), [['DELETE', 'https://guard.test/api/external-bans/8.8.8.8']]);
  assert.equal((await db('web_bans').where({ id: promoted.id }).first()).obliguard_status, 'disabled', 'withdrawn from Obliguard');
  // A failed unban DELETE is retried by the worker, never lost.
  assert.equal((await db('web_bans').where({ id: platformManual.id }).first()).obliguard_status, 'sent');
  guardDown = true;
  guardCalls.length = 0;
  r = await call('DELETE', `/bans/${platformManual.id}`, asAdmin);
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(guardCalls.filter((c) => c.method === 'DELETE').length, 1);
  assert.equal((await db('web_bans').where({ id: platformManual.id }).first()).obliguard_status, 'sent', 'DELETE owed');
  guardDown = false;
  guardCalls.length = 0;
  await svc.webBanWorkerForTests.resendObliguard();
  assert.deepEqual(guardCalls.map((c) => [c.method, c.url]), [['DELETE', `https://guard.test/api/external-bans/${encodeURIComponent('2a01:4f8:1:2::/64')}`]]);
  assert.equal((await db('web_bans').where({ id: platformManual.id }).first()).obliguard_status, 'disabled');
  // A ban lifted while its POST was in flight is withdrawn right after the POST.
  const [lateRow] = await db('web_bans').insert({ ip: '1.0.0.1', scope: 'platform', tenant_id: MASTER_TENANT_ID, source: 'manual', is_active: true, obliguard_status: 'pending' }).returning('id');
  const late = Number(lateRow.id ?? lateRow);
  guardCalls.length = 0;
  duringPost = () => db('web_bans').where({ id: late }).update({ is_active: false, deactivated_at: clock });
  assert.equal(await svc.syncBanToObliguard(late), 'sent');
  duringPost = null;
  assert.deepEqual(guardCalls.map((c) => c.method), ['POST', 'DELETE']);
  assert.equal((await db('web_bans').where({ id: late }).first()).obliguard_status, 'disabled');
  assert.ok(await db('audit_logs').where({ action: 'bans.delete', tenant_id: MASTER_TENANT_ID }).first());

  // ── promote ────────────────────────────────────────────────────────────────
  const accountBan = await activeRow('8.8.8.8', acme);
  r = await call('POST', `/bans/${accountBan.id}/promote`, asManager);
  assert.equal(r.status, 403, 'visible, not allowed');
  r = await call('POST', `/bans/${accountBan.id}/promote`, asStaffB);
  assert.equal(r.status, 404, 'invisible');
  r = await call('POST', `/bans/${accountBan.id}/promote`, asAdmin);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.scope, 'platform');
  assert.equal(r.body.data.source, 'promotion');
  assert.ok(new Date(r.body.data.bannedUntil).getTime() >= new Date(accountBan.banned_until).getTime(), 'never shorter than the account ban');
  r = await call('POST', `/bans/${accountBan.id}/promote`, asAdmin);
  assert.equal(r.status, 409);
  assert.ok(await db('audit_logs').where({ action: 'bans.promote' }).first());

  // ── retention ──────────────────────────────────────────────────────────────
  const before = Number((await db('web_bans').where({ is_active: false }).count<{ n: string }[]>({ n: '*' }))[0].n);
  assert.ok(before > 0);
  advance(91 * 24 * 60);
  await svc.webBanWorkerForTests.expireNow();
  await svc.webBanWorkerForTests.retentionNow();
  const inactive = await db('web_bans').where({ is_active: false }).select(db.raw('COALESCE(deactivated_at, last_seen_at) as deactivated_at'));
  assert.ok(inactive.every((x: { deactivated_at: Date }) => new Date(x.deactivated_at).getTime() >= clock.getTime() - 90 * 86_400_000), 'old inactive bans purged');
  assert.equal(Number((await db('web_ban_offenses').count<{ n: string }[]>({ n: '*' }))[0].n), 0, 'offences past the window purged');
});
