import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeftToLine, CalendarOff, CloudMoon, CornerDownLeft, CornerUpRight, Filter, Keyboard, ListFilter, LogOut, Moon, PenSquare, RefreshCw, Search, Sun,
} from 'lucide-react';
import { applyTheme } from '@/utils/theme';
import { cn } from '@/utils/cn';
import { emptyDraft } from '../lib/compose';
import { useWebmail } from '../store';
import { flattenTree, roleIcon, useMailboxName } from './MailboxTree';
import { SEARCH_INPUT_ID } from './SearchBox';
import { Kbd } from './ui';

// Command palette (Oblidesk layout/CommandPalette): Ctrl+K, type to filter,
// ↑ ↓ to move, Enter to run, Esc to close. Commands: write, search, folders,
// quick filters, theme, automatic replies / forwarding / rules, shortcuts, back to the panel,
// sign out.

interface Command {
  id: string;
  group: 'actions' | 'folders' | 'view' | 'theme';
  title: string;
  icon: ReactNode;
  hint?: string;
  run: () => void;
}

/** Lower case without accents (search "boite" finds "Boîte de réception"). */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function CommandPalette({ panelUrl, onLogout }: { panelUrl: string | null; onLogout: () => void }) {
  const { t } = useTranslation();
  const open = useWebmail((s) => s.overlay === 'palette');
  const mailboxes = useWebmail((s) => s.mailboxes);
  const composer = useWebmail((s) => s.composer);
  const nameOf = useMailboxName();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = () => useWebmail.getState().setOverlay(null);

  const commands = useMemo<Command[]>(() => {
    const s = useWebmail.getState();
    const after = (fn: () => void) => () => { s.setOverlay(null); fn(); };
    const list: Command[] = [];
    if (!composer) list.push({ id: 'compose', group: 'actions', title: t('wm.compose.new') || 'New message', icon: <PenSquare size={15} />, hint: 'C', run: after(() => s.openComposer(emptyDraft())) });
    list.push(
      { id: 'search', group: 'actions', title: t('wm.keys.search') || 'Search', icon: <Search size={15} />, hint: '/', run: after(() => window.setTimeout(() => document.getElementById(SEARCH_INPUT_ID)?.focus(), 0)) },
      { id: 'refresh', group: 'actions', title: t('wm.actions.refresh') || 'Refresh', icon: <RefreshCw size={15} />, run: after(() => { void s.refreshMailboxes(); void s.reloadList(); }) },
      { id: 'vacation', group: 'actions', title: t('wm.vacation.title') || 'Automatic replies', icon: <CalendarOff size={15} />, run: () => s.openSettings('vacation') },
      { id: 'forwarding', group: 'actions', title: t('wm.forwarding.title') || 'Forwarding', icon: <CornerUpRight size={15} />, run: () => s.openSettings('forwarding') },
      { id: 'rules', group: 'actions', title: t('wm.rules.title') || 'Rules', icon: <ListFilter size={15} />, run: () => s.openSettings('rules') },
      { id: 'shortcuts', group: 'actions', title: t('wm.keys.title') || 'Keyboard shortcuts', icon: <Keyboard size={15} />, hint: '?', run: () => s.setOverlay('shortcuts') },
    );
    if (panelUrl) list.push({ id: 'panel', group: 'actions', title: t('wm.back.toPanel') || 'Back to Oblimint', icon: <ArrowLeftToLine size={15} />, run: after(() => { window.location.assign(panelUrl); }) });
    list.push({ id: 'logout', group: 'actions', title: t('wm.logout') || 'Sign out', icon: <LogOut size={15} />, run: after(onLogout) });
    for (const { m, depth } of flattenTree(mailboxes)) {
      list.push({ id: `mb-${m.id}`, group: 'folders', title: `${depth ? '› '.repeat(depth) : ''}${nameOf(m)}`, icon: roleIcon(m.role), hint: m.unreadEmails ? String(m.unreadEmails) : undefined, run: after(() => s.openMailbox(m.id)) });
    }
    list.push(
      { id: 'q-all', group: 'view', title: t('wm.list.quickAll') || 'All', icon: <Filter size={15} />, run: after(() => s.setQuick('all')) },
      { id: 'q-unread', group: 'view', title: t('wm.list.quickUnread') || 'Unread', icon: <Filter size={15} />, run: after(() => s.setQuick('unread')) },
      { id: 'q-flagged', group: 'view', title: t('wm.list.quickFlagged') || 'Flagged', icon: <Filter size={15} />, run: after(() => s.setQuick('flagged')) },
      { id: 't-dark', group: 'theme', title: t('wm.prefs.themeDark') || 'Dark', icon: <Moon size={15} />, run: after(() => applyTheme('obli-operator')) },
      { id: 't-light', group: 'theme', title: t('wm.prefs.themeLight') || 'Light', icon: <Sun size={15} />, run: after(() => applyTheme('obli-daylight')) },
      { id: 't-dim', group: 'theme', title: t('wm.prefs.themeDim') || 'Slate', icon: <CloudMoon size={15} />, run: after(() => applyTheme('obli-dim')) },
    );
    return list;
  }, [t, composer, mailboxes, nameOf, panelUrl, onLogout]);

  const rows = useMemo(() => {
    const q = fold(query.trim());
    return q ? commands.filter((c) => fold(c.title).includes(q)) : commands;
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    window.setTimeout(() => input.current?.focus(), 0);
  }, [open]);
  useEffect(() => { setCursor(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector('[data-cursor="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!open) return null;

  const groupLabel: Record<Command['group'], string> = {
    actions: t('wm.palette.actions') || 'Actions',
    folders: t('wm.folders.title') || 'Folders',
    view: t('wm.list.quickTitle') || 'Show',
    theme: t('wm.prefs.theme') || 'Theme',
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(rows.length - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); rows[cursor]?.run(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };

  return createPortal(
    <div className="wm-backdrop fixed inset-0 z-[70] flex items-start justify-center px-4 py-[12vh]" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div role="dialog" aria-modal="true" aria-label={t('wm.palette.title') || 'Command palette'}
        className="wm-pop wm-scale-in flex w-full max-w-xl flex-col overflow-hidden rounded-[14px] bg-bg-secondary">
        <div className="flex items-center gap-2.5 px-4 py-3">
          <Search size={16} className="shrink-0 text-text-muted" />
          <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}
            placeholder={t('wm.palette.placeholder') || 'Type a command or a folder…'} aria-label={t('wm.palette.title') || 'Command palette'}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-text-primary outline-none placeholder:text-text-muted" autoComplete="off" spellCheck={false} />
          <Kbd>Esc</Kbd>
        </div>
        <div className="h-px bg-border" />
        <div ref={listRef} className="wm-scroll max-h-[52vh] overflow-y-auto py-2">
          {rows.length === 0 && <p className="px-4 py-6 text-center text-[13px] text-text-muted">{t('wm.palette.none') || 'No command matches.'}</p>}
          {(['actions', 'folders', 'view', 'theme'] as const).map((g) => {
            const items = rows.filter((r) => r.group === g);
            if (!items.length) return null;
            return (
              <div key={g}>
                <div className="px-4 pb-1 pt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">{groupLabel[g]}</div>
                {items.map((c) => {
                  const i = rows.indexOf(c);
                  const on = i === cursor;
                  return (
                    <button key={c.id} type="button" data-cursor={on} onMouseEnter={() => setCursor(i)} onClick={() => c.run()}
                      className={cn('flex w-full items-center gap-3 px-4 py-2 text-left transition-colors', on ? 'bg-bg-hover' : 'hover:bg-bg-hover/60')}>
                      <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px]', on ? 'bg-accent/15 text-accent' : 'bg-bg-tertiary text-text-muted')}>{c.icon}</span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">{c.title}</span>
                      {c.hint && <Kbd>{c.hint}</Kbd>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="h-px bg-border" />
        <div className="flex items-center gap-4 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-text-muted max-sm:hidden">
          <span className="flex items-center gap-1"><CornerDownLeft size={11} /> {t('wm.palette.run') || 'Run'}</span>
          <span>↑↓ {t('wm.palette.move') || 'Move'}</span>
          <span>Esc {t('wm.common.close') || 'Close'}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
