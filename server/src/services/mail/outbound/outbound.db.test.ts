import { test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { Request } from 'express';
import type { MailDriver, MailLogEvent, MailQueueEntry } from '../driver';
import type { HostdClient, HostdMailFirewallState } from '../../hostd/client';

// ─────────────────────────────────────────────────────────────────────────────
// DB tests of the outbound-security module on PGlite:
//   PG_PORT=55465 node <scratchpad>/pg/pgserver.mjs
// OUTBOUND_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. Docker, hostd and the mail engine are fakes; files go to a temp dir.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.OUTBOUND_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55465/postgres';

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

function fakeReq(userId: number, tenantId: number, username = `u${userId}`): Request {
  return {
    session: { userId, username, currentTenantId: tenantId, mfaVerifiedAt: Date.now() },
    sessionID: `sid-${userId}-${Math.random()}`,
    tenantId,
    headers: {},
    socket: { remoteAddress: '198.51.100.200' },
    query: {}, params: {}, body: {}, method: 'POST', path: '/api/mail',
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

test('outbound + security on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55465)`);
    return;
  }
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_MAIL_WORKERS = 'off';
  process.env.SESSION_SECRET ||= 'outbound-test-secret-0123456789abcdef';

  const { db } = await import('../../../db');
  const { reconcileService } = await import('../../docker/reconcile.service');
  const { fileServerService } = await import('../../docker/filesrv.service');
  const { edgeService } = await import('../../edge/edge.service');
  const { resolveActor } = await import('../../hosting/access');
  const { plansService } = await import('../../hosting/plans.service');
  const { accountsService } = await import('../../hosting/accounts.service');
  const { hostingLayout } = await import('../../hosting/paths');
  const schema = await import('../../../validators/hosting.schema');
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');
  const { platformSettings } = await import('../../platformSettings');
  const { setMailDriverForTests } = await import('../registry');
  const { mailService } = await import('../mail.service');
  const relaySync = await import('./relaySync');
  const { relayService } = await import('./relay.service');
  const outbound = await import('./outbound.service');
  const { outboundService } = outbound;
  const security = await import('../security/mailSecurity.service');
  const { mailSecurityService } = security;

  mock.method(reconcileService, 'requestAccount', () => {});
  mock.method(reconcileService, 'requestSite', () => {});
  mock.method(edgeService, 'scheduleSync', () => {});
  mock.method(fileServerService, 'applyMode', async () => {});
  const syncRequests: string[] = [];
  mock.method(mailService, 'requestSync', (reason: string) => { syncRequests.push(reason); });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-outbound-'));
  const layout = hostingLayout(tmp);
  const noDocker = async () => { throw new Error('no Docker in tests'); };
  relaySync.setRelaySyncBackendsForTests({ paths: layout, docker: noDocker });

  // Fake engine: queue, log parser, relay target.
  let queueEntries: MailQueueEntry[] = [];
  const queueActions: string[] = [];
  const driver = {
    engine: 'postfix-dovecot',
    capabilities: { supported: true, mailboxes: true, sieve: true, appPasswordNets: true, quotaUsage: true, queue: true, clamav: true, greylisting: true, passwordSchemes: [] },
    async queue() { return queueEntries; },
    async queueAction(id: string, action: string) { queueActions.push(`${action}:${id}`); },
    logContainers: () => ['oblimint-mail'],
    parseLogLine: (_c: string, line: string): MailLogEvent | null => {
      try { return JSON.parse(line) as MailLogEvent; } catch { return null; }
    },
    relayTarget: () => ({ host: 'oblimint-mail', port: 10025, tls: 'none' }),
  } as unknown as MailDriver;
  setMailDriverForTests(driver);
  let now = new Date();
  let driverFail = false;
  outbound.setOutboundBackendsForTests({
    docker: noDocker,
    driver: async () => { if (driverFail) throw new Error('engine unavailable'); return driver; },
    now: () => now,
  });

  const pushed: HostdMailFirewallState[] = [];
  let hostdFail: Error | null = null;
  const hostd = {
    async setMailFirewall(s: HostdMailFirewallState) { if (hostdFail) throw hostdFail; pushed.push(s); },
  } as unknown as HostdClient;
  security.setMailSecurityBackendsForTests({
    hostd: async () => hostd,
    docker: noDocker,
    now: () => now,
    relayTestTarget: async () => null,
  });

  try {
    await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
    await db.raw('CREATE SCHEMA public');
    await db.migrate.latest();
    await db('app_config').insert([{ key: 'public_ipv4', value: '203.0.113.5' }]).onConflict('key').merge();
    platformSettings.invalidate();

    const [tA] = await db('tenants').insert({ name: 'Reseller A', slug: 'reseller-a' }).returning('id');
    const [tB] = await db('tenants').insert({ name: 'Reseller B', slug: 'reseller-b' }).returning('id');
    const tenantA = Number(tA.id ?? tA);
    const tenantB = Number(tB.id ?? tB);
    const mkUser = async (username: string, role: 'admin' | 'user', kind: 'staff' | 'client' = 'staff') =>
      Number((await db('users').insert({ username, role, kind, is_active: true, password_hash: 'x' }).returning('id'))[0].id);
    const root = await mkUser('root', 'admin');
    const staffA = await mkUser('staff-a', 'user');
    const staffB = await mkUser('staff-b', 'user');
    await db('user_tenants').insert([{ user_id: staffA, tenant_id: tenantA, role: 'admin' }, { user_id: staffB, tenant_id: tenantB, role: 'admin' }]);
    const asRoot = () => fakeReq(root, 1, 'root');
    const asStaffA = () => fakeReq(staffA, tenantA, 'staff-a');
    const asStaffB = () => fakeReq(staffB, tenantB, 'staff-b');
    const actorOf = (req: Request) => resolveActor(req);

    const planA = await plansService.create(asStaffA(), await actorOf(asStaffA()),
      schema.planInputSchema.parse({ name: 'Mail', limits: { ...DEFAULT_PLAN_LIMITS, maxSites: 5, mailSiteOutboundPerHour: 100, mailOutboundPerHour: 300 } }));
    const shop = await accountsService.create(asStaffA(), await actorOf(asStaffA()), schema.accountCreateSchema.parse({
      username: 'shop', planId: planA.id,
      owner: { username: 'alice', password: 'correct horse battery', capabilities: ['mail.manage', 'sites.manage'] },
    }));
    const other = await accountsService.create(asStaffA(), await actorOf(asStaffA()), schema.accountCreateSchema.parse({
      username: 'other', planId: planA.id,
      owner: { username: 'bob', password: 'correct horse battery', capabilities: ['sites.manage'] },
    }));
    const planB = await plansService.create(asStaffB(), await actorOf(asStaffB()), schema.planInputSchema.parse({ name: 'B', limits: { ...DEFAULT_PLAN_LIMITS } }));
    const foreign = await accountsService.create(asStaffB(), await actorOf(asStaffB()), schema.accountCreateSchema.parse({ username: 'foreign', planId: planB.id }));
    for (const a of [shop, other, foreign]) await db('hosting_accounts').where({ id: a.id }).update({ status: 'active' });
    const alice = Number((await db('users').where({ username: 'alice' }).first('id')).id);
    const bob = Number((await db('users').where({ username: 'bob' }).first('id')).id);
    const asAlice = () => fakeReq(alice, tenantA, 'alice');
    const asBob = () => fakeReq(bob, tenantA, 'bob');

    // Domains (verified) + mail domains + sites (direct rows: other modules' services are not under test).
    const mkDomain = async (acc: { id: number; tenantId: number }, name: string, verified = true) => {
      const [d] = await db('domains').insert({ tenant_id: acc.tenantId, account_id: acc.id, name, verification_status: verified ? 'verified' : 'pending' }).returning('id');
      const domainId = Number(d.id ?? d);
      const [md] = await db('mail_domains').insert({ tenant_id: acc.tenantId, account_id: acc.id, domain_id: domainId, name }).returning('id');
      return Number(md.id ?? md);
    };
    const mkSite = async (acc: { id: number; tenantId: number }, slug: string) => {
      const [s] = await db('sites').insert({ tenant_id: acc.tenantId, account_id: acc.id, name: slug, slug, base: 'apache-php8.3', status: 'active' }).returning('id');
      const id = Number(s.id ?? s);
      fs.mkdirSync(layout.runtime(acc.id, id), { recursive: true });
      return id;
    };
    await mkDomain(shop, 'exemple.fr');
    await mkDomain(shop, 'pending.fr', false);
    await mkDomain(other, 'autre.fr');
    await mkDomain(foreign, 'etranger.fr');
    const shopSite = await mkSite(shop, 'wp');
    const shopSite2 = await mkSite(shop, 'shop2');
    const otherSite = await mkSite(other, 'blog');
    const foreignSite = await mkSite(foreign, 'x');
    const [mb] = await db('mailboxes').insert({
      tenant_id: shop.tenantId, account_id: shop.id, mail_domain_id: (await db('mail_domains').where({ name: 'exemple.fr' }).first('id')).id,
      local_part: 'contact', address: 'contact@exemple.fr', password_hash: '{SHA512-CRYPT}$6$x$y', password_scheme: 'SHA512-CRYPT',
    }).returning('id');
    const mailboxId = Number(mb.id ?? mb);
    const relayConf = path.join(tmp, 'mail', 'relay', 'config');
    const readMsmtprc = (accId: number, siteId: number) => {
      const f = layout.siteMsmtprc(accId, siteId);
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
    };

    await t.test('site relays: rows, msmtprc, relay files (MA3, MA4)', async () => {
      await relaySync.syncAccountRelays(shop.id);
      await relaySync.syncAccountRelays(other.id);
      const rows = await db('mail_site_relays').where({ account_id: shop.id }).orderBy('site_id');
      assert.deepEqual(rows.map((r: { username: string }) => r.username), [`site-${shopSite}`, `site-${shopSite2}`]);
      for (const r of rows) {
        assert.match(r.password_hash, /^\{SHA512-CRYPT\}\$6\$/);
        assert.ok(!r.password_sealed.includes(r.password_hash));
      }
      const conf = readMsmtprc(shop.id, shopSite)!;
      assert.match(conf, /^user site-\d+$/m);
      assert.match(conf, /^from noreply@exemple\.fr$/m, 'pending.fr is not an allowed sender (unverified)');
      if (process.platform !== 'win32') {
        const st = fs.statSync(layout.siteMsmtprc(shop.id, shopSite));
        assert.equal(st.mode & 0o777, 0o640);
      }
      // Relay files: hashes only, the policy lists the account domains.
      await relaySync.writeRelayFiles();
      const passwd = fs.readFileSync(path.join(relayConf, 'passwd'), 'utf8');
      assert.match(passwd, new RegExp(`^site-${shopSite}:\\{SHA512-CRYPT\\}`, 'm'));
      const clear = conf.match(/^password (.+)$/m)![1];
      assert.ok(!passwd.includes(clear) && !fs.readFileSync(path.join(relayConf, 'policy.json'), 'utf8').includes(clear), 'the clear credential never reaches the relay files');
      const policy = JSON.parse(fs.readFileSync(path.join(relayConf, 'policy.json'), 'utf8'));
      assert.deepEqual(policy.accounts[String(shop.id)].domains, ['exemple.fr']);
      assert.equal(policy.users[`site-${shopSite}`].perHour, 100);
      assert.match(fs.readFileSync(path.join(relayConf, 'postfix.cf'), 'utf8'), /^relayhost = \[oblimint-mail\]:10025$/m);
      // Engine target unreadable: never fail open to direct delivery (last postfix.cf kept).
      {
        const d = driver as unknown as { relayTarget: () => unknown };
        const real = d.relayTarget;
        d.relayTarget = () => { throw new Error('app_config read failed'); };
        try {
          await relaySync.writeRelayFiles();
          assert.match(fs.readFileSync(path.join(relayConf, 'postfix.cf'), 'utf8'), /^relayhost = \[oblimint-mail\]:10025$/m);
          relaySync.setRelaySyncBackendsForTests({ paths: layout, docker: noDocker }); // forgets lastFiles
          fs.rmSync(path.join(relayConf, 'postfix.cf'));
          await relaySync.writeRelayFiles();
          assert.match(fs.readFileSync(path.join(relayConf, 'postfix.cf'), 'utf8'), /^relayhost = \[127\.0\.0\.1\]:1$/m, 'nothing known: mail held');
        } finally {
          d.relayTarget = real;
        }
        await relaySync.writeRelayFiles();
        assert.match(fs.readFileSync(path.join(relayConf, 'postfix.cf'), 'utf8'), /^relayhost = \[oblimint-mail\]:10025$/m);
      }

      // API: never the credential; access rules.
      const list = await relayService.listForAccount(await actorOf(asAlice()), shop.id);
      assert.equal(list.length, 2);
      assert.ok(!JSON.stringify(list).includes(clear) && !JSON.stringify(list).includes('SHA512'));
      assert.deepEqual(list[0].allowedSenders, ['noreply@exemple.fr', '@exemple.fr']);
      assert.equal(list.find((r) => r.siteId === shopSite)!.configured, true);
      await rejectsWith(relayService.listForAccount(await actorOf(asAlice()), other.id), 404);
      await rejectsWith(relayService.get(await actorOf(asAlice()), foreignSite), 404);
      await rejectsWith(relayService.get(await actorOf(asStaffB()), shopSite), 404);
      // bob reads his site but cannot change it (no mail.manage).
      assert.equal((await relayService.get(await actorOf(asBob()), otherSite)).siteId, otherSite);
      await rejectsWith(relayService.update(asBob(), await actorOf(asBob()), otherSite, { enabled: false }), 403);
    });

    await t.test('site relay update / rotate: sender rules, plan limit, audit', async () => {
      const actor = await actorOf(asAlice());
      await rejectsWith(relayService.update(asAlice(), actor, shopSite, { defaultSender: 'boss@autre.fr' }), 400, 'senderNotAllowed');
      await rejectsWith(relayService.update(asAlice(), actor, shopSite, { defaultSender: 'x@pending.fr' }), 400, 'senderNotAllowed');
      await rejectsWith(relayService.update(asAlice(), actor, shopSite, { perHour: 101 }), 409, 'planLimit');
      const before = readMsmtprc(shop.id, shopSite)!;
      const r = await relayService.update(asAlice(), actor, shopSite, { defaultSender: 'Shop@Exemple.fr', perHour: 20 });
      assert.equal(r.defaultSender, 'shop@exemple.fr');
      assert.equal(r.perHour, 20);
      assert.match(readMsmtprc(shop.id, shopSite)!, /^from shop@exemple\.fr$/m);
      assert.equal(JSON.parse(fs.readFileSync(path.join(relayConf, 'policy.json'), 'utf8')).users[`site-${shopSite}`].perHour, 20);
      assert.ok(await db('audit_logs').where({ action: 'mail.relay.update', tenant_id: tenantA }).first());

      const pw = (s: string) => s.match(/^password (.+)$/m)![1];
      const oldHash = (await db('mail_site_relays').where({ site_id: shopSite }).first()).password_hash;
      await relayService.rotate(asAlice(), actor, shopSite);
      const after = readMsmtprc(shop.id, shopSite)!;
      assert.notEqual(pw(after), pw(before));
      assert.notEqual((await db('mail_site_relays').where({ site_id: shopSite }).first()).password_hash, oldHash);
      const audit = await db('audit_logs').where({ action: 'mail.relay.rotate' }).first();
      assert.ok(audit && !JSON.stringify(audit).includes(pw(after)), 'audited, without the credential');

      // Disabled for one site → its file disappears, it leaves the passwd-file.
      await relayService.update(asAlice(), actor, shopSite2, { enabled: false });
      assert.equal(readMsmtprc(shop.id, shopSite2), null);
      assert.doesNotMatch(fs.readFileSync(path.join(relayConf, 'passwd'), 'utf8'), new RegExp(`^site-${shopSite2}:`, 'm'));
      await relayService.update(asAlice(), actor, shopSite2, { enabled: true });
      assert.ok(readMsmtprc(shop.id, shopSite2));
    });

    await t.test('relay off: setting, account suspension', async () => {
      await db('hosting_accounts').where({ id: shop.id }).update({ status: 'suspended' });
      await relaySync.syncAccountRelays(shop.id);
      assert.equal(readMsmtprc(shop.id, shopSite), null, 'suspended account: no msmtprc');
      await db('hosting_accounts').where({ id: shop.id }).update({ status: 'active' });
      await relaySync.syncAccountRelays(shop.id);
      assert.ok(readMsmtprc(shop.id, shopSite));

      await platformSettings.update({ mail: { siteRelay: false } });
      await relaySync.syncAccountRelays(shop.id);
      assert.equal(readMsmtprc(shop.id, shopSite), null, 'setting off: no msmtprc');
      await rejectsWith(relayService.update(asAlice(), await actorOf(asAlice()), shopSite, { perHour: 10 }), 409, 'relayDisabled');
      assert.deepEqual((await outboundService.relayTrust()).relayAddresses, []);
      await platformSettings.update({ mail: { siteRelay: true } });
      await relaySync.syncAccountRelays(shop.id);
      assert.ok(readMsmtprc(shop.id, shopSite));
    });

    await t.test('outbound state: info / suspend / resume (staff only), send policy, relay policy', async () => {
      const info = await outboundService.info(await actorOf(asAlice()), shop.id);
      assert.equal(info.status, 'active');
      assert.equal(info.perHourLimit, 300);
      await rejectsWith(outboundService.info(await actorOf(asAlice()), other.id), 404);
      await rejectsWith(outboundService.suspend(asAlice(), await actorOf(asAlice()), shop.id, { reason: 'x' }), 403);
      await rejectsWith(outboundService.suspend(asStaffB(), await actorOf(asStaffB()), shop.id, {}), 404);

      const s = await outboundService.suspend(asStaffA(), await actorOf(asStaffA()), shop.id, { reason: 'Plainte reçue' });
      assert.deepEqual([s.status, s.reason, s.suspendedBy], ['suspended', 'staff', 'staff-a']);
      assert.ok(syncRequests.length > 0, 'engine sync requested');
      assert.equal((await outboundService.sendPolicy()).get(shop.id)?.suspended, true);
      assert.equal((await outboundService.sendPolicy()).get(other.id)?.suspended, false);
      await relaySync.writeRelayFiles();
      assert.equal(JSON.parse(fs.readFileSync(path.join(relayConf, 'policy.json'), 'utf8')).accounts[String(shop.id)].suspended, true);
      assert.ok(await db('audit_logs').where({ action: 'mail.outbound.suspend', tenant_id: tenantA }).first());

      await rejectsWith(outboundService.resume(asAlice(), await actorOf(asAlice()), shop.id), 403);
      const r = await outboundService.resume(asStaffA(), await actorOf(asStaffA()), shop.id);
      assert.equal(r.status, 'active');
      assert.ok(await db('audit_logs').where({ action: 'mail.outbound.resume' }).first());

      // Account suspended (hosting): reported as such.
      await db('hosting_accounts').where({ id: other.id }).update({ status: 'suspended' });
      assert.equal((await outboundService.info(await actorOf(asStaffA()), other.id)).reason, 'accountSuspended');
      await db('hosting_accounts').where({ id: other.id }).update({ status: 'active' });
    });

    await t.test('mail log: ingestion, attribution, scoping (MA5), client detail masked (A6)', async () => {
      await db('mail_log').del();
      const at = new Date().toISOString();
      const ev = (e: Partial<MailLogEvent>) => JSON.stringify({ type: 'delivery', at, direction: 'outbound', event: 'delivered', queueId: 'Q1', messageId: null, sender: null, recipient: null, sizeBytes: 10, saslUser: null, detail: '250 2.0.0 OK id=secret-engine-text', remote: 'mx.example', ...e });
      outbound.ingestMailLogLine('oblimint-mail', ev({ sender: 'contact@exemple.fr', recipient: 'a@gmail.com', saslUser: 'contact@exemple.fr' }));
      outbound.ingestMailLogLine('oblimint-mail', ev({ sender: 'boss@autre.fr', recipient: 'a@gmail.com' }));
      outbound.ingestMailLogLine('oblimint-mail', ev({ direction: 'inbound', sender: 'x@gmail.com', recipient: 'nobody@unknown.example' }));
      outbound.ingestMailLogLine('oblimint-mail', 'garbage line');
      outbound.ingestMailLogLine('oblimint-mail-relay', JSON.stringify({ type: 'decision', at, stage: 'end-of-message', decision: 'accept', user: `site-${shopSite}`, site: shopSite, account: shop.id, sender: 'shop@exemple.fr', recipients: 2, size: 500, queueId: 'R1' }));
      assert.equal(await outbound.flushMailLog(), 4);

      const aliceLogs = await outboundService.logs(await actorOf(asAlice()), { limit: 50, offset: 0 });
      assert.equal(aliceLogs.total, 2);
      assert.ok(aliceLogs.items.every((i) => i.accountId === shop.id));
      assert.ok(aliceLogs.items.every((i) => !i.detail || !i.detail.includes('secret-engine-text')), 'engine text hidden from clients');
      const relayRow = aliceLogs.items.find((i) => i.direction === 'relay')!;
      assert.equal(relayRow.siteId, shopSite);
      assert.equal(aliceLogs.items.find((i) => i.direction === 'outbound')!.mailboxId, mailboxId);
      // Filters.
      assert.equal((await outboundService.logs(await actorOf(asAlice()), { siteId: shopSite, limit: 50, offset: 0 })).total, 1);
      assert.equal((await outboundService.logs(await actorOf(asAlice()), { q: 'shop@', limit: 50, offset: 0 })).total, 1);
      assert.equal((await outboundService.logs(await actorOf(asAlice()), { q: '%', limit: 50, offset: 0 })).total, 0, 'LIKE wildcards escaped');
      await rejectsWith(outboundService.logs(await actorOf(asAlice()), { accountId: other.id, limit: 50, offset: 0 }), 404);
      // bob (other account) sees his row only; tenant B staff sees nothing of A.
      assert.deepEqual((await outboundService.logs(await actorOf(asBob()), { limit: 50, offset: 0 })).items.map((i) => i.sender), ['boss@autre.fr']);
      assert.equal((await outboundService.logs(await actorOf(asStaffB()), { limit: 50, offset: 0 })).total, 0);
      // Tenant staff: its accounts with the engine text; platform admin: everything, unattributed included.
      const staffLogs = await outboundService.logs(await actorOf(asStaffA()), { limit: 50, offset: 0 });
      assert.equal(staffLogs.total, 3);
      assert.ok(staffLogs.items.some((i) => i.detail?.includes('secret-engine-text')));
      assert.equal((await outboundService.logs(await actorOf(asRoot()), { limit: 50, offset: 0 })).total, 4);

      // Auth failures: logged + ban source.
      for (let i = 0; i < 2; i++) outbound.ingestMailLogLine('oblimint-mail', JSON.stringify({ type: 'authFailure', at, service: 'imap', ip: '203.0.113.77', username: 'contact@exemple.fr' }));
      await outbound.flushMailLog();
      const fails = await outboundService.logs(await actorOf(asAlice()), { event: 'authFailed', limit: 50, offset: 0 });
      assert.equal(fails.total, 2);
      assert.equal(fails.items[0].remote, '203.0.113.77');

      // Engine / database outage at flush time: the lines are kept (not lost),
      // the follower's checkpoint is held back before them, retried later.
      driverFail = true;
      outbound.ingestMailLogLine('oblimint-mail', ev({ queueId: 'Q9', sender: 'contact@exemple.fr', recipient: 'z@gmail.com' }));
      outbound.ingestMailLogLine('oblimint-mail', JSON.stringify({ type: 'authFailure', at, service: 'imap', ip: '203.0.113.78', username: 'contact@exemple.fr' }));
      assert.equal(await outbound.flushMailLog(), 0);
      assert.notEqual(outbound.unpersistedFloor('oblimint-mail'), null);
      assert.equal(outbound.unpersistedFloor('oblimint-mail-relay'), null);
      assert.equal(outbound.cappedCheckpoint('oblimint-mail', '9999999999.000000000').capped, true);
      assert.equal(outbound.cappedCheckpoint('oblimint-mail', '1.000000000').capped, false);
      driverFail = false;
      assert.equal(await outbound.flushMailLog(), 2);
      assert.equal(outbound.unpersistedFloor('oblimint-mail'), null);
      assert.equal((await outboundService.logs(await actorOf(asAlice()), { event: 'authFailed', limit: 50, offset: 0 })).total, 3);

      // Retention.
      await db('mail_log').insert({ at: new Date(Date.now() - 40 * 86400_000), direction: 'outbound', event: 'delivered', engine: 'postfix-dovecot' });
      assert.equal(await outbound.purgeMailLog(), 1);
    });

    await t.test('queue: strict attribution (forged sender), scoping, actions (404 queueItemNotFound)', async () => {
      queueEntries = [
        { queueId: 'AAA111', sender: 'contact@exemple.fr', recipients: ['a@gmail.com'], sizeBytes: 100, arrivedAt: new Date().toISOString(), status: 'deferred', reason: 'connect to gmail: timeout (raw)', attempts: 2, nextAttemptAt: null },
        { queueId: 'BBB222', sender: 'boss@autre.fr', recipients: ['b@gmail.com'], sizeBytes: 100, arrivedAt: new Date().toISOString(), status: 'active', reason: null, attempts: 0, nextAttemptAt: null },
        { queueId: 'CCC333', sender: '', recipients: ['c@gmail.com'], sizeBytes: 100, arrivedAt: new Date().toISOString(), status: 'deferred', reason: 'bounce', attempts: 1, nextAttemptAt: null },
        { queueId: 'DDD444', sender: 'x@etranger.fr', recipients: ['d@gmail.com'], sizeBytes: 100, arrivedAt: new Date().toISOString(), status: 'hold', reason: null, attempts: 0, nextAttemptAt: null },
        // Inbound to bob's account with a FORGED sender of alice's domain: never alice's (MA5).
        { queueId: 'EEE555', sender: 'contact@exemple.fr', recipients: ['boss@autre.fr'], sizeBytes: 100, arrivedAt: new Date().toISOString(), status: 'deferred', reason: 'quota', attempts: 1, nextAttemptAt: null },
        // Inbound from outside to bob's account: bob's.
        { queueId: 'FFF666', sender: 'x@gmail.com', recipients: ['boss@autre.fr'], sizeBytes: 100, arrivedAt: new Date().toISOString(), status: 'deferred', reason: 'quota', attempts: 1, nextAttemptAt: null },
      ];
      const q = await outboundService.queue(await actorOf(asAlice()), { limit: 50, offset: 0 });
      assert.deepEqual(q.items.map((i) => i.queueId), ['AAA111']);
      assert.ok(!q.items[0].reason?.includes('raw'), 'reason masked for a client');
      assert.deepEqual((await outboundService.queue(await actorOf(asStaffA()), { limit: 50, offset: 0 })).items.map((i) => i.queueId), ['AAA111', 'BBB222', 'FFF666']);
      assert.deepEqual((await outboundService.queue(await actorOf(asBob()), { limit: 50, offset: 0 })).items.map((i) => i.queueId), ['BBB222', 'FFF666']);
      assert.deepEqual((await outboundService.queue(await actorOf(asRoot()), { limit: 50, offset: 0 })).items.map((i) => i.queueId), ['AAA111', 'BBB222', 'CCC333', 'DDD444', 'EEE555', 'FFF666']);
      assert.deepEqual((await outboundService.queue(await actorOf(asRoot()), { accountId: other.id, limit: 50, offset: 0 })).items.map((i) => i.queueId), ['BBB222', 'FFF666']);
      await rejectsWith(outboundService.queueAction(asAlice(), await actorOf(asAlice()), 'EEE555', 'delete'), 404, 'queueItemNotFound');

      await rejectsWith(outboundService.queueAction(asAlice(), await actorOf(asAlice()), 'BBB222', 'delete'), 404, 'queueItemNotFound');
      await rejectsWith(outboundService.queueAction(asAlice(), await actorOf(asAlice()), 'CCC333', 'delete'), 404, 'queueItemNotFound');
      await rejectsWith(outboundService.queueAction(asAlice(), await actorOf(asAlice()), 'NOPE', 'retry'), 404, 'queueItemNotFound');
      await rejectsWith(outboundService.queueAction(asBob(), await actorOf(asBob()), 'BBB222', 'retry'), 403);
      await outboundService.queueAction(asAlice(), await actorOf(asAlice()), 'AAA111', 'retry');
      await outboundService.queueAction(asRoot(), await actorOf(asRoot()), 'CCC333', 'delete');
      assert.deepEqual(queueActions, ['retry:AAA111', 'delete:CCC333']);
      assert.ok(await db('audit_logs').where({ action: 'mail.queue.retry', tenant_id: tenantA }).first());
    });

    await t.test('abuse protection: bounce burst suspends (auto), resume is not undone by the same hour', async () => {
      await db('mail_log').del();
      now = new Date();
      const rows = [];
      for (let i = 0; i < 40; i++) rows.push({ at: now, tenant_id: tenantA, account_id: shop.id, direction: 'outbound', event: i < 30 ? 'delivered' : 'bounced', engine: 'postfix-dovecot' });
      await db('mail_log').insert(rows);
      await platformSettings.update({ mail: { abuseMinMessages: 50, abuseBounceRatePct: 20, abuseAction: 'suspend' } });
      assert.deepEqual(await outbound.abusePass(), [], 'under the volume threshold');
      await db('mail_log').insert(Array.from({ length: 20 }, () => ({ at: now, tenant_id: tenantA, account_id: shop.id, direction: 'outbound', event: 'bounced', engine: 'postfix-dovecot' })));
      assert.deepEqual(await outbound.abusePass(), [shop.id]);
      const st = await db('mail_outbound_state').where({ account_id: shop.id }).first();
      assert.deepEqual([st.status, st.reason, st.suspended_by], ['suspended', 'bounceRate', 'auto']);
      assert.match(st.reason_detail, /60 messages sortants/);
      const audit = await db('audit_logs').where({ action: 'mail.outbound.suspend' }).orderBy('id', 'desc').first();
      assert.equal(audit.user_id, null);
      assert.deepEqual(await outbound.abusePass(), [], 'already suspended');
      now = new Date(now.getTime() + 1000);
      await outboundService.resume(asStaffA(), await actorOf(asStaffA()), shop.id);
      assert.deepEqual(await outbound.abusePass(), [], 'the hour before the resume is not judged again');
    });

    await t.test('bans: threshold, /64, never internal, hostd push, unban, expiry (MA8, W1)', async () => {
      await platformSettings.update({ mail: { authBanThreshold: 3, authBanWindowMinutes: 10, authBanDurationMinutes: 60 } });
      now = new Date('2026-10-09T12:00:00Z');
      const fail = (ip: string) => security.recordMailAuthFailure({ ip, service: 'imap', username: 'contact@exemple.fr' });
      assert.equal(await fail('198.51.100.9'), null);
      assert.equal(await fail('198.51.100.9'), null);
      const ban = await fail('198.51.100.9');
      assert.ok(ban);
      assert.equal(ban.ip, '198.51.100.9');
      assert.equal(ban.service, 'imap');
      assert.equal(ban.expiresAt, '2026-10-09T13:00:00.000Z');
      // IPv6: the /64.
      for (const ip of ['2001:db8:aa:bb::1', '2001:db8:aa:bb::2']) await fail(ip);
      assert.equal((await fail('2001:db8:aa:bb::3'))?.ip, '2001:db8:aa:bb::/64');
      // Never: Docker / private / loopback / the node itself.
      for (const ip of ['172.18.0.3', '10.0.0.8', '127.0.0.1', '203.0.113.5']) {
        for (let i = 0; i < 5; i++) assert.equal(await fail(ip), null, ip);
      }
      assert.equal(await mailSecurityService.activeBanCount(), 2);
      const bans = await mailSecurityService.listBans();
      assert.deepEqual(bans.map((b) => b.ip).sort(), ['198.51.100.9', '2001:db8:aa:bb::/64']);

      await security.pushMailFirewall();
      const last = pushed[pushed.length - 1];
      assert.deepEqual(last.ports, [25, 110, 143, 465, 587, 993, 995, 4190]);
      assert.deepEqual(last.bans.map((b) => b.cidr).sort(), ['198.51.100.9', '2001:db8:aa:bb::/64']);
      // W1: a failed push is visible and thrown.
      hostdFail = new Error('hostd: nft refused');
      await assert.rejects(security.pushMailFirewall());
      assert.equal(security.mailSecurityStatus().lastApplyError, 'hostd: nft refused');
      hostdFail = null;
      await security.pushMailFirewall();
      assert.equal(security.mailSecurityStatus().lastApplyError, null);

      // Unban (audited), expiry.
      const v6 = bans.find((b) => b.ip.includes(':'))!;
      await mailSecurityService.unban(asRoot(), v6.id);
      assert.ok(await db('audit_logs').where({ action: 'mail.unban', tenant_id: 1 }).first());
      await rejectsWith(mailSecurityService.unban(asRoot(), v6.id), 404);
      now = new Date('2026-10-09T13:00:01Z');
      assert.equal(await security.expireMailBans(), 1);
      assert.equal(await mailSecurityService.activeBanCount(), 0);
      // Without a public address the relay test refuses to run.
      await rejectsWith(mailSecurityService.relayTest(asRoot()), 409, 'noPublicAddress');
    });

    await t.test('reconcile hook: queues the account, never throws without Docker', async () => {
      const { mailRelayReconcileHook } = await import('./reconcileHook');
      fs.rmSync(layout.siteMsmtprc(shop.id, shopSite));
      assert.equal(readMsmtprc(shop.id, shopSite), null);
      const state = { account: { ...(await db('hosting_accounts').where({ id: shop.id }).first()), limits: DEFAULT_PLAN_LIMITS }, sites: [] };
      await mailRelayReconcileHook.afterAccountPass({ state, docker: {} as never, report: {} as never } as never);
      await relaySync.relayQueueIdle();
      assert.ok(readMsmtprc(shop.id, shopSite));
    });
  } finally {
    relaySync.stopRelaySync();
    security.stopMailSecurity();
    outbound.setOutboundBackendsForTests(null);
    security.setMailSecurityBackendsForTests(null);
    relaySync.setRelaySyncBackendsForTests(null);
    setMailDriverForTests(null);
    fs.rmSync(tmp, { recursive: true, force: true });
    await db.destroy();
  }
});
