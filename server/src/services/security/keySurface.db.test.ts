import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// IP security of the key surfaces (spec §5, §9 keySurface.db.test.ts) on a real
// PostgreSQL (KS_TEST_DATABASE_URL; skipped when nothing listens). The real
// /api/v1, /mcp and /oauth/token routers, real obk_ keys and connector tokens,
// the real web bans (hostd / edge / Obliguard faked through
// setWebBanBackendsForTests). The client address comes through
// X-Forwarded-For from loopback (a trusted proxy by default), like the edge.
//   - strict ⇒ a key-intrusion ban: platform, permanent, Obliguard POST
//     (banned_until null) and re-pushed before Obliguard's 7-day cap;
//   - strictMode log ⇒ no ban, "would have banned" journaled and in the status;
//   - bad keys from an allowed address ⇒ key-bruteforce, escalation level 1
//     then 2; lifting the ban (Bans page) ⇒ inactive, DELETE Obliguard,
//     the guard forgets it at once;
//   - never banned: an open platform-admin session's address, Anthropic's
//     ranges, the trusted IPs ("trust" lifts and exempts in one go);
//   - verify reasons: ipNotAllowed, ipRequired (tenant override), a connector's
//     list + the connectors' ranges; 400 ipRequired at creation;
//   - /oauth/token: invalid_client counted; settings routes gated by
//     platform.key_security; web_bans_source_check accepts the new sources.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.KS_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55929/postgres';

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

test('IP security of the key surfaces', { timeout: 600_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) { t.skip(`no PostgreSQL at ${DB_URL}`); return; }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-ks-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'ks-test-secret-0123456789abcdef0123';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { MASTER_TENANT_ID } = await import('@oblimint/shared');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const v1Routes = (await import('../../routes/v1.routes')).default;
  const bansRoutes = (await import('../../routes/bans.routes')).default;
  const keySecurityRoutes = (await import('../../routes/keySecurity.routes')).default;
  const { mcpRouter } = await import('../apiKeys/mcp');
  const { oauthPublicRouter } = await import('../apiKeys/oauth');
  const { apiKeysService, hashKey } = await import('../apiKeys/apiKeys.service');
  const { actorForUser } = await import('../hosting/access');
  const { platformSettings } = await import('../platformSettings');
  const bans = await import('./bans.service');
  const { keySurfaceGuard } = await import('./keySurfaceGuard');
  const { ObliguardClient } = await import('./obliguard');
  const { setGeoBackendsForTests } = await import('./geoip.service');

  await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
  await db.raw('CREATE SCHEMA public');
  await db.migrate.latest();
  t.after(async () => { keySurfaceGuard.setDepsForTests(null); bans.webBanService.stop(); bans.setWebBanBackendsForTests(null); setGeoBackendsForTests(null); await db.destroy(); });

  // 029: the CHECK takes the new sources.
  const check = await db.raw(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'web_bans_source_check'`);
  assert.match(check.rows[0].d, /key-intrusion/);
  assert.match(check.rows[0].d, /key-bruteforce/);

  // ── fakes: hostd, Docker, edge, Obliguard ──
  const pushes: Array<{ bans: Array<{ cidr: string; expiresAt: string | null }> }> = [];
  const edgeSyncs: string[] = [];
  const guardCalls: Array<{ method: string; url: string; body: { ip?: string; banned_until?: string | null; source_type?: string } | null }> = [];
  const obliguard = new ObliguardClient(
    async () => ({ manualUrl: 'https://guard.example.com', obligate: { url: 'https://obligate.example.com', apiKey: 'k' }, connectedApps: async () => [] }),
    async (url, init) => {
      if (url.endsWith('/api/delegation/token')) return Response.json({ success: true, data: { token: 'tok' } });
      guardCalls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(null, { status: 201 });
    },
  );
  bans.setWebBanBackendsForTests({
    setWebFirewall: async (s) => { pushes.push(JSON.parse(JSON.stringify(s))); },
    dockerSubnets: async () => ['172.17.0.0/16'],
    nodeAddresses: async () => ['203.0.113.10'],
    scheduleEdgeSync: (r) => { edgeSyncs.push(r); },
    obliguard,
  });
  setGeoBackendsForTests({ fetch: async () => { throw new Error('no network in tests'); } });
  await platformSettings.update({ bans: { geoipProvider: 'off', obliguardEnabled: true, escalation: [60, 1440, null] } });
  await platformSettings.update({ keySecurity: { strictMode: 'on', maxFailures: 3, failureWindowMinutes: 15 } });
  // The matrix stays out of the way (platform.key_security is tested on its own below).
  await db('tenants').update({ action_restrictions: JSON.stringify({}) });
  const settle = async () => { await new Promise((r) => setTimeout(r, 150)); };
  const refresh = () => { platformSettings.invalidate(); keySurfaceGuard.invalidate(); };

  // ── fixtures ──
  const A = Number((await db('tenants').insert({ name: 'Reseller KS', slug: 'reseller-ks', action_restrictions: JSON.stringify({}) }).returning('id'))[0].id);
  const OWNER = Number((await db('users').insert({ username: 'ks-owner', role: 'user', kind: 'client', is_active: true, password_hash: 'x' }).returning('id'))[0].id);
  await db('user_tenants').insert({ user_id: OWNER, tenant_id: A, role: 'client' });
  const ADMIN = Number((await db('users').insert({ username: 'ks-admin', role: 'admin', kind: 'staff', is_active: true, password_hash: 'x' }).returning('id'))[0].id);
  await db('user_tenants').insert({ user_id: ADMIN, tenant_id: MASTER_TENANT_ID, role: 'admin' });
  const nodeId = Number(((await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined)?.id
    ?? (await db('nodes').insert({ name: 'n1', is_local: true }).returning('id'))[0].id);
  const [plan] = await db('plans').insert({ tenant_id: A, name: 'p-ks', limits: JSON.stringify({}) }).returning('id');
  const acct = Number((await db('hosting_accounts').insert({
    tenant_id: A, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: 'ksacme', uid: 42001, gid: 42001, status: 'active', filesrv_mode: 'off',
  }).returning('id'))[0].id);
  await db('account_users').insert({ user_id: OWNER, account_id: acct, capabilities: JSON.stringify(['sites.manage', 'files.manage']) });
  const fakeReq = (userId: number) => ({ headers: {}, session: { userId }, socket: { remoteAddress: '203.0.113.7' } }) as never;
  const owner = await actorForUser(OWNER, A);
  const K1 = await apiKeysService.create(fakeReq(OWNER), owner, acct, { name: 'ci', scopes: ['files.read'], siteScope: 'all', allowedIps: ['198.51.100.0/24'] });
  assert.equal(K1.open, false);
  // An IP-less connector is open, like an IP-less key (owner rule: each account secures its own keys).
  const OPEN_CONN = await apiKeysService.create(fakeReq(OWNER), owner, acct, { name: 'claude-open', kind: 'connector', scopes: ['files.read'], siteScope: 'all' });
  assert.equal(OPEN_CONN.open, true);
  assert.deepEqual(OPEN_CONN.connectorRanges, []);
  await apiKeysService.remove(fakeReq(OWNER), owner, acct, OPEN_CONN.id);
  // A connector with an address and a live authorization: its list ∪ the connectors' ranges (Anthropic by default).
  const CONN = await apiKeysService.create(fakeReq(OWNER), owner, acct, { name: 'claude', kind: 'connector', scopes: ['files.read'], siteScope: 'all', allowedIps: ['198.51.100.0/24'] });
  assert.equal(CONN.open, false);
  assert.deepEqual(CONN.connectorRanges, ['160.79.104.0/21']);
  const family = crypto.randomUUID();
  await db('api_key_oauth_tokens').insert({ key_id: CONN.id, kind: 'refresh', token_hash: hashKey(`obr_${crypto.randomBytes(32).toString('base64url')}`), family, user_id: OWNER, expires_at: new Date(Date.now() + 86_400_000) });
  const accessToken = `oba_${crypto.randomBytes(32).toString('base64url')}`;
  await db('api_key_oauth_tokens').insert({ key_id: CONN.id, kind: 'access', token_hash: hashKey(accessToken), family, user_id: OWNER, expires_at: new Date(Date.now() + 3_600_000) });

  // ── app ──
  const app = express();
  app.use(express.json());
  app.use(oauthPublicRouter);
  app.use('/api/v1', v1Routes);
  app.use('/mcp', mcpRouter);
  const session = (req: import('express').Request, _res: unknown, next: () => void) => {
    const r = req as unknown as { session: Record<string, unknown>; tenantId: number };
    r.session = { userId: ADMIN, role: 'admin', currentTenantId: MASTER_TENANT_ID };
    r.tenantId = MASTER_TENANT_ID;
    next();
  };
  app.use('/api/system/key-security', session, keySecurityRoutes);
  app.use('/bans', session, bansRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, url: string, from: string, opts: { auth?: string; body?: unknown; form?: string } = {}) => {
    const headers: Record<string, string> = { 'x-forwarded-for': from };
    if (opts.auth) headers.authorization = opts.auth;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(`${base}${url}`, { method, headers, body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)) });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  };
  const mcp = (from: string, auth?: string) => call('POST', '/mcp', from, { auth, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  const activeBan = (ip: string) => db('web_bans').where({ ip, scope: 'platform', is_active: true }).first();

  // ── regime ──
  let st = await call('GET', '/api/system/key-security/status', '198.51.100.5');
  assert.equal(st.status, 200);
  assert.equal(st.body.data.regime, 'strict');
  assert.equal(st.body.data.activeKeys, 2);
  assert.deepEqual(st.body.data.openKeys, []);
  assert.equal(st.body.data.currentIp, '198.51.100.5');
  assert.equal(st.body.data.currentIpCoverage, 'allowList');
  assert.equal(st.body.data.strictMode, 'on');

  // ── an allowed address: authenticated, a bad key is a 401 ──
  assert.equal((await call('GET', '/api/v1/me', '198.51.100.5', { auth: `Bearer ${K1.key}` })).status, 200);
  assert.equal((await call('GET', '/api/v1/me', '198.51.100.5')).status, 401);
  // The connector from Anthropic's range.
  assert.equal((await mcp('160.79.104.10', `Bearer ${accessToken}`)).status, 200);

  // ── strict: an address outside every list is banned at once, permanently ──
  const intr = await mcp('203.0.113.50');
  assert.equal(intr.status, 403);
  assert.equal(intr.body.code, 'addressBanned');
  let ban = await activeBan('203.0.113.50');
  assert.ok(ban, 'platform ban');
  assert.equal(ban.source, 'key-intrusion');
  assert.equal(ban.banned_until, null, 'permanent');
  assert.equal(ban.account_id, null);
  assert.match(ban.reason, /\/mcp.*intrusion/);
  await settle();
  const posted = guardCalls.find((c) => c.method === 'POST' && c.body?.ip === '203.0.113.50');
  assert.ok(posted, 'pushed to Obliguard');
  assert.equal(posted!.body!.banned_until, null);
  assert.equal(posted!.body!.source_type, 'key-intrusion');
  assert.ok(edgeSyncs.length > 0, 'edge resynced');
  // Banned from then on — even with a valid key — without a second ban row.
  assert.equal((await call('GET', '/api/v1/me', '203.0.113.50', { auth: `Bearer ${K1.key}` })).status, 403);
  assert.equal(Number((await db('web_bans').where({ ip: '203.0.113.50' }).count<{ n: string }[]>('* as n'))[0].n), 1);
  // /oauth/token too (OAuth error form), not /.well-known.
  const tokIntr = await call('POST', '/oauth/token', '203.0.113.51', { form: 'grant_type=refresh_token' });
  assert.equal(tokIntr.status, 403);
  assert.equal(tokIntr.body.error, 'access_denied');
  assert.equal((await call('GET', '/.well-known/oauth-authorization-server', '203.0.113.52')).status, 200);
  assert.equal(await activeBan('203.0.113.52'), undefined);

  // Obliguard caps an external ban at 7 days: the permanent one is pushed again before that.
  const before = guardCalls.length;
  await db('web_bans').where({ id: ban.id }).update({ obliguard_status: 'sent', obliguard_sent_at: new Date(Date.now() - 6.5 * 86_400_000) });
  await bans.webBanWorkerForTests.resendObliguard();
  assert.ok(guardCalls.slice(before).some((c) => c.method === 'POST' && c.body?.ip === '203.0.113.50'), 'refreshed in Obliguard');
  const again = guardCalls.length;
  await bans.webBanWorkerForTests.resendObliguard();
  assert.equal(guardCalls.slice(again).filter((c) => c.body?.ip === '203.0.113.50').length, 0, 'not every 5 minutes');

  // ── strictMode log: nothing banned, journaled ──
  await platformSettings.update({ keySecurity: { strictMode: 'log' } });
  refresh();
  assert.equal((await mcp('203.0.113.60')).status, 401);
  assert.equal(await activeBan('203.0.113.60'), undefined);
  assert.ok(await db('audit_logs').where({ action: 'keySecurity.wouldBan', resource_path: '203.0.113.60' }).first('id'));
  st = await call('GET', '/api/system/key-security/status', '198.51.100.5');
  assert.equal(st.body.data.strictMode, 'log');
  assert.equal(st.body.data.wouldHaveBanned[0].ip, '203.0.113.60');
  assert.equal(st.body.data.wouldHaveBanned[0].surface, 'mcp');
  await platformSettings.update({ keySecurity: { strictMode: 'on' } });
  refresh();

  // ── an open platform-admin session's address is never banned ──
  await db('session').insert({ sid: 'ks-admin-sid', sess: JSON.stringify({ userId: ADMIN, role: 'admin', ip: '203.0.113.70' }), expire: new Date(Date.now() + 3_600_000) });
  refresh();
  assert.equal((await mcp('203.0.113.70')).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await mcp('203.0.113.70', 'Bearer obk_1_' + 'x'.repeat(43))).status, 401);
  assert.equal(await activeBan('203.0.113.70'), undefined);
  st = await call('GET', '/api/system/key-security/status', '203.0.113.70');
  assert.deepEqual(st.body.data.staffSessionIps, ['203.0.113.70']);
  assert.equal(st.body.data.currentIpCoverage, 'adminSession');
  // A client's (or an expired) session exempts nothing.
  await db('session').insert({ sid: 'ks-owner-sid', sess: JSON.stringify({ userId: OWNER, ip: '203.0.113.71' }), expire: new Date(Date.now() + 3_600_000) });
  refresh();
  assert.equal((await mcp('203.0.113.71')).status, 403);

  // ── Anthropic's ranges: refused, never banned ──
  for (let i = 0; i < 6; i++) assert.equal((await mcp('160.79.104.20', 'Bearer oba_' + 'A'.repeat(43))).status, 401);
  assert.equal(await activeBan('160.79.104.20'), undefined);

  // ── bad keys from an allowed address: escalation ──
  const bad = (from: string) => call('GET', '/api/v1/me', from, { auth: 'Bearer obk_1_' + 'y'.repeat(43) });
  assert.equal((await bad('198.51.100.7')).status, 401);
  assert.equal((await bad('198.51.100.7')).status, 401);
  const third = await bad('198.51.100.7');
  assert.equal(third.status, 403);
  assert.equal(third.body.code, 'addressBanned');
  ban = await activeBan('198.51.100.7');
  assert.equal(ban.source, 'key-bruteforce');
  assert.equal(ban.offense_level, 1);
  const minutes1 = (new Date(ban.banned_until).getTime() - new Date(ban.created_at).getTime()) / 60_000;
  assert.ok(Math.abs(minutes1 - 60) < 1, `level 1 = 60 min (${minutes1})`);
  // Lifted from the Bans page: inactive, withdrawn from Obliguard, forgotten by the guard at once.
  await settle();
  await db('web_bans').where({ id: ban.id }).update({ obliguard_status: 'sent' });
  const del = await call('DELETE', `/bans/${ban.id}`, '198.51.100.5');
  assert.equal(del.status, 200);
  await settle();
  assert.equal((await db('web_bans').where({ id: ban.id }).first('is_active')).is_active, false);
  assert.ok(guardCalls.some((c) => c.method === 'DELETE' && c.url.endsWith('/198.51.100.7')), 'DELETE Obliguard');
  assert.equal((await call('GET', '/api/v1/me', '198.51.100.7', { auth: `Bearer ${K1.key}` })).status, 200, 'no stale ban in the cache');
  assert.equal((await bad('198.51.100.7')).status, 401, 'counter cleared');
  assert.equal((await bad('198.51.100.7')).status, 401);
  assert.equal((await bad('198.51.100.7')).status, 403);
  ban = await activeBan('198.51.100.7');
  assert.equal(ban.offense_level, 2);
  const minutes2 = (new Date(ban.banned_until).getTime() - new Date(ban.created_at).getTime()) / 60_000;
  assert.ok(Math.abs(minutes2 - 1440) < 1, `level 2 = 1440 min (${minutes2})`);

  // ── "add to the trusted IPs": lifts and exempts in one go ──
  const trust = await call('POST', '/api/system/key-security/trust', '198.51.100.5', { body: { ip: '198.51.100.7' } });
  assert.equal(trust.status, 200);
  assert.deepEqual(trust.body.data.liftedBans, [ban.id]);
  assert.ok(trust.body.data.settings.trustedIps.includes('198.51.100.7'));
  assert.equal(await activeBan('198.51.100.7'), undefined);
  for (let i = 0; i < 6; i++) assert.equal((await bad('198.51.100.7')).status, 401);
  assert.equal(await activeBan('198.51.100.7'), undefined);

  // ── CLI path: liftPlatformBans (the intrusion ban) ──
  await db('web_bans').where({ ip: '203.0.113.50' }).update({ obliguard_status: 'sent' });
  const lifted = await bans.liftPlatformBans('203.0.113.50', { actor: 'cli' });
  assert.equal(lifted.length, 1);
  keySurfaceGuard.banLifted('203.0.113.50');
  await settle();
  assert.equal(await activeBan('203.0.113.50'), undefined);
  assert.ok(guardCalls.some((c) => c.method === 'DELETE' && c.url.endsWith('/203.0.113.50')));

  // ── /oauth/token: invalid_client counted ──
  for (let i = 0; i < 2; i++) assert.equal((await call('POST', '/oauth/token', '198.51.100.9', { form: 'grant_type=refresh_token&client_id=nope&client_secret=x' })).status, 401);
  const tok3 = await call('POST', '/oauth/token', '198.51.100.9', { form: 'grant_type=refresh_token&client_id=nope&client_secret=x' });
  assert.equal(tok3.status, 403);
  assert.equal((await activeBan('198.51.100.9')).source, 'key-bruteforce');

  // ── verify reasons ──
  assert.deepEqual(await apiKeysService.verifyDetailed(K1.key!, '203.0.113.99'), { ok: false, reason: 'ipNotAllowed' });
  assert.deepEqual(await apiKeysService.verifyDetailed('obk_nope', '198.51.100.5'), { ok: false, reason: 'malformed' });
  assert.deepEqual(await apiKeysService.verifyDetailed(`obk_${K1.id}_${'z'.repeat(43)}`, '198.51.100.5'), { ok: false, reason: 'unknown' });
  // A connector with a list: its list + the connectors' ranges.
  await db('api_keys').where({ id: CONN.id }).update({ allowed_ips: JSON.stringify(['198.51.100.0/24']) });
  assert.equal((await apiKeysService.verifyAccessTokenDetailed(accessToken, '160.79.104.10')).ok, true);
  assert.equal((await apiKeysService.verifyAccessTokenDetailed(accessToken, '198.51.100.3')).ok, true);
  assert.deepEqual(await apiKeysService.verifyAccessTokenDetailed(accessToken, '203.0.113.99'), { ok: false, reason: 'ipNotAllowed' });
  // IP mandatory (tenant override): an existing open key is refused at use; a new one without IP is a 400.
  const OPEN = await apiKeysService.create(fakeReq(OWNER), owner, acct, { name: 'open', scopes: ['files.read'], siteScope: 'all' });
  assert.equal(OPEN.open, true);
  assert.equal((await apiKeysService.verifyDetailed(OPEN.key!, '203.0.113.99')).ok, true);
  assert.equal((await apiKeysService.grantable(owner, acct)).requireIp, false, 'the key form: address optional');
  await db('tenants').where({ id: A }).update({ key_require_ip: true });
  assert.equal((await apiKeysService.grantable(owner, acct)).requireIp, true, 'the key form marks the address mandatory');
  assert.deepEqual(await apiKeysService.verifyDetailed(OPEN.key!, '203.0.113.99'), { ok: false, reason: 'ipRequired' });
  assert.equal((await apiKeysService.list(owner, acct)).find((k) => k.id === OPEN.id)?.ipMissing, true);
  await assert.rejects(apiKeysService.create(fakeReq(OWNER), owner, acct, { name: 'open2', scopes: ['files.read'], siteScope: 'all' }), (e: { code?: string }) => e.code === 'ipRequired');
  // A connector follows the same rule as a key: an address is required too.
  await assert.rejects(apiKeysService.create(fakeReq(OWNER), owner, acct, { name: 'claude-2', kind: 'connector', scopes: ['files.read'], siteScope: 'all' }), (e: { code?: string }) => e.code === 'ipRequired');
  await db('tenants').where({ id: A }).update({ key_require_ip: false });
  await platformSettings.update({ keySecurity: { requireIp: true } });
  platformSettings.invalidate();
  assert.equal((await apiKeysService.verifyDetailed(OPEN.key!, '203.0.113.99')).ok, true, 'false overrides the platform');
  assert.equal((await apiKeysService.grantable(owner, acct)).requireIp, false, 'the workspace false overrides the platform in the form too');
  await db('tenants').where({ id: A }).update({ key_require_ip: null });
  assert.deepEqual(await apiKeysService.verifyDetailed(OPEN.key!, '203.0.113.99'), { ok: false, reason: 'ipRequired' }, 'null inherits');
  assert.equal((await apiKeysService.grantable(owner, acct)).requireIp, true, 'the form inherits the platform setting');
  await platformSettings.update({ keySecurity: { requireIp: false } });
  refresh();

  // The open key put the surfaces back in watch mode.
  st = await call('GET', '/api/system/key-security/status', '198.51.100.5');
  assert.equal(st.body.data.regime, 'watch');
  assert.deepEqual(st.body.data.openKeys.map((k: { id: number }) => k.id), [OPEN.id]);
  assert.equal((await mcp('203.0.113.80')).status, 401);
  assert.equal(await activeBan('203.0.113.80'), undefined);

  // A connector with a list refuses the client secret from elsewhere at /oauth/token too.
  const connForm = (rt: string) => new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: CONN.oauthClientId!, client_secret: CONN.clientSecret! }).toString();
  const tokElsewhere = await call('POST', '/oauth/token', '203.0.113.82', { form: connForm('obr_nope') });
  assert.equal(tokElsewhere.status, 401);
  assert.equal(tokElsewhere.body.error, 'invalid_client', 'client secret used from outside the list and the ranges');
  const tokRange = await call('POST', '/oauth/token', '160.79.104.30', { form: connForm('obr_nope') });
  assert.equal(tokRange.status, 400);
  assert.equal(tokRange.body.error, 'invalid_grant', 'from the ranges: authenticated, then the grant is checked');
  // An IP-less connector is open, like an IP-less key (each account secures its own keys).
  await db('api_keys').where({ id: CONN.id }).update({ allowed_ips: JSON.stringify([]) });
  assert.equal((await apiKeysService.verifyAccessTokenDetailed(accessToken, '203.0.113.99')).ok, true);
  assert.equal((await apiKeysService.verifyAccessTokenDetailed(accessToken, '160.79.104.10')).ok, true);
  const tokOpen = await call('POST', '/oauth/token', '203.0.113.83', { form: connForm('obr_nope') });
  assert.equal(tokOpen.body.error, 'invalid_grant', 'open connector: authenticated from anywhere, then the grant is checked');

  // Editing an IP-less key where an IP is mandatory: 400 ipRequired (a narrowing edit is never blocked).
  await db('tenants').where({ id: A }).update({ key_require_ip: true });
  await assert.rejects(apiKeysService.update(fakeReq(OWNER), owner, acct, OPEN.id, { name: 'open-renamed' }), (e: { code?: string }) => e.code === 'ipRequired');
  await apiKeysService.update(fakeReq(OWNER), owner, acct, OPEN.id, { expiresAt: new Date(Date.now() + 2 * 3_600_000).toISOString() });
  const fixed = await apiKeysService.update(fakeReq(OWNER), owner, acct, OPEN.id, { name: 'open-fixed', allowedIps: ['198.51.100.0/24'] });
  assert.equal(fixed.open, false);
  await apiKeysService.update(fakeReq(OWNER), owner, acct, OPEN.id, { allowedIps: [] }).then(
    () => assert.fail('an empty list where one is mandatory'), (e: { code?: string }) => assert.equal(e.code, 'ipRequired'));
  await db('tenants').where({ id: A }).update({ key_require_ip: null });
  await db('api_keys').where({ id: OPEN.id }).update({ allowed_ips: JSON.stringify([]) });
  refresh();

  // A key whose list is too wide keeps the platform in watch mode, and says why.
  const WIDE = await apiKeysService.create(fakeReq(OWNER), owner, acct, { name: 'wide', scopes: ['files.read'], siteScope: 'all', allowedIps: ['11.0.0.0/8'] });
  refresh();
  st = await call('GET', '/api/system/key-security/status', '198.51.100.5');
  assert.deepEqual(st.body.data.openKeys.map((k: { id: number; why: string }) => [k.id, k.why]).sort(), [[CONN.id, 'noIp'], [OPEN.id, 'noIp'], [WIDE.id, 'tooWide']].sort(), 'the IP-less connector counts as open');
  await apiKeysService.remove(fakeReq(OWNER), owner, acct, WIDE.id);
  refresh();

  // "Trust" a CIDR: every platform ban inside the range is lifted, not only its network address.
  await bans.banFromKeySurface({ key: '192.0.2.17', source: 'key-intrusion', permanent: true, reason: 'test' });
  await bans.banFromKeySurface({ key: '192.0.2.200', source: 'key-bruteforce', permanent: false, reason: 'test' });
  const trustNet = await call('POST', '/api/system/key-security/trust', '198.51.100.5', { body: { ip: '192.0.2.0/24' } });
  assert.equal(trustNet.status, 200);
  assert.equal(trustNet.body.data.liftedBans.length, 2);
  assert.equal(await activeBan('192.0.2.17'), undefined);
  assert.equal(await activeBan('192.0.2.200'), undefined);
  // IPv6: lifting an address lifts its /64; a trusted range lifts the /64s inside it.
  await bans.banFromKeySurface({ key: '2001:db8:42:1::/64', source: 'key-intrusion', permanent: true, reason: 'test' });
  assert.deepEqual((await bans.liftPlatformBans('2001:db8:42::/48', { actor: 'cli' })).length, 1);

  // ── settings route: validated, gated by platform.key_security ──
  const put = await call('PUT', '/api/system/key-security', '198.51.100.5', { body: { trustedIps: ['192.0.2.0/24'], maxFailures: 4 } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.data.trustedIps, ['192.0.2.0/24']);
  assert.equal(put.body.data.maxFailures, 4);
  assert.equal((await call('PUT', '/api/system/key-security', '198.51.100.5', { body: { trustedIps: ['nope'] } })).status, 400);
  assert.equal((await call('PUT', '/api/system/key-security', '198.51.100.5', { body: { autoStrictAt: null } })).status, 400);
  await db('tenants').where({ id: MASTER_TENANT_ID }).update({ action_restrictions: JSON.stringify({ 'platform.key_security': 'sensitive' }) });
  const gated = await call('PUT', '/api/system/key-security', '198.51.100.5', { body: { maxFailures: 5 } });
  assert.equal(gated.status, 403, 'an admin without a second factor is refused');
  assert.equal(gated.body.code, 'twoFactorNotEnrolled');
});
