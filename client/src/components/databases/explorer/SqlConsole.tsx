import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Download, History, Play, XCircle } from 'lucide-react';
import type { DbxQueryResponse } from '@oblimint/shared';
import { DBX_MAX_QUERY_ROWS, DBX_STATEMENT_TIMEOUT_S } from '@oblimint/shared';
import { dbExplorerApi } from '@/api/dbExplorer.api';
import { Button } from '@/components/common/Button';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { CodeEditor } from '@/components/apps/CodeEditor';
import { ActionMenu } from '@/components/common/ActionMenu';
import { DataGrid, downloadText, toCsv } from './DataGrid';
import { explorerError } from './TableDataTab';

const HISTORY_KEY = 'oblimint.dbx.history';

function readHistory(): string[] {
  try { const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((s) => typeof s === 'string').slice(0, 30) : []; } catch { return []; }
}

/** Statements that destroy data without a WHERE (asked first, like phpMyAdmin). */
export function destructive(sql: string): Array<{ text: string; noWhere: boolean }> {
  const out: Array<{ text: string; noWhere: boolean }> = [];
  const clean = sql.replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.)*"|--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
  for (const s of clean.split(';')) {
    const st = s.trim();
    const head = st.split(/\s+/).slice(0, 3).join(' ');
    if (/^(drop|truncate)\b/i.test(st)) out.push({ text: head, noWhere: false });
    else if (/^(delete|update)\b/i.test(st) && !/\bwhere\b/i.test(st)) out.push({ text: head, noWhere: true });
  }
  return out;
}

/** SQL console: statements run in order as the session's user (stops at the first error), results as grids. */
export function SqlConsole({ instanceId, dbId, initialSql, onSchemaChanged }: {
  instanceId: number;
  dbId: number;
  initialSql: string;
  onSchemaChanged?: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [sql, setSql] = useState(initialSql);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<DbxQueryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState(readHistory);
  const sqlRef = useRef(sql);
  sqlRef.current = sql;

  useEffect(() => { if (initialSql && !sqlRef.current.trim()) setSql(initialSql); }, [initialSql]);

  const run = async () => {
    const text = sqlRef.current.trim();
    if (!text || busy) return;
    const danger = destructive(text);
    if (danger.length && !(await confirm({
      title: t('dbx.console.dangerTitle') || 'Destructive statements',
      message: (
        <div className="space-y-2 text-sm">
          <p>{t('dbx.console.dangerMessage') || 'These statements delete data or structure. Run them?'}</p>
          <ul className="font-mono text-xs text-status-down">{danger.map((d, i) => <li key={i}>{d.text}{d.noWhere && ` … (${t('dbx.console.noWhere') || 'no WHERE: every row'})`}</li>)}</ul>
        </div>
      ),
      danger: true,
      confirmLabel: t('dbx.console.run') || 'Run',
    }))) return;
    setBusy(true);
    setError(null);
    try {
      const r = await dbExplorerApi.query(instanceId, dbId, text);
      setRes(r);
      const h = [text, ...history.filter((x) => x !== text)].slice(0, 30);
      setHistory(h);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch { /* quota / private mode */ }
      if (r.results.some((x) => !x.columns && !x.error)) onSchemaChanged?.();
    } catch (err) {
      setError(explorerError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="border-b border-white/[0.04] p-2"
        onKeyDownCapture={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void run(); } }}
      >
        <CodeEditor value={sql} onChange={setSql} language="sql" minHeight="140px" maxHeight="40vh" ariaLabel="SQL" placeholder="SELECT * FROM …" />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void run()} loading={busy}><Play className="mr-1.5 h-3.5 w-3.5" />{t('dbx.console.run') || 'Run'}</Button>
          <span className="text-[11px] text-text-muted">
            Ctrl+Enter · {t('dbx.console.limits', { rows: DBX_MAX_QUERY_ROWS, seconds: DBX_STATEMENT_TIMEOUT_S, defaultValue: '{{rows}} rows max per result, {{seconds}} s per statement' })}
          </span>
          {history.length > 0 && (
            <div className="ml-auto">
              <ActionMenu
                label={t('dbx.console.history') || 'History'}
                trigger={(p) => <button {...p} type="button" className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary"><History className="h-3.5 w-3.5" />{t('dbx.console.history') || 'History'}</button>}
                menuClassName="w-[min(520px,90vw)]"
                items={history.map((h, i) => ({ key: String(i), label: h.replace(/\s+/g, ' ').slice(0, 120), onClick: () => setSql(h) }))}
              />
            </div>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {error && <p className="text-sm text-status-down">{error}</p>}
        {res?.results.map((r, i) => (
          <div key={i} className="overflow-hidden rounded-lg bg-bg-primary/40">
            <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-[12px]">
              {r.error ? <XCircle className="h-4 w-4 shrink-0 text-status-down" /> : r.truncated ? <AlertTriangle className="h-4 w-4 shrink-0 text-status-pending" /> : <CheckCircle2 className="h-4 w-4 shrink-0 text-status-up" />}
              <code className="min-w-0 flex-1 truncate font-mono text-text-secondary" title={r.statement}>{r.statement.replace(/\s+/g, ' ')}</code>
              <span className="font-mono text-[11px] text-text-muted">
                {r.columns ? t('dbx.console.rows', { count: r.rows?.length ?? 0, defaultValue: '{{count}} row(s)' }) : r.error ? '' : t('dbx.console.affected', { count: r.affectedRows ?? 0, defaultValue: '{{count}} row(s) affected' })}
                {r.insertId ? ` · id ${r.insertId}` : ''} · {r.durationMs} ms
              </span>
              {r.columns && r.rows && r.rows.length > 0 && (
                <button type="button" title={t('dbx.exportCsv') || 'Export as CSV'} onClick={() => downloadText(`result-${i + 1}.csv`, toCsv(r.columns!, r.rows!))} className="text-text-muted hover:text-text-primary">
                  <Download className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {r.error && <p className="border-t border-white/[0.04] px-3 py-2 font-mono text-[12px] text-status-down">{r.error}</p>}
            {r.truncated && <p className="border-t border-white/[0.04] px-3 py-1 text-[11px] text-status-pending">{t('dbx.console.truncated', { rows: DBX_MAX_QUERY_ROWS, defaultValue: 'Only the first {{rows}} rows are shown (add a LIMIT).' })}</p>}
            {r.columns && r.rows && (
              <div className="flex max-h-[420px] min-h-0 flex-col border-t border-white/[0.04]">
                <DataGrid columns={r.columns} rows={r.rows} emptyText={t('dbx.console.noRows') || 'No rows.'} />
              </div>
            )}
          </div>
        ))}
        {res?.stopped && <p className="text-[11px] text-text-muted">{t('dbx.console.stopped') || 'Execution stopped at the first error: the following statements were not run.'}</p>}
      </div>
    </div>
  );
}
