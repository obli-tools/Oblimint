import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { ArrowRight, Eye, Loader2, RefreshCw, Settings2, ShieldCheck } from 'lucide-react';
import type {
  AutoValidateMode, Site, SiteMaintenanceInfo, SiteMaintenanceSettings, SiteMaintenanceSettingsUpdate, SnapshotMode, SupervisionInfo,
  WindowPendingPolicy,
} from '@oblimint/shared';
import { maintenanceApi, supervisionApi } from '@/api/maintenance.api';
import { databasesApi } from '@/api/databases.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Card, InfoRow, inputCls, isStepUpHandled, labelCls } from '@/components/hosting/hostingUi';
import { formatDateTime } from '@/components/sites/siteForm';
import { cn } from '@/utils/cn';
import { RiskBadge, WindowStatusBadge } from './MaintenanceBadges';
import { browserTimezone, intIn, isValidKickPath } from './maintenanceFormat';
import { isNotImplemented, maintenanceErrorMessage, toastMaintenanceError } from './maintenanceErrors';
import { ScheduleEditor, isWindowCron, useCronHuman } from './ScheduleEditor';

interface Draft {
  pendingPolicy: WindowPendingPolicy;
  autoValidate: AutoValidateMode;
  defaultDurationMinutes: string;
  scheduleEnabled: boolean;
  cron: string;
  timezone: string;
  scheduleDuration: string;
  kickPath: string;
  snapshotMode: SnapshotMode;
  databaseIds: number[];
  supervised: boolean;
  digestIntervalHours: string;
}

function toDraft(s: SiteMaintenanceSettings): Draft {
  return {
    pendingPolicy: s.pendingPolicy,
    autoValidate: s.autoValidate,
    defaultDurationMinutes: String(s.defaultDurationMinutes),
    scheduleEnabled: !!s.schedule?.enabled,
    cron: s.schedule?.cron ?? '0 3 * * 0',
    timezone: s.schedule?.timezone ?? browserTimezone(),
    scheduleDuration: String(s.schedule?.durationMinutes ?? 60),
    kickPath: s.schedule?.kickPath ?? '',
    snapshotMode: s.snapshot.mode,
    databaseIds: [...s.snapshot.databaseIds].sort((a, b) => a - b),
    supervised: s.supervised,
    digestIntervalHours: String(s.digestIntervalHours),
  };
}

interface DbOption { id: number; label: string }

/** Settings of the site windows: policy, auto-validation, schedule, DB snapshots, supervised mode. */
export function SiteMaintenanceSettingsCard({ site, info, onSaved }: {
  site: Site;
  info: SiteMaintenanceInfo;
  onSaved: (info: SiteMaintenanceInfo) => void;
}) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const { can } = useHostingMe();
  const canEdit = can('sites.manage', site.accountId);
  const cronHuman = useCronHuman();
  const max = info.maxWindowMinutes;

  const base = useMemo(() => toDraft(info.settings), [info.settings]);
  const [draft, setDraft] = useState<Draft>(base);
  const baseKey = JSON.stringify(base);
  useEffect(() => { setDraft(base); }, [baseKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(draft) !== baseKey;
  const set = (patch: Partial<Draft>) => { setDraft((d) => ({ ...d, ...patch })); setError(null); };

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Databases of the account (snapshot selection), loaded when needed.
  const [dbs, setDbs] = useState<DbOption[] | null>(null);
  const [dbError, setDbError] = useState<string | null>(null);
  const needDbs = draft.snapshotMode === 'selected';
  useEffect(() => {
    if (!needDbs || dbs !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const instances = await databasesApi.listInstances({ accountId: site.accountId });
        const details = await Promise.allSettled(instances.map((i) => databasesApi.getInstance(i.id)));
        const out: DbOption[] = [];
        details.forEach((d) => {
          if (d.status !== 'fulfilled') return;
          for (const db of d.value.databases) out.push({ id: db.id, label: `${db.name} · ${d.value.name} (${d.value.engine})` });
        });
        if (!cancelled) { setDbs(out.sort((a, b) => a.label.localeCompare(b.label))); setDbError(null); }
      } catch (err) {
        if (!cancelled) { setDbs([]); setDbError(maintenanceErrorMessage(err, t, t('maintenance.settings.dbLoadFailed') || 'Failed to load the databases of the account')); }
      }
    })();
    return () => { cancelled = true; };
  }, [needDbs, dbs, site.accountId, t]);

  const defDuration = intIn(draft.defaultDurationMinutes, 5, max);
  const schedDuration = intIn(draft.scheduleDuration, 5, max);
  const digest = intIn(draft.digestIntervalHours, 1, 168);
  const kick = draft.kickPath.trim();
  const kickOk = !kick || isValidKickPath(kick);
  const cronOk = !draft.scheduleEnabled || isWindowCron(draft.cron);
  const selectionOk = draft.snapshotMode !== 'selected' || draft.databaseIds.length > 0;
  const valid = defDuration !== null && digest !== null && kickOk && cronOk && selectionOk && (!draft.scheduleEnabled || schedDuration !== null);
  const range = (a: number, b: number) => t('maintenance.settings.range', { min: a, max: b, defaultValue: 'Between {{min}} and {{max}}.' });

  const save = async () => {
    if (!valid || defDuration === null || digest === null) return;
    if (draft.supervised !== base.supervised && !(await confirm({
      title: draft.supervised ? (t('maintenance.settings.supervisedOnTitle') || 'Enable supervised mode') : (t('maintenance.settings.supervisedOffTitle') || 'Disable supervised mode'),
      message: draft.supervised
        ? (t('maintenance.settings.supervisedOnConfirm') || 'A permanent window is opened: the application can write its code at any time, executable files written outside a manual window are quarantined at once, and a digest of the changes is sent for review periodically.')
        : (t('maintenance.settings.supervisedOffConfirm') || 'The permanent window is closed: its changes go to review (or are discarded when empty) and the code becomes read-only again.'),
      confirmLabel: t('common.confirm') || 'Confirm',
    }))) return;
    // A disabled schedule is kept (enabled: false) only when its expression is still valid.
    const keepSchedule = draft.scheduleEnabled || (info.settings.schedule !== null && isWindowCron(draft.cron));
    const patch: SiteMaintenanceSettingsUpdate = {
      pendingPolicy: draft.pendingPolicy,
      autoValidate: draft.autoValidate,
      defaultDurationMinutes: defDuration,
      schedule: keepSchedule ? {
        enabled: draft.scheduleEnabled,
        cron: draft.cron.trim(),
        timezone: draft.timezone || 'UTC',
        durationMinutes: schedDuration ?? 60,
        kickPath: kick || null,
      } : null,
      snapshot: { mode: draft.snapshotMode, databaseIds: draft.snapshotMode === 'selected' ? draft.databaseIds : [] },
      supervised: draft.supervised,
      digestIntervalHours: digest,
    };
    setSaving(true);
    setError(null);
    try {
      onSaved(await maintenanceApi.updateSettings(site.id, patch));
      toast.success(t('maintenance.settings.saved') || 'Maintenance settings saved');
    } catch (err) {
      if (!isStepUpHandled(err)) setError(maintenanceErrorMessage(err, t, t('maintenance.settings.saveFailed') || 'Failed to save the settings'));
    } finally {
      setSaving(false);
    }
  };

  const human = draft.scheduleEnabled && cronOk ? cronHuman(draft.cron, draft.timezone) : null;
  const isWordPress = site.appProfile === 'wordpress';

  const policyOptions: Array<{ id: WindowPendingPolicy; label: string; hint: string }> = [
    { id: 'keep', label: t('maintenance.settings.policy.keep') || 'Keep serving the changes', hint: t('maintenance.settings.policy.keepHint') || 'Until the review, the site keeps serving the frozen content of the window (read-only).' },
    { id: 'revert', label: t('maintenance.settings.policy.revert') || 'Go back to the release', hint: t('maintenance.settings.policy.revertHint') || 'At closing, the site serves the live release again at once; the changes stay reviewable and can still be validated.' },
  ];
  const autoOptions: Array<{ id: AutoValidateMode; label: string; hint: string }> = [
    { id: 'off', label: t('maintenance.settings.auto.off') || 'Never', hint: t('maintenance.settings.auto.offHint') || 'Every window waits for a human review.' },
    { id: 'scheduled', label: t('maintenance.settings.auto.scheduled') || 'Scheduled windows', hint: t('maintenance.settings.auto.scheduledHint') || 'A scheduled window is validated automatically when the analysis is clean, the HTTP check passes and the official checksums match.' },
    { id: 'scheduled-api', label: t('maintenance.settings.auto.scheduledApi') || 'Scheduled + API', hint: t('maintenance.settings.auto.scheduledApiHint') || 'Same rule for the windows opened with an API token.' },
  ];
  const snapshotOptions: Array<{ id: SnapshotMode; label: string }> = [
    { id: 'all', label: t('maintenance.settings.snapshot.all') || 'Every database of the account' },
    { id: 'selected', label: t('maintenance.settings.snapshot.selected') || 'Selected databases' },
    { id: 'none', label: t('maintenance.settings.snapshot.none') || 'None' },
  ];

  return (
    <Card title={t('maintenance.settings.title') || 'Window settings'} icon={<Settings2 size={14} className="text-accent" />}>
      <div className="space-y-5">
        {/* Pending policy */}
        <fieldset disabled={!canEdit} className="min-w-0">
          <legend className="mb-2 text-sm font-medium text-text-secondary">{t('maintenance.settings.policy.title') || 'While a review is pending'}</legend>
          <RadioCards value={draft.pendingPolicy} options={policyOptions} onChange={(v) => set({ pendingPolicy: v })} cols="md:grid-cols-2" />
        </fieldset>

        {/* Auto-validation */}
        <fieldset disabled={!canEdit} className="min-w-0">
          <legend className="mb-2 text-sm font-medium text-text-secondary">{t('maintenance.settings.auto.title') || 'Automatic validation'}</legend>
          <RadioCards value={draft.autoValidate} options={autoOptions} onChange={(v) => set({ autoValidate: v })} cols="md:grid-cols-3" />
        </fieldset>

        <div className="max-w-xs">
          <label className={labelCls} htmlFor="mt-default-duration">{t('maintenance.settings.defaultDuration') || 'Default duration of a manual window (minutes)'}</label>
          <input id="mt-default-duration" type="number" inputMode="numeric" min={5} max={max} disabled={!canEdit} value={draft.defaultDurationMinutes} onChange={(e) => set({ defaultDurationMinutes: e.target.value })} className={cn(inputCls, 'font-mono', defDuration === null && 'ring-1 ring-status-down')} />
          {defDuration === null && <p className="mt-1 text-xs text-status-down">{range(5, max)}</p>}
        </div>

        {/* Schedule */}
        <div className="space-y-3 rounded-lg bg-bg-primary p-3">
          <ToggleSwitch
            checked={draft.scheduleEnabled}
            disabled={!canEdit}
            onChange={(v) => set({ scheduleEnabled: v })}
            label={t('maintenance.settings.schedule.enabled') || 'Scheduled window'}
            description={t('maintenance.settings.schedule.enabledHint') || "Opens a window at fixed times so that the application's own updates (e.g. WordPress auto-updates) can run."}
          />
          {draft.scheduleEnabled && (
            <>
              <ScheduleEditor idPrefix="mt-sched" cron={draft.cron} timezone={draft.timezone} disabled={!canEdit} onChange={(v) => set({ cron: v.cron, timezone: v.timezone })} />
              {human && <p className="text-xs text-text-secondary">{t('maintenance.settings.schedule.human', { text: human, defaultValue: 'Opens: {{text}}' })}</p>}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
                <div>
                  <label className={labelCls} htmlFor="mt-sched-duration">{t('maintenance.settings.schedule.duration') || 'Duration (minutes)'}</label>
                  <input id="mt-sched-duration" type="number" inputMode="numeric" min={5} max={max} disabled={!canEdit} value={draft.scheduleDuration} onChange={(e) => set({ scheduleDuration: e.target.value })} className={cn(inputCls, 'font-mono', schedDuration === null && 'ring-1 ring-status-down')} />
                  {schedDuration === null && <p className="mt-1 text-xs text-status-down">{range(5, max)}</p>}
                </div>
                <div className="min-w-0">
                  <label className={labelCls} htmlFor="mt-kick">{t('maintenance.settings.schedule.kickPath') || 'Path to call during the window (optional)'}</label>
                  <div className="flex gap-2">
                    <input id="mt-kick" value={draft.kickPath} disabled={!canEdit} onChange={(e) => set({ kickPath: e.target.value })} placeholder="/wp-cron.php" autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(inputCls, 'min-w-0 font-mono', !kickOk && 'ring-1 ring-status-down')} />
                    {isWordPress && canEdit && draft.kickPath.trim() !== '/wp-cron.php' && (
                      <Button size="sm" variant="secondary" onClick={() => set({ kickPath: '/wp-cron.php' })}>/wp-cron.php</Button>
                    )}
                  </div>
                  <p className={cn('mt-1 text-xs', kickOk ? 'text-text-muted' : 'text-status-down')}>
                    {kickOk
                      ? (t('maintenance.settings.schedule.kickHint') || 'Requested every 5 minutes while the scheduled window is open, so that the application scheduler runs (WordPress: /wp-cron.php).')
                      : (t('maintenance.settings.schedule.kickInvalid') || 'An absolute path starting with /, without host or space.')}
                  </p>
                </div>
              </div>
              {!cronOk && <p className="text-xs text-status-down">{t('maintenance.errors.invalidSchedule') || 'Invalid schedule: 5 fields (minute hour day month weekday) and a valid time zone.'}</p>}
              {info.nextScheduledAt && <p className="text-xs text-text-muted">{t('maintenance.settings.schedule.next', { date: formatDateTime(info.nextScheduledAt, i18n.language), defaultValue: 'Next opening: {{date}}' })}</p>}
            </>
          )}
        </div>

        {/* Database snapshots */}
        <fieldset disabled={!canEdit} className="min-w-0 space-y-2">
          <legend className="mb-1 text-sm font-medium text-text-secondary">{t('maintenance.settings.snapshot.title') || 'Database snapshots before a window or an update'}</legend>
          <div role="radiogroup" className="flex flex-wrap gap-1.5">
            {snapshotOptions.map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={draft.snapshotMode === o.id}
                onClick={() => set({ snapshotMode: o.id })}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 coarse:min-h-10',
                  draft.snapshotMode === o.id ? 'border-accent bg-accent/10 text-accent' : 'border-transparent bg-bg-tertiary text-text-muted hover:border-accent/30',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
          {draft.snapshotMode === 'selected' && (
            dbs === null ? (
              <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
            ) : dbError ? (
              <p className="text-xs text-status-down">{dbError}</p>
            ) : dbs.length === 0 ? (
              <p className="text-xs text-text-muted">{t('maintenance.settings.snapshot.noDb') || 'The account has no database.'}</p>
            ) : (
              <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {dbs.map((db) => {
                  const checked = draft.databaseIds.includes(db.id);
                  return (
                    <li key={db.id}>
                      <label className="flex cursor-pointer items-center gap-2 rounded-md bg-bg-primary px-3 py-2 text-sm text-text-secondary coarse:min-h-10">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-accent"
                          checked={checked}
                          onChange={() => set({ databaseIds: (checked ? draft.databaseIds.filter((x) => x !== db.id) : [...draft.databaseIds, db.id]).sort((a, b) => a - b) })}
                        />
                        <span className="min-w-0 truncate font-mono text-xs">{db.label}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )
          )}
          {!selectionOk && dbs && dbs.length > 0 && <p className="text-xs text-status-down">{t('maintenance.settings.snapshot.pickOne') || 'Select at least one database.'}</p>}
          <p className="text-xs text-text-muted">{t('maintenance.settings.snapshot.hint') || 'The database is not immutable: a snapshot is taken when a window opens or an update starts, so that a rejection can restore it.'}</p>
        </fieldset>

        {/* Supervised mode */}
        <div className="space-y-3 rounded-lg bg-bg-primary p-3">
          <ToggleSwitch
            checked={draft.supervised}
            disabled={!canEdit}
            onChange={(v) => set({ supervised: v })}
            label={t('maintenance.settings.supervised') || 'Supervised mode'}
            description={t('maintenance.settings.supervisedHint') || 'For applications that must write their code at any time: permanent window, executable files written outside a manual window are quarantined immediately, periodic digest to review.'}
          />
          {draft.supervised && (
            <div className="max-w-xs">
              <label className={labelCls} htmlFor="mt-digest">{t('maintenance.settings.digestInterval') || 'Digest every (hours)'}</label>
              <input id="mt-digest" type="number" inputMode="numeric" min={1} max={168} disabled={!canEdit} value={draft.digestIntervalHours} onChange={(e) => set({ digestIntervalHours: e.target.value })} className={cn(inputCls, 'font-mono', digest === null && 'ring-1 ring-status-down')} />
              {digest === null && <p className="mt-1 text-xs text-status-down">{range(1, 168)}</p>}
            </div>
          )}
        </div>

        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
        {canEdit ? (
          <div className={cn('flex flex-wrap items-center justify-end gap-2', !dirty && 'hidden')}>
            <Button size="sm" variant="secondary" disabled={saving} onClick={() => { setDraft(base); setError(null); }}>{t('common.cancel') || 'Cancel'}</Button>
            <Button size="sm" loading={saving} disabled={!valid} onClick={() => { void save(); }}>{t('common.save') || 'Save'}</Button>
          </div>
        ) : (
          <p className="text-xs text-text-muted">{t('maintenance.settings.readOnly') || 'Read only: changing these settings needs the right to manage the site.'}</p>
        )}
      </div>
    </Card>
  );
}

function RadioCards<T extends string>({ value, options, onChange, cols }: {
  value: T;
  options: Array<{ id: T; label: string; hint: string }>;
  onChange: (v: T) => void;
  cols: string;
}) {
  return (
    <div role="radiogroup" className={cn('grid grid-cols-1 gap-2', cols)}>
      {options.map((o) => {
        const selected = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.id)}
            className={cn('rounded-lg border-2 p-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-60', selected ? 'border-accent bg-accent/5' : 'border-transparent bg-bg-primary hover:border-accent/30')}
          >
            <div className="text-sm font-semibold text-text-primary">{o.label}</div>
            <p className="mt-1 text-xs text-text-secondary">{o.hint}</p>
          </button>
        );
      })}
    </div>
  );
}

/** Supervised mode: permanent window, quarantined executables, digest (shown when the mode is on). */
export function SupervisionCard({ site, tick }: { site: Site; tick: number }) {
  const { t, i18n } = useTranslation();
  const { can } = useHostingMe();
  const canPublish = can('releases.publish', site.accountId);
  const [info, setInfo] = useState<SupervisionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setInfo(await supervisionApi.get(site.id));
      setError(null);
    } catch (err) {
      setInfo(null);
      setError(isNotImplemented(err)
        ? (t('maintenance.notAvailable') || 'Not available on this server yet.')
        : maintenanceErrorMessage(err, t, t('supervision.loadFailed') || 'Failed to load the supervision state'));
    }
  }, [site.id, t]);
  useEffect(() => { void load(); }, [load, tick]);

  const digestNow = async () => {
    setBusy(true);
    try {
      setInfo(await supervisionApi.digest(site.id));
      toast.success(t('supervision.digested') || 'Digest computed');
    } catch (err) {
      toastMaintenanceError(err, t, t('supervision.digestFailed') || 'Failed to compute the digest');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={t('supervision.title') || 'Supervised mode'}
      icon={<ShieldCheck size={14} className="text-accent" />}
      actions={(
        <>
          {canPublish && info?.enabled && (
            <Button size="sm" variant="secondary" loading={busy} onClick={() => { void digestNow(); }}>
              <RefreshCw size={13} className="mr-1.5" />{t('supervision.digestNow') || 'Digest now'}
            </Button>
          )}
        </>
      )}
    >
      {error ? (
        <p className="text-xs text-text-muted">{error}</p>
      ) : !info ? (
        <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <InfoRow label={t('supervision.window') || 'Permanent window'}>
              {info.windowStatus ? <WindowStatusBadge status={info.windowStatus} /> : '—'}
            </InfoRow>
            <InfoRow label={t('supervision.pending') || 'Changes since the last validation'} mono>{info.pendingChanges ?? '—'}</InfoRow>
            <InfoRow label={t('supervision.risk') || 'Risk'}><RiskBadge risk={info.risk} /></InfoRow>
            <InfoRow label={t('supervision.quarantined') || 'Quarantined executables'} mono>
              {info.quarantined > 0 ? <Link to="/maintenance?tab=quarantine" className="text-red-400 hover:underline">{info.quarantined}</Link> : 0}
            </InfoRow>
            <InfoRow label={t('supervision.lastDigest') || 'Last digest'}><span className="text-[13px]">{formatDateTime(info.lastDigestAt, i18n.language)}</span></InfoRow>
            <InfoRow label={t('supervision.nextDigest') || 'Next digest'}><span className="text-[13px]">{formatDateTime(info.nextDigestAt, i18n.language)}</span></InfoRow>
            {info.execAllowedUntil && (
              <InfoRow label={t('maintenance.window.execAllowed') || 'Executables allowed until'}><span className="text-[13px]">{formatDateTime(info.execAllowedUntil, i18n.language)}</span></InfoRow>
            )}
          </div>
          {info.windowId != null && (
            <Link to={`/sites/${site.id}/windows/${info.windowId}`} className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
              <Eye size={14} />{t('supervision.review') || 'Review the accumulated changes'}<ArrowRight size={13} />
            </Link>
          )}
          <p className="text-xs text-text-muted">{t('supervision.hint') || 'Validating the digest closes and validates the permanent window: a new one opens on the new release.'}</p>
        </div>
      )}
    </Card>
  );
}
