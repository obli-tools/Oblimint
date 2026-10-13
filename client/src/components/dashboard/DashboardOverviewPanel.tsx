import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Activity, AlertTriangle, CheckCircle2, ClipboardCheck, FileWarning, Globe, History, Lock, Rocket, ShieldAlert, Wrench,
} from 'lucide-react';
import type { DashboardOverview } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { dashboardApi } from '@/api/dashboard.api';
import { Card, Pill, useHostingEvents } from '@/components/hosting/hostingUi';
import { ago } from '@/components/apps/appsFormat';
import { cn } from '@/utils/cn';

// Health and activity of the dashboard (staff and client space): what needs
// attention, the state of the sites, the latest publications, monitoring and
// certificates, and (staff) the latest audit events. Every figure comes from
// GET /api/dashboard/overview, scoped server side to what the caller may see.

const RELEASE_TONE: Record<string, 'green' | 'amber' | 'red' | 'blue' | 'muted'> = {
  ready: 'green', awaiting_approval: 'amber', failed: 'red', rejected: 'red', publishing: 'blue', scanning: 'blue', queued: 'muted',
};

function Attention({ icon, label, count, to, tone }: { icon: ReactNode; label: string; count: number; to: string; tone: 'red' | 'amber' }) {
  return (
    <Link to={to} className={cn(
      'flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
      tone === 'red' ? 'bg-status-down/10 text-status-down hover:bg-status-down/15' : 'bg-amber-400/10 text-amber-400 hover:bg-amber-400/15',
    )}>
      {icon}
      <span className="font-display text-lg font-semibold leading-none">{count}</span>
      <span className="text-[13px]">{label}</span>
    </Link>
  );
}

export function DashboardOverviewPanel({ tenantKey, showActivity }: { tenantKey: number | null; showActivity: boolean }) {
  const { t } = useTranslation();
  const [o, setO] = useState<DashboardOverview | null>(null);

  const load = useCallback(async () => {
    try { setO(await dashboardApi.overview()); } catch { /* optional block: hidden on failure */ }
  }, []);
  useEffect(() => { void load(); }, [load, tenantKey]);
  useHostingEvents([HostingSocketEvents.HOSTING_CHANGED], () => { void load(); }, undefined, 2000);
  useEffect(() => {
    const id = setInterval(() => { void load(); }, 60_000);
    return () => clearInterval(id);
  }, [load]);

  if (!o) return null;
  const p = o.pending;
  const attention = [
    { key: 'sites', n: o.sites.byStatus.error, label: t('dashboard.overview.sitesInError') || 'site(s) in error', to: '/sites', tone: 'red' as const, icon: <AlertTriangle size={15} /> },
    { key: 'down', n: o.uptime.down, label: t('dashboard.overview.monitorsDown') || 'monitor(s) down', to: '/uptime', tone: 'red' as const, icon: <Activity size={15} /> },
    { key: 'certs', n: o.certificates.failed.length, label: t('dashboard.overview.certsFailed') || 'certificate(s) failed', to: '/domains', tone: 'red' as const, icon: <Lock size={15} /> },
    { key: 'failed', n: p.failedReleases, label: t('dashboard.overview.failedReleases') || 'failed publication(s) (24 h)', to: '/sites', tone: 'red' as const, icon: <Rocket size={15} /> },
    { key: 'approvals', n: p.approvals, label: t('dashboard.overview.approvals') || 'release(s) to approve', to: '/sites', tone: 'amber' as const, icon: <ClipboardCheck size={15} /> },
    { key: 'windows', n: p.windowsToReview, label: t('dashboard.overview.windows') || 'window(s) to review', to: '/maintenance', tone: 'amber' as const, icon: <Wrench size={15} /> },
    { key: 'quarantine', n: p.quarantined, label: t('dashboard.overview.quarantine') || 'file(s) in quarantine', to: '/maintenance', tone: 'amber' as const, icon: <ShieldAlert size={15} /> },
    { key: 'expiring', n: o.certificates.expiring.length, label: t('dashboard.overview.certsExpiring') || 'certificate(s) expiring (14 d)', to: '/domains', tone: 'amber' as const, icon: <FileWarning size={15} /> },
    { key: 'domains', n: p.domainsUnverified, label: t('dashboard.overview.domainsUnverified') || 'unverified domain(s)', to: '/domains', tone: 'amber' as const, icon: <Globe size={15} /> },
  ].filter((a) => a.n > 0);

  const s = o.sites.byStatus;
  const segments = [
    { n: s.active, cls: 'bg-status-up', label: t('dashboard.overview.active') || 'active' },
    { n: s.provisioning, cls: 'bg-sky-400', label: t('dashboard.overview.provisioning') || 'provisioning' },
    { n: s.stopped, cls: 'bg-text-muted', label: t('dashboard.overview.stopped') || 'stopped' },
    { n: s.error, cls: 'bg-status-down', label: t('dashboard.overview.error') || 'error' },
  ];
  const monitorsTotal = o.uptime.up + o.uptime.down + o.uptime.paused + o.uptime.pending;

  return (
    <div className="flex flex-col gap-3.5">
      {/* Needs attention */}
      <div className="rounded-xl bg-bg-secondary p-4">
        <div className="mb-2 text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted">{t('dashboard.overview.attention') || 'Needs attention'}</div>
        {attention.length ? (
          <div className="flex flex-wrap gap-2">{attention.map((a) => <Attention key={a.key} icon={a.icon} label={a.label} count={a.n} to={a.to} tone={a.tone} />)}</div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-status-up"><CheckCircle2 size={16} />{t('dashboard.overview.allGood') || 'Everything is fine: nothing waits for you.'}</p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
        {/* Sites */}
        <Card title={t('dashboard.overview.sites') || 'Sites'} actions={<Link to="/sites" className="text-xs text-accent hover:underline">{t('dashboard.overview.seeAll') || 'See all'}</Link>}>
          {o.sites.total === 0 ? <p className="text-sm text-text-muted">{t('dashboard.overview.noSite') || 'No site yet.'}</p> : (
            <>
              <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
                {segments.filter((x) => x.n > 0).map((x) => <div key={x.label} className={x.cls} style={{ width: `${(x.n / o.sites.total) * 100}%` }} title={`${x.n} ${x.label}`} />)}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
                {segments.map((x) => (
                  <span key={x.label} className="inline-flex items-center gap-1.5"><span className={cn('h-2 w-2 rounded-full', x.cls)} />{x.n} {x.label}</span>
                ))}
              </div>
              {o.sites.problems.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {o.sites.problems.map((x) => (
                    <li key={x.id}>
                      <Link to={`/sites/${x.id}`} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-bg-hover">
                        <AlertTriangle size={14} className="shrink-0 text-status-down" />
                        <span className="truncate text-text-primary">{x.primaryDomain || x.name}</span>
                        {x.statusMessage && <span className="truncate text-xs text-text-muted">{x.statusMessage}</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Card>

        {/* Latest publications */}
        <Card title={t('dashboard.overview.releases') || 'Latest publications'} icon={<History size={14} className="text-accent" />}>
          {!o.releases.length ? <p className="text-sm text-text-muted">{t('dashboard.overview.noRelease') || 'No publication yet.'}</p> : (
            <ul className="space-y-0.5">
              {o.releases.map((r) => (
                <li key={r.id}>
                  <Link to={`/sites/${r.siteId}?tab=releases`} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-bg-hover">
                    <Pill tone={RELEASE_TONE[r.status] ?? 'muted'}>{t(`dashboard.overview.releaseStatus.${r.status}`) || r.status}</Pill>
                    <span className="truncate text-text-primary">{r.siteName}</span>
                    <span className="font-mono text-xs text-text-muted">#{r.number}</span>
                    {r.message && <span className="hidden truncate text-xs text-text-muted sm:inline">{r.message}</span>}
                    <span className="ml-auto shrink-0 font-mono text-[11px] text-text-muted">{r.trigger} · {ago(r.createdAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Monitoring and certificates */}
        <Card title={t('dashboard.overview.monitoring') || 'Monitoring & certificates'} icon={<Activity size={14} className="text-accent" />}
          actions={<Link to="/uptime" className="text-xs text-accent hover:underline">{t('dashboard.overview.seeAll') || 'See all'}</Link>}>
          {monitorsTotal === 0 ? <p className="text-sm text-text-muted">{t('dashboard.overview.noMonitor') || 'No monitor configured.'}</p> : (
            <div className="flex flex-wrap gap-2 text-xs">
              <Pill tone="green">{o.uptime.up} up</Pill>
              {o.uptime.down > 0 && <Pill tone="red">{o.uptime.down} down</Pill>}
              {o.uptime.pending > 0 && <Pill tone="blue">{o.uptime.pending} pending</Pill>}
              {o.uptime.paused > 0 && <Pill>{o.uptime.paused} paused</Pill>}
            </div>
          )}
          {(o.uptime.downList.length > 0 || o.certificates.failed.length > 0 || o.certificates.expiring.length > 0) && (
            <ul className="mt-3 space-y-1 text-sm">
              {o.uptime.downList.map((m) => (
                <li key={`m${m.id}`} className="flex items-center gap-2 px-2"><Activity size={14} className="shrink-0 text-status-down" /><span className="truncate text-text-primary">{m.name}</span><span className="truncate text-xs text-text-muted">{m.lastError}</span></li>
              ))}
              {o.certificates.failed.map((c) => (
                <li key={`f${c.name}`} className="flex items-center gap-2 px-2"><Lock size={14} className="shrink-0 text-status-down" /><span className="truncate font-mono text-[13px] text-text-primary">{c.name}</span><span className="truncate text-xs text-text-muted">{c.error}</span></li>
              ))}
              {o.certificates.expiring.map((c) => (
                <li key={`e${c.name}`} className="flex items-center gap-2 px-2"><FileWarning size={14} className="shrink-0 text-amber-400" /><span className="truncate font-mono text-[13px] text-text-primary">{c.name}</span>
                  <span className="text-xs text-text-muted">{t('dashboard.overview.expiresOn', { date: new Date(c.notAfter).toLocaleDateString(), defaultValue: 'expires {{date}}' })}</span></li>
              ))}
            </ul>
          )}
        </Card>

        {/* Recent activity (staff) */}
        {showActivity && (
          <Card title={t('dashboard.overview.activity') || 'Recent activity'} icon={<History size={14} className="text-accent" />}
            actions={<Link to="/manage/audit-log" className="text-xs text-accent hover:underline">{t('dashboard.overview.seeAll') || 'See all'}</Link>}>
            {!o.activity.length ? <p className="text-sm text-text-muted">{t('dashboard.overview.noActivity') || 'No recent activity.'}</p> : (
              <ul className="space-y-0.5">
                {o.activity.map((a) => (
                  <li key={a.id} className="flex items-center gap-2 px-2 py-0.5 text-sm">
                    <span className="shrink-0 font-mono text-[12px] text-accent">{a.action}</span>
                    <span className="truncate text-text-secondary">{a.resourceName ?? a.resourceType ?? ''}</span>
                    <span className="ml-auto shrink-0 font-mono text-[11px] text-text-muted">{a.username ?? '—'}{a.tenantName ? ` · ${a.tenantName}` : ''} · {ago(a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
