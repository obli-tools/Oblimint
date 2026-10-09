import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import express from 'express';
import type Docker from 'dockerode';
import { AppError, errorHandler } from '../../middleware/errorHandler';
import { createHostdClient, type HostdClient, type HostdGatewayEvent } from '../hostd/client';
import { banKey, cidrContains, normalizeAddress, normalizeCidr, wideBanKey } from './addresses';
import { DbLogSource } from './dbLogSource';
import {
  egressSubnets, handleGatewayEvent, issueProbeNonceForTests, pollGatewayEventsOnce, setFirewallBackendsForTests, type GatewayEventDeps,
} from './firewall.service';
import { GATEWAY_ACTIVATION_WAIT_SEC, GATEWAY_IDLE_TIMEOUT_SEC, gatewaySpecFor } from './gatewaySpec';
import { buildAccountState, FailureWindow, MAX_BANS_PER_ACCOUNT, parseDbAuthFailure, ProbeStore, PROBE_IP_TTL_MS, PROBE_NONCE_TTL_MS, Throttle } from './state';
import ipProbeRouter, { setProbeOriginsForTests } from '../../routes/ipProbe.routes';

// Pure parts of the firewall module + the IP probe route + the gateway
// event handling against a fake hostd (named pipe / unix socket). No database.

const codeOf = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (err) { return err instanceof AppError ? `${err.statusCode} ${err.code}` : String(err); }
  return undefined;
};

test('CIDR validation and normalization', () => {
  assert.deepEqual(normalizeCidr('203.0.113.4'), { cidr: '203.0.113.4', family: 4, bits: 32 });
  assert.equal(normalizeCidr('203.0.113.4/32').cidr, '203.0.113.4');
  assert.equal(normalizeCidr(' 10.1.2.3/8 ').cidr, '10.0.0.0/8');
  assert.equal(normalizeCidr('2001:DB8:0:0::1').cidr, '2001:db8::1');
  assert.equal(normalizeCidr('2001:db8:1:2:3::/48').cidr, '2001:db8:1::/48');
  assert.equal(normalizeCidr('::ffff:192.0.2.9').cidr, '192.0.2.9');
  assert.equal(normalizeCidr('::ffff:192.0.2.0/120').cidr, '192.0.2.0/24');
  for (const bad of ['', 'abc', '10.1', '010.1.2.3', '0x0a.0.0.1', '1.2.3.4/33', '1.2.3.4/', '1.2.3.4/+8', '1.2.3.4/8/8',
    'fe80::1%eth0', '2001:db8::/129', '1.2.3.4 ', '1.2.3.4;', '<script>', '1.2.3.4\n5.6.7.8']) {
    const code = codeOf(() => normalizeCidr(bad));
    assert.ok(code === '400 invalidCidr' || (bad === '1.2.3.4 ' && code === undefined), `${JSON.stringify(bad)} → ${code}`);
  }
  assert.equal(codeOf(() => normalizeCidr('0.0.0.0/0')), '400 cidrTooWide');
  assert.equal(codeOf(() => normalizeCidr('10.0.0.0/7')), '400 cidrTooWide');
  assert.equal(codeOf(() => normalizeCidr('2001::/31')), '400 cidrTooWide');
  assert.equal(codeOf(() => normalizeCidr('::/0')), '400 cidrTooWide');
  assert.equal(normalizeCidr('10.0.0.0/8').bits, 8);
  assert.equal(normalizeCidr('2001:db8::/32').bits, 32);
  assert.equal(cidrContains('10.0.0.0/8', '10.200.1.1'), true);
  assert.equal(cidrContains('10.0.0.0/8', '11.0.0.1'), false);
  assert.equal(cidrContains('2001:db8::/32', '2001:db8:ffff::1'), true);
  assert.equal(cidrContains('2001:db8::/32', '10.0.0.1'), false);
  assert.equal(cidrContains('192.0.2.9', '::ffff:192.0.2.9'), true);
  assert.deepEqual(normalizeAddress('[2001:db8::1]'), { ip: '2001:db8::1', family: 6 });
  assert.equal(normalizeAddress('example.com'), null);
});

test('ban key: IPv4 address, IPv6 /64', () => {
  assert.equal(banKey('203.0.113.7'), '203.0.113.7');
  assert.equal(banKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(banKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(banKey('2001:db8:1:2::1'), banKey('2001:db8:1:2:ffff::9'));
  assert.equal(banKey('nope'), null);
  // Wider ban (rotation inside one allocation): the /48 of an IPv6 address, never for IPv4.
  assert.equal(wideBanKey('2001:db8:1:2:aaaa::1'), '2001:db8:1::/48');
  assert.equal(wideBanKey('203.0.113.7'), null);
  assert.ok(cidrContains(wideBanKey('2001:db8:1:ffff::9')!, '2001:db8:1:2::1'));
});

test('state builder: modes, gateway vs published ports, expiry', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  const base = {
    accountId: 7, portGateway: true, filesrvMode: 'on-demand' as const, filesrvPort: 30007, publishedPorts: [33001, 33001, 0],
    rules: [{ cidr: '198.51.100.0/24', expiresAt: null }, { cidr: '192.0.2.1', expiresAt: new Date('2026-10-09T11:00:00Z') }],
    grants: [{ ip: '203.0.113.5', expiresAt: '2026-10-09T16:00:00Z' }, { ip: '203.0.113.6', expiresAt: '2026-10-09T11:59:00Z' }],
    bans: [{ ip: '2001:db8:1:2::/64', expiresAt: '2026-10-09T13:00:00Z' }, { ip: '203.0.113.9', expiresAt: '2026-10-09T11:00:00Z' }],
    now,
  };
  const auto = buildAccountState({ ...base, mode: 'auto-2fa' });
  assert.deepEqual(auto, {
    accountId: 7, mode: 'auto-2fa', gatewayPorts: [30007], publishedPorts: [33001],
    allow: [{ cidr: '198.51.100.0/24', expiresAt: null }, { cidr: '203.0.113.5', expiresAt: '2026-10-09T16:00:00.000Z' }],
    bans: [{ ip: '2001:db8:1:2::/64', expiresAt: '2026-10-09T13:00:00.000Z' }],
  });
  // allowlist: the rules only (grants never count).
  assert.deepEqual(buildAccountState({ ...base, mode: 'allowlist' }).allow, [{ cidr: '198.51.100.0/24', expiresAt: null }]);
  // Without the gateway (P1), the SFTP port is published by Docker: filtered on FORWARD.
  const p1 = buildAccountState({ ...base, mode: 'open', portGateway: false });
  assert.deepEqual([p1.gatewayPorts, p1.publishedPorts], [[], [30007, 33001]]);
  // File server off: no SFTP port at all.
  const off = buildAccountState({ ...base, mode: 'open', filesrvMode: 'off' });
  assert.deepEqual([off.gatewayPorts, off.publishedPorts], [[], [33001]]);
});

test('ban counting: sliding window, threshold, reset', () => {
  const w = new FailureWindow();
  const win = 10 * 60_000;
  const t0 = Date.parse('2026-10-09T12:00:00Z');
  for (let i = 0; i < 9; i++) assert.equal(w.record('7|sftp|203.0.113.7', t0 + i * 1000, win, 10), null);
  // Another account / service / address counts apart.
  assert.equal(w.record('8|sftp|203.0.113.7', t0, win, 10), null);
  assert.equal(w.record('7|db|203.0.113.7', t0, win, 10), null);
  assert.equal(w.record('7|sftp|203.0.113.7', t0 + 9000, win, 10), 10);
  assert.equal(w.count('7|sftp|203.0.113.7', t0 + 9000, win), 0, 'reset after the ban');
  // Failures older than the window do not count.
  for (let i = 0; i < 9; i++) w.record('7|sftp|198.51.100.1', t0 + i * 60_000, win, 10);
  assert.equal(w.record('7|sftp|198.51.100.1', t0 + 11 * 60_000, win, 10), null);
  assert.equal(w.count('7|sftp|198.51.100.1', t0 + 11 * 60_000, win), 8);
  // IPv6: every address of a /64 shares one counter (the key is banKey).
  for (let i = 1; i < 10; i++) w.record(`7|sftp|${banKey(`2001:db8:5:6::${i}`)}`, t0, win, 10);
  assert.equal(w.record(`7|sftp|${banKey('2001:db8:5:6:ffff::1')}`, t0, win, 10), 10);
  w.clear('7|');
  assert.equal(w.count('7|sftp|198.51.100.1', t0 + 11 * 60_000, win), 0);
  assert.equal(w.count('8|sftp|203.0.113.7', t0, win), 1);
});

test('grant refresh throttle: once per 5 min per key', () => {
  const th = new Throttle(5 * 60_000);
  const t0 = 1_000_000;
  assert.equal(th.hit('s1|7|203.0.113.5', t0), true);
  assert.equal(th.hit('s1|7|203.0.113.5', t0 + 60_000), false);
  assert.equal(th.hit('s1|7|203.0.113.5,2001:db8::5', t0 + 60_000), true, 'a new address set is not throttled');
  assert.equal(th.hit('s2|7|203.0.113.5', t0 + 60_000), true, 'per session');
  assert.equal(th.hit('s1|7|203.0.113.5', t0 + 5 * 60_000), true);
  th.forget('s1|');
  assert.equal(th.hit('s1|7|203.0.113.5,2001:db8::5', t0 + 5 * 60_000 + 1), true);
});

test('probe nonce lifecycle: bound to a session, 60 s, one address per family for 30 min', () => {
  let now = Date.parse('2026-10-09T12:00:00Z');
  const store = new ProbeStore(() => now);
  const { nonce, expiresAt } = store.issue('hashA');
  assert.match(nonce, /^[0-9a-f]{32}$/);
  assert.equal(expiresAt, now + PROBE_NONCE_TTL_MS);
  assert.equal(store.record('deadbeef', '203.0.113.5'), null, 'malformed nonce');
  assert.equal(store.record('0'.repeat(32), '203.0.113.5'), null, 'unknown nonce');
  assert.equal(store.record(nonce, 'not-an-ip'), null);
  assert.deepEqual(store.record(nonce, '::ffff:203.0.113.5'), { ip: '203.0.113.5', family: 4 });
  assert.deepEqual(store.record(nonce, '2001:db8::5'), { ip: '2001:db8::5', family: 6 }, 'the same nonce serves both probes');
  assert.deepEqual(store.ipsOf('hashA'), { ipv4: '203.0.113.5', ipv6: '2001:db8::5' });
  assert.deepEqual(store.ipsOf('hashB'), { ipv4: null, ipv6: null });
  now += PROBE_NONCE_TTL_MS + 1;
  assert.equal(store.record(nonce, '203.0.113.6'), null, 'expired nonce');
  assert.equal(store.ipsOf('hashA').ipv4, '203.0.113.5');
  now += PROBE_IP_TTL_MS;
  assert.deepEqual(store.ipsOf('hashA'), { ipv4: null, ipv6: null }, 'recorded addresses expire');
  const second = store.issue('hashA').nonce;
  store.dropSession('hashA');
  assert.equal(store.record(second, '203.0.113.5'), null, 'ended session: nonce dropped');
});

test('database log lines: MariaDB / MySQL / PostgreSQL authentication failures', () => {
  assert.deepEqual(parseDbAuthFailure("2026-10-09 12:00:00 31 [Warning] Access denied for user 'root'@'203.0.113.7' (using password: YES)"),
    { ip: '203.0.113.7', username: 'root' });
  assert.deepEqual(parseDbAuthFailure("2026-10-09T12:00:00.123Z 9 [Note] [MY-010926] [Server] Access denied for user 'app'@'2001:db8::7' (using password: YES)"),
    { ip: '2001:db8::7', username: 'app' });
  assert.deepEqual(parseDbAuthFailure('2026-10-09 12:00:00.123 UTC [123] 198.51.100.4 FATAL:  password authentication failed for user "bob"'),
    { ip: '198.51.100.4', username: 'bob' });
  assert.equal(parseDbAuthFailure('2026-10-09 12:00:00.123 UTC [123] [local] FATAL:  password authentication failed for user "bob"'), null);
  assert.equal(parseDbAuthFailure("Access denied for user 'x'@'localhost' (using password: YES)"), null);
  assert.equal(parseDbAuthFailure('2026-10-09 12:00:00 0 [Note] mariadbd: ready for connections.'), null);

  assert.equal(parseDbAuthFailure("2026-10-09 12:00:00 31 [Warning] Access denied for user 'x'@'localhost' (using password: YES)"), null);

  const seen: unknown[] = [];
  const src = new DbLogSource({ docker: async () => ({}) as Docker, onFailure: (e) => seen.push(e) });
  src.line(12, "2026-10-09 12:00:00 31 [Warning] Access denied for user 'root'@'203.0.113.7' (using password: YES)", 1_000);
  src.line(12, "Access denied for user 'root'@'203.0.113.8' (using password: YES)", 1_000); // no server prefix
  src.line(12, 'nothing', 1_000);
  assert.deepEqual(seen, [{ accountId: 12, service: 'db', ip: '203.0.113.7', username: 'root' }]);
});

test('database log lines: a client-chosen user name never chooses the banned address', () => {
  const victim = '203.0.113.7';
  const real = '198.51.100.66';
  // Quotes in the user name: the address is the server-written suffix (LAST '@').
  assert.equal(parseDbAuthFailure(`2026-10-09 12:00:00 31 [Warning] Access denied for user 'x'@'${victim}' -- '@'${real}' (using password: YES)`), null,
    "a user name with an embedded '@' quote is refused");
  assert.deepEqual(parseDbAuthFailure(`2026-10-09 12:00:00 31 [Warning] Access denied for user 'it''s'@'${real}' (using password: NO)`),
    { ip: real, username: "it''s" });
  assert.equal(parseDbAuthFailure(`2026-10-09 12:00:00 31 [Warning] Access denied for user 'x'@'${victim}' (using password: YES) trailing`), null,
    'the suffix must end the line');
  assert.equal(parseDbAuthFailure(`2026-10-09 12:00:00 31 [Warning] Access denied for user 'a\tb'@'${real}' (using password: YES)`), null,
    'control characters refused');
  // PostgreSQL: the address is the %h of the prefix, the line starts with the timestamp.
  assert.equal(parseDbAuthFailure(`x" 2026-10-09 12:00:00.123 UTC [1] ${victim} FATAL:  password authentication failed for user "y"`), null);
  assert.equal(parseDbAuthFailure(`2026-10-09 12:00:00.123 UTC [1] ${victim} FATAL:  password authentication failed for user "y" extra`), null);

  // Newline in a MariaDB user name: the record is split, a whole forged line
  // may follow. Everything after the unterminated head is ignored briefly.
  const seen: Array<{ ip: string }> = [];
  const src = new DbLogSource({ docker: async () => ({}) as Docker, onFailure: (e) => seen.push(e) });
  const forged = `2026-10-09 12:00:00 31 [Warning] Access denied for user 'x'@'${victim}' (using password: YES)`;
  src.line(5, "2026-10-09 12:00:00 31 [Warning] Access denied for user 'a", 10_000);
  src.line(5, forged, 10_001);
  src.line(5, `b'@'${real}' (using password: YES)`, 10_001);
  assert.deepEqual(seen, [], 'forged line inside a split record ignored');
  src.line(6, forged, 10_002);
  assert.equal(seen.length, 1, 'other accounts are not affected');
  src.line(5, forged, 10_000 + 2_000 + 1);
  assert.equal(seen.length, 2, 'counted again after the taint window');
  // A complete record (also localhost) never taints.
  src.line(7, "2026-10-09 12:00:00 31 [Warning] Access denied for user 'x'@'localhost' (using password: YES)", 20_000);
  src.line(7, forged, 20_001);
  assert.equal(seen.length, 3);
  // PostgreSQL split record.
  src.line(8, '2026-10-09 12:00:00.123 UTC [1] 198.51.100.66 FATAL:  password authentication failed for user "a', 30_000);
  src.line(8, `2026-10-09 12:00:00.123 UTC [1] ${victim} FATAL:  password authentication failed for user "y"`, 30_001);
  assert.equal(seen.length, 3);
});

test('gateway spec of an account file server', () => {
  const acct = { id: 7, status: 'active' as const, filesrv_mode: 'on-demand' as const, filesrv_port: 30007 };
  const running = {
    State: { Running: true, Restarting: false },
    NetworkSettings: { Networks: { 'oblimint-acct-7': { IPAddress: '172.20.0.5' } } },
  } as unknown as Docker.ContainerInspectInfo;
  assert.deepEqual(gatewaySpecFor(acct, running), {
    accountId: 7, port: 30007, target: { ip: '172.20.0.5', port: 2022 }, proxyProtocol: true,
    idleTimeoutSec: GATEWAY_IDLE_TIMEOUT_SEC, activationWaitSec: GATEWAY_ACTIVATION_WAIT_SEC,
  });
  assert.equal(gatewaySpecFor(acct, null)!.target, null, 'stopped: hold + activate');
  assert.equal(gatewaySpecFor({ ...acct, filesrv_mode: 'always' }, running)!.idleTimeoutSec, 0);
  assert.equal(gatewaySpecFor({ ...acct, status: 'suspended' }, null)!.activationWaitSec, 0);
  assert.equal(gatewaySpecFor({ ...acct, filesrv_mode: 'off' }, running), null);
  assert.equal(gatewaySpecFor({ ...acct, filesrv_port: null }, running), null);
  assert.equal(gatewaySpecFor({ ...acct, status: 'deleting' }, running), null);
});

function recordingDeps(fail?: string): GatewayEventDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async activate(id) {
      calls.push(`activate ${id}`);
      await new Promise((r) => setTimeout(r, 20));
      if (fail) throw new AppError(409, fail, fail);
    },
    async pushTarget(id) { calls.push(`push ${id}`); },
    async endActivation(id) { calls.push(`end ${id}`); return true; },
  };
}

const ev = (accountId: number, kind: HostdGatewayEvent['kind']): HostdGatewayEvent => ({ accountId, kind, at: '2026-10-09T12:00:00Z', remoteIp: '203.0.113.5' });

test('gateway events: activate → file server + target, idle → end, concurrent activations deduplicated', async () => {
  const deps = recordingDeps();
  await Promise.all([handleGatewayEvent(ev(7, 'activate'), deps), handleGatewayEvent(ev(7, 'activate'), deps)]);
  await handleGatewayEvent(ev(7, 'idle'), deps);
  await handleGatewayEvent(ev(7, 'refused'), deps);
  await handleGatewayEvent({ ...ev(0, 'activate') }, deps);
  assert.deepEqual(deps.calls, ['activate 7', 'push 7', 'end 7']);
  // A refused activation (file server off, account suspended) never throws.
  const failing = recordingDeps('fileServerOff');
  await handleGatewayEvent(ev(8, 'activate'), failing);
  assert.deepEqual(failing.calls, ['activate 8']);
});

// ── Fake hostd on a named pipe / unix socket ────────────────────────────────

const socketPath = process.platform === 'win32'
  ? `\\\\.\\pipe\\oblimint-fw-test-${crypto.randomBytes(6).toString('hex')}`
  : path.join(os.tmpdir(), `oblimint-fw-test-${crypto.randomBytes(6).toString('hex')}.sock`);

let hostdServer: http.Server | null = null;
after(async () => {
  setFirewallBackendsForTests(null);
  if (hostdServer) {
    hostdServer.closeAllConnections();
    await new Promise<void>((r) => hostdServer!.close(() => r()));
  }
});

test('gateway event long poll against a fake hostd', async () => {
  const queued: HostdGatewayEvent[][] = [[ev(7, 'activate'), ev(9, 'idle')], []];
  const seen: string[] = [];
  hostdServer = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events: queued.shift() ?? [] }));
  });
  await new Promise<void>((r) => hostdServer!.listen(socketPath, r));
  setFirewallBackendsForTests({ hostd: () => createHostdClient({ socketPath }), localNode: async () => 1 });
  const deps = recordingDeps();
  assert.equal(await pollGatewayEventsOnce(50, deps), 2);
  assert.equal(await pollGatewayEventsOnce(50, deps), 0);
  assert.deepEqual(seen, ['GET /v1/gateway/events?wait=50', 'GET /v1/gateway/events?wait=50']);
  // Handlers run concurrently (an activation never delays another account).
  assert.deepEqual([...deps.calls].sort(), ['activate 7', 'end 9', 'push 7']);
  assert.ok(deps.calls.indexOf('activate 7') < deps.calls.indexOf('push 7'));
});

test('ip-probe: CORS for the panel origin only, never credentials, 404 probeExpired', async () => {
  setFirewallBackendsForTests({ probeHosts: async () => ({ v4: 'ip4.example.com', v6: 'ip6.example.com' }) });
  setProbeOriginsForTests(['https://panel.example.com', 'http://localhost:5174']);
  const app = express();
  app.use('/api/ip-probe', ipProbeRouter);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ip-probe`;
  // The test client is the loopback edge (trusted): X-Forwarded-For carries the client.
  const via = (xff: string) => ({ Origin: 'https://panel.example.com', 'X-Forwarded-For': xff });
  try {
    const nonce = issueProbeNonceForTests('a'.repeat(64));
    const ok = await fetch(`${base}?nonce=${nonce}`, { headers: { ...via('203.0.113.5'), Cookie: 'x=1' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { success: true, data: { ip: '203.0.113.5', family: 4 } });

    // Relays / non-public addresses are never recorded (docker-proxy gateway, LAN proxy, the edge itself).
    for (const xff of ['172.18.0.1', '10.0.0.7', '100.64.1.2', 'fd00::5', '198.51.100.9, 192.168.1.10']) {
      const r = await fetch(`${base}?nonce=${nonce}`, { headers: via(xff) });
      assert.equal(r.status, 422, xff);
      assert.equal(((await r.json()) as { code?: string }).code, 'probeNotPublic', xff);
    }
    const direct = await fetch(`${base}?nonce=${nonce}`, { headers: { Origin: 'https://panel.example.com' } });
    assert.equal(direct.status, 422, 'the loopback edge itself is a relay');
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://panel.example.com');
    assert.equal(ok.headers.get('access-control-allow-credentials'), null);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.match(ok.headers.get('vary') ?? '', /Origin/);

    const foreign = await fetch(`${base}?nonce=${nonce}`, { headers: { Origin: 'https://evil.example.net', 'X-Forwarded-For': '203.0.113.5' } });
    assert.equal(foreign.status, 200, 'the answer is only unreadable cross-origin, the probe still counts');
    assert.equal(foreign.headers.get('access-control-allow-origin'), null);

    const expired = await fetch(`${base}?nonce=${'0'.repeat(32)}`, { headers: { Origin: 'http://localhost:5174', 'X-Forwarded-For': '203.0.113.5' } });
    assert.equal(expired.status, 404);
    assert.equal(((await expired.json()) as { code?: string }).code, 'probeExpired');
    assert.equal(expired.headers.get('access-control-allow-origin'), 'http://localhost:5174');

    const pre = await fetch(base, { method: 'OPTIONS', headers: { Origin: 'https://panel.example.com', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://panel.example.com');
  } finally {
    setProbeOriginsForTests(null);
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('ip-probe: the v4-only / v6-only probe host only learns its own family', async () => {
  setFirewallBackendsForTests({ probeHosts: async () => ({ v4: 'IP4.example.com', v6: 'ip6.example.com.' }) });
  const { firewallService } = await import('./firewall.service');
  const nonce = issueProbeNonceForTests('b'.repeat(64));
  const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as AppError).code; } };
  // An IPv4 relay seen by the v6 probe never overwrites the real IPv4 slot.
  assert.equal(await code(firewallService.recordProbe(nonce, '198.51.100.7', 'ip6.example.com')), 'probeFamilyMismatch');
  assert.equal(await code(firewallService.recordProbe(nonce, '2001:db8::7', 'ip4.example.com')), 'probeFamilyMismatch');
  assert.deepEqual(await firewallService.recordProbe(nonce, '2001:db8::7', 'ip6.example.com'), { ip: '2001:db8::7', family: 6 });
  assert.deepEqual(await firewallService.recordProbe(nonce, '198.51.100.7', 'ip4.example.com'), { ip: '198.51.100.7', family: 4 });
  assert.equal(await code(firewallService.recordProbe(nonce, '172.18.0.1', 'ip4.example.com')), 'probeNotPublic');
  // The store itself refuses a mismatch too.
  const store = new ProbeStore();
  const n = store.issue('h').nonce;
  assert.equal(store.record(n, '198.51.100.7', 6), null);
  assert.deepEqual(store.record(n, '198.51.100.7', 4), { ip: '198.51.100.7', family: 4 });
  setFirewallBackendsForTests(null);
});

test('reconcile hook: pushes the gateway target from the file server container, then queues the state', async (t) => {
  const { config } = await import('../../config');
  const { firewallReconcileHook, setReconcileHookHostdForTests } = await import('./reconcileHook');
  const { firewallService } = await import('./firewall.service');
  const queued: number[] = [];
  t.mock.method(firewallService, 'requestSync', (id: number) => { queued.push(id); });
  const syncAll: string[] = [];
  t.mock.method(firewallService, 'requestSyncAll', (reason: string) => { syncAll.push(reason); });
  const calls: string[] = [];
  setReconcileHookHostdForTests(() => ({
    async setGateway(spec: { accountId: number; target: { ip: string } | null }) { calls.push(`set ${spec.accountId} ${spec.target?.ip ?? 'null'}`); },
    async removeGateway(id: number) { calls.push(`remove ${id}`); },
  }) as unknown as HostdClient);
  const docker = {
    getContainer: (name: string) => ({
      async inspect() {
        if (name !== 'oblimint-files-7') throw Object.assign(new Error('no such container'), { statusCode: 404 });
        return { State: { Running: true }, NetworkSettings: { Networks: { 'oblimint-acct-7': { IPAddress: '172.20.0.9' } } } };
      },
    }),
    // A DB network the global egress state does not hold yet (created by this pass).
    getNetwork: (name: string) => ({
      async inspect() {
        if (name !== 'oblimint-acct-7-db') throw Object.assign(new Error('no such network'), { statusCode: 404 });
        return { IPAM: { Config: [{ Subnet: '172.30.0.0/16' }] } };
      },
    }),
  } as unknown as Docker;
  const ctx = (account: Record<string, unknown>) => ({
    state: { account: { node_id: 1, status: 'active', filesrv_mode: 'on-demand', filesrv_port: 30007, ...account }, sites: [] },
    docker, report: { accountId: Number(account.id), ok: true, actions: [], errors: [] },
  }) as never;
  try {
    await firewallReconcileHook.afterAccountPass(ctx({ id: 7 }));
    await firewallReconcileHook.afterAccountPass(ctx({ id: 8 }));
    await firewallReconcileHook.afterAccountPass(ctx({ id: 9, filesrv_mode: 'off' }));
    if (config.hosting.portGateway) assert.deepEqual(calls, ['set 7 172.20.0.9', 'set 8 null', 'remove 9']);
    else assert.deepEqual(calls, []);
    assert.deepEqual(queued, [7, 8, 9]);
    assert.deepEqual(syncAll, ['network-added'], 'a new (DB) network subnet triggers one global egress push');
  } finally {
    setReconcileHookHostdForTests(null);
  }
});

test('state builder: bans capped below the hostd limit (the latest-expiring kept)', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  const bans = Array.from({ length: MAX_BANS_PER_ACCOUNT + 50 }, (_, i) => ({
    ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, expiresAt: new Date(now.getTime() + (i + 1) * 1000),
  }));
  const s = buildAccountState({
    accountId: 1, mode: 'open', portGateway: true, filesrvMode: 'off', filesrvPort: null, publishedPorts: [], rules: [], grants: [], bans, now,
  });
  assert.equal(s.bans.length, MAX_BANS_PER_ACCOUNT);
  assert.ok(MAX_BANS_PER_ACCOUNT < 10_000, 'hostd maxBanEntries');
  assert.ok(!s.bans.some((b) => b.ip === '10.0.0.0'), 'the earliest-expiring ban is the one dropped');
});

test('egress filter covers the account networks AND the account DATABASE networks', async () => {
  const byLabel: Record<string, Array<{ IPAM?: { Config?: Array<{ Subnet?: string }> } }>> = {
    'oblimint.account': [{ IPAM: { Config: [{ Subnet: '172.21.0.0/16' }, { Subnet: 'fd00:21::/64' }] } }, { IPAM: {} }],
    'oblimint.db-network': [{ IPAM: { Config: [{ Subnet: '172.22.0.0/16' }] } }, { IPAM: { Config: [{ Subnet: '172.21.0.0/16' }] } }],
  };
  const asked: unknown[] = [];
  const docker = {
    async listNetworks(opts: { filters: { label: string[] } }) {
      asked.push(opts.filters.label);
      return opts.filters.label.length === 1 ? byLabel[opts.filters.label[0]] ?? [] : [];
    },
  } as unknown as Pick<Docker, 'listNetworks'>;
  assert.deepEqual(await egressSubnets(docker), ['172.21.0.0/16', 'fd00:21::/64', '172.22.0.0/16']);
  // One label per query (several values of one filter key are ANDed by Docker).
  assert.deepEqual(asked, [['oblimint.account'], ['oblimint.db-network']]);
});
