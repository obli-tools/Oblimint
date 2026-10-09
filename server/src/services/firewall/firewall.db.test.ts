import { test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import type { Request } from 'express';
import type { HostdClient, HostdFirewallAccountState, HostdFirewallGlobal } from '../hostd/client';

// ─────────────────────────────────────────────────────────────────────────────
// DB tests of the access allow-list (module hostd-firewall) on PGlite:
//   PG_PORT=55444 node <scratchpad>/pg/pgserver.mjs
// FIREWALL_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. hostd and Docker are fakes (setFirewallBackendsForTests).
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.FIREWALL_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55444/postgres';

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

let sidSeq = 0;
function fakeReq(userId: number, tenantId: number, extra: { ip?: string; mfa?: boolean; username?: string; sid?: string } = {}): Request {
  return {
    session: { userId, username: extra.username ?? `u${userId}`, currentTenantId: tenantId, ...(extra.mfa ? { mfaVerifiedAt: Date.now() } : {}) },
    sessionID: extra.sid ?? `sid-${userId}-${++sidSeq}`,
    tenantId,
    headers: {},
    socket: { remoteAddress: extra.ip ?? '203.0.113.50' },
    query: {}, params: {}, body: {}, method: 'GET', path: '/api/accounts',
  } as unknown as Request;
}

async function rejectsWith(p: Promise<unknown>, status: number, code?: string): Promise<Record<string, unknown> | undefined> {
  try {
    await p;
  } catch (err) {
    const e = err as { statusCode?: number; code?: string; message?: string; details?: Record<string, unknown> };
    assert.equal(e.statusCode, status, `expected HTTP ${status}, got ${e.statusCode} (${e.message})`);
    if (code !== undefined) assert.equal(e.code, code, `expected code ${code}, got ${e.code} (${e.message})`);
    return e.details;
  }
  assert.fail(`expected a ${status}${code ? ` ${code}` : ''} rejection`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('access allow-list on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55444)`);
    return;
  }
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.SESSION_SECRET ||= 'firewall-test-secret-0123456789abcdef';

  const { db } = await import('../../db');
  const { reconcileService } = await import('../docker/reconcile.service');
  const { fileServerService } = await import('../docker/filesrv.service');
  const { edgeService } = await import('../edge/edge.service');
  const { resolveActor } = await import('../hosting/access');
  const { plansService } = await import('../hosting/plans.service');
  const { accountsService } = await import('../hosting/accounts.service');
  const { clientUsersService } = await import('../hosting/clientUsers.service');
  const schema = await import('../../validators/hosting.schema');
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');
  const { sessionHash } = await import('../../utils/sessionHash');
  const fw = await import('./firewall.service');
  const { MAX_BANS_PER_ACCOUNT } = await import('./state');
  const { firewallService, APPLY_ERROR_CLIENT_MESSAGE } = fw;

  mock.method(reconcileService, 'requestAccount', () => {});
  mock.method(reconcileService, 'requestSite', () => {});
  mock.method(edgeService, 'scheduleSync', () => {});
  mock.method(fileServerService, 'applyMode', async () => {});

  // Fake hostd: records the pushed states; `fail` makes applyFirewall throw.
  const pushed: HostdFirewallAccountState[] = [];
  const globals: HostdFirewallGlobal[] = [];
  let fail: Error | null = null;
  const hostd = {
    async applyFirewall(s: HostdFirewallAccountState) { if (fail) throw fail; pushed.push(s); },
    async removeFirewall() {},
    async setFirewallGlobal(g: HostdFirewallGlobal) { globals.push(g); },
    async firewallStatus() { return { backend: 'nftables', accounts: 0, lastApplyAt: null, lastApplyError: null, gatewayListeners: 0, accountIds: [], gatewayAccountIds: [] }; },
    async setGateway() {}, async removeGateway() {}, async gatewayEvents() { return []; },
  } as unknown as HostdClient;
  let now = new Date('2026-10-09T12:00:00Z');
  const lastState = (accountId: number) => [...pushed].reverse().find((s) => s.accountId === accountId);
  const flushSync = async () => { await sleep(700); for (let i = 0; i < 20 && pushed.length === 0; i++) await sleep(100); };

  try {
    await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
    await db.raw('CREATE SCHEMA public');
    await db.migrate.latest();

    const localNode = Number((await db('nodes').where({ is_local: true }).first('id'))?.id ?? 1);
    fw.setFirewallBackendsForTests({
      hostd: () => hostd,
      localNode: async () => localNode,
      docker: async () => { throw new Error('no Docker in tests'); },
      now: () => now,
    });

    const [tA] = await db('tenants').insert({ name: 'Reseller A', slug: 'reseller-a' }).returning('id');
    const [tB] = await db('tenants').insert({ name: 'Reseller B', slug: 'reseller-b' }).returning('id');
    const tenantA = Number(tA.id ?? tA);
    const tenantB = Number(tB.id ?? tB);
    const mkUser = async (username: string, role: 'admin' | 'user', kind: 'staff' | 'client' = 'staff') =>
      Number((await db('users').insert({ username, role, kind, is_active: true, password_hash: 'x' }).returning('id'))[0].id);
    const staffA = await mkUser('staff-a', 'user');
    const staffB = await mkUser('staff-b', 'user');
    await db('user_tenants').insert([{ user_id: staffA, tenant_id: tenantA, role: 'admin' }, { user_id: staffB, tenant_id: tenantB, role: 'admin' }]);
    const asStaffA = () => fakeReq(staffA, tenantA, { ip: '198.51.100.200', mfa: true });
    const actorOf = (req: Request) => resolveActor(req);

    const plan = await plansService.create(asStaffA(), await actorOf(asStaffA()),
      schema.planInputSchema.parse({ name: 'Starter', limits: { ...DEFAULT_PLAN_LIMITS, maxSites: 5 } }));
    const shop = await accountsService.create(asStaffA(), await actorOf(asStaffA()), schema.accountCreateSchema.parse({
      username: 'shop', planId: plan.id,
      owner: { username: 'alice', password: 'correct horse battery', capabilities: ['sites.manage', 'files.manage'] },
    }));
    const other = await accountsService.create(asStaffA(), await actorOf(asStaffA()), schema.accountCreateSchema.parse({ username: 'other', planId: plan.id }));
    const alice = Number((await db('users').where({ username: 'alice' }).first('id')).id);
    const bob = Number((await clientUsersService.add(asStaffA(), await db('hosting_accounts').where({ id: shop.id }).first(),
      schema.clientUserAddSchema.parse({ mode: 'create', username: 'bob', password: 'correct horse battery', capabilities: ['sites.manage'] }))).userId);
    const asAlice = (extra: Parameters<typeof fakeReq>[2] = {}) => fakeReq(alice, tenantA, { username: 'alice', ...extra });
    pushed.length = 0;

    await t.test('access rules: visibility (404), files.manage (403), validation, limit', async () => {
      const a = asAlice();
      const info = await firewallService.getAccess(await actorOf(a), shop.id);
      assert.equal(info.mode, 'open');
      assert.equal(info.grantTtlMinutes, 240);
      assert.deepEqual(info.rules, []);
      await rejectsWith(firewallService.getAccess(await actorOf(a), other.id), 404, 'notFound');
      await rejectsWith(firewallService.addRule(a, await actorOf(a), other.id, { cidr: '203.0.113.1' }), 404, 'notFound');
      // Staff of another tenant: invisible.
      const sb = fakeReq(staffB, tenantB);
      await rejectsWith(firewallService.getAccess(await actorOf(sb), shop.id), 404);
      // Bob reads, but has no files.manage.
      const b = fakeReq(bob, tenantA);
      assert.equal((await firewallService.getAccess(await actorOf(b), shop.id)).accountId, shop.id);
      await rejectsWith(firewallService.addRule(b, await actorOf(b), shop.id, { cidr: '203.0.113.1' }), 403);
      await rejectsWith(firewallService.updateAccess(b, await actorOf(b), shop.id, { mode: 'open' }), 403);

      await rejectsWith(firewallService.addRule(a, await actorOf(a), shop.id, { cidr: 'not-an-ip' }), 400, 'invalidCidr');
      await rejectsWith(firewallService.addRule(a, await actorOf(a), shop.id, { cidr: '10.0.0.0/7' }), 400, 'cidrTooWide');
      await rejectsWith(firewallService.addRule(a, await actorOf(a), shop.id, { cidr: '2001:db8::/16' }), 400, 'cidrTooWide');
      await rejectsWith(firewallService.addRule(a, await actorOf(a), shop.id, { cidr: '203.0.113.1', expiresAt: new Date(now.getTime() + 60_000).toISOString() }), 400, 'validation');
      const rule = await firewallService.addRule(a, await actorOf(a), shop.id, { cidr: '198.51.100.7/24', label: 'Bureau' });
      assert.deepEqual([rule.cidr, rule.label, rule.createdBy], ['198.51.100.0/24', 'Bureau', 'alice']);
      await rejectsWith(firewallService.addRule(a, await actorOf(a), shop.id, { cidr: '198.51.100.0/24' }), 409, 'ruleExists');
      assert.equal(await db('audit_logs').where({ action: 'access.rule_add', tenant_id: tenantA }).count('* as c').first().then((r) => Number((r as { c: string }).c)), 1);

      // Another account's rule cannot be deleted through this one.
      const [foreign] = await db('access_rules').insert({ account_id: other.id, cidr: '192.0.2.1' }).returning('id');
      await rejectsWith(firewallService.deleteRule(a, await actorOf(a), shop.id, Number(foreign.id)), 404);
      assert.ok(await db('access_rules').where({ id: foreign.id }).first());
      await db('access_rules').where({ id: foreign.id }).del();

      // 100 rules per account.
      await db('access_rules').insert(Array.from({ length: 99 }, (_, i) => ({ account_id: shop.id, cidr: `10.9.${Math.floor(i / 250)}.${i}` })));
      await rejectsWith(firewallService.addRule(a, await actorOf(a), shop.id, { cidr: '203.0.113.99' }), 409, 'ruleLimit');
      await db('access_rules').where({ account_id: shop.id }).andWhereLike('cidr', '10.9.%').del();
    });

    await t.test('lockoutRisk: allowlist without any rule needs confirm', async () => {
      const [acct] = [other];
      const req = asStaffA();
      const details = await rejectsWith(firewallService.updateAccess(req, await actorOf(req), acct.id, { mode: 'allowlist' }), 409, 'lockoutRisk');
      assert.equal(details?.confirm, true);
      assert.deepEqual(details?.sessionIps, ['198.51.100.200']);
      assert.equal((await db('hosting_accounts').where({ id: acct.id }).first('access_mode')).access_mode, 'open');
      const info = await firewallService.updateAccess(req, await actorOf(req), acct.id, { mode: 'allowlist', confirm: true });
      assert.equal(info.mode, 'allowlist');
      assert.equal(info.applied, false, 'pending until hostd applied it');
      const audit = await db('audit_logs').where({ action: 'access.mode', tenant_id: tenantA }).first('details');
      assert.ok(JSON.stringify(audit.details).includes('allowlist'));
      // With a rule, no confirmation is needed.
      await firewallService.updateAccess(req, await actorOf(req), acct.id, { mode: 'open' });
      await firewallService.addRule(req, await actorOf(req), acct.id, { cidr: '192.0.2.0/24' });
      assert.equal((await firewallService.updateAccess(req, await actorOf(req), acct.id, { mode: 'allowlist' })).mode, 'allowlist');
    });

    await t.test('state pushed to hostd, apply result persisted', async () => {
      pushed.length = 0;
      firewallService.requestSync(other.id, 'test');
      await flushSync();
      const st = lastState(other.id);
      assert.ok(st, 'state pushed');
      assert.equal(st!.mode, 'allowlist');
      assert.ok(st!.allow.some((a) => a.cidr === '192.0.2.0/24'));
      const row = await db('hosting_accounts').where({ id: other.id }).first('access_applied_at', 'access_apply_error');
      assert.ok(row.access_applied_at);
      assert.equal(row.access_apply_error, null);
      const req = asStaffA();
      assert.equal((await firewallService.getAccess(await actorOf(req), other.id)).applied, true);

      fail = new Error('nft -f: syntax error');
      firewallService.requestSync(other.id, 'test');
      await sleep(900);
      fail = null;
      const err = await db('hosting_accounts').where({ id: other.id }).first('access_apply_error');
      assert.match(err.access_apply_error, /nft -f/);
      const failed = await firewallService.getAccess(await actorOf(req), other.id);
      assert.equal(failed.applied, false);
      assert.match(failed.applyError ?? '', /nft -f/, 'staff sees the hostd text (W1)');
      // A client user sees that it failed, never the backend text (A6).
      const saved = (await db('hosting_accounts').where({ id: shop.id }).first('access_apply_error')).access_apply_error;
      await db('hosting_accounts').where({ id: shop.id }).update({ access_apply_error: 'nft -f /run/oblimint/x: syntax error' });
      const asClient = await firewallService.getAccess(await actorOf(asAlice()), shop.id);
      assert.equal(asClient.applyError, APPLY_ERROR_CLIENT_MESSAGE);
      await db('hosting_accounts').where({ id: shop.id }).update({ access_apply_error: saved ?? null });
    });

    await t.test('auto-2fa grants: only for a CLIENT session that passed 2FA, on its own accounts', async () => {
      const req = asAlice({ mfa: true });
      await firewallService.updateAccess(req, await actorOf(req), shop.id, { mode: 'auto-2fa', grantTtlMinutes: 60 });
      await firewallService.updateAccess(asStaffA(), await actorOf(asStaffA()), other.id, { mode: 'auto-2fa' });
      // Staff with 2FA: no grant.
      assert.deepEqual(await fw.refreshGrants({ userId: staffA, tenantId: tenantA, sessionHash: 'f'.repeat(64), ips: [{ ip: '198.51.100.200', family: 4, source: 'session-2fa' }] }), []);
      // Client: its account only (not `other`), in its tenant only.
      const hash = sessionHash(req.sessionID);
      assert.deepEqual(await fw.refreshGrants({ userId: alice, tenantId: tenantB, sessionHash: hash, ips: [{ ip: '203.0.113.50', family: 4, source: 'session-2fa' }] }), []);
      assert.deepEqual(await fw.refreshGrants({ userId: alice, tenantId: tenantA, sessionHash: hash, ips: [{ ip: '203.0.113.50', family: 4, source: 'session-2fa' }] }), [shop.id]);
      const grants = await db('access_grants').select('account_id', 'user_id', 'ip', 'session_hash', 'expires_at');
      assert.equal(grants.length, 1);
      assert.deepEqual([grants[0].account_id, grants[0].user_id, grants[0].ip, grants[0].session_hash], [shop.id, alice, '203.0.113.50', hash]);
      assert.equal(new Date(grants[0].expires_at).getTime(), now.getTime() + 60 * 60_000);

      // Through the request hook: a session WITHOUT 2FA gets nothing; with 2FA, the seen address (throttled).
      await db('access_grants').del();
      firewallService.onSessionActivity(asAlice({ ip: '203.0.113.60' }));
      const withMfa = asAlice({ mfa: true, ip: '203.0.113.61', sid: 'sess-alice-1' });
      firewallService.onSessionActivity(withMfa);
      await sleep(300);
      assert.deepEqual((await db('access_grants').select('ip')).map((g) => g.ip), ['203.0.113.61']);
      // Throttled for the same (session, address)…
      await db('access_grants').del();
      firewallService.onSessionActivity(asAlice({ mfa: true, ip: '203.0.113.61', sid: 'sess-alice-1' }));
      await sleep(300);
      assert.equal((await db('access_grants').count('* as c').first() as { c: string }).c, '0');
      // …but probed addresses of the session are added (new address set).
      const nonce = fw.issueProbeNonceForTests(sessionHash('sess-alice-1'));
      assert.deepEqual(await firewallService.recordProbe(nonce, '2001:db8:aa::61'), { ip: '2001:db8:aa::61', family: 6 });
      firewallService.onSessionActivity(asAlice({ mfa: true, ip: '203.0.113.61', sid: 'sess-alice-1' }));
      await sleep(300);
      assert.deepEqual((await db('access_grants').orderBy('ip').select('ip', 'family', 'source')).map((g) => `${g.ip}/${g.family}/${g.source}`),
        ['2001:db8:aa::61/6/probe', '203.0.113.61/4/session-2fa']);
      const myIps = await firewallService.myIps(asAlice({ mfa: true, ip: '203.0.113.61', sid: 'sess-alice-1' }));
      assert.deepEqual(myIps, { seen: '203.0.113.61', ipv4: null, ipv6: '2001:db8:aa::61', mfa: true });

      // The state pushed for an auto-2fa account carries the grants.
      pushed.length = 0;
      firewallService.requestSync(shop.id, 'test');
      await flushSync();
      assert.ok(lastState(shop.id)!.allow.some((a) => a.cidr === '203.0.113.61'));

      // Session ended → grants dropped; deleteGrant audited.
      firewallService.onSessionEnded(sessionHash('sess-alice-1'));
      await sleep(300);
      assert.equal((await db('access_grants').count('* as c').first() as { c: string }).c, '0');
      const [g] = await db('access_grants').insert({ account_id: shop.id, user_id: alice, ip: '203.0.113.70', family: 4, expires_at: new Date(now.getTime() + 3_600_000) }).returning('id');
      const a = asAlice();
      await firewallService.deleteGrant(a, await actorOf(a), shop.id, Number(g.id));
      assert.ok(await db('audit_logs').where({ action: 'access.grant_remove' }).first());
      await rejectsWith(firewallService.deleteGrant(a, await actorOf(a), shop.id, Number(g.id)), 404);
    });

    await t.test('allow-my-ips adds the session addresses as rules (once)', async () => {
      const sid = 'sess-alice-2';
      const nonce = fw.issueProbeNonceForTests(sessionHash(sid));
      await firewallService.recordProbe(nonce, '2001:db8:bb::2');
      const req = asAlice({ ip: '203.0.113.80', sid });
      const before = (await db('access_rules').where({ account_id: shop.id })).length;
      const info = await firewallService.allowMyIps(req, await actorOf(req), shop.id);
      const cidrs = info.rules.map((r) => r.cidr);
      assert.ok(cidrs.includes('203.0.113.80') && cidrs.includes('2001:db8:bb::2'), cidrs.join(' '));
      await firewallService.allowMyIps(asAlice({ ip: '203.0.113.80', sid }), await actorOf(req), shop.id);
      assert.equal((await db('access_rules').where({ account_id: shop.id })).length, before + 2);
    });

    await t.test('bans: threshold in the window, IPv6 by /64, never an allowed address', async () => {
      const { banThreshold } = await (await import('../platformSettings')).platformSettings.section('access');
      let ban = null;
      for (let i = 0; i < banThreshold; i++) ban = await fw.recordFailure({ accountId: shop.id, service: 'sftp', ip: `2001:db8:cc:dd::${i + 1}`, username: 'shop' });
      assert.ok(ban, 'banned at the threshold');
      assert.deepEqual([ban!.ip, ban!.service, ban!.failures], ['2001:db8:cc:dd::/64', 'sftp', banThreshold]);
      // An address covered by a rule of the account is never banned.
      let none = null;
      for (let i = 0; i < banThreshold + 2; i++) none = await fw.recordFailure({ accountId: shop.id, service: 'db', ip: '198.51.100.9' });
      assert.equal(none, null);
      assert.equal((await db('access_bans').where({ account_id: shop.id })).length, 1);
      // Bans are pushed; unban audited.
      pushed.length = 0;
      firewallService.requestSync(shop.id, 'test');
      await flushSync();
      assert.deepEqual(lastState(shop.id)!.bans.map((b) => b.ip), ['2001:db8:cc:dd::/64']);
      const a = asAlice();
      await firewallService.unban(a, await actorOf(a), shop.id, ban!.id);
      assert.ok(await db('audit_logs').where({ action: 'access.unban' }).first());
      await rejectsWith(firewallService.unban(fakeReq(bob, tenantA), await actorOf(fakeReq(bob, tenantA)), shop.id, ban!.id), 403);
    });

    await t.test('bans: IPv6 /64 rotation widens to the /48; live bans capped below the hostd limit', async () => {
      const { banThreshold } = await (await import('../platformSettings')).platformSettings.section('access');
      await db('access_bans').where({ account_id: shop.id }).del();
      const banOnce = async (ip: string) => {
        let b = null;
        for (let i = 0; i < banThreshold; i++) b = await fw.recordFailure({ accountId: shop.id, service: 'db', ip });
        return b;
      };
      for (let k = 1; k <= fw.V6_WIDEN_AFTER; k++) assert.equal((await banOnce(`2001:db8:77:${k}::1`))!.ip, `2001:db8:77:${k}::/64`);
      const wide = await banOnce('2001:db8:77:99::1');
      assert.equal(wide!.ip, '2001:db8:77::/48', 'the /48 is banned');
      assert.deepEqual((await db('access_bans').where({ account_id: shop.id, service: 'db' })).map((b) => b.ip), ['2001:db8:77::/48'],
        'the covered /64 bans are replaced by it');
      assert.equal(await banOnce('2001:db8:77:1234::5'), null, 'covered by the /48: no new ban');
      await db('access_bans').where({ account_id: shop.id }).del();

      // Cap: the account already holds MAX live bans → the oldest goes, never more than MAX.
      const exp = new Date(now.getTime() + 3_600_000);
      const old = new Date(now.getTime() - 60_000);
      const rows = Array.from({ length: MAX_BANS_PER_ACCOUNT }, (_, i) => ({
        account_id: shop.id, ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, service: 'sftp', expires_at: exp, created_at: old,
      }));
      await db.batchInsert('access_bans', rows, 500);
      const fresh = await banOnce('198.18.0.77');
      assert.ok(fresh);
      assert.equal(Number((await db('access_bans').where({ account_id: shop.id }).count('id as n'))[0].n), MAX_BANS_PER_ACCOUNT);
      assert.ok(await db('access_bans').where({ account_id: shop.id, ip: '198.18.0.77' }).first(), 'the newest is kept');
      assert.ok(MAX_BANS_PER_ACCOUNT < 10_000, 'below hostd maxBanEntries');
      await db('access_bans').where({ account_id: shop.id }).del();
    });

    await t.test('expiry worker: expired rows and grants of ended sessions go', async () => {
      const exp = new Date(now.getTime() + 10 * 60_000);
      await db('access_rules').insert({ account_id: shop.id, cidr: '192.0.2.200', expires_at: exp });
      await db('access_grants').insert([
        { account_id: shop.id, user_id: alice, ip: '203.0.113.90', family: 4, expires_at: exp },
        { account_id: shop.id, user_id: alice, ip: '203.0.113.91', family: 4, expires_at: new Date(now.getTime() + 3_600_000), session_hash: sessionHash('gone') },
        { account_id: shop.id, user_id: alice, ip: '203.0.113.92', family: 4, expires_at: new Date(now.getTime() + 3_600_000), session_hash: sessionHash('alive') },
      ]);
      await db('session').insert({ sid: 'alive', sess: JSON.stringify({}), expire: new Date(now.getTime() + 86_400_000) });
      await db('access_bans').insert({ account_id: shop.id, ip: '203.0.113.93', service: 'sftp', expires_at: exp });
      now = new Date(now.getTime() + 11 * 60_000);
      const affected = await fw.expiryPass();
      assert.deepEqual(affected, [shop.id]);
      assert.equal(await db('access_rules').where({ cidr: '192.0.2.200' }).first(), undefined);
      assert.deepEqual((await db('access_grants').select('ip')).map((g) => g.ip), ['203.0.113.92']);
      assert.equal(await db('access_bans').where({ ip: '203.0.113.93' }).first(), undefined);
    });
  } finally {
    fw.setFirewallBackendsForTests(null);
    firewallService.stop();
    await db.destroy();
  }
});
