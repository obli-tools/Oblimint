import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Key } from 'lucide-react';
import type { DbxCell, DbxColumn } from '@oblimint/shared';
import { cn } from '@/utils/cn';

// Result grid of the database explorer: sticky header (sortable when onSort
// is given), cells by kind (NULL, binary, long text), optional row selection
// and in-place editing (double-click a cell: Enter saves, Esc cancels,
// Ctrl+Enter in a multi-line value; the NULL button sets SQL NULL).

export function isLong(c: DbxCell): c is { long: true; text: string; size: number } {
  return typeof c === 'object' && c !== null && 'long' in c;
}
export function isBinary(c: DbxCell): c is { binary: true; hex: string; size: number; truncated: boolean } {
  return typeof c === 'object' && c !== null && 'binary' in c;
}

/** Text of a cell (CSV export, editing, copy). */
export function cellText(c: DbxCell): string {
  if (c === null) return '';
  if (isLong(c)) return c.text;
  if (isBinary(c)) return `0x${c.hex}${c.truncated ? '…' : ''}`;
  return String(c);
}

export function CellView({ value }: { value: DbxCell }) {
  if (value === null) return <span className="italic text-text-muted">NULL</span>;
  if (isBinary(value)) return <span className="font-mono text-fuchsia-400" title={`${value.size} B`}>0x{value.hex}{value.truncated && '…'}</span>;
  if (isLong(value)) return <span title={`${value.size} chars`}>{value.text.slice(0, 200)}<span className="text-accent">…</span></span>;
  if (typeof value === 'boolean') return <span className="font-mono text-sky-400">{value ? 'true' : 'false'}</span>;
  const s = String(value);
  return <span>{s.length > 200 ? `${s.slice(0, 200)}…` : s}</span>;
}

export interface GridEdit {
  row: number;
  column: string;
}

export function DataGrid({
  columns, rows, columnInfo, sort, onSort, selected, onToggleRow, onToggleAll, onEdit, rowOffset = 0, emptyText,
}: {
  columns: string[];
  rows: DbxCell[][];
  /** Structure of the columns (types, PK marks, editability). */
  columnInfo?: DbxColumn[];
  sort?: { column: string; dir: 'asc' | 'desc' } | null;
  onSort?: (column: string) => void;
  selected?: Set<number>;
  onToggleRow?: (i: number, shift: boolean) => void;
  onToggleAll?: () => void;
  /** Editing allowed: called with the new text (null = SQL NULL); resolves when saved. */
  onEdit?: (row: number, column: string, value: string | null) => Promise<boolean>;
  rowOffset?: number;
  emptyText?: ReactNode;
}) {
  const [editing, setEditing] = useState<GridEdit | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const info = new Map((columnInfo ?? []).map((c) => [c.name, c]));

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const startEdit = (row: number, column: string) => {
    if (!onEdit) return;
    const c = info.get(column);
    const v = rows[row][columns.indexOf(column)];
    if (c?.binary || isBinary(v) || isLong(v)) return;
    setDraft(v === null ? '' : String(v));
    setEditing({ row, column });
  };
  const commit = async (value: string | null) => {
    if (!editing || !onEdit) return;
    setSaving(true);
    const ok = await onEdit(editing.row, editing.column, value);
    setSaving(false);
    if (ok) setEditing(null);
  };

  const th = 'sticky top-0 z-10 whitespace-nowrap bg-bg-secondary px-3 py-2 text-left text-[11px] font-mono font-medium text-text-muted';
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-max min-w-full border-separate border-spacing-0 text-[13px]">
        <thead>
          <tr>
            {onToggleRow && (
              <th className={cn(th, 'w-8')}>
                <input type="checkbox" checked={!!rows.length && selected?.size === rows.length} onChange={onToggleAll} className="accent-[rgb(var(--c-accent))]" />
              </th>
            )}
            <th className={cn(th, 'w-12 text-right')}>#</th>
            {columns.map((c) => {
              const ci = info.get(c);
              return (
                <th key={c} className={cn(th, onSort && 'cursor-pointer select-none hover:text-text-primary')} onClick={() => onSort?.(c)} title={ci ? `${ci.type}${ci.nullable ? '' : ' NOT NULL'}${ci.comment ? ` — ${ci.comment}` : ''}` : undefined}>
                  <span className="inline-flex items-center gap-1">
                    {ci?.primary && <Key className="h-3 w-3 text-amber-400" />}
                    <span className="normal-case text-text-secondary">{c}</span>
                    {ci && <span className="font-normal normal-case text-text-muted/70">{ci.type.length > 18 ? `${ci.type.slice(0, 18)}…` : ci.type}</span>}
                    {sort?.column === c && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3 text-accent" /> : <ArrowDown className="h-3 w-3 text-accent" />)}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={cn('group', selected?.has(i) ? 'bg-accent/[0.12]' : 'hover:bg-bg-hover/50')}>
              {onToggleRow && (
                <td className="border-t border-white/[0.03] px-3 py-1">
                  <input type="checkbox" checked={selected?.has(i) ?? false} onChange={(e) => onToggleRow(i, (e.nativeEvent as MouseEvent).shiftKey)} className="accent-[rgb(var(--c-accent))]" />
                </td>
              )}
              <td className="border-t border-white/[0.03] px-3 py-1 text-right font-mono text-[11px] text-text-muted">{rowOffset + i + 1}</td>
              {columns.map((c, j) => {
                const isEditing = editing?.row === i && editing.column === c;
                return (
                  <td
                    key={c}
                    onDoubleClick={() => startEdit(i, c)}
                    className={cn('max-w-[420px] border-t border-white/[0.03] px-3 py-1 align-top', isEditing ? 'p-0' : 'truncate', onEdit && 'cursor-cell')}
                  >
                    {isEditing ? (
                      <div className="flex min-w-[260px] flex-col gap-1 bg-bg-primary p-1.5 ring-1 ring-accent">
                        <textarea
                          ref={inputRef}
                          value={draft}
                          rows={Math.min(8, Math.max(1, draft.split('\n').length))}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !draft.includes('\n'))) { if (!e.shiftKey) { e.preventDefault(); void commit(draft); } }
                          }}
                          disabled={saving}
                          className="w-full resize-y bg-transparent font-mono text-[12px] text-text-primary outline-none"
                        />
                        <div className="flex gap-1 text-[11px]">
                          <button type="button" onClick={() => void commit(draft)} disabled={saving} className="rounded bg-accent px-2 py-0.5 font-medium text-white">OK</button>
                          {info.get(c)?.nullable !== false && (
                            <button type="button" onClick={() => void commit(null)} disabled={saving} className="rounded bg-bg-tertiary px-2 py-0.5 text-text-secondary hover:text-text-primary">NULL</button>
                          )}
                          <button type="button" onClick={() => setEditing(null)} className="rounded px-2 py-0.5 text-text-muted hover:text-text-primary">Esc</button>
                        </div>
                      </div>
                    ) : <CellView value={r[j]} />}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && emptyText && <div className="p-8 text-center text-sm text-text-muted">{emptyText}</div>}
    </div>
  );
}

/** CSV of a result (RFC 4180, ; separated for spreadsheet locales → comma kept: universal). */
export function toCsv(columns: string[], rows: DbxCell[][]): string {
  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [columns.map(esc).join(','), ...rows.map((r) => r.map((c) => esc(cellText(c))).join(','))].join('\r\n');
}

export function downloadText(name: string, text: string, type = 'text/csv'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
