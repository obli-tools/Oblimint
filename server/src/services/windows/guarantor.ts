import { db } from '../../db';
import { permissionService } from '../permission.service';
import { clientCapabilities } from '../hosting/rows';

// ─────────────────────────────────────────────────────────────────────────────
// "Guarantor" of an unattended publication path (site API token, scheduled
// window, adapter schedule): the user who created / last vouched for it must
// STILL be allowed to publish on the site when it fires — the same rights a
// session needs to open a window or start a run from the panel
// (releases.publish, and sites.manage that configures the path). A user
// deleted (created_by SET NULL), deactivated, detached from the account or
// stripped of a capability silently disarms every path he vouched for.
// OWNED BY MODULE `windows` (also used by adapters).
// ─────────────────────────────────────────────────────────────────────────────

export interface GuarantorTarget { tenantId: number; accountId: number }

/**
 * Does `userId` currently hold releases.publish AND sites.manage on the
 * account (client: both capabilities on that account of that tenant; staff:
 * platform admin, or the 'sites.manage' staff capability in the tenant)?
 * Never throws (false on any error: fail closed).
 */
export async function userCanPublish(userId: number | null | undefined, target: GuarantorTarget): Promise<boolean> {
  if (!userId || !Number.isInteger(Number(userId))) return false;
  try {
    const user = await db('users').where({ id: userId }).first('kind', 'role', 'is_active') as
      { kind: string; role: string; is_active: boolean } | undefined;
    if (!user || !user.is_active) return false;
    if (user.kind === 'client') {
      const row = await db('account_users as au')
        .join('hosting_accounts as a', 'a.id', 'au.account_id')
        .where('au.user_id', userId)
        .andWhere('au.account_id', target.accountId)
        .andWhere('a.tenant_id', target.tenantId)
        .first('au.capabilities') as { capabilities: unknown } | undefined;
      if (!row) return false;
      const caps = new Set<string>(clientCapabilities(row.capabilities));
      return caps.has('releases.publish') && caps.has('sites.manage');
    }
    if (user.role === 'admin') return true;
    // Staff: releases.publish and sites.manage both map to the staff capability 'sites.manage' (access.ts).
    const caps = await permissionService.listUserTenantCapabilities(Number(userId), target.tenantId);
    return caps.includes('sites.manage');
  } catch {
    return false;
  }
}
