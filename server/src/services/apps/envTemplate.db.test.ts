import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of the .env of an application whatever its source, on a PGlite
// server (APPS_TEST_DATABASE_URL, default port 55471 like apps.db.test.ts;
// skipped cleanly when nothing listens). Docker = FakeAppDocker, git = a fake
// runner. Covers: the bounded lookup of a repository's .env example before
// creation (access, URL rules, anti-SSRF, token never in the arguments, temp
// directory removed, audit with the key names only), a git application created
// with its .env, `env_file: .env` absent from the repository = the stack .env
// in the container, GET /stacks/:id/env-template (local read, remote fetch when
// the tree is gone), the .env of a git application updated (compose still
// refused) and redeployed, a catalog .env edited by hand.
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

test('application .env: git, example, env_file, catalog (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-appenv-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_P4B_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'apps-env-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const appsRoutes = (await import('../../routes/apps.routes')).default;
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');
  const { setAppsDepsForTests } = await import('./deps');
  const { FakeAppDocker, fakeAppsDeps } = await import('./testing/fakeAppDocker');
  const { whenStackIdle } = await import('./deployments');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // ── fakes ──────────────────────────────────────────────────────────────────
  const docker = new FakeAppDocker();
  docker.remote.set('docker.io/library/nginx:1.27', `sha256:${'1'.repeat(64)}`);
  const fake = fakeAppsDeps(docker);
  const GIT_SHA = 'c'.repeat(40);
  const BLOB = 'e'.repeat(40);
  const EXAMPLE = '# The API key of the provider\nAPI_KEY=changeme-example\nMODE=prod\n';
  const COMPOSE = 'services:\n  app:\n    image: nginx:1.27\n    expose: ["80"]\n    env_file: .env\n    environment:\n      MODE: ${MODE:-dev}\n';
  const gitCalls: Array<{ args: string[]; env: Record<string, string>; cwd?: string }> = [];
  let lookupAnswer = '93.184.216.34';
  let withExample = true;
  setAppsDepsForTests({
    ...fake.deps,
    async lookup() { return [{ address: lookupAnswer, family: 4 }]; },
    async git(args, opts) {
      gitCalls.push({ args, env: opts.env, cwd: opts.cwd });
      if (args.includes('ls-remote')) return { code: 0, stdout: `${GIT_SHA}\trefs/heads/main\n`, stderr: '' };
      if (args.includes('clone')) {
        const dest = path.join(opts.cwd!, args[args.length - 1]);
        fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
        if (args.includes('--no-checkout')) return { code: 0, stdout: '', stderr: '' };
        fs.mkdirSync(path.join(dest, 'deploy'), { recursive: true });
        fs.writeFileSync(path.join(dest, 'deploy', 'compose.yml'), COMPOSE);
        if (withExample) fs.writeFileSync(path.join(dest, 'deploy', '.env.example'), EXAMPLE);
        fs.writeFileSync(path.join(dest, '.env.example'), 'ROOT_ONLY=1\n');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args.includes('ls-tree')) {
        const paths = args.slice(args.indexOf('--') + 1);
        const out = withExample && paths.includes('deploy/.env.example') ? `100644 blob ${BLOB}\tdeploy/.env.example\0` : '';
        return { code: 0, stdout: out, stderr: '' };
      }
      if (args.includes('cat-file')) return args.includes(BLOB) ? { code: 0, stdout: EXAMPLE, stderr: '' } : { code: 128, stdout: '', stderr: 'fatal: not a valid object' };
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
    async probeTcp() { return true; },
    async probeHttp() { return true; },
  });
  t.after(() => { setAppsDepsForTests(null); });

  // ── fixtures ───────────────────────────────────────────────────────────────
  const suffix = Date.now().toString(36);
  const [tenant] = await db('tenants').insert({ name: `E ${suffix}`, slug: `e-${suffix}` }).returning('id');
  const tId = Number(tenant.id ?? tenant);
  const user = async (username: string, kind: 'staff' | 'client') => {
    const [row] = await db('users').insert({ username: `${username}-${suffix}`, kind, role: kind === 'staff' ? 'admin' : 'user', is_active: true }).returning('id');
    const id = Number(row.id ?? row);
    await db('user_tenants').insert({ user_id: id, tenant_id: tId, role: kind === 'staff' ? 'admin' : 'user' });
    return id;
  };
  const clientRead = await user('er', 'client');
  const clientManage = await user('em', 'client');
  const clientOther = await user('eo', 'client');
  const localNode = await db('nodes').where({ is_local: true }).first('id') as { id: number };
  const limits = { ...DEFAULT_PLAN_LIMITS, maxAppStacks: 5, maxAppContainers: 10, appsCpuCores: 4, appsMemoryMb: 4096, appsPidsPerContainer: 256 };
  const [plan] = await db('plans').insert({ tenant_id: tId, name: `pe-${suffix}`, limits: JSON.stringify(limits) }).returning('id');
  const planId = Number(plan.id ?? plan);
  const mkAccount = async (name: string) => {
    const uid = 20000 + Math.floor(Math.random() * 30000);
    const [acct] = await db('hosting_accounts').insert({
      tenant_id: tId, node_id: localNode.id, plan_id: planId, username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
      network_model: 'segmented',
    }).returning('id');
    return Number(acct.id ?? acct);
  };
  const acct = await mkAccount('envacct');
  const other = await mkAccount('envother');
  await db('account_users').insert([
    { user_id: clientRead, account_id: acct, capabilities: JSON.stringify([]) },
    { user_id: clientManage, account_id: acct, capabilities: JSON.stringify(['apps.manage']) },
    { user_id: clientOther, account_id: other, capabilities: JSON.stringify(['apps.manage']) },
  ]);

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
  const asReader: Who = { user: clientRead, tenant: tId };
  const asManager: Who = { user: clientManage, tenant: tId };
  const asOther: Who = { user: clientOther, tenant: tId };
  const appsDir = path.join(dataRoot, 'accounts', String(acct), 'apps');

  // ── .env example of a repository before creation ──────────────────────────
  const TOKEN = 'ghp_EnvExampleToken42';
  const probe = { accountId: acct, repoUrl: 'https://git.example.com/acme/app', branch: 'main', composePath: 'deploy/compose.yml', token: TOKEN };
  let r = await call('POST', '/apps/git/env-template', asReader, probe);
  assert.equal(r.status, 403, 'member without apps.manage');
  r = await call('POST', '/apps/git/env-template', asOther, probe);
  assert.equal(r.status, 404, 'client of another account');
  r = await call('POST', '/apps/git/env-template', asManager, { ...probe, repoUrl: 'http://git.example.com/acme/app' });
  assert.equal(r.status, 400, 'https only');
  r = await call('POST', '/apps/git/env-template', asManager, { ...probe, repoUrl: 'https://127.0.0.1/acme/app' });
  assert.equal(r.status, 400, 'private address');
  lookupAnswer = '10.1.2.3';
  r = await call('POST', '/apps/git/env-template', asManager, probe);
  assert.equal(r.status, 400, 'a name resolving to a private address');
  assert.equal(r.body.code, 'validation');
  lookupAnswer = '93.184.216.34';
  assert.equal(gitCalls.length, 0, 'nothing ran for a refused repository');
  r = await call('POST', '/apps/git/env-template', asManager, { ...probe, extra: 1 });
  assert.equal(r.status, 400, 'strict body');

  r = await call('POST', '/apps/git/env-template', asManager, probe);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, { file: 'deploy/.env.example', content: EXAMPLE, keys: ['API_KEY', 'MODE'], missingKeys: ['API_KEY', 'MODE'] });
  assert.deepEqual(gitCalls.map((c) => c.args.find((a) => ['clone', 'ls-tree', 'cat-file'].includes(a))), ['clone', 'ls-tree', 'cat-file']);
  for (const c of gitCalls) {
    assert.ok(!c.args.join(' ').includes(TOKEN), 'token never in the git arguments');
    assert.ok(c.args.includes('http.curloptResolve=git.example.com:443:93.184.216.34'), 'checked address pinned on every step');
    assert.ok((c.env.GIT_CONFIG_VALUE_0 ?? '').startsWith('Authorization: Basic '), 'token through the environment');
    assert.ok(path.resolve(c.cwd!).startsWith(path.resolve(appsDir) + path.sep), 'inside the account apps/ tree (quota)');
  }
  assert.ok(gitCalls[0].args.includes('--filter=blob:none') && gitCalls[0].args.includes('--no-checkout'));
  assert.deepEqual(fs.readdirSync(appsDir).filter((n) => n.startsWith('.probe-')), [], 'temporary directory removed');
  let audit = await db('audit_logs').where({ action: 'apps.git.envTemplate.fetch' }).orderBy('id', 'desc').first();
  assert.ok(audit, 'audited');
  assert.deepEqual(audit.details.keys, ['API_KEY', 'MODE']);
  assert.ok(!JSON.stringify(audit.details).includes('changeme-example') && !JSON.stringify(audit.details).includes(TOKEN), 'key names only');

  withExample = false;
  r = await call('POST', '/apps/git/env-template', asManager, { ...probe, token: null });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { file: null, content: null, keys: [], missingKeys: [] }, 'no example: the root one is not read when the tree lists none');
  withExample = true;

  // ── git application created with its .env (env_file: .env absent from the repository) ──
  gitCalls.length = 0;
  r = await call('POST', '/apps/stacks', asManager, {
    accountId: acct, name: 'from-git', sourceType: 'git', deploy: true, env: 'API_KEY=real-key-123456\n',
    git: { repoUrl: 'https://git.example.com/acme/app', branch: 'main', composePath: 'deploy/compose.yml' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const stackId = r.body.data.id as number;
  assert.deepEqual(r.body.data.envKeys, ['API_KEY']);
  assert.ok(!JSON.stringify(r.body).includes('real-key-123456'));
  await whenStackIdle(stackId);
  const containerEnv = () => new Map((docker.containers.get(`oblimint-app-${stackId}-app`)!.spec!.Env ?? []).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
  r = await call('GET', `/apps/stacks/${stackId}`, asManager);
  assert.equal(r.body.data.status, 'running', JSON.stringify(r.body.data.statusMessage));
  assert.equal(containerEnv().get('API_KEY'), 'real-key-123456', 'env_file: .env = the sealed .env of the application');
  assert.equal(containerEnv().get('MODE'), 'dev');
  const src = path.join(appsDir, String(stackId), 'src');
  assert.ok(!fs.existsSync(path.join(src, 'deploy', '.env')), 'the .env is never written in the source tree');

  // ── GET /stacks/:id/env-template ───────────────────────────────────────────
  r = await call('GET', `/apps/stacks/${stackId}/env-template`, asReader);
  assert.equal(r.status, 403);
  r = await call('GET', `/apps/stacks/${stackId}/env-template`, asOther);
  assert.equal(r.status, 404);
  const before = gitCalls.length;
  r = await call('GET', `/apps/stacks/${stackId}/env-template`, asManager);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, { file: 'deploy/.env.example', content: EXAMPLE, keys: ['API_KEY', 'MODE'], missingKeys: ['MODE'] }, 'the compose directory first');
  assert.equal(gitCalls.length, before, 'read in the source tree, no git');
  assert.equal(await db('audit_logs').where({ action: 'apps.stack.envTemplate.fetch' }).first(), undefined, 'a local read is not audited');

  // ── .env of a git application: editable, the compose is not ────────────────
  r = await call('PUT', `/apps/stacks/${stackId}`, asReader, { env: 'API_KEY=x\n' });
  assert.equal(r.status, 403);
  r = await call('PUT', `/apps/stacks/${stackId}`, asManager, { composeYaml: 'services:\n  a:\n    image: nginx:1.27\n' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'sourceTypeMismatch');
  r = await call('PUT', `/apps/stacks/${stackId}`, asManager, { env: 'API_KEY=real-key-123456\nMODE=staging\n' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.envKeys, ['API_KEY', 'MODE']);
  assert.equal(r.body.data.validation.ok, true);
  const row = await db('app_stacks').where({ id: stackId }).first();
  assert.ok(row.env_sealed.startsWith('v1:') && !row.env_sealed.includes('staging'), 'sealed');
  audit = await db('audit_logs').where({ action: 'apps.stack.update', resource_path: String(stackId) }).orderBy('id', 'desc').first();
  assert.deepEqual(audit.details.changed, ['env']);
  r = await call('GET', `/apps/stacks/${stackId}/env-template`, asManager);
  assert.deepEqual(r.body.data.missingKeys, [], 'every expected variable set');
  r = await call('POST', `/apps/stacks/${stackId}/actions`, asManager, { action: 'redeploy' });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await whenStackIdle(stackId);
  assert.equal(containerEnv().get('MODE'), 'staging', 'redeployed with the new .env');
  // A .env the compose cannot use (required variable removed) is refused, nothing stored.
  r = await call('PUT', `/apps/stacks/${stackId}`, asManager, { env: 'NOT VALID\n' });
  assert.equal(r.status, 400);

  // The tree is gone: the example is fetched from the repository (audited, key names only).
  fs.rmSync(src, { recursive: true, force: true });
  gitCalls.length = 0;
  r = await call('GET', `/apps/stacks/${stackId}/env-template`, asManager);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.file, 'deploy/.env.example');
  assert.ok(gitCalls.some((c) => c.args.includes('cat-file')));
  audit = await db('audit_logs').where({ action: 'apps.stack.envTemplate.fetch' }).first();
  assert.ok(audit);
  assert.deepEqual(audit.details.keys, ['API_KEY', 'MODE']);
  assert.ok(!JSON.stringify(audit.details).includes('changeme-example'));

  // Editor stack: no example.
  r = await call('POST', '/apps/stacks', asManager, { accountId: acct, name: 'edited', sourceType: 'editor', deploy: false, composeYaml: 'services:\n  a:\n    image: nginx:1.27\n' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await call('GET', `/apps/stacks/${r.body.data.id}/env-template`, asManager);
  assert.deepEqual(r.body.data, { file: null, content: null, keys: [], missingKeys: [] });

  // ── catalog .env edited by hand ────────────────────────────────────────────
  r = await call('POST', '/apps/stacks', asManager, {
    accountId: acct, name: 'vault', sourceType: 'catalog', deploy: false,
    catalog: { templateSlug: 'vaultwarden', values: { DOMAIN: 'https://vault.example.com' } },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const vault = r.body.data.id as number;
  r = await call('GET', `/apps/stacks/${vault}/env`, asManager);
  const token = /ADMIN_TOKEN="?([^"\n]+)"?/.exec(r.body.data.env)![1];
  assert.ok(token.length > 20);
  // DOMAIN changed by hand, ADMIN_TOKEN (generated) and SIGNUPS_ALLOWED removed by mistake.
  r = await call('PUT', `/apps/stacks/${vault}`, asManager, { env: '# by hand\nDOMAIN=https://new.example.com\nEXTRA=1\n' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.catalogSource.values, { DOMAIN: 'https://new.example.com', SIGNUPS_ALLOWED: false }, 'template values follow the .env');
  r = await call('GET', `/apps/stacks/${vault}/env`, asManager);
  assert.ok(r.body.data.env.startsWith('# by hand\nDOMAIN=https://new.example.com\nEXTRA=1\n'), 'the hand-written text is kept');
  assert.equal(/ADMIN_TOKEN="?([^"\n]+)"?/.exec(r.body.data.env)?.[1], token, 'the generated secret comes back unchanged');
  assert.match(r.body.data.env, /SIGNUPS_ALLOWED=false/);
  r = await call('PUT', `/apps/stacks/${vault}`, asManager, { env: 'DOMAIN=not a url\n' });
  assert.equal(r.status, 400, 'a value the template field refuses');
  assert.equal((await call('GET', `/apps/stacks/${vault}`, asManager)).body.data.catalogSource.values.DOMAIN, 'https://new.example.com', 'nothing stored');
});
