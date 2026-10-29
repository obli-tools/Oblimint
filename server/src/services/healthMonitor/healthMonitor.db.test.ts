import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';

// Deep health + heartbeat on a real PostgreSQL (HEALTHMON_TEST_DATABASE_URL,
// default the harness on 55523; skipped when nothing listens): token stored as
// a hash and checked by GET /health/deep (404 / 401 / 200 / 503), heartbeat URL
// sealed at rest and refused by the anti-SSRF guard, a beat sent only while
// every check is green.

const DB_URL = process.env.HEALTHMON_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55523/postgres';

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

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: s ? JSON.parse(s) : null }));
    }).on('error', reject);
  });
}

test('deep health and heartbeat', { timeout: 120_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) { t.skip(`no PostgreSQL at ${DB_URL}`); return; }
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.SESSION_SECRET ||= 'healthmon-test-secret-0123456789abcdef';
  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const svc = await import('./healthMonitor.service');
  await db.migrate.latest();
  await db('app_config').where({ key: 'health_monitor' }).del();
  t.after(async () => { await db('app_config').where({ key: 'health_monitor' }).del(); svc.setHealthMonitorForTests(null); await db.destroy(); });

  // Probes: real PostgreSQL, the rest controlled.
  let edgeRunning = true;
  svc.setHealthMonitorForTests({
    hostd: async () => undefined,
    infra: async () => [{ id: 'edge', deployed: true, running: edgeRunning, image: null, version: null, detail: null }],
    workers: () => ({ enabled: true, lastTick: Date.now(), startedAt: Date.now() }),
    disk: async () => ({ totalBytes: 100 * 1024 ** 3, availableBytes: 50 * 1024 ** 3 }),
  });

  const app = express();
  app.get('/health/deep', svc.deepHealthHandler);
  const server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;

  const suffix = Date.now().toString(36);
  const [ten] = await db('tenants').insert({ name: `H ${suffix}`, slug: `h-${suffix}` }).returning('id');
  const tenantId = Number(ten.id ?? ten);
  t.after(async () => { await db('audit_logs').where({ tenant_id: tenantId }).del().catch(() => undefined); await db('tenants').where({ id: tenantId }).del().catch(() => undefined); });
  const req = { headers: {}, session: { currentTenantId: tenantId }, socket: { remoteAddress: '203.0.113.9' } } as never;

  // No token: the endpoint is off.
  assert.equal((await get(port, '/health/deep')).status, 404);
  const created = await svc.healthMonitorService.createToken(req);
  assert.match(created.token, /^obh_[A-Za-z0-9_-]{40,}$/);
  assert.equal(created.settings.tokenSet, true);
  const stored = await db('app_config').where({ key: 'health_monitor' }).first('value');
  assert.equal(String(stored.value).includes(created.token), false, 'only the hash is stored');

  assert.equal((await get(port, '/health/deep')).status, 401);
  assert.equal((await get(port, '/health/deep', { authorization: 'Bearer wrong' })).status, 401);
  const okRes = await get(port, '/health/deep', { authorization: `Bearer ${created.token}` });
  assert.equal(okRes.status, 200, JSON.stringify(okRes.body));
  assert.equal(okRes.body.status, 'ok');
  assert.equal(okRes.body.checks.find((c: { id: string }) => c.id === 'postgres').status, 'ok');
  assert.equal((await get(port, `/health/deep?token=${encodeURIComponent(created.token)}`)).status, 200);
  assert.equal((await get(port, '/health/deep', { 'x-oblimint-health-token': created.token })).status, 200);

  // A new token replaces the old one.
  const second = await svc.healthMonitorService.createToken(req);
  assert.equal((await get(port, '/health/deep', { authorization: `Bearer ${created.token}` })).status, 401);

  // Heartbeat URL: refused by the guard (loopback, private, single label), then accepted, sealed at rest.
  for (const bad of ['http://127.0.0.1:8080/push', 'http://10.1.2.3/push', 'http://monitor/push']) {
    await assert.rejects(svc.healthMonitorService.updateSettings(req, { heartbeatUrl: bad }), (e: { code?: string }) => e.code === 'targetNotAllowed', bad);
  }
  await assert.rejects(svc.healthMonitorService.updateSettings(req, { heartbeatUrl: 'ftp://hb.example.com/' }), (e: { code?: string }) => e.code === 'validation');
  // (A save-time DNS failure is not a refusal: every beat resolves again.)
  const s = await svc.healthMonitorService.updateSettings(req, { heartbeatUrl: 'https://hb.example.com/api/push/very-secret?status=up' });
  assert.equal(s.heartbeatSet, true);
  assert.equal(s.heartbeatOrigin, 'https://hb.example.com');
  assert.equal(JSON.stringify(s).includes('very-secret'), false);
  const raw = await db('app_config').where({ key: 'health_monitor' }).first('value');
  assert.equal(String(raw.value).includes('very-secret'), false, 'URL sealed at rest');

  // Beats: a local receiver behind a test resolver (the real guard refuses loopback).
  let beats = 0;
  const receiver = http.createServer((_q, r) => { beats++; r.writeHead(200); r.end('ok'); });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  t.after(() => receiver.close());
  const rport = (receiver.address() as AddressInfo).port;
  await svc.healthMonitorService.updateSettings(req, { heartbeatUrl: `http://hb.example.com:${rport}/push` });
  svc.setHealthMonitorForTests({
    hostd: async () => undefined,
    infra: async () => [{ id: 'edge', deployed: true, running: edgeRunning, image: null, version: null, detail: null }],
    workers: () => ({ enabled: true, lastTick: Date.now(), startedAt: Date.now() }),
    disk: async () => ({ totalBytes: 100 * 1024 ** 3, availableBytes: 50 * 1024 ** 3 }),
  }, { resolve: async () => ({ address: '127.0.0.1', family: 4 }) });

  await svc.heartbeatTickForTests();
  assert.equal(beats, 1);
  let st = await svc.healthMonitorService.getSettings();
  assert.ok(st.lastHeartbeatAt);
  assert.equal(st.lastHeartbeatError, null);
  assert.equal(st.lastReport?.status, 'ok');

  // A red check: no beat, the reason is kept; the endpoint answers 503.
  edgeRunning = false;
  await svc.heartbeatTickForTests();
  assert.equal(beats, 1);
  st = await svc.healthMonitorService.getSettings();
  assert.match(st.lastHeartbeatError ?? '', /failing checks \(edge\)/);
  const red = await get(port, '/health/deep', { authorization: `Bearer ${second.token}` });
  assert.equal(red.status, 503);
  assert.equal(red.body.status, 'fail');

  // Removal and revocation.
  const cleared = await svc.healthMonitorService.updateSettings(req, { heartbeatUrl: null });
  assert.equal(cleared.heartbeatSet, false);
  await svc.healthMonitorService.revokeToken(req);
  assert.equal((await get(port, '/health/deep', { authorization: `Bearer ${second.token}` })).status, 404);
  const actions = (await db('audit_logs').where({ tenant_id: tenantId }).pluck('action')).sort();
  assert.ok(actions.includes('system.healthMonitor.tokenCreated') && actions.includes('system.healthMonitor.heartbeatSet') && actions.includes('system.healthMonitor.tokenRevoked'));
});
