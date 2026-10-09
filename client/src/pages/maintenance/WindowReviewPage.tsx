import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  AlertTriangle, ArrowLeft, ArrowRight, Check, DatabaseBackup, DoorOpen, Loader2, RefreshCw, RotateCcw, ScrollText, ShieldAlert, X,
} from 'lucide-react';
import { HostingSocketEvents, type MaintenanceWindowDetail, type ReleaseLogLine, type Site, type WindowUpdatedPayload } from '@oblimint/shared';
import { windowsApi } from '@/api/maintenance.api';
import { sitesApi } from '@/api/sites.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { useConfirm, usePrompt } from '@/components/common/ConfirmDialog';
import { useHostingEvent } from '@/components/sites/useHostingEvent';
import { formatDateTime } from '@/components/sites/siteForm';
import { sectionLabelCls } from '@/components/sites/styles';
import {
  DecisionBadge, RiskBadge, WindowStatusBadge, useCloseReasonLabel, useTriggerLabel,
} from '@/components/maintenance/MaintenanceBadges';
import { WINDOW_BUSY_STATUSES } from '@/components/maintenance/maintenanceFormat';
import { apiErrorStatus, isNotImplemented, maintenanceErrorMessage, toastMaintenanceError } from '@/components/maintenance/maintenanceErrors';
import { ReviewSummary } from '@/components/maintenance/review/ReviewSummary';
import { ChangesBrowser } from '@/components/maintenance/review/ChangesBrowser';
import { ValidateWindowModal } from '@/components/maintenance/review/ValidateWindowModal';

const REASON_MAX = 500;

const LOG_CLS: Record<ReleaseLogLine['level'], string> = {
  info: 'text-text-secondary',
  warn: 'text-amber-400',
  error: 'text-red-400',
};

/**
 * /sites/:id/windows/:windowId — review of a closed modification window: tree
 * of the changes, per-file diff, risk badges, scanner findings, checksums,
 * validate / reject / reject + restore the databases (docs/P3-PLAN.md §13).
 * OWNED BY MODULE `ui-maintenance`.
 */
export function WindowReviewPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const { id, windowId } = useParams<{ id: string; windowId: string }>();
  const siteId = Number(id);
  const wid = Number(windowId);
  const { me, can } = useHostingMe();
  const triggerLabel = useTriggerLabel();
  const closeReasonLabel = useCloseReasonLabel();

  const [w, setW] = useState<MaintenanceWindowDetail | null>(null);
  const [site, setSite] = useState<Site | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState<'reject' | 'restore' | 'reanalyze' | null>(null);
  const [validating, setValidating] = useState(false);
  /** Bumped when the window changes: the file list refetches. */
  const [filesTick, setFilesTick] = useState(0);

  const seq = useRef(0);
  const load = useCallback(async (quiet = false) => {
    const n = ++seq.current;
    if (!Number.isInteger(siteId) || siteId <= 0 || !Number.isInteger(wid) || wid <= 0) { setNotFound(true); setLoading(false); return; }
    if (!quiet) setLoading(true);
    try {
      const detail = await windowsApi.get(siteId, wid);
      if (n !== seq.current) return;
      setW(detail);
      setError(null);
      setNotFound(false);
    } catch (err) {
      if (n !== seq.current) return;
      if (apiErrorStatus(err) === 404) setNotFound(true);
      else if (!quiet || !w) setError(isNotImplemented(err) ? (t('maintenance.notAvailableLong') || 'Modification windows are not available on this server yet.') : maintenanceErrorMessage(err, t, t('windowReview.loadFailed') || 'Failed to load the window'));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [siteId, wid, t]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setW(null); void load(); }, [load]);
  useEffect(() => {
    if (!Number.isInteger(siteId) || siteId <= 0) return undefined;
    let cancelled = false;
    sitesApi.get(siteId).then((s) => { if (!cancelled) setSite(s); }).catch(() => { if (!cancelled) setSite(null); });
    return () => { cancelled = true; };
  }, [siteId]);

  const lastStatus = useRef<string | null>(null);
  useHostingEvent<WindowUpdatedPayload>(HostingSocketEvents.WINDOW_UPDATED, (p) => {
    if (p.siteId !== siteId || p.windowId !== wid) return;
    void load(true);
    // A new analysis rewrites window_files: refetch the tree once the status settles.
    if (lastStatus.current !== p.status && (p.status === 'pending_review' || p.status === 'validated' || p.status === 'rejected')) setFilesTick((n) => n + 1);
    lastStatus.current = p.status;
  });

  const back = () => { if (window.history.length > 1) navigate(-1); else navigate(`/sites/${siteId}?tab=maintenance`); };

  if (loading && !w) {
    return <PageContainer className="flex justify-center py-16"><LoadingSpinner /></PageContainer>;
  }
  if (notFound || !w) {
    return (
      <PageContainer className="flex flex-col items-center gap-3 py-16 text-center">
        <DoorOpen className="h-8 w-8 text-text-muted" />
        <p className="text-sm text-text-secondary">{notFound ? (t('windowReview.notFound') || 'This window does not exist or is not visible to you.') : error}</p>
        <Link to={Number.isInteger(siteId) && siteId > 0 ? `/sites/${siteId}?tab=maintenance` : '/maintenance'} className="text-sm text-accent hover:underline">{t('windowReview.backToSite') || 'Back to the site'}</Link>
      </PageContainer>
    );
  }

  const accountId = site?.accountId ?? w.accountId;
  const isStaff = me?.kind === 'staff';
  const canPublish = can('releases.publish', accountId);
  const canApprove = can('releases.approve', accountId);
  const approvalMode = site?.publishMode === 'approval';
  const canValidate = canPublish && (!approvalMode || canApprove);
  const canRestoreDb = can('databases.manage', accountId);
  const pending = w.status === 'pending_review';
  const blocked = !!w.analysis?.blocked;
  const canOverride = isStaff && canApprove;

  const reject = async (restoreDatabases: boolean) => {
    const reason = await prompt({
      title: restoreDatabases
        ? (t('windowReview.reject.restoreTitle') || 'Reject and restore the databases')
        : t('windowReview.reject.title', { number: w.number, defaultValue: 'Reject window #{{number}}' }),
      message: restoreDatabases
        ? (t('windowReview.reject.restoreMessage') || 'The code goes back to the release, AND the databases are restored from the snapshots taken at opening: everything written in them since is lost. Reason (optional):')
        : (t('windowReview.reject.message') || 'The changes are discarded and the site serves its release again; the databases are kept as they are. Reason (optional):'),
      multiline: true,
      maxLength: REASON_MAX,
      plain: false,
      confirmLabel: restoreDatabases ? (t('windowReview.reject.restoreSubmit') || 'Reject and restore') : (t('windowReview.reject.submit') || 'Reject'),
    });
    if (reason === null) return;
    setBusy(restoreDatabases ? 'restore' : 'reject');
    try {
      await windowsApi.reject(siteId, w.id, { reason: reason.trim() || null, restoreDatabases });
      toast.success(t('windowReview.reject.done') || 'Window rejected');
      void load(true);
    } catch (err) {
      toastMaintenanceError(err, t, t('windowReview.reject.failed') || 'Failed to reject the window');
    } finally {
      setBusy(null);
    }
  };

  const reanalyze = async () => {
    if (!(await confirm({
      title: t('windowReview.reanalyze') || 'Reanalyze',
      message: t('windowReview.reanalyzeConfirm') || 'Run the analysis again (scanner with the latest signatures, checksums, HTTP check)?',
      confirmLabel: t('windowReview.reanalyze') || 'Reanalyze',
    }))) return;
    setBusy('reanalyze');
    try {
      await windowsApi.reanalyze(siteId, w.id);
      toast.success(t('windowReview.reanalyzeStarted') || 'Analysis started');
      void load(true);
    } catch (err) {
      toastMaintenanceError(err, t, t('windowReview.reanalyzeFailed') || 'Failed to start the analysis');
    } finally {
      setBusy(null);
    }
  };

  const busyServer = WINDOW_BUSY_STATUSES.includes(w.status);

  return (
    <PageContainer className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-start gap-4 max-lg:flex-wrap max-lg:gap-3">
        <IconButton onClick={back} size="lg" variant="plain" className="mt-0.5 rounded-lg hover:bg-bg-secondary" label={t('common.back') || 'Back'} icon={<ArrowLeft className="h-4 w-4" />} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3 max-sm:gap-2">
            <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary max-sm:text-xl">
              {t('windowReview.title', { number: w.number, defaultValue: 'Window #{{number}}' })}
            </h1>
            <WindowStatusBadge status={w.status} />
            {w.decision && w.decision !== w.status && <DecisionBadge decision={w.decision} />}
            <RiskBadge risk={w.risk} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-muted">
            <Link to={`/sites/${siteId}?tab=maintenance`} className="hover:text-accent">{site?.name ?? `#${siteId}`}</Link>
            <span>·</span>
            <span>{triggerLabel(w.trigger)}{w.tokenName ? ` (${w.tokenName})` : ''}</span>
            <span>·</span>
            <span className="font-mono">
              {w.baseReleaseNumber != null ? `#${w.baseReleaseNumber}` : '—'}
              <ArrowRight className="mx-1 inline h-3 w-3" />
              {w.resultReleaseNumber != null
                ? <Link to={`/sites/${siteId}?tab=releases`} className="text-accent hover:underline">#{w.resultReleaseNumber}</Link>
                : '?'}
            </span>
          </p>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted">
            <span>{t('windowReview.openedBy', { date: formatDateTime(w.openedAt, i18n.language), name: w.openedByName ?? '—', defaultValue: 'Opened {{date}} by {{name}}' })}</span>
            {w.closedAt && <span>{t('windowReview.closedAt', { date: formatDateTime(w.closedAt, i18n.language), defaultValue: 'closed {{date}}' })}{w.closeReason ? ` (${closeReasonLabel(w.closeReason)})` : ''}</span>}
            {w.decidedAt && <span>{t('windowReview.decidedBy', { date: formatDateTime(w.decidedAt, i18n.language), name: w.decidedByName ?? '—', defaultValue: 'decided {{date}} by {{name}}' })}</span>}
          </p>
          {w.note && <p className="mt-2 whitespace-pre-line break-words text-sm text-text-secondary">{w.note}</p>}
          {w.decisionReason && <p className="mt-1 whitespace-pre-line break-words text-xs text-text-muted">{t('windowReview.reason', { reason: w.decisionReason, defaultValue: 'Reason: {{reason}}' })}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 max-lg:order-last max-lg:w-full">
          <IconButton label={t('common.refresh') || 'Refresh'} icon={<RefreshCw className="h-4 w-4" />} onClick={() => { void load(true); setFilesTick((n) => n + 1); }} size="lg" variant="solid" className="rounded-lg" />
          {pending && canValidate && (
            <Button size="sm" onClick={() => setValidating(true)} disabled={busy !== null || w.stale} variant={blocked ? 'danger' : 'primary'}>
              <Check size={14} className="mr-1" />{t('windowReview.validate.button') || 'Validate'}
            </Button>
          )}
          {pending && canPublish && (
            <Button size="sm" variant="secondary" loading={busy === 'reject'} disabled={busy !== null} onClick={() => { void reject(false); }}>
              <X size={14} className="mr-1" />{t('windowReview.reject.submit') || 'Reject'}
            </Button>
          )}
          {pending && canPublish && canRestoreDb && w.snapshots.count > 0 && (
            <Button size="sm" variant="secondary" loading={busy === 'restore'} disabled={busy !== null} onClick={() => { void reject(true); }}>
              <DatabaseBackup size={14} className="mr-1" />{t('windowReview.reject.restoreButton') || 'Reject + restore DB'}
            </Button>
          )}
          {pending && canPublish && (
            <Button size="sm" variant="ghost" loading={busy === 'reanalyze'} disabled={busy !== null} onClick={() => { void reanalyze(); }}>
              <RotateCcw size={14} className="mr-1" />{t('windowReview.reanalyze') || 'Reanalyze'}
            </Button>
          )}
        </div>
      </div>

      {/* Banners */}
      {busyServer && (
        <p className="flex items-center gap-2 rounded-lg border border-blue-400/30 bg-blue-500/10 px-3 py-2 text-sm text-blue-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          {w.status === 'validating'
            ? (t('windowReview.busy.validating') || 'Publishing the new release…')
            : w.status === 'rejecting'
              ? (t('windowReview.busy.rejecting') || 'Rejecting the window…')
              : (t('windowReview.busy.analyzing') || 'Analysis in progress (scanner, checksums, HTTP check)…')}
        </p>
      )}
      {w.status === 'open' && (
        <p className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-sm text-text-secondary">
          <DoorOpen className="h-4 w-4 text-accent" />
          {t('windowReview.stillOpen') || 'The window is still open: close it from the Maintenance tab of the site to analyze the changes.'}
        </p>
      )}
      {w.stale && pending && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-sm text-amber-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{t('maintenance.errors.windowBaseChanged') || 'The live release changed since the window was opened: validate is no longer possible, reject the window.'}
        </p>
      )}
      {blocked && pending && (
        <p className="flex items-start gap-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          {isStaff
            ? (t('windowReview.blockedStaff') || 'The analysis blocked this window. Only a staff override (audited) can validate it.')
            : (t('windowReview.blockedClient') || 'The analysis blocked this window: it cannot be validated. Reject it, or contact the support.')}
        </p>
      )}
      {pending && approvalMode && !canApprove && canPublish && (
        <p className="flex items-start gap-2 rounded-lg bg-bg-secondary px-3 py-2 text-xs text-text-muted">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{t('windowReview.approvalNeeded') || 'This site publishes with approval: validating needs the approval right.'}
        </p>
      )}
      {w.stagingConflicts.length > 0 && pending && (
        <details className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-sm text-amber-400">
          <summary className="cursor-pointer">{t('windowReview.conflicts', { count: w.stagingConflicts.length, defaultValue: '{{count}} file(s) of the staging folder changed since the base release (validation will ask to overwrite them)' })}</summary>
          <ul className="mt-2 max-h-40 overflow-auto font-mono text-[11px] text-text-secondary">
            {w.stagingConflicts.map((p) => <li key={p} className="break-all">{p}</li>)}
          </ul>
        </details>
      )}
      {w.error && (
        <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2">
          <div className="mb-1 text-xs font-semibold text-red-400">{t('releases.fields.error') || 'Error'}</div>
          <p className="whitespace-pre-wrap break-words font-mono text-xs text-red-400">{w.error}</p>
        </div>
      )}
      {w.snapshots.failed > 0 && pending && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('maintenance.window.snapshotsFailed', { count: w.snapshots.failed, defaultValue: '{{count}} database snapshot(s) failed at opening: a rejection could not restore these databases.' })}
        </p>
      )}

      <ReviewSummary w={w} />

      <section>
        <div className={sectionLabelCls}>{t('windowReview.changes') || 'Changed files'}</div>
        <ChangesBrowser siteId={siteId} windowId={w.id} tick={filesTick} />
      </section>

      {w.log.length > 0 && (
        <details className="rounded-xl bg-bg-secondary p-4">
          <summary className="flex cursor-pointer items-center gap-2 text-sm text-text-secondary"><ScrollText size={14} className="text-accent" />{t('windowReview.log') || 'Log'}</summary>
          <pre className="mt-3 max-h-72 overflow-auto overscroll-contain rounded-lg bg-bg-primary/70 p-3 font-mono text-[11px] leading-relaxed">
            {w.log.map((l, i) => (
              <div key={i} className={LOG_CLS[l.level]}>
                <span className="text-text-muted/70">{new Date(l.at).toLocaleTimeString(i18n.language)}</span>{' '}
                <span className="uppercase">{l.level.padEnd(5)}</span>{' '}
                {l.message}
              </div>
            ))}
          </pre>
        </details>
      )}

      <ValidateWindowModal
        open={validating}
        siteId={siteId}
        w={w}
        canOverride={canOverride}
        onClose={() => setValidating(false)}
        onDone={() => {
          setValidating(false);
          toast.success(t('windowReview.validate.done') || 'Window validated: the release is being published');
          void load(true);
        }}
      />
    </PageContainer>
  );
}
