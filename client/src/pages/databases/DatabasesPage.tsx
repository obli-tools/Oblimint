import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Database, Plus, RefreshCw, Search, Server } from 'lucide-react';
import { HostingSocketEvents, type DbCatalog, type DbDatabaseListItem, type DbInstance } from '@oblimint/shared';
import { databasesApi } from '@/api/databases.api';
import { useHostingMe } from '@/store/hostingStore';
import { useTenantStore } from '@/store/tenantStore';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { AccountScopeBar, useAccountScope } from '@/components/common/AccountScope';
import { EmptyState, headerAccentBtnCls, headerBtnCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { DbInstanceCreateModal, DbPlanLimits } from '@/components/databases/DbInstanceCreateModal';
import { DbInstanceList } from '@/components/databases/DbInstanceList';
import { DbDatabaseList } from '@/components/databases/DbDatabaseList';
import { dbErrorMessage } from '@/components/databases/dbFormat';
import { DB_SITE_FILTER_NONE, matchesSiteFilter, normalizeSiteFilter, sitesOfList } from '@/components/databases/dbSites';
import { SettingsLink } from '@/components/common/SettingsLink';

type View = 'instances' | 'databases';
/** ?site= of the databases view: a site id, or 'none' = shared across the account (no owner). */
const NO_OWNER = DB_SITE_FILTER_NONE;

/**
 * /databases — instances of the visible accounts (account scope: ?account=<id>, god view ?tenants=);
 * ?view=databases: every database with its site(s), filterable by site (?site=<id>|none).
 */
export function DatabasesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can } = useHostingMe();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const scope = useAccountScope();
  const { accounts, tenantId } = scope;
  const accountFilter = scope.accountParam;
  const view: View = scope.params.get('view') === 'databases' ? 'databases' : 'instances';
  const siteFilter = normalizeSiteFilter(scope.params.get('site'));

  const [instances, setInstances] = useState<DbInstance[]>([]);
  const [databases, setDatabases] = useState<DbDatabaseListItem[] | null>(null);
  const [catalog, setCatalog] = useState<DbCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dbError, setDbError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  const filters = useMemo(() => ({ ...(accountFilter ? { accountId: accountFilter } : {}), ...(tenantId ? { tenantId } : {}) }), [accountFilter, tenantId]);
  const load = useCallback(async () => {
    try {
      setInstances(await databasesApi.listInstances(filters));
      setLoadError(null);
    } catch (err) {
      setInstances([]);
      setLoadError(dbErrorMessage(t, err, t('databases.loadFailed') || 'Failed to load the database instances'));
    } finally {
      setLoading(false);
    }
  }, [t, filters]);
  const loadDatabases = useCallback(async () => {
    try {
      setDatabases(await databasesApi.listDatabases(filters));
      setDbError(null);
    } catch (err) {
      setDatabases([]);
      setDbError(dbErrorMessage(t, err, t('databases.sites.listFailed') || 'Failed to load the databases'));
    }
  }, [t, filters]);
  const reload = () => { void load(); if (view === 'databases') void loadDatabases(); };

  useEffect(() => { setLoading(true); void load(); }, [load, currentTenantId]);
  useEffect(() => { if (view === 'databases') { setDatabases(null); void loadDatabases(); } }, [view, loadDatabases, currentTenantId]);
  // Plan limits are per account: shown once one account is selected (or the caller sees only one).
  // Another account / tenant: a site of the previous one would filter everything out.
  // Not on the first render, nor when the same navigation also sets ?site= (a deep
  // link ?account=&site= keeps its site).
  const scopeKey = `${accountFilter ?? ''}|${tenantId ?? ''}|${currentTenantId ?? ''}`;
  const rawSite = scope.params.get('site');
  const prevScope = useRef({ key: scopeKey, site: rawSite });
  const { update: updateScope } = scope;
  useEffect(() => {
    const prev = prevScope.current;
    prevScope.current = { key: scopeKey, site: rawSite };
    if (prev.key !== scopeKey && rawSite && rawSite === prev.site) updateScope({ site: null });
  }, [scopeKey, rawSite, updateScope]);

  const limitsAccount = accountFilter ?? (accounts.length === 1 ? accounts[0].id : null);
  useEffect(() => {
    if (limitsAccount == null) { setCatalog(null); return; }
    let cancelled = false;
    databasesApi.catalog(limitsAccount).then((c) => { if (!cancelled) setCatalog(c); }).catch(() => { if (!cancelled) setCatalog(null); });
    return () => { cancelled = true; };
  }, [limitsAccount]);
  useHostingEvents([HostingSocketEvents.DB_INSTANCE_UPDATED, HostingSocketEvents.HOSTING_CHANGED], reload, (e, p) => (
    e === HostingSocketEvents.DB_INSTANCE_UPDATED || ['dbInstance', 'account', 'site'].includes(String((p as { entity?: string } | null)?.entity))
  ));

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return instances;
    return instances.filter((i) => i.name.includes(q) || i.accountUsername.toLowerCase().includes(q) || i.engine.includes(q));
  }, [instances, search]);

  // Site filter: the sites the listed databases belong to (owner or shared).
  const siteOptions = useMemo(() => sitesOfList(databases ?? []), [databases]);
  const filteredDbs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (databases ?? []).filter((d) => {
      if (!matchesSiteFilter(d, siteFilter)) return false;
      if (!q) return true;
      return d.name.toLowerCase().includes(q) || d.instanceName.includes(q) || d.accountUsername.toLowerCase().includes(q)
        || [d.ownerSite, ...d.sharedSites].some((s) => !!s && s.name.toLowerCase().includes(q));
    });
  }, [databases, search, siteFilter]);

  const canCreate = can('databases.manage');
  const instanceCount = limitsAccount != null ? instances.filter((i) => i.accountId === limitsAccount).length : undefined;
  const views: SegmentedTab<View>[] = [
    { id: 'instances', label: t('databases.views.instances') || 'Servers', icon: <Server size={15} /> },
    { id: 'databases', label: t('databases.views.databases') || 'Databases & sites', icon: <Database size={15} /> },
  ];

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('nav.databases') || 'Databases'}</h1>
        <span className="text-xs font-mono tracking-wider text-text-muted">
          {view === 'databases'
            ? t('databases.sites.dbCount', { count: databases?.length ?? 0, defaultValue: '{{count}} database(s)' })
            : t('databases.count', { count: instances.length, defaultValue: '{{count}} instance(s)' })}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <SettingsLink anchor="settings-dbadmin" />
          <button onClick={reload} className={headerBtnCls}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
          {canCreate && (
            <button onClick={() => setCreating(true)} className={headerAccentBtnCls}><Plus size={14} />{t('databases.create') || 'New instance'}</button>
          )}
        </div>
      </div>

      <SegmentedTabs<View>
        tabs={views}
        value={view}
        onChange={(v) => scope.update({ view: v === 'instances' ? null : v, site: null })}
        ariaLabel={t('nav.databases') || 'Databases'}
        fill={false}
      />

      <AccountScopeBar scope={scope}>
        {view === 'databases' && (
          <select
            aria-label={t('databases.sites.filterLabel') || 'Filter by site'}
            value={siteFilter ?? ''}
            onChange={(e) => scope.update({ site: e.target.value || null })}
            className="w-full rounded-md border border-bg-tertiary bg-bg-secondary px-3 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none coarse:min-h-10 sm:w-56"
          >
            <option value="">{t('databases.sites.filterAll') || 'All sites'}</option>
            <option value={NO_OWNER}>{t('databases.sites.filterNone') || 'Account (unattached)'}</option>
            {siteOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            {siteFilter && siteFilter !== NO_OWNER && !siteOptions.some((s) => String(s.id) === siteFilter) && (
              <option value={siteFilter}>{t('databases.sites.filterSiteId', { id: siteFilter, defaultValue: 'Site #{{id}}' })}</option>
            )}
          </select>
        )}
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-text-muted" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={view === 'databases' ? (t('databases.sites.searchPlaceholder') || 'Search a database, a site…') : (t('databases.searchPlaceholder') || 'Search an instance…')}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            className="w-full rounded-md border border-bg-tertiary bg-bg-secondary py-1.5 pl-8 pr-3 text-sm text-text-primary focus:border-accent focus:outline-none coarse:min-h-10"
          />
        </div>
      </AccountScopeBar>

      {catalog && <DbPlanLimits catalog={catalog} instanceCount={instanceCount} />}

      {view === 'databases' ? (
        databases === null ? (
          <div className="flex justify-center py-12"><LoadingSpinner /></div>
        ) : dbError ? (
          <EmptyState icon={<AlertTriangle />} text={dbError} />
        ) : filteredDbs.length === 0 ? (
          <EmptyState icon={<Database />} text={search || siteFilter ? (t('common.noMatch') || 'No match') : (t('databases.db.empty') || 'No database yet.')} />
        ) : (
          <DbDatabaseList databases={filteredDbs} showTenant={scope.showTenant} onChanged={() => { void loadDatabases(); }} />
        )
      ) : loading ? (
        <div className="flex justify-center py-12"><LoadingSpinner /></div>
      ) : loadError ? (
        <EmptyState icon={<AlertTriangle />} text={loadError} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Database />}
          text={search ? (t('common.noMatch') || 'No match') : (t('databases.empty') || 'No database instance yet.')}
          action={canCreate && !search ? <button onClick={() => setCreating(true)} className={headerAccentBtnCls}><Plus size={14} />{t('databases.create') || 'New instance'}</button> : undefined}
        />
      ) : (
        <DbInstanceList instances={filtered} showTenant={scope.showTenant} />
      )}

      <DbInstanceCreateModal
        open={creating}
        accountId={accountFilter ?? undefined}
        onClose={() => setCreating(false)}
        onCreated={(i) => {
          setCreating(false);
          toast.success(t('databases.created', { name: i.name, defaultValue: 'Instance {{name}} created' }));
          navigate(`/databases/${i.id}`);
        }}
      />
    </PageContainer>
  );
}
