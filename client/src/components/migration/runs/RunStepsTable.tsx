import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { MigrationRunStep } from '@oblimint/shared';
import { TableScroll } from '@/components/common/TableScroll';
import { SortTh, useTableSort } from '@/components/common/SortHead';
import { Pill, thCls, theadRowCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { durationBetween, formatDuration, resultSummary, targetLinks } from '../migrationFormat';
import { ParamChips, StepStatusPill, WarningList, stepLabelText, tdCls } from '../migrationUi';

/** Steps of a run in execution order (phase, provider, position), with result links and warnings. */
export function RunStepsTable({ steps, onShowEvents }: { steps: MigrationRunStep[]; onShowEvents?: (stepKey: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (id: number) => setOpen((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const execution = [...steps].sort((a, b) => a.phase - b.phase || a.provider.localeCompare(b.provider) || a.id - b.id);
  // No column picked = execution order (phase, provider, position).
  const { sorted: ordered, sort } = useTableSort(execution, {
    phase: (s) => s.phase,
    step: (s) => s.key,
    status: (s) => s.status,
    attempts: (s) => s.attempts,
    duration: (s) => (s.startedAt ? durationBetween(s.startedAt, s.finishedAt) : null),
    result: (s) => s.error ?? '',
  });
  return (
    <TableScroll className="rounded-xl bg-bg-secondary">
      <table className="w-full min-w-[880px] text-sm">
        <thead>
          <tr className={theadRowCls}>
            <th className={`${thCls} w-8`}><span className="sr-only">{t('migration.run.details') || 'Details'}</span></th>
            <SortTh k="phase" sort={sort} className={`${thCls} w-14`}>{t('migration.run.phase') || 'Phase'}</SortTh>
            <SortTh k="step" sort={sort} className={thCls}>{t('migration.run.step') || 'Step'}</SortTh>
            <SortTh k="status" sort={sort} className={thCls}>{t('migration.common.status') || 'Status'}</SortTh>
            <SortTh k="attempts" sort={sort} className={thCls}>{t('migration.run.attempts') || 'Attempts'}</SortTh>
            <SortTh k="duration" sort={sort} className={thCls}>{t('migration.runs.duration') || 'Duration'}</SortTh>
            <SortTh k="result" sort={sort} className={thCls}>{t('migration.run.result') || 'Result'}</SortTh>
          </tr>
        </thead>
        <tbody>
          {ordered.map((s) => {
            const links = targetLinks(s.result);
            const summary = resultSummary(s.result);
            const hasDetail = s.warnings.length > 0 || !!s.error || summary.length > 0;
            const expanded = open.has(s.id);
            return (
              <Fragment key={s.id}>
                <tr className={cn('align-top transition-colors hover:bg-bg-hover', s.status === 'failed' && 'bg-status-down/[0.05]', s.status === 'running' && 'bg-sky-400/[0.04]')}>
                  <td className="px-2 py-2.5">
                    {hasDetail && (
                      <button type="button" onClick={() => toggle(s.id)} aria-expanded={expanded} aria-label={t('migration.run.details') || 'Details'} className="rounded p-1 text-text-muted hover:text-text-primary">
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    )}
                  </td>
                  <td className={`${tdCls} font-mono text-xs text-text-muted`}>{s.phase}</td>
                  <td className={tdCls}>
                    <div className="text-sm text-text-primary">{stepLabelText(t, s.label)} <ParamChips params={s.label.params} /></div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <code className="font-mono text-[10px] text-text-muted">{s.key}</code>
                      <Pill>{s.provider}</Pill>
                      {onShowEvents && <button type="button" className="text-[10px] text-accent hover:underline" onClick={() => onShowEvents(s.key)}>{t('migration.run.showEvents') || 'events'}</button>}
                    </div>
                  </td>
                  <td className={tdCls}>
                    <StepStatusPill status={s.status} />
                    {s.warnings.length > 0 && <Pill tone="amber" className="ml-1">{s.warnings.length}</Pill>}
                  </td>
                  <td className={`${tdCls} font-mono text-xs text-text-muted`}>{s.attempts}</td>
                  <td className={`${tdCls} font-mono text-[11px] text-text-muted`}>{s.startedAt && (s.finishedAt || s.status === 'running') ? formatDuration(durationBetween(s.startedAt, s.finishedAt)) : '—'}</td>
                  <td className={tdCls}>
                    <div className="flex flex-wrap gap-1.5">
                      {links.map((l) => (
                        <Link key={`${l.kind}-${l.id}`} to={l.to} className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] text-accent hover:bg-accent/20">
                          {t(`migration.objectKinds.${l.kind}`, { defaultValue: l.kind })} #{l.id}
                        </Link>
                      ))}
                      {links.length === 0 && summary.length === 0 && <span className="text-text-muted">—</span>}
                    </div>
                    {s.error && <div className="mt-1 max-w-[320px] truncate text-[11px] text-status-down" title={s.error}>{s.error}</div>}
                  </td>
                </tr>
                {expanded && (
                  <tr>
                    <td />
                    <td colSpan={6} className="space-y-2 px-4 pb-3">
                      {s.error && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-status-down/5 p-2 font-mono text-[11px] text-status-down">{s.error}</pre>}
                      {summary.length > 0 && (
                        <dl className="grid gap-x-3 gap-y-0.5 font-mono text-[11px] sm:grid-cols-[max-content_1fr]">
                          {summary.map(([k, v]) => <div key={k} className="contents"><dt className="text-text-muted">{k}</dt><dd className="break-all text-text-secondary">{v}</dd></div>)}
                        </dl>
                      )}
                      <WarningList warnings={s.warnings} showScope />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}
