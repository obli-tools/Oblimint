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
// DB integration of the snapshots (module checksums-snapshots, docs/P3-PLAN.md
// §10.3, §15: port 55453):
//   PG_PORT=55453 node <scratchpad>/pg/pgserver.mjs
// SNAPSHOTS_TEST_DATABASE_URL overrides the URL. Skipped cleanly when nothing
// listens. Docker exec of the SQL clients = a recording fake (exec seam).
// Covers: snapshotIo (argv, passwords only in the env, gzip file written
// atomically 0600 in a 0700 dir, busy guard, restore without the superuser),
// createForSite (modes all / selected / none / explicit, partial failure,
// instance not running), restore, release + retention, boot recovery, API
// access rules (404 / 403, A6 masking).
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.SNAPSHOTS_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55453/postgres';
const POSIX = process.platform !== 'win32';

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

test('database snapshots on PostgreSQL (PGlite)', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) {
    t.skip(`no PostgreSQL at ${DB_URL} (start the PGlite harness with PG_PORT=55453)`);
    return;
  }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-snap-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'snapshots-test-secret-0123456789abcdef';

  const express = (await import('express')).default;
  const { db } = await import('../../db');
  const { AppError, errorHandler } = await import('../../middleware/errorHandler');
  const routes = (await import('../../routes/snapshots.routes')).default;
  const { setEngineFactoryForTests } = await import('../docker/engine');
  const { setDbExecForTests } = await import('../databases/exec');
  const { acquireBusy } = await import('../databases/instances');
  const { dumpArgv, restoreArgv } = await import('../databases/engines');
  const { mysqlRestoreUser } = await import('../databases/sql');
  const { resetSsoStateForTests } = await import('../databases/sso');
  const { dumpDatabaseToFile, restoreDatabaseFromFile, SnapshotRestoreError, mysqlEmptyDatabaseSql, pgEmptyDatabaseSql, snapshotRestoreArgv } = await import('../databases/snapshotIo');
  const { snapshotService, snapshotRetentionPass, recoverInterruptedSnapshots } = await import('./snapshot.service');
  const { localPaths } = await import('../hosting/paths');
  const { platformSettings } = await import('../platformSettings');
  const { seal } = await import('../../utils/secretBox');
  const { DEFAULT_PLAN_LIMITS } = await import('@oblimint/shared');

  await db.migrate.latest();
  t.after(async () => { await db.destroy(); });

  // ── fakes ──────────────────────────────────────────────────────────────────
  const localNode = (await db('nodes').where({ is_local: true }).first('id')) as { id: number };
  setEngineFactoryForTests(() => ({}) as never, localNode.id);
  const execCalls: ExecCall[] = [];
  /** Containers whose dump fails / restore client exits non-zero. */
  const failDump = new Set<string>();
  const failRestore = new Set<string>();
  const DUMP = (c: string) => `-- dump of ${c}\nCREATE TABLE t (id int);\n`;
  const hex = (x: string) => Buffer.from(x, 'utf8').toString('hex').toUpperCase();
  /** Superuser listing of the MySQL objects (batch output of mysqlListObjectsSql). */
  const MYSQL_LISTING = [
    `T\t${hex('wp_posts')}\tBASE TABLE`,
    `T\t${hex('added`later')}\tBASE TABLE`,
    `T\t${hex('v_recent')}\tVIEW`,
    `R\t${hex('p1')}\tPROCEDURE`,
    `R\t${hex('f1')}\tFUNCTION`,
    `E\t${hex('e1')}\tEVENT`,
    'junk line',
  ].join('\n') + '\n';
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
    if (sqlEnv?.includes('information_schema.TABLES')) return { exitCode: 0, stdout: MYSQL_LISTING, stderr: '' };
    if (opts.stdout) {
      if (failDump.has(container)) return { exitCode: 2, stdout: '', stderr: 'mysqldump: Got error: 2002 at /run/mysqld/mysqld.sock' };
      (opts.stdout as Writable).write(Buffer.from(DUMP(container)));
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (stdin !== null && failRestore.has(container)) return { exitCode: 1, stdout: '', stderr: 'ERROR 1064 at line 1 in /var/lib/mysql' };
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  t.after(() => {
    setEngineFactoryForTests(null);
    setDbExecForTests(null);
    resetSsoStateForTests();
    snapshotService.stop();
  });

  // ── fixtures ───────────────────────────────────────────────────────────────
  const suffix = Date.now().toString(36);
  const idOf = (r: unknown) => Number((r as { id?: number }).id ?? r);
  const tA = idOf((await db('tenants').insert({ name: `A ${suffix}`, slug: `a-${suffix}` }).returning('id'))[0]);
  const tB = idOf((await db('tenants').insert({ name: `B ${suffix}`, slug: `b-${suffix}` }).returning('id'))[0]);
  const user = async (username: string, kind: 'staff' | 'client', role: 'admin' | 'user', tenantId: number) => {
    const id = idOf((await db('users').insert({ username: `${username}-${suffix}`, kind, role, is_active: true }).returning('id'))[0]);
    if (kind === 'staff') await db('user_tenants').insert({ user_id: id, tenant_id: tenantId, role: 'admin' });
    return id;
  };
  const staffB = await user('stb', 'staff', 'user', tB);
  const clientRead = await user('cr', 'client', 'user', tA);
  const clientManage = await user('cm', 'client', 'user', tA);
  const clientOther = await user('co', 'client', 'user', tA);
  const platformAdmin = await user('pa', 'staff', 'admin', 1);

  const planId = idOf((await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify(DEFAULT_PLAN_LIMITS) }).returning('id'))[0]);
  const mkAccount = async (name: string) => {
    const uid = 20000 + Math.floor(Math.random() * 30000);
    return idOf((await db('hosting_accounts').insert({
      tenant_id: tA, node_id: localNode.id, plan_id: planId, username: `${name}${suffix}`.slice(0, 30), uid, gid: uid, status: 'active', filesrv_mode: 'off',
    }).returning('id'))[0]);
  };
  const acct = await mkAccount('acme');
  const other = await mkAccount('other');
  await db('account_users').insert([
    { user_id: clientRead, account_id: acct, capabilities: JSON.stringify([]) },
    { user_id: clientManage, account_id: acct, capabilities: JSON.stringify(['databases.manage']) },
    { user_id: clientOther, account_id: other, capabilities: JSON.stringify(['databases.manage']) },
  ]);
  const mkSite = async (accountId: number, slug: string) => idOf((await db('sites').insert({
    tenant_id: tA, account_id: accountId, name: slug, slug, base: 'apache-php8.3', status: 'active',
  }).returning('id'))[0]);
  const blog = await mkSite(acct, 'blog');
  const shopSite = await mkSite(acct, 'shopsite');
  const otherSite = await mkSite(other, 'elsewhere');

  const ROOT_PW = 'root-password-never-on-argv-0123';
  const mkInstance = async (accountId: number, name: string, engine: string, status: string) => idOf((await db('db_instances').insert({
    tenant_id: tA, account_id: accountId, node_id: localNode.id, name, engine, version: engine === 'postgresql' ? '17' : '11.4',
    status, root_secret: seal('db-root', ROOT_PW),
  }).returning('id'))[0]);
  const m1 = await mkInstance(acct, 'main', 'mariadb', 'running');
  const p1 = await mkInstance(acct, 'pg', 'postgresql', 'running');
  const s1 = await mkInstance(acct, 'off', 'mariadb', 'stopped');
  const e1 = await mkInstance(acct, 'broken', 'mariadb', 'error');
  const o1 = await mkInstance(other, 'main', 'mariadb', 'running');
  const mkDb = async (instanceId: number, accountId: number, name: string) =>
    idOf((await db('db_databases').insert({ instance_id: instanceId, account_id: accountId, name }).returning('id'))[0]);
  const shop = await mkDb(m1, acct, 'shop');
  const wp = await mkDb(m1, acct, 'wp');
  const analytics = await mkDb(p1, acct, 'analytics');
  await mkDb(s1, acct, 'old');
  const brokenDb = await mkDb(e1, acct, 'brk');
  const otherDb = await mkDb(o1, other, 'theirs');

  const allPasswords = () => execCalls.flatMap((c) => c.env.filter((e) => /^(MYSQL_PWD|PGPASSWORD)=/.test(e)).map((e) => e.split('=').slice(1).join('=')));
  const assertNoPasswordOnArgv = () => {
    const pws = allPasswords();
    assert.ok(pws.length > 0);
    for (const c of execCalls) for (const pw of pws) assert.ok(!c.cmd.some((a) => a.includes(pw)), `password on argv: ${c.cmd.join(' ')}`);
  };
  const gunzipText = (file: string) => zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');

  // ── snapshotIo ─────────────────────────────────────────────────────────────
  await t.test('dumpDatabaseToFile: gzip, atomic, 0600 in 0700, env-only password, busy guard', async () => {
    execCalls.length = 0;
    const dir = localPaths.snapshots(acct);
    const file = localPaths.snapshotFile(acct, 'io-shop.sql.gz');
    const { bytes } = await dumpDatabaseToFile(shop, file);
    assert.equal(bytes, fs.statSync(file).size);
    assert.equal(gunzipText(file), DUMP(`oblimint-db-${m1}`));
    assert.ok(!fs.existsSync(`${file}.tmp`), 'temporary file renamed');
    if (POSIX) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    }
    const call = execCalls.find((c) => c.cmd[0]?.includes('dump'))!;
    assert.deepEqual(call.cmd, dumpArgv('mariadb', 'shop'));
    assert.equal(call.container, `oblimint-db-${m1}`);
    assert.ok(call.env.includes(`MYSQL_PWD=${ROOT_PW}`));
    assertNoPasswordOnArgv();

    // A failing dump leaves neither the file nor its temporary file.
    failDump.add(`oblimint-db-${m1}`);
    const bad = localPaths.snapshotFile(acct, 'io-fail.sql.gz');
    await assert.rejects(() => dumpDatabaseToFile(shop, bad), (err: unknown) => err instanceof AppError && err.code === 'backendUnavailable');
    assert.ok(!fs.existsSync(bad) && !fs.existsSync(`${bad}.tmp`));
    failDump.clear();

    // One heavy operation per instance.
    const release = acquireBusy(m1);
    try {
      await assert.rejects(() => dumpDatabaseToFile(wp, bad), (err: unknown) => err instanceof AppError && err.code === 'instanceBusy');
    } finally {
      release();
    }
    await assert.rejects(() => dumpDatabaseToFile(brokenDb, bad), (err: unknown) => err instanceof AppError && err.code === 'instanceNotRunning');
    await assert.rejects(() => dumpDatabaseToFile(shop, 'relative/x.sql.gz'), /invalid snapshot file path/);
  });

  await t.test('restoreDatabaseFromFile: never the superuser (MySQL family and PostgreSQL)', async () => {
    const file = localPaths.snapshotFile(acct, 'io-shop.sql.gz');
    execCalls.length = 0;
    await restoreDatabaseFromFile(shop, file);
    const restoreUser = mysqlRestoreUser(shop);
    const unlock = execCalls.findIndex((c) => c.sql?.includes(restoreUser) && /ACCOUNT UNLOCK|IDENTIFIED/i.test(c.sql ?? ''));
    const run = execCalls.findIndex((c) => c.stdin !== null);
    assert.ok(unlock >= 0 && run > unlock, 'restore account unlocked first');
    assert.deepEqual(execCalls[run].cmd, restoreArgv('mariadb', 'shop', restoreUser));
    assert.deepEqual(snapshotRestoreArgv('mariadb', 'shop', restoreUser), restoreArgv('mariadb', 'shop', restoreUser));
    // The database is emptied first (objects created after the snapshot must go), by the restore account.
    const listing = execCalls.findIndex((c) => c.sql?.includes('information_schema.TABLES'));
    assert.ok(listing >= 0 && listing < run, 'objects listed before the replay');
    assert.ok(execCalls[listing].sql!.includes("TABLE_SCHEMA = 'shop'"));
    const empty = mysqlEmptyDatabaseSql('shop', MYSQL_LISTING);
    assert.equal(empty, [
      'SET FOREIGN_KEY_CHECKS = 0;',
      'DROP VIEW IF EXISTS `shop`.`v_recent`;',
      'DROP TABLE IF EXISTS `shop`.`wp_posts`;',
      'DROP TABLE IF EXISTS `shop`.`added``later`;',
      'DROP PROCEDURE IF EXISTS `shop`.`p1`;',
      'DROP FUNCTION IF EXISTS `shop`.`f1`;',
      'DROP EVENT IF EXISTS `shop`.`e1`;',
      'SET FOREIGN_KEY_CHECKS = 1;',
      '',
    ].join('\n'));
    assert.equal(mysqlEmptyDatabaseSql('shop', ''), '', 'empty database: no preamble');
    assert.equal(execCalls[run].stdin, empty + DUMP(`oblimint-db-${m1}`));
    assert.ok(!execCalls[run].env.includes(`MYSQL_PWD=${ROOT_PW}`), 'not the superuser password');
    assert.ok(execCalls.slice(run + 1).some((c) => c.sql?.includes(restoreUser) && /LOCK/i.test(c.sql ?? '')), 'locked again after');
    assertNoPasswordOnArgv();

    // PostgreSQL: ephemeral member role, PGOPTIONS, \restrict prefix.
    const pgFile = localPaths.snapshotFile(acct, 'io-analytics.sql.gz');
    await dumpDatabaseToFile(analytics, pgFile);
    execCalls.length = 0;
    await restoreDatabaseFromFile(analytics, pgFile);
    const pgRun = execCalls.find((c) => c.stdin !== null)!;
    assert.ok(!pgRun.cmd.includes('postgres'), 'not the postgres superuser');
    assert.ok(pgRun.env.some((e) => e.startsWith('PGOPTIONS=')));
    // Emptied (what the owner role owns) and replayed in ONE transaction.
    assert.deepEqual(pgRun.cmd.slice(-2), ['--single-transaction', '--file=-']);
    const pgEmpty = pgEmptyDatabaseSql(analytics);
    assert.ok((pgRun.stdin ?? '').startsWith(pgEmpty), 'emptying preamble first');
    assert.match((pgRun.stdin ?? '').slice(pgEmpty.length), /^\\restrict [0-9a-f]+\n-- dump of /);
    assert.ok(pgEmpty.includes(`rolname = 'oblimint_o${analytics}'`));
    assert.ok(!/DROP OWNED/i.test(pgEmpty), 'default privileges of the owner role kept');
    assert.match(pgEmpty, /^DO \$oblimint_empty\$\n[\s\S]*\nEND\n\$oblimint_empty\$;\n$/);
    assertNoPasswordOnArgv();

    // Refused by the client: SnapshotRestoreError carries the raw output (not in details), account locked again.
    failRestore.add(`oblimint-db-${m1}`);
    execCalls.length = 0;
    await assert.rejects(() => restoreDatabaseFromFile(shop, file), (err: unknown) => {
      assert.ok(err instanceof SnapshotRestoreError);
      assert.equal(err.code, 'restoreFailed');
      assert.match(err.output, /ERROR 1064/);
      assert.deepEqual(err.details, { exitCode: 1 });
      return true;
    });
    assert.ok(execCalls.at(-1)?.sql?.includes(restoreUser), 'restore account locked again after a failure');
    failRestore.clear();
    await assert.rejects(() => restoreDatabaseFromFile(shop, localPaths.snapshotFile(acct, 'missing.sql.gz')), (err: unknown) => {
      assert.ok(err instanceof AppError && err.code === 'snapshotNotReady');
      assert.equal(err.message, 'The snapshot file is missing', 'A6: no host path in the message');
      assert.deepEqual(err.details, { file: 'missing' });
      return true;
    });
  });

  // ── createForSite ──────────────────────────────────────────────────────────
  let readyShop = 0;
  let failedBroken = 0;
  let windowId = 0;
  await t.test('createForSite: mode all (default), instance not running, partial failure', async () => {
    windowId = idOf((await db('maintenance_windows').insert({
      tenant_id: tA, account_id: acct, site_id: blog, number: 1, trigger: 'scheduled', status: 'validated',
    }).returning('id'))[0]);
    failDump.add(`oblimint-db-${p1}`);
    const snaps = await snapshotService.createForSite(blog, { reason: 'window', windowId, userId: clientManage });
    failDump.clear();
    const byName = new Map(snaps.map((s) => [s.databaseName, s]));
    assert.deepEqual([...byName.keys()].sort(), ['analytics', 'brk', 'shop', 'wp'], 'stopped instance excluded from "all"; other account never');
    assert.equal(byName.get('shop')!.status, 'ready');
    assert.equal(byName.get('wp')!.status, 'ready');
    assert.equal(byName.get('analytics')!.status, 'failed', 'one failing dump does not stop the others');
    assert.match(byName.get('analytics')!.error ?? '', /^backendUnavailable: /);
    assert.equal(byName.get('brk')!.status, 'failed');
    assert.match(byName.get('brk')!.error ?? '', /^instanceNotRunning: /);
    const shopSnap = byName.get('shop')!;
    readyShop = shopSnap.id;
    failedBroken = byName.get('brk')!.id;
    assert.equal(shopSnap.windowId, windowId);
    assert.equal(shopSnap.reason, 'window');
    assert.equal(shopSnap.instanceId, m1);
    assert.equal(shopSnap.engine, 'mariadb');
    const row = await db('db_snapshots').where({ id: shopSnap.id }).first();
    assert.equal(row.file_name, `${shopSnap.id}-shop.sql.gz`);
    assert.equal(row.created_by, clientManage);
    assert.equal(row.tenant_id, tA);
    const file = localPaths.snapshotFile(acct, row.file_name);
    assert.equal(fs.statSync(file).size, shopSnap.sizeBytes);
    assert.equal(gunzipText(file), DUMP(`oblimint-db-${m1}`));
    assert.deepEqual((await snapshotService.listForWindow(windowId)).map((s) => s.id).sort((a, b) => a - b), snaps.map((s) => s.id).sort((a, b) => a - b));
    assert.deepEqual(await snapshotService.listForAdapterRun(999999), []);
  });

  await t.test('createForSite: selected, none, explicit ids (always ∩ the account)', async () => {
    await db('site_maintenance').insert({ site_id: shopSite, settings: JSON.stringify({ snapshot: { mode: 'selected', databaseIds: [wp, otherDb] } }) });
    let snaps = await snapshotService.createForSite(shopSite, { reason: 'adapter' });
    assert.deepEqual(snaps.map((s) => s.databaseName), ['wp']);
    await db('site_maintenance').where({ site_id: shopSite }).update({ settings: JSON.stringify({ snapshot: { mode: 'none', databaseIds: [] } }) });
    assert.deepEqual(await snapshotService.createForSite(shopSite, { reason: 'adapter' }), []);
    snaps = await snapshotService.createForSite(shopSite, { reason: 'manual', databaseIds: [shop, otherDb] });
    assert.deepEqual(snaps.map((s) => s.databaseName), ['shop']);
    assert.deepEqual(await snapshotService.createForSite(shopSite, { reason: 'manual', databaseIds: [] }), []);
    // Unparsable / partial settings: defaults merged (mode all).
    await db('site_maintenance').where({ site_id: shopSite }).update({ settings: JSON.stringify({ pendingPolicy: 'keep' }) });
    snaps = await snapshotService.createForSite(shopSite, { reason: 'manual' });
    assert.equal(snaps.length, 4);
    await assert.rejects(() => snapshotService.createForSite(999999, { reason: 'manual' }), (err: unknown) => err instanceof AppError && err.statusCode === 404);
  });

  await t.test('restore (internal) + audit', async () => {
    execCalls.length = 0;
    const res = await snapshotService.restore([readyShop, failedBroken, 987654], { userId: clientManage, reason: 'window #1 rejected' });
    assert.equal(res.restored, 1);
    assert.deepEqual(res.failed.map((f) => f.id).sort((a, b) => a - b), [failedBroken, 987654].sort((a, b) => a - b));
    assert.match(res.failed.find((f) => f.id === failedBroken)!.error, /^snapshotNotReady/);
    const row = await db('db_snapshots').where({ id: readyShop }).first();
    assert.ok(row.restored_at, 'restored_at set');
    const audits = await db('audit_logs').where({ action: 'snapshot.restore', resource_path: String(readyShop) });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].tenant_id, tA);
    assert.equal(audits[0].user_id, clientManage);
  });

  await t.test('release + retention + boot recovery', async () => {
    await snapshotService.release({});
    await snapshotService.release({ windowId: -3 });
    await snapshotService.release({ windowId });
    const rows = await db('db_snapshots').where({ window_id: windowId });
    const days = (await platformSettings.section('maintenance')).snapshotRetentionDays;
    for (const r of rows) {
      const delta = new Date(r.expires_at).getTime() - Date.now();
      assert.ok(Math.abs(delta - days * 86_400_000) < 120_000, `expires in ${days} days`);
    }
    // Expired: file removed, status 'expired'.
    await db('db_snapshots').where({ id: readyShop }).update({ expires_at: new Date(Date.now() - 1000) });
    const shopFile = localPaths.snapshotFile(acct, `${readyShop}-shop.sql.gz`);
    assert.ok(fs.existsSync(shopFile));
    let pass = await snapshotRetentionPass();
    assert.equal(pass.expired, 1);
    assert.equal((await db('db_snapshots').where({ id: readyShop }).first()).status, 'expired');
    assert.ok(!fs.existsSync(shopFile));

    // Beyond maxSnapshotsPerSite: the oldest DECIDED ones go first, undecided ones stay.
    await platformSettings.update({ maintenance: { maxSnapshotsPerSite: 2 } });
    const ready = await db('db_snapshots').where({ site_id: shopSite, status: 'ready' }).orderBy('id').select('id', 'created_at');
    assert.ok(ready.length >= 4, `${ready.length} ready snapshots on the shop site`);
    const decided = ready.slice(0, 2).map((r: { id: number }) => r.id);
    await db('db_snapshots').whereIn('id', decided).update({ expires_at: new Date(Date.now() + 86_400_000) });
    try {
      pass = await snapshotRetentionPass();
    } finally {
      await platformSettings.update({ maintenance: { maxSnapshotsPerSite: 10 } });
    }
    assert.equal(pass.trimmed, 2, 'only decided snapshots are trimmed');
    const left = await db('db_snapshots').where({ site_id: shopSite, status: 'ready' }).select('id');
    assert.equal(left.length, ready.length - 2);
    assert.ok(decided.every((id: number) => !left.some((l: { id: number }) => l.id === id)));

    // Orphans never released, older than the retention period, expire (file
    // removed); recent ones and those of a window still undecided stay.
    const old = new Date(Date.now() - (days + 1) * 86_400_000);
    const mkOrphan = async (over: Record<string, unknown>) => {
      const [ins] = await db('db_snapshots').insert({
        tenant_id: tA, account_id: acct, site_id: blog, instance_id: m1, database_id: shop, database_name: 'shop', engine: 'mariadb',
        reason: 'window', status: 'ready', created_at: old, ...over,
      }).returning('id');
      const id = idOf(ins);
      await db('db_snapshots').where({ id }).update({ file_name: `${id}-shop.sql.gz` });
      fs.writeFileSync(localPaths.snapshotFile(acct, `${id}-shop.sql.gz`), 'x');
      return id;
    };
    const openWindow = idOf((await db('maintenance_windows').insert({
      tenant_id: tA, account_id: acct, site_id: blog, number: 2, trigger: 'manual', status: 'pending_review',
    }).returning('id'))[0]);
    const doneWindow = idOf((await db('maintenance_windows').insert({
      tenant_id: tA, account_id: acct, site_id: blog, number: 3, trigger: 'manual', status: 'rejected', updated_at: old,
    }).returning('id'))[0]);
    const recentDone = idOf((await db('maintenance_windows').insert({
      tenant_id: tA, account_id: acct, site_id: blog, number: 4, trigger: 'manual', status: 'validated',
    }).returning('id'))[0]);
    const siteGone = await mkOrphan({ site_id: null, reason: 'manual' });
    const refsGone = await mkOrphan({ reason: 'adapter' });
    const lostRelease = await mkOrphan({ window_id: doneWindow });
    const recentOrphan = await mkOrphan({ site_id: null, reason: 'manual', created_at: new Date() });
    const undecided = await mkOrphan({ window_id: openWindow });
    const justDecided = await mkOrphan({ window_id: recentDone });
    const manualKept = await mkOrphan({ reason: 'manual' });
    pass = await snapshotRetentionPass();
    assert.equal(pass.expired, 3, 'site deleted, window / run gone, decided long ago without release()');
    const statusOf = async (id: number) => (await db('db_snapshots').where({ id }).first()).status as string;
    for (const id of [siteGone, refsGone, lostRelease]) {
      assert.equal(await statusOf(id), 'expired');
      assert.ok(!fs.existsSync(localPaths.snapshotFile(acct, `${id}-shop.sql.gz`)), 'file removed');
    }
    for (const id of [recentOrphan, undecided, justDecided, manualKept]) assert.equal(await statusOf(id), 'ready', `snapshot ${id} kept`);

    // A ready row whose file vanished: 409 without the host path, row marked failed.
    fs.rmSync(localPaths.snapshotFile(acct, `${manualKept}-shop.sql.gz`));
    const res = await snapshotService.restore([manualKept], { userId: null, reason: 'test' });
    assert.equal(res.restored, 0);
    assert.match(res.failed[0].error, /^snapshotNotReady: The snapshot file is missing$/);
    assert.ok(!res.failed[0].error.includes(dataRoot));
    assert.equal(await statusOf(manualKept), 'failed');

    // A dump interrupted by a restart.
    const [stale] = await db('db_snapshots').insert({
      tenant_id: tA, account_id: acct, site_id: blog, instance_id: m1, database_id: shop, database_name: 'shop', engine: 'mariadb',
      reason: 'window', status: 'creating', file_name: null,
    }).returning('id');
    assert.equal(await recoverInterruptedSnapshots(new Date(Date.now() - 3_600_000)), 0, 'a recent dump (this process) is left alone');
    assert.ok(await recoverInterruptedSnapshots(new Date(Date.now() + 60_000)) >= 1);
    assert.equal((await db('db_snapshots').where({ id: idOf(stale) }).first()).status, 'failed');

    // The worker returns at once and never throws.
    snapshotService.start();
    snapshotService.start();
    snapshotService.stop();
  });

  // ── API ────────────────────────────────────────────────────────────────────
  await t.test('API: list / restore / delete with the access rules', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { session: unknown }).session = { userId: Number(req.header('x-user')) };
      (req as unknown as { tenantId: number }).tenantId = Number(req.header('x-tenant'));
      next();
    });
    app.use('/sites', routes);
    app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    t.after(() => new Promise<void>((r) => server.close(() => r())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    type Who = { user: number; tenant: number };
    const call = async (method: string, url: string, who: Who) => {
      const res = await fetch(`${base}${url}`, { method, headers: { 'x-user': String(who.user), 'x-tenant': String(who.tenant) } });
      return { status: res.status, body: await res.json() as { success: boolean; data?: any; code?: string; error?: string; details?: any } };
    };
    const asReader: Who = { user: clientRead, tenant: tA };
    const asManager: Who = { user: clientManage, tenant: tA };
    const asOther: Who = { user: clientOther, tenant: tA };
    const asAdmin: Who = { user: platformAdmin, tenant: 1 };
    const asStaffB: Who = { user: staffB, tenant: tB };

    let r = await call('GET', `/sites/${blog}/snapshots?limit=2`, asReader);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const total = r.body.data.total as number;
    assert.ok(total >= 5);
    assert.equal(r.body.data.items.length, 2);
    r = await call('GET', `/sites/${blog}/snapshots?limit=100`, asReader);
    const brk = r.body.data.items.find((s: { id: number }) => s.id === failedBroken);
    assert.equal(brk.error, 'instanceNotRunning', 'A6: a client only gets the code');
    r = await call('GET', `/sites/${blog}/snapshots?limit=100`, asAdmin);
    assert.match(r.body.data.items.find((s: { id: number }) => s.id === failedBroken).error, /^instanceNotRunning: The instance is not running/);
    r = await call('GET', `/sites/${blog}/snapshots`, asStaffB);
    assert.equal(r.status, 404, 'staff of another tenant');
    r = await call('GET', `/sites/${blog}/snapshots`, asOther);
    assert.equal(r.status, 404, 'client of another account');
    r = await call('GET', `/sites/${blog}/snapshots?limit=500`, asReader);
    assert.equal(r.status, 400);

    // A fresh ready snapshot of the blog.
    const [fresh] = await snapshotService.createForSite(blog, { reason: 'manual', databaseIds: [shop] });
    assert.equal(fresh.status, 'ready');
    const [elsewhere] = await snapshotService.createForSite(otherSite, { reason: 'manual', databaseIds: [otherDb] });

    r = await call('POST', `/sites/${blog}/snapshots/${fresh.id}/restore`, asReader);
    assert.equal(r.status, 403, 'databases.manage required');
    r = await call('POST', `/sites/${blog}/snapshots/${fresh.id}/restore`, asOther);
    assert.equal(r.status, 404);
    r = await call('POST', `/sites/${blog}/snapshots/${elsewhere.id}/restore`, asManager);
    assert.equal(r.status, 404, 'a snapshot of another site through this site id');
    r = await call('POST', `/sites/${blog}/snapshots/${failedBroken}/restore`, asManager);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'snapshotNotReady');
    r = await call('POST', `/sites/${blog}/snapshots/${fresh.id}/restore`, asManager);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data, { restored: true });
    assert.equal((await db('audit_logs').where({ action: 'snapshot.restore', resource_path: String(fresh.id) })).length, 1);

    failRestore.add(`oblimint-db-${m1}`);
    r = await call('POST', `/sites/${blog}/snapshots/${fresh.id}/restore`, asManager);
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'restoreFailed');
    assert.deepEqual(r.body.details, { exitCode: 1 }, 'A6: no raw client output for a client');
    r = await call('POST', `/sites/${blog}/snapshots/${fresh.id}/restore`, asAdmin);
    assert.equal(r.status, 502);
    assert.match(r.body.details.output, /ERROR 1064/, 'the staff sees the client output');
    failRestore.clear();

    const release = acquireBusy(m1);
    try {
      r = await call('POST', `/sites/${blog}/snapshots/${fresh.id}/restore`, asManager);
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'instanceBusy');
    } finally {
      release();
    }

    r = await call('DELETE', `/sites/${blog}/snapshots/${fresh.id}`, asReader);
    assert.equal(r.status, 403);
    r = await call('DELETE', `/sites/${blog}/snapshots/${fresh.id}`, asManager);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data, { deleted: true });
    const row = await db('db_snapshots').where({ id: fresh.id }).first();
    assert.equal(row.status, 'deleted');
    assert.ok(!fs.existsSync(localPaths.snapshotFile(acct, row.file_name)), 'file deleted');
    assert.equal((await db('audit_logs').where({ action: 'snapshot.delete', resource_path: String(fresh.id), tenant_id: tA })).length, 1);
    r = await call('DELETE', `/sites/${blog}/snapshots/${fresh.id}`, asManager);
    assert.equal(r.status, 404, 'already deleted');
    r = await call('GET', `/sites/${blog}/snapshots?limit=100`, asReader);
    assert.ok(!r.body.data.items.some((s: { id: number }) => s.id === fresh.id));
    assert.equal(r.body.data.total, total, 'deleted rows are not listed');
    r = await call('POST', `/sites/${blog}/snapshots/abc/restore`, asManager);
    assert.equal(r.status, 404);
  });
});
