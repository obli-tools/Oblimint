import type { MailOutboundCounters } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Outbound abuse protection, PURE part (docs/P4-PLAN.md §9.5, MA9) —
// abuse.test.ts. Counters of an account over a window come from mail_log
// (grouped by direction / event):
//
//   sent      outbound delivered
//   bounced   outbound bounced
//   rejected  outbound rejected + relay rejected (refused by the relay policy)
//   spam      outbound spam + virus
//
// Over `minMessages` outbound messages (sent + bounced + rejected + spam) in
// the last hour, a "bad" rate (bounced + rejected + spam) ≥ `ratePct` is
// abuse: reason spamRate when spam dominates, else bounceRate.
// ─────────────────────────────────────────────────────────────────────────────

export interface CounterRow {
  direction: string;
  event: string;
  n: number | string;
}

export function emptyCounters(): MailOutboundCounters {
  return { sent: 0, bounced: 0, rejected: 0, spam: 0 };
}

/** mail_log aggregates (one account, one window) → counters. */
export function countersFromRows(rows: readonly CounterRow[]): MailOutboundCounters {
  const c = emptyCounters();
  for (const r of rows) {
    const n = Number(r.n) || 0;
    if (r.direction === 'outbound') {
      if (r.event === 'delivered') c.sent += n;
      else if (r.event === 'bounced') c.bounced += n;
      else if (r.event === 'rejected') c.rejected += n;
      else if (r.event === 'spam' || r.event === 'virus') c.spam += n;
    } else if (r.direction === 'relay' && r.event === 'rejected') {
      c.rejected += n;
    }
  }
  return c;
}

export interface AbuseSettings {
  /** settings mail.abuseMinMessages */
  minMessages: number;
  /** settings mail.abuseBounceRatePct */
  ratePct: number;
}

export interface AbuseVerdict {
  abusive: boolean;
  reason: 'bounceRate' | 'spamRate' | null;
  /** Bad rate in % (one decimal), 0 when there is nothing to judge. */
  ratePct: number;
  total: number;
}

export function evaluateAbuse(c: MailOutboundCounters, s: AbuseSettings): AbuseVerdict {
  const total = c.sent + c.bounced + c.rejected + c.spam;
  const bad = c.bounced + c.rejected + c.spam;
  const ratePct = total > 0 ? Math.round((bad / total) * 1000) / 10 : 0;
  const min = Math.max(1, Math.floor(s.minMessages));
  const threshold = Math.min(100, Math.max(1, s.ratePct));
  if (total < min || bad === 0 || ratePct < threshold) return { abusive: false, reason: null, ratePct, total };
  return { abusive: true, reason: c.spam > c.bounced + c.rejected ? 'spamRate' : 'bounceRate', ratePct, total };
}

/** French sentence for the notification / reason_detail. */
export function abuseDetail(c: MailOutboundCounters, v: AbuseVerdict): string {
  return `${v.total} messages sortants sur la dernière heure, dont ${c.bounced} rebonds, ${c.rejected} refus et ${c.spam} indésirables (${v.ratePct} %)`;
}
