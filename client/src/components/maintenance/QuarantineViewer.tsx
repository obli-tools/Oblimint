import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, ChevronLeft, ChevronRight, FileLock2, Loader2, RotateCcw, ShieldAlert, Trash2 } from 'lucide-react';
import {
  HostingSocketEvents, type HostingAccount, type QuarantineItem, type QuarantineItemDetail, type QuarantineStatus, type Site,
} from '@oblimint/shared';
import { quarantineApi } from '@/api/maintenance.api';
import { accountsApi } from '@/api/accounts.api';
import { sitesApi } from '@/api/sites.api';
import { useHostingMe } from '@/store/hostingStore';
import { useTenantStore } from '@/store/tenantStore';
import { Button } from '@/components/common/Button';
import { Drawer } from '@/components/common/Drawer';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { TableScroll } from '@/components/common/TableScroll';
import { useConfirm, usePrompt } from '@/components/common/ConfirmDialog';
import { EmptyState, InfoRow, selectCls, thCls, theadRowCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { formatDateTime } from '@/components/sites/siteForm';
import { cn } from '@/utils/cn';
import { QuarantineStatusBadge, useQuarantineReasonLabel, useQuarantineSourceLabel } from './MaintenanceBadges';
import { bytesToText, decodeBase64, formatBytes, hexDump } from './maintenanceFormat';
import { apiErrorCode, apiErrorDetails, isNotImplemented, maintenanceErrorMessage, toastMaintenanceError } from './maintenanceErrors';

const PAGE = 25;
const REASON_MAX = 500;

/**
 * Quarantine viewer (/maintenance?tab=quarantine): files moved out of the
 * typed data paths or written by the application in supervised mode. Staff
 * restore or delete (audited); clients read only, never see the content.
 */
export function QuarantineViewer() {
  const { t, i18n } = useTranslation();
  const reasonLabel = useQuarantineReasonLabel();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);

  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [siteId, setSiteId] = useState<number | null>(null);
  const [status, setStatus] = useState<QuarantineStatus | ''>('quarantined');
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<QuarantineItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openItem, setOpenItem] = useState<QuarantineItem | null>(null);
  const [detailTick, setDetailTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    accountsApi.list().then((l) => { if (!cancelled) setAccounts(l); }).catch(() => { if (!cancelled) setAccounts([]); });
    return () => { cancelled = true; };
  }, [currentTenantId]);
  useEffect(() => {
    let cancelled = false;
    sitesApi.list(accountId ? { accountId } : {}).then((l) => { if (!cancelled) setSites(l); }).catch(() => { if (!cancelled) setSites([]); });
    return () => { cancelled = true; };
  }, [accountId, currentTenantId]);

  const load = useCallback(async () => {
    try {
      const res = await quarantineApi.list({
        accountId: accountId ?? undefined, siteId: siteId ?? undefined, status: status || undefined, limit: PAGE, offset,
      });
      setItems(res.items);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setItems([]);
      setTotal(0);
      setError(isNotImplemented(err) ? (t('maintenance.notAvailable') || 'Not available on this server yet.') : maintenanceErrorMessage(err, t, t('quarantine.loadFailed') || 'Failed to load the quarantine'));
    } finally {
      setLoading(false);
    }
  }, [accountId, siteId, status, offset, t]);
  useEffect(() => { setLoading(true); void load(); }, [load, currentTenantId]);
  useHostingEvents([HostingSocketEvents.QUARANTINE_UPDATED], () => { void load(); setDetailTick((n) => n + 1); }, undefined, 800);

  const setFilter = (patch: { accountId?: number | null; siteId?: number | null; status?: QuarantineStatus | '' }) => {
    if (patch.accountId !== undefined) { setAccountId(patch.accountId); setSiteId(null); }
    if (patch.siteId !== undefined) setSiteId(patch.siteId);
    if (patch.status !== undefined) setStatus(patch.status);
    setOffset(0);
  };

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.floor(offset / PAGE) + 1;
  const where = (q: QuarantineItem) => `${q.siteName ?? q.accountUsername}`;

  return (
    <div className="space-y-3">
      <p className="text-sm text-text-muted">
        {t('quarantine.explain') || 'Files refused in a typed data path (wrong extension, PHP content, polyglot…) or executable files written outside a window in supervised mode. Nothing is deleted automatically: the staff restores or deletes them.'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {accounts.length > 1 && (
          <select aria-label={t('quarantine.filter.account') || 'Account'} value={accountId ?? ''} onChange={(e) => setFilter({ accountId: e.target.value ? Number(e.target.value) : null })} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-52')}>
            <option value="">{t('quarantine.filter.allAccounts') || 'All accounts'}</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.username}</option>)}
          </select>
        )}
        {sites.length > 1 && (
          <select aria-label={t('quarantine.filter.site') || 'Site'} value={siteId ?? ''} onChange={(e) => setFilter({ siteId: e.target.value ? Number(e.target.value) : null })} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-52')}>
            <option value="">{t('quarantine.filter.allSites') || 'All sites'}</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <select aria-label={t('quarantine.filter.status') || 'Status'} value={status} onChange={(e) => setFilter({ status: e.target.value as QuarantineStatus | '' })} className={cn(selectCls, 'w-full bg-bg-secondary sm:w-44')}>
          <option value="quarantined">{t('quarantine.status.quarantined') || 'In quarantine'}</option>
          <option value="restored">{t('quarantine.status.restored') || 'Restored'}</option>
          <option value="deleted">{t('quarantine.status.deleted') || 'Deleted'}</option>
          <option value="">{t('quarantine.filter.allStatuses') || 'All statuses'}</option>
        </select>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><LoadingSpinner /></div>
      ) : error ? (
        <EmptyState icon={<AlertTriangle />} text={error} />
      ) : items.length === 0 ? (
        <EmptyState icon={<FileLock2 />} text={t('quarantine.empty') || 'No file in quarantine.'} />
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {items.map((q) => (
              <li key={q.id}>
                <button type="button" onClick={() => setOpenItem(q)} className="w-full rounded-xl bg-bg-secondary px-3 py-2.5 text-left hover:bg-bg-hover">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-primary">{q.path}</span>
                    <QuarantineStatusBadge status={q.status} />
                  </div>
                  <div className="mt-1 text-xs text-text-secondary">{reasonLabel(q.reason)}</div>
                  <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-text-muted">
                    <span>{where(q)}</span>
                    <span className="font-mono">{formatBytes(q.sizeBytes)}</span>
                    <span className="font-mono">{formatDateTime(q.detectedAt, i18n.language)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <TableScroll className="rounded-xl bg-bg-secondary max-md:hidden">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className={theadRowCls}>
                  <th className={thCls}>{t('quarantine.col.detected') || 'Detected'}</th>
                  <th className={thCls}>{t('quarantine.col.site') || 'Site'}</th>
                  <th className={thCls}>{t('quarantine.col.path') || 'Path'}</th>
                  <th className={thCls}>{t('quarantine.col.reason') || 'Reason'}</th>
                  <th className={thCls}>{t('quarantine.col.type') || 'Type'}</th>
                  <th className={thCls}>{t('quarantine.col.size') || 'Size'}</th>
                  <th className={thCls}>{t('quarantine.col.status') || 'Status'}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((q) => (
                  <tr key={q.id} onClick={() => setOpenItem(q)} className="cursor-pointer transition-colors hover:bg-bg-hover">
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-text-muted">{formatDateTime(q.detectedAt, i18n.language)}</td>
                    <td className="max-w-[12rem] px-4 py-2.5">
                      <div className="truncate text-text-primary">{q.siteName ?? '—'}</div>
                      <div className="truncate font-mono text-[11px] text-text-muted">{q.accountUsername}</div>
                    </td>
                    <td className="max-w-[18rem] px-4 py-2.5"><span className="block truncate font-mono text-xs text-text-primary" title={q.path}>{q.path}</span></td>
                    <td className="max-w-[16rem] px-4 py-2.5 text-xs text-text-secondary">{reasonLabel(q.reason)}</td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-text-muted">{q.detectedType ?? '—'}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-text-secondary">{formatBytes(q.sizeBytes)}</td>
                    <td className="px-4 py-2.5"><QuarantineStatusBadge status={q.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          {pages > 1 && (
            <div className="flex items-center justify-end gap-2 text-xs text-text-muted">
              <IconButton label={t('common.previous') || 'Previous'} icon={<ChevronLeft className="h-4 w-4" />} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} />
              <span className="font-mono">{page} / {pages}</span>
              <IconButton label={t('common.next') || 'Next'} icon={<ChevronRight className="h-4 w-4" />} disabled={page >= pages} onClick={() => setOffset(offset + PAGE)} />
            </div>
          )}
        </>
      )}

      <QuarantineDrawer item={openItem} tick={detailTick} onClose={() => setOpenItem(null)} onChanged={() => { void load(); setDetailTick((n) => n + 1); }} />
    </div>
  );
}

function QuarantineDrawer({ item, tick, onClose, onChanged }: { item: QuarantineItem | null; tick: number; onClose: () => void; onChanged: () => void }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const { me, can } = useHostingMe();
  const reasonLabel = useQuarantineReasonLabel();
  const sourceLabel = useQuarantineSourceLabel();
  const [detail, setDetail] = useState<QuarantineItemDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'restore' | 'delete' | null>(null);
  const [view, setView] = useState<'text' | 'hex'>('text');
  const itemId = item?.id ?? null;

  useEffect(() => {
    if (itemId === null) { setDetail(null); return undefined; }
    let cancelled = false;
    setError('');
    quarantineApi.get(itemId)
      .then((d) => { if (!cancelled) { setDetail(d); setView(d.preview?.text ? 'text' : 'hex'); } })
      .catch((err) => { if (!cancelled) setError(maintenanceErrorMessage(err, t)); });
    return () => { cancelled = true; };
  }, [itemId, tick, t]);

  const q: QuarantineItem | null = (detail && detail.id === itemId ? detail : null) ?? item;
  const preview = detail && detail.id === itemId ? detail.preview : null;
  const bytes = useMemo(() => (preview ? decodeBase64(preview.base64) : null), [preview]);
  const staffActions = !!q && me?.kind === 'staff' && can('files.manage', q.accountId) && q.status === 'quarantined';

  const restore = async () => {
    if (!q) return;
    const reason = await prompt({
      title: t('quarantine.restoreTitle') || 'Restore the file',
      message: t('quarantine.restoreMessage', { path: q.path, defaultValue: 'Put {{path}} back at its original place? Make sure it is legitimate: it will be served (and possibly executed) again. Reason (optional, audited):' }),
      multiline: true,
      maxLength: REASON_MAX,
      plain: false,
      confirmLabel: t('quarantine.restore') || 'Restore',
    });
    if (reason === null) return;
    setBusy('restore');
    const run = async (overwrite: boolean) => {
      await quarantineApi.restore(q.id, { reason: reason.trim() || null, overwrite });
      toast.success(t('quarantine.restored') || 'File restored');
      onChanged();
    };
    try {
      await run(false);
    } catch (err) {
      if (apiErrorCode(err) === 'restoreConflict') {
        const path = String(apiErrorDetails(err).path ?? q.path);
        const ok = await confirm({
          title: t('quarantine.overwriteTitle') || 'A file exists at this path',
          message: t('quarantine.overwriteConfirm', { path, defaultValue: 'A file now exists at {{path}}. Replace it with the quarantined file?' }),
          confirmLabel: t('quarantine.overwrite') || 'Replace',
          danger: true,
        });
        if (ok) {
          try { await run(true); } catch (e2) { toastMaintenanceError(e2, t, t('quarantine.restoreFailed') || 'Failed to restore the file'); }
        }
      } else {
        toastMaintenanceError(err, t, t('quarantine.restoreFailed') || 'Failed to restore the file');
      }
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!q) return;
    if (!(await confirm({
      title: t('quarantine.deleteTitle') || 'Delete the file',
      message: t('quarantine.deleteConfirm', { path: q.path, defaultValue: 'Permanently delete the quarantined copy of {{path}}? The entry stays in the list as « deleted » (audited).' }),
      confirmLabel: t('common.delete') || 'Delete',
      danger: true,
    }))) return;
    setBusy('delete');
    try {
      await quarantineApi.delete(q.id);
      toast.success(t('quarantine.deleted') || 'File deleted');
      onChanged();
    } catch (err) {
      toastMaintenanceError(err, t, t('quarantine.deleteFailed') || 'Failed to delete the file');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Drawer
      open={item !== null}
      onClose={onClose}
      side="right"
      size="full"
      className="sm:w-[min(95vw,760px)]"
      icon={<ShieldAlert className="h-4 w-4 text-accent" />}
      title={t('quarantine.drawerTitle') || 'Quarantined file'}
      headerExtra={q ? <QuarantineStatusBadge status={q.status} /> : undefined}
      footer={staffActions ? (
        <>
          <Button size="sm" variant="secondary" loading={busy === 'delete'} disabled={busy !== null} onClick={() => { void remove(); }} className="text-status-down">
            <Trash2 size={14} className="mr-1" />{t('common.delete') || 'Delete'}
          </Button>
          <Button size="sm" loading={busy === 'restore'} disabled={busy !== null} onClick={() => { void restore(); }}>
            <RotateCcw size={14} className="mr-1" />{t('quarantine.restore') || 'Restore'}
          </Button>
        </>
      ) : undefined}
    >
      {!q ? null : (
        <div className="space-y-5">
          <code className="block break-all rounded-lg bg-bg-primary px-3 py-2 font-mono text-sm text-text-primary">{q.path}</code>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <InfoRow label={t('quarantine.col.reason') || 'Reason'}>{reasonLabel(q.reason)}</InfoRow>
            <InfoRow label={t('quarantine.source.title') || 'Source'}>{sourceLabel(q.source)}</InfoRow>
            <InfoRow label={t('quarantine.col.site') || 'Site'}>{q.siteName ?? '—'} <span className="font-mono text-xs text-text-muted">({q.accountUsername})</span></InfoRow>
            <InfoRow label={t('quarantine.dataPath') || 'Data path'} mono>{q.dataPath ?? '—'}</InfoRow>
            <InfoRow label={t('quarantine.col.type') || 'Type'} mono>{q.detectedType ?? '—'}</InfoRow>
            <InfoRow label={t('quarantine.col.size') || 'Size'} mono>{formatBytes(q.sizeBytes)}</InfoRow>
            <InfoRow label={t('quarantine.col.detected') || 'Detected'}>{formatDateTime(q.detectedAt, i18n.language)}</InfoRow>
            <InfoRow label={t('quarantine.resolved') || 'Resolved'}>
              {q.resolvedAt ? `${formatDateTime(q.resolvedAt, i18n.language)}${q.resolvedByName ? ` · ${q.resolvedByName}` : ''}` : '—'}
            </InfoRow>
          </div>
          <InfoRow label="SHA-256" mono><span className="break-all text-xs">{q.sha256}</span></InfoRow>
          {q.detail && <p className="whitespace-pre-wrap break-words rounded-lg bg-bg-tertiary/60 px-3 py-2 text-xs text-text-secondary">{q.detail}</p>}

          <section>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-mono uppercase tracking-[0.12em] text-text-muted">{t('quarantine.preview') || 'Preview'}</span>
              {preview && (
                <SegmentedTabs
                  size="sm"
                  value={view}
                  onChange={setView}
                  tabs={[
                    { id: 'text', label: t('quarantine.text') || 'Text', disabled: !preview.text },
                    { id: 'hex', label: t('quarantine.hex') || 'Hex' },
                  ]}
                />
              )}
            </div>
            {error ? (
              <p className="text-xs text-red-400">{error}</p>
            ) : !detail ? (
              <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
            ) : !preview || !bytes ? (
              <p className="text-xs text-text-muted">{t('quarantine.noPreview') || 'The content is shown to the platform staff only.'}</p>
            ) : (
              <>
                <pre className="max-h-[50vh] overflow-auto overscroll-contain whitespace-pre rounded-lg bg-bg-primary/70 p-3 font-mono text-[11px] leading-relaxed text-text-secondary">
                  {view === 'text' && preview.text ? bytesToText(bytes) : hexDump(bytes, bytes.length)}
                </pre>
                {preview.truncated && <p className="mt-1 text-xs text-amber-400">{t('quarantine.truncated', { size: formatBytes(bytes.length), defaultValue: 'Only the first {{size}} are shown.' })}</p>}
              </>
            )}
          </section>
          {!staffActions && q.status === 'quarantined' && (
            <p className="text-xs text-text-muted">{t('quarantine.clientHint') || 'Only the platform staff can restore or delete a quarantined file: contact the support if this file is legitimate.'}</p>
          )}
        </div>
      )}
    </Drawer>
  );
}
