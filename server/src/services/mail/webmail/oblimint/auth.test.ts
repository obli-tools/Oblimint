import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebmailAuth, LOGIN_MAX_FAILURES_PER_ADDRESS, LOGIN_MAX_FAILURES_PER_IP, WebmailAuthError } from './auth';
import { hashSessionId, WEBMAIL_ABSOLUTE_MS, WEBMAIL_IDLE_MS } from './session';
import { fakeAuthDeps } from './testing';

const IP = '203.0.113.10';

async function rejects(p: Promise<unknown>, code: string, status: number): Promise<void> {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof WebmailAuthError, String(err));
    assert.equal((err as WebmailAuthError).code, code);
    assert.equal((err as WebmailAuthError).status, status);
    return true;
  });
}

test('password login: panel hash AND engine must accept; the session pins the mailbox and its JMAP account', async () => {
  const f = fakeAuthDeps();
  const auth = createWebmailAuth(f.deps);
  const { sid, session } = await auth.login(' Alice@Example.test ', 'alice-password-1', IP, 'UA');
  assert.equal(session.address, 'alice@example.test');
  assert.equal(session.jmapAccountId, 'acctA');
  assert.equal(session.method, 'password');
  assert.ok(f.store.rows.has(hashSessionId(sid)), 'only the hash is stored');
  assert.equal([...f.store.rows.keys()].includes(sid), false);
  const row = f.store.rows.get(hashSessionId(sid))!;
  assert.equal(row.expiresAt - row.createdAt, WEBMAIL_ABSOLUTE_MS);
  assert.deepEqual(f.engine.verifyCalls, ['alice@example.test']);
  assert.equal(f.failures.length, 0);
});

test('wrong password: refused, fed to the ban service, the engine never sees it', async () => {
  const f = fakeAuthDeps();
  const auth = createWebmailAuth(f.deps);
  await rejects(auth.login('alice@example.test', 'nope-nope-nope', IP, null), 'invalidCredentials', 401);
  assert.deepEqual(f.failures, [{ ip: IP, username: 'alice@example.test' }]);
  assert.deepEqual(f.engine.verifyCalls, [], 'no brute force reaches the engine');
  assert.equal(f.store.rows.size, 0);
});

test('unknown address / malformed input: same generic refusal', async () => {
  const f = fakeAuthDeps();
  const auth = createWebmailAuth(f.deps);
  await rejects(auth.login('nobody@example.test', 'whatever-123', IP, null), 'invalidCredentials', 401);
  await rejects(auth.login('a%oblimint-master@example.test', 'x', IP, null), 'invalidCredentials', 401);
  await rejects(auth.login('alice@example.test', '', IP, null), 'invalidCredentials', 401);
  await rejects(auth.login({ address: 1 }, 'x', IP, null), 'invalidCredentials', 401);
  assert.equal(f.failures.length, 4);
  assert.deepEqual(f.engine.verifyCalls, []);
});

test('the engine refusing the password (desynchronized hash) refuses the login', async () => {
  const f = fakeAuthDeps();
  f.boxes.get('bob@example.test')!.engineRefuses = true;
  const auth = createWebmailAuth(f.deps);
  await rejects(auth.login('bob@example.test', 'bob-password-22', IP, null), 'invalidCredentials', 401);
  assert.equal(f.failures.length, 1);
});

test('a disabled mailbox / suspended account / unverified domain cannot log in', async () => {
  for (const patch of [{ mailboxEnabled: false }, { accountStatus: 'suspended' }, { domainVerified: false }, { domainEnabled: false }]) {
    const f = fakeAuthDeps();
    Object.assign(f.boxes.get('alice@example.test')!, patch);
    const auth = createWebmailAuth(f.deps);
    await rejects(auth.login('alice@example.test', 'alice-password-1', IP, null), 'invalidCredentials', 401);
  }
});

test('engine down: 503, no failure counted', async () => {
  const f = fakeAuthDeps();
  f.engine.down = true;
  const auth = createWebmailAuth(f.deps);
  await rejects(auth.login('alice@example.test', 'alice-password-1', IP, null), 'unavailable', 503);
  assert.equal(f.failures.length, 0);
});

test('throttle per client address (IPv6 per /64), then 429 even with the right password', async () => {
  const f = fakeAuthDeps();
  const auth = createWebmailAuth(f.deps);
  const v6 = (n: number) => `2001:db8:5:6::${n}`;
  for (let i = 0; i < LOGIN_MAX_FAILURES_PER_IP; i++) {
    await rejects(auth.login('alice@example.test', `wrong-${i}-xxxx`, v6(i + 1), null), 'invalidCredentials', 401);
  }
  await rejects(auth.login('alice@example.test', 'alice-password-1', v6(999), null), 'tooManyAttempts', 429);
  // Another client is not affected.
  await auth.login('alice@example.test', 'alice-password-1', IP, null);
  // The window slides.
  f.advance(16 * 60_000);
  await auth.login('alice@example.test', 'alice-password-1', v6(1), null);
});

test('throttle per mailbox address (distributed guessing)', async () => {
  const f = fakeAuthDeps();
  const auth = createWebmailAuth(f.deps);
  for (let i = 0; i < LOGIN_MAX_FAILURES_PER_ADDRESS; i++) {
    await rejects(auth.login('bob@example.test', `wrong-${i}-xxxx`, `198.51.100.${i + 1}`, null), 'invalidCredentials', 401);
  }
  await rejects(auth.login('bob@example.test', 'bob-password-22', '192.0.2.200', null), 'tooManyAttempts', 429);
  await auth.login('alice@example.test', 'alice-password-1', '192.0.2.200', null);
});

test('a banned address (mail_bans) cannot log in', async () => {
  const f = fakeAuthDeps();
  f.banned.add(IP);
  const auth = createWebmailAuth(f.deps);
  await rejects(auth.login('alice@example.test', 'alice-password-1', IP, null), 'tooManyAttempts', 429);
});

test('SSO: a valid one-time token opens a session for ITS mailbox; replay / unknown refused', async () => {
  const f = fakeAuthDeps();
  f.ssoTokens.set('tok-bob', 2);
  const auth = createWebmailAuth(f.deps);
  const { session } = await auth.sso('tok-bob', IP, null);
  assert.equal(session.address, 'bob@example.test');
  assert.equal(session.jmapAccountId, 'acctB');
  assert.equal(session.method, 'sso');
  await rejects(auth.sso('tok-bob', IP, null), 'ssoInvalid', 401);
  await rejects(auth.sso('nope', IP, null), 'ssoInvalid', 401);
  f.ssoTokens.set('tok-alice', 1);
  f.boxes.get('alice@example.test')!.mailboxEnabled = false;
  await rejects(auth.sso('tok-alice', IP, null), 'ssoInvalid', 401);
});

test('load(): idle timeout, background calls, revoked mailbox, malformed cookie', async () => {
  const f = fakeAuthDeps();
  const auth = createWebmailAuth(f.deps);
  const { sid } = await auth.login('alice@example.test', 'alice-password-1', IP, null);
  assert.ok(await auth.load(sid, false));
  assert.equal(await auth.load('short', false), null);
  assert.equal(await auth.load(null, false), null);
  // Background calls during 29 min do not keep the session alive.
  f.advance(WEBMAIL_IDLE_MS - 60_000);
  assert.ok(await auth.load(sid, true));
  f.advance(120_000);
  assert.equal(await auth.load(sid, true), null, 'idle');
  assert.equal(f.store.rows.size, 0, 'removed');

  const again = await auth.login('alice@example.test', 'alice-password-1', IP, null);
  f.advance(WEBMAIL_IDLE_MS - 60_000);
  assert.ok(await auth.load(again.sid, false), 'foreground call touches');
  f.advance(WEBMAIL_IDLE_MS - 60_000);
  assert.ok(await auth.load(again.sid, false), 'still alive after the touch');
  f.store.mailboxActive.set(1, false);
  assert.equal(await auth.load(again.sid, false), null, 'mailbox no longer allowed');
});

test('own account guard: a session whose mailbox maps to another JMAP account is refused', async () => {
  const f = fakeAuthDeps();
  const auth = createWebmailAuth(f.deps);
  const { session } = await auth.login('alice@example.test', 'alice-password-1', IP, null);
  await auth.assertOwnAccount(session);
  f.boxes.get('alice@example.test')!.jmapAccountId = 'acctZ';
  await rejects(auth.assertOwnAccount(session), 'notAuthenticated', 401);
});

test('info(): never exposes another mailbox, csrf per session', async () => {
  const f = fakeAuthDeps();
  const auth = createWebmailAuth(f.deps);
  const a = await auth.login('alice@example.test', 'alice-password-1', IP, null);
  const b = await auth.login('bob@example.test', 'bob-password-22', IP, null);
  const ia = await auth.info(a.session, '');
  const ib = await auth.info(b.session, '');
  assert.equal(ia.address, 'alice@example.test');
  assert.deepEqual(ia.identities.map((i) => i.email), ['alice@example.test']);
  assert.notEqual(ia.csrf, ib.csrf);
  const anon = await auth.info(null, 'pre');
  assert.equal(anon.authenticated, false);
  assert.equal(anon.csrf, 'pre');
});
