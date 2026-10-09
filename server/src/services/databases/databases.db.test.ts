import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import type { AddressInfo } from 'net';
import type { Readable, Writable } from 'stream';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of the databases module on a PGlite server
// (docs/P2-PLAN.md §12: databases = port 55443):
//   PG_PORT=55443 node <scratchpad>/pg/pgserver.mjs
// DATABASES_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. Docker = FakeDocker (engine seam), docker exec of the SQL clients =
// a recording fake (exec seam), hostd = fake (backends seam). Covers: plan
// limits, default-per-family rule, access rules (other tenant / account →
// 404, no capability → 403), external port allocation uniqueness, the
// instance converge + reconcile hook, SQL never carrying a password on a
// command line, dump / restore streaming, SSO session.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.DATABASES_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55443/postgres';

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

interface ExecCall { container: string; cmd: string[]; env: string[]; sql: string | null; stdin: string | null }

test('databases module on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55443)`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-db-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'databases-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const routes = (await import('../../routes/databases.routes')).default;
  const { setEngineFactoryForTests } = await import('../docker/engine');
  const { setBackendsForTests } = await import('../docker/backends');
  const { FakeDocker } = await import('../docker/testing/fakeDocker');
  const { setDbExecForTests } = await import('./exec');
  const { settleConverges } = await import('./instances');
  const { databaseService, measureInstance } = await import('./databases.service');
  const { databaseReconcileHook } = await import('./reconcileHook');
  const { ssoTokens } = await import('./ssoTokens');
  const { resetSsoStateForTests, expireSsoSessions } = await import('./sso');
  const { platformSettings } = await import('../platformSettings');
  const { config } = await import('../../config');
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // ── fakes ──────────────────────────────────────────────────────────────────
  const docker = new FakeDocker();
  docker.networks.set('oblimint', { name: 'oblimint', labels: {} });
  for (const img of ['mariadb:11.4', 'postgres:17']) docker.images.add(img);
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number };
  setEngineFactoryForTests(() => docker.asDocker(), localNode.id);

  const hostdCalls: string[] = [];
  const { HostdError } = await import('../hostd/client');
  /** Next hostd failures by operation (ensure / remove): thrown once each. */
  const hostdFails: Array<{ op: 'ensure' | 'remove'; err: Error }> = [];
  const failIf = (op: 'ensure' | 'remove') => {
    const i = hostdFails.findIndex((f) => f.op === op);
    if (i >= 0) throw hostdFails.splice(i, 1)[0].err;
  };
  setBackendsForTests({
    hostd: () => ({
      ensureDbInstance: async (s: { accountId: number; instanceId: number; uid: number }) => { failIf('ensure'); hostdCalls.push(`ensure ${s.accountId}/${s.instanceId} uid=${s.uid}`); },
      removeDbInstance: async (a: number, i: number, o: { purge: boolean }) => { failIf('remove'); hostdCalls.push(`remove ${a}/${i} purge=${o.purge}`); },
      setDefaultDbSocket: async (a: number, f: string, i: number | null) => { hostdCalls.push(`default ${a} ${f} ${i}`); },
    }) as never,
    scheduleEdgeSync: () => undefined,
  });

  const execCalls: ExecCall[] = [];
  let failNextSql: { exitCode: number; stderr: string } | null = null;
  let restoreExit = 0;
  let sizeOutput = '';
  setDbExecForTests(async (_docker, container, cmd, opts = {}) => {
    const env = opts.env ?? [];
    const sqlEnv = env.find((e) => e.startsWith('OBLIMINT_SQL='));
    let stdin: string | null = null;
    if (opts.stdin && typeof opts.stdin !== 'string') {
      const chunks: Buffer[] = [];
      for await (const c of opts.stdin as Readable) chunks.push(Buffer.from(c));
      stdin = Buffer.concat(chunks).toString('utf8');
    }
    execCalls.push({ container, cmd, env, sql: sqlEnv ? sqlEnv.slice('OBLIMINT_SQL='.length) : null, stdin });
    if (opts.stdout) {
      (opts.stdout as Writable).write(Buffer.from('-- dump of the database\nCREATE TABLE t (id int);\n'));
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (stdin !== null) return { exitCode: restoreExit, stdout: '', stderr: restoreExit ? 'ERROR 1064 near line 1 at /var/lib/mysql' : '' };
    if (sqlEnv && failNextSql) {
      const f = failNextSql;
      failNextSql = null;
      return { exitCode: f.exitCode, stdout: '', stderr: f.stderr };
    }
    if (sqlEnv?.includes('information_schema.TABLES') || sqlEnv?.includes('pg_database_size')) return { exitCode: 0, stdout: sizeOutput, stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  t.after(() => {
    setEngineFactoryForTests(null);
    setBackendsForTests(null);
    setDbExecForTests(null);
    resetSsoStateForTests();
    databaseService.stop();
  });

  // ── fixtures ───────────────────────────────────────────────────────────────
  const suffix = Date.now().toString(36);
  const [tenantA] = await db('tenants').insert({ name: `A ${suffix}`, slug: `a-${suffix}` }).returning('id');
  const [tenantB] = await db('tenants').insert({ name: `B ${suffix}`, slug: `b-${suffix}` }).returning('id');
  const tA = Number(tenantA.id ?? tenantA);
  const tB = Number(tenantB.id ?? tenantB);
  const user = async (username: string, kind: 'staff' | 'client', role: 'admin' | 'user', tenantId: number) => {
    const [row] = await db('users').insert({ username: `${username}-${suffix}`, kind, role, is_active: true }).returning('id');
    const id = Number(row.id ?? row);
    if (kind === 'staff') await db('user_tenants').insert({ user_id: id, tenant_id: tenantId, role: 'admin' });
    return id;
  };
  const staffB = await user('stb', 'staff', 'user', tB);
  const clientRead = await user('cr', 'client', 'user', tA);
  const clientManage = await user('cm', 'client', 'user', tA);
  const clientOther = await user('co', 'client', 'user', tA);
  const platformAdmin = await user('pa', 'staff', 'admin', 1);
  // Admin of tenant A (caps '*' in its tenant, no god view): NOT the platform admin.
  const staffAdminA = await user('sta', 'staff', 'admin', tA);

  const limits = { ...DEFAULT_PLAN_LIMITS, maxDbInstances: 3, maxDatabases: 2, dbEngines: ['mariadb', 'postgresql'], dbExternalAccess: false, dbProfile: 'S' };
  const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify(limits) }).returning('id');
  const planId = Number(plan.id ?? plan);
  const mkAccount = async (name: string) => {
    const uid = 20000 + Math.floor(Math.random() * 30000);
    const [acct] = await db('hosting_accounts').insert({
      tenant_id: tA, node_id: localNode.id, plan_id: planId, username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active',
      filesrv_mode: 'off',
    }).returning('id');
    const id = Number(acct.id ?? acct);
    docker.networks.set(`oblimint-acct-${id}`, { name: `oblimint-acct-${id}`, labels: { 'oblimint.account': String(id) } });
    docker.networks.set(`oblimint-acct-${id}-db`, { name: `oblimint-acct-${id}-db`, labels: { 'oblimint.account': String(id) } });
    return { id, uid };
  };
  const acct = await mkAccount('acme');
  const other = await mkAccount('other');
  await db('account_users').insert([
    { user_id: clientRead, account_id: acct.id, capabilities: JSON.stringify([]) },
    { user_id: clientManage, account_id: acct.id, capabilities: JSON.stringify(['databases.manage']) },
    { user_id: clientOther, account_id: other.id, capabilities: JSON.stringify(['databases.manage']) },
  ]);

  // ── app ────────────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: Number(req.header('x-user')) };
    (req as unknown as { tenantId: number }).tenantId = Number(req.header('x-tenant'));
    next();
  });
  app.use('/databases', routes);
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
  const asAdmin: Who = { user: platformAdmin, tenant: 1 };
  const asStaffB: Who = { user: staffB, tenant: tB };

  // ── catalog ────────────────────────────────────────────────────────────────
  let r = await call('GET', `/databases/catalog?accountId=${acct.id}`, asReader);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.allowedEngines, ['mariadb', 'postgresql']);
  assert.equal(r.body.data.maxInstances, 3);
  assert.equal(r.body.data.externalAccessAllowed, false);
  r = await call('GET', `/databases/catalog?accountId=${acct.id}`, asStaffB);
  assert.equal(r.status, 404);

  // ── create + converge ──────────────────────────────────────────────────────
  r = await call('POST', '/databases/instances', asReader, { accountId: acct.id, name: 'main', engine: 'mariadb', version: '11.4' });
  assert.equal(r.status, 403, 'member without databases.manage');
  r = await call('POST', '/databases/instances', asOther, { accountId: acct.id, name: 'main', engine: 'mariadb', version: '11.4' });
  assert.equal(r.status, 404, 'client of another account');
  r = await call('POST', '/databases/instances', asManager, { accountId: acct.id, name: 'main', engine: 'mysql', version: '8.4' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'engineNotAllowed');
  r = await call('POST', '/databases/instances', asManager, { accountId: acct.id, name: 'Bad_Name', engine: 'mariadb', version: '11.4' });
  assert.equal(r.status, 400);
  r = await call('POST', '/databases/instances', asManager, { accountId: acct.id, name: 'main', engine: 'mariadb', version: '9.9' });
  assert.equal(r.status, 400);
  r = await call('POST', '/databases/instances', asManager, { accountId: acct.id, name: 'big', engine: 'mariadb', version: '11.4', profile: 'L' });
  assert.equal(r.status, 409, 'profile above the plan: staff only');
  assert.equal(r.body.code, 'planLimit');

  r = await call('POST', '/databases/instances', asManager, { accountId: acct.id, name: 'main', engine: 'mariadb', version: '11.4' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const m1 = r.body.data.id as number;
  assert.equal(r.body.data.status, 'provisioning');
  assert.equal(r.body.data.isDefault, true, 'first of its family = default');
  assert.equal(r.body.data.socketPath, '/run/mysqld/mysqld.sock');
  assert.equal(r.body.data.profile, 'S');
  assert.equal(r.body.data.memoryLimitMb, 256);
  assert.equal(r.body.data.rootSecret, undefined);
  await settleConverges();
  let row = await db('db_instances').where({ id: m1 }).first();
  assert.equal(row.status, 'running', row.status_message);
  assert.match(row.root_secret, /^v1:/, 'superuser password sealed');
  const c1 = docker.containers.get(`oblimint-db-${m1}`);
  assert.equal(c1?.state, 'running');
  assert.equal(c1?.spec?.User, `${acct.uid}:${acct.uid}`);
  assert.equal(c1?.labels['oblimint.role'], 'db');
  assert.ok(hostdCalls.includes(`ensure ${acct.id}/${m1} uid=${acct.uid}`));
  assert.ok(hostdCalls.includes(`default ${acct.id} mysql ${m1}`));

  r = await call('POST', '/databases/instances', asManager, { accountId: acct.id, name: 'main', engine: 'postgresql', version: '17' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'instanceNameTaken');
  r = await call('POST', '/databases/instances', asManager, { accountId: acct.id, name: 'pg', engine: 'postgresql', version: '17' });
  assert.equal(r.status, 201);
  const p1 = r.body.data.id as number;
  assert.equal(r.body.data.isDefault, true, 'first of the postgresql family');
  r = await call('POST', '/databases/instances', { user: staffAdminA, tenant: tA }, { accountId: acct.id, name: 'second', engine: 'mariadb', version: '11.4', profile: 'M' });
  assert.equal(r.status, 409, 'a reseller admin may not exceed the plan profile (tenant memory envelope)');
  assert.equal(r.body.code, 'planLimit');
  r = await call('POST', '/databases/instances', asAdmin, { accountId: acct.id, name: 'second', engine: 'mariadb', version: '11.4', profile: 'M' });
  assert.equal(r.status, 201, 'the platform admin may exceed the plan profile');
  const m2 = r.body.data.id as number;
  assert.equal(r.body.data.isDefault, false, 'second of the family');
  assert.equal(r.body.data.socketPath, `/run/oblimint-db/i-${m2}/mysqld.sock`);
  r = await call('POST', '/databases/instances', asManager, { accountId: acct.id, name: 'fourth', engine: 'mariadb', version: '11.4' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'planLimit');
  assert.equal(r.body.details.limit, 'maxDbInstances');
  await settleConverges();
  assert.equal(docker.containers.get(`oblimint-db-${m2}`)?.spec?.HostConfig?.Memory, 768 * 1048576);

  // ── access ─────────────────────────────────────────────────────────────────
  r = await call('GET', `/databases/instances/${m1}`, asStaffB);
  assert.equal(r.status, 404, 'staff of another tenant');
  r = await call('GET', `/databases/instances/${m1}`, { user: clientRead, tenant: tB });
  assert.equal(r.status, 404, 'client in another tenant session');
  r = await call('GET', `/databases/instances/${m1}`, asOther);
  assert.equal(r.status, 404, 'client of another account');
  r = await call('GET', '/databases/instances/abc', asReader);
  assert.equal(r.status, 404);
  r = await call('GET', `/databases/instances/${m1}`, asReader);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.adminUi, 'phpmyadmin');
  assert.equal(r.body.data.connection.internalHost, `db-${m1}`);
  r = await call('PUT', `/databases/instances/${m1}`, asReader, { name: 'x' });
  assert.equal(r.status, 403);
  r = await call('PUT', `/databases/instances/${m1}`, asStaffB, { bogus: true });
  assert.equal(r.status, 404, 'access checked before the body');
  r = await call('GET', '/databases/instances', asOther);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, [], 'a client only lists its accounts');
  r = await call('GET', '/databases/instances', asReader);
  assert.deepEqual(r.body.data.map((i: { id: number }) => i.id).sort((a: number, b: number) => a - b), [m1, p1, m2].sort((a, b) => a - b));
  r = await call('GET', '/databases/instances', asStaffB);
  assert.deepEqual(r.body.data, [], 'staff of another tenant lists nothing of A');
  r = await call('GET', `/databases/instances?accountId=${acct.id}`, asOther);
  assert.equal(r.status, 404);

  // ── default per family ─────────────────────────────────────────────────────
  hostdCalls.length = 0;
  const containersBefore = docker.calls.filter((c) => c.startsWith('create ')).length;
  r = await call('PUT', `/databases/instances/${m2}`, asManager, { isDefault: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.isDefault, true);
  const defaults = await db('db_instances').where({ account_id: acct.id, is_default: true }).orderBy('id').select('id');
  assert.deepEqual(defaults.map((d: { id: number }) => d.id), [p1, m2].sort((a, b) => a - b), 'one default per family');
  assert.deepEqual(hostdCalls, [`default ${acct.id} mysql ${m2}`]);
  assert.equal(docker.calls.filter((c) => c.startsWith('create ')).length, containersBefore, 'no container recreated');

  // ── databases ──────────────────────────────────────────────────────────────
  execCalls.length = 0;
  r = await call('POST', `/databases/instances/${m1}/databases`, asManager, { name: 'mysql' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'reservedName');
  r = await call('POST', `/databases/instances/${m1}/databases`, asManager, { name: 'a`b' });
  assert.equal(r.status, 400);
  assert.equal(execCalls.length, 0, 'nothing reached the SQL client');
  r = await call('POST', `/databases/instances/${m1}/databases`, asReader, { name: 'shop' });
  assert.equal(r.status, 403);
  r = await call('POST', `/databases/instances/${m1}/databases`, asManager, { name: 'shop' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const shopId = r.body.data.id as number;
  assert.equal(r.body.data.charset, 'utf8mb4');
  const createCall = execCalls.at(-1)!;
  assert.equal(createCall.container, `oblimint-db-${m1}`);
  assert.match(createCall.sql ?? '', /CREATE DATABASE `shop`/);
  assert.equal(createCall.cmd.slice(0, 3).join(' '), 'sh -c printf "%s" "$OBLIMINT_SQL" | "$@"');
  assert.ok(createCall.env.some((e) => e.startsWith('MYSQL_PWD=')));
  assert.ok(!createCall.cmd.some((a) => a.includes('shop')), 'the statements are not on the command line');
  r = await call('POST', `/databases/instances/${m1}/databases`, asManager, { name: 'SHOP' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'databaseNameTaken');
  r = await call('POST', `/databases/instances/${p1}/databases`, asManager, { name: 'Analytics' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.name, 'analytics', 'PostgreSQL names lower-cased');
  assert.match(execCalls.at(-1)!.sql ?? '', /OWNER "oblimint_o\d+"/);
  assert.ok(execCalls.at(-1)!.env.some((e) => e.startsWith('PGPASSWORD=')));
  r = await call('POST', `/databases/instances/${m2}/databases`, asManager, { name: 'third' });
  assert.equal(r.status, 409, 'maxDatabases is a total over the account');
  assert.equal(r.body.details.limit, 'maxDatabases');

  // failing SQL: the row is rolled back, raw output only for the staff
  await db('plans').where({ id: planId }).update({ limits: JSON.stringify({ ...limits, maxDatabases: 10 }) });
  failNextSql = { exitCode: 1, stderr: 'ERROR 1007 (HY000): something at /var/lib/mysql' };
  r = await call('POST', `/databases/instances/${m1}/databases`, asManager, { name: 'boom' });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'backendUnavailable');
  assert.doesNotMatch(r.body.error ?? '', /var\/lib/, 'A6: no raw text for a client');
  assert.equal(await db('db_databases').where({ instance_id: m1, name: 'boom' }).first(), undefined);

  // ── users ──────────────────────────────────────────────────────────────────
  r = await call('POST', `/databases/instances/${m1}/users`, asManager, { username: 'root' });
  assert.equal(r.status, 400);
  r = await call('POST', `/databases/instances/${m1}/users`, asManager, { username: 'app', password: 'short' });
  assert.equal(r.status, 400);
  r = await call('POST', `/databases/instances/${m1}/users`, asManager, { username: 'app', grants: [{ databaseId: 999999, level: 'all' }] });
  assert.equal(r.status, 400, 'grant on a database of another instance');
  r = await call('POST', `/databases/instances/${m1}/users`, asManager, { username: 'app', grants: [{ databaseId: shopId, level: 'all' }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const appId = r.body.data.user.id as number;
  const generated = r.body.data.password as string;
  assert.equal(generated.length, 24);
  assert.deepEqual(r.body.data.user.grants, [{ databaseId: shopId, databaseName: 'shop', level: 'all' }]);
  const userCall = execCalls.at(-1)!;
  assert.ok((userCall.sql ?? '').includes(generated), 'password in the statement (stdin)…');
  assert.ok(!userCall.cmd.some((a) => a.includes(generated)), '…never on the command line');
  const userRow = await db('db_users').where({ id: appId }).first();
  assert.ok(!Object.values(userRow).some((v) => String(v).includes(generated)), 'B2: password not stored');
  r = await call('POST', `/databases/instances/${m1}/users`, asManager, { username: 'APP' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'dbUserTaken');
  r = await call('PUT', `/databases/instances/${m1}/users/${appId}`, asManager, { grants: [{ databaseId: shopId, level: 'readonly' }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.grants, [{ databaseId: shopId, databaseName: 'shop', level: 'readonly' }]);
  assert.match(execCalls.at(-1)!.sql ?? '', /REVOKE ALL PRIVILEGES ON `shop`\.\* FROM 'app'@'%';\nGRANT SELECT, SHOW VIEW/);
  r = await call('POST', `/databases/instances/${m1}/users/${appId}/password`, asManager, { password: 'a-chosen-password' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.password, 'a-chosen-password');
  r = await call('POST', `/databases/instances/${p1}/users/${appId}/password`, asManager, {});
  assert.equal(r.status, 404, 'user of another instance');

  // ── stop / start ───────────────────────────────────────────────────────────
  r = await call('POST', `/databases/instances/${m1}/stop`, asManager);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.status, 'stopped');
  assert.equal(docker.containers.get(`oblimint-db-${m1}`)?.state, 'exited');
  r = await call('POST', `/databases/instances/${m1}/databases`, asManager, { name: 'later' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'instanceNotRunning');
  r = await call('POST', `/databases/instances/${m1}/start`, asManager);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'running');

  // ── reconcile hook: suspension stops, never removes; resume restarts ───────
  const state = async () => {
    const a = await db('hosting_accounts').where({ id: acct.id }).first();
    return { state: { account: { ...a, limits }, sites: [] }, docker: docker.asDocker(), report: { accountId: acct.id, ok: true, actions: [], errors: [] } } as never;
  };
  await db('hosting_accounts').where({ id: acct.id }).update({ status: 'suspended' });
  await databaseReconcileHook.afterAccountPass(await state());
  await settleConverges();
  for (const id of [m1, m2, p1]) assert.equal(docker.containers.get(`oblimint-db-${id}`)?.state, 'exited', `instance ${id} stopped`);
  assert.equal((await db('db_instances').where({ id: m1 }).first()).status, 'running', 'status kept: it restarts with the account');
  r = await call('POST', `/databases/instances/${m1}/databases`, asManager, { name: 'later' });
  assert.equal(r.body.code, 'accountSuspended');
  await db('hosting_accounts').where({ id: acct.id }).update({ status: 'active' });
  await databaseReconcileHook.afterAccountPass(await state());
  await settleConverges();
  for (const id of [m1, m2, p1]) assert.equal(docker.containers.get(`oblimint-db-${id}`)?.state, 'running', `instance ${id} restarted`);
  // drift (container removed behind our back) → recreated
  docker.containers.delete(`oblimint-db-${m2}`);
  await databaseReconcileHook.afterAccountPass(await state());
  await settleConverges();
  assert.equal(docker.containers.get(`oblimint-db-${m2}`)?.state, 'running');

  // ── external access ────────────────────────────────────────────────────────
  r = await call('PUT', `/databases/instances/${m1}/external`, asManager, { enabled: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.details.limit, 'dbExternalAccess');
  await db('plans').where({ id: planId }).update({ limits: JSON.stringify({ ...limits, maxDatabases: 10, dbExternalAccess: true }) });
  // a port already taken on the node (a file server of another account) is skipped
  const usedPorts = async () => {
    const a = await db('db_instances').where({ node_id: localNode.id }).whereNotNull('external_port').pluck('external_port');
    const b = await db('hosting_accounts').where({ node_id: localNode.id }).whereNotNull('filesrv_port').pluck('filesrv_port');
    return new Set([...a, ...b].map(Number));
  };
  const freeFrom = (used: Set<number>, from: number) => { let p = from; while (used.has(p)) p++; return p; };
  const blocked = freeFrom(await usedPorts(), config.hosting.dbPortMin);
  await db('hosting_accounts').where({ id: other.id }).update({ filesrv_port: blocked });
  const expected1 = freeFrom(await usedPorts(), config.hosting.dbPortMin);
  r = await call('PUT', `/databases/instances/${m1}/external`, asManager, { enabled: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const port1 = r.body.data.externalPort as number;
  assert.equal(port1, expected1);
  assert.notEqual(port1, blocked);
  const expected2 = freeFrom(await usedPorts(), config.hosting.dbPortMin);
  r = await call('PUT', `/databases/instances/${p1}/external`, asManager, { enabled: true });
  const port2 = r.body.data.externalPort as number;
  assert.equal(port2, expected2);
  assert.notEqual(port2, port1, 'unique per node');
  assert.deepEqual(docker.containers.get(`oblimint-db-${m1}`)?.spec?.HostConfig?.PortBindings, { '3306/tcp': [{ HostPort: String(port1) }] });
  assert.deepEqual((await databaseService.externalPorts(acct.id)).map((p) => p.port).sort(), [port1, port2].sort());
  r = await call('PUT', `/databases/instances/${m1}/external`, asManager, { enabled: false });
  assert.equal(r.body.data.externalPort, null);
  assert.equal(docker.containers.get(`oblimint-db-${m1}`)?.spec?.HostConfig?.PortBindings, undefined);
  assert.deepEqual((await databaseService.externalPorts(acct.id)).map((p) => p.port), [port2]);

  // ── size / usage ───────────────────────────────────────────────────────────
  sizeOutput = 'shop\t2097152\nmysql\t999\nperformance_schema\t5\nrogue\t1000\n';
  await measureInstance(await db('db_instances').where({ id: m1 }).first());
  assert.equal(Number((await db('db_databases').where({ id: shopId }).first()).size_bytes), 2097152);
  assert.equal(Number((await db('db_instances').where({ id: m1 }).first()).size_bytes), 2097152 + 1000,
    'system schemas excluded, a schema unknown to the panel counted');
  const usage = await databaseService.accountDbUsage(acct.id);
  assert.equal(usage.instances, 3);
  assert.equal(usage.databases, 2);
  assert.equal(usage.sizeBytes, 2097152 + 1000, 'the account usage is the sum of its instances');
  // a database above dbMaxSizeMb blocks new databases / users
  await db('plans').where({ id: planId }).update({ limits: JSON.stringify({ ...limits, maxDatabases: 10, dbExternalAccess: true, dbMaxSizeMb: 1 }) });
  r = await call('POST', `/databases/instances/${m1}/databases`, asManager, { name: 'more' });
  assert.equal(r.status, 409);
  assert.equal(r.body.details.limit, 'dbMaxSizeMb');
  await db('plans').where({ id: planId }).update({ limits: JSON.stringify({ ...limits, maxDatabases: 10, dbExternalAccess: true }) });

  // ── dump / restore ─────────────────────────────────────────────────────────
  let res = await fetch(`${base}/databases/instances/${m1}/databases/${shopId}/dump`, { headers: { 'x-user': String(clientRead), 'x-tenant': String(tA) } });
  assert.equal(res.status, 403);
  res = await fetch(`${base}/databases/instances/${m1}/databases/${shopId}/dump`, { headers: { 'x-user': String(clientManage), 'x-tenant': String(tA) } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/gzip');
  assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="main-shop-\d{8}-\d{4}\.sql\.gz"$/);
  assert.equal(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString(), '-- dump of the database\nCREATE TABLE t (id int);\n');
  const dumpCall = execCalls.at(-1)!;
  assert.equal(dumpCall.cmd[0], 'mariadb-dump');
  assert.ok(dumpCall.env.some((e) => e.startsWith('MYSQL_PWD=')));

  const sqlBody = 'CREATE TABLE x (id int);\n';
  // (a size measurement follows each restore in the background: look for the call that had a stdin)
  const lastRestore = () => [...execCalls].reverse().find((c) => c.stdin !== null)!;
  const restore = (body: Buffer, type: string, who = clientManage) => fetch(`${base}/databases/instances/${m1}/databases/${shopId}/restore`, {
    method: 'POST', headers: { 'content-type': type, 'x-user': String(who), 'x-tenant': String(tA) }, body,
  });
  execCalls.length = 0;
  res = await restore(zlib.gzipSync(sqlBody), 'application/gzip');
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual((await res.json() as { data: unknown }).data, { restored: true });
  assert.equal(lastRestore().stdin, sqlBody, 'inflated on the fly');
  assert.ok(lastRestore().cmd.includes('--database=shop'));
  // never as root: the database's restore account, sandboxed client, locked again afterwards
  assert.ok(lastRestore().cmd.includes(`--user=oblimint_o${shopId}`), lastRestore().cmd.join(' '));
  assert.ok(lastRestore().cmd.includes('--sandbox'));
  assert.ok(!lastRestore().cmd.includes('--user=root'));
  const m1Calls = execCalls.filter((c) => c.container === `oblimint-db-${m1}`);
  const restoreIdx = m1Calls.indexOf(lastRestore());
  assert.match(m1Calls[restoreIdx - 1]?.sql ?? '', new RegExp(`ALTER USER 'oblimint_o${shopId}'@'%' IDENTIFIED BY '[^']+' ACCOUNT UNLOCK;`));
  assert.match(m1Calls[restoreIdx + 1]?.sql ?? '', new RegExp(`ALTER USER IF EXISTS 'oblimint_o${shopId}'@'%' IDENTIFIED BY '[^']+' ACCOUNT LOCK;`));
  const unlockPw = /IDENTIFIED BY '([^']+)' ACCOUNT UNLOCK/.exec(m1Calls[restoreIdx - 1]!.sql!)![1];
  assert.ok(lastRestore().env.includes(`MYSQL_PWD=${unlockPw}`), 'authenticates as the restore account');
  // DEFINER clauses removed from the dump
  res = await restore(Buffer.from('CREATE DEFINER=`root`@`localhost` VIEW v AS SELECT 1;\n'), 'application/sql');
  assert.equal(res.status, 200);
  assert.equal(lastRestore().stdin, 'CREATE  VIEW v AS SELECT 1;\n');
  res = await restore(Buffer.from(sqlBody), 'application/sql');
  assert.equal(res.status, 200);
  assert.equal(lastRestore().stdin, sqlBody);
  res = await restore(Buffer.from(sqlBody), 'text/plain');
  assert.equal(res.status, 415);
  restoreExit = 1;
  res = await restore(Buffer.from(sqlBody), 'application/sql');
  assert.equal(res.status, 502);
  let j = await res.json() as { code: string; details: Record<string, unknown> };
  assert.equal(j.code, 'restoreFailed');
  assert.equal(j.details.output, undefined, 'client output reserved to the staff');
  res = await fetch(`${base}/databases/instances/${m1}/databases/${shopId}/restore`, {
    method: 'POST', headers: { 'content-type': 'application/sql', 'x-user': String(platformAdmin), 'x-tenant': '1' }, body: sqlBody,
  });
  j = await res.json() as { code: string; details: Record<string, unknown> };
  assert.equal(j.code, 'restoreFailed');
  assert.match(String(j.details.output), /ERROR 1064/);
  restoreExit = 0;
  // PostgreSQL restore runs as the database owner role
  const analytics = await db('db_databases').where({ instance_id: p1 }).first();
  res = await fetch(`${base}/databases/instances/${p1}/databases/${analytics.id}/restore`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-user': String(clientManage), 'x-tenant': String(tA) }, body: sqlBody,
  });
  assert.equal(res.status, 200);
  assert.ok(lastRestore().env.includes(`PGOPTIONS=-c role=oblimint_o${analytics.id}`));
  // …through an ephemeral non-superuser (member of the owner role), psql restricted, the role dropped afterwards
  const pgRestore = lastRestore();
  const pgUser = pgRestore.cmd[pgRestore.cmd.indexOf('-U') + 1];
  assert.match(pgUser, /^oblsso_[0-9a-f]{8}$/);
  assert.match(pgRestore.stdin ?? '', /^\\restrict [0-9a-f]{48}\nCREATE TABLE x \(id int\);\n$/);
  const p1Calls = execCalls.filter((c) => c.container === `oblimint-db-${p1}`);
  const pgIdx = p1Calls.indexOf(pgRestore);
  assert.match(p1Calls[pgIdx - 1]?.sql ?? '', new RegExp(`CREATE ROLE "${pgUser}" LOGIN PASSWORD '[^']+' VALID UNTIL`));
  assert.match(p1Calls[pgIdx - 1]?.sql ?? '', new RegExp(`GRANT "oblimint_o${analytics.id}" TO "${pgUser}"`));
  assert.ok(!(p1Calls[pgIdx - 1]?.sql ?? '').includes('SUPERUSER'));
  assert.match(p1Calls[pgIdx + 1]?.sql ?? '', new RegExp(`DROP ROLE IF EXISTS "${pgUser}";`));
  const { pendingSsoDrops, liveSsoSessions } = await import('./sso');
  assert.deepEqual(pendingSsoDrops(), [], 'dropped at once');

  // ── heavy-operation lock: no recreation while a dump / restore runs ───────
  const { acquireBusy } = await import('./instances');
  const releaseBusy = acquireBusy(p1);
  r = await call('PUT', `/databases/instances/${p1}`, asAdmin, { profile: 'M' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'instanceBusy');
  r = await call('PUT', `/databases/instances/${p1}/external`, asManager, { enabled: false });
  assert.equal(r.body.code, 'instanceBusy', 'external access change recreates the container');
  const createsBefore = docker.calls.filter((c) => c.startsWith('create ')).length;
  await db('db_instances').where({ id: p1 }).update({ profile: 'M' }); // drift behind the API
  await databaseReconcileHook.afterAccountPass(await state());
  await settleConverges();
  assert.equal(docker.calls.filter((c) => c.startsWith('create ')).length, createsBefore, 'drift recreation deferred while busy');
  releaseBusy();
  await settleConverges();
  assert.equal(docker.calls.filter((c) => c.startsWith('create ')).length, createsBefore + 1, 'done once released');
  assert.equal(docker.containers.get(`oblimint-db-${p1}`)?.spec?.HostConfig?.Memory, 768 * 1048576);

  // ── SSO admin session ──────────────────────────────────────────────────────
  r = await call('POST', `/databases/instances/${m1}/admin-session`, asManager, {});
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'dbAdminUnavailable', 'no dbAdmin.hostname');
  await platformSettings.update({ dbAdmin: { hostname: 'db.example.test' } } as never);
  r = await call('POST', `/databases/instances/${m1}/admin-session`, asManager, {});
  assert.equal(r.status, 409, 'admin container not running');
  docker.addContainer({ name: 'oblimint-phpmyadmin', state: 'running' });
  r = await call('POST', `/databases/instances/${m1}/admin-session`, asReader, {});
  assert.equal(r.status, 403);
  r = await call('POST', `/databases/instances/${m1}/admin-session`, asManager, { databaseId: shopId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const url = new URL(r.body.data.url);
  assert.equal(url.origin, 'https://db.example.test');
  assert.equal(url.pathname, '/phpmyadmin/oblimint-sso.php');
  const token = url.searchParams.get('token')!;
  assert.ok(Date.parse(r.body.data.expiresAt) - Date.now() <= 60_000);
  const ssoSql = execCalls.at(-1)!.sql ?? '';
  assert.match(ssoSql, /CREATE USER 'oblsso_[0-9a-f]{8}'@'%'/);
  assert.match(ssoSql, /GRANT ALL PRIVILEGES ON `shop`\.\*/);
  assert.ok(docker.calls.includes(`connect oblimint-phpmyadmin oblimint-acct-${acct.id}-db`), 'attached to the account DATABASE network (never the edge one)');
  assert.equal(ssoTokens.redeem(token, 'adminer'), null, 'not for Adminer (and burnt)');
  r = await call('POST', `/databases/instances/${m1}/admin-session`, asManager, {});
  const t2 = new URL(r.body.data.url).searchParams.get('token')!;
  const ticket = ssoTokens.redeem(t2, 'phpmyadmin');
  assert.ok(ticket);
  assert.equal(ticket!.credentials.host, `db-${m1}`);
  assert.equal(ticket!.credentials.database, null);
  assert.match(ticket!.credentials.user, /^oblsso_[0-9a-f]{8}$/);
  assert.equal(ssoTokens.redeem(t2, 'phpmyadmin'), null, 'single use');
  // expiry: users dropped, admin detached once no session remains
  execCalls.length = 0;
  await expireSsoSessions(Date.now() + 3 * 60 * 60_000);
  assert.equal(execCalls.filter((c) => /DROP USER IF EXISTS 'oblsso_/.test(c.sql ?? '')).length, 2);
  assert.ok(docker.calls.includes(`disconnect oblimint-phpmyadmin oblimint-acct-${acct.id}-db`));

  // expiry of a session whose instance is stopped: detached anyway, the user dropped once it runs again
  const disconnects = () => docker.calls.filter((c) => c === `disconnect oblimint-phpmyadmin oblimint-acct-${acct.id}-db`).length;
  r = await call('POST', `/databases/instances/${m1}/admin-session`, asManager, {});
  assert.equal(r.status, 200);
  const ssoUser = liveSsoSessions()[0].username;
  await db('db_instances').where({ id: m1 }).update({ status: 'stopped' });
  let before = disconnects();
  execCalls.length = 0;
  await expireSsoSessions(Date.now() + 3 * 60 * 60_000);
  assert.equal(liveSsoSessions().length, 0, 'the expired session left the registry');
  assert.equal(disconnects(), before + 1, 'admin detached although the user could not be dropped');
  assert.deepEqual(pendingSsoDrops(), [ssoUser]);
  assert.equal(execCalls.length, 0);
  await db('db_instances').where({ id: m1 }).update({ status: 'running' });
  await expireSsoSessions();
  assert.ok(execCalls.some((c) => (c.sql ?? '').includes(`DROP USER IF EXISTS '${ssoUser}'`)));
  assert.deepEqual(pendingSsoDrops(), []);

  // account being deleted: its sessions end and the admin containers leave its network at once
  r = await call('POST', `/databases/instances/${m1}/admin-session`, asManager, {});
  assert.equal(r.status, 200);
  await db('hosting_accounts').where({ id: acct.id }).update({ status: 'deleting' });
  before = disconnects();
  await expireSsoSessions();
  assert.equal(liveSsoSessions().length, 0);
  assert.equal(disconnects(), before + 1);
  await db('hosting_accounts').where({ id: acct.id }).update({ status: 'active' });
  const { detachAccountAdmins } = await import('./sso');
  r = await call('POST', `/databases/instances/${m1}/admin-session`, asManager, {});
  before = docker.calls.length;
  await detachAccountAdmins(docker.asDocker(), acct.id);
  assert.deepEqual(docker.calls.slice(before), [`disconnect oblimint-phpmyadmin oblimint-acct-${acct.id}-db`], '(Adminer was not attached: nothing to do)');
  assert.equal(liveSsoSessions().length, 0);
  await expireSsoSessions(); // drops the users

  // at most 10 live sessions per account
  for (let i = 0; i < 10; i++) {
    r = await call('POST', `/databases/instances/${m1}/admin-session`, asManager, {});
    assert.equal(r.status, 200, `session ${i}`);
  }
  r = await call('POST', `/databases/instances/${m1}/admin-session`, asManager, {});
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'rateLimited');
  await expireSsoSessions(Date.now() + 3 * 60 * 60_000);
  assert.equal(liveSsoSessions().length, 0);

  // ── deletes ────────────────────────────────────────────────────────────────
  r = await call('DELETE', `/databases/instances/${m1}/databases/${shopId}`, asManager, { confirm: 'nope' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'confirmMismatch');
  r = await call('DELETE', `/databases/instances/${m1}/users/${appId}`, asManager);
  assert.equal(r.status, 200);
  r = await call('DELETE', `/databases/instances/${m1}/databases/${shopId}`, asManager, { confirm: 'shop' });
  assert.equal(r.status, 200);
  assert.match(execCalls.at(-1)!.sql ?? '', /DROP DATABASE IF EXISTS `shop`/);
  r = await call('DELETE', `/databases/instances/${m2}`, asManager, { confirm: 'main' });
  assert.equal(r.status, 400);
  hostdCalls.length = 0;
  r = await call('DELETE', `/databases/instances/${m2}`, asManager, { confirm: 'second' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!docker.containers.has(`oblimint-db-${m2}`));
  assert.ok(hostdCalls.includes(`remove ${acct.id}/${m2} purge=true`));
  assert.equal((await db('db_instances').where({ id: m1 }).first()).is_default, true, 'the default passes to the remaining instance of the family');
  assert.ok(hostdCalls.includes(`default ${acct.id} mysql ${m1}`));
  r = await call('GET', `/databases/instances/${m2}`, asManager);
  assert.equal(r.status, 404);

  // ── hostd busy during a converge: deferred, never 'error' ─────────────────
  hostdFails.push({ op: 'ensure', err: new HostdError(409, 'account busy', 'busy') });
  r = await call('POST', `/databases/instances/${m1}/restart`, asManager);
  await settleConverges();
  row = await db('db_instances').where({ id: m1 }).first();
  assert.equal(row.status, 'running', `hostd busy is transient: ${row.status_message}`);
  assert.equal(hostdFails.length, 0, 'the busy answer was consumed');

  // ── failed purge: stays 'deleting', port kept, never recreated, retried ───
  assert.deepEqual((await databaseService.externalPorts(acct.id)).map((p) => p.port), [port2]);
  hostdFails.push({ op: 'remove', err: new Error('rm: I/O error') });
  r = await call('DELETE', `/databases/instances/${p1}`, asManager, { confirm: 'pg' });
  assert.equal(r.status, 502, JSON.stringify(r.body));
  row = await db('db_instances').where({ id: p1 }).first();
  assert.equal(row.status, 'deleting', 'never error: the converge would re-initialise the half-purged datadir');
  assert.match(row.status_message, /I\/O error/);
  assert.ok(!docker.containers.has(`oblimint-db-${p1}`));
  assert.deepEqual((await databaseService.externalPorts(acct.id)).map((p) => p.port), [port2], 'port kept in the firewall state until the row is gone');
  // Next reconcile pass: no container recreated, the deletion is resumed.
  hostdCalls.length = 0;
  await databaseReconcileHook.afterAccountPass(await state());
  await settleConverges();
  for (let i = 0; i < 50 && await db('db_instances').where({ id: p1 }).first(); i++) await new Promise((res) => setTimeout(res, 20));
  assert.ok(!docker.containers.has(`oblimint-db-${p1}`), 'never recreated');
  assert.equal(await db('db_instances').where({ id: p1 }).first(), undefined, 'deletion resumed by the reconcile');
  assert.ok(hostdCalls.includes(`remove ${acct.id}/${p1} purge=true`));
  assert.deepEqual(await databaseService.externalPorts(acct.id), []);
  // A row left 'deleting' by a crash (container still there): removed by the next pass too.
  await db('db_instances').where({ id: m1 }).update({ status: 'deleting' });
  assert.ok(docker.containers.has(`oblimint-db-${m1}`));
  await databaseReconcileHook.afterAccountPass(await state());
  for (let i = 0; i < 50 && await db('db_instances').where({ id: m1 }).first(); i++) await new Promise((res) => setTimeout(res, 20));
  assert.equal(await db('db_instances').where({ id: m1 }).first(), undefined);
  assert.ok(!docker.containers.has(`oblimint-db-${m1}`));
});
