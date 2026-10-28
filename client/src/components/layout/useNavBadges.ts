import { useCallback, useEffect, useState } from 'react';
import { HostingSocketEvents } from '@oblimint/shared';
import { maintenanceApi, quarantineApi } from '@/api/maintenance.api';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { useHostingEvents } from '@/components/hosting/hostingUi';

// Pending-work counters of the sidebar entries (coherence plan C12), like
// Obliance's pending approvals on « Security »: kept per user + workspace at
// module level so a remount (drawer, collapse) shows the last count at once.

let maintenanceCache: { key: string; count: number } | null = null;

function cacheKey(): string {
  return `${useAuthStore.getState().user?.id ?? ''}:${useTenantStore.getState().currentTenantId ?? ''}`;
}

/**
 * Maintenance entry: windows waiting for a review + quarantined files of the
 * sites the caller sees (the server scopes both). 0 while unknown or refused.
 */
export function useMaintenanceBadge(enabled: boolean): number {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const tenantId = useTenantStore((s) => s.currentTenantId);
  const key = `${userId ?? ''}:${tenantId ?? ''}`;
  const [count, setCount] = useState(() => (maintenanceCache?.key === key ? maintenanceCache.count : 0));

  const load = useCallback(async () => {
    if (!enabled || userId == null) return;
    const k = cacheKey();
    const [p, q] = await Promise.allSettled([
      maintenanceApi.listAll({ status: 'pending_review', limit: 1 }),
      quarantineApi.summary(),
    ]);
    if (k !== cacheKey()) return;
    const next = (p.status === 'fulfilled' ? p.value.total : 0) + (q.status === 'fulfilled' ? q.value.quarantined : 0);
    maintenanceCache = { key: k, count: next };
    setCount(next);
  }, [enabled, userId]);

  useEffect(() => {
    setCount(maintenanceCache?.key === key ? maintenanceCache.count : 0);
    void load();
  }, [key, load]);
  useHostingEvents([HostingSocketEvents.WINDOW_UPDATED, HostingSocketEvents.QUARANTINE_UPDATED], () => { void load(); }, undefined, 1500);

  return enabled ? count : 0;
}
