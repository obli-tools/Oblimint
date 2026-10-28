import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Database, Plus, RefreshCw, Search } from 'lucide-react';
import { HostingSocketEvents, type DbCatalog, type DbInstance } from '@oblimint/shared';
import { databasesApi } from '@/api/databases.api';
import { useHostingMe } from '@/store/hostingStore';
import { useTenantStore } from '@/store/tenantStore';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { AccountScopeBar, useAccountScope } from '@/components/common/AccountScope';
import { EmptyState, headerAccentBtnCls, headerBtnCls, useHostingEvents } from '@/components/hosting/hostingUi';
import { DbInstanceCreateModal, DbPlanLimits } from '@/components/databases/DbInstanceCreateModal';
import { DbInstanceList } from '@/components/databases/DbInstanceList';
import { dbErrorMessage } from '@/components/databases/dbFormat';
import { SettingsLink } from '@/components/common/SettingsLink';

/** /databases — instances of the visible accounts (account scope: ?account=<id>, god view ?tenants=). */
export function DatabasesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can } = useHostingMe();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const scope = useAccountScope();
  const { accounts, tenantId } = scope;
  const accountFilter = scope.accountParam;

  const [instances, setInstances] = useState<DbInstance[]>([]);
  const [catalog, setCatalog] = useState<DbCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setInstances(await databasesApi.listInstances({ ...(accountFilter ? { accountId: accountFilter } : {}), ...(tenantId ? { tenantId } : {}) }));
      setLoadError(null);
    } catch (err) {
      setInstances([]);
      setLoadError(dbErrorMessage(t, err, t('databases.loadFailed') || 'Failed to load the database instances'));
    } finally {
      setLoading(false);
    }
  }, [t, accountFilter, tenantId]);

  useEffect(() => { setLoading(true); void load(); }, [load, currentTenantId]);
  // Plan limits are per account: shown once one account is selected (or the caller sees only one).
  const limitsAccount = accountFilter ?? (accounts.length === 1 ? accounts[0].id : null);
  useEffect(() => {
    if (limitsAccount == null) { setCatalog(null); return; }
    let cancelled = false;
    databasesApi.catalog(limitsAccount).then((c) => { if (!cancelled) setCatalog(c); }).catch(() => { if (!cancelled) setCatalog(null); });
    return () => { cancelled = true; };
  }, [limitsAccount]);
  useHostingEvents([HostingSocketEvents.DB_INSTANCE_UPDATED, HostingSocketEvents.HOSTING_CHANGED], () => { void load(); }, (e, p) => (
    e === HostingSocketEvents.DB_INSTANCE_UPDATED || ['dbInstance', 'account'].includes(String((p as { entity?: string } | null)?.entity))
  ));

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return instances;
    return instances.filter((i) => i.name.includes(q) || i.accountUsername.toLowerCase().includes(q) || i.engine.includes(q));
  }, [instances, search]);

  const canCreate = can('databases.manage');
  const instanceCount = limitsAccount != null ? instances.filter((i) => i.accountId === limitsAccount).length : undefined;

  return (
    <PageContainer className="flex flex-col gap-5">
      <div className="flex items-baseline gap-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">{t('nav.databases') || 'Databases'}</h1>
        <span className="text-xs font-mono tracking-wider text-text-muted">
          {t('databases.count', { count: instances.length, defaultValue: '{{count}} instance(s)' })}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <SettingsLink anchor="settings-dbadmin" />
          <button onClick={() => { void load(); }} className={headerBtnCls}><RefreshCw size={14} />{t('common.refresh') || 'Refresh'}</button>
          {canCreate && (
            <button onClick={() => setCreating(true)} className={headerAccentBtnCls}><Plus size={14} />{t('databases.create') || 'New instance'}</button>
          )}
        </div>
      </div>

      <AccountScopeBar scope={scope}>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-text-muted" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('databases.searchPlaceholder') || 'Search an instance…'}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            className="w-full rounded-md border border-bg-tertiary bg-bg-secondary py-1.5 pl-8 pr-3 text-sm text-text-primary focus:border-accent focus:outline-none coarse:min-h-10"
          />
        </div>
      </AccountScopeBar>

      {catalog && <DbPlanLimits catalog={catalog} instanceCount={instanceCount} />}

      {loading ? (
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
