import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { buffer } from 'stream/consumers';

// External backups on a real PostgreSQL (BACKUP_TEST_DATABASE_URL, default
// the harness on 55490; skipped when nothing listens), local destination,
// hostd replaced by an in-memory tar source / sink: settings and passphrase
// rules, run objects encrypted at rest, restore of a site's code and data
// into the same folders, rights, retention.

const DB_URL = process.env.BACKUP_TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:55490/postgres';

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

test('external backups', { timeout: 300_000 }, async (t: TestContext) => {
  if (!(await reachable(DB_URL))) { t.skip(`no PostgreSQL at ${DB_URL}`); return; }
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-backup-test-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_WORKERS = 'off';
  process.env.OBLIMINT_DATA_DIR = dataRoot;
  process.env.SESSION_SECRET ||= 'backup-test-secret-0123456789abcdef';
  const { db } = await import('../../db');
  const { actorForUser } = await import('../hosting/access');
  const { hostdFiles } = await import('../hostd/files');
  const { backupService, runAccountBackupForTests, applyRetentionForTests, openBackupContextForTests } = await import('./backup.service');
  const { LOCAL_BACKUP_ROOT } = await import('./stores');
  await db.migrate.latest();
  await db('app_config').where({ key: 'backups_settings' }).del(); // a previous failed run
  t.after(async () => { await db.destroy(); });

  // hostd: a tar is "TAR:<root>", an untar records what it received.
  const untarred: Array<{ to: string; body: string; clear: boolean }> = [];
  const realOpenTar = hostdFiles.openTar;
  const realUntar = hostdFiles.untar;
  hostdFiles.openTar = (async (_t: unknown, roots: string[], relative?: boolean) => {
    assert.equal(relative, true);
    return { status: 200, headers: {}, body: Readable.from([Buffer.from(`TAR:${roots[0]}:`.padEnd(5000, 'x'))]) };
  }) as never;
  hostdFiles.untar = (async (_t: unknown, _o: unknown, to: string, body: Readable, opts: { clear?: boolean }) => {
    untarred.push({ to, body: (await buffer(body)).toString(), clear: !!opts.clear });
    return { files: 1, dirs: 0, bytes: 1, skipped: 0, conflicts: [] };
  }) as never;
  t.after(() => { hostdFiles.openTar = realOpenTar; hostdFiles.untar = realUntar; });

  const suffix = Date.now().toString(36);
  const [ta] = await db('tenants').insert({ name: `B ${suffix}`, slug: `b-${suffix}` }).returning('id');
  const tA = Number(ta.id ?? ta);
  const [u] = await db('users').insert({ username: `bo-${suffix}`, kind: 'client', role: 'user', is_active: true }).returning('id');
  const [r] = await db('users').insert({ username: `br-${suffix}`, kind: 'client', role: 'user', is_active: true }).returning('id');
  const owner = Number(u.id ?? u);
  const reader = Number(r.id ?? r);
  const [sm] = await db('users').insert({ username: `bs-${suffix}`, kind: 'client', role: 'user', is_active: true }).returning('id');
  const [ou] = await db('users').insert({ username: `bx-${suffix}`, kind: 'client', role: 'user', is_active: true }).returning('id');
  const sitesOnly = Number(sm.id ?? sm);
  const outsider = Number(ou.id ?? ou);
  const node = (await db('nodes').where({ is_local: true }).first('id')) as { id: number } | undefined;
  const nodeId = node?.id ?? Number((await db('nodes').insert({ name: `n-${suffix}`, is_local: true }).returning('id'))[0].id);
  const [plan] = await db('plans').insert({ tenant_id: tA, name: `p-${suffix}`, limits: JSON.stringify({}) }).returning('id');
  const username = `b${suffix}`.slice(0, 30);
  const uid = 30000 + (Date.now() % 20000);
  const [acct] = await db('hosting_accounts').insert({
    tenant_id: tA, node_id: nodeId, plan_id: Number(plan.id ?? plan), username, uid, gid: uid, status: 'active', filesrv_mode: 'off',
  }).returning('id');
  const accountId = Number(acct.id ?? acct);
  const [s] = await db('sites').insert({
    tenant_id: tA, account_id: accountId, name: 'shop', slug: 'shop', base: 'apache-php8.3', docroot: '', base_path: '/', publish_mode: 'manual',
    publish_debounce_sec: 30, healthcheck_path: '/', status: 'active', php_settings: JSON.stringify({}),
  }).returning('id');
  const siteId = Number(s.id ?? s);
  await db('account_users').insert([
    { user_id: owner, account_id: accountId, capabilities: JSON.stringify(['sites.manage', 'files.manage', 'databases.manage']) },
    { user_id: reader, account_id: accountId, capabilities: JSON.stringify([]) },
    { user_id: sitesOnly, account_id: accountId, capabilities: JSON.stringify(['sites.manage']) },
  ]);
  const req = { headers: {}, session: { userId: owner, currentTenantId: tA }, socket: { remoteAddress: '203.0.113.9' } } as never;
  const actor = await actorForUser(owner, tA);
  const readerActor = await actorForUser(reader, tA);
  const sitesOnlyActor = await actorForUser(sitesOnly, tA);
  const outsiderActor = await actorForUser(outsider, tA); // a client of the tenant without this account

  // Not ready: no destination / passphrase.
  await assert.rejects(backupService.updateSettings(req, { enabled: true }), (e: { code: string }) => e.code === 'backupNotReady');
  await assert.rejects(backupService.startAccountRun(req, actor, accountId), (e: { code: string }) => e.code === 'backupNoPassphrase');

  const dest = await backupService.saveDestination(req, null, { name: `local-${suffix}`, config: { kind: 'local', subdir: suffix } });
  assert.equal(dest.kind, 'local');
  const tested = await backupService.testDestination(dest.id);
  assert.equal(tested.lastTestError, null);
  await assert.rejects(backupService.saveDestination(req, null, { name: 'evil', config: { kind: 'local', subdir: '../../etc' } }), (e: { code: string }) => e.code === 'validation');
  const sftp = await backupService.saveDestination(req, null, { name: `sftp-${suffix}`, config: { kind: 'sftp', host: 'backup.example', username: 'u', password: 'hunter2' } });
  assert.equal(sftp.hasPassword, true);
  assert.equal(JSON.stringify(sftp).includes('hunter2'), false);
  // An update without the password keeps it.
  const sftp2 = await backupService.saveDestination(req, sftp.id, { name: `sftp-${suffix}`, config: { kind: 'sftp', host: 'backup.example', username: 'v' } });
  assert.equal(sftp2.hasPassword, true);
  assert.equal(sftp2.settings.username, 'v');
  await backupService.removeDestination(req, sftp.id);

  await backupService.updateSettings(req, { destinationId: dest.id, passphrase: 'correct horse battery staple', retentionDays: 1, keepMin: 1 });
  await assert.rejects(backupService.updateSettings(req, { passphrase: 'another long passphrase' }), (e: { code: string }) => e.code === 'backupPassphraseSet');
  const settings = await backupService.updateSettings(req, { enabled: true });
  assert.equal(settings.enabled, true);
  assert.equal(settings.passphraseSet, true);
  assert.equal(JSON.stringify(settings).includes('horse'), false);

  // The site's release history: a real repo.git with two releases (bundled by the run).
  const { localPaths } = await import('../hosting/paths');
  const { commitStaging, initBareRepo } = await import('../releases/repo');
  const { repoRefs } = await import('./repoBundle');
  const repoDir = localPaths.repo(accountId, siteId);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-backup-staging-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const author = { name: 'T', email: 't@example.com' };
  await initBareRepo(repoDir);
  fs.writeFileSync(path.join(work, 'index.html'), 'v1');
  await commitStaging({ repoDir, stagingDir: work, dataPaths: [], nestedRepos: [], message: 'r1', author });
  fs.writeFileSync(path.join(work, 'index.html'), 'v2');
  await commitStaging({ repoDir, stagingDir: work, dataPaths: [], nestedRepos: [], message: 'r2', author });
  const refsAtBackup = await repoRefs(repoDir);

  // A run: one object per part, encrypted on disk.
  const runId = await runAccountBackupForTests(accountId);
  const { runs } = await backupService.accountRuns(actor, accountId);
  const run = runs.find((x) => x.id === runId)!;
  assert.equal(run.status, 'ok', JSON.stringify(run.errors));
  assert.deepEqual(run.objects.map((o) => o.kind).sort(), ['code', 'data', 'manifest', 'repo']);
  const repoObj = run.objects.find((o) => o.kind === 'repo')!;
  assert.match(repoObj.key, /\/site-shop-repo\.bundle\.obkp$/);
  assert.equal(repoObj.siteId, siteId);
  const codeObj = run.objects.find((o) => o.kind === 'code')!;
  assert.match(codeObj.key, new RegExp(`^accounts/${username}-${accountId}/[0-9TZ-]+/site-shop-code\\.tar\\.gz\\.obkp$`));
  const onDisk = fs.readFileSync(path.join(LOCAL_BACKUP_ROOT, suffix, ...codeObj.key.split('/')));
  assert.equal(onDisk.subarray(0, 4).toString(), 'OBKP');
  assert.equal(onDisk.includes(Buffer.from('TAR:')), false);

  // Restore: rights, then code + data back into the same folders, emptied first.
  await assert.rejects(backupService.restore(req, readerActor, accountId, runId, [{ kind: 'code', siteId }]), (e: { statusCode: number }) => e.statusCode === 403);
  // The code overwrites the staging: sites.manage alone is not enough (L2).
  await assert.rejects(backupService.restore(req, sitesOnlyActor, accountId, runId, [{ kind: 'code', siteId }]), (e: { statusCode: number }) => e.statusCode === 403);
  assert.equal(untarred.length, 0, 'nothing restored by the refused calls');
  const res = await backupService.restore(req, actor, accountId, runId, [{ kind: 'code', siteId }, { kind: 'data', siteId }, { kind: 'db', databaseId: 999999 }]);
  assert.deepEqual(res.restored.map((x) => x.ok), [true, true, false]);
  assert.deepEqual(untarred.map((x) => [x.to, x.clear]), [['staging/shop', true], ['data/shop', true]]);
  assert.ok(untarred[0].body.startsWith('TAR:staging/shop:'));
  assert.equal(untarred[0].body.length, 5000);
  assert.ok(untarred[1].body.startsWith('TAR:data/shop:'));
  await assert.rejects(backupService.restore(req, actor, accountId + 1, runId, [{ kind: 'code', siteId }]), (e: { statusCode: number }) => e.statusCode === 404);

  // Release history: the repo moves on (a third release), then is put back in place; lost, it is recreated.
  fs.writeFileSync(path.join(work, 'index.html'), 'v3');
  await commitStaging({ repoDir, stagingDir: work, dataPaths: [], nestedRepos: [], message: 'r3', author });
  assert.notDeepEqual(await repoRefs(repoDir), refsAtBackup);
  await assert.rejects(backupService.restore(req, readerActor, accountId, runId, [{ kind: 'repo', siteId }]), (e: { statusCode: number }) => e.statusCode === 403);
  const rr = await backupService.restore(req, sitesOnlyActor, accountId, runId, [{ kind: 'repo', siteId }]);
  assert.deepEqual(rr.restored.map((x) => [x.kind, x.ok, x.refs]), [['repo', true, Object.keys(refsAtBackup).length]], JSON.stringify(rr));
  assert.deepEqual(await repoRefs(repoDir), refsAtBackup);
  fs.rmSync(repoDir, { recursive: true, force: true });
  const rr2 = await backupService.restore(req, actor, accountId, runId, [{ kind: 'repo', siteId }]);
  assert.equal(rr2.restored[0].ok, true, JSON.stringify(rr2));
  assert.deepEqual(await repoRefs(repoDir), refsAtBackup);
  // A publication in progress holds the site: the repo restore is refused for this item only.
  const { releaseService } = await import('../releases/release.service');
  let releaseLock!: () => void;
  const held = releaseService.withSiteLock(siteId, () => new Promise<void>((r) => { releaseLock = r; }));
  const busy = await backupService.restore(req, actor, accountId, runId, [{ kind: 'repo', siteId }]);
  releaseLock();
  await held;
  assert.equal(busy.restored[0].ok, false);
  assert.equal(untarred.length, 2, 'the repo restores never touched the staging / data');

  // A wrong passphrase cannot restore (simulated by replacing it).
  await backupService.updateSettings(req, { passphrase: 'a different passphrase', replacePassphrase: true });
  const bad = await backupService.restore(req, actor, accountId, runId, [{ kind: 'code', siteId }]);
  assert.equal(bad.restored[0].ok, false);
  assert.match(bad.restored[0].error!, /passphrase|altered/);

  // Retention: two runs, the oldest aged beyond retentionDays, keepMin 1 → purged.
  const run2 = await runAccountBackupForTests(accountId);
  await db('backup_runs').where({ id: runId }).update({ started_at: new Date(Date.now() - 3 * 86400_000) });
  const ctx = await openBackupContextForTests();
  const purged = await applyRetentionForTests(ctx, { ...(await backupService.getSettings()), passphraseSealed: 'x', retentionDays: 1, keepMin: 1 } as never);
  await ctx.store.close();
  assert.ok(purged >= 1);
  const after = await backupService.listRuns({ accountId });
  assert.ok(after.find((x) => x.id === runId)!.purgedAt);
  assert.equal(after.find((x) => x.id === run2)!.purgedAt, null);
  assert.equal(fs.existsSync(path.join(LOCAL_BACKUP_ROOT, suffix, ...codeObj.key.split('/'))), false);
  await assert.rejects(backupService.restore(req, actor, accountId, runId, [{ kind: 'code', siteId }]), (e: { code: string }) => e.code === 'backupPurged');
  // The state of a backup is never answered for an account the caller does not see (L3): 404, not 409.
  await assert.rejects(backupService.restore(req, outsiderActor, accountId, runId, [{ kind: 'code', siteId }]),
    (e: { statusCode: number; code?: string }) => e.statusCode === 404 && e.code !== 'backupPurged');

  // The destination in use by the schedule cannot be deleted.
  await assert.rejects(backupService.removeDestination(req, dest.id), (e: { code: string }) => e.code === 'conflict');
  await backupService.updateSettings(req, { enabled: false });
  await db('app_config').where({ key: 'backups_settings' }).del();
});
