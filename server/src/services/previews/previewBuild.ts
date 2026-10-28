import fs from 'fs';
import path from 'path';
import type { PreviewWarningCode, ScanSummary } from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { siteDeletions } from '../hosting/deletions';
import { releasePreviewContainer } from '../hosting/naming';
import { localPaths } from '../hosting/paths';
import { json, type DataPathRow } from '../hosting/rows';
import { buildPreviewRuntimeConfig, writeRuntimeConfigFiles } from '../docker/runtimeConfig';
import { runtimeConfigInput } from '../docker/siteOps';
import { PREVIEW_MAX_EPHEMERAL_TMPFS, isPreviewTmpfsPath } from '../docker/specs';
import { commitWholeTree, dropCandidateRef } from '../releases/candidate';
import { materializeRelease, switchCurrent } from '../releases/materialize';
import { commitExists, diffStats, headCommit } from '../releases/repo';
import { releaseService } from '../releases/release.service';
import { emitPreview, errorText, failPreview, loadPreview, previewCandidateRef, previewDirs, previewOptions, type PreviewRow } from './previewCore';
import { previewDeps } from './previewDeps';

// ─────────────────────────────────────────────────────────────────────────────
// Feature B — preview builder: in-process queue (2 builds at a time, one per
// site), a cancel flag per build, the in-flight registry awaited by
// teardownSite. Before EVERY disk write: guard() (cancelled, site being
// deleted, account deleting) — A6.
//
//   mkdir previews/<id>/{releases,runtime} → [staging: snapshot commit under
//   the site lock (withSiteLock: clearStaleGitLocks never runs meanwhile)] →
//   scan (staging snapshot, or a release never scanned: B6) → ephemeral paths
//   (real directories only) → tree releases/<n|0> hardlinked from the live tree
//   → current → <n> → preview.json → starting → reconcile → readiness →
//   edge sync → running.
// ─────────────────────────────────────────────────────────────────────────────

export const BUILD_CONCURRENCY = 2;
export const READINESS_ATTEMPTS = 20;
export const SNAPSHOT_LOCK_RETRIES = 5;
export const SNAPSHOT_LOCK_DELAY_MS = 2_000;

class BuildCancelled extends Error {}
class BuildFailure extends Error {
  constructor(public code: string, message: string) { super(message); }
}

interface Build { id: number; siteId: number; cancelled: boolean; done: Promise<void> }

const queue: Array<{ id: number; siteId: number }> = [];
const inFlight = new Map<number, Build>();

/** Tests: the builds in flight (by preview id). */
export function buildsInFlight(): number[] {
  return [...inFlight.keys()];
}

export const previewBuilder = {
  enqueue(id: number, siteId: number): void {
    if (inFlight.has(id) || queue.some((q) => q.id === id)) return;
    queue.push({ id, siteId });
    drain();
  },

  /** Cancels the builds of a site (queued ones dropped) and waits for the running one (≤ timeoutMs). */
  async cancelSite(siteId: number, timeoutMs = 30_000): Promise<void> {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].siteId === siteId) queue.splice(i, 1);
    const running = [...inFlight.values()].filter((b) => b.siteId === siteId);
    for (const b of running) b.cancelled = true;
    if (!running.length) return;
    await Promise.race([
      Promise.allSettled(running.map((b) => b.done)),
      new Promise((r) => { const t = setTimeout(r, timeoutMs); t.unref?.(); }),
    ]);
  },

  cancel(id: number): void {
    const i = queue.findIndex((q) => q.id === id);
    if (i >= 0) queue.splice(i, 1);
    const b = inFlight.get(id);
    if (b) b.cancelled = true;
  },
};

function drain(): void {
  while (inFlight.size < BUILD_CONCURRENCY) {
    const busySites = new Set([...inFlight.values()].map((b) => b.siteId));
    const idx = queue.findIndex((q) => !busySites.has(q.siteId));
    if (idx < 0) return;
    const [next] = queue.splice(idx, 1);
    const build: Build = { id: next.id, siteId: next.siteId, cancelled: false, done: Promise.resolve() };
    build.done = runBuild(build)
      .catch((err) => logger.error({ err: (err as Error).message, previewId: next.id }, 'preview build crashed'))
      .finally(() => { inFlight.delete(next.id); drain(); });
    inFlight.set(next.id, build);
  }
}

async function runBuild(build: Build): Promise<void> {
  try {
    await build1(build);
  } catch (err) {
    if (err instanceof BuildCancelled) {
      logger.info({ previewId: build.id }, 'preview build cancelled');
      const row = await loadPreview(build.id).catch(() => null);
      if (row && row.status === 'building') await failPreview(build.id, 'cancelled', 'Construction annulée').catch(() => undefined);
      return;
    }
    const code = err instanceof BuildFailure ? err.code : 'previewBuildFailed';
    const msg = err instanceof BuildFailure ? err.message : `Construction de l’aperçu impossible : ${(err as Error)?.message ?? String(err)}`;
    logger.warn({ previewId: build.id, code, err: (err as Error)?.message }, 'preview build failed');
    await failPreview(build.id, code, msg).catch((e) => logger.warn({ err: (e as Error).message }, 'preview: fail not recorded'));
  }
}

async function build1(build: Build): Promise<void> {
  const deps = previewDeps();
  const row = await loadPreview(build.id);
  if (!row || row.status !== 'building') return;
  const guard = async (): Promise<void> => {
    if (build.cancelled || siteDeletions.has(row.site_id)) throw new BuildCancelled();
    const acct = await db('hosting_accounts').where({ id: row.account_id }).first('status') as { status: string } | undefined;
    if (!acct || acct.status === 'deleting') throw new BuildCancelled();
    const cur = await db('site_previews').where({ id: row.id }).first('status') as { status: string } | undefined;
    if (!cur || cur.status !== 'building') throw new BuildCancelled();
  };

  const ctx = await releaseService.previewContext(row.site_id);
  const dirs = previewDirs(row);
  const options = previewOptions(row.options);
  const warnings = new Set<PreviewWarningCode>(json<PreviewWarningCode[]>(row.warnings, []));
  await guard();
  fs.mkdirSync(dirs.root, { recursive: true, mode: 0o755 });
  fs.mkdirSync(dirs.releases, { recursive: true, mode: 0o755 });
  fs.mkdirSync(dirs.runtime, { recursive: true, mode: 0o755 });

  const dataPaths = ctx.dataPaths.map((d) => d.path);
  const live = ctx.liveTree;
  let commit: string;
  let scan: ScanSummary | null = json<ScanSummary | null>(row.scan, null);
  const number = row.target === 'release' ? Number(row.release_number) : 0;

  if (row.target === 'release') {
    commit = String(row.commit_sha ?? '');
    if (!commit || !(await commitExists(ctx.paths.repo, commit))) throw new BuildFailure('releaseNotReady', 'Commit de la release introuvable');
    if (!scan) {
      // B6: a release that was never scanned (failed before its scan) is scanned now.
      const stats = await diffStats(ctx.paths.repo, ctx.liveCommit, commit);
      scan = await releaseService.scanCommit(row.site_id, row.account_id, ctx.paths.staging, commit, stats.changed);
      await db('site_previews').where({ id: row.id }).update({ scan: JSON.stringify(scan), updated_at: db.fn.now() });
    }
  } else {
    await guard();
    const baseCommit = ctx.liveCommit ?? await headCommit(ctx.paths.repo);
    const refName = previewCandidateRef(row.id);
    let cand: Awaited<ReturnType<typeof commitWholeTree>> | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        cand = await releaseService.withSiteLock(row.site_id, async () => {
          await guard();
          return commitWholeTree({
            repoDir: ctx.paths.repo, baseCommit, workTree: ctx.paths.staging, dataPaths,
            message: `Aperçu du staging #${row.id}`, author: { name: 'Oblimint preview', email: 'preview@oblimint.local' }, refName,
          });
        });
        break;
      } catch (err) {
        if ((err as { code?: string })?.code !== 'publishInProgress') throw err;
        if (attempt >= SNAPSHOT_LOCK_RETRIES) throw new BuildFailure('publishInProgress', 'Une publication est en cours sur ce site : réessayez dans un instant');
        await deps.sleep(SNAPSHOT_LOCK_DELAY_MS);
      }
    }
    commit = cand!.commit;
    // Recorded only while still building: a stop during commitWholeTree has already run its
    // cleanup (the ref did not exist yet), so the ref is dropped here.
    const kept = await db('site_previews').where({ id: row.id, status: 'building' }).update({ commit_sha: commit, candidate_ref: refName, updated_at: db.fn.now() });
    if (!kept) {
      await dropCandidateRef(ctx.paths.repo, refName).catch((err) => logger.debug({ err: (err as Error).message, previewId: row.id }, 'preview: candidate ref not dropped'));
      throw new BuildCancelled();
    }
    const changed = cand!.files.filter((f) => f.change !== 'deleted').map((f) => f.path);
    scan = await releaseService.scanCommit(row.site_id, row.account_id, ctx.paths.staging, commit, changed);
    await db('site_previews').where({ id: row.id }).update({ scan: JSON.stringify(scan), updated_at: db.fn.now() });
  }
  if (scan?.blocked && !options.allowBlockedScan) throw new BuildFailure('scanBlocked', 'Le code est bloqué par l’analyse : aucun aperçu');
  if (scan && (scan.verdict !== 'clean' || scan.findings.length > 0)) warnings.add('scanWarnings');

  // Ephemeral data paths: one tmpfs each, only on a REAL directory (lstat, never a symlink — B13 / §4.18).
  const dataRoot = localPaths.siteData(row.account_id, ctx.site.slug);
  const ephemeral: string[] = [];
  for (const d of ctx.dataPaths as DataPathRow[]) {
    if (d.policy !== 'ephemeral') continue;
    let ok = isPreviewTmpfsPath(d.path);
    if (ok) {
      try {
        let cur = dataRoot;
        for (const seg of d.path.split('/')) {
          cur = path.posix.join(cur, seg);
          const st = fs.lstatSync(cur);
          if (st.isSymbolicLink() || !st.isDirectory()) { ok = false; break; }
        }
      } catch { ok = false; }
    }
    if (ok && ephemeral.length < PREVIEW_MAX_EPHEMERAL_TMPFS) ephemeral.push(d.path);
    else warnings.add('ephemeralSkipped');
  }

  await guard();
  await materializeRelease({
    repoDir: ctx.paths.repo,
    releasesDir: dirs.releases,
    number,
    commit,
    dataPaths,
    typedDataPaths: ctx.dataPaths.filter((d) => d.policy === 'typed').map((d) => d.path),
    base: live ? { number: live.number, commit: live.commit } : null,
    baseDir: live?.dir,
  });
  await guard();
  switchCurrent(dirs.releases, number);
  const cfg = buildPreviewRuntimeConfig(runtimeConfigInput({ site: ctx.site, runtimes: [], dataPaths: ctx.dataPaths, routes: [] }), row.base);
  await writeRuntimeConfigFiles(dirs.runtime, [cfg]);
  // The reload marker is meaningless for a preview (never reloaded): dropped.
  fs.rmSync(path.join(dirs.runtime, '.reload-pending'), { force: true });

  await guard();
  const n = await db('site_previews').where({ id: row.id, status: 'building' }).update({
    status: 'starting',
    options: JSON.stringify({ ...options, ephemeralPaths: ephemeral }),
    warnings: JSON.stringify([...warnings].sort()),
    updated_at: db.fn.now(),
  });
  if (!n) throw new BuildCancelled();
  emitPreview(row, 'starting');

  const report = await deps.reconcile(row.account_id);
  const issue = (report.issues ?? []).find((i) => i.scope === `preview:${row.site_id}` || i.scope === 'account' || i.scope === `site:${row.site_id}`);
  if (issue) throw new BuildFailure('previewStartFailed', `Le conteneur de l’aperçu n’a pas démarré : ${issue.message}`);

  // Readiness: any HTTP status = up.
  const site = ctx.site as { healthcheck_path?: string | null };
  const hc = site.healthcheck_path?.startsWith('/') ? site.healthcheck_path : '/';
  const liveHost = await import('../releases/release.service').then((m) => m.healthcheckHost(row.site_id)).catch(() => row.host);
  let up = false;
  for (let i = 0; i < READINESS_ATTEMPTS; i++) {
    if (build.cancelled) throw new BuildCancelled();
    const r = await deps.fetch(releasePreviewContainer(row.site_id, row.id), hc, { host: liveHost, method: 'GET', maxBytes: 1024 });
    if (r.status !== null) { up = true; break; }
    await deps.sleep(1_000);
  }
  if (build.cancelled || siteDeletions.has(row.site_id)) throw new BuildCancelled();
  if (!up) throw new BuildFailure('previewNotReady', 'Le conteneur de l’aperçu ne répond pas');

  const m = await db('site_previews').where({ id: row.id, status: 'starting' }).update({ status: 'running', started_at: db.fn.now(), updated_at: db.fn.now() });
  if (!m) return; // stopped meanwhile: the stop path cleans up
  try {
    await deps.syncEdgeNow();
  } catch (err) {
    logger.warn({ err: (err as Error).message, previewId: row.id }, 'preview: edge sync failed (retried by the scheduled syncs)');
    deps.scheduleEdgeSync('preview');
  }
  emitPreview(row, 'running');
}

/** Fails a build (test / worker use): generic message. */
export async function failBuild(row: PreviewRow, code: string, message: string): Promise<void> {
  previewBuilder.cancel(row.id);
  await failPreview(row.id, code, errorText(message));
}
