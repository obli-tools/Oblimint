import type { WebmailIdentity, WebmailSessionInfo } from '@oblimint/shared';
import { logger } from '../../../../utils/logger';
import { verifyMailPassword } from '../../passwords';
import type { WebmailEngine } from './engine';
import { WebmailEngineError } from './engine';
import { FailureCounter, throttleKey } from './guards';
import {
  hashSessionId, mailboxLoginAllowed, newCsrfToken, newSessionId, sessionState, shouldTouch, WEBMAIL_ABSOLUTE_MS, WEBMAIL_IDLE_MS,
  type WebmailAuthMethod, type WebmailSession, type WebmailSessionStore, SESSION_ID_RE,
} from './session';

// ─────────────────────────────────────────────────────────────────────────────
// Authentication of the Oblimint webmail (no HTTP here: app.ts wires it).
//
// Password login, in this order (any refusal = the same generic answer):
//  1. the client address is not banned on the mail ports (mail_bans) and is
//     under its local failure budget (LOGIN_MAX_FAILURES_PER_IP / window,
//     IPv6 per /64); the mailbox address under LOGIN_MAX_FAILURES_PER_ADDRESS;
//  2. the panel's copy of the mailbox hash accepts the password (a dummy hash
//     is checked for an unknown address: same cost, no enumeration);
//  3. the mailbox may log in (enabled, domain enabled + verified, account
//     served and not suspended);
//  4. the ENGINE accepts the same password (final authority: a hash the
//     engine does not know yet / any more is refused) — only reached with a
//     password the panel already recognised, so the engine never sees a
//     brute force from the panel's address;
//  5. the JMAP account of the mailbox (impersonated) is pinned in the session.
// Each failure feeds the mail ban service (service 'webmail').
// The password is never stored and never logged.
// ─────────────────────────────────────────────────────────────────────────────

export const LOGIN_WINDOW_MS = 15 * 60_000;
export const LOGIN_MAX_FAILURES_PER_IP = 10;
export const LOGIN_MAX_FAILURES_PER_ADDRESS = 20;

/** Never matches anything: verified when the address is unknown (same cost as a real SHA512-CRYPT). */
const DUMMY_HASH = '{SHA512-CRYPT}$6$rounds=5000$oblimintdummy000$Vh2oV5QPKqYcFqjD4M3pXb8L4pE5S0eHq8x5vY3m1sRk2aU7nZ9tW6cB1dF0gJ3hK4lM5nO6pQ7rS8tU9vW0x.';

export interface MailboxAuthRow {
  id: number;
  accountId: number;
  tenantId: number;
  address: string;
  displayName: string | null;
  passwordHash: string;
  mailboxEnabled: boolean;
  domainEnabled: boolean;
  domainVerified: boolean;
  accountStatus: string | null;
}

export interface WebmailAuthDeps {
  store: WebmailSessionStore;
  engine: WebmailEngine;
  now(): number;
  findMailboxByAddress(address: string): Promise<MailboxAuthRow | null>;
  findMailboxById(id: number): Promise<MailboxAuthRow | null>;
  /** One-time SSO token of the panel → mailbox id (null = unknown / expired / replayed / other webmail). */
  redeemSso(token: unknown): Promise<{ mailboxId: number } | null>;
  /** Live ban of the client address on the mail ports (mail_bans). Never throws. */
  isBanned(ip: string): Promise<boolean>;
  /** Mail ban service, service 'webmail'. Never throws. */
  recordFailure(ip: string, username: string | null): void;
  maxUploadBytes(mailboxId: number): Promise<number>;
}

export class WebmailAuthError extends Error {
  constructor(
    public readonly code: 'invalidCredentials' | 'tooManyAttempts' | 'notAuthenticated' | 'ssoInvalid' | 'unavailable' | 'invalidRequest',
    public readonly status: number,
    message: string,
    public readonly retryAfterSec = 0,
  ) {
    super(message);
    this.name = 'WebmailAuthError';
  }
}

export interface LoadedSession {
  session: WebmailSession;
  sidHash: string;
}

const ADDRESS_RE = /^[^\s@%:]{1,64}@[a-z0-9.-]{1,253}$/;

export function normalizeLoginAddress(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const a = v.trim().toLowerCase();
  return a.length <= 254 && ADDRESS_RE.test(a) ? a : null;
}

export function createWebmailAuth(deps: WebmailAuthDeps) {
  const perIp = new FailureCounter(LOGIN_WINDOW_MS, LOGIN_MAX_FAILURES_PER_IP);
  const perAddress = new FailureCounter(LOGIN_WINDOW_MS, LOGIN_MAX_FAILURES_PER_ADDRESS);
  const identityCache = new Map<string, { at: number; list: WebmailIdentity[] }>();

  const fail = (ip: string, address: string | null): never => {
    const t = deps.now();
    perIp.record(throttleKey(ip), t);
    if (address) perAddress.record(address, t);
    deps.recordFailure(ip, address);
    throw new WebmailAuthError('invalidCredentials', 401, 'Wrong address or password');
  };

  /** Creates the session row; returns the cookie value. */
  async function open(mb: MailboxAuthRow, method: WebmailAuthMethod, ip: string | null, userAgent: string | null): Promise<{ sid: string; session: WebmailSession }> {
    let ep;
    try {
      ep = await deps.engine.endpoints(mb.address, true);
    } catch (err) {
      if (err instanceof WebmailEngineError && err.status === 401) throw new WebmailAuthError('invalidCredentials', 401, 'This mailbox cannot log in');
      throw new WebmailAuthError('unavailable', 503, 'The mail engine is not available');
    }
    const sid = newSessionId();
    const t = deps.now();
    const csrf = newCsrfToken();
    await deps.store.insert(hashSessionId(sid), {
      mailboxId: mb.id, accountId: mb.accountId, tenantId: mb.tenantId, address: mb.address, jmapAccountId: ep.accountId,
      method, ip, userAgent, csrf, now: t, expiresAt: t + WEBMAIL_ABSOLUTE_MS,
    });
    logger.info({ mailboxId: mb.id, method }, 'webmail session opened');
    return {
      sid,
      session: {
        id: 0, mailboxId: mb.id, accountId: mb.accountId, tenantId: mb.tenantId, address: mb.address, displayName: mb.displayName,
        jmapAccountId: ep.accountId, csrf, method, createdAt: t, lastSeenAt: t, expiresAt: t + WEBMAIL_ABSOLUTE_MS, ip,
      },
    };
  }

  return {
    /** Address + password. Throws WebmailAuthError. */
    async login(addressRaw: unknown, password: unknown, ip: string, userAgent: string | null): Promise<{ sid: string; session: WebmailSession }> {
      const t = deps.now();
      const ipKey = throttleKey(ip);
      if (perIp.blocked(ipKey, t) || await deps.isBanned(ip)) {
        throw new WebmailAuthError('tooManyAttempts', 429, 'Too many failed logins from this address', perIp.retryAfterSec(ipKey, t) || 60);
      }
      const address = normalizeLoginAddress(addressRaw);
      if (!address || typeof password !== 'string' || password.length === 0 || Buffer.byteLength(password, 'utf8') > 1024) {
        return fail(ip, address);
      }
      if (perAddress.blocked(address, t)) {
        throw new WebmailAuthError('tooManyAttempts', 429, 'Too many failed logins for this mailbox', perAddress.retryAfterSec(address, t) || 60);
      }
      const mb = await deps.findMailboxByAddress(address);
      const hashOk = verifyMailPassword(password, mb?.passwordHash ?? DUMMY_HASH);
      if (!mb || !hashOk) return fail(ip, address);
      if (!mailboxLoginAllowed(mb)) return fail(ip, address);
      let engineOk: boolean;
      try {
        engineOk = await deps.engine.verifyPassword(mb.address, password);
      } catch {
        throw new WebmailAuthError('unavailable', 503, 'The mail engine is not available');
      }
      if (!engineOk) return fail(ip, address);
      perAddress.clear(address);
      return open(mb, 'password', ip, userAgent);
    },

    /** Panel single sign-on token. Throws WebmailAuthError. */
    async sso(token: unknown, ip: string, userAgent: string | null): Promise<{ sid: string; session: WebmailSession }> {
      const ticket = await deps.redeemSso(token);
      if (!ticket) throw new WebmailAuthError('ssoInvalid', 401, 'This link has expired or was already used: open the webmail again from the panel');
      const mb = await deps.findMailboxById(ticket.mailboxId);
      if (!mb || !mailboxLoginAllowed(mb)) throw new WebmailAuthError('ssoInvalid', 401, 'This mailbox cannot log in');
      return open(mb, 'sso', ip, userAgent);
    },

    /**
     * Session of a cookie value. null = none / unknown / timed out / mailbox no
     * longer allowed / engine account changed (the row is removed then).
     */
    async load(sid: string | null, background: boolean): Promise<LoadedSession | null> {
      if (!sid || !SESSION_ID_RE.test(sid)) return null;
      const sidHash = hashSessionId(sid);
      const hit = await deps.store.find(sidHash);
      if (!hit) return null;
      const t = deps.now();
      if (!hit.mailboxActive || sessionState(hit.session, t, WEBMAIL_IDLE_MS) !== 'valid') {
        await deps.store.remove(sidHash).catch(() => undefined);
        return null;
      }
      if (shouldTouch(hit.session, t, background)) {
        await deps.store.touch(sidHash, t).catch(() => undefined);
        hit.session.lastSeenAt = t;
      }
      return { session: hit.session, sidHash };
    },

    async logout(sidHash: string): Promise<void> {
      await deps.store.remove(sidHash);
    },

    /** Identities of the session's mailbox (cached 5 min per session). */
    async identities(s: WebmailSession): Promise<WebmailIdentity[]> {
      const key = `${s.mailboxId}:${s.jmapAccountId}`;
      const hit = identityCache.get(key);
      const t = deps.now();
      if (hit && t - hit.at < 5 * 60_000) return hit.list;
      const list = await deps.engine.identities(s.address, s.jmapAccountId, s.displayName);
      if (identityCache.size > 5000) identityCache.clear();
      identityCache.set(key, { at: t, list });
      return list;
    },

    /** The engine still maps the session's mailbox to the pinned JMAP account (own account guard). */
    async assertOwnAccount(s: WebmailSession): Promise<void> {
      const ep = await deps.engine.endpoints(s.address);
      if (ep.accountId !== s.jmapAccountId) throw new WebmailAuthError('notAuthenticated', 401, 'The mailbox account changed: log in again');
    },

    async info(s: WebmailSession | null, preLoginCsrf: string): Promise<WebmailSessionInfo> {
      if (!s) {
        return {
          authenticated: false, csrf: preLoginCsrf, address: null, displayName: null, accountId: null, identities: [],
          maxUploadBytes: 0, idleTimeoutSec: Math.floor(WEBMAIL_IDLE_MS / 1000), method: null,
        };
      }
      return {
        authenticated: true,
        csrf: s.csrf,
        address: s.address,
        displayName: s.displayName,
        accountId: s.jmapAccountId,
        identities: await this.identities(s).catch(() => []),
        maxUploadBytes: await deps.maxUploadBytes(s.mailboxId).catch(() => 25 * 1048576),
        idleTimeoutSec: Math.floor(WEBMAIL_IDLE_MS / 1000),
        method: s.method,
      };
    },

    /** Tests. */
    _counters: { perIp, perAddress },
  };
}

export type WebmailAuth = ReturnType<typeof createWebmailAuth>;
