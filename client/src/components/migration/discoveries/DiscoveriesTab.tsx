import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Eye, FileStack, Radar, Square, Trash2 } from 'lucide-react';
import { HostingSocketEvents, type MigrationDiscovery, type MigrationSource, type MigrationUpdatedPayload } from '@oblimint/shared';
import { migrationApi } from '@/api/migration.api';
import { ActionMenu } from '@/components/common/ActionMenu';
import { Button } from '@/components/common/Button';
import { TableScroll } from '@/components/common/TableScroll';
import { SortTh, useTableSort } from '@/components/common/SortHead';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { selectCls, thCls, theadRowCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { formatDateTime, progressPct } from '../migrationFormat';
import { DiscoveryStatusPill, LoadState, ProgressBar, loadErrorOf, tdCls, toastMigrationError, type LoadError } from '../migrationUi';
import { CreatePlanModal } from '../plans/CreatePlanModal';
import { discoveryPhaseLabel } from './discoveryLabels';

/** Short counts summary of a finished discovery ("18 accounts · 112 domains · 40 DB · 25 mailboxes"). */
export function DiscoveryCountsSummary({ d }: { d: MigrationDiscovery }) {
  const { t } = useTranslation();
  if (!d.counts) return <span className="text-text-muted">—</span>;
  const c = d.counts;
  const parts: Array<[number, string]> = [
    [c.accounts, t('migration.counts.inline.accounts') || 'accounts'],
    [c.domains, t('migration.counts.inline.domains') || 'domains'],
    [c.databases, t('migration.counts.inline.databases') || 'databases'],
    [c.mailboxes, t('migration.counts.inline.mailboxes') || 'mailboxes'],
    [c.dnsZones, t('migration.counts.inline.dnsZones') || 'zones'],
  ];
  return <span className="text-xs text-text-secondary">{parts.map(([n, l]) => `${n} ${l}`).join(' · ')}</span>;
}

/** Discoveries of every source (live through MIGRATION_UPDATED), open / cancel / delete / plan from it. */
export function DiscoveriesTab({ sources, sourceFilter, onSourceFilter, onPlanCreated }: {
  sources: MigrationSource[];
  sourceFilter: number | null;
  onSourceFilter: (id: number | null) => void;
  onPlanCreated: () => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [items, setItems] = useState<MigrationDiscovery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [planFrom, setPlanFrom] = useState<MigrationDiscovery | null>(null);
  const shownSources = sourceFilter != null ? sources.filter((s) => s.id === sourceFilter) : sources;
  const sourceKey = shownSources.map((s) => s.id).join(',');

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    const ids = sourceKey ? sourceKey.split(',').map(Number) : [];
    const res = await Promise.allSettled(ids.map((id) => migrationApi.listDiscoveries(id)));
    if (n !== seq.current) return;
    const ok = res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    const failed = res.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    setItems(ok.sort((a, b) => b.id - a.id));
    setError(failed && ok.length === 0 ? loadErrorOf(t, failed.reason, t('migration.discoveries.loadFailed') || 'Failed to load the discoveries') : null);
    setLoading(false);
  }, [sourceKey, t]);
  useEffect(() => { setLoading(true); void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.MIGRATION_UPDATED], () => { void load(); }, (_e, p) => (p as MigrationUpdatedPayload | null)?.entity === 'discovery', 700);

  const sourceName = (id: number) => sources.find((s) => s.id === id)?.name ?? `#${id}`;
  const { sorted: sortedItems, sort } = useTableSort(items, {
    id: (d) => d.id, source: (d) => sourceName(d.sourceId), status: (d) => d.status,
    progress: (d) => progressPct(d.progress.done, d.progress.total) ?? 0, inventory: (d) => d.counts?.accounts ?? null, started: (d) => d.startedAt ?? '',
  }, { key: 'id', dir: 'desc' });

  const cancel = async (d: MigrationDiscovery) => {
    if (!(await confirm({
      title: t('migration.discoveries.cancelTitle') || 'Cancel the discovery',
      message: t('migration.discoveries.cancelConfirm') || 'The discovery stops after the current read. Nothing was written on the source.',
      confirmLabel: t('migration.discoveries.cancel') || 'Cancel the discovery',
      danger: true,
    }))) return;
    setBusy(d.id);
    try {
      await migrationApi.cancelDiscovery(d.id);
      void load();
    } catch (err) {
      toastMigrationError(t, err, t('migration.discoveries.cancelFailed') || 'The discovery could not be cancelled');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (d: MigrationDiscovery) => {
    if (!(await confirm({
      title: t('migration.discoveries.deleteTitle') || 'Delete the discovery',
      message: t('migration.discoveries.deleteConfirm') || 'Delete this inventory? A discovery used by a plan cannot be deleted (rebase or delete the plan first).',
      danger: true,
    }))) return;
    setBusy(d.id);
    try {
      await migrationApi.deleteDiscovery(d.id);
      toast.success(t('migration.discoveries.deleted') || 'Discovery deleted');
      void load();
    } catch (err) {
      toastMigrationError(t, err, t('migration.discoveries.deleteFailed') || 'The discovery could not be deleted');
    } finally {
      setBusy(null);
    }
  };

  const start = async (sourceId: number) => {
    try {
      const d = await migrationApi.startDiscovery(sourceId);
      navigate(`/manage/migration/discoveries/${d.id}`);
    } catch (err) {
      toastMigrationError(t, err, t('migration.discoveries.startFailed') || 'The discovery could not start');
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {sources.length > 1 && (
          <select aria-label={t('migration.common.source') || 'Source'} value={sourceFilter ?? ''} onChange={(e) => onSourceFilter(e.target.value ? Number(e.target.value) : null)} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-64')}>
            <option value="">{t('migration.common.allSources') || 'All sources'}</option>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <p className="min-w-0 flex-1 text-sm text-text-muted">{t('migration.discoveries.description') || 'A discovery reads the whole CWP server (accounts, domains, vhosts, PHP, databases, mail, DNS, FTP, crons, certificates) and builds an inventory without any secret.'}</p>
        {sourceFilter != null && (
          <Button size="sm" onClick={() => { void start(sourceFilter); }}><Radar size={13} className="mr-1.5" />{t('migration.sources.discover') || 'Start a discovery'}</Button>
        )}
      </div>
      <LoadState
        loading={loading}
        error={error}
        empty={items.length === 0}
        emptyIcon={<Radar />}
        emptyText={sources.length === 0 ? (t('migration.discoveries.noSource') || 'Declare a source first.') : (t('migration.discoveries.empty') || 'No discovery yet: start one from a source whose host key is pinned.')}
      >
        <TableScroll className="rounded-xl bg-bg-secondary">
          <table className="w-full min-w-[960px] text-sm">
            <thead>
              <tr className={theadRowCls}>
                <SortTh k="id" sort={sort} className={thCls}>#</SortTh>
                <SortTh k="source" sort={sort} className={thCls}>{t('migration.common.source') || 'Source'}</SortTh>
                <SortTh k="status" sort={sort} className={thCls}>{t('migration.common.status') || 'Status'}</SortTh>
                <SortTh k="progress" sort={sort} className={`${thCls} w-56`}>{t('migration.discoveries.progress') || 'Progress'}</SortTh>
                <SortTh k="inventory" sort={sort} className={thCls}>{t('migration.discoveries.inventory') || 'Inventory'}</SortTh>
                <SortTh k="started" sort={sort} className={thCls}>{t('migration.common.startedFinished') || 'Started / finished'}</SortTh>
                <th className={`${thCls} w-36`}><span className="sr-only">{t('migration.common.actions') || 'Actions'}</span></th>
              </tr>
            </thead>
            <tbody>
              {sortedItems.map((d) => {
                const pct = progressPct(d.progress.done, d.progress.total);
                return (
                  <tr key={d.id} className="transition-colors hover:bg-bg-hover">
                    <td className={tdCls}><Link to={`/manage/migration/discoveries/${d.id}`} className="font-mono text-xs text-accent hover:underline">#{d.id}</Link></td>
                    <td className={`${tdCls} text-xs text-text-secondary`}>{sourceName(d.sourceId)}</td>
                    <td className={tdCls}>
                      <DiscoveryStatusPill status={d.status} />
                      {d.error && <div className="mt-1 max-w-[240px] truncate text-[11px] text-status-down" title={d.error}>{d.error}</div>}
                    </td>
                    <td className={tdCls}>
                      {d.status === 'running' ? (
                        <div className="space-y-1">
                          <div className="flex justify-between text-[11px] text-text-muted">
                            <span>{d.phase ? discoveryPhaseLabel(t, d.phase) : '…'}</span>
                            <span className="font-mono">{pct != null ? `${pct}%` : ''}</span>
                          </div>
                          <ProgressBar pct={pct} />
                        </div>
                      ) : <span className="font-mono text-[11px] text-text-muted">{d.progress.done}/{d.progress.total}</span>}
                    </td>
                    <td className={tdCls}><DiscoveryCountsSummary d={d} /></td>
                    <td className={`${tdCls} font-mono text-[11px] text-text-muted`}>{formatDateTime(d.startedAt, i18n.language)}<br />{formatDateTime(d.finishedAt, i18n.language)}</td>
                    <td className={`${tdCls} text-right`}>
                      <div className="flex items-center justify-end gap-1.5">
                        <Button size="sm" variant="secondary" onClick={() => navigate(`/manage/migration/discoveries/${d.id}`)}><Eye size={13} className="mr-1.5" />{t('migration.common.open') || 'Open'}</Button>
                        <ActionMenu
                          label={t('migration.common.actions') || 'Actions'}
                          items={[
                            { key: 'plan', icon: <FileStack size={14} />, label: t('migration.plans.createFrom') || 'Create a plan', onClick: () => setPlanFrom(d), disabled: d.status !== 'done' },
                            { key: 'cancel', icon: <Square size={14} />, label: t('migration.discoveries.cancel') || 'Cancel the discovery', onClick: () => { void cancel(d); }, hidden: d.status !== 'running', disabled: busy === d.id },
                            { key: 'delete', icon: <Trash2 size={14} />, label: t('common.delete') || 'Delete', onClick: () => { void remove(d); }, danger: true, disabled: d.status === 'running' || busy === d.id, separator: true },
                          ]}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      </LoadState>
      <CreatePlanModal
        discovery={planFrom}
        onClose={() => setPlanFrom(null)}
        onCreated={(p) => { setPlanFrom(null); onPlanCreated(); navigate(`/manage/migration/plans/${p.id}`); }}
      />
    </div>
  );
}
