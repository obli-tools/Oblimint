import { Router, type Request } from 'express';
import { isMasterTenant } from '@oblimint/shared';
import { requireTenantCapability } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { AppError } from '../middleware/errorHandler';
import { hashPassword } from '../utils/crypto';
import { userService } from '../services/user.service';
import { userScope, actorFromReq, resetSecondFactors } from '../services/userScope.service';
import { createUserAccount, updateUserAccount, deleteUserAccount, usernameTaken } from '../services/userAdmin.service';
import { auditService } from '../services/audit.service';
import { gateTenant } from '../services/restrictions/targets';
import {
  createUserSchema, updateUserSchema, changePasswordSchema,
  type CreateUserInput, type UpdateUserInput, type ChangePasswordInput,
} from '../validators/user.schema';

// /api/users — tenant router (requireAuth + requireTenant), capability
// users.manage. Same paths and shapes as Obliance (users.routes.ts +
// users.controller.ts), without teams (GET /:id/teams answers []) and phone keys.

const router = Router();
router.use(requireTenantCapability('users.manage'));

const isPlatformAdmin = (req: Request): boolean => req.session.role === 'admin';
const idParam = (req: Request): number => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(400, 'Invalid user id');
  return id;
};

// GET /api/users — every account for the platform admin on the master tenant
// (god view), the members of the current tenant otherwise.
router.get('/', async (req, res, next) => {
  try {
    const scopeAll = isPlatformAdmin(req) && isMasterTenant(req.tenantId);
    res.json({ success: true, data: await userService.getAll(scopeAll ? null : req.tenantId) });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = idParam(req);
    await userScope.assertReadableTarget(actorFromReq(req), id);
    const user = await userService.getById(id);
    if (!user) throw new AppError(404, 'User not found');
    res.json({ success: true, data: user });
  } catch (err) { next(err); }
});

router.post('/', validate(createUserSchema), async (req, res, next) => {
  try {
    const data = req.body as CreateUserInput;
    if (data.role === 'admin' && !isPlatformAdmin(req)) {
      throw new AppError(403, 'Only a platform administrator can create an administrator account');
    }
    if (await usernameTaken(data.username)) throw new AppError(409, 'Username already exists');
    const { password, ...shown } = data as CreateUserInput & { password?: string };
    await gateTenant(req, 'user.create', { ...shown }, { secretParams: password ? { password } : {} });
    const user = await createUserAccount(actorFromReq(req), data, await hashPassword(data.password), req);
    res.status(201).json({ success: true, data: user });
  } catch (err) { next(err); }
});

router.put('/:id', validate(updateUserSchema), async (req, res, next) => {
  try {
    const target = await userScope.assertManageableTarget(actorFromReq(req), idParam(req));
    await gateTenant(req, 'user.update', { userId: idParam(req), username: target.username, ...(req.body as UpdateUserInput) });
    const user = await updateUserAccount(actorFromReq(req), idParam(req), req.body as UpdateUserInput, req);
    res.json({ success: true, data: user });
  } catch (err) { next(err); }
});

router.put('/:id/password', validate(changePasswordSchema), async (req, res, next) => {
  try {
    const id = idParam(req);
    if (id === req.session.userId) throw new AppError(400, 'Use your profile to change your own password');
    const target = await userScope.assertManageableTarget(actorFromReq(req), id);
    if (target.foreign_source === 'obligate') throw new AppError(400, 'Cannot modify SSO user — manage from Obligate');
    await gateTenant(req, 'user.password_reset', { userId: id, username: target.username }, { secretParams: { password: (req.body as ChangePasswordInput).password } });
    if (!(await userService.changePassword(id, (req.body as ChangePasswordInput).password))) throw new AppError(404, 'User not found');
    // The account's other sessions end with the old password.
    const { killSessionsForUser } = await import('../services/userSessions.service');
    await killSessionsForUser(id, 'password_reset');
    await auditService.logReq(req, 'user.password_reset_admin', { resourceType: 'user', resourcePath: String(id), details: { username: target.username } });
    res.json({ success: true, message: 'Password changed' });
  } catch (err) { next(err); }
});

router.delete('/:id/2fa', async (req, res, next) => {
  try {
    const id = idParam(req);
    if (id === req.session.userId) throw new AppError(400, 'Use your profile to manage your own two-factor authentication');
    const target = await userScope.assertManageableTarget(actorFromReq(req), id);
    await gateTenant(req, 'user.2fa_reset', { userId: id, username: target.username });
    if (!(await resetSecondFactors(id))) throw new AppError(404, 'User not found');
    // Sessions opened with the removed factor end (the account signs in again).
    const { killSessionsForUser } = await import('../services/userSessions.service');
    await killSessionsForUser(id, '2fa_reset');
    await auditService.logReq(req, 'user.2fa_reset', { resourceType: 'user', resourcePath: String(id), details: { username: target.username } });
    res.json({ success: true, message: 'MFA reset successfully' });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (idParam(req) === req.session.userId) throw new AppError(400, 'Cannot delete your own account');
    const target = await userScope.assertManageableTarget(actorFromReq(req), idParam(req));
    await gateTenant(req, 'user.delete', { userId: idParam(req), username: target.username });
    await deleteUserAccount(actorFromReq(req), idParam(req), req);
    res.json({ success: true, message: 'User deleted' });
  } catch (err) { next(err); }
});

// Oblimint has no teams.
router.get('/:id/teams', async (req, res, next) => {
  try {
    await userScope.assertReadableTarget(actorFromReq(req), idParam(req));
    res.json({ success: true, data: [] });
  } catch (err) { next(err); }
});

router.get('/:id/tenants', async (req, res, next) => {
  try {
    const id = idParam(req);
    const actor = actorFromReq(req);
    await userScope.assertReadableTarget(actor, id);
    let assignments = await userService.getUserTenantAssignments(id);
    if (!actor.isPlatformAdmin) assignments = assignments.filter((a) => Number(a.tenantId) === actor.tenantId);
    res.json({ success: true, data: assignments });
  } catch (err) { next(err); }
});

// PUT /api/users/:id/tenants { assignments: [{ tenantId, role }] }
router.put('/:id/tenants', async (req, res, next) => {
  try {
    const id = idParam(req);
    const targetUser = await userService.getById(id);
    if (!targetUser) throw new AppError(404, 'User not found');
    if (targetUser.foreignSource === 'obligate') {
      throw new AppError(400, 'Cannot modify SSO user tenant access — manage from Obligate');
    }
    const assignments = await userScope.resolveTenantAssignments(actorFromReq(req), id, (req.body as { assignments?: unknown })?.assignments);
    await gateTenant(req, 'user.tenants_set', { userId: id, username: targetUser.username, assignments });
    await userService.setUserTenantAssignments(id, assignments);
    await auditService.logReq(req, 'user.tenants_changed', { resourceType: 'user', resourcePath: String(id), details: { username: targetUser.username, assignments } });
    res.json({ success: true, message: 'Tenant assignments updated' });
  } catch (err) { next(err); }
});

export default router;
