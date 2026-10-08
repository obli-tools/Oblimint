import type { UserPermissions } from '@oblimint/shared';
import { db } from '../db';

function capsOf(raw: unknown): string[] {
  const caps = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(caps) ? caps.map(String) : [];
}

// Oblimint has no teams: a user's rights on a tenant are the capabilities of
// the permission set named by its membership role (user_tenants.role); a
// tenant admin ('admin') holds every capability; a platform admin
// (users.role='admin') bypasses every gate (checked by the callers).
export const permissionService = {
  async userHasTenantCapability(userId: number, tenantId: number, capability: string): Promise<boolean> {
    const ut = await db('user_tenants').where({ user_id: userId, tenant_id: tenantId }).first('role') as { role: string } | undefined;
    if (!ut) return false;
    if (ut.role === 'admin') return true;
    const set = await db('permission_sets').where({ slug: ut.role }).first('capabilities') as { capabilities: unknown } | undefined;
    return !!set && capsOf(set.capabilities).includes(capability);
  },

  /** Every capability of the user on the tenant (a tenant admin: the union of all sets). */
  async listUserTenantCapabilities(userId: number, tenantId: number): Promise<string[]> {
    const ut = await db('user_tenants').where({ user_id: userId, tenant_id: tenantId }).first('role') as { role: string } | undefined;
    if (!ut) return [];
    if (ut.role === 'admin') {
      const all = await db('permission_sets').select('capabilities') as Array<{ capabilities: unknown }>;
      const set = new Set<string>();
      for (const row of all) for (const c of capsOf(row.capabilities)) set.add(c);
      return [...set];
    }
    const set = await db('permission_sets').where({ slug: ut.role }).first('capabilities') as { capabilities: unknown } | undefined;
    return set ? capsOf(set.capabilities) : [];
  },

  /** Same shape as Obliance's UserPermissions (teams / permissions always empty). */
  async getUserPermissions(userId: number, isAdmin: boolean, tenantId?: number): Promise<UserPermissions> {
    if (isAdmin) return { canCreate: true, teams: [], permissions: {}, tenantCapabilities: [] };
    const tenantCapabilities = tenantId != null ? await this.listUserTenantCapabilities(userId, tenantId) : [];
    return { canCreate: tenantCapabilities.includes('accounts.manage'), teams: [], permissions: {}, tenantCapabilities };
  },
};
