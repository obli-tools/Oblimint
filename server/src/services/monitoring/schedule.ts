import type { AppMaintenanceSchedule } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Maintenance window math (docs/P4b-PLAN.md §11.4) — PURE. A window opens on
// each selected weekday at HH:MM wall-clock time of its IANA time zone and
// stays open `durationMinutes` of real time (it may cross midnight and the
// end of the week). Time zones through Intl (no tz database of our own):
//   - a start inside a DST gap (02:30 on the spring-forward night) opens at
//     the first valid instant after it (03:30 local);
//   - a start inside a repeated hour (fall back) opens at its later
//     occurrence (the wall clock reads HH:MM, standard time).
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_WINDOW_MINUTES = 7 * 24 * 60;
const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    if (formatters.size > 200) formatters.clear();
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

export function zonedParts(at: Date, tz: string): ZonedParts {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(at)) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  const hour = parts.hour === 24 ? 0 : parts.hour;
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour,
    minute: parts.minute,
    second: parts.second,
    weekday: new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay(),
  };
}

/** Offset of the zone at `at` (local − UTC), ms. */
export function tzOffsetMs(at: Date, tz: string): number {
  const p = zonedParts(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Instant of a wall-clock time of `tz` (gap → shifted forward, repeated hour → later occurrence). */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const off1 = tzOffsetMs(new Date(guess), tz);
  let t = guess - off1;
  const off2 = tzOffsetMs(new Date(t), tz);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

/** Why a schedule is unusable (null = valid). `timezone` problems are reported separately by the caller (code). */
export function scheduleProblem(s: unknown): { code: 'invalidSchedule' | 'invalidTimezone'; message: string } | null {
  if (!s || typeof s !== 'object') return { code: 'invalidSchedule', message: 'Schedule required' };
  const v = s as Partial<AppMaintenanceSchedule>;
  if (!Array.isArray(v.days) || v.days.length === 0 || v.days.length > 7) return { code: 'invalidSchedule', message: 'At least one day is required' };
  if (v.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6) || new Set(v.days).size !== v.days.length) {
    return { code: 'invalidSchedule', message: 'Days are 0 (Sunday) … 6 (Saturday), each once' };
  }
  if (typeof v.start !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.start)) return { code: 'invalidSchedule', message: 'Start must be HH:MM' };
  if (!Number.isInteger(v.durationMinutes) || (v.durationMinutes as number) < 1 || (v.durationMinutes as number) > MAX_WINDOW_MINUTES) {
    return { code: 'invalidSchedule', message: `Duration must be 1 … ${MAX_WINDOW_MINUTES} minutes` };
  }
  if (!isValidTimeZone(v.timezone)) return { code: 'invalidTimezone', message: 'Unknown time zone' };
  return null;
}

/** Starts of the window on the local days [first, last] around `at` (local day offsets), ascending. */
function startsAround(s: AppMaintenanceSchedule, at: Date, firstOffset: number, lastOffset: number): Date[] {
  const local = zonedParts(at, s.timezone);
  const [hh, mm] = s.start.split(':').map(Number);
  const days = new Set(s.days);
  const out: Date[] = [];
  for (let k = firstOffset; k <= lastOffset; k++) {
    const d = new Date(Date.UTC(local.year, local.month - 1, local.day + k));
    if (!days.has(d.getUTCDay())) continue;
    out.push(zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hh, mm, s.timezone));
  }
  return out;
}

/** The opening containing `at`, or null. */
export function currentOpening(s: AppMaintenanceSchedule, at: Date): { start: Date; end: Date } | null {
  if (scheduleProblem(s)) return null;
  const durMs = s.durationMinutes * 60_000;
  const back = Math.ceil(durMs / DAY_MS) + 1;
  for (const start of startsAround(s, at, -back, 0).reverse()) {
    const end = new Date(start.getTime() + durMs);
    if (start.getTime() <= at.getTime() && at.getTime() < end.getTime()) return { start, end };
  }
  return null;
}

export function windowIsOpen(s: AppMaintenanceSchedule, at: Date): boolean {
  return currentOpening(s, at) !== null;
}

/** `from` when open, else the next start after it; null for an invalid schedule. */
export function nextWindowOpening(s: AppMaintenanceSchedule, from: Date): Date | null {
  if (scheduleProblem(s)) return null;
  if (windowIsOpen(s, from)) return from;
  for (const start of startsAround(s, from, 0, 8)) if (start.getTime() > from.getTime()) return start;
  return null;
}
