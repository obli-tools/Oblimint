import type { UserPermissions } from '@oblimint/shared';
import { db } from '../db';

function capsOf(raw: unknown): string[] {
  const caps = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(caps) ? caps.map(String) : [];
}

/** Permission set of client memberships (seeded by migration 002, empty and
 *  locked: permissionSet.service). */
export const CLIENT_MEMBERSHIP_ROLE = 'client';

/**
 * M12: a client login (users.kind = 'client') holds the 'client' role only,
 * and the 'client' role belongs to client logins only. Returns the refusal
 * text, or null when the pair is allowed.
 */
export function membershipRoleRefusal(kind: string | null | undefined, role: string): string | null {
  if (kind === 'client') return role === CLIENT_MEMBERSHIP_ROLE ? null : 'A client account can only hold the client role';
  return role === CLIENT_MEMBERSHIP_ROLE ? 'The client role is reserved for client accounts' : null;
}

/**
 * Membership role that carries tenant capabilities, or null. A client login
 * never holds a tenant capability (M12): its rights are per hosting account
 * (account_users), whatever its membership row or the 'client' set say.
 */
async function capabilityRole(userId: number, tenantId: number): Promise<string | null> {
  const ut = await db('user_tenants as ut')
    .join('users as u', 'u.id', 'ut.user_id')
    .where({ 'ut.user_id': userId, 'ut.tenant_id': tenantId })
    .first('ut.role', 'u.kind') as { role: string; kind: string } | undefined;
  if (!ut || ut.kind === 'client' || ut.role === CLIENT_MEMBERSHIP_ROLE) return null;
  return ut.role;
}

// Oblimint has no teams: a user's rights on a tenant are the capabilities of
// the permission set named by its membership role (user_tenants.role); a
// tenant admin ('admin') holds every capability; a platform admin
// (users.role='admin') bypasses every gate (checked by the callers); a client
// login holds none (capabilityRole).
export const permissionService = {
  async userHasTenantCapability(userId: number, tenantId: number, capability: string): Promise<boolean> {
    const role = await capabilityRole(userId, tenantId);
    if (!role) return false;
    if (role === 'admin') return true;
    const set = await db('permission_sets').where({ slug: role }).first('capabilities') as { capabilities: unknown } | undefined;
    return !!set && capsOf(set.capabilities).includes(capability);
  },

  /** Every capability of the user on the tenant (a tenant admin: the union of all sets). */
  async listUserTenantCapabilities(userId: number, tenantId: number): Promise<string[]> {
    const role = await capabilityRole(userId, tenantId);
    if (!role) return [];
    if (role === 'admin') {
      const all = await db('permission_sets').select('capabilities') as Array<{ capabilities: unknown }>;
      const set = new Set<string>();
      for (const row of all) for (const c of capsOf(row.capabilities)) set.add(c);
      return [...set];
    }
    const set = await db('permission_sets').where({ slug: role }).first('capabilities') as { capabilities: unknown } | undefined;
    return set ? capsOf(set.capabilities) : [];
  },

  /** Same shape as Obliance's UserPermissions (teams / permissions always empty). */
  async getUserPermissions(userId: number, isAdmin: boolean, tenantId?: number): Promise<UserPermissions> {
    if (isAdmin) return { canCreate: true, teams: [], permissions: {}, tenantCapabilities: [] };
    const tenantCapabilities = tenantId != null ? await this.listUserTenantCapabilities(userId, tenantId) : [];
    return { canCreate: tenantCapabilities.includes('accounts.manage'), teams: [], permissions: {}, tenantCapabilities };
  },
};
