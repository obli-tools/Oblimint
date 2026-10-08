import { useTenantStore } from '@/store/tenantStore';
import { useAuthStore } from '@/store/authStore';
import { MASTER_TENANT_ID, isMasterTenant } from '@oblimint/shared';

/** True when the active tenant is the master/Default tenant — the
 *  god view that aggregates every child tenant's data. UI code uses
 *  this to switch between strict tenant scoping and the cross-tenant
 *  view (tenant grouping in sidebar, "Tenant" column on lists,
 *  multi-tenant fan-out targets in create forms, etc).
 *
 *  The god view belongs to the PLATFORM ADMIN on the master tenant only
 *  (server: utils/globalView.ts, E13): any other account of the master
 *  tenant is limited to it like any tenant, so the cross-tenant UI is
 *  hidden for it.
 *
 *  Re-exports the constant so call sites that need both the boolean
 *  and the literal id (e.g. for query-param building) only import this. */
export function useIsMasterTenant(): boolean {
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const platformAdmin = useAuthStore((s) => s.user?.role === 'admin');
  return platformAdmin && isMasterTenant(currentTenantId);
}

export { MASTER_TENANT_ID };
