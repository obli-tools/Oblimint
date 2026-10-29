import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { Request } from 'express';

// ─────────────────────────────────────────────────────────────────────────────
// Notification center on a real PostgreSQL (INBOX_TEST_DATABASE_URL, default
// the harness on port 55900; skipped when nothing listens):
//  - recipients computed on the server: account members with the right
//    capability, staff of the tenant with the right capability, platform
//    admins for platform events — never another tenant / account (non-leak);
//  - per-user preferences (in-app / e-mail), 24 h deduplication;
//  - inbox API scoped to (user, tenant): another user's ids never change;
//  - notify() feeds the center (queue hook);
//  - transactional sender: settings (write-only passwords), sending through
//    an external SMTP / the platform engine (fake transports), journal;
//  - retention (90 days, 500 per user and tenant).
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.INBOX_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55900/postgres';

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

test('notification center: recipients, preferences, inbox, e-mail', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) { t.skip(`no PostgreSQL at ${DB_URL}`); return; }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-inbox-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'inbox-test-secret-0123456789abcdef';

  const { db } = await import('../../db');
  const svc = await import('./userNotifications.service');
  const { notify, notificationQueueIdle, setNotificationDepsForTests } = await import('./notifications.service');
  const tm = await import('../mail/transactional');
  await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
  await db.raw('CREATE SCHEMA public');
  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  const sent: Array<{ options: Record<string, unknown>; mail: Record<string, unknown> }> = [];
  let failNext = false;
  tm.setTransactionalDepsForTests({
    transport: (options) => ({
      async sendMail(mail: Record<string, unknown>) {
        if (failNext) { failNext = false; throw Object.assign(new Error('mailbox unavailable'), { responseCode: 550 }); }
        sent.push({ options, mail });
        return {};
      },
      close() { /* nothing */ },
    }),
    lookup: async () => [{ address: '100.64.0.25', family: 4 }],
    submissionEndpoint: async () => ({ host: 'oblimint-mail', port: 587, tls: 'starttls' }),
  });
  setNotificationDepsForTests({ retryDelaysMs: [] });

  // ── fixtures ──
  const [ta] = await db('tenants').insert({ name: 'Reseller A', slug: 'reseller-a' }).returning('id');
  const [tb] = await db('tenants').insert({ name: 'Reseller B', slug: 'reseller-b' }).returning('id');
  const A = Number(ta.id ?? ta);
  const B = Number(tb.id ?? tb);
  await db('permission_sets').insert({ name: 'Domains', slug: 'domains-only', capabilities: JSON.stringify(['overview.read', 'domains.manage']) });
  const mkUser = async (username: string, opts: { role?: 'admin' | 'user'; kind?: 'staff' | 'client'; email?: string } = {}) =>
    Number((await db('users').insert({
      username, role: opts.role ?? 'user', kind: opts.kind ?? 'staff', is_active: true, password_hash: 'x', email: opts.email ?? null,
    }).returning('id'))[0].id);
  const admin = await mkUser('platform-admin', { role: 'admin', email: 'admin@example.com' });
  const staffA = await mkUser('staff-a');
  const domainsA = await mkUser('domains-a');
  const staffB = await mkUser('staff-b');
  const c1 = await mkUser('client-approver', { kind: 'client', email: 'approver@example.com' });
  const c2 = await mkUser('client-plain', { kind: 'client' });
  const c3 = await mkUser('client-other', { kind: 'client' });
  await db('user_tenants').insert([
    { user_id: admin, tenant_id: 1, role: 'admin' },
    { user_id: staffA, tenant_id: A, role: 'admin' },
    { user_id: domainsA, tenant_id: A, role: 'domains-only' },
    { user_id: staffB, tenant_id: B, role: 'admin' },
    { user_id: c1, tenant_id: A, role: 'client' },
    { user_id: c2, tenant_id: A, role: 'client' },
    { user_id: c3, tenant_id: A, role: 'client' },
  ]);
  const node = (await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined;
  const nodeId = node?.id ?? Number((await db('nodes').insert({ name: 'n1', is_local: true }).returning('id'))[0].id);
  const mkAccount = async (tenantId: number, name: string) => {
    const [plan] = await db('plans').insert({ tenant_id: tenantId, name: `p-${name}`, limits: JSON.stringify({}) }).returning('id');
    const uid = 20000 + Math.floor(Math.random() * 30000);
    const [a] = await db('hosting_accounts').insert({
      tenant_id: tenantId, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: name, uid, gid: uid, status: 'active', filesrv_mode: 'off',
    }).returning('id');
    return Number(a.id ?? a);
  };
  const a1 = await mkAccount(A, 'acct1');
  const a2 = await mkAccount(A, 'acct2');
  await db('account_users').insert([
    { user_id: c1, account_id: a1, capabilities: JSON.stringify(['releases.publish', 'releases.approve']) },
    { user_id: c2, account_id: a1, capabilities: JSON.stringify([]) },
    { user_id: c3, account_id: a2, capabilities: JSON.stringify(['releases.publish', 'releases.approve']) },
  ]);

  const rowsOf = async (event: string, key: string) =>
    (await db('user_notifications').where({ event, dedup_key: key }).orderBy('user_id').select('user_id', 'tenant_id', 'in_app')) as Array<{ user_id: number; tenant_id: number; in_app: boolean }>;
  const usersOf = async (event: string, key: string) => (await rowsOf(event, key)).map((r) => r.user_id).sort((x, y) => x - y);
  const sorted = (...ids: number[]) => [...ids].sort((x, y) => x - y);
  const base = { title: 'T', message: 'M', severity: 'warning' as const };

  await t.test('account event: members of the account + staff with the capability, nobody else', async () => {
    await svc.deliverToUsers('certificate.failed', { ...base, tenantId: A, accountId: a1, key: 'cert:1', link: '/domains' });
    assert.deepEqual(await usersOf('certificate.failed', 'cert:1'), sorted(c1, c2, staffA, domainsA));
    for (const r of await rowsOf('certificate.failed', 'cert:1')) assert.equal(r.tenant_id, A);
  });

  await t.test('a decision event goes to those who can decide only', async () => {
    await svc.deliverToUsers('release.pendingApproval', { ...base, tenantId: A, accountId: a1, key: 'release:1' });
    assert.deepEqual(await usersOf('release.pendingApproval', 'release:1'), sorted(c1, staffA));
  });

  await t.test('non-leak: an account of another tenant never brings its members in', async () => {
    // Emitter bug: tenant B with an account of tenant A → the clients of A never see it.
    await svc.deliverToUsers('quota.warning', { ...base, tenantId: B, accountId: a1, key: 'quota:x' });
    assert.deepEqual(await usersOf('quota.warning', 'quota:x'), [staffB]);
    // Platform staff of the master tenant are not tenant B staff.
    assert.ok(!(await usersOf('quota.warning', 'quota:x')).includes(admin));
  });

  await t.test('platform events reach the platform admins, stored in the master tenant', async () => {
    await svc.deliverToUsers('platform.updateFailed', { ...base, tenantId: 1, key: 'pu:1', platform: true });
    const rows = await rowsOf('platform.updateFailed', 'pu:1');
    assert.deepEqual(rows.map((r) => [r.user_id, r.tenant_id]), [[admin, 1]]);
    await svc.deliverToUsers('mail.serviceFailed', { ...base, tenantId: A, key: 'ms:1', platform: true });
    const ms = await rowsOf('mail.serviceFailed', 'ms:1');
    assert.deepEqual(ms.map((r) => [r.user_id, r.tenant_id]).sort(), [[admin, 1], [staffA, A]].sort());
  });

  await t.test('24 h deduplication per user', async () => {
    const n = await svc.deliverToUsers('certificate.failed', { ...base, tenantId: A, accountId: a1, key: 'cert:1' });
    assert.equal(n, 0);
    assert.equal((await rowsOf('certificate.failed', 'cert:1')).length, 4);
  });

  await t.test('preferences: in-app off removes the user, unknown families refused', async () => {
    const s = await svc.userNotificationService.updatePrefs({} as Request, c2, { prefs: { certificates: { inApp: false } } });
    assert.equal(s.prefs.certificates.inApp, false);
    assert.equal(s.prefs.releases.inApp, true);
    assert.ok(!s.families.includes('platform'), 'a client never chooses platform events');
    await assert.rejects(svc.userNotificationService.updatePrefs({} as Request, c2, { prefs: { nope: { inApp: true } } } as never), /Unknown notification family/);
    await assert.rejects(svc.userNotificationService.updatePrefs({} as Request, c2, { prefs: { quota: { inApp: 'yes' } } } as never), /Invalid preference/);
    await svc.deliverToUsers('certificate.failed', { ...base, tenantId: A, accountId: a1, key: 'cert:2' });
    assert.deepEqual(await usersOf('certificate.failed', 'cert:2'), sorted(c1, staffA, domainsA));
  });

  await t.test('inbox: scoped to (user, tenant), read / unread / all / delete', async () => {
    const page = await svc.userNotificationService.list(c1, A);
    assert.ok(page.items.length >= 3);
    assert.equal(page.unreadCount, page.items.length);
    assert.ok(page.items.every((n) => n.tenantId === A));
    assert.equal((await svc.userNotificationService.list(c1, B)).items.length, 0, 'nothing of tenant A in tenant B');
    const ids = page.items.map((n) => n.id);
    // Another user's ids change nothing.
    assert.equal((await svc.userNotificationService.markRead(c2, A, ids)).updated, 0);
    assert.equal((await svc.userNotificationService.remove(staffB, B, ids)).deleted, 0);
    const r = await svc.userNotificationService.markRead(c1, A, [ids[0]]);
    assert.equal(r.updated, 1);
    assert.equal(r.unreadCount, ids.length - 1);
    assert.equal((await svc.userNotificationService.list(c1, A, { unread: true })).items.length, ids.length - 1);
    assert.equal((await svc.userNotificationService.markUnread(c1, A, [ids[0]])).unreadCount, ids.length);
    assert.equal((await svc.userNotificationService.markAllRead(c1, A)).unreadCount, 0);
    assert.equal(await svc.userNotificationService.unreadCount(c1, A), 0);
    assert.equal((await svc.userNotificationService.remove(c1, A, [ids[0]])).deleted, 1);
    // Paging.
    const p1 = await svc.userNotificationService.list(staffA, A, { limit: 2 });
    assert.equal(p1.items.length, 2);
    assert.equal(p1.hasMore, true);
    const p2 = await svc.userNotificationService.list(staffA, A, { limit: 2, before: p1.items[1].id });
    assert.ok(p2.items.every((n) => n.id < p1.items[1].id));
    // Family filter + account filter (API keys).
    assert.ok((await svc.userNotificationService.list(staffA, A, { family: 'releases' })).items.every((n) => n.family === 'releases'));
    assert.ok((await svc.userNotificationService.list(staffA, A, { accountId: a2 })).items.length === 0);
    assert.throws(() => svc.parseIds('1,2'), /array/);
    assert.throws(() => svc.parseIds([]), /1 to 500/);
  });

  await t.test('notify() feeds the notification center', async () => {
    notify('domain.verified', { tenantId: A, accountId: a2, key: 'domain:9', title: 'Domaine vérifié : example.com', message: 'ok', severity: 'info', link: '//evil.example.com' });
    await notificationQueueIdle();
    assert.deepEqual(await usersOf('domain.verified', 'domain:9'), sorted(c3, staffA, domainsA));
    const row = await db('user_notifications').where({ event: 'domain.verified', user_id: c3 }).first('link', 'family');
    assert.equal(row.link, null, 'an off-panel link is dropped');
    assert.equal(row.family, 'domains');
  });

  await t.test('transactional sender: settings, write-only password, SMTP and platform', async () => {
    const req = { session: { userId: admin }, headers: {}, socket: { remoteAddress: '203.0.113.9' }, ip: '203.0.113.9', get: () => undefined } as unknown as Request;
    assert.equal((await tm.transactionalMailService.get()).ready, false);
    const r = await tm.sendTransactional({ to: 'x@example.com', subject: 's', text: 't', kind: 'test' });
    assert.equal(r.status, 'skipped');

    let s = await tm.transactionalMailService.update(req, {
      mode: 'smtp', fromName: 'Hébergeur', smtp: { host: 'smtp.example.com', port: 587, secure: false, username: 'mailer', from: 'noreply@example.com', password: 'p4ss' },
    });
    assert.equal(s.ready, true);
    assert.equal(s.smtp.passwordSet, true);
    assert.equal((s.smtp as Record<string, unknown>).password, undefined, 'never returned');
    const stored = await db('app_config').where({ key: 'mail.transactional' }).first('value');
    assert.ok(!String(stored.value).includes('p4ss'), 'sealed at rest');
    // A kept password does not follow a new server.
    await assert.rejects(tm.transactionalMailService.update(req, { smtp: { host: 'other.example.com' } }), /enter the password again/);
    await assert.rejects(tm.transactionalMailService.update(req, { fromName: 'a"<b>' }), /Validation failed/);

    const ok = await tm.transactionalMailService.test(req, 'dest@example.com');
    assert.equal(ok.ok, true);
    const last = sent[sent.length - 1];
    assert.equal(last.options.host, '100.64.0.25', 'pinned address');
    assert.deepEqual(last.options.tls, { servername: 'smtp.example.com' });
    assert.deepEqual(last.options.auth, { user: 'mailer', pass: 'p4ss' });
    assert.equal(last.mail.from, '"Hébergeur" <noreply@example.com>');
    failNext = true;
    const ko = await tm.transactionalMailService.test(req, 'dest@example.com');
    assert.equal(ko.ok, false);
    assert.match(String(ko.error), /SMTP 550/);
    assert.ok(!String(ko.error).includes('p4ss'));
    const log = await tm.transactionalMailService.log(10);
    assert.deepEqual(log.slice(0, 3).map((e) => e.status), ['failed', 'sent', 'skipped']);

    s = await tm.transactionalMailService.update(req, { mode: 'platform', platform: { mailbox: 'noreply@example.com', password: 'mb-pass' } });
    assert.equal(s.platformAvailable, true);
    assert.equal(s.ready, true);
    assert.equal((await tm.transactionalMailService.test(req, 'dest@example.com')).ok, true);
    const p = sent[sent.length - 1];
    assert.equal(p.options.host, 'oblimint-mail');
    assert.equal(p.options.port, 587);
    assert.equal(p.options.requireTLS, true);
    assert.deepEqual(p.options.auth, { user: 'noreply@example.com', pass: 'mb-pass' });
    // Another mailbox without a password: the old one is not reused.
    s = await tm.transactionalMailService.update(req, { platform: { mailbox: 'other@example.com' } });
    assert.equal(s.platform.passwordSet, false);
    assert.equal(s.ready, false);
    await tm.transactionalMailService.update(req, { platform: { mailbox: 'noreply@example.com', password: 'mb-pass' } });
  });

  await t.test('e-mail channel of the notification center follows the preferences', async () => {
    const before = sent.length;
    await svc.userNotificationService.updatePrefs({} as Request, c1, { prefs: { releases: { email: true, inApp: false } } });
    const settings = await svc.userNotificationService.settings(c1);
    assert.equal(settings.emailAvailable, true);
    assert.equal(settings.emailAddress, 'approver@example.com');
    await svc.deliverToUsers('release.rejected', { ...base, tenantId: A, accountId: a1, key: 'release:7', title: 'Release rejetée : blog' });
    const mails = sent.slice(before);
    assert.equal(mails.length, 1, 'only the user who asked for e-mails');
    assert.equal(mails[0].mail.to, 'approver@example.com');
    assert.equal(mails[0].mail.subject, '[Oblimint] Release rejetée : blog');
    const row = await db('user_notifications').where({ event: 'release.rejected', user_id: c1 }).first('in_app', 'emailed_at');
    assert.equal(row.in_app, false, 'e-mail only: not in the bell');
    assert.ok(row.emailed_at);
    assert.ok(!(await svc.userNotificationService.list(c1, A)).items.some((n) => n.event === 'release.rejected'));
    // Deduplicated like the bell (no second e-mail).
    await svc.deliverToUsers('release.rejected', { ...base, tenantId: A, accountId: a1, key: 'release:7' });
    assert.equal(sent.length - before, 1);
  });

  await t.test('retention: 90 days, 500 per user and tenant', async () => {
    const old = new Date(Date.now() - 91 * 86_400_000);
    await db('user_notifications').insert({ user_id: staffB, tenant_id: B, event: 'quota.warning', family: 'quota', title: 'old', created_at: old });
    const many = Array.from({ length: 510 }, (_, i) => ({ user_id: staffB, tenant_id: B, event: 'quota.warning', family: 'quota', title: `n${i}`, dedup_key: `k${i}` }));
    await db('user_notifications').insert(many);
    const res = await svc.purgeUserNotifications();
    assert.equal(res.expired, 1);
    assert.ok(res.overflow >= 10);
    const left = Number((await db('user_notifications').where({ user_id: staffB, tenant_id: B }).count({ n: '*' }))[0].n);
    assert.equal(left, 500);
    assert.equal((await db('user_notifications').where({ user_id: staffB, title: 'n509' }).first('id')) !== undefined, true, 'the newest are kept');
  });
});
