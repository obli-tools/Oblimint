import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// DB integration of the scanners module on a PGlite server
// (docs/P3-PLAN.md §15: scanners = port 55452):
//   PG_PORT=55452 node <scratchpad>/pg/pgserver.mjs
// SCAN_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. Covers the publication loader (site row by id AND account, data
// paths, live release dir on disk) and the sealed scanner key.
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.SCAN_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55452/postgres';

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

test('scanners module on PostgreSQL (PGlite)', { timeout: 120_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55452)`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-scan-db-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'scan-test-secret-0123456789abcdef';

  const { db } = await import('../../db');
  t.after(() => db.destroy());
  const { localPaths } = await import('../hosting/paths');
  const { loadPublishSite } = await import('./prePublish');
  const { ensureScannerKey, invalidateScannerKey, readScannerKey, SCANNER_KEY_CONFIG } = await import('./scannerKey');
  await db.migrate.latest();

  const suffix = Date.now().toString(36).slice(-6);
  const [tenant] = await db('tenants').insert({ name: `S ${suffix}`, slug: `s-${suffix}` }).returning('id');
  const tenantId = Number(tenant.id ?? tenant);
  const localNode = await db('nodes').where({ is_local: true }).first('id') as { id: number } | undefined;
  const nodeId = localNode?.id ?? Number((await db('nodes').insert({ name: `n-${suffix}`, engine_type: 'local', is_local: true }).returning('id'))[0].id);
  const [plan] = await db('plans').insert({ tenant_id: tenantId, name: `p-${suffix}`, limits: JSON.stringify({}) }).returning('id');
  const mkAccount = async (n: number) => {
    const uid = 30000 + Math.floor(Math.random() * 20000) + n;
    const [a] = await db('hosting_accounts').insert({
      tenant_id: tenantId, node_id: nodeId, plan_id: Number(plan.id ?? plan), username: `scan${n}${suffix}`, uid, gid: uid, status: 'active', filesrv_mode: 'off',
    }).returning('id');
    return Number(a.id ?? a);
  };
  const accountA = await mkAccount(1);
  const accountB = await mkAccount(2);
  const [site] = await db('sites').insert({
    tenant_id: tenantId, account_id: accountA, name: 'Boutique', slug: `shop-${suffix}`, base: 'apache-php8.3', app_profile: 'wordpress', status: 'active',
  }).returning('id');
  const siteId = Number(site.id ?? site);
  await db('site_data_paths').insert([
    { site_id: siteId, path: 'wp-content/uploads', policy: 'typed', allowed_extensions: JSON.stringify(['jpg', 'png']) },
    { site_id: siteId, path: 'wp-content/cache', policy: 'ephemeral', allowed_extensions: null },
  ]);

  await t.test('loader: site of the right account only, data paths, no live release yet', async () => {
    const info = await loadPublishSite(siteId, accountA);
    assert.ok(info);
    assert.equal(info!.tenantId, tenantId);
    assert.equal(info!.name, 'Boutique');
    assert.equal(info!.appProfile, 'wordpress');
    assert.equal(info!.liveReleaseDir, null);
    const byPath = new Map(info!.dataPaths.map((d) => [d.path, d]));
    assert.deepEqual(byPath.get('wp-content/uploads'), { path: 'wp-content/uploads', policy: 'typed', allowedExtensions: ['jpg', 'png'] });
    assert.deepEqual(byPath.get('wp-content/cache'), { path: 'wp-content/cache', policy: 'ephemeral', allowedExtensions: null });
    assert.equal(await loadPublishSite(siteId, accountB), null, 'another account never sees the site');
    assert.equal(await loadPublishSite(999999, accountA), null);
  });

  await t.test('loader: live release directory only when it exists on disk', async () => {
    const [rel] = await db('releases').insert({ site_id: siteId, number: 4, status: 'ready', trigger: 'manual' }).returning('id');
    await db('sites').where({ id: siteId }).update({ current_release_id: Number(rel.id ?? rel) });
    assert.equal((await loadPublishSite(siteId, accountA))!.liveReleaseDir, null, 'pruned / not materialized');
    const dir = localPaths.release(accountA, siteId, 4);
    fs.mkdirSync(dir, { recursive: true });
    assert.equal((await loadPublishSite(siteId, accountA))!.liveReleaseDir, dir);
  });

  await t.test('scanner key: generated once, sealed in app_config, stable', async () => {
    await db('app_config').where({ key: SCANNER_KEY_CONFIG }).delete();
    invalidateScannerKey();
    assert.equal(await readScannerKey(), null);
    const key = await ensureScannerKey();
    assert.match(key, /^[A-Za-z0-9_-]{43}$/);
    const row = await db('app_config').where({ key: SCANNER_KEY_CONFIG }).first('value') as { value: string };
    assert.ok(row.value.startsWith('v1:'), 'sealed');
    assert.ok(!row.value.includes(key));
    invalidateScannerKey();
    assert.equal(await readScannerKey(), key);
    assert.equal(await ensureScannerKey(), key);
    // An unreadable sealed value (rotated secret / tampering) reads as absent and is replaced.
    await db('app_config').where({ key: SCANNER_KEY_CONFIG }).update({ value: 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    invalidateScannerKey();
    assert.equal(await readScannerKey(), null);
    const fresh = await ensureScannerKey();
    assert.notEqual(fresh, key);
  });

  await db('sites').where({ id: siteId }).update({ current_release_id: null });
  await db('sites').where({ id: siteId }).delete();
  await db('hosting_accounts').whereIn('id', [accountA, accountB]).delete();
});
