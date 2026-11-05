import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import * as OTPAuth from 'otpauth';
import type { ContainmentSqlInstance } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Follow-ups of the containment on a real PostgreSQL (CONTAINMENT_TEST_DATABASE_URL;
// skipped when nothing listens): the external SQL step and its resume, the report
// of the windows still served, the password expired by the lift (real routes for
// the sign-in and the lift, real reset links), migration 044 down and up.
// The engines themselves: databases/externalSessions.e2e.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.CONTAINMENT_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55462/postgres';
const OLD_PW = 'client-password-0123456789';
const NEW_PW = 'brand-new-password-0123456789';

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

test('containment follow-ups', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) { t.skip(`no PostgreSQL at ${DB_URL}`); return; }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-followup-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'contain-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const { captureStepUpProof } = await import('../../middleware/captureStepUpProof');
  const containmentRoutes = (await import('../../routes/containment.routes')).default;
  const { authController } = await import('../../controllers/auth.controller');
  const { setFirewallBackendsForTests } = await import('../firewall/firewall.service');
  const { containmentService, setContainmentDepsForTests } = await import('./containment.service');
  const { twoFactorService } = await import('../twoFactor.service');
  const { hashPassword } = await import('../../utils/crypto');
  const { resetStepUpFailuresForTests } = await import('../stepUp');
  const { identityService } = await import('../identity/identity.service');
  const { linkTokenHash, newLinkToken } = await import('../identity/secrets');
  const { userService } = await import('../user.service');

  await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
  await db.raw('CREATE SCHEMA public');
  await db.migrate.latest();
  t.after(async () => { setContainmentDepsForTests(null); setFirewallBackendsForTests(null); resetStepUpFailuresForTests(); await db.destroy(); });

  // ── fixtures ──
  const A = Number((await db('tenants').insert({ name: 'AlphaT', slug: 'alphat' }).returning('id'))[0].id);
  const secret = twoFactorService.generateTotpSecret('staff-a').secret;
  const STAFF = Number((await db('users').insert({
    username: 'staff-a', role: 'admin', kind: 'staff', is_active: true, password_hash: 'x', totp_enabled: true, totp_secret: secret, preferred_language: 'fr',
  }).returning('id'))[0].id);
  await db('user_tenants').insert({ user_id: STAFF, tenant_id: A, role: 'admin' });
  const hash = await hashPassword(OLD_PW);
  const mkClient = async (username: string, email: string | null = null) => {
    const id = Number((await db('users').insert({
      username, role: 'user', kind: 'client', is_active: true, password_hash: hash, preferred_language: 'fr', email, email_verified_for: email,
    }).returning('id'))[0].id);
    await db('user_tenants').insert({ user_id: id, tenant_id: A, role: 'client' });
    return id;
  };
  const SOLO = await mkClient('client-solo', 'solo@example.test');
  const MULTI = await mkClient('client-multi');
  const nodeId = Number(((await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined)?.id
    ?? (await db('nodes').insert({ name: 'n1', is_local: true }).returning('id'))[0].id);
  const mkAccount = async (username: string, uid: number) => {
    const [plan] = await db('plans').insert({ tenant_id: A, name: `p-${username}`, limits: JSON.stringify({}) }).returning('id');
    return Number((await db('hosting_accounts').insert({
      tenant_id: A, node_id: nodeId, plan_id: Number(plan.id ?? plan), username, uid, gid: uid, status: 'active', filesrv_mode: 'off', access_mode: 'open',
    }).returning('id'))[0].id);
  };
  const acct = await mkAccount('acmeone', 41001);
  const other = await mkAccount('acmetwo', 41002);
  const caps = JSON.stringify(['sites.manage', 'files.manage']);
  await db('account_users').insert([
    { user_id: SOLO, account_id: acct, capabilities: caps },
    { user_id: MULTI, account_id: acct, capabilities: caps },
    { user_id: MULTI, account_id: other, capabilities: caps },
  ]);
  const site = Number((await db('sites').insert({
    tenant_id: A, account_id: acct, name: 'web', slug: 'web', base: 'nginx-static', docroot: '', base_path: '/', publish_mode: 'manual',
    publish_debounce_sec: 30, healthcheck_path: '/', status: 'active', php_settings: JSON.stringify({}),
  }).returning('id'))[0].id);

  // ── deps ──
  const sqlRuns: ContainmentSqlInstance[][] = [];
  let firewallFails = false;
  const inst = (over: Partial<ContainmentSqlInstance>): ContainmentSqlInstance => ({
    instanceId: 1, name: 'main', engine: 'mariadb', state: 'closed', reason: null, killed: 0, kept: 0, remaining: 0, sessions: [], error: null, ...over,
  });
  const order: string[] = [];
  const mails: Array<[number, string | null]> = [];
  const selfService = new Set<number>([SOLO]);
  const notifications: Array<{ event: string; message: string }> = [];
  const killed: number[] = [];
  const { killSessionsForUser } = await import('../userSessions.service');
  setContainmentDepsForTests({
    applyFileServer: async () => {},
    syncFirewall: async () => { order.push('firewall'); if (firewallFails) throw new Error('hostd refused'); },
    closeExternalSql: async () => { order.push('sql'); return sqlRuns.shift() ?? []; },
    stopPreviews: async () => 0,
    closeConsoles: async () => 0,
    closeDbSessions: async () => 0,
    closeWindow: async (siteId, windowId) => { await db('maintenance_windows').where({ id: windowId, site_id: siteId }).update({ status: 'pending_review', overlay: 'ro', closed_at: new Date() }); },
    freezeSite: async () => ({ liveReleaseNumber: null, liveCommit: null, stagingCommit: null, entries: [], note: 'noRepository' }),
    killSessions: async (userId) => { killed.push(userId); return killSessionsForUser(userId, 'test'); },
    canSelfReset: async (userId) => selfService.has(userId),
    sendForcedReset: async (userId, ip) => { mails.push([userId, ip]); return 'sent'; },
    notify: (event, payload) => { notifications.push({ event, message: payload.message }); },
  });
  setFirewallBackendsForTests({
    hostd: (() => ({ applyFirewall: async () => {} })) as never,
    localNode: async () => nodeId,
    now: () => new Date(),
  });

  // ── app ──
  const app = express();
  app.use(express.json());
  app.use(captureStepUpProof);
  app.post('/auth/login', (req, res, next) => { (req as unknown as { session: unknown }).session = { regenerate: (cb: (e?: unknown) => void) => cb() }; void authController.login(req, res, next); });
  app.use('/accounts', (req, _res, next) => {
    const r = req as unknown as { session: Record<string, unknown>; tenantId: number; sessionID: string };
    r.session = { userId: Number(req.header('x-user')), role: 'admin', currentTenantId: A };
    r.sessionID = `sid-${req.header('x-user')}`;
    r.tenantId = A;
    next();
  }, containmentRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const code = async () => {
    await db('users').where({ id: STAFF }).update({ totp_last_step: null });
    return new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  };
  const panel = async (method: string, url: string, body?: Record<string, unknown>) => {
    const r = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', 'x-user': String(STAFF) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: JSON.parse(text) as Json, text };
  };
  const contain = async () => panel('POST', `/accounts/${acct}/containment`, { twoFactorCode: await code() });
  const lift = async () => panel('POST', `/accounts/${acct}/containment/lift`, { twoFactorCode: await code() });
  const login = async (username: string, password: string) => {
    const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    return { status: r.status, body: await r.json() as Json };
  };
  const stepOf = (report: Json, key: string) => (report.steps as Json[]).find((s) => s.key === key) as Json;
  const flag = async (id: number) => (await db('users').where({ id }).first('password_reset_required_at')).password_reset_required_at as Date | null;
  const mkToken = async (userId: number, email: string) => {
    const token = newLinkToken();
    await db('user_action_tokens').insert({ user_id: userId, purpose: 'password_reset', token_hash: linkTokenHash(token), email, expires_at: new Date(Date.now() + 600_000) });
    return token;
  };
  const session = async (userId: number) => db('session').insert({ sid: `s-${userId}-${Date.now()}`, sess: JSON.stringify({ userId, cookie: {} }), expire: new Date(Date.now() + 3600_000) });
  const sessionsOf = async (userId: number) => Number((await db.raw("SELECT COUNT(*) AS n FROM session WHERE sess::jsonb ->> 'userId' = ?", [String(userId)]) as { rows: Array<{ n: string }> }).rows[0].n);

  await t.test('external SQL: after the firewall; a failure comes back on the resume and stops nothing else', async () => {
    firewallFails = true;
    sqlRuns.push([inst({ killed: 2, kept: 3, sessions: [{ user: 'app', ip: '203.0.113.7' }, { user: 'app', ip: '172.30.0.1' }] })]);
    await db('maintenance_windows').insert({ tenant_id: A, account_id: acct, site_id: site, number: 1, trigger: 'manual', status: 'open', overlay: 'rw', log: JSON.stringify([]) });
    const first = await contain();
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.data.status, 'partial');
    assert.deepEqual(order, ['firewall', 'sql'], 'the ports close first');
    assert.equal(stepOf(first.body.data, 'firewall').status, 'failed');
    const sql = stepOf(first.body.data, 'sqlSessions');
    assert.equal(sql.status, 'failed', 'ports still open: a session can come back');
    assert.match(sql.error, /not closed/);
    assert.equal(stepOf(first.body.data, 'publishMode').status, 'done', 'the next steps ran');
    assert.equal(stepOf(first.body.data, 'evidenceAudit').status, 'done');

    // Resume: the failed steps only, the killed sessions stay in the report.
    firewallFails = false;
    order.length = 0;
    sqlRuns.push([inst({ killed: 1, kept: 3, sessions: [{ user: 'late', ip: '198.51.100.9' }] })]);
    const second = await contain();
    assert.equal(second.body.data.status, 'active', JSON.stringify(second.body.data.steps));
    assert.deepEqual(order, ['firewall', 'sql']);
    assert.equal(stepOf(second.body.data, 'sqlSessions').count, 3);
    assert.deepEqual(second.body.data.sqlSessions[0].sessions.map((s: Json) => s.ip), ['203.0.113.7', '172.30.0.1', '198.51.100.9']);
    assert.equal(second.body.data.sqlSessions[0].killed, 3);
    const audit = await db('audit_logs').where({ action: 'account.contain_report' }).orderBy('id', 'desc').first('details');
    assert.equal(audit.details.sqlSessions[0].killed, 3, 'in the audit, hence in the frozen evidence');

    // Already active: nothing runs again.
    order.length = 0;
    assert.equal((await contain()).status, 200);
    assert.deepEqual(order, []);
  });

  await t.test('a closed window: the report says its content stays served, and links its review', async () => {
    const r = await panel('GET', `/accounts/${acct}/containment`);
    const [w] = r.body.data.reviewWindows;
    assert.equal(r.body.data.reviewWindows.length, 1);
    assert.equal(w.status, 'pending_review', 'closed by the containment, not decided');
    assert.equal(w.siteName, 'web');
    assert.equal(w.reviewPath, `/sites/${site}/windows/${w.windowId}`);
    assert.ok(w.closedAt);
    const told = notifications.find((n) => n.event === 'account.contained' && /reste servi/.test(n.message));
    assert.ok(told, 'the notification says it too');
  });

  await t.test('before the lift: who it concerns is announced, nothing is expired yet', async () => {
    const r = await panel('GET', `/accounts/${acct}/containment`);
    const resets = r.body.data.clientPasswordResets as Json[];
    assert.deepEqual(resets.map((c) => [c.username, c.selfService, c.otherAccounts, c.otherContained, c.mail]), [
      ['client-solo', true, 0, 0, null],
      ['client-multi', false, 1, 0, null],
    ]);
    assert.equal(await flag(SOLO), null);
    assert.equal(await flag(MULTI), null);
    // The other account of client-multi is not contained: the sign-in still works before the lift.
    assert.notEqual((await login('client-multi', OLD_PW)).status, 423);
    assert.equal((await login('client-solo', OLD_PW)).status, 423, 'every account contained');
  });

  let staleLink = '';
  await t.test('the lift: password expired everywhere, sessions closed, nothing secret in the answer', async () => {
    staleLink = await mkToken(SOLO, 'solo@example.test');
    await session(SOLO);
    await session(MULTI);
    const before = await db('users').whereIn('id', [SOLO, MULTI]).orderBy('id').select('credential_version', 'password_hash');
    const r = await lift();
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.data.clientPasswordResets.map((c: Json) => [c.username, c.mail]), [['client-solo', 'sent'], ['client-multi', 'unavailable']]);
    assert.deepEqual(mails.map((m) => m[0]), [SOLO], 'no mail without a way to use it');
    assert.ok(await flag(SOLO));
    assert.ok(await flag(MULTI), 'a client with another account is treated the same: the password belongs to the login');
    assert.deepEqual(killed.filter((id) => id === MULTI).length, 2, 'at the containment and at the lift');
    assert.equal(await sessionsOf(MULTI), 0);
    assert.equal(await sessionsOf(SOLO), 0);
    const after = await db('users').whereIn('id', [SOLO, MULTI]).orderBy('id').select('credential_version', 'password_hash');
    after.forEach((u, i) => {
      assert.equal(u.credential_version, before[i].credential_version + 1);
      assert.equal(u.password_hash, before[i].password_hash, 'the hash is kept: the same password can be refused');
    });
    assert.ok(!r.text.includes(hash), 'no hash in the answer');
    assert.ok(!/password_hash|token_hash/.test(r.text));
    const audit = await db('audit_logs').where({ action: 'account.contain_lift' }).orderBy('id', 'desc').first('details');
    assert.deepEqual(audit.details.clientResets.map((c: Json) => c.mail), ['sent', 'unavailable']);
    assert.ok(!JSON.stringify(audit.details).includes(hash));
    assert.match(notifications.at(-1)?.message ?? '', /nouveau mot de passe/);
    // Frozen in the report: it no longer follows the accounts.
    const read = await panel('GET', `/accounts/${acct}/containment`);
    assert.deepEqual(read.body.data.clientPasswordResets.map((c: Json) => c.mail), ['sent', 'unavailable']);
  });

  await t.test('the old password is refused; only the holder of the right one learns why', async () => {
    const refused = await login('client-multi', OLD_PW);
    assert.deepEqual([refused.status, refused.body.code], [403, 'passwordResetRequired']);
    assert.equal(refused.body.data, undefined, 'no session, no user');
    assert.equal((await login('client-multi', 'not-the-password-012345')).status, 401);
    const audit = await db('audit_logs').where({ action: 'auth.login_refused', user_id: MULTI }).orderBy('id', 'desc').first('details');
    assert.equal(audit.details.reason, 'password_reset_required');
  });

  await t.test('a link from before the lift no longer resets; the existing path does, never with the old password', async () => {
    await assert.rejects(identityService.confirmPasswordReset(staleLink, NEW_PW, null), (e: { code?: string }) => e.code === 'invalidToken');
    const link = await mkToken(SOLO, 'solo@example.test');
    await assert.rejects(identityService.confirmPasswordReset(link, OLD_PW, null), (e: { code?: string }) => e.code === 'passwordReused');
    assert.ok(await flag(SOLO), 'still expired');
    assert.equal((await identityService.passwordResetTokenState(link)).valid, true, 'the link survives a refused password');
    await identityService.confirmPasswordReset(link, NEW_PW, null);
    assert.equal(await flag(SOLO), null, 'cleared by the change itself');
    assert.equal((await login('client-solo', OLD_PW)).status, 401);
    assert.equal((await login('client-solo', NEW_PW)).status, 200);
  });

  await t.test('the staff path: same rule, no self-service needed', async () => {
    await assert.rejects(userService.changePassword(MULTI, OLD_PW), (e: { code?: string }) => e.code === 'passwordReused');
    assert.equal(await userService.changePassword(MULTI, NEW_PW), true);
    assert.equal(await flag(MULTI), null);
    assert.equal((await login('client-multi', NEW_PW)).status, 200);
    // Without an expired password, the same password is nobody's business.
    assert.equal(await userService.changePassword(MULTI, NEW_PW), true);
  });

  await t.test('a client of two contained accounts: lifting one leaves the other barred, each lift expires', async () => {
    const OTHER_TWO = await mkClient('client-both');
    await db('account_users').insert([{ user_id: OTHER_TWO, account_id: acct, capabilities: caps }, { user_id: OTHER_TWO, account_id: other, capabilities: caps }]);
    sqlRuns.push([]);
    assert.equal((await contain()).body.data.status, 'active');
    sqlRuns.push([]);
    assert.equal((await panel('POST', `/accounts/${other}/containment`, { twoFactorCode: await code() })).body.data.status, 'active');
    const read = await panel('GET', `/accounts/${acct}/containment`);
    const both = (read.body.data.clientPasswordResets as Json[]).find((c) => c.username === 'client-both') as Json;
    assert.deepEqual([both.otherAccounts, both.otherContained], [0, 1]);
    await lift();
    assert.ok(await flag(OTHER_TWO));
    assert.equal((await login('client-both', OLD_PW)).status, 403);
    await userService.changePassword(OTHER_TWO, NEW_PW);
    assert.equal(await flag(OTHER_TWO), null);
    assert.equal((await panel('POST', `/accounts/${other}/containment/lift`, { twoFactorCode: await code() })).status, 200);
    assert.ok(await flag(OTHER_TWO), 'expired again by the second lift');
  });

  await t.test('a containment started before this version resumes with the new step', async () => {
    sqlRuns.push([inst({ state: 'unreliable', reason: 'unknownNetwork' })]);
    const row = (await contain()).body.data;
    assert.equal(row.status, 'active');
    assert.deepEqual(row.sqlSessions.map((i: Json) => [i.state, i.reason, i.killed]), [['unreliable', 'unknownNetwork', 0]], 'the report says nothing was cut');
    assert.equal(stepOf(row, 'sqlSessions').status, 'done', 'not retried for ever: a human checks');
    const rows = await db('account_containments').where({ account_id: acct }).whereNot('status', 'lifted').first('id', 'steps');
    await db('account_containments').where({ id: rows.id }).update({
      status: 'partial', sql_sessions: '[]', steps: JSON.stringify((rows.steps as Json[]).filter((s) => s.key !== 'sqlSessions')),
    });
    order.length = 0;
    sqlRuns.push([inst({ killed: 1 })]);
    const resumed = await contain();
    assert.equal(resumed.body.data.status, 'active', JSON.stringify(resumed.body.data.steps));
    assert.equal(stepOf(resumed.body.data, 'sqlSessions').count, 1);
    assert.deepEqual(order, ['sql']);
    assert.equal(resumed.body.data.steps[5].key, 'sqlSessions', 'in its place');
    assert.equal((await lift()).status, 200);
  });

  await t.test('migration 044: down then up', async () => {
    const m = await import('../../db/migrations/044_containment_followup');
    await db('releases').insert({ site_id: site, number: 77, status: 'withdrawn', trigger: 'manual', log: '[]', on_disk: false });
    await db('users').where({ id: SOLO }).update({ password_reset_required_at: new Date() });
    await m.down(db);
    const cols = await db('users').columnInfo();
    assert.equal('password_reset_required_at' in cols, false);
    const ccols = await db('account_containments').columnInfo();
    assert.equal('sql_sessions' in ccols, false);
    assert.equal('client_resets' in ccols, false);
    assert.equal((await db('releases').where({ site_id: site, number: 77 }).first('status')).status, 'rejected', 'nothing is lost nor resurrected');
    await assert.rejects(db('releases').insert({ site_id: site, number: 78, status: 'withdrawn', trigger: 'manual', log: '[]', on_disk: false }), /releases_status_check/);
    await db('users').where({ id: SOLO }).update({ password_hash: hash }); // the trigger is gone with its column
    await m.up(db);
    assert.ok('password_reset_required_at' in await db('users').columnInfo());
    await db('releases').insert({ site_id: site, number: 78, status: 'withdrawn', trigger: 'manual', log: '[]', on_disk: false });
    await db('users').where({ id: SOLO }).update({ password_reset_required_at: new Date() });
    await db('users').where({ id: SOLO }).update({ preferred_language: 'en' });
    assert.ok(await flag(SOLO), 'another column does not clear it');
    await db('users').where({ id: SOLO }).update({ password_hash: await hashPassword(NEW_PW) });
    assert.equal(await flag(SOLO), null, 'the password does');
    assert.ok(Array.isArray((await containmentService.latest({ id: acct, tenant_id: A }))?.sqlSessions));
  });
});
