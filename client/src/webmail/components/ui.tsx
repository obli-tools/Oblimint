import { createContext, forwardRef, useContext, useEffect, useRef, type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { cn } from '@/utils/cn';
import { avatarHue, initials } from '../lib/view';

// Building blocks of the webmail shell, after Oblidesk's (common/Button,
// UserAvatar, EmptyState, the queue splitter, the palette rows):
// NO-BORDER RULE (depth = background step + soft shadow), pills 7px,
// cards 10px, modals 14px, Oblimint mint accent.

/** Round avatar with the correspondent's initials, hue in the mint family. */
export function Avatar({ name, email, size = 32, className }: { name?: string | null; email?: string | null; size?: number; className?: string }) {
  const label = (name ?? '').trim() || (email ?? '');
  const hue = avatarHue(email || label);
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white', className)}
      style={{
        width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)),
        background: `linear-gradient(135deg, hsl(${hue} 62% 50% / 0.95), hsl(${hue - 22} 58% 34% / 0.95))`,
      }}
    >
      {initials(label)}
    </span>
  );
}

type IconButtonTone = 'ghost' | 'surface' | 'accent' | 'danger';

/** Icon-only pill button (toolbars, row actions). `label` is its tooltip and accessible name. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string; tone?: IconButtonTone; active?: boolean; size?: 'xs' | 'sm' | 'md';
}>(function IconButton({ label, tone = 'ghost', active, size = 'md', className, children, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[7px] transition-colors disabled:pointer-events-none disabled:opacity-40',
        size === 'xs' ? 'h-6 w-6 rounded-[6px]' : size === 'sm' ? 'h-7 w-7' : 'h-8 w-8',
        'coarse:h-10 coarse:w-10',
        tone === 'ghost' && (active ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-bg-hover hover:text-text-primary'),
        tone === 'surface' && (active ? 'bg-accent/15 text-accent' : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary'),
        tone === 'accent' && 'bg-accent/15 text-accent hover:bg-accent/20',
        tone === 'danger' && 'text-text-muted hover:bg-red-500/15 hover:text-red-400',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

/** Pill button with a label (toolbar actions, dialogs). */
export const PillButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'accent' | 'secondary' | 'ghost'; icon?: ReactNode; loading?: boolean; size?: 'sm' | 'md';
}>(function PillButton({ variant = 'secondary', icon, loading, size = 'md', className, children, disabled, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[7px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3 text-[13px]',
        'coarse:min-h-10',
        variant === 'primary' && 'bg-accent font-semibold text-bg-primary hover:bg-accent-hover',
        variant === 'accent' && 'bg-accent/15 text-accent hover:bg-accent/20',
        variant === 'secondary' && 'bg-bg-tertiary text-text-primary hover:bg-bg-hover',
        variant === 'ghost' && 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('h-3.5 w-3.5 shrink-0 animate-spin', className)} fill="none" viewBox="0 0 24 24" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

/** Small counter pill (folder counts, totals). */
export function CountPill({ value, tone = 'default', className }: { value: number; tone?: 'default' | 'accent'; className?: string }) {
  if (!value) return null;
  return (
    <span className={cn(
      'shrink-0 rounded-[7px] px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none tabular-nums',
      tone === 'accent' ? 'bg-accent/15 text-accent' : 'bg-bg-tertiary text-text-muted',
      className,
    )}>
      {value > 999 ? '999+' : value}
    </span>
  );
}

/** Mono upper-case section label (sidebar sections, palette groups). */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted', className)}>{children}</span>;
}

/** The blank slate of a pane: quiet, never looks like an error. */
export function EmptyState({ icon, title, description, action, className }: {
  icon?: ReactNode; title: string; description?: string; action?: ReactNode; className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-12 text-center', className)}>
      {icon && <div className="flex h-12 w-12 items-center justify-center rounded-[10px] bg-bg-tertiary text-text-muted">{icon}</div>}
      <div className="max-w-sm space-y-1">
        <p className="text-[15px] font-semibold text-text-primary">{title}</p>
        {description && <p className="text-[13px] leading-relaxed text-text-muted">{description}</p>}
      </div>
      {action && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <span aria-hidden className={cn('wm-skel block', className)} style={style} />;
}

/** Keyboard key. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="wm-kbd">{children}</kbd>;
}

/**
 * Popover anchored to its wrapper (account menu, move-to menu…): closes on an
 * outside press and on Escape. On a phone it is a sheet docked at the bottom
 * of the screen, full width (a menu anchored to a toolbar button would run
 * off the viewport). `role` "dialog" for a panel that is not a plain list of
 * commands (the account menu: theme radios, language select), with `label`.
 */
/** Role of the enclosing popover: its items are menu items only inside a menu. */
const PopoverRole = createContext<'menu' | 'dialog'>('menu');

export function Popover({ open, onClose, children, className, align = 'right', role = 'menu', label }: {
  open: boolean; onClose: () => void; children: ReactNode; className?: string; align?: 'left' | 'right'; role?: 'menu' | 'dialog'; label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const anchor = ref.current?.parentElement;
      if (anchor && !anchor.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc, true); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <PopoverRole.Provider value={role}>
    <div ref={ref} role={role} aria-label={label}
      className={cn(
        'wm-pop wm-scale-in absolute top-full z-40 mt-1.5 overflow-hidden rounded-[10px] bg-bg-secondary py-1', align === 'right' ? 'right-0' : 'left-0', className,
        // Phone: bottom sheet (these max-sm variants win over the widths / heights passed in className).
        'max-sm:fixed max-sm:inset-x-2 max-sm:bottom-[max(0.5rem,var(--safe-bottom,0px))] max-sm:top-auto max-sm:z-50 max-sm:mt-0 max-sm:max-h-[60vh] max-sm:w-auto max-sm:overflow-y-auto max-sm:rounded-[14px] max-sm:py-2',
      )}>
      {children}
    </div>
    </PopoverRole.Provider>
  );
}

export function MenuItem({ icon, children, onClick, hint, danger, active, disabled, className }: {
  icon?: ReactNode; children: ReactNode; onClick: () => void; hint?: ReactNode; danger?: boolean; active?: boolean; disabled?: boolean; className?: string;
}) {
  const inMenu = useContext(PopoverRole) === 'menu';
  return (
    <button type="button" role={inMenu ? 'menuitem' : undefined} onClick={onClick} disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors disabled:pointer-events-none disabled:opacity-40 coarse:py-3',
        danger ? 'text-text-secondary hover:bg-red-500/10 hover:text-red-400' : active ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
        className,
      )}>
      {icon && <span className="flex w-4 shrink-0 justify-center">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-[11px] text-text-muted">{hint}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-border" />;
}

/**
 * 4px drag strip between two panes (Oblidesk queue splitter): pointer drag
 * (mouse, pen, touch), arrow keys (16 px), double click resets. `onDrag`
 * receives the pointer's horizontal travel since the press. The pointer is
 * captured and iframes (HTML mail, rich editor) ignore the pointer while
 * dragging, so a release over a mail body still ends the drag.
 */
export function Splitter({ label, onDragStart, onDrag, onDragEnd, onNudge, onReset, className }: {
  label: string;
  onDragStart: () => void;
  onDrag: (dx: number) => void;
  onDragEnd: () => void;
  onNudge: (dx: number) => void;
  onReset?: () => void;
  className?: string;
}) {
  const startX = useRef<number | null>(null);
  const end = () => {
    if (startX.current === null) return;
    startX.current = null;
    document.body.classList.remove('wm-resizing');
    onDragEnd();
  };
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* capture unavailable: the iframe guard still applies */ }
    startX.current = e.clientX;
    document.body.classList.add('wm-resizing');
    onDragStart();
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (startX.current !== null) onDrag(e.clientX - startX.current);
  };
  const key = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); onNudge(-16); }
    if (e.key === 'ArrowRight') { e.preventDefault(); onNudge(16); }
  };
  useEffect(() => () => document.body.classList.remove('wm-resizing'), []);
  return (
    <div
      role="separator" aria-orientation="vertical" aria-label={label} title={label} tabIndex={0}
      onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
      onKeyDown={key} onDoubleClick={onReset}
      className={cn('w-1 shrink-0 cursor-col-resize touch-none bg-bg-primary transition-colors hover:bg-accent/40 focus:bg-accent/60 focus:outline-none', className)}
    />
  );
}
