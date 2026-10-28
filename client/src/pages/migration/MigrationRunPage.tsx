import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { FileText, ListOrdered, Pause, Play, RotateCcw, ScrollText, Square } from 'lucide-react';
import {
  HostingSocketEvents, type MigrationAccountReport, type MigrationRun, type MigrationRunDetail, type MigrationUpdatedPayload,
} from '@oblimint/shared';
import { migrationApi } from '@/api/migration.api';
import { DetailHeader } from '@/components/common/DetailHeader';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, InfoRow, Pill, headerBtnCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { durationBetween, formatBytes, formatDateTime, formatDuration, patchSearchParams, progressPct } from '@/components/migration/migrationFormat';
import {
  ErrorBlock, LoadState, ParamChips, ProgressBar, RunStatusPill, loadErrorOf, runKindLabel, stepLabelText, toastMigrationError, useByteUnits, type LoadError,
} from '@/components/migration/migrationUi';
import { RunStepsTable } from '@/components/migration/runs/RunStepsTable';
import { RunEventsLog } from '@/components/migration/runs/RunEventsLog';
import { AccountReportView } from '@/components/migration/report/AccountReportView';
import { cn } from '@/utils/cn';

type Tab = 'steps' | 'events' | 'report';
const TABS: readonly Tab[] = ['steps', 'events', 'report'];
function isTab(v: string | null): v is Tab {
  return v !== null && (TABS as readonly string[]).includes(v);
}

function RunReport({ runId }: { runId: number }) {
  const { t } = useTranslation();
  const [report, setReport] = useState<MigrationAccountReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);
  useEffect(() => {
    let cancelled = false;
    migrationApi.runReport(runId)
      .then((r) => { if (!cancelled) { setReport(r); setError(null); } })
      .catch((err) => { if (!cancelled) setError(loadErrorOf(t, err, t('migration.report.loadFailed') || 'Failed to load the report')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [runId, t]);
  return (
    <LoadState loading={loading} error={error} empty={!report} emptyIcon={<FileText />} emptyText={t('migration.report.empty') || 'Nothing migrated yet.'}>
      {report && <AccountReportView report={report} />}
    </LoadState>
  );
}

/**
 * /manage/migration/runs/:id — one run: progress, pause / resume / cancel /
 * retry, steps, live journal, account report (tabs ?tab=steps|events|report).
 * docs/P5-PLAN.md §9, §11. OWNED BY MODULE `ui-migration`.
 */
export function MigrationRunPage() {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const units = useByteUnits();
  const { id } = useParams();
  const runId = Number(id);
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab: Tab = isTab(tabParam) ? tabParam : 'steps';
  const setTab = (next: Tab) => setParams((prev) => patchSearchParams(prev, { tab: next === 'steps' ? null : next }), { replace: true });

  const [run, setRun] = useState<MigrationRunDetail | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [stepKey, setStepKey] = useState<string | null>(null);

  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const r = await migrationApi.getRun(runId);
      if (n !== seq.current) return;
      setRun(r);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setError(loadErrorOf(t, err, t('migration.run.loadFailed') || 'Failed to load the run'));
    }
  }, [runId, t]);
  useEffect(() => { void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.MIGRATION_UPDATED], () => { void load(); setTick((n) => n + 1); }, (_e, p) => {
    const payload = p as MigrationUpdatedPayload | null;
    if (!payload) return false;
    return (payload.entity === 'run' && payload.id === runId) || (payload.entity === 'step' && payload.runId === runId);
  }, 500);

  if (error && !run) {
    return (
      <PageContainer className="flex flex-col gap-4">
        <Link to="/manage/migration?tab=runs" className="text-sm text-accent hover:underline">← {t('migration.backToList') || 'Back to the migration'}</Link>
        <ErrorBlock error={error} />
      </PageContainer>
    );
  }
  if (!run) return <PageContainer className="flex justify-center py-16"><LoadingSpinner /></PageContainer>;

  const pct = progressPct(run.progress.done, run.progress.total);
  const current = run.currentStep ? run.steps.find((s) => s.key === run.currentStep) ?? null : null;

  const act = async (action: 'pause' | 'resume' | 'cancel' | 'retry') => {
    const confirms: Record<typeof action, { title: string; message: string; danger: boolean }> = {
      pause: { title: t('migration.run.pause') || 'Pause', message: t('migration.run.pauseConfirm') || 'The run stops after the current item (copies resume where they stopped). Resume it later.', danger: false },
      resume: { title: t('migration.run.resume') || 'Resume', message: t('migration.run.resumeConfirm') || 'The run goes back to the queue and resumes at the interrupted step.', danger: false },
      cancel: { title: t('migration.run.cancelRun') || 'Stop the run', message: t('migration.run.cancelConfirm') || 'The run stops. What was already created on the target is kept (nothing is deleted); a new run reuses it.', danger: true },
      retry: { title: t('migration.run.retry') || 'Retry', message: t('migration.run.retryConfirm') || 'The run resumes at the failed or interrupted step (steps already done are not run again).', danger: false },
    };
    const c = confirms[action];
    if (!(await confirm({ title: c.title, message: c.message, confirmLabel: c.title, danger: c.danger }))) return;
    setBusy(action);
    try {
      const fn: Record<typeof action, (id: number) => Promise<MigrationRun>> = {
        pause: migrationApi.pauseRun, resume: migrationApi.resumeRun, cancel: migrationApi.cancelRun, retry: migrationApi.retryRun,
      };
      await fn[action](run.id);
      toast.success(t(`migration.run.done.${action}`, { defaultValue: 'Requested' }));
      void load();
    } catch (err) {
      toastMigrationError(t, err, t('migration.run.actionFailed') || 'The action failed');
    } finally {
      setBusy(null);
    }
  };

  const tabs: SegmentedTab<Tab>[] = [
    { id: 'steps', label: t('migration.run.tabs.steps') || 'Steps', icon: <ListOrdered size={15} />, badge: <span className="ml-1 rounded-full bg-accent/15 px-1.5 font-mono text-[10px] text-accent">{run.steps.length}</span> },
    { id: 'events', label: t('migration.run.tabs.events') || 'Journal', icon: <ScrollText size={15} /> },
    { id: 'report', label: t('migration.run.tabs.report') || 'Account report', icon: <FileText size={15} /> },
  ];

  return (
    <PageContainer className="flex flex-col gap-5">
      <DetailHeader
        backTo={`/manage/migration/plans/${run.planId}?tab=runs`}
        title={<>{t('migration.run.title') || 'Migration run'} #{run.id} · <span className="font-mono">{run.cwpUsername}</span></>}
        badges={(
          <>
            <RunStatusPill status={run.status} />
          </>
        )}
        subtitle={(
          <>
            <span>{runKindLabel(t, run.kind)}</span>
            {run.kind !== 'initial' && run.parts.map((p) => <Pill key={p}>{t(`migration.parts.${p}`, { defaultValue: p })}</Pill>)}
            {run.mirrorDeletes && <Pill tone="red">{t('migration.runs.mirrorDeletesShort') || 'mirror deletes'}</Pill>}
            <span>·</span>
            <Link to={`/manage/migration/plans/${run.planId}?tab=runs`} className="text-accent hover:underline">{t('migration.runs.plan') || 'Plan'} #{run.planId}</Link>
            {run.targetAccountId != null && <><span>·</span><Link to={`/accounts/${run.targetAccountId}`} className="text-accent hover:underline">{t('migration.runs.targetAccount') || 'Target account'} #{run.targetAccountId}</Link></>}
          </>
        )}
        onRefresh={() => { void load(); setTick((n) => n + 1); }}
        actions={(
          <>
            {(run.status === 'running' || run.status === 'queued') && <button type="button" className={headerBtnCls} disabled={busy != null} onClick={() => { void act('pause'); }}><Pause size={14} />{t('migration.run.pause') || 'Pause'}</button>}
            {run.status === 'paused' && <button type="button" className={headerBtnCls} disabled={busy != null} onClick={() => { void act('resume'); }}><Play size={14} />{t('migration.run.resume') || 'Resume'}</button>}
            {(run.status === 'failed' || run.status === 'cancelled') && <button type="button" className={headerBtnCls} disabled={busy != null} onClick={() => { void act('retry'); }}><RotateCcw size={14} />{t('migration.run.retry') || 'Retry'}</button>}
            {(run.status === 'running' || run.status === 'queued' || run.status === 'paused') && (
              <button type="button" className={cn(headerBtnCls, 'text-status-down')} disabled={busy != null} onClick={() => { void act('cancel'); }}><Square size={14} />{t('migration.run.cancelRun') || 'Stop the run'}</button>
            )}
          </>
        )}
      />

      <Card>
        <div className="mb-2 flex flex-wrap justify-between gap-2 text-xs text-text-muted">
          <span>{current ? <>{t('migration.run.current') || 'Current step'}: {stepLabelText(t, current.label)} <ParamChips params={current.label.params} /></> : run.currentStep ?? ''}</span>
          <span className="font-mono">
            {run.progress.done}/{run.progress.total}{pct != null ? ` · ${pct}%` : ''}{run.progress.bytes != null ? ` · ${formatBytes(run.progress.bytes, units)}` : ''}
          </span>
        </div>
        <ProgressBar pct={run.status === 'queued' ? 0 : pct} tone={run.status === 'failed' ? 'red' : run.status === 'done' ? 'green' : run.status === 'paused' ? 'amber' : 'accent'} label={t('migration.runs.progress') || 'Progress'} />
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <InfoRow label={t('migration.run.started') || 'Started'} mono>{formatDateTime(run.startedAt, i18n.language)}</InfoRow>
          <InfoRow label={t('migration.run.finished') || 'Finished'} mono>{formatDateTime(run.finishedAt, i18n.language)}</InfoRow>
          <InfoRow label={t('migration.runs.duration') || 'Duration'} mono>{formatDuration(durationBetween(run.startedAt, run.finishedAt))}</InfoRow>
          <InfoRow label={t('migration.run.created') || 'Queued'} mono>{formatDateTime(run.createdAt, i18n.language)}</InfoRow>
        </div>
        {run.error && <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-status-down/5 p-2 font-mono text-[11px] text-status-down">{run.error}</pre>}
        {run.status === 'queued' && <p className="mt-3 text-xs text-text-muted">{t('migration.run.queuedHint') || 'Waiting for a migration worker (concurrency limited; OBLIMINT_MIGRATION_WORKERS=off keeps runs queued).'}</p>}
      </Card>

      <SegmentedTabs<Tab> tabs={tabs} value={tab} onChange={setTab} ariaLabel={t('migration.run.title') || 'Migration run'} fill={false} />

      {tab === 'steps' && (run.steps.length === 0
        ? <p className="rounded-xl bg-bg-secondary p-6 text-center text-sm text-text-muted">{t('migration.run.noSteps') || 'The steps are built when a worker takes the run.'}</p>
        : <RunStepsTable steps={run.steps} onShowEvents={(k) => { setStepKey(k); setTab('events'); }} />)}
      {tab === 'events' && <RunEventsLog runId={run.id} tick={tick} stepKey={stepKey} onClearStep={() => setStepKey(null)} />}
      {tab === 'report' && <RunReport key={`${run.id}-${run.status}`} runId={run.id} />}
    </PageContainer>
  );
}
