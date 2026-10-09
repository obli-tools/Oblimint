import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronLeft, ChevronRight, DoorOpen, Eye, FileLock2, Package, RefreshCw } from 'lucide-react';
import { HostingSocketEvents, type MaintenanceWindowListItem } from '@oblimint/shared';
import { maintenanceApi, quarantineApi } from '@/api/maintenance.api';
import { useTenantStore } from '@/store/tenantStore';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { EmptyState, headerBtnCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { WindowsTable } from '@/components/maintenance/WindowsTable';
import { QuarantineViewer } from '@/components/maintenance/QuarantineViewer';
import { UpdatesOverview } from '@/components/maintenance/UpdatesOverview';
import { isNotImplemented, maintenanceErrorMessage } from '@/components/maintenance/maintenanceErrors';

type Tab = 'reviews' | 'windows' | 'updates' | 'quarantine';
const TABS: readonly Tab[] = ['reviews', 'windows', 'updates', 'quarantine'];

function isTab(v: string | null): v is Tab {
  return v !== null && (TABS as readonly string[]).includes(v);
}

/**
 * /maintenance — overview of the modification windows (pending reviews, open
 * windows), application updates and quarantine across the sites the caller
 * sees (docs/P3-PLAN.md §13). OWNED BY MODULE `ui-maintenance`.
 */
export function MaintenancePage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: Tab = isTab(tabParam) ? tabParam : 'reviews';
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [quarantined, setQuarantined] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  const loadCounts = useCallback(async () => {
    const [p, q] = await Promise.allSettled([
      maintenanceApi.listAll({ status: 'pending_review', limit: 1 }),
      quarantineApi.summary(),
    ]);
    setPendingCount(p.status === 'fulfilled' ? p.value.total : null);
    setQuarantined(q.status === 'fulfilled' ? q.value.quarantined : null);
  }, []);
  useEffect(() => { void loadCounts(); }, [loadCounts, currentTenantId]);
  useHostingEvents([HostingSocketEvents.WINDOW_UPDATED, HostingSocketEvents.QUARANTINE_UPDATED], () => { void loadCounts(); }, undefined, 1000);

  const setTab = (next: Tab) => {
    const p = new URLSearchParams();
    if (next !== 'reviews') p.set('tab', next);
    setParams(p, { replace: true });
  };

  const badge = (n: number | null) => (n ? <span className="ml-1 rounded-full bg-accent/15 px-1.5 font-mono text-[10px] text-accent">{n}</span> : null);
  const tabs: SegmentedTab<Tab>[] = [
    { id: 'reviews', label: t('maintenance.page.tabs.reviews') || 'Reviews', icon: <Eye size={16} />, badge: badge(pendingCount) },
    { id: 'windows', label: t('maintenance.page.tabs.windows') || 'Windows in progress', icon: <DoorOpen size={16} /> },
    { id: 'updates', label: t('maintenance.page.tabs.updates') || 'Updates', icon: <Package size={16} /> },
    { id: 'quarantine', label: t('maintenance.page.tabs.quarantine') || 'Quarantine', icon: <FileLock2 size={16} />, badge: badge(quarantined) },
  ];

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('nav.maintenance') || 'Maintenance'}</h1>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => { void loadCounts(); setTick((n) => n + 1); }} className={headerBtnCls}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
        </div>
      </div>
      <p className="-mt-3 text-sm text-text-muted">
        {t('maintenance.page.description') || 'Modification windows waiting for a review, application updates and quarantined files.'}
      </p>

      <SegmentedTabs<Tab> tabs={tabs} value={tab} onChange={setTab} ariaLabel={t('nav.maintenance') || 'Maintenance'} fill={false} />

      {tab === 'reviews' && <WindowsOverview key={`reviews-${tick}`} status="pending_review" />}
      {tab === 'windows' && <WindowsOverview key={`windows-${tick}`} status="active" />}
      {tab === 'updates' && <UpdatesOverview key={`updates-${tick}`} />}
      {tab === 'quarantine' && <QuarantineViewer key={`quarantine-${tick}`} />}
    </PageContainer>
  );
}

const PAGE = 25;

/** Windows of every visible site with a status filter ('active' = every non-final window). */
function WindowsOverview({ status }: { status: 'pending_review' | 'active' }) {
  const { t } = useTranslation();
  const isMaster = useIsMasterTenant();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const [items, setItems] = useState<MaintenanceWindowListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const res = await maintenanceApi.listAll({ status, limit: PAGE, offset });
      if (n !== seq.current) return;
      setItems(res.items);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setItems([]);
      setError(isNotImplemented(err) ? (t('maintenance.notAvailableLong') || 'Modification windows are not available on this server yet.') : maintenanceErrorMessage(err, t, t('windows.loadFailed') || 'Failed to load the windows'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [status, offset, t]);
  useEffect(() => { setLoading(true); void load(); }, [load, currentTenantId]);
  useHostingEvents([HostingSocketEvents.WINDOW_UPDATED], () => { void load(); }, undefined, 800);

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.floor(offset / PAGE) + 1;

  if (loading) return <div className="flex justify-center py-10"><LoadingSpinner /></div>;
  if (error) return <EmptyState icon={<AlertTriangle />} text={error} />;
  if (items.length === 0) {
    return (
      <EmptyState
        icon={status === 'pending_review' ? <Eye /> : <DoorOpen />}
        text={status === 'pending_review'
          ? (t('maintenance.page.noReview') || 'No window waits for a review.')
          : (t('maintenance.page.noWindow') || 'No window in progress.')}
      />
    );
  }
  return (
    <div className="space-y-2">
      <WindowsTable items={items} showSite showTenant={isMaster} />
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-xs text-text-muted">
          <IconButton label={t('common.previous') || 'Previous'} icon={<ChevronLeft className="h-4 w-4" />} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} />
          <span className="font-mono">{page} / {pages}</span>
          <IconButton label={t('common.next') || 'Next'} icon={<ChevronRight className="h-4 w-4" />} disabled={page >= pages} onClick={() => setOffset(offset + PAGE)} />
        </div>
      )}
    </div>
  );
}
