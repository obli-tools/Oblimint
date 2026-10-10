import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { AppMaintenanceSchedule, WorkflowAction, WorkflowRunStatus, WorkflowTrigger, WorkflowTriggerKind } from '@oblimint/shared';
import { describeSchedule } from '@/components/cron/cronFormat';
import { Pill } from '@/components/hosting/hostingUi';
import { WEEK_ORDER, weekdayShort, windowEnd } from '@/components/apps/appsFormat';

// Labels of the automation screens (literal keys for the en extractor). OWNED BY MODULE `ui-apps`.

export function triggerKindLabel(t: TFunction, k: WorkflowTriggerKind): string {
  switch (k) {
    case 'cert-renewal': return t('automation.trigger.certRenewal') || 'Certificate renewal';
    case 'interval': return t('automation.trigger.interval') || 'Interval';
    case 'cron': return t('automation.trigger.cron') || 'Schedule (cron)';
    default: return t('automation.trigger.manual') || 'Manual';
  }
}

/** One-line human description of a trigger. */
export function describeTrigger(t: TFunction, tr: WorkflowTrigger, lang: string): string {
  switch (tr.kind) {
    case 'cert-renewal':
      return tr.certificateNames?.length
        ? t('automation.trigger.certRenewalOf', { names: tr.certificateNames.join(', '), defaultValue: 'When a certificate of {{names}} is renewed' })
        : (t('automation.trigger.certRenewalAny') || 'When a certificate of the account is renewed');
    case 'interval':
      return t('automation.trigger.everyMinutes', { count: tr.intervalMinutes ?? 0, defaultValue: 'Every {{count}} min' });
    case 'cron': {
      const d = tr.cron ? describeSchedule(tr.cron, lang) : null;
      return `${d ?? tr.cron ?? '—'} (${tr.timezone || 'UTC'})`;
    }
    default:
      return t('automation.trigger.manualOnly') || 'Run by hand only';
  }
}

export function describeAction(t: TFunction, a: WorkflowAction, names: { cert?: string | null; target?: string | null; stack?: string | null }): string {
  if (a.kind === 'export-certificate') {
    return t('automation.action.exportSummary', { cert: names.cert ?? `#${a.certificate?.id ?? '?'}`, target: names.target ?? `#${a.sftpTargetId ?? '?'}`, defaultValue: 'Export {{cert}} to {{target}}' });
  }
  return t('automation.action.restartSummary', {
    stack: names.stack ?? `#${a.stackId ?? '?'}`,
    services: a.services?.length ? a.services.join(', ') : (t('automation.action.allServices') || 'every service'),
    defaultValue: 'Restart {{stack}} ({{services}})',
  });
}

export function runStatusLabel(t: TFunction, s: WorkflowRunStatus): string {
  switch (s) {
    case 'running': return t('automation.run.running') || 'Running';
    case 'succeeded': return t('automation.run.succeeded') || 'Succeeded';
    default: return t('automation.run.failed') || 'Failed';
  }
}

export function runStatusTone(s: WorkflowRunStatus | null): 'green' | 'red' | 'blue' | 'muted' {
  return s === 'succeeded' ? 'green' : s === 'failed' ? 'red' : s === 'running' ? 'blue' : 'muted';
}

/** "Mon, Wed 02:00 → 04:00 (Europe/Paris)". */
export function describeWindow(s: AppMaintenanceSchedule, lang: string): string {
  const days = WEEK_ORDER.filter((d) => s.days.includes(d)).map((d) => weekdayShort(d, lang)).join(', ');
  const { end, nextDay } = windowEnd(s);
  return `${days || '—'} ${s.start} → ${end}${nextDay ? ' (+1)' : ''} (${s.timezone})`;
}

export function RunStatusPill({ status }: { status: WorkflowRunStatus | null }) {
  const { t } = useTranslation();
  if (!status) return <span className="text-text-muted">—</span>;
  return <Pill tone={runStatusTone(status)}>{runStatusLabel(t, status)}</Pill>;
}
