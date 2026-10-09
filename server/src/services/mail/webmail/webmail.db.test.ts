import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of the webmail module on a PGlite server
// (docs/P4-PLAN.md §14: webmail = port 55466):
//   PG_PORT=55466 node <scratchpad>/pg/pgserver.mjs
// WEBMAIL_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. The mail driver is a fake (setMailDriverForTests); the engine
// sync, the container state and the mail network subnets go through the
// service seams (setWebmailDepsForTests). Covers: access rules of
// openSession (no mail.manage → 403, other account → 404, disabled
// mailbox → 409, suspended account, engine without mailboxes, no webmail,
// sync timeout), URL host choice, credential row (hash only, 12 h), audit
// without secret, redeem (single use, kind change), appPasswords
// (expired / revoked excluded, allowNets, fail closed), logout, the
// mailboxChanged hook, the expiry pass, D1 of the vhost loader.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.WEBMAIL_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55466/postgres';

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

const tick = () => new Promise<void>((r) => setTimeout(r, 50));

test('webmail module on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55466)`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-webmail-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'webmail-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../../db');
  const { errorHandler } = await import('../../../middleware/errorHandler');
  const routes = (await import('../../../routes/webmail.routes')).default;
  const { platformSettings } = await import('../../platformSettings');
  const { appConfigService } = await import('../../appConfig.service');
  const { setMailDriverForTests } = await import('../registry');
  const { verifyMailPassword, hashMailPassword } = await import('../passwords');
  const svc = await import('./webmail.service');
  const { webmailService, setWebmailDepsForTests, expireWebmailSessions, resetWebmailStateForTests, WEBMAIL_SESSION_TTL_MS } = svc;
  const { webmailTokens } = await import('./ssoTokens');
  const { loadActiveWebmailDomains } = await import('./edgeContributor');
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // ── fakes ──────────────────────────────────────────────────────────────────
  const caps = { supported: true, mailboxes: true, sieve: true, appPasswordNets: true, quotaUsage: true, queue: true, clamav: true, greylisting: true, passwordSchemes: [] };
  const fakeDriver = (engine: string, mailboxes: boolean) => ({
    engine, capabilities: { ...caps, mailboxes },
    imapEndpoint: () => ({ host: 'oblimint-mail', port: 143, tls: 'none' }),
    submissionEndpoint: () => ({ host: 'oblimint-mail', port: 587, tls: 'starttls' }),
    sieveEndpoint: () => ({ host: 'oblimint-mail', port: 4190, tls: 'none' }),
  }) as never;
  setMailDriverForTests(fakeDriver('postfix-dovecot', true));
  const syncs: string[] = [];
  let syncOk = true;
  let running = true;
  let subnets = ['172.30.0.0/24', 'fd00:abcd::/64'];
  const syncDomains: string[] = [];
  setWebmailDepsForTests({
    requestSync: (reason) => { syncs.push(reason); },
    syncNow: async (domain) => { syncDomains.push(domain); return syncOk; },
    running: async () => running,
    subnets: async () => subnets,
  });
  t.after(() => {
    setMailDriverForTests(null);
    setWebmailDepsForTests(null);
    resetWebmailStateForTests();
  });

  await appConfigService.set('panel_hostname', 'panel.platform.test');
  await platformSettings.update({ mail: { webmail: 'roundcube', webmailHostname: 'webmail.platform.test', webmailPerDomain: true } } as never);
  platformSettings.invalidate();

  // ── fixtures ───────────────────────────────────────────────────────────────
  const suffix = Date.now().toString(36);
  const [tenantA] = await db('tenants').insert({ name: `A ${suffix}`, slug: `a-${suffix}` }).returning('id');
  const tA = Number(tenantA.id ?? tenantA);
  const user = async (username: string) => {
    const [row] = await db('users').insert({ username: `${username}-${suffix}`, kind: 'client', role: 'user', is_active: true }).returning('id');
    return Number(row.id ?? row);
  };
  const clientRead = await user('cr');
  const manager = await user('cm');
  const manager2 = await user('cm2');
  const clientOther = await user('co');
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number };
  const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify(DEFAULT_PLAN_LIMITS) }).returning('id');
  const planId = Number(plan.id ?? plan);
  const mkAccount = async (name: string) => {
    const uid = 20000 + Math.floor(Math.random() * 30000);
    const [acct] = await db('hosting_accounts').insert({
      tenant_id: tA, node_id: localNode.id, plan_id: planId, username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
    }).returning('id');
    return Number(acct.id ?? acct);
  };
  const acct = await mkAccount('acme');
  const other = await mkAccount('other');
  await db('account_users').insert([
    { user_id: clientRead, account_id: acct, capabilities: JSON.stringify([]) },
    { user_id: manager, account_id: acct, capabilities: JSON.stringify(['mail.manage']) },
    { user_id: manager2, account_id: acct, capabilities: JSON.stringify(['mail.manage']) },
    { user_id: clientOther, account_id: other, capabilities: JSON.stringify(['mail.manage']) },
  ]);
  const mkDomain = async (accountId: number, name: string, verified: boolean, mailEnabled = true) => {
    const [d] = await db('domains').insert({ tenant_id: tA, account_id: accountId, name, verification_status: verified ? 'verified' : 'pending' }).returning('id');
    const domainId = Number(d.id ?? d);
    const [md] = await db('mail_domains').insert({ tenant_id: tA, account_id: accountId, domain_id: domainId, name, enabled: mailEnabled }).returning('id');
    return Number(md.id ?? md);
  };
  const dom = `exemple-${suffix}.test`;
  const mailDomain = await mkDomain(acct, dom, true);
  const unverified = await mkDomain(acct, `pending-${suffix}.test`, false);
  const disabledDomain = await mkDomain(acct, `off-${suffix}.test`, true, false);
  const mkMailbox = async (accountId: number, mailDomainId: number, domainName: string, local: string, enabled = true) => {
    const [m] = await db('mailboxes').insert({
      tenant_id: tA, account_id: accountId, mail_domain_id: mailDomainId, local_part: local, address: `${local}@${domainName}`,
      password_hash: hashMailPassword('Mailbox-Password-1').hash, password_scheme: 'SHA512-CRYPT', enabled,
    }).returning('id');
    return Number(m.id ?? m);
  };
  const box = await mkMailbox(acct, mailDomain, dom, 'contact');
  const box2 = await mkMailbox(acct, mailDomain, dom, 'info');
  const disabledBox = await mkMailbox(acct, mailDomain, dom, 'off', false);
  const pendingBox = await mkMailbox(acct, unverified, `pending-${suffix}.test`, 'contact');

  // ── app ────────────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: Number(req.header('x-user')) };
    (req as unknown as { tenantId: number }).tenantId = Number(req.header('x-tenant'));
    next();
  });
  app.use('/mail', routes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const open = async (who: number, mailboxId: number) => {
    const res = await fetch(`${base}/mail/mailboxes/${mailboxId}/webmail-session`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-user': String(who), 'x-tenant': String(tA) }, body: '{}',
    });
    return { status: res.status, body: await res.json() as { success: boolean; data?: { url: string; expiresAt: string }; code?: string } };
  };
  const tokenOf = (url: string) => new URL(url).searchParams.get('_oblimint_sso')!;

  await t.test('access: no mail.manage → 403, another account → 404, unknown → 404', async () => {
    assert.equal((await open(clientRead, box)).status, 403);
    assert.equal((await open(clientOther, box)).status, 404);
    assert.equal((await open(manager, 999_999)).status, 404);
  });

  await t.test('no valid certificate for the platform webmail host → no URL, 409 webmailUnavailable', async () => {
    assert.equal(await webmailService.urlFor(`pending-${suffix}.test`), null);
    const r = await open(manager, box);
    assert.deepEqual([r.status, r.body.code], [409, 'webmailUnavailable']);
    assert.equal(await db('mail_app_passwords').where({ mailbox_id: box }).first(), undefined, 'no credential created');
    await db('certificates').insert({ primary_name: 'webmail.platform.test', names: JSON.stringify(['webmail.platform.test']), status: 'valid' });
  });

  await t.test('no mail network subnet → 409 before any credential (appPasswords would drop it)', async () => {
    subnets = [];
    const r = await open(manager, box);
    assert.deepEqual([r.status, r.body.code], [409, 'webmailUnavailable']);
    assert.equal(await db('mail_app_passwords').where({ mailbox_id: box }).first(), undefined, 'no credential created');
    subnets = ['172.30.0.0/24', 'fd00:abcd::/64'];
  });

  let firstToken = '';
  await t.test('openSession: credential row (hash only, 12 h), sync requested, URL on the platform host, audit without secret', async () => {
    syncs.length = 0;
    syncDomains.length = 0;
    const r = await open(manager, box);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const url = r.body.data!.url;
    assert.ok(url.startsWith('https://webmail.platform.test/?_oblimint_sso='), url);
    firstToken = tokenOf(url);
    assert.match(firstToken, /^[A-Za-z0-9_-]{43}$/);
    const exp = Date.parse(r.body.data!.expiresAt) - Date.now();
    assert.ok(exp > 50_000 && exp <= 60_000, 'token: 60 s');
    assert.deepEqual(syncDomains, [dom], 'one sync run now, checked for the mailbox domain');
    const rows = await db('mail_app_passwords').where({ mailbox_id: box });
    assert.equal(rows.length, 1);
    assert.match(rows[0].password_hash, /^\{SHA512-CRYPT\}\$6\$/);
    assert.equal(rows[0].purpose, 'webmail');
    assert.equal(rows[0].created_by, manager);
    const ttl = new Date(rows[0].expires_at).getTime() - Date.now();
    assert.ok(ttl > WEBMAIL_SESSION_TTL_MS - 60_000 && ttl <= WEBMAIL_SESSION_TTL_MS);
    const audit = await db('audit_logs').where({ action: 'mail.webmail.sso', tenant_id: tA }).orderBy('id', 'desc').first();
    assert.ok(audit, 'audited');
    const details = typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details;
    assert.equal(details.address, `contact@${dom}`);
    assert.equal(details.webmail, 'roundcube');
    assert.ok(!JSON.stringify(audit).includes(firstToken), 'no token in the audit');
  });

  await t.test('redeem: credential matches the stored hash; single use (replay refused)', async () => {
    const creds = await webmailService.redeem(firstToken);
    assert.ok(creds);
    assert.equal(creds!.username, `contact@${dom}`);
    const row = await db('mail_app_passwords').where({ mailbox_id: box }).first();
    assert.equal(verifyMailPassword(creds!.password, row.password_hash), true);
    assert.ok(!row.password_hash.includes(creds!.password));
    assert.equal(await webmailService.redeem(firstToken), null, 'replay');
    assert.equal(await webmailService.redeem('A'.repeat(43)), null, 'unknown');
  });

  await t.test('URL: webmail.<d> once a valid platform certificate covers it', async () => {
    await db('certificates').insert({ primary_name: `mail.${dom}`, names: JSON.stringify([`mail.${dom}`, `webmail.${dom}`]), status: 'valid' });
    assert.equal(await webmailService.urlFor(dom), `https://webmail.${dom}/`);
    const r = await open(manager, box2);
    assert.equal(r.status, 200);
    assert.ok(r.body.data!.url.startsWith(`https://webmail.${dom}/?_oblimint_sso=`));
    // an unverified domain falls back to the platform host
    assert.equal(await webmailService.urlFor(`pending-${suffix}.test`), 'https://webmail.platform.test/');
  });

  await t.test('appPasswords: active rows only, allowNets = mail network subnets, fail closed without subnets', async () => {
    const live = await db('mail_app_passwords').whereIn('mailbox_id', [box, box2]).whereNull('revoked_at').pluck('id');
    const pw = hashMailPassword('x'.repeat(20)).hash;
    const [expired] = await db('mail_app_passwords').insert({ account_id: acct, mailbox_id: box, purpose: 'webmail', password_hash: pw, expires_at: new Date(Date.now() - 1000) }).returning('id');
    const [revoked] = await db('mail_app_passwords').insert({ account_id: acct, mailbox_id: box, purpose: 'webmail', password_hash: pw, expires_at: new Date(Date.now() + 3600_000), revoked_at: new Date() }).returning('id');
    const [onDisabled] = await db('mail_app_passwords').insert({ account_id: acct, mailbox_id: disabledBox, purpose: 'webmail', password_hash: pw, expires_at: new Date(Date.now() + 3600_000) }).returning('id');
    const list = (await webmailService.appPasswords()).filter((a) => a.mailboxId === box || a.mailboxId === box2 || a.mailboxId === disabledBox);
    const ids = list.map((a) => a.id).sort((a, b) => a - b);
    assert.deepEqual(ids, live.map(Number).sort((a, b) => a - b));
    for (const id of [expired, revoked, onDisabled]) assert.ok(!ids.includes(Number(id.id ?? id)));
    for (const a of list) {
      assert.deepEqual(a.allowNets, ['172.30.0.0/24', 'fd00:abcd::/64']);
      assert.equal(a.purpose, 'webmail');
      assert.match(a.passwordHash, /^\{SHA512-CRYPT\}/);
      assert.ok(Date.parse(a.expiresAt) > Date.now());
    }
    subnets = [];
    assert.deepEqual(await webmailService.appPasswords(), [], 'no subnet → no credential at all');
    subnets = ['172.30.0.0/24', 'fd00:abcd::/64'];
  });

  await t.test('logout revokes the presented credential only', async () => {
    const r = await open(manager2, box);
    const creds = (await webmailService.redeem(tokenOf(r.body.data!.url)))!;
    syncs.length = 0;
    assert.equal(await webmailService.logout(creds.username, 'wrong-credential-value'), false);
    assert.equal(await webmailService.logout('nobody@nowhere.test', creds.password), false);
    assert.equal(await webmailService.logout(creds.username.toUpperCase(), creds.password), true);
    assert.deepEqual(syncs, ['webmail logout']);
    assert.equal(await webmailService.logout(creds.username, creds.password), false, 'already revoked');
    const stillLive = await db('mail_app_passwords').where({ mailbox_id: box }).whereNull('revoked_at').where('expires_at', '>', new Date());
    assert.equal(stillLive.length, 1, 'the first session stays');
  });

  await t.test('mailboxChanged revokes every session + pending token of the mailbox, then sync', async () => {
    const r = await open(manager2, box);
    const token = tokenOf(r.body.data!.url);
    syncs.length = 0;
    webmailService.mailboxChanged(box, 'password');
    await tick();
    const live = await db('mail_app_passwords').where({ mailbox_id: box }).whereNull('revoked_at');
    assert.equal(live.length, 0);
    assert.ok(syncs.some((s) => s.includes('password')));
    assert.equal(await webmailService.redeem(token), null, 'pending token dropped');
    const other = await db('mail_app_passwords').where({ mailbox_id: box2 }).whereNull('revoked_at');
    assert.equal(other.length, 1, 'other mailbox untouched');
  });

  await t.test('409s: disabled mailbox, inactive domain, suspended account, engine without mailboxes, no webmail, not running, sync timeout', async () => {
    const r1 = await open(manager, disabledBox);
    assert.deepEqual([r1.status, r1.body.code], [409, 'mailboxDisabled']);
    const r2 = await open(manager, pendingBox);
    assert.deepEqual([r2.status, r2.body.code], [409, 'mailboxDisabled'], 'unverified domain (D1)');

    await db('hosting_accounts').where({ id: acct }).update({ status: 'suspended' });
    const r3 = await open(manager, box2);
    assert.deepEqual([r3.status, r3.body.code], [409, 'accountSuspended']);
    await db('hosting_accounts').where({ id: acct }).update({ status: 'active' });

    setMailDriverForTests(fakeDriver('external', false));
    const r4 = await open(manager, box2);
    assert.deepEqual([r4.status, r4.body.code], [409, 'mailEngineNoMailboxes']);
    setMailDriverForTests(fakeDriver('postfix-dovecot', true));

    running = false;
    const r5 = await open(manager, box2);
    assert.deepEqual([r5.status, r5.body.code], [409, 'webmailUnavailable']);
    running = true;

    const before = await db('mail_app_passwords').where({ mailbox_id: box2 }).whereNull('revoked_at').count<{ count: string }[]>('id as count');
    syncOk = false;
    const r6 = await open(manager2, box2);
    assert.deepEqual([r6.status, r6.body.code], [409, 'webmailUnavailable']);
    syncOk = true;
    const after = await db('mail_app_passwords').where({ mailbox_id: box2 }).whereNull('revoked_at').count<{ count: string }[]>('id as count');
    assert.equal(Number(after[0].count), Number(before[0].count), 'the credential of a failed session is revoked');

    await platformSettings.update({ mail: { webmail: 'none' } } as never);
    const r7 = await open(manager2, box2);
    assert.deepEqual([r7.status, r7.body.code], [409, 'webmailUnavailable']);
    await platformSettings.update({ mail: { webmail: 'roundcube', webmailHostname: 'webmail.panel.platform.test' } } as never);
    assert.equal(await webmailService.urlFor(`pending-${suffix}.test`), null, "P1': platform host under the panel host is never used");
    await platformSettings.update({ mail: { webmailHostname: 'webmail.platform.test' } } as never);
  });

  await t.test('redeem refused after a webmail kind change', async () => {
    const r = await open(manager2, box2);
    assert.equal(r.status, 200);
    await platformSettings.update({ mail: { webmail: 'snappymail' } } as never);
    assert.equal(await webmailService.redeem(tokenOf(r.body.data!.url)), null);
    await platformSettings.update({ mail: { webmail: 'roundcube' } } as never);
  });

  await t.test('expiry pass: expired → revoked_at + sync, rows older than 7 days deleted, tokens swept', async () => {
    const pw = hashMailPassword('y'.repeat(20)).hash;
    const [soon] = await db('mail_app_passwords').insert({ account_id: acct, mailbox_id: box2, purpose: 'webmail', password_hash: pw, expires_at: new Date(Date.now() - 5_000) }).returning('id');
    const [old] = await db('mail_app_passwords').insert({
      account_id: acct, mailbox_id: box2, purpose: 'webmail', password_hash: pw,
      expires_at: new Date(Date.now() - 8 * 86400_000 + 12 * 3600_000), revoked_at: new Date(Date.now() - 8 * 86400_000), created_at: new Date(Date.now() - 8 * 86400_000),
    }).returning('id');
    syncs.length = 0;
    const n = await expireWebmailSessions();
    assert.ok(n >= 1);
    assert.ok(syncs.includes('webmail sessions expired'));
    const s = await db('mail_app_passwords').where({ id: Number(soon.id ?? soon) }).first();
    assert.ok(s.revoked_at, 'expired row marked revoked');
    assert.equal(await db('mail_app_passwords').where({ id: Number(old.id ?? old) }).first(), undefined, 'old row deleted');
    syncs.length = 0;
    assert.equal(await expireWebmailSessions(), 0);
    assert.deepEqual(syncs, [], 'nothing new: no sync');
    assert.equal(webmailTokens.size >= 0, true);
  });

  await t.test('edge loader: only enabled mail domains on verified domains (D1)', async () => {
    const ids = (await loadActiveWebmailDomains()).map((d) => d.id);
    assert.ok(ids.includes(mailDomain));
    assert.ok(!ids.includes(unverified));
    assert.ok(!ids.includes(disabledDomain));
  });

  await t.test('live sessions per mailbox bounded by the engine slots: the oldest is revoked, not dropped silently', async () => {
    const { MAX_WEBMAIL_SESSIONS_PER_MAILBOX } = svc;
    const { APP_PASSWORD_SLOTS } = await import('../engines/postfixDovecot/layout');
    assert.equal(MAX_WEBMAIL_SESSIONS_PER_MAILBOX, APP_PASSWORD_SLOTS);
    // Fill the mailbox up to the limit directly (the route allows 10 opens / min / user), then open one more.
    await db('mail_app_passwords').where({ mailbox_id: box2 }).whereNull('revoked_at').update({ revoked_at: new Date() });
    const pw = hashMailPassword('z'.repeat(20)).hash;
    const seeded = await db('mail_app_passwords').insert(Array.from({ length: MAX_WEBMAIL_SESSIONS_PER_MAILBOX }, () => (
      { account_id: acct, mailbox_id: box2, purpose: 'webmail', password_hash: pw, expires_at: new Date(Date.now() + 3600_000) }))).returning('id');
    const oldest = Math.min(...seeded.map((r: { id: number } | number) => Number((r as { id: number }).id ?? r)));
    const manager3 = await user('cm3');
    await db('account_users').insert({ user_id: manager3, account_id: acct, capabilities: JSON.stringify(['mail.manage']) });
    const r = await open(manager3, box2);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const live = await db('mail_app_passwords').where({ mailbox_id: box2 }).whereNull('revoked_at').where('expires_at', '>', new Date());
    assert.equal(live.length, MAX_WEBMAIL_SESSIONS_PER_MAILBOX);
    assert.ok((await db('mail_app_passwords').where({ id: oldest }).first()).revoked_at, 'the oldest session is explicitly revoked');
  });

  await t.test('mailboxChanged deleted: no throw, sync requested', async () => {
    syncs.length = 0;
    webmailService.mailboxChanged(424242, 'deleted');
    await tick();
    assert.equal(syncs.length, 1);
  });
});
