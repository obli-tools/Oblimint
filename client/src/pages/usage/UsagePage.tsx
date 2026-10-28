import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Activity, AlertTriangle, BarChart3, BellRing, Building2, ChevronRight, Cpu, Database, HardDrive, MemoryStick, RefreshCw, Server, Users,
} from 'lucide-react';
import type { AccountUsage, HostingAccount, PlatformUsage, TenantUsage, UsageAlert } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { usageApi } from '@/api/usage.api';
import { accountsApi } from '@/api/accounts.api';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { PageContainer } from '@/components/common/PageContainer';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { GroupedTable, flatNodes } from '@/components/common/GroupedTable';
import { useAccountDirectory } from '@/components/common/accountGroups';
import { AccountScopeBar, useAccountScope } from '@/components/common/AccountScope';
import { TenantBadge } from '@/components/common/TenantBadge';
import { AccountStatusBadge, Card, EmptyState, headerBtnCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { BarChart, ChartLegend, LineChart, Sparkline } from '@/components/usage/UsageCharts';
import { HeroCard, HeroFeatured, MiniStat } from '@/components/usage/HeroCards';
import { opsErrorMessage } from '@/components/usage/opsErrors';
import { AccountUsageTab } from '@/components/usage/AccountUsageTab';
import { accountHref } from '@/utils/links';
import { fillMonthDays, formatCount, isoMonth, quotaColor, quotaPct, sumBy } from '@/components/usage/usageFormat';
import {
  MonthPicker, OverQuotaBanner, OverQuotaPill, QuotaLine, UsageAlertsList, dayLabel, hourLabel, monthLabel, resourceSeries, useByteFormat,
} from '@/components/usage/usageUi';

const MIB = 1024 * 1024;

type Loaded<T> = { data: T; error: null } | { data: null; error: string };

/** Consumption: staff → workspace (+ platform for admins); client users → their own accounts. */
export function UsagePage() {
  const isClient = useAuthStore((s) => s.user?.kind === 'client');
  return isClient ? <ClientUsage /> : <StaffUsage />;
}

function PageHeader({ subtitle, actions }: { subtitle?: string; actions?: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
      <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('nav.usage') || 'Usage'}</h1>
      {subtitle && <span className="text-xs font-mono tracking-wider text-text-muted">{subtitle}</span>}
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// ── Staff ───────────────────────────────────────────────────────────────────

function StaffUsage() {
  const { t, i18n } = useTranslation();
  const bytes = useByteFormat();
  const isMaster = useIsMasterTenant();
  // GET /usage/platform: platform admin in the god view (master tenant).
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin') && isMaster;
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  // Account scope of the cross-account pages; the workspace chips keep their ?tenant= key.
  // God view: one workspace at a time (the endpoint takes a single tenantId).
  const scope = useAccountScope({ tenantParam: 'tenant' });
  const { tenantId } = scope;
  const [month, setMonth] = useState(() => isoMonth());
  const [usage, setUsage] = useState<Loaded<TenantUsage> | null>(null);
  const [alerts, setAlerts] = useState<UsageAlert[]>([]);
  const [platform, setPlatform] = useState<Loaded<PlatformUsage> | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const id = ++seq.current;
    const [u, a, p] = await Promise.allSettled([
      usageApi.tenant({ tenantId, month }),
      usageApi.alerts({ open: true }),
      isAdmin ? usageApi.platform(month) : Promise.resolve(null),
    ]);
    if (id !== seq.current) return;
    setUsage(u.status === 'fulfilled' ? { data: u.value, error: null } : { data: null, error: opsErrorMessage(t, u.reason, 'usage', t('usage.loadFailed') || 'Failed to load the usage') });
    setAlerts(a.status === 'fulfilled' ? a.value : []);
    if (isAdmin) {
      setPlatform(p.status === 'fulfilled' && p.value ? { data: p.value, error: null } : { data: null, error: opsErrorMessage(t, p.status === 'rejected' ? p.reason : null, 'usage', t('usage.platform.loadFailed') || 'Failed to load the platform usage') });
    }
  }, [tenantId, month, isAdmin, t]);

  useEffect(() => { void load(); }, [load, currentTenantId]);
  useHostingEvents([HostingSocketEvents.USAGE_ALERT], () => { void load(); }, undefined, 1500);

  const data = usage?.data ?? null;
  // The tenant section always covers ONE workspace (the chip, else the server falls back to the
  // current one): its alerts must match, never the alerts of every workspace.
  const shownTenantId = data?.tenantId ?? tenantId;
  const shownAlerts = isMaster && shownTenantId != null ? alerts.filter((a) => a.tenantId === shownTenantId) : alerts;
  const accountNames = useMemo(() => new Map((data?.topAccounts ?? []).map((r) => [r.accountId, r.username])), [data]);

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageHeader
        subtitle={monthLabel(month, i18n.language)}
        actions={
          <>
            <MonthPicker value={month} onChange={setMonth} />
            <button onClick={() => { void load(); }} className={headerBtnCls}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
          </>
        }
      />
      <AccountScopeBar scope={scope}>
        {scope.accountParam != null && (
          <Link to={accountHref(scope.accountParam, 'usage')} className="text-xs text-accent hover:underline">{t('usage.page.openAccount') || 'Open the account'}</Link>
        )}
      </AccountScopeBar>
      {scope.accountParam != null ? (
        // One account chosen: its own consumption (the same view as its account page).
        <AccountUsageTab key={scope.accountParam} accountId={scope.accountParam} />
      ) : (<>
      {isMaster && tenantId == null && data && (
        <p className="-mt-2 flex flex-wrap items-center gap-2 text-xs text-text-muted">
          {t('usage.page.oneWorkspace') || 'Workspace shown:'}
          <TenantBadge tenantId={data.tenantId} />
          <span>{isAdmin
            ? (t('usage.page.oneWorkspaceHintAdmin') || 'pick a chip for another workspace; the platform totals are below.')
            : (t('usage.page.oneWorkspaceHint') || 'pick a chip for another workspace.')}</span>
        </p>
      )}

      {usage === null ? (
        <div className="flex justify-center py-12"><LoadingSpinner /></div>
      ) : data === null ? (
        <EmptyState icon={<AlertTriangle />} text={usage.error} />
      ) : (
        <TenantSection usage={data} month={month} />
      )}

      {data && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <TopAccounts usage={data} />
          <Card title={t('usage.alerts.title') || 'Open alerts'} icon={<BellRing size={14} className="text-accent" />}>
            <UsageAlertsList alerts={shownAlerts} accountNames={accountNames} accountLink />
          </Card>
        </div>
      )}

      {isAdmin && (
        <>
          <h2 className="mt-2 font-display text-lg font-semibold tracking-wide text-text-primary">{t('usage.platform.title') || 'Platform'}</h2>
          {platform === null ? (
            <div className="flex justify-center py-8"><LoadingSpinner /></div>
          ) : platform.data === null ? (
            <EmptyState icon={<AlertTriangle />} text={platform.error} />
          ) : (
            <PlatformSection usage={platform.data} bytes={bytes} />
          )}
        </>
      )}
      </>)}
    </PageContainer>
  );
}

function TenantSection({ usage, month }: { usage: TenantUsage; month: string }) {
  const { t, i18n } = useTranslation();
  const bytes = useByteFormat();
  const days = fillMonthDays(month, usage.traffic, (p) => p.bytesOut);
  const last = days.slice(-4);
  const trafficEnvelope = usage.envelope.trafficMbPerMonth != null ? usage.envelope.trafficMbPerMonth * MIB : null;
  const diskEnvelope = usage.envelope.diskMb != null ? usage.envelope.diskMb * MIB : null;
  const trafficPct = quotaPct(usage.totals.trafficBytes, trafficEnvelope);
  const diskPct = quotaPct(usage.totals.diskUsedBytes, diskEnvelope);
  const requests = sumBy(usage.traffic, (p) => p.requests);

  return (
    <>
      <div className="grid grid-cols-1 items-stretch gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <HeroFeatured
          label={t('usage.hero.traffic') || 'Traffic of the month'}
          value={bytes(usage.totals.trafficBytes)}
          color="text-accent"
          sub={trafficEnvelope != null
            ? t('usage.hero.ofEnvelope', { value: bytes(trafficEnvelope), pct: Math.round(trafficPct ?? 0), defaultValue: '{{pct}} % of {{value}}' })
            : t('usage.traffic.requests', { value: formatCount(requests), defaultValue: '{{value}} requests' })}
          series={days.map((d) => d.value)}
          days={last.map((d) => ({ short: dayLabel(d.day), value: bytes(d.value) }))}
        />
        <HeroCard
          label={t('usage.hero.disk') || 'Disk used'}
          value={bytes(usage.totals.diskUsedBytes)}
          color="text-green-400"
          deltaText={diskEnvelope != null
            ? t('usage.hero.ofEnvelope', { value: bytes(diskEnvelope), pct: Math.round(diskPct ?? 0), defaultValue: '{{pct}} % of {{value}}' })
            : (t('usage.hero.noEnvelope') || 'no workspace envelope')}
          barPct={diskPct}
          barColor={quotaColor(diskPct)}
        />
        <Link to="/accounts" className="block h-full transition-opacity hover:opacity-95">
          <HeroCard
            label={t('usage.hero.accounts') || 'Hosting accounts'}
            value={usage.totals.accounts}
            color="text-text-primary"
            deltaText={t('usage.hero.sites', { count: usage.totals.sites, defaultValue: '{{count}} sites' })}
          />
        </Link>
        <Link to="/databases" className="block h-full transition-opacity hover:opacity-95">
          <HeroCard label={t('usage.hero.dbInstances') || 'DB instances'} value={usage.totals.dbInstances} color="text-amber-400" />
        </Link>
      </div>

      <Card
        title={t('usage.traffic.dailyTitle', { month: monthLabel(month, i18n.language), defaultValue: 'Traffic of {{month}}' })}
        icon={<BarChart3 size={14} className="text-accent" />}
      >
        <BarChart
          data={days.map((d) => ({ label: dayLabel(d.day), value: d.value, title: `${new Date(`${d.day}T00:00:00Z`).toLocaleDateString(i18n.language, { timeZone: 'UTC' })} · ${bytes(d.value)}` }))}
          formatValue={(v) => bytes(v)}
          emptyText={t('usage.traffic.none') || 'No traffic this month.'}
        />
      </Card>
    </>
  );
}

type TopAccount = TenantUsage['topAccounts'][number];
type TenantRow = PlatformUsage['tenants'][number];

function TopAccounts({ usage }: { usage: TenantUsage }) {
  const { t } = useTranslation();
  const isMaster = useIsMasterTenant();
  const accountDir = useAccountDirectory();
  const rows = usage.topAccounts;
  return (
    <Card title={t('usage.top.title') || 'Top accounts'} icon={<Users size={14} className="text-accent" />}>
      {rows.length === 0 ? (
        <p className="py-3 text-center text-xs text-text-muted">{t('usage.top.empty') || 'No account yet.'}</p>
      ) : (
        <>
          <GroupedTable<TopAccount>
            storageKey="usage-top"
            singleGroupFlat
            className=""
            minWidth={640}
            defaultSort={{ column: 'traffic', dir: 'desc' }}
            groups={[{ key: 'all', label: '', sortLabel: '', nodes: flatNodes(rows, (r) => r.accountId) }]}
            renderCard={(r) => (
              <Link to={`/accounts/${r.accountId}?tab=usage`} className="block rounded-lg bg-bg-primary px-3 py-2.5 hover:bg-bg-hover">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-sm font-semibold text-text-primary">{accountDir.get(r.accountId)?.primaryDomain || r.username}</span>
                  <OverQuotaPill state={r.overQuota} />
                  <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-text-muted" />
                </div>
                <div className="mt-2 space-y-2">
                  <QuotaLine dimension="traffic" used={r.trafficBytes} limit={r.trafficQuotaBytes} />
                  <QuotaLine dimension="disk" used={r.diskUsedBytes} limit={r.diskQuotaBytes} />
                </div>
              </Link>
            )}
            columns={[
              {
                id: 'account', header: t('usage.top.account') || 'Account', sort: (r) => accountDir.get(r.accountId)?.primaryDomain || r.username,
                cell: (r) => {
                  const domain = accountDir.get(r.accountId)?.primaryDomain;
                  return (
                    <div className="flex items-center gap-2">
                      <div className="min-w-0">
                        <Link to={`/accounts/${r.accountId}?tab=usage`} className="font-mono font-medium text-text-primary hover:text-accent">{domain || r.username}</Link>
                        {domain && domain !== r.username && <div className="font-mono text-[11px] text-text-muted">{r.username}</div>}
                      </div>
                      {isMaster && <TenantBadge tenantId={r.tenantId} />}
                    </div>
                  );
                },
              },
              { id: 'traffic', header: t('usage.dimension.traffic') || 'Traffic', tdClassName: 'w-[30%]', sort: (r) => r.trafficBytes, cell: (r) => <QuotaLine dimension="traffic" used={r.trafficBytes} limit={r.trafficQuotaBytes} /> },
              { id: 'disk', header: t('usage.dimension.disk') || 'Disk', tdClassName: 'w-[30%]', sort: (r) => r.diskUsedBytes, cell: (r) => <QuotaLine dimension="disk" used={r.diskUsedBytes} limit={r.diskQuotaBytes} /> },
              {
                id: 'state', header: t('usage.top.state') || 'State', sort: (r) => (r.overQuota === 'ok' ? '' : r.overQuota),
                cell: (r) => (r.overQuota === 'ok' ? <span className="text-xs text-text-muted">—</span> : <OverQuotaPill state={r.overQuota} />),
              },
            ]}
          />
        </>
      )}
    </Card>
  );
}

function PlatformSection({ usage, bytes }: { usage: PlatformUsage; bytes: (n: number | null | undefined) => string }) {
  const { t, i18n } = useTranslation();
  const res = resourceSeries(usage.resources);
  const labels = usage.resources.map((p) => hourLabel(p.at, i18n.language));
  const tenants = [...usage.tenants].sort((a, b) => b.trafficBytes - a.trafficBytes);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <MiniStat icon={<BarChart3 size={15} />} label={t('usage.hero.traffic') || 'Traffic of the month'} value={bytes(usage.totals.trafficBytes)} />
        <MiniStat icon={<HardDrive size={15} />} label={t('usage.hero.disk') || 'Disk used'} value={bytes(usage.totals.diskUsedBytes)} />
        <MiniStat icon={<Building2 size={15} />} label={t('usage.platform.tenants') || 'Workspaces'} value={usage.totals.tenants} to="/manage/tenants" />
        <MiniStat icon={<Users size={15} />} label={t('usage.hero.accounts') || 'Hosting accounts'} value={usage.totals.accounts} to="/accounts" />
        <MiniStat icon={<Server size={15} />} label={t('usage.platform.sites') || 'Sites'} value={usage.totals.sites} to="/sites" />
        <MiniStat icon={<Database size={15} />} label={t('usage.hero.dbInstances') || 'DB instances'} value={usage.totals.dbInstances} to="/databases" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title={t('usage.platform.perTenant') || 'Per workspace'} icon={<Building2 size={14} className="text-accent" />}>
          {tenants.length === 0 ? (
            <p className="py-3 text-center text-xs text-text-muted">{t('usage.top.empty') || 'No account yet.'}</p>
          ) : (
            <GroupedTable<TenantRow>
              storageKey="usage-tenants"
              singleGroupFlat
              className=""
              minWidth={420}
              defaultSort={{ column: 'traffic', dir: 'desc' }}
              groups={[{ key: 'all', label: '', sortLabel: '', nodes: flatNodes(tenants, (r) => r.tenantId) }]}
              columns={[
                { id: 'tenant', header: t('usage.platform.tenant') || 'Workspace', sort: (r) => r.name, cell: (r) => <TenantBadge tenantId={r.tenantId} tenantName={r.name} size="md" /> },
                { id: 'traffic', header: t('usage.dimension.traffic') || 'Traffic', thClassName: 'text-right', tdClassName: 'text-right font-mono text-xs text-text-secondary', sort: (r) => r.trafficBytes, cell: (r) => bytes(r.trafficBytes) },
                { id: 'disk', header: t('usage.dimension.disk') || 'Disk', thClassName: 'text-right', tdClassName: 'text-right font-mono text-xs text-text-secondary', sort: (r) => r.diskUsedBytes, cell: (r) => bytes(r.diskUsedBytes) },
                { id: 'accounts', header: t('usage.platform.accounts') || 'Accounts', thClassName: 'text-right', tdClassName: 'text-right font-mono text-xs text-text-secondary', sort: (r) => r.accounts, cell: (r) => r.accounts },
              ]}
            />
          )}
        </Card>

        <Card title={t('usage.platform.resources') || 'Host resources (last 24 h)'} icon={<Activity size={14} className="text-accent" />}>
          <div className="space-y-4">
            <div>
              <div className="mb-1 flex items-center gap-2 text-xs text-text-secondary"><Cpu size={12} />{t('usage.resources.cpu') || 'CPU'}</div>
              <LineChart series={[{ key: 'cpu', label: 'CPU', color: '#36B98F', values: res.cpu, area: true }]} labels={labels} height={150} formatValue={(v) => `${Math.round(v)} %`} emptyText={t('usage.resources.none') || 'No sample yet.'} />
            </div>
            <div>
              <div className="mb-1 flex items-center gap-2 text-xs text-text-secondary"><MemoryStick size={12} />{t('usage.resources.memory') || 'Memory'}</div>
              <LineChart series={[{ key: 'mem', label: 'RAM', color: '#38bdf8', values: res.mem, area: true }]} labels={labels} height={150} formatValue={(v) => bytes(v)} emptyText={t('usage.resources.none') || 'No sample yet.'} />
            </div>
            <ChartLegend items={[{ label: t('usage.resources.cpuLegend') || 'CPU (% of one core)', color: '#36B98F' }, { label: t('usage.resources.memLegend') || 'Memory (without cache)', color: '#38bdf8' }]} />
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── Client users ────────────────────────────────────────────────────────────

function ClientUsage() {
  const { t } = useTranslation();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const [accounts, setAccounts] = useState<HostingAccount[] | null>(null);
  const [usage, setUsage] = useState<Record<number, Loaded<AccountUsage>>>({});
  const [alerts, setAlerts] = useState<UsageAlert[]>([]);
  const [error, setError] = useState<string | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const id = ++seq.current;
    try {
      const list = await accountsApi.list();
      if (id !== seq.current) return;
      setAccounts(list);
      setError(null);
      const [results, a] = await Promise.all([
        Promise.allSettled(list.map((acc) => usageApi.account(acc.id))),
        usageApi.alerts({ open: true }).catch(() => [] as UsageAlert[]),
      ]);
      if (id !== seq.current) return;
      const next: Record<number, Loaded<AccountUsage>> = {};
      results.forEach((r, i) => {
        next[list[i].id] = r.status === 'fulfilled' ? { data: r.value, error: null } : { data: null, error: opsErrorMessage(t, r.reason, 'usage', t('usage.loadFailed') || 'Failed to load the usage') };
      });
      setUsage(next);
      setAlerts(a);
    } catch (err) {
      if (id !== seq.current) return;
      setAccounts([]);
      setError(opsErrorMessage(t, err, 'usage', t('clientSpace.loadFailed') || 'Failed to load your accounts'));
    }
  }, [t]);

  useEffect(() => { void load(); }, [load, currentTenantId]);
  useHostingEvents([HostingSocketEvents.USAGE_ALERT], () => { void load(); }, undefined, 1500);

  const names = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a.username])), [accounts]);

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageHeader actions={<button onClick={() => { void load(); }} className={headerBtnCls}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>} />
      <p className="-mt-2 text-sm text-text-muted">{t('usage.page.subtitle') || 'Traffic, disk and resources of the accounts.'}</p>
      {accounts === null ? (
        <div className="flex justify-center py-12"><LoadingSpinner /></div>
      ) : error ? (
        <EmptyState icon={<AlertTriangle />} text={error} />
      ) : accounts.length === 0 ? (
        <EmptyState icon={<Server />} text={t('clientSpace.noAccount') || 'No hosting account is linked to your login yet.'} />
      ) : (
        <>
          {alerts.length > 0 && (
            <Card title={t('usage.alerts.title') || 'Open alerts'} icon={<BellRing size={14} className="text-accent" />}>
              <UsageAlertsList alerts={alerts} accountNames={names} accountLink />
            </Card>
          )}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {accounts.map((a) => <ClientAccountCard key={a.id} account={a} usage={usage[a.id] ?? null} />)}
          </div>
        </>
      )}
    </PageContainer>
  );
}

function ClientAccountCard({ account, usage }: { account: HostingAccount; usage: Loaded<AccountUsage> | null }) {
  const { t } = useTranslation();
  const bytes = useByteFormat();
  const data = usage?.data ?? null;
  const traffic = data ? fillMonthDays(data.month, data.traffic, (p) => p.bytesOut) : [];
  return (
    <div className="rounded-xl bg-bg-secondary p-4 shadow-[0_1px_0_0_rgba(255,255,255,0.03),_0_6px_24px_-8px_rgba(0,0,0,0.45)]">
      <Link to={`/accounts/${account.id}?tab=usage`} className="group flex items-center gap-2">
        <span className="truncate font-mono text-sm font-semibold text-text-primary group-hover:text-accent">{account.username}</span>
        <AccountStatusBadge status={account.status} message={account.statusMessage} />
        <OverQuotaPill state={account.overQuota} />
        <ChevronRight size={16} className="ml-auto shrink-0 text-text-muted" />
      </Link>
      {account.planName && <div className="mt-0.5 truncate text-xs text-text-muted">{account.planName}</div>}
      {usage === null ? (
        <div className="flex justify-center py-6"><LoadingSpinner /></div>
      ) : data === null ? (
        <p className="mt-3 text-xs text-text-muted">{usage.error}</p>
      ) : (
        <div className="mt-3 space-y-3">
          {account.status !== 'suspended' && <OverQuotaBanner state={data.overQuota} />}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {data.gauges.map((g) => <QuotaLine key={g.dimension} dimension={g.dimension} used={g.used} limit={g.limit} />)}
          </div>
          <div>
            <div className="mb-1 flex items-center gap-2 text-[11px] font-mono text-text-muted">
              <BarChart3 size={11} />{t('usage.hero.traffic') || 'Traffic of the month'}
              <span className="ml-auto text-text-secondary">{bytes(sumBy(data.traffic, (p) => p.bytesOut))}</span>
            </div>
            <Sparkline data={traffic.map((d) => d.value)} color="#98E8C8" height={40} />
          </div>
        </div>
      )}
    </div>
  );
}
