import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { accountsApi } from '@/api/accounts.api';
import { accountAccessHref } from '@/utils/links';
import { useTenantStore } from '@/store/tenantStore';

/** Accounts fetched in parallel at most while indexing the memberships. */
const CONCURRENCY = 6;

/**
 * Opens the hosting account of a client user (users.kind = 'client') on its
 * Users tab, from the platform user list. The memberships are not part of the
 * user rows: they are indexed once (accounts × their client users) on the
 * first use, then reused while the workspace stays the same (a miss rebuilds
 * it once). A user of several accounts opens the first one.
 */
export function useOpenClientAccount() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [busyUserId, setBusyUserId] = useState<number | null>(null);
  const tenantId = useTenantStore((s) => s.currentTenantId);
  const index = useRef<{ tenantId: number | null; map: Map<number, Array<{ id: number; username: string }>> } | null>(null);

  const buildIndex = async () => {
    const accounts = await accountsApi.list();
    const map = new Map<number, Array<{ id: number; username: string }>>();
    let next = 0;
    const worker = async () => {
      while (next < accounts.length) {
        const a = accounts[next++];
        const users = await accountsApi.listUsers(a.id).catch(() => []);
        for (const u of users) {
          const list = map.get(u.userId) ?? [];
          list.push({ id: a.id, username: a.username });
          map.set(u.userId, list);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, accounts.length) }, worker));
    return map;
  };

  const open = useCallback(async (userId: number) => {
    setBusyUserId(userId);
    try {
      if (!index.current || index.current.tenantId !== tenantId) index.current = { tenantId, map: await buildIndex() };
      // A miss may be a membership added since the index was built: rebuild once.
      else if (!index.current.map.has(userId)) index.current = { tenantId, map: await buildIndex() };
      const found = (index.current.map.get(userId) ?? []).slice().sort((a, b) => a.username.localeCompare(b.username));
      if (found.length === 0) {
        toast.error(t('users.clientNoAccount') || 'This customer is attached to no hosting account visible in this workspace.');
        return;
      }
      if (found.length > 1) {
        toast(t('users.clientSeveralAccounts', { count: found.length, username: found[0].username, defaultValue: 'Member of {{count}} accounts: {{username}} is opened.' }));
      }
      navigate(accountAccessHref(found[0].id, 'users'));
    } catch {
      toast.error(t('users.clientAccountFailed') || 'Failed to find the account of this customer');
    } finally {
      setBusyUserId(null);
    }
  }, [navigate, t, tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  return { open, busyUserId };
}
