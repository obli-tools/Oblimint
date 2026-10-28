import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageContainer } from '@/components/common/PageContainer';
import { cn } from '@/utils/cn';

// Table of contents of the single Settings page (coherence plan C11): the
// page stays ONE scrolling page (Obliance DNA); a sticky summary on a large
// screen, chips on a small one, and every section is an anchor
// (/settings#<id>) the operation pages link to.

interface TocEntry {
  id: string;
  title: string;
  /** null for a group, else the id of its group. */
  group: string | null;
}

/** A family of sections: a group of the table of contents (`data-toc-group`). */
export function SettingsGroup({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} data-toc-title={title} data-toc-group="" className="scroll-mt-4 space-y-8">
      {children}
    </section>
  );
}

/** Entries of the container: groups, and the anchored blocks inside them. */
function scan(container: HTMLElement): TocEntry[] {
  const out: TocEntry[] = [];
  container.querySelectorAll<HTMLElement>('[data-toc-title][id]').forEach((el) => {
    const isGroup = el.hasAttribute('data-toc-group');
    const group = isGroup ? null : (el.parentElement?.closest<HTMLElement>('[data-toc-group][id]')?.id ?? null);
    // A duplicated id (loading placeholder then the block) is listed once.
    if (out.some((e) => e.id === el.id)) return;
    out.push({ id: el.id, title: el.dataset.tocTitle ?? el.id, group });
  });
  return out;
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  let p = el.parentElement;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') return p;
    p = p.parentElement;
  }
  return null;
}

/**
 * Hook + views of the table of contents of `containerRef`: entries follow the
 * sections actually rendered (rights, loading), the hash scrolls to its
 * section once it exists, the active entry follows the scroll.
 */
export function useSettingsToc(containerRef: RefObject<HTMLElement>) {
  const location = useLocation();
  const navigate = useNavigate();
  const [entries, setEntries] = useState<TocEntry[]>([]);
  const [active, setActive] = useState<string | null>(null);

  // Entries: rescanned when the sections render (async loads, rights).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let last = '';
    const update = () => {
      const next = scan(container);
      const key = JSON.stringify(next);
      if (key !== last) { last = key; setEntries(next); }
    };
    update();
    const obs = new MutationObserver(update);
    obs.observe(container, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [containerRef]);

  // Hash → scroll to the section, waiting for it to render (sections load on their own).
  const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
  useEffect(() => {
    const container = containerRef.current;
    if (!hash || !container) return;
    let done = false;
    const timers: number[] = [];
    const go = () => {
      const el = document.getElementById(hash);
      if (!el || !container.contains(el)) return false;
      el.scrollIntoView({ block: 'start' });
      return true;
    };
    const settle = () => {
      done = true;
      obs.disconnect();
      // Sections above may still grow while they load: align again once.
      timers.push(window.setTimeout(go, 700));
    };
    const obs = new MutationObserver(() => { if (!done && go()) settle(); });
    if (go()) settle();
    else {
      obs.observe(container, { childList: true, subtree: true });
      timers.push(window.setTimeout(() => { done = true; obs.disconnect(); }, 8000));
    }
    return () => { obs.disconnect(); timers.forEach((x) => window.clearTimeout(x)); };
  }, [hash, containerRef]);

  // Active entry: the last section whose top passed the top of the scroll area.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scroller = scrollParent(container);
    let frame = 0;
    const compute = () => {
      frame = 0;
      const top = (scroller?.getBoundingClientRect().top ?? 0) + 96;
      let current: string | null = null;
      for (const e of entriesRef.current) {
        const el = document.getElementById(e.id);
        if (el && el.getBoundingClientRect().top <= top) current = e.id;
      }
      setActive(current ?? entriesRef.current[0]?.id ?? null);
    };
    const onScroll = () => { if (!frame) frame = window.requestAnimationFrame(compute); };
    compute();
    (scroller ?? window).addEventListener('scroll', onScroll, { passive: true });
    return () => {
      (scroller ?? window).removeEventListener('scroll', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [containerRef, entries]);

  const goTo = useCallback((id: string) => {
    if (id === hash) document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    else navigate({ hash: `#${id}` }, { replace: true });
  }, [hash, navigate]);

  return { entries, active, goTo };
}

type Toc = ReturnType<typeof useSettingsToc>;

/** The summary is worth showing: at least two families of sections. */
function hasGroups(toc: Toc): boolean {
  return toc.entries.filter((e) => e.group === null).length >= 2;
}

/** Group of the active entry (itself, or the group it belongs to). */
function activeGroup(toc: Toc): string | null {
  const e = toc.entries.find((x) => x.id === toc.active);
  return e ? (e.group ?? e.id) : null;
}

/** Sticky summary (large screens): every group, the blocks of the active group. */
export function SettingsTocNav({ toc }: { toc: Toc }) {
  const { t } = useTranslation();
  const group = activeGroup(toc);
  // A single family (staff with the notification channels only): nothing to summarise.
  if (!hasGroups(toc)) return null;
  return (
    <nav aria-label={t('settings.toc.title') || 'On this page'} className="sticky top-6 max-h-[calc(100dvh-9rem)] overflow-y-auto pb-4">
      <p className="mb-2 px-3 text-[10px] font-bold uppercase tracking-widest text-text-muted">{t('settings.toc.title') || 'On this page'}</p>
      <ul className="space-y-0.5">
        {toc.entries.filter((e) => e.group === null || e.group === group).map((e) => (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => toc.goTo(e.id)}
              aria-current={toc.active === e.id ? 'location' : undefined}
              className={cn(
                'w-full truncate rounded-md py-1.5 text-left transition-colors',
                e.group === null ? 'px-3 text-[13px]' : 'pl-6 pr-3 text-[12px]',
                toc.active === e.id
                  ? 'bg-bg-active text-text-primary'
                  : e.id === group
                    ? 'text-text-primary hover:bg-bg-hover'
                    : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
              )}
            >
              {e.title}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Chips of the groups (small screens), above the sections. */
export function SettingsTocChips({ toc, className }: { toc: Toc; className?: string }) {
  const { t } = useTranslation();
  const groups = toc.entries.filter((e) => e.group === null);
  const group = activeGroup(toc);
  if (groups.length < 2) return null;
  return (
    <nav aria-label={t('settings.toc.title') || 'On this page'} className={cn('-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none]', className)}>
      {groups.map((g) => (
        <button
          key={g.id}
          type="button"
          onClick={() => toc.goTo(g.id)}
          className={cn(
            'shrink-0 rounded-full px-3 py-1 text-xs transition-colors coarse:py-2',
            g.id === group ? 'bg-accent text-white' : 'bg-bg-secondary text-text-muted hover:text-text-primary',
          )}
        >
          {g.title}
        </button>
      ))}
    </nav>
  );
}

/** The page: the sections (`contentRef`) and, on a large screen, the sticky summary beside them. */
export function SettingsPageLayout({ toc, contentRef, children }: { toc: Toc; contentRef: RefObject<HTMLDivElement>; children: ReactNode }) {
  return (
    <PageContainer className="flex gap-8">
      <div ref={contentRef} className="min-w-0 flex-1 space-y-8">{children}</div>
      {hasGroups(toc) && <aside className="hidden w-56 shrink-0 xl:block"><SettingsTocNav toc={toc} /></aside>}
    </PageContainer>
  );
}
