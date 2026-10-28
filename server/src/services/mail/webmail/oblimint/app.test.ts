import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import http from 'http';
import { createWebmailApp, relayEvent } from './app';
import { createWebmailAuth } from './auth';
import { fakeAuthDeps } from './testing';

interface Harness {
  base: string;
  origin: string;
  close(): Promise<void>;
  f: ReturnType<typeof fakeAuthDeps>;
  setEnabled(v: boolean): void;
}

async function start(): Promise<Harness> {
  const f = fakeAuthDeps();
  const auth = createWebmailAuth(f.deps);
  let enabled = true;
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-dist-'));
  fs.writeFileSync(path.join(dist, 'webmail.html'), '<!doctype html><title>wm</title>');
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'assets', 'a.js'), 'console.log(1)');
  const app = createWebmailApp({
    auth,
    engine: f.engine,
    enabled: async () => enabled,
    secure: true,
    clientIp: () => '203.0.113.50',
    maxUploadBytes: async () => 1024,
    vacation: { get: async () => null, set: async (_id, v) => v },
    clientDist: dist,
    now: f.now,
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    origin: `https://127.0.0.1:${port}`,
    f,
    setEnabled: (v) => { enabled = v; },
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

function cookiesOf(res: Response): string[] {
  return res.headers.getSetCookie();
}

function cookieValue(setCookies: string[], name: string): string | null {
  for (const c of setCookies) {
    const m = new RegExp(`^${name.replace(/[-]/g, '\\-')}=([^;]*)`).exec(c);
    if (m) return m[1];
  }
  return null;
}

/** Logs `address` in through the API; returns the cookie header and the CSRF token. */
async function login(h: Harness, address: string, password: string): Promise<{ cookie: string; csrf: string }> {
  const s = await fetch(`${h.base}/wm-api/session`);
  const pre = cookieValue(cookiesOf(s), '__Host-oblimint-wm-csrf')!;
  const info = await s.json() as { csrf: string };
  assert.equal(info.csrf, pre);
  const r = await fetch(`${h.base}/wm-api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: h.origin, Cookie: `__Host-oblimint-wm-csrf=${pre}`, 'X-Oblimint-CSRF': pre },
    body: JSON.stringify({ address, password }),
  });
  assert.equal(r.status, 200);
  const sid = cookieValue(cookiesOf(r), '__Host-oblimint-wm')!;
  const body = await r.json() as { csrf: string; authenticated: boolean };
  assert.equal(body.authenticated, true);
  return { cookie: `__Host-oblimint-wm=${sid}`, csrf: body.csrf };
}

test('page and API carry the security headers; disabled webmail = 404', async () => {
  const h = await start();
  try {
    const p = await fetch(`${h.base}/`);
    assert.equal(p.status, 200);
    assert.match(p.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.equal(p.headers.get('x-frame-options'), 'DENY');
    assert.equal(p.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(p.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(p.headers.get('strict-transport-security'));
    const a = await fetch(`${h.base}/assets/a.js`);
    assert.equal(a.status, 200);
    // Raw path (fetch would normalize it): nothing outside assets/ is served.
    const raw = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get(`${h.base}/assets/..%2f..%2fwebmail.html`, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }).on('error', reject);
    });
    assert.ok([403, 404].includes(raw.status), `no traversal out of assets/ (${raw.status})`);
    const s = await fetch(`${h.base}/wm-api/session`);
    assert.equal(s.headers.get('cache-control'), 'no-store');
    assert.match(s.headers.get('content-security-policy') ?? '', /sandbox/);
    h.setEnabled(false);
    assert.equal((await fetch(`${h.base}/wm-api/session`)).status, 404);
    assert.equal((await fetch(`${h.base}/`)).status, 404);
  } finally { await h.close(); }
});

test('login: pre-login CSRF double submit, same Origin, JSON only; cookie is __Host-, HttpOnly, Secure, SameSite=Strict', async () => {
  const h = await start();
  try {
    const s = await fetch(`${h.base}/wm-api/session`);
    const pre = cookieValue(cookiesOf(s), '__Host-oblimint-wm-csrf')!;
    assert.match(pre, /^[A-Za-z0-9_-]{43}$/);
    const body = JSON.stringify({ address: 'alice@example.test', password: 'alice-password-1' });
    const post = (headers: Record<string, string>) => fetch(`${h.base}/wm-api/login`, { method: 'POST', headers, body });
    assert.equal((await post({ 'Content-Type': 'application/json', Origin: h.origin, Cookie: `__Host-oblimint-wm-csrf=${pre}` })).status, 403, 'no CSRF header');
    assert.equal((await post({ 'Content-Type': 'application/json', Origin: h.origin, Cookie: `__Host-oblimint-wm-csrf=${pre}`, 'X-Oblimint-CSRF': 'x'.repeat(43) })).status, 403, 'wrong token');
    assert.equal((await post({ 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: `__Host-oblimint-wm-csrf=${pre}`, 'X-Oblimint-CSRF': pre })).status, 403, 'foreign origin');
    assert.equal((await post({ 'Content-Type': 'application/json', Cookie: `__Host-oblimint-wm-csrf=${pre}`, 'X-Oblimint-CSRF': pre })).status, 403, 'no origin');
    assert.equal((await post({ 'Content-Type': 'application/json', Origin: h.origin, 'Sec-Fetch-Site': 'cross-site', Cookie: `__Host-oblimint-wm-csrf=${pre}`, 'X-Oblimint-CSRF': pre })).status, 403);
    assert.equal((await post({ 'Content-Type': 'text/plain', Origin: h.origin, Cookie: `__Host-oblimint-wm-csrf=${pre}`, 'X-Oblimint-CSRF': pre })).status, 415, 'form-encodable type refused');
    const ok = await post({ 'Content-Type': 'application/json', Origin: h.origin, Cookie: `__Host-oblimint-wm-csrf=${pre}`, 'X-Oblimint-CSRF': pre });
    assert.equal(ok.status, 200);
    const sc = cookiesOf(ok).find((c) => c.startsWith('__Host-oblimint-wm='))!;
    assert.match(sc, /; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=\d+/);
    assert.doesNotMatch(sc, /Domain/i);
    const bad = await fetch(`${h.base}/wm-api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: h.origin, Cookie: `__Host-oblimint-wm-csrf=${pre}`, 'X-Oblimint-CSRF': pre },
      body: JSON.stringify({ address: 'alice@example.test', password: 'wrong-password' }),
    });
    assert.equal(bad.status, 401);
    assert.deepEqual(await bad.json(), { error: 'invalidCredentials', message: 'Wrong address or password' });
    assert.equal(h.f.failures.length, 1);
    assert.equal(h.f.failures[0].ip, '203.0.113.50');
  } finally { await h.close(); }
});

test('JMAP proxy: session CSRF required; the call runs as the session mailbox with its account forced', async () => {
  const h = await start();
  try {
    const a = await login(h, 'alice@example.test', 'alice-password-1');
    const jmap = (cookie: string, csrf: string | null, body: unknown) => fetch(`${h.base}/wm-api/jmap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: h.origin, Cookie: cookie, ...(csrf ? { 'X-Oblimint-CSRF': csrf } : {}) },
      body: JSON.stringify(body),
    });
    assert.equal((await jmap(a.cookie, null, { methodCalls: [['Mailbox/get', {}, '0']] })).status, 403);
    const r = await jmap(a.cookie, a.csrf, { methodCalls: [['Mailbox/get', {}, '0']] });
    assert.equal(r.status, 200);
    const out = await r.json() as { methodResponses: Array<[string, Record<string, unknown>, string]> };
    assert.equal(out.methodResponses[0][1].accountId, 'acctA');
    assert.equal(out.methodResponses[0][1].echoedBy, 'alice@example.test');
    assert.equal((await jmap('', a.csrf, { methodCalls: [['Mailbox/get', {}, '0']] })).status, 401);
  } finally { await h.close(); }
});

test("isolation: mailbox A's session can never reach mailbox B's account", async () => {
  const h = await start();
  try {
    const a = await login(h, 'alice@example.test', 'alice-password-1');
    const b = await login(h, 'bob@example.test', 'bob-password-22');
    const before = h.f.engine.calls.length;
    const asA = (body: unknown, csrf = a.csrf) => fetch(`${h.base}/wm-api/jmap`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: h.origin, Cookie: a.cookie, 'X-Oblimint-CSRF': csrf }, body: JSON.stringify(body),
    });
    // 1. explicit other account
    assert.equal((await asA({ methodCalls: [['Email/query', { accountId: 'acctB' }, '0']] })).status, 403);
    // 2. B's CSRF token with A's cookie
    assert.equal((await asA({ methodCalls: [['Email/query', {}, '0']] }, b.csrf)).status, 403);
    // 3. cross-account copy
    assert.equal((await asA({ methodCalls: [['Email/copy', { fromAccountId: 'acctB', accountId: 'acctA' }, '0']] })).status, 403);
    assert.equal(h.f.engine.calls.length, before, 'nothing reached the engine');
    // 4. whatever A does runs impersonating A only
    await asA({ methodCalls: [['Email/query', {}, '0']] });
    assert.deepEqual(h.f.engine.calls.slice(before).map((c) => [c.address, c.methodCalls[0][1].accountId]), [['alice@example.test', 'acctA']]);
    // 5. blobs: always A's account
    const blob = await fetch(`${h.base}/wm-api/blob/Gb1?name=x.html`, { headers: { Cookie: a.cookie } });
    assert.match(await blob.text(), /alice@example\.test acctA Gb1/);
  } finally { await h.close(); }
});

test('downloads are attachments, never rendered; uploads are bounded', async () => {
  const h = await start();
  try {
    const a = await login(h, 'alice@example.test', 'alice-password-1');
    const d = await fetch(`${h.base}/wm-api/blob/Gb1?name=${encodeURIComponent('évil".html')}`, { headers: { Cookie: a.cookie } });
    assert.equal(d.status, 200);
    assert.equal(d.headers.get('content-type'), 'application/octet-stream');
    assert.match(d.headers.get('content-disposition') ?? '', /^attachment; filename="/);
    assert.equal(d.headers.get('x-content-type-options'), 'nosniff');
    assert.match(d.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.equal((await fetch(`${h.base}/wm-api/blob/..%2Fx`, { headers: { Cookie: a.cookie } })).status, 400);

    const up = (size: number, csrf = a.csrf) => fetch(`${h.base}/wm-api/upload`, {
      method: 'POST', headers: { 'Content-Type': 'image/png', Origin: h.origin, Cookie: a.cookie, 'X-Oblimint-CSRF': csrf }, body: new Uint8Array(size),
    });
    const ok = await up(1000);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { blobId: 'blob-1000', type: 'image/png', size: 1000 });
    assert.equal(h.f.engine.uploads[0].accountId, 'acctA');
    assert.equal((await up(5000)).status, 413);
    assert.equal((await up(10, 'nope')).status, 403);
  } finally { await h.close(); }
});

test('logout ends the session server side and clears the cookie', async () => {
  const h = await start();
  try {
    const a = await login(h, 'alice@example.test', 'alice-password-1');
    const out = await fetch(`${h.base}/wm-api/logout`, { method: 'POST', headers: { Origin: h.origin, Cookie: a.cookie, 'X-Oblimint-CSRF': a.csrf } });
    assert.equal(out.status, 200);
    assert.ok(cookiesOf(out).some((c) => /^__Host-oblimint-wm=;.*Max-Age=0/.test(c)));
    assert.equal(h.f.store.rows.size, 0);
    const again = await fetch(`${h.base}/wm-api/jmap`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: h.origin, Cookie: a.cookie, 'X-Oblimint-CSRF': a.csrf },
      body: JSON.stringify({ methodCalls: [['Mailbox/get', {}, '0']] }),
    });
    assert.equal(again.status, 401);
  } finally { await h.close(); }
});

test('vacation: validated, CSRF protected', async () => {
  const h = await start();
  try {
    const a = await login(h, 'alice@example.test', 'alice-password-1');
    const put = (body: unknown, csrf = a.csrf) => fetch(`${h.base}/wm-api/vacation`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: h.origin, Cookie: a.cookie, 'X-Oblimint-CSRF': csrf }, body: JSON.stringify(body),
    });
    assert.equal((await put({ enabled: true, subject: 'Away', body: 'Back Monday' }, 'x')).status, 403);
    assert.equal((await put({ enabled: true, subject: '', body: '' })).status, 400);
    assert.equal((await put({ enabled: true, subject: 'Away', body: 'x', startsAt: '2026-01-02', endsAt: '2026-01-01' })).status, 400);
    assert.equal((await put({ enabled: true, subject: 'Away', body: 'x', script: 'redirect "x@y"' })).status, 400);
    const ok = await put({ enabled: true, subject: 'Away', body: 'Back Monday', intervalDays: 3 });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { intervalDays: number }).intervalDays, 3);
  } finally { await h.close(); }
});

test('SSO: token in the body, pre-login CSRF; a second SSO replaces the session', async () => {
  const h = await start();
  try {
    h.f.ssoTokens.set('t1', 2);
    const s = await fetch(`${h.base}/wm-api/session`);
    const pre = cookieValue(cookiesOf(s), '__Host-oblimint-wm-csrf')!;
    const r = await fetch(`${h.base}/wm-api/sso`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: h.origin, Cookie: `__Host-oblimint-wm-csrf=${pre}`, 'X-Oblimint-CSRF': pre },
      body: JSON.stringify({ token: 't1' }),
    });
    assert.equal(r.status, 200);
    const info = await r.json() as { address: string; method: string };
    assert.equal(info.address, 'bob@example.test');
    assert.equal(info.method, 'sso');
    const replay = await fetch(`${h.base}/wm-api/sso`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: h.origin, Cookie: `__Host-oblimint-wm-csrf=${pre}`, 'X-Oblimint-CSRF': pre },
      body: JSON.stringify({ token: 't1' }),
    });
    assert.equal(replay.status, 401);
  } finally { await h.close(); }
});

test('event relay: only StateChange of the own account, pings kept, anything else dropped', () => {
  const own = relayEvent('event: state\ndata: {"@type":"StateChange","changed":{"acctA":{"Email":"s2","Mailbox":"m3"},"acctB":{"Email":"x"}}}', 'acctA');
  assert.equal(own, 'event: state\ndata: {"@type":"StateChange","changed":{"acctA":{"Email":"s2","Mailbox":"m3"}}}\n\n');
  assert.equal(relayEvent('event: state\ndata: {"changed":{"acctB":{"Email":"x"}}}', 'acctA'), null);
  assert.equal(relayEvent('event: ping\ndata: {"interval":60}', 'acctA'), ': ping\n\n');
  assert.equal(relayEvent('event: other\ndata: {}', 'acctA'), null);
  assert.equal(relayEvent('data: not json', 'acctA'), null);
  assert.equal(relayEvent('event: state\ndata: {"changed":{"acctA":{"Email<script>":"x","Email":"<b>"}}}', 'acctA'),
    'event: state\ndata: {"@type":"StateChange","changed":{"acctA":{"Email":"<b>"}}}\n\n');
});
