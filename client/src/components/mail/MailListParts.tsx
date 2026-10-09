import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { IconButton } from '@/components/common/IconButton';
import { cn } from '@/utils/cn';

/** Search field of the mail lists (same look as the other list pages). */
export function MailSearch({ value, onChange, placeholder, className = 'w-full sm:w-64' }: { value: string; onChange: (v: string) => void; placeholder: string; className?: string }) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-text-muted" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoCapitalize="off" autoCorrect="off" spellCheck={false}
        className="w-full rounded-md border border-bg-tertiary bg-bg-secondary py-1.5 pl-8 pr-3 text-sm text-text-primary focus:border-accent focus:outline-none coarse:min-h-10"
      />
    </div>
  );
}

/** "‹ 2 / 7 ›" pager (offset based). */
export function Pager({ offset, total, pageSize, onOffset, extra }: { offset: number; total: number; pageSize: number; onOffset: (o: number) => void; extra?: ReactNode }) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.floor(offset / pageSize) + 1;
  if (pages <= 1 && !extra) return null;
  return (
    <div className="flex items-center justify-end gap-2 text-xs text-text-muted">
      {extra}
      {pages > 1 && (
        <>
          <IconButton label={t('common.previous') || 'Previous'} icon={<ChevronLeft className="h-4 w-4" />} disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - pageSize))} />
          <span className="font-mono">{page} / {pages}</span>
          <IconButton label={t('common.next') || 'Next'} icon={<ChevronRight className="h-4 w-4" />} disabled={page >= pages} onClick={() => onOffset(offset + pageSize)} />
        </>
      )}
    </div>
  );
}

