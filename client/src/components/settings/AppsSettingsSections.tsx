import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Boxes, Building2, HeartPulse, Network } from 'lucide-react';
import {
  APP_CAP_ADD_ALLOWED, type AppsSettings, type HostingSettings, type HostingSettingsUpdate, type MonitoringSettings, type NetworkSettings,
  type TenantAppPolicy,
} from '@oblimint/shared';
import { hostingSettingsApi } from '@/api/hostingSettings.api';
import { appsApi } from '@/api/apps.api';
import { isStepUpHandled } from '@/api/client';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { useTenantStore } from '@/store/tenantStore';
import { cn } from '@/utils/cn';
import { ChipsInput } from './ChipsInput';
import { Field, SettingsBlock, settingsInputCls } from './SettingsBlock';
import { appsErrorMessage } from '@/components/apps/appsErrors';
import { REGISTRY_RE } from '@/components/apps/appsFormat';

/**
 * Settings page sections of P4b owned by `ui-apps` (docs/P4b-PLAN.md §13, §17):
 * `apps` (registries, denied images, build, console, cap_add, defaults, git /
 * update / ZIP limits, retention), `monitoring`, `network` (policy mode) of
 * GET / PUT /api/system/hosting-settings, + the per-tenant app policy
 * (/api/apps/policy/tenants/:id, master tenant only). Rendered by SettingsPage
 * for platform admins. OWNED BY MODULE `ui-apps`.
 */
export function AppsSettingsSections() {
  const { t } = useTranslation();
  const isMaster = useIsMasterTenant();
  const [settings, setSettings] = useState<HostingSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    hostingSettingsApi.get()
      .then((s) => { if (!cancelled) { setSettings(s); setError(null); } })
      .catch((err) => { if (!cancelled) setError(appsErrorMessage(t, err, t('apps.settingsPage.loadFailed') || 'Failed to load the settings')); });
    return () => { cancelled = true; };
  }, [t]);

  /** Saves one section; returns an error message ('' = already reported) or null. */
  const save = async (patch: HostingSettingsUpdate): Promise<string | null> => {
    try {
      setSettings(await hostingSettingsApi.update(patch));
      toast.success(t('apps.settingsPage.saved') || 'Settings saved');
      return null;
    } catch (err) {
      if (isStepUpHandled(err)) return '';
      return appsErrorMessage(t, err, t('apps.settingsPage.saveFailed') || 'Failed to save the settings');
    }
  };

  if (!settings?.apps || !settings.monitoring || !settings.network) {
    return (
      <SettingsBlock icon={<Boxes />} title={t('apps.settingsPage.appsTitle') || 'Applications'}>
        {error ? <p className="flex items-start gap-2 text-sm text-text-muted"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</p> : <div className="flex justify-center py-4"><LoadingSpinner /></div>}
      </SettingsBlock>
    );
  }
  return (
    <>
      <AppsBlock value={settings.apps} save={save} />
      {isMaster && <TenantPolicyBlock />}
      <MonitoringBlock value={settings.monitoring} save={save} />
      <NetworkBlock value={settings.network} save={save} />
    </>
  );
}

type SaveFn = (patch: HostingSettingsUpdate) => Promise<string | null>;

/** Form draft following the saved value until edited. */
function useDraft<T>(value: T): [T, (patch: Partial<T>) => void, boolean, () => void] {
  const [draft, setDraft] = useState<T>(value);
  const key = JSON.stringify(value);
  useEffect(() => { setDraft(value); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return [draft, (patch) => setDraft((d) => ({ ...d, ...patch })), JSON.stringify(draft) !== key, () => setDraft(value)];
}

function num(v: string, min: number, max: number, int = true): number | null {
  const s = v.trim().replace(',', '.');
  if (!(int ? /^\d+$/ : /^\d+(\.\d+)?$/).test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

function NumField({ id, label, value, onChange, min, max, hint, decimals = false }: {
  id: string; label: string; value: string; onChange: (v: string) => void; min: number; max: number; hint?: ReactNode; decimals?: boolean;
}) {
  const { t } = useTranslation();
  const ok = num(value, min, max, !decimals) !== null;
  return (
    <Field label={label} htmlFor={id} hint={hint} error={ok ? null : t('apps.settingsPage.range', { min, max, defaultValue: 'Between {{min}} and {{max}}.' })}>
      <input id={id} type="number" inputMode={decimals ? 'decimal' : 'numeric'} step={decimals ? '0.05' : '1'} min={min} max={max} value={value} onChange={(e) => onChange(e.target.value)} className={cn(settingsInputCls, 'font-mono', !ok && 'ring-2 ring-status-down/50')} />
    </Field>
  );
}

// ── apps ────────────────────────────────────────────────────────────────────

const APP_NUMS = {
  defaultServiceMemoryMb: [16, 65536, false],
  defaultServiceCpus: [0.05, 64, true],
  maxServicesPerStack: [1, 100, false],
  gitPollMinSec: [30, 86400, false],
  updateCheckMinMinutes: [15, 10080, false],
  zipMaxMb: [1, 1024, false],
  zipMaxExpandedMb: [1, 8192, false],
  deploymentRetention: [10, 1000, false],
  deploymentRetentionDays: [1, 3650, false],
} as const;
type AppNumKey = keyof typeof APP_NUMS;

function appsForm(v: AppsSettings) {
  const nums = {} as Record<AppNumKey, string>;
  for (const k of Object.keys(APP_NUMS) as AppNumKey[]) nums[k] = String(v[k]);
  return { enabled: v.enabled, allowedRegistries: v.allowedRegistries, deniedImages: v.deniedImages, allowBuild: v.allowBuild, consoleEnabled: v.consoleEnabled, capAddAllowed: v.capAddAllowed, ...nums };
}

function AppsBlock({ value, save }: { value: AppsSettings; save: SaveFn }) {
  const { t } = useTranslation();
  const [d, set, dirty, reset] = useDraft(appsForm(value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = (Object.keys(APP_NUMS) as AppNumKey[]).every((k) => num(d[k], APP_NUMS[k][0], APP_NUMS[k][1], !APP_NUMS[k][2]) !== null)
    && Number(d.zipMaxExpandedMb) >= Number(d.zipMaxMb);

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    const patch: Partial<AppsSettings> = {
      enabled: d.enabled, allowedRegistries: d.allowedRegistries, deniedImages: d.deniedImages, allowBuild: d.allowBuild,
      consoleEnabled: d.consoleEnabled, capAddAllowed: d.capAddAllowed,
    };
    for (const k of Object.keys(APP_NUMS) as AppNumKey[]) (patch as Record<string, unknown>)[k] = Number(d[k].replace(',', '.'));
    setError(await save({ apps: patch }));
    setSaving(false);
  };
  const toggleCap = (c: string) => set({ capAddAllowed: d.capAddAllowed.includes(c) ? d.capAddAllowed.filter((x) => x !== c) : [...d.capAddAllowed, c] });
  const n = (k: AppNumKey, label: string, hint?: string) => (
    <NumField id={`apps-${k}`} label={label} value={d[k]} onChange={(v) => set({ [k]: v } as Partial<typeof d>)} min={APP_NUMS[k][0]} max={APP_NUMS[k][1]} decimals={APP_NUMS[k][2]} hint={hint} />
  );

  return (
    <SettingsBlock
      id="settings-apps"
      icon={<Boxes />}
      title={t('apps.settingsPage.appsTitle') || 'Applications'}
      description={t('apps.settingsPage.appsDescription') || 'Docker applications of the accounts. A tenant policy can only narrow these rules; the plan of the account caps the resources.'}
      dirty={dirty}
      saving={saving}
      canSave={valid}
      onSave={() => { void submit(); }}
      onReset={() => { reset(); setError(null); }}
      error={error}
    >
      <ToggleSwitch checked={d.enabled} onChange={(c) => set({ enabled: c })} label={t('apps.settingsPage.enabled') || 'Applications enabled'} description={t('apps.settingsPage.enabledHint') || 'Off: no new deployment; running applications are kept.'} />
      <Field label={t('apps.settingsPage.registries') || 'Allowed registries'} hint={t('apps.settingsPage.registriesHint') || 'Host names (docker.io covers Docker Hub). An image of another registry is refused.'}>
        <ChipsInput value={d.allowedRegistries} onChange={(v) => set({ allowedRegistries: v })} normalize={(v) => v.toLowerCase()} validate={(v) => REGISTRY_RE.test(v)} placeholder="docker.io, ghcr.io" />
      </Field>
      <Field label={t('apps.settingsPage.denied') || 'Refused images'} hint={t('apps.settingsPage.deniedHint') || 'Glob patterns on the normalized reference, e.g. docker.io/library/foo*, *:latest.'}>
        <ChipsInput value={d.deniedImages} onChange={(v) => set({ deniedImages: v })} validate={(v) => v.length <= 255 && !/\s/.test(v)} placeholder="docker.io/library/foo*" />
      </Field>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <ToggleSwitch checked={d.allowBuild} onChange={(c) => set({ allowBuild: c })} label={t('apps.settingsPage.allowBuild') || 'Builds from source'} description={t('apps.settingsPage.allowBuildHint') || 'Also needs the plan and the tenant policy. RUN steps get the default Docker capabilities (R-APPS-BUILD).'} />
        <ToggleSwitch checked={d.consoleEnabled} onChange={(c) => set({ consoleEnabled: c })} label={t('apps.settingsPage.console') || 'Interactive console'} description={t('apps.settingsPage.consoleHint') || 'Also needs the plan, the tenant policy and the "Application console" capability. Every opening is audited.'} />
      </div>
      <Field label={t('apps.settingsPage.capAdd') || 'Capabilities a compose may add (cap_add)'} hint={t('apps.settingsPage.capAddHint') || 'NET_RAW, NET_ADMIN and SYS_* (except SYS_CHROOT) are never allowed: the network isolation relies on it.'}>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {APP_CAP_ADD_ALLOWED.map((c) => (
            <label key={c} className="flex cursor-pointer items-center gap-2 font-mono text-[13px] text-text-primary coarse:min-h-10">
              <input type="checkbox" checked={d.capAddAllowed.includes(c)} onChange={() => toggleCap(c)} className="accent-accent" />{c}
            </label>
          ))}
        </div>
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {n('defaultServiceMemoryMb', t('apps.settingsPage.defaultMemory') || 'Default memory of a service (MB)')}
        {n('defaultServiceCpus', t('apps.settingsPage.defaultCpus') || 'Default CPU of a service')}
        {n('maxServicesPerStack', t('apps.settingsPage.maxServices') || 'Services per application')}
        {n('gitPollMinSec', t('apps.settingsPage.gitPoll') || 'Minimum git poll interval (s)')}
        {n('updateCheckMinMinutes', t('apps.settingsPage.updateCheck') || 'Minimum update check interval (min)')}
        {n('zipMaxMb', t('apps.settingsPage.zipMax') || 'ZIP archive, compressed (MB)')}
        {n('zipMaxExpandedMb', t('apps.settingsPage.zipExpanded') || 'ZIP archive, expanded (MB)', Number(d.zipMaxExpandedMb) < Number(d.zipMaxMb) ? (t('apps.settingsPage.zipOrder') || 'Must be at least the compressed size.') : undefined)}
        {n('deploymentRetention', t('apps.settingsPage.retention') || 'Deployments kept per application')}
        {n('deploymentRetentionDays', t('apps.settingsPage.retentionDays') || 'Deployments kept at most (days)')}
      </div>
    </SettingsBlock>
  );
}

// ── per-tenant app policy ───────────────────────────────────────────────────

type Tri = 'inherit' | 'yes' | 'no';
const triOf = (v: boolean | null): Tri => (v == null ? 'inherit' : v ? 'yes' : 'no');
const triOut = (v: Tri): boolean | null => (v === 'inherit' ? null : v === 'yes');

function TriSelect({ id, label, hint, value, onChange, inheritLabel }: { id: string; label: string; hint?: string; value: Tri; onChange: (v: Tri) => void; inheritLabel: string }) {
  const { t } = useTranslation();
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as Tri)} className={settingsInputCls}>
        <option value="inherit">{inheritLabel}</option>
        <option value="yes">{t('apps.settingsPage.policy.allow') || 'Allowed'}</option>
        <option value="no">{t('apps.settingsPage.policy.deny') || 'Refused'}</option>
      </select>
    </Field>
  );
}

function TenantPolicyBlock() {
  const { t } = useTranslation();
  const tenants = useTenantStore((s) => s.tenants);
  const [tenantId, setTenantId] = useState<number | null>(null);
  const [policy, setPolicy] = useState<TenantAppPolicy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ownRegistries, setOwnRegistries] = useState(false);
  const [registries, setRegistries] = useState<string[]>([]);
  const [denied, setDenied] = useState<string[]>([]);
  const [build, setBuild] = useState<Tri>('inherit');
  const [consoleTri, setConsoleTri] = useState<Tri>('inherit');
  const [external, setExternal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (tenantId == null && tenants.length) setTenantId(tenants[0].id);
  }, [tenants, tenantId]);

  const apply = (p: TenantAppPolicy) => {
    setPolicy(p);
    setOwnRegistries(p.allowedRegistries != null);
    setRegistries(p.allowedRegistries ?? []);
    setDenied(p.deniedImages);
    setBuild(triOf(p.allowBuild));
    setConsoleTri(triOf(p.allowConsole));
    setExternal(p.allowExternalProxyTargets === true);
  };
  useEffect(() => {
    if (tenantId == null) return;
    let cancelled = false;
    setPolicy(null);
    setLoadError(null);
    appsApi.getTenantPolicy(tenantId)
      .then((p) => { if (!cancelled) apply(p); })
      .catch((err) => { if (!cancelled) setLoadError(appsErrorMessage(t, err, t('apps.settingsPage.policy.loadFailed') || 'Failed to load the policy')); });
    return () => { cancelled = true; };
  }, [tenantId, t]);

  const current = policy ? {
    allowedRegistries: ownRegistries ? registries : null, deniedImages: denied, allowBuild: triOut(build), allowConsole: triOut(consoleTri),
    allowExternalProxyTargets: external,
  } : null;
  const dirty = !!policy && !!current && JSON.stringify(current) !== JSON.stringify({
    allowedRegistries: policy.allowedRegistries, deniedImages: policy.deniedImages, allowBuild: policy.allowBuild, allowConsole: policy.allowConsole,
    allowExternalProxyTargets: policy.allowExternalProxyTargets === true,
  });

  const submit = async () => {
    if (tenantId == null || !current) return;
    setSaving(true);
    setError(null);
    try {
      apply(await appsApi.updateTenantPolicy(tenantId, current));
      toast.success(t('apps.settingsPage.policy.saved') || 'Workspace policy saved');
    } catch (err) {
      if (!isStepUpHandled(err)) setError(appsErrorMessage(t, err, t('apps.settingsPage.policy.saveFailed') || 'Failed to save the policy'));
    } finally {
      setSaving(false);
    }
  };

  const inherit = t('apps.settingsPage.policy.inherit') || 'Platform setting';
  return (
    <SettingsBlock
      id="settings-apps-policy"
      icon={<Building2 />}
      title={t('apps.settingsPage.policy.title') || 'Applications policy per workspace'}
      description={t('apps.settingsPage.policy.description') || 'Narrows the platform rules for one workspace (tenant): registries, refused images, builds, console, proxy hosts to external targets.'}
      dirty={dirty}
      saving={saving}
      onSave={() => { void submit(); }}
      onReset={() => { if (policy) apply(policy); setError(null); }}
      error={error}
    >
      <Field label={t('apps.settingsPage.policy.tenant') || 'Workspace'} htmlFor="pol-tenant">
        <select id="pol-tenant" value={tenantId ?? ''} onChange={(e) => setTenantId(Number(e.target.value) || null)} className={cn(settingsInputCls, 'sm:w-72')}>
          {tenants.map((tn) => <option key={tn.id} value={tn.id}>{tn.name}</option>)}
        </select>
      </Field>
      {loadError ? <p className="text-sm text-status-down">{loadError}</p> : !policy ? <div className="flex justify-center py-4"><LoadingSpinner /></div> : (
        <>
          <div className="space-y-2">
            <ToggleSwitch checked={ownRegistries} onChange={setOwnRegistries} label={t('apps.settingsPage.policy.ownRegistries') || 'Own list of allowed registries'} description={t('apps.settingsPage.policy.ownRegistriesHint') || 'Off: the platform list applies.'} />
            {ownRegistries && <ChipsInput value={registries} onChange={setRegistries} normalize={(v) => v.toLowerCase()} validate={(v) => REGISTRY_RE.test(v)} placeholder="docker.io, ghcr.io" />}
          </div>
          <Field label={t('apps.settingsPage.policy.denied') || 'Images refused for this workspace (added to the platform list)'}>
            <ChipsInput value={denied} onChange={setDenied} validate={(v) => v.length <= 255 && !/\s/.test(v)} placeholder="*:latest" />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TriSelect id="pol-build" label={t('apps.settingsPage.allowBuild') || 'Builds from source'} value={build} onChange={setBuild} inheritLabel={inherit} />
            <TriSelect id="pol-console" label={t('apps.settingsPage.console') || 'Interactive console'} value={consoleTri} onChange={setConsoleTri} inheritLabel={inherit} />
          </div>
          <ToggleSwitch
            checked={external}
            onChange={setExternal}
            label={t('apps.settingsPage.policy.external') || 'Proxy hosts to external targets'}
            description={t('apps.settingsPage.policy.externalHint') || 'IP / host names outside the platform (also needs the plan option). Needed by CWP migrations.'}
          />
        </>
      )}
    </SettingsBlock>
  );
}

// ── monitoring ──────────────────────────────────────────────────────────────

const MON_NUMS = {
  trafficMinuteDays: [1, 31],
  trafficHourDays: [1, 730],
  uptimeRetentionDays: [1, 365],
  uptimeMinIntervalSec: [10, 3600],
  certExpiryWarningDays: [1, 60],
} as const;
type MonNumKey = keyof typeof MON_NUMS;

function MonitoringBlock({ value, save }: { value: MonitoringSettings; save: SaveFn }) {
  const { t } = useTranslation();
  const toForm = (v: MonitoringSettings) => {
    const nums = {} as Record<MonNumKey, string>;
    for (const k of Object.keys(MON_NUMS) as MonNumKey[]) nums[k] = String(v[k]);
    return { allowPrivateTargets: v.allowPrivateTargets, statusPagesEnabled: v.statusPagesEnabled, workflowsEnabled: v.workflowsEnabled, ...nums };
  };
  const [d, set, dirty, reset] = useDraft(toForm(value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = (Object.keys(MON_NUMS) as MonNumKey[]).every((k) => num(d[k], MON_NUMS[k][0], MON_NUMS[k][1]) !== null);
  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    const patch: Partial<MonitoringSettings> = { allowPrivateTargets: d.allowPrivateTargets, statusPagesEnabled: d.statusPagesEnabled, workflowsEnabled: d.workflowsEnabled };
    for (const k of Object.keys(MON_NUMS) as MonNumKey[]) (patch as Record<string, unknown>)[k] = Number(d[k]);
    setError(await save({ monitoring: patch }));
    setSaving(false);
  };
  const n = (k: MonNumKey, label: string) => (
    <NumField id={`mon-${k}`} label={label} value={d[k]} onChange={(v) => set({ [k]: v } as Partial<typeof d>)} min={MON_NUMS[k][0]} max={MON_NUMS[k][1]} />
  );
  return (
    <SettingsBlock
      id="settings-monitoring"
      icon={<HeartPulse />}
      title={t('apps.settingsPage.monitoringTitle') || 'Monitoring and automation'}
      description={t('apps.settingsPage.monitoringDescription') || 'Traffic of the proxy hosts, uptime monitors, status pages, workflows and certificate expiry.'}
      dirty={dirty}
      saving={saving}
      canSave={valid}
      onSave={() => { void submit(); }}
      onReset={() => { reset(); setError(null); }}
      error={error}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {n('trafficMinuteDays', t('apps.settingsPage.trafficMinute') || 'Traffic per minute kept (days)')}
        {n('trafficHourDays', t('apps.settingsPage.trafficHour') || 'Traffic per hour kept (days)')}
        {n('uptimeRetentionDays', t('apps.settingsPage.uptimeRetention') || 'Uptime checks kept (days)')}
        {n('uptimeMinIntervalSec', t('apps.settingsPage.uptimeMinInterval') || 'Shortest check interval of a client (s)')}
        {n('certExpiryWarningDays', t('apps.settingsPage.certExpiry') || 'Certificate expiry warning (days before)')}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <ToggleSwitch checked={d.statusPagesEnabled} onChange={(c) => set({ statusPagesEnabled: c })} label={t('apps.settingsPage.statusPages') || 'Public status pages'} />
        <ToggleSwitch checked={d.workflowsEnabled} onChange={(c) => set({ workflowsEnabled: c })} label={t('apps.settingsPage.workflows') || 'Workflows'} />
        <ToggleSwitch checked={d.allowPrivateTargets} onChange={(c) => set({ allowPrivateTargets: c })} label={t('apps.settingsPage.privateTargets') || 'Private targets (platform objects)'} description={t('apps.settingsPage.privateTargetsHint') || 'Monitors and SFTP targets of the platform staff may use private addresses. Never for a client.'} />
      </div>
    </SettingsBlock>
  );
}

// ── network ─────────────────────────────────────────────────────────────────

function NetworkBlock({ value, save }: { value: NetworkSettings; save: SaveFn }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [mode, setMode] = useState<NetworkSettings['mode']>(value.mode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setMode(value.mode); }, [value.mode]);
  const modes: Array<{ id: NetworkSettings['mode']; label: string; hint: string }> = [
    { id: 'enforce', label: t('network.mode.enforceLabel') || 'Enforce', hint: t('network.mode.enforceHint') || 'Default deny between the containers of an account; only the policy flows and declared links pass.' },
    { id: 'monitor', label: t('network.mode.monitorLabel') || 'Monitor', hint: t('network.mode.monitorHint') || 'Everything passes; frames that would be refused are counted and logged (diagnosis).' },
    { id: 'off', label: t('network.mode.offLabel') || 'Off', hint: t('network.mode.offHint') || 'No filtering inside the accounts (behaviour before P4b).' },
  ];
  const submit = async () => {
    if (mode !== 'enforce' && !(await confirm({
      title: t('network.mode.confirmTitle') || 'Weaken the network isolation',
      message: t('network.mode.confirmMessage') || 'The containers of an account (sites, databases, applications) will be able to reach each other. Continue?',
      confirmLabel: t('common.confirm') || 'Confirm',
      danger: true,
    }))) return;
    setSaving(true);
    setError(await save({ network: { mode } }));
    setSaving(false);
  };
  return (
    <SettingsBlock
      id="settings-network"
      icon={<Network />}
      title={t('apps.settingsPage.networkTitle') || 'Network isolation'}
      description={t('apps.settingsPage.networkDescription') || 'Filtering of the traffic between the containers of one account (nftables, pushed to hostd).'}
      dirty={mode !== value.mode}
      saving={saving}
      onSave={() => { void submit(); }}
      onReset={() => { setMode(value.mode); setError(null); }}
      error={error}
    >
      <div role="radiogroup" aria-label={t('apps.settingsPage.networkTitle') || 'Network isolation'} className="grid grid-cols-1 gap-2 md:grid-cols-3">
        {modes.map((m) => {
          const selected = mode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setMode(m.id)}
              className={cn('rounded-lg border-2 p-3 text-left transition-all', selected ? 'border-accent bg-accent/5' : 'border-transparent bg-bg-primary hover:border-accent/30')}
            >
              <div className="text-sm font-semibold text-text-primary">{m.label}</div>
              <p className="mt-1 text-xs text-text-secondary">{m.hint}</p>
            </button>
          );
        })}
      </div>
      {mode !== 'enforce' && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-400">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {t('network.mode.warning') || 'Without enforcement, a compromised site or application can reach the other containers of its account (databases, other applications).'}
        </p>
      )}
    </SettingsBlock>
  );
}
