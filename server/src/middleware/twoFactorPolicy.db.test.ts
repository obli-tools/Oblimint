import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// force_2fa against the real panel app (createApp: session, guards, routers)
// on a real PostgreSQL: GUARDS_TEST_DATABASE_URL (default: the harness on port
// 55512). Skipped cleanly when nothing listens. Covers H1: a local account
// without TOTP signed in under force_2fa must not reach a route by changing
// the case of its path (POST /API/accounts/:id/api-keys, PUT
// /API/admin/config/force_2fa) — refused (403 twoFactorSetupRequired), and
// the routing itself is case-sensitive (404 once force_2fa is off).
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.GUARDS_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55512/postgres';

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

type Reply = { status: number; body: string; json: { code?: string; success?: boolean } | null; cookies: string[] };

/** Plain HTTP client (no Origin / Sec-Fetch headers: a script, like the phished-password scenario). */
function send(port: number, method: string, urlPath: string, opts: { cookie?: string; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    if (payload !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(payload)); }
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers, agent: false }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json: Reply['json'] = null;
        try { json = JSON.parse(data); } catch { /* HTML 404 of Express */ }
        const sc = res.headers['set-cookie'];
        resolve({ status: res.statusCode ?? 0, body: data, json, cookies: Array.isArray(sc) ? sc : sc ? [sc] : [] });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

test('force_2fa: no route is reached by changing the case of its path (H1)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-2fa-case-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'twofactor-case-test-secret-0123456789abcdef';

  const { db } = await import('../db');
  const { createApp } = await import('../app');
  const { forgetTwoFactorPolicy } = await import('./sessionUserGuard');
  const { hashPassword } = await import('../utils/crypto');
  const { SESSION_COOKIE_NAME } = await import('../config');

  await db.migrate.latest();

  // ── fixtures: a tenant admin (staff, local password, no TOTP) and an account ──
  const suffix = Date.now().toString(36);
  const [ta] = await db('tenants').insert({ name: `F ${suffix}`, slug: `f-${suffix}` }).returning('id');
  const tA = Number(ta.id ?? ta);
  const password = 'Case-Test-Password-42';
  const [urow] = await db('users').insert({
    username: `phished-${suffix}`, kind: 'staff', role: 'user', is_active: true, password_hash: await hashPassword(password),
  }).returning('id');
  const userId = Number(urow.id ?? urow);
  await db('user_tenants').insert({ user_id: userId, tenant_id: tA, role: 'admin' });
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined;
  const nodeId = localNode?.id ?? Number((await db('nodes').insert({ name: `n-${suffix}`, is_local: true }).returning('id'))[0].id);
  const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify({}) }).returning('id');
  const uid = 20000 + Math.floor(Math.random() * 30000);
  const [acct] = await db('hosting_accounts').insert({
    tenant_id: tA, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: `fa${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
  }).returning('id');
  const accountId = Number(acct.id ?? acct);

  const setForce = async (on: boolean) => {
    await db('app_config').insert({ key: 'force_2fa', value: on ? 'true' : 'false' }).onConflict('key').merge();
    forgetTwoFactorPolicy();
  };
  const forceValue = async () => ((await db('app_config').where({ key: 'force_2fa' }).first('value')) as { value: string } | undefined)?.value;
  const keyCount = async () => Number(((await db('api_keys').where({ account_id: accountId }).count({ n: '*' }))[0] as { n: string | number }).n);

  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  // One hook, in order: the server, the policy back off, then the pool.
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await setForce(false);
    await db.destroy();
  });

  // ── sign in with the password alone (force_2fa does not block the sign-in itself) ──
  await setForce(true);
  const login = await send(port, 'POST', '/api/auth/login', { body: { username: `phished-${suffix}`, password } });
  assert.equal(login.status, 200, login.body);
  const sid = login.cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  assert.ok(sid, 'session cookie set');
  const as = (method: string, p: string, body?: unknown) => send(port, method, p, { cookie: sid, body });

  const me = await as('GET', '/api/auth/me');
  assert.equal(me.status, 200, me.body);

  // ── force_2fa on: every case variant is refused before any route ──
  const newKey = { name: 'stolen', scopes: [], siteScope: 'all' };
  for (const p of [`/api/accounts/${accountId}/api-keys`, `/API/accounts/${accountId}/api-keys`, `/Api/accounts/${accountId}/api-keys`, `/api/ACCOUNTS/${accountId}/api-keys`]) {
    const r = await as('POST', p, newKey);
    assert.equal(r.status, 403, `POST ${p}: ${r.body}`);
    assert.equal(r.json?.code, 'twoFactorSetupRequired', `POST ${p}`);
  }
  for (const p of ['/api/admin/config/force_2fa', '/API/admin/config/force_2fa', '/api/ADMIN/config/force_2fa']) {
    const r = await as('PUT', p, { value: 'false' });
    assert.equal(r.status, 403, `PUT ${p}: ${r.body}`);
    assert.equal(r.json?.code, 'twoFactorSetupRequired', `PUT ${p}`);
  }
  // A case variant of an allowed path is refused too (exact allow-list).
  const meUpper = await as('GET', '/API/auth/me');
  assert.equal(meUpper.status, 403, meUpper.body);
  assert.equal(await keyCount(), 0, 'no key was created');
  assert.equal(await forceValue(), 'true', 'force_2fa still on');

  // ── force_2fa off: the routing itself is case-sensitive (a variant reaches no route) ──
  await setForce(false);
  for (const p of [`/API/accounts/${accountId}/api-keys`, `/api/ACCOUNTS/${accountId}/api-keys`]) {
    const r = await as('POST', p, newKey);
    assert.equal(r.status, 404, `POST ${p}: ${r.body}`);
  }
  const upperCfg = await as('PUT', '/API/admin/config/force_2fa', { value: 'true' });
  assert.equal(upperCfg.status, 404, upperCfg.body);
  assert.equal((await as('GET', '/API/auth/me')).status, 404);
  assert.equal(await keyCount(), 0, 'no key was created by a case variant');
  // …while the exact path works for this account (the fixture would have succeeded).
  const created = await as('POST', `/api/accounts/${accountId}/api-keys`, newKey);
  assert.equal(created.status, 201, created.body);
  assert.equal(await keyCount(), 1);
});
