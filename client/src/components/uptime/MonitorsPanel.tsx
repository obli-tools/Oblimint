import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { HeartPulse, Pause, Pencil, Play, RefreshCw, Trash2, Zap } from 'lucide-react';
import { HostingSocketEvents, type HostingAccount, type MonitoringUpdatedPayload, type UptimeCheckPoint, type UptimeMonitor } from '@oblimint/shared';
import { uptimeApi } from '@/api/uptime.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { GroupedTable, flatNodes } from '@/components/common/GroupedTable';
import { groupRowsByAccount } from '@/components/common/accountGroups';
import { TenantBadge } from '@/components/common/TenantBadge';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EmptyState, Pill, headerBtnCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { useP4bAccess } from '@/components/apps/appsAccess';
import { appsErrorMessage, toastAppsError } from '@/components/apps/appsErrors';
import { formatMs, formatPct, uptimeColor } from '@/components/apps/appsFormat';
import { UptimeStatusPill } from '@/components/apps/AppBadges';
import { Sparkline } from '@/components/apps/charts';
import { MonitorModal } from './MonitorModal';

/** Sparklines are fetched per row: capped to keep the list light. */
const SPARK_MAX = 40;

export function monitorTarget(m: UptimeMonitor): string {
  return m.kind === 'tcp' ? `${m.host ?? '?'}:${m.port ?? '?'}` : (m.url ?? '—');
}

function LatencySpark({ id }: { id: number }) {
  const [points, setPoints] = useState<UptimeCheckPoint[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    uptimeApi.checks(id, '24h').then((p) => { if (!cancelled) setPoints(p); }).catch(() => { if (!cancelled) setPoints([]); });
    return () => { cancelled = true; };
  }, [id]);
  if (!points) return <div className="h-6" />;
  return <Sparkline values={points.slice(-60).map((p) => (p.ok ? p.latencyMs : null))} height={24} color="#4f7bff" />;
}

/** Uptime monitors table (status, uptime 24 h / 30 d, latency sparkline), create / edit / pause / check now. */
export function MonitorsPanel({ accountId, tenantId, accounts, showAccount, creating, onCreatingChange }: {
  accountId: number | null;
  tenantId: number | undefined;
  accounts: HostingAccount[];
  showAccount: boolean;
  creating: boolean;
  onCreatingChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { can, isStaff } = useP4bAccess();
  const [items, setItems] = useState<UptimeMonitor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<UptimeMonitor | null>(null);
  const [busy, setBusy] = useState<number | 'sync' | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const l = await uptimeApi.listMonitors({ accountId: accountId ?? undefined, tenantId });
      if (n !== seq.current) return;
      setItems(l);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setItems((cur) => cur ?? []);
      setError(appsErrorMessage(t, err, t('uptime.loadFailed') || 'Failed to load the monitors', 'uptime'));
    }
  }, [accountId, tenantId, t]);
  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.MONITORING_UPDATED], () => { void load(); }, (_e, p) => {
    const payload = p as MonitoringUpdatedPayload | null;
    return !!payload && payload.entity === 'monitor' && (accountId == null || payload.accountId == null || payload.accountId === accountId);
  }, 1000);

  const manageOf = (m: UptimeMonitor) => can('monitoring.manage', m.accountId);
  const manageable = accounts.filter((a) => can('monitoring.manage', a.id));

  const checkNow = async (m: UptimeMonitor) => {
    setBusy(m.id);
    try {
      const p = await uptimeApi.checkNow(m.id);
      if (p.ok) toast.success(t('uptime.checkOk', { latency: formatMs(p.latencyMs), defaultValue: 'Up ({{latency}})' }));
      else toast.error(t('uptime.checkKo', { error: p.error ?? (p.statusCode != null ? String(p.statusCode) : '?'), defaultValue: 'Down: {{error}}' }));
      void load();
    } catch (err) {
      toastAppsError(t, err, t('uptime.checkFailed') || 'The check failed', 'uptime');
    } finally {
      setBusy(null);
    }
  };

  const setEnabled = async (m: UptimeMonitor, enabled: boolean) => {
    setBusy(m.id);
    try {
      await uptimeApi.updateMonitor(m.id, { enabled });
      void load();
    } catch (err) {
      toastAppsError(t, err, t('uptime.form.saveFailed') || 'Failed to save the monitor', 'uptime');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (m: UptimeMonitor) => {
    if (!(await confirm({
      title: t('uptime.deleteTitle') || 'Delete the monitor',
      message: t('uptime.deleteConfirm', { name: m.name, defaultValue: 'Delete {{name}} and its history? It is also removed from the status pages.' }),
      danger: true,
    }))) return;
    try {
      await uptimeApi.deleteMonitor(m.id);
      toast.success(t('uptime.deleted') || 'Monitor deleted');
      void load();
    } catch (err) {
      toastAppsError(t, err, t('uptime.deleteFailed') || 'Failed to delete the monitor', 'uptime');
    }
  };

  const accountDir = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  // Latency sparklines: the first SPARK_MAX monitors of the list only (one request each).
  const sparked = useMemo(() => new Set((items ?? []).slice(0, SPARK_MAX).map((m) => m.id)), [items]);

  const syncProxy = async () => {
    if (accountId == null) return;
    setBusy('sync');
    try {
      const r = await uptimeApi.syncProxyHosts(accountId);
      toast.success(t('uptime.synced', { created: r.created, removed: r.removed, defaultValue: '{{created}} monitor(s) created, {{removed}} removed' }));
      void load();
    } catch (err) {
      toastAppsError(t, err, t('uptime.syncFailed') || 'The synchronisation failed', 'uptime');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {accountId != null && can('monitoring.manage', accountId) && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-sm text-text-muted">{t('uptime.syncHint') || 'Proxy hosts with "automatic monitor" get a monitor kept in sync.'}</p>
          <button type="button" disabled={busy === 'sync'} onClick={() => { void syncProxy(); }} className={headerBtnCls}><RefreshCw size={14} />{t('uptime.syncProxy') || 'Sync the proxy hosts'}</button>
        </div>
      )}
      {items === null ? <div className="flex justify-center py-12"><LoadingSpinner /></div>
        : items.length === 0 ? <EmptyState icon={<HeartPulse />} text={error ?? (t('uptime.empty') || 'No monitor yet.')} />
          : (
            <GroupedTable<UptimeMonitor>
              storageKey="uptime"
              singleGroupFlat
              minWidth={760}
              defaultSort={{ column: 'name' }}
              // Grouped by account; the platform monitors (no account) in their own group.
              groups={showAccount
                ? groupRowsByAccount(items, accountDir, (m) => ({ id: m.accountId, username: accounts.find((a) => a.id === m.accountId)?.username }), (rows) => flatNodes(rows, (m) => m.id), t('uptime.platformGroup') || 'Platform')
                : [{ key: 'all', label: '', sortLabel: '', nodes: flatNodes(items, (m) => m.id) }]}
              onRowClick={(m) => navigate(`/uptime/monitors/${m.id}`)}
              columns={[
                {
                  id: 'name', header: t('uptime.form.name') || 'Name', tdClassName: 'max-w-[20rem]', sort: (m) => m.name,
                  cell: (m) => (
                    <>
                      <div className="flex items-center gap-2">
                        <Link to={`/uptime/monitors/${m.id}`} className="truncate font-medium text-text-primary hover:text-accent">{m.name}</Link>
                        {m.auto && <Pill tone="accent">{t('uptime.auto') || 'auto'}</Pill>}
                        {isStaff && !showAccount && <TenantBadge tenantId={m.tenantId} />}
                      </div>
                      <div className="truncate font-mono text-[11px] text-text-muted">{m.kind.toUpperCase()} · {monitorTarget(m)}</div>
                    </>
                  ),
                },
                {
                  id: 'status', header: t('apps.list.status') || 'Status', sort: (m) => (m.enabled ? m.status : 'paused'),
                  cell: (m) => (
                    <>
                      <UptimeStatusPill status={m.enabled ? m.status : 'paused'} />
                      {m.status === 'down' && m.lastError && <div className="mt-1 max-w-[14rem] truncate text-[11px] text-status-down" title={m.lastError}>{m.lastError}</div>}
                    </>
                  ),
                },
                { id: 'u24', header: t('uptime.uptime24h') || '24 h', sort: (m) => m.uptime24h ?? null, cell: (m) => <span className="font-mono text-xs" style={{ color: uptimeColor(m.uptime24h) }}>{formatPct(m.uptime24h)}</span> },
                { id: 'u30', header: t('uptime.uptime30d') || '30 d', sort: (m) => m.uptime30d ?? null, cell: (m) => <span className="font-mono text-xs" style={{ color: uptimeColor(m.uptime30d) }}>{formatPct(m.uptime30d)}</span> },
                {
                  id: 'latency', header: t('uptime.latency') || 'Latency', thClassName: 'w-40', sort: (m) => m.lastLatencyMs ?? null,
                  cell: (m) => (
                    <>
                      <div className="font-mono text-[11px] text-text-secondary">{formatMs(m.lastLatencyMs)}</div>
                      {sparked.has(m.id) && <LatencySpark id={m.id} />}
                    </>
                  ),
                },
                {
                  id: 'actions', header: <span className="sr-only">{t('apps.list.actions') || 'Actions'}</span>, thClassName: 'w-12', tdClassName: 'px-2 py-2',
                  cell: (m) => (busy === m.id ? <div className="p-2"><LoadingSpinner size="sm" /></div> : (
                    <ActionMenu items={[
                      { key: 'check', icon: <Zap size={14} />, label: t('uptime.checkNow') || 'Check now', onClick: () => { void checkNow(m); }, hidden: !manageOf(m) },
                      { key: 'edit', icon: <Pencil size={14} />, label: t('common.edit') || 'Edit', onClick: () => setEditing(m), hidden: !manageOf(m) },
                      m.enabled
                        ? { key: 'pause', icon: <Pause size={14} />, label: t('uptime.pause') || 'Pause', onClick: () => { void setEnabled(m, false); }, hidden: !manageOf(m) }
                        : { key: 'resume', icon: <Play size={14} />, label: t('uptime.resume') || 'Resume', onClick: () => { void setEnabled(m, true); }, hidden: !manageOf(m) },
                      { key: 'delete', icon: <Trash2 size={14} />, label: t('common.delete') || 'Delete', onClick: () => { void remove(m); }, danger: true, separator: true, hidden: !manageOf(m) },
                    ]} />
                  )),
                },
              ]}
            />
          )}
      {(creating || editing) && (
        <MonitorModal
          monitor={editing}
          accountId={accountId}
          accounts={manageable}
          onClose={() => { setEditing(null); onCreatingChange(false); }}
          onSaved={() => { setEditing(null); onCreatingChange(false); void load(); }}
        />
      )}
    </div>
  );
}
