import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of apps-core on a PGlite server (docs/P4b-PLAN.md §15:
// apps-core = port 55471):  PG_PORT=55471 node <scratchpad>/pg/pgserver.mjs
// APPS_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. Docker = FakeAppDocker, other modules = recording fakes, registry
// = fake fetch. Covers: migrations 001–007, CRUD through the routes,
// isolation (other account / tenant, missing capability, god view), plan
// limits (stacks, memory sum), deployments (deploy, stop, start, redeploy,
// rollback, cancel guard), sealed .env (audited read, never in details),
// registries (ids of another account refused), catalog (builtins seeded,
// tenant templates, builtins read-only, catalog deploy), validation preview
// with lines, updates (digest check, notify once, apply, image rollback,
// auto-update gated by the maintenance window), delete guard (stackInUse,
// force), policy (platform admin only), teardown hook + tombstone purge.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.APPS_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55471/postgres';

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

test('apps-core on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55471)`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-apps-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_P4B_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'apps-core-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const appsRoutes = (await import('../../routes/apps.routes')).default;
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');
  const { setAppsDepsForTests } = await import('./deps');
  const { FakeAppDocker, fakeAppsDeps } = await import('./testing/fakeAppDocker');
  const { whenStackIdle, whenAllIdle, setUpdateStableMsForTests } = await import('./deployments');
  const { runUpdatePass } = await import('./updates');
  const { appsTeardownHook } = await import('./teardownHook');
  const { purgeTombstones } = await import('./worker');
  const { platformSettings } = await import('../platformSettings');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // 007 objects exist.
  for (const table of ['tenant_app_policies', 'app_registry_credentials', 'app_templates', 'app_stacks', 'app_stack_credentials', 'app_services', 'app_deployments', 'app_image_pulls', 'app_volume_tombstones']) {
    assert.ok(await db.schema.hasTable(table), table);
  }

  // ── fakes ──────────────────────────────────────────────────────────────────
  const docker = new FakeAppDocker();
  const D1 = `sha256:${'1'.repeat(64)}`;
  const D2 = `sha256:${'2'.repeat(64)}`;
  const D3 = `sha256:${'3'.repeat(64)}`;
  docker.remote.set('docker.io/library/nginx:1.27', D1);
  let remoteDigest = D2;
  let windowOpen = true;
  let targeting: Array<{ id: number; name: string; domains: string[]; service: string; port: number }> = [];
  const fetches: string[] = [];
  const fake = fakeAppsDeps(docker, {
    async maintenanceOpen() { return windowOpen; },
    fetch: (async (input: string | URL) => {
      fetches.push(String(input));
      return new Response(null, { status: 200, headers: { 'docker-content-digest': remoteDigest } });
    }) as typeof fetch,
  });
  const gitCalls: Array<{ args: string[]; env: Record<string, string> }> = [];
  let gitCompose = 'services:\n  app:\n    image: nginx:1.27\n    expose: ["80"]\n';
  const GIT_SHA = 'c'.repeat(40);
  let lsSha = GIT_SHA;
  const overrides: Partial<import('./deps').AppsDeps> = {
    ...fake.deps,
    proxy: {
      async hostsTargetingStack() { return targeting; },
      async stackDeleted(stackId) { fake.events.push(`proxy-deleted ${stackId}`); },
    },
    async git(args, opts) {
      gitCalls.push({ args, env: opts.env });
      if (args.includes('ls-remote')) return { code: 0, stdout: `${lsSha}\trefs/heads/main\n`, stderr: '' };
      if (args.includes('clone')) {
        const dest = path.join(opts.cwd!, args[args.length - 1]);
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
        fs.mkdirSync(path.join(dest, 'deploy'), { recursive: true });
        fs.writeFileSync(path.join(dest, 'deploy', 'compose.yml'), gitCompose);
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
    async probeTcp() { return true; },
    async probeHttp() { return true; },
  };
  setAppsDepsForTests(overrides);
  setUpdateStableMsForTests(0);
  t.after(() => { setAppsDepsForTests(null); setUpdateStableMsForTests(null); });

  // ── fixtures ───────────────────────────────────────────────────────────────
  const suffix = Date.now().toString(36);
  const [tenantA] = await db('tenants').insert({ name: `A ${suffix}`, slug: `a-${suffix}` }).returning('id');
  const [tenantB] = await db('tenants').insert({ name: `B ${suffix}`, slug: `b-${suffix}` }).returning('id');
  const tA = Number(tenantA.id ?? tenantA);
  const tB = Number(tenantB.id ?? tenantB);
  const user = async (username: string, kind: 'staff' | 'client', role: 'admin' | 'user', tenantId: number) => {
    const [row] = await db('users').insert({ username: `${username}-${suffix}`, kind, role, is_active: true }).returning('id');
    const id = Number(row.id ?? row);
    await db('user_tenants').insert({ user_id: id, tenant_id: tenantId, role: kind === 'staff' ? 'admin' : 'user' });
    return id;
  };
  const staffA = await user('sta', 'staff', 'admin', tA);
  const staffB = await user('stb', 'staff', 'admin', tB);
  const clientRead = await user('cr', 'client', 'user', tA);
  const clientManage = await user('cm', 'client', 'user', tA);
  const clientOther = await user('co', 'client', 'user', tA);
  const platformAdmin = await user('pa', 'staff', 'admin', 1);

  const localNode = await db('nodes').where({ is_local: true }).first('id') as { id: number };
  const limits = { ...DEFAULT_PLAN_LIMITS, maxAppStacks: 3, maxAppContainers: 6, appsCpuCores: 4, appsMemoryMb: 2048, appsPidsPerContainer: 256 };
  const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify(limits) }).returning('id');
  const planId = Number(plan.id ?? plan);
  const mkAccount = async (name: string, networkModel: 'segmented' | 'legacy' = 'segmented') => {
    const uid = 20000 + Math.floor(Math.random() * 30000);
    const [acct] = await db('hosting_accounts').insert({
      tenant_id: tA, node_id: localNode.id, plan_id: planId, username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
      network_model: networkModel,
    }).returning('id');
    return Number(acct.id ?? acct);
  };
  const acct = await mkAccount('acme');
  const other = await mkAccount('other');
  await db('account_users').insert([
    { user_id: clientRead, account_id: acct, capabilities: JSON.stringify([]) },
    { user_id: clientManage, account_id: acct, capabilities: JSON.stringify(['apps.manage']) },
    { user_id: clientOther, account_id: other, capabilities: JSON.stringify(['apps.manage']) },
  ]);

  // ── app ────────────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: Number(req.header('x-user')) };
    (req as unknown as { tenantId: number }).tenantId = Number(req.header('x-tenant'));
    next();
  });
  app.use('/apps', appsRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  type Who = { user: number; tenant: number };
  const call = async (method: string, url: string, who: Who, body?: unknown) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-user': String(who.user), 'x-tenant': String(who.tenant) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as { success: boolean; data?: any; code?: string; error?: string; details?: any } };
  };
  const asReader: Who = { user: clientRead, tenant: tA };
  const asManager: Who = { user: clientManage, tenant: tA };
  const asOther: Who = { user: clientOther, tenant: tA };
  const asStaffA: Who = { user: staffA, tenant: tA };
  const asStaffB: Who = { user: staffB, tenant: tB };
  const asAdmin: Who = { user: platformAdmin, tenant: 1 };

  const COMPOSE = `services:
  web:
    image: nginx:1.27
    ports: ["8080:80"]
    environment:
      API_TOKEN: \${API_TOKEN:?}
      MODE: prod
    volumes: ["html:/usr/share/nginx/html"]
volumes:
  html: {}
`;
  const SECRET = 'tok-abcdef-123456-secret';

  // ── create: access ─────────────────────────────────────────────────────────
  const createBody = { accountId: acct, name: 'site-web', sourceType: 'editor', composeYaml: COMPOSE, env: `API_TOKEN=${SECRET}\n` };
  let r = await call('POST', '/apps/stacks', asReader, createBody);
  assert.equal(r.status, 403, 'member without apps.manage');
  r = await call('POST', '/apps/stacks', asOther, createBody);
  assert.equal(r.status, 404, 'client of another account');
  r = await call('POST', '/apps/stacks', asStaffB, createBody);
  assert.equal(r.status, 404, 'staff of another tenant');
  r = await call('POST', '/apps/stacks', asManager, { ...createBody, name: 'Bad Name' });
  assert.equal(r.status, 400);
  r = await call('POST', '/apps/stacks', asManager, { ...createBody, composeYaml: 'services:\n  web:\n    image: nginx\n    privileged: true\n' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'composeInvalid');
  assert.equal(r.body.details.issues[0].line, 4);
  r = await call('POST', '/apps/stacks', asManager, { ...createBody, composeYaml: 'services:\n  web:\n    image: registry.evil.example/x/y:1\n' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'imageNotAllowed');
  r = await call('POST', '/apps/stacks', asManager, { ...createBody, composeYaml: 'services:\n  web:\n    build: .\n' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'buildNotAllowed');

  // ── create + deploy ────────────────────────────────────────────────────────
  r = await call('POST', '/apps/stacks', asManager, createBody);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const stackId = r.body.data.id as number;
  assert.deepEqual(r.body.data.envKeys, ['API_TOKEN']);
  assert.ok(!JSON.stringify(r.body).includes(SECRET), 'the .env value is never returned');
  await whenStackIdle(stackId);
  r = await call('GET', `/apps/stacks/${stackId}`, asReader);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'running', JSON.stringify(r.body.data.statusMessage));
  assert.equal(r.body.data.services[0].name, 'web');
  assert.equal(r.body.data.services[0].currentDigest, D1);
  assert.equal(r.body.data.services[0].state, 'running');
  assert.ok(!JSON.stringify(r.body).includes(SECRET));
  const container = docker.containers.get(`oblimint-app-${stackId}-web`)!;
  assert.ok(container, 'container created');
  assert.equal(container.spec!.HostConfig!.PortBindings, undefined, 'never published');
  assert.deepEqual(container.spec!.HostConfig!.CapDrop, ['ALL']);
  assert.equal(container.labels['oblimint.account'], String(acct));
  assert.equal(container.image, `docker.io/library/nginx@${D1}`);
  assert.ok(docker.volumes.has(`oblimint-app-${stackId}-html`));
  assert.ok(fs.statSync(path.join(dataRoot, 'accounts', String(acct), 'apps', String(stackId), 'volumes', 'html')).isDirectory());
  assert.ok(await db('app_image_pulls').where({ account_id: acct, image: 'docker.io/library/nginx:1.27' }).first(), 'AP6 pull recorded');
  const stackRow = await db('app_stacks').where({ id: stackId }).first();
  assert.ok(stackRow.env_sealed.startsWith('v1:') && !stackRow.env_sealed.includes(SECRET), 'sealed');
  r = await call('GET', `/apps/stacks/${stackId}/deployments`, asReader);
  assert.equal(r.body.data.total, 1);
  const dep1 = r.body.data.items[0];
  assert.equal(dep1.status, 'succeeded');
  assert.equal(dep1.canRollback, true);
  r = await call('GET', `/apps/stacks/${stackId}/deployments/${dep1.id}`, asReader);
  assert.ok(r.body.data.log.length > 2);
  assert.ok(!JSON.stringify(r.body.data).includes(SECRET), 'log and effective YAML redacted');
  assert.match(r.body.data.effectiveYaml, /cap_drop/);
  assert.ok(fake.events.includes('policy apps') && fake.events.includes('edge apps'));

  // ── isolation / lists ──────────────────────────────────────────────────────
  r = await call('GET', `/apps/stacks/${stackId}`, asOther);
  assert.equal(r.status, 404);
  r = await call('GET', `/apps/stacks/${stackId}`, asStaffB);
  assert.equal(r.status, 404);
  r = await call('PUT', `/apps/stacks/${stackId}`, asReader, { displayName: 'x' });
  assert.equal(r.status, 403);
  r = await call('GET', '/apps/stacks', asOther);
  assert.deepEqual(r.body.data, []);
  r = await call('GET', `/apps/stacks?accountId=${acct}`, asOther);
  assert.deepEqual(r.body.data, [], 'another account id in the query shows nothing');
  r = await call('GET', '/apps/stacks', asStaffB);
  assert.deepEqual(r.body.data, []);
  r = await call('GET', `/apps/stacks?tenantId=${tA}`, asAdmin);
  assert.equal(r.body.data.length, 1, 'god view');
  assert.equal(r.body.data[0].runningCount, 1);
  r = await call('GET', '/apps/stacks', asReader);
  assert.equal(r.body.data.length, 1);

  // ── .env read audited ──────────────────────────────────────────────────────
  r = await call('GET', `/apps/stacks/${stackId}/env`, asReader);
  assert.equal(r.status, 403);
  r = await call('GET', `/apps/stacks/${stackId}/env`, asManager);
  assert.equal(r.body.data.env.trim(), `API_TOKEN=${SECRET}`);
  const envAudit = await db('audit_logs').where({ action: 'apps.stack.env.read', resource_path: String(stackId) }).first('details');
  assert.ok(envAudit && !JSON.stringify(envAudit.details).includes(SECRET));
  const allAudit = await db('audit_logs').where('action', 'like', 'apps.%').select('details');
  assert.ok(!JSON.stringify(allAudit).includes(SECRET), 'no secret in any audit row');

  // ── inspect masks secrets; logs ────────────────────────────────────────────
  r = await call('GET', `/apps/stacks/${stackId}/containers/web/inspect`, asReader);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.env.find((e: { key: string }) => e.key === 'API_TOKEN'), { key: 'API_TOKEN', value: null });
  assert.deepEqual(r.body.data.env.find((e: { key: string }) => e.key === 'MODE'), { key: 'MODE', value: 'prod' });
  docker.logsText = '2024-01-01T00:00:00.000000000Z hello\n';
  r = await call('GET', `/apps/stacks/${stackId}/containers/web/logs?tail=10`, asReader);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.lines[0].text, 'hello');
  r = await call('GET', `/apps/stacks/${stackId}/containers/ghost/logs`, asReader);
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'serviceNotFound');

  // ── validate preview ───────────────────────────────────────────────────────
  r = await call('POST', '/apps/validate', asManager, { accountId: acct, composeYaml: 'services:\n  a:\n    image: nginx\n    volumes: ["/etc:/x"]\n' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.ok, false);
  assert.equal(r.body.data.issues[0].code, 'absoluteBind');
  assert.equal(r.body.data.issues[0].line, 4);
  r = await call('POST', '/apps/validate', asOther, { accountId: acct, composeYaml: COMPOSE });
  assert.equal(r.status, 404);
  r = await call('POST', '/apps/validate', asManager, { accountId: acct, composeYaml: COMPOSE, stackId });
  assert.equal(r.body.data.ok, true, 'existing stack: its sealed .env is used');

  // ── plan limits ────────────────────────────────────────────────────────────
  r = await call('POST', '/apps/stacks', asManager, { ...createBody, name: 'big', composeYaml: 'services:\n  a:\n    image: nginx\n    mem_limit: 1900m\n' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'planLimit');
  assert.equal(r.body.details.dimension, 'appsMemory');
  r = await call('POST', '/apps/stacks', asManager, { ...createBody, name: 'site-web' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'stackNameTaken');
  r = await call('POST', '/apps/stacks', asManager, { accountId: acct, name: 'two', sourceType: 'editor', composeYaml: 'services:\n  a:\n    image: nginx:1.27\n', deploy: false });
  assert.equal(r.status, 201);
  const stack2 = r.body.data.id as number;
  assert.equal(r.body.data.status, 'draft');
  r = await call('POST', '/apps/stacks', asManager, { accountId: acct, name: 'three', sourceType: 'zip' });
  assert.equal(r.status, 201);
  const stack3 = r.body.data.id as number;
  r = await call('POST', '/apps/stacks', asManager, { accountId: acct, name: 'four', sourceType: 'zip' });
  assert.equal(r.status, 409);
  assert.equal(r.body.details.dimension, 'appStacks');
  r = await call('PUT', `/apps/stacks/${stack3}`, asManager, { composeYaml: 'services:\n  a:\n    image: nginx\n' });
  assert.equal(r.status, 200, 'zip stacks accept a compose edit');
  r = await call('PUT', `/apps/stacks/${stackId}`, asManager, { git: { repoUrl: 'https://git.example.com/r' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'sourceTypeMismatch');
  r = await call('GET', `/apps/resources?accountId=${acct}`, asReader);
  assert.deepEqual(r.body.data.used, { stacks: 3, containers: 3, cpus: 1.5, memoryMb: 768 });
  assert.equal(r.body.data.limits.stacks, 3);
  r = await call('DELETE', `/apps/stacks/${stack3}`, asManager, { confirm: 'three' });
  assert.equal(r.status, 200);

  // ── registries ─────────────────────────────────────────────────────────────
  r = await call('POST', '/apps/registries', asOther, { accountId: other, registry: 'ghcr.io', username: 'bot', password: 'p4ss-registry' });
  assert.equal(r.status, 201);
  const otherCred = r.body.data.id as number;
  assert.equal(r.body.data.password, undefined);
  r = await call('POST', '/apps/registries', asManager, { accountId: acct, registry: 'https://index.docker.io/v1/', username: 'me', password: 'p4ss-hub' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.registry, 'docker.io');
  const myCred = r.body.data.id as number;
  r = await call('PUT', `/apps/stacks/${stack2}`, asManager, { registryCredentialIds: [otherCred] });
  assert.equal(r.status, 404, 'a credential of another account is never accepted');
  r = await call('PUT', `/apps/stacks/${stack2}`, asManager, { registryCredentialIds: [myCred] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.registryCredentialIds, [myCred]);
  r = await call('GET', '/apps/registries', asManager);
  assert.deepEqual(r.body.data.map((c: { id: number }) => c.id), [myCred]);
  r = await call('DELETE', `/apps/registries/${otherCred}`, asManager);
  assert.equal(r.status, 404);
  const credRow = await db('app_registry_credentials').where({ id: myCred }).first();
  assert.ok(!credRow.password_sealed.includes('p4ss-hub'));

  // ── actions ────────────────────────────────────────────────────────────────
  r = await call('POST', `/apps/stacks/${stackId}/actions`, asManager, { action: 'stop' });
  assert.equal(r.status, 202);
  await whenStackIdle(stackId);
  r = await call('GET', `/apps/stacks/${stackId}`, asReader);
  assert.equal(r.body.data.status, 'stopped');
  assert.equal(r.body.data.desiredState, 'stopped');
  r = await call('POST', `/apps/stacks/${stackId}/actions`, asManager, { action: 'start' });
  await whenStackIdle(stackId);
  r = await call('GET', `/apps/stacks/${stackId}`, asReader);
  assert.equal(r.body.data.status, 'running');
  // busy: a second action while one runs
  docker.pullGate = new Promise(() => undefined);
  r = await call('POST', `/apps/stacks/${stackId}/actions`, asManager, { action: 'redeploy' });
  assert.equal(r.status, 202);
  const busyDep = r.body.data.id as number;
  r = await call('POST', `/apps/stacks/${stackId}/actions`, asManager, { action: 'restart' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'stackBusy');
  r = await call('DELETE', `/apps/stacks/${stackId}`, asManager, { confirm: 'site-web' });
  assert.equal(r.status, 409);
  r = await call('POST', `/apps/stacks/${stackId}/deployments/${busyDep}/cancel`, asManager);
  assert.equal(r.body.data.cancelled, true);
  docker.pullGate = null;
  await whenStackIdle(stackId);
  r = await call('GET', `/apps/stacks/${stackId}/deployments/${busyDep}`, asReader);
  assert.equal(r.body.data.status, 'cancelled');

  // ── updates ────────────────────────────────────────────────────────────────
  r = await call('POST', `/apps/stacks/${stackId}/updates/check`, asManager);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.services.map((s: { updateAvailable: boolean; latestDigest: string }) => [s.updateAvailable, s.latestDigest]), [[true, D2]]);
  assert.ok(fetches.some((u) => u === 'https://registry-1.docker.io/v2/library/nginx/manifests/1.27'));
  assert.equal(fake.events.filter((e) => e.startsWith('notify app.updateAvailable')).length, 1);
  r = await call('POST', `/apps/stacks/${stackId}/updates/check`, asManager);
  assert.equal(r.status, 429, '1 check per minute');
  r = await call('POST', `/apps/stacks/${stackId}/updates/apply`, asManager, {});
  assert.equal(r.status, 202);
  await whenStackIdle(stackId);
  let svc = await db('app_services').where({ stack_id: stackId, name: 'web' }).first();
  assert.equal(svc.current_digest, D2);
  assert.equal(svc.previous_digest, D1);
  assert.equal(docker.containers.get(`oblimint-app-${stackId}-web`)!.image, `docker.io/library/nginx@${D2}`);
  assert.ok(fake.events.some((e) => e.startsWith('notify app.updated')));
  r = await call('POST', `/apps/stacks/${stackId}/updates/rollback`, asManager, { service: 'web' });
  assert.equal(r.status, 202);
  await whenStackIdle(stackId);
  svc = await db('app_services').where({ stack_id: stackId, name: 'web' }).first();
  assert.equal(svc.current_digest, D1);
  assert.equal(svc.previous_digest, D2);
  r = await call('POST', `/apps/stacks/${stackId}/updates/rollback`, asManager, { service: 'ghost' });
  assert.equal(r.body.code, 'serviceNotFound');

  // a manual image rollback sticks: auto-update (window open) does not re-apply the digest rolled back from
  await db('app_stacks').where({ id: stackId }).update({ update_policy: JSON.stringify({ autoUpdate: true, checkIntervalMin: 60, maintenanceWindowId: null, notify: true }), last_update_check_at: null });
  const autoBefore = await db('app_deployments').where({ stack_id: stackId, trigger: 'auto-update' }).count<{ count: string }[]>('id as count');
  await runUpdatePass(60);
  await whenAllIdle();
  const autoAfter = await db('app_deployments').where({ stack_id: stackId, trigger: 'auto-update' }).count<{ count: string }[]>('id as count');
  assert.equal(Number(autoAfter[0].count), Number(autoBefore[0].count), 'rolled-back digest not auto-applied');
  svc = await db('app_services').where({ stack_id: stackId, name: 'web' }).first();
  assert.equal(svc.current_digest, D1);
  assert.equal(svc.latest_digest, D2);

  // auto-update: only inside the maintenance window (a newer digest than the one rolled back from)
  remoteDigest = D3;
  await db('app_stacks').where({ id: stackId }).update({ update_policy: JSON.stringify({ autoUpdate: true, checkIntervalMin: 60, maintenanceWindowId: null, notify: true }), last_update_check_at: null });
  windowOpen = false;
  const before = await db('app_deployments').where({ stack_id: stackId }).count<{ count: string }[]>('id as count');
  await runUpdatePass(60);
  await whenAllIdle();
  const afterClosed = await db('app_deployments').where({ stack_id: stackId }).count<{ count: string }[]>('id as count');
  assert.equal(Number(afterClosed[0].count), Number(before[0].count), 'window closed: no update');
  windowOpen = true;
  await runUpdatePass(60);
  await whenAllIdle();
  const auto = await db('app_deployments').where({ stack_id: stackId, trigger: 'auto-update' }).orderBy('id', 'desc').first();
  assert.equal(auto.status, 'succeeded', JSON.stringify(auto.log));
  svc = await db('app_services').where({ stack_id: stackId, name: 'web' }).first();
  assert.equal(svc.current_digest, D3);

  // ── rollback to the first deployment ───────────────────────────────────────
  // (git stack: the deployment rolled back to carries its commit, the rollback record inherits it)
  await db('app_deployments').where({ id: dep1.id }).update({ commit_sha: 'c'.repeat(40) });
  r = await call('POST', `/apps/stacks/${stackId}/rollback`, asManager, { deploymentId: dep1.id });
  assert.equal(r.status, 202);
  assert.equal(r.body.data.commitSha, 'c'.repeat(40), 'rollback record carries the commit of its target');
  await whenStackIdle(stackId);
  assert.equal(docker.containers.get(`oblimint-app-${stackId}-web`)!.image, `docker.io/library/nginx@${D1}`);
  r = await call('POST', `/apps/stacks/${stackId}/rollback`, asManager, { deploymentId: busyDep });
  assert.equal(r.body.code, 'nothingToRollback');
  r = await call('POST', `/apps/stacks/${stackId}/rollback`, asManager, { deploymentId: 999999 });
  assert.equal(r.body.code, 'deploymentNotFound');

  // ── sleep / wake ───────────────────────────────────────────────────────────
  const { SleepManager } = await import('./sleep');
  const realNow = overrides.now;
  overrides.now = () => Date.now();
  try {
    await db('app_stacks').where({ id: stackId }).update({
      sleep_policy: JSON.stringify({ enabled: true, idleMinutes: 5, mode: 'stop', wakeTimeoutSec: 60, readyPath: null, wakingPageId: null }),
      last_activity_at: new Date(Date.now() - 3600_000), last_deployed_at: new Date(Date.now() - 3600_000),
    });
    const manager = new SleepManager();
    assert.equal(await manager.sleepIdle(), 1);
    await whenStackIdle(stackId);
    r = await call('GET', `/apps/stacks/${stackId}`, asReader);
    assert.equal(r.body.data.status, 'sleeping');
    assert.equal(docker.containers.get(`oblimint-app-${stackId}-web`)!.state, 'exited');
    const { appsService } = await import('./apps.service');
    let target = await appsService.targetInfo(stackId, 'web');
    assert.equal(target!.sleeping, true);
    assert.equal(target!.sleepEnabled, true);
    assert.equal(target!.alias, `app-${stackId}-web`);
    assert.deepEqual(target!.exposedPorts, [{ port: 80, protocol: 'tcp' }]);
    manager.wakeForRequest(stackId);
    manager.wakeForRequest(stackId);
    await new Promise((res) => setTimeout(res, 200));
    await whenStackIdle(stackId);
    r = await call('GET', `/apps/stacks/${stackId}`, asReader);
    assert.equal(r.body.data.status, 'running');
    target = await appsService.targetInfo(stackId, 'web');
    assert.ok(target!.wakeEtaSec !== null && target!.wakeEtaSec >= 1);
    assert.equal(await db('app_deployments').where({ stack_id: stackId, action: 'wake' }).count<{ count: string }[]>('id as count').then((x) => Number(x[0].count)), 1, 'debounced');
    assert.equal(await appsService.targetInfo(stackId, 'ghost'), null);
    assert.deepEqual(await appsService.stackContainers(stackId), [{ service: 'web', container: `oblimint-app-${stackId}-web` }]);
    const wf = await appsService.restartForWorkflow(stackId, ['web']);
    await whenStackIdle(stackId);
    assert.equal((await db('app_deployments').where({ id: wf.deploymentId }).first()).trigger, 'workflow');
    await db('app_stacks').where({ id: stackId }).update({ sleep_policy: JSON.stringify({ enabled: false }) });
  } finally {
    overrides.now = realNow;
  }

  // ── suspended account ──────────────────────────────────────────────────────
  await db('hosting_accounts').where({ id: acct }).update({ status: 'suspended' });
  r = await call('POST', `/apps/stacks/${stackId}/actions`, asManager, { action: 'deploy' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'accountSuspended');
  await db('hosting_accounts').where({ id: acct }).update({ status: 'active' });

  // ── settings: apps disabled ────────────────────────────────────────────────
  await platformSettings.update({ apps: { enabled: false } });
  r = await call('POST', '/apps/stacks', asManager, { ...createBody, name: 'off' });
  assert.equal(r.body.code, 'appsDisabled');
  await platformSettings.update({ apps: { enabled: true } });

  // ── catalog ────────────────────────────────────────────────────────────────
  r = await call('GET', '/apps/catalog', asReader);
  assert.ok(r.body.data.some((t: { slug: string }) => t.slug === 'vaultwarden'));
  assert.ok(!r.body.data.some((t: { slug: string }) => t.slug === 'obliview'), 'disabled templates hidden from clients');
  r = await call('GET', '/apps/catalog', asStaffA);
  const builtin = r.body.data.find((t: { slug: string }) => t.slug === 'redis');
  assert.ok(builtin.builtin);
  r = await call('PUT', `/apps/catalog/${builtin.id}`, asAdmin, { name: 'x' });
  assert.equal(r.body.code, 'templateBuiltin');
  r = await call('GET', '/apps/catalog/vaultwarden', asReader);
  assert.match(r.body.data.composeYaml, /vaultwarden\/server/);
  const tpl = { slug: 'my-nginx', name: 'My nginx', category: 'other', description: 'x', version: '1', composeYaml: 'services:\n  web:\n    image: nginx:1.27\n    ports: ["80"]\n', fields: [] };
  r = await call('POST', '/apps/catalog', asManager, tpl);
  assert.equal(r.status, 403, 'clients never create templates');
  r = await call('POST', '/apps/catalog', asStaffA, { ...tpl, tenantId: null });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.tenantId, tA, 'tenant staff templates are forced to its tenant');
  const myTpl = r.body.data.id as number;
  r = await call('POST', '/apps/catalog', asStaffA, { ...tpl, slug: 'bad', composeYaml: 'services:\n  a:\n    image: nginx\n    privileged: true\n' });
  assert.equal(r.body.code, 'composeInvalid');
  r = await call('GET', '/apps/catalog/my-nginx', asStaffB);
  assert.equal(r.status, 404, 'tenant templates stay in their tenant');
  r = await call('DELETE', `/apps/catalog/${myTpl}`, asStaffB);
  assert.equal(r.status, 404);
  r = await call('POST', '/apps/catalog', asAdmin, { ...tpl, slug: `platform-${suffix}`, tenantId: null });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.tenantId, null);

  // catalog stack (no deploy): generated secrets in the sealed .env, non-secret values in clear
  r = await call('POST', '/apps/stacks', asOther, {
    accountId: other, name: 'vault', sourceType: 'catalog', deploy: false,
    catalog: { templateSlug: 'vaultwarden', values: { DOMAIN: 'https://vault.example.fr' } },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.catalogSource.values, { DOMAIN: 'https://vault.example.fr', SIGNUPS_ALLOWED: false });
  assert.ok(r.body.data.envKeys.includes('ADMIN_TOKEN'));
  assert.equal(r.body.data.catalog.slug, 'vaultwarden');
  const vault = r.body.data.id as number;
  r = await call('POST', '/apps/stacks', asOther, { accountId: other, name: 'nope', sourceType: 'catalog', catalog: { templateSlug: 'obliview', values: {} } });
  assert.equal(r.body.code, 'templateNotFound', 'disabled template');

  // ── ZIP source ─────────────────────────────────────────────────────────────
  const { makeZip } = await import('./testing/zipWriter');
  r = await call('POST', '/apps/stacks', asOther, { accountId: other, name: 'zipped', sourceType: 'zip' });
  assert.equal(r.status, 201);
  const zipped = r.body.data.id as number;
  const upload = async (who: Who, id: number, body: Buffer) => {
    const res = await fetch(`${base}/apps/stacks/${id}/source/zip`, {
      method: 'POST', headers: { 'content-type': 'application/zip', 'x-user': String(who.user), 'x-tenant': String(who.tenant) }, body,
    });
    return { status: res.status, body: await res.json() as { data?: any; code?: string } };
  };
  let u = await upload(asManager, zipped, makeZip([{ name: 'docker-compose.yml', data: Buffer.from('services: {}') }]));
  assert.equal(u.status, 404, 'zip upload on another account');
  u = await upload(asOther, zipped, makeZip([{ name: '../evil', data: Buffer.from('x') }]));
  assert.equal(u.status, 400);
  assert.equal(u.body.code, 'zipInvalid');
  u = await upload(asOther, zipped, makeZip([
    { name: 'pkg/', mode: 0o040755 },
    { name: 'pkg/docker-compose.yml', data: Buffer.from('services:\n  web:\n    image: nginx:1.27\n    expose: ["80"]\n    volumes: ["./html:/usr/share/nginx/html"]\n') },
    { name: 'pkg/html/index.html', data: Buffer.from('<h1>hi</h1>') },
  ]));
  assert.equal(u.status, 200, JSON.stringify(u.body));
  await whenStackIdle(zipped);
  const zipStack = await db('app_stacks').where({ id: zipped }).first();
  assert.equal(zipStack.status, 'running', zipStack.status_message);
  assert.ok(fs.existsSync(path.join(dataRoot, 'accounts', String(other), 'apps', String(zipped), 'src', 'html', 'index.html')), 'single top directory became the source root');
  const zipC = docker.containers.get(`oblimint-app-${zipped}-web`)!;
  assert.ok(zipC.spec!.HostConfig!.Mounts!.some((m) => m.Type === 'bind' && new RegExp(`/apps/${zipped}/snapshots/\\d+/src/html$`).test(m.Source!) && m.ReadOnly === true),
    'relative bind RO, from the deployment snapshot of src/ (never the live tree)');
  // A refused archive never replaces the current source.
  u = await upload(asOther, zipped, makeZip([{ name: 'docker-compose.yml', data: Buffer.from('services:\n  web:\n    image: nginx:1.27\n    privileged: true\n') }]));
  assert.equal(u.status, 400);
  assert.equal(u.body.code, 'composeInvalid');
  assert.ok(fs.existsSync(path.join(dataRoot, 'accounts', String(other), 'apps', String(zipped), 'src', 'html', 'index.html')), 'previous source kept');
  assert.ok(!fs.existsSync(path.join(dataRoot, 'accounts', String(other), 'apps', String(zipped), 'src.new')), 'staged tree removed');
  r = await call('PUT', `/apps/stacks/${zipped}`, asOther, { git: { repoUrl: 'https://git.example.com/r' } });
  assert.equal(r.body.code, 'sourceTypeMismatch');
  r = await call('DELETE', `/apps/stacks/${zipped}`, asOther, { confirm: 'zipped', removeVolumes: true });
  assert.equal(r.status, 200);
  assert.ok(!fs.existsSync(path.join(dataRoot, 'accounts', String(other), 'apps', String(zipped))), 'removeVolumes: whole tree removed');
  assert.equal(await db('app_volume_tombstones').where({ stack_id: zipped }).first(), undefined);

  // ── git source ─────────────────────────────────────────────────────────────
  const TOKEN = 'ghp_TopSecretGitToken42';
  r = await call('POST', '/apps/stacks', asOther, {
    accountId: other, name: 'from-git', sourceType: 'git', deploy: true,
    git: { repoUrl: 'https://git.example.com/acme/app', branch: 'main', composePath: 'deploy/compose.yml', token: TOKEN, pollIntervalSec: 5 },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const fromGit = r.body.data.id as number;
  assert.equal(r.body.data.git.hasToken, true);
  assert.equal(r.body.data.git.lastCommit, GIT_SHA);
  assert.equal(r.body.data.git.pollIntervalSec, 60, 'poll ≥ settings gitPollMinSec');
  assert.ok(!JSON.stringify(r.body).includes(TOKEN));
  for (const call_ of gitCalls) assert.ok(!call_.args.join(' ').includes(TOKEN), 'token never in git arguments');
  assert.ok(gitCalls.some((c) => (c.env.GIT_CONFIG_VALUE_0 ?? '').startsWith('Authorization: Basic ')), 'token through the environment');
  assert.ok(!fs.existsSync(path.join(dataRoot, 'accounts', String(other), 'apps', String(fromGit), 'src', '.git')), '.git removed');
  await whenStackIdle(fromGit);
  assert.equal((await db('app_deployments').where({ stack_id: fromGit }).first()).commit_sha, GIT_SHA);
  r = await call('POST', `/apps/stacks/${fromGit}/source/pull`, asOther, {});
  assert.deepEqual([r.body.data.commit, r.body.data.changed, r.body.data.deployment], [GIT_SHA, false, null]);
  gitCompose = 'services:\n  app:\n    image: nginx:1.27\n    privileged: true\n';
  // A new commit whose compose is refused: 400, and src/ is NOT swapped (validated in src.new first).
  lsSha = 'd'.repeat(40);
  r = await call('POST', `/apps/stacks/${fromGit}/source/pull`, asOther, { deploy: false });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, 'composeInvalid');
  const gitSrc = path.join(dataRoot, 'accounts', String(other), 'apps', String(fromGit), 'src', 'deploy', 'compose.yml');
  assert.doesNotMatch(fs.readFileSync(gitSrc, 'utf8'), /privileged/, 'the refused tree never replaced src/');
  assert.equal((await db('app_stacks').where({ id: fromGit }).first()).git_last_commit, GIT_SHA);
  lsSha = GIT_SHA;
  r = await call('POST', '/apps/stacks', asOther, {
    accountId: other, name: 'bad-git', sourceType: 'git', git: { repoUrl: 'https://git.example.com/acme/app', composePath: 'deploy/compose.yml' },
  });
  assert.equal(r.body.code, 'composeInvalid');
  assert.equal(await db('app_stacks').where({ account_id: other, name: 'bad-git' }).first(), undefined, 'nothing kept');
  r = await call('POST', '/apps/stacks', asOther, { accountId: other, name: 'bad-url', sourceType: 'git', git: { repoUrl: 'http://git.example.com/x' } });
  assert.equal(r.status, 400);

  // ── apps never run on an account whose network is not segmented (SG1) ──────
  const legacy = await mkAccount('legacy', 'legacy');
  await db('account_users').insert({ user_id: clientManage, account_id: legacy, capabilities: JSON.stringify(['apps.manage']) });
  r = await call('POST', '/apps/stacks', asManager, { accountId: legacy, name: 'unfiltered', sourceType: 'editor', composeYaml: 'services:\n  a:\n    image: nginx:1.27\n    expose: ["80"]\n', deploy: false });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await call('POST', `/apps/stacks/${r.body.data.id}/actions`, asManager, { action: 'deploy' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'networkNotSegmented');

  // ── policy (platform admin) ────────────────────────────────────────────────
  r = await call('GET', `/apps/policy/tenants/${tA}`, asStaffA);
  assert.equal(r.status, 403);
  r = await call('PUT', `/apps/policy/tenants/${tA}`, asAdmin, { allowedRegistries: ['ghcr.io'], deniedImages: ['*:latest'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.allowedRegistries, ['ghcr.io']);
  r = await call('POST', '/apps/validate', asManager, { accountId: acct, composeYaml: 'services:\n  a:\n    image: nginx:1\n' });
  assert.equal(r.body.data.issues[0].code, 'registryNotAllowed', 'tenant policy narrows the registries');
  r = await call('PUT', `/apps/policy/tenants/${tA}`, asAdmin, { allowedRegistries: null, deniedImages: [] });
  assert.ok(await db('audit_logs').where({ action: 'apps.policy.update' }).first());

  // ── delete guard ───────────────────────────────────────────────────────────
  targeting = [{ id: 7, name: 'vault host', domains: ['vault.example.fr'], service: 'web', port: 80 }];
  r = await call('DELETE', `/apps/stacks/${stackId}`, asManager, { confirm: 'wrong' });
  assert.equal(r.body.code, 'confirmMismatch');
  r = await call('DELETE', `/apps/stacks/${stackId}`, asManager, { confirm: 'site-web' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'stackInUse');
  r = await call('DELETE', `/apps/stacks/${stackId}?force=1`, asManager, { confirm: 'site-web' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(fake.events.includes(`proxy-deleted ${stackId}`));
  assert.ok(fake.events.includes(`release ${stackId}`));
  assert.ok(!docker.containers.has(`oblimint-app-${stackId}-web`));
  assert.ok(!docker.volumes.has(`oblimint-app-${stackId}-html`));
  const tomb = await db('app_volume_tombstones').where({ stack_id: stackId }).first();
  assert.ok(tomb, 'volume data kept 7 days');
  assert.ok(new Date(tomb.purge_after).getTime() > Date.now() + 6 * 86_400_000);
  targeting = [];

  // tombstone purge after the grace period, never through a link
  await db('app_volume_tombstones').where({ id: tomb.id }).update({ purge_after: new Date(Date.now() - 1000) });
  const outside = path.join(dataRoot, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
  try { fs.symlinkSync(outside, path.join(tomb.path, 'evil-link'), 'junction'); } catch { /* symlinks not permitted on this box */ }
  assert.equal(await purgeTombstones(), 1);
  assert.ok(!fs.existsSync(tomb.path));
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')), 'a link inside the volume dir is never followed');

  // ── account teardown hook ──────────────────────────────────────────────────
  docker.volumes.set(`oblimint-app-${vault}-data`, { Name: `oblimint-app-${vault}-data`, Labels: { 'oblimint.app': String(vault) } });
  docker.networks.set(`oblimint-app-${vault}-default`, { name: `oblimint-app-${vault}-default`, labels: { 'oblimint.app-network': String(vault) } });
  fs.mkdirSync(path.join(dataRoot, 'accounts', String(other), 'apps', String(vault), 'volumes', 'data'), { recursive: true });
  const errors: string[] = [];
  await appsTeardownHook.beforeNetworksRemoved({ docker: docker.asDocker(), accountId: other, purge: false, errors });
  assert.deepEqual(errors, []);
  assert.ok(!docker.volumes.has(`oblimint-app-${vault}-data`));
  assert.ok(!docker.networks.has(`oblimint-app-${vault}-default`));
  assert.ok(await db('app_volume_tombstones').where({ stack_id: vault }).first());

  await whenAllIdle();
});
