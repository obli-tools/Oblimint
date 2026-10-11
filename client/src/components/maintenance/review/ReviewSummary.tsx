import { useTranslation } from 'react-i18next';
import { Activity, AlertTriangle, CheckCircle2, FileStack, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import type { MaintenanceWindowDetail } from '@oblimint/shared';
import { TableScroll } from '@/components/common/TableScroll';
import { SortTh, useTableSort } from '@/components/common/SortHead';
import { Card, InfoRow, thCls, theadRowCls } from '@/components/hosting/hostingUi';
import { formatDateTime } from '@/components/sites/siteForm';
import { Pill } from '@/components/sites/SiteBadges';
import {
  COMPONENT_TONE, LevelBadge, SnapshotStatusBadge, useAutoValidationReasonLabel, useComponentStatusLabel, useEngineLabel,
} from '../MaintenanceBadges';
import { formatBytes, riskTone } from '../maintenanceFormat';

/** Summary cards of the review page: counts, risk, auto-validation reasons, checksums, HTTP check, snapshots. */
export function ReviewSummary({ w }: { w: MaintenanceWindowDetail }) {
  const { t, i18n } = useTranslation();
  const engineLabel = useEngineLabel();
  const reasonLabel = useAutoValidationReasonLabel();
  const componentLabel = useComponentStatusLabel();
  const { sorted: components, sort } = useTableSort(w.checksums?.components ?? [], {
    provider: (c) => c.provider, name: (c) => c.name, version: (c) => c.version ?? '', status: (c) => c.status, files: (c) => c.mismatches * 1e9 + c.files,
  });
  const c = w.counts ?? w.analysis?.counts ?? null;
  const a = w.analysis;
  const risk = w.risk ?? a?.risk ?? null;
  const tone = riskTone(risk?.level);
  const auto = w.autoValidation;
  const failedReasons = auto ? auto.reasons.filter((r) => r.code !== 'ok') : [];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {/* Counts */}
      <Card title={t('windowReview.counts.title') || 'Changes'} icon={<FileStack size={14} className="text-accent" />}>
        {c ? (
          <div className="grid grid-cols-3 gap-3">
            <InfoRow label={t('windowReview.change.added') || 'Added'} mono><span className="text-status-up">+{c.added}</span></InfoRow>
            <InfoRow label={t('windowReview.change.modified') || 'Modified'} mono><span className="text-amber-400">~{c.modified}</span></InfoRow>
            <InfoRow label={t('windowReview.change.deleted') || 'Deleted'} mono><span className="text-red-400">−{c.deleted}</span></InfoRow>
            <InfoRow label={t('windowReview.counts.executable') || 'Executable'} mono><span className={c.executable > 0 ? 'text-orange-400' : ''}>{c.executable}</span></InfoRow>
            <InfoRow label={t('windowReview.counts.ignored') || 'Ignored'} mono>{c.ignored}</InfoRow>
            <InfoRow label={t('windowReview.counts.bytes') || 'Size'} mono>{formatBytes(c.bytes)}</InfoRow>
          </div>
        ) : (
          <p className="text-xs text-text-muted">{t('windowReview.notAnalyzed') || 'Not analyzed yet.'}</p>
        )}
      </Card>

      {/* Risk */}
      <Card title={t('windowReview.risk.title') || 'Risk'} icon={tone === 'red' ? <ShieldAlert size={14} className="text-red-400" /> : <ShieldCheck size={14} className="text-accent" />}>
        {risk ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span className={`font-mono text-3xl font-semibold tabular-nums ${tone === 'red' ? 'text-red-400' : tone === 'amber' ? 'text-amber-400' : 'text-text-primary'}`}>{risk.score}</span>
              <span className="text-xs text-text-muted">/ 100</span>
              <LevelBadge level={risk.level} />
            </div>
            {a && (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {a.engines.map((e) => <Pill key={e} tone="muted">{engineLabel(e)}</Pill>)}
                </div>
                <p className="text-xs text-text-secondary">
                  {t('windowReview.risk.findings', { count: a.findings, critical: a.criticalFindings, defaultValue: '{{count}} finding(s), {{critical}} critical' })}
                  {a.skipped > 0 && <span className="text-text-muted"> · {t('windowReview.risk.skipped', { count: a.skipped, defaultValue: '{{count}} file(s) not scanned (too large)' })}</span>}
                </p>
                {a.scannerUnavailable && (
                  <p className="flex items-start gap-2 text-xs text-amber-400">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" />{t('windowReview.risk.scannerUnavailable') || 'The scanner (ClamAV / YARA) did not answer: heuristics only.'}
                  </p>
                )}
                {a.blocked && (
                  <p className="flex items-start gap-2 text-xs text-red-400">
                    <ShieldAlert size={13} className="mt-0.5 shrink-0" />{t('windowReview.risk.blocked') || 'Blocked: validation needs a staff override.'}
                  </p>
                )}
              </>
            )}
          </div>
        ) : (
          <p className="text-xs text-text-muted">{t('windowReview.notAnalyzed') || 'Not analyzed yet.'}</p>
        )}
      </Card>

      {/* HTTP check + auto validation */}
      <Card title={t('windowReview.checks.title') || 'Checks'} icon={<Activity size={14} className="text-accent" />}>
        <div className="space-y-3">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">{t('windowReview.checks.http') || 'HTTP check of the site'}</div>
            {w.healthcheck ? (
              <p className={`mt-1 flex items-center gap-1.5 text-sm ${w.healthcheck.ok ? 'text-status-up' : 'text-red-400'}`}>
                {w.healthcheck.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                {w.healthcheck.ok ? (t('windowReview.checks.httpOk') || 'OK') : (t('windowReview.checks.httpFailed') || 'Failed')}
                {w.healthcheck.status != null && <span className="font-mono text-xs text-text-muted">HTTP {w.healthcheck.status}</span>}
              </p>
            ) : <p className="mt-1 text-sm text-text-muted">—</p>}
            {w.healthcheck?.error && <p className="mt-1 break-words text-xs text-red-400">{w.healthcheck.error}</p>}
          </div>
          <div>
            <div className="text-[10px] font-mono uppercase tracking-[0.12em] text-text-muted">{t('windowReview.checks.auto') || 'Automatic validation'}</div>
            {!auto ? (
              <p className="mt-1 text-sm text-text-muted">—</p>
            ) : auto.decision === 'validate' ? (
              <p className="mt-1 flex items-center gap-1.5 text-sm text-status-up"><CheckCircle2 size={14} />{t('windowReview.checks.autoValidated') || 'Every condition was met.'}</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {failedReasons.map((r, i) => (
                  <li key={`${r.code}-${i}`} className="text-xs text-text-secondary">
                    <span className="mr-1 text-amber-400">•</span>{reasonLabel(r.code)}
                    {r.detail && <span className="text-text-muted"> — {r.detail}</span>}
                    {r.paths && r.paths.length > 0 && (
                      <span className="mt-0.5 block break-all pl-3 font-mono text-[11px] text-text-muted">
                        {r.paths.slice(0, 5).join(', ')}{r.paths.length > 5 ? ` (+${r.paths.length - 5})` : ''}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Card>

      {/* Checksums */}
      {w.checksums && w.checksums.components.length > 0 && (
        <Card title={t('windowReview.checksums.title') || 'Official checksums'} icon={<ShieldCheck size={14} className="text-accent" />} className="lg:col-span-2">
          <TableScroll>
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className={theadRowCls}>
                  <SortTh k="provider" sort={sort} className={thCls}>{t('windowReview.checksums.provider') || 'Provider'}</SortTh>
                  <SortTh k="name" sort={sort} className={thCls}>{t('windowReview.checksums.name') || 'Component'}</SortTh>
                  <SortTh k="version" sort={sort} className={thCls}>{t('windowReview.checksums.version') || 'Version'}</SortTh>
                  <SortTh k="status" sort={sort} className={thCls}>{t('windowReview.checksums.status') || 'Status'}</SortTh>
                  <SortTh k="files" sort={sort} className={thCls}>{t('windowReview.checksums.files') || 'Files'}</SortTh>
                </tr>
              </thead>
              <tbody>
                {components.map((comp) => (
                  <tr key={`${comp.provider}:${comp.name}`}>
                    <td className="px-4 py-2 font-mono text-xs text-text-muted">{comp.provider}</td>
                    <td className="px-4 py-2 text-text-primary">{comp.name}</td>
                    <td className="px-4 py-2 font-mono text-xs text-text-secondary">{comp.version ?? '—'}</td>
                    <td className="px-4 py-2"><Pill tone={COMPONENT_TONE[comp.status] ?? 'muted'} title={comp.detail ?? undefined}>{componentLabel(comp.status)}</Pill></td>
                    <td className="px-4 py-2 font-mono text-xs text-text-secondary">
                      {comp.files}{comp.mismatches > 0 && <span className="ml-1 text-red-400">({t('windowReview.checksums.mismatches', { count: comp.mismatches, defaultValue: '{{count}} mismatch(es)' })})</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          <p className="mt-2 text-xs text-text-muted">
            {t('windowReview.checksums.summary', {
              verified: w.checksums.filesVerified, mismatched: w.checksums.filesMismatched, unknown: w.checksums.filesUnknown,
              defaultValue: '{{verified}} file(s) verified, {{mismatched}} mismatch(es), {{unknown}} not covered.',
            })}
          </p>
        </Card>
      )}

      {/* Snapshots */}
      {w.snapshotList.length > 0 && (
        <Card title={t('windowReview.snapshots') || 'Database snapshots'} className={w.checksums && w.checksums.components.length > 0 ? '' : 'lg:col-span-3'}>
          <ul className="space-y-1.5">
            {w.snapshotList.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate font-mono text-text-primary">{s.databaseName}</span>
                <span className="font-mono text-text-muted">{formatBytes(s.sizeBytes)}</span>
                <SnapshotStatusBadge status={s.status} />
                {s.restoredAt && <span className="text-text-muted">{t('snapshots.restoredAt', { date: formatDateTime(s.restoredAt, i18n.language), defaultValue: 'restored {{date}}' })}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
