import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarClock } from 'lucide-react';
import type { CronJob, CronJobInput } from '@oblimint/shared';
import { CRON_DEFAULT_TIMEOUT_SEC, CRON_MAX_TIMEOUT_SEC } from '@oblimint/shared';
import { cronApi } from '@/api/cronLogs.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { inputCls, isStepUpHandled, labelCls } from '@/components/hosting/hostingUi';
import { opsErrorMessage } from '@/components/usage/opsErrors';
import { cn } from '@/utils/cn';
import { CRON_COMMAND_MAX, CRON_PRESETS, describeSchedule, looksLikeCron } from './cronFormat';

const TIMEOUT_MIN = 10;

/** Create / edit a cron job of a site. */
export function CronJobModal({ open, siteId, job, onClose, onSaved }: {
  open: boolean;
  siteId: number;
  /** null = create. */
  job: CronJob | null;
  onClose: () => void;
  onSaved: (job: CronJob) => void;
}) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState('');
  const [schedule, setSchedule] = useState('');
  const [command, setCommand] = useState('');
  const [timeout, setTimeoutSec] = useState(String(CRON_DEFAULT_TIMEOUT_SEC));
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(job?.name ?? '');
    setSchedule(job?.schedule ?? CRON_PRESETS[3].schedule);
    setCommand(job?.command ?? '');
    setTimeoutSec(String(job?.timeoutSec ?? CRON_DEFAULT_TIMEOUT_SEC));
    setEnabled(job?.enabled ?? true);
    setError('');
  }, [open, job]);

  const description = describeSchedule(schedule, i18n.language);
  const scheduleOk = looksLikeCron(schedule);
  const timeoutNum = Number(timeout);
  const timeoutOk = Number.isInteger(timeoutNum) && timeoutNum >= TIMEOUT_MIN && timeoutNum <= CRON_MAX_TIMEOUT_SEC;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim() || !command.trim()) { setError(t('common.requiredField') || 'This field is required'); return; }
    if (!scheduleOk) { setError(t('cron.errors.cronInvalidSchedule') || 'Invalid schedule: 5 fields (minute hour day month weekday) or @hourly / @daily / @weekly / @monthly.'); return; }
    if (command.length > CRON_COMMAND_MAX) { setError(t('cron.errors.commandTooLong') || 'The command is too long (1000 characters at most).'); return; }
    if (!timeoutOk) { setError(t('cron.form.timeoutRange', { min: TIMEOUT_MIN, max: CRON_MAX_TIMEOUT_SEC, defaultValue: 'Timeout: between {{min}} and {{max}} seconds.' })); return; }
    const input: CronJobInput = { name: name.trim(), schedule: schedule.trim(), command, timeoutSec: timeoutNum, enabled };
    setSaving(true);
    setError('');
    try {
      onSaved(job ? await cronApi.update(siteId, job.id, input) : await cronApi.create(siteId, input));
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(opsErrorMessage(t, err, 'cron', t('cron.saveFailed') || 'Failed to save the cron job'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={job ? t('cron.form.editTitle', { name: job.name, defaultValue: 'Edit {{name}}' }) : (t('cron.form.createTitle') || 'New cron job')}
      icon={<CalendarClock className="h-4 w-4 text-accent" />}
      size="lg"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} onClick={() => { void submit(); }}>{job ? (t('common.save') || 'Save') : (t('common.create') || 'Create')}</Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <label className={labelCls} htmlFor="cron-name">{t('cron.form.name') || 'Name'}</label>
          <input id="cron-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus placeholder={t('cron.form.namePlaceholder') || 'WordPress cron'} className={inputCls} />
        </div>

        <div>
          <label className={labelCls} htmlFor="cron-schedule">{t('cron.form.schedule') || 'Schedule'}</label>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {CRON_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setSchedule(p.schedule)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors coarse:min-h-10 coarse:px-3',
                  schedule.trim() === p.schedule ? 'border-accent bg-accent/10 text-accent' : 'border-transparent bg-bg-tertiary text-text-muted hover:border-accent/30',
                )}
              >
                {t(`cron.presets.${p.key}`) || p.fallback}
              </button>
            ))}
          </div>
          <input
            id="cron-schedule"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            maxLength={100}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            placeholder="*/10 * * * *"
            className={cn(inputCls, 'font-mono', schedule.trim() && !scheduleOk && 'ring-1 ring-status-down')}
          />
          <p className={cn('mt-1 text-xs', description ? 'text-text-secondary' : 'text-text-muted')}>
            {description
              ? <>{description} <span className="font-mono text-text-muted">(UTC)</span></>
              : (t('cron.form.scheduleHint') || 'minute hour day-of-month month day-of-week — times are UTC.')}
          </p>
        </div>

        <div>
          <label className={labelCls} htmlFor="cron-command">{t('cron.form.command') || 'Command'}</label>
          <textarea
            id="cron-command"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            rows={4}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            placeholder="php wp-cron.php"
            className={cn(inputCls, 'resize-y font-mono text-[13px]', command.length > CRON_COMMAND_MAX && 'ring-1 ring-status-down')}
          />
          <div className="mt-1 flex flex-wrap gap-2 text-xs text-text-muted">
            <span className="min-w-0 flex-1">{t('cron.form.commandHint') || 'Run with sh -c in the site container, as the account user, from /srv/releases/current (the published release, read only: write in the data paths).'}</span>
            <span className={cn('font-mono', command.length > CRON_COMMAND_MAX && 'text-status-down')}>{command.length} / {CRON_COMMAND_MAX}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:items-end">
          <div>
            <label className={labelCls} htmlFor="cron-timeout">{t('cron.form.timeout') || 'Timeout (seconds)'}</label>
            <input id="cron-timeout" type="number" inputMode="numeric" min={TIMEOUT_MIN} max={CRON_MAX_TIMEOUT_SEC} value={timeout} onChange={(e) => setTimeoutSec(e.target.value)} className={cn(inputCls, 'font-mono', !timeoutOk && 'ring-1 ring-status-down')} />
          </div>
          <ToggleSwitch checked={enabled} onChange={setEnabled} label={t('cron.form.enabled') || 'Enabled'} />
        </div>
        <p className="text-xs text-text-muted">{t('cron.form.overlapHint') || 'A run never overlaps the previous one: while it is still running, the next occurrence is skipped. Beyond the timeout the command is killed.'}</p>

        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
