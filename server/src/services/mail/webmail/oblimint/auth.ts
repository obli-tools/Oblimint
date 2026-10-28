import type { WebmailIdentity, WebmailSessionInfo } from '@oblimint/shared';
import { logger } from '../../../../utils/logger';
import { toStalwartSecret } from '../../engines/stalwart/principals';
import { verifyMailPassword } from '../../passwords';
import type { WebmailEngine } from './engine';
import { WebmailEngineError } from './engine';
import { FailureCounter, networkKey, throttleKey } from './guards';
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
//     IPv6 per /64);
//  2. the mailbox address, SEEN FROM THE CLIENT'S NETWORK (IPv4 /24, IPv6
//     /64), is under LOGIN_MAX_FAILURES_PER_ADDRESS_NET: guessing from one
//     network blocks that network only, never the mailbox's owner elsewhere;
//     across all networks, the failures of the address only SLOW its logins
//     down (loginDelayMs: progressive, bounded) — no hard lock anyone could
//     trigger from anywhere;
//  3. the panel's copy of the mailbox hash accepts the password (a dummy hash
//     is checked for an unknown address: same cost, no enumeration), and the
//     engine can verify that hash (the scheme rule of the sync: a hash it
//     cannot verify gives the mailbox no login anywhere — same here);
//  4. the mailbox may log in (enabled, domain enabled + verified, account
//     served and not suspended);
//  5. the JMAP account of the mailbox (impersonated) is pinned in the session.
// The password is NEVER presented to the engine: the panel's hash is the
// authority (the sync pushes it to the engine; the webmail itself works by
// impersonation, so the engine's copy is never used by it). A password the
// engine would refuse (sync lag after a change) therefore cannot make the
// engine's auto-ban block the panel's own address (admin API + every webmail).
// Each failure feeds the mail ban service (service 'webmail').
// The password is never stored and never logged.
// ─────────────────────────────────────────────────────────────────────────────

export const LOGIN_WINDOW_MS = 15 * 60_000;
export const LOGIN_MAX_FAILURES_PER_IP = 10;
/** Failures of one mailbox address from one client network (IPv4 /24, IPv6 /64): then 429 for that network. */
export const LOGIN_MAX_FAILURES_PER_ADDRESS_NET = 10;
/** Failures of one mailbox address from anywhere before its logins are slowed down. */
export const LOGIN_SLOW_AFTER_FAILURES = 20;
export const LOGIN_MAX_DELAY_MS = 10_000;

/**
 * Wait imposed on a login of an address that failed `failures` times in the
 * window (all networks): 0 up to LOGIN_SLOW_AFTER_FAILURES, then 0.5 s
 * doubling every 5 failures, at most LOGIN_MAX_DELAY_MS.
 */
export function loginDelayMs(failures: number): number {
  if (failures <= LOGIN_SLOW_AFTER_FAILURES) return 0;
  return Math.min(LOGIN_MAX_DELAY_MS, 500 * 2 ** Math.floor((failures - LOGIN_SLOW_AFTER_FAILURES - 1) / 5));
}

/** The engine can verify this stored hash (principals.ts: otherwise the mailbox gets no secret, no login). */
function engineVerifiable(stored: string): boolean {
  try {
    toStalwartSecret(stored);
    return true;
  } catch {
    return false;
  }
}

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
  /** Same lookup WITHOUT using the token (confirmation screen before the redemption). */
  peekSso(token: unknown): Promise<{ mailboxId: number } | null>;
  /** Live ban of the client address on the mail ports (mail_bans). Never throws. */
  isBanned(ip: string): Promise<boolean>;
  /** Mail ban service, service 'webmail'. Never throws. */
  recordFailure(ip: string, username: string | null): void;
  maxUploadBytes(mailboxId: number): Promise<number>;
  /** Progressive login delay (tests replace it). */
  sleep?: (ms: number) => Promise<void>;
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
  const perAddressNet = new FailureCounter(LOGIN_WINDOW_MS, LOGIN_MAX_FAILURES_PER_ADDRESS_NET);
  /** Never blocks: its count only sets the delay (bounded memory: at most 2 × max timestamps per key). */
  const perAddress = new FailureCounter(LOGIN_WINDOW_MS, 100);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref?.(); }));
  const addrNet = (address: string, ip: string) => `${address}|${networkKey(ip)}`;
  const identityCache = new Map<string, { at: number; list: WebmailIdentity[] }>();

  const fail = (ip: string, address: string | null): never => {
    const t = deps.now();
    perIp.record(throttleKey(ip), t);
    if (address) {
      perAddressNet.record(addrNet(address, ip), t);
      perAddress.record(address, t);
    }
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
      const netKey = addrNet(address, ip);
      if (perAddressNet.blocked(netKey, t)) {
        throw new WebmailAuthError('tooManyAttempts', 429, 'Too many failed logins for this mailbox', perAddressNet.retryAfterSec(netKey, t) || 60);
      }
      const wait = loginDelayMs(perAddress.count(address, t));
      if (wait > 0) await sleep(wait);
      const mb = await deps.findMailboxByAddress(address);
      const hashOk = verifyMailPassword(password, mb?.passwordHash ?? DUMMY_HASH);
      if (!mb || !hashOk || !engineVerifiable(mb.passwordHash)) return fail(ip, address);
      if (!mailboxLoginAllowed(mb)) return fail(ip, address);
      perAddressNet.clear(netKey);
      perAddress.clear(address);
      return open(mb, 'password', ip, userAgent);
    },

    /**
     * Mailbox a panel SSO token would open, the token left unused: the browser
     * always shows it and asks before redeeming (a link minted by someone else
     * for THEIR mailbox must never log the visitor into it silently).
     */
    async ssoTarget(token: unknown): Promise<{ address: string }> {
      const ticket = await deps.peekSso(token);
      if (!ticket) throw new WebmailAuthError('ssoInvalid', 401, 'This link has expired or was already used: open the webmail again from the panel');
      const mb = await deps.findMailboxById(ticket.mailboxId);
      if (!mb || !mailboxLoginAllowed(mb)) throw new WebmailAuthError('ssoInvalid', 401, 'This mailbox cannot log in');
      return { address: mb.address };
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
    _counters: { perIp, perAddressNet, perAddress },
  };
}

export type WebmailAuth = ReturnType<typeof createWebmailAuth>;
