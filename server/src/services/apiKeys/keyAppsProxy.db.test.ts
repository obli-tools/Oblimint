import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// Docker applications and proxy hosts through an access key (keyStacks.ts,
// keyProxy.ts; REST /api/v1/apps/stacks…, /api/v1/proxy-hosts…; MCP
// list_apps, deploy_app, update_app, app_action, app_logs, delete_app,
// create_proxy_host, update_proxy_host, delete_proxy_host…) on a real
// PostgreSQL: KEYAPPS_TEST_DATABASE_URL (default: the PGlite harness on port
// 55495; skipped when nothing listens). Docker = FakeAppDocker (apps deps),
// edge / certificates / monitors = recording fakes (proxy deps); the apps
// worker's deploy jobs and the proxy contract of the apps module are real.
// Covers: the scopes (absent: 403; opt-in; the creator's apps.manage /
// proxy.manage + domains.manage), the perimeter (another account / tenant:
// 404; a domain not given: 403), the compose rules and the plan limits, the
// suspended and contained account, the .env and git secrets (never in a
// reply, the audit nor a pending action; masked in the logs), the proxy host
// « domain → application:internal port » with Let's Encrypt and the https
// redirection (and the subdomain made on the fly, removed again when the host
// cannot be saved), the gates (app.delete, proxy.host_delete: a pending
// action the owner confirms, then the same call runs once).
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.KEYAPPS_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55495/postgres';

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

test('Docker applications and proxy hosts through an access key (REST + MCP)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-keyapps-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_P4B_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.OBLIMINT_SELF_CONTAINER = 'oblimint';
  process.env.SESSION_SECRET ||= 'keyapps-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const v1Routes = (await import('../../routes/v1.routes')).default;
  const { mcpRouter } = await import('./mcp');
  const { actorForUser } = await import('../hosting/access');
  const { apiKeysService } = await import('./apiKeys.service');
  const { keyStacks } = await import('./keyStacks');
  const { keyProxy } = await import('./keyProxy');
  const { appsService } = await import('../apps/apps.service');
  const { proxyHostsService } = await import('../proxy/hosts.service');
  const { restrictionService } = await import('../restrictions/restriction.service');
  const { twoFactorService } = await import('../twoFactor.service');
  const { DEFAULT_PLAN_LIMITS, defaultRestrictionsFor } = await import('@oblimint/shared');
  const { setEngineFactoryForTests } = await import('../docker/engine');
  const { setAppsDepsForTests } = await import('../apps/deps');
  const { FakeAppDocker, fakeAppsDeps } = await import('../apps/testing/fakeAppDocker');
  const { whenStackIdle, setUpdateStableMsForTests } = await import('../apps/deployments');
  const { setProxyDepsForTests } = await import('../proxy/deps');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // ── fakes: Docker (apps + engine), git, the edge / certificates / monitors of the proxy ──
  const docker = new FakeAppDocker();
  docker.addContainer({ name: 'oblimint' });
  docker.addContainer({ name: 'oblimint-edge' });
  const D1 = `sha256:${'1'.repeat(64)}`;
  docker.remote.set('docker.io/library/nginx:1.27', D1);
  const localNode = await db('nodes').where({ is_local: true }).first('id') as { id: number };
  setEngineFactoryForTests(() => docker.asDocker(), localNode.id);
  const fake = fakeAppsDeps(docker);
  // The real proxy contract of the apps module (proxy hosts targeting a stack: stackInUse).
  const { proxy: _fakeProxy, ...appsDeps } = fake.deps;
  const gitCalls: Array<{ args: string[]; env: Record<string, string> }> = [];
  const gitCompose = 'services:\n  api:\n    image: nginx:1.27\n    expose: ["9000"]\n';
  setAppsDepsForTests({
    ...appsDeps,
    async git(args, opts) {
      gitCalls.push({ args, env: opts.env });
      if (args.includes('ls-remote')) return { code: 0, stdout: `${'c'.repeat(40)}\trefs/heads/main\n`, stderr: '' };
      if (args.includes('clone')) {
        const dest = path.join(opts.cwd!, args[args.length - 1]);
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
        fs.writeFileSync(path.join(dest, 'docker-compose.yml'), gitCompose);
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
    async probeTcp() { return true; },
    async probeHttp() { return true; },
  });
  setUpdateStableMsForTests(0);
  const hooks: string[] = [];
  setProxyDepsForTests({
    async unitStates() { return new Map(); },
    syncAutoMonitor(id) { hooks.push(`monitor ${id}`); },
    requestPolicySync(reason) { hooks.push(`policy ${reason}`); },
    scheduleEdgeSync(reason) { hooks.push(`edge ${reason}`); },
    ensureCertificate(id) { hooks.push(`cert ${id}`); },
    authChanged(reason) { hooks.push(`auth ${reason}`); },
    async allowExternalTargets() { return false; },
    async lookup() { return [{ address: '93.184.216.34', family: 4 }]; },
    async dockerSubnets() { return ['172.30.0.0/16']; },
    async nodeAddresses() { return []; },
  });
  t.after(() => {
    setEngineFactoryForTests(null);
    setAppsDepsForTests(null);
    setUpdateStableMsForTests(null);
    setProxyDepsForTests(null);
  });

  // ── fixtures: tenant A (accounts acme, other), tenant B ──
  const suffix = Date.now().toString(36);
  const idOf = (r: unknown) => Number((r as { id?: number }).id ?? r);
  const tenant = async (n: string) => idOf((await db('tenants').insert({ name: `K ${n} ${suffix}`, slug: `k-${n}-${suffix}` }).returning('id'))[0]);
  const tA = await tenant('a');
  const tB = await tenant('b');
  const mkUser = async (name: string, tenantId: number, totp: boolean) => {
    const id = idOf((await db('users').insert({
      username: `${name}-${suffix}`, kind: 'client', role: 'user', is_active: true, password_hash: 'x',
      ...(totp ? { totp_enabled: true, totp_secret: twoFactorService.generateTotpSecret(`${name}-${suffix}`).secret } : {}),
    }).returning('id'))[0]);
    await db('user_tenants').insert({ user_id: id, tenant_id: tenantId, role: 'client' });
    return id;
  };
  const owner = await mkUser('appowner', tA, true);
  const siteOnly = await mkUser('sitesonly', tA, false);
  const noDomains = await mkUser('nodomains', tA, false);
  const otherUser = await mkUser('otheruser', tA, false);
  const bUser = await mkUser('buser', tB, false);
  const limits = { ...DEFAULT_PLAN_LIMITS, maxAppStacks: 3, maxAppContainers: 6, appsCpuCores: 4, appsMemoryMb: 2048, appsPidsPerContainer: 256, maxProxyHosts: 2 };
  const mkAccount = async (tenantId: number, name: string) => {
    const planId = idOf((await db('plans').insert({ tenant_id: tenantId, name: `p-${name}-${suffix}`, limits: JSON.stringify(limits) }).returning('id'))[0]);
    const uid = 20000 + Math.floor(Math.random() * 30000);
    return idOf((await db('hosting_accounts').insert({
      tenant_id: tenantId, node_id: localNode.id, plan_id: planId, username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
      network_model: 'segmented',
    }).returning('id'))[0]);
  };
  const acme = await mkAccount(tA, 'kacme');
  const other = await mkAccount(tA, 'kother');
  const bAcct = await mkAccount(tB, 'kbacct');
  const mkDomain = async (tenantId: number, accountId: number, name: string) => idOf((await db('domains').insert({
    tenant_id: tenantId, account_id: accountId, name, kind: 'primary', include_www: false, tls_mode: 'none', force_https: false,
    verification_status: 'verified', verification_method: 'txt', verified_at: db.fn.now(),
  }).returning('id'))[0]);
  const appDomain = `app-${suffix}.example.com`;
  const parentDomain = `parent-${suffix}.example.com`;
  const notGiven = `notgiven-${suffix}.example.com`;
  const otherDomain = `other-${suffix}.example.com`;
  const dApp = await mkDomain(tA, acme, appDomain);
  const dParent = await mkDomain(tA, acme, parentDomain);
  const dNotGiven = await mkDomain(tA, acme, notGiven);
  await mkDomain(tA, other, otherDomain);
  await db('account_users').insert([
    { user_id: owner, account_id: acme, capabilities: JSON.stringify(['sites.manage', 'apps.manage', 'proxy.manage', 'domains.manage']) },
    { user_id: siteOnly, account_id: acme, capabilities: JSON.stringify(['sites.manage']) },
    { user_id: noDomains, account_id: acme, capabilities: JSON.stringify(['sites.manage', 'apps.manage', 'proxy.manage']) },
    { user_id: otherUser, account_id: other, capabilities: JSON.stringify(['apps.manage']) },
    { user_id: bUser, account_id: bAcct, capabilities: JSON.stringify(['apps.manage']) },
  ]);
  await restrictionService.setMap(tA, {});

  const fakeReq = (userId: number) => ({ headers: {}, query: {}, session: { userId }, socket: { remoteAddress: '203.0.113.9' } }) as never;
  const ownerActor = await actorForUser(owner, tA);
  const mkKey = async (name: string, scopes: string[], extra: Record<string, unknown> = {}) =>
    apiKeysService.create(fakeReq(owner), ownerActor, acme, { name, siteScope: 'all', scopes, ...extra } as never);
  const kApps = await mkKey('apps', ['apps.manage']);
  const kRead = await mkKey('apps-read', ['apps.read']);
  const kProxy = await mkKey('proxy', ['proxy.manage', 'apps.read', 'domains.subdomain'], { domainScope: 'selected', domainIds: [dApp, dParent] });
  const kLogs = await mkKey('logs', ['logs.read']);
  const ctxOf = async (k: { key: string | null }) => (await apiKeysService.verify(k.key!, '203.0.113.9'))!;

  // Applications of another account and of another tenant (made by their own users through the service).
  const otherApp = await appsService.create(fakeReq(otherUser), await actorForUser(otherUser, tA), {
    accountId: other, name: 'theirs', sourceType: 'editor', composeYaml: 'services:\n  web:\n    image: nginx:1.27\n    expose: ["8080"]\n', deploy: false,
  });
  const foreignApp = await appsService.create(fakeReq(bUser), await actorForUser(bUser, tB), {
    accountId: bAcct, name: 'foreign', sourceType: 'editor', composeYaml: 'services:\n  web:\n    image: nginx:1.27\n    expose: ["8080"]\n', deploy: false,
  });

  // ── HTTP ──
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1', v1Routes);
  app.use('/mcp', mcpRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  type Json = { success?: boolean; data?: any; code?: string; details?: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const rest = async (key: { key: string | null }, method: string, p: string, body?: unknown) => {
    const r = await fetch(`${base}/api/v1${p}`, {
      method, headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() as Json };
  };
  const tool = async (key: { key: string | null }, name: string, args: Record<string, unknown>) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const j = await r.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    return { isError: j.result.isError === true, text: j.result.content[0].text };
  };
  const detailsOf = (text: string) => JSON.parse(text.slice(text.indexOf('details: ') + 9)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const auditText = async () => JSON.stringify(await db('audit_logs').where({ tenant_id: tA }).select('action', 'details'));
  const pendingText = async () => JSON.stringify(await db('pending_actions').where({ tenant_id: tA }).select());
  const lastAudit = async (action: string) => {
    const row = await db('audit_logs').where({ action, tenant_id: tA }).orderBy('id', 'desc').first('details');
    return row ? (typeof row.details === 'string' ? JSON.parse(row.details) : row.details) as Record<string, any> : null; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const approve = (pid: number) => db('pending_actions').where({ id: pid }).update({
    status: 'approved', decided_by: owner, decided_at: db.fn.now(), decided_via: 'totp', consume_by: new Date(Date.now() + 15 * 60_000),
  });
  const pendingOf = async (action: string) => db('pending_actions').where({ tenant_id: tA, action_key: action }).select('id', 'status');

  // ── the scopes: opt-in, absent → 403, granted only by who holds the rights ──
  let r = await rest(kLogs, 'GET', '/apps/stacks');
  assert.deepEqual([r.status, r.body.code], [403, 'keyScope'], 'no apps scope');
  let m = await tool(kLogs, 'deploy_app', { name: 'nope', source: 'compose', compose_yaml: 'services: {}' });
  assert.match(m.text, /\(keyScope\)/);
  m = await tool(kRead, 'deploy_app', { name: 'nope', source: 'compose', compose_yaml: 'services: {}' });
  assert.match(m.text, /\(keyScope\)/, 'apps.read never deploys');
  m = await tool(kApps, 'list_proxy_hosts', {});
  assert.match(m.text, /\(keyScope\)/, 'apps.manage is not proxy.manage');
  r = await rest(kLogs, 'POST', '/proxy-hosts', { domains: [appDomain], target: { appName: 'web', port: 8080 } });
  assert.deepEqual([r.status, r.body.code], [403, 'keyScope']);
  await assert.rejects(apiKeysService.create(fakeReq(siteOnly), await actorForUser(siteOnly, tA), acme, { name: 'x1', siteScope: 'all', scopes: ['apps.manage'] } as never),
    (e: { statusCode: number; code: string }) => e.statusCode === 403 && e.code === 'capabilityNotHeld', 'no apps.manage: the scope cannot be granted');
  await assert.rejects(apiKeysService.create(fakeReq(noDomains), await actorForUser(noDomains, tA), acme, { name: 'x2', siteScope: 'all', scopes: ['proxy.manage'] } as never),
    (e: { statusCode: number; code: string; details: { missing: string[] } }) => e.statusCode === 403 && e.code === 'capabilityNotHeld' && e.details.missing.includes('proxy.manage'),
    'proxy.manage needs domains.manage too');
  const grantable = await apiKeysService.grantable(await actorForUser(noDomains, tA), acme);
  assert.ok(grantable.scopes.includes('apps.manage') && !grantable.scopes.includes('proxy.manage'));

  // ── deploy (REST, compose): secrets in the .env only, the deploy runs in the background ──
  const SECRET = 'tok-0f9e8d7c6b5a-secret';
  const COMPOSE = 'services:\n  web:\n    image: nginx:1.27\n    expose: ["8080"]\n    environment:\n      API_TOKEN: ${API_TOKEN:?}\n      MODE: ${MODE}\n';
  r = await rest(kApps, 'POST', '/apps/stacks', { name: 'bad', source: 'compose', composeYaml: 'services:\n  web:\n    image: nginx:1.27\n    privileged: true\n' });
  assert.deepEqual([r.status, r.body.code], [400, 'composeInvalid'], 'the compose rules of the panel');
  r = await rest(kApps, 'POST', '/apps/stacks', { name: 'evil', source: 'compose', composeYaml: 'services:\n  web:\n    image: registry.evil.example/x/y:1\n' });
  assert.deepEqual([r.status, r.body.code], [400, 'imageNotAllowed'], 'the image policy');
  r = await rest(kApps, 'POST', '/apps/stacks', { name: 'bad-env', source: 'compose', composeYaml: COMPOSE, env: { 'BAD-NAME': 'x' } });
  assert.deepEqual([r.status, r.body.code], [400, 'validation']);
  r = await rest(kApps, 'POST', '/apps/stacks', { name: 'web', displayName: 'Web', source: 'compose', composeYaml: COMPOSE, env: { API_TOKEN: SECRET, MODE: 'prod' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const webId = r.body.data.app.id as number;
  assert.ok(r.body.data.deployment && r.body.data.deployment.action === 'deploy', 'deployed at once');
  assert.deepEqual(r.body.data.app.envKeys.sort(), ['API_TOKEN', 'MODE']);
  assert.ok(!JSON.stringify(r.body).includes(SECRET), 'never a value of the .env');
  await whenStackIdle(webId);
  r = await rest(kRead, 'GET', `/apps/stacks/${webId}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.status, 'running', JSON.stringify(r.body.data.statusMessage));
  assert.deepEqual(r.body.data.services.map((s: { name: string; exposedPorts: unknown }) => [s.name, s.exposedPorts]), [['web', [{ port: 8080, protocol: 'tcp' }]]]);
  assert.equal(r.body.data.deployments[0].status, 'succeeded');
  assert.ok(!JSON.stringify(r.body).includes(SECRET));
  assert.ok(docker.containers.get(`oblimint-app-${webId}-web`), 'the container exists');
  let audit = await lastAudit('apps.stack.create');
  assert.deepEqual([audit?.name, audit?.apiKey?.id], ['web', kApps.id], 'audited with the key');
  assert.deepEqual([...(audit?.envKeys ?? [])].sort(), ['API_TOKEN', 'MODE']);

  // ── listing: the account's applications only, the plan's limits ──
  m = await tool(kRead, 'list_apps', {});
  assert.equal(m.isError, false, m.text);
  const list = JSON.parse(m.text);
  assert.deepEqual(list.apps.map((a: { name: string }) => a.name), ['web'], 'never another account or tenant');
  assert.equal(list.resources.limits.stacks, 3);
  assert.equal(list.resources.used.stacks, 1);
  m = await tool(kRead, 'list_app_catalog', {});
  assert.equal(m.isError, false, m.text);
  assert.ok(Array.isArray(JSON.parse(m.text)));

  // ── the perimeter: another account, another tenant → 404 ──
  for (const id of [otherApp.id, foreignApp.id]) {
    r = await rest(kApps, 'GET', `/apps/stacks/${id}`);
    assert.deepEqual([r.status, r.body.code], [404, 'notFound'], `app ${id}`);
    m = await tool(kApps, 'app_action', { app_id: id, action: 'stop' });
    assert.match(m.text, /\(notFound\)/);
    m = await tool(kApps, 'delete_app', { app_id: id, confirm_name: 'theirs' });
    assert.match(m.text, /\(notFound\)/);
  }
  m = await tool(kApps, 'get_app', { app_name: 'theirs' });
  assert.match(m.text, /\(notFound\)/, 'by name too');

  // ── logs: the .env secrets masked ──
  docker.logsText = `2024-01-01T00:00:00.000000000Z boot with token=${SECRET}\n`;
  m = await tool(kRead, 'app_logs', { app_name: 'web' });
  assert.equal(m.isError, false, m.text);
  assert.ok(!m.text.includes(SECRET), 'masked');
  assert.match(m.text, /token=\*{8}/);
  const depId = (await rest(kRead, 'GET', `/apps/stacks/${webId}`)).body.data.deployments[0].id as number;
  r = await rest(kRead, 'GET', `/apps/stacks/${webId}/logs?deploymentId=${depId}&tail=50`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.data.lines.length > 0 && r.body.data.deploymentStatus === 'succeeded');
  assert.ok(!JSON.stringify(r.body).includes(SECRET));

  // ── git source with a token: sealed, never returned, audited nor in a pending action ──
  const GIT_TOKEN = 'ghp-very-secret-token-0123456789';
  m = await tool(kApps, 'deploy_app', { name: 'gitapp', source: 'git', git: { repo_url: 'https://git.example.com/acme/api.git', token: GIT_TOKEN } });
  assert.equal(m.isError, false, m.text);
  const gitApp = JSON.parse(m.text);
  assert.equal(gitApp.app.git.hasToken, true);
  assert.ok(!m.text.includes(GIT_TOKEN));
  await whenStackIdle(gitApp.app.id);
  assert.ok(gitCalls.length > 0, 'the repository was read');

  // ── plan limits: 3 applications ──
  m = await tool(kApps, 'deploy_app', { name: 'second', source: 'compose', compose_yaml: COMPOSE, env: { API_TOKEN: SECRET }, deploy: false });
  assert.equal(m.isError, false, m.text);
  assert.equal(JSON.parse(m.text).deployment, null, 'a draft');
  m = await tool(kApps, 'deploy_app', { name: 'third', source: 'compose', compose_yaml: COMPOSE, deploy: false });
  assert.match(m.text, /\(planLimit\)/);
  assert.equal(detailsOf(m.text).dimension, 'appStacks');

  // ── change: env_set keeps the other variables, redeploy ──
  m = await tool(kApps, 'update_app', { app_name: 'web', env_set: { MODE: 'staging' }, redeploy: true });
  assert.equal(m.isError, false, m.text);
  const upd = JSON.parse(m.text);
  assert.deepEqual(upd.app.envKeys.sort(), ['API_TOKEN', 'MODE'], 'API_TOKEN kept');
  assert.ok(upd.deployment && upd.deployment.action === 'redeploy');
  await whenStackIdle(webId);
  const sealed = (await db('app_stacks').where({ id: webId }).first('env_sealed')).env_sealed as string;
  assert.ok(!sealed.includes(SECRET) && !sealed.includes('staging'), 'sealed');
  m = await tool(kApps, 'update_app', { app_name: 'web', env: { A: 'b' }, env_unset: ['MODE'] });
  assert.match(m.text, /\(validation\)/, 'env alone, or env_set / env_unset');

  // ── start / stop ──
  m = await tool(kApps, 'app_action', { app_id: webId, action: 'stop' });
  assert.equal(m.isError, false, m.text);
  await whenStackIdle(webId);
  assert.equal((await db('app_stacks').where({ id: webId }).first('status')).status, 'stopped');
  m = await tool(kApps, 'app_action', { app_id: webId, action: 'start' });
  assert.equal(m.isError, false, m.text);
  await whenStackIdle(webId);
  assert.equal((await db('app_stacks').where({ id: webId }).first('status')).status, 'running');
  m = await tool(kApps, 'app_action', { app_id: webId, action: 'restart', service: 'ghost' });
  assert.match(m.text, /\(serviceNotFound\)/);

  // ── suspended account: nothing starts ──
  await db('hosting_accounts').where({ id: acme }).update({ status: 'suspended' });
  m = await tool(kApps, 'app_action', { app_id: webId, action: 'start' });
  assert.match(m.text, /\(accountSuspended\)/);
  r = await rest(kApps, 'POST', '/apps/stacks', { name: 'while-suspended', source: 'compose', composeYaml: COMPOSE, deploy: false });
  assert.deepEqual([r.status, r.body.code], [409, 'accountSuspended']);
  await db('hosting_accounts').where({ id: acme }).update({ status: 'active' });

  // ── contained account: the key answers 423, and the services refuse a key still in hand ──
  const liveApps = await ctxOf(kApps);
  const liveProxy = await ctxOf(kProxy);
  await db('hosting_accounts').where({ id: acme }).update({ contained_at: new Date() });
  r = await rest(kApps, 'GET', '/apps/stacks');
  assert.deepEqual([r.status, r.body.code], [423, 'accountContained']);
  for (const op of [
    () => keyStacks.deploy(liveApps, fakeReq(owner), { name: 'contained', source: 'compose', composeYaml: COMPOSE, deploy: false }),
    () => keyStacks.action(liveApps, fakeReq(owner), { id: webId }, { action: 'restart' }),
    () => keyStacks.remove(liveApps, fakeReq(owner), { id: webId }, { confirmName: 'web' }),
    () => keyProxy.create(liveProxy, fakeReq(owner), { domains: [appDomain], target: { appId: webId, service: 'web', port: 8080 } }),
  ]) await assert.rejects(op(), (e: { statusCode: number }) => e.statusCode === 423);
  await db('hosting_accounts').where({ id: acme }).update({ contained_at: null });

  // ── proxy host: domain → application:internal port, Let's Encrypt and https ──
  m = await tool(kProxy, 'create_proxy_host', { domains: [appDomain], app_name: 'web', service: 'web', port: 9999 });
  assert.match(m.text, /\(targetPortNotExposed\)/, 'an internal port the service exposes');
  m = await tool(kProxy, 'create_proxy_host', { domains: [notGiven], app_name: 'web', service: 'web', port: 8080 });
  assert.match(m.text, /\(keyDomainNotManageable\)/, 'a domain not given to the key');
  m = await tool(kProxy, 'create_proxy_host', { domains: [otherDomain], app_name: 'web', service: 'web', port: 8080 });
  assert.ok(m.isError && /\((notASubdomain|domainNotInAccount)\)/.test(m.text), m.text);
  m = await tool(kProxy, 'create_proxy_host', { domains: [appDomain], app_id: otherApp.id, service: 'web', port: 8080 });
  assert.match(m.text, /\(notFound\)/, 'an application of another account');
  m = await tool(kProxy, 'create_proxy_host', { domains: [appDomain], host: '10.1.2.3', port: 80 });
  assert.match(m.text, /\(targetNotAllowed\)/, 'external targets: plan / policy');
  hooks.length = 0;
  m = await tool(kProxy, 'create_proxy_host', { domains: [appDomain], app_name: 'web', service: 'web', port: 8080 });
  assert.equal(m.isError, false, m.text);
  const host1 = JSON.parse(m.text);
  assert.deepEqual([host1.ssl.mode, host1.ssl.forceSsl, host1.ssl.http2, host1.ssl.hsts], ['auto', true, true, true], 'SSL asked by default');
  assert.deepEqual([host1.target.kind, host1.target.appId, host1.target.appName, host1.target.service, host1.target.port], ['app', webId, 'web', 'web', 8080]);
  assert.deepEqual(host1.urls, [`https://${appDomain}/`]);
  assert.equal(host1.manageable, true);
  assert.equal((await db('domains').where({ id: dApp }).first('tls_mode', 'served_by')).tls_mode, 'letsencrypt', 'Let\'s Encrypt turned on');
  assert.equal((await db('domains').where({ id: dApp }).first('served_by')).served_by, 'proxy');
  assert.ok(hooks.includes(`cert ${dApp}`), 'the certificate is asked');
  assert.ok(hooks.some((h) => h.startsWith('edge ')) && hooks.includes(`monitor ${host1.id}`), 'edge sync + monitor');
  audit = await lastAudit('proxy.host.create');
  assert.deepEqual([audit?.apiKey?.id, audit?.target], [kProxy.id, 'app']);
  r = await rest(kRead, 'GET', `/apps/stacks/${webId}`);
  assert.deepEqual(r.body.data.urls, [`https://${appDomain}/`], 'the application knows its URL');

  // A subdomain made on the fly (domains.subdomain): created, verified from its parent, bound.
  const sub = `api.${parentDomain}`;
  r = await rest(kProxy, 'POST', '/proxy-hosts', { domains: [sub], target: { appName: 'web', port: 8080 }, websocket: false });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const host2 = r.body.data;
  assert.equal(host2.options.websocket, false);
  const subRow = await db('domains').where({ name: sub }).first('id', 'account_id', 'verification_status', 'served_by', 'tls_mode');
  assert.deepEqual([subRow.account_id, subRow.verification_status, subRow.served_by, subRow.tls_mode], [acme, 'verified', 'proxy', 'letsencrypt']);
  assert.ok(await db('api_key_domains').where({ key_id: kProxy.id, domain_id: subRow.id, created_by_key: true }).first(), 'the key\'s own subdomain');
  // Plan: 2 proxy hosts. The subdomain made for a refused host goes away again.
  const sub3 = `www.${parentDomain}`;
  m = await tool(kProxy, 'create_proxy_host', { domains: [sub3], app_name: 'web', port: 8080 });
  assert.match(m.text, /\(planLimit\)/);
  assert.equal(detailsOf(m.text).dimension, 'proxyHosts');
  assert.equal(await db('domains').where({ name: sub3 }).first('id'), undefined, 'no stray subdomain');

  // A host of the panel on a domain not given to the key: listed, never changed by it.
  await db('proxy_hosts').where({ id: host2.id }).del();
  await db('edge_domain_bindings').where({ kind: 'proxy', ref_id: host2.id }).del();
  await db('domains').where({ id: subRow.id }).update({ served_by: 'sites' });
  const panelHost = await proxyHostsService.create(fakeReq(owner), ownerActor, {
    accountId: acme, name: 'panel-host', domainIds: [dNotGiven], target: { kind: 'app', stackId: webId, service: 'web', port: 8080, scheme: 'http' },
  });
  m = await tool(kProxy, 'list_proxy_hosts', {});
  const hostsSeen = JSON.parse(m.text) as Array<{ id: number; manageable: boolean }>;
  assert.deepEqual(hostsSeen.map((h) => [h.id, h.manageable]).sort(), [[host1.id, true], [panelHost.id, false]].sort());
  m = await tool(kProxy, 'update_proxy_host', { proxy_host_id: panelHost.id, websocket: false });
  assert.match(m.text, /\(keyDomainNotManageable\)/);
  m = await tool(kProxy, 'update_proxy_host', { proxy_host_id: host1.id, websocket: false, read_timeout_sec: 120 });
  assert.equal(m.isError, false, m.text);
  assert.deepEqual([JSON.parse(m.text).options.websocket, JSON.parse(m.text).options.readTimeoutSec, JSON.parse(m.text).ssl.mode], [false, 120, 'auto']);
  await db('proxy_hosts').where({ id: panelHost.id }).del();
  await db('edge_domain_bindings').where({ kind: 'proxy', ref_id: panelHost.id }).del();

  // ── deletions: refused before any request while a proxy host targets the application ──
  m = await tool(kApps, 'delete_app', { app_name: 'web', confirm_name: 'web' });
  assert.match(m.text, /\(stackInUse\)/, 'delete the proxy hosts first');
  m = await tool(kApps, 'delete_app', { app_name: 'web', confirm_name: 'wrong' });
  assert.match(m.text, /\(confirmMismatch\)/);
  r = await rest(kApps, 'DELETE', `/apps/stacks/${webId}?force=1`, { confirmName: 'web' });
  assert.deepEqual([r.status, r.body.code], [409, 'stackInUse'], 'never ?force through a key');
  assert.deepEqual(await pendingOf('app.delete'), [], 'nobody was asked');

  // ── the default protections: the key's owner confirms, then the same call runs once ──
  await restrictionService.setMap(tA, defaultRestrictionsFor(false));
  m = await tool(kProxy, 'delete_proxy_host', { proxy_host_id: host1.id });
  assert.match(m.text, /\(twoFactorRequired\)/);
  let d = detailsOf(m.text);
  assert.equal(d.action, 'proxy.host_delete');
  assert.ok(await db('proxy_hosts').where({ id: host1.id }).first(), 'nothing ran');
  r = await rest(kProxy, 'DELETE', `/proxy-hosts/${host1.id}`);
  assert.deepEqual([r.status, r.body.code, Number(r.body.details?.pendingActionId)], [428, 'twoFactorRequired', Number(d.pendingActionId)], 'the same request');
  await approve(Number(d.pendingActionId));
  m = await tool(kProxy, 'delete_proxy_host', { proxy_host_id: host1.id, approval_id: Number(d.pendingActionId) });
  assert.equal(m.isError, false, m.text);
  assert.equal(await db('proxy_hosts').where({ id: host1.id }).first('id'), undefined);
  assert.equal((await db('pending_actions').where({ id: Number(d.pendingActionId) }).first('status')).status, 'consumed');
  assert.equal((await db('domains').where({ id: dApp }).first('served_by')).served_by, 'sites', 'the domain is free again');
  m = await tool(kProxy, 'delete_proxy_host', { proxy_host_id: host1.id });
  assert.match(m.text, /\(notFound\)/, 'ran once');

  m = await tool(kApps, 'delete_app', { app_name: 'web', confirm_name: 'web', remove_volumes: true });
  assert.match(m.text, /\(twoFactorRequired\)/);
  d = detailsOf(m.text);
  assert.equal(d.action, 'app.delete');
  assert.ok(String(d.description).startsWith('Supprimer l’application Docker « web »'), String(d.description));
  assert.ok(await db('app_stacks').where({ id: webId }).first('id'), 'nothing ran');
  m = await tool(kApps, 'delete_app', { app_name: 'web', confirm_name: 'web' });
  assert.match(m.text, /\(twoFactorRequired\)/);
  assert.notEqual(Number(detailsOf(m.text).pendingActionId), Number(d.pendingActionId), 'other arguments, another request');
  await approve(Number(d.pendingActionId));
  r = await rest(kApps, 'DELETE', `/apps/stacks/${webId}`, { confirmName: 'web', removeVolumes: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, { deleted: true, id: webId, name: 'web' });
  assert.equal(await db('app_stacks').where({ id: webId }).first('id'), undefined);
  assert.equal((await db('pending_actions').where({ id: Number(d.pendingActionId) }).first('status')).status, 'consumed');
  assert.ok(!docker.containers.has(`oblimint-app-${webId}-web`), 'its container is gone');
  audit = await lastAudit('apps.stack.delete');
  assert.deepEqual([audit?.name, audit?.removeVolumes, audit?.apiKey?.id], ['web', true, kApps.id]);
  m = await tool(kApps, 'get_app', { app_id: webId });
  assert.match(m.text, /\(notFound\)/);

  // ── secrets: never in the audit nor in a pending action ──
  const auditAll = await auditText();
  const pendingAll = await pendingText();
  for (const s of [SECRET, GIT_TOKEN]) {
    assert.ok(!auditAll.includes(s), 'never audited');
    assert.ok(!pendingAll.includes(s), 'never in a pending action');
  }

  // ── the creator loses a right: the scope is inactive at once ──
  await db('account_users').where({ user_id: owner, account_id: acme }).update({ capabilities: JSON.stringify(['sites.manage', 'apps.manage', 'proxy.manage']) });
  m = await tool(kProxy, 'list_proxy_hosts', {});
  assert.match(m.text, /\(keyScope\)/, 'proxy.manage without domains.manage');
  await db('account_users').where({ user_id: owner, account_id: acme }).update({ capabilities: JSON.stringify(['sites.manage']) });
  r = await rest(kApps, 'GET', '/apps/stacks');
  assert.deepEqual([r.status, r.body.code], [403, 'keyScope']);
  r = await rest(kRead, 'GET', '/apps/stacks');
  assert.equal(r.status, 200, 'apps.read only needs the membership');
});
