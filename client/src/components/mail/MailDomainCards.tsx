import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Fingerprint, Info, Globe, KeyRound, ListChecks, Plus, RefreshCw, RotateCw, Server, Settings2, Trash2, Wrench } from 'lucide-react';
import {
  HostingSocketEvents,
  type DkimAlgorithm, type DkimKey, type DkimKeyStatus, type DmarcPolicy, type MailDnsDelegation, type MailDnsRecord, type MailDnsStatus, type MailDomainDetail, type MailDomainDnsSettings,
  type MailExternalConfig, type MailPtrCheck, type MailUpdatedPayload, type MtaStsMode,
} from '@oblimint/shared';
import { mailApi } from '@/api/mail.api';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { ChipsInput } from '@/components/settings/ChipsInput';
import { Card, CopyButton, InfoRow, Pill, inputCls, labelCls, selectCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { DnsCheckPill } from './MailBadges';
import { MailDnsFixModal } from './MailDnsFixModal';
import { mailErrorMessage, mailLoadError, toastMailError } from './mailErrors';
import { EXTERNAL_DKIM_SELECTOR_RE, intIn, isValidAddress, isValidHostname, normalizeAddress } from './mailFormat';

// Cards of /mail/domains/:id. OWNED BY MODULE `ui-mail`.

// ── Settings: enabled, catch-all, message size ─────────────────────────────

export function MailDomainSettingsCard({ domain, manage, onChanged }: { domain: MailDomainDetail; manage: boolean; onChanged: (d: MailDomainDetail) => void }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(domain.enabled);
  const [catchAll, setCatchAll] = useState(domain.catchAll ?? '');
  const [size, setSize] = useState(domain.maxMessageSizeMb == null ? '' : String(domain.maxMessageSizeMb));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const key = `${domain.enabled}|${domain.catchAll}|${domain.maxMessageSizeMb}`;
  useEffect(() => {
    setEnabled(domain.enabled);
    setCatchAll(domain.catchAll ?? '');
    setSize(domain.maxMessageSizeMb == null ? '' : String(domain.maxMessageSizeMb));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const planMax = domain.limits.maxMessageSizeMb;
  const catchAllOk = !catchAll.trim() || isValidAddress(catchAll);
  const sizeVal = size.trim() ? intIn(size, 1, 100) : null;
  const sizeOk = !size.trim() || sizeVal !== null;
  const dirty = enabled !== domain.enabled || (catchAll.trim() ? normalizeAddress(catchAll) : null) !== domain.catchAll || sizeVal !== domain.maxMessageSizeMb;

  const save = async () => {
    if (!catchAllOk || !sizeOk) return;
    setSaving(true);
    setError('');
    try {
      onChanged(await mailApi.updateDomain(domain.id, { enabled, catchAll: catchAll.trim() ? normalizeAddress(catchAll) : null, maxMessageSizeMb: sizeVal }));
      toast.success(t('mail.domain.saved') || 'Mail domain saved');
    } catch (err) {
      setError(mailErrorMessage(t, err, t('mail.domain.saveFailed') || 'Failed to save the mail domain'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={t('mail.domain.settings') || 'Settings'} icon={<Settings2 size={14} className="text-accent" />}>
      <div className="space-y-4">
        <ToggleSwitch
          checked={enabled}
          disabled={!manage}
          onChange={setEnabled}
          label={t('mail.domains.enabled') || 'Mail enabled'}
          description={t('mail.domains.enabledHint') || 'Off: messages to this domain are refused and its mailboxes cannot sign in.'}
        />
        <div>
          <label className={labelCls} htmlFor="mdd-catchall">{t('mail.domains.catchAll') || 'Catch-all (optional)'}</label>
          <input id="mdd-catchall" type="email" value={catchAll} disabled={!manage} onChange={(e) => setCatchAll(e.target.value)} placeholder="contact@example.com" autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(inputCls, 'font-mono', !catchAllOk && 'ring-2 ring-status-down/50')} />
          <p className="mt-1 text-xs text-text-muted">{t('mail.domains.catchAllHint') || 'Receives the messages sent to unknown addresses of the domain. Empty: they are refused.'}</p>
        </div>
        <div>
          <label className={labelCls} htmlFor="mdd-size">{t('mail.domain.maxSize') || 'Largest message'} <span className="font-mono text-[10px]">({t('units.mb') || 'MB'})</span></label>
          <input id="mdd-size" type="number" min={1} max={100} inputMode="numeric" value={size} disabled={!manage} onChange={(e) => setSize(e.target.value)} placeholder={t('mail.domain.maxSizePlan', { size: planMax, defaultValue: 'plan: {{size}}' })} className={cn(inputCls, 'font-mono', !sizeOk && 'ring-2 ring-status-down/50')} />
          <p className="mt-1 text-xs text-text-muted">{t('mail.domain.maxSizeHint', { size: planMax, defaultValue: 'Empty: the plan value ({{size}} MB). Never above the plan and platform ceilings.' })}</p>
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
        {manage && dirty && (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" disabled={saving} onClick={() => { setEnabled(domain.enabled); setCatchAll(domain.catchAll ?? ''); setSize(domain.maxMessageSizeMb == null ? '' : String(domain.maxMessageSizeMb)); setError(''); }}>{t('common.cancel') || 'Cancel'}</Button>
            <Button size="sm" loading={saving} disabled={!catchAllOk || !sizeOk} onClick={() => { void save(); }}>{t('common.save') || 'Save'}</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

// ── DNS records (expected + last check) ─────────────────────────────────────

function recordLine(r: MailDnsRecord): string {
  return r.priority != null ? `${r.priority} ${r.content}` : r.content;
}

const KIND_LABEL: Record<string, string> = {
  mx: 'MX', spf: 'SPF', dkim: 'DKIM', dmarc: 'DMARC', ptr: 'PTR', 'mta-sts': 'MTA-STS', 'tls-rpt': 'TLS-RPT',
  autoconfig: 'Autoconfig', autodiscover: 'Autodiscover', srv: 'SRV', 'mail-host': 'Mail host',
};

/** MX / SPF / DKIM / DMARC row the Fix can repair (zone hosted here, stored records hide the expected one). */
function rowFixable(r: MailDnsRecord): boolean {
  return !!r.fixable && r.status !== 'ok';
}

const hostsOf = (list: string[]) => list.join(', ');

/** The delegation of the status (unknown, unchecked when an older server sent none). */
const delegationOf = (s: MailDnsStatus): MailDnsDelegation =>
  s.delegation ?? { zone: s.domain, found: [], expected: [], status: 'unknown', checked: false };

/** Who serves the zone (public NS): green = our name servers, amber = another DNS host, red = mixed (an error). */
function DelegationPill({ d }: { d: MailDnsDelegation }) {
  const { t } = useTranslation();
  if (d.status === 'ours') return <Pill tone="green">{t('mail.dns.delegation.ours') || 'on Mint'}</Pill>;
  if (d.status === 'elsewhere') return <Pill tone="amber" title={hostsOf(d.found)}>{t('mail.dns.delegation.elsewhere') || 'elsewhere'}</Pill>;
  if (d.status === 'mixed') return <Pill tone="red" title={hostsOf(d.found)}>{t('mail.dns.delegation.mixed') || 'mixed'}</Pill>;
  return <Pill tone="muted">{d.checked ? (t('mail.dns.delegation.unknown') || 'unknown') : (t('mail.dns.status.unchecked') || 'not checked')}</Pill>;
}

/** First row of the card: the name servers of the zone apex, expected vs found. */
function DelegationRow({ d }: { d: MailDnsDelegation }) {
  const { t } = useTranslation();
  return (
    <li className="rounded-lg bg-bg-primary p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] font-semibold text-accent">NS</span>
        <span className="text-[11px] text-text-muted">{t('mail.dns.delegation.title') || 'Name servers (NS)'}</span>
        <span className="ml-auto"><DelegationPill d={d} /></span>
      </div>
      <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <InfoRow label={t('mail.dns.delegation.zone') || 'Zone'} mono>{d.zone}</InfoRow>
        <InfoRow label={t('mail.dns.delegation.expected') || 'Expected (ours)'} mono>{d.expected.length ? hostsOf(d.expected) : (t('mail.dns.delegation.noneConfigured') || 'none configured')}</InfoRow>
        <InfoRow label={t('mail.dns.delegation.found') || 'Found (public)'} mono>{d.found.length ? hostsOf(d.found) : '—'}</InfoRow>
      </div>
    </li>
  );
}

const NOTE_TONES = {
  info: 'border-sky-400/30 bg-sky-400/5 text-sky-300',
  warning: 'border-amber-400/30 bg-amber-400/5 text-amber-400',
  error: 'border-red-400/30 bg-red-500/5 text-red-400',
} as const;

function DnsNote({ tone, title, children }: { tone: keyof typeof NOTE_TONES; title?: string; children: ReactNode }) {
  const Icon = tone === 'info' ? Info : AlertTriangle;
  return (
    <div className={cn('rounded-md border p-3 text-xs', NOTE_TONES[tone])}>
      <div className="flex items-start gap-2">
        <Icon size={13} className="mt-0.5 shrink-0" />
        <div>
          {title && <div className="font-medium">{title}</div>}
          <div className={cn(title && 'mt-0.5 text-text-secondary')}>{children}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * Explanation of the card, from the real situation: zone hosted here or not × public
 * delegation (ours / elsewhere / mixed / unknown). `zonesHref`: where a zone can be hosted here.
 */
function DnsSituationHint({ status, fixEnabled, zonesHref }: { status: MailDnsStatus; fixEnabled: boolean; zonesHref: string | null }) {
  const { t } = useTranslation();
  const d = delegationOf(status);
  const hosted = status.zoneHosted || status.managed;
  const found = hostsOf(d.found);
  const ours = d.expected.length ? hostsOf(d.expected) : (t('mail.dns.delegation.ourNameservers') || 'our name servers');
  const shadowed = status.shadowed ? (
    <DnsNote tone="warning">
      {fixEnabled
        ? (t('mail.dns.shadowedHint') || 'The zone of this domain is hosted on our name servers, but records stored in it override the automatic ones (marked below): use « Fix » to serve the expected records.')
        : (t('mail.dns.shadowedHintReadOnly') || 'The zone of this domain is hosted on our name servers, but records stored in it override the automatic ones (marked below): someone allowed to edit the DNS zone can fix them.')}
    </DnsNote>
  ) : null;
  let main: ReactNode = null;
  if (d.status === 'mixed') {
    main = (
      <DnsNote tone="error" title={t('mail.dns.delegation.mixedTitle') || 'Mixed name servers'}>
        {t('mail.dns.delegation.mixedHint', { found, ours, defaultValue: 'The domain points both to our name servers and to others ({{found}}): resolvers answer at random from one or the other. Set the name servers of the domain at the registrar to {{ours}} only, or to the other DNS host only.' })}
      </DnsNote>
    );
  } else if (hosted && d.status === 'elsewhere') {
    main = (
      <DnsNote tone="warning" title={t('mail.dns.delegation.notServedTitle') || 'This zone is not served'}>
        {t('mail.dns.delegation.hostedElsewhereHint', { found, ours, defaultValue: 'A zone exists on Mint but the domain points to other name servers ({{found}}): what Mint writes is NOT served. Either switch the name servers to {{ours}} at the registrar, or copy the records below at the current DNS host.' })}
      </DnsNote>
    );
  } else if (hosted) {
    // ours, or delegation unknown: the zone written here is (presumably) the one served.
    if (!shadowed) {
      main = (
        <p className="text-xs text-text-muted">{d.status === 'ours'
          ? (t('mail.dns.delegation.servedHint') || 'The zone is served by Mint: these records are written automatically.')
          : (t('mail.dns.managedHint') || 'The zone of this domain is hosted on our name servers: these records are written automatically.')}</p>
      );
    }
  } else if (d.status === 'elsewhere') {
    main = (
      <DnsNote tone="info" title={t('mail.dns.externalTitle') || 'To create at your DNS provider'}>
        {t('mail.dns.delegation.externalHint', { found, defaultValue: 'The zone is managed at {{found}}: copy the records below there (copy button on each line), then click « Check now ».' })}
      </DnsNote>
    );
  } else if (d.status === 'ours') {
    const href = status.zoneId ? `/dns/zones/${status.zoneId}` : zonesHref;
    main = (
      <DnsNote tone="warning" title={t('mail.dns.delegation.noZoneTitle') || 'No zone on Mint'}>
        {t('mail.dns.delegation.noZoneHint', { defaultValue: 'The domain points to the name servers of Mint, but its zone is not hosted here: nothing is served for it (no web, no mail). Host its DNS zone here, or point the domain back to its former DNS host at the registrar.' })}
        {href && (
          <>{' '}<Link to={href} className="font-medium underline">{t('mail.dns.delegation.noZoneLink') || 'DNS zones'}</Link></>
        )}
      </DnsNote>
    );
  } else {
    main = (
      <DnsNote tone="warning" title={t('mail.dns.externalTitle') || 'To create at your DNS provider'}>
        {t('mail.dns.externalHint') || 'The DNS zone of this domain is not hosted here: create the records below at your registrar or DNS provider (copy button on each line), then click « Check now ».'}
      </DnsNote>
    );
  }
  return <>{main}{shadowed}</>;
}

/**
 * `canFix`: the user may write the zone (mail.manage + dns.manage on the account).
 * `onFixed`: status returned by a successful fix.
 * `zonesHref`: the DNS zones of the account (link of the « points to us, no zone here » hint).
 * `fixPrompt`: bumped when mail was just enabled on the domain — the Fix opens by itself
 * (prompt mode) when the zone overrides the mail records.
 */
export function MailDnsRecordsCard({ status, error, checking, onCheck, canFix = false, onFixed, zonesHref = null, fixPrompt = 0 }: {
  status: MailDnsStatus | null;
  error: string | null;
  checking: boolean;
  onCheck: () => void;
  canFix?: boolean;
  onFixed?: (s: MailDnsStatus) => void;
  zonesHref?: string | null;
  fixPrompt?: number;
}) {
  const { t, i18n } = useTranslation();
  const message = (r: MailDnsRecord) => (r.code ? t(`mail.dns.messages.${r.code}`, { defaultValue: r.message ?? r.code }) : r.message);
  // null = closed; '' = every fixable record; else the item id ('<kind>:<FQDN>') of one row.
  const [fixFocus, setFixFocus] = useState<string | null>(null);
  const fixEnabled = canFix && !!status?.zoneHosted;
  const fixableCount = fixEnabled ? (status?.records ?? []).filter(rowFixable).length : 0;
  const [prompting, setPrompting] = useState(false);
  const promptHandled = useRef(0);
  useEffect(() => {
    if (!fixPrompt || fixPrompt === promptHandled.current || !status) return;
    promptHandled.current = fixPrompt;
    if (status.shadowed && fixableCount > 0) { setPrompting(true); setFixFocus(''); }
  }, [fixPrompt, status, fixableCount]);
  return (
    <Card
      title={t('mail.dns.title') || 'DNS records'}
      icon={<Globe size={14} className="text-accent" />}
      actions={
        <div className="flex items-center gap-2">
          {fixableCount > 0 && (
            <Button size="sm" onClick={() => { setPrompting(false); setFixFocus(''); }}>
              <Wrench size={13} className="mr-1.5" />{t('mail.dns.fix.fixAll') || 'Fix all'}
            </Button>
          )}
          <Button size="sm" variant="secondary" loading={checking} disabled={!status} onClick={onCheck}>
            <RefreshCw size={13} className="mr-1.5" />{t('mail.dns.checkNow') || 'Check now'}
          </Button>
        </div>
      }
    >
      {error ? (
        <p className="flex items-start gap-2 text-sm text-text-muted"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</p>
      ) : !status ? (
        <div className="flex justify-center py-4"><LoadingSpinner /></div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
            {status.healthy ? <Pill tone="green">{t('mail.dns.healthy') || 'everything is right'}</Pill> : <Pill tone="red">{t('mail.dns.unhealthy') || 'to fix'}</Pill>}
            <span>{status.checkedAt ? t('mail.dns.checkedAt', { date: new Date(status.checkedAt).toLocaleString(i18n.language), defaultValue: 'last check {{date}}' }) : (t('mail.dns.neverChecked') || 'never checked')}</span>
          </div>
          <DnsSituationHint status={status} fixEnabled={fixEnabled} zonesHref={zonesHref} />
          <ul className="space-y-2">
            <DelegationRow d={delegationOf(status)} />
            {status.records.map((r, i) => {
                const msg = message(r);
                return (
                  <li key={`${r.kind}-${r.name}-${r.type}-${i}`} className="rounded-lg bg-bg-primary p-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[11px] font-semibold text-accent">{r.type}</span>
                      <span className="text-[11px] text-text-muted">{t(`mail.dns.kinds.${r.kind}`, { defaultValue: KIND_LABEL[r.kind] ?? r.kind })}</span>
                      {!r.required && <Pill>{t('mail.dns.optional') || 'optional'}</Pill>}
                      {r.fixable && <Pill tone="amber">{t('mail.dns.overridden') || 'overridden in the zone'}</Pill>}
                      <span className="ml-auto flex items-center gap-2">
                        <DnsCheckPill status={r.status} />
                        {fixEnabled && rowFixable(r) && (
                          <Button size="sm" variant="secondary" onClick={() => { setPrompting(false); setFixFocus(`${r.kind}:${r.name}`); }}>
                            <Wrench size={12} className="mr-1" />{t('mail.dns.fix.fix') || 'Fix'}
                          </Button>
                        )}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-start gap-1">
                      <div className="min-w-0 flex-1">
                        <div className="break-all font-mono text-sm text-text-primary">{r.name}</div>
                        <div className="mt-0.5 break-all font-mono text-xs text-text-secondary">{recordLine(r)}</div>
                      </div>
                      <CopyButton text={r.name} label={t('mail.dns.copyName') || 'Copy the name'} />
                      <CopyButton text={recordLine(r)} label={t('mail.dns.copyValue') || 'Copy the value'} />
                    </div>
                    {r.status !== 'ok' && r.found.length > 0 && (
                      <div className="mt-1.5 break-all text-[11px] text-text-muted">
                        {t('mail.dns.found') || 'Found:'} <span className="font-mono">{r.found.join(' | ')}</span>
                      </div>
                    )}
                    {msg && r.status !== 'ok' && <p className="mt-1 text-[11px] text-amber-400">{msg}</p>}
                  </li>
                );
              })}
          </ul>
          {status.records.length === 0 && (
            <p className="py-4 text-center text-xs text-text-muted">{t('mail.dns.noRecord') || 'No record expected (mail disabled or domain pending).'}</p>
          )}
        </div>
      )}
      {status && fixEnabled && (
        <MailDnsFixModal
          open={fixFocus !== null}
          mailDomainId={status.mailDomainId}
          focus={fixFocus || null}
          ptr={status.ptr}
          prompt={prompting}
          onClose={() => { setFixFocus(null); setPrompting(false); }}
          onApplied={(s) => onFixed?.(s)}
        />
      )}
    </Card>
  );
}

// ── PTR reminder ────────────────────────────────────────────────────────────

export function MailPtrCard({ ptr }: { ptr: MailDnsStatus['ptr'] | null }) {
  const { t } = useTranslation();
  const row = (label: string, p: MailPtrCheck | null) => (
    <div className="rounded-lg bg-bg-primary p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-text-secondary">{label}</span>
        {p ? <span className="ml-auto"><DnsCheckPill status={p.status} /></span> : <span className="ml-auto text-[11px] text-text-muted">{t('mail.ptr.noAddress') || 'no address'}</span>}
      </div>
      {p && (
        <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <InfoRow label={t('mail.ptr.ip') || 'Address'} mono>{p.ip}</InfoRow>
          <InfoRow label={t('mail.ptr.expected') || 'Expected'} mono>{p.expected}</InfoRow>
          <InfoRow label={t('mail.ptr.found') || 'Found'} mono>{p.found.length ? p.found.join(', ') : '—'}</InfoRow>
        </div>
      )}
    </div>
  );
  return (
    <Card title={t('mail.ptr.title') || 'Reverse DNS (PTR)'} icon={<Server size={14} className="text-accent" />}>
      <p className="mb-3 text-xs text-text-muted">{t('mail.ptr.hint') || 'Receiving servers check that the address of our mail server points back to its name. This record is set at the hosting provider of the server (not in your zone): the panel can only remind it.'}</p>
      {ptr ? (
        <div className="space-y-2">
          {row('IPv4', ptr.ipv4)}
          {row('IPv6', ptr.ipv6)}
        </div>
      ) : (
        <p className="text-xs text-text-muted">—</p>
      )}
    </Card>
  );
}

// ── DKIM keys ───────────────────────────────────────────────────────────────

/**
 * `ed25519Setting`: the domain's own dkimEd25519 setting (null = platform
 * default, which is not exposed to clients). `refreshKey`: bumped by the page
 * after a DNS options save so the key list is reloaded.
 */
export function MailDkimCard({ mailDomainId, manage, ed25519Setting, refreshKey = 0 }: {
  mailDomainId: number;
  manage: boolean;
  ed25519Setting: boolean | null;
  refreshKey?: number;
}) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [keys, setKeys] = useState<DkimKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [algorithm, setAlgorithm] = useState<DkimAlgorithm>('rsa-2048');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setKeys(await mailApi.dkimKeys(mailDomainId));
      setError(null);
    } catch (err) {
      setKeys(null);
      setError(mailLoadError(t, err, t('mail.dkim.loadFailed') || 'Failed to load the DKIM keys'));
    }
  }, [mailDomainId, t]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  // Keys created / promoted / retired by the server (DNS options save, rotation worker).
  useHostingEvents([HostingSocketEvents.MAIL_UPDATED], () => { void load(); }, (_e, p) => {
    const payload = p as MailUpdatedPayload | null;
    return !!payload && payload.entity === 'dkim' && payload.id === mailDomainId;
  });

  // Effective ed25519 setting (server: domain setting ?? platform setting). With
  // the platform default, a live ed25519 key exists exactly when it is on
  // (the server creates / retires that key when the effective setting changes).
  const ed25519On = ed25519Setting ?? (keys ?? []).some((k) => k.algorithm === 'ed25519' && k.status !== 'retired');
  useEffect(() => { if (!ed25519On && algorithm === 'ed25519') setAlgorithm('rsa-2048'); }, [ed25519On, algorithm]);

  const rotate = async () => {
    if (!(await confirm({
      title: t('mail.dkim.rotateTitle') || 'Rotate the DKIM key',
      message: t('mail.dkim.rotateConfirm') || 'A new key is created and published; it signs the outgoing mail once its DNS record is visible, then the old key is retired after 7 days. If the zone is hosted elsewhere, publish the new record at your provider.',
      confirmLabel: t('mail.dkim.rotate') || 'Rotate',
    }))) return;
    setBusy(true);
    try {
      setKeys(await mailApi.rotateDkim(mailDomainId, ed25519On ? algorithm : 'rsa-2048'));
      toast.success(t('mail.dkim.rotated') || 'New DKIM key created');
    } catch (err) {
      toastMailError(t, err, t('mail.dkim.rotateFailed') || 'Failed to rotate the DKIM key');
    } finally {
      setBusy(false);
    }
  };

  const tone = (s: DkimKeyStatus) => ({ active: 'green', next: 'blue', retiring: 'amber', retired: 'muted' } as const)[s];
  const visible = (keys ?? []).filter((k) => k.status !== 'retired');
  const retired = (keys ?? []).length - visible.length;

  return (
    <Card
      title={t('mail.dkim.title') || 'DKIM keys'}
      icon={<Fingerprint size={14} className="text-accent" />}
      actions={manage && keys ? (
        <div className="flex items-center gap-2">
          <select aria-label={t('mail.dkim.algorithm') || 'Algorithm'} value={algorithm} onChange={(e) => setAlgorithm(e.target.value as DkimAlgorithm)} className={cn(selectCls, 'w-auto py-1 text-xs')}>
            <option value="rsa-2048">RSA 2048</option>
            <option value="ed25519" disabled={!ed25519On}>{ed25519On ? 'Ed25519' : (t('mail.dkim.ed25519Off') || 'Ed25519 (turn it on in the DNS options)')}</option>
          </select>
          <Button size="sm" variant="secondary" loading={busy} onClick={() => { void rotate(); }}><RotateCw size={13} className="mr-1.5" />{t('mail.dkim.rotate') || 'Rotate'}</Button>
        </div>
      ) : undefined}
    >
      {error ? (
        <p className="flex items-start gap-2 text-sm text-text-muted"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</p>
      ) : !keys ? (
        <div className="flex justify-center py-4"><LoadingSpinner /></div>
      ) : visible.length === 0 ? (
        <p className="py-4 text-center text-xs text-text-muted">{t('mail.dkim.empty') || 'No DKIM key yet: it is created with the mail domain.'}</p>
      ) : (
        <ul className="space-y-2">
          {visible.map((k) => (
            <li key={k.id} className="rounded-lg bg-bg-primary p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <KeyRound size={13} className="text-text-muted" />
                <span className="font-mono text-sm text-text-primary">{k.selector}</span>
                <Pill tone={tone(k.status)}>{t(`mail.dkim.status.${k.status}`) || k.status}</Pill>
                <span className="font-mono text-[11px] text-text-muted">{k.algorithm === 'ed25519' ? 'Ed25519' : 'RSA 2048'}</span>
                <span className="ml-auto"><CopyButton text={k.publicRecord} label={t('mail.dns.copyValue') || 'Copy the value'} /></span>
              </div>
              <div className="mt-1 line-clamp-2 break-all font-mono text-[11px] text-text-muted" title={k.publicRecord}>{k.publicRecord}</div>
              <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-text-muted">
                <span>{t('mail.dkim.created', { date: new Date(k.createdAt).toLocaleDateString(i18n.language), defaultValue: 'created {{date}}' })}</span>
                {k.activatedAt && <span>{t('mail.dkim.activated', { date: new Date(k.activatedAt).toLocaleDateString(i18n.language), defaultValue: 'active since {{date}}' })}</span>}
                {k.retireAfter && <span>{t('mail.dkim.retireAfter', { date: new Date(k.retireAfter).toLocaleDateString(i18n.language), defaultValue: 'removed after {{date}}' })}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {retired > 0 && <p className="mt-2 text-[11px] text-text-muted">{t('mail.dkim.retiredCount', { count: retired, defaultValue: '{{count}} retired key(s) hidden.' })}</p>}
    </Card>
  );
}

// ── DNS options (DMARC, SPF, MTA-STS, TLS-RPT, autoconfig, SRV, ed25519) ────

type Tri = 'default' | 'on' | 'off';
const triOf = (v: boolean | null): Tri => (v === null ? 'default' : v ? 'on' : 'off');
const triVal = (v: Tri): boolean | null => (v === 'default' ? null : v === 'on');

/** Host name inside an SPF mechanism (server SPF_HOST_RE): labels, underscores allowed, >= 2 labels, no macro. */
const SPF_HOST_RE = /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)+$/;
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function isValidIpv6(v: string): boolean {
  if (!/^[0-9a-f:.]+$/.test(v) || v.length > 45) return false;
  let s = v;
  let groups = 0;
  const tail = s.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    if (!IPV4_RE.test(tail[1])) return false;
    s = s.slice(0, -tail[1].length) + '0:0';
  }
  if (s.includes('.')) return false;
  const halves = s.split('::');
  if (halves.length > 2) return false;
  for (const h of halves) {
    if (h === '') continue;
    for (const g of h.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return false;
      groups += 1;
    }
  }
  return halves.length === 2 ? groups <= 7 : groups === 8;
}

/**
 * Mirror of the server normalizeSpfMechanism (services/mail/dns/records.ts):
 * include:/exists:/a:/mx:<host>, a, mx, ip4:<addr>[/8-32], ip6:<addr>[/16-128];
 * no qualifier, no macro, no all / redirect=.
 */
export function isValidSpfMechanism(raw: string): boolean {
  const m = raw.trim().toLowerCase();
  if (m === 'a' || m === 'mx') return true;
  const colon = m.indexOf(':');
  if (colon <= 0) return false;
  const mech = m.slice(0, colon);
  const value = m.slice(colon + 1);
  const prefixOk = (prefix: string | undefined, min: number, max: number, digits: number) =>
    prefix === undefined || (/^\d+$/.test(prefix) && prefix.length <= digits && Number(prefix) >= min && Number(prefix) <= max);
  switch (mech) {
    case 'include': case 'exists': case 'a': case 'mx':
      return SPF_HOST_RE.test(value);
    case 'ip4': {
      const [addr, prefix, extra] = value.split('/');
      return extra === undefined && IPV4_RE.test(addr) && prefixOk(prefix, 8, 32, 2);
    }
    case 'ip6': {
      const [addr, prefix, extra] = value.split('/');
      return extra === undefined && isValidIpv6(addr) && prefixOk(prefix, 16, 128, 3);
    }
    default:
      return false;
  }
}

export function MailDnsOptionsCard({ domain, manage, onSaved }: { domain: MailDomainDetail; manage: boolean; onSaved: (s: MailDnsStatus) => void }) {
  const { t } = useTranslation();
  const s = domain.dnsSettings;
  const init = {
    dmarcPolicy: (s.dmarcPolicy ?? 'default') as DmarcPolicy | 'default',
    dmarcRua: s.dmarcRua ?? '',
    spfExtra: s.spfExtra,
    mtaSts: (s.mtaSts ?? 'default') as MtaStsMode | 'default',
    tlsRpt: triOf(s.tlsRpt),
    autoconfig: triOf(s.autoconfig),
    srv: triOf(s.srv),
    dkimEd25519: triOf(s.dkimEd25519),
  };
  const key = JSON.stringify(init);
  const [draft, setDraft] = useState(init);
  useEffect(() => { setDraft(init); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<typeof init>) => setDraft((d) => ({ ...d, ...patch }));
  const dirty = JSON.stringify(draft) !== key;
  const ruaOk = !draft.dmarcRua.trim() || isValidAddress(draft.dmarcRua);

  const save = async () => {
    if (!ruaOk) return;
    const settings: Partial<MailDomainDnsSettings> = {
      dmarcPolicy: draft.dmarcPolicy === 'default' ? null : draft.dmarcPolicy,
      dmarcRua: draft.dmarcRua.trim() ? normalizeAddress(draft.dmarcRua) : null,
      spfExtra: draft.spfExtra,
      mtaSts: draft.mtaSts === 'default' ? null : draft.mtaSts,
      tlsRpt: triVal(draft.tlsRpt),
      autoconfig: triVal(draft.autoconfig),
      srv: triVal(draft.srv),
      dkimEd25519: triVal(draft.dkimEd25519),
    };
    setSaving(true);
    setError('');
    try {
      onSaved(await mailApi.updateDnsSettings(domain.id, { settings }));
      toast.success(t('mail.dnsOptions.saved') || 'DNS options saved');
    } catch (err) {
      setError(mailErrorMessage(t, err, t('mail.dnsOptions.saveFailed') || 'Failed to save the DNS options'));
    } finally {
      setSaving(false);
    }
  };

  const triSelect = (id: string, label: string, value: Tri, onChange: (v: Tri) => void, hint?: string) => (
    <div>
      <label className={labelCls} htmlFor={id}>{label}</label>
      <select id={id} value={value} disabled={!manage} onChange={(e) => onChange(e.target.value as Tri)} className={selectCls}>
        <option value="default">{t('mail.dnsOptions.platformDefault') || 'Platform default'}</option>
        <option value="on">{t('mail.dnsOptions.on') || 'On'}</option>
        <option value="off">{t('mail.dnsOptions.off') || 'Off'}</option>
      </select>
      {hint && <p className="mt-1 text-[11px] text-text-muted">{hint}</p>}
    </div>
  );

  return (
    <Card title={t('mail.dnsOptions.title') || 'DNS options'} icon={<ListChecks size={14} className="text-accent" />}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="dno-dmarc">{t('mail.dnsOptions.dmarcPolicy') || 'DMARC policy'}</label>
            <select id="dno-dmarc" value={draft.dmarcPolicy} disabled={!manage} onChange={(e) => set({ dmarcPolicy: e.target.value as DmarcPolicy | 'default' })} className={selectCls}>
              <option value="default">{t('mail.dnsOptions.platformDefault') || 'Platform default'}</option>
              <option value="none">{t('mail.dmarc.none') || 'none (monitor only)'}</option>
              <option value="quarantine">{t('mail.dmarc.quarantine') || 'quarantine (spam folder)'}</option>
              <option value="reject">{t('mail.dmarc.reject') || 'reject'}</option>
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="dno-rua">{t('mail.dnsOptions.dmarcRua') || 'DMARC reports to'}</label>
            <input id="dno-rua" type="email" value={draft.dmarcRua} disabled={!manage} onChange={(e) => set({ dmarcRua: e.target.value })} placeholder="dmarc@example.com" autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(inputCls, 'font-mono', !ruaOk && 'ring-2 ring-status-down/50')} />
          </div>
        </div>
        <div>
          <label className={labelCls} htmlFor="dno-spf">{t('mail.dnsOptions.spfExtra') || 'Extra SPF mechanisms'}</label>
          <ChipsInput
            id="dno-spf"
            value={draft.spfExtra}
            onChange={(v) => set({ spfExtra: v })}
            validate={(v) => isValidSpfMechanism(v)}
            normalize={(v) => v.trim().toLowerCase()}
            max={10}
            disabled={!manage}
            placeholder="include:_spf.example.net"
            ariaLabel={t('mail.dnsOptions.spfExtra') || 'Extra SPF mechanisms'}
          />
          <p className="mt-1 text-[11px] text-text-muted">{t('mail.dnsOptions.spfExtraHint') || 'Other servers allowed to send for this domain (newsletter service…): include:, ip4:, ip6:, a, mx.'}</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="dno-mtasts">MTA-STS</label>
            <select id="dno-mtasts" value={draft.mtaSts} disabled={!manage} onChange={(e) => set({ mtaSts: e.target.value as MtaStsMode | 'default' })} className={selectCls}>
              <option value="default">{t('mail.dnsOptions.platformDefault') || 'Platform default'}</option>
              <option value="off">{t('mail.mtaSts.off') || 'off'}</option>
              <option value="testing">{t('mail.mtaSts.testing') || 'testing'}</option>
              <option value="enforce">{t('mail.mtaSts.enforce') || 'enforce'}</option>
            </select>
          </div>
          {triSelect('dno-tlsrpt', 'TLS-RPT', draft.tlsRpt, (v) => set({ tlsRpt: v }), t('mail.dnsOptions.tlsRptHint') || 'Needs a report address in the platform settings.')}
          {triSelect('dno-autoconfig', t('mail.dnsOptions.autoconfig') || 'Autoconfiguration (Thunderbird, Outlook)', draft.autoconfig, (v) => set({ autoconfig: v }))}
          {triSelect('dno-srv', t('mail.dnsOptions.srv') || 'SRV records (IMAP, SMTP, POP)', draft.srv, (v) => set({ srv: v }))}
          {triSelect('dno-ed25519', t('mail.dnsOptions.dkimEd25519') || 'Ed25519 DKIM key (dual signing)', draft.dkimEd25519, (v) => set({ dkimEd25519: v }))}
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
        {manage && dirty && (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" disabled={saving} onClick={() => { setDraft(init); setError(''); }}>{t('common.cancel') || 'Cancel'}</Button>
            <Button size="sm" loading={saving} disabled={!ruaOk} onClick={() => { void save(); }}>{t('common.save') || 'Save'}</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

// ── External engine: records given by the customer's provider ──────────────

const EMPTY_EXTERNAL: MailExternalConfig = { mx: [], spf: null, dkim: [], dmarc: null };
/** Server caps (routes/mailDns.routes.ts externalConfig). */
const MAX_EXTERNAL_ROWS = 10;

export function MailExternalConfigCard({ domain, manage, onSaved }: { domain: MailDomainDetail; manage: boolean; onSaved: (s: MailDnsStatus) => void }) {
  const { t } = useTranslation();
  const base = domain.external ?? EMPTY_EXTERNAL;
  const toDraft = (c: MailExternalConfig) => ({
    mx: c.mx.map((m) => ({ host: m.host, priority: String(m.priority) })),
    spf: c.spf ?? '',
    dkim: c.dkim.map((d) => ({ selector: d.selector, value: d.value })),
    dmarc: c.dmarc ?? '',
  });
  const key = JSON.stringify(base);
  const [draft, setDraft] = useState(() => toDraft(base));
  useEffect(() => { setDraft(toDraft(base)); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const mxOk = draft.mx.every((m) => isValidHostname(m.host.replace(/\.$/, '')) && intIn(m.priority, 0, 65535) !== null);
  const spfOk = !draft.spf.trim() || /^v=spf1(\s|$)/i.test(draft.spf.trim());
  const dkimOk = draft.dkim.every((d) => EXTERNAL_DKIM_SELECTOR_RE.test(d.selector.trim().toLowerCase()) && /^v=DKIM1/i.test(d.value.trim()) && d.value.trim().length >= 10);
  const dmarcOk = !draft.dmarc.trim() || /^v=DMARC1;/i.test(draft.dmarc.trim());
  const valid = mxOk && spfOk && dkimOk && dmarcOk;
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(base));

  const save = async () => {
    if (!valid) return;
    const external: MailExternalConfig = {
      mx: draft.mx.map((m) => ({ host: m.host.trim().toLowerCase().replace(/\.$/, ''), priority: Number(m.priority) })),
      spf: draft.spf.trim() || null,
      dkim: draft.dkim.map((d) => ({ selector: d.selector.trim().toLowerCase(), value: d.value.trim() })),
      dmarc: draft.dmarc.trim() || null,
    };
    setSaving(true);
    setError('');
    try {
      onSaved(await mailApi.updateDnsSettings(domain.id, { external }));
      toast.success(t('mail.external.saved') || 'Provider records saved');
    } catch (err) {
      setError(mailErrorMessage(t, err, t('mail.external.saveFailed') || 'Failed to save the provider records'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={t('mail.external.title') || 'Records of your mail provider'} icon={<Globe size={14} className="text-accent" />}>
      <p className="mb-3 text-xs text-text-muted">{t('mail.external.hint') || 'Copy here the records given by your provider (Google Workspace, Microsoft 365…): the panel publishes them in the zone and checks them.'}</p>
      <div className="space-y-4">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className={labelCls}>MX</span>
            {manage && draft.mx.length < MAX_EXTERNAL_ROWS && (
              <IconButton label={t('mail.external.addMx') || 'Add an MX'} icon={<Plus size={13} />} size="sm" className="ml-auto" onClick={() => setDraft((d) => ({ ...d, mx: [...d.mx, { host: '', priority: String((d.mx.length + 1) * 10) }] }))} />
            )}
          </div>
          {draft.mx.length === 0 && <p className="text-[11px] text-text-muted">{t('mail.external.noMx') || 'No MX: the domain receives no mail.'}</p>}
          <div className="space-y-1.5">
            {draft.mx.map((m, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input aria-label={t('mail.external.priority') || 'Priority'} type="number" min={0} max={65535} value={m.priority} disabled={!manage} onChange={(e) => setDraft((d) => ({ ...d, mx: d.mx.map((x, j) => (j === i ? { ...x, priority: e.target.value } : x)) }))} className={cn(inputCls, 'w-20 shrink-0 font-mono')} />
                <input aria-label={t('mail.external.host') || 'Mail server'} value={m.host} disabled={!manage} placeholder="aspmx.l.google.com" onChange={(e) => setDraft((d) => ({ ...d, mx: d.mx.map((x, j) => (j === i ? { ...x, host: e.target.value } : x)) }))} autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(inputCls, 'min-w-0 flex-1 font-mono', m.host && !isValidHostname(m.host.replace(/\.$/, '')) && 'ring-2 ring-status-down/50')} />
                {manage && <IconButton label={t('common.delete') || 'Delete'} variant="danger" icon={<Trash2 size={13} />} onClick={() => setDraft((d) => ({ ...d, mx: d.mx.filter((_, j) => j !== i) }))} />}
              </div>
            ))}
          </div>
        </div>
        <div>
          <label className={labelCls} htmlFor="ext-spf">SPF</label>
          <input id="ext-spf" value={draft.spf} disabled={!manage} onChange={(e) => setDraft((d) => ({ ...d, spf: e.target.value }))} placeholder="v=spf1 include:_spf.google.com ~all" autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(inputCls, 'font-mono', !spfOk && 'ring-2 ring-status-down/50')} />
        </div>
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span className={labelCls}>DKIM</span>
            {manage && draft.dkim.length < MAX_EXTERNAL_ROWS && (
              <IconButton label={t('mail.external.addDkim') || 'Add a DKIM key'} icon={<Plus size={13} />} size="sm" className="ml-auto" onClick={() => setDraft((d) => ({ ...d, dkim: [...d.dkim, { selector: '', value: '' }] }))} />
            )}
          </div>
          <div className="space-y-1.5">
            {draft.dkim.map((k, i) => (
              <div key={i} className="flex items-start gap-1.5 max-sm:flex-wrap">
                <input aria-label={t('mail.external.selector') || 'Selector'} value={k.selector} disabled={!manage} placeholder="google" onChange={(e) => setDraft((d) => ({ ...d, dkim: d.dkim.map((x, j) => (j === i ? { ...x, selector: e.target.value } : x)) }))} autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(inputCls, 'font-mono sm:w-36 sm:shrink-0')} />
                <textarea aria-label={t('mail.external.dkimValue') || 'Value'} rows={2} value={k.value} disabled={!manage} placeholder="v=DKIM1; k=rsa; p=…" onChange={(e) => setDraft((d) => ({ ...d, dkim: d.dkim.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) }))} spellCheck={false} className={cn(inputCls, 'min-w-0 flex-1 font-mono text-xs')} />
                {manage && <IconButton label={t('common.delete') || 'Delete'} variant="danger" icon={<Trash2 size={13} />} onClick={() => setDraft((d) => ({ ...d, dkim: d.dkim.filter((_, j) => j !== i) }))} />}
              </div>
            ))}
          </div>
          {!dkimOk && <p className="mt-1 text-xs text-status-down">{t('mail.external.dkimInvalid') || 'Selector: lower-case letters, digits, dots, dashes and underscores; value starting with v=DKIM1.'}</p>}
        </div>
        <div>
          <label className={labelCls} htmlFor="ext-dmarc">DMARC</label>
          <input id="ext-dmarc" value={draft.dmarc} disabled={!manage} onChange={(e) => setDraft((d) => ({ ...d, dmarc: e.target.value }))} placeholder={t('mail.external.dmarcDefault') || 'empty: v=DMARC1; p=none (platform default)'} autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(inputCls, 'font-mono', !dmarcOk && 'ring-2 ring-status-down/50')} />
        </div>
        {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
        {manage && dirty && (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" disabled={saving} onClick={() => { setDraft(toDraft(base)); setError(''); }}>{t('common.cancel') || 'Cancel'}</Button>
            <Button size="sm" loading={saving} disabled={!valid} onClick={() => { void save(); }}>{t('common.save') || 'Save'}</Button>
          </div>
        )}
      </div>
    </Card>
  );
}
