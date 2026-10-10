import type { BansSettings } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Escalation of the web bans (docs/P4b-PLAN.md §9.3) — PURE (escalation.test.ts).
//
//  - offences are counted per (ip, account) in web_ban_offenses (account 0 =
//    platform history); an offence older than bans.escalationWindowDays
//    restarts the ladder at level 1;
//  - duration of level n = bans.escalation[n-1] minutes (null = permanent),
//    past the end of the ladder: its last value;
//  - a proxy host's honeypot.banDurationMinutes is a FLOOR (its first step at
//    least, and never shorter at the next levels); null = the ladder alone;
//  - a repeat while a ban is active does not climb the ladder (the same burst:
//    nginx closes the next requests already); it extends the ban when the
//    duration of the current level ends later.
// ─────────────────────────────────────────────────────────────────────────────

export const DAY_MS = 86_400_000;

/** Level of a new offence given the previous counter and its date. */
export function nextOffenceLevel(prev: { offenses: number; lastOffenseAt: Date } | null, now: Date, windowDays: number): number {
  if (!prev || !Number.isFinite(prev.offenses) || prev.offenses < 1) return 1;
  const windowMs = Math.max(1, windowDays) * DAY_MS;
  if (now.getTime() - prev.lastOffenseAt.getTime() > windowMs) return 1;
  return Math.min(prev.offenses + 1, 1_000_000);
}

/** Minutes for a level (null = permanent). */
export function durationForLevel(level: number, s: Pick<BansSettings, 'escalation'>, floorMinutes: number | null = null): number | null {
  const ladder = Array.isArray(s.escalation) && s.escalation.length > 0 ? s.escalation : [60];
  const i = Math.min(Math.max(1, Math.floor(level)), ladder.length) - 1;
  const step = ladder[i];
  if (step === null) return null;
  const floor = Number.isInteger(floorMinutes) && (floorMinutes as number) > 0 ? (floorMinutes as number) : 0;
  return Math.max(step, floor);
}

/** End of a ban of `minutes` from now (null = permanent). */
export function banUntil(now: Date, minutes: number | null): Date | null {
  return minutes === null ? null : new Date(now.getTime() + minutes * 60_000);
}

/** true when `candidate` ends later than `current` (null = permanent = latest). */
export function endsLater(candidate: Date | null, current: Date | null): boolean {
  if (current === null) return false;
  if (candidate === null) return true;
  return candidate.getTime() > current.getTime();
}

/**
 * Same IP banned BY THE HONEYPOT (never a manual ban) on at least this many
 * accounts of at least this many independent principals within the window ⇒
 * platform ban (promotion). A principal is whoever can steer the bans of an
 * account: a reseller tenant as a whole (its staff controls every account of
 * it), and, in the master tenant, the group of accounts linked by a common
 * client user (a client with proxy.manage on 3 accounts is ONE principal).
 * One tenant or one client can therefore never escalate an address to the
 * whole platform on its own (BN2).
 */
export const PROMOTION_ACCOUNTS = 3;
export const PROMOTION_PRINCIPALS = 3;

/**
 * Number of independent principals behind a set of banned accounts (see
 * PROMOTION_PRINCIPALS). `members`: the client users of the master-tenant
 * accounts (pairs user → account); accounts of other tenants collapse into
 * their tenant.
 */
export function countIndependentPrincipals(
  accounts: ReadonlyArray<{ accountId: number; tenantId: number }>,
  masterTenantId: number,
  members: ReadonlyArray<{ userId: number; accountId: number }>,
): number {
  const tenants = new Set<number>();
  const parent = new Map<number, number>();
  const find = (a: number): number => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  for (const a of accounts) {
    if (a.tenantId === masterTenantId) parent.set(a.accountId, a.accountId);
    else tenants.add(a.tenantId);
  }
  const firstOfUser = new Map<number, number>();
  for (const m of members) {
    if (!parent.has(m.accountId)) continue;
    const prev = firstOfUser.get(m.userId);
    if (prev === undefined) firstOfUser.set(m.userId, m.accountId);
    else parent.set(find(m.accountId), find(prev));
  }
  const roots = new Set<number>();
  for (const id of parent.keys()) roots.add(find(id));
  return tenants.size + roots.size;
}
