import fs from 'fs';
import type { Request } from 'express';
import type { DbSnapshot, DbSnapshotReason, DbSnapshotStatus, SiteMaintenanceSettings, SnapshotMode } from '@oblimint/shared';
import { ADAPTER_RUN_FINAL_STATUSES, DEFAULT_SITE_MAINTENANCE_SETTINGS, WINDOW_FINAL_STATUSES } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { dumpDatabaseToFile, restoreDatabaseFromFile, SnapshotRestoreError } from '../databases/snapshotIo';
import { loadSite, type HostingActor } from '../hosting/access';
import { localPaths } from '../hosting/paths';
import { iso } from '../hosting/rows';
import { platformSettings } from '../platformSettings';

// ─────────────────────────────────────────────────────────────────────────────
// Database snapshots before a window / an adapter run (ARCHITECTURE §2.4,
// docs/P3-PLAN.md §10.3). OWNED BY MODULE `checksums-snapshots`.
//
// Files: accounts/<accountId>/snapshots/<snapshotId>-<database>.sql.gz (root
// 0600 in a root 0700 dir, counted in the account quota, never mounted in a
// tenant container — M7), written by the panel through databases/snapshotIo.ts
// (dump in the instance container, gzip stream, never in a shell). Paths come
// only from localPaths + numeric ids + validated database names (R2).
// Restore: never as the superuser (P2 rules), databases.manage on the site's
// account, audit 'snapshot.restore' in the object's tenant.
// Retention: settings maintenance.snapshotRetentionDays after the window / run
// is decided (release()), maxSnapshotsPerSite (oldest DECIDED ones first);
// hourly worker. Orphans never released (site deleted, window / run gone or
// decided without release()) expire too (orphanSnapshotsQuery).
// A6: the stored `error` is "<code>: <detail>"; a client only gets the code.
// ─────────────────────────────────────────────────────────────────────────────

export interface SnapshotRef {
  reason: DbSnapshotReason;
  windowId?: number | null;
  adapterRunId?: number | null;
  userId?: number | null;
  /** Explicit databases (db_databases ids); default: the site's snapshot setting (all databases of the account / selected / none). */
  databaseIds?: number[] | null;
}

interface SnapshotRow {
  id: number;
  tenant_id: number;
  account_id: number;
  site_id: number | null;
  instance_id: number | null;
  database_id: number | null;
  database_name: string;
  engine: string;
  reason: DbSnapshotReason;
  window_id: number | null;
  adapter_run_id: number | null;
  file_name: string | null;
  status: DbSnapshotStatus;
  size_bytes: number | string | null;
  error: string | null;
  created_by: number | null;
  expires_at: Date | string | null;
  restored_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SiteRef { id: number; tenant_id: number; account_id: number; name: string }

interface DatabaseCandidate {
  id: number;
  name: string;
  instance_id: number;
  account_id: number;
  engine: string;
  instance_status: string;
}

const DB_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;
const RETENTION_INTERVAL_MS = 60 * 60_000;
const RETENTION_FIRST_DELAY_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** Instances deliberately off: not part of mode 'all' (nothing to protect while they do not run). */
const INSTANCE_OFF = new Set(['stopped', 'deleting']);

function notFound(what: string): AppError {
  return new AppError(404, `${what} not found`, 'notFound');
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** "<code>: <detail>" stored in db_snapshots.error (the code alone is safe for a client). */
function storedError(err: unknown): string {
  const code = err instanceof AppError && err.code ? err.code : 'snapshotFailed';
  return `${code}: ${errText(err)}`.slice(0, 2000);
}

function snapshotFileName(id: number, databaseName: string): string {
  if (!Number.isInteger(id) || id <= 0 || !DB_NAME_RE.test(databaseName)) throw new Error('invalid snapshot file name');
  return `${id}-${databaseName}.sql.gz`;
}

/** Absolute local path of a snapshot file (null when the row has no valid file name). */
function snapshotPath(row: Pick<SnapshotRow, 'account_id' | 'file_name'>): string | null {
  if (!row.file_name || !/^[0-9]{1,12}-[A-Za-z0-9_]{1,64}\.sql\.gz$/.test(row.file_name)) return null;
  return localPaths.snapshotFile(row.account_id, row.file_name);
}

async function removeFile(row: Pick<SnapshotRow, 'account_id' | 'file_name'>): Promise<void> {
  const file = snapshotPath(row);
  if (!file) return;
  await fs.promises.rm(file, { force: true });
  await fs.promises.rm(`${file}.tmp`, { force: true });
}

export function toDbSnapshot(r: SnapshotRow, opts: { staff: boolean } = { staff: true }): DbSnapshot {
  let error = r.error;
  if (error && !opts.staff) error = error.split(':', 1)[0].trim() || 'snapshotFailed';
  return {
    id: r.id,
    siteId: r.site_id,
    accountId: r.account_id,
    instanceId: r.instance_id ?? 0,
    databaseId: r.database_id,
    databaseName: r.database_name,
    engine: r.engine,
    reason: r.reason,
    windowId: r.window_id,
    adapterRunId: r.adapter_run_id,
    status: r.status,
    sizeBytes: r.size_bytes === null || r.size_bytes === undefined ? null : Number(r.size_bytes),
    error,
    createdAt: iso(r.created_at)!,
    expiresAt: iso(r.expires_at),
    restoredAt: iso(r.restored_at),
  };
}

/** Site setting read directly from site_maintenance (defaults merged; no dependency on the windows module). */
export async function siteSnapshotSetting(siteId: number): Promise<{ mode: SnapshotMode; databaseIds: number[] }> {
  const row = await db('site_maintenance').where({ site_id: siteId }).first('settings') as { settings: unknown } | undefined;
  let raw: unknown = row?.settings ?? null;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  const settings = (raw && typeof raw === 'object' ? raw : {}) as Partial<SiteMaintenanceSettings>;
  const def = DEFAULT_SITE_MAINTENANCE_SETTINGS.snapshot;
  const snap = settings.snapshot && typeof settings.snapshot === 'object' ? settings.snapshot : def;
  const mode: SnapshotMode = snap.mode === 'all' || snap.mode === 'selected' || snap.mode === 'none' ? snap.mode : def.mode;
  const databaseIds = Array.isArray(snap.databaseIds) ? snap.databaseIds.filter((n) => Number.isInteger(n) && n > 0) : [];
  return { mode, databaseIds };
}

function databaseQuery(accountId: number) {
  return db('db_databases as d')
    .join('db_instances as i', 'i.id', 'd.instance_id')
    .where('d.account_id', accountId)
    .andWhere('i.account_id', accountId)
    .orderBy('d.id')
    .select('d.id', 'd.name', 'd.instance_id', 'd.account_id', 'i.engine', 'i.status as instance_status');
}

/** Databases a snapshot set covers: explicit ids or the site setting, always ∩ the site's account. */
async function databasesFor(site: SiteRef, ref: SnapshotRef): Promise<DatabaseCandidate[]> {
  if (Array.isArray(ref.databaseIds)) {
    const ids = ref.databaseIds.filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length === 0) return [];
    return await databaseQuery(site.account_id).whereIn('d.id', ids) as DatabaseCandidate[];
  }
  const setting = await siteSnapshotSetting(site.id);
  if (setting.mode === 'none') return [];
  if (setting.mode === 'selected') {
    if (setting.databaseIds.length === 0) return [];
    return await databaseQuery(site.account_id).whereIn('d.id', setting.databaseIds) as DatabaseCandidate[];
  }
  const all = await databaseQuery(site.account_id) as DatabaseCandidate[];
  return all.filter((d) => !INSTANCE_OFF.has(d.instance_status));
}

async function rowsWhere(where: Record<string, unknown>): Promise<DbSnapshot[]> {
  const rows = await db('db_snapshots').where(where).orderBy('id') as SnapshotRow[];
  return rows.map((r) => toDbSnapshot(r));
}

async function auditSnapshot(
  row: SnapshotRow,
  action: 'snapshot.restore' | 'snapshot.delete',
  details: Record<string, unknown>,
  who: { req: Request } | { userId: number | null },
): Promise<void> {
  const extras = {
    resourceType: 'db_snapshot',
    resourcePath: String(row.id),
    details: { database: row.database_name, siteId: row.site_id, accountId: row.account_id, ...details },
  };
  if ('req' in who) await auditService.logReqAs(who.req, row.tenant_id, action, extras);
  else await auditService.log({ tenantId: row.tenant_id, userId: who.userId ?? undefined, action, ...extras });
}

async function loadSiteSnapshot(siteId: number, snapshotId: number, site: { tenant_id: number; account_id: number }): Promise<SnapshotRow> {
  if (!Number.isInteger(snapshotId) || snapshotId <= 0) throw notFound('Snapshot');
  const row = await db('db_snapshots')
    .where({ id: snapshotId, site_id: siteId, account_id: site.account_id, tenant_id: site.tenant_id })
    .first() as SnapshotRow | undefined;
  if (!row || row.status === 'deleted') throw notFound('Snapshot');
  return row;
}

/** Restores one READY snapshot into its database (409 snapshotNotReady otherwise). */
async function restoreRow(row: SnapshotRow): Promise<void> {
  const file = snapshotPath(row);
  if (row.status !== 'ready' || !file) throw new AppError(409, 'The snapshot is not ready', 'snapshotNotReady', { status: row.status });
  if (!row.database_id) throw new AppError(409, 'The database of this snapshot no longer exists', 'snapshotNotReady', { status: row.status });
  // The database must still belong to the snapshot's account (never restored across accounts).
  const target = await db('db_databases').where({ id: row.database_id, account_id: row.account_id }).first('id') as { id: number } | undefined;
  if (!target) throw new AppError(409, 'The database of this snapshot no longer exists', 'snapshotNotReady', { status: row.status });
  try {
    await restoreDatabaseFromFile(row.database_id, file);
  } catch (err) {
    // The file of a "ready" row is gone (or replaced by a link): the row stops showing as ready.
    if (err instanceof AppError && err.code === 'snapshotNotReady' && (err.details as { file?: string } | undefined)?.file === 'missing') {
      await db('db_snapshots').where({ id: row.id, status: 'ready' })
        .update({ status: 'failed', error: 'snapshotNotReady: the snapshot file is missing', updated_at: new Date() });
    }
    throw err;
  }
  await db('db_snapshots').where({ id: row.id }).update({ restored_at: new Date(), updated_at: new Date() });
}

// ── retention ───────────────────────────────────────────────────────────────

/** Adapter run statuses after which its snapshots are no longer needed (awaiting_approval may still roll back). */
const RUN_DONE_STATUSES = ADAPTER_RUN_FINAL_STATUSES.filter((s) => s !== 'awaiting_approval');

/**
 * READY snapshots no release() will ever date (expires_at NULL), older than
 * the retention period: site deleted (site_id NULL), window / run snapshot
 * whose window AND run are gone, or whose window / run reached a final state
 * more than the retention period ago without release(). Invisible in the UI
 * (listForSite filters on site_id) yet counted in the account quota.
 */
function orphanSnapshotsQuery(cutoff: Date) {
  return db('db_snapshots as s')
    .where('s.status', 'ready')
    .whereNull('s.expires_at')
    .andWhere('s.created_at', '<=', cutoff)
    .andWhere((q) => {
      q.whereNull('s.site_id')
        .orWhere((o) => o.whereIn('s.reason', ['window', 'adapter']).whereNull('s.window_id').whereNull('s.adapter_run_id'))
        .orWhereExists(db('maintenance_windows as w').whereRaw('w.id = s.window_id')
          .whereIn('w.status', [...WINDOW_FINAL_STATUSES]).andWhere('w.updated_at', '<=', cutoff).select(db.raw('1')))
        .orWhereExists(db('adapter_runs as a').whereRaw('a.id = s.adapter_run_id')
          .whereIn('a.status', RUN_DONE_STATUSES).andWhere('a.updated_at', '<=', cutoff).select(db.raw('1')));
    });
}

/**
 * One retention pass: orphans (orphanSnapshotsQuery) are dated now; expired
 * READY snapshots lose their file ('expired');
 * beyond maxSnapshotsPerSite the oldest DECIDED ones (expires_at set) go
 * first. Never throws (logged).
 */
export async function snapshotRetentionPass(now: Date = new Date()): Promise<{ expired: number; trimmed: number }> {
  let expired = 0;
  let trimmed = 0;
  try {
    // Orphans: dated now, then expired with the due ones below.
    const days = (await platformSettings.section('maintenance')).snapshotRetentionDays;
    const orphanIds = (await orphanSnapshotsQuery(new Date(now.getTime() - days * DAY_MS)).select('s.id') as Array<{ id: number }>).map((r) => r.id);
    if (orphanIds.length > 0) {
      await db('db_snapshots').whereIn('id', orphanIds).where({ status: 'ready' }).whereNull('expires_at').update({ expires_at: now, updated_at: now });
    }
    const due = await db('db_snapshots').where({ status: 'ready' }).whereNotNull('expires_at').andWhere('expires_at', '<=', now)
      .orderBy('id').select('*') as SnapshotRow[];
    for (const row of due) {
      try {
        await removeFile(row);
        await db('db_snapshots').where({ id: row.id, status: 'ready' }).update({ status: 'expired', updated_at: now });
        expired++;
      } catch (err) {
        logger.warn({ snapshotId: row.id, err: errText(err) }, 'Snapshot expiry failed');
      }
    }
    const max = (await platformSettings.section('maintenance')).maxSnapshotsPerSite;
    const crowded = await db('db_snapshots').where({ status: 'ready' }).whereNotNull('site_id')
      .groupBy('site_id').havingRaw('COUNT(*) > ?', [max]).select('site_id', db.raw('COUNT(*) AS n')) as Array<{ site_id: number; n: number | string }>;
    for (const s of crowded) {
      const excess = Number(s.n) - max;
      const victims = await db('db_snapshots').where({ site_id: s.site_id, status: 'ready' }).whereNotNull('expires_at')
        .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'id', order: 'asc' }]).limit(excess).select('*') as SnapshotRow[];
      for (const row of victims) {
        try {
          await removeFile(row);
          await db('db_snapshots').where({ id: row.id, status: 'ready' }).update({ status: 'expired', updated_at: now });
          trimmed++;
        } catch (err) {
          logger.warn({ snapshotId: row.id, err: errText(err) }, 'Snapshot trim failed');
        }
      }
    }
  } catch (err) {
    logger.warn({ err: errText(err) }, 'Snapshot retention pass failed');
  }
  return { expired, trimmed };
}

/** When this process started: a 'creating' row older than that was interrupted by a restart. */
const PROCESS_STARTED_AT = new Date();

/** Boot: dumps interrupted by a restart ('creating' before this process) become 'failed', their temporary file removed. Never throws. */
export async function recoverInterruptedSnapshots(startedAt: Date = PROCESS_STARTED_AT): Promise<number> {
  try {
    const rows = await db('db_snapshots').where({ status: 'creating' }).andWhere('created_at', '<', startedAt).select('*') as SnapshotRow[];
    for (const row of rows) {
      await removeFile(row).catch(() => {});
      await db('db_snapshots').where({ id: row.id, status: 'creating' })
        .update({ status: 'failed', error: 'interrupted: the panel restarted during the dump', updated_at: new Date() });
    }
    return rows.length;
  } catch (err) {
    logger.warn({ err: errText(err) }, 'Interrupted snapshots not recovered');
    return 0;
  }
}

let retentionTimer: NodeJS.Timeout | null = null;
let retentionFirst: NodeJS.Timeout | null = null;
let retentionRunning = false;

function runRetention(): void {
  if (retentionRunning) return;
  retentionRunning = true;
  snapshotRetentionPass().finally(() => { retentionRunning = false; });
}

// ── service ─────────────────────────────────────────────────────────────────

export const snapshotService = {
  /**
   * Dumps the databases of the site's snapshot setting. One failing database
   * does not stop the others: its row is 'failed' with the error. [] when the
   * setting is 'none' or the account has no database.
   */
  async createForSite(siteId: number, ref: SnapshotRef): Promise<DbSnapshot[]> {
    const site = await db('sites').where({ id: siteId }).first('id', 'tenant_id', 'account_id', 'name') as SiteRef | undefined;
    if (!site) throw notFound('Site');
    const databases = await databasesFor(site, ref);
    const out: DbSnapshot[] = [];
    for (const d of databases) {
      const [inserted] = await db('db_snapshots').insert({
        tenant_id: site.tenant_id,
        account_id: site.account_id,
        site_id: site.id,
        instance_id: d.instance_id,
        database_id: d.id,
        database_name: d.name.slice(0, 64),
        engine: String(d.engine).slice(0, 24),
        reason: ref.reason,
        window_id: ref.windowId ?? null,
        adapter_run_id: ref.adapterRunId ?? null,
        created_by: ref.userId ?? null,
        status: 'creating',
      }).returning('id');
      const id = Number((inserted as { id: number }).id ?? inserted);
      let update: Partial<SnapshotRow>;
      try {
        if (!DB_NAME_RE.test(d.name)) throw new AppError(400, 'Invalid database name', 'validation');
        if (d.instance_status !== 'running') {
          throw new AppError(409, `The instance is not running (${d.instance_status})`, 'instanceNotRunning', { status: d.instance_status });
        }
        const fileName = snapshotFileName(id, d.name);
        await db('db_snapshots').where({ id }).update({ file_name: fileName });
        const { bytes } = await dumpDatabaseToFile(d.id, localPaths.snapshotFile(site.account_id, fileName));
        update = { status: 'ready', size_bytes: bytes, error: null };
      } catch (err) {
        logger.warn({ siteId, databaseId: d.id, snapshotId: id, err: errText(err) }, 'Database snapshot failed');
        update = { status: 'failed', error: storedError(err) };
      }
      await db('db_snapshots').where({ id }).update({ ...update, updated_at: new Date() });
      const row = await db('db_snapshots').where({ id }).first() as SnapshotRow;
      out.push(toDbSnapshot(row));
    }
    return out;
  },

  /** Restores the given snapshots (internal: windows reject+restore, adapters rollback). */
  async restore(snapshotIds: number[], opts: { userId: number | null; reason: string }): Promise<{ restored: number; failed: Array<{ id: number; error: string }> }> {
    const ids = [...new Set(snapshotIds.filter((n) => Number.isInteger(n) && n > 0))];
    const rows = ids.length ? await db('db_snapshots').whereIn('id', ids).orderBy('id') as SnapshotRow[] : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    let restored = 0;
    const failed: Array<{ id: number; error: string }> = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        failed.push({ id, error: 'notFound' });
        continue;
      }
      try {
        await restoreRow(row);
        restored++;
        await auditSnapshot(row, 'snapshot.restore', { ok: true, reason: opts.reason }, { userId: opts.userId });
      } catch (err) {
        const message = err instanceof SnapshotRestoreError ? `${storedError(err)}\n${err.output}`.slice(0, 2000) : storedError(err);
        logger.warn({ snapshotId: id, err: message }, 'Snapshot restore failed');
        failed.push({ id, error: message });
        await auditSnapshot(row, 'snapshot.restore', { ok: false, reason: opts.reason, code: err instanceof AppError ? err.code ?? null : null }, { userId: opts.userId });
      }
    }
    return { restored, failed };
  },

  async listForWindow(windowId: number): Promise<DbSnapshot[]> {
    if (!Number.isInteger(windowId) || windowId <= 0) return [];
    return rowsWhere({ window_id: windowId });
  },

  async listForAdapterRun(runId: number): Promise<DbSnapshot[]> {
    if (!Number.isInteger(runId) || runId <= 0) return [];
    return rowsWhere({ adapter_run_id: runId });
  },

  /** Marks the snapshots of a decided window / run for expiry (retention starts). Never throws. */
  async release(ref: { windowId?: number | null; adapterRunId?: number | null }): Promise<void> {
    try {
      const windowId = Number.isInteger(ref.windowId) && ref.windowId! > 0 ? ref.windowId! : null;
      const runId = Number.isInteger(ref.adapterRunId) && ref.adapterRunId! > 0 ? ref.adapterRunId! : null;
      if (!windowId && !runId) return;
      const days = (await platformSettings.section('maintenance')).snapshotRetentionDays;
      const expiresAt = new Date(Date.now() + days * DAY_MS);
      await db('db_snapshots')
        .where((q) => {
          if (windowId) q.orWhere('window_id', windowId);
          if (runId) q.orWhere('adapter_run_id', runId);
        })
        .whereNull('expires_at')
        .whereIn('status', ['creating', 'ready', 'failed'])
        .update({ expires_at: expiresAt, updated_at: new Date() });
    } catch (err) {
      logger.warn({ ...ref, err: errText(err) }, 'Snapshot release failed');
    }
  },

  // ── API (GET/POST/DELETE /sites/:id/snapshots…) ──
  async listForSite(actor: HostingActor, siteId: number, opts: { limit: number; offset: number }): Promise<{ items: DbSnapshot[]; total: number }> {
    const site = await loadSite(actor, siteId, 'read');
    const base = () => db('db_snapshots')
      .where({ site_id: site.id, account_id: site.account_id, tenant_id: site.tenant_id })
      .whereNot('status', 'deleted');
    const limit = Math.min(100, Math.max(1, Math.floor(opts.limit) || 20));
    const offset = Math.max(0, Math.floor(opts.offset) || 0);
    const [rows, count] = await Promise.all([
      base().orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(limit).offset(offset).select('*') as Promise<SnapshotRow[]>,
      base().count<{ count: string | number }[]>('* as count').first(),
    ]);
    const staff = actor.kind === 'staff';
    return { items: rows.map((r) => toDbSnapshot(r, { staff })), total: Number((count as { count?: string | number } | undefined)?.count ?? 0) };
  },

  async restoreOne(req: Request, actor: HostingActor, siteId: number, snapshotId: number): Promise<{ restored: true }> {
    const site = await loadSite(actor, siteId, 'databases.manage');
    const row = await loadSiteSnapshot(site.id, snapshotId, site);
    try {
      await restoreRow(row);
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'snapshotNotReady') {
        await auditSnapshot(row, 'snapshot.restore', { ok: false, code: err instanceof AppError ? err.code ?? null : null }, { req });
      }
      // A6: the raw SQL client output only for the staff.
      if (err instanceof SnapshotRestoreError && actor.kind === 'staff') {
        throw new AppError(502, err.message, 'restoreFailed', { exitCode: err.exitCode, output: err.output });
      }
      throw err;
    }
    await auditSnapshot(row, 'snapshot.restore', { ok: true, reason: 'manual' }, { req });
    return { restored: true };
  },

  async remove(req: Request, actor: HostingActor, siteId: number, snapshotId: number): Promise<void> {
    const site = await loadSite(actor, siteId, 'databases.manage');
    const row = await loadSiteSnapshot(site.id, snapshotId, site);
    if (row.status === 'creating') throw new AppError(409, 'The snapshot is being created', 'snapshotNotReady', { status: row.status });
    try {
      await removeFile(row);
    } catch (err) {
      throw new AppError(502, `Snapshot file not removed: ${errText(err)}`, 'backendUnavailable');
    }
    await db('db_snapshots').where({ id: row.id }).update({ status: 'deleted', updated_at: new Date() });
    await auditSnapshot(row, 'snapshot.delete', { status: row.status }, { req });
  },

  /** Retention worker. Returns at once, never throws. */
  start(): void {
    if (retentionTimer) return;
    retentionFirst = setTimeout(() => {
      retentionFirst = null;
      void recoverInterruptedSnapshots().finally(runRetention);
    }, RETENTION_FIRST_DELAY_MS);
    retentionFirst.unref?.();
    retentionTimer = setInterval(runRetention, RETENTION_INTERVAL_MS);
    retentionTimer.unref?.();
  },

  stop(): void {
    if (retentionTimer) clearInterval(retentionTimer);
    if (retentionFirst) clearTimeout(retentionFirst);
    retentionTimer = null;
    retentionFirst = null;
  },
};
