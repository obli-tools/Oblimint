import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, CalendarClock, History, Pencil, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { CronJob, Site } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { cronApi } from '@/api/cronLogs.api';
import { useHostingMe } from '@/store/hostingStore';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TableScroll } from '@/components/common/TableScroll';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EmptyState, Pill, payloadNumber, thCls, theadRowCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { opsErrorMessage, toastOpsError } from '@/components/usage/opsErrors';
import { describeSchedule, runStatusTone } from './cronFormat';
import { CronJobModal } from './CronJobModal';
import { CronRunsDrawer } from './CronRunsDrawer';
import { useRunStatusLabel } from './cronUi';

/**
 * Cron tab of the site detail page (?tab=cron): scheduled commands run in the
 * site's container (account uid, timeout, no overlap). Editing needs
 * `sites.manage`; reading is open to whoever sees the site.
 */
export function SiteCronTab({ site }: { site: Site }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const { can } = useHostingMe();
  const canEdit = can('sites.manage', site.accountId);
  const statusLabel = useRunStatusLabel();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CronJob | 'new' | null>(null);
  const [history, setHistory] = useState<CronJob | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const id = ++seq.current;
    try {
      const list = await cronApi.list(site.id);
      if (id !== seq.current) return;
      setJobs(list);
      setError(null);
    } catch (err) {
      if (id !== seq.current) return;
      setJobs([]);
      setError(opsErrorMessage(t, err, 'cron', t('cron.loadFailed') || 'Failed to load the cron jobs'));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [site.id, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.CRON_RUN_UPDATED, HostingSocketEvents.HOSTING_CHANGED], () => { void load(); }, (e, p) => {
    if (e === HostingSocketEvents.CRON_RUN_UPDATED) return payloadNumber(p, 'siteId') === site.id;
    const entity = (p as { entity?: string } | null)?.entity;
    return entity === 'cronJob' && payloadNumber(p, 'accountId') === site.accountId;
  }, 600);

  const replace = (job: CronJob) => setJobs((cur) => (cur.some((j) => j.id === job.id) ? cur.map((j) => (j.id === job.id ? job : j)) : [...cur, job]));

  const toggle = async (job: CronJob, enabled: boolean) => {
    setBusy(job.id);
    try {
      replace(await cronApi.update(site.id, job.id, { enabled }));
    } catch (err) {
      toastOpsError(t, err, 'cron', t('cron.saveFailed') || 'Failed to save the cron job');
    } finally {
      setBusy(null);
    }
  };

  const runNow = async (job: CronJob) => {
    setBusy(job.id);
    try {
      await cronApi.runNow(site.id, job.id);
      toast.success(t('cron.started', { name: job.name, defaultValue: '{{name}} started' }));
      setHistory(job);
      void load();
    } catch (err) {
      toastOpsError(t, err, 'cron', t('cron.runFailed') || 'Failed to start the job');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (job: CronJob) => {
    if (!(await confirm({
      title: t('cron.deleteTitle') || 'Delete the cron job',
      message: t('cron.deleteConfirm', { name: job.name, defaultValue: 'Delete « {{name}} » and its history?' }),
      confirmLabel: t('common.delete') || 'Delete',
      danger: true,
    }))) return;
    setBusy(job.id);
    try {
      await cronApi.delete(site.id, job.id);
      setJobs((cur) => cur.filter((j) => j.id !== job.id));
      toast.success(t('cron.deleted') || 'Cron job deleted');
    } catch (err) {
      toastOpsError(t, err, 'cron', t('cron.deleteFailed') || 'Failed to delete the cron job');
    } finally {
      setBusy(null);
    }
  };

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language) : '—');
  const human = (job: CronJob) => describeSchedule(job.schedule, i18n.language);

  const actions = (job: CronJob) => [
    { key: 'history', icon: <History size={16} />, label: t('cron.history') || 'History', onClick: () => setHistory(job) },
    { key: 'run', icon: <Play size={16} />, label: t('cron.runNow') || 'Run now', onClick: () => { void runNow(job); }, hidden: !canEdit, disabled: busy === job.id },
    { key: 'edit', icon: <Pencil size={16} />, label: t('common.edit') || 'Edit', onClick: () => setEditing(job), hidden: !canEdit },
    { key: 'delete', icon: <Trash2 size={16} />, label: t('common.delete') || 'Delete', onClick: () => { void remove(job); }, hidden: !canEdit, danger: true, separator: true },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 basis-64 text-sm text-text-muted">{t('cron.tab.subtitle') || 'Scheduled commands of this site.'}</p>
        <IconButton label={t('common.refresh') || 'Refresh'} icon={<RefreshCw size={14} />} onClick={() => { void load(); }} />
        {canEdit && <Button size="sm" onClick={() => setEditing('new')}><Plus size={13} className="mr-1.5" />{t('cron.create') || 'New cron job'}</Button>}
      </div>
      {site.status === 'stopped' && jobs.length > 0 && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-amber-400">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {t('cron.siteStopped') || 'The site is stopped: its jobs are skipped until it is started again.'}
        </p>
      )}

      {loading ? (
        <div className="flex justify-center py-8"><LoadingSpinner /></div>
      ) : error ? (
        <EmptyState icon={<AlertTriangle />} text={error} />
      ) : jobs.length === 0 ? (
        <EmptyState
          icon={<CalendarClock />}
          text={t('cron.empty') || 'No cron job yet.'}
          action={canEdit ? <Button size="sm" variant="secondary" onClick={() => setEditing('new')}><Plus size={13} className="mr-1.5" />{t('cron.create') || 'New cron job'}</Button> : undefined}
        />
      ) : (
        <>
          {/* Phone: cards */}
          <ul className="space-y-2 md:hidden">
            {jobs.map((job) => (
              <li key={job.id} className="rounded-xl bg-bg-secondary px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{job.name}</span>
                  {canEdit && <ToggleSwitch size="sm" checked={job.enabled} disabled={busy === job.id} onChange={(v) => { void toggle(job, v); }} ariaLabel={t('cron.form.enabled') || 'Enabled'} />}
                  <ActionMenu items={actions(job)} sheetTitle={job.name} />
                </div>
                <div className="mt-1 font-mono text-[11px] text-text-secondary">{job.schedule}</div>
                {human(job) && <div className="text-xs text-text-muted">{human(job)} (UTC)</div>}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
                  <Pill tone={runStatusTone(job.lastStatus)}>{statusLabel(job.lastStatus)}</Pill>
                  <span className="font-mono">{t('cron.col.next') || 'Next'}: {job.enabled ? fmt(job.nextRunAt) : (t('cron.disabled') || 'disabled')}</span>
                </div>
              </li>
            ))}
          </ul>
          {/* Desktop: table */}
          <TableScroll className="rounded-xl bg-bg-secondary max-md:hidden">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className={theadRowCls}>
                  <th className={thCls}>{t('cron.col.name') || 'Name'}</th>
                  <th className={thCls}>{t('cron.col.schedule') || 'Schedule'}</th>
                  <th className={thCls}>{t('cron.col.next') || 'Next'}</th>
                  <th className={thCls}>{t('cron.col.last') || 'Last run'}</th>
                  <th className={thCls}>{t('cron.col.enabled') || 'Enabled'}</th>
                  <th className={thCls} />
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} className="transition-colors hover:bg-bg-hover">
                    <td className="max-w-[16rem] px-4 py-3">
                      <div className="truncate font-medium text-text-primary">{job.name}</div>
                      <div className="truncate font-mono text-[11px] text-text-muted" title={job.command}>{job.command}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-mono text-xs text-text-secondary">{job.schedule}</div>
                      {human(job) && <div className="text-[11px] text-text-muted">{human(job)} (UTC)</div>}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">{job.enabled ? fmt(job.nextRunAt) : '—'}</td>
                    <td className="px-4 py-3">
                      <button type="button" onClick={() => setHistory(job)} className="flex flex-col items-start gap-0.5 text-left">
                        <Pill tone={runStatusTone(job.lastStatus)}>{statusLabel(job.lastStatus)}</Pill>
                        {job.lastRunAt && <span className="font-mono text-[11px] text-text-muted">{fmt(job.lastRunAt)}</span>}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <ToggleSwitch size="sm" checked={job.enabled} disabled={!canEdit || busy === job.id} onChange={(v) => { void toggle(job, v); }} ariaLabel={t('cron.form.enabled') || 'Enabled'} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {canEdit && <IconButton label={t('cron.runNow') || 'Run now'} icon={<Play size={14} />} disabled={busy === job.id} onClick={() => { void runNow(job); }} />}
                        <IconButton label={t('cron.history') || 'History'} icon={<History size={14} />} onClick={() => setHistory(job)} />
                        {canEdit && <IconButton label={t('common.edit') || 'Edit'} icon={<Pencil size={14} />} onClick={() => setEditing(job)} />}
                        {canEdit && <IconButton variant="danger" label={t('common.delete') || 'Delete'} icon={<Trash2 size={14} />} disabled={busy === job.id} onClick={() => { void remove(job); }} />}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </>
      )}
      <p className="text-xs text-text-muted">{t('cron.utcHint') || 'Schedules are evaluated in UTC. The plan sets the number of jobs and the minimum interval between two runs.'}</p>

      <CronJobModal
        open={editing !== null}
        siteId={site.id}
        job={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={(job) => {
          const created = editing === 'new';
          setEditing(null);
          replace(job);
          toast.success(created ? (t('cron.created') || 'Cron job created') : (t('cron.saved') || 'Cron job saved'));
        }}
      />
      <CronRunsDrawer siteId={site.id} job={history} onClose={() => setHistory(null)} />
    </div>
  );
}
