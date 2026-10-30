import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Request } from 'express';
import * as OTPAuth from 'otpauth';

// ─────────────────────────────────────────────────────────────────────────────
// Sensitive actions on a real PostgreSQL (PA_TEST_DATABASE_URL; skipped when
// nothing listens): the gate (panel and access keys), pending confirmations /
// approvals (single use, races, fingerprint, level changes, expiry), the
// approvers computed from the database (non-leak between accounts and
// tenants), the notification family 'approvals', the matrix routes (tenant
// isolation, clients refused, platform floor, restrictions.manage gated),
// the step-up of a sensitive action (TOTP never reused, trusted IP 24 h,
// Obligate code of an SSO staff account), audit without secret.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.PA_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55901/postgres';

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

test('sensitive actions: gate, pending actions, approvers, matrix routes', { timeout: 600_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) { t.skip(`no PostgreSQL at ${DB_URL}`); return; }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-pa-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'pa-test-secret-0123456789abcdef0123';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const shared = await import('@oblimint/shared');
  const { AppError, errorHandler } = await import('../../middleware/errorHandler');
  const { captureStepUpProof } = await import('../../middleware/captureStepUpProof');
  const { gateAction, runGated } = await import('./gate');
  const { restrictionService } = await import('./restriction.service');
  const { sweep } = await import('./pendingActions.service');
  const { eligibleApprovers } = await import('./approvers');
  const { checkActionStepUp, resetStepUpFailuresForTests, STEP_UP_MAX_FAILURES } = await import('../stepUp');
  const { unlockRestrictionsManage, resetRestrictionsFloor } = await import('./unlock');
  const { setObligateTotpVerifierForTests } = await import('../obligate.service');
  const { actorCan, actorForUser } = await import('../hosting/access');
  const { platformSettings } = await import('../platformSettings');
  const { twoFactorService } = await import('../twoFactor.service');
  const restrictionsRoutes = (await import('../../routes/restrictions.routes')).default;
  const pendingRoutes = (await import('../../routes/pendingActions.routes')).default;

  await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
  await db.raw('CREATE SCHEMA public');
  await db.migrate.latest();
  t.after(async () => { setObligateTotpVerifierForTests(null); resetStepUpFailuresForTests(); await db.destroy(); });

  // ── migration 027 seeds the defaults (master: with the platform entries) ──
  const masterMap = await restrictionService.getMap(1);
  assert.equal(masterMap['db.drop']?.level, 'sensitive');
  assert.equal(masterMap['platform.tenant_delete']?.level, 'sensitive');
  assert.equal(masterMap['db.query_write']?.via, 'keys');
  const constraint = await db.raw(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'web_bans_source_check'`) as { rows: Array<{ d: string }> };
  assert.match(constraint.rows[0].d, /key-intrusion/);
  assert.match(constraint.rows[0].d, /key-bruteforce/);

  // ── fixtures ──
  const A = Number((await db('tenants').insert({ name: 'Reseller A', slug: 'reseller-a' }).returning('id'))[0].id);
  const B = Number((await db('tenants').insert({ name: 'Reseller B', slug: 'reseller-b' }).returning('id'))[0].id);
  const secrets = new Map<number, string>();
  const mkUser = async (username: string, o: { role?: 'admin' | 'user'; kind?: 'staff' | 'client'; totp?: boolean; sso?: number } = {}) => {
    const secret = o.totp === false || o.sso ? null : twoFactorService.generateTotpSecret(username).secret;
    const id = Number((await db('users').insert({
      username, role: o.role ?? 'user', kind: o.kind ?? 'staff', is_active: true, password_hash: 'x',
      totp_enabled: !!secret, totp_secret: secret, preferred_language: 'fr',
      foreign_source: o.sso ? 'obligate' : null, foreign_id: o.sso ?? null,
    }).returning('id'))[0].id);
    if (secret) secrets.set(id, secret);
    return id;
  };
  const PA = await mkUser('platform-admin', { role: 'admin' });
  const SA = await mkUser('staff-a');
  const SN = await mkUser('staff-a-nofactor', { totp: false });
  const SB = await mkUser('staff-b');
  const SSO = await mkUser('staff-sso', { sso: 77 });
  // Obligate "configured" (test verifier) and known to hold a TOTP for SSO.
  const obligateVerifier = async (id: number, code: string) => (id === 77 && code === '123456' ? 'valid' as const : id === 78 ? 'notEnrolled' as const : code === '999999' ? 'unavailable' as const : 'invalid' as const);
  setObligateTotpVerifierForTests(obligateVerifier);
  await db('users').where({ id: SSO }).update({ sso_totp_enabled: true });
  const C1 = await mkUser('client-owner', { kind: 'client' });
  const C2 = await mkUser('client-approver', { kind: 'client' });
  const C3 = await mkUser('client-nocap', { kind: 'client' });
  const C4 = await mkUser('client-other-account', { kind: 'client' });
  const C5 = await mkUser('client-nofactor', { kind: 'client', totp: false });
  await db('user_tenants').insert([
    { user_id: PA, tenant_id: 1, role: 'admin' },
    { user_id: SA, tenant_id: A, role: 'admin' },
    { user_id: SN, tenant_id: A, role: 'admin' },
    { user_id: SSO, tenant_id: A, role: 'admin' },
    { user_id: SB, tenant_id: B, role: 'admin' },
    ...[C1, C2, C3, C4, C5].map((u) => ({ user_id: u, tenant_id: A, role: 'client' })),
  ]);
  const nodeId = Number(((await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined)?.id
    ?? (await db('nodes').insert({ name: 'n1', is_local: true }).returning('id'))[0].id);
  const mkAccount = async (tenantId: number, name: string) => {
    const [plan] = await db('plans').insert({ tenant_id: tenantId, name: `p-${name}`, limits: JSON.stringify({}) }).returning('id');
    const uid = 20000 + Math.floor(Math.random() * 30000);
    return Number((await db('hosting_accounts').insert({
      tenant_id: tenantId, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: name, uid, gid: uid, status: 'active', filesrv_mode: 'off',
    }).returning('id'))[0].id);
  };
  const a1 = await mkAccount(A, 'acme');
  const a2 = await mkAccount(A, 'other');
  const b1 = await mkAccount(B, 'bacct');
  await db('account_users').insert([
    { user_id: C1, account_id: a1, capabilities: JSON.stringify(['databases.manage', 'sites.manage']) },
    { user_id: C2, account_id: a1, capabilities: JSON.stringify(['databases.manage']) },
    { user_id: C3, account_id: a1, capabilities: JSON.stringify([]) },
    { user_id: C4, account_id: a2, capabilities: JSON.stringify(['databases.manage']) },
    { user_id: C5, account_id: a1, capabilities: JSON.stringify(['databases.manage']) },
  ]);
  const mkKey = async (name: string, creator: number, kind: 'key' | 'connector' = 'key') => Number((await db('api_keys').insert({
    tenant_id: A, account_id: a1, name, token_hash: `${name}-hash-${Math.random()}`.padEnd(64, '0').slice(0, 64), prefix: name, created_by: creator, kind,
  }).returning('id'))[0].id);
  const K1 = await mkKey('ci', C1);
  const K2 = await mkKey('ci-two', C1);
  const K5 = await mkKey('nofactor', C5);
  const K3 = await mkKey('budget', C1);
  const keys = new Map<number, { creator: number; name: string; kind: 'key' | 'connector' }>([
    [K1, { creator: C1, name: 'ci', kind: 'key' }], [K2, { creator: C1, name: 'ci-two', kind: 'key' }], [K5, { creator: C5, name: 'nofactor', kind: 'key' }], [K3, { creator: C1, name: 'budget', kind: 'key' }],
  ]);

  /** A fresh TOTP code of the user (its anti-replay marker reset unless `keep`). */
  const codeOf = async (userId: number, keep = false) => {
    if (!keep) await db('users').where({ id: userId }).update({ totp_last_step: null });
    return new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secrets.get(userId) as string) }).generate();
  };

  // ── app: fake session / key, the real routes, a gated synthetic operation ──
  const app = express();
  app.use(express.json());
  app.use(captureStepUpProof);
  app.use((req, _res, next) => {
    const key = Number(req.header('x-key'));
    const r = req as unknown as { session: Record<string, unknown>; tenantId: number; apiKey?: unknown };
    if (key) {
      const k = keys.get(key)!;
      r.session = {};
      r.tenantId = A;
      r.apiKey = { id: key, name: k.name, kind: k.kind, tenantId: A, accountId: a1, creatorId: k.creator };
    } else {
      r.session = { userId: Number(req.header('x-user')), role: req.header('x-role') ?? 'user', currentTenantId: Number(req.header('x-tenant')) };
      r.tenantId = Number(req.header('x-tenant'));
    }
    next();
  });
  app.use('/restrictions', restrictionsRoutes);
  app.use('/pending-actions', pendingRoutes);
  app.post('/t/gate', async (req, res, next) => {
    try {
      const b = req.body as { action: string; accountId?: number; siteId?: number; tenantId?: number; params?: Record<string, unknown>; secret?: Record<string, unknown>; approvalId?: number; fail?: 'backend' | 'pg' | 'forbidden'; viaHandler?: boolean };
      const tenantId = b.tenantId ?? A;
      const accountId = b.accountId === undefined ? a1 : b.accountId;
      const spec = { action: b.action, target: { tenantId, accountId, siteId: b.siteId ?? null }, params: b.params ?? {}, secretParams: b.secret, approvalId: b.approvalId };
      const op = async () => {
        if (b.fail === 'backend') throw new AppError(503, 'connect ENOENT /srv/oblimint/run/hostd.sock (hostd: mount failed)', 'backendUnavailable');
        if (b.fail === 'pg') throw new Error('insert into "secret_table" values ($1) - relation "secret_table" does not exist');
        if (b.fail === 'forbidden') throw new AppError(403, 'Insufficient permissions');
        // The handler re-checks the CURRENT rights of the acting user (a key: its creator).
        const userId = req.apiKey ? req.apiKey.creatorId : Number(req.session.userId);
        const actor = await actorForUser(userId, tenantId);
        if (b.action.startsWith('db.') && !actorCan(actor, 'databases.manage', { tenantId, accountId })) throw new AppError(403, 'Insufficient permissions');
      };
      if (b.viaHandler) {
        // A panel route: gateAction, then the handler; its error reaches the error handler.
        await gateAction(req, spec);
        await op();
      } else {
        await runGated(req, spec, op);
      }
      res.json({ success: true, data: { viaPendingAction: req.viaPendingAction ?? null } });
    } catch (err) { next(err); }
  });
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  type Who = { user?: number; tenant?: number; role?: string; key?: number };
  const call = async (method: string, url: string, who: Who, body?: unknown, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { 'content-type': 'application/json', ...headers };
    if (who.key) h['x-key'] = String(who.key);
    else { h['x-user'] = String(who.user); h['x-tenant'] = String(who.tenant ?? A); if (who.role) h['x-role'] = who.role; }
    const res = await fetch(`${base}${url}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as { success: boolean; data?: any; code?: string; error?: string; details?: any; [k: string]: any } };
  };
  const asKey1: Who = { key: K1 };
  const asC1: Who = { user: C1 };
  const asC2: Who = { user: C2 };
  const asSA: Who = { user: SA };
  const asPA: Who = { user: PA, tenant: 1, role: 'admin' };
  const gate = (who: Who, action: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    call('POST', '/t/gate', who, { action, params, ...extra }, headers);
  const setMap = (tenantId: number, map: Record<string, unknown>) => restrictionService.setMap(tenantId, map as never);
  const row = async (id: number) => db('pending_actions').where({ id }).first();
  const notified = async (event: string, id: number) =>
    (await db('user_notifications').where({ event, dedup_key: `pa:${id}` }).orderBy('user_id').pluck('user_id') as number[]).map(Number);

  await t.test('key, sensitive: 428 with the French message, confirmation by the owner with a NEW code, single use', async () => {
    await setMap(A, { 'db.drop': 'sensitive' });
    let r = await gate(asKey1, 'db.drop', { name: 'wp_prod' });
    assert.equal(r.status, 428, JSON.stringify(r.body));
    assert.equal(r.body.code, 'twoFactorRequired');
    const id = r.body.details.pendingActionId as number;
    assert.ok(r.body.details.userMessage.includes('Autoriser l\'action avec un 2FA téléphone ou un code via l\'interface'));
    assert.match(r.body.details.next, /wait_for_pending_action/);
    assert.match(r.body.details.approveUrl, new RegExp(`/approvals/${id}$`));
    assert.match(r.body.details.description, /Supprimer la base de données « wp_prod »/);
    assert.deepEqual(await notified('action.confirmationRequired', id), [C1], 'the key owner only');

    r = await gate(asKey1, 'db.drop', { name: 'wp_prod' });
    assert.equal(r.body.details.pendingActionId, id, 'the agent that insists finds the same request');

    r = await call('POST', `/pending-actions/${id}/confirm`, asKey1);
    assert.equal(r.status, 403, 'a key never confirms');
    assert.equal(r.body.code, 'keyCannotDecide');
    r = await call('POST', `/pending-actions/${id}/confirm`, asC2);
    assert.equal(r.status, 404, 'another user does not even see it');
    r = await call('POST', `/pending-actions/${id}/confirm`, asC1);
    assert.equal(r.status, 401);
    assert.equal(r.body.twoFactorRequired, true);
    assert.equal(r.body.codeMustBeNew, true);
    assert.equal(r.body.trustIpAllowed, false, 'never a trusted IP for a confirmation');
    r = await call('POST', `/pending-actions/${id}/confirm`, asC1, { twoFactorCode: '000000' });
    assert.equal(r.status, 401);
    const code = await codeOf(C1);
    r = await call('POST', `/pending-actions/${id}/confirm`, asC1, { twoFactorCode: code });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.status, 'approved');

    // The same code never serves twice.
    const other = await gate(asKey1, 'db.drop', { name: 'wp_other' });
    assert.equal(other.status, 428);
    r = await call('POST', `/pending-actions/${other.body.details.pendingActionId}/confirm`, asC1, { twoFactorCode: code });
    assert.equal(r.status, 401);
    assert.equal(r.body.codeUsed, true);

    // Another key of the same user does not consume it; modified parameters neither.
    r = await gate({ key: K2 }, 'db.drop', { name: 'wp_prod' });
    assert.equal(r.status, 428);
    assert.notEqual(r.body.details.pendingActionId, id);
    r = await gate(asKey1, 'db.drop', { name: 'wp_prod', cascade: true });
    assert.equal(r.status, 428);
    assert.notEqual(r.body.details.pendingActionId, id);
    assert.equal((await row(id)).status, 'approved', 'still waiting for the exact request');

    r = await gate(asKey1, 'db.drop', { name: 'wp_prod' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.viaPendingAction, id);
    assert.equal((await row(id)).status, 'consumed');
    r = await gate(asKey1, 'db.drop', { name: 'wp_prod' });
    assert.equal(r.status, 428, 'single use: a new request');
    assert.notEqual(r.body.details.pendingActionId, id);
  });

  await t.test('two concurrent re-submissions: only one passes', async () => {
    let r = await gate(asKey1, 'db.drop', { name: 'race' });
    const id = r.body.details.pendingActionId as number;
    r = await call('POST', `/pending-actions/${id}/confirm`, asC1, { twoFactorCode: await codeOf(C1) });
    assert.equal(r.status, 200);
    const both = await Promise.all([gate(asKey1, 'db.drop', { name: 'race' }), gate(asKey1, 'db.drop', { name: 'race' })]);
    assert.deepEqual(both.map((x) => x.status).sort(), [200, 428]);
  });

  await t.test('owner without a second factor: 403 twoFactorNotEnrolled at once, no request', async () => {
    const before = Number((await db('pending_actions').count<{ n: string }[]>({ n: '*' }).first())?.n);
    const r = await gate({ key: K5 }, 'db.drop', { name: 'x' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'twoFactorNotEnrolled');
    assert.equal(Number((await db('pending_actions').count<{ n: string }[]>({ n: '*' }).first())?.n), before);
  });

  await t.test('via keys: an agent is gated, the panel is free', async () => {
    await setMap(A, { 'db.query_write': { level: 'sensitive', via: 'keys' } });
    let r = await gate(asC1, 'db.query_write', { sql: 'DELETE FROM t' });
    assert.equal(r.status, 200, 'panel free');
    r = await gate(asKey1, 'db.query_write', { sql: 'DELETE FROM t' });
    assert.equal(r.status, 428);
  });

  await t.test('level raised after a confirmation: the confirmation no longer suffices', async () => {
    await setMap(A, { 'db.drop': 'sensitive' });
    let r = await gate(asKey1, 'db.drop', { name: 'raised' });
    const id = r.body.details.pendingActionId as number;
    assert.equal((await call('POST', `/pending-actions/${id}/confirm`, asC1, { twoFactorCode: await codeOf(C1) })).status, 200);
    await setMap(A, { 'db.drop': 'restricted' });
    r = await gate(asKey1, 'db.drop', { name: 'raised' });
    assert.equal(r.status, 428);
    assert.equal(r.body.code, 'approvalRequired');
    assert.notEqual(r.body.details.pendingActionId, id);
    assert.equal((await row(id)).status, 'cancelled', 'the weaker one is retired');
  });

  await t.test('approvers: computed from the database, never another account or tenant', async () => {
    await setMap(A, { 'db.drop': 'restricted' });
    const def = shared.restrictableAction('db.drop')!;
    const list = (await eligibleApprovers(def, { tenantId: A, accountId: a1, siteId: null }, C1)).map((x) => x.userId).sort((x, y) => x - y);
    assert.deepEqual(list, [C2, SA, SSO, PA].sort((x, y) => x - y), 'not the requester, not without the right, not another account / tenant, not without a factor');

    let r = await gate(asKey1, 'db.drop', { name: 'approve-me' });
    assert.equal(r.status, 428);
    const id = r.body.details.pendingActionId as number;
    assert.deepEqual(await notified('action.approvalRequired', id), [C2, SA, SSO, PA].sort((x, y) => x - y));
    const fam = await db('user_notifications').where({ dedup_key: `pa:${id}`, user_id: C2 }).first('family', 'link', 'tenant_id');
    assert.equal(fam.family, 'approvals', 'family approvals delivered to a client');
    assert.equal(fam.link, `/approvals/${id}`);
    assert.equal(Number(fam.tenant_id), A);
    const paRow = await db('user_notifications').where({ dedup_key: `pa:${id}`, user_id: PA }).first('tenant_id');
    assert.equal(Number(paRow.tenant_id), 1, 'platform admins: their god view');

    r = await call('POST', `/pending-actions/${id}/approve`, asC1, { twoFactorCode: await codeOf(C1) });
    assert.equal(r.status, 403, 'self approval');
    r = await call('POST', `/pending-actions/${id}/approve`, { user: C3 });
    assert.equal(r.status, 403, 'a login of the same account without the right: told so');
    assert.equal(r.body.code, 'notEligibleApprover');
    r = await call('GET', `/pending-actions/${id}`, { user: C3 });
    assert.equal(r.status, 404, 'but he cannot read it');
    r = await call('POST', `/pending-actions/${id}/approve`, { user: C4 });
    assert.equal(r.status, 404, 'client of another account');
    r = await call('POST', `/pending-actions/${id}/approve`, { user: SB, tenant: B });
    assert.equal(r.status, 404, 'staff of another tenant');
    r = await call('GET', '/pending-actions?tab=todo', asC2);
    assert.ok(r.body.data.items.some((x: { id: number; can: { approve: boolean } }) => x.id === id && x.can.approve));
    assert.ok(r.body.data.todoCount >= 1);
    r = await call('POST', `/pending-actions/${id}/approve`, asC2);
    assert.equal(r.status, 401, 'the approver types his own code');
    r = await call('POST', `/pending-actions/${id}/approve`, asC2, { twoFactorCode: await codeOf(C2), reason: 'ok' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.decidedVia, 'second_person');
    assert.deepEqual(await notified('action.approved', id), [C1]);
    r = await call('POST', `/pending-actions/${id}/approve`, asSA, { twoFactorCode: await codeOf(SA) });
    assert.equal(r.status, 409, 'already decided');
    r = await gate(asKey1, 'db.drop', { name: 'approve-me' });
    assert.equal(r.status, 200);
  });

  await t.test('approver who lost his right meanwhile: 403 notEligibleApprover at decision time (spec §1.3)', async () => {
    const r = await gate(asKey1, 'db.drop', { name: 'lost-right' });
    const id = r.body.details.pendingActionId as number;
    await db('account_users').where({ user_id: C2, account_id: a1 }).update({ capabilities: JSON.stringify([]) });
    let d = await call('POST', `/pending-actions/${id}/approve`, asC2, { twoFactorCode: await codeOf(C2) });
    assert.equal(d.status, 403);
    assert.equal(d.body.code, 'notEligibleApprover');
    d = await call('POST', `/pending-actions/${id}/deny`, asC2);
    assert.equal(d.status, 403);
    assert.equal(d.body.code, 'notEligibleApprover');
    d = await call('POST', `/pending-actions/${id}/approve`, { user: C4 }, { twoFactorCode: '000000' });
    assert.equal(d.status, 404, 'outside the circle (another account): still nothing disclosed');
    await db('account_users').where({ user_id: C2, account_id: a1 }).update({ capabilities: JSON.stringify(['databases.manage']) });
  });

  await t.test('deny and cancel', async () => {
    let r = await gate(asKey1, 'db.drop', { name: 'deny-me' });
    const id = r.body.details.pendingActionId as number;
    r = await call('POST', `/pending-actions/${id}/deny`, asC2, { reason: 'no' });
    assert.equal(r.status, 200);
    assert.equal((await row(id)).status, 'denied');
    assert.deepEqual(await notified('action.denied', id), [C1]);
    r = await gate(asKey1, 'db.drop', { name: 'cancel-me' });
    const id2 = r.body.details.pendingActionId as number;
    r = await call('POST', `/pending-actions/${id2}/cancel`, asC2);
    assert.equal(r.status, 404, 'only the requester cancels');
    r = await call('POST', `/pending-actions/${id2}/cancel`, asC1);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.status, 'cancelled');
  });

  await t.test('nobody eligible: 409 noEligibleApprover (single platform admin)', async () => {
    await setMap(1, { ...await restrictionService.getMap(1), 'platform.tenant_delete': 'restricted' });
    const r = await gate(asPA, 'platform.tenant_delete', { tenantId: B }, { tenantId: 1, accountId: null });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'noEligibleApprover');
    assert.match(String(r.body.error), /second authorised person/);
  });

  await t.test('panel restricted: 202, approval by a second person, re-submission (header must match)', async () => {
    await setMap(A, { 'db.drop': 'restricted' });
    let r = await gate(asC1, 'db.drop', { name: 'panel-prod' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.data.status, 'pendingApproval');
    const id = r.body.data.pendingActionId as number;
    assert.equal((await row(id)).api_key_id, null);
    r = await call('POST', `/pending-actions/${id}/approve`, asSA, { twoFactorCode: await codeOf(SA) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await gate(asC1, 'db.drop', { name: 'panel-prod' }, {}, { 'X-Oblimint-Approval': String(id + 1000) });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'approvalMismatch');
    r = await gate(asC1, 'db.drop', { name: 'panel-prod' }, {}, { 'X-Oblimint-Approval': String(id) });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.viaPendingAction, id);
  });

  await t.test('panel restricted carrying a secret: a fresh code instead of an approval', async () => {
    await setMap(A, { 'db.user_password_reset': 'restricted' });
    let r = await gate(asC1, 'db.user_password_reset', { username: 'wp' }, { secret: { password: 'hunter2-secret' } });
    assert.equal(r.status, 401);
    assert.equal(r.body.trustIpAllowed, false);
    r = await gate(asC1, 'db.user_password_reset', { username: 'wp', twoFactorCode: await codeOf(C1) }, { secret: { password: 'hunter2-secret' } });
    // twoFactorCode sits inside params here: moved out by captureStepUpProof only at the top level.
    assert.equal(r.status, 401);
    const res = await fetch(`${base}/t/gate`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-user': String(C1), 'x-tenant': String(A) },
      body: JSON.stringify({ action: 'db.user_password_reset', params: { username: 'wp' }, secret: { password: 'hunter2-secret' }, twoFactorCode: await codeOf(C1) }),
    });
    assert.equal(res.status, 200);
  });

  await t.test('panel sensitive: no factor → twoFactorNotEnrolled, code accepted once', async () => {
    await setMap(A, { 'site.delete': 'sensitive' });
    let r = await gate({ user: SN }, 'site.delete', { name: 'shop' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'twoFactorNotEnrolled');
    assert.match(String(r.body.error), /enable it in your profile/);
    r = await gate(asSA, 'site.delete', { name: 'shop' });
    assert.equal(r.status, 401);
    assert.equal(r.body.twoFactorRequired, true);
    const res = await fetch(`${base}/t/gate`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-user': String(SA), 'x-tenant': String(A) },
      body: JSON.stringify({ action: 'site.delete', params: { name: 'shop' }, twoFactorCode: await codeOf(SA) }),
    });
    assert.equal(res.status, 200);
  });

  await t.test('step-up: trusted IP 24 h (panel sensitive only), Obligate code of an SSO staff account', async () => {
    const fake = (userId: number, proof: Record<string, unknown> | undefined, ip = '203.0.113.9') => ({
      session: { userId }, sessionID: `s-${userId}`, stepUpProof: proof, headers: {}, socket: { remoteAddress: ip },
    }) as unknown as Request;
    let o = await checkActionStepUp(fake(SA, { twoFactorCode: await codeOf(SA), trustIp: true }), 'site.delete', { allowTrustedIp: true });
    assert.deepEqual(o, { ok: true, via: 'totp' });
    o = await checkActionStepUp(fake(SA, undefined), 'site.delete', { allowTrustedIp: true });
    assert.deepEqual(o, { ok: true, via: 'trusted_ip' });
    o = await checkActionStepUp(fake(SA, undefined), 'pending_action.approve', { allowTrustedIp: false });
    assert.equal(o.ok, false, 'never for an approval / confirmation');
    o = await checkActionStepUp(fake(SA, undefined, '203.0.113.10'), 'site.delete', { allowTrustedIp: true });
    assert.equal(o.ok, false, 'another address');

    o = await checkActionStepUp(fake(SSO, { twoFactorCode: '123456' }), 'site.delete');
    assert.deepEqual(o, { ok: true, via: 'obligate_totp' });
    o = await checkActionStepUp(fake(SSO, { twoFactorCode: '123456' }), 'site.delete');
    assert.equal(o.ok, false, 'the same Obligate code never serves twice here');
    assert.equal((o as { body: { codeUsed?: boolean } }).body.codeUsed, true);
    o = await checkActionStepUp(fake(SSO, { twoFactorCode: '111111' }), 'site.delete');
    assert.equal((o as { status: number }).status, 401);
    o = await checkActionStepUp(fake(SSO, { twoFactorCode: '999999' }), 'site.delete');
    assert.equal((o as { status: number }).status, 503, 'Obligate unavailable: not the user\'s fault');
  });

  await t.test('rights removed from the creator: the re-submission fails in the handler, the request stays consumed with the error', async () => {
    await setMap(A, { 'db.drop': 'sensitive' });
    let r = await gate(asKey1, 'db.drop', { name: 'revoked-right' });
    const id = r.body.details.pendingActionId as number;
    assert.equal((await call('POST', `/pending-actions/${id}/confirm`, asC1, { twoFactorCode: await codeOf(C1) })).status, 200);
    await db('account_users').where({ user_id: C1, account_id: a1 }).update({ capabilities: JSON.stringify(['sites.manage']) });
    r = await gate(asKey1, 'db.drop', { name: 'revoked-right' });
    assert.equal(r.status, 403);
    const after = await row(id);
    assert.equal(after.status, 'consumed');
    assert.match(String(after.execution_error), /Insufficient permissions/);
    await db('account_users').where({ user_id: C1, account_id: a1 }).update({ capabilities: JSON.stringify(['databases.manage', 'sites.manage']) });
  });

  await t.test('sweeper: pending and approved-but-unused requests expire, requester told; revoked key takes its requests', async () => {
    await setMap(A, { 'db.drop': 'sensitive' });
    let r = await gate(asKey1, 'db.drop', { name: 'expire-pending' });
    const p1 = r.body.details.pendingActionId as number;
    r = await gate(asKey1, 'db.drop', { name: 'expire-approved' });
    const p2 = r.body.details.pendingActionId as number;
    assert.equal((await call('POST', `/pending-actions/${p2}/confirm`, asC1, { twoFactorCode: await codeOf(C1) })).status, 200);
    await db('pending_actions').where({ id: p1 }).update({ expires_at: new Date(Date.now() - 1000) });
    await db('pending_actions').where({ id: p2 }).update({ consume_by: new Date(Date.now() - 1000) });
    const s = await sweep();
    assert.ok(s.expired >= 2);
    assert.equal((await row(p1)).status, 'expired');
    assert.equal((await row(p2)).status, 'expired');
    assert.deepEqual(await notified('action.expired', p1), [C1]);
    assert.ok(await db('audit_logs').where({ action: 'pending_action.expired', resource_path: String(p1) }).first());
    r = await gate(asKey1, 'db.drop', { name: 'expire-approved' });
    assert.equal(r.status, 428, 'an expired approval is never consumed');

    r = await gate({ key: K2 }, 'db.drop', { name: 'k2' });
    const k2req = r.body.details.pendingActionId as number;
    await db('api_keys').where({ id: K2 }).delete();
    assert.equal(await row(k2req), undefined, 'a revoked key takes its requests');
  });

  await t.test('audit: requested / confirmed / consumed present, no secret anywhere', async () => {
    for (const a of ['pending_action.requested', 'pending_action.confirmed', 'pending_action.approved', 'pending_action.consumed', 'pending_action.denied', 'pending_action.cancelled']) {
      assert.ok(await db('audit_logs').where({ action: a }).first(), a);
    }
    const requested = await db('audit_logs').where({ action: 'pending_action.requested' }).whereRaw(`details->>'action' = 'db.drop'`).whereRaw(`(details->'apiKey'->>'id') IS NOT NULL`).first();
    assert.ok(requested, 'the key is recorded');
    const all = JSON.stringify(await db('audit_logs').select('details')) + JSON.stringify(await db('pending_actions').select('*'));
    assert.ok(!all.includes('hunter2-secret'), 'a secret is never stored');
  });

  await t.test('matrix routes: isolation, clients refused, platform entries, scopes confined, restrictions.manage gated', async () => {
    let r = await call('GET', '/restrictions', asC1);
    assert.equal(r.status, 403, 'a client never edits nor reads the matrix');
    r = await call('GET', '/restrictions', { user: SA, tenant: B });
    assert.equal(r.status, 403, 'no capability in another tenant');
    r = await call('GET', '/restrictions', asSA);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.canEditPlatform, false);
    assert.ok(!r.body.data.actions.some((a: { platform?: boolean }) => a.platform), 'platform actions hidden from a reseller');
    assert.ok(r.body.data.stats.withoutTotp.staff >= 1, 'staff without factor counted');
    assert.ok(r.body.data.stats.withoutTotp.clients >= 1, 'clients without factor counted');

    r = await call('PUT', '/restrictions', asSA, {
      map: {
        'db.drop': { level: 'sensitive', scope: { mode: 'include', accountIds: [a1, b1] } },
        'platform.tenant_delete': 'none', 'platform.update_apply': 'restricted', 'junk.key': 'sensitive', 'site.delete': 'none',
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const mapA = await restrictionService.getMap(A);
    assert.deepEqual(mapA['db.drop'].scope, { mode: 'include', accountIds: [a1] }, 'another tenant\'s account stripped');
    assert.equal(mapA['platform.update_apply'], undefined, 'no platform entry outside the master');
    assert.equal(mapA['junk.key'], undefined);
    const mapB = await restrictionService.getMap(B);
    assert.equal(mapB['db.drop'], undefined, 'tenant B untouched');
    assert.ok(await db('audit_logs').where({ action: 'restrictions.updated', tenant_id: A }).first());

    r = await call('PUT', '/restrictions', { user: SB, tenant: B }, { map: { 'db.import': 'sensitive' } });
    assert.equal(r.status, 200);
    assert.equal((await restrictionService.getMap(A))['db.import'], undefined, 'B never writes A');

    // restrictions.manage restricted → the change waits for another person.
    await restrictionService.setMap(A, { ...await restrictionService.getMap(A), 'restrictions.manage': { level: 'restricted', scope: { mode: 'all' }, via: 'all' } });
    r = await call('PUT', '/restrictions', asSA, { map: { 'restrictions.manage': 'restricted', 'db.drop': 'restricted' } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.data.status, 'pendingApproval');
    assert.match(r.body.data.description, /Modifier la matrice des actions protégées/);
    assert.equal((await restrictionService.getMap(A))['db.drop'].level, 'sensitive', 'unchanged until approved');
  });

  await t.test('platform floor: master platform admin only, never lowered by a tenant', async () => {
    let r = await call('PUT', '/restrictions/floor', asSA, { floor: { 'db.dump': 'restricted' } });
    assert.equal(r.status, 403);
    // The master's own matrix gates restrictions.manage? Not by default: free.
    r = await call('PUT', '/restrictions/floor', asPA, { floor: { 'db.dump': 'restricted', 'x.unknown': 'sensitive' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.floor, { 'db.dump': 'restricted' });
    assert.equal(r.body.data.canEditPlatform, true);
    platformSettings.invalidate();
    await setMap(B, {});
    const def = shared.restrictableAction('db.dump')!;
    const fakeReq = { tenantId: B, session: { userId: SB } } as unknown as Request;
    assert.equal(await restrictionService.levelFor(fakeReq, def, { tenantId: B, accountId: b1, siteId: null }), 'restricted');
    r = await call('PUT', '/restrictions', { user: SB, tenant: B }, { map: { 'db.dump': 'none' } });
    assert.equal(r.status, 200);
    assert.equal(await restrictionService.levelFor(fakeReq, def, { tenantId: B, accountId: b1, siteId: null }), 'restricted', 'the floor stays');
    // hosting-settings never writes the protected sections
    const { hostingSettingsUpdateSchema } = await import('../platformSettings');
    assert.equal(hostingSettingsUpdateSchema.safeParse({ restrictions: { floor: {} } }).success, false);
    assert.equal(hostingSettingsUpdateSchema.safeParse({ keySecurity: { strictMode: 'off' } }).success, false);
  });

  await t.test('preferences: the in-app delivery of approvals cannot be switched off', async () => {
    const { userNotificationService } = await import('../usage/userNotifications.service');
    await assert.rejects(userNotificationService.updatePrefs({} as Request, C1, { prefs: { approvals: { inApp: false } } }),
      (e: { code?: string }) => e.code === 'notificationLocked');
    const s = await userNotificationService.updatePrefs({} as Request, C1, { prefs: { approvals: { email: true } } });
    assert.deepEqual(s.prefs.approvals, { inApp: true, email: true });
    assert.ok(s.families.includes('approvals'), 'a client sees the family');
  });

  await t.test('frozen request bound to its target: an approval for site 7 never deletes site 8', async () => {
    await setMap(A, { 'site.delete': 'restricted' });
    let r = await gate(asC1, 'site.delete', {}, { siteId: 7 });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const id = r.body.data.pendingActionId as number;
    assert.match(r.body.data.description, /site #7/, 'the decider sees the object');
    assert.deepEqual((await row(id)).params_display, { target: { accountId: a1, siteId: 7 } });
    assert.equal((await call('POST', `/pending-actions/${id}/approve`, asSA, { twoFactorCode: await codeOf(SA) })).status, 200);
    r = await gate(asC1, 'site.delete', {}, { siteId: 8 }, { 'X-Oblimint-Approval': String(id) });
    assert.equal(r.status, 409, 'the approval names site 7');
    assert.equal(r.body.code, 'approvalMismatch');
    r = await gate(asC1, 'site.delete', {}, { siteId: 8 });
    assert.equal(r.status, 202, 'site 8: a new request');
    assert.notEqual(r.body.data.pendingActionId, id);
    assert.equal((await row(id)).status, 'approved', 'site 7 approval untouched');
    r = await gate(asC1, 'site.delete', {}, { siteId: 7 });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.viaPendingAction, id);
    await setMap(A, {});
  });

  await t.test('execution error kept redacted: backend text and raw server errors never stored', async () => {
    await setMap(A, { 'db.drop': 'sensitive' });
    for (const [fail, viaHandler, expected] of [
      ['backend', false, /container engine or the host daemon is unreachable/],
      ['backend', true, /container engine or the host daemon is unreachable/],
      ['pg', false, /^Internal server error$/],
      ['pg', true, /^Internal server error$/],
    ] as const) {
      const name = `fail-${fail}-${viaHandler}`;
      let r = await call('POST', '/t/gate', asKey1, { action: 'db.drop', params: { name }, fail, viaHandler });
      assert.equal(r.status, 428);
      const id = r.body.details.pendingActionId as number;
      assert.equal((await call('POST', `/pending-actions/${id}/confirm`, asC1, { twoFactorCode: await codeOf(C1) })).status, 200);
      r = await call('POST', '/t/gate', asKey1, { action: 'db.drop', params: { name }, fail, viaHandler });
      assert.ok(r.status >= 500, JSON.stringify(r.body));
      await new Promise((res) => setTimeout(res, 100)); // the error handler records it asynchronously
      const after = await row(id);
      assert.equal(after.status, 'consumed');
      assert.match(String(after.execution_error), expected, name);
      assert.ok(!/srv\/oblimint|hostd\.sock|secret_table/.test(String(after.execution_error)), `${name}: no raw text`);
      r = await call('GET', `/pending-actions/${id}`, asC1);
      assert.ok(!/srv\/oblimint|secret_table/.test(String(r.body.data.executionError)));
    }
  });

  await t.test('pending requests capped per principal; an insisting agent costs no new request', async () => {
    const { MAX_PENDING_PER_PRINCIPAL } = await import('./pendingActions.service');
    await setMap(A, { 'db.drop': 'restricted' });
    const ids: number[] = [];
    for (let i = 0; i < MAX_PENDING_PER_PRINCIPAL; i++) {
      const r = await gate({ key: K3 }, 'db.drop', { name: `flood-${i}` });
      assert.equal(r.status, 428, JSON.stringify(r.body));
      ids.push(r.body.details.pendingActionId as number);
    }
    let r = await gate({ key: K3 }, 'db.drop', { name: 'flood-over' });
    assert.equal(r.status, 429);
    assert.equal(r.body.code, 'tooManyPendingActions');
    r = await gate({ key: K3 }, 'db.drop', { name: 'flood-0' });
    assert.equal(r.status, 428, 'the same request is still found');
    assert.equal(r.body.details.pendingActionId, ids[0]);
    r = await gate(asKey1, 'db.drop', { name: 'other-key-free' });
    assert.equal(r.status, 428, 'another key has its own budget');
    for (const id of ids) await call('POST', `/pending-actions/${id}/cancel`, asC1);
    r = await gate({ key: K3 }, 'db.drop', { name: 'flood-over' });
    assert.equal(r.status, 428, 'room again once cancelled');
  });

  await t.test('"to do" tab: a platform admin sees every approval he may give, a staff of another tenant none', async () => {
    await setMap(A, { 'db.drop': 'restricted' });
    const r = await gate(asKey1, 'db.drop', { name: 'todo-admin' });
    const id = r.body.details.pendingActionId as number;
    let l = await call('GET', '/pending-actions?tab=todo', asPA);
    assert.ok(l.body.data.items.some((x: { id: number; can: { approve: boolean } }) => x.id === id && x.can.approve), 'god view');
    l = await call('GET', '/pending-actions?tab=todo', { user: SB, tenant: B });
    assert.ok(!l.body.data.items.some((x: { id: number }) => x.id === id));
    l = await call('GET', '/pending-actions/count', asSA);
    assert.ok(l.body.data.todo >= 1);
  });

  await t.test('wrong 2FA codes capped per user, whatever the route', async () => {
    resetStepUpFailuresForTests();
    await setMap(A, { 'site.delete': 'sensitive', 'db.drop': 'restricted' });
    const tryCode = (code: string) => fetch(`${base}/t/gate`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-user': String(SA), 'x-tenant': String(A) },
      body: JSON.stringify({ action: 'site.delete', params: { name: 'cap' }, twoFactorCode: code }),
    });
    for (let i = 0; i < STEP_UP_MAX_FAILURES; i++) assert.equal((await tryCode('000000')).status, 401);
    let res = await tryCode(await codeOf(SA));
    assert.equal(res.status, 429, 'locked even with the right code');
    assert.equal(((await res.json()) as { code: string }).code, 'stepUpLocked');
    // The decision routes share the same cap.
    const k = await gate(asKey1, 'db.drop', { name: 'cap-decision' });
    const pid = k.body.details.pendingActionId as number;
    const d = await call('POST', `/pending-actions/${pid}/approve`, asSA, { twoFactorCode: await codeOf(SA) });
    assert.equal(d.status, 429);
    resetStepUpFailuresForTests();
    res = await tryCode(await codeOf(SA));
    assert.equal(res.status, 200);
    await setMap(A, {});
  });

  await t.test('SSO approver: counted only with a TOTP known at Obligate; "not configured" → twoFactorNotEnrolled', async () => {
    const SSO2 = await mkUser('staff-sso-nototp', { sso: 78 });
    const T = Number((await db('tenants').insert({ name: 'Reseller C', slug: 'reseller-c' }).returning('id'))[0].id);
    const LOC = await mkUser('staff-c-local');
    await db('user_tenants').insert([{ user_id: SSO2, tenant_id: T, role: 'admin' }, { user_id: LOC, tenant_id: T, role: 'admin' }]);
    const c1 = await mkAccount(T, 'cacct');
    const def = shared.restrictableAction('db.drop')!;
    const target = { tenantId: T, accountId: c1, siteId: null };
    const listOf = async () => (await eligibleApprovers(def, target, LOC)).map((x) => x.userId);
    assert.ok(!(await listOf()).includes(SSO2), 'unknown TOTP at Obligate: not an approver');
    // His own step-up is tried (lenient), Obligate says "TOTP not configured": recorded, clear 403.
    const fake = { session: { userId: SSO2 }, sessionID: 's-sso2', stepUpProof: { twoFactorCode: '123456' }, headers: {}, socket: { remoteAddress: '203.0.113.20' } } as unknown as Request;
    const o = await checkActionStepUp(fake, 'site.delete');
    assert.equal((o as { status: number }).status, 403);
    assert.equal((o as { body: { code?: unknown } }).body.code, 'twoFactorNotEnrolled');
    assert.equal((await db('users').where({ id: SSO2 }).first('sso_totp_enabled')).sso_totp_enabled, false);
    const o2 = await checkActionStepUp({ ...fake, stepUpProof: undefined } as unknown as Request, 'site.delete');
    assert.equal((o2 as { status: number }).status, 403, 'then refused at once, never "Invalid 2FA code" forever');
    // Platform admins are approvers everywhere: without them, nobody → 409, no parked request.
    await db('users').where({ id: PA }).update({ is_active: false });
    await setMap(T, { 'db.drop': 'restricted' });
    const res = await fetch(`${base}/t/gate`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-user': String(LOC), 'x-tenant': String(T) },
      body: JSON.stringify({ action: 'db.drop', tenantId: T, accountId: c1, params: { name: 'x' } }),
    });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code: string }).code, 'noEligibleApprover');
    // Known TOTP, but Obligate not configured: unusable.
    await db('users').where({ id: SSO2 }).update({ sso_totp_enabled: true });
    assert.ok((await listOf()).includes(SSO2), 'known TOTP: an approver');
    setObligateTotpVerifierForTests(null);
    assert.ok(!(await listOf()).includes(SSO2), 'Obligate not configured: not an approver');
    setObligateTotpVerifierForTests(obligateVerifier);
    await db('users').where({ id: PA }).update({ is_active: true });
  });

  await t.test('never locked out of the matrix: lock-out refused, platform-admin escape, CLI unlock', async () => {
    // A single platform admin (the master has no other staff): restricting restrictions.manage is refused.
    let r = await call('PUT', '/restrictions', asPA, { map: { ...await restrictionService.getMap(1), 'restrictions.manage': 'restricted' } });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.code, 'restrictionsLockout');
    r = await call('PUT', '/restrictions/floor', asPA, { floor: { 'restrictions.manage': 'restricted' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'restrictionsLockout');
    // Set behind the panel's back (old data, an approver removed later): the platform admin types his code instead.
    await setMap(1, { ...await restrictionService.getMap(1), 'restrictions.manage': 'restricted' });
    r = await call('PUT', '/restrictions', asPA, { map: { ...await restrictionService.getMap(1), 'restrictions.manage': 'sensitive' } });
    assert.equal(r.status, 401, JSON.stringify(r.body));
    assert.equal(r.body.trustIpAllowed, false);
    r = await call('PUT', '/restrictions', asPA, { map: { ...await restrictionService.getMap(1), 'restrictions.manage': 'sensitive' }, twoFactorCode: await codeOf(PA) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await restrictionService.getMap(1))['restrictions.manage'].level, 'sensitive');
    assert.ok(await db('audit_logs').where({ action: 'restrictions.lockout_escape' }).first());
    // Out of the panel: the docker exec CLI.
    await setMap(1, { ...await restrictionService.getMap(1), 'restrictions.manage': 'restricted' });
    await setMap(A, { 'restrictions.manage': 'restricted', 'db.drop': 'sensitive' });
    await platformSettings.update({ restrictions: { floor: { 'restrictions.manage': 'restricted', 'db.dump': 'restricted' } } });
    platformSettings.invalidate();
    const u = await unlockRestrictionsManage(null);
    assert.deepEqual(u.tenants.sort((x, y) => x - y), [1, A].sort((x, y) => x - y));
    assert.equal(u.floorChanged, true);
    platformSettings.invalidate();
    assert.equal((await restrictionService.getMap(1))['restrictions.manage'], undefined);
    assert.equal((await restrictionService.getMap(A))['db.drop'].level, 'sensitive', 'other entries kept');
    assert.deepEqual(await restrictionService.floor(), { 'db.dump': 'restricted' });
    assert.deepEqual((await resetRestrictionsFloor()).removed, ['db.dump']);
    platformSettings.invalidate();
    assert.deepEqual(await restrictionService.floor(), {});
    assert.ok(await db('audit_logs').where({ action: 'restrictions.cli_unlock' }).first());
    assert.ok(await db('audit_logs').where({ action: 'restrictions.cli_floor' }).first());
  });
});
