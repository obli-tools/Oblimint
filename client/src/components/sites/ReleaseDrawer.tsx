import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { GitCommit, Loader2 } from 'lucide-react';
import type { Release, ReleaseDetail, ReleaseLogLine } from '@oblimint/shared';
import { releasesApi } from '@/api/releases.api';
import { Drawer } from '@/components/common/Drawer';
import { cn } from '@/utils/cn';
import { ReleaseDiffPanel } from './DiffViewer';
import { Pill, ReleaseStatusBadge, ScanVerdictChip } from './SiteBadges';
import { formatDateTime } from './siteForm';
import { siteErrorMessage } from './siteErrors';
import { sectionLabelCls } from './styles';

export interface ReleaseDrawerProps {
  siteId: number;
  /** Release to show (null = closed). */
  releaseId: number | null;
  releases: Release[];
  /** Bumped by the parent when RELEASE_UPDATED concerns this release. */
  tick: number;
  onClose: () => void;
  /** Approve / reject / restore buttons for this release. */
  renderActions?: (release: Release) => ReactNode;
}

const LEVEL_CLS: Record<ReleaseLogLine['level'], string> = {
  info: 'text-text-secondary',
  warn: 'text-amber-400',
  error: 'text-red-400',
};

export function ReleaseDrawer({ siteId, releaseId, releases, tick, onClose, renderActions }: ReleaseDrawerProps) {
  const { t, i18n } = useTranslation();
  const severityLabel = (s: 'info' | 'warn' | 'critical') => (
    s === 'critical' ? (t('releases.scan.severity.critical') || 'critical')
      : s === 'warn' ? (t('releases.scan.severity.warn') || 'warning')
        : (t('releases.scan.severity.info') || 'info')
  );
  const [detail, setDetail] = useState<ReleaseDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (releaseId === null) { setDetail(null); return; }
    let cancelled = false;
    setError('');
    releasesApi.get(siteId, releaseId)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((err) => { if (!cancelled) setError(siteErrorMessage(err, t)); });
    return () => { cancelled = true; };
  }, [siteId, releaseId, tick, t]);

  // Until the detail arrives, show the list row (instant title / status).
  const release: Release | null = (detail && detail.id === releaseId ? detail : null) ?? releases.find((r) => r.id === releaseId) ?? null;
  const log = detail && detail.id === releaseId ? detail.log : null;

  const meta: Array<[string, ReactNode]> = release ? [
    [t('releases.fields.trigger') || 'Trigger', triggerLabel(release.trigger, t)],
    [t('releases.fields.author') || 'Author', release.authorName ?? '—'],
    [t('releases.fields.commit') || 'Commit', release.commitSha ? <span className="font-mono" title={release.commitSha}>{release.commitSha.slice(0, 12)}</span> : '—'],
    [t('releases.fields.created') || 'Created', formatDateTime(release.createdAt, i18n.language)],
    [t('releases.fields.published') || 'Published', formatDateTime(release.publishedAt, i18n.language)],
    [t('releases.fields.approvedBy') || 'Approved by', release.approvedBy ? `${release.approvedBy} · ${formatDateTime(release.approvedAt, i18n.language)}` : '—'],
    [t('releases.fields.onDisk') || 'On disk', release.onDisk ? (t('releases.onDiskYes') || 'yes') : (t('releases.onDiskNo') || 'no (pruned, rebuilt from git on restore)')],
    [t('releases.fields.changes') || 'Changes', (
      <span className="font-mono">
        <span className="text-status-up">+{release.filesAdded}</span>{' '}
        <span className="text-amber-400">~{release.filesModified}</span>{' '}
        <span className="text-red-400">−{release.filesDeleted}</span>
      </span>
    )],
  ] : [];

  return (
    <Drawer
      open={releaseId !== null}
      onClose={onClose}
      side="right"
      size="full"
      className="sm:w-[min(95vw,960px)]"
      icon={<GitCommit className="h-4 w-4 text-accent" />}
      title={release ? t('releases.drawer.title', { number: release.number, defaultValue: 'Release #{{number}}' }) : (t('releases.drawer.loading') || 'Release')}
      headerExtra={release ? (
        <span className="flex items-center gap-1.5">
          {release.isCurrent && <Pill tone="accent">{t('releases.current') || 'current'}</Pill>}
          <ReleaseStatusBadge status={release.status} />
        </span>
      ) : undefined}
      footer={release && renderActions ? renderActions(release) : undefined}
    >
      {error && !release ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : !release ? (
        <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-text-muted" /></div>
      ) : (
        <div className="space-y-5">
          {release.message && <p className="whitespace-pre-line break-words text-sm text-text-primary">{release.message}</p>}

          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {meta.map(([k, v]) => (
              <div key={k} className="flex min-w-0 gap-3">
                <dt className="w-32 shrink-0 text-text-muted">{k}</dt>
                <dd className="min-w-0 break-words text-text-secondary">{v}</dd>
              </div>
            ))}
          </dl>

          {release.error && (
            <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2">
              <div className="mb-1 text-xs font-semibold text-red-400">{t('releases.fields.error') || 'Error'}</div>
              <p className="whitespace-pre-wrap break-words font-mono text-xs text-red-400">{release.error}</p>
            </div>
          )}

          {release.scan && (
            <section>
              <div className={cn(sectionLabelCls, 'flex items-center gap-2')}>
                {t('releases.scan.title') || 'Pre-publication scan'}
                <ScanVerdictChip verdict={release.scan.verdict} />
                <span className="normal-case tracking-normal text-text-muted/70">{release.scan.scanner}</span>
              </div>
              {release.scan.findings.length === 0 ? (
                <p className="text-xs text-text-muted">{t('releases.scan.noFinding') || 'No finding.'}</p>
              ) : (
                <ul className="space-y-1">
                  {release.scan.findings.map((f, i) => (
                    <li key={`${f.path}:${f.rule}:${i}`} className="rounded-lg bg-bg-tertiary/60 px-3 py-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <Pill tone={f.severity === 'critical' ? 'red' : f.severity === 'warn' ? 'amber' : 'muted'} className="text-[10px] uppercase">{severityLabel(f.severity)}</Pill>
                        <code className="break-all font-mono text-text-primary">{f.path}</code>
                        <span className="font-mono text-text-muted">{f.rule}</span>
                      </div>
                      <p className="mt-1 text-text-secondary">{f.message}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section>
            <div className={sectionLabelCls}>{t('releases.drawer.log') || 'Log'}</div>
            {log === null ? (
              error ? <p className="text-xs text-red-400">{error}</p> : <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
            ) : log.length === 0 ? (
              <p className="text-xs text-text-muted">{t('releases.drawer.noLog') || 'Empty log.'}</p>
            ) : (
              <pre className="max-h-72 overflow-auto overscroll-contain rounded-lg bg-bg-primary/70 p-3 font-mono text-[11px] leading-relaxed">
                {log.map((l, i) => (
                  <div key={i} className={LEVEL_CLS[l.level]}>
                    <span className="text-text-muted/70">{new Date(l.at).toLocaleTimeString(i18n.language)}</span>{' '}
                    <span className="uppercase">{l.level.padEnd(5)}</span>{' '}
                    {l.message}
                  </div>
                ))}
              </pre>
            )}
          </section>

          {release.commitSha && (
            <section>
              <div className={sectionLabelCls}>{t('releases.diff.title') || 'Changes'}</div>
              <ReleaseDiffPanel siteId={siteId} release={release} releases={releases} />
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}

export function triggerLabel(trigger: Release['trigger'], t: (k: string) => string): string {
  return ({
    auto: t('releases.trigger.auto') || 'automatic',
    manual: t('releases.trigger.manual') || 'manual',
    api: t('releases.trigger.api') || 'API',
  })[trigger];
}
