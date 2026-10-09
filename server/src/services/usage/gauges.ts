import type { IsoDay, IsoMonth, QuotaDimension, QuotaGauge, TrafficPoint } from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers of the usage module: calendar months (UTC), quota gauges and
// threshold levels, day series, human sizes for the French notifications.
// ─────────────────────────────────────────────────────────────────────────────

export const MIB = 1024 * 1024;

/** 'YYYY-MM' of a date (UTC). */
export function monthOf(d: Date = new Date()): IsoMonth {
  return d.toISOString().slice(0, 7);
}

/** 'YYYY-MM-DD' of a date (UTC). */
export function dayOf(d: Date = new Date()): IsoDay {
  return d.toISOString().slice(0, 10);
}

/** ?month= → IsoMonth (current month when absent); 400 validation when malformed. */
export function parseMonth(v: unknown, now: Date = new Date()): IsoMonth {
  if (v === undefined || v === null || v === '') return monthOf(now);
  if (typeof v !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) {
    throw new AppError(400, 'Validation failed — month: expected YYYY-MM', 'validation', { month: ['expected YYYY-MM'] });
  }
  return v;
}

/** [start, end) days of a month: start = first day, end = first day of the next month. */
export function monthRange(month: IsoMonth): { start: IsoDay; end: IsoDay } {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return { start: dayOf(start), end: dayOf(end) };
}

/** Days from `from` to `to` inclusive (UTC), at most 400. */
export function daysBetween(from: IsoDay, to: IsoDay): IsoDay[] {
  const out: IsoDay[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const last = new Date(`${to}T00:00:00Z`).getTime();
  while (d.getTime() <= last && out.length < 400) {
    out.push(dayOf(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Days of a month shown in a series: the whole month when past, up to today when current, none when future. */
export function monthDays(month: IsoMonth, now: Date = new Date()): IsoDay[] {
  const { start, end } = monthRange(month);
  const today = dayOf(now);
  if (start > today) return [];
  const lastOfMonth = dayOf(new Date(new Date(`${end}T00:00:00Z`).getTime() - 86_400_000));
  return daysBetween(start, lastOfMonth < today ? lastOfMonth : today);
}

/** Dense daily series (missing days = 0). */
export function fillTraffic(days: IsoDay[], rows: Array<{ day: IsoDay; requests: number; bytesOut: number; bytesIn: number }>): TrafficPoint[] {
  const map = new Map(rows.map((r) => [r.day, r]));
  return days.map((day) => {
    const r = map.get(day);
    return { day, requests: r?.requests ?? 0, bytesOut: r?.bytesOut ?? 0, bytesIn: r?.bytesIn ?? 0 };
  });
}

/** Highest threshold reached by `pct` (thresholds ascending or not), null below the first one. */
export function levelOf(pct: number | null, thresholds: readonly number[]): number | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  let level: number | null = null;
  for (const t of thresholds) if (pct >= t && (level === null || t > level)) level = t;
  return level;
}

/**
 * Gauge of one dimension. limit null = unlimited (no pct, no level). A zero
 * limit is reached as soon as anything is used (100 %).
 */
export function gaugeOf(dimension: QuotaDimension, used: number, limit: number | null, thresholds: readonly number[]): QuotaGauge {
  const u = Math.max(0, Number(used) || 0);
  if (limit === null || limit === undefined || !Number.isFinite(limit)) return { dimension, used: u, limit: null, pct: null, level: null };
  const l = Math.max(0, limit);
  const pct = l > 0 ? Math.round((u / l) * 1000) / 10 : u > 0 ? 100 : 0;
  return { dimension, used: u, limit: l, pct, level: levelOf(pct, thresholds) };
}

/** MiB limit of a plan / envelope → bytes (null stays unlimited). */
export function mbToBytes(mb: number | null | undefined): number | null {
  return mb === null || mb === undefined ? null : Math.round(mb * MIB);
}

/** Period of an alert: the month for traffic (monthly reset), 'current' for the others. */
export function alertPeriod(dimension: QuotaDimension, month: IsoMonth): string {
  return dimension === 'traffic' ? month : 'current';
}

/** French human size (1 décimale, unités binaires). */
export function humanBytes(n: number): string {
  const units = ['o', 'Kio', 'Mio', 'Gio', 'Tio', 'Pio'];
  let v = Math.max(0, Number(n) || 0);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const s = i === 0 ? String(Math.round(v)) : v.toFixed(1).replace('.', ',');
  return `${s} ${units[i]}`;
}

/** French label of a dimension. */
export const DIMENSION_LABELS_FR: Record<QuotaDimension, string> = {
  disk: 'disque',
  traffic: 'trafic mensuel',
  databases: 'bases de données',
  dbSize: 'taille des bases de données',
};

/** Value of a gauge in French (sizes or counts). */
export function humanValue(dimension: QuotaDimension, v: number): string {
  return dimension === 'databases' ? String(Math.round(v)) : humanBytes(v);
}
