import type { Request } from 'express';
import type { User } from '@oblimint/shared';
import { db } from '../db';
import { AppError } from '../middleware/errorHandler';
import { userService } from './user.service';
import { userScope, type ScopeActor } from './userScope.service';
import type { CreateUserInput, UpdateUserInput } from '../validators/user.schema';

// Create / update / delete a user account (Obliance userAdmin.service, without
// the approval path). Rules:
//  - P1 scope (userScope.assertManageableTarget): a manager that is not a
//    platform admin only acts on an account it dominates;
//  - only a platform admin creates an administrator or changes a platform
//    role; a client account is never an administrator;
//  - SSO (Obligate) accounts are managed from Obligate;
//  - the last active administrator is never demoted, disabled or deleted;
//  - one's own account is never deleted.

async function audit(req: Request | undefined, action: string, targetId: number, details: Record<string, unknown>): Promise<void> {
  if (!req) return;
  try {
    const { auditService } = await import('./audit.service');
    await auditService.logReq(req, action, { resourceType: 'user', resourcePath: String(targetId), details });
  } catch { /* never breaks the action */ }
}

async function otherActiveAdmins(exceptId: number): Promise<number> {
  const row = await db('users').where({ role: 'admin', is_active: true }).whereNot({ id: exceptId })
    .count('* as n').first() as { n: string | number } | undefined;
  return Number(row?.n ?? 0);
}

export async function usernameTaken(username: string): Promise<boolean> {
  return !!(await db('users').whereRaw('lower(username) = lower(?)', [username]).first('id'));
}

export async function createUserAccount(
  actor: ScopeActor,
  data: CreateUserInput,
  passwordHash: string,
  req?: Request,
): Promise<User> {
  if (data.role === 'admin' && !actor.isPlatformAdmin) {
    throw new AppError(403, 'Only a platform administrator can create an administrator account');
  }
  if (data.kind === 'client' && data.role === 'admin') throw new AppError(400, 'A client account cannot be an administrator');
  if (await usernameTaken(data.username)) throw new AppError(409, 'Username already exists');
  let user: User;
  try {
    user = await userService.createWithPasswordHash({
      username: data.username,
      passwordHash,
      displayName: data.displayName ?? null,
      email: data.email ?? null,
      role: data.role ?? 'user',
      kind: data.kind ?? 'staff',
    });
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') throw new AppError(409, 'Username or e-mail already exists');
    throw err;
  }
  // A manager that is not a platform admin creates the account IN its tenant
  // (role 'user'); otherwise it could neither see it nor would it get a session.
  let memberOf: number | undefined;
  if (!actor.isPlatformAdmin && Number.isInteger(actor.tenantId) && actor.tenantId > 0) {
    await db('user_tenants').insert({ user_id: user.id, tenant_id: actor.tenantId, role: 'user' })
      .onConflict(['user_id', 'tenant_id']).ignore();
    memberOf = actor.tenantId;
  }
  await audit(req, 'user.created', user.id, {
    username: user.username, role: user.role, kind: user.kind, ...(memberOf ? { tenantId: memberOf, tenantRole: 'user' } : {}),
  });
  return user;
}

export async function updateUserAccount(actor: ScopeActor, targetId: number, data: UpdateUserInput, req?: Request): Promise<User> {
  const scoped = await userScope.assertManageableTarget(actor, targetId);
  if (data.role !== undefined && data.role !== scoped.role && !actor.isPlatformAdmin) {
    throw new AppError(403, 'Only a platform administrator can change a user role');
  }
  if (scoped.foreign_source === 'obligate') throw new AppError(400, 'Cannot modify SSO user — manage from Obligate');
  const kindRow = await db('users').where({ id: targetId }).first('kind') as { kind: string } | undefined;
  if (data.role === 'admin' && kindRow?.kind === 'client') throw new AppError(400, 'A client account cannot be an administrator');
  if ((data.role === 'user' || data.isActive === false) && scoped.role === 'admin') {
    if ((await otherActiveAdmins(targetId)) === 0) throw new AppError(400, 'Cannot remove the last active admin');
  }
  if (data.isActive === false && targetId === actor.userId) throw new AppError(400, 'Cannot disable your own account');
  if (data.username !== undefined && data.username.toLowerCase() !== scoped.username.toLowerCase() && await usernameTaken(data.username)) {
    throw new AppError(409, 'Username already exists');
  }

  let user: User | null;
  try {
    user = await userService.update(targetId, data);
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') throw new AppError(409, 'Username or e-mail already exists');
    throw err;
  }
  if (!user) throw new AppError(404, 'User not found');
  const { forgetSessionUser } = await import('../middleware/sessionUserGuard');
  forgetSessionUser(targetId);
  const demoted = scoped.role === 'admin' && user.role !== 'admin';
  if (data.isActive === false || demoted) {
    const { killSessionsForUser } = await import('./userSessions.service');
    await killSessionsForUser(targetId, data.isActive === false ? 'user_disabled' : 'role_demoted');
  }
  const roleChanged = data.role !== undefined && data.role !== scoped.role;
  await audit(req, roleChanged ? 'user.role_changed' : 'user.updated', targetId, {
    username: user.username,
    before: { role: scoped.role, isActive: scoped.is_active },
    after: { role: user.role, isActive: user.isActive },
  });
  return user;
}

export async function deleteUserAccount(actor: ScopeActor, targetId: number, req?: Request): Promise<void> {
  if (targetId === actor.userId) throw new AppError(400, 'Cannot delete your own account');
  const scoped = await userScope.assertManageableTarget(actor, targetId);
  if (scoped.foreign_source === 'obligate') throw new AppError(400, 'Cannot delete SSO user — manage from Obligate');
  if (scoped.role === 'admin' && (await otherActiveAdmins(targetId)) === 0) throw new AppError(400, 'Cannot delete the last admin');
  if (!(await userService.delete(targetId))) throw new AppError(404, 'User not found');
  const { forgetSessionUser } = await import('../middleware/sessionUserGuard');
  forgetSessionUser(targetId);
  const { killSessionsForUser } = await import('./userSessions.service');
  await killSessionsForUser(targetId, 'user_deleted');
  await audit(req, 'user.deleted', targetId, { username: scoped.username });
}
