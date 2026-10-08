import type { User, UserKind, UserRole, UserTenantAssignment } from '@oblimint/shared';
import { db } from '../db';
import { hashPassword } from '../utils/crypto';
import { rowToUser, type UserRow } from './userRow';

export const userService = {
  /** Every user (tenantId null — the platform admin's god view on the master
   *  tenant), or the members of `tenantId`. */
  async getAll(tenantId?: number | null): Promise<User[]> {
    const q = db<UserRow>('users').orderBy('users.username').select('users.*');
    if (tenantId != null) {
      q.join('user_tenants', 'user_tenants.user_id', 'users.id').where('user_tenants.tenant_id', tenantId);
    }
    return (await q).map(rowToUser);
  },

  async getById(id: number): Promise<User | null> {
    const row = await db<UserRow>('users').where({ id }).first();
    return row ? rowToUser(row) : null;
  },

  async createWithPasswordHash(data: {
    username: string;
    passwordHash: string;
    displayName?: string | null;
    email?: string | null;
    role?: UserRole;
    kind?: UserKind;
  }): Promise<User> {
    const kind: UserKind = data.kind ?? 'staff';
    const [row] = await db<UserRow>('users')
      .insert({
        username: data.username,
        password_hash: data.passwordHash,
        display_name: data.displayName || null,
        email: data.email || null,
        // A client is never a platform administrator (also a DB CHECK).
        role: kind === 'client' ? 'user' : (data.role || 'user'),
        kind,
      } as any)
      .returning('*');
    return rowToUser(row as UserRow);
  },

  async update(id: number, data: {
    username?: string;
    displayName?: string | null;
    email?: string | null;
    role?: UserRole;
    isActive?: boolean;
  }): Promise<User | null> {
    const updateData: Record<string, unknown> = { updated_at: new Date() };
    if (data.username !== undefined) updateData.username = data.username;
    if (data.displayName !== undefined) updateData.display_name = data.displayName;
    if (data.email !== undefined) updateData.email = data.email || null;
    if (data.role !== undefined) updateData.role = data.role;
    if (data.isActive !== undefined) updateData.is_active = data.isActive;
    const [row] = await db<UserRow>('users').where({ id }).update(updateData as any).returning('*');
    return row ? rowToUser(row as UserRow) : null;
  },

  async changePassword(id: number, newPassword: string): Promise<boolean> {
    const passwordHash = await hashPassword(newPassword);
    const count = await db('users').where({ id }).update({ password_hash: passwordHash, updated_at: new Date() });
    return count > 0;
  },

  async delete(id: number): Promise<boolean> {
    return (await db('users').where({ id }).del()) > 0;
  },

  async getUserTenantAssignments(userId: number): Promise<UserTenantAssignment[]> {
    const rows = await db('tenants as t')
      .leftJoin('user_tenants as ut', function () {
        this.on('ut.tenant_id', '=', 't.id').andOnVal('ut.user_id', '=', userId);
      })
      .select(
        't.id as tenantId',
        't.name as tenantName',
        't.slug as tenantSlug',
        db.raw('(ut.user_id IS NOT NULL) as is_member'),
        db.raw("COALESCE(ut.role, 'user') as role"),
      )
      .orderBy('t.name');
    return rows.map((r: any) => ({
      tenantId: r.tenantId,
      tenantName: r.tenantName,
      tenantSlug: r.tenantSlug,
      isMember: Boolean(r.is_member),
      role: r.role === 'member' ? 'user' : r.role,
    }));
  },

  /** Bulk-replaces the user's memberships; sessions end when a tenant is removed. */
  async setUserTenantAssignments(userId: number, assignments: { tenantId: number; role: string }[]): Promise<number[]> {
    const removed = await db.transaction(async (trx) => {
      const before = (await trx('user_tenants').where({ user_id: userId }).pluck('tenant_id') as number[]).map(Number);
      const kept = new Set(assignments.map((a) => Number(a.tenantId)));
      const gone = before.filter((t) => !kept.has(t));
      await trx('user_tenants').where({ user_id: userId }).del();
      if (assignments.length > 0) {
        await trx('user_tenants').insert(assignments.map((a) => ({
          user_id: userId,
          tenant_id: a.tenantId,
          role: a.role === 'member' || !a.role ? 'user' : a.role,
        })));
      }
      return gone;
    });
    if (removed.length > 0) {
      const { killSessionsForUser } = await import('./userSessions.service');
      await killSessionsForUser(userId, 'tenant_access_removed');
    }
    return removed;
  },
};
