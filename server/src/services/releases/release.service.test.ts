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

test('leak guard: block fails the release (nothing live, leakBlocked), warn publishes with the findings, allowlist ignores a path', { skip: SKIP }, async () => {
  const token = 'ob' + 'k_7_' + 'z'.repeat(43);
  const s = await newSite({ files: { 'index.php': '<?php echo 1;', 'assets/app.js': `const k = "${token}";`, 'dump.sql': 'INSERT INTO t VALUES (1);' } });
  const blocked = await publish(s.siteId);
  assert.equal(blocked.status, 'failed', JSON.stringify(blocked.log));
  assert.match(blocked.error, /^garde anti-fuite/);
  assert.equal(await currentId(s.siteId), null);
  assert.equal(calls.reload.length, 0);
  const scan = JSON.parse(typeof blocked.scan === 'string' ? blocked.scan : JSON.stringify(blocked.scan));
  assert.deepEqual([scan.leaks.policy, scan.leaks.blocked, scan.leaks.critical], ['block', true, 2]);
  assert.equal(scan.leaks.findings.find((f: any) => f.rule === 'secret.panel-token').keyId, 7);
  const detail = await m.releaseService.get(s.siteId, blocked.id);
  assert.equal(detail.errorCode, 'leakBlocked');
  assert.ok(detail.log.some((l) => l.message.startsWith('fuite : assets/app.js:1 — secret.panel-token')));
  assert.ok(!JSON.stringify(detail).includes(token), 'the secret never reaches the release (log, scan, error)');

  // Policy warn: published, findings kept in the scan and the log.
  await m.db('sites').where({ id: s.siteId }).update({ leak_policy: 'warn' });
  const warned = await publish(s.siteId);
  assert.equal(warned.status, 'ready', JSON.stringify(warned.log));
  const ws = JSON.parse(typeof warned.scan === 'string' ? warned.scan : JSON.stringify(warned.scan));
  assert.deepEqual([ws.leaks.blocked, ws.leaks.critical], [false, 2]);

  // Back to block: the token is removed, the dump is allowlisted → clean release.
  await m.db('sites').where({ id: s.siteId }).update({ leak_policy: 'block', leak_allowlist: JSON.stringify(['dump.sql']) });
  fs.writeFileSync(`${s.staging}/assets/app.js`, 'const k = process.env.KEY;');
  const clean = await publish(s.siteId);
  assert.equal(clean.status, 'ready', JSON.stringify(clean.log));
  const cs = JSON.parse(typeof clean.scan === 'string' ? clean.scan : JSON.stringify(clean.scan));
  assert.deepEqual([cs.leaks.critical, cs.leaks.warn, cs.leaks.allowlisted], [0, 0, 1]);
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
  assert.equal(d.contentHidden, false);
  // M1: without the code right, names and stats only; a file's patch is refused (before its existence is told).
  const names = await m.releaseService.diff(s.siteId, r2.id, 'previous', null, { content: false });
  assert.equal(names.contentHidden, true);
  assert.deepEqual(names.files.map((f) => `${f.status}:${f.path}`).sort(), ['added:new.txt', 'modified:readme.txt']);
  assert.ok(names.files.every((f) => f.patch === null && !f.patchTruncated), 'no patch inlined');
  assert.deepEqual(names.files.map((f) => f.additions + f.deletions), d.files.map((f) => f.additions + f.deletions), 'stats kept');
  await assert.rejects(m.releaseService.diff(s.siteId, r2.id, r1.id, 'readme.txt', { content: false }), (err: any) => err.statusCode === 403 && err.code === 'codeReadForbidden');
  await assert.rejects(m.releaseService.diff(s.siteId, r2.id, r1.id, 'nope.txt', { content: false }), (err: any) => err.statusCode === 403);
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

test('GET /sites/:id/releases/:rid/diff: the patches follow the code right of the caller (M1, at the route)', { skip: SKIP }, async (t) => {
  const s = await newSite({ files: { 'index.php': '<?php echo 1;\n', 'config.php': '<?php $secret = "s3cr3t";\n' } });
  await publish(s.siteId);
  fs.writeFileSync(`${s.staging}/config.php`, '<?php $secret = "rotated";\n');
  const r2 = await publish(s.siteId);

  const express = (await import('express')).default;
  const { setRequestActor } = await import('../hosting/access');
  const { errorHandler } = await import('../../middleware/errorHandler');
  const releasesRoutes = (await import('../../routes/releases.routes')).default;
  type Actor = import('../hosting/access').HostingActor;
  const client = (uid: number, caps: string[]): Actor => ({ kind: 'client', userId: uid, tenantId: 1, accounts: new Map([[accountId, new Set(caps as never[])]]) });
  const staff = (uid: number, caps: string[]): Actor => ({ kind: 'staff', userId: uid, tenantId: 1, globalView: false, caps: new Set(caps) });
  const actors: Record<string, Actor> = {
    helpdesk: staff(9001, ['overview.read', 'users.manage']),
    member: client(9002, []),
    alice: client(9003, ['files.manage', 'sites.manage']),
    approver: client(9004, ['releases.approve']),
    ops: staff(9005, ['sites.manage']),
  };
  // The actor is set as an API-key request would set it: the route's own resolveActor / loadSite / code gate run unchanged.
  const app = express();
  app.use((req, _res, next) => {
    const who = String(req.headers['x-actor']);
    (req as unknown as { session: unknown }).session = { userId: actors[who].userId };
    req.tenantId = 1;
    setRequestActor(req, actors[who]);
    next();
  });
  app.use('/sites', releasesRoutes);
  app.use(errorHandler);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}/sites/${s.siteId}/releases/${r2.id}/diff`;
  type DiffBody = { success: boolean; code?: string; data?: { contentHidden: boolean; files: Array<{ path: string; patch: string | null; additions: number }> } };
  const get = async (who: string, qs = '') => {
    const r = await fetch(`${base}${qs}`, { headers: { 'x-actor': who } });
    return { status: r.status, body: await r.json() as DiffBody };
  };

  // (a) read only: names and stats, every patch null — the secret never leaves.
  for (const who of ['helpdesk', 'member']) {
    const r = await get(who);
    assert.equal(r.status, 200, who);
    assert.equal(r.body.data?.contentHidden, true, `${who}: contentHidden`);
    assert.deepEqual(r.body.data?.files.map((f) => f.path), ['config.php'], `${who}: names kept`);
    assert.ok(r.body.data?.files.every((f) => f.patch === null && f.additions === 1), `${who}: stats only, no patch`);
    assert.doesNotMatch(JSON.stringify(r.body), /s3cr3t|rotated/, `${who}: no file content in the answer`);
    // (b) ?file= (and against=empty, the whole tree) → 403 codeReadForbidden.
    const one = await get(who, '?file=config.php');
    assert.equal(one.status, 403, `${who}: ?file=`);
    assert.equal(one.body.code, 'codeReadForbidden');
    assert.equal((await get(who, '?against=empty&file=index.php')).body.code, 'codeReadForbidden', `${who}: against=empty`);
  }
  // (c) the code right (client files.manage or releases.approve, staff sites.manage): the patches inline.
  for (const who of ['alice', 'approver', 'ops']) {
    const r = await get(who);
    assert.equal(r.status, 200, who);
    assert.equal(r.body.data?.contentHidden, false, `${who}: content shown`);
    assert.match(r.body.data?.files[0].patch ?? '', /rotated/, `${who}: inline patch`);
    const one = await get(who, '?file=config.php');
    assert.equal(one.status, 200, `${who}: ?file=`);
    assert.match(one.body.data?.files[0].patch ?? '', /^\+<\?php \$secret = "rotated";$/m);
  }
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

// ── Feature A: rollback detection, guard, copy of a release into the staging ──

const siteRow = (siteId: number) => m.db('sites').where({ id: siteId }).first();
const wsRelease = new Map<string, number>();
const restoreCalls = { ensure: 0, remove: 0, apply: [] as number[] };
let applyDelayMs = 0;

/** hostd fakes of a copy into the staging: the workspace is releases/<n>, applyToStaging copies / deletes in the staging. */
function installRestoreFakes(): void {
  restoreCalls.ensure = 0;
  restoreCalls.remove = 0;
  restoreCalls.apply.length = 0;
  applyDelayMs = 0;
  m.setReleaseDeps({
    ensureWorkspace: async (_n, spec) => { restoreCalls.ensure++; wsRelease.set(`${spec.siteId}:${spec.workspaceId}`, spec.releaseNumber); return { files: 0, bytes: 0 }; },
    removeWorkspace: async (_n, spec) => { restoreCalls.remove++; wsRelease.delete(`${spec.siteId}:${spec.workspaceId}`); },
    applyToStaging: async (_n, spec, source, changes) => {
      restoreCalls.apply.push(changes.length);
      if (applyDelayMs) await new Promise((r) => setTimeout(r, applyDelayMs));
      const n = wsRelease.get(`${spec.siteId}:${(source as { workspaceId: number }).workspaceId}`);
      assert.ok(n, 'workspace ensured before the copy');
      const rel = `${m.localPaths.releases(spec.accountId, spec.siteId)}/${n}`;
      const stg = m.localPaths.siteStaging(spec.accountId, spec.slug);
      let written = 0;
      let deleted = 0;
      for (const c of changes) {
        const dst = path.join(stg, c.path);
        if (c.op === 'delete') { fs.rmSync(dst, { recursive: true, force: true }); deleted++; continue; }
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(rel, c.path), dst);
        written++;
      }
      return { written, deleted, conflicts: [] };
    },
  });
}

/** A candidate commit (adapter) on top of `base` with some files changed. */
async function candidateFrom(siteId: number, staging: string, base: string, files: Record<string, string>): Promise<string> {
  const { runGit } = await import('./git');
  const repo = m.localPaths.repo(accountId, siteId);
  const idx = path.join(os.tmpdir(), `cand-${siteId}-${Date.now()}.index`);
  const env = { GIT_INDEX_FILE: idx, GIT_AUTHOR_NAME: 'adapter', GIT_AUTHOR_EMAIL: 'a@oblimint.local', GIT_COMMITTER_NAME: 'adapter', GIT_COMMITTER_EMAIL: 'a@oblimint.local' };
  await runGit(['read-tree', base], { gitDir: repo, env });
  for (const [p, content] of Object.entries(files)) {
    const oid = (await runGit(['hash-object', '-w', '--stdin'], { gitDir: repo, input: content })).stdout.toString().trim();
    await runGit(['update-index', '--add', '--cacheinfo', `100644,${oid},${p}`], { gitDir: repo, workTree: staging, env });
  }
  const tree = (await runGit(['write-tree'], { gitDir: repo, env })).stdout.toString().trim();
  const sha = (await runGit(['commit-tree', tree, '-p', base, '-m', 'adapter update'], { gitDir: repo, env })).stdout.toString().trim();
  fs.rmSync(idx, { force: true });
  return sha;
}

const CLEAN_SCAN = { scanner: 'test', verdict: 'clean' as const, findings: [] };

async function publishAdapter(siteId: number, staging: string, files: Record<string, string>) {
  const cur = await m.db('releases').where({ id: await currentId(siteId) }).first('id', 'commit_sha');
  const sha = await candidateFrom(siteId, staging, cur.commit_sha, files);
  const rel = await m.releaseService.publishCommit(siteId, {
    commitSha: sha, baseReleaseId: cur.id, trigger: 'adapter', userId: null, message: 'adapter update', scan: CLEAN_SCAN, approvedBy: null,
  });
  return settle(siteId, rel.id);
}

test('Feature A — the rollback flag: set by a human, kept further back, cleared forward / by a staging publication; kept by revert, rebuild, adapter', { skip: SKIP }, async () => {
  const { liveStates } = await import('./liveState');
  const s = await newSite({ files: { 'index.php': 'v1' }, dataPaths: [['cache', 'ephemeral']] });
  const r1 = await publish(s.siteId);
  fs.writeFileSync(`${s.staging}/index.php`, 'v2');
  const r2 = await publish(s.siteId);
  fs.writeFileSync(`${s.staging}/index.php`, 'v3');
  const r3 = await publish(s.siteId);
  let row = await siteRow(s.siteId);
  assert.equal(row.current_release_via, 'publish');
  assert.equal(row.current_release_by, userId);
  assert.ok(row.current_release_at);
  assert.equal(row.rolled_back_from_release_id, null);

  await m.releaseService.rollback(s.siteId, r2.id, userId);
  row = await siteRow(s.siteId);
  assert.equal(row.rolled_back_from_release_id, r3.id, 'rollback 3 → 2');
  assert.equal(row.current_release_via, 'rollback');
  await m.releaseService.rollback(s.siteId, r1.id, userId);
  assert.equal((await siteRow(s.siteId)).rolled_back_from_release_id, r3.id, '2 → 1 keeps 3');
  await m.releaseService.rollback(s.siteId, r3.id, userId);
  assert.equal((await siteRow(s.siteId)).rolled_back_from_release_id, null, 'forward to 3: cleared');
  await m.releaseService.rollback(s.siteId, r2.id, userId);
  assert.equal((await siteRow(s.siteId)).rolled_back_from_release_id, r3.id);

  // An automatic revert (adapter) never touches the flag.
  await m.releaseService.revertTo(s.siteId, r1.id, 'adaptateur wordpress #9 : healthcheck : HTTP 500');
  row = await siteRow(s.siteId);
  assert.equal(row.rolled_back_from_release_id, r3.id);
  assert.equal(row.current_release_via, 'revert');
  assert.equal(row.current_release_by, null);
  assert.match(row.current_release_reason, /healthcheck/);
  const st = (await liveStates([s.siteId])).get(s.siteId)!;
  assert.equal(st.rolledBack, true);
  assert.equal(st.rolledBackFrom?.number, r3.number);
  assert.equal(st.live?.number, r1.number);
  assert.equal(st.latest?.number, r3.number, 'newest published one, display only');

  // A rebuild (data path deleted) keeps it.
  const rebuilt = await m.releaseService.applyDataPathChange(s.siteId, {
    next: [], userId, apply: async () => { await m.db('site_data_paths').where({ site_id: s.siteId }).del(); },
  });
  assert.ok(rebuilt.rebuiltReleaseId);
  row = await siteRow(s.siteId);
  assert.equal(row.current_release_via, 'rebuild');
  assert.equal(row.rolled_back_from_release_id, r3.id);

  // An adapter release keeps it (its staging reflection covers its own paths only, A7).
  const ad = await publishAdapter(s.siteId, s.staging, { 'plugin.php': 'p2' });
  assert.equal(ad.status, 'ready', JSON.stringify(ad.log));
  row = await siteRow(s.siteId);
  assert.equal(row.current_release_via, 'publish');
  assert.equal(row.rolled_back_from_release_id, r3.id);
  const status = await m.releaseService.stagingStatus(s.siteId);
  assert.equal(status.rolledBack, true);
  assert.equal(status.baseIsLive, false);
  assert.ok(status.warningItems.some((w) => w.code === 'liveOlderThanBase' && w.baseNumber === r3.number));
  assert.ok((status.liveChanges?.count ?? 0) > 0, 'what a publication would change on the live site');

  // A publication from the staging is an assumed decision: cleared.
  fs.writeFileSync(`${s.staging}/index.php`, 'v4');
  const r5 = await publish(s.siteId);
  assert.equal(r5.status, 'ready');
  assert.equal((await siteRow(s.siteId)).rolled_back_from_release_id, null);
});

test('Feature A — guard liveRolledBack: adapter release after a rollback (A7), 70 MiB file detected, restored staging passes', { skip: SKIP }, async () => {
  installRestoreFakes();
  const s = await newSite({ files: { 'index.php': 'v1', 'lib.php': 'l1' } });
  await publish(s.siteId);
  fs.writeFileSync(`${s.staging}/index.php`, 'v2');
  const r2 = await publish(s.siteId);
  fs.writeFileSync(`${s.staging}/index.php`, 'v3');
  fs.writeFileSync(`${s.staging}/big.bin`, Buffer.alloc(70 * 1024 * 1024, 7));
  const r3 = await publish(s.siteId);
  assert.equal(r3.status, 'ready');
  await m.releaseService.rollback(s.siteId, r2.id, userId);
  const r4 = await publishAdapter(s.siteId, s.staging, { 'lib.php': 'l2' });
  assert.equal(r4.status, 'ready');
  // The staging still holds release 3: refused, with the paths.
  await assert.rejects(m.releaseService.publish(s.siteId, { trigger: 'api', userId, rollbackGuard: 'refuse' }), (e: any) => {
    assert.equal(e.code, 'liveRolledBack');
    assert.equal(e.details.rolledBackFrom, r3.number);
    assert.equal(e.details.liveRelease, r4.number);
    // lib.php too: the staging holds release 3's version where the live one (adapter) differs.
    assert.deepEqual([...e.details.paths].sort(), ['big.bin', 'index.php', 'lib.php']);
    return true;
  });
  assert.equal(m.internals.locks.has(s.siteId), false);
  // Copy the live release into the staging: the guard has nothing left to protect.
  const res = await m.releaseService.restoreToStaging(s.siteId, r4.id, { userId, apiKeyId: null, discardPending: false });
  assert.equal(res.status, 'done');
  if (res.status !== 'done') return;
  assert.equal(res.remaining, 0);
  assert.equal(res.previousStagingCommit, null);
  assert.equal(fs.readFileSync(`${s.staging}/index.php`, 'utf8'), 'v2');
  assert.equal(fs.readFileSync(`${s.staging}/lib.php`, 'utf8'), 'l2');
  assert.equal(fs.existsSync(`${s.staging}/big.bin`), false);
  assert.equal((await siteRow(s.siteId)).rolled_back_from_release_id, null);
  assert.equal(restoreCalls.ensure, 1);
  assert.equal(restoreCalls.remove, 1, 'workspace always removed');
  await assert.rejects(m.releaseService.publish(s.siteId, { trigger: 'api', userId, rollbackGuard: 'refuse' }), (e: any) => e.code === 'noChanges');
  fs.writeFileSync(`${s.staging}/extra.php`, 'x');
  const r5 = await settle(s.siteId, (await m.releaseService.publish(s.siteId, { trigger: 'api', userId, rollbackGuard: 'refuse' })).id);
  assert.equal(r5.status, 'ready');
});

test('Feature A — restoreToStaging of the live release with stale data links: no hostd data call, tree kept; pending changes; discardPending backup; no notifyChange, no release log line', { skip: SKIP }, async () => {
  installRestoreFakes();
  const { publishScheduler } = await import('./publishScheduler');
  const { runGit } = await import('./git');
  const s = await newSite({ files: { 'index.php': 'v1' }, dataPaths: [['uploads', 'persistent']] });
  await publish(s.siteId);
  fs.writeFileSync(`${s.staging}/index.php`, 'v2');
  const r2 = await publish(s.siteId);
  // Stale data links: the data path row goes away without a rebuild.
  await m.db('site_data_paths').where({ site_id: s.siteId }).del();
  fs.writeFileSync(`${s.staging}/index.php`, 'work in progress');
  for (const k of Object.keys(calls) as Array<keyof typeof calls>) calls[k].length = 0;
  const logBefore = JSON.stringify((await m.db('releases').where({ id: r2.id }).first('log')).log);
  await assert.rejects(m.releaseService.restoreToStaging(s.siteId, r2.id, { userId, apiKeyId: null, discardPending: false }), (e: any) => {
    assert.equal(e.code, 'stagingHasPendingChanges');
    assert.equal(e.details.count, 1);
    assert.deepEqual(e.details.paths, ['index.php']);
    return true;
  });
  const res = await m.releaseService.restoreToStaging(s.siteId, r2.id, { userId, apiKeyId: null, discardPending: true });
  assert.equal(res.status, 'done');
  if (res.status !== 'done') return;
  assert.match(res.previousStagingCommit ?? '', /^[0-9a-f]{40}$/);
  const repo = m.localPaths.repo(accountId, s.siteId);
  const backup = (await runGit(['rev-parse', 'refs/oblimint/staging-before-restore'], { gitDir: repo })).stdout.toString().trim();
  assert.equal(backup, res.previousStagingCommit);
  assert.equal((await runGit(['show', `${backup}:index.php`], { gitDir: repo })).stdout.toString(), 'work in progress', 'the discarded work is kept');
  assert.equal(fs.readFileSync(`${s.staging}/index.php`, 'utf8'), 'v2');
  assert.equal(fs.existsSync(`${s.releases}/2`), true, 'the live tree is never removed (A1)');
  assert.deepEqual([calls.ensure, calls.seed, calls.clear], [[], [], []], 'no hostd call on the data (A2)');
  assert.equal(JSON.stringify((await m.db('releases').where({ id: r2.id }).first('log')).log), logBefore, 'no line in the release log (C11)');
  assert.equal(publishScheduler.lastChange(s.siteId), null, 'never notifies the auto-publish scheduler');
  const st = await m.releaseService.stagingStatus(s.siteId);
  assert.equal(st.pendingChanges, 0, 'HEAD recorded on the restored tree');
  assert.equal(st.baseIsLive, true);
  assert.equal(st.restore?.status, 'done');
});

test('Feature A — restoreToStaging: pruned release materialized then pruned again; batches; running then done; refusals', { skip: SKIP }, async () => {
  installRestoreFakes();
  const keep = m.config.hosting.releasesKeep;
  const tuning = { ...m.internals.restoreTuning };
  m.config.hosting.releasesKeep = 1;
  try {
    const s = await newSite({ files: { 'index.php': 'v1', 'a.php': 'a', 'b.php': 'b', 'c.php': 'c' } });
    const r1 = await publish(s.siteId);
    fs.writeFileSync(`${s.staging}/index.php`, 'v2');
    for (const f of ['a.php', 'b.php', 'c.php']) fs.rmSync(`${s.staging}/${f}`);
    const r2 = await publish(s.siteId);
    fs.writeFileSync(`${s.staging}/index.php`, 'v3');
    const r3 = await publish(s.siteId);
    assert.equal((await m.db('releases').where({ id: r1.id }).first('on_disk')).on_disk, false, 'release 1 pruned');
    // 4 paths differ, batches of 3.
    m.internals.restoreTuning.batchSize = 3;
    const res = await m.releaseService.restoreToStaging(s.siteId, r1.id, { userId, apiKeyId: null, discardPending: false });
    assert.equal(res.status, 'done');
    assert.deepEqual(restoreCalls.apply, [3, 1]);
    assert.equal(fs.readFileSync(`${s.staging}/b.php`, 'utf8'), 'b');
    assert.equal((await m.db('releases').where({ id: r1.id }).first('on_disk')).on_disk, false, 'pruned again');
    assert.equal(fs.existsSync(`${s.releases}/1`), false);
    // Not published: refused (failed / rejected / awaiting approval).
    probeOk = false;
    fs.writeFileSync(`${s.staging}/index.php`, 'broken');
    const failed = await publish(s.siteId);
    probeOk = true;
    assert.equal(failed.status, 'failed');
    await assert.rejects(m.releaseService.restoreToStaging(s.siteId, failed.id, { userId, apiKeyId: null, discardPending: true }), (e: any) => e.code === 'releaseNotReady');
    // A staging too big to compare safely.
    m.internals.restoreTuning.scanMax = 1;
    await assert.rejects(m.releaseService.restoreToStaging(s.siteId, r3.id, { userId, apiKeyId: null, discardPending: true }), (e: any) => e.code === 'stagingTooLarge');
    m.internals.restoreTuning.scanMax = tuning.scanMax;
    assert.equal(m.internals.locks.has(s.siteId), false);
    // Slow copy: answered 'running', then the state turns 'done'; a second copy meanwhile is refused.
    m.internals.restoreTuning.waitMs = 20;
    applyDelayMs = 400;
    const running = await m.releaseService.restoreToStaging(s.siteId, r3.id, { userId, apiKeyId: null, discardPending: true });
    assert.equal(running.status, 'running');
    assert.equal((await m.releaseService.stagingStatus(s.siteId)).restore?.status, 'running');
    await assert.rejects(m.releaseService.restoreToStaging(s.siteId, r3.id, { userId, apiKeyId: null, discardPending: true }), (e: any) => e.code === 'restoreInProgress');
    await assert.rejects(m.releaseService.publish(s.siteId, { trigger: 'manual', userId }), (e: any) => e.code === 'publishInProgress');
    const t0 = Date.now();
    while (m.internals.restoreStates.get(s.siteId)?.status === 'running' && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50));
    const done = (await m.releaseService.stagingStatus(s.siteId)).restore;
    assert.equal(done?.status, 'done');
    assert.equal(done?.result?.releaseNumber, r3.number);
    assert.equal(fs.readFileSync(`${s.staging}/index.php`, 'utf8'), 'v3');
    assert.equal(m.internals.locks.has(s.siteId), false);
  } finally {
    Object.assign(m.internals.restoreTuning, tuning);
    m.config.hosting.releasesKeep = keep;
    applyDelayMs = 0;
  }
});

test('Feature A — more than 5000 paths restored, then the publication passes', { skip: SKIP }, async () => {
  installRestoreFakes();
  const files: Record<string, string> = { 'index.php': 'v1' };
  for (let i = 0; i < 5100; i++) files[`f/${i % 50}/n${i}.txt`] = String(i);
  const s = await newSite({ files });
  const r1 = await publish(s.siteId);
  fs.rmSync(`${s.staging}/f`, { recursive: true, force: true });
  fs.writeFileSync(`${s.staging}/index.php`, 'v2');
  await publish(s.siteId);
  await m.releaseService.rollback(s.siteId, r1.id, userId);
  await assert.rejects(m.releaseService.publish(s.siteId, { trigger: 'api', userId, rollbackGuard: 'refuse' }), (e: any) => e.code === 'liveRolledBack' && e.details.count === 5101 && e.details.paths.length === 20);
  const res = await m.releaseService.restoreToStaging(s.siteId, r1.id, { userId, apiKeyId: null, discardPending: false });
  assert.equal(res.status, 'done');
  if (res.status !== 'done') return;
  assert.equal(res.written, 5101);
  assert.equal(res.remaining, 0);
  fs.writeFileSync(`${s.staging}/index.php`, 'v3');
  const r = await settle(s.siteId, (await m.releaseService.publish(s.siteId, { trigger: 'api', userId, rollbackGuard: 'refuse' })).id);
  assert.equal(r.status, 'ready');
});

test('Feature A — auto-publication held by a rollback: not re-armed, heldInfo, warning, cleared by a publication', { skip: SKIP }, async () => {
  const sched = await import('./publishScheduler');
  sched.setSchedulerDeps({ loadSettings: async () => ({ mode: 'auto', debounceSec: 0 }) });
  try {
    const s = await newSite({ files: { 'index.php': 'v1' }, mode: 'auto' });
    const r1 = await publish(s.siteId);
    fs.writeFileSync(`${s.staging}/index.php`, 'v2');
    const r2 = await publish(s.siteId);
    await m.releaseService.rollback(s.siteId, r1.id, userId);
    sched.publishScheduler.notifyChange(s.siteId);
    await sched.publishScheduler.idle();
    const t0 = Date.now();
    while (!sched.publishScheduler.heldInfo(s.siteId) && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50));
    const held = sched.publishScheduler.heldInfo(s.siteId);
    assert.equal(held?.releaseNumber, r2.number);
    assert.equal(held?.count, 1);
    assert.equal(sched.publishScheduler.deadline(s.siteId), null, 'not re-armed');
    assert.equal(await m.db('releases').where({ site_id: s.siteId }).count('* as n').first().then((x: any) => Number(x.n)), 2, 'nothing published');
    const st = await m.releaseService.stagingStatus(s.siteId);
    assert.ok(st.warningItems.some((w) => w.code === 'autoPublishHeld' && w.releaseNumber === r2.number && w.count === 1));
    // A human publishes anyway (panel confirmation): held and flag cleared.
    const r3 = await settle(s.siteId, (await m.releaseService.publish(s.siteId, { trigger: 'manual', userId, rollbackGuard: 'off' })).id);
    assert.equal(r3.status, 'ready');
    assert.equal(sched.publishScheduler.heldInfo(s.siteId), null);
    assert.equal((await siteRow(s.siteId)).rolled_back_from_release_id, null);
  } finally {
    sched.publishScheduler.stop();
    sched.setSchedulerDeps(null);
    sched.publishScheduler.stop();
  }
});

test('Feature A — migration 016 backfill: rebuild recognized by its commit (not its message), the flag only after a rollback', { skip: SKIP }, async () => {
  const mig = await import('../../db/migrations/016_current_release_provenance');
  const mk = async (name: string) => {
    const [row] = await m.db('sites').insert({
      tenant_id: 1, account_id: accountId, name, slug: `${name}-${Date.now() % 100000}`, base: 'apache-php8.3', publish_mode: 'manual', status: 'active', healthcheck_path: '/',
    }).returning('id');
    return Number(row.id ?? row);
  };
  const rel = async (siteId: number, number: number, sha: string, at: string, message = 'Publication') => {
    const [row] = await m.db('releases').insert({
      site_id: siteId, number, status: 'ready', trigger: 'manual', message, author_user_id: userId, commit_sha: sha, log: '[]', on_disk: false, published_at: at,
    }).returning('id');
    return Number(row.id ?? row);
  };
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  // Same commit as an older ready release, ordinary message: a rebuild.
  const sRebuild = await mk('mig-rebuild');
  await rel(sRebuild, 1, A, '2026-01-01T00:00:00Z');
  await rel(sRebuild, 2, B, '2026-01-02T00:00:00Z');
  const third = await rel(sRebuild, 3, A, '2026-01-03T00:00:00Z');
  await m.db('sites').where({ id: sRebuild }).update({ current_release_id: third });
  // Rolled back by a human (audit), then by an automatic revert.
  const sRollback = await mk('mig-rollback');
  const rb1 = await rel(sRollback, 1, A, '2026-01-01T00:00:00Z');
  const rb2 = await rel(sRollback, 2, B, '2026-01-02T00:00:00Z');
  await m.db('sites').where({ id: sRollback }).update({ current_release_id: rb1 });
  await m.db('audit_logs').insert({ tenant_id: 1, user_id: userId, action: 'release.rollback', resource_type: 'release', resource_path: String(rb1), details: JSON.stringify({ siteId: sRollback }), created_at: '2026-01-03T00:00:00Z' });
  const sRevert = await mk('mig-revert');
  const rv1 = await rel(sRevert, 1, A, '2026-01-01T00:00:00Z');
  await rel(sRevert, 2, B, '2026-01-02T00:00:00Z');
  await m.db('sites').where({ id: sRevert }).update({ current_release_id: rv1 });
  await m.db('audit_logs').insert({ tenant_id: 1, action: 'release.revert', resource_type: 'release', resource_path: String(rv1), details: JSON.stringify({ siteId: sRevert, reason: 'adaptateur x : migrations' }), created_at: '2026-01-03T00:00:00Z' });

  await mig.down(m.db);
  await mig.up(m.db);
  const get = (id: number) => m.db('sites').where({ id }).first('current_release_via', 'current_release_by', 'current_release_reason', 'rolled_back_from_release_id');
  const a = await get(sRebuild);
  assert.equal(a.current_release_via, 'rebuild');
  assert.equal(a.rolled_back_from_release_id, null);
  const b = await get(sRollback);
  assert.equal(b.current_release_via, 'rollback');
  assert.equal(b.current_release_by, userId);
  assert.equal(b.rolled_back_from_release_id, rb2);
  const c = await get(sRevert);
  assert.equal(c.current_release_via, 'revert');
  assert.equal(c.current_release_reason, 'adaptateur x : migrations');
  assert.equal(c.rolled_back_from_release_id, null, 'never after an automatic revert');
});

test('Feature A — restoreToStaging and executable bits: a legacy 0644 tree is rebuilt (not live) or its paths reported (live, modeLost)', { skip: SKIP || (process.platform === 'win32' ? 'no executable bit on Windows' : false) }, async () => {
  installRestoreFakes();
  const s = await newSite({ files: { 'index.php': 'v1', 'bin/run.sh': '#!/bin/sh\necho 1\n' } });
  fs.chmodSync(`${s.staging}/bin/run.sh`, 0o755);
  const r1 = await publish(s.siteId);
  fs.writeFileSync(`${s.staging}/index.php`, 'v2');
  fs.writeFileSync(`${s.staging}/bin/run.sh`, '#!/bin/sh\necho 2\n');
  const r2 = await publish(s.siteId);
  assert.equal(fs.statSync(`${s.releases}/2/bin/run.sh`).mode & 0o777, 0o755, 'new trees keep the bit');
  await m.releaseService.rollback(s.siteId, r1.id, userId);
  // Trees materialized before the executable bit was kept: every file 0644.
  for (const n of [1, 2]) for (const f of ['index.php', 'bin/run.sh']) fs.chmodSync(`${s.releases}/${n}/${f}`, 0o644);
  const mode = (p: string) => fs.statSync(`${s.staging}/${p}`).mode & 0o777;

  // The live release: its tree is never replaced (A1), the paths that lost their bit are reported.
  const live = await m.releaseService.restoreToStaging(s.siteId, r1.id, { userId, apiKeyId: null, discardPending: false });
  assert.equal(live.status, 'done');
  if (live.status !== 'done') return;
  assert.equal(fs.readFileSync(`${s.staging}/bin/run.sh`, 'utf8'), '#!/bin/sh\necho 1\n');
  assert.equal(mode('bin/run.sh'), 0o644);
  assert.deepEqual(live.modeLost, ['bin/run.sh']);
  assert.equal(live.modeLostCount, 1);
  assert.deepEqual(live.remainingPaths, ['bin/run.sh']);
  assert.equal(fs.statSync(`${s.releases}/1/bin/run.sh`).mode & 0o777, 0o644, 'the live tree is untouched');
  assert.equal((await siteRow(s.siteId)).rolled_back_from_release_id, null);

  // Fixed by hand in the staging; then a release that is not live: its stale tree is rebuilt from git.
  fs.chmodSync(`${s.staging}/bin/run.sh`, 0o755);
  // HEAD was not recorded (a path still differed): the staging counts as unpublished work vs HEAD.
  const old = await m.releaseService.restoreToStaging(s.siteId, r2.id, { userId, apiKeyId: null, discardPending: true });
  assert.equal(old.status, 'done');
  if (old.status !== 'done') return;
  assert.equal(fs.readFileSync(`${s.staging}/bin/run.sh`, 'utf8'), '#!/bin/sh\necho 2\n');
  assert.equal(mode('bin/run.sh'), 0o755);
  assert.deepEqual(old.modeLost, []);
  assert.equal(old.remaining, 0);
  assert.equal((await m.db('releases').where({ id: r2.id }).first('on_disk')).on_disk, true);
  assert.equal(fs.statSync(`${s.releases}/2/bin/run.sh`).mode & 0o777, 0o755, 'rebuilt with the bit');
  assert.equal((await m.releaseService.stagingStatus(s.siteId)).pendingChanges, 0, 'HEAD recorded on the restored tree');
});

test('Feature A — held auto-publication: dropped and re-armed by a forward rollback, never shown without a pending rollback or in manual mode', { skip: SKIP }, async () => {
  const sched = await import('./publishScheduler');
  sched.setSchedulerDeps({ loadSettings: async () => ({ mode: 'auto', debounceSec: 0 }) });
  const count = (siteId: number) => m.db('releases').where({ site_id: siteId }).count('* as n').first().then((x: any) => Number(x.n));
  const waitFor = async (cond: () => Promise<boolean> | boolean, what: string) => {
    const t0 = Date.now();
    while (!(await cond())) {
      if (Date.now() - t0 > 20_000) throw new Error(`timeout: ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  try {
    const s = await newSite({ files: { 'index.php': 'v1' }, mode: 'auto' });
    const r1 = await publish(s.siteId);
    fs.writeFileSync(`${s.staging}/index.php`, 'v2');
    const r2 = await publish(s.siteId);
    await m.releaseService.rollback(s.siteId, r1.id, userId);
    sched.publishScheduler.notifyChange(s.siteId);
    await sched.publishScheduler.idle();
    await waitFor(() => !!sched.publishScheduler.heldInfo(s.siteId), 'held');
    // Work written meanwhile, then the human goes forward again: no rollback pending any more.
    fs.writeFileSync(`${s.staging}/extra.php`, 'x');
    await m.releaseService.rollback(s.siteId, r2.id, userId);
    assert.equal((await siteRow(s.siteId)).rolled_back_from_release_id, null);
    assert.equal(sched.publishScheduler.heldInfo(s.siteId), null, 'dropped');
    await waitFor(async () => (await count(s.siteId)) === 3 && !m.internals.locks.has(s.siteId), 're-armed auto publication');
    const r3 = await m.db('releases').where({ site_id: s.siteId }).orderBy('number', 'desc').first();
    const done = await settle(s.siteId, r3.id);
    assert.equal(done.status, 'ready');
    assert.equal(done.trigger, 'auto');

    // stagingStatus: a stale held entry (no pending rollback, or a manual site) is never reported.
    await m.releaseService.rollback(s.siteId, r1.id, userId);
    sched.publishScheduler.notifyChange(s.siteId);
    await sched.publishScheduler.idle();
    await waitFor(() => !!sched.publishScheduler.heldInfo(s.siteId), 'held again');
    assert.ok((await m.releaseService.stagingStatus(s.siteId)).warningItems.some((w) => w.code === 'autoPublishHeld'));
    await m.db('sites').where({ id: s.siteId }).update({ publish_mode: 'manual' });
    assert.ok(!(await m.releaseService.stagingStatus(s.siteId)).warningItems.some((w) => w.code === 'autoPublishHeld'));
    assert.equal(sched.publishScheduler.heldInfo(s.siteId), null);
  } finally {
    sched.publishScheduler.stop();
    sched.setSchedulerDeps(null);
    sched.publishScheduler.stop();
  }
});
