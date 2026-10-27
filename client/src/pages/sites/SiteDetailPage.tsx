import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, CalendarClock, Cpu, Database, DoorOpen, Eye, FolderOpen, KeyRound, Globe, History, LayoutDashboard, Play, RefreshCw, Rocket, Route,
  ScrollText, Square, Trash2, ExternalLink, Wrench,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { HostingSocketEvents, type HostingChangedPayload, type MaintenanceWindow, type Site, type WindowUpdatedPayload } from '@oblimint/shared';
import { sitesApi } from '@/api/sites.api';
import { maintenanceApi } from '@/api/maintenance.api';
import { useHostingMe } from '@/store/hostingStore';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
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
import { SiteDataPathsTab } from '@/components/sites/tabs/SiteDataPathsTab';
import { SiteFilesTab } from '@/components/sites/tabs/SiteFilesTab';
import { SiteEnvTab } from '@/components/sites/tabs/SiteEnvTab';
import { SiteCronTab } from '@/components/cron/SiteCronTab';
import { SiteLogsTab } from '@/components/logs/SiteLogsTab';
import { SiteMaintenanceTab } from '@/components/maintenance/SiteMaintenanceTab';
import type { SiteTab } from '@/utils/links';

// The tab ids are the deep-link contract of siteHref() (utils/links.ts).
type Tab = SiteTab;
const TAB_IDS: readonly Tab[] = ['overview', 'releases', 'runtime', 'routes', 'data', 'env', 'files', 'cron', 'logs', 'maintenance'];

function isTab(v: string | null): v is Tab {
  return v !== null && (TAB_IDS as readonly string[]).includes(v);
}

export function SiteDetailPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { id } = useParams<{ id: string }>();
  const siteId = Number(id);
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: Tab = isTab(tabParam) ? tabParam : 'overview';
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
  useHostingEvent<WindowUpdatedPayload>(HostingSocketEvents.WINDOW_UPDATED, (p) => {
    if (p.siteId === siteId) void loadWindow();
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
    const params = new URLSearchParams();
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

  const tabs: SegmentedTab<Tab>[] = [
    { id: 'overview', label: t('sites.tabs.overview') || 'Overview', icon: <LayoutDashboard size={16} /> },
    { id: 'releases', label: t('sites.tabs.releases') || 'Releases', icon: <History size={16} /> },
    { id: 'runtime', label: t('sites.tabs.runtime') || 'Runtime', icon: <Cpu size={16} /> },
    { id: 'routes', label: t('sites.tabs.routes') || 'Routes & domains', icon: <Route size={16} /> },
    { id: 'data', label: t('sites.tabs.data') || 'Data paths', icon: <Database size={16} /> },
    { id: 'env', label: t('siteEnv.tab') || 'Variables', icon: <KeyRound size={16} /> },
    { id: 'files', label: t('sites.tabs.files') || 'File access', icon: <FolderOpen size={16} /> },
    { id: 'cron', label: t('cron.tab.title') || 'Cron', icon: <CalendarClock size={16} /> },
    { id: 'logs', label: t('logs.tab.title') || 'Logs', icon: <ScrollText size={16} /> },
    { id: 'maintenance', label: t('maintenance.tab.title') || 'Maintenance', icon: <Wrench size={16} /> },
  ];

  const tabProps = {
    site,
    onSiteChange: setSiteIfCurrent,
    reloadSite: () => loadSite(true),
    onPublish: () => setPublishOpen(true),
  };

  return (
    <PageContainer className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-start gap-4 max-lg:flex-wrap max-lg:gap-3">
        <IconButton
          onClick={() => { if (window.history.length > 1) navigate(-1); else navigate('/sites'); }}
          size="lg"
          variant="plain"
          className="mt-0.5 rounded-lg hover:bg-bg-secondary"
          label={t('common.back') || 'Back'}
          icon={<ArrowLeft className="h-4 w-4" />}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3 max-sm:gap-2">
            <h1 className="truncate font-display text-2xl font-semibold tracking-wide text-text-primary max-sm:text-xl">{site.name}</h1>
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
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-muted">
            <Link to={`/accounts/${site.accountId}`} className="font-mono hover:text-accent">{site.accountUsername}</Link>
            <span>·</span>
            <span className="font-mono">{site.slug}</span>
            {site.currentReleaseNumber != null && (<><span>·</span><span className="font-mono">#{site.currentReleaseNumber}</span></>)}
            {site.primaryDomain && (
              <>
                <span>·</span>
                <a href={`https://${site.primaryDomain}/`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono hover:text-accent">
                  {site.primaryDomain}<ExternalLink className="h-3 w-3" />
                </a>
              </>
            )}
            {site.previewUrl && (
              <>
                <span>·</span>
                <a href={site.previewUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-blue-400 hover:underline">
                  {t('runtime.preview.link') || 'preview'}<ExternalLink className="h-3 w-3" />
                </a>
              </>
            )}
          </p>
          {site.status === 'error' && site.statusMessage && (
            <p className="mt-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{site.statusMessage}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 max-lg:order-last max-lg:w-full">
          <IconButton
            label={t('common.refresh') || 'Refresh'}
            icon={<RefreshCw className="h-4 w-4" />}
            onClick={() => { void loadSite(true); void loadWindow(); setReleasesTick((n) => n + 1); }}
            size="lg"
            variant="solid"
            className="rounded-lg"
          />
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
        </div>
      </div>

      <SegmentedTabs<Tab> tabs={tabs} value={tab} onChange={(next) => setTab(next)} ariaLabel={site.name} fill={false} />

      {/* Keyed by site: no local tab state (dirty form, open drawer…) carries over to another site. */}
      <Fragment key={`tabs-${site.id}`}>
      {tab === 'overview' && <SiteOverviewTab {...tabProps} onGoTo={setTab} />}
      {tab === 'releases' && <SiteReleasesTab {...tabProps} tick={releasesTick} />}
      {tab === 'runtime' && (
        <SiteRuntimeTab
          {...tabProps}
          switchTo={searchParams.get('switchTo')}
          onSwitchHandled={() => setTab('runtime')}
        />
      )}
      {tab === 'routes' && <SiteRoutesTab {...tabProps} />}
      {tab === 'data' && <SiteDataPathsTab {...tabProps} />}
      {tab === 'env' && <SiteEnvTab {...tabProps} />}
      {tab === 'files' && <SiteFilesTab {...tabProps} />}
      {tab === 'cron' && <SiteCronTab site={site} />}
      {tab === 'logs' && <SiteLogsTab site={site} />}
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
