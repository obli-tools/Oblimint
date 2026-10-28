import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Check, ExternalLink, Pencil, Plus, Route as RouteIcon, Trash2, X } from 'lucide-react';
import {
  HostingSocketEvents, normalizePathPrefix, type Domain, type HostingChangedPayload, type Site, type SiteRoute, type SiteRuntime,
} from '@oblimint/shared';
import { domainsApi } from '@/api/domains.api';
import { sitesApi } from '@/api/sites.api';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Pill } from '@/components/common/Pill';
import { BaseBadge } from '@/components/sites/SiteBadges';
import { siteErrorMessage, toastSiteError } from '@/components/sites/siteErrors';
import { useHostingEvent } from '@/components/sites/useHostingEvent';
import { isStepUpHandled } from '@/api/client';
import { cn } from '@/utils/cn';
import { siteHref } from '@/utils/links';
import { VerificationBadge } from '@/components/dns/DnsBadges';
import { Card, ForceHttpsIcon, TlsBadge, inputCls, labelCls, selectCls, useHostingEvents } from './hostingUi';
import { AddDomainInline } from './DomainCreateModal';
import { useDomainDrawerEvents, type DomainDrawerEvent } from './DomainDrawer';

// ─────────────────────────────────────────────────────────────────────────────
// The ONE route editor (coherence plan D3): the routes of a domain (its
// drawer: the site is chosen) or of a site (its Domains tab: the domain is
// chosen) — add, edit, delete, one family of i18n keys (domains.routes.*).
// Longest prefix first, the order the edge matches them in.
// ─────────────────────────────────────────────────────────────────────────────

type Target = { domain: Domain; site?: never } | { site: Site; domain?: never };

interface Draft { id: number | null; prefix: string; domainId: number | ''; siteId: number | ''; runtimeId: number | null }

export function RouteEditor({ manage, onChanged, emptyText, onOpenDomain, actions, ...target }: Target & {
  /** domains.manage on the account. */
  manage: boolean;
  /** A route was added, changed or removed (reload the owner). */
  onChanged: () => void;
  /** Domain mode: text when the domain has no route (e.g. it is served by a proxy host, not « 404 »). */
  emptyText?: ReactNode;
  /** Site mode: the domain of a route was clicked (opens its drawer in place). */
  onOpenDomain?: (domainId: number) => void;
  /** Extra buttons of the card header (e.g. « Add a domain »). */
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const domain = target.domain ?? null;
  const site = target.site ?? null;
  const accountId = (domain ?? site)!.accountId;

  // Site mode: the routes come from the site; domain mode: from the domain row.
  const [siteRoutes, setSiteRoutes] = useState<SiteRoute[]>([]);
  const [loaded, setLoaded] = useState(domain != null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  // The choices below are known (no « no domain / no site » hint before they are).
  const [choicesLoaded, setChoicesLoaded] = useState(false);
  const [runtimes, setRuntimes] = useState<Record<number, SiteRuntime[]>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSiteRoutes = useCallback(async () => {
    if (!site) return;
    try {
      setSiteRoutes(await sitesApi.routes(site.id));
      setLoadError(null);
    } catch (err) {
      setLoadError(siteErrorMessage(err, t));
    } finally {
      setLoaded(true);
    }
  }, [site?.id, t]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void loadSiteRoutes(); }, [loadSiteRoutes]);

  // Site mode: the domains of the account — choices of the form AND badges of
  // each route, so they follow the drawer, the certificates and the proofs.
  // Only the latest request lands (a slower earlier one does not overwrite it).
  const domainsSeq = useRef(0);
  const loadDomains = useCallback(async () => {
    if (domain) return;
    const seq = ++domainsSeq.current;
    try {
      const list = await domainsApi.list({ accountId });
      if (seq === domainsSeq.current) setDomains(list);
    } catch {
      // A failed reload keeps the known list (the first load leaves it empty).
    } finally {
      if (seq === domainsSeq.current) setChoicesLoaded(true);
    }
  }, [accountId, domain != null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Site mode: a domain (or this site) changed elsewhere — its routes may have too (domain mode: the drawer reloads the domain).
  useHostingEvent<HostingChangedPayload>(HostingSocketEvents.HOSTING_CHANGED, (p) => {
    if (!site) return;
    if (p.entity === 'domain' || (p.entity === 'site' && p.id === site.id)) void loadSiteRoutes();
    if (p.entity === 'domain') void loadDomains();
  });
  // Site mode: the TLS and ownership badges of the routes.
  useHostingEvents(
    [HostingSocketEvents.CERTIFICATE_UPDATED, HostingSocketEvents.DOMAIN_VERIFICATION_UPDATED],
    () => { void loadDomains(); },
    () => site != null,
  );
  // Site mode: what the domain drawer (opened in place) changed or deleted.
  useDomainDrawerEvents(useCallback((e: DomainDrawerEvent) => {
    if (domain) return;
    if (e.type === 'changed') setDomains((cur) => cur.map((x) => (x.id === e.domain.id ? e.domain : x)));
    else {
      setDomains((cur) => cur.filter((x) => x.id !== e.id));
      setDraft((cur) => (cur && cur.id == null && cur.domainId === e.id ? { ...cur, domainId: '' } : cur));
      void loadSiteRoutes();
    }
  }, [domain != null, loadSiteRoutes])); // eslint-disable-line react-hooks/exhaustive-deps

  // Choices of the form: the sites (domain mode) or the domains (site mode) of the account.
  useEffect(() => {
    if (!domain) {
      setChoicesLoaded(false);
      void loadDomains();
      return;
    }
    if (!manage) return;
    let cancelled = false;
    setChoicesLoaded(false);
    sitesApi.list({ accountId })
      .then((l) => { if (!cancelled) setSites(l); })
      .catch(() => { if (!cancelled) setSites([]); })
      .finally(() => { if (!cancelled) setChoicesLoaded(true); });
    return () => { cancelled = true; };
  }, [accountId, manage, domain != null, loadDomains]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sites whose runtimes were requested (in flight or loaded): one request per site.
  const requestedRuntimes = useRef(new Set<number>());
  const loadRuntimes = useCallback((siteId: number) => {
    if (requestedRuntimes.current.has(siteId)) return;
    requestedRuntimes.current.add(siteId);
    sitesApi.runtimes(siteId)
      .then((list) => setRuntimes((cur) => ({ ...cur, [siteId]: list })))
      .catch(() => setRuntimes((cur) => ({ ...cur, [siteId]: [] })));
  }, []);
  const draftSiteId = site ? site.id : draft?.siteId ?? '';
  useEffect(() => { if (draftSiteId !== '' && (draft || site)) loadRuntimes(draftSiteId); }, [draftSiteId, draft != null, loadRuntimes]); // eslint-disable-line react-hooks/exhaustive-deps

  const routes = useMemo(() => [...(domain ? domain.routes : siteRoutes)].sort((a, b) => (
    a.domainName.localeCompare(b.domainName) || b.pathPrefix.length - a.pathPrefix.length || a.pathPrefix.localeCompare(b.pathPrefix)
  )), [domain, siteRoutes]);

  const normalizedPrefix = draft ? normalizePathPrefix(draft.prefix) : null;
  const draftSite = site ?? sites.find((s) => s.id === draft?.siteId) ?? null;
  const ready = draft != null && normalizedPrefix != null && (domain ? draft.siteId !== '' : draft.domainId !== '');

  const startAdd = () => {
    setError(null);
    setDraft({
      id: null,
      prefix: domain && domain.routes.some((r) => r.pathPrefix === '/') ? '' : '/',
      domainId: domain ? domain.id : (domains.length === 1 ? domains[0].id : ''),
      siteId: site ? site.id : (sites.length === 1 ? sites[0].id : ''),
      runtimeId: null,
    });
  };
  const startEdit = (r: SiteRoute) => { setError(null); setDraft({ id: r.id, prefix: r.pathPrefix, domainId: r.domainId, siteId: r.siteId, runtimeId: r.runtimeId }); };

  const changed = () => {
    onChanged();
    if (site) void loadSiteRoutes();
  };

  const save = async () => {
    if (!draft || !ready || !normalizedPrefix) return;
    setSaving(true);
    setError(null);
    try {
      const input = { pathPrefix: normalizedPrefix, siteId: draft.siteId as number, runtimeId: draft.runtimeId };
      const domainId = draft.domainId as number;
      if (draft.id == null) await domainsApi.addRoute(domainId, input);
      else await domainsApi.updateRoute(domainId, draft.id, input);
      toast.success(t('domains.routes.saved') || 'Route saved');
      setDraft(null);
      changed();
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setError(siteErrorMessage(err, t, t('domains.routes.saveFailed') || 'Failed to save the route'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r: SiteRoute) => {
    if (!(await confirm({
      message: t('domains.routes.deleteConfirmAddress', { route: `${r.domainName}${r.pathPrefix}`, defaultValue: 'Remove the route {{route}}? This address will no longer serve the site.' }),
      danger: true,
    }))) return;
    try {
      await domainsApi.deleteRoute(r.domainId, r.id);
      toast.success(t('domains.routes.deleted') || 'Route removed');
      changed();
    } catch (err) {
      toastSiteError(err, t, t('domains.routes.deleteFailed') || 'Failed to remove the route');
    }
  };

  const runtimeOptions = draftSite ? runtimes[draftSite.id] ?? [] : [];
  const domainById = useMemo(() => new Map(domains.map((d) => [d.id, d])), [domains]);
  const editor = draft && (
    <div className="space-y-2 rounded-lg bg-bg-primary p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {site && (
          <div>
            <label className={labelCls} htmlFor="route-domain">{t('domains.routes.domain') || 'Domain'}</label>
            {/* An existing route stays on its domain (the server updates it under that domain only). */}
            <select id="route-domain" value={draft.domainId} disabled={draft.id != null} onChange={(e) => setDraft({ ...draft, domainId: e.target.value ? Number(e.target.value) : '' })} className={selectCls}>
              <option value="">{t('domains.routes.chooseDomain') || 'Choose a domain…'}</option>
              {domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
        )}
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
            className={cn(inputCls, 'font-mono', draft.prefix && !normalizedPrefix && 'ring-2 ring-red-400/60')}
          />
        </div>
        {domain && (
          <div>
            <label className={labelCls} htmlFor="route-site">{t('domains.routes.site') || 'Site'}</label>
            <select id="route-site" value={draft.siteId} onChange={(e) => setDraft({ ...draft, siteId: e.target.value ? Number(e.target.value) : '', runtimeId: null })} className={selectCls}>
              <option value="">{t('domains.routes.chooseSite') || 'Choose a site…'}</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.slug})</option>)}
            </select>
          </div>
        )}
        <div>
          <label className={labelCls} htmlFor="route-runtime">{t('domains.routes.runtime') || 'Runtime'}</label>
          <select
            id="route-runtime"
            value={draft.runtimeId ?? ''}
            disabled={!draftSite}
            onChange={(e) => setDraft({ ...draft, runtimeId: e.target.value ? Number(e.target.value) : null })}
            className={selectCls}
          >
            <option value="">{t('domains.routes.primary') || 'primary'}{draftSite ? ` (${draftSite.base})` : ''}</option>
            {runtimeOptions.map((rt) => (
              <option key={rt.id} value={rt.id}>{t('domains.routes.secondary') || 'secondary'} — {rt.base}</option>
            ))}
          </select>
        </div>
      </div>
      {draft.prefix && !normalizedPrefix && (
        <p className="text-xs text-red-400">{t('domains.routes.prefixInvalid') || 'A prefix is "/" or "/path/" (letters, digits, . _ @ + - only).'}</p>
      )}
      {normalizedPrefix && normalizedPrefix !== draft.prefix && (
        <p className="font-mono text-xs text-text-muted">{t('domains.routes.normalized', { prefix: normalizedPrefix, defaultValue: 'Saved as {{prefix}}' })}</p>
      )}
      {error && <p className="whitespace-pre-line text-xs text-red-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setDraft(null)}><X size={13} className="mr-1" />{t('common.cancel') || 'Cancel'}</Button>
        <Button size="sm" loading={saving} disabled={!ready} onClick={() => { void save(); }}>
          <Check size={13} className="mr-1" />{t('common.save') || 'Save'}
        </Button>
      </div>
    </div>
  );

  // Nothing to route with (no site in the account / no domain): the add button stays off.
  const noChoice = !choicesLoaded || (domain ? sites.length === 0 : domains.length === 0);
  const runtimeCell = (r: SiteRoute) => (r.runtimeId == null
    ? <Pill tone="accent" className="text-[10px] uppercase">{t('domains.routes.primary') || 'primary'}</Pill>
    : r.runtimeBase ? <BaseBadge base={r.runtimeBase} compact /> : <Pill>#{r.runtimeId}</Pill>);

  return (
    <Card
      title={t('domains.routes.title') || 'Routes'}
      icon={<RouteIcon size={14} className="text-accent" />}
      actions={(manage && !draft) || actions ? (
        <>
          {actions}
          {manage && !draft && (
            <Button size="sm" variant="secondary" onClick={startAdd} disabled={noChoice}>
              <Plus size={13} className="mr-1" />{t('domains.routes.add') || 'Add a route'}
            </Button>
          )}
        </>
      ) : undefined}
    >
      <p className="mb-3 text-xs text-text-muted">
        {domain
          ? (t('domains.routes.hint') || 'Each path prefix of the domain is served by a site (or one of its secondary runtimes). The longest matching prefix wins: /shop/ beats /.')
          : (t('domains.routes.siteHint') || 'A route sends a domain + path prefix to this site (or one of its secondary runtimes). When several prefixes match a request, the longest one wins.')}
      </p>
      {!loaded ? (
        <p className="text-xs text-text-muted">{t('common.loading') || 'Loading...'}</p>
      ) : loadError ? (
        <p className="text-xs text-red-400">{loadError}</p>
      ) : routes.length === 0 && !draft ? (
        <p className="text-xs text-text-muted">
          {domain
            ? (sites.length === 0 && manage && choicesLoaded
              ? (t('domains.routes.noSite') || 'The account has no site yet: create a site, then route the domain to it.')
              : (emptyText ?? (t('domains.routes.empty') || 'No route: the domain answers 404.')))
            : (t('domains.routes.siteEmpty') || 'No domain points to this site yet.')}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {routes.map((r) => (draft?.id === r.id ? (
            <li key={r.id} className="py-2">{editor}</li>
          ) : (
            <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
              {domain ? (
                <>
                  <span className="w-28 shrink-0 truncate font-mono text-sm text-accent">{r.pathPrefix}</span>
                  <span className="min-w-0 flex-1 text-sm text-text-primary">
                    <Link to={siteHref(r.siteId)} className="hover:text-accent">{r.siteName}</Link>
                  </span>
                </>
              ) : (
                <span className="inline-flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                  {onOpenDomain ? (
                    <button type="button" onClick={() => onOpenDomain(r.domainId)} className="break-all text-left font-mono text-sm text-text-primary hover:text-accent" title={t('domains.routes.openDomain') || 'Open the domain'}>
                      {r.domainName}<span className="text-accent">{r.pathPrefix}</span>
                    </button>
                  ) : (
                    <span className="break-all font-mono text-sm text-text-primary">{r.domainName}<span className="text-accent">{r.pathPrefix}</span></span>
                  )}
                  <a href={`https://${r.domainName}${r.pathPrefix}`} target="_blank" rel="noopener noreferrer" className="text-text-muted hover:text-accent" aria-label={t('domains.routes.visit') || 'Visit'}>
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                  {domainById.get(r.domainId) && (
                    <>
                      <VerificationBadge verification={domainById.get(r.domainId)!.verification} />
                      <TlsBadge tlsMode={domainById.get(r.domainId)!.tlsMode} certificate={domainById.get(r.domainId)!.certificate} />
                      {domainById.get(r.domainId)!.forceHttps && <ForceHttpsIcon on />}
                    </>
                  )}
                </span>
              )}
              {runtimeCell(r)}
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
      {/* The site tab passes its own « Add a domain » (routed to the site) in `actions`: no second path here. */}
      {manage && site && !actions && choicesLoaded && domains.length === 0 && !draft && (
        <p className="mt-3 text-xs text-text-muted">
          {t('domains.routes.noDomain') || 'This account has no domain yet.'}{' '}
          {/* Added in place (account preset), then chosen in the route form. */}
          <AddDomainInline
            accountId={accountId}
            onCreated={(d) => {
              setDomains((cur) => [...cur, d]);
              // The create form may already route it to this site; else the route form opens on it.
              changed();
              if (site) { setError(null); setDraft({ id: null, prefix: '/', domainId: d.id, siteId: site.id, runtimeId: null }); }
            }}
          />
        </p>
      )}
    </Card>
  );
}
