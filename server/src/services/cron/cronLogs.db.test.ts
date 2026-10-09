import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { PassThrough } from 'stream';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of module cron-logs on a PGlite server (docs/P2-PLAN.md §12:
// cron-logs = port 55446):
//   PG_PORT=55446 node <scratchpad>/pg/pgserver.mjs
// CRON_LOGS_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. Docker = a small fake (engine seam). Covers the HTTP routes of
// §6.6 / §6.7 with their access checks (invisible → 404, visible without
// sites.manage → 403), the plan limits, name uniqueness, manual runs (202,
// cronRunning, siteNotRunning), the scheduler pass (due jobs, overlap →
// skipped, suspended account), boot recovery, run retention, and the log
// routes (persisted access days, download, container logs).
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.CRON_LOGS_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55446/postgres';

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

function frame(stream: 1 | 2, payload: string): Buffer {
  const body = Buffer.from(payload);
  const h = Buffer.alloc(8);
  h.writeUInt8(stream, 0);
  h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
}

/** Minimal dockerode fake: containers (inspect / exec / logs) + listContainers. */
class CronFakeDocker {
  containers = new Map<string, { running: boolean; labels: Record<string, string>; logs?: Buffer }>();
  /** Next exec outcome per container; `hold` keeps the stream open until released. */
  execPlan = new Map<string, { exitCode: number; out?: string; hold?: boolean }>();
  execs: Array<Record<string, unknown>> = [];
  held: Array<() => void> = [];
  modem: { demuxStream: (s: NodeJS.ReadableStream, o: NodeJS.WritableStream, e: NodeJS.WritableStream) => void };

  constructor(demux: CronFakeDocker['modem']['demuxStream']) {
    this.modem = { demuxStream: demux };
  }

  async listContainers() {
    return [...this.containers.entries()].map(([name, c]) => ({ Id: name, Names: [`/${name}`], State: c.running ? 'running' : 'exited', Labels: c.labels }));
  }

  getContainer(name: string) {
    const self = this;
    const need = () => {
      const c = self.containers.get(name);
      if (!c) throw Object.assign(new Error(`No such container: ${name}`), { statusCode: 404 });
      return c;
    };
    return {
      async inspect() { return { State: { Running: need().running } }; },
      async logs() { return need().logs ?? Buffer.alloc(0); },
      async exec(opts: Record<string, unknown>) {
        need();
        self.execs.push({ container: name, ...opts });
        const plan = self.execPlan.get(name) ?? { exitCode: 0, out: 'ok\n' };
        return {
          async start() {
            const s = new PassThrough();
            const finish = () => {
              if (plan.out) s.write(frame(1, plan.out));
              s.end();
            };
            if (plan.hold) self.held.push(finish);
            else setImmediate(finish);
            return s;
          },
          async inspect() { return { ExitCode: plan.exitCode, Running: false }; },
        };
      },
    };
  }
}

test('cron + logs routes on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55446)`);
    return;
  }
  const base = process.env.OBLIMINT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const dataRoot = fs.mkdtempSync(path.join(base, 'oblimint-cronlogs-db-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  // Before ANY import of config / db.
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.OBLIMINT_LOGS_DIR = path.join(dataRoot, 'logs');
  process.env.SESSION_SECRET ||= 'cron-logs-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const Docker = (await import('dockerode')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const cronRoutes = (await import('../../routes/cron.routes')).default;
  const logsRoutes = (await import('../../routes/logs.routes')).default;
  const { setEngineFactoryForTests } = await import('../docker/engine');
  const { schedulerTick, recoverInterruptedRuns, purgeRuns, drainRunsForTests, INTERRUPTED_OUTPUT, RECOVERY_MARGIN_MS } = await import('./cron.service');
  const { killSweepArgv, RUN_MARKER_VAR } = await import('./executor');
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  const real = new Docker({ socketPath: '/nonexistent/docker.sock' });
  const docker = new CronFakeDocker(real.modem.demuxStream.bind(real.modem));
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number };
  setEngineFactoryForTests(() => docker as never, localNode.id);
  t.after(() => setEngineFactoryForTests(null));

  // ── fixtures ───────────────────────────────────────────────────────────────
  const suffix = Date.now().toString(36);
  const idOf = (r: { id?: number } | number) => Number((r as { id?: number }).id ?? r);
  const tA = idOf((await db('tenants').insert({ name: `A ${suffix}`, slug: `a-${suffix}` }).returning('id'))[0]);
  const tB = idOf((await db('tenants').insert({ name: `B ${suffix}`, slug: `b-${suffix}` }).returning('id'))[0]);
  const user = async (name: string, kind: 'staff' | 'client', tenantId: number, tenantRole = 'admin') => {
    const id = idOf((await db('users').insert({ username: `${name}-${suffix}`, kind, role: 'user', is_active: true }).returning('id'))[0]);
    if (kind === 'staff') await db('user_tenants').insert({ user_id: id, tenant_id: tenantId, role: tenantRole });
    return id;
  };
  const adminA = await user('adm', 'staff', tA, 'admin');
  const viewerA = await user('view', 'staff', tA, 'viewer');
  const staffB = await user('stb', 'staff', tB, 'admin');
  const clientRead = await user('cr', 'client', tA);
  const clientManage = await user('cm', 'client', tA);

  const planId = idOf((await db('plans').insert({
    tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify({ ...DEFAULT_PLAN_LIMITS, maxCronJobs: 2, cronMinIntervalMin: 5 }),
  }).returning('id'))[0]);
  const uid = 20000 + Math.floor(Math.random() * 30000);
  const accountId = idOf((await db('hosting_accounts').insert({
    tenant_id: tA, node_id: localNode.id, plan_id: planId, username: `acme${suffix}`.slice(0, 30), uid, gid: uid, status: 'active',
    filesrv_mode: 'off',
  }).returning('id'))[0]);
  const site = async (slug: string) => idOf((await db('sites').insert({
    tenant_id: tA, account_id: accountId, name: slug, slug, base: 'apache-php8.3', status: 'active',
  }).returning('id'))[0]);
  const siteId = await site('blog');
  const site2 = await site('shop');
  await db('account_users').insert([
    { user_id: clientRead, account_id: accountId, capabilities: JSON.stringify([]) },
    { user_id: clientManage, account_id: accountId, capabilities: JSON.stringify(['sites.manage']) },
  ]);

  // ── app ────────────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: Number(req.header('x-user')) };
    (req as unknown as { tenantId: number }).tenantId = Number(req.header('x-tenant'));
    next();
  });
  app.use('/sites', cronRoutes);
  app.use('/sites', logsRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  type Who = { user: number; tenant: number };
  const A: Who = { user: adminA, tenant: tA };
  const call = async (method: string, url: string, who: Who, body?: unknown) => {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-user': String(who.user), 'x-tenant': String(who.tenant) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* text body */ }
    return { status: res.status, body: json, text, headers: res.headers };
  };

  // ── cron: access ───────────────────────────────────────────────────────────
  const job = { name: 'Laravel', schedule: '*/5 * * * *', command: 'php artisan schedule:run' };
  assert.equal((await call('POST', `/sites/${siteId}/cron`, { user: staffB, tenant: tB }, job)).status, 404);
  assert.equal((await call('POST', `/sites/${siteId}/cron`, { user: clientRead, tenant: tA }, job)).status, 403);
  assert.equal((await call('POST', `/sites/${siteId}/cron`, { user: viewerA, tenant: tA }, job)).status, 403);
  assert.equal((await call('GET', `/sites/${siteId}/cron`, { user: staffB, tenant: tB })).status, 404);
  assert.equal((await call('GET', `/sites/abc/cron`, A)).status, 404);

  // ── cron: validation and plan ──────────────────────────────────────────────
  let r = await call('POST', `/sites/${siteId}/cron`, A, { ...job, schedule: '*/5 * * * * *' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'cronInvalidSchedule');
  r = await call('POST', `/sites/${siteId}/cron`, A, { ...job, schedule: '* * * * *' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'cronTooFrequent');
  assert.equal(r.body.details.minIntervalMin, 5);
  r = await call('POST', `/sites/${siteId}/cron`, A, { ...job, command: 'x'.repeat(1001) });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'commandTooLong');
  r = await call('POST', `/sites/${siteId}/cron`, A, { ...job, timeoutSec: 5 });
  assert.equal(r.status, 400);

  r = await call('POST', `/sites/${siteId}/cron`, { user: clientManage, tenant: tA }, job);
  assert.equal(r.status, 201, r.text);
  const job1 = r.body.data;
  assert.equal(job1.timeoutSec, 300);
  assert.equal(job1.enabled, true);
  assert.ok(job1.nextRunAt && Date.parse(job1.nextRunAt) > Date.now());
  assert.equal(job1.accountId, accountId);

  r = await call('POST', `/sites/${siteId}/cron`, A, { ...job, schedule: '@daily' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'cronNameTaken');

  r = await call('POST', `/sites/${site2}/cron`, A, { ...job, schedule: '@hourly', timeoutSec: 30 });
  assert.equal(r.status, 201, r.text);
  const job2 = r.body.data;
  // maxCronJobs counts the whole ACCOUNT (two sites).
  r = await call('POST', `/sites/${siteId}/cron`, A, { ...job, name: 'third' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'planLimit');

  r = await call('GET', `/sites/${siteId}/cron`, { user: clientRead, tenant: tA });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map((j: { id: number }) => j.id), [job1.id]);

  // ── cron: update / delete ──────────────────────────────────────────────────
  assert.equal((await call('PUT', `/sites/${site2}/cron/${job1.id}`, A, { enabled: false })).status, 404); // job of another site
  assert.equal((await call('PUT', `/sites/${siteId}/cron/${job1.id}`, { user: clientRead, tenant: tA }, { enabled: false })).status, 403);
  r = await call('PUT', `/sites/${siteId}/cron/${job1.id}`, A, { enabled: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.nextRunAt, null);
  r = await call('PUT', `/sites/${siteId}/cron/${job1.id}`, A, { enabled: true, schedule: '0 3 * * *' });
  assert.match(r.body.data.nextRunAt, /T03:00:00\.000Z$/);
  r = await call('PUT', `/sites/${siteId}/cron/${job1.id}`, A, { schedule: '*/2 * * * *' });
  assert.equal(r.body.code, 'cronTooFrequent');

  // ── manual run ─────────────────────────────────────────────────────────────
  r = await call('POST', `/sites/${siteId}/cron/${job1.id}/run`, A);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'siteNotRunning'); // no container yet
  docker.containers.set(`oblimint-site-${siteId}`, { running: true, labels: { 'oblimint.site': String(siteId), 'oblimint.account': String(accountId), 'oblimint.role': 'site' } });
  assert.equal((await call('POST', `/sites/${siteId}/cron/${job1.id}/run`, { user: clientRead, tenant: tA })).status, 403);
  docker.execPlan.set(`oblimint-site-${siteId}`, { exitCode: 0, out: 'Running scheduled command\n' });
  r = await call('POST', `/sites/${siteId}/cron/${job1.id}/run`, A);
  assert.equal(r.status, 202, r.text);
  assert.equal(r.body.data.status, 'running');
  assert.equal(r.body.data.trigger, 'manual');
  await drainRunsForTests();
  const exec = docker.execs.at(-1)!;
  assert.equal(exec.User, `${uid}:${uid}`);
  assert.equal(exec.WorkingDir, '/srv/releases/current');
  assert.deepEqual(exec.Cmd, ['timeout', '-s', 'KILL', '300', 'sh', '-c', 'php artisan schedule:run']);
  r = await call('GET', `/sites/${siteId}/cron/${job1.id}/runs?limit=10`, { user: clientRead, tenant: tA });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.total, 1);
  assert.equal(r.body.data.items[0].status, 'success');
  assert.equal(r.body.data.items[0].summary, 'Running scheduled command');
  const runId = r.body.data.items[0].id;
  r = await call('GET', `/sites/${siteId}/cron/runs/${runId}`, { user: clientRead, tenant: tA });
  assert.equal(r.body.data.output, 'Running scheduled command\n');
  assert.equal(r.body.data.exitCode, 0);
  assert.equal((await call('GET', `/sites/${site2}/cron/runs/${runId}`, A)).status, 404); // run of another site
  assert.equal((await call('GET', `/sites/${siteId}/cron/runs/${runId}`, { user: staffB, tenant: tB })).status, 404);
  const jobRow = await db('cron_jobs').where({ id: job1.id }).first();
  assert.equal(jobRow.last_status, 'success');

  // Overlap: a held run → second manual run 409, scheduler pass records 'skipped'.
  docker.execPlan.set(`oblimint-site-${siteId}`, { exitCode: 1, out: 'boom\n', hold: true });
  r = await call('POST', `/sites/${siteId}/cron/${job1.id}/run`, A);
  assert.equal(r.status, 202);
  for (let i = 0; i < 50 && docker.held.length === 0; i++) await new Promise((res) => setTimeout(res, 10));
  r = await call('POST', `/sites/${siteId}/cron/${job1.id}/run`, A);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'cronRunning');
  await db('cron_jobs').where({ id: job1.id }).update({ next_run_at: new Date(Date.now() - 1000) });
  await schedulerTick();
  const skipped = await db('cron_runs').where({ job_id: job1.id, status: 'skipped' }).first();
  assert.ok(skipped, 'overlap recorded as skipped');
  assert.match(skipped.output, /toujours en cours/);
  const advanced = await db('cron_jobs').where({ id: job1.id }).first('next_run_at');
  assert.ok(new Date(advanced.next_run_at).getTime() > Date.now());
  for (const release of docker.held.splice(0)) release();
  await drainRunsForTests();
  assert.equal((await db('cron_jobs').where({ id: job1.id }).first('last_status')).last_status, 'failed');

  // Scheduler: a due job of a site whose container is stopped → skipped with the reason.
  docker.containers.get(`oblimint-site-${siteId}`)!.running = false;
  await db('cron_jobs').where({ id: job1.id }).update({ next_run_at: new Date(Date.now() - 1000) });
  await schedulerTick();
  await drainRunsForTests();
  const last = await db('cron_runs').where({ job_id: job1.id }).orderBy('id', 'desc').first();
  assert.equal(last.status, 'skipped');
  assert.match(last.output, /arrêté/);
  docker.containers.get(`oblimint-site-${siteId}`)!.running = true;

  // Scheduler: suspended account → next run advanced, no execution, ONE 'skipped' run with
  // the reason per suspension (a second due pass does not add another).
  await db('hosting_accounts').where({ id: accountId }).update({ status: 'suspended' });
  const before = Number((await db('cron_runs').where({ job_id: job1.id }).count('id as n'))[0].n);
  const execsBefore = docker.execs.length;
  await db('cron_jobs').where({ id: job1.id }).update({ next_run_at: new Date(Date.now() - 1000) });
  await schedulerTick();
  await drainRunsForTests();
  assert.equal(Number((await db('cron_runs').where({ job_id: job1.id }).count('id as n'))[0].n), before + 1);
  const susp = await db('cron_runs').where({ job_id: job1.id }).orderBy('id', 'desc').first();
  assert.equal(susp.status, 'skipped');
  assert.match(susp.output, /compte suspendu/);
  assert.equal((await db('cron_jobs').where({ id: job1.id }).first('last_status')).last_status, 'skipped');
  await db('cron_jobs').where({ id: job1.id }).update({ next_run_at: new Date(Date.now() - 1000) });
  await schedulerTick();
  await drainRunsForTests();
  assert.equal(Number((await db('cron_runs').where({ job_id: job1.id }).count('id as n'))[0].n), before + 1);
  assert.equal(docker.execs.length, execsBefore, 'nothing executed while suspended');
  assert.ok(new Date((await db('cron_jobs').where({ id: job1.id }).first('next_run_at')).next_run_at).getTime() > Date.now());
  r = await call('POST', `/sites/${siteId}/cron/${job1.id}/run`, A);
  assert.equal(r.body.code, 'siteNotRunning');
  await db('hosting_accounts').where({ id: accountId }).update({ status: 'active' });

  // Boot recovery.
  const [orphan] = await db('cron_runs').insert({ job_id: job2.id, site_id: site2, status: 'running', trigger: 'schedule' }).returning('id');
  assert.ok((await recoverInterruptedRuns()) >= 1);
  const rec = await db('cron_runs').where({ id: idOf(orphan) }).first();
  assert.equal(rec.status, 'failed');
  assert.equal(rec.output, INTERRUPTED_OUTPUT);
  assert.ok(rec.finished_at);

  // C1': the marker of every run is persisted (the exec env carries the same one)…
  // (a claimed run skipped because the container was stopped also carries a marker but never
  // executed: look at the last run that actually reached the exec.)
  const lastRun = await db('cron_runs').whereNotNull('run_marker').whereNotIn('status', ['skipped', 'running']).orderBy('id', 'desc').first();
  assert.ok(lastRun, 'runs carry their marker');
  const envOf = (e: Record<string, unknown>) => ((e.Env as string[] | undefined) ?? []).find((v) => v.startsWith(`${RUN_MARKER_VAR}=`));
  assert.ok(docker.execs.some((e) => envOf(e) === `${RUN_MARKER_VAR}=${lastRun.run_marker}`), 'the exec ran with the persisted marker');
  // …so a run of a previous process still alive in a running container is KILLED before it is failed.
  const marker = 'abcdef0123456789abcdef01';
  const [alive] = await db('cron_runs').insert({ job_id: job1.id, site_id: siteId, status: 'running', trigger: 'schedule', run_marker: marker }).returning('id');
  docker.execPlan.set(`oblimint-site-${siteId}`, { exitCode: 0 }); // the sweep exec completes at once
  const sweepsBefore = docker.execs.length;
  assert.equal(await recoverInterruptedRuns(), 1);
  const sweeps = docker.execs.slice(sweepsBefore);
  assert.deepEqual(sweeps.map((e) => e.Cmd), [killSweepArgv(marker)]);
  assert.equal(sweeps[0].container, `oblimint-site-${siteId}`);
  assert.equal((await db('cron_runs').where({ id: idOf(alive) }).first()).status, 'failed');
  // Without a marker (cannot be killed): kept 'running' — no second run of the job — until past its timeout.
  const [legacy] = await db('cron_runs').insert({ job_id: job1.id, site_id: siteId, status: 'running', trigger: 'schedule' }).returning('id');
  assert.equal(await recoverInterruptedRuns(), 0);
  assert.equal((await db('cron_runs').where({ id: idOf(legacy) }).first()).status, 'running');
  r = await call('POST', `/sites/${siteId}/cron/${job1.id}/run`, A);
  assert.equal(r.status, 409, 'no overlap with the interrupted run');
  assert.equal(r.body.code, 'cronRunning');
  assert.equal(await recoverInterruptedRuns(new Date(Date.now() + 3600_000 + RECOVERY_MARGIN_MS + 1000)), 1);
  assert.equal((await db('cron_runs').where({ id: idOf(legacy) }).first()).status, 'failed');

  // Retention: 100 runs per job, 30 days.
  const old = new Date(Date.now() - 40 * 86_400_000);
  await db('cron_runs').insert(Array.from({ length: 110 }, (_, i) => ({
    job_id: job2.id, site_id: site2, status: 'success', trigger: 'schedule',
    started_at: i < 5 ? old : new Date(Date.now() - (200 - i) * 60_000), finished_at: new Date(),
  })));
  await purgeRuns();
  assert.equal(Number((await db('cron_runs').where({ job_id: job2.id }).count('id as n'))[0].n), 100);
  assert.equal(Number((await db('cron_runs').where({ job_id: job2.id }).andWhere('started_at', '<', new Date(Date.now() - 30 * 86_400_000)).count('id as n'))[0].n), 0);

  // Delete + audit (site's tenant).
  assert.equal((await call('DELETE', `/sites/${siteId}/cron/${job1.id}`, { user: clientRead, tenant: tA })).status, 403);
  r = await call('DELETE', `/sites/${siteId}/cron/${job1.id}`, { user: clientManage, tenant: tA });
  assert.deepEqual(r.body.data, { deleted: true });
  assert.equal(Number((await db('cron_runs').where({ job_id: job1.id }).count('id as n'))[0].n), 0);
  const actions = (await db('audit_logs').where({ tenant_id: tA }).whereIn('action', ['cron.create', 'cron.update', 'cron.delete', 'cron.run']).select('action')).map((x: { action: string }) => x.action);
  for (const a of ['cron.create', 'cron.update', 'cron.delete', 'cron.run']) assert.ok(actions.includes(a), a);

  // ── logs ───────────────────────────────────────────────────────────────────
  assert.equal((await call('GET', `/sites/${siteId}/logs?source=access`, { user: staffB, tenant: tB })).status, 404);
  r = await call('GET', `/sites/${siteId}/logs?source=bogus`, { user: clientRead, tenant: tA });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'logSourceInvalid');
  r = await call('GET', `/sites/${siteId}/logs?source=access&since=yesterday`, { user: clientRead, tenant: tA });
  assert.equal(r.body.code, 'logDateInvalid');
  r = await call('GET', `/sites/${siteId}/logs?source=access`, { user: clientRead, tenant: tA });
  assert.deepEqual(r.body.data, { siteId, source: 'access', lines: [], truncated: false });

  const dir = path.join(dataRoot, 'logs', String(accountId), String(siteId));
  fs.mkdirSync(dir, { recursive: true });
  const line = (uri: string, status: number) => JSON.stringify({ time: '2026-03-09T10:00:00.000Z', host: 'blog.test', remoteAddr: '203.0.113.5', method: 'GET', uri, status, bytes: 10, requestTime: 0.01, userAgent: 'ua' });
  fs.writeFileSync(path.join(dir, 'access-2026-03-09.log.gz'), zlib.gzipSync(`${line('/a', 200)}\n${line('/b', 500)}\n`));
  // Another site's day in the same account: never served for siteId.
  fs.mkdirSync(path.join(dataRoot, 'logs', String(accountId), String(site2)), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'logs', String(accountId), String(site2), 'access-2026-03-09.log'), `${line('/secret', 200)}\n`);

  r = await call('GET', `/sites/${siteId}/logs?source=access&status=5xx`, { user: clientRead, tenant: tA });
  assert.deepEqual(r.body.data.lines.map((l: { access: { uri: string } }) => l.access.uri), ['/b']);
  r = await call('GET', `/sites/${siteId}/logs/files`, { user: clientRead, tenant: tA });
  assert.equal(r.body.data.length, 1);
  assert.equal(r.body.data[0].date, '2026-03-09');
  r = await call('GET', `/sites/${siteId}/logs/download?source=access&date=2026-03-09`, { user: clientRead, tenant: tA });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /^text\/plain/);
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="site-blog-access-2026-03-09.log"');
  assert.equal(r.text, `${line('/a', 200)}\n${line('/b', 500)}\n`);
  assert.equal((await call('GET', `/sites/${siteId}/logs/download?source=access&date=2026-13-01`, A)).body.code, 'logDateInvalid');
  assert.equal((await call('GET', `/sites/${siteId}/logs/download?source=access&date=2026-03-01`, A)).status, 404);
  assert.equal((await call('GET', `/sites/${siteId}/logs/download?source=access&date=2026-03-09`, { user: staffB, tenant: tB })).status, 404);

  // Container logs (error = stderr of every site container).
  docker.containers.get(`oblimint-site-${siteId}`)!.logs = Buffer.concat([
    frame(2, '2026-03-10T10:00:00.000000000Z PHP Warning: one\n2026-03-10T10:00:02.000000000Z PHP Fatal: two\n'),
  ]);
  docker.containers.set(`oblimint-site-${siteId}-preview`, {
    running: true,
    labels: { 'oblimint.site': String(siteId), 'oblimint.account': String(accountId), 'oblimint.role': 'site-preview' },
    logs: frame(2, '2026-03-10T10:00:01.000000000Z preview warning\n'),
  });
  r = await call('GET', `/sites/${siteId}/logs?source=error`, { user: clientRead, tenant: tA });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.data.lines.map((l: { container: string; text: string }) => `${l.container}:${l.text}`),
    ['primary:PHP Warning: one', 'preview:preview warning', 'primary:PHP Fatal: two']);
  r = await call('GET', `/sites/${siteId}/logs?source=error&q=fatal`, { user: clientRead, tenant: tA });
  assert.deepEqual(r.body.data.lines.map((l: { text: string }) => l.text), ['PHP Fatal: two']);
  // Download = last 24 h only.
  const recent = new Date(Date.now() - 3600_000).toISOString();
  docker.containers.get(`oblimint-site-${siteId}`)!.logs = Buffer.concat([
    frame(2, '2026-03-10T10:00:00.000000000Z too old\n'), frame(2, `${recent} recent error\n`),
  ]);
  r = await call('GET', `/sites/${siteId}/logs/download?source=error`, { user: clientRead, tenant: tA });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition') ?? '', /^attachment; filename="site-blog-error-\d{4}-\d{2}-\d{2}\.log"$/);
  assert.equal(r.text, `${recent} [primary] recent error\n`);
  r = await call('GET', `/sites/${site2}/logs?source=app`, A);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'siteNotRunning');
});
