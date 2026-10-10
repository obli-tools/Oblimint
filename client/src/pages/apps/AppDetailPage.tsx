import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  Activity, ArrowLeft, ArrowUpCircle, Boxes, Code2, Container, Download, Globe, History, LayoutDashboard, Moon, Play, Power, RefreshCw,
  Repeat, Rocket, RotateCw, ScrollText, Settings2, Square, Sun, TerminalSquare, Trash2,
} from 'lucide-react';
import {
  HostingSocketEvents, type AppDeployment, type AppResourceSummary, type AppStackDetail, type AppUpdatedPayload, type AppUserAction,
} from '@oblimint/shared';
import { appsApi } from '@/api/apps.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { TenantBadge } from '@/components/common/TenantBadge';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { headerAccentBtnCls, headerBtnCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { useP4bAccess } from '@/components/apps/appsAccess';
import { appsErrorMessage, isNotFound, toastAppsError } from '@/components/apps/appsErrors';
import { patchParams } from '@/components/apps/appsFormat';
import { AppStatusBadge, SourceTypeIcon, UpdateAvailableBadge, sourceTypeLabel } from '@/components/apps/AppBadges';
import { CatalogIcon } from '@/components/apps/CatalogIcon';
import { DeleteStackModal } from '@/components/apps/detail/DeleteStackModal';
import { AppOverviewTab } from '@/components/apps/detail/AppOverviewTab';
import { AppContainersTab } from '@/components/apps/detail/AppContainersTab';
import { AppLogsTab } from '@/components/apps/detail/AppLogsTab';
import { AppConsoleTab } from '@/components/apps/detail/AppConsoleTab';
import { AppHistoryTab } from '@/components/apps/detail/AppHistoryTab';
import { AppUpdatesTab } from '@/components/apps/detail/AppUpdatesTab';
import { AppResourcesTab } from '@/components/apps/detail/AppResourcesTab';
import { AppProxyTab } from '@/components/apps/detail/AppProxyTab';
import { AppSettingsTab } from '@/components/apps/detail/AppSettingsTab';

type Tab = 'overview' | 'containers' | 'logs' | 'console' | 'history' | 'updates' | 'resources' | 'proxy' | 'settings';
const TABS: readonly Tab[] = ['overview', 'containers', 'logs', 'console', 'history', 'updates', 'resources', 'proxy', 'settings'];

function isTab(v: string | null): v is Tab {
  return v !== null && (TABS as readonly string[]).includes(v);
}

/**
 * /apps/:id — one application: actions (deploy, redeploy, recreate, pull,
 * start, stop, restart, down, sleep / wake, delete), live deployment output and
 * tabs ?tab=overview|containers|logs|console|history|updates|resources|proxy|settings
 * (docs/P4b-PLAN.md §13). Refetched on APP_UPDATED. OWNED BY MODULE `ui-apps`.
 */
export function AppDetailPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { id } = useParams();
  const stackId = Number(id);
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: Tab = isTab(tabParam) ? tabParam : 'overview';
  const setTab = (next: Tab) => setParams((prev) => patchParams(prev, { tab: next === 'overview' ? null : next }), { replace: true });
  const { can } = useP4bAccess();

  const [stack, setStack] = useState<AppStackDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [resources, setResources] = useState<AppResourceSummary | null>(null);
  const [lastDeployment, setLastDeployment] = useState<AppDeployment | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [tick, setTick] = useState(0);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const [s, deps] = await Promise.all([
        appsApi.getStack(stackId),
        appsApi.listDeployments(stackId, { limit: 1 }).catch(() => ({ items: [] as AppDeployment[], total: 0 })),
      ]);
      if (n !== seq.current) return;
      setStack(s);
      setLastDeployment(deps.items[0] ?? null);
      setLoadError(null);
    } catch (err) {
      if (n !== seq.current) return;
      if (isNotFound(err)) setNotFound(true);
      else setLoadError(appsErrorMessage(t, err, t('apps.detail.loadFailed') || 'Failed to load the application'));
    }
  }, [stackId, t]);
  useEffect(() => { void load(); }, [load]);

  const accountId = stack?.accountId ?? null;
  useEffect(() => {
    if (accountId == null) return;
    let cancelled = false;
    appsApi.resources(accountId).then((r) => { if (!cancelled) setResources(r); }).catch(() => { if (!cancelled) setResources(null); });
    return () => { cancelled = true; };
  }, [accountId]);

  useHostingEvents([HostingSocketEvents.APP_UPDATED], () => { void load(); setTick((n) => n + 1); }, (_e, p) => {
    const payload = p as AppUpdatedPayload | null;
    if (!payload || (payload.stackId !== stackId && !(payload.entity === 'stack' && payload.id === stackId))) return false;
    if (payload.entity === 'stack' && payload.action === 'deleted') { navigate('/apps', { replace: true }); return false; }
    return true;
  }, 600);

  if (notFound || (loadError && !stack)) {
    return (
      <PageContainer className="flex flex-col items-center gap-3 py-16 text-center">
        <Boxes className="h-8 w-8 text-text-muted" />
        <p className="text-sm text-text-secondary">{notFound ? (t('apps.detail.notFound') || 'This application does not exist or is not visible to you.') : loadError}</p>
        <Link to="/apps" className="text-sm text-accent hover:underline">{t('apps.backToList') || 'Back to the applications'}</Link>
      </PageContainer>
    );
  }
  if (!stack) return <PageContainer className="flex justify-center py-16"><LoadingSpinner /></PageContainer>;

  const manage = can('apps.manage', stack.accountId);
  const consoleAllowed = !!resources?.console && can('apps.console', stack.accountId);
  const draft = stack.status === 'draft';
  const locked = stack.status === 'deploying' || stack.status === 'deleting' || busy !== null;
  const running = stack.status === 'running' || stack.status === 'partial';

  const started = (d: AppDeployment) => {
    setLastDeployment(d);
    if (tab !== 'overview' && tab !== 'history') setTab('overview');
  };

  const act = async (action: AppUserAction) => {
    const needsConfirm: Partial<Record<AppUserAction, { title: string; message: string }>> = {
      stop: { title: t('apps.actions.stop') || 'Stop', message: t('apps.actions.stopConfirm', { name: stack.displayName, defaultValue: 'Stop {{name}}? Its services stop answering until it is started again.' }) },
      down: { title: t('apps.actions.down') || 'Remove containers', message: t('apps.actions.downConfirm', { name: stack.displayName, defaultValue: 'Remove the containers of {{name}}? The volumes (data) are kept; a deploy recreates the containers.' }) },
      recreate: { title: t('apps.actions.recreate') || 'Recreate', message: t('apps.actions.recreateConfirm', { name: stack.displayName, defaultValue: 'Recreate every container of {{name}}? The services are interrupted for a moment.' }) },
    };
    const c = needsConfirm[action];
    if (c && !(await confirm({ title: c.title, message: c.message, confirmLabel: c.title, danger: action !== 'recreate' }))) return;
    setBusy(action);
    try {
      started(await appsApi.action(stack.id, { action }));
      toast.success(t('apps.actions.queued') || 'Action started');
    } catch (err) {
      toastAppsError(t, err, t('apps.actions.failed') || 'The action failed');
    } finally {
      setBusy(null);
    }
  };

  const sleepWake = async (wake: boolean) => {
    setBusy(wake ? 'wake' : 'sleep');
    try {
      started(wake ? await appsApi.wake(stack.id) : await appsApi.sleep(stack.id));
      toast.success(wake ? (t('apps.actions.wakeQueued') || 'Waking up…') : (t('apps.actions.sleepQueued') || 'Going to sleep…'));
    } catch (err) {
      toastAppsError(t, err, t('apps.actions.failed') || 'The action failed');
    } finally {
      setBusy(null);
    }
  };

  const tabs: SegmentedTab<Tab>[] = [
    { id: 'overview', label: t('apps.detail.tabs.overview') || 'Overview', icon: <LayoutDashboard size={15} /> },
    { id: 'containers', label: t('apps.detail.tabs.containers') || 'Containers', icon: <Container size={15} /> },
    { id: 'logs', label: t('apps.detail.tabs.logs') || 'Logs', icon: <ScrollText size={15} /> },
    { id: 'console', label: t('apps.detail.tabs.console') || 'Console', icon: <TerminalSquare size={15} />, hidden: !consoleAllowed },
    { id: 'history', label: t('apps.detail.tabs.history') || 'History', icon: <History size={15} /> },
    {
      id: 'updates', label: t('apps.detail.tabs.updates') || 'Updates', icon: <ArrowUpCircle size={15} />,
      badge: stack.updateAvailable ? <span className="ml-1 h-1.5 w-1.5 rounded-full bg-sky-400" /> : null,
    },
    { id: 'resources', label: t('apps.detail.tabs.resources') || 'Resources', icon: <Activity size={15} /> },
    { id: 'proxy', label: t('apps.detail.tabs.proxy') || 'Proxy', icon: <Globe size={15} />, badge: stack.proxyHosts.length ? <span className="ml-1 rounded-full bg-accent/15 px-1.5 font-mono text-[10px] text-accent">{stack.proxyHosts.length}</span> : null },
    { id: 'settings', label: t('apps.detail.tabs.settings') || 'Settings', icon: <Settings2 size={15} />, hidden: !manage },
  ];
  const shownTab: Tab = (tab === 'console' && !consoleAllowed) || (tab === 'settings' && !manage) ? 'overview' : tab;

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-start gap-4 max-lg:flex-wrap max-lg:gap-3">
        <IconButton
          onClick={() => { if (window.history.length > 1) navigate(-1); else navigate('/apps'); }}
          size="lg" variant="plain" className="mt-0.5 rounded-lg hover:bg-bg-secondary" label={t('common.back') || 'Back'} icon={<ArrowLeft className="h-4 w-4" />}
        />
        <CatalogIcon icon={stack.catalog?.icon ?? null} size={40} className="mt-0.5 max-sm:hidden" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3 max-sm:gap-2">
            <h1 className="min-w-0 break-all font-display text-2xl font-semibold tracking-wide text-text-primary max-sm:text-xl">{stack.displayName}</h1>
            <AppStatusBadge status={stack.status} message={stack.statusMessage} />
            {stack.updateAvailable && <UpdateAvailableBadge />}
            <TenantBadge tenantId={stack.tenantId} size="md" />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-muted">
            <span className="font-mono">{stack.accountUsername}</span>
            <span>·</span>
            <span className="font-mono">{stack.name}</span>
            <span>·</span>
            <span className="inline-flex items-center gap-1"><SourceTypeIcon type={stack.sourceType} size={13} />{stack.catalog ? stack.catalog.name : sourceTypeLabel(t, stack.sourceType)}</span>
            <span>·</span>
            <span className="font-mono">{t('apps.detail.servicesCount', { running: stack.runningCount, total: stack.serviceCount, defaultValue: '{{running}} / {{total}} services' })}</span>
          </p>
          {stack.description && <p className="mt-1 text-sm text-text-secondary">{stack.description}</p>}
          {(stack.status === 'error' || stack.status === 'partial') && stack.statusMessage && (
            <p className="mt-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{stack.statusMessage}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 max-lg:order-last max-lg:w-full">
          <IconButton label={t('common.refresh') || 'Refresh'} icon={<RefreshCw className="h-4 w-4" />} onClick={() => { void load(); setTick((n) => n + 1); }} size="lg" variant="solid" className="rounded-lg" />
          {manage && (
            <>
              {stack.status === 'sleeping' ? (
                <button type="button" disabled={locked} onClick={() => { void sleepWake(true); }} className={headerAccentBtnCls}><Sun size={14} />{t('apps.actions.wake') || 'Wake up'}</button>
              ) : (
                <button type="button" disabled={locked} onClick={() => { void act(draft ? 'deploy' : 'redeploy'); }} className={headerAccentBtnCls}>
                  <Rocket size={14} />{draft ? (t('apps.actions.deploy') || 'Deploy') : (t('apps.actions.redeploy') || 'Redeploy')}
                </button>
              )}
              {!draft && (running
                ? <button type="button" disabled={locked} onClick={() => { void act('stop'); }} className={headerBtnCls}><Square size={14} />{t('apps.actions.stop') || 'Stop'}</button>
                : stack.status !== 'sleeping' && <button type="button" disabled={locked} onClick={() => { void act('start'); }} className={headerBtnCls}><Play size={14} />{t('apps.actions.start') || 'Start'}</button>)}
              <ActionMenu
                triggerSize="lg"
                triggerVariant="solid"
                triggerClassName="rounded-lg"
                items={[
                  { key: 'edit', icon: <Code2 size={14} />, label: t('apps.list.editCompose') || 'Edit the compose', onClick: () => navigate(`/apps/${stack.id}/edit`) },
                  { key: 'restart', icon: <RotateCw size={14} />, label: t('apps.actions.restart') || 'Restart', onClick: () => { void act('restart'); }, disabled: locked || draft, separator: true },
                  { key: 'recreate', icon: <Repeat size={14} />, label: t('apps.actions.recreate') || 'Recreate', description: t('apps.actions.recreateHint') || 'New containers, same configuration', onClick: () => { void act('recreate'); }, disabled: locked || draft },
                  { key: 'pull', icon: <Download size={14} />, label: t('apps.actions.pull') || 'Pull images', description: t('apps.actions.pullHint') || 'Download the images without restarting', onClick: () => { void act('pull'); }, disabled: locked },
                  { key: 'sleep', icon: <Moon size={14} />, label: t('apps.actions.sleep') || 'Put to sleep', onClick: () => { void sleepWake(false); }, disabled: locked || !running, hidden: stack.status === 'sleeping' },
                  { key: 'down', icon: <Power size={14} />, label: t('apps.actions.down') || 'Remove containers', onClick: () => { void act('down'); }, disabled: locked || draft, danger: true, separator: true },
                  { key: 'delete', icon: <Trash2 size={14} />, label: t('apps.actions.delete') || 'Delete', onClick: () => setDeleting(true), disabled: stack.status === 'deleting', danger: true },
                ]}
              />
            </>
          )}
        </div>
      </div>

      <SegmentedTabs<Tab> tabs={tabs} value={shownTab} onChange={setTab} ariaLabel={stack.displayName} fill={false} />

      {shownTab === 'overview' && <AppOverviewTab stack={stack} lastDeployment={lastDeployment} canManage={manage} onDeploymentFinished={() => { void load(); }} />}
      {shownTab === 'containers' && <AppContainersTab key={tick} stack={stack} canManage={manage} onChanged={() => { void load(); }} />}
      {shownTab === 'logs' && <AppLogsTab stack={stack} />}
      {shownTab === 'console' && consoleAllowed && <AppConsoleTab stack={stack} />}
      {shownTab === 'history' && <AppHistoryTab key={tick} stack={stack} canManage={manage} onStarted={started} />}
      {shownTab === 'updates' && <AppUpdatesTab key={tick} stack={stack} canManage={manage} onStarted={started} onChanged={() => { void load(); }} />}
      {shownTab === 'resources' && <AppResourcesTab stack={stack} />}
      {shownTab === 'proxy' && <AppProxyTab stack={stack} canManage={can('proxy.manage', stack.accountId)} />}
      {shownTab === 'settings' && manage && <AppSettingsTab stack={stack} buildAllowed={resources?.build ?? false} onSaved={(s) => setStack(s)} onStarted={started} />}

      {deleting && <DeleteStackModal stack={stack} onClose={() => setDeleting(false)} onDeleted={() => navigate('/apps', { replace: true })} />}
    </PageContainer>
  );
}
