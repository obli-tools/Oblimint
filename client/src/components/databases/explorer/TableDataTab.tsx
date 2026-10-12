import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import axios from 'axios';
import { ChevronLeft, ChevronRight, Download, Filter, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import type { DbxCell, DbxFilter, DbxFilterOp, DbxRowKey, DbxRows, DbxTableInfo } from '@oblimint/shared';
import { dbExplorerApi } from '@/api/dbExplorer.api';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { DataGrid, downloadText, isBinary, isLong, toCsv } from './DataGrid';

const OPS: DbxFilterOp[] = ['=', '!=', '<', '<=', '>', '>=', 'like', 'not like', 'null', 'not null'];
const PAGE_SIZES = [25, 50, 100, 250, 500];

export function explorerError(err: unknown): string {
  if (axios.isAxiosError(err)) return (err.response?.data as { error?: string } | undefined)?.error || err.message;
  return err instanceof Error ? err.message : String(err);
}

function readLimit(): number {
  try { const n = Number(localStorage.getItem('oblimint.dbx.limit')); return PAGE_SIZES.includes(n) ? n : 100; } catch { return 100; }
}

/** Data of a table: filters, sort, pages, in-place editing, insert, delete (tables with a primary key). */
export function TableDataTab({ instanceId, dbId, info, onChanged }: {
  instanceId: number;
  dbId: number;
  info: DbxTableInfo;
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(readLimit);
  const [sort, setSort] = useState<{ column: string; dir: 'asc' | 'desc' } | null>(null);
  const [filters, setFilters] = useState<DbxFilter[]>([]);
  const [draft, setDraft] = useState<DbxFilter>({ column: info.columns[0]?.name ?? '', op: '=', value: '' });
  const [showFilter, setShowFilter] = useState(false);
  const [data, setData] = useState<DbxRows | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [inserting, setInserting] = useState(false);
  const name = info.table.id;
  const editable = info.table.kind === 'table' && info.primaryKey.length > 0;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await dbExplorerApi.rows(instanceId, dbId, name, { offset, limit, ...(sort ? { sort: sort.column, dir: sort.dir } : {}), filters }));
      setError(null);
    } catch (err) {
      setError(explorerError(err));
    } finally {
      setLoading(false);
      setSelected(new Set());
    }
  }, [instanceId, dbId, name, offset, limit, sort, filters]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setOffset(0); setSort(null); setFilters([]); setDraft({ column: info.columns[0]?.name ?? '', op: '=', value: '' }); }, [name]); // eslint-disable-line react-hooks/exhaustive-deps

  const keyOf = (row: DbxCell[]): DbxRowKey | null => {
    if (!data) return null;
    const key: DbxRowKey = {};
    for (const c of info.primaryKey) {
      const v = row[data.columns.indexOf(c)];
      if (v === undefined || isBinary(v) || isLong(v) || typeof v === 'boolean') return null;
      key[c] = v;
    }
    return key;
  };

  const onEdit = async (row: number, column: string, value: string | null): Promise<boolean> => {
    if (!data) return false;
    const key = keyOf(data.rows[row]);
    if (!key) { toast.error(t('dbx.errors.noKey') || 'This row cannot be identified (primary key)'); return false; }
    try {
      const n = await dbExplorerApi.update(instanceId, dbId, name, key, { [column]: value });
      if (n === 0) toast(t('dbx.data.unchanged') || 'No row changed (the value may be identical, or the row was modified elsewhere).', { icon: 'ℹ️' });
      const next = data.rows.map((r) => [...r]);
      next[row][data.columns.indexOf(column)] = value;
      setData({ ...data, rows: next });
      // Values computed by the engine (types, triggers): reload quietly.
      void dbExplorerApi.rows(instanceId, dbId, name, { offset, limit, ...(sort ? { sort: sort.column, dir: sort.dir } : {}), filters }).then(setData).catch(() => undefined);
      return true;
    } catch (err) {
      toast.error(explorerError(err));
      return false;
    }
  };

  const removeSelected = async () => {
    if (!data || !selected.size) return;
    const keys = [...selected].map((i) => keyOf(data.rows[i])).filter((k): k is DbxRowKey => k !== null);
    if (!(await confirm({
      title: t('dbx.data.deleteTitle') || 'Delete rows',
      message: t('dbx.data.deleteConfirm', { count: keys.length, table: info.table.name, defaultValue: 'Delete {{count}} row(s) from {{table}}? This cannot be undone.' }),
      danger: true,
    }))) return;
    try {
      const n = await dbExplorerApi.remove(instanceId, dbId, name, keys);
      toast.success(t('dbx.data.deleted', { count: n, defaultValue: '{{count}} row(s) deleted' }));
      onChanged?.();
      await load();
    } catch (err) { toast.error(explorerError(err)); }
  };

  const toggleRow = (i: number, shift: boolean) => {
    const s = new Set(selected);
    if (shift && anchor !== null) {
      const [lo, hi] = anchor < i ? [anchor, i] : [i, anchor];
      for (let k = lo; k <= hi; k++) s.add(k);
    } else if (s.has(i)) s.delete(i); else s.add(i);
    setSelected(s);
    setAnchor(i);
  };

  const total = data?.total ?? null;
  const lastPage = total !== null && offset + limit >= total;
  const addFilter = () => {
    if (!draft.column) return;
    setFilters([...filters, draft.op === 'null' || draft.op === 'not null' ? { column: draft.column, op: draft.op } : draft]);
    setOffset(0);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-white/[0.04] px-3 py-2">
        <IconButton size="sm" label={t('dbx.refresh') || 'Refresh'} icon={<RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />} onClick={() => void load()} />
        <IconButton size="sm" label={t('dbx.data.filter') || 'Filter'} icon={<Filter className="h-4 w-4" />} active={showFilter || filters.length > 0} onClick={() => setShowFilter((v) => !v)} />
        {editable && <IconButton size="sm" label={t('dbx.data.insert') || 'Insert a row'} icon={<Plus className="h-4 w-4" />} onClick={() => setInserting(true)} />}
        {editable && <IconButton size="sm" variant="danger" label={t('dbx.data.deleteSelected') || 'Delete the selected rows'} icon={<Trash2 className="h-4 w-4" />} onClick={() => void removeSelected()} disabled={!selected.size} />}
        <IconButton size="sm" label={t('dbx.exportCsv') || 'Export the page as CSV'} icon={<Download className="h-4 w-4" />} disabled={!data?.rows.length}
          onClick={() => data && downloadText(`${info.table.name}-${offset + 1}.csv`, toCsv(data.columns, data.rows))} />
        {filters.map((f, i) => (
          <span key={i} className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 font-mono text-[11px] text-accent">
            {f.column} {f.op}{f.value !== undefined ? ` '${f.value}'` : ''}
            <button type="button" onClick={() => { setFilters(filters.filter((_, k) => k !== i)); setOffset(0); }}><X className="h-3 w-3" /></button>
          </span>
        ))}
        {!editable && (
          <span className="text-[11px] text-text-muted">
            {info.table.kind === 'view' ? (t('dbx.data.viewReadOnly') || 'View: read-only') : (t('dbx.data.noPk') || 'No primary key: read-only here (use SQL)')}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5 font-mono text-[11px] text-text-muted">
          <select value={limit} onChange={(e) => { const n = Number(e.target.value); setLimit(n); setOffset(0); try { localStorage.setItem('oblimint.dbx.limit', String(n)); } catch { /* */ } }}
            className="rounded bg-bg-tertiary px-1.5 py-0.5 text-text-primary outline-none">
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <span>
            {data?.rows.length ? `${offset + 1}–${offset + data.rows.length}` : '0'}
            {total !== null && ` / ${data?.approximate ? '≈ ' : ''}${total.toLocaleString()}`}
          </span>
          <IconButton size="xs" label={t('dbx.prev') || 'Previous page'} icon={<ChevronLeft className="h-4 w-4" />} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))} />
          <IconButton size="xs" label={t('dbx.next') || 'Next page'} icon={<ChevronRight className="h-4 w-4" />} disabled={lastPage || (data?.rows.length ?? 0) < limit} onClick={() => setOffset(offset + limit)} />
        </div>
      </div>
      {showFilter && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-white/[0.04] bg-bg-primary/30 px-3 py-2 text-[12px]">
          <select value={draft.column} onChange={(e) => setDraft({ ...draft, column: e.target.value })} className="rounded bg-bg-tertiary px-2 py-1 font-mono text-text-primary outline-none">
            {info.columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
          <select value={draft.op} onChange={(e) => setDraft({ ...draft, op: e.target.value as DbxFilterOp })} className="rounded bg-bg-tertiary px-2 py-1 font-mono text-text-primary outline-none">
            {OPS.map((o) => <option key={o} value={o}>{o.toUpperCase()}</option>)}
          </select>
          {draft.op !== 'null' && draft.op !== 'not null' && (
            <input value={draft.value ?? ''} onChange={(e) => setDraft({ ...draft, value: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') addFilter(); }}
              placeholder={draft.op.includes('like') ? '%texte%' : (t('dbx.data.value') || 'value')} className="w-48 rounded bg-bg-tertiary px-2 py-1 font-mono text-text-primary outline-none" />
          )}
          <Button size="sm" variant="secondary" onClick={addFilter}>{t('dbx.data.addFilter') || 'Add'}</Button>
        </div>
      )}
      {error ? <p className="p-4 text-sm text-status-down">{error}</p>
        : !data ? <div className="flex justify-center p-8"><LoadingSpinner /></div>
          : (
            <DataGrid
              columns={data.columns}
              rows={data.rows}
              columnInfo={info.columns}
              rowOffset={offset}
              sort={sort}
              onSort={(c) => { setSort(sort?.column === c ? (sort.dir === 'asc' ? { column: c, dir: 'desc' } : null) : { column: c, dir: 'asc' }); setOffset(0); }}
              selected={editable ? selected : undefined}
              onToggleRow={editable ? toggleRow : undefined}
              onToggleAll={() => setSelected(selected.size === data.rows.length ? new Set() : new Set(data.rows.map((_, i) => i)))}
              onEdit={editable ? onEdit : undefined}
              emptyText={filters.length ? (t('dbx.data.noMatch') || 'No row matches the filters.') : (t('dbx.data.empty') || 'This table is empty.')}
            />
          )}
      {inserting && (
        <InsertModal info={info} onClose={() => setInserting(false)} onSave={async (values) => {
          try {
            await dbExplorerApi.insert(instanceId, dbId, name, values);
            toast.success(t('dbx.data.inserted') || 'Row inserted');
            setInserting(false);
            onChanged?.();
            await load();
          } catch (err) { toast.error(explorerError(err)); }
        }} />
      )}
    </div>
  );
}

function InsertModal({ info, onClose, onSave }: { info: DbxTableInfo; onClose: () => void; onSave: (values: Record<string, string | null>) => Promise<void> }) {
  const { t } = useTranslation();
  const cols = info.columns.filter((c) => !c.binary);
  // 'default' = column omitted (engine default / auto increment), 'null', or a value.
  const [mode, setMode] = useState<Record<string, 'default' | 'null' | 'value'>>(() =>
    Object.fromEntries(cols.map((c) => [c.name, c.autoIncrement || c.default !== null ? 'default' : c.nullable ? 'null' : 'value'])));
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const values: Record<string, string | null> = {};
    for (const c of cols) {
      if (mode[c.name] === 'null') values[c.name] = null;
      else if (mode[c.name] === 'value') values[c.name] = vals[c.name] ?? '';
    }
    setBusy(true);
    await onSave(values);
    setBusy(false);
  };
  return (
    <Modal open onClose={onClose} size="lg" title={t('dbx.data.insertTitle', { table: info.table.name, defaultValue: 'New row in {{table}}' })}
      footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button><Button loading={busy} onClick={() => void submit()}>{t('dbx.data.insert') || 'Insert'}</Button></div>}>
      <div className="max-h-[60vh] space-y-2 overflow-y-auto">
        {cols.map((c) => (
          <div key={c.name} className="grid grid-cols-[minmax(120px,1fr)_auto_2fr] items-center gap-2">
            <div className="min-w-0">
              <div className="truncate font-mono text-[13px] text-text-primary">{c.name}</div>
              <div className="truncate font-mono text-[10px] text-text-muted">{c.type}{c.autoIncrement ? ' · auto' : ''}{c.default !== null ? ` · ${c.default}` : ''}</div>
            </div>
            <select value={mode[c.name]} onChange={(e) => setMode({ ...mode, [c.name]: e.target.value as 'default' | 'null' | 'value' })}
              className="rounded bg-bg-tertiary px-2 py-1 text-[12px] text-text-primary outline-none">
              <option value="value">{t('dbx.data.modeValue') || 'Value'}</option>
              <option value="default">{t('dbx.data.modeDefault') || 'Default'}</option>
              {c.nullable && <option value="null">NULL</option>}
            </select>
            <input value={vals[c.name] ?? ''} disabled={mode[c.name] !== 'value'} onChange={(e) => setVals({ ...vals, [c.name]: e.target.value })}
              className="rounded bg-bg-tertiary px-2 py-1 font-mono text-[12px] text-text-primary outline-none disabled:opacity-40" />
          </div>
        ))}
      </div>
    </Modal>
  );
}
