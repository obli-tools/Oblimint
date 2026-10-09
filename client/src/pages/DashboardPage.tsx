import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, ArrowRight, Building2, Users, Server, Mail, Database, Globe, FolderOpen, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DashboardSummary, HostingAccount } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { dashboardApi } from '@/api/dashboard.api';
import { accountsApi } from '@/api/accounts.api';
import { PageContainer } from '@/components/common/PageContainer';
import { AccountStatusBadge, DiskBar, hostingErrorMessage, useHostingEvents } from '@/components/hosting/hostingUi';

// ── Sparkline (filled area + line) — ported from Obliance ───────────────────

function Sparkline({ data, color, height = 36 }: { data: number[]; color: string; height?: number }) {
  if (data.length < 2) return <div style={{ height }} />;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const w = 200;
  const h = height;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return [x, y];
  });
  const linePath = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${w},${h} L0,${h} Z`;
  const id = `sg-${color.replace(/[^a-z0-9]/gi, '')}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height }} className="block">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.40" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${id})`} />
      <path d={linePath} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

// ── Hero KPI card (featured: with spark + axis) — ported from Obliance ──────

function HeroFeatured({ label, value, color, series, days }: {
  label: string; value: number; color: string;
  series: number[]; days: { short: string; value: number }[];
}) {
  return (
    <div className="h-full flex flex-col rounded-xl p-5 relative overflow-hidden bg-gradient-to-br from-accent/10 via-bg-secondary to-bg-secondary shadow-[0_0_0_1px_rgb(var(--c-accent)/0.18)_inset,_0_6px_28px_-10px_rgb(var(--c-accent)/0.25)]">
      <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted mb-3">{label}</div>
      <div className={`font-display text-[48px] font-semibold leading-none ${color}`}>{value}</div>
      <div className="mt-3"><Sparkline data={series} color="#ff6868" /></div>
      <div className="grid grid-cols-4 mt-2 gap-2">
        {days.map((d, i) => {
          const isLast = i === days.length - 1;
          return (
            <div key={i} className={`flex flex-col items-start ${isLast ? 'text-text-primary' : 'text-text-muted'}`}>
              <span className="text-[10px] font-mono uppercase tracking-wider">{d.short}</span>
              <span className={`text-[12px] font-mono ${isLast ? 'text-text-primary font-semibold' : 'text-text-secondary'}`}>{d.value}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HeroCard({ label, value, color, deltaText, barPct, barColor }: {
  label: string; value: number; color: string;
  deltaText?: string;
  barPct?: number;
  barColor?: string;
}) {
  return (
    <div className="h-full flex flex-col rounded-xl p-5 relative overflow-hidden bg-bg-secondary shadow-[0_1px_0_0_rgba(255,255,255,0.03),_0_6px_24px_-8px_rgba(0,0,0,0.45)]">
      <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted mb-3">{label}</div>
      <div className={`font-display text-[36px] font-semibold leading-none ${color}`}>{value}</div>
      {deltaText && (
        <div className="text-[12px] font-mono mt-3 text-text-muted">
          <span className="mr-1">—</span>{deltaText}
        </div>
      )}
      {barPct != null && (
        <div className="mt-2 h-1 w-full bg-white/[0.04] rounded">
          <div className="h-full rounded" style={{ width: `${Math.min(100, Math.max(0, barPct))}%`, background: barColor ?? 'rgb(var(--c-accent))' }} />
        </div>
      )}
    </div>
  );
}

// ── Mini-stat compact card — ported from Obliance ───────────────────────────

function MiniStat({ icon, label, value, sub, color = 'text-text-primary', to }: {
  icon: React.ReactNode; label: string; value: React.ReactNode; sub?: string;
  color?: string; to?: string;
}) {
  const body = (
    <div className="flex items-center gap-3 rounded-lg bg-bg-secondary px-3.5 py-2.5 shadow-[0_1px_0_0_rgba(255,255,255,0.03),_0_4px_16px_-8px_rgba(0,0,0,0.35)]">
      <div className="w-8 h-8 rounded-md bg-bg-hover flex items-center justify-center shrink-0 text-text-muted">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted truncate">{label}</div>
        <div className={`text-[14px] font-semibold leading-tight ${color} truncate`}>{value}</div>
        {sub && <div className="text-[10px] font-mono text-text-muted truncate">{sub}</div>}
      </div>
    </div>
  );
  return to ? <Link to={to} className="block hover:opacity-90 transition-opacity">{body}</Link> : body;
}

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
              </div>
            ))}
          </div>
        </div>
      )}
    </PageContainer>
  );
}
