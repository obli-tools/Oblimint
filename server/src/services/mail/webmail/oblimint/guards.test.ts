import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cookieHeader, FailureCounter, readCookie, requestHost, sameOrigin, throttleKey, WEBMAIL_CSP } from './guards';
import {
  hashSessionId, mailboxLoginAllowed, newSessionId, SESSION_ID_RE, sessionState, shouldTouch, tokensEqual, WEBMAIL_IDLE_MS, WEBMAIL_TOUCH_EVERY_MS,
} from './session';

test('session ids: 256-bit base64url, only the hash is stored', () => {
  const a = newSessionId();
  const b = newSessionId();
  assert.match(a, SESSION_ID_RE);
  assert.notEqual(a, b);
  assert.match(hashSessionId(a), /^[0-9a-f]{64}$/);
  assert.notEqual(hashSessionId(a), a);
});

test('idle timeout, absolute lifetime and background calls', () => {
  const s = { lastSeenAt: 1_000_000, expiresAt: 1_000_000 + 12 * 3600_000 };
  assert.equal(sessionState(s, 1_000_000 + WEBMAIL_IDLE_MS - 1), 'valid');
  assert.equal(sessionState(s, 1_000_000 + WEBMAIL_IDLE_MS), 'idle');
  assert.equal(sessionState({ lastSeenAt: s.expiresAt - 10, expiresAt: s.expiresAt }, s.expiresAt), 'expired');
  // Background calls (event stream, refresh) never extend the session.
  assert.equal(shouldTouch(s, s.lastSeenAt + WEBMAIL_TOUCH_EVERY_MS, true), false);
  assert.equal(shouldTouch(s, s.lastSeenAt + WEBMAIL_TOUCH_EVERY_MS, false), true);
  assert.equal(shouldTouch(s, s.lastSeenAt + 10, false), false);
});

test('CSRF token comparison is exact and refuses empty values', () => {
  assert.equal(tokensEqual('abc', 'abc'), true);
  assert.equal(tokensEqual('abc', 'abd'), false);
  assert.equal(tokensEqual('abc', 'abcd'), false);
  assert.equal(tokensEqual('', ''), false);
  assert.equal(tokensEqual(undefined, 'x'), false);
  assert.equal(tokensEqual('x', null), false);
});

test('same-origin check of state-changing requests', () => {
  const h = (origin: string | undefined, site?: string) => ({ origin, host: 'webmail.example.test', 'sec-fetch-site': site });
  assert.equal(sameOrigin(h('https://webmail.example.test'), true), true);
  assert.equal(sameOrigin(h('https://webmail.example.test', 'same-origin'), true), true);
  assert.equal(sameOrigin(h('https://webmail.example.test', 'same-site'), true), false);
  assert.equal(sameOrigin(h('https://webmail.example.test', 'cross-site'), true), false);
  assert.equal(sameOrigin(h('https://evil.example'), true), false);
  assert.equal(sameOrigin(h('https://panel.example.test'), true), false);
  assert.equal(sameOrigin(h('http://webmail.example.test'), true), false, 'http origin refused in production');
  assert.equal(sameOrigin(h('http://webmail.example.test'), false), true, 'dev: plain http');
  assert.equal(sameOrigin(h(undefined), true), false, 'no Origin = refused');
  assert.equal(sameOrigin(h('null'), true), false, 'opaque origin (sandboxed iframe, file:) refused');
  assert.equal(sameOrigin({ origin: 'https://x', host: 'bad host\r\n' }, true), false);
  assert.equal(requestHost('Webmail.Example.Test:443'), 'webmail.example.test:443');
});

test('cookies: host-only, HttpOnly, SameSite=Strict, Secure in production', () => {
  const c = cookieHeader('__Host-oblimint-wm', 'abc', { secure: true, maxAgeSec: 60 });
  assert.match(c, /^__Host-oblimint-wm=abc; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=60$/);
  assert.doesNotMatch(c, /Domain=/i);
  assert.match(cookieHeader('x', '', { secure: true, clear: true }), /Max-Age=0/);
  assert.doesNotMatch(cookieHeader('oblimint-wm', 'v', { secure: false }), /Secure/);
  assert.equal(readCookie('a=1; __Host-oblimint-wm=xyz; b=2', '__Host-oblimint-wm'), 'xyz');
  assert.equal(readCookie('oblimint-wm=dev', '__Host-oblimint-wm'), null);
  assert.equal(readCookie(undefined, 'a'), null);
});

test('login throttle keys: IPv4 as is, IPv6 per /64', () => {
  assert.equal(throttleKey('203.0.113.7'), '203.0.113.7');
  assert.equal(throttleKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(throttleKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(throttleKey('2001:db8:1:2::9'), '2001:db8:1:2::/64');
  assert.equal(throttleKey('2001:db8::1'), '2001:db8:0:0::/64');
});

test('failure counter: sliding window and bounded', () => {
  const c = new FailureCounter(1000, 3, 2);
  c.record('a', 0); c.record('a', 100);
  assert.equal(c.blocked('a', 200), false);
  c.record('a', 300);
  assert.equal(c.blocked('a', 400), true);
  assert.ok(c.retryAfterSec('a', 400) >= 1);
  assert.equal(c.blocked('a', 1200), false, 'window slid');
  c.record('b', 0); c.record('c', 0);
  assert.equal(c.count('a', 0) + c.count('b', 0) + c.count('c', 0) <= 4, true);
});

test('a mailbox logs in only when enabled, domain enabled and verified, account served', () => {
  const ok = { mailboxEnabled: true, domainEnabled: true, domainVerified: true, accountStatus: 'active' };
  assert.equal(mailboxLoginAllowed(ok), true);
  assert.equal(mailboxLoginAllowed({ ...ok, accountStatus: 'error' }), true);
  assert.equal(mailboxLoginAllowed({ ...ok, mailboxEnabled: false }), false);
  assert.equal(mailboxLoginAllowed({ ...ok, domainEnabled: false }), false);
  assert.equal(mailboxLoginAllowed({ ...ok, domainVerified: false }), false);
  assert.equal(mailboxLoginAllowed({ ...ok, accountStatus: 'suspended' }), false);
  assert.equal(mailboxLoginAllowed({ ...ok, accountStatus: 'deleting' }), false);
});

test('host CSP: no inline script, no third party, no framing, no forms', () => {
  assert.match(WEBMAIL_CSP, /script-src 'self'(;|$)/);
  assert.doesNotMatch(WEBMAIL_CSP, /script-src[^;]*unsafe/);
  assert.match(WEBMAIL_CSP, /frame-ancestors 'none'/);
  assert.match(WEBMAIL_CSP, /form-action 'none'/);
  assert.match(WEBMAIL_CSP, /connect-src 'self'/);
  assert.match(WEBMAIL_CSP, /object-src 'none'/);
  assert.match(WEBMAIL_CSP, /base-uri 'none'/);
  assert.doesNotMatch(WEBMAIL_CSP, /https?:\/\//, 'no third-party origin');
});
