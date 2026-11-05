import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type Docker from 'dockerode';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of the application installer. APPINSTALL_TEST_DATABASE_URL
// (skipped cleanly when nothing listens). Docker, the database engines, the
// publication and wordpress.org are faked (setInstallDepsForTests); the sites,
// the variables, the audit, the gates, the keys, the tenant wall are the real ones.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.APPINSTALL_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55463/postgres';

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

test('application installer on PostgreSQL', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-appinstall-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'appinstall-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const routes = (await import('../../routes/appInstalls.routes')).default;
  const v1Routes = (await import('../../routes/v1.routes')).default;
  const { mcpRouter } = await import('../apiKeys/mcp');
  const { actorForUser } = await import('../hosting/access');
  const { apiKeysService } = await import('../apiKeys/apiKeys.service');
  const { localPaths } = await import('../hosting/paths');
  const { setEngineFactoryForTests } = await import('../docker/engine');
  const { restrictionService } = await import('../restrictions/restriction.service');
  const { seal, open } = await import('../../utils/secretBox');
  const { setInstallDepsForTests } = await import('./deps');
  const { appInstallService, drainInstallsForTests } = await import('./appInstall.service');
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number };
  setEngineFactoryForTests(() => ({}) as never, localNode.id);
  t.after(() => setEngineFactoryForTests(null));

  // ── fixtures ──
  const suffix = Date.now().toString(36);
  const idOf = (r: unknown) => Number((r as { id?: number }).id ?? r);
  const tA = idOf((await db('tenants').insert({ name: `A ${suffix}`, slug: `a-${suffix}` }).returning('id'))[0]);
  const tB = idOf((await db('tenants').insert({ name: `B ${suffix}`, slug: `b-${suffix}` }).returning('id'))[0]);
  const user = async (name: string, kind: 'staff' | 'client', tenantId: number) => {
    const id = idOf((await db('users').insert({ username: `${name}-${suffix}`, kind, role: 'user', is_active: true }).returning('id'))[0]);
    if (kind === 'staff') await db('user_tenants').insert({ user_id: id, tenant_id: tenantId, role: 'admin' });
    return id;
  };
  const staffA = await user('staffa', 'staff', tA);
  const staffB = await user('staffb', 'staff', tB);
  const client = await user('client', 'client', tA);
  const clientNoDb = await user('nodb', 'client', tA);
  const account = async (name: string, tenantId: number, limits: Record<string, unknown> = {}) => {
    const plan = idOf((await db('plans').insert({ tenant_id: tenantId, name: `p-${name}-${suffix}`, limits: JSON.stringify({ ...DEFAULT_PLAN_LIMITS, maxSites: null, maxDatabases: null, maxDbInstances: null, diskMb: null, dbEngines: null, ...limits }) }).returning('id'))[0]);
    const uid = 20000 + Math.floor(Math.random() * 30000);
    return idOf((await db('hosting_accounts').insert({ tenant_id: tenantId, node_id: localNode.id, plan_id: plan, username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off' }).returning('id'))[0]);
  };
  const acme = await account('acme', tA);
  const other = await account('other', tB);
  await db('account_users').insert([
    { user_id: client, account_id: acme, capabilities: JSON.stringify(['sites.manage', 'databases.manage', 'releases.publish', 'files.manage']) },
    { user_id: clientNoDb, account_id: acme, capabilities: JSON.stringify(['sites.manage', 'releases.publish']) },
  ]);

  // ── fakes ──
  const toolSpecs: Docker.ContainerCreateOptions[] = [];
  let toolFailure: ((spec: Docker.ContainerCreateOptions) => string | null) = () => null;
  const calls: string[] = [];
  const archive = path.join(dataRoot, 'archive.tar.gz');
  fs.writeFileSync(archive, 'archive');
  setInstallDepsForTests({
    pollMs: 10,
    createInstance: async (_req, _actor, body) => {
      calls.push(`createInstance:${body.engine}`);
      const id = idOf((await db('db_instances').insert({
        tenant_id: tA, account_id: body.accountId, node_id: localNode.id, name: body.name, engine: body.engine, version: body.version, status: 'running', is_default: true, root_secret: seal('db-root', 'x'),
      }).returning('id'))[0]);
      return { id } as never;
    },
    getInstance: async () => ({ connection: { socketPath: '/run/mysqld/mysqld.sock' } }) as never,
    createDatabase: async (_req, _actor, instanceId, body) => {
      calls.push(`createDatabase:${body.name}`);
      const row = await db('db_instances').where({ id: instanceId }).first('account_id') as { account_id: number };
      const id = idOf((await db('db_databases').insert({ instance_id: instanceId, account_id: row.account_id, name: body.name, charset: 'utf8mb4' }).returning('id'))[0]);
      return { id } as never;
    },
    createUser: async (_req, _actor, instanceId, body) => {
      calls.push(`createUser:${body.username}`);
      const row = await db('db_instances').where({ id: instanceId }).first('account_id') as { account_id: number };
      const id = idOf((await db('db_users').insert({ instance_id: instanceId, account_id: row.account_id, username: body.username }).returning('id'))[0]);
      return { user: { id }, password: 'db-password-from-create' } as never;
    },
    resetUserPassword: async () => { calls.push('resetUserPassword'); return { user: {}, password: 'db-password-from-reset' } as never; },
    deleteUser: async (_r, _a, _i, id) => { calls.push('deleteUser'); await db('db_users').where({ id }).del(); },
    deleteDatabase: async (_r, _a, _i, id) => { calls.push('deleteDatabase'); await db('db_databases').where({ id }).del(); },
    deleteInstance: async (_r, _a, id) => { calls.push('deleteInstance'); await db('db_instances').where({ id }).del(); },
    removeSite: async (_r, _a, id) => { calls.push('removeSite'); await db('sites').where({ id }).del(); },
    latestOffer: async () => ({ version: '7.1.4', phpVersion: '7.4' }),
    ensureArchive: async () => archive,
    verifyCore: async () => ({ available: true, checked: 3, mismatched: [] }),
    runTools: async (_n, spec) => {
      toolSpecs.push(spec);
      const out = toolFailure(spec);
      return { ok: out === null, exitCode: out === null ? 0 : 1, output: out ?? 'Success', outputTruncated: false, timedOut: false, stdout: '', stderr: '' };
    },
    startPreview: async () => { calls.push('startPreview'); return { preview: { id: 77 } } as never; },
    getPreview: async () => ({ id: 77, status: 'running' }) as never,
    stopPreview: async () => { calls.push('stopPreview'); },
    publish: async (siteId) => {
      calls.push('publish');
      const id = idOf((await db('releases').insert({ site_id: siteId, number: 1, status: 'ready', trigger: 'manual', on_disk: true }).returning('id'))[0]);
      return { id, number: 1 } as never;
    },
    waitForRelease: async (_s, id) => (await db('releases').where({ id }).first('id', 'status', 'error')) as never,
  });
  t.after(() => setInstallDepsForTests(null));

  // What the reconcile does: the site comes up, its staging exists.
  const reconciler = setInterval(() => {
    void (async () => {
      const rows = await db('sites').where({ status: 'provisioning' }).select('id', 'account_id', 'slug') as Array<{ id: number; account_id: number; slug: string }>;
      for (const r of rows) {
        fs.mkdirSync(localPaths.siteStaging(r.account_id, r.slug), { recursive: true });
        await db('sites').where({ id: r.id }).update({ status: 'active' });
      }
    })().catch(() => {});
  }, 15);
  t.after(() => clearInterval(reconciler));

  // ── app ──
  const app = express();
  app.use(express.json());
  app.use('/api/v1', v1Routes);
  app.use('/mcp', mcpRouter);
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: Number(req.header('x-user')) };
    (req as unknown as { tenantId: number }).tenantId = Number(req.header('x-tenant'));
    next();
  });
  app.use('/app-installs', routes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, url: string, userId: number, tenantId: number, body?: unknown) => {
    const r = await fetch(`${baseUrl}${url}`, { method, headers: { 'x-user': String(userId), 'x-tenant': String(tenantId), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) as { data?: any; code?: string; error?: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const start = (slug: string, extra: Record<string, unknown> = {}, accountId = acme) => ({
    accountId, app: 'wordpress', name: `Site ${slug}`, slug, adminUser: 'admin', adminEmail: 'admin@example.com', ...extra,
  });
  const wait = async () => { await drainInstallsForTests(); };
  const auditDump = async () => JSON.stringify(await db('audit_logs').select('*').catch(() => []));

  await t.test('success: password returned once, never in a command line, a log, the audit or a later read', async () => {
    const r = await call('POST', '/app-installs', staffA, tA, start('blog', { publishMode: 'manual' }));
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const { install, adminPassword, adminUser } = r.json.data;
    assert.equal(adminUser, 'admin');
    assert.ok(adminPassword.length >= 24);
    await wait();
    const row = await db('app_installs').where({ id: install.id }).first();
    assert.equal(row.status, 'succeeded', row.error);
    assert.equal(row.admin_password_sealed, null, 'not kept');
    assert.equal(row.version, '7.1.4');
    assert.ok(row.release_id);

    const got = await call('GET', `/app-installs/${install.id}`, staffA, tA);
    assert.equal(got.status, 200);
    assert.ok(!JSON.stringify(got.json).includes(adminPassword), 'never in a read');
    assert.ok(got.json.data.steps.every((s: { status: string }) => s.status === 'done' || s.status === 'skipped'));
    assert.equal(got.json.data.releaseNumber, 1);

    const specs = toolSpecs.filter((s) => s.Labels?.['oblimint.app-install'] === String(install.id));
    assert.ok(specs.length >= 5);
    for (const s of specs) {
      assert.equal(s.HostConfig?.NetworkMode, 'none', `${s.name} has no network`);
      assert.ok(!JSON.stringify(s.Cmd).includes(adminPassword), `${s.name}: password in the command line`);
    }
    const withPassword = specs.filter((s) => (s.Env ?? []).some((e) => e.includes(adminPassword)));
    assert.deepEqual(withPassword.map((s) => s.name), [`oblimint-tools-${install.id}-ai-set-password`], 'only the step that sets it');

    const dump = await auditDump();
    assert.ok(dump.includes('app.install.start'), 'audited');
    assert.ok(dump.includes('app.install.finish'));
    assert.ok(!dump.includes(adminPassword), 'never in the audit');
    assert.ok(!JSON.stringify(row.log).includes(adminPassword));

    const site = await db('sites').where({ id: row.site_id }).first('app_profile', 'publish_mode', 'docroot');
    assert.equal(site.app_profile, 'wordpress');
    assert.equal(site.publish_mode, 'manual');
    const env = await db('site_env_vars').where({ site_id: row.site_id }).select('name', 'secret', 'value_sealed');
    const byName = new Map(env.map((e) => [e.name, e]));
    assert.equal(byName.get('DB_PASSWORD')?.secret, true);
    assert.equal(open('site-env', byName.get('DB_PASSWORD')!.value_sealed), 'db-password-from-create');
    assert.equal(byName.get('WP_AUTH_KEY')?.secret, true);
    assert.equal(byName.get('DB_NAME')?.secret, false);
    assert.equal(await db('site_data_paths').where({ site_id: row.site_id, path: 'wp-content/uploads' }).first('id') !== undefined, true);
    assert.ok(!fs.existsSync(localPaths.appDistSeed(install.id)), 'seed removed');
    assert.deepEqual(calls.splice(0), ['createInstance:mariadb', `createDatabase:wp_blog`, `createUser:wp${install.id}_blog`, 'publish']);
    assert.ok(row.instance_created && row.database_created && row.user_created);
  });

  await t.test('an existing MySQL-family server is used, and is not "created" by the operation', async () => {
    const r = await call('POST', '/app-installs', staffA, tA, start('second', { publishMode: 'manual' }));
    assert.equal(r.status, 201);
    await wait();
    const row = await db('app_installs').where({ id: r.json.data.install.id }).first();
    assert.equal(row.status, 'succeeded', row.error);
    assert.equal(row.instance_created, false);
    assert.ok(!calls.some((c) => c.startsWith('createInstance')));
    calls.length = 0;
  });

  await t.test('rights, tenant wall and validation answer before anything exists', async () => {
    const sites = async () => Number((await db('sites').count<{ n: string }[]>({ n: '*' }))[0].n);
    const before = await sites();
    assert.equal((await call('POST', '/app-installs', staffB, tB, start('x1', {}, acme))).status, 404, 'another tenant');
    const noDb = await call('POST', '/app-installs', clientNoDb, tA, start('x2'));
    assert.equal(noDb.status, 403);
    assert.equal(noDb.json.code, 'appInstallRights');
    assert.equal((await call('POST', '/app-installs', staffA, tA, { ...start('x3'), app: 'joomla' })).status, 400, 'WordPress only');
    assert.equal((await call('POST', '/app-installs', staffA, tA, { ...start('x4'), adminUser: '--evil' })).status, 400, 'no leading dash');
    assert.equal((await call('POST', '/app-installs', staffA, tA, { ...start('x5'), base: 'nginx-static' })).status, 400, 'a PHP base');
    assert.equal(await sites(), before, 'nothing created');

    const blog = await db('app_installs').where({ site_slug: 'blog' }).first('id');
    assert.equal((await call('GET', `/app-installs/${blog.id}`, staffB, tB)).status, 404, 'invisible to another tenant');
    assert.deepEqual((await call('GET', '/app-installs', staffB, tB)).json.data, []);
    assert.equal((await call('POST', `/app-installs/${blog.id}/retry`, staffB, tB)).status, 404);
    assert.equal((await call('POST', `/app-installs/${blog.id}/cleanup`, staffB, tB)).status, 404);
    assert.ok((await call('GET', '/app-installs', client, tA)).json.data.length >= 2);
    assert.ok((await appInstallService.list(await actorForUser(staffB, tB))).every((i) => i.accountId === other));
  });

  await t.test('quotas of the plan: refused before anything exists', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ maxDatabases: 0 }, 'maxDatabases'],
      [{ maxDbInstances: 0 }, 'maxDbInstances'],
      [{ dbEngines: ['postgresql'] }, 'engineNotAllowed'],
      [{ diskMb: 100 }, 'diskMb'],
    ];
    for (const [limits, code] of cases) {
      const a = await account(`q${code.toLowerCase()}`, tA, limits);
      const r = await call('POST', '/app-installs', staffA, tA, start(`q-${code.toLowerCase()}`, {}, a));
      assert.equal(r.status, 409, code);
      assert.equal(r.json.code, 'planLimit');
      assert.equal((r.json as { details?: { limit?: string } }).details?.limit ?? code, code);
      assert.equal(await db('sites').where({ account_id: a }).first('id'), undefined);
    }
    const a = await account('maxsites', tA, { maxSites: 0 });
    const r = await call('POST', '/app-installs', staffA, tA, start('q-sites', {}, a));
    assert.equal(r.status, 409, 'maxSites');
    assert.equal(await db('app_installs').where({ account_id: a }).first('id'), undefined);
    // A taken slug: answered at once too.
    assert.equal((await call('POST', '/app-installs', staffA, tA, start('blog'))).json.code, 'slugTaken');
  });

  await t.test('failure: scrubbed, raw cause for the staff only, retry resumes at the failed step with the same password', async () => {
    let captured = '';
    toolFailure = (spec) => {
      if (!spec.name?.endsWith('ai-core-install')) return null;
      captured = 'x';
      return 'Admin password: generatedSecret123\nError: database unreachable';
    };
    const r = await call('POST', '/app-installs', staffA, tA, start('flaky', { publishMode: 'manual' }));
    const { install, adminPassword } = r.json.data;
    await wait();
    assert.ok(captured);
    let row = await db('app_installs').where({ id: install.id }).first();
    assert.equal(row.status, 'failed');
    assert.equal(row.failed_step, 'install');
    assert.equal(row.error_code, 'toolFailed');
    assert.ok(!String(row.error_detail).includes('generatedSecret123'), 'generated password scrubbed');
    assert.ok(String(row.error_detail).includes('database unreachable'));
    assert.ok(row.admin_password_sealed, 'kept sealed for the retry');
    const staffView = await call('GET', `/app-installs/${install.id}`, staffA, tA);
    assert.ok(staffView.json.data.error.includes('database unreachable'));
    const clientView = await call('GET', `/app-installs/${install.id}`, client, tA);
    assert.ok(!clientView.json.data.error.includes('database unreachable'), 'raw cause hidden from a client');
    assert.equal(clientView.json.data.failedStep, 'install');

    // Not a state that can be published or cleaned while it runs; a second retry is refused once running.
    toolFailure = () => null;
    const seenBefore = toolSpecs.length;
    const again = await call('POST', `/app-installs/${install.id}/retry`, client, tA);
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json.data.adminPassword, undefined, 'the first password still holds');
    await wait();
    row = await db('app_installs').where({ id: install.id }).first();
    assert.equal(row.status, 'succeeded', row.error);
    const names = toolSpecs.slice(seenBefore).map((s) => String(s.name).replace(/^.*-ai-/, ''));
    assert.deepEqual(names, ['core-install', 'set-password', 'permalinks'], 'steps done are not run again');
    const setPassword = toolSpecs.slice(seenBefore).find((s) => s.name?.endsWith('ai-set-password'));
    assert.ok(setPassword?.Env?.includes(`OBLIMINT_INSTALL_ADMIN_PASSWORD=${adminPassword}`));
    assert.equal((await call('POST', `/app-installs/${install.id}/retry`, staffA, tA)).json.code, 'appInstallState');
    calls.length = 0;
  });

  await t.test('cleanup removes only what the operation created', async () => {
    toolFailure = (spec) => (spec.name?.endsWith('ai-extract') ? 'tar: no space left' : null);
    // Own account: the operation creates the server too.
    const a = await account('clean', tA);
    const r = await call('POST', '/app-installs', staffA, tA, start('cleaned', { publishMode: 'manual' }, a));
    const id = r.json.data.install.id;
    await wait();
    let row = await db('app_installs').where({ id }).first();
    assert.equal(row.status, 'failed');
    assert.equal(row.failed_step, 'extract');
    const instanceId = row.db_instance_id;
    calls.length = 0;
    const done = await call('POST', `/app-installs/${id}/cleanup`, staffA, tA);
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.deepEqual(calls.splice(0), ['removeSite', 'deleteUser', 'deleteDatabase', 'deleteInstance']);
    row = await db('app_installs').where({ id }).first();
    assert.equal(row.status, 'cleaned');
    assert.equal(row.admin_password_sealed, null);
    assert.equal(row.site_id, null);
    assert.equal(await db('db_instances').where({ id: instanceId }).first('id'), undefined);

    // On an account with a server of its own: the server and its other databases stay.
    const r2 = await call('POST', '/app-installs', staffA, tA, start('cleaned2', { publishMode: 'manual' }));
    await wait();
    const row2 = await db('app_installs').where({ id: r2.json.data.install.id }).first();
    assert.equal(row2.instance_created, false);
    assert.equal((await call('POST', `/app-installs/${row2.id}/cleanup`, staffA, tA)).status, 200);
    assert.deepEqual(calls.splice(0), ['createDatabase:wp_cleaned2', `createUser:wp${row2.id}_cleaned2`, 'removeSite', 'deleteUser', 'deleteDatabase']);
    assert.ok(await db('db_instances').where({ id: row2.db_instance_id }).first('id'), 'the server stays');
    assert.ok(await db('sites').where({ slug: 'blog', account_id: acme }).first('id'), 'other sites stay');
    toolFailure = () => null;

    // A live release is never cleaned.
    const blog = await db('app_installs').where({ site_slug: 'blog' }).first('id');
    assert.equal((await call('POST', `/app-installs/${blog.id}/cleanup`, staffA, tA)).json.code, 'appInstallState');
  });

  await t.test('install in a preview first: stops before publishing, then publishes on demand', async () => {
    const { platformSettings } = await import('../platformSettings');
    const missing = await call('POST', '/app-installs', staffA, tA, start('prev0', { previewFirst: true }));
    assert.equal(missing.status, 409);
    assert.equal(missing.json.code, 'previewDomainMissing', 'refused before anything exists');
    assert.equal(await db('sites').where({ slug: 'prev0' }).first('id'), undefined);
    const original = platformSettings.get.bind(platformSettings);
    platformSettings.get = (async () => {
      const s = await original();
      return { ...s, preview: { ...s.preview, previewDomain: 'preview.example.com' } };
    }) as typeof platformSettings.get;
    t.after(() => { platformSettings.get = original; });

    calls.length = 0;
    const r = await call('POST', '/app-installs', staffA, tA, start('prev', { previewFirst: true, publishMode: 'approval' }));
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const id = r.json.data.install.id;
    await wait();
    let row = await db('app_installs').where({ id }).first();
    assert.equal(row.status, 'preview_ready', row.error);
    assert.equal(row.preview_id, 77);
    assert.equal(row.release_id, null);
    assert.equal(row.admin_password_sealed, null, 'gone once WordPress is installed');
    assert.ok(calls.includes('startPreview'));
    assert.ok(!calls.includes('publish'));
    assert.equal((await db('sites').where({ id: row.site_id }).first('publish_mode')).publish_mode, 'manual', 'nothing can publish yet');

    const published = await call('POST', `/app-installs/${id}/publish`, staffA, tA);
    assert.equal(published.status, 200, JSON.stringify(published.json));
    await wait();
    row = await db('app_installs').where({ id }).first();
    assert.equal(row.status, 'succeeded', row.error);
    assert.ok(calls.includes('publish'));
    assert.ok(calls.includes('stopPreview'));
    assert.equal((await db('sites').where({ id: row.site_id }).first('publish_mode')).publish_mode, 'approval', 'the chosen mode from there on');
    assert.equal((await call('POST', `/app-installs/${id}/publish`, staffA, tA)).json.code, 'appInstallState');
    platformSettings.get = original;
    calls.length = 0;
  });

  await t.test('gate: one request on the strictest action, nothing happens before it', async () => {
    const sitesBefore = Number((await db('sites').count<{ n: string }[]>({ n: '*' }))[0].n);
    await restrictionService.setMap(tA, { 'release.publish': 'restricted' } as never);
    const second = await user('second', 'staff', tA);
    await db('users').where({ id: second }).update({ totp_enabled: true, totp_secret: 'JBSWY3DPEHPK3PXP' });
    const held = await call('POST', '/app-installs', staffA, tA, start('gated', { publishMode: 'manual' }));
    assert.equal(held.status, 202, JSON.stringify(held.json));
    assert.equal(held.json.data.status, 'pendingApproval');
    assert.equal(Number((await db('sites').count<{ n: string }[]>({ n: '*' }))[0].n), sitesBefore, 'nothing created');
    const pending = await db('pending_actions').where({ id: held.json.data.pendingActionId }).first();
    assert.equal(pending.action_key, 'release.publish');
    assert.ok(!JSON.stringify(pending).includes('Password'));
    await db('pending_actions').where({ id: pending.id }).del();
    await restrictionService.setMap(tA, {} as never);
  });

  await t.test('access keys: scopes, MCP install_app, follow-up without a password, cleanup by its own key only', async () => {
    const actor = await actorForUser(client, tA);
    const req = { headers: {}, session: { userId: client }, socket: { remoteAddress: '203.0.113.7' } } as never;
    const full = await apiKeysService.create(req, actor, acme, { name: 'full', scopes: ['sites.create', 'sites.manage', 'databases.manage', 'releases.publish'], siteScope: 'selected', siteIds: [] });
    const poor = await apiKeysService.create(req, actor, acme, { name: 'poor', scopes: ['sites.create'], siteScope: 'selected', siteIds: [] });
    const strange = await apiKeysService.create(req, actor, acme, { name: 'strange', scopes: ['sites.create', 'sites.manage', 'databases.manage', 'releases.publish'], siteScope: 'selected', siteIds: [] });
    const rest = async (key: string, method: string, url: string, body?: unknown) => {
      const r = await fetch(`${baseUrl}/api/v1${url}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: await r.json().catch(() => null) as { data?: any; code?: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const mcp = async (key: string, name: string, args: unknown) => {
      const r = await fetch(`${baseUrl}/mcp`, {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      const body = await r.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
      return { isError: !!body.result.isError, text: body.result.content[0].text };
    };
    const refused = await rest(poor.key!, 'POST', '/apps/install', { app: 'wordpress', name: 'P', slug: 'poor', adminUser: 'a', adminEmail: 'a@example.com' });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.code, 'keyScope');

    const viaMcp = await mcp(full.key!, 'install_app', { app: 'wordpress', name: 'Agent', slug: 'agent', admin_user: 'admin', admin_email: 'a@example.com', publish_mode: 'manual', locale: 'fr_FR' });
    assert.equal(viaMcp.isError, false, viaMcp.text);
    const started = JSON.parse(viaMcp.text);
    assert.ok(started.adminPassword);
    await wait();
    const id = started.install.id;
    const followed = await mcp(full.key!, 'get_app_install', { install_id: id });
    assert.equal(followed.isError, false, followed.text);
    assert.equal(JSON.parse(followed.text).status, 'succeeded');
    assert.equal(JSON.parse(followed.text).locale, 'fr_FR');
    assert.ok(!followed.text.includes(started.adminPassword));
    const listed = await rest(full.key!, 'GET', '/apps/installs');
    assert.ok(listed.json.data.some((i: { id: number }) => i.id === id));
    assert.ok(!JSON.stringify(listed.json).includes(started.adminPassword));
    const row = await db('app_installs').where({ id }).first();
    assert.equal(row.api_key_id, full.id);
    assert.ok(await db('api_key_sites').where({ key_id: full.id, site_id: row.site_id }).first('site_id'), 'the site joined the key');
    assert.ok(await db('api_key_db_objects').where({ key_id: full.id, kind: 'database', object_id: row.db_database_id }).first('object_id'));

    // Another key of the account: out of its reach.
    assert.equal((await rest(strange.key!, 'GET', `/apps/installs/${id}`)).status, 404);
    assert.equal((await rest(strange.key!, 'POST', `/apps/installs/${id}/cleanup`)).status, 404);

    // A failed one, cleaned by the key that started it.
    toolFailure = (spec) => (spec.name?.endsWith('ai-extract') ? 'boom' : null);
    const failed = await rest(full.key!, 'POST', '/apps/install', { app: 'wordpress', name: 'F', slug: 'failing', adminUser: 'a', adminEmail: 'a@example.com', publishMode: 'manual' });
    assert.equal(failed.status, 201, JSON.stringify(failed.json));
    await wait();
    toolFailure = () => null;
    const fid = failed.json.data.install.id;
    assert.equal((await rest(full.key!, 'GET', `/apps/installs/${fid}`)).json.data.status, 'failed');
    assert.ok(!(await rest(full.key!, 'GET', `/apps/installs/${fid}`)).json.data.error.includes('boom'), 'raw cause hidden from a key');
    await db('users').where({ id: client }).update({ totp_enabled: true, totp_secret: 'JBSWY3DPEHPK3PXP' });
    await restrictionService.setMap(tA, { 'site.delete': 'sensitive' } as never);
    const gated = await rest(full.key!, 'POST', `/apps/installs/${fid}/cleanup`);
    assert.equal(gated.status, 428, 'a key does not delete a site without its owner');
    await restrictionService.setMap(tA, {} as never);
    assert.equal((await rest(full.key!, 'POST', `/apps/installs/${fid}/cleanup`)).json.data.status, 'cleaned');
  });

  await t.test('restart: an operation left running becomes failed; a purged password is replaced, once', async () => {
    const [row] = await db('app_installs').insert({
      tenant_id: tA, account_id: acme, site_id: (await db('sites').where({ slug: 'agent' }).first('id')).id, site_slug: 'agent', site_name: 'x', app: 'wordpress', status: 'running',
      options: JSON.stringify({ title: 't', adminUser: 'admin', adminEmail: 'a@example.com', locale: 'en_US', previewFirst: false, base: 'apache-php8.3', publishMode: 'manual', publishDebounceSec: null }),
      steps: JSON.stringify(['site', 'database', 'variables', 'download', 'extract', 'config', 'verify', 'install', 'preview', 'publish'].map((key, i) => ({
        key, status: i < 7 ? 'done' : key === 'install' ? 'running' : key === 'preview' ? 'skipped' : 'pending', startedAt: null, finishedAt: null,
      }))),
      version: '7.1.4', admin_password_sealed: seal('app-install', 'old-password'), created_by: staffA, updated_at: new Date(Date.now() - 8 * 86_400_000),
    }).returning('*');
    assert.equal(await appInstallService.recoverInterrupted(), 1);
    let cur = await db('app_installs').where({ id: row.id }).first();
    assert.equal(cur.status, 'failed');
    assert.equal(cur.error_code, 'interrupted');
    assert.equal(cur.failed_step, 'install');
    await db('app_installs').where({ id: row.id }).update({ updated_at: new Date(Date.now() - 8 * 86_400_000) });
    assert.equal(await appInstallService.sweep(), 1);
    cur = await db('app_installs').where({ id: row.id }).first();
    assert.equal(cur.admin_password_sealed, null);
    // Publishing needs a free release number on this fixture: the failure there is not what is checked.
    const again = await call('POST', `/app-installs/${row.id}/retry`, staffA, tA);
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.ok(again.json.data.adminPassword, 'a new one, shown once');
    await wait();
    assert.equal((await db('app_installs').where({ id: row.id }).first()).admin_password_sealed, null);
    await db('app_installs').where({ id: row.id }).del();
  });

  await t.test('migration 043 is reversible', async () => {
    await db.migrate.down();
    assert.equal(await db.schema.hasTable('app_installs'), false);
    await db.migrate.latest();
    assert.equal(await db.schema.hasTable('app_installs'), true);
  });
});
