import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { HostingAccount } from '@oblimint/shared';
import { accountsApi } from '@/api/accounts.api';
import { useTenantStore } from '@/store/tenantStore';
import { TenantBadge } from '@/components/common/TenantBadge';
import { groupByAccount, type RowGroup, type TreeNode } from '@/components/common/GroupedTable';

// ─────────────────────────────────────────────────────────────────────────────
// Account groups of the lists: the group is titled by the account's PRIMARY
// DOMAIN (example.com), the system user name and the workspace follow. The
// accounts are loaded once per list (refreshed with the workspace).
// ─────────────────────────────────────────────────────────────────────────────

export function useAccountDirectory(): Map<number, HostingAccount> {
  const tenant = useTenantStore((s) => s.currentTenantId);
  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  useEffect(() => {
    let live = true;
    accountsApi.list().then((list) => { if (live) setAccounts(list); }).catch(() => { if (live) setAccounts([]); });
    return () => { live = false; };
  }, [tenant]);
  return useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
}

/** Group header of an account: primary domain (else user name) + user name link + workspace badge. */
export function accountGroupOf(
  directory: Map<number, HostingAccount>, accountId: number | null | undefined, username?: string | null,
): { id: number | string; name: string; meta?: ReactNode } | null {
  if (accountId == null) return null;
  const a = directory.get(accountId);
  const user = a?.username ?? username ?? `#${accountId}`;
  const title = a?.primaryDomain || user;
  return {
    id: accountId,
    name: title,
    meta: (
      <>
        {title !== user && (
          <Link to={`/accounts/${accountId}`} className="font-mono text-[11px] text-text-muted hover:text-accent">{user}</Link>
        )}
        {a && <TenantBadge tenantId={a.tenantId} />}
      </>
    ),
  };
}

/** Rows of several accounts → one group per account (see GroupedTable). */
export function groupRowsByAccount<T>(
  rows: T[], directory: Map<number, HostingAccount>,
  accountOf: (row: T) => { id: number | null | undefined; username?: string | null },
  nodesOf: (rows: T[]) => TreeNode<T>[],
  noAccountLabel?: string,
): RowGroup<T>[] {
  return groupByAccount(rows, (r) => { const a = accountOf(r); return accountGroupOf(directory, a.id, a.username); }, nodesOf, noAccountLabel);
}
