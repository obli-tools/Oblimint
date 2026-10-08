import type { Request, Response, NextFunction } from 'express';
import { performance } from 'node:perf_hooks';
import { db } from '../db';
import { AppError } from './errorHandler';

// Extend Express.Request to carry the resolved tenantId
declare global {
  namespace Express {
    interface Request {
      tenantId: number;
    }
  }
}

// Membership of (user, tenant), cached a few seconds: a session keeps the
// tenant it was put on, and a user removed from that tenant (or its tenant
// deleted) must lose it on its next requests, not when it switches tenant.
const MEMBERSHIP_TTL_MS = 5_000;
const MEMBERSHIP_MAX_ENTRIES = 10_000;
const membershipCache = new Map<string, { at: number; member: boolean }>();
// Bumped by forgetTenantMemberships: an answer read BEFORE a membership change
// (query in flight at that moment) is never cached after it.
const membershipGeneration = new Map<number, number>();

/** Drops the cached memberships of a user (called by killSessionsForUser). */
export function forgetTenantMemberships(userId: number): void {
  const prefix = `${userId}:`;
  for (const key of membershipCache.keys()) if (key.startsWith(prefix)) membershipCache.delete(key);
  membershipGeneration.set(userId, (membershipGeneration.get(userId) ?? 0) + 1);
}

async function isTenantMember(userId: number, tenantId: number): Promise<boolean> {
  const key = `${userId}:${tenantId}`;
  const now = performance.now();
  const hit = membershipCache.get(key);
  if (hit && now - hit.at < MEMBERSHIP_TTL_MS) return hit.member;
  const generation = membershipGeneration.get(userId) ?? 0;
  const member = !!(await db('user_tenants').where({ user_id: userId, tenant_id: tenantId }).first('user_id'));
  if ((membershipGeneration.get(userId) ?? 0) !== generation) return member; // changed meanwhile: not cached
  if (membershipCache.size >= MEMBERSHIP_MAX_ENTRIES) { membershipCache.clear(); membershipGeneration.clear(); }
  membershipCache.set(key, { at: now, member });
  return member;
}

/**
 * Resolves req.tenantId from the session.
 * Must be applied after requireAuth on all routes that operate on tenant-scoped data.
 * A user that is not a platform admin must still be a member of the
 * session's tenant (re-checked, cached a few seconds): team grants are not
 * tenant-filtered everywhere (requireDeviceRead / requireDeviceWrite).
 */
export async function requireTenant(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const tid = req.session?.currentTenantId;
  if (!tid) {
    next(new AppError(400, 'No tenant selected'));
    return;
  }
  if (req.session.role !== 'admin') {
    try {
      const userId = Number(req.session.userId);
      if (!Number.isInteger(userId) || userId <= 0 || !(await isTenantMember(userId, Number(tid)))) {
        next(new AppError(403, 'No access to this tenant'));
        return;
      }
    } catch (err) {
      next(err);
      return;
    }
  }
  req.tenantId = tid;
  next();
}

/**
 * For routers that are NOT mounted under the tenant router (/api/profile,
 * /api/profile/2fa): exposes the session's current tenant as req.tenantId,
 * so the restriction envelope (`tenant.manage_profile`), the "Trust this IP"
 * duration and the audit log all see a tenant (P4). A session without a
 * tenant (pre-tenant sessions) is repaired the way /auth/me does, with the
 * user's first tenant; an account without any tenant is refused (403
 * noTenantAccess, E3) — it never gets the master tenant.
 */
export async function attachSessionTenant(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.session?.userId;
    if (userId) {
      if (!req.session.currentTenantId) {
        const { tenantService, noTenantAccessError } = await import('../services/tenant.service');
        const tenantId = await tenantService.sessionTenantFor(userId, req.session.role);
        // E3: never the master tenant for an account without any tenant.
        if (tenantId === null) { next(noTenantAccessError()); return; }
        req.session.currentTenantId = tenantId;
      }
      req.tenantId = req.session.currentTenantId;
    }
    next();
  } catch (err) {
    next(err);
  }
}
