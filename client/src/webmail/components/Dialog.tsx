import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/utils/cn';

// Minimal modal of the webmail (same look as the panel's Modal: card on a
// dimmed backdrop, full screen on phones), without the panel's native bridge.

export function Dialog({ open, onClose, title, children, footer, size = 'md', className }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
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
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 animate-obli-fade-in sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className={cn('flex w-full flex-col bg-bg-secondary shadow-2xl outline-none sm:max-h-[90vh] sm:rounded-xl sm:border sm:border-border', width, className)}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
          <h2 className="flex-1 truncate text-base font-semibold text-text-primary">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-md p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary coarse:min-h-10 coarse:min-w-10" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
