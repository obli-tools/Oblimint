import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { cn } from '@/utils/cn';
import { useWebmail } from '../store';

export function Toasts() {
  const toasts = useWebmail((s) => s.toasts);
  const dismiss = useWebmail((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg animate-obli-fade-in',
            t.kind === 'error' ? 'border-status-down/40 bg-bg-tertiary text-text-primary' : 'border-accent/40 bg-bg-tertiary text-text-primary',
          )}
        >
          {t.kind === 'error' ? <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-400" /> : <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-accent" />}
          <span className="flex-1 break-words">{t.text}</span>
          <button type="button" onClick={() => dismiss(t.id)} className="text-text-muted hover:text-text-primary" aria-label="Dismiss"><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}
