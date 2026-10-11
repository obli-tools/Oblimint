import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, CornerDownRight } from 'lucide-react';
import { TableScroll } from '@/components/common/TableScroll';
import { cn } from '@/utils/cn';

// ─────────────────────────────────────────────────────────────────────────────
// Lists grouped by hosting account (one collapsible root per account), rows
// nested inside a group (a sub-domain under its parent domain), sortable
// columns (Obliance SortHead pattern: click = sort, again = reverse; siblings
// are sorted, the hierarchy is kept). Desktop: a table; phone: the group
// headers with the caller's cards. The collapsed groups are remembered per
// list (localStorage, `storageKey`).
// ─────────────────────────────────────────────────────────────────────────────

export type SortValue = string | number | boolean | null | undefined;

export interface GroupedColumn<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Sort key (absent = not sortable). */
  sort?: (row: T) => SortValue;
  thClassName?: string;
  tdClassName?: string;
}

export interface TreeNode<T> {
  key: string | number;
  row: T;
  children: TreeNode<T>[];
}

export interface RowGroup<T> {
  key: string;
  /** Account name (or any group title). */
  label: ReactNode;
  /** Text matched by the group-level sort (account name). */
  sortLabel: string;
  /** Extra header content (workspace badge, link…). */
  meta?: ReactNode;
  nodes: TreeNode<T>[];
}

const thBase = 'px-4 py-3 text-left text-[11px] font-mono font-medium uppercase tracking-[0.12em] text-text-muted';
const tdBase = 'px-4 py-2.5 align-middle';

/** Comparison of two sort keys: empty values last, numbers numerically, text naturally (a2 < a10). */
export function compareSortValues(a: SortValue, b: SortValue): number {
  if (a === b) return 0;
  if (a === null || a === undefined || a === '') return 1;
  if (b === null || b === undefined || b === '') return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a ? -1 : 1;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function sortNodes<T>(nodes: TreeNode<T>[], key: ((row: T) => SortValue) | null, dir: 1 | -1): TreeNode<T>[] {
  const list = key ? [...nodes].sort((x, y) => dir * compareSortValues(key(x.row), key(y.row))) : nodes;
  return list.map((n) => (n.children.length ? { ...n, children: sortNodes(n.children, key, dir) } : n));
}

function countNodes<T>(nodes: TreeNode<T>[]): number {
  return nodes.reduce((n, x) => n + 1 + countNodes(x.children), 0);
}

function readCollapsed(storageKey?: string): Set<string> {
  if (!storageKey) return new Set();
  try {
    const raw = window.localStorage.getItem(`oblimint.groups.${storageKey}`);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(storageKey: string | undefined, set: Set<string>): void {
  if (!storageKey) return;
  try { window.localStorage.setItem(`oblimint.groups.${storageKey}`, JSON.stringify([...set])); } catch { /* private mode */ }
}

export function GroupedTable<T>({
  groups, columns, onRowClick, selectedKey, minWidth = 900, storageKey, renderCard, defaultSort, singleGroupFlat = false,
  rowClassName, className = 'bg-bg-secondary',
}: {
  groups: RowGroup<T>[];
  columns: GroupedColumn<T>[];
  onRowClick?: (row: T) => void;
  selectedKey?: string | number | null;
  /** Table min width in px (horizontal scroll below). */
  minWidth?: number;
  /** Remembers the collapsed groups of this list. */
  storageKey?: string;
  /** Phone: one card per row (absent = the table scrolls). */
  renderCard?: (row: T, depth: number) => ReactNode;
  defaultSort?: { column: string; dir?: 'asc' | 'desc' };
  /** One group only (a client user, an account filter): no group header. */
  singleGroupFlat?: boolean;
  /** Extra classes of a row (a disabled record dimmed…). */
  rowClassName?: (row: T) => string | false | null | undefined;
  /** Card look of the table (default bg-bg-secondary; bg-bg-primary inside a card). */
  className?: string;
}) {
  const { t } = useTranslation();
  const [sortCol, setSortCol] = useState<string | null>(defaultSort?.column ?? null);
  const [sortDir, setSortDir] = useState<1 | -1>(defaultSort?.dir === 'desc' ? -1 : 1);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed(storageKey));

  const toggleSort = (id: string) => {
    if (sortCol === id) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortCol(id); setSortDir(1); }
  };
  const setGroupCollapsed = (next: Set<string>) => { setCollapsed(next); writeCollapsed(storageKey, next); };
  const toggleGroup = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key); else next.add(key);
    setGroupCollapsed(next);
  };

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.id === sortCol && c.sort);
    const key = col?.sort ?? null;
    const gs = groups.map((g) => ({ ...g, nodes: sortNodes(g.nodes, key, sortDir) }));
    // Groups: by name, reversed with the first column (the « name » column of every list).
    const groupDir: 1 | -1 = sortCol === columns[0]?.id ? sortDir : 1;
    return gs.sort((a, b) => groupDir * a.sortLabel.localeCompare(b.sortLabel, undefined, { numeric: true, sensitivity: 'base' }));
  }, [groups, columns, sortCol, sortDir]);

  const flat = singleGroupFlat && sorted.length === 1;
  const allCollapsed = sorted.length > 0 && sorted.every((g) => collapsed.has(g.key));

  const rowsOf = (nodes: TreeNode<T>[], depth: number, out: Array<{ node: TreeNode<T>; depth: number; last: boolean }>) => {
    nodes.forEach((n, i) => {
      out.push({ node: n, depth, last: i === nodes.length - 1 });
      rowsOf(n.children, depth + 1, out);
    });
    return out;
  };

  const groupHeader = (g: RowGroup<T>, open: boolean, count: number) => (
    <button
      type="button"
      onClick={() => toggleGroup(g.key)}
      aria-expanded={open}
      className="flex w-full items-center gap-2 text-left"
    >
      {open ? <ChevronDown size={14} className="shrink-0 text-text-muted" /> : <ChevronRight size={14} className="shrink-0 text-text-muted" />}
      <span className="font-mono text-sm font-semibold text-text-primary">{g.label}</span>
      <span className="rounded-full bg-accent/15 px-1.5 font-mono text-[10px] text-accent">{count}</span>
      {g.meta && <span className="flex min-w-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>{g.meta}</span>}
    </button>
  );

  // Under a group header the rows are indented one step; a nested row (sub-domain) one more per level, with an arrow.
  const firstCell = (depth: number, inGroup: boolean, content: ReactNode) => {
    const rem = (inGroup ? 0.75 : 0) + Math.max(0, depth - 1) * 1.25;
    return (
      <div className="flex items-center gap-1.5" style={rem ? { paddingLeft: `${rem}rem` } : undefined}>
        {depth > 0 && <CornerDownRight size={13} className="shrink-0 text-text-muted/60" aria-hidden />}
        <div className="min-w-0">{content}</div>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-2">
      {sorted.length > 1 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setGroupCollapsed(allCollapsed ? new Set() : new Set(sorted.map((g) => g.key)))}
            className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary"
          >
            {allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
            {allCollapsed ? (t('common.expandAll') || 'Expand all') : (t('common.collapseAll') || 'Collapse all')}
          </button>
        </div>
      )}

      {/* Phone: group headers + the caller's cards */}
      {renderCard && (
        <div className="space-y-3 md:hidden">
          {sorted.map((g) => {
            const open = flat || !collapsed.has(g.key);
            const rows = rowsOf(g.nodes, 0, []);
            return (
              <section key={g.key}>
                {!flat && <div className="mb-1.5 px-1">{groupHeader(g, open, rows.length)}</div>}
                {open && (
                  <ul className="space-y-2">
                    {rows.map(({ node, depth }) => (
                      <li key={node.key} style={depth ? { marginLeft: `${Math.min(depth, 3) * 0.75}rem` } : undefined}>{renderCard(node.row, depth)}</li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}

      <TableScroll className={cn('rounded-xl', className, renderCard && 'hidden md:block')} stickyFirstCol>
        <table className="w-full text-sm" style={{ minWidth }}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.id}
                  className={cn(thBase, c.sort && 'cursor-pointer select-none hover:text-text-primary', c.thClassName)}
                  onClick={c.sort ? () => toggleSort(c.id) : undefined}
                  aria-sort={sortCol === c.id ? (sortDir === 1 ? 'ascending' : 'descending') : undefined}
                >
                  <span className="inline-flex items-center gap-1">
                    {c.header}
                    {sortCol === c.id && (sortDir === 1 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((g) => {
              const open = flat || !collapsed.has(g.key);
              const rows = rowsOf(g.nodes, 0, []);
              return (
                <Fragment key={g.key}>
                  {!flat && (
                    <tr className="border-t border-white/[0.04] bg-bg-tertiary/40">
                      <td colSpan={columns.length} className="px-4 py-2">{groupHeader(g, open, countNodes(g.nodes))}</td>
                    </tr>
                  )}
                  {open && rows.map(({ node, depth }) => (
                    <tr
                      key={node.key}
                      onClick={onRowClick ? (e) => {
                        if ((e.target as HTMLElement).closest('a,button,input,label')) return;
                        onRowClick(node.row);
                      } : undefined}
                      className={cn(onRowClick && 'cursor-pointer', 'transition-colors hover:bg-bg-hover', node.key === selectedKey && 'bg-bg-hover', rowClassName?.(node.row))}
                    >
                      {columns.map((c, i) => (
                        <td key={c.id} className={cn(tdBase, c.tdClassName)}>
                          {i === 0 ? firstCell(depth, !flat, c.cell(node.row)) : c.cell(node.row)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Flat rows → one node each (no hierarchy). */
export function flatNodes<T>(rows: T[], keyOf: (row: T) => string | number): TreeNode<T>[] {
  return rows.map((row) => ({ key: keyOf(row), row, children: [] }));
}

/**
 * Host names → tree: each name goes under the longest OTHER name of the list it is a sub-domain of
 * (example.com → shop.example.com, www.shop.example.com…). Order kept (the table sorts siblings).
 */
export function domainTree<T>(rows: T[], nameOf: (row: T) => string, keyOf: (row: T) => string | number): TreeNode<T>[] {
  const names = rows.map((r) => nameOf(r).toLowerCase().replace(/\.$/, ''));
  const nodes = rows.map((row) => ({ key: keyOf(row), row, children: [] as TreeNode<T>[] }));
  const roots: TreeNode<T>[] = [];
  names.forEach((name, i) => {
    let parent = -1;
    names.forEach((other, j) => {
      if (j !== i && name.endsWith(`.${other}`) && (parent < 0 || other.length > names[parent].length)) parent = j;
    });
    if (parent >= 0) nodes[parent].children.push(nodes[i]); else roots.push(nodes[i]);
  });
  return roots;
}

/**
 * Rows → one group per account (account name first, then by id). `accountOf` gives the id + name;
 * `nodesOf` builds the rows of a group (flatNodes / domainTree).
 */
export function groupByAccount<T>(
  rows: T[],
  accountOf: (row: T) => { id: number | string; name: string; meta?: ReactNode } | null,
  nodesOf: (rows: T[]) => TreeNode<T>[],
  noAccountLabel = '—',
): RowGroup<T>[] {
  const map = new Map<string, { name: string; meta?: ReactNode; rows: T[] }>();
  for (const r of rows) {
    const a = accountOf(r);
    const key = a ? `a:${a.id}` : 'none';
    const cur = map.get(key) ?? { name: a?.name ?? noAccountLabel, meta: a?.meta, rows: [] };
    cur.rows.push(r);
    map.set(key, cur);
  }
  return [...map.entries()].map(([key, g]) => ({ key, label: g.name, sortLabel: g.name, meta: g.meta, nodes: nodesOf(g.rows) }));
}
