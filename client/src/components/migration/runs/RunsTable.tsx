import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { MigrationRun } from '@oblimint/shared';
import { GroupedTable, flatNodes, groupByAccount } from '@/components/common/GroupedTable';
import { Pill } from '@/components/hosting/hostingUi';
import { durationBetween, formatBytes, formatDateTime, formatDuration, progressPct } from '../migrationFormat';
import { ProgressBar, RunStatusPill, runKindLabel, useByteUnits } from '../migrationUi';

/** Table of runs (global runs tab and plan runs tab), grouped by CWP account, newest first. */
export function RunsTable({ runs, showPlan = true, planName }: {
  runs: MigrationRun[];
  showPlan?: boolean;
  planName?: (planId: number) => string;
}) {
  const { t, i18n } = useTranslation();
  const units = useByteUnits();
  return (
    <GroupedTable<MigrationRun>
      storageKey="migration-runs"
      singleGroupFlat
      minWidth={880}
      defaultSort={{ column: 'id', dir: 'desc' }}
      groups={groupByAccount(runs, (r) => ({ id: r.cwpUsername, name: r.cwpUsername }), (rows) => flatNodes(rows, (r) => r.id))}
      columns={[
        {
          id: 'id', header: '#', sort: (r) => r.id,
          cell: (r) => (
            <>
              <Link to={`/manage/migration/runs/${r.id}`} className="font-mono text-xs text-accent hover:underline">#{r.id}</Link>
              {r.targetAccountId != null && <Link to={`/accounts/${r.targetAccountId}`} className="ml-2 text-[11px] text-text-muted hover:text-accent">→ #{r.targetAccountId}</Link>}
            </>
          ),
        },
        ...(showPlan ? [{
          id: 'plan', header: t('migration.runs.plan') || 'Plan', sort: (r: MigrationRun) => (planName ? planName(r.planId) : r.planId),
          cell: (r: MigrationRun) => <Link to={`/manage/migration/plans/${r.planId}`} className="text-xs text-text-secondary hover:text-accent">{planName ? planName(r.planId) : `#${r.planId}`}</Link>,
        }] : []),
        {
          id: 'kind', header: t('migration.runs.kind') || 'Kind', sort: (r) => r.kind,
          cell: (r) => (
            <>
              <span className="text-xs text-text-secondary">{runKindLabel(t, r.kind)}</span>
              {r.kind !== 'initial' && r.parts.length > 0 && <div className="mt-0.5 flex flex-wrap gap-1">{r.parts.map((p) => <Pill key={p}>{t(`migration.parts.${p}`, { defaultValue: p })}</Pill>)}</div>}
              {r.mirrorDeletes && <div className="mt-0.5"><Pill tone="red">{t('migration.runs.mirrorDeletesShort') || 'mirror deletes'}</Pill></div>}
            </>
          ),
        },
        {
          id: 'status', header: t('migration.common.status') || 'Status', sort: (r) => r.status,
          cell: (r) => (
            <>
              <RunStatusPill status={r.status} />
              {r.error && <div className="mt-1 max-w-[220px] truncate text-[11px] text-status-down" title={r.error}>{r.error}</div>}
            </>
          ),
        },
        {
          id: 'progress', header: t('migration.runs.progress') || 'Progress', thClassName: 'w-56', sort: (r) => progressPct(r.progress.done, r.progress.total) ?? 0,
          cell: (r) => {
            const pct = progressPct(r.progress.done, r.progress.total);
            return (
              <>
                <div className="flex justify-between text-[11px] text-text-muted">
                  <span className="font-mono">{r.progress.done}/{r.progress.total}</span>
                  {r.progress.bytes != null && <span className="font-mono">{formatBytes(r.progress.bytes, units)}</span>}
                </div>
                <ProgressBar className="mt-1" pct={r.status === 'running' || r.status === 'done' || r.status === 'failed' || r.status === 'paused' ? (pct ?? 0) : 0} tone={r.status === 'failed' ? 'red' : r.status === 'done' ? 'green' : r.status === 'paused' ? 'amber' : 'accent'} />
              </>
            );
          },
        },
        {
          id: 'started', header: t('migration.common.startedFinished') || 'Started / finished', tdClassName: 'font-mono text-[11px] text-text-muted', sort: (r) => r.startedAt ?? '',
          cell: (r) => <>{formatDateTime(r.startedAt, i18n.language)}<br />{formatDateTime(r.finishedAt, i18n.language)}</>,
        },
        {
          id: 'duration', header: t('migration.runs.duration') || 'Duration', tdClassName: 'font-mono text-[11px] text-text-muted',
          sort: (r) => durationBetween(r.startedAt, r.finishedAt) ?? null,
          cell: (r) => formatDuration(durationBetween(r.startedAt, r.finishedAt)),
        },
      ]}
    />
  );
}
