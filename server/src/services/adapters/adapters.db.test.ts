import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type Docker from 'dockerode';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of module adapters on a PGlite server (docs/P3-PLAN.md §15:
// adapters = port 55454):
//   PG_PORT=55454 node <scratchpad>/pg/pgserver.mjs
// ADAPTERS_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. Every other module is faked (setAdapterDepsForTests). Covers the
// routes of §6.5 with their access rules (invisible → 404, no right → 403),
// the refusals (adaptersDisabled, adapterNotDetected, windowActive,
// publishInProgress, noRelease, siteStopped, accountSuspended), one run in
// flight per site (adapterBusy), the run detail (A6: CLI output only for
// releases.publish, raw causes hidden from clients), schedules CRUD +
// scheduler pass, boot recovery (runs in flight, orphan workspaces / containers).
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.ADAPTERS_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55454/postgres';

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

test('adapters routes on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55454)`);
    return;
  }
  const base = process.env.OBLIMINT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const dataRoot = fs.mkdtempSync(path.join(base, 'oblimint-adapters-db-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  // Before ANY import of config / db.
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'adapters-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const adaptersRoutes = (await import('../../routes/adapters.routes')).default;
  const { setEngineFactoryForTests } = await import('../docker/engine');
  const { localPaths } = await import('../hosting/paths');
  const { platformSettings } = await import('../platformSettings');
  const { setAdapterDepsForTests } = await import('./deps');
  const { drainRunsForTests, recoverInterruptedRuns, resumeDeferredRuns, schedulerTick } = await import('./adapter.service');
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // ── fakes ──────────────────────────────────────────────────────────────────
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number };
  const toolsContainers = new Map<string, Record<string, string>>();
  const removedContainers: string[] = [];
  const fakeDocker = {
    listContainers: async () => [...toolsContainers.entries()].map(([name, labels]) => ({ Id: name, Names: [`/${name}`], Labels: labels })),
    getContainer: (name: string) => ({ remove: async () => { removedContainers.push(name); toolsContainers.delete(name); } }),
  };
  setEngineFactoryForTests(() => fakeDocker as never, localNode.id);
  t.after(() => setEngineFactoryForTests(null));

  let windowActive = false;
  let hold: Promise<void> | null = null;
  let releaseHold: (() => void) | null = null;
  const removedWorkspaces: number[] = [];
  const toolsArgv: string[][] = [];
  const releasedSnapshots: number[] = [];
  const deletedRefs: string[] = [];
  const reflected: string[] = [];
  setAdapterDepsForTests({
    ensureWorkspace: async (_n, spec) => {
      const tree = localPaths.workspaceTree(spec.accountId, spec.siteId, spec.workspaceId);
      fs.mkdirSync(path.join(tree, 'wp-includes'), { recursive: true });
      fs.writeFileSync(path.join(tree, 'wp-includes/version.php'), "<?php $wp_version = '6.5.3';");
      return { files: 1, bytes: 10 };
    },
    removeWorkspace: async (_n, spec) => { removedWorkspaces.push(spec.workspaceId); },
    blocksPublish: async () => windowActive,
    runTools: async (_n, spec) => {
      const argv = spec.Cmd as string[];
      toolsArgv.push(argv);
      if (hold) await hold;
      const stdout = argv[2] === 'list' && argv[1] === 'plugin'
        ? '[{"name":"akismet","title":"Akismet","version":"5.3.2","update_version":"5.3.3"}]'
        : argv[1] === 'core' ? 'Success: WordPress is at the latest version.' : '[]';
      return { ok: true, exitCode: 0, output: `${stdout}\n/srv/oblimint/secret-host-path`, outputTruncated: false, timedOut: false, stdout, stderr: '' };
    },
    removeRunContainers: async () => {},
    releaseSnapshots: async (ref) => { releasedSnapshots.push(ref.adapterRunId); },
    deleteCandidateRef: async (_s, ref) => { deletedRefs.push(ref); },
    waitForRelease: async (_s, id) => {
      const row = await db('releases').where({ id }).first('id', 'number', 'status', 'error');
      return { id: Number(row.id), number: Number(row.number), status: row.status, error: row.error } as never;
    },
    healthcheck: async () => null,
    revertTo: async () => {},
    reflectToStaging: async (_s, source, changes) => { reflected.push(`${JSON.stringify(source)} ${changes.map((c) => c.path).join(',')}`); return { written: changes.length, deleted: 0, conflicts: [] }; },
    docker: async () => fakeDocker as unknown as Docker,
    emitRun: () => {},
    notify: () => {},
  });
  t.after(() => setAdapterDepsForTests(null));

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
  const clientPublish = await user('cp', 'client', tA);
  const clientManage = await user('cm', 'client', tA);
  const clientBoth = await user('cb', 'client', tA);

  const planId = idOf((await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify(DEFAULT_PLAN_LIMITS) }).returning('id'))[0]);
  const uid = 20000 + Math.floor(Math.random() * 30000);
  const accountId = idOf((await db('hosting_accounts').insert({
    tenant_id: tA, node_id: localNode.id, plan_id: planId, username: `acme${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
  }).returning('id'))[0]);
  const site = async (slug: string, siteBase = 'apache-php8.3', wp = true) => {
    const id = idOf((await db('sites').insert({ tenant_id: tA, account_id: accountId, name: slug, slug, base: siteBase, status: 'active' }).returning('id'))[0]);
    const rel = idOf((await db('releases').insert({ site_id: id, number: 1, status: 'ready', trigger: 'manual', commit_sha: 'a'.repeat(40), on_disk: true }).returning('id'))[0]);
    await db('sites').where({ id }).update({ current_release_id: rel });
    const dir = localPaths.release(accountId, id, 1);
    fs.mkdirSync(path.join(dir, 'wp-includes'), { recursive: true });
    if (wp) fs.writeFileSync(path.join(dir, 'wp-includes/version.php'), "<?php\n$wp_version = '6.5.3';\n");
    return id;
  };
  const siteId = await site('blog');
  const plainSite = await site('plain', 'apache-php8.3', false);
  const staticSite = await site('static', 'nginx-static');
  await db('account_users').insert([
    { user_id: clientRead, account_id: accountId, capabilities: JSON.stringify([]) },
    { user_id: clientPublish, account_id: accountId, capabilities: JSON.stringify(['releases.publish']) },
    { user_id: clientManage, account_id: accountId, capabilities: JSON.stringify(['sites.manage']) },
    { user_id: clientBoth, account_id: accountId, capabilities: JSON.stringify(['sites.manage', 'releases.publish']) },
  ]);

  // ── app ────────────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: Number(req.header('x-user')) };
    (req as unknown as { tenantId: number }).tenantId = Number(req.header('x-tenant'));
    next();
  });
  app.use('/sites', adaptersRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  type Who = { user: number; tenant: number };
  const A: Who = { user: adminA, tenant: tA };
  const as = (u: number): Who => ({ user: u, tenant: tA });
  const call = async (method: string, url: string, who: Who, body?: unknown) => {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-user': String(who.user), 'x-tenant': String(who.tenant) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* text body */ }
    return { status: res.status, body: json, text };
  };
  const check = { adapter: 'wordpress', action: 'check' };

  // ── access ─────────────────────────────────────────────────────────────────
  assert.equal((await call('GET', `/sites/${siteId}/adapters`, { user: staffB, tenant: tB })).status, 404);
  assert.equal((await call('POST', `/sites/${siteId}/adapters/runs`, { user: staffB, tenant: tB }, check)).status, 404);
  assert.equal((await call('POST', `/sites/${siteId}/adapters/runs`, as(clientRead), check)).status, 403);
  assert.equal((await call('POST', `/sites/${siteId}/adapters/runs`, as(viewerA), check)).status, 403);
  assert.equal((await call('POST', `/sites/${siteId}/adapters/runs`, as(clientManage), check)).status, 403);
  assert.equal((await call('POST', `/sites/${siteId}/adapters/runs`, A, { ...check, options: { plugins: ['../x'] } })).status, 400);
  assert.equal((await call('POST', `/sites/${siteId}/adapters/runs`, A, { adapter: 'joomla', action: 'check' })).status, 400);

  let r = await call('GET', `/sites/${siteId}/adapters`, as(clientRead));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.data.enabled, true);
  assert.deepEqual(r.body.data.detections.filter((d: { detected: boolean }) => d.detected).map((d: { adapter: string; version: string }) => [d.adapter, d.version]), [['wordpress', '6.5.3']]);
  assert.deepEqual(r.body.data.available, [{ adapter: 'wordpress', checkedAt: null, updates: [], error: null }]);
  assert.equal(r.body.data.running, false);
  r = await call('GET', `/sites/${staticSite}/adapters`, A);
  assert.equal(r.body.data.enabled, false);

  // ── refusals ───────────────────────────────────────────────────────────────
  const refused = async (url: string, body: unknown, codeWanted: string) => {
    const res = await call('POST', url, A, body);
    assert.equal(res.status, 409, `${codeWanted}: ${res.text}`);
    assert.equal(res.body.code, codeWanted);
  };
  await refused(`/sites/${plainSite}/adapters/runs`, check, 'adapterNotDetected');
  await refused(`/sites/${staticSite}/adapters/runs`, check, 'adapterNotDetected');
  await refused(`/sites/${siteId}/adapters/runs`, { adapter: 'drupal', action: 'check' }, 'adapterNotDetected');
  windowActive = true;
  await refused(`/sites/${siteId}/adapters/runs`, check, 'windowActive');
  windowActive = false;
  const pub = idOf((await db('releases').insert({ site_id: siteId, number: 2, status: 'publishing', trigger: 'manual' }).returning('id'))[0]);
  await refused(`/sites/${siteId}/adapters/runs`, { adapter: 'wordpress', action: 'update' }, 'publishInProgress');
  await db('releases').where({ id: pub }).del();
  await db('sites').where({ id: siteId }).update({ status: 'stopped' });
  await refused(`/sites/${siteId}/adapters/runs`, check, 'siteStopped');
  await db('sites').where({ id: siteId }).update({ status: 'active' });
  await db('hosting_accounts').where({ id: accountId }).update({ status: 'suspended' });
  await refused(`/sites/${siteId}/adapters/runs`, check, 'accountSuspended');
  await db('hosting_accounts').where({ id: accountId }).update({ status: 'active' });
  const cur = (await db('sites').where({ id: plainSite }).first('current_release_id')).current_release_id;
  await db('sites').where({ id: plainSite }).update({ current_release_id: null });
  await refused(`/sites/${plainSite}/adapters/runs`, check, 'noRelease');
  await db('sites').where({ id: plainSite }).update({ current_release_id: cur });
  await platformSettings.update({ maintenance: { adaptersEnabled: false } });
  await refused(`/sites/${siteId}/adapters/runs`, check, 'adaptersDisabled');
  await platformSettings.update({ maintenance: { adaptersEnabled: true } });
  assert.equal(Number((await db('adapter_runs').whereIn('site_id', [siteId, plainSite, staticSite]).count('id as n'))[0].n), 0, 'no row for a refusal');

  // ── one run in flight per site ─────────────────────────────────────────────
  hold = new Promise<void>((res) => { releaseHold = res; });
  r = await call('POST', `/sites/${siteId}/adapters/runs`, as(clientPublish), check);
  assert.equal(r.status, 202, r.text);
  const run1 = r.body.data;
  assert.equal(run1.status, 'queued');
  assert.equal(run1.trigger, 'manual');
  assert.equal(run1.accountId, accountId);
  for (let i = 0; i < 100 && toolsArgv.length === 0; i++) await new Promise((res) => setTimeout(res, 10));
  await refused(`/sites/${siteId}/adapters/runs`, check, 'adapterBusy');
  r = await call('GET', `/sites/${siteId}/adapters`, A);
  assert.equal(r.body.data.running, true);
  hold = null;
  releaseHold!();
  await drainRunsForTests();
  const audit = await db('audit_logs').where({ action: 'adapter.run', tenant_id: tA }).first();
  assert.ok(audit, 'adapter.run audited in the tenant of the site');

  r = await call('GET', `/sites/${siteId}/adapters/runs?limit=5`, as(clientRead));
  assert.equal(r.status, 200);
  assert.equal(r.body.data.total, 1);
  assert.equal(r.body.data.items[0].status, 'succeeded');
  assert.equal(r.body.data.items[0].createdByName, `cp-${suffix}`);
  // The check result shows in info().available.
  r = await call('GET', `/sites/${siteId}/adapters`, A);
  const avail = r.body.data.available.find((a: { adapter: string }) => a.adapter === 'wordpress');
  assert.deepEqual(avail.updates.map((u: { name: string }) => u.name), ['akismet']);
  assert.ok(avail.checkedAt);
  assert.equal(r.body.data.recentRuns.length, 1);

  // ── run detail, A6 ─────────────────────────────────────────────────────────
  r = await call('GET', `/sites/${siteId}/adapters/runs/${run1.id}`, as(clientPublish));
  assert.equal(r.status, 200);
  assert.match(r.body.data.output, /\$ wp plugin list/);
  assert.equal(r.body.data.snapshots.length, 0);
  assert.ok(r.body.data.log.length > 2);
  r = await call('GET', `/sites/${siteId}/adapters/runs/${run1.id}`, as(clientRead));
  assert.equal(r.body.data.output, null, 'CLI output: releases.publish only');
  assert.equal((await call('GET', `/sites/${plainSite}/adapters/runs/${run1.id}`, A)).status, 404, 'run of another site');
  assert.equal((await call('GET', `/sites/${siteId}/adapters/runs/${run1.id}`, { user: staffB, tenant: tB })).status, 404);
  await db('adapter_runs').where({ id: run1.id }).update({
    status: 'failed', error: 'liste impossible : erreur interne : EACCES /srv/oblimint/accounts/1',
    log: JSON.stringify([
      { at: new Date().toISOString(), level: 'info', message: 'mise à jour des extensions : akismet' },
      { at: new Date().toISOString(), level: 'error', message: 'liste impossible : erreur interne : EACCES /srv/oblimint/accounts/1', raw: true },
    ]),
  });
  r = await call('GET', `/sites/${siteId}/adapters/runs/${run1.id}`, as(clientPublish));
  assert.equal(r.body.data.error, 'liste impossible');
  assert.deepEqual(r.body.data.log.map((l: { message: string }) => l.message), ['mise à jour des extensions : akismet', 'liste impossible'],
    'A6: only the raw-flagged lines are reduced to their labels');
  assert.ok(r.body.data.log.every((l: Record<string, unknown>) => !('raw' in l)), 'internal flag never exposed');
  r = await call('GET', `/sites/${siteId}/adapters/runs/${run1.id}`, A);
  assert.match(r.body.data.error, /EACCES/);
  assert.match(r.body.data.log[1].message, /EACCES/);
  assert.ok(r.body.data.log.every((l: Record<string, unknown>) => !('raw' in l)));

  // ── schedules ──────────────────────────────────────────────────────────────
  const sched = { cron: '0 3 * * 0', timezone: 'Europe/Paris', options: { minorOnly: true }, enabled: true };
  assert.equal((await call('PUT', `/sites/${siteId}/adapters/schedules/wordpress`, as(clientPublish), sched)).status, 403);
  assert.equal((await call('PUT', `/sites/${siteId}/adapters/schedules/joomla`, A, sched)).status, 404);
  r = await call('PUT', `/sites/${siteId}/adapters/schedules/wordpress`, A, { ...sched, cron: '*/5 * * * *' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'invalidSchedule');
  r = await call('PUT', `/sites/${siteId}/adapters/schedules/wordpress`, A, { ...sched, timezone: 'Nowhere/City' });
  assert.equal(r.body.code, 'invalidSchedule');
  // A scheduled update publishes on its own: sites.manage alone is not enough (releases.publish too).
  assert.equal((await call('PUT', `/sites/${siteId}/adapters/schedules/wordpress`, as(clientManage), sched)).status, 403);
  r = await call('PUT', `/sites/${siteId}/adapters/schedules/wordpress`, as(clientBoth), sched);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.data.timezone, 'Europe/Paris');
  assert.deepEqual(r.body.data.options, { minorOnly: true });
  const next = new Date(r.body.data.nextRunAt);
  assert.ok(next.getTime() > Date.now());
  assert.ok([1, 2].includes(next.getUTCHours()), 'Sunday 03:00 Paris = 01:00 / 02:00 UTC');
  r = await call('PUT', `/sites/${siteId}/adapters/schedules/wordpress`, A, { ...sched, enabled: false });
  assert.equal(r.body.data.nextRunAt, null);
  assert.equal(Number((await db('adapter_schedules').where({ site_id: siteId }).count('id as n'))[0].n), 1, 'upsert');
  r = await call('PUT', `/sites/${staticSite}/adapters/schedules/wordpress`, A, sched);
  assert.equal(r.body.code, 'adapterNotDetected');
  r = await call('GET', `/sites/${siteId}/adapters`, as(clientRead));
  assert.equal(r.body.data.schedules.length, 1);

  // Scheduler pass: a due schedule starts a 'scheduled' update run (no user), then records it.
  await call('PUT', `/sites/${siteId}/adapters/schedules/wordpress`, A, sched);
  await db('adapter_schedules').where({ site_id: siteId }).update({ next_run_at: new Date(Date.now() - 1000) });
  assert.equal(await schedulerTick(), 1);
  await drainRunsForTests();
  const sRow = await db('adapter_schedules').where({ site_id: siteId }).first();
  assert.ok(new Date(sRow.next_run_at).getTime() > Date.now(), 'next run advanced');
  const sRun = await db('adapter_runs').where({ id: sRow.last_run_id }).first();
  assert.equal(sRun.trigger, 'scheduled');
  assert.equal(sRun.action, 'update');
  assert.equal(sRun.created_by, null);
  assert.ok(['no_changes', 'failed'].includes(sRun.status), sRun.status);
  const sAudit = await db('audit_logs').where({ action: 'adapter.run', tenant_id: tA }).whereNull('user_id').first();
  assert.ok(sAudit, 'scheduled run audited (no user)');
  assert.equal((typeof sAudit.details === 'string' ? JSON.parse(sAudit.details) : sAudit.details).trigger, 'scheduled');
  // A due schedule refused (window active) leaves a failed run with the reason.
  windowActive = true;
  await db('adapter_schedules').where({ site_id: siteId }).update({ next_run_at: new Date(Date.now() - 1000) });
  assert.equal(await schedulerTick(), 0);
  windowActive = false;
  const refusedRun = await db('adapter_runs').where({ id: (await db('adapter_schedules').where({ site_id: siteId }).first()).last_run_id }).first();
  assert.equal(refusedRun.status, 'failed');
  assert.match(refusedRun.error, /run planifié non lancé : une fenêtre de modification est active/);
  // The author of the schedule lost releases.publish: the schedule no longer fires (failed run with the reason).
  await db('adapter_schedules').where({ site_id: siteId }).update({ created_by: clientManage, next_run_at: new Date(Date.now() - 1000) });
  assert.equal(await schedulerTick(), 0);
  const revokedRun = await db('adapter_runs').where({ id: (await db('adapter_schedules').where({ site_id: siteId }).first()).last_run_id }).first();
  assert.equal(revokedRun.status, 'failed');
  assert.match(revokedRun.error, /n'a plus le droit de publier/);
  await db('adapter_schedules').where({ site_id: siteId }).update({ created_by: adminA });

  r = await call('DELETE', `/sites/${siteId}/adapters/schedules/wordpress`, as(clientRead));
  assert.equal(r.status, 403);
  r = await call('DELETE', `/sites/${siteId}/adapters/schedules/wordpress`, A);
  assert.deepEqual(r.body.data, { deleted: true });
  assert.equal((await call('DELETE', `/sites/${siteId}/adapters/schedules/wordpress`, A)).status, 404);
  assert.ok(await db('audit_logs').where({ action: 'adapter.schedule.delete', tenant_id: tA }).first());

  // ── per-account cap on runs in flight ──────────────────────────────────────
  const blog2 = await site('blog2');
  const blog3 = await site('blog3');
  hold = new Promise<void>((res) => { releaseHold = res; });
  const argvBefore = toolsArgv.length;
  assert.equal((await call('POST', `/sites/${siteId}/adapters/runs`, A, check)).status, 202);
  assert.equal((await call('POST', `/sites/${blog2}/adapters/runs`, A, check)).status, 202);
  for (let i = 0; i < 100 && toolsArgv.length < argvBefore + 2; i++) await new Promise((res) => setTimeout(res, 10));
  r = await call('POST', `/sites/${blog3}/adapters/runs`, A, check);
  assert.equal(r.status, 409, r.text);
  assert.equal(r.body.code, 'adapterBusy');
  assert.equal(r.body.details?.reason, 'accountBusy');
  hold = null;
  releaseHold!();
  await drainRunsForTests();

  // ── deferred runs (release awaited approval) ───────────────────────────────
  const rel = async (siteIdOf: number, number: number, status: string) => idOf((await db('releases').insert({
    site_id: siteIdOf, number, status, trigger: 'adapter', commit_sha: 'c'.repeat(40), on_disk: true,
  }).returning('id'))[0]);
  const baseRel = (await db('sites').where({ id: blog2 }).first('current_release_id')).current_release_id;
  const approved = await rel(blog2, 2, 'ready');
  await db('sites').where({ id: blog2 }).update({ current_release_id: approved });
  const deferredRow = (siteIdOf: number, base: number, result: number) => db('adapter_runs').insert({
    tenant_id: tA, account_id: accountId, site_id: siteIdOf, adapter: 'wordpress', action: 'update', status: 'awaiting_approval', options: '{}',
    base_release_id: base, result_release_id: result, created_by: adminA,
    analysis: JSON.stringify({ verdict: 'clean', pendingReflect: [['wp-content/plugins/akismet/akismet.php', 'modified', 'file']] }),
    log: JSON.stringify([{ at: new Date().toISOString(), level: 'info', message: 'run en file' }]),
  }).returning('id');
  const deferredOk = idOf((await deferredRow(blog2, baseRel, approved))[0]);
  const rejectedRel = await rel(blog3, 2, 'rejected');
  const deferredRejected = idOf((await deferredRow(blog3, baseRel, rejectedRel))[0]);
  const stillWaiting = await rel(siteId, 9, 'awaiting_approval');
  const deferredWaiting = idOf((await deferredRow(siteId, baseRel, stillWaiting))[0]);
  // A deferred run holds the site: no second update (two deferred releases would block each other's approval).
  r = await call('POST', `/sites/${siteId}/adapters/runs`, A, { adapter: 'wordpress', action: 'update' });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.body.code, 'adapterBusy');
  assert.equal(r.body.details?.reason, 'awaitingApproval');
  // Their workspaces survive the orphan sweep of the boot recovery.
  fs.mkdirSync(path.join(localPaths.workspaces(accountId, siteId), String(deferredWaiting), 'tree'), { recursive: true });
  removedWorkspaces.length = 0;
  await recoverInterruptedRuns();
  assert.ok(!removedWorkspaces.includes(deferredWaiting), 'deferred run workspace kept');

  removedWorkspaces.length = 0;
  toolsArgv.length = 0;
  assert.equal(await resumeDeferredRuns(), 1);
  await drainRunsForTests();
  const ok = await db('adapter_runs').where({ id: deferredOk }).first();
  assert.equal(ok.status, 'succeeded', JSON.stringify(ok.log));
  assert.ok(toolsArgv.some((a) => a[1] === 'core' && a[2] === 'update-db'), 'migrations ran after the approval');
  assert.ok(reflected.some((x) => x.startsWith(`{"kind":"workspace","workspaceId":${deferredOk}} wp-content/plugins/akismet/akismet.php`)));
  assert.equal((typeof ok.analysis === 'string' ? JSON.parse(ok.analysis) : ok.analysis).pendingReflect, undefined);
  assert.ok(removedWorkspaces.includes(deferredOk) && releasedSnapshots.includes(deferredOk));
  const rej = await db('adapter_runs').where({ id: deferredRejected }).first();
  assert.equal(rej.status, 'failed');
  assert.match(rej.error, /rejetée/);
  assert.ok(removedWorkspaces.includes(deferredRejected) && releasedSnapshots.includes(deferredRejected) && deletedRefs.includes(`refs/oblimint/candidates/adapter-${deferredRejected}`));
  assert.equal((await db('adapter_runs').where({ id: deferredWaiting }).first()).status, 'awaiting_approval', 'still awaiting: untouched');
  // Superseded by a newer live release ⇒ abandoned.
  const newer = await rel(siteId, 10, 'ready');
  await db('sites').where({ id: siteId }).update({ current_release_id: newer });
  assert.equal(await resumeDeferredRuns(), 0);
  assert.match((await db('adapter_runs').where({ id: deferredWaiting }).first()).error, /release plus récente/);

  // ── boot recovery ──────────────────────────────────────────────────────────
  const stuck = idOf((await db('adapter_runs').insert({
    tenant_id: tA, account_id: accountId, site_id: plainSite, adapter: 'wordpress', action: 'update', status: 'running', options: '{}',
  }).returning('id'))[0]);
  fs.mkdirSync(path.join(localPaths.workspaces(accountId, siteId), '999', 'tree'), { recursive: true });
  toolsContainers.set('oblimint-tools-999-core', { 'oblimint.role': 'tools', 'oblimint.adapter-run': '999' });
  removedWorkspaces.length = 0;
  assert.equal(await recoverInterruptedRuns(), 1);
  const rec = await db('adapter_runs').where({ id: stuck }).first();
  assert.equal(rec.status, 'failed');
  assert.equal(rec.error, 'interrompu par un redémarrage');
  assert.ok(rec.finished_at);
  assert.ok(removedWorkspaces.includes(stuck));
  assert.ok(removedWorkspaces.includes(999), 'orphan workspace removed');
  assert.deepEqual(removedContainers, ['oblimint-tools-999-core']);
  assert.equal(await recoverInterruptedRuns(), 0, 'idempotent');
});
