import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type {
  ProfileDetection, Release, ReleaseDetail, ReleaseDiff, ReleaseDiffFile, ReleaseLogLine, ReleaseStatus, ReleaseTrigger,
  ScanSummary, StagingStatus,
} from '@oblimint/shared';
import { detectAppProfile, HostingSocketEvents, normalizeRelPath } from '@oblimint/shared';
import { db } from '../../db';
import { config } from '../../config';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { siteDeletions } from '../hosting/deletions';
import { dataPathForbiddenError } from '../hosting/hostingValidation.service';
import { localPaths } from '../hosting/paths';
import { siteUpstream } from '../hosting/naming';
import { emitHosting } from '../hosting/events';
import { json, toRelease, toReleaseDetail, type DataPathRow, type ReleaseRow, type SiteRow } from '../hosting/rows';
import { HostdError, type HostdSiteSpec } from '../hostd/client';
import type { PublishCommitOptions } from '../maintenance/contracts';
import { notify } from '../usage/notifications.service';
import { EMPTY_TREE, type GitIdentity } from './git';
import {
  clearStaleGitLocks, commitExists, commitStaging, diffNameStatus, diffNumstat, diffStats, filePatch, headCommit, initBareRepo, scanStaging,
  stagingChanges, stagingMatchesCommit, writeExclude,
} from './repo';
import { fastForwardHead, parentOf } from './candidate';
import { dataLinksMatch, materializeRelease, readCurrent, removeTmpEntries, removeUnder, staleDataExposure, switchCurrent } from './materialize';
import { releaseDeps } from './deps';
import { getScanner } from './scan';

// ─────────────────────────────────────────────────────────────────────────────
// Release pipeline (ARCHITECTURE §1, docs/P1-PLAN.md §9). OWNED BY MODULE `releases` (P1);
// in P3 by module `windows` (docs/P3-PLAN.md §2: publishCommit, windowActive guards, scan override).
//
// P3: publish / approve / rollback / applyDataPathChange refuse 409
// windowActive while a modification window holds the site (§5.3);
// publishCommit publishes a candidate commit (window / adapter) through the
// same steps; a BLOCKED scan (risk ≥ blockScore or ClamAV) waits for an
// audited staff override instead of failing (§9.3, M5).
// Callers have ALREADY checked access (services/hosting/access.ts).
//
// publish: lock(site) → commit staging into repo.git (author, message,
// data paths excluded) → scan hook → [approval gate] → materialize
// releases/<n> (hardlinks to the current release for unchanged blobs) → data
// links (<path> → /srv/data/<path>) → hostd ensure/seed/clear → atomic switch
// of releases/current → runtimeService.reloadSite → HTTP healthcheck →
// auto-rollback on failure → prune (keep N + current) → events/audit.
//
// One pipeline per site at a time: in-process lock (this panel is the only
// writer) + a DB check on in-flight statuses (survives nothing: a restart
// marks them failed through recoverInterrupted()).
// ─────────────────────────────────────────────────────────────────────────────

export interface PublishOptions {
  trigger: ReleaseTrigger;
  /** null = file-server event (auto). */
  userId: number | null;
  message?: string | null;
}

const IN_FLIGHT: ReleaseStatus[] = ['queued', 'scanning', 'publishing'];
/** waitForRelease polling period. */
const WAIT_POLL_MS = 250;
/** waitForRelease: longest wait for the end of the run (prune) once the release is settled. */
const WAIT_LOCK_GRACE_MS = 60_000;
const LOG_CAP = 500;
const DIFF_FILES_CAP = 2000;
const PATCH_FILE_CAP = 256 * 1024;
const AUTO_PATCH_MAX_FILES = 20;
const AUTO_PATCH_MAX_BYTES = 16 * 1024;
const STAGING_FILES_CAP = 500;

/** Expected pipeline failure: its message (French) is shown as the release error. */
class PipelineError extends Error {}

/** A pipeline failure caused by a transient backend state (hostd busy / restarting): an auto publication is retried. */
class TransientPipelineError extends PipelineError {}

/** hostd answers that mean "try again later" (another long operation holds the account, hostd restarting). */
const TRANSIENT_HOSTD_CODES = new Set(['busy', 'cancelled', 'hostdUnavailable']);
/** Backoff of the hostd calls of a publication (≈ 2 min in all; the auto-publish scheduler retries after that). */
const HOSTD_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];

function isTransientHostd(err: unknown): boolean {
  return err instanceof HostdError && TRANSIENT_HOSTD_CODES.has(err.code ?? '');
}

/** Sites with a pipeline / rollback running in this process. */
const locks = new Set<number>();

// ── context ──────────────────────────────────────────────────────────────────

interface SiteContext {
  site: SiteRow;
  account: { id: number; tenant_id: number; node_id: number; uid: number; gid: number; status: string; username: string };
  dataPaths: DataPathRow[];
  paths: { site: string; repo: string; releases: string; runtime: string; staging: string };
}

async function loadContext(siteId: number): Promise<SiteContext> {
  const site = await db('sites').where({ id: siteId }).first() as SiteRow | undefined;
  if (!site) throw new AppError(404, 'Site not found', 'notFound');
  const account = await db('hosting_accounts').where({ id: site.account_id })
    .first('id', 'tenant_id', 'node_id', 'uid', 'gid', 'status', 'username') as SiteContext['account'] | undefined;
  if (!account) throw new AppError(404, 'Account not found', 'notFound');
  const dataPaths = await db('site_data_paths').where({ site_id: siteId }).orderBy('path') as DataPathRow[];
  return {
    site,
    account,
    // Defense in depth: a row naming a per-directory config file (.htaccess,
    // .user.ini, php.ini… refused by hosting-api since) never becomes a data link.
    dataPaths: dataPaths.filter((d) => normalizeRelPath(d.path) === d.path && dataPathForbiddenError(d.path) === null),
    paths: {
      site: localPaths.site(account.id, site.id),
      repo: localPaths.repo(account.id, site.id),
      releases: localPaths.releases(account.id, site.id),
      runtime: localPaths.runtime(account.id, site.id),
      staging: localPaths.siteStaging(account.id, site.slug),
    },
  };
}

function hostdSpec(ctx: SiteContext): HostdSiteSpec {
  return { accountId: ctx.account.id, siteId: ctx.site.id, slug: ctx.site.slug, uid: ctx.account.uid, gid: ctx.account.gid };
}

const dataPathList = (ctx: SiteContext): string[] => ctx.dataPaths.map((d) => d.path);

async function ensureStorageFor(ctx: SiteContext): Promise<void> {
  fs.mkdirSync(ctx.paths.site, { recursive: true, mode: 0o755 });
  await initBareRepo(ctx.paths.repo);
  for (const dir of [ctx.paths.releases, ctx.paths.runtime]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o755 });
  }
  // Created when missing only: the publication rewrites it (with nested repos) under the site lock,
  // and a read-only caller (stagingStatus) must never clobber it during a `git add -A`.
  if (!fs.existsSync(path.join(ctx.paths.repo, 'info', 'exclude'))) writeExclude(ctx.paths.repo, dataPathList(ctx));
}

/**
 * Disk state left by a crash, a SIGKILLed git or an interrupted switch:
 * stale git locks, releases/*.tmp, and `current` not naming the release of
 * sites.current_release_id (the only one that passed its healthcheck).
 * Caller guarantees no pipeline runs for the site (site lock held or boot).
 */
async function repairSiteDisk(ctx: SiteContext, doReload: boolean): Promise<void> {
  const removedLocks = fs.existsSync(ctx.paths.repo) ? clearStaleGitLocks(ctx.paths.repo) : [];
  if (removedLocks.length) logger.warn({ siteId: ctx.site.id, removed: removedLocks }, 'Release: stale git locks removed');
  const removedTmp = removeTmpEntries(ctx.paths.releases);
  if (removedTmp.length) logger.warn({ siteId: ctx.site.id, removed: removedTmp }, 'Release: leftover temporary trees removed');
  await syncCurrent(ctx, doReload);
  const orphans = await removeOrphanTrees(ctx);
  if (orphans.length) logger.warn({ siteId: ctx.site.id, removed: orphans }, 'Release: trees not recorded on disk removed');
}

/**
 * releases/<n> directories whose row is not on_disk (or missing): a prune
 * interrupted between the row update and the removal, or a crash between the
 * rename of a materialized tree and its `on_disk: true`. Never `current`.
 * Caller guarantees no pipeline runs for the site.
 */
async function removeOrphanTrees(ctx: SiteContext): Promise<string[]> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(ctx.paths.releases, { withFileTypes: true }); } catch { return []; }
  const numbers = entries.filter((e) => /^\d+$/.test(e.name)).map((e) => Number(e.name));
  if (!numbers.length) return [];
  const onDisk = new Set((await db('releases').where({ site_id: ctx.site.id, on_disk: true }).pluck('number') as Array<number | string>).map(Number));
  const current = readCurrent(ctx.paths.releases, releaseDeps().links);
  const removed: string[] = [];
  for (const n of numbers) {
    if (onDisk.has(n) || n === current) continue;
    try {
      removeUnder(ctx.paths.releases, path.posix.join(ctx.paths.releases, String(n)));
      removed.push(String(n));
    } catch (err) {
      logger.warn({ err, siteId: ctx.site.id, number: n }, 'Release: cannot remove an orphan tree');
    }
  }
  return removed;
}

// ── release rows ─────────────────────────────────────────────────────────────

function releaseQuery() {
  return db('releases as r')
    .join('sites as s', 's.id', 'r.site_id')
    .leftJoin('users as au', 'au.id', 'r.author_user_id')
    .leftJoin('users as ap', 'ap.id', 'r.approved_by')
    .select(
      'r.*',
      db.raw('COALESCE(au.display_name, au.username) as author_name'),
      db.raw('COALESCE(ap.display_name, ap.username) as approver_name'),
      db.raw('(s.current_release_id = r.id) as is_current'),
    );
}

async function fetchRelease(siteId: number, releaseId: number): Promise<ReleaseRow> {
  const row = await releaseQuery().where('r.id', releaseId).andWhere('r.site_id', siteId).first() as ReleaseRow | undefined;
  if (!row) throw new AppError(404, 'Release not found', 'notFound');
  return row;
}

/** One pipeline run: buffered log + status updates + socket events. */
class Run {
  private log: ReleaseLogLine[];

  constructor(public ctx: SiteContext, public release: ReleaseRow) {
    this.log = json<ReleaseLogLine[]>(release.log, []);
  }

  private emit(status: ReleaseStatus): void {
    emitHosting(HostingSocketEvents.RELEASE_UPDATED, { siteId: this.ctx.site.id, releaseId: this.release.id, status }, {
      tenantId: this.ctx.site.tenant_id, accountId: this.ctx.account.id,
    });
  }

  line(level: ReleaseLogLine['level'], message: string): void {
    this.log.push({ at: new Date().toISOString(), level, message });
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
  }

  /** Appends a log line and persists it with optional column updates. */
  async step(level: ReleaseLogLine['level'], message: string, patch: Record<string, unknown> = {}): Promise<void> {
    this.line(level, message);
    await this.save(patch);
  }

  async save(patch: Record<string, unknown> = {}): Promise<void> {
    await db('releases').where({ id: this.release.id }).update({ ...patch, log: JSON.stringify(this.log), updated_at: db.fn.now() });
    if (typeof patch.status === 'string') {
      this.release.status = patch.status as ReleaseStatus;
      this.emit(patch.status as ReleaseStatus);
    }
  }
}

// ── identity, domains, healthcheck ───────────────────────────────────────────

async function authorIdentity(userId: number | null): Promise<GitIdentity> {
  if (!userId) return { name: 'sftp', email: 'sftp@oblimint.local' };
  const u = await db('users').where({ id: userId }).first('username', 'display_name') as { username: string; display_name: string | null } | undefined;
  if (!u) return { name: `user-${userId}`, email: `user-${userId}@oblimint.local` };
  const local = u.username.toLowerCase().replace(/[^a-z0-9._-]/g, '-') || `user-${userId}`;
  return { name: u.display_name || u.username, email: `${local}@oblimint.local` };
}

/** Host header of the healthcheck: the domain routed at '/', else any routed domain, else 'localhost'. */
export async function healthcheckHost(siteId: number): Promise<string> {
  const row = await db('site_routes as sr')
    .join('domains as d', 'd.id', 'sr.domain_id')
    .where('sr.site_id', siteId)
    .orderByRaw(`(sr.path_prefix = '/') DESC, (sr.runtime_id IS NULL) DESC, (d.kind = 'primary') DESC, d.id ASC`)
    .first('d.name') as { name: string } | undefined;
  return row?.name ?? 'localhost';
}

/**
 * HTTP healthcheck of the site's primary container, outside a pipeline
 * (orchestration: after a runtime switch / promotion). null = healthy.
 */
export async function siteHealthcheck(site: Pick<SiteRow, 'id' | 'healthcheck_path'>): Promise<string | null> {
  const r = await healthcheck({ site }, null);
  return r.ok ? null : r.error;
}

async function healthcheck(ctx: { site: Pick<SiteRow, 'id' | 'healthcheck_path'> }, run: Run | null): Promise<{ ok: boolean; error: string | null }> {
  const deps = releaseDeps();
  const hcPath = ctx.site.healthcheck_path?.startsWith('/') ? ctx.site.healthcheck_path : `/${ctx.site.healthcheck_path ?? ''}`;
  const url = siteUpstream(ctx.site.id) + hcPath;
  const host = await healthcheckHost(ctx.site.id);
  let last: string | null = null;
  for (let i = 1; i <= deps.health.attempts; i++) {
    const r = await deps.probe(url, host, deps.health.timeoutMs);
    if (r.ok) {
      run?.line('info', `healthcheck OK (HTTP ${r.status}, essai ${i})`);
      return { ok: true, error: null };
    }
    last = r.error ?? `HTTP ${r.status}`;
    run?.line('warn', `healthcheck essai ${i}/${deps.health.attempts} : ${last}`);
    if (i < deps.health.attempts) await deps.sleep(deps.health.delayMs);
  }
  return { ok: false, error: `healthcheck en échec : ${last}` };
}

/** Reloads every running container of the site. ok=false (logged) when one of them could not be reloaded. */
async function reload(ctx: SiteContext, run: Run | null): Promise<{ ok: boolean; error: string | null }> {
  try {
    const r = await releaseDeps().reloadSite(ctx.site.id);
    if (!r.ok) {
      const error = r.errors.join('; ') || 'erreur inconnue';
      run?.line('warn', `rechargement en échec : ${error}`);
      logger.warn({ siteId: ctx.site.id, errors: r.errors }, 'Release: reloadSite failed');
      return { ok: false, error };
    }
    run?.line('info', 'conteneurs rechargés');
    return { ok: true, error: null };
  } catch (err) {
    const error = (err as Error)?.message ?? String(err);
    run?.line('warn', `rechargement impossible : ${error}`);
    logger.warn({ err, siteId: ctx.site.id }, 'Release: reloadSite failed');
    return { ok: false, error };
  }
}

/**
 * Switches `current` to release `number`, reloads the containers and runs
 * the healthcheck. A container that could not be reloaded keeps serving the
 * PREVIOUS code for a while (php-fpm workers not restarted resolve
 * /srv/releases/current through their realpath cache): its healthcheck would
 * prove nothing, so a failed reload counts as a failed healthcheck. On
 * failure `current` goes back to the previous release (reloaded again) and
 * the error is returned; null = the release is live and healthy.
 */
async function switchAndVerify(ctx: SiteContext, number: number, run: Run): Promise<string | null> {
  const deps = releaseDeps();
  const prevNumber = readCurrent(ctx.paths.releases, deps.links);
  const prevExists = prevNumber !== null && fs.existsSync(path.posix.join(ctx.paths.releases, String(prevNumber)));
  switchCurrent(ctx.paths.releases, number, deps.links);
  await run.step('info', `bascule : current → ${number}`);
  const rl = await reload(ctx, run);
  const hc = rl.ok ? await healthcheck(ctx, run) : { ok: false, error: `rechargement des conteneurs en échec : ${rl.error}` };
  if (hc.ok) return null;
  switchCurrent(ctx.paths.releases, prevExists ? prevNumber : null, deps.links);
  run.line('warn', prevExists ? `retour automatique à la release #${prevNumber}` : 'retour automatique : aucune release précédente');
  await reload(ctx, run);
  return hc.error ?? 'healthcheck en échec';
}

/** A hostd call of the pipeline, retried with backoff while hostd answers busy / cancelled / unavailable. */
async function withHostdRetry<T>(what: string, run: Run | null, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientHostd(err) || attempt >= HOSTD_RETRY_DELAYS_MS.length) throw err;
      const delay = HOSTD_RETRY_DELAYS_MS[attempt];
      run?.line('warn', `${what} : hostd indisponible (${(err as Error).message}), nouvel essai dans ${Math.round(delay / 1000)} s`);
      if (run) await run.save().catch(() => {});
      await releaseDeps().sleep(delay);
    }
  }
}

// ── pipeline ─────────────────────────────────────────────────────────────────

/**
 * Commit of what is LIVE (sites.current_release_id), else of the last ready
 * release, else null (empty tree). The scan and the file stats of a new
 * release are computed against it, never against HEAD: HEAD also moves on
 * failed / rejected / awaiting releases, whose content would otherwise never
 * be scanned again (§9 step 3).
 */
async function liveCommit(ctx: SiteContext): Promise<string | null> {
  const fresh = await db('sites').where({ id: ctx.site.id }).first('current_release_id') as { current_release_id: number | null } | undefined;
  const candidates: Array<{ commit_sha: string | null } | undefined> = [];
  if (fresh?.current_release_id) {
    candidates.push(await db('releases').where({ id: fresh.current_release_id, site_id: ctx.site.id }).first('commit_sha'));
  }
  candidates.push(await db('releases').where({ site_id: ctx.site.id, status: 'ready' }).whereNotNull('commit_sha')
    .orderBy('number', 'desc').first('commit_sha'));
  for (const c of candidates) {
    if (c?.commit_sha && await commitExists(ctx.paths.repo, c.commit_sha)) return c.commit_sha;
  }
  return null;
}

/** Commit + scan. Returns true when the pipeline must continue to deployment. */
async function commitAndScan(run: Run): Promise<boolean> {
  const { ctx, release } = run;
  const dataPaths = dataPathList(ctx);
  await ensureStorageFor(ctx);

  const scan = scanStaging(ctx.paths.staging, dataPaths);
  for (const n of scan.nestedRepos) run.line('warn', `dépôt git imbriqué exclu : ${n}/`);
  if (scan.fileCount === 0) throw new PipelineError('staging vide : publication annulée (un site n’est jamais vidé)');

  // Under the site lock no git process can run on repo.git: locks left by a killed git are stale.
  const stale = clearStaleGitLocks(ctx.paths.repo);
  if (stale.length) run.line('warn', `verrous git orphelins supprimés : ${stale.join(', ')}`);
  const base = await liveCommit(ctx);
  const author = await authorIdentity(release.author_user_id);
  const sha = await commitStaging({
    repoDir: ctx.paths.repo,
    stagingDir: ctx.paths.staging,
    dataPaths,
    nestedRepos: scan.nestedRepos,
    message: release.message?.trim() || `Publication #${release.number}`,
    author,
  });
  const stats = await diffStats(ctx.paths.repo, base, sha);
  release.commit_sha = sha;
  await run.step('info', `commit ${sha.slice(0, 12)} : +${stats.added} ~${stats.modified} -${stats.deleted}`, {
    commit_sha: sha, files_added: stats.added, files_modified: stats.modified, files_deleted: stats.deleted,
  });

  await run.save({ status: 'scanning' });
  const scanner = getScanner();
  const summary = normalizeScan(await scanner.scan({
    siteId: ctx.site.id, accountId: ctx.account.id, stagingDir: ctx.paths.staging, commitSha: sha, changedFiles: stats.changed,
  }));
  return scanGate(run, summary, { approvedBy: null, scanOverrideBy: null, notifyThreat: true });
}

/** P3 (docs/P3-PLAN.md §9.3): `blocked` = risk ≥ blockScore or a ClamAV hit; a P1-style 'infected' verdict counts as blocked. */
function normalizeScan(summary: ScanSummary): ScanSummary {
  const blocked = summary.blocked === true || summary.verdict === 'infected';
  return { ...summary, blocked };
}

function riskText(scan: ScanSummary): string {
  return scan.risk ? `risque ${scan.risk.score} (${scan.risk.level})` : `${scan.findings.length} détection(s)`;
}

/**
 * Scan step of a release (publish and publishCommit). Records the summary and
 * decides: blocked (no staff override) ⇒ awaiting_approval, BLOCKED (only an
 * audited staff override approves it, M5); suspicious or publish mode
 * 'approval' ⇒ awaiting_approval unless the caller's decision is the approval
 * (approvedBy). Returns true when the pipeline goes on to deployment.
 */
async function scanGate(run: Run, scan: ScanSummary, opts: { approvedBy: number | null; scanOverrideBy: number | null; notifyThreat: boolean }): Promise<boolean> {
  const { ctx, release } = run;
  await run.step('info', `analyse (${scan.scanner}) : ${scan.verdict}${scan.risk ? `, ${riskText(scan)}` : ''}`, { scan: JSON.stringify(scan) });
  if (scan.blocked) {
    if (opts.notifyThreat) {
      notify('scan.threat', {
        tenantId: ctx.site.tenant_id, accountId: ctx.account.id, key: `release:${release.id}`, severity: 'critical',
        title: `Publication bloquée : ${ctx.site.name}`,
        message: `La release #${release.number} du site ${ctx.site.name} est bloquée par l’analyse (${riskText(scan)}). Seule une dérogation du staff peut la publier.`,
        link: `/sites/${ctx.site.id}?tab=releases`,
      });
    }
    if (!opts.scanOverrideBy) {
      await run.step('warn', `publication bloquée par l’analyse (${riskText(scan)}) : dérogation du staff requise`, { status: 'awaiting_approval' });
      return false;
    }
    run.line('warn', `analyse bloquante levée par dérogation du staff (utilisateur #${opts.scanOverrideBy})`);
  }
  if (!opts.approvedBy && (scan.verdict === 'suspicious' || ctx.site.publish_mode === 'approval')) {
    const why = scan.verdict === 'suspicious' ? 'contenu suspect' : 'mode approbation';
    await run.step('info', `en attente d’approbation (${why})`, { status: 'awaiting_approval' });
    return false;
  }
  return true;
}

/** Base release for hardlinks: the current one when its tree is on disk. */
async function hardlinkBase(ctx: SiteContext, excludeId: number): Promise<{ number: number; commit: string } | null> {
  const q = db('releases').where({ site_id: ctx.site.id, on_disk: true }).whereNotNull('commit_sha').whereNot({ id: excludeId });
  const row = (ctx.site.current_release_id
    ? await q.clone().where({ id: ctx.site.current_release_id }).first('number', 'commit_sha')
    : null) ?? await q.clone().where({ status: 'ready' }).orderBy('number', 'desc').first('number', 'commit_sha');
  if (!row) return null;
  return fs.existsSync(path.posix.join(ctx.paths.releases, String(row.number))) ? { number: row.number, commit: row.commit_sha } : null;
}

/** Tree on disk + data dirs (hostd). Used by the publication and by rollbacks of pruned releases. */
async function materialize(ctx: SiteContext, release: ReleaseRow, run: Run | null): Promise<void> {
  const deps = releaseDeps();
  if (!release.commit_sha || !(await commitExists(ctx.paths.repo, release.commit_sha))) {
    throw new PipelineError(`commit introuvable pour la release #${release.number}`);
  }
  const dataPaths = dataPathList(ctx);
  const res = await materializeRelease({
    repoDir: ctx.paths.repo,
    releasesDir: ctx.paths.releases,
    number: release.number,
    commit: release.commit_sha,
    dataPaths,
    typedDataPaths: ctx.dataPaths.filter((d) => d.policy === 'typed').map((d) => d.path),
    base: await hardlinkBase(ctx, release.id),
    links: deps.links,
    log: (level, message) => run?.line(level, message),
  });
  await db('releases').where({ id: release.id }).update({ on_disk: true });
  release.on_disk = true;
  run?.line('info', `arbre matérialisé : ${res.files} fichier(s) (${res.linked} lien(s) dur(s)), ${res.symlinks} lien(s) symbolique(s)`);

  if (dataPaths.length) {
    const hostd = deps.hostd(ctx.account.node_id);
    const spec = hostdSpec(ctx);
    try {
      await withHostdRetry('chemins de données', run, () => hostd.ensureDataPaths(spec, dataPaths));
    } catch (err) {
      const message = `chemins de données (hostd) : ${(err as Error).message}`;
      throw isTransientHostd(err) ? new TransientPipelineError(message) : new PipelineError(message);
    }
    for (const d of ctx.dataPaths) {
      try {
        if (d.policy === 'ephemeral') {
          await withHostdRetry(`vidage de ${d.path}`, run, () => hostd.clearDataPaths(spec, [d.path]));
        } else {
          const r = await withHostdRetry(`amorçage de ${d.path}`, run, () => hostd.seedDataPath(spec, d.path));
          if (r.copied) run?.line('info', `données initiales copiées : ${d.path} (${r.files} fichier(s))`);
        }
      } catch (err) {
        run?.line('warn', `${d.policy === 'ephemeral' ? 'vidage' : 'amorçage'} de ${d.path} impossible : ${(err as Error).message}`);
      }
    }
  }
}

/** Steps c–h of a release whose commit (and scan) are done. */
async function deploy(run: Run): Promise<void> {
  const { ctx, release } = run;
  await run.save({ status: 'publishing' });
  await ensureStorageFor(ctx);
  // publishCommit without a precomputed scan materializes first (the scan reads the tree): no second pass.
  const dir = path.posix.join(ctx.paths.releases, String(release.number));
  if (!(release.on_disk && fs.existsSync(dir))) await materialize(ctx, release, run);
  await run.save();

  const failed = await switchAndVerify(ctx, release.number, run);
  if (failed) throw new PipelineError(failed);

  await db.transaction(async (trx) => {
    await trx('releases').where({ id: release.id }).update({ status: 'ready', published_at: trx.fn.now(), error: null });
    await trx('sites').where({ id: ctx.site.id }).update({ current_release_id: release.id, updated_at: trx.fn.now() });
  });
  ctx.site.current_release_id = release.id;
  await run.step('info', `release #${release.number} en ligne`, { status: 'ready' });
  if ((release.trigger === 'window' || release.trigger === 'adapter') && release.commit_sha) await fastForwardHeadTo(run, release.commit_sha);
  if (release.trigger !== 'manual' || release.approved_by) {
    await auditService.log({
      tenantId: ctx.site.tenant_id, userId: release.approved_by ?? release.author_user_id ?? undefined, action: 'release.publish',
      resourceType: 'release', resourcePath: String(release.id),
      details: { siteId: ctx.site.id, number: release.number, trigger: release.trigger, live: true },
    });
  }
}

/**
 * A published candidate (window / adapter) becomes HEAD when HEAD still is its
 * parent (nothing committed from the staging since): the staging, reflected
 * by the caller, then shows no pending change. Otherwise HEAD stays (the next
 * staging commit is a normal commit on top of it). Never throws.
 */
async function fastForwardHeadTo(run: Run, commit: string): Promise<void> {
  try {
    const parent = await parentOf(run.ctx.paths.repo, commit);
    if (!parent) return;
    if (await headCommit(run.ctx.paths.repo) !== parent) {
      run.line('info', 'HEAD du dépôt a bougé depuis la base : non avancé');
      return;
    }
    if (await fastForwardHead(run.ctx.paths.repo, commit, parent)) run.line('info', `HEAD avancé sur ${commit.slice(0, 12)}`);
    await run.save();
  } catch (err) {
    logger.warn({ err, releaseId: run.release.id }, 'Release: cannot fast-forward HEAD');
  }
}

async function fail(run: Run, err: unknown): Promise<void> {
  const message = err instanceof PipelineError ? err.message : `erreur interne : ${(err as Error)?.message ?? String(err)}`;
  if (!(err instanceof PipelineError)) logger.error({ err, releaseId: run.release.id }, 'Release pipeline failed');
  try {
    await run.step('error', message, { status: 'failed', error: message.slice(0, 2000) });
  } catch (e) {
    logger.error({ err: e, releaseId: run.release.id }, 'Release: cannot record the failure');
  }
  await auditService.log({
    tenantId: run.ctx.site.tenant_id, userId: run.release.author_user_id ?? undefined, action: 'release.failed',
    resourceType: 'release', resourcePath: String(run.release.id),
    details: { siteId: run.ctx.site.id, number: run.release.number, error: message.slice(0, 500) },
  });
}

/**
 * Points `current` at the release of sites.current_release_id (null / tree
 * missing → removed), reloading when it changed and doReload. Safety net
 * after an unexpected failure post-switch, and boot / reconcile repair.
 */
async function syncCurrent(ctx: SiteContext, doReload = true): Promise<void> {
  const deps = releaseDeps();
  const fresh = await db('sites').where({ id: ctx.site.id }).first('current_release_id') as { current_release_id: number | null } | undefined;
  const cur = fresh?.current_release_id
    ? await db('releases').where({ id: fresh.current_release_id }).first('number', 'on_disk') as { number: number; on_disk: boolean } | undefined
    : undefined;
  const want = cur && cur.on_disk && fs.existsSync(path.posix.join(ctx.paths.releases, String(cur.number))) ? cur.number : null;
  const have = readCurrent(ctx.paths.releases, deps.links);
  const present = have !== null || fs.existsSync(path.posix.join(ctx.paths.releases, 'current')) || deps.links.isLink(path.posix.join(ctx.paths.releases, 'current'));
  if (have !== want || (want === null && present)) {
    try {
      switchCurrent(ctx.paths.releases, want, deps.links);
      logger.warn({ siteId: ctx.site.id, from: have, to: want }, 'Release: `current` re-pointed to the recorded current release');
      if (doReload) await reload(ctx, null);
    } catch (err) {
      logger.error({ err, siteId: ctx.site.id }, 'Release: cannot restore `current`');
    }
  }
}

/** Background body of publish / approve. Never throws. */
/** Steps of publishCommit before the deployment: stats vs the live release, scan (precomputed or on the materialized tree), gates. */
async function prepareCommit(run: Run, opts: CommitRunOptions): Promise<boolean> {
  const { ctx, release } = run;
  await ensureStorageFor(ctx);
  const sha = release.commit_sha as string;
  if (!(await commitExists(ctx.paths.repo, sha))) throw new PipelineError(`commit candidat introuvable : ${sha.slice(0, 12)}`);
  const base = await liveCommit(ctx);
  const stats = await diffStats(ctx.paths.repo, base, sha);
  await run.step('info', `commit ${sha.slice(0, 12)} : +${stats.added} ~${stats.modified} -${stats.deleted}`, {
    files_added: stats.added, files_modified: stats.modified, files_deleted: stats.deleted,
  });
  let scan: ScanSummary;
  if (opts.scan) {
    scan = normalizeScan(opts.scan);
    run.line('info', 'analyse fournie par l’appelant (fenêtre / adaptateur) : pas de nouvelle analyse');
  } else {
    await run.save({ status: 'scanning' });
    // The candidate is not in the staging: the scanner reads the materialized tree of the release.
    await materialize(ctx, release, run);
    await run.save();
    scan = normalizeScan(await getScanner().scan({
      siteId: ctx.site.id, accountId: ctx.account.id, stagingDir: path.posix.join(ctx.paths.releases, String(release.number)),
      commitSha: sha, changedFiles: stats.changed,
    }));
  }
  if (opts.scanOverrideBy && scan.blocked) {
    scan = { ...scan, override: { by: await userName(opts.scanOverrideBy), at: new Date().toISOString(), reason: opts.overrideReason ?? null } };
  }
  return scanGate(run, scan, { approvedBy: opts.approvedBy, scanOverrideBy: opts.scanOverrideBy, notifyThreat: !opts.scan });
}

interface CommitRunOptions {
  scan: ScanSummary | null;
  approvedBy: number | null;
  scanOverrideBy: number | null;
  overrideReason?: string | null;
}

async function userName(userId: number): Promise<string> {
  const u = await db('users').where({ id: userId }).first('username', 'display_name') as { username: string; display_name: string | null } | undefined;
  return u ? (u.display_name || u.username) : `#${userId}`;
}

async function runInBackground(siteId: number, releaseId: number, phase: 'full' | 'deploy' | 'commit', commitOpts?: CommitRunOptions): Promise<void> {
  let run: Run | null = null;
  try {
    const ctx = await loadContext(siteId);
    const release = await db('releases').where({ id: releaseId }).first() as ReleaseRow;
    run = new Run(ctx, release);
    // Re-checked before any disk write (a teardown also holds the site lock: defense in depth).
    if (siteDeletions.has(siteId) || ctx.account.status === 'deleting') throw new PipelineError('site en cours de suppression : publication annulée');
    if (phase === 'full') {
      await run.step('info', `publication #${release.number} (${release.trigger})`);
      if (!(await commitAndScan(run))) return;
    } else if (phase === 'commit') {
      await run.step('info', `publication #${release.number} (${release.trigger === 'window' ? `fenêtre #${release.window_id ?? '?'}` : `adaptateur, run #${release.adapter_run_id ?? '?'}`})`);
      if (!(await prepareCommit(run, commitOpts ?? { scan: null, approvedBy: null, scanOverrideBy: null }))) return;
    } else {
      await run.step('info', 'reprise après approbation');
    }
    await deploy(run);
  } catch (err) {
    if (run) {
      await fail(run, err);
      await syncCurrent(run.ctx);
      // hostd still busy with another site of the account after the backoff: an AUTO
      // publication is retried later (nothing else re-arms it until the next upload).
      if (err instanceof TransientPipelineError && run.release.trigger === 'auto') {
        try {
          const { publishScheduler } = await import('./publishScheduler');
          publishScheduler.retryAfterTransientFailure(siteId);
        } catch (e) {
          logger.warn({ err: e, siteId }, 'Release: cannot re-arm the auto publication');
        }
      }
    } else {
      logger.error({ err, siteId, releaseId }, 'Release pipeline could not start');
      await db('releases').where({ id: releaseId }).update({ status: 'failed', error: String((err as Error)?.message ?? err).slice(0, 2000) })
        .catch(() => {});
    }
  } finally {
    if (run) {
      try { await prune(run.ctx); } catch (err) { logger.warn({ err, siteId }, 'Release prune failed'); }
    }
    locks.delete(siteId);
  }
}

/** Keeps the `releasesKeep` most recent ready trees + the current one; removes the others. */
async function prune(ctx: SiteContext): Promise<void> {
  const rows = await db('releases').where({ site_id: ctx.site.id, on_disk: true }).orderBy('number', 'desc')
    .select('id', 'number', 'status') as Array<{ id: number; number: number; status: ReleaseStatus }>;
  const site = await db('sites').where({ id: ctx.site.id }).first('current_release_id') as { current_release_id: number | null };
  const keep = new Set<number>();
  if (site?.current_release_id) keep.add(site.current_release_id);
  let kept = 0;
  for (const r of rows) {
    if (r.status === 'ready' && kept < Math.max(1, config.hosting.releasesKeep)) { keep.add(r.id); kept++; }
    // An approved release waiting for its deployment, or one being deployed, keeps its tree.
    if (IN_FLIGHT.includes(r.status)) keep.add(r.id);
  }
  const links = releaseDeps().links;
  const current = readCurrent(ctx.paths.releases, links);
  for (const r of rows) {
    if (keep.has(r.id) || r.number === current) continue;
    // Row first: a half-deleted tree (EBUSY, crash) must never be trusted as
    // on disk by a rollback. Then renamed to <n>.tmp (swept by the disk repair
    // if the removal stops half-way) and removed.
    await db('releases').where({ id: r.id }).update({ on_disk: false });
    const dir = path.posix.join(ctx.paths.releases, String(r.number));
    const doomed = `${dir}.tmp`;
    try {
      if (fs.existsSync(doomed) || links.isLink(doomed)) removeUnder(ctx.paths.releases, doomed);
      if (fs.existsSync(dir) || links.isLink(dir)) fs.renameSync(dir, doomed);
      removeUnder(ctx.paths.releases, doomed);
    } catch (err) {
      logger.warn({ err, siteId: ctx.site.id, number: r.number }, 'Release prune: tree removal failed (swept by the next disk repair)');
    }
  }
}

async function hasInFlight(siteId: number): Promise<boolean> {
  const row = await db('releases').where({ site_id: siteId }).whereIn('status', IN_FLIGHT).first('id');
  return !!row;
}

/** No pipeline on a site (or account) being deleted: its storage is being removed. */
function assertNotDeleting(ctx: SiteContext): void {
  if (siteDeletions.has(ctx.site.id)) throw new AppError(409, 'The site is being deleted', 'siteDeleting');
  if (ctx.account.status === 'deleting') throw new AppError(409, 'The hosting account is being deleted', 'accountDeleting');
}

/**
 * Would a publication only re-deploy what is already live? True when the
 * site's current release is ready, its tree is on disk and pointed to by
 * `current`, its data links match the data paths (a data path added since
 * still needs a publication to get its link), and committing the staging
 * now would give exactly its tree. Any doubt (disk out of sync, git error)
 * → false: publishing is the repair path. Caller holds the site lock.
 */
async function unchangedSinceLive(ctx: SiteContext, nestedRepos: string[]): Promise<boolean> {
  if (!ctx.site.current_release_id) return false;
  const cur = await db('releases').where({ id: ctx.site.current_release_id, site_id: ctx.site.id })
    .first('number', 'status', 'commit_sha', 'on_disk') as Pick<ReleaseRow, 'number' | 'status' | 'commit_sha' | 'on_disk'> | undefined;
  if (!cur || cur.status !== 'ready' || !cur.commit_sha || !cur.on_disk) return false;
  const deps = releaseDeps();
  const dir = path.posix.join(ctx.paths.releases, String(cur.number));
  if (!fs.existsSync(dir) || readCurrent(ctx.paths.releases, deps.links) !== cur.number) return false;
  const dataPaths = dataPathList(ctx);
  const typed = ctx.dataPaths.filter((d) => d.policy === 'typed').map((d) => d.path);
  if (!dataLinksMatch(dir, dataPaths, deps.links) || staleDataExposure(dir, cur.number, dataPaths, typed, deps.links).length > 0) return false;
  try {
    if (!(await commitExists(ctx.paths.repo, cur.commit_sha))) return false;
    const tmpIndex = path.join(os.tmpdir(), `oblimint-same-${ctx.site.id}-${crypto.randomBytes(6).toString('hex')}.index`);
    return await stagingMatchesCommit({
      repoDir: ctx.paths.repo, stagingDir: ctx.paths.staging, dataPaths, nestedRepos, commit: cur.commit_sha, tmpIndex,
    });
  } catch (err) {
    logger.warn({ err, siteId: ctx.site.id }, 'Release: cannot compare the staging with the live release');
    return false;
  }
}

function publishInProgress(): AppError {
  return new AppError(409, 'A publication is already in progress for this site', 'publishInProgress');
}

function windowActiveError(): AppError {
  return new AppError(409, 'A modification window holds this site (decide it first)', 'windowActive');
}

/** P3 §5.3: no publish / approve / rollback / data-path rebuild while a window holds the site. */
async function assertNoWindow(siteId: number): Promise<void> {
  if (await releaseDeps().windowBlocks(siteId, null)) throw windowActiveError();
}

/**
 * P3 (adapters, integration): no staging publish / approval of another release / manual rollback /
 * data-path rebuild while an adapter run of the site is past its publication (publishing, post_deploy:
 * migrations + healthcheck) or deferred awaiting the approval of its own release (its continuation runs
 * the migrations once that release is live): the update would be dropped from the live site, possibly
 * after its migrations ran. 409 adapterBusy; the auto-publish scheduler retries later. `exemptRunId`:
 * the run whose own release is being approved. The run's own revertTo is not guarded (rollbackTo).
 */
async function assertNoAdapterRun(siteId: number, exemptRunId: number | null = null): Promise<void> {
  const q = db('adapter_runs').where({ site_id: siteId }).where((w) => {
    w.whereIn('status', ['publishing', 'post_deploy'])
      .orWhere((d) => d.where('status', 'awaiting_approval').whereRaw("analysis -> 'pendingReflect' is not null"));
  });
  if (exemptRunId !== null) q.whereNot('id', exemptRunId);
  const row = await q.first('id');
  if (row) throw new AppError(409, 'An application update is being published on this site (adapter run in progress)', 'adapterBusy');
}

/** detectAppProfile helper: does `rel` exist under root, no component being a symlink (R1)? */
export function existsNoFollow(root: string, rel: string): boolean {
  const norm = normalizeRelPath(rel);
  if (norm === null) return false;
  let cur = root;
  for (const seg of norm.split('/')) {
    cur = path.join(cur, seg);
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// ── public service ───────────────────────────────────────────────────────────

export const releaseService = {
  /** Idempotent: repo.git (bare, hooks disabled), releases/, runtime/ of a site. Called by the reconcile. */
  async ensureSiteStorage(siteId: number): Promise<void> {
    const ctx = await loadContext(siteId);
    // Never recreate the storage of a site / account being torn down (root-owned orphan trees).
    if (siteDeletions.has(siteId) || ctx.account.status === 'deleting') return;
    await ensureStorageFor(ctx);
    // Disk repair only when no pipeline / rollback runs (taking the lock keeps one from starting meanwhile;
    // an auto publish hitting it gets publishInProgress and is rescheduled). No reload: the reconcile converges containers.
    if (locks.has(siteId)) return;
    locks.add(siteId);
    try {
      if (!(await hasInFlight(siteId))) await repairSiteDisk(ctx, false);
    } finally {
      locks.delete(siteId);
    }
  },

  /** Deletes repo.git + releases/ + runtime/ of a site (destroySite). */
  async removeSiteStorage(accountId: number, siteId: number): Promise<void> {
    const siteDir = localPaths.site(accountId, siteId);
    for (const p of [localPaths.repo(accountId, siteId), localPaths.releases(accountId, siteId), localPaths.runtime(accountId, siteId)]) {
      removeUnder(siteDir, p);
    }
    try { fs.rmdirSync(siteDir); } catch { /* not empty / absent: hostd owns the rest */ }
  },

  /**
   * Site / account deletion: takes the pipeline lock of these sites for the
   * whole teardown, so no publication / rollback / rebuild runs (or starts)
   * while repo.git and releases/ are removed — a running pipeline would
   * recreate them as root-owned orphans. 409 publishInProgress when one runs.
   * Returns the function releasing the locks (call it in a finally).
   */
  async lockForTeardown(siteIds: number[]): Promise<() => void> {
    const ids = [...new Set(siteIds)];
    if (ids.some((id) => locks.has(id))) throw publishInProgress();
    for (const id of ids) locks.add(id);
    const release = (): void => { for (const id of ids) locks.delete(id); };
    try {
      for (const id of ids) if (await hasInFlight(id)) throw publishInProgress();
    } catch (err) {
      release();
      throw err;
    }
    return release;
  },

  /**
   * A data path change (sites.service: update / delete) that the LIVE tree
   * must follow BEFORE the new web-server rules apply: a deleted data path
   * keeps its link `<p> → /srv/data/<p>` in releases/<current>, and would be
   * served with the code rules (.htaccess honored, PHP executed); a path
   * becoming `typed` keeps the code symlinks into it (whitelist bypassed).
   *
   * Under the site lock: when the current tree conflicts with `next`
   * (staleDataExposure), the current commit is re-materialized as a NEW
   * release with the links of `next`, switched, reloaded and healthchecked;
   * only then `apply()` commits the DB change (the reconcile renders the new
   * rules after it). Until then the old rules stay, which are stricter for
   * the new tree. Any failure: the old tree is live again, nothing is
   * applied, 502 releaseRebuildFailed. No conflict (or nothing published):
   * apply() only.
   */
  async applyDataPathChange(siteId: number, opts: {
    next: Array<Pick<DataPathRow, 'path' | 'policy'>>;
    userId: number | null;
    apply: () => Promise<void>;
  }): Promise<{ rebuiltReleaseId: number | null }> {
    const ctx = await loadContext(siteId);
    assertNotDeleting(ctx);
    if (locks.has(siteId)) throw publishInProgress();
    locks.add(siteId);
    try {
      if (await hasInFlight(siteId)) throw publishInProgress();
      await assertNoWindow(siteId);
      await assertNoAdapterRun(siteId);
      const deps = releaseDeps();
      const next = opts.next.filter((d) => normalizeRelPath(d.path) === d.path && dataPathForbiddenError(d.path) === null);
      const nextPaths = next.map((d) => d.path);
      const nextTyped = next.filter((d) => d.policy === 'typed').map((d) => d.path);

      const cur = ctx.site.current_release_id
        ? await db('releases').where({ id: ctx.site.current_release_id, site_id: siteId }).first() as ReleaseRow | undefined
        : undefined;
      const dir = cur ? path.posix.join(ctx.paths.releases, String(cur.number)) : null;
      const live = !!cur && !!cur.commit_sha && !!dir && fs.existsSync(dir) && readCurrent(ctx.paths.releases, deps.links) === cur.number;
      const reasons = live ? staleDataExposure(dir as string, (cur as ReleaseRow).number, nextPaths, nextTyped, deps.links) : [];
      if (!reasons.length) {
        await opts.apply();
        return { rebuiltReleaseId: null };
      }
      const source = cur as ReleaseRow;

      const nextCtx: SiteContext = {
        ...ctx,
        dataPaths: next.map((d) => ({ ...(ctx.dataPaths.find((x) => x.path === d.path) ?? {}), path: d.path, policy: d.policy }) as DataPathRow),
      };
      const id = await db.transaction(async (trx) => {
        await trx('sites').where({ id: siteId }).forUpdate().first('id');
        const max = await trx('releases').where({ site_id: siteId }).max('number as n').first() as { n: number | null } | undefined;
        const [row] = await trx('releases').insert({
          site_id: siteId,
          number: Number(max?.n ?? 0) + 1,
          status: 'publishing',
          trigger: 'manual',
          message: `Reconstruction de la release #${source.number} (chemins de données modifiés)`,
          author_user_id: opts.userId,
          commit_sha: source.commit_sha,
          log: JSON.stringify([]),
          on_disk: false,
        }).returning('id');
        return Number(typeof row === 'object' ? row.id : row);
      });
      const release = await fetchRelease(siteId, id);
      emitHosting(HostingSocketEvents.RELEASE_UPDATED, { siteId, releaseId: id, status: 'publishing' }, { tenantId: ctx.site.tenant_id, accountId: ctx.account.id });
      const run = new Run(nextCtx, release);
      try {
        await run.step('info', `reconstruction de la release #${source.number} : ${reasons.join(' ; ')}`);
        await ensureStorageFor(nextCtx);
        await materialize(nextCtx, release, run);
        await run.save();
        // Containers not serving (site stopped, account suspended): nothing to reload nor probe.
        const serving = ctx.site.status !== 'stopped' && ctx.account.status !== 'suspended';
        if (serving) {
          const failed = await switchAndVerify(nextCtx, release.number, run);
          if (failed) throw new PipelineError(failed);
        } else {
          switchCurrent(ctx.paths.releases, release.number, deps.links);
          await run.step('info', `bascule : current → ${release.number} (site arrêté : sans healthcheck)`);
        }
        await opts.apply();
        await db.transaction(async (trx) => {
          await trx('releases').where({ id: release.id }).update({ status: 'ready', published_at: trx.fn.now(), error: null });
          await trx('sites').where({ id: siteId }).update({ current_release_id: release.id, updated_at: trx.fn.now() });
        });
        ctx.site.current_release_id = release.id;
        await run.step('info', `release #${release.number} en ligne`, { status: 'ready' });
        await auditService.log({
          tenantId: ctx.site.tenant_id, userId: opts.userId ?? undefined, action: 'release.rebuild',
          resourceType: 'release', resourcePath: String(release.id),
          details: { siteId, number: release.number, from: source.number, reasons },
        });
        return { rebuiltReleaseId: release.id };
      } catch (err) {
        await fail(run, err);
        // `current` back on the recorded current release (apply() failing after the switch).
        await syncCurrent(ctx);
        if (err instanceof AppError) throw err;
        throw new AppError(502, `The live release could not be rebuilt with the new data paths: ${(err as Error)?.message ?? String(err)}`, 'releaseRebuildFailed');
      }
    } finally {
      try { await prune(ctx); } catch (err) { logger.warn({ err, siteId }, 'Release prune failed'); }
      locks.delete(siteId);
    }
  },

  /** Creates the release row (queued) and runs the pipeline in the background. 409 when one is in flight. */
  async publish(siteId: number, opts: PublishOptions): Promise<Release> {
    const ctx = await loadContext(siteId);
    assertNotDeleting(ctx);
    if (ctx.account.status === 'suspended') throw new AppError(409, 'The hosting account is suspended', 'accountSuspended');
    if (locks.has(siteId)) throw publishInProgress();
    locks.add(siteId);
    let started = false;
    try {
      if (await hasInFlight(siteId)) throw publishInProgress();
      await assertNoWindow(siteId);
      await assertNoAdapterRun(siteId);
      const scan = scanStaging(ctx.paths.staging, dataPathList(ctx));
      if (scan.fileCount === 0) {
        throw new AppError(409, 'The staging directory of this site is empty', 'stagingEmpty');
      }
      // Same tree as the live release: no empty 'ready' release (nothing would change on line).
      if (await unchangedSinceLive(ctx, scan.nestedRepos)) {
        throw new AppError(409, 'Nothing changed in the staging since the live release', 'noChanges');
      }
      const message = opts.message?.trim() ? opts.message.trim().slice(0, 2000) : null;
      const id = await db.transaction(async (trx) => {
        await trx('sites').where({ id: siteId }).forUpdate().first('id');
        const max = await trx('releases').where({ site_id: siteId }).max('number as n').first() as { n: number | null } | undefined;
        const [row] = await trx('releases').insert({
          site_id: siteId,
          number: Number(max?.n ?? 0) + 1,
          status: 'queued',
          trigger: opts.trigger,
          message,
          author_user_id: opts.userId,
          log: JSON.stringify([]),
          on_disk: false,
        }).returning('id');
        return Number(typeof row === 'object' ? row.id : row);
      });
      const row = await fetchRelease(siteId, id);
      emitHosting(HostingSocketEvents.RELEASE_UPDATED, { siteId, releaseId: id, status: 'queued' }, { tenantId: ctx.site.tenant_id, accountId: ctx.account.id });
      started = true;
      void runInBackground(siteId, id, 'full');
      return toRelease(row);
    } finally {
      if (!started) locks.delete(siteId);
    }
  },

  /**
   * Approves a release awaiting approval. A release whose scan is BLOCKED
   * (risk ≥ blockScore or ClamAV, M5) needs `override` — the caller (route)
   * has checked it is a staff member holding releases.approve and audits it
   * ('release.approve.override'); the override is recorded in scan.override
   * and releases.scan_override_by/at. 409 riskBlocked {score, level} without.
   */
  async approve(siteId: number, releaseId: number, userId: number, opts: { override?: { reason: string | null } | null } = {}): Promise<Release> {
    const ctx = await loadContext(siteId);
    const row = await fetchRelease(siteId, releaseId);
    if (row.status !== 'awaiting_approval') throw new AppError(409, 'This release is not awaiting approval', 'releaseNotAwaitingApproval');
    assertNotDeleting(ctx);
    if (ctx.account.status === 'suspended') throw new AppError(409, 'The hosting account is suspended', 'accountSuspended');
    // A window's release is decided through its window (validate / reject), never approved on its own: a
    // rejected / re-reviewed window must not go live through a leftover release (docs/P3-PLAN.md §5, M5).
    if (row.window_id) {
      const w = await db('maintenance_windows').where({ id: row.window_id, site_id: siteId }).first('status') as { status: string } | undefined;
      if (!w || w.status !== 'validating') {
        throw new AppError(409, 'This release belongs to a modification window: decide the window instead', 'releaseNotAwaitingApproval');
      }
    }
    const scan = json<ScanSummary | null>(row.scan, null);
    const blocked = !!scan && (scan.blocked === true || scan.verdict === 'infected');
    if (blocked && !opts.override) {
      throw new AppError(409, 'The scan of this release blocks its publication (staff override required)', 'riskBlocked', {
        score: scan?.risk?.score ?? 100, level: scan?.risk?.level ?? 'critical',
      });
    }
    if (locks.has(siteId)) throw publishInProgress();
    locks.add(siteId);
    let started = false;
    try {
      if (await hasInFlight(siteId)) throw publishInProgress();
      await assertNoWindow(siteId);
      await assertNoAdapterRun(siteId, row.adapter_run_id ? Number(row.adapter_run_id) : null);
      // Approving an older release would silently replace newer published content.
      // A rebuild of OLDER content (data paths changed: same commit as an older ready release) brings nothing newer.
      const newer = await db('releases as n').where({ 'n.site_id': siteId, 'n.status': 'ready' }).where('n.number', '>', row.number)
        .whereNotExists(db('releases as o').whereRaw('o.site_id = n.site_id').where('o.status', 'ready').where('o.number', '<', row.number)
          .whereRaw('o.commit_sha = n.commit_sha'))
        .first('n.id');
      if (newer) throw new AppError(409, 'A newer release has already been published', 'releaseSuperseded');
      const patch: Record<string, unknown> = { approved_by: userId, approved_at: db.fn.now(), status: 'publishing', updated_at: db.fn.now() };
      if (blocked && scan && opts.override) {
        patch.scan = JSON.stringify({ ...scan, blocked: true, override: { by: await userName(userId), at: new Date().toISOString(), reason: opts.override.reason ?? null } });
        patch.scan_override_by = userId;
        patch.scan_override_at = db.fn.now();
      }
      const n = await db('releases').where({ id: releaseId, status: 'awaiting_approval' }).update(patch);
      if (!n) throw new AppError(409, 'This release is not awaiting approval', 'releaseNotAwaitingApproval');
      started = true;
      void runInBackground(siteId, releaseId, 'deploy');
      return toRelease(await fetchRelease(siteId, releaseId));
    } finally {
      if (!started) locks.delete(siteId);
    }
  },

  async reject(siteId: number, releaseId: number, userId: number, reason?: string | null): Promise<Release> {
    const ctx = await loadContext(siteId);
    const row = await fetchRelease(siteId, releaseId);
    if (row.status !== 'awaiting_approval') throw new AppError(409, 'This release is not awaiting approval', 'releaseNotAwaitingApproval');
    const run = new Run(ctx, row);
    const why = reason?.trim() ? reason.trim().slice(0, 500) : null;
    run.line('warn', `rejetée par l’utilisateur #${userId}${why ? ` : ${why}` : ''}`);
    const n = await db('releases').where({ id: releaseId, status: 'awaiting_approval' })
      .update({ status: 'rejected', error: why, updated_at: db.fn.now() });
    if (!n) throw new AppError(409, 'This release is not awaiting approval', 'releaseNotAwaitingApproval');
    await run.save({ status: 'rejected' });
    return toRelease(await fetchRelease(siteId, releaseId));
  },

  /**
   * Internal (module windows): a release left awaiting approval is rejected
   * (no user). false when it was not awaiting approval any more.
   */
  async dismissAwaiting(siteId: number, releaseId: number, reason: string): Promise<boolean> {
    const ctx = await loadContext(siteId);
    const row = await fetchRelease(siteId, releaseId);
    if (row.status !== 'awaiting_approval') return false;
    const run = new Run(ctx, row);
    const why = reason.trim().slice(0, 500) || 'écartée';
    run.line('warn', `écartée automatiquement : ${why}`);
    const n = await db('releases').where({ id: releaseId, status: 'awaiting_approval' })
      .update({ status: 'rejected', error: why, updated_at: db.fn.now() });
    if (!n) return false;
    await run.save({ status: 'rejected' });
    return true;
  },

  /** Makes an older READY release current again (re-materialized from git when pruned). */
  async rollback(siteId: number, releaseId: number, userId: number): Promise<void> {
    await assertNoAdapterRun(siteId);
    await rollbackTo(siteId, releaseId, { userId, reason: null });
  },

  // ── P3 (docs/P3-PLAN.md §6.4) — module `windows` ──

  /**
   * Publishes an EXISTING commit (candidate of a window / an adapter run)
   * through the normal pipeline: release row (trigger window | adapter,
   * window_id / adapter_run_id), scan step skipped when opts.scan is given,
   * approval gate skipped when opts.approvedBy, then materialize → data links
   * → switch → reload → healthcheck → auto-rollback, HEAD fast-forwarded to
   * the commit when it still points at its parent. 409 publishInProgress /
   * windowActive (another window) / windowBaseChanged (base no longer live).
   * Returns the queued row at once (background run, RELEASE_UPDATED events).
   */
  async publishCommit(siteId: number, opts: PublishCommitOptions): Promise<Release> {
    const ctx = await loadContext(siteId);
    assertNotDeleting(ctx);
    if (ctx.account.status === 'suspended') throw new AppError(409, 'The hosting account is suspended', 'accountSuspended');
    if (!/^[0-9a-f]{40,64}$/.test(opts.commitSha)) throw new AppError(409, 'Candidate commit not found', 'candidateNotFound');
    if (locks.has(siteId)) throw publishInProgress();
    locks.add(siteId);
    let started = false;
    try {
      if (await hasInFlight(siteId)) throw publishInProgress();
      const exempt = opts.trigger === 'window' ? opts.windowId ?? null : null;
      if (await releaseDeps().windowBlocks(siteId, exempt)) throw windowActiveError();
      const fresh = await db('sites').where({ id: siteId }).first('current_release_id') as { current_release_id: number | null } | undefined;
      if (opts.baseReleaseId !== null && (fresh?.current_release_id ?? null) !== opts.baseReleaseId) {
        throw opts.trigger === 'window'
          ? new AppError(409, 'The base release of this window is no longer the live one', 'windowBaseChanged')
          : new AppError(409, 'A newer release has already been published', 'releaseSuperseded');
      }
      await ensureStorageFor(ctx);
      if (!(await commitExists(ctx.paths.repo, opts.commitSha))) throw new AppError(409, 'Candidate commit not found', 'candidateNotFound');
      const message = opts.message?.trim() ? opts.message.trim().slice(0, 2000) : null;
      const id = await db.transaction(async (trx) => {
        await trx('sites').where({ id: siteId }).forUpdate().first('id');
        const max = await trx('releases').where({ site_id: siteId }).max('number as n').first() as { n: number | null } | undefined;
        const [row] = await trx('releases').insert({
          site_id: siteId,
          number: Number(max?.n ?? 0) + 1,
          status: 'queued',
          trigger: opts.trigger,
          message,
          author_user_id: opts.userId,
          commit_sha: opts.commitSha,
          window_id: opts.trigger === 'window' ? opts.windowId ?? null : null,
          adapter_run_id: opts.trigger === 'adapter' ? opts.adapterRunId ?? null : null,
          approved_by: opts.approvedBy ?? null,
          approved_at: opts.approvedBy ? trx.fn.now() : null,
          scan_override_by: opts.scanOverrideBy ?? null,
          scan_override_at: opts.scanOverrideBy ? trx.fn.now() : null,
          log: JSON.stringify([]),
          on_disk: false,
        }).returning('id');
        return Number(typeof row === 'object' ? row.id : row);
      });
      const row = await fetchRelease(siteId, id);
      emitHosting(HostingSocketEvents.RELEASE_UPDATED, { siteId, releaseId: id, status: 'queued' }, { tenantId: ctx.site.tenant_id, accountId: ctx.account.id });
      started = true;
      void runInBackground(siteId, id, 'commit', {
        scan: opts.scan, approvedBy: opts.approvedBy ?? null, scanOverrideBy: opts.scanOverrideBy ?? null,
      });
      return toRelease(row);
    } finally {
      if (!started) locks.delete(siteId);
    }
  },

  /** Resolves when the release reaches ready / failed / rejected / awaiting_approval (or the timeout: current row). */
  async waitForRelease(siteId: number, releaseId: number, timeoutMs: number): Promise<Release> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let settledAt: number | null = null;
    for (;;) {
      const row = await fetchRelease(siteId, releaseId);
      const settled = !IN_FLIGHT.includes(row.status);
      if (settled && settledAt === null) settledAt = Date.now();
      // A terminal status is final, but the run still holds the site lock while it prunes: the caller's
      // next step (revertTo, reopening a window) would get publishInProgress. Wait for it (bounded).
      const lockFree = !locks.has(siteId) || (settledAt !== null && Date.now() - settledAt > WAIT_LOCK_GRACE_MS);
      if ((settled && lockFree) || Date.now() >= deadline) return toRelease(row);
      await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
    }
  },

  /** Internal rollback (adapter post-deploy failure): same as rollback() without a user, `reason` logged and audited. */
  async revertTo(siteId: number, releaseId: number, reason: string): Promise<void> {
    await rollbackTo(siteId, releaseId, { userId: null, reason: reason.trim().slice(0, 500) || 'retour automatique' });
    const site = await db('sites').where({ id: siteId }).first('tenant_id') as { tenant_id: number } | undefined;
    if (site) {
      await auditService.log({
        tenantId: site.tenant_id, action: 'release.revert', resourceType: 'release', resourcePath: String(releaseId),
        details: { siteId, reason },
      });
    }
  },

  /** A pipeline / rollback runs (or is recorded in flight) for the site. */
  async pipelineBusy(siteId: number): Promise<boolean> {
    return locks.has(siteId) || await hasInFlight(siteId);
  },

  /**
   * Runs `fn` while holding the pipeline lock of the site (no publication can
   * start meanwhile); 409 publishInProgress when a pipeline runs. Used by the
   * windows module to create its row atomically with respect to publications.
   */
  async reserve<T>(siteId: number, fn: () => Promise<T>): Promise<T> {
    if (locks.has(siteId)) throw publishInProgress();
    locks.add(siteId);
    try {
      if (await hasInFlight(siteId)) throw publishInProgress();
      return await fn();
    } finally {
      locks.delete(siteId);
    }
  },

  async list(siteId: number, opts: { limit: number; offset: number }): Promise<{ items: Release[]; total: number }> {
    const limit = Math.min(100, Math.max(1, Math.trunc(opts.limit) || 20));
    const offset = Math.max(0, Math.trunc(opts.offset) || 0);
    const [rows, count] = await Promise.all([
      releaseQuery().where('r.site_id', siteId).orderBy('r.number', 'desc').limit(limit).offset(offset) as Promise<ReleaseRow[]>,
      db('releases').where({ site_id: siteId }).count<{ n: string }[]>('* as n'),
    ]);
    return { items: rows.map(toRelease), total: Number(count[0]?.n ?? 0) };
  },

  async get(siteId: number, releaseId: number): Promise<ReleaseDetail> {
    return toReleaseDetail(await fetchRelease(siteId, releaseId));
  },

  /** against: a release id, 'previous' (default) or 'empty'; file: one file's full patch. */
  async diff(siteId: number, releaseId: number, against: number | 'previous' | 'empty', file?: string | null): Promise<ReleaseDiff> {
    const ctx = await loadContext(siteId);
    const to = await fetchRelease(siteId, releaseId);
    if (!to.commit_sha) throw new AppError(409, 'This release has no commit yet', 'releaseNotReady');
    let fromId: number | null = null;
    let fromCommit: string | null = null;
    if (against === 'previous') {
      const prev = await db('releases').where({ site_id: siteId, status: 'ready' }).where('number', '<', to.number)
        .whereNotNull('commit_sha').orderBy('number', 'desc').first('id', 'commit_sha') as { id: number; commit_sha: string } | undefined;
      if (prev) { fromId = prev.id; fromCommit = prev.commit_sha; }
    } else if (typeof against === 'number') {
      const other = await db('releases').where({ id: against, site_id: siteId }).first('id', 'commit_sha') as { id: number; commit_sha: string | null } | undefined;
      if (!other) throw new AppError(404, 'Release not found', 'notFound');
      if (!other.commit_sha) throw new AppError(409, 'This release has no commit yet', 'releaseNotReady');
      fromId = other.id;
      fromCommit = other.commit_sha;
    }
    const repo = ctx.paths.repo;
    const fromRef = fromCommit ?? EMPTY_TREE;
    const [names, nums] = await Promise.all([diffNameStatus(repo, fromRef, to.commit_sha, true), diffNumstat(repo, fromRef, to.commit_sha)]);
    const numByPath = new Map(nums.map((n) => [n.path, n]));
    let files: ReleaseDiffFile[] = names.map((e) => {
      const n = numByPath.get(e.path);
      return {
        path: e.path, oldPath: e.oldPath, status: e.status,
        additions: n?.additions ?? 0, deletions: n?.deletions ?? 0, binary: n?.binary ?? false,
        patch: null, patchTruncated: false,
      };
    });
    const totalFiles = files.length;
    const truncated = totalFiles > DIFF_FILES_CAP;
    if (truncated) files = files.slice(0, DIFF_FILES_CAP);

    if (file) {
      const target = files.find((x) => x.path === file);
      if (!target) throw new AppError(404, 'File not in this diff', 'notFound');
      files = [target];
      if (!target.binary) {
        const p = await filePatch(repo, fromRef, to.commit_sha, target.path, target.oldPath, PATCH_FILE_CAP);
        target.patch = p.patch;
        target.patchTruncated = p.truncated;
      }
    } else if (files.length <= AUTO_PATCH_MAX_FILES) {
      for (const f of files) {
        if (f.binary) continue;
        const p = await filePatch(repo, fromRef, to.commit_sha, f.path, f.oldPath, AUTO_PATCH_MAX_BYTES + 1);
        if (!p.truncated && p.patch.length <= AUTO_PATCH_MAX_BYTES) f.patch = p.patch;
        else f.patchTruncated = true;
      }
    }
    return { fromReleaseId: fromId, toReleaseId: to.id, fromCommit, toCommit: to.commit_sha, files, totalFiles, truncated };
  },

  async stagingStatus(siteId: number): Promise<StagingStatus> {
    const ctx = await loadContext(siteId);
    const { publishScheduler } = await import('./publishScheduler');
    const lastUpload = publishScheduler.lastChange(siteId);
    const deadline = publishScheduler.deadline(siteId);
    const base: StagingStatus = {
      siteId, pendingChanges: 0, files: [], truncated: false,
      lastUploadAt: lastUpload ? lastUpload.toISOString() : null,
      autoPublishAt: deadline ? deadline.toISOString() : null,
      warnings: [],
      warningItems: [],
    };
    if (!fs.existsSync(ctx.paths.staging)) {
      base.warnings.push('dossier de staging absent');
      base.warningItems.push({ code: 'stagingMissing' });
      return base;
    }
    const dataPaths = dataPathList(ctx);
    const scan = scanStaging(ctx.paths.staging, dataPaths, 50_000);
    for (const n of scan.nestedRepos) {
      base.warnings.push(`dépôt git imbriqué (exclu des publications) : ${n}/`);
      base.warningItems.push({ code: 'nestedRepo', path: `${n}/` });
    }
    for (const s of scan.symlinks.slice(0, 20)) {
      base.warnings.push(`lien symbolique : ${s}`);
      base.warningItems.push({ code: 'symlink', path: s });
    }
    if (scan.symlinks.length > 20) {
      base.warnings.push(`… et ${scan.symlinks.length - 20} autre(s) lien(s) symbolique(s)`);
      base.warningItems.push({ code: 'moreSymlinks', count: scan.symlinks.length - 20 });
    }
    // A site / account being deleted: no storage recreated behind the teardown.
    if (siteDeletions.has(siteId) || ctx.account.status === 'deleting') return base;
    await ensureStorageFor(ctx);
    const tmpIndex = path.join(os.tmpdir(), `oblimint-status-${siteId}-${crypto.randomBytes(6).toString('hex')}.index`);
    const changes = await stagingChanges(ctx.paths.repo, ctx.paths.staging, dataPaths, scan.nestedRepos, tmpIndex, !locks.has(siteId));
    base.pendingChanges = changes.length;
    base.truncated = changes.length > STAGING_FILES_CAP;
    base.files = changes.slice(0, STAGING_FILES_CAP);
    return base;
  },

  /** detectAppProfile (shared) over the staging of the site (no symlink followed). */
  async detectProfile(siteId: number): Promise<ProfileDetection> {
    const ctx = await loadContext(siteId);
    return detectAppProfile((rel) => existsNoFollow(ctx.paths.staging, rel));
  },

  /**
   * Boot: releases left in queued/scanning/publishing by a crash → failed;
   * then, for every site, disk repair (stale git locks, *.tmp, `current`
   * re-pointed to sites.current_release_id — a crash between the switch and
   * the healthcheck, or during a rollback, leaves it on an unverified release).
   */
  async recoverInterrupted(): Promise<void> {
    const rows = await db('releases').whereIn('status', IN_FLIGHT).select('id', 'log') as Array<{ id: number; log: unknown }>;
    for (const r of rows) {
      const log = json<ReleaseLogLine[]>(r.log, []);
      log.push({ at: new Date().toISOString(), level: 'error', message: 'interrompue par un redémarrage' });
      await db('releases').where({ id: r.id }).whereIn('status', IN_FLIGHT).update({
        status: 'failed', error: 'interrompue par un redémarrage', log: JSON.stringify(log.slice(-LOG_CAP)), updated_at: db.fn.now(),
      });
    }
    if (rows.length) logger.warn({ count: rows.length }, 'Releases interrupted by a restart marked as failed');

    const sites = await db('sites').select('id') as Array<{ id: number }>;
    for (const { id } of sites) {
      if (locks.has(id)) continue; // a pipeline already started in this process
      locks.add(id);
      try {
        const ctx = await loadContext(id);
        if (!fs.existsSync(ctx.paths.site)) continue;
        await repairSiteDisk(ctx, true);
      } catch (err) {
        logger.warn({ err, siteId: id }, 'Release: boot disk repair failed');
      } finally {
        locks.delete(id);
      }
    }
  },
};

/** Body of rollback() / revertTo(): makes an older READY release current again. */
async function rollbackTo(siteId: number, releaseId: number, who: { userId: number | null; reason: string | null }): Promise<void> {
  const ctx = await loadContext(siteId);
  const target = await fetchRelease(siteId, releaseId);
  if (target.status !== 'ready') throw new AppError(409, 'Only a published release can be restored', 'releaseNotReady');
  const deps = releaseDeps();
  // Current only when the DB AND releases/current agree: a disk out of sync (crash) stays repairable from the UI.
  if (ctx.site.current_release_id === target.id && readCurrent(ctx.paths.releases, deps.links) === target.number) {
    throw new AppError(409, 'This release is already the current one', 'releaseIsCurrent');
  }
  assertNotDeleting(ctx);
  if (ctx.account.status === 'suspended') throw new AppError(409, 'The hosting account is suspended', 'accountSuspended');
  if (locks.has(siteId)) throw publishInProgress();
  locks.add(siteId);
  const run = new Run(ctx, target);
  try {
    if (await hasInFlight(siteId)) throw publishInProgress();
    await assertNoWindow(siteId);
    await ensureStorageFor(ctx);
    run.line('info', who.userId ? `restauration demandée par l’utilisateur #${who.userId}` : `retour automatique : ${who.reason ?? 'sans motif'}`);
    const dir = path.posix.join(ctx.paths.releases, String(target.number));
    const onDisk = target.on_disk && fs.existsSync(dir);
    const typed = ctx.dataPaths.filter((d) => d.policy === 'typed').map((d) => d.path);
    const staleLinks = onDisk && (!dataLinksMatch(dir, dataPathList(ctx), deps.links)
      || staleDataExposure(dir, target.number, dataPathList(ctx), typed, deps.links).length > 0);
    if (staleLinks) run.line('info', 'liens de données obsolètes (chemins de données modifiés) : arbre reconstruit');
    if (!onDisk || staleLinks) {
      try {
        await materialize(ctx, target, run);
      } catch (err) {
        await run.save();
        if (err instanceof PipelineError) throw new AppError(502, err.message, 'backendUnavailable');
        throw err;
      }
    }
    const failed = await switchAndVerify(ctx, target.number, run);
    if (failed) {
      run.line('error', `restauration annulée (${failed})`);
      await run.save();
      throw new AppError(502, failed, 'rollbackHealthcheckFailed');
    }
    await db('sites').where({ id: siteId }).update({ current_release_id: target.id, updated_at: db.fn.now() });
    ctx.site.current_release_id = target.id;
    run.line('info', `release #${target.number} restaurée`);
    await run.save({ status: 'ready' });
  } finally {
    try { await prune(ctx); } catch (err) { logger.warn({ err, siteId }, 'Release prune failed'); }
    locks.delete(siteId);
  }
}

/** Tests only: in-process lock state. */
export const __releaseInternals = { locks, prune: (siteId: number) => loadContext(siteId).then(prune) };
