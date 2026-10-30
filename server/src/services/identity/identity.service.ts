import type { Request } from 'express';
import { z } from 'zod';
import type {
  EmailChangeResult, EmailState, PasswordResetTokenState, RecoveryCodesGenerated, RecoveryCodesStatus,
} from '@oblimint/shared';
import {
  EMAIL_CHANGE_TTL_HOURS, MASTER_TENANT_ID, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_RESET_TTL_MINUTES, RECOVERY_CODE_COUNT,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { hashPassword } from '../../utils/crypto';
import { clientIp } from '../../utils/clientIp';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { recordSkippedTransactional, sendTransactional, transactionalMailReady, type TransactionalMessage } from '../mail/transactional';
import { panelHosts } from '../panelHosts';
import { deliverAccountNotice } from '../usage/userNotifications.service';
import { killSessionsForUser } from '../userSessions.service';
import {
  emailChangeRequestedMail, emailChangedNotice, emailConfirmMail, langOf, noticeMail, passwordResetMail, passwordResetNotice,
  recoveryCodeUsedNotice, type Lang,
} from './messages';
import { linkTokenHash, newLinkToken, newRecoveryCodes, recoveryCodeHash } from './secrets';

// ─────────────────────────────────────────────────────────────────────────────
// Self-service identity of LOCAL accounts (docs: shared/src/identity.ts).
//
// Forgotten password (POST /api/auth/password-reset):
//   - only an active account WITHOUT foreign_source (never an Obligate / og_
//     account) whose CURRENT address is verified (users.email_verified_for)
//     ever receives a link; every other case is silently ignored, and the
//     route answers the same thing after the same delay (no enumeration);
//   - the link carries a 256-bit token, only its sha256 is stored, valid 30
//     min, single use (atomic UPDATE … used_at), bound to the address it was
//     sent to (an address change kills it); a new request replaces the
//     previous link; a few requests per account and hour at most;
//   - the reset bumps credential_version (trigger) and ends EVERY session and
//     connector token of the account (killSessionsForUser); the second factor
//     is untouched: it is still asked at the next sign-in.
//
// Recovery codes: 10 one-time codes per batch, shown once, sha256 bound to the
// user; a sign-in with one notifies the account (bell + e-mail).
//
// E-mail change (step-up checked by the route): a link to the NEW address
// confirms it (24 h), the old address is told; without an e-mail sender the
// change applies but stays unverified (no reset link will go to it).
// ─────────────────────────────────────────────────────────────────────────────

const RESET_MIN_INTERVAL_MS = 60_000;
const RESET_MAX_PER_HOUR = 5;
const EMAIL_LINK_MIN_INTERVAL_MS = 30_000;

const emailSchema = z.string().trim().toLowerCase().min(3).max(254).regex(/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/, 'an e-mail address');
const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

interface IdentityRow {
  id: number;
  username: string;
  email: string | null;
  email_verified_for: string | null;
  kind: string;
  role: string;
  is_active: boolean;
  password_hash: string | null;
  foreign_source: string | null;
  preferred_language: string | null;
  totp_enabled: boolean;
  totp_secret: string | null;
}

const IDENTITY_COLUMNS = ['id', 'username', 'email', 'email_verified_for', 'kind', 'role', 'is_active', 'password_hash', 'foreign_source',
  'preferred_language', 'totp_enabled', 'totp_secret'] as const;

async function userRow(userId: number): Promise<IdentityRow | undefined> {
  return db('users').where({ id: userId }).first(...IDENTITY_COLUMNS) as Promise<IdentityRow | undefined>;
}

const lower = (v: string | null | undefined): string | null => (v ? v.trim().toLowerCase() : null);
const isVerified = (u: Pick<IdentityRow, 'email' | 'email_verified_for'>): boolean => !!u.email && lower(u.email) === u.email_verified_for;
/** A local account: never an SSO (Obligate) one, whatever its password column holds. */
const isLocal = (u: Pick<IdentityRow, 'foreign_source'>): boolean => !u.foreign_source;

/**
 * https origin of the panel for this kind of account: the client space for a
 * client when it is configured, else the panel host. Configured names only
 * (the Host header of the request is never used in a link). null: none set.
 */
export async function accountOrigin(kind: string): Promise<string | null> {
  const hosts = await panelHosts();
  const host = kind === 'client' && hosts.client ? hosts.client : hosts.admin;
  return host ? `https://${host}` : null;
}

async function auditTenantOf(userId: number): Promise<number> {
  const row = await db('user_tenants').where({ user_id: userId }).orderBy('tenant_id').first('tenant_id') as { tenant_id: number } | undefined;
  return row ? Number(row.tenant_id) : MASTER_TENANT_ID;
}

async function audit(userId: number, action: string, ip: string | null, details?: Record<string, unknown>): Promise<void> {
  await auditService.log({
    tenantId: await auditTenantOf(userId), userId, action, resourceType: 'user', resourcePath: String(userId), details, ipAddress: ip || undefined,
  });
}

/** Fire and forget (the caller never waits for SMTP); journaled by sendTransactional. */
function sendLater(m: TransactionalMessage): void {
  sendTransactional(m).catch((err) => logger.warn({ err: (err as Error).message }, 'identity e-mail failed'));
}

/** Personal notice: bell (always) + e-mail to the current address (when there is one). */
async function noticeToUser(u: IdentityRow, event: Parameters<typeof deliverAccountNotice>[1], content: { title: string; message: string },
  severity: 'info' | 'warning', opts: { tenantId?: number | null; emailTo?: string | null; link?: string } = {}): Promise<void> {
  await deliverAccountNotice(u.id, event, { ...content, severity, tenantId: opts.tenantId ?? null, link: opts.link ?? '/profile' });
  const to = opts.emailTo === undefined ? u.email : opts.emailTo;
  if (!to) return;
  const origin = await accountOrigin(u.kind).catch(() => null);
  const mail = noticeMail(langOf(u.preferred_language), content, origin ? { url: `${origin}${opts.link ?? '/profile'}` } : null);
  sendLater({ to, kind: 'account', userId: u.id, ...mail });
}

// ── tokens ───────────────────────────────────────────────────────────────────

type Purpose = 'password_reset' | 'email_change';

async function issueToken(userId: number, purpose: Purpose, email: string, ttlMs: number, ip: string | null): Promise<string> {
  const token = newLinkToken();
  await db.transaction(async (trx) => {
    // One live link per purpose: a new request replaces the previous one.
    await trx('user_action_tokens').where({ user_id: userId, purpose }).whereNull('used_at').delete();
    await trx('user_action_tokens').insert({
      user_id: userId, purpose, token_hash: linkTokenHash(token), email, expires_at: new Date(Date.now() + ttlMs), requested_ip: ip ? ip.slice(0, 64) : null,
    });
  });
  return token;
}

interface TokenRow { id: number | string; user_id: number; email: string; created_at: Date | string }

async function liveToken(raw: unknown, purpose: Purpose): Promise<TokenRow | null> {
  const hash = linkTokenHash(raw);
  if (!hash) return null;
  const row = await db('user_action_tokens').where({ token_hash: hash, purpose }).whereNull('used_at').where('expires_at', '>', db.fn.now())
    .first('id', 'user_id', 'email', 'created_at') as TokenRow | undefined;
  return row ?? null;
}

const invalidToken = () => new AppError(400, 'This link is invalid or has expired', 'invalidToken');

/** Expired / used tokens older than a day (called by the notification purge worker pass, best effort). */
export async function purgeActionTokens(now = Date.now()): Promise<number> {
  const cutoff = new Date(now - 86_400_000);
  return Number(await db('user_action_tokens').where((q) => q.where('expires_at', '<', cutoff).orWhere('used_at', '<', cutoff)).delete()) || 0;
}

// ── forgotten password ───────────────────────────────────────────────────────

export type ResetRequestOutcome = 'sent' | 'ignored' | 'throttled' | 'unavailable' | 'failed';

/** Eligible account owning this verified address (null otherwise). */
async function resetTarget(email: string): Promise<IdentityRow | null> {
  const rows = await db('users').whereRaw('lower(email) = ?', [email]).where({ is_active: true }).whereNull('foreign_source')
    .limit(2).select(...IDENTITY_COLUMNS) as IdentityRow[];
  // Two accounts on one address (case variants written before the checks): ambiguous, nothing is sent.
  if (rows.length !== 1) return null;
  const u = rows[0];
  return isLocal(u) && isVerified(u) ? u : null;
}

export const identityService = {
  /**
   * POST /api/auth/password-reset. Never throws, never tells the caller what
   * happened (the route answers the same thing in every case; the outcome is
   * for tests and logs).
   */
  async requestPasswordReset(rawEmail: unknown, ip: string | null): Promise<ResetRequestOutcome> {
    try {
      const parsed = emailSchema.safeParse(rawEmail);
      if (!parsed.success) return 'ignored';
      const u = await resetTarget(parsed.data);
      if (!u) return 'ignored';
      const recent = await db('user_action_tokens').where({ user_id: u.id, purpose: 'password_reset' })
        .where('created_at', '>', new Date(Date.now() - 3600_000)).orderBy('created_at', 'desc').select('created_at') as Array<{ created_at: Date | string }>;
      if (recent.length >= RESET_MAX_PER_HOUR || (recent[0] && Date.now() - new Date(recent[0].created_at).getTime() < RESET_MIN_INTERVAL_MS)) {
        await audit(u.id, 'user.password_reset_requested', ip, { outcome: 'throttled' });
        return 'throttled';
      }
      const lang = langOf(u.preferred_language);
      const origin = await accountOrigin(u.kind);
      if (!origin || !(await transactionalMailReady())) {
        const reason = !origin ? 'Aucun nom d’hôte du panel configuré' : 'Expéditeur des e-mails non configuré';
        await recordSkippedTransactional({ to: u.email!, kind: 'account', userId: u.id, subject: passwordResetMail(lang, u.username, '').subject, text: '' }, reason);
        await audit(u.id, 'user.password_reset_requested', ip, { outcome: 'unavailable' });
        return 'unavailable';
      }
      const token = await issueToken(u.id, 'password_reset', lower(u.email)!, PASSWORD_RESET_TTL_MINUTES * 60_000, ip);
      const mail = passwordResetMail(lang, u.username, `${origin}/reset-password?token=${encodeURIComponent(token)}`);
      const r = await sendTransactional({ to: u.email!, kind: 'account', userId: u.id, ...mail });
      await audit(u.id, 'user.password_reset_requested', ip, { outcome: r.ok ? 'sent' : 'failed' });
      return r.ok ? 'sent' : 'failed';
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'password reset request failed');
      return 'failed';
    }
  },

  /** POST /api/auth/password-reset/validate (does not consume the link). */
  async passwordResetTokenState(raw: unknown): Promise<PasswordResetTokenState> {
    const t = await liveToken(raw, 'password_reset');
    if (!t) return { valid: false };
    const u = await userRow(t.user_id);
    if (!u || !u.is_active || !isLocal(u) || lower(u.email) !== t.email) return { valid: false };
    return { valid: true, kind: u.kind === 'client' ? 'client' : 'staff' };
  },

  /** POST /api/auth/password-reset/confirm. 400 invalidToken / validation. */
  async confirmPasswordReset(raw: unknown, newPassword: unknown, ip: string | null): Promise<{ kind: 'staff' | 'client' }> {
    const pw = passwordSchema.safeParse(newPassword);
    if (!pw.success) {
      throw new AppError(400, `The password must hold ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`, 'validation', { field: 'newPassword' });
    }
    const hash = linkTokenHash(raw);
    if (!hash) throw invalidToken();
    // Cheap check first: a guessed token never costs a bcrypt round.
    if (!(await liveToken(raw, 'password_reset'))) throw invalidToken();
    const passwordHash = await hashPassword(pw.data);
    const user = await db.transaction(async (trx) => {
      const [t] = await trx('user_action_tokens')
        .where({ token_hash: hash, purpose: 'password_reset' }).whereNull('used_at').where('expires_at', '>', trx.fn.now())
        .update({ used_at: trx.fn.now() }).returning(['id', 'user_id', 'email']) as Array<{ id: number; user_id: number; email: string }>;
      if (!t) throw invalidToken();
      const u = await trx('users').where({ id: t.user_id }).forUpdate().first(...IDENTITY_COLUMNS) as IdentityRow | undefined;
      // The account changed since the link was sent: disabled, now SSO, another address.
      if (!u || !u.is_active || !isLocal(u) || lower(u.email) !== t.email) throw invalidToken();
      // credential_version moves (trigger): every session stamped before is refused by sessionUserGuard.
      await trx('users').where({ id: u.id }).update({ password_hash: passwordHash, updated_at: new Date() });
      await trx('user_action_tokens').where({ user_id: u.id, purpose: 'password_reset' }).whereNull('used_at').delete();
      return u;
    });
    await killSessionsForUser(user.id, 'password_reset');
    await audit(user.id, 'user.password_reset', ip, { via: 'email_link' });
    await noticeToUser(user, 'account.passwordReset', passwordResetNotice(langOf(user.preferred_language)), 'warning', { link: '/profile' });
    return { kind: user.kind === 'client' ? 'client' : 'staff' };
  },

  // ── recovery codes ─────────────────────────────────────────────────────────

  async recoveryStatus(userId: number): Promise<RecoveryCodesStatus> {
    const u = await userRow(userId);
    if (!u) throw new AppError(401, 'Authentication required');
    const row = await db('user_recovery_codes').where({ user_id: userId })
      .select(db.raw('count(*)::int as total'), db.raw('count(*) FILTER (WHERE used_at IS NULL)::int as remaining'), db.raw('max(created_at) as generated_at'))
      .first() as { total: number; remaining: number; generated_at: Date | string | null } | undefined;
    const totpEnabled = !!(u.totp_enabled && u.totp_secret);
    return {
      totpEnabled,
      total: totpEnabled ? Number(row?.total ?? 0) : 0,
      remaining: totpEnabled ? Number(row?.remaining ?? 0) : 0,
      generatedAt: totpEnabled && row?.generated_at ? new Date(row.generated_at).toISOString() : null,
    };
  },

  /** A new batch (the previous codes stop working). The caller checked the step-up. */
  async generateRecoveryCodes(userId: number): Promise<RecoveryCodesGenerated> {
    const u = await userRow(userId);
    if (!u) throw new AppError(401, 'Authentication required');
    if (!isLocal(u)) throw new AppError(403, 'The two-factor authentication of an SSO account is managed in Obligate.', 'ssoTwoFactorManaged');
    if (!(u.totp_enabled && u.totp_secret)) throw new AppError(400, 'Recovery codes need an authenticator app: enable it first', 'totpRequired');
    const codes = newRecoveryCodes(RECOVERY_CODE_COUNT);
    const now = new Date();
    await db.transaction(async (trx) => {
      await trx('user_recovery_codes').where({ user_id: userId }).delete();
      await trx('user_recovery_codes').insert(codes.map((c) => ({ user_id: userId, code_hash: recoveryCodeHash(userId, c), created_at: now })));
    });
    return { codes, generatedAt: now.toISOString() };
  },

  async clearRecoveryCodes(userId: number): Promise<void> {
    await db('user_recovery_codes').where({ user_id: userId }).delete();
  },

  /**
   * Consumes one unused code of the user (atomic: a code never works twice,
   * even on two concurrent sign-ins). The number of codes left, or null.
   */
  async consumeRecoveryCode(userId: number, code: unknown): Promise<number | null> {
    const hash = recoveryCodeHash(userId, code);
    if (!hash) return null;
    const used = await db('user_recovery_codes').where({ user_id: userId, code_hash: hash }).whereNull('used_at')
      .update({ used_at: db.fn.now() }).returning('id') as unknown[];
    if (used.length === 0) return null;
    const row = await db('user_recovery_codes').where({ user_id: userId }).whereNull('used_at').count<{ n: string }[]>({ n: '*' }).first();
    return Number(row?.n ?? 0);
  },

  /** After a sign-in with a recovery code: audit + bell + e-mail to the account. */
  async recoveryCodeUsed(userId: number, remaining: number, tenantId: number | null, ip: string | null): Promise<void> {
    const u = await userRow(userId);
    if (!u) return;
    await audit(userId, 'user.recovery_code_used', ip, { remaining });
    await noticeToUser(u, 'account.recoveryCodeUsed', recoveryCodeUsedNotice(langOf(u.preferred_language), remaining), 'warning', { tenantId, link: '/profile' });
  },

  // ── e-mail address ─────────────────────────────────────────────────────────

  async emailState(userId: number): Promise<EmailState> {
    const u = await userRow(userId);
    if (!u) throw new AppError(401, 'Authentication required');
    const t = await db('user_action_tokens').where({ user_id: userId, purpose: 'email_change' }).whereNull('used_at')
      .where('expires_at', '>', db.fn.now()).orderBy('id', 'desc').first('email', 'expires_at') as { email: string; expires_at: Date | string } | undefined;
    return {
      email: u.email ?? null,
      verified: isVerified(u),
      pending: t ? { email: t.email, expiresAt: new Date(t.expires_at).toISOString() } : null,
      mailAvailable: await transactionalMailReady(),
    };
  },

  /**
   * POST /api/profile/email — the route checked the step-up (current
   * password or TOTP). null / '' removes the address.
   */
  async requestEmailChange(req: Request, rawEmail: unknown): Promise<EmailChangeResult> {
    const userId = Number(req.session?.userId);
    const u = await userRow(userId);
    if (!u) throw new AppError(401, 'Authentication required');
    if (!isLocal(u)) throw new AppError(403, 'The e-mail address of an SSO account is managed in Obligate.', 'ssoEmailManaged');
    const ip = clientIp(req) || null;
    const lang = langOf(u.preferred_language);

    if (rawEmail === null || rawEmail === '') {
      if (!u.email) return { status: 'changed', state: await this.emailState(userId) };
      await db.transaction(async (trx) => {
        await trx('users').where({ id: userId }).update({ email: null, email_verified_for: null, updated_at: new Date() });
        await trx('user_action_tokens').where({ user_id: userId }).whereNull('used_at').delete();
      });
      await audit(userId, 'user.email_changed', ip, { via: 'removed' });
      await noticeToUser(u, 'account.emailChanged', emailChangedNotice(lang, null), 'warning', { tenantId: req.session.currentTenantId, emailTo: u.email });
      return { status: 'changed', state: await this.emailState(userId) };
    }

    const parsed = emailSchema.safeParse(rawEmail);
    if (!parsed.success) throw new AppError(400, 'A valid e-mail address is required', 'validation', { field: 'email' });
    const next = parsed.data;
    const same = lower(u.email) === next;
    if (same && isVerified(u)) return { status: 'changed', state: await this.emailState(userId) };
    if (!same && await db('users').whereRaw('lower(email) = ?', [next]).whereNot({ id: userId }).first('id')) {
      throw new AppError(409, 'This e-mail address is already used', 'emailTaken');
    }

    const origin = await accountOrigin(u.kind);
    if (origin && await transactionalMailReady()) {
      const last = await db('user_action_tokens').where({ user_id: userId, purpose: 'email_change' }).orderBy('id', 'desc').first('created_at', 'email') as
        { created_at: Date | string; email: string } | undefined;
      if (last && last.email === next && Date.now() - new Date(last.created_at).getTime() < EMAIL_LINK_MIN_INTERVAL_MS) {
        throw new AppError(429, 'A link was just sent to this address: wait a moment before asking again', 'tooSoon');
      }
      const token = await issueToken(userId, 'email_change', next, EMAIL_CHANGE_TTL_HOURS * 3600_000, ip);
      const r = await sendTransactional({ to: next, kind: 'account', userId, ...emailConfirmMail(lang, u.username, `${origin}/confirm-email?token=${encodeURIComponent(token)}`) });
      if (!r.ok) {
        await db('user_action_tokens').where({ token_hash: linkTokenHash(token) }).delete();
        throw new AppError(502, 'The confirmation e-mail could not be sent: try again later', 'mailFailed');
      }
      // The current (verified) address learns about a change to another one.
      if (!same && u.email && isVerified(u)) sendLater({ to: u.email, kind: 'account', userId, ...emailChangeRequestedMail(lang, u.username, next) });
      await audit(userId, same ? 'user.email_verification_requested' : 'user.email_change_requested', ip, same ? undefined : { to: next });
      return { status: 'pending', state: await this.emailState(userId) };
    }

    // No e-mail sender: applied, unverified (no reset link will ever go to it until it is confirmed).
    if (same) throw new AppError(503, 'The platform cannot send e-mails yet: the address cannot be confirmed', 'mailUnavailable');
    try {
      await db.transaction(async (trx) => {
        await trx('users').where({ id: userId }).update({ email: next, email_verified_for: null, updated_at: new Date() });
        await trx('user_action_tokens').where({ user_id: userId }).whereNull('used_at').delete();
      });
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') throw new AppError(409, 'This e-mail address is already used', 'emailTaken');
      throw err;
    }
    await audit(userId, 'user.email_changed', ip, { via: 'unverified' });
    await noticeToUser(u, 'account.emailChanged', emailChangedNotice(lang, next), 'info', { tenantId: req.session.currentTenantId, emailTo: null });
    return { status: 'changed', state: await this.emailState(userId) };
  },

  async cancelEmailChange(userId: number): Promise<EmailState> {
    await db('user_action_tokens').where({ user_id: userId, purpose: 'email_change' }).whereNull('used_at').delete();
    return this.emailState(userId);
  },

  /** POST /api/auth/email-change/confirm (public: the link may be opened anywhere). */
  async confirmEmailChange(raw: unknown, ip: string | null): Promise<{ email: string; kind: 'staff' | 'client' }> {
    const hash = linkTokenHash(raw);
    if (!hash) throw invalidToken();
    let before: IdentityRow | undefined;
    let email = '';
    try {
      await db.transaction(async (trx) => {
        const [t] = await trx('user_action_tokens')
          .where({ token_hash: hash, purpose: 'email_change' }).whereNull('used_at').where('expires_at', '>', trx.fn.now())
          .update({ used_at: trx.fn.now() }).returning(['id', 'user_id', 'email']) as Array<{ id: number; user_id: number; email: string }>;
        if (!t) throw invalidToken();
        before = await trx('users').where({ id: t.user_id }).forUpdate().first(...IDENTITY_COLUMNS) as IdentityRow | undefined;
        if (!before || !before.is_active || !isLocal(before)) throw invalidToken();
        if (await trx('users').whereRaw('lower(email) = ?', [t.email]).whereNot({ id: t.user_id }).first('id')) {
          throw new AppError(409, 'This e-mail address is already used by another account', 'emailTaken');
        }
        email = t.email;
        // Password reset links were bound to the old address: they die with it.
        await trx('users').where({ id: t.user_id }).update({ email: t.email, email_verified_for: t.email, updated_at: new Date() });
        await trx('user_action_tokens').where({ user_id: t.user_id }).whereNull('used_at').delete();
      });
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') throw new AppError(409, 'This e-mail address is already used by another account', 'emailTaken');
      throw err;
    }
    const u = before!;
    const changed = lower(u.email) !== email;
    await audit(u.id, changed ? 'user.email_changed' : 'user.email_verified', ip, changed ? { via: 'confirmation' } : undefined);
    if (changed) {
      const n = emailChangedNotice(langOf(u.preferred_language), email);
      await deliverAccountNotice(u.id, 'account.emailChanged', { ...n, severity: 'info', link: '/profile' });
      // The previous address learns that it no longer receives the account's e-mails.
      if (u.email) {
        const origin = await accountOrigin(u.kind).catch(() => null);
        sendLater({ to: u.email, kind: 'account', userId: u.id, ...noticeMail(langOf(u.preferred_language), n, origin ? { url: `${origin}/profile` } : null) });
      }
    }
    return { email, kind: u.kind === 'client' ? 'client' : 'staff' };
  },
};

export type { Lang };
