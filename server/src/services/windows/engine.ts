import fs from 'fs';
import path from 'path';
import type {
  AutoValidationResult, ChangeAnalysisSummary, ChecksumReport, DataPathPolicy, MaintenanceWindow, ReleaseLogLine, ScanSummary,
  SiteMaintenanceSettings, WindowChangeCounts, WindowCloseReason, WindowStatus, WindowTrigger,
} from '@oblimint/shared';
import { HostingSocketEvents, normalizeRelPath, riskLevelOf, WINDOW_ACTIVE_STATUSES } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { siteDeletions } from '../hosting/deletions';
import { emitHosting } from '../hosting/events';
import { dataPathForbiddenError } from '../hosting/hostingValidation.service';
import { localPaths } from '../hosting/paths';
import type { SiteRow } from '../hosting/rows';
import type { HostdSiteSpec } from '../hostd/client';
import {
  localContentTree, type AnalysisDataPath, type ChangeAnalysis, type ChangedPath, type ChecksumVerification, type FileAnalysis,
} from '../maintenance/contracts';
import { classifyChanges } from '../releases/candidate';
import { releaseService } from '../releases/release.service';
import { windowDeps } from './deps';
import { mergeSettings } from './settings';
import { json, manifestChanges, readManifest, toWindow, windowQuery, withDetail, type WindowRow } from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle engine of the modification windows (docs/P3-PLAN.md §5). No
// access check here (window.service.ts checks, or the caller is internal:
// scheduler, API token, supervised mode).
//
//   opening → open → closing → analyzing ─┬─► pending_review ─► validating ─► validated
//                                         ├─► (auto) validating ─► validated
//                                         └─► discarded (no change)
//   pending_review ─► rejecting ─► rejected ;  any step ─► failed (overlay repaired)
//
// Every transition is a conditional UPDATE on the current status (the DB is
// the source of truth; the partial unique index keeps one non-final window
// per site); long steps (snapshots, mount, export, analysis, publication,
// unmount) run in the background, tracked for the tests (idle()).
// M2: the overlay is mounted rw ONLY for an 'open' window; closing freezes it
// (ro) first; recovery never remounts rw a window that is not open.
// ─────────────────────────────────────────────────────────────────────────────

const LOG_CAP = 500;
/** Export limits handed to hostd (files above maxFileBytes are listed, not copied → tooLarge). */
export const EXPORT_LIMITS = { maxFileBytes: 256 * 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024 * 1024, maxEntries: 200_000 };
/** Longest wait for the publication of a validated window. */
export const VALIDATION_TIMEOUT_MS = 30 * 60_000;
const ADAPTER_IN_FLIGHT = ['queued', 'preparing', 'running', 'analyzing', 'publishing', 'post_deploy'];
/** Statuses during which the window holds the site whatever its overlay (§5.3). */
const HOLDING_STATUSES: WindowStatus[] = ['opening', 'closing', 'analyzing', 'validating', 'rejecting'];
/** Names of executables for the web server (fallback when the scan module does not answer). */
const EXECUTABLE_RE = /(\.(php[3-8]?|phtml|pht|phps|phar|inc|cgi|pl|py|sh)$|(^|\/)\.htaccess$|(^|\/)\.user\.ini$)/i;

export interface AuditCtx { userId: number | null; ip: string | null; tokenName?: string | null }

// ── background tracking ──────────────────────────────────────────────────────

const pending = new Set<Promise<unknown>>();
/** Engine operations per window, serialized (tail of the chain). */
const chains = new Map<number, Promise<void>>();

export function track(p: Promise<unknown>): void {
  const q = p.catch((err) => logger.error({ err }, 'Windows: background task failed'));
  pending.add(q);
  void q.finally(() => pending.delete(q));
}

/** Tests: waits until no background task runs (tasks may chain new ones). */
export async function idle(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

/** Runs fn after the previous engine operation of the window (skipIfBusy: not at all when one runs). */
async function exclusive<T>(windowId: number, fn: () => Promise<T>, skipIfBusy = false): Promise<T | null> {
  if (skipIfBusy && chains.has(windowId)) return null;
  const prev = chains.get(windowId) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((r) => { done = r; });
  const tail = prev.then(() => mine);
  chains.set(windowId, tail);
  await prev;
  try {
    return await fn();
  } finally {
    done();
    if (chains.get(windowId) === tail) chains.delete(windowId);
  }
}

// ── context ──────────────────────────────────────────────────────────────────

export interface SiteCtx {
  site: SiteRow;
  account: { id: number; tenant_id: number; node_id: number; uid: number; gid: number; status: string; username: string };
  spec: HostdSiteSpec;
}

export async function siteCtx(siteId: number): Promise<SiteCtx> {
  const site = await db('sites').where({ id: siteId }).first() as SiteRow | undefined;
  if (!site) throw new AppError(404, 'Site not found', 'notFound');
  const account = await db('hosting_accounts').where({ id: site.account_id })
    .first('id', 'tenant_id', 'node_id', 'uid', 'gid', 'status', 'username') as SiteCtx['account'] | undefined;
  if (!account) throw new AppError(404, 'Account not found', 'notFound');
  return { site, account, spec: { accountId: account.id, siteId: site.id, slug: site.slug, uid: account.uid, gid: account.gid } };
}

async function dataPathsOf(siteId: number): Promise<AnalysisDataPath[]> {
  const rows = await db('site_data_paths').where({ site_id: siteId }).orderBy('path')
    .select('path', 'policy', 'allowed_extensions') as Array<{ path: string; policy: DataPathPolicy; allowed_extensions: unknown }>;
  return rows
    .filter((r) => normalizeRelPath(r.path) === r.path && dataPathForbiddenError(r.path) === null)
    .map((r) => ({ path: r.path, policy: r.policy, allowedExtensions: json<string[] | null>(r.allowed_extensions, null) }));
}

export async function settingsOf(siteId: number): Promise<SiteMaintenanceSettings> {
  const row = await db('site_maintenance').where({ site_id: siteId }).first('settings') as { settings: unknown } | undefined;
  return mergeSettings(json(row?.settings, {}));
}

export async function fetchRow(windowId: number): Promise<WindowRow | undefined> {
  return await windowQuery().where('w.id', windowId).first() as WindowRow | undefined;
}

export async function activeRow(siteId: number): Promise<WindowRow | undefined> {
  return await windowQuery().where('w.site_id', siteId).whereIn('w.status', WINDOW_ACTIVE_STATUSES as WindowStatus[])
    .orderBy('w.id', 'desc').first() as WindowRow | undefined;
}

/** §5.3: the window holds the site (overlay mounted, or a transition running). */
export function rowBlocks(row: Pick<WindowRow, 'status' | 'overlay'> | undefined): boolean {
  if (!row || !(WINDOW_ACTIVE_STATUSES as WindowStatus[]).includes(row.status)) return false;
  return HOLDING_STATUSES.includes(row.status) || row.overlay === 'rw' || row.overlay === 'ro';
}

function emit(row: Pick<WindowRow, 'id' | 'site_id' | 'tenant_id' | 'account_id'>, status: WindowStatus): void {
  emitHosting(HostingSocketEvents.WINDOW_UPDATED, { siteId: row.site_id, windowId: row.id, status }, {
    tenantId: row.tenant_id, accountId: row.account_id,
  });
}

/** One engine operation on a window: buffered log, conditional transitions, socket events. */
class WinRun {
  private log: ReleaseLogLine[];

  constructor(public ctx: SiteCtx, public row: WindowRow) {
    this.log = json<ReleaseLogLine[]>(row.log, []);
  }

  get id(): number { return this.row.id; }

  line(level: ReleaseLogLine['level'], message: string): void {
    this.log.push({ at: windowDeps().now().toISOString(), level, message });
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
  }

  async save(patch: Record<string, unknown> = {}): Promise<void> {
    await db('maintenance_windows').where({ id: this.row.id }).update({ ...patch, log: JSON.stringify(this.log), updated_at: db.fn.now() });
    Object.assign(this.row, patch);
    if (typeof patch.status === 'string') emit(this.row, patch.status as WindowStatus);
  }

  async step(level: ReleaseLogLine['level'], message: string, patch: Record<string, unknown> = {}): Promise<void> {
    this.line(level, message);
    await this.save(patch);
  }

  /** Conditional transition: only from `from`. false when another actor moved the window first. */
  async transition(from: WindowStatus[], to: WindowStatus, patch: Record<string, unknown> = {}, message?: string): Promise<boolean> {
    if (message) this.line('info', message);
    const n = await db('maintenance_windows').where({ id: this.row.id }).whereIn('status', from)
      .update({ ...patch, status: to, log: JSON.stringify(this.log), updated_at: db.fn.now() });
    if (!n) return false;
    Object.assign(this.row, patch, { status: to });
    emit(this.row, to);
    return true;
  }
}

async function loadRun(windowId: number): Promise<WinRun> {
  const row = await fetchRow(windowId);
  if (!row) throw new AppError(404, 'Window not found', 'notFound');
  return new WinRun(await siteCtx(row.site_id), row);
}

function windowSpec(run: WinRun) {
  return { ...run.ctx.spec, windowId: run.id };
}

async function audit(run: WinRun, action: string, who: AuditCtx | null, details: Record<string, unknown> = {}): Promise<void> {
  await auditService.log({
    tenantId: run.row.tenant_id, userId: who?.userId ?? undefined, action, ipAddress: who?.ip ?? undefined,
    resourceType: 'site', resourcePath: String(run.row.site_id),
    details: { siteId: run.row.site_id, windowId: run.id, number: run.row.number, ...(who?.tokenName ? { token: who.tokenName } : {}), ...details },
  });
}

function notifyWindow(run: WinRun, event: 'window.pendingReview' | 'window.autoValidated' | 'window.failed' | 'scan.threat', title: string, message: string): void {
  windowDeps().notify(event, {
    tenantId: run.row.tenant_id, accountId: run.row.account_id, key: `window:${run.id}:${event}`,
    severity: event === 'scan.threat' ? 'critical' : event === 'window.failed' ? 'warning' : 'info',
    title, message, link: `/sites/${run.row.site_id}/windows/${run.id}`,
  });
}

async function reload(run: WinRun): Promise<void> {
  try {
    const r = await windowDeps().reloadSite(run.row.site_id);
    if (!r.ok) run.line('warn', withDetail('rechargement des conteneurs en échec', r.errors.join('; ')));
  } catch (err) {
    run.line('warn', withDetail('rechargement des conteneurs impossible', err));
  }
}

async function unmount(run: WinRun, keepExport: boolean): Promise<boolean> {
  try {
    await windowDeps().hostd(run.ctx.account.node_id).removeWindow(windowSpec(run), { keepExport });
    return true;
  } catch (err) {
    run.line('warn', withDetail('démontage de la fenêtre impossible', err));
    return false;
  }
}

/**
 * The overlay is already gone (revert policy, never mounted): what is left of
 * the window on disk (export kept for the review, upper/work) is removed now
 * that the window is decided — removeWindow is idempotent and needs no mount.
 * Best effort (the export counts against the account quota).
 */
async function dropWindowFiles(run: WinRun): Promise<void> {
  try {
    await windowDeps().hostd(run.ctx.account.node_id).removeWindow(windowSpec(run), { keepExport: false });
  } catch (err) {
    run.line('warn', withDetail('fichiers de la fenêtre non supprimés', err));
  }
}

/** Best effort: the overlay remounted read-only (failure path when the unmount itself failed). */
async function freeze(run: WinRun): Promise<boolean> {
  try {
    await windowDeps().hostd(run.ctx.account.node_id).ensureWindow({
      ...windowSpec(run), releaseNumber: run.row.base_release_number as number, mode: 'ro', quarantineExecutables: false,
    });
    run.line('warn', 'couche gelée (lecture seule) faute de pouvoir la retirer : nouvel essai de démontage automatique');
    return true;
  } catch (err) {
    run.line('error', withDetail('gel de la couche impossible : nouvel essai de démontage automatique', err));
    return false;
  }
}

/**
 * Worker (every tick): a FINAL window whose overlay is still mounted (an
 * unmount failed: hostd hiccup) gets its unmount retried, its containers
 * reloaded. Returns the number of overlays removed.
 */
export async function retryStaleOverlays(): Promise<number> {
  const ids = await db('maintenance_windows').whereNotIn('status', WINDOW_ACTIVE_STATUSES as WindowStatus[])
    .whereIn('overlay', ['rw', 'ro']).orderBy('id').pluck('id') as number[];
  let removed = 0;
  for (const id of ids) {
    try {
      const done = await exclusive(id, async () => {
        const run = await loadRun(id);
        if ((WINDOW_ACTIVE_STATUSES as WindowStatus[]).includes(run.row.status) || (run.row.overlay !== 'rw' && run.row.overlay !== 'ro')) return false;
        if (!(await unmount(run, run.row.status === 'failed'))) {
          if (run.row.overlay === 'rw' && await freeze(run)) await run.save({ overlay: 'ro' });
          else await run.save();
          return false;
        }
        await reload(run);
        await run.step('info', 'couche retirée (nouvel essai) : le site sert de nouveau sa release', { overlay: 'unmounted' });
        return true;
      }, true);
      if (done) removed++;
    } catch (err) {
      logger.warn({ err, windowId: id }, 'Windows: stale overlay retry failed');
    }
  }
  return removed;
}

/** A failed window keeps its export for the staff this long (it counts against the account quota). */
export const FAILED_EXPORT_RETENTION_MS = 7 * 24 * 3_600_000;
/** Older failed windows are not looked at any more (their files were removed at the first pass past the retention). */
const FAILED_EXPORT_SCAN_MS = 60 * 24 * 3_600_000;

/**
 * Worker (every tick): files of FAILED windows (export kept for the staff,
 * upper/work) removed once FAILED_EXPORT_RETENTION_MS has passed. Only windows
 * whose overlay is gone (a mounted one is retryStaleOverlays' business).
 * Returns the number of windows cleaned.
 */
export async function purgeFailedExports(): Promise<number> {
  const now = windowDeps().now().getTime();
  const rows = await db('maintenance_windows as w').join('hosting_accounts as a', 'a.id', 'w.account_id')
    .where('w.status', 'failed').whereIn('w.overlay', ['unmounted', 'none'])
    .where('w.updated_at', '<=', new Date(now - FAILED_EXPORT_RETENTION_MS))
    .where('w.updated_at', '>', new Date(now - FAILED_EXPORT_SCAN_MS))
    .orderBy('w.id').limit(50)
    .select('w.id', 'w.account_id', 'w.site_id') as Array<{ id: number; account_id: number; site_id: number }>;
  let cleaned = 0;
  for (const r of rows) {
    if (!fs.existsSync(localPaths.window(r.account_id, r.site_id, r.id))) continue;
    try {
      const ctx = await siteCtx(r.site_id);
      await windowDeps().hostd(ctx.account.node_id).removeWindow({ ...ctx.spec, windowId: r.id }, { keepExport: false });
      cleaned++;
    } catch (err) {
      logger.warn({ err, windowId: r.id }, 'Windows: files of a failed window not removed (retried)');
    }
  }
  return cleaned;
}

/** A final window of the site still has its overlay mounted (unmount pending a retry). */
export async function staleOverlay(siteId: number): Promise<boolean> {
  return !!(await db('maintenance_windows').where({ site_id: siteId }).whereNotIn('status', WINDOW_ACTIVE_STATUSES as WindowStatus[])
    .whereIn('overlay', ['rw', 'ro']).first('id'));
}

async function releaseSnapshots(windowId: number): Promise<void> {
  try { await windowDeps().snapshots.release({ windowId }); } catch (err) { logger.warn({ err, windowId }, 'Windows: snapshot release failed'); }
}

/** After a final decision: an auto publication refused meanwhile is re-armed; a supervised site gets its permanent window back. */
async function afterFinal(run: WinRun, reopenSupervised: boolean): Promise<void> {
  try { windowDeps().stagingChanged(run.row.site_id); } catch { /* hook */ }
  if (!reopenSupervised) return;
  try {
    const settings = await settingsOf(run.row.site_id);
    if (settings.supervised && !(await activeRow(run.row.site_id))) {
      await openWindow(run.row.site_id, { trigger: 'supervised', userId: null, durationMinutes: null, note: null }, { userId: null, ip: null });
    }
  } catch (err) {
    logger.warn({ err, siteId: run.row.site_id }, 'Windows: cannot reopen the supervised window (the worker retries)');
  }
}

/** Any step → failed: overlay removed (export kept for the staff), containers reloaded. */
async function failWindow(run: WinRun, message: string, who: AuditCtx | null = null): Promise<void> {
  const wasMounted = run.row.overlay === 'rw' || run.row.overlay === 'ro';
  const unmounted = wasMounted ? await unmount(run, true) : true;
  if (wasMounted && unmounted) await reload(run);
  let overlay = wasMounted ? (unmounted ? 'unmounted' : run.row.overlay) : run.row.overlay;
  // M2: a final window never keeps a WRITABLE overlay; the worker retries the unmount (retryStaleOverlays).
  if (overlay === 'rw' && await freeze(run)) {
    overlay = 'ro';
    // Best effort (the window fails anyway): no container may keep a private writable copy.
    const v = await verifyContainers(run, 'ro');
    if (!v.ok) run.line('error', v.error);
  }
  run.line('error', message);
  const ok = await run.transition(WINDOW_ACTIVE_STATUSES as WindowStatus[], 'failed', { overlay, error: message.slice(0, 2000) });
  if (!ok) return;
  await releaseSnapshots(run.id);
  if (run.row.candidate_ref) await windowDeps().changeset.deleteCandidateRef(run.row.site_id, run.row.candidate_ref);
  await audit(run, 'window.fail', who, { error: message.slice(0, 500) });
  notifyWindow(run, 'window.failed', `Fenêtre de modification en échec : ${run.ctx.site.name}`,
    `La fenêtre #${run.row.number} du site ${run.ctx.site.name} est en échec : ${message.replace(/ \[détail : [\s\S]*\]$/, '')}`);
  try { windowDeps().stagingChanged(run.row.site_id); } catch { /* hook */ }
}

// ── opening ──────────────────────────────────────────────────────────────────

export interface OpenOrigin {
  trigger: WindowTrigger;
  userId: number | null;
  tokenId?: number | null;
  tokenName?: string | null;
  durationMinutes: number | null;
  note?: string | null;
}

function conflict(message: string, code: string, details?: unknown): AppError {
  return new AppError(409, message, code, details);
}

/** Refusals shared by open / info (§5.1 step 1) that need no window row. */
export async function openRefusal(ctx: SiteCtx): Promise<AppError | null> {
  if (siteDeletions.has(ctx.site.id) || ctx.account.status === 'deleting') return conflict('The site is being deleted', 'siteDeleting');
  if (ctx.account.status === 'suspended') return conflict('The hosting account is suspended', 'accountSuspended');
  if (ctx.site.status === 'stopped') return conflict('The site is stopped', 'siteStopped');
  return null;
}

/** Base of a new window: the live release, ready and materialized (§5.1). */
export async function liveBase(ctx: SiteCtx): Promise<{ id: number; number: number; commit: string } | null> {
  const fresh = await db('sites').where({ id: ctx.site.id }).first('current_release_id') as { current_release_id: number | null } | undefined;
  if (!fresh?.current_release_id) return null;
  const rel = await db('releases').where({ id: fresh.current_release_id, site_id: ctx.site.id })
    .first('id', 'number', 'status', 'commit_sha', 'on_disk') as { id: number; number: number; status: string; commit_sha: string | null; on_disk: boolean } | undefined;
  if (!rel || rel.status !== 'ready' || !rel.commit_sha || !rel.on_disk) return null;
  if (!fs.existsSync(path.posix.join(localPaths.releases(ctx.account.id, ctx.site.id), String(rel.number)))) return null;
  return { id: rel.id, number: rel.number, commit: rel.commit_sha };
}

/**
 * Opens a window (any trigger). Synchronous part: refusals + the 'opening'
 * row (created under the pipeline lock: no publication starts meanwhile);
 * background: DB snapshots, overlay rw, propagation check → open.
 */
export async function openWindow(siteId: number, origin: OpenOrigin, who: AuditCtx): Promise<MaintenanceWindow> {
  const deps = windowDeps();
  const ms = await deps.settings.maintenance();
  if (!ms.windowsEnabled) throw conflict('Modification windows are disabled on this platform', 'windowsDisabled');
  const ctx = await siteCtx(siteId);
  const refusal = await openRefusal(ctx);
  if (refusal) throw refusal;
  if (origin.durationMinutes !== null && origin.durationMinutes > ms.maxWindowMinutes) {
    throw conflict(`A window lasts at most ${ms.maxWindowMinutes} minutes`, 'windowMaxDuration', { maxMinutes: ms.maxWindowMinutes });
  }
  const active = await activeRow(siteId);
  if (active) {
    // Supervised site: a MANUAL window (a session user holding releases.publish) = executables allowed for a
    // while on the permanent overlay (§12). Never an API token nor a schedule: switching off the quarantine
    // of a supervised site (and renewing that forever) is a human decision.
    if (active.trigger === 'supervised' && active.status === 'open' && origin.trigger !== 'supervised') {
      if (origin.trigger === 'api') {
        throw new AppError(403, 'A site API token cannot allow executable writes on a supervised site', 'tokenScope');
      }
      if (origin.trigger === 'manual' && origin.durationMinutes !== null) return allowExecutables(active.id, origin.durationMinutes, who);
    }
    throw conflict('A modification window is already active on this site', 'windowActive');
  }
  // The overlay of a finished window is still mounted (unmount retried by the worker): no second overlay on top.
  if (await staleOverlay(siteId)) throw conflict('The previous modification window is still being cleaned up', 'windowActive');
  // A deferred update run (release awaiting approval, continued by the adapters worker once approved) also
  // holds the site: a window would block that approval and supersede the update (integration, §11).
  if (await db('adapter_runs').where({ site_id: siteId }).where((w) => {
    w.whereIn('status', ADAPTER_IN_FLIGHT)
      .orWhere((d) => d.where('status', 'awaiting_approval').whereRaw("analysis -> 'pendingReflect' is not null"));
  }).first('id')) {
    throw conflict('An application adapter run is in progress on this site', 'adapterBusy');
  }
  const base = await liveBase(ctx);
  if (!base) throw conflict('The site has no published release to open a window on', 'noRelease');

  const id = await releaseService.reserve(siteId, async () => {
    try {
      return await db.transaction(async (trx) => {
        await trx('sites').where({ id: siteId }).forUpdate().first('id');
        if (await trx('maintenance_windows').where({ site_id: siteId }).whereIn('status', WINDOW_ACTIVE_STATUSES as WindowStatus[]).first('id')) {
          throw conflict('A modification window is already active on this site', 'windowActive');
        }
        const max = await trx('maintenance_windows').where({ site_id: siteId }).max('number as n').first() as { n: number | null } | undefined;
        const number = Number(max?.n ?? 0) + 1;
        const [row] = await trx('maintenance_windows').insert({
          tenant_id: ctx.site.tenant_id, account_id: ctx.account.id, site_id: siteId, number, trigger: origin.trigger,
          status: 'opening', overlay: 'none', base_release_id: base.id, base_release_number: base.number, base_commit: base.commit,
          opened_by: origin.userId, token_id: origin.tokenId ?? null, token_name: origin.tokenName ?? null,
          note: origin.note?.trim() ? origin.note.trim().slice(0, 500) : null,
          log: JSON.stringify([{ at: deps.now().toISOString(), level: 'info', message: `ouverture demandée (${origin.trigger}) sur la release #${base.number}` }]),
        }).returning('id');
        return Number(typeof row === 'object' ? row.id : row);
      });
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') throw conflict('A modification window is already active on this site', 'windowActive');
      throw err;
    }
  });
  const row = await fetchRow(id) as WindowRow;
  emit(row, 'opening');
  track(completeOpening(id, origin, who));
  return toWindow(row);
}

async function completeOpening(windowId: number, origin: OpenOrigin, who: AuditCtx): Promise<void> {
  await exclusive(windowId, async () => {
    const deps = windowDeps();
    const run = await loadRun(windowId);
    if (run.row.status !== 'opening') return;
    // 1. Database snapshots first: a failure is visible, never blocking (§5.1 step 3).
    const settings = await settingsOf(run.row.site_id);
    if (origin.trigger === 'supervised') {
      run.line('info', 'mode supervisé : pas de cliché des bases (fenêtre permanente)');
    } else if (settings.snapshot.mode === 'none') {
      run.line('info', 'clichés des bases désactivés pour ce site');
    } else {
      try {
        const snaps = await deps.snapshots.createForSite(run.row.site_id, { reason: 'window', windowId, userId: origin.userId });
        const failed = snaps.filter((s) => s.status === 'failed').length;
        if (!snaps.length) run.line('info', 'aucune base à sauvegarder');
        else if (failed) run.line('warn', `clichés des bases : ${snaps.length - failed} prêt(s), ${failed} en échec`);
        else run.line('info', `clichés des bases : ${snaps.length} prêt(s)`);
      } catch (err) {
        run.line('warn', withDetail('clichés des bases impossibles (la fenêtre s’ouvre quand même)', err));
      }
    }
    await run.save();

    // 2. Overlay rw over releases/<n>.
    try {
      await deps.hostd(run.ctx.account.node_id).ensureWindow({
        ...windowSpec(run), releaseNumber: run.row.base_release_number as number, mode: 'rw',
        quarantineExecutables: origin.trigger === 'supervised',
      });
    } catch (err) {
      run.row.overlay = 'rw'; // maybe half-mounted: removeWindow is idempotent
      await failWindow(run, withDetail('montage de la fenêtre impossible', err), who);
      return;
    }
    await run.step('info', `couche d’écriture montée sur la release #${run.row.base_release_number}`, { overlay: 'rw' });

    // 3. Propagation into every running container of the site (§4.1).
    const prop = await checkPropagation(run);
    if (prop !== null) {
      await failWindow(run, prop, who);
      return;
    }

    const now = deps.now();
    const expires = origin.durationMinutes === null ? null : new Date(now.getTime() + origin.durationMinutes * 60_000);
    const ok = await run.transition(['opening'], 'open', { opened_at: now, expires_at: expires },
      expires ? `fenêtre ouverte jusqu’à ${expires.toISOString()}` : 'fenêtre ouverte (sans échéance)');
    if (!ok) return;
    await audit(run, 'window.open', who, { trigger: origin.trigger, durationMinutes: origin.durationMinutes, baseRelease: run.row.base_release_number });
  });
}

/** Opening (rw): the overlay must be visible, writable, in every running container. null = OK, else the error. */
async function checkPropagation(run: WinRun): Promise<string | null> {
  const r = await verifyContainers(run, 'rw');
  return r.ok ? null : r.error;
}

/** confirmed: a container really shows the wrong state (vs. the check itself could not run). */
type VerifyResult = { ok: true } | { ok: false; error: string; confirmed: boolean };

/**
 * Verifies the overlay in every running container of the site
 * (/proc/<pid>/mountinfo via hostd): visible, in the `expect` mode. A container
 * that fails is RECREATED from its current spec (releases bind rslave) — never
 * restarted: a restart reuses the old mount config and Docker's recursive bind
 * would take a PRIVATE copy of the overlay that no later freeze / unmount on
 * the host reaches (M2) — then verified again.
 *
 *   expect 'rw' (opening): invisible or not writable ⇒ error;
 *   expect 'ro' (after a freeze): still WRITABLE ⇒ error (M2); invisible ⇒
 *   warning only (that container serves the base release, nothing writable).
 */
async function verifyContainers(run: WinRun, expect: 'rw' | 'ro'): Promise<VerifyResult> {
  const deps = windowDeps();
  if (!deps.propagationCheck()) {
    run.line('info', 'vérification de la propagation désactivée (OBLIMINT_WINDOW_PROPAGATION_CHECK=off)');
    return { ok: true };
  }
  const hostd = deps.hostd(run.ctx.account.node_id);
  type Outcome = { invisible: string[]; wrongMode: string[]; checked: number };
  const verify = async (): Promise<Outcome | string> => {
    let containers;
    try {
      containers = await deps.siteContainers(run.row.site_id);
    } catch (err) {
      return withDetail('conteneurs du site illisibles', err);
    }
    if (!containers.length) return { invisible: [], wrongMode: [], checked: 0 };
    try {
      const results = await hostd.verifyWindowPropagation(run.ctx.account.id, run.row.site_id, run.id, containers.map((c) => c.pid));
      const byPid = new Map(results.map((r) => [r.pid, r]));
      const out: Outcome = { invisible: [], wrongMode: [], checked: containers.length };
      for (const c of containers) {
        const r = byPid.get(c.pid);
        if (!r?.visible) out.invisible.push(c.name);
        else if (r.mode !== expect) out.wrongMode.push(c.name);
      }
      return out;
    } catch (err) {
      return withDetail('vérification de la propagation impossible', err);
    }
  };
  const failing = (o: Outcome): string[] => (expect === 'rw' ? [...o.invisible, ...o.wrongMode] : o.wrongMode);
  const what = expect === 'rw' ? 'couche d’écriture' : 'couche gelée';
  const first = await verify();
  if (typeof first === 'string') return { ok: false, error: first, confirmed: false };
  if (!first.checked) {
    run.line('info', 'aucun conteneur en cours d’exécution : propagation non vérifiée');
    return { ok: true };
  }
  const bad = failing(first);
  if (!bad.length) {
    if (first.invisible.length) run.line('warn', `${what} invisible dans ${first.invisible.join(', ')} (ce conteneur sert la release de base)`);
    run.line('info', `${what} vérifiée dans ${first.checked - first.invisible.length} conteneur(s)`);
    return { ok: true };
  }
  for (const name of bad) {
    run.line('warn', first.wrongMode.includes(name)
      ? `${what} vue ${expect === 'ro' ? 'inscriptible' : 'en lecture seule'} dans ${name} : conteneur recréé`
      : `${what} invisible dans ${name} : conteneur recréé`);
    try {
      await deps.recreateContainer(run.row.site_id, name);
    } catch (err) {
      run.line('warn', withDetail(`recréation de ${name} impossible`, err));
    }
  }
  await run.save();
  const second = await verify();
  if (typeof second === 'string') return { ok: false, error: second, confirmed: false };
  if (second.wrongMode.length) {
    return { ok: false, confirmed: true, error: `${what} vue ${expect === 'ro' ? 'inscriptible' : 'en lecture seule'} dans ${second.wrongMode.join(', ')} après recréation` };
  }
  if (expect === 'rw' && second.invisible.length) return { ok: false, confirmed: true, error: `${what} invisible dans ${second.invisible.join(', ')} après recréation` };
  if (second.invisible.length) run.line('warn', `${what} invisible dans ${second.invisible.join(', ')} (ce conteneur sert la release de base)`);
  run.line('info', `${what} vérifiée dans ${second.checked - second.invisible.length} conteneur(s) après recréation`);
  return { ok: true };
}

/** Supervised site: executables allowed on the permanent overlay until now + minutes, then analysis (§12). */
async function allowExecutables(windowId: number, minutes: number, who: AuditCtx): Promise<MaintenanceWindow> {
  // Under the window lock, status re-read: a close queued meanwhile freezes AFTER this rw remount (runClose
  // waits for the lock), never before it (M2).
  await exclusive(windowId, async () => {
    const run = await loadRun(windowId);
    if (run.row.status !== 'open' || run.row.trigger !== 'supervised' || run.row.overlay !== 'rw') {
      throw conflict('This window is not open', 'windowNotOpen');
    }
    const until = new Date(windowDeps().now().getTime() + minutes * 60_000);
    try {
      await windowDeps().hostd(run.ctx.account.node_id).ensureWindow({
        ...windowSpec(run), releaseNumber: run.row.base_release_number as number, mode: 'rw', quarantineExecutables: false,
      });
    } catch (err) {
      throw new AppError(502, withDetail('Cannot allow executable writes on the supervised window', err), 'backendUnavailable');
    }
    const ok = await run.transition(['open'], 'open', { exec_allowed_until: until }, `écritures exécutables permises jusqu’à ${until.toISOString()}`);
    if (!ok) throw conflict('This window is not open', 'windowNotOpen');
    await audit(run, 'window.open', who, { supervised: true, execAllowedUntil: until.toISOString() });
  });
  return toWindow(await fetchRow(windowId) as WindowRow);
}

/** End of an executables allowance: quarantine back on, then a digest. */
export async function endExecAllowance(windowId: number): Promise<void> {
  await exclusive(windowId, async () => {
    const run = await loadRun(windowId);
    if (run.row.status !== 'open' || !run.row.exec_allowed_until) return;
    try {
      await windowDeps().hostd(run.ctx.account.node_id).ensureWindow({
        ...windowSpec(run), releaseNumber: run.row.base_release_number as number, mode: 'rw', quarantineExecutables: true,
      });
    } catch (err) {
      run.line('warn', withDetail('remise en quarantaine des exécutables impossible (nouvel essai)', err));
      await run.save();
      return;
    }
    await run.step('info', 'fin des écritures exécutables permises : mise en quarantaine rétablie', { exec_allowed_until: null });
  });
  await digest(windowId);
}

// ── extend / close ───────────────────────────────────────────────────────────

export async function extendWindow(siteId: number, windowId: number, minutes: number, who: AuditCtx): Promise<MaintenanceWindow> {
  const row = await fetchRow(windowId);
  if (!row || row.site_id !== siteId) throw new AppError(404, 'Window not found', 'notFound');
  if (row.status !== 'open') throw conflict('This window is not open', 'windowNotOpen');
  if (!row.expires_at) return toWindow(row); // supervised: no expiry
  const ms = await windowDeps().settings.maintenance();
  const now = windowDeps().now().getTime();
  const next = Math.max(new Date(row.expires_at).getTime(), now) + minutes * 60_000;
  const openedAt = row.opened_at ? new Date(row.opened_at).getTime() : now;
  if (next - openedAt > ms.maxWindowMinutes * 60_000) {
    throw conflict(`A window lasts at most ${ms.maxWindowMinutes} minutes`, 'windowMaxDuration', { maxMinutes: ms.maxWindowMinutes });
  }
  const run = new WinRun(await siteCtx(siteId), row);
  const ok = await run.transition(['open'], 'open', { expires_at: new Date(next) }, `prolongée de ${minutes} min (jusqu’à ${new Date(next).toISOString()})`);
  if (!ok) throw conflict('This window is not open', 'windowNotOpen');
  await audit(run, 'window.extend', who, { minutes, expiresAt: new Date(next).toISOString() });
  return toWindow(await fetchRow(windowId) as WindowRow);
}

/** open → closing (synchronous), then freeze + analysis in the background. */
export async function closeWindow(siteId: number, windowId: number, reason: WindowCloseReason, who: AuditCtx): Promise<MaintenanceWindow> {
  const row = await fetchRow(windowId);
  if (!row || row.site_id !== siteId) throw new AppError(404, 'Window not found', 'notFound');
  if (row.status !== 'open') throw conflict('This window is not open', 'windowNotOpen');
  const run = new WinRun(await siteCtx(siteId), row);
  const ok = await run.transition(['open'], 'closing', { closed_at: windowDeps().now(), close_reason: reason, exec_allowed_until: null },
    `fermeture (${reason})`);
  if (!ok) throw conflict('This window is not open', 'windowNotOpen');
  await audit(run, 'window.close', who, { reason });
  track(runClose(windowId));
  return toWindow(await fetchRow(windowId) as WindowRow);
}

/** Freeze (ro) → analyzing → analysis + decision. Used by close and by the boot recovery. */
export async function runClose(windowId: number): Promise<void> {
  await exclusive(windowId, async () => {
    const run = await loadRun(windowId);
    if (run.row.status !== 'closing' && run.row.status !== 'analyzing') return;
    await closeBody(run);
  });
}

/** A 'closing' window whose freeze could not be done / verified is retried this often by the worker… */
export const CLOSE_RETRY_MS = 60_000;
/** …for this long after its close: then a hostd error fails it, an unverifiable propagation is accepted. */
export const CLOSE_GIVE_UP_MS = 30 * 60_000;

function closeGaveUp(run: WinRun): boolean {
  const at = run.row.closed_at ? new Date(run.row.closed_at).getTime() : 0;
  return windowDeps().now().getTime() - at >= CLOSE_GIVE_UP_MS;
}

/**
 * Caller holds exclusive. The freeze never destroys the layer on a transient
 * error: the upper layer is the only copy of the client's changes, so a
 * failed freeze (hostd hiccup) leaves the window 'closing' and the worker
 * retries (retryClosings) — failWindow (which removes upper/) only after
 * CLOSE_GIVE_UP_MS, since a final window never keeps a writable overlay (M2).
 * After the freeze every running container must show the overlay READ-ONLY
 * (a private rw copy would keep the frozen layer writable, M2): a container
 * still writable after its recreation fails the window.
 */
async function closeBody(run: WinRun): Promise<void> {
  if (run.row.overlay === 'rw' || (run.row.status === 'closing' && run.row.overlay !== 'unmounted')) {
    try {
      await windowDeps().hostd(run.ctx.account.node_id).ensureWindow({
        ...windowSpec(run), releaseNumber: run.row.base_release_number as number, mode: 'ro', quarantineExecutables: false,
      });
    } catch (err) {
      if (closeGaveUp(run)) {
        await failWindow(run, withDetail('gel de la fenêtre impossible', err));
        return;
      }
      run.line('error', withDetail('gel de la fenêtre impossible : nouvel essai automatique (les modifications sont conservées)', err));
      await run.save();
      return;
    }
    await run.step('info', 'couche gelée (lecture seule)', { overlay: 'ro' });
    const v = await verifyContainers(run, 'ro');
    if (!v.ok) {
      if (v.confirmed) {
        await failWindow(run, `M2 : ${v.error}`);
        return;
      }
      if (!closeGaveUp(run)) {
        run.line('warn', `${v.error} : nouvel essai automatique`);
        await run.save();
        return;
      }
      run.line('warn', `${v.error} : analyse poursuivie (couche gelée sur l’hôte)`);
    }
  }
  if (run.row.status === 'closing' && !(await run.transition(['closing'], 'analyzing'))) return;
  await analyzeAndDecide(run, { decide: true });
}

/**
 * Worker (every tick): 'closing' windows whose freeze failed or could not be
 * verified (closeBody left them for a retry) are frozen again. Returns the
 * number of windows retried.
 */
export async function retryClosings(): Promise<number> {
  const before = new Date(windowDeps().now().getTime() - CLOSE_RETRY_MS);
  const ids = await db('maintenance_windows').where({ status: 'closing' }).where('updated_at', '<=', before)
    .orderBy('id').pluck('id') as number[];
  let retried = 0;
  for (const id of ids) {
    if (chains.has(id)) continue;
    retried++;
    track(exclusive(id, async () => {
      const run = await loadRun(id);
      if (run.row.status !== 'closing') return;
      await closeBody(run);
    }, true));
  }
  return retried;
}

// ── analysis ─────────────────────────────────────────────────────────────────

/** Analysis stored in maintenance_windows.analysis: the API summary + what validation needs. */
export interface StoredAnalysis extends ChangeAnalysisSummary {
  /** ScanSummary handed to publishCommit (the pipeline does not rescan). */
  scan?: ScanSummary;
  /** A changed file too large for the export / candidate, or a truncated manifest: validation refused (windowTooLarge). */
  tooLarge?: boolean;
}

function fallbackAnalysis(files: ChangedPath[], counts: WindowChangeCounts, now: Date): ChangeAnalysis {
  const fa: FileAnalysis[] = files.map((f) => ({
    path: f.path, change: f.change, type: f.type, size: f.size, executable: EXECUTABLE_RE.test(f.path), binary: false,
    risk: 0, level: 'none', findings: [], ignored: f.ignored ?? null,
  }));
  return {
    summary: {
      engines: [], verdict: 'suspicious', risk: { score: 0, level: 'none' }, counts, findings: 0, criticalFindings: 0,
      scannerUnavailable: true, skipped: files.filter((f) => !f.ignored).length, blocked: false, analyzedAt: now.toISOString(),
    },
    files: fa,
    scan: { scanner: 'unavailable', verdict: 'suspicious', findings: [], risk: { score: 0, level: 'none' }, scannerUnavailable: true, blocked: false },
  };
}

interface AnalyzeOpts {
  /** Close path: auto-validation / pending_review. false: reanalysis (back to pending_review). */
  decide: boolean;
  /** Supervised digest: the window stays open (no discard, no decision). */
  digest?: boolean;
}

/**
 * Export (unless the overlay is gone: revert policy) → manifest → ignore rules
 * → candidate commit → scan + checksums + healthcheck + staging conflicts →
 * window_files / counts / risk → decision. Caller holds exclusive(windowId).
 */
async function analyzeAndDecide(run: WinRun, opts: AnalyzeOpts): Promise<void> {
  const deps = windowDeps();
  const { ctx } = run;
  const w = run.row;
  const accountId = ctx.account.id;
  const exportFiles = localPaths.windowExportFiles(accountId, w.site_id, w.id);

  let manifest;
  try {
    if (w.overlay !== 'unmounted') {
      const r = await deps.hostd(ctx.account.node_id).exportWindow(windowSpec(run), EXPORT_LIMITS);
      run.line('info', `export : ${r.entries} entrée(s), +${r.added} ~${r.modified} -${r.deleted}, ${r.bytes} octet(s)${r.truncated ? ' (tronqué)' : ''}`);
    } else {
      run.line('info', 'couche déjà retirée (politique « revenir ») : export existant réutilisé');
    }
    manifest = readManifest(localPaths.windowManifest(accountId, w.site_id, w.id), w.id);
  } catch (err) {
    if (opts.digest) { run.line('warn', withDetail('résumé impossible : export en échec', err)); await run.save(); return; }
    await analysisFailed(run, withDetail('export de la fenêtre impossible', err));
    return;
  }

  const dataPaths = await dataPathsOf(w.site_id);
  const classified = classifyChanges(manifestChanges(manifest), dataPaths.map((d) => d.path));
  const meaningful = classified.filter((c) => !c.ignored && !(c.type === 'dir' && c.change !== 'deleted'));
  let tooLarge = manifest.truncated || classified.some((c) => c.ignored === 'tooLarge');
  if (!opts.digest && !meaningful.length && !tooLarge) {
    await discard(run, classified.length ? `${classified.length} chemin(s) ignoré(s), aucun changement publiable` : 'aucun changement');
    return;
  }

  const tree = localContentTree(exportFiles);
  const refName = `refs/oblimint/candidates/window-${w.id}`;
  let candidate;
  try {
    candidate = await deps.changeset.buildCandidateCommit({
      siteId: w.site_id, baseCommit: w.base_commit as string, tree, changes: classified, refName,
      message: `Fenêtre #${w.number}${w.note ? ` — ${w.note}` : ''}`,
      author: { name: `window #${w.number}`, email: `window-${w.number}@oblimint.local` },
    });
  } catch (err) {
    if (opts.digest) { run.line('warn', withDetail('résumé impossible : commit candidat en échec', err)); await run.save(); return; }
    await analysisFailed(run, withDetail('commit candidat impossible', err));
    return;
  }
  run.line('info', `commit candidat ${candidate.commit.slice(0, 12)} : +${candidate.added} ~${candidate.modified} -${candidate.deleted}`);
  const ignoredBy = new Map<string, ChangedPath['ignored']>();
  for (const c of classified) if (c.ignored) ignoredBy.set(c.path, c.ignored);
  for (const i of candidate.ignored) ignoredBy.set(i.path, i.reason);
  if (candidate.ignored.some((i) => i.reason === 'tooLarge')) tooLarge = true;
  if (!opts.digest && !candidate.files.length && !tooLarge) {
    await run.save({ candidate_commit: candidate.commit, candidate_ref: candidate.refName });
    await discard(run, 'aucun changement de contenu (métadonnées seules)');
    return;
  }

  // The change set as git sees it (authoritative), enriched with the manifest, plus the ignored paths.
  const byPath = new Map(classified.map((c) => [c.path, c]));
  const files: ChangedPath[] = candidate.files.map((f) => {
    const m = byPath.get(f.path);
    return {
      path: f.path, change: f.change, type: m && m.type !== 'dir' ? m.type : 'file',
      size: f.change === 'deleted' ? null : m?.size ?? null, mode: m?.mode ?? null, sha256: m?.sha256 ?? null, ignored: null,
    };
  });
  for (const [p, reason] of ignoredBy) {
    if (files.some((f) => f.path === p)) continue;
    const m = byPath.get(p);
    files.push({ path: p, change: m?.change ?? 'modified', type: m?.type ?? 'file', size: m?.size ?? null, mode: m?.mode ?? null, ignored: reason });
  }
  const effective = files.filter((f) => !f.ignored);
  const counts: WindowChangeCounts = {
    added: candidate.files.filter((f) => f.change === 'added').length,
    modified: candidate.files.filter((f) => f.change === 'modified' || f.change === 'typechange').length,
    deleted: candidate.files.filter((f) => f.change === 'deleted').length,
    total: candidate.files.length,
    executable: 0,
    ignored: files.length - effective.length,
    bytes: effective.reduce((s, f) => s + (f.size ?? 0), 0),
  };

  // Scan (heuristics + YARA + ClamAV), checksums, healthcheck, staging conflicts.
  let analysis: ChangeAnalysis;
  try {
    analysis = await deps.analyze({
      origin: opts.digest ? 'digest' : 'window', siteId: w.site_id, accountId, appProfile: ctx.site.app_profile,
      tree, files, dataPaths,
    });
  } catch (err) {
    run.line('warn', withDetail('analyse indisponible : revue humaine obligatoire', err));
    analysis = fallbackAnalysis(files, counts, deps.now());
  }
  const fileInfo = new Map(analysis.files.map((f) => [f.path, f]));
  counts.executable = effective.filter((f) => fileInfo.get(f.path)?.executable ?? EXECUTABLE_RE.test(f.path)).length;

  let checksums: ChecksumVerification | null = null;
  try {
    checksums = await deps.verifyChecksums({ siteId: w.site_id, appProfile: ctx.site.app_profile, tree, files: effective });
  } catch (err) {
    run.line('warn', withDetail('sommes de contrôle indisponibles', err));
  }
  let health: { ok: boolean; status: number | null; error: string | null };
  try {
    health = await deps.healthcheck(w.site_id);
  } catch (err) {
    health = { ok: false, status: null, error: (err as Error)?.message ?? String(err) };
  }
  run.line(health.ok ? 'info' : 'warn', health.ok ? 'contrôle HTTP du site OK' : withDetail('contrôle HTTP du site en échec', health.error));
  let conflicts: string[] = [];
  try {
    conflicts = await deps.changeset.stagingConflicts(w.site_id, w.base_commit as string, candidate.files.map((f) => f.path));
    if (conflicts.length) run.line('warn', `${conflicts.length} chemin(s) modifié(s) dans le staging depuis la release de base`);
  } catch (err) {
    run.line('warn', withDetail('comparaison avec le staging impossible', err));
  }

  const scanner = await deps.settings.scanner();
  const risk = analysis.summary.risk ?? { score: 0, level: riskLevelOf(0, scanner) };
  // An infected verdict always blocks (same rule as the pipeline's normalizeScan), whatever summary.blocked says.
  const blocked = analysis.summary.blocked || analysis.summary.verdict === 'infected' || analysis.scan.verdict === 'infected';
  analysis.summary = { ...analysis.summary, blocked };
  const stored: StoredAnalysis = { ...analysis.summary, counts, scan: { ...analysis.scan, blocked }, tooLarge };
  await db.transaction(async (trx) => {
    await trx('window_files').where({ window_id: w.id }).del();
    const rows = files.map((f) => {
      const a = fileInfo.get(f.path);
      return {
        window_id: w.id, path: f.path, change: f.change, type: f.type, size: f.size, executable: a?.executable ?? EXECUTABLE_RE.test(f.path),
        binary: a?.binary ?? false, risk: Math.max(0, Math.min(100, Math.round(a?.risk ?? 0))), level: a?.level ?? 'none',
        checksum: checksums?.files.get(f.path) ?? 'unknown', findings: JSON.stringify(a?.findings ?? []),
        ignored: !!f.ignored, ignore_reason: f.ignored ?? null,
      };
    });
    for (let i = 0; i < rows.length; i += 500) await trx('window_files').insert(rows.slice(i, i + 500));
  });
  run.line(analysis.summary.blocked ? 'warn' : 'info',
    `analyse : ${analysis.summary.verdict}, risque ${risk.score} (${risk.level})${analysis.summary.blocked ? ', BLOQUÉE' : ''}${analysis.summary.scannerUnavailable ? ', scanner indisponible' : ''}`);
  if (tooLarge) run.line('warn', 'des fichiers trop volumineux n’ont pas pu être exportés : validation impossible');
  await run.save({
    candidate_commit: candidate.commit, candidate_ref: candidate.refName, counts: JSON.stringify(counts),
    risk_score: risk.score, risk_level: risk.level, analysis: JSON.stringify(stored),
    checksums: checksums ? JSON.stringify(checksums.report satisfies ChecksumReport) : null,
    healthcheck: JSON.stringify({ ...health, at: deps.now().toISOString() }),
    staging_conflicts: JSON.stringify(conflicts), error: null,
  });
  if (analysis.summary.blocked) {
    notifyWindow(run, 'scan.threat', `Menace détectée : ${ctx.site.name}`,
      `L’analyse de la fenêtre #${w.number} du site ${ctx.site.name} la bloque (risque ${risk.score}). Seule une dérogation du staff peut la valider.`);
  }
  if (opts.digest) return;

  if (!opts.decide) {
    await run.transition(['analyzing'], 'pending_review', {}, 'nouvelle analyse terminée');
    return;
  }

  // Decision (§5.1 step 5, §10.2).
  const settings = await settingsOf(w.site_id);
  const ms = await deps.settings.maintenance();
  const fresh = await db('sites').where({ id: w.site_id }).first('current_release_id', 'publish_mode') as { current_release_id: number | null; publish_mode: string };
  const baseIsCurrent = fresh?.current_release_id === w.base_release_id;
  let auto: AutoValidationResult;
  if (tooLarge) {
    auto = { eligible: false, decision: 'review', reasons: [{ code: 'disabled', detail: 'changements trop volumineux' }], decidedAt: deps.now().toISOString() };
  } else {
    auto = deps.decideAutoValidation({
      trigger: w.trigger, mode: settings.autoValidate, analysis: stored, executablePaths: effective.filter((f) => fileInfo.get(f.path)?.executable).map((f) => f.path),
      healthcheck: { ok: health.ok, error: health.error }, checksums, requireChecksums: ms.autoValidateRequireChecksums,
      reviewScore: scanner.reviewScore, baseIsCurrent,
    });
  }
  // Defense in depth (M5): never automatic for a manual / supervised window, a blocked analysis,
  // an approval-mode site (a human approves) or staging conflicts (a human chooses).
  const autoAllowed = (w.trigger === 'scheduled' || (w.trigger === 'api' && settings.autoValidate === 'scheduled-api'))
    && settings.autoValidate !== 'off' && !analysis.summary.blocked && !analysis.summary.scannerUnavailable
    && analysis.summary.verdict === 'clean' && analysis.scan.verdict === 'clean'
    && fresh?.publish_mode !== 'approval' && !conflicts.length && baseIsCurrent;
  if (auto.decision === 'validate' && !autoAllowed) {
    auto = {
      ...auto, decision: 'review',
      reasons: [...auto.reasons.filter((r) => r.code !== 'ok'), {
        code: 'disabled', detail: fresh?.publish_mode === 'approval' ? 'site en mode approbation' : conflicts.length ? 'conflits avec le staging' : 'non éligible',
      }],
    };
  }
  await run.save({ auto_validation: JSON.stringify(auto) });
  if (auto.decision === 'validate') {
    run.line('info', 'validation automatique : toutes les conditions sont remplies');
    try {
      await startValidation(run, { userId: null, auto: true, override: false, message: null }, null);
      return;
    } catch (err) {
      run.line('warn', withDetail('validation automatique impossible : revue humaine', err));
    }
  }
  const moved = await run.transition(['analyzing'], 'pending_review', {}, 'en attente de revue');
  if (!moved) return;
  notifyWindow(run, 'window.pendingReview', `Fenêtre à valider : ${ctx.site.name}`,
    `La fenêtre #${w.number} du site ${ctx.site.name} attend une décision : ${counts.total} changement(s), risque ${risk.score} (${risk.level}).`);
  if (settings.pendingPolicy === 'revert' && w.trigger !== 'supervised' && run.row.overlay !== 'unmounted') {
    if (await unmount(run, true)) {
      await reload(run);
      await run.step('info', 'politique « revenir » : le site sert de nouveau la release de base (le diff reste validable)', { overlay: 'unmounted' });
    }
  }
}

/**
 * The export / candidate of a FROZEN window failed (hostd timeout, EDQUOT,
 * restart…): the layer is the only copy of the client's changes, so it is
 * KEPT (never failWindow, which removes upper/): the window goes to
 * pending_review with the error and no analysis — no validation possible
 * until an analysis succeeds (windowNotAnalyzed); staff / client retry with
 * « relancer l’analyse », or reject.
 */
async function analysisFailed(run: WinRun, message: string): Promise<void> {
  run.line('error', `${message} : couche conservée, relancer l’analyse ou rejeter la fenêtre`);
  // The export may have been redone partially: a previous analysis no longer describes it (validation refused until a new one).
  const moved = await run.transition(['analyzing'], 'pending_review', { error: message.slice(0, 2000), analysis: null, candidate_commit: null });
  if (!moved) { await run.save(); return; }
  notifyWindow(run, 'window.failed', `Analyse de fenêtre en échec : ${run.ctx.site.name}`,
    `L’analyse de la fenêtre #${run.row.number} du site ${run.ctx.site.name} a échoué (${message.replace(/ \[détail : [\s\S]*\]$/, '')}) ; les modifications sont conservées, relancez l’analyse.`);
}

async function discard(run: WinRun, why: string): Promise<void> {
  const gone = run.row.overlay === 'unmounted' || run.row.overlay === 'none';
  const unmounted = gone ? true : await unmount(run, false);
  if (gone) await dropWindowFiles(run);
  if (unmounted) await reload(run);
  const ok = await run.transition(['analyzing', 'closing'], 'discarded', {
    decision: 'discarded', decided_at: windowDeps().now(), overlay: unmounted ? 'unmounted' : run.row.overlay,
  }, `fenêtre abandonnée : ${why}`);
  if (!ok) return;
  if (run.row.candidate_ref) await windowDeps().changeset.deleteCandidateRef(run.row.site_id, run.row.candidate_ref);
  await releaseSnapshots(run.id);
  await audit(run, 'window.discard', null, { reason: why });
  await afterFinal(run, true);
}

/** Supervised digest / exec-allowance end: export + analysis of an OPEN window, nothing closed. */
export async function digest(windowId: number): Promise<boolean> {
  const r = await exclusive(windowId, async () => {
    const run = await loadRun(windowId);
    if (run.row.status !== 'open') return false;
    await analyzeAndDecide(run, { decide: false, digest: true });
    return true;
  }, true);
  return r === true;
}

export async function reanalyze(siteId: number, windowId: number, who: AuditCtx): Promise<MaintenanceWindow> {
  const row = await fetchRow(windowId);
  if (!row || row.site_id !== siteId) throw new AppError(404, 'Window not found', 'notFound');
  if (row.status !== 'pending_review') throw conflict('This window is not waiting for a review', 'windowNotPending');
  const run = new WinRun(await siteCtx(siteId), row);
  if (!(await run.transition(['pending_review'], 'analyzing', {}, 'nouvelle analyse demandée'))) throw conflict('This window is not waiting for a review', 'windowNotPending');
  await audit(run, 'window.reanalyze', who);
  track(exclusive(windowId, async () => {
    const r = await loadRun(windowId);
    await analyzeAndDecide(r, { decide: false });
  }));
  return toWindow(await fetchRow(windowId) as WindowRow);
}

// ── validation ───────────────────────────────────────────────────────────────

export interface ValidateOpts {
  userId: number | null;
  auto: boolean;
  /** A staff override of a blocked analysis (checked + audited by the caller). */
  override: boolean;
  message: string | null;
}

/**
 * pending_review | analyzing (auto) → validating → publishCommit; the wait
 * for the release and the end (reflection to staging, unmount) run in the
 * background. A synchronous refusal of the pipeline puts the window back.
 */
async function startValidation(run: WinRun, opts: ValidateOpts, who: AuditCtx | null): Promise<MaintenanceWindow> {
  const w = run.row;
  const from: WindowStatus[] = opts.auto ? ['analyzing'] : ['pending_review'];
  // Before the transition: the worker sweep must not settle the window before its release row exists.
  validationsInFlight.add(w.id);
  let release;
  try {
    // decided_by / scan_override recorded now: the sweep and the recovery finish with the right decision.
    if (!(await run.transition(from, 'validating', { error: null, decided_by: opts.userId, scan_override: opts.override },
      opts.auto ? 'validation automatique' : `validation par l’utilisateur #${opts.userId}`))) {
      throw conflict('This window is not waiting for a review', 'windowNotPending');
    }
    const stored = json<StoredAnalysis | null>(w.analysis, null);
    try {
      release = await releaseService.publishCommit(w.site_id, {
        commitSha: w.candidate_commit as string, baseReleaseId: w.base_release_id, trigger: 'window', windowId: w.id,
        userId: opts.userId, message: opts.message?.trim() || `Fenêtre #${w.number}`, scan: stored?.scan ?? null,
        scanOverrideBy: opts.override ? opts.userId : null, approvedBy: opts.userId,
      });
    } catch (err) {
      await run.transition(['validating'], opts.auto ? 'analyzing' : 'pending_review', {
        decided_by: null, scan_override: false,
        error: withDetail('publication refusée', err instanceof AppError ? `${err.code ?? ''} ${err.message}`.trim() : err),
      });
      throw err;
    }
  } catch (err) {
    validationsInFlight.delete(w.id);
    throw err;
  }
  try {
    await run.step('info', `release #${release.number} en cours de publication`);
  } finally {
    track(finishValidation(w.id, release.id, opts, who));
  }
  return toWindow(await fetchRow(w.id) as WindowRow);
}

/** Human validation (window.service checked access, override, base, conflicts). */
export async function validateWindow(windowId: number, opts: ValidateOpts, who: AuditCtx): Promise<MaintenanceWindow> {
  return startValidation(await loadRun(windowId), opts, who);
}

/** Windows whose validation is followed by a finishValidation of this process (the worker sweep skips them). */
const validationsInFlight = new Set<number>();
const RELEASE_IN_FLIGHT = ['queued', 'scanning', 'publishing'];

async function finishValidation(windowId: number, releaseId: number, opts: ValidateOpts, who: AuditCtx | null): Promise<void> {
  try {
    const siteId = (await fetchRow(windowId) as WindowRow).site_id;
    let rel: { id: number; number: number; status: string; error?: string | null } | null = null;
    try {
      rel = await releaseService.waitForRelease(siteId, releaseId, VALIDATION_TIMEOUT_MS);
    } catch (err) {
      // Transient (DB…): the window stays 'validating', the worker sweep settles it from the release status.
      logger.warn({ err, windowId, releaseId }, 'Windows: waiting for the validation release failed (the worker settles it)');
      return;
    }
    if (RELEASE_IN_FLIGHT.includes(rel.status)) {
      // Long publication: never back to review while the release may still go live; the worker settles it.
      logger.info({ windowId, releaseId, status: rel.status }, 'Windows: validation release still in flight (the worker settles it)');
      return;
    }
    await exclusive(windowId, async () => {
      const run = await loadRun(windowId);
      if (run.row.status !== 'validating') return;
      await settleValidation(run, rel as NonNullable<typeof rel>, opts, who);
    });
  } finally {
    validationsInFlight.delete(windowId);
  }
}

/**
 * A 'validating' window from the state of its release (caller holds
 * exclusive): ready ⇒ validated; failed / rejected / awaiting_approval ⇒
 * back to pending_review — a release left awaiting approval is REJECTED first
 * (it must never be approvable once the window is decided elsewhere); still in
 * flight ⇒ nothing (false).
 */
async function settleValidation(run: WinRun, rel: { id: number; number: number; status: string; error?: string | null } | null,
  opts: ValidateOpts, who: AuditCtx | null): Promise<boolean> {
  if (rel && RELEASE_IN_FLIGHT.includes(rel.status)) return false;
  if (rel?.status === 'ready') {
    await completeValidation(run, rel.id, rel.number, opts, who);
    return true;
  }
  if (rel?.status === 'awaiting_approval') {
    try {
      await releaseService.dismissAwaiting(run.row.site_id, rel.id, `fenêtre #${run.row.number} renvoyée en revue`);
    } catch (err) {
      // Not rejected: approve() refuses a window release whose window is not validating anyway.
      run.line('warn', withDetail(`la release #${rel.number} n’a pas pu être écartée`, err));
    }
  }
  const why = !rel ? 'aucune release de validation trouvée'
    : rel.status === 'awaiting_approval' ? `la release #${rel.number} attendait une approbation (écartée)`
      : `la publication de la release #${rel.number} a échoué`;
  const moved = await run.transition(['validating'], 'pending_review', {
    decided_by: null, scan_override: false, error: withDetail(why, rel?.error ?? rel?.status ?? null),
  }, why);
  if (moved) {
    notifyWindow(run, 'window.failed', `Validation de fenêtre en échec : ${run.ctx.site.name}`,
      `La validation de la fenêtre #${run.row.number} du site ${run.ctx.site.name} a échoué (${why}) ; elle reste en attente de revue.`);
  }
  return true;
}

async function validationRelease(row: Pick<WindowRow, 'id' | 'site_id'>): Promise<{ id: number; number: number; status: string; error: string | null } | null> {
  return await db('releases').where({ site_id: row.site_id, window_id: row.id }).orderBy('id', 'desc')
    .first('id', 'number', 'status', 'error') as { id: number; number: number; status: string; error: string | null } | undefined ?? null;
}

/**
 * Worker (every tick): 'validating' windows no finishValidation of this
 * process follows (wait failed, timeout on a long publication) are settled
 * from the status of their release.
 */
export async function sweepValidations(): Promise<number> {
  const rows = await windowQuery().where('w.status', 'validating').orderBy('w.id') as WindowRow[];
  let settled = 0;
  for (const row of rows) {
    if (validationsInFlight.has(row.id)) continue;
    try {
      const done = await exclusive(row.id, async () => {
        if (validationsInFlight.has(row.id)) return false;
        const run = await loadRun(row.id);
        if (run.row.status !== 'validating') return false;
        const rel = await validationRelease(run.row);
        return settleValidation(run, rel, { userId: run.row.decided_by, auto: !run.row.decided_by, override: run.row.scan_override, message: null }, null);
      }, true);
      if (done) settled++;
    } catch (err) {
      logger.warn({ err, windowId: row.id }, 'Windows: validation sweep failed for a window');
    }
  }
  return settled;
}

/** Release ready: staging reflection, overlay removed, validated. Also the recovery path. */
async function completeValidation(run: WinRun, releaseId: number, releaseNumber: number, opts: ValidateOpts, who: AuditCtx | null): Promise<void> {
  const deps = windowDeps();
  const files = await db('window_files').where({ window_id: run.id, ignored: false })
    .select('path', 'change', 'type', 'size') as Array<{ path: string; change: ChangedPath['change']; type: ChangedPath['type']; size: number | null }>;
  try {
    const r = await deps.changeset.reflectToStaging(run.row.site_id, { kind: 'window', windowId: run.id },
      files.map((f) => ({ path: f.path, change: f.change, type: f.type, size: f.size === null ? null : Number(f.size) })));
    run.line('info', `staging mis à jour : ${r.written} écrit(s), ${r.deleted} supprimé(s)`);
    if (r.conflicts.length) run.line('warn', `chemins du staging non mis à jour (lien ou fichier en travers) : ${r.conflicts.slice(0, 20).join(', ')}`);
  } catch (err) {
    run.line('warn', withDetail('le staging n’a pas pu être mis à jour (la release est en ligne)', err));
  }
  const gone = run.row.overlay === 'unmounted' || run.row.overlay === 'none';
  const unmounted = gone ? true : await unmount(run, false);
  if (gone) await dropWindowFiles(run);
  if (unmounted) await reload(run);
  const ok = await run.transition(['validating'], 'validated', {
    result_release_id: releaseId, overlay: unmounted ? 'unmounted' : run.row.overlay,
    decision: opts.auto ? 'auto_validated' : 'validated', decided_by: opts.userId, decided_at: deps.now(), scan_override: opts.override,
  }, `validée : release #${releaseNumber} en ligne`);
  if (!ok) return;
  await releaseSnapshots(run.id);
  await audit(run, opts.auto ? 'window.auto_validate' : 'window.validate', who, { releaseId, releaseNumber, override: opts.override });
  if (opts.auto) {
    notifyWindow(run, 'window.autoValidated', `Fenêtre validée automatiquement : ${run.ctx.site.name}`,
      `La fenêtre #${run.row.number} du site ${run.ctx.site.name} a été validée automatiquement : release #${releaseNumber} en ligne.`);
  }
  await afterFinal(run, true);
}

// ── rejection ────────────────────────────────────────────────────────────────

export interface RejectOpts { userId: number | null; reason: string | null; restoreDatabases: boolean }

const RESTORE_MARKER = 'restauration des bases demandée';

export async function rejectWindow(siteId: number, windowId: number, opts: RejectOpts, who: AuditCtx): Promise<MaintenanceWindow> {
  const row = await fetchRow(windowId);
  if (!row || row.site_id !== siteId) throw new AppError(404, 'Window not found', 'notFound');
  if (row.status !== 'pending_review') throw conflict('This window is not waiting for a review', 'windowNotPending');
  const run = new WinRun(await siteCtx(siteId), row);
  const why = opts.reason?.trim() ? opts.reason.trim().slice(0, 500) : null;
  if (!(await run.transition(['pending_review'], 'rejecting', { decision_reason: why, decided_by: opts.userId },
    `rejet par l’utilisateur #${opts.userId}${opts.restoreDatabases ? ` (${RESTORE_MARKER})` : ''}`))) {
    throw conflict('This window is not waiting for a review', 'windowNotPending');
  }
  track(runReject(windowId, opts, who));
  return toWindow(await fetchRow(windowId) as WindowRow);
}

/** rejecting → overlay removed → reload → [DB restore] → rejected. Idempotent (recovery). */
export async function runReject(windowId: number, opts: RejectOpts, who: AuditCtx | null): Promise<void> {
  await exclusive(windowId, async () => {
    const deps = windowDeps();
    const run = await loadRun(windowId);
    if (run.row.status !== 'rejecting') return;
    if (run.row.overlay !== 'unmounted' && run.row.overlay !== 'none') {
      if (!(await unmount(run, false))) {
        await failWindow(run, 'rejet : la couche n’a pas pu être retirée', who);
        return;
      }
      await run.save({ overlay: 'unmounted' });
    } else {
      await dropWindowFiles(run);
    }
    await reload(run);
    let restored = false;
    if (opts.restoreDatabases) {
      try {
        const snaps = (await deps.snapshots.listForWindow(windowId)).filter((s) => s.status === 'ready');
        if (!snaps.length) {
          run.line('warn', 'aucun cliché prêt à restaurer');
        } else {
          const r = await deps.snapshots.restore(snaps.map((s) => s.id), { userId: opts.userId, reason: `rejet de la fenêtre #${run.row.number}` });
          restored = r.restored > 0;
          run.line(r.failed.length ? 'warn' : 'info', `bases restaurées : ${r.restored}${r.failed.length ? `, ${r.failed.length} en échec` : ''}`);
          for (const f of r.failed) run.line('warn', withDetail(`restauration du cliché #${f.id} en échec`, f.error));
        }
      } catch (err) {
        run.line('warn', withDetail('restauration des bases impossible', err));
      }
    }
    const ok = await run.transition(['rejecting'], 'rejected', {
      decision: 'rejected', decided_at: deps.now(), db_restored: restored, overlay: 'unmounted',
    }, 'fenêtre rejetée : le site sert la release de base');
    if (!ok) return;
    if (run.row.candidate_ref) await deps.changeset.deleteCandidateRef(run.row.site_id, run.row.candidate_ref);
    await releaseSnapshots(run.id);
    await audit(run, 'window.reject', who, { reason: run.row.decision_reason, restoreDatabases: opts.restoreDatabases });
    if (restored) await audit(run, 'window.restore_db', who);
    await afterFinal(run, true);
  });
}

// ── boot recovery (§5.4) ─────────────────────────────────────────────────────

/**
 * Overlays mounted (hostd.listWindows) + non-final rows: opening ⇒ removed,
 * failed; open not mounted ⇒ ensureWindow(rw) (host rebooted), expired ⇒
 * closed; closing / analyzing ⇒ freeze + analysis; pending_review + overlay ro
 * ⇒ ensureWindow(ro); validating ⇒ release ready ⇒ finish, awaiting approval
 * ⇒ release dismissed + pending_review, failed ⇒ pending_review, in flight ⇒
 * left to the worker sweep; rejecting ⇒ redone (with the requested restore). Overlay mounted without a non-final row ⇒
 * unmounted. NEVER a rw remount of a window that is not open (M2).
 */
export async function recover(): Promise<void> {
  const deps = windowDeps();
  const rows = await windowQuery().whereIn('w.status', WINDOW_ACTIVE_STATUSES as WindowStatus[]).orderBy('w.id') as WindowRow[];
  const nodes = await db('hosting_accounts').distinct('node_id').pluck('node_id') as number[];
  const mounted = new Map<number, { mode: 'rw' | 'ro'; accountId: number; siteId: number; releaseNumber: number }>();
  let listed = true;
  for (const node of nodes) {
    try {
      for (const m of await deps.hostd(node).listWindows()) mounted.set(m.windowId, m);
    } catch (err) {
      listed = false;
      logger.warn({ err, node }, 'Windows recovery: cannot list the mounted overlays');
    }
  }
  const activeIds = new Set(rows.map((r) => r.id));

  for (const row of rows) {
    try {
      await recoverOne(row, listed ? mounted.get(row.id) ?? null : undefined);
    } catch (err) {
      logger.warn({ err, windowId: row.id }, 'Windows recovery failed for a window');
    }
  }
  // Orphan overlays: mounted without a non-final row.
  for (const [windowId, m] of mounted) {
    if (activeIds.has(windowId)) continue;
    try {
      const ctx = await siteCtx(m.siteId);
      await deps.hostd(ctx.account.node_id).removeWindow({ ...ctx.spec, windowId }, { keepExport: false });
      await db('maintenance_windows').where({ id: windowId }).whereNotIn('status', WINDOW_ACTIVE_STATUSES as WindowStatus[]).update({ overlay: 'unmounted' });
      logger.warn({ windowId, siteId: m.siteId }, 'Windows recovery: orphan overlay unmounted');
      await deps.reloadSite(m.siteId).catch(() => {});
    } catch (err) {
      logger.warn({ err, windowId }, 'Windows recovery: cannot unmount an orphan overlay');
    }
  }
}

/** mount: the hostd entry, null = not mounted, undefined = unknown (hostd unreachable). */
async function recoverOne(row: WindowRow, mount: { mode: 'rw' | 'ro' } | null | undefined): Promise<void> {
  const deps = windowDeps();
  const run = new WinRun(await siteCtx(row.site_id), row);
  const hostd = deps.hostd(run.ctx.account.node_id);
  const remount = async (mode: 'rw' | 'ro', quarantine: boolean): Promise<void> => {
    await hostd.ensureWindow({ ...windowSpec(run), releaseNumber: row.base_release_number as number, mode, quarantineExecutables: quarantine });
  };
  switch (row.status) {
    case 'opening':
      run.row.overlay = 'rw';
      await failWindow(run, 'ouverture interrompue par un redémarrage');
      return;
    case 'open': {
      const expired = row.expires_at && new Date(row.expires_at).getTime() <= deps.now().getTime();
      if (mount === null) {
        if (expired) {
          // Not remounted rw: the close path freezes (mounts ro) and analyses.
          run.line('warn', 'fenêtre échue pendant l’arrêt : fermeture');
          await closeWindow(row.site_id, row.id, row.trigger === 'scheduled' ? 'schedule' : 'expired', { userId: null, ip: null });
          return;
        }
        const quarantine = row.trigger === 'supervised' && !(row.exec_allowed_until && new Date(row.exec_allowed_until).getTime() > deps.now().getTime());
        await remount('rw', quarantine);
        await run.step('warn', 'couche remontée après un redémarrage de l’hôte', { overlay: 'rw' });
        const prop = await checkPropagation(run);
        if (prop) await failWindow(run, prop);
        return;
      }
      if (expired) await closeWindow(row.site_id, row.id, row.trigger === 'scheduled' ? 'schedule' : 'expired', { userId: null, ip: null });
      return;
    }
    case 'closing':
    case 'analyzing':
      if (row.overlay !== 'unmounted' && mount === null) {
        await remount('ro', false);
        await run.step('warn', 'couche remontée gelée après un redémarrage', { overlay: 'ro' });
      }
      track(runClose(row.id));
      return;
    case 'pending_review':
      if (row.overlay === 'ro' && mount === null) {
        await remount('ro', false);
        await run.step('warn', 'couche gelée remontée après un redémarrage');
      } else if (mount && mount.mode === 'rw') {
        // Never rw outside 'open' (M2).
        await remount('ro', false);
        await run.step('warn', 'couche trouvée inscriptible hors fenêtre ouverte : gelée', { overlay: 'ro' });
      }
      return;
    case 'validating': {
      const rel = await validationRelease(row);
      if (rel?.status === 'ready') {
        if (row.overlay === 'ro' && mount === null) run.row.overlay = 'unmounted';
      } else if (row.overlay === 'ro' && mount === null) {
        await remount('ro', false);
      }
      // Same settlement as the worker sweep (a release awaiting approval is dismissed; in flight ⇒ the sweep finishes it).
      await exclusive(row.id, () => settleValidation(run, rel,
        { userId: row.decided_by, auto: !row.decided_by, override: row.scan_override, message: null }, null));
      return;
    }
    case 'rejecting': {
      // §5.4 "rejecting ⇒ refaire": the requested restore is redone (restoring the same snapshots again is idempotent).
      const restore = json<ReleaseLogLine[]>(row.log, []).some((l) => l.message.includes(RESTORE_MARKER));
      if (restore) run.line('warn', 'rejet interrompu par un redémarrage : restauration des bases relancée');
      await run.save();
      track(runReject(row.id, { userId: row.decided_by, reason: row.decision_reason, restoreDatabases: restore }, null));
      return;
    }
    default:
  }
}
