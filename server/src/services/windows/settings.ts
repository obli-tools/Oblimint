import { parseExpression } from 'cron-parser';
import type { SiteMaintenanceSettings, SiteMaintenanceSettingsUpdate, WindowSchedule } from '@oblimint/shared';
import { DEFAULT_SITE_MAINTENANCE_SETTINGS } from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';

// ─────────────────────────────────────────────────────────────────────────────
// Window settings of a site (site_maintenance.settings, docs/P3-PLAN.md §5.2).
// PURE: no DB, no clock (the reference date is passed in) — tested in
// settings.test.ts. The service checks what needs the DB (databases of the
// account) and persists.
//
// Schedule: 5-field cron (minute hour dom month dow) or @hourly / @daily /
// @weekly / @monthly, evaluated in an IANA time zone (cron-parser tz), a
// duration ≤ maintenance.maxWindowMinutes, an optional kickPath (absolute
// path of the site, never a URL: N1).
// ─────────────────────────────────────────────────────────────────────────────

const ALIASES = ['@hourly', '@daily', '@weekly', '@monthly'];

/** Path requested during a scheduled window: '/x/y.php?a=b', never '//host' nor a scheme. */
const KICK_PATH_RE = /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@/%?]*$/;

/** Stored jsonb → settings with every default merged (never throws). */
export function mergeSettings(raw: unknown): SiteMaintenanceSettings {
  const d = DEFAULT_SITE_MAINTENANCE_SETTINGS;
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<SiteMaintenanceSettings>;
  const snap = v.snapshot && typeof v.snapshot === 'object' ? v.snapshot : d.snapshot;
  const sched = v.schedule && typeof v.schedule === 'object' ? v.schedule : null;
  return {
    pendingPolicy: v.pendingPolicy === 'revert' ? 'revert' : 'keep',
    schedule: sched ? {
      enabled: !!sched.enabled,
      cron: String(sched.cron ?? ''),
      timezone: String(sched.timezone || 'UTC'),
      durationMinutes: Number(sched.durationMinutes) > 0 ? Math.trunc(Number(sched.durationMinutes)) : d.defaultDurationMinutes,
      kickPath: typeof sched.kickPath === 'string' && sched.kickPath ? sched.kickPath : null,
    } : null,
    autoValidate: v.autoValidate === 'off' || v.autoValidate === 'scheduled-api' ? v.autoValidate : d.autoValidate,
    snapshot: {
      mode: snap.mode === 'selected' || snap.mode === 'none' ? snap.mode : 'all',
      databaseIds: Array.isArray(snap.databaseIds) ? snap.databaseIds.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [],
    },
    supervised: v.supervised === true,
    digestIntervalHours: Number(v.digestIntervalHours) >= 1 ? Math.trunc(Number(v.digestIntervalHours)) : d.digestIntervalHours,
    defaultDurationMinutes: Number(v.defaultDurationMinutes) >= 5 ? Math.trunc(Number(v.defaultDurationMinutes)) : d.defaultDurationMinutes,
  };
}

/** A valid IANA time zone name (Intl knows it). */
export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function invalid(message: string): AppError {
  return new AppError(400, message, 'invalidSchedule');
}

function tooLong(maxMinutes: number): AppError {
  return new AppError(409, `A window lasts at most ${maxMinutes} minutes`, 'windowMaxDuration', { maxMinutes });
}

/** Normalized cron expression, or 400 invalidSchedule. */
export function normalizeCron(raw: string): string {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!s || s.length > 100) throw invalid('Invalid cron expression');
  if (s.startsWith('@')) {
    const a = s.toLowerCase();
    if (!ALIASES.includes(a)) throw invalid(`Unsupported schedule alias ${s} (use ${ALIASES.join(', ')})`);
    return a;
  }
  const fields = s.split(' ');
  if (fields.length !== 5) throw invalid('A cron expression has exactly 5 fields: minute hour day month weekday');
  if (!/^[A-Za-z0-9*,\-/#?]+$/.test(fields.join(''))) throw invalid('Invalid cron expression');
  return s;
}

/** Next occurrence of a schedule strictly after `from` in its time zone, null when it never fires. */
export function nextScheduleAt(schedule: Pick<WindowSchedule, 'cron' | 'timezone'>, from: Date): Date | null {
  try {
    const it = parseExpression(schedule.cron, { currentDate: from, tz: schedule.timezone || 'UTC' });
    return (it.next() as unknown as { toDate(): Date }).toDate();
  } catch {
    return null;
  }
}

/** Validates a schedule (400 invalidSchedule / 409 windowMaxDuration); returns its normalized form. */
export function validateSchedule(input: WindowSchedule, maxWindowMinutes: number, from: Date): WindowSchedule {
  const cron = normalizeCron(input.cron);
  const timezone = String(input.timezone ?? '').trim() || 'UTC';
  if (!isValidTimezone(timezone)) throw invalid(`Unknown time zone: ${timezone}`);
  const duration = Math.trunc(Number(input.durationMinutes));
  if (!Number.isFinite(duration) || duration < 5) throw invalid('A scheduled window lasts at least 5 minutes');
  if (duration > maxWindowMinutes) throw tooLong(maxWindowMinutes);
  let kickPath: string | null = null;
  if (input.kickPath !== null && input.kickPath !== undefined && String(input.kickPath).trim() !== '') {
    kickPath = String(input.kickPath).trim();
    if (kickPath.length > 255 || !KICK_PATH_RE.test(kickPath)) throw invalid('kickPath must be an absolute path of the site (e.g. /wp-cron.php)');
  }
  try {
    parseExpression(cron, { currentDate: from, tz: timezone }).next();
  } catch (err) {
    throw invalid(`Invalid cron expression: ${(err as Error)?.message ?? String(err)}`);
  }
  if (nextScheduleAt({ cron, timezone }, from) === null) throw invalid('This schedule never fires');
  return { enabled: !!input.enabled, cron, timezone, durationMinutes: duration, kickPath };
}

/**
 * current + update → new settings (400 / 409 on invalid values). Database ids
 * of a 'selected' snapshot are checked by the caller (they need the DB).
 */
export function applySettingsUpdate(current: SiteMaintenanceSettings, body: SiteMaintenanceSettingsUpdate, maxWindowMinutes: number, now: Date): SiteMaintenanceSettings {
  const next: SiteMaintenanceSettings = { ...current, snapshot: { ...current.snapshot } };
  if (body.pendingPolicy !== undefined) next.pendingPolicy = body.pendingPolicy;
  if (body.autoValidate !== undefined) next.autoValidate = body.autoValidate;
  if (body.supervised !== undefined) next.supervised = body.supervised;
  if (body.digestIntervalHours !== undefined) next.digestIntervalHours = Math.trunc(body.digestIntervalHours);
  if (body.defaultDurationMinutes !== undefined) {
    const d = Math.trunc(body.defaultDurationMinutes);
    if (d > maxWindowMinutes) throw tooLong(maxWindowMinutes);
    next.defaultDurationMinutes = d;
  }
  if (body.schedule !== undefined) next.schedule = body.schedule === null ? null : validateSchedule(body.schedule, maxWindowMinutes, now);
  if (body.snapshot !== undefined) {
    const ids = [...new Set((body.snapshot.databaseIds ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    next.snapshot = { mode: body.snapshot.mode, databaseIds: body.snapshot.mode === 'selected' ? ids : [] };
  }
  return next;
}

/** site_maintenance.next_window_at for these settings. */
export function nextWindowAt(settings: SiteMaintenanceSettings, from: Date): Date | null {
  const s = settings.schedule;
  if (!s || !s.enabled) return null;
  return nextScheduleAt(s, from);
}
