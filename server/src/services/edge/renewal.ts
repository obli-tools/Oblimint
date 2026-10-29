// ─────────────────────────────────────────────────────────────────────────────
// PURE certificate scheduling rules (injected clock): when to (re)issue, when
// to mark a certificate expired, and the backoff after failures.
//   - renewal window: not_after < now + 30 days;
//   - after a failure: wait backoffMs(failure_count) since last_attempt_at
//     (6 h, 12 h, then 24 h max) — never hammer Let's Encrypt (rate limits);
//   - EXCEPT a platform row never issued yet (fast_start: panel / client
//     space / DB admin / probe / mail / webmail host just set — and the mail
//     certificates of the mail domains, platform rows too — its DNS not
//     pointing or not propagated yet at the first attempt): 10 min, 30 min,
//     1 h, 3 h, then the regular 6 h / 12 h / 24 h (Let's Encrypt allows 5
//     failed validations per host name per hour: far below);
//   - the retry happens AT the end of the backoff (certificate.service arms a
//     timer), not at the next 12-hourly renewal pass;
//   - a 'pending' row whose last attempt is older than 1 h is considered
//     stuck (process restarted mid-issuance) and retried;
//   - a 'valid' certificate from the STAGING directory while the platform is
//     on PRODUCTION is reissued (staging certs are untrusted by browsers). The
//     opposite switch (production → staging, for tests) never replaces a
//     trusted certificate;
//   - names changed (www toggled) → reissued, but still after the failure
//     backoff (a failed attempt keeps the OLD names on a still-valid row).
//   - P5: a certificate IMPORTED from CWP (issuer 'imported', docs/P5-PLAN.md
//     §9.6) is served as is and handed over to Let's Encrypt like one of ours:
//     renewed in the same 30-day window (or at the cutover, explicitly).
// ─────────────────────────────────────────────────────────────────────────────

export const RENEW_BEFORE_MS = 30 * 24 * 3600_000;
export const BACKOFF_BASE_MS = 6 * 3600_000;
export const BACKOFF_MAX_MS = 24 * 3600_000;
export const STUCK_PENDING_MS = 3600_000;
/** Minimum delay between two manual renew requests of the same certificate. */
export const MANUAL_COOLDOWN_MS = 10 * 60_000;
/**
 * Minimum delay between two « retry now » of a PLATFORM host name certificate
 * (staff only, Settings): short, the owner fixes the DNS and retries — the
 * Let's Encrypt limit (5 failed validations per host name per hour, one back
 * every 12 min) is then the only bound, its error is shown as is.
 */
export const PLATFORM_RETRY_COOLDOWN_MS = 2 * 60_000;
/** fast_start backoff (platform host name never issued): then the regular schedule. */
export const FIRST_ISSUANCE_BACKOFF_MS: readonly number[] = [10 * 60_000, 30 * 60_000, 3600_000, 3 * 3600_000];

export type CertIssuer = 'letsencrypt' | 'letsencrypt-staging';

/** certificates.issuer of a certificate imported by the CWP migration (P5): renewed by Let's Encrypt. */
export const IMPORTED_CERT_ISSUER = 'imported';

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
  /** Platform host name never issued yet: short first retries (FIRST_ISSUANCE_BACKOFF_MS). */
  fast_start?: boolean;
}

type BackoffRow = Pick<ScheduleRow, 'failure_count' | 'last_attempt_at' | 'fast_start'>;

function ms(v: Date | string | null): number | null {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Minimum delay after `failureCount` consecutive failures (0 → none); `fastStart`: FIRST_ISSUANCE_BACKOFF_MS first. */
export function backoffMs(failureCount: number, fastStart = false): number {
  if (!failureCount || failureCount <= 0) return 0;
  let n = failureCount;
  if (fastStart) {
    if (n <= FIRST_ISSUANCE_BACKOFF_MS.length) return FIRST_ISSUANCE_BACKOFF_MS[n - 1];
    n -= FIRST_ISSUANCE_BACKOFF_MS.length;
  }
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 8));
}

/** End of the failure backoff (epoch ms); null when the row has none (no failure, never attempted). */
export function backoffEndsAt(row: BackoffRow): number | null {
  const last = ms(row.last_attempt_at);
  if (!row.failure_count || last === null) return null;
  return last + backoffMs(row.failure_count, !!row.fast_start);
}

/** Is the row still waiting out its failure backoff at `now`? */
export function inBackoff(row: BackoffRow, now: number): boolean {
  const end = backoffEndsAt(row);
  return end !== null && now < end;
}

/**
 * Next AUTOMATIC attempt (epoch ms) as these rules decide it, shown to the
 * staff (Settings → platform certificates): valid → start of the renewal
 * window (or the backoff end when later); failed / expired → the backoff end
 * (`now` when already due); pending → when it counts as stuck.
 */
export function nextAttemptAt(row: ScheduleRow | null | undefined, now: number): number | null {
  if (!row) return null;
  const backoff = backoffEndsAt(row);
  if (row.status === 'pending') {
    const last = ms(row.last_attempt_at);
    return last === null ? now : Math.max(now, last + STUCK_PENDING_MS);
  }
  if (row.status === 'valid') {
    const end = ms(row.not_after);
    const window = end === null ? now : end - RENEW_BEFORE_MS;
    return Math.max(window, backoff ?? window);
  }
  return Math.max(now, backoff ?? now);
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
 * and ids to (re)issue now. Only Let's Encrypt certificates (and the ones
 * imported by the CWP migration, handed over to Let's Encrypt) are handled.
 */
export function planRenewals(rows: ScheduleRow[], now: number, opts: PlanRenewalsOptions = {}): { expire: number[]; renew: number[] } {
  const expire: number[] = [];
  const renew: number[] = [];
  for (const r of rows) {
    if (!r.issuer.startsWith('letsencrypt') && r.issuer !== IMPORTED_CERT_ISSUER) continue;
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
