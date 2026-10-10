import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, History, Layers, RefreshCw, ServerCog, Undo2 } from 'lucide-react';
import {
  HostingSocketEvents,
  type EdgeApplyRecord, type EdgeStatus, type EdgeUnitOwnerKind, type EdgeUnitState, type EdgeUnitStatusKind, type HostingAccount,
  type ProxyUpdatedPayload,
} from '@oblimint/shared';
import { accountsApi } from '@/api/accounts.api';
import { infraApi } from '@/api/infra.api';
import { systemEdgeUnitsApi } from '@/api/edgeUnits.api';
import { Button } from '@/components/common/Button';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, InfoRow, Pill, headerBtnCls, selectCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { MailSearch } from '@/components/mail/MailListParts';
import { ListState, useUnitStatusLabel } from '@/components/proxy/proxyUi';
import { proxyLoadError, toastProxyError } from '@/components/proxy/proxyErrors';
import { ApplyResultPill, EdgeAppliesTable } from '@/components/edge/EdgeAppliesTable';
import { EdgeUnitsTable, useOwnerKindLabel } from '@/components/edge/EdgeUnitsTable';
import { cn } from '@/utils/cn';

type View = 'units' | 'applies';
const STATUSES: EdgeUnitStatusKind[] = ['quarantined', 'stub', 'upstreamUnreachable', 'pending', 'active', 'disabled'];
const OWNERS: EdgeUnitOwnerKind[] = ['proxy-host', 'redirection', 'dead-host', 'stream', 'site-domain', 'contributed', 'platform', 'global'];

/**
 * /manage/edge (platform admin) — configuration units of the edge with their
 * validation output, retry, history of the applies (canary), global
 * rollback to the previous good snapshot, edge status (docs/P4b-PLAN.md §8.3,
 * §8.6, §13). OWNED BY MODULE `ui-proxy`.
 */
export function EdgeUnitsPage() {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const statusLabel = useUnitStatusLabel();
  const ownerLabel = useOwnerKindLabel();
  const [view, setView] = useState<View>('units');
  const [status, setStatus] = useState<EdgeUnitStatusKind | ''>('');
  const [owner, setOwner] = useState<EdgeUnitOwnerKind | ''>('');
  const [accountId, setAccountId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [units, setUnits] = useState<EdgeUnitState[]>([]);
  const [applies, setApplies] = useState<EdgeApplyRecord[]>([]);
  const [edge, setEdge] = useState<EdgeStatus | null>(null);
  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [appliesError, setAppliesError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [rollingBack, setRollingBack] = useState(false);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    const [u, a, e] = await Promise.allSettled([
      systemEdgeUnitsApi.list({ status: status || undefined, accountId: accountId ?? undefined }),
      systemEdgeUnitsApi.applies(50),
      infraApi.edgeStatus(),
    ]);
    if (n !== seq.current) return;
    if (u.status === 'fulfilled') { setUnits(u.value); setError(null); } else { setUnits([]); setError(proxyLoadError(t, u.reason, t('edgeUnits.loadFailed') || 'Failed to load the edge units', 'edgeUnits')); }
    if (a.status === 'fulfilled') { setApplies(a.value); setAppliesError(null); } else { setApplies([]); setAppliesError(proxyLoadError(t, a.reason, t('edgeUnits.appliesFailed') || 'Failed to load the applies', 'edgeUnits')); }
    setEdge(e.status === 'fulfilled' ? e.value : null);
    setLoading(false);
  }, [status, accountId, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useEffect(() => { accountsApi.list().then(setAccounts).catch(() => setAccounts([])); }, []);
  useHostingEvents([HostingSocketEvents.PROXY_UPDATED], () => { void load(); }, (_e, p) => (p as ProxyUpdatedPayload | null)?.entity === 'edgeUnit', 1500);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return units
      .filter((u) => !owner || u.ownerKind === owner)
      .filter((u) => !q || u.unitId.toLowerCase().includes(q) || (u.error ?? '').toLowerCase().includes(q))
      .sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || a.unitId.localeCompare(b.unitId));
  }, [units, owner, search]);

  const retry = async (u: EdgeUnitState) => {
    setRetrying(u.unitId);
    try {
      const next = await systemEdgeUnitsApi.retry(u.unitId);
      setUnits((cur) => cur.map((x) => (x.unitId === next.unitId ? next : x)));
      toast.success(t('edgeUnits.retried', { unit: u.unitId, defaultValue: '{{unit}} validated again' }));
    } catch (err) {
      toastProxyError(t, err, t('edgeUnits.retryFailed') || 'The new attempt failed', 'edgeUnits');
    } finally {
      setRetrying(null);
    }
  };

  const rollback = async () => {
    if (!(await confirm({
      title: t('edgeUnits.rollbackTitle') || 'Roll the edge back',
      message: t('edgeUnits.rollbackConfirm') || 'The whole configuration of the edge goes back to the previous good snapshot and nginx is reloaded. The changes made since then are applied again at the next synchronisation (and quarantined if they still fail).',
      confirmLabel: t('edgeUnits.rollback') || 'Roll back',
      danger: true,
    }))) return;
    setRollingBack(true);
    try {
      const rec = await systemEdgeUnitsApi.rollback();
      toast.success(t('edgeUnits.rolledBack') || 'Edge rolled back');
      setApplies((cur) => [rec, ...cur.filter((x) => x.id !== rec.id)]);
      void load();
    } catch (err) {
      toastProxyError(t, err, t('edgeUnits.rollbackFailed') || 'The rollback failed', 'edgeUnits');
    } finally {
      setRollingBack(false);
    }
  };

  const counts = edge?.units;
  const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(i18n.language) : '—');

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('nav.edge') || 'Edge'}</h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button onClick={() => { setLoading(true); void load(); }} className={headerBtnCls}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
          <Button size="sm" variant="danger" loading={rollingBack} onClick={() => { void rollback(); }}><Undo2 size={14} className="mr-1.5" />{t('edgeUnits.rollback') || 'Roll back'}</Button>
        </div>
      </div>
      <p className="-mt-3 text-sm text-text-muted">{t('edgeUnits.description') || 'Each site domain, proxy host, redirection, dead host and stream is an independent unit: checked, probed and tested in isolation before going live. A refused unit is quarantined (its last good version is served) without touching the others.'}</p>

      <Card title={t('edgeUnits.edgeStatus') || 'Web front end'} icon={<ServerCog size={14} className="text-accent" />}>
        {!edge ? <p className="text-sm text-text-muted">{t('edgeUnits.statusUnavailable') || 'Status unavailable.'}</p> : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <InfoRow label={t('edgeUnits.running') || 'State'}>{edge.running ? <Pill tone="green">{t('infra.running') || 'running'}</Pill> : <Pill tone="red">{t('infra.stopped') || 'stopped'}</Pill>}</InfoRow>
              <InfoRow label={t('edgeUnits.vhosts') || 'Server blocks'} mono>{edge.vhostCount}</InfoRow>
              <InfoRow label={t('edgeUnits.lastSync') || 'Last sync'} mono>{fmt(edge.lastSyncAt)}</InfoRow>
              <InfoRow label={t('edgeUnits.lastApply') || 'Last apply'}>
                {edge.lastApply ? <span className="flex flex-wrap items-center gap-2"><ApplyResultPill result={edge.lastApply.result as EdgeApplyRecord['result']} /><span className="font-mono text-[11px] text-text-muted">{fmt(edge.lastApply.at)}</span></span> : '—'}
              </InfoRow>
            </div>
            {counts && (
              <div className="flex flex-wrap gap-2">
                {([['active', counts.active], ['quarantined', counts.quarantined], ['stub', counts.stub], ['upstreamUnreachable', counts.upstreamUnreachable], ['pending', counts.pending]] as Array<[EdgeUnitStatusKind, number]>).map(([k, v]) => (
                  <button key={k} type="button" onClick={() => { setView('units'); setStatus(status === k ? '' : k); }}
                    className={cn('rounded-full px-2.5 py-0.5 text-[11px] transition-colors', status === k ? 'bg-accent text-white' : 'bg-bg-primary text-text-muted hover:text-text-primary', v > 0 && k !== 'active' && status !== k && 'text-amber-400')}>
                    {statusLabel(k)} · {v}
                  </button>
                ))}
                <span className="self-center font-mono text-[11px] text-text-muted">{t('edgeUnits.total', { count: counts.total, defaultValue: '{{count}} unit(s)' })}</span>
              </div>
            )}
            {(edge.lastSyncError || edge.lastApply?.error) && (
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-status-down/5 p-2 font-mono text-[11px] text-status-down">{edge.lastApply?.error ?? edge.lastSyncError}</pre>
            )}
          </div>
        )}
      </Card>

      <SegmentedTabs<View>
        fill={false}
        tabs={[
          { id: 'units', label: t('edgeUnits.tabs.units') || 'Units', icon: <Layers size={16} /> },
          { id: 'applies', label: t('edgeUnits.tabs.applies') || 'Applies', icon: <History size={16} /> },
        ]}
        value={view}
        onChange={setView}
        ariaLabel={t('nav.edge') || 'Edge'}
      />

      {view === 'units' ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <MailSearch value={search} onChange={setSearch} placeholder={t('edgeUnits.search') || 'Unit or error…'} />
            <select aria-label={t('edgeUnits.status') || 'Status'} value={status} onChange={(e) => setStatus(e.target.value as EdgeUnitStatusKind | '')} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-48')}>
              <option value="">{t('edgeUnits.allStatus') || 'Every status'}</option>
              {STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </select>
            <select aria-label={t('edgeUnits.ownerLabel') || 'Owner'} value={owner} onChange={(e) => setOwner(e.target.value as EdgeUnitOwnerKind | '')} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-44')}>
              <option value="">{t('edgeUnits.allOwners') || 'Every owner'}</option>
              {OWNERS.map((o) => <option key={o} value={o}>{ownerLabel(o)}</option>)}
            </select>
            {accounts.length > 0 && (
              <select aria-label={t('proxy.account') || 'Hosting account'} value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-52')}>
                <option value="">{t('proxy.allAccounts') || 'All accounts'}</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.username}</option>)}
              </select>
            )}
          </div>
          <ListState loading={loading} error={error} empty={shown.length === 0} emptyIcon={<Layers />} emptyText={search || owner || status ? (t('common.noMatch') || 'No match') : (t('edgeUnits.empty') || 'No unit.')}>
            <EdgeUnitsTable units={shown} accounts={accounts} retrying={retrying} onRetry={(u) => { void retry(u); }} />
          </ListState>
        </>
      ) : (
        <ListState loading={loading} error={appliesError} empty={applies.length === 0} emptyIcon={<AlertTriangle />} emptyText={t('edgeUnits.noApply') || 'No apply recorded yet.'}>
          <EdgeAppliesTable applies={applies} />
        </ListState>
      )}
    </PageContainer>
  );
}
