import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of monitoring-automation on a PGlite server (docs/P4b-PLAN.md
// §15: monitoring-automation = port 55476):  PG_PORT=55476 node <scratchpad>/pg/pgserver.mjs
// MONITORING_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. Migrations 001–007 (this suite is the first replay of 007 for the
// module's tables). External effects are fakes: DNS (save-time lookup +
// check-time resolver), ssh2 client, the uptime target is a local HTTP server.
// Covers: routes CRUD + isolation (other account / tenant, platform rows
// invisible to clients, access before body validation), plan limits, anti-SSRF
// refusals, check-now + history + transitions + scheduler, auto monitors of
// proxy hosts, status pages (+ public 404s and projection), traffic flush /
// roll-up / retention / API, app stats history, maintenance windows (CRUD +
// resolution), SSH keys, SFTP targets (TOFU pin, mismatch, reset), workflows
// (limits, validation, single-run guard, SFTP export run, cert-renewal,
// scheduler, disabled setting), certificate expiry dedup.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.MONITORING_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55476/postgres';

function reachable(url: string): Promise<boolean> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 5432) });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(1000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function until(cond: () => Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
}

test('monitoring-automation on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55476)`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-monitoring-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'monitoring-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const monitoringRoutes = (await import('../../routes/monitoring.routes')).default;
  const uptimeRoutes = (await import('../../routes/uptime.routes')).default;
  const automationRoutes = (await import('../../routes/automation.routes')).default;
  const publicRoutes = (await import('../../routes/publicStatus.routes')).default;
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');
  const { platformSettings } = await import('../platformSettings');
  const { localPaths } = await import('../hosting/paths');
  const uptime = await import('./uptime.service');
  const { clearStatusPageCacheForTests } = await import('./statusPages.service');
  const { ProxyTrafficAggregator } = await import('./traffic/aggregate');
  const { flushProxyTraffic, rollupTrafficHours, purgeTraffic } = await import('./traffic/store');
  const { appMaintenanceWindowService } = await import('./maintenanceWindows.service');
  const { setSftpResolverForTests } = await import('./automation/credentials.service');
  const { setSsh2ClientFactoryForTests } = await import('./automation/sftp');
  const { fingerprintOf } = await import('./automation/sshKeys');
  const wf = await import('./automation/workflows.service');
  const { runCertExpiryPass, CERT_NOTIFIED_KEY } = await import('./certExpiry');
  const { open } = await import('../../utils/secretBox');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // ── fakes ──────────────────────────────────────────────────────────────────
  const saveLookup = async (h: string) => {
    if (h === 'lan.example') return [{ address: '10.1.2.3', family: 4 }];
    return [{ address: '93.184.216.34', family: 4 }];
  };
  uptime.setUptimeResolverForTests(async (host) => {
    if (host === 'lan.example') throw new (await import('./targetGuard')).TargetRefusedError('refused');
    return { address: '127.0.0.1', family: 4 };
  }, saveLookup);
  setSftpResolverForTests(async () => ({ address: '203.0.113.9', family: 4 }), saveLookup);
  let hostKey = crypto.randomBytes(51);
  const remoteFiles = new Map<string, { data: string; mode: number }>();
  class FakeSsh2 extends EventEmitter {
    connect(cfg: { hostVerifier: (k: Buffer) => boolean }) {
      setImmediate(() => {
        if (!cfg.hostVerifier(hostKey)) { this.emit('error', Object.assign(new Error('Host denied'), { level: 'client-verification' })); return; }
        this.emit('ready');
      });
      return this;
    }
    sftp(cb: (e: Error | undefined, s: unknown) => void) {
      cb(undefined, {
        readdir: (_d: string, done: (e: Error | null, l: unknown[]) => void) => done(null, []),
        stat: (_p: string, done: (e: Error | null) => void) => done(null),
        mkdir: (_p: string, done: (e: Error | null) => void) => done(null),
        writeFile: (p: string, data: string, o: { mode: number }, done: (e: Error | null) => void) => { remoteFiles.set(p, { data: String(data), mode: o.mode }); done(null); },
        chmod: (p: string, mode: number, done: (e: Error | null) => void) => { const f = remoteFiles.get(p); if (f) f.mode = mode; done(null); },
        end: () => undefined,
      });
      return this;
    }
    end() { return this; }
  }
  setSsh2ClientFactoryForTests(() => new FakeSsh2() as never);
  t.after(() => {
    uptime.setUptimeResolverForTests(null);
    setSftpResolverForTests(null);
    setSsh2ClientFactoryForTests(null);
    uptime.resetUptimeForTests();
    uptime.uptimeService.stop();
  });

  // Local HTTP target of the monitors ("public.example" resolves to it at check time).
  let targetStatus = 200;
  const target = http.createServer((_req, res) => { res.writeHead(targetStatus); res.end('hello ALL GOOD'); });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
  t.after(() => new Promise<void>((r) => { target.closeAllConnections?.(); target.close(() => r()); }));
  const targetPort = (target.address() as AddressInfo).port;

  await platformSettings.update({ monitoring: { uptimeMinIntervalSec: 30, allowPrivateTargets: false, statusPagesEnabled: true, workflowsEnabled: true, certExpiryWarningDays: 14 } });

  // ── fixtures ───────────────────────────────────────────────────────────────
  const suffix = Date.now().toString(36);
  const ins = async (table: string, row: Record<string, unknown>) => {
    const [r] = await db(table).insert(row).returning('id');
    return Number((r as { id: number }).id ?? r);
  };
  const tA = await ins('tenants', { name: `A ${suffix}`, slug: `a-${suffix}` });
  const tB = await ins('tenants', { name: `B ${suffix}`, slug: `b-${suffix}` });
  const user = async (username: string, kind: 'staff' | 'client', role: 'admin' | 'user', tenantId: number) => {
    const id = await ins('users', { username: `${username}-${suffix}`, kind, role, is_active: true });
    if (kind === 'staff') await db('user_tenants').insert({ user_id: id, tenant_id: tenantId, role: 'admin' });
    return id;
  };
  const staffB = await user('stb', 'staff', 'admin', tB);
  const clientRead = await user('cr', 'client', 'user', tA);
  const clientManage = await user('cm', 'client', 'user', tA);
  const clientOther = await user('co', 'client', 'user', tA);
  const platformAdmin = await user('pa', 'staff', 'admin', 1);

  const localNode = await db('nodes').where({ is_local: true }).first('id') as { id: number };
  const limits = { ...DEFAULT_PLAN_LIMITS, maxUptimeMonitors: 3, maxWorkflows: 1 };
  const planId = await ins('plans', { tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify(limits) });
  const mkAccount = async (name: string) => {
    const uid = 20000 + Math.floor(Math.random() * 30000);
    return ins('hosting_accounts', { tenant_id: tA, node_id: localNode.id, plan_id: planId, username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off' });
  };
  const acct = await mkAccount('acme');
  const other = await mkAccount('other');
  await db('account_users').insert([
    { user_id: clientRead, account_id: acct, capabilities: JSON.stringify([]) },
    { user_id: clientManage, account_id: acct, capabilities: JSON.stringify(['monitoring.manage', 'apps.manage', 'proxy.manage']) },
    { user_id: clientOther, account_id: other, capabilities: JSON.stringify(['monitoring.manage']) },
  ]);
  const dVault = await ins('domains', { tenant_id: tA, account_id: acct, name: `vault-${suffix}.acme.fr`, verification_status: 'verified' });
  const dOther = await ins('domains', { tenant_id: tA, account_id: other, name: `x-${suffix}.other.fr`, verification_status: 'verified' });

  // ── app ────────────────────────────────────────────────────────────────────
  const app = express();
  app.set('trust proxy', false);
  app.use(express.json());
  app.use('/public', publicRoutes);
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: Number(req.header('x-user')) };
    (req as unknown as { tenantId: number }).tenantId = Number(req.header('x-tenant'));
    next();
  });
  app.use('/monitoring', monitoringRoutes);
  app.use('/uptime', uptimeRoutes);
  app.use('/automation', automationRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  type Who = { user: number; tenant: number } | null;
  const call = async (method: string, url: string, who: Who, body?: unknown) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'content-type': 'application/json', ...(who ? { 'x-user': String(who.user), 'x-tenant': String(who.tenant) } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as { success: boolean; data?: any; code?: string; error?: string; details?: any } };
  };
  const asReader: Who = { user: clientRead, tenant: tA };
  const asManager: Who = { user: clientManage, tenant: tA };
  const asOther: Who = { user: clientOther, tenant: tA };
  const asAdmin: Who = { user: platformAdmin, tenant: 1 };
  const asStaffB: Who = { user: staffB, tenant: tB };

  // ═══ uptime monitors ═══════════════════════════════════════════════════════
  const http1 = { accountId: acct, name: 'Site', kind: 'http', url: `http://public.example:${targetPort}/`, expectedStatus: [200], intervalSec: 60, retries: 2 };
  let r = await call('POST', '/uptime/monitors', asReader, http1);
  assert.equal(r.status, 403, 'member without monitoring.manage');
  r = await call('POST', '/uptime/monitors', asOther, http1);
  assert.equal(r.status, 404, 'client of another account');
  r = await call('POST', '/uptime/monitors', asStaffB, http1);
  assert.equal(r.status, 404, 'staff of another tenant');
  r = await call('POST', '/uptime/monitors', asManager, { ...http1, url: 'http://lan.example/' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'targetNotAllowed');
  r = await call('POST', '/uptime/monitors', asManager, { ...http1, url: 'http://10.0.0.1/' });
  assert.equal(r.body.code, 'targetNotAllowed', 'literal private address');
  r = await call('POST', '/uptime/monitors', asManager, { ...http1, url: 'http://169.254.169.254/latest/meta-data' });
  assert.equal(r.body.code, 'targetNotAllowed', 'metadata address');
  r = await call('POST', '/uptime/monitors', asManager, { ...http1, intervalSec: 10 });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'intervalTooShort');
  r = await call('POST', '/uptime/monitors', asManager, { ...http1, kind: 'tcp', url: null });
  assert.equal(r.status, 400, 'tcp without host / port');
  r = await call('POST', '/uptime/monitors', asManager, { ...http1, url: 'ftp://public.example/' });
  assert.equal(r.status, 400);
  r = await call('POST', '/uptime/monitors', asManager, { ...http1, accountId: null });
  assert.equal(r.status, 404, 'a client never creates a platform monitor');

  r = await call('POST', '/uptime/monitors', asManager, http1);
  assert.equal(r.status, 201, r.text);
  const m1 = r.body.data;
  assert.equal(m1.status, 'pending');
  assert.equal(m1.accountId, acct);
  assert.deepEqual(m1.expectedStatus, [200]);

  // Platform monitor: staff only, private target only with the setting (master tenant).
  r = await call('POST', '/uptime/monitors', asAdmin, { ...http1, accountId: null, name: 'Platform', url: 'http://lan.example/' });
  assert.equal(r.body.code, 'targetNotAllowed', 'allowPrivateTargets off');
  await platformSettings.update({ monitoring: { allowPrivateTargets: true } });
  r = await call('POST', '/uptime/monitors', asAdmin, { ...http1, accountId: null, name: 'Platform', url: 'http://lan.example/', intervalSec: 15 });
  assert.equal(r.status, 201, r.text);
  const mPlatform = r.body.data;
  await platformSettings.update({ monitoring: { allowPrivateTargets: false } });
  r = await call('POST', '/uptime/monitors', asManager, { ...http1, url: 'http://lan.example/' });
  assert.equal(r.body.code, 'targetNotAllowed', 'never for an account monitor');

  // Visibility.
  r = await call('GET', '/uptime/monitors', asReader);
  assert.deepEqual(r.body.data.map((m: { id: number }) => m.id), [m1.id], 'member reads its account, no platform row');
  r = await call('GET', '/uptime/monitors', asOther);
  assert.deepEqual(r.body.data, []);
  r = await call('GET', '/uptime/monitors', asStaffB);
  assert.deepEqual(r.body.data, []);
  r = await call('GET', '/uptime/monitors', asAdmin);
  assert.ok(r.body.data.some((m: { id: number }) => m.id === mPlatform.id) && r.body.data.some((m: { id: number }) => m.id === m1.id));
  r = await call('GET', `/uptime/monitors/${mPlatform.id}`, asManager);
  assert.equal(r.status, 404, 'platform row invisible to a client');
  r = await call('GET', `/uptime/monitors/${m1.id}`, asOther);
  assert.equal(r.status, 404);
  r = await call('PUT', `/uptime/monitors/${m1.id}`, asOther, { intervalSec: 'garbage' });
  assert.equal(r.status, 404, 'access checked before the body');
  r = await call('PUT', `/uptime/monitors/${m1.id}`, asReader, { name: 'x' });
  assert.equal(r.status, 403);
  r = await call('DELETE', `/uptime/monitors/${m1.id}`, asOther);
  assert.equal(r.status, 404);

  // check-now + history + ratios + rate limit.
  r = await call('POST', `/uptime/monitors/${m1.id}/check-now`, asReader);
  assert.equal(r.status, 403, 'running a check is a change');
  r = await call('POST', `/uptime/monitors/${m1.id}/check-now`, asManager);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.data.ok, true);
  assert.equal(r.body.data.statusCode, 200);
  r = await call('POST', `/uptime/monitors/${m1.id}/check-now`, asManager);
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'rateLimited');
  r = await call('GET', `/uptime/monitors/${m1.id}`, asReader);
  assert.equal(r.body.data.status, 'up');
  assert.equal(r.body.data.uptime24h, 1);
  assert.equal(r.body.data.uptime30d, 1);
  r = await call('GET', `/uptime/monitors/${m1.id}/checks?range=24h`, asReader);
  assert.equal(r.body.data.length, 1);
  r = await call('GET', `/uptime/monitors/${m1.id}/checks?range=7d`, asReader);
  assert.equal(r.body.data.length, 1, 'hourly points');

  // Transitions through recordCheck (retries 2): up → up (1 failure) → down → up.
  const fail = { ok: false, latencyMs: null, statusCode: 503, error: 'unexpected status 503' };
  const ok = { ok: true, latencyMs: 12, statusCode: 200, error: null };
  const status = async () => (await db('uptime_monitors').where({ id: m1.id }).first('status', 'consecutive_failures', 'last_error')) as { status: string; consecutive_failures: number; last_error: string | null };
  await uptime.recordCheck(m1.id, fail, new Date(Date.now() + 1));
  assert.deepEqual(await status(), { status: 'up', consecutive_failures: 1, last_error: 'unexpected status 503' });
  await uptime.recordCheck(m1.id, fail, new Date(Date.now() + 2));
  assert.equal((await status()).status, 'down');
  await uptime.recordCheck(m1.id, ok, new Date(Date.now() + 3));
  assert.deepEqual(await status(), { status: 'up', consecutive_failures: 0, last_error: null });
  const daily = await db('uptime_daily').where({ monitor_id: m1.id }).first('checks', 'up') as { checks: number; up: number };
  assert.deepEqual([Number(daily.checks), Number(daily.up)], [4, 2]);

  // Scheduler: a due monitor is checked (bounded concurrency, real HTTP to the local target).
  uptime.resetUptimeForTests();
  await db('uptime_monitors').where({ id: m1.id }).update({ last_checked_at: new Date(Date.now() - 3_600_000) });
  // Only m1 is due (the database may hold rows of an earlier run of this suite).
  await db('uptime_monitors').whereNot({ id: m1.id }).update({ enabled: false });
  const before = Number((await db('uptime_checks').where({ monitor_id: m1.id }).count<{ count: string }[]>('* as count').first())!.count);
  const launched = await uptime.schedulerTick(new Date());
  assert.equal(launched, 1);
  await until(async () => Number((await db('uptime_checks').where({ monitor_id: m1.id }).count<{ count: string }[]>('* as count').first())!.count) > before);
  assert.equal(await uptime.schedulerTick(new Date()), 0, 'not due again');

  // Update: disable → paused, enable → pending.
  r = await call('PUT', `/uptime/monitors/${m1.id}`, asManager, { enabled: false });
  assert.equal(r.body.data.status, 'paused');
  r = await call('PUT', `/uptime/monitors/${m1.id}`, asManager, { enabled: true });
  assert.equal(r.body.data.status, 'pending');
  r = await call('PUT', `/uptime/monitors/${m1.id}`, asManager, { url: 'http://lan.example/' });
  assert.equal(r.body.code, 'targetNotAllowed', 'update re-checks the target');

  // ── auto monitors of proxy hosts ──
  const hostId = await ins('proxy_hosts', { tenant_id: tA, account_id: acct, name: 'Vault', target: JSON.stringify({ kind: 'app' }), auto_monitor: true });
  await db('edge_domain_bindings').insert({ domain_id: dVault, account_id: acct, kind: 'proxy', ref_id: hostId });
  r = await call('POST', '/uptime/sync-proxy-hosts', asOther, { accountId: acct });
  assert.equal(r.status, 404);
  r = await call('POST', '/uptime/sync-proxy-hosts', asManager, { accountId: acct });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.data, { created: 1, removed: 0 });
  const auto = await db('uptime_monitors').where({ proxy_host_id: hostId, auto: true }).first() as { id: number; url: string; interval_sec: number; expected_status: unknown };
  assert.equal(auto.url, `https://vault-${suffix}.acme.fr/`);
  assert.equal(auto.interval_sec, 60);
  assert.deepEqual(auto.expected_status, []);
  assert.equal(await uptime.syncAutoMonitorNow(hostId), 'unchanged');
  r = await call('PUT', `/uptime/monitors/${auto.id}`, asManager, { url: 'https://elsewhere.example/' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'autoMonitor');
  r = await call('PUT', `/uptime/monitors/${auto.id}`, asManager, { retries: 3 });
  assert.equal(r.status, 200);
  await db('proxy_hosts').where({ id: hostId }).update({ ssl: JSON.stringify({ mode: 'none' }) });
  assert.equal(await uptime.syncAutoMonitorNow(hostId), 'updated');
  assert.equal((await db('uptime_monitors').where({ id: auto.id }).first('url') as { url: string }).url, `http://vault-${suffix}.acme.fr/`);
  // The owner's pause survives host saves; a disabled host pauses, its re-enabling resumes only a non-paused monitor.
  r = await call('PUT', `/uptime/monitors/${auto.id}`, asManager, { enabled: false });
  assert.equal(r.status, 200);
  await db('proxy_hosts').where({ id: hostId }).update({ name: 'Vault 2' });
  assert.equal(await uptime.syncAutoMonitorNow(hostId), 'updated');
  assert.deepEqual(await db('uptime_monitors').where({ id: auto.id }).first('enabled', 'status'), { enabled: false, status: 'paused' }, 'pause kept');
  r = await call('PUT', `/uptime/monitors/${auto.id}`, asManager, { enabled: true });
  await db('proxy_hosts').where({ id: hostId }).update({ enabled: false });
  assert.equal(await uptime.syncAutoMonitorNow(hostId), 'updated');
  assert.deepEqual(await db('uptime_monitors').where({ id: auto.id }).first('enabled', 'status'), { enabled: true, status: 'paused' }, 'host disabled');
  await db('proxy_hosts').where({ id: hostId }).update({ enabled: true });
  assert.equal(await uptime.syncAutoMonitorNow(hostId), 'updated');
  assert.deepEqual(await db('uptime_monitors').where({ id: auto.id }).first('enabled', 'status'), { enabled: true, status: 'pending' }, 'host enabled again');

  // Plan limit (3, the auto monitor counts).
  r = await call('POST', '/uptime/monitors', asManager, { ...http1, name: 'Third' });
  assert.equal(r.status, 201);
  const m3 = r.body.data;
  r = await call('POST', '/uptime/monitors', asManager, { ...http1, name: 'Fourth' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'planLimit');
  assert.equal(r.body.details.dimension, 'uptimeMonitors');
  // A second host with autoMonitor: over the limit → reported by the sync.
  const host2 = await ins('proxy_hosts', { tenant_id: tA, account_id: acct, name: 'Wiki', target: JSON.stringify({ kind: 'app' }), auto_monitor: true });
  const dWiki = await ins('domains', { tenant_id: tA, account_id: acct, name: `wiki-${suffix}.acme.fr`, verification_status: 'verified' });
  await db('edge_domain_bindings').insert({ domain_id: dWiki, account_id: acct, kind: 'proxy', ref_id: host2 });
  r = await call('POST', '/uptime/sync-proxy-hosts', asManager, { accountId: acct });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'planLimit');
  // autoMonitor off → removed; host deleted → orphan swept.
  await db('proxy_hosts').where({ id: hostId }).update({ auto_monitor: false });
  assert.equal(await uptime.syncAutoMonitorNow(hostId), 'removed');
  assert.equal(await uptime.syncAutoMonitorNow(host2), 'created');
  await db('proxy_hosts').where({ id: host2 }).delete();
  assert.equal(await uptime.syncAutoMonitorNow(host2), 'removed', 'deleted host: orphan swept at once');
  r = await call('POST', '/uptime/sync-proxy-hosts', asManager, { accountId: acct });
  assert.deepEqual(r.body.data, { created: 0, removed: 0 });
  assert.equal(await db('uptime_monitors').where({ auto: true, account_id: acct }).first('id'), undefined);

  // ═══ status pages ══════════════════════════════════════════════════════════
  const slug = `acme-${suffix}`;
  r = await call('POST', '/uptime/status-pages', asManager, { accountId: acct, slug, title: 'Acme', monitorIds: [mPlatform.id] });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'monitorNotInAccount');
  r = await call('POST', '/uptime/status-pages', asManager, { accountId: acct, slug, title: 'Acme', monitorIds: [m1.id], customCss: '@import url(x);' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'validation');
  r = await call('POST', '/uptime/status-pages', asManager, { accountId: acct, slug: 'Bad Slug', title: 'Acme' });
  assert.equal(r.status, 400);
  r = await call('POST', '/uptime/status-pages', asManager, { accountId: acct, slug, title: 'Acme', monitorIds: [m1.id, m3.id], customCss: 'body{color:red}' });
  assert.equal(r.status, 201, r.text);
  const page = r.body.data;
  assert.equal(page.published, false);
  r = await call('POST', '/uptime/status-pages', asOther, { accountId: other, slug, title: 'Copy' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'slugTaken');
  r = await call('GET', '/uptime/status-pages', asOther);
  assert.deepEqual(r.body.data, []);
  r = await call('GET', `/uptime/status-pages/${page.id}`, asStaffB);
  assert.equal(r.status, 404);

  clearStatusPageCacheForTests();
  r = await call('GET', `/public/status-pages/${slug}`, null);
  assert.equal(r.status, 404, 'unpublished');
  r = await call('GET', '/public/status-pages/nope-nope', null);
  assert.equal(r.status, 404);
  r = await call('PUT', `/uptime/status-pages/${page.id}`, asManager, { published: true });
  assert.equal(r.status, 200);
  r = await call('GET', `/public/status-pages/${slug}`, null);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.data.monitors.map((m: { name: string }) => m.name), ['Site', 'Third']);
  assert.equal(r.body.data.monitors[0].history.length, 90);
  assert.equal(r.body.data.customCss, 'body{color:red}');
  for (const leak of ['public.example', 'lan.example', 'unexpected status', `"id"`, 'accountId']) {
    assert.ok(!r.text.includes(leak), `public page leaks ${leak}`);
  }
  await platformSettings.update({ monitoring: { statusPagesEnabled: false } });
  clearStatusPageCacheForTests();
  r = await call('GET', `/public/status-pages/${slug}`, null);
  assert.equal(r.status, 404, 'disabled by the settings');
  await platformSettings.update({ monitoring: { statusPagesEnabled: true } });
  r = await call('DELETE', `/uptime/status-pages/${page.id}`, asReader);
  assert.equal(r.status, 403);

  // ═══ traffic ═══════════════════════════════════════════════════════════════
  const trafficHost = await ins('proxy_hosts', { tenant_id: tA, account_id: acct, name: 'Traffic', target: JSON.stringify({ kind: 'app' }) });
  const agg = new ProxyTrafficAggregator();
  const now = new Date();
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000 - 5 * 60_000);
  const line = (over: Record<string, unknown> = {}) => ({
    time: new Date(minute.getTime() + 10_000).toISOString(), host: 'x', remoteAddr: '198.51.100.7', method: 'GET', uri: '/a?b=1', status: 200, bytes: 1,
    bytesOut: 100, bytesIn: 10, requestTime: 0.03, upstream: null, upstreamStatus: '200', userAgent: 'ua', referer: null, siteId: null, accountId: acct, tenantId: tA,
    kind: 'proxy', proxyHostId: trafficHost, ...over,
  });
  for (let i = 0; i < 8; i++) agg.add(line() as never, now);
  agg.add(line({ status: 502, requestTime: 2 }) as never, now);
  agg.add(line({ status: 404 }) as never, now);
  agg.add(line({ proxyHostId: 999_999 }) as never, now); // unknown host: dropped at flush (FK)
  const lookups: string[][] = [];
  const geo = async (ips: string[]) => { lookups.push(ips); return new Map(ips.map((ip) => [ip, { countryCode: 'FR', countryName: 'France', city: null, latitude: null, longitude: null, org: null }])); };
  const drained = agg.drain();
  assert.equal(await flushProxyTraffic(drained, { lookupMany: geo }), 1);
  // Additive: the same batch again doubles the counters and the histogram.
  const again = new ProxyTrafficAggregator();
  for (let i = 0; i < 8; i++) again.add(line() as never, now);
  again.add(line({ status: 502, requestTime: 2 }) as never, now);
  again.add(line({ status: 404 }) as never, now);
  await flushProxyTraffic(again.drain(), { lookupMany: geo });
  const minuteRow = await db('proxy_traffic_minute').where({ proxy_host_id: trafficHost }).first() as Record<string, unknown>;
  assert.equal(Number(minuteRow.requests), 20);
  assert.equal(Number(minuteRow.upstream_errors), 2);
  assert.equal(Number(minuteRow.account_id), acct);
  assert.equal((minuteRow.latency_buckets as number[]).reduce((a, b) => a + Number(b), 0), 20);
  assert.equal(Number((minuteRow.latency_buckets as number[])[3]), 18, '30 ms bucket summed');
  assert.ok(lookups[0].includes('198.51.100.7'));
  // Samples capped at 200 per host and kind.
  const many = new ProxyTrafficAggregator();
  for (let i = 0; i < 199; i++) many.add(line({ status: 500, uri: `/e${i}` }) as never, now);
  await flushProxyTraffic(many.drain());
  const sampleCount = Number((await db('proxy_traffic_samples').where({ proxy_host_id: trafficHost, kind: 'error' }).count<{ count: string }[]>('* as count').first())!.count);
  assert.equal(sampleCount, 200, '2 + 199 → 200 kept');
  // Roll-up (idempotent) and API.
  await rollupTrafficHours(new Date(minute.getTime() - 3_600_000), new Date(now.getTime() + 3_600_000));
  await rollupTrafficHours(new Date(minute.getTime() - 3_600_000), new Date(now.getTime() + 3_600_000));
  const hourRow = await db('proxy_traffic_hour').where({ proxy_host_id: trafficHost }).first('requests') as { requests: number };
  assert.equal(Number(hourRow.requests), 219);
  r = await call('GET', '/monitoring/traffic?range=1h', asReader);
  const ov = r.body.data.find((x: { proxyHostId: number }) => x.proxyHostId === trafficHost);
  assert.equal(ov.requests, 219);
  assert.ok(ov.errorRate > 0);
  assert.ok(ov.p95Ms !== null);
  r = await call('GET', '/monitoring/traffic?range=1h', asOther);
  assert.ok(!r.body.data.some((x: { proxyHostId: number }) => x.proxyHostId === trafficHost));
  r = await call('GET', `/monitoring/traffic/${trafficHost}?range=1h`, asOther);
  assert.equal(r.status, 404);
  r = await call('GET', `/monitoring/traffic/${trafficHost}?range=1h`, asReader);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.data.summary.requests, 219);
  assert.equal(r.body.data.series.length, 60);
  assert.equal(r.body.data.topIps[0].key, '198.51.100.7');
  assert.equal(r.body.data.topIps[0].geo.countryCode, 'FR');
  assert.equal(r.body.data.topUris[0].key, '/a');
  assert.equal(r.body.data.countries[0].key, 'FR');
  assert.equal(r.body.data.slowSamples.length, 2);
  r = await call('GET', `/monitoring/traffic/${trafficHost}?range=7d&status=4xx`, asReader);
  assert.equal(r.body.data.summary.requests, 219, 'hourly + live minutes');
  assert.equal(r.body.data.errorSamples.length, 0, 'errors samples are ≥ 500');
  await purgeTraffic(7, 90, new Date(now.getTime() + 100 * 86_400_000));
  assert.equal(await db('proxy_traffic_minute').where({ proxy_host_id: trafficHost }).first('minute'), undefined);
  assert.equal(await db('proxy_traffic_hour').where({ proxy_host_id: trafficHost }).first('hour'), undefined);

  // ═══ app stats (history; no Docker answer) ═════════════════════════════════
  const stackId = await ins('app_stacks', { tenant_id: tA, account_id: acct, node_id: localNode.id, name: `vault${suffix}`.slice(0, 30), display_name: 'Vault', source_type: 'editor' });
  await db('usage_resource_samples').insert([
    { at: new Date(now.getTime() - 120_000), account_id: acct, container: `app-${suffix}-web`, role: 'app', cpu_pct: 1.5, mem_bytes: 1000, app_stack_id: stackId },
    { at: new Date(now.getTime() - 60_000), account_id: acct, container: `app-${suffix}-web`, role: 'app', cpu_pct: 2.5, mem_bytes: 3000, app_stack_id: stackId },
    { at: new Date(now.getTime() - 60_000), account_id: acct, container: `site-${suffix}`, role: 'site', cpu_pct: 9, mem_bytes: 9 },
  ]);
  r = await call('GET', `/monitoring/apps/${stackId}/stats?range=1h`, asReader);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.data.services.length, 1);
  assert.equal(r.body.data.services[0].series.length, 2);
  assert.equal(r.body.data.services[0].current, null);
  r = await call('GET', `/monitoring/apps/${stackId}/stats?range=7d`, asReader);
  assert.equal(r.body.data.services[0].series.length >= 1, true);
  r = await call('GET', `/monitoring/apps/${stackId}/stats`, asOther);
  assert.equal(r.status, 404);

  // ═══ maintenance windows ═══════════════════════════════════════════════════
  const sched = { days: [0, 1, 2, 3, 4, 5, 6], start: '03:00', durationMinutes: 60, timezone: 'Europe/Paris' };
  r = await call('POST', '/automation/maintenance-windows', asManager, { accountId: acct, name: 'Bad', schedule: { ...sched, timezone: 'Nowhere/X' } });
  assert.equal(r.body.code, 'invalidTimezone');
  r = await call('POST', '/automation/maintenance-windows', asManager, { accountId: acct, name: 'Bad', schedule: { ...sched, start: '25:00' } });
  assert.equal(r.body.code, 'invalidSchedule');
  r = await call('POST', '/automation/maintenance-windows', asReader, { accountId: acct, name: 'Nightly', schedule: sched });
  assert.equal(r.status, 403);
  r = await call('POST', '/automation/maintenance-windows', asManager, { accountId: acct, name: 'Nightly', schedule: sched, isDefault: true });
  assert.equal(r.status, 201, r.text);
  const w1 = r.body.data;
  assert.equal(typeof w1.openNow, 'boolean');
  assert.ok(w1.nextOpenAt);
  r = await call('POST', '/automation/maintenance-windows', asManager, { accountId: acct, name: 'Sunday', schedule: { ...sched, days: [0], start: '12:00', timezone: 'UTC' }, isDefault: true });
  assert.equal(r.status, 201);
  const w2 = r.body.data;
  assert.equal((await db('app_maintenance_windows').where({ id: w1.id }).first('is_default') as { is_default: boolean }).is_default, false, 'one default per account');
  // Tenant default (platform row of tenant A: staff).
  const staffA = await user('sta', 'staff', 'admin', tA);
  r = await call('POST', '/automation/maintenance-windows', { user: staffA, tenant: tA }, { accountId: null, name: 'Tenant', schedule: { ...sched, days: [6], start: '01:00', timezone: 'UTC' }, isDefault: true });
  assert.equal(r.status, 201, r.text);
  const wTenant = r.body.data;
  r = await call('GET', '/automation/maintenance-windows', asManager);
  assert.ok(!r.body.data.some((w: { id: number }) => w.id === wTenant.id), 'platform window invisible to a client');
  // Resolution: stack window → account default → tenant default → none.
  const sunNoon = new Date('2026-10-11T12:30:00Z');
  const sat0130 = new Date('2026-10-10T01:30:00Z');
  const paris0330 = new Date('2026-10-14T01:30:00Z'); // Wednesday 03:30 CEST
  assert.equal(await appMaintenanceWindowService.isOpen({ tenantId: tA, accountId: acct, windowId: w1.id }, paris0330), true, 'stack window');
  assert.equal(await appMaintenanceWindowService.isOpen({ tenantId: tA, accountId: acct, windowId: w1.id }, sunNoon), false);
  assert.equal(await appMaintenanceWindowService.isOpen({ tenantId: tA, accountId: acct, windowId: null }, sunNoon), true, 'account default');
  assert.equal(await appMaintenanceWindowService.isOpen({ tenantId: tA, accountId: acct, windowId: null }, paris0330), false);
  assert.equal(await appMaintenanceWindowService.isOpen({ tenantId: tA, accountId: other, windowId: null }, sat0130), true, 'tenant default');
  assert.equal(await appMaintenanceWindowService.isOpen({ tenantId: tA, accountId: other, windowId: null }, sunNoon), false);
  assert.equal(await appMaintenanceWindowService.isOpen({ tenantId: tA, accountId: other, windowId: w1.id }, sunNoon), false, 'another account window ignored → defaults');
  assert.equal(await appMaintenanceWindowService.isOpen({ tenantId: tB, accountId: 999_999, windowId: null }, sunNoon), true, 'no window = any time');
  assert.equal(await appMaintenanceWindowService.nextOpening({ tenantId: tB, accountId: 999_999, windowId: null }, sunNoon), null);
  assert.equal((await appMaintenanceWindowService.nextOpening({ tenantId: tA, accountId: acct, windowId: null }, new Date('2026-10-12T00:00:00Z')))!.toISOString(), '2026-10-18T12:00:00.000Z');
  // Unreadable window → closed.
  await db('app_maintenance_windows').where({ id: w2.id }).update({ schedule: JSON.stringify({ days: 'x' }) });
  assert.equal(await appMaintenanceWindowService.isOpen({ tenantId: tA, accountId: acct, windowId: null }, sunNoon), false);
  assert.equal(await appMaintenanceWindowService.nextOpening({ tenantId: tA, accountId: acct, windowId: null }, sunNoon), null);
  r = await call('PUT', `/automation/maintenance-windows/${w2.id}`, asManager, { schedule: { ...sched, days: [0], start: '12:00', timezone: 'UTC' } });
  assert.equal(r.status, 200);
  r = await call('PUT', `/automation/maintenance-windows/${w2.id}`, asOther, { name: 'x' });
  assert.equal(r.status, 404);
  r = await call('DELETE', `/automation/maintenance-windows/${wTenant.id}`, asManager);
  assert.equal(r.status, 404);

  // ═══ SSH keys + SFTP targets ═══════════════════════════════════════════════
  r = await call('POST', '/automation/ssh-keys', asManager, { accountId: acct, name: 'deploy' });
  assert.equal(r.status, 201, r.text);
  const key = r.body.data;
  assert.match(key.publicKey, /^ssh-ed25519 [A-Za-z0-9+/=]+ oblimint\/deploy$/);
  assert.match(key.fingerprint, /^SHA256:/);
  assert.ok(!r.text.includes('PRIVATE'), 'private key never returned');
  const sealed = await db('automation_ssh_keys').where({ id: key.id }).first('private_key_sealed') as { private_key_sealed: string };
  assert.ok(!sealed.private_key_sealed.includes('PRIVATE'));
  assert.match(open('automation', sealed.private_key_sealed), /BEGIN OPENSSH PRIVATE KEY/);
  r = await call('POST', '/automation/ssh-keys', asManager, { accountId: acct, name: 'bad', privateKey: 'not a key' });
  assert.equal(r.status, 400);
  r = await call('POST', '/automation/ssh-keys', asOther, { accountId: other, name: 'theirs' });
  const otherKey = r.body.data;

  const targetBody = { accountId: acct, name: 'Backup', host: 'sftp.example', username: 'deploy', authMethod: 'key', sshKeyId: key.id, basePath: '/srv/certs' };
  r = await call('POST', '/automation/sftp-targets', asManager, { ...targetBody, sshKeyId: otherKey.id });
  assert.equal(r.status, 404, 'key of another account');
  r = await call('POST', '/automation/sftp-targets', asManager, { ...targetBody, host: 'lan.example' });
  assert.equal(r.body.code, 'targetNotAllowed');
  r = await call('POST', '/automation/sftp-targets', asManager, { ...targetBody, basePath: '/srv/../etc' });
  assert.equal(r.status, 400);
  r = await call('POST', '/automation/sftp-targets', asManager, { ...targetBody, authMethod: 'password', sshKeyId: null });
  assert.equal(r.status, 400, 'password required');
  r = await call('POST', '/automation/sftp-targets', asManager, targetBody);
  assert.equal(r.status, 201, r.text);
  const sftpT = r.body.data;
  assert.equal(sftpT.hostKeyFingerprint, null);
  r = await call('POST', `/automation/sftp-targets/${sftpT.id}/test`, asManager);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.data.ok, r.body.data.fingerprint], [true, fingerprintOf(hostKey)]);
  assert.equal((await db('sftp_targets').where({ id: sftpT.id }).first('host_key_fingerprint') as { host_key_fingerprint: string }).host_key_fingerprint, fingerprintOf(hostKey), 'TOFU pin');
  const firstKey = hostKey;
  hostKey = crypto.randomBytes(51);
  r = await call('POST', `/automation/sftp-targets/${sftpT.id}/test`, asManager);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'hostKeyMismatch');
  hostKey = firstKey;
  r = await call('POST', '/automation/sftp-targets', asManager, { ...targetBody, name: 'Pw', authMethod: 'password', sshKeyId: null, password: 's3cret!' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.hasPassword, true);
  assert.ok(!r.text.includes('s3cret'));
  const pwTarget = r.body.data;
  r = await call('PUT', `/automation/sftp-targets/${pwTarget.id}`, asManager, { name: 'Pw2' });
  assert.equal(r.status, 200, 'password kept when absent');
  r = await call('DELETE', `/automation/ssh-keys/${key.id}`, asManager);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'sshKeyInUse');
  r = await call('GET', '/automation/sftp-targets', asOther);
  assert.deepEqual(r.body.data, []);

  // ═══ workflows ═════════════════════════════════════════════════════════════
  const certName = `vault-${suffix}.acme.fr`;
  const certId = await ins('certificates', { domain_id: dVault, primary_name: certName, names: JSON.stringify([certName]), status: 'valid', not_after: new Date(Date.now() + 5 * 86_400_000) });
  const otherCert = await ins('certificates', { domain_id: dOther, primary_name: `x-${suffix}.other.fr`, names: JSON.stringify([]), status: 'valid', not_after: new Date(Date.now() + 60 * 86_400_000) });
  const certDir = path.join(localPaths.edgeCerts(), certName);
  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(path.join(certDir, 'fullchain.pem'), '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n');
  fs.writeFileSync(path.join(certDir, 'privkey.pem'), '-----BEGIN PRIVATE KEY-----\nKKK\n-----END PRIVATE KEY-----\n');
  const exportAction = { kind: 'export-certificate', certificate: { kind: 'acme', id: certId }, sftpTargetId: sftpT.id, remotePath: 'vault', format: 'pem-split' };
  const wfBody = { accountId: acct, name: 'Export', trigger: { kind: 'manual' }, actions: [exportAction] };
  r = await call('POST', '/automation/workflows', asManager, { ...wfBody, actions: [{ ...exportAction, certificate: { kind: 'acme', id: otherCert } }] });
  assert.equal(r.status, 400, 'certificate of another account');
  r = await call('POST', '/automation/workflows', asManager, { ...wfBody, actions: [{ ...exportAction, remotePath: '../etc' }] });
  assert.equal(r.status, 400);
  r = await call('POST', '/automation/workflows', asManager, { ...wfBody, trigger: { kind: 'interval', intervalMinutes: 4 } });
  assert.equal(r.status, 400);
  r = await call('POST', '/automation/workflows', asManager, { ...wfBody, trigger: { kind: 'cron', cron: 'nope' } });
  assert.equal(r.body.code, 'invalidCron');
  r = await call('POST', '/automation/workflows', asManager, { ...wfBody, actions: [{ kind: 'restart-app', stackId: 999_999 }] });
  assert.equal(r.status, 404, 'unknown stack');
  r = await call('POST', '/automation/workflows', asReader, wfBody);
  assert.equal(r.status, 403);
  await db('account_users').where({ user_id: clientManage, account_id: acct }).update({ capabilities: JSON.stringify(['monitoring.manage', 'apps.manage']) });
  r = await call('POST', '/automation/workflows', asManager, wfBody);
  assert.equal(r.status, 403, 'export-certificate needs proxy.manage on the certificate account');
  await db('account_users').where({ user_id: clientManage, account_id: acct }).update({ capabilities: JSON.stringify(['monitoring.manage', 'apps.manage', 'proxy.manage']) });
  r = await call('POST', '/automation/workflows', asManager, wfBody);
  assert.equal(r.status, 201, r.text);
  const wf1 = r.body.data;
  r = await call('POST', '/automation/workflows', asManager, { ...wfBody, name: 'Second' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'planLimit');
  assert.equal(r.body.details.dimension, 'workflows');
  r = await call('DELETE', `/automation/sftp-targets/${sftpT.id}`, asManager);
  assert.equal(r.body.code, 'sftpTargetInUse');
  r = await call('GET', `/automation/workflows/${wf1.id}`, asOther);
  assert.equal(r.status, 404);

  // Single-run guard.
  const claimed = await wf.claimWorkflow(wf1.id);
  assert.ok(claimed);
  assert.equal(await wf.claimWorkflow(wf1.id), null, 'never two runs');
  r = await call('POST', `/automation/workflows/${wf1.id}/run`, asManager);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'workflowRunning');
  await db('workflows').where({ id: wf1.id }).update({ running_since: new Date(Date.now() - 2 * 3_600_000) });
  assert.ok(await wf.claimWorkflow(wf1.id), 'stale claim taken over');
  await db('workflows').where({ id: wf1.id }).update({ running_since: null });

  // Manual run: export over (fake) SFTP.
  r = await call('POST', `/automation/workflows/${wf1.id}/run`, asManager);
  assert.equal(r.status, 202, r.text);
  assert.equal(r.body.data.status, 'running');
  await wf.workflowRunsIdle();
  let run = await db('workflow_runs').where({ id: r.body.data.id }).first() as { status: string; log: string[] };
  assert.equal(run.status, 'succeeded', JSON.stringify(run.log));
  assert.deepEqual([...remoteFiles.keys()].sort(), ['/srv/certs/vault/fullchain.pem', '/srv/certs/vault/privkey.pem']);
  assert.equal(remoteFiles.get('/srv/certs/vault/privkey.pem')?.mode, 0o600);
  assert.match(remoteFiles.get('/srv/certs/vault/privkey.pem')!.data, /KKK/);
  r = await call('GET', `/automation/workflows/${wf1.id}/runs`, asReader);
  assert.equal(r.body.data.total, 1);
  assert.equal(r.body.data.items[0].status, 'succeeded');
  assert.equal((await db('workflows').where({ id: wf1.id }).first('last_status', 'running_since') as { last_status: string; running_since: unknown }).running_since, null);

  // Host key changed → the run fails (generic error), workflow.failed.
  hostKey = crypto.randomBytes(51);
  r = await call('POST', `/automation/workflows/${wf1.id}/run`, asManager);
  await wf.workflowRunsIdle();
  run = await db('workflow_runs').where({ id: r.body.data.id }).first() as { status: string; log: string[] };
  assert.equal(run.status, 'failed');
  assert.ok(run.log.some((l) => l.includes('host key mismatch')), JSON.stringify(run.log));
  hostKey = firstKey;

  // cert-renewal + interval triggers (plan raised for the account).
  await db('plans').where({ id: planId }).update({ limits: JSON.stringify({ ...limits, maxWorkflows: 5 }) });
  r = await call('PUT', `/automation/workflows/${wf1.id}`, asManager, { trigger: { kind: 'cert-renewal', certificateNames: [`*.acme.fr`] } });
  assert.equal(r.status, 200, r.text);
  assert.equal(await wf.handleCertificateInstalled(`x-${suffix}.other.fr`, []), 0, 'certificate of another account');
  assert.equal(await wf.handleCertificateInstalled(certName, [certName]), 1);
  await wf.workflowRunsIdle();
  const certRun = await db('workflow_runs').where({ workflow_id: wf1.id }).orderBy('id', 'desc').first() as { trigger: string; status: string };
  assert.deepEqual([certRun.trigger.startsWith('cert-renewal:'), certRun.status], [true, 'succeeded']);

  r = await call('POST', '/automation/workflows', asManager, { ...wfBody, name: 'Every 10', trigger: { kind: 'interval', intervalMinutes: 10 } });
  assert.equal(r.status, 201, r.text);
  const wf2 = r.body.data;
  assert.ok(wf2.nextRunAt);
  await db('workflows').whereNot({ id: wf2.id }).whereRaw("trigger->>'kind' IN ('interval', 'cron')").update({ enabled: false });
  assert.equal(await wf.workflowSchedulerTick(new Date()), 0, 'not due yet');
  await db('workflows').where({ id: wf2.id }).update({ next_run_at: new Date(Date.now() - 1000) });
  assert.equal(await wf.workflowSchedulerTick(new Date()), 1);
  await wf.workflowRunsIdle();
  const nextAt = (await db('workflows').where({ id: wf2.id }).first('next_run_at') as { next_run_at: Date }).next_run_at;
  assert.ok(new Date(nextAt).getTime() > Date.now() + 9 * 60_000, 'rescheduled');

  // restart-app: apps.manage on the stack required; restartForWorkflow called.
  const { appsService } = await import('../apps/apps.service');
  const restarts: Array<[number, string[] | null]> = [];
  const original = appsService.restartForWorkflow;
  // The run waits for the outcome of the restart deployment: the fake records an already finished one.
  appsService.restartForWorkflow = async (id, services) => {
    restarts.push([id, services]);
    const st = await db('app_stacks').where({ id }).first('account_id', 'tenant_id') as { account_id: number; tenant_id: number };
    const [dep] = await db('app_deployments').insert({ stack_id: id, account_id: st.account_id, tenant_id: st.tenant_id, action: 'restart', trigger: 'workflow', status: 'succeeded' }).returning('id');
    return { deploymentId: Number((dep as { id: number }).id ?? dep) };
  };
  t.after(() => { appsService.restartForWorkflow = original; });
  r = await call('POST', '/automation/workflows', asManager, { accountId: acct, name: 'Restart', trigger: { kind: 'manual' }, actions: [{ kind: 'restart-app', stackId, services: ['web'] }] });
  assert.equal(r.status, 201, r.text);
  const wf3 = r.body.data;
  await db('account_users').where({ user_id: clientManage, account_id: acct }).update({ capabilities: JSON.stringify(['monitoring.manage']) });
  r = await call('POST', '/automation/workflows', asManager, { accountId: acct, name: 'Restart2', trigger: { kind: 'manual' }, actions: [{ kind: 'restart-app', stackId }] });
  assert.equal(r.status, 403, 'apps.manage required at save time');
  r = await call('POST', `/automation/workflows/${wf3.id}/run`, asManager);
  assert.equal(r.status, 202);
  await wf.workflowRunsIdle();
  assert.deepEqual(restarts, [[stackId, ['web']]]);
  const restartRun = await db('workflow_runs').where({ workflow_id: wf3.id }).orderBy('id', 'desc').first('status', 'log') as { status: string; log: unknown };
  assert.equal(restartRun.status, 'succeeded', JSON.stringify(restartRun.log));
  assert.ok(JSON.stringify(restartRun.log).includes('Restart done'));

  // Disabled by the settings.
  await platformSettings.update({ monitoring: { workflowsEnabled: false } });
  r = await call('POST', '/automation/workflows', asManager, { ...wfBody, name: 'Off' });
  assert.equal(r.body.code, 'workflowsDisabled');
  r = await call('POST', `/automation/workflows/${wf3.id}/run`, asManager);
  assert.equal(r.body.code, 'workflowsDisabled');
  assert.equal(await wf.handleCertificateInstalled(certName, [certName]), 0);
  await platformSettings.update({ monitoring: { workflowsEnabled: true } });

  // Isolation of the lists.
  r = await call('GET', '/automation/workflows', asStaffB);
  assert.deepEqual(r.body.data, []);
  r = await call('GET', '/automation/workflows', asOther);
  assert.deepEqual(r.body.data, []);
  r = await call('GET', '/automation/ssh-keys', asReader);
  assert.deepEqual(r.body.data.map((k: { id: number }) => k.id), [key.id]);

  // ═══ certificate expiry ════════════════════════════════════════════════════
  await db('app_config').where({ key: CERT_NOTIFIED_KEY }).delete();
  const refs = await runCertExpiryPass(new Date());
  assert.ok(refs.includes(`acme:${certId}`));
  assert.ok(!refs.includes(`acme:${otherCert}`), 'beyond the warning threshold');
  assert.deepEqual(await runCertExpiryPass(new Date()), [], 'once per 7 days');
  assert.ok((await runCertExpiryPass(new Date(Date.now() + 8 * 86_400_000))).includes(`acme:${certId}`), 'again after 7 days');

  // Delete flows.
  r = await call('DELETE', `/automation/workflows/${wf1.id}`, asManager);
  assert.equal(r.status, 200);
  r = await call('DELETE', `/uptime/monitors/${m3.id}`, asManager);
  assert.equal(r.status, 200);
});
