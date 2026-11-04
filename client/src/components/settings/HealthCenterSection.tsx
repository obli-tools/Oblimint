import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Stethoscope } from 'lucide-react';
import type { HealthCenterSettings, HealthCenterStatus } from '@oblimint/shared';
import {
  HEALTH_CENTER_CONFIRM_MAX, HEALTH_CENTER_CONFIRM_MIN, HEALTH_CENTER_DISK_GIB_MAX, HEALTH_CENTER_DISK_PERCENT_MAX, HEALTH_CENTER_EVENTS,
} from '@oblimint/shared';
import { healthMonitorApi } from '@/api/healthMonitor.api';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Pill } from '@/components/common/Pill';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { Field, SettingsBlock, settingsInputCls } from '@/components/settings/SettingsBlock';
import { hostingErrorMessage, toastHostingError } from '@/components/hosting/hostingUi';
import { STATUS_TONE, componentLabel, healthEventLabel, statusLabel } from '@/components/dashboard/healthCenterUi';

/**
 * Settings page (platform admin, master workspace): the health center —
 * notifications of the platform administrators on a component down / back,
 * the data disk under its thresholds, a backup failing / recovering.
 */
export function HealthCenterSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<HealthCenterStatus | null>(null);
  const [draft, setDraft] = useState<HealthCenterSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await healthMonitorApi.center();
      setStatus(s);
      setDraft(s.settings);
      setError(null);
    } catch (err) {
      setError(hostingErrorMessage(t, err, t('healthCenter.loadFailed') || 'The health center could not be loaded'));
    }
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  const dirty = useMemo(() => !!status && !!draft && JSON.stringify(status.settings) !== JSON.stringify(draft), [status, draft]);
  const title = t('healthCenter.title') || 'Health center';

  if (!status || !draft) {
    return (
      <SettingsBlock id="settings-health-center" icon={<Stethoscope />} title={title}>
        {error ? <p className="flex items-start gap-2 text-sm text-text-muted"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</p> : <div className="flex justify-center py-4"><LoadingSpinner /></div>}
      </SettingsBlock>
    );
  }

  const set = <K extends keyof HealthCenterSettings>(k: K, v: HealthCenterSettings[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const num = (raw: string, min: number, max: number, int: boolean) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, int ? Math.round(n) : n));
  };
  const valid = draft.confirmChecks >= HEALTH_CENTER_CONFIRM_MIN && draft.confirmChecks <= HEALTH_CENTER_CONFIRM_MAX
    && draft.diskMinFreePercent >= 0 && draft.diskMinFreePercent <= HEALTH_CENTER_DISK_PERCENT_MAX
    && draft.diskMinFreeGiB >= 0 && draft.diskMinFreeGiB <= HEALTH_CENTER_DISK_GIB_MAX;

  const save = async () => {
    setSaving(true);
    try {
      const s = await healthMonitorApi.updateCenter(draft);
      setStatus(s);
      setDraft(s.settings);
      toast.success(t('healthCenter.saved') || 'Health center settings saved');
    } catch (err) {
      toastHostingError(t, err, t('healthCenter.saveFailed') || 'The health center settings could not be saved');
    } finally { setSaving(false); }
  };

  return (
    <SettingsBlock
      id="settings-health-center"
      icon={<Stethoscope />}
      title={title}
      description={t('healthCenter.intro') || 'Every minute, the deep checks (database, hostd, edge, DNS, mail, workers) and the data disk of the node are followed, as well as the backup runs. The platform administrators are notified once per change of state — in the bell, by e-mail according to their preferences, and on the notification channels subscribed to these events.'}
      dirty={dirty}
      saving={saving}
      canSave={valid}
      onSave={() => { void save(); }}
      onReset={() => setDraft(status.settings)}
    >
      {!status.workersEnabled && <p className="text-xs text-amber-400">{t('healthCenter.workersOff') || 'Background workers are off on this panel (OBLIMINT_WORKERS=off): nothing is followed.'}</p>}

      {/* Current state (read only; the dashboard card shows the same) */}
      <div className="flex flex-wrap gap-1.5">
        {status.components.map((c) => (
          <Pill key={c.id} tone={STATUS_TONE[c.status]} title={c.detail ?? undefined}>{componentLabel(t, c.id)} · {statusLabel(t, c.status)}</Pill>
        ))}
        <Pill tone={STATUS_TONE[status.disk.status]}>{t('healthCenter.disk') || 'Data disk'} · {statusLabel(t, status.disk.status, true)}</Pill>
      </div>

      <ToggleSwitch
        checked={draft.enabled}
        onChange={(v) => set('enabled', v)}
        label={t('healthCenter.enabled') || 'Notify the platform administrators'}
        description={t('healthCenter.enabledHint') || 'Off: the states are still followed and shown on the dashboard, nothing is sent.'}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label={t('healthCenter.confirmChecks') || 'Checks before a change of state'} htmlFor="hc-confirm"
          hint={t('healthCenter.confirmChecksHint') || 'Consecutive checks (one per minute) needed before a component or the disk is declared down — and as many to declare it back. Avoids alerts on a single hiccup.'}>
          <input id="hc-confirm" type="number" inputMode="numeric" className={settingsInputCls} min={HEALTH_CENTER_CONFIRM_MIN} max={HEALTH_CENTER_CONFIRM_MAX} step={1}
            value={draft.confirmChecks} onChange={(e) => set('confirmChecks', num(e.target.value, HEALTH_CENTER_CONFIRM_MIN, HEALTH_CENTER_CONFIRM_MAX, true))} />
        </Field>
        <Field label={t('healthCenter.diskMinFreePercent') || 'Low disk: free share under (%)'} htmlFor="hc-disk-pct"
          hint={t('healthCenter.diskHint') || 'The data disk of the node is low under either threshold (0 GiB: share only).'}>
          <input id="hc-disk-pct" type="number" inputMode="decimal" className={settingsInputCls} min={0} max={HEALTH_CENTER_DISK_PERCENT_MAX} step={1}
            value={draft.diskMinFreePercent} onChange={(e) => set('diskMinFreePercent', num(e.target.value, 0, HEALTH_CENTER_DISK_PERCENT_MAX, false))} />
        </Field>
        <Field label={t('healthCenter.diskMinFreeGiB') || '…or free space under (GiB)'} htmlFor="hc-disk-gib">
          <input id="hc-disk-gib" type="number" inputMode="decimal" className={settingsInputCls} min={0} max={HEALTH_CENTER_DISK_GIB_MAX} step={1}
            value={draft.diskMinFreeGiB} onChange={(e) => set('diskMinFreeGiB', num(e.target.value, 0, HEALTH_CENTER_DISK_GIB_MAX, false))} />
        </Field>
      </div>

      <div className="space-y-2 border-t border-border pt-4">
        <div className="text-sm font-medium text-text-primary">{t('healthCenter.eventsTitle') || 'Events'}</div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {HEALTH_CENTER_EVENTS.map((e) => (
            <ToggleSwitch
              key={e}
              size="sm"
              checked={draft.events[e]}
              disabled={!draft.enabled}
              onChange={(v) => setDraft((d) => (d ? { ...d, events: { ...d.events, [e]: v } } : d))}
              label={healthEventLabel(t, e)}
            />
          ))}
        </div>
      </div>
    </SettingsBlock>
  );
}
