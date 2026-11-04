import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Activity, Check, Eye, RotateCcw } from 'lucide-react';
import {
  OBSERVATION_THRESHOLDS, OBSERVATION_WINDOW_MAX_MINUTES, OBSERVATION_WINDOW_MIN_MINUTES,
  type ObservationMode, type ReleaseObservation, type ReleaseVerdict, type ReleaseVerdictReason, type Site,
} from '@oblimint/shared';
import { sitesApi } from '@/api/sites.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { Pill, type Tone } from '@/components/common/Pill';
import { Card } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { formatDateTime } from './siteForm';
import { siteErrorMessage } from './siteErrors';
import { fieldCls, labelCls, sectionLabelCls } from './styles';

// Observation of a release after it went live (shared/releaseObservation.ts):
// the verdict badge (releases list, drawer header), the facts in the release
// drawer, and the per-site settings (Configuration tab: mode and window).

const VERDICT_TONE: Record<ReleaseVerdict, Tone> = { healthy: 'green', degraded: 'amber', failed: 'red', insufficient_data: 'muted' };

function useVerdictLabel(): (v: ReleaseVerdict) => string {
  const { t } = useTranslation();
  return (v) => ({
    healthy: t('releaseObservation.verdict.healthy') || 'healthy',
    degraded: t('releaseObservation.verdict.degraded') || 'degraded',
    failed: t('releaseObservation.verdict.failed') || 'failed',
    insufficient_data: t('releaseObservation.verdict.insufficientData') || 'not enough traffic',
  })[v];
}

function useReasonLabel(): (r: ReleaseVerdictReason) => string {
  const { t } = useTranslation();
  return (r) => ({
    errorRate: t('releaseObservation.reason.errorRate') || 'Share of 5xx answers far above the threshold and the previous release',
    healthcheckFailing: t('releaseObservation.reason.healthcheckFailing') || 'Health check failing several times in a row',
    errorRateUp: t('releaseObservation.reason.errorRateUp') || 'More 5xx answers than with the previous release',
    healthcheckFlaky: t('releaseObservation.reason.healthcheckFlaky') || 'Some health checks failed',
    newFatalErrors: t('releaseObservation.reason.newFatalErrors') || 'New fatal PHP errors (none of the earlier releases had them)',
    lowTraffic: t('releaseObservation.reason.lowTraffic', { count: OBSERVATION_THRESHOLDS.minRequests, defaultValue: 'Fewer than {{count}} requests: no verdict on the traffic' }),
  })[r];
}

const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 1000) / 10} %`);

/** Compact badge: watching (with the provisional verdict in the tooltip), the verdict, and a return done automatically. */
export function ReleaseVerdictBadge({ observation, className }: { observation: ReleaseObservation | null; className?: string }) {
  const { t } = useTranslation();
  const label = useVerdictLabel();
  if (!observation) return null;
  if (observation.state === 'watching') {
    return (
      <Pill tone="blue" className={cn('text-[10px]', className)} title={t('releaseObservation.soFar', { verdict: label(observation.provisionalVerdict), defaultValue: 'So far: {{verdict}}' })}>
        <Eye size={11} />{t('releaseObservation.watching') || 'observing'}
      </Pill>
    );
  }
  const v = observation.verdict ?? observation.provisionalVerdict;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      <Pill tone={observation.state === 'superseded' ? 'muted' : VERDICT_TONE[v]} className="text-[10px]" title={t('releaseObservation.badgeTitle') || 'Verdict of the observation after publication'}>
        <Activity size={11} />{label(v)}
      </Pill>
      {observation.action === 'reverted' && (
        <Pill tone="amber" className="text-[10px]"><RotateCcw size={11} />{t('releaseObservation.reverted') || 'reverted'}</Pill>
      )}
    </span>
  );
}

/** Section of the release drawer: window, verdict, facts, what the panel did. */
export function ReleaseObservationPanel({ observation }: { observation: ReleaseObservation }) {
  const { t, i18n } = useTranslation();
  const reason = useReasonLabel();
  const label = useVerdictLabel();
  const f = observation.facts;
  const prev = observation.previousReleaseNumber;
  const rows: Array<[string, string]> = [
    [t('releaseObservation.facts.window') || 'Window', `${formatDateTime(observation.startedAt, i18n.language)} → ${formatDateTime(observation.endsAt, i18n.language)} (${observation.windowMinutes} min)`],
    [t('releaseObservation.facts.requests') || 'Requests', String(f.requests)],
    [t('releaseObservation.facts.errors') || '5xx answers', `${f.errors5xx} (${pct(f.errorRate)})${f.upstreamErrors ? ` · ${t('releaseObservation.facts.upstream', { count: f.upstreamErrors, defaultValue: '{{count}} × 502/503/504' })}` : ''}`],
    [prev ? t('releaseObservation.facts.baselineOf', { number: prev, defaultValue: 'Before (#{{number}})' }) : (t('releaseObservation.facts.baseline') || 'Before'), f.baseline
      ? `${f.baseline.errors5xx}/${f.baseline.requests} (${pct(f.baseline.errorRate)}) · ${t('releaseObservation.facts.minutes', { count: f.baseline.minutes, defaultValue: '{{count}} min' })}`
      : (t('releaseObservation.facts.noBaseline') || 'unknown (first release, or the panel restarted)')],
    [t('releaseObservation.facts.php') || 'New PHP errors', t('releaseObservation.facts.phpValue', {
      groups: f.newErrorGroups, fatals: f.newFatalGroups, occurrences: f.newErrorOccurrences, defaultValue: '{{groups}} group(s), {{fatals}} fatal, {{occurrences}} occurrence(s)',
    })],
    [t('releaseObservation.facts.probes') || 'Health checks', f.probes
      ? `${t('releaseObservation.facts.probesValue', { ok: f.probes - f.probeFailures, total: f.probes, defaultValue: '{{ok}}/{{total}} OK' })}${f.lastProbeError ? ` · ${f.lastProbeError}` : ''}`
      : '—'],
  ];
  const shown = observation.verdict ?? observation.provisionalVerdict;
  return (
    <section>
      <div className={cn(sectionLabelCls, 'flex flex-wrap items-center gap-2')}>
        {t('releaseObservation.title') || 'Observation after publication'}
        <ReleaseVerdictBadge observation={observation} />
        <span className="normal-case tracking-normal text-text-muted/70">
          {observation.mode === 'revert' ? (t('releaseObservation.mode.revert') || 'automatic return') : (t('releaseObservation.mode.alert') || 'alert')}
        </span>
      </div>
      {observation.state === 'watching' && (
        <p className="mb-2 text-xs text-text-muted">
          {t('releaseObservation.watchingText', { verdict: label(observation.provisionalVerdict), date: formatDateTime(observation.endsAt, i18n.language), defaultValue: 'Compared with the previous release until {{date}}. So far: {{verdict}}.' })}
        </p>
      )}
      {observation.state === 'superseded' && (
        <p className="mb-2 text-xs text-text-muted">{t('releaseObservation.supersededText') || 'Stopped: another release went live during the window.'}</p>
      )}
      {observation.action === 'reverted' && (
        <p className="mb-2 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-400">
          <RotateCcw size={14} className="mt-0.5 shrink-0" />
          {t('releaseObservation.revertedText', { number: prev ?? '?', defaultValue: 'This release was broken: release #{{number}} was put back automatically.' })}
        </p>
      )}
      {observation.action === 'revertFailed' && (
        <p className="mb-2 rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {t('releaseObservation.revertFailedText') || 'The automatic return failed: this release stayed live.'}
          {observation.actionReason && <span className="block font-mono text-[11px]">{observation.actionReason}</span>}
        </p>
      )}
      {observation.revertBlocked === 'migrations' && observation.mode === 'revert' && (
        <p className="mb-2 text-xs text-amber-400">
          {t('releaseObservation.migrationsText') || 'This release ran database migrations: it is never put back automatically (alert only).'}
        </p>
      )}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex min-w-0 gap-3">
            <dt className="w-32 shrink-0 text-text-muted">{k}</dt>
            <dd className="min-w-0 break-words text-text-secondary">{v}</dd>
          </div>
        ))}
      </dl>
      {observation.reasons.length > 0 && shown !== 'healthy' && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-text-secondary">
          {observation.reasons.map((r) => <li key={r}>{reason(r)}</li>)}
        </ul>
      )}
    </section>
  );
}

/** Settings of a site: mode (off / alert / revert) and window. 'revert' takes releases.publish (server rule too). */
export function ObservationSettingsCard({ site, onSiteChange }: { site: Site; onSiteChange: (s: Site) => void }) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const canManage = can('sites.manage', site.accountId);
  const canRevert = can('releases.publish', site.accountId);
  const [mode, setMode] = useState<ObservationMode>(site.observationMode);
  const [minutes, setMinutes] = useState(String(site.observationWindowMinutes));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const initial = useMemo(() => ({ mode: site.observationMode, minutes: String(site.observationWindowMinutes) }), [site.observationMode, site.observationWindowMinutes]);
  const [last, setLast] = useState(initial);
  if (initial !== last) {
    setLast(initial);
    if (mode === last.mode && minutes === last.minutes) { setMode(initial.mode); setMinutes(initial.minutes); }
  }
  const dirty = mode !== initial.mode || minutes !== initial.minutes;

  const save = async () => {
    setError('');
    const n = Number(minutes);
    if (!Number.isInteger(n) || n < OBSERVATION_WINDOW_MIN_MINUTES || n > OBSERVATION_WINDOW_MAX_MINUTES) {
      setError(t('releaseObservation.settings.windowInvalid', { min: OBSERVATION_WINDOW_MIN_MINUTES, max: OBSERVATION_WINDOW_MAX_MINUTES, defaultValue: 'Between {{min}} and {{max}} minutes.' }));
      return;
    }
    setSaving(true);
    try {
      const updated = await sitesApi.update(site.id, { observationMode: mode, observationWindowMinutes: n });
      onSiteChange(updated);
      setMode(updated.observationMode);
      setMinutes(String(updated.observationWindowMinutes));
      toast.success(t('sites.form.saved') || 'Settings saved');
    } catch (err) {
      setError(siteErrorMessage(err, t));
    } finally {
      setSaving(false);
    }
  };

  const disabled = !canManage || saving;
  return (
    <Card title={t('releaseObservation.title') || 'Observation after publication'} icon={<Activity size={14} className="text-accent" />}>
      <p className="mb-3 text-xs text-text-muted">
        {t('releaseObservation.settings.intro', {
          requests: OBSERVATION_THRESHOLDS.minRequests,
          defaultValue: 'After each publication the new release is compared with the previous one for a while: share of 5xx answers, new PHP errors, a health check every minute. Verdict: healthy, degraded, failed, or not enough traffic (fewer than {{requests}} requests).',
        })}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor={`observation-mode-${site.id}`}>{t('releaseObservation.settings.modeLabel') || 'When a release is degraded or failed'}</label>
          <select id={`observation-mode-${site.id}`} value={mode} onChange={(e) => setMode(e.target.value as ObservationMode)} className={fieldCls} disabled={disabled}>
            <option value="alert">{t('releaseObservation.settings.alert') || 'Alert (recommended)'}</option>
            <option value="revert" disabled={!canRevert && site.observationMode !== 'revert'}>{t('releaseObservation.settings.revert') || 'Put the previous release back if it failed'}</option>
            <option value="off">{t('releaseObservation.settings.off') || 'No observation'}</option>
          </select>
          <p className="mt-1 text-xs text-text-muted">
            {t('releaseObservation.settings.modeHint') || 'Alert: a notification for a degraded or failed release. Automatic return: a failed release is replaced once by the previous one — never a release that ran database migrations (alert only), never after a rollback.'}
          </p>
        </div>
        <div>
          <label className={labelCls} htmlFor={`observation-window-${site.id}`}>{t('releaseObservation.settings.windowLabel') || 'Window (minutes)'}</label>
          <input
            id={`observation-window-${site.id}`}
            type="number"
            inputMode="numeric"
            min={OBSERVATION_WINDOW_MIN_MINUTES}
            max={OBSERVATION_WINDOW_MAX_MINUTES}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            className={fieldCls}
            disabled={disabled || mode === 'off'}
          />
          <p className="mt-1 text-xs text-text-muted">
            {t('releaseObservation.settings.windowHint') || 'A clearly failed release is judged after 2 minutes; otherwise at the end of the window.'}
          </p>
        </div>
      </div>
      {canManage && !canRevert && (
        <p className="mt-3 text-xs text-text-muted">{t('releaseObservation.settings.revertNeedsPublish') || 'The automatic return takes the right to publish releases.'}</p>
      )}
      {canManage && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {error && <p className="mr-auto text-xs text-red-400">{error}</p>}
          {dirty && (
            <Button variant="ghost" size="sm" onClick={() => { setMode(initial.mode); setMinutes(initial.minutes); setError(''); }} disabled={saving}>
              {t('common.cancel') || 'Cancel'}
            </Button>
          )}
          <Button size="sm" onClick={save} loading={saving} disabled={!dirty}>
            <Check size={14} className="mr-1" />
            {t('common.save') || 'Save'}
          </Button>
        </div>
      )}
    </Card>
  );
}
