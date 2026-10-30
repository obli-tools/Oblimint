import { Router } from 'express';
import { MASTER_TENANT_ID } from '@oblimint/shared';
import { db } from '../db';
import { AppError } from '../middleware/errorHandler';
import { validate } from '../middleware/validate';
import { requirePlatformAdminOnMaster } from '../middleware/rbac';
import { tenantService, createTenantSchema, updateTenantSchema } from '../services/tenant.service';
import { auditService } from '../services/audit.service';
import { CLIENT_MEMBERSHIP_ROLE, membershipRoleRefusal } from '../services/permission.service';
import { gatePlatform } from '../services/restrictions/targets';

// Mounted (behind requireAuth) on BOTH /api/tenants and /api/tenant, like
// Obliance: GET /api/tenants, POST /api/tenant/switch, CRUD /api/tenants.
// Writes: platform admin sitting on the master tenant (god view).

const router = Router({ caseSensitive: true }); // force_2fa allow-list (sessionUserGuard.ts): exact paths

const idParam = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(400, 'Invalid tenant id');
  return id;
};

/** A tenant role is 'admin' or a permission-set slug; absent → 'user' ('client'
 *  for a client account), 'member' → 'user'. A client account holds the
 *  'client' role only, and that role is a client's (M12). */
async function tenantRoleFrom(raw: unknown, kind: string): Promise<string> {
  const absent = raw === undefined || raw === null || raw === '';
  const role = absent ? (kind === 'client' ? CLIENT_MEMBERSHIP_ROLE : 'user') : raw === 'member' ? 'user' : String(raw);
  if (role === 'admin' && kind === 'client') throw new AppError(400, 'A client account cannot be a workspace administrator');
  const refusal = membershipRoleRefusal(kind, role);
  if (refusal) throw new AppError(400, refusal);
  if (!(await db('permission_sets').where({ slug: role }).first('slug'))) throw new AppError(400, `Unknown role '${role}'`);
  return role;
}

// POST /api/tenant/switch { tenantId } → { currentTenantId }
router.post('/switch', async (req, res, next) => {
  try {
    const tenantId = (req.body as { tenantId?: unknown })?.tenantId;
    if (typeof tenantId !== 'number' || !Number.isSafeInteger(tenantId) || tenantId <= 0) throw new AppError(400, 'tenantId is required');
    if (req.session.role === 'admin') {
      if (!(await db('tenants').where({ id: tenantId }).first('id'))) throw new AppError(404, 'Tenant not found');
    } else if (!(await tenantService.userHasAccess(req.session.userId!, tenantId))) {
      throw new AppError(403, 'Access denied to this tenant');
    }
    req.session.currentTenantId = tenantId;
    res.json({ success: true, data: { currentTenantId: tenantId } });
  } catch (err) { next(err); }
});

// GET /api/tenants — platform admin: every tenant (Tenant[]); others: theirs (TenantWithRole[]).
router.get('/', async (req, res, next) => {
  try {
    const data = req.session.role === 'admin'
      ? await tenantService.getAll()
      : await tenantService.getTenantsForUser(req.session.userId!);
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/', requirePlatformAdminOnMaster, validate(createTenantSchema), async (req, res, next) => {
  try {
    const tenant = await tenantService.create(req.body);
    await auditService.logReqAs(req, MASTER_TENANT_ID, 'tenant.created', {
      resourceType: 'tenant', resourcePath: String(tenant.id), details: { name: tenant.name, slug: tenant.slug, limits: tenant.limits },
    });
    res.status(201).json({ success: true, data: tenant });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = idParam(req.params.id);
    if (req.session.role !== 'admin' && !(await tenantService.userHasAccess(req.session.userId!, id))) {
      throw new AppError(404, 'Tenant not found');
    }
    const tenant = await tenantService.getById(id);
    if (!tenant) throw new AppError(404, 'Tenant not found');
    res.json({ success: true, data: tenant });
  } catch (err) { next(err); }
});

router.put('/:id', requirePlatformAdminOnMaster, validate(updateTenantSchema), async (req, res, next) => {
  try {
    const id = idParam(req.params.id);
    const before = await tenantService.getById(id);
    if (!before) throw new AppError(404, 'Tenant not found');
    const tenant = await tenantService.update(id, req.body);
    if (!tenant) throw new AppError(404, 'Tenant not found');
    const changes: Record<string, unknown> = {};
    if (tenant.name !== before.name) changes.name = { from: before.name, to: tenant.name };
    if (tenant.slug !== before.slug) changes.slug = { from: before.slug, to: tenant.slug };
    if (JSON.stringify(tenant.limits) !== JSON.stringify(before.limits)) changes.limits = { from: before.limits, to: tenant.limits };
    if (Object.keys(changes).length > 0) {
      await auditService.logReqAs(req, id, 'tenant.settings_changed', { resourceType: 'tenant', resourcePath: String(id), details: changes });
    }
    res.json({ success: true, data: tenant });
  } catch (err) { next(err); }
});

router.delete('/:id', requirePlatformAdminOnMaster, async (req, res, next) => {
  try {
    const id = idParam(req.params.id);
    if (id === MASTER_TENANT_ID) throw new AppError(400, 'Cannot delete the default tenant');
    const before = await tenantService.getById(id);
    if (!before) throw new AppError(404, 'Tenant not found');
    await gatePlatform(req, 'platform.tenant_delete', { tenantId: id, name: before.name, slug: before.slug });
    const members = await db('user_tenants').where({ tenant_id: id }).pluck('user_id') as number[];
    await tenantService.delete(id);
    // Sessions sitting on the deleted tenant are repaired by /auth/me
    // (stale tenant); memberships go with the CASCADE.
    const { forgetTenantMemberships } = await import('../middleware/tenant');
    for (const uid of members) forgetTenantMemberships(Number(uid));
    await auditService.logReqAs(req, MASTER_TENANT_ID, 'tenant.deleted', {
      resourceType: 'tenant', resourcePath: String(id), details: { name: before.name, slug: before.slug },
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Members (platform admin on master) ──────────────────────────────────────

router.get('/:id/members', requirePlatformAdminOnMaster, async (req, res, next) => {
  try {
    res.json({ success: true, data: await tenantService.getMembers(idParam(req.params.id)) });
  } catch (err) { next(err); }
});

router.post('/:id/members', requirePlatformAdminOnMaster, async (req, res, next) => {
  try {
    const tenantId = idParam(req.params.id);
    const { userId, role } = (req.body ?? {}) as { userId?: unknown; role?: unknown };
    if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) throw new AppError(400, 'userId is required');
    if (!(await db('tenants').where({ id: tenantId }).first('id'))) throw new AppError(404, 'Tenant not found');
    const target = await db('users').where({ id: userId }).first('kind', 'foreign_source') as { kind: string; foreign_source: string | null } | undefined;
    if (!target) throw new AppError(404, 'User not found');
    if (target.foreign_source === 'obligate') throw new AppError(400, 'Cannot modify SSO user tenant access — manage from Obligate');
    const r = await tenantRoleFrom(role, target.kind);
    await tenantService.addUser(tenantId, userId, r);
    await auditService.logReqAs(req, tenantId, 'tenant.member_added', { resourceType: 'user', resourcePath: String(userId), details: { role: r } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.put('/:id/members/:uid', requirePlatformAdminOnMaster, async (req, res, next) => {
  try {
    const tenantId = idParam(req.params.id);
    const userId = idParam(req.params.uid);
    const role = (req.body as { role?: unknown })?.role;
    if (!role) throw new AppError(400, 'role is required');
    const target = await db('users').where({ id: userId }).first('kind', 'foreign_source') as { kind: string; foreign_source: string | null } | undefined;
    if (!target) throw new AppError(404, 'User not found');
    if (target.foreign_source === 'obligate') throw new AppError(400, 'Cannot modify SSO user tenant access — manage from Obligate');
    const r = await tenantRoleFrom(role, target.kind);
    if (!(await tenantService.updateUserRole(tenantId, userId, r))) throw new AppError(404, 'Membership not found');
    await auditService.logReqAs(req, tenantId, 'tenant.member_role_changed', { resourceType: 'user', resourcePath: String(userId), details: { role: r } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.delete('/:id/members/:uid', requirePlatformAdminOnMaster, async (req, res, next) => {
  try {
    const tenantId = idParam(req.params.id);
    const userId = idParam(req.params.uid);
    const target = await db('users').where({ id: userId }).first('foreign_source') as { foreign_source: string | null } | undefined;
    if (target?.foreign_source === 'obligate') throw new AppError(400, 'Cannot modify SSO user tenant access — manage from Obligate');
    await tenantService.removeUser(tenantId, userId);
    const { killSessionsForUser } = await import('../services/userSessions.service');
    await killSessionsForUser(userId, 'tenant_access_removed');
    await auditService.logReqAs(req, tenantId, 'tenant.member_removed', { resourceType: 'user', resourcePath: String(userId) });
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
