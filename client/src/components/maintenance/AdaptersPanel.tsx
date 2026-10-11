import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, CalendarClock, Download, Loader2, Package, Search } from 'lucide-react';
import {
  HostingSocketEvents, type AdapterId, type AdapterRun, type AdapterRunOptions, type AdapterRunUpdatedPayload, type Site,
  type SiteAdaptersInfo,
} from '@oblimint/shared';
import { adaptersApi } from '@/api/maintenance.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { TableScroll } from '@/components/common/TableScroll';
import { SortTh, useTableSort } from '@/components/common/SortHead';
import { Card, isStepUpHandled, thCls, theadRowCls } from '@/components/hosting/hostingUi';
import { useHostingEvent } from '@/components/sites/useHostingEvent';
import { formatDateTime } from '@/components/sites/siteForm';
import { Pill } from '@/components/sites/SiteBadges';
import { RiskBadge, RunStatusBadge, UpdateLevelBadge, useAdapterName, useUpdateKindLabel } from './MaintenanceBadges';
import { groupUpdates } from './maintenanceFormat';
import { isNotImplemented, maintenanceErrorMessage, toastMaintenanceError } from './maintenanceErrors';
import { AdapterScheduleModal, AdapterUpdateModal } from './AdapterModals';
import { AdapterRunDrawer } from './AdapterRunDrawer';
import { useCronHuman } from './ScheduleEditor';

/**
 * Application adapters of the site (WP-CLI, Composer, drush, occ): detection,
 * available updates by kind and level, Check / Update with options, schedules,
 * recent runs with their drawer. Refreshed on ADAPTER_RUN_UPDATED.
 */
export function AdaptersPanel({ site }: { site: Site }) {
  const { t, i18n } = useTranslation();
  const { can } = useHostingMe();
  const canRun = can('releases.publish', site.accountId);
  const canSchedule = can('sites.manage', site.accountId);
  const adapterName = useAdapterName();
  const kindLabel = useUpdateKindLabel();
  const cronHuman = useCronHuman();

  const [info, setInfo] = useState<SiteAdaptersInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [updating, setUpdating] = useState<AdapterId | null>(null);
  const [scheduling, setScheduling] = useState<AdapterId | null>(null);
  const [openRun, setOpenRun] = useState<AdapterRun | null>(null);
  const [runTick, setRunTick] = useState(0);

  const load = useCallback(async () => {
    try {
      setInfo(await adaptersApi.info(site.id));
      setError(null);
    } catch (err) {
      setInfo(null);
      setError(isNotImplemented(err) ? (t('maintenance.notAvailable') || 'Not available on this server yet.') : maintenanceErrorMessage(err, t, t('adapters.loadFailed') || 'Failed to load the application updates'));
    }
  }, [site.id, t]);
  useEffect(() => { void load(); }, [load]);

  useHostingEvent<AdapterRunUpdatedPayload>(HostingSocketEvents.ADAPTER_RUN_UPDATED, (p) => {
    if (p.siteId !== site.id) return;
    void load();
    if (openRun && p.runId === openRun.id) setRunTick((n) => n + 1);
  });

  const run = async (adapter: AdapterId, action: 'check' | 'update', options?: AdapterRunOptions): Promise<boolean> => {
    setBusy(`${action}-${adapter}`);
    try {
      const started = await adaptersApi.run(site.id, { adapter, action, options });
      toast.success(action === 'check' ? (t('adapters.checkStarted') || 'Check started') : (t('adapters.updateStarted') || 'Update started'));
      setOpenRun(started);
      void load();
      return true;
    } catch (err) {
      toastMaintenanceError(err, t, t('adapters.runFailed') || 'Failed to start the run');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const saveSchedule = async (adapter: AdapterId, input: { cron: string; timezone: string; options: AdapterRunOptions; enabled: boolean }): Promise<string | null> => {
    try {
      await adaptersApi.putSchedule(site.id, adapter, input);
      toast.success(t('adapters.scheduleSaved') || 'Schedule saved');
      void load();
      return null;
    } catch (err) {
      if (isStepUpHandled(err)) return '';
      return maintenanceErrorMessage(err, t, t('adapters.scheduleFailed') || 'Failed to save the schedule');
    }
  };

  const deleteSchedule = async (adapter: AdapterId): Promise<boolean> => {
    try {
      await adaptersApi.deleteSchedule(site.id, adapter);
      toast.success(t('adapters.scheduleDeleted') || 'Schedule removed');
      void load();
      return true;
    } catch (err) {
      toastMaintenanceError(err, t, t('adapters.scheduleFailed') || 'Failed to save the schedule');
      return false;
    }
  };

  const detected = info?.detections.filter((d) => d.detected) ?? [];
  const availableFor = (a: AdapterId) => info?.available.find((x) => x.adapter === a) ?? null;
  const scheduleFor = (a: AdapterId) => info?.schedules.find((s) => s.adapter === a) ?? null;

  return (
    <Card title={t('adapters.title') || 'Application updates'} icon={<Package size={14} className="text-accent" />}>
      {error ? (
        <p className="text-xs text-text-muted">{error}</p>
      ) : !info ? (
        <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-text-muted">
            {t('adapters.explain') || 'When the application is recognized, its own tools (WP-CLI, Composer, drush, occ) update it on a copy of the release; the result is published like any release.'}
          </p>
          {!info.enabled && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-amber-400">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />{t('maintenance.errors.adaptersDisabled') || 'Application updates are disabled on this platform.'}
            </p>
          )}
          {info.running && (
            <p className="flex items-center gap-2 text-xs text-blue-400"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('adapters.running') || 'A run is in progress.'}</p>
          )}

          {detected.length === 0 ? (
            <p className="text-sm text-text-muted">{t('adapters.noneDetected') || 'No supported application detected in the live release (WordPress, Composer, Drupal, Nextcloud).'}</p>
          ) : detected.map((d) => {
            const avail = availableFor(d.adapter);
            const groups = groupUpdates(avail?.updates ?? []);
            const sched = scheduleFor(d.adapter);
            const disabled = !info.enabled || info.running || busy !== null;
            return (
              <div key={d.adapter} className="rounded-lg bg-bg-primary p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-text-primary">{adapterName(d.adapter)}</span>
                  {d.version && <Pill tone="muted" className="font-mono">{d.version}</Pill>}
                  {avail && avail.updates.length > 0 && <Pill tone="amber">{t('adapters.updatesCount', { count: avail.updates.length, defaultValue: '{{count}} update(s)' })}</Pill>}
                  {avail && avail.updates.length === 0 && avail.checkedAt && <Pill tone="green">{t('adapters.upToDate') || 'up to date'}</Pill>}
                  <div className="ml-auto flex flex-wrap gap-1.5">
                    {canRun && (
                      <>
                        <Button size="sm" variant="secondary" loading={busy === `check-${d.adapter}`} disabled={disabled} onClick={() => { void run(d.adapter, 'check'); }}>
                          <Search size={13} className="mr-1" />{t('adapters.check') || 'Check'}
                        </Button>
                        <Button size="sm" disabled={disabled} onClick={() => setUpdating(d.adapter)}>
                          <Download size={13} className="mr-1" />{t('adapters.update') || 'Update'}
                        </Button>
                      </>
                    )}
                    {canSchedule && (
                      <Button size="sm" variant="ghost" onClick={() => setScheduling(d.adapter)} disabled={!info.enabled}>
                        <CalendarClock size={13} className="mr-1" />{t('adapters.schedule') || 'Schedule'}
                      </Button>
                    )}
                  </div>
                </div>
                {d.detail && <p className="mt-1 text-xs text-text-muted">{d.detail}</p>}
                <div className="mt-1 text-[11px] text-text-muted">
                  {avail?.checkedAt
                    ? t('adapters.checkedAt', { date: formatDateTime(avail.checkedAt, i18n.language), defaultValue: 'Last check: {{date}}' })
                    : (t('adapters.neverChecked') || 'Never checked: click « Check ».')}
                </div>
                {avail?.error && <p className="mt-1 break-words text-xs text-red-400">{avail.error}</p>}

                {groups.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {groups.map((g) => (
                      <div key={g.kind}>
                        <div className="mb-1 text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted">{kindLabel(g.kind)} · {g.items.length}</div>
                        <ul className="divide-y divide-border/60 rounded-md bg-bg-secondary">
                          {g.items.map((u) => (
                            <li key={`${u.kind}:${u.name}`} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
                              <span className="min-w-0 flex-1 truncate text-text-primary" title={u.name}>{u.title ?? u.name}</span>
                              <span className="font-mono text-text-secondary">{u.currentVersion ?? '?'} → {u.newVersion ?? '?'}</span>
                              <UpdateLevelBadge level={u.level} />
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}

                {sched && (
                  <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                    <CalendarClock size={13} className="text-text-muted" />
                    {sched.enabled ? (cronHuman(sched.cron, sched.timezone) ?? sched.cron) : (t('adapters.scheduleDisabled') || 'Schedule disabled')}
                    {sched.enabled && sched.nextRunAt && <span className="text-text-muted">· {t('adapters.nextRun', { date: formatDateTime(sched.nextRunAt, i18n.language), defaultValue: 'next: {{date}}' })}</span>}
                    {sched.lastRunStatus && <RunStatusBadge status={sched.lastRunStatus} />}
                  </p>
                )}
              </div>
            );
          })}

          {/* Recent runs */}
          {info.recentRuns.length > 0 && (
            <div>
              <div className="mb-2 text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted">{t('adapters.recentRuns') || 'Recent runs'}</div>
              <RunsTable runs={info.recentRuns} onOpen={setOpenRun} />
            </div>
          )}
        </div>
      )}

      <AdapterUpdateModal adapter={updating} available={updating ? (availableFor(updating)?.updates ?? []) : []} onClose={() => setUpdating(null)} onRun={(a, o) => run(a, 'update', o)} />
      <AdapterScheduleModal
        adapter={scheduling}
        schedule={scheduling ? scheduleFor(scheduling) : null}
        available={scheduling ? (availableFor(scheduling)?.updates ?? []) : []}
        onClose={() => setScheduling(null)}
        onSave={saveSchedule}
        onDelete={deleteSchedule}
      />
      <AdapterRunDrawer siteId={site.id} run={openRun} tick={runTick} onClose={() => setOpenRun(null)} />
    </Card>
  );
}

/** Adapter runs (site panel, /maintenance updates tab). */
export function RunsTable({ runs, onOpen, siteLabel }: { runs: AdapterRun[]; onOpen: (r: AdapterRun) => void; siteLabel?: (r: AdapterRun) => string }) {
  const { t, i18n } = useTranslation();
  const adapterName = useAdapterName();
  const actionLabel = (r: AdapterRun) => (r.action === 'check' ? (t('adapters.check') || 'Check') : (t('adapters.update') || 'Update'));
  const { sorted, sort } = useTableSort(runs, {
    id: (r) => r.id, site: (r) => (siteLabel ? siteLabel(r) : ''), adapter: (r) => adapterName(r.adapter), action: (r) => r.action,
    status: (r) => r.status, updates: (r) => r.updates.length, risk: (r) => r.risk?.score ?? null, date: (r) => r.startedAt ?? r.createdAt,
  });
  return (
    <>
      <ul className="space-y-2 md:hidden">
        {sorted.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => onOpen(r)} className="w-full rounded-lg bg-bg-primary px-3 py-2 text-left hover:bg-bg-hover">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{siteLabel ? `${siteLabel(r)} · ` : ''}{adapterName(r.adapter)}</span>
                <RunStatusBadge status={r.status} />
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-text-muted">
                <span>{actionLabel(r)}</span>
                <span>{t('adapters.updatesCount', { count: r.updates.length, defaultValue: '{{count}} update(s)' })}</span>
                <span className="font-mono">{formatDateTime(r.startedAt ?? r.createdAt, i18n.language)}</span>
              </div>
            </button>
          </li>
        ))}
      </ul>
      <TableScroll className="max-md:hidden">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className={theadRowCls}>
              <SortTh k="id" sort={sort} className={thCls}>#</SortTh>
              {siteLabel && <SortTh k="site" sort={sort} className={thCls}>{t('windows.col.site') || 'Site'}</SortTh>}
              <SortTh k="adapter" sort={sort} className={thCls}>{t('adapters.col.adapter') || 'Application'}</SortTh>
              <SortTh k="action" sort={sort} className={thCls}>{t('adapters.col.action') || 'Action'}</SortTh>
              <SortTh k="status" sort={sort} className={thCls}>{t('adapters.col.status') || 'Status'}</SortTh>
              <SortTh k="updates" sort={sort} className={thCls}>{t('adapters.col.updates') || 'Updates'}</SortTh>
              <SortTh k="risk" sort={sort} className={thCls}>{t('adapters.col.risk') || 'Risk'}</SortTh>
              <SortTh k="date" sort={sort} className={thCls}>{t('adapters.col.date') || 'Date'}</SortTh>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id} onClick={() => onOpen(r)} className="cursor-pointer transition-colors hover:bg-bg-hover">
                <td className="px-4 py-2 font-mono text-xs text-text-muted">{r.id}</td>
                {siteLabel && <td className="max-w-[12rem] truncate px-4 py-2 text-text-primary">{siteLabel(r)}</td>}
                <td className="px-4 py-2 text-text-primary">{adapterName(r.adapter)}</td>
                <td className="px-4 py-2 text-xs text-text-secondary">
                  {actionLabel(r)}
                  {r.trigger === 'scheduled' && <span className="text-text-muted"> · {t('windows.trigger.scheduled') || 'Scheduled'}</span>}
                </td>
                <td className="px-4 py-2"><RunStatusBadge status={r.status} /></td>
                <td className="px-4 py-2 font-mono text-xs text-text-secondary">
                  {r.updates.length}
                  {r.resultReleaseNumber != null && <span className="ml-2 text-text-muted">→ #{r.resultReleaseNumber}</span>}
                </td>
                <td className="px-4 py-2"><RiskBadge risk={r.risk} compact /></td>
                <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-text-muted">{formatDateTime(r.startedAt ?? r.createdAt, i18n.language)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </>
  );
}
