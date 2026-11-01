import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { useWebmail } from '../store';

/** Toasts (Oblidesk live alerts): a raised card with a tone rail, fading in at the bottom. */
export function Toasts() {
  const { t } = useTranslation();
  const toasts = useWebmail((s) => s.toasts);
  const dismiss = useWebmail((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-[max(1rem,var(--safe-bottom,0px))] left-1/2 z-[60] flex w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2" aria-live="polite">
      {toasts.map((x) => (
        <div
          key={x.id}
          role={x.kind === 'error' ? 'alert' : 'status'}
          className="wm-fade-up pointer-events-auto flex items-start gap-2.5 rounded-[10px] bg-bg-secondary py-2.5 pl-3.5 pr-2 text-[13px] text-text-primary"
          // NO-BORDER RULE: the tone rail is an inset shadow, stacked on the raised shadow.
          style={{ boxShadow: `inset 3px 0 0 0 ${x.kind === 'error' ? 'rgb(var(--wm-warn))' : 'rgb(var(--c-accent))'}, var(--wm-shadow-pop)` }}
        >
          {x.kind === 'error' ? <AlertTriangle size={16} className="wm-warn mt-0.5 shrink-0" /> : <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-accent" />}
          <span className="min-w-0 flex-1 break-words leading-snug">{x.text}</span>
          <button type="button" onClick={() => dismiss(x.id)} className="rounded-[7px] p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary" aria-label={t('wm.common.dismiss') || 'Dismiss'}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
