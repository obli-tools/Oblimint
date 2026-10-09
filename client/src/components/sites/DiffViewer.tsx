import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronDown, ChevronRight, FileWarning, Loader2 } from 'lucide-react';
import type { Release, ReleaseDiff, ReleaseDiffFile } from '@oblimint/shared';
import { releasesApi } from '@/api/releases.api';
import { cn } from '@/utils/cn';
import { FileStatusIcon, Pill } from './SiteBadges';
import { parseUnifiedDiff, type DiffRow } from './diffParse';
import { siteErrorMessage } from './siteErrors';
import { fieldCls } from './styles';

type Against = number | 'previous' | 'empty';

interface PatchState {
  loading: boolean;
  patch: string | null;
  truncated: boolean;
  error: string | null;
}

export interface ReleaseDiffPanelProps {
  siteId: number;
  release: Release;
  /** Other releases of the site, offered as comparison bases. */
  releases: Release[];
}

/**
 * Diff of a release against the previous one / the empty tree / another
 * release: file list with +/− counts, each file's patch lazy-loaded on click.
 */
export function ReleaseDiffPanel({ siteId, release, releases }: ReleaseDiffPanelProps) {
  const { t } = useTranslation();
  const [against, setAgainst] = useState<Against>('previous');
  const [diff, setDiff] = useState<ReleaseDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [patches, setPatches] = useState<Record<string, PatchState>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setDiff(null);
    setOpen(new Set());
    setPatches({});
    releasesApi.diff(siteId, release.id, against)
      .then((d) => { if (!cancelled) setDiff(d); })
      .catch((err) => { if (!cancelled) setError(siteErrorMessage(err, t)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [siteId, release.id, against, t]);

  const loadPatch = useCallback(async (file: ReleaseDiffFile) => {
    setPatches((p) => ({ ...p, [file.path]: { loading: true, patch: null, truncated: false, error: null } }));
    try {
      const d = await releasesApi.diff(siteId, release.id, against, file.path);
      const f = d.files.find((x) => x.path === file.path) ?? d.files[0];
      setPatches((p) => ({ ...p, [file.path]: { loading: false, patch: f?.patch ?? null, truncated: !!f?.patchTruncated, error: null } }));
    } catch (err) {
      setPatches((p) => ({ ...p, [file.path]: { loading: false, patch: null, truncated: false, error: siteErrorMessage(err, t) } }));
    }
  }, [siteId, release.id, against, t]);

  const toggle = (file: ReleaseDiffFile) => {
    const next = new Set(open);
    if (next.has(file.path)) {
      next.delete(file.path);
    } else {
      next.add(file.path);
      if (!file.binary && file.patch == null && !patches[file.path]) void loadPatch(file);
    }
    setOpen(next);
  };

  const others = useMemo(
    () => releases.filter((r) => r.id !== release.id && r.commitSha).sort((a, b) => b.number - a.number),
    [releases, release.id],
  );

  const totals = useMemo(() => {
    if (!diff) return null;
    return diff.files.reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), { add: 0, del: 0 });
  }, [diff]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-text-muted" htmlFor="diff-against">{t('releases.diff.compareWith') || 'Compare with'}</label>
        <select
          id="diff-against"
          value={String(against)}
          onChange={(e) => {
            const v = e.target.value;
            setAgainst(v === 'previous' || v === 'empty' ? v : Number(v));
          }}
          className={cn(fieldCls, 'w-auto min-w-[12rem] py-1.5')}
        >
          <option value="previous">{t('releases.diff.previous') || 'Previous release'}</option>
          <option value="empty">{t('releases.diff.empty') || 'Empty (all files)'}</option>
          {others.map((r) => (
            <option key={r.id} value={r.id}>#{r.number}{r.message ? ` — ${r.message.slice(0, 40)}` : ''}</option>
          ))}
        </select>
        {diff && totals && (
          <span className="ml-auto font-mono text-xs text-text-muted">
            {t('releases.diff.filesCount', { count: diff.totalFiles, defaultValue: '{{count}} file(s)' })}
            {' · '}<span className="text-status-up">+{totals.add}</span>{' '}<span className="text-red-400">−{totals.del}</span>
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-text-muted"><Loader2 className="h-4 w-4 animate-spin" />{t('common.loading') || 'Loading...'}</div>
      ) : error ? (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">{error}</p>
      ) : diff && diff.files.length === 0 ? (
        <p className="py-2 text-sm text-text-muted">{t('releases.diff.noChange') || 'No difference.'}</p>
      ) : diff && (
        <div className="space-y-1">
          {diff.files.map((f) => {
            const isOpen = open.has(f.path);
            const state = patches[f.path];
            const patch = f.patch ?? state?.patch ?? null;
            // In the file list, patchTruncated only means "not inlined": once
            // the patch was fetched with ?file=, its own flag is authoritative.
            const truncated = state ? state.truncated : !!f.patchTruncated;
            return (
              <div key={`${f.status}:${f.oldPath ?? ''}:${f.path}`} className="overflow-hidden rounded-lg bg-bg-tertiary/50">
                <button
                  type="button"
                  onClick={() => toggle(f)}
                  aria-expanded={isOpen}
                  className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-bg-hover coarse:min-h-10"
                >
                  {isOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />}
                  <FileStatusIcon status={f.status} />
                  <span className="min-w-0 flex-1 truncate font-mono text-text-primary" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                    {f.oldPath && f.status === 'renamed' ? (<><span className="text-text-muted">{f.oldPath}</span> → {f.path}</>) : f.path}
                  </span>
                  {f.binary ? (
                    <Pill tone="muted" className="text-[10px]">{t('releases.diff.binary') || 'binary'}</Pill>
                  ) : (
                    <span className="shrink-0 font-mono tabular-nums">
                      <span className="text-status-up">+{f.additions}</span>{' '}
                      <span className="text-red-400">−{f.deletions}</span>
                    </span>
                  )}
                </button>
                {isOpen && (
                  <div className="border-t border-border/60">
                    {f.binary ? (
                      <p className="flex items-center gap-2 px-3 py-3 text-xs text-text-muted">
                        <FileWarning className="h-3.5 w-3.5" />{t('releases.diff.binaryNotice') || 'Binary file: no textual diff.'}
                      </p>
                    ) : state?.loading ? (
                      <p className="flex items-center gap-2 px-3 py-3 text-xs text-text-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('common.loading') || 'Loading...'}</p>
                    ) : state?.error ? (
                      <p className="px-3 py-3 text-xs text-red-400">{state.error}</p>
                    ) : (
                      <UnifiedDiff patch={patch} truncated={truncated} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {diff.truncated && (
            <p className="flex items-center gap-2 px-1 pt-1 text-xs text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t('releases.diff.listTruncated', { shown: diff.files.length, total: diff.totalFiles, defaultValue: 'Only {{shown}} of {{total}} files are listed.' })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const ROW_CLS: Record<DiffRow['kind'], string> = {
  hunk: 'bg-blue-500/10 text-blue-400',
  add: 'bg-status-up/10 text-text-primary',
  del: 'bg-red-500/10 text-text-primary',
  ctx: 'text-text-secondary',
  note: 'text-text-muted italic',
};

const GUTTER_CLS: Record<DiffRow['kind'], string> = {
  hunk: 'bg-blue-500/10',
  add: 'bg-status-up/15 text-status-up/80',
  del: 'bg-red-500/15 text-red-400/80',
  ctx: '',
  note: '',
};

const SIGN: Record<DiffRow['kind'], string> = { hunk: '', add: '+', del: '−', ctx: ' ', note: '' };

/** Hand-made unified diff renderer: old / new line gutters, coloured rows, horizontal scroll. */
export function UnifiedDiff({ patch, truncated = false }: { patch: string | null; truncated?: boolean }) {
  const { t } = useTranslation();
  const parsed = useMemo(() => parseUnifiedDiff(patch), [patch]);

  if (!patch || parsed.rows.length === 0) {
    return <p className="px-3 py-3 text-xs text-text-muted">{t('releases.diff.noPatch') || 'No textual change to show (empty file, mode or rename only).'}</p>;
  }

  return (
    <div>
      <div className="max-h-[60vh] overflow-auto overscroll-contain">
        <table className="w-full border-collapse font-mono text-[12px] leading-[1.45]">
          <tbody>
            {parsed.rows.map((r, i) => (
              <tr key={i} className={ROW_CLS[r.kind]}>
                {r.kind === 'hunk' ? (
                  <td colSpan={4} className="whitespace-pre px-3 py-0.5 text-[11px]">{r.text}</td>
                ) : (
                  <>
                    <td className={cn('w-px select-none whitespace-nowrap px-2 text-right tabular-nums text-text-muted/70', GUTTER_CLS[r.kind])}>{r.oldNo ?? ''}</td>
                    <td className={cn('w-px select-none whitespace-nowrap px-2 text-right tabular-nums text-text-muted/70', GUTTER_CLS[r.kind])}>{r.newNo ?? ''}</td>
                    <td className={cn('w-px select-none pl-2 pr-1', r.kind === 'add' && 'text-status-up', r.kind === 'del' && 'text-red-400')}>{SIGN[r.kind]}</td>
                    <td className="whitespace-pre pr-4">{r.kind === 'note' ? `\\ ${r.text}` : (r.text || ' ')}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated && (
        <p className="flex items-center gap-2 border-t border-border/60 px-3 py-2 text-xs text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5" />{t('releases.diff.patchTruncated') || 'Patch truncated: the file has too many changes to be shown in full.'}
        </p>
      )}
    </div>
  );
}
