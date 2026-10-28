import crypto from 'crypto';
import { config } from '../../../config';

// ─────────────────────────────────────────────────────────────────────────────
// One-time tokens of the webmail single sign-on (docs/P4-PLAN.md §9.7,
// invariants MA4 / MA13, same pattern as the DB admin SSO: P2 B3,
// databases/ssoTokens.ts). The panel creates a session credential (hash in
// mail_app_passwords), then hands the browser a TOKEN that only the webmail
// container can trade for that credential on the internal listener. Memory
// only (risk R-SINGLE-PANEL): 60 s, single use (taken out of the map on
// redemption, even a failed one), bounded per account and globally.
// ─────────────────────────────────────────────────────────────────────────────

export const WEBMAIL_TOKEN_TTL_MS = 60_000;
export const MAX_WEBMAIL_TOKENS = 2_000;
export const MAX_WEBMAIL_TOKENS_PER_ACCOUNT = 20;

/** Token format: 43 base64url characters (32 random bytes). */
export const WEBMAIL_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Header carrying the shared key of the webmail container. */
export const WEBMAIL_KEY_HEADER = 'x-oblimint-webmail-key';

/** What the webmail container receives in exchange for a token (redeem). */
export interface WebmailCredentials {
  /** Mailbox address = IMAP / SMTP login. */
  username: string;
  /** Clear session credential (never stored, never logged, never sent to the browser). */
  password: string;
  /** End of the session credential (ISO). */
  expiresAt: string;
}

/**
 * Webmail the session was opened for (a kind change in between voids the token):
 *  - roundcube / snappymail: the container trades the token for a session credential;
 *  - oblimint: the panel's own webmail redeems it in-process (no credential at all:
 *    the panel impersonates the mailbox on the engine, webmail/oblimint/).
 */
export type WebmailTicket =
  | {
    kind: 'roundcube' | 'snappymail';
    credentials: WebmailCredentials;
    /** mail_app_passwords.id of the credential (still checked at redemption). */
    appPasswordId: number;
    mailboxId: number;
    accountId: number;
  }
  | {
    kind: 'oblimint';
    credentials: null;
    appPasswordId: null;
    mailboxId: number;
    accountId: number;
  };

/** Key shared with the webmail container (env OBLIMINT_WEBMAIL_KEY): HMAC-SHA256(sessionSecret, 'oblimint-webmail'). */
export function webmailKey(secret = config.sessionSecret || 'oblimint-dev'): string {
  return crypto.createHmac('sha256', secret).update('oblimint-webmail').digest('hex');
}

export class WebmailTokenStore {
  private tokens = new Map<string, { ticket: WebmailTicket; expiresAt: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = WEBMAIL_TOKEN_TTL_MS,
    private readonly maxTokens = MAX_WEBMAIL_TOKENS,
    private readonly maxPerAccount = MAX_WEBMAIL_TOKENS_PER_ACCOUNT,
  ) {}

  /** Issues a token for `ticket`; returns it with its expiry. */
  issue(ticket: WebmailTicket): { token: string; expiresAt: Date } {
    this.sweep();
    // Bounded per account first: an account flooding the route only evicts
    // its OWN oldest pending tokens, never another tenant's.
    let oldestOwn: string | undefined;
    let own = 0;
    for (const [k, v] of this.tokens) {
      if (v.ticket.accountId !== ticket.accountId) continue;
      if (oldestOwn === undefined) oldestOwn = k;
      own++;
    }
    if (own >= this.maxPerAccount && oldestOwn !== undefined) this.tokens.delete(oldestOwn);
    if (this.tokens.size >= this.maxTokens) {
      const first = this.tokens.keys().next().value;
      if (first !== undefined) this.tokens.delete(first);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    this.tokens.set(token, { ticket, expiresAt });
    return { token, expiresAt: new Date(expiresAt) };
  }

  /** Single use: the token is removed whatever the outcome. null when malformed / unknown / expired. */
  redeem(token: unknown): WebmailTicket | null {
    if (typeof token !== 'string' || !WEBMAIL_TOKEN_RE.test(token)) return null;
    const hit = this.tokens.get(token);
    if (!hit) return null;
    this.tokens.delete(token);
    if (hit.expiresAt <= this.now()) return null;
    return hit.ticket;
  }

  /** Drops expired tokens (worker, and on every issue). Returns how many. */
  sweep(): number {
    const t = this.now();
    let n = 0;
    for (const [k, v] of this.tokens) {
      if (v.expiresAt <= t) { this.tokens.delete(k); n++; }
    }
    return n;
  }

  /** Forgets every pending token of a mailbox (disabled / password changed / deleted). */
  revokeMailbox(mailboxId: number): number {
    let n = 0;
    for (const [k, v] of this.tokens) {
      if (v.ticket.mailboxId === mailboxId) { this.tokens.delete(k); n++; }
    }
    return n;
  }

  clear(): void {
    this.tokens.clear();
  }

  get size(): number {
    return this.tokens.size;
  }
}

export const webmailTokens = new WebmailTokenStore();
