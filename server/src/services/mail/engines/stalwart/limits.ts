import type { MailDesiredState } from '../../driver';
import { domainName, positiveInt } from './validate';

// ─────────────────────────────────────────────────────────────────────────────
// Hourly sending limits of the Stalwart engine (MA9) — PURE (limits.test.ts).
// Report P4 (docs/P4b-PLAN.md §19): a mailbox create / delete or a send toggle
// must NOT restart the engine. Stalwart 0.12.4 reads its configuration file at
// start only, so the limits are rendered so that those changes never touch it:
//
//  - the limit is a property of the ACCOUNT (plan mailOutboundPerHour or the
//    outbound policy, the same for every mailbox of the account): one rule
//    per rate, matching the mail DOMAINS of the accounts at that rate
//    (`ends_with(authenticated_as, '@<domain>')`, the login is the address),
//    every domain of an account whose rate is known — not the mailbox list;
//  - the send toggle is the email-send permission of the principal (live,
//    principals.ts), never a configuration change: the limits ignore it;
//  - a fallback rule applies the platform's STRICTEST rate to any
//    authenticated sender of a domain without a rule (a new account's first
//    mailbox), so a mailbox is never unlimited by accident;
//  - the driver records the limits the running engine loaded (appliedLimits)
//    and restarts only when, for some domain, the desired limit is STRICTER
//    than what the engine enforces (limitsCovered false: plan downgrade, the
//    very first limited account while no fallback is loaded yet) — MA9 at
//    once. An engine stricter than desired (a new account under the
//    fallback, a plan upgrade, a deleted mailbox) is safe: no immediate
//    restart, the exact limits are loaded at its next restart (domain / DKIM
//    / TLS / settings change) — BOUNDED (limitsStale / staleRestartDue): a
//    mailbox kept under a stricter limit than its plan for 6 h gets a restart
//    in the quiet window (02:00–05:00 UTC), and in any case after 24 h.
// ─────────────────────────────────────────────────────────────────────────────

export interface SendLimits {
  /** domain → hourly limit of its account (null = unlimited). Domains of accounts without any mailbox are absent. */
  byDomain: Record<string, number | null>;
  /** Strictest numeric limit of byDomain: applied to authenticated senders of any OTHER domain (null = none). */
  fallback: number | null;
}

export const NO_LIMITS: SendLimits = Object.freeze({ byDomain: Object.freeze({}) as Record<string, number | null>, fallback: null });

const MAX_RATE = 1_000_000;

/** Strictest of two limits (null = unlimited). */
function stricter(a: number | null | undefined, b: number | null): number | null {
  if (a === undefined) return b;
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/** The limits of a desired state (every mailbox counts, whatever its login / send flags). Throws invalidState on bad data. */
export function desiredSendLimits(state: Pick<MailDesiredState, 'domains' | 'mailboxes'>): SendLimits {
  const byAccount = new Map<number, number | null>();
  const byMailboxDomain = new Map<string, number | null>();
  for (const mb of state.mailboxes) {
    const rate = mb.sendPerHour === null ? null : positiveInt(mb.sendPerHour, 'hourly sending limit', MAX_RATE);
    byAccount.set(mb.accountId, stricter(byAccount.get(mb.accountId), rate));
    const d = domainName(mb.domain);
    byMailboxDomain.set(d, stricter(byMailboxDomain.get(d), rate));
  }
  const byDomain: Record<string, number | null> = {};
  for (const d of state.domains) {
    if (!byAccount.has(d.accountId)) continue;
    const name = domainName(d.name);
    byDomain[name] = stricter(byDomain[name], byAccount.get(d.accountId)!);
  }
  // A mailbox whose domain row is not in the state (defensive): its own domain.
  for (const [d, rate] of byMailboxDomain) if (!(d in byDomain)) byDomain[d] = rate;
  const sorted: Record<string, number | null> = {};
  for (const k of Object.keys(byDomain).sort()) sorted[k] = byDomain[k];
  const rates = Object.values(sorted).filter((r): r is number => r !== null);
  return { byDomain: sorted, fallback: rates.length ? Math.min(...rates) : null };
}

/** Limit the engine enforces for a domain under `applied` (rule, else the fallback; null = unlimited). */
export function enforcedLimit(applied: SendLimits, domain: string): number | null {
  return Object.prototype.hasOwnProperty.call(applied.byDomain, domain) ? applied.byDomain[domain] : applied.fallback;
}

/**
 * true when the engine running with `applied` never lets a mailbox send MORE
 * than `desired` allows (equal or stricter everywhere): no restart needed.
 */
export function limitsCovered(applied: SendLimits, desired: SendLimits): boolean {
  for (const [domain, want] of Object.entries(desired.byDomain)) {
    const have = enforcedLimit(applied, domain);
    if (have === null) {
      if (want !== null) return false;
    } else if (want !== null && have > want) {
      return false;
    }
  }
  return true;
}

/** Bookkeeping form → SendLimits (garbage → NO_LIMITS, i.e. "nothing known": the next sync restarts if needed). */
export function parseLimits(v: unknown): SendLimits {
  const o = v as { byDomain?: unknown; fallback?: unknown } | null;
  if (!o || typeof o !== 'object' || !o.byDomain || typeof o.byDomain !== 'object') return NO_LIMITS;
  const byDomain: Record<string, number | null> = {};
  for (const [k, r] of Object.entries(o.byDomain as Record<string, unknown>)) {
    if (r === null || (Number.isInteger(r) && (r as number) >= 0)) byDomain[k] = r as number | null;
    else return NO_LIMITS;
  }
  const fallback = o.fallback === null || o.fallback === undefined ? null : Number.isInteger(o.fallback) && (o.fallback as number) >= 0 ? (o.fallback as number) : null;
  return { byDomain, fallback };
}

/**
 * true when, for some domain of `desired`, the engine enforces a STRICTER
 * limit than wanted (a new account under the fallback, a plan upgrade): safe
 * for MA9, but a functional regression of the plan that must not last.
 */
export function limitsStale(applied: SendLimits, desired: SendLimits): boolean {
  for (const [domain, want] of Object.entries(desired.byDomain)) {
    const have = enforcedLimit(applied, domain);
    if (have === null) continue;
    if (want === null || have < want) return true;
  }
  return false;
}

/** Stale limits restart in the quiet window once this old… */
export const LIMITS_STALE_QUIET_MS = 6 * 3_600_000;
/** …and at any hour once this old. */
export const LIMITS_STALE_MAX_MS = 24 * 3_600_000;
/** Quiet window (UTC hours, [start, end)). */
const QUIET_START_UTC = 2;
const QUIET_END_UTC = 5;

/** A restart is due to load stale limits (staleSince = first sync that saw them stale). */
export function staleRestartDue(staleSince: Date | null, now: Date): boolean {
  if (!staleSince || Number.isNaN(staleSince.getTime())) return false;
  const age = now.getTime() - staleSince.getTime();
  if (age >= LIMITS_STALE_MAX_MS) return true;
  const h = now.getUTCHours();
  return age >= LIMITS_STALE_QUIET_MS && h >= QUIET_START_UTC && h < QUIET_END_UTC;
}
