import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Check, Pencil, Plus, RefreshCw, Route as RouteIcon, ShieldCheck, Trash2, X, Settings2 } from 'lucide-react';
import type {
  CertificateDetail, Domain, DomainKind, DomainUpdate, Site, SiteRoute, SiteRuntime, TlsMode,
} from '@oblimint/shared';
import { HostingSocketEvents, normalizePathPrefix } from '@oblimint/shared';
import { domainsApi } from '@/api/domains.api';
import { sitesApi } from '@/api/sites.api';
import { useHostingMe } from '@/store/hostingStore';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { cn } from '@/utils/cn';
import {
  Card, InfoRow, Pill, TlsBadge, hostingErrorMessage, inputCls, isStepUpHandled, labelCls, payloadNumber, selectCls, toastHostingError,
  useHostingEvents,
} from './hostingUi';
import { DOMAIN_KINDS, domainKindLabel, tlsModeLabel } from './DomainCreateModal';
import { domainRoutesSite, followServerValues } from './hostingFormat';

/** Detail of a domain: route table, settings, certificate, deletion. */
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
  // CERTIFICATE_UPDATED too: the TLS badge of the header comes from domain.certificate.
  useHostingEvents([HostingSocketEvents.HOSTING_CHANGED, HostingSocketEvents.CERTIFICATE_UPDATED], () => { void load(); }, (e, p) => {
    if (e === HostingSocketEvents.CERTIFICATE_UPDATED) return payloadNumber(p, 'domainId') === domainId;
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
        <span className="w-full text-xs text-text-muted">
          {t('domains.col.account') || 'Account'}:{' '}
          <Link to={`/accounts/${domain.accountId}`} className="font-mono text-text-secondary hover:text-accent">{domain.accountUsername}</Link>
        </span>
      </div>

      <RoutesCard domain={domain} manage={manage} onChanged={() => { void load(); }} />
      <SettingsCard domain={domain} manage={manage} onSaved={(d) => { setDomain(d); onChanged?.(d); }} />
      <CertificateCard domain={domain} manage={manage} />

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

// ── Route table ─────────────────────────────────────────────────────────────

interface RouteDraft { id: number | null; prefix: string; siteId: number | ''; runtimeId: number | null }

function RoutesCard({ domain, manage, onChanged }: { domain: Domain; manage: boolean; onChanged: () => void }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [sites, setSites] = useState<Site[]>([]);
  const [runtimes, setRuntimes] = useState<Record<number, SiteRuntime[]>>({});
  const [draft, setDraft] = useState<RouteDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    sitesApi.list({ accountId: domain.accountId })
      .then((list) => { if (!cancelled) setSites(list); })
      .catch(() => { if (!cancelled) setSites([]); });
    return () => { cancelled = true; };
  }, [domain.accountId]);

  // Sites whose runtimes were requested (in flight or loaded): one request per site.
  const requestedRuntimes = useRef(new Set<number>());
  const loadRuntimes = useCallback((siteId: number) => {
    if (requestedRuntimes.current.has(siteId)) return;
    requestedRuntimes.current.add(siteId);
    sitesApi.runtimes(siteId)
      .then((list) => setRuntimes((cur) => ({ ...cur, [siteId]: list })))
      .catch(() => setRuntimes((cur) => ({ ...cur, [siteId]: [] })));
  }, []);

  const draftSiteId = draft?.siteId ?? '';
  useEffect(() => { if (draftSiteId !== '') loadRuntimes(draftSiteId); }, [draftSiteId, loadRuntimes]);

  // Longest prefix first: the order the edge matches them in.
  const routes = useMemo(() => [...domain.routes].sort((a, b) => b.pathPrefix.length - a.pathPrefix.length || a.pathPrefix.localeCompare(b.pathPrefix)), [domain.routes]);

  const normalizedPrefix = draft ? normalizePathPrefix(draft.prefix) : null;

  const startAdd = () => {
    setError(null);
    setDraft({ id: null, prefix: domain.routes.some((r) => r.pathPrefix === '/') ? '' : '/', siteId: sites.length === 1 ? sites[0].id : '', runtimeId: null });
  };
  const startEdit = (r: SiteRoute) => { setError(null); setDraft({ id: r.id, prefix: r.pathPrefix, siteId: r.siteId, runtimeId: r.runtimeId }); };

  const save = async () => {
    if (!draft || draft.siteId === '' || !normalizedPrefix) return;
    setSaving(true);
    setError(null);
    try {
      const input = { pathPrefix: normalizedPrefix, siteId: draft.siteId, runtimeId: draft.runtimeId };
      if (draft.id == null) await domainsApi.addRoute(domain.id, input);
      else await domainsApi.updateRoute(domain.id, draft.id, input);
      toast.success(t('domains.routes.saved') || 'Route saved');
      setDraft(null);
      onChanged();
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(hostingErrorMessage(t, err, t('domains.routes.saveFailed') || 'Failed to save the route'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r: SiteRoute) => {
    if (!(await confirm({
      message: t('domains.routes.deleteConfirm', { prefix: r.pathPrefix, defaultValue: 'Remove the route {{prefix}}?' }),
      danger: true,
    }))) return;
    try {
      await domainsApi.deleteRoute(domain.id, r.id);
      onChanged();
    } catch (err) {
      toastHostingError(t, err, t('domains.routes.deleteFailed') || 'Failed to remove the route');
    }
  };

  const runtimeLabel = (r: SiteRoute) => (r.runtimeId == null
    ? (t('domains.routes.primary') || 'primary')
    : (r.runtimeBase ?? `#${r.runtimeId}`));

  const editor = draft && (
    <div className="space-y-2 rounded-lg bg-bg-primary p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div>
          <label className={labelCls} htmlFor="route-prefix">{t('domains.routes.prefix') || 'Path prefix'}</label>
          <input
            id="route-prefix"
            value={draft.prefix}
            autoFocus
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            onChange={(e) => setDraft({ ...draft, prefix: e.target.value })}
            onBlur={() => { if (normalizedPrefix) setDraft({ ...draft, prefix: normalizedPrefix }); }}
            placeholder="/shop/"
            className={cn(inputCls, 'font-mono', draft.prefix && !normalizedPrefix && 'ring-2 ring-status-down')}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="route-site">{t('domains.routes.site') || 'Site'}</label>
          <select id="route-site" value={draft.siteId} onChange={(e) => setDraft({ ...draft, siteId: e.target.value ? Number(e.target.value) : '', runtimeId: null })} className={selectCls}>
            <option value="">{t('domains.routes.chooseSite') || 'Choose a site…'}</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.slug})</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="route-runtime">{t('domains.routes.runtime') || 'Runtime'}</label>
          <select
            id="route-runtime"
            value={draft.runtimeId ?? ''}
            disabled={draft.siteId === ''}
            onChange={(e) => setDraft({ ...draft, runtimeId: e.target.value ? Number(e.target.value) : null })}
            className={selectCls}
          >
            <option value="">
              {t('domains.routes.primary') || 'primary'}
              {draft.siteId !== '' ? ` (${sites.find((s) => s.id === draft.siteId)?.base ?? ''})` : ''}
            </option>
            {(draft.siteId !== '' ? runtimes[draft.siteId] ?? [] : []).map((rt) => (
              <option key={rt.id} value={rt.id}>{t('domains.routes.secondary') || 'secondary'} — {rt.base}</option>
            ))}
          </select>
        </div>
      </div>
      {draft.prefix && !normalizedPrefix && (
        <p className="text-xs text-status-down">{t('domains.routes.prefixInvalid') || 'A prefix is "/" or "/path/" (letters, digits, . _ @ + - only).'}</p>
      )}
      {normalizedPrefix && normalizedPrefix !== draft.prefix && (
        <p className="font-mono text-xs text-text-muted">{t('domains.routes.normalized', { prefix: normalizedPrefix, defaultValue: 'Saved as {{prefix}}' })}</p>
      )}
      {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setDraft(null)}><X size={13} className="mr-1" />{t('common.cancel') || 'Cancel'}</Button>
        <Button size="sm" loading={saving} disabled={!normalizedPrefix || draft.siteId === ''} onClick={() => { void save(); }}>
          <Check size={13} className="mr-1" />{t('common.save') || 'Save'}
        </Button>
      </div>
    </div>
  );

  return (
    <Card
      title={t('domains.routes.title') || 'Routes'}
      icon={<RouteIcon size={14} className="text-accent" />}
      actions={manage && !draft ? (
        <Button size="sm" variant="secondary" onClick={startAdd} disabled={sites.length === 0}>
          <Plus size={13} className="mr-1" />{t('domains.routes.add') || 'Add a route'}
        </Button>
      ) : undefined}
    >
      <p className="mb-3 text-xs text-text-muted">
        {t('domains.routes.hint') || 'Each path prefix of the domain is served by a site (or one of its secondary runtimes). The longest matching prefix wins: /shop/ beats /.'}
      </p>
      {routes.length === 0 && !draft ? (
        <p className="text-xs text-text-muted">
          {sites.length === 0
            ? (t('domains.routes.noSite') || 'The account has no site yet: create a site, then route the domain to it.')
            : (t('domains.routes.empty') || 'No route: the domain answers 404.')}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {routes.map((r) => (draft?.id === r.id ? (
            <li key={r.id} className="py-2">{editor}</li>
          ) : (
            <li key={r.id} className="flex items-center gap-2 py-2">
              <span className="w-28 shrink-0 truncate font-mono text-sm text-accent">{r.pathPrefix}</span>
              <span className="min-w-0 flex-1 text-sm text-text-primary">
                <Link to={`/sites/${r.siteId}`} className="hover:text-accent">{r.siteName}</Link>
                <span className="ml-2 font-mono text-[11px] text-text-muted">{runtimeLabel(r)}</span>
              </span>
              {manage && !draft && (
                <>
                  <IconButton label={t('common.edit') || 'Edit'} icon={<Pencil size={13} />} size="sm" onClick={() => startEdit(r)} />
                  <IconButton label={t('common.delete') || 'Delete'} icon={<Trash2 size={13} />} size="sm" variant="danger" onClick={() => { void remove(r); }} />
                </>
              )}
            </li>
          )))}
          {draft?.id === null && <li className="py-2">{editor}</li>}
        </ul>
      )}
    </Card>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

interface SettingsForm { kind: DomainKind; includeWww: boolean; tlsMode: TlsMode; forceHttps: boolean }

function SettingsCard({ domain, manage, onSaved }: { domain: Domain; manage: boolean; onSaved: (d: Domain) => void }) {
  const { t } = useTranslation();
  const server: SettingsForm = { kind: domain.kind, includeWww: domain.includeWww, tlsMode: domain.tlsMode, forceHttps: domain.forceHttps };
  const [form, setForm] = useState<SettingsForm>(server);
  const [saving, setSaving] = useState(false);
  const { kind, includeWww, tlsMode, forceHttps } = form;
  const setKind = (v: DomainKind) => setForm((f) => ({ ...f, kind: v }));
  const setIncludeWww = (v: boolean) => setForm((f) => ({ ...f, includeWww: v }));
  const setTlsMode = (v: TlsMode) => setForm((f) => ({ ...f, tlsMode: v }));
  const setForceHttps = (v: boolean) => setForm((f) => ({ ...f, forceHttps: v }));

  // A reload (socket event, other tab) must not wipe unsaved edits: follow the
  // server values field by field, only where the field is still untouched.
  const [lastServer, setLastServer] = useState<SettingsForm>(server);
  if (server.kind !== lastServer.kind || server.includeWww !== lastServer.includeWww
    || server.tlsMode !== lastServer.tlsMode || server.forceHttps !== lastServer.forceHttps) {
    setLastServer(server);
    setForm((f) => followServerValues(f, lastServer, server));
  }

  const patch: DomainUpdate = {};
  if (kind !== domain.kind) patch.kind = kind;
  if (includeWww !== domain.includeWww) patch.includeWww = includeWww;
  if (tlsMode !== domain.tlsMode) patch.tlsMode = tlsMode;
  const effForce = tlsMode === 'none' ? false : forceHttps;
  if (effForce !== domain.forceHttps) patch.forceHttps = effForce;
  const dirty = Object.keys(patch).length > 0;

  const save = async () => {
    setSaving(true);
    try {
      onSaved(await domainsApi.update(domain.id, patch));
      toast.success(t('domains.saved') || 'Domain saved');
    } catch (err) {
      toastHostingError(t, err, t('domains.saveFailed') || 'Failed to save the domain');
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
