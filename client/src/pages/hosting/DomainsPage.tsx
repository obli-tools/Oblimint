import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, ChevronRight, FileStack, Globe, Network, Plus, RefreshCw, Search } from 'lucide-react';
import type { Domain } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { domainsApi } from '@/api/domains.api';
import { useHostingMe } from '@/store/hostingStore';
import { useTenantStore } from '@/store/tenantStore';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { TableScroll } from '@/components/common/TableScroll';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { TenantBadge } from '@/components/common/TenantBadge';
import { Drawer } from '@/components/common/Drawer';
import { DomainCreateModal, domainKindLabel } from '@/components/hosting/DomainCreateModal';
import { DomainPanel } from '@/components/hosting/DomainPanel';
import {
  EmptyState, ForceHttpsIcon, TlsBadge, headerAccentBtnCls, headerBtnCls, thCls, theadRowCls, useHostingEvents,
} from '@/components/hosting/hostingUi';
import { VerificationBadge, ZoneKindBadge } from '@/components/dns/DnsBadges';
import { DomainClaimsCard } from '@/components/dns/DomainClaims';
import { DnsZonesTab } from '@/components/dns/DnsZonesTab';
import { DnsTemplatesTab } from '@/components/dns/DnsTemplatesTab';
import { ownershipErrorMessage } from '@/components/dns/dnsErrors';

type Tab = 'domains' | 'zones' | 'templates';
const TAB_IDS: readonly Tab[] = ['domains', 'zones', 'templates'];

function isTab(v: string | null): v is Tab {
  return v !== null && (TAB_IDS as readonly string[]).includes(v);
}

/** Domains & DNS: domains (ownership, routes, TLS), zones, templates (staff) — tab in the URL (?tab=). */
export function DomainsPage() {
  const { t } = useTranslation();
  const { me, can } = useHostingMe();
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const showTemplates = me?.kind === 'staff' && can('dns.manage');
  const tab: Tab = isTab(tabParam) && (tabParam !== 'templates' || showTemplates) ? tabParam : 'domains';

  const setTab = (next: Tab) => {
    const p = new URLSearchParams();
    if (next !== 'domains') p.set('tab', next);
    setParams(p, { replace: true });
  };

  const tabs: SegmentedTab<Tab>[] = [
    { id: 'domains', label: t('dns.tabs.domains') || 'Domains', icon: <Globe size={16} /> },
    { id: 'zones', label: t('dns.tabs.zones') || 'DNS zones', icon: <Network size={16} /> },
    { id: 'templates', label: t('dns.tabs.templates') || 'Templates', icon: <FileStack size={16} />, hidden: !showTemplates },
  ];

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('dns.page.title') || 'Domains & DNS'}</h1>
      </div>
      <SegmentedTabs<Tab> tabs={tabs} value={tab} onChange={setTab} fill={false} ariaLabel={t('dns.page.title') || 'Domains & DNS'} />
      {tab === 'domains' && <DomainsTab />}
      {tab === 'zones' && <DnsZonesTab />}
      {tab === 'templates' && showTemplates && <DnsTemplatesTab />}
    </PageContainer>
  );
}

/** Domains of the visible accounts; the selected one opens in a drawer (?domain=<id>). */
function DomainsTab() {
  const { t } = useTranslation();
  const { can } = useHostingMe();
  const isMaster = useIsMasterTenant();
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
      setDomains(await domainsApi.list());
      setLoadError(null);
    } catch (err) {
      setDomains([]);
      setLoadError(ownershipErrorMessage(t, err, t('domains.loadFailed') || 'Failed to load the domains'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load, currentTenantId]);
  useHostingEvents([
    HostingSocketEvents.HOSTING_CHANGED, HostingSocketEvents.CERTIFICATE_UPDATED,
    HostingSocketEvents.DOMAIN_VERIFICATION_UPDATED, HostingSocketEvents.DNS_ZONE_UPDATED,
  ], () => { void load(); });

  const select = (id: number | null) => {
    const next = new URLSearchParams(params);
    if (id == null) next.delete('domain'); else next.set('domain', String(id));
    setParams(next, { replace: id == null });
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return domains;
    return domains.filter((d) => d.name.includes(q) || d.accountUsername.toLowerCase().includes(q));
  }, [domains, search]);

  const canCreate = can('domains.manage');
  const selected = domains.find((d) => d.id === selectedId) ?? null;
  const pendingCount = domains.filter((d) => d.verification?.status === 'pending').length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-text-muted" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('domains.searchPlaceholder') || 'Search a domain or an account…'}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            className="w-full rounded-md border border-bg-tertiary bg-bg-secondary py-1.5 pl-8 pr-3 text-sm text-text-primary focus:border-accent focus:outline-none coarse:min-h-10"
          />
        </div>
        <span className="text-xs font-mono tracking-wider text-text-muted">
          {t('domains.count', { count: domains.length, defaultValue: '{{count}} domain(s)' })}
          {pendingCount > 0 && ` · ${t('domainOwnership.pendingCount', { count: pendingCount, defaultValue: '{{count}} to verify' })}`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => { void load(); }} className={headerBtnCls}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
          {canCreate && (
            <button onClick={() => setCreating(true)} className={headerAccentBtnCls}><Plus size={14} />{t('domains.create') || 'Add a domain'}</button>
          )}
        </div>
      </div>

      <DomainClaimsCard refreshKey={claimsKey} onSucceeded={() => { void load(); }} />

      {loading ? (
        <div className="flex justify-center py-12"><LoadingSpinner /></div>
      ) : loadError ? (
        <EmptyState icon={<AlertTriangle />} text={loadError} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Globe />}
          text={search ? (t('common.noMatch') || 'No match') : (t('domains.empty') || 'No domain yet.')}
          action={canCreate && !search ? <button onClick={() => setCreating(true)} className={headerAccentBtnCls}><Plus size={14} />{t('domains.create') || 'Add a domain'}</button> : undefined}
        />
      ) : (
        <>
          {/* Phone: cards */}
          <ul className="space-y-2 md:hidden">
            {filtered.map((d) => (
              <li key={d.id}>
                <button type="button" onClick={() => select(d.id)} className="w-full rounded-xl bg-bg-secondary px-3 py-2.5 text-left hover:bg-bg-tertiary/30">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 truncate font-mono text-sm font-semibold text-text-primary">{d.name}</span>
                    <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-text-muted" />
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
                    <VerificationBadge verification={d.verification} />
                    <TlsBadge tlsMode={d.tlsMode} certificate={d.certificate} />
                    <span>{domainKindLabel(t, d.kind)}</span>
                    <span className="font-mono">{d.accountUsername}</span>
                    <span>{t('domains.routesCount', { count: d.routes.length, defaultValue: '{{count}} route(s)' })}</span>
                    {isMaster && <TenantBadge tenantId={d.tenantId} />}
                  </div>
                </button>
              </li>
            ))}
          </ul>

          <TableScroll className="hidden rounded-xl bg-bg-secondary md:block">
            <table className="w-full min-w-[980px] text-sm">
              <thead>
                <tr className={theadRowCls}>
                  <th className={thCls}>{t('domains.col.name') || 'Domain'}</th>
                  <th className={thCls}>{t('domains.col.account') || 'Account'}</th>
                  {isMaster && <th className={thCls}>{t('hostingCommon.tenant') || 'Workspace'}</th>}
                  <th className={thCls}>{t('domains.col.kind') || 'Kind'}</th>
                  <th className={thCls}>{t('domainOwnership.col') || 'Ownership'}</th>
                  <th className={thCls}>{t('dns.zone.label') || 'DNS zone'}</th>
                  <th className={`${thCls} text-right`}>{t('domains.col.routes') || 'Routes'}</th>
                  <th className={thCls}>{t('domains.col.tls') || 'TLS'}</th>
                  <th className={thCls}>{t('domains.col.https') || 'HTTPS'}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((d) => (
                  <tr key={d.id} onClick={() => select(d.id)} className={`cursor-pointer transition-colors hover:bg-bg-hover ${d.id === selectedId ? 'bg-bg-hover' : ''}`}>
                    <td className="px-4 py-3">
                      <div className="whitespace-nowrap font-mono font-medium text-text-primary">{d.name}</div>
                      {(d.includeWww || d.wildcard) && (
                        <div className="font-mono text-[11px] text-text-muted">
                          {[d.includeWww ? '+ www' : null, d.wildcard ? '+ *' : null].filter(Boolean).join(' ')}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Link to={`/accounts/${d.accountId}`} onClick={(e) => e.stopPropagation()} className="font-mono text-text-secondary hover:text-accent">{d.accountUsername}</Link>
                    </td>
                    {isMaster && <td className="px-4 py-3"><TenantBadge tenantId={d.tenantId} /></td>}
                    <td className="whitespace-nowrap px-4 py-3 text-text-secondary">{domainKindLabel(t, d.kind)}</td>
                    <td className="px-4 py-3"><VerificationBadge verification={d.verification} /></td>
                    <td className="px-4 py-3">
                      {d.zone ? (
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                          <Link to={`/dns/zones/${d.zone.id}`} onClick={(e) => e.stopPropagation()} className="font-mono text-xs text-text-secondary hover:text-accent">{d.zone.name}</Link>
                          <ZoneKindBadge kind={d.zone.kind} />
                        </span>
                      ) : <span className="text-text-muted">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">{d.routes.length}</td>
                    <td className="px-4 py-3"><TlsBadge tlsMode={d.tlsMode} certificate={d.certificate} /></td>
                    <td className="px-4 py-3"><ForceHttpsIcon on={d.forceHttps} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </>
      )}

      <Drawer
        open={selectedId != null}
        onClose={() => select(null)}
        side="right"
        size="lg"
        title={selected?.name ?? (t('domains.detailTitle') || 'Domain')}
        icon={<Globe size={16} className="shrink-0 text-accent" />}
        bodyClassName="p-4"
      >
        {selectedId != null && (
          <DomainPanel
            domainId={selectedId}
            onChanged={(d) => setDomains((cur) => cur.map((x) => (x.id === d.id ? d : x)))}
            onDeleted={() => { select(null); void load(); }}
          />
        )}
      </Drawer>

      <DomainCreateModal
        open={creating}
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
