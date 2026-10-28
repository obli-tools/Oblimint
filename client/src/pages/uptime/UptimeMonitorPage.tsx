import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { HeartPulse, Pause, Pencil, Play, Trash2, Zap } from 'lucide-react';
import { HostingSocketEvents, type HostingAccount, type MonitoringUpdatedPayload, type UptimeCheckPoint, type UptimeMonitor } from '@oblimint/shared';
import { uptimeApi, type UptimeRange } from '@/api/uptime.api';
import { accountsApi } from '@/api/accounts.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { DetailHeader } from '@/components/common/DetailHeader';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { GroupedTable } from '@/components/common/GroupedTable';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, InfoRow, Pill, headerAccentBtnCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { useP4bAccess } from '@/components/apps/appsAccess';
import { appsErrorMessage, isNotFound, toastAppsError } from '@/components/apps/appsErrors';
import { formatDateTime, formatMs, formatPct, uptimeColor } from '@/components/apps/appsFormat';
import { UptimeStatusPill } from '@/components/apps/AppBadges';
import { TimeChart } from '@/components/apps/charts';
import { MonitorModal } from '@/components/uptime/MonitorModal';
import { monitorTarget } from '@/components/uptime/MonitorsPanel';

const RANGES: UptimeRange[] = ['24h', '7d', '30d'];
const HISTORY_ROWS = 100;

/**
 * /uptime/monitors/:id — one monitor: latency chart with failures, uptime over
 * the range, check history, check now / edit / pause / delete
 * (docs/P4b-PLAN.md §10). OWNED BY MODULE `ui-apps`.
 */
export function UptimeMonitorPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { id } = useParams();
  const monitorId = Number(id);
  const { can } = useP4bAccess();
  const [monitor, setMonitor] = useState<UptimeMonitor | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [range, setRange] = useState<UptimeRange>('24h');
  const [checks, setChecks] = useState<UptimeCheckPoint[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [accounts, setAccounts] = useState<HostingAccount[]>([]);

  const load = useCallback(async () => {
    try {
      setMonitor(await uptimeApi.getMonitor(monitorId));
      setLoadError(null);
    } catch (err) {
      if (isNotFound(err)) setNotFound(true);
      else setLoadError(appsErrorMessage(t, err, t('uptime.loadOneFailed') || 'Failed to load the monitor', 'uptime'));
    }
  }, [monitorId, t]);
  const loadChecks = useCallback(async () => {
    try {
      setChecks(await uptimeApi.checks(monitorId, range));
    } catch {
      setChecks([]);
    }
  }, [monitorId, range]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setChecks(null); void loadChecks(); }, [loadChecks]);
  useEffect(() => {
    if (!editing || accounts.length) return;
    accountsApi.list().then(setAccounts).catch(() => setAccounts([]));
  }, [editing, accounts.length]);
  useHostingEvents([HostingSocketEvents.MONITORING_UPDATED], () => { void load(); void loadChecks(); }, (_e, p) => {
    const payload = p as MonitoringUpdatedPayload | null;
    if (!payload || payload.entity !== 'monitor' || payload.id !== monitorId) return false;
    if (payload.action === 'deleted') { navigate('/uptime', { replace: true }); return false; }
    return true;
  }, 1000);

  const chart = useMemo(() => {
    if (!checks) return null;
    const fmt = range === '24h'
      ? (iso: string) => new Date(iso).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })
      : (iso: string) => new Date(iso).toLocaleDateString(i18n.language, { day: '2-digit', month: '2-digit' });
    const okCount = checks.filter((c) => c.ok).length;
    return {
      labels: checks.map((c) => fmt(c.at)),
      latency: checks.map((c) => (c.ok ? c.latencyMs : null)),
      failures: checks.map((c) => (c.ok ? null : 0)),
      ratio: checks.length ? okCount / checks.length : null,
      failed: checks.length - okCount,
    };
  }, [checks, range, i18n.language]);

  if (notFound || (loadError && !monitor)) {
    return (
      <PageContainer className="flex flex-col items-center gap-3 py-16 text-center">
        <HeartPulse className="h-8 w-8 text-text-muted" />
        <p className="text-sm text-text-secondary">{notFound ? (t('uptime.notFound') || 'This monitor does not exist or is not visible to you.') : loadError}</p>
        <Link to="/uptime" className="text-sm text-accent hover:underline">{t('uptime.backToList') || 'Back to the monitors'}</Link>
      </PageContainer>
    );
  }
  if (!monitor) return <PageContainer className="flex justify-center py-16"><LoadingSpinner /></PageContainer>;

  const manage = can('monitoring.manage', monitor.accountId);

  const checkNow = async () => {
    setBusy(true);
    try {
      const p = await uptimeApi.checkNow(monitor.id);
      if (p.ok) toast.success(t('uptime.checkOk', { latency: formatMs(p.latencyMs), defaultValue: 'Up ({{latency}})' }));
      else toast.error(t('uptime.checkKo', { error: p.error ?? (p.statusCode != null ? String(p.statusCode) : '?'), defaultValue: 'Down: {{error}}' }));
      void load();
      void loadChecks();
    } catch (err) {
      toastAppsError(t, err, t('uptime.checkFailed') || 'The check failed', 'uptime');
    } finally {
      setBusy(false);
    }
  };
  const setEnabled = async (enabled: boolean) => {
    try {
      setMonitor(await uptimeApi.updateMonitor(monitor.id, { enabled }));
    } catch (err) {
      toastAppsError(t, err, t('uptime.form.saveFailed') || 'Failed to save the monitor', 'uptime');
    }
  };
  const remove = async () => {
    if (!(await confirm({
      title: t('uptime.deleteTitle') || 'Delete the monitor',
      message: t('uptime.deleteConfirm', { name: monitor.name, defaultValue: 'Delete {{name}} and its history? It is also removed from the status pages.' }),
      danger: true,
    }))) return;
    try {
      await uptimeApi.deleteMonitor(monitor.id);
      toast.success(t('uptime.deleted') || 'Monitor deleted');
      navigate('/uptime', { replace: true });
    } catch (err) {
      toastAppsError(t, err, t('uptime.deleteFailed') || 'Failed to delete the monitor', 'uptime');
    }
  };

  const history = (checks ?? []).slice(-HISTORY_ROWS).reverse();

  return (
    <PageContainer className="flex flex-col gap-5">
      <DetailHeader
        backTo="/uptime"
        title={monitor.name}
        badges={(
          <>
            <UptimeStatusPill status={monitor.enabled ? monitor.status : 'paused'} />
            {monitor.auto && <Pill tone="accent">{t('uptime.auto') || 'auto'}</Pill>}
          </>
        )}
        onRefresh={() => { void load(); void loadChecks(); }}
        actions={(
          <>
            {manage && (
              <>
                <button type="button" disabled={busy} onClick={() => { void checkNow(); }} className={headerAccentBtnCls}><Zap size={14} />{t('uptime.checkNow') || 'Check now'}</button>
                <ActionMenu triggerSize="lg" triggerVariant="solid" triggerClassName="rounded-lg" items={[
                  { key: 'edit', icon: <Pencil size={14} />, label: t('common.edit') || 'Edit', onClick: () => setEditing(true) },
                  monitor.enabled
                    ? { key: 'pause', icon: <Pause size={14} />, label: t('uptime.pause') || 'Pause', onClick: () => { void setEnabled(false); } }
                    : { key: 'resume', icon: <Play size={14} />, label: t('uptime.resume') || 'Resume', onClick: () => { void setEnabled(true); } },
                  { key: 'delete', icon: <Trash2 size={14} />, label: t('common.delete') || 'Delete', onClick: () => { void remove(); }, danger: true, separator: true },
                ]} />
              </>
            )}
          </>
        )}
      >
        <p className="mt-1 break-all font-mono text-xs text-text-muted">{monitor.kind.toUpperCase()} · {monitorTarget(monitor)}</p>
        {monitor.status === 'down' && monitor.lastError && <p className="mt-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{monitor.lastError}</p>}
      </DetailHeader>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card><InfoRow label={t('uptime.uptime24h') || '24 h'}><span className="font-mono text-lg" style={{ color: uptimeColor(monitor.uptime24h) }}>{formatPct(monitor.uptime24h)}</span></InfoRow></Card>
        <Card><InfoRow label={t('uptime.uptime30d') || '30 d'}><span className="font-mono text-lg" style={{ color: uptimeColor(monitor.uptime30d) }}>{formatPct(monitor.uptime30d)}</span></InfoRow></Card>
        <Card><InfoRow label={t('uptime.latency') || 'Latency'}><span className="font-mono text-lg">{formatMs(monitor.lastLatencyMs)}</span></InfoRow></Card>
        <Card><InfoRow label={t('uptime.lastCheck') || 'Last check'}><span className="text-sm">{formatDateTime(monitor.lastCheckedAt, i18n.language)}</span></InfoRow></Card>
      </div>

      <Card
        title={t('uptime.latencyChart') || 'Response time'}
        actions={<SegmentedTabs<UptimeRange> size="sm" fill={false} value={range} onChange={setRange} tabs={RANGES.map((r) => ({ id: r, label: <span className="font-mono">{r}</span> }))} />}
      >
        {!chart ? <div className="flex justify-center py-10"><LoadingSpinner /></div> : (
          <>
            <TimeChart
              labels={chart.labels}
              series={[
                { label: t('uptime.latency') || 'Latency', color: '#4f7bff', values: chart.latency },
                { label: t('uptime.failures') || 'Failures', color: '#ef4444', values: chart.failures, area: false },
              ]}
              formatY={(v) => formatMs(v)}
            />
            <p className="mt-2 text-xs text-text-muted">
              {t('uptime.rangeSummary', { ratio: formatPct(chart.ratio), failed: chart.failed, total: checks?.length ?? 0, defaultValue: '{{ratio}} over the range · {{failed}} failed check(s) out of {{total}}' })}
            </p>
          </>
        )}
      </Card>

      <Card title={t('uptime.history') || 'Check history'}>
        {history.length === 0 ? <p className="text-sm text-text-muted">{t('uptime.noCheck') || 'No check yet.'}</p> : (
          <GroupedTable<UptimeCheckPoint>
            singleGroupFlat
            className="bg-bg-primary"
            minWidth={560}
            groups={[{ key: 'all', label: '', sortLabel: '', nodes: history.map((c, i) => ({ key: `${c.at}-${i}`, row: c, children: [] })) }]}
            columns={[
              { id: 'at', header: t('apps.history.date') || 'Date', tdClassName: 'text-xs text-text-secondary', sort: (c) => c.at, cell: (c) => formatDateTime(c.at, i18n.language) },
              {
                id: 'status', header: t('apps.list.status') || 'Status', sort: (c) => c.ok,
                cell: (c) => (c.ok ? <Pill tone="green">{t('uptime.status.up') || 'Up'}</Pill> : <Pill tone="red">{t('uptime.status.down') || 'Down'}</Pill>),
              },
              { id: 'latency', header: t('uptime.latency') || 'Latency', tdClassName: 'font-mono text-xs text-text-secondary', sort: (c) => c.latencyMs ?? null, cell: (c) => formatMs(c.latencyMs) },
              { id: 'http', header: 'HTTP', tdClassName: 'font-mono text-xs text-text-secondary', sort: (c) => c.statusCode ?? null, cell: (c) => c.statusCode ?? '—' },
              { id: 'error', header: t('uptime.error') || 'Error', tdClassName: 'max-w-[22rem] truncate text-xs text-status-down', sort: (c) => c.error ?? '', cell: (c) => <span title={c.error ?? undefined}>{c.error ?? ''}</span> },
            ]}
          />
        )}
      </Card>

      {editing && (
        <MonitorModal
          monitor={monitor}
          accountId={monitor.accountId}
          accounts={accounts}
          onClose={() => setEditing(false)}
          onSaved={(m) => { setMonitor(m); setEditing(false); void loadChecks(); }}
        />
      )}
    </PageContainer>
  );
}
