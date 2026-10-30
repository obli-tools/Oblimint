import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { clsx } from 'clsx';
import { Check, Clock, History, Inbox, KeyRound, RefreshCw, ShieldCheck, Send, X } from 'lucide-react';
import type { PendingAction, PendingActionTab } from '@oblimint/shared';
import { pendingActionsApi } from '@/api/pendingActions.api';
import { apiErrorMessage, isStepUpHandled } from '@/api/client';
import { usePendingActionsStore } from '@/store/pendingActionsStore';
import { PageContainer } from '@/components/common/PageContainer';
import { IconButton } from '@/components/common/IconButton';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { TenantBadge } from '@/components/common/TenantBadge';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useConfirm, usePrompt } from '@/components/common/ConfirmDialog';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { LevelPill, StatusPill, actionLabel, formatCountdown, requesterLine, shownStatus, useTick } from '@/components/approvals/approvalsUi';
import { payloadRows } from '@/components/approvals/approvalsLogic';

// Confirmations and approvals of the sensitive actions (spec §6.2), ported
// from Obliance ApprovalsPage. Staff and client spaces alike: the server
// lists only what the viewer may see (his own requests, and the approvals
// he is eligible for). /approvals/:id (notification link) opens one request.
//   « To handle »   my confirmations (actions of my keys) + approvals I may give
//   « My requests »
//   « History »     resolved, asked or decided by me

const TABS: PendingActionTab[] = ['todo', 'mine', 'history'];
const MAX_ROWS = 80;

function RequestDescription({ text }: { text: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const check = () => setOverflowing(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);

  return (
    <>
      <p
        ref={ref}
        className={clsx(
          'text-sm text-text-primary font-medium',
          expanded ? 'whitespace-pre-wrap break-words' : 'line-clamp-3 break-words',
        )}
      >
        {text}
      </p>
      {(overflowing || expanded) && (
        <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="text-[11px] text-accent hover:underline coarse:min-h-9">
          {expanded ? (t('approvals.showLess') || 'Show less') : (t('approvals.showMore') || 'Show more')}
        </button>
      )}
    </>
  );
}

/** What will run once approved (masked parameters, read-only). */
function PayloadTable({ payload }: { payload: unknown }) {
  const { t } = useTranslation();
  const rows = payloadRows(payload ?? {});
  const shown = rows.slice(0, MAX_ROWS);
  return (
    <div className="mt-1 rounded bg-bg-tertiary p-2 max-h-60 overflow-auto text-left">
      <p className="text-[10px] uppercase text-text-muted mb-1">{t('approvals.details') || 'Parameters'}</p>
      {shown.length === 0 ? (
        <p className="text-[11px] text-text-muted">{t('approvals.emptyPayload') || 'No parameters'}</p>
      ) : (
        <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11px] font-mono">
          {shown.map(([k, v], i) => (
            <div key={i} className="contents">
              <dt className="text-text-muted break-all">{k}</dt>
              <dd className="text-text-primary break-all whitespace-pre-wrap">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {rows.length > MAX_ROWS && (
        <p className="text-[11px] text-text-muted mt-1">{t('approvals.moreRows', { count: rows.length - MAX_ROWS, defaultValue: '+{{count}} more fields' })}</p>
      )}
    </div>
  );
}

function RequestDetails({ a, defaultOpen = false }: { a: PendingAction; defaultOpen?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="text-[11px] text-accent hover:underline coarse:min-h-9">
        {open ? (t('approvals.hideDetails') || 'Hide details') : (t('approvals.showDetails') || 'Show details')}
      </button>
      {open && (
        <>
          <PayloadTable payload={a.params} />
          <dl className="mt-1 grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11px]">
            <dt className="text-text-muted">{t('approvals.action') || 'Action'}</dt>
            <dd className="font-mono text-text-secondary break-all">{a.action}</dd>
            {a.requestIp && (<><dt className="text-text-muted">{t('approvals.ip') || 'Address'}</dt><dd className="font-mono text-text-secondary break-all">{a.requestIp}</dd></>)}
            {a.userAgent && (<><dt className="text-text-muted">{t('approvals.userAgent') || 'Client'}</dt><dd className="font-mono text-text-secondary break-all">{a.userAgent}</dd></>)}
          </dl>
        </>
      )}
    </>
  );
}

export function ApprovalsPage() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const navigate = useNavigate();
  const params = useParams<{ id?: string }>();
  const focusId = params.id && /^\d+$/.test(params.id) ? Number(params.id) : null;
  const isMaster = useIsMasterTenant();
  const version = usePendingActionsStore((s) => s.version);
  const todoCount = usePendingActionsStore((s) => s.todo);

  const [tab, setTab] = useState<PendingActionTab>('todo');
  const [items, setItems] = useState<PendingAction[]>([]);
  const [focused, setFocused] = useState<PendingAction | null>(null);
  const [focusMissing, setFocusMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  useTick(true);

  const load = useCallback(async (spinner = true) => {
    if (spinner) setLoading(true);
    try {
      const [list, one] = await Promise.all([
        pendingActionsApi.list(tab),
        focusId ? pendingActionsApi.get(focusId).catch(() => null) : Promise.resolve(null),
      ]);
      setItems(list.items);
      usePendingActionsStore.setState({ todo: list.todoCount });
      setFocused(one);
      setFocusMissing(focusId !== null && one === null);
    } catch (err) {
      toast.error(apiErrorMessage(err, t('approvals.loadFailed') || 'Failed to load the requests'));
    } finally {
      if (spinner) setLoading(false);
    }
  }, [tab, focusId, t]);

  useEffect(() => { void load(true); }, [load]);
  // Live: socket changes bump the store's version.
  useEffect(() => { if (version > 0) void load(false); }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (a: PendingAction, fn: () => Promise<PendingAction>, ok: string) => {
    setBusyId(a.id);
    try {
      await fn();
      toast.success(ok);
      await load(false);
    } catch (err) {
      if (!isStepUpHandled(err)) toast.error(apiErrorMessage(err, t('approvals.actionFailed') || 'The decision failed'));
      await load(false);
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirm = (a: PendingAction) => run(a, () => pendingActionsApi.confirm(a.id),
    a.via === 'panel'
      ? (t('approvals.confirmedToast') || 'Confirmed.')
      : (t('approvals.confirmedAgentToast') || 'Confirmed: the agent can now run the action (it calls it again).'));

  const handleApprove = async (a: PendingAction) => {
    const reason = await prompt({
      title: t('approvals.approveTitle') || 'Approve this request?',
      message: (
        <div className="space-y-1">
          <span className="break-words">{a.description}</span>
          <PayloadTable payload={a.params} />
          <span className="block text-[11px] text-text-muted">{t('approvals.approveCodeHint') || 'Your own 2FA code will be asked next.'}</span>
        </div>
      ),
      placeholder: t('approvals.reasonOptional') || 'Reason (optional)',
      confirmLabel: t('approvals.approve') || 'Approve',
      maxLength: 500,
      plain: false,
    });
    if (reason === null) return;
    await run(a, () => pendingActionsApi.approve(a.id, reason.trim() || undefined),
      t('approvals.approvedToast') || 'Approved: the requester can now run the action.');
  };

  const handleDeny = async (a: PendingAction) => {
    const reason = await prompt({
      title: t('approvals.denyTitle') || 'Deny this request?',
      message: <span className="break-words">{a.description}</span>,
      placeholder: t('approvals.reasonOptional') || 'Reason (optional)',
      confirmLabel: t('approvals.deny') || 'Deny',
      maxLength: 500,
      plain: false,
    });
    if (reason === null) return;
    await run(a, () => pendingActionsApi.deny(a.id, reason.trim() || undefined), t('approvals.deniedToast') || 'Denied.');
  };

  const handleCancel = async (a: PendingAction) => {
    if (!(await confirm({
      message: t('approvals.cancelConfirm') || 'Cancel your request? The action will not run.',
      confirmLabel: t('approvals.cancelRequest') || 'Cancel the request',
      cancelLabel: t('common.back') || 'Back',
    }))) return;
    await run(a, () => pendingActionsApi.cancel(a.id), t('approvals.cancelledToast') || 'Request cancelled.');
  };

  const tabs: SegmentedTab<PendingActionTab>[] = [
    {
      id: 'todo', label: t('approvals.tabs.todo') || 'To handle', icon: <Inbox size={14} />,
      badge: todoCount > 0 ? <span className="ml-1 rounded-full bg-red-500/20 px-1.5 text-[10px] font-semibold text-red-400">{todoCount > 99 ? '99+' : todoCount}</span> : undefined,
    },
    { id: 'mine', label: t('approvals.tabs.mine') || 'My requests', icon: <Send size={14} /> },
    { id: 'history', label: t('approvals.tabs.history') || 'History', icon: <History size={14} /> },
  ];

  const card = (a: PendingAction, highlighted = false) => {
    const status = shownStatus(a);
    const pending = status === 'pending';
    const expiringSoon = pending && new Date(a.expiresAt).getTime() - Date.now() < 5 * 60_000;
    const decider = a.decidedBy ? (a.decidedBy.displayName || a.decidedBy.username) : null;
    const can = pending ? a.can : { confirm: false, approve: false, deny: false, cancel: false };
    const hasActions = can.confirm || can.approve || can.deny || can.cancel;
    return (
      <div
        key={`${highlighted ? 'f' : 'l'}-${a.id}`}
        id={highlighted ? `pending-action-${a.id}` : undefined}
        className={clsx(
          'rounded-lg bg-bg-secondary p-3 border border-transparent',
          expiringSoon && 'border-orange-400/30 bg-orange-400/5',
          highlighted && 'border-accent/50',
        )}
      >
        <div className="flex items-start justify-between gap-3 max-sm:flex-col max-sm:items-stretch">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <StatusPill status={status} t={t} />
              <LevelPill level={a.level} t={t} />
              <span className="text-[11px] text-text-secondary">{actionLabel(t, a.action)}</span>
              <span className="text-[10px] font-mono text-text-muted">#{a.id}</span>
              {a.via !== 'panel' && (
                <span className="inline-flex items-center gap-1 text-[10px] text-text-muted"><KeyRound size={10} /> {a.apiKey?.name ?? a.via}</span>
              )}
              {isMaster && <TenantBadge tenantId={a.tenantId} />}
            </div>
            <RequestDescription text={a.description} />
            <RequestDetails a={a} defaultOpen={highlighted} />
            <div className="flex items-center gap-3 mt-1 text-[11px] text-text-muted flex-wrap">
              <span>{t('approvals.by') || 'By'} <strong className="text-text-secondary">{requesterLine(a, t)}</strong></span>
              <span>{new Date(a.createdAt).toLocaleString()}</span>
              {pending && (
                <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" />{formatCountdown(a.expiresAt, t)}</span>
              )}
              {status === 'approved' && a.consumeBy && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {t('approvals.consumeBy', { left: formatCountdown(a.consumeBy, t), defaultValue: 'to run within {{left}}' })}
                </span>
              )}
              {decider && (
                <span>
                  {a.status === 'denied' ? (t('approvals.deniedBy') || 'denied by') : a.decidedVia === 'totp' ? (t('approvals.confirmedBy') || 'confirmed by') : (t('approvals.approvedBy') || 'approved by')}
                  {' '}<strong>{decider}</strong>
                </span>
              )}
            </div>
            {a.reason && <p className="text-[11px] italic text-text-muted mt-1 break-words">« {a.reason} »</p>}
            {a.executionError && (
              <p className="text-[11px] mt-1 break-words text-red-400">
                {t('approvals.executionError', { error: a.executionError, defaultValue: 'Run, but failed: {{error}}' })}
              </p>
            )}
            {pending && a.kind === 'confirm' && can.confirm && (
              <p className="text-[11px] mt-1 text-text-muted">
                {t('approvals.confirmHint') || 'Your access key or agent asked for this action. Confirm it with your 2FA code, then the agent runs it.'}
              </p>
            )}
          </div>

          {hasActions && (
            <div className="flex items-center gap-1.5 shrink-0 coarse:gap-3 max-sm:justify-end flex-wrap">
              {can.confirm && (
                <button
                  disabled={busyId === a.id}
                  onClick={() => { void handleConfirm(a); }}
                  className="flex items-center gap-1 text-xs px-2.5 py-1 rounded border border-accent/40 bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-50 coarse:min-h-10 coarse:px-3"
                >
                  <ShieldCheck className="w-3.5 h-3.5" /> {t('approvals.confirmWithCode') || 'Confirm with my code'}
                </button>
              )}
              {can.approve && (
                <button
                  disabled={busyId === a.id}
                  onClick={() => { void handleApprove(a); }}
                  className="flex items-center gap-1 text-xs px-2.5 py-1 rounded border border-green-400/30 bg-green-400/10 text-green-400 hover:bg-green-400/20 disabled:opacity-50 coarse:min-h-10 coarse:px-3"
                >
                  <Check className="w-3.5 h-3.5" /> {t('approvals.approve') || 'Approve'}
                </button>
              )}
              {can.deny && (
                <button
                  disabled={busyId === a.id}
                  onClick={() => { void handleDeny(a); }}
                  className="flex items-center gap-1 text-xs px-2.5 py-1 rounded border border-red-400/30 bg-red-400/10 text-red-400 hover:bg-red-400/20 disabled:opacity-50 coarse:min-h-10 coarse:px-3"
                >
                  <X className="w-3.5 h-3.5" /> {t('approvals.deny') || 'Deny'}
                </button>
              )}
              {can.cancel && (
                <button
                  disabled={busyId === a.id}
                  onClick={() => { void handleCancel(a); }}
                  className="flex items-center gap-1 text-xs px-2.5 py-1 rounded text-text-muted hover:text-text-primary disabled:opacity-50 coarse:min-h-10 coarse:px-3"
                >
                  {t('approvals.cancelRequest') || 'Cancel the request'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <PageContainer>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-6 h-6 text-accent" />
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('approvals.title') || 'Approvals'}</h1>
            <p className="text-sm text-text-muted">{t('approvals.subtitle') || 'Sensitive actions waiting for a 2FA code or the approval of a second person.'}</p>
          </div>
        </div>
        <IconButton
          label={t('common.refresh') || 'Refresh'}
          icon={<RefreshCw className="w-4 h-4" />}
          variant="plain"
          onClick={() => { void load(true); }}
          className="ml-auto hover:border-accent/40"
        />
      </div>

      {focusId !== null && (focused || focusMissing) && (
        <div className="mb-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] uppercase tracking-wider font-semibold text-text-muted">{t('approvals.selected') || 'Selected request'}</p>
            <button type="button" className="text-[11px] text-text-muted hover:text-text-primary" onClick={() => navigate('/approvals')}>
              {t('common.close') || 'Close'}
            </button>
          </div>
          {focused ? card(focused, true) : (
            <div className="rounded-lg bg-bg-secondary p-3 text-sm text-text-muted">
              {t('approvals.notFound') || 'This request does not exist or is not visible to you.'}{' '}
              <Link to="/approvals" className="text-accent hover:underline">{t('approvals.backToList') || 'Back to the list'}</Link>
            </div>
          )}
        </div>
      )}

      <SegmentedTabs tabs={tabs} value={tab} onChange={(v) => setTab(TABS.includes(v) ? v : 'todo')} className="mb-4" tabClassName="gap-1.5" />

      {loading ? (
        <div className="flex justify-center py-10"><LoadingSpinner /></div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="w-8 h-8 opacity-30" />}
          text={tab === 'todo' ? (t('approvals.emptyTodo') || 'Nothing waiting for you.') : tab === 'mine' ? (t('approvals.emptyMine') || 'You have no request.') : (t('approvals.emptyHistory') || 'No resolved request yet.')}
        />
      ) : (
        <div className="space-y-2">
          {items.filter((a) => !focused || a.id !== focused.id).map((a) => card(a))}
        </div>
      )}
    </PageContainer>
  );
}
