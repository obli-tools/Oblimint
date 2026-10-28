import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarOff, ChevronDown, LogOut, Menu, PenSquare } from 'lucide-react';
import { Logo } from '@/components/common/Logo';
import { cn } from '@/utils/cn';
import { wmApi } from '../api';
import { emptyDraft } from '../lib/compose';
import { useWebmail } from '../store';
import { Composer } from './Composer';
import { MailboxTree } from './MailboxTree';
import { MessageList } from './MessageList';
import { LanguageThemeBar, VacationDialog } from './Preferences';
import { ReadingPane } from './ReadingPane';
import { SearchBox } from './SearchBox';

/**
 * Layout (Obliance shell): top bar, folders sidebar, message list, reading
 * pane. ≥ lg: three columns. md: folders in a drawer. Phone: one column
 * (list, or the open conversation full screen), folders in a drawer, the
 * composer full screen.
 */
export function MailShell() {
  const { t } = useTranslation();
  const session = useWebmail((s) => s.session);
  const openThreadId = useWebmail((s) => s.openThreadId);
  const drawerOpen = useWebmail((s) => s.drawerOpen);
  const composer = useWebmail((s) => s.composer);
  const { setDrawer, openComposer, reset, setPhase } = useWebmail.getState();
  const [menu, setMenu] = useState(false);
  const [vacation, setVacation] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [menu]);

  const logout = async () => {
    await wmApi.logout();
    reset();
    setPhase('login');
  };

  return (
    <div className="flex h-full flex-col bg-bg-primary">
      <header className="relative z-20 flex h-[52px] shrink-0 items-center gap-3 bg-bg-secondary pl-[max(0.75rem,var(--safe-left,0px))] pr-[max(0.75rem,var(--safe-right,0px))] md:pl-4 md:pr-4">
        <button type="button" onClick={() => setDrawer(true)} className="rounded-md p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary lg:hidden coarse:min-h-10 coarse:min-w-10" aria-label={t('wm.folders.title') || 'Folders'}>
          <Menu size={18} />
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <Logo className="h-6 max-sm:hidden" />
          <span className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-text-secondary max-sm:hidden">
            <span className="h-1.5 w-1.5 rounded-full bg-obli-mint" />{t('wm.title') || 'Webmail'}
          </span>
        </div>
        <SearchBox className="min-w-0 flex-1 md:max-w-xl" />
        <div className="flex-1 max-md:hidden" />
        <div ref={menuRef} className="relative">
          <button type="button" onClick={() => setMenu((v) => !v)} className="flex max-w-[16rem] items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary coarse:min-h-10" aria-expanded={menu}>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs font-semibold uppercase text-accent">{(session?.address ?? '?').slice(0, 1)}</span>
            <span className="truncate max-md:hidden">{session?.address}</span>
            <ChevronDown size={14} className="shrink-0" />
          </button>
          {menu && (
            <div className="absolute right-0 top-full mt-1 w-72 rounded-lg border border-border bg-bg-secondary p-2 shadow-xl">
              <div className="truncate px-2 pb-2 pt-1 text-sm font-medium text-text-primary">{session?.address}</div>
              <button type="button" onClick={() => { setMenu(false); setVacation(true); }} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary">
                <CalendarOff size={15} />{t('wm.vacation.title') || 'Vacation responder'}
              </button>
              <LanguageThemeBar className="px-2 py-2" />
              <div className="my-1 h-px bg-border" />
              <button type="button" onClick={() => { void logout(); }} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary">
                <LogOut size={15} />{t('wm.logout') || 'Sign out'}
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Folders: column from lg, drawer below. */}
        <aside className="hidden w-60 shrink-0 bg-bg-secondary lg:block">
          <MailboxTree />
        </aside>
        {drawerOpen && (
          <div className="fixed inset-0 z-40 flex lg:hidden" onMouseDown={(e) => { if (e.target === e.currentTarget) setDrawer(false); }}>
            <div className="absolute inset-0 bg-black/50" onClick={() => setDrawer(false)} />
            <aside className="relative h-full w-72 max-w-[85vw] bg-bg-secondary shadow-2xl animate-obli-slide-in-left">
              <MailboxTree />
            </aside>
          </div>
        )}

        <div className={cn('min-w-0 border-r border-border md:w-[22rem] md:shrink-0 xl:w-[26rem]', openThreadId ? 'max-md:hidden' : 'flex-1 md:flex-none')}>
          <MessageList />
        </div>
        <main className={cn('min-w-0 flex-1 bg-bg-primary', !openThreadId && 'max-md:hidden')}>
          <ReadingPane />
        </main>
      </div>

      {/* Phone: compose button. */}
      {!composer && !openThreadId && (
        <button type="button" onClick={() => openComposer(emptyDraft())}
          className="fixed bottom-5 right-5 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-xl lg:hidden"
          aria-label={t('wm.compose.new') || 'New message'}>
          <PenSquare size={20} />
        </button>
      )}
      {composer && <Composer key={composer.key} c={composer} />}
      <VacationDialog open={vacation} onClose={() => setVacation(false)} />
    </div>
  );
}
