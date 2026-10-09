import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { ChevronLeft, ChevronRight, DatabaseBackup, RotateCcw, Trash2 } from 'lucide-react';
import type { DbSnapshot, Site } from '@oblimint/shared';
import { snapshotsApi } from '@/api/maintenance.api';
import { useHostingMe } from '@/store/hostingStore';
import { IconButton } from '@/components/common/IconButton';
import { TableScroll } from '@/components/common/TableScroll';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, thCls, theadRowCls } from '@/components/hosting/hostingUi';
import { formatDateTime } from '@/components/sites/siteForm';
import { SnapshotStatusBadge, useSnapshotReasonLabel } from './MaintenanceBadges';
import { formatBytes } from './maintenanceFormat';
import { isNotImplemented, maintenanceErrorMessage, toastMaintenanceError } from './maintenanceErrors';

const PAGE = 20;

/** Database snapshots of the site (taken before windows / updates): restore, delete (databases.manage). */
export function SnapshotsCard({ site, tick }: { site: Site; tick: number }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const { can } = useHostingMe();
  const canManage = can('databases.manage', site.accountId);
  const reasonLabel = useSnapshotReasonLabel();
  const [items, setItems] = useState<DbSnapshot[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await snapshotsApi.list(site.id, { limit: PAGE, offset });
      setItems(res.items);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setItems([]);
      setError(isNotImplemented(err) ? (t('maintenance.notAvailable') || 'Not available on this server yet.') : maintenanceErrorMessage(err, t, t('snapshots.loadFailed') || 'Failed to load the snapshots'));
    }
  }, [site.id, offset, t]);
  useEffect(() => { void load(); }, [load, tick]);

  const restore = async (s: DbSnapshot) => {
    if (!(await confirm({
      title: t('snapshots.restoreTitle') || 'Restore the snapshot',
      message: t('snapshots.restoreConfirm', {
        name: s.databaseName, date: formatDateTime(s.createdAt, i18n.language),
        defaultValue: 'Replace the current content of the database « {{name}} » with the snapshot of {{date}}? Everything written since is lost.',
      }),
      confirmLabel: t('snapshots.restore') || 'Restore',
      danger: true,
      requireText: s.databaseName,
    }))) return;
    setBusy(s.id);
    try {
      await snapshotsApi.restore(site.id, s.id);
      toast.success(t('snapshots.restored', { name: s.databaseName, defaultValue: 'Database {{name}} restored' }));
      void load();
    } catch (err) {
      toastMaintenanceError(err, t, t('snapshots.restoreFailed') || 'Failed to restore the snapshot');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (s: DbSnapshot) => {
    if (!(await confirm({
      title: t('snapshots.deleteTitle') || 'Delete the snapshot',
      message: t('snapshots.deleteConfirm', { name: s.databaseName, defaultValue: 'Delete this snapshot of « {{name}} »? It cannot be restored afterwards.' }),
      confirmLabel: t('common.delete') || 'Delete',
      danger: true,
    }))) return;
    setBusy(s.id);
    try {
      await snapshotsApi.delete(site.id, s.id);
      toast.success(t('snapshots.deleted') || 'Snapshot deleted');
      void load();
    } catch (err) {
      toastMaintenanceError(err, t, t('snapshots.deleteFailed') || 'Failed to delete the snapshot');
    } finally {
      setBusy(null);
    }
  };

  const origin = (s: DbSnapshot) => (s.windowId != null
    ? <Link to={`/sites/${site.id}/windows/${s.windowId}`} className="text-accent hover:underline">{t('snapshots.window', { id: s.windowId, defaultValue: 'window {{id}}' })}</Link>
    : s.adapterRunId != null ? <span>{t('snapshots.run', { id: s.adapterRunId, defaultValue: 'update run {{id}}' })}</span> : null);

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.floor(offset / PAGE) + 1;
  const actions = (s: DbSnapshot) => canManage ? (
    <div className="flex justify-end gap-1">
      <IconButton label={t('snapshots.restore') || 'Restore'} icon={<RotateCcw size={14} />} disabled={s.status !== 'ready' || busy === s.id} onClick={() => { void restore(s); }} />
      <IconButton variant="danger" label={t('common.delete') || 'Delete'} icon={<Trash2 size={14} />} disabled={s.status === 'deleted' || s.status === 'creating' || busy === s.id} onClick={() => { void remove(s); }} />
    </div>
  ) : null;

  return (
    <Card title={t('snapshots.title') || 'Database snapshots'} icon={<DatabaseBackup size={14} className="text-accent" />}>
      {error ? (
        <p className="text-xs text-text-muted">{error}</p>
      ) : items === null ? null : items.length === 0 ? (
        <p className="text-sm text-text-muted">{t('snapshots.empty') || 'No snapshot yet: one is taken for each database when a window opens or an update starts.'}</p>
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {items.map((s) => (
              <li key={s.id} className="rounded-lg bg-bg-primary px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-text-primary">{s.databaseName}</span>
                  <SnapshotStatusBadge status={s.status} />
                  {actions(s)}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-text-muted">
                  <span>{reasonLabel(s.reason)}</span>
                  {origin(s)}
                  <span className="font-mono">{formatBytes(s.sizeBytes)}</span>
                  <span className="font-mono">{formatDateTime(s.createdAt, i18n.language)}</span>
                </div>
                {s.error && <p className="mt-1 break-words text-[11px] text-red-400">{s.error}</p>}
              </li>
            ))}
          </ul>
          <TableScroll className="max-md:hidden">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className={theadRowCls}>
                  <th className={thCls}>{t('snapshots.col.database') || 'Database'}</th>
                  <th className={thCls}>{t('snapshots.col.status') || 'Status'}</th>
                  <th className={thCls}>{t('snapshots.col.reason') || 'Reason'}</th>
                  <th className={thCls}>{t('snapshots.col.size') || 'Size'}</th>
                  <th className={thCls}>{t('snapshots.col.created') || 'Created'}</th>
                  <th className={thCls}>{t('snapshots.col.expires') || 'Expires'}</th>
                  <th className={thCls} />
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id} className="transition-colors hover:bg-bg-hover">
                    <td className="px-4 py-2.5">
                      <div className="font-mono text-text-primary">{s.databaseName}</div>
                      <div className="text-[11px] text-text-muted">{s.engine}</div>
                    </td>
                    <td className="px-4 py-2.5">
                      <SnapshotStatusBadge status={s.status} />
                      {s.restoredAt && <div className="mt-0.5 text-[11px] text-text-muted">{t('snapshots.restoredAt', { date: formatDateTime(s.restoredAt, i18n.language), defaultValue: 'restored {{date}}' })}</div>}
                      {s.error && <div className="mt-0.5 max-w-[16rem] truncate text-[11px] text-red-400" title={s.error}>{s.error}</div>}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-text-secondary">
                      <div>{reasonLabel(s.reason)}</div>
                      <div className="text-text-muted">{origin(s)}</div>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-text-secondary">{formatBytes(s.sizeBytes)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-text-muted">{formatDateTime(s.createdAt, i18n.language)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-text-muted">{formatDateTime(s.expiresAt, i18n.language)}</td>
                    <td className="px-4 py-2.5">{actions(s)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          {pages > 1 && (
            <div className="mt-2 flex items-center justify-end gap-2 text-xs text-text-muted">
              <IconButton label={t('common.previous') || 'Previous'} icon={<ChevronLeft className="h-4 w-4" />} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} />
              <span className="font-mono">{page} / {pages}</span>
              <IconButton label={t('common.next') || 'Next'} icon={<ChevronRight className="h-4 w-4" />} disabled={page >= pages} onClick={() => setOffset(offset + PAGE)} />
            </div>
          )}
        </>
      )}
      {!canManage && items && items.length > 0 && (
        <p className="mt-2 text-xs text-text-muted">{t('snapshots.readOnly') || 'Restoring or deleting a snapshot needs the right to manage the databases.'}</p>
      )}
    </Card>
  );
}
