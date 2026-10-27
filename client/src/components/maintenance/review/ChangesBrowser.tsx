import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronDown, ChevronRight, Cog, FileWarning, Folder, FolderOpen, Loader2, Lock, Search } from 'lucide-react';
import type { ChangeKind, WindowFile, WindowFileDiff } from '@oblimint/shared';
import { windowsApi } from '@/api/maintenance.api';
import { Button } from '@/components/common/Button';
import { MasterDetail } from '@/components/common/MasterDetail';
import { selectCls } from '@/components/hosting/hostingUi';
import { UnifiedDiff } from '@/components/sites/DiffViewer';
import { FileStatusIcon, Pill } from '@/components/sites/SiteBadges';
import { sectionLabelCls } from '@/components/sites/styles';
import { cn } from '@/utils/cn';
import {
  ChecksumBadge, LevelBadge, SeverityBadge, useChangeKindLabel, useEngineLabel, useIgnoreReasonLabel,
} from '../MaintenanceBadges';
import { buildFileTree, compactDir, defaultExpanded, fileName, formatBytes, riskTone, type TreeDir } from '../maintenanceFormat';
import { isNotImplemented, maintenanceErrorMessage } from '../maintenanceErrors';

/** Server maximum of one /files page. */
const PAGE = 500;
/** Files rendered per folder before a « show more » (keeps the DOM small on huge change sets). */
const FILES_PER_DIR = 200;

const MIN_RISK = [0, 1, 30, 70] as const;

/**
 * Filterable tree of the changed paths + detail pane (findings, diff).
 * canReadCode false (no files.manage nor releases.approve; staff: nor sites.manage): the diffs are
 * not requested (the server refuses them, codeReadForbidden), a notice instead.
 */
export function ChangesBrowser({ siteId, windowId, tick, canReadCode = true }: { siteId: number; windowId: number; tick: number; canReadCode?: boolean }) {
  const { t } = useTranslation();
  const changeLabel = useChangeKindLabel();
  const [change, setChange] = useState<ChangeKind | ''>('');
  const [minRisk, setMinRisk] = useState<number>(0);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [files, setFiles] = useState<WindowFile[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<WindowFile | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));

  // Search debounce.
  useEffect(() => {
    const id = window.setTimeout(() => setQ(search.trim()), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  const seq = useRef(0);
  const params = useMemo(() => ({ change: change || undefined, minRisk: minRisk || undefined, q: q || undefined }), [change, minRisk, q]);

  const load = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const res = await windowsApi.files(siteId, windowId, { ...params, limit: PAGE, offset: 0 });
      if (id !== seq.current) return;
      setFiles(res.items);
      setTotal(res.total);
      setError(null);
      // Reanalysis / filter change: the detail pane follows the fresh entry (or closes if it is gone).
      setSelected((cur) => (cur ? res.items.find((f) => f.path === cur.path) ?? null : null));
      setExpanded(defaultExpanded(buildFileTree(res.items)));
    } catch (err) {
      if (id !== seq.current) return;
      setFiles([]);
      setTotal(0);
      setError(isNotImplemented(err) ? (t('maintenance.notAvailable') || 'Not available on this server yet.') : maintenanceErrorMessage(err, t, t('windowReview.filesFailed') || 'Failed to load the changed files'));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [siteId, windowId, params, t]);
  useEffect(() => { void load(); }, [load, tick]);

  const loadMore = async () => {
    const id = seq.current;
    setLoadingMore(true);
    try {
      const res = await windowsApi.files(siteId, windowId, { ...params, limit: PAGE, offset: files.length });
      if (id !== seq.current) return;
      setFiles((cur) => [...cur, ...res.items]);
      setTotal(res.total);
    } catch (err) {
      setError(maintenanceErrorMessage(err, t));
    } finally {
      setLoadingMore(false);
    }
  };

  const tree = useMemo(() => buildFileTree(files), [files]);
  const toggle = useCallback((path: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);
  const expandAll = () => {
    const all = new Set<string>(['']);
    const walk = (d: TreeDir) => { all.add(d.path); d.dirs.forEach(walk); };
    walk(tree);
    setExpanded(all);
  };

  const minRiskLabel = (v: number) => ({
    0: t('windowReview.filter.anyRisk') || 'Any risk',
    1: t('windowReview.filter.risk1') || 'Some risk (≥ 1)',
    30: t('windowReview.filter.risk30') || 'Medium and more (≥ 30)',
    70: t('windowReview.filter.risk70') || 'High (≥ 70)',
  } as Record<number, string>)[v];

  const master = (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-0 flex-1 basis-48">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-text-muted" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('windowReview.filter.search') || 'Filter by path…'}
            maxLength={255}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            className="w-full rounded-md border border-bg-tertiary bg-bg-primary py-1.5 pl-8 pr-3 text-sm text-text-primary focus:border-accent focus:outline-none coarse:min-h-10"
          />
        </div>
        <select aria-label={t('windowReview.filter.change') || 'Change'} value={change} onChange={(e) => setChange(e.target.value as ChangeKind | '')} className={cn(selectCls, 'w-auto bg-bg-primary')}>
          <option value="">{t('windowReview.filter.allChanges') || 'All changes'}</option>
          {(['added', 'modified', 'deleted', 'typechange'] as const).map((k) => <option key={k} value={k}>{changeLabel(k)}</option>)}
        </select>
        <select aria-label={t('windowReview.filter.minRisk') || 'Minimum risk'} value={minRisk} onChange={(e) => setMinRisk(Number(e.target.value))} className={cn(selectCls, 'w-auto bg-bg-primary')}>
          {MIN_RISK.map((v) => <option key={v} value={v}>{minRiskLabel(v)}</option>)}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
        <span>{t('windowReview.shown', { shown: files.length, total, defaultValue: '{{shown}} / {{total}} path(s)' })}</span>
        {files.length > 0 && (
          <>
            <button type="button" onClick={expandAll} className="text-accent hover:underline">{t('windowReview.expandAll') || 'Expand all'}</button>
            <button type="button" onClick={() => setExpanded(new Set(['']))} className="text-accent hover:underline">{t('windowReview.collapseAll') || 'Collapse all'}</button>
          </>
        )}
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      </div>

      <div className="rounded-xl bg-bg-secondary p-2">
        {error ? (
          <p className="px-2 py-6 text-center text-sm text-text-muted">{error}</p>
        ) : !loading && files.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-text-muted">{q || change || minRisk ? (t('common.noMatch') || 'No match') : (t('windowReview.noFiles') || 'No changed file.')}</p>
        ) : (
          <div className="max-h-[70vh] overflow-auto overscroll-contain" role="tree" aria-label={t('windowReview.treeLabel') || 'Changed files'}>
            <DirChildren dir={tree} depth={0} expanded={expanded} onToggle={toggle} selected={selected?.path ?? null} onSelect={setSelected} />
          </div>
        )}
        {files.length < total && !error && (
          <div className="flex justify-center p-2">
            <Button size="sm" variant="secondary" loading={loadingMore} onClick={() => { void loadMore(); }}>
              {t('windowReview.loadMore', { count: Math.min(PAGE, total - files.length), defaultValue: 'Load {{count}} more' })}
            </Button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <MasterDetail
      master={master}
      detail={selected ? <FileDetail siteId={siteId} windowId={windowId} file={selected} canReadCode={canReadCode} /> : null}
      detailTitle={selected ? fileName(selected.path) : undefined}
      onBack={() => setSelected(null)}
      narrowMode="drawer"
      masterClassName="lg:w-[44%] lg:shrink-0"
      emptyDetail={(
        <div className="flex flex-col items-center gap-2 rounded-xl bg-bg-secondary px-4 py-16 text-center text-sm text-text-muted">
          <FileWarning className="h-6 w-6 opacity-40" />
          {t('windowReview.selectFile') || 'Select a file to see its findings and its diff.'}
        </div>
      )}
    />
  );
}

interface TreeProps {
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  selected: string | null;
  onSelect: (f: WindowFile) => void;
}

function DirChildren({ dir, ...p }: TreeProps & { dir: TreeDir }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const shown = all ? dir.files : dir.files.slice(0, FILES_PER_DIR);
  return (
    <ul role="group">
      {dir.dirs.map((d) => <DirRow key={d.path} dir={compactDir(d)} {...p} />)}
      {shown.map((f) => <FileRow key={f.path} file={f} depth={p.depth} selected={p.selected === f.path} onSelect={p.onSelect} />)}
      {!all && dir.files.length > FILES_PER_DIR && (
        <li style={{ paddingLeft: 8 + p.depth * 14 }}>
          <button type="button" onClick={() => setAll(true)} className="px-2 py-1 text-xs text-accent hover:underline">
            {t('windowReview.moreFiles', { count: dir.files.length - FILES_PER_DIR, defaultValue: 'Show {{count}} more file(s)' })}
          </button>
        </li>
      )}
    </ul>
  );
}

function DirRow({ dir, ...p }: TreeProps & { dir: TreeDir }) {
  const open = p.expanded.has(dir.path);
  const c = dir.counts;
  const tone = riskTone(c.maxLevel);
  return (
    <li role="treeitem" aria-expanded={open}>
      <button
        type="button"
        onClick={() => p.onToggle(dir.path)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] hover:bg-bg-hover coarse:min-h-9"
        style={{ paddingLeft: 8 + p.depth * 14 }}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />}
        {open ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-accent/80" /> : <Folder className="h-3.5 w-3.5 shrink-0 text-accent/80" />}
        <span className="min-w-0 flex-1 truncate font-mono text-text-primary">{dir.name}/</span>
        <span className="shrink-0 font-mono text-[10px] text-text-muted">
          {c.added > 0 && <span className="text-status-up">+{c.added} </span>}
          {c.modified > 0 && <span className="text-amber-400">~{c.modified} </span>}
          {c.deleted > 0 && <span className="text-red-400">−{c.deleted}</span>}
        </span>
        {tone !== 'muted' && <span className={cn('h-2 w-2 shrink-0 rounded-full', tone === 'red' ? 'bg-red-400' : 'bg-amber-400')} />}
      </button>
      {open && <DirChildren dir={dir} {...p} depth={p.depth + 1} />}
    </li>
  );
}

const FileRow = memo(function FileRow({ file, depth, selected, onSelect }: { file: WindowFile; depth: number; selected: boolean; onSelect: (f: WindowFile) => void }) {
  const { t } = useTranslation();
  const ignoreLabel = useIgnoreReasonLabel();
  return (
    <li role="treeitem" aria-selected={selected}>
      <button
        type="button"
        onClick={() => onSelect(file)}
        className={cn('flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] coarse:min-h-9', selected ? 'bg-accent/10' : 'hover:bg-bg-hover', file.ignored && 'opacity-60')}
        style={{ paddingLeft: 8 + depth * 14 + 18 }}
        title={file.path}
      >
        <FileStatusIcon status={file.change} />
        <span className={cn('min-w-0 flex-1 truncate font-mono', file.change === 'deleted' ? 'text-text-muted line-through' : 'text-text-secondary')}>{fileName(file.path)}</span>
        {file.executable && <span title={t('windowReview.counts.executable') || 'Executable'}><Cog className="h-3 w-3 shrink-0 text-orange-400" /></span>}
        {file.ignored && <Pill tone="muted" className="px-1.5 text-[10px]" title={file.ignoreReason ? ignoreLabel(file.ignoreReason) : undefined}>{t('windowReview.ignored') || 'ignored'}</Pill>}
        <ChecksumBadge status={file.checksum} compact />
        {file.findings.length > 0 && <span className="shrink-0 font-mono text-[10px] text-amber-400">⚑{file.findings.length}</span>}
        {file.level !== 'none' && <span className={cn('shrink-0 font-mono text-[10px]', riskTone(file.level) === 'red' ? 'text-red-400' : riskTone(file.level) === 'amber' ? 'text-amber-400' : 'text-text-muted')}>{file.risk}</span>}
      </button>
    </li>
  );
});

type DiffState = { loading: boolean; diff: WindowFileDiff | null; error: string | null };

/** Detail of a changed file: metadata, findings (engine, rule, severity, line), diff. */
function FileDetail({ siteId, windowId, file, canReadCode }: { siteId: number; windowId: number; file: WindowFile; canReadCode: boolean }) {
  const { t } = useTranslation();
  const engineLabel = useEngineLabel();
  const changeLabel = useChangeKindLabel();
  const ignoreLabel = useIgnoreReasonLabel();
  const [state, setState] = useState<DiffState>({ loading: true, diff: null, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, diff: null, error: null });
    if (file.type === 'dir' || !canReadCode) { setState({ loading: false, diff: null, error: null }); return undefined; }
    windowsApi.diff(siteId, windowId, file.path)
      .then((diff) => { if (!cancelled) setState({ loading: false, diff, error: null }); })
      .catch((err) => { if (!cancelled) setState({ loading: false, diff: null, error: maintenanceErrorMessage(err, t) }); });
    return () => { cancelled = true; };
  // `file` (not only its path): a reanalysis hands a fresh entry → findings of the diff refetched too.
  }, [siteId, windowId, file, canReadCode, t]);

  const d = state.diff;
  return (
    <div className="space-y-4 rounded-xl bg-bg-secondary p-4 max-lg:bg-transparent max-lg:p-0">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <FileStatusIcon status={file.change} />
          <code className="min-w-0 break-all font-mono text-sm text-text-primary">{file.path}</code>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Pill tone="muted">{changeLabel(file.change)}</Pill>
          {file.type !== 'file' && <Pill tone="muted">{file.type}</Pill>}
          {file.executable && <Pill tone="orange"><Cog className="h-3 w-3" />{t('windowReview.counts.executable') || 'Executable'}</Pill>}
          {file.binary && <Pill tone="muted">{t('windowReview.binary') || 'binary'}</Pill>}
          <ChecksumBadge status={file.checksum} />
          <LevelBadge level={file.level} />
          <span className="font-mono text-xs text-text-muted">{t('windowReview.score', { score: file.risk, defaultValue: 'score {{score}}' })}</span>
          {file.size != null && <span className="font-mono text-xs text-text-muted">{formatBytes(file.size)}</span>}
        </div>
        {file.ignored && (
          <p className="mt-2 flex items-start gap-2 rounded-lg bg-bg-tertiary/60 px-3 py-2 text-xs text-text-secondary">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-text-muted" />
            {t('windowReview.ignoredHint', { reason: file.ignoreReason ? ignoreLabel(file.ignoreReason) : '—', defaultValue: 'Not published ({{reason}}): this path stays out of the release.' })}
          </p>
        )}
      </div>

      <section>
        <div className={sectionLabelCls}>{t('windowReview.findings') || 'Findings'}</div>
        {file.findings.length === 0 ? (
          <p className="text-xs text-text-muted">{t('releases.scan.noFinding') || 'No finding.'}</p>
        ) : (
          <ul className="space-y-1">
            {file.findings.map((f, i) => (
              <li key={`${f.rule}:${i}`} className="rounded-lg bg-bg-tertiary/60 px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={f.severity} />
                  <Pill tone="muted">{engineLabel(f.engine)}</Pill>
                  <span className="font-mono text-text-muted">{f.rule}</span>
                  {f.line != null && <span className="font-mono text-text-muted">{t('windowReview.line', { line: f.line, defaultValue: 'line {{line}}' })}</span>}
                  {f.score != null && f.score > 0 && <span className="ml-auto font-mono text-text-muted">+{f.score}</span>}
                </div>
                <p className="mt-1 break-words text-text-secondary">{f.message}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className={sectionLabelCls}>{t('windowReview.diff') || 'Diff'}</div>
        <div className="overflow-hidden rounded-lg border border-border/60 bg-bg-primary/60">
          {!canReadCode ? (
            <p className="flex items-start gap-2 px-3 py-3 text-xs text-text-muted">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t('windowReview.diffHidden') || 'The content of the changed files needs the right to manage the files or to approve the releases.'}
            </p>
          ) : state.loading ? (
            <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-text-muted" /></div>
          ) : state.error ? (
            <p className="px-3 py-3 text-xs text-red-400">{state.error}</p>
          ) : !d ? (
            <p className="px-3 py-3 text-xs text-text-muted">—</p>
          ) : d.binary ? (
            <p className="px-3 py-3 text-xs text-text-muted">
              {t('windowReview.binaryDiff', { old: formatBytes(d.oldSize), new: formatBytes(d.newSize), defaultValue: 'Binary file: no textual diff ({{old}} → {{new}}).' })}
            </p>
          ) : (
            <UnifiedDiff patch={d.patch} truncated={d.patchTruncated} />
          )}
        </div>
      </section>
    </div>
  );
}
