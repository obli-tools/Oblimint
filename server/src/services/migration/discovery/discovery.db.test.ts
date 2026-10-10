import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of module discovery on a PGlite server (docs/P5-PLAN.md §15:
// discovery = port 55482):
//   PG_PORT=55482 node <scratchpad>/pg/pgserver.mjs
// DISCOVERY_TEST_DATABASE_URL overrides the URL; skipped cleanly when nothing
// listens. Migrations 001–008 replayed. Covers the routes of §6.2: launch
// (404 / 409 hostKeyUnpinned / 202 / 409 discoveryRunning), the background run
// with an injected fake session (done row + inventory + counts, session
// closed), inventory 409 discoveryNotDone, list newest first, cancel, a
// connection failure (French message), remove (409 discoveryRunning /
// discoveryInUse), boot recovery (interrupted → failed), audit rows.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.DISCOVERY_TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:55482/postgres';

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

test('discovery routes + background run on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55482)`);
    return;
  }
  const base = process.env.OBLIMINT_TEST_TMP || os.tmpdir();
  const dataRoot = fs.mkdtempSync(path.join(base, 'oblimint-discovery-db-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  // Before ANY import of config / db.
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.OBLIMINT_LOGS_DIR = path.join(dataRoot, 'logs');
  process.env.SESSION_SECRET ||= 'discovery-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../../db');
  const { errorHandler } = await import('../../../middleware/errorHandler');
  const routes = (await import('../../../routes/migrationDiscovery.routes')).default;
  const { discoveryService, setDiscoverySessionFactoryForTests, waitForDiscoveryForTests, INTERRUPTED_MESSAGE } = await import('./discovery.service');
  const { createFakeSession } = await import('../contracts/testing');
  const { SourceConnectionError } = await import('../contracts/source');
  const { buildScenario, FIXTURE_NOW } = await import('./fixtures/scenario');
  void FIXTURE_NOW;

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });
  t.after(() => setDiscoverySessionFactoryForTests(null));

  const suffix = Date.now().toString(36);
  const idOf = (r: { id?: number } | number) => Number((r as { id?: number }).id ?? r);
  const adminId = idOf((await db('users').insert({ username: `adm-${suffix}`, kind: 'staff', role: 'admin', is_active: true }).returning('id'))[0]);
  const source = async (name: string, pinned: boolean) => idOf((await db('migration_sources').insert({
    name: `${name}-${suffix}`, host: '192.0.2.50', port: 22, username: 'root', auth_method: 'password',
    host_key_algorithm: pinned ? 'ssh-ed25519' : null, host_key_fingerprint: pinned ? 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' : null,
  }).returning('id'))[0]);
  const unpinned = await source('unpinned', false);
  const src = await source('cwp', true);
  const src2 = await source('cwp2', true);

  // Gate: the fake session blocks on its first command until released.
  let release: () => void = () => {};
  let gate = Promise.resolve();
  const closeGate = () => { gate = new Promise<void>((r) => { release = r; }); };
  const sessions: Array<ReturnType<typeof createFakeSession>> = [];
  setDiscoverySessionFactoryForTests(async () => {
    const sc = buildScenario();
    const h = sc.options.handlers as NonNullable<typeof sc.options.handlers>;
    const whoami = h['sys.whoami'] as () => string;
    h['sys.whoami'] = async () => { await gate; return whoami(); };
    const s = createFakeSession(sc.options);
    sessions.push(s);
    return s;
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: adminId, currentTenantId: 1 };
    (req as unknown as { tenantId: number }).tenantId = 1;
    next();
  });
  app.use('/m', routes);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/m`;
  const call = async (method: string, url: string) => {
    const res = await fetch(`${baseUrl}${url}`, { method, headers: { 'content-type': 'application/json' } });
    const json = await res.json() as any;
    return { status: res.status, body: json };
  };

  // ── launch guards ──────────────────────────────────────────────────────────
  assert.equal((await call('POST', '/sources/999999/discoveries')).status, 404);
  assert.equal((await call('POST', '/sources/abc/discoveries')).status, 404);
  const unpinnedRes = await call('POST', `/sources/${unpinned}/discoveries`);
  assert.equal(unpinnedRes.status, 409);
  assert.equal(unpinnedRes.body.code, 'hostKeyUnpinned');

  // ── running → done ─────────────────────────────────────────────────────────
  closeGate();
  const launched = await call('POST', `/sources/${src}/discoveries`);
  assert.equal(launched.status, 202);
  assert.equal(launched.body.success, true);
  const d1 = launched.body.data;
  assert.equal(d1.status, 'running');
  assert.equal(d1.sourceId, src);
  assert.equal(d1.createdBy, adminId);
  const again = await call('POST', `/sources/${src}/discoveries`);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'discoveryRunning');
  assert.equal((await call('GET', `/discoveries/${d1.id}/inventory`)).body.code, 'discoveryNotDone');
  const delRunning = await call('DELETE', `/discoveries/${d1.id}`);
  assert.equal(delRunning.status, 409);
  assert.equal(delRunning.body.code, 'discoveryRunning');
  release();
  await waitForDiscoveryForTests(d1.id);
  const got = await call('GET', `/discoveries/${d1.id}`);
  assert.equal(got.body.data.status, 'done', JSON.stringify(got.body));
  assert.equal(got.body.data.phase, 'finalize');
  assert.equal(got.body.data.counts.accounts, 6);
  assert.deepEqual(got.body.data.progress, { done: 16, total: 16 });
  assert.ok(got.body.data.finishedAt);
  const inv = await call('GET', `/discoveries/${d1.id}/inventory`);
  assert.equal(inv.status, 200);
  assert.equal(inv.body.data.counts.domains, 18);
  assert.equal(inv.body.data.accounts.length, 6);
  assert.equal(sessions[0].closed, true);
  const srcRow = await db('migration_sources').where({ id: src }).first('cwp_version', 'os_release');
  assert.equal(srcRow.cwp_version, '1.18');
  assert.equal(srcRow.os_release, 'Rocky Linux 8.10 (Green Obsidian)');
  // The persisted row holds no secret.
  const raw = await db('migration_discoveries').where({ id: d1.id }).first('inventory');
  assert.doesNotMatch(JSON.stringify(raw.inventory), /\$6\$|\$2[aby]\$|\{SHA512-CRYPT\}|PRIVATE KEY/);

  // ── cancel ─────────────────────────────────────────────────────────────────
  closeGate();
  const d2 = (await call('POST', `/sources/${src}/discoveries`)).body.data;
  const cancelled = await call('POST', `/discoveries/${d2.id}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.data.status, 'cancelled');
  // The cancelled runner is still blocked in a remote command: a relaunch waits for it to close its session
  // (never two discovery sessions against the same source).
  let relaunchDone = false;
  const relaunch = call('POST', `/sources/${src}/discoveries`).then((r) => { relaunchDone = true; return r; });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(relaunchDone, false);
  assert.equal(sessions.length, 2);
  release();
  const d2b = await relaunch;
  assert.equal(d2b.status, 202);
  assert.equal(sessions[1].closed, true);
  await waitForDiscoveryForTests(d2.id);
  await waitForDiscoveryForTests(d2b.body.data.id);
  assert.equal((await call('GET', `/discoveries/${d2.id}`)).body.data.status, 'cancelled');
  assert.equal((await call('GET', `/discoveries/${d2b.body.data.id}`)).body.data.status, 'done');
  assert.equal(sessions[1].closed, true);
  assert.equal((await call('GET', `/discoveries/${d2.id}/inventory`)).body.code, 'discoveryNotDone');
  // Cancelling a finished discovery is a no-op.
  assert.equal((await call('POST', `/discoveries/${d1.id}/cancel`)).body.data.status, 'done');

  // ── connection failure ─────────────────────────────────────────────────────
  setDiscoverySessionFactoryForTests(async () => { throw new SourceConnectionError('hostKeyMismatch', 'mismatch SHA256:xyz'); });
  const d3 = (await call('POST', `/sources/${src}/discoveries`)).body.data;
  await waitForDiscoveryForTests(d3.id);
  const failed = (await call('GET', `/discoveries/${d3.id}`)).body.data;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, "L'empreinte d'hôte présentée ne correspond pas à l'empreinte épinglée");

  // ── list newest first ──────────────────────────────────────────────────────
  const list = await call('GET', `/sources/${src}/discoveries`);
  assert.deepEqual(list.body.data.map((d: { id: number }) => d.id), [d3.id, d2b.body.data.id, d2.id, d1.id]);
  assert.equal((await call('GET', '/sources/999999/discoveries')).status, 404);
  assert.equal((await call('GET', '/discoveries/999999')).status, 404);

  // ── remove ─────────────────────────────────────────────────────────────────
  const planId = idOf((await db('migration_plans').insert({
    source_id: src, discovery_id: d1.id, name: `plan-${suffix}`, choices: JSON.stringify({}), choices_hash: 'x'.repeat(64),
  }).returning('id'))[0]);
  const inUse = await call('DELETE', `/discoveries/${d1.id}`);
  assert.equal(inUse.status, 409);
  assert.equal(inUse.body.code, 'discoveryInUse');
  await db('migration_plans').where({ id: planId }).del();
  const del = await call('DELETE', `/discoveries/${d1.id}`);
  assert.deepEqual(del.body, { success: true, data: { deleted: true } });
  assert.equal((await call('GET', `/discoveries/${d1.id}`)).status, 404);

  // ── boot recovery ──────────────────────────────────────────────────────────
  const orphan = idOf((await db('migration_discoveries').insert({ source_id: src2, status: 'running', phase: 'dns' }).returning('id'))[0]);
  assert.equal(await discoveryService.recoverInterrupted(), 1);
  const rec = (await call('GET', `/discoveries/${orphan}`)).body.data;
  assert.equal(rec.status, 'failed');
  assert.equal(rec.error, INTERRUPTED_MESSAGE);
  assert.ok(rec.finishedAt);
  discoveryService.start(); // never throws, nothing left to recover
  discoveryService.stop();

  // ── audit ──────────────────────────────────────────────────────────────────
  const audits = await db('audit_logs').where({ tenant_id: 1, user_id: adminId }).whereIn('action', ['migration.discovery.start', 'migration.discovery.cancel', 'migration.discovery.delete']).select('action');
  const actions = audits.map((a: { action: string }) => a.action);
  assert.equal(actions.filter((a: string) => a === 'migration.discovery.start').length, 4);
  assert.ok(actions.includes('migration.discovery.cancel'));
  assert.ok(actions.includes('migration.discovery.delete'));
});
