import type { Request } from 'express';
import { db } from '../db';
import { AppError } from '../middleware/errorHandler';
import { staffEquivalentOf } from './hosting/access';
import { CLIENT_MEMBERSHIP_ROLE, membershipRoleRefusal } from './permission.service';

// ── Scope of `users.manage` (P1, docs/mobile/device-bound-2fa.md §6.0) ─────
//
// /api/users is gated by the tenant capability `users.manage`. Password,
// 2FA, activity and deletion act on the GLOBAL account, so a holder that is
// not a platform admin may only act on an account it fully dominates:
//   - never a platform admin (users.role = 'admin');
//   - a member of the caller's current tenant;
//   - in EVERY tenant the account belongs to:
//       · a tenant administrator (user_tenants.role = 'admin') only if the
//         caller is tenant administrator there too;
//       · otherwise the caller holds `users.manage` there AND every
//         capability of the account's permission set there (taking over an
//         account must never widen the caller's rights).
// Platform admins (session role 'admin') may target anyone.
//
// The same rules are re-run by the approval executor (approval.service.ts)
// as the REQUESTER, because rights may change while a request waits.

export type ScopeActor = { userId: number; isPlatformAdmin: boolean; tenantId: number };
export type ManagedTarget = {
  id: number; username: string; role: string; is_active: boolean; foreign_source: string | null;
};
export type TenantAssignment = { tenantId: number; role: string };

export function actorFromReq(req: Request): ScopeActor {
  return {
    userId: Number(req.session.userId),
    isPlatformAdmin: req.session.role === 'admin',
    tenantId: Number((req as any).tenantId),
  };
}

/** Pre-091 tenant role 'member' is the 'user' permission set (migration 091
 *  backfilled it; the tenant panel kept writing it — an orphan slug gives no
 *  capability at all). */
export function normaliseTenantRole(role: unknown): string {
  const r = String(role ?? '').trim();
  return r === '' || r === 'member' ? 'user' : r;
}

type Caps = { all: true } | { all: false; set: Set<string> };

async function capsOfRole(role: string): Promise<Caps | null> {
  if (role === 'admin') return { all: true };
  // The client set is locked empty (M12; permissionSet.service), whatever the row says.
  if (role === CLIENT_MEMBERSHIP_ROLE) return { all: false, set: new Set() };
  const row = await db('permission_sets').where({ slug: role }).first('capabilities') as { capabilities: unknown } | undefined;
  if (!row) return null; // unknown slug: no capability (userHasTenantCapability)
  const raw = typeof row.capabilities === 'string' ? JSON.parse(row.capabilities) : row.capabilities;
  return { all: false, set: new Set(Array.isArray(raw) ? raw.map(String) : []) };
}

/** The CALLER's role in `tenantId`; a client login counts as 'client' (no
 *  tenant capability, M12) whatever its membership row says. */
async function membershipRole(userId: number, tenantId: number): Promise<string | null> {
  const row = await db('user_tenants as ut').join('users as u', 'u.id', 'ut.user_id')
    .where({ 'ut.user_id': userId, 'ut.tenant_id': tenantId })
    .first('ut.role', 'u.kind') as { role: string; kind: string } | undefined;
  if (!row) return null;
  return row.kind === 'client' ? CLIENT_MEMBERSHIP_ROLE : normaliseTenantRole(row.role);
}

/**
 * Can `actor` (not a platform admin) manage an account whose role in
 * `tenantId` is `targetRole`? Returns the refusal text, or null when allowed.
 */
async function refusalFor(actor: ScopeActor, tenantId: number, targetRole: string, extraTargetCaps: Iterable<string> = []): Promise<string | null> {
  const callerRole = await membershipRole(actor.userId, tenantId);
  if (callerRole === 'admin') return null; // tenant admin: every capability there
  if (targetRole === 'admin') {
    return "Only an administrator of each of this user's tenants can manage a tenant administrator";
  }
  const callerCaps = callerRole ? await capsOfRole(callerRole) : null;
  if (callerCaps?.all) return null;
  if (!callerCaps || !callerCaps.set.has('users.manage')) {
    return 'This user also belongs to a tenant where you cannot manage users';
  }
  const targetCaps = await capsOfRole(targetRole);
  if (targetCaps?.all) return 'This user has permissions you do not hold';
  for (const cap of [...(targetCaps?.set ?? []), ...extraTargetCaps]) {
    if (!callerCaps.set.has(cap)) return 'This user has permissions you do not hold';
  }
  return null;
}

/**
 * A CLIENT login's real rights are its per-account capabilities
 * (account_users), not its membership role ('client' = empty set): their
 * staff equivalents in `tenantId` (releases.* ← sites.manage). Taking it over
 * (password / 2FA reset, then signing in as it) needs them too.
 */
async function clientHostingCapsIn(userId: number, tenantId: number): Promise<Set<string>> {
  const rows = await db('account_users as au')
    .join('hosting_accounts as a', 'a.id', 'au.account_id')
    .where('au.user_id', userId)
    .andWhere('a.tenant_id', tenantId)
    .select('au.capabilities') as Array<{ capabilities: unknown }>;
  const all: string[] = [];
  for (const r of rows) {
    const raw = typeof r.capabilities === 'string' ? JSON.parse(r.capabilities) : r.capabilities;
    if (Array.isArray(raw)) all.push(...raw.map(String));
  }
  return staffEquivalentOf(all);
}

export const userScope = {
  /** Write access (password / 2FA reset, edit, enable/disable, delete,
   *  tenant access). Throws 400 / 403 / 404 (AppError). */
  async assertManageableTarget(actor: ScopeActor, targetId: number): Promise<ManagedTarget> {
    if (!Number.isInteger(targetId) || targetId <= 0) throw new AppError(400, 'Invalid user id');
    const row = await db('users').where({ id: targetId })
      .first('id', 'username', 'role', 'is_active', 'foreign_source', 'kind') as (ManagedTarget & { kind?: string }) | undefined;
    if (!row) throw new AppError(404, 'User not found');
    const { kind, ...target } = row;
    if (actor.isPlatformAdmin) return target;
    if (target.role === 'admin') {
      throw new AppError(403, 'Only a platform administrator can manage an administrator account');
    }
    const rows = await db('user_tenants').where({ user_id: targetId }).select('tenant_id', 'role') as Array<{ tenant_id: number; role: string }>;
    if (!rows.some((r) => Number(r.tenant_id) === actor.tenantId)) throw new AppError(404, 'User not found');
    for (const r of rows) {
      const tenantId = Number(r.tenant_id);
      const extra = kind === 'client' ? await clientHostingCapsIn(targetId, tenantId) : [];
      const refusal = await refusalFor(actor, tenantId, normaliseTenantRole(r.role), extra);
      if (refusal) throw new AppError(403, refusal);
    }
    return target;
  },

  /** Read access (GET /users/:id, /:id/tenants, /:id/teams): the same
   *  population as GET /users — every account for a platform admin, members
   *  of the current tenant otherwise, on the master tenant too (its god view
   *  is the platform admin's, not every holder of users.manage there).
   *  404 outside. */
  async assertReadableTarget(actor: ScopeActor, targetId: number): Promise<void> {
    if (!Number.isInteger(targetId) || targetId <= 0) throw new AppError(400, 'Invalid user id');
    if (actor.isPlatformAdmin) return;
    const member = await db('user_tenants').where({ user_id: targetId, tenant_id: actor.tenantId }).first('user_id');
    if (!member) throw new AppError(404, 'User not found');
  },

  /**
   * Resolves PUT /users/:id/tenants into the full list of memberships to
   * store. Platform admin: the list as sent ('member' read as 'user').
   * Other managers: only the CURRENT tenant's row may change (add a role,
   * change it, or remove it); every other membership is kept as it is —
   * absent from the list or repeated unchanged, never altered.
   */
  async resolveTenantAssignments(actor: ScopeActor, targetId: number, assignments: unknown): Promise<TenantAssignment[]> {
    if (!Array.isArray(assignments)) throw new AppError(400, 'assignments must be an array');
    const wanted: TenantAssignment[] = [];
    const seen = new Set<number>();
    for (const a of assignments as Array<{ tenantId?: unknown; role?: unknown }>) {
      const tenantId = Number(a?.tenantId);
      if (!Number.isInteger(tenantId) || tenantId <= 0) throw new AppError(400, 'Invalid tenant id');
      if (seen.has(tenantId)) throw new AppError(400, 'Duplicate tenant in assignments');
      seen.add(tenantId);
      wanted.push({ tenantId, role: normaliseTenantRole(a?.role) });
    }
    // Oblimint: every requested tenant must exist and every role must be a
    // known permission set ('admin' included), whoever asks.
    const target = await db('users').where({ id: targetId }).first('kind') as { kind: string } | undefined;
    for (const w of wanted) {
      // A client account never administers a workspace, nor holds any tenant
      // capability: the 'client' role only (and that role is a client's, M12).
      if (target?.kind === 'client' && w.role === 'admin') throw new AppError(400, 'A client account cannot be a workspace administrator');
      const kindRefusal = membershipRoleRefusal(target?.kind, w.role);
      if (kindRefusal) throw new AppError(400, kindRefusal);
      if (!(await db('tenants').where({ id: w.tenantId }).first('id'))) throw new AppError(400, `Unknown tenant: ${w.tenantId}`);
      if (!(await capsOfRole(w.role))) throw new AppError(400, `Unknown role: ${w.role}`);
    }
    if (actor.isPlatformAdmin) return wanted;

    if (targetId === actor.userId) throw new AppError(403, 'You cannot change your own tenant access');
    await this.assertManageableTarget(actor, targetId); // member of the current tenant, dominated everywhere

    const current = (await db('user_tenants').where({ user_id: targetId }).select('tenant_id', 'role') as Array<{ tenant_id: number; role: string }>)
      .map((r) => ({ tenantId: Number(r.tenant_id), role: normaliseTenantRole(r.role) }));
    const kept = current.filter((r) => r.tenantId !== actor.tenantId);
    for (const w of wanted) {
      if (w.tenantId === actor.tenantId) continue;
      const same = kept.find((k) => k.tenantId === w.tenantId);
      if (!same || same.role !== w.role) throw new AppError(403, 'You can only change access to the current tenant');
    }

    const next = wanted.find((w) => w.tenantId === actor.tenantId);
    if (next) {
      const callerRole = await membershipRole(actor.userId, actor.tenantId);
      if (next.role === 'admin') {
        if (callerRole !== 'admin') {
          throw new AppError(403, 'Only a tenant administrator can grant the tenant administrator role');
        }
      } else {
        if (!(await capsOfRole(next.role))) throw new AppError(400, `Unknown role: ${next.role}`);
        const refusal = await refusalFor(actor, actor.tenantId, next.role);
        if (refusal) throw new AppError(403, 'You can only grant a role whose permissions you hold');
      }
    }
    return next ? [...kept, next] : kept;
  },

  /**
   * H3: the membership role a manager that is not a platform admin gives an
   * account it creates in `tenantId` (users.manage): a known permission set
   * whose every capability the manager holds there ('admin': tenant
   * administrators only), and the role of the account's kind (M12).
   */
  async assertGrantableRole(actor: ScopeActor, tenantId: number, role: string, kind: string): Promise<void> {
    const kindRefusal = membershipRoleRefusal(kind, role);
    if (kindRefusal) throw new AppError(400, kindRefusal);
    if (!(await capsOfRole(role))) throw new AppError(400, `Unknown role: ${role}`);
    if (actor.isPlatformAdmin) return;
    const refusal = await refusalFor(actor, tenantId, role);
    if (refusal) throw new AppError(403, 'You can only grant a role whose permissions you hold');
  },

};


/** Admin 2FA reset: removes the local TOTP (the account sets it up again). */
export async function resetSecondFactors(userId: number): Promise<boolean> {
  const count = await db('users').where({ id: userId }).update({
    totp_secret: null,
    totp_enabled: false,
    updated_at: new Date(),
  });
  // Its recovery codes went with the authenticator (a new batch comes with the next one).
  await db('user_recovery_codes').where({ user_id: userId }).delete();
  return count > 0;
}
