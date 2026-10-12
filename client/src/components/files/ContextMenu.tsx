import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/utils/cn';

export interface ContextMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

/**
 * Right-click menu at the pointer (explorer rows / background): clamped to the
 * viewport, first enabled item focused, ↑/↓/Home/End move, Enter runs, Esc,
 * an outside click, scroll, resize or window blur close it.
 */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: ContextMenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
    el.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [onClose]);

  const onKey = (e: React.KeyboardEvent) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => { e.preventDefault(); buttons[(n + buttons.length) % buttons.length]?.focus(); };
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(buttons.length - 1);
    else if (e.key === 'Tab') { e.preventDefault(); onClose(); }
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[200] min-w-[220px] max-w-[320px] rounded-xl bg-bg-secondary p-1.5 shadow-2xl ring-1 ring-white/[0.08]"
      style={pos}
    >
      {items.map((it) => (
        <div key={it.key}>
          {it.separator && <div className="my-1 h-px bg-white/[0.06]" />}
          <button
            role="menuitem"
            type="button"
            disabled={it.disabled}
            onClick={() => { onClose(); it.onClick(); }}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-40',
              it.danger ? 'text-status-down hover:bg-status-down/10 focus:bg-status-down/10' : 'text-text-primary hover:bg-bg-hover focus:bg-bg-hover',
            )}
          >
            <span className="flex w-4 shrink-0 justify-center text-text-muted">{it.icon}</span>
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.shortcut && <span className="shrink-0 font-mono text-[10px] text-text-muted">{it.shortcut}</span>}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
