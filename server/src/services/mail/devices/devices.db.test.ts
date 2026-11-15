import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// « Se connecter à Mint », lot 1 (L1a, L1b, L1c) on a PGlite server:
//   PG_PORT=55940 node <scratchpad>/pg/pgserver.mjs
// DEVICES_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. The mail driver is a fake (setMailDriverForTests, with a
// kickSessions spy); the webmail and device seams record syncs / revocations.
// Covers: migration 046 (constraints), manual app passwords (access, secret
// once, hash + verifier, audit without secret, ceiling, durations, disabled
// mailbox), the list, the desired-state provider, the webmail never touching
// device passwords (session cap, mailboxChanged, logout — review R2-R4),
// expiry and purge per purpose (R4), revocation by a manager and with a
// password change, the device API (status instead of 401 for a revoked
// credential, check-in once per 24 h, MailForge push-back, DELETE, 404 under
// /client and /device, no-store, 429 without any web ban), the discovery
// document (domain + panel host, never the engine), the revocation allowance
// of the mail bans (O11: with / without user name, setting off, 20 office
// devices behind one address, webmail excluded).
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.DEVICES_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55940/postgres';

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

const tick = (ms = 50) => new Promise<void>((r) => setTimeout(r, ms));
const DAY = 86_400_000;

test('device passwords, device API, discovery, ban allowance (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55940)`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-devices-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'devices-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../../db');
  const { errorHandler } = await import('../../../middleware/errorHandler');
  const mailRoutes = (await import('../../../routes/mail.routes')).default;
  const webmailRoutes = (await import('../../../routes/webmail.routes')).default;
  const clientV1Routes = (await import('../../../routes/mailClientV1.routes')).default;
  const { platformSettings } = await import('../../platformSettings');
  const { appConfigService } = await import('../../appConfig.service');
  const { setMailDriverForTests } = await import('../registry');
  const { verifyMailPassword, hashMailPassword } = await import('../passwords');
  const webmail = await import('../webmail/webmail.service');
  const { webmailService, setWebmailDepsForTests, expireAppPasswords, resetWebmailStateForTests } = webmail;
  const { devicesService, setDevicesDepsForTests, deviceVerifier, newDevicePublicId, cleanDeviceLabel, parseBasic } = await import('./devices.service');
  const { mailCoreDeps } = await import('../deps');
  const { autoconfigService } = await import('../autoconfig/autoconfig.service');
  const security = await import('../security/mailSecurity.service');
  const { webmailTokens } = await import('../webmail/ssoTokens');
  const { DEFAULT_PLAN_LIMITS, MAIL_DEVICE_PUBLIC_ID_RE } = await import('@oblimint/shared');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // ── fakes ──────────────────────────────────────────────────────────────────
  const caps = { supported: true, mailboxes: true, sieve: true, appPasswordNets: true, quotaUsage: true, queue: true, clamav: true, greylisting: true, passwordSchemes: ['SHA512-CRYPT'] };
  const kicked: string[] = [];
  setMailDriverForTests({
    engine: 'postfix-dovecot', capabilities: caps,
    imapEndpoint: () => ({ host: 'oblimint-mail', port: 143, tls: 'none' }),
    submissionEndpoint: () => ({ host: 'oblimint-mail', port: 587, tls: 'starttls' }),
    sieveEndpoint: () => ({ host: 'oblimint-mail', port: 4190, tls: 'none' }),
    kickSessions: async (a: string) => { kicked.push(a); },
  } as never);
  const syncs: string[] = [];
  const expiredDevices: number[][] = [];
  setWebmailDepsForTests({
    requestSync: (reason) => { syncs.push(reason); },
    syncNow: async () => true,
    running: async () => true,
    subnets: async () => ['172.30.0.0/24'],
    devicesExpired: (ids) => { expiredDevices.push(ids); },
  });
  let now = Date.now();
  let applied = false;
  const revocations: Array<{ addresses: string[]; reason: string }> = [];
  setDevicesDepsForTests({
    requestSync: (reason) => { syncs.push(reason); },
    revoked: (addresses, reason) => { revocations.push({ addresses, reason }); security.invalidateRevocationAllowance(); },
    appliedSince: () => applied,
    now: () => now,
  });
  const pushed: unknown[] = [];
  security.setMailSecurityBackendsForTests({
    hostd: async () => ({ setMailFirewall: async (s: unknown) => { pushed.push(s); } }) as never,
    docker: async () => { throw new Error('no docker in tests'); },
    now: () => new Date(now),
    relayTestTarget: async () => null,
  });
  t.after(() => {
    setMailDriverForTests(null);
    setWebmailDepsForTests(null);
    setDevicesDepsForTests(null);
    security.setMailSecurityBackendsForTests(null);
    resetWebmailStateForTests();
  });

  await appConfigService.set('panel_hostname', 'panel.platform.test');
  await appConfigService.set('client_panel_hostname', 'client.platform.test');
  await platformSettings.update({ mail: { webmail: 'roundcube', webmailHostname: 'webmail.platform.test', webmailPerDomain: false } } as never);
  await db('certificates').insert({ primary_name: 'webmail.platform.test', names: JSON.stringify(['webmail.platform.test']), status: 'valid' });
  platformSettings.invalidate();

  // ── fixtures ───────────────────────────────────────────────────────────────
  const suffix = Date.now().toString(36);
  const [tenantA] = await db('tenants').insert({ name: `D ${suffix}`, slug: `d-${suffix}` }).returning('id');
  const tA = Number(tenantA.id ?? tenantA);
  const user = async (username: string) => {
    const [row] = await db('users').insert({ username: `${username}-${suffix}`, display_name: `User ${username}`, kind: 'client', role: 'user', is_active: true }).returning('id');
    return Number(row.id ?? row);
  };
  const reader = await user('dr');
  const manager = await user('dm');
  const outsider = await user('do');
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
  const acct = await mkAccount('dev');
  const other = await mkAccount('oth');
  await db('account_users').insert([
    { user_id: reader, account_id: acct, capabilities: JSON.stringify([]) },
    { user_id: manager, account_id: acct, capabilities: JSON.stringify(['mail.manage']) },
    { user_id: outsider, account_id: other, capabilities: JSON.stringify(['mail.manage']) },
  ]);
  const dom = `devices-${suffix}.test`;
  const [d] = await db('domains').insert({ tenant_id: tA, account_id: acct, name: dom, verification_status: 'verified' }).returning('id');
  const [md] = await db('mail_domains').insert({ tenant_id: tA, account_id: acct, domain_id: Number(d.id ?? d), name: dom, enabled: true }).returning('id');
  const mailDomain = Number(md.id ?? md);
  const mkMailbox = async (local: string, enabled = true) => {
    const [m] = await db('mailboxes').insert({
      tenant_id: tA, account_id: acct, mail_domain_id: mailDomain, local_part: local, address: `${local}@${dom}`,
      password_hash: hashMailPassword('Mailbox-Password-1').hash, password_scheme: 'SHA512-CRYPT', enabled,
    }).returning('id');
    return Number(m.id ?? m);
  };
  const box = await mkMailbox('claire');
  const box2 = await mkMailbox('contact');
  const offBox = await mkMailbox('off', false);
  const address = `claire@${dom}`;

  // ── app ────────────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.header('x-user')) {
      (req as unknown as { session: unknown }).session = { userId: Number(req.header('x-user')) };
      (req as unknown as { tenantId: number }).tenantId = tA;
    }
    next();
  });
  app.use('/mail', mailRoutes);
  app.use('/mail', webmailRoutes);
  app.use('/v1/mail', clientV1Routes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  type Json = { success: boolean; data?: any; code?: string; error?: string }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const call = async (method: string, url: string, who: number | null, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(who ? { 'x-user': String(who) } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: (text ? JSON.parse(text) : null) as Json };
  };
  const basic = (id: string, secret: string) => ({ authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` });
  const create = (who: number, mailboxId: number, body: unknown) => call('POST', `/mail/mailboxes/${mailboxId}/devices`, who, body);
  const liveDevices = async (mailboxId: number) => db('mail_app_passwords').where({ mailbox_id: mailboxId, purpose: 'device' }).whereNull('revoked_at');

  await t.test('migration 046: purpose device and its constraints, ban column', async () => {
    const cons = (await db.raw(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'mail_app_passwords'::regclass`)).rows as Array<{ conname: string; def: string }>;
    const byName = new Map(cons.map((c) => [c.conname, c.def]));
    assert.match(byName.get('mail_app_passwords_purpose_check') ?? '', /device/);
    assert.ok(byName.has('mail_app_passwords_device_fields'));
    assert.match(byName.get('mail_app_passwords_device_basis') ?? '', /mailforge/);
    assert.ok(byName.has('mail_app_passwords_revoked_reason_check'));
    const cols = await db('mail_bans').columnInfo();
    assert.ok(cols.revoked_allowance, 'mail_bans.revoked_allowance');
  });

  await t.test('pure helpers: public id, verifier, label, Basic header', () => {
    const id = newDevicePublicId();
    assert.match(id, MAIL_DEVICE_PUBLIC_ID_RE);
    assert.notEqual(newDevicePublicId(), id);
    assert.equal(deviceVerifier('abc'), crypto.createHash('sha256').update('abc').digest('hex'));
    assert.equal(cleanDeviceLabel('  Phone\u0000 of\n Claire  '), 'Phone of Claire');
    assert.equal(cleanDeviceLabel(`${String.fromCharCode(0x2028)} `), null);
    assert.equal(cleanDeviceLabel('x'.repeat(100))?.length, 64);
    assert.deepEqual(parseBasic(basic(id, 's3cret').authorization), { id, secret: 's3cret' });
    assert.equal(parseBasic(`Bearer ${id}`), null);
    assert.equal(parseBasic(basic('omd_UPPER', 'x').authorization), null);
    assert.equal(parseBasic(basic(id, '').authorization), null);
  });

  let manual: { id: string; password: string } = { id: '', password: '' };

  await t.test('manual app password: access, secret once, hashes, audit without secret, sync', async () => {
    assert.equal((await create(reader, box, { label: 'x', days: 365, protocols: 'imapSmtp' })).status, 403);
    assert.equal((await create(outsider, box, { label: 'x', days: 365, protocols: 'imapSmtp' })).status, 404);
    assert.equal((await create(manager, box, { label: 'x', days: 30, protocols: 'imapSmtp' })).body.code, 'invalidDuration');
    assert.equal((await create(manager, box, { label: 'x', days: 365, protocols: 'pop3' })).status, 400);
    assert.equal((await create(manager, offBox, { label: 'x', days: 365, protocols: 'imapSmtp' })).body.code, 'mailboxDisabled');
    syncs.length = 0;
    const r = await create(manager, box, { label: '  Téléphone\tde Claire ', days: 365, protocols: 'imapSmtp' });
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const c = r.body.data;
    assert.equal(c.username, address);
    assert.equal(c.password.length, 43);
    assert.match(c.device.id, MAIL_DEVICE_PUBLIC_ID_RE);
    assert.equal(c.device.label, 'Téléphone de Claire');
    assert.equal(c.device.client, 'manual');
    assert.equal(c.device.basis, 'manage');
    assert.deepEqual(c.device.protocols, ['imap', 'smtp']);
    assert.equal(c.device.createdFor.id, manager);
    assert.ok(Math.abs(Date.parse(c.device.expiresAt) - (now + 365 * DAY)) < 60_000);
    const row = await db('mail_app_passwords').where({ public_id: c.device.id }).first();
    assert.equal(row.purpose, 'device');
    assert.ok(verifyMailPassword(c.password, row.password_hash), 'engine hash');
    assert.equal(row.verifier_sha256, deviceVerifier(c.password));
    assert.ok(!JSON.stringify(row).includes(c.password), 'never stored in clear');
    assert.ok(syncs.includes('device password created'));
    const audit = await db('audit_logs').where({ action: 'mail.device.create', resource_path: String(box) }).orderBy('id', 'desc').first();
    assert.ok(audit);
    const details = typeof audit.details === 'string' ? audit.details : JSON.stringify(audit.details);
    assert.ok(details.includes(c.device.id));
    assert.ok(!details.includes(c.password) && !details.includes(row.password_hash) && !details.includes(row.verifier_sha256), 'no secret in the audit');
    manual = { id: c.device.id, password: c.password };
    // 3 years refused once the platform ceiling is 1 year.
    await platformSettings.update({ mail: { manualAppPasswordMaxDays: 365 } } as never);
    assert.equal((await create(manager, box, { label: 'x', days: 1095, protocols: 'all' })).body.code, 'invalidDuration');
    await platformSettings.update({ mail: { manualAppPasswordMaxDays: 1095 } } as never);
  });

  await t.test('list (mail.manage only) and ceiling per mailbox', async () => {
    assert.equal((await call('GET', `/mail/mailboxes/${box}/devices`, reader)).status, 403);
    const l = await call('GET', `/mail/mailboxes/${box}/devices`, manager);
    assert.equal(l.status, 200);
    assert.equal(l.body.data.max, 10);
    assert.equal(l.body.data.pop3AlwaysOpen, false);
    assert.deepEqual(l.body.data.items.map((x: { id: string }) => x.id), [manual.id]);
    assert.ok(!JSON.stringify(l.body).includes('password_hash') && !JSON.stringify(l.body).includes('verifier'));
    await platformSettings.update({ mail: { maxDevicesPerMailbox: 2 } } as never);
    assert.equal((await create(manager, box, { label: 'Second', days: 90, protocols: 'all' })).status, 201);
    const third = await create(manager, box, { label: 'Third', days: 90, protocols: 'all' });
    assert.equal(third.status, 409);
    assert.equal(third.body.code, 'deviceLimit');
    await platformSettings.update({ mail: { maxDevicesPerMailbox: 10 } } as never);
    assert.equal((await create(manager, box, { label: 'Third', days: 90, protocols: 'imapSmtp' })).status, 201);
    assert.equal((await liveDevices(box)).length, 3);
  });

  await t.test('desired-state providers: device rows apart from the webmail ones', async () => {
    const devices = await devicesService.appPasswords();
    const mine = devices.filter((p) => p.mailboxId === box);
    assert.equal(mine.length, 3);
    for (const p of mine) {
      assert.equal(p.purpose, 'device');
      assert.equal(p.allowNets, null);
      assert.equal(p.address, address);
      assert.ok(p.protocols && p.protocols.length >= 2);
    }
    assert.ok((await webmailService.appPasswords()).every((p) => p.purpose === 'webmail'));
    const all = await mailCoreDeps().appPasswords();
    assert.equal(all.filter((p) => p.purpose === 'device' && p.mailboxId === box).length, 3);
  });

  await t.test('the webmail never revokes, counts nor reads device passwords (R2-R4)', async () => {
    const open = () => call('POST', `/mail/mailboxes/${box}/webmail-session`, manager, {});
    let lastTicket = '';
    for (let i = 0; i < 9; i++) {
      const r = await open();
      assert.equal(r.status, 200, JSON.stringify(r.body));
      lastTicket = new URL(r.body.data.url).searchParams.get('_oblimint_sso')!;
    }
    assert.equal((await liveDevices(box)).length, 3, '9 webmail openings revoke no device');
    const liveWebmail = await db('mail_app_passwords').where({ mailbox_id: box, purpose: 'webmail' }).whereNull('revoked_at');
    assert.equal(liveWebmail.length, 8, 'the webmail cap counts webmail sessions only');
    // Logout finds its credential among 8 webmail + 3 device rows.
    const creds = await webmailService.redeem(lastTicket);
    assert.ok(creds);
    assert.equal(await webmailService.logout(address, creds!.password), true);
    // Password changed / mailbox disabled: webmail sessions revoked, devices kept (suspended ≠ revoked).
    webmailService.mailboxChanged(box, 'password');
    webmailService.mailboxChanged(box, 'disabled');
    await tick(150);
    assert.equal((await db('mail_app_passwords').where({ mailbox_id: box, purpose: 'webmail' }).whereNull('revoked_at')).length, 0);
    assert.equal((await liveDevices(box)).length, 3);
    webmailTokens.clear();
  });

  await t.test('expiry and purge per purpose (R4)', async () => {
    const hash = hashMailPassword('z'.repeat(30)).hash;
    const dev = (over: Record<string, unknown>) => ({
      account_id: acct, mailbox_id: box2, purpose: 'device', password_hash: hash, public_id: newDevicePublicId(), label: 'old', client: 'manual',
      basis: 'manage', protocols: JSON.stringify(['imap', 'smtp']), verifier_sha256: deviceVerifier('z'), ...over,
    });
    const [recent] = await db('mail_app_passwords').insert(dev({ created_at: new Date(now - 100 * DAY), expires_at: new Date(now + 100 * DAY), revoked_at: new Date(now - 60_000), revoked_reason: 'manager' })).returning('id');
    const [ancient] = await db('mail_app_passwords').insert(dev({ created_at: new Date(now - 800 * DAY), expires_at: new Date(now - 401 * DAY) })).returning('id');
    const [due] = await db('mail_app_passwords').insert(dev({ created_at: new Date(now - 90 * DAY), expires_at: new Date(Date.now() - 1000) })).returning('id');
    syncs.length = 0;
    expiredDevices.length = 0;
    assert.ok(await expireAppPasswords() >= 1);
    const id = (x: { id?: number } | number) => Number((x as { id?: number }).id ?? x);
    assert.ok(await db('mail_app_passwords').where({ id: id(recent) }).first(), 'a device revoked a minute ago stays readable, whatever its age');
    assert.equal(await db('mail_app_passwords').where({ id: id(ancient) }).first(), undefined, 'over 400 days after its expiry: deleted');
    const dueRow = await db('mail_app_passwords').where({ id: id(due) }).first();
    assert.ok(dueRow.revoked_at);
    assert.equal(dueRow.revoked_reason, 'expired');
    assert.ok(syncs.includes('app passwords expired'));
    assert.ok(expiredDevices.some((ids) => ids.includes(id(due))), 'device follow-up (audit, kick, allowance)');
  });

  await t.test('revocation by a manager: one, unknown, all; with a password change', async () => {
    revocations.length = 0;
    assert.equal((await call('POST', `/mail/mailboxes/${box}/devices/revoke`, reader, { id: manual.id })).status, 403);
    assert.equal((await call('POST', `/mail/mailboxes/${box}/devices/revoke`, manager, { id: 'omd_aaaaaaaaaaaaaaaa' })).status, 404);
    const one = await call('POST', `/mail/mailboxes/${box}/devices/revoke`, manager, { id: manual.id });
    assert.equal(one.body.data.revoked, 1);
    const row = await db('mail_app_passwords').where({ public_id: manual.id }).first();
    assert.equal(row.revoked_reason, 'manager');
    assert.equal(row.revoked_by, manager);
    assert.deepEqual(revocations[0], { addresses: [address], reason: 'manager' });
    assert.ok(await db('audit_logs').where({ action: 'mail.device.revoke', resource_path: String(box) }).first());
    // Password changed WITHOUT the box: devices stay.
    assert.equal((await call('POST', `/mail/mailboxes/${box}/password`, manager, {})).status, 200);
    assert.equal((await liveDevices(box)).length, 2);
    // WITH the box: every device of the mailbox, reason 'password'.
    assert.equal((await call('POST', `/mail/mailboxes/${box}/password`, manager, { revokeDevices: true })).status, 200);
    assert.equal((await liveDevices(box)).length, 0);
    assert.ok(revocations.some((r) => r.reason === 'password'));
    const reasons = await db('mail_app_passwords').where({ mailbox_id: box, purpose: 'device' }).whereNotNull('revoked_at').pluck('revoked_reason');
    assert.ok(reasons.includes('password'));
    // Revoke all on box2.
    await create(manager, box2, { label: 'A', days: 90, protocols: 'imapSmtp' });
    await create(manager, box2, { label: 'B', days: 90, protocols: 'imapSmtp' });
    const all = await call('POST', `/mail/mailboxes/${box2}/devices/revoke`, manager, { all: true });
    assert.equal(all.body.data.revoked, 2);
    assert.equal((await call('POST', `/mail/mailboxes/${box2}/devices/revoke`, manager, { all: true, id: manual.id })).status, 400);
  });

  await t.test('device API: status instead of 401, check-in once a day, MailForge push-back, DELETE', async () => {
    const c = (await create(manager, box, { label: 'API', days: 365, protocols: 'all' })).body.data;
    const auth = basic(c.device.id, c.password);
    applied = false;
    let r = await call('GET', '/v1/mail/device/self', null, undefined, auth);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('pragma'), 'no-cache');
    assert.equal(r.body.data.status, 'active');
    assert.equal(r.body.data.address, address);
    assert.equal(r.body.data.engineReady, false);
    assert.equal(r.body.data.servers.engine, 'postfix-dovecot', 'the engine only in an authenticated answer');
    assert.equal(r.body.data.servers.managesieve.port, 4190);
    let row = await db('mail_app_passwords').where({ public_id: c.device.id }).first();
    assert.ok(row.last_seen_at);
    assert.equal(row.last_seen_ip, '127.0.0.1');
    const firstSeen = new Date(row.last_seen_at).getTime();
    applied = true;
    now += 3_600_000;
    r = await call('GET', '/v1/mail/device/self', null, undefined, auth);
    assert.equal(r.body.data.engineReady, true);
    row = await db('mail_app_passwords').where({ public_id: c.device.id }).first();
    assert.equal(new Date(row.last_seen_at).getTime(), firstSeen, 'at most one write per 24 h');
    now += DAY;
    await call('GET', '/v1/mail/device/self', null, undefined, auth);
    row = await db('mail_app_passwords').where({ public_id: c.device.id }).first();
    assert.ok(new Date(row.last_seen_at).getTime() > firstSeen);
    assert.equal(new Date(row.expires_at).getTime(), Date.parse(c.device.expiresAt), 'a manual password is never pushed back');
    // Wrong secret / malformed / unknown id → 401 invalidCredential.
    assert.equal((await call('GET', '/v1/mail/device/self', null, undefined, basic(c.device.id, 'wrong'))).body.code, 'invalidCredential');
    assert.equal((await call('GET', '/v1/mail/device/self', null, undefined, { authorization: 'Bearer x' })).status, 401);
    assert.equal((await call('GET', '/v1/mail/device/self', null, undefined, basic('omd_bbbbbbbbbbbbbbbb', c.password))).status, 401);
    // A MailForge credential is pushed back to now + idle days.
    const secret = 'm'.repeat(43);
    const mfId = newDevicePublicId();
    await db('mail_app_passwords').insert({
      account_id: acct, mailbox_id: box, purpose: 'device', password_hash: hashMailPassword(secret).hash, public_id: mfId, label: 'PC (MailForge)',
      client: 'mailforge', basis: 'assigned', protocols: JSON.stringify(['imap', 'smtp']), verifier_sha256: deviceVerifier(secret), created_by: manager,
      expires_at: new Date(now + 10 * DAY),
    });
    r = await call('GET', '/v1/mail/device/self', null, undefined, basic(mfId, secret));
    assert.equal(r.body.data.status, 'active');
    assert.ok(Math.abs(Date.parse(r.body.data.expiresAt) - (now + 180 * DAY)) < 60_000);
    // Disabled mailbox → suspended (not revoked).
    await db('mailboxes').where({ id: box }).update({ enabled: false });
    r = await call('GET', '/v1/mail/device/self', null, undefined, auth);
    assert.equal(r.body.data.status, 'suspended');
    assert.equal(r.body.data.servers, null);
    await db('mailboxes').where({ id: box }).update({ enabled: true });
    // DELETE → 204, reason 'device', audit; again → 204.
    revocations.length = 0;
    r = await call('DELETE', '/v1/mail/device/self', null, undefined, auth);
    assert.equal(r.status, 204);
    assert.equal((await db('mail_app_passwords').where({ public_id: c.device.id }).first()).revoked_reason, 'device');
    assert.deepEqual(revocations, [{ addresses: [address], reason: 'device' }]);
    assert.ok(await db('audit_logs').where({ action: 'mail.device.revoke' }).whereRaw("details->>'reason' = 'device'").first());
    assert.equal((await call('DELETE', '/v1/mail/device/self', null, undefined, auth)).status, 204);
    // The revoked credential learns its status (200), never 401.
    r = await call('GET', '/v1/mail/device/self', null, undefined, auth);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.status, 'revoked');
    assert.equal(r.body.data.revokedReason, 'device');
    // An expired one too.
    await db('mail_app_passwords').where({ public_id: mfId }).update({ expires_at: new Date(now - 1000) });
    r = await call('GET', '/v1/mail/device/self', null, undefined, basic(mfId, secret));
    assert.equal(r.body.data.status, 'expired');
    assert.equal(r.body.data.revokedReason, 'expired');
  });

  await t.test('nothing of MailForge falls through to the key router: 404 under /client and /device', async () => {
    for (const p of ['/v1/mail/client/mailboxes', '/v1/mail/client', '/v1/mail/device/other', '/v1/mail/device']) {
      const r = await call('GET', p, null);
      assert.equal(r.status, 404, p);
      assert.equal(r.body.code, 'notFound', p);
    }
  });

  await t.test('API router: /v1/mail is mounted BEFORE the access-key router (no key surface barrier, review R1)', async () => {
    const api = (await import('../../../routes/index')).routes as unknown as { stack: Array<{ handle: unknown; regexp: RegExp }> };
    const v1 = (await import('../../../routes/v1.routes')).default;
    const iMail = api.stack.findIndex((l) => l.handle === clientV1Routes);
    const iKeys = api.stack.findIndex((l) => l.handle === v1);
    assert.ok(iMail >= 0 && iKeys >= 0, 'both routers mounted');
    assert.ok(iMail < iKeys, 'the device API answers before keySurfaceGate(key-api) could see the request');
    assert.ok(api.stack[iMail].regexp.test('/v1/mail/device/self'));
  });

  await t.test('discovery document: autoconfig.<d> and panel hosts, never the engine (P6)', async () => {
    const a = await autoconfigService.mailClient(`autoconfig.${dom}`);
    assert.ok(a);
    assert.equal(a!.cors, true);
    assert.equal(a!.maxAge, 300);
    const doc = JSON.parse(a!.body);
    assert.equal(doc.domain, dom);
    assert.deepEqual(doc.issuers, ['https://panel.platform.test', 'https://client.platform.test']);
    assert.equal(doc.oauth.enabled, false, 'no MailForge sign-in before lot 2');
    assert.deepEqual(doc.oauth.endpoints, {});
    assert.equal(doc.mail.smtp[0].port, 465);
    assert.equal(doc.mail.imap[0].host, 'panel.platform.test');
    assert.equal(doc.mail.capabilities.manualAppPasswords, true);
    assert.equal(doc.mail.capabilities.deviceApi, true);
    assert.equal(doc.mail.authBan.revokedAllowance, true);
    for (const k of ['engine', 'managesieve', 'serverFullTextSearch', 'imapConnectionsPerUserIp', 'dovecot', 'stalwart', 'LOGIN']) assert.ok(!a!.body.toLowerCase().includes(k.toLowerCase()), k);
    assert.deepEqual(Object.keys(doc).sort(), ['clientSpaceUrl', 'domain', 'issuers', 'mail', 'oauth', 'panelUrl', 'product', 'version', 'webmailUrl'], 'no panel version, no engine');
    const p = await autoconfigService.mailClient('client.platform.test');
    assert.ok(p);
    assert.equal(JSON.parse(p!.body).domain, undefined);
    assert.equal(await autoconfigService.mailClient('unknown.example.com'), null);
    assert.equal(await autoconfigService.mailClient(`autoconfig.unknown-${suffix}.test`), null);
    assert.equal(await autoconfigService.mailClient(`mta-sts.${dom}`), null);
  });

  await t.test('ban allowance (O11): user name, no user name, setting off, office behind one address', async () => {
    await platformSettings.update({ mail: { authBanThreshold: 3, authBanWindowMinutes: 10, authBanDurationMinutes: 60, authBanRevokedAllowance: true } } as never);
    now = Date.now();
    const hash = hashMailPassword('q'.repeat(30)).hash;
    const revokedDevice = async (mailboxId: number, lastSeenIp: string | null) => db('mail_app_passwords').insert({
      account_id: acct, mailbox_id: mailboxId, purpose: 'device', password_hash: hash, public_id: newDevicePublicId(), label: 'gone', client: 'mailforge',
      basis: 'assigned', protocols: JSON.stringify(['imap', 'smtp']), verifier_sha256: deviceVerifier('q'), expires_at: new Date(now + DAY),
      revoked_at: new Date(now - 3_600_000), revoked_reason: 'manager', last_seen_ip: lastSeenIp,
    });
    const target = await mkMailbox('allowance');
    const targetAddr = `allowance@${dom}`;
    await revokedDevice(target, '198.51.100.20');
    security.invalidateRevocationAllowance();
    const fail = (ip: string, username: string | null, service: 'imap' | 'smtp' | 'webmail' = 'imap') => security.recordMailAuthFailure({ ip, service, username });

    // 1 revoked device on that address: the first failure of the pair is free, the ban comes one later.
    assert.equal(await fail('203.0.113.50', targetAddr.toUpperCase()), null);
    assert.equal(await fail('203.0.113.50', targetAddr), null);
    assert.equal(await fail('203.0.113.50', targetAddr), null);
    const ban = await fail('203.0.113.50', targetAddr);
    assert.ok(ban, 'banned once the allowance is used');
    assert.equal(ban!.revokedAllowance, 1);
    assert.equal((await security.mailSecurityService.listBans()).find((b) => b.ip === '203.0.113.50')?.revokedAllowance, 1);

    // Non-regression: an address without revocation is banned at the threshold.
    assert.equal(await fail('203.0.113.51', `nobody@${dom}`), null);
    assert.equal(await fail('203.0.113.51', `nobody@${dom}`), null);
    assert.ok(await fail('203.0.113.51', `nobody@${dom}`));

    // Without a user name: the allowance follows the last check-in address of the revoked device.
    assert.equal(await fail('198.51.100.20', null, 'smtp'), null);
    assert.equal(await fail('198.51.100.20', null, 'smtp'), null);
    assert.equal(await fail('198.51.100.20', null, 'smtp'), null);
    assert.ok(await fail('198.51.100.20', null, 'smtp'));
    assert.equal(await fail('198.51.100.21', null, 'smtp'), null);
    assert.equal(await fail('198.51.100.21', null, 'smtp'), null);
    assert.ok(await fail('198.51.100.21', null, 'smtp'), 'another address: no allowance');

    // The webmail never gets an allowance.
    assert.equal(await fail('203.0.113.52', targetAddr, 'webmail'), null);
    assert.equal(await fail('203.0.113.52', targetAddr, 'webmail'), null);
    assert.ok(await fail('203.0.113.52', targetAddr, 'webmail'));

    // Setting off: counted at once.
    await platformSettings.update({ mail: { authBanRevokedAllowance: false } } as never);
    assert.equal(await fail('203.0.113.53', targetAddr), null);
    assert.equal(await fail('203.0.113.53', targetAddr), null);
    assert.ok(await fail('203.0.113.53', targetAddr));
    await platformSettings.update({ mail: { authBanRevokedAllowance: true } } as never);

    // T8 in miniature: 20 office devices behind one address, 20 mailboxes revoked at once, one try each → no ban.
    const office: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = await mkMailbox(`office${i}`);
      await revokedDevice(id, null);
      office.push(`office${i}@${dom}`);
    }
    security.invalidateRevocationAllowance();
    for (const a of office) assert.equal(await fail('203.0.113.60', a), null, a);
    assert.equal((await security.mailSecurityService.listBans()).some((b) => b.ip === '203.0.113.60'), false);
    // T9 in miniature: 5 devices of one shared mailbox revoked, 5 tries on that pair → no ban.
    const shared = await mkMailbox('shared');
    for (let i = 0; i < 5; i++) await revokedDevice(shared, null);
    security.invalidateRevocationAllowance();
    for (let i = 0; i < 5; i++) assert.equal(await fail('203.0.113.61', `shared@${dom}`), null);
    assert.equal((await security.mailSecurityService.listBans()).some((b) => b.ip === '203.0.113.61'), false);

    // Review: the allowance without a user name must stay bounded. Anyone holding a mailbox can mint
    // revocations (create, check in from HIS address, revoke): each one used to buy one more free SMTP
    // try against ANY mailbox from that address. The budget is capped (REVOCATION_ALLOWANCE_MAX).
    const own = await mkMailbox('selfminted');
    const cap = 50; // REVOCATION_ALLOWANCE_MAX
    const minted = cap + 10;
    for (let i = 0; i < minted; i++) await revokedDevice(own, '192.0.2.77');
    security.invalidateRevocationAllowance();
    let banned = false;
    for (let i = 0; i < cap + 3 && !banned; i++) banned = !!(await fail('192.0.2.77', null, 'smtp'));
    assert.ok(banned, `banned after at most ${cap} free tries + the threshold, whatever the self-made revocations`);
    // Same ceiling with a user name (revocations churned on one address).
    let bannedPair = false;
    for (let i = 0; i < cap + 3 && !bannedPair; i++) bannedPair = !!(await fail('192.0.2.78', `selfminted@${dom}`));
    assert.ok(bannedPair, 'the per-address allowance has the same ceiling');
    assert.equal(security.REVOCATION_ALLOWANCE_MAX, cap);
  });

  await t.test('device API limiters: 429, never a web ban', async () => {
    const before = Number((await db('web_bans').count<{ n: string }[]>('* as n'))[0].n);
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await call('GET', '/v1/mail/device/self', null, undefined, basic('omd_cccccccccccccccc', 'nope'))).status;
    assert.equal(last, 429);
    const r = await call('GET', '/v1/mail/device/self', null, undefined, basic('omd_cccccccccccccccc', 'nope'));
    assert.equal(r.body.code, 'rateLimited');
    assert.ok(Number(r.headers.get('retry-after')) > 0, 'Retry-After');
    assert.equal(Number((await db('web_bans').count<{ n: string }[]>('* as n'))[0].n), before, 'no web ban');
  });
});
