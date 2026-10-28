import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of the Oblimint webmail (migration 021, session store, SSO of
// kind 'oblimint', revocation hooks, mailbox lookup, vacation = the panel's
// autoresponder). PostgreSQL at WEBMAIL_OBLIMINT_TEST_DATABASE_URL (default
// port 55467); skipped cleanly when nothing listens. The engine is a fake
// (testing.ts FakeEngine): the real one is covered by e2e.stalwart.ts.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.WEBMAIL_OBLIMINT_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55467/postgres';

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

test('Oblimint webmail on PostgreSQL', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-wm-db-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'webmail-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../../../db');
  const { errorHandler } = await import('../../../../middleware/errorHandler');
  const routes = (await import('../../../../routes/webmail.routes')).default;
  const { platformSettings } = await import('../../../platformSettings');
  const { appConfigService } = await import('../../../appConfig.service');
  const { setMailDriverForTests } = await import('../../registry');
  const { hashMailPassword } = await import('../../passwords');
  const { webmailService, setWebmailDepsForTests, resetWebmailStateForTests } = await import('../webmail.service');
  const { mailService } = await import('../../mail.service');
  const { dbWebmailSessionStore, hashSessionId } = await import('./session');
  const { findWebmailMailbox, maxUploadBytes, webmailSendAllowed } = await import('./server');
  const { createWebmailAuth } = await import('./auth');
  const { createWebmailApp } = await import('./app');
  const { FakeEngine } = await import('./testing');
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  const caps = { supported: true, mailboxes: true, sieve: true, appPasswordNets: false, quotaUsage: true, queue: true, clamav: false, greylisting: true, passwordSchemes: [] };
  const fakeDriver = (engine: string) => ({ engine, capabilities: caps, imapEndpoint: () => null, submissionEndpoint: () => null, sieveEndpoint: () => null }) as never;
  setMailDriverForTests(fakeDriver('stalwart'));
  let listening = true;
  const syncs: string[] = [];
  setWebmailDepsForTests({
    requestSync: (r) => { syncs.push(r); },
    syncNow: async () => { throw new Error('no engine sync for the Oblimint webmail'); },
    running: async () => false,
    oblimintRunning: () => listening,
  });
  t.after(() => { setMailDriverForTests(null); setWebmailDepsForTests(null); resetWebmailStateForTests(); });

  await appConfigService.set('panel_hostname', 'panel.platform.test');
  await platformSettings.update({ mail: { webmail: 'oblimint', webmailHostname: 'webmail.platform.test', webmailPerDomain: false, maxMessageSizeMb: 30 } } as never);
  platformSettings.invalidate();
  await db('certificates').insert({ primary_name: 'webmail.platform.test', names: JSON.stringify(['webmail.platform.test']), status: 'valid' });

  // ── fixtures ──
  const suffix = Date.now().toString(36);
  const [tenant] = await db('tenants').insert({ name: `W ${suffix}`, slug: `w-${suffix}` }).returning('id');
  const tId = Number(tenant.id ?? tenant);
  const [u] = await db('users').insert({ username: `wm-${suffix}`, kind: 'client', role: 'user', is_active: true }).returning('id');
  const manager = Number(u.id ?? u);
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number };
  const [plan] = await db('plans').insert({ tenant_id: tId, name: `p-${suffix}`, limits: JSON.stringify(DEFAULT_PLAN_LIMITS) }).returning('id');
  const uid = 20000 + Math.floor(Math.random() * 30000);
  const [acctRow] = await db('hosting_accounts').insert({
    tenant_id: tId, node_id: localNode.id, plan_id: Number(plan.id ?? plan), username: `wm${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
  }).returning('id');
  const acct = Number(acctRow.id ?? acctRow);
  await db('account_users').insert({ user_id: manager, account_id: acct, capabilities: JSON.stringify(['mail.manage']) });
  const dom = `exemple-${suffix}.test`;
  const [d] = await db('domains').insert({ tenant_id: tId, account_id: acct, name: dom, verification_status: 'verified' }).returning('id');
  const [md] = await db('mail_domains').insert({ tenant_id: tId, account_id: acct, domain_id: Number(d.id ?? d), name: dom, enabled: true, max_message_size_mb: 10 }).returning('id');
  const mailDomainId = Number(md.id ?? md);
  const mkBox = async (local: string) => {
    const [m] = await db('mailboxes').insert({
      tenant_id: tId, account_id: acct, mail_domain_id: mailDomainId, local_part: local, address: `${local}@${dom}`,
      password_hash: hashMailPassword('Mailbox-Password-1').hash, password_scheme: 'SHA512-CRYPT', enabled: true,
    }).returning('id');
    return Number(m.id ?? m);
  };
  const alice = await mkBox('alice');
  const bob = await mkBox('bob');

  // ── panel route ──
  const panel = express();
  panel.use(express.json());
  panel.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: manager };
    (req as unknown as { tenantId: number }).tenantId = tId;
    next();
  });
  panel.use('/mail', routes);
  panel.use(errorHandler);
  const ps = panel.listen(0, '127.0.0.1');
  await new Promise<void>((r) => ps.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => ps.close(() => r())));
  const pbase = `http://127.0.0.1:${(ps.address() as AddressInfo).port}`;
  const open = async (mailboxId: number) => {
    const res = await fetch(`${pbase}/mail/mailboxes/${mailboxId}/webmail-session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    return { status: res.status, body: await res.json() as { data?: { url: string }; code?: string } };
  };

  await t.test('migration 021: table, FK cascade with the mailbox, method check', async () => {
    assert.ok(await db.schema.hasTable('webmail_sessions'));
    const now = Date.now();
    await dbWebmailSessionStore.insert('a'.repeat(64), {
      mailboxId: bob, accountId: acct, tenantId: tId, address: `bob@${dom}`, jmapAccountId: 'b1', method: 'password', ip: '203.0.113.1', userAgent: 'UA',
      csrf: 'c'.repeat(43), now, expiresAt: now + 3600_000,
    });
    await assert.rejects(db('webmail_sessions').insert({
      sid_hash: 'b'.repeat(64), mailbox_id: bob, account_id: acct, tenant_id: tId, address: 'x', jmap_account_id: 'x', csrf_token: 'x', method: 'magic',
      created_at: new Date(), last_seen_at: new Date(), expires_at: new Date(),
    }));
  });

  await t.test('SSO of kind oblimint: token in the fragment, no app password, no engine sync, audited', async () => {
    syncs.length = 0;
    const r = await open(alice);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const url = new URL(r.body.data!.url);
    assert.equal(url.origin, 'https://webmail.platform.test');
    assert.equal(url.search, '', 'nothing in the query string');
    assert.match(url.hash, /^#sso=[A-Za-z0-9_-]{43}$/);
    assert.equal(await db('mail_app_passwords').where({ mailbox_id: alice }).first(), undefined);
    assert.deepEqual(syncs, []);
    const audit = await db('audit_logs').where({ action: 'mail.webmail.sso', resource_path: String(alice) }).orderBy('id', 'desc').first();
    assert.ok(audit);
    assert.doesNotMatch(JSON.stringify(audit.details), /sso=/);
    const token = url.hash.slice(5);
    // The container endpoint never trades an Oblimint token…
    assert.equal(await webmailService.redeem(token), null);
    // …which consumed it (single use).
    assert.equal(await webmailService.redeemOblimint(token), null);
    const again = new URL((await open(alice)).body.data!.url).hash.slice(5);
    assert.deepEqual(await webmailService.redeemOblimint(again), { mailboxId: alice });
    assert.equal(await webmailService.redeemOblimint(again), null, 'replay');
    // The confirmation screen asks which mailbox a token opens WITHOUT using it.
    const peeked = new URL((await open(alice)).body.data!.url).hash.slice(5);
    assert.deepEqual(await webmailService.peekOblimint(peeked), { mailboxId: alice });
    assert.deepEqual(await webmailService.peekOblimint(peeked), { mailboxId: alice });
    assert.deepEqual(await webmailService.redeemOblimint(peeked), { mailboxId: alice }, 'still usable after the peek');
    assert.equal(await webmailService.peekOblimint(peeked), null, 'used');
    assert.equal(await webmailService.peekOblimint('x'.repeat(43)), null);
  });

  await t.test('SSO refused when the engine is not Stalwart or the listener is down', async () => {
    setMailDriverForTests(fakeDriver('postfix-dovecot'));
    assert.deepEqual([(await open(alice)).status, (await open(alice)).body.code], [409, 'webmailUnavailable']);
    setMailDriverForTests(fakeDriver('stalwart'));
    listening = false;
    assert.equal((await open(alice)).status, 409);
    listening = true;
  });

  await t.test('mailbox lookup for the password login; upload limit = the mail domain size', async () => {
    const row = await findWebmailMailbox({ address: `alice@${dom}` });
    assert.equal(row?.id, alice);
    assert.equal(row?.domainVerified, true);
    assert.equal(row?.accountStatus, 'active');
    assert.match(row!.passwordHash, /^\{SHA512-CRYPT\}/);
    assert.equal(await findWebmailMailbox({ address: `nobody@${dom}` }), null);
    assert.equal(await maxUploadBytes(alice), 10 * 1048576);
  });

  // ── webmail app on the real session store and mailbox rows (fake engine) ──
  const engineBoxes = new Map([[`alice@${dom}`, { password: 'Mailbox-Password-1', jmapAccountId: 'acctA' }], [`bob@${dom}`, { password: 'Mailbox-Password-1', jmapAccountId: 'acctB' }]]);
  const engine = new FakeEngine(new Map([...engineBoxes].map(([a, v]) => [a, { ...v, address: a } as never])));
  const failures: string[] = [];
  const auth = createWebmailAuth({
    store: dbWebmailSessionStore, engine, now: Date.now,
    findMailboxByAddress: (a) => findWebmailMailbox({ address: a }), findMailboxById: (id) => findWebmailMailbox({ id }),
    redeemSso: (tk) => webmailService.redeemOblimint(tk), peekSso: (tk) => webmailService.peekOblimint(tk),
    isBanned: async () => false, recordFailure: (ip) => { failures.push(ip); }, maxUploadBytes,
  });
  const app = createWebmailApp({
    auth, engine, enabled: async () => true, secure: true, clientIp: () => '203.0.113.9', maxUploadBytes, sendAllowed: webmailSendAllowed,
    vacation: {
      get: async (id) => (await db('mailboxes').where({ id }).first('autoresponder'))?.autoresponder ?? null,
      set: (id, v, ip) => mailService.setAutoresponderAsMailbox(id, v, ip),
    },
    clientDist: null, now: Date.now,
  });
  const ws = http.createServer(app);
  await new Promise<void>((r) => ws.listen(0, '127.0.0.1', () => r()));
  t.after(() => new Promise<void>((r) => { ws.close(() => r()); ws.closeAllConnections?.(); }));
  const wbase = `http://127.0.0.1:${(ws.address() as AddressInfo).port}`;
  const origin = wbase.replace('http:', 'https:');
  const session = async () => {
    const s = await fetch(`${wbase}/wm-api/session`);
    return (s.headers.getSetCookie().find((c) => c.startsWith('__Host-oblimint-wm-csrf=')) ?? '').split(';')[0].split('=')[1];
  };
  const post = async (p: string, body: unknown, cookie: string, csrf: string) => fetch(`${wbase}/wm-api${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie, 'X-Oblimint-CSRF': csrf }, body: JSON.stringify(body),
  });

  let aliceCookie = '';
  let aliceCsrf = '';
  await t.test('password login against the panel hash, session row stored hashed', async () => {
    const pre = await session();
    const bad = await post('/login', { address: `alice@${dom}`, password: 'wrong-password' }, `__Host-oblimint-wm-csrf=${pre}`, pre);
    assert.equal(bad.status, 401);
    assert.deepEqual(failures, ['203.0.113.9']);
    const ok = await post('/login', { address: `alice@${dom}`, password: 'Mailbox-Password-1' }, `__Host-oblimint-wm-csrf=${pre}`, pre);
    assert.equal(ok.status, 200);
    const sid = (ok.headers.getSetCookie().find((c) => c.startsWith('__Host-oblimint-wm=')) ?? '').split(';')[0].split('=')[1];
    aliceCookie = `__Host-oblimint-wm=${sid}`;
    aliceCsrf = ((await ok.json()) as { csrf: string }).csrf;
    const row = await db('webmail_sessions').where({ sid_hash: hashSessionId(sid) }).first();
    assert.equal(row.mailbox_id, alice);
    assert.equal(row.jmap_account_id, 'acctA');
    assert.equal(await db('webmail_sessions').where({ sid_hash: sid }).first(), undefined, 'raw id never stored');
  });

  await t.test('vacation = the panel autoresponder (DB, sync requested, audited without the body)', async () => {
    syncs.length = 0;
    const r = await fetch(`${wbase}/wm-api/vacation`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: aliceCookie, 'X-Oblimint-CSRF': aliceCsrf },
      body: JSON.stringify({ enabled: true, subject: 'Away', body: 'Secret body text', intervalDays: 2 }),
    });
    assert.equal(r.status, 200);
    const row = await db('mailboxes').where({ id: alice }).first('autoresponder');
    const ar = typeof row.autoresponder === 'string' ? JSON.parse(row.autoresponder) : row.autoresponder;
    assert.deepEqual([ar.enabled, ar.subject, ar.intervalDays], [true, 'Away', 2]);
    const audit = await db('audit_logs').where({ action: 'mail.mailbox.autoresponder', resource_path: String(alice) }).orderBy('id', 'desc').first();
    assert.ok(audit);
    assert.doesNotMatch(JSON.stringify(audit.details), /Secret body/);
  });

  await t.test('sending allowed = the desired state rule, read at each send (send toggle, outbound suspension, account)', async () => {
    assert.equal(await webmailSendAllowed(alice), true);
    const send = () => post('/jmap', { methodCalls: [
      ['Email/set', { create: { m: { mailboxIds: { d: true }, from: [{ email: `alice@${dom}` }], to: [{ email: `bob@${dom}` }], subject: 'x' } } }, 'e'],
      ['EmailSubmission/set', { create: { s: { identityId: `id-alice@${dom}`, emailId: '#m' } } }, 's'],
    ] }, aliceCookie, aliceCsrf);
    assert.equal((await send()).status, 200);
    // Send toggle off.
    await db('mailboxes').where({ id: alice }).update({ send_enabled: false });
    assert.equal(await webmailSendAllowed(alice), false);
    const r = await send();
    assert.equal(r.status, 403);
    assert.equal(((await r.json()) as { error: string }).error, 'sendDisabled');
    await db('mailboxes').where({ id: alice }).update({ send_enabled: true });
    // Anti-abuse suspension of the account's outbound mail.
    await db('mail_outbound_state').insert({ account_id: acct, tenant_id: tId, status: 'suspended', reason: 'staff', suspended_at: new Date(), suspended_by: 'test' })
      .onConflict('account_id').merge({ status: 'suspended' });
    assert.equal(await webmailSendAllowed(alice), false);
    assert.equal((await send()).status, 403);
    await db('mail_outbound_state').where({ account_id: acct }).update({ status: 'active' });
    assert.equal(await webmailSendAllowed(alice), true);
    assert.equal((await send()).status, 200);
    // Domain disabled / unknown mailbox.
    await db('mail_domains').where({ id: (await db('mailboxes').where({ id: alice }).first('mail_domain_id')).mail_domain_id }).update({ enabled: false });
    assert.equal(await webmailSendAllowed(alice), false);
    await db('mail_domains').where({ id: (await db('mailboxes').where({ id: alice }).first('mail_domain_id')).mail_domain_id }).update({ enabled: true });
    assert.equal(await webmailSendAllowed(999999), false);
  });

  await t.test('the session dies with the mailbox: disabled → refused at once, then revoked by the hook', async () => {
    const ok = await post('/jmap', { methodCalls: [['Mailbox/get', {}, '0']] }, aliceCookie, aliceCsrf);
    assert.equal(ok.status, 200);
    await db('mailboxes').where({ id: alice }).update({ enabled: false });
    assert.equal((await post('/jmap', { methodCalls: [['Mailbox/get', {}, '0']] }, aliceCookie, aliceCsrf)).status, 401, 'lookup re-checks the mailbox');
    await db('mailboxes').where({ id: alice }).update({ enabled: true });
    // Hook path (disabled / password changed): every session of the mailbox removed.
    const now = Date.now();
    await dbWebmailSessionStore.insert('d'.repeat(64), {
      mailboxId: alice, accountId: acct, tenantId: tId, address: `alice@${dom}`, jmapAccountId: 'acctA', method: 'sso', ip: null, userAgent: null,
      csrf: 'e'.repeat(43), now, expiresAt: now + 3600_000,
    });
    webmailService.mailboxChanged(alice, 'password');
    for (let i = 0; i < 40 && (await db('webmail_sessions').where({ mailbox_id: alice }).count<{ n: string }[]>('id as n'))[0].n !== '0'; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(Number((await db('webmail_sessions').where({ mailbox_id: alice }).count<{ n: string }[]>('id as n'))[0].n), 0);
  });

  await t.test('suspended account: sessions refused; deleted mailbox: rows cascade', async () => {
    const now = Date.now();
    await dbWebmailSessionStore.insert('f'.repeat(64), {
      mailboxId: bob, accountId: acct, tenantId: tId, address: `bob@${dom}`, jmapAccountId: 'acctB', method: 'sso', ip: null, userAgent: null,
      csrf: 'g'.repeat(43), now, expiresAt: now + 3600_000,
    });
    await db('hosting_accounts').where({ id: acct }).update({ status: 'suspended' });
    assert.equal((await dbWebmailSessionStore.find('f'.repeat(64)))?.mailboxActive, false);
    await db('hosting_accounts').where({ id: acct }).update({ status: 'active' });
    assert.equal((await dbWebmailSessionStore.find('f'.repeat(64)))?.mailboxActive, true);
    await db('mailboxes').where({ id: bob }).delete();
    assert.equal(await db('webmail_sessions').where({ mailbox_id: bob }).first(), undefined);
  });

  await t.test('sweep: idle and expired rows go', async () => {
    const now = Date.now();
    await dbWebmailSessionStore.insert('9'.repeat(64), {
      mailboxId: alice, accountId: acct, tenantId: tId, address: `alice@${dom}`, jmapAccountId: 'acctA', method: 'sso', ip: null, userAgent: null,
      csrf: 'h'.repeat(43), now: now - 31 * 60_000, expiresAt: now + 3600_000,
    });
    assert.ok(await dbWebmailSessionStore.sweep(now) >= 1);
    assert.equal(await db('webmail_sessions').where({ sid_hash: '9'.repeat(64) }).first(), undefined);
  });
});
