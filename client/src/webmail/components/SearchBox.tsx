import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/common/Button';
import { cn } from '@/utils/cn';
import type { SearchQuery } from '../jmap';
import { useWebmail } from '../store';

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
  const input = 'w-full rounded-md bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent';

  return (
    <form ref={box} onSubmit={submit} className={cn('relative', className)} role="search">
      <div className="flex items-center rounded-md bg-bg-tertiary focus-within:ring-2 focus-within:ring-accent">
        <Search size={15} className="ml-3 shrink-0 text-text-muted" />
        <input
          value={q.text ?? ''} onChange={(e) => setQ({ ...q, text: e.target.value })}
          placeholder={t('wm.search.placeholder') || 'Search mail'}
          className="min-w-0 flex-1 bg-transparent px-2 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
          aria-label={t('wm.search.placeholder') || 'Search mail'}
        />
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
        <div className="absolute left-0 right-0 top-full z-30 mt-1 space-y-2 rounded-lg border border-border bg-bg-secondary p-3 shadow-xl">
          <input value={q.from ?? ''} onChange={(e) => setQ({ ...q, from: e.target.value })} placeholder={t('wm.search.from') || 'From'} className={input} />
          <input value={q.to ?? ''} onChange={(e) => setQ({ ...q, to: e.target.value })} placeholder={t('wm.search.to') || 'To'} className={input} />
          <input value={q.subject ?? ''} onChange={(e) => setQ({ ...q, subject: e.target.value })} placeholder={t('wm.search.subject') || 'Subject'} className={input} />
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input type="checkbox" checked={!!q.hasAttachment} onChange={(e) => setQ({ ...q, hasAttachment: e.target.checked })} className="h-4 w-4" />
            {t('wm.search.hasAttachment') || 'Has an attachment'}
          </label>
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input type="checkbox" checked={!!q.everywhere} onChange={(e) => setQ({ ...q, everywhere: e.target.checked })} className="h-4 w-4" />
            {t('wm.search.everywhere') || 'Search every folder'}
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" size="sm" onClick={() => { setQ({}); setSearch(null); setAdvanced(false); }}>{t('wm.search.clear') || 'Clear the search'}</Button>
            <Button type="submit" size="sm">{t('wm.search.submit') || 'Search'}</Button>
          </div>
        </div>
      )}
    </form>
  );
}
