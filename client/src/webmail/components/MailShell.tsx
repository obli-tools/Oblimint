import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeftToLine, CalendarOff, ChevronDown, Command, CornerUpRight, Keyboard, ListFilter, LogOut, Menu, PanelLeft, PenSquare } from 'lucide-react';
import { Logo } from '@/components/common/Logo';
import { cn } from '@/utils/cn';
import { archive, canArchive, closeThread, COMPOSER_CLOSE_EVENT, currentTargets, deleteThreads, deletesForGood, stepThread, toggleFlag, toggleSeen } from '../actions';
import { wmApi } from '../api';
import { SHORTCUTS, useHotkeys } from '../hotkeys';
import { emptyDraft } from '../lib/compose';
import { clampWidth, maxListWidth } from '../lib/view';
import { panelLinkFor } from '../panelLink';
import { useWebmail } from '../store';
import { CommandPalette } from './CommandPalette';
import { Composer } from './Composer';
import { Dialog } from './Dialog';
import { MailboxTree } from './MailboxTree';
import { MessageList } from './MessageList';
import { ForwardingBanner } from './ForwardingBanner';
import { LanguagePicker, ThemePicker } from './Preferences';
import { ReadingPane } from './ReadingPane';
import { SearchBox, SEARCH_INPUT_ID } from './SearchBox';
import { SettingsDialog } from './Settings';
import { Avatar, IconButton, Kbd, MenuItem, MenuSeparator, Popover, Splitter } from './ui';

/**
 * Layout (Oblidesk's three-pane desk, Outlook-like):
 *   ┌──────────────────────── header ────────────────────────┐
 *   │ folders │ list (resizable) ┃ reading pane              │
 *   └─────────┴──────────────────┸───────────────────────────┘
 * ≥ lg: three panes, the folders column can be hidden. md: list + reading,
 * folders in a drawer. Phone: one pane at a time (list, or the conversation
 * with a back button — also the system Back button), folders in a drawer,
 * the composer full screen. Widths persist in this browser.
 */

const LIST_WIDTH_KEY = 'wm-list-width';
const SIDEBAR_KEY = 'wm-sidebar-hidden';
const LIST_BOUNDS = { min: 300, max: 640, fallback: 400 };
/** Narrowest reading pane the splitter leaves (px): md (no folders column), lg and up. Same values as the list's max-w classes. */
const READING_MIN = { md: 384, lg: 448 };

function readStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStored(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable: not kept */ }
}

const phone = () => window.matchMedia('(max-width: 767px)').matches;
const wide = () => window.matchMedia('(min-width: 1024px)').matches;

/** Layers over the list that the phone's Back button closes, in stacking order. */
type Layer = 'thread' | 'drawer' | 'compose';
const LAYERS: Layer[] = ['thread', 'drawer', 'compose'];

function AccountMenu({ panelUrl, onLogout }: { panelUrl: string | null; onLogout: () => void }) {
  const { t } = useTranslation();
  const session = useWebmail((s) => s.session);
  const setOverlay = useWebmail((s) => s.setOverlay);
  const openSettings = useWebmail((s) => s.openSettings);
  const forwardingActive = useWebmail((s) => !!s.forwarding?.active);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const address = session?.address ?? '';
  const name = session?.displayName?.trim() || '';
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog"
        title={address}
        className="flex h-9 max-w-[16rem] items-center gap-2 rounded-[10px] py-1 pl-1 pr-1.5 transition-colors hover:bg-bg-hover lg:bg-bg-hover lg:pr-2.5 lg:hover:bg-bg-active">
        <Avatar name={name || address} email={address} size={28} />
        <span className="hidden min-w-0 truncate text-[13px] font-medium text-text-primary lg:inline">{address}</span>
        <ChevronDown size={13} className={cn('hidden shrink-0 text-text-muted transition-transform lg:block', open && 'rotate-180')} />
      </button>
      <Popover open={open} onClose={close} role="dialog" label={t('wm.account.title') || 'Account'} className="w-[min(20rem,calc(100vw-1.5rem))]">
        <div className="flex items-center gap-3 px-3 pb-3 pt-2">
          <Avatar name={name || address} email={address} size={40} />
          <div className="min-w-0">
            {name && <div className="truncate text-[13px] font-semibold text-text-primary">{name}</div>}
            <div className={cn('truncate', name ? 'text-[12px] text-text-muted' : 'text-[13px] font-semibold text-text-primary')}>{address}</div>
            <div className="mt-1 inline-flex items-center gap-1.5 rounded-[7px] bg-accent/15 px-1.5 py-0.5 text-[10.5px] font-medium text-accent">
              <span className="h-1.5 w-1.5 rounded-full bg-obli-mint shadow-[0_0_6px_#98E8C8]" />
              {session?.method === 'sso' ? (t('wm.account.viaPanel') || 'Opened from Oblimint') : (t('wm.account.viaPassword') || 'Signed in with the mailbox password')}
            </div>
          </div>
        </div>
        <MenuSeparator />
        {panelUrl && <MenuItem icon={<ArrowLeftToLine size={14} />} onClick={() => { close(); window.location.assign(panelUrl); }}>{t('wm.back.toPanel') || 'Back to Oblimint'}</MenuItem>}
        <MenuItem icon={<CalendarOff size={14} />} onClick={() => { close(); openSettings('vacation'); }}>{t('wm.vacation.title') || 'Automatic replies'}</MenuItem>
        <MenuItem icon={<CornerUpRight size={14} />} hint={forwardingActive ? <span className="font-medium text-accent">{t('wm.forwarding.on') || 'on'}</span> : undefined}
          onClick={() => { close(); openSettings('forwarding'); }}>{t('wm.forwarding.title') || 'Forwarding'}</MenuItem>
        <MenuItem icon={<ListFilter size={14} />} onClick={() => { close(); openSettings('rules'); }}>{t('wm.rules.title') || 'Rules'}</MenuItem>
        <MenuItem icon={<Keyboard size={14} />} hint={<Kbd>?</Kbd>} onClick={() => { close(); setOverlay('shortcuts'); }}>{t('wm.keys.title') || 'Keyboard shortcuts'}</MenuItem>
        <MenuSeparator />
        <div className="space-y-2 px-3 py-2">
          <ThemePicker />
          <LanguagePicker />
        </div>
        <MenuSeparator />
        <MenuItem danger icon={<LogOut size={14} />} onClick={() => { close(); onLogout(); }}>{t('wm.logout') || 'Sign out'}</MenuItem>
      </Popover>
    </div>
  );
}

function ShortcutsDialog() {
  const { t } = useTranslation();
  const open = useWebmail((s) => s.overlay === 'shortcuts');
  const setOverlay = useWebmail((s) => s.setOverlay);
  const close = useCallback(() => setOverlay(null), [setOverlay]);
  return (
    <Dialog open={open} onClose={close} title={t('wm.keys.title') || 'Keyboard shortcuts'} closeLabel={t('wm.common.close') || 'Close'}>
      <ul className="grid grid-cols-1 gap-x-6 gap-y-1 pb-3 sm:grid-cols-2">
        {SHORTCUTS.map((s) => (
          <li key={s.key} className="flex items-center justify-between gap-3 py-1.5 text-[13px] text-text-secondary">
            <span className="min-w-0">{t(s.key) || s.fallback}</span>
            <span className="flex shrink-0 items-center gap-1">{s.keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

export function MailShell() {
  const { t } = useTranslation();
  const session = useWebmail((s) => s.session);
  const openThreadId = useWebmail((s) => s.openThreadId);
  const drawerOpen = useWebmail((s) => s.drawerOpen);
  const composer = useWebmail((s) => s.composer);
  const overlay = useWebmail((s) => s.overlay);
  const { setDrawer, openComposer, reset, setPhase, setOverlay } = useWebmail.getState();
  const panelUrl = panelLinkFor(session);
  const [listWidth, setListWidth] = useState(() => clampWidth(readStored(LIST_WIDTH_KEY), LIST_BOUNDS.min, LIST_BOUNDS.max, LIST_BOUNDS.fallback));
  const [sidebarHidden, setSidebarHidden] = useState(() => readStored(SIDEBAR_KEY) === '1');
  const dragStart = useRef(listWidth);
  const dragMax = useRef<number>(LIST_BOUNDS.max);
  const listRef = useRef<HTMLDivElement>(null);
  const readingRef = useRef<HTMLElement>(null);

  const logout = useCallback(async () => {
    await wmApi.logout();
    reset();
    setPhase('login');
  }, [reset, setPhase]);

  // Phone: each layer over the list (open conversation, full-screen composer, folders drawer) is a history
  // entry, so the system Back button closes it instead of leaving the webmail. `pushed` is the stack of the
  // entries THIS page pushed (an entry left by a previous load is never popped into the previous document).
  // A layer closed by anything else (a button, archive / delete of the open conversation, a sent message, a
  // picked folder) has its entry popped; several at once in one step.
  const pushed = useRef<Layer[]>([]);
  const ownPops = useRef(0);
  const syncHistory = useRef<() => void>(() => undefined);
  syncHistory.current = () => {
    const s = useWebmail.getState();
    const open: Record<Layer, boolean> = { thread: !!s.openThreadId, drawer: s.drawerOpen, compose: !!s.composer };
    let n = 0;
    while (pushed.current.length && !open[pushed.current[pushed.current.length - 1]]) { pushed.current.pop(); n++; }
    if (n) { ownPops.current++; window.history.go(-n); return; } // pushes wait for that traversal (popstate below)
    if (!phone()) return;
    for (const l of LAYERS) {
      if (open[l] && !pushed.current.includes(l)) { pushed.current.push(l); window.history.pushState({ wm: l }, ''); }
    }
  };
  useEffect(() => {
    const onPop = () => {
      if (ownPops.current > 0) { ownPops.current--; syncHistory.current(); return; }
      // System Back: the browser left the top entry; its layer closes (the composer saves its draft first).
      const layer = pushed.current.pop();
      const s = useWebmail.getState();
      if (layer === 'compose' && s.composer) window.dispatchEvent(new Event(COMPOSER_CLOSE_EVENT));
      else if (layer === 'drawer' && s.drawerOpen) s.setDrawer(false);
      else if (layer === 'thread' && s.openThreadId) s.openThread(null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => { syncHistory.current(); }, [openThreadId, drawerOpen, composer]);

  // Escape closes the phone drawer.
  useEffect(() => {
    if (!drawerOpen) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [drawerOpen, setDrawer]);

  // Single-key shortcuts on the conversation / selection never act while a composer is open: the focus may
  // have fallen back to the page (a removed attachment, the Cc button…) while the user is writing.
  const writing = () => !!useWebmail.getState().composer;
  const del = () => {
    if (writing()) return false;
    const ids = currentTargets();
    if (!ids.length) return;
    if (deletesForGood() && !window.confirm(t('wm.list.confirmDestroy') || 'Delete these messages permanently?')) return;
    void deleteThreads(ids);
  };
  useHotkeys({
    c: () => { if (!useWebmail.getState().composer) openComposer(emptyDraft()); },
    '/': () => document.getElementById(SEARCH_INPUT_ID)?.focus(),
    j: () => { if (writing()) return false; stepThread(1); },
    k: () => { if (writing()) return false; stepThread(-1); },
    e: () => { if (writing()) return false; const ids = currentTargets(); if (ids.length && canArchive()) void archive(ids); },
    '#': del,
    delete: del,
    u: () => { if (writing()) return false; void toggleSeen(currentTargets()); },
    s: () => { if (writing()) return false; void toggleFlag(currentTargets()); },
    x: () => { if (writing()) return false; const ids = currentTargets(); const s = useWebmail.getState(); if (ids.length === 1 && !s.selection.length) s.toggleSelected(ids[0]); },
    escape: () => {
      if (writing()) return false;
      const s = useWebmail.getState();
      if (s.selection.length) s.setSelection([]);
      else if (s.openThreadId) closeThread();
    },
    'mod+k': () => setOverlay('palette'),
    '?': () => setOverlay('shortcuts'),
  }, !overlay && !drawerOpen);

  /** Widest list the splitter allows now: the reading pane keeps READING_MIN. */
  const roomForList = () => maxListWidth(
    listRef.current?.offsetWidth ?? listWidth, readingRef.current?.offsetWidth ?? 0,
    (wide() ? READING_MIN.lg : READING_MIN.md) - 4, LIST_BOUNDS.min, LIST_BOUNDS.max,
  );

  const toggleSidebar = () => {
    setSidebarHidden((v) => { writeStored(SIDEBAR_KEY, v ? '0' : '1'); return !v; });
  };

  return (
    <div className="wm-app flex h-full flex-col bg-bg-primary">
      <header className="relative z-30 flex h-[52px] shrink-0 items-center gap-1.5 bg-bg-secondary pl-[max(0.5rem,var(--safe-left,0px))] pr-[max(0.5rem,var(--safe-right,0px))] sm:gap-2 md:gap-3 md:px-4">
        <IconButton className="lg:hidden" label={t('wm.folders.title') || 'Folders'} onClick={() => setDrawer(true)}><Menu size={18} /></IconButton>
        <IconButton className="max-lg:hidden" active={!sidebarHidden} label={sidebarHidden ? (t('wm.folders.show') || 'Show the folders') : (t('wm.folders.hide') || 'Hide the folders')} onClick={toggleSidebar}>
          <PanelLeft size={17} />
        </IconButton>
        <div className="flex shrink-0 items-center gap-2.5 max-sm:hidden">
          <Logo className="h-6" />
          <span className="flex items-center gap-1.5 rounded-[7px] bg-accent/15 px-2.5 py-1 text-[12px] font-semibold text-accent max-lg:hidden">
            <span className="h-2 w-2 rounded-full bg-obli-mint shadow-[0_0_8px_#98E8C8]" />{t('wm.title') || 'Webmail'}
          </span>
        </div>
        <SearchBox className="min-w-0 flex-1 md:ml-3 md:max-w-xl" />
        <div className="flex-1 max-md:hidden" />
        {panelUrl && (
          <a href={panelUrl}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[7px] bg-bg-tertiary px-2 text-[12.5px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary coarse:h-10 sm:px-2.5"
            title={t('wm.back.toPanelHint') || 'Back to the Oblimint panel'}>
            <ArrowLeftToLine size={15} className="shrink-0 text-accent" />
            <span className="max-md:hidden">{t('wm.back.toPanel') || 'Back to Oblimint'}</span>
            <span className="md:hidden">{t('wm.back.short') || 'Oblimint'}</span>
          </a>
        )}
        <IconButton className="max-md:hidden" label={`${t('wm.palette.title') || 'Command palette'} (Ctrl+K)`} onClick={() => setOverlay('palette')}><Command size={16} /></IconButton>
        <AccountMenu panelUrl={panelUrl} onLogout={() => { void logout(); }} />
      </header>

      <ForwardingBanner />

      <div className="flex min-h-0 flex-1">
        {/* Folders: column from lg (unless hidden), drawer below. */}
        {!sidebarHidden && (
          <aside className="hidden h-full w-[232px] shrink-0 bg-bg-secondary lg:block">
            <MailboxTree />
          </aside>
        )}
        {drawerOpen && (
          <div className="fixed inset-0 z-40 flex lg:hidden">
            <div className="wm-backdrop absolute inset-0" onClick={() => setDrawer(false)} />
            <aside className="wm-pop relative h-full w-72 max-w-[85vw] bg-bg-secondary pt-[var(--safe-top,0px)] animate-obli-slide-in-left">
              <MailboxTree />
            </aside>
          </div>
        )}

        <div
          ref={listRef}
          style={{ ['--wm-list-w' as string]: `${listWidth}px` }}
          className={cn(
            // The reading pane keeps READING_MIN whatever the stored width (window resized, folders shown again).
            'min-w-0 overflow-hidden md:w-[var(--wm-list-w)] md:max-w-[calc(100%-24rem)] md:shrink-0 lg:ml-1 lg:max-w-[calc(100%-232px-4px-28rem)] lg:rounded-tl-[10px]',
            sidebarHidden && 'lg:ml-0 lg:max-w-[calc(100%-28rem)] lg:rounded-none',
            openThreadId ? 'max-md:hidden' : 'flex-1 md:flex-none',
          )}
        >
          <MessageList />
        </div>
        <Splitter
          className="max-md:hidden"
          label={t('wm.list.resize') || 'Resize the list'}
          onDragStart={() => {
            // From the rendered width (a stored width may be capped by the max-w classes), bounded by the room left.
            dragStart.current = listRef.current?.offsetWidth || listWidth;
            dragMax.current = roomForList();
          }}
          onDrag={(dx) => setListWidth(clampWidth(dragStart.current + dx, LIST_BOUNDS.min, dragMax.current, LIST_BOUNDS.fallback))}
          onDragEnd={() => setListWidth((w) => { writeStored(LIST_WIDTH_KEY, String(w)); return w; })}
          onNudge={(dx) => {
            const n = clampWidth((listRef.current?.offsetWidth || listWidth) + dx, LIST_BOUNDS.min, roomForList(), LIST_BOUNDS.fallback);
            setListWidth(n);
            writeStored(LIST_WIDTH_KEY, String(n));
          }}
          onReset={() => { setListWidth(LIST_BOUNDS.fallback); writeStored(LIST_WIDTH_KEY, String(LIST_BOUNDS.fallback)); }}
        />
        <main ref={readingRef} className={cn('min-w-0 flex-1', !openThreadId && 'max-md:hidden')}>
          <ReadingPane />
        </main>
      </div>

      {/* Phone / tablet: compose button. */}
      {!composer && !openThreadId && (
        <button type="button" onClick={() => openComposer(emptyDraft())}
          className="wm-pop fixed bottom-[max(1.25rem,var(--safe-bottom,0px))] right-5 z-30 flex h-14 w-14 items-center justify-center rounded-[16px] bg-accent text-bg-primary transition-colors hover:bg-accent-hover lg:hidden"
          aria-label={t('wm.compose.new') || 'New message'}>
          <PenSquare size={20} />
        </button>
      )}
      {composer && <Composer key={composer.key} c={composer} />}
      <SettingsDialog />
      <ShortcutsDialog />
      <CommandPalette panelUrl={panelUrl} onLogout={() => { void logout(); }} />
    </div>
  );
}
