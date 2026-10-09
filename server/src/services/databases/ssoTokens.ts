import crypto from 'crypto';
import type { DbEngine } from '@oblimint/shared';
import { config } from '../../config';

// ─────────────────────────────────────────────────────────────────────────────
// Single sign-on of phpMyAdmin / Adminer (docs/P2-PLAN.md §9.3, invariant
// B3). The panel creates an ephemeral SQL user, then a one-time TOKEN kept
// in memory only: 60 s, single use (taken out of the map on redemption,
// even a failed one never leaves it reusable). The admin container redeems
// it on the internal listener with the shared key below.
// ─────────────────────────────────────────────────────────────────────────────

export const SSO_TOKEN_TTL_MS = 60_000;
const MAX_TOKENS = 2_000;
export const MAX_TOKENS_PER_ACCOUNT = 20;

/** What the admin container receives in exchange for a token. */
export interface DbAdminCredentials {
  engine: DbEngine;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string | null;
  /** End of the SSO session (the ephemeral user is dropped then). */
  expiresAt: string;
}

export interface SsoTicket {
  credentials: DbAdminCredentials;
  instanceId: number;
  accountId: number;
  /** Which admin UI may redeem it. */
  kind: 'phpmyadmin' | 'adminer';
}

/** Key shared with the admin containers (env OBLIMINT_DBADMIN_KEY): HMAC(sessionSecret, 'oblimint-dbadmin'). */
export function dbAdminKey(secret = config.sessionSecret || 'oblimint-dev'): string {
  return crypto.createHmac('sha256', secret).update('oblimint-dbadmin').digest('hex');
}

/** phpMyAdmin cookie encryption secret (32 bytes, hex): stable across restarts, never stored. */
export function phpMyAdminBlowfishSecret(secret = config.sessionSecret || 'oblimint-dev'): string {
  return crypto.createHmac('sha256', secret).update('oblimint-pma-blowfish').digest('hex');
}

/** Token format: 43 base64url characters (32 random bytes). */
export const SSO_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export class SsoTokenStore {
  private tokens = new Map<string, { ticket: SsoTicket; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = SSO_TOKEN_TTL_MS) {}

  /** Issues a token for `ticket`; returns it with its expiry. */
  issue(ticket: SsoTicket): { token: string; expiresAt: Date } {
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
    if (own >= MAX_TOKENS_PER_ACCOUNT && oldestOwn !== undefined) this.tokens.delete(oldestOwn);
    if (this.tokens.size >= MAX_TOKENS) {
      // Global memory bound (≥ 100 accounts at their cap within 60 s): the oldest token goes.
      const first = this.tokens.keys().next().value;
      if (first !== undefined) this.tokens.delete(first);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    this.tokens.set(token, { ticket, expiresAt });
    return { token, expiresAt: new Date(expiresAt) };
  }

  /** Single use: the token is removed whatever the outcome. null when unknown / expired / wrong UI. */
  redeem(token: unknown, kind?: SsoTicket['kind']): SsoTicket | null {
    if (typeof token !== 'string' || !SSO_TOKEN_RE.test(token)) return null;
    const hit = this.tokens.get(token);
    if (!hit) return null;
    this.tokens.delete(token);
    if (hit.expiresAt <= this.now()) return null;
    if (kind && hit.ticket.kind !== kind) return null;
    return hit.ticket;
  }

  /** Drops expired tokens (worker, and on every issue). */
  sweep(): number {
    const t = this.now();
    let n = 0;
    for (const [k, v] of this.tokens) {
      if (v.expiresAt <= t) { this.tokens.delete(k); n++; }
    }
    return n;
  }

  /** Forgets every token of an instance (instance deleted). */
  revokeInstance(instanceId: number): void {
    for (const [k, v] of this.tokens) if (v.ticket.instanceId === instanceId) this.tokens.delete(k);
  }

  get size(): number {
    return this.tokens.size;
  }
}

export const ssoTokens = new SsoTokenStore();
