import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { cn } from '@/utils/cn';
import type { SearchQuery } from '../jmap';
import { useWebmail } from '../store';
import { Kbd, PillButton } from './ui';

/** Id of the search field (the "/" shortcut focuses it). */
export const SEARCH_INPUT_ID = 'wm-search';

/** Search: free text + advanced fields (from, to, subject, attachment, every folder) → JMAP filter. */
export function SearchBox({ className }: { className?: string }) {
  const { t } = useTranslation();
  const search = useWebmail((s) => s.search);
  const setSearch = useWebmail((s) => s.setSearch);
  const [q, setQ] = useState<SearchQuery>({});
  const [advanced, setAdvanced] = useState(false);
  const box = useRef<HTMLFormElement>(null);

  useEffect(() => { if (!search) setQ({}); }, [search]);
  useEffect(() => {
    if (!advanced) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setAdvanced(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [advanced]);

  const empty = !q.text?.trim() && !q.from?.trim() && !q.to?.trim() && !q.subject?.trim() && !q.hasAttachment;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAdvanced(false);
    setSearch(empty ? null : { ...q });
  };
  const input = 'w-full rounded-[7px] bg-bg-tertiary px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/60';

  return (
    <form ref={box} onSubmit={submit} className={cn('relative', className)} role="search">
      <div className="flex h-9 items-center rounded-[7px] bg-bg-tertiary transition-colors focus-within:bg-bg-primary focus-within:ring-1 focus-within:ring-accent coarse:h-10">
        <Search size={14} className="ml-3 shrink-0 text-text-muted" />
        <input
          id={SEARCH_INPUT_ID}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.currentTarget.blur(); if (search) { setQ({}); setSearch(null); } } }}
          value={q.text ?? ''} onChange={(e) => setQ({ ...q, text: e.target.value })}
          placeholder={t('wm.search.placeholder') || 'Search mail'}
          className="peer min-w-0 flex-1 bg-transparent px-2 py-1.5 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none"
          aria-label={t('wm.search.placeholder') || 'Search mail'}
        />
        {!search && !q.text && <span className="mr-1 hidden shrink-0 lg:inline-flex" aria-hidden><Kbd>/</Kbd></span>}
        {search && (
          <button type="button" onClick={() => { setQ({}); setSearch(null); }} className="p-2 text-text-muted hover:text-text-primary" aria-label={t('wm.search.clear') || 'Clear the search'}>
            <X size={15} />
          </button>
        )}
        <button type="button" onClick={() => setAdvanced((v) => !v)} className={cn('p-2 hover:text-text-primary', advanced ? 'text-accent' : 'text-text-muted')}
          aria-label={t('wm.search.advanced') || 'Advanced search'} aria-expanded={advanced}>
          <SlidersHorizontal size={15} />
        </button>
      </div>
      {advanced && (
        <div className="wm-pop wm-scale-in absolute left-0 right-0 top-full z-30 mt-1.5 space-y-2 rounded-[10px] bg-bg-secondary p-3 max-sm:fixed max-sm:inset-x-3 max-sm:top-14">
          <input value={q.from ?? ''} onChange={(e) => setQ({ ...q, from: e.target.value })} placeholder={t('wm.search.from') || 'From'} className={input} />
          <input value={q.to ?? ''} onChange={(e) => setQ({ ...q, to: e.target.value })} placeholder={t('wm.search.to') || 'To'} className={input} />
          <input value={q.subject ?? ''} onChange={(e) => setQ({ ...q, subject: e.target.value })} placeholder={t('wm.search.subject') || 'Subject'} className={input} />
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input type="checkbox" checked={!!q.hasAttachment} onChange={(e) => setQ({ ...q, hasAttachment: e.target.checked })} className="h-4 w-4 accent-[rgb(var(--c-accent))]" />
            {t('wm.search.hasAttachment') || 'Has an attachment'}
          </label>
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input type="checkbox" checked={!!q.everywhere} onChange={(e) => setQ({ ...q, everywhere: e.target.checked })} className="h-4 w-4 accent-[rgb(var(--c-accent))]" />
            {t('wm.search.everywhere') || 'Search every folder'}
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <PillButton size="sm" variant="ghost" onClick={() => { setQ({}); setSearch(null); setAdvanced(false); }}>{t('wm.search.clear') || 'Clear the search'}</PillButton>
            <PillButton type="submit" size="sm" variant="primary">{t('wm.search.submit') || 'Search'}</PillButton>
          </div>
        </div>
      )}
    </form>
  );
}
