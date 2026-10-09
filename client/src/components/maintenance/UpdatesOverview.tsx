import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2, Package } from 'lucide-react';
import { HostingSocketEvents, type AdapterRun, type Site, type SiteAdaptersInfo } from '@oblimint/shared';
import { adaptersApi } from '@/api/maintenance.api';
import { sitesApi } from '@/api/sites.api';
import { useTenantStore } from '@/store/tenantStore';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TableScroll } from '@/components/common/TableScroll';
import { EmptyState, thCls, theadRowCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { formatDateTime } from '@/components/sites/siteForm';
import { Pill } from '@/components/sites/SiteBadges';
import { useAdapterName } from './MaintenanceBadges';
import { RunsTable } from './AdaptersPanel';
import { AdapterRunDrawer } from './AdapterRunDrawer';
import { isNotImplemented, maintenanceErrorMessage } from './maintenanceErrors';

/**
 * There is no cross-site endpoint for the adapters (docs/P3-PLAN.md §6.5 is
 * per site): the overview asks GET /sites/:id/adapters for the first
 * MAX_SITES sites the caller sees, a few at a time, and merges their recent
 * runs and available updates.
 */
const MAX_SITES = 40;
const CONCURRENCY = 4;
const MAX_RUNS = 50;

interface SiteRow { site: Site; info: SiteAdaptersInfo }

export function UpdatesOverview() {
  const { t, i18n } = useTranslation();
  const adapterName = useAdapterName();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const [rows, setRows] = useState<SiteRow[] | null>(null);
  const [siteCount, setSiteCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<AdapterRun | null>(null);
  const [runTick, setRunTick] = useState(0);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const sites = (await sitesApi.list()).filter((s) => s.currentReleaseNumber != null);
      if (n !== seq.current) return;
      setSiteCount(sites.length);
      const picked = sites.slice(0, MAX_SITES);
      const out: SiteRow[] = [];
      let unavailable = 0;
      for (let i = 0; i < picked.length; i += CONCURRENCY) {
        const batch = picked.slice(i, i + CONCURRENCY);
        const res = await Promise.allSettled(batch.map((s) => adaptersApi.info(s.id)));
        res.forEach((r, j) => {
          if (r.status === 'fulfilled') out.push({ site: batch[j], info: r.value });
          else if (isNotImplemented(r.reason)) unavailable += 1;
        });
        if (n !== seq.current) return;
      }
      if (n !== seq.current) return;
      if (picked.length > 0 && unavailable === picked.length) {
        setRows([]);
        setError(t('maintenance.notAvailable') || 'Not available on this server yet.');
        return;
      }
      setRows(out);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setRows([]);
      setError(maintenanceErrorMessage(err, t, t('adapters.loadFailed') || 'Failed to load the application updates'));
    }
  }, [t]);
  useEffect(() => { setRows(null); void load(); }, [load, currentTenantId]);
  // A run emits ~7 events (queued → … → final), possibly on many sites at once (scheduled
  // presets): only the sites named by the events are refetched and merged, never the full fan-out.
  const dirtySites = useRef<Set<number>>(new Set());
  const shownSites = useRef<Set<number>>(new Set());
  shownSites.current = new Set((rows ?? []).map((r) => r.site.id));
  const refreshDirty = useCallback(async () => {
    const ids = [...dirtySites.current];
    dirtySites.current.clear();
    const fresh = new Map<number, SiteAdaptersInfo>();
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const batch = ids.slice(i, i + CONCURRENCY);
      const res = await Promise.allSettled(batch.map((id) => adaptersApi.info(id)));
      res.forEach((r, j) => { if (r.status === 'fulfilled') fresh.set(batch[j], r.value); });
    }
    if (fresh.size === 0) return;
    setRows((cur) => cur?.map((r) => {
      const info = fresh.get(r.site.id);
      return info ? { ...r, info } : r;
    }) ?? cur);
  }, []);
  useHostingEvents(
    [HostingSocketEvents.ADAPTER_RUN_UPDATED],
    () => { void refreshDirty(); setRunTick((x) => x + 1); },
    (_ev, payload) => {
      const siteId = (payload as { siteId?: unknown } | null)?.siteId;
      if (typeof siteId === 'number' && shownSites.current.has(siteId)) dirtySites.current.add(siteId);
      return true;
    },
    1500,
  );

  if (rows === null) return <div className="flex justify-center py-10"><LoadingSpinner /></div>;
  if (error) return <EmptyState icon={<AlertTriangle />} text={error} />;

  const withApps = rows.filter((r) => r.info.detections.some((d) => d.detected));
  const runs = rows.flatMap((r) => r.info.recentRuns)
    .sort((a, b) => (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt))
    .slice(0, MAX_RUNS);
  const siteName = new Map(rows.map((r) => [r.site.id, r.site.name]));

  return (
    <div className="space-y-4">
      {withApps.length === 0 ? (
        <EmptyState icon={<Package />} text={t('adapters.overview.empty') || 'No site with a supported application (WordPress, Composer, Drupal, Nextcloud).'} />
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {withApps.map(({ site, info }) => {
              const count = info.available.reduce((n, a) => n + a.updates.length, 0);
              return (
                <li key={site.id}>
                  <Link to={`/sites/${site.id}?tab=maintenance`} className="block rounded-xl bg-bg-secondary px-3 py-2.5 hover:bg-bg-hover">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{site.name}</span>
                      {info.running && <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />}
                      {count > 0 ? <Pill tone="amber">{count}</Pill> : <Pill tone="green">{t('adapters.upToDate') || 'up to date'}</Pill>}
                    </div>
                    <div className="mt-1 text-[11px] text-text-muted">{info.detections.filter((d) => d.detected).map((d) => `${adapterName(d.adapter)}${d.version ? ` ${d.version}` : ''}`).join(' · ')}</div>
                  </Link>
                </li>
              );
            })}
          </ul>
          <TableScroll className="rounded-xl bg-bg-secondary max-md:hidden">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className={theadRowCls}>
                  <th className={thCls}>{t('windows.col.site') || 'Site'}</th>
                  <th className={thCls}>{t('adapters.col.adapter') || 'Application'}</th>
                  <th className={thCls}>{t('adapters.col.updates') || 'Updates'}</th>
                  <th className={thCls}>{t('adapters.overview.lastCheck') || 'Last check'}</th>
                  <th className={thCls}>{t('adapters.overview.schedules') || 'Schedules'}</th>
                </tr>
              </thead>
              <tbody>
                {withApps.map(({ site, info }) => {
                  const count = info.available.reduce((n, a) => n + a.updates.length, 0);
                  const lastCheck = info.available.map((a) => a.checkedAt).filter((x): x is string => !!x).sort().pop() ?? null;
                  return (
                    <tr key={site.id} className="transition-colors hover:bg-bg-hover">
                      <td className="px-4 py-2.5">
                        <Link to={`/sites/${site.id}?tab=maintenance`} className="font-medium text-text-primary hover:text-accent">{site.name}</Link>
                        <div className="font-mono text-[11px] text-text-muted">{site.accountUsername}</div>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-text-secondary">
                        {info.detections.filter((d) => d.detected).map((d) => (
                          <div key={d.adapter}>{adapterName(d.adapter)}{d.version && <span className="ml-1 font-mono text-text-muted">{d.version}</span>}</div>
                        ))}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center gap-1.5">
                          {count > 0 ? <Pill tone="amber">{t('adapters.updatesCount', { count, defaultValue: '{{count}} update(s)' })}</Pill> : <Pill tone="green">{t('adapters.upToDate') || 'up to date'}</Pill>}
                          {info.running && <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-text-muted">{formatDateTime(lastCheck, i18n.language)}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-text-secondary">{info.schedules.filter((s) => s.enabled).length}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        </>
      )}
      {siteCount > MAX_SITES && (
        <p className="text-xs text-text-muted">{t('adapters.overview.capped', { count: MAX_SITES, total: siteCount, defaultValue: 'Only the first {{count}} of {{total}} sites are shown here: open a site for its updates.' })}</p>
      )}

      {runs.length > 0 && (
        <div>
          <div className="mb-2 text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted">{t('adapters.recentRuns') || 'Recent runs'}</div>
          <div className="rounded-xl bg-bg-secondary p-2">
            <RunsTable runs={runs} onOpen={setOpenRun} siteLabel={(r) => siteName.get(r.siteId) ?? `#${r.siteId}`} />
          </div>
        </div>
      )}
      <AdapterRunDrawer siteId={openRun?.siteId ?? 0} run={openRun} tick={runTick} onClose={() => setOpenRun(null)} />
    </div>
  );
}
