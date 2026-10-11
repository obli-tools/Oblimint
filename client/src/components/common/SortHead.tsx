import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { cn } from '@/utils/cn';
import { compareSortValues, type SortValue } from '@/components/common/GroupedTable';

// ─────────────────────────────────────────────────────────────────────────────
// Sortable headers for the tables GroupedTable cannot host (expandable detail
// rows, editable grids): Obliance SortHead pattern — click sorts, a second
// click reverses, an arrow marks the column. Same comparison as GroupedTable.
// ─────────────────────────────────────────────────────────────────────────────

export interface TableSort<K extends string> {
  key: K | null;
  dir: 1 | -1;
  toggle: (k: K) => void;
}

/** Rows sorted by the active column (`keys[col](row)`); no column = the given order. */
export function useTableSort<T, K extends string>(
  rows: T[], keys: Record<K, (row: T) => SortValue>, initial: { key: NoInfer<K> | null; dir?: 'asc' | 'desc' } = { key: null },
): { sorted: T[]; sort: TableSort<K> } {
  const [key, setKey] = useState<K | null>(initial.key);
  const [dir, setDir] = useState<1 | -1>(initial.dir === 'desc' ? -1 : 1);
  const toggle = (k: K) => {
    if (key === k) setDir((d) => (d === 1 ? -1 : 1));
    else { setKey(k); setDir(1); }
  };
  const sorted = useMemo(() => {
    if (!key) return rows;
    const f = keys[key];
    return [...rows].sort((a, b) => dir * compareSortValues(f(a), f(b)));
    // keys is a literal object rebuilt each render: the column functions only read the row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, key, dir]);
  return { sorted, sort: { key, dir, toggle } };
}

/** A <th> that sorts its column. */
export function SortTh<K extends string>({ k, sort, children, className }: { k: K; sort: TableSort<K>; children: ReactNode; className?: string }) {
  const active = sort.key === k;
  return (
    <th
      className={cn('cursor-pointer select-none hover:text-text-primary', className)}
      onClick={() => sort.toggle(k)}
      aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {active && (sort.dir === 1 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </span>
    </th>
  );
}
