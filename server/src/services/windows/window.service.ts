import type { Request } from 'express';
import type {
  ChangeAnalysisSummary, MaintenanceWindow, MaintenanceWindowDetail, MaintenanceWindowListItem, SiteMaintenanceInfo,
  SiteMaintenanceSettings, SiteMaintenanceSettingsUpdate, WindowCloseReason, WindowExtendRequest, WindowFile, WindowFileDiff,
  WindowOpenRequest, WindowRejectRequest, WindowStatus, WindowTrigger, WindowValidateRequest,
} from '@oblimint/shared';
import { WINDOW_ACTIVE_STATUSES } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { clientIp } from '../../utils/clientIp';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { actorCan, assertNeedSomewhere, assertReadsCode, loadSite, scopeToActor, type HostingActor } from '../hosting/access';
import { siteUpstream } from '../hosting/naming';
import { healthcheckHost, releaseService } from '../releases/release.service';
import { windowDeps } from './deps';
import {
  activeRow, closeWindow, digest, endExecAllowance, extendWindow, fetchRow, idle, liveBase, openRefusal, openWindow, reanalyze,
  purgeFailedExports, recover, rejectWindow, retryClosings, retryStaleOverlays, rowBlocks, settingsOf, siteCtx, staleOverlay, sweepValidations, track,
  validateWindow,
  type AuditCtx, type StoredAnalysis,
} from './engine';
import { validationVerdict } from './policy';
import { detailParts, json, toWindow, toWindowFile, windowForActor, windowQuery, type WindowFileRow, type WindowRow } from './rows';
import { userCanPublish } from './guarantor';
import { applySettingsUpdate, mergeSettings, nextWindowAt } from './settings';

// ─────────────────────────────────────────────────────────────────────────────
// Modification windows (ARCHITECTURE §2.2, docs/P3-PLAN.md §5–§6).
// OWNED BY MODULE `windows`. The lifecycle itself lives in engine.ts; this
// file is the API of the module (access checks, audit at request time) and
// its worker (scheduler, expiries, kicks, supervised mode, boot recovery).
//
// Public methods take the resolved actor and check access themselves with
// loadSite(actor, siteId, need) (404 invisible / 403 no right), like P2.
// Internal methods (other modules, API tokens, scheduler) do no access check.
// ─────────────────────────────────────────────────────────────────────────────

/** Who opens a window (internal callers: scheduler, supervised mode, API token). */
export interface WindowOpenOrigin {
  trigger: WindowTrigger;
  userId: number | null;
  tokenId?: number | null;
  tokenName?: string | null;
  /** null = no expiry (supervised). */
  durationMinutes: number | null;
  note?: string | null;
}

export interface WindowListQuery {
  limit: number;
  offset: number;
  status?: WindowStatus | 'active' | null;
}

export interface WindowFilesQuery {
  change?: 'added' | 'modified' | 'deleted' | 'typechange' | null;
  minRisk?: number | null;
  q?: string | null;
  limit: number;
  offset: number;
}

export interface MaintenanceListFilters {
  status?: WindowStatus | 'active' | null;
  accountId?: number | null;
  tenantId?: number | null;
  limit: number;
  offset: number;
}

const ALL_STATUSES: readonly WindowStatus[] = [
  'opening', 'open', 'closing', 'analyzing', 'pending_review', 'validating', 'validated', 'rejecting', 'rejected', 'discarded', 'failed',
];
/** Worker period (expiries, scheduler, kicks). */
const TICK_MS = 30_000;
/** A scheduled window requests its kickPath this often. */
export const KICK_INTERVAL_MS = 5 * 60_000;
const KICK_TIMEOUT_MS = 30_000;
/** A supervised site whose permanent window could not be (re)opened is retried after this. */
const SUPERVISED_RETRY_MS = 10 * 60_000;
/** Consecutive failed supervised windows after which the worker stops reopening (toggle the mode to retry). */
export const SUPERVISED_MAX_FAILURES = 5;
const DIFF_MAX_BYTES = 256 * 1024;

/**
 * Settings that end in writable live code or in a publication without a human
 * (schedule + auto-validation, supervised permanent window): changing them
 * needs releases.publish on top of sites.manage, like opening a window.
 */
const PUBLISH_SETTINGS = ['schedule', 'autoValidate', 'supervised'] as const;

function publishSettingsChanged(before: SiteMaintenanceSettings, after: SiteMaintenanceSettings): string[] {
  return PUBLISH_SETTINGS.filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
}

const who = (req: Request, actor: HostingActor): AuditCtx => ({ userId: actor.userId, ip: clientIp(req) || null });

function statusFilter<T extends { whereIn(c: string, v: readonly string[]): T; where(c: string, v: string): T }>(qb: T, col: string, status: string | null | undefined): T {
  if (!status) return qb;
  if (status === 'active') return qb.whereIn(col, WINDOW_ACTIVE_STATUSES);
  if (!(ALL_STATUSES as readonly string[]).includes(status)) throw new AppError(400, 'Unknown window status', 'validation');
  return qb.where(col, status);
}

async function windowOfSite(siteId: number, windowId: number): Promise<WindowRow> {
  const row = await fetchRow(windowId);
  if (!row || row.site_id !== siteId) throw new AppError(404, 'Window not found', 'notFound');
  return row;
}

/** Analysis as the API shows it (internal fields dropped). */
function publicAnalysis(a: StoredAnalysis | null): ChangeAnalysisSummary | null {
  if (!a) return null;
  const { scan: _scan, tooLarge: _tooLarge, ...rest } = a;
  return rest;
}

async function detailOf(row: WindowRow): Promise<MaintenanceWindowDetail> {
  const deps = windowDeps();
  const parts = detailParts(row);
  let snapshotList: MaintenanceWindowDetail['snapshotList'] = [];
  try { snapshotList = await deps.snapshots.listForWindow(row.id); } catch { /* snapshots module not available */ }
  let live: MaintenanceWindowDetail['live'] = null;
  if (row.status === 'open' && row.overlay === 'rw') {
    try {
      const node = await db('hosting_accounts').where({ id: row.account_id }).first('node_id') as { node_id: number } | undefined;
      if (node) {
        const st = await deps.hostd(node.node_id).windowStatus(row.account_id, row.site_id, row.id);
        live = st.mounted ? { upperBytes: st.upperBytes, upperEntries: st.upperEntries } : null;
      }
    } catch { /* hostd unreachable: no live view */ }
  }
  const site = await db('sites').where({ id: row.site_id }).first('current_release_id') as { current_release_id: number | null } | undefined;
  const stale = (WINDOW_ACTIVE_STATUSES as readonly string[]).includes(row.status) && (site?.current_release_id ?? null) !== row.base_release_id;
  return {
    ...toWindow(row),
    ...parts,
    analysis: publicAnalysis(json<StoredAnalysis | null>(row.analysis, null)),
    snapshotList,
    live,
    stale,
  };
}

// ── worker state ─────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let running = false;
let ticking = false;
const supervisedBackoff = new Map<number, number>();

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    // Steps isolated: one failing (DB hiccup) does not starve the others.
    const steps: Array<[string, () => Promise<unknown>]> = [
      ['expiries', expireWindows], ['execAllowances', endExecAllowances], ['schedules', runSchedules], ['kicks', kickScheduledWindows],
      ['validations', sweepValidations], ['closings', retryClosings], ['staleOverlays', retryStaleOverlays],
      ['exports', purgeFailedExports], ['supervised', ensureSupervised],
    ];
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (err) {
        logger.warn({ err, step: name }, 'Windows worker tick step failed');
      }
    }
  } finally {
    ticking = false;
  }
}

async function expireWindows(): Promise<void> {
  const now = windowDeps().now();
  const rows = await db('maintenance_windows').where({ status: 'open' }).whereNotNull('expires_at').where('expires_at', '<=', now)
    .select('id', 'site_id', 'trigger') as Array<{ id: number; site_id: number; trigger: WindowTrigger }>;
  for (const r of rows) {
    try {
      await closeWindow(r.site_id, r.id, r.trigger === 'scheduled' ? 'schedule' : 'expired', { userId: null, ip: null });
    } catch (err) {
      logger.warn({ err, windowId: r.id }, 'Windows: cannot close an expired window');
    }
  }
}

async function endExecAllowances(): Promise<void> {
  const now = windowDeps().now();
  const ids = await db('maintenance_windows').where({ status: 'open', trigger: 'supervised' }).whereNotNull('exec_allowed_until')
    .where('exec_allowed_until', '<=', now).pluck('id') as number[];
  for (const id of ids) track(endExecAllowance(id));
}

async function runSchedules(): Promise<void> {
  const now = windowDeps().now();
  const due = await db('site_maintenance').whereNotNull('next_window_at').where('next_window_at', '<=', now)
    .select('site_id', 'settings') as Array<{ site_id: number; settings: unknown }>;
  for (const d of due) {
    const settings = mergeSettings(json(d.settings, {}));
    // Next occurrence first: a failure (site stopped, window active…) waits for the next one.
    await db('site_maintenance').where({ site_id: d.site_id }).update({ next_window_at: nextWindowAt(settings, now), updated_at: db.fn.now() });
    const sched = settings.schedule;
    if (!sched?.enabled) continue;
    // The user who last vouched for the publication settings (site_maintenance.updated_by) must still be
    // allowed to publish: a scheduled window makes the live code writable and may auto-validate.
    const guard = await db('sites as s').join('site_maintenance as m', 'm.site_id', 's.id').where('s.id', d.site_id)
      .first('s.tenant_id', 's.account_id', 'm.updated_by') as { tenant_id: number; account_id: number; updated_by: number | null } | undefined;
    if (!guard || !(await userCanPublish(guard.updated_by, { tenantId: guard.tenant_id, accountId: guard.account_id }))) {
      logger.warn({ siteId: d.site_id, userId: guard?.updated_by ?? null }, 'Windows: scheduled window not opened (its author may no longer publish on this site)');
      continue;
    }
    try {
      await openWindow(d.site_id, { trigger: 'scheduled', userId: null, durationMinutes: sched.durationMinutes, note: 'fenêtre planifiée' }, { userId: null, ip: null });
      logger.info({ siteId: d.site_id }, 'Windows: scheduled window opened');
    } catch (err) {
      logger.info({ siteId: d.site_id, code: (err as AppError)?.code, err: (err as Error)?.message }, 'Windows: scheduled window not opened (next occurrence kept)');
    }
  }
}

async function kickScheduledWindows(): Promise<void> {
  const deps = windowDeps();
  const now = deps.now();
  const rows = await db('maintenance_windows').where({ status: 'open', trigger: 'scheduled' })
    .where((q) => q.whereNull('last_kick_at').orWhere('last_kick_at', '<=', new Date(now.getTime() - KICK_INTERVAL_MS)))
    .select('id', 'site_id') as Array<{ id: number; site_id: number }>;
  for (const r of rows) {
    const kickPath = (await settingsOf(r.site_id)).schedule?.kickPath;
    await db('maintenance_windows').where({ id: r.id }).update({ last_kick_at: now });
    if (!kickPath) continue;
    try {
      const res = await deps.probe(siteUpstream(r.site_id) + kickPath, await healthcheckHost(r.site_id), KICK_TIMEOUT_MS);
      logger.debug({ windowId: r.id, status: res.status, error: res.error }, 'Windows: kickPath requested');
    } catch (err) {
      logger.debug({ err, windowId: r.id }, 'Windows: kickPath request failed');
    }
  }
}

async function ensureSupervised(): Promise<void> {
  const now = windowDeps().now().getTime();
  const sites = await db('site_maintenance').whereRaw(`(settings->>'supervised') = 'true'`).pluck('site_id') as number[];
  for (const siteId of sites) {
    if ((supervisedBackoff.get(siteId) ?? 0) > now) continue;
    if (await activeRow(siteId)) continue;
    // Persisted back-off: openWindow returns once the 'opening' row exists, a mount / propagation failure ends
    // later in 'failed'. Consecutive failed supervised windows delay the next one (n × SUPERVISED_RETRY_MS),
    // and stop the automatic reopening after SUPERVISED_MAX_FAILURES (toggling the mode retries at once).
    const recent = await db('maintenance_windows').where({ site_id: siteId, trigger: 'supervised' }).orderBy('id', 'desc')
      .limit(SUPERVISED_MAX_FAILURES).select('status', 'updated_at') as Array<{ status: WindowStatus; updated_at: Date | string }>;
    let failures = 0;
    while (failures < recent.length && recent[failures].status === 'failed') failures++;
    if (failures >= SUPERVISED_MAX_FAILURES) continue;
    if (failures && new Date(recent[0].updated_at).getTime() + failures * SUPERVISED_RETRY_MS > now) continue;
    try {
      await openWindow(siteId, { trigger: 'supervised', userId: null, durationMinutes: null, note: null }, { userId: null, ip: null });
      supervisedBackoff.delete(siteId);
    } catch (err) {
      supervisedBackoff.set(siteId, now + SUPERVISED_RETRY_MS);
      logger.info({ siteId, code: (err as AppError)?.code }, 'Windows: supervised window not opened (retry later)');
    }
  }
}

// ── public service ───────────────────────────────────────────────────────────

export const windowService = {
  // ── settings / info (GET|PUT /sites/:id/maintenance) ──
  async info(actor: HostingActor, siteId: number): Promise<SiteMaintenanceInfo> {
    const site = await loadSite(actor, siteId, 'read');
    const deps = windowDeps();
    const ms = await deps.settings.maintenance();
    const settings = await settingsOf(site.id);
    const active = await activeRow(site.id);
    const sm = await db('site_maintenance').where({ site_id: site.id }).first('next_window_at') as { next_window_at: Date | string | null } | undefined;
    const pendingCount = await db('maintenance_windows').where({ site_id: site.id, status: 'pending_review' }).count<{ n: string }[]>('* as n');
    let reason: SiteMaintenanceInfo['cannotOpenReason'] = null;
    if (!ms.windowsEnabled) reason = 'windowsDisabled';
    else if (active && !(active.trigger === 'supervised' && active.status === 'open')) reason = 'windowActive';
    else {
      const ctx = await siteCtx(site.id);
      const refusal = await openRefusal(ctx);
      if (refusal) reason = refusal.code === 'accountSuspended' ? 'accountSuspended' : 'siteStopped';
      else if (!(await liveBase(ctx))) reason = 'noRelease';
      else if (await releaseService.pipelineBusy(site.id)) reason = 'publishInProgress';
    }
    return {
      siteId: site.id,
      settings,
      activeWindow: active ? windowForActor(actor, toWindow(active)) : null,
      nextScheduledAt: sm?.next_window_at ? new Date(sm.next_window_at).toISOString() : null,
      pendingReviews: Number(pendingCount[0]?.n ?? 0),
      canOpen: reason === null,
      cannotOpenReason: reason,
      maxWindowMinutes: ms.maxWindowMinutes,
    };
  },

  async updateSettings(req: Request, actor: HostingActor, siteId: number, body: SiteMaintenanceSettingsUpdate): Promise<SiteMaintenanceInfo> {
    const site = await loadSite(actor, siteId, 'sites.manage');
    const deps = windowDeps();
    const ms = await deps.settings.maintenance();
    const now = deps.now();
    const current = await settingsOf(site.id);
    const next = applySettingsUpdate(current, body, ms.maxWindowMinutes, now);
    const target = { tenantId: site.tenant_id, accountId: site.account_id };
    const sensitive = publishSettingsChanged(current, next);
    const canPublish = actorCan(actor, 'releases.publish', target);
    if (sensitive.length && !canPublish) {
      throw new AppError(403, `Changing ${sensitive.join(', ')} needs the right to publish (releases.publish)`, 'forbidden', { settings: sensitive });
    }
    const ids = next.snapshot.mode === 'selected' ? next.snapshot.databaseIds : [];
    if (ids.length) {
      // Only databases of the site's account (instance of the same account).
      const owned = await db('db_databases as d').join('db_instances as i', 'i.id', 'd.instance_id')
        .whereIn('d.id', ids).where('d.account_id', site.account_id).where('i.account_id', site.account_id).pluck('d.id') as number[];
      if (owned.length !== ids.length) throw new AppError(400, 'A selected database does not belong to this site’s account', 'validation');
    }
    // updated_by = the guarantor of the publication settings (checked when a scheduled window fires):
    // only a user who may publish takes that role over.
    await db('site_maintenance').insert({
      site_id: site.id, settings: JSON.stringify(next), next_window_at: nextWindowAt(next, now), updated_by: actor.userId,
    }).onConflict('site_id').merge({
      settings: JSON.stringify(next), next_window_at: nextWindowAt(next, now), updated_at: db.fn.now(),
      ...(canPublish ? { updated_by: actor.userId } : {}),
    });
    await auditService.logReqAs(req, site.tenant_id, 'site.maintenance', {
      resourceType: 'site', resourcePath: String(site.id), details: { siteId: site.id, changes: Object.keys(body) },
    });
    await applySupervisedToggle(site.id, current, next, who(req, actor));
    return this.info(actor, site.id);
  },

  /** Settings of a site, defaults merged (internal). */
  async settingsOf(siteId: number): Promise<SiteMaintenanceSettings> {
    return settingsOf(siteId);
  },

  // ── windows of a site ──
  async list(actor: HostingActor, siteId: number, q: WindowListQuery): Promise<{ items: MaintenanceWindow[]; total: number }> {
    const site = await loadSite(actor, siteId, 'read');
    const base = () => statusFilter(db('maintenance_windows as w').where('w.site_id', site.id), 'w.status', q.status ?? null);
    const [rows, count] = await Promise.all([
      statusFilter(windowQuery().where('w.site_id', site.id), 'w.status', q.status ?? null).orderBy('w.number', 'desc').limit(q.limit).offset(q.offset) as Promise<WindowRow[]>,
      base().count<{ n: string }[]>('* as n'),
    ]);
    return { items: rows.map((r) => windowForActor(actor, toWindow(r))), total: Number(count[0]?.n ?? 0) };
  },

  async listAll(actor: HostingActor, f: MaintenanceListFilters): Promise<{ items: MaintenanceWindowListItem[]; total: number }> {
    // The tenant filter alone is not a right: a staff member without read (users.manage only…) gets 403 (M8).
    if (actor.kind === 'staff') assertNeedSomewhere(actor, 'read');
    const scoped = (qb: ReturnType<typeof db>) => {
      scopeToActor(actor, qb, { tenant: 'w.tenant_id', account: 'w.account_id' }, f.tenantId ?? null);
      statusFilter(qb, 'w.status', f.status ?? null);
      if (f.accountId) qb.where('w.account_id', f.accountId);
      return qb;
    };
    const rowsQ = scoped(windowQuery()
      .join('sites as s', 's.id', 'w.site_id')
      .join('hosting_accounts as a', 'a.id', 'w.account_id')
      .select('s.name as site_name', 's.slug as site_slug', 'a.username as account_username'));
    const [rows, count] = await Promise.all([
      rowsQ.orderBy('w.updated_at', 'desc').orderBy('w.id', 'desc').limit(f.limit).offset(f.offset) as Promise<WindowRow[]>,
      scoped(db('maintenance_windows as w')).count<{ n: string }[]>('* as n'),
    ]);
    return {
      items: rows.map((r) => ({
        ...windowForActor(actor, toWindow(r)), siteName: r.site_name ?? '', siteSlug: r.site_slug ?? '', accountUsername: r.account_username ?? '',
      })),
      total: Number(count[0]?.n ?? 0),
    };
  },

  async get(actor: HostingActor, siteId: number, windowId: number): Promise<MaintenanceWindowDetail> {
    const site = await loadSite(actor, siteId, 'read');
    return windowForActor(actor, await detailOf(await windowOfSite(site.id, windowId)));
  },

  async open(req: Request, actor: HostingActor, siteId: number, body: WindowOpenRequest): Promise<MaintenanceWindow> {
    const site = await loadSite(actor, siteId, 'releases.publish');
    const settings = await settingsOf(site.id);
    const w = await openWindow(site.id, {
      trigger: 'manual', userId: actor.userId, durationMinutes: body.durationMinutes ?? settings.defaultDurationMinutes, note: body.note ?? null,
    }, who(req, actor));
    return windowForActor(actor, w);
  },

  async extend(req: Request, actor: HostingActor, siteId: number, windowId: number, body: WindowExtendRequest): Promise<MaintenanceWindow> {
    const site = await loadSite(actor, siteId, 'releases.publish');
    return windowForActor(actor, await extendWindow(site.id, windowId, body.minutes, who(req, actor)));
  },

  async close(req: Request, actor: HostingActor, siteId: number, windowId: number): Promise<MaintenanceWindow> {
    const site = await loadSite(actor, siteId, 'releases.publish');
    return windowForActor(actor, await closeWindow(site.id, windowId, 'manual', who(req, actor)));
  },

  async validate(req: Request, actor: HostingActor, siteId: number, windowId: number, body: WindowValidateRequest): Promise<MaintenanceWindow> {
    const site = await loadSite(actor, siteId, 'releases.publish');
    const row = await windowOfSite(site.id, windowId);
    if (row.status !== 'pending_review') throw new AppError(409, 'This window is not waiting for a review', 'windowNotPending');
    const analysis = json<StoredAnalysis | null>(row.analysis, null);
    if (!analysis || !row.candidate_commit) throw new AppError(409, 'This window has not been analysed yet', 'windowNotAnalyzed');
    if (analysis.tooLarge) throw new AppError(409, 'Some changed files are too large for a release', 'windowTooLarge');
    const verdict = validationVerdict(actor, { tenantId: site.tenant_id, accountId: site.account_id, publishMode: site.publish_mode }, {
      blocked: !!analysis.blocked || analysis.verdict === 'infected', score: analysis.risk?.score ?? row.risk_score ?? 0, level: analysis.risk?.level ?? row.risk_level ?? 'none',
    }, !!body.override);
    if (!verdict.ok) throw verdict.error;
    const fresh = await db('sites').where({ id: site.id }).first('current_release_id') as { current_release_id: number | null };
    if ((fresh?.current_release_id ?? null) !== row.base_release_id) {
      throw new AppError(409, 'The base release of this window is no longer the live one', 'windowBaseChanged');
    }
    // Recomputed now: the client may have uploaded since the analysis.
    let conflicts = json<string[]>(row.staging_conflicts, []);
    try {
      const paths = await db('window_files').where({ window_id: row.id, ignored: false }).pluck('path') as string[];
      conflicts = await windowDeps().changeset.stagingConflicts(site.id, row.base_commit as string, paths);
    } catch (err) {
      logger.warn({ err, windowId }, 'Windows: staging conflicts not recomputed');
    }
    if (conflicts.length && !body.force) {
      throw new AppError(409, 'The staging changed since the base release on paths this window writes', 'stagingConflict', { paths: conflicts.slice(0, 200) });
    }
    if (verdict.override) {
      await auditService.logReqAs(req, site.tenant_id, 'window.validate.override', {
        resourceType: 'site', resourcePath: String(site.id),
        details: { siteId: site.id, windowId: row.id, number: row.number, risk: analysis.risk ?? null },
      });
    }
    const w = await validateWindow(row.id, { userId: actor.userId, auto: false, override: verdict.override, message: body.message ?? null }, who(req, actor));
    return windowForActor(actor, w);
  },

  async reject(req: Request, actor: HostingActor, siteId: number, windowId: number, body: WindowRejectRequest): Promise<MaintenanceWindow> {
    const site = await loadSite(actor, siteId, 'releases.publish');
    if (body.restoreDatabases && !actorCan(actor, 'databases.manage', { tenantId: site.tenant_id, accountId: site.account_id })) {
      throw new AppError(403, 'Restoring the databases needs databases.manage');
    }
    const w = await rejectWindow(site.id, windowId, { userId: actor.userId, reason: body.reason ?? null, restoreDatabases: !!body.restoreDatabases }, who(req, actor));
    return windowForActor(actor, w);
  },

  async reanalyze(req: Request, actor: HostingActor, siteId: number, windowId: number): Promise<MaintenanceWindow> {
    const site = await loadSite(actor, siteId, 'releases.publish');
    return windowForActor(actor, await reanalyze(site.id, windowId, who(req, actor)));
  },

  async files(actor: HostingActor, siteId: number, windowId: number, q: WindowFilesQuery): Promise<{ items: WindowFile[]; total: number }> {
    const site = await loadSite(actor, siteId, 'read');
    const row = await windowOfSite(site.id, windowId);
    if (!row.analysis) throw new AppError(409, 'This window has not been analysed yet', 'windowNotAnalyzed');
    const base = () => {
      const qb = db('window_files').where({ window_id: row.id });
      if (q.change) qb.where('change', q.change);
      if (q.minRisk !== null && q.minRisk !== undefined) qb.where('risk', '>=', q.minRisk);
      if (q.q) qb.whereRaw(`path ILIKE ? ESCAPE '\\'`, [`%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`]);
      return qb;
    };
    const [rows, count] = await Promise.all([
      base().orderBy([{ column: 'ignored', order: 'asc' }, { column: 'risk', order: 'desc' }, { column: 'path', order: 'asc' }])
        .limit(q.limit).offset(q.offset).select('*') as Promise<WindowFileRow[]>,
      base().count<{ n: string }[]>('* as n'),
    ]);
    return { items: rows.map(toWindowFile), total: Number(count[0]?.n ?? 0) };
  },

  /** The patch is the code itself: code.read (files.manage or client releases.approve, staff sites.manage too), 'read' only lists files(). */
  async fileDiff(actor: HostingActor, siteId: number, windowId: number, path: string): Promise<WindowFileDiff> {
    const site = await loadSite(actor, siteId, 'read');
    assertReadsCode(actor, site);
    const row = await windowOfSite(site.id, windowId);
    if (!row.candidate_commit || !row.base_commit) throw new AppError(409, 'This window has not been analysed yet', 'windowNotAnalyzed');
    const file = await db('window_files').where({ window_id: row.id, path }).first() as WindowFileRow | undefined;
    if (!file) throw new AppError(404, 'File not in this window', 'notFound');
    if (file.ignored) {
      return {
        path, change: file.change, binary: !!file.binary, patch: null, patchTruncated: false, oldSize: null,
        newSize: file.size === null ? null : Number(file.size),
      };
    }
    const d = await windowDeps().changeset.candidateFileDiff(site.id, row.base_commit, row.candidate_commit, path, DIFF_MAX_BYTES);
    return { path, change: file.change, binary: d.binary, patch: d.patch, patchTruncated: d.truncated, oldSize: d.oldSize, newSize: d.newSize };
  },

  // ── internal (other modules, no access check: the caller checked) ──
  /** Opens a window for the scheduler / an API token / the supervised mode. Same refusals as open(). */
  async openInternal(siteId: number, origin: WindowOpenOrigin, auditCtx?: AuditCtx): Promise<MaintenanceWindow> {
    return openWindow(siteId, origin, auditCtx ?? { userId: origin.userId, ip: null, tokenName: origin.tokenName ?? null });
  },
  async extendInternal(siteId: number, windowId: number, minutes: number, auditCtx?: AuditCtx): Promise<MaintenanceWindow> {
    return extendWindow(siteId, windowId, minutes, auditCtx ?? { userId: null, ip: null });
  },
  async closeInternal(siteId: number, windowId: number, reason: WindowCloseReason, auditCtx?: AuditCtx): Promise<MaintenanceWindow> {
    return closeWindow(siteId, windowId, reason, auditCtx ?? { userId: null, ip: null });
  },
  /** Non-final window of a site (row → API shape), null when none. */
  async activeWindow(siteId: number): Promise<MaintenanceWindow | null> {
    try {
      const row = await activeRow(siteId);
      return row ? toWindow(row) : null;
    } catch {
      return null;
    }
  },
  /**
   * HOOK used by the release pipeline: a window holds the site (its overlay
   * covers the live release, or a transition runs), or the overlay of a FINAL
   * window is still mounted over a release (unmount pending a retry: a
   * rollback / approval onto that release would serve the never-validated
   * layer) → publish / approve / rollback / data-path rebuild refuse with 409
   * windowActive. `exemptWindowId`: the window whose own validation publishes.
   * Never throws; FAILS CLOSED (true) when the state cannot be read: the §5.3
   * invariant is never skipped, the caller retries.
   */
  async blocksPublish(siteId: number, exemptWindowId: number | null = null): Promise<boolean> {
    try {
      if (await staleOverlay(siteId)) return true;
      const row = await activeRow(siteId);
      if (row && exemptWindowId !== null && row.id === exemptWindowId) return false;
      return rowBlocks(row);
    } catch (err) {
      logger.warn({ err, siteId }, 'Windows: blocksPublish check failed (publication refused)');
      return true;
    }
  },
  /**
   * Supervised digest (module supervised-quarantine): exports + analyses the
   * permanent overlay of a supervised site WITHOUT closing it; stores the
   * analysis on the window and returns it. null when the site is not supervised.
   */
  async digestSupervised(siteId: number): Promise<MaintenanceWindowDetail | null> {
    const settings = await settingsOf(siteId);
    if (!settings.supervised) return null;
    const row = await activeRow(siteId);
    if (!row || row.trigger !== 'supervised') return null;
    if (row.status === 'open') await digest(row.id);
    const fresh = await fetchRow(row.id);
    return fresh ? detailOf(fresh) : null;
  },

  // ── workers (scheduler, expiries, kicks, boot recovery) ──
  start(): void {
    if (running) return;
    running = true;
    void (async () => {
      try {
        await recover();
      } catch (err) {
        logger.warn({ err }, 'Windows: boot recovery failed');
      }
      if (!running) return;
      timer = setInterval(() => { void tick(); }, TICK_MS);
      timer.unref?.();
      void tick();
    })();
  },
  stop(): void {
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
  },
};

/** Supervised mode switched on / off (§12): permanent window opened, or closed (reviewed / discarded when empty). */
async function applySupervisedToggle(siteId: number, before: SiteMaintenanceSettings, after: SiteMaintenanceSettings, auditCtx: AuditCtx): Promise<void> {
  if (before.supervised === after.supervised) return;
  try {
    const active = await activeRow(siteId);
    if (after.supervised) {
      if (!active) await openWindow(siteId, { trigger: 'supervised', userId: auditCtx.userId, durationMinutes: null, note: null }, auditCtx);
    } else if (active && active.trigger === 'supervised' && active.status === 'open') {
      await closeWindow(siteId, active.id, 'supervised', auditCtx);
    }
  } catch (err) {
    // The setting is saved; the worker retries the opening (ensureSupervised).
    logger.info({ siteId, code: (err as AppError)?.code }, 'Windows: supervised mode toggle not applied yet');
  }
}

/** Tests only. */
export const __windowInternals = { tick, recover, idle };
