import crypto from 'crypto';
import type { Request } from 'express';
import {
  MAIL_DEVICE_ID_PREFIX, MAIL_DEVICE_PROTOCOL_SETS, MAIL_DEVICE_PUBLIC_ID_RE, MAIL_DEVICE_REVOKED_REASONS, MAIL_DEVICE_SLOTS,
  MANUAL_APP_PASSWORD_DAYS,
  type MailDevice, type MailDeviceBasis, type MailDeviceClient, type MailDeviceCreate, type MailDeviceCreated, type MailDeviceList,
  type MailDeviceProtocol, type MailDeviceRevoke, type MailDeviceRevokedReason, type MailDeviceSelf, type MailDeviceStatus,
} from '@oblimint/shared';
import { db } from '../../../db';
import { AppError } from '../../../middleware/errorHandler';
import { logger } from '../../../utils/logger';
import { auditService } from '../../audit.service';
import { assertNotContained } from '../../containment/guard';
import type { HostingActor } from '../../hosting/access';
import { platformSettings } from '../../platformSettings';
import { errText } from '../../setup/docker';
import { loadMailbox, type MailboxLoaded } from '../access';
import { buildMailClientServers } from '../autoconfig/mailClientDiscovery';
import { mailHostname } from '../contracts';
import type { DesiredAppPassword } from '../driver';
import { accountServesMail } from '../mappers';
import { generateMailPassword, hashMailPassword } from '../passwords';
import { activeMailDriver } from '../registry';

// ─────────────────────────────────────────────────────────────────────────────
// Device passwords of a mailbox (« Se connecter à Mint », O4a — lot 1).
//
// A device password is a mail_app_passwords row of purpose 'device': 32
// random bytes generated HERE, shown once, kept as two digests — the
// {SHA512-CRYPT} hash the engines verify, and verifier_sha256 for the device
// API (one row read by public id, constant-time comparison). Login on IMAP /
// SMTP = the mailbox address. Never logged, never audited, never in an error
// (MA4): the audit carries the public id (omd_…).
//
//  - panel (mail.manage on the mailbox's account): list, manual creation
//    (label, 90 d / 1 y / 3 y, IMAP+SMTP or IMAP+POP3+SMTP; gate
//    mail.device_create in the route), revocation of one or all (reason
//    'manager'), « also disconnect the devices » with a password change
//    ('password');
//  - provider of the desired state (live rows, mailbox / account state
//    filtered by desiredState like the webmail rows): a suspended mailbox or
//    account keeps its device passwords, they come back with it;
//  - device API (routes/mailClientV1.routes.ts, L1c): status of the
//    credential (a revoked / expired one answers its status, never 401),
//    daily check-in (last_seen_*, MailForge rows pushed back by
//    mail.devicePasswordIdleDays), revocation by the device itself ('device');
//  - after any revocation: engine sync, then the open sessions of the mailbox
//    are kicked (postfix-dovecot) and the ban allowance refreshed (O11).
// The expiry ('expired') and the purge (400 days) are the shared expiry pass
// of webmail.service (expireAppPasswords).
// ─────────────────────────────────────────────────────────────────────────────

const CHECKIN_INTERVAL_MS = 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const LABEL_MAX = 64;

// ── seams (tests) ────────────────────────────────────────────────────────────

export interface DevicesDeps {
  requestSync(reason: string): void;
  /** Credentials of these mailboxes were revoked: sync, then end the open sessions, refresh the ban allowance. Never throws. */
  revoked(addresses: string[], reason: MailDeviceRevokedReason): void;
  /** engineReady: a sync read after `since` applied `domain`. */
  appliedSince(domain: string, since: Date): boolean;
  now(): number;
}

async function defaultRevoked(addresses: string[], reason: MailDeviceRevokedReason): Promise<void> {
  try {
    (await import('../security/mailSecurity.service')).invalidateRevocationAllowance();
  } catch (err) {
    logger.warn({ err: errText(err) }, 'mail devices: ban allowance not refreshed');
  }
  const sync = await import('../sync');
  const result = await sync.runCoalescedSync(`device passwords revoked (${reason})`);
  if (!result) return; // the engine still knows the credentials: kicking now would only reconnect them
  const driver = await activeMailDriver();
  if (!driver.kickSessions) return;
  for (const address of [...new Set(addresses.map((a) => a.toLowerCase()))]) {
    await driver.kickSessions(address).catch((err) => logger.warn({ err: errText(err) }, 'mail devices: open sessions not ended'));
  }
}

const defaultDeps: DevicesDeps = {
  requestSync: (reason) => {
    void import('../mail.service').then((m) => m.mailService.requestSync(reason)).catch(() => undefined);
  },
  revoked: (addresses, reason) => {
    if (addresses.length === 0) return;
    void defaultRevoked(addresses, reason).catch((err) => logger.warn({ err: errText(err) }, 'mail devices: post-revocation steps failed'));
  },
  appliedSince: (domain, since) => {
    // Lazy: sync.ts imports the desired state, which imports the providers (this module among them).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('../sync') as typeof import('../sync')).mailSyncAppliedSince(domain, since);
  },
  now: Date.now,
};
let deps: DevicesDeps = defaultDeps;

/** Tests: override some seams; null restores the real ones. */
export function setDevicesDepsForTests(partial: Partial<DevicesDeps> | null): void {
  deps = partial ? { ...defaultDeps, ...partial } : defaultDeps;
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface DeviceRow {
  id: number;
  account_id: number;
  mailbox_id: number;
  public_id: string;
  label: string;
  client: MailDeviceClient;
  basis: MailDeviceBasis;
  protocols: unknown;
  verifier_sha256: string;
  password_hash: string;
  created_by: number | null;
  created_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  revoked_reason: string | null;
  last_seen_at: Date | string | null;
  last_seen_ip: string | null;
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 'omd_' + 16 base32 characters (80 random bits). */
export function newDevicePublicId(): string {
  const bytes = crypto.randomBytes(10);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `${MAIL_DEVICE_ID_PREFIX}${out.slice(0, 16)}`;
}

export function deviceVerifier(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex SHA-256 digests. */
function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(String(a ?? ''), 'hex');
  const y = Buffer.from(String(b ?? ''), 'hex');
  return x.length === 32 && y.length === 32 && crypto.timingSafeEqual(x, y);
}

function protocolsOf(v: unknown): MailDeviceProtocol[] {
  let list = v;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
  return Array.isArray(list) ? list.filter((p): p is MailDeviceProtocol => p === 'imap' || p === 'pop3' || p === 'smtp') : [];
}

function reasonOf(v: string | null): MailDeviceRevokedReason | null {
  return v && (MAIL_DEVICE_REVOKED_REASONS as readonly string[]).includes(v) ? v as MailDeviceRevokedReason : null;
}

const iso = (v: Date | string): string => new Date(v).toISOString();
const isoOrNull = (v: Date | string | null): string | null => (v ? iso(v) : null);

/** Shown label: printable, ≤ 64 characters (never trusted, never interpreted). */
export function cleanDeviceLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // C0 / C1 controls and the Unicode line / paragraph separators become spaces.
  const printable = [...raw].map((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ? ' ' : ch;
  }).join('');
  const s = printable.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return [...s].slice(0, LABEL_MAX).join('');
}

function toApi(r: DeviceRow & { created_for_name?: string | null }): MailDevice {
  return {
    id: r.public_id,
    mailboxId: Number(r.mailbox_id),
    label: r.label,
    client: r.client,
    basis: r.basis,
    protocols: protocolsOf(r.protocols),
    createdFor: r.created_by ? { id: Number(r.created_by), name: r.created_for_name || `#${r.created_by}` } : null,
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
    lastSeenAt: isoOrNull(r.last_seen_at),
    lastSeenIp: r.last_seen_ip,
    revokedAt: isoOrNull(r.revoked_at),
    revokedReason: reasonOf(r.revoked_reason),
  };
}

async function deviceLimits(): Promise<{ max: number; manualMaxDays: number; idleDays: number }> {
  const s = await platformSettings.section('mail');
  return {
    max: Math.max(1, Math.min(MAIL_DEVICE_SLOTS, Math.floor(Number(s.maxDevicesPerMailbox) || MAIL_DEVICE_SLOTS))),
    manualMaxDays: Math.max(1, Math.floor(Number(s.manualAppPasswordMaxDays) || 1095)),
    idleDays: Math.max(1, Math.floor(Number(s.devicePasswordIdleDays) || 180)),
  };
}

const DEVICE_COLS = [
  'p.id', 'p.account_id', 'p.mailbox_id', 'p.public_id', 'p.label', 'p.client', 'p.basis', 'p.protocols', 'p.verifier_sha256', 'p.password_hash',
  'p.created_by', 'p.created_at', 'p.expires_at', 'p.revoked_at', 'p.revoked_reason', 'p.last_seen_at', 'p.last_seen_ip',
];

/**
 * Revokes the live device rows matching `where` (reason, author) and returns
 * them with their mailbox address. One UPDATE … RETURNING: never a row twice.
 */
async function revokeRows(where: (q: ReturnType<typeof db>) => void, reason: MailDeviceRevokedReason, by: number | null): Promise<Array<{ id: number; public_id: string; label: string; mailbox_id: number; account_id: number }>> {
  const at = new Date(deps.now());
  const q = db('mail_app_passwords').where('purpose', 'device').whereNull('revoked_at');
  where(q);
  return await q.update({ revoked_at: at, revoked_reason: reason, revoked_by: by, updated_at: at })
    .returning(['id', 'public_id', 'label', 'mailbox_id', 'account_id']) as Array<{ id: number; public_id: string; label: string; mailbox_id: number; account_id: number }>;
}

// ── service ──────────────────────────────────────────────────────────────────

export const devicesService = {
  /** GET /mail/mailboxes/:id/devices — mail.manage: the live device passwords of a mailbox. */
  async list(actor: HostingActor, mailboxId: number): Promise<MailDeviceList> {
    const mb = await loadMailbox(actor, mailboxId, 'mail.manage');
    const limits = await deviceLimits();
    const rows = await db('mail_app_passwords as p')
      .leftJoin('users as u', 'u.id', 'p.created_by')
      .where({ 'p.mailbox_id': mb.id, 'p.account_id': mb.account_id, 'p.purpose': 'device' })
      .whereNull('p.revoked_at')
      .where('p.expires_at', '>', new Date(deps.now()))
      .orderBy('p.id', 'desc')
      .select([...DEVICE_COLS, db.raw("COALESCE(NULLIF(u.display_name, ''), u.username) AS created_for_name")]) as Array<DeviceRow & { created_for_name: string | null }>;
    let pop3AlwaysOpen = false;
    try {
      pop3AlwaysOpen = (await activeMailDriver()).engine === 'stalwart';
    } catch { /* unknown engine: nothing to warn about */ }
    return { items: rows.map(toApi), max: limits.max, manualMaxDays: limits.manualMaxDays, pop3AlwaysOpen };
  },

  /** Live device passwords of a mailbox (password change dialog: « also disconnect the devices (n) »). */
  async liveCount(mailboxId: number): Promise<number> {
    const r = await db('mail_app_passwords').where({ mailbox_id: mailboxId, purpose: 'device' }).whereNull('revoked_at')
      .where('expires_at', '>', new Date(deps.now())).count<{ n: string | number }[]>('id as n');
    return Number(r[0]?.n ?? 0);
  },

  /**
   * POST /mail/mailboxes/:id/devices — manual app password (O4a), mail.manage
   * (base 'manage': the credential belongs to the mailbox, like its password).
   * 409 deviceLimit / mailboxDisabled / accountSuspended / mailEngineNoMailboxes,
   * 423 accountContained, 400 invalidDuration / invalidLabel. Audited
   * `mail.device.create` (never the secret).
   */
  async createManual(req: Request, actor: HostingActor, mailboxId: number, body: MailDeviceCreate): Promise<MailDeviceCreated> {
    const mb = await loadMailbox(actor, mailboxId, 'mail.manage');
    const label = cleanDeviceLabel(body?.label);
    if (!label) throw new AppError(400, 'A device name is required (64 characters at most)', 'invalidLabel');
    const limits = await deviceLimits();
    const days = Number(body?.days);
    if (!MANUAL_APP_PASSWORD_DAYS.includes(days) || days > limits.manualMaxDays) {
      throw new AppError(400, `The lifetime must be one of ${MANUAL_APP_PASSWORD_DAYS.filter((d) => d <= limits.manualMaxDays).join(', ')} days`, 'invalidDuration', { maxDays: limits.manualMaxDays });
    }
    const protocols = MAIL_DEVICE_PROTOCOL_SETS[body?.protocols as keyof typeof MAIL_DEVICE_PROTOCOL_SETS];
    if (!protocols) throw new AppError(400, 'Unknown protocol set', 'validation');
    await assertNotContained(mb.account_id);
    if (!accountServesMail(mb.account_status)) throw new AppError(409, 'This account is suspended', 'accountSuspended');
    if (!mb.enabled) throw new AppError(409, 'This mailbox is disabled', 'mailboxDisabled');
    const driver = await activeMailDriver();
    if (!driver.capabilities.mailboxes) throw new AppError(409, 'The mail engine has no mailboxes', 'mailEngineNoMailboxes');

    const password = generateMailPassword(32);
    const { hash } = hashMailPassword(password);
    const publicId = newDevicePublicId();
    const now = deps.now();
    const row = await db.transaction(async (trx) => {
      // Serializes the ceiling per mailbox (two creations at once cannot both pass it).
      await trx('mailboxes').where({ id: mb.id, account_id: mb.account_id }).forUpdate().first('id');
      const live = await trx('mail_app_passwords').where({ mailbox_id: mb.id, purpose: 'device' }).whereNull('revoked_at')
        .where('expires_at', '>', new Date(now)).count<{ n: string | number }[]>('id as n');
      if (Number(live[0]?.n ?? 0) >= limits.max) {
        throw new AppError(409, `At most ${limits.max} devices per mailbox: revoke one first`, 'deviceLimit', { max: limits.max });
      }
      // Last statement of the transaction, with the statement clock: a sync whose state is read after it sees the row (engineReady).
      const [inserted] = await trx('mail_app_passwords').insert({
        account_id: mb.account_id,
        mailbox_id: mb.id,
        purpose: 'device',
        password_hash: hash,
        created_by: actor.userId,
        expires_at: new Date(now + days * DAY_MS),
        public_id: publicId,
        label,
        client: 'manual',
        basis: 'manage',
        protocols: JSON.stringify(protocols),
        verifier_sha256: deviceVerifier(password),
        created_at: trx.raw('clock_timestamp()'),
        updated_at: trx.raw('clock_timestamp()'),
      }).returning(DEVICE_COLS.map((c) => c.slice(2))) as DeviceRow[];
      return inserted;
    });
    deps.requestSync('device password created');
    await auditService.logReqAs(req, mb.tenant_id, 'mail.device.create', {
      resourceType: 'mailbox',
      resourcePath: String(mb.id),
      details: { address: mb.address, id: publicId, label, client: 'manual', basis: 'manage', protocols: [...protocols], days },
    });
    const created = await db('users').where({ id: actor.userId }).first('display_name', 'username') as { display_name: string | null; username: string } | undefined;
    return {
      device: toApi({ ...row, created_for_name: created ? (created.display_name || created.username) : null }),
      username: mb.address,
      password,
    };
  },

  /**
   * POST /mail/mailboxes/:id/devices/revoke — mail.manage: one device password
   * (id) or all of them (all: true), reason 'manager'. 404 for an unknown or
   * already revoked id. Audited `mail.device.revoke` per credential.
   */
  async revoke(req: Request, actor: HostingActor, mailboxId: number, body: MailDeviceRevoke): Promise<{ revoked: number }> {
    const mb = await loadMailbox(actor, mailboxId, 'mail.manage');
    let rows;
    if (body?.all === true) {
      rows = await revokeRows((q) => { q.where({ mailbox_id: mb.id, account_id: mb.account_id }); }, 'manager', actor.userId);
    } else {
      const id = typeof body?.id === 'string' ? body.id.trim().toLowerCase() : '';
      if (!MAIL_DEVICE_PUBLIC_ID_RE.test(id)) throw new AppError(404, 'Device not found', 'notFound');
      rows = await revokeRows((q) => { q.where({ mailbox_id: mb.id, account_id: mb.account_id, public_id: id }); }, 'manager', actor.userId);
      if (rows.length === 0) throw new AppError(404, 'Device not found', 'notFound');
    }
    await this.afterRevocation(rows.map(() => mb.address), 'manager');
    for (const r of rows) {
      await auditService.logReqAs(req, mb.tenant_id, 'mail.device.revoke', {
        resourceType: 'mailbox', resourcePath: String(mb.id),
        details: { address: mb.address, id: r.public_id, label: r.label, reason: 'manager' },
      });
    }
    return { revoked: rows.length };
  },

  /**
   * Password change with « also disconnect the devices » (route mail.routes,
   * after mailService.setPassword): every live device password of the
   * mailbox, reason 'password'. The caller already loaded the mailbox with
   * mail.manage. Returns the count.
   */
  async revokeForPasswordChange(req: Request, mb: MailboxLoaded, userId: number | null): Promise<number> {
    const rows = await revokeRows((q) => { q.where({ mailbox_id: mb.id, account_id: mb.account_id }); }, 'password', userId);
    if (rows.length === 0) return 0;
    await this.afterRevocation(rows.map(() => mb.address), 'password');
    for (const r of rows) {
      await auditService.logReqAs(req, mb.tenant_id, 'mail.device.revoke', {
        resourceType: 'mailbox', resourcePath: String(mb.id),
        details: { address: mb.address, id: r.public_id, label: r.label, reason: 'password' },
      });
    }
    return rows.length;
  },

  /**
   * Containment of an account (containment.service): every live app password
   * of the account was revoked there (device ones with reason
   * 'containment'): engine sync, open sessions ended. Never throws.
   */
  async afterContainment(accountId: number, mailboxIds: number[]): Promise<void> {
    try {
      if (mailboxIds.length === 0) return;
      const boxes = await db('mailboxes').where({ account_id: accountId }).whereIn('id', mailboxIds).pluck('address') as string[];
      deps.revoked(boxes, 'containment');
    } catch (err) {
      logger.warn({ err: errText(err), accountId }, 'mail devices: containment follow-up failed');
    }
  },

  /** Expiry pass (webmail.service expireAppPasswords): audit `mail.device.expire`, open sessions ended. Never throws. */
  async afterExpiry(ids: number[]): Promise<void> {
    try {
      if (ids.length === 0) return;
      const rows = await db('mail_app_passwords as p')
        .join('mailboxes as m', function joinMailbox() { this.on('m.id', '=', 'p.mailbox_id').andOn('m.account_id', '=', 'p.account_id'); })
        .whereIn('p.id', ids).where('p.purpose', 'device')
        .select('p.public_id', 'p.label', 'p.mailbox_id', 'm.address', 'm.tenant_id') as Array<{ public_id: string; label: string; mailbox_id: number; address: string; tenant_id: number }>;
      deps.revoked(rows.map((r) => r.address), 'expired');
      for (const r of rows) {
        await auditService.log({
          tenantId: Number(r.tenant_id), action: 'mail.device.expire', resourceType: 'mailbox', resourcePath: String(r.mailbox_id),
          details: { address: r.address, id: r.public_id, label: r.label, reason: 'expired' },
        });
      }
    } catch (err) {
      logger.warn({ err: errText(err) }, 'mail devices: expiry follow-up failed');
    }
  },

  /** Sync + open sessions + ban allowance after a revocation (addresses of the revoked rows). Never throws. */
  async afterRevocation(addresses: string[], reason: MailDeviceRevokedReason): Promise<void> {
    try {
      deps.revoked(addresses, reason);
    } catch (err) {
      logger.warn({ err: errText(err) }, 'mail devices: post-revocation steps failed');
    }
  },

  /** Live device passwords for the desired state (desiredState drops those of a mailbox that may not log in). */
  async appPasswords(): Promise<DesiredAppPassword[]> {
    const rows = await db('mail_app_passwords as p')
      .join('mailboxes as m', function joinMailbox() { this.on('m.id', '=', 'p.mailbox_id').andOn('m.account_id', '=', 'p.account_id'); })
      .where('p.purpose', 'device')
      .whereNull('p.revoked_at')
      .where('p.expires_at', '>', new Date(deps.now()))
      .where('m.enabled', true)
      .orderBy('p.id')
      .select('p.id', 'p.mailbox_id', 'm.address', 'p.password_hash', 'p.expires_at', 'p.protocols') as
      Array<{ id: number; mailbox_id: number; address: string; password_hash: string; expires_at: Date | string; protocols: unknown }>;
    return rows.map((r) => ({
      id: Number(r.id),
      mailboxId: Number(r.mailbox_id),
      address: r.address,
      passwordHash: r.password_hash,
      expiresAt: iso(r.expires_at),
      purpose: 'device' as const,
      allowNets: null,
      protocols: protocolsOf(r.protocols),
    }));
  },

  // ── device API (C7 / C8) ──

  /**
   * `Authorization: Basic base64("omd_<id>:<secret>")` → the row when the
   * secret matches (revoked / expired rows included: their holder learns the
   * status), else null (401 invalidCredential). One row read by public id,
   * constant-time comparison of SHA-256 digests.
   */
  async authenticate(authorization: unknown): Promise<DeviceAuth | null> {
    const creds = parseBasic(authorization);
    if (!creds) return null;
    const row = await db('mail_app_passwords as p')
      .join('mailboxes as m', function joinMailbox() { this.on('m.id', '=', 'p.mailbox_id').andOn('m.account_id', '=', 'p.account_id'); })
      .join('mail_domains as md', 'md.id', 'm.mail_domain_id')
      .join('hosting_accounts as a', 'a.id', 'm.account_id')
      .where({ 'p.public_id': creds.id, 'p.purpose': 'device' })
      .first([...DEVICE_COLS, 'm.address', 'm.enabled as mailbox_enabled', 'm.tenant_id', 'md.name as domain_name', 'md.enabled as domain_enabled', 'a.status as account_status']) as DeviceAuth | undefined;
    // Same work whether the id exists or not (no oracle on the public id through timing).
    const expected = row?.verifier_sha256 ?? '0'.repeat(64);
    const ok = sameDigest(deviceVerifier(creds.secret), expected);
    return row && ok ? row : null;
  },

  /** Status of an authenticated device row (pure but for the clock and engineReady). */
  statusOf(row: DeviceAuth): MailDeviceStatus {
    if (row.revoked_at) return row.revoked_reason === 'expired' ? 'expired' : 'revoked';
    if (new Date(row.expires_at).getTime() <= deps.now()) return 'expired';
    if (!row.mailbox_enabled || !row.domain_enabled || !accountServesMail(row.account_status)) return 'suspended';
    return 'active';
  },

  /**
   * GET /api/v1/mail/device/self. Active credential: check-in at most once
   * per 24 h (last_seen_at / last_seen_ip; a MailForge credential is pushed
   * back to now + mail.devicePasswordIdleDays). Never 401 for a revoked one.
   */
  async self(row: DeviceAuth, ip: string | null): Promise<MailDeviceSelf> {
    const status = this.statusOf(row);
    let expiresAt = iso(row.expires_at);
    if (status === 'active') {
      const now = deps.now();
      const last = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
      if (now - last >= CHECKIN_INTERVAL_MS) {
        const patch: Record<string, unknown> = { last_seen_at: new Date(now), last_seen_ip: ip ? ip.slice(0, 45) : null, updated_at: new Date(now) };
        if (row.client === 'mailforge') {
          const { idleDays } = await deviceLimits();
          const next = new Date(now + idleDays * DAY_MS);
          if (next.getTime() > new Date(row.expires_at).getTime()) {
            patch.expires_at = next;
            expiresAt = next.toISOString();
          }
        }
        // Still live at write time (a revocation in between wins).
        await db('mail_app_passwords').where({ id: row.id }).whereNull('revoked_at').update(patch);
        if (patch.expires_at) deps.requestSync('device password checked in');
      }
    }
    let servers = null;
    if (status === 'active') {
      try {
        const [driver, host] = await Promise.all([activeMailDriver(), mailHostname()]);
        servers = host ? buildMailClientServers(driver.engine, host) : null;
      } catch { /* engine unknown right now: the client keeps its own */ }
    }
    return {
      id: row.public_id,
      mailboxId: Number(row.mailbox_id),
      address: row.address,
      label: row.label,
      status,
      revokedReason: status === 'revoked' || status === 'expired' ? (reasonOf(row.revoked_reason) ?? (status === 'expired' ? 'expired' : null)) : null,
      engineReady: status === 'active' && deps.appliedSince(row.domain_name, new Date(row.created_at)),
      expiresAt,
      protocols: protocolsOf(row.protocols),
      servers,
    };
  },

  /** DELETE /api/v1/mail/device/self: the device forgets its account (reason 'device'). Idempotent. Audited. */
  async selfRevoke(row: DeviceAuth, ip: string | null): Promise<void> {
    const rows = await revokeRows((q) => { q.where({ id: row.id }); }, 'device', null);
    if (rows.length === 0) return;
    await this.afterRevocation([row.address], 'device');
    await auditService.log({
      tenantId: Number(row.tenant_id), action: 'mail.device.revoke', resourceType: 'mailbox', resourcePath: String(row.mailbox_id),
      details: { address: row.address, id: row.public_id, label: row.label, reason: 'device' }, ipAddress: ip ?? undefined,
    });
  },
};

export type DeviceAuth = DeviceRow & {
  address: string;
  mailbox_enabled: boolean;
  tenant_id: number;
  domain_name: string;
  domain_enabled: boolean;
  account_status: string;
};

/** Basic credentials of the device API: public id + secret, both bounded; null when malformed. */
export function parseBasic(header: unknown): { id: string; secret: string } | null {
  if (typeof header !== 'string' || header.length > 512) return null;
  const m = /^Basic\s+([A-Za-z0-9+/=_-]{8,400})$/i.exec(header.trim());
  if (!m) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const i = decoded.indexOf(':');
  if (i <= 0) return null;
  const id = decoded.slice(0, i).trim().toLowerCase();
  const secret = decoded.slice(i + 1);
  if (!MAIL_DEVICE_PUBLIC_ID_RE.test(id) || secret.length === 0 || secret.length > 256) return null;
  return { id, secret };
}
