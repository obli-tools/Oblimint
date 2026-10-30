import toast from 'react-hot-toast';
import i18n from 'i18next';
import type { RestrictionErrorMessage } from '@/api/restrictionErrors';
import { appNavigate } from '@/utils/appNavigate';

// Toasts of the sensitive-actions flow raised by the API client (outside
// React): a refusal of the gate with its fix (enable 2FA…), and the
// "approved — run it now" offer of a request filed earlier.

export function showRestrictionError(m: RestrictionErrorMessage, serverMessage?: string): void {
  const text = i18n.t(m.key, { defaultValue: m.fallback }) || serverMessage || m.fallback;
  toast.error((tt) => (
    <span className="flex flex-col gap-1.5">
      <span>{text}</span>
      {m.link && (
        <button
          type="button"
          className="self-start text-xs font-medium text-accent hover:underline"
          onClick={() => { toast.dismiss(tt.id); appNavigate(m.link!.path); }}
        >
          {i18n.t(m.link.key, { defaultValue: m.link.fallback })}
        </button>
      )}
    </span>
  ), { id: `restriction-${m.code}`, duration: m.link ? 12000 : 8000 });
}

/** A request filed earlier (modal closed) was approved: offer to run it once. */
export function showApprovedReplay(pendingActionId: number, run: () => Promise<unknown>): void {
  toast((tt) => (
    <span className="flex flex-col gap-1.5">
      <span>{i18n.t('approvals.replay.approved', { id: pendingActionId, defaultValue: 'Request #{{id}} was approved. Nothing was done yet.' })}</span>
      <span className="flex items-center gap-3">
        <button
          type="button"
          className="text-xs font-medium text-accent hover:underline"
          onClick={() => {
            toast.dismiss(tt.id);
            run()
              .then(() => toast.success(i18n.t('approvals.replay.done', { id: pendingActionId, defaultValue: 'Request #{{id}} executed.' })))
              .catch(() => { /* the API client already reported the failure */ });
          }}
        >
          {i18n.t('approvals.replay.runNow', 'Run now')}
        </button>
        <button
          type="button"
          className="text-xs text-text-muted hover:text-text-primary"
          onClick={() => { toast.dismiss(tt.id); appNavigate(`/approvals/${pendingActionId}`); }}
        >
          {i18n.t('approvals.replay.open', 'Open the request')}
        </button>
      </span>
    </span>
  ), { id: `pa-approved-${pendingActionId}`, duration: 60_000 });
}

/** A request filed earlier ended without approval (denied, expired, cancelled). */
export function showRequestClosed(pendingActionId: number, status: string): void {
  const key = status === 'denied' ? 'approvals.replay.denied' : status === 'expired' ? 'approvals.replay.expired' : 'approvals.replay.cancelled';
  const fallback = status === 'denied' ? 'Request #{{id}} was denied: the action was not run.'
    : status === 'expired' ? 'Request #{{id}} expired: the action was not run.'
      : 'Request #{{id}} was cancelled: the action was not run.';
  toast(i18n.t(key, { id: pendingActionId, defaultValue: fallback }), { id: `pa-closed-${pendingActionId}`, duration: 8000 });
}
