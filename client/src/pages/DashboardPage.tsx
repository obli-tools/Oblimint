import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, ArrowRight, Building2, Users, Server, Mail, Database } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DashboardSummary } from '@oblimint/shared';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { dashboardApi } from '@/api/dashboard.api';
import { PageContainer } from '@/components/common/PageContainer';

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

export function DashboardPage() {
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
