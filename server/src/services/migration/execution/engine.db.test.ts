import { test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type {
  CwpInventory, MigrationAccountPlan, MigrationPlan, MigrationPlanResult, MigrationRun,
} from '@oblimint/shared';
import type { MigrationStepContext, MigrationStepOutcome, MigrationStepProvider, MigrationStepSpec } from '../contracts/execution';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of the execution engine (module executor-web-db, PGlite port
// 55484, docs/P5-PLAN.md §15):
//   PG_PORT=55484 node <scratchpad>/pg/pgserver.mjs
// EXECUTOR_WEBDB_TEST_DATABASE_URL overrides the URL; skipped when nothing
// listens. Migrations 001–008 replayed on an empty schema. FAKE providers
// (registered over the real ones) and a fake source session: what is tested
// is the engine — persistence, ordering, resume after a crash, pause /
// cancel / retry, concurrency, hooks, validations of startRuns, reports.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.EXECUTOR_WEBDB_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55484/postgres';

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

async function rejectsWith(p: Promise<unknown>, status: number, code: string): Promise<{ details?: unknown }> {
  try {
    await p;
  } catch (err) {
    const e = err as { statusCode?: number; code?: string; details?: unknown; message?: string };
    assert.equal(e.statusCode, status, `expected HTTP ${status}, got ${e.statusCode} (${e.message})`);
    assert.equal(e.code, code, `expected ${code}, got ${e.code} (${e.message})`);
    return e;
  }
  assert.fail(`expected ${status} ${code}`);
}

async function waitFor(cond: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('condition not reached in time');
}

function accountPlan(cwpUsername: string, over: Partial<MigrationAccountPlan> = {}): MigrationAccountPlan {
  return {
    cwpUsername, selected: true, tenantId: 1, targetUsername: cwpUsername, existingAccountId: null, packageKey: '1@1', planId: null, suspended: false,
    domains: [], sites: [], proxies: [], dbInstance: null, databases: [], dbUsers: [], zones: [], mailDomains: [], mailboxes: [], aliases: [],
    dkim: [], crons: [], certificates: [], ftp: null,
    warnings: [{ code: 'phpUpgrade', severity: 'warning', scope: { kind: 'site', key: `${cwpUsername}.tld`, account: cwpUsername }, params: { from: '7.3' } }],
    followUps: [{ code: 'clientLogin', suggestion: 'client-login', scope: { kind: 'account', key: cwpUsername, account: cwpUsername }, params: {} }],
    blocked: false, estimates: { filesBytes: 0, dbBytes: 0, mailBytes: 0 },
    ...over,
  };
}

test('migration engine on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55484)`);
    return;
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-engine-'));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataDir;
  process.env.SESSION_SECRET ||= 'engine-test-secret-0123456789abcdef';

  const { db } = await import('../../../db');
  const { registerMigrationStepProvider, registerRunFinishedHook, MigrationInterruptedError } = await import('../contracts/execution');
  const { createFakeSession } = await import('../contracts/testing');
  const { migrationRequest } = await import('../jobContext');
  const { migrationPlansService } = await import('../plan/plans.service');
  const { migrationRunsService } = await import('./runs.service');
  const { worker, setEngineDepsForTests } = await import('./engine');
  const { migrationObjectMap } = await import('../objectMap');

  // ── schema (validates migration 008) ──
  await db.raw('DROP SCHEMA IF EXISTS public CASCADE');
  await db.raw('CREATE SCHEMA public');
  await db.migrate.latest();

  t.after(async () => {
    worker.stop();
    await worker.drain();
    setEngineDepsForTests(null);
    await db.destroy();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // ── fixtures ──
  const mkUser = async (username: string, role: 'admin' | 'user') =>
    Number((await db('users').insert({ username, role, kind: 'staff', is_active: true, password_hash: 'x' }).returning('id'))[0].id);
  const admin = await mkUser('platform-admin', 'admin');
  const plainStaff = await mkUser('plain-staff', 'user');
  const [src] = await db('migration_sources').insert({ name: 'cwp', host: '203.0.113.10', username: 'root', auth_method: 'key' }).returning('id');
  const sourceId = Number(src.id ?? src);
  const inventory = {
    schemaVersion: 1, accounts: [], outside: [
      { kind: 'systemd-service', key: 'node-app.service', account: 'acct1', code: 'nodeApp', params: {}, suggestion: 'docker-app', details: {} },
      { kind: 'root-cron', key: 'root:1', account: null, code: 'rootCron', params: {}, suggestion: 'manual', details: {} },
    ],
  } as unknown as CwpInventory;
  const [disc] = await db('migration_discoveries').insert({ source_id: sourceId, status: 'done', inventory: JSON.stringify(inventory) }).returning('id');
  const discoveryId = Number(disc.id ?? disc);
  const result: MigrationPlanResult = {
    computedAt: new Date().toISOString(), choicesHash: 'hash1', discoveryId,
    packages: [{ key: '1@1', cwpPackageId: 1, tenantId: 1, action: 'create', planId: null, name: 'CWP default', limits: {} as never }],
    accounts: ['acct1', 'acct2', 'acct3', 'acct4', 'acct5', 'acct6'].map((u) => accountPlan(u))
      .concat([accountPlan('blocked1', { blocked: true }), accountPlan('unsel', { selected: false })]),
    warnings: [], followUps: [], totals: { accounts: 8, selected: 7, blocked: 1, filesBytes: 0, dbBytes: 0, mailBytes: 0 },
  };
  const [pl] = await db('migration_plans').insert({
    source_id: sourceId, discovery_id: discoveryId, name: 'Plan 1', choices: JSON.stringify({}), choices_hash: 'hash1', result: JSON.stringify(result), computed_at: new Date(),
  }).returning('id');
  const planId = Number(pl.id ?? pl);
  const planDto = { id: planId, sourceId, discoveryId, name: 'Plan 1', status: 'active', computedAt: result.computedAt, stale: false, totals: result.totals, createdAt: '', updatedAt: '', choices: {}, result } as unknown as MigrationPlan;
  mock.method(migrationPlansService, 'loadForExecution', async () => ({ plan: planDto, inventory }));

  // ── fake providers (registered over the real ones) ──
  const executed: string[] = [];
  const behaviour = new Map<string, (ctx: MigrationStepContext) => Promise<MigrationStepOutcome>>();
  const fake = (id: 'web-db' | 'mail-dns', specs: Array<Pick<MigrationStepSpec, 'key' | 'phase'>>): MigrationStepProvider => ({
    id,
    steps: () => specs.map((s) => ({ ...s, provider: id, label: { code: `steps.${s.key}` }, weight: s.key === 'big' ? 5 : 1 })),
    async run(step, ctx) {
      executed.push(`${ctx.run.cwpUsername}:${step.key}`);
      const b = behaviour.get(step.key);
      if (b) return b(ctx);
      return { status: 'done', result: { ok: step.key } };
    },
  });
  registerMigrationStepProvider(fake('web-db', [{ key: 'account', phase: 20 }, { key: 'big', phase: 60 }, { key: 'plan', phase: 10 }]));
  registerMigrationStepProvider(fake('mail-dns', [{ key: 'dns:zone:x', phase: 35 }, { key: 'early', phase: 10 }]));
  const finishedRuns: MigrationRun[] = [];
  registerRunFinishedHook((run) => { finishedRuns.push(run); });
  setEngineDepsForTests({ openSession: async () => createFakeSession({ phase: 'transfer', sourceId }), concurrency: () => 1 });

  const req = () => migrationRequest(admin, 1);
  const runOf = async (id: number) => migrationRunsService.get(id);

  await t.test('startRuns validations', async () => {
    const blocked = await rejectsWith(migrationRunsService.startRuns(req(), planId, { accounts: ['acct1', 'blocked1', 'unsel', 'ghost'], kind: 'initial' }), 409, 'planBlocked');
    assert.deepEqual((blocked.details as { accounts: string[] }).accounts, ['blocked1', 'unsel', 'ghost']);
    await rejectsWith(migrationRunsService.startRuns(req(), planId, { accounts: ['acct1'], kind: 'resync' }), 409, 'initialRequired');
    assert.equal(await db('migration_runs').count('* as n').first().then((r) => Number((r as { n: string }).n)), 0);
  });

  let run1: MigrationRun;
  await t.test('initial run: steps persisted and executed in order, hooks, events, frozen plan hidden', async () => {
    [run1] = await migrationRunsService.startRuns(req(), planId, { accounts: ['acct1'], kind: 'initial', parts: ['files'], mirrorDeletes: true });
    assert.equal(run1.status, 'queued');
    assert.deepEqual(run1.parts, []);
    assert.equal(run1.mirrorDeletes, false);
    assert.equal(run1.createdBy, admin);
    await rejectsWith(migrationRunsService.startRuns(req(), planId, { accounts: ['acct1'], kind: 'initial' }), 409, 'runActive');

    const claimed = await worker.claim();
    assert.deepEqual(claimed, [run1.id]);
    await worker.drain();
    const detail = await runOf(run1.id);
    assert.equal(detail.status, 'done', detail.error ?? '');
    assert.deepEqual(detail.steps.map((s) => s.key), ['plan', 'early', 'account', 'dns:zone:x', 'big']);
    assert.deepEqual(detail.steps.map((s) => s.provider), ['web-db', 'mail-dns', 'web-db', 'mail-dns', 'web-db']);
    assert.ok(detail.steps.every((s) => s.status === 'done' && s.attempts === 1));
    assert.deepEqual(detail.progress, { done: 9, total: 9, bytes: 0 });
    assert.deepEqual(executed.splice(0), ['acct1:plan', 'acct1:early', 'acct1:account', 'acct1:dns:zone:x', 'acct1:big']);
    assert.equal(finishedRuns.at(-1)!.id, run1.id);
    const events = await migrationRunsService.events(run1.id, { limit: 500 });
    assert.equal(events[0].code, 'runStarted');
    assert.equal(events.at(-1)!.code, 'runDone');
    const after = await migrationRunsService.events(run1.id, { after: events[2].id, limit: 2, stepKey: 'account' });
    assert.ok(after.every((e) => e.stepKey === 'account' && e.id > events[2].id));
    const audits = await db('audit_logs').where({ resource_type: 'migration_run', resource_path: String(run1.id) }).pluck('action');
    assert.ok(audits.includes('migration.run.start') && audits.includes('migration.run.done'));
  });

  await t.test('stepResult: this run first, then the latest successful run of the account; setTargetAccountId', async () => {
    let seen: Record<string, unknown> | null = null;
    behaviour.set('big', async (ctx) => { seen = await ctx.stepResult('account'); return { status: 'done' }; });
    const [resync] = await migrationRunsService.startRuns(req(), planId, { accounts: ['acct1'], kind: 'resync' });
    assert.deepEqual(resync.parts, ['files', 'data', 'databases', 'maildirs']);
    await worker.claim();
    await worker.drain();
    assert.equal((await runOf(resync.id)).status, 'done');
    assert.deepEqual(seen, { ok: 'account' });
    behaviour.delete('big');
    executed.splice(0);
  });

  await t.test('failed step stops the run; retry resumes at that step, done steps never re-run', async () => {
    let fail = true;
    behaviour.set('account', async () => {
      if (fail) throw new Error("Access denied near '*6BB4837EB74329105EE4568DDA7DC67ED2CA2AD9'");
      return { status: 'warning', warnings: [{ code: 'x', severity: 'warning', scope: { kind: 'account', key: 'acct2' } }] };
    });
    const [run] = await migrationRunsService.startRuns(req(), planId, { accounts: ['acct2'], kind: 'initial' });
    await worker.claim();
    await worker.drain();
    let d = await runOf(run.id);
    assert.equal(d.status, 'failed');
    assert.match(d.error!, /^Étape account : Erreur interne/);
    assert.doesNotMatch(d.error!, /6BB4837E/);
    assert.deepEqual(d.steps.map((s) => s.status), ['done', 'done', 'failed', 'pending', 'pending']);
    assert.deepEqual(executed.splice(0), ['acct2:plan', 'acct2:early', 'acct2:account']);
    assert.equal(finishedRuns.at(-1)!.status, 'failed');
    await rejectsWith(migrationRunsService.resume(req(), run.id), 409, 'runNotResumable');
    await rejectsWith(migrationRunsService.pause(req(), run.id), 409, 'runNotPausable');

    fail = false;
    const retried = await migrationRunsService.retry(req(), run.id);
    assert.equal(retried.status, 'queued');
    await worker.claim();
    await worker.drain();
    d = await runOf(run.id);
    assert.equal(d.status, 'done');
    assert.deepEqual(executed.splice(0), ['acct2:account', 'acct2:dns:zone:x', 'acct2:big']);
    assert.deepEqual(d.steps.map((s) => [s.key, s.status, s.attempts]),
      [['plan', 'done', 1], ['early', 'done', 1], ['account', 'warning', 2], ['dns:zone:x', 'done', 1], ['big', 'done', 1]]);
    assert.equal(d.steps.find((s) => s.key === 'account')!.warnings[0].code, 'x');
    await rejectsWith(migrationRunsService.retry(req(), run.id), 409, 'runNotRetryable');
    behaviour.delete('account');
  });

  await t.test('resume after a crash: the running step re-runs once, nothing is duplicated (MG9)', async () => {
    const [run] = await migrationRunsService.startRuns(req(), planId, { accounts: ['acct3'], kind: 'initial' });
    // Simulated crash: another process held the lease and died inside step 'account'.
    await worker.claim();
    await worker.drain();
    executed.splice(0);
    await db('migration_runs').where({ id: run.id }).update({ status: 'running', lease_owner: 'dead-host:1:x', lease_until: new Date(Date.now() - 1000), finished_at: null });
    await db('migration_run_steps').where({ run_id: run.id, key: 'account' }).update({ status: 'running' });
    await db('migration_run_steps').where({ run_id: run.id }).whereIn('key', ['dns:zone:x', 'big']).update({ status: 'pending' });
    // A live lease is never stolen.
    await db('migration_runs').where({ id: run.id }).update({ lease_until: new Date(Date.now() + 60_000) });
    assert.deepEqual(await worker.claim(), []);
    await db('migration_runs').where({ id: run.id }).update({ lease_until: new Date(Date.now() - 1000) });
    assert.deepEqual(await worker.claim(), [run.id]);
    await worker.drain();
    const d = await runOf(run.id);
    assert.equal(d.status, 'done');
    assert.deepEqual(executed.splice(0), ['acct3:account', 'acct3:dns:zone:x', 'acct3:big']);
    assert.equal(d.steps.length, 5);
    assert.equal(Number((await db('migration_run_steps').where({ run_id: run.id }).count('* as n').first() as { n: string }).n), 6); // + frozen plan
    const events = await migrationRunsService.events(run.id, { limit: 500 });
    assert.ok(events.some((e) => e.code === 'runResumed'));
  });

  await t.test('pause / resume / cancel', async () => {
    let started!: () => void;
    const startedP = new Promise<void>((r) => { started = r; });
    let release = false;
    behaviour.set('account', async (ctx) => {
      started();
      while (!release) { await ctx.checkpoint(); await new Promise((r) => setTimeout(r, 10)); }
      return { status: 'done' };
    });
    const [run] = await migrationRunsService.startRuns(req(), planId, { accounts: ['acct4'], kind: 'initial' });
    await worker.claim();
    await startedP;
    const paused = await migrationRunsService.pause(req(), run.id);
    assert.ok(['running', 'paused'].includes(paused.status)); // requested: the worker stops at once (signal) or at the next checkpoint
    await worker.drain();
    let d = await runOf(run.id);
    assert.equal(d.status, 'paused');
    assert.equal(d.steps.find((s) => s.key === 'account')!.status, 'pending');
    assert.equal((await db('migration_runs').where({ id: run.id }).first('requested_action', 'lease_owner')).lease_owner, null);
    await rejectsWith(migrationRunsService.pause(req(), run.id), 409, 'runNotPausable');
    await migrationRunsService.resume(req(), run.id);
    release = true;
    await worker.claim();
    await worker.drain();
    d = await runOf(run.id);
    assert.equal(d.status, 'done');
    behaviour.delete('account');
    executed.splice(0);

    // Cancel: a queued run directly (hooks called), a running one at its next checkpoint.
    const [queued] = await migrationRunsService.startRuns(req(), planId, { accounts: ['acct5'], kind: 'initial' });
    const cancelled = await migrationRunsService.cancel(req(), queued.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(finishedRuns.at(-1)!.id, queued.id);
    await rejectsWith(migrationRunsService.cancel(req(), queued.id), 409, 'runNotCancellable');
    // Paused queued run.
    const retried = await migrationRunsService.retry(req(), queued.id);
    assert.equal(retried.status, 'queued');
    assert.equal((await migrationRunsService.pause(req(), queued.id)).status, 'paused');
    assert.equal((await migrationRunsService.resume(req(), queued.id)).status, 'queued');

    let runningStarted!: () => void;
    const p2 = new Promise<void>((r) => { runningStarted = r; });
    behaviour.set('big', async (ctx) => {
      runningStarted();
      for (;;) { await ctx.checkpoint(); if (ctx.signal.aborted) throw new MigrationInterruptedError('cancel'); await new Promise((r) => setTimeout(r, 10)); }
    });
    await worker.claim();
    await p2;
    await migrationRunsService.cancel(req(), queued.id);
    await worker.drain();
    d = await runOf(queued.id);
    assert.equal(d.status, 'cancelled');
    assert.equal(d.steps.find((s) => s.key === 'big')!.status, 'pending');
    assert.ok(d.finishedAt);
    behaviour.delete('big');
    executed.splice(0);
  });

  await t.test('concurrency limit and MG4 (creator no longer platform admin → failed)', async () => {
    const runs = await migrationRunsService.startRuns(req(), planId, { accounts: ['acct6'], kind: 'initial' });
    await db('migration_runs').where({ id: runs[0].id }).update({ created_by: plainStaff });
    const [other] = await migrationRunsService.startRuns(req(), planId, { accounts: ['acct3'], kind: 'resync' });
    setEngineDepsForTests({ openSession: async () => createFakeSession({ phase: 'transfer', sourceId }), concurrency: () => 1 });
    assert.equal((await worker.claim()).length, 1);
    assert.equal((await worker.claim()).length, 0, 'limit reached while one runs');
    await worker.drain();
    assert.equal((await worker.claim()).length, 1);
    await worker.drain();
    const d = await runOf(runs[0].id);
    assert.equal(d.status, 'failed');
    assert.match(d.error!, /migrationAdminRequired/);
    assert.equal(executed.filter((e) => e.startsWith('acct6:')).length, 0);
    assert.equal((await runOf(other.id)).status, 'done');
    executed.splice(0);
  });

  await t.test('switchedNoMirror, account statuses, reports', async () => {
    await db('migration_cutover_domains').insert({ plan_id: planId, source_id: sourceId, cwp_username: 'acct1', fqdn: 'acct1.tld', mode: 'records', state: 'switched' });
    await rejectsWith(migrationRunsService.startRuns(req(), planId, { accounts: ['acct1'], kind: 'resync', parts: ['maildirs'], mirrorDeletes: true }), 409, 'switchedNoMirror');
    // Switched then rolled back: still refused (same rule as the maildir step, mailDns/maildir.ts).
    await db('migration_cutover_domains').where({ plan_id: planId, fqdn: 'acct1.tld' }).update({ state: 'rolled-back', switched_at: db.fn.now() });
    await rejectsWith(migrationRunsService.startRuns(req(), planId, { accounts: ['acct1'], kind: 'resync', parts: ['maildirs'], mirrorDeletes: true }), 409, 'switchedNoMirror');
    await db('migration_cutover_domains').where({ plan_id: planId, fqdn: 'acct1.tld' }).update({ state: 'switched' });
    await migrationObjectMap.put({ sourceId, cwpUsername: 'acct1', kind: 'domain', sourceKey: 'acct1.tld', targetTable: 'domains', targetId: 77, meta: { name: 'acct1.tld' } });

    const statuses = await migrationRunsService.accountStatuses(planId);
    const s1 = statuses.find((s) => s.cwpUsername === 'acct1')!;
    assert.equal(s1.initialDone, true);
    assert.ok(s1.lastSyncAt);
    assert.deepEqual(s1.cutover, { domains: 1, switched: 1 });
    assert.equal(statuses.find((s) => s.cwpUsername === 'acct6')!.initialDone, false);

    const report = await migrationRunsService.planReport(planId);
    const r1 = report.accounts.find((a) => a.cwpUsername === 'acct1')!;
    assert.equal(r1.runs.length, 2);
    assert.deepEqual(r1.migrated.map((m) => m.kind), ['domain']);
    assert.ok(r1.warnings.some((w) => w.code === 'phpUpgrade'));
    assert.ok(r1.followUps.some((f) => f.code === 'nodeApp'));
    assert.ok(report.serverFollowUps.some((f) => f.code === 'rootCron'));
    const runReport = await migrationRunsService.runReport(run1.id);
    assert.equal(runReport.cwpUsername, 'acct1');
    const mdText = await migrationRunsService.planReportMarkdown(planId);
    assert.match(mdText, /^# Rapport de migration CWP — Plan 1/);
    assert.match(mdText, /## Compte acct1/);
    assert.match(mdText, /### Objets migrés/);
    assert.match(mdText, /acct1\.tld : basculée/);
    assert.match(mdText, /## Suivis manuels du serveur/);
  });

  await t.test('installImportedDomainCertificate: certificates row (issuer imported), D1, never downgrades Let\'s Encrypt', async () => {
    const { installImportedDomainCertificate } = await import('../../edge/importedSiteCert');
    const { edgeService } = await import('../../edge/edge.service');
    const syncs: string[] = [];
    mock.method(edgeService, 'scheduleSync', (reason: string) => { syncs.push(reason); });
    const selfsigned = (await import('selfsigned')).default;
    const gen = (names: string[]) => {
      const r = selfsigned.generate([{ name: 'commonName', value: names[0] }], {
        days: 60, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: names.map((value) => ({ type: 2, value })) }],
      });
      return { certificatePem: r.cert, chainPem: null, privateKeyPem: r.private };
    };
    const [p] = await db('plans').insert({ tenant_id: 1, name: 'Cert plan', limits: JSON.stringify({}) }).returning('id');
    const [a] = await db('hosting_accounts').insert({ tenant_id: 1, node_id: 1, plan_id: Number(p.id ?? p), username: 'certacct', uid: 20001, gid: 20001, status: 'active' }).returning('id');
    const [d] = await db('domains').insert({ tenant_id: 1, account_id: Number(a.id ?? a), name: 'example.tld', kind: 'primary', include_www: true, verification_status: 'pending' }).returning('id');
    const domainId = Number(d.id ?? d);
    const bundle = gen(['example.tld', 'www.example.tld']);

    assert.equal((await installImportedDomainCertificate(domainId, bundle)).reason, 'notVerified');
    await db('domains').where({ id: domainId }).update({ verification_status: 'verified' });
    assert.equal((await installImportedDomainCertificate(domainId, gen(['example.tld']))).reason, 'namesNotCovered');
    assert.equal((await installImportedDomainCertificate(domainId, { ...bundle, privateKeyPem: gen(['x.tld']).privateKeyPem })).reason, 'keyMismatch');
    assert.equal((await installImportedDomainCertificate(domainId, { ...bundle, certificatePem: 'nope' })).reason, 'invalidPem');

    const first = await installImportedDomainCertificate(domainId, bundle);
    assert.equal(first.installed, true, String(first.reason));
    const row = await db('certificates').where({ domain_id: domainId }).first();
    assert.equal(row.issuer, 'imported');
    assert.equal(row.status, 'valid');
    assert.equal(row.primary_name, 'example.tld');
    assert.deepEqual(row.names, ['example.tld', 'www.example.tld']);
    assert.ok(fs.existsSync(path.join(dataDir, 'edge', 'certs', 'example.tld', 'fullchain.pem')));
    assert.ok(syncs.includes('migration certificate'));
    const again = await installImportedDomainCertificate(domainId, bundle);
    assert.equal(again.certificateId, first.certificateId);
    assert.equal(Number((await db('certificates').count('* as n').first() as { n: string }).n), 1);

    await db('certificates').where({ id: first.certificateId! }).update({ issuer: 'letsencrypt', not_after: new Date(Date.now() + 30 * 86_400_000) });
    assert.equal((await installImportedDomainCertificate(domainId, bundle)).reason, 'letsencryptValid');
    assert.equal((await db('certificates').where({ id: first.certificateId! }).first('issuer')).issuer, 'letsencrypt');
  });

  await t.test('shutdown leaves the run resumable; the next start resumes it', async () => {
    let started!: () => void;
    const startedP = new Promise<void>((r) => { started = r; });
    behaviour.set('account', async (ctx) => {
      started();
      for (;;) { await ctx.checkpoint(); await new Promise((r) => setTimeout(r, 10)); }
    });
    const [run] = await migrationRunsService.startRuns(req(), planId, { accounts: ['acct2'], kind: 'resync' });
    // resync of the fake providers runs the same steps; 'account' blocks.
    worker.start();
    await startedP;
    worker.stop();
    await worker.drain();
    let row = await db('migration_runs').where({ id: run.id }).first();
    assert.equal(row.status, 'running');
    assert.ok(new Date(row.lease_until).getTime() <= Date.now());
    assert.equal((await db('migration_run_steps').where({ run_id: run.id, key: 'account' }).first('status')).status, 'pending');
    behaviour.delete('account');
    worker.start();
    await waitFor(async () => (await db('migration_runs').where({ id: run.id }).first('status')).status === 'done');
    worker.stop();
    await worker.drain();
    row = await db('migration_runs').where({ id: run.id }).first();
    assert.equal(row.lease_owner, null);
  });

  await t.test('a process that lost the lease never overwrites the new owner\'s run / step state', async () => {
    let started!: () => void;
    const startedP = new Promise<void>((r) => { started = r; });
    let release!: () => void;
    const releaseP = new Promise<void>((r) => { release = r; });
    behaviour.set('account', async () => {
      started();
      await releaseP;
      throw new Error('late failure of the old owner');
    });
    const [run] = await migrationRunsService.startRuns(req(), planId, { accounts: ['acct2'], kind: 'resync' });
    worker.start(); // stopped by the previous test; nothing else is claimable (the run below keeps a live foreign lease)
    await startedP;
    // Another panel process claimed the run (expired lease) and runs the step itself.
    await db('migration_runs').where({ id: run.id }).update({ lease_owner: 'other-host:1:x', lease_until: new Date(Date.now() + 60_000) });
    release();
    await worker.drain();
    behaviour.delete('account');
    const row = await db('migration_runs').where({ id: run.id }).first();
    assert.equal(row.status, 'running');
    assert.equal(row.lease_owner, 'other-host:1:x');
    assert.equal(row.error, null);
    assert.equal((await db('migration_run_steps').where({ run_id: run.id, key: 'account' }).first('status')).status, 'running');
    await db('migration_runs').where({ id: run.id }).update({ status: 'cancelled', lease_owner: null, lease_until: null });
  });
});
