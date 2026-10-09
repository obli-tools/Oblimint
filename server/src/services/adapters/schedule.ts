import { parseExpression } from 'cron-parser';
import { AppError } from '../../middleware/errorHandler';
import { assertValidSchedule, ScheduleError } from '../cron/schedule';

// ─────────────────────────────────────────────────────────────────────────────
// Adapter schedules (adapter_schedules, docs/P3-PLAN.md §11). Pure: the
// reference date is always passed in.
//
// Same expression alphabet as the cron jobs (5 fields or @hourly / @daily /
// @weekly / @monthly, cron/schedule.ts), evaluated in an IANA time zone
// (cron-parser@4 `tz`, DST handled by it), and at most one run per hour
// (an update run copies the release, snapshots the databases, publishes).
// ─────────────────────────────────────────────────────────────────────────────

export const ADAPTER_SCHEDULE_MIN_INTERVAL_MIN = 60;
const SAMPLE = 5;

export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function occurrences(cron: string, timezone: string, from: Date, count: number): Date[] {
  const it = parseExpression(cron, { currentDate: from, tz: timezone });
  const out: Date[] = [];
  for (let i = 0; i < count; i++) {
    try {
      out.push((it.next() as unknown as { toDate(): Date }).toDate());
    } catch {
      break;
    }
  }
  return out;
}

/** Next run strictly after `from` in `timezone`, null when the expression never fires again (or is unreadable). */
export function nextAdapterRunAt(cron: string, timezone: string, from: Date): Date | null {
  try {
    return occurrences(cron, timezone, from, 1)[0] ?? null;
  } catch {
    return null;
  }
}

function invalid(message: string, details?: Record<string, unknown>): AppError {
  return new AppError(400, message, 'invalidSchedule', details);
}

/**
 * Validates a schedule (400 invalidSchedule): expression, time zone, fires
 * at least once, no two of the next occurrences closer than one hour.
 * Returns the normalized expression, the zone and the next run.
 */
export function validateAdapterSchedule(rawCron: string, rawTz: string | null | undefined, from: Date = new Date()): { cron: string; timezone: string; next: Date } {
  let cron: string;
  try {
    cron = assertValidSchedule(rawCron);
  } catch (err) {
    if (err instanceof ScheduleError) throw invalid(err.message);
    throw err;
  }
  const timezone = (rawTz ?? 'UTC').trim() || 'UTC';
  if (!isValidTimezone(timezone)) throw invalid(`Unknown time zone ${JSON.stringify(timezone)}`, { timezone });
  let occ: Date[];
  try {
    occ = occurrences(cron, timezone, from, SAMPLE);
  } catch (err) {
    throw invalid(`Invalid cron schedule: ${(err as Error)?.message ?? String(err)}`);
  }
  if (occ.length === 0) throw invalid('This schedule never fires');
  for (let i = 1; i < occ.length; i++) {
    if ((occ[i].getTime() - occ[i - 1].getTime()) / 60_000 < ADAPTER_SCHEDULE_MIN_INTERVAL_MIN) {
      throw invalid(`An adapter schedule runs at most once per hour`, { minIntervalMin: ADAPTER_SCHEDULE_MIN_INTERVAL_MIN });
    }
  }
  return { cron, timezone, next: occ[0] };
}
