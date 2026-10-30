import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  CalendarClock, Cpu, DoorOpen, Eye, FolderOpen, Globe, History, LayoutDashboard, Play, Rocket, ScrollText, Settings2,
  Square, Trash2, ExternalLink, Wrench,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { HostingSocketEvents, type HostingChangedPayload, type MaintenanceWindow, type Site, type WindowUpdatedPayload } from '@oblimint/shared';
import { sitesApi } from '@/api/sites.api';
import { maintenanceApi } from '@/api/maintenance.api';
import { useHostingMe } from '@/store/hostingStore';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { DetailHeader, AccountLink } from '@/components/common/DetailHeader';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { TenantBadge } from '@/components/common/TenantBadge';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { BaseBadge, Pill, SiteStatusBadge } from '@/components/sites/SiteBadges';
import { PublishModal } from '@/components/sites/PublishModal';
import { useHostingEvent } from '@/components/sites/useHostingEvent';
import { apiErrorStatus, siteErrorMessage, toastSiteError } from '@/components/sites/siteErrors';
import { SiteOverviewTab } from '@/components/sites/tabs/SiteOverviewTab';
import { SiteReleasesTab } from '@/components/sites/tabs/SiteReleasesTab';
import { SiteRuntimeTab } from '@/components/sites/tabs/SiteRuntimeTab';
import { SiteRoutesTab } from '@/components/sites/tabs/SiteRoutesTab';
import { SiteConfigTab } from '@/components/sites/tabs/SiteConfigTab';
import { SiteFilesTab } from '@/components/sites/tabs/SiteFilesTab';
import { SiteMonitorsCard } from '@/components/sites/tabs/SiteMonitorsCard';
import { SiteSettingsCard, siteHasPhp } from '@/components/sites/SiteSettingsCard';
import { SiteCronTab } from '@/components/cron/SiteCronTab';
import { SiteLogsTab } from '@/components/logs/SiteLogsTab';
import { SiteErrorGroupsCard } from '@/components/logs/SiteErrorGroupsCard';
import { SiteMaintenanceTab } from '@/components/maintenance/SiteMaintenanceTab';
import { SnapshotsCard } from '@/components/maintenance/SnapshotsCard';
import { AccountBackupsTab } from '@/components/hosting/AccountBackupsTab';
import { accountHref, resolveSiteTab, type SiteTab } from '@/utils/links';

// The tab ids are the deep-link contract of siteHref() (utils/links.ts);
// the old ids (routes, data, env) are aliases rewritten on arrival.
type Tab = SiteTab;

export function SiteDetailPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { id } = useParams<{ id: string }>();
  const siteId = Number(id);
  const [searchParams, setSearchParams] = useSearchParams();
  const resolvedTab = resolveSiteTab(searchParams.get('tab'));
  const tab: Tab = resolvedTab.tab;
  // An old tab id (?tab=routes|data|env) becomes the new one, with its section.
  useEffect(() => {
    if (!resolvedTab.alias) return;
    const next = new URLSearchParams(searchParams);
    if (tab === 'overview') next.delete('tab'); else next.set('tab', tab);
    for (const [k, v] of Object.entries(resolvedTab.alias.extra)) next.set(k, v);
    setSearchParams(next, { replace: true });
  }, [resolvedTab.alias, tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const { can } = useHostingMe();

  const [site, setSite] = useState<Site | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [publishOpen, setPublishOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Bumped after a publication / rollback so the releases tab refetches. */
  const [releasesTick, setReleasesTick] = useState(0);

  // The instance is reused from /sites/1 to /sites/2: a late answer for the
  // previous site must never land under the new URL.
  const reqSeq = useRef(0);
  const currentSiteId = useRef(siteId);
  currentSiteId.current = siteId;
  const loadSite = useCallback(async (quiet = false) => {
    const seq = ++reqSeq.current;
    if (!Number.isInteger(siteId) || siteId <= 0) { setNotFound(true); setLoading(false); return; }
    if (!quiet) setLoading(true);
    try {
      const loaded = await sitesApi.get(siteId);
      if (seq !== reqSeq.current) return;
      setSite(loaded);
      setNotFound(false);
      setLoadError('');
    } catch (err) {
      if (seq !== reqSeq.current) return;
      if (apiErrorStatus(err) === 404) setNotFound(true);
      else if (!quiet) setLoadError(siteErrorMessage(err, t, t('sites.loadSiteFailed') || 'Failed to load the site'));
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [siteId, t]);
  /** setSite for answers of actions started on a (possibly) previous site. */
  const setSiteIfCurrent = useCallback((next: Site) => {
    if (next.id === currentSiteId.current) setSite(next);
  }, []);

  useEffect(() => { setSite(null); void loadSite(); }, [loadSite]);

  // P3: header badge « window open » / « review pending » (silent when the endpoint is not there).
  const [activeWindow, setActiveWindow] = useState<MaintenanceWindow | null>(null);
  const windowSeq = useRef(0);
  const loadWindow = useCallback(async () => {
    const seq = ++windowSeq.current;
    if (!Number.isInteger(siteId) || siteId <= 0) return;
    try {
      const info = await maintenanceApi.info(siteId);
      if (seq === windowSeq.current) setActiveWindow(info.activeWindow);
    } catch {
      if (seq === windowSeq.current) setActiveWindow(null);
    }
  }, [siteId]);
  useEffect(() => { setActiveWindow(null); void loadWindow(); }, [loadWindow]);
  // Database snapshots are taken when a window opens / an update runs: the card follows the windows.
  const [snapshotsTick, setSnapshotsTick] = useState(0);
  useHostingEvent<WindowUpdatedPayload>(HostingSocketEvents.WINDOW_UPDATED, (p) => {
    if (p.siteId !== siteId) return;
    void loadWindow();
    setSnapshotsTick((n) => n + 1);
  });

  useHostingEvent<HostingChangedPayload>(HostingSocketEvents.HOSTING_CHANGED, (p) => {
    if (p.entity !== 'site' || p.id !== siteId) return;
    if (p.action === 'deleted') { navigate('/sites', { replace: true }); return; }
    void loadSite(true);
  });
  useHostingEvent<{ siteId: number }>(HostingSocketEvents.RUNTIME_UPDATED, (p) => {
    if (p.siteId === siteId) void loadSite(true);
  });
  useHostingEvent<{ siteId: number; status: string }>(HostingSocketEvents.RELEASE_UPDATED, (p) => {
    // The current release number / status may have changed.
    if (p.siteId === siteId && (p.status === 'ready' || p.status === 'failed')) void loadSite(true);
  });

  const setTab = (next: Tab, extra: Record<string, string> = {}) => {
    // The domain drawer (?domain=) stays open across tabs; the rest is per tab.
    const params = new URLSearchParams();
    const domain = searchParams.get('domain');
    if (domain) params.set('domain', domain);
    if (next !== 'overview') params.set('tab', next);
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    setSearchParams(params, { replace: true });
  };

  if (loading && !site) {
    return (
      <PageContainer className="flex justify-center py-16">
        <LoadingSpinner />
      </PageContainer>
    );
  }

  if (notFound || !site) {
    return (
      <PageContainer className="flex flex-col items-center gap-3 py-16 text-center">
        <Globe className="h-8 w-8 text-text-muted" />
        <p className="text-sm text-text-secondary">
          {notFound ? (t('sites.notFound') || 'This site does not exist or is not visible to you.') : loadError}
        </p>
        <Link to="/sites" className="text-sm text-accent hover:underline">{t('sites.backToList') || 'Back to sites'}</Link>
      </PageContainer>
    );
  }

  const canManage = can('sites.manage', site.accountId);
  const canPublish = can('releases.publish', site.accountId);

  const toggleRunning = async () => {
    const stopping = site.status !== 'stopped';
    if (stopping && !(await confirm({
      title: t('sites.actions.stop') || 'Stop the site',
      message: t('sites.actions.stopConfirm', { name: site.name, defaultValue: 'Stop "{{name}}"? Its containers are stopped and visitors get an error page until it is started again.' }),
      confirmLabel: t('sites.actions.stop') || 'Stop the site',
    }))) return;
    setBusy(true);
    try {
      setSiteIfCurrent(stopping ? await sitesApi.stop(site.id) : await sitesApi.start(site.id));
      toast.success(stopping ? (t('sites.actions.stopped') || 'Site stopped') : (t('sites.actions.started') || 'Site started'));
    } catch (err) {
      toastSiteError(err, t);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!(await confirm({
      title: t('sites.actions.delete') || 'Delete the site',
      message: t('sites.actions.deleteConfirm', {
        name: site.name, slug: site.slug,
        defaultValue: 'Delete "{{name}}"? Its containers, releases and routes are removed, as well as /staging/{{slug}}/ and /data/{{slug}}/. This cannot be undone.',
      }),
      danger: true,
      requireText: site.slug,
    }))) return;
    setBusy(true);
    try {
      await sitesApi.delete(site.id, site.slug);
      toast.success(t('sites.actions.deleted') || 'Site deleted');
      navigate('/sites', { replace: true });
    } catch (err) {
      toastSiteError(err, t);
      setBusy(false);
    }
  };

  // Coherence plan 1.3: the site page is self-sufficient, in 9 tabs.
  const tabs: SegmentedTab<Tab>[] = [
    { id: 'overview', label: t('sites.tabs.overview') || 'Overview', icon: <LayoutDashboard size={16} /> },
    { id: 'releases', label: t('sites.tabs.releasesRestore') || 'Releases & restore', icon: <History size={16} /> },
    { id: 'domains', label: t('sites.tabs.domains') || 'Domains', icon: <Globe size={16} /> },
    { id: 'runtime', label: t('sites.tabs.runtimePhp') || 'Runtime & PHP', icon: <Cpu size={16} /> },
    { id: 'config', label: t('sites.tabs.config') || 'Configuration', icon: <Settings2 size={16} /> },
    { id: 'files', label: t('sites.tabs.files') || 'Files', icon: <FolderOpen size={16} /> },
    { id: 'cron', label: t('sites.tabs.cron') || 'Cron', icon: <CalendarClock size={16} /> },
    { id: 'logs', label: t('sites.tabs.logs') || 'Logs & observation', icon: <ScrollText size={16} /> },
    { id: 'maintenance', label: t('sites.tabs.maintenance') || 'Maintenance & access', icon: <Wrench size={16} /> },
  ];

  const tabProps = {
    site,
    onSiteChange: setSiteIfCurrent,
    reloadSite: () => loadSite(true),
    onPublish: () => setPublishOpen(true),
  };

  return (
    <PageContainer className="flex flex-col gap-5">
      <DetailHeader
        backTo={accountHref(site.accountId, 'sites')}
        title={site.name}
        badges={(
          <>
            <SiteStatusBadge status={site.status} message={site.statusMessage} />
            <BaseBadge base={site.base} />
            {site.previewBase && (
              <Pill tone="blue"><Eye className="h-3 w-3" />{t('runtime.preview.badge') || 'Preview running'}</Pill>
            )}
            {activeWindow && activeWindow.status === 'pending_review' ? (
              <Link to={`/sites/${site.id}/windows/${activeWindow.id}`} className="inline-flex">
                <Pill tone="amber"><Eye className="h-3 w-3" />{t('maintenance.badge.review') || 'Review pending'}</Pill>
              </Link>
            ) : activeWindow && activeWindow.status === 'open' ? (
              <button type="button" onClick={() => setTab('maintenance')} className="inline-flex">
                <Pill tone="accent"><DoorOpen className="h-3 w-3" />{t('maintenance.badge.open') || 'Window open'}</Pill>
              </button>
            ) : activeWindow ? (
              <button type="button" onClick={() => setTab('maintenance')} className="inline-flex">
                <Pill tone="blue"><DoorOpen className="h-3 w-3" />{t('maintenance.badge.busy') || 'Window in progress'}</Pill>
              </button>
            ) : null}
            <TenantBadge tenantId={site.tenantId} size="md" />
          </>
        )}
        subtitle={[
          <AccountLink key="account" accountId={site.accountId} username={site.accountUsername} tab="sites" />,
          <span key="slug" className="font-mono">{site.slug}</span>,
          site.currentReleaseNumber != null && <span key="release" className="font-mono">#{site.currentReleaseNumber}</span>,
          site.primaryDomain && (
            <a key="domain" href={`https://${site.primaryDomain}/`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono hover:text-accent">
              {site.primaryDomain}<ExternalLink className="h-3 w-3" />
            </a>
          ),
          site.previewUrl && (
            <a key="preview" href={site.previewUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-blue-400 hover:underline">
              {t('runtime.preview.link') || 'preview'}<ExternalLink className="h-3 w-3" />
            </a>
          ),
        ]}
        message={site.status === 'error' ? site.statusMessage : null}
        onRefresh={() => { void loadSite(true); void loadWindow(); setReleasesTick((n) => n + 1); }}
        actions={(
          <>
            {canPublish && (
              <Button size="sm" onClick={() => setPublishOpen(true)} className="coarse:min-h-10">
                <Rocket size={14} className="mr-1" />
                {t('releases.publish.button') || 'Publish'}
              </Button>
            )}
            {canManage && (
              <ActionMenu
                triggerSize="lg"
                triggerVariant="solid"
                triggerClassName="rounded-lg"
                disabled={busy}
                items={[
                  site.status === 'stopped'
                    ? { key: 'start', icon: <Play className="h-4 w-4" />, label: t('sites.actions.start') || 'Start the site', onClick: () => void toggleRunning() }
                    : { key: 'stop', icon: <Square className="h-4 w-4" />, label: t('sites.actions.stop') || 'Stop the site', onClick: () => void toggleRunning() },
                  { key: 'delete', icon: <Trash2 className="h-4 w-4" />, label: t('sites.actions.delete') || 'Delete the site', onClick: () => void remove(), danger: true, separator: true },
                ]}
              />
            )}
          </>
        )}
      />

      <SegmentedTabs<Tab> tabs={tabs} value={tab} onChange={(next) => setTab(next)} ariaLabel={site.name} fill={false} />

      {/* Keyed by site: no local tab state (dirty form, open drawer…) carries over to another site. */}
      <Fragment key={`tabs-${site.id}`}>
      {tab === 'overview' && <SiteOverviewTab {...tabProps} onGoTo={setTab} />}
      {tab === 'releases' && (
        <div className="space-y-4">
          <SiteReleasesTab {...tabProps} tick={releasesTick} />
          {/* D10: everything that puts the site back in a previous state, in one tab. */}
          <SnapshotsCard site={site} tick={releasesTick + snapshotsTick} />
          <AccountBackupsTab
            accountId={site.accountId}
            siteId={site.id}
            canRun={canManage}
            canManage={false}
            can={{ code: canManage && can('files.manage', site.accountId), data: can('files.manage', site.accountId), db: false }}
          />
        </div>
      )}
      {tab === 'domains' && <SiteRoutesTab {...tabProps} />}
      {tab === 'runtime' && (
        <div className="space-y-4">
          <SiteRuntimeTab
            {...tabProps}
            switchTo={searchParams.get('switchTo')}
            onSwitchHandled={() => setTab('runtime')}
          />
          {siteHasPhp(site) && <SiteSettingsCard site={site} onSiteChange={setSiteIfCurrent} part="php" />}
        </div>
      )}
      {tab === 'config' && <SiteConfigTab {...tabProps} />}
      {tab === 'files' && <SiteFilesTab {...tabProps} />}
      {tab === 'cron' && <SiteCronTab site={site} />}
      {tab === 'logs' && (
        <div className="space-y-4">
          <SiteMonitorsCard site={site} />
          <SiteErrorGroupsCard site={site} />
          <SiteLogsTab site={site} />
        </div>
      )}
      {tab === 'maintenance' && <SiteMaintenanceTab site={site} />}
      </Fragment>

      <PublishModal
        key={`publish-${site.id}`}
        site={site}
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        onPublished={() => {
          setPublishOpen(false);
          setReleasesTick((n) => n + 1);
          if (tab !== 'releases') setTab('releases');
        }}
      />
    </PageContainer>
  );
}
