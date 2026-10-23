import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of the orchestration module on a PGlite server
// (docs/P1-PLAN.md §16: orchestration = port 55436):
//   PG_PORT=55436 node <scratchpad>/pg/pgserver.mjs
// ORCHESTRATION_TEST_DATABASE_URL overrides the URL. Skipped cleanly when
// nothing listens. Docker = FakeDocker (engine seam), hostd / releases / edge
// = fakes (backends seam). Covers the HTTP routes (runtime, filesrv) with
// their access checks (A1/A2: invisible → 404, visible without the need →
// 403), the reconcile on real rows (statuses, quota mode) and the file server
// expiry worker.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.ORCHESTRATION_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55436/postgres';

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

test('orchestration routes + reconcile on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55436)`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-orch-db-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  // Before ANY import of config / db.
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'orchestration-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const runtimeRoutes = (await import('../../routes/runtime.routes')).default;
  const fileServerRoutes = (await import('../../routes/filesrv.routes')).default;
  const { setEngineFactoryForTests } = await import('./engine');
  const { setBackendsForTests } = await import('./backends');
  const { FakeDocker } = await import('./testing/fakeDocker');
  const { reconcileService, loadAccountState, persistOutcome } = await import('./reconcile.service');
  const { expireActivations } = await import('./filesrv.service');
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // ── fakes ──────────────────────────────────────────────────────────────────
  const docker = new FakeDocker();
  docker.networks.set('oblimint', { name: 'oblimint', labels: {} });
  docker.addContainer({ name: 'oblimint-edge' });
  for (const img of ['apache-php8.3', 'nginx-php8.3', 'nginx-php8.4']) docker.images.add(`meejay/oblimint-${img}:latest`);
  docker.images.add('meejay/oblimint-filesrv:latest');
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number };
  setEngineFactoryForTests(() => docker.asDocker(), localNode.id);
  const hostdCalls: string[] = [];
  setBackendsForTests({
    hostd: () => ({
      ensureAccount: async (s: { accountId: number }) => { hostdCalls.push(`ensureAccount ${s.accountId}`); return { quotaMode: 'measured' as const }; },
      ensureSite: async () => undefined,
      ensureDataPaths: async () => undefined,
    }) as never,
    ensureSiteStorage: async () => undefined,
    removeSiteStorage: async () => undefined,
    scheduleEdgeSync: () => undefined,
  });
  t.after(() => { setEngineFactoryForTests(null); setBackendsForTests(null); reconcileService.stop(); });

  // ── fixtures ───────────────────────────────────────────────────────────────
  const suffix = Date.now().toString(36);
  const [tenantA] = await db('tenants').insert({ name: `A ${suffix}`, slug: `a-${suffix}` }).returning('id');
  const [tenantB] = await db('tenants').insert({ name: `B ${suffix}`, slug: `b-${suffix}` }).returning('id');
  const tA = Number(tenantA.id ?? tenantA);
  const tB = Number(tenantB.id ?? tenantB);
  const user = async (username: string, kind: 'staff' | 'client', role: 'admin' | 'user', tenantId: number, tenantRole = 'admin') => {
    const [row] = await db('users').insert({ username: `${username}-${suffix}`, kind, role, is_active: true }).returning('id');
    const id = Number(row.id ?? row);
    if (kind === 'staff') await db('user_tenants').insert({ user_id: id, tenant_id: tenantId, role: tenantRole });
    return id;
  };
  const adminA = await user('adm', 'staff', 'user', tA, 'admin');      // tenant admin of A (caps '*' via role? no: permission set)
  const staffB = await user('stb', 'staff', 'user', tB, 'admin');
  const clientRead = await user('cr', 'client', 'user', tA);
  const clientManage = await user('cm', 'client', 'user', tA);
  const platformAdmin = await user('pa', 'staff', 'admin', 1);

  const [plan] = await db('plans').insert({
    tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify({ ...DEFAULT_PLAN_LIMITS, allowedBases: ['apache-php8.3', 'nginx-php8.3', 'nginx-php8.4'] }),
  }).returning('id');
  const uid = 20000 + Math.floor(Math.random() * 30000);
  const [acct] = await db('hosting_accounts').insert({
    tenant_id: tA, node_id: localNode.id, plan_id: Number(plan.id ?? plan), username: `acme${suffix}`.slice(0, 30), uid, gid: uid,
    filesrv_mode: 'on-demand', filesrv_port: 30000 + (uid % 2000),
  }).returning('id');
  const accountId = Number(acct.id ?? acct);
  const [siteRow] = await db('sites').insert({
    tenant_id: tA, account_id: accountId, name: 'Blog', slug: 'blog', base: 'apache-php8.3',
  }).returning('id');
  const siteId = Number(siteRow.id ?? siteRow);
  await db('account_users').insert([
    { user_id: clientRead, account_id: accountId, capabilities: JSON.stringify([]) },
    { user_id: clientManage, account_id: accountId, capabilities: JSON.stringify(['sites.manage', 'files.manage']) },
  ]);

  // ── app ────────────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: Number(req.header('x-user')) };
    (req as unknown as { tenantId: number }).tenantId = Number(req.header('x-tenant'));
    next();
  });
  app.use('/sites', runtimeRoutes);
  app.use('/accounts', fileServerRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = async (method: string, url: string, who: { user: number; tenant: number }, body?: unknown) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-user': String(who.user), 'x-tenant': String(who.tenant) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as { success: boolean; data?: any; code?: string; error?: string } };
  };
  const asReader = { user: clientRead, tenant: tA };
  const asManager = { user: clientManage, tenant: tA };

  // ── reconcile on real rows ─────────────────────────────────────────────────
  const report = await reconcileService.reconcileAccountNow(accountId);
  assert.equal(report.ok, true, report.errors.join('\n'));
  const acctAfter = await db('hosting_accounts').where({ id: accountId }).first('status', 'quota_mode');
  assert.deepEqual({ ...acctAfter }, { status: 'active', quota_mode: 'measured' });
  assert.equal((await db('sites').where({ id: siteId }).first('status')).status, 'active');
  assert.equal(docker.containers.get(`oblimint-site-${siteId}`)?.state, 'running');
  assert.ok(fs.existsSync(path.join(dataRoot, 'accounts', String(accountId), 'sites', String(siteId), 'runtime', 'primary.json')));

  // ── access (A1/A2) ─────────────────────────────────────────────────────────
  let r = await call('GET', `/sites/${siteId}/runtime`, { user: staffB, tenant: tB });
  assert.equal(r.status, 404, 'staff of another tenant: invisible');
  r = await call('GET', `/sites/${siteId}/runtime`, { user: clientRead, tenant: tB });
  assert.equal(r.status, 404, 'client in another tenant session: invisible');
  r = await call('GET', `/sites/999999/runtime`, asReader);
  assert.equal(r.status, 404);
  r = await call('GET', `/sites/abc/runtime`, asReader);
  assert.equal(r.status, 404);
  r = await call('GET', `/sites/${siteId}/runtime`, asReader);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.base, 'apache-php8.3');
  assert.deepEqual(r.body.data.containers.map((c: { role: string; state: string }) => `${c.role}:${c.state}`), ['primary:running']);
  r = await call('POST', `/sites/${siteId}/runtime/switch`, asReader, { base: 'nginx-php8.3', mode: 'direct' });
  assert.equal(r.status, 403, 'member without sites.manage');
  r = await call('POST', `/sites/${siteId}/runtime/restart`, asReader);
  assert.equal(r.status, 403);
  r = await call('POST', `/sites/${siteId}/runtime/switch`, { user: staffB, tenant: tB }, { base: 'nope' });
  assert.equal(r.status, 404, 'access checked before the body');
  r = await call('POST', `/sites/${siteId}/runtime/switch`, asManager, { base: 'nope' });
  assert.equal(r.status, 400);

  // ── check / switch / preview / promote ─────────────────────────────────────
  r = await call('POST', `/sites/${siteId}/runtime/check`, asReader, { base: 'apache-php7.4' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.warnings.map((w: { code: string }) => w.code).sort(), ['imageMissing', 'phpDowngrade', 'phpMajorChange', 'unmaintainedRuntime', 'vulnerableRuntime']);

  r = await call('POST', `/sites/${siteId}/runtime/switch`, asManager, { base: 'apache-php8.4', mode: 'direct' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'baseNotAllowed');

  r = await call('POST', `/sites/${siteId}/runtime/switch`, asManager, { base: 'nginx-php8.3', mode: 'direct' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.base, 'nginx-php8.3');
  assert.equal(docker.containers.get(`oblimint-site-${siteId}`)?.image, 'meejay/oblimint-nginx-php8.3:latest');

  r = await call('POST', `/sites/${siteId}/runtime/switch`, asManager, { base: 'nginx-php8.4', mode: 'preview' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.previewBase, 'nginx-php8.4');
  assert.equal(docker.containers.get(`oblimint-site-${siteId}-preview`)?.state, 'running');

  r = await call('POST', `/sites/${siteId}/runtime/preview/promote`, asManager);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.base, 'nginx-php8.4');
  assert.equal(r.body.data.previewBase, null);
  assert.ok(!docker.containers.has(`oblimint-site-${siteId}-preview`));
  assert.equal(docker.containers.get(`oblimint-site-${siteId}`)?.image, 'meejay/oblimint-nginx-php8.4:latest');

  r = await call('POST', `/sites/${siteId}/runtime/preview/promote`, asManager);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'noPreview');

  r = await call('POST', `/sites/${siteId}/runtime/restart`, asManager);
  assert.equal(r.status, 200);
  assert.ok(docker.calls.includes(`restart oblimint-site-${siteId}`));

  const audits = await db('audit_logs').where({ tenant_id: tA }).whereIn('action', ['runtime.switch', 'runtime.preview', 'runtime.promote']).pluck('action');
  assert.deepEqual([...audits].sort(), ['runtime.preview', 'runtime.promote', 'runtime.switch']);

  // Platform admin on the master tenant (god view) sees it.
  r = await call('GET', `/sites/${siteId}/runtime`, { user: platformAdmin, tenant: 1 });
  assert.equal(r.status, 200);
  void adminA;

  // ── file server ────────────────────────────────────────────────────────────
  r = await call('GET', `/accounts/${accountId}/filesrv`, asReader);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.running, false);
  r = await call('POST', `/accounts/${accountId}/filesrv/activate`, asReader, { minutes: 60 });
  assert.equal(r.status, 403);
  r = await call('POST', `/accounts/${accountId}/filesrv/activate`, { user: staffB, tenant: tB }, { minutes: 60 });
  assert.equal(r.status, 404);
  r = await call('POST', `/accounts/${accountId}/filesrv/activate`, asManager, { minutes: 5 });
  assert.equal(r.status, 400);
  r = await call('POST', `/accounts/${accountId}/filesrv/activate`, asManager, { minutes: 60 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.running, true);
  assert.ok(r.body.data.activeUntil);
  assert.equal(docker.containers.get(`oblimint-files-${accountId}`)?.state, 'running');

  // Expiry worker: active_until in the past → cleared, the reconcile stops it.
  await db('hosting_accounts').where({ id: accountId }).update({ filesrv_active_until: new Date(Date.now() - 1000) });
  assert.deepEqual(await expireActivations(), [accountId]);
  reconcileService.stop(); // drop the queued debounce: run the pass synchronously
  await reconcileService.reconcileAccountNow(accountId);
  assert.equal(docker.containers.get(`oblimint-files-${accountId}`)?.state, 'exited');

  // ── gateway activation (P2): persisted, so a panel restart keeps extending it ──
  const { fileServerService } = await import('./filesrv.service');
  const cols = async () => await db('hosting_accounts').where({ id: accountId }).first('filesrv_active_until', 'filesrv_gateway_until') as
    { filesrv_active_until: Date | null; filesrv_gateway_until: Date | null };
  const ms = (v: Date | string | null) => (v === null ? null : new Date(v).getTime());
  await fileServerService.activateFromGateway(accountId);
  let acc = await cols();
  assert.ok(acc.filesrv_gateway_until, 'gateway origin persisted');
  assert.equal(ms(acc.filesrv_gateway_until), ms(acc.filesrv_active_until));
  assert.equal(await fileServerService.isGatewayActivation(accountId), true);
  // Nothing in memory: a window close to its end is extended from the DB (as after a restart).
  const later = new Date(ms(acc.filesrv_active_until)! - 60_000);
  assert.deepEqual(await fileServerService.extendGatewayActivations(later), [accountId]);
  acc = await cols();
  assert.equal(ms(acc.filesrv_active_until), later.getTime() + 15 * 60_000);
  assert.equal(ms(acc.filesrv_gateway_until), ms(acc.filesrv_active_until));
  assert.deepEqual(await fileServerService.extendGatewayActivations(later), [], 'far from its end: unchanged');
  // The gateway's idle closes its own window.
  assert.equal(await fileServerService.endGatewayActivation(accountId), true);
  acc = await cols();
  assert.equal(acc.filesrv_active_until, null);
  assert.equal(acc.filesrv_gateway_until, null);
  // A manual window is never extended nor stopped by the gateway.
  await fileServerService.activateFromGateway(accountId);
  r = await call('POST', `/accounts/${accountId}/filesrv/activate`, asManager, { minutes: 60 });
  assert.equal(r.status, 200);
  assert.equal((await cols()).filesrv_gateway_until, null);
  assert.equal(await fileServerService.isGatewayActivation(accountId), false);
  assert.deepEqual(await fileServerService.extendGatewayActivations(new Date(Date.now() + 58 * 60_000)), []);
  assert.equal(await fileServerService.endGatewayActivation(accountId), false);
  // block-uploads: the open sessions are dropped (restart), a stopped server is left alone.
  assert.equal(await fileServerService.dropSessions(accountId), true);
  assert.ok(docker.calls.includes(`restart oblimint-files-${accountId}`));
  r = await call('POST', `/accounts/${accountId}/filesrv/deactivate`, asManager);
  assert.equal(r.status, 200);

  await db('hosting_accounts').where({ id: accountId }).update({ filesrv_mode: 'off' });
  r = await call('POST', `/accounts/${accountId}/filesrv/activate`, asManager, { minutes: 60 });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'fileServerOff');
  r = await call('POST', `/accounts/${accountId}/filesrv/deactivate`, asManager);
  assert.equal(r.status, 200);
  assert.ok(!docker.containers.has(`oblimint-files-${accountId}`), 'mode off: container removed');

  // ── suspension stops, unsuspension restarts ────────────────────────────────
  await db('hosting_accounts').where({ id: accountId }).update({ status: 'suspended' });
  await reconcileService.reconcileAccountNow(accountId);
  assert.equal(docker.containers.get(`oblimint-site-${siteId}`)?.state, 'exited');
  await db('hosting_accounts').where({ id: accountId }).update({ status: 'active' });
  await reconcileService.reconcileAccountNow(accountId);
  assert.equal(docker.containers.get(`oblimint-site-${siteId}`)?.state, 'running');
  assert.ok(hostdCalls.length > 0);

  // ── statuses are compare-and-set: a change made during a pass wins ─────────
  await db('hosting_accounts').where({ id: accountId }).update({ status: 'error', status_message: 'x' });
  await db('sites').where({ id: siteId }).update({ status: 'error', status_message: 'y' });
  const snap = (await loadAccountState(accountId))!;
  // Meanwhile (outside the account lock): the account is suspended, the site stopped.
  await db('hosting_accounts').where({ id: accountId }).update({ status: 'suspended' });
  await db('sites').where({ id: siteId }).update({ status: 'stopped' });
  await persistOutcome(snap, {
    report: { accountId, ok: true, actions: [], errors: [], issues: [] }, unreachable: false, quotaMode: null,
    accountErrors: [], siteErrors: new Map(), skippedSites: new Set(), touchedSites: new Set(), fileServerRunning: null,
  });
  assert.equal((await db('hosting_accounts').where({ id: accountId }).first('status')).status, 'suspended');
  assert.equal((await db('sites').where({ id: siteId }).first('status')).status, 'stopped');
  // Unchanged meanwhile → written.
  await db('hosting_accounts').where({ id: accountId }).update({ status: 'error' });
  const snap3 = (await loadAccountState(accountId))!;
  await persistOutcome(snap3, {
    report: { accountId, ok: true, actions: [], errors: [], issues: [] }, unreachable: false, quotaMode: null,
    accountErrors: [], siteErrors: new Map(), skippedSites: new Set(), touchedSites: new Set(), fileServerRunning: null,
  });
  assert.equal((await db('hosting_accounts').where({ id: accountId }).first('status')).status, 'active');
  reconcileService.stop(); // drop the 'status-race' re-queue
});
