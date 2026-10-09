import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { describeSchedule, looksLikeCron } from '@/components/cron/cronFormat';
import { inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { listTimezones } from './maintenanceFormat';

/** Presets of the window / adapter schedules (night-time, low traffic). */
const PRESETS = [
  { id: 'nightly', cron: '0 3 * * *', key: 'nightly', fallback: 'Every night at 03:00' },
  { id: 'sunday', cron: '0 3 * * 0', key: 'sunday', fallback: 'Sunday at 03:00' },
  { id: 'monday', cron: '0 4 * * 1', key: 'monday', fallback: 'Monday at 04:00' },
  { id: 'monthly', cron: '0 3 1 * *', key: 'monthly', fallback: 'The 1st of the month at 03:00' },
] as const;

/** Human text of a cron expression + zone ("At 03:00, only on Sunday (Europe/Paris)"). */
export function useCronHuman(): (cron: string, timezone: string) => string | null {
  const { i18n } = useTranslation();
  return (cron, timezone) => {
    const d = describeSchedule(cron, i18n.language);
    return d ? `${d} (${timezone || 'UTC'})` : null;
  };
}

/** Cron expression (5 fields, presets, cronstrue text) + IANA time zone. */
export function ScheduleEditor({ idPrefix, cron, timezone, onChange, disabled = false }: {
  idPrefix: string;
  cron: string;
  timezone: string;
  onChange: (next: { cron: string; timezone: string }) => void;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const zones = useMemo(() => listTimezones(timezone), [timezone]);
  const presetLabel = (key: typeof PRESETS[number]['key']) => ({
    nightly: t('maintenance.schedule.presets.nightly') || 'Every night at 03:00',
    sunday: t('maintenance.schedule.presets.sunday') || 'Sunday at 03:00',
    monday: t('maintenance.schedule.presets.monday') || 'Monday at 04:00',
    monthly: t('maintenance.schedule.presets.monthly') || 'The 1st of the month at 03:00',
  })[key];
  const description = describeSchedule(cron, i18n.language);
  const ok = looksLikeCron(cron) && !cron.trim().startsWith('@');

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
      <div className="min-w-0">
        <label className={labelCls} htmlFor={`${idPrefix}-cron`}>{t('maintenance.schedule.cron') || 'Schedule (cron)'}</label>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ cron: p.cron, timezone })}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 coarse:min-h-10 coarse:px-3',
                cron.trim() === p.cron ? 'border-accent bg-accent/10 text-accent' : 'border-transparent bg-bg-tertiary text-text-muted hover:border-accent/30',
              )}
            >
              {presetLabel(p.key)}
            </button>
          ))}
        </div>
        <input
          id={`${idPrefix}-cron`}
          value={cron}
          disabled={disabled}
          onChange={(e) => onChange({ cron: e.target.value, timezone })}
          maxLength={100}
          autoCapitalize="off" autoCorrect="off" spellCheck={false}
          placeholder="0 3 * * 0"
          className={cn(inputCls, 'font-mono', cron.trim() && !ok && 'ring-1 ring-status-down')}
        />
        <p className={cn('mt-1 text-xs', description && ok ? 'text-text-secondary' : 'text-text-muted')}>
          {description && ok ? description : (t('maintenance.schedule.cronHint') || 'minute hour day-of-month month day-of-week, in the time zone below.')}
        </p>
      </div>
      <div className="min-w-0">
        <label className={labelCls} htmlFor={`${idPrefix}-tz`}>{t('maintenance.schedule.timezone') || 'Time zone'}</label>
        <select
          id={`${idPrefix}-tz`}
          value={timezone || 'UTC'}
          disabled={disabled}
          onChange={(e) => onChange({ cron, timezone: e.target.value })}
          className={cn(selectCls, 'font-mono text-[13px]')}
        >
          {zones.map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
      </div>
    </div>
  );
}

/** Re-renders every `ms` (countdowns); returns Date.now(). */
export function useNow(ms = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms, enabled]);
  return now;
}

/** True when the cron is a 5-field expression (no @macro: the server schedules with cron-parser + tz). */
export function isWindowCron(cron: string): boolean {
  return looksLikeCron(cron) && !cron.trim().startsWith('@');
}
