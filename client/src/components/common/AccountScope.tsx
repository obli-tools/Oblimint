import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import type { HostingAccount } from '@oblimint/shared';
import { accountsApi } from '@/api/accounts.api';
import { useTenantStore } from '@/store/tenantStore';
import { useIsMasterTenant } from '@/hooks/useIsMasterTenant';
import { useTenantFilter } from '@/hooks/useTenantFilter';
import { TenantFilterChips } from '@/components/common/TenantFilterChips';
import { selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';

// ─────────────────────────────────────────────────────────────────────────────
// The ONE account scope of the cross-account pages (coherence plan C1, P2):
// `?account=<id>` + god-view single workspace `?tenants=<id>`, the visible
// hosting accounts, a URL updater applying several keys in one navigation.
// The account chosen is kept for the session (per workspace) and put back on
// the sidebar links of the scoped pages; an account that is not (or no
// longer) visible is ignored.
// ─────────────────────────────────────────────────────────────────────────────

const MEMORY_KEY = 'oblimint.scope';

interface ScopeMemory {
  tenantId: number | null;
  accountId: number | null;
  remember: (tenantId: number | null, accountId: number | null) => void;
}

function readMemory(): { tenantId: number | null; accountId: number | null } {
  try {
    const raw = JSON.parse(sessionStorage.getItem(MEMORY_KEY) ?? 'null') as { tenantId?: unknown; accountId?: unknown } | null;
    const accountId = typeof raw?.accountId === 'number' && raw.accountId > 0 ? raw.accountId : null;
    return { tenantId: typeof raw?.tenantId === 'number' ? raw.tenantId : null, accountId };
  } catch {
    return { tenantId: null, accountId: null };
  }
}

/** Account remembered for the session (sidebar links of the scoped pages). */
export const useScopeMemory = create<ScopeMemory>((set) => ({
  ...readMemory(),
  remember: (tenantId, accountId) => {
    try { sessionStorage.setItem(MEMORY_KEY, JSON.stringify({ tenantId, accountId })); } catch { /* private mode */ }
    set({ tenantId, accountId });
  },
}));

/** The remembered account of the current workspace (null = none, or another workspace's). */
export function useRememberedAccount(): number | null {
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const tenantId = useScopeMemory((s) => s.tenantId);
  const accountId = useScopeMemory((s) => s.accountId);
  return accountId != null && tenantId === currentTenantId ? accountId : null;
}

/** URL params with several keys changed at once (null deletes). */
export function patchSearchParams(prev: URLSearchParams, patch: Record<string, string | null>): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) next.delete(k); else next.set(k, v);
  }
  return next;
}

/** God view, one workspace at a time: keeps the chip just added, else the first left. */
function pickOneTenant(current: ReadonlySet<number>, next: ReadonlySet<number>): number | null {
  const added = [...next].filter((x) => !current.has(x));
  if (added.length > 0) return added[added.length - 1];
  const rest = [...next];
  return rest.length > 0 ? rest[0] : null;
}

/** Label of an account in a selector: primary domain (else user name), then the user name / display name. */
export function accountOptionLabel(a: HostingAccount): string {
  const head = a.primaryDomain || a.username;
  const parts = [head];
  if (a.primaryDomain) parts.push(a.username);
  if (a.displayName && a.displayName !== head) parts.push(a.displayName);
  return parts.join(' — ');
}

export interface AccountScopeOptions {
  /** Only these accounts are offered (e.g. the ones whose files the caller manages). Keep it stable (useCallback). */
  accountFilter?: (a: HostingAccount) => boolean;
  /** URL key of the workspace chips (default `tenants`). */
  tenantParam?: string;
  /**
   * Keep the URL account for the session (sidebar links). False on a page that puts an
   * account in the URL by itself (Files picks one): that pick, or an account its filter
   * drops, must never change the scope of the other pages.
   */
  remember?: boolean;
}

export interface AccountScope {
  isMaster: boolean;
  /** God view: the single workspace applied to the lists (undefined = current tenant). */
  tenantId: number | undefined;
  /** God view over every workspace: the lists show a workspace badge. */
  showTenant: boolean;
  tenantFilter: ReturnType<typeof useTenantFilter>;
  accounts: HostingAccount[];
  accountsLoaded: boolean;
  /** `?account=` as given, while it is (or may be) visible (null = every account). */
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

export function useAccountScope(options: AccountScopeOptions = {}): AccountScope {
  const { accountFilter, tenantParam = 'tenants', remember: keepInMemory = true } = options;
  const isMaster = useIsMasterTenant();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const tenantFilter = useTenantFilter(tenantParam);
  const tenantId = isMaster && tenantFilter.ids.length > 0 ? tenantFilter.ids[0] : undefined;
  const [params, setParams] = useSearchParams();
  const rawAccount = Number(params.get('account')) || null;
  const remember = useScopeMemory((s) => s.remember);

  const [allAccounts, setAllAccounts] = useState<HostingAccount[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setAccountsLoaded(false);
    accountsApi.list(tenantId ? { tenantId } : {})
      .then((list) => { if (!cancelled) setAllAccounts(list); })
      .catch(() => { if (!cancelled) setAllAccounts([]); })
      .finally(() => { if (!cancelled) setAccountsLoaded(true); });
    return () => { cancelled = true; };
  }, [currentTenantId, tenantId]);

  const accounts = useMemo(() => (accountFilter ? allAccounts.filter(accountFilter) : allAccounts), [allAccounts, accountFilter]);
  // Before the list is known the URL is trusted (no flash of every account); afterwards an
  // account that is not visible is ignored.
  const accountParam = rawAccount != null && (!accountsLoaded || accounts.some((a) => a.id === rawAccount)) ? rawAccount : null;
  const accountId = accountParam ?? (accounts.length === 1 ? accounts[0].id : null);
  const selectedAccount = useMemo(() => accounts.find((a) => a.id === accountId) ?? null, [accounts, accountId]);

  // Remember a visible account chosen in the URL (sidebar links); a stale one is forgotten.
  useEffect(() => {
    if (!keepInMemory || !accountsLoaded || rawAccount == null) return;
    remember(currentTenantId, accountParam);
  }, [keepInMemory, accountsLoaded, rawAccount, accountParam, currentTenantId, remember]);

  const update = useCallback((patch: Record<string, string | null>) => {
    setParams((prev) => patchSearchParams(prev, patch), { replace: true });
  }, [setParams]);
  const setAccount = useCallback((id: number | null) => {
    if (id == null && keepInMemory) remember(currentTenantId, null);
    update({ account: id == null ? null : String(id) });
  }, [update, remember, currentTenantId, keepInMemory]);
  const setSingleTenant = (next: Set<number>) => {
    const picked = pickOneTenant(tenantFilter.value, next);
    // Changing the workspace also forgets the account (it belongs to the old one).
    update({ [tenantParam]: picked == null ? null : String(picked), account: null });
  };
  // A deep link `?tenants=1,2` is normalised to the workspace actually applied.
  const multiTenantUrl = isMaster && tenantFilter.ids.length > 1 ? tenantFilter.ids[0] : null;
  useEffect(() => {
    if (multiTenantUrl != null) update({ [tenantParam]: String(multiTenantUrl) });
  }, [multiTenantUrl, update, tenantParam]);

  return {
    isMaster, tenantId, showTenant: isMaster && tenantId == null, tenantFilter, accounts, accountsLoaded,
    accountParam, accountId, selectedAccount, params, update, setAccount, setSingleTenant,
  };
}

/** The account selector of a scope (shown when several accounts are visible). */
export function AccountScopeSelect({ scope, allowAll = true, value, onChange, className }: {
  scope: AccountScope;
  /** Offer "All accounts" (list pages); false = an account must be chosen. */
  allowAll?: boolean;
  /** Override of the shown value / change handler (default: `?account=`). */
  value?: number | null;
  onChange?: (id: number | null) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  if (scope.accounts.length <= 1) return null;
  const shown = value !== undefined ? value : scope.accountParam;
  return (
    <select
      aria-label={t('hostingCommon.scope.account') || 'Hosting account'}
      value={shown ?? ''}
      onChange={(e) => (onChange ?? scope.setAccount)(e.target.value ? Number(e.target.value) : null)}
      className={cn(selectCls, 'w-full bg-bg-secondary sm:w-64', className)}
    >
      <option value="" disabled={!allowAll}>
        {allowAll ? (t('hostingCommon.scope.allAccounts') || 'All accounts') : (t('hostingCommon.scope.pickAccount') || 'Choose an account…')}
      </option>
      {scope.accounts.map((a) => <option key={a.id} value={a.id}>{accountOptionLabel(a)}</option>)}
    </select>
  );
}

/** Workspace chips (god view) + account selector (when several accounts are visible) + extra content. */
export function AccountScopeBar({ scope, allowAll = true, value, onChange, selectClassName, children }: {
  scope: AccountScope;
  allowAll?: boolean;
  value?: number | null;
  onChange?: (id: number | null) => void;
  selectClassName?: string;
  /** Extra content on the selector line (filters, limits, counters). */
  children?: ReactNode;
}) {
  return (
    <>
      <TenantFilterChips value={scope.tenantFilter.value} onChange={scope.setSingleTenant} />
      {(scope.accounts.length > 1 || children) && (
        <div className="flex flex-wrap items-center gap-2">
          <AccountScopeSelect scope={scope} allowAll={allowAll} value={value} onChange={onChange} className={selectClassName} />
          {children}
        </div>
      )}
    </>
  );
}

/** Header subtitle of a scoped page: the account shown, else « all accounts ». */
export function scopeSubtitle(scope: AccountScope, allLabel: string): string {
  return scope.selectedAccount ? (scope.selectedAccount.primaryDomain || scope.selectedAccount.username) : allLabel;
}
