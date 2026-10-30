import type { RestrictableActionDef } from '@oblimint/shared';
import { MASTER_TENANT_ID, restrictableAction } from '@oblimint/shared';
import { db } from '../../db';
import { actorCan, actorForUser, type HostingActor, type HostingNeed } from '../hosting/access';
import { clientCapabilities } from '../hosting/rows';
import type { Recipient } from '../usage/userNotifications.service';
import type { RestrictionTarget } from './restriction.service';

// ─────────────────────────────────────────────────────────────────────────────
// Who may approve a 'restricted' action (spec §1.3). Computed from the
// database only, like the notification center's recipientsFor, with the
// same code as the API (actorForUser + actorCan):
//   - action on an account: client logins of that account holding the need,
//     staff of the tenant holding it, platform admins (god view);
//   - staff-only action: staff of the tenant holding the capability, platform admins;
//   - platform action: another platform admin.
// Always excluded: the requester (the acting user: a key's creator, the user
// who authorized a connector). Since an approver types his own code
// (owner decision 5), a user without any second factor cannot approve:
// he is not counted.
// Re-evaluated at decision time (canApprove): a right lost meanwhile → 403.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_APPROVERS = 500;

interface UserFactorRow {
  id: number;
  kind: string;
  role: string;
  is_active: boolean;
  totp_enabled: boolean | null;
  totp_secret: string | null;
  foreign_source: string | null;
  foreign_id: number | null;
}

const USER_COLS = ['id', 'kind', 'role', 'is_active', 'totp_enabled', 'totp_secret', 'foreign_source', 'foreign_id'];

/** Local TOTP, or an Obligate SSO staff account (its code is checked by Obligate, owner decision 3). */
export function hasSecondFactor(u: Pick<UserFactorRow, 'kind' | 'totp_enabled' | 'totp_secret' | 'foreign_source' | 'foreign_id'>): boolean {
  if (u.totp_enabled && u.totp_secret) return true;
  return u.kind !== 'client' && u.foreign_source === 'obligate' && Number(u.foreign_id) > 0;
}

/** Does a user (by id) have a usable second factor? */
export async function userHasSecondFactor(userId: number): Promise<boolean> {
  const u = await db('users').where({ id: userId }).first(...USER_COLS) as UserFactorRow | undefined;
  return !!u && u.is_active && hasSecondFactor(u);
}

function staffCapsGrant(actor: Extract<HostingActor, { kind: 'staff' }>, cap: string): boolean {
  return actor.caps === '*' || actor.caps.has(cap);
}

async function rightOf(u: UserFactorRow, def: RestrictableActionDef, target: RestrictionTarget): Promise<boolean> {
  const isPlatformAdmin = u.kind === 'staff' && u.role === 'admin';
  if (isPlatformAdmin) return true;
  if (def.platform) return false;
  const tenantId = target.tenantId;
  const accountId = target.accountId ?? null;
  const needs = [def.need, ...(def.alsoNeed ? [def.alsoNeed] : [])];

  if (u.kind === 'client') {
    if (def.staffOnly || !accountId) return false;
    const row = await db('account_users as au')
      .join('hosting_accounts as a', 'a.id', 'au.account_id')
      .where({ 'au.user_id': u.id, 'au.account_id': accountId, 'a.tenant_id': tenantId })
      .first('au.capabilities') as { capabilities: unknown } | undefined;
    if (!row) return false;
    const actor: HostingActor = { kind: 'client', userId: u.id, tenantId, accounts: new Map([[accountId, new Set(clientCapabilities(row.capabilities))]]) };
    return needs.every((n) => actorCan(actor, n as HostingNeed, { tenantId, accountId }));
  }

  const member = await db('user_tenants').where({ user_id: u.id, tenant_id: tenantId }).first('user_id');
  if (!member) return false;
  let actor: HostingActor;
  try { actor = await actorForUser(u.id, tenantId); } catch { return false; }
  if (actor.kind !== 'staff') return false;
  if (def.staffOnly) return needs.every((n) => staffCapsGrant(actor as Extract<HostingActor, { kind: 'staff' }>, n));
  return needs.every((n) => actorCan(actor, n as HostingNeed, { tenantId, accountId }));
}

async function eligible(u: UserFactorRow | undefined, def: RestrictableActionDef, target: RestrictionTarget, requesterId: number): Promise<boolean> {
  if (!u || !u.is_active || Number(u.id) === Number(requesterId)) return false;
  if (!hasSecondFactor(u)) return false;
  return rightOf(u, def, target);
}

/** May `userId` approve `def` on `target` requested by `requesterId`? */
export async function isEligibleApprover(userId: number, def: RestrictableActionDef, target: RestrictionTarget, requesterId: number): Promise<boolean> {
  const u = await db('users').where({ id: userId }).first(...USER_COLS) as UserFactorRow | undefined;
  return eligible(u, def, target, requesterId);
}

/** Everyone who may approve (capped), as notification recipients. */
export async function eligibleApprovers(def: RestrictableActionDef, target: RestrictionTarget, requesterId: number): Promise<Recipient[]> {
  const out = new Map<number, Recipient>();
  const tenantId = target.tenantId;
  const accountId = target.accountId ?? null;
  const consider = async (rows: UserFactorRow[], tenantOf: (u: UserFactorRow) => number) => {
    for (const u of rows) {
      if (out.size >= MAX_APPROVERS || out.has(Number(u.id))) continue;
      if (await eligible(u, def, target, requesterId)) {
        out.set(Number(u.id), { userId: Number(u.id), tenantId: tenantOf(u), kind: u.kind === 'client' ? 'client' : 'staff' });
      }
    }
  };
  if (!def.platform) {
    if (accountId && !def.staffOnly) {
      const clients = await db('account_users as au')
        .join('hosting_accounts as a', 'a.id', 'au.account_id')
        .join('users as u', 'u.id', 'au.user_id')
        .where({ 'au.account_id': accountId, 'a.tenant_id': tenantId, 'u.kind': 'client', 'u.is_active': true })
        .orderBy('u.id').limit(MAX_APPROVERS)
        .select(USER_COLS.map((c) => `u.${c}`)) as UserFactorRow[];
      await consider(clients, () => tenantId);
    }
    const staff = await db('user_tenants as ut')
      .join('users as u', 'u.id', 'ut.user_id')
      .where({ 'ut.tenant_id': tenantId, 'u.kind': 'staff', 'u.is_active': true })
      .orderBy('u.id').limit(MAX_APPROVERS)
      .select(USER_COLS.map((c) => `u.${c}`)) as UserFactorRow[];
    // A platform admin who is a member of the tenant is notified in that tenant.
    await consider(staff, () => tenantId);
  }
  const admins = await db('users').where({ role: 'admin', kind: 'staff', is_active: true }).orderBy('id').limit(MAX_APPROVERS)
    .select(USER_COLS) as UserFactorRow[];
  await consider(admins, () => MASTER_TENANT_ID);
  return [...out.values()];
}

/** Decision time: the approver's eligibility on the stored request, recomputed. */
export async function canApprove(userId: number, row: { action_key: string; tenant_id: number; account_id: number | null; site_id: number | null; requested_by: number }): Promise<boolean> {
  const def = restrictableAction(row.action_key);
  if (!def) return false;
  return isEligibleApprover(userId, def, { tenantId: row.tenant_id, accountId: row.account_id, siteId: row.site_id }, row.requested_by);
}
