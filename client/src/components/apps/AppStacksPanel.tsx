import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Boxes, Code2, ExternalLink, Play, Plus, RotateCw, Rocket, Search, Square } from 'lucide-react';
import {
  HostingSocketEvents, type AppStack, type AppStackStatus, type AppUpdatedPayload, type AppUserAction,
} from '@oblimint/shared';
import { appsApi } from '@/api/apps.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { GroupedTable, flatNodes } from '@/components/common/GroupedTable';
import { groupRowsByAccount, useAccountDirectory } from '@/components/common/accountGroups';
import { TenantBadge } from '@/components/common/TenantBadge';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EmptyState, headerAccentBtnCls, inputCls, selectCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { useP4bAccess } from './appsAccess';
import { appsErrorMessage, isNotImplemented, toastAppsError } from './appsErrors';
import { ago } from './appsFormat';
import { AppStatusBadge, SourceTypeIcon, UpdateAvailableBadge, sourceTypeLabel, stackStatusLabel } from './AppBadges';
import { CatalogIcon } from './CatalogIcon';

const STATUSES: AppStackStatus[] = ['running', 'partial', 'deploying', 'stopped', 'sleeping', 'error', 'draft'];

/** Stacks table of /apps (search, status filter, quick actions, live refresh on APP_UPDATED). */
export function AppStacksPanel({ accountId, tenantId, showAccount, showTenant, newHref }: {
  accountId: number | null;
  tenantId: number | undefined;
  showAccount: boolean;
  showTenant: boolean;
  /** "New application" link (null = no right). */
  newHref: string | null;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { can } = useP4bAccess();
  const [stacks, setStacks] = useState<AppStack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<AppStackStatus | ''>('');
  const [busy, setBusy] = useState<number | null>(null);

  const seq = useRef(0);
  const load = useCallback(async (quiet = false) => {
    const n = ++seq.current;
    if (!quiet) setLoading(true);
    try {
      const list = await appsApi.listStacks({ accountId: accountId ?? undefined, tenantId });
      if (n !== seq.current) return;
      setStacks(list);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setError(isNotImplemented(err) ? appsErrorMessage(t, err) : appsErrorMessage(t, err, t('apps.list.loadFailed') || 'Failed to load the applications'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [accountId, tenantId, t]);
  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.APP_UPDATED], () => { void load(true); }, (_e, p) => {
    const payload = p as AppUpdatedPayload | null;
    return !!payload && payload.entity !== 'template' && (accountId == null || payload.accountId == null || payload.accountId === accountId);
  }, 800);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return stacks.filter((s) => (!status || s.status === status)
      && (!q || s.name.includes(q) || s.displayName.toLowerCase().includes(q) || s.accountUsername.toLowerCase().includes(q)));
  }, [stacks, search, status]);

  const accountDir = useAccountDirectory();

  const run = async (s: AppStack, action: AppUserAction) => {
    if (action === 'stop' && !(await confirm({
      title: t('apps.actions.stop') || 'Stop',
      message: t('apps.actions.stopConfirm', { name: s.displayName, defaultValue: 'Stop {{name}}? Its services stop answering until it is started again.' }),
      confirmLabel: t('apps.actions.stop') || 'Stop',
    }))) return;
    setBusy(s.id);
    try {
      await appsApi.action(s.id, { action });
      toast.success(t('apps.actions.queued') || 'Action started');
      void load(true);
    } catch (err) {
      toastAppsError(t, err, t('apps.actions.failed') || 'The action failed');
    } finally {
      setBusy(null);
    }
  };

  if (loading && stacks.length === 0) return <div className="flex justify-center py-12"><LoadingSpinner /></div>;
  if (error && stacks.length === 0) return <EmptyState icon={<Boxes />} text={error} />;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('apps.list.search') || 'Search an application…'} className={cn(inputCls, 'bg-bg-secondary pl-8')} />
        </div>
        <select aria-label={t('apps.list.statusFilter') || 'Status'} value={status} onChange={(e) => setStatus(e.target.value as AppStackStatus | '')} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-48')}>
          <option value="">{t('apps.list.allStatuses') || 'All statuses'}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{stackStatusLabel(t, s)}</option>)}
        </select>
      </div>

      {shown.length === 0 ? (
        <EmptyState
          icon={<Boxes />}
          text={stacks.length === 0 ? (t('apps.list.empty') || 'No application yet. Deploy one from the catalog, a compose file, a git repository or a ZIP archive.') : (t('apps.list.noMatch') || 'No application matches the filters.')}
          action={stacks.length === 0 && newHref ? <Link to={newHref} className={headerAccentBtnCls}><Plus size={14} />{t('apps.new') || 'New application'}</Link> : undefined}
        />
      ) : (
        <GroupedTable<AppStack>
          storageKey="apps"
          singleGroupFlat
          minWidth={700}
          defaultSort={{ column: 'name' }}
          groups={showAccount
            ? groupRowsByAccount(shown, accountDir, (s) => ({ id: s.accountId, username: s.accountUsername }), (rows) => flatNodes(rows, (s) => s.id))
            : [{ key: 'all', label: '', sortLabel: '', nodes: flatNodes(shown, (s) => s.id) }]}
          onRowClick={(s) => navigate(`/apps/${s.id}`)}
          columns={[
            {
              id: 'name', header: t('apps.list.name') || 'Application', sort: (s) => s.displayName,
              cell: (s) => (
                <div className="flex min-w-0 items-center gap-2.5">
                  <CatalogIcon icon={s.catalog?.icon ?? null} size={28} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Link to={`/apps/${s.id}`} className="truncate font-medium text-text-primary hover:text-accent">{s.displayName}</Link>
                      {showTenant && !showAccount && <TenantBadge tenantId={s.tenantId} />}
                    </div>
                    <div className="truncate font-mono text-[11px] text-text-muted">{s.name}</div>
                  </div>
                </div>
              ),
            },
            {
              id: 'source', header: t('apps.list.source') || 'Source', sort: (s) => (s.catalog ? s.catalog.name : s.sourceType),
              cell: (s) => (
                <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
                  <SourceTypeIcon type={s.sourceType} size={13} />
                  {s.catalog ? s.catalog.name : sourceTypeLabel(t, s.sourceType)}
                </span>
              ),
            },
            {
              id: 'status', header: t('apps.list.status') || 'Status', sort: (s) => s.status,
              cell: (s) => (
                <div className="flex flex-wrap items-center gap-1">
                  <AppStatusBadge status={s.status} message={s.statusMessage} />
                  {s.updateAvailable && <UpdateAvailableBadge />}
                </div>
              ),
            },
            { id: 'services', header: t('apps.list.services') || 'Services', tdClassName: 'font-mono text-xs text-text-secondary', sort: (s) => s.runningCount, cell: (s) => `${s.runningCount} / ${s.serviceCount}` },
            {
              id: 'deployed', header: t('apps.list.lastDeploy') || 'Last deployment', tdClassName: 'text-xs text-text-muted', sort: (s) => s.lastDeployedAt ?? '',
              cell: (s) => (
                <span title={s.lastDeployedAt ? new Date(s.lastDeployedAt).toLocaleString(i18n.language) : undefined}>
                  {s.lastDeployedAt ? t('apps.list.ago', { value: ago(s.lastDeployedAt), defaultValue: '{{value}} ago' }) : '—'}
                </span>
              ),
            },
            {
              id: 'actions', header: <span className="sr-only">{t('apps.list.actions') || 'Actions'}</span>, thClassName: 'w-12', tdClassName: 'px-2 py-2',
              cell: (s) => {
                const manage = can('apps.manage', s.accountId);
                const locked = s.status === 'deploying' || s.status === 'deleting' || busy === s.id;
                return (
                  <ActionMenu
                    disabled={busy === s.id}
                    items={[
                      { key: 'open', icon: <ExternalLink size={14} />, label: t('apps.list.open') || 'Open', onClick: () => navigate(`/apps/${s.id}`) },
                      { key: 'edit', icon: <Code2 size={14} />, label: t('apps.list.editCompose') || 'Edit the compose', onClick: () => navigate(`/apps/${s.id}/edit`), hidden: !manage },
                      { key: 'deploy', icon: <Rocket size={14} />, label: s.status === 'draft' ? (t('apps.actions.deploy') || 'Deploy') : (t('apps.actions.redeploy') || 'Redeploy'), onClick: () => { void run(s, s.status === 'draft' ? 'deploy' : 'redeploy'); }, hidden: !manage, disabled: locked, separator: true },
                      { key: 'start', icon: <Play size={14} />, label: t('apps.actions.start') || 'Start', onClick: () => { void run(s, 'start'); }, hidden: !manage || s.status === 'draft', disabled: locked || s.status === 'running' },
                      { key: 'restart', icon: <RotateCw size={14} />, label: t('apps.actions.restart') || 'Restart', onClick: () => { void run(s, 'restart'); }, hidden: !manage || s.status === 'draft', disabled: locked },
                      { key: 'stop', icon: <Square size={14} />, label: t('apps.actions.stop') || 'Stop', onClick: () => { void run(s, 'stop'); }, hidden: !manage || s.status === 'draft', disabled: locked || s.status === 'stopped', danger: true },
                    ]}
                  />
                );
              },
            },
          ]}
        />
      )}
    </div>
  );
}
