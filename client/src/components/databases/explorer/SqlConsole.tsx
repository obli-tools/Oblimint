import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Prec, keymap, type EditorView } from '@uiw/react-codemirror';
import {
  AlertTriangle, BookMarked, CheckCircle2, Download, FileCode2, Gauge, History, ListChecks, Play, Save, Square, Trash2, XCircle,
} from 'lucide-react';
import type { DbFamily, DbxQueryResponse, DbxSavedQuery } from '@oblimint/shared';
import { DBX_MAX_QUERY_ROWS, DBX_STATEMENT_TIMEOUT_S } from '@oblimint/shared';
import { dbExplorerApi } from '@/api/dbExplorer.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { EmptyState } from '@/components/common/EmptyState';
import { IconButton } from '@/components/common/IconButton';
import { useConfirm, usePrompt } from '@/components/common/ConfirmDialog';
import { CodeEditor, type SqlEditorConfig } from '@/components/apps/CodeEditor';
import { ActionMenu } from '@/components/common/ActionMenu';
import { useAuthStore } from '@/store/authStore';
import { downloadUrl } from '@/utils/download';
import { DataGrid } from './DataGrid';
import { explorerError } from './TableDataTab';
import { statementAt } from './sqlRanges';
import { sqlTemplate, type TemplateId } from './sqlTemplates';

const HISTORY_MAX = 50;
const TIMEOUTS = [10, 30, 60, 120, 300];

/**
 * Console history: in the browser (localStorage), per panel user and database —
 * it holds literal values typed by the user (possibly personal data): it never
 * leaves the device and grows no table on the server. Saved queries, chosen
 * deliberately, are kept on the server (they follow the user).
 */
interface HistoryEntry { sql: string; at: number }
const historyKey = (userId: number | undefined, instanceId: number, dbId: number) => `oblimint.dbx.history.${userId ?? 0}.${instanceId}.${dbId}`;

function readHistory(key: string): HistoryEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(v) ? v.filter((h) => h && typeof h.sql === 'string').slice(0, HISTORY_MAX) : [];
  } catch { return []; }
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

/** Downloads a server export (CSV / JSON of one reading statement, run again read-only and streamed). */
export async function exportQuery(instanceId: number, dbId: number, sql: string, format: 'csv' | 'json'): Promise<void> {
  try {
    const tk = await dbExplorerApi.prepareExport(instanceId, dbId, { format, sql });
    await downloadUrl(tk.url, tk.filename);
  } catch (err) { toast.error(explorerError(err)); }
}

/**
 * SQL console: Ctrl+Enter runs the selection or the statement under the
 * cursor, Ctrl+Shift+Enter everything; EXPLAIN, cancel, time limit per run,
 * history (local) and saved queries (server), templates, autocomplete on the
 * tables / columns of the database. Statements run in order as the session's
 * SQL user and stop at the first error.
 */
export function SqlConsole({ instanceId, dbId, family, engine, initialSql, inject, onInjected, onSchemaChanged }: {
  instanceId: number;
  dbId: number;
  family: DbFamily;
  engine: string;
  initialSql: string;
  /** Text pushed into the editor from elsewhere (objects, templates): a new nonce replaces the content. */
  inject?: { sql: string; nonce: number } | null;
  /** The injected text was taken (the page forgets it: no replay on the next mount). */
  onInjected?: () => void;
  onSchemaChanged?: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const userId = useAuthStore((s) => s.user?.id);
  const hKey = historyKey(userId, instanceId, dbId);
  // The text being written survives a switch of view / table (this tab only).
  const draftKey = `oblimint.dbx.draft.${instanceId}.${dbId}`;
  const [sql, setSql] = useState(() => { try { return sessionStorage.getItem(draftKey) || initialSql; } catch { return initialSql; } });
  useEffect(() => { try { sessionStorage.setItem(draftKey, sql); } catch { /* storage off */ } }, [draftKey, sql]);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [res, setRes] = useState<DbxQueryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>(() => readHistory(hKey));
  const [timeoutS, setTimeoutS] = useState(DBX_STATEMENT_TIMEOUT_S);
  const [schema, setSchema] = useState<Record<string, string[]> | undefined>(undefined);
  const [saved, setSaved] = useState<DbxSavedQuery[] | null>(null);
  const [manageSaved, setManageSaved] = useState(false);
  const sqlRef = useRef(sql);
  sqlRef.current = sql;
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => { if (initialSql && !sqlRef.current.trim()) setSql(initialSql); }, [initialSql]);
  useEffect(() => { if (inject?.sql) { setSql(inject.sql); onInjected?.(); } }, [inject?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setHistory(readHistory(hKey)); }, [hKey]);

  const loadSchema = useCallback(() => {
    dbExplorerApi.schema(instanceId, dbId).then((s) => setSchema(s.tables)).catch(() => undefined);
  }, [instanceId, dbId]);
  const loadSaved = useCallback(() => {
    dbExplorerApi.savedQueries(instanceId, dbId).then(setSaved).catch(() => setSaved([]));
  }, [instanceId, dbId]);
  useEffect(() => { loadSchema(); loadSaved(); }, [loadSchema, loadSaved]);

  const sqlConfig = useMemo<SqlEditorConfig>(() => ({ dialect: family === 'postgresql' ? 'postgresql' : engine === 'mariadb' ? 'mariadb' : 'mysql', schema }), [family, engine, schema]);

  /** The selection, else the statement under the cursor, else everything. */
  const currentText = (): string => {
    const v = viewRef.current;
    const all = sqlRef.current;
    if (!v) return all.trim();
    const sel = v.state.selection.main;
    if (!sel.empty) return v.state.sliceDoc(sel.from, sel.to).trim();
    return statementAt(all, sel.head, family) ?? all.trim();
  };

  const run = async (text: string) => {
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
      const r = await dbExplorerApi.query(instanceId, dbId, text, timeoutS);
      setRes(r);
      const h = [{ sql: text, at: Date.now() }, ...history.filter((x) => x.sql !== text)].slice(0, HISTORY_MAX);
      setHistory(h);
      try { localStorage.setItem(hKey, JSON.stringify(h)); } catch { /* quota / private mode */ }
      if (r.results.some((x) => !x.columns && !x.error)) { onSchemaChanged?.(); loadSchema(); }
    } catch (err) {
      setError(explorerError(err));
    } finally {
      setBusy(false);
      setCancelling(false);
    }
  };

  const runCurrent = () => void run(currentText());
  const runAll = () => void run(sqlRef.current.trim());
  const explain = () => {
    const st = currentText();
    if (st) void run(`EXPLAIN ${st.replace(/;\s*$/, '')}`);
  };
  const cancel = async () => {
    setCancelling(true);
    try {
      if (!(await dbExplorerApi.cancel(instanceId, dbId))) toast(t('dbx.console.nothingToCancel') || 'Nothing to cancel (the statement may have just ended).', { icon: 'ℹ️' });
    } catch (err) { toast.error(explorerError(err)); setCancelling(false); }
  };

  const saveCurrent = async () => {
    const text = sqlRef.current.trim();
    if (!text) return;
    const name = await prompt({ title: t('dbx.saved.saveTitle') || 'Save the query', placeholder: t('dbx.saved.namePlaceholder') || 'Name', required: true, maxLength: 120 });
    if (!name) return;
    try {
      await dbExplorerApi.saveQuery(instanceId, dbId, { name, sql: text });
      toast.success(t('dbx.saved.saved') || 'Query saved');
      loadSaved();
    } catch (err) { toast.error(explorerError(err)); }
  };

  // Ctrl+Enter / Ctrl+Shift+Enter inside the editor (CodeMirror keymap: the editor owns its keys).
  const runRef = useRef({ runCurrent, runAll });
  runRef.current = { runCurrent, runAll };
  // Highest precedence: the default keymap binds Mod-Enter to « insert a blank line ».
  const keys = useMemo(() => [Prec.highest(keymap.of([
    { key: 'Mod-Enter', run: () => { runRef.current.runCurrent(); return true; } },
    { key: 'Mod-Shift-Enter', run: () => { runRef.current.runAll(); return true; } },
  ]))], []);

  const templates: Array<{ id: TemplateId; label: string }> = [
    { id: 'select', label: 'SELECT' }, { id: 'insert', label: 'INSERT' }, { id: 'update', label: 'UPDATE' }, { id: 'delete', label: 'DELETE' },
    { id: 'view', label: t('dbx.objects.kind.view') || 'View' },
    { id: 'procedure', label: t('dbx.objects.kind.procedure') || 'Procedure' },
    { id: 'function', label: t('dbx.objects.kind.function') || 'Function' },
    { id: 'trigger', label: t('dbx.objects.kind.trigger') || 'Trigger' },
    ...(family === 'mysql' ? [{ id: 'event' as const, label: t('dbx.objects.kind.event') || 'Event' }] : []),
  ];
  const menuBtn = 'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary';
  const statements = res ? [...new Set(res.results.map((r) => r.statement))] : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-white/[0.04] p-2">
        <CodeEditor value={sql} onChange={setSql} language="sql" minHeight="140px" maxHeight="40vh" ariaLabel="SQL" placeholder="SELECT * FROM …"
          sqlConfig={sqlConfig} extraExtensions={keys} onCreateEditor={(v) => { viewRef.current = v; }} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {busy ? (
            <Button size="sm" variant="danger" onClick={() => void cancel()} loading={cancelling}><Square className="mr-1.5 h-3.5 w-3.5" />{t('dbx.console.cancel') || 'Cancel'}</Button>
          ) : (
            <Button size="sm" onClick={runCurrent}><Play className="mr-1.5 h-3.5 w-3.5" />{t('dbx.console.run') || 'Run'}</Button>
          )}
          <Button size="sm" variant="secondary" onClick={runAll} disabled={busy}><ListChecks className="mr-1.5 h-3.5 w-3.5" />{t('dbx.console.runAll') || 'Run all'}</Button>
          <Button size="sm" variant="ghost" onClick={explain} disabled={busy}><Gauge className="mr-1.5 h-3.5 w-3.5" />EXPLAIN</Button>
          <label className="inline-flex items-center gap-1 text-[11px] text-text-muted" title={t('dbx.console.timeoutHint') || 'Time limit of each statement'}>
            <select value={timeoutS} onChange={(e) => setTimeoutS(Number(e.target.value))} className="rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-text-primary outline-none">
              {TIMEOUTS.map((s) => <option key={s} value={s}>{s} s</option>)}
            </select>
          </label>
          <span className="hidden text-[11px] text-text-muted md:inline">
            {t('dbx.console.keys') || 'Ctrl+Enter: selection or current statement · Ctrl+Shift+Enter: all'} · {t('dbx.console.limitRows', { rows: DBX_MAX_QUERY_ROWS, defaultValue: '{{rows}} rows max per result' })}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1">
            <ActionMenu label={t('dbx.console.templates') || 'Templates'} menuClassName="w-56"
              trigger={(p) => <button {...p} type="button" className={menuBtn}><FileCode2 className="h-3.5 w-3.5" />{t('dbx.console.templates') || 'Templates'}</button>}
              items={templates.map((x) => ({ key: x.id, label: x.label, onClick: () => setSql(sqlTemplate(family, x.id)) }))} />
            <ActionMenu label={t('dbx.saved.title') || 'Saved queries'} menuClassName="w-[min(420px,90vw)]"
              trigger={(p) => <button {...p} type="button" className={menuBtn}><BookMarked className="h-3.5 w-3.5" />{t('dbx.saved.title') || 'Saved queries'}{saved?.length ? ` (${saved.length})` : ''}</button>}
              items={[
                { key: '_save', icon: <Save className="h-4 w-4" />, label: t('dbx.saved.saveCurrent') || 'Save the current query…', onClick: () => void saveCurrent() },
                ...(saved ?? []).map((q) => ({ key: String(q.id), label: q.name, description: q.sql.replace(/\s+/g, ' ').slice(0, 80), onClick: () => setSql(q.sql) })),
                ...(saved?.length ? [{ key: '_manage', icon: <Trash2 className="h-4 w-4" />, label: t('dbx.saved.manage') || 'Manage…', onClick: () => setManageSaved(true), separator: true }] : []),
              ]} />
            {history.length > 0 && (
              <ActionMenu label={t('dbx.console.history') || 'History'} menuClassName="w-[min(520px,90vw)]"
                trigger={(p) => <button {...p} type="button" className={menuBtn}><History className="h-3.5 w-3.5" />{t('dbx.console.history') || 'History'}</button>}
                items={[
                  ...history.map((h, i) => ({ key: String(i), label: h.sql.replace(/\s+/g, ' ').slice(0, 120), description: new Date(h.at).toLocaleString(), onClick: () => setSql(h.sql) })),
                  { key: '_clear', icon: <Trash2 className="h-4 w-4" />, label: t('dbx.console.clearHistory') || 'Clear the history', danger: true, separator: true, onClick: () => { setHistory([]); try { localStorage.removeItem(hKey); } catch { /* */ } } },
                ]} />
            )}
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {error && <p className="text-sm text-status-down">{error}</p>}
        {!res && !error && <EmptyState icon={<Play />} text={t('dbx.console.empty') || 'Write a statement and press Ctrl+Enter.'} className="bg-transparent" />}
        {res?.results.map((r, i) => {
          const readable = r.columns && !r.resultSet && /^\s*(\(|select|with|show|table|values|explain|desc)/i.test(r.statement);
          return (
            <div key={i} className="overflow-hidden rounded-lg bg-bg-primary/40">
              <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-[12px]">
                {r.error ? <XCircle className="h-4 w-4 shrink-0 text-status-down" /> : r.truncated ? <AlertTriangle className="h-4 w-4 shrink-0 text-status-pending" /> : <CheckCircle2 className="h-4 w-4 shrink-0 text-status-up" />}
                {r.resultSet && <span className="rounded bg-bg-tertiary px-1.5 font-mono text-[10px] text-text-muted">#{r.resultSet}</span>}
                <code className="min-w-0 flex-1 truncate font-mono text-text-secondary" title={r.statement}>{r.statement.replace(/\s+/g, ' ')}</code>
                <span className="font-mono text-[11px] text-text-muted">
                  {r.columns ? t('dbx.console.rows', { count: r.rows?.length ?? 0, defaultValue: '{{count}} row(s)' }) : r.error ? '' : t('dbx.console.affected', { count: r.affectedRows ?? 0, defaultValue: '{{count}} row(s) affected' })}
                  {r.insertId ? ` · id ${r.insertId}` : ''} · {r.durationMs} ms
                </span>
                {readable && (
                  <ActionMenu label={t('dbx.export.title') || 'Export'}
                    trigger={(p) => <IconButton {...p} size="xs" label={t('dbx.export.result') || 'Export the whole result'} icon={<Download className="h-3.5 w-3.5" />} />}
                    items={[
                      { key: 'csv', label: 'CSV', description: t('dbx.export.resultHint') || 'Every row, run again read-only', onClick: () => void exportQuery(instanceId, dbId, r.statement, 'csv') },
                      { key: 'json', label: 'JSON', onClick: () => void exportQuery(instanceId, dbId, r.statement, 'json') },
                    ]} />
                )}
              </div>
              {r.error && <p className="border-t border-white/[0.04] px-3 py-2 font-mono text-[12px] text-status-down">{r.error}</p>}
              {r.truncated && <p className="border-t border-white/[0.04] px-3 py-1 text-[11px] text-status-pending">{t('dbx.console.truncated', { rows: DBX_MAX_QUERY_ROWS, defaultValue: 'Not every row is shown: at most {{rows}} rows per result and 8 MiB per run (add a LIMIT, or export the result).' })}</p>}
              {r.columns && r.rows && (
                <div className="flex max-h-[420px] min-h-0 flex-col border-t border-white/[0.04]">
                  <DataGrid columns={r.columns} rows={r.rows} emptyText={t('dbx.console.noRows') || 'No rows.'} />
                </div>
              )}
            </div>
          );
        })}
        {res?.stopped && <p className="text-[11px] text-text-muted">{t('dbx.console.stopped') || 'Execution stopped at the first error: the following statements were not run.'}</p>}
        {res && statements.length > 1 && <p className="text-[11px] text-text-muted">{t('dbx.console.statements', { count: statements.length, defaultValue: '{{count}} statement(s) run' })}</p>}
      </div>
      {manageSaved && saved && (
        <SavedQueriesModal instanceId={instanceId} dbId={dbId} saved={saved} onClose={() => setManageSaved(false)} onChanged={loadSaved} onLoad={(q) => { setSql(q); setManageSaved(false); }} />
      )}
    </div>
  );
}

function SavedQueriesModal({ instanceId, dbId, saved, onClose, onChanged, onLoad }: {
  instanceId: number; dbId: number; saved: DbxSavedQuery[]; onClose: () => void; onChanged: () => void; onLoad: (sql: string) => void;
}) {
  const { t } = useTranslation();
  const prompt = usePrompt();
  const confirm = useConfirm();
  const rename = async (q: DbxSavedQuery) => {
    const name = await prompt({ title: t('dbx.saved.rename') || 'Rename', defaultValue: q.name, required: true, maxLength: 120 });
    if (!name) return;
    try { await dbExplorerApi.updateQuery(instanceId, dbId, q.id, { name }); onChanged(); } catch (err) { toast.error(explorerError(err)); }
  };
  const remove = async (q: DbxSavedQuery) => {
    if (!(await confirm({ message: t('dbx.saved.deleteConfirm', { name: q.name, defaultValue: 'Delete the saved query {{name}}?' }), danger: true }))) return;
    try { await dbExplorerApi.deleteQuery(instanceId, dbId, q.id); onChanged(); } catch (err) { toast.error(explorerError(err)); }
  };
  return (
    <Modal open onClose={onClose} size="lg" title={t('dbx.saved.title') || 'Saved queries'} icon={<BookMarked className="h-4 w-4 text-accent" />}>
      <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
        {saved.map((q) => (
          <li key={q.id} className="flex items-center gap-2 rounded-lg bg-bg-primary/40 px-3 py-2">
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onLoad(q.sql)}>
              <div className="truncate text-sm text-text-primary">{q.name}</div>
              <div className="truncate font-mono text-[11px] text-text-muted">{q.sql.replace(/\s+/g, ' ')}</div>
            </button>
            <Button size="sm" variant="ghost" onClick={() => void rename(q)}>{t('dbx.saved.rename') || 'Rename'}</Button>
            <IconButton size="sm" variant="danger" label={t('common.delete') || 'Delete'} icon={<Trash2 className="h-4 w-4" />} onClick={() => void remove(q)} />
          </li>
        ))}
      </ul>
    </Modal>
  );
}
