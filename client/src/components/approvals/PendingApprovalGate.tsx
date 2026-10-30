import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Clock, Loader2, Play, ShieldAlert } from 'lucide-react';
import type { PendingAction } from '@oblimint/shared';
import { Modal } from '@/components/common/Modal';
import { pendingActionsApi } from '@/api/pendingActions.api';
import { usePendingActionsStore } from '@/store/pendingActionsStore';
import { setAppNavigate } from '@/utils/appNavigate';
import { setPendingApprovalListener, takeReplay, type PendingApprovalPrompt } from '@/utils/pendingApprovalGate';
import { StatusPill, formatCountdown, shownStatus, useTick } from './approvalsUi';

// Singleton mounted once inside the router (App.tsx), next to TwoFactorGate.
// Any panel action answered 202 pendingApproval (a 'restricted' action) pops
// this modal through the API client: it follows the request live (socket +
// a slow poll), lets the requester cancel it, and once a second person
// approved it, « Run now » sends the very same request again — the call
// site then continues normally. Nothing has been done while it waits.

const POLL_MS = 10_000;

export function PendingApprovalGate() {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState<PendingApprovalPrompt | null>(null);

  useEffect(() => {
    setAppNavigate((to) => navigate(to));
    return () => setAppNavigate(null);
  }, [navigate]);

  useEffect(() => {
    setPendingApprovalListener((p) => {
      // One modal at a time: an older one still open is dismissed (its call is rejected, handled).
      setPrompt((cur) => { cur?.resolve('dismiss'); return p; });
    });
    return () => setPendingApprovalListener(null);
  }, []);

  if (!prompt) return null;
  return (
    <PendingApprovalModal
      key={prompt.pendingActionId}
      prompt={prompt}
      onDone={(d, approved) => {
        prompt.resolve(d);
        setPrompt(null);
        // Closed although already approved: the approval event is past, offer the replay now
        // (the API client keeps it right after this resolve).
        if (d === 'dismiss' && approved) {
          const id = prompt.pendingActionId;
          window.setTimeout(() => {
            const run = takeReplay(id);
            if (run) void import('./restrictionToast').then(({ showApprovedReplay }) => showApprovedReplay(id, run));
          }, 0);
        }
      }}
      onOpenPage={() => { prompt.resolve('dismiss'); setPrompt(null); navigate(`/approvals/${prompt.pendingActionId}`); }}
    />
  );
}

function PendingApprovalModal({ prompt, onDone, onOpenPage }: {
  prompt: PendingApprovalPrompt;
  onDone: (d: 'run' | 'dismiss', approved?: boolean) => void;
  onOpenPage: () => void;
}) {
  const { t } = useTranslation();
  const id = prompt.pendingActionId;
  const [row, setRow] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const version = usePendingActionsStore((s) => s.version);
  useTick(true);

  useEffect(() => {
    let alive = true;
    const load = () => { pendingActionsApi.get(id).then((r) => { if (alive) setRow(r); }).catch(() => {}); };
    load();
    const h = window.setInterval(load, POLL_MS);
    return () => { alive = false; window.clearInterval(h); };
  }, [id, version]);

  const expiresAt = row?.expiresAt ?? prompt.expiresAt;
  const status = row ? shownStatus(row) : (expiresAt && new Date(expiresAt).getTime() <= Date.now() ? 'expired' : 'pending');
  const description = row?.description ?? prompt.description ?? '';
  const decider = row?.decidedBy ? (row.decidedBy.displayName || row.decidedBy.username) : null;

  const cancelRequest = async () => {
    setBusy(true);
    try {
      setRow(await pendingActionsApi.cancel(id));
    } catch { /* reported by the API client or stale: reload */ }
    finally { setBusy(false); }
  };

  const btn = 'px-3 py-1.5 text-xs rounded disabled:opacity-50 coarse:min-h-10 coarse:px-4';

  return (
    <Modal
      open
      onClose={() => onDone('dismiss', status === 'approved')}
      title={t('approvals.gate.title') || 'Waiting for approval'}
      icon={<ShieldAlert className="w-4 h-4 text-accent" />}
      size="md"
      phoneLayout="center"
      closeOnBackdrop={false}
      overlayClassName="z-[290] bg-black/70"
      bodyClassName="py-4 space-y-3"
      footer={
        <>
          <button type="button" onClick={onOpenPage} className={`${btn} text-text-muted hover:text-text-primary mr-auto`}>
            {t('approvals.gate.openPage') || 'Open in Approvals'}
          </button>
          {status === 'pending' && (
            <button type="button" onClick={cancelRequest} disabled={busy} className={`${btn} text-red-400 hover:bg-red-400/10`}>
              {t('approvals.cancelRequest') || 'Cancel the request'}
            </button>
          )}
          <button type="button" onClick={() => onDone('dismiss', status === 'approved')} className={`${btn} text-text-muted hover:text-text-primary`}>
            {t('common.close') || 'Close'}
          </button>
          {status === 'approved' && (
            <button
              type="button"
              autoFocus
              onClick={() => onDone('run')}
              className={`${btn} bg-accent text-white hover:bg-accent/90 inline-flex items-center gap-1.5`}
            >
              <Play className="w-3 h-3" /> {t('approvals.gate.runNow') || 'Run now'}
            </button>
          )}
        </>
      }
    >
      <div className="flex items-center gap-2 flex-wrap">
        <StatusPill status={status} t={t} />
        <span className="text-[11px] font-mono text-text-muted">#{id}</span>
        {status === 'pending' && (
          <span className="inline-flex items-center gap-1 text-[11px] text-text-muted">
            <Clock className="w-3 h-3" /> {formatCountdown(expiresAt, t)}
          </span>
        )}
        {status === 'pending' && <Loader2 className="w-3 h-3 animate-spin text-text-muted" aria-hidden />}
      </div>
      {description && <p className="text-sm font-medium text-text-primary whitespace-pre-wrap break-words">{description}</p>}
      {status === 'pending' && (
        <p className="text-xs text-text-muted">
          {t('approvals.gate.pendingHint') || 'This action needs the approval of a second authorised person, who was notified. Nothing has been done yet. Keep this window open to run it as soon as it is approved.'}
        </p>
      )}
      {status === 'approved' && (
        <p className="text-xs text-status-up">
          {decider
            ? t('approvals.gate.approvedBy', { name: decider, defaultValue: 'Approved by {{name}}. Run the action now to apply it.' })
            : t('approvals.gate.approved', 'Approved. Run the action now to apply it.')}
        </p>
      )}
      {status === 'denied' && (
        <p className="text-xs text-red-400 break-words">
          {t('approvals.gate.denied', { name: decider ?? '—', defaultValue: 'Denied by {{name}}: the action was not run.' })}
          {row?.reason ? ` « ${row.reason} »` : ''}
        </p>
      )}
      {(status === 'expired' || status === 'cancelled') && (
        <p className="text-xs text-text-muted">
          {status === 'expired'
            ? t('approvals.gate.expired', 'This request expired: the action was not run. Do it again to file a new request.')
            : t('approvals.gate.cancelled', 'Request cancelled: the action was not run.')}
        </p>
      )}
      {status === 'pending' && (
        <p className="text-[11px] text-text-muted/80">
          {prompt.replayableLater
            ? t('approvals.gate.closeHintReplay', 'If you close this window, you will be offered to run the action once it is approved.')
            : t('approvals.gate.closeHintRedo', 'This request carries a secret or a file that is not kept: if you close this window, do the action again once it is approved.')}
        </p>
      )}
    </Modal>
  );
}
