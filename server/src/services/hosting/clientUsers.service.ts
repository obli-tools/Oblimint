import type { Request } from 'express';
import type { Knex } from 'knex';
import type { AccountClientUser, AccountClientUserUpdate, ClientCapability, ClientUserCandidate } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { hashPassword } from '../../utils/crypto';
import { logger } from '../../utils/logger';
import type { ClientUserAddBody, ClientUserCreateBody } from '../../validators/hosting.schema';
import { auditService } from '../audit.service';
import { accountContained } from '../containment/guard';
import { CLIENT_MEMBERSHIP_ROLE } from '../permission.service';
import { userService } from '../user.service';
import { actorForUser, assertCanGrantClientCapabilities, resolveActor, type HostingActor } from './access';
import {
  assertClientMayGrant, assertNotSelf, clientDominanceRefusal, clientLoginRefusal, rowFlags, staffLoginRefusal,
  type LoginMembership, type StaffActor, type StaffCapsIn,
} from './clientTeam';
import { emitHosting } from './events';
import { isUniqueViolation } from './hostingValidation.service';
import { clientCapabilities, iso, type AccountRow } from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// Client users of a hosting account (users.kind = 'client'): local accounts
// only (never Obligate, never admin — DB CHECKs of migration 001), member of
// the account's tenant with the 'client' permission set (no tenant
// capability), rights = account_users.capabilities.
//
// Managed by STAFF with accounts.manage, and by a CLIENT holding the
// capability users.manage on the account (its team) — the need
// 'users.manage' of access.ts. The anti-escalation rules (never itself,
// only logins whose rights it holds, a shared login only if it controls
// every account of it, grants ⊆ its own rights) live in clientTeam.ts.
// Operations:
//   list / candidates / add (create or attach) / update (capabilities on the
//   account + profile of the login) / setPassword / setActive / remove.
// Every change is audited (account.user_*) and announced on the account's
// room (HOSTING_CHANGED); a password change or a disable ends the login's
// sessions. A password is never logged (the route gates it as a secret).
// ─────────────────────────────────────────────────────────────────────────────

/** Permission set of client memberships (seeded by migration 002). */
export { CLIENT_MEMBERSHIP_ROLE };

interface ClientUserRow {
  id: number; username: string; display_name: string | null; email: string | null; is_active: boolean;
  totp_enabled: boolean; capabilities: unknown; other_account_count: number | string; created_at: Date | string;
}

type RowFlags = Pick<AccountClientUser, 'isSelf' | 'manageable' | 'loginManageable'>;

/** Without a caller (internal reads): nothing is offered. */
const NO_FLAGS: RowFlags = { isSelf: false, manageable: false, loginManageable: false };

function toClientUser(r: ClientUserRow, flags: RowFlags = NO_FLAGS): AccountClientUser {
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
    ...flags,
  };
}

function selectClientUsers(accountId: number) {
  return db('account_users as au')
    .join('users as u', 'u.id', 'au.user_id')
    .where('au.account_id', accountId)
    .andWhere('u.kind', 'client')
    .select('u.id', 'u.username', 'u.display_name', 'u.email', 'u.is_active', 'u.totp_enabled', 'au.capabilities', 'au.created_at',
      db.raw('(SELECT COUNT(*) FROM account_users o WHERE o.user_id = u.id AND o.account_id <> au.account_id) AS other_account_count'));
}

function usernameTaken(): AppError {
  return new AppError(409, 'This user name is already taken', 'usernameTaken');
}

function emailTaken(): AppError {
  return new AppError(409, 'This e-mail address is already used by another user', 'emailTaken');
}

function emitAccount(account: Pick<AccountRow, 'id' | 'tenant_id'>): void {
  emitHosting(HostingSocketEvents.HOSTING_CHANGED, { entity: 'account', id: account.id, accountId: account.id, action: 'updated' },
    { tenantId: account.tenant_id, accountId: account.id });
}

/** A change of the LOGIN shows in the users list of every account it belongs to. */
function emitAccounts(memberships: readonly LoginMembership[]): void {
  for (const m of memberships) emitAccount({ id: m.accountId, tenant_id: m.tenantId });
}

type Membership = LoginMembership & { contained: boolean };

/** Every account of each login (all tenants), with the capabilities there. */
async function membershipsOf(userIds: number[]): Promise<Map<number, Membership[]>> {
  const out = new Map<number, Membership[]>();
  if (userIds.length === 0) return out;
  const rows = await db('account_users as au')
    .join('hosting_accounts as a', 'a.id', 'au.account_id')
    .whereIn('au.user_id', userIds)
    .select('au.user_id', 'au.account_id', 'a.tenant_id', 'a.contained_at', 'au.capabilities') as
    Array<{ user_id: number; account_id: number; tenant_id: number; contained_at: Date | string | null; capabilities: unknown }>;
  for (const r of rows) {
    const list = out.get(Number(r.user_id)) ?? [];
    list.push({ accountId: Number(r.account_id), tenantId: Number(r.tenant_id), capabilities: clientCapabilities(r.capabilities), contained: !!r.contained_at });
    out.set(Number(r.user_id), list);
  }
  return out;
}

async function membershipsOfOne(userId: number): Promise<Membership[]> {
  return (await membershipsOf([userId])).get(userId) ?? [];
}

/** The staff actor's capabilities in another tenant (cached for one operation). */
function staffCapsResolver(actor: StaffActor): StaffCapsIn {
  const cache = new Map<number, Promise<'*' | ReadonlySet<string> | null>>();
  return (tenantId) => {
    let p = cache.get(tenantId);
    if (!p) {
      p = actorForUser(actor.userId, tenantId)
        .then((a) => (a.kind === 'staff' ? a.caps : null))
        .catch(() => null);
      cache.set(tenantId, p);
    }
    return p;
  };
}

/** May the actor change the login itself (profile, password, active)? Throws the refusal. */
async function assertControlsLogin(actor: HostingActor, account: Pick<AccountRow, 'id'>, target: AccountClientUser, memberships: readonly LoginMembership[]): Promise<void> {
  if (actor.kind === 'client') {
    const refusal = clientDominanceRefusal(actor, account.id, target.capabilities) ?? clientLoginRefusal(actor, memberships);
    if (refusal) throw refusal;
    return;
  }
  const refusal = await staffLoginRefusal(actor, memberships, staffCapsResolver(actor));
  if (refusal) throw refusal;
}

/** May the actor touch the target's membership of the account (capabilities, removal)? Throws the refusal. */
function assertControlsMembership(actor: HostingActor, account: Pick<AccountRow, 'id'>, target: AccountClientUser): void {
  if (actor.kind !== 'client') return;
  const refusal = clientDominanceRefusal(actor, account.id, target.capabilities);
  if (refusal) throw refusal;
}

/** What opens a way in (password, enable, e-mail) waits while any account of the login is contained. */
function assertLoginNotContained(memberships: readonly Membership[]): void {
  if (memberships.some((m) => m.contained)) throw accountContained();
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

const lower = (v: string | null | undefined): string | null => (v ? v.trim().toLowerCase() : null);

export const clientUsersService = {
  /** Users of the account; with `actor`, each row carries what that caller may do on it. */
  async list(accountId: number, actor?: HostingActor): Promise<AccountClientUser[]> {
    const rows = await selectClientUsers(accountId).orderBy('u.username') as ClientUserRow[];
    if (!actor) return rows.map((r) => toClientUser(r));
    const memberships = await membershipsOf(rows.map((r) => Number(r.id)));
    const capsIn = actor.kind === 'staff' ? staffCapsResolver(actor) : async () => null;
    const out: AccountClientUser[] = [];
    for (const r of rows) {
      const flags = await rowFlags(actor, accountId, { userId: Number(r.id), capabilities: clientCapabilities(r.capabilities) },
        memberships.get(Number(r.id)) ?? [], capsIn);
      out.push(toClientUser(r, flags));
    }
    return out;
  },

  /**
   * Logins that "attach existing" may pick, not on this account yet.
   * Staff: active CLIENT users member of the account's tenant (never staff,
   * never another tenant: same rule as add()) — including logins detached
   * from every account. Client: only the logins of the OTHER accounts where
   * it holds users.manage (never the tenant's directory).
   */
  async candidates(account: Pick<AccountRow, 'id' | 'tenant_id'>, actor?: HostingActor): Promise<ClientUserCandidate[]> {
    let q = db('users as u')
      .where('u.kind', 'client')
      .andWhere('u.is_active', true)
      .whereNotExists(db('account_users as au').whereRaw('au.user_id = u.id').andWhere('au.account_id', account.id));
    if (actor?.kind === 'client') {
      const managed = [...actor.accounts].filter(([id, caps]) => id !== account.id && caps.has('users.manage')).map(([id]) => id);
      if (managed.length === 0 || actor.tenantId !== account.tenant_id) return [];
      q = q.whereExists(db('account_users as m').join('hosting_accounts as ma', 'ma.id', 'm.account_id')
        .whereRaw('m.user_id = u.id').whereIn('m.account_id', managed).andWhere('ma.tenant_id', account.tenant_id));
    } else {
      q = q.join('user_tenants as ut', 'ut.user_id', 'u.id').andWhere('ut.tenant_id', account.tenant_id);
    }
    const rows = await q
      .select('u.id', 'u.username', 'u.display_name', 'u.email',
        db.raw(`(SELECT COUNT(*) FROM account_users o JOIN hosting_accounts a ON a.id = o.account_id
                 WHERE o.user_id = u.id AND a.tenant_id = ?) AS account_count`, [account.tenant_id]))
      .orderBy('u.username')
      .limit(1000) as Array<{ id: number; username: string; display_name: string | null; email: string | null; account_count: number | string }>;
    return rows.map((r) => ({ userId: r.id, username: r.username, displayName: r.display_name, email: r.email, accountCount: Number(r.account_count ?? 0) }));
  },

  /** One user of the account (404 otherwise); with `actor`, its flags for that caller. */
  async get(accountId: number, userId: number, actor?: HostingActor): Promise<AccountClientUser> {
    const row = await selectClientUsers(accountId).where('u.id', userId).first() as ClientUserRow | undefined;
    if (!row) throw new AppError(404, 'User not found', 'notFound');
    if (!actor) return toClientUser(row);
    const capsIn = actor.kind === 'staff' ? staffCapsResolver(actor) : async () => null;
    return toClientUser(row, await rowFlags(actor, accountId, { userId: Number(row.id), capabilities: clientCapabilities(row.capabilities) },
      await membershipsOfOne(Number(row.id)), capsIn));
  },

  /** Pre-checks of a new client user (409 usernameTaken / emailTaken). */
  async assertCreatable(input: Pick<ClientUserCreateBody, 'username' | 'email'>): Promise<void> {
    if (await db('users').whereRaw('lower(username) = lower(?)', [input.username]).first('id')) throw usernameTaken();
    if (input.email && await db('users').whereRaw('lower(email) = lower(?)', [input.email]).first('id')) throw emailTaken();
  },

  /**
   * Inserts a client user + its tenant membership + the account link inside
   * `trx`. Call assertCreatable first; unique violations still map to 409.
   * `trustedEmail`: written by the staff — trusted as verified; an address
   * typed by a client stays unverified (no reset link goes to it until the
   * user confirms it from its profile).
   */
  async createInTrx(trx: Knex.Transaction, account: Pick<AccountRow, 'id' | 'tenant_id'>, input: ClientUserCreateBody, opts: { trustedEmail?: boolean } = {}): Promise<number> {
    const passwordHash = await hashPassword(input.password);
    const trustedEmail = opts.trustedEmail ?? true;
    let userId: number;
    try {
      const [row] = await trx('users').insert({
        username: input.username,
        password_hash: passwordHash,
        display_name: input.displayName ?? null,
        email: input.email ?? null,
        email_verified_for: input.email && trustedEmail ? input.email.trim().toLowerCase() : null,
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

  /**
   * Checks of POST /accounts/:id/users without any side effect (the route
   * runs them BEFORE the gate: nobody is asked to confirm or approve what
   * will be refused anyway). add() runs them again.
   */
  async authorizeAdd(req: Request, account: AccountRow, body: ClientUserAddBody): Promise<{ actor: HostingActor; attachId: number | null }> {
    const actor = await resolveActor(req);
    // Never a login with rights the caller lacks: staff → staff equivalents, client → its own capabilities on the account.
    if (actor.kind === 'client') assertClientMayGrant(actor, account.id, body.capabilities);
    else assertCanGrantClientCapabilities(actor, body.capabilities);
    if (body.mode === 'create') {
      await this.assertCreatable(body);
      return { actor, attachId: null };
    }
    // Only an active CLIENT already member of the account's tenant: never a
    // staff user, never someone of another tenant (same 404 for all cases).
    const target = await db('users as u')
      .join('user_tenants as ut', function joinTenant() {
        this.on('ut.user_id', '=', 'u.id').andOn('ut.tenant_id', '=', db.raw('?', [account.tenant_id]));
      })
      .where('u.id', body.userId)
      .first('u.id', 'u.kind', 'u.is_active') as { id: number; kind: string; is_active: boolean } | undefined;
    if (!target || target.kind !== 'client' || !target.is_active) throw new AppError(404, 'User not found', 'notFound');
    if (actor.kind === 'client') {
      // A client only attaches a login of another account whose users it manages (same 404 otherwise).
      const managed = [...actor.accounts].filter(([id, caps]) => id !== account.id && caps.has('users.manage')).map(([id]) => id);
      const visible = managed.length > 0 && await db('account_users').where('user_id', target.id).whereIn('account_id', managed).first('account_id');
      if (!visible) throw new AppError(404, 'User not found', 'notFound');
    }
    if (await db('account_users').where({ user_id: target.id, account_id: account.id }).first('user_id')) {
      throw new AppError(409, 'This user already has access to the account', 'alreadyMember');
    }
    return { actor, attachId: target.id };
  },

  /** POST /accounts/:id/users — create a client user, or attach an existing client of the same tenant. */
  async add(req: Request, account: AccountRow, body: ClientUserAddBody): Promise<AccountClientUser> {
    const { actor, attachId } = await this.authorizeAdd(req, account, body);
    let userId: number;
    if (body.mode === 'create') {
      userId = await db.transaction((trx) => this.createInTrx(trx, account, body, { trustedEmail: actor.kind === 'staff' }));
    } else {
      userId = attachId as number;
      try {
        await db('account_users').insert({ user_id: userId, account_id: account.id, capabilities: JSON.stringify(body.capabilities) });
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError(409, 'This user already has access to the account', 'alreadyMember');
        throw err;
      }
    }
    const user = await this.get(account.id, userId, actor);
    await auditService.logReqAs(req, account.tenant_id, 'account.user_add', {
      resourceType: 'account', resourcePath: String(account.id),
      details: { username: account.username, user: user.username, userId, mode: body.mode, capabilities: user.capabilities, by: actor.kind },
    });
    emitAccount(account);
    return user;
  },

  /**
   * PUT /accounts/:id/users/:userId — capabilities on the account and / or
   * the login's profile (display name, e-mail). Only what actually changes
   * is checked: capabilities need the membership rules, the profile the
   * login rules (clientTeam.ts).
   */
  async authorizeUpdate(req: Request, account: AccountRow, userId: number, body: AccountClientUserUpdate): Promise<{
    actor: HostingActor; before: AccountClientUser; caps: ClientCapability[] | undefined;
    profile: { display_name?: string | null; email?: string | null }; memberships: Membership[];
  }> {
    const actor = await resolveActor(req);
    assertNotSelf(actor, userId);
    const before = await this.get(account.id, userId);
    const caps = body.capabilities !== undefined && !sameSet(body.capabilities, before.capabilities) ? body.capabilities : undefined;
    const profile: { display_name?: string | null; email?: string | null } = {};
    if (body.displayName !== undefined && (body.displayName ?? null) !== (before.displayName ?? null)) profile.display_name = body.displayName ?? null;
    if (body.email !== undefined && lower(body.email) !== lower(before.email)) profile.email = lower(body.email);
    const profileChanged = Object.keys(profile).length > 0;
    if (caps === undefined && !profileChanged) return { actor, before, caps, profile, memberships: [] };

    assertControlsMembership(actor, account, before);
    if (caps !== undefined) {
      if (actor.kind === 'client') assertClientMayGrant(actor, account.id, caps);
      // Staff: only the capabilities ADDED need the caller's equivalents (removing never widens anything).
      else assertCanGrantClientCapabilities(actor, caps.filter((c) => !before.capabilities.includes(c)));
    }
    let memberships: Membership[] = [];
    if (profileChanged) {
      memberships = await membershipsOfOne(userId);
      await assertControlsLogin(actor, account, before, memberships);
      // A new address may receive a reset link: never while an account of the login is contained.
      if ('email' in profile) {
        assertLoginNotContained(memberships);
        if (profile.email && await db('users').whereRaw('lower(email) = ?', [profile.email]).whereNot('id', userId).first('id')) throw emailTaken();
      }
    }
    return { actor, before, caps, profile, memberships };
  },

  async update(req: Request, account: AccountRow, userId: number, body: AccountClientUserUpdate): Promise<AccountClientUser> {
    const { actor, before, caps, profile, memberships } = await this.authorizeUpdate(req, account, userId, body);
    const profileChanged = Object.keys(profile).length > 0;
    if (caps === undefined && !profileChanged) return this.get(account.id, userId, actor);
    try {
      await db.transaction(async (trx) => {
        if (profileChanged) {
          const patch: Record<string, unknown> = { ...profile, updated_at: new Date() };
          // Written by the staff: trusted as verified; typed by a client: to be confirmed by the user.
          if ('email' in profile) patch.email_verified_for = profile.email && actor.kind === 'staff' ? profile.email : null;
          await trx('users').where({ id: userId, kind: 'client' }).update(patch);
        }
        if (caps !== undefined) {
          await trx('account_users').where({ user_id: userId, account_id: account.id }).update({ capabilities: JSON.stringify(caps) });
        }
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw emailTaken();
      throw err;
    }
    const details: Record<string, unknown> = { username: account.username, user: before.username, userId, by: actor.kind };
    if (caps !== undefined) Object.assign(details, { from: before.capabilities, to: caps });
    if ('display_name' in profile) details.displayName = { from: before.displayName, to: profile.display_name };
    if ('email' in profile) details.email = { from: before.email, to: profile.email };
    await auditService.logReqAs(req, account.tenant_id, 'account.user_update', { resourceType: 'account', resourcePath: String(account.id), details });
    if (profileChanged) emitAccounts(memberships);
    else emitAccount(account);
    return this.get(account.id, userId, actor);
  },

  /** Capabilities only (kept for the callers of P1). */
  async updateCapabilities(req: Request, account: AccountRow, userId: number, capabilities: ClientCapability[]): Promise<AccountClientUser> {
    return this.update(req, account, userId, { capabilities });
  },

  /**
   * Checks of a LOGIN operation (password, active) without side effect:
   * never itself, controls the login everywhere, nothing that opens a way in
   * while an account of the login is contained.
   */
  async authorizeLogin(req: Request, account: AccountRow, userId: number, opensWayIn: boolean): Promise<{ actor: HostingActor; before: AccountClientUser; memberships: Membership[] }> {
    const actor = await resolveActor(req);
    assertNotSelf(actor, userId);
    const before = await this.get(account.id, userId);
    const memberships = await membershipsOfOne(userId);
    await assertControlsLogin(actor, account, before, memberships);
    if (opensWayIn) assertLoginNotContained(memberships);
    return { actor, before, memberships };
  },

  /** PUT /accounts/:id/users/:userId/password — sets the login's password and ends its sessions. Never logged. */
  async setPassword(req: Request, account: AccountRow, userId: number, password: string): Promise<{ updated: true }> {
    const { actor, before } = await this.authorizeLogin(req, account, userId, true);
    if (!(await userService.changePassword(userId, password))) throw new AppError(404, 'User not found', 'notFound');
    await killSessions(userId, 'password_reset');
    await auditService.logReqAs(req, account.tenant_id, 'account.user_password', {
      resourceType: 'account', resourcePath: String(account.id),
      details: { username: account.username, user: before.username, userId, by: actor.kind },
    });
    emitAccount(account);
    return { updated: true };
  },

  /** PUT /accounts/:id/users/:userId/active — disables (sessions ended) or enables the login. */
  async setActive(req: Request, account: AccountRow, userId: number, active: boolean): Promise<AccountClientUser> {
    const { actor, before, memberships } = await this.authorizeLogin(req, account, userId, active);
    if (before.isActive !== active) {
      await db('users').where({ id: userId, kind: 'client' }).update({ is_active: active, updated_at: new Date() });
      if (!active) await killSessions(userId, 'user_disabled');
      await auditService.logReqAs(req, account.tenant_id, active ? 'account.user_enable' : 'account.user_disable', {
        resourceType: 'account', resourcePath: String(account.id),
        details: { username: account.username, user: before.username, userId, by: actor.kind },
      });
      emitAccounts(memberships);
    }
    return this.get(account.id, userId, actor);
  },

  /**
   * Unlinks a client user from the account. deleteUser: the user itself is
   * deleted when no other account remains (else only unlinked). The tenant
   * membership is dropped when no account of that tenant remains.
   */
  /** Checks of DELETE /accounts/:id/users/:userId without side effect. */
  async authorizeRemove(req: Request, account: AccountRow, userId: number): Promise<{ actor: HostingActor; user: AccountClientUser }> {
    const actor = await resolveActor(req);
    assertNotSelf(actor, userId);
    const user = await this.get(account.id, userId);
    // The login is only deleted when this account was its last one: the membership rule covers it.
    assertControlsMembership(actor, account, user);
    return { actor, user };
  },

  async remove(req: Request, account: AccountRow, userId: number, deleteUser: boolean): Promise<{ removed: true; userDeleted: boolean }> {
    const { actor, user } = await this.authorizeRemove(req, account, userId);
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
    if (userDeleted) await killSessions(userId, 'user_deleted');
    else leaveAccountRoom(userId, account.id);
    await auditService.logReqAs(req, account.tenant_id, 'account.user_remove', {
      resourceType: 'account', resourcePath: String(account.id),
      details: { username: account.username, user: user.username, userId, userDeleted, by: actor.kind },
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
      for (const id of orphans) await killSessions(id, 'user_deleted');
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

async function killSessions(userId: number, reason: string): Promise<void> {
  try {
    const { killSessionsForUser } = await import('../userSessions.service');
    await killSessionsForUser(userId, reason);
  } catch (err) {
    logger.debug({ err, userId }, 'killSessionsForUser failed');
  }
}
