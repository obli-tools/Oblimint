import { execFileSync } from 'child_process';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import * as OTPAuth from 'otpauth';

// ─────────────────────────────────────────────────────────────────────────────
// Containment of an account, on a real PostgreSQL (CONTAINMENT_TEST_DATABASE_URL;
// skipped when nothing listens), real routers (panel, /api/v1, /mcp, /site-api,
// /oauth/token), real git for the frozen diff, the firewall state as pushed to a
// fake hostd. Faked: the file server, previews, consoles, the window engine.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.CONTAINMENT_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55462/postgres';
const PLAIN_SFTP = 'old-sftp-password-0123456789';
const PLAIN_LOGIN = 'client-password-0123456789';

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

test('containment of an account', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) { t.skip(`no PostgreSQL at ${DB_URL}`); return; }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-contain-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'contain-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const { captureStepUpProof } = await import('../../middleware/captureStepUpProof');
  const v1Routes = (await import('../../routes/v1.routes')).default;
  const siteApiRoutes = (await import('../../routes/siteApi.routes')).default;
  const containmentRoutes = (await import('../../routes/containment.routes')).default;
  const { authController } = await import('../../controllers/auth.controller');
  const { mcpRouter } = await import('../apiKeys/mcp');
  const { oauthPublicRouter } = await import('../apiKeys/oauth');
  const { apiKeysService, hashKey } = await import('../apiKeys/apiKeys.service');
  const { actorForUser, loadAccount } = await import('../hosting/access');
  const { fileAccessService } = await import('../hosting/fileAccess.service');
  const { sitesService } = await import('../hosting/sites.service');
  const { accountsService } = await import('../hosting/accounts.service');
  const { siteTokenService } = await import('../windows/siteTokens');
  const { windowService } = await import('../windows/window.service');
  const { userCanPublish } = await import('../windows/guarantor');
  const { setFirewallBackendsForTests } = await import('../firewall/firewall.service');
  const { previewService } = await import('../previews/previews.service');
  const { containmentService, setContainmentDepsForTests } = await import('./containment.service');
  const { localPaths } = await import('../hosting/paths');
  const { releaseService, __releaseInternals } = await import('../releases/release.service');
  const { setReleaseDeps } = await import('../releases/deps');
  const { setScanner, noopScanner } = await import('../releases/scan');
  const tu = await import('../releases/testUtil');
  const { twoFactorService } = await import('../twoFactor.service');
  const { hashPassword } = await import('../../utils/crypto');
  const { resetStepUpFailuresForTests } = await import('../stepUp');

  await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
  await db.raw('CREATE SCHEMA public');
  await db.migrate.latest();
  t.after(async () => { setContainmentDepsForTests(null); setFirewallBackendsForTests(null); resetStepUpFailuresForTests(); await db.destroy(); });

  // ── fixtures ──
  const tenant = async (name: string) => Number((await db('tenants').insert({ name, slug: name.toLowerCase() }).returning('id'))[0].id);
  const A = await tenant('AlphaT');
  const B = await tenant('BravoT');
  const secrets = new Map<number, string>();
  const mkStaff = async (username: string, tenantId: number, totp = true) => {
    const secret = totp ? twoFactorService.generateTotpSecret(username).secret : null;
    const id = Number((await db('users').insert({
      username, role: 'admin', kind: 'staff', is_active: true, password_hash: 'x', totp_enabled: !!secret, totp_secret: secret, preferred_language: 'fr',
    }).returning('id'))[0].id);
    if (secret) secrets.set(id, secret);
    await db('user_tenants').insert({ user_id: id, tenant_id: tenantId, role: 'admin' });
    return id;
  };
  const STAFF = await mkStaff('staff-a', A);
  const STAFF_B = await mkStaff('staff-b', B);
  const CLIENT = Number((await db('users').insert({
    username: 'client-a', role: 'user', kind: 'client', is_active: true, password_hash: await hashPassword(PLAIN_LOGIN), preferred_language: 'fr',
  }).returning('id'))[0].id);
  await db('user_tenants').insert({ user_id: CLIENT, tenant_id: A, role: 'client' });
  const nodeId = Number(((await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined)?.id
    ?? (await db('nodes').insert({ name: 'n1', is_local: true }).returning('id'))[0].id);
  const mkAccount = async (tenantId: number, username: string, uid: number) => {
    const [plan] = await db('plans').insert({ tenant_id: tenantId, name: `p-${username}`, limits: JSON.stringify({}) }).returning('id');
    return Number((await db('hosting_accounts').insert({
      tenant_id: tenantId, node_id: nodeId, plan_id: Number(plan.id ?? plan), username, uid, gid: uid, status: 'active', filesrv_mode: 'always', filesrv_port: uid - 19000,
      filesrv_password_hash: await hashPassword(PLAIN_SFTP), access_mode: 'open',
    }).returning('id'))[0].id);
  };
  const acct = await mkAccount(A, 'acmeone', 41001);
  const other = await mkAccount(A, 'acmetwo', 41002);
  await db('account_users').insert({ user_id: CLIENT, account_id: acct, capabilities: JSON.stringify(['sites.manage', 'files.manage', 'releases.publish', 'databases.manage']) });
  const mkSite = async (account: number, slug: string, mode: string) => Number((await db('sites').insert({
    tenant_id: A, account_id: account, name: slug, slug, base: 'nginx-static', docroot: '', base_path: '/', publish_mode: mode,
    publish_debounce_sec: 30, healthcheck_path: '/', status: 'active', php_settings: JSON.stringify({}),
  }).returning('id'))[0].id);
  const site1 = await mkSite(acct, 'web', 'auto');
  const site2 = await mkSite(acct, 'blog', 'manual');
  const siteOther = await mkSite(other, 'other', 'auto');

  const fakeReq = (userId: number) => ({ headers: {}, session: { userId }, socket: { remoteAddress: '203.0.113.7' }, get: () => undefined }) as never;

  // Real git for site1, with a live release and a staging that differs from it.
  const staging = localPaths.siteStaging(acct, 'web');
  setReleaseDeps({
    ...(tu.canSymlink() ? {} : { links: tu.emulatedLinkOps() }),
    reloadSite: async () => ({ ok: true, errors: [] }),
    probe: async () => ({ ok: true, status: 200, error: null }),
    sleep: async () => {},
    health: { attempts: 1, delayMs: 0, timeoutMs: 100 },
    hostd: () => ({ ensureDataPaths: async () => {}, seedDataPath: async () => ({ copied: false, files: 0 }), clearDataPaths: async () => {} }),
    windowBlocks: async () => false,
  });
  setScanner(noopScanner);
  fs.mkdirSync(staging, { recursive: true });
  await releaseService.ensureSiteStorage(site1);
  fs.writeFileSync(path.join(staging, 'index.html'), 'v1\n');
  const rel = await releaseService.publish(site1, { trigger: 'manual', userId: STAFF });
  for (const t0 = Date.now(); ;) {
    const r = await db('releases').where({ id: rel.id }).first('status');
    if (!['queued', 'scanning', 'publishing'].includes(r.status) && !__releaseInternals.locks.has(site1)) { assert.equal(r.status, 'ready'); break; }
    if (Date.now() - t0 > 60_000) throw new Error('release stuck');
    await new Promise((res) => setTimeout(res, 50));
  }
  fs.writeFileSync(path.join(staging, 'backdoor.php'), '<?php // planted\n');
  const liveRelease = (await db('sites').where({ id: site1 }).first('current_release_id')).current_release_id as number;
  assert.ok(liveRelease);

  // Credentials of the three families, a session, an SSH key.
  const clientActor = await actorForUser(CLIENT, A);
  const key = await apiKeysService.create(fakeReq(CLIENT), clientActor, acct, { name: 'agent', scopes: ['sites.manage', 'files.read', 'releases.publish'] as never, siteScope: 'all' });
  const connector = await apiKeysService.create(fakeReq(CLIENT), clientActor, acct, { name: 'claude', kind: 'connector', scopes: ['files.read'] as never, siteScope: 'all' });
  const oba = `oba_${'a'.repeat(43)}`;
  const obr = `obr_${'b'.repeat(43)}`;
  const future = new Date(Date.now() + 3_600_000);
  await db('api_key_oauth_tokens').insert([
    { key_id: connector.id, kind: 'access', token_hash: hashKey(oba), family: 'fam-1', user_id: CLIENT, expires_at: future },
    { key_id: connector.id, kind: 'refresh', token_hash: hashKey(obr), family: 'fam-1', user_id: CLIENT, expires_at: future },
  ]);
  const siteToken = await siteTokenService.create(fakeReq(CLIENT), clientActor, site1, { name: 'ci' });
  const otherKey = await apiKeysService.create(fakeReq(STAFF), await actorForUser(STAFF, A), other, { name: 'other', scopes: ['sites.manage'] as never, siteScope: 'all' });
  await db('session').insert({ sid: 'client-sess', sess: JSON.stringify({ userId: CLIENT }), expire: future });
  await db('session').insert({ sid: 'staff-sess', sess: JSON.stringify({ userId: STAFF }), expire: future });
  await db('account_ssh_keys').insert({ account_id: acct, name: 'laptop', public_key: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:abc', algorithm: 'ed25519' });
  await db('access_rules').insert({ account_id: acct, cidr: '198.51.100.9/32', label: 'mine' });
  await db('access_grants').insert({ account_id: acct, user_id: CLIENT, ip: '198.51.100.10', family: 4, expires_at: future });
  const [inst] = await db('db_instances').insert({
    tenant_id: A, account_id: acct, node_id: nodeId, name: 'db1', engine: 'mariadb', version: '11.4', profile: 'S', status: 'running', is_default: true, root_secret: 'keep-root-secret',
    external_enabled: true, external_port: 33101,
  }).returning('id');
  const instId = Number(inst.id ?? inst);
  const setAt = new Date('2026-01-01T00:00:00Z');
  await db('db_users').insert({ instance_id: instId, account_id: acct, username: 'wpuser', password_set_at: setAt });
  const mkWindow = (siteId: number, status: string, baseRelease: number | null) => db('maintenance_windows').insert({
    tenant_id: A, account_id: acct, site_id: siteId, number: 1, trigger: 'manual', status, overlay: status === 'open' ? 'rw' : 'none', base_release_id: baseRelease, log: JSON.stringify([]),
  });
  await mkWindow(site1, 'open', liveRelease);
  await mkWindow(site2, 'opening', null);
  const [pa] = await db('pending_actions').insert({
    tenant_id: A, account_id: acct, action_key: 'files.write', level: 'sensitive', kind: 'confirm', via: 'key', requested_by: CLIENT, params_hmac: 'x', params_display: JSON.stringify({}),
    description: 'x', status: 'approved', expires_at: future,
  }).returning('id');

  // Audit rows on and around the span.
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
  await db('audit_logs').insert([
    { tenant_id: A, action: 'test.inside', resource_type: 'account', resource_path: String(acct), created_at: hoursAgo(71) },
    { tenant_id: A, action: 'test.tooOld', resource_type: 'account', resource_path: String(acct), created_at: hoursAgo(73) },
    { tenant_id: A, action: 'test.otherAccount', resource_type: 'account', resource_path: String(other), created_at: hoursAgo(1) },
    { tenant_id: B, action: 'test.otherTenant', resource_type: 'account', resource_path: String(acct), created_at: hoursAgo(1) },
    { tenant_id: A, action: 'test.clientUser', user_id: CLIENT, resource_type: 'domain', resource_path: '99', created_at: hoursAgo(2) },
  ]);

  // ── faked backends ──
  const calls = { apply: 0, previews: 0, consoles: 0, closed: [] as number[], notified: [] as string[] };
  let failApply = true;
  setContainmentDepsForTests({
    applyFileServer: async () => {
      calls.apply += 1;
      if (failApply) throw new Error('hostd unreachable');
    },
    stopPreviews: async () => { calls.previews += 1; return 0; },
    closeConsoles: async () => { calls.consoles += 1; return 0; },
    closeWindow: async (siteId, windowId) => {
      calls.closed.push(windowId);
      await db('maintenance_windows').where({ id: windowId, site_id: siteId }).update({ status: 'closing', overlay: 'ro' });
    },
    notify: (event) => { calls.notified.push(event); },
  });
  const pushed: Array<{ accountId: number; mode: string; allow: unknown[]; publishedPorts: number[]; gatewayPorts: number[] }> = [];
  setFirewallBackendsForTests({
    hostd: (() => ({ applyFirewall: async (s: (typeof pushed)[number]) => { pushed.push(s); } })) as never,
    localNode: async () => nodeId,
    now: () => new Date(),
  });

  // ── app ──
  const app = express();
  app.use(express.json());
  app.use(captureStepUpProof);
  app.post('/auth/login', (req, res, next) => { (req as unknown as { session: unknown }).session = { regenerate: (cb: (e?: unknown) => void) => cb() }; void authController.login(req, res, next); });
  app.use('/api/v1', v1Routes);
  app.use('/mcp', mcpRouter);
  app.use('/site-api', siteApiRoutes);
  app.use(oauthPublicRouter);
  app.use('/accounts', (req, _res, next) => {
    const r = req as unknown as { session: Record<string, unknown>; tenantId: number; sessionID: string };
    r.session = { userId: Number(req.header('x-user')), role: 'admin', currentTenantId: Number(req.header('x-tenant')) };
    r.sessionID = `sid-${req.header('x-user')}`;
    r.tenantId = Number(req.header('x-tenant'));
    next();
  }, containmentRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const code = async (userId: number) => {
    await db('users').where({ id: userId }).update({ totp_last_step: null });
    return new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secrets.get(userId) as string) }).generate();
  };
  const panel = async (userId: number, tenantId: number, method: string, url: string, body?: Record<string, unknown>) => {
    const r = await fetch(`${base}${url}`, {
      method, headers: { 'content-type': 'application/json', 'x-user': String(userId), 'x-tenant': String(tenantId) }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() as Json };
  };
  const contain = async (body: Record<string, unknown> = {}) => panel(STAFF, A, 'POST', `/accounts/${acct}/containment`, { ...body, twoFactorCode: await code(STAFF) });
  const bearer = async (token: string, url: string, method = 'GET', body?: unknown, type = 'application/json') => {
    const r = await fetch(`${base}${url}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': type }, body: body === undefined ? undefined : JSON.stringify(body) });
    let j: Json = {};
    try { j = await r.json() as Json; } catch { /* empty */ }
    return { status: r.status, body: j };
  };
  const refusal = async (fn: () => Promise<unknown>): Promise<{ status?: number; code?: string }> => {
    try {
      await fn();
    } catch (err) {
      return { status: (err as { statusCode?: number }).statusCode, code: (err as { code?: string }).code };
    }
    return {};
  };
  const stepOf = (report: Json, key: string) => (report.steps as Json[]).find((s) => s.key === key) as Json;
  const accountRow = () => db('hosting_accounts').where({ id: acct }).first();
  const mcpCall = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

  await t.test('a publication in flight when the barrier falls goes no further than a human', async () => {
    const racing = await mkAccount(A, 'acmethree', 41003);
    const siteRacing = await mkSite(racing, 'race', 'manual');
    const dir = localPaths.siteStaging(racing, 'race');
    fs.mkdirSync(dir, { recursive: true });
    await releaseService.ensureSiteStorage(siteRacing);
    fs.writeFileSync(path.join(dir, 'index.html'), 'race\n');
    setScanner({
      name: 'contains-during-the-scan',
      async scan() {
        await db('hosting_accounts').where({ id: racing }).update({ contained_at: new Date() });
        return { scanner: 'none', verdict: 'clean', findings: [] };
      },
    });
    t.after(() => setScanner(noopScanner));
    const flying = await releaseService.publish(siteRacing, { trigger: 'manual', userId: STAFF });
    for (const t0 = Date.now(); ;) {
      const r = await db('releases').where({ id: flying.id }).first('status');
      if (!['queued', 'scanning', 'publishing'].includes(r.status) && !__releaseInternals.locks.has(siteRacing)) { assert.equal(r.status, 'awaiting_approval'); break; }
      if (Date.now() - t0 > 60_000) throw new Error('release stuck');
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.equal((await db('sites').where({ id: siteRacing }).first('current_release_id')).current_release_id, null);
    setScanner(noopScanner);
  });

  await t.test('before: the credentials work', async () => {
    assert.equal((await bearer(key.key as string, '/api/v1/sites')).status, 200);
    assert.equal((await bearer(key.key as string, '/mcp', 'POST', mcpCall)).status, 200);
    assert.equal((await bearer(oba, '/mcp', 'POST', mcpCall)).status, 200);
    assert.equal((await bearer(siteToken.token, '/site-api/window')).status, 200);
  });

  await t.test('only the staff of the tenant, and always under step-up', async () => {
    assert.equal((await panel(CLIENT, A, 'POST', `/accounts/${acct}/containment`, {})).status, 403, 'a client cannot contain');
    assert.equal((await panel(STAFF_B, B, 'POST', `/accounts/${acct}/containment`, { twoFactorCode: await code(STAFF_B) })).status, 404, 'other tenant: invisible');
    assert.equal((await panel(STAFF_B, B, 'GET', `/accounts/${acct}/containment`)).status, 404);
    const noCode = await panel(STAFF, A, 'POST', `/accounts/${acct}/containment`, {});
    assert.equal(noCode.status, 401);
    assert.equal(noCode.body.twoFactorRequired, true);
    assert.equal((await accountRow()).contained_at, null, 'nothing happened');
    assert.equal(Number((await db('account_containments').count<{ n: string }[]>('* as n'))[0].n), 0);
  });

  let hashAfterCut = '';
  await t.test('failure in the middle: the barrier stands, the other steps ran, the report says which', async () => {
    const r = await contain({ reason: 'clé volée' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const rep = r.body.data as Json;
    assert.equal(rep.status, 'partial');
    assert.equal(stepOf(rep, 'sftp').status, 'failed');
    assert.match(stepOf(rep, 'sftp').error, /hostd unreachable/);
    assert.equal(stepOf(rep, 'windows').status, 'failed');
    assert.match(stepOf(rep, 'windows').error, /still opening/);
    assert.equal(stepOf(rep, 'verify').status, 'pending');
    for (const k of ['keys', 'siteTokens', 'sessions', 'firewall', 'previews', 'pendingActions', 'consoles', 'publishMode', 'evidenceStaging', 'evidenceAudit']) {
      assert.equal(stepOf(rep, k).status, 'done', `${k}: ${stepOf(rep, k).error}`);
    }
    assert.equal(stepOf(rep, 'keys').count, 2);
    assert.equal(stepOf(rep, 'siteTokens').count, 1);
    const a = await accountRow();
    assert.ok(a.contained_at);
    assert.equal(a.filesrv_mode, 'off', 'cut in the database even though hostd failed');
    hashAfterCut = a.filesrv_password_hash;
    assert.ok(hashAfterCut);
    assert.equal(calls.closed.length, 1, 'the open window closed, the opening one left');
    assert.equal((await bearer(key.key as string, '/api/v1/sites')).status, 423, 'agents already refused');
    assert.deepEqual(calls.notified, ['account.contained']);
  });

  await t.test('resume: only what failed runs again, nothing already done is redone', async () => {
    failApply = false;
    await db('maintenance_windows').where({ site_id: site2 }).update({ status: 'open', overlay: 'rw' });
    const before = { ...calls, closed: [...calls.closed] };
    const r = await contain();
    assert.equal(r.status, 200);
    const rep = r.body.data as Json;
    assert.equal(rep.status, 'active', JSON.stringify(rep.steps));
    assert.ok(rep.steps.every((s: Json) => s.status === 'done'));
    assert.ok(rep.completedAt);
    assert.equal(calls.previews, before.previews, 'previews not stopped twice');
    assert.equal(calls.consoles, before.consoles);
    assert.equal(calls.closed.length, before.closed.length + 1, 'only the second window');
    const a = await accountRow();
    assert.equal(a.filesrv_password_hash, hashAfterCut, 'the password is not rotated twice');
    const row = await db('account_containments').where({ account_id: acct }).first();
    assert.equal(row.previous.filesrvMode, 'always', 'the mode to restore is kept');
    assert.deepEqual(row.previous.publishModes, { [site1]: 'auto', [site2]: 'manual' });
  });

  await t.test('idempotent: again on a finished one, the report and nothing else', async () => {
    const audits = async () => Number((await db('audit_logs').where('action', 'like', 'account.contain%').count<{ n: string }[]>('* as n'))[0].n);
    const before = { audits: await audits(), apply: calls.apply, notified: calls.notified.length };
    const r = await contain();
    assert.equal(r.status, 200);
    assert.equal(r.body.data.status, 'active');
    assert.equal(await audits(), before.audits);
    assert.equal(calls.apply, before.apply);
    assert.equal(calls.notified.length, before.notified);
    assert.equal(Number((await db('account_containments').where({ account_id: acct }).count<{ n: string }[]>('* as n'))[0].n), 1);
  });

  await t.test('423 accountContained on every agent surface', async () => {
    const checks = [
      await bearer(key.key as string, '/api/v1/sites'),
      await bearer(key.key as string, '/mcp', 'POST', mcpCall),
      await bearer(oba, '/mcp', 'POST', mcpCall),
      await bearer(siteToken.token, '/site-api/window'),
      await bearer(siteToken.token, '/site-api/window', 'POST', {}),
    ];
    for (const c of checks) {
      assert.equal(c.status, 423, JSON.stringify(c.body));
      assert.equal(c.body.code, 'accountContained');
    }
    const refresh = await fetch(`${base}/oauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: obr, client_id: connector.oauthClientId as string }).toString(),
    });
    assert.equal(refresh.status, 423);
    assert.equal((await refresh.json() as Json).code, 'accountContained');
    // An agent that insists is never mistaken for a brute force (20 refused keys per 15 min), nor anything else told.
    for (let i = 0; i < 25; i++) assert.equal((await bearer(key.key as string, '/api/v1/sites')).status, 423);
    assert.equal((await bearer(`obk_999999_${'c'.repeat(43)}`, '/api/v1/sites')).status, 401, 'an unknown key learns nothing');
    assert.equal((await bearer(otherKey.key as string, '/api/v1/sites')).status, 200, 'the other account of the tenant is untouched');
  });

  await t.test('what the containment revoked is gone', async () => {
    assert.equal(Number((await db('api_keys').where({ account_id: acct }).count<{ n: string }[]>('* as n'))[0].n), 0);
    assert.equal(Number((await db('api_key_oauth_tokens').count<{ n: string }[]>('* as n'))[0].n), 0);
    assert.equal(Number((await db('site_api_tokens').where({ account_id: acct }).count<{ n: string }[]>('* as n'))[0].n), 0);
    assert.equal(Number((await db('account_ssh_keys').where({ account_id: acct }).count<{ n: string }[]>('* as n'))[0].n), 0);
    assert.equal(Number((await db('access_grants').where({ account_id: acct }).count<{ n: string }[]>('* as n'))[0].n), 0);
    assert.equal(await db('session').where({ sid: 'client-sess' }).first(), undefined, 'the session of the client');
    assert.ok(await db('session').where({ sid: 'staff-sess' }).first(), 'never the staff');
    assert.equal((await db('pending_actions').where({ id: pa.id }).first('status')).status, 'cancelled');
    assert.equal((await fileAccessService.verifyLogin(acct, { username: 'acmeone', password: PLAIN_SFTP })).ok, false);
    assert.equal(await db('sites').where({ account_id: acct }).whereNot('publish_mode', 'approval').first('id'), undefined);
    assert.equal((await db('sites').where({ id: siteOther }).first('publish_mode')).publish_mode, 'auto', 'other account untouched');
    assert.equal((await db('hosting_accounts').where({ id: other }).first('filesrv_mode')).filesrv_mode, 'always');
  });

  await t.test('no access can be created during the containment', async () => {
    const staff = await actorForUser(STAFF, A);
    const client = await actorForUser(CLIENT, A);
    const row = await db('hosting_accounts').where({ id: acct }).first();
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['staff: new key', () => apiKeysService.create(fakeReq(STAFF), staff, acct, { name: 'new', scopes: ['sites.manage'] as never, siteScope: 'all' })],
      ['client: new key', () => apiKeysService.create(fakeReq(CLIENT), client, acct, { name: 'new', scopes: ['sites.manage'] as never, siteScope: 'all' })],
      ['staff: new window token', () => siteTokenService.create(fakeReq(STAFF), staff, site1, { name: 'new' })],
      ['client: new window token', () => siteTokenService.create(fakeReq(CLIENT), client, site1, { name: 'new' })],
      ['new SFTP password', () => fileAccessService.resetPassword(fakeReq(STAFF), row)],
      ['SFTP back on', () => fileAccessService.setMode(fakeReq(STAFF), row, 'always')],
      ['new SSH key', () => fileAccessService.addKey(fakeReq(STAFF), row, { name: 'k', publicKey: 'ssh-ed25519 AAAA' })],
      ['staff: new window', () => windowService.open(fakeReq(STAFF), staff, site2, { durationMinutes: 30 })],
      ['client: new window', () => windowService.open(fakeReq(CLIENT), client, site2, { durationMinutes: 30 })],
      ['token / schedule: new window', () => windowService.openInternal(site2, { trigger: 'api', userId: null, durationMinutes: 30, note: null })],
      ['supervised: window back', () => windowService.openInternal(site2, { trigger: 'supervised', userId: null, durationMinutes: null, note: null })],
      ['leaving the approval mode', () => sitesService.update(fakeReq(STAFF), staff, site1, { publishMode: 'auto' })],
      ['new site', () => sitesService.create(fakeReq(STAFF), staff, { accountId: acct, name: 'n', slug: 'n', base: 'nginx-static' } as never)],
      ['preview', () => previewService.start(fakeReq(STAFF), staff, site1, { target: 'staging' } as never)],
      ['account deletion', () => accountsService.remove(fakeReq(STAFF), staff, acct, 'acmeone')],
    ];
    for (const [name, fn] of cases) {
      const r = await refusal(fn);
      assert.equal(r.code, 'accountContained', `${name}: ${JSON.stringify(r)}`);
      assert.equal(r.status, 423, name);
    }
    assert.equal(await userCanPublish(CLIENT, { tenantId: A, accountId: acct }), false, 'unattended paths disarmed');
    assert.equal(await userCanPublish(STAFF, { tenantId: A, accountId: acct }), false);
    // A client keeps only read, and is told why.
    assert.equal(client.kind === 'client' && client.accounts.get(acct)?.size, 0);
    assert.ok(await loadAccount(client, acct, 'read'));
    assert.equal((await refusal(() => loadAccount(client, acct, 'files.manage'))).status, 423);
    assert.equal((await refusal(() => loadAccount(client, acct, 'accounts.manage'))).status, 403, 'a need no client holds stays 403');
    // A stolen password stops at the login.
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'client-a', password: PLAIN_LOGIN }) });
    assert.equal(login.status, 423);
    assert.equal((await login.json() as Json).code, 'accountContained');
  });

  await t.test('the site keeps serving, the database passwords are left alone, the ports close without touching a container', async () => {
    const a = await accountRow();
    assert.equal(a.status, 'active', 'never suspended');
    const s = await db('sites').where({ id: site1 }).first();
    assert.equal(s.status, 'active');
    assert.equal(s.current_release_id, liveRelease);
    const i = await db('db_instances').where({ id: instId }).first();
    assert.equal(i.external_enabled, true, 'the instance is not touched: closing it would recreate its container');
    assert.equal(i.external_port, 33101);
    assert.equal(i.root_secret, 'keep-root-secret');
    assert.equal(i.status, 'running');
    const u = await db('db_users').where({ instance_id: instId, username: 'wpuser' }).first();
    assert.equal(new Date(u.password_set_at).getTime(), setAt.getTime());
    const state = pushed.filter((p) => p.accountId === acct).at(-1);
    assert.ok(state);
    assert.equal(state.mode, 'allowlist');
    assert.deepEqual(state.allow, [], 'neither the rules nor the grants');
    assert.deepEqual(state.publishedPorts, [33101], 'the external SQL port is under the filter');
    assert.ok(await db('access_rules').where({ account_id: acct, cidr: '198.51.100.9/32' }).first(), 'the rule is kept for after the lift');
  });

  await t.test('evidence: diff, credentials and audit frozen on ±72 h, without a secret', async () => {
    const r = await panel(STAFF, A, 'GET', `/accounts/${acct}/containment`);
    assert.equal(r.status, 200);
    const rep = r.body.data as Json;
    const f1 = (rep.sites as Json[]).find((s) => s.siteId === site1) as Json;
    assert.ok(f1.entries.some((e: Json) => e.path === 'backdoor.php'), JSON.stringify(f1));
    assert.ok(f1.liveCommit);
    const repo = localPaths.repo(acct, site1);
    const refs = execFileSync('git', ['--git-dir', repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/oblimint/containment/'], { encoding: 'utf8' });
    assert.ok(refs.includes(`/live ${f1.liveCommit}`), refs);
    assert.ok(refs.includes(`/staging ${f1.stagingCommit}`), refs);
    const planted = execFileSync('git', ['--git-dir', repo, 'show', `${f1.stagingCommit}:backdoor.php`], { encoding: 'utf8' });
    assert.match(planted, /planted/, 'the file itself is kept');
    assert.equal((rep.sites as Json[]).find((s) => s.siteId === site2)?.note, 'noRepository');
    assert.equal(new Date(rep.auditUntil).getTime() - new Date(rep.startedAt).getTime(), 72 * 3_600_000);

    const names = (rep.credentials as Json[]).map((c) => `${c.family}:${c.name}`).sort();
    assert.deepEqual(names, ['connector:claude', 'key:agent', 'siteToken:ci', 'sshKey:laptop']);
    const text = JSON.stringify(rep);
    for (const secret of [key.key as string, siteToken.token, hashKey(key.key as string), oba, obr]) assert.ok(!text.includes(secret), 'no secret in the report');
    assert.deepEqual(rep.accessRules.map((x: Json) => x.cidr), ['198.51.100.9/32']);

    const audit = await panel(STAFF, A, 'GET', `/accounts/${acct}/containment/audit?limit=500`);
    const actions = (audit.body.data.items as Json[]).map((x) => x.action);
    for (const a of ['test.inside', 'test.clientUser', 'account.contain', 'account.contain_report']) assert.ok(actions.includes(a), `${a} in ${actions}`);
    for (const a of ['test.tooOld', 'test.otherAccount', 'test.otherTenant']) assert.ok(!actions.includes(a), a);
    assert.equal((await panel(STAFF_B, B, 'GET', `/accounts/${acct}/containment/audit`)).status, 404);
    assert.equal((await panel(CLIENT, A, 'GET', `/accounts/${acct}/containment/audit`)).status, 403);

    // The rows of the next 72 h join the evidence, and the live rows may go: the copy stays.
    await db('audit_logs').insert({ tenant_id: A, action: 'test.after', resource_type: 'account', resource_path: String(acct), created_at: new Date() });
    await containmentService.sweep();
    const again = await panel(STAFF, A, 'GET', `/accounts/${acct}/containment/audit?limit=500`);
    assert.ok((again.body.data.items as Json[]).some((x) => x.action === 'test.after'));
  });

  await t.test('a window opened in the race is closed by the worker', async () => {
    const n = calls.closed.length;
    await db('maintenance_windows').where({ site_id: site2 }).update({ status: 'open', overlay: 'rw' });
    await containmentService.sweep(new Date(), false);
    assert.equal(calls.closed.length, n + 1);
    await db('maintenance_windows').where({ site_id: site2 }).update({ status: 'discarded', overlay: 'none' });
  });

  await t.test('a key that appears during the containment is caught by the verification, and answers 423', async () => {
    const row = await db('api_keys').where({ id: otherKey.id }).first();
    const raw = `obk_900001_${'d'.repeat(43)}`;
    await db('api_keys').insert({
      ...row, id: 900001, account_id: acct, token_hash: hashKey(raw), prefix: 'obk_900001', name: 'race',
      scopes: JSON.stringify(row.scopes), allowed_ips: JSON.stringify(row.allowed_ips),
    });
    assert.equal((await bearer(raw, '/api/v1/sites')).status, 423, 'a live key of a contained account');
    // Interrupted before its verification: the resume finds the key and sends its step back…
    const live = await db('account_containments').where({ account_id: acct }).whereNot('status', 'lifted').first();
    const steps = (live.steps as Json[]).map((s) => (s.key === 'verify' ? { ...s, status: 'pending' } : s));
    await db('account_containments').where({ id: live.id }).update({ status: 'running', steps: JSON.stringify(steps) });
    const first = (await contain()).body.data as Json;
    assert.equal(first.status, 'partial');
    assert.match(stepOf(first, 'verify').error, /keys=1/);
    assert.equal(stepOf(first, 'keys').status, 'pending');
    // …and the next one revokes it.
    const second = (await contain()).body.data as Json;
    assert.equal(second.status, 'active', JSON.stringify(second.steps));
    assert.equal(await db('api_keys').where({ id: 900001 }).first('id'), undefined);
    assert.equal((await bearer(raw, '/api/v1/sites')).status, 423, 'and it still answers 423');
  });

  await t.test('lift: staff of the tenant only, fresh code; what was burnt stays burnt', async () => {
    const liftUrl = `/accounts/${acct}/containment/lift`;
    assert.equal((await panel(CLIENT, A, 'POST', liftUrl, {})).status, 403, 'a client cannot lift');
    assert.equal((await panel(STAFF_B, B, 'POST', liftUrl, { twoFactorCode: await code(STAFF_B) })).status, 404);
    const noCode = await panel(STAFF, A, 'POST', liftUrl, {});
    assert.equal(noCode.status, 401);
    assert.ok((await accountRow()).contained_at);

    const r = await panel(STAFF, A, 'POST', liftUrl, { note: 'incident clos', twoFactorCode: await code(STAFF) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.status, 'lifted');
    assert.equal(r.body.data.liftNote, 'incident clos');
    const a = await accountRow();
    assert.equal(a.contained_at, null);
    assert.equal(a.filesrv_mode, 'always', 'the mode comes back');
    assert.equal(a.filesrv_password_hash, hashAfterCut, 'not the old password');
    assert.equal((await db('sites').where({ id: site1 }).first('publish_mode')).publish_mode, 'auto');
    assert.equal((await db('sites').where({ id: site2 }).first('publish_mode')).publish_mode, 'manual');
    assert.deepEqual(calls.notified.at(-1), 'account.containmentLifted');
    assert.equal(pushed.filter((p) => p.accountId === acct).at(-1)?.mode, 'open');

    assert.equal((await bearer(key.key as string, '/api/v1/sites')).status, 401, 'the old key stays revoked, and is now just unknown');
    assert.equal((await bearer(oba, '/mcp', 'POST', mcpCall)).status, 401);
    assert.equal((await bearer(siteToken.token, '/site-api/window')).status, 401);
    assert.equal((await fileAccessService.verifyLogin(acct, { username: 'acmeone', password: PLAIN_SFTP })).ok, false);

    const client = await actorForUser(CLIENT, A);
    assert.ok(client.kind === 'client' && (client.accounts.get(acct)?.size ?? 0) > 0, 'the rights come back');
    const fresh = await apiKeysService.create(fakeReq(CLIENT), client, acct, { name: 'after', scopes: ['sites.manage'] as never, siteScope: 'all' });
    assert.equal((await bearer(fresh.key as string, '/api/v1/sites')).status, 200);
    const pw = await fileAccessService.resetPassword(fakeReq(CLIENT), a);
    assert.ok(pw.password);

    const twice = await panel(STAFF, A, 'POST', liftUrl, { twoFactorCode: await code(STAFF) });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.code, 'accountNotContained');
    const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'client-a', password: PLAIN_LOGIN }) });
    assert.notEqual(login.status, 423, 'the client signs in again');
  });

  await t.test('the evidence outlives the lift, and a new containment starts a new one', async () => {
    const rep = await containmentService.latest({ id: acct, tenant_id: A });
    assert.equal(rep?.status, 'lifted');
    assert.ok((rep?.auditCount ?? 0) > 0);
    assert.ok(rep?.sites.length);
    const r = await contain({ reason: 'récidive' });
    assert.equal(r.body.data.status, 'active', JSON.stringify(r.body.data.steps));
    assert.notEqual(r.body.data.id, rep?.id);
    assert.equal((await bearer(key.key as string, '/api/v1/sites')).status, 401, 'revoked by the first one: unknown to the second');
    assert.equal(r.body.data.steps.find((s: Json) => s.key === 'keys').count, 1, 'the key created after the first lift');
  });

  await t.test('without a second factor the staff is refused: the step-up has no bypass', async () => {
    const NOFACTOR = await mkStaff('staff-nofactor', A, false);
    const r = await panel(NOFACTOR, A, 'POST', `/accounts/${other}/containment`, {});
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'twoFactorNotEnrolled');
    assert.equal((await db('hosting_accounts').where({ id: other }).first('contained_at')).contained_at, null);
  });

  await t.test('migration 042 is reversible', async () => {
    const m = await import('../../db/migrations/042_account_containment');
    await db('containment_audit_freeze').del();
    await m.down(db);
    assert.equal(await db.schema.hasColumn('hosting_accounts', 'contained_at'), false);
    assert.equal(await db.schema.hasTable('account_containments'), false);
    await m.up(db);
    assert.equal(await db.schema.hasColumn('hosting_accounts', 'contained_at'), true);
  });
});
