// ─────────────────────────────────────────────────────────────────────────────
// PURE certificate scheduling rules (injected clock): when to (re)issue, when
// to mark a certificate expired, and the backoff after failures.
//   - renewal window: not_after < now + 30 days;
//   - after a failure: wait backoffMs(failure_count) since last_attempt_at
//     (6 h, 12 h, then 24 h max) — never hammer Let's Encrypt (rate limits);
//   - a 'pending' row whose last attempt is older than 1 h is considered
//     stuck (process restarted mid-issuance) and retried;
//   - a 'valid' certificate from the STAGING directory while the platform is
//     on PRODUCTION is reissued (staging certs are untrusted by browsers). The
//     opposite switch (production → staging, for tests) never replaces a
//     trusted certificate;
//   - names changed (www toggled) → reissued, but still after the failure
//     backoff (a failed attempt keeps the OLD names on a still-valid row).
// ─────────────────────────────────────────────────────────────────────────────

export const RENEW_BEFORE_MS = 30 * 24 * 3600_000;
export const BACKOFF_BASE_MS = 6 * 3600_000;
export const BACKOFF_MAX_MS = 24 * 3600_000;
export const STUCK_PENDING_MS = 3600_000;
/** Minimum delay between two manual renew requests of the same certificate. */
export const MANUAL_COOLDOWN_MS = 10 * 60_000;

export type CertIssuer = 'letsencrypt' | 'letsencrypt-staging';

/** Issuer of the certificates of a directory. */
export function issuerFor(directory: 'production' | 'staging'): CertIssuer {
  return directory === 'staging' ? 'letsencrypt-staging' : 'letsencrypt';
}

/** A staging certificate while the platform issues from production → replace it. */
export function issuerOutdated(issuer: string, expected: CertIssuer | undefined): boolean {
  return expected === 'letsencrypt' && issuer === 'letsencrypt-staging';
}

export interface ScheduleRow {
  id: number;
  status: 'pending' | 'valid' | 'failed' | 'expired';
  issuer: string;
  names: string[];
  not_after: Date | string | null;
  failure_count: number;
  last_attempt_at: Date | string | null;
}

function ms(v: Date | string | null): number | null {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Minimum delay after `failureCount` consecutive failures (0 → none). */
export function backoffMs(failureCount: number): number {
  if (!failureCount || failureCount <= 0) return 0;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(failureCount - 1, 8));
}

/** Is the row still waiting out its failure backoff at `now`? */
export function inBackoff(row: Pick<ScheduleRow, 'failure_count' | 'last_attempt_at'>, now: number): boolean {
  const last = ms(row.last_attempt_at);
  if (!row.failure_count || last === null) return false;
  return now - last < backoffMs(row.failure_count);
}

/** Same set of names (order-insensitive, case-insensitive). */
export function sameNames(a: string[], b: string[]): boolean {
  const sa = new Set(a.map((n) => n.toLowerCase()));
  const sb = new Set(b.map((n) => n.toLowerCase()));
  return sa.size === sb.size && [...sa].every((n) => sb.has(n));
}

/** Is the certificate currently usable (valid, not past not_after)? */
export function isUsable(row: Pick<ScheduleRow, 'status' | 'not_after'> | null | undefined, now: number): boolean {
  if (!row || row.status !== 'valid') return false;
  const end = ms(row.not_after);
  return end !== null && end > now;
}

/**
 * Should an issuance be queued for these names? (ensureForDomain / ensureForHost)
 * Names changed or staging certificate on production → yes; otherwise only
 * inside the renewal window. Never during the failure backoff, nor while an
 * attempt is in flight.
 */
export function needsIssuance(row: ScheduleRow | null | undefined, names: string[], now: number, expectedIssuer?: CertIssuer): boolean {
  if (!row) return true;
  const end = ms(row.not_after);
  const stale = !sameNames(row.names, names) || (row.status === 'valid' && issuerOutdated(row.issuer, expectedIssuer));
  if (!stale && row.status === 'valid' && end !== null && end - now > RENEW_BEFORE_MS) return false;
  if (row.status === 'pending') {
    const last = ms(row.last_attempt_at);
    if (last !== null && now - last < STUCK_PENDING_MS) return false;
  }
  return !inBackoff(row, now);
}

export interface PlanRenewalsOptions {
  /** Issuer of the current ACME directory (staging certs replaced on production). */
  expectedIssuer?: CertIssuer;
  /** Names the row SHOULD cover (undefined = unknown / unchanged). */
  desiredNames?: (id: number) => string[] | undefined;
}

/**
 * Renewal pass (checkRenewals): ids to mark 'expired' (valid past not_after)
 * and ids to (re)issue now. Only Let's Encrypt certificates are handled.
 */
export function planRenewals(rows: ScheduleRow[], now: number, opts: PlanRenewalsOptions = {}): { expire: number[]; renew: number[] } {
  const expire: number[] = [];
  const renew: number[] = [];
  for (const r of rows) {
    if (!r.issuer.startsWith('letsencrypt')) continue;
    const end = ms(r.not_after);
    if (r.status === 'valid' && end !== null && end <= now) expire.push(r.id);
    let due: boolean;
    switch (r.status) {
      case 'valid': {
        const desired = opts.desiredNames?.(r.id);
        due = end === null || end - now < RENEW_BEFORE_MS || issuerOutdated(r.issuer, opts.expectedIssuer)
          || (desired !== undefined && !sameNames(r.names, desired));
        break;
      }
      case 'pending': {
        const last = ms(r.last_attempt_at);
        due = last === null || now - last >= STUCK_PENDING_MS;
        break;
      }
      default: due = true; // failed / expired: retry, subject to the backoff
    }
    if (due && !inBackoff(r, now)) renew.push(r.id);
  }
  return { expire, renew };
}
