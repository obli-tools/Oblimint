import type { Request } from 'express';
import type { WebmailSsoTicket } from '@oblimint/shared';
import { WEBMAIL_SSO_FRAGMENT } from '@oblimint/shared';
import { db } from '../../../db';
import { AppError } from '../../../middleware/errorHandler';
import { logger } from '../../../utils/logger';
import { auditService } from '../../audit.service';
import { appConfigService } from '../../appConfig.service';
import { platformSettings } from '../../platformSettings';
import { errText } from '../../setup/docker';
import { registerEdgeContributor, unregisterEdgeContributor } from '../../edge/contributors';
import { SERVED_ACCOUNT_STATUSES } from '../../edge/vhostPlan';
import { isValidServerName } from '../../edge/nginxConfig';
import type { HostingActor } from '../../hosting/access';
import { loadMailbox } from '../access';
import { accountServesMail } from '../mappers';
import type { DesiredAppPassword } from '../driver';
import { mailService } from '../mail.service';
import { mailNetworkSubnets } from '../network';
import { APP_PASSWORD_SLOTS } from '../engines/postfixDovecot/layout';
import { generateMailPassword, hashMailPassword, verifyMailPassword } from '../passwords';
import { activeMailDriver } from '../registry';
import { isUnderPanel, webmailEdgeContributor, webmailHostRefusal } from './edgeContributor';
import { webmailTokens, type WebmailCredentials } from './ssoTokens';
import { removeWebmail, webmailInfraComponent, webmailRunning, wantedWebmailKind } from './webmailInfra';
import { oblimintWebmailListening, resetOblimintWebmailCache } from './oblimint/server';
import { dbWebmailSessionStore } from './oblimint/session';

// ─────────────────────────────────────────────────────────────────────────────
// Webmail + single sign-on (docs/P4-PLAN.md §9.7, MA4 / MA6 / MA13, B3).
//
// openSession: mail.manage on the mailbox's account; mailbox enabled, account
// active, mail domain active, engine with mailboxes, webmail deployed and
// reachable on a host (webmail.<d> with a certificate, else the platform
// webmail host — never under the panel host). Then:
//   1. a random session CREDENTIAL (32 bytes) stored as a SHA512-CRYPT hash
//      in mail_app_passwords (purpose webmail, 12 h); the engine only
//      accepts it from the mail network (DesiredAppPassword.allowNets —
//      postfix-dovecot; Stalwart cannot restrict it: risk R-STALWART-APPPW);
//   2. a sync run NOW on the serialized sync chain (sync.ts runSyncNow: its
//      desired state is loaded after the insert), bounded (≤ 10 s), that
//      must have applied this mailbox's domain, else 409 webmailUnavailable
//      (credential revoked);
//   3. a one-time TOKEN (memory, 60 s, ssoTokens.ts) → URL
//      https://<webmail host>/?_oblimint_sso=<token>.
// The webmail container redeems the token on the internal listener
// (internalRoutes.ts: source + shared key) and logs into IMAP with
// (address, credential): the credential never reaches the browser, a log or
// the audit; the mailbox password is never handled. Logout (container),
// expiry (timer), mailbox disabled / password changed / deleted → revoked_at
// + requestSync (the engine drops it at the next sync). Rows older than
// 7 days are deleted.
// ─────────────────────────────────────────────────────────────────────────────

export const WEBMAIL_SESSION_TTL_MS = 12 * 60 * 60_000;
export const WEBMAIL_SYNC_WAIT_MS = 10_000;
/**
 * Live session credentials per mailbox: the oldest is revoked (revoked_at)
 * beyond. Equals the postfix-dovecot slot count: the engine renders at most
 * APP_PASSWORD_SLOTS credentials per address, so a 9th would be dropped
 * silently (DB and engine disagreeing).
 */
export const MAX_WEBMAIL_SESSIONS_PER_MAILBOX = APP_PASSWORD_SLOTS;
export const WEBMAIL_ROW_RETENTION_MS = 7 * 24 * 60 * 60_000;
const EXPIRY_INTERVAL_MS = 60_000;
const SETTINGS_DEBOUNCE_MS = 1_000;

export const SSO_QUERY_PARAM = '_oblimint_sso';

// ── seams (tests) ────────────────────────────────────────────────────────────

export interface WebmailDeps {
  requestSync(reason: string): void;
  /**
   * Runs an engine sync whose desired state is loaded NOW (after the
   * credential insert); true when it applied `domain` within timeoutMs.
   * Never throws.
   */
  syncNow(domain: string, timeoutMs: number): Promise<boolean>;
  /** The webmail container runs. */
  running(): Promise<boolean>;
  /** The Oblimint webmail listener is up (kind oblimint). */
  oblimintRunning(): boolean;
  /** Ends Oblimint webmail sessions: of one mailbox, or all (null). Never throws. */
  endOblimintSessions(mailboxId: number | null): Promise<number>;
  /** Subnets of the mail network (allowNets). */
  subnets(): Promise<string[]>;
  now(): number;
}

/**
 * Default: sync.ts runCoalescedSync — the first sync that STARTS after this
 * call (its desired state is read after the insert), shared with every
 * webmail login arriving meanwhile (no per-login full engine reload), raced
 * against timeoutMs. Success = that sync applied, fully ok or without a
 * failure for `domain`. Never systemStatus(). Never throws.
 */
async function defaultSyncNow(domain: string, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const sync = await import('../sync');
    const result = await Promise.race([
      sync.runCoalescedSync('webmail session'),
      new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); timer.unref?.(); }),
    ]);
    if (result === 'timeout' || !result) return false; // too slow, or that sync failed (driver error, guard…)
    const failing = result.domainErrors ?? {};
    if (Object.prototype.hasOwnProperty.call(failing, domain)) return false;
    return result.ok || Object.keys(failing).length > 0;
  } catch (err) {
    logger.warn({ err: errText(err) }, 'webmail: engine sync failed');
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const defaultDeps: WebmailDeps = {
  requestSync: (reason) => mailService.requestSync(reason),
  syncNow: defaultSyncNow,
  running: webmailRunning,
  oblimintRunning: oblimintWebmailListening,
  endOblimintSessions: (mailboxId) => (mailboxId === null ? dbWebmailSessionStore.removeAll() : dbWebmailSessionStore.removeMailbox(mailboxId)).catch(() => 0),
  subnets: mailNetworkSubnets,
  now: Date.now,
};
let deps: WebmailDeps = defaultDeps;

/** Tests: override some seams; null restores the real ones. */
export function setWebmailDepsForTests(partial: Partial<WebmailDeps> | null): void {
  deps = partial ? { ...defaultDeps, ...partial } : defaultDeps;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function unavailable(message: string): AppError {
  return new AppError(409, message, 'webmailUnavailable');
}

async function panelHost(): Promise<string | null> {
  return (await appConfigService.get('panel_hostname'))?.trim().toLowerCase() || null;
}

/** Is `name` covered by a VALID platform certificate (row names, exact or one-label wildcard)? */
async function hasValidCertificate(name: string): Promise<boolean> {
  const wildcard = `*.${name.slice(name.indexOf('.') + 1)}`;
  const row = await db('certificates')
    .whereNull('domain_id').whereNull('site_id').where('status', 'valid')
    .where((q) => q.whereRaw('names @> ?::jsonb', [JSON.stringify([name])]).orWhereRaw('names @> ?::jsonb', [JSON.stringify([wildcard])]))
    .first('id');
  return !!row;
}

/** Is the mail domain active (enabled, domain verified — D1 —, account served)? */
async function mailDomainActive(name: string): Promise<boolean> {
  const row = await db('mail_domains as md')
    .join('domains as d', 'd.id', 'md.domain_id')
    .join('hosting_accounts as a', 'a.id', 'md.account_id')
    .where('md.name', name)
    .where('md.enabled', true)
    .where('d.verification_status', 'verified')
    .whereIn('a.status', [...SERVED_ACCOUNT_STATUSES])
    .first('md.id');
  return !!row;
}

/** Revokes active credentials matching `where`; returns how many. */
async function revokeWhere(where: (q: ReturnType<typeof db>) => void): Promise<number> {
  const q = db('mail_app_passwords').whereNull('revoked_at');
  where(q);
  return Number(await q.update({ revoked_at: new Date(deps.now()), updated_at: new Date(deps.now()) }));
}

/** Subnets of the mail network usable as allowNets ([] on any error). */
async function mailNets(): Promise<string[]> {
  try {
    return (await deps.subnets()).filter((n) => typeof n === 'string' && n.includes('/'));
  } catch {
    return [];
  }
}

/** Validated redeem / logout identity (never echoed). */
const ADDRESS_RE = /^[^\s@]{1,64}@[a-z0-9.-]{1,253}$/;

// ── expiry / settings (worker) ───────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let settingsTimer: NodeJS.Timeout | null = null;
let lastKind: string | null = null;

/**
 * Expired credentials → revoked_at (+ engine sync), rows older than 7 days
 * deleted, expired tokens dropped. Never throws. Returns the revoked count.
 */
export async function expireWebmailSessions(now = deps.now()): Promise<number> {
  webmailTokens.sweep();
  try {
    const at = new Date(now);
    const revoked = Number(await db('mail_app_passwords').whereNull('revoked_at').where('expires_at', '<=', at)
      .update({ revoked_at: at, updated_at: at }));
    await db('mail_app_passwords').where('created_at', '<', new Date(now - WEBMAIL_ROW_RETENTION_MS))
      .where((q) => q.whereNotNull('revoked_at').orWhere('expires_at', '<=', at))
      .delete();
    if (revoked > 0) {
      logger.info({ count: revoked }, 'webmail: session credentials expired');
      deps.requestSync('webmail sessions expired');
    }
    return revoked;
  } catch (err) {
    logger.warn({ err: errText(err) }, 'webmail: session expiry pass failed');
    return 0;
  }
}

/** (Re)deploys or removes the container per settings, then edge sync. Never throws. */
async function applySettings(): Promise<void> {
  const log = (line: string) => logger.info({ component: 'webmail' }, line);
  try {
    const kind = await wantedWebmailKind();
    if (lastKind !== null && kind !== lastKind) {
      // Another webmail (or none): the sessions of the previous one end now.
      webmailTokens.clear();
      const n = await revokeWhere(() => undefined);
      if (n > 0) deps.requestSync('webmail changed');
      await deps.endOblimintSessions(null);
    }
    resetOblimintWebmailCache();
    lastKind = kind;
    if (kind) await webmailInfraComponent.ensure(log);
    else await removeWebmail(log);
  } catch (err) {
    logger.warn({ err: errText(err) }, 'webmail: settings change not applied (retried at the next change / boot)');
  }
  try {
    (await import('../../edge/edge.service')).edgeService.scheduleSync('webmail settings');
  } catch (err) {
    logger.warn({ err: errText(err) }, 'webmail: edge sync not scheduled');
  }
}

// ── service ──────────────────────────────────────────────────────────────────

export const webmailService = {
  /** POST /mail/mailboxes/:id/webmail-session — mail.manage on the account; 409 webmailUnavailable / mailboxDisabled / accountSuspended / mailEngineNoMailboxes. Audited `mail.webmail.sso`. */
  async openSession(req: Request, actor: HostingActor, mailboxId: number): Promise<WebmailSsoTicket> {
    const mb = await loadMailbox(actor, mailboxId, 'mail.manage');
    // Same rule as the engine login (desiredState loginEnabled, mail-core accountServesMail): only a
    // suspended / deleted account loses mail access — a site-container error never cuts the webmail.
    if (!accountServesMail(mb.account_status)) throw new AppError(409, 'This account is suspended', 'accountSuspended');
    if (!mb.enabled) throw new AppError(409, 'This mailbox is disabled', 'mailboxDisabled');
    if (!(await mailDomainActive(mb.domain_name))) throw new AppError(409, 'The mail domain of this mailbox is not active', 'mailboxDisabled');

    const driver = await activeMailDriver();
    if (!driver.capabilities.mailboxes) throw new AppError(409, 'The mail engine has no mailboxes', 'mailEngineNoMailboxes');
    const settings = await platformSettings.section('mail');
    if (settings.webmail === 'none') throw unavailable('No webmail is configured');
    const kind = settings.webmail;
    const url = await this.urlFor(mb.domain_name);
    if (!url) throw unavailable('No webmail host is served for this domain');

    if (kind === 'oblimint') {
      // Panel's own webmail: no credential, no engine sync — the webmail listener
      // impersonates the mailbox on the engine (JMAP, Stalwart only).
      if (driver.engine !== 'stalwart') throw unavailable('The Oblimint webmail needs the Stalwart mail engine');
      if (!deps.oblimintRunning()) throw unavailable('The webmail is not running');
      const { token, expiresAt: tokenExpiry } = webmailTokens.issue({
        kind: 'oblimint', credentials: null, appPasswordId: null, mailboxId: mb.id, accountId: mb.account_id,
      });
      await auditService.logReqAs(req, mb.tenant_id, 'mail.webmail.sso', {
        resourceType: 'mailbox',
        resourcePath: String(mb.id),
        details: { address: mb.address, webmail: kind },
      });
      // Token in the FRAGMENT: never sent to a server, never in an access log or a Referer.
      return { url: `${url}#${WEBMAIL_SSO_FRAGMENT}=${encodeURIComponent(token)}`, expiresAt: tokenExpiry.toISOString() };
    }

    if (!(await deps.running())) throw unavailable('The webmail is not running');
    // appPasswords() drops every credential without the mail network subnets (fail closed): no ticket then.
    if ((await mailNets()).length === 0) throw unavailable('The mail network is not available');

    // 1. session credential (hash only), bounded per mailbox.
    const password = generateMailPassword(32);
    const { hash } = hashMailPassword(password);
    const now = deps.now();
    const expiresAt = new Date(now + WEBMAIL_SESSION_TTL_MS);
    const appPasswordId = await db.transaction(async (trx) => {
      const live = await trx('mail_app_passwords').where({ mailbox_id: mb.id }).whereNull('revoked_at').where('expires_at', '>', new Date(now))
        .orderBy('id', 'desc').pluck('id') as Array<number | string>;
      const excess = live.slice(MAX_WEBMAIL_SESSIONS_PER_MAILBOX - 1).map(Number);
      if (excess.length) await trx('mail_app_passwords').whereIn('id', excess).update({ revoked_at: new Date(now), updated_at: new Date(now) });
      const [row] = await trx('mail_app_passwords').insert({
        account_id: mb.account_id,
        mailbox_id: mb.id,
        purpose: 'webmail',
        password_hash: hash,
        created_by: actor.userId,
        expires_at: expiresAt,
      }).returning('id');
      return Number((row as { id?: number })?.id ?? row);
    });

    // 2. the engine must know it before the webmail logs in.
    if (!(await deps.syncNow(mb.domain_name, WEBMAIL_SYNC_WAIT_MS))) {
      await revokeWhere((q) => { q.where({ id: appPasswordId }); }).catch(() => 0);
      deps.requestSync('webmail session aborted');
      throw unavailable('The mail engine did not take the webmail session in time');
    }

    // 3. one-time token for the webmail container.
    const { token, expiresAt: tokenExpiry } = webmailTokens.issue({
      appPasswordId,
      mailboxId: mb.id,
      accountId: mb.account_id,
      kind,
      credentials: { username: mb.address, password, expiresAt: expiresAt.toISOString() },
    });
    await auditService.logReqAs(req, mb.tenant_id, 'mail.webmail.sso', {
      resourceType: 'mailbox',
      resourcePath: String(mb.id),
      details: { address: mb.address, webmail: kind },
    });
    return { url: `${url}?${SSO_QUERY_PARAM}=${encodeURIComponent(token)}`, expiresAt: tokenExpiry.toISOString() };
  },

  /** Public webmail URL of a mailbox's domain (webmail.<d>, else the platform webmail host — each only with a valid certificate), null = none. */
  async urlFor(domain: string): Promise<string | null> {
    const settings = await platformSettings.section('mail');
    if (settings.webmail === 'none') return null;
    const panel = await panelHost();
    const d = String(domain ?? '').trim().toLowerCase();
    if (settings.webmailPerDomain && d) {
      const name = `webmail.${d}`;
      // Served by the edge with TLS: active domain, not a tenant domain of its own, not under the panel host, certificate valid.
      if (isValidServerName(name) && !isUnderPanel(name, panel) && await mailDomainActive(d)
        && !(await db('domains').where({ name }).first('id')) && await hasValidCertificate(name)) {
        return `https://${name}/`;
      }
    }
    const platform = settings.webmailHostname?.trim().toLowerCase() || null;
    // Same rule as webmail.<d>: the edge only proxies a webmail name with a valid certificate (else ACME-only vhost).
    if (platform && isValidServerName(platform) && !webmailHostRefusal(platform, panel) && await hasValidCertificate(platform)) {
      return `https://${platform}/`;
    }
    return null;
  },

  /** Active (unexpired, unrevoked) session credentials for the desired state. */
  async appPasswords(): Promise<DesiredAppPassword[]> {
    // Fail closed: without the mail network subnets, no credential at all
    // (an empty allowNets must never mean "from anywhere").
    const allowNets = await mailNets();
    if (allowNets.length === 0) return [];
    const rows = await db('mail_app_passwords as p')
      .join('mailboxes as m', function joinMailbox() { this.on('m.id', '=', 'p.mailbox_id').andOn('m.account_id', '=', 'p.account_id'); })
      .whereNull('p.revoked_at')
      .where('p.expires_at', '>', new Date(deps.now()))
      .where('p.purpose', 'webmail')
      .where('m.enabled', true)
      .orderBy('p.id')
      .select('p.id', 'p.mailbox_id', 'm.address', 'p.password_hash', 'p.expires_at') as
      Array<{ id: number; mailbox_id: number; address: string; password_hash: string; expires_at: Date | string }>;
    return rows.map((r) => ({
      id: Number(r.id),
      mailboxId: Number(r.mailbox_id),
      address: r.address,
      passwordHash: r.password_hash,
      expiresAt: new Date(r.expires_at).toISOString(),
      purpose: 'webmail' as const,
      allowNets: [...allowNets],
    }));
  },

  // ── internal listener (internalRoutes.ts) ──

  /** Trades a one-time token for the session credential; null = refused (unknown / expired / replayed / revoked / other webmail). */
  async redeem(token: unknown): Promise<WebmailCredentials | null> {
    const ticket = webmailTokens.redeem(token);
    // An Oblimint webmail token is never traded for a credential (it has none).
    if (!ticket || ticket.kind === 'oblimint') return null;
    const settings = await platformSettings.section('mail');
    if (settings.webmail !== ticket.kind) return null;
    const row = await db('mail_app_passwords').where({ id: ticket.appPasswordId, mailbox_id: ticket.mailboxId })
      .whereNull('revoked_at').where('expires_at', '>', new Date(deps.now())).first('id');
    if (!row) return null;
    logger.info({ mailboxId: ticket.mailboxId, accountId: ticket.accountId, webmail: ticket.kind }, 'webmail SSO token redeemed');
    return { ...ticket.credentials };
  },

  /** Oblimint webmail (in-process): one-time token → mailbox id; null = refused (unknown / expired / replayed / other webmail). */
  async redeemOblimint(token: unknown): Promise<{ mailboxId: number } | null> {
    const ticket = webmailTokens.redeem(token);
    if (!ticket || ticket.kind !== 'oblimint') return null;
    const settings = await platformSettings.section('mail');
    if (settings.webmail !== 'oblimint') return null;
    logger.info({ mailboxId: ticket.mailboxId, accountId: ticket.accountId, webmail: ticket.kind }, 'webmail SSO token redeemed');
    return { mailboxId: ticket.mailboxId };
  },

  /** Oblimint webmail: mailbox of a live token of kind 'oblimint', the token left unused (confirmation screen). */
  async peekOblimint(token: unknown): Promise<{ mailboxId: number } | null> {
    const ticket = webmailTokens.peek(token);
    if (!ticket || ticket.kind !== 'oblimint') return null;
    const settings = await platformSettings.section('mail');
    if (settings.webmail !== 'oblimint') return null;
    return { mailboxId: ticket.mailboxId };
  },

  /** Webmail logout: revokes the session credential presented (constant work per live session). */
  async logout(username: unknown, password: unknown): Promise<boolean> {
    if (typeof username !== 'string' || typeof password !== 'string' || password.length === 0 || password.length > 256) return false;
    const address = username.trim().toLowerCase();
    if (address.length > 254 || !ADDRESS_RE.test(address)) return false;
    const rows = await db('mail_app_passwords as p')
      .join('mailboxes as m', 'm.id', 'p.mailbox_id')
      .where('m.address', address)
      .whereNull('p.revoked_at')
      .where('p.expires_at', '>', new Date(deps.now()))
      .orderBy('p.id', 'desc')
      .limit(MAX_WEBMAIL_SESSIONS_PER_MAILBOX)
      .select('p.id', 'p.mailbox_id', 'p.password_hash') as Array<{ id: number; mailbox_id: number; password_hash: string }>;
    const hit = rows.find((r) => verifyMailPassword(password, r.password_hash));
    if (!hit) return false;
    await revokeWhere((q) => { q.where({ id: hit.id }); });
    logger.info({ mailboxId: Number(hit.mailbox_id) }, 'webmail session closed (credential revoked)');
    deps.requestSync('webmail logout');
    return true;
  },

  // ── hooks (never throw) ──

  /** Mailbox disabled / password changed / deleted: revoke its sessions. */
  mailboxChanged(mailboxId: number, reason: 'disabled' | 'password' | 'deleted'): void {
    try {
      webmailTokens.revokeMailbox(mailboxId);
    } catch { /* memory only */ }
    // Oblimint webmail sessions of the mailbox end now (deleted: CASCADE did it already).
    if (reason !== 'deleted') void deps.endOblimintSessions(mailboxId);
    void (async () => {
      // 'deleted': the rows went with the mailbox (CASCADE); the sync drops them from the engine.
      const n = reason === 'deleted' ? 0 : await revokeWhere((q) => { q.where({ mailbox_id: mailboxId }); });
      if (n > 0 || reason === 'deleted') deps.requestSync(`webmail sessions revoked (${reason})`);
    })().catch((err) => logger.warn({ err: errText(err), mailboxId, reason }, 'webmail: session revocation failed'));
  },

  /** (Re)deploys / removes the container per settings mail.webmail, then edge sync (debounced). */
  settingsChanged(): void {
    if (settingsTimer) clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => {
      settingsTimer = null;
      void applySettings();
    }, SETTINGS_DEBOUNCE_MS);
    settingsTimer.unref?.();
  },

  /** Registers the edge contributor and the expiry timer. */
  start(): void {
    try {
      registerEdgeContributor(webmailEdgeContributor);
    } catch (err) {
      logger.warn({ err: errText(err) }, 'webmail: edge contributor not registered');
    }
    if (timer) return;
    void wantedWebmailKind().then((k) => { if (lastKind === null) lastKind = k; }).catch(() => undefined);
    timer = setInterval(() => { void expireWebmailSessions(); }, EXPIRY_INTERVAL_MS);
    timer.unref?.();
    setTimeout(() => { void expireWebmailSessions(); }, 5_000).unref?.();
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
    if (settingsTimer) clearTimeout(settingsTimer);
    settingsTimer = null;
    try { unregisterEdgeContributor(webmailEdgeContributor.id); } catch { /* nothing registered */ }
  },
};

/** Tests. */
export function resetWebmailStateForTests(): void {
  webmailTokens.clear();
  lastKind = null;
  webmailService.stop();
}
