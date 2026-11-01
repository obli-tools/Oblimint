import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/utils/cn';

// Minimal modal of the webmail (same look as the panel's Modal: card on a
// dimmed backdrop, full screen on phones), without the panel's native bridge.

export function Dialog({ open, onClose, title, children, footer, size = 'md', className, closeLabel = 'Close' }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  closeLabel?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  const width = { sm: 'sm:max-w-md', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl' }[size];
  return createPortal(
    <div className="wm-backdrop fixed inset-0 z-50 flex items-stretch justify-center animate-obli-fade-in sm:items-start sm:px-4 sm:py-[10vh]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className={cn('wm-pop wm-scale-in flex w-full flex-col bg-bg-secondary outline-none sm:max-h-[80vh] sm:rounded-[14px]', width, className)}
      >
        <div className="flex shrink-0 items-center gap-2 px-5 pb-2 pt-4 pt-[max(1rem,var(--safe-top,0px))] sm:pt-4">
          <h2 className="flex-1 truncate text-[17px] font-semibold text-text-primary">{title}</h2>
          <button type="button" onClick={onClose} className="-mr-1 flex h-8 w-8 items-center justify-center rounded-[7px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary coarse:h-10 coarse:w-10" aria-label={closeLabel}>
            <X size={16} />
          </button>
        </div>
        <div className="wm-scroll min-h-0 flex-1 overflow-y-auto px-5 py-2">{children}</div>
        {footer && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 bg-bg-tertiary/50 px-5 py-3 pb-[max(0.75rem,var(--safe-bottom,0px))] sm:rounded-b-[14px]">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
