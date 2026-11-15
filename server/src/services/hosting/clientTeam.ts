import type { ClientCapability } from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';
import { staffEquivalentOf, type HostingActor } from './access';

// ─────────────────────────────────────────────────────────────────────────────
// Who may manage which customer login of an account (anti-escalation rules of
// the account's team). Pure functions: the service (clientUsers.service.ts)
// loads the facts, these decide. The same functions compute the per-row
// flags of GET /accounts/:id/users (manageable / loginManageable).
//
// Two levels of operations on a target login T of account A:
//   - on its MEMBERSHIP of A: capabilities on A, removal from A;
//   - on the LOGIN itself, which is global (every account it belongs to):
//     profile (display name, e-mail), password, disable / enable, deletion.
//
// Client actor (users.manage on A — loadAccount(…, 'users.manage')):
//   - never itself (capabilities, profile, password, disable, removal: its
//     own profile / password are changed from its profile page);
//   - T's capabilities on A ⊆ the actor's on A (it never touches someone who
//     holds what it does not);
//   - capabilities it grants on A ⊆ its own on A (the whole new set);
//   - LOGIN operations: for EVERY account T belongs to, the actor holds
//     users.manage there (same tenant) with T's capabilities there ⊆ its own;
//     otherwise 403 sharedLoginNotManaged — T can only be removed from A;
//   - attach: only a login already member of another account where the actor
//     holds users.manage (never the tenant's directory).
// Staff actor (accounts.manage on A):
//   - capabilities it grants: the staff equivalent of every capability ADDED
//     (assertCanGrantClientCapabilities, unchanged);
//   - LOGIN operations (taking the login over: password, e-mail, and also
//     display name, disable / enable, one rule for all): in every tenant
//     where T has an account, the actor holds accounts.manage and the staff
//     equivalents of T's capabilities there (a platform admin: always).
//     Another tenant it is not staff of → 403 sharedLoginNotManaged.
// Deleting the login (remove with deleteUser) only happens when A was its
// last account: the membership rule covers it, for both actors.
// Contained accounts: a client actor is refused upstream (its capabilities
// are off, loadAccount answers 423); what opens a way in (add, password,
// enable, e-mail) is refused while ANY account of the login is contained.
// ─────────────────────────────────────────────────────────────────────────────

export type ClientActor = Extract<HostingActor, { kind: 'client' }>;
export type StaffActor = Extract<HostingActor, { kind: 'staff' }>;

/** One account a target login belongs to (account_users row joined to its account). */
export interface LoginMembership {
  accountId: number;
  tenantId: number;
  capabilities: readonly ClientCapability[];
}

/** Staff capabilities of the actor in a tenant ('*' = all; null = not staff there). */
export type StaffCapsIn = (tenantId: number) => Promise<'*' | ReadonlySet<string> | null>;

export const TEAM_ERROR_CODES = {
  self: 'cannotManageSelf',
  notDominated: 'userNotDominated',
  notHeld: 'capabilityNotHeld',
  shared: 'sharedLoginNotManaged',
} as const;

/** Capabilities of a client actor on one account (empty when it is not a member). */
export function clientCapsOn(actor: ClientActor, accountId: number): ReadonlySet<ClientCapability> {
  return actor.accounts.get(accountId) ?? new Set<ClientCapability>();
}

/** Items of `wanted` missing from `held` (sorted, unique). */
export function missingFrom(wanted: Iterable<string>, held: ReadonlySet<string>): string[] {
  return [...new Set([...wanted].filter((c) => !held.has(c)))].sort();
}

export function selfRefusal(): AppError {
  return new AppError(403, 'You cannot change your own access from this screen: use your profile', TEAM_ERROR_CODES.self);
}

/** 403 when a client actor targets its own login. */
export function assertNotSelf(actor: HostingActor, userId: number): void {
  if (actor.kind === 'client' && Number(actor.userId) === Number(userId)) throw selfRefusal();
}

/** 403 capabilityNotHeld unless every capability granted on the account is held by the client actor there. */
export function assertClientMayGrant(actor: ClientActor, accountId: number, caps: Iterable<string>): void {
  const missing = missingFrom(caps, clientCapsOn(actor, accountId));
  if (missing.length > 0) {
    throw new AppError(403, `You cannot grant rights you do not hold (${missing.join(', ')})`, TEAM_ERROR_CODES.notHeld, { missing });
  }
}

/** Refusal when the target holds, on the account, capabilities the client actor lacks there (null = allowed). */
export function clientDominanceRefusal(actor: ClientActor, accountId: number, targetCaps: Iterable<string>): AppError | null {
  const missing = missingFrom(targetCaps, clientCapsOn(actor, accountId));
  if (missing.length === 0) return null;
  return new AppError(403, `This user has rights you do not hold (${missing.join(', ')})`, TEAM_ERROR_CODES.notDominated, { missing });
}

/**
 * Refusal of a LOGIN operation by a client actor (null = allowed): the actor
 * holds users.manage on every account of the login, in its tenant, with the
 * login's capabilities there ⊆ its own.
 */
export function clientLoginRefusal(actor: ClientActor, memberships: readonly LoginMembership[]): AppError | null {
  const blocked: number[] = [];
  for (const m of memberships) {
    if (Number(m.tenantId) !== Number(actor.tenantId)) { blocked.push(m.accountId); continue; }
    const held = clientCapsOn(actor, m.accountId);
    if (!held.has('users.manage') || missingFrom(m.capabilities, held).length > 0) blocked.push(m.accountId);
  }
  if (blocked.length === 0) return null;
  return new AppError(403,
    'This login also belongs to accounts whose users you do not manage: you can only remove it from this account',
    TEAM_ERROR_CODES.shared, { accounts: blocked.length });
}

/**
 * Refusal of a LOGIN operation by a staff actor (null = allowed): in every
 * tenant where the login has an account, accounts.manage and the staff
 * equivalents of its capabilities there.
 */
export async function staffLoginRefusal(actor: StaffActor, memberships: readonly LoginMembership[], capsIn: StaffCapsIn): Promise<AppError | null> {
  if (actor.caps === '*' && actor.globalView) return null;
  const byTenant = new Map<number, Set<string>>();
  for (const m of memberships) {
    const caps = byTenant.get(Number(m.tenantId)) ?? new Set<string>();
    for (const c of m.capabilities) caps.add(c);
    byTenant.set(Number(m.tenantId), caps);
  }
  for (const [tenantId, targetCaps] of byTenant) {
    const held = tenantId === Number(actor.tenantId) ? actor.caps : await capsIn(tenantId);
    if (held === '*') continue;
    const elsewhere = tenantId !== Number(actor.tenantId);
    if (!held || !held.has('accounts.manage')) {
      return new AppError(403,
        'This login also belongs to accounts of another workspace you do not manage: you can only remove it from this account',
        TEAM_ERROR_CODES.shared, { accounts: memberships.filter((m) => Number(m.tenantId) === tenantId).length });
    }
    const missing = missingFrom(staffEquivalentOf(targetCaps), held);
    if (missing.length > 0) {
      if (elsewhere) {
        return new AppError(403,
          'This login also belongs to accounts of another workspace where it holds rights you do not: you can only remove it from this account',
          TEAM_ERROR_CODES.shared, { missing });
      }
      return new AppError(403, `This login holds rights you do not hold (${missing.join(', ')})`, TEAM_ERROR_CODES.notHeld, { missing });
    }
  }
  return null;
}

/** Flags of one row of the users list, for the caller (the server re-checks every operation). */
export async function rowFlags(
  actor: HostingActor, accountId: number, target: { userId: number; capabilities: readonly ClientCapability[] },
  memberships: readonly LoginMembership[], capsIn: StaffCapsIn,
): Promise<{ isSelf: boolean; manageable: boolean; loginManageable: boolean }> {
  if (actor.kind === 'client') {
    const isSelf = Number(actor.userId) === Number(target.userId);
    const manageable = !isSelf && clientDominanceRefusal(actor, accountId, target.capabilities) === null;
    return { isSelf, manageable, loginManageable: manageable && clientLoginRefusal(actor, memberships) === null };
  }
  return { isSelf: false, manageable: true, loginManageable: (await staffLoginRefusal(actor, memberships, capsIn)) === null };
}
