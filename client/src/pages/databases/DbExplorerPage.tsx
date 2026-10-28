import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, Columns3, Database, Download, Eye, FileCode2, LayoutList, RefreshCw, Rows3, Search, Table2, TerminalSquare, Upload,
} from 'lucide-react';
import type { DbFamily, DbInstanceDetail, DbxFilter, DbxInfo, DbxTable, DbxTableInfo } from '@oblimint/shared';
import { databasesApi } from '@/api/databases.api';
import { dbExplorerApi } from '@/api/dbExplorer.api';
import { PageContainer } from '@/components/common/PageContainer';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { IconButton } from '@/components/common/IconButton';
import { Button } from '@/components/common/Button';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { formatBytes } from '@/components/usage/usageFormat';
import { TableDataTab, explorerError } from '@/components/databases/explorer/TableDataTab';
import { TableStructureTab } from '@/components/databases/explorer/TableStructureTab';
import { SqlConsole } from '@/components/databases/explorer/SqlConsole';
import { ObjectsPanel, OverviewPanel, SearchPanel } from '@/components/databases/explorer/DatabasePanels';
import { ExportModal, ImportModal } from '@/components/databases/explorer/TransferDialogs';
import { qIdent } from '@/components/databases/explorer/sqlIdent';
import { cn } from '@/utils/cn';

type Tab = 'data' | 'structure' | 'sql';
type View = 'overview' | 'sql' | 'search' | 'objects';

function parseFilters(v: string | null): DbxFilter[] | undefined {
  if (!v) return undefined;
  try { const f = JSON.parse(v); return Array.isArray(f) ? f.slice(0, 20) : undefined; } catch { return undefined; }
}

/**
 * « Explorateur SQL » of one database: tables on the left; on the right the
 * database (overview, console, search, objects) or a table (data, structure,
 * console). The table, tab, view and filters live in the URL
 * (?t=items&tab=data&f=[…]). The panel's ephemeral SQL session is closed on leave.
 */
export function DbExplorerPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const params = useParams();
  const instanceId = Number(params.id);
  const dbId = Number(params.dbId);
  const [search, setSearch] = useSearchParams();
  const tableId = search.get('t');
  const tab = (search.get('tab') as Tab) || 'data';
  const view = (search.get('view') as View) || 'overview';
  const filtersParam = search.get('f');
  const initialFilters = useMemo(() => parseFilters(filtersParam), [filtersParam]);

  const [instance, setInstance] = useState<DbInstanceDetail | null>(null);
  const [info, setInfo] = useState<DbxInfo | null>(null);
  const [tables, setTables] = useState<DbxTable[] | null>(null);
  const [tableInfo, setTableInfo] = useState<DbxTableInfo | null>(null);
  const [tableNonce, setTableNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [inject, setInject] = useState<{ sql: string; nonce: number } | null>(null);
  const [exporting, setExporting] = useState<{ preset?: string[] } | null>(null);
  const [importing, setImporting] = useState<{ table?: string } | null>(null);

  useEffect(() => {
    let live = true;
    databasesApi.getInstance(instanceId).then((i) => { if (live) setInstance(i); }).catch(() => undefined);
    setInfo(null);
    setTables(null);
    setError(null);
    dbExplorerApi.info(instanceId, dbId)
      .then((i) => { if (!live) return; setInfo(i); return dbExplorerApi.tables(instanceId, dbId).then((l) => { if (live) setTables(l); }); })
      .catch((err) => { if (live) setError(explorerError(err)); });
    return () => {
      live = false;
      void dbExplorerApi.close(instanceId, dbId).catch(() => undefined);
    };
  }, [instanceId, dbId]);

  const refreshTables = useCallback(async () => {
    try { setTables(await dbExplorerApi.tables(instanceId, dbId, true)); } catch (err) { setError(explorerError(err)); }
  }, [instanceId, dbId]);

  useEffect(() => {
    if (!tableId) { setTableInfo(null); return; }
    let live = true;
    setTableInfo(null);
    dbExplorerApi.table(instanceId, dbId, tableId).then((i) => { if (live) setTableInfo(i); }).catch((err) => { if (live) setError(explorerError(err)); });
    return () => { live = false; };
  }, [instanceId, dbId, tableId, tableNonce]);

  const go = (p: { t?: string | null; tab?: Tab; view?: View; f?: DbxFilter[] }) => {
    const n = new URLSearchParams();
    if (p.t) {
      n.set('t', p.t);
      if (p.tab && p.tab !== 'data') n.set('tab', p.tab);
      if (p.f?.length) n.set('f', JSON.stringify(p.f));
    } else if (p.view && p.view !== 'overview') n.set('view', p.view);
    setSearch(n);
  };
  const openTable = (id: string, nextTab: Tab = 'data') => go({ t: id, tab: nextTab });
  const editInConsole = (sql: string) => { setInject({ sql, nonce: Date.now() }); go({ view: 'sql' }); };
  const schemaChanged = () => { void refreshTables(); setTableNonce((n) => n + 1); };

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (tables ?? []).filter((x) => !f || x.id.toLowerCase().includes(f));
  }, [tables, filter]);

  const family: DbFamily = instance?.family ?? (info?.engine === 'postgresql' ? 'postgresql' : 'mysql');
  const selected = tables?.find((x) => x.id === tableId) ?? null;
  const initialSql = selected ? `SELECT * FROM ${qIdent(family, selected)} LIMIT 100;` : '';
  const tabs: SegmentedTab<Tab>[] = [
    { id: 'data', label: t('dbx.tabs.data') || 'Data', icon: <Rows3 size={15} /> },
    { id: 'structure', label: t('dbx.tabs.structure') || 'Structure', icon: <Columns3 size={15} /> },
    { id: 'sql', label: 'SQL', icon: <TerminalSquare size={15} /> },
  ];
  const views: Array<{ id: View; label: string; icon: JSX.Element }> = [
    { id: 'overview', label: t('dbx.views.overview') || 'Tables', icon: <LayoutList className="h-4 w-4" /> },
    { id: 'sql', label: t('dbx.tables.console') || 'SQL console', icon: <TerminalSquare className="h-4 w-4" /> },
    { id: 'search', label: t('dbx.views.search') || 'Search', icon: <Search className="h-4 w-4" /> },
    { id: 'objects', label: t('dbx.views.objects') || 'Views & routines', icon: <FileCode2 className="h-4 w-4" /> },
  ];
  const consoleEl = (
    <SqlConsole key={`${dbId}`} instanceId={instanceId} dbId={dbId} family={family} engine={info?.engine ?? ''} initialSql={initialSql} inject={inject} onInjected={() => setInject(null)} onSchemaChanged={schemaChanged} />
  );

  return (
    <PageContainer className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <IconButton label={t('common.back') || 'Back'} icon={<ArrowLeft className="h-5 w-5" />} onClick={() => navigate(`/databases/${instanceId}`)} />
        <Database className="h-6 w-6 text-accent" />
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-semibold leading-tight text-text-primary">{info?.database ?? '…'}</h1>
          <div className="font-mono text-[11px] text-text-muted">
            {instance && <Link to={`/databases/${instanceId}`} className="hover:text-accent">{instance.name}</Link>}
            {info && ` · ${info.engine}${info.version ? ` ${info.version}` : ''} · ${t('dbx.sessionUser', { user: info.user, defaultValue: 'session {{user}}' })}`}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {info && tables && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setExporting({})}><Download className="mr-1.5 h-4 w-4" />{t('dbx.export.title') || 'Export'}</Button>
              <Button size="sm" variant="secondary" onClick={() => setImporting({})}><Upload className="mr-1.5 h-4 w-4" />{t('dbx.import.title') || 'Import'}</Button>
            </>
          )}
          {instance && instance.databases.length > 1 && (
            <select value={dbId} onChange={(e) => navigate(`/databases/${instanceId}/explorer/${e.target.value}`)}
              className="rounded-lg bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none ring-1 ring-white/[0.06] focus:ring-accent">
              {instance.databases.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
        </div>
      </div>

      {error && <div className="rounded-lg bg-status-down/10 px-3 py-2 text-sm text-status-down">{error}</div>}

      <div className="flex min-h-[70vh] flex-1 gap-3 max-lg:flex-col">
        {/* Database views + tables */}
        <aside className="flex w-64 shrink-0 flex-col overflow-hidden rounded-xl bg-bg-secondary max-lg:max-h-72 max-lg:w-full">
          <div className="border-b border-white/[0.04] py-1">
            {views.map((v) => (
              <button key={v.id} type="button" onClick={() => go({ view: v.id })}
                className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-bg-hover', !tableId && view === v.id ? 'bg-accent/[0.12] text-accent' : 'text-text-secondary')}>
                {v.icon}{v.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 border-b border-white/[0.04] p-2">
            <div className="flex flex-1 items-center gap-1 rounded-lg bg-bg-primary/60 px-2 py-1">
              <Search className="h-3.5 w-3.5 text-text-muted" />
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('dbx.tables.filter') || 'Tables'} className="w-full bg-transparent text-[13px] text-text-primary outline-none" />
            </div>
            <IconButton size="sm" label={t('dbx.refresh') || 'Refresh'} icon={<RefreshCw className="h-4 w-4" />} onClick={() => void refreshTables()} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            {!tables && !error && <div className="flex justify-center p-6"><LoadingSpinner /></div>}
            {tables && !tables.length && <p className="p-4 text-xs text-text-muted">{t('dbx.tables.empty') || 'No table in this database yet.'}</p>}
            {shown.map((x) => (
              <button key={x.id} type="button" onClick={() => openTable(x.id, tableId ? tab : 'data')} title={[x.comment, x.bytes !== null ? formatBytes(x.bytes) : null].filter(Boolean).join(' · ') || x.id}
                className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-bg-hover', x.id === tableId ? 'bg-accent/[0.12] text-text-primary' : 'text-text-secondary')}>
                {x.kind === 'view' ? <Eye className="h-3.5 w-3.5 shrink-0 text-sky-400" /> : <Table2 className="h-3.5 w-3.5 shrink-0 text-accent" />}
                <span className="min-w-0 flex-1 truncate font-mono">{x.id}</span>
                {x.rows !== null && <span className="shrink-0 font-mono text-[10px] text-text-muted">{x.rows.toLocaleString()}</span>}
              </button>
            ))}
          </div>
          {tables && (
            <div className="border-t border-white/[0.04] px-3 py-1.5 font-mono text-[10px] text-text-muted">
              {t('dbx.tables.count', { count: tables.length, defaultValue: '{{count}} table(s)' })}
              {' · '}{formatBytes(tables.reduce((s, x) => s + (x.bytes ?? 0), 0))}
            </div>
          )}
        </aside>

        {/* Workspace */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-bg-secondary">
          {tableId && (
            <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.04] px-3 py-2">
              {selected && (
                <span className="inline-flex items-center gap-1.5 font-mono text-sm text-text-primary">
                  {selected.kind === 'view' ? <Eye className="h-4 w-4 text-sky-400" /> : <Table2 className="h-4 w-4 text-accent" />}{selected.id}
                </span>
              )}
              <SegmentedTabs tabs={tabs} value={tab} onChange={(v) => go({ t: tableId, tab: v })} />
            </div>
          )}
          {!info || !tables ? (
            !error && <div className="flex justify-center p-10"><LoadingSpinner /></div>
          ) : !tableId ? (
            view === 'sql' ? consoleEl
              : view === 'search' ? <SearchPanel instanceId={instanceId} dbId={dbId} onOpen={(id) => openTable(id)} />
                : view === 'objects' ? <ObjectsPanel instanceId={instanceId} dbId={dbId} family={family} onEditInConsole={editInConsole} onChanged={schemaChanged} />
                  : <OverviewPanel instanceId={instanceId} dbId={dbId} family={family} info={info} tables={tables} onOpen={(id) => openTable(id)} onChanged={schemaChanged}
                      onExport={(preset) => setExporting({ preset })} onImport={() => setImporting({})} />
          ) : tab === 'sql' ? consoleEl
            : !tableInfo ? <div className="flex justify-center p-10"><LoadingSpinner /></div>
              : tab === 'structure' ? (
                <TableStructureTab instanceId={instanceId} dbId={dbId} family={family} info={tableInfo} tables={tables} onOpenTable={(id) => openTable(id, 'structure')}
                  onChanged={schemaChanged} onRenamed={(id) => { void refreshTables(); openTable(id, 'structure'); }} onDropped={() => { void refreshTables(); go({ view: 'overview' }); }} />
              ) : (
                <TableDataTab key={`${tableId}:${filtersParam ?? ''}`} instanceId={instanceId} dbId={dbId} info={tableInfo} onChanged={() => void refreshTables()}
                  initialFilters={initialFilters} onOpen={(id, f) => go({ t: id, f })}
                  onExport={() => setExporting({ preset: [tableId] })} onImport={() => setImporting({ table: tableId })} />
              )}
        </section>
      </div>

      {exporting && tables && <ExportModal instanceId={instanceId} dbId={dbId} tables={tables} preset={exporting.preset} onClose={() => setExporting(null)} />}
      {importing && tables && info && (
        <ImportModal instanceId={instanceId} dbId={dbId} tables={tables} presetTable={importing.table} maxBytes={info.importMaxBytes} onClose={() => setImporting(null)} onDone={schemaChanged} />
      )}
    </PageContainer>
  );
}
