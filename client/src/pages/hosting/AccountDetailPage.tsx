import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  AlertTriangle, AppWindow, Archive, AtSign, BarChart3, ChevronRight, Database, FolderOpen, Gauge, Globe, HardDrive, HeartPulse, Layers, LayoutGrid,
  ListChecks, Network, Pause, Play, Plus, RefreshCw, Server, ShieldCheck, Shuffle, Trash2, Workflow, Activity,
} from 'lucide-react';
import type { AppStack, BackupRun, DbInstance, Domain, HostingAccount, MailOverview, Plan, ProxyHost, Site, UptimeMonitor } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { accountsApi } from '@/api/accounts.api';
import { plansApi } from '@/api/plans.api';
import { sitesApi } from '@/api/sites.api';
import { domainsApi } from '@/api/domains.api';
import { databasesApi } from '@/api/databases.api';
import { mailApi } from '@/api/mail.api';
import { appsApi } from '@/api/apps.api';
import { proxyApi } from '@/api/proxy.api';
import { uptimeApi } from '@/api/uptime.api';
import { backupsApi } from '@/api/backups.api';
import { useHostingMe } from '@/store/hostingStore';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { AccountBackupsTab } from '@/components/hosting/AccountBackupsTab';
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu';
import { DetailHeader } from '@/components/common/DetailHeader';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { GroupedTable, domainTree } from '@/components/common/GroupedTable';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TenantBadge } from '@/components/common/TenantBadge';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { LaunchChecklist, type ChecklistItem } from '@/components/common/ObjectTiles';
import { MiniStat } from '@/components/usage/HeroCards';
import { FileAccessPanel } from '@/components/hosting/FileAccessPanel';
import { AccountAccessTab } from '@/components/hosting/AccountAccessTab';
import { PlanSummary } from '@/components/hosting/AccountCreateModal';
import { DomainsList } from '@/components/hosting/DomainsList';
import { DomainCreateModal } from '@/components/hosting/DomainCreateModal';
import { DnsZonesTab } from '@/components/dns/DnsZonesTab';
import { AccountUsageTab } from '@/components/usage/AccountUsageTab';
import { OverQuotaBanner, OverQuotaPill } from '@/components/usage/usageUi';
import { AccountDatabasesPanel } from '@/components/databases/AccountDatabasesPanel';
import { DbInstanceCreateModal } from '@/components/databases/DbInstanceCreateModal';
import { AccountMailTab } from '@/components/mail/AccountMailTab';
import { MailDomainCreateModal } from '@/components/mail/MailDomainCreateModal';
import { AppStacksPanel } from '@/components/apps/AppStacksPanel';
import { p4bCan } from '@/components/apps/appsFormat';
import { FileExplorer } from '@/components/files/FileExplorer';
import {
  AccountStatusBadge, Card, DiskBar, EmptyState, InfoRow, Pill,
  hostingErrorMessage, isStepUpHandled, labelCls, payloadNumber, selectCls, toastHostingError, useHostingEvents,
} from '@/components/hosting/hostingUi';
import { CreateSiteModal } from '@/components/sites/CreateSiteModal';
import { BaseBadge, SiteStatusBadge } from '@/components/sites/SiteBadges';
import { resolveAccountTab, siteHref, type AccountTab } from '@/utils/links';

// The tab ids are the deep-link contract of accountHref() (utils/links.ts);
// the old ids (security, users, keys) are aliases rewritten on arrival.
type Tab = AccountTab;
type DomainsSub = 'domains' | 'zones';

/**
 * Account page (coherence plan 1.2): the management centre of a hosting
 * account, in 10 tabs. Everything about the account is done here, creations
 * in place; the sidebar pages are the cross-account views of the same panels.
 */
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
  const appsReadable = p4bCan(me, 'read', accountId);
  const resolved = resolveAccountTab(params.get('tab'));
  const tab: Tab = resolved.tab === 'apps' && me && !appsReadable ? 'overview' : resolved.tab;
  // An old tab id (?tab=security|users|keys) becomes « Access & security » on its section.
  useEffect(() => {
    if (!resolved.alias) return;
    const p = new URLSearchParams(params);
    p.set('tab', resolved.tab);
    for (const [k, v] of Object.entries(resolved.alias.extra)) p.set(k, v);
    setParams(p, { replace: true });
  }, [resolved.alias, resolved.tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const setTab = (next: Tab, extra: Record<string, string> = {}) => {
    const p = new URLSearchParams();
    if (next !== 'overview') p.set('tab', next);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    setParams(p, { replace: true });
  };
  // Domains tab: sub-filter Domains | DNS zones (`&sub=zones`; domains by default).
  const domainsSub: DomainsSub = params.get('sub') === 'zones' ? 'zones' : 'domains';
  const setDomainsSub = (next: DomainsSub) => {
    const p = new URLSearchParams(params);
    if (next === 'domains') p.delete('sub'); else p.set('sub', next);
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
        <DetailHeader backTo="/accounts" title={t('accounts.notFound') || 'Account not found'} />
        <EmptyState icon={<AlertTriangle />} text={loadError ?? (t('accounts.notFound') || 'Account not found')} />
      </PageContainer>
    );
  }

  const refreshUsage = () => { void act('usage', () => accountsApi.refreshUsage(account.id), 'accounts.usageRefreshed', 'Disk usage refreshed', 'accounts.actionFailed', 'Action failed'); };
  const menuItems: ActionMenuItem[] = [
    { key: 'usage', icon: <Gauge size={16} />, label: t('accounts.refreshUsage') || 'Refresh disk usage', onClick: refreshUsage },
    { key: 'plan', icon: <Layers size={16} />, label: t('accounts.changePlan') || 'Change plan', onClick: () => setPlanModal(true), hidden: !manage },
    { key: 'suspend', icon: <Pause size={16} />, label: t('accounts.suspend') || 'Suspend', onClick: () => { void suspend(); }, hidden: !manage || account.status === 'suspended' || account.status === 'deleting' },
    { key: 'unsuspend', icon: <Play size={16} />, label: t('accounts.unsuspend') || 'Resume', onClick: () => { void act('unsuspend', () => accountsApi.unsuspend(account.id), 'accounts.unsuspended', 'Account resumed', 'accounts.actionFailed', 'Action failed'); }, hidden: !manage || account.status !== 'suspended' },
    { key: 'delete', icon: <Trash2 size={16} />, label: t('accounts.delete') || 'Delete the account', onClick: () => { void remove(); }, hidden: !manage || account.status === 'deleting', danger: true, separator: true },
  ];

  const count = (n: number) => <span className="font-mono text-[10px] opacity-70">{n}</span>;
  // Coherence plan 1.2: 10 tabs, the proxy is reached from a tile of the overview.
  const tabs: SegmentedTab<Tab>[] = [
    { id: 'overview', label: t('accounts.tabs.overview') || 'Overview', icon: <LayoutGrid size={14} /> },
    { id: 'sites', label: t('accounts.tabs.sites') || 'Sites', icon: <Server size={14} />, badge: count(account.siteCount) },
    { id: 'apps', label: t('accounts.tabs.apps') || 'Applications', icon: <AppWindow size={14} />, hidden: !appsReadable },
    { id: 'domains', label: t('accounts.tabs.domainsDns') || 'Domains & DNS', icon: <Globe size={14} />, badge: count(account.domainCount) },
    { id: 'mail', label: t('accounts.tabs.mail') || 'Mail', icon: <AtSign size={14} /> },
    { id: 'databases', label: t('accounts.tabs.databases') || 'Databases', icon: <Database size={14} /> },
    { id: 'files', label: t('accounts.tabs.files') || 'Files', icon: <FolderOpen size={14} /> },
    { id: 'backups', label: t('accounts.tabs.backups') || 'Backups', icon: <Archive size={14} /> },
    { id: 'access', label: t('accounts.tabs.access') || 'Access & security', icon: <ShieldCheck size={14} /> },
    { id: 'usage', label: t('accounts.tabs.usage') || 'Usage', icon: <BarChart3 size={14} /> },
  ];

  return (
    <PageContainer className="flex flex-col gap-5">
      <DetailHeader
        backTo="/accounts"
        // C3: the account is named by its primary domain, the system user follows.
        title={<span className="font-mono">{account.primaryDomain || account.username}</span>}
        badges={(
          <>
            <AccountStatusBadge status={account.status} message={account.statusMessage} />
            {account.planName && <Pill tone="accent"><Layers size={10} />{account.planName}</Pill>}
            <OverQuotaPill state={account.overQuota} />
            {isMaster && <TenantBadge tenantId={account.tenantId} tenantName={account.tenantName} size="md" />}
          </>
        )}
        subtitle={[
          account.primaryDomain ? <span key="user" className="font-mono">{account.username}</span> : null,
          account.displayName ? <span key="name">{account.displayName}</span> : null,
        ]}
        message={account.status === 'error' ? account.statusMessage : null}
        onRefresh={() => { void load(); }}
        refreshing={busy !== null}
        actions={<ActionMenu items={menuItems} sheetTitle={account.username} disabled={busy !== null} triggerSize="lg" triggerVariant="solid" triggerClassName="rounded-lg" />}
      />

      {account.status === 'suspended' && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-amber-400">
          <Pause size={14} className="mt-0.5 shrink-0" />
          <span>{account.statusMessage || t('accounts.suspendedBanner') || 'This account is suspended: its sites show a suspension page and SFTP is refused.'}</span>
        </div>
      )}

      {account.status !== 'suspended' && tab !== 'usage' && <OverQuotaBanner state={account.overQuota} />}

      <SegmentedTabs tabs={tabs} value={tab} onChange={(next) => setTab(next)} className="lg:self-start" fill={false} tabClassName="gap-1.5" />

      {tab === 'overview' && <OverviewTab account={account} isStaff={isStaff} appsReadable={appsReadable} onGoTo={setTab} onRefreshUsage={refreshUsage} refreshing={busy === 'usage'} />}
      {tab === 'sites' && <SitesTab account={account} />}
      {tab === 'apps' && <AppsTab account={account} />}
      {tab === 'domains' && (
        <div className="flex flex-col gap-4">
          <SegmentedTabs<DomainsSub>
            tabs={[
              { id: 'domains', label: t('dns.tabs.domains') || 'Domains', icon: <Globe size={14} /> },
              { id: 'zones', label: t('dns.tabs.zones') || 'DNS zones', icon: <Network size={14} /> },
            ]}
            value={domainsSub}
            onChange={setDomainsSub}
            size="sm"
            fill={false}
            className="self-start"
            ariaLabel={t('accounts.tabs.domains') || 'Domains'}
          />
          {domainsSub === 'domains'
            ? <DomainsList accountId={account.id} createDisabled={account.status === 'deleting'} />
            : <DnsZonesTab accountId={account.id} />}
        </div>
      )}
      {tab === 'mail' && <AccountMailTab account={account} />}
      {tab === 'databases' && <AccountDatabasesPanel accountId={account.id} />}
      {tab === 'files' && <FilesTab account={account} />}
      {tab === 'backups' && (
        <AccountBackupsTab
          accountId={account.id}
          canRun={can('sites.manage', accountId)}
          canManage={manage}
          can={{ code: can('sites.manage', accountId) && can('files.manage', accountId), data: can('files.manage', accountId), db: can('databases.manage', accountId) }}
        />
      )}
      {tab === 'access' && <AccountAccessTab account={account} />}
      {tab === 'usage' && <AccountUsageTab accountId={account.id} />}

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

/** What the overview counts, each list null when the caller may not read it. */
interface OverviewData {
  domains: Domain[] | null;
  instances: DbInstance[] | null;
  mail: MailOverview | null;
  apps: AppStack[] | null;
  proxyHosts: ProxyHost[] | null;
  monitors: UptimeMonitor[] | null;
  backups: BackupRun[] | null;
}

function useOverviewData(accountId: number, appsReadable: boolean): [OverviewData | null, () => void] {
  const [data, setData] = useState<OverviewData | null>(null);
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    const v = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === 'fulfilled' ? r.value : null);
    void Promise.allSettled([
      domainsApi.list({ accountId }),
      databasesApi.listInstances({ accountId }),
      mailApi.overview(accountId),
      appsReadable ? appsApi.listStacks({ accountId }) : Promise.reject(new Error('no access')),
      proxyApi.listHosts({ accountId }),
      uptimeApi.listMonitors({ accountId }),
      backupsApi.account(accountId),
    ]).then(([d, i, m, a, p, u, b]) => {
      if (n !== seq.current) return;
      setData({ domains: v(d), instances: v(i), mail: v(m), apps: v(a), proxyHosts: v(p), monitors: v(u), backups: v(b)?.runs ?? null });
    });
  }, [accountId, appsReadable]);
  useEffect(() => { load(); }, [load]);
  useHostingEvents([
    HostingSocketEvents.HOSTING_CHANGED, HostingSocketEvents.CERTIFICATE_UPDATED, HostingSocketEvents.DOMAIN_VERIFICATION_UPDATED,
    HostingSocketEvents.DB_INSTANCE_UPDATED, HostingSocketEvents.MAIL_UPDATED,
  ], load, (_e, p) => payloadNumber(p, 'accountId') === accountId || payloadNumber(p, 'accountId') == null, 1500);
  return [data, load];
}

function OverviewTab({ account, isStaff, appsReadable, onGoTo, onRefreshUsage, refreshing }: {
  account: HostingAccount; isStaff: boolean; appsReadable: boolean;
  onGoTo: (tab: Tab, extra?: Record<string, string>) => void;
  onRefreshUsage: () => void; refreshing: boolean;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { can } = useHostingMe();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [data, reload] = useOverviewData(account.id, appsReadable);
  // Creations in place from the checklist (coherence plan C6).
  const [creating, setCreating] = useState<'site' | 'domain' | 'db' | 'mail' | null>(null);

  useEffect(() => {
    if (!isStaff) return;
    let cancelled = false;
    plansApi.get(account.planId).then((p) => { if (!cancelled) setPlan(p); }).catch(() => { if (!cancelled) setPlan(null); });
    return () => { cancelled = true; };
  }, [account.planId, isStaff]);

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language) : '—');
  const fmtShort = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' }) : '—');

  const domains = data?.domains ?? null;
  const unverified = domains?.filter((d) => d.verification?.status === 'pending') ?? [];
  const certFailed = domains?.filter((d) => d.tlsMode !== 'none' && (d.certificate?.status === 'failed' || d.certificate?.status === 'expired')) ?? [];
  const httpsOk = domains?.some((d) => d.tlsMode !== 'none' && d.certificate?.status === 'valid') ?? false;
  const lastBackup = data?.backups?.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
  const active = account.status !== 'suspended' && account.status !== 'deleting';
  const unknown = data === null;

  const items: ChecklistItem[] = [
    {
      key: 'site', done: account.siteCount > 0,
      label: t('objectPage.account.site') || 'A site is created',
      action: can('sites.manage', account.id) && active ? { label: t('accounts.sites.create') || 'New site', onClick: () => setCreating('site') } : null,
    },
    {
      key: 'domain', done: (domains?.length ?? 0) > 0 && unverified.length === 0, unknown: unknown || domains === null,
      label: t('objectPage.account.domain') || 'A verified domain',
      hint: unverified.length > 0 ? t('objectPage.account.toVerifyHint', { names: unverified.map((d) => d.name).join(', '), defaultValue: 'To verify: {{names}}' }) : undefined,
      action: unverified.length > 0
        ? { label: t('objectPage.open') || 'Open', onClick: () => onGoTo('domains', { domain: String(unverified[0].id) }) }
        : can('domains.manage', account.id) && active ? { label: t('domains.create') || 'Add a domain', onClick: () => setCreating('domain') } : null,
    },
    {
      key: 'https', done: httpsOk && certFailed.length === 0, unknown: unknown || domains === null || domains.length === 0,
      label: t('objectPage.account.https') || 'HTTPS in place',
      hint: certFailed.length > 0 ? t('objectPage.account.certFailedHint', { names: certFailed.map((d) => d.name).join(', '), defaultValue: 'Certificate failed: {{names}}' }) : undefined,
      action: { label: t('objectPage.open') || 'Open', onClick: () => onGoTo('domains', certFailed[0] ? { domain: String(certFailed[0].id) } : {}) },
    },
    {
      key: 'db', done: (data?.instances?.length ?? 0) > 0, unknown: unknown || data?.instances === null,
      label: t('objectPage.account.db') || 'A database instance',
      hint: t('objectPage.account.optional') || 'Optional',
      action: can('databases.manage', account.id) && active ? { label: t('databases.create') || 'New instance', onClick: () => setCreating('db') } : null,
    },
    {
      key: 'mail', done: (data?.mail?.counts.domains ?? 0) > 0, unknown: unknown || data?.mail === null,
      label: t('objectPage.account.mail') || 'Mail enabled on a domain',
      hint: t('objectPage.account.optional') || 'Optional',
      action: can('mail.manage', account.id) && active ? { label: t('domains.usage.enableMail') || 'Enable mail', onClick: () => setCreating('mail') } : null,
    },
    {
      key: 'backup', done: lastBackup != null && (lastBackup.status === 'ok' || lastBackup.status === 'partial'), unknown: unknown || data?.backups === null,
      label: t('objectPage.account.backup') || 'A backup made',
      hint: lastBackup ? fmtShort(lastBackup.startedAt) : undefined,
      action: { label: t('objectPage.open') || 'Open', onClick: () => onGoTo('backups') },
    },
  ];

  const mailCounts = data?.mail?.counts ?? null;
  const proxyEnabled = data?.proxyHosts?.filter((h) => h.enabled).length ?? 0;
  const monitorsDown = data?.monitors?.filter((m) => m.status === 'down').length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      {(unverified.length > 0 || certFailed.length > 0) && (
        <div className="flex flex-col gap-1.5">
          {unverified.map((d) => (
            <button key={`v-${d.id}`} type="button" onClick={() => onGoTo('domains', { domain: String(d.id) })} className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 text-left text-xs text-amber-400 hover:bg-amber-400/10">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{t('objectPage.account.alertUnverified', { name: d.name, defaultValue: '{{name}} is not verified: visitors see a placeholder page and no certificate is issued.' })}</span>
              <ChevronRight size={14} className="ml-auto mt-0.5 shrink-0" />
            </button>
          ))}
          {certFailed.map((d) => (
            <button key={`c-${d.id}`} type="button" onClick={() => onGoTo('domains', { domain: String(d.id) })} className="flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-400/5 p-3 text-left text-xs text-red-400 hover:bg-red-400/10">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{t('objectPage.account.alertCert', { name: d.name, defaultValue: 'The certificate of {{name}} failed or expired.' })}</span>
              <ChevronRight size={14} className="ml-auto mt-0.5 shrink-0" />
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
        <MiniStat icon={<Server size={15} />} label={t('accounts.tabs.sites') || 'Sites'} value={account.siteCount} onClick={() => onGoTo('sites')} />
        {appsReadable && <MiniStat icon={<AppWindow size={15} />} label={t('accounts.tabs.apps') || 'Applications'} value={data?.apps?.length ?? null} onClick={() => onGoTo('apps')} />}
        <MiniStat
          icon={<Globe size={15} />} label={t('accounts.tabs.domains') || 'Domains'} value={account.domainCount}
          sub={unverified.length > 0 ? t('domainOwnership.pendingCount', { count: unverified.length, defaultValue: '{{count}} to verify' }) : undefined}
          tone={unverified.length > 0 ? 'amber' : undefined}
          onClick={() => onGoTo('domains')}
        />
        <MiniStat
          icon={<AtSign size={15} />} label={t('mail.tabs.mailboxes') || 'Mailboxes'} value={mailCounts?.mailboxes ?? null}
          sub={mailCounts ? t('objectPage.account.mailDomains', { count: mailCounts.domains, defaultValue: '{{count}} mail domain(s)' }) : undefined}
          onClick={() => onGoTo('mail')}
        />
        <MiniStat icon={<Database size={15} />} label={t('accounts.tabs.databases') || 'Databases'} value={data?.instances?.length ?? null} onClick={() => onGoTo('databases')} />
        {/* The proxy has no tab of its own (8 sub-tabs): a tile to its page, account preset. */}
        <MiniStat
          icon={<Shuffle size={15} />} label={t('objectPage.account.proxyHosts') || 'Proxy hosts'} value={data?.proxyHosts?.length ?? null}
          sub={data?.proxyHosts ? t('objectPage.account.enabledCount', { count: proxyEnabled, defaultValue: '{{count}} enabled' }) : undefined}
          to={`/proxy?account=${account.id}`}
        />
        <MiniStat
          icon={<HeartPulse size={15} />} label={t('objectPage.account.monitors') || 'Monitors'} value={data?.monitors?.length ?? null}
          sub={monitorsDown > 0 ? t('objectPage.account.downCount', { count: monitorsDown, defaultValue: '{{count}} down' }) : undefined}
          tone={monitorsDown > 0 ? 'red' : undefined}
          to={`/uptime?account=${account.id}`}
        />
        <MiniStat
          icon={<Archive size={15} />} label={t('objectPage.account.lastBackup') || 'Last backup'}
          value={lastBackup ? fmtShort(lastBackup.startedAt) : (data?.backups ? '—' : null)}
          sub={lastBackup?.status === 'failed' ? (t('objectPage.account.backupFailed') || 'failed') : undefined}
          tone={lastBackup?.status === 'failed' ? 'red' : undefined}
          onClick={() => onGoTo('backups')}
        />
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <Link to={`/traffic?account=${account.id}`} className="inline-flex items-center gap-1 text-accent hover:underline"><Activity size={12} />{t('objectPage.account.traffic') || 'HTTP requests'}</Link>
        <Link to={`/automation?account=${account.id}`} className="inline-flex items-center gap-1 text-accent hover:underline"><Workflow size={12} />{t('objectPage.account.automation') || 'Automation'}</Link>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title={t('objectPage.account.launchTitle') || 'Getting started'} icon={<ListChecks size={14} className="text-accent" />}>
          <LaunchChecklist items={items} />
        </Card>

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

        <Card title={t('accounts.overview.plan') || 'Plan'} icon={<Layers size={14} className="text-accent" />}>
          <div className="text-sm font-medium text-text-primary">{account.planName ?? `#${account.planId}`}</div>
          {plan && <PlanSummary plan={plan} />}
          {plan?.description && <p className="mt-2 text-xs text-text-muted">{plan.description}</p>}
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
      </div>

      <CreateSiteModal
        open={creating === 'site'}
        initialAccountId={account.id}
        onClose={() => setCreating(null)}
        onCreated={(site) => { setCreating(null); navigate(siteHref(site.id)); }}
      />
      <DomainCreateModal
        open={creating === 'domain'}
        accountId={account.id}
        onClose={() => setCreating(null)}
        onCreated={(d) => {
          setCreating(null);
          toast.success(t('domains.created', { name: d.name, defaultValue: 'Domain {{name}} added' }));
          onGoTo('domains', { domain: String(d.id) });
        }}
      />
      {creating === 'db' && (
        <DbInstanceCreateModal
          open
          accountId={account.id}
          onClose={() => setCreating(null)}
          onCreated={(i) => { setCreating(null); toast.success(t('databases.created', { name: i.name, defaultValue: 'Instance {{name}} created' })); reload(); }}
        />
      )}
      <MailDomainCreateModal
        open={creating === 'mail'}
        accounts={[]}
        defaultAccountId={account.id}
        onClose={() => setCreating(null)}
        onCreated={() => { setCreating(null); toast.success(t('domains.usage.mailEnabled') || 'Mail enabled'); reload(); }}
      />
    </div>
  );
}

// ── Applications ────────────────────────────────────────────────────────────

/** The application stacks of the account (same panel as /apps, account fixed). */
function AppsTab({ account }: { account: HostingAccount }) {
  const { t } = useTranslation();
  const { me } = useHostingMe();
  const canCreate = p4bCan(me, 'apps.manage', account.id) && account.status !== 'suspended' && account.status !== 'deleting';
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-xs">
        <Link to={`/apps?account=${account.id}&tab=catalog`} className="text-accent hover:underline">{t('objectPage.account.appsCatalog') || 'Catalog'}</Link>
        <Link to={`/apps?account=${account.id}&tab=registries`} className="text-accent hover:underline">{t('objectPage.account.appsRegistries') || 'Registries'}</Link>
        {canCreate && (
          <Link to={`/apps/new?account=${account.id}`} className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:bg-accent-hover">
            <Plus size={13} />{t('apps.new') || 'New application'}
          </Link>
        )}
      </div>
      <AppStacksPanel accountId={account.id} tenantId={undefined} showAccount={false} showTenant={false} newHref={canCreate ? `/apps/new?account=${account.id}` : null} />
    </div>
  );
}

// ── Files ───────────────────────────────────────────────────────────────────

/**
 * Files of the account (coherence plan D6): the explorer from the account
 * root (`&path=`), then the SFTP connection, password, keys and mode.
 */
function FilesTab({ account }: { account: HostingAccount }) {
  const { can } = useHostingMe();
  const [params, setParams] = useSearchParams();
  const path = params.get('path') || '/';
  const go = (p: string) => setParams((prev) => { const next = new URLSearchParams(prev); next.set('path', p); return next; });
  return (
    <div className="flex flex-col gap-4">
      {can('files.manage', account.id) && (
        <FileExplorer accountId={account.id} path={path} onPathChange={go} className="h-[60vh] min-h-[420px]" />
      )}
      <FileAccessPanel accountId={account.id} />
    </div>
  );
}

// ── Sites ───────────────────────────────────────────────────────────────────

function SitesTab({ account }: { account: HostingAccount }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can } = useHostingMe();
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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
  // Created in place (account preset); then the new site, whose back button returns here.
  const createSite = () => setCreating(true);

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
                <SiteStatusBadge status={x.status} message={x.statusMessage} />
                <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-text-muted" />
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-text-muted">{x.slug}</div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-text-muted">
                <BaseBadge base={x.base} compact />
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
            { id: 'base', header: t('accounts.sites.col.base') || 'Base', sort: (x) => x.base, cell: (x) => <BaseBadge base={x.base} compact /> },
            {
              id: 'status', header: t('accounts.sites.col.status') || 'Status', sort: (x) => x.status,
              cell: (x) => <SiteStatusBadge status={x.status} message={x.statusMessage} />,
            },
            { id: 'release', header: t('accounts.sites.col.release') || 'Release', tdClassName: 'font-mono text-xs text-text-secondary', sort: (x) => x.currentReleaseNumber ?? null, cell: (x) => (x.currentReleaseNumber != null ? `#${x.currentReleaseNumber}` : '—') },
            { id: 'domain', header: t('accounts.sites.col.domain') || 'Domain', tdClassName: 'font-mono text-xs text-text-secondary', sort: (x) => x.primaryDomain ?? '', cell: (x) => x.primaryDomain ?? '—' },
          ]}
        />
      )}

      <CreateSiteModal
        open={creating}
        initialAccountId={account.id}
        onClose={() => setCreating(false)}
        onCreated={(site) => { setCreating(false); navigate(siteHref(site.id)); }}
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
