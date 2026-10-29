import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  AlertTriangle, CheckCircle2, Globe, Mail, RefreshCw, ShieldAlert, ShieldBan, ShieldCheck, SlidersHorizontal, Unlock, Workflow, XCircle, Zap,
} from 'lucide-react';
import {
  HostingSocketEvents, MAIL_ENGINES, isMailEngineSupported,
  type AppConfigData, type HostingSettings, type HostingSettingsUpdate, type InfraComponentStatus, type MailBan, type MailEngine, type MailPtrCheck,
  type MailSettings, type MailSystemStatus, type MailUpdatedPayload, type OpenRelayTestResult, type WebmailKind,
} from '@oblimint/shared';
import { hostingSettingsApi } from '@/api/hostingSettings.api';
import { systemMailApi } from '@/api/mail.api';
import { isStepUpHandled } from '@/api/client';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TableScroll } from '@/components/common/TableScroll';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { PlatformCertInline, usePlatformCertificates } from '@/components/settings/PlatformCertificates';
import { Field, SettingsBlock, settingsInputCls } from '@/components/settings/SettingsBlock';
import { EmptyState, InfoRow, Pill, thCls, theadRowCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { DnsCheckPill, useMailEngineLabel } from './MailBadges';
import { mailErrorMessage, mailLoadError, toastMailError } from './mailErrors';
import { intIn, isUnderPanelHost, isValidAddress, isValidHostname, numIn } from './mailFormat';

/**
 * Settings page sections of the mail service (platform admin): engine status
 * and synchronisation, engine change (while no mailbox / alias exists), webmail
 * choice and host names, DNS defaults (DMARC, MTA-STS, TLS-RPT, DKIM),
 * anti-spam (scores, greylisting, ClamAV), sizes and quotas, relay and abuse
 * protection, bans, open relay self-test (docs/P4-PLAN.md §12). Settings
 * section `mail` of /api/system/hosting-settings + /api/system/mail.
 * OWNED BY MODULE `ui-mail`.
 */
export function MailSettingsSections() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<HostingSettings | null>(null);
  const [panel, setPanel] = useState<AppConfigData | null>(null);
  const [panelFailed, setPanelFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { reload: reloadCerts } = usePlatformCertificates();

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([hostingSettingsApi.get(), hostingSettingsApi.panelConfig()]).then(([s, p]) => {
      if (cancelled) return;
      if (s.status === 'fulfilled') { setSettings(s.value); setError(null); } else setError(mailLoadError(t, s.reason, t('mailSettings.loadFailed') || 'Failed to load the mail settings'));
      if (p.status === 'fulfilled') { setPanel(p.value); setPanelFailed(false); } else setPanelFailed(true);
    });
    return () => { cancelled = true; };
  }, [t]);

  const save = async (patch: Partial<MailSettings>): Promise<string | null> => {
    try {
      setSettings(await hostingSettingsApi.update({ mail: patch } as HostingSettingsUpdate));
      toast.success(t('mailSettings.saved') || 'Mail settings saved');
      reloadCerts(); // a new mail / webmail host name: its certificate line (Hosting → platform certificates)
      return null;
    } catch (err) {
      if (isStepUpHandled(err)) return '';
      return mailErrorMessage(t, err, t('mailSettings.saveFailed') || 'Failed to save the mail settings');
    }
  };

  return (
    <>
      <MailEngineBlock />
      {!settings?.mail ? (
        <SettingsBlock icon={<SlidersHorizontal />} title={t('mailSettings.title') || 'Mail service'}>
          {error ? <p className="flex items-start gap-2 text-sm text-text-muted"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</p> : <div className="flex justify-center py-4"><LoadingSpinner /></div>}
        </SettingsBlock>
      ) : (
        <>
          <MailServiceBlock value={settings.mail} panelHost={panel?.panel_hostname ?? null} panelUnknown={panelFailed} save={save} />
          <MailDnsDefaultsBlock value={settings.mail} save={save} />
          <MailAntispamBlock value={settings.mail} save={save} />
          <MailAbuseBlock value={settings.mail} save={save} />
        </>
      )}
      <RelayTestBlock />
    </>
  );
}

type SaveFn = (patch: Partial<MailSettings>) => Promise<string | null>;

/** Form draft that follows the saved value until edited. */
function useDraft<T>(value: T): [T, (patch: Partial<T>) => void, boolean, () => void] {
  const [draft, setDraft] = useState<T>(value);
  const [base, setBase] = useState<T>(value);
  const key = JSON.stringify(value);
  useEffect(() => { setDraft(value); setBase(value); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return [draft, (patch) => setDraft((d) => ({ ...d, ...patch })), JSON.stringify(draft) !== JSON.stringify(base), () => setDraft(base)];
}

function NumberField({ id, label, value, onChange, min, max, hint, decimals = false }: {
  id: string; label: string; value: string; onChange: (v: string) => void; min: number; max: number; hint?: string; decimals?: boolean;
}) {
  const { t } = useTranslation();
  const ok = (decimals ? numIn(value, min, max) : intIn(value, min, max)) !== null;
  return (
    <Field label={label} htmlFor={id} hint={hint} error={ok ? null : t('mailSettings.range', { min, max, defaultValue: 'Between {{min}} and {{max}}.' })}>
      <input id={id} type="number" inputMode={decimals ? 'decimal' : 'numeric'} step={decimals ? '0.5' : '1'} min={min} max={max} value={value} onChange={(e) => onChange(e.target.value)} className={cn(settingsInputCls, 'font-mono', !ok && 'ring-2 ring-status-down/50')} />
    </Field>
  );
}

const selectSettingsCls = settingsInputCls;

// ── Engine status, synchronisation, engine change ───────────────────────────

function ComponentLine({ c }: { c: InfraComponentStatus }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg bg-bg-primary p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-text-primary">{c.id}</span>
        {!c.deployed
          ? <Pill tone="red">{t('infra.notDeployed') || 'not deployed'}</Pill>
          : c.running ? <Pill tone="green">{t('infra.running') || 'running'}</Pill> : <Pill tone="amber">{t('infra.stopped') || 'stopped'}</Pill>}
        {c.version && <span className="ml-auto font-mono text-[11px] text-text-muted">{c.version}</span>}
      </div>
      {c.image && <div className="mt-1 break-all font-mono text-[11px] text-text-muted">{c.image}</div>}
      {c.detail && <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-text-muted">{c.detail}</pre>}
    </div>
  );
}

function PtrLine({ label, p }: { label: string; p: MailPtrCheck | null }) {
  const { t } = useTranslation();
  if (!p) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="w-10 font-mono text-text-muted">{label}</span>
      <span className="font-mono text-text-primary">{p.ip}</span>
      <span className="text-text-muted">→</span>
      <span className="font-mono text-text-secondary">{p.found.length ? p.found.join(', ') : '—'}</span>
      <span className="text-text-muted">({t('mail.ptr.expected') || 'Expected'} <span className="font-mono">{p.expected}</span>)</span>
      <DnsCheckPill status={p.status} />
    </div>
  );
}

function MailEngineBlock() {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const engineLabel = useMailEngineLabel();
  const [status, setStatus] = useState<MailSystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'sync' | 'force' | 'engine' | null>(null);
  const [nextEngine, setNextEngine] = useState<MailEngine | ''>('');

  const load = useCallback(async () => {
    try {
      setStatus(await systemMailApi.status());
      setError(null);
    } catch (err) {
      setStatus(null);
      setError(mailLoadError(t, err, t('mailSettings.status.loadFailed') || 'Failed to load the mail service status'));
    }
  }, [t]);
  useEffect(() => { void load(); }, [load]);
  // Sync worker / engine change results (last sync, last error, components, queue).
  useHostingEvents([HostingSocketEvents.MAIL_UPDATED], () => { void load(); }, (_e, p) => (p as MailUpdatedPayload | null)?.entity === 'engine', 800);

  const sync = async (force: boolean) => {
    if (force && !(await confirm({
      title: t('mailSettings.status.forceTitle') || 'Force a full synchronisation',
      message: t('mailSettings.status.forceConfirm') || 'The whole configuration of the engine is rewritten and reloaded, even if nothing changed. Connections in progress may be cut for a few seconds.',
      confirmLabel: t('mailSettings.status.force') || 'Force',
      danger: true,
    }))) return;
    setBusy(force ? 'force' : 'sync');
    try {
      setStatus(await systemMailApi.sync(force));
      toast.success(t('mailSettings.status.synced') || 'Mail service synchronised');
    } catch (err) {
      toastMailError(t, err, t('mailSettings.status.syncFailed') || 'The synchronisation failed');
    } finally {
      setBusy(null);
    }
  };

  const changeEngine = async () => {
    if (!nextEngine || !status || nextEngine === status.engine) return;
    if (!(await confirm({
      title: t('mailSettings.engine.changeTitle') || 'Change the mail engine',
      message: t('mailSettings.engine.changeConfirm', { from: engineLabel(status.engine), to: engineLabel(nextEngine), defaultValue: 'The containers of {{from}} are removed (their data is kept on disk) and {{to}} is deployed. The DNS records and certificates are regenerated.' }),
      confirmLabel: t('mailSettings.engine.change') || 'Change the engine',
      danger: true,
    }))) return;
    setBusy('engine');
    try {
      setStatus(await systemMailApi.changeEngine(nextEngine));
      setNextEngine('');
      toast.success(t('mailSettings.engine.changed') || 'Mail engine changed');
    } catch (err) {
      toastMailError(t, err, t('mailSettings.engine.changeFailed') || 'Failed to change the mail engine');
    } finally {
      setBusy(null);
    }
  };

  const s = status;
  return (
    <SettingsBlock
      id="settings-mail-status"
      icon={<Mail />}
      title={t('mailSettings.status.title') || 'Mail service'}
      description={t('mailSettings.status.description') || 'Shared mail engine (ports 25, 465, 587, 143, 993, 110, 995, 4190), chosen in the setup wizard. The panel is the source of truth: the engine store is rebuilt from it at every synchronisation.'}
      headerExtra={<IconButton label={t('common.refresh') || 'Refresh'} icon={<RefreshCw size={14} />} onClick={() => { void load(); }} />}
    >
      {error ? (
        <p className="flex items-start gap-2 text-sm text-text-muted"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</p>
      ) : !s ? (
        <div className="flex justify-center py-4"><LoadingSpinner /></div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-text-primary">{engineLabel(s.engine)}</span>
            {s.engineSupported ? <Pill tone="green">{t('mailSettings.status.supported') || 'supported'}</Pill> : <Pill tone="red">{t('mailSettings.status.unsupported') || 'not supported'}</Pill>}
            {s.version && <span className="font-mono text-[11px] text-text-muted">{s.version}</span>}
            <span className="ml-auto flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" loading={busy === 'sync'} disabled={busy !== null || !s.engineSupported} onClick={() => { void sync(false); }}>
                <RefreshCw size={13} className="mr-1.5" />{t('mailSettings.status.sync') || 'Synchronise'}
              </Button>
              <Button size="sm" variant="secondary" loading={busy === 'force'} disabled={busy !== null || !s.engineSupported} onClick={() => { void sync(true); }}>
                <Zap size={13} className="mr-1.5" />{t('mailSettings.status.force') || 'Force'}
              </Button>
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <InfoRow label={t('mailSettings.status.hostname') || 'Mail host'} mono>{s.hostname ?? '—'}</InfoRow>
            <InfoRow label={t('mailSettings.status.lastSync') || 'Last sync'} mono>{s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString(i18n.language) : '—'}</InfoRow>
            <InfoRow label={t('mailSettings.status.counts') || 'Domains / mailboxes / aliases'} mono>{s.counts.domains} / {s.counts.mailboxes} / {s.counts.aliases}</InfoRow>
            <InfoRow label={t('mailSettings.status.queue') || 'Queue (active / deferred / hold)'} mono>{s.queue ? `${s.queue.active} / ${s.queue.deferred} / ${s.queue.hold}` : '—'}</InfoRow>
          </div>
          {s.lastSyncError && (
            <div>
              <div className="mb-1 text-xs text-text-muted">{t('mailSettings.status.lastError') || 'Last synchronisation error'}</div>
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-status-down/5 p-2 font-mono text-[11px] text-status-down">{s.lastSyncError}</pre>
            </div>
          )}
          {s.components.length > 0 && (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {/* Engine parts share id 'mail' and have no image until deployed: the index keeps keys unique. */}
              {s.components.map((c, i) => <ComponentLine key={`${c.id}-${c.image ?? ''}-${i}`} c={c} />)}
            </div>
          )}
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <div className="rounded-lg bg-bg-primary p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-text-secondary">{t('mailSettings.status.relay') || 'Site relay'}</span>
                {!s.relay.enabled ? <Pill>{t('mailSettings.status.off') || 'off'}</Pill> : s.relay.component?.running ? <Pill tone="green">{t('infra.running') || 'running'}</Pill> : <Pill tone="amber">{t('infra.stopped') || 'stopped'}</Pill>}
              </div>
              {s.relay.component?.detail && <p className="mt-1 break-words font-mono text-[11px] text-text-muted">{s.relay.component.detail}</p>}
            </div>
            <div className="rounded-lg bg-bg-primary p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-text-secondary">{t('mailSettings.status.webmail') || 'Webmail'}</span>
                <span className="font-mono text-[11px] text-text-muted">{webmailLabel(s.webmail.kind)}</span>
                {s.webmail.kind !== 'none' && (s.webmail.component?.running
                  ? <Pill tone="green">{t('infra.running') || 'running'}</Pill>
                  : s.webmail.component?.deployed
                    ? <Pill tone="amber">{t('infra.stopped') || 'stopped'}</Pill>
                    : <Pill>{t('infra.notDeployed') || 'not deployed'}</Pill>)}
              </div>
              {s.webmail.hostname && <p className="mt-1 font-mono text-[11px] text-text-secondary">{s.webmail.hostname}</p>}
              {/* Not deployed on purpose (webmail = none, no mailboxes yet): the detail is a note, not a problem. */}
              {s.webmail.component?.detail && (
                <p className={`mt-1 break-words font-mono text-[11px] ${s.webmail.kind !== 'none' && s.webmail.component.deployed ? 'text-amber-400' : 'text-text-muted'}`}>
                  {s.webmail.component.detail}
                </p>
              )}
            </div>
          </div>
          {(s.ptr.ipv4 || s.ptr.ipv6) && (
            <div className="space-y-1.5 rounded-lg bg-bg-primary p-2.5">
              <div className="text-xs font-semibold text-text-secondary">{t('mail.ptr.title') || 'Reverse DNS (PTR)'}</div>
              <PtrLine label="IPv4" p={s.ptr.ipv4} />
              <PtrLine label="IPv6" p={s.ptr.ipv6} />
              <p className="text-[11px] text-text-muted">{t('mailSettings.status.ptrHint') || 'Set at the hosting provider of the server: the PTR of each public address must point to the mail host.'}</p>
            </div>
          )}
          <p className="text-xs text-text-muted">
            <Link to="/security/bans?tab=mail" className="text-accent hover:underline">{t('mailSettings.status.bans', { count: s.activeBans, defaultValue: '{{count}} active ban(s) on the mail ports.' })}</Link>{' '}
            <Link to="/manage/nodes" className="text-accent hover:underline">{t('mailSettings.status.nodesLink') || 'Containers: Nodes page'}</Link>
          </p>

          <div className="rounded-lg bg-bg-primary p-3">
            <div className="mb-2 text-sm font-medium text-text-primary">{t('mailSettings.engine.title') || 'Mail engine'}</div>
            {s.engineChangeAllowed ? (
              <div className="flex flex-wrap items-center gap-2">
                <select aria-label={t('mailSettings.engine.title') || 'Mail engine'} value={nextEngine} onChange={(e) => setNextEngine(e.target.value as MailEngine | '')} className={cn(selectSettingsCls, 'w-full sm:w-72')}>
                  <option value="">{t('mailSettings.engine.choose') || 'Choose another engine…'}</option>
                  {MAIL_ENGINES.filter((e) => e !== s.engine).map((e) => (
                    <option key={e} value={e} disabled={!isMailEngineSupported(e)}>
                      {engineLabel(e)}{!isMailEngineSupported(e) ? ` — ${t('setup.mail.notSupported') || 'Not yet supported'}` : ''}
                    </option>
                  ))}
                </select>
                <Button size="sm" variant="danger" loading={busy === 'engine'} disabled={!nextEngine || busy !== null} onClick={() => { void changeEngine(); }}>
                  <Workflow size={13} className="mr-1.5" />{t('mailSettings.engine.change') || 'Change the engine'}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-text-muted">{t('mailSettings.engine.locked') || 'The engine can only be changed while no mailbox and no alias exist: changing it afterwards is a migration of the mailboxes, not a switch.'}</p>
            )}
          </div>
        </div>
      )}
    </SettingsBlock>
  );
}

function webmailLabel(kind: WebmailKind): string {
  return kind === 'roundcube' ? 'Roundcube' : kind === 'snappymail' ? 'SnappyMail' : kind === 'oblimint' ? 'Oblimint' : '—';
}

// ── Service: mail host, webmail ─────────────────────────────────────────────

/** `panelUnknown`: the panel host could not be loaded, so the webmail host cannot be checked against it. */
function MailServiceBlock({ value, panelHost, panelUnknown, save }: { value: MailSettings; panelHost: string | null; panelUnknown: boolean; save: SaveFn }) {
  const { t } = useTranslation();
  const [draft, set, dirty, reset] = useDraft({
    hostname: value.hostname ?? '',
    webmail: value.webmail,
    webmailHostname: value.webmailHostname ?? '',
    webmailPerDomain: value.webmailPerDomain,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hostOk = !draft.hostname.trim() || isValidHostname(draft.hostname);
  const wmOk = !draft.webmailHostname.trim() || isValidHostname(draft.webmailHostname);
  const underPanel = wmOk && isUnderPanelHost(draft.webmailHostname, panelHost);
  // Panel host unknown: a new (non-empty) webmail host cannot be checked (plan §11) — not saved until it is known.
  const wmUnchecked = panelUnknown && !!draft.webmailHostname.trim()
    && draft.webmailHostname.trim().toLowerCase() !== (value.webmailHostname ?? '').toLowerCase();
  const valid = hostOk && wmOk && !underPanel && !wmUnchecked;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    const err = await save({
      hostname: draft.hostname.trim().toLowerCase() || null,
      webmail: draft.webmail,
      webmailHostname: draft.webmailHostname.trim().toLowerCase() || null,
      webmailPerDomain: draft.webmailPerDomain,
    });
    setSaving(false);
    setError(err || null);
  };

  return (
    <SettingsBlock
      id="settings-mail-service"
      icon={<Globe />}
      title={t('mailSettings.service.title') || 'Mail host and webmail'}
      dirty={dirty} saving={saving} canSave={valid} onSave={() => { void submit(); }} onReset={() => { reset(); setError(null); }} error={error}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label={<>{t('mailSettings.service.hostname') || 'Mail host name'}<PlatformCertInline host={value.hostname} /></>} htmlFor="ms-host" hint={t('mailSettings.service.hostnameHint', { panel: panelHost ?? '—', defaultValue: 'MX target, SMTP / IMAP server and its certificate. Empty: the panel host ({{panel}}).' })} error={hostOk ? null : (t('mailSettings.errors.hostname') || 'Enter a fully qualified host name.')}>
          <input id="ms-host" value={draft.hostname} onChange={(e) => set({ hostname: e.target.value })} placeholder={panelHost ?? 'mail.example.com'} autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(settingsInputCls, 'font-mono')} />
        </Field>
        <Field label={t('mailSettings.service.webmail') || 'Webmail'} htmlFor="ms-webmail" hint={t('mailSettings.service.webmailHint') || 'Shared webmail container, opened from the panel without a password (single sign-on). Changing it redeploys the container.'}>
          <select id="ms-webmail" value={draft.webmail} onChange={(e) => set({ webmail: e.target.value as WebmailKind })} className={selectSettingsCls}>
            <option value="roundcube">Roundcube</option>
            <option value="snappymail">SnappyMail</option>
            <option value="oblimint">{t('mailSettings.service.oblimintWebmail') || 'Oblimint (built in, Stalwart engine)'}</option>
            <option value="none">{t('mailSettings.service.noWebmail') || 'No webmail'}</option>
          </select>
          {draft.webmail === 'oblimint' && (
            <p className="mt-1 text-xs text-text-muted">{t('mailSettings.service.oblimintHint') || 'Built-in webmail served by the panel itself on the webmail host (JMAP): needs the Stalwart mail engine, no container. Mailbox owners sign in with their address and password.'}</p>
          )}
        </Field>
        <Field
          label={<>{t('mailSettings.service.webmailHostname') || 'Platform webmail host'}<PlatformCertInline host={value.webmailHostname} /></>}
          htmlFor="ms-wmhost"
          hint={t('mailSettings.service.webmailHostnameHint') || 'For example webmail.<platform domain>. Empty: only webmail.<domain> of each mail domain.'}
          error={!wmOk ? (t('mailSettings.errors.hostname') || 'Enter a fully qualified host name.') : underPanel ? (t('mailSettings.service.underPanel', { panel: panelHost ?? '', defaultValue: 'Never the panel host ({{panel}}) nor one of its sub-domains: the webmail would share the panel cookies. It would not be served.' }))
            : wmUnchecked ? (t('mailSettings.service.panelUnknown') || 'The panel host could not be loaded: the webmail host cannot be checked against it, so a new value cannot be saved. Reload the page.') : null}
        >
          <input id="ms-wmhost" value={draft.webmailHostname} disabled={draft.webmail === 'none'} onChange={(e) => set({ webmailHostname: e.target.value })} placeholder="webmail.example.net" autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(settingsInputCls, 'font-mono', (underPanel || !wmOk || wmUnchecked) && 'ring-2 ring-status-down/50')} />
        </Field>
        <div className="pt-1">
          <ToggleSwitch
            checked={draft.webmailPerDomain}
            disabled={draft.webmail === 'none'}
            onChange={(v) => set({ webmailPerDomain: v })}
            label={t('mailSettings.service.perDomain') || 'webmail.<domain> for every mail domain'}
            description={t('mailSettings.service.perDomainHint') || 'DNS record and certificate added for each active mail domain.'}
          />
        </div>
      </div>
    </SettingsBlock>
  );
}

// ── DNS defaults ────────────────────────────────────────────────────────────

function MailDnsDefaultsBlock({ value, save }: { value: MailSettings; save: SaveFn }) {
  const { t } = useTranslation();
  const [draft, set, dirty, reset] = useDraft({
    autoconfig: value.autoconfig,
    srvRecords: value.srvRecords,
    dkimEd25519: value.dkimEd25519,
    rotation: value.dkimRotationDays != null,
    dkimRotationDays: String(value.dkimRotationDays ?? 365),
    dmarcPolicy: value.dmarcPolicy,
    dmarcRua: value.dmarcRua ?? '',
    mtaSts: value.mtaSts,
    tlsRptRua: value.tlsRptRua ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rotation = draft.rotation ? intIn(draft.dkimRotationDays, 30, 730) : null;
  const ruaOk = !draft.dmarcRua.trim() || isValidAddress(draft.dmarcRua);
  const tlsOk = !draft.tlsRptRua.trim() || isValidAddress(draft.tlsRptRua);
  const valid = (!draft.rotation || rotation !== null) && ruaOk && tlsOk;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    const err = await save({
      autoconfig: draft.autoconfig, srvRecords: draft.srvRecords, dkimEd25519: draft.dkimEd25519,
      dkimRotationDays: draft.rotation ? rotation : null,
      dmarcPolicy: draft.dmarcPolicy, dmarcRua: draft.dmarcRua.trim().toLowerCase() || null,
      mtaSts: draft.mtaSts, tlsRptRua: draft.tlsRptRua.trim().toLowerCase() || null,
    });
    setSaving(false);
    setError(err || null);
  };

  return (
    <SettingsBlock
      id="settings-mail-dns"
      icon={<ShieldCheck />}
      title={t('mailSettings.dns.title') || 'DNS defaults of the mail domains'}
      description={t('mailSettings.dns.description') || 'Applied to every mail domain that does not override them (DNS options of the domain).'}
      dirty={dirty} saving={saving} canSave={valid} onSave={() => { void submit(); }} onReset={() => { reset(); setError(null); }} error={error}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <ToggleSwitch checked={draft.autoconfig} onChange={(v) => set({ autoconfig: v })} label={t('mail.dnsOptions.autoconfig') || 'Autoconfiguration (Thunderbird, Outlook)'} />
        <ToggleSwitch checked={draft.srvRecords} onChange={(v) => set({ srvRecords: v })} label={t('mail.dnsOptions.srv') || 'SRV records (IMAP, SMTP, POP)'} />
        <ToggleSwitch checked={draft.dkimEd25519} onChange={(v) => set({ dkimEd25519: v })} label={t('mail.dnsOptions.dkimEd25519') || 'Ed25519 DKIM key (dual signing)'} />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label={t('mail.dnsOptions.dmarcPolicy') || 'DMARC policy'} htmlFor="mdns-dmarc" hint={t('mailSettings.dns.dmarcHint') || 'p=none until the reports show that every legitimate sender is aligned.'}>
          <select id="mdns-dmarc" value={draft.dmarcPolicy} onChange={(e) => set({ dmarcPolicy: e.target.value as MailSettings['dmarcPolicy'] })} className={selectSettingsCls}>
            <option value="none">{t('mail.dmarc.none') || 'none (monitor only)'}</option>
            <option value="quarantine">{t('mail.dmarc.quarantine') || 'quarantine (spam folder)'}</option>
            <option value="reject">{t('mail.dmarc.reject') || 'reject'}</option>
          </select>
        </Field>
        <Field label={t('mail.dnsOptions.dmarcRua') || 'DMARC reports to'} htmlFor="mdns-rua" error={ruaOk ? null : (t('mailSettings.errors.email') || 'Invalid e-mail address.')}>
          <input id="mdns-rua" type="email" value={draft.dmarcRua} onChange={(e) => set({ dmarcRua: e.target.value })} placeholder="dmarc@example.net" autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(settingsInputCls, 'font-mono')} />
        </Field>
        <Field label="MTA-STS" htmlFor="mdns-mtasts">
          <select id="mdns-mtasts" value={draft.mtaSts} onChange={(e) => set({ mtaSts: e.target.value as MailSettings['mtaSts'] })} className={selectSettingsCls}>
            <option value="off">{t('mail.mtaSts.off') || 'off'}</option>
            <option value="testing">{t('mail.mtaSts.testing') || 'testing'}</option>
            <option value="enforce">{t('mail.mtaSts.enforce') || 'enforce'}</option>
          </select>
        </Field>
        <Field label={t('mailSettings.dns.tlsRpt') || 'TLS-RPT reports to'} htmlFor="mdns-tls" hint={t('mailSettings.dns.tlsRptHint') || 'Empty: no TLS-RPT record.'} error={tlsOk ? null : (t('mailSettings.errors.email') || 'Invalid e-mail address.')}>
          <input id="mdns-tls" type="email" value={draft.tlsRptRua} onChange={(e) => set({ tlsRptRua: e.target.value })} placeholder="tls-reports@example.net" autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(settingsInputCls, 'font-mono')} />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ToggleSwitch checked={draft.rotation} onChange={(v) => set({ rotation: v })} label={t('mailSettings.dns.rotation') || 'Automatic DKIM rotation'} description={t('mailSettings.dns.rotationHint') || 'A new key is published, used once visible, the old one retired 7 days later. Off: manual rotation only.'} />
        {draft.rotation && (
          <NumberField id="mdns-rot" label={t('mailSettings.dns.rotationDays') || 'Rotate every (days)'} value={draft.dkimRotationDays} onChange={(v) => set({ dkimRotationDays: v })} min={30} max={730} />
        )}
      </div>
    </SettingsBlock>
  );
}

// ── Anti-spam, sizes, quotas, retention ─────────────────────────────────────

function MailAntispamBlock({ value, save }: { value: MailSettings; save: SaveFn }) {
  const { t } = useTranslation();
  const [draft, set, dirty, reset] = useDraft({
    spamTagScore: String(value.spamTagScore),
    spamRejectScore: String(value.spamRejectScore),
    greylisting: value.greylisting,
    clamav: value.clamav,
    maxMessageSizeMb: String(value.maxMessageSizeMb),
    defaultMailboxQuotaMb: String(value.defaultMailboxQuotaMb),
    logRetentionDays: String(value.logRetentionDays),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tag = numIn(draft.spamTagScore, 1, 50);
  const reject = numIn(draft.spamRejectScore, 2, 100);
  const size = intIn(draft.maxMessageSizeMb, 1, 100);
  const quota = intIn(draft.defaultMailboxQuotaMb, 10, 1_048_576);
  const retention = intIn(draft.logRetentionDays, 1, 366);
  const order = tag !== null && reject !== null && tag < reject;
  const valid = tag !== null && reject !== null && order && size !== null && quota !== null && retention !== null;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    const err = await save({
      spamTagScore: tag!, spamRejectScore: reject!, greylisting: draft.greylisting, clamav: draft.clamav,
      maxMessageSizeMb: size!, defaultMailboxQuotaMb: quota!, logRetentionDays: retention!,
    });
    setSaving(false);
    setError(err || null);
  };

  return (
    <SettingsBlock
      id="settings-mail-antispam"
      icon={<ShieldAlert />}
      title={t('mailSettings.antispam.title') || 'Anti-spam, sizes and retention'}
      dirty={dirty} saving={saving} canSave={valid} onSave={() => { void submit(); }} onReset={() => { reset(); setError(null); }} error={error}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ToggleSwitch checked={draft.greylisting} onChange={(v) => set({ greylisting: v })} label={t('mailSettings.antispam.greylisting') || 'Greylisting'} description={t('mailSettings.antispam.greylistingHint') || 'Unknown senders are asked to retry a few minutes later (delays the first message).'} />
        <ToggleSwitch checked={draft.clamav} onChange={(v) => set({ clamav: v })} label={t('mailSettings.antispam.clamav') || 'Antivirus (ClamAV)'} description={t('mailSettings.antispam.clamavHint') || 'Incoming messages scanned by the shared scanner (Postfix + Dovecot only; needs the scanner deployed).'} />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <NumberField id="mas-tag" decimals label={t('mailSettings.antispam.tagScore') || 'Spam score: tag from'} value={draft.spamTagScore} onChange={(v) => set({ spamTagScore: v })} min={1} max={50} hint={t('mailSettings.antispam.tagHint') || 'X-Spam header, Junk folder.'} />
        <NumberField id="mas-reject" decimals label={t('mailSettings.antispam.rejectScore') || 'Spam score: refuse from'} value={draft.spamRejectScore} onChange={(v) => set({ spamRejectScore: v })} min={2} max={100} hint={t('mailSettings.antispam.rejectHint') || 'Refused during the SMTP dialogue.'} />
        <NumberField id="mas-size" label={t('mailSettings.antispam.maxSize') || 'Largest message (MB)'} value={draft.maxMessageSizeMb} onChange={(v) => set({ maxMessageSizeMb: v })} min={1} max={100} hint={t('mailSettings.antispam.maxSizeHint') || 'Platform ceiling (plans and domains stay below).'} />
        <NumberField id="mas-quota" label={t('mailSettings.antispam.defaultQuota') || 'Default mailbox quota (MB)'} value={draft.defaultMailboxQuotaMb} onChange={(v) => set({ defaultMailboxQuotaMb: v })} min={10} max={1_048_576} hint={t('mailSettings.antispam.defaultQuotaHint') || 'When none is given, capped by the plan.'} />
        <NumberField id="mas-retention" label={t('mailSettings.antispam.retention') || 'Mail logs kept (days)'} value={draft.logRetentionDays} onChange={(v) => set({ logRetentionDays: v })} min={1} max={366} />
      </div>
      {tag !== null && reject !== null && !order && (
        <p className="text-xs text-status-down">{t('mailSettings.antispam.order') || 'The tag score must be lower than the refuse score.'}</p>
      )}
    </SettingsBlock>
  );
}

// ── Relay, abuse protection, bans thresholds ────────────────────────────────

function MailAbuseBlock({ value, save }: { value: MailSettings; save: SaveFn }) {
  const { t } = useTranslation();
  const [draft, set, dirty, reset] = useDraft({
    siteRelay: value.siteRelay,
    abuseBounceRatePct: String(value.abuseBounceRatePct),
    abuseMinMessages: String(value.abuseMinMessages),
    abuseAction: value.abuseAction,
    authBanThreshold: String(value.authBanThreshold),
    authBanWindowMinutes: String(value.authBanWindowMinutes),
    authBanDurationMinutes: String(value.authBanDurationMinutes),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rate = intIn(draft.abuseBounceRatePct, 1, 100);
  const minMsg = intIn(draft.abuseMinMessages, 5, 100_000);
  const threshold = intIn(draft.authBanThreshold, 3, 1000);
  const windowMin = intIn(draft.authBanWindowMinutes, 1, 1440);
  const duration = intIn(draft.authBanDurationMinutes, 1, 43_200);
  const valid = rate !== null && minMsg !== null && threshold !== null && windowMin !== null && duration !== null;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    const err = await save({
      siteRelay: draft.siteRelay, abuseBounceRatePct: rate!, abuseMinMessages: minMsg!, abuseAction: draft.abuseAction,
      authBanThreshold: threshold!, authBanWindowMinutes: windowMin!, authBanDurationMinutes: duration!,
    });
    setSaving(false);
    setError(err || null);
  };

  return (
    <SettingsBlock
      id="settings-mail-abuse"
      icon={<ShieldBan />}
      title={t('mailSettings.abuse.title') || 'Site relay, abuse and bans'}
      dirty={dirty} saving={saving} canSave={valid} onSave={() => { void submit(); }} onReset={() => { reset(); setError(null); }} error={error}
    >
      <ToggleSwitch
        checked={draft.siteRelay}
        onChange={(v) => set({ siteRelay: v })}
        label={t('mailSettings.abuse.siteRelay') || 'Sites send through the relay (PHP mail())'}
        description={t('mailSettings.abuse.siteRelayHint') || 'msmtp in every site → authenticated relay, sender forced on an address of the account, limit per site. Off: mail() of the sites returns false.'}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <NumberField id="mab-rate" label={t('mailSettings.abuse.rate') || 'Bounce + spam rate (%)'} value={draft.abuseBounceRatePct} onChange={(v) => set({ abuseBounceRatePct: v })} min={1} max={100} />
        <NumberField id="mab-min" label={t('mailSettings.abuse.minMessages') || 'From (messages / hour)'} value={draft.abuseMinMessages} onChange={(v) => set({ abuseMinMessages: v })} min={5} max={100_000} />
        <Field label={t('mailSettings.abuse.action') || 'Then'} htmlFor="mab-action">
          <select id="mab-action" value={draft.abuseAction} onChange={(e) => set({ abuseAction: e.target.value as MailSettings['abuseAction'] })} className={selectSettingsCls}>
            <option value="suspend">{t('mailSettings.abuse.suspend') || 'Suspend sending + notify'}</option>
            <option value="notify">{t('mailSettings.abuse.notify') || 'Notify only'}</option>
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <NumberField id="mab-thr" label={t('mailSettings.abuse.banThreshold') || 'Ban after (failed logins)'} value={draft.authBanThreshold} onChange={(v) => set({ authBanThreshold: v })} min={3} max={1000} />
        <NumberField id="mab-win" label={t('mailSettings.abuse.banWindow') || 'Within (minutes)'} value={draft.authBanWindowMinutes} onChange={(v) => set({ authBanWindowMinutes: v })} min={1} max={1440} />
        <NumberField id="mab-dur" label={t('mailSettings.abuse.banDuration') || 'Ban duration (minutes)'} value={draft.authBanDurationMinutes} onChange={(v) => set({ authBanDurationMinutes: v })} min={1} max={43_200} />
      </div>
      <p className="text-xs text-text-muted">
        {t('mailSettings.abuse.banHint') || 'Bans apply to the mail ports only (hostd nftables, before Docker); IPv6 per /64; internal addresses are never banned.'}{' '}
        <Link to="/security/bans?tab=mail" className="text-accent hover:underline">{t('mailSettings.abuse.bansLink') || 'See the mail bans'}</Link>
      </p>
    </SettingsBlock>
  );
}

// ── Bans ────────────────────────────────────────────────────────────────────

/**
 * Bans of the mail ports (platform admin): shown in the « Mail » tab of the
 * Bans page (coherence plan D13); the thresholds stay in Settings → Mail.
 */
export function MailBansPanel() {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [bans, setBans] = useState<MailBan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setBans(await systemMailApi.bans());
      setError(null);
    } catch (err) {
      setBans(null);
      setError(mailLoadError(t, err, t('mailSettings.bans.loadFailed') || 'Failed to load the bans'));
    }
  }, [t]);
  useEffect(() => { void load(); }, [load]);

  const unban = async (b: MailBan) => {
    if (!(await confirm({
      title: t('mailSettings.bans.unbanTitle') || 'Lift the ban',
      message: t('mailSettings.bans.unbanConfirm', { ip: b.ip, defaultValue: 'Lift the ban of {{ip}} on the mail ports now?' }),
      confirmLabel: t('mailSettings.bans.unban') || 'Lift',
    }))) return;
    setBusy(b.id);
    try {
      await systemMailApi.unban(b.id);
      setBans((cur) => (cur ? cur.filter((x) => x.id !== b.id) : cur));
      toast.success(t('mailSettings.bans.unbanned') || 'Ban lifted');
    } catch (err) {
      toastMailError(t, err, t('mailSettings.bans.unbanFailed') || 'Failed to lift the ban');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-muted">{t('mailSettings.bans.description') || 'Addresses banned from the mail ports (SMTP, submission, IMAP, POP3) after repeated authentication failures.'}</p>
      {error ? (
        <EmptyState icon={<AlertTriangle />} text={error} />
      ) : bans === null ? (
        <div className="flex justify-center py-8"><LoadingSpinner /></div>
      ) : bans.length === 0 ? (
        <EmptyState icon={<ShieldBan />} text={t('mailSettings.bans.empty') || 'No address is banned.'} />
      ) : (
        <TableScroll className="rounded-xl bg-bg-secondary">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className={theadRowCls}>
                <th className={thCls}>{t('mailSettings.bans.ip') || 'Address'}</th>
                <th className={thCls}>{t('mailSettings.bans.service') || 'Service'}</th>
                <th className={`${thCls} text-right`}>{t('mailSettings.bans.failures') || 'Failures'}</th>
                <th className={thCls}>{t('mailSettings.bans.expires') || 'Until'}</th>
                <th className={`${thCls} w-14`}><span className="sr-only">{t('mail.actions') || 'Actions'}</span></th>
              </tr>
            </thead>
            <tbody>
              {bans.map((b) => (
                <tr key={b.id} className="transition-colors hover:bg-bg-hover">
                  <td className="px-4 py-2.5 font-mono text-xs text-text-primary">
                    {b.ip}
                    {b.reason && <div className="text-[11px] text-text-muted">{b.reason}</div>}
                  </td>
                  <td className="px-4 py-2.5"><Pill>{b.service}</Pill></td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums">{b.failures}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-text-secondary">{new Date(b.expiresAt).toLocaleString(i18n.language)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <IconButton label={t('mailSettings.bans.unban') || 'Lift'} icon={<Unlock size={13} />} disabled={busy !== null} onClick={() => { void unban(b); }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </div>
  );
}

// ── Open relay self-test ────────────────────────────────────────────────────

const CHECK_FALLBACK: Record<string, string> = {
  unauthRelay: 'Port 25 refuses to relay to an external domain',
  submissionNoAuth: 'Port 587 refuses to relay without authentication',
  submissionNoTls: 'Port 587 offers no AUTH before STARTTLS',
  relayPort: 'Internal ports (10025, 2525) unreachable from outside',
  senderMismatch: 'A mailbox cannot send as another address',
};

function RelayTestBlock() {
  const { t, i18n } = useTranslation();
  const [result, setResult] = useState<OpenRelayTestResult | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await systemMailApi.relayTest());
    } catch (err) {
      toastMailError(t, err, t('mailSettings.relayTest.failed') || 'The test could not run');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsBlock
      id="settings-mail-relaytest"
      icon={<ShieldCheck />}
      title={t('mailSettings.relayTest.title') || 'Open relay test'}
      description={t('mailSettings.relayTest.description') || 'Connects to the public address of the server like an outsider and checks that no message can be relayed (the dialogue stops before DATA: nothing is sent).'}
    >
      <Button size="sm" variant="secondary" loading={busy} onClick={() => { void run(); }}>{t('mailSettings.relayTest.run') || 'Run the test'}</Button>
      {result && (
        <div className={cn('rounded-lg border p-3 text-sm', result.ok ? 'border-status-up/30 bg-status-up/5 text-status-up' : 'border-red-400/30 bg-red-500/10 text-red-400')}>
          <div className="flex flex-wrap items-center gap-2">
            {result.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
            {result.ok ? (t('mailSettings.relayTest.ok') || 'No open relay found.') : (t('mailSettings.relayTest.ko') || 'OPEN RELAY: the server accepts to relay messages it should refuse.')}
            <span className="ml-auto font-mono text-[11px] text-text-muted">{result.target} · {new Date(result.testedAt).toLocaleString(i18n.language)}</span>
          </div>
          <ul className="mt-2 space-y-1">
            {result.checks.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-xs">
                {c.passed ? <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-status-up" /> : <XCircle size={13} className="mt-0.5 shrink-0 text-red-400" />}
                <span className="min-w-0">
                  <span className="text-text-primary">{t(`mailSettings.relayTest.checks.${c.id}`, { defaultValue: CHECK_FALLBACK[c.id] ?? c.id })}</span>
                  {c.detail && <span className="block break-words font-mono text-[11px] text-text-muted">{c.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SettingsBlock>
  );
}
