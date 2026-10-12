import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Database, Eye, RefreshCw, Search, Table2, TerminalSquare, Columns3, Rows3 } from 'lucide-react';
import type { DbInstanceDetail, DbxInfo, DbxTable, DbxTableInfo } from '@oblimint/shared';
import { databasesApi } from '@/api/databases.api';
import { dbExplorerApi } from '@/api/dbExplorer.api';
import { PageContainer } from '@/components/common/PageContainer';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { IconButton } from '@/components/common/IconButton';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { formatBytes } from '@/components/usage/usageFormat';
import { TableDataTab, explorerError } from '@/components/databases/explorer/TableDataTab';
import { TableStructureTab } from '@/components/databases/explorer/TableStructureTab';
import { SqlConsole } from '@/components/databases/explorer/SqlConsole';
import { qIdent } from '@/components/databases/explorer/sqlIdent';
import { cn } from '@/utils/cn';

type Tab = 'data' | 'structure' | 'sql';

/**
 * « Explorateur SQL » of one database: tables on the left, data / structure /
 * SQL console on the right. The table and the tab live in the URL
 * (?t=items&tab=data). The panel's ephemeral SQL session is closed on leave.
 */
export function DbExplorerPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const params = useParams();
  const instanceId = Number(params.id);
  const dbId = Number(params.dbId);
  const [search, setSearch] = useSearchParams();
  const tableId = search.get('t');
  const tab = (search.get('tab') as Tab) || (tableId ? 'data' : 'sql');

  const [instance, setInstance] = useState<DbInstanceDetail | null>(null);
  const [info, setInfo] = useState<DbxInfo | null>(null);
  const [tables, setTables] = useState<DbxTable[] | null>(null);
  const [tableInfo, setTableInfo] = useState<DbxTableInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

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
  }, [instanceId, dbId, tableId]);

  const open = (id: string | null, nextTab?: Tab) => {
    const p = new URLSearchParams(search);
    if (id) p.set('t', id); else p.delete('t');
    if (nextTab) p.set('tab', nextTab); else p.delete('tab');
    setSearch(p);
  };

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (tables ?? []).filter((x) => !f || x.id.toLowerCase().includes(f));
  }, [tables, filter]);

  const family = instance?.family ?? (info?.engine === 'postgresql' ? 'postgresql' : 'mysql');
  const selected = tables?.find((x) => x.id === tableId) ?? null;
  const initialSql = selected ? `SELECT * FROM ${qIdent(family, selected)} LIMIT 100;` : '';
  const tabs: SegmentedTab<Tab>[] = [
    ...(tableId ? [
      { id: 'data' as const, label: t('dbx.tabs.data') || 'Data', icon: <Rows3 size={15} /> },
      { id: 'structure' as const, label: t('dbx.tabs.structure') || 'Structure', icon: <Columns3 size={15} /> },
    ] : []),
    { id: 'sql', label: 'SQL', icon: <TerminalSquare size={15} /> },
  ];

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
        {instance && instance.databases.length > 1 && (
          <select value={dbId} onChange={(e) => navigate(`/databases/${instanceId}/explorer/${e.target.value}`)}
            className="ml-auto rounded-lg bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none ring-1 ring-white/[0.06] focus:ring-accent">
            {instance.databases.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        )}
      </div>

      {error && <div className="rounded-lg bg-status-down/10 px-3 py-2 text-sm text-status-down">{error}</div>}

      <div className="flex min-h-[70vh] flex-1 gap-3 max-lg:flex-col">
        {/* Tables */}
        <aside className="flex w-64 shrink-0 flex-col overflow-hidden rounded-xl bg-bg-secondary max-lg:max-h-64 max-lg:w-full">
          <div className="flex items-center gap-1 border-b border-white/[0.04] p-2">
            <div className="flex flex-1 items-center gap-1 rounded-lg bg-bg-primary/60 px-2 py-1">
              <Search className="h-3.5 w-3.5 text-text-muted" />
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('dbx.tables.filter') || 'Tables'} className="w-full bg-transparent text-[13px] text-text-primary outline-none" />
            </div>
            <IconButton size="sm" label={t('dbx.refresh') || 'Refresh'} icon={<RefreshCw className="h-4 w-4" />} onClick={() => void refreshTables()} />
          </div>
          <button type="button" onClick={() => open(null)} className={cn('flex items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-bg-hover', !tableId && 'bg-accent/[0.12] text-accent')}>
            <TerminalSquare className="h-4 w-4" />{t('dbx.tables.console') || 'SQL console'}
          </button>
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            {!tables && !error && <div className="flex justify-center p-6"><LoadingSpinner /></div>}
            {tables && !tables.length && <p className="p-4 text-xs text-text-muted">{t('dbx.tables.empty') || 'No table in this database yet.'}</p>}
            {shown.map((x) => (
              <button key={x.id} type="button" onClick={() => open(x.id, tab === 'sql' ? 'data' : tab)} title={x.comment ?? x.id}
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
          <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.04] px-3 py-2">
            {selected && (
              <span className="inline-flex items-center gap-1.5 font-mono text-sm text-text-primary">
                {selected.kind === 'view' ? <Eye className="h-4 w-4 text-sky-400" /> : <Table2 className="h-4 w-4 text-accent" />}{selected.id}
              </span>
            )}
            <SegmentedTabs tabs={tabs} value={tab} onChange={(v) => open(tableId, v)} />
          </div>
          {!info ? (
            !error && <div className="flex justify-center p-10"><LoadingSpinner /></div>
          ) : tab === 'sql' || !tableId ? (
            <SqlConsole key={`${dbId}`} instanceId={instanceId} dbId={dbId} initialSql={initialSql} onSchemaChanged={() => void refreshTables()} />
          ) : !tableInfo ? (
            <div className="flex justify-center p-10"><LoadingSpinner /></div>
          ) : tab === 'structure' ? (
            <TableStructureTab info={tableInfo} onOpenTable={(id) => open(id, 'data')} />
          ) : (
            <TableDataTab instanceId={instanceId} dbId={dbId} info={tableInfo} onChanged={() => void refreshTables()} />
          )}
        </section>
      </div>
    </PageContainer>
  );
}
