import cronstrue from 'cronstrue';
// Registers the French locale on the cronstrue instance (side-effect module).
import 'cronstrue/locales/fr';
import type { CronRunStatus } from '@oblimint/shared';

// Pure helpers of the cron tab: schedule presets, human description
// (cronstrue, English or French), light shape check. The server validates for
// real (cron-parser, plan minimum interval → cronInvalidSchedule / cronTooFrequent).

export interface CronPreset {
  id: string;
  schedule: string;
  /** i18n key under cron.presets + English fallback. */
  key: string;
  fallback: string;
}

export const CRON_PRESETS: readonly CronPreset[] = [
  { id: 'every5', schedule: '*/5 * * * *', key: 'every5', fallback: 'Every 5 minutes' },
  { id: 'every15', schedule: '*/15 * * * *', key: 'every15', fallback: 'Every 15 minutes' },
  { id: 'hourly', schedule: '0 * * * *', key: 'hourly', fallback: 'Every hour' },
  { id: 'daily', schedule: '0 3 * * *', key: 'daily', fallback: 'Every day at 03:00' },
  { id: 'weekly', schedule: '0 4 * * 1', key: 'weekly', fallback: 'Every Monday at 04:00' },
  { id: 'monthly', schedule: '0 5 1 * *', key: 'monthly', fallback: 'The 1st of each month at 05:00' },
];

const MACROS = new Set(['@hourly', '@daily', '@midnight', '@weekly', '@monthly', '@yearly', '@annually']);
const FIELD_RE = /^[0-9*,/\-A-Za-z?LW#]+$/;

/** Shape check: a 5-field expression or an @ macro (no seconds field). */
export function looksLikeCron(expr: string): boolean {
  const s = expr.trim();
  if (!s) return false;
  if (s.startsWith('@')) return MACROS.has(s.toLowerCase());
  const fields = s.split(/\s+/);
  return fields.length === 5 && fields.every((f) => FIELD_RE.test(f));
}

/**
 * Human description of a schedule ("At 03:00" / « À 03:00 »), null when it
 * cannot be described. `lang` picks the cronstrue locale (fr or en).
 */
export function describeSchedule(expr: string, lang: string): string | null {
  const s = expr.trim();
  if (!looksLikeCron(s)) return null;
  const locale = lang.toLowerCase().startsWith('fr') ? 'fr' : 'en';
  try {
    return cronstrue.toString(s, { locale, use24HourTimeFormat: true, throwExceptionOnParseError: true, verbose: false });
  } catch {
    return null;
  }
}

/** Pill tone of a run status. */
export function runStatusTone(s: CronRunStatus | null): 'green' | 'red' | 'amber' | 'blue' | 'muted' {
  switch (s) {
    case 'success': return 'green';
    case 'failed': return 'red';
    case 'timeout': return 'amber';
    case 'running': return 'blue';
    default: return 'muted';
  }
}

/** "850 ms" / "12.4 s" / "3 min 05 s". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} min ${String(s).padStart(2, '0')} s`;
}

/** Server limit of a command (commandTooLong beyond). */
export const CRON_COMMAND_MAX = 1000;
