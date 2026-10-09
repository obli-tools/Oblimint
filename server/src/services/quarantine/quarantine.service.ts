import type { Request } from 'express';
import type {
  QuarantineItem, QuarantineItemDetail, QuarantineReason, QuarantineRestoreRequest, QuarantineSource, QuarantineStatus, QuarantineSummary,
  SupervisionInfo,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { HostdError } from '../hostd/client';
import { actorCan, actorSees, assertNeedSomewhere, loadAccount, loadSite, scopeToActor, type HostingActor } from '../hosting/access';
import { iso } from '../hosting/rows';
import { errText } from '../setup/docker';
import { deps } from './deps';
import { defaultHostdRestart, eventLoop, setHostdRestartHandler } from './events';
import { auditReconciliation, claimItem, emitQuarantine, releaseItem, resyncAll } from './ingest';
import { looksLikeText, MISSING_ON_HOST_NOTE, PREVIEW_MAX_BYTES } from './logic';
import { digestForRequest, digestTick, supervisionInfo } from './supervision';
import { queueWatchSync, queueWatchSyncAll, resetWatchState } from './watch';

// ─────────────────────────────────────────────────────────────────────────────
// Quarantine (typed data paths + supervised mode) and supervision digests
// (ARCHITECTURE §2.1, docs/P3-PLAN.md §6.6, §12). MODULE `supervised-quarantine`.
//
// hostd quarantines by itself (inotify watcher on typed paths, upper layer of
// a supervised window) and emits 'quarantined' events; this module consumes
// them (long poll hostdFor().events + periodic resync with listQuarantine:
// ingest.ts / events.ts), records quarantine_items, audits ('quarantine.add'),
// notifies ('quarantine.added'), pushes the watch specs (watch.ts, reconcile
// hook) and serves the viewer: everyone who sees the account reads the list,
// only STAFF previews, restores or deletes (M9: nothing is ever deleted
// silently, every deletion / restore is audited in the account's tenant).
// ─────────────────────────────────────────────────────────────────────────────

export interface QuarantineFilters {
  accountId?: number | null;
  siteId?: number | null;
  status?: QuarantineStatus | null;
  tenantId?: number | null;
  limit: number;
  offset: number;
}

const RESYNC_MS = 10 * 60_000;
const DIGEST_TICK_MS = 5 * 60_000;
const FIRST_DIGEST_TICK_MS = 60_000;

interface ItemRow {
  id: number; tenant_id: number; account_id: number; site_id: number | null; site_name: string | null;
  source: QuarantineSource; reason: QuarantineReason; path: string; data_path: string | null; size_bytes: number | string;
  sha256: string; detected_type: string | null; detail: string | null; hostd_entry_id: string; status: QuarantineStatus;
  detected_at: Date | string; resolved_at: Date | string | null; resolved_by: number | null; resolution_note: string | null;
  /** joined */ account_username: string; resolved_by_name: string | null;
}

function baseQuery() {
  return db('quarantine_items as q')
    .join('hosting_accounts as a', 'a.id', 'q.account_id')
    .leftJoin('users as r', 'r.id', 'q.resolved_by');
}

const COLUMNS = ['q.*', 'a.username as account_username', db.raw('COALESCE(r.display_name, r.username) as resolved_by_name')];

function toItem(r: ItemRow): QuarantineItem {
  return {
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    accountId: Number(r.account_id),
    accountUsername: r.account_username,
    siteId: r.site_id === null ? null : Number(r.site_id),
    siteName: r.site_name,
    source: r.source,
    reason: r.reason,
    path: r.path,
    dataPath: r.data_path,
    sizeBytes: Number(r.size_bytes ?? 0),
    sha256: r.sha256,
    detectedType: r.detected_type,
    detail: r.detail,
    status: r.status,
    detectedAt: iso(r.detected_at)!,
    resolvedAt: iso(r.resolved_at),
    resolvedByName: r.resolved_by_name ?? null,
  };
}

async function rowById(id: number): Promise<ItemRow | null> {
  return (await baseQuery().where('q.id', id).first(COLUMNS) as ItemRow | undefined) ?? null;
}

function notFound(): AppError {
  return new AppError(404, 'Quarantined file not found', 'notFound');
}

/** One row visible to the actor (404 otherwise: no existence oracle), with the 'read' need (403), like loadAccount. */
async function visibleRow(actor: HostingActor, id: number): Promise<ItemRow> {
  if (!Number.isInteger(id) || id <= 0) throw notFound();
  const row = await rowById(id);
  const target = row ? { tenantId: Number(row.tenant_id), accountId: Number(row.account_id) } : null;
  if (!row || !target || !actorSees(actor, target)) throw notFound();
  if (!actorCan(actor, 'read', target)) throw new AppError(403, 'Insufficient permissions');
  return row;
}

function resolvedConflict(status: string): AppError {
  return new AppError(409, `This file is already ${status}`, 'quarantineResolved', { status });
}

/**
 * Restore / delete: visible (404), staff (403 staffOnly), files.manage on the
 * account (403), still quarantined (409), then CLAIMED: a second staff action
 * on the same row while this one runs gets 409 and the ingestion leaves the
 * row alone. The caller releases the claim (releaseItem) in a finally.
 */
async function rowForStaffAction(actor: HostingActor, id: number): Promise<ItemRow> {
  const row = await visibleRow(actor, id);
  if (actor.kind !== 'staff') throw new AppError(403, 'Only the platform staff may restore or delete a quarantined file', 'staffOnly');
  if (!actorCan(actor, 'files.manage', { tenantId: Number(row.tenant_id), accountId: Number(row.account_id) })) {
    throw new AppError(403, 'Insufficient permissions');
  }
  if (row.status !== 'quarantined') throw resolvedConflict(row.status);
  if (!claimItem(Number(row.id))) throw new AppError(409, 'Another action on this file is in progress', 'quarantineResolved', { status: row.status });
  // Re-read under the claim: an action that finished between the read and the claim already closed it.
  const fresh = await rowById(Number(row.id)).catch((err) => { releaseItem(Number(row.id)); throw err; });
  if (!fresh || fresh.status !== 'quarantined') {
    releaseItem(Number(row.id));
    throw resolvedConflict(fresh?.status ?? 'deleted');
  }
  return fresh;
}

async function accountOf(accountId: number): Promise<{ id: number; node_id: number; uid: number; gid: number }> {
  const a = await db('hosting_accounts').where({ id: accountId }).first('id', 'node_id', 'uid', 'gid') as { id: number; node_id: number; uid: number; gid: number } | undefined;
  if (!a) throw notFound();
  return a;
}

function backendError(what: string, err: unknown): AppError {
  return new AppError(502, `hostd (${what}): ${errText(err)}`, 'backendUnavailable');
}

async function resolveRow(req: Request, row: ItemRow, status: 'restored' | 'deleted', note: string | null): Promise<QuarantineItem> {
  const now = deps.now();
  const userId = Number(req.session?.userId) || null;
  // Conditional: never overwrite a row another writer closed meanwhile.
  const n = await db('quarantine_items').where({ id: row.id, status: 'quarantined' })
    .update({ status, resolved_at: now, resolved_by: userId, resolution_note: note, updated_at: now });
  if (n === 0) throw resolvedConflict((await rowById(Number(row.id)))?.status ?? 'deleted');
  emitQuarantine({ tenantId: Number(row.tenant_id), accountId: Number(row.account_id), id: Number(row.id), status });
  return toItem((await rowById(Number(row.id)))!);
}

/** An entry hostd no longer has: the row is closed as deleted outside the panel, the caller gets 409. */
async function entryVanished(row: ItemRow): Promise<never> {
  const now = deps.now();
  const n = await db('quarantine_items').where({ id: row.id, status: 'quarantined' })
    .update({ status: 'deleted', resolved_at: now, resolved_by: null, resolution_note: MISSING_ON_HOST_NOTE, updated_at: now });
  if (n > 0) {
    emitQuarantine({ tenantId: Number(row.tenant_id), accountId: Number(row.account_id), id: Number(row.id), status: 'deleted' });
    await auditReconciliation({ tenantId: Number(row.tenant_id), accountId: Number(row.account_id), username: row.account_username },
      { id: Number(row.id), path: row.path, sha256: row.sha256, site_id: row.site_id, site_name: row.site_name }, 'deleted', MISSING_ON_HOST_NOTE);
  }
  throw new AppError(409, 'The quarantined file no longer exists on the host', 'quarantineResolved', { status: 'deleted' });
}

/** Restore under the claim of rowForStaffAction. */
async function restoreClaimed(req: Request, row: ItemRow, body: QuarantineRestoreRequest): Promise<QuarantineItem> {
  const account = await accountOf(Number(row.account_id));
  const overwrite = body?.overwrite === true;
  let restoredPath: string | null = null;
  try {
    const r = await deps.hostd(account.node_id).restoreQuarantine(account.id, row.hostd_entry_id, { uid: account.uid, gid: account.gid, overwrite });
    restoredPath = typeof r?.path === 'string' ? r.path : null;
  } catch (err) {
    if (err instanceof HostdError && err.status === 409 && (err.code === 'restoreConflict' || err.code === 'conflict' || !err.code)) {
      throw new AppError(409, 'A file now exists at the original path (restore with overwrite to replace it)', 'restoreConflict', { path: row.path });
    }
    if (err instanceof HostdError && err.status === 404) await entryVanished(row);
    throw backendError('restore', err);
  }
  const reason = body?.reason?.trim() || null;
  const item = await resolveRow(req, row, 'restored', reason);
  await auditService.logReqAs(req, Number(row.tenant_id), 'quarantine.restore', {
    resourceType: 'quarantine',
    resourcePath: String(row.id),
    details: {
      accountId: item.accountId, username: item.accountUsername, siteId: item.siteId, siteName: item.siteName,
      path: item.path, sha256: item.sha256, overwrite, ...(reason ? { reason } : {}), ...(restoredPath ? { hostPath: restoredPath } : {}),
    },
  });
  return item;
}

/** Delete under the claim of rowForStaffAction. */
async function removeClaimed(req: Request, row: ItemRow): Promise<QuarantineItem> {
  const account = await accountOf(Number(row.account_id));
  try {
    await deps.hostd(account.node_id).deleteQuarantine(account.id, row.hostd_entry_id);
  } catch (err) {
    // Already gone from the store: the deletion is what was asked, record it.
    if (!(err instanceof HostdError && err.status === 404)) throw backendError('delete', err);
  }
  const item = await resolveRow(req, row, 'deleted', 'Supprimé par un administrateur');
  await auditService.logReqAs(req, Number(row.tenant_id), 'quarantine.delete', {
    resourceType: 'quarantine',
    resourcePath: String(row.id),
    details: {
      accountId: item.accountId, username: item.accountUsername, siteId: item.siteId, siteName: item.siteName,
      path: item.path, sha256: item.sha256, reason: item.reason,
    },
  });
  return item;
}

let running = false;
let resyncTimer: NodeJS.Timeout | null = null;
let digestTimer: NodeJS.Timeout | null = null;
let firstDigestTimer: NodeJS.Timeout | null = null;
let resyncRunning = false;
let digestRunning = false;

function resyncInBackground(reason: string): void {
  if (resyncRunning) return;
  resyncRunning = true;
  resyncAll()
    .then((r) => { if (r.added || r.restored || r.missing || r.failed) logger.info({ reason, ...r }, 'quarantine resync'); })
    .catch((err) => logger.warn({ err: errText(err) }, 'quarantine resync failed'))
    .finally(() => { resyncRunning = false; });
}

function digestInBackground(): void {
  if (digestRunning) return;
  digestRunning = true;
  digestTick().finally(() => { digestRunning = false; });
}

export const quarantineService = {
  async list(actor: HostingActor, f: QuarantineFilters): Promise<{ items: QuarantineItem[]; total: number }> {
    // Like every hosting list: a staff member needs a hosting read capability (a billing-only member sees nothing).
    if (actor.kind === 'staff') assertNeedSomewhere(actor, 'read');
    if (f.accountId) await loadAccount(actor, f.accountId, 'read');
    const q = scopeToActor(actor, baseQuery(), { tenant: 'q.tenant_id', account: 'q.account_id' }, f.tenantId ?? null);
    if (f.accountId) q.where('q.account_id', f.accountId);
    if (f.siteId) q.where('q.site_id', f.siteId);
    if (f.status) q.where('q.status', f.status);
    const [{ n }] = await q.clone().clearSelect().count<{ n: string | number }[]>('q.id as n');
    const rows = await q.select(COLUMNS).orderBy('q.detected_at', 'desc').orderBy('q.id', 'desc')
      .limit(Math.min(Math.max(1, f.limit), 100)).offset(Math.max(0, f.offset)) as ItemRow[];
    return { items: rows.map(toItem), total: Number(n) };
  },

  async get(actor: HostingActor, id: number): Promise<QuarantineItemDetail> {
    const row = await visibleRow(actor, id);
    let preview: QuarantineItemDetail['preview'] = null;
    // M9: the content is evidence, possibly hostile — staff only, never a client,
    // and only staff holding files.manage on the account (those who may restore / delete it).
    if (actor.kind === 'staff' && row.status === 'quarantined'
      && actorCan(actor, 'files.manage', { tenantId: Number(row.tenant_id), accountId: Number(row.account_id) })) {
      try {
        const account = await accountOf(Number(row.account_id));
        const p = await deps.hostd(account.node_id).quarantinePreview(account.id, row.hostd_entry_id, PREVIEW_MAX_BYTES);
        const buf = Buffer.from(typeof p.base64 === 'string' ? p.base64 : '', 'base64').subarray(0, PREVIEW_MAX_BYTES);
        const truncated = p.truncated === true || buf.length < Number(p.size ?? 0);
        preview = { base64: buf.toString('base64'), truncated, text: looksLikeText(buf, truncated) };
      } catch (err) {
        logger.debug({ itemId: row.id, err: errText(err) }, 'quarantine preview unavailable');
      }
    }
    return { ...toItem(row), preview };
  },

  async summary(actor: HostingActor, accountId: number | null): Promise<QuarantineSummary> {
    if (actor.kind === 'staff') assertNeedSomewhere(actor, 'read');
    if (accountId) await loadAccount(actor, accountId, 'read');
    const q = scopeToActor(actor, db('quarantine_items as q'), { tenant: 'q.tenant_id', account: 'q.account_id' });
    if (accountId) q.where('q.account_id', accountId);
    const since = new Date(deps.now().getTime() - 24 * 3_600_000);
    const row = await q.first(
      db.raw(`COUNT(*) FILTER (WHERE q.status = 'quarantined') AS quarantined`),
      db.raw('COUNT(*) FILTER (WHERE q.detected_at >= ?) AS last24h', [since]),
    ) as { quarantined: string | number; last24h: string | number } | undefined;
    return { quarantined: Number(row?.quarantined ?? 0), last24h: Number(row?.last24h ?? 0) };
  },

  async restore(req: Request, actor: HostingActor, id: number, body: QuarantineRestoreRequest): Promise<QuarantineItem> {
    const row = await rowForStaffAction(actor, id);
    try {
      return await restoreClaimed(req, row, body);
    } finally {
      releaseItem(Number(row.id));
    }
  },

  async remove(req: Request, actor: HostingActor, id: number): Promise<QuarantineItem> {
    const row = await rowForStaffAction(actor, id);
    try {
      return await removeClaimed(req, row);
    } finally {
      releaseItem(Number(row.id));
    }
  },

  // ── supervised mode (GET /sites/:id/supervision, POST …/digest) ──
  async supervision(actor: HostingActor, siteId: number): Promise<SupervisionInfo> {
    await loadSite(actor, siteId, 'read');
    return supervisionInfo(siteId);
  },

  async digestNow(_req: Request, actor: HostingActor, siteId: number): Promise<SupervisionInfo> {
    await loadSite(actor, siteId, 'releases.publish');
    await digestForRequest(siteId);
    return supervisionInfo(siteId);
  },

  /** HOOK: re-push the typed-path watch specs of every site (settings / data paths changed). Never throws. */
  requestWatchSyncAll(reason: string): void {
    try { queueWatchSyncAll(reason); } catch { /* never throws */ }
  },
  /** HOOK: re-push the watch spec of one site's account. Never throws. */
  requestWatchSync(accountId: number, reason: string): void {
    try { queueWatchSync(accountId, reason); } catch { /* never throws */ }
  },

  /** hostd event consumer + resync + digest worker. Returns at once, never throws. */
  start(): void {
    if (running) return;
    try {
      running = true;
      setHostdRestartHandler(defaultHostdRestart);
      queueWatchSyncAll('boot', true);
      resyncInBackground('boot');
      resyncTimer = setInterval(() => resyncInBackground('periodic'), RESYNC_MS);
      resyncTimer.unref?.();
      firstDigestTimer = setTimeout(digestInBackground, FIRST_DIGEST_TICK_MS);
      firstDigestTimer.unref?.();
      digestTimer = setInterval(digestInBackground, DIGEST_TICK_MS);
      digestTimer.unref?.();
      void eventLoop(() => running).catch((err) => logger.warn({ err: errText(err) }, 'quarantine event loop stopped'));
    } catch (err) {
      logger.warn({ err: errText(err) }, 'quarantine workers not started');
    }
  },

  stop(): void {
    running = false;
    if (resyncTimer) clearInterval(resyncTimer);
    if (digestTimer) clearInterval(digestTimer);
    if (firstDigestTimer) clearTimeout(firstDigestTimer);
    resyncTimer = digestTimer = firstDigestTimer = null;
    setHostdRestartHandler(null);
    resetWatchState();
  },
};
