import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, BarChart3, Database, Eye, Globe, Server, ShieldCheck } from 'lucide-react';
import apiClient from '@/api/client';
import type { AppConfigData, HostingSettings, HostingSettingsSection, HostingSettingsUpdate } from '@oblimint/shared';
import { hostingSettingsApi } from '@/api/hostingSettings.api';
import { isStepUpHandled } from '@/api/client';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { CopyButton } from '@/components/hosting/hostingUi';
import { opsErrorMessage } from '@/components/usage/opsErrors';
import { cn } from '@/utils/cn';
import { ChipsInput } from './ChipsInput';
import { Field, SettingsBlock, settingsInputCls } from './SettingsBlock';
import { dbAdminConflictsWithPanel, intInRange, isPanelHost, isEmail, isHostname, isIp, isIpOrCidr, normalizeHostname, previewConflictsWithPanel } from './settingsFormat';

type SaveFn = <K extends HostingSettingsSection>(section: K, patch: HostingSettingsUpdate[K]) => Promise<string | null>;

/**
 * P2 platform settings (GET / PUT /api/system/hosting-settings, platform
 * admin): DNS, previews, database admin, access, usage. One Save per section
 * (the PUT takes any subset of sections).
 */
export function HostingSettingsSections() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<HostingSettings | null>(null);
  const [panel, setPanel] = useState<AppConfigData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [s, p] = await Promise.allSettled([hostingSettingsApi.get(), hostingSettingsApi.panelConfig()]);
    if (s.status === 'fulfilled') { setSettings(s.value); setError(null); } else setError(opsErrorMessage(t, s.reason, 'platformSettings', t('platformSettings.loadFailed') || 'Failed to load the hosting settings'));
    if (p.status === 'fulfilled') setPanel(p.value);
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  const save: SaveFn = async (section, patch) => {
    try {
      setSettings(await hostingSettingsApi.update({ [section]: patch } as HostingSettingsUpdate));
      toast.success(t('platformSettings.saved') || 'Settings saved');
      return null;
    } catch (err) {
      if (isStepUpHandled(err)) return '';
      return opsErrorMessage(t, err, 'platformSettings', t('platformSettings.saveFailed') || 'Failed to save the settings');
    }
  };

  if (!settings) {
    return (
      <SettingsBlock icon={<Globe />} title={t('platformSettings.hostingTitle') || 'Hosting'}>
        {error ? <p className="flex items-start gap-2 text-sm text-text-muted"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</p> : <div className="flex justify-center py-4"><LoadingSpinner /></div>}
      </SettingsBlock>
    );
  }

  return (
    <>
      <PanelAddressSection panel={panel} onSaved={setPanel} />
      <DnsSection value={settings.dns} save={save} />
      <PreviewSection value={settings.preview} panelHost={panel?.panel_hostname ?? null} save={save} />
      <ReleasePreviewsSection value={settings.releasePreviews} previewDomain={settings.preview.previewDomain} save={save} />
      <DbAdminSection value={settings.dbAdmin} panelHost={panel?.panel_hostname ?? null} previewDomain={settings.preview.previewDomain} save={save} />
      <AccessSection value={settings.access} panel={panel} save={save} />
      <UsageSection value={settings.usage} save={save} />
    </>
  );
}

/** Draft of a section: edits are kept until saved or reset; the saved value replaces an untouched draft. */
function useDraft<T>(value: T): [T, (next: T) => void, boolean, () => void] {
  const [draft, setDraft] = useState<T>(value);
  const [base, setBase] = useState<T>(value);
  // Keyed by content: callers derive `value` inline (a new object every render).
  const key = JSON.stringify(value);
  useEffect(() => { setDraft(value); setBase(value); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  return [draft, setDraft, dirty, () => setDraft(base)];
}

function useSaver(save: SaveFn) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <K extends HostingSettingsSection>(section: K, patch: HostingSettingsUpdate[K]) => {
    setSaving(true);
    const err = await save(section, patch);
    setSaving(false);
    setError(err || null);
  };
  return { saving, error, setError, run };
}

function NumberInput({ id, value, onChange, min, max, invalid }: { id: string; value: string; onChange: (v: string) => void; min: number; max: number; invalid?: boolean }) {
  return (
    <input id={id} type="number" inputMode="numeric" min={min} max={max} value={value} onChange={(e) => onChange(e.target.value)} className={cn(settingsInputCls, 'font-mono', invalid && 'ring-2 ring-status-down/50')} />
  );
}

// ── DNS ─────────────────────────────────────────────────────────────────────

function DnsSection({ value, save }: { value: HostingSettings['dns']; save: SaveFn }) {
  const { t } = useTranslation();
  const form = { ...value, defaultTtl: String(value.defaultTtl), hostmasterEmail: value.hostmasterEmail ?? '' };
  const [draft, setDraft, dirty, reset] = useDraft(form);
  const { saving, error, setError, run } = useSaver(save);
  const set = (patch: Partial<typeof draft>) => { setDraft({ ...draft, ...patch }); setError(null); };

  const ttl = intInRange(draft.defaultTtl, 60, 86400);
  const email = draft.hostmasterEmail.trim();
  const emailOk = !email || isEmail(email);
  const valid = ttl !== null && emailOk && draft.resolvers.length > 0;

  const submit = () => {
    if (!valid || ttl === null) return;
    void run('dns', {
      enabled: draft.enabled, nameservers: draft.nameservers, hostmasterEmail: email || null, defaultTtl: ttl,
      axfrAllowFrom: draft.axfrAllowFrom, alsoNotify: draft.alsoNotify, dnssecDefault: draft.dnssecDefault,
      allowNsProof: draft.allowNsProof, resolvers: draft.resolvers,
    });
  };

  return (
    <SettingsBlock
      id="settings-dns"
      icon={<Globe />}
      title={t('platformSettings.dns.title') || 'DNS'}
      description={t('platformSettings.dns.description') || 'Shared PowerDNS server of the platform: zones generated from the domains, served on port 53 of this host.'}
      dirty={dirty} saving={saving} canSave={valid} onSave={submit} onReset={reset} error={error}
    >
      <ToggleSwitch
        checked={draft.enabled}
        onChange={(v) => set({ enabled: v })}
        label={t('platformSettings.dns.enabled') || 'Host the DNS zones'}
        description={t('platformSettings.dns.enabledHint') || 'Off: no PowerDNS, every zone is « hosted elsewhere » and the panel only lists the records to create at the provider.'}
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label={t('platformSettings.dns.nameservers') || 'Name servers'} htmlFor="dns-ns" hint={t('platformSettings.dns.nameserversHint') || 'Our authoritative servers (FQDN), at least two recommended. They are the NS records of every hosted zone.'}>
          <ChipsInput id="dns-ns" value={draft.nameservers} onChange={(v) => set({ nameservers: v })} validate={isHostname} normalize={normalizeHostname} max={8} placeholder="ns1.example.com" />
        </Field>
        <Field label={t('platformSettings.dns.hostmaster') || 'Hostmaster e-mail'} htmlFor="dns-hostmaster" error={emailOk ? null : (t('platformSettings.errors.email') || 'Invalid e-mail address.')} hint={t('platformSettings.dns.hostmasterHint') || 'SOA contact. Empty: hostmaster@<zone>.'}>
          <input id="dns-hostmaster" type="email" value={draft.hostmasterEmail} onChange={(e) => set({ hostmasterEmail: e.target.value })} placeholder="hostmaster@example.com" className={settingsInputCls} />
        </Field>
        <Field label={t('platformSettings.dns.defaultTtl') || 'Default TTL (seconds)'} htmlFor="dns-ttl" error={ttl === null ? t('platformSettings.errors.range', { min: 60, max: 86400, defaultValue: 'Between {{min}} and {{max}}.' }) : null}>
          <NumberInput id="dns-ttl" value={draft.defaultTtl} onChange={(v) => set({ defaultTtl: v })} min={60} max={86400} invalid={ttl === null} />
        </Field>
        <Field label={t('platformSettings.dns.resolvers') || 'Public resolvers'} htmlFor="dns-resolvers" error={draft.resolvers.length === 0 ? (t('platformSettings.dns.resolversRequired') || 'At least one resolver.') : null} hint={t('platformSettings.dns.resolversHint') || 'Used for the ownership and delegation checks (never the Docker DNS).'}>
          <ChipsInput id="dns-resolvers" value={draft.resolvers} onChange={(v) => set({ resolvers: v })} validate={isIp} max={8} placeholder="1.1.1.1" />
        </Field>
        <Field label={t('platformSettings.dns.axfr') || 'Secondary servers allowed to transfer (AXFR)'} htmlFor="dns-axfr" hint={t('platformSettings.dns.axfrHint') || 'IP addresses or CIDR ranges.'}>
          <ChipsInput id="dns-axfr" value={draft.axfrAllowFrom} onChange={(v) => set({ axfrAllowFrom: v })} validate={isIpOrCidr} max={32} placeholder="198.51.100.53" />
        </Field>
        <Field label={t('platformSettings.dns.alsoNotify') || 'Servers notified of changes (NOTIFY)'} htmlFor="dns-notify" hint={t('platformSettings.dns.alsoNotifyHint') || 'IP addresses of the secondary servers.'}>
          <ChipsInput id="dns-notify" value={draft.alsoNotify} onChange={(v) => set({ alsoNotify: v })} validate={isIp} max={16} placeholder="198.51.100.53" />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ToggleSwitch
          checked={draft.dnssecDefault}
          onChange={(v) => set({ dnssecDefault: v })}
          label={t('platformSettings.dns.dnssec') || 'DNSSEC on new zones'}
          description={t('platformSettings.dns.dnssecHint') || 'The DS record must then be published at the registrar of each domain.'}
        />
        <ToggleSwitch
          checked={draft.allowNsProof}
          onChange={(v) => set({ allowNsProof: v })}
          label={t('platformSettings.dns.nsProof') || 'Accept the NS delegation as ownership proof'}
          description={t('platformSettings.dns.nsProofHint') || 'A domain delegated to our name servers is verified without TXT record. The TXT record stays the strong proof: a squatter who delegated first could be verified by NS.'}
        />
      </div>
    </SettingsBlock>
  );
}

/** Amber advice under a host field (same registrable domain as the panel: allowed, explained). */
function SameSiteNote({ text }: { text: string }) {
  return (
    <p className="mb-1.5 flex items-start gap-1.5 text-xs text-status-pending">
      <AlertTriangle size={12} className="mt-0.5 shrink-0" />
      <span>{text}</span>
    </p>
  );
}

// ── Previews ────────────────────────────────────────────────────────────────

function PreviewSection({ value, panelHost, save }: { value: HostingSettings['preview']; panelHost: string | null; save: SaveFn }) {
  const { t } = useTranslation();
  const [draft, setDraft, dirty, reset] = useDraft({ previewDomain: value.previewDomain ?? '', wildcardCertificate: value.wildcardCertificate });
  const { saving, error, setError, run } = useSaver(save);
  const domain = normalizeHostname(draft.previewDomain);
  const invalid = !!domain && !isHostname(domain);
  // Same site as the panel: advised against (R-SAMESITE), not refused — the panel cookie is __Host- and every
  // request is origin-checked. Only the panel host itself is refused.
  const panelItself = !invalid && isPanelHost(domain, panelHost);
  const sameSite = !invalid && !panelItself && previewConflictsWithPanel(domain, panelHost);
  const valid = !invalid && !panelItself;

  return (
    <SettingsBlock
      id="settings-preview"
      icon={<Eye />}
      title={t('platformSettings.preview.title') || 'Previews'}
      description={t('platformSettings.preview.description') || 'Blue/green previews are served on <site>-<id>.<preview domain>.'}
      dirty={dirty} saving={saving} canSave={valid}
      onSave={() => { void run('preview', { previewDomain: domain || null, wildcardCertificate: draft.wildcardCertificate }); }}
      onReset={reset} error={error}
    >
      <div className="flex items-start gap-2 rounded-md border border-status-pending/30 bg-status-pending-bg p-3 text-sm text-status-pending">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span>{t('platformSettings.preview.warning') || 'Use a registrable domain of its own (e.g. example-preview.net), distinct from the panel domain: a preview runs tenant code, and on a sub-domain of the panel it could read or set the panel cookies.'}</span>
      </div>
      <Field
        label={t('platformSettings.preview.domain') || 'Preview domain'}
        htmlFor="preview-domain"
        error={invalid ? (t('platformSettings.preview.invalid') || 'Enter a domain name (e.g. example-preview.net).') : panelItself ? (t('platformSettings.errors.panelHost') || 'This is the panel host name.') : null}
        hint={t('platformSettings.preview.domainHint') || 'Empty: previews have no public URL. Point *.<domain> (A / AAAA) to this server.'}
      >
        {sameSite && <SameSiteNote text={t('platformSettings.preview.sameSite') || 'Same registrable domain as the panel: allowed, but a preview runs tenant code next to the panel (it could flood the panel domain with cookies). A domain of its own is safer.'} />}
        <input id="preview-domain" value={draft.previewDomain} onChange={(e) => { setDraft({ ...draft, previewDomain: e.target.value }); setError(null); }} placeholder={t('platformSettings.preview.placeholder') || 'example-preview.net'} autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(settingsInputCls, 'font-mono')} />
      </Field>
      <ToggleSwitch
        checked={draft.wildcardCertificate}
        onChange={(v) => { setDraft({ ...draft, wildcardCertificate: v }); setError(null); }}
        disabled={!domain}
        label={t('platformSettings.preview.wildcard') || 'Wildcard certificate'}
        description={t('platformSettings.preview.wildcardHint') || 'One *.<domain> certificate through DNS-01: the zone of the preview domain must be hosted on our DNS server. Off: one certificate per preview host.'}
      />
    </SettingsBlock>
  );
}

// ── Release previews (feature B) ───────────────────────────────────────────

function ReleasePreviewsSection({ value, previewDomain, save }: { value: HostingSettings['releasePreviews']; previewDomain: string | null; save: SaveFn }) {
  const { t } = useTranslation();
  const [draft, setDraft, dirty, reset] = useDraft({
    enabled: value.enabled,
    defaultTtlMinutes: String(value.defaultTtlMinutes),
    maxTtlMinutes: String(value.maxTtlMinutes),
    maxPerAccount: String(value.maxPerAccount),
    maxTotal: String(value.maxTotal),
    memoryMb: String(value.memoryMb),
    cpus: String(value.cpus),
    minIntervalSeconds: String(value.minIntervalSeconds),
    dbCloneMaxMb: String(value.dbCloneMaxMb),
  });
  const { saving, error, setError, run } = useSaver(save);
  const set = (patch: Partial<typeof draft>) => { setDraft({ ...draft, ...patch }); setError(null); };
  const range = (min: number, max: number) => t('platformSettings.errors.range', { min, max, defaultValue: 'Between {{min}} and {{max}}.' });
  const defTtl = intInRange(draft.defaultTtlMinutes, 5, 1440);
  const maxTtl = intInRange(draft.maxTtlMinutes, 5, 1440);
  const perAccount = intInRange(draft.maxPerAccount, 1, 10);
  const total = intInRange(draft.maxTotal, 1, 200);
  const memory = intInRange(draft.memoryMb, 128, 4096);
  const cpusNum = Number(draft.cpus);
  const cpus = Number.isFinite(cpusNum) && cpusNum >= 0.25 && cpusNum <= 4 ? cpusNum : null;
  const interval = intInRange(draft.minIntervalSeconds, 0, 3600);
  const cloneMax = intInRange(draft.dbCloneMaxMb, 0, 65536);
  const ttlOrder = defTtl !== null && maxTtl !== null && defTtl > maxTtl;
  const valid = defTtl !== null && maxTtl !== null && perAccount !== null && total !== null && memory !== null && cpus !== null && interval !== null && cloneMax !== null && !ttlOrder;
  const num = (id: keyof typeof draft, label: string, min: number, max: number, parsed: number | null) => (
    <Field label={label} htmlFor={`rp-${id}`} error={parsed === null ? range(min, max) : null}>
      <NumberInput id={`rp-${id}`} value={String(draft[id])} onChange={(v) => set({ [id]: v } as Partial<typeof draft>)} min={min} max={max} invalid={parsed === null} />
    </Field>
  );

  return (
    <SettingsBlock
      id="settings-release-previews"
      icon={<Eye />}
      title={t('previews.settings.title') || 'Release previews'}
      description={t('previews.settings.explain') || 'Live previews of a release or of the staging, on the preview domain (needs a preview domain).'}
      dirty={dirty} saving={saving} canSave={valid}
      onSave={() => {
        if (!valid) return;
        void run('releasePreviews', {
          enabled: draft.enabled, defaultTtlMinutes: defTtl!, maxTtlMinutes: maxTtl!, maxPerAccount: perAccount!, maxTotal: total!,
          memoryMb: memory!, cpus: cpus!, minIntervalSeconds: interval!, dbCloneMaxMb: cloneMax!,
        });
      }}
      onReset={reset} error={error ?? (ttlOrder ? range(5, maxTtl ?? 1440) : null)}
    >
      {!previewDomain && (
        <p className="flex items-start gap-2 text-sm text-status-pending">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {t('sites.errors.previewDomainMissing') || 'No preview domain is configured on this platform.'}
        </p>
      )}
      <ToggleSwitch checked={draft.enabled} onChange={(v) => set({ enabled: v })} label={t('previews.settings.enabled') || 'Enabled'} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {num('defaultTtlMinutes', t('previews.settings.defaultTtlMinutes') || 'Default duration (min)', 5, 1440, defTtl)}
        {num('maxTtlMinutes', t('previews.settings.maxTtlMinutes') || 'Longest duration (min)', 5, 1440, maxTtl)}
        {num('maxPerAccount', t('previews.settings.maxPerAccount') || 'Previews per account', 1, 10, perAccount)}
        {num('maxTotal', t('previews.settings.maxTotal') || 'Previews on the platform', 1, 200, total)}
        {num('memoryMb', t('previews.settings.memoryMb') || 'Memory per preview (MiB)', 128, 4096, memory)}
        <Field label={t('previews.settings.cpus') || 'CPUs per preview'} htmlFor="rp-cpus" error={cpus === null ? range(0.25, 4) : null}>
          <input id="rp-cpus" type="number" step="0.25" min={0.25} max={4} value={draft.cpus} onChange={(e) => set({ cpus: e.target.value })} className={cn(settingsInputCls, 'font-mono', cpus === null && 'ring-2 ring-status-down/50')} />
        </Field>
        {num('minIntervalSeconds', t('previews.settings.minIntervalSeconds') || 'Minimum delay between two previews of a site (s)', 0, 3600, interval)}
        {num('dbCloneMaxMb', t('previews.settings.dbCloneMaxMb') || 'Largest database copy (MiB, 0 = copies off)', 0, 65536, cloneMax)}
      </div>
      <p className="text-xs text-text-muted">
        {t('previews.settings.dbCloneHint') || 'A preview may get a throw-away copy of the site\'s database(s), in memory, on a network of its own: the live database is never reachable. The copy counts in the memory of the host while the preview runs.'}
      </p>
    </SettingsBlock>
  );
}

// ── Database admin ──────────────────────────────────────────────────────────

function DbAdminSection({ value, panelHost, previewDomain, save }: { value: HostingSettings['dbAdmin']; panelHost: string | null; previewDomain: string | null; save: SaveFn }) {
  const { t } = useTranslation();
  const [draft, setDraft, dirty, reset] = useDraft({
    hostname: value.hostname ?? '', explorerImportMaxMb: String(value.explorerImportMaxMb ?? 256), explorerExportMaxMb: String(value.explorerExportMaxMb ?? 4096),
  });
  const { saving, error, setError, run } = useSaver(save);
  const host = normalizeHostname(draft.hostname);
  const invalid = !!host && !isHostname(host);
  const panelItself = !invalid && isPanelHost(host, panelHost);
  const sameSite = !invalid && !panelItself && dbAdminConflictsWithPanel(host, panelHost);
  const importMax = intInRange(draft.explorerImportMaxMb, 1, 16384);
  const exportMax = intInRange(draft.explorerExportMaxMb, 1, 65536);
  const valid = !invalid && !panelItself && importMax !== null && exportMax !== null;
  const range = (min: number, max: number) => t('platformSettings.errors.range', { min, max, defaultValue: 'Between {{min}} and {{max}}.' });
  const suggestion = previewDomain ? `db.${previewDomain}` : null;

  return (
    <SettingsBlock
      id="settings-dbadmin"
      icon={<Database />}
      title={t('platformSettings.dbAdmin.title') || 'Database administration'}
      description={t('platformSettings.dbAdmin.description') || 'phpMyAdmin and Adminer are opened from the panel with single sign-on, on their own host name.'}
      dirty={dirty} saving={saving} canSave={valid}
      onSave={() => { if (valid) void run('dbAdmin', { hostname: host || null, explorerImportMaxMb: importMax!, explorerExportMaxMb: exportMax! }); }}
      onReset={reset} error={error}
    >
      <Field
        label={t('platformSettings.dbAdmin.hostname') || 'Host name'}
        htmlFor="dbadmin-host"
        error={invalid ? (t('platformSettings.errors.hostname') || 'Enter a fully qualified host name.') : panelItself ? (t('platformSettings.errors.panelHost') || 'This is the panel host name.') : null}
        hint={suggestion
          ? t('platformSettings.dbAdmin.hintSuggest', { value: suggestion, defaultValue: 'For instance {{value}}. Empty: the admin tools are off.' })
          : (t('platformSettings.dbAdmin.hint') || 'For instance db.<preview domain>. Empty: the admin tools are off.')}
      >
        {sameSite && <SameSiteNote text={t('platformSettings.dbAdmin.sameSite') || 'Same registrable domain as the panel: allowed. A flaw in phpMyAdmin / Adminer could then flood the panel domain with cookies (clear them to recover); a separate domain avoids it.'} />}
        <input id="dbadmin-host" value={draft.hostname} onChange={(e) => { setDraft({ ...draft, hostname: e.target.value }); setError(null); }} placeholder={suggestion ?? 'db.example-preview.net'} autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(settingsInputCls, 'font-mono')} />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('platformSettings.dbAdmin.explorerImportMaxMb') || 'SQL explorer: largest import (MiB)'} htmlFor="dbadmin-import" error={importMax === null ? range(1, 16384) : null}>
          <NumberInput id="dbadmin-import" value={draft.explorerImportMaxMb} onChange={(v) => { setDraft({ ...draft, explorerImportMaxMb: v }); setError(null); }} min={1} max={16384} invalid={importMax === null} />
        </Field>
        <Field label={t('platformSettings.dbAdmin.explorerExportMaxMb') || 'SQL explorer: largest export (MiB)'} htmlFor="dbadmin-export" error={exportMax === null ? range(1, 65536) : null}>
          <NumberInput id="dbadmin-export" value={draft.explorerExportMaxMb} onChange={(v) => { setDraft({ ...draft, explorerExportMaxMb: v }); setError(null); }} min={1} max={65536} invalid={exportMax === null} />
        </Field>
      </div>
      <p className="text-xs text-text-muted">{t('platformSettings.dbAdmin.explorerHint') || 'The integrated SQL explorer works without phpMyAdmin / Adminer: these caps bound its file imports (gzip counted compressed) and exports.'}</p>
    </SettingsBlock>
  );
}

// ── Access (probes, bans, egress) ───────────────────────────────────────────

type Egress = HostingSettings['access']['egressFilter'];
const EGRESS: Egress[] = ['off', 'metadata', 'strict'];

function AccessSection({ value, panel, save }: { value: HostingSettings['access']; panel: AppConfigData | null; save: SaveFn }) {
  const { t } = useTranslation();
  const [draft, setDraft, dirty, reset] = useDraft({
    probeHostV4: value.probeHostV4 ?? '',
    probeHostV6: value.probeHostV6 ?? '',
    defaultGrantTtlMinutes: String(value.defaultGrantTtlMinutes),
    banThreshold: String(value.banThreshold),
    banWindowMinutes: String(value.banWindowMinutes),
    banDurationMinutes: String(value.banDurationMinutes),
    egressFilter: value.egressFilter,
  });
  const { saving, error, setError, run } = useSaver(save);
  const set = (patch: Partial<typeof draft>) => { setDraft({ ...draft, ...patch }); setError(null); };

  const v4 = normalizeHostname(draft.probeHostV4);
  const v6 = normalizeHostname(draft.probeHostV6);
  const v4Bad = !!v4 && !isHostname(v4);
  const v6Bad = !!v6 && !isHostname(v6);
  const ttl = intInRange(draft.defaultGrantTtlMinutes, 15, 1440);
  const threshold = intInRange(draft.banThreshold, 3, 1000);
  const windowMin = intInRange(draft.banWindowMinutes, 1, 1440);
  const duration = intInRange(draft.banDurationMinutes, 1, 43200);
  const valid = !v4Bad && !v6Bad && ttl !== null && threshold !== null && windowMin !== null && duration !== null;
  const range = (min: number, max: number) => t('platformSettings.errors.range', { min, max, defaultValue: 'Between {{min}} and {{max}}.' });

  const records = [
    v4 ? { name: v4, type: 'A', value: panel?.public_ipv4 ?? null } : null,
    v6 ? { name: v6, type: 'AAAA', value: panel?.public_ipv6 ?? null } : null,
  ].filter((r): r is { name: string; type: string; value: string | null } => r !== null);

  const egressHint = (f: Egress) => ({
    off: t('platformSettings.access.egress.offHint') || 'No filter: the sites may reach any address, including the cloud metadata service and the host.',
    metadata: t('platformSettings.access.egress.metadataHint') || 'Recommended: the account networks cannot reach 169.254.0.0/16 (cloud metadata) nor the host outside ports 80/443.',
    strict: t('platformSettings.access.egress.strictHint') || 'Also refuses the private ranges (RFC 1918, ULA, link-local) outside the account network. May break sites that call internal services.',
  })[f];

  return (
    <SettingsBlock
      id="settings-access"
      icon={<ShieldCheck />}
      title={t('platformSettings.access.title') || 'Access'}
      description={t('platformSettings.access.description') || 'Address probes of the « auto after 2FA » mode, bans after authentication failures, egress filter of the account networks.'}
      dirty={dirty} saving={saving} canSave={valid}
      onSave={() => {
        if (!valid) return;
        void run('access', {
          probeHostV4: v4 || null, probeHostV6: v6 || null, defaultGrantTtlMinutes: ttl!, banThreshold: threshold!,
          banWindowMinutes: windowMin!, banDurationMinutes: duration!, egressFilter: draft.egressFilter,
        });
      }}
      onReset={reset} error={error}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label={t('platformSettings.access.probeV4') || 'IPv4 probe host'} htmlFor="probe-v4" error={v4Bad ? (t('platformSettings.errors.hostname') || 'Enter a fully qualified host name.') : null} hint={t('platformSettings.access.probeV4Hint') || 'A name with an A record only (no AAAA).'}>
          <input id="probe-v4" value={draft.probeHostV4} onChange={(e) => set({ probeHostV4: e.target.value })} placeholder="ip4.example-preview.net" autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(settingsInputCls, 'font-mono')} />
        </Field>
        <Field label={t('platformSettings.access.probeV6') || 'IPv6 probe host'} htmlFor="probe-v6" error={v6Bad ? (t('platformSettings.errors.hostname') || 'Enter a fully qualified host name.') : null} hint={t('platformSettings.access.probeV6Hint') || 'A name with an AAAA record only (no A).'}>
          <input id="probe-v6" value={draft.probeHostV6} onChange={(e) => set({ probeHostV6: e.target.value })} placeholder="ip6.example-preview.net" autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(settingsInputCls, 'font-mono')} />
        </Field>
      </div>
      {records.length > 0 && (
        <div className="rounded-lg bg-bg-primary p-3">
          <div className="mb-2 text-xs text-text-muted">{t('platformSettings.access.records') || 'DNS records to create (and nothing else on these names):'}</div>
          <ul className="space-y-1.5">
            {records.map((r) => {
              const line = `${r.name}. ${r.type} ${r.value ?? '?'}`;
              return (
                <li key={r.type} className="flex items-center gap-2 font-mono text-xs text-text-primary">
                  <span className="min-w-0 flex-1 break-all">{r.name} <span className="text-accent">{r.type}</span> {r.value ?? <span className="text-amber-400">{t('platformSettings.access.noIp') || '(no public IP of this family in the setup)'}</span>}</span>
                  {r.value && <CopyButton text={line} />}
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-text-muted">{t('platformSettings.access.recordsHint') || 'Each probe host must resolve in ONE family only, otherwise the browser picks the family and the other address of the client is never seen. Use host names outside the panel domain.'}</p>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={t('platformSettings.access.grantTtl') || 'Default grant lifetime (min)'} htmlFor="acc-ttl" error={ttl === null ? range(15, 1440) : null}>
          <NumberInput id="acc-ttl" value={draft.defaultGrantTtlMinutes} onChange={(v) => set({ defaultGrantTtlMinutes: v })} min={15} max={1440} invalid={ttl === null} />
        </Field>
        <Field label={t('platformSettings.access.banThreshold') || 'Failures before a ban'} htmlFor="acc-threshold" error={threshold === null ? range(3, 1000) : null}>
          <NumberInput id="acc-threshold" value={draft.banThreshold} onChange={(v) => set({ banThreshold: v })} min={3} max={1000} invalid={threshold === null} />
        </Field>
        <Field label={t('platformSettings.access.banWindow') || 'Within (min)'} htmlFor="acc-window" error={windowMin === null ? range(1, 1440) : null}>
          <NumberInput id="acc-window" value={draft.banWindowMinutes} onChange={(v) => set({ banWindowMinutes: v })} min={1} max={1440} invalid={windowMin === null} />
        </Field>
        <Field label={t('platformSettings.access.banDuration') || 'Ban duration (min)'} htmlFor="acc-duration" error={duration === null ? range(1, 43200) : null}>
          <NumberInput id="acc-duration" value={draft.banDurationMinutes} onChange={(v) => set({ banDurationMinutes: v })} min={1} max={43200} invalid={duration === null} />
        </Field>
      </div>
      <div>
        <div className="mb-2 text-sm font-medium text-text-secondary">{t('platformSettings.access.egressTitle') || 'Egress filter of the account networks'}</div>
        <div role="radiogroup" aria-label={t('platformSettings.access.egressTitle') || 'Egress filter of the account networks'} className="grid grid-cols-1 gap-2 md:grid-cols-3">
          {EGRESS.map((f) => {
            const selected = draft.egressFilter === f;
            return (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => set({ egressFilter: f })}
                className={cn('rounded-lg border-2 p-3 text-left transition-all', selected ? 'border-accent bg-accent/5' : 'border-transparent bg-bg-primary hover:border-accent/30')}
              >
                <div className="text-sm font-semibold text-text-primary">{t(`platformSettings.access.egress.${f}`) || f}</div>
                <p className="mt-1 text-xs text-text-secondary">{egressHint(f)}</p>
              </button>
            );
          })}
        </div>
      </div>
    </SettingsBlock>
  );
}

// ── Usage ───────────────────────────────────────────────────────────────────

function UsageSection({ value, save }: { value: HostingSettings['usage']; save: SaveFn }) {
  const { t } = useTranslation();
  const [draft, setDraft, dirty, reset] = useDraft({
    alertThresholds: value.alertThresholds.map(String),
    accessLogRetentionDays: String(value.accessLogRetentionDays),
    resourceRetentionDays: String(value.resourceRetentionDays),
  });
  const { saving, error, setError, run } = useSaver(save);
  const set = (patch: Partial<typeof draft>) => { setDraft({ ...draft, ...patch }); setError(null); };
  const logs = intInRange(draft.accessLogRetentionDays, 1, 366);
  const res = intInRange(draft.resourceRetentionDays, 1, 90);
  const thresholds = draft.alertThresholds.map(Number).sort((a, b) => a - b);
  const valid = logs !== null && res !== null && thresholds.length > 0;
  const range = (min: number, max: number) => t('platformSettings.errors.range', { min, max, defaultValue: 'Between {{min}} and {{max}}.' });

  return (
    <SettingsBlock
      id="settings-usage"
      icon={<BarChart3 />}
      title={t('platformSettings.usage.title') || 'Usage'}
      description={t('platformSettings.usage.description') || 'Quota alerts and retention of the measures.'}
      dirty={dirty} saving={saving} canSave={valid}
      onSave={() => { if (valid) void run('usage', { alertThresholds: thresholds, accessLogRetentionDays: logs!, resourceRetentionDays: res! }); }}
      onReset={reset} error={error}
    >
      <Field
        label={t('platformSettings.usage.thresholds') || 'Alert thresholds (% of a quota)'}
        htmlFor="usage-thresholds"
        error={thresholds.length === 0 ? (t('platformSettings.usage.thresholdsRequired') || 'At least one threshold.') : null}
        hint={t('platformSettings.usage.thresholdsHint') || 'Up to 5 values between 1 and 200. At 100 %, the action of the plan applies (warn, block uploads, suspend).'}
      >
        <ChipsInput
          id="usage-thresholds"
          value={draft.alertThresholds}
          onChange={(v) => set({ alertThresholds: [...v].sort((a, b) => Number(a) - Number(b)) })}
          validate={(v) => intInRange(v, 1, 200) !== null}
          normalize={(v) => v.replace(/\s*%$/, '')}
          max={5}
          inputMode="numeric"
          placeholder="80"
        />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('platformSettings.usage.logRetention') || 'Access logs kept (days)'} htmlFor="usage-logs" error={logs === null ? range(1, 366) : null}>
          <NumberInput id="usage-logs" value={draft.accessLogRetentionDays} onChange={(v) => set({ accessLogRetentionDays: v })} min={1} max={366} invalid={logs === null} />
        </Field>
        <Field label={t('platformSettings.usage.resourceRetention') || 'Resource samples kept (days)'} htmlFor="usage-res" error={res === null ? range(1, 90) : null} hint={t('platformSettings.usage.resourceRetentionHint') || 'Beyond, only the hourly aggregates remain (90 days).'}>
          <NumberInput id="usage-res" value={draft.resourceRetentionDays} onChange={(v) => set({ resourceRetentionDays: v })} min={1} max={90} invalid={res === null} />
        </Field>
      </div>
    </SettingsBlock>
  );
}

// ── Panel address (identity from the setup wizard, editable afterwards) ─────
function PanelAddressSection({ panel, onSaved }: { panel: AppConfigData | null; onSaved: (p: AppConfigData) => void }) {
  const { t } = useTranslation();
  const initial = { host: panel?.panel_hostname ?? '', clientHost: panel?.client_panel_hostname ?? '', v4: panel?.public_ipv4 ?? '', v6: panel?.public_ipv6 ?? '', email: panel?.acme_email ?? '' };
  const [draft, setDraft, dirty, reset] = useDraft(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const host = normalizeHostname(draft.host);
  const clientHost = normalizeHostname(draft.clientHost);
  const clientInvalid = !!clientHost && (!isHostname(clientHost) || clientHost === host);
  const invalid = !isHostname(host) || clientInvalid || (!!draft.v4.trim() && !isIp(draft.v4.trim())) || (!!draft.v6.trim() && !isIp(draft.v6.trim())) || !isEmail(draft.email.trim());
  const onSave = async () => {
    setSaving(true); setError(null);
    try {
      const res = await apiClient.put<{ success: boolean; data: AppConfigData }>('/admin/config/platform', { panelHostname: host, clientPanelHostname: clientHost, publicIpv4: draft.v4.trim(), publicIpv6: draft.v6.trim(), acmeEmail: draft.email.trim() });
      onSaved(res.data.data);
      toast.success(t('platformSettings.saved') || 'Settings saved');
    } catch (err) {
      if (!isStepUpHandled(err)) setError(opsErrorMessage(t, err, 'platformSettings', t('platformSettings.saveFailed') || 'Failed to save the settings'));
    } finally { setSaving(false); }
  };
  const set = (k: keyof typeof initial) => (e: React.ChangeEvent<HTMLInputElement>) => { setDraft({ ...draft, [k]: e.target.value }); setError(null); };
  return (
    <SettingsBlock
      id="settings-panel-address"
      icon={<Server />}
      title={t('platformSettings.panel.title') || 'Panel address'}
      description={t('platformSettings.panel.description') || 'Host name of this panel and public addresses of the node. The edge serves the panel on this name and requests its certificate as soon as the DNS points here.'}
      dirty={dirty} saving={saving} canSave={!invalid}
      onSave={() => { void onSave(); }}
      onReset={reset} error={error}
    >
      <Field label={t('platformSettings.panel.host') || 'Panel host name'} htmlFor="panel-host" hint={t('platformSettings.panel.hostHint') || 'Create an A (and AAAA) record of this name to the public IP of the server. Customers sign in at https://<name>/client.'}>
        <input id="panel-host" value={draft.host} onChange={set('host')} placeholder="panel.example.com" autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(settingsInputCls, 'font-mono')} />
      </Field>
      <Field
        label={t('platformSettings.panel.clientHost') || 'Client space host name (optional)'}
        htmlFor="panel-client-host"
        hint={clientHost && clientHost === host
          ? (t('platformSettings.panel.clientHostSame') || 'The client space needs its own name, not the panel one.')
          : (t('platformSettings.panel.clientHostHint') || 'Same panel on a second name, with its own certificate: customers sign in there directly, without SSO. Once set, clients can no longer sign in on the panel host and administrators cannot sign in on the client space. Create an A (and AAAA) record of this name to the server. Empty = none.')}
      >
        <input id="panel-client-host" value={draft.clientHost} onChange={set('clientHost')} placeholder="espace.example.com" autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(settingsInputCls, 'font-mono', clientInvalid && 'border-status-down')} />
      </Field>
      <Field label={t('platformSettings.panel.ipv4') || 'Public IPv4'} htmlFor="panel-v4">
        <input id="panel-v4" value={draft.v4} onChange={set('v4')} placeholder="203.0.113.10" className={cn(settingsInputCls, 'font-mono')} />
      </Field>
      <Field label={t('platformSettings.panel.ipv6') || 'Public IPv6 (optional)'} htmlFor="panel-v6">
        <input id="panel-v6" value={draft.v6} onChange={set('v6')} placeholder="2001:db8::10" className={cn(settingsInputCls, 'font-mono')} />
      </Field>
      <Field label={t('platformSettings.panel.acmeEmail') || "Let's Encrypt e-mail"} htmlFor="panel-acme">
        <input id="panel-acme" value={draft.email} onChange={set('email')} placeholder="admin@example.com" className={settingsInputCls} />
      </Field>
    </SettingsBlock>
  );
}
