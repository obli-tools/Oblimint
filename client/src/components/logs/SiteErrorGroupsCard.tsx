import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Bug, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import type { Site, SiteErrorClass, SiteErrorGroup, SiteErrorGroupDetail, SiteErrorLevel, SiteErrorList } from '@oblimint/shared';
import { logsApi } from '@/api/cronLogs.api';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import type { Tone } from '@/components/common/Pill';
import { Card, Pill, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { opsErrorMessage } from '@/components/usage/opsErrors';
import { cn } from '@/utils/cn';

const LEVEL_TONE: Record<SiteErrorLevel, Tone> = { fatal: 'red', parse: 'red', warning: 'amber', notice: 'muted', deprecated: 'muted' };
const LEVEL_LABEL: Record<SiteErrorLevel, string> = { fatal: 'Fatal', parse: 'Parse', warning: 'Warning', notice: 'Notice', deprecated: 'Deprecated' };
const LEVEL_FILTERS = ['', 'fatal,parse', 'warning', 'notice,deprecated'] as const;
type LevelFilter = typeof LEVEL_FILTERS[number];

/**
 * PHP errors of the site grouped by release (Site > Logs & observation):
 * one row per fingerprint and release (level, message, file:line, count, last
 * seen, « new » in that release), the summary per release as filter chips,
 * the immutable-model explanation (read-only code, refused execution) and,
 * on a row, the last occurrence with its stack.
 */
export function SiteErrorGroupsCard({ site }: { site: Site }) {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<SiteErrorList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [releaseId, setReleaseId] = useState<number | null>(null);
  const [newOnly, setNewOnly] = useState(false);
  const [level, setLevel] = useState<LevelFilter>('');
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await logsApi.errors(site.id, { releaseId: releaseId ?? undefined, newOnly, level: level || undefined, limit: 100 }));
      setError(null);
    } catch (err) {
      setError(opsErrorMessage(t, err, 'siteErrors', t('siteErrors.loadFailed') || 'Failed to load the PHP errors'));
    } finally {
      setLoading(false);
    }
  }, [site.id, releaseId, newOnly, level, t]);
  useEffect(() => { void load(); }, [load]);

  const when = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(i18n.language, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };
  const releaseLabel = (n: number) => (n > 0 ? `#${n}` : (t('siteErrors.unknownRelease') || 'unknown'));

  return (
    <Card
      title={t('siteErrors.title') || 'PHP errors by release'}
      icon={<Bug size={14} className="text-accent" />}
      actions={<IconButton label={t('siteErrors.refresh') || 'Refresh'} icon={<RefreshCw size={14} className={cn(loading && 'animate-spin')} />} onClick={() => { void load(); }} />}
    >
      <p className="mb-3 text-xs text-text-muted">
        {t('siteErrors.subtitle') || 'Errors, warnings and fatals of the live containers, grouped by message and file:line, attributed to the release that served them. Collected every minute.'}
      </p>

      {data && data.releases.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          <ReleaseChip active={releaseId === null} onClick={() => setReleaseId(null)}>
            {t('siteErrors.allReleases') || 'All releases'}
          </ReleaseChip>
          {data.releases.map((r) => (
            <ReleaseChip key={r.releaseNumber} active={releaseId !== null && releaseId === r.releaseId} disabled={r.releaseId === null} onClick={() => r.releaseId !== null && setReleaseId(r.releaseId)}>
              <span className="font-mono">{releaseLabel(r.releaseNumber)}</span>
              {r.live && <Pill tone="green">{t('siteErrors.live') || 'live'}</Pill>}
              <span className="text-text-muted">{t('siteErrors.groupCount', { count: r.groups, defaultValue: '{{count}} error(s)' })}</span>
              {r.fatals > 0 && <Pill tone="red">{t('siteErrors.fatalCount', { count: r.fatals, defaultValue: '{{count}} fatal' })}</Pill>}
              {r.newGroups > 0 && r.releaseNumber > 0 && <Pill tone="accent">{t('siteErrors.newCount', { count: r.newGroups, defaultValue: '{{count}} new' })}</Pill>}
            </ReleaseChip>
          ))}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="w-48">
          <label className={labelCls} htmlFor="site-errors-level">{t('siteErrors.level') || 'Level'}</label>
          <select id="site-errors-level" value={level} onChange={(e) => setLevel(e.target.value as LevelFilter)} className={selectCls}>
            <option value="">{t('siteErrors.levels.all') || 'All levels'}</option>
            <option value="fatal,parse">{t('siteErrors.levels.fatal') || 'Fatal and parse'}</option>
            <option value="warning">{t('siteErrors.levels.warning') || 'Warnings'}</option>
            <option value="notice,deprecated">{t('siteErrors.levels.notice') || 'Notices and deprecations'}</option>
          </select>
        </div>
        <ToggleSwitch checked={newOnly} onChange={setNewOnly} label={<span className="text-sm">{t('siteErrors.newOnly') || 'New in their release only'}</span>} />
        {data?.collectedAt && (
          <span className="ml-auto text-[11px] font-mono text-text-muted">
            {t('siteErrors.collectedAt', { at: when(data.collectedAt), defaultValue: 'collected {{at}}' })}
          </span>
        )}
      </div>

      {data === null && loading ? (
        <div className="flex justify-center py-6"><LoadingSpinner size="sm" /></div>
      ) : error ? (
        <p className="text-xs text-status-down">{error}</p>
      ) : !data || data.groups.length === 0 ? (
        <p className="text-xs text-text-muted">
          {releaseId !== null || newOnly || level
            ? (t('siteErrors.emptyFiltered') || 'No PHP error for these filters.')
            : (t('siteErrors.empty') || 'No PHP error recorded for this site.')}
        </p>
      ) : (
        <>
          <ul className="divide-y divide-border rounded-lg bg-bg-tertiary">
            {data.groups.map((g) => (
              <ErrorRow key={g.id} siteId={site.id} group={g} open={open === g.id} onToggle={() => setOpen(open === g.id ? null : g.id)} when={when} releaseLabel={releaseLabel} />
            ))}
          </ul>
          {data.total > data.groups.length && (
            <p className="mt-2 text-[11px] font-mono text-text-muted">
              {t('siteErrors.more', { shown: data.groups.length, total: data.total, defaultValue: '{{shown}} of {{total}} groups (most recent first)' })}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function ReleaseChip({ active, disabled, onClick, children }: { active: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors disabled:cursor-default disabled:opacity-60 coarse:min-h-10',
        active ? 'border-accent/40 bg-accent/10 text-text-primary' : 'border-border bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
      )}
    >
      {children}
    </button>
  );
}

function classLabel(t: TFunction, c: SiteErrorClass): string {
  return c === 'readOnlyWrite' ? (t('siteErrors.class.readOnlyWrite') || 'Write to read-only code') : (t('siteErrors.class.execRefused') || 'Execution refused');
}

function classExplain(t: TFunction, c: SiteErrorClass): string {
  return c === 'readOnlyWrite'
    ? (t('siteErrors.explain.readOnlyWrite') || 'The live code is read-only: the site tried to write next to its code. Declare that folder as a data path (Configuration tab), then publish again.')
    : (t('siteErrors.explain.execRefused') || 'PHP only runs code from the release: a script under a data path or /tmp is refused. Put the PHP file in the code (staging) and publish.');
}

function ErrorRow({ siteId, group: g, open, onToggle, when, releaseLabel }: {
  siteId: number; group: SiteErrorGroup; open: boolean; onToggle: () => void; when: (iso: string) => string; releaseLabel: (n: number) => string;
}) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<SiteErrorGroupDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || detail) return;
    let live = true;
    logsApi.error(siteId, g.id)
      .then((d) => { if (live) { setDetail(d); setError(null); } })
      .catch((err) => { if (live) setError(opsErrorMessage(t, err, 'siteErrors', t('siteErrors.detailFailed') || 'Failed to load this error')); });
    return () => { live = false; };
  }, [open, detail, siteId, g.id, t]);

  return (
    <li>
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-bg-hover coarse:min-h-10">
        {open ? <ChevronDown size={14} className="mt-0.5 shrink-0 text-text-muted" /> : <ChevronRight size={14} className="mt-0.5 shrink-0 text-text-muted" />}
        <Pill tone={LEVEL_TONE[g.level]} className="shrink-0">{t(`siteErrors.levelName.${g.level}`) || LEVEL_LABEL[g.level]}</Pill>
        <span className="min-w-0 flex-1">
          <span className="block break-words text-xs text-text-primary">{g.message}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-text-muted">
            {g.file && <span className="break-all">{g.file}{g.line !== null ? `:${g.line}` : ''}</span>}
            <span>{releaseLabel(g.releaseNumber)}</span>
            {g.container && g.container !== 'primary' && <span className="text-sky-400">[{g.container}]</span>}
            {g.newInRelease && <Pill tone="accent">{t('siteErrors.new') || 'new'}</Pill>}
            {g.errorClass && <Pill tone="orange">{classLabel(t, g.errorClass)}</Pill>}
          </span>
        </span>
        <span className="shrink-0 text-right font-mono text-[11px] text-text-muted">
          <span className="block text-xs font-semibold text-text-secondary">×{g.count}</span>
          {when(g.lastSeen)}
        </span>
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3 pl-9">
          {g.errorClass && <p className="rounded-md bg-orange-400/10 px-3 py-2 text-xs text-orange-300">{classExplain(t, g.errorClass)}</p>}
          <p className="font-mono text-[11px] text-text-muted">
            {t('siteErrors.seen', { first: when(g.firstSeen), last: when(g.lastSeen), defaultValue: 'first seen {{first}} · last seen {{last}}' })}
          </p>
          {error ? (
            <p className="text-xs text-status-down">{error}</p>
          ) : !detail ? (
            <div className="flex py-2"><LoadingSpinner size="sm" /></div>
          ) : (
            <>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-bg-primary px-3 py-2 font-mono text-[11px] leading-relaxed text-text-secondary">{detail.sample}</pre>
              {detail.otherReleases.length > 0 ? (
                <p className="text-xs text-text-muted">
                  {t('siteErrors.otherReleases') || 'Also seen in'}{' '}
                  {detail.otherReleases.map((o) => `${releaseLabel(o.releaseNumber)} (×${o.count})`).join(', ')}
                </p>
              ) : (
                <p className="text-xs text-text-muted">{t('siteErrors.onlyRelease') || 'Seen in this release only.'}</p>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}
