import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive, Check, Flag, FolderInput, Inbox, Mail, MailOpen, Minus, Paperclip, RefreshCw, SearchX, ShieldAlert, Trash2, X,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { archive, canArchive, canSpam, deleteThreads, deletesForGood, markFlagged, markSeen, markSpam, moveTo } from '../actions';
import type { EmailListItem } from '../jmap';
import { displayName } from '../lib/compose';
import { formatFullDate, formatListDate } from '../lib/format';
import { QUICK_FILTERS, type QuickFilter } from '../lib/view';
import { useWebmail } from '../store';
import { flattenTree, roleIcon, useMailboxName } from './MailboxTree';
import { SenderHover } from './SenderCard';
import { Avatar, CountPill, EmptyState, IconButton, PillButton, Popover } from './ui';

/** Fixed row height: the list is windowed (only the visible rows exist in the DOM). */
export const ROW_HEIGHT = 78;
const OVERSCAN = 8;

/** Move-to menu: every folder but the current one and Drafts. */
export function MoveMenu({ open, onPick, onClose, align = 'right' }: { open: boolean; onPick: (id: string) => void; onClose: () => void; align?: 'left' | 'right' }) {
  const mailboxes = useWebmail((s) => s.mailboxes);
  const current = useWebmail((s) => s.currentMailboxId);
  const nameOf = useMailboxName();
  return (
    <Popover open={open} onClose={onClose} align={align} className="wm-scroll max-h-80 w-60 overflow-y-auto">
      {flattenTree(mailboxes).filter(({ m }) => m.id !== current && m.role !== 'drafts').map(({ m, depth }) => (
        <button key={m.id} type="button" role="menuitem" onClick={() => { onPick(m.id); onClose(); }}
          className="flex w-full items-center gap-2.5 py-2 pr-3 text-left text-[13px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary coarse:py-3"
          style={{ paddingLeft: `${0.75 + depth * 0.75}rem` }}>
          <span className="opacity-70">{roleIcon(m.role)}</span>
          <span className="truncate">{nameOf(m)}</span>
        </button>
      ))}
    </Popover>
  );
}

function Checkbox({ checked, partial, label, onClick }: { checked: boolean; partial?: boolean; label: string; onClick: (e: ReactMouseEvent) => void }) {
  return (
    <button type="button" role="checkbox" aria-checked={partial ? 'mixed' : checked} aria-label={label} title={label} onClick={onClick}
      className={cn(
        'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] transition-colors',
        checked || partial ? 'bg-accent text-bg-primary' : 'bg-bg-tertiary text-transparent shadow-[inset_0_0_0_1px_rgb(var(--c-border-light))] hover:bg-bg-active',
      )}>
      {partial ? <Minus size={12} strokeWidth={3} /> : <Check size={12} strokeWidth={3} />}
    </button>
  );
}

function RowSkeleton() {
  return (
    <div className="flex gap-3 px-3 py-3" style={{ height: ROW_HEIGHT }} aria-hidden>
      <span className="wm-skel block h-9 w-9 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        <div className="flex gap-3"><span className="wm-skel block h-3.5 w-2/5" /><span className="flex-1" /><span className="wm-skel block h-3 w-10" /></div>
        <span className="wm-skel block h-3.5 w-3/4" />
        <span className="wm-skel block h-3 w-11/12 opacity-70" />
      </div>
    </div>
  );
}

interface RowProps {
  e: EmailListItem;
  /** The correspondent shown (sender, or first recipient in Sent / Drafts): their card on hover. */
  person: { name: string | null; email: string } | null;
  who: string;
  whoEmail: string;
  count: number;
  selected: boolean;
  open: boolean;
  lang: string;
  /** Delete destroys for good here (deletesForGood): confirmed first. */
  forGood: boolean;
  onOpen: (e: EmailListItem, ev: ReactMouseEvent) => void;
  onOpenKey: (e: EmailListItem) => void;
  onToggle: (id: string, ev: ReactMouseEvent) => void;
}

function Row({ e, person, who, whoEmail, count, selected, open, lang, forGood, onOpen, onOpenKey, onToggle }: RowProps) {
  const { t } = useTranslation();
  const unread = !e.keywords?.$seen;
  const flagged = !!e.keywords?.$flagged;
  const stop = (fn: () => void) => (ev: ReactMouseEvent) => { ev.stopPropagation(); fn(); };
  const del = () => {
    if (forGood && !window.confirm(t('wm.list.confirmDestroy') || 'Delete these messages permanently?')) return;
    void deleteThreads([e.id]);
  };
  return (
    <li
      style={{ height: ROW_HEIGHT }}
      tabIndex={0}
      aria-current={open ? 'true' : undefined}
      className={cn(
        'wm-row relative flex cursor-pointer select-none items-start gap-3 px-3 py-2.5 transition-colors',
        // NO-BORDER RULE: open / selected / hover are background steps; the open row also gets an inset accent rail.
        open ? 'bg-bg-active shadow-[inset_3px_0_0_0_rgb(var(--c-accent))]' : selected ? 'bg-accent/10' : 'hover:bg-bg-hover',
      )}
      onClick={(ev) => onOpen(e, ev)}
      // Keyboard: Tab reaches the row, Enter / Space opens it (J / K move between rows).
      onKeyDown={(ev) => { if (ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); onOpenKey(e); } }}
    >
      <div className="relative flex h-9 w-9 shrink-0 items-center justify-center">
        <span className="wm-row-avatar flex" onClick={(ev) => { ev.stopPropagation(); onToggle(e.id, ev); }}><Avatar name={who} email={whoEmail} size={36} /></span>
        <span className="wm-row-check h-9 w-9 items-center justify-center">
          <Checkbox checked={selected} label={t('wm.list.select') || 'Select'} onClick={(ev) => { ev.stopPropagation(); onToggle(e.id, ev); }} />
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex h-5 items-center gap-1.5">
          {unread && <><span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden /><span className="sr-only">{t('wm.list.unread') || 'Unread'}</span></>}
          <span className="flex min-w-0 flex-1">
            <SenderHover person={person} className={cn('min-w-0 truncate text-[13.5px]', unread ? 'font-semibold text-text-primary' : 'text-text-secondary')}>
              {who || (t('wm.list.noSender') || '(no sender)')}
            </SenderHover>
          </span>
          {count > 1 && <CountPill value={count} />}
          {e.hasAttachment && <Paperclip size={13} className="shrink-0 text-text-muted" aria-label={t('wm.read.attachment') || 'attachment'} />}
          {flagged && <Flag size={13} className="wm-warn shrink-0" fill="currentColor" aria-label={t('wm.list.flagged') || 'Flagged'} />}
          <time dateTime={e.receivedAt} title={formatFullDate(e.receivedAt, lang)}
            className={cn('wm-row-date shrink-0 font-mono text-[11px] tabular-nums', unread ? 'text-accent' : 'text-text-muted')}>
            {formatListDate(e.receivedAt, lang)}
          </time>
        </div>
        <div className={cn('truncate text-[13px] leading-5', unread ? 'font-medium text-text-primary' : 'text-text-secondary')}>
          {e.subject || (t('wm.list.noSubject') || '(no subject)')}
        </div>
        <div className="truncate text-[12px] leading-5 text-text-muted">{e.preview}</div>
      </div>

      {/* Hover actions (Outlook): a raised strip over the date. */}
      <div className="wm-row-actions wm-card absolute right-2 top-[9px] flex items-center rounded-[7px] bg-bg-secondary transition-opacity">
        <IconButton size="xs" label={unread ? (t('wm.actions.markRead') || 'Mark as read') : (t('wm.actions.markUnread') || 'Mark as unread')} onClick={stop(() => { void markSeen([e.id], unread); })}>
          {unread ? <MailOpen size={13} /> : <Mail size={13} />}
        </IconButton>
        <IconButton size="xs" active={flagged} label={flagged ? (t('wm.actions.unflag') || 'Remove the flag') : (t('wm.actions.flag') || 'Flag')} onClick={stop(() => { void markFlagged([e.id], !flagged); })}>
          <Flag size={13} fill={flagged ? 'currentColor' : 'none'} />
        </IconButton>
        {canArchive() && (
          <IconButton size="xs" label={t('wm.actions.archive') || 'Archive'} onClick={stop(() => { void archive([e.id]); })}><Archive size={13} /></IconButton>
        )}
        <IconButton size="xs" tone="danger" label={forGood ? (t('wm.actions.destroy') || 'Delete permanently') : (t('wm.actions.delete') || 'Delete')} onClick={stop(del)}>
          <Trash2 size={13} />
        </IconButton>
      </div>
    </li>
  );
}

export function MessageList() {
  const { t, i18n } = useTranslation();
  const list = useWebmail((s) => s.list);
  const selection = useWebmail((s) => s.selection);
  const openThreadId = useWebmail((s) => s.openThreadId);
  const mailboxes = useWebmail((s) => s.mailboxes);
  const currentId = useWebmail((s) => s.currentMailboxId);
  const search = useWebmail((s) => s.search);
  const quick = useWebmail((s) => s.quick);
  const { setSelection, toggleSelected, openThread, loadMore, reloadList, refreshMailboxes, setQuick, setSearch } = useWebmail.getState();
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [moveOpen, setMoveOpen] = useState(false);
  const anchor = useRef<number | null>(null);
  const nameOf = useMailboxName();
  const current = mailboxes.find((m) => m.id === currentId) ?? null;
  const sentLike = current?.role === 'sent' || current?.role === 'drafts';
  const forGood = deletesForGood({ mailboxes, currentMailboxId: currentId });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  // A new list starts at the top.
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); setScrollTop(0); anchor.current = null; }, [currentId, search, quick]);

  // The open conversation stays in view when it moves (j / k).
  useEffect(() => {
    const el = scroller.current;
    if (!el || !openThreadId) return;
    const i = list.ids.findIndex((id) => list.emails[id]?.threadId === openThreadId);
    if (i < 0) return;
    const top = i * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTo({ top });
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTo({ top: top + ROW_HEIGHT - el.clientHeight });
  }, [openThreadId, list.ids, list.emails]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(list.ids.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  useEffect(() => {
    if (end >= list.ids.length - 5 && list.ids.length < list.total && !list.loading) void loadMore();
  }, [end, list.ids.length, list.total, list.loading, loadMore]);

  const allSelected = list.ids.length > 0 && selection.length === list.ids.length;
  const someSelected = selection.length > 0;
  const selectedUnread = selection.some((id) => !list.emails[id]?.keywords?.$seen);
  const selectedFlagged = selection.length > 0 && selection.every((id) => list.emails[id]?.keywords?.$flagged);
  const rows = useMemo(() => list.ids.slice(start, end), [list.ids, start, end]);
  const title = search ? (t('wm.search.results') || 'Search results') : current ? nameOf(current) : '';
  const firstLoad = list.loading && list.ids.length === 0;

  const onOpen = useCallback((e: EmailListItem, ev: ReactMouseEvent) => {
    const ids = useWebmail.getState().list.ids;
    const index = ids.indexOf(e.id);
    if (ev.shiftKey && anchor.current !== null) {
      const [a, b] = [Math.min(anchor.current, index), Math.max(anchor.current, index)];
      setSelection([...new Set([...useWebmail.getState().selection, ...ids.slice(a, b + 1)])]);
      return;
    }
    anchor.current = index;
    // Ctrl / Cmd click selects; on a touch screen, a tap selects while a selection exists (Outlook mobile).
    if (ev.ctrlKey || ev.metaKey || (useWebmail.getState().selection.length > 0 && window.matchMedia('(hover: none)').matches)) {
      toggleSelected(e.id);
      return;
    }
    openThread(e.threadId);
  }, [openThread, setSelection, toggleSelected]);

  const onOpenKey = useCallback((e: EmailListItem) => {
    anchor.current = useWebmail.getState().list.ids.indexOf(e.id);
    openThread(e.threadId);
  }, [openThread]);

  const onToggle = useCallback((id: string, ev: ReactMouseEvent) => {
    const ids = useWebmail.getState().list.ids;
    const index = ids.indexOf(id);
    if (ev.shiftKey && anchor.current !== null) {
      const [a, b] = [Math.min(anchor.current, index), Math.max(anchor.current, index)];
      setSelection([...new Set([...useWebmail.getState().selection, ...ids.slice(a, b + 1)])]);
      return;
    }
    anchor.current = index;
    toggleSelected(id);
  }, [setSelection, toggleSelected]);

  const confirmDelete = () => {
    if (forGood && !window.confirm(t('wm.list.confirmDestroy') || 'Delete these messages permanently?')) return;
    void deleteThreads(selection);
  };

  const quickLabel = (q: QuickFilter) => (q === 'unread' ? (t('wm.list.quickUnread') || 'Unread') : q === 'flagged' ? (t('wm.list.quickFlagged') || 'Flagged') : (t('wm.list.quickAll') || 'All'));

  const empty = () => {
    if (search) {
      return (
        <EmptyState icon={<SearchX size={22} />} title={t('wm.search.none') || 'No message matches.'}
          description={t('wm.search.noneHint') || 'Try other words, or search every folder from the advanced search.'}
          action={<PillButton size="sm" onClick={() => setSearch(null)}>{t('wm.search.clear') || 'Clear the search'}</PillButton>} />
      );
    }
    if (quick !== 'all') {
      return (
        <EmptyState icon={quick === 'unread' ? <MailOpen size={22} /> : <Flag size={22} />}
          title={quick === 'unread' ? (t('wm.list.noUnread') || 'No unread message here.') : (t('wm.list.noFlagged') || 'No flagged message here.')}
          action={<PillButton size="sm" onClick={() => setQuick('all')}>{t('wm.list.showAll') || 'Show every message'}</PillButton>} />
      );
    }
    return (
      <EmptyState icon={<Inbox size={22} />} title={t('wm.list.empty') || 'This folder is empty.'}
        description={current?.role === 'inbox' ? (t('wm.list.emptyInbox') || 'New messages arrive here.') : undefined} />
    );
  };

  return (
    <section className={cn('flex h-full min-w-0 flex-col bg-bg-secondary', someSelected && 'wm-selecting')} aria-label={title}>
      {/* Header: folder, total, refresh; quick filters (Oblidesk view chips). */}
      <div className="shrink-0 space-y-2 px-3 pb-2 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <Checkbox checked={allSelected} partial={someSelected && !allSelected}
            label={allSelected ? (t('wm.list.selectNone') || 'Select none') : (t('wm.list.selectAll') || 'Select all')}
            onClick={() => setSelection(allSelected || someSelected ? [] : [...list.ids])} />
          <h2 className="ml-1 min-w-0 flex-1 truncate text-[15px] font-semibold text-text-primary">{title}</h2>
          {list.total > 0 && <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-muted">{list.total}</span>}
          <IconButton label={t('wm.actions.refresh') || 'Refresh'} onClick={() => { void refreshMailboxes(); void reloadList(); }}>
            <RefreshCw size={15} className={cn(list.loading && 'animate-spin')} />
          </IconButton>
        </div>
        <div className="flex items-center gap-1" role="tablist" aria-label={t('wm.list.quickTitle') || 'Show'}>
          {QUICK_FILTERS.map((q) => (
            <button key={q} type="button" role="tab" aria-selected={quick === q} onClick={() => setQuick(q)}
              className={cn(
                'inline-flex h-7 shrink-0 items-center rounded-[7px] px-2.5 text-[12px] transition-colors coarse:h-9',
                quick === q ? 'bg-accent font-semibold text-bg-primary' : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary',
              )}>
              {quickLabel(q)}
            </button>
          ))}
        </div>
      </div>

      {/* Bulk bar (selection): Oblidesk's accent-tinted card. */}
      {someSelected && (
        <div className="wm-card wm-fade-up mx-2 mb-1.5 flex shrink-0 items-center gap-0.5 rounded-[10px] bg-accent/10 py-1 pl-3 pr-1">
          <span className="mr-auto truncate text-[12px] font-medium text-text-primary">{t('wm.list.selected', { count: selection.length }) || `${selection.length} selected`}</span>
          <IconButton size="sm" label={selectedUnread ? (t('wm.actions.markRead') || 'Mark as read') : (t('wm.actions.markUnread') || 'Mark as unread')} onClick={() => { void markSeen(selection, selectedUnread); }}>
            {selectedUnread ? <MailOpen size={15} /> : <Mail size={15} />}
          </IconButton>
          <IconButton size="sm" active={selectedFlagged} label={selectedFlagged ? (t('wm.actions.unflag') || 'Remove the flag') : (t('wm.actions.flag') || 'Flag')} onClick={() => { void markFlagged(selection, !selectedFlagged); }}>
            <Flag size={15} />
          </IconButton>
          <div className="relative">
            <IconButton size="sm" label={t('wm.actions.move') || 'Move to…'} onClick={() => setMoveOpen((v) => !v)}><FolderInput size={15} /></IconButton>
            <MoveMenu open={moveOpen} onPick={(id) => { void moveTo(selection, id); }} onClose={() => setMoveOpen(false)} />
          </div>
          {canArchive() && <IconButton size="sm" label={t('wm.actions.archive') || 'Archive'} onClick={() => { void archive(selection); }}><Archive size={15} /></IconButton>}
          {canSpam() && <IconButton size="sm" label={t('wm.actions.spam') || 'Mark as spam'} onClick={() => { void markSpam(selection); }}><ShieldAlert size={15} /></IconButton>}
          <IconButton size="sm" tone="danger" label={forGood ? (t('wm.actions.destroy') || 'Delete permanently') : (t('wm.actions.delete') || 'Delete')} onClick={confirmDelete}><Trash2 size={15} /></IconButton>
          <IconButton size="sm" label={t('wm.list.selectNone') || 'Select none'} onClick={() => setSelection([])}><X size={15} /></IconButton>
        </div>
      )}

      <div ref={scroller} className="wm-scroll relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        {firstLoad && Array.from({ length: 9 }, (_, i) => <RowSkeleton key={i} />)}
        {list.ids.length === 0 && !list.loading && empty()}
        <div style={{ height: list.ids.length * ROW_HEIGHT }} className="relative">
          <ul className="absolute left-0 right-0" style={{ top: start * ROW_HEIGHT }} role="list">
            {rows.map((id) => {
              const e = list.emails[id];
              if (!e) return null;
              const to = e.to ?? [];
              const who = sentLike ? to.map(displayName).join(', ') : displayName(e.from?.[0]);
              const whoEmail = sentLike ? to[0]?.email ?? '' : e.from?.[0]?.email ?? '';
              return (
                <Row key={id} e={e} person={(sentLike ? to[0] : e.from?.[0]) ?? null} who={who} whoEmail={whoEmail} count={list.threadSizes[e.threadId] ?? 1}
                  selected={selection.includes(id)} open={openThreadId === e.threadId} lang={i18n.language} forGood={forGood}
                  onOpen={onOpen} onOpenKey={onOpenKey} onToggle={onToggle} />
              );
            })}
          </ul>
        </div>
        {/* Phone / tablet: room for the floating compose button under the last row. */}
        {list.ids.length > 0 && <div className="h-20 lg:hidden" aria-hidden />}
        {list.loading && list.ids.length > 0 && (
          <p className="flex items-center justify-center gap-2 py-3 text-[11px] text-text-muted">
            <RefreshCw size={11} className="animate-spin" />{t('wm.common.loading') || 'Loading…'}
          </p>
        )}
      </div>
    </section>
  );
}
