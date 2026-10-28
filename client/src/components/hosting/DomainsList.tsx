import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, ChevronRight, Globe, Plus, RefreshCw, Search } from 'lucide-react';
import type { Domain } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { domainsApi } from '@/api/domains.api';
import { useHostingMe } from '@/store/hostingStore';
import { useTenantStore } from '@/store/tenantStore';
import { GroupedTable, domainTree } from '@/components/common/GroupedTable';
import { groupRowsByAccount, useAccountDirectory } from '@/components/common/accountGroups';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { EmptyState } from '@/components/common/EmptyState';
import { VerificationBadge, ZoneKindBadge } from '@/components/dns/DnsBadges';
import { DomainClaimsCard } from '@/components/dns/DomainClaims';
import { ownershipErrorMessage } from '@/components/dns/dnsErrors';
import { DomainCreateModal, domainKindLabel } from './DomainCreateModal';
import { useDomainDrawerEvents, type DomainDrawerEvent } from './DomainDrawer';
import { ForceHttpsIcon, TlsBadge, headerAccentBtnCls, headerBtnCls, useHostingEvents } from './hostingUi';

/**
 * The ONE domain list (coherence plan D5): the Domains tab of an account and
 * the Domains & DNS page (every visible account, grouped by account). Search,
 * counters, claims in progress, the domain drawer (?domain=<id>, GlobalDomainDrawer) and the
 * creation in place (account preset when one is known).
 */
export function DomainsList({ accountId = null, tenantId, createDisabled = false, filters }: {
  /** Fixed account (its page) or the account of the scope; null = every visible account. */
  accountId?: number | null;
  /** God view, one workspace: the list is cut down to it (domains carry their workspace). */
  tenantId?: number;
  /** No creation (e.g. the account is being deleted). */
  createDisabled?: boolean;
  /** Extra filters before the search (account scope of the global page). */
  filters?: ReactNode;
}) {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const [params, setParams] = useSearchParams();
  const selectedId = Number(params.get('domain')) || null;

  const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [claimsKey, setClaimsKey] = useState(0);

  const load = useCallback(async () => {
    try {
      setDomains(await domainsApi.list(accountId != null ? { accountId } : {}));
      setLoadError(null);
    } catch (err) {
      setDomains([]);
      setLoadError(ownershipErrorMessage(t, err, t('domains.loadFailed') || 'Failed to load the domains'));
    } finally {
      setLoading(false);
    }
  }, [accountId, t]);

  useEffect(() => { setLoading(true); void load(); }, [load, currentTenantId]);
  useHostingEvents([
    HostingSocketEvents.HOSTING_CHANGED, HostingSocketEvents.CERTIFICATE_UPDATED,
    HostingSocketEvents.DOMAIN_VERIFICATION_UPDATED, HostingSocketEvents.DNS_ZONE_UPDATED,
  ], () => { void load(); });

  // The drawer (GlobalDomainDrawer, ?domain=) is the layout's: its changes come back here.
  useDomainDrawerEvents(useCallback((e: DomainDrawerEvent) => {
    if (e.type === 'changed') setDomains((cur) => cur.map((x) => (x.id === e.domain.id ? e.domain : x)));
    else { setDomains((cur) => cur.filter((x) => x.id !== e.id)); void load(); }
  }, [load]));

  const select = (id: number | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id == null) next.delete('domain'); else next.set('domain', String(id));
      return next;
    }, { replace: id == null });
  };

  const inScope = useMemo(() => (tenantId != null ? domains.filter((d) => d.tenantId === tenantId) : domains), [domains, tenantId]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return inScope;
    return inScope.filter((d) => d.name.includes(q) || d.accountUsername.toLowerCase().includes(q));
  }, [inScope, search]);

  const accountDir = useAccountDirectory();
  const canCreate = can('domains.manage', accountId ?? undefined) && !createDisabled;
  const pendingCount = inScope.filter((d) => d.verification?.status === 'pending').length;
  const createBtn = <button onClick={() => setCreating(true)} className={headerAccentBtnCls}><Plus size={14} />{t('domains.create') || 'Add a domain'}</button>;

  return (
    <div className="flex flex-col gap-4">
      {filters}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-text-muted" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={accountId != null ? (t('domains.searchOnePlaceholder') || 'Search a domain…') : (t('domains.searchPlaceholder') || 'Search a domain or an account…')}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            className="w-full rounded-md border border-bg-tertiary bg-bg-secondary py-1.5 pl-8 pr-3 text-sm text-text-primary focus:border-accent focus:outline-none coarse:min-h-10"
          />
        </div>
        <span className="text-xs font-mono tracking-wider text-text-muted">
          {t('domains.count', { count: inScope.length, defaultValue: '{{count}} domain(s)' })}
          {pendingCount > 0 && ` · ${t('domainOwnership.pendingCount', { count: pendingCount, defaultValue: '{{count}} to verify' })}`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => { void load(); }} className={headerBtnCls}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
          {canCreate && createBtn}
        </div>
      </div>

      {/* Claims started from the create modal below are followed here. */}
      <DomainClaimsCard accountId={accountId ?? undefined} refreshKey={claimsKey} onSucceeded={() => { void load(); }} />

      {loading ? (
        <div className="flex justify-center py-12"><LoadingSpinner /></div>
      ) : loadError ? (
        <EmptyState icon={<AlertTriangle />} text={loadError} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Globe />}
          text={search ? (t('common.noMatch') || 'No match')
            : accountId != null ? (t('accounts.domains.empty') || 'No domain in this account yet.')
              : (t('domains.empty') || 'No domain yet.')}
          action={canCreate && !search ? createBtn : undefined}
        />
      ) : (
        <GroupedTable<Domain>
          storageKey="domains"
          singleGroupFlat
          minWidth={900}
          defaultSort={{ column: 'name' }}
          selectedKey={selectedId}
          // example.com at the root of its account, shop.example.com below it.
          groups={accountId != null
            ? [{ key: 'all', label: '', sortLabel: '', nodes: domainTree(filtered, (d) => d.name, (d) => d.id) }]
            : groupRowsByAccount(filtered, accountDir, (d) => ({ id: d.accountId, username: d.accountUsername }), (rows) => domainTree(rows, (d) => d.name, (d) => d.id))}
          onRowClick={(d) => select(d.id)}
          renderCard={(d) => (
            <button type="button" onClick={() => select(d.id)} className="w-full rounded-xl bg-bg-secondary px-3 py-2.5 text-left hover:bg-bg-tertiary/30">
              <div className="flex items-center gap-2">
                <span className="min-w-0 truncate font-mono text-sm font-semibold text-text-primary">{d.name}</span>
                <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-text-muted" />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                <VerificationBadge verification={d.verification} />
                <TlsBadge tlsMode={d.tlsMode} certificate={d.certificate} />
                {d.forceHttps && <ForceHttpsIcon on />}
                <span>{domainKindLabel(t, d.kind)}</span>
                <span>{t('domains.routesCount', { count: d.routes.length, defaultValue: '{{count}} route(s)' })}</span>
              </div>
            </button>
          )}
          columns={[
            {
              id: 'name', header: t('domains.col.name') || 'Domain', sort: (d) => d.name,
              cell: (d) => (
                <>
                  <div className="whitespace-nowrap font-mono font-medium text-text-primary">{d.name}</div>
                  {(d.includeWww || d.wildcard) && (
                    <div className="font-mono text-[11px] text-text-muted">{[d.includeWww ? '+ www' : null, d.wildcard ? '+ *' : null].filter(Boolean).join(' ')}</div>
                  )}
                </>
              ),
            },
            { id: 'kind', header: t('domains.col.kind') || 'Kind', tdClassName: 'whitespace-nowrap text-text-secondary', sort: (d) => d.kind, cell: (d) => domainKindLabel(t, d.kind) },
            { id: 'ownership', header: t('domainOwnership.col') || 'Ownership', sort: (d) => d.verification?.status ?? '', cell: (d) => <VerificationBadge verification={d.verification} /> },
            {
              id: 'zone', header: t('dns.zone.label') || 'DNS zone', sort: (d) => d.zone?.name ?? '',
              cell: (d) => (d.zone ? (
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <Link to={`/dns/zones/${d.zone.id}`} onClick={(e) => e.stopPropagation()} className="font-mono text-xs text-text-secondary hover:text-accent">{d.zone.name}</Link>
                  <ZoneKindBadge kind={d.zone.kind} />
                </span>
              ) : <span className="text-text-muted">—</span>),
            },
            { id: 'routes', header: t('domains.col.routes') || 'Routes', thClassName: 'text-right', tdClassName: 'text-right font-mono tabular-nums', sort: (d) => d.routes.length, cell: (d) => d.routes.length },
            { id: 'tls', header: t('domains.col.tls') || 'TLS', sort: (d) => d.certificate?.status ?? d.tlsMode, cell: (d) => <TlsBadge tlsMode={d.tlsMode} certificate={d.certificate} /> },
            { id: 'https', header: t('domains.col.https') || 'HTTPS', sort: (d) => d.forceHttps, cell: (d) => <ForceHttpsIcon on={d.forceHttps} /> },
          ]}
        />
      )}

      <DomainCreateModal
        open={creating}
        accountId={accountId ?? undefined}
        onClose={() => setCreating(false)}
        onClaimCreated={() => setClaimsKey((n) => n + 1)}
        onCreated={(d) => {
          setCreating(false);
          toast.success(t('domains.created', { name: d.name, defaultValue: 'Domain {{name}} added' }));
          setDomains((cur) => [...cur, d]);
          select(d.id);
        }}
      />
    </div>
  );
}
