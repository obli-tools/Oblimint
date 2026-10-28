import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Download, Eye, FileCode2, Plus, Search, Table2, TerminalSquare, Trash2, Upload, Wrench } from 'lucide-react';
import type { DbFamily, DbxDdlRequest, DbxInfo, DbxMaintenanceOp, DbxObject, DbxObjectKind, DbxQueryResponse, DbxSearchResponse, DbxTable } from '@oblimint/shared';
import { DBX_SEARCH_MAX_TABLES, DBX_SEARCH_ROWS_PER_TABLE } from '@oblimint/shared';
import { dbExplorerApi } from '@/api/dbExplorer.api';
import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Pill } from '@/components/common/Pill';
import { ActionMenu } from '@/components/common/ActionMenu';
import { SortTh, useTableSort } from '@/components/common/SortHead';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { CodeEditor } from '@/components/apps/CodeEditor';
import { formatBytes } from '@/components/usage/usageFormat';
import { cn } from '@/utils/cn';
import { DataGrid } from './DataGrid';
import { CreateTableModal, DdlPreviewModal } from './DdlDialogs';
import { explorerError } from './TableDataTab';
import { sqlTemplate } from './sqlTemplates';

const MAINT_LABEL: Record<DbxMaintenanceOp, string> = {
  optimize: 'OPTIMIZE', analyze: 'ANALYZE', check: 'CHECK', repair: 'REPAIR', vacuum: 'VACUUM', vacuumAnalyze: 'VACUUM (ANALYZE)', reindex: 'REINDEX',
};

/** Database home: every table with its estimated rows and size; selection → export, maintenance; new table, import. */
export function OverviewPanel({ instanceId, dbId, family, info, tables, onOpen, onChanged, onExport, onImport }: {
  instanceId: number; dbId: number; family: DbFamily; info: DbxInfo; tables: DbxTable[];
  onOpen: (id: string) => void; onChanged: () => void; onExport: (preset?: string[]) => void; onImport: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<{ request: DbxDdlRequest; title: string } | null>(null);
  const [maint, setMaint] = useState<{ op: DbxMaintenanceOp; res: DbxQueryResponse } | null>(null);
  const [busy, setBusy] = useState<DbxMaintenanceOp | null>(null);
  const { sorted, sort } = useTableSort(tables, { name: (x) => x.id, rows: (x) => x.rows ?? -1, bytes: (x) => x.bytes ?? -1 }, { key: 'name' });
  const only = [...sel].filter((id) => tables.some((x) => x.id === id && x.kind === 'table'));
  const runMaint = async (op: DbxMaintenanceOp) => {
    if (!only.length) return;
    if ((op === 'optimize' || op === 'repair' || op === 'reindex' || op === 'vacuum' || op === 'vacuumAnalyze') && !(await confirm({
      title: MAINT_LABEL[op],
      message: t('dbx.maintenance.lockWarning', { count: only.length, defaultValue: 'Runs on {{count}} table(s). The tables may be locked meanwhile (a big table: minutes).' }),
      confirmLabel: t('dbx.console.run') || 'Run',
    }))) return;
    setBusy(op);
    try {
      setMaint({ op, res: await dbExplorerApi.maintenance(instanceId, dbId, op, only) });
      onChanged();
    } catch (err) { toast.error(explorerError(err)); } finally { setBusy(null); }
  };
  const total = tables.reduce((s, x) => s + (x.bytes ?? 0), 0);
  const th = 'px-3 py-2 text-left text-[11px] font-mono font-medium uppercase tracking-[0.1em] text-text-muted';
  const td = 'border-t border-white/[0.03] px-3 py-1.5';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.04] px-3 py-2">
        <Button size="sm" onClick={() => setCreating(true)}><Plus className="mr-1 h-3.5 w-3.5" />{t('dbx.table.create') || 'New table'}</Button>
        <Button size="sm" variant="secondary" onClick={() => onExport(only.length ? [...sel] : undefined)}><Download className="mr-1 h-3.5 w-3.5" />{only.length ? t('dbx.export.selectedTables', { count: sel.size, defaultValue: 'Export {{count}} table(s)' }) : (t('dbx.export.database') || 'Export the database')}</Button>
        <Button size="sm" variant="secondary" onClick={onImport}><Upload className="mr-1 h-3.5 w-3.5" />{t('dbx.import.title') || 'Import'}</Button>
        <ActionMenu label={t('dbx.maintenance.title') || 'Maintenance'}
          trigger={(p) => <Button {...p} size="sm" variant="ghost" disabled={!only.length} loading={busy !== null}><Wrench className="mr-1 h-3.5 w-3.5" />{t('dbx.maintenance.title') || 'Maintenance'}</Button>}
          items={info.maintenance.map((op) => ({ key: op, label: MAINT_LABEL[op], description: t(`dbx.maintenance.hint.${op}`, { defaultValue: '' }) || undefined, onClick: () => void runMaint(op) }))} />
        <span className="ml-auto font-mono text-[11px] text-text-muted">{t('dbx.tables.count', { count: tables.length, defaultValue: '{{count}} table(s)' })} · {formatBytes(total)}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!tables.length ? <EmptyState icon={<Table2 />} text={t('dbx.tables.empty') || 'No table in this database yet.'} action={<Button size="sm" onClick={() => setCreating(true)}>{t('dbx.table.create') || 'New table'}</Button>} /> : (
          <div className="overflow-x-auto rounded-lg bg-bg-primary/40">
            <table className="w-full text-[13px]">
              <thead><tr>
                <th className={cn(th, 'w-8')}><input type="checkbox" checked={sel.size === tables.length} onChange={() => setSel(sel.size === tables.length ? new Set() : new Set(tables.map((x) => x.id)))} className="accent-[rgb(var(--c-accent))]" /></th>
                <SortTh k="name" sort={sort} className={th}>{t('dbx.structure.name') || 'Name'}</SortTh>
                <SortTh k="rows" sort={sort} className={cn(th, 'text-right')}>{t('dbx.tables.rows') || 'Rows (≈)'}</SortTh>
                <SortTh k="bytes" sort={sort} className={cn(th, 'text-right')}>{t('dbx.tables.size') || 'Size'}</SortTh>
                <th className={th}>{t('dbx.tables.engine') || 'Engine'}</th>
                <th className={th}>{t('dbx.structure.comment') || 'Comment'}</th>
              </tr></thead>
              <tbody>
                {sorted.map((x) => (
                  <tr key={x.id} className={sel.has(x.id) ? 'bg-accent/[0.08]' : 'hover:bg-bg-hover/50'}>
                    <td className={td}><input type="checkbox" checked={sel.has(x.id)} onChange={() => { const n = new Set(sel); if (n.has(x.id)) n.delete(x.id); else n.add(x.id); setSel(n); }} className="accent-[rgb(var(--c-accent))]" /></td>
                    <td className={td}>
                      <button type="button" onClick={() => onOpen(x.id)} className="inline-flex items-center gap-1.5 font-mono text-text-primary hover:text-accent">
                        {x.kind === 'view' ? <Eye className="h-3.5 w-3.5 text-sky-400" /> : <Table2 className="h-3.5 w-3.5 text-accent" />}{x.id}
                      </button>
                    </td>
                    <td className={cn(td, 'text-right font-mono text-text-secondary')}>{x.rows?.toLocaleString() ?? '—'}</td>
                    <td className={cn(td, 'text-right font-mono text-text-secondary')}>{x.bytes !== null ? formatBytes(x.bytes) : '—'}</td>
                    <td className={cn(td, 'font-mono text-[11px] text-text-muted')}>{x.kind === 'view' ? (x.materialized ? 'materialized view' : 'view') : (x.engine ?? '')}</td>
                    <td className={cn(td, 'text-text-muted')}>{x.comment}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {maint && (
          <div className="mt-4 overflow-hidden rounded-lg bg-bg-primary/40">
            <div className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-secondary"><Wrench className="h-3.5 w-3.5" />{MAINT_LABEL[maint.op]}
              {maint.res.stopped ? <Pill tone="red">{t('dbx.maintenance.failed') || 'failed'}</Pill> : <Pill tone="green">OK</Pill>}</div>
            {maint.res.results.map((r, i) => (
              <div key={i} className="border-t border-white/[0.04]">
                <code className="block truncate px-3 py-1 font-mono text-[11px] text-text-muted">{r.statement}{r.error ? ` → ${r.error}` : ` · ${r.durationMs} ms`}</code>
                {r.columns && r.rows && <div className="flex max-h-72 min-h-0 flex-col"><DataGrid columns={r.columns} rows={r.rows} /></div>}
              </div>
            ))}
          </div>
        )}
      </div>
      {creating && <CreateTableModal family={family} onClose={() => setCreating(false)} onRequest={(request, title) => { setCreating(false); setPending({ request, title }); }} />}
      {pending && <DdlPreviewModal instanceId={instanceId} dbId={dbId} request={pending.request} title={pending.title} onClose={() => setPending(null)} onDone={onChanged} />}
    </div>
  );
}

const KINDS: DbxObjectKind[] = ['view', 'procedure', 'function', 'trigger', 'event'];

/** Views, routines, triggers (and events): definition, drop, edit / create through the console. */
export function ObjectsPanel({ instanceId, dbId, family, onEditInConsole, onChanged }: {
  instanceId: number; dbId: number; family: DbFamily; onEditInConsole: (sql: string) => void; onChanged: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [list, setList] = useState<DbxObject[] | null>(null);
  const [picked, setPicked] = useState<DbxObject | null>(null);
  const [ddl, setDdl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<DbxDdlRequest | null>(null);
  const load = () => { dbExplorerApi.objects(instanceId, dbId).then((l) => { setList(l); setError(null); }).catch((err) => setError(explorerError(err))); };
  useEffect(load, [instanceId, dbId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setDdl(null);
    if (!picked) return;
    dbExplorerApi.objectDefinition(instanceId, dbId, picked.kind, picked.id).then((d) => setDdl(d.ddl)).catch((err) => setDdl(`-- ${explorerError(err)}`));
  }, [instanceId, dbId, picked]);
  const kinds = KINDS.filter((k) => k !== 'event' || family === 'mysql');
  const drop = async (o: DbxObject) => {
    if (await confirm({ title: t('dbx.objects.dropTitle', { name: o.name, defaultValue: 'Drop {{name}}' }), message: t('dbx.objects.dropConfirm', { name: o.name, defaultValue: 'Type {{name}} to confirm.' }), danger: true, requireText: o.name })) {
      setPending({ op: 'dropObject', kind: o.kind, id: o.id, confirm: o.name });
    }
  };
  /** MySQL: SHOW CREATE gives CREATE … DEFINER=…: rewritten as CREATE OR REPLACE without the definer (the console user becomes it). */
  const editable = (o: DbxObject, text: string) => {
    if (family !== 'mysql') return text;
    const s = text.replace(/\s+DEFINER\s*=\s*(`[^`]*`|'[^']*'|\S+)@(`[^`]*`|'[^']*'|\S+)/i, '');
    if (o.kind === 'view') return s.replace(/^CREATE\s+(ALGORITHM=\w+\s+)?/i, 'CREATE OR REPLACE $1');
    if (o.kind === 'procedure' || o.kind === 'function' || o.kind === 'trigger' || o.kind === 'event') {
      return `-- ${t('dbx.objects.recreateHint') || 'To change it: drop it, then run this (edited) statement.'}\nDELIMITER $$\n${s}$$\nDELIMITER ;`;
    }
    return s;
  };
  return (
    <div className="flex min-h-0 flex-1 max-md:flex-col">
      <div className="w-72 shrink-0 overflow-y-auto border-r border-white/[0.04] p-2 max-md:max-h-64 max-md:w-full max-md:border-b max-md:border-r-0">
        <ActionMenu label={t('dbx.objects.new') || 'New'} menuClassName="w-56"
          trigger={(p) => <Button {...p} size="sm" className="mb-2 w-full"><Plus className="mr-1 h-3.5 w-3.5" />{t('dbx.objects.new') || 'New'}</Button>}
          items={kinds.map((k) => ({ key: k, icon: <FileCode2 className="h-4 w-4" />, label: t(`dbx.objects.kind.${k}`, { defaultValue: k }), onClick: () => onEditInConsole(sqlTemplate(family, k)) }))} />
        {!list && !error && <div className="flex justify-center p-6"><LoadingSpinner /></div>}
        {error && <p className="p-2 text-xs text-status-down">{error}</p>}
        {list && !list.length && <p className="p-2 text-xs text-text-muted">{t('dbx.objects.empty') || 'No view, routine or trigger.'}</p>}
        {kinds.map((k) => {
          const items = (list ?? []).filter((o) => o.kind === k);
          if (!items.length) return null;
          return (
            <div key={k} className="mb-2">
              <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-[0.1em] text-text-muted">{t(`dbx.objects.kinds.${k}`, { defaultValue: `${k}s` })} · {items.length}</div>
              {items.map((o) => (
                <button key={o.id} type="button" onClick={() => setPicked(o)} title={o.detail ?? undefined}
                  className={cn('flex w-full items-center gap-1.5 rounded px-2 py-1 text-left font-mono text-[12px] hover:bg-bg-hover', picked?.id === o.id && picked.kind === o.kind ? 'bg-accent/[0.12] text-text-primary' : 'text-text-secondary')}>
                  <span className="min-w-0 flex-1 truncate">{o.schema && o.schema !== 'public' ? `${o.schema}.` : ''}{o.name}</span>
                  {o.ephemeralDefiner && <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400" />}
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto p-3">
        {!picked ? <EmptyState icon={<FileCode2 />} text={t('dbx.objects.pick') || 'Pick a view, a routine or a trigger.'} className="bg-transparent" /> : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone="accent">{t(`dbx.objects.kind.${picked.kind}`, { defaultValue: picked.kind })}</Pill>
              <span className="font-mono text-sm text-text-primary">{picked.name}</span>
              {picked.table && <span className="font-mono text-xs text-text-muted">ON {picked.table}</span>}
              {picked.detail && <span className="font-mono text-xs text-text-muted">{picked.detail}</span>}
              <div className="ml-auto flex gap-1.5">
                <Button size="sm" variant="secondary" disabled={!ddl} onClick={() => ddl && onEditInConsole(editable(picked, ddl))}><TerminalSquare className="mr-1 h-3.5 w-3.5" />{t('dbx.objects.editInConsole') || 'Edit in the console'}</Button>
                <Button size="sm" variant="danger" onClick={() => void drop(picked)}><Trash2 className="mr-1 h-3.5 w-3.5" />{t('dbx.objects.drop') || 'Drop'}</Button>
              </div>
            </div>
            {picked.definer && (
              <p className={cn('text-[12px]', picked.ephemeralDefiner ? 'text-amber-400' : 'text-text-muted')}>
                DEFINER {picked.definer}{picked.ephemeralDefiner && ` — ${t('dbx.objects.ephemeralDefiner') || 'a temporary session user of the panel: this object stops working once that user is dropped. Recreate it with SQL SECURITY INVOKER, or from the site.'}`}
              </p>
            )}
            {ddl === null ? <div className="flex justify-center p-6"><LoadingSpinner /></div> : <CodeEditor value={ddl} readOnly language="sql" minHeight="160px" maxHeight="60vh" />}
          </div>
        )}
      </div>
      {pending && <DdlPreviewModal instanceId={instanceId} dbId={dbId} request={pending} title={t('dbx.objects.drop') || 'Drop'} onClose={() => setPending(null)} onDone={() => { setPicked(null); load(); onChanged(); }} />}
    </div>
  );
}

/** Search a text in every table of the database (text columns, bounded). */
export function SearchPanel({ instanceId, dbId, onOpen }: { instanceId: number; dbId: number; onOpen: (table: string) => void }) {
  const { t } = useTranslation();
  const [term, setTerm] = useState('');
  const [mode, setMode] = useState<'contains' | 'exact'>('contains');
  const [res, setRes] = useState<DbxSearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    if (!term.trim() || busy) return;
    setBusy(true);
    setError(null);
    try { setRes(await dbExplorerApi.search(instanceId, dbId, { term, mode })); } catch (err) { setError(explorerError(err)); } finally { setBusy(false); }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.04] px-3 py-2">
        <div className="flex min-w-[240px] flex-1 items-center gap-1 rounded-lg bg-bg-primary/60 px-2 py-1.5">
          <Search className="h-4 w-4 text-text-muted" />
          <input value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void go(); }} maxLength={200} autoFocus
            placeholder={t('dbx.search.placeholder') || 'Text to find in every table'} className="w-full bg-transparent text-sm text-text-primary outline-none" />
        </div>
        <select value={mode} onChange={(e) => setMode(e.target.value as 'contains' | 'exact')} className="rounded-lg bg-bg-tertiary px-2 py-1.5 text-sm text-text-primary outline-none">
          <option value="contains">{t('dbx.search.contains') || 'Contains'}</option>
          <option value="exact">{t('dbx.search.exact') || 'Exact value'}</option>
        </select>
        <Button size="sm" loading={busy} onClick={() => void go()}>{t('dbx.search.go') || 'Search'}</Button>
        <span className="text-[11px] text-text-muted">{t('dbx.search.limits', { tables: DBX_SEARCH_MAX_TABLES, rows: DBX_SEARCH_ROWS_PER_TABLE, defaultValue: 'Text columns, {{tables}} tables and {{rows}} rows per table at most' })}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {error && <p className="text-sm text-status-down">{error}</p>}
        {res && (
          <p className="text-[12px] text-text-muted">
            {t('dbx.search.summary', { hits: res.hits.length, searched: res.tablesSearched, skipped: res.tablesSkipped, defaultValue: '{{hits}} table(s) with matches · {{searched}} searched · {{skipped}} skipped' })}
            {res.timedOut && <span className="ml-1 text-status-pending">{t('dbx.search.timedOut') || '(time budget reached: narrow the search)'}</span>}
          </p>
        )}
        {res && !res.hits.length && <EmptyState icon={<Search />} text={t('dbx.search.none') || 'Nothing found.'} className="bg-transparent" />}
        {res?.hits.map((h) => (
          <div key={h.table} className="overflow-hidden rounded-lg bg-bg-primary/40">
            <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-[12px]">
              <button type="button" onClick={() => onOpen(h.table)} className="inline-flex items-center gap-1.5 font-mono text-text-primary hover:text-accent"><Table2 className="h-3.5 w-3.5 text-accent" />{h.table}</button>
              <span className="font-mono text-[11px] text-text-muted">{h.rows.length}{h.more ? '+' : ''} · {h.searchedColumns.join(', ')}</span>
            </div>
            <div className="flex max-h-72 min-h-0 flex-col border-t border-white/[0.04]"><DataGrid columns={h.columns} rows={h.rows} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}
