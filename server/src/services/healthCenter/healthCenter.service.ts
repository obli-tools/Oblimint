import type { Request } from 'express';
import { z } from 'zod';
import type {
  DeepHealthReport, HealthCenterBackupFailure, HealthCenterBackupTarget, HealthCenterComponentId, HealthCenterEvent, HealthCenterSettings,
  HealthCenterSettingsInput, HealthCenterStatus, HealthTrackStatus, NotificationEvent,
} from '@oblimint/shared';
import {
  DEFAULT_HEALTH_CENTER_SETTINGS, HEALTH_CENTER_COMPONENT_IDS, HEALTH_CENTER_CONFIRM_MAX, HEALTH_CENTER_CONFIRM_MIN, HEALTH_CENTER_DISK_GIB_MAX,
  HEALTH_CENTER_DISK_PERCENT_MAX, HEALTH_CENTER_EVENTS, MASTER_TENANT_ID,
} from '@oblimint/shared';
import { config } from '../../config';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import type { NotificationPayload } from '../usage/notifications.service';
import {
  EMPTY_BACKUP_TRACK, EMPTY_TRACK, diskObservation, durationFr, stepBackup, stepTrack, type BackupOutcome, type BackupTrack, type DiskFigures, type Track,
} from './transitions';

// ─────────────────────────────────────────────────────────────────────────────
// Health center (platform admins). A worker, every minute (workers on):
//   1. takes the admin report of the deep checks (healthMonitor: the SAME
//      checks as /health/deep and the heartbeat, shared cache) and the raw
//      figures of the data disk;
//   2. steps the hysteresis of each component (postgres, hostd, edge, dns,
//      mail, workers) and of the disk (thresholds of the settings) —
//      transitions.ts;
//   3. examines the backup runs finished since its cursor, per target (an
//      account, the panel): first failure → backup.failed, success after
//      failures → backup.recovered;
//   4. persists the confirmed states (platform_health_state, migration 037)
//      THEN notifies, once per transition (the notification key carries the
//      transition time: never deduplicated away, never sent twice).
// notify() goes to the bell / e-mail of the platform admins (family
// 'platform', their preferences) and to the master channels subscribed to
// the event. While PostgreSQL is down the states live in memory (the worker
// keeps observing; the 'postgres' recovery is notified once it answers).
// Settings: app_config `health_center` (GET / PUT …/health-monitor/center).
// ─────────────────────────────────────────────────────────────────────────────

const SETTINGS_KEY = 'health_center';
const TICK_MS = 60_000;
/** A run finished less than this ago may still be committing beside a later one: examined next tick. */
const BACKUP_SETTLE_MS = 5_000;
const BACKUP_BATCH = 500;
const DISK_KEY = 'disk:local';
const CURSOR_KEY = 'cursor:backups';

const COMPONENT_LABEL_FR: Record<HealthCenterComponentId, string> = {
  postgres: 'PostgreSQL (base du panel)',
  hostd: 'hostd (démon hôte)',
  edge: 'edge (proxy des sites)',
  dns: 'DNS (PowerDNS)',
  mail: 'moteur mail',
  workers: 'workers de fond',
};

// ── dependencies (tests) ─────────────────────────────────────────────────────

export interface HealthCenterDeps {
  checks(): Promise<{ report: DeepHealthReport; disk: DiskFigures | null }>;
  notify(event: NotificationEvent, payload: NotificationPayload): void;
  now(): number;
  workersEnabled(): boolean;
}

const realDeps: HealthCenterDeps = {
  async checks() {
    const { deepHealthForCenter } = await import('../healthMonitor/healthMonitor.service');
    return deepHealthForCenter();
  },
  notify(event, payload) {
    void import('../usage/notifications.service').then((m) => m.notify(event, payload)).catch((err) => logger.warn({ err, event }, 'health center: notify failed'));
  },
  now: () => Date.now(),
  workersEnabled: () => config.hosting.workersEnabled,
};

let deps: HealthCenterDeps = realDeps;

// ── settings ─────────────────────────────────────────────────────────────────

const eventsSchema = z.object(Object.fromEntries(HEALTH_CENTER_EVENTS.map((e) => [e, z.boolean()])) as Record<HealthCenterEvent, z.ZodBoolean>).strict();

const settingsSchema = z.object({
  enabled: z.boolean(),
  confirmChecks: z.number().int().min(HEALTH_CENTER_CONFIRM_MIN).max(HEALTH_CENTER_CONFIRM_MAX),
  diskMinFreePercent: z.number().min(0).max(HEALTH_CENTER_DISK_PERCENT_MAX),
  diskMinFreeGiB: z.number().min(0).max(HEALTH_CENTER_DISK_GIB_MAX),
  events: eventsSchema,
}).strict();

/** Body of PUT …/center/settings (route validation). */
export const healthCenterSettingsInputSchema = settingsSchema.partial().extend({ events: eventsSchema.partial().optional() }).strict();

const cloneDefaults = (): HealthCenterSettings => ({ ...DEFAULT_HEALTH_CENTER_SETTINGS, events: { ...DEFAULT_HEALTH_CENTER_SETTINGS.events } });

/** Stored JSON → full settings (each valid field kept, defaults elsewhere). */
export function normalizeSettings(raw: unknown): HealthCenterSettings {
  const out = cloneDefaults();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const k of ['enabled', 'confirmChecks', 'diskMinFreePercent', 'diskMinFreeGiB'] as const) {
    const v = settingsSchema.shape[k].safeParse(r[k]);
    if (v.success) (out as unknown as Record<string, unknown>)[k] = v.data;
  }
  if (r.events && typeof r.events === 'object') {
    for (const e of HEALTH_CENTER_EVENTS) {
      const v = (r.events as Record<string, unknown>)[e];
      if (typeof v === 'boolean') out.events[e] = v;
    }
  }
  return out;
}

/** Last settings read (the worker keeps going on them while the database is down). */
let lastSettings: HealthCenterSettings = cloneDefaults();

async function loadSettings(): Promise<HealthCenterSettings> {
  const row = await db('app_config').where({ key: SETTINGS_KEY }).first('value') as { value: string } | undefined;
  let parsed: unknown = null;
  if (row?.value) { try { parsed = JSON.parse(row.value); } catch { parsed = null; } }
  lastSettings = normalizeSettings(parsed);
  return lastSettings;
}

// ── states ───────────────────────────────────────────────────────────────────

interface StateRow {
  key: string;
  kind: string;
  status: HealthTrackStatus;
  streak: number;
  detail: string | null;
  since: Date | string | null;
  last_checked_at: Date | string | null;
  data: Record<string, unknown> | string | null;
}

interface Stored {
  kind: 'component' | 'disk' | 'backup' | 'cursor';
  track: Track;
  lastCheckedAt: string | null;
  data: Record<string, unknown>;
}

const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);
const STATUSES: readonly HealthTrackStatus[] = ['unknown', 'ok', 'fail', 'skipped'];

function fromRow(r: StateRow): Stored {
  let data: Record<string, unknown> = {};
  if (typeof r.data === 'string') { try { data = JSON.parse(r.data) as Record<string, unknown>; } catch { data = {}; } } else if (r.data && typeof r.data === 'object') data = r.data;
  return {
    kind: (['component', 'disk', 'backup', 'cursor'].includes(r.kind) ? r.kind : 'component') as Stored['kind'],
    track: {
      status: STATUSES.includes(r.status) ? r.status : 'unknown',
      streak: Number(r.streak) || 0,
      since: iso(r.since),
      detail: r.detail,
    },
    lastCheckedAt: iso(r.last_checked_at),
    data,
  };
}

/** In-memory mirror of platform_health_state (the truth while the worker runs). */
const states = new Map<string, Stored>();
let statesLoaded = false;
let lastTickAt: string | null = null;

async function loadStates(): Promise<void> {
  const rows = await db('platform_health_state').select('*') as StateRow[];
  for (const r of rows) {
    // Observed in memory while the database was unreachable: memory wins.
    if (!states.has(r.key)) states.set(r.key, fromRow(r));
  }
  statesLoaded = true;
}

async function saveStates(keys: Iterable<string>): Promise<void> {
  const rows = [...new Set(keys)].map((key) => {
    const s = states.get(key)!;
    return {
      key, kind: s.kind, status: s.track.status, streak: s.track.streak, detail: s.track.detail ? s.track.detail.slice(0, 1000) : null,
      since: s.track.since, last_checked_at: s.lastCheckedAt, data: JSON.stringify(s.data), updated_at: db.fn.now(),
    };
  });
  if (!rows.length) return;
  await db('platform_health_state').insert(rows).onConflict('key').merge();
}

/** Target of a run: the panel, an account (by id; by username once the account is gone: account_id SET NULL). */
const backupKey = (scope: 'account' | 'panel', accountId: number | null, username: string | null) =>
  (scope === 'panel' ? 'backup:panel' : accountId ? `backup:account:${accountId}` : `backup:account:gone:${String(username ?? '').slice(0, 64)}`);

function backupTrackOf(s: Stored | undefined): BackupTrack {
  if (!s) return { ...EMPTY_BACKUP_TRACK };
  return { ...s.track, failures: Number(s.data.failures) || 0, lastRunId: Number.isInteger(s.data.lastRunId) ? Number(s.data.lastRunId) : null };
}

// ── notifications ────────────────────────────────────────────────────────────

interface Pending { event: HealthCenterEvent; payload: NotificationPayload }

function payload(key: string, title: string, message: string, severity: NotificationPayload['severity'], link: string): NotificationPayload {
  return { tenantId: MASTER_TENANT_ID, platform: true, key, title, message, severity, link };
}

function componentNotice(id: HealthCenterComponentId, transition: 'down' | 'up', prev: Track, next: Track, confirm: number, nowMs: number): Pending {
  const label = COMPONENT_LABEL_FR[id];
  const link = '/settings#settings-health-center';
  if (transition === 'down') {
    return {
      event: 'platform.componentDown',
      payload: payload(`platform.componentDown:${id}:${next.since}`, `Composant en panne : ${label}`,
        `Le contrôle « ${id} » échoue (${confirm} contrôle${confirm > 1 ? 's' : ''} de suite).${next.detail ? `\nDétail : ${next.detail}` : ''}`, 'critical', link),
    };
  }
  const lasted = durationFr(prev.since, nowMs);
  return {
    event: 'platform.componentUp',
    payload: payload(`platform.componentUp:${id}:${next.since}`, `Composant rétabli : ${label}`,
      `Le contrôle « ${id} » est de nouveau vert${lasted ? ` après ${lasted} de panne` : ''}.`, 'info', link),
  };
}

function diskNotice(transition: 'down' | 'up', prev: Track, next: Track, s: HealthCenterSettings, nowMs: number): Pending {
  const link = '/settings#settings-health-center';
  const floor = `seuil : ${s.diskMinFreePercent} % libres${s.diskMinFreeGiB > 0 ? ` ou ${s.diskMinFreeGiB} Gio` : ''}`;
  if (transition === 'down') {
    return {
      event: 'node.diskLow',
      payload: payload(`node.diskLow:local:${next.since}`, 'Espace disque faible sur le nœud',
        `Répertoire de données du panel : ${next.detail ?? '—'} (${floor}).\nLibérez de la place ou agrandissez le disque avant qu’il ne se remplisse.`, 'warning', link),
    };
  }
  const lasted = durationFr(prev.since, nowMs);
  return {
    event: 'node.diskOk',
    payload: payload(`node.diskOk:local:${next.since}`, 'Espace disque revenu à la normale',
      `Répertoire de données du panel : ${next.detail ?? '—'} (${floor})${lasted ? `, après ${lasted}` : ''}.`, 'info', link),
  };
}

interface RunRow {
  id: number;
  scope: 'account' | 'panel';
  account_id: number | null;
  account_username: string | null;
  status: BackupOutcome;
  destination_name: string | null;
  errors: string[] | string | null;
  finished_at: Date | string;
}

function errorsOf(r: Pick<RunRow, 'errors'>): string[] {
  let v: unknown = r.errors;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = [v]; } }
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

const targetFr = (r: Pick<RunRow, 'scope' | 'account_id' | 'account_username'>) =>
  (r.scope === 'panel' ? 'panel (base et configuration)' : `compte ${r.account_username ?? `#${r.account_id}`}`);
const backupLink = (r: Pick<RunRow, 'scope' | 'account_id'>) => (r.scope === 'account' && r.account_id ? `/accounts/${r.account_id}?tab=backups` : '/settings#settings-group-backups');

function backupNotice(r: RunRow, transition: 'down' | 'up', prev: BackupTrack, nowMs: number): Pending {
  const target = targetFr(r);
  const key = backupKey(r.scope, r.account_id, r.account_username);
  if (transition === 'down') {
    const errs = errorsOf(r);
    const shown = errs.slice(0, 3).join('\n') + (errs.length > 3 ? `\n… (${errs.length - 3} autre${errs.length - 3 > 1 ? 's' : ''})` : '');
    return {
      event: 'backup.failed',
      payload: payload(`backup.failed:${key}:${r.id}`, `${r.status === 'partial' ? 'Sauvegarde incomplète' : 'Échec de la sauvegarde'} : ${target}`,
        `Run #${r.id}${r.destination_name ? ` vers « ${r.destination_name} »` : ''} : ${r.status === 'partial' ? 'une partie des éléments n’a pas été sauvegardée' : 'rien n’a été sauvegardé'}.${shown ? `\n${shown}` : ''}`,
        r.status === 'partial' ? 'warning' : 'critical', backupLink(r)),
    };
  }
  const lasted = durationFr(prev.since, nowMs);
  return {
    event: 'backup.recovered',
    payload: payload(`backup.recovered:${key}:${r.id}`, `Sauvegarde rétablie : ${target}`,
      `Le run #${r.id}${r.destination_name ? ` vers « ${r.destination_name} »` : ''} a réussi après ${prev.failures} échec${prev.failures > 1 ? 's' : ''}${lasted ? ` (${lasted})` : ''}.`, 'info', backupLink(r)),
  };
}

// ── the tick ─────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let firstTimer: NodeJS.Timeout | null = null;
let ticking = false;

/** Backup runs finished after the cursor (oldest first). */
async function newBackupRuns(cursor: { finishedAt: string; id: number } | null, nowMs: number): Promise<RunRow[]> {
  const settled = new Date(nowMs - BACKUP_SETTLE_MS);
  const q = db('backup_runs').whereNot('status', 'running').whereNotNull('finished_at').where('finished_at', '<', settled);
  if (cursor) q.whereRaw('(finished_at, id) > (?::timestamptz, ?)', [cursor.finishedAt, cursor.id]);
  return q.orderBy([{ column: 'finished_at', order: 'asc' }, { column: 'id', order: 'asc' }]).limit(BACKUP_BATCH)
    .select('id', 'scope', 'account_id', 'account_username', 'status', 'destination_name', 'errors', 'finished_at') as Promise<RunRow[]>;
}

/** First tick ever: the cursor starts at the newest finished run (the past is never replayed). */
async function initialCursor(): Promise<{ finishedAt: string; id: number } | null> {
  const last = await db('backup_runs').whereNot('status', 'running').whereNotNull('finished_at')
    .orderBy([{ column: 'finished_at', order: 'desc' }, { column: 'id', order: 'desc' }]).first('id', 'finished_at') as { id: number; finished_at: Date | string } | undefined;
  return last ? { finishedAt: iso(last.finished_at)!, id: Number(last.id) } : { finishedAt: new Date(0).toISOString(), id: 0 };
}

/** One minute of the worker. Never throws. Exported for the tests. */
export async function healthCenterTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const changed = new Set<string>();
  const out: Pending[] = [];
  try {
    let settings = lastSettings;
    try { settings = await loadSettings(); } catch { /* database down: last settings */ }
    if (!statesLoaded) { try { await loadStates(); } catch { /* database down: memory only */ } }

    // 1-2. Components and disk.
    let checks: { report: DeepHealthReport; disk: DiskFigures | null } | null = null;
    try { checks = await deps.checks(); } catch (err) { logger.warn({ err }, 'health center: deep checks failed'); }
    if (checks) {
      for (const id of HEALTH_CENTER_COMPONENT_IDS) {
        const c = checks.report.checks.find((x) => x.id === id);
        if (!c) continue;
        const key = `component:${id}`;
        const prev = states.get(key)?.track ?? { ...EMPTY_TRACK };
        const { next, transition } = stepTrack(prev, c.status, c.detail, settings.confirmChecks, nowIso);
        states.set(key, { kind: 'component', track: next, lastCheckedAt: nowIso, data: {} });
        changed.add(key);
        if (transition) out.push(componentNotice(id, transition, prev, next, settings.confirmChecks, nowMs));
      }
      const d = diskObservation(checks.disk, settings);
      const prev = states.get(DISK_KEY)?.track ?? { ...EMPTY_TRACK };
      const { next, transition } = stepTrack(prev, d.obs, d.detail, settings.confirmChecks, nowIso);
      states.set(DISK_KEY, {
        kind: 'disk', track: next, lastCheckedAt: nowIso,
        data: checks.disk ? { totalBytes: checks.disk.totalBytes, availableBytes: checks.disk.availableBytes } : {},
      });
      changed.add(DISK_KEY);
      if (transition) out.push(diskNotice(transition, prev, next, settings, nowMs));
    }

    // 3. Backup runs (needs the database).
    try {
      const stored = states.get(CURSOR_KEY);
      let cursor = stored && typeof stored.data.finishedAt === 'string' ? { finishedAt: stored.data.finishedAt, id: Number(stored.data.id) || 0 } : null;
      if (!cursor) {
        cursor = await initialCursor();
        if (cursor) { states.set(CURSOR_KEY, { kind: 'cursor', track: { ...EMPTY_TRACK }, lastCheckedAt: nowIso, data: { ...cursor } }); changed.add(CURSOR_KEY); }
      }
      const runs = await newBackupRuns(cursor, nowMs);
      for (const r of runs) {
        const key = backupKey(r.scope, r.account_id, r.account_username);
        const prev = backupTrackOf(states.get(key));
        const outcome: BackupOutcome = r.status === 'ok' ? 'ok' : r.status === 'partial' ? 'partial' : 'failed';
        const errs = errorsOf(r);
        const { next, transition } = stepBackup(prev, outcome, Number(r.id), errs[0] ?? null, iso(r.finished_at) ?? nowIso);
        states.set(key, {
          kind: 'backup', track: next, lastCheckedAt: nowIso,
          data: { failures: next.failures, lastRunId: next.lastRunId, scope: r.scope, accountId: r.account_id, accountUsername: r.account_username },
        });
        changed.add(key);
        if (transition) out.push(backupNotice(r, transition, prev, nowMs));
        states.set(CURSOR_KEY, { kind: 'cursor', track: { ...EMPTY_TRACK }, lastCheckedAt: nowIso, data: { finishedAt: iso(r.finished_at), id: Number(r.id) } });
        changed.add(CURSOR_KEY);
      }
    } catch (err) {
      logger.debug({ err }, 'health center: backup runs not examined');
    }

    // 4. Persist, then notify (a restart after the save never notifies again).
    try {
      await saveStates(changed);
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, 'health center: states not saved (kept in memory)');
    }
    lastTickAt = nowIso;
    if (settings.enabled) {
      for (const n of out) {
        if (settings.events[n.event]) deps.notify(n.event, n.payload);
      }
    }
    if (out.length) logger.info({ transitions: out.map((n) => n.payload.key) }, 'health center: transitions');
  } catch (err) {
    logger.warn({ err }, 'health center: tick failed');
  } finally {
    ticking = false;
  }
}

// ── API ──────────────────────────────────────────────────────────────────────

async function lastBackupFailure(): Promise<HealthCenterBackupFailure | null> {
  const r = await db('backup_runs').whereIn('status', ['failed', 'partial']).whereNotNull('finished_at').orderBy([{ column: 'finished_at', order: 'desc' }, { column: 'id', order: 'desc' }])
    .first('id', 'scope', 'account_id', 'account_username', 'status', 'destination_name', 'errors', 'finished_at') as RunRow | undefined;
  if (!r) return null;
  return {
    runId: Number(r.id), scope: r.scope, accountId: r.account_id, accountUsername: r.account_username, status: r.status === 'partial' ? 'partial' : 'failed',
    destinationName: r.destination_name, finishedAt: iso(r.finished_at), error: errorsOf(r)[0]?.slice(0, 500) ?? null,
  };
}

async function statusOut(settings: HealthCenterSettings): Promise<HealthCenterStatus> {
  if (!statesLoaded) { try { await loadStates(); } catch { /* shown from memory */ } }
  const components = HEALTH_CENTER_COMPONENT_IDS.map((id) => {
    const s = states.get(`component:${id}`);
    return { id, status: s?.track.status ?? 'unknown', detail: s?.track.detail ?? null, pending: s?.track.streak ?? 0, since: s?.track.since ?? null, lastCheckedAt: s?.lastCheckedAt ?? null };
  });
  const d = states.get(DISK_KEY);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const failing: HealthCenterBackupTarget[] = [];
  for (const [, s] of states) {
    if (s.kind !== 'backup' || s.track.status !== 'fail') continue;
    failing.push({
      scope: s.data.scope === 'panel' ? 'panel' : 'account',
      accountId: num(s.data.accountId),
      accountUsername: typeof s.data.accountUsername === 'string' ? s.data.accountUsername : null,
      failures: num(s.data.failures) ?? 1,
      since: s.track.since,
      lastRunId: num(s.data.lastRunId),
      lastError: s.track.detail,
    });
  }
  failing.sort((a, b) => String(b.since ?? '').localeCompare(String(a.since ?? '')));
  return {
    settings,
    workersEnabled: deps.workersEnabled(),
    lastTickAt,
    components,
    disk: {
      status: d?.track.status ?? 'unknown',
      totalBytes: num(d?.data.totalBytes),
      availableBytes: num(d?.data.availableBytes),
      pending: d?.track.streak ?? 0,
      since: d?.track.since ?? null,
      lastCheckedAt: d?.lastCheckedAt ?? null,
    },
    backups: { failing: failing.slice(0, 50), lastFailure: await lastBackupFailure() },
  };
}

export const healthCenterService = {
  async getStatus(): Promise<HealthCenterStatus> {
    return statusOut(await loadSettings());
  },

  async getSettings(): Promise<HealthCenterSettings> {
    return loadSettings();
  },

  /** Partial update (validated by the route schema, merged, validated whole). */
  async updateSettings(req: Request, input: HealthCenterSettingsInput): Promise<HealthCenterStatus> {
    const current = await loadSettings();
    const merged = { ...current, ...input, events: { ...current.events, ...(input.events ?? {}) } };
    const parsed = settingsSchema.safeParse(merged);
    if (!parsed.success) {
      throw new AppError(400, `Validation failed — ${parsed.error.errors.map((e) => `${e.path.join('.') || '<root>'}: ${e.message}`).join('; ')}`, 'validation');
    }
    const next = parsed.data as HealthCenterSettings;
    await db('app_config').insert({ key: SETTINGS_KEY, value: JSON.stringify(next) }).onConflict('key').merge();
    lastSettings = next;
    const changedFields = (Object.keys(input) as Array<keyof HealthCenterSettingsInput>).filter((k) => JSON.stringify(current[k]) !== JSON.stringify(next[k]));
    if (changedFields.length) await auditService.logReq(req, 'system.healthCenter.update', { details: { changed: changedFields, settings: next } });
    return statusOut(next);
  },

  start(): void {
    if (timer) return;
    // A first pass shortly after the start (the boot workers settle), then every minute.
    firstTimer = setTimeout(() => { firstTimer = null; void healthCenterTick(); }, 20_000);
    firstTimer.unref?.();
    timer = setInterval(() => { void healthCenterTick(); }, TICK_MS);
    timer.unref?.();
  },

  stop(): void {
    if (timer) clearInterval(timer);
    if (firstTimer) clearTimeout(firstTimer);
    timer = null;
    firstTimer = null;
  },
};

/** Tests: replace the dependencies (null restores) and forget the in-memory state. */
export function setHealthCenterForTests(override: Partial<HealthCenterDeps> | null): void {
  deps = override ? { ...realDeps, ...override } : realDeps;
  states.clear();
  statesLoaded = false;
  lastTickAt = null;
  lastSettings = cloneDefaults();
  ticking = false;
}
