import type { MailDesiredState } from '../../driver';
import { domainName, positiveInt } from './validate';

// ─────────────────────────────────────────────────────────────────────────────
// Hourly sending limits of the Stalwart engine (MA9) — PURE (limits.test.ts).
// Report P4 (docs/P4b-PLAN.md §19): a mailbox create / delete or a send toggle
// must NOT restart the engine — the first mailbox of a fresh install
// included. The limiters are rendered as SETTINGS of Stalwart's store
// (config.ts DYNAMIC_SETTINGS, queue.limiter.inbound.oblimint-*), written
// through POST /api/settings and applied by GET /api/reload: live, exact at
// every sync, never a restart (the Linux test host 0.12.4: a limiter added, raised,
// lowered or removed this way is enforced at once, the engine keeps running).
// They used to live in config.toml (read at start only), which made the first
// limited account restart the engine.
//
//  - the limit is a property of the ACCOUNT (plan mailOutboundPerHour or the
//    outbound policy, the same for every mailbox of the account): one rule
//    per rate, matching the mail DOMAINS of the accounts at that rate
//    (`ends_with(authenticated_as, '@<domain>')`, the login is the address),
//    every domain of an account whose rate is known — not the mailbox list:
//    the settings only move with the first / last mailbox of an account or a
//    rate change;
//  - the send toggle is the email-send + jmap-email-submission-set permissions of the principal (live,
//    principals.ts), never a limiter change: the limits ignore it;
//  - a fallback rule applies the platform's STRICTEST rate to any
//    authenticated sender of a domain without a rule, so a mailbox is never
//    unlimited by accident (defensive: the driver writes the settings before
//    the principals of the same sync).
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
