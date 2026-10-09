import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, CheckCircle2, DownloadCloud, FlaskConical, Radar, RefreshCw, Wrench, XCircle } from 'lucide-react';
import type { HostingSettings, HostingSettingsUpdate, ScanTestResult, ScannerEngineStatus, ScannerStatus } from '@oblimint/shared';
import { hostingSettingsApi } from '@/api/hostingSettings.api';
import { scannerApi } from '@/api/maintenance.api';
import { isStepUpHandled } from '@/api/client';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { Field, SettingsBlock, settingsInputCls } from '@/components/settings/SettingsBlock';
import { InfoRow } from '@/components/hosting/hostingUi';
import { formatDateTime } from '@/components/sites/siteForm';
import { Pill } from '@/components/sites/SiteBadges';
import { cn } from '@/utils/cn';
import { useEngineLabel } from './MaintenanceBadges';
import { intIn } from './maintenanceFormat';
import { isNotImplemented, maintenanceErrorMessage, toastMaintenanceError } from './maintenanceErrors';

type ScannerForm = { enabled: boolean; clamav: boolean; yara: boolean; reviewScore: string; blockScore: string; maxFileSizeMb: string; signatureChecksPerDay: string };
type MaintenanceForm = {
  windowsEnabled: boolean; maxWindowMinutes: string; snapshotRetentionDays: string; maxSnapshotsPerSite: string;
  autoValidateRequireChecksums: boolean; adaptersEnabled: boolean; adapterTimeoutMinutes: string; adapterMemoryMb: string; typedWatcher: boolean;
};

/**
 * Settings page (platform admin): scanner status + settings (section `scanner`
 * of /api/system/hosting-settings, /api/system/scanner status / update / test)
 * and maintenance settings (section `maintenance`) — docs/P3-PLAN.md §13.
 * OWNED BY MODULE `ui-maintenance`.
 */
export function MaintenanceSettingsSections() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<HostingSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    hostingSettingsApi.get()
      .then((s) => { if (!cancelled) { setSettings(s); setError(null); } })
      .catch((err) => { if (!cancelled) setError(maintenanceErrorMessage(err, t, t('scanner.settings.loadFailed') || 'Failed to load the settings')); });
    return () => { cancelled = true; };
  }, [t]);

  const save = async (patch: HostingSettingsUpdate): Promise<string | null> => {
    try {
      setSettings(await hostingSettingsApi.update(patch));
      toast.success(t('scanner.settings.saved') || 'Settings saved');
      return null;
    } catch (err) {
      if (isStepUpHandled(err)) return '';
      return maintenanceErrorMessage(err, t, t('scanner.settings.saveFailed') || 'Failed to save the settings');
    }
  };

  return (
    <>
      <ScannerStatusBlock />
      {!settings ? (
        <SettingsBlock icon={<Wrench />} title={t('scanner.settings.title') || 'Scanner and updates'}>
          {error ? <p className="flex items-start gap-2 text-sm text-text-muted"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</p> : <div className="flex justify-center py-4"><LoadingSpinner /></div>}
        </SettingsBlock>
      ) : (
        <>
          {settings.scanner && <ScannerSettingsBlock value={settings.scanner} save={save} />}
          {settings.maintenance && <MaintenancePlatformBlock value={settings.maintenance} save={save} />}
        </>
      )}
    </>
  );
}

/** Form draft that follows the saved value until edited. */
function useDraft<T>(value: T): [T, (patch: Partial<T>) => void, boolean, () => void] {
  const [draft, setDraft] = useState<T>(value);
  const [base, setBase] = useState<T>(value);
  const key = JSON.stringify(value);
  useEffect(() => { setDraft(value); setBase(value); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return [draft, (patch) => setDraft((d) => ({ ...d, ...patch })), JSON.stringify(draft) !== JSON.stringify(base), () => setDraft(base)];
}

function NumberField({ id, label, value, onChange, min, max, hint }: { id: string; label: string; value: string; onChange: (v: string) => void; min: number; max: number; hint?: string }) {
  const { t } = useTranslation();
  const ok = intIn(value, min, max) !== null;
  return (
    <Field label={label} htmlFor={id} hint={hint} error={ok ? null : t('maintenance.settings.range', { min, max, defaultValue: 'Between {{min}} and {{max}}.' })}>
      <input id={id} type="number" inputMode="numeric" min={min} max={max} value={value} onChange={(e) => onChange(e.target.value)} className={cn(settingsInputCls, 'font-mono', !ok && 'ring-2 ring-status-down/50')} />
    </Field>
  );
}

// ── Scanner status ──────────────────────────────────────────────────────────

function ScannerStatusBlock() {
  const { t, i18n } = useTranslation();
  const engineLabel = useEngineLabel();
  const [status, setStatus] = useState<ScannerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'update' | 'test' | null>(null);
  const [test, setTest] = useState<ScanTestResult | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await scannerApi.status());
      setError(null);
    } catch (err) {
      setStatus(null);
      setError(isNotImplemented(err) ? (t('maintenance.notAvailable') || 'Not available on this server yet.') : maintenanceErrorMessage(err, t, t('scanner.status.loadFailed') || 'Failed to load the scanner status'));
    }
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  const update = async () => {
    setBusy('update');
    try {
      setStatus(await scannerApi.update());
      toast.success(t('scanner.status.updated') || 'Signatures updated');
    } catch (err) {
      toastMaintenanceError(err, t, t('scanner.status.updateFailed') || 'Failed to update the signatures');
    } finally {
      setBusy(null);
    }
  };

  const runTest = async () => {
    setBusy('test');
    setTest(null);
    try {
      setTest(await scannerApi.test());
    } catch (err) {
      toastMaintenanceError(err, t, t('scanner.status.testFailed') || 'The test could not run');
    } finally {
      setBusy(null);
    }
  };

  const engine = (name: string, e: ScannerEngineStatus) => (
    <div className="rounded-lg bg-bg-primary p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-text-primary">{name}</span>
        {!e.enabled
          ? <Pill tone="muted">{t('scanner.status.disabled') || 'disabled'}</Pill>
          : e.available
            ? <Pill tone="green">{t('scanner.status.available') || 'available'}</Pill>
            : <Pill tone="red">{t('scanner.status.unavailable') || 'unavailable'}</Pill>}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <InfoRow label={t('infra.version') || 'Version'} mono>{e.version ?? '—'}</InfoRow>
        <InfoRow label={t('scanner.status.signatures') || 'Signatures'} mono>{e.signatureVersion ?? '—'}</InfoRow>
        <InfoRow label={t('scanner.status.signaturesDate') || 'Updated'}><span className="text-[13px]">{formatDateTime(e.signaturesUpdatedAt, i18n.language)}</span></InfoRow>
        <InfoRow label={t('scanner.status.rules') || 'Rules'} mono>{e.ruleCount ?? '—'}</InfoRow>
      </div>
      {e.error && <p className="mt-2 break-words font-mono text-[11px] text-status-down">{e.error}</p>}
    </div>
  );

  return (
    <SettingsBlock
      id="settings-scanner-status"
      icon={<Radar />}
      title={t('scanner.status.title') || 'Scanner'}
      description={t('scanner.status.description') || 'Shared ClamAV + YARA container (oblimint-scanner) used before every publication and on the windows; the heuristics of the panel always run.'}
      headerExtra={<IconButton label={t('common.refresh') || 'Refresh'} icon={<RefreshCw size={14} />} onClick={() => { void load(); }} />}
    >
      {error ? (
        <p className="flex items-start gap-2 text-sm text-text-muted"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</p>
      ) : !status ? (
        <div className="flex justify-center py-4"><LoadingSpinner /></div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {!status.deployed
              ? <Pill tone="red">{t('infra.notDeployed') || 'not deployed'}</Pill>
              : status.running
                ? <Pill tone="green">{t('infra.running') || 'running'}</Pill>
                : <Pill tone="amber">{t('infra.stopped') || 'stopped'}</Pill>}
            <span className="text-xs text-text-muted">{t('scanner.status.heuristics', { count: status.heuristics.ruleCount, defaultValue: 'Heuristics: {{count}} rules' })}</span>
            <span className="text-xs text-text-muted">· {t('scanner.status.lastScan', { date: formatDateTime(status.lastScanAt, i18n.language), defaultValue: 'last scan: {{date}}' })}</span>
            {!status.deployed && (
              <Link to="/manage/nodes" className="ml-auto text-sm text-accent hover:underline">{t('scanner.status.deployLink') || 'Deploy from the Nodes page'}</Link>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {engine('ClamAV', status.clamav)}
            {engine('YARA', status.yara)}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" loading={busy === 'update'} disabled={busy !== null || !status.running} onClick={() => { void update(); }}>
              <DownloadCloud size={14} className="mr-1.5" />{t('scanner.status.update') || 'Update the signatures'}
            </Button>
            <Button size="sm" variant="secondary" loading={busy === 'test'} disabled={busy !== null} onClick={() => { void runTest(); }}>
              <FlaskConical size={14} className="mr-1.5" />{t('scanner.status.test') || 'Test (EICAR)'}
            </Button>
          </div>
          {test && (
            <div className={cn('rounded-lg border p-3 text-sm', test.ok ? 'border-status-up/30 bg-status-up/5 text-status-up' : 'border-red-400/30 bg-red-500/10 text-red-400')}>
              <div className="flex items-center gap-2">
                {test.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
                {test.ok ? (t('scanner.status.testOk') || 'The test samples were detected.') : (t('scanner.status.testKo') || 'The test samples were NOT all detected.')}
              </div>
              {test.detections.length > 0 && (
                <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-text-secondary">
                  {test.detections.map((d, i) => <li key={`${d.engine}:${d.rule}:${i}`}>{engineLabel(d.engine)} — {d.rule}</li>)}
                </ul>
              )}
              {test.error && <p className="mt-1 break-words font-mono text-[11px]">{test.error}</p>}
            </div>
          )}
        </div>
      )}
    </SettingsBlock>
  );
}

// ── Scanner settings ────────────────────────────────────────────────────────

function ScannerSettingsBlock({ value, save }: { value: HostingSettings['scanner']; save: (p: HostingSettingsUpdate) => Promise<string | null> }) {
  const { t } = useTranslation();
  const form: ScannerForm = {
    enabled: value.enabled, clamav: value.clamav, yara: value.yara,
    reviewScore: String(value.reviewScore), blockScore: String(value.blockScore),
    maxFileSizeMb: String(value.maxFileSizeMb), signatureChecksPerDay: String(value.signatureChecksPerDay),
  };
  const [draft, set, dirty, reset] = useDraft(form);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const review = intIn(draft.reviewScore, 1, 100);
  const block = intIn(draft.blockScore, 1, 100);
  const size = intIn(draft.maxFileSizeMb, 1, 512);
  const checks = intIn(draft.signatureChecksPerDay, 1, 24);
  const order = review !== null && block !== null && review <= block;
  const valid = review !== null && block !== null && size !== null && checks !== null && order;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    const err = await save({ scanner: { enabled: draft.enabled, clamav: draft.clamav, yara: draft.yara, reviewScore: review!, blockScore: block!, maxFileSizeMb: size!, signatureChecksPerDay: checks! } });
    setSaving(false);
    setError(err || null);
  };

  return (
    <SettingsBlock
      id="settings-scanner"
      icon={<Radar />}
      title={t('scanner.settings.scannerTitle') || 'Scanner settings'}
      dirty={dirty} saving={saving} canSave={valid} onSave={() => { void submit(); }} onReset={() => { reset(); setError(null); }} error={error}
    >
      <ToggleSwitch
        checked={draft.enabled}
        onChange={(v) => set({ enabled: v })}
        label={t('scanner.settings.enabled') || 'Use the scanner container'}
        description={t('scanner.settings.enabledHint') || 'Deployed at boot when on. Off: heuristics only (and never an automatic validation when the scanner is expected but unreachable).'}
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ToggleSwitch checked={draft.clamav} disabled={!draft.enabled} onChange={(v) => set({ clamav: v })} label="ClamAV" description={t('scanner.settings.clamavHint') || 'Antivirus daemon (≈ 1 GB of RAM with the full signatures).'} />
        <ToggleSwitch checked={draft.yara} disabled={!draft.enabled} onChange={(v) => set({ yara: v })} label="YARA" description={t('scanner.settings.yaraHint') || 'Rules for PHP webshells and obfuscated code.'} />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <NumberField id="sc-review" label={t('scanner.settings.reviewScore') || 'Review score'} value={draft.reviewScore} onChange={(v) => set({ reviewScore: v })} min={1} max={100} hint={t('scanner.settings.reviewScoreHint') || 'From this score, a change needs a human review.'} />
        <NumberField id="sc-block" label={t('scanner.settings.blockScore') || 'Block score'} value={draft.blockScore} onChange={(v) => set({ blockScore: v })} min={1} max={100} hint={t('scanner.settings.blockScoreHint') || 'From this score (or a ClamAV hit), only a staff override publishes.'} />
        <NumberField id="sc-size" label={t('scanner.settings.maxFileSizeMb') || 'Largest scanned file (MB)'} value={draft.maxFileSizeMb} onChange={(v) => set({ maxFileSizeMb: v })} min={1} max={512} />
        <NumberField id="sc-checks" label={t('scanner.settings.signatureChecksPerDay') || 'Signature checks per day'} value={draft.signatureChecksPerDay} onChange={(v) => set({ signatureChecksPerDay: v })} min={1} max={24} />
      </div>
      {review !== null && block !== null && !order && (
        <p className="text-xs text-status-down">{t('scanner.settings.order') || 'The review score must not exceed the block score.'}</p>
      )}
    </SettingsBlock>
  );
}

// ── Maintenance settings ────────────────────────────────────────────────────

function MaintenancePlatformBlock({ value, save }: { value: HostingSettings['maintenance']; save: (p: HostingSettingsUpdate) => Promise<string | null> }) {
  const { t } = useTranslation();
  const form: MaintenanceForm = {
    windowsEnabled: value.windowsEnabled,
    maxWindowMinutes: String(value.maxWindowMinutes),
    snapshotRetentionDays: String(value.snapshotRetentionDays),
    maxSnapshotsPerSite: String(value.maxSnapshotsPerSite),
    autoValidateRequireChecksums: value.autoValidateRequireChecksums,
    adaptersEnabled: value.adaptersEnabled,
    adapterTimeoutMinutes: String(value.adapterTimeoutMinutes),
    adapterMemoryMb: String(value.adapterMemoryMb),
    typedWatcher: value.typedWatcher,
  };
  const [draft, set, dirty, reset] = useDraft(form);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const maxWin = intIn(draft.maxWindowMinutes, 15, 10080);
  const retention = intIn(draft.snapshotRetentionDays, 1, 365);
  const maxSnap = intIn(draft.maxSnapshotsPerSite, 1, 100);
  const timeout = intIn(draft.adapterTimeoutMinutes, 1, 240);
  const memory = intIn(draft.adapterMemoryMb, 256, 8192);
  const valid = maxWin !== null && retention !== null && maxSnap !== null && timeout !== null && memory !== null;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    const err = await save({
      maintenance: {
        windowsEnabled: draft.windowsEnabled, maxWindowMinutes: maxWin!, snapshotRetentionDays: retention!, maxSnapshotsPerSite: maxSnap!,
        autoValidateRequireChecksums: draft.autoValidateRequireChecksums, adaptersEnabled: draft.adaptersEnabled,
        adapterTimeoutMinutes: timeout!, adapterMemoryMb: memory!, typedWatcher: draft.typedWatcher,
      },
    });
    setSaving(false);
    setError(err || null);
  };

  return (
    <SettingsBlock
      id="settings-maintenance"
      icon={<Wrench />}
      title={t('scanner.settings.maintenanceTitle') || 'Windows and updates'}
      description={t('scanner.settings.maintenanceDescription') || 'Modification windows, database snapshots, application adapters and typed data path watcher.'}
      dirty={dirty} saving={saving} canSave={valid} onSave={() => { void submit(); }} onReset={() => { reset(); setError(null); }} error={error}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ToggleSwitch checked={draft.windowsEnabled} onChange={(v) => set({ windowsEnabled: v })} label={t('scanner.settings.windowsEnabled') || 'Modification windows'} description={t('scanner.settings.windowsEnabledHint') || 'Off: no new window (manual, scheduled, API or supervised) can be opened.'} />
        <ToggleSwitch checked={draft.autoValidateRequireChecksums} onChange={(v) => set({ autoValidateRequireChecksums: v })} label={t('scanner.settings.requireChecksums') || 'Auto-validation requires official checksums'} description={t('scanner.settings.requireChecksumsHint') || 'Every changed executable file must match an official checksum (WordPress core and plugins) to be validated without a human.'} />
        <ToggleSwitch checked={draft.adaptersEnabled} onChange={(v) => set({ adaptersEnabled: v })} label={t('scanner.settings.adaptersEnabled') || 'Application adapters'} description={t('scanner.settings.adaptersEnabledHint') || 'WP-CLI, Composer, drush and occ in disposable tools containers.'} />
        <ToggleSwitch checked={draft.typedWatcher} onChange={(v) => set({ typedWatcher: v })} label={t('scanner.settings.typedWatcher') || 'Watch the typed data paths'} description={t('scanner.settings.typedWatcherHint') || 'Files that do not match a typed data path (extension, PHP content, polyglot) are quarantined as soon as they are written.'} />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <NumberField id="mt-max" label={t('scanner.settings.maxWindowMinutes') || 'Longest window (minutes)'} value={draft.maxWindowMinutes} onChange={(v) => set({ maxWindowMinutes: v })} min={15} max={10080} />
        <NumberField id="mt-retention" label={t('scanner.settings.snapshotRetentionDays') || 'Snapshots kept (days)'} value={draft.snapshotRetentionDays} onChange={(v) => set({ snapshotRetentionDays: v })} min={1} max={365} />
        <NumberField id="mt-maxsnap" label={t('scanner.settings.maxSnapshotsPerSite') || 'Snapshots per site (max)'} value={draft.maxSnapshotsPerSite} onChange={(v) => set({ maxSnapshotsPerSite: v })} min={1} max={100} />
        <NumberField id="mt-timeout" label={t('scanner.settings.adapterTimeoutMinutes') || 'Adapter step time limit (minutes)'} value={draft.adapterTimeoutMinutes} onChange={(v) => set({ adapterTimeoutMinutes: v })} min={1} max={240} />
        <NumberField id="mt-memory" label={t('scanner.settings.adapterMemoryMb') || 'Adapter container memory (MB)'} value={draft.adapterMemoryMb} onChange={(v) => set({ adapterMemoryMb: v })} min={256} max={8192} />
      </div>
    </SettingsBlock>
  );
}
