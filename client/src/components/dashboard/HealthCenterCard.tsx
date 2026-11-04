import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Archive, HardDrive, HeartPulse } from 'lucide-react';
import type { HealthCenterStatus } from '@oblimint/shared';
import { healthMonitorApi } from '@/api/healthMonitor.api';
import { Card, Pill } from '@/components/hosting/hostingUi';
import { ago } from '@/components/apps/appsFormat';
import { useByteFormat } from '@/components/usage/usageUi';
import { STATUS_TONE, componentLabel, statusLabel } from '@/components/dashboard/healthCenterUi';
import { cn } from '@/utils/cn';

// Dashboard card of the platform admin (master workspace): the confirmed state
// of each deep health component, the data disk of the node and the failing
// backups, from GET /api/system/health-monitor/center (refreshed every minute,
// the pace of the worker). Hidden when the API is unavailable.

const DOT: Record<string, string> = { ok: 'bg-status-up', fail: 'bg-status-down', skipped: 'bg-text-muted', unknown: 'bg-text-muted' };

export function HealthCenterCard() {
  const { t } = useTranslation();
  const fmtBytes = useByteFormat();
  const [s, setS] = useState<HealthCenterStatus | null>(null);

  const load = useCallback(async () => {
    try { setS(await healthMonitorApi.center()); } catch { /* optional block: hidden on failure */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const id = setInterval(() => { void load(); }, 60_000);
    return () => clearInterval(id);
  }, [load]);

  if (!s) return null;
  const d = s.disk;
  const freePct = d.totalBytes && d.availableBytes != null ? Math.round((d.availableBytes / d.totalBytes) * 1000) / 10 : null;
  const failing = s.backups.failing;
  const lf = s.backups.lastFailure;
  const target = (scope: 'account' | 'panel', username: string | null, accountId: number | null) =>
    (scope === 'panel' ? (t('healthCenter.panel') || 'Panel') : username ?? `#${accountId ?? '?'}`);
  const anyDown = s.components.some((c) => c.status === 'fail') || d.status === 'fail' || failing.length > 0;

  return (
    <Card
      title={t('healthCenter.cardTitle') || 'Platform health'}
      icon={<HeartPulse size={14} className={anyDown ? 'text-status-down' : 'text-accent'} />}
      actions={<Link to="/settings#settings-health-center" className="text-xs text-accent hover:underline">{t('healthCenter.settings') || 'Settings'}</Link>}
    >
      {!s.workersEnabled && <p className="mb-3 text-xs text-amber-400">{t('healthCenter.workersOff') || 'Background workers are off on this panel (OBLIMINT_WORKERS=off): nothing is followed.'}</p>}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {/* Components */}
        <div className="min-w-0">
          <div className="mb-2 text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted">{t('healthCenter.components') || 'Components'}</div>
          {!s.lastTickAt && s.components.every((c) => !c.lastCheckedAt) ? (
            <p className="text-xs text-text-muted">{t('healthCenter.notCheckedYet') || 'Not checked yet: the first pass runs about a minute after the start.'}</p>
          ) : (
            <ul className="space-y-1">
              {s.components.map((c) => (
                <li key={c.id} className="flex min-w-0 items-center gap-2 text-sm" title={c.detail ?? undefined}>
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT[c.status])} />
                  <span className="truncate text-text-primary">{componentLabel(t, c.id)}</span>
                  {c.pending > 0 && <Pill tone="amber">{t('healthCenter.status.pending', { count: c.pending, defaultValue: 'confirming ({{count}})' })}</Pill>}
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {c.status === 'fail' && c.since && <span className="font-mono text-[11px] text-text-muted">{t('healthCenter.since', { ago: ago(c.since), defaultValue: 'since {{ago}}' })}</span>}
                    <Pill tone={STATUS_TONE[c.status]}>{statusLabel(t, c.status)}</Pill>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {s.lastTickAt && <p className="mt-2 font-mono text-[11px] text-text-muted">{t('healthCenter.lastCheck', { ago: ago(s.lastTickAt), defaultValue: 'Last check {{ago}} ago' })}</p>}
        </div>

        {/* Disk */}
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted"><HardDrive size={12} />{t('healthCenter.disk') || 'Data disk'}</div>
          {freePct == null ? <p className="text-xs text-text-muted">{t('healthCenter.diskUnknown') || 'Not measured yet'}</p> : (
            <>
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-secondary">
                  {t('healthCenter.diskFree', { free: fmtBytes(d.availableBytes), total: fmtBytes(d.totalBytes), pct: freePct, defaultValue: '{{free}} free of {{total}} ({{pct}} %)' })}
                </span>
                <span className="ml-auto shrink-0"><Pill tone={STATUS_TONE[d.status]}>{statusLabel(t, d.status, true)}</Pill></span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
                <div className={cn('h-full rounded-full', d.status === 'fail' ? 'bg-status-down' : 'bg-accent')} style={{ width: `${Math.min(100, Math.max(0, 100 - freePct))}%` }} />
              </div>
              {d.status === 'fail' && d.since && <p className="mt-1.5 font-mono text-[11px] text-text-muted">{t('healthCenter.since', { ago: ago(d.since), defaultValue: 'since {{ago}}' })}</p>}
            </>
          )}
        </div>

        {/* Backups */}
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted"><Archive size={12} />{t('healthCenter.backups') || 'Backups'}</div>
          {failing.length === 0
            ? <p className="text-xs text-status-up">{t('healthCenter.backupsOk') || 'No backup target in failure'}</p>
            : (
              <ul className="space-y-1">
                <li className="text-xs text-status-down">{t('healthCenter.backupsFailing', { count: failing.length, defaultValue: '{{count}} target(s) failing' })}</li>
                {failing.slice(0, 5).map((f) => (
                  <li key={`${f.scope}:${f.accountId ?? f.accountUsername ?? ''}`}>
                    <Link to={f.scope === 'account' && f.accountId ? `/accounts/${f.accountId}?tab=backups` : '/settings#settings-group-backups'}
                      className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-bg-hover" title={f.lastError ?? undefined}>
                      <span className="h-2 w-2 shrink-0 rounded-full bg-status-down" />
                      <span className="truncate text-text-primary">{target(f.scope, f.accountUsername, f.accountId)}</span>
                      <span className="ml-auto shrink-0 font-mono text-[11px] text-text-muted">{t('healthCenter.failures', { count: f.failures, defaultValue: '{{count}} failure(s) in a row' })}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          <div className="mt-2 text-xs text-text-muted">
            <span className="font-medium text-text-secondary">{t('healthCenter.lastFailure') || 'Last failure:'}</span>{' '}
            {lf ? (
              <span title={lf.error ?? undefined}>
                {target(lf.scope, lf.accountUsername, lf.accountId)} · #{lf.runId}{lf.finishedAt ? ` · ${ago(lf.finishedAt)}` : ''}
                {lf.error && <span className="block truncate">{lf.error}</span>}
              </span>
            ) : (t('healthCenter.noFailure') || 'No failed backup')}
          </div>
        </div>
      </div>
    </Card>
  );
}
