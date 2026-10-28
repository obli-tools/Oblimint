import crypto from 'crypto';
import { db } from '../../../../db';
import { SERVED_ACCOUNT_STATUSES } from '../../../edge/vhostPlan';
import { accountServesMail } from '../../mappers';

// ─────────────────────────────────────────────────────────────────────────────
// Sessions of the Oblimint webmail (table webmail_sessions, migration 020).
//
//  - the browser holds a random 256-bit id in a host-only cookie
//    (__Host-oblimint-wm: Secure, HttpOnly, SameSite=Strict, Path=/); only its
//    SHA-256 is stored;
//  - a session is bound to ONE mailbox (mailbox_id, address) and to the JMAP
//    account the engine gave that mailbox at login; nothing in a request can
//    change either;
//  - idle timeout (WEBMAIL_IDLE_MS, background calls do not extend it) and
//    absolute lifetime (WEBMAIL_ABSOLUTE_MS);
//  - every lookup re-checks the mailbox (enabled), its mail domain (enabled,
//    domain verified) and its account (served, not suspended): a session dies
//    with any of them, not only at the next sync of the engine;
//  - per-session CSRF token (sent back in X-Oblimint-CSRF).
// The store is an interface: memory implementation for the unit tests, the
// database one at run time.
// ─────────────────────────────────────────────────────────────────────────────

export const WEBMAIL_IDLE_MS = 30 * 60_000;
export const WEBMAIL_ABSOLUTE_MS = 12 * 60 * 60_000;
/** last_seen_at is written at most this often (one UPDATE per minute and session). */
export const WEBMAIL_TOUCH_EVERY_MS = 60_000;
export const MAX_SESSIONS_PER_MAILBOX = 20;

export const SESSION_COOKIE_SECURE = '__Host-oblimint-wm';
export const SESSION_COOKIE_DEV = 'oblimint-wm';
export const PRELOGIN_COOKIE_SECURE = '__Host-oblimint-wm-csrf';
export const PRELOGIN_COOKIE_DEV = 'oblimint-wm-csrf';

/** Cookie value format: 43 base64url characters (32 bytes). */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;

export type WebmailAuthMethod = 'password' | 'sso';

export interface WebmailSession {
  id: number;
  mailboxId: number;
  accountId: number;
  tenantId: number;
  address: string;
  displayName: string | null;
  jmapAccountId: string;
  csrf: string;
  method: WebmailAuthMethod;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string | null;
}

export interface NewWebmailSession {
  mailboxId: number;
  accountId: number;
  tenantId: number;
  address: string;
  jmapAccountId: string;
  method: WebmailAuthMethod;
  ip: string | null;
  userAgent: string | null;
}

export interface WebmailSessionStore {
  /** Inserts a session (keeps at most MAX_SESSIONS_PER_MAILBOX per mailbox: the oldest go). */
  insert(sidHash: string, s: NewWebmailSession & { csrf: string; now: number; expiresAt: number }): Promise<void>;
  /** The session and whether its mailbox may still log in, null = unknown. */
  find(sidHash: string): Promise<{ session: WebmailSession; mailboxActive: boolean } | null>;
  touch(sidHash: string, now: number): Promise<void>;
  remove(sidHash: string): Promise<void>;
  removeMailbox(mailboxId: number): Promise<number>;
  removeAll(): Promise<number>;
  /** Deletes sessions idle or past their lifetime. */
  sweep(now: number): Promise<number>;
}

export function newSessionId(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function newCsrfToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashSessionId(sid: string): string {
  return crypto.createHash('sha256').update(sid, 'utf8').digest('hex');
}

/** Constant-time comparison of two tokens (false when either is missing). */
export function tokensEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false;
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y) && a.length === b.length;
}

export type SessionState = 'valid' | 'idle' | 'expired';

/** Pure: is the session still usable at `now`? */
export function sessionState(s: Pick<WebmailSession, 'lastSeenAt' | 'expiresAt'>, now: number, idleMs = WEBMAIL_IDLE_MS): SessionState {
  if (now >= s.expiresAt) return 'expired';
  if (now - s.lastSeenAt >= idleMs) return 'idle';
  return 'valid';
}

/** Should this request write last_seen_at (foreground and older than WEBMAIL_TOUCH_EVERY_MS)? */
export function shouldTouch(s: Pick<WebmailSession, 'lastSeenAt'>, now: number, background: boolean): boolean {
  return !background && now - s.lastSeenAt >= WEBMAIL_TOUCH_EVERY_MS;
}

/** May this mailbox log into the webmail? (mailbox enabled, mail domain enabled + verified, account served and not suspended) */
export function mailboxLoginAllowed(r: { mailboxEnabled: boolean; domainEnabled: boolean; domainVerified: boolean; accountStatus: string | null | undefined }): boolean {
  return !!r.mailboxEnabled && !!r.domainEnabled && !!r.domainVerified
    && (SERVED_ACCOUNT_STATUSES as readonly string[]).includes(String(r.accountStatus)) && accountServesMail(r.accountStatus);
}

// ── memory store (tests) ─────────────────────────────────────────────────────

export class MemoryWebmailSessionStore implements WebmailSessionStore {
  readonly rows = new Map<string, WebmailSession>();
  /** mailboxId → still allowed to log in (default true). */
  readonly mailboxActive = new Map<number, boolean>();
  private seq = 0;

  async insert(sidHash: string, s: NewWebmailSession & { csrf: string; now: number; expiresAt: number }): Promise<void> {
    const own = [...this.rows.entries()].filter(([, v]) => v.mailboxId === s.mailboxId).sort((a, b) => a[1].id - b[1].id);
    while (own.length >= MAX_SESSIONS_PER_MAILBOX) this.rows.delete(own.shift()![0]);
    this.rows.set(sidHash, {
      id: ++this.seq, mailboxId: s.mailboxId, accountId: s.accountId, tenantId: s.tenantId, address: s.address, displayName: null,
      jmapAccountId: s.jmapAccountId, csrf: s.csrf, method: s.method, createdAt: s.now, lastSeenAt: s.now, expiresAt: s.expiresAt, ip: s.ip,
    });
  }

  async find(sidHash: string) {
    const s = this.rows.get(sidHash);
    return s ? { session: { ...s }, mailboxActive: this.mailboxActive.get(s.mailboxId) ?? true } : null;
  }

  async touch(sidHash: string, now: number): Promise<void> {
    const s = this.rows.get(sidHash);
    if (s) s.lastSeenAt = now;
  }

  async remove(sidHash: string): Promise<void> {
    this.rows.delete(sidHash);
  }

  async removeMailbox(mailboxId: number): Promise<number> {
    let n = 0;
    for (const [k, v] of this.rows) if (v.mailboxId === mailboxId) { this.rows.delete(k); n++; }
    return n;
  }

  async removeAll(): Promise<number> {
    const n = this.rows.size;
    this.rows.clear();
    return n;
  }

  async sweep(now: number): Promise<number> {
    let n = 0;
    for (const [k, v] of this.rows) if (sessionState(v, now) !== 'valid') { this.rows.delete(k); n++; }
    return n;
  }
}

// ── database store ───────────────────────────────────────────────────────────

const ms = (v: Date | string | number): number => (v instanceof Date ? v.getTime() : new Date(v).getTime());

export const dbWebmailSessionStore: WebmailSessionStore = {
  async insert(sidHash, s) {
    await db.transaction(async (trx) => {
      const live = await trx('webmail_sessions').where({ mailbox_id: s.mailboxId }).orderBy('id', 'desc').pluck('id') as Array<number | string>;
      const excess = live.slice(MAX_SESSIONS_PER_MAILBOX - 1).map(Number);
      if (excess.length) await trx('webmail_sessions').whereIn('id', excess).delete();
      await trx('webmail_sessions').insert({
        sid_hash: sidHash,
        mailbox_id: s.mailboxId,
        account_id: s.accountId,
        tenant_id: s.tenantId,
        address: s.address,
        jmap_account_id: s.jmapAccountId,
        csrf_token: s.csrf,
        method: s.method,
        ip: s.ip ? s.ip.slice(0, 64) : null,
        user_agent: s.userAgent ? s.userAgent.slice(0, 255) : null,
        created_at: new Date(s.now),
        last_seen_at: new Date(s.now),
        expires_at: new Date(s.expiresAt),
      });
    });
  },

  async find(sidHash) {
    const r = await db('webmail_sessions as s')
      .join('mailboxes as m', function joinMailbox() { this.on('m.id', '=', 's.mailbox_id').andOn('m.account_id', '=', 's.account_id'); })
      .join('mail_domains as md', 'md.id', 'm.mail_domain_id')
      .join('domains as d', 'd.id', 'md.domain_id')
      .join('hosting_accounts as a', 'a.id', 'm.account_id')
      .where('s.sid_hash', sidHash)
      .first(
        's.*', 'm.address as mailbox_address', 'm.display_name', 'm.enabled as mailbox_enabled', 'md.enabled as domain_enabled',
        'd.verification_status', 'a.status as account_status',
      ) as Record<string, unknown> | undefined;
    if (!r) return null;
    const session: WebmailSession = {
      id: Number(r.id),
      mailboxId: Number(r.mailbox_id),
      accountId: Number(r.account_id),
      tenantId: Number(r.tenant_id),
      address: String(r.address),
      displayName: (r.display_name as string | null) ?? null,
      jmapAccountId: String(r.jmap_account_id),
      csrf: String(r.csrf_token),
      method: r.method === 'sso' ? 'sso' : 'password',
      createdAt: ms(r.created_at as Date),
      lastSeenAt: ms(r.last_seen_at as Date),
      expiresAt: ms(r.expires_at as Date),
      ip: (r.ip as string | null) ?? null,
    };
    // A renamed mailbox (address changed) never keeps a session of the old address.
    const sameAddress = String(r.mailbox_address).toLowerCase() === session.address.toLowerCase();
    const mailboxActive = sameAddress && mailboxLoginAllowed({
      mailboxEnabled: !!r.mailbox_enabled,
      domainEnabled: !!r.domain_enabled,
      domainVerified: r.verification_status === 'verified',
      accountStatus: r.account_status as string,
    });
    return { session, mailboxActive };
  },

  async touch(sidHash, now) {
    await db('webmail_sessions').where({ sid_hash: sidHash }).update({ last_seen_at: new Date(now) });
  },

  async remove(sidHash) {
    await db('webmail_sessions').where({ sid_hash: sidHash }).delete();
  },

  async removeMailbox(mailboxId) {
    return Number(await db('webmail_sessions').where({ mailbox_id: mailboxId }).delete());
  },

  async removeAll() {
    return Number(await db('webmail_sessions').delete());
  },

  async sweep(now) {
    return Number(await db('webmail_sessions')
      .where('expires_at', '<=', new Date(now))
      .orWhere('last_seen_at', '<=', new Date(now - WEBMAIL_IDLE_MS))
      .delete());
  },
};
