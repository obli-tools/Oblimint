import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Asterisk, AtSign, CornerDownRight, Link2, Network, RefreshCw, Shuffle, ShieldCheck, Trash2, Settings2 } from 'lucide-react';
import type {
  CertificateDetail, Domain, DomainKind, DomainUpdate, MailDomain, ProxyHost, TlsMode,
} from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { domainsApi } from '@/api/domains.api';
import { mailApi } from '@/api/mail.api';
import { proxyApi } from '@/api/proxy.api';
import { MailDomainCreateModal } from '@/components/mail/MailDomainCreateModal';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { AccountLink } from '@/components/common/DetailHeader';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { cn } from '@/utils/cn';
import {
  Card, InfoRow, Pill, TlsBadge, hostingErrorMessage, labelCls, payloadNumber, selectCls, toastHostingError, useHostingEvents,
} from './hostingUi';
import { DOMAIN_KINDS, DomainCreateModal, domainKindLabel, tlsModeLabel } from './DomainCreateModal';
import { useDomainDrawer } from './DomainDrawer';
import { VerificationBadge, ZoneKindBadge } from '@/components/dns/DnsBadges';
import { DomainOwnershipCard } from '@/components/dns/DomainOwnershipCard';
import { toastOwnershipError } from '@/components/dns/dnsErrors';
import { domainRoutesSite, followServerValues } from './hostingFormat';
import { RouteEditor } from './RouteEditor';

/**
 * What the domain serves besides its routes (coherence plan 1.4): the proxy
 * hosts bound to it and its mail domain, read from the lists of the account
 * (null = not readable by the caller, the line is not shown).
 */
function useDomainUsage(domain: Domain | null): { proxyHosts: ProxyHost[] | null; mailDomain: MailDomain | null | undefined; reload: () => void } {
  const [proxyHosts, setProxyHosts] = useState<ProxyHost[] | null>(null);
  const [mailDomain, setMailDomain] = useState<MailDomain | null | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const domainId = domain?.id ?? null;
  const accountId = domain?.accountId ?? null;
  useEffect(() => {
    if (domainId == null || accountId == null) return;
    let cancelled = false;
    proxyApi.listHosts({ accountId })
      .then((l) => { if (!cancelled) setProxyHosts(l.filter((h) => h.domains.some((d) => d.domainId === domainId))); })
      .catch(() => { if (!cancelled) setProxyHosts(null); });
    mailApi.listDomains({ accountId })
      .then((l) => { if (!cancelled) setMailDomain(l.find((m) => m.domainId === domainId) ?? null); })
      .catch(() => { if (!cancelled) setMailDomain(undefined); });
    return () => { cancelled = true; };
  }, [domainId, accountId, tick]);
  return { proxyHosts, mailDomain, reload: () => setTick((n) => n + 1) };
}

/** Detail of a domain: what it serves (routes, proxy, mail), settings, certificate, deletion. */
export function DomainPanel({ domainId, onChanged, onDeleted }: {
  domainId: number;
  /** The domain changed (row refresh in the parent list). */
  onChanged?: (d: Domain) => void;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { can } = useHostingMe();
  const [domain, setDomain] = useState<Domain | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingSub, setAddingSub] = useState(false);
  const drawer = useDomainDrawer();

  const load = useCallback(async () => {
    try {
      const d = await domainsApi.get(domainId);
      setDomain(d);
      setError(null);
      onChanged?.(d);
    } catch (err) {
      setError(hostingErrorMessage(t, err, t('domains.loadFailed') || 'Failed to load the domain'));
    }
  }, [domainId, t]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setDomain(null); void load(); }, [load]);
  const usage = useDomainUsage(domain);
  // CERTIFICATE_UPDATED too: the TLS badge of the header comes from domain.certificate.
  // P2: the verification badge and the zone link come from the domain row too.
  useHostingEvents([
    HostingSocketEvents.HOSTING_CHANGED, HostingSocketEvents.CERTIFICATE_UPDATED,
    HostingSocketEvents.DOMAIN_VERIFICATION_UPDATED, HostingSocketEvents.DNS_ZONE_UPDATED,
  ], () => { void load(); }, (e, p) => {
    if (e === HostingSocketEvents.CERTIFICATE_UPDATED || e === HostingSocketEvents.DOMAIN_VERIFICATION_UPDATED
      || e === HostingSocketEvents.DNS_ZONE_UPDATED) return payloadNumber(p, 'domainId') === domainId;
    const entity = (p as { entity?: string } | null)?.entity;
    if (entity === 'domain') return payloadNumber(p, 'id') === domainId;
    // A site event only matters for a site routed by this domain (status of the routes).
    return entity === 'site' && !!domain && domainRoutesSite(domain.routes, payloadNumber(p, 'id'));
  });

  if (error) return <p className="py-8 text-center text-sm text-text-muted">{error}</p>;
  if (!domain) return <div className="flex justify-center py-12"><LoadingSpinner /></div>;

  const manage = can('domains.manage', domain.accountId);

  const remove = async () => {
    if (!(await confirm({
      title: t('domains.deleteTitle') || 'Delete the domain',
      message: t('domains.deleteConfirm', { name: domain.name, defaultValue: 'Delete {{name}}, its routes and its certificate? The sites are not affected.' }),
      danger: true,
      requireText: domain.name,
    }))) return;
    try {
      await domainsApi.delete(domain.id);
      toast.success(t('domains.deleted') || 'Domain deleted');
      onDeleted?.();
    } catch (err) {
      toastHostingError(t, err, t('domains.deleteFailed') || 'Failed to delete the domain');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="break-all font-mono text-base font-semibold text-text-primary">{domain.name}</span>
        <Pill>{domainKindLabel(t, domain.kind)}</Pill>
        <TlsBadge tlsMode={domain.tlsMode} certificate={domain.certificate} />
        <VerificationBadge verification={domain.verification} />
        {domain.wildcard && <Pill tone="blue"><Asterisk size={10} />{t('dns.wildcard.badge') || 'wildcard'}</Pill>}
        <span className="w-full text-xs text-text-muted">
          {t('domains.col.account') || 'Account'}:{' '}
          <AccountLink accountId={domain.accountId} username={domain.accountUsername} tab="domains" className="text-text-secondary" />
        </span>
        <span className="flex w-full flex-wrap items-center gap-1.5 text-xs text-text-muted">
          <Network size={12} className="shrink-0" />
          {t('dns.zone.label') || 'DNS zone'}:{' '}
          {domain.zone ? (
            <>
              <Link to={`/dns/zones/${domain.zone.id}`} className="font-mono text-text-secondary hover:text-accent">{domain.zone.name}</Link>
              <ZoneKindBadge kind={domain.zone.kind} />
            </>
          ) : (
            <span>{t('dns.zone.none') || 'none'}</span>
          )}
        </span>
        {manage && (
          <span className="w-full text-xs">
            <button type="button" onClick={() => setAddingSub(true)} className="inline-flex items-center gap-1 text-accent hover:underline">
              <CornerDownRight size={12} />{t('domains.addSubdomain') || 'Add a subdomain'}
            </button>
          </span>
        )}
      </div>

      <DomainOwnershipCard domain={domain} onVerified={() => { void load(); }} />
      <RouteEditor
        domain={domain}
        manage={manage}
        onChanged={() => { void load(); }}
        // A domain bound to a proxy host does not answer 404 without a route.
        emptyText={usage.proxyHosts && usage.proxyHosts.length > 0
          ? (t('domains.usage.servedByProxy') || 'No site route: the domain is served by the proxy host(s) below.')
          : undefined}
      />
      <UsedByCard domain={domain} proxyHosts={usage.proxyHosts} mailDomain={usage.mailDomain} onMailCreated={usage.reload} />
      <SettingsCard domain={domain} manage={manage} onSaved={(d) => { setDomain(d); onChanged?.(d); }} />
      <CertificateCard domain={domain} manage={manage} />

      {manage && (
        <DomainCreateModal
          open={addingSub}
          accountId={domain.accountId}
          initialMode="subdomain"
          parentDomainId={domain.id}
          onClose={() => setAddingSub(false)}
          onCreated={(d) => {
            setAddingSub(false);
            toast.success(t('domains.created', { name: d.name, defaultValue: 'Domain {{name}} added' }));
            // Next step of the new name (route, ownership): its own drawer.
            drawer.open(d.id);
          }}
        />
      )}
      {manage && (
        <div className="flex justify-end">
          <Button size="sm" variant="danger" onClick={() => { void remove(); }}>
            <Trash2 size={13} className="mr-1.5" />{t('domains.delete') || 'Delete the domain'}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Used by (proxy, mail) ───────────────────────────────────────────────────

function UsedByCard({ domain, proxyHosts, mailDomain, onMailCreated }: {
  domain: Domain;
  proxyHosts: ProxyHost[] | null;
  /** undefined = not readable; null = no mail on this domain. */
  mailDomain: MailDomain | null | undefined;
  onMailCreated: () => void;
}) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const [creatingMail, setCreatingMail] = useState(false);
  if (proxyHosts === null && mailDomain === undefined) return null;
  const canMail = can('mail.manage', domain.accountId);

  return (
    <Card title={t('domains.usage.title') || 'Used by'} icon={<Link2 size={14} className="text-accent" />}>
      <ul className="divide-y divide-border text-sm">
        {proxyHosts !== null && (
          <li className="flex flex-wrap items-center gap-2 py-2">
            <Shuffle size={14} className="shrink-0 text-text-muted" />
            <span className="w-28 shrink-0 text-xs text-text-muted">{t('domains.usage.proxy') || 'Proxy'}</span>
            {proxyHosts.length === 0 ? (
              <span className="text-xs text-text-muted">{t('domains.usage.noProxy') || 'No proxy host'}</span>
            ) : (
              <span className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1">
                {proxyHosts.map((h) => (
                  <Link key={h.id} to={`/proxy/hosts/${h.id}`} className="text-text-primary hover:text-accent">
                    {h.name} <span className="font-mono text-[11px] text-text-muted">→ {h.targetLabel}</span>
                  </Link>
                ))}
              </span>
            )}
          </li>
        )}
        {mailDomain !== undefined && (
          <li className="flex flex-wrap items-center gap-2 py-2">
            <AtSign size={14} className="shrink-0 text-text-muted" />
            <span className="w-28 shrink-0 text-xs text-text-muted">{t('domains.usage.mail') || 'Mail'}</span>
            {mailDomain ? (
              <Link to={`/mail/domains/${mailDomain.id}`} className="text-text-primary hover:text-accent">
                {t('domains.usage.mailboxes', { count: mailDomain.mailboxCount, defaultValue: '{{count}} mailbox(es)' })}
                {!mailDomain.enabled && <span className="ml-1.5 text-xs text-text-muted">({t('domains.usage.mailOff') || 'disabled'})</span>}
              </Link>
            ) : canMail ? (
              <button type="button" onClick={() => setCreatingMail(true)} className="text-accent hover:underline">{t('domains.usage.enableMail') || 'Enable mail'}</button>
            ) : (
              <span className="text-xs text-text-muted">{t('domains.usage.noMail') || 'No mail'}</span>
            )}
          </li>
        )}
      </ul>
      {canMail && (
        <MailDomainCreateModal
          open={creatingMail}
          accounts={[]}
          defaultAccountId={domain.accountId}
          defaultDomainId={domain.id}
          onClose={() => setCreatingMail(false)}
          onCreated={() => { setCreatingMail(false); toast.success(t('domains.usage.mailEnabled') || 'Mail enabled'); onMailCreated(); }}
        />
      )}
    </Card>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

interface SettingsForm { kind: DomainKind; includeWww: boolean; tlsMode: TlsMode; forceHttps: boolean; wildcard: boolean }

function SettingsCard({ domain, manage, onSaved }: { domain: Domain; manage: boolean; onSaved: (d: Domain) => void }) {
  const { t } = useTranslation();
  const server: SettingsForm = {
    kind: domain.kind, includeWww: domain.includeWww, tlsMode: domain.tlsMode, forceHttps: domain.forceHttps, wildcard: domain.wildcard,
  };
  const [form, setForm] = useState<SettingsForm>(server);
  const [saving, setSaving] = useState(false);
  const { kind, includeWww, tlsMode, forceHttps, wildcard } = form;
  const setKind = (v: DomainKind) => setForm((f) => ({ ...f, kind: v }));
  const setIncludeWww = (v: boolean) => setForm((f) => ({ ...f, includeWww: v }));
  const setTlsMode = (v: TlsMode) => setForm((f) => ({ ...f, tlsMode: v }));
  const setForceHttps = (v: boolean) => setForm((f) => ({ ...f, forceHttps: v }));
  const setWildcard = (v: boolean) => setForm((f) => ({ ...f, wildcard: v }));
  // Wildcard certificate = DNS-01: a zone hosted here is required (server: wildcardNeedsHostedZone).
  const wildcardBlocked = !domain.wildcard && domain.zone?.kind !== 'hosted';

  // A reload (socket event, other tab) must not wipe unsaved edits: follow the
  // server values field by field, only where the field is still untouched.
  const [lastServer, setLastServer] = useState<SettingsForm>(server);
  if (server.kind !== lastServer.kind || server.includeWww !== lastServer.includeWww
    || server.tlsMode !== lastServer.tlsMode || server.forceHttps !== lastServer.forceHttps
    || server.wildcard !== lastServer.wildcard) {
    setLastServer(server);
    setForm((f) => followServerValues(f, lastServer, server));
  }

  const patch: DomainUpdate = {};
  if (kind !== domain.kind) patch.kind = kind;
  if (includeWww !== domain.includeWww) patch.includeWww = includeWww;
  if (tlsMode !== domain.tlsMode) patch.tlsMode = tlsMode;
  const effForce = tlsMode === 'none' ? false : forceHttps;
  if (effForce !== domain.forceHttps) patch.forceHttps = effForce;
  if (wildcard !== domain.wildcard) patch.wildcard = wildcard;
  const dirty = Object.keys(patch).length > 0;

  const save = async () => {
    setSaving(true);
    try {
      onSaved(await domainsApi.update(domain.id, patch));
      toast.success(t('domains.saved') || 'Domain saved');
    } catch (err) {
      toastOwnershipError(t, err, t('domains.saveFailed') || 'Failed to save the domain');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={t('domains.settings') || 'Settings'} icon={<Settings2 size={14} className="text-accent" />}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls} htmlFor="dom-set-kind">{t('domains.form.kind') || 'Kind'}</label>
          <select id="dom-set-kind" value={kind} disabled={!manage} onChange={(e) => setKind(e.target.value as DomainKind)} className={selectCls}>
            {DOMAIN_KINDS.map((k) => <option key={k} value={k}>{domainKindLabel(t, k)}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="dom-set-tls">{t('domains.form.tls') || 'TLS'}</label>
          <select id="dom-set-tls" value={tlsMode} disabled={!manage} onChange={(e) => setTlsMode(e.target.value as TlsMode)} className={selectCls}>
            <option value="letsencrypt">{tlsModeLabel(t, 'letsencrypt')}</option>
            <option value="none">{tlsModeLabel(t, 'none')}</option>
          </select>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        <ToggleSwitch checked={includeWww} disabled={!manage} onChange={setIncludeWww} label={t('domains.form.includeWww') || 'Also serve www.'} description={`www.${domain.name}`} />
        <ToggleSwitch
          checked={effForce}
          disabled={!manage || tlsMode === 'none'}
          onChange={setForceHttps}
          label={t('domains.forceHttps') || 'Force HTTPS'}
          description={t('domains.form.forceHttpsHint') || 'Redirect HTTP to HTTPS once the certificate is valid.'}
        />
        <ToggleSwitch
          checked={wildcard}
          disabled={!manage || (wildcardBlocked && !wildcard)}
          onChange={setWildcard}
          label={t('dns.wildcard.label') || 'Wildcard (*.domain)'}
          description={wildcardBlocked
            ? (t('dns.wildcard.needsHosted') || 'Needs a DNS zone hosted here (certificate through DNS-01).')
            : `*.${domain.name}`}
        />
      </div>
      {manage && (
        <div className="mt-3 flex justify-end">
          <Button size="sm" loading={saving} disabled={!dirty} onClick={() => { void save(); }}>{t('common.save') || 'Save'}</Button>
        </div>
      )}
    </Card>
  );
}

// ── Certificate ─────────────────────────────────────────────────────────────

function CertificateCard({ domain, manage }: { domain: Domain; manage: boolean }) {
  const { t, i18n } = useTranslation();
  const [cert, setCert] = useState<CertificateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [busy, setBusy] = useState<'renew' | 'force' | null>(null);
  // Forcing a renewal of a valid certificate is staff-only (server: 409 certificateNotDue for a client).
  const { me } = useHostingMe();
  const canForce = me?.kind === 'staff';

  const load = useCallback(async () => {
    try {
      setCert(await domainsApi.certificate(domain.id));
      setUnavailable(null);
    } catch (err) {
      setCert(null);
      setUnavailable(hostingErrorMessage(t, err, t('certificates.loadFailed') || 'Failed to load the certificate'));
    } finally {
      setLoading(false);
    }
  }, [domain.id, t]);

  useEffect(() => { setLoading(true); void load(); }, [load]);
  useHostingEvents([HostingSocketEvents.CERTIFICATE_UPDATED], () => { void load(); }, (_e, p) => payloadNumber(p, 'domainId') === domain.id);

  const renew = async (force: boolean) => {
    setBusy(force ? 'force' : 'renew');
    try {
      setCert(await domainsApi.renewCertificate(domain.id, force));
      toast.success(t('certificates.renewRequested') || 'Certificate request started');
    } catch (err) {
      toastHostingError(t, err, t('certificates.renewFailed') || 'Certificate request failed');
    } finally {
      setBusy(null);
    }
  };

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(i18n.language) : '—');
  const issuerLabel = (i: CertificateDetail['issuer']) => (i === 'letsencrypt' ? "Let's Encrypt"
    : i === 'letsencrypt-staging' ? (t('certificates.issuerStaging') || "Let's Encrypt (staging, untrusted)")
    : (t('certificates.issuerSelfSigned') || 'Self-signed'));

  return (
    <Card
      title={t('certificates.title') || 'Certificate'}
      icon={<ShieldCheck size={14} className="text-accent" />}
      actions={manage && domain.tlsMode !== 'none' ? (
        <>
          <Button size="sm" variant="secondary" loading={busy === 'renew'} disabled={busy !== null} onClick={() => { void renew(false); }}>
            <RefreshCw size={13} className="mr-1.5" />{t('certificates.renew') || 'Renew'}
          </Button>
          {canForce && (
            <Button size="sm" variant="ghost" loading={busy === 'force'} disabled={busy !== null} onClick={() => { void renew(true); }}>
              {t('certificates.force') || 'Force'}
            </Button>
          )}
        </>
      ) : undefined}
    >
      {domain.tlsMode === 'none' ? (
        <p className="text-xs text-text-muted">{t('certificates.tlsOff') || 'TLS is off for this domain: it is served over HTTP only.'}</p>
      ) : loading ? (
        <div className="flex justify-center py-4"><LoadingSpinner size="sm" /></div>
      ) : unavailable ? (
        <p className="text-xs text-text-muted">{unavailable}</p>
      ) : !cert ? (
        <p className="text-xs text-text-muted">{t('certificates.none') || 'No certificate yet: it is requested automatically once a route exists and the DNS points here.'}</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <InfoRow label={t('certificates.status') || 'Status'}><TlsBadge tlsMode={domain.tlsMode} certificate={cert} /></InfoRow>
            <InfoRow label={t('certificates.issuer') || 'Issuer'}>{issuerLabel(cert.issuer)}</InfoRow>
            <InfoRow label={t('certificates.notBefore') || 'Valid from'} mono>{fmt(cert.notBefore)}</InfoRow>
            <InfoRow label={t('certificates.notAfter') || 'Valid until'} mono>{fmt(cert.notAfter)}</InfoRow>
          </div>
          <InfoRow label={t('certificates.names') || 'Names'} mono>{cert.names.join(', ') || '—'}</InfoRow>
          {cert.lastError && (
            <div>
              <div className={labelCls}>{t('certificates.lastError') || 'Last error'}</div>
              <pre className="whitespace-pre-wrap break-words rounded-md bg-status-down/5 p-2 font-mono text-[11px] text-status-down">{cert.lastError}</pre>
            </div>
          )}
          {cert.log.length > 0 && (
            <div>
              <div className={labelCls}>{t('certificates.log') || 'Log'}</div>
              <div className="max-h-48 overflow-y-auto rounded-md bg-bg-primary p-2 font-mono text-[11px] leading-relaxed">
                {cert.log.slice(-100).map((l, i) => (
                  <div key={i} className={cn(l.level === 'error' ? 'text-status-down' : l.level === 'warn' ? 'text-amber-400' : 'text-text-secondary')}>
                    <span className="text-text-muted">{new Date(l.at).toLocaleTimeString(i18n.language)}</span> {l.message}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
