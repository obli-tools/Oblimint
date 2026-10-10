import { parseExpression } from 'cron-parser';
import type { WorkflowTrigger } from '@oblimint/shared';
import { isValidTimeZone } from '../schedule';

// ─────────────────────────────────────────────────────────────────────────────
// Workflow triggers (docs/P4b-PLAN.md §11.1) — PURE: validation, next run of
// the interval / cron triggers, certificate name matching of cert-renewal.
// Cron: 5 fields (minute precision), evaluated in `timezone` (UTC by
// default); two consecutive runs closer than MIN_PERIOD_MINUTES are refused,
// as for the interval trigger.
// ─────────────────────────────────────────────────────────────────────────────

export const MIN_PERIOD_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 31 * 24 * 60;

export interface TriggerProblem {
  code: 'invalidCron' | 'invalidTimezone' | 'validation';
  message: string;
}

function cronIterator(expr: string, from: Date, tz: string) {
  return parseExpression(expr, { currentDate: from, tz });
}

export function triggerProblem(t: WorkflowTrigger): TriggerProblem | null {
  switch (t.kind) {
    case 'interval': {
      const m = Number(t.intervalMinutes);
      if (!Number.isInteger(m) || m < MIN_PERIOD_MINUTES || m > MAX_INTERVAL_MINUTES) {
        return { code: 'validation', message: `The interval must be ${MIN_PERIOD_MINUTES} … ${MAX_INTERVAL_MINUTES} minutes` };
      }
      return null;
    }
    case 'cron': {
      const tz = t.timezone || 'UTC';
      if (!isValidTimeZone(tz)) return { code: 'invalidTimezone', message: 'Unknown time zone' };
      const expr = (t.cron ?? '').trim();
      if (!expr || expr.split(/\s+/).length !== 5) return { code: 'invalidCron', message: 'A cron expression has 5 fields (minute hour day month weekday)' };
      try {
        const it = cronIterator(expr, new Date(), tz);
        let prev = it.next().toDate().getTime();
        for (let i = 0; i < 12; i++) {
          const next = it.next().toDate().getTime();
          if (next - prev < MIN_PERIOD_MINUTES * 60_000) return { code: 'invalidCron', message: `Runs must be at least ${MIN_PERIOD_MINUTES} minutes apart` };
          prev = next;
        }
      } catch {
        return { code: 'invalidCron', message: 'Invalid cron expression' };
      }
      return null;
    }
    case 'cert-renewal': {
      const names = t.certificateNames ?? [];
      if (!Array.isArray(names) || names.length > 50) return { code: 'validation', message: 'At most 50 certificate names' };
      if (names.some((n) => typeof n !== 'string' || !/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(n) || n.length > 253)) {
        return { code: 'validation', message: 'Invalid certificate name' };
      }
      return null;
    }
    case 'manual':
      return null;
    default:
      return { code: 'validation', message: 'Unknown trigger' };
  }
}

/** Normalized trigger (only the fields of its kind). */
export function normalizeTrigger(t: WorkflowTrigger): WorkflowTrigger {
  switch (t.kind) {
    case 'interval': return { kind: 'interval', intervalMinutes: Number(t.intervalMinutes) };
    case 'cron': return { kind: 'cron', cron: (t.cron ?? '').trim().replace(/\s+/g, ' '), timezone: t.timezone || 'UTC' };
    case 'cert-renewal': return { kind: 'cert-renewal', certificateNames: [...new Set((t.certificateNames ?? []).map((n) => n.toLowerCase()))] };
    default: return { kind: 'manual' };
  }
}

/** Next scheduled run strictly after `from` (null for cert-renewal / manual or an invalid trigger). */
export function nextRunAt(t: WorkflowTrigger, from: Date): Date | null {
  if (t.kind === 'interval') {
    const m = Number(t.intervalMinutes);
    return Number.isFinite(m) && m >= MIN_PERIOD_MINUTES ? new Date(from.getTime() + m * 60_000) : null;
  }
  if (t.kind === 'cron') {
    try {
      return cronIterator((t.cron ?? '').trim(), from, t.timezone || 'UTC').next().toDate();
    } catch {
      return null;
    }
  }
  return null;
}

function nameMatches(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  if (p === n) return true;
  // *.example.com covers exactly one label (as a certificate wildcard does).
  if (p.startsWith('*.') && !n.startsWith('*.')) {
    const dot = n.indexOf('.');
    return dot > 0 && n.slice(dot + 1) === p.slice(2);
  }
  return false;
}

/** cert-renewal filter: empty = any certificate (of the workflow's account); else one pattern matches one name. */
export function certificateMatches(patterns: readonly string[] | undefined, names: readonly string[]): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => names.some((n) => nameMatches(p, n)));
}
