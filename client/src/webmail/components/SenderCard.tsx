import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Copy, ListFilter, PenSquare, Search } from 'lucide-react';
import { cn } from '@/utils/cn';
import { ruleFromSender } from '@/utils/mailRules';
import type { EmailAddress } from '../jmap';
import { emptyDraft, formatAddress } from '../lib/compose';
import { useWebmail } from '../store';
import { Avatar, PillButton } from './ui';

// Contact card of a correspondent (Outlook's "people card"): hovering the
// sender of a list row (pointer devices), or clicking the sender of a message
// in the reading pane, shows avatar, name, address and the actions: new
// message, search their messages (every folder), copy the address, create a
// rule from this sender. Rendered in a portal at a fixed position (the list
// is windowed and clipped); a sheet docked at the bottom on a phone.

const CARD_W = 320;

function place(anchor: DOMRect): { left: number; top: number; above: boolean } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(8, Math.min(anchor.left, vw - CARD_W - 8));
  const above = anchor.bottom + 210 > vh && anchor.top > 220;
  return { left, top: above ? anchor.top - 8 : anchor.bottom + 6, above };
}

export function SenderCard({ person, anchor, onClose, onEnter, onLeave }: {
  person: EmailAddress;
  anchor: DOMRect;
  onClose: () => void;
  /** Pointer over the card (keeps a hover card open). */
  onEnter?: () => void;
  onLeave?: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const session = useWebmail((s) => s.session);
  const [pos, setPos] = useState(() => place(anchor));
  useLayoutEffect(() => setPos(place(anchor)), [anchor]);
  useEffect(() => {
    const away = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const scroll = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const email = person.email;
  const name = person.name?.trim() || '';
  const own = [session?.address, ...(session?.identities ?? []).map((i) => i.email)].some((a) => a && a.toLowerCase() === email.toLowerCase());
  const s = useWebmail.getState();
  const act = (fn: () => void) => () => { onClose(); fn(); };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(email);
      s.toast('ok', t('wm.card.copied') || 'Address copied');
    } catch {
      s.toast('error', t('wm.card.copyFailed') || 'Could not copy the address');
    }
  };

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={name || email}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      // A portal still bubbles through the React tree: never to the row / message header under it.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{ left: pos.left, top: pos.top, width: CARD_W }}
      // The placement (translate above the anchor) is on this wrapper, the entrance animation
      // (transform: scale) on the card inside: one never overrides the other.
      className={cn(
        'fixed z-50',
        pos.above && '-translate-y-full',
        'max-sm:!inset-x-2 max-sm:!bottom-[max(0.5rem,var(--safe-bottom,0px))] max-sm:!top-auto max-sm:!w-auto max-sm:!translate-y-0',
      )}
    >
      <div className={cn('wm-pop wm-scale-in rounded-[14px] bg-bg-secondary p-4', pos.above && 'origin-bottom')}>
        <div className="flex items-center gap-3">
          <Avatar name={name || email} email={email} size={48} />
          <div className="min-w-0 flex-1">
            {name && <div className="truncate text-[15px] font-semibold text-text-primary" title={name}>{name}</div>}
            <div className={cn('select-text truncate', name ? 'text-[12.5px] text-text-muted' : 'text-[14px] font-semibold text-text-primary')} title={email}>{email}</div>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-1.5">
          <PillButton size="sm" variant="accent" icon={<PenSquare size={13} />}
            onClick={act(() => s.openComposer({ ...emptyDraft(), to: formatAddress(person) }))}>
            {t('wm.card.write') || 'Send an email'}
          </PillButton>
          <PillButton size="sm" icon={<Search size={13} />}
            onClick={act(() => { s.openThread(null); s.setSearch({ from: email, everywhere: true }); })}>
            {t('wm.card.search') || 'Their messages'}
          </PillButton>
          <PillButton size="sm" icon={<Copy size={13} />} onClick={act(() => { void copy(); })}>
            {t('wm.card.copy') || 'Copy the address'}
          </PillButton>
          {!own && (
            <PillButton size="sm" icon={<ListFilter size={13} />}
              onClick={act(() => s.openSettings('rules', ruleFromSender(email, name, t('wm.rules.fromSenderName', { who: '{{who}}' }) || 'Messages from {{who}}')))}>
              {t('wm.card.rule') || 'Create a rule'}
            </PillButton>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The sender of a list row: after a short hover (pointer devices only), its
 * card opens; it stays open while the pointer is on the name or the card.
 * A click goes through (the row opens the conversation).
 */
export function SenderHover({ person, children, className }: { person: EmailAddress | null; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<number | null>(null);
  const clear = () => { if (timer.current) { window.clearTimeout(timer.current); timer.current = null; } };
  const close = useCallback(() => { clear(); setAnchor(null); }, []);
  useEffect(() => () => clear(), []);
  const hoverable = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const enter = () => {
    if (!person?.email || !hoverable()) return;
    clear();
    timer.current = window.setTimeout(() => { if (ref.current) setAnchor(ref.current.getBoundingClientRect()); }, 550);
  };
  const leave = () => {
    clear();
    timer.current = window.setTimeout(() => setAnchor(null), 220);
  };
  return (
    <>
      <span ref={ref} className={className} onPointerEnter={enter} onPointerLeave={leave}>{children}</span>
      {anchor && person && <SenderCard person={person} anchor={anchor} onClose={close} onEnter={clear} onLeave={leave} />}
    </>
  );
}

/** The sender of a message card (reading pane): a button that opens the card on click / Enter. */
export function SenderButton({ person, children, className, label }: { person: EmailAddress | null; children: ReactNode; className?: string; label: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  if (!person?.email) return <span className={className}>{children}</span>;
  return (
    <>
      <button ref={ref} type="button" title={label} aria-haspopup="dialog" aria-expanded={!!anchor}
        className={cn('rounded-[7px] text-left transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60', className)}
        onClick={(e) => { e.stopPropagation(); setAnchor((a) => (a ? null : ref.current!.getBoundingClientRect())); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}>
        {children}
      </button>
      {anchor && <SenderCard person={person} anchor={anchor} onClose={close} />}
    </>
  );
}
