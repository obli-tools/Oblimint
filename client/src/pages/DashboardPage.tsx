import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, ArrowRight, Building2, Users, Server, Mail, Database, Globe, FolderOpen, ChevronRight, BellRing, BarChart3, Bot } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DashboardSummary, HostingAccount, TenantUsage, UsageAlert } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { useHostingMe } from '@/store/hostingStore';
import { dashboardApi } from '@/api/dashboard.api';
import { accountsApi } from '@/api/accounts.api';
import { PageContainer } from '@/components/common/PageContainer';
import { AccountStatusBadge, DiskBar, hostingErrorMessage, useHostingEvents } from '@/components/hosting/hostingUi';
import { usageApi } from '@/api/usage.api';
import { HeroCard, HeroFeatured, MiniStat } from '@/components/usage/HeroCards';
import { HostResources, useHostMetrics } from '@/components/usage/HostResources';
import { DashboardOverviewPanel } from '@/components/dashboard/DashboardOverviewPanel';
import { fillMonthDays, isoMonth, quotaColor, quotaPct } from '@/components/usage/usageFormat';
import { dayLabel, useByteFormat } from '@/components/usage/usageUi';

const MIB = 1024 * 1024;

const EMPTY_SUMMARY: DashboardSummary = {
  accounts: 0, sites: 0, domains: 0, mailboxes: 0, databases: 0, tenants: 0, users: 0, nodes: 0,
};

/** Staff: platform / workspace counters. Client users (kind = client): their own space. */
export function DashboardPage() {
  const isClient = useAuthStore((s) => s.user?.kind === 'client');
  return isClient ? <ClientDashboard /> : <StaffDashboard />;
}

function StaffDashboard() {
  const { t } = useTranslation();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const isMaster = useIsMasterTenant();
  const host = useHostMetrics(isAdmin && isMaster);
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const [summary, setSummary] = useState<DashboardSummary>(EMPTY_SUMMARY);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const s = await dashboardApi.summary();
      setSummary({ ...EMPTY_SUMMARY, ...s });
    } catch {
      // Keep the zeros: the dashboard must render even when the API fails.
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, currentTenantId]);
  useHostingEvents([HostingSocketEvents.HOSTING_CHANGED], () => { void load(); }, undefined, 1000);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 animate-spin text-text-muted" />
      </div>
    );
  }

  const { accounts, sites, domains, mailboxes, databases } = summary;
  const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
  const nowLabel = t('dashboard.now', 'Now');

  return (
    <PageContainer className="flex flex-col gap-5">

      {/* Page header — wraps on narrow screens (actions go to a second line). */}
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">
          {t('dashboard.title', 'Dashboard')}
        </h1>
        <span className="text-xs font-mono tracking-wider text-text-muted">
          {t('dashboard.accountsHosted', { count: accounts, defaultValue: '{{count}} hosting accounts' })}
        </span>
        <div className="ml-auto flex items-center gap-2 max-sm:flex-wrap">
          <button
            onClick={() => { void load(); }}
            className="inline-flex items-center gap-2 h-9 px-3.5 rounded-md bg-bg-hover hover:bg-bg-active text-[13px] font-medium text-text-primary transition-colors whitespace-nowrap coarse:h-10"
          >
            <RefreshCw size={14} />
            {t('common.refresh', 'Refresh')}
          </button>
          <Link
            to="/accounts"
            className="inline-flex items-center gap-2 h-9 px-3.5 rounded-md bg-accent/12 hover:bg-accent/20 text-[13px] font-medium text-accent transition-colors whitespace-nowrap coarse:h-10"
          >
            {t('dashboard.allAccounts', 'View all accounts')}
            <ArrowRight size={14} />
          </Link>
        </div>
      </div>

      {/* Hero row — featured accounts + 4 KPIs. Each card links to its page. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3.5 items-stretch">
        <Link to="/accounts" className="h-full block hover:opacity-95 transition-opacity">
          <HeroFeatured
            label={t('dashboard.accounts', 'Hosting accounts')}
            value={accounts}
            color="text-accent"
            series={[accounts, accounts]}
            days={[{ short: nowLabel, value: accounts }]}
          />
        </Link>
        <Link to="/sites" className="h-full block hover:opacity-95 transition-opacity">
          <HeroCard
            label={t('dashboard.sites', 'Sites')}
            value={sites}
            color="text-green-400"
            deltaText={t('dashboard.perAccount', { value: accounts > 0 ? (sites / accounts).toFixed(1) : '0', defaultValue: '{{value}} per account' })}
            barPct={pct(sites, Math.max(sites, domains))}
            barColor="#1edd8a"
          />
        </Link>
        <Link to="/domains" className="h-full block hover:opacity-95 transition-opacity">
          <HeroCard
            label={t('dashboard.domains', 'Domains')}
            value={domains}
            color="text-text-primary"
            deltaText={t('dashboard.perAccount', { value: accounts > 0 ? (domains / accounts).toFixed(1) : '0', defaultValue: '{{value}} per account' })}
            barPct={pct(domains, Math.max(sites, domains))}
            barColor="rgb(var(--c-text-muted))"
          />
        </Link>
        <Link to="/mail" className="h-full block hover:opacity-95 transition-opacity">
          <HeroCard
            label={t('dashboard.mailboxes', 'Mailboxes')}
            value={mailboxes}
            color="text-amber-400"
            deltaText={t('dashboard.perAccount', { value: accounts > 0 ? (mailboxes / accounts).toFixed(1) : '0', defaultValue: '{{value}} per account' })}
            barPct={pct(mailboxes, Math.max(mailboxes, databases))}
            barColor="#f5a623"
          />
        </Link>
        <Link to="/databases" className="h-full block hover:opacity-95 transition-opacity">
          <HeroCard
            label={t('dashboard.databases', 'Databases')}
            value={databases}
            color="text-accent"
            deltaText={t('dashboard.perAccount', { value: accounts > 0 ? (databases / accounts).toFixed(1) : '0', defaultValue: '{{value}} per account' })}
            barPct={pct(databases, Math.max(mailboxes, databases))}
            barColor="rgb(var(--c-accent))"
          />
        </Link>
      </div>

      {/* Usage row (P2) — traffic of the month, disk, DB instances, open alerts. */}
      <UsageWidgets dbInstances={databases} tenantKey={currentTenantId} platformView={isAdmin && isMaster} hostDiskTotal={host?.disk?.totalBytes ?? null} />

      {/* Server resources (platform admin): CPU, memory, data disk of the node. */}
      {isAdmin && isMaster && <HostResources metrics={host} />}

      {/* Health and activity: what needs attention, sites, publications, monitoring, audit (admins). */}
      <DashboardOverviewPanel tenantKey={currentTenantId} showActivity={isAdmin} />

      {/* Mini-stats row — platform figures (admins). */}
      {isAdmin && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {isMaster && (
            <MiniStat
              icon={<Building2 size={15} />}
              label={t('dashboard.workspaces', 'Workspaces')}
              value={summary.tenants}
              to="/manage/tenants"
            />
          )}
          <MiniStat
            icon={<Users size={15} />}
            label={t('dashboard.users', 'Users')}
            value={summary.users}
            to="/manage/users"
          />
          <MiniStat
            icon={<Server size={15} />}
            label={t('dashboard.nodes', 'Nodes')}
            value={summary.nodes}
            to="/manage/nodes"
          />
          <MiniStat
            icon={<Mail size={15} />}
            label={t('dashboard.mailboxes', 'Mailboxes')}
            value={mailboxes}
            to="/mail"
          />
          <MiniStat
            icon={<Database size={15} />}
            label={t('dashboard.databases', 'Databases')}
            value={databases}
            to="/databases"
          />
        </div>
      )}
    </PageContainer>
  );
}

// ── Client space (users.kind = 'client') ────────────────────────────────────
// No tenant / user / node figures: only the caller's accounts, their sites
// and domains (counted from GET /accounts, which the server scopes to the
// accounts the client belongs to).

function ClientDashboard() {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAccounts(await accountsApi.list());
      setError(null);
    } catch (err) {
      setAccounts([]);
      setError(hostingErrorMessage(t, err, t('clientSpace.loadFailed') || 'Failed to load your accounts'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load, currentTenantId]);
  useHostingEvents([HostingSocketEvents.HOSTING_CHANGED], () => { void load(); }, undefined, 1000);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 animate-spin text-text-muted" />
      </div>
    );
  }

  const sites = accounts.reduce((n, a) => n + a.siteCount, 0);
  const domains = accounts.reduce((n, a) => n + a.domainCount, 0);
  const single = accounts.length === 1 ? accounts[0] : null;

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">
          {t('clientSpace.title') || 'My space'}
        </h1>
        <span className="text-xs font-mono tracking-wider text-text-muted">
          {t('accounts.count', { count: accounts.length, defaultValue: '{{count}} account(s)' })}
        </span>
        <div className="ml-auto flex items-center gap-2 max-sm:flex-wrap">
          <button
            onClick={() => { void load(); }}
            className="inline-flex items-center gap-2 h-9 px-3.5 rounded-md bg-bg-hover hover:bg-bg-active text-[13px] font-medium text-text-primary transition-colors whitespace-nowrap coarse:h-10"
          >
            <RefreshCw size={14} />
            {t('common.refresh') || 'Refresh'}
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-text-muted">{error}</p>}
      <ClientAlertsBanner tenantKey={currentTenantId} />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 items-stretch">
        <Link to={single ? `/accounts/${single.id}` : '/accounts'} className="h-full block hover:opacity-95 transition-opacity">
          <HeroCard label={t('clientSpace.accounts') || 'Hosting accounts'} value={accounts.length} color="text-accent" />
        </Link>
        <Link to="/sites" className="h-full block hover:opacity-95 transition-opacity">
          <HeroCard label={t('clientSpace.sites') || 'Sites'} value={sites} color="text-green-400" />
        </Link>
        <Link to="/domains" className="h-full block hover:opacity-95 transition-opacity">
          <HeroCard label={t('clientSpace.domains') || 'Domains'} value={domains} color="text-text-primary" />
        </Link>
      </div>

      {accounts.length > 0 && <DashboardOverviewPanel tenantKey={currentTenantId} showActivity={false} />}

      {accounts.length === 0 && !error ? (
        <div className="flex flex-col items-center gap-2 rounded-xl bg-bg-secondary py-12 text-text-muted">
          <Server size={24} className="opacity-40" />
          <p className="text-sm">{t('clientSpace.noAccount') || 'No hosting account is linked to your login yet.'}</p>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted">{t('clientSpace.myAccounts') || 'My accounts'}</div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {accounts.map((a) => (
              <div key={a.id} className="rounded-xl bg-bg-secondary p-4 shadow-[0_1px_0_0_rgba(255,255,255,0.03),_0_6px_24px_-8px_rgba(0,0,0,0.45)]">
                <Link to={`/accounts/${a.id}`} className="flex items-center gap-2 group">
                  <span className="font-mono text-sm font-semibold text-text-primary group-hover:text-accent truncate">{a.username}</span>
                  <AccountStatusBadge status={a.status} message={a.statusMessage} />
                  <ChevronRight size={16} className="ml-auto text-text-muted shrink-0" />
                </Link>
                {(a.displayName || a.planName) && (
                  <div className="mt-0.5 text-xs text-text-muted truncate">{[a.displayName, a.planName].filter(Boolean).join(' · ')}</div>
                )}
                <div className="mt-3"><DiskBar usedMb={a.diskUsedMb} quotaMb={a.diskQuotaMb} mode={a.quotaMode} /></div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <MiniStat icon={<Server size={15} />} label={t('clientSpace.sites') || 'Sites'} value={a.siteCount} to={`/accounts/${a.id}?tab=sites`} />
                  <MiniStat icon={<Globe size={15} />} label={t('clientSpace.domains') || 'Domains'} value={a.domainCount} to={`/accounts/${a.id}?tab=domains`} />
                  <MiniStat icon={<FolderOpen size={15} />} label={t('clientSpace.files') || 'Files'} value={t('clientSpace.sftp') || 'SFTP'} to={`/accounts/${a.id}?tab=files`} />
                </div>
                {/* No site yet: an AI agent can build it (opens the account's key form, agent preset). */}
                {a.siteCount === 0 && a.status === 'active' && can('sites.manage', a.id) && (
                  <Link
                    to={`/accounts/${a.id}?agent=1`}
                    className="mt-3 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-accent hover:bg-accent/10"
                  >
                    <Bot size={14} className="shrink-0" />
                    <span>{t('agentConnect.dashboardCta') || 'No site yet: connect an AI agent to build and publish it'}</span>
                    <ChevronRight size={14} className="ml-auto shrink-0" />
                  </Link>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </PageContainer>
  );
}

// ── Usage widgets (P2) ──────────────────────────────────────────────────────
// Their own requests: a usage endpoint that fails (module not deployed,
// no right) leaves dashes, never breaks the P0/P1 counters above.

/** What the widgets show: one workspace (TenantUsage) or, in the god view, the whole platform. */
type UsageSummary = Pick<TenantUsage, 'month' | 'traffic' | 'envelope'> & { totals: Pick<TenantUsage['totals'], 'trafficBytes' | 'diskUsedBytes' | 'dbInstances'> };

function UsageWidgets({ dbInstances, tenantKey, platformView, hostDiskTotal }: { dbInstances: number; tenantKey: number | null; platformView: boolean; hostDiskTotal: number | null }) {
  const { t } = useTranslation();
  const bytes = useByteFormat();
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [alerts, setAlerts] = useState<UsageAlert[] | null>(null);

  const load = useCallback(async () => {
    // God view (platform admin on the master tenant): platform totals, like the P1 counters
    // around them and the alerts of every workspace — not the master workspace alone.
    const summary: Promise<UsageSummary> = platformView
      ? usageApi.platform().then((p) => ({ month: p.month, traffic: p.traffic, totals: p.totals, envelope: { trafficMbPerMonth: null, diskMb: null } }))
      : usageApi.tenant();
    const [u, a] = await Promise.allSettled([summary, usageApi.alerts({ open: true })]);
    setUsage(u.status === 'fulfilled' ? u.value : null);
    setAlerts(a.status === 'fulfilled' ? a.value : null);
  }, [platformView]);

  useEffect(() => { void load(); }, [load, tenantKey]);
  useHostingEvents([HostingSocketEvents.USAGE_ALERT], () => { void load(); }, undefined, 1500);

  const month = usage?.month ?? isoMonth();
  const days = usage ? fillMonthDays(month, usage.traffic, (p) => p.bytesOut) : [];
  // God view: the sites' disk against the whole data disk of the node.
  const diskEnvelope = usage?.envelope.diskMb != null ? usage.envelope.diskMb * MIB : platformView ? hostDiskTotal : null;
  const diskPct = usage ? quotaPct(usage.totals.diskUsedBytes, diskEnvelope) : null;
  const trafficEnvelope = usage?.envelope.trafficMbPerMonth != null ? usage.envelope.trafficMbPerMonth * MIB : null;
  const trafficPct = usage ? quotaPct(usage.totals.trafficBytes, trafficEnvelope) : null;
  const critical = (alerts ?? []).filter((a) => a.level >= 100).length;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 items-stretch">
      <Link to="/usage" className="h-full block hover:opacity-95 transition-opacity">
        <HeroFeatured
          label={t('usage.hero.traffic') || 'Traffic of the month'}
          value={usage ? bytes(usage.totals.trafficBytes) : '—'}
          color="text-accent"
          sub={trafficEnvelope != null ? t('usage.hero.ofEnvelope', { value: bytes(trafficEnvelope), pct: Math.round(trafficPct ?? 0), defaultValue: '{{pct}} % of {{value}}' }) : undefined}
          series={days.map((d) => d.value)}
          days={days.slice(-4).map((d) => ({ short: dayLabel(d.day), value: bytes(d.value) }))}
        />
      </Link>
      <Link to="/usage" className="h-full block hover:opacity-95 transition-opacity">
        <HeroCard
          label={t('usage.hero.disk') || 'Disk used'}
          value={usage ? bytes(usage.totals.diskUsedBytes) : '—'}
          color="text-green-400"
          deltaText={usage ? (diskEnvelope != null
            ? t('usage.hero.ofEnvelope', { value: bytes(diskEnvelope), pct: Math.round(diskPct ?? 0), defaultValue: '{{pct}} % of {{value}}' })
            : platformView ? (t('usage.hero.platformTotal') || 'all workspaces') : (t('usage.hero.noEnvelope') || 'no workspace envelope')) : undefined}
          barPct={diskPct}
          barColor={quotaColor(diskPct)}
        />
      </Link>
      <Link to="/databases" className="h-full block hover:opacity-95 transition-opacity">
        <HeroCard label={t('usage.hero.dbInstances') || 'DB instances'} value={usage?.totals.dbInstances ?? dbInstances} color="text-amber-400" />
      </Link>
      <Link to="/usage" className="h-full block hover:opacity-95 transition-opacity">
        <HeroCard
          label={t('usage.hero.alerts') || 'Open alerts'}
          value={alerts ? alerts.length : '—'}
          color={critical > 0 ? 'text-status-down' : alerts && alerts.length > 0 ? 'text-amber-400' : 'text-text-primary'}
          deltaText={alerts ? t('usage.hero.alertsCritical', { count: critical, defaultValue: '{{count}} at 100 %' }) : undefined}
        />
      </Link>
    </div>
  );
}

/** Client space: open quota alerts of the caller's accounts, with a link to the usage page. */
function ClientAlertsBanner({ tenantKey }: { tenantKey: number | null }) {
  const { t } = useTranslation();
  const [alerts, setAlerts] = useState<UsageAlert[]>([]);
  const load = useCallback(async () => {
    try { setAlerts(await usageApi.alerts({ open: true })); } catch { setAlerts([]); }
  }, []);
  useEffect(() => { void load(); }, [load, tenantKey]);
  useHostingEvents([HostingSocketEvents.USAGE_ALERT], () => { void load(); }, undefined, 1500);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <MiniStat icon={<BarChart3 size={15} />} label={t('nav.usage') || 'Usage'} value={t('usage.hero.seeUsage') || 'Traffic, disk, resources'} to="/usage" />
      <MiniStat
        icon={<BellRing size={15} />}
        label={t('usage.hero.alerts') || 'Open alerts'}
        value={alerts.length}
        color={alerts.some((a) => a.level >= 100) ? 'text-status-down' : alerts.length > 0 ? 'text-amber-400' : 'text-text-primary'}
        to="/usage"
      />
    </div>
  );
}
