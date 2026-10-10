import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { HostingAccount } from '@oblimint/shared';
import { accountsApi } from '@/api/accounts.api';
import { useTenantStore } from '@/store/tenantStore';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { useTenantFilter } from '@/hooks/useTenantFilter';
import { TenantFilterChips } from '@/components/common/TenantFilterChips';
import { selectCls } from '@/components/hosting/hostingUi';
import { pickSingleTenant } from '@/components/mail/mailFormat';
import { cn } from '@/utils/cn';
import { patchParams } from './appsFormat';

export interface AccountScope {
  isMaster: boolean;
  /** God view: the single workspace applied to the lists (undefined = current tenant). */
  tenantId: number | undefined;
  tenantFilter: ReturnType<typeof useTenantFilter>;
  accounts: HostingAccount[];
  accountsLoaded: boolean;
  /** `?account=` as given (null = every account). */
  accountParam: number | null;
  /** Account worked on: `?account=`, or the only visible account. */
  accountId: number | null;
  selectedAccount: HostingAccount | null;
  params: URLSearchParams;
  /** Several URL keys in one navigation (null deletes). */
  update: (patch: Record<string, string | null>) => void;
  setAccount: (id: number | null) => void;
  setSingleTenant: (next: Set<number>) => void;
}

/**
 * Account scope of the P4b list pages, as the mail page (docs/P4b-PLAN.md §13):
 * god view = one workspace at a time (`?tenants=`), account selector
 * (`?account=`), a caller with a single account always works on it.
 */
export function useAccountScope(): AccountScope {
  const isMaster = useIsMasterTenant();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const tenantFilter = useTenantFilter();
  const tenantId = isMaster && tenantFilter.ids.length > 0 ? tenantFilter.ids[0] : undefined;
  const [params, setParams] = useSearchParams();
  const accountParam = Number(params.get('account')) || null;

  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setAccountsLoaded(false);
    accountsApi.list(tenantId ? { tenantId } : {})
      .then((list) => { if (!cancelled) setAccounts(list); })
      .catch(() => { if (!cancelled) setAccounts([]); })
      .finally(() => { if (!cancelled) setAccountsLoaded(true); });
    return () => { cancelled = true; };
  }, [currentTenantId, tenantId]);

  const accountId = accountParam ?? (accounts.length === 1 ? accounts[0].id : null);
  const selectedAccount = useMemo(() => accounts.find((a) => a.id === accountId) ?? null, [accounts, accountId]);

  const update = useCallback((patch: Record<string, string | null>) => {
    setParams((prev) => patchParams(prev, patch), { replace: true });
  }, [setParams]);
  const setAccount = useCallback((id: number | null) => update({ account: id == null ? null : String(id) }), [update]);
  const setSingleTenant = (next: Set<number>) => {
    const picked = pickSingleTenant(tenantFilter.value, next);
    update({ tenants: picked == null ? null : String(picked), account: null });
  };
  // A deep link `?tenants=1,2` is normalised to the workspace actually applied.
  const multiTenantUrl = isMaster && tenantFilter.ids.length > 1 ? tenantFilter.ids[0] : null;
  useEffect(() => {
    if (multiTenantUrl != null) update({ tenants: String(multiTenantUrl) });
  }, [multiTenantUrl, update]);

  return { isMaster, tenantId, tenantFilter, accounts, accountsLoaded, accountParam, accountId, selectedAccount, params, update, setAccount, setSingleTenant };
}

/** Workspace chips (god view) + account selector (when several accounts are visible). */
export function AccountScopeBar({ scope, allowAll = true, children }: {
  scope: AccountScope;
  /** Offer "All accounts" (list pages); false = an account must be chosen. */
  allowAll?: boolean;
  /** Extra content on the selector line (limits, counters). */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <>
      <TenantFilterChips value={scope.tenantFilter.value} onChange={scope.setSingleTenant} />
      {(scope.accounts.length > 1 || children) && (
        <div className="flex flex-wrap items-center gap-2">
          {scope.accounts.length > 1 && (
            <select
              aria-label={t('apps.scope.account') || 'Hosting account'}
              value={scope.accountParam ?? ''}
              onChange={(e) => scope.setAccount(e.target.value ? Number(e.target.value) : null)}
              className={cn(selectCls, 'w-full bg-bg-secondary sm:w-64')}
            >
              <option value="" disabled={!allowAll}>{allowAll ? (t('apps.scope.allAccounts') || 'All accounts') : (t('apps.scope.pickAccount') || 'Choose an account…')}</option>
              {scope.accounts.map((a) => <option key={a.id} value={a.id}>{a.username}{a.displayName ? ` — ${a.displayName}` : ''}</option>)}
            </select>
          )}
          {children}
        </div>
      )}
    </>
  );
}
