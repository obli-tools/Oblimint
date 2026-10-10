import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Eye, FileStack, Trash2 } from 'lucide-react';
import { HostingSocketEvents, type MigrationPlanSummary, type MigrationSource, type MigrationUpdatedPayload } from '@oblimint/shared';
import { migrationApi } from '@/api/migration.api';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { TableScroll } from '@/components/common/TableScroll';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Pill, selectCls, thCls, theadRowCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { formatBytes, formatDateTime } from '../migrationFormat';
import { LoadState, PlanStatusPill, loadErrorOf, tdCls, toastMigrationError, useByteUnits, type LoadError } from '../migrationUi';

export function StaleBadge() {
  const { t } = useTranslation();
  return <Pill tone="amber" title={t('migration.plan.staleHint') || 'The choices changed since the last computation: recompute before running.'}>{t('migration.plan.stale') || 'to recompute'}</Pill>;
}

/** Plans tab: every migration plan (dry-run totals, stale badge), open / delete. */
export function PlansTab({ sources, sourceFilter, onSourceFilter, reloadKey }: {
  sources: MigrationSource[];
  sourceFilter: number | null;
  onSourceFilter: (id: number | null) => void;
  reloadKey: number;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const units = useByteUnits();
  const [plans, setPlans] = useState<MigrationPlanSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const list = await migrationApi.listPlans(sourceFilter != null ? { sourceId: sourceFilter } : {});
      if (n !== seq.current) return;
      setPlans(list);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setPlans([]);
      setError(loadErrorOf(t, err, t('migration.plans.loadFailed') || 'Failed to load the plans'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [sourceFilter, t]);
  useEffect(() => { setLoading(true); void load(); }, [load, reloadKey]);
  useHostingEvents([HostingSocketEvents.MIGRATION_UPDATED], () => { void load(); }, (_e, p) => (p as MigrationUpdatedPayload | null)?.entity === 'plan', 800);

  const sourceName = (id: number) => sources.find((s) => s.id === id)?.name ?? `#${id}`;

  const remove = async (p: MigrationPlanSummary) => {
    if (!(await confirm({
      title: t('migration.plans.deleteTitle') || 'Delete the plan',
      message: t('migration.plans.deleteConfirm', { name: p.name, defaultValue: 'Delete {{name}}? A plan that already ran is archived instead (its runs, reports and object map are kept). Nothing is removed on the target.' }),
      danger: true,
    }))) return;
    setBusy(p.id);
    try {
      const r = await migrationApi.deletePlan(p.id);
      toast.success(r.archived ? (t('migration.plans.archived') || 'Plan archived (it already ran)') : (t('migration.plans.deleted') || 'Plan deleted'));
      void load();
    } catch (err) {
      toastMigrationError(t, err, t('migration.plans.deleteFailed') || 'The plan could not be deleted');
    } finally {
      setBusy(null);
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
        <p className="min-w-0 flex-1 text-sm text-text-muted">{t('migration.plans.description') || 'A plan turns an inventory into fully resolved actions (the dry-run). Create one from a finished discovery.'}</p>
      </div>
      <LoadState
        loading={loading}
        error={error}
        empty={plans.length === 0}
        emptyIcon={<FileStack />}
        emptyText={t('migration.plans.empty') || 'No plan yet: open a finished discovery and create a plan from it.'}
      >
        <TableScroll className="rounded-xl bg-bg-secondary">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className={theadRowCls}>
                <th className={thCls}>{t('migration.plans.name') || 'Name'}</th>
                <th className={thCls}>{t('migration.common.source') || 'Source'}</th>
                <th className={thCls}>{t('migration.plans.discovery') || 'Discovery'}</th>
                <th className={thCls}>{t('migration.common.status') || 'Status'}</th>
                <th className={thCls}>{t('migration.plans.totals') || 'Accounts selected / blocked'}</th>
                <th className={thCls}>{t('migration.plans.volume') || 'Volume'}</th>
                <th className={thCls}>{t('migration.plans.computedAt') || 'Computed'}</th>
                <th className={`${thCls} w-32`}><span className="sr-only">{t('migration.common.actions') || 'Actions'}</span></th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.id} className="transition-colors hover:bg-bg-hover">
                  <td className={tdCls}>
                    <Link to={`/manage/migration/plans/${p.id}`} className="font-medium text-text-primary hover:text-accent">{p.name}</Link>
                    <div className="mt-0.5">{p.stale && <StaleBadge />}</div>
                  </td>
                  <td className={`${tdCls} text-xs text-text-secondary`}>{sourceName(p.sourceId)}</td>
                  <td className={tdCls}><Link to={`/manage/migration/discoveries/${p.discoveryId}`} className="font-mono text-xs text-accent hover:underline">#{p.discoveryId}</Link></td>
                  <td className={tdCls}><PlanStatusPill status={p.status} /></td>
                  <td className={`${tdCls} font-mono text-xs`}>
                    {p.totals ? (
                      <>
                        <span className="text-text-primary">{p.totals.selected}</span>
                        <span className="text-text-muted"> / {p.totals.accounts}</span>
                        {p.totals.blocked > 0 && <span className="ml-2 text-status-down">{t('migration.plans.blockedCount', { count: p.totals.blocked, defaultValue: '{{count}} blocked' })}</span>}
                      </>
                    ) : '—'}
                  </td>
                  <td className={`${tdCls} font-mono text-[11px] text-text-muted`}>
                    {p.totals ? formatBytes(p.totals.filesBytes + p.totals.dbBytes + p.totals.mailBytes, units) : '—'}
                  </td>
                  <td className={`${tdCls} font-mono text-[11px] text-text-muted`}>{formatDateTime(p.computedAt, i18n.language)}</td>
                  <td className={`${tdCls} text-right`}>
                    <div className="flex items-center justify-end gap-1">
                      <Button size="sm" variant="secondary" onClick={() => navigate(`/manage/migration/plans/${p.id}`)}><Eye size={13} className="mr-1.5" />{t('migration.common.open') || 'Open'}</Button>
                      <IconButton label={t('common.delete') || 'Delete'} icon={<Trash2 size={14} />} variant="danger" disabled={busy === p.id} onClick={() => { void remove(p); }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </LoadState>
    </div>
  );
}
