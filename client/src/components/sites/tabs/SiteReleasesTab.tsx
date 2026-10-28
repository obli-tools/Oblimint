import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronLeft, ChevronRight, CopyCheck, History, RotateCcw, Rocket, ShieldAlert, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { HostingSocketEvents, type Release } from '@oblimint/shared';
import { releasesApi } from '@/api/releases.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { GroupedTable, flatNodes } from '@/components/common/GroupedTable';
import { useConfirm, usePrompt } from '@/components/common/ConfirmDialog';
import { Pill, ReleaseStatusBadge, ScanVerdictChip } from '../SiteBadges';
import { ReleaseDrawer, triggerLabel } from '../ReleaseDrawer';
import { formatDateTime } from '../siteForm';
import { apiErrorCode, isNotImplemented, siteErrorMessage, toastSiteError } from '../siteErrors';
import { useHostingEvent } from '../useHostingEvent';
import type { SiteTabProps } from './types';

const PAGE_SIZE = 25;
/** Server limit of the reject reason (releases rejectBody). */
const REJECT_REASON_MAX = 500;

/**
 * P3: the pre-publication scan blocked this release and no staff override was
 * recorded. A plain approve always fails with 409 riskBlocked: only the audited
 * override of the ReleaseDrawer (staff) publishes it.
 */
export function isScanBlocked(r: Pick<Release, 'scan'>): boolean {
  return !!r.scan?.blocked && !r.scan.override;
}

export function SiteReleasesTab({ site, reloadSite, onPublish, tick }: SiteTabProps & { tick: number }) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const { can } = useHostingMe();
  const canPublish = can('releases.publish', site.accountId);
  const canApprove = can('releases.approve', site.accountId);
  const canManageFiles = can('files.manage', site.accountId);

  const [items, setItems] = useState<Release[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [drawerTick, setDrawerTick] = useState(0);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await releasesApi.list(site.id, { limit: PAGE_SIZE, offset });
      setItems(res.items);
      setTotal(res.total);
      setError('');
    } catch (err) {
      setError(isNotImplemented(err) ? (t('sites.errors.notImplemented') || 'This feature is not available on this server yet.') : siteErrorMessage(err, t));
    } finally {
      setLoading(false);
    }
  }, [site.id, offset, t]);

  useEffect(() => { void load(); }, [load, tick]);

  useHostingEvent<{ siteId: number; releaseId: number; status: string }>(HostingSocketEvents.RELEASE_UPDATED, (p) => {
    if (p.siteId !== site.id) return;
    void load(true);
    if (p.releaseId === openId) setDrawerTick((n) => n + 1);
  });

  const afterAction = async () => {
    await Promise.all([load(true), reloadSite()]);
    setDrawerTick((n) => n + 1);
  };

  const approve = async (r: Release) => {
    if (!(await confirm({
      title: t('releases.actions.approve') || 'Approve',
      message: t('releases.actions.approveConfirm', { number: r.number, defaultValue: 'Approve release #{{number}}? It will be published right away.' }),
      confirmLabel: t('releases.actions.approve') || 'Approve',
    }))) return;
    setBusyId(r.id);
    try {
      await releasesApi.approve(site.id, r.id);
      toast.success(t('releases.actions.approved', { number: r.number, defaultValue: 'Release #{{number}} approved' }));
      await afterAction();
    } catch (err) {
      toastSiteError(err, t);
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (r: Release) => {
    const reason = await prompt({
      title: t('releases.actions.rejectTitle', { number: r.number, defaultValue: 'Reject release #{{number}}' }),
      message: t('releases.actions.rejectMessage') || 'The release will never be published. Reason (optional, kept in its log):',
      multiline: true,
      maxLength: REJECT_REASON_MAX,
      plain: false,
      confirmLabel: t('releases.actions.reject') || 'Reject',
    });
    if (reason === null) return;
    if (reason.trim().length > REJECT_REASON_MAX) {
      toast.error(t('releases.actions.rejectReasonTooLong', { max: REJECT_REASON_MAX, defaultValue: 'The reason is limited to {{max}} characters.' }));
      return;
    }
    setBusyId(r.id);
    try {
      await releasesApi.reject(site.id, r.id, reason.trim() || undefined);
      toast.success(t('releases.actions.rejected', { number: r.number, defaultValue: 'Release #{{number}} rejected' }));
      await afterAction();
    } catch (err) {
      toastSiteError(err, t);
    } finally {
      setBusyId(null);
    }
  };

  const rollback = async (r: Release) => {
    if (!(await confirm({
      title: t('releases.actions.rollback') || 'Restore this release',
      message: t('releases.actions.rollbackConfirm', {
        number: r.number,
        defaultValue: 'Put release #{{number}} back online? The switch is instant; if its health check fails, the current release is kept.',
      }),
      confirmLabel: t('releases.actions.rollbackShort') || 'Restore',
    }))) return;
    setBusyId(r.id);
    try {
      await releasesApi.rollback(site.id, r.id);
      toast.success(t('releases.actions.rolledBack', { number: r.number, defaultValue: 'Release #{{number}} is back online' }));
      await afterAction();
    } catch (err) {
      if (apiErrorCode(err) === 'rollbackHealthcheckFailed') {
        toast.error(siteErrorMessage(err, t), { duration: 10_000 });
        await afterAction();
      } else {
        toastSiteError(err, t);
      }
    } finally {
      setBusyId(null);
    }
  };

  /** Copies a ready release into the staging (never publishes); unpublished changes are discarded only after a second confirmation. */
  const restoreToStaging = async (r: Release) => {
    if (!(await confirm({
      title: t('releases.actions.restoreStaging') || 'Copy into the staging',
      message: t('releases.actions.restoreStagingConfirm', {
        number: r.number,
        defaultValue: 'Make the staging folder exactly the code of release #{{number}}? Nothing goes live; data paths are not touched. In automatic publication mode, the next upload publishes it.',
      }),
      confirmLabel: t('releases.actions.restoreStagingShort') || 'Copy',
    }))) return;
    setBusyId(r.id);
    const run = async (discardPending: boolean) => {
      const res = await releasesApi.restoreToStaging(site.id, r.id, { discardPending });
      if (res.status === 'running') toast.success(t('releases.actions.restoreStagingRunning', { number: r.number, defaultValue: 'Copy of release #{{number}} into the staging started' }));
      else {
        toast.success(t('releases.actions.restoreStagingDone', { number: r.number, defaultValue: 'Release #{{number}} copied into the staging' }));
        if (res.modeLostCount > 0) {
          toast.error(t('releases.actions.restoreStagingModeLost', {
            count: res.modeLostCount, paths: res.modeLost.slice(0, 5).join(', '),
            defaultValue: '{{count}} file(s) were copied without their executable bit ({{paths}}…): make them executable again in the staging (chmod +x over SFTP) before publishing.',
          }), { duration: 12000 });
        }
      }
    };
    try {
      try {
        await run(false);
      } catch (err) {
        if (apiErrorCode(err) !== 'stagingHasPendingChanges') throw err;
        const count = Number((err as { response?: { data?: { details?: { count?: unknown } } } }).response?.data?.details?.count ?? 0);
        if (!(await confirm({
          title: t('releases.actions.restoreStaging') || 'Copy into the staging',
          message: t('releases.actions.discardPendingConfirm', {
            count,
            defaultValue: 'The staging holds {{count}} unpublished change(s). Discard them? A copy is kept on the server.',
          }),
          confirmLabel: t('releases.actions.discardPending') || 'Discard the unpublished changes',
          danger: true,
        }))) return;
        await run(true);
      }
      await afterAction();
    } catch (err) {
      toastSiteError(err, t);
    } finally {
      setBusyId(null);
    }
  };

  const renderActions = (r: Release, inDrawer = false) => {
    const busy = busyId === r.id;
    const out = [];
    if (r.status === 'awaiting_approval' && canApprove) {
      if (!isScanBlocked(r)) out.push(
        <Button key="approve" size="sm" onClick={() => void approve(r)} disabled={busy} className="bg-green-600 hover:bg-green-500">
          <Check size={14} className="mr-1" />{t('releases.actions.approve') || 'Approve'}
        </Button>,
      );
      out.push(
        <Button key="reject" size="sm" variant="secondary" onClick={() => void reject(r)} disabled={busy}>
          <X size={14} className="mr-1" />{t('releases.actions.reject') || 'Reject'}
        </Button>,
      );
    }
    if (r.status === 'ready' && !r.isCurrent && canPublish) {
      out.push(
        <Button key="rollback" size="sm" variant={inDrawer ? 'primary' : 'secondary'} onClick={() => void rollback(r)} loading={busy}>
          <RotateCcw size={14} className="mr-1" />{t('releases.actions.rollback') || 'Restore this release'}
        </Button>,
      );
    }
    if (r.status === 'ready' && canManageFiles && (inDrawer || (r.isCurrent && site.rolledBackFromNumber !== null))) {
      out.push(
        <Button key="restoreStaging" size="sm" variant="secondary" onClick={() => void restoreToStaging(r)} loading={busy}>
          <CopyCheck size={14} className="mr-1" />{t('releases.actions.restoreStaging') || 'Copy into the staging'}
        </Button>,
      );
    }
    return out.length ? <>{out}</> : null;
  };

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-muted">
          {t('releases.explain') || 'Each publication freezes the staging folder into an immutable release. The current one is served read-only; earlier ones can be restored instantly.'}
        </p>
        {canPublish && (
          <Button size="sm" onClick={onPublish}>
            <Rocket size={14} className="mr-1" />{t('releases.publish.button') || 'Publish'}
          </Button>
        )}
      </div>

      {error ? (
        <div className="rounded-xl bg-bg-secondary px-4 py-6 text-center text-sm text-text-muted">{error}</div>
      ) : loading && items.length === 0 ? (
        <p className="text-sm text-text-muted">{t('common.loading') || 'Loading...'}</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl bg-bg-secondary px-6 py-10 text-center">
          <History className="mx-auto mb-3 h-8 w-8 text-text-muted" />
          <p className="text-sm text-text-secondary">{t('releases.empty') || 'No release yet: upload the site to the staging folder, then publish.'}</p>
        </div>
      ) : (
        <GroupedTable<Release>
          storageKey="site-releases"
          singleGroupFlat
          minWidth={1040}
          defaultSort={{ column: 'number', dir: 'desc' }}
          groups={[{ key: 'all', label: '', sortLabel: '', nodes: flatNodes(items, (r) => r.id) }]}
          onRowClick={(r) => setOpenId(r.id)}
          rowClassName={(r) => r.isCurrent && 'bg-accent/[0.04]'}
          columns={[
            {
              id: 'number', header: '#', tdClassName: 'whitespace-nowrap', sort: (r) => r.number,
              cell: (r) => (
                <>
                  <span className="font-mono font-semibold text-text-primary">#{r.number}</span>
                  {r.isCurrent && <Pill tone="accent" className="ml-2 text-[10px]">{t('releases.current') || 'current'}</Pill>}
                  {r.isCurrent && site.rolledBackFromNumber !== null && (
                    <Pill tone="amber" className="ml-1 text-[10px]">
                      {t('releases.rolledBackFrom', { number: site.rolledBackFromNumber, defaultValue: 'Rollback (from #{{number}})' })}
                    </Pill>
                  )}
                </>
              ),
            },
            { id: 'status', header: t('releases.fields.status') || 'Status', sort: (r) => r.status, cell: (r) => <ReleaseStatusBadge status={r.status} /> },
            {
              id: 'trigger', header: t('releases.fields.trigger') || 'Trigger', tdClassName: 'text-xs text-text-secondary', sort: (r) => r.trigger,
              cell: (r) => (
                <>
                  <div>{triggerLabel(r.trigger, t)}</div>
                  {r.authorName && <div className="text-text-muted">{r.authorName}</div>}
                </>
              ),
            },
            {
              id: 'message', header: t('releases.fields.message') || 'Message', tdClassName: 'max-w-[18rem]', sort: (r) => r.message ?? '',
              cell: (r) => (
                <>
                  <span className="line-clamp-2 break-words text-xs text-text-secondary" title={r.message ?? undefined}>{r.message || <span className="text-text-muted">—</span>}</span>
                  {r.error && <span className="mt-0.5 block truncate text-[11px] text-red-400" title={r.error}>{r.error}</span>}
                </>
              ),
            },
            {
              id: 'changes', header: t('releases.fields.changes') || 'Changes', tdClassName: 'whitespace-nowrap font-mono text-xs', sort: (r) => r.filesAdded + r.filesModified + r.filesDeleted,
              cell: (r) => (
                <>
                  <span className="text-status-up">+{r.filesAdded}</span>{' '}
                  <span className="text-amber-400">~{r.filesModified}</span>{' '}
                  <span className="text-red-400">−{r.filesDeleted}</span>
                </>
              ),
            },
            {
              id: 'scan', header: t('releases.fields.scan') || 'Scan', sort: (r) => r.scan?.verdict ?? '',
              cell: (r) => (r.scan ? (
                <span className="inline-flex flex-wrap items-center gap-1">
                  <ScanVerdictChip verdict={r.scan.verdict} />
                  {isScanBlocked(r) && (
                    <Pill tone="red" className="text-[10px]">
                      <ShieldAlert size={11} className="mr-0.5" />{t('scanner.blocked.chip') || 'blocked'}
                    </Pill>
                  )}
                </span>
              ) : <span className="text-text-muted">—</span>),
            },
            {
              id: 'onDisk', header: t('releases.fields.onDisk') || 'On disk', tdClassName: 'text-xs', sort: (r) => r.onDisk,
              cell: (r) => (r.onDisk ? <Check className="h-4 w-4 text-status-up" aria-label={t('releases.onDiskYes') || 'yes'} /> : <span className="text-text-muted">—</span>),
            },
            {
              id: 'date', header: t('releases.fields.date') || 'Date', tdClassName: 'whitespace-nowrap font-mono text-xs text-text-muted', sort: (r) => r.createdAt,
              cell: (r) => (
                <>
                  <div title={t('releases.fields.created') || 'Created'}>{formatDateTime(r.createdAt, i18n.language)}</div>
                  {r.publishedAt && <div className="text-status-up/80" title={t('releases.fields.published') || 'Published'}>↑ {formatDateTime(r.publishedAt, i18n.language)}</div>}
                </>
              ),
            },
            {
              id: 'actions', header: <span className="sr-only">{t('releases.fields.actions') || 'Actions'}</span>, tdClassName: 'whitespace-nowrap text-right',
              cell: (r) => <div className="flex justify-end gap-1">{renderActions(r)}</div>,
            },
          ]}
        />
      )}

      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-xs text-text-muted">
          <IconButton label={t('common.previous') || 'Prev'} icon={<ChevronLeft className="h-4 w-4" />} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} />
          <span className="font-mono">{page} / {pages}</span>
          <IconButton label={t('common.next') || 'Next'} icon={<ChevronRight className="h-4 w-4" />} disabled={page >= pages} onClick={() => setOffset(offset + PAGE_SIZE)} />
        </div>
      )}

      <ReleaseDrawer
        siteId={site.id}
        releaseId={openId}
        releases={items}
        tick={drawerTick}
        onClose={() => setOpenId(null)}
        renderActions={(r) => renderActions(r, true)}
      />
    </div>
  );
}
