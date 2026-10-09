import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'net';
import express from 'express';
import { createDbAdminInternalRouter, DBADMIN_KEY_HEADER } from './internalRoutes';
import { createDbAdminSourceCheck } from './sourceCheck';
import { dbAdminKey, MAX_TOKENS_PER_ACCOUNT, phpMyAdminBlowfishSecret, SSO_TOKEN_RE, SsoTokenStore, type SsoTicket } from './ssoTokens';

// SSO token lifecycle (single use, 60 s, per UI), source check and the
// internal redeem route (B3), with fakes: no Docker DNS, loopback listener.

const ticket = (kind: SsoTicket['kind'] = 'phpmyadmin'): SsoTicket => ({
  kind,
  instanceId: 4,
  accountId: 2,
  credentials: {
    engine: kind === 'phpmyadmin' ? 'mariadb' : 'postgresql', host: 'db-4', port: 3306, user: 'oblsso_0a1b2c3d',
    password: 'p'.repeat(32), database: null, expiresAt: '2026-10-09T12:00:00.000Z',
  },
});

test('token store: single use, expiry, kind, format, sweep, revoke', () => {
  let now = 1_000_000;
  const store = new SsoTokenStore(() => now);
  const a = store.issue(ticket());
  assert.match(a.token, SSO_TOKEN_RE);
  assert.equal(a.expiresAt.getTime(), now + 60_000);
  assert.equal(store.redeem(a.token, 'adminer'), null, 'wrong UI');
  assert.equal(store.redeem(a.token, 'phpmyadmin'), null, 'a failed redemption burns the token too');

  const b = store.issue(ticket());
  assert.deepEqual(store.redeem(b.token, 'phpmyadmin')?.credentials.user, 'oblsso_0a1b2c3d');
  assert.equal(store.redeem(b.token, 'phpmyadmin'), null, 'replay refused');

  const c = store.issue(ticket('adminer'));
  now += 60_001;
  assert.equal(store.redeem(c.token), null, 'expired');

  for (const bad of [undefined, null, 42, '', 'x'.repeat(43) + '!', 'short', { token: 'x' }]) assert.equal(store.redeem(bad), null);

  store.issue(ticket());
  now += 61_000;
  assert.equal(store.sweep(), 1);
  assert.equal(store.size, 0);

  const d = store.issue(ticket());
  store.revokeInstance(4);
  assert.equal(store.redeem(d.token), null);
});

test('token store: a flooding account only evicts its own tokens', () => {
  const store = new SsoTokenStore(() => 5_000);
  const forAccount = (accountId: number): SsoTicket => ({ ...ticket(), accountId });
  const victim = store.issue(forAccount(1));
  const flood: string[] = [];
  for (let i = 0; i < MAX_TOKENS_PER_ACCOUNT * 5; i++) flood.push(store.issue(forAccount(2)).token);
  assert.equal(store.size, MAX_TOKENS_PER_ACCOUNT + 1, 'per-account bound');
  assert.equal(store.redeem(flood[0]), null, 'its oldest tokens went');
  assert.ok(store.redeem(flood.at(-1)), 'its newest is valid');
  assert.ok(store.redeem(victim.token), 'the other account\'s token survived');
});

test('derived secrets are stable, distinct and depend on the session secret', () => {
  assert.equal(dbAdminKey('s1'), dbAdminKey('s1'));
  assert.notEqual(dbAdminKey('s1'), dbAdminKey('s2'));
  assert.notEqual(dbAdminKey('s1'), phpMyAdminBlowfishSecret('s1'));
  assert.match(phpMyAdminBlowfishSecret('s1'), /^[0-9a-f]{64}$/);
});

test('source check: only the admin containers\' addresses, never loopback, cached lookups', async () => {
  let lookups = 0;
  let now = 0;
  const table: Record<string, string[]> = { 'oblimint-phpmyadmin': ['172.18.0.5', '172.20.0.9'], 'oblimint-adminer': ['172.18.0.6'] };
  const check = createDbAdminSourceCheck({
    resolve: async (name) => { lookups++; if (!table[name]) throw new Error('ENOTFOUND'); return table[name]; },
    now: () => now,
  });
  assert.equal(await check('::ffff:172.18.0.5'), 'phpmyadmin');
  assert.equal(await check('172.20.0.9'), 'phpmyadmin', 'its address on an account network too');
  assert.equal(await check('172.18.0.6'), 'adminer');
  assert.equal(await check('127.0.0.1'), null, 'loopback is not an admin container');
  assert.equal(await check('::1'), null);
  assert.equal(await check('172.18.0.50'), null, 'a site container');
  assert.equal(await check(undefined), null);
  assert.equal(await check('garbage'), null);
  const before = lookups;
  await check('172.18.0.5');
  assert.equal(lookups, before, 'cache hit');
  // recreated container → new address, found after the retry delay
  table['oblimint-adminer'] = ['172.18.0.7'];
  now += 3_000;
  assert.equal(await check('172.18.0.7'), 'adminer');
});

async function listen(t: TestContext, app: express.Express): Promise<string> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('redeem route: key + source + single-use token, every refusal a bare 404', async (t) => {
  const store = new SsoTokenStore();
  let source: 'phpmyadmin' | 'adminer' | null = 'phpmyadmin';
  const seen: Array<string | undefined> = [];
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/internal/dbadmin', createDbAdminInternalRouter({
    key: () => 'the-key',
    sourceKind: async (addr) => { seen.push(addr); return source; },
    store,
    ratePerMinute: 1000,
  }));
  const base = await listen(t, app);
  const redeem = (token: unknown, key: string | null = 'the-key') => fetch(`${base}/internal/dbadmin/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key !== null ? { [DBADMIN_KEY_HEADER]: key } : {}) },
    body: JSON.stringify({ token }),
  });

  const { token } = store.issue(ticket());
  let r = await redeem(token, 'wrong-key');
  assert.equal(r.status, 404);
  r = await redeem(token, null);
  assert.equal(r.status, 404);
  assert.equal(seen.length, 0, 'no DNS work before the key matches');

  source = null;
  r = await redeem(token);
  assert.equal(r.status, 404, 'right key from a site container');

  source = 'adminer';
  const t2 = store.issue(ticket());
  r = await redeem(t2.token);
  assert.equal(r.status, 404, 'a phpMyAdmin token is not redeemable by Adminer');

  source = 'phpmyadmin';
  const t3 = store.issue(ticket());
  r = await redeem(t3.token);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const body = await r.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['database', 'engine', 'expiresAt', 'host', 'password', 'port', 'user']);
  assert.equal(body.host, 'db-4');
  r = await redeem(t3.token);
  assert.equal(r.status, 404, 'replay');

  r = await redeem('nope');
  assert.equal(r.status, 404);
  r = await fetch(`${base}/internal/dbadmin/other`, { method: 'POST' });
  assert.equal(r.status, 404);
  assert.match(seen.find((a) => !!a) ?? '', /127\.0\.0\.1/, 'the peer address is what is checked');
});

test('redeem route is rate-limited per peer', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/internal/dbadmin', createDbAdminInternalRouter({ key: () => 'k', sourceKind: async () => null, store: new SsoTokenStore(), ratePerMinute: 3 }));
  const base = await listen(t, app);
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) {
    statuses.push((await fetch(`${base}/internal/dbadmin/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status);
  }
  assert.deepEqual(statuses, [404, 404, 404, 429, 429]);
});
