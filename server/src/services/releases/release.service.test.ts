import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
// NO static import of a module that loads config/db: the environment below must be set first.

// Release pipeline end to end with a REAL database (PGlite harness) and real
// git, every other module faked (hostd, runtime reload, HTTP healthcheck).
// Opt-in: OBLIMINT_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55434/postgres
// (docs/P1-PLAN.md §16 — releases uses port 55434). Without it: skipped.
// On a box without the symlink privilege the `current` / data links are
// emulated (testUtil.emulatedLinkOps): the pipeline LOGIC is what is tested here.

const DB_URL = process.env.OBLIMINT_TEST_DATABASE_URL;
const SKIP = DB_URL ? false : 'OBLIMINT_TEST_DATABASE_URL not set (PGlite harness)';

if (DB_URL) {
  const tmpBase = process.env.OBLIMINT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(tmpBase, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(tmpBase, 'rel-data-'));
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_DATA_DIR = dataDir;
}

type Mods = {
  db: typeof import('../../db').db;
  config: typeof import('../../config').config;
  releaseService: typeof import('./release.service').releaseService;
  internals: typeof import('./release.service').__releaseInternals;
  setReleaseDeps: typeof import('./deps').setReleaseDeps;
  setScanner: typeof import('./scan').setScanner;
  noopScanner: typeof import('./scan').noopScanner;
  localPaths: typeof import('../hosting/paths').localPaths;
  readCurrent: typeof import('./materialize').readCurrent;
  switchCurrent: typeof import('./materialize').switchCurrent;
  realLinkOps: typeof import('./materialize').realLinkOps;
};
let m: Mods;
let writeFiles: typeof import('./testUtil').writeFiles;
let links: ReturnType<typeof import('./testUtil').emulatedLinkOps> | null = null;
const calls = { reload: [] as number[], ensure: [] as string[][], seed: [] as string[], clear: [] as string[][], probes: [] as Array<{ url: string; host: string }> };
let probeOk: boolean | ((n: number) => boolean) = true;
let accountId = 0;
let userId = 0;
let siteSeq = 0;

before(async () => {
  if (SKIP) return;
  const tu = await import('./testUtil');
  writeFiles = tu.writeFiles;
  links = tu.canSymlink() ? null : tu.emulatedLinkOps();
  const { db } = await import('../../db');
  const { config } = await import('../../config');
  const svc = await import('./release.service');
  const deps = await import('./deps');
  const scan = await import('./scan');
  const paths = await import('../hosting/paths');
  const mat = await import('./materialize');
  m = {
    db, config, releaseService: svc.releaseService, internals: svc.__releaseInternals, setReleaseDeps: deps.setReleaseDeps,
    setScanner: scan.setScanner, noopScanner: scan.noopScanner, localPaths: paths.localPaths, readCurrent: mat.readCurrent,
    switchCurrent: mat.switchCurrent, realLinkOps: mat.realLinkOps,
  };
  await db.migrate.latest();
  const [u] = await db('users').insert({ username: `rel-admin-${Date.now()}`, display_name: 'Rel Admin', role: 'admin', kind: 'staff' }).returning('id');
  userId = Number(u.id ?? u);
  const [plan] = await db('plans').insert({ tenant_id: 1, name: `rel-plan-${Date.now()}`, limits: JSON.stringify({}) }).returning('id');
  const UID = 20000 + Math.floor(Math.random() * 39000); // the harness DB may outlive a run
  const [acc] = await db('hosting_accounts').insert({
    tenant_id: 1, node_id: 1, plan_id: Number(plan.id ?? plan), username: `rel${Date.now() % 100000}`, status: 'active', uid: UID, gid: UID,
  }).returning('id');
  accountId = Number(acc.id ?? acc);
  deps.setReleaseDeps({
    ...(links ? { links } : {}),
    reloadSite: async (siteId) => { calls.reload.push(siteId); return { ok: true, errors: [] }; },
    hostd: () => ({
      ensureDataPaths: async (_spec, p) => { calls.ensure.push(p); },
      seedDataPath: async (_spec, p) => { calls.seed.push(p); return { copied: true, files: 1 }; },
      clearDataPaths: async (_spec, p) => { calls.clear.push(p); },
    }),
    probe: async (url, host) => {
      calls.probes.push({ url, host });
      const ok = typeof probeOk === 'function' ? probeOk(calls.probes.length) : probeOk;
      return ok ? { ok: true, status: 200, error: null } : { ok: false, status: 503, error: 'HTTP 503' };
    },
    sleep: async () => {},
    health: { attempts: 3, delayMs: 0, timeoutMs: 100 },
  });
});

after(async () => {
  if (!SKIP) await m.db.destroy();
});

beforeEach(() => {
  probeOk = true;
  for (const k of Object.keys(calls) as Array<keyof typeof calls>) calls[k].length = 0;
  if (!SKIP) m.setScanner(m.noopScanner);
});

async function newSite(opts: { mode?: 'auto' | 'manual' | 'approval'; files?: Record<string, string>; dataPaths?: Array<[string, string]>; domain?: boolean } = {}) {
  const slug = `s${++siteSeq}-${Date.now() % 100000}`;
  const [s] = await m.db('sites').insert({
    tenant_id: 1, account_id: accountId, name: slug, slug, base: 'apache-php8.3', publish_mode: opts.mode ?? 'manual', status: 'active',
    healthcheck_path: '/health.php',
  }).returning('id');
  const siteId = Number(s.id ?? s);
  for (const [p, policy] of opts.dataPaths ?? []) await m.db('site_data_paths').insert({ site_id: siteId, path: p, policy });
  if (opts.domain) {
    const [d] = await m.db('domains').insert({ tenant_id: 1, account_id: accountId, name: `${slug}.example.test`, kind: 'primary' }).returning('id');
    await m.db('site_routes').insert({ account_id: accountId, domain_id: Number(d.id ?? d), path_prefix: '/', site_id: siteId });
  }
  const staging = m.localPaths.siteStaging(accountId, slug);
  fs.mkdirSync(staging, { recursive: true });
  writeFiles(staging, opts.files ?? {});
  await m.releaseService.ensureSiteStorage(siteId);
  return { siteId, slug, staging, releases: m.localPaths.releases(accountId, siteId) };
}

async function settle(siteId: number, releaseId: number, timeoutMs = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await m.db('releases').where({ id: releaseId }).first();
    if (!['queued', 'scanning', 'publishing'].includes(r.status) && !m.internals.locks.has(siteId)) return r;
    if (Date.now() - t0 > timeoutMs) throw new Error(`release ${releaseId} stuck in ${r.status}`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

async function publish(siteId: number, message?: string) {
  const rel = await m.releaseService.publish(siteId, { trigger: 'manual', userId, message });
  return settle(siteId, rel.id);
}

const currentId = async (siteId: number) => (await m.db('sites').where({ id: siteId }).first('current_release_id')).current_release_id as number | null;

test('success path: commit, data links, hostd, switch, reload, healthcheck with the routed Host', { skip: SKIP }, async () => {
  const s = await newSite({
    domain: true,
    files: { 'index.php': '<?php echo 1;', 'wp-content/uploads/seed.jpg': 'J', 'cache/x': 'x' },
    dataPaths: [['wp-content/uploads', 'persistent'], ['cache', 'ephemeral']],
  });
  const queued = await m.releaseService.publish(s.siteId, { trigger: 'manual', userId, message: 'Hello' });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.number, 1);
  const r = await settle(s.siteId, queued.id);
  assert.equal(r.status, 'ready', JSON.stringify(r.log));
  assert.equal(r.on_disk, true);
  assert.equal(r.files_added, 1);
  assert.ok(r.published_at);
  assert.equal(await currentId(s.siteId), r.id);
  assert.equal(m.readCurrent(s.releases, links ?? undefined), 1);
  assert.equal(fs.readFileSync(`${s.releases}/1/index.php`, 'utf8'), '<?php echo 1;');
  assert.deepEqual(calls.ensure, [['cache', 'wp-content/uploads']]);
  assert.deepEqual(calls.seed, ['wp-content/uploads']);
  assert.deepEqual(calls.clear, [['cache']]);
  assert.deepEqual(calls.reload, [s.siteId]);
  assert.deepEqual(calls.probes, [{ url: `http://oblimint-site-${s.siteId}:8080/health.php`, host: `${s.slug}.example.test` }]);
  const detail = await m.releaseService.get(s.siteId, r.id);
  assert.equal(detail.isCurrent, true);
  assert.equal(detail.authorName, 'Rel Admin');
  assert.equal(detail.message, 'Hello');
  assert.ok(detail.log.some((l) => l.message.includes('en ligne')));
});

test('healthcheck failure → automatic rollback to the previous release', { skip: SKIP }, async () => {
  const s = await newSite({ files: { 'index.php': 'v1' } });
  const r1 = await publish(s.siteId);
  assert.equal(r1.status, 'ready');
  fs.writeFileSync(`${s.staging}/index.php`, 'v2');
  probeOk = false;
  calls.probes.length = 0;
  calls.reload.length = 0;
  const r2 = await publish(s.siteId);
  assert.equal(r2.status, 'failed');
  assert.match(r2.error, /healthcheck/);
  assert.equal(calls.probes.length, 3, '3 attempts');
  assert.equal(await currentId(s.siteId), r1.id);
  assert.equal(m.readCurrent(s.releases, links ?? undefined), 1);
  assert.deepEqual(calls.reload, [s.siteId, s.siteId], 'reload after the switch and after the rollback');
  // First release failing: `current` is removed.
  const s2 = await newSite({ files: { 'a.html': 'a' } });
  const f = await publish(s2.siteId);
  assert.equal(f.status, 'failed');
  assert.equal(m.readCurrent(s2.releases, links ?? undefined), null);
  assert.equal(await currentId(s2.siteId), null);
});

test('a healthcheck that recovers on the 2nd attempt succeeds', { skip: SKIP }, async () => {
  const s = await newSite({ files: { 'index.php': 'v1' } });
  probeOk = (n) => n >= 2;
  const r = await publish(s.siteId);
  assert.equal(r.status, 'ready');
});

test('guards: stagingEmpty, publishInProgress, accountSuspended', { skip: SKIP }, async () => {
  const empty = await newSite({ files: {} });
  fs.mkdirSync(`${empty.staging}/only-dirs/x`, { recursive: true });
  await assert.rejects(m.releaseService.publish(empty.siteId, { trigger: 'auto', userId: null }), (e: any) => e.code === 'stagingEmpty');

  const s = await newSite({ files: { 'a.txt': 'a' } });
  const first = await m.releaseService.publish(s.siteId, { trigger: 'manual', userId });
  await assert.rejects(m.releaseService.publish(s.siteId, { trigger: 'manual', userId }), (e: any) => e.code === 'publishInProgress');
  await settle(s.siteId, first.id);

  await m.db('hosting_accounts').where({ id: accountId }).update({ status: 'suspended' });
  try {
    await assert.rejects(m.releaseService.publish(s.siteId, { trigger: 'manual', userId }), (e: any) => e.code === 'accountSuspended');
  } finally {
    await m.db('hosting_accounts').where({ id: accountId }).update({ status: 'active' });
  }
});

test('noChanges: an unchanged staging creates no release; a change, a new data path or a broken live tree still publish', { skip: SKIP }, async () => {
  const s = await newSite({ files: { 'index.php': 'v1', 'up/a.jpg': 'J' }, dataPaths: [['up', 'persistent']] });
  const r1 = await publish(s.siteId);
  assert.equal(r1.status, 'ready');
  const count = async () => Number((await m.db('releases').where({ site_id: s.siteId }).count<{ n: string }[]>('* as n'))[0].n);
  for (const trigger of ['manual', 'auto'] as const) {
    await assert.rejects(m.releaseService.publish(s.siteId, { trigger, userId }), (e: any) => e.code === 'noChanges' && e.statusCode === 409);
  }
  writeFiles(s.staging, { 'up/b.jpg': 'K' });
  fs.mkdirSync(`${s.staging}/empty-dir`);
  await assert.rejects(m.releaseService.publish(s.siteId, { trigger: 'manual', userId }), (e: any) => e.code === 'noChanges', 'data / empty dirs only');
  assert.equal(await count(), 1);
  assert.equal(m.internals.locks.has(s.siteId), false);

  fs.writeFileSync(`${s.staging}/index.php`, 'v2');
  const r2 = await publish(s.siteId);
  assert.equal(r2.status, 'ready');
  fs.writeFileSync(`${s.staging}/index.php`, 'v1'); // back to r1's content: differs from the LIVE r2
  const r3 = await publish(s.siteId);
  assert.equal(r3.status, 'ready');
  assert.equal(r3.commit_sha === r1.commit_sha, false);

  // A data path added since the live release: same tree, but its link is missing → publishes.
  await m.db('site_data_paths').insert({ site_id: s.siteId, path: 'cache', policy: 'ephemeral' });
  const r4 = await publish(s.siteId);
  assert.equal(r4.status, 'ready', JSON.stringify(r4.log));
  await assert.rejects(m.releaseService.publish(s.siteId, { trigger: 'manual', userId }), (e: any) => e.code === 'noChanges');

  // Live tree gone from disk (out of sync): publishing is the repair path.
  fs.rmSync(`${s.releases}/${r4.number}`, { recursive: true, force: true });
  const r5 = await publish(s.siteId);
  assert.equal(r5.status, 'ready');
  assert.equal(await currentId(s.siteId), r5.id);
});

test('scan: infected → blocked awaiting_approval (nothing live, override needed); suspicious → awaiting_approval → approve resumes', { skip: SKIP }, async () => {
  const s = await newSite({ files: { 'index.php': 'v1' } });
  m.setScanner({ name: 'fake', scan: async () => ({ scanner: 'fake', verdict: 'infected', findings: [{ path: 'index.php', rule: 'x', severity: 'critical', message: 'bad' }] }) });
  const bad = await publish(s.siteId);
  assert.equal(bad.status, 'awaiting_approval', 'P3: a blocked scan waits for a staff override instead of failing');
  assert.equal(JSON.parse(typeof bad.scan === 'string' ? bad.scan : JSON.stringify(bad.scan)).blocked, true);
  assert.equal(bad.on_disk, false);
  assert.equal(await currentId(s.siteId), null);
  assert.equal(calls.reload.length, 0);
  await assert.rejects(m.releaseService.approve(s.siteId, bad.id, userId), (e: any) => e.code === 'riskBlocked' && e.statusCode === 409);
  await m.releaseService.reject(s.siteId, bad.id, userId, 'menace');

  m.setScanner({ name: 'fake', scan: async (ctx) => ({ scanner: 'fake', verdict: 'suspicious', findings: ctx.changedFiles.map((p) => ({ path: p, rule: 'y', severity: 'warn' as const, message: 'hmm' })) }) });
  const sus = await publish(s.siteId);
  assert.equal(sus.status, 'awaiting_approval');
  assert.equal(sus.on_disk, false);
  const approved = await m.releaseService.approve(s.siteId, sus.id, userId);
  assert.equal(approved.status, 'publishing');
  const done = await settle(s.siteId, sus.id);
  assert.equal(done.status, 'ready');
  assert.equal(done.approved_by, userId);
  assert.equal(await currentId(s.siteId), sus.id);
  await assert.rejects(m.releaseService.approve(s.siteId, sus.id, userId), (e: any) => e.code === 'releaseNotAwaitingApproval');
});

test('approval mode always waits; reject closes the release', { skip: SKIP }, async () => {
  const s = await newSite({ mode: 'approval', files: { 'index.php': 'v1' } });
  const r = await publish(s.siteId);
  assert.equal(r.status, 'awaiting_approval');
  const rejected = await m.releaseService.reject(s.siteId, r.id, userId, 'pas maintenant');
  assert.equal(rejected.status, 'rejected');
  const d = await m.releaseService.get(s.siteId, r.id);
  assert.ok(d.log.some((l) => l.message.includes('pas maintenant')));
  await assert.rejects(m.releaseService.approve(s.siteId, r.id, userId), (e: any) => e.code === 'releaseNotAwaitingApproval');
});

test('manual rollback, re-materialization of a pruned release, failed rollback healthcheck → 502', { skip: SKIP }, async () => {
  const s = await newSite({ files: { 'index.php': 'v1' } });
  const r1 = await publish(s.siteId);
  fs.writeFileSync(`${s.staging}/index.php`, 'v2');
  const r2 = await publish(s.siteId);
  assert.equal(r2.status, 'ready');
  await assert.rejects(m.releaseService.rollback(s.siteId, r2.id, userId), (e: any) => e.code === 'releaseIsCurrent');

  // Simulate a pruned r1.
  fs.rmSync(`${s.releases}/1`, { recursive: true, force: true });
  await m.db('releases').where({ id: r1.id }).update({ on_disk: false });
  await m.releaseService.rollback(s.siteId, r1.id, userId);
  assert.equal(await currentId(s.siteId), r1.id);
  assert.equal(m.readCurrent(s.releases, links ?? undefined), 1);
  assert.equal(fs.readFileSync(`${s.releases}/1/index.php`, 'utf8'), 'v1');
  assert.equal((await m.db('releases').where({ id: r1.id }).first()).on_disk, true);

  probeOk = false;
  await assert.rejects(m.releaseService.rollback(s.siteId, r2.id, userId), (e: any) => e.code === 'rollbackHealthcheckFailed' && e.statusCode === 502);
  assert.equal(await currentId(s.siteId), r1.id);
  assert.equal(m.readCurrent(s.releases, links ?? undefined), 1);

  const failed = await m.db('releases').insert({ site_id: s.siteId, number: 99, status: 'failed', trigger: 'manual' }).returning('id');
  await assert.rejects(m.releaseService.rollback(s.siteId, Number(failed[0].id ?? failed[0]), userId), (e: any) => e.code === 'releaseNotReady');
});

test('prune keeps the N most recent ready trees + the current one', { skip: SKIP }, async () => {
  const keep = m.config.hosting.releasesKeep;
  m.config.hosting.releasesKeep = 2;
  try {
    const s = await newSite({ files: { 'index.php': 'v0', 'same.txt': 'same' } });
    const ids: number[] = [];
    for (let i = 1; i <= 4; i++) {
      fs.writeFileSync(`${s.staging}/index.php`, `v${i}`);
      const r = await publish(s.siteId);
      assert.equal(r.status, 'ready');
      ids.push(r.id);
    }
    const rows = await m.db('releases').where({ site_id: s.siteId }).orderBy('number');
    assert.deepEqual(rows.map((r: any) => r.on_disk), [false, false, true, true]);
    assert.equal(fs.existsSync(`${s.releases}/1`), false);
    assert.equal(fs.existsSync(`${s.releases}/2`), false);
    // Roll back to #3, then publish twice: #3 stays while current.
    await m.releaseService.rollback(s.siteId, ids[2], userId);
    fs.writeFileSync(`${s.staging}/index.php`, 'v5');
    probeOk = false;
    await publish(s.siteId); // #5 failed
    probeOk = true;
    fs.writeFileSync(`${s.staging}/index.php`, 'v6');
    const r6 = await publish(s.siteId);
    assert.equal(r6.status, 'ready');
    const after = await m.db('releases').where({ site_id: s.siteId }).orderBy('number');
    assert.deepEqual(after.map((r: any) => [r.number, r.status, r.on_disk]), [
      [1, 'ready', false], [2, 'ready', false], [3, 'ready', false], [4, 'ready', true], [5, 'failed', false], [6, 'ready', true],
    ]);
  } finally {
    m.config.hosting.releasesKeep = keep;
  }
});

test('list, diff (previous / empty / other release / single file), staging status, profile detection', { skip: SKIP }, async () => {
  const s = await newSite({ files: { 'wp-config.php': '<?php', 'wp-includes/version.php': '<?php $v=1;', 'wp-content/uploads/a.jpg': 'J', 'readme.txt': 'a\n' }, dataPaths: [['wp-content/uploads', 'persistent']] });
  const r1 = await publish(s.siteId);
  fs.writeFileSync(`${s.staging}/readme.txt`, 'a\nb\n');
  writeFiles(s.staging, { 'new.txt': 'n' });
  const r2 = await publish(s.siteId);

  const list = await m.releaseService.list(s.siteId, { limit: 1, offset: 0 });
  assert.equal(list.total, 2);
  assert.equal(list.items[0].number, 2);
  assert.equal(list.items[0].isCurrent, true);

  const d = await m.releaseService.diff(s.siteId, r2.id, 'previous');
  assert.equal(d.fromReleaseId, r1.id);
  assert.deepEqual(d.files.map((f) => `${f.status}:${f.path}`).sort(), ['added:new.txt', 'modified:readme.txt']);
  assert.ok(d.files.every((f) => f.patch !== null), 'small diff → patches included');
  const e = await m.releaseService.diff(s.siteId, r1.id, 'empty');
  assert.equal(e.fromCommit, null);
  assert.equal(e.totalFiles, 3);
  const prevOfFirst = await m.releaseService.diff(s.siteId, r1.id, 'previous');
  assert.equal(prevOfFirst.fromReleaseId, null);
  const one = await m.releaseService.diff(s.siteId, r2.id, r1.id, 'readme.txt');
  assert.equal(one.files.length, 1);
  assert.match(one.files[0].patch ?? '', /^\+b$/m);
  await assert.rejects(m.releaseService.diff(s.siteId, r2.id, r1.id, 'nope.txt'), (err: any) => err.statusCode === 404);
  const other = await newSite({ files: { 'x': 'x' } });
  const ro = await publish(other.siteId);
  await assert.rejects(m.releaseService.diff(s.siteId, r2.id, ro.id), (err: any) => err.statusCode === 404, 'release of another site');
  await assert.rejects(m.releaseService.get(s.siteId, ro.id), (err: any) => err.statusCode === 404);

  fs.rmSync(`${s.staging}/new.txt`);
  writeFiles(s.staging, { 'later.txt': 'l' });
  const st = await m.releaseService.stagingStatus(s.siteId);
  assert.deepEqual(st.files.map((f) => `${f.status}:${f.path}`).sort(), ['added:later.txt', 'deleted:new.txt']);
  assert.equal(st.pendingChanges, 2);

  const det = await m.releaseService.detectProfile(s.siteId);
  assert.equal(det.profile, 'wordpress');
});

test('recoverInterrupted marks in-flight releases as failed', { skip: SKIP }, async () => {
  const s = await newSite({ files: { 'a': 'a' } });
  const [row] = await m.db('releases').insert({ site_id: s.siteId, number: 1, status: 'publishing', trigger: 'auto' }).returning('id');
  await m.releaseService.recoverInterrupted();
  const r = await m.db('releases').where({ id: Number(row.id ?? row) }).first();
  assert.equal(r.status, 'failed');
  assert.equal(r.error, 'interrompue par un redémarrage');
});

test('removeSiteStorage deletes repo, releases and runtime only', { skip: SKIP }, async () => {
  const s = await newSite({ files: { 'a': 'a' } });
  await publish(s.siteId);
  const siteDir = m.localPaths.site(accountId, s.siteId);
  fs.writeFileSync(`${siteDir}/keep.txt`, 'k');
  await m.releaseService.removeSiteStorage(accountId, s.siteId);
  assert.deepEqual(fs.readdirSync(siteDir), ['keep.txt']);
  assert.equal(fs.existsSync(s.staging), true, 'staging untouched');
});

test('the scan diffs against the LIVE release: content of a blocked (infected) release is scanned again', { skip: SKIP }, async () => {
  const s = await newSite({ files: { 'index.php': 'v1' } });
  const seen: string[][] = [];
  m.setScanner({ name: 'fake', scan: async (ctx) => {
    seen.push([...ctx.changedFiles].sort());
    return ctx.changedFiles.includes('evil.php')
      ? { scanner: 'fake', verdict: 'infected', findings: [{ path: 'evil.php', rule: 'x', severity: 'critical', message: 'bad' }] }
      : { scanner: 'fake', verdict: 'clean', findings: [] };
  } });
  const r1 = await publish(s.siteId);
  assert.equal(r1.status, 'ready');
  writeFiles(s.staging, { 'evil.php': '<?php system($_GET[1]);' });
  const r2 = await publish(s.siteId);
  assert.equal(r2.status, 'awaiting_approval');
  writeFiles(s.staging, { 'harmless.txt': 'h' });
  const r3 = await publish(s.siteId);
  assert.equal(r3.status, 'awaiting_approval', 'evil.php is still in the delta vs the live release');
  assert.equal(JSON.parse(typeof r3.scan === 'string' ? r3.scan : JSON.stringify(r3.scan)).blocked, true);
  assert.deepEqual(seen.at(-1), ['evil.php', 'harmless.txt']);
  assert.equal(r3.files_added, 2);
  assert.equal(await currentId(s.siteId), r1.id);
});

test('approve refuses a release superseded by a newer published one', { skip: SKIP }, async () => {
  const s = await newSite({ files: { 'index.php': 'v1' } });
  m.setScanner({ name: 'fake', scan: async () => ({ scanner: 'fake', verdict: 'suspicious', findings: [] }) });
  const old = await publish(s.siteId);
  assert.equal(old.status, 'awaiting_approval');
  m.setScanner(m.noopScanner);
  fs.writeFileSync(`${s.staging}/index.php`, 'v2');
  const newer = await publish(s.siteId);
  assert.equal(newer.status, 'ready');
  await assert.rejects(m.releaseService.approve(s.siteId, old.id, userId), (e: any) => e.code === 'releaseSuperseded' && e.statusCode === 409);
  assert.equal((await m.db('releases').where({ id: old.id }).first()).status, 'awaiting_approval');
  assert.equal(m.internals.locks.has(s.siteId), false);
});

test('recoverInterrupted re-points current, removes *.tmp and stale git locks; rollback repairs a disk out of sync', { skip: SKIP }, async () => {
  const s = await newSite({ files: { 'index.php': 'v1' } });
  const r1 = await publish(s.siteId);
  fs.writeFileSync(`${s.staging}/index.php`, 'v2');
  const r2 = await publish(s.siteId);
  assert.equal(r2.status, 'ready');
  // Crash of #3 between the switch and the healthcheck (unverified tree live), a killed git, a half-built tree.
  const [row] = await m.db('releases').insert({ site_id: s.siteId, number: 3, status: 'publishing', trigger: 'auto', on_disk: true }).returning('id');
  fs.mkdirSync(`${s.releases}/3`);
  m.switchCurrent(s.releases, 3, links ?? undefined);
  fs.mkdirSync(`${s.releases}/4.tmp`);
  const repo = m.localPaths.repo(accountId, s.siteId);
  fs.writeFileSync(`${repo}/index.lock`, '');
  calls.reload.length = 0;
  await m.releaseService.recoverInterrupted();
  assert.equal((await m.db('releases').where({ id: Number(row.id ?? row) }).first()).status, 'failed');
  assert.equal(m.readCurrent(s.releases, links ?? undefined), 2);
  assert.equal(fs.existsSync(`${s.releases}/4.tmp`), false);
  assert.equal(fs.existsSync(`${repo}/index.lock`), false);
  assert.deepEqual(calls.reload, [s.siteId]);

  // Disk out of sync with the DB (crash during a rollback): the recorded current release can be restored.
  m.switchCurrent(s.releases, 1, links ?? undefined);
  await m.releaseService.rollback(s.siteId, r2.id, userId);
  assert.equal(m.readCurrent(s.releases, links ?? undefined), 2);
  await assert.rejects(m.releaseService.rollback(s.siteId, r2.id, userId), (e: any) => e.code === 'releaseIsCurrent');
  // ensureSiteStorage (reconcile) repairs too, without reloading.
  m.switchCurrent(s.releases, 1, links ?? undefined);
  calls.reload.length = 0;
  await m.releaseService.ensureSiteStorage(s.siteId);
  assert.equal(m.readCurrent(s.releases, links ?? undefined), 2);
  assert.deepEqual(calls.reload, []);
  assert.equal(await currentId(s.siteId), r2.id);
  void r1;
});

test('rollback rebuilds an on-disk tree whose data links no longer match the data paths', { skip: SKIP }, async () => {
  const s = await newSite({ files: { 'index.php': 'v1' } });
  const r1 = await publish(s.siteId);
  fs.writeFileSync(`${s.staging}/index.php`, 'v2');
  await publish(s.siteId);
  assert.equal(fs.existsSync(`${s.releases}/1`), true);
  await m.db('site_data_paths').insert({ site_id: s.siteId, path: 'up', policy: 'persistent' });
  await m.releaseService.rollback(s.siteId, r1.id, userId);
  assert.equal(m.readCurrent(s.releases, links ?? undefined), 1);
  assert.equal((links ?? m.realLinkOps).readlink(`${s.releases}/1/up`), '/srv/data/up');
  assert.equal(fs.readFileSync(`${s.releases}/1/index.php`, 'utf8'), 'v1');
});

const defaultHostd = () => ({
  ensureDataPaths: async (_spec: unknown, p: string[]) => { calls.ensure.push(p); },
  seedDataPath: async (_spec: unknown, p: string) => { calls.seed.push(p); return { copied: true, files: 1 }; },
  clearDataPaths: async (_spec: unknown, p: string[]) => { calls.clear.push(p); },
});

test('a failed container reload counts as a failed healthcheck: automatic rollback, nothing probed', { skip: SKIP }, async () => {
  const s = await newSite({ files: { 'index.php': 'v1' } });
  const r1 = await publish(s.siteId);
  assert.equal(r1.status, 'ready');
  fs.writeFileSync(`${s.staging}/index.php`, 'v2');
  let reloads = 0;
  m.setReleaseDeps({
    reloadSite: async (siteId) => {
      calls.reload.push(siteId);
      reloads++;
      return reloads === 1 ? { ok: false, errors: ['oblimint-site-x: exec timed out'] } : { ok: true, errors: [] };
    },
  });
  calls.probes.length = 0;
  try {
    const r2 = await publish(s.siteId);
    assert.equal(r2.status, 'failed');
    assert.match(r2.error, /rechargement des conteneurs en échec : oblimint-site-x: exec timed out/);
    assert.equal(calls.probes.length, 0, 'the healthcheck of a non-reloaded container proves nothing');
    assert.equal(await currentId(s.siteId), r1.id);
    assert.equal(m.readCurrent(s.releases, links ?? undefined), 1);
    assert.equal(reloads, 2, 'reloaded again after switching back');
  } finally {
    m.setReleaseDeps({ reloadSite: async (siteId) => { calls.reload.push(siteId); return { ok: true, errors: [] }; } });
  }
});

test('hostd busy: retried with backoff; still busy → failed', { skip: SKIP }, async () => {
  const { HostdError } = await import('../hostd/client');
  const s = await newSite({ files: { 'index.php': 'v1', 'up/a.jpg': 'J' }, dataPaths: [['up', 'persistent']] });
  let busyLeft = 2;
  m.setReleaseDeps({
    hostd: () => ({
      ...defaultHostd(),
      ensureDataPaths: async (_spec: unknown, p: string[]) => {
        if (busyLeft-- > 0) throw new HostdError(409, 'account busy', 'busy');
        calls.ensure.push(p);
      },
    }),
  });
  try {
    const ok = await publish(s.siteId);
    assert.equal(ok.status, 'ready', JSON.stringify(ok.log));
    assert.equal(ok.log.filter((l: any) => /hostd indisponible/.test(l.message)).length, 2);
    busyLeft = 99;
    fs.writeFileSync(`${s.staging}/index.php`, 'v2');
    const ko = await publish(s.siteId);
    assert.equal(ko.status, 'failed');
    assert.match(ko.error, /chemins de données \(hostd\) : account busy/);
    assert.equal(await currentId(s.siteId), ok.id);
  } finally {
    m.setReleaseDeps({ hostd: defaultHostd });
  }
});

test('disk repair removes trees not recorded on disk (interrupted prune, crash before on_disk)', { skip: SKIP }, async () => {
  const s = await newSite({ files: { 'index.php': 'v1' } });
  const r1 = await publish(s.siteId);
  fs.writeFileSync(`${s.staging}/index.php`, 'v2');
  await publish(s.siteId);
  // #1 half-pruned: row already off disk, tree still there; #9 has no row at all.
  await m.db('releases').where({ id: r1.id }).update({ on_disk: false });
  fs.mkdirSync(`${s.releases}/9/x`, { recursive: true });
  await m.releaseService.ensureSiteStorage(s.siteId);
  assert.equal(fs.existsSync(`${s.releases}/1`), false);
  assert.equal(fs.existsSync(`${s.releases}/9`), false);
  assert.equal(fs.existsSync(`${s.releases}/2`), true, 'current kept');
  assert.equal(m.readCurrent(s.releases, links ?? undefined), 2);
});

test('data path deleted: the live release is rebuilt BEFORE the change applies', { skip: SKIP }, async () => {
  const s = await newSite({ files: { 'index.php': 'v1', 'up/a.jpg': 'J' }, dataPaths: [['up', 'persistent'], ['cache', 'ephemeral']] });
  const r1 = await publish(s.siteId);
  assert.equal(r1.status, 'ready');
  const lo = links ?? m.realLinkOps;
  assert.equal(lo.readlink(`${s.releases}/1/up`), '/srv/data/up');

  // Adding a data path: nothing to rebuild (stricter rules, link at the next publish).
  let applied = 0;
  const added = await m.releaseService.applyDataPathChange(s.siteId, {
    next: [{ path: 'up', policy: 'persistent' }, { path: 'cache', policy: 'ephemeral' }, { path: 'new', policy: 'persistent' }],
    userId, apply: async () => { applied++; },
  });
  assert.deepEqual(added, { rebuiltReleaseId: null });
  assert.equal(applied, 1);

  // Deleting `up` with a failing healthcheck: nothing applied, old tree live, 502.
  probeOk = false;
  applied = 0;
  await assert.rejects(m.releaseService.applyDataPathChange(s.siteId, {
    next: [{ path: 'cache', policy: 'ephemeral' }], userId, apply: async () => { applied++; },
  }), (e: any) => e.code === 'releaseRebuildFailed' && e.statusCode === 502);
  assert.equal(applied, 0);
  assert.equal(await currentId(s.siteId), r1.id);
  assert.equal(m.readCurrent(s.releases, links ?? undefined), 1);
  assert.equal(m.internals.locks.has(s.siteId), false);

  // Deleting `up`: release #3 = same commit, no `up` link, live, then the row change applies.
  probeOk = true;
  const order: string[] = [];
  const res = await m.releaseService.applyDataPathChange(s.siteId, {
    next: [{ path: 'cache', policy: 'ephemeral' }], userId,
    apply: async () => { order.push(`apply current=${m.readCurrent(s.releases, links ?? undefined)}`); },
  });
  assert.ok(res.rebuiltReleaseId);
  const rebuilt = await m.db('releases').where({ id: res.rebuiltReleaseId }).first();
  assert.equal(rebuilt.status, 'ready');
  assert.equal(rebuilt.number, 3);
  assert.equal(rebuilt.commit_sha, r1.commit_sha);
  assert.deepEqual(order, ['apply current=3'], 'the DB change applies once the rebuilt tree is live');
  assert.equal(await currentId(s.siteId), rebuilt.id);
  assert.equal(lo.isLink(`${s.releases}/3/up`), false);
  assert.equal(fs.existsSync(`${s.releases}/3/up`), false);
  assert.equal(fs.readFileSync(`${s.releases}/3/index.php`, 'utf8'), 'v1');

  // No exposure change (`cache` ephemeral → persistent): apply only.
  const same = await m.releaseService.applyDataPathChange(s.siteId, { next: [{ path: 'cache', policy: 'persistent' }], userId, apply: async () => {} });
  assert.equal(same.rebuiltReleaseId, null);
});

test('approve: a rebuild of older content does not supersede a waiting release', { skip: SKIP }, async () => {
  const s = await newSite({ files: { 'index.php': 'v1', 'up/a': 'a' }, dataPaths: [['up', 'persistent']] });
  await publish(s.siteId);
  m.setScanner({ name: 'fake', scan: async () => ({ scanner: 'fake', verdict: 'suspicious', findings: [] }) });
  fs.writeFileSync(`${s.staging}/index.php`, 'v2');
  const waiting = await publish(s.siteId);
  assert.equal(waiting.status, 'awaiting_approval');
  m.setScanner(m.noopScanner);
  const rb = await m.releaseService.applyDataPathChange(s.siteId, {
    next: [], userId, apply: async () => { await m.db('site_data_paths').where({ site_id: s.siteId }).del(); },
  });
  assert.ok(rb.rebuiltReleaseId);
  await m.releaseService.approve(s.siteId, waiting.id, userId);
  const done = await settle(s.siteId, waiting.id);
  assert.equal(done.status, 'ready');
  assert.equal(fs.readFileSync(`${s.releases}/${done.number}/index.php`, 'utf8'), 'v2');
});

test('lockForTeardown: refused while a publication runs, blocks publications while held', { skip: SKIP }, async () => {
  const s = await newSite({ files: { 'index.php': 'v1' } });
  const running = await m.releaseService.publish(s.siteId, { trigger: 'manual', userId });
  await assert.rejects(m.releaseService.lockForTeardown([s.siteId]), (e: any) => e.code === 'publishInProgress');
  await settle(s.siteId, running.id);
  const unlock = await m.releaseService.lockForTeardown([s.siteId]);
  await assert.rejects(m.releaseService.publish(s.siteId, { trigger: 'manual', userId }), (e: any) => e.code === 'publishInProgress');
  await assert.rejects(m.releaseService.applyDataPathChange(s.siteId, { next: [], userId, apply: async () => {} }), (e: any) => e.code === 'publishInProgress');
  unlock();
  assert.equal(m.internals.locks.has(s.siteId), false);
});

test('adapter run past its publication or deferred: publish / approve another release / rollback refused (adapterBusy)', { skip: SKIP }, async () => {
  const s = await newSite({ files: { 'index.php': 'v1' } });
  const r1 = await settle(s.siteId, (await m.releaseService.publish(s.siteId, { trigger: 'manual', userId })).id);
  assert.equal(r1.status, 'ready');
  fs.writeFileSync(`${s.staging}/index.php`, 'v2');
  const r2 = await settle(s.siteId, (await m.releaseService.publish(s.siteId, { trigger: 'manual', userId })).id);
  assert.equal(r2.status, 'ready');
  fs.writeFileSync(`${s.staging}/index.php`, 'v3');
  const insertRun = async (status: string, analysis: Record<string, unknown>) => {
    const [row] = await m.db('adapter_runs').insert({
      tenant_id: 1, account_id: accountId, site_id: s.siteId, adapter: 'wordpress', action: 'update', status, options: '{}',
      base_release_id: r2.id, analysis: JSON.stringify(analysis), log: '[]',
    }).returning('id');
    return Number(row.id ?? row);
  };
  // post_deploy (migrations + healthcheck): every pipeline entry point refuses.
  const run = await insertRun('post_deploy', { verdict: 'clean' });
  await assert.rejects(m.releaseService.publish(s.siteId, { trigger: 'auto', userId: null }), (e: any) => e.code === 'adapterBusy');
  await assert.rejects(m.releaseService.rollback(s.siteId, r1.id, userId), (e: any) => e.code === 'adapterBusy');
  // Deferred (its release awaiting approval, pendingReflect kept): still refused.
  await m.db('adapter_runs').where({ id: run }).update({ status: 'awaiting_approval', analysis: JSON.stringify({ verdict: 'clean', pendingReflect: [] }) });
  await assert.rejects(m.releaseService.publish(s.siteId, { trigger: 'manual', userId }), (e: any) => e.code === 'adapterBusy');
  // A plain awaiting_approval run (nothing to continue) or a final run does not hold the site.
  await m.db('adapter_runs').where({ id: run }).update({ status: 'failed', analysis: JSON.stringify({ verdict: 'clean' }) });
  const r3 = await settle(s.siteId, (await m.releaseService.publish(s.siteId, { trigger: 'manual', userId })).id);
  assert.equal(r3.status, 'ready');
});
