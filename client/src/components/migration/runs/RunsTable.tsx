import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { MigrationRun } from '@oblimint/shared';
import { TableScroll } from '@/components/common/TableScroll';
import { Pill, thCls, theadRowCls } from '@/components/hosting/hostingUi';
import { durationBetween, formatBytes, formatDateTime, formatDuration, progressPct } from '../migrationFormat';
import { ProgressBar, RunStatusPill, runKindLabel, tdCls, useByteUnits } from '../migrationUi';

/** Table of runs (global runs tab and plan runs tab). */
export function RunsTable({ runs, showPlan = true, planName }: {
  runs: MigrationRun[];
  showPlan?: boolean;
  planName?: (planId: number) => string;
}) {
  const { t, i18n } = useTranslation();
  const units = useByteUnits();
  return (
    <TableScroll className="rounded-xl bg-bg-secondary">
      <table className="w-full min-w-[920px] text-sm">
        <thead>
          <tr className={theadRowCls}>
            <th className={thCls}>#</th>
            <th className={thCls}>{t('migration.runs.account') || 'CWP account'}</th>
            {showPlan && <th className={thCls}>{t('migration.runs.plan') || 'Plan'}</th>}
            <th className={thCls}>{t('migration.runs.kind') || 'Kind'}</th>
            <th className={thCls}>{t('migration.common.status') || 'Status'}</th>
            <th className={`${thCls} w-56`}>{t('migration.runs.progress') || 'Progress'}</th>
            <th className={thCls}>{t('migration.common.startedFinished') || 'Started / finished'}</th>
            <th className={thCls}>{t('migration.runs.duration') || 'Duration'}</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const pct = progressPct(r.progress.done, r.progress.total);
            return (
              <tr key={r.id} className="transition-colors hover:bg-bg-hover">
                <td className={tdCls}><Link to={`/manage/migration/runs/${r.id}`} className="font-mono text-xs text-accent hover:underline">#{r.id}</Link></td>
                <td className={tdCls}>
                  <Link to={`/manage/migration/runs/${r.id}`} className="font-mono text-xs text-text-primary hover:text-accent">{r.cwpUsername}</Link>
                  {r.targetAccountId != null && <Link to={`/accounts/${r.targetAccountId}`} className="ml-2 text-[11px] text-text-muted hover:text-accent">→ #{r.targetAccountId}</Link>}
                </td>
                {showPlan && (
                  <td className={tdCls}><Link to={`/manage/migration/plans/${r.planId}`} className="text-xs text-text-secondary hover:text-accent">{planName ? planName(r.planId) : `#${r.planId}`}</Link></td>
                )}
                <td className={tdCls}>
                  <span className="text-xs text-text-secondary">{runKindLabel(t, r.kind)}</span>
                  {r.kind !== 'initial' && r.parts.length > 0 && <div className="mt-0.5 flex flex-wrap gap-1">{r.parts.map((p) => <Pill key={p}>{t(`migration.parts.${p}`, { defaultValue: p })}</Pill>)}</div>}
                  {r.mirrorDeletes && <div className="mt-0.5"><Pill tone="red">{t('migration.runs.mirrorDeletesShort') || 'mirror deletes'}</Pill></div>}
                </td>
                <td className={tdCls}>
                  <RunStatusPill status={r.status} />
                  {r.error && <div className="mt-1 max-w-[220px] truncate text-[11px] text-status-down" title={r.error}>{r.error}</div>}
                </td>
                <td className={tdCls}>
                  <div className="flex justify-between text-[11px] text-text-muted">
                    <span className="font-mono">{r.progress.done}/{r.progress.total}</span>
                    {r.progress.bytes != null && <span className="font-mono">{formatBytes(r.progress.bytes, units)}</span>}
                  </div>
                  <ProgressBar className="mt-1" pct={r.status === 'running' || r.status === 'done' || r.status === 'failed' || r.status === 'paused' ? (pct ?? 0) : 0} tone={r.status === 'failed' ? 'red' : r.status === 'done' ? 'green' : r.status === 'paused' ? 'amber' : 'accent'} />
                </td>
                <td className={`${tdCls} font-mono text-[11px] text-text-muted`}>{formatDateTime(r.startedAt, i18n.language)}<br />{formatDateTime(r.finishedAt, i18n.language)}</td>
                <td className={`${tdCls} font-mono text-[11px] text-text-muted`}>{formatDuration(durationBetween(r.startedAt, r.finishedAt))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}
