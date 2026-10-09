// Pure helpers of the usage / quota UI (no React, no i18n instance): byte
// formatting, months, quota levels, chart series. Kept free of runtime
// imports so they can be unit-tested with node:test.

export interface ByteUnits { b: string; kb: string; mb: string; gb: string; tb: string }

export const DEFAULT_BYTE_UNITS: ByteUnits = { b: 'B', kb: 'KB', mb: 'MB', gb: 'GB', tb: 'TB' };

/** Rounded number for display (≤ `decimals` decimals, no trailing zeros). */
function trim(n: number, decimals: number): string {
  const f = 10 ** decimals;
  return String(Math.round(n * f) / f);
}

/** Bytes → "512 B" / "1.5 KB" / "12 MB" / "3.2 GB" (binary multiples, translated unit labels). */
export function formatBytes(bytes: number | null | undefined, units: ByteUnits = DEFAULT_BYTE_UNITS): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  const abs = Math.abs(bytes);
  const steps: Array<[number, string]> = [[1024 ** 4, units.tb], [1024 ** 3, units.gb], [1024 ** 2, units.mb], [1024, units.kb]];
  for (const [size, label] of steps) {
    if (abs >= size) {
      const v = bytes / size;
      return `${trim(v, Math.abs(v) >= 100 ? 0 : 1)} ${label}`;
    }
  }
  return `${Math.round(bytes)} ${units.b}`;
}

/** Compact count: 950 → "950", 12 400 → "12.4k", 3 200 000 → "3.2M". */
export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${trim(n / 1e6, 1)}M`;
  if (abs >= 1e4) return `${trim(n / 1e3, 1)}k`;
  return String(Math.round(n));
}

/** 'YYYY-MM' of a date (UTC calendar month, as the server counts traffic). */
export function isoMonth(d: Date = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Month shifted by `delta` months ('2026-01', -1 → '2025-12'). */
export function shiftMonth(month: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const idx = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

/** The `count` last months, most recent first ('YYYY-MM'). */
export function recentMonths(count: number, now: Date = new Date()): string[] {
  const cur = isoMonth(now);
  return Array.from({ length: count }, (_, i) => shiftMonth(cur, -i));
}

/** Days ('YYYY-MM-DD') of a month, up to today when it is the current month. */
export function daysOfMonth(month: string, now: Date = new Date()): string[] {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return [];
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const isCurrent = month === isoMonth(now);
  const end = isCurrent ? Math.min(last, now.getUTCDate()) : last;
  return Array.from({ length: end }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

export interface DayValue { day: string; value: number }

/**
 * Daily series of a month with the missing days at 0 (the server only
 * returns days that have traffic). Points outside the month are ignored.
 */
export function fillMonthDays<T extends { day: string }>(month: string, points: T[], pick: (p: T) => number, now: Date = new Date()): DayValue[] {
  const byDay = new Map<string, number>();
  for (const p of points) byDay.set(p.day, (byDay.get(p.day) ?? 0) + pick(p));
  return daysOfMonth(month, now).map((day) => ({ day, value: byDay.get(day) ?? 0 }));
}

/** Highest alert threshold reached by `pct` (thresholds sorted or not), null below all. */
export function quotaLevel(pct: number | null | undefined, thresholds: readonly number[] = [80, 100]): number | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  let level: number | null = null;
  for (const th of thresholds) if (pct >= th && (level === null || th > level)) level = th;
  return level;
}

/** Gauge colour: green below 80 %, amber from 80 %, red from 100 % (CSS colour). */
export function quotaColor(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return 'rgb(var(--c-text-muted))';
  if (pct >= 100) return '#ef4444';
  if (pct >= 80) return '#f5a623';
  return '#1edd8a';
}

/** used / limit in percent (not clamped: 130 % stays 130), null when unlimited / unknown. */
export function quotaPct(used: number | null | undefined, limit: number | null | undefined): number | null {
  if (used == null || limit == null || !Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  return (used / limit) * 100;
}

/** Sum of a numeric field over a list. */
export function sumBy<T>(list: readonly T[], pick: (v: T) => number): number {
  let s = 0;
  for (const v of list) s += pick(v) || 0;
  return s;
}

/**
 * "Nice" upper bound of a chart axis (1, 2, 2.5, 5 × 10^n ≥ max), so grid
 * lines fall on round values. 0 / negative → 1.
 */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= max) return m * exp;
  return 10 * exp;
}
