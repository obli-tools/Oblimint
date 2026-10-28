import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive, CheckSquare, Flag, FolderInput, Mail, MailOpen, MinusSquare, Paperclip, RefreshCw, ShieldAlert, Square, Trash2,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { archive, canArchive, canSpam, deleteThreads, markFlagged, markSeen, markSpam, moveTo } from '../actions';
import { displayName } from '../lib/compose';
import { formatListDate } from '../lib/format';
import { mailboxByRole, useWebmail } from '../store';
import { flattenTree, useMailboxName } from './MailboxTree';

/** Fixed row height: the list is windowed (only the visible rows exist in the DOM). */
export const ROW_HEIGHT = 76;
const OVERSCAN = 8;

export function ToolbarButton({ title, onClick, children, disabled, active }: {
  title: string; onClick: () => void; children: React.ReactNode; disabled?: boolean; active?: boolean;
}) {
  return (
    <button
      type="button" title={title} aria-label={title} onClick={onClick} disabled={disabled}
      className={cn(
        'inline-flex items-center justify-center rounded-md p-2 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent coarse:min-h-10 coarse:min-w-10',
        active && 'text-accent',
      )}
    >
      {children}
    </button>
  );
}

export function MoveMenu({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) {
  const mailboxes = useWebmail((s) => s.mailboxes);
  const current = useWebmail((s) => s.currentMailboxId);
  const nameOf = useMailboxName();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [onClose]);
  return (
    <div ref={ref} className="absolute right-0 top-full z-30 mt-1 max-h-80 w-56 overflow-y-auto rounded-lg border border-border bg-bg-secondary py-1 shadow-xl">
      {flattenTree(mailboxes).filter(({ m }) => m.id !== current && m.role !== 'drafts').map(({ m, depth }) => (
        <button key={m.id} type="button" onClick={() => { onPick(m.id); onClose(); }}
          className="block w-full truncate px-3 py-2 text-left text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          style={{ paddingLeft: `${0.75 + depth * 0.75}rem` }}>
          {nameOf(m)}
        </button>
      ))}
    </div>
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
  const { setSelection, toggleSelected, openThread, loadMore, reloadList, refreshMailboxes } = useWebmail.getState();
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [moveOpen, setMoveOpen] = useState(false);
  const nameOf = useMailboxName();
  const current = mailboxes.find((m) => m.id === currentId) ?? null;
  const sentLike = current?.role === 'sent' || current?.role === 'drafts';
  const inTrash = !!current && current.id === mailboxByRole(mailboxes, 'trash')?.id;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  // A new list starts at the top.
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); setScrollTop(0); }, [currentId, search]);

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

  const confirmDelete = () => {
    if (inTrash && !window.confirm(t('wm.list.confirmDestroy') || 'Delete these messages permanently?')) return;
    void deleteThreads(selection);
  };

  return (
    <section className="flex h-full min-w-0 flex-col" aria-label={title}>
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <ToolbarButton title={allSelected ? (t('wm.list.selectNone') || 'Select none') : (t('wm.list.selectAll') || 'Select all')} onClick={() => setSelection(allSelected ? [] : [...list.ids])}>
          {allSelected ? <CheckSquare size={17} /> : someSelected ? <MinusSquare size={17} /> : <Square size={17} />}
        </ToolbarButton>
        {someSelected ? (
          <>
            <ToolbarButton title={selectedUnread ? (t('wm.actions.markRead') || 'Mark as read') : (t('wm.actions.markUnread') || 'Mark as unread')} onClick={() => { void markSeen(selection, selectedUnread); }}>
              {selectedUnread ? <MailOpen size={17} /> : <Mail size={17} />}
            </ToolbarButton>
            <ToolbarButton title={selectedFlagged ? (t('wm.actions.unflag') || 'Remove the flag') : (t('wm.actions.flag') || 'Flag')} active={selectedFlagged} onClick={() => { void markFlagged(selection, !selectedFlagged); }}>
              <Flag size={17} />
            </ToolbarButton>
            <div className="relative">
              <ToolbarButton title={t('wm.actions.move') || 'Move to…'} onClick={() => setMoveOpen((v) => !v)}><FolderInput size={17} /></ToolbarButton>
              {moveOpen && <MoveMenu onPick={(id) => { void moveTo(selection, id); }} onClose={() => setMoveOpen(false)} />}
            </div>
            {canArchive() && <ToolbarButton title={t('wm.actions.archive') || 'Archive'} onClick={() => { void archive(selection); }}><Archive size={17} /></ToolbarButton>}
            {canSpam() && <ToolbarButton title={t('wm.actions.spam') || 'Mark as spam'} onClick={() => { void markSpam(selection); }}><ShieldAlert size={17} /></ToolbarButton>}
            <ToolbarButton title={inTrash ? (t('wm.actions.destroy') || 'Delete permanently') : (t('wm.actions.delete') || 'Delete')} onClick={confirmDelete}><Trash2 size={17} /></ToolbarButton>
            <span className="ml-1 truncate text-xs text-text-muted">{t('wm.list.selected', { count: selection.length }) || `${selection.length} selected`}</span>
          </>
        ) : (
          <>
            <h2 className="ml-1 min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{title}</h2>
            <span className="text-xs text-text-muted">{list.total > 0 ? list.total : ''}</span>
            <ToolbarButton title={t('wm.actions.refresh') || 'Refresh'} onClick={() => { void refreshMailboxes(); void reloadList(); }}>
              <RefreshCw size={16} className={cn(list.loading && 'animate-spin')} />
            </ToolbarButton>
          </>
        )}
      </div>

      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        {list.ids.length === 0 && !list.loading && (
          <p className="px-4 py-10 text-center text-sm text-text-muted">{search ? (t('wm.search.none') || 'No message matches.') : (t('wm.list.empty') || 'This folder is empty.')}</p>
        )}
        <div style={{ height: list.ids.length * ROW_HEIGHT }} className="relative">
          <ul className="absolute left-0 right-0" style={{ top: start * ROW_HEIGHT }} role="list">
            {rows.map((id) => {
              const e = list.emails[id];
              if (!e) return null;
              const unread = !e.keywords?.$seen;
              const flagged = !!e.keywords?.$flagged;
              const selected = selection.includes(id);
              const open = openThreadId === e.threadId;
              const who = sentLike ? (e.to ?? []).map(displayName).join(', ') : displayName(e.from?.[0]);
              const count = list.threadSizes[e.threadId] ?? 1;
              return (
                <li key={id} style={{ height: ROW_HEIGHT }}
                  className={cn(
                    'group flex cursor-pointer items-stretch border-b border-border/60 transition-colors',
                    open ? 'bg-bg-active' : selected ? 'bg-bg-hover' : 'hover:bg-bg-hover',
                  )}
                  onClick={() => openThread(e.threadId)}
                >
                  <span className={cn('w-1 shrink-0', unread ? 'bg-accent' : 'bg-transparent')} />
                  <button type="button" onClick={(ev) => { ev.stopPropagation(); toggleSelected(id); }}
                    className="flex w-9 shrink-0 items-start justify-center pt-3 text-text-muted hover:text-text-primary"
                    aria-label={t('wm.list.select') || 'Select'} aria-pressed={selected}>
                    {selected ? <CheckSquare size={16} className="text-accent" /> : <Square size={16} />}
                  </button>
                  <div className="min-w-0 flex-1 py-2 pr-3">
                    <div className="flex items-center gap-2">
                      <span className={cn('min-w-0 flex-1 truncate text-sm', unread ? 'font-semibold text-text-primary' : 'text-text-secondary')}>
                        {who || (t('wm.list.noSender') || '(no sender)')}
                        {count > 1 && <span className="ml-1.5 text-xs font-normal text-text-muted">{count}</span>}
                      </span>
                      {e.hasAttachment && <Paperclip size={13} className="shrink-0 text-text-muted" />}
                      <button type="button" title={flagged ? (t('wm.actions.unflag') || 'Remove the flag') : (t('wm.actions.flag') || 'Flag')}
                        onClick={(ev) => { ev.stopPropagation(); void markFlagged([id], !flagged); }}
                        className={cn('shrink-0', flagged ? 'text-amber-400' : 'text-text-muted opacity-0 group-hover:opacity-100 coarse:opacity-60')}>
                        <Flag size={13} fill={flagged ? 'currentColor' : 'none'} />
                      </button>
                      <span className="shrink-0 font-mono text-[11px] text-text-muted">{formatListDate(e.receivedAt, i18n.language)}</span>
                    </div>
                    <div className={cn('truncate text-sm', unread ? 'text-text-primary' : 'text-text-secondary')}>{e.subject || (t('wm.list.noSubject') || '(no subject)')}</div>
                    <div className="truncate text-xs text-text-muted">{e.preview}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        {list.loading && <p className="py-3 text-center text-xs text-text-muted">{t('wm.common.loading') || 'Loading…'}</p>}
      </div>
    </section>
  );
}
