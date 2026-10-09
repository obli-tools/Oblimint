import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Request } from 'express';
// NO static import of a module that loads config/db: the environment below must be set first.

// ─────────────────────────────────────────────────────────────────────────────
// Modification windows end to end with a REAL database (PGlite harness,
// docs/P3-PLAN.md §15: module windows = port 55451), real git (repo.git,
// candidate commits, publishCommit through the real pipeline) and every other
// module faked: hostd (overlay simulated by an "upper" map exported into
// windows/<w>/export), scan, checksums, auto-validation, snapshots, docker,
// healthchecks, notifications.
// Opt-in: OBLIMINT_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55451/postgres
// ─────────────────────────────────────────────────────────────────────────────

const DB_URL = process.env.OBLIMINT_TEST_DATABASE_URL;
const SKIP = DB_URL ? false : 'OBLIMINT_TEST_DATABASE_URL not set (PGlite harness, port 55451)';

if (DB_URL) {
  const tmpBase = process.env.OBLIMINT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(tmpBase, { recursive: true });
  process.env.DATABASE_URL = DB_URL;
  process.env.OBLIMINT_DATA_DIR = fs.mkdtempSync(path.join(tmpBase, 'win-data-'));
}

type HostingActor = import('../hosting/access').HostingActor;
type DbSnapshot = import('@oblimint/shared').DbSnapshot;
type ChangeAnalysis = import('../maintenance/contracts').ChangeAnalysis;

let m: {
  db: typeof import('../../db').db;
  releaseService: typeof import('../releases/release.service').releaseService;
  relInternals: typeof import('../releases/release.service').__releaseInternals;
  setReleaseDeps: typeof import('../releases/deps').setReleaseDeps;
  setScanner: typeof import('../releases/scan').setScanner;
  noopScanner: typeof import('../releases/scan').noopScanner;
  localPaths: typeof import('../hosting/paths').localPaths;
  windowService: typeof import('./window.service').windowService;
  internals: typeof import('./window.service').__windowInternals;
  setWindowDeps: typeof import('./deps').setWindowDeps;
  siteTokenService: typeof import('./siteTokens').siteTokenService;
  writeFiles: typeof import('../releases/testUtil').writeFiles;
  runGit: typeof import('../releases/git').runGit;
  headCommit: typeof import('../releases/repo').headCommit;
};

let adminId = 0;
let accountId = 0;
let siteSeq = 0;
let admin: HostingActor;

// ── fakes ────────────────────────────────────────────────────────────────────

/** What the application wrote in the overlay of each window: path → content (null = deleted). */
const upper = new Map<number, Record<string, string | null>>();
const mounts = new Map<number, { mode: 'rw' | 'ro'; accountId: number; siteId: number; releaseNumber: number; quarantine: boolean }>();
const calls = {
  ensure: [] as Array<{ windowId: number; mode: string; quarantine: boolean }>,
  remove: [] as Array<{ windowId: number; keepExport: boolean }>,
  recreate: [] as string[], reload: [] as number[], notify: [] as string[], snapshotsCreated: [] as number[],
  restore: [] as number[][], released: [] as number[], staged: [] as number[],
};
let visibleAfter = 0; // propagation: invisible until this many verifications
let verifications = 0;
let analysisFor: (files: string[]) => { score: number; blocked: boolean } = () => ({ score: 5, blocked: false });
let ensureFails = false;
/** ensureWindow fails only for this mode (e.g. the freeze). */
let ensureFailsMode: 'rw' | 'ro' | null = null;
let exportFails = false;
/** A container keeps a PRIVATE rw copy of the overlay (restarted with the old spec) until it is recreated. */
let privateRwCopy = false;
let recreateFixes = true;
let removeFails = false;

function fakeAnalysis(input: import('../maintenance/contracts').AnalyzeInput): ChangeAnalysis {
  const files = input.files.filter((f) => !f.ignored).map((f) => f.path);
  const { score, blocked } = analysisFor(files);
  const level = score >= 90 ? 'critical' : score >= 70 ? 'high' : score >= 30 ? 'medium' : score > 0 ? 'low' : 'none';
  const verdict = blocked ? 'infected' : score >= 30 ? 'suspicious' : 'clean';
  return {
    summary: {
      engines: ['heuristic'], verdict, risk: { score, level }, counts: { added: 0, modified: 0, deleted: 0, total: 0, executable: 0, ignored: 0, bytes: 0 },
      findings: blocked ? 1 : 0, criticalFindings: blocked ? 1 : 0, scannerUnavailable: false, skipped: 0, blocked, analyzedAt: new Date().toISOString(),
    },
    files: input.files.map((f) => ({
      path: f.path, change: f.change, type: f.type, size: f.size, executable: /\.php$/.test(f.path), binary: false,
      risk: score, level, findings: [], ignored: f.ignored ?? null,
    })),
    scan: { scanner: 'fake', verdict, findings: [], risk: { score, level }, blocked },
  };
}

const snapshots = new Map<number, DbSnapshot[]>();

function snapshotRow(id: number, windowId: number): DbSnapshot {
  return {
    id, siteId: null, accountId, instanceId: 1, databaseId: null, databaseName: 'db', engine: 'mariadb', reason: 'window',
    windowId, adapterRunId: null, status: 'ready', sizeBytes: 1, error: null, createdAt: new Date().toISOString(), expiresAt: null, restoredAt: null,
  };
}

before(async () => {
  if (SKIP) return;
  const tu = await import('../releases/testUtil');
  const links = tu.canSymlink() ? null : tu.emulatedLinkOps();
  const { db } = await import('../../db');
  const rel = await import('../releases/release.service');
  const rdeps = await import('../releases/deps');
  const scan = await import('../releases/scan');
  const paths = await import('../hosting/paths');
  const ws = await import('./window.service');
  const wdeps = await import('./deps');
  const tokens = await import('./siteTokens');
  const git = await import('../releases/git');
  const repo = await import('../releases/repo');
  m = {
    db, releaseService: rel.releaseService, relInternals: rel.__releaseInternals, setReleaseDeps: rdeps.setReleaseDeps,
    setScanner: scan.setScanner, noopScanner: scan.noopScanner, localPaths: paths.localPaths, windowService: ws.windowService,
    internals: ws.__windowInternals, setWindowDeps: wdeps.setWindowDeps, siteTokenService: tokens.siteTokenService,
    writeFiles: tu.writeFiles, runGit: git.runGit, headCommit: repo.headCommit,
  };
  await db.migrate.latest();
  const [u] = await db('users').insert({ username: `win-admin-${Date.now()}`, display_name: 'Win Admin', role: 'admin', kind: 'staff' }).returning('id');
  adminId = Number(u.id ?? u);
  admin = { kind: 'staff', userId: adminId, tenantId: 1, globalView: true, caps: '*' };
  const [plan] = await db('plans').insert({ tenant_id: 1, name: `win-plan-${Date.now()}`, limits: JSON.stringify({}) }).returning('id');
  const UID = 20000 + Math.floor(Math.random() * 39000);
  const [acc] = await db('hosting_accounts').insert({
    tenant_id: 1, node_id: 1, plan_id: Number(plan.id ?? plan), username: `win${Date.now() % 100000}`, status: 'active', uid: UID, gid: UID,
  }).returning('id');
  accountId = Number(acc.id ?? acc);

  m.setReleaseDeps({
    ...(links ? { links } : {}),
    reloadSite: async () => ({ ok: true, errors: [] }),
    hostd: () => ({ ensureDataPaths: async () => {}, seedDataPath: async () => ({ copied: false, files: 0 }), clearDataPaths: async () => {} }),
    probe: async () => ({ ok: true, status: 200, error: null }),
    sleep: async () => {},
    health: { attempts: 1, delayMs: 0, timeoutMs: 100 },
    // hostd applyToStaging: copies from the window export into the staging.
    applyToStaging: async (_node, spec, source, changes) => {
      calls.staged.push(spec.siteId);
      const src = source.kind === 'window' ? paths.localPaths.windowExportFiles(spec.accountId, spec.siteId, source.windowId) : '';
      const dst = paths.localPaths.siteStaging(spec.accountId, spec.slug);
      let written = 0;
      let deleted = 0;
      for (const c of changes) {
        if (c.op === 'delete') { fs.rmSync(path.join(dst, c.path), { force: true, recursive: true }); deleted++; continue; }
        fs.mkdirSync(path.dirname(path.join(dst, c.path)), { recursive: true });
        fs.copyFileSync(path.join(src, c.path), path.join(dst, c.path));
        written++;
      }
      return { written, deleted, conflicts: [] };
    },
  });

  m.setWindowDeps({
    hostd: () => ({
      async ensureWindow(spec) {
        if (ensureFails || ensureFailsMode === spec.mode) throw new Error('mount: EBUSY /srv/oblimint/x');
        calls.ensure.push({ windowId: spec.windowId, mode: spec.mode, quarantine: spec.quarantineExecutables });
        mounts.set(spec.windowId, { mode: spec.mode, accountId: spec.accountId, siteId: spec.siteId, releaseNumber: spec.releaseNumber, quarantine: spec.quarantineExecutables });
        return { accountId: spec.accountId, siteId: spec.siteId, windowId: spec.windowId, mounted: true, mode: spec.mode, releaseNumber: spec.releaseNumber, quarantineExecutables: spec.quarantineExecutables, upperBytes: 0, upperEntries: 0, exportReady: false };
      },
      async windowStatus(a, s, w) {
        const mt = mounts.get(w);
        return { accountId: a, siteId: s, windowId: w, mounted: !!mt, mode: mt?.mode ?? null, releaseNumber: mt?.releaseNumber ?? null, quarantineExecutables: !!mt?.quarantine, upperBytes: 12, upperEntries: 3, exportReady: false };
      },
      async exportWindow(spec) {
        if (exportFails) throw new Error('hostd: request timeout');
        const up = upper.get(spec.windowId) ?? {};
        const exp = paths.localPaths.windowExport(spec.accountId, spec.siteId, spec.windowId);
        fs.rmSync(exp, { recursive: true, force: true });
        fs.mkdirSync(`${exp}/files`, { recursive: true });
        const entries = [];
        for (const [p, content] of Object.entries(up)) {
          if (content === null) {
            entries.push({ path: p, change: 'deleted', type: 'file', size: null, mode: null, sha256: null, linkTarget: null, exported: false, skipped: null });
            continue;
          }
          const big = content === '@@toolarge';
          if (!big) {
            fs.mkdirSync(path.dirname(`${exp}/files/${p}`), { recursive: true });
            fs.writeFileSync(`${exp}/files/${p}`, content);
          }
          entries.push({ path: p, change: 'added', type: 'file', size: content.length, mode: 0o644, sha256: 'x', linkTarget: null, exported: !big, skipped: big ? 'tooLarge' : null });
        }
        fs.writeFileSync(`${exp}/manifest.json`, JSON.stringify({ version: 1, windowId: spec.windowId, releaseNumber: 1, createdAt: new Date().toISOString(), entries, truncated: false }));
        return { entries: entries.length, added: entries.length, modified: 0, deleted: 0, bytes: 0, truncated: false };
      },
      async removeWindow(spec, opts) {
        if (removeFails) throw new Error('umount: EBUSY');
        calls.remove.push({ windowId: spec.windowId, keepExport: opts.keepExport });
        mounts.delete(spec.windowId);
        if (!opts.keepExport) fs.rmSync(paths.localPaths.window(spec.accountId, spec.siteId, spec.windowId), { recursive: true, force: true });
      },
      async verifyWindowPropagation(_a, _s, w, pids) {
        verifications++;
        const mt = mounts.get(w);
        if (!mt) throw Object.assign(new Error('window is not mounted'), { status: 409, code: 'windowNotMounted' });
        const mode = privateRwCopy ? 'rw' as const : mt.mode;
        return pids.map((pid) => ({ pid, visible: verifications > visibleAfter, mode, error: null }));
      },
      async listWindows() {
        return [...mounts.entries()].map(([windowId, mt]) => ({ windowId, accountId: mt.accountId, siteId: mt.siteId, mode: mt.mode, releaseNumber: mt.releaseNumber }));
      },
    }),
    analyze: async (input) => fakeAnalysis(input),
    verifyChecksums: async (input) => ({
      report: { providers: [], components: [], filesVerified: 0, filesMismatched: 0, filesUnknown: input.files.length, checkedAt: new Date().toISOString() },
      files: new Map(),
    }),
    decideAutoValidation: (input) => {
      const ok = (input.trigger === 'scheduled' || (input.trigger === 'api' && input.mode === 'scheduled-api')) && input.mode !== 'off'
        && input.analysis.risk.score < input.reviewScore && input.healthcheck.ok && input.baseIsCurrent;
      return { eligible: ok, decision: ok ? 'validate' : 'review', reasons: [{ code: ok ? 'ok' : 'riskTooHigh' }], decidedAt: new Date().toISOString() };
    },
    snapshots: {
      async createForSite(_siteId, ref) {
        calls.snapshotsCreated.push(ref.windowId ?? 0);
        const rows = [snapshotRow(1000 + (ref.windowId ?? 0), ref.windowId ?? 0)];
        snapshots.set(ref.windowId ?? 0, rows);
        return rows;
      },
      async restore(ids) { calls.restore.push(ids); return { restored: ids.length, failed: [] }; },
      async listForWindow(windowId) { return snapshots.get(windowId) ?? []; },
      async release(ref) { calls.released.push(ref.windowId ?? 0); },
    },
    siteContainers: async (siteId) => [{ name: `oblimint-site-${siteId}`, pid: 4242 }],
    recreateContainer: async (_siteId, name) => { calls.recreate.push(name); if (recreateFixes) privateRwCopy = false; },
    reloadSite: async (siteId) => { calls.reload.push(siteId); return { ok: true, errors: [] }; },
    healthcheck: async () => ({ ok: true, status: 200, error: null }),
    probe: async () => ({ ok: true, status: 200, error: null }),
    notify: (event) => { calls.notify.push(event); },
    settings: {
      maintenance: async () => ({ ...(await import('@oblimint/shared')).DEFAULT_HOSTING_SETTINGS.maintenance, ...maintenanceOver }),
      scanner: async () => (await import('@oblimint/shared')).DEFAULT_HOSTING_SETTINGS.scanner,
    },
    stagingChanged: () => {},
    propagationCheck: () => true,
  });
});

let maintenanceOver: Record<string, unknown> = {};

after(async () => {
  if (!SKIP) {
    await m.internals.idle();
    await m.db.destroy();
  }
});

beforeEach(() => {
  for (const k of Object.keys(calls) as Array<keyof typeof calls>) calls[k].length = 0;
  visibleAfter = 0;
  verifications = 0;
  ensureFails = false;
  ensureFailsMode = null;
  exportFails = false;
  privateRwCopy = false;
  recreateFixes = true;
  removeFails = false;
  maintenanceOver = {};
  analysisFor = () => ({ score: 5, blocked: false });
  if (!SKIP) m.setScanner(m.noopScanner);
});

const fakeReq = (userId: number): Request => ({ headers: {}, socket: { remoteAddress: '127.0.0.1' }, session: { userId } } as unknown as Request);

async function settleReleases(siteId: number): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const busy = await m.db('releases').where({ site_id: siteId }).whereIn('status', ['queued', 'scanning', 'publishing']).first('id');
    if (!busy && !m.relInternals.locks.has(siteId)) return;
    if (Date.now() - t0 > 60_000) throw new Error('release stuck');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function settle(siteId: number): Promise<void> {
  await m.internals.idle();
  await settleReleases(siteId);
  await m.internals.idle();
}

/** A site with release #1 live (staging: index.php + wp-config.php). */
async function newSite(opts: { mode?: 'manual' | 'auto' | 'approval' } = {}) {
  const slug = `w${++siteSeq}-${Date.now() % 100000}`;
  const [s] = await m.db('sites').insert({
    tenant_id: 1, account_id: accountId, name: slug, slug, base: 'apache-php8.3', publish_mode: opts.mode ?? 'manual', status: 'active', healthcheck_path: '/',
  }).returning('id');
  const siteId = Number(s.id ?? s);
  const staging = m.localPaths.siteStaging(accountId, slug);
  fs.mkdirSync(staging, { recursive: true });
  m.writeFiles(staging, { 'index.php': '<?php echo 1;', 'wp-config.php': 'cfg' });
  await m.releaseService.ensureSiteStorage(siteId);
  const r = await m.releaseService.publish(siteId, { trigger: 'manual', userId: adminId });
  await settleReleases(siteId);
  const row = await m.db('releases').where({ id: r.id }).first();
  assert.equal(row.status, 'ready', JSON.stringify(row.log));
  return { siteId, slug, staging, repo: m.localPaths.repo(accountId, siteId), release1: row };
}

const row = async (windowId: number) => m.db('maintenance_windows').where({ id: windowId }).first();
const audits = async (action: string) => m.db('audit_logs').where({ action }).count<{ n: string }[]>('* as n').then((r) => Number(r[0].n));

async function openManual(siteId: number, minutes = 30) {
  const w = await m.windowService.open(fakeReq(adminId), admin, siteId, { durationMinutes: minutes });
  assert.equal(w.status, 'opening');
  await settle(siteId);
  const r = await row(w.id);
  assert.equal(r.status, 'open', JSON.stringify(r.log));
  return w.id;
}

async function closeAndAnalyze(siteId: number, windowId: number, content: Record<string, string | null>) {
  upper.set(windowId, content);
  const c = await m.windowService.close(fakeReq(adminId), admin, siteId, windowId);
  assert.equal(c.status, 'closing');
  await settle(siteId);
  return row(windowId);
}

test('open: refusals, snapshots, rw overlay, propagation, guard on the pipeline', { skip: SKIP }, async () => {
  const s = await newSite();
  const id = await openManual(s.siteId);
  const r = await row(id);
  assert.equal(r.overlay, 'rw');
  assert.equal(r.number, 1);
  assert.equal(r.trigger, 'manual');
  assert.equal(r.base_release_id, s.release1.id);
  assert.ok(r.expires_at);
  assert.deepEqual(calls.ensure, [{ windowId: id, mode: 'rw', quarantine: false }]);
  assert.deepEqual(calls.snapshotsCreated, [id]);
  assert.equal(verifications, 1);
  assert.ok(await audits('window.open') >= 1);
  // One window per site; the pipeline is held.
  await assert.rejects(m.windowService.open(fakeReq(adminId), admin, s.siteId, {}), (e: any) => e.code === 'windowActive');
  assert.equal(await m.windowService.blocksPublish(s.siteId), true);
  m.writeFiles(s.staging, { 'new.txt': 'n' });
  await assert.rejects(m.releaseService.publish(s.siteId, { trigger: 'manual', userId: adminId }), (e: any) => e.code === 'windowActive' && e.statusCode === 409);
  await assert.rejects(m.releaseService.rollback(s.siteId, s.release1.id, adminId), (e: any) => e.code === 'releaseIsCurrent' || e.code === 'windowActive');
  await assert.rejects(m.releaseService.applyDataPathChange(s.siteId, { next: [{ path: 'wp-content/uploads', policy: 'typed' }], userId: adminId, apply: async () => {} }),
    (e: any) => e.code === 'windowActive');
  // Extend: within the limit, then windowMaxDuration.
  maintenanceOver = { maxWindowMinutes: 60 };
  const ext = await m.windowService.extend(fakeReq(adminId), admin, s.siteId, id, { minutes: 20 });
  assert.ok(new Date(ext.expiresAt as string).getTime() > new Date(r.expires_at).getTime());
  await assert.rejects(m.windowService.extend(fakeReq(adminId), admin, s.siteId, id, { minutes: 30 }), (e: any) => e.code === 'windowMaxDuration' && e.details.maxMinutes === 60);
  const info = await m.windowService.info(admin, s.siteId);
  assert.equal(info.activeWindow?.id, id);
  assert.equal(info.canOpen, false);
  assert.equal(info.cannotOpenReason, 'windowActive');
  const detail = await m.windowService.get(admin, s.siteId, id);
  assert.deepEqual(detail.live, { upperBytes: 12, upperEntries: 3 });
  assert.equal(detail.snapshotList.length, 1);
  // Not-open operations.
  await assert.rejects(m.windowService.validate(fakeReq(adminId), admin, s.siteId, id, {}), (e: any) => e.code === 'windowNotPending');
  await assert.rejects(m.windowService.files(admin, s.siteId, id, { limit: 10, offset: 0 }), (e: any) => e.code === 'windowNotAnalyzed');
  await assert.rejects(m.windowService.fileDiff(admin, s.siteId, id, 'x'), (e: any) => e.code === 'windowNotAnalyzed');
  // Clean up: empty window → discarded.
  const d = await closeAndAnalyze(s.siteId, id, {});
  assert.equal(d.status, 'discarded');
  assert.equal(d.decision, 'discarded');
  assert.equal(d.overlay, 'unmounted');
  assert.equal(await m.windowService.blocksPublish(s.siteId), false);
});

test('open refusals: windowsDisabled, noRelease, siteStopped, adapterBusy, publishInProgress, windowMaxDuration', { skip: SKIP }, async () => {
  const s = await newSite();
  maintenanceOver = { windowsEnabled: false };
  await assert.rejects(m.windowService.open(fakeReq(adminId), admin, s.siteId, {}), (e: any) => e.code === 'windowsDisabled');
  maintenanceOver = { maxWindowMinutes: 30 };
  await assert.rejects(m.windowService.open(fakeReq(adminId), admin, s.siteId, { durationMinutes: 45 }), (e: any) => e.code === 'windowMaxDuration');
  maintenanceOver = {};
  await m.db('sites').where({ id: s.siteId }).update({ status: 'stopped' });
  await assert.rejects(m.windowService.open(fakeReq(adminId), admin, s.siteId, {}), (e: any) => e.code === 'siteStopped');
  await m.db('sites').where({ id: s.siteId }).update({ status: 'active' });
  const [run] = await m.db('adapter_runs').insert({ tenant_id: 1, account_id: accountId, site_id: s.siteId, adapter: 'wordpress', action: 'update', status: 'running' }).returning('id');
  await assert.rejects(m.windowService.open(fakeReq(adminId), admin, s.siteId, {}), (e: any) => e.code === 'adapterBusy');
  await m.db('adapter_runs').where({ id: Number(run.id ?? run) }).update({ status: 'failed' });
  m.relInternals.locks.add(s.siteId);
  try {
    await assert.rejects(m.windowService.open(fakeReq(adminId), admin, s.siteId, {}), (e: any) => e.code === 'publishInProgress');
  } finally {
    m.relInternals.locks.delete(s.siteId);
  }
  const bare = await m.db('sites').insert({
    tenant_id: 1, account_id: accountId, name: `bare${siteSeq}`, slug: `bare${++siteSeq}-${Date.now() % 1000}`, base: 'apache-php8.3', publish_mode: 'manual', status: 'active',
  }).returning('id');
  await assert.rejects(m.windowService.open(fakeReq(adminId), admin, Number(bare[0].id ?? bare[0]), {}), (e: any) => e.code === 'noRelease');
});

test('manual window: close → analysis → review files / diff → validate → release n+1, staging, HEAD, overlay removed', { skip: SKIP }, async () => {
  const s = await newSite();
  const id = await openManual(s.siteId);
  const r = await closeAndAnalyze(s.siteId, id, {
    'wp-content/plugins/hello/hello.php': '<?php // Hello plugin', 'index.php': '<?php echo 2;', 'wp-config.php': null,
    'dir/.sftpgo-upload.1.part': 'partial',
  });
  assert.equal(r.status, 'pending_review', JSON.stringify(r.log));
  assert.equal(r.overlay, 'ro');
  assert.ok(calls.ensure.some((e) => e.windowId === id && e.mode === 'ro'), 'frozen before the analysis');
  assert.ok(r.candidate_commit);
  assert.equal(r.candidate_ref, `refs/oblimint/candidates/window-${id}`);
  const counts = typeof r.counts === 'string' ? JSON.parse(r.counts) : r.counts;
  assert.equal(counts.total, 3);
  assert.equal(counts.ignored, 1);
  assert.ok(calls.notify.includes('window.pendingReview'));
  assert.equal(await m.windowService.blocksPublish(s.siteId), true, 'frozen overlay still covers the release');

  const files = await m.windowService.files(admin, s.siteId, id, { limit: 50, offset: 0 });
  assert.equal(files.total, 4);
  assert.deepEqual(files.items.filter((f) => f.ignored).map((f) => [f.path, f.ignoreReason]), [['dir/.sftpgo-upload.1.part', 'special']]);
  const added = await m.windowService.files(admin, s.siteId, id, { change: 'added', limit: 50, offset: 0 });
  assert.ok(added.items.every((f) => f.change === 'added'));
  const q = await m.windowService.files(admin, s.siteId, id, { q: 'hello', limit: 50, offset: 0 });
  assert.deepEqual(q.items.map((f) => f.path), ['wp-content/plugins/hello/hello.php']);
  const diff = await m.windowService.fileDiff(admin, s.siteId, id, 'index.php');
  assert.match(diff.patch ?? '', /-<\?php echo 1;\n?\\? ?.*\n?\+<\?php echo 2;|\+<\?php echo 2;/);
  assert.equal(diff.change, 'modified');
  await assert.rejects(m.windowService.fileDiff(admin, s.siteId, id, 'nope.php'), (e: any) => e.statusCode === 404);
  const author = (await m.runGit(['log', '-1', '--format=%an', r.candidate_commit], { gitDir: s.repo })).stdout.toString().trim();
  assert.equal(author, 'window #1');

  const v = await m.windowService.validate(fakeReq(adminId), admin, s.siteId, id, { message: 'Extension Hello' });
  assert.equal(v.status, 'validating');
  await settle(s.siteId);
  const done = await row(id);
  assert.equal(done.status, 'validated', JSON.stringify(done.log));
  assert.equal(done.decision, 'validated');
  assert.equal(done.overlay, 'unmounted');
  const rel = await m.db('releases').where({ id: done.result_release_id }).first();
  assert.equal(rel.status, 'ready', JSON.stringify(rel.log));
  assert.equal(rel.trigger, 'window');
  assert.equal(rel.window_id, id);
  assert.equal(rel.number, 2);
  assert.equal(rel.commit_sha, r.candidate_commit);
  assert.equal(rel.approved_by, adminId);
  assert.equal(rel.message, 'Extension Hello');
  assert.equal((await m.db('sites').where({ id: s.siteId }).first('current_release_id')).current_release_id, rel.id);
  // Staging reflects the window; HEAD fast-forwarded → nothing pending.
  assert.equal(fs.readFileSync(`${s.staging}/wp-content/plugins/hello/hello.php`, 'utf8'), '<?php // Hello plugin');
  assert.equal(fs.existsSync(`${s.staging}/wp-config.php`), false);
  assert.equal(fs.existsSync(`${s.staging}/dir/.sftpgo-upload.1.part`), false, 'ignored paths never reach the staging');
  assert.equal(await m.headCommit(s.repo), r.candidate_commit);
  assert.equal((await m.releaseService.stagingStatus(s.siteId)).pendingChanges, 0);
  assert.ok(calls.remove.some((x) => x.windowId === id && x.keepExport === false));
  assert.ok(calls.released.includes(id), 'snapshots enter retention');
  assert.ok(await audits('window.validate') >= 1);
  // A new window bases on release #2.
  const id2 = await openManual(s.siteId);
  assert.equal((await row(id2)).base_release_number, 2);
  assert.equal((await row(id2)).number, 2);
  await closeAndAnalyze(s.siteId, id2, {});
});

test('reject + restore the databases; candidate ref dropped', { skip: SKIP }, async () => {
  const s = await newSite();
  const id = await openManual(s.siteId);
  const r = await closeAndAnalyze(s.siteId, id, { 'config.php': '<?php $x = 1;' });
  assert.equal(r.status, 'pending_review');
  const client: HostingActor = { kind: 'client', userId: adminId, tenantId: 1, accounts: new Map([[accountId, new Set(['releases.publish'] as const)]]) };
  await assert.rejects(m.windowService.reject(fakeReq(adminId), client, s.siteId, id, { restoreDatabases: true }), (e: any) => e.statusCode === 403);
  const rj = await m.windowService.reject(fakeReq(adminId), admin, s.siteId, id, { reason: 'pas voulu', restoreDatabases: true });
  assert.equal(rj.status, 'rejecting');
  await settle(s.siteId);
  const done = await row(id);
  assert.equal(done.status, 'rejected', JSON.stringify(done.log));
  assert.equal(done.db_restored, true);
  assert.equal(done.decision_reason, 'pas voulu');
  assert.deepEqual(calls.restore, [[1000 + id]]);
  assert.equal((await m.db('sites').where({ id: s.siteId }).first('current_release_id')).current_release_id, s.release1.id);
  const ref = await m.runGit(['rev-parse', '-q', '--verify', `refs/oblimint/candidates/window-${id}`], { gitDir: s.repo, okCodes: [1] });
  assert.equal(ref.code, 1);
  assert.ok(await audits('window.restore_db') >= 1);
  await assert.rejects(m.windowService.reject(fakeReq(adminId), admin, s.siteId, id, {}), (e: any) => e.code === 'windowNotPending');
});

test('blocked analysis: riskBlocked, overrideForbidden for a client, staff override audited', { skip: SKIP }, async () => {
  const s = await newSite();
  analysisFor = () => ({ score: 95, blocked: true });
  const id = await openManual(s.siteId);
  const r = await closeAndAnalyze(s.siteId, id, { 'shell.php': '<?php system($_GET[1]);' });
  assert.equal(r.status, 'pending_review');
  assert.ok(calls.notify.includes('scan.threat'));
  await assert.rejects(m.windowService.validate(fakeReq(adminId), admin, s.siteId, id, {}),
    (e: any) => e.code === 'riskBlocked' && e.details.score === 95 && e.details.level === 'critical');
  const client: HostingActor = { kind: 'client', userId: adminId, tenantId: 1, accounts: new Map([[accountId, new Set(['releases.publish', 'releases.approve'] as const)]]) };
  await assert.rejects(m.windowService.validate(fakeReq(adminId), client, s.siteId, id, { override: true }), (e: any) => e.code === 'overrideForbidden' && e.statusCode === 403);
  const before = await audits('window.validate.override');
  await m.windowService.validate(fakeReq(adminId), admin, s.siteId, id, { override: true });
  await settle(s.siteId);
  const done = await row(id);
  assert.equal(done.status, 'validated', JSON.stringify(done.log));
  assert.equal(done.scan_override, true);
  assert.equal(await audits('window.validate.override'), before + 1);
  const rel = await m.db('releases').where({ id: done.result_release_id }).first();
  assert.equal(rel.scan_override_by, adminId);
  const scan = typeof rel.scan === 'string' ? JSON.parse(rel.scan) : rel.scan;
  assert.equal(scan.blocked, true);
  assert.equal(scan.override.by, 'Win Admin');
});

test('staging conflicts need force; base changed is refused', { skip: SKIP }, async () => {
  const s = await newSite();
  const id = await openManual(s.siteId);
  await closeAndAnalyze(s.siteId, id, { 'index.php': '<?php echo "window";' });
  m.writeFiles(s.staging, { 'index.php': '<?php echo "sftp";' });
  await assert.rejects(m.windowService.validate(fakeReq(adminId), admin, s.siteId, id, {}),
    (e: any) => e.code === 'stagingConflict' && e.details.paths.includes('index.php'));
  // Base changed (another release made current behind the window's back).
  const [other] = await m.db('releases').insert({
    site_id: s.siteId, number: 99, status: 'ready', trigger: 'manual', commit_sha: s.release1.commit_sha, log: '[]', on_disk: false,
  }).returning('id');
  await m.db('sites').where({ id: s.siteId }).update({ current_release_id: Number(other.id ?? other) });
  await assert.rejects(m.windowService.validate(fakeReq(adminId), admin, s.siteId, id, { force: true }), (e: any) => e.code === 'windowBaseChanged');
  await m.db('sites').where({ id: s.siteId }).update({ current_release_id: s.release1.id });
  await m.windowService.validate(fakeReq(adminId), admin, s.siteId, id, { force: true });
  await settle(s.siteId);
  assert.equal((await row(id)).status, 'validated');
  assert.equal(fs.readFileSync(`${s.staging}/index.php`, 'utf8'), '<?php echo "window";', 'force overwrites the staging');
});

test('scheduled window: auto-validation; tick opens due schedules and closes expired windows; kicks', { skip: SKIP }, async () => {
  const s = await newSite();
  await m.windowService.updateSettings(fakeReq(adminId), admin, s.siteId, {
    schedule: { enabled: true, cron: '0 3 * * 0', timezone: 'Europe/Paris', durationMinutes: 60, kickPath: '/wp-cron.php' },
  });
  const sm = await m.db('site_maintenance').where({ site_id: s.siteId }).first();
  assert.ok(sm.next_window_at, 'next occurrence computed');
  // Make it due now.
  await m.db('site_maintenance').where({ site_id: s.siteId }).update({ next_window_at: new Date(Date.now() - 1000) });
  await m.internals.tick();
  await settle(s.siteId);
  const w = await m.db('maintenance_windows').where({ site_id: s.siteId }).orderBy('id', 'desc').first();
  assert.equal(w.trigger, 'scheduled');
  assert.equal(w.status, 'open', JSON.stringify(w.log));
  assert.ok(new Date((await m.db('site_maintenance').where({ site_id: s.siteId }).first()).next_window_at).getTime() > Date.now());
  // Kick on the next tick (last_kick_at null).
  await m.internals.tick();
  assert.ok((await row(w.id)).last_kick_at);
  // Expire → closed by the tick ('schedule'), clean analysis → auto-validated.
  upper.set(w.id, { 'wp-includes/version.php': '<?php $wp_version = "6.6.3";' });
  await m.db('maintenance_windows').where({ id: w.id }).update({ expires_at: new Date(Date.now() - 1000) });
  await m.internals.tick();
  await settle(s.siteId);
  const done = await row(w.id);
  assert.equal(done.close_reason, 'schedule');
  assert.equal(done.status, 'validated', JSON.stringify(done.log));
  assert.equal(done.decision, 'auto_validated');
  assert.equal(done.decided_by, null);
  assert.ok(calls.notify.includes('window.autoValidated'));
  assert.ok(await audits('window.auto_validate') >= 1);
  // Same flow, risky → pending review (no auto-validation).
  analysisFor = () => ({ score: 40, blocked: false });
  const w2 = await m.windowService.openInternal(s.siteId, { trigger: 'scheduled', userId: null, durationMinutes: 30 });
  await settle(s.siteId);
  const r2 = await closeAndAnalyze(s.siteId, w2.id, { 'x.php': '<?php eval(base64_decode("x"));' });
  assert.equal(r2.status, 'pending_review');
  const av = typeof r2.auto_validation === 'string' ? JSON.parse(r2.auto_validation) : r2.auto_validation;
  assert.equal(av.decision, 'review');
  await m.windowService.reject(fakeReq(adminId), admin, s.siteId, w2.id, {});
  await settle(s.siteId);
});

test('pending policy revert: overlay removed at review, diff still validable', { skip: SKIP }, async () => {
  const s = await newSite();
  await m.windowService.updateSettings(fakeReq(adminId), admin, s.siteId, { pendingPolicy: 'revert' });
  const id = await openManual(s.siteId);
  const r = await closeAndAnalyze(s.siteId, id, { 'a.php': '<?php // a' });
  assert.equal(r.status, 'pending_review');
  assert.equal(r.overlay, 'unmounted');
  assert.ok(calls.remove.some((x) => x.windowId === id && x.keepExport === true));
  assert.equal(await m.windowService.blocksPublish(s.siteId), false);
  // Reanalysis works on the kept export.
  await m.windowService.reanalyze(fakeReq(adminId), admin, s.siteId, id);
  await settle(s.siteId);
  assert.equal((await row(id)).status, 'pending_review');
  await m.windowService.validate(fakeReq(adminId), admin, s.siteId, id, {});
  await settle(s.siteId);
  assert.equal((await row(id)).status, 'validated', JSON.stringify((await row(id)).log));
  assert.equal(fs.readFileSync(`${s.staging}/a.php`, 'utf8'), '<?php // a');
});

test('propagation: recreate fallback (never a plain restart) then failure; mount failure', { skip: SKIP }, async () => {
  const s = await newSite();
  visibleAfter = 1; // invisible at the first check, visible after the recreation
  const id = await openManual(s.siteId);
  assert.deepEqual(calls.recreate, [`oblimint-site-${s.siteId}`]);
  await closeAndAnalyze(s.siteId, id, {});

  verifications = 0;
  visibleAfter = 10;
  calls.recreate.length = 0;
  const w = await m.windowService.open(fakeReq(adminId), admin, s.siteId, {});
  await settle(s.siteId);
  const f = await row(w.id);
  assert.equal(f.status, 'failed');
  assert.match(f.error, /invisible/);
  assert.equal(f.overlay, 'unmounted');
  assert.ok(calls.remove.some((x) => x.windowId === w.id));
  assert.ok(calls.notify.includes('window.failed'));

  ensureFails = true;
  const w2 = await m.windowService.open(fakeReq(adminId), admin, s.siteId, {});
  await settle(s.siteId);
  const f2 = await row(w2.id);
  assert.equal(f2.status, 'failed');
  // A6: the raw hostd text is for the staff only.
  const client: HostingActor = { kind: 'client', userId: adminId, tenantId: 1, accounts: new Map([[accountId, new Set(['releases.publish'] as const)]]) };
  assert.match((await m.windowService.get(admin, s.siteId, w2.id)).error ?? '', /EBUSY/);
  assert.equal((await m.windowService.get(client, s.siteId, w2.id)).error, 'montage de la fenêtre impossible');
});

test('too large changes: validation refused (windowTooLarge)', { skip: SKIP }, async () => {
  const s = await newSite();
  const id = await openManual(s.siteId);
  const r = await closeAndAnalyze(s.siteId, id, { 'big.zip': '@@toolarge' });
  assert.equal(r.status, 'pending_review', JSON.stringify(r.log));
  await assert.rejects(m.windowService.validate(fakeReq(adminId), admin, s.siteId, id, {}), (e: any) => e.code === 'windowTooLarge');
  await m.windowService.reject(fakeReq(adminId), admin, s.siteId, id, {});
  await settle(s.siteId);
});

test('supervised mode: toggle opens the permanent window, manual open allows executables, digest, toggle off', { skip: SKIP }, async () => {
  const s = await newSite();
  await m.windowService.updateSettings(fakeReq(adminId), admin, s.siteId, { supervised: true });
  await settle(s.siteId);
  const sup = await m.db('maintenance_windows').where({ site_id: s.siteId }).orderBy('id', 'desc').first();
  assert.equal(sup.trigger, 'supervised');
  assert.equal(sup.status, 'open', JSON.stringify(sup.log));
  assert.equal(sup.expires_at, null);
  assert.ok(calls.ensure.some((e) => e.windowId === sup.id && e.quarantine === true));
  assert.ok(!calls.snapshotsCreated.includes(sup.id));
  // A manual window on a supervised site = executables allowed for a while.
  const w = await m.windowService.open(fakeReq(adminId), admin, s.siteId, { durationMinutes: 15 });
  assert.equal(w.id, sup.id);
  assert.ok(w.execAllowedUntil);
  assert.ok(calls.ensure.some((e) => e.windowId === sup.id && e.quarantine === false));
  // Allowance ends → quarantine back + digest.
  upper.set(sup.id, { 'wp-content/plugins/new/new.php': '<?php // new' });
  await m.db('maintenance_windows').where({ id: sup.id }).update({ exec_allowed_until: new Date(Date.now() - 1000) });
  await m.internals.tick();
  await settle(s.siteId);
  const after = await row(sup.id);
  assert.equal(after.status, 'open');
  assert.equal(after.exec_allowed_until, null);
  assert.ok(after.analysis, 'digest stored');
  const digest = await m.windowService.digestSupervised(s.siteId);
  assert.equal(digest?.id, sup.id);
  assert.equal(digest?.counts?.total, 1);
  // Close + validate the digest → a new supervised window on the new release.
  await m.windowService.close(fakeReq(adminId), admin, s.siteId, sup.id);
  await settle(s.siteId);
  assert.equal((await row(sup.id)).status, 'pending_review');
  await m.windowService.validate(fakeReq(adminId), admin, s.siteId, sup.id, {});
  await settle(s.siteId);
  assert.equal((await row(sup.id)).status, 'validated');
  const next = await m.db('maintenance_windows').where({ site_id: s.siteId }).orderBy('id', 'desc').first();
  assert.notEqual(next.id, sup.id);
  assert.equal(next.trigger, 'supervised');
  assert.equal(next.status, 'open');
  assert.equal(next.base_release_number, 2);
  // Toggle off: empty supervised window closed → discarded.
  upper.set(next.id, {});
  await m.windowService.updateSettings(fakeReq(adminId), admin, s.siteId, { supervised: false });
  await settle(s.siteId);
  assert.equal((await row(next.id)).status, 'discarded');
  assert.equal(await m.windowService.digestSupervised(s.siteId), null);
});

test('settings validation through the service: time zone, databases of another account', { skip: SKIP }, async () => {
  const s = await newSite();
  await assert.rejects(m.windowService.updateSettings(fakeReq(adminId), admin, s.siteId, {
    schedule: { enabled: true, cron: '0 3 * * 0', timezone: 'Mars/Base', durationMinutes: 60, kickPath: null },
  }), (e: any) => e.code === 'invalidSchedule' && e.statusCode === 400);
  await assert.rejects(m.windowService.updateSettings(fakeReq(adminId), admin, s.siteId, { snapshot: { mode: 'selected', databaseIds: [987654] } }),
    (e: any) => e.statusCode === 400);
  const info = await m.windowService.updateSettings(fakeReq(adminId), admin, s.siteId, { autoValidate: 'off', defaultDurationMinutes: 45 });
  assert.equal(info.settings.autoValidate, 'off');
  assert.equal(info.settings.defaultDurationMinutes, 45);
  assert.equal(info.canOpen, true);
  assert.ok(await audits('site.maintenance') >= 1);
  const w = await m.windowService.open(fakeReq(adminId), admin, s.siteId, {});
  await settle(s.siteId);
  const r = await row(w.id);
  assert.equal(Math.round((new Date(r.expires_at).getTime() - new Date(r.opened_at).getTime()) / 60000), 45, 'site default duration');
  await closeAndAnalyze(s.siteId, w.id, {});
  const list = await m.windowService.list(admin, s.siteId, { limit: 10, offset: 0, status: 'discarded' });
  assert.equal(list.total, 1);
  const all = await m.windowService.listAll(admin, { status: 'discarded', accountId, limit: 100, offset: 0 });
  assert.ok(all.items.some((i) => i.id === w.id && i.siteSlug === s.slug));
  const outsider: HostingActor = { kind: 'client', userId: adminId, tenantId: 1, accounts: new Map() };
  assert.equal((await m.windowService.listAll(outsider, { limit: 100, offset: 0 })).total, 0);
  await assert.rejects(m.windowService.get(outsider, s.siteId, w.id), (e: any) => e.statusCode === 404);
});

test('site API tokens: create (shown once), limit, unique name, verify, expiry, revoke', { skip: SKIP }, async () => {
  const s = await newSite();
  const t = await m.siteTokenService.create(fakeReq(adminId), admin, s.siteId, { name: 'ci' });
  assert.match(t.token, /^obt_\d+_[A-Za-z0-9_-]{43}$/);
  const stored = await m.db('site_api_tokens').where({ id: t.id }).first();
  assert.notEqual(stored.token_hash, t.token);
  // The secret (base64url) may itself contain '_': take everything after 'obt_<id>_' (the stored prefix is only its first characters).
  const secret = t.token.slice(t.token.indexOf('_', 4) + 1);
  assert.equal(secret.length, 43);
  assert.ok(!JSON.stringify(stored).includes(secret), 'the secret is never stored');
  const ident = await m.siteTokenService.verify(t.token);
  assert.deepEqual(ident, { tokenId: t.id, siteId: s.siteId, accountId, tenantId: 1, name: 'ci' });
  assert.equal(await m.siteTokenService.verify(t.token.slice(0, -1) + (t.token.endsWith('A') ? 'B' : 'A')), null);
  await assert.rejects(m.siteTokenService.create(fakeReq(adminId), admin, s.siteId, { name: 'ci' }), (e: any) => e.code === 'tokenNameTaken');
  await assert.rejects(m.siteTokenService.create(fakeReq(adminId), admin, s.siteId, { name: 'soon', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    (e: any) => e.statusCode === 400);
  for (let i = 0; i < 9; i++) await m.siteTokenService.create(fakeReq(adminId), admin, s.siteId, { name: `t${i}` });
  await assert.rejects(m.siteTokenService.create(fakeReq(adminId), admin, s.siteId, { name: 'eleventh' }), (e: any) => e.code === 'tokenLimit');
  assert.equal((await m.siteTokenService.list(admin, s.siteId)).length, 10);
  assert.ok((await m.siteTokenService.list(admin, s.siteId)).every((x) => !('token' in x)));
  // Expired token → refused.
  await m.db('site_api_tokens').where({ id: t.id }).update({ expires_at: new Date(Date.now() - 1000) });
  assert.equal(await m.siteTokenService.verify(t.token), null);
  await m.db('site_api_tokens').where({ id: t.id }).update({ expires_at: null });
  // API window through the internal methods (trigger api, token named in the audit).
  const w = await m.windowService.openInternal(s.siteId, { trigger: 'api', userId: null, tokenId: t.id, tokenName: 'ci', durationMinutes: 20 });
  await settle(s.siteId);
  const r = await row(w.id);
  assert.equal(r.trigger, 'api');
  assert.equal(r.token_name, 'ci');
  const a = await m.db('audit_logs').where({ action: 'window.open' }).orderBy('id', 'desc').first();
  const details = typeof a.details === 'string' ? JSON.parse(a.details) : a.details;
  assert.equal(details.token, 'ci');
  await m.windowService.closeInternal(s.siteId, w.id, 'api');
  await settle(s.siteId);
  assert.equal((await row(w.id)).close_reason, 'api');
  await m.siteTokenService.remove(fakeReq(adminId), admin, s.siteId, t.id);
  assert.equal(await m.siteTokenService.verify(t.token), null);
  await assert.rejects(m.siteTokenService.remove(fakeReq(adminId), admin, s.siteId, t.id), (e: any) => e.statusCode === 404);
});

test('release approve: blocked scan needs an override (recorded); suspicious just waits', { skip: SKIP }, async () => {
  const s = await newSite();
  m.setScanner({ name: 'fake', scan: async () => ({ scanner: 'fake', verdict: 'infected', findings: [{ path: 'x.php', rule: 'clamav:X', severity: 'critical', message: 'bad' }], risk: { score: 100, level: 'critical' } }) });
  m.writeFiles(s.staging, { 'x.php': '<?php bad' });
  const r = await m.releaseService.publish(s.siteId, { trigger: 'manual', userId: adminId });
  await settleReleases(s.siteId);
  const blocked = await m.db('releases').where({ id: r.id }).first();
  assert.equal(blocked.status, 'awaiting_approval', 'blocked waits, no longer failed');
  assert.equal((typeof blocked.scan === 'string' ? JSON.parse(blocked.scan) : blocked.scan).blocked, true);
  await assert.rejects(m.releaseService.approve(s.siteId, r.id, adminId), (e: any) => e.code === 'riskBlocked' && e.details.score === 100);
  const ok = await m.releaseService.approve(s.siteId, r.id, adminId, { override: { reason: 'faux positif' } });
  assert.equal(ok.status, 'publishing');
  await settleReleases(s.siteId);
  const done = await m.db('releases').where({ id: r.id }).first();
  assert.equal(done.status, 'ready', JSON.stringify(done.log));
  assert.equal(done.scan_override_by, adminId);
  const scan = typeof done.scan === 'string' ? JSON.parse(done.scan) : done.scan;
  assert.equal(scan.override.reason, 'faux positif');
  // While a window holds the site, approve is refused too.
  m.setScanner({ name: 'fake', scan: async () => ({ scanner: 'fake', verdict: 'suspicious', findings: [] }) });
  m.writeFiles(s.staging, { 'y.php': '<?php y' });
  const r2 = await m.releaseService.publish(s.siteId, { trigger: 'manual', userId: adminId });
  await settleReleases(s.siteId);
  const id = await openManual(s.siteId);
  await assert.rejects(m.releaseService.approve(s.siteId, r2.id, adminId), (e: any) => e.code === 'windowActive');
  await closeAndAnalyze(s.siteId, id, {});
  const ap = await m.releaseService.approve(s.siteId, r2.id, adminId);
  assert.equal(ap.status, 'publishing');
  await settleReleases(s.siteId);
});

test('boot recovery: opening → failed, open unmounted → remounted rw, pending_review ro remount, orphan overlay unmounted, never rw outside open', { skip: SKIP }, async () => {
  const s = await newSite();
  // An open window whose overlay disappeared (host rebooted).
  const id = await openManual(s.siteId);
  mounts.clear();
  calls.ensure.length = 0;
  await m.internals.recover();
  await settle(s.siteId);
  assert.deepEqual(calls.ensure.map((e) => [e.windowId, e.mode]), [[id, 'rw']]);
  assert.equal((await row(id)).status, 'open');
  // pending_review + ro: remounted ro; a rw mount found outside 'open' is frozen.
  await closeAndAnalyze(s.siteId, id, { 'a.php': '<?php a' });
  assert.equal((await row(id)).status, 'pending_review');
  mounts.clear();
  calls.ensure.length = 0;
  await m.internals.recover();
  assert.deepEqual(calls.ensure.map((e) => [e.windowId, e.mode]), [[id, 'ro']]);
  mounts.set(id, { mode: 'rw', accountId, siteId: s.siteId, releaseNumber: 1, quarantine: false });
  calls.ensure.length = 0;
  await m.internals.recover();
  assert.deepEqual(calls.ensure.map((e) => [e.windowId, e.mode]), [[id, 'ro']], 'M2: never rw outside open');
  // Orphan overlay (no non-final row) → unmounted.
  await m.windowService.reject(fakeReq(adminId), admin, s.siteId, id, {});
  await settle(s.siteId);
  mounts.set(id, { mode: 'ro', accountId, siteId: s.siteId, releaseNumber: 1, quarantine: false });
  calls.remove.length = 0;
  await m.internals.recover();
  assert.deepEqual(calls.remove.map((r) => r.windowId), [id]);
  // 'opening' interrupted → failed; 'validating' with its release ready → finished.
  const [op] = await m.db('maintenance_windows').insert({
    tenant_id: 1, account_id: accountId, site_id: s.siteId, number: 50, trigger: 'manual', status: 'opening', overlay: 'none',
    base_release_id: s.release1.id, base_release_number: 1, base_commit: s.release1.commit_sha,
  }).returning('id');
  const opId = Number(op.id ?? op);
  await m.internals.recover();
  await settle(s.siteId);
  assert.equal((await row(opId)).status, 'failed');
});

test('validation settlement: a window release left awaiting approval is dismissed, never approvable; sweep settles stuck validations', { skip: SKIP }, async () => {
  const s = await newSite();
  const id = await openManual(s.siteId);
  const r = await closeAndAnalyze(s.siteId, id, { 'a.php': '<?php a' });
  assert.equal(r.status, 'pending_review');
  // A 'validating' window whose release ended awaiting approval (no finishValidation in this process).
  await m.db('maintenance_windows').where({ id }).update({ status: 'validating', decided_by: adminId });
  const [rel] = await m.db('releases').insert({
    site_id: s.siteId, number: 90, status: 'awaiting_approval', trigger: 'window', window_id: id, commit_sha: r.candidate_commit, log: '[]', on_disk: false,
  }).returning('id');
  const relId = Number(rel.id ?? rel);
  await m.internals.tick();
  await settle(s.siteId);
  const w = await row(id);
  assert.equal(w.status, 'pending_review', JSON.stringify(w.log));
  assert.equal(w.decided_by, null);
  assert.equal((await m.db('releases').where({ id: relId }).first()).status, 'rejected');
  // Even left awaiting approval, a window release is never approved on its own once the window is not validating.
  await m.db('releases').where({ id: relId }).update({ status: 'awaiting_approval' });
  await m.windowService.reject(fakeReq(adminId), admin, s.siteId, id, {});
  await settle(s.siteId);
  assert.equal((await row(id)).status, 'rejected');
  await assert.rejects(m.releaseService.approve(s.siteId, relId, adminId), (e: any) => e.code === 'releaseNotAwaitingApproval');
  await m.db('releases').where({ id: relId }).update({ status: 'rejected' });
});

test('auto-validation needs a clean verdict; an infected verdict blocks even when summary.blocked is false', { skip: SKIP }, async () => {
  const s = await newSite();
  // Infected without the blocked flag: blocked on the window, validation refused without override.
  analysisFor = () => ({ score: 5, blocked: false });
  const id = await openManual(s.siteId);
  upper.set(id, { 'evil.php': '<?php evil' });
  const realAnalyze = (await import('./deps')).windowDeps().analyze;
  m.setWindowDeps({
    analyze: async (input) => {
      const a = await realAnalyze(input);
      return { ...a, summary: { ...a.summary, verdict: 'infected', blocked: false }, scan: { ...a.scan, verdict: 'infected', blocked: false } };
    },
  });
  try {
    await m.windowService.close(fakeReq(adminId), admin, s.siteId, id);
    await settle(s.siteId);
  } finally {
    m.setWindowDeps({ analyze: realAnalyze });
  }
  const r = await row(id);
  assert.equal(r.status, 'pending_review');
  const an = typeof r.analysis === 'string' ? JSON.parse(r.analysis) : r.analysis;
  assert.equal(an.blocked, true);
  assert.equal(an.scan.blocked, true);
  await assert.rejects(m.windowService.validate(fakeReq(adminId), admin, s.siteId, id, {}), (e: any) => e.code === 'riskBlocked');
  await m.windowService.reject(fakeReq(adminId), admin, s.siteId, id, {});
  await settle(s.siteId);
});

test('final window with its overlay still mounted: frozen ro, unmount retried by the worker, no new window meanwhile', { skip: SKIP }, async () => {
  const s = await newSite();
  // Propagation never visible → failWindow, and the unmount fails.
  visibleAfter = 99;
  removeFails = true;
  const w = await m.windowService.open(fakeReq(adminId), admin, s.siteId, { durationMinutes: 30 });
  await settle(s.siteId);
  let r = await row(w.id);
  assert.equal(r.status, 'failed');
  assert.equal(r.overlay, 'ro', 'M2: never a writable overlay on a final window');
  assert.equal(mounts.get(w.id)?.mode, 'ro');
  await assert.rejects(m.windowService.open(fakeReq(adminId), admin, s.siteId, {}), (e: any) => e.code === 'windowActive');
  // hostd back: the tick removes it.
  removeFails = false;
  visibleAfter = 0;
  await m.internals.tick();
  await settle(s.siteId);
  r = await row(w.id);
  assert.equal(r.overlay, 'unmounted', JSON.stringify(r.log));
  assert.equal(mounts.has(w.id), false);
  const id = await openManual(s.siteId);
  await closeAndAnalyze(s.siteId, id, {});
});

test('supervised site whose window fails in the background is not reopened on every tick', { skip: SKIP }, async () => {
  const s = await newSite();
  visibleAfter = 99; // every supervised opening fails (propagation)
  await m.windowService.updateSettings(fakeReq(adminId), admin, s.siteId, { supervised: true });
  await settle(s.siteId);
  const count = async () => Number((await m.db('maintenance_windows').where({ site_id: s.siteId }).count<{ n: string }[]>('* as n'))[0].n);
  assert.equal(await count(), 1);
  assert.equal((await m.db('maintenance_windows').where({ site_id: s.siteId }).first()).status, 'failed');
  await m.internals.tick();
  await settle(s.siteId);
  await m.internals.tick();
  await settle(s.siteId);
  assert.equal(await count(), 1, 'persisted back-off after a failed supervised window');
  // Back-off elapsed (failure 1 h ago): retried once.
  await m.db('maintenance_windows').where({ site_id: s.siteId }).update({ updated_at: new Date(Date.now() - 3_600_000) });
  await m.internals.tick();
  await settle(s.siteId);
  assert.equal(await count(), 2);
  // After SUPERVISED_MAX_FAILURES consecutive failures: no automatic reopening.
  const { SUPERVISED_MAX_FAILURES } = await import('./window.service');
  for (let i = 0; i < 10; i++) {
    await m.db('maintenance_windows').where({ site_id: s.siteId }).update({ updated_at: new Date(Date.now() - 24 * 3_600_000) });
    await m.internals.tick();
    await settle(s.siteId);
  }
  assert.equal(await count(), SUPERVISED_MAX_FAILURES);
  visibleAfter = 0;
  await m.db('site_maintenance').where({ site_id: s.siteId }).update({ settings: JSON.stringify({ supervised: false }) });
});

test('boot recovery of a rejecting window redoes the requested database restore', { skip: SKIP }, async () => {
  const s = await newSite();
  const id = await openManual(s.siteId);
  await closeAndAnalyze(s.siteId, id, { 'b.php': '<?php b' });
  await m.db('maintenance_windows').where({ id }).update({
    status: 'rejecting', decided_by: adminId,
    log: JSON.stringify([{ at: new Date().toISOString(), level: 'info', message: 'rejet par l’utilisateur #1 (restauration des bases demandée)' }]),
  });
  calls.restore.length = 0;
  await m.internals.recover();
  await settle(s.siteId);
  const r = await row(id);
  assert.equal(r.status, 'rejected');
  assert.equal(r.db_restored, true);
  assert.deepEqual(calls.restore, [[1000 + id]]);
});

// ── fixes of the P3 review ───────────────────────────────────────────────────

test('freeze: a container keeping a private writable copy is recreated; still writable ⇒ failed (M2)', { skip: SKIP }, async () => {
  const s = await newSite();
  const id = await openManual(s.siteId);
  privateRwCopy = true; // e.g. restarted with the pre-rslave spec during the window
  const r = await closeAndAnalyze(s.siteId, id, { 'a.php': '<?php a' });
  assert.equal(r.status, 'pending_review', JSON.stringify(r.log));
  assert.deepEqual(calls.recreate, [`oblimint-site-${s.siteId}`], 'recreated, never restarted');
  await m.windowService.reject(fakeReq(adminId), admin, s.siteId, id, {});
  await settle(s.siteId);

  const id2 = await openManual(s.siteId);
  privateRwCopy = true;
  recreateFixes = false;
  calls.recreate.length = 0;
  const f = await closeAndAnalyze(s.siteId, id2, { 'b.php': '<?php b' });
  assert.equal(f.status, 'failed', JSON.stringify(f.log));
  assert.match(f.error, /M2/);
  assert.equal(calls.recreate.length, 1);
});

test('freeze failure keeps the layer: window stays closing, the worker retries, nothing removed', { skip: SKIP }, async () => {
  const s = await newSite();
  const id = await openManual(s.siteId);
  ensureFailsMode = 'ro';
  const r = await closeAndAnalyze(s.siteId, id, { 'keep.php': '<?php // two hours of work' });
  assert.equal(r.status, 'closing', JSON.stringify(r.log));
  assert.equal(r.overlay, 'rw');
  assert.equal(calls.remove.length, 0, 'upper/ never removed on a transient freeze failure');
  assert.equal(await m.windowService.blocksPublish(s.siteId), true);
  // hostd back: the tick (after CLOSE_RETRY_MS) freezes and analyses.
  ensureFailsMode = null;
  await m.db('maintenance_windows').where({ id }).update({ updated_at: new Date(Date.now() - 120_000) });
  await m.internals.tick();
  await settle(s.siteId);
  const done = await row(id);
  assert.equal(done.status, 'pending_review', JSON.stringify(done.log));
  assert.equal(done.overlay, 'ro');
  // Still failing after CLOSE_GIVE_UP_MS: failed (M2: no writable overlay on a final window).
  await m.windowService.reject(fakeReq(adminId), admin, s.siteId, id, {});
  await settle(s.siteId);
  const id2 = await openManual(s.siteId);
  ensureFailsMode = 'ro';
  await closeAndAnalyze(s.siteId, id2, { 'x.php': '<?php x' });
  await m.db('maintenance_windows').where({ id: id2 }).update({ closed_at: new Date(Date.now() - 3_600_000), updated_at: new Date(Date.now() - 120_000) });
  await m.internals.tick();
  await settle(s.siteId);
  assert.equal((await row(id2)).status, 'failed');
});

test('export failure keeps the frozen layer: pending_review without analysis, reanalysis succeeds', { skip: SKIP }, async () => {
  const s = await newSite();
  const id = await openManual(s.siteId);
  exportFails = true;
  const r = await closeAndAnalyze(s.siteId, id, { 'work.php': '<?php // work' });
  assert.equal(r.status, 'pending_review', JSON.stringify(r.log));
  assert.equal(r.overlay, 'ro');
  assert.equal(r.analysis, null);
  assert.match(r.error, /export/);
  assert.equal(calls.remove.length, 0, 'the layer is kept');
  assert.ok(calls.notify.includes('window.failed'));
  await assert.rejects(m.windowService.validate(fakeReq(adminId), admin, s.siteId, id, {}), (e: any) => e.code === 'windowNotAnalyzed');
  exportFails = false;
  await m.windowService.reanalyze(fakeReq(adminId), admin, s.siteId, id);
  await settle(s.siteId);
  const again = await row(id);
  assert.equal(again.status, 'pending_review');
  assert.ok(again.analysis && again.candidate_commit);
  await m.windowService.validate(fakeReq(adminId), admin, s.siteId, id, {});
  await settle(s.siteId);
  assert.equal((await row(id)).status, 'validated');
});

test('supervised site: an API token or a schedule never switches the quarantine off', { skip: SKIP }, async () => {
  const s = await newSite();
  await m.windowService.updateSettings(fakeReq(adminId), admin, s.siteId, { supervised: true });
  await settle(s.siteId);
  const sup = await m.db('maintenance_windows').where({ site_id: s.siteId }).orderBy('id', 'desc').first();
  assert.equal(sup.status, 'open');
  calls.ensure.length = 0;
  await assert.rejects(m.windowService.openInternal(s.siteId, { trigger: 'api', userId: null, tokenName: 'ci', durationMinutes: 60 }),
    (e: any) => e.code === 'tokenScope' && e.statusCode === 403);
  await assert.rejects(m.windowService.openInternal(s.siteId, { trigger: 'scheduled', userId: null, durationMinutes: 60 }),
    (e: any) => e.code === 'windowActive');
  assert.equal(calls.ensure.length, 0, 'never remounted without quarantine');
  assert.equal((await row(sup.id)).exec_allowed_until, null);
  upper.set(sup.id, {});
  await m.windowService.updateSettings(fakeReq(adminId), admin, s.siteId, { supervised: false });
  await settle(s.siteId);
});

test('publication rights: tokens, schedule / auto-validation / supervised settings need releases.publish; tokens die with their creator', { skip: SKIP }, async () => {
  const s = await newSite();
  const mk = async (name: string, caps: string[]) => {
    const [u] = await m.db('users').insert({
      username: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, kind: 'client', role: 'user', is_active: true,
    }).returning('id');
    const id = Number(u.id ?? u);
    await m.db('account_users').insert({ user_id: id, account_id: accountId, capabilities: JSON.stringify(caps) });
    const actor = { kind: 'client', userId: id, tenantId: 1, accounts: new Map([[accountId, new Set(caps)]]) } as unknown as HostingActor;
    return { id, actor };
  };
  const manager = await mk('mgr', ['sites.manage']);
  const both = await mk('both', ['sites.manage', 'releases.publish']);
  await assert.rejects(m.siteTokenService.create(fakeReq(manager.id), manager.actor, s.siteId, { name: 'x' }), (e: any) => e.statusCode === 403);
  await assert.rejects(m.siteTokenService.list(manager.actor, s.siteId), (e: any) => e.statusCode === 403);
  await assert.rejects(m.windowService.updateSettings(fakeReq(manager.id), manager.actor, s.siteId, { autoValidate: 'scheduled-api' }),
    (e: any) => e.statusCode === 403);
  await assert.rejects(m.windowService.updateSettings(fakeReq(manager.id), manager.actor, s.siteId, { supervised: true }), (e: any) => e.statusCode === 403);
  await assert.rejects(m.windowService.updateSettings(fakeReq(manager.id), manager.actor, s.siteId, {
    schedule: { enabled: true, cron: '0 3 * * 0', timezone: 'Europe/Paris', durationMinutes: 60, kickPath: null },
  }), (e: any) => e.statusCode === 403);
  // Harmless settings stay sites.manage.
  await m.windowService.updateSettings(fakeReq(manager.id), manager.actor, s.siteId, { pendingPolicy: 'keep', digestIntervalHours: 12 });

  const t = await m.siteTokenService.create(fakeReq(both.id), both.actor, s.siteId, { name: 'ci' });
  assert.ok(await m.siteTokenService.verify(t.token));
  // Creator stripped of releases.publish → the token stops working; capability back → works again.
  await m.db('account_users').where({ user_id: both.id, account_id: accountId }).update({ capabilities: JSON.stringify(['sites.manage']) });
  assert.equal(await m.siteTokenService.verify(t.token), null);
  await m.db('account_users').where({ user_id: both.id, account_id: accountId }).update({ capabilities: JSON.stringify(['sites.manage', 'releases.publish']) });
  assert.ok(await m.siteTokenService.verify(t.token));
  // Detached from the account / deleted (created_by SET NULL) → dead.
  await m.db('account_users').where({ user_id: both.id, account_id: accountId }).del();
  assert.equal(await m.siteTokenService.verify(t.token), null);
  await m.db('account_users').insert({ user_id: both.id, account_id: accountId, capabilities: JSON.stringify(['sites.manage', 'releases.publish']) });
  await m.db('site_api_tokens').where({ id: t.id }).update({ created_by: null });
  assert.equal(await m.siteTokenService.verify(t.token), null);

  // A schedule fires only while its guarantor (last publisher who saved the settings) may still publish.
  await m.windowService.updateSettings(fakeReq(both.id), both.actor, s.siteId, {
    schedule: { enabled: true, cron: '0 3 * * 0', timezone: 'Europe/Paris', durationMinutes: 60, kickPath: null },
  });
  // A later harmless change by a non-publisher keeps the guarantor.
  await m.windowService.updateSettings(fakeReq(manager.id), manager.actor, s.siteId, { digestIntervalHours: 24 });
  assert.equal((await m.db('site_maintenance').where({ site_id: s.siteId }).first('updated_by')).updated_by, both.id);
  await m.db('account_users').where({ user_id: both.id, account_id: accountId }).update({ capabilities: JSON.stringify(['sites.manage']) });
  await m.db('site_maintenance').where({ site_id: s.siteId }).update({ next_window_at: new Date(Date.now() - 1000) });
  await m.internals.tick();
  await settle(s.siteId);
  assert.equal(await m.db('maintenance_windows').where({ site_id: s.siteId }).first('id'), undefined, 'no scheduled window opened');
  await m.db('site_maintenance').where({ site_id: s.siteId }).update({ settings: JSON.stringify({}), next_window_at: null });
});

test('window files removed on decision (revert policy) and after the retention of a failed window', { skip: SKIP }, async () => {
  const s = await newSite();
  await m.windowService.updateSettings(fakeReq(adminId), admin, s.siteId, { pendingPolicy: 'revert' });
  const id = await openManual(s.siteId);
  const r = await closeAndAnalyze(s.siteId, id, { 'a.php': '<?php // a' });
  assert.equal(r.overlay, 'unmounted');
  calls.remove.length = 0;
  await m.windowService.reject(fakeReq(adminId), admin, s.siteId, id, {});
  await settle(s.siteId);
  assert.equal((await row(id)).status, 'rejected');
  assert.deepEqual(calls.remove, [{ windowId: id, keepExport: false }], 'export of a reverted window removed');
  assert.equal(fs.existsSync(m.localPaths.window(accountId, s.siteId, id)), false);

  // Failed window: export kept for the staff, removed after the retention.
  visibleAfter = 99;
  const w = await m.windowService.open(fakeReq(adminId), admin, s.siteId, {});
  await settle(s.siteId);
  assert.equal((await row(w.id)).status, 'failed');
  fs.mkdirSync(m.localPaths.windowExport(accountId, s.siteId, w.id), { recursive: true });
  calls.remove.length = 0;
  await m.internals.tick();
  assert.equal(calls.remove.length, 0, 'kept during the retention');
  await m.db('maintenance_windows').where({ id: w.id }).update({ updated_at: new Date(Date.now() - 8 * 24 * 3_600_000) });
  await m.internals.tick();
  assert.deepEqual(calls.remove, [{ windowId: w.id, keepExport: false }]);
  assert.equal(fs.existsSync(m.localPaths.window(accountId, s.siteId, w.id)), false);
});

test('pipeline guard: the overlay of a final window still mounted blocks publications', { skip: SKIP }, async () => {
  const s = await newSite();
  visibleAfter = 99;
  removeFails = true;
  const w = await m.windowService.open(fakeReq(adminId), admin, s.siteId, {});
  await settle(s.siteId);
  assert.equal((await row(w.id)).status, 'failed');
  assert.equal(await m.windowService.blocksPublish(s.siteId), true, 'stale overlay over releases/<n>');
  m.writeFiles(s.staging, { 'new.txt': 'n' });
  await assert.rejects(m.releaseService.publish(s.siteId, { trigger: 'manual', userId: adminId }), (e: any) => e.code === 'windowActive');
  removeFails = false;
  visibleAfter = 0;
  await m.internals.tick();
  await settle(s.siteId);
  assert.equal(await m.windowService.blocksPublish(s.siteId), false);
});
