import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  AlertTriangle, Archive, ArrowLeft, BarChart3, ChevronRight, Database, FolderOpen, KeyRound, Gauge, Globe, HardDrive, Layers, LayoutGrid, Pause, Play, Plus,
  RefreshCw, Server, ShieldCheck, Trash2, Users,
} from 'lucide-react';
import type { Domain, HostingAccount, Plan, Site, SiteStatus } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { accountsApi } from '@/api/accounts.api';
import { plansApi } from '@/api/plans.api';
import { domainsApi } from '@/api/domains.api';
import { sitesApi } from '@/api/sites.api';
import { useHostingMe } from '@/store/hostingStore';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { AccountApiKeysTab } from '@/components/hosting/AccountApiKeysTab';
import { AccountBackupsTab } from '@/components/hosting/AccountBackupsTab';
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu';
import { IconButton } from '@/components/common/IconButton';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { Drawer } from '@/components/common/Drawer';
import { GroupedTable, domainTree } from '@/components/common/GroupedTable';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TenantBadge } from '@/components/common/TenantBadge';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { FileAccessPanel } from '@/components/hosting/FileAccessPanel';
import { AccountUsersTab } from '@/components/hosting/AccountUsersTab';
import { PlanSummary } from '@/components/hosting/AccountCreateModal';
import { DomainCreateModal, domainKindLabel } from '@/components/hosting/DomainCreateModal';
import { DomainPanel } from '@/components/hosting/DomainPanel';
import { VerificationBadge } from '@/components/dns/DnsBadges';
import { DomainClaimsCard } from '@/components/dns/DomainClaims';
import { AccountSecurityTab } from '@/components/security/AccountSecurityTab';
import { AccountUsageTab } from '@/components/usage/AccountUsageTab';
import { OverQuotaBanner, OverQuotaPill } from '@/components/usage/usageUi';
import { AccountDatabasesPanel } from '@/components/databases/AccountDatabasesPanel';
import {
  AccountStatusBadge, Card, DiskBar, EmptyState, ForceHttpsIcon, InfoRow, Pill, TlsBadge, headerBtnCls,
  hostingErrorMessage, isStepUpHandled, labelCls, payloadNumber, selectCls, toastHostingError, useHostingEvents,
} from '@/components/hosting/hostingUi';

type Tab = 'overview' | 'sites' | 'domains' | 'databases' | 'usage' | 'security' | 'users' | 'files' | 'keys' | 'backups';
const TABS: Tab[] = ['overview', 'sites', 'domains', 'databases', 'usage', 'security', 'users', 'files', 'keys', 'backups'];

export function AccountDetailPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { id: idParam } = useParams();
  const accountId = Number(idParam);
  const [params, setParams] = useSearchParams();
  const { me, can } = useHostingMe();
  const isMaster = useIsMasterTenant();

  const [account, setAccount] = useState<HostingAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [planModal, setPlanModal] = useState(false);

  const isStaff = me?.kind === 'staff';
  const manage = isStaff && can('accounts.manage', accountId);
  const rawTab = params.get('tab') as Tab | null;
  const manageKeys = can('sites.manage', accountId);
  const tab: Tab = rawTab && TABS.includes(rawTab) && (rawTab !== 'users' || manage) && (rawTab !== 'keys' || manageKeys) ? rawTab : 'overview';
  const setTab = (next: Tab) => {
    const p = new URLSearchParams(params);
    if (next === 'overview') p.delete('tab'); else p.set('tab', next);
    p.delete('domain');
    setParams(p, { replace: true });
  };

  // Request sequence: when :id changes, a late answer for the previous account is ignored.
  const seqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    if (!Number.isInteger(accountId) || accountId <= 0) { setAccount(null); setLoadError(t('accounts.notFound') || 'Account not found'); setLoading(false); return; }
    try {
      const a = await accountsApi.get(accountId);
      if (seq !== seqRef.current) return;
      setAccount(a);
      setLoadError(null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setAccount(null);
      const status = (err as { response?: { status?: number } })?.response?.status;
      setLoadError(status === 404 ? (t('accounts.notFound') || 'Account not found') : hostingErrorMessage(t, err, t('accounts.loadOneFailed') || 'Failed to load the account'));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [accountId, t]);

  useEffect(() => { setLoading(true); setAccount((cur) => (cur && cur.id === accountId ? cur : null)); void load(); }, [load, accountId]);
  useHostingEvents([HostingSocketEvents.HOSTING_CHANGED], () => { void load(); }, (_e, p) => {
    const entity = (p as { entity?: string } | null)?.entity;
    return payloadNumber(p, 'accountId') === accountId || (entity === 'account' && payloadNumber(p, 'id') === accountId);
  });

  const act = async (key: string, fn: () => Promise<HostingAccount>, okKey: string, okFallback: string, failKey: string, failFallback: string) => {
    setBusy(key);
    try {
      setAccount(await fn());
      toast.success(t(okKey) || okFallback);
    } catch (err) {
      toastHostingError(t, err, t(failKey) || failFallback);
    } finally {
      setBusy(null);
    }
  };

  const suspend = async () => {
    if (!account) return;
    if (!(await confirm({
      title: t('accounts.suspendTitle') || 'Suspend the account',
      message: t('accounts.suspendConfirm', { username: account.username, defaultValue: 'Suspend {{username}}? Its sites answer with a suspension page and its SFTP access is refused until it is resumed.' }),
      confirmLabel: t('accounts.suspend') || 'Suspend',
      danger: true,
    }))) return;
    await act('suspend', () => accountsApi.suspend(account.id), 'accounts.suspended', 'Account suspended', 'accounts.actionFailed', 'Action failed');
  };

  const remove = async () => {
    if (!account) return;
    if (!(await confirm({
      title: t('accounts.deleteTitle') || 'Delete the account',
      message: t('accounts.deleteConfirm', { username: account.username, defaultValue: 'Delete {{username}} with all its sites, releases, data, domains and certificates? This cannot be undone.' }),
      danger: true,
      requireText: account.username,
    }))) return;
    setBusy('delete');
    try {
      await accountsApi.delete(account.id, account.username);
      toast.success(t('accounts.deleted') || 'Account deletion started');
      navigate('/accounts');
    } catch (err) {
      toastHostingError(t, err, t('accounts.deleteFailed') || 'Failed to delete the account');
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <PageContainer><div className="flex justify-center py-12"><LoadingSpinner /></div></PageContainer>;
  if (!account) {
    return (
      <PageContainer className="flex flex-col gap-5">
        <Link to="/accounts" className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary"><ArrowLeft size={14} />{t('accounts.backToList') || 'Hosting accounts'}</Link>
        <EmptyState icon={<AlertTriangle />} text={loadError ?? (t('accounts.notFound') || 'Account not found')} />
      </PageContainer>
    );
  }

  const menuItems: ActionMenuItem[] = [
    { key: 'usage', icon: <Gauge size={16} />, label: t('accounts.refreshUsage') || 'Refresh disk usage', onClick: () => { void act('usage', () => accountsApi.refreshUsage(account.id), 'accounts.usageRefreshed', 'Disk usage refreshed', 'accounts.actionFailed', 'Action failed'); } },
    { key: 'plan', icon: <Layers size={16} />, label: t('accounts.changePlan') || 'Change plan', onClick: () => setPlanModal(true), hidden: !manage },
    { key: 'suspend', icon: <Pause size={16} />, label: t('accounts.suspend') || 'Suspend', onClick: () => { void suspend(); }, hidden: !manage || account.status === 'suspended' || account.status === 'deleting' },
    { key: 'unsuspend', icon: <Play size={16} />, label: t('accounts.unsuspend') || 'Resume', onClick: () => { void act('unsuspend', () => accountsApi.unsuspend(account.id), 'accounts.unsuspended', 'Account resumed', 'accounts.actionFailed', 'Action failed'); }, hidden: !manage || account.status !== 'suspended' },
    { key: 'delete', icon: <Trash2 size={16} />, label: t('accounts.delete') || 'Delete the account', onClick: () => { void remove(); }, hidden: !manage || account.status === 'deleting', danger: true, separator: true },
  ];

  const tabs: SegmentedTab<Tab>[] = [
    { id: 'overview', label: t('accounts.tabs.overview') || 'Overview', icon: <LayoutGrid size={14} /> },
    { id: 'sites', label: t('accounts.tabs.sites') || 'Sites', icon: <Server size={14} />, badge: <span className="font-mono text-[10px] opacity-70">{account.siteCount}</span> },
    { id: 'domains', label: t('accounts.tabs.domains') || 'Domains', icon: <Globe size={14} />, badge: <span className="font-mono text-[10px] opacity-70">{account.domainCount}</span> },
    { id: 'databases', label: t('usage.accountTabs.databases') || 'Databases', icon: <Database size={14} /> },
    { id: 'usage', label: t('usage.accountTabs.usage') || 'Usage', icon: <BarChart3 size={14} /> },
    { id: 'security', label: t('security.tab.title') || 'Security', icon: <ShieldCheck size={14} /> },
    { id: 'users', label: t('accounts.tabs.users') || 'Users', icon: <Users size={14} />, hidden: !manage },
    { id: 'files', label: t('accounts.tabs.files') || 'File access', icon: <FolderOpen size={14} /> },
    { id: 'keys', label: t('apiKeys.tab') || 'Access keys', icon: <KeyRound size={14} />, hidden: !manageKeys },
    { id: 'backups', label: t('backups.tab') || 'Backups', icon: <Archive size={14} /> },
  ];

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-center gap-3 max-sm:flex-wrap max-sm:gap-y-2">
        <IconButton label={t('accounts.backToList') || 'Hosting accounts'} icon={<ArrowLeft size={16} />} onClick={() => navigate('/accounts')} />
        <h1 className="min-w-0 truncate font-display text-2xl font-semibold tracking-wide text-text-primary">
          <span className="font-mono">{account.username}</span>
        </h1>
        <AccountStatusBadge status={account.status} message={account.statusMessage} />
        {account.planName && <Pill tone="accent" className="normal-case tracking-normal"><Layers size={10} />{account.planName}</Pill>}
        <OverQuotaPill state={account.overQuota} />
        {isMaster && <TenantBadge tenantId={account.tenantId} tenantName={account.tenantName} size="md" />}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => { void load(); }} className={headerBtnCls} disabled={busy !== null}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
          <ActionMenu items={menuItems} sheetTitle={account.username} disabled={busy !== null} />
        </div>
      </div>
      {account.displayName && <p className="-mt-3 text-sm text-text-muted">{account.displayName}</p>}

      {account.status === 'error' && account.statusMessage && (
        <div className="flex items-start gap-2 rounded-lg border border-status-down/30 bg-status-down/5 p-3 text-xs text-status-down">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="whitespace-pre-line break-words font-mono">{account.statusMessage}</span>
        </div>
      )}
      {account.status === 'suspended' && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-amber-400">
          <Pause size={14} className="mt-0.5 shrink-0" />
          <span>{account.statusMessage || t('accounts.suspendedBanner') || 'This account is suspended: its sites show a suspension page and SFTP is refused.'}</span>
        </div>
      )}

      {account.status !== 'suspended' && tab !== 'usage' && <OverQuotaBanner state={account.overQuota} />}

      <SegmentedTabs tabs={tabs} value={tab} onChange={setTab} className="lg:self-start" fill={false} tabClassName="gap-1.5" />

      {tab === 'overview' && <OverviewTab account={account} isStaff={isStaff} onRefreshUsage={() => { void act('usage', () => accountsApi.refreshUsage(account.id), 'accounts.usageRefreshed', 'Disk usage refreshed', 'accounts.actionFailed', 'Action failed'); }} refreshing={busy === 'usage'} />}
      {tab === 'sites' && <SitesTab account={account} />}
      {tab === 'domains' && <DomainsTab account={account} />}
      {tab === 'databases' && <AccountDatabasesPanel accountId={account.id} />}
      {tab === 'usage' && <AccountUsageTab accountId={account.id} />}
      {tab === 'security' && <AccountSecurityTab accountId={account.id} />}
      {tab === 'users' && manage && <AccountUsersTab accountId={account.id} tenantId={account.tenantId} />}
      {tab === 'files' && <FileAccessPanel accountId={account.id} />}
      {tab === 'keys' && manageKeys && <AccountApiKeysTab accountId={account.id} />}
      {tab === 'backups' && (
        <AccountBackupsTab
          accountId={account.id}
          canRun={can('sites.manage', accountId)}
          canManage={manage}
          can={{ code: can('sites.manage', accountId) && can('files.manage', accountId), data: can('files.manage', accountId), db: can('databases.manage', accountId) }}
        />
      )}

      <ChangePlanModal
        open={planModal}
        account={account}
        onClose={() => setPlanModal(false)}
        onSaved={(a) => { setPlanModal(false); setAccount(a); toast.success(t('accounts.planChanged') || 'Plan changed'); }}
      />
    </PageContainer>
  );
}

// ── Overview ────────────────────────────────────────────────────────────────

function OverviewTab({ account, isStaff, onRefreshUsage, refreshing }: {
  account: HostingAccount; isStaff: boolean; onRefreshUsage: () => void; refreshing: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [plan, setPlan] = useState<Plan | null>(null);

  useEffect(() => {
    if (!isStaff) return;
    let cancelled = false;
    plansApi.get(account.planId).then((p) => { if (!cancelled) setPlan(p); }).catch(() => { if (!cancelled) setPlan(null); });
    return () => { cancelled = true; };
  }, [account.planId, isStaff]);

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language) : '—');

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card
        title={t('accounts.overview.disk') || 'Disk'}
        icon={<HardDrive size={14} className="text-accent" />}
        actions={<Button size="sm" variant="secondary" loading={refreshing} onClick={onRefreshUsage}><RefreshCw size={13} className="mr-1.5" />{t('accounts.refreshUsage') || 'Refresh disk usage'}</Button>}
      >
        <DiskBar usedMb={account.diskUsedMb} quotaMb={account.diskQuotaMb} mode={account.quotaMode} />
        <p className="mt-3 text-xs text-text-muted">
          {account.quotaMode === 'xfs'
            ? (t('accounts.quota.xfsHint') || 'Hard XFS project quota: writes beyond the quota are refused by the file system.')
            : account.quotaMode === 'measured'
              ? (t('accounts.quota.measuredHint') || 'Measured usage: the disk is not XFS with project quotas, so the quota is checked periodically, not enforced by the file system.')
              : (t('accounts.quota.unknownHint') || 'The disk usage has not been measured yet.')}
        </p>
        <p className="mt-1 font-mono text-[11px] text-text-muted">{t('accounts.overview.usageChecked') || 'Measured'}: {fmt(account.usageCheckedAt)}</p>
      </Card>

      <Card title={t('accounts.overview.system') || 'System'} icon={<Server size={14} className="text-accent" />}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <InfoRow label={t('accounts.overview.username') || 'User'} mono>{account.username}</InfoRow>
          <InfoRow label="UID" mono>{account.uid}</InfoRow>
          <InfoRow label="GID" mono>{account.gid}</InfoRow>
          <InfoRow label={t('accounts.overview.node') || 'Node'} mono>#{account.nodeId}</InfoRow>
          <InfoRow label={t('accounts.overview.created') || 'Created'} mono>{fmt(account.createdAt)}</InfoRow>
          <InfoRow label={t('accounts.overview.updated') || 'Updated'} mono>{fmt(account.updatedAt)}</InfoRow>
        </div>
      </Card>

      <Card title={t('accounts.overview.plan') || 'Plan'} icon={<Layers size={14} className="text-accent" />}>
        <div className="text-sm font-medium text-text-primary">{account.planName ?? `#${account.planId}`}</div>
        {plan && <PlanSummary plan={plan} />}
        {plan?.description && <p className="mt-2 text-xs text-text-muted">{plan.description}</p>}
      </Card>

      <Card title={t('accounts.overview.content') || 'Content'} icon={<LayoutGrid size={14} className="text-accent" />}>
        <div className="grid grid-cols-2 gap-3">
          <InfoRow label={t('accounts.col.sites') || 'Sites'}><span className="font-display text-2xl font-semibold">{account.siteCount}</span></InfoRow>
          <InfoRow label={t('accounts.col.domains') || 'Domains'}><span className="font-display text-2xl font-semibold">{account.domainCount}</span></InfoRow>
        </div>
      </Card>
    </div>
  );
}

// ── Sites ───────────────────────────────────────────────────────────────────

function siteStatusTone(s: SiteStatus) {
  return ({ provisioning: 'blue', active: 'green', stopped: 'muted', error: 'red' } as const)[s];
}

function SitesTab({ account }: { account: HostingAccount }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can } = useHostingMe();
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSites(await sitesApi.list({ accountId: account.id }));
      setError(null);
    } catch (err) {
      setSites([]);
      setError(hostingErrorMessage(t, err, t('accounts.sites.loadFailed') || 'Failed to load the sites'));
    } finally {
      setLoading(false);
    }
  }, [account.id, t]);

  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.HOSTING_CHANGED], () => { void load(); }, (_e, p) => (p as { entity?: string } | null)?.entity === 'site' && payloadNumber(p, 'accountId') === account.id);

  const canCreate = can('sites.manage', account.id) && account.status !== 'suspended' && account.status !== 'deleting';
  // Contract with ui-sites: SitesPage opens its create modal from these query params.
  const createSite = () => navigate(`/sites?create=1&accountId=${account.id}`);
  const statusLabel = (s: SiteStatus) => t(`hostingCommon.siteStatus.${s}`) || s;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        {canCreate && <Button size="sm" onClick={createSite}><Plus size={13} className="mr-1.5" />{t('accounts.sites.create') || 'New site'}</Button>}
      </div>
      {loading ? (
        <div className="flex justify-center py-8"><LoadingSpinner /></div>
      ) : error ? (
        <EmptyState icon={<AlertTriangle />} text={error} />
      ) : sites.length === 0 ? (
        <EmptyState icon={<Server />} text={t('accounts.sites.empty') || 'No site in this account yet.'} />
      ) : (
        <GroupedTable<Site>
          singleGroupFlat
          minWidth={680}
          defaultSort={{ column: 'name' }}
          groups={[{ key: 'all', label: '', sortLabel: '', nodes: domainTree(sites, (x) => x.primaryDomain ?? `~${x.slug}`, (x) => x.id) }]}
          onRowClick={(x) => navigate(`/sites/${x.id}`)}
          renderCard={(x) => (
            <Link to={`/sites/${x.id}`} className="block rounded-xl bg-bg-secondary px-3 py-2.5 hover:bg-bg-tertiary/30">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-text-primary">{x.name}</span>
                <Pill tone={siteStatusTone(x.status)}>{statusLabel(x.status)}</Pill>
                <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-text-muted" />
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-text-muted">{x.slug}</div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-text-muted">
                <span>{x.base}</span>
                <span>{t('accounts.sites.col.release') || 'Release'} {x.currentReleaseNumber != null ? `#${x.currentReleaseNumber}` : '—'}</span>
                {x.primaryDomain && <span className="truncate">{x.primaryDomain}</span>}
              </div>
            </Link>
          )}
          columns={[
            {
              id: 'name', header: t('accounts.sites.col.name') || 'Site', sort: (x) => x.primaryDomain ?? x.name,
              cell: (x) => (
                <>
                  <Link to={`/sites/${x.id}`} className="font-medium text-text-primary hover:text-accent">{x.name}</Link>
                  <div className="font-mono text-[11px] text-text-muted">{x.slug}</div>
                </>
              ),
            },
            { id: 'base', header: t('accounts.sites.col.base') || 'Base', tdClassName: 'font-mono text-xs text-text-secondary', sort: (x) => x.base, cell: (x) => x.base },
            {
              id: 'status', header: t('accounts.sites.col.status') || 'Status', sort: (x) => x.status,
              cell: (x) => (x.statusMessage
                ? <span title={x.statusMessage}><Pill tone={siteStatusTone(x.status)}>{statusLabel(x.status)}</Pill></span>
                : <Pill tone={siteStatusTone(x.status)}>{statusLabel(x.status)}</Pill>),
            },
            { id: 'release', header: t('accounts.sites.col.release') || 'Release', tdClassName: 'font-mono text-xs text-text-secondary', sort: (x) => x.currentReleaseNumber ?? null, cell: (x) => (x.currentReleaseNumber != null ? `#${x.currentReleaseNumber}` : '—') },
            { id: 'domain', header: t('accounts.sites.col.domain') || 'Domain', tdClassName: 'font-mono text-xs text-text-secondary', sort: (x) => x.primaryDomain ?? '', cell: (x) => x.primaryDomain ?? '—' },
          ]}
        />
      )}
    </div>
  );
}

// ── Domains ─────────────────────────────────────────────────────────────────

function DomainsTab({ account }: { account: HostingAccount }) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const [params, setParams] = useSearchParams();
  const selectedId = Number(params.get('domain')) || null;
  const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [claimsKey, setClaimsKey] = useState(0);

  const load = useCallback(async () => {
    try {
      setDomains(await domainsApi.list({ accountId: account.id }));
      setError(null);
    } catch (err) {
      setDomains([]);
      setError(hostingErrorMessage(t, err, t('domains.loadFailed') || 'Failed to load the domains'));
    } finally {
      setLoading(false);
    }
  }, [account.id, t]);

  useEffect(() => { void load(); }, [load]);
  useHostingEvents([
    HostingSocketEvents.HOSTING_CHANGED, HostingSocketEvents.CERTIFICATE_UPDATED, HostingSocketEvents.DOMAIN_VERIFICATION_UPDATED,
  ], () => { void load(); });

  const select = (id: number | null) => {
    const p = new URLSearchParams(params);
    if (id == null) p.delete('domain'); else p.set('domain', String(id));
    setParams(p, { replace: id == null });
  };

  const canCreate = can('domains.manage', account.id) && account.status !== 'deleting';
  const selected = domains.find((d) => d.id === selectedId) ?? null;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        {canCreate && <Button size="sm" onClick={() => setCreating(true)}><Plus size={13} className="mr-1.5" />{t('domains.create') || 'Add a domain'}</Button>}
      </div>
      {/* Claims started from the create modal below are followed here (as on /domains). */}
      <DomainClaimsCard accountId={account.id} refreshKey={claimsKey} onSucceeded={() => { void load(); }} />
      {loading ? (
        <div className="flex justify-center py-8"><LoadingSpinner /></div>
      ) : error ? (
        <EmptyState icon={<AlertTriangle />} text={error} />
      ) : domains.length === 0 ? (
        <EmptyState icon={<Globe />} text={t('accounts.domains.empty') || 'No domain in this account yet.'} />
      ) : (
        <GroupedTable<Domain>
          singleGroupFlat
          minWidth={720}
          defaultSort={{ column: 'name' }}
          selectedKey={selectedId}
          groups={[{ key: 'all', label: '', sortLabel: '', nodes: domainTree(domains, (d) => d.name, (d) => d.id) }]}
          onRowClick={(d) => select(d.id)}
          renderCard={(d) => (
            <button type="button" onClick={() => select(d.id)} className="block w-full rounded-xl bg-bg-secondary px-3 py-2.5 text-left hover:bg-bg-tertiary/30">
              <div className="flex items-center gap-2">
                <span className="truncate font-mono text-sm font-semibold text-text-primary">{d.name}</span>
                <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-text-muted" />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted">
                <VerificationBadge verification={d.verification} />
                <span>{domainKindLabel(t, d.kind)}</span>
                <span className="font-mono">{d.routes.length} {t('domains.col.routes') || 'Routes'}</span>
                <TlsBadge tlsMode={d.tlsMode} certificate={d.certificate} />
                {d.forceHttps && <ForceHttpsIcon on />}
              </div>
            </button>
          )}
          columns={[
            { id: 'name', header: t('domains.col.name') || 'Domain', tdClassName: 'font-mono font-medium text-text-primary', sort: (d) => d.name, cell: (d) => d.name },
            { id: 'kind', header: t('domains.col.kind') || 'Kind', tdClassName: 'text-text-secondary', sort: (d) => d.kind, cell: (d) => domainKindLabel(t, d.kind) },
            { id: 'ownership', header: t('domainOwnership.col') || 'Ownership', sort: (d) => d.verification?.status ?? '', cell: (d) => <VerificationBadge verification={d.verification} /> },
            { id: 'routes', header: t('domains.col.routes') || 'Routes', thClassName: 'text-right', tdClassName: 'text-right font-mono tabular-nums', sort: (d) => d.routes.length, cell: (d) => d.routes.length },
            { id: 'tls', header: t('domains.col.tls') || 'TLS', sort: (d) => d.certificate?.status ?? d.tlsMode, cell: (d) => <TlsBadge tlsMode={d.tlsMode} certificate={d.certificate} /> },
            { id: 'https', header: t('domains.col.https') || 'HTTPS', sort: (d) => d.forceHttps, cell: (d) => <ForceHttpsIcon on={d.forceHttps} /> },
          ]}
        />
      )}

      <Drawer
        open={selectedId != null}
        onClose={() => select(null)}
        side="right"
        size="lg"
        title={selected?.name ?? (t('domains.detailTitle') || 'Domain')}
        icon={<Globe size={16} className="shrink-0 text-accent" />}
        bodyClassName="p-4"
      >
        {selectedId != null && (
          <DomainPanel
            domainId={selectedId}
            onChanged={(d) => setDomains((cur) => cur.map((x) => (x.id === d.id ? d : x)))}
            onDeleted={() => { select(null); void load(); }}
          />
        )}
      </Drawer>

      <DomainCreateModal
        open={creating}
        accountId={account.id}
        onClose={() => setCreating(false)}
        onClaimCreated={() => setClaimsKey((n) => n + 1)}
        onCreated={(d) => {
          setCreating(false);
          toast.success(t('domains.created', { name: d.name, defaultValue: 'Domain {{name}} added' }));
          setDomains((cur) => [...cur, d]);
          select(d.id);
        }}
      />
    </div>
  );
}

// ── Change plan ─────────────────────────────────────────────────────────────

function ChangePlanModal({ open, account, onClose, onSaved }: {
  open: boolean; account: HostingAccount; onClose: () => void; onSaved: (a: HostingAccount) => void;
}) {
  const { t } = useTranslation();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [planId, setPlanId] = useState<number>(account.planId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPlanId(account.planId);
    setError(null);
    plansApi.list()
      // God view: GET /plans lists every tenant's plans; only plans of the account's own tenant are valid.
      .then((list) => setPlans(list.filter((p) => p.tenantId === account.tenantId && (p.isActive || p.id === account.planId))))
      .catch((err) => setError(hostingErrorMessage(t, err, t('plans.loadFailed') || 'Failed to load the plans')));
  }, [open, account.planId, account.tenantId, t]);

  const plan = plans.find((p) => p.id === planId) ?? null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      onSaved(await accountsApi.update(account.id, { planId }));
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(hostingErrorMessage(t, err, t('accounts.changePlanFailed') || 'Failed to change the plan'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('accounts.changePlanTitle', { username: account.username, defaultValue: 'Plan of {{username}}' })}
      icon={<Layers className="h-4 w-4 text-accent" />}
      size="md"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
          <Button size="sm" loading={saving} disabled={planId === account.planId} onClick={() => { void save(); }}>{t('common.save') || 'Save'}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className={labelCls} htmlFor="change-plan">{t('accounts.form.plan') || 'Plan'}</label>
          <select id="change-plan" value={planId} onChange={(e) => setPlanId(Number(e.target.value))} className={selectCls}>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === account.planId ? ` (${t('accounts.currentPlan') || 'current'})` : ''}</option>)}
          </select>
          {plan && <PlanSummary plan={plan} />}
        </div>
        <p className="text-xs text-text-muted">{t('accounts.changePlanHint') || 'The new limits apply at the next reconciliation (disk quota, CPU and memory of the site containers).'}</p>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
