import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import type { InfraComponentStatus } from '@oblimint/shared';
import { diskCheck, runDeepChecks, workersCheck, WORKER_STALE_MS, type DeepProbes } from './checks';
import { heartbeatOrigin, parseHeartbeatUrl, sendHeartbeat, HeartbeatUrlError } from './heartbeat';
import { TargetRefusedError, resolveTarget } from '../monitoring/targetGuard';

const comp = (id: InfraComponentStatus['id'], deployed: boolean, running: boolean, detail: string | null = null): InfraComponentStatus =>
  ({ id, deployed, running, image: null, version: null, detail });

function probes(over: Partial<DeepProbes> = {}): DeepProbes {
  const now = 1_000_000_000;
  return {
    postgres: async () => undefined,
    hostd: async () => undefined,
    infra: async () => [comp('edge', true, true), comp('hostd', true, true), comp('dns', true, true), comp('mail', false, false)],
    workers: () => ({ enabled: true, lastTick: now - 60_000, startedAt: now - 3_600_000 }),
    disk: async () => ({ totalBytes: 100 * 1024 ** 3, availableBytes: 40 * 1024 ** 3 }),
    now: () => now,
    ...over,
  };
}

test('deep checks: all green, a component not deployed is skipped', async () => {
  const r = await runDeepChecks(probes(), '1.2.3');
  assert.equal(r.status, 'ok');
  assert.equal(r.version, '1.2.3');
  assert.deepEqual(r.checks.map((c) => c.id), ['postgres', 'hostd', 'edge', 'dns', 'mail', 'workers', 'disk']);
  assert.equal(r.checks.find((c) => c.id === 'mail')!.status, 'skipped');
  assert.equal(r.checks.find((c) => c.id === 'disk')!.detail, '40% free');
});

test('deep checks: a failing probe, a stopped container, a hung probe', async () => {
  const r = await runDeepChecks(probes({
    postgres: async () => { throw new Error('connection refused'); },
    infra: async () => [comp('edge', true, false, 'exited (exit 1)'), comp('dns', true, true)],
    hostd: () => new Promise(() => undefined),
  }), 'v', 50);
  assert.equal(r.status, 'fail');
  const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
  assert.equal(by.postgres.status, 'fail');
  assert.match(by.postgres.detail!, /connection refused/);
  assert.equal(by.edge.status, 'fail');
  assert.match(by.edge.detail!, /not running/);
  assert.equal(by.hostd.status, 'fail');
  assert.match(by.hostd.detail!, /timed out/);
  assert.equal(by.dns.status, 'ok');
  assert.equal(by.mail.status, 'skipped');
});

test('deep checks: infra unreachable fails edge / dns / mail', async () => {
  const r = await runDeepChecks(probes({ infra: async () => { throw new Error('docker down'); } }), 'v');
  for (const id of ['edge', 'dns', 'mail']) assert.equal(r.checks.find((c) => c.id === id)!.status, 'fail');
});

test('workers check', () => {
  const now = 10 * WORKER_STALE_MS;
  assert.equal(workersCheck({ enabled: false, lastTick: null, startedAt: 0 }, now).status, 'skipped');
  assert.equal(workersCheck({ enabled: true, lastTick: now - 1000, startedAt: 0 }, now).status, 'ok');
  assert.equal(workersCheck({ enabled: true, lastTick: now - WORKER_STALE_MS - 1, startedAt: 0 }, now).status, 'fail');
  assert.deepEqual(workersCheck({ enabled: true, lastTick: null, startedAt: now - 1000 }, now), { status: 'ok', detail: 'starting' });
  assert.equal(workersCheck({ enabled: true, lastTick: null, startedAt: 0 }, now).status, 'fail');
});

test('disk check', () => {
  assert.equal(diskCheck(null).status, 'fail');
  assert.equal(diskCheck({ totalBytes: 100 * 1024 ** 3, availableBytes: 4 * 1024 ** 3 }).status, 'fail');
  assert.equal(diskCheck({ totalBytes: 10 * 1024 ** 3, availableBytes: 0.9 * 1024 ** 3 }).status, 'fail');
  assert.equal(diskCheck({ totalBytes: 10 * 1024 ** 3, availableBytes: 5 * 1024 ** 3 }).status, 'ok');
});

test('heartbeat URL format', () => {
  assert.equal(parseHeartbeatUrl('https://hc.example.com/ping/abc').hostname, 'hc.example.com');
  assert.equal(parseHeartbeatUrl('http://kuma.example.com:3001/api/push/x?status=up').port, '3001');
  for (const bad of ['', 'ftp://example.com/', 'https://u:p@example.com/', 'not a url', `https://example.com/${'a'.repeat(2100)}`]) {
    assert.throws(() => parseHeartbeatUrl(bad), HeartbeatUrlError, bad.slice(0, 30));
  }
  assert.equal(heartbeatOrigin('https://hc.example.com/ping/secret-uuid?x=1'), 'https://hc.example.com');
  assert.equal(heartbeatOrigin('nope'), null);
});

test('heartbeat: the guard refuses loopback / metadata, even with private allowed', async () => {
  await assert.rejects(sendHeartbeat('http://127.0.0.1:9/', { policy: { allowPrivate: true } }), TargetRefusedError);
  await assert.rejects(sendHeartbeat('http://169.254.169.254/latest', { policy: { allowPrivate: true } }), TargetRefusedError);
  await assert.rejects(sendHeartbeat('http://10.20.30.40/', { policy: { allowPrivate: false } }), TargetRefusedError);
  await assert.rejects(sendHeartbeat('http://intranet/', { policy: { allowPrivate: false } }), TargetRefusedError);
  // Documentation ranges are not global unicast either.
  await assert.rejects(sendHeartbeat('http://203.0.113.7/', { policy: { allowPrivate: true } }), TargetRefusedError);
  // A name is resolved by the guard and every address checked.
  await assert.rejects(
    resolveTarget('hb.example.com', { allowPrivate: false, lookup: async () => [{ address: '192.0.2.1', family: 4 }, { address: '127.0.0.1', family: 4 }] }),
    TargetRefusedError,
  );
});

test('heartbeat: GET on the pinned address, 2xx ok, redirect / error refused', async (t) => {
  const seen: Array<{ method?: string; url?: string; host?: string; ua?: string }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, host: req.headers.host, ua: req.headers['user-agent'] });
    if (req.url?.startsWith('/redirect')) { res.writeHead(302, { Location: 'http://169.254.169.254/' }); res.end(); return; }
    if (req.url?.startsWith('/fail')) { res.writeHead(500); res.end('x'); return; }
    res.writeHead(200); res.end('OK');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  // Tests only: the guard's resolution replaced (it refuses loopback), the name still pinned.
  const deps = { policy: { allowPrivate: false }, resolve: async () => ({ address: '127.0.0.1', family: 4 as const }) };
  assert.equal(await sendHeartbeat(`http://hb.example.com:${port}/ping/abc?s=up`, deps), 200);
  assert.deepEqual(seen[0], { method: 'GET', url: '/ping/abc?s=up', host: `hb.example.com:${port}`, ua: 'Oblimint-Heartbeat/1' });
  await assert.rejects(sendHeartbeat(`http://hb.example.com:${port}/redirect`, deps), /HTTP 302/);
  assert.equal(seen.length, 2, 'the redirect is not followed');
  await assert.rejects(sendHeartbeat(`http://hb.example.com:${port}/fail`, deps), /HTTP 500/);
  // Nothing listens: a connection error, bounded.
  const closed = http.createServer();
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
  const deadPort = (closed.address() as AddressInfo).port;
  await new Promise<void>((r) => closed.close(() => r()));
  await assert.rejects(sendHeartbeat(`http://hb.example.com:${deadPort}/`, deps), /connection failed/);
});
