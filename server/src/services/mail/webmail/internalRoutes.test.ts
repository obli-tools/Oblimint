import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'net';
import express from 'express';
import { createMailInternalRouter, createWebmailSourceCheck } from './internalRoutes';
import type { WebmailCredentials } from './ssoTokens';

// Internal webmail SSO routes: wrong source → 404, wrong key → 404, both
// right → credentials; logout; never an oracle in the answers.

const KEY = 'a'.repeat(64);
const CREDS: WebmailCredentials = { username: 'contact@example.test', password: 'S3ss10n-Credential', expiresAt: '2030-01-01T00:00:00.000Z' };

async function serve(t: TestContext, sourceOk: () => boolean) {
  const redeemed: unknown[] = [];
  const loggedOut: Array<[unknown, unknown]> = [];
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/internal/mail', createMailInternalRouter({
    key: () => KEY,
    isWebmailSource: async () => sourceOk(),
    redeem: async (token) => { redeemed.push(token); return token === 'good' ? CREDS : null; },
    logout: async (u, p) => { loggedOut.push([u, p]); return u === CREDS.username && p === CREDS.password; },
    ratePerMinute: 1000,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/mail`;
  const post = async (path: string, body: unknown, key: string | null = KEY) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key !== null ? { 'x-oblimint-webmail-key': key } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, cache: res.headers.get('cache-control') };
  };
  return { post, redeemed, loggedOut };
}

test('redeem: both checks right → credentials, no-store', async (t) => {
  const { post } = await serve(t, () => true);
  const r = await post('/webmail/redeem', { token: 'good' });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text), CREDS);
  assert.equal(r.cache, 'no-store');
});

test('redeem: wrong / missing key → bare 404, the token is not even looked at', async (t) => {
  const { post, redeemed } = await serve(t, () => true);
  for (const key of ['b'.repeat(64), '', null]) {
    const r = await post('/webmail/redeem', { token: 'good' }, key);
    assert.equal(r.status, 404);
    assert.equal(r.text, '{"ok":false}');
  }
  assert.equal(redeemed.length, 0);
});

test('redeem: wrong source → bare 404 (same answer as an unknown token)', async (t) => {
  const { post, redeemed } = await serve(t, () => false);
  const wrongSource = await post('/webmail/redeem', { token: 'good' });
  assert.equal(wrongSource.status, 404);
  assert.equal(redeemed.length, 0);
  const ok = await serve(t, () => true);
  const unknown = await ok.post('/webmail/redeem', { token: 'nope' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.text, wrongSource.text, 'no oracle between refusals');
});

test('logout: checks first, then { revoked }', async (t) => {
  const { post, loggedOut } = await serve(t, () => true);
  const yes = await post('/webmail/logout', { username: CREDS.username, password: CREDS.password });
  assert.equal(yes.status, 200);
  assert.deepEqual(JSON.parse(yes.text), { revoked: true });
  const no = await post('/webmail/logout', { username: CREDS.username, password: 'other' });
  assert.deepEqual(JSON.parse(no.text), { revoked: false });
  const badKey = await post('/webmail/logout', { username: CREDS.username, password: CREDS.password }, 'c'.repeat(64));
  assert.equal(badKey.status, 404);
  assert.equal(loggedOut.length, 2);
});

test('unknown paths and methods → 404', async (t) => {
  const { post } = await serve(t, () => true);
  assert.equal((await post('/webmail/other', {})).status, 404);
  assert.equal((await post('/dbadmin/redeem', { token: 'good' })).status, 404);
});

test('rate limited per peer', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/internal/mail', createMailInternalRouter({
    key: () => KEY, isWebmailSource: async () => true, redeem: async () => null, logout: async () => false, ratePerMinute: 3,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/mail/webmail/redeem`;
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) {
    codes.push((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-oblimint-webmail-key': KEY }, body: '{}' })).status);
  }
  assert.deepEqual(codes, [404, 404, 404, 429, 429]);
});

test('source check: only the webmail container addresses, cached, loopback refused, lookups throttled', async () => {
  let now = 0;
  let lookups = 0;
  let addrs = ['172.30.0.5', 'fd00:abcd::5'];
  const check = createWebmailSourceCheck({ addresses: async () => { lookups++; return addrs; }, now: () => now, ttlMs: 30_000, retryMs: 2_000 });
  assert.equal(await check('::ffff:172.30.0.5'), true, 'IPv4-mapped unwrapped');
  assert.equal(await check('fd00:abcd::5'), true);
  assert.equal(lookups, 1);
  assert.equal(await check('127.0.0.1'), false, 'loopback is not the webmail container');
  assert.equal(await check('::1'), false);
  assert.equal(await check(undefined), false);
  assert.equal(await check('172.30.0.6'), false);
  assert.equal(lookups, 1, 'mismatch within retryMs: no new lookup');
  // Container recreated with a new address.
  addrs = ['172.30.0.9'];
  now = 5_000;
  assert.equal(await check('172.30.0.9'), true);
  assert.equal(lookups, 2);
  assert.equal(await check('172.30.0.5'), false, 'old address forgotten');
});

test('source check: a failing lookup (network missing, stub) means nobody', async () => {
  const check = createWebmailSourceCheck({ addresses: async () => { throw new Error('not implemented'); } });
  assert.equal(await check('172.30.0.5'), false);
});
