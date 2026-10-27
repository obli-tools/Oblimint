import type { Request } from 'express';
import type { Knex } from 'knex';
import type { AccountClientUser, ClientCapability, ClientUserCandidate } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { hashPassword } from '../../utils/crypto';
import { logger } from '../../utils/logger';
import type { ClientUserAddBody, ClientUserCreateBody } from '../../validators/hosting.schema';
import { auditService } from '../audit.service';
import { CLIENT_MEMBERSHIP_ROLE } from '../permission.service';
import { assertCanGrantClientCapabilities, resolveActor } from './access';
import { emitHosting } from './events';
import { isUniqueViolation } from './hostingValidation.service';
import { clientCapabilities, iso, type AccountRow } from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// Client users of a hosting account (users.kind = 'client'): local accounts
// only (never Obligate, never admin — DB CHECKs of migration 001), member of
// the account's tenant with the 'client' permission set (no tenant
// capability), rights = account_users.capabilities. Managed by STAFF with
// accounts.manage only (clients never manage users in P1).
// ─────────────────────────────────────────────────────────────────────────────

/** Permission set of client memberships (seeded by migration 002). */
export { CLIENT_MEMBERSHIP_ROLE };

interface ClientUserRow {
  id: number; username: string; display_name: string | null; email: string | null; is_active: boolean;
  totp_enabled: boolean; capabilities: unknown; other_account_count: number | string; created_at: Date | string;
}

function toClientUser(r: ClientUserRow): AccountClientUser {
  return {
    userId: r.id,
    username: r.username,
    displayName: r.display_name,
    email: r.email,
    isActive: !!r.is_active,
    totpEnabled: !!r.totp_enabled,
    capabilities: clientCapabilities(r.capabilities),
    otherAccountCount: Number(r.other_account_count ?? 0),
    createdAt: iso(r.created_at) as string,
  };
}

function selectClientUsers(accountId: number) {
  return db('account_users as au')
    .join('users as u', 'u.id', 'au.user_id')
    .where('au.account_id', accountId)
    .select('u.id', 'u.username', 'u.display_name', 'u.email', 'u.is_active', 'u.totp_enabled', 'au.capabilities', 'au.created_at',
      db.raw('(SELECT COUNT(*) FROM account_users o WHERE o.user_id = u.id AND o.account_id <> au.account_id) AS other_account_count'));
}

function usernameTaken(): AppError {
  return new AppError(409, 'This user name is already taken', 'usernameTaken');
}

function emailTaken(): AppError {
  return new AppError(409, 'This e-mail address is already used by another user', 'emailTaken');
}

function emitAccount(account: AccountRow): void {
  emitHosting(HostingSocketEvents.HOSTING_CHANGED, { entity: 'account', id: account.id, accountId: account.id, action: 'updated' },
    { tenantId: account.tenant_id, accountId: account.id });
}

export const clientUsersService = {
  async list(accountId: number): Promise<AccountClientUser[]> {
    return (await selectClientUsers(accountId).orderBy('u.username') as ClientUserRow[]).map(toClientUser);
  },

  /**
   * Logins that "attach existing" may pick: active CLIENT users member of the
   * account's tenant (never staff, never another tenant: same rule as add()),
   * not on this account yet — including logins detached from every account.
   */
  async candidates(account: Pick<AccountRow, 'id' | 'tenant_id'>): Promise<ClientUserCandidate[]> {
    const rows = await db('users as u')
      .join('user_tenants as ut', 'ut.user_id', 'u.id')
      .where('ut.tenant_id', account.tenant_id)
      .andWhere('u.kind', 'client')
      .andWhere('u.is_active', true)
      .whereNotExists(db('account_users as au').whereRaw('au.user_id = u.id').andWhere('au.account_id', account.id))
      .select('u.id', 'u.username', 'u.display_name', 'u.email',
        db.raw(`(SELECT COUNT(*) FROM account_users o JOIN hosting_accounts a ON a.id = o.account_id
                 WHERE o.user_id = u.id AND a.tenant_id = ?) AS account_count`, [account.tenant_id]))
      .orderBy('u.username')
      .limit(1000) as Array<{ id: number; username: string; display_name: string | null; email: string | null; account_count: number | string }>;
    return rows.map((r) => ({ userId: r.id, username: r.username, displayName: r.display_name, email: r.email, accountCount: Number(r.account_count ?? 0) }));
  },

  async get(accountId: number, userId: number): Promise<AccountClientUser> {
    const row = await selectClientUsers(accountId).where('u.id', userId).first() as ClientUserRow | undefined;
    if (!row) throw new AppError(404, 'User not found', 'notFound');
    return toClientUser(row);
  },

  /** Pre-checks of a new client user (409 usernameTaken / emailTaken). */
  async assertCreatable(input: Pick<ClientUserCreateBody, 'username' | 'email'>): Promise<void> {
    if (await db('users').whereRaw('lower(username) = lower(?)', [input.username]).first('id')) throw usernameTaken();
    if (input.email && await db('users').whereRaw('lower(email) = lower(?)', [input.email]).first('id')) throw emailTaken();
  },

  /**
   * Inserts a client user + its tenant membership + the account link inside
   * `trx`. Call assertCreatable first; unique violations still map to 409.
   */
  async createInTrx(trx: Knex.Transaction, account: Pick<AccountRow, 'id' | 'tenant_id'>, input: ClientUserCreateBody): Promise<number> {
    const passwordHash = await hashPassword(input.password);
    let userId: number;
    try {
      const [row] = await trx('users').insert({
        username: input.username,
        password_hash: passwordHash,
        display_name: input.displayName ?? null,
        email: input.email ?? null,
        role: 'user',
        kind: 'client',
        is_active: true,
      }).returning('id') as Array<{ id: number }>;
      userId = row.id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        const detail = String((err as { detail?: string; constraint?: string }).constraint ?? (err as { detail?: string }).detail ?? '');
        throw detail.includes('email') ? emailTaken() : usernameTaken();
      }
      throw err;
    }
    await trx('user_tenants').insert({ user_id: userId, tenant_id: account.tenant_id, role: CLIENT_MEMBERSHIP_ROLE })
      .onConflict(['user_id', 'tenant_id']).ignore();
    await trx('account_users').insert({ user_id: userId, account_id: account.id, capabilities: JSON.stringify(input.capabilities) });
    return userId;
  },

  /** POST /accounts/:id/users — create a client user, or attach an existing client of the same tenant. */
  async add(req: Request, account: AccountRow, body: ClientUserAddBody): Promise<AccountClientUser> {
    // accounts.manage alone must not mint a login with hosting rights the caller lacks.
    assertCanGrantClientCapabilities(await resolveActor(req), body.capabilities);
    let userId: number;
    if (body.mode === 'create') {
      await this.assertCreatable(body);
      userId = await db.transaction((trx) => this.createInTrx(trx, account, body));
    } else {
      // Only an active CLIENT already member of the account's tenant: never a
      // staff user, never someone of another tenant (same 404 for all cases).
      const target = await db('users as u')
        .join('user_tenants as ut', function joinTenant() {
          this.on('ut.user_id', '=', 'u.id').andOn('ut.tenant_id', '=', db.raw('?', [account.tenant_id]));
        })
        .where('u.id', body.userId)
        .first('u.id', 'u.kind', 'u.is_active') as { id: number; kind: string; is_active: boolean } | undefined;
      if (!target || target.kind !== 'client' || !target.is_active) throw new AppError(404, 'User not found', 'notFound');
      if (await db('account_users').where({ user_id: target.id, account_id: account.id }).first('user_id')) {
        throw new AppError(409, 'This user already has access to the account', 'alreadyMember');
      }
      await db('account_users').insert({ user_id: target.id, account_id: account.id, capabilities: JSON.stringify(body.capabilities) });
      userId = target.id;
    }
    const user = await this.get(account.id, userId);
    await auditService.logReqAs(req, account.tenant_id, 'account.user_add', {
      resourceType: 'account', resourcePath: String(account.id),
      details: { username: account.username, user: user.username, userId, mode: body.mode, capabilities: user.capabilities },
    });
    emitAccount(account);
    return user;
  },

  async updateCapabilities(req: Request, account: AccountRow, userId: number, capabilities: ClientCapability[]): Promise<AccountClientUser> {
    const before = await this.get(account.id, userId);
    // Only the capabilities ADDED need the caller's equivalents (removing never widens anything).
    const added = capabilities.filter((c) => !before.capabilities.includes(c));
    assertCanGrantClientCapabilities(await resolveActor(req), added);
    await db('account_users').where({ user_id: userId, account_id: account.id }).update({ capabilities: JSON.stringify(capabilities) });
    await auditService.logReqAs(req, account.tenant_id, 'account.user_update', {
      resourceType: 'account', resourcePath: String(account.id),
      details: { username: account.username, user: before.username, userId, from: before.capabilities, to: capabilities },
    });
    emitAccount(account);
    return this.get(account.id, userId);
  },

  /**
   * Unlinks a client user from the account. deleteUser: the user itself is
   * deleted when no other account remains (else only unlinked). The tenant
   * membership is dropped when no account of that tenant remains.
   */
  async remove(req: Request, account: AccountRow, userId: number, deleteUser: boolean): Promise<{ removed: true; userDeleted: boolean }> {
    const user = await this.get(account.id, userId);
    let userDeleted = false;
    await db.transaction(async (trx) => {
      await trx('account_users').where({ user_id: userId, account_id: account.id }).del();
      const remaining = await trx('account_users').where({ user_id: userId }).count('* as c').first() as { c: string | number };
      if (deleteUser && Number(remaining.c) === 0) {
        await trx('users').where({ id: userId, kind: 'client' }).del();
        userDeleted = true;
        return;
      }
      const inTenant = await trx('account_users as au').join('hosting_accounts as a', 'a.id', 'au.account_id')
        .where('au.user_id', userId).andWhere('a.tenant_id', account.tenant_id).first('au.account_id');
      if (!inTenant) {
        await trx('user_tenants').where({ user_id: userId, tenant_id: account.tenant_id, role: CLIENT_MEMBERSHIP_ROLE }).del();
      }
    });
    if (userDeleted) await killSessions(userId);
    else leaveAccountRoom(userId, account.id);
    await auditService.logReqAs(req, account.tenant_id, 'account.user_remove', {
      resourceType: 'account', resourcePath: String(account.id),
      details: { username: account.username, user: user.username, userId, userDeleted },
    });
    emitAccount(account);
    return { removed: true, userDeleted };
  },

  /** After an account deletion: delete the client users it left without any account. */
  async deleteOrphans(userIds: number[]): Promise<number[]> {
    if (userIds.length === 0) return [];
    const orphans = await db('users as u')
      .whereIn('u.id', userIds)
      .andWhere('u.kind', 'client')
      .whereNotExists(db('account_users as au').whereRaw('au.user_id = u.id').select(db.raw('1')))
      .pluck('u.id') as number[];
    if (orphans.length > 0) {
      await db('users').whereIn('id', orphans).andWhere('kind', 'client').del();
      for (const id of orphans) await killSessions(id);
    }
    return orphans;
  },
};

/**
 * A client unlinked from an account (user kept) leaves that account's Socket.io
 * room at once: the room was joined at handshake (socket.ts) and would keep
 * delivering the account's events until the socket reconnects.
 */
function leaveAccountRoom(userId: number, accountId: number): void {
  void import('../../socket').then(({ getIO }) => {
    getIO()?.in(`user:${userId}`).socketsLeave(`account:${accountId}`);
  }).catch((err) => { logger.debug({ err, userId, accountId }, 'socketsLeave failed'); });
}

async function killSessions(userId: number): Promise<void> {
  try {
    const { killSessionsForUser } = await import('../userSessions.service');
    await killSessionsForUser(userId, 'user_deleted');
  } catch (err) {
    logger.debug({ err, userId }, 'killSessionsForUser failed');
  }
}
