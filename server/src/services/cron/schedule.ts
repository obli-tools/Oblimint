import { parseExpression } from 'cron-parser';

// ─────────────────────────────────────────────────────────────────────────────
// Cron schedule validation and next-run computation (docs/P2-PLAN.md §9.6).
// Pure: no DB, no clock (the reference date is always passed in).
//
// Accepted: a classic 5-field crontab expression (minute hour day month
// weekday), evaluated in UTC, or one of @hourly / @daily / @weekly /
// @monthly. Refused: a seconds field (6 fields), @reboot / @yearly, anything
// cron-parser cannot read. The plan's minimum interval is checked on the
// gaps between the next occurrences (MIN_INTERVAL_SAMPLE runs).
// ─────────────────────────────────────────────────────────────────────────────

export const SCHEDULE_ALIASES = ['@hourly', '@daily', '@weekly', '@monthly'] as const;

/** Occurrences sampled for the minimum interval check (plan: the next 5). */
export const MIN_INTERVAL_SAMPLE = 5;

export class ScheduleError extends Error {
  constructor(
    message: string,
    /** 'invalid' → 400 cronInvalidSchedule; 'tooFrequent' → 409 cronTooFrequent. */
    public readonly reason: 'invalid' | 'tooFrequent',
  ) {
    super(message);
    this.name = 'ScheduleError';
  }
}

/** Canonical form stored in cron_jobs.schedule (single spaces, lowercase alias). */
export function normalizeSchedule(raw: string): string {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  return s.startsWith('@') ? s.toLowerCase() : s;
}

function parse(schedule: string, from: Date) {
  return parseExpression(schedule, { currentDate: from, utc: true });
}

/**
 * Throws ScheduleError('invalid') unless `raw` is an accepted expression.
 * Returns the normalized expression.
 */
export function assertValidSchedule(raw: string): string {
  const s = normalizeSchedule(raw);
  if (!s || s.length > 100) throw new ScheduleError('Invalid cron schedule', 'invalid');
  if (s.startsWith('@')) {
    if (!(SCHEDULE_ALIASES as readonly string[]).includes(s)) {
      throw new ScheduleError(`Unsupported schedule alias ${s} (use ${SCHEDULE_ALIASES.join(', ')})`, 'invalid');
    }
  } else {
    const fields = s.split(' ');
    if (fields.length !== 5) {
      throw new ScheduleError('A cron schedule has exactly 5 fields: minute hour day month weekday (no seconds)', 'invalid');
    }
    // Only the crontab alphabet: digits, names (jan, mon…), * , - / and L / # / ? of cron-parser.
    if (!/^[A-Za-z0-9*,\-/#?]+$/.test(fields.join(''))) throw new ScheduleError('Invalid cron schedule', 'invalid');
  }
  try {
    parse(s, new Date(0)).next();
  } catch (err) {
    throw new ScheduleError(`Invalid cron schedule: ${(err as Error)?.message ?? String(err)}`, 'invalid');
  }
  return s;
}

/** The next `count` occurrences strictly after `from` (UTC). */
export function nextOccurrences(schedule: string, from: Date, count: number): Date[] {
  const it = parse(schedule, from);
  const out: Date[] = [];
  for (let i = 0; i < count; i++) {
    try {
      out.push((it.next() as unknown as { toDate(): Date }).toDate());
    } catch {
      break; // no further occurrence (e.g. 30 feb never happens)
    }
  }
  return out;
}

/** Next run strictly after `from`, or null when the expression never fires again. */
export function nextRunAt(schedule: string, from: Date): Date | null {
  try {
    return nextOccurrences(schedule, from, 1)[0] ?? null;
  } catch {
    return null;
  }
}

/** Smallest gap (minutes) between the next MIN_INTERVAL_SAMPLE occurrences after `from`. */
export function minGapMinutes(schedule: string, from: Date): number | null {
  const occ = nextOccurrences(schedule, from, MIN_INTERVAL_SAMPLE);
  let min: number | null = null;
  for (let i = 1; i < occ.length; i++) {
    const gap = (occ[i].getTime() - occ[i - 1].getTime()) / 60_000;
    if (min === null || gap < min) min = gap;
  }
  return min;
}

/**
 * Full check of a schedule against the plan: valid expression, fires at
 * least once, and no two of the next occurrences closer than `minIntervalMin`.
 * Returns the normalized expression.
 */
export function validateSchedule(raw: string, minIntervalMin: number, from: Date = new Date()): string {
  const s = assertValidSchedule(raw);
  if (nextRunAt(s, from) === null) throw new ScheduleError('This cron schedule never fires', 'invalid');
  const min = Math.max(1, Math.floor(Number(minIntervalMin) || 1));
  const gap = minGapMinutes(s, from);
  if (gap !== null && gap < min) {
    throw new ScheduleError(`This schedule runs more often than the plan allows (every ${min} min at most)`, 'tooFrequent');
  }
  return s;
}
