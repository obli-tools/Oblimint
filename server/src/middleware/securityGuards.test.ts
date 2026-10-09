import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { isAllowedOrigin, isForeignBrowserRequest, originGuard } from './originGuard';
import { ipKey } from './rateLimiter';
import { allowedDuringTwoFactorSetup } from './sessionUserGuard';
import { expressTrustProxy, setEdgeProxyAddresses } from '../utils/clientIp';
import { containerAddresses, refreshEdgeProxyTrust, setEdgeInspectorForTests } from '../services/proxyTrust';
import { obligateUrlError } from '../services/obligateUrl';
import { appConfigForRole } from '../routes/appConfig.routes';
import { SESSION_COOKIE_NAME, sessionCookieSecure } from '../config';
import { assertCanGrantClientCapabilities, staffEquivalentOf, type HostingActor } from '../services/hosting/access';

// Regression tests of the panel-level security guards (no database):
// same-site request forgery from tenant-controlled preview hosts, proxy trust
// behind the edge, rate-limit keys, force_2fa allow-list, Obligate URL rules,
// admin config redaction, client capability laundering.

// ── originGuard over a real HTTP server ──────────────────────────────────────

async function withApp(fn: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(originGuard);
  app.use(express.json());
  app.post('/api/sites/1/releases/2/approve', (req, res) => { res.json({ ok: true, body: req.body }); });
  app.get('/api/sites', (_req, res) => { res.json({ ok: true }); });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function send(hostPort: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  const [host, port] = hostPort.split(':');
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port: Number(port), path, method: opts.method ?? 'POST', headers: opts.headers ?? {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

test('originGuard: a no-cors / form POST from a preview host of the panel domain is refused', async () => {
  await withApp(async (base) => {
    const panelHost = 'panel.example.com';
    // fetch(..., {mode:'no-cors', credentials:'include'}) from <slug>-<id>.preview.<panel>: text/plain, Origin set.
    const preview = await send(base, '/api/sites/1/releases/2/approve', {
      headers: { host: panelHost, origin: 'https://wp-3.preview.panel.example.com', 'content-type': 'text/plain', 'content-length': '2' },
      body: '{}',
    });
    assert.equal(preview.status, 403);
    assert.match(preview.body, /crossOriginRefused/);
    // Bodyless same-SITE POST (Origin of a tenant domain under the operator's zone).
    const bodyless = await send(base, '/api/sites/1/releases/2/approve', {
      headers: { host: panelHost, origin: 'https://shop.example.com', 'content-length': '0' },
    });
    assert.equal(bodyless.status, 403);
    // Sandboxed frame / data: URL.
    const nullOrigin = await send(base, '/api/sites/1/releases/2/approve', { headers: { host: panelHost, origin: 'null' } });
    assert.equal(nullOrigin.status, 403);
    // No Origin but fetch metadata says same-site / cross-site.
    const sameSite = await send(base, '/api/sites/1/releases/2/approve', { headers: { host: panelHost, 'sec-fetch-site': 'same-site' } });
    assert.equal(sameSite.status, 403);
    // No Origin, foreign Referer.
    const referer = await send(base, '/api/sites/1/releases/2/approve', { headers: { host: panelHost, referer: 'https://evil.example.net/x' } });
    assert.equal(referer.status, 403);
  });
});

test('originGuard: the panel itself (edge host name, direct :8443, dev client origin) and non-browser clients pass', async () => {
  await withApp(async (base) => {
    const json = { 'content-type': 'application/json' };
    const viaEdge = await send(base, '/api/sites/1/releases/2/approve', {
      headers: { ...json, host: 'panel.example.com', origin: 'https://panel.example.com', 'sec-fetch-site': 'same-origin', 'content-length': '2' },
      body: '{}',
    });
    assert.equal(viaEdge.status, 200);
    const direct = await send(base, '/api/sites/1/releases/2/approve', {
      headers: { ...json, host: '203.0.113.7:8443', origin: 'https://203.0.113.7:8443', 'content-length': '2' },
      body: '{}',
    });
    assert.equal(direct.status, 200);
    // axios bodyless POST from the panel: no Content-Type at all.
    const bodyless = await send(base, '/api/sites/1/releases/2/approve', { headers: { host: 'panel.example.com', origin: 'https://panel.example.com', 'content-length': '0' } });
    assert.equal(bodyless.status, 200);
    // Server-to-server (Obligate sso-user-sync, curl): no Origin, no fetch metadata, no cookie by construction.
    const curl = await send(base, '/api/sites/1/releases/2/approve', { headers: { ...json, host: 'panel.example.com', 'content-length': '2' }, body: '{}' });
    assert.equal(curl.status, 200);
    // GET is never blocked (read-only).
    const get = await send(base, '/api/sites', { method: 'GET', headers: { host: 'panel.example.com', origin: 'https://evil.example.net' } });
    assert.equal(get.status, 200);
  });
});

test('originGuard: a same-origin request must still send its body as JSON (no form / text bodies)', async () => {
  await withApp(async (base) => {
    const form = await send(base, '/api/sites/1/releases/2/approve', {
      headers: { host: 'panel.example.com', origin: 'https://panel.example.com', 'content-type': 'application/x-www-form-urlencoded', 'content-length': '3' },
      body: 'a=b',
    });
    assert.equal(form.status, 415);
    const text = await send(base, '/api/sites/1/releases/2/approve', {
      headers: { host: 'panel.example.com', 'content-type': 'text/plain', 'content-length': '2' },
      body: '{}',
    });
    assert.equal(text.status, 415);
  });
});

test('isAllowedOrigin: exact host match only (no suffix / prefix tricks), default ports tolerated', () => {
  assert.equal(isAllowedOrigin('https://panel.example.com', 'panel.example.com'), true);
  assert.equal(isAllowedOrigin('https://panel.example.com', 'panel.example.com:443'), true);
  assert.equal(isAllowedOrigin('https://panel.example.com:8443', 'panel.example.com:8443'), true);
  assert.equal(isAllowedOrigin('https://panel.example.com:8443', 'panel.example.com'), false);
  assert.equal(isAllowedOrigin('https://x.panel.example.com', 'panel.example.com'), false);
  assert.equal(isAllowedOrigin('https://panel.example.com.evil.net', 'panel.example.com'), false);
  assert.equal(isAllowedOrigin('null', 'panel.example.com'), false);
  assert.equal(isAllowedOrigin(undefined, 'panel.example.com'), false);
  assert.equal(isAllowedOrigin('https://panel.example.com', undefined), false);
});

test('Socket.io handshake check: a foreign Origin is refused, the panel origin and no Origin pass', () => {
  const req = (headers: Record<string, string>) => ({ headers } as unknown as http.IncomingMessage);
  assert.equal(isForeignBrowserRequest(req({ host: 'panel.example.com', origin: 'https://a-1.preview.panel.example.com' })), true);
  assert.equal(isForeignBrowserRequest(req({ host: 'panel.example.com', origin: 'https://panel.example.com' })), false);
  assert.equal(isForeignBrowserRequest(req({ host: 'panel.example.com' })), false);
});

test('session cookie: __Host- prefix whenever it is Secure (subdomains cannot toss / shadow it)', () => {
  if (sessionCookieSecure) assert.equal(SESSION_COOKIE_NAME, '__Host-oblimint.sid');
  else assert.equal(SESSION_COOKIE_NAME, 'oblimint.sid');
  assert.notEqual(SESSION_COOKIE_NAME, 'connect.sid');
});

// ── Proxy trust (edge) ───────────────────────────────────────────────────────

/** What Express (proxy-addr) computes as req.ip with our trust function. */
async function reqIp(peer: string, xff: string | undefined, hops = 0): Promise<string> {
  // Express's own resolver (dependency of express, untyped here).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const proxyaddr = require('proxy-addr') as (req: unknown, trust: (a: string, i: number) => boolean) => string;
  const req = { connection: { remoteAddress: peer }, socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} };
  return proxyaddr(req, expressTrustProxy(hops));
}

test('trust proxy: only the edge container (exact addresses) may set the client address', async () => {
  setEdgeProxyAddresses(['172.20.0.5', '10.88.0.3']);
  try {
    // Through the edge: the address nginx appended (rightmost) is the client; a forged left part is ignored.
    assert.equal(await reqIp('172.20.0.5', '6.6.6.6, 198.51.100.9'), '198.51.100.9');
    assert.equal(await reqIp('::ffff:10.88.0.3', '198.51.100.10'), '198.51.100.10');
    // Direct :8443 client forging X-Forwarded-For: its own address, whatever TRUST_PROXY_HOPS says.
    assert.equal(await reqIp('203.0.113.50', '1.2.3.4'), '203.0.113.50');
    assert.equal(await reqIp('203.0.113.50', '1.2.3.4', 1), '203.0.113.50');
    // A tenant site container on an account network (same subnet as the edge's address there).
    assert.equal(await reqIp('172.20.0.9', '1.2.3.4'), '172.20.0.9');
    // A single trusted hop: the edge cannot be made to vouch for a second one.
    assert.equal(await reqIp('172.20.0.5', '1.2.3.4, 172.20.0.5'), '172.20.0.5');
  } finally {
    setEdgeProxyAddresses([]);
  }
  // Edge unknown (no Docker / dev): nothing but loopback trusted.
  assert.equal(await reqIp('172.20.0.5', '198.51.100.9'), '172.20.0.5');
});

test('proxyTrust: edge addresses read from Docker inspect; removed edge → none; Docker down → kept', async () => {
  assert.deepEqual(containerAddresses({ NetworkSettings: { Networks: {
    oblimint: { IPAddress: '172.20.0.5', GlobalIPv6Address: '' },
    'oblimint-acct-3': { IPAddress: '10.88.0.3', GlobalIPv6Address: 'fd00::3' },
  } } }), ['172.20.0.5', '10.88.0.3', 'fd00::3']);
  try {
    setEdgeInspectorForTests(async () => ({ NetworkSettings: { Networks: { oblimint: { IPAddress: '172.20.0.5' } } } }));
    assert.deepEqual(await refreshEdgeProxyTrust(), ['172.20.0.5']);
    setEdgeInspectorForTests(async () => { throw Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' }); });
    assert.deepEqual(await refreshEdgeProxyTrust(), ['172.20.0.5']);
    setEdgeInspectorForTests(async () => { throw Object.assign(new Error('no such container'), { statusCode: 404 }); });
    assert.deepEqual(await refreshEdgeProxyTrust(), []);
  } finally {
    setEdgeInspectorForTests(null);
    setEdgeProxyAddresses([]);
  }
});

test('rate-limit keys: IPv4 as is, IPv6 by /64, mapped IPv4 unwrapped', () => {
  assert.equal(ipKey('198.51.100.7'), '198.51.100.7');
  assert.equal(ipKey('::ffff:198.51.100.7'), '198.51.100.7');
  assert.equal(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:db8:1:2:0:0:0:ffff'), ipKey('2001:db8:1:2::9'));
  assert.notEqual(ipKey('2001:db8:1:3::1'), ipKey('2001:db8:1:2::1'));
  assert.equal(ipKey('::1'), '0:0:0:0::/64');
  assert.equal(ipKey(undefined), 'unknown');
});

// ── force_2fa allow-list ─────────────────────────────────────────────────────

test('force_2fa: a session without TOTP only reaches the sign-in, profile and 2FA setup routes', () => {
  for (const [m, p] of [['GET', '/api/auth/me'], ['POST', '/api/auth/logout'], ['POST', '/api/profile/2fa/totp/setup'],
    ['POST', '/api/profile/2fa/totp/enable'], ['GET', '/api/profile'], ['PUT', '/api/profile/password'], ['GET', '/api/tenants'],
    ['GET', '/login'], ['GET', '/auth/callback']] as const) {
    assert.equal(allowedDuringTwoFactorSetup(m, p), true, `${m} ${p}`);
  }
  for (const [m, p] of [['GET', '/api/accounts'], ['POST', '/api/accounts/1/file-access/password'], ['GET', '/api/users'],
    ['PUT', '/api/profile'], ['POST', '/api/tenants'], ['GET', '/api/hosting/me'], ['POST', '/api/system/infra/reconcile']] as const) {
    assert.equal(allowedDuringTwoFactorSetup(m, p), false, `${m} ${p}`);
  }
});

// ── Obligate trust anchor / config redaction ─────────────────────────────────

test('Obligate URL: https anywhere, plain http only on local / private addresses', () => {
  assert.equal(obligateUrlError('https://sso.example.com'), null);
  assert.equal(obligateUrlError('http://obligate:3000'), null);
  assert.equal(obligateUrlError('http://127.0.0.1:3000'), null);
  assert.equal(obligateUrlError('http://192.168.1.20'), null);
  assert.equal(obligateUrlError('http://172.18.0.4:8080'), null);
  assert.equal(obligateUrlError('http://[fd00::4]:8080'), null);
  assert.equal(obligateUrlError('http://sso.home.arpa'), null);
  assert.match(obligateUrlError('http://sso.example.com') ?? '', /https/);
  assert.match(obligateUrlError('http://8.8.8.8') ?? '', /https/);
  assert.match(obligateUrlError('http://172.32.0.1') ?? '', /https/);
  assert.match(obligateUrlError('ftp://sso.example.com') ?? '', /http/);
});

test('GET /admin/config: non-administrators never see the ACME e-mail, mail engine or Obligate URL', () => {
  const cfg = {
    allow_2fa: 'true', force_2fa: 'false', app_name: 'Oblimint', default_language: 'en', obligate_url: 'https://sso.internal',
    obligate_enabled: 'true', panel_hostname: 'panel.example.com', public_ipv4: '203.0.113.7', public_ipv6: null, nameservers: '["ns1.example.com"]',
    acme_email: 'ops@example.com', mail_engine: 'stalwart',
  };
  const client = appConfigForRole(cfg, false);
  assert.equal(client.acme_email, null);
  assert.equal(client.mail_engine, null);
  assert.equal(client.obligate_url, null);
  assert.equal(client.public_ipv4, '203.0.113.7'); // needed to point DNS
  assert.equal(client.force_2fa, 'false');
  assert.deepEqual(appConfigForRole(cfg, true), cfg);
});

// ── Client capability laundering ─────────────────────────────────────────────

test('client capabilities map to staff equivalents; granting needs them', () => {
  assert.deepEqual([...staffEquivalentOf(['releases.publish', 'releases.approve', 'files.manage'])].sort(), ['files.manage', 'sites.manage']);
  const accountsOnly: HostingActor = { kind: 'staff', userId: 2, tenantId: 2, globalView: false, caps: new Set(['accounts.manage']) };
  const operator: HostingActor = { kind: 'staff', userId: 3, tenantId: 2, globalView: false, caps: new Set(['accounts.manage', 'sites.manage']) };
  const admin: HostingActor = { kind: 'staff', userId: 1, tenantId: 1, globalView: true, caps: '*' };
  assert.throws(() => assertCanGrantClientCapabilities(accountsOnly, ['files.manage']), (e: { statusCode?: number; code?: string }) => e.statusCode === 403 && e.code === 'capabilityNotHeld');
  assert.throws(() => assertCanGrantClientCapabilities(accountsOnly, ['releases.approve']), (e: { statusCode?: number }) => e.statusCode === 403);
  assert.doesNotThrow(() => assertCanGrantClientCapabilities(accountsOnly, []));
  assert.doesNotThrow(() => assertCanGrantClientCapabilities(operator, ['sites.manage', 'releases.publish', 'releases.approve']));
  assert.throws(() => assertCanGrantClientCapabilities(operator, ['domains.manage']));
  assert.doesNotThrow(() => assertCanGrantClientCapabilities(admin, ['sites.manage', 'domains.manage', 'files.manage', 'releases.approve']));
});
