import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// Commands in an application's container through an access key (scope
// apps.exec; keyStacks.exec, REST POST /api/v1/apps/stacks/:id/exec, MCP
// exec_in_app) on a real PostgreSQL: KEYEXEC_TEST_DATABASE_URL (default: the
// PGlite harness on port 55496; skipped when nothing listens). Docker =
// FakeAppDocker (apps deps): its exec handler plays the commands (output,
// stdin echoed, a command hanging until the kill sweep of its marker, a slow
// one). Covers: the scope (absent: 403; opt-in; granted only by a creator
// holding apps.console; the key gets apps.console and nothing else), the
// console's conditions (platform, tenant policy, plan: consoleDisabled with
// its reason; suspended: accountSuspended; contained: 423), the perimeter
// (another account / tenant: 404; a container without the stack's labels),
// a stopped container (409), the service, the .env secrets masked in the
// output and the audited command, stdin and env never in the audit nor a
// pending action, the timeout (processes killed), 2 commands at once per
// application (execBusy), the gate app.exec (open by default, the tenant's
// admin may protect it: the same call runs once approved).
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.KEYEXEC_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55496/postgres';

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

test('commands in the containers of the applications through an access key (REST + MCP)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL}`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-keyexec-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_P4B_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.OBLIMINT_SELF_CONTAINER = 'oblimint';
  process.env.SESSION_SECRET ||= 'keyexec-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const v1Routes = (await import('../../routes/v1.routes')).default;
  const { mcpRouter } = await import('./mcp');
  const { actorForUser } = await import('../hosting/access');
  const { apiKeysService } = await import('./apiKeys.service');
  const { keyStacks, runningExecs } = await import('./keyStacks');
  const { appsService } = await import('../apps/apps.service');
  const { appPolicyService } = await import('../apps/policy.service');
  const { consoleRefusal } = await import('../apps/consoleAccess');
  const { platformSettings } = await import('../platformSettings');
  const { restrictionService } = await import('../restrictions/restriction.service');
  const { twoFactorService } = await import('../twoFactor.service');
  const { DEFAULT_PLAN_LIMITS, defaultRestrictionsFor } = await import('@oblimint/shared');
  const { setEngineFactoryForTests } = await import('../docker/engine');
  const { setAppsDepsForTests } = await import('../apps/deps');
  const { FakeAppDocker, fakeAppsDeps } = await import('../apps/testing/fakeAppDocker');
  const { whenStackIdle, setUpdateStableMsForTests } = await import('../apps/deployments');
  const { EXEC_MARKER_VAR } = await import('../apps/exec');

  await db.migrate.latest();
  // The after hooks run in their order: the settings are put back before the pool is closed.
  const settingsBefore = await platformSettings.section('apps');
  t.after(async () => { await platformSettings.update({ apps: { consoleEnabled: settingsBefore.consoleEnabled } } as never); });
  t.after(async () => { await db.destroy(); });

  // ── fakes: Docker (apps + engine) ──
  const docker = new FakeAppDocker();
  docker.addContainer({ name: 'oblimint' });
  docker.addContainer({ name: 'oblimint-edge' });
  docker.remote.set('docker.io/library/nginx:1.27', `sha256:${'1'.repeat(64)}`);
  const localNode = await db('nodes').where({ is_local: true }).first('id') as { id: number };
  setEngineFactoryForTests(() => docker.asDocker(), localNode.id);
  const fake = fakeAppsDeps(docker);
  setAppsDepsForTests({ ...fake.deps, async probeTcp() { return true; }, async probeHttp() { return true; } });
  setUpdateStableMsForTests(0);
  t.after(() => {
    setEngineFactoryForTests(null);
    setAppsDepsForTests(null);
    setUpdateStableMsForTests(null);
  });
  await platformSettings.update({ apps: { consoleEnabled: true } } as never);

  // ── fixtures: tenant A (accounts acme, other), tenant B ──
  const suffix = Date.now().toString(36);
  const idOf = (r: unknown) => Number((r as { id?: number }).id ?? r);
  const tenant = async (n: string) => idOf((await db('tenants').insert({ name: `X ${n} ${suffix}`, slug: `x-${n}-${suffix}` }).returning('id'))[0]);
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
  const owner = await mkUser('execowner', tA, true);
  const noConsole = await mkUser('noconsole', tA, false);
  const otherUser = await mkUser('execother', tA, false);
  const bUser = await mkUser('execb', tB, false);
  const limits = { ...DEFAULT_PLAN_LIMITS, maxAppStacks: 4, maxAppContainers: 8, appsCpuCores: 4, appsMemoryMb: 2048, appsPidsPerContainer: 256, appsConsole: true };
  const plans: Record<number, number> = {};
  const mkAccount = async (tenantId: number, name: string) => {
    const planId = idOf((await db('plans').insert({ tenant_id: tenantId, name: `p-${name}-${suffix}`, limits: JSON.stringify(limits) }).returning('id'))[0]);
    const uid = 20000 + Math.floor(Math.random() * 30000);
    const id = idOf((await db('hosting_accounts').insert({
      tenant_id: tenantId, node_id: localNode.id, plan_id: planId, username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
      network_model: 'segmented',
    }).returning('id'))[0]);
    plans[id] = planId;
    return id;
  };
  const acme = await mkAccount(tA, 'xacme');
  const other = await mkAccount(tA, 'xother');
  const bAcct = await mkAccount(tB, 'xbacct');
  await db('account_users').insert([
    { user_id: owner, account_id: acme, capabilities: JSON.stringify(['sites.manage', 'apps.manage', 'apps.console']) },
    { user_id: noConsole, account_id: acme, capabilities: JSON.stringify(['sites.manage', 'apps.manage']) },
    { user_id: otherUser, account_id: other, capabilities: JSON.stringify(['apps.manage', 'apps.console']) },
    { user_id: bUser, account_id: bAcct, capabilities: JSON.stringify(['apps.manage', 'apps.console']) },
  ]);
  await restrictionService.setMap(tA, {});

  const fakeReq = (userId: number) => ({ headers: {}, query: {}, session: { userId }, socket: { remoteAddress: '203.0.113.9' } }) as never;
  const ownerActor = await actorForUser(owner, tA);
  const mkKey = async (name: string, scopes: string[]) => apiKeysService.create(fakeReq(owner), ownerActor, acme, { name, siteScope: 'all', scopes } as never);
  const kManage = await mkKey('manage', ['apps.manage']);
  const kExec = await mkKey('exec', ['apps.exec']);
  const kExec2 = await mkKey('exec2', ['apps.exec']);
  const ctxOf = async (k: { key: string | null }) => (await apiKeysService.verify(k.key!, '203.0.113.9'))!;

  // ── HTTP ──
  const app = express();
  app.use(express.json({ limit: '8mb' }));
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
    return { status: r.status, body: await r.json() as Json, headers: r.headers };
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

  // ── applications: web (one service, a secret in its .env), duo (two services); others' applications ──
  const SECRET = 'tok-7e6d5c4b3a2f-secret';
  const COMPOSE = 'services:\n  web:\n    image: nginx:1.27\n    expose: ["8080"]\n    environment:\n      API_TOKEN: ${API_TOKEN:?}\n';
  let r = await rest(kManage, 'POST', '/apps/stacks', { name: 'web', source: 'compose', composeYaml: COMPOSE, env: { API_TOKEN: SECRET } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const webId = r.body.data.app.id as number;
  await whenStackIdle(webId);
  r = await rest(kManage, 'POST', '/apps/stacks', {
    name: 'duo', source: 'compose', composeYaml: 'services:\n  web:\n    image: nginx:1.27\n  worker:\n    image: nginx:1.27\n',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const duoId = r.body.data.app.id as number;
  await whenStackIdle(duoId);
  const webContainer = `oblimint-app-${webId}-web`;
  assert.equal(docker.containers.get(webContainer)?.state, 'running');
  assert.equal(docker.containers.get(webContainer)?.labels['oblimint.app'], String(webId), 'labelled by the deploy');
  const otherApp = await appsService.create(fakeReq(otherUser), await actorForUser(otherUser, tA), {
    accountId: other, name: 'theirs', sourceType: 'editor', composeYaml: 'services:\n  web:\n    image: nginx:1.27\n', deploy: false,
  });
  const foreignApp = await appsService.create(fakeReq(bUser), await actorForUser(bUser, tB), {
    accountId: bAcct, name: 'foreign', sourceType: 'editor', composeYaml: 'services:\n  web:\n    image: nginx:1.27\n', deploy: false,
  });

  // The commands, played by the fake: by their first argument.
  const sweeps: string[][] = [];
  docker.execHandler = (_c, opts) => {
    const cmd = opts.Cmd ?? [];
    if (cmd[3] === 'oblimint-exec-kill') { sweeps.push(cmd); docker.killExecsWithMarker(cmd[4]); return { exitCode: 0 }; }
    if (cmd[0] === 'show-secret') return { exitCode: 0, stdout: `token is ${SECRET}\n`, stderr: `warn ${SECRET}\n` };
    if (cmd[0] === 'cat') return { exitCode: 0, echoStdin: true };
    if (cmd[0] === 'sleep') return { exitCode: 0, hangUntilKilled: true };
    if (cmd[0] === 'slow') return { exitCode: 0, stdout: 'done\n', delayMs: 700 };
    if (cmd[0] === 'fail') return { exitCode: 2, stderr: 'boom\n' };
    return { exitCode: 0, stdout: 'ok\n' };
  };

  // ── the scope: opt-in, absent → 403, granted only by who holds apps.console ──
  r = await rest(kManage, 'POST', `/apps/stacks/${webId}/exec`, { command: ['id'] });
  assert.deepEqual([r.status, r.body.code], [403, 'keyScope'], 'apps.manage is not apps.exec');
  let m = await tool(kManage, 'exec_in_app', { app_name: 'web', command: ['id'] });
  assert.match(m.text, /\(keyScope\)/);
  await assert.rejects(apiKeysService.create(fakeReq(noConsole), await actorForUser(noConsole, tA), acme, { name: 'x1', siteScope: 'all', scopes: ['apps.exec'] } as never),
    (e: { statusCode: number; code: string; details: { missing: string[] } }) => e.statusCode === 403 && e.code === 'capabilityNotHeld' && e.details.missing.includes('apps.exec'),
    'no apps.console: the scope cannot be granted');
  const grantable = await apiKeysService.grantable(await actorForUser(noConsole, tA), acme);
  assert.ok(grantable.scopes.includes('apps.manage') && !grantable.scopes.includes('apps.exec'));
  assert.ok((await apiKeysService.grantable(ownerActor, acme)).scopes.includes('apps.exec'));
  const execCtx = await ctxOf(kExec);
  assert.deepEqual([...(execCtx.actor.kind === 'client' ? execCtx.actor.accounts.get(acme) ?? [] : [])], ['apps.console'], 'apps.console and nothing else');
  m = await tool(kExec, 'deploy_app', { name: 'nope', source: 'compose', compose_yaml: 'services: {}' });
  assert.match(m.text, /\(keyScope\)/, 'apps.exec never deploys');
  m = await tool(kExec, 'app_logs', { app_name: 'web' });
  assert.match(m.text, /\(keyScope\)/, 'nor reads the logs');

  // ── a command (MCP): stdout / stderr apart, the exit code, the .env secrets masked ──
  m = await tool(kExec, 'exec_in_app', { app_name: 'web', command: ['show-secret'] });
  assert.equal(m.isError, false, m.text);
  let res = JSON.parse(m.text);
  assert.deepEqual([res.appId, res.service, res.exitCode, res.timedOut, res.killed], [webId, 'web', 0, false, null]);
  assert.equal(res.stdout, 'token is ********\n');
  assert.equal(res.stderr, 'warn ********\n');
  assert.deepEqual(res.truncated, { stdout: false, stderr: false });
  assert.ok(typeof res.durationMs === 'number');
  assert.ok(!m.text.includes(SECRET), 'masked');
  let audit = await lastAudit('apps.exec');
  assert.deepEqual([audit?.apiKey?.id, audit?.service, audit?.command, audit?.exitCode, audit?.timedOut], [kExec.id, 'web', 'show-secret', 0, false]);
  const execRun = docker.execRuns[docker.execRuns.length - 1];
  assert.equal(execRun.container, webContainer);
  assert.deepEqual([execRun.opts.Tty, execRun.opts.User], [false, undefined], 'no TTY, the image\'s user');
  m = await tool(kExec, 'exec_in_app', { app_name: 'web', command: 'fail now' });
  assert.equal(m.isError, false, m.text);
  assert.deepEqual(docker.execRuns[docker.execRuns.length - 1].opts.Cmd, ['sh', '-c', 'fail now'], 'a string: sh -c');

  // ── REST: stdin and env, never in the audit; a secret in the command masked in the audit ──
  const STDIN = 'admin@example.com\nStdin-Passw0rd-unique\n';
  const ENVV = 'Env-Passw0rd-unique';
  r = await rest(kExec, 'POST', `/apps/stacks/${webId}/exec`, {
    command: ['cat'], stdin: STDIN, env: { ADMIN_PASSWORD: ENVV, MODE: 'setup' }, workdir: '/srv', timeoutSeconds: 30,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.body.data.stdout, STDIN, 'stdin then EOF');
  const run = docker.execRuns[docker.execRuns.length - 1];
  assert.equal(run.stdin.toString(), STDIN);
  assert.deepEqual(run.opts.Env?.slice(0, 2), [`ADMIN_PASSWORD=${ENVV}`, 'MODE=setup']);
  assert.ok(run.opts.Env?.[2]?.startsWith(`${EXEC_MARKER_VAR}=`));
  assert.equal(run.opts.WorkingDir, '/srv');
  audit = await lastAudit('apps.exec');
  assert.deepEqual([audit?.command, audit?.stdinBytes, audit?.envNames, audit?.workdir, audit?.timeoutSeconds], ['cat', Buffer.byteLength(STDIN), ['ADMIN_PASSWORD', 'MODE'], '/srv', 30]);
  r = await rest(kExec, 'POST', `/apps/stacks/${webId}/exec`, { command: `echo ${SECRET} ${ENVV}`, env: { ADMIN_PASSWORD: ENVV } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  audit = await lastAudit('apps.exec');
  assert.equal(audit?.command, 'echo ******** ********', 'the .env secret and the env value masked in the audited command');
  r = await rest(kExec, 'POST', `/apps/stacks/${webId}/exec`, { command: ['id'], user: 'root' });
  assert.deepEqual([r.status, r.body.code], [400, 'validation'], 'never another user');
  r = await rest(kExec, 'POST', `/apps/stacks/${webId}/exec`, { command: ['id'], env: { OBLIMINT_EXEC_RUN: 'x' } });
  assert.deepEqual([r.status, r.body.code], [400, 'validation']);

  // ── the service ──
  m = await tool(kExec, 'exec_in_app', { app_name: 'duo', command: ['id'] });
  assert.match(m.text, /\(serviceRequired\)/);
  assert.deepEqual(detailsOf(m.text).services.sort(), ['web', 'worker']);
  m = await tool(kExec, 'exec_in_app', { app_name: 'duo', service: 'worker', command: ['id'] });
  assert.equal(m.isError, false, m.text);
  assert.equal(JSON.parse(m.text).service, 'worker');
  m = await tool(kExec, 'exec_in_app', { app_name: 'duo', service: 'ghost', command: ['id'] });
  assert.match(m.text, /\(serviceNotFound\)/);

  // ── the perimeter: another account, another tenant → 404; a container without the stack's labels ──
  for (const id of [otherApp.id, foreignApp.id]) {
    r = await rest(kExec, 'POST', `/apps/stacks/${id}/exec`, { command: ['id'] });
    assert.deepEqual([r.status, r.body.code], [404, 'notFound'], `app ${id}`);
  }
  m = await tool(kExec, 'exec_in_app', { app_name: 'theirs', command: ['id'] });
  assert.match(m.text, /\(notFound\)/, 'by name too');
  const labels = docker.containers.get(webContainer)!.labels;
  labels['oblimint.account'] = String(other);
  m = await tool(kExec, 'exec_in_app', { app_name: 'web', command: ['id'] });
  assert.match(m.text, /\(serviceNotFound\)/, 'only a container labelled with this stack and account');
  labels['oblimint.account'] = String(acme);

  // ── a stopped container → 409 ──
  docker.containers.get(webContainer)!.state = 'exited';
  r = await rest(kExec, 'POST', `/apps/stacks/${webId}/exec`, { command: ['id'] });
  assert.deepEqual([r.status, r.body.code], [409, 'containerNotRunning']);
  docker.containers.get(webContainer)!.state = 'running';
  const removed = docker.containers.get(webContainer)!;
  docker.containers.delete(webContainer);
  m = await tool(kExec, 'exec_in_app', { app_name: 'web', command: ['id'] });
  assert.match(m.text, /\(containerNotRunning\)/, 'a missing container');
  docker.containers.set(webContainer, removed);

  // ── the console's conditions: platform, tenant policy, plan (consoleDisabled + reason), suspended, contained ──
  const stackRow = { tenant_id: tA, account_id: acme };
  assert.equal(await consoleRefusal(stackRow), null);
  await platformSettings.update({ apps: { consoleEnabled: false } } as never);
  r = await rest(kExec, 'POST', `/apps/stacks/${webId}/exec`, { command: ['id'] });
  assert.deepEqual([r.status, r.body.code, r.body.details?.reason], [403, 'consoleDisabled', 'platform']);
  await platformSettings.update({ apps: { consoleEnabled: true } } as never);
  await appPolicyService.set(fakeReq(owner), tA, { allowConsole: false });
  m = await tool(kExec, 'exec_in_app', { app_name: 'web', command: ['id'] });
  assert.match(m.text, /\(consoleDisabled\)/);
  assert.equal(detailsOf(m.text).reason, 'policy');
  await appPolicyService.set(fakeReq(owner), tA, { allowConsole: null });
  await db('plans').where({ id: plans[acme] }).update({ limits: JSON.stringify({ ...limits, appsConsole: false }) });
  r = await rest(kExec, 'POST', `/apps/stacks/${webId}/exec`, { command: ['id'] });
  assert.deepEqual([r.status, r.body.code, r.body.details?.reason], [403, 'consoleDisabled', 'plan']);
  assert.equal(await consoleRefusal(stackRow), 'plan', 'the very function of the panel\'s console');
  await db('plans').where({ id: plans[acme] }).update({ limits: JSON.stringify(limits) });
  await db('hosting_accounts').where({ id: acme }).update({ status: 'suspended' });
  r = await rest(kExec, 'POST', `/apps/stacks/${webId}/exec`, { command: ['id'] });
  assert.deepEqual([r.status, r.body.code], [409, 'accountSuspended']);
  await db('hosting_accounts').where({ id: acme }).update({ status: 'active' });
  const liveExec = await ctxOf(kExec);
  await db('hosting_accounts').where({ id: acme }).update({ contained_at: new Date() });
  r = await rest(kExec, 'POST', `/apps/stacks/${webId}/exec`, { command: ['id'] });
  assert.deepEqual([r.status, r.body.code], [423, 'accountContained']);
  await assert.rejects(keyStacks.exec(liveExec, fakeReq(owner), { id: webId }, { command: ['id'] }), (e: { statusCode: number }) => e.statusCode === 423, 'a key still in hand');
  await db('hosting_accounts').where({ id: acme }).update({ contained_at: null });
  const execsBefore = docker.execRuns.length;

  // ── timeout: the processes of the command killed ──
  const started = Date.now();
  m = await tool(kExec, 'exec_in_app', { app_name: 'web', command: ['sleep', '1000'], timeout_seconds: 1 });
  assert.equal(m.isError, false, m.text);
  res = JSON.parse(m.text);
  assert.deepEqual([res.timedOut, res.killed, res.exitCode], [true, true, 137]);
  assert.ok(Date.now() - started < 10_000);
  assert.equal(sweeps.length, 1, 'one kill sweep');
  assert.equal(docker.execRuns.length, execsBefore + 2, 'the command, then the sweep: nothing ran while refused');
  assert.equal(docker.execRuns[execsBefore].running, false, 'stopped');
  audit = await lastAudit('apps.exec');
  assert.deepEqual([audit?.timedOut, audit?.killed], [true, true]);

  // ── 2 commands at once per application (every key together) ──
  const slow = [tool(kExec, 'exec_in_app', { app_name: 'web', command: ['slow'] }), tool(kExec2, 'exec_in_app', { app_name: 'web', command: ['slow'] })];
  for (let i = 0; i < 50 && runningExecs(webId) < 2; i++) await new Promise((res2) => setTimeout(res2, 20));
  assert.equal(runningExecs(webId), 2);
  r = await rest(kExec, 'POST', `/apps/stacks/${webId}/exec`, { command: ['id'] });
  assert.deepEqual([r.status, r.body.code], [429, 'execBusy']);
  m = await tool(kExec, 'exec_in_app', { app_name: 'duo', service: 'web', command: ['id'] });
  assert.equal(m.isError, false, 'another application is not held');
  for (const p of await Promise.all(slow)) assert.equal(JSON.parse(p.text).stdout, 'done\n');
  assert.equal(runningExecs(webId), 0, 'the slots are given back');

  // ── the gate app.exec: open by default (the defaults never protect it), protected by the tenant's admin ──
  await restrictionService.setMap(tA, defaultRestrictionsFor(false));
  m = await tool(kExec, 'exec_in_app', { app_name: 'web', command: ['id'] });
  assert.equal(m.isError, false, 'never a 2FA by default');
  await restrictionService.setMap(tA, { ...defaultRestrictionsFor(false), 'app.exec': { level: 'sensitive', scope: { mode: 'all' }, via: 'keys' } });
  const GATED_STDIN = 'Gated-Stdin-Passw0rd';
  const GATED_ENV = 'Gated-Env-Passw0rd';
  const before = docker.execRuns.length;
  const gatedArgs = { app_name: 'web', command: ['cat'], stdin: GATED_STDIN, env: { PW: GATED_ENV } };
  m = await tool(kExec, 'exec_in_app', gatedArgs);
  assert.match(m.text, /\(twoFactorRequired\)/);
  const d = detailsOf(m.text);
  assert.equal(d.action, 'app.exec');
  assert.ok(String(d.description).startsWith('Exécuter une commande dans l’application Docker « web » (service web) : cat'), String(d.description));
  assert.equal(docker.execRuns.length, before, 'nothing ran');
  assert.equal(runningExecs(webId), 0, 'the slot is given back');
  m = await tool(kExec, 'exec_in_app', { ...gatedArgs, stdin: 'another stdin' });
  assert.match(m.text, /\(twoFactorRequired\)/);
  assert.notEqual(Number(detailsOf(m.text).pendingActionId), Number(d.pendingActionId), 'another stdin, another request');
  await approve(Number(d.pendingActionId));
  m = await tool(kExec, 'exec_in_app', { ...gatedArgs, approval_id: Number(d.pendingActionId) });
  assert.equal(m.isError, false, m.text);
  assert.equal(JSON.parse(m.text).stdout, GATED_STDIN);
  assert.equal((await db('pending_actions').where({ id: Number(d.pendingActionId) }).first('status')).status, 'consumed');
  m = await tool(kExec, 'exec_in_app', gatedArgs);
  assert.match(m.text, /\(twoFactorRequired\)/, 'ran once: a new request');
  await restrictionService.setMap(tA, {});

  // ── secrets: stdin and env values never in the audit nor in a pending action ──
  const auditAll = await auditText();
  const pendingAll = await pendingText();
  for (const s of [SECRET, STDIN.trim().split('\n')[1], ENVV, GATED_STDIN, GATED_ENV, Buffer.from(GATED_STDIN).toString('base64')]) {
    assert.ok(!auditAll.includes(s), `never audited: ${s}`);
    assert.ok(!pendingAll.includes(s), `never in a pending action: ${s}`);
  }
  assert.ok(auditAll.includes('"envNames":["PW"]'), 'the names of env only');

  // ── the creator loses apps.console: the scope is inactive at once ──
  await db('account_users').where({ user_id: owner, account_id: acme }).update({ capabilities: JSON.stringify(['sites.manage', 'apps.manage']) });
  r = await rest(kExec, 'POST', `/apps/stacks/${webId}/exec`, { command: ['id'] });
  assert.deepEqual([r.status, r.body.code], [403, 'keyScope']);
});
