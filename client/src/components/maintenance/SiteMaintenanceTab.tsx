import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronLeft, ChevronRight, History, RefreshCw } from 'lucide-react';
import { HostingSocketEvents, type MaintenanceWindow, type Site, type SiteMaintenanceInfo, type WindowUpdatedPayload } from '@oblimint/shared';
import { maintenanceApi, windowsApi } from '@/api/maintenance.api';
import { useHostingMe } from '@/store/hostingStore';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Card, EmptyState } from '@/components/hosting/hostingUi';
import { useHostingEvent } from '@/components/sites/useHostingEvent';
import { ActiveWindowCard } from './ActiveWindowCard';
import { AdaptersPanel } from './AdaptersPanel';
import { SiteMaintenanceSettingsCard, SupervisionCard } from './SiteMaintenanceSettingsCard';
import { SiteTokensCard } from './SiteTokensCard';
import { SnapshotsCard } from './SnapshotsCard';
import { WindowsTable } from './WindowsTable';
import { isNotImplemented, maintenanceErrorMessage } from './maintenanceErrors';

const HISTORY_PAGE = 10;

/**
 * Site tab "Maintenance" (?tab=maintenance): open / extend / close a window
 * with its countdown, schedule editor, policy, supervised mode, API tokens,
 * history of the windows, adapters panel (available updates, run now,
 * schedules), database snapshots (docs/P3-PLAN.md §13).
 * OWNED BY MODULE `ui-maintenance`.
 */
export function SiteMaintenanceTab({ site }: { site: Site }) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const canManage = can('sites.manage', site.accountId);

  const [info, setInfo] = useState<SiteMaintenanceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  /** Bumped on WINDOW_UPDATED: history, snapshots, supervision refetch. */
  const [tick, setTick] = useState(0);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const id = ++seq.current;
    try {
      const next = await maintenanceApi.info(site.id);
      if (id !== seq.current) return;
      setInfo(next);
      setError(null);
      setUnavailable(false);
    } catch (err) {
      if (id !== seq.current) return;
      setUnavailable(isNotImplemented(err));
      setError(maintenanceErrorMessage(err, t, t('maintenance.loadFailed') || 'Failed to load the maintenance state'));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [site.id, t]);
  useEffect(() => { setLoading(true); void load(); }, [load]);

  useHostingEvent<WindowUpdatedPayload>(HostingSocketEvents.WINDOW_UPDATED, (p) => {
    if (p.siteId !== site.id) return;
    void load();
    setTick((n) => n + 1);
  });

  const refresh = () => { void load(); setTick((n) => n + 1); };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 basis-64 text-sm text-text-muted">
          {t('maintenance.tab.subtitle') || 'Modification windows, application updates and database snapshots of this site.'}
        </p>
        <IconButton label={t('common.refresh') || 'Refresh'} icon={<RefreshCw size={14} />} onClick={refresh} />
      </div>

      {loading && !info ? (
        <div className="flex justify-center py-8"><LoadingSpinner /></div>
      ) : !info ? (
        <EmptyState
          icon={<AlertTriangle />}
          text={unavailable ? (t('maintenance.notAvailableLong') || 'Modification windows are not available on this server yet.') : error}
        />
      ) : (
        <>
          <ActiveWindowCard site={site} info={info} onChanged={refresh} />
          {info.settings.supervised && <SupervisionCard site={site} tick={tick} />}
          <AdaptersPanel site={site} />
          <WindowHistoryCard site={site} tick={tick} />
          <SnapshotsCard site={site} tick={tick} />
          <SiteMaintenanceSettingsCard site={site} info={info} onSaved={(next) => { setInfo(next); setTick((n) => n + 1); }} />
          {canManage && <SiteTokensCard site={site} />}
        </>
      )}
    </div>
  );
}

/** Windows of the site, newest first. */
function WindowHistoryCard({ site, tick }: { site: Site; tick: number }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<MaintenanceWindow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await windowsApi.list(site.id, { limit: HISTORY_PAGE, offset });
      setItems(res.items);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setItems([]);
      setError(isNotImplemented(err) ? (t('maintenance.notAvailable') || 'Not available on this server yet.') : maintenanceErrorMessage(err, t, t('windows.loadFailed') || 'Failed to load the windows'));
    }
  }, [site.id, offset, t]);
  useEffect(() => { void load(); }, [load, tick]);

  const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE));
  const page = Math.floor(offset / HISTORY_PAGE) + 1;
  return (
    <Card title={t('windows.history') || 'Window history'} icon={<History size={14} className="text-accent" />}>
      {error ? (
        <p className="text-xs text-text-muted">{error}</p>
      ) : items === null ? null : items.length === 0 ? (
        <p className="text-sm text-text-muted">{t('windows.empty') || 'No window yet.'}</p>
      ) : (
        <>
          <WindowsTable items={items} nested />
          {pages > 1 && (
            <div className="mt-2 flex items-center justify-end gap-2 text-xs text-text-muted">
              <IconButton label={t('common.previous') || 'Previous'} icon={<ChevronLeft className="h-4 w-4" />} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - HISTORY_PAGE))} />
              <span className="font-mono">{page} / {pages}</span>
              <IconButton label={t('common.next') || 'Next'} icon={<ChevronRight className="h-4 w-4" />} disabled={page >= pages} onClick={() => setOffset(offset + HISTORY_PAGE)} />
            </div>
          )}
        </>
      )}
    </Card>
  );
}
