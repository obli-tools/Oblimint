import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Check, Circle, Clock, Loader2, Terminal, X } from 'lucide-react';
import type { AdapterRun, AdapterRunDetail, AdapterRunStatus, ReleaseLogLine } from '@oblimint/shared';
import { adaptersApi } from '@/api/maintenance.api';
import { Drawer } from '@/components/common/Drawer';
import { InfoRow } from '@/components/hosting/hostingUi';
import { formatDateTime } from '@/components/sites/siteForm';
import { sectionLabelCls } from '@/components/sites/styles';
import { cn } from '@/utils/cn';
import { RiskBadge, RunStatusBadge, UpdateLevelBadge, useAdapterName, useRunStatusLabel, useUpdateKindLabel } from './MaintenanceBadges';
import { CountsInline } from './WindowsTable';
import { maintenanceErrorMessage } from './maintenanceErrors';

const STEPS: readonly AdapterRunStatus[] = ['queued', 'preparing', 'running', 'analyzing', 'publishing', 'post_deploy'];
const CHECK_STEPS: readonly AdapterRunStatus[] = ['queued', 'preparing', 'running'];

type StepState = 'done' | 'active' | 'waiting' | 'pending';

/**
 * State of each timeline step. awaiting_approval is a final status of the RUN
 * row but not of the update: the release is not published and post_deploy
 * (DB migrations) has not run; they resume after the approval (plan §13).
 */
export function adapterStepStates(status: AdapterRunStatus, steps: readonly AdapterRunStatus[]): StepState[] {
  if (status === 'awaiting_approval') {
    const pub = steps.indexOf('publishing');
    return steps.map((_, i) => (pub < 0 || i < pub ? 'done' : i === pub ? 'waiting' : 'pending'));
  }
  const final = !STEPS.includes(status);
  if (final) {
    const ok = status !== 'failed' && status !== 'rolled_back';
    return steps.map(() => (ok ? 'done' : 'pending'));
  }
  const cur = steps.indexOf(status);
  return steps.map((_, i) => (i < cur ? 'done' : i === cur ? 'active' : 'pending'));
}

const LEVEL_CLS: Record<ReleaseLogLine['level'], string> = {
  info: 'text-text-secondary',
  warn: 'text-amber-400',
  error: 'text-red-400',
};

/** Detail of an adapter run: status timeline, updates, analysis, log, CLI output, resulting release. */
export function AdapterRunDrawer({ siteId, run, tick, onClose }: { siteId: number; run: AdapterRun | null; tick: number; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const name = useAdapterName();
  const statusLabel = useRunStatusLabel();
  const kindLabel = useUpdateKindLabel();
  const [detail, setDetail] = useState<AdapterRunDetail | null>(null);
  const [error, setError] = useState('');
  const runId = run?.id ?? null;

  useEffect(() => {
    if (runId === null) { setDetail(null); return undefined; }
    let cancelled = false;
    setError('');
    adaptersApi.getRun(siteId, runId)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((err) => { if (!cancelled) setError(maintenanceErrorMessage(err, t)); });
    return () => { cancelled = true; };
  }, [siteId, runId, tick, t]);

  const r: AdapterRun | null = (detail && detail.id === runId ? detail : null) ?? run;
  const d = detail && detail.id === runId ? detail : null;
  const steps = r?.action === 'check' ? CHECK_STEPS : STEPS;
  const final = r ? !STEPS.includes(r.status) : false;
  const failedAt = r && (r.status === 'failed' || r.status === 'rolled_back');
  const awaiting = r?.status === 'awaiting_approval';
  const states = r ? adapterStepStates(r.status, steps) : [];

  return (
    <Drawer
      open={run !== null}
      onClose={onClose}
      side="right"
      size="full"
      className="sm:w-[min(95vw,820px)]"
      icon={<Terminal className="h-4 w-4 text-accent" />}
      title={r ? t('adapters.run.title', { id: r.id, name: name(r.adapter), defaultValue: 'Run #{{id}} — {{name}}' }) : ''}
      headerExtra={r ? <RunStatusBadge status={r.status} /> : undefined}
    >
      {!r ? null : (
        <div className="space-y-5">
          {/* Timeline */}
          <ol className="flex flex-wrap items-center gap-x-1 gap-y-2">
            {steps.map((s, i) => {
              const st = states[i];
              return (
                <li key={s} className="flex items-center gap-1">
                  <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]', st === 'active' ? 'bg-blue-500/10 text-blue-400' : st === 'waiting' ? 'bg-amber-400/10 text-amber-400' : st === 'done' ? 'bg-status-up/10 text-status-up' : 'bg-bg-tertiary text-text-muted')}>
                    {st === 'active' ? <Loader2 className="h-3 w-3 animate-spin" /> : st === 'waiting' ? <Clock className="h-3 w-3" /> : st === 'done' ? <Check className="h-3 w-3" /> : <Circle className="h-3 w-3" />}
                    {statusLabel(s)}
                  </span>
                  {i < steps.length - 1 && <span className="text-text-muted/50">›</span>}
                </li>
              );
            })}
            {final && !awaiting && (
              <li className="flex items-center gap-1">
                <span className="text-text-muted/50">›</span>
                <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]', failedAt ? 'bg-red-500/10 text-red-400' : 'bg-status-up/10 text-status-up')}>
                  {failedAt ? <X className="h-3 w-3" /> : <Check className="h-3 w-3" />}{statusLabel(r.status)}
                </span>
              </li>
            )}
          </ol>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <InfoRow label={t('adapters.run.action') || 'Action'}>{r.action === 'check' ? (t('adapters.check') || 'Check') : (t('adapters.update') || 'Update')}</InfoRow>
            <InfoRow label={t('adapters.run.trigger') || 'Trigger'}>{r.trigger === 'scheduled' ? (t('windows.trigger.scheduled') || 'Scheduled') : (t('windows.trigger.manual') || 'Manual')}{r.createdByName ? <span className="block text-xs text-text-muted">{r.createdByName}</span> : null}</InfoRow>
            <InfoRow label={t('adapters.run.started') || 'Started'}><span className="text-[13px]">{formatDateTime(r.startedAt ?? r.createdAt, i18n.language)}</span></InfoRow>
            <InfoRow label={t('adapters.run.finished') || 'Finished'}><span className="text-[13px]">{formatDateTime(r.finishedAt, i18n.language)}</span></InfoRow>
            <InfoRow label={t('adapters.run.changes') || 'Changes'}><CountsInline counts={r.counts} /></InfoRow>
            <InfoRow label={t('adapters.run.risk') || 'Risk'}><RiskBadge risk={r.risk} /></InfoRow>
            <InfoRow label={t('adapters.run.release') || 'Release'} mono>
              {r.resultReleaseNumber != null
                ? <Link to={`/sites/${siteId}?tab=releases`} className="text-accent hover:underline">#{r.resultReleaseNumber}</Link>
                : '—'}
            </InfoRow>
            {d && d.snapshots.length > 0 && <InfoRow label={t('adapters.run.snapshots') || 'DB snapshots'} mono>{d.snapshots.length}</InfoRow>}
          </div>

          {r.status === 'awaiting_approval' && (
            <p className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-400">
              {t('adapters.run.awaitingApproval') || 'The site publishes with approval: the release waits in the Releases tab; the database migrations were not run.'}
            </p>
          )}
          {r.error && (
            <div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2">
              <div className="mb-1 text-xs font-semibold text-red-400">{t('releases.fields.error') || 'Error'}</div>
              <p className="whitespace-pre-wrap break-words font-mono text-xs text-red-400">{r.error}</p>
            </div>
          )}

          <section>
            <div className={sectionLabelCls}>{r.action === 'check' ? (t('adapters.run.available') || 'Available updates') : (t('adapters.run.applied') || 'Updates applied')}</div>
            {r.updates.length === 0 ? (
              <p className="text-xs text-text-muted">{t('adapters.run.noUpdate') || 'None.'}</p>
            ) : (
              <ul className="divide-y divide-border/60 rounded-lg bg-bg-primary">
                {r.updates.map((u) => (
                  <li key={`${u.kind}:${u.name}`} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
                    <span className="text-text-muted">{kindLabel(u.kind)}</span>
                    <span className="min-w-0 truncate font-mono text-text-primary">{u.title ?? u.name}</span>
                    <span className="ml-auto font-mono text-text-secondary">{u.currentVersion ?? '?'} → {u.newVersion ?? '?'}</span>
                    <UpdateLevelBadge level={u.level} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <div className={sectionLabelCls}>{t('releases.drawer.log') || 'Log'}</div>
            {d === null ? (
              error ? <p className="text-xs text-red-400">{error}</p> : <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
            ) : d.log.length === 0 ? (
              <p className="text-xs text-text-muted">{t('releases.drawer.noLog') || 'Empty log.'}</p>
            ) : (
              <pre className="max-h-72 overflow-auto overscroll-contain rounded-lg bg-bg-primary/70 p-3 font-mono text-[11px] leading-relaxed">
                {d.log.map((l, i) => (
                  <div key={i} className={LEVEL_CLS[l.level]}>
                    <span className="text-text-muted/70">{new Date(l.at).toLocaleTimeString(i18n.language)}</span>{' '}
                    <span className="uppercase">{l.level.padEnd(5)}</span>{' '}
                    {l.message}
                  </div>
                ))}
              </pre>
            )}
          </section>

          {d && d.output && (
            <section>
              <div className={sectionLabelCls}>{t('adapters.run.output') || 'Command output'}</div>
              <pre className="max-h-96 overflow-auto overscroll-contain whitespace-pre rounded-lg bg-black/80 p-3 font-mono text-[11px] leading-relaxed text-green-200">{d.output}</pre>
              {d.outputTruncated && <p className="mt-1 text-xs text-amber-400">{t('adapters.run.outputTruncated') || 'Output truncated (64 KiB).'}</p>}
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
}
