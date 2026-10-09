import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Docker from 'dockerode';
import type { AdapterRunStatus, ChangeAnalysisSummary, DbSnapshot, Release, ReleaseStatus } from '@oblimint/shared';
import type { CandidateCommit, ChangeAnalysis } from '../maintenance/contracts';
import type { AdapterDeps, AuditEntry } from './deps';
import { AppError } from '../../middleware/errorHandler';
import { continueApprovedRun, executeRun, MAX_RELEASE_WAIT_ROUNDS, type RunJob } from './runMachine';

// ─────────────────────────────────────────────────────────────────────────────
// The run state machine (docs/P3-PLAN.md §11) end to end with fakes: the
// WordPress adapter for real (argv, parsers), every other module faked
// (hostd workspace = a temp dir, tools container = scripted CLI answers
// that also write into the workspace, commit / scan / publish / snapshots).
// Scenarios: check, update success, no_changes, blocked, awaiting_approval,
// failure before publication, failure in post_deploy ⇒ rolled_back with the
// snapshot restore, healthcheck failure ⇒ rolled_back, snapshot failure.
// ─────────────────────────────────────────────────────────────────────────────

const CORE_CHECK = '[{"version":"6.5.5","update_type":"minor","package_url":"x"}]';
const PLUGINS = '[{"name":"akismet","title":"Akismet","version":"5.3.2","update_version":"5.3.3"}]';

interface Scenario {
  coreCheck?: string;
  plugins?: string;
  /** Files the "CLI" writes in the workspace during the update commands. */
  writes?: Record<string, string>;
  updateFails?: boolean;
  blocked?: boolean;
  releaseStatus?: ReleaseStatus;
  updateDbFails?: boolean;
  healthcheck?: string | null;
  snapshot?: 'ready' | 'failed' | 'none';
  publishThrows?: { code: string; statusCode: number };
  adapter?: 'wordpress' | 'nextcloud' | 'composer';
  options?: Record<string, unknown>;
  /** sites.current_release_id seen by the machine (default: the run's release, 77). */
  currentRelease?: number | null;
  ensureFails?: boolean;
}

function setup(t: TestContext, sc: Scenario, action: 'check' | 'update' = 'update') {
  const root = fs.mkdtempSync(path.join(process.env.OBLIMINT_TEST_TMP || os.tmpdir(), 'oblimint-adapter-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, 'tree');
  const calls: string[] = [];
  const statuses: AdapterRunStatus[] = [];
  const saved: Array<Record<string, unknown>> = [];
  const audits: AuditEntry[] = [];
  const notes: string[] = [];
  const argvs: Array<{ argv: string[]; ro: boolean; name: string }> = [];
  const written: string[] = [];
  let waits = 0;

  const release = (status: ReleaseStatus): Release => ({ id: 77, number: 5, status, error: status === 'failed' ? 'healthcheck en échec : HTTP 500' : null } as unknown as Release);
  const snaps: DbSnapshot[] = sc.snapshot === 'none' ? [] : [{
    id: 501, siteId: 12, accountId: 7, instanceId: 3, databaseId: 9, databaseName: 'wp', engine: 'mariadb', reason: 'adapter', windowId: null,
    adapterRunId: 42, status: sc.snapshot === 'failed' ? 'failed' : 'ready', sizeBytes: 10, error: null, createdAt: '', expiresAt: null, restoredAt: null,
  }];
  const summary = (blocked: boolean): ChangeAnalysisSummary => ({
    engines: ['heuristic'], verdict: blocked ? 'infected' : 'clean', risk: { score: blocked ? 95 : 0, level: blocked ? 'critical' : 'none' },
    counts: { added: 0, modified: written.length, deleted: 0, total: written.length, executable: written.length, ignored: 0, bytes: 10 },
    findings: blocked ? 1 : 0, criticalFindings: blocked ? 1 : 0, scannerUnavailable: false, skipped: 0, blocked, analyzedAt: new Date().toISOString(),
  });

  const deps: AdapterDeps = {
    ensureWorkspace: async (_n, spec) => {
      calls.push(`ensureWorkspace ${spec.workspaceId} #${spec.releaseNumber}`);
      if (sc.ensureFails) throw new Error('ENOSPC: no space left on device');
      fs.mkdirSync(path.join(ws, 'wp-includes'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'occ'), '<?php');
      fs.writeFileSync(path.join(ws, 'version.php'), "<?php $OC_VersionString = '28.0.4';");
      fs.writeFileSync(path.join(ws, 'composer.json'), '{"name":"acme/app"}');
      fs.writeFileSync(path.join(ws, 'wp-includes/version.php'), "<?php\n$wp_version = '6.5.3';\n");
      return { files: 1, bytes: 30 };
    },
    removeWorkspace: async (_n, spec) => { calls.push(`removeWorkspace ${spec.workspaceId}`); },
    commitWorkTree: async (input) => {
      calls.push(`commit ${input.refName} ${input.author.name}`);
      assert.equal(input.workTree, ws);
      const c: CandidateCommit = {
        commit: 'c0ffee'.padEnd(40, '0'), baseCommit: input.baseCommit, refName: input.refName,
        files: written.map((p) => ({ path: p, change: 'modified' as const })), added: 0, modified: written.length, deleted: 0, ignored: [],
      };
      return c;
    },
    reflectToStaging: async (_s, source, changes) => { calls.push(`reflect ${JSON.stringify(source)} ${changes.map((c) => c.path).join(',')}`); return { written: changes.length, deleted: 0, conflicts: [] }; },
    deleteCandidateRef: async (_s, ref) => { calls.push(`deleteRef ${ref}`); },
    publishCommit: async (_s, opts) => {
      calls.push(`publish ${opts.trigger} run=${opts.adapterRunId} base=${opts.baseReleaseId} scan=${opts.scan?.scanner}`);
      if (sc.publishThrows) throw new AppError(sc.publishThrows.statusCode, 'busy', sc.publishThrows.code);
      return release('queued');
    },
    waitForRelease: async () => { waits++; return release(sc.releaseStatus ?? 'ready'); },
    revertTo: async (_s, id, reason) => { calls.push(`revert ${id} ${reason}`); },
    healthcheck: async () => sc.healthcheck ?? null,
    blocksPublish: async () => false,
    currentReleaseId: async () => (sc.currentRelease === undefined ? 77 : sc.currentRelease),
    listRunSnapshots: async () => snaps,
    analyze: async (input) => {
      calls.push(`analyze ${input.origin} ${input.files.map((f) => `${f.path}:${f.type}:${f.size}`).join(',')}`);
      return { summary: summary(!!sc.blocked), files: [], scan: { scanner: 'fake', verdict: 'clean', findings: [] } } as ChangeAnalysis;
    },
    verifyChecksums: async () => { throw new Error('checksums offline'); },
    createSnapshots: async (_s, ref) => { calls.push(`snapshots ${ref.reason} ${ref.adapterRunId}`); return snaps; },
    restoreSnapshots: async (ids) => { calls.push(`restore ${ids.join(',')}`); return { restored: ids.length, failed: [] }; },
    releaseSnapshots: async (ref) => { calls.push(`releaseSnapshots ${ref.adapterRunId}`); },
    docker: async () => ({}) as Docker,
    runTools: async (_n, spec) => {
      const argv = spec.Cmd as string[];
      const ro = spec.HostConfig!.Mounts![0].ReadOnly === true;
      argvs.push({ argv, ro, name: spec.name! });
      const cmd = argv.slice(1, 3).join(' ');
      let stdout = '';
      let ok = true;
      const writeAll = () => {
        for (const [rel, content] of Object.entries(sc.writes ?? {})) {
          fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
          fs.writeFileSync(path.join(ws, rel), content);
          if (!written.includes(rel)) written.push(rel);
        }
      };
      if (argv[0] === 'php' && argv[1].endsWith('/occ')) {
        // Nextcloud: occ <args…>
        const occ = argv.slice(2, 4).join(' ');
        if (occ === 'app:update --showonly') stdout = 'calendar new version available: 4.7.15';
        else if (occ === 'app:update --all') { if (sc.updateFails) ok = false; else writeAll(); }
        else if (occ.startsWith('upgrade')) ok = !sc.updateDbFails;
        return { ok, exitCode: ok ? 0 : 1, output: stdout, outputTruncated: false, timedOut: false, stdout, stderr: '' };
      }
      if (argv[0] === 'composer') {
        if (argv[1] === 'outdated') stdout = '{"installed":[]}';
        else if (argv[1] === 'install') writeAll();
        return { ok, exitCode: 0, output: stdout, outputTruncated: false, timedOut: false, stdout, stderr: '' };
      }
      if (cmd === 'core check-update') stdout = sc.coreCheck ?? CORE_CHECK;
      else if (cmd === 'plugin list') stdout = sc.plugins ?? PLUGINS;
      else if (cmd === 'theme list' || cmd === 'language core') stdout = '[]';
      else if (cmd === 'core update-db') ok = !sc.updateDbFails;
      else if (argv[2] === 'update') {
        if (sc.updateFails) ok = false;
        for (const [rel, content] of Object.entries(sc.writes ?? {})) {
          fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
          fs.writeFileSync(path.join(ws, rel), content);
          if (!written.includes(rel)) written.push(rel);
        }
        stdout = ok ? 'Success: Updated.' : 'Error: Download failed.';
      }
      return { ok, exitCode: ok ? 0 : 1, output: stdout, outputTruncated: false, timedOut: false, stdout, stderr: '' };
    },
    removeRunContainers: async (_n, runId) => { calls.push(`removeContainers ${runId}`); },
    saveRun: async (_id, patch) => { saved.push(patch); },
    emitRun: (_scope, p) => { statuses.push(p.status); },
    audit: async (e) => { audits.push(e); },
    notify: (event) => { notes.push(event); },
    publishWaitMs: 1000,
  };

  const job: RunJob = {
    runId: 42, adapter: sc.adapter ?? 'wordpress', action, trigger: 'manual', options: sc.options ?? {}, createdBy: 3,
    site: { id: 12, tenantId: 2, accountId: 7, name: 'Blog', slug: 'blog', docroot: '', appProfile: 'wordpress', healthcheckPath: '/', php: '8.3' },
    account: { id: 7, nodeId: 1, uid: 20007, gid: 20007, limits: { memoryMb: 512, cpuCores: 1 } },
    base: { releaseId: 70, number: 4, commit: 'b'.repeat(40) },
    dataPaths: [{ path: 'wp-content/uploads', policy: 'typed', allowedExtensions: ['jpg'] }],
    paths: { workspaceLocal: ws, workspaceHost: '/srv/oblimint/accounts/7/sites/12/work/42/tree', dataHost: '/srv/oblimint/accounts/7/data/blog', dbSockets: { root: '/a', mysql: '/b', postgresql: '/c' } },
    settings: { stepTimeoutMs: 60_000, memoryMb: 1024 },
  };
  const last = () => Object.assign({}, ...saved) as Record<string, unknown>;
  const log = () => (JSON.parse(String(last().log)) as Array<{ message: string }>).map((l) => l.message).join('\n');
  const lines = () => JSON.parse(String(last().log)) as Array<{ message: string; raw?: boolean }>;
  return { job, deps, calls, statuses, saved, audits, notes, argvs, last, log, lines, release, waits: () => waits };
}

const ALWAYS = ['removeContainers 42', 'removeWorkspace 42'];

test('check: lists updates on a read-only copy, no snapshot, no release', async (t) => {
  const s = setup(t, {}, 'check');
  const out = await executeRun(s.job, s.deps);
  assert.equal(out.status, 'succeeded');
  assert.deepEqual(s.statuses, ['preparing', 'running', 'succeeded']);
  assert.ok(s.argvs.every((a) => a.ro), 'check: workspace read-only');
  assert.ok(s.argvs.every((a) => a.name.startsWith('oblimint-tools-42-')));
  const updates = JSON.parse(String(s.last().updates));
  assert.deepEqual(updates.map((u: { name: string; level: string }) => [u.name, u.level]), [['wordpress', 'patch'], ['akismet', 'patch']]);
  assert.ok(!s.calls.some((c) => /^(snapshots|commit|publish)/.test(c)));
  for (const c of ALWAYS) assert.ok(s.calls.includes(c), c);
  assert.ok(!s.calls.some((c) => c.startsWith('releaseSnapshots')));
  assert.deepEqual(s.notes, []);
  assert.ok(String(s.last().output).includes('$ wp core check-update --format=json --path=/srv/app'));
});

test('update: success → published, migrations RO, healthcheck, staging reflected', async (t) => {
  const s = setup(t, { writes: { 'wp-content/plugins/akismet/akismet.php': '<?php // 5.3.3', 'wp-includes/version.php': "<?php $wp_version = '6.5.5';" } });
  const out = await executeRun(s.job, s.deps);
  assert.equal(out.status, 'succeeded', s.log());
  assert.equal(out.resultReleaseId, 77);
  assert.deepEqual(s.statuses, ['preparing', 'running', 'analyzing', 'publishing', 'post_deploy', 'succeeded']);
  assert.equal(s.calls[0], 'snapshots adapter 42');
  assert.equal(s.calls[1], 'ensureWorkspace 42 #4');
  assert.ok(s.calls.includes('commit refs/oblimint/candidates/adapter-42 adapter wordpress #42'));
  assert.ok(s.calls.some((c) => c.startsWith('analyze adapter wp-content/plugins/akismet/akismet.php:file:')));
  assert.ok(s.calls.includes('publish adapter run=42 base=70 scan=fake'));
  assert.ok(s.calls.some((c) => c.startsWith('reflect {"kind":"workspace","workspaceId":42}')));
  for (const c of [...ALWAYS, 'deleteRef refs/oblimint/candidates/adapter-42', 'releaseSnapshots 42']) assert.ok(s.calls.includes(c), c);
  assert.ok(!s.calls.some((c) => c.startsWith('revert') || c.startsWith('restore')));
  const updateCmds = s.argvs.filter((a) => a.argv.includes('update') || a.argv[2] === 'update-db');
  assert.deepEqual(updateCmds.map((a) => [a.argv.slice(1, 3).join(' '), a.ro]), [
    ['core update', false], ['plugin update', false], ['language core', false], ['language plugin', false], ['language theme', false], ['core update-db', true],
  ]);
  assert.deepEqual(s.notes, ['adapter.completed']);
  assert.equal(s.last().result_release_id, 77);
  assert.equal(s.last().risk_score, 0);
  assert.equal(s.last().checksums, null);
  assert.match(s.log(), /sommes de contrôle indisponibles/);
});

test('update: nothing available → no_changes, nothing published', async (t) => {
  const s = setup(t, { coreCheck: 'Success: WordPress is at the latest version.', plugins: '[]' });
  const out = await executeRun(s.job, s.deps);
  assert.equal(out.status, 'no_changes');
  assert.ok(!s.calls.some((c) => c.startsWith('commit') || c.startsWith('publish')));
  assert.ok(s.calls.includes('releaseSnapshots 42'));
  assert.deepEqual(s.notes, []);
});

test('update: CLI changed nothing → no_changes, candidate ref dropped', async (t) => {
  const s = setup(t, { writes: {} });
  const out = await executeRun(s.job, s.deps);
  assert.equal(out.status, 'no_changes');
  assert.ok(s.calls.includes('deleteRef refs/oblimint/candidates/adapter-42'));
  assert.ok(!s.calls.some((c) => c.startsWith('publish')));
});

test('update: blocked analysis → failed riskBlocked, scan.threat, never published', async (t) => {
  const s = setup(t, { writes: { 'x.php': '<?php eval(base64_decode($_GET[1]));' }, blocked: true });
  const out = await executeRun(s.job, s.deps);
  assert.equal(out.status, 'failed');
  assert.match(out.error!, /risque trop élevé \(95\/100\)/);
  assert.ok(!s.calls.some((c) => c.startsWith('publish')));
  assert.deepEqual(s.notes, ['scan.threat', 'adapter.failed']);
  assert.equal(s.last().risk_level, 'critical');
});

test('update: release awaiting approval → awaiting_approval, migrations not run, ref kept', async (t) => {
  const s = setup(t, { writes: { 'a.php': '<?php' }, releaseStatus: 'awaiting_approval' });
  const out = await executeRun(s.job, s.deps);
  assert.equal(out.status, 'awaiting_approval');
  assert.equal(out.resultReleaseId, 77);
  assert.ok(!s.argvs.some((a) => a.argv[2] === 'update-db'), 'migrations not run');
  assert.ok(!s.calls.some((c) => c.startsWith('deleteRef') || c.startsWith('reflect')));
  assert.match(s.log(), /en attente d'approbation : migrations de base et reflet dans le staging après l'approbation/);
  assert.deepEqual(s.notes, ['adapter.completed']);
  // Deferred: workspace, snapshots and ref kept for the continuation; the changes to reflect saved.
  assert.ok(!s.calls.includes('removeWorkspace 42'), 'workspace kept (reflection source)');
  assert.ok(!s.calls.some((c) => c.startsWith('releaseSnapshots')), 'snapshots kept (rollback point)');
  assert.ok(!s.calls.some((c) => c.startsWith('restore')), 'WordPress apply never touched the database');
  assert.deepEqual(JSON.parse(String(s.last().analysis)).pendingReflect, [['a.php', 'modified', 'file']]);
});

test('continuation of an approved release: migrations RO, healthcheck, staging reflected from the kept workspace, cleanup', async (t) => {
  const s = setup(t, { writes: { 'a.php': '<?php' } });
  // The workspace still exists (kept by the deferred run).
  await s.deps.ensureWorkspace(1, { accountId: 7, siteId: 12, slug: 'blog', uid: 1, gid: 1, workspaceId: 42, releaseNumber: 4 });
  s.calls.length = 0;
  const out = await continueApprovedRun(s.job, s.deps, {
    release: s.release('ready'),
    log: [{ at: '2026-01-01T00:00:00.000Z', level: 'info', message: 'run en file' }],
    output: '$ wp core update\n',
    outputTruncated: false,
    analysis: { verdict: 'clean', pendingReflect: [['a.php', 'modified', 'file'], ['old.php', 'deleted', 'file']] },
  });
  assert.equal(out.status, 'succeeded', s.log());
  assert.deepEqual(s.statuses, ['post_deploy', 'succeeded']);
  const updb = s.argvs.find((a) => a.argv[2] === 'update-db');
  assert.ok(updb && updb.ro, 'migrations on a read-only workspace');
  assert.ok(s.calls.includes('reflect {"kind":"workspace","workspaceId":42} a.php,old.php'));
  for (const c of [...ALWAYS, 'deleteRef refs/oblimint/candidates/adapter-42', 'releaseSnapshots 42']) assert.ok(s.calls.includes(c), c);
  assert.match(s.log(), /^run en file\n.*release #5 approuvée : reprise/s, 'log continued, not replaced');
  assert.equal(JSON.parse(String(s.last().analysis)).pendingReflect, undefined, 'private key dropped');
  assert.deepEqual(s.notes, ['adapter.completed']);
});

test('continuation: the approved release is no longer live → failed, no migration', async (t) => {
  const s = setup(t, { currentRelease: 90 });
  const out = await continueApprovedRun(s.job, s.deps, { release: s.release('ready'), log: [], output: null, outputTruncated: false, analysis: { pendingReflect: [] } });
  assert.equal(out.status, 'failed');
  assert.match(out.error!, /n'est plus en ligne : migrations de base non lancées/);
  assert.ok(!s.argvs.length && !s.calls.some((c) => c.startsWith('revert') || c.startsWith('reflect')));
});

test('nextcloud: apply migrates the live database → restored on every exit before publication', async (t) => {
  const blocked = setup(t, { adapter: 'nextcloud', writes: { 'apps/calendar/appinfo/info.xml': '<version>4.7.15</version>' }, blocked: true });
  const o1 = await executeRun(blocked.job, blocked.deps);
  assert.equal(o1.status, 'failed');
  assert.ok(blocked.calls.includes('restore 501'), 'blocked ⇒ databases back to the snapshot');
  assert.ok(!blocked.calls.some((c) => c.startsWith('publish')));

  const failing = setup(t, { adapter: 'nextcloud', updateFails: true });
  const o2 = await executeRun(failing.job, failing.deps);
  assert.equal(o2.status, 'failed');
  assert.ok(failing.calls.includes('restore 501'), 'a half-done app:update is undone too');

  const approval = setup(t, { adapter: 'nextcloud', writes: { 'apps/calendar/x.php': '<?php' }, releaseStatus: 'awaiting_approval' });
  const o3 = await executeRun(approval.job, approval.deps);
  assert.equal(o3.status, 'awaiting_approval');
  assert.ok(approval.calls.includes('restore 501'), 'live code = base release ⇒ live databases = snapshot');
  assert.ok(!approval.calls.some((c) => c.startsWith('releaseSnapshots')), 'snapshots kept for the continuation');

  const ok = setup(t, { adapter: 'nextcloud', writes: { 'apps/calendar/x.php': '<?php' } });
  const o4 = await executeRun(ok.job, ok.deps);
  assert.equal(o4.status, 'succeeded', ok.log());
  assert.ok(!ok.calls.some((c) => c.startsWith('restore')));
  assert.ok(ok.argvs.some((a) => a.argv[2] === 'upgrade' && a.ro));
});

test('rollback never reverts a newer release published meanwhile', async (t) => {
  const s = setup(t, { writes: { 'a.php': '<?php' }, updateDbFails: true, currentRelease: 78 });
  const out = await executeRun(s.job, s.deps);
  assert.equal(out.status, 'failed');
  assert.match(out.error!, /retour arrière non effectué : une release plus récente est en ligne/);
  assert.ok(!s.calls.some((c) => c.startsWith('revert') || c.startsWith('restore')));
  assert.equal(s.audits[0]?.details.skipped, 'releaseSuperseded');
});

test('healthcheck failure without any migration: code reverted, databases NOT restored', async (t) => {
  const s = setup(t, { writes: { 'a.php': '<?php' }, healthcheck: 'HTTP 500', options: { runMigrations: false } });
  const out = await executeRun(s.job, s.deps);
  assert.equal(out.status, 'rolled_back');
  assert.ok(s.calls.some((c) => c.startsWith('revert 70 ')));
  assert.ok(!s.calls.some((c) => c.startsWith('restore')), 'live writes since the snapshot kept');
  assert.equal(s.audits[0]?.details.databasesRestored, 0);
});

test('release still in the pipeline after every wait round → failed, ref kept for the staff', async (t) => {
  const s = setup(t, { writes: { 'a.php': '<?php' }, releaseStatus: 'publishing' });
  const out = await executeRun(s.job, s.deps);
  assert.equal(out.status, 'failed');
  assert.equal(s.waits(), MAX_RELEASE_WAIT_ROUNDS);
  assert.match(out.error!, /toujours en cours de publication .* à vérifier/);
  assert.equal(out.resultReleaseId, 77);
  assert.ok(!s.calls.some((c) => c.startsWith('deleteRef')), 'the release may still go live: its ref stays');
});

test('a failed copy still removes the workspace (hostd may have started it)', async (t) => {
  const s = setup(t, { ensureFails: true });
  const out = await executeRun(s.job, s.deps);
  assert.equal(out.status, 'failed');
  assert.ok(s.calls.includes('removeWorkspace 42'));
});

test('composer install runs on an up-to-date project and claims no upgrade', async (t) => {
  const s = setup(t, { adapter: 'composer', options: { composerCommand: 'install', noDev: true }, writes: { 'vendor/autoload.php': '<?php' } });
  const out = await executeRun(s.job, s.deps);
  assert.equal(out.status, 'succeeded', s.log());
  assert.ok(s.argvs.some((a) => a.argv[1] === 'install' && a.argv.includes('--no-dev') && !a.ro));
  assert.equal(s.last().updates, '[]', 'install upgrades none of the outdated packages');
  assert.ok(s.calls.includes('publish adapter run=42 base=70 scan=fake'));
});

test('A6 flags: raw causes marked, the machine\'s own lines not', async (t) => {
  const s = setup(t, { updateFails: true });
  await executeRun(s.job, s.deps);
  const ls = s.lines();
  assert.ok(ls.find((l) => l.message.startsWith('mise à jour en échec : '))?.raw, 'failure text flagged');
  assert.ok(!ls.find((l) => l.message.startsWith('WordPress (WP-CLI) : mise à jour'))?.raw, 'own text unflagged');
});

test('update: failure before publication → failed, nothing moved', async (t) => {
  const s = setup(t, { updateFails: true });
  const out = await executeRun(s.job, s.deps);
  assert.equal(out.status, 'failed');
  assert.match(out.error!, /mise à jour en échec : mise à jour du cœur WordPress : Error: Download failed/);
  assert.ok(!s.calls.some((c) => /^(commit|publish|revert|restore)/.test(c)));
  for (const c of [...ALWAYS, 'releaseSnapshots 42']) assert.ok(s.calls.includes(c), c);
  assert.deepEqual(s.notes, ['adapter.failed']);

  const busy = setup(t, { writes: { 'a.php': '<?php' }, publishThrows: { code: 'publishInProgress', statusCode: 409 } });
  const o2 = await executeRun(busy.job, busy.deps);
  assert.equal(o2.status, 'failed');
  assert.equal(o2.error, 'publication refusée : une publication est déjà en cours');
  assert.ok(!busy.calls.some((c) => c.startsWith('revert')));

  const pipeline = setup(t, { writes: { 'a.php': '<?php' }, releaseStatus: 'failed' });
  const o3 = await executeRun(pipeline.job, pipeline.deps);
  assert.equal(o3.status, 'failed');
  assert.match(o3.error!, /la publication de la release #5 a échoué : healthcheck en échec/);
  assert.ok(!pipeline.calls.some((c) => c.startsWith('revert') || c.startsWith('restore')), 'the pipeline rolled the code back itself');
});

test('update: failure in post_deploy → revertTo(base) + snapshot restore → rolled_back', async (t) => {
  const s = setup(t, { writes: { 'a.php': '<?php' }, updateDbFails: true });
  const out = await executeRun(s.job, s.deps);
  assert.equal(out.status, 'rolled_back', s.log());
  assert.match(out.error!, /^migrations de base en échec/);
  const revert = s.calls.findIndex((c) => c.startsWith('revert 70 '));
  const restore = s.calls.indexOf('restore 501');
  assert.ok(revert >= 0 && restore > revert, 'code first, then the databases');
  assert.ok(!s.calls.some((c) => c.startsWith('reflect')), 'staging untouched');
  assert.deepEqual(s.audits.map((a) => [a.action, a.tenantId, a.details.codeRestored, a.details.databasesRestored]), [['adapter.rollback', 2, true, 1]]);
  assert.deepEqual(s.notes, ['adapter.failed']);
  assert.equal(s.statuses.at(-1), 'rolled_back');
});

test('update: healthcheck failure after migrations → rolled_back', async (t) => {
  const s = setup(t, { writes: { 'a.php': '<?php' }, healthcheck: 'healthcheck en échec : HTTP 500' });
  const out = await executeRun(s.job, s.deps);
  assert.equal(out.status, 'rolled_back');
  assert.match(out.error!, /contrôle HTTP en échec après la mise à jour/);
  assert.ok(s.calls.includes('restore 501'));
});

test('update: a failed snapshot cancels the run before the copy', async (t) => {
  const s = setup(t, { snapshot: 'failed' });
  const out = await executeRun(s.job, s.deps);
  assert.equal(out.status, 'failed');
  assert.match(out.error!, /clichés des bases en échec \(wp\)/);
  assert.ok(!s.calls.some((c) => c.startsWith('ensureWorkspace')));
  assert.ok(!s.calls.includes('removeWorkspace 42'), 'no workspace was created');
});
