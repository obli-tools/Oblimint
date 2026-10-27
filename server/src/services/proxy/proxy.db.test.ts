import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import selfsigned from 'selfsigned';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of proxy-hosts on a PGlite server (docs/P4b-PLAN.md §15:
// proxy-hosts = port 55473):  PG_PORT=55473 node <scratchpad>/pg/pgserver.mjs
// PROXY_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. Other P4b modules = fakes (setProxyDepsForTests), Docker =
// FakeDocker. Covers: migrations 001–007, CRUD through the routes, domain
// binding rules (unverified, other account, already bound, site routes,
// served_by back to sites), plan limits, isolation (other account / tenant,
// missing capability, client vs staff-only features), external targets,
// advancedConfig, access lists / pages / providers / certificates, the edge
// unit provider (claimed names dropped), the internal contracts and the
// forward-auth sidecars convergence.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.PROXY_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55473/postgres';

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

function selfSigned(names: string[]): Promise<{ cert: string; key: string }> {
  return new Promise((resolve, reject) => {
    selfsigned.generate([{ name: 'commonName', value: names[0] }], {
      keySize: 2048, days: 30, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: names.map((value) => ({ type: 2, value })) }],
    }, (err, pems) => (err ? reject(err) : resolve({ cert: pems.cert, key: pems.private })));
  });
}

test('proxy-hosts on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55473)`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-proxy-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.OBLIMINT_SELF_CONTAINER = 'oblimint';
  process.env.SESSION_SECRET ||= 'proxy-hosts-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const proxyRoutes = (await import('../../routes/proxy.routes')).default;
  const { setEngineFactoryForTests } = await import('../docker/engine');
  const { FakeDocker } = await import('../docker/testing/fakeDocker');
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');
  const { setProxyDepsForTests } = await import('./deps');
  const { platformSettings } = await import('../platformSettings');
  const { buildProxyUnits, proxyUnitProblem } = await import('./provider');
  const { recheckExternalTargets } = await import('./worker');
  const { proxyContracts } = await import('./contracts');
  const { convergeAuth, resetAuthInfraForTests, sidecarStateOf } = await import('./authInfra');
  const { localPaths } = await import('../hosting/paths');
  const { verifyAccessPassword } = await import('./htpasswd');
  type AppTargetInfo = import('../apps/apps.service').AppTargetInfo;

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // 007 replayed: its tables exist.
  for (const table of ['proxy_hosts', 'proxy_routes', 'edge_domain_bindings', 'proxy_streams', 'access_lists', 'custom_pages', 'auth_providers',
    'imported_certificates', 'proxy_host_access_lists', 'proxy_redirections', 'proxy_dead_hosts', 'uptime_monitors']) {
    assert.ok(await db.schema.hasTable(table), `${table} exists`);
  }

  // ── fakes ──────────────────────────────────────────────────────────────────
  const docker = new FakeDocker();
  docker.addContainer({ name: 'oblimint' });
  docker.addContainer({ name: 'oblimint-edge' });
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number };
  setEngineFactoryForTests(() => docker.asDocker(), localNode.id);

  const hooks: string[] = [];
  let externalAllowed = false;
  let publicAddress = '93.184.216.34';
  const targetInfos = new Map<string, AppTargetInfo>();
  let retryBehaviour: 'notImplemented' | 'ok' = 'notImplemented';
  setProxyDepsForTests({
    async targetInfo(stackId, service) { return targetInfos.get(`${stackId}/${service}`) ?? null; },
    async stackSummary(stackId) { return { id: stackId, accountId: 0, tenantId: 0, name: `stack${stackId}`, displayName: `Stack ${stackId}`, status: 'running' }; },
    async allowExternalTargets() { return externalAllowed; },
    lintAdvancedConfig(text) {
      return text.includes('include') ? { ok: false, issues: [{ line: 1, directive: 'include', code: 'forbiddenDirective', message: 'no include' }] } : { ok: true, issues: [] };
    },
    async unitStates(kind, ids) {
      return new Map(ids.map((id) => [id, {
        unitId: `x-${id}`, ownerKind: kind, ownerId: id, accountId: null, status: 'quarantined', error: 'nginx: [emerg] secret path /srv/x', upstreams: [],
        desiredHash: null, activeHash: null, checkedAt: null, appliedAt: null,
      }]));
    },
    async retryUnit(_req, unitId) {
      hooks.push(`retry ${unitId}`);
      if (retryBehaviour === 'notImplemented') {
        const { notImplementedError } = await import('../../utils/notImplemented');
        throw notImplementedError('edge-robustness', 'retry');
      }
      return { unitId, ownerKind: 'proxy-host', ownerId: null, accountId: null, status: 'active', error: null, upstreams: [], desiredHash: null, activeHash: null, checkedAt: null, appliedAt: null };
    },
    syncAutoMonitor(id) { hooks.push(`monitor ${id}`); },
    requestPolicySync(reason) { hooks.push(`policy ${reason}`); },
    scheduleEdgeSync(reason) { hooks.push(`edge ${reason}`); },
    ensureCertificate(id) { hooks.push(`cert ${id}`); },
    authChanged(reason) { hooks.push(`auth ${reason}`); },
    async lookup(host) {
      if (host === 'public.example.com') return [{ address: publicAddress, family: 4 }];
      throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    },
    async dockerSubnets() { return ['172.30.0.0/16']; },
  });
  t.after(() => {
    setEngineFactoryForTests(null);
    setProxyDepsForTests(null);
    resetAuthInfraForTests();
  });
  // Ports are global to the edge: a previous run on the same server must not hold them.
  await db('proxy_streams').del();
  await platformSettings.update({ edge:{ streamPorts: [{ port: 5432, protocol: 'tcp' }, { port: 2053, protocol: 'udp' }] } } as never);

  // ── fixtures ───────────────────────────────────────────────────────────────
  const suffix = Date.now().toString(36);
  const idOf = (r: unknown) => Number((r as { id?: number }).id ?? r);
  const tA = idOf((await db('tenants').insert({ name: `A ${suffix}`, slug: `a-${suffix}` }).returning('id'))[0]);
  const tB = idOf((await db('tenants').insert({ name: `B ${suffix}`, slug: `b-${suffix}` }).returning('id'))[0]);
  const user = async (username: string, kind: 'staff' | 'client', role: 'admin' | 'user', tenantId: number) => {
    const id = idOf((await db('users').insert({ username: `${username}-${suffix}`, kind, role, is_active: true }).returning('id'))[0]);
    if (kind === 'staff') await db('user_tenants').insert({ user_id: id, tenant_id: tenantId, role: 'admin' });
    return id;
  };
  const staffB = await user('stb', 'staff', 'admin', tB);
  const clientRead = await user('cr', 'client', 'user', tA);
  const clientManage = await user('cm', 'client', 'user', tA);
  const clientOther = await user('co', 'client', 'user', tA);
  const clientProxyOnly = await user('cpo', 'client', 'user', tA);
  const platformAdmin = await user('pa', 'staff', 'admin', 1);

  const limits = { ...DEFAULT_PLAN_LIMITS, maxProxyHosts: 3, maxRedirections: 2, proxyExternalTargets: true };
  const planId = idOf((await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify(limits) }).returning('id'))[0]);
  const mkAccount = async (name: string) => {
    const uid = 20000 + Math.floor(Math.random() * 30000);
    return idOf((await db('hosting_accounts').insert({
      tenant_id: tA, node_id: localNode.id, plan_id: planId, username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
    }).returning('id'))[0]);
  };
  const acct = await mkAccount('acme');
  const other = await mkAccount('other');
  const mkDomain = async (accountId: number, name: string, verified: boolean, extra: Record<string, unknown> = {}) =>
    idOf((await db('domains').insert({ tenant_id: tA, account_id: accountId, name, verification_status: verified ? 'verified' : 'pending', ...extra }).returning('id'))[0]);
  const d1 = await mkDomain(acct, `vault-${suffix}.fr`, true, { include_www: true });
  const d2 = await mkDomain(acct, `two-${suffix}.fr`, true);
  const d3 = await mkDomain(acct, `three-${suffix}.fr`, true);
  const d4 = await mkDomain(acct, `four-${suffix}.fr`, true);
  const d5 = await mkDomain(acct, `five-${suffix}.fr`, true);
  const dPending = await mkDomain(acct, `pending-${suffix}.fr`, false);
  const dRouted = await mkDomain(acct, `routed-${suffix}.fr`, true);
  const dOther = await mkDomain(other, `other-${suffix}.fr`, true);
  const siteId = idOf((await db('sites').insert({ tenant_id: tA, account_id: acct, name: 'site', slug: `s${suffix}`.slice(0, 30), base: 'apache-php8.3', status: 'active' }).returning('id'))[0]);
  await db('site_routes').insert({ account_id: acct, domain_id: dRouted, path_prefix: '/', site_id: siteId, runtime_id: null });
  await db('account_users').insert([
    { user_id: clientRead, account_id: acct, capabilities: JSON.stringify([]) },
    // Binding a domain takes it from the sites: proxy.manage + domains.manage (L1); clientProxyOnly has proxy.manage alone.
    { user_id: clientManage, account_id: acct, capabilities: JSON.stringify(['proxy.manage', 'domains.manage']) },
    { user_id: clientProxyOnly, account_id: acct, capabilities: JSON.stringify(['proxy.manage']) },
    { user_id: clientOther, account_id: other, capabilities: JSON.stringify(['proxy.manage']) },
  ]);
  // Stack ids unique per run (the harness database may be reused).
  const S1 = 1000 + Math.floor(Math.random() * 1_000_000) * 3;
  const S2 = S1 + 1;
  const S3 = S1 + 2;
  const appInfo = (stackId: number, accountId: number, extra: Partial<AppTargetInfo> = {}): AppTargetInfo => ({
    stackId, accountId, tenantId: tA, nodeId: localNode.id, service: 'web', alias: `app-${stackId}-web`, exposedPorts: [{ port: 8080, protocol: 'tcp' }],
    status: 'running', sleeping: false, onFront: true, sleepEnabled: false, wakingPageId: null, wakeEtaSec: null, ...extra,
  });
  targetInfos.set(`${S1}/web`, appInfo(S1, acct, { sleepEnabled: true, wakeEtaSec: 7 }));
  targetInfos.set(`${S3}/web`, appInfo(S3, other));
  targetInfos.set(`${S2}/db`, { ...appInfo(S2, acct), service: 'db', alias: `app-${S2}-db`, exposedPorts: [{ port: 5432, protocol: 'tcp' }] });

  // ── app ────────────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: Number(req.header('x-user')) };
    (req as unknown as { tenantId: number }).tenantId = Number(req.header('x-tenant'));
    next();
  });
  app.use('/proxy', proxyRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  type Who = { user: number; tenant: number };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (method: string, url: string, who: Who, body?: unknown): Promise<{ status: number; body: { success: boolean; data?: any; code?: string; error?: string; details?: any } }> => {
    const res = await fetch(`${base}${url}`, {
      method, headers: { 'content-type': 'application/json', 'x-user': String(who.user), 'x-tenant': String(who.tenant) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as never };
  };
  const asReader: Who = { user: clientRead, tenant: tA };
  const asManager: Who = { user: clientManage, tenant: tA };
  const asOther: Who = { user: clientOther, tenant: tA };
  const asProxyOnly: Who = { user: clientProxyOnly, tenant: tA };
  const asAdmin: Who = { user: platformAdmin, tenant: 1 };
  const asStaffB: Who = { user: staffB, tenant: tB };
  const servedBy = async (id: number) => ((await db('domains').where({ id }).first('served_by')) as { served_by: string }).served_by;
  const appTarget = { kind: 'app', stackId: S1, service: 'web', port: 8080, scheme: 'http' };

  // ── proxy hosts: access + domain binding rules ─────────────────────────────
  const hostBody = (domainIds: number[], extra: Record<string, unknown> = {}) => ({ accountId: acct, name: 'vault', domainIds, target: appTarget, ...extra });
  let r = await call('POST', '/proxy/hosts', asReader, hostBody([d1]));
  assert.equal(r.status, 403, 'member without proxy.manage');
  r = await call('POST', '/proxy/hosts', asOther, hostBody([d1]));
  assert.equal(r.status, 404, 'client of another account');
  r = await call('POST', '/proxy/hosts', asStaffB, hostBody([d1]));
  assert.equal(r.status, 404, 'staff of another tenant');
  r = await call('POST', '/proxy/hosts', asManager, hostBody([dPending]));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'domainNotVerified');
  r = await call('POST', '/proxy/hosts', asManager, hostBody([dOther]));
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'domainNotInAccount');
  r = await call('POST', '/proxy/hosts', asManager, hostBody([dRouted]));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'domainInUse');
  assert.equal(r.body.details.servedBy, 'sites');
  r = await call('POST', '/proxy/hosts', asManager, hostBody([d1], { target: { ...appTarget, port: 9999 } }));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'targetPortNotExposed');
  r = await call('POST', '/proxy/hosts', asManager, hostBody([d1], { target: { ...appTarget, stackId: S3 } }));
  assert.equal(r.status, 404, 'a stack of another account');
  r = await call('POST', '/proxy/hosts', asManager, hostBody([d1], { advancedConfig: 'add_header X 1;' }));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'advancedConfigForbidden');
  r = await call('POST', '/proxy/hosts', asManager, hostBody([d1], { routes: [{ path: '/a b/', target: appTarget }] }));
  assert.equal(r.status, 400, 'hostile route path refused by the schema');
  // Nothing was left behind by the refused attempts.
  assert.equal(await servedBy(d1), 'sites');
  assert.equal(Number(((await db('proxy_hosts').where({ account_id: acct }).count('* as c').first()) as { c: unknown }).c), 0);

  hooks.length = 0;
  r = await call('POST', '/proxy/hosts', asManager, hostBody([d1], {
    options: { websocket: true, rateLimit: { rps: 10, burst: 20 } },
    routes: [{ path: '/api/', target: { kind: 'site', siteId, port: 1234, scheme: 'https' } }],
    autoMonitor: true,
  }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const h1 = r.body.data;
  assert.equal(h1.domains.length, 1);
  assert.equal(h1.domains[0].name, `vault-${suffix}.fr`);
  assert.equal(h1.routes[0].target.port, 8080, 'site target normalized to the site port');
  assert.equal(h1.targetLabel, `Stack ${S1}/web:8080`);
  assert.equal(h1.advancedConfig, null);
  assert.equal(h1.edge.error, 'The edge refused this configuration (contact support)', 'A6: generic edge error for a client');
  assert.equal(await servedBy(d1), 'proxy');
  assert.ok(await db('edge_domain_bindings').where({ domain_id: d1, kind: 'proxy', ref_id: h1.id }).first());
  assert.ok(hooks.includes(`monitor ${h1.id}`) && hooks.some((h) => h.startsWith('policy ')) && hooks.some((h) => h.startsWith('edge ')) && hooks.includes(`cert ${d1}`));
  const audit = await db('audit_logs').where({ action: 'proxy.host.create', resource_path: String(h1.id) }).first('tenant_id');
  assert.equal(Number(audit.tenant_id), tA);

  r = await call('POST', '/proxy/hosts', asManager, hostBody([d1]));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'domainInUse');
  assert.equal(r.body.details.servedBy, 'proxy');
  // proxy.manage alone: never binds a domain (L1), but edits a host whose domains stay the same.
  r = await call('POST', '/proxy/hosts', asProxyOnly, hostBody([d2], { name: 'two' }));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'domainsManageRequired');
  assert.equal(await servedBy(d2), 'sites');
  r = await call('POST', '/proxy/redirections', asProxyOnly, { accountId: acct, domainIds: [d2], targetDomain: 'example.org' });
  assert.equal(r.body.code, 'domainsManageRequired');
  r = await call('PUT', `/proxy/hosts/${h1.id}`, asProxyOnly, { domainIds: [d1, d2] });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'domainsManageRequired');
  r = await call('PUT', `/proxy/hosts/${h1.id}`, asProxyOnly, { name: 'vault' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await servedBy(d2), 'sites');
  assert.equal(Number(((await db('proxy_hosts').where({ account_id: acct }).count('* as c').first()) as { c: unknown }).c), 1);
  r = await call('POST', '/proxy/redirections', asManager, { accountId: acct, domainIds: [d1], targetDomain: 'example.org' });
  assert.equal(r.status, 409, 'one consumer per domain');

  // Reads: member yes, other account / tenant no.
  r = await call('GET', `/proxy/hosts/${h1.id}`, asReader);
  assert.equal(r.status, 200);
  r = await call('GET', `/proxy/hosts/${h1.id}`, asOther);
  assert.equal(r.status, 404);
  r = await call('GET', `/proxy/hosts/${h1.id}`, asStaffB);
  assert.equal(r.status, 404);
  r = await call('GET', '/proxy/hosts', asOther);
  assert.deepEqual(r.body.data, []);
  r = await call('GET', `/proxy/hosts?search=vault-${suffix}`, asReader);
  assert.equal(r.body.data.length, 1);
  r = await call('GET', `/proxy/hosts/${h1.id}`, asAdmin);
  assert.ok(r.body.data.edge.error.includes('emerg'), 'staff sees the edge detail');

  // advancedConfig: platform staff only, linted; a client edit keeps it, never shows it.
  r = await call('PUT', `/proxy/hosts/${h1.id}`, asAdmin, { advancedConfig: 'include /etc/passwd;' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'advancedConfigInvalid');
  assert.equal(r.body.details.issues[0].code, 'forbiddenDirective');
  r = await call('PUT', `/proxy/hosts/${h1.id}`, asAdmin, { advancedConfig: 'add_header X-Staff 1;' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.advancedConfig, 'add_header X-Staff 1;');
  r = await call('PUT', `/proxy/hosts/${h1.id}`, asManager, { name: 'vault2' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.advancedConfig, null);
  assert.equal(r.body.data.hasAdvancedConfig, true);
  assert.equal(((await db('proxy_hosts').where({ id: h1.id }).first('advanced_config')) as { advanced_config: string }).advanced_config, 'add_header X-Staff 1;');
  r = await call('PUT', `/proxy/hosts/${h1.id}`, asManager, { advancedConfig: null });
  assert.equal(r.status, 403, 'a client cannot remove it either');

  // External targets: plan ∧ tenant policy, public only; allowPrivate = platform staff.
  const ext = (host: string, extra: Record<string, unknown> = {}) => ({ kind: 'external', host, port: 443, scheme: 'https', ...extra });
  r = await call('POST', '/proxy/hosts', asManager, hostBody([d2], { target: ext('93.184.216.34') }));
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'targetNotAllowed');
  externalAllowed = true;
  r = await call('POST', '/proxy/hosts', asManager, hostBody([d2], { target: ext('10.1.2.3') }));
  assert.equal(r.status, 403, 'private refused');
  r = await call('POST', '/proxy/hosts', asManager, hostBody([d2], { target: ext('10.1.2.3', { allowPrivate: true }) }));
  assert.equal(r.status, 403, 'allowPrivate is platform staff only');
  r = await call('POST', '/proxy/hosts', asManager, hostBody([d2], { target: ext('172.30.1.1', { allowPrivate: true }) }));
  assert.equal(r.status, 403);
  r = await call('POST', '/proxy/hosts', asManager, hostBody([d2], { target: ext('public.example.com') }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const h2 = r.body.data;
  r = await call('PUT', `/proxy/hosts/${h2.id}`, asAdmin, { target: ext('10.1.2.3', { allowPrivate: true }) });
  assert.equal(r.status, 200, 'platform staff may allow a private target');
  r = await call('PUT', `/proxy/hosts/${h2.id}`, asManager, { name: 'renamed' });
  assert.equal(r.status, 200, 'an unchanged staff-set target survives a client edit');
  assert.equal(r.body.data.target.allowPrivate, true);
  externalAllowed = false;
  r = await call('PUT', `/proxy/hosts/${h2.id}`, asManager, { name: 'renamed' });
  assert.equal(r.status, 403, 'PX2: the plan / tenant policy is re-checked even for an unchanged external target');
  assert.equal(r.body.code, 'targetNotAllowed');
  externalAllowed = true;
  r = await call('PUT', `/proxy/hosts/${h2.id}`, asAdmin, { target: ext('172.30.1.1', { allowPrivate: true }) });
  assert.equal(r.status, 403, 'Docker ranges never, even for the staff');

  // Plan limit (maxProxyHosts 3).
  r = await call('POST', '/proxy/hosts', asManager, hostBody([d3]));
  assert.equal(r.status, 201);
  const h3 = r.body.data;
  r = await call('POST', '/proxy/hosts', asManager, hostBody([d4]));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'planLimit');
  assert.equal(r.body.details.dimension, 'proxyHosts');
  assert.equal(await servedBy(d4), 'sites');

  // Domain swap: d3 → d4, d3 back to sites.
  r = await call('PUT', `/proxy/hosts/${h3.id}`, asManager, { domainIds: [d4] });
  assert.equal(r.status, 200);
  assert.equal(await servedBy(d3), 'sites');
  assert.equal(await servedBy(d4), 'proxy');

  // Retry: edge-robustness not there → scheduled sync, host returned.
  hooks.length = 0;
  r = await call('POST', `/proxy/hosts/${h3.id}/retry`, asManager);
  assert.equal(r.status, 200);
  assert.ok(hooks.includes(`retry ph-${h3.id}`) && hooks.some((h) => h.startsWith('edge ')));
  r = await call('POST', `/proxy/hosts/${h3.id}/retry`, asReader);
  assert.equal(r.status, 403);

  // Delete: bindings gone, served_by back to sites.
  r = await call('DELETE', `/proxy/hosts/${h3.id}`, asManager);
  assert.equal(r.status, 200);
  assert.equal(await servedBy(d4), 'sites');
  assert.equal(await db('edge_domain_bindings').where({ domain_id: d4 }).first(), undefined);

  // Quick setup (letsencrypt on, auto monitor).
  await db('domains').where({ id: d3 }).update({ tls_mode: 'none' });
  hooks.length = 0;
  // Turning Let's Encrypt on goes through the domain module: domains.manage is needed too, checked before the host exists.
  const hostsBefore = Number(((await db('proxy_hosts').where({ account_id: acct }).count('* as n').first()) as { n: string | number }).n);
  r = await call('POST', '/proxy/hosts/quick-setup', asProxyOnly, { stackId: S1, service: 'web', port: 8080, domainIds: [d3] });
  assert.equal(r.status, 403, 'quick setup switching TLS needs domains.manage');
  assert.equal(Number(((await db('proxy_hosts').where({ account_id: acct }).count('* as n').first()) as { n: string | number }).n), hostsBefore);
  r = await call('POST', '/proxy/hosts/quick-setup', asManager, { stackId: S1, service: 'web', port: 8080, domainIds: [d3] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const hq = r.body.data;
  assert.equal(hq.autoMonitor, true);
  assert.equal(hq.options.websocket, true);
  assert.equal(hq.options.blockExploits, true);
  assert.equal(((await db('domains').where({ id: d3 }).first('tls_mode')) as { tls_mode: string }).tls_mode, 'letsencrypt');
  assert.ok(hooks.includes(`cert ${d3}`) && hooks.includes(`monitor ${hq.id}`));
  r = await call('POST', '/proxy/hosts/quick-setup', asOther, { stackId: S1, service: 'web', port: 8080, domainIds: [dOther] });
  assert.equal(r.status, 404, 'a stack of another account is invisible');

  // ── redirections / dead hosts (maxRedirections 2, both kinds) ──────────────
  r = await call('POST', '/proxy/redirections', asManager, { accountId: acct, domainIds: [d4], targetDomain: `vault-${suffix}.fr`, statusCode: 302 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const rd = r.body.data;
  assert.equal(rd.statusCode, 302);
  assert.equal(await servedBy(d4), 'redirect');
  r = await call('POST', '/proxy/redirections', asManager, { accountId: acct, domainIds: [d5], targetDomain: `five-${suffix}.fr` });
  assert.equal(r.status, 400, 'self loop refused');
  // The domain of another account is never read for the loop check (L4: no id → name oracle).
  r = await call('POST', '/proxy/redirections', asManager, { accountId: acct, domainIds: [dOther], targetDomain: `other-${suffix}.fr` });
  assert.equal(r.status, 404, JSON.stringify(r.body));
  assert.equal(r.body.code, 'domainNotInAccount');
  r = await call('POST', '/proxy/dead-hosts', asManager, { accountId: acct, domainIds: [d5] });
  assert.equal(r.status, 201);
  const dh = r.body.data;
  assert.equal(await servedBy(d5), 'dead');
  r = await call('POST', '/proxy/dead-hosts', asManager, { accountId: acct, domainIds: [dRouted] });
  assert.equal(r.status, 409);
  const d6 = await mkDomain(acct, `six-${suffix}.fr`, true);
  r = await call('POST', '/proxy/dead-hosts', asManager, { accountId: acct, domainIds: [d6] });
  assert.equal(r.status, 409);
  assert.equal(r.body.details.dimension, 'redirections');
  r = await call('PUT', `/proxy/redirections/${rd.id}`, asManager, { preservePath: false, targetPath: '/x' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.targetPath, '/x');
  r = await call('GET', `/proxy/dead-hosts/${dh.id}`, asOther);
  assert.equal(r.status, 404);

  // ── streams (staff only, approved ports, one per port / protocol) ─────────
  const streamBody = { accountId: acct, name: 'pg', incomingPort: 5432, tcp: true, target: { kind: 'app', stackId: S2, service: 'db', port: 5432, scheme: 'http' } };
  r = await call('POST', '/proxy/streams', asManager, streamBody);
  assert.equal(r.status, 403, 'streams are staff-only');
  r = await call('GET', '/proxy/streams', asManager);
  assert.equal(r.status, 403);
  r = await call('POST', '/proxy/streams', asAdmin, { ...streamBody, incomingPort: 6000 });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'streamPortNotApproved');
  r = await call('POST', '/proxy/streams', asAdmin, { ...streamBody, udp: true });
  assert.equal(r.status, 400, '5432/udp not approved');
  r = await call('POST', '/proxy/streams', asAdmin, streamBody);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const st = r.body.data;
  r = await call('POST', '/proxy/streams', asAdmin, { ...streamBody, name: 'again' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'streamPortTaken');
  r = await call('POST', '/proxy/streams', asAdmin, { accountId: null, name: 'dns', incomingPort: 2053, tcp: false, udp: true, target: ext('93.184.216.34', { port: 53, scheme: 'http' }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const stPlatform = r.body.data;
  assert.equal(stPlatform.accountId, null);
  r = await call('GET', '/proxy/stream-ports', asAdmin);
  assert.deepEqual(r.body.data, [{ port: 5432, protocol: 'tcp', usedBy: st.id }, { port: 2053, protocol: 'udp', usedBy: stPlatform.id }]);
  r = await call('GET', `/proxy/streams/${stPlatform.id}`, asStaffB);
  assert.equal(r.status, 404, 'a platform stream of another tenant');

  // ── access lists ──────────────────────────────────────────────────────────
  r = await call('POST', '/proxy/access-lists', asManager, {
    accountId: acct, name: 'team', rules: [{ action: 'allow', cidr: '203.0.113.0/24' }], users: [{ username: 'alice', password: 'correct horse 1' }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const al = r.body.data;
  assert.deepEqual(al.users, [{ username: 'alice' }], 'never a hash');
  assert.ok(!JSON.stringify(r.body).includes('$6$'));
  r = await call('POST', '/proxy/access-lists', asManager, { accountId: acct, name: 'team' });
  assert.equal(r.status, 409);
  r = await call('POST', '/proxy/access-lists', asManager, { accountId: acct, name: 'bad', rules: [{ action: 'allow', cidr: 'all' }] });
  assert.equal(r.status, 400);
  r = await call('PUT', `/proxy/access-lists/${al.id}`, asManager, { users: [{ username: 'alice2', previousUsername: 'alice' }] });
  assert.equal(r.status, 200);
  const stored = (await db('access_lists').where({ id: al.id }).first('users')) as { users: Array<{ username: string; hash: string }> };
  assert.equal(stored.users[0].username, 'alice2');
  assert.ok(verifyAccessPassword('correct horse 1', stored.users[0].hash), 'rename keeps the password');
  r = await call('POST', '/proxy/access-lists', asOther, { accountId: other, name: 'foreign' });
  const foreignList = r.body.data;
  r = await call('PUT', `/proxy/hosts/${h1.id}`, asManager, { auth: { accessListIds: [foreignList.id] } });
  assert.equal(r.status, 404, 'an access list of another account');
  r = await call('PUT', `/proxy/hosts/${h1.id}`, asManager, { auth: { accessListIds: [al.id] }, honeypot: { enabled: true, paths: ['/wp-login.php'], banAclViolations: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.auth.accessListIds, [al.id]);
  r = await call('GET', `/proxy/access-lists/${al.id}`, asReader);
  assert.equal(r.body.data.usedBy, 1);
  r = await call('DELETE', `/proxy/access-lists/${al.id}`, asManager);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'accessListInUse');

  // ── custom pages ──────────────────────────────────────────────────────────
  r = await call('POST', '/proxy/custom-pages', asManager, { accountId: null, name: 'platform', html: '<p>x</p>' });
  assert.equal(r.status, 403, 'platform pages are staff-only');
  r = await call('POST', '/proxy/custom-pages', asAdmin, { accountId: null, name: 'platform 404', codes: [404], html: '<h1>{{CODE}} {{HOST}}</h1>' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const platformPage = r.body.data;
  r = await call('POST', '/proxy/custom-pages', asManager, { accountId: acct, name: 'mine', codes: [404, 999], html: 'x' });
  assert.equal(r.status, 400);
  r = await call('POST', '/proxy/custom-pages', asManager, { accountId: acct, name: 'mine', codes: [502], html: 'down', isWakingPage: true });
  assert.equal(r.status, 201);
  const myPage = r.body.data;
  r = await call('GET', '/proxy/custom-pages', asReader);
  assert.ok(r.body.data.some((p: { id: number }) => p.id === platformPage.id), 'a client sees the platform pages (read-only)');
  r = await call('GET', '/proxy/custom-pages', asStaffB);
  assert.ok(!r.body.data.some((p: { id: number }) => p.id === myPage.id));
  r = await call('PUT', `/proxy/custom-pages/${platformPage.id}`, asManager, { name: 'hijack' });
  assert.equal(r.status, 404, 'a client never changes a platform page');
  r = await call('PUT', `/proxy/dead-hosts/${dh.id}`, asManager, { customPageId: platformPage.id });
  assert.equal(r.status, 200, 'a client USES a platform page');
  r = await call('POST', '/proxy/custom-pages', asOther, { accountId: other, name: 'theirs', html: 'x' });
  const theirPage = r.body.data;
  r = await call('PUT', `/proxy/hosts/${h1.id}`, asManager, { options: { errorPageId: theirPage.id } });
  assert.equal(r.status, 404, 'a page of another account');
  r = await call('PUT', `/proxy/hosts/${h1.id}`, asManager, { options: { wakingPageId: myPage.id } });
  assert.equal(r.status, 200);
  r = await call('DELETE', `/proxy/custom-pages/${platformPage.id}`, asAdmin);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'customPageInUse');
  r = await call('POST', '/proxy/custom-pages/preview', asReader, { html: '{{CODE}} {{HOST}}', code: 503, host: '<b>' });
  assert.equal(r.body.data.html, '503 &#60;b&#62;');

  // ── auth providers ────────────────────────────────────────────────────────
  const providerBody = { accountId: acct, name: 'entra', azureTenantId: '11111111-2222-3333-4444-555555555555', clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
  r = await call('POST', '/proxy/auth-providers', asManager, providerBody);
  assert.equal(r.status, 400, 'secret required at creation');
  r = await call('POST', '/proxy/auth-providers', asManager, { ...providerBody, clientSecret: 'very-secret-value', allowedGroups: ['g1'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ap = r.body.data;
  assert.equal(ap.hasSecret, true);
  assert.ok(!JSON.stringify(r.body).includes('very-secret-value'));
  const sealed = (await db('auth_providers').where({ id: ap.id }).first('client_secret_sealed')) as { client_secret_sealed: string };
  assert.ok(!sealed.client_secret_sealed.includes('very-secret-value'), 'sealed at rest');
  r = await call('PUT', `/proxy/hosts/${h1.id}`, asManager, { auth: { authProviderId: ap.id, allowedEmails: ['boss@acme.fr'] } });
  assert.equal(r.status, 400, 'forward-auth over a list with users (basic auth) would loop on the 401');
  assert.equal(r.body.code, 'forwardAuthWithUsers');
  r = await call('POST', '/proxy/access-lists', asManager, { accountId: acct, name: 'office', rules: [{ action: 'allow', cidr: '203.0.113.0/24' }] });
  assert.equal(r.status, 201);
  const alIp = r.body.data;
  r = await call('PUT', `/proxy/hosts/${h1.id}`, asManager, { auth: { accessListIds: [alIp.id], authProviderId: ap.id, allowedEmails: ['boss@acme.fr'] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('PUT', `/proxy/access-lists/${alIp.id}`, asManager, { users: [{ username: 'eve', password: 'correct horse 2' }] });
  assert.equal(r.status, 409, 'a list under forward-auth never gets users');
  assert.equal(r.body.code, 'forwardAuthWithUsers');
  r = await call('GET', `/proxy/auth-providers/${ap.id}`, asReader);
  assert.deepEqual(r.body.data.redirectUris, [`https://vault-${suffix}.fr/oauth2/callback`, `https://www.vault-${suffix}.fr/oauth2/callback`]);
  assert.equal(r.body.data.usedBy, 1);
  r = await call('DELETE', `/proxy/auth-providers/${ap.id}`, asManager);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'authProviderInUse');
  r = await call('POST', '/proxy/auth-providers', asOther, { ...providerBody, accountId: other, clientSecret: 'x' });
  const foreignProvider = r.body.data;
  r = await call('PUT', `/proxy/hosts/${h1.id}`, asManager, { auth: { authProviderId: foreignProvider.id } });
  assert.equal(r.status, 404, 'a provider of another account');

  // ── certificates ──────────────────────────────────────────────────────────
  const good = await selfSigned([`shop.vault-${suffix}.fr`, `vault-${suffix}.fr`]);
  const foreign = await selfSigned([`other-${suffix}.fr`]);
  r = await call('POST', '/proxy/certificates/import', asManager, { accountId: acct, name: 'shop', certificatePem: foreign.cert, privateKeyPem: foreign.key });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'certificateNamesNotOwned');
  r = await call('POST', '/proxy/certificates/import', asManager, { accountId: acct, name: 'shop', certificatePem: good.cert, privateKeyPem: foreign.key });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'certificateInvalid');
  r = await call('POST', '/proxy/certificates/import', asManager, { accountId: acct, name: 'shop', certificatePem: good.cert, privateKeyPem: good.key });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ic = r.body.data;
  assert.ok(fs.existsSync(path.join(localPaths.edgeCerts(), `imported-${ic.id}`, 'privkey.pem')));
  const icRow = (await db('imported_certificates').where({ id: ic.id }).first('private_key_sealed')) as { private_key_sealed: string };
  assert.ok(!icRow.private_key_sealed.includes('PRIVATE KEY'), 'key sealed');
  r = await call('PUT', `/proxy/hosts/${h1.id}`, asManager, { ssl: { mode: 'imported', importedCertificateId: ic.id } });
  assert.equal(r.status, 200);
  await db('certificates').insert({ domain_id: d2, primary_name: `two-${suffix}.fr`, names: JSON.stringify([`two-${suffix}.fr`]), status: 'valid', not_after: new Date(Date.now() + 86400_000 * 60) });
  r = await call('GET', '/proxy/certificates', asReader);
  const acmeItem = r.body.data.find((c: { kind: string; domainId: number }) => c.kind === 'acme' && c.domainId === d2);
  assert.deepEqual(acmeItem.usedBy, [{ kind: 'proxy-host', id: h2.id, name: 'renamed' }]);
  const impItem = r.body.data.find((c: { kind: string; id: number }) => c.kind === 'imported' && c.id === ic.id);
  assert.equal(impItem.status, 'valid');
  assert.equal(impItem.usedBy[0].id, h1.id);
  r = await call('GET', '/proxy/certificates', asOther);
  assert.ok(!r.body.data.some((c: { accountId: number }) => c.accountId === acct));
  r = await call('DELETE', `/proxy/certificates/imported/${ic.id}`, asManager);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'certificateInUse');

  // ── edge unit provider ────────────────────────────────────────────────────
  r = await call('PUT', `/proxy/hosts/${h2.id}`, asAdmin, { target: ext('public.example.com') });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  fs.mkdirSync(path.join(localPaths.edgeCerts(), `two-${suffix}.fr`), { recursive: true });
  const claimed = new Set([`www.vault-${suffix}.fr`]);
  const units = await buildProxyUnits({
    platform: { panel: 'panel.example.net', previewDomain: null, dbAdmin: null, probeV4: null, probeV6: null },
    panelUpstream: 'https://oblimint-panel:8443',
    certificates: await db('certificates').select('domain_id', 'site_id', 'primary_name', 'status', 'names'),
    certFilesExist: (n) => n === `two-${suffix}.fr`,
    claimed,
    streamPorts: [{ port: 5432, protocol: 'tcp' }, { port: 2053, protocol: 'udp' }],
  });
  const byId = new Map(units.map((u) => [u.id, u]));
  assert.equal(units[0].id, 'g-proxy');
  assert.ok(units[0].config.includes(`zone=ph_${h1.id}:1m rate=10r/s`));
  const u1 = byId.get(`ph-${h1.id}`)!;
  assert.deepEqual(u1.serverNames, [`vault-${suffix}.fr`], 'claimed www name dropped');
  assert.ok(u1.config.includes(`/etc/nginx/oblimint/certs/imported-${ic.id}/fullchain.pem`));
  assert.ok(u1.config.includes(`set $oblimint_fa_auth "http://oblimint-oauth2-${ap.id}:4180/oauth2/auth?allowed_groups=`) === false, 'host groups empty');
  assert.ok(u1.config.includes('allowed_emails=boss@acme.fr'));
  assert.ok(u1.config.includes('allow 203.0.113.0/24;'));
  assert.ok(!u1.files.htpasswd, 'IP rules only under forward-auth');
  assert.ok(u1.files['pages/waking.html'] === 'down', 'waking page of a sleeping app target');
  assert.ok(u1.config.includes('add_header X-Staff 1;'), 'advancedConfig rendered (setting on)');
  const u2 = byId.get(`ph-${h2.id}`)!;
  assert.ok(u2.config.includes(`ssl_certificate /etc/nginx/oblimint/certs/two-${suffix}.fr/fullchain.pem;`));
  assert.ok(u2.config.includes('set $oblimint_up "https://93.184.216.34:443";'), 'PX2: the name pinned to its validated address');
  assert.ok(!u2.config.includes('"https://public.example.com'));
  assert.ok(u2.config.includes('proxy_ssl_name public.example.com;'));
  assert.ok(byId.get(`rd-${rd.id}`)!.config.includes(`return 301 https://$host$request_uri;`) || byId.get(`rd-${rd.id}`)!.config.includes('return 302'));
  assert.ok(byId.get(`dh-${dh.id}`)!.files['pages/404.html'].includes(`five-${suffix}.fr`));
  assert.equal(byId.get(`st-${st.id}`)!.scope, 'stream');
  assert.ok(byId.get(`st-${stPlatform.id}`)!.config.includes('listen 2053 udp;'));
  for (const u of units) for (const m of u.config.matchAll(/proxy_pass\s+([^;\s]+);/g)) assert.match(m[1], /^\$/);
  const build = async () => new Map((await buildProxyUnits({
    platform: { panel: null, previewDomain: null, dbAdmin: null, probeV4: null, probeV6: null }, panelUpstream: 'x', certificates: [],
    certFilesExist: () => false, claimed: new Set(), streamPorts: [],
  })).map((u) => [u.id, u as typeof u & { invalidReason?: string | null }]));
  // Periodic re-check: same answer = nothing; a rebinding to a private address = edge sync, unit invalid (last good kept).
  hooks.length = 0;
  assert.equal(await recheckExternalTargets(), false);
  publicAddress = '10.9.8.7';
  assert.equal(await recheckExternalTargets(), true);
  assert.ok(hooks.some((h) => h.startsWith('edge ')), 'edge sync asked');
  let rebuilt = await build();
  assert.ok(rebuilt.get(`ph-${h2.id}`)!.invalidReason, 'refused address: invalid unit (edge keeps the last good version)');
  assert.equal(rebuilt.get(`ph-${h2.id}`)!.config, '');
  assert.ok(rebuilt.get(`ph-${h2.id}`)!.serverNames.includes(`two-${suffix}.fr`), 'names still claimed');
  assert.match(proxyUnitProblem(`ph-${h2.id}`)!.message, /refused address/);
  r = await call('GET', `/proxy/hosts/${h2.id}`, asManager);
  assert.match(r.body.data.edge.error, /refused address/, 'the problem is shown on the object');
  publicAddress = '93.184.216.34';
  // Policy turned off after the save: disabled (503 stub keeping the names).
  externalAllowed = false;
  rebuilt = await build();
  assert.equal(rebuilt.get(`ph-${h2.id}`)!.disabled, true);
  assert.match(proxyUnitProblem(`ph-${h2.id}`)!.message, /no longer allowed/);
  externalAllowed = true;
  // Suspended account → disabled; unverified domain → not served.
  await db('hosting_accounts').where({ id: acct }).update({ status: 'suspended' });
  await db('domains').where({ id: d2 }).update({ verification_status: 'pending' });
  const again = new Map((await buildProxyUnits({
    platform: { panel: null, previewDomain: null, dbAdmin: null, probeV4: null, probeV6: null }, panelUpstream: 'x', certificates: [],
    certFilesExist: () => false, claimed: new Set(), streamPorts: [],
  })).map((u) => [u.id, u]));
  assert.equal(again.get(`ph-${h1.id}`)!.disabled, true);
  assert.ok(!again.has(`ph-${h2.id}`), 'D1: unverified domain never served');
  await db('hosting_accounts').where({ id: acct }).update({ status: 'active' });
  await db('domains').where({ id: d2 }).update({ verification_status: 'verified' });

  // ── internal contracts ────────────────────────────────────────────────────
  const targets = await proxyContracts.policyTargets(acct);
  assert.ok(targets.some((x) => x.kind === 'app' && x.stackId === S1 && x.port === 8080 && x.via === 'host'));
  assert.ok(targets.some((x) => x.kind === 'site' && x.siteId === siteId && x.port === 8080 && x.via === 'route'));
  assert.ok(targets.some((x) => x.kind === 'app' && x.stackId === S2 && x.via === 'stream'));
  assert.ok(!targets.some((x) => x.accountId !== acct));
  assert.ok((await proxyContracts.policyTargets(null)).length >= targets.length);
  const summary = await proxyContracts.hostSummary(h1.id);
  assert.deepEqual(summary, { id: h1.id, accountId: acct, tenantId: tA, name: 'vault2', domains: [`vault-${suffix}.fr`], enabled: true });
  assert.equal(await proxyContracts.hostSummary(999999), null);
  const targeting = await proxyContracts.hostsTargetingStack(S1);
  assert.deepEqual(targeting.map((x) => x.id).sort(), [h1.id, hq.id].sort());
  await proxyContracts.stackDeleted(S1);
  assert.equal(((await db('proxy_hosts').where({ id: h1.id }).first('enabled')) as { enabled: boolean }).enabled, false);
  assert.ok(!(await proxyContracts.policyTargets(acct)).some((x) => x.stackId === S1), 'disabled hosts leave the policy');
  await proxyContracts.stackDeleted(S2);
  assert.equal(((await db('proxy_streams').where({ id: st.id }).first('enabled')) as { enabled: boolean }).enabled, false);

  // ── forward-auth sidecars (FakeDocker) ────────────────────────────────────
  await convergeAuth(() => undefined);
  assert.ok(docker.networks.has('oblimint-auth'));
  assert.ok(docker.containers.has('oblimint-auth-redis'));
  const sidecar = docker.containers.get(`oblimint-oauth2-${ap.id}`)!;
  assert.ok(sidecar, 'sidecar created');
  assert.equal(sidecar.state, 'running');
  assert.ok(!('oblimint.account' in sidecar.labels));
  assert.ok(sidecar.spec!.Env!.includes(`OAUTH2_PROXY_WHITELIST_DOMAINS=vault-${suffix}.fr,www.vault-${suffix}.fr`));
  assert.ok(sidecar.spec!.Env!.includes('OAUTH2_PROXY_CLIENT_SECRET=very-secret-value'));
  assert.ok(docker.containers.has(`oblimint-oauth2-${foreignProvider.id}`));
  assert.deepEqual(sidecarStateOf(ap.id), { deployed: true, running: true, detail: null });
  const created = docker.calls.filter((c) => c.startsWith('create ')).length;
  await convergeAuth(() => undefined);
  assert.equal(docker.calls.filter((c) => c.startsWith('create ')).length, created, 'idempotent: nothing recreated');
  r = await call('DELETE', `/proxy/auth-providers/${foreignProvider.id}`, asOther);
  assert.equal(r.status, 200);
  await convergeAuth(() => undefined);
  assert.ok(!docker.containers.has(`oblimint-oauth2-${foreignProvider.id}`), 'sidecar of a deleted provider removed');
  assert.ok(docker.containers.has(`oblimint-oauth2-${ap.id}`));

  // ── deletions put served_by back ──────────────────────────────────────────
  r = await call('DELETE', `/proxy/redirections/${rd.id}`, asManager);
  assert.equal(r.status, 200);
  assert.equal(await servedBy(d4), 'sites');
  r = await call('DELETE', `/proxy/dead-hosts/${dh.id}`, asManager);
  assert.equal(await servedBy(d5), 'sites');
  r = await call('DELETE', `/proxy/access-lists/${al.id}?force=1`, asManager);
  assert.equal(r.status, 200);
  assert.equal(await db('proxy_host_access_lists').where({ access_list_id: al.id }).first(), undefined);
  // Domain deletion cascades its binding.
  await db('domains').where({ id: d3 }).del();
  assert.equal(await db('edge_domain_bindings').where({ domain_id: d3 }).first(), undefined);
});
