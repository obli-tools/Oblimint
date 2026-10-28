import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { CheckCircle2, Download, Square, Upload, XCircle } from 'lucide-react';
import type { DbxExportFormat, DbxImportStatus, DbxTable, DbxTableInfo } from '@oblimint/shared';
import { dbxTransactionalEngine } from '@oblimint/shared';
import { dbExplorerApi } from '@/api/dbExplorer.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { Pill } from '@/components/common/Pill';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { formatBytes } from '@/components/usage/usageFormat';
import { downloadUrl } from '@/utils/download';
import { explorerError } from './TableDataTab';

const inputCls = 'w-full rounded-lg bg-bg-tertiary px-2.5 py-1.5 text-[13px] text-text-primary outline-none ring-1 ring-white/[0.06] focus:ring-accent';
const labelCls = 'mb-1 block text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted';
const check = 'accent-[rgb(var(--c-accent))]';
type Delim = ',' | ';' | '\t';
const DELIMS: Array<{ v: Delim; label: string }> = [{ v: ',', label: ', (virgule / comma)' }, { v: ';', label: '; (point-virgule / semicolon)' }, { v: '\t', label: 'Tab' }];

/**
 * Export of the database or of tables: SQL (the engine's own dump tool, as the
 * session's SQL user: structure and / or data, re-importable), CSV or JSON of
 * one table. The browser downloads a one-shot link: the file streams, nothing
 * is held in memory.
 */
export function ExportModal({ instanceId, dbId, tables, preset, onClose }: {
  instanceId: number; dbId: number; tables: DbxTable[]; preset?: string[]; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<DbxExportFormat>('sql');
  const [chosen, setChosen] = useState<Set<string>>(new Set(preset ?? []));
  const [structure, setStructure] = useState(true);
  const [data, setData] = useState(true);
  const [routines, setRoutines] = useState(true);
  const [gzip, setGzip] = useState(true);
  const [delimiter, setDelimiter] = useState<Delim>(',');
  const [header, setHeader] = useState(true);
  const [one, setOne] = useState(preset?.[0] ?? tables.find((x) => x.kind === 'table')?.id ?? '');
  const [busy, setBusy] = useState(false);
  const whole = chosen.size === 0;

  const go = async () => {
    setBusy(true);
    try {
      const tk = await dbExplorerApi.prepareExport(instanceId, dbId, format === 'sql'
        ? { format, tables: [...chosen], structure, data, routines, gzip }
        : { format, tables: [one], gzip, csvDelimiter: delimiter, csvHeader: header });
      if (await downloadUrl(tk.url, tk.filename)) {
        toast.success(t('dbx.export.started', { name: tk.filename, defaultValue: 'Download started: {{name}}' }));
        onClose();
      }
    } catch (err) { toast.error(explorerError(err)); } finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} size="lg" title={t('dbx.export.title') || 'Export'} icon={<Download className="h-4 w-4 text-accent" />}
      footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>{t('common.cancel') || 'Cancel'}</Button>
        <Button loading={busy} disabled={format === 'sql' ? !structure && !data : !one} onClick={() => void go()}><Download className="mr-1.5 h-4 w-4" />{t('dbx.export.download') || 'Download'}</Button></div>}>
      <div className="space-y-4">
        <SegmentedTabs tabs={[{ id: 'sql', label: 'SQL' }, { id: 'csv', label: 'CSV' }, { id: 'json', label: 'JSON' }]} value={format} onChange={(v) => setFormat(v as DbxExportFormat)} />
        {format === 'sql' ? (
          <>
            <p className="text-xs text-text-muted">{t('dbx.export.sqlHint') || 'Dump made by the engine\'s own tool, re-importable here or with any client. Run as the temporary SQL user of this session.'}</p>
            <div className="flex flex-wrap gap-4 text-sm text-text-secondary">
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={structure} onChange={(e) => setStructure(e.target.checked)} className={check} />{t('dbx.export.structure') || 'Structure'}</label>
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={data} onChange={(e) => setData(e.target.checked)} className={check} />{t('dbx.export.data') || 'Data'}</label>
              {whole && <label className="inline-flex items-center gap-2"><input type="checkbox" checked={routines} onChange={(e) => setRoutines(e.target.checked)} className={check} />{t('dbx.export.routines') || 'Routines, triggers, events'}</label>}
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={gzip} onChange={(e) => setGzip(e.target.checked)} className={check} />gzip</label>
            </div>
            <div>
              <div className="mb-1 flex items-center gap-2">
                <span className={labelCls}>{t('dbx.export.tables') || 'Tables'}</span>
                <Pill tone={whole ? 'accent' : 'muted'}>{whole ? (t('dbx.export.whole') || 'whole database') : t('dbx.export.selected', { count: chosen.size, defaultValue: '{{count}} selected' })}</Pill>
                {!whole && <button type="button" className="text-[11px] text-accent hover:underline" onClick={() => setChosen(new Set())}>{t('dbx.export.all') || 'All'}</button>}
              </div>
              <div className="max-h-56 overflow-y-auto rounded-lg bg-bg-primary/40 p-2">
                {tables.map((x) => (
                  <label key={x.id} className="flex items-center gap-2 px-1 py-0.5 font-mono text-[12px] text-text-secondary">
                    <input type="checkbox" checked={chosen.has(x.id)} onChange={(e) => { const n = new Set(chosen); if (e.target.checked) n.add(x.id); else n.delete(x.id); setChosen(n); }} className={check} />
                    {x.id}{x.kind === 'view' && <span className="text-[10px] text-sky-400">view</span>}
                  </label>
                ))}
              </div>
            </div>
          </>
        ) : (
          <>
            <div>
              <label className={labelCls}>{t('dbx.export.table') || 'Table'}</label>
              <select value={one} onChange={(e) => setOne(e.target.value)} className={`${inputCls} font-mono`}>{tables.map((x) => <option key={x.id} value={x.id}>{x.id}</option>)}</select>
            </div>
            {format === 'csv' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div><label className={labelCls}>{t('dbx.csv.delimiter') || 'Delimiter'}</label>
                  <select value={delimiter} onChange={(e) => setDelimiter(e.target.value as Delim)} className={inputCls}>{DELIMS.map((d) => <option key={d.label} value={d.v}>{d.label}</option>)}</select></div>
                <label className="mt-5 inline-flex items-center gap-2 text-sm text-text-secondary"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} className={check} />{t('dbx.csv.header') || 'Column names on the first line'}</label>
              </div>
            )}
            <label className="inline-flex items-center gap-2 text-sm text-text-secondary"><input type="checkbox" checked={gzip} onChange={(e) => setGzip(e.target.checked)} className={check} />gzip</label>
            <p className="text-xs text-text-muted">{t('dbx.export.rowsHint') || 'Every row, streamed. Binary values are written as 0x… (hexadecimal), read back the same way by the CSV import.'}</p>
          </>
        )}
      </div>
    </Modal>
  );
}

/** First record of a CSV file (header), quotes understood. */
function firstCsvLine(text: string, d: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === d) { out.push(cur); cur = ''; } else if (c === '\n' || c === '\r') break;
    else cur += c;
  }
  out.push(cur);
  return out.map((s, i) => (i === 0 ? s.replace(/^﻿/, '') : s));
}

/**
 * Import of an .sql / .sql.gz file (statement by statement, as the session's
 * SQL user; stops at the first error unless « continue ») or of a CSV file into
 * a table (columns mapped, one transaction). Progress is polled while the file
 * uploads and runs.
 */
export function ImportModal({ instanceId, dbId, tables, presetTable, maxBytes, onClose, onDone }: {
  instanceId: number; dbId: number; tables: DbxTable[]; presetTable?: string; maxBytes: number; onClose: () => void; onDone: () => void;
}) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<'sql' | 'csv'>(presetTable ? 'csv' : 'sql');
  const [file, setFile] = useState<File | null>(null);
  const [continueOnError, setContinueOnError] = useState(false);
  const [table, setTable] = useState(presetTable ?? tables.find((x) => x.kind === 'table')?.id ?? '');
  const [tableInfo, setTableInfo] = useState<DbxTableInfo | null>(null);
  const [delimiter, setDelimiter] = useState<Delim>(',');
  const [header, setHeader] = useState(true);
  const [emptyNull, setEmptyNull] = useState(false);
  const [fileCols, setFileCols] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Array<string | null>>([]);
  const [sent, setSent] = useState(0);
  const [status, setStatus] = useState<DbxImportStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const poll = useRef<number | null>(null);

  useEffect(() => {
    if (format !== 'csv' || !table) { setTableInfo(null); return; }
    dbExplorerApi.table(instanceId, dbId, table).then(setTableInfo).catch((err) => setError(explorerError(err)));
  }, [instanceId, dbId, table, format]);

  useEffect(() => {
    if (format !== 'csv' || !file || !tableInfo) return;
    let live = true;
    file.slice(0, 64 * 1024).text().then((txt) => {
      if (!live) return;
      const cols = firstCsvLine(txt, delimiter);
      setFileCols(cols);
      const names = tableInfo.columns.map((c) => c.name);
      setMapping(cols.map((c, i) => (header ? (names.find((n) => n.toLowerCase() === c.trim().toLowerCase()) ?? null) : (names[i] ?? null))));
    }).catch(() => undefined);
    return () => { live = false; };
  }, [file, tableInfo, delimiter, header, format]);

  useEffect(() => () => { if (poll.current) window.clearInterval(poll.current); }, []);

  const tooBig = !!file && file.size > maxBytes;
  const csvReady = format !== 'csv' || (!!tableInfo && mapping.some((m) => m !== null));
  const start = async () => {
    if (!file) return;
    setRunning(true);
    setError(null);
    setStatus(null);
    setSent(0);
    poll.current = window.setInterval(() => { dbExplorerApi.importStatus(instanceId, dbId).then((s) => { if (s?.state === 'running') setStatus(s); }).catch(() => undefined); }, 1000);
    try {
      const s = await dbExplorerApi.startImport(instanceId, dbId, file, format === 'sql'
        ? { format, continueOnError }
        : { format, table, csvDelimiter: delimiter, csvHeader: header, columns: mapping, csvEmptyNull: emptyNull, continueOnError }, setSent);
      setStatus(s);
      onDone();
    } catch (err) {
      setError(explorerError(err));
    } finally {
      if (poll.current) window.clearInterval(poll.current);
      poll.current = null;
      setRunning(false);
    }
  };
  const stop = () => { void dbExplorerApi.cancelImport(instanceId, dbId).catch(() => undefined); };
  const pct = file?.size ? Math.min(100, Math.round(((status?.bytesRead ?? sent) / file.size) * 100)) : 0;
  const done = status && status.state !== 'running';
  const stateTone = useMemo(() => (status?.state === 'done' ? (status.errorCount ? 'amber' : 'green') : status?.state === 'failed' ? 'red' : 'muted'), [status]);

  return (
    <Modal open onClose={() => { if (!running) onClose(); }} dismissible={!running} size="xl" title={t('dbx.import.title') || 'Import'} icon={<Upload className="h-4 w-4 text-accent" />}
      footer={(
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {running ? <Button variant="danger" onClick={stop}><Square className="mr-1.5 h-4 w-4" />{t('dbx.import.stop') || 'Stop'}</Button>
            : <Button variant="secondary" onClick={onClose}>{done ? (t('common.close') || 'Close') : (t('common.cancel') || 'Cancel')}</Button>}
          {!running && <Button disabled={!file || tooBig || !csvReady} onClick={() => void start()}><Upload className="mr-1.5 h-4 w-4" />{t('dbx.import.start') || 'Import'}</Button>}
        </div>
      )}>
      <div className="space-y-4">
        <SegmentedTabs tabs={[{ id: 'sql', label: 'SQL' }, { id: 'csv', label: 'CSV' }]} value={format} onChange={(v) => { if (!running) setFormat(v as 'sql' | 'csv'); }} />
        <div>
          <label className={labelCls}>{t('dbx.import.file') || 'File'}</label>
          <input type="file" accept={format === 'sql' ? '.sql,.gz,.txt' : '.csv,.txt,.tsv,.gz'} disabled={running} onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-text-secondary file:mr-3 file:rounded-lg file:border-0 file:bg-bg-tertiary file:px-3 file:py-1.5 file:text-text-primary" />
          <p className="mt-1 text-[11px] text-text-muted">
            {file && `${formatBytes(file.size)} · `}{t('dbx.import.max', { size: formatBytes(maxBytes), defaultValue: 'At most {{size}}, uncompressed (gzip accepted).' })}
            {tooBig && <span className="ml-1 text-status-down">{t('dbx.import.tooBig') || 'Too large: split the file, or ask the platform administrator.'}</span>}
          </p>
        </div>
        {format === 'sql' ? (
          <p className="text-xs text-text-muted">{t('dbx.import.sqlHint') || 'Statements run one by one as the temporary SQL user of this session (DELIMITER, mysqldump and pg_dump files understood). Back the database up first: there is no undo.'}</p>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div><label className={labelCls}>{t('dbx.export.table') || 'Table'}</label>
                <select value={table} onChange={(e) => setTable(e.target.value)} disabled={running} className={`${inputCls} font-mono`}>{tables.filter((x) => x.kind === 'table').map((x) => <option key={x.id} value={x.id}>{x.id}</option>)}</select></div>
              <div><label className={labelCls}>{t('dbx.csv.delimiter') || 'Delimiter'}</label>
                <select value={delimiter} onChange={(e) => setDelimiter(e.target.value as Delim)} disabled={running} className={inputCls}>{DELIMS.map((d) => <option key={d.label} value={d.v}>{d.label}</option>)}</select></div>
            </div>
            <div className="flex flex-wrap gap-4 text-sm text-text-secondary">
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} className={check} />{t('dbx.csv.header') || 'Column names on the first line'}</label>
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={emptyNull} onChange={(e) => setEmptyNull(e.target.checked)} className={check} />{t('dbx.csv.emptyNull') || 'Empty field = NULL'}</label>
            </div>
            {fileCols.length > 0 && tableInfo && (
              <div>
                <label className={labelCls}>{t('dbx.csv.mapping') || 'Columns'}</label>
                <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg bg-bg-primary/40 p-2">
                  {fileCols.map((c, i) => (
                    <div key={i} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-[12px]">
                      <span className="truncate font-mono text-text-secondary">{header ? c || `#${i + 1}` : `#${i + 1} (${c.slice(0, 20)})`}</span>
                      <span className="text-text-muted">→</span>
                      <select value={mapping[i] ?? ''} onChange={(e) => setMapping(mapping.map((m, k) => (k === i ? (e.target.value || null) : m)))} className={`${inputCls} py-1 font-mono`}>
                        <option value="">{t('dbx.csv.skip') || '(skip)'}</option>
                        {tableInfo.columns.map((col) => <option key={col.name} value={col.name}>{col.name}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <p className="text-xs text-text-muted">{t('dbx.import.csvHint') || 'One transaction: on an error nothing is kept (unless « continue », where the faulty rows are skipped and listed).'}</p>
            {(() => {
              const engine = tables.find((x) => x.id === table)?.engine ?? null;
              return engine && !dbxTransactionalEngine(engine) ? (
                <p className="text-xs text-status-pending">{t('dbx.import.notTransactional', { engine, defaultValue: '{{engine}} table: not transactional. On an error, the rows already inserted are kept (nothing is rolled back).' })}</p>
              ) : null;
            })()}
          </div>
        )}
        <label className="inline-flex items-center gap-2 text-sm text-text-secondary"><input type="checkbox" checked={continueOnError} disabled={running} onChange={(e) => setContinueOnError(e.target.checked)} className={check} />{t('dbx.import.continue') || 'Continue after an error (errors listed)'}</label>

        {(running || status) && (
          <div className="space-y-2 rounded-lg bg-bg-primary/40 p-3">
            <div className="h-1.5 overflow-hidden rounded-full bg-bg-tertiary"><div className="h-full bg-accent transition-all" style={{ width: `${done ? 100 : pct}%` }} /></div>
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-text-secondary">
              {status && <Pill tone={stateTone}>{t(`dbx.import.state.${status.state}`, { defaultValue: status.state })}</Pill>}
              <span className="font-mono">{formatBytes(status?.bytesRead ?? sent)}{file ? ` / ${formatBytes(file.size)}` : ''}</span>
              {status && <span>{t('dbx.import.counts', { statements: status.statements, rows: status.rows, defaultValue: '{{statements}} statement(s) · {{rows}} row(s)' })}</span>}
              {!!status?.errorCount && <span className="text-status-down">{t('dbx.import.errors', { count: status.errorCount, defaultValue: '{{count}} error(s)' })}</span>}
            </div>
            {status?.message && <p className="text-[12px] text-text-muted">{status.message}</p>}
            {status?.errors.map((e, i) => (
              <div key={i} className="rounded bg-status-down/10 px-2 py-1.5 text-[12px]">
                <div className="flex items-center gap-1.5 text-status-down"><XCircle className="h-3.5 w-3.5" />{e.line > 0 && t('dbx.import.line', { line: e.line, defaultValue: 'line {{line}}' })}: {e.error}</div>
                {e.statement && <code className="mt-1 block truncate font-mono text-[11px] text-text-muted" title={e.statement}>{e.statement}</code>}
              </div>
            ))}
            {status?.state === 'done' && !status.errorCount && <div className="flex items-center gap-1.5 text-[12px] text-status-up"><CheckCircle2 className="h-3.5 w-3.5" />{t('dbx.import.ok') || 'Import complete'}</div>}
          </div>
        )}
        {error && <p className="text-sm text-status-down">{error}</p>}
      </div>
    </Modal>
  );
}
