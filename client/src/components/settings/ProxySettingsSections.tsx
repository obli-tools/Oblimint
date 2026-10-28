import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Plus, ServerCog, ShieldBan, X } from 'lucide-react';
import type { BansSettings, CustomPage, EdgeSettings, HostingSettings, HostingSettingsUpdate } from '@oblimint/shared';
import { hostingSettingsApi } from '@/api/hostingSettings.api';
import { proxyApi } from '@/api/proxy.api';
import { isStepUpHandled } from '@/api/client';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { ChipsInput } from '@/components/settings/ChipsInput';
import { Field, SettingsBlock, settingsInputCls } from '@/components/settings/SettingsBlock';
import { proxyErrorMessage, proxyLoadError } from '@/components/proxy/proxyErrors';
import { RESERVED_STREAM_PORTS, intIn, isValidCidr } from '@/components/proxy/proxyFormat';
import { cn } from '@/utils/cn';

/**
 * Settings sections of P4b owned by `ui-proxy` (docs/P4b-PLAN.md §13, §17):
 * edge (stream ports, advanced config, body sizes, probes, canary, default
 * pages) and bans (escalation, never-ban list, nftables, Obliguard, GeoIP,
 * retention) of /api/system/hosting-settings. Platform admin (SettingsPage).
 */
export function ProxySettingsSections() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<HostingSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pages, setPages] = useState<CustomPage[]>([]);

  useEffect(() => {
    let cancelled = false;
    hostingSettingsApi.get()
      .then((s) => { if (!cancelled) { setSettings(s); setError(null); } })
      .catch((err) => { if (!cancelled) setError(proxyLoadError(t, err, t('edgeUnits.settings.loadFailed') || 'Failed to load the settings')); });
    proxyApi.listCustomPages().then((l) => { if (!cancelled) setPages(l.filter((p) => p.accountId == null)); }).catch(() => { /* pages module not deployed: no picker */ });
    return () => { cancelled = true; };
  }, [t]);

  const save = async (patch: HostingSettingsUpdate, okMsg: string): Promise<string | null> => {
    try {
      setSettings(await hostingSettingsApi.update(patch));
      toast.success(okMsg);
      return null;
    } catch (err) {
      if (isStepUpHandled(err)) return '';
      return proxyErrorMessage(t, err, t('edgeUnits.settings.saveFailed') || 'Failed to save the settings');
    }
  };

  if (!settings?.edge || !settings.bans) {
    return (
      <SettingsBlock id="settings-edge" icon={<ServerCog />} title={t('edgeUnits.settings.edgeTitle') || 'Edge and proxy hosts'}>
        {error ? <p className="flex items-start gap-2 text-sm text-text-muted"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</p> : <div className="flex justify-center py-4"><LoadingSpinner /></div>}
      </SettingsBlock>
    );
  }
  return (
    <>
      <EdgeBlock value={settings.edge} pages={pages} save={(p) => save({ edge: p }, t('edgeUnits.settings.edgeSaved') || 'Edge settings saved')} />
      <BansBlock value={settings.bans} save={(p) => save({ bans: p }, t('bans.settings.saved') || 'Ban settings saved')} />
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
    <Field label={label} htmlFor={id} hint={hint} error={ok ? null : t('edgeUnits.settings.range', { min, max, defaultValue: 'Between {{min}} and {{max}}.' })}>
      <input id={id} type="number" inputMode="numeric" min={min} max={max} value={value} onChange={(e) => onChange(e.target.value)} className={cn(settingsInputCls, 'font-mono', !ok && 'ring-2 ring-status-down/50')} />
    </Field>
  );
}

type SaveFn<T> = (patch: Partial<T>) => Promise<string | null>;

// ── Edge ────────────────────────────────────────────────────────────────────

function EdgeBlock({ value, pages, save }: { value: EdgeSettings; pages: CustomPage[]; save: SaveFn<EdgeSettings> }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [draft, set, dirty, reset] = useDraft({
    streamPorts: value.streamPorts.map((p) => ({ port: String(p.port), protocol: p.protocol })),
    allowAdvancedConfig: value.allowAdvancedConfig,
    defaultBodySizeMb: String(value.defaultBodySizeMb),
    maxBodySizeMb: String(value.maxBodySizeMb),
    probeUpstreams: value.probeUpstreams,
    canary: value.canary,
    canarySampleSize: String(value.canarySampleSize),
    defaultErrorPageId: value.defaultErrorPageId,
    defaultWakingPageId: value.defaultWakingPageId,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ports = draft.streamPorts.map((p) => ({ port: intIn(p.port, 1, 65535), protocol: p.protocol }));
  const reserved = ports.filter((p) => p.port != null && RESERVED_STREAM_PORTS.includes(p.port)).map((p) => p.port);
  const keys = ports.map((p) => `${p.port}/${p.protocol}`);
  const portsOk = ports.every((p) => p.port != null) && reserved.length === 0 && new Set(keys).size === keys.length;
  const def = intIn(draft.defaultBodySizeMb, 1, 10240);
  const max = intIn(draft.maxBodySizeMb, 1, 10240);
  const sample = intIn(draft.canarySampleSize, 0, 100);
  const valid = portsOk && def != null && max != null && def <= max && sample != null;
  const portsChanged = JSON.stringify(ports) !== JSON.stringify(value.streamPorts);

  const submit = async () => {
    if (!valid) return;
    if (portsChanged && !(await confirm({
      title: t('edgeUnits.settings.recreateTitle') || 'Change the stream ports',
      message: t('edgeUnits.settings.recreateConfirm') || 'The edge container is recreated to publish the new ports: every site and proxy host is cut for a few seconds.',
      confirmLabel: t('common.save') || 'Save',
      danger: true,
    }))) return;
    setSaving(true);
    const err = await save({
      streamPorts: ports.map((p) => ({ port: p.port!, protocol: p.protocol })),
      allowAdvancedConfig: draft.allowAdvancedConfig,
      defaultBodySizeMb: def!,
      maxBodySizeMb: max!,
      probeUpstreams: draft.probeUpstreams,
      canary: draft.canary,
      canarySampleSize: sample!,
      defaultErrorPageId: draft.defaultErrorPageId,
      defaultWakingPageId: draft.defaultWakingPageId,
    });
    setSaving(false);
    setError(err || null);
  };

  const setPort = (i: number, p: Partial<{ port: string; protocol: 'tcp' | 'udp' }>) => set({ streamPorts: draft.streamPorts.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const errorPages = pages.filter((p) => !p.isWakingPage);
  const wakingPages = pages.filter((p) => p.isWakingPage);

  return (
    <SettingsBlock
      id="settings-edge"
      icon={<ServerCog />}
      title={t('edgeUnits.settings.edgeTitle') || 'Edge and proxy hosts'}
      description={t('edgeUnits.settings.edgeDescription') || 'Shared web front end: stream ports, advanced configuration of the proxy hosts, sizes, validation before going live.'}
      dirty={dirty}
      saving={saving}
      canSave={valid}
      onSave={() => { void submit(); }}
      onReset={() => { reset(); setError(null); }}
      error={error}
    >
      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-sm font-medium text-text-secondary">{t('edgeUnits.settings.streamPorts') || 'Stream ports (TCP / UDP)'}</span>
          <Button size="sm" variant="ghost" className="ml-auto" disabled={draft.streamPorts.length >= 64} onClick={() => set({ streamPorts: [...draft.streamPorts, { port: '', protocol: 'tcp' }] })}>
            <Plus size={13} className="mr-1" />{t('edgeUnits.settings.addPort') || 'Add a port'}
          </Button>
        </div>
        {draft.streamPorts.length === 0 ? (
          <p className="text-xs text-text-muted">{t('edgeUnits.settings.noPort') || 'No stream port: streams are off.'}</p>
        ) : (
          <ul className="space-y-1.5">
            {draft.streamPorts.map((p, i) => {
              const n = intIn(p.port, 1, 65535);
              const bad = n == null || RESERVED_STREAM_PORTS.includes(n);
              return (
                <li key={i} className="flex items-center gap-2">
                  <input aria-label={t('edgeUnits.settings.port') || 'Port'} type="number" inputMode="numeric" min={1} max={65535} value={p.port} onChange={(e) => setPort(i, { port: e.target.value })}
                    className={cn(settingsInputCls, 'w-32 font-mono', bad && 'ring-2 ring-status-down/50')} />
                  <select aria-label={t('edgeUnits.settings.protocol') || 'Protocol'} value={p.protocol} onChange={(e) => setPort(i, { protocol: e.target.value as 'tcp' | 'udp' })} className={cn(settingsInputCls, 'w-24')}>
                    <option value="tcp">tcp</option>
                    <option value="udp">udp</option>
                  </select>
                  <IconButton label={t('common.delete') || 'Delete'} icon={<X size={14} />} size="sm" onClick={() => set({ streamPorts: draft.streamPorts.filter((_, j) => j !== i) })} />
                </li>
              );
            })}
          </ul>
        )}
        {reserved.length > 0 && <p className="mt-1.5 text-xs text-status-down">{t('edgeUnits.settings.reservedPorts', { ports: reserved.join(', '), defaultValue: 'Reserved by the platform: {{ports}}.' })}</p>}
        <p className="mt-1.5 text-xs text-text-muted">
          {t('edgeUnits.settings.reservedHint', { ports: RESERVED_STREAM_PORTS.join(', '), defaultValue: 'Never: {{ports}}.' })}{' '}
          <span className="text-amber-400">{t('edgeUnits.settings.recreateHint') || 'Changing the list recreates the edge (a few seconds of downtime).'}</span>
        </p>
      </div>

      <ToggleSwitch checked={draft.allowAdvancedConfig} onChange={(v) => set({ allowAdvancedConfig: v })} label={t('edgeUnits.settings.allowAdvanced') || 'Advanced configuration of the proxy hosts'}
        description={t('edgeUnits.settings.allowAdvancedHint') || 'Raw nginx directives, platform staff only, checked and tested in isolation.'} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <NumberField id="edge-body-def" label={t('edgeUnits.settings.defaultBody') || 'Default body size (MiB)'} value={draft.defaultBodySizeMb} onChange={(v) => set({ defaultBodySizeMb: v })} min={1} max={10240} />
        <NumberField id="edge-body-max" label={t('edgeUnits.settings.maxBody') || 'Maximum body size (MiB)'} value={draft.maxBodySizeMb} onChange={(v) => set({ maxBodySizeMb: v })} min={1} max={10240}
          hint={def != null && max != null && def > max ? (t('edgeUnits.settings.bodyOrder') || 'The default must not exceed the maximum.') : undefined} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ToggleSwitch checked={draft.probeUpstreams} onChange={(v) => set({ probeUpstreams: v })} label={t('edgeUnits.settings.probe') || 'Probe the targets before activation'}
          description={t('edgeUnits.settings.probeHint') || 'TCP connection from the edge; an unreachable target keeps the previous version.'} />
        <ToggleSwitch checked={draft.canary} onChange={(v) => set({ canary: v })} label={t('edgeUnits.settings.canary') || 'Canary after each reload'}
          description={t('edgeUnits.settings.canaryHint') || 'Checks the default server and a sample of hosts; a failure rolls the whole edge back.'} />
      </div>
      {draft.canary && (
        <div className="sm:w-1/2">
          <NumberField id="edge-sample" label={t('edgeUnits.settings.sample') || 'Hosts checked by the canary'} value={draft.canarySampleSize} onChange={(v) => set({ canarySampleSize: v })} min={0} max={100} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('edgeUnits.settings.defaultErrorPage') || 'Default error page'} htmlFor="edge-errpage">
          <select id="edge-errpage" value={draft.defaultErrorPageId ?? ''} onChange={(e) => set({ defaultErrorPageId: e.target.value ? Number(e.target.value) : null })} className={settingsInputCls}>
            <option value="">{t('edgeUnits.settings.builtin') || 'Built-in pages'}</option>
            {errorPages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label={t('edgeUnits.settings.defaultWakingPage') || 'Default waking page'} htmlFor="edge-wakepage">
          <select id="edge-wakepage" value={draft.defaultWakingPageId ?? ''} onChange={(e) => set({ defaultWakingPageId: e.target.value ? Number(e.target.value) : null })} className={settingsInputCls}>
            <option value="">{t('edgeUnits.settings.builtin') || 'Built-in pages'}</option>
            {wakingPages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      </div>
    </SettingsBlock>
  );
}

// ── Bans ────────────────────────────────────────────────────────────────────

function BansBlock({ value, save }: { value: BansSettings; save: SaveFn<BansSettings> }) {
  const { t } = useTranslation();
  const [draft, set, dirty, reset] = useDraft({
    enabled: value.enabled,
    escalation: value.escalation.map((m) => (m == null ? '' : String(m))),
    escalationWindowDays: String(value.escalationWindowDays),
    neverBan: value.neverBan,
    nftables: value.nftables,
    obliguardEnabled: value.obliguardEnabled,
    obliguardUrl: value.obliguardUrl ?? '',
    geoipProvider: value.geoipProvider,
    geoipMmdbPath: value.geoipMmdbPath ?? '',
    retentionDays: String(value.retentionDays),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // '' = permanent (null).
  const ladder = draft.escalation.map((v) => (v.trim() === '' ? null : intIn(v, 1, 525_600)));
  const ladderOk = ladder.length > 0 && draft.escalation.every((v, i) => v.trim() === '' || ladder[i] != null);
  const windowDays = intIn(draft.escalationWindowDays, 1, 365);
  const retention = intIn(draft.retentionDays, 1, 3650);
  const urlOk = !draft.obliguardUrl.trim() || /^https?:\/\/[^\s]+$/.test(draft.obliguardUrl.trim());
  const mmdbOk = draft.geoipProvider !== 'mmdb' || /^\/[^\0]+\.mmdb$/.test(draft.geoipMmdbPath.trim());
  const valid = ladderOk && windowDays != null && retention != null && urlOk && mmdbOk;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    const err = await save({
      enabled: draft.enabled,
      escalation: ladder,
      escalationWindowDays: windowDays!,
      neverBan: draft.neverBan,
      nftables: draft.nftables,
      obliguardEnabled: draft.obliguardEnabled,
      obliguardUrl: draft.obliguardUrl.trim() || null,
      geoipProvider: draft.geoipProvider,
      geoipMmdbPath: draft.geoipMmdbPath.trim() || null,
      retentionDays: retention!,
    });
    setSaving(false);
    setError(err || null);
  };

  const setStep = (i: number, v: string) => set({ escalation: draft.escalation.map((x, j) => (j === i ? v : x)) });
  const stepHint = (i: number) => {
    const m = ladder[i];
    if (m === undefined) return '';
    if (m === null) return t('bans.permanent') || 'permanent';
    if (m % 1440 === 0) return t('bans.days', { count: m / 1440, defaultValue: '{{count}} d' });
    if (m % 60 === 0) return t('bans.hours', { count: m / 60, defaultValue: '{{count}} h' });
    return t('bans.minutes', { count: m, defaultValue: '{{count}} min' });
  };

  return (
    <SettingsBlock
      id="settings-bans"
      icon={<ShieldBan />}
      title={t('bans.settings.title') || 'Web bans and honeypot'}
      description={<>
        {t('bans.settings.description') || 'Bans produced by the honeypots and the access-list trap of the proxy hosts, manual bans and the Obliguard synchronisation.'}{' '}
        <Link to="/security/bans" className="text-accent hover:underline">{t('bans.settings.listLink') || 'See the web bans'}</Link>
      </>}
      dirty={dirty}
      saving={saving}
      canSave={valid}
      onSave={() => { void submit(); }}
      onReset={() => { reset(); setError(null); }}
      error={error}
    >
      <ToggleSwitch checked={draft.enabled} onChange={(v) => set({ enabled: v })} label={t('bans.settings.enabled') || 'Web bans enabled'} />

      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-sm font-medium text-text-secondary">{t('bans.settings.escalation') || 'Escalation ladder (minutes per offence)'}</span>
          <Button size="sm" variant="ghost" className="ml-auto" disabled={draft.escalation.length >= 10} onClick={() => set({ escalation: [...draft.escalation, ''] })}>
            <Plus size={13} className="mr-1" />{t('bans.settings.addStep') || 'Add a step'}
          </Button>
        </div>
        <ol className="space-y-1.5">
          {draft.escalation.map((v, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <span className="w-20 font-mono text-xs text-text-muted">{t('bans.settings.offence', { n: i + 1, defaultValue: 'offence {{n}}' })}</span>
              <input aria-label={t('bans.settings.minutes') || 'Minutes'} type="number" inputMode="numeric" min={1} max={525600} value={v} onChange={(e) => setStep(i, e.target.value)} placeholder="∞"
                className={cn(settingsInputCls, 'w-36 font-mono', v.trim() !== '' && ladder[i] == null && 'ring-2 ring-status-down/50')} />
              <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                <input type="checkbox" className="accent-accent" checked={v.trim() === ''} onChange={(e) => setStep(i, e.target.checked ? '' : '60')} />
                {t('bans.permanent') || 'permanent'}
              </label>
              <span className="text-xs text-text-muted">{stepHint(i)}</span>
              <IconButton label={t('common.delete') || 'Delete'} icon={<X size={14} />} size="sm" disabled={draft.escalation.length <= 1} onClick={() => set({ escalation: draft.escalation.filter((_, j) => j !== i) })} />
            </li>
          ))}
        </ol>
        <p className="mt-1.5 text-xs text-text-muted">{t('bans.settings.escalationHint') || 'Offences of an address within the window: the 1st uses the first step, and so on; past the end, the last step applies.'}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <NumberField id="bans-window" label={t('bans.settings.window') || 'Escalation window (days)'} value={draft.escalationWindowDays} onChange={(v) => set({ escalationWindowDays: v })} min={1} max={365} />
        <NumberField id="bans-retention" label={t('bans.settings.retention') || 'Keep lifted bans (days)'} value={draft.retentionDays} onChange={(v) => set({ retentionDays: v })} min={1} max={3650} />
      </div>

      <Field label={t('bans.settings.neverBan') || 'Never ban (CIDR)'} htmlFor="bans-never" hint={t('bans.settings.neverBanHint') || 'On top of the private, loopback, link-local, CGNAT and ULA ranges and the addresses of the server, always excluded.'}>
        <ChipsInput id="bans-never" value={draft.neverBan} onChange={(v) => set({ neverBan: v })} validate={isValidCidr} max={200} placeholder="198.51.100.0/24" ariaLabel={t('bans.settings.neverBan') || 'Never ban (CIDR)'} />
      </Field>

      <ToggleSwitch checked={draft.nftables} onChange={(v) => set({ nftables: v })} label={t('bans.settings.nftables') || 'Firewall for the platform bans'}
        description={t('bans.settings.nftablesHint') || 'Platform bans are also dropped by nftables on ports 80 / 443, before Docker.'} />

      <div className="space-y-3 rounded-lg bg-bg-primary p-3">
        <ToggleSwitch checked={draft.obliguardEnabled} onChange={(v) => set({ obliguardEnabled: v })} label={t('bans.settings.obliguard') || 'Synchronise with Obliguard'}
          description={t('bans.settings.obliguardHint') || 'Bans are sent to Obliguard (Obligate delegation token) and lifted there on unban.'} />
        {draft.obliguardEnabled && (
          <Field label={t('bans.settings.obliguardUrl') || 'Obliguard URL'} htmlFor="bans-og-url" hint={t('bans.settings.obliguardUrlHint') || 'Empty = discovered through Obligate.'} error={urlOk ? null : (t('bans.settings.urlInvalid') || 'Invalid URL.')}>
            <input id="bans-og-url" value={draft.obliguardUrl} onChange={(e) => set({ obliguardUrl: e.target.value })} placeholder="https://obliguard.example.com" spellCheck={false} className={cn(settingsInputCls, 'font-mono')} />
          </Field>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('bans.settings.geoip') || 'GeoIP'} htmlFor="bans-geoip" hint={draft.geoipProvider === 'ip-api' ? (t('bans.settings.ipApiHint') || 'ip-api.com receives the banned addresses and those of the traffic tops (cached 30 days).') : undefined}>
          <select id="bans-geoip" value={draft.geoipProvider} onChange={(e) => set({ geoipProvider: e.target.value as BansSettings['geoipProvider'] })} className={settingsInputCls}>
            <option value="off">{t('bans.settings.geoipOff') || 'Off'}</option>
            <option value="ip-api">ip-api.com</option>
            <option value="mmdb">{t('bans.settings.geoipMmdb') || 'MaxMind GeoLite2 file (.mmdb)'}</option>
          </select>
        </Field>
        {draft.geoipProvider === 'mmdb' && (
          <Field label={t('bans.settings.mmdbPath') || 'Path of the .mmdb file (in the panel container)'} htmlFor="bans-mmdb" error={mmdbOk ? null : (t('bans.settings.mmdbInvalid') || 'An absolute path ending with .mmdb.')}>
            <input id="bans-mmdb" value={draft.geoipMmdbPath} onChange={(e) => set({ geoipMmdbPath: e.target.value })} placeholder="/data/GeoLite2-City.mmdb" spellCheck={false} className={cn(settingsInputCls, 'font-mono')} />
          </Field>
        )}
      </div>
    </SettingsBlock>
  );
}
