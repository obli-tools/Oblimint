import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { MigrationPlan, MigrationPlanSummary, MigrationTargetCatalog } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of the planner on a PGlite server (docs/P5-PLAN.md §15:
// planner = port 55483):  PG_PORT=55483 node <scratchpad>/pg/pgserver.mjs
// PLANNER_TEST_DATABASE_URL overrides the URL; skipped cleanly when nothing
// listens. Migrations 001–008 replayed (validates 008), then the routes of
// migrationPlans.routes.ts: create (defaults + computed), get, list, choices
// (zod strict, unknown keys dropped), account choice, compute (target state
// re-read: a name taken since → usernameTaken), rebase (same source / done),
// remove (delete vs archive), targets, loadForExecution (planStale, 404).
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.PLANNER_TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:55483/postgres';

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

test('planner on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55483)`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-planner-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'planner-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../../db');
  const { errorHandler } = await import('../../../middleware/errorHandler');
  const planRoutes = (await import('../../../routes/migrationPlans.routes')).default;
  const { migrationPlansService } = await import('./plans.service');
  const { migrationObjectMap } = await import('../objectMap');
  const { referenceInventory } = await import('./fixtures');
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  for (const table of ['migration_sources', 'migration_discoveries', 'migration_plans', 'migration_runs', 'migration_object_map']) {
    assert.ok(await db.schema.hasTable(table), `008 created ${table}`);
  }

  // ── fixtures ──
  const [user] = await db('users').insert({ username: 'planner-admin', role: 'admin' }).returning('id') as Array<{ id: number }>;
  const userId = Number(user.id);
  const [src] = await db('migration_sources').insert({ name: 'cwp', host: '192.0.2.1', username: 'root', auth_method: 'key' }).returning('id') as Array<{ id: number }>;
  const [src2] = await db('migration_sources').insert({ name: 'cwp2', host: '192.0.2.2', username: 'root', auth_method: 'key' }).returning('id') as Array<{ id: number }>;
  const inv = referenceInventory();
  const addDiscovery = async (sourceId: number, status: string, inventory: unknown) => {
    const [row] = await db('migration_discoveries').insert({
      source_id: sourceId, status, inventory: inventory ? JSON.stringify(inventory) : null, counts: null, finished_at: status === 'done' ? new Date() : null,
    }).returning('id') as Array<{ id: number }>;
    return Number(row.id);
  };
  const disc1 = await addDiscovery(src.id, 'done', inv);
  const running = await addDiscovery(src.id, 'running', null);
  const inv2 = referenceInventory();
  inv2.accounts.push({ ...inv2.accounts[0], username: 'acct9', mainDomain: 'nine.tld' });
  const disc2 = await addDiscovery(src.id, 'done', inv2);
  const other = await addDiscovery(src2.id, 'done', inv);
  await db('app_config').insert({ key: 'public_ipv4', value: '198.51.100.50' }).onConflict('key').merge();

  // ── app ──
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { userId, currentTenantId: 1 }; next(); });
  app.use('/api/system/migration', planRoutes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/system/migration`;
  const call = async <T = unknown>(method: string, p: string, body?: unknown): Promise<{ status: number; data: T; code?: string }> => {
    const res = await fetch(`${base}${p}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await res.json() as { data: T; code?: string };
    return { status: res.status, data: j.data, code: j.code };
  };

  // targets
  const cat = await call<MigrationTargetCatalog>('GET', '/targets');
  assert.equal(cat.status, 200);
  assert.ok(cat.data.tenants.some((x) => x.id === 1));
  assert.equal(cat.data.platformIpv4, '198.51.100.50');
  assert.ok(cat.data.dbVersions.some((v) => v.engine === 'mysql' && v.nativeHashes === false));
  assert.ok(cat.data.bases.includes('apache-php7.4'));

  // create
  assert.equal((await call('POST', '/plans', { discoveryId: running, name: 'x' })).code, 'discoveryNotDone');
  assert.equal((await call('POST', '/plans', { discoveryId: 99999, name: 'x' })).status, 404);
  assert.equal((await call('POST', '/plans', { discoveryId: disc1, name: 'x', extra: 1 })).code, 'validation');
  const created = await call<MigrationPlan>('POST', '/plans', { discoveryId: disc1, name: 'Plan A' });
  assert.equal(created.status, 201);
  const plan = created.data;
  assert.equal(plan.status, 'draft');
  assert.equal(plan.stale, false);
  assert.ok(plan.result);
  assert.equal(plan.result!.discoveryId, disc1);
  assert.equal(plan.result!.accounts[0].zones[0].records.find((r) => r.name === '@' && r.type === 'A')!.content, '198.51.100.50');
  assert.equal(plan.choices.global.targetIpv4, '198.51.100.50');
  assert.equal((await call('POST', '/plans', { discoveryId: disc1, name: 'Plan A' })).code, 'nameTaken');
  const audit = await db('audit_logs').where({ action: 'migration.plan.create' }).first();
  assert.ok(audit && audit.tenant_id === 1);
  assert.ok(!JSON.stringify(audit.details).includes('example.tld'), 'no inventory content in the audit');

  // get / list
  const got = await call<MigrationPlan>('GET', `/plans/${plan.id}`);
  assert.equal(got.data.result!.choicesHash, plan.result!.choicesHash);
  assert.equal((await call('GET', '/plans/99999')).status, 404);
  const list = await call<MigrationPlanSummary[]>('GET', `/plans?sourceId=${src.id}`);
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].stale, false);
  assert.equal(list.data[0].totals!.accounts, 1);
  assert.equal((await call<MigrationPlanSummary[]>('GET', `/plans?sourceId=${src2.id}`)).data.length, 0);

  // choices: strict schema, unknown keys dropped, recomputed
  const choices = structuredClone(plan.choices);
  choices.accounts.ghost = { selected: true };
  choices.accounts.acct1.databases = { acct1_shop: { selected: false }, nope: { selected: false } };
  const set = await call<MigrationPlan>('PUT', `/plans/${plan.id}/choices`, choices);
  assert.equal(set.status, 200, JSON.stringify(set));
  assert.equal(set.data.choices.accounts.ghost, undefined);
  assert.deepEqual(set.data.choices.accounts.acct1.databases, { acct1_shop: { selected: false } });
  assert.ok(!set.data.result!.accounts[0].databases.some((d) => d.name === 'acct1_shop'));
  assert.notEqual(set.data.result!.choicesHash, plan.result!.choicesHash);
  assert.equal(set.data.stale, false);
  const bad = structuredClone(choices);
  (bad.global as unknown as Record<string, unknown>).bogus = true;
  assert.equal((await call('PUT', `/plans/${plan.id}/choices`, bad)).code, 'validation');
  const badBase = structuredClone(choices);
  badBase.accounts.acct1.domains!['example.tld'] = { as: 'site', base: 'apache-php5.6' as never };
  assert.equal((await call('PUT', `/plans/${plan.id}/choices`, badBase)).code, 'validation');
  const badPath = structuredClone(choices);
  badPath.accounts.acct1.domains!['example.tld'] = { as: 'site', sourceRoot: '/home/acct1/../../etc' };
  assert.equal((await call('PUT', `/plans/${plan.id}/choices`, badPath)).code, 'validation');

  // account choice
  assert.equal((await call('PUT', `/plans/${plan.id}/accounts/nobody`, { selected: false })).status, 404);
  const ac = await call<MigrationPlan>('PUT', `/plans/${plan.id}/accounts/acct1`, { selected: true, targetUsername: 'newname' });
  assert.equal(ac.status, 200);
  assert.equal(ac.data.result!.accounts[0].targetUsername, 'newname');
  assert.equal(ac.data.choices.accounts.acct1.databases, undefined, 'the account choice is replaced');

  // compute: the target state is re-read (a name taken since → usernameTaken)
  const [tenantPlan] = await db('plans').insert({ tenant_id: 1, name: 'P', limits: JSON.stringify(DEFAULT_PLAN_LIMITS) }).returning('id') as Array<{ id: number }>;
  const node = await db('nodes').first('id');
  await db('hosting_accounts').insert({ tenant_id: 1, node_id: node.id, plan_id: tenantPlan.id, username: 'newname', uid: 20001, gid: 20001, status: 'active' });
  const recomputed = await call<MigrationPlan>('POST', `/plans/${plan.id}/compute`);
  assert.ok(recomputed.data.result!.accounts[0].warnings.some((w) => w.code === 'usernameTaken'));
  assert.equal(recomputed.data.result!.accounts[0].blocked, true);
  // … unless the object map says it is ours (re-run).
  const acctRow = await db('hosting_accounts').where({ username: 'newname' }).first('id');
  await migrationObjectMap.put({ sourceId: src.id, cwpUsername: 'acct1', kind: 'account', sourceKey: 'acct1', targetTable: 'hosting_accounts', targetId: acctRow.id });
  const rerun = await call<MigrationPlan>('POST', `/plans/${plan.id}/compute`);
  assert.equal(rerun.data.result!.accounts[0].existingAccountId, acctRow.id);
  assert.ok(!rerun.data.result!.accounts[0].warnings.some((w) => w.code === 'usernameTaken'));
  assert.ok(await db('audit_logs').where({ action: 'migration.plan.update' }).whereRaw("details->>'scope' = ?", ['compute']).first(), 'compute is audited');

  // loadForExecution: fresh → ok; choices changed behind the result → planStale
  const exec = await migrationPlansService.loadForExecution(plan.id);
  assert.equal(exec.inventory.accounts[0].username, 'acct1');
  assert.equal(exec.plan.id, plan.id);
  await db('migration_plans').where({ id: plan.id }).update({ choices: JSON.stringify({ ...rerun.data.choices, orphanZones: { 'x.tld': { account: null } } }) });
  await assert.rejects(migrationPlansService.loadForExecution(plan.id), (e: { code?: string; statusCode?: number }) => e.code === 'planStale' && e.statusCode === 409);
  await db('migration_plans').where({ id: plan.id }).update({ result: null });
  await assert.rejects(migrationPlansService.loadForExecution(plan.id), (e: { code?: string }) => e.code === 'planStale');
  await assert.rejects(migrationPlansService.loadForExecution(99999), (e: { statusCode?: number }) => e.statusCode === 404);
  const fixed = await call<MigrationPlan>('POST', `/plans/${plan.id}/compute`);
  assert.equal(fixed.data.stale, false);
  await migrationPlansService.loadForExecution(plan.id);

  // rebase
  assert.equal((await call('POST', `/plans/${plan.id}/rebase`, { discoveryId: other })).code, 'discoveryOtherSource');
  assert.equal((await call('POST', `/plans/${plan.id}/rebase`, { discoveryId: running })).code, 'discoveryNotDone');
  const rb = await call<MigrationPlan>('POST', `/plans/${plan.id}/rebase`, { discoveryId: disc2 });
  assert.equal(rb.status, 200);
  assert.equal(rb.data.discoveryId, disc2);
  assert.equal(rb.data.result!.accounts.length, 2);
  assert.equal(rb.data.choices.accounts.acct1.targetUsername, 'newname', 'choices kept');
  assert.ok(await db('audit_logs').where({ action: 'migration.plan.rebase' }).first());

  // remove: no run → deleted; with a run → archived
  const p2 = (await call<MigrationPlan>('POST', '/plans', { discoveryId: disc1, name: 'Plan B' })).data;
  assert.deepEqual((await call('DELETE', `/plans/${p2.id}`)).data, { deleted: true, archived: false });
  assert.equal((await call('GET', `/plans/${p2.id}`)).status, 404);
  await db('migration_runs').insert({ plan_id: plan.id, source_id: src.id, cwp_username: 'acct1', kind: 'initial', target_tenant_id: 1 });
  assert.deepEqual((await call('DELETE', `/plans/${plan.id}`)).data, { deleted: false, archived: true });
  assert.equal((await call<MigrationPlan>('GET', `/plans/${plan.id}`)).data.status, 'archived');
  await assert.rejects(migrationPlansService.loadForExecution(plan.id), (e: { code?: string; statusCode?: number }) => e.code === 'planArchived' && e.statusCode === 409);
  assert.ok(await db('audit_logs').where({ action: 'migration.plan.delete' }).first());
});
