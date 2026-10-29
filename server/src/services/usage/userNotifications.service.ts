import type { Request } from 'express';
import type {
  NotificationEvent, NotificationFamily, UserNotification, UserNotificationPage, UserNotificationPrefs, UserNotificationPrefsInput,
  UserNotificationSettings, UserNotificationSeverity,
} from '@oblimint/shared';
import {
  CLIENT_NOTIFICATION_FAMILIES, DEFAULT_USER_NOTIFICATION_PREFS, MASTER_TENANT_ID, NOTIFICATION_EVENT_FAMILY, NOTIFICATION_FAMILIES,
  USER_NOTIFICATION_DEDUP_HOURS, USER_NOTIFICATION_MAX_PER_USER, USER_NOTIFICATION_PAGE_MAX, USER_NOTIFICATION_RETENTION_DAYS,
  UserNotificationSocketEvents,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { getIO } from '../../socket';
import { logger } from '../../utils/logger';
import { actorCan, actorForUser, type HostingActor, type HostingNeed } from '../hosting/access';
import { clientCapabilities } from '../hosting/rows';
import { purgeTransactionalLog, sendTransactional, transactionalMailReady } from '../mail/transactional';
import { htmlBody, plainText, type RenderedNotification } from './notifications/plugins';

// ─────────────────────────────────────────────────────────────────────────────
// Per-user notification center (the bell). Fed by notify() (the queue of
// notifications.service.ts calls deliverToUsers for every job): the
// recipients are computed HERE, on the server, like loadAccount does for a
// request — never from the payload alone:
//
//   - client users (kind 'client') of the payload's account, in the payload's
//     tenant, whose account capabilities grant the family's need;
//   - staff members of the payload's tenant (user_tenants) whose capabilities
//     grant the staff need (actorForUser + actorCan: the same code as the API);
//   - platform admins for master-tenant and `platform` events (row stored in
//     the master tenant: their god view).
//
// A notification therefore never reaches another tenant or another account
// (tests: userNotifications.db.test.ts, non-leak). Each recipient's
// preferences (per family: in-app, e-mail) decide; a same (event, key) is
// kept once per user for 24 h; 90 days and 500 rows per user and tenant.
// Live push on the socket room user:<id> (the client filters on its tenant).
// ─────────────────────────────────────────────────────────────────────────────

interface Audience {
  /** Staff need (null: platform admins only). */
  staff: HostingNeed | null;
  /** Client need on the payload's account (null: never a client). */
  client: HostingNeed | null;
}

const FAMILY_AUDIENCE: Record<NotificationFamily, Audience> = {
  releases: { staff: 'releases.publish', client: 'releases.publish' },
  certificates: { staff: 'domains.manage', client: 'read' },
  domains: { staff: 'domains.manage', client: 'read' },
  quota: { staff: 'accounts.manage', client: 'read' },
  mail: { staff: 'mail.manage', client: 'mail.manage' },
  apps: { staff: 'apps.manage', client: 'apps.manage' },
  monitoring: { staff: 'monitoring.manage', client: 'monitoring.manage' },
  security: { staff: 'proxy.manage', client: null },
  platform: { staff: null, client: null },
};

const EVENT_AUDIENCE: Partial<Record<NotificationEvent, Audience>> = {
  // A decision is asked: whoever can take it.
  'release.pendingApproval': { staff: 'releases.approve', client: 'releases.approve' },
  'window.pendingReview': { staff: 'releases.approve', client: 'releases.approve' },
  'db.instanceFailed': { staff: 'databases.manage', client: 'databases.manage' },
  'cron.failed': { staff: 'sites.manage', client: 'sites.manage' },
  'mail.quotaWarning': { staff: 'mail.manage', client: 'read' },
  'mail.outboundSuspended': { staff: 'mail.manage', client: 'read' },
};

export function audienceOf(event: NotificationEvent): Audience {
  return EVENT_AUDIENCE[event] ?? FAMILY_AUDIENCE[NOTIFICATION_EVENT_FAMILY[event]];
}

/** Recipients cap of one event (a tenant with hundreds of staff members: the first ones by id). */
const MAX_RECIPIENTS = 500;
const MAX_EMAILS_PER_EVENT = 50;

export interface NotificationTarget {
  tenantId: number;
  accountId?: number | null;
  platform?: boolean;
}

export interface Recipient {
  userId: number;
  /** Tenant the row is stored in (the master tenant for the platform admins' copy). */
  tenantId: number;
  kind: 'staff' | 'client';
}

/**
 * Who receives `event` about `target`. Computed from the database only
 * (memberships, capabilities), never from what the emitter claims beyond the
 * tenant / account ids.
 */
export async function recipientsFor(event: NotificationEvent, target: NotificationTarget): Promise<Recipient[]> {
  const aud = audienceOf(event);
  const tenantId = target.tenantId;
  const accountId = Number.isInteger(target.accountId) && Number(target.accountId) > 0 ? Number(target.accountId) : null;
  const out = new Map<number, Recipient>();
  const add = (r: Recipient) => { if (!out.has(r.userId) && out.size < MAX_RECIPIENTS) out.set(r.userId, r); };

  // 1. Client users of the account (the account must belong to the tenant).
  if (accountId && aud.client) {
    const rows = await db('account_users as au')
      .join('hosting_accounts as a', 'a.id', 'au.account_id')
      .join('users as u', 'u.id', 'au.user_id')
      .where({ 'au.account_id': accountId, 'a.tenant_id': tenantId, 'u.kind': 'client', 'u.is_active': true })
      .orderBy('u.id')
      .limit(MAX_RECIPIENTS)
      .select('u.id', 'au.capabilities') as Array<{ id: number; capabilities: unknown }>;
    for (const r of rows) {
      const actor: HostingActor = { kind: 'client', userId: Number(r.id), tenantId, accounts: new Map([[accountId, new Set(clientCapabilities(r.capabilities))]]) };
      if (actorCan(actor, aud.client, { tenantId, accountId })) add({ userId: Number(r.id), tenantId, kind: 'client' });
    }
  }

  // 2. Staff members of the tenant holding the staff need.
  if (aud.staff) {
    const rows = await db('user_tenants as ut')
      .join('users as u', 'u.id', 'ut.user_id')
      .where({ 'ut.tenant_id': tenantId, 'u.kind': 'staff', 'u.is_active': true })
      .orderBy('u.id')
      .limit(MAX_RECIPIENTS)
      .select('u.id') as Array<{ id: number }>;
    for (const r of rows) {
      try {
        const actor = await actorForUser(Number(r.id), tenantId);
        if (actor.kind === 'staff' && actorCan(actor, aud.staff, { tenantId, accountId })) add({ userId: Number(r.id), tenantId, kind: 'staff' });
      } catch {
        // inactive / vanished meanwhile: skipped
      }
    }
  }

  // 3. Platform admins: master-tenant events, platform-wide events, and families for admins only.
  if (tenantId === MASTER_TENANT_ID || target.platform === true || aud.staff === null) {
    const admins = await db('users').where({ role: 'admin', kind: 'staff', is_active: true }).orderBy('id').limit(MAX_RECIPIENTS).select('id') as Array<{ id: number }>;
    for (const a of admins) add({ userId: Number(a.id), tenantId: MASTER_TENANT_ID, kind: 'staff' });
  }
  return [...out.values()];
}

// ── preferences ──────────────────────────────────────────────────────────────

/** Stored JSON → full prefs (unknown families / values ignored, defaults filled). */
export function normalizePrefs(raw: unknown): UserNotificationPrefs {
  const out = JSON.parse(JSON.stringify(DEFAULT_USER_NOTIFICATION_PREFS)) as UserNotificationPrefs;
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { obj = null; }
  }
  if (!obj || typeof obj !== 'object') return out;
  for (const f of NOTIFICATION_FAMILIES) {
    const v = (obj as Record<string, unknown>)[f];
    if (!v || typeof v !== 'object') continue;
    const p = v as Record<string, unknown>;
    if (typeof p.inApp === 'boolean') out[f].inApp = p.inApp;
    if (typeof p.email === 'boolean') out[f].email = p.email;
  }
  return out;
}

async function prefsOf(userIds: number[]): Promise<Map<number, UserNotificationPrefs>> {
  const map = new Map<number, UserNotificationPrefs>();
  if (userIds.length === 0) return map;
  const rows = await db('user_notification_prefs').whereIn('user_id', userIds).select('user_id', 'prefs') as Array<{ user_id: number; prefs: unknown }>;
  for (const r of rows) map.set(Number(r.user_id), normalizePrefs(r.prefs));
  return map;
}

// ── delivery ─────────────────────────────────────────────────────────────────

interface Row {
  id: number | string;
  user_id: number;
  tenant_id: number;
  account_id: number | null;
  event: string;
  family: string;
  severity: UserNotificationSeverity;
  title: string;
  message: string;
  link: string | null;
  read_at: Date | string | null;
  created_at: Date | string;
}

function toNotification(r: Row): UserNotification {
  return {
    id: Number(r.id),
    tenantId: r.tenant_id,
    accountId: r.account_id ?? null,
    event: r.event as NotificationEvent,
    family: r.family as NotificationFamily,
    severity: r.severity,
    title: r.title,
    message: r.message,
    link: r.link,
    readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/** Same rule as the channels: an in-panel path only (never //host or a scheme). */
export function safeLink(link: unknown): string | null {
  if (typeof link !== 'string' || !link.startsWith('/') || link.startsWith('//') || link.includes('\\')) return null;
  return link.slice(0, 500);
}

export interface DeliverPayload {
  tenantId: number;
  accountId?: number | null;
  key: string;
  title: string;
  message: string;
  severity: UserNotificationSeverity;
  platform?: boolean;
  link?: string | null;
}

function emitToUser(userId: number, event: string, payload: Record<string, unknown>): void {
  try {
    getIO()?.to(`user:${userId}`).emit(event, payload);
  } catch (err) {
    logger.debug({ err, userId }, 'user notification socket emit failed');
  }
}

/**
 * CROSS-MODULE (called by the notify() queue): writes the notification for
 * every recipient whose preferences want it, pushes it live and sends the
 * e-mails. Never throws.
 */
export async function deliverToUsers(event: NotificationEvent, p: DeliverPayload, rendered?: RenderedNotification | null): Promise<number> {
  try {
    const family = NOTIFICATION_EVENT_FAMILY[event];
    if (!family) return 0;
    const recipients = await recipientsFor(event, { tenantId: p.tenantId, accountId: p.accountId ?? null, platform: p.platform });
    if (recipients.length === 0) return 0;
    const dedupKey = String(p.key ?? '').slice(0, 200);
    const since = new Date(Date.now() - USER_NOTIFICATION_DEDUP_HOURS * 3600_000);
    const already = new Set((await db('user_notifications')
      .where({ event, dedup_key: dedupKey })
      .where('created_at', '>=', since)
      .whereIn('user_id', recipients.map((r) => r.userId))
      .select('user_id', 'tenant_id') as Array<{ user_id: number; tenant_id: number }>).map((r) => `${r.user_id}:${r.tenant_id}`));
    const prefs = await prefsOf(recipients.map((r) => r.userId));
    const emailOn = await transactionalMailReady();
    const title = String(p.title ?? '').slice(0, 200) || event;
    const message = String(p.message ?? '').slice(0, 4000);
    const severity: UserNotificationSeverity = p.severity === 'critical' || p.severity === 'warning' ? p.severity : 'info';
    const link = safeLink(p.link);
    const accountId = Number.isInteger(p.accountId) ? Number(p.accountId) : null;

    const inserts: Array<Record<string, unknown>> = [];
    const wantsEmail = new Set<number>();
    for (const r of recipients) {
      if (already.has(`${r.userId}:${r.tenantId}`)) continue;
      if (r.kind === 'client' && !CLIENT_NOTIFICATION_FAMILIES.includes(family)) continue;
      const pref = (prefs.get(r.userId) ?? DEFAULT_USER_NOTIFICATION_PREFS)[family];
      const email = emailOn && pref.email;
      if (!pref.inApp && !email) continue;
      if (email) wantsEmail.add(r.userId);
      inserts.push({
        user_id: r.userId, tenant_id: r.tenantId, account_id: accountId, event, family, severity, title, message, link,
        dedup_key: dedupKey, in_app: pref.inApp,
      });
    }
    if (inserts.length === 0) return 0;
    const rows = await db('user_notifications').insert(inserts).returning('*') as Array<Row & { in_app: boolean }>;
    for (const row of rows) {
      if (!row.in_app) continue;
      emitToUser(row.user_id, UserNotificationSocketEvents.NEW, { tenantId: row.tenant_id, notification: toNotification(row) });
    }
    if (wantsEmail.size > 0) await sendEmails(rows.filter((r) => wantsEmail.has(r.user_id)), event, p, rendered ?? null);
    return rows.length;
  } catch (err) {
    logger.warn({ err: (err as Error).message, event }, 'user notifications: delivery failed');
    return 0;
  }
}

async function sendEmails(rows: Row[], event: NotificationEvent, p: DeliverPayload, rendered: RenderedNotification | null): Promise<void> {
  const list = rows.slice(0, MAX_EMAILS_PER_EVENT);
  const users = await db('users').whereIn('id', list.map((r) => r.user_id)).whereNotNull('email').where({ is_active: true })
    .select('id', 'email') as Array<{ id: number; email: string }>;
  const emails = new Map(users.map((u) => [Number(u.id), u.email]));
  const n: RenderedNotification = rendered ?? {
    event, eventLabel: event, title: p.title, message: p.message, severity: p.severity, url: null,
    tenantId: p.tenantId, accountId: p.accountId ?? null, key: p.key, timestamp: new Date().toISOString(),
  };
  for (const row of list) {
    const to = emails.get(row.user_id);
    if (!to) continue;
    const r = await sendTransactional({ to, kind: 'notification', userId: row.user_id, subject: `[Oblimint] ${n.title}`, text: plainText(n), html: htmlBody(n) });
    if (r.ok) {
      try { await db('user_notifications').where({ id: row.id, user_id: row.user_id }).update({ emailed_at: db.fn.now() }); } catch { /* journal only */ }
    }
  }
}

// ── retention ────────────────────────────────────────────────────────────────

/** 90 days, then the oldest beyond 500 per (user, tenant); plus the transactional mail journal. */
export async function purgeUserNotifications(now = Date.now()): Promise<{ expired: number; overflow: number; mailLog: number }> {
  const cutoff = new Date(now - USER_NOTIFICATION_RETENTION_DAYS * 86_400_000);
  const expired = Number(await db('user_notifications').where('created_at', '<', cutoff).delete()) || 0;
  const res = await db.raw(`
    DELETE FROM user_notifications WHERE id IN (
      SELECT id FROM (
        SELECT id, row_number() OVER (PARTITION BY user_id, tenant_id ORDER BY id DESC) AS rn FROM user_notifications
      ) ranked WHERE rn > ?
    )`, [USER_NOTIFICATION_MAX_PER_USER]) as { rowCount?: number };
  const overflow = Number(res?.rowCount) || 0;
  let mailLog = 0;
  try { mailLog = await purgeTransactionalLog(now); } catch { /* next pass */ }
  return { expired, overflow, mailLog };
}

const worker: { timer: NodeJS.Timeout | null; first: NodeJS.Timeout | null } = { timer: null, first: null };

export const userNotificationsWorker = {
  start(): void {
    if (worker.timer) return;
    const pass = () => { purgeUserNotifications().catch((err) => logger.warn({ err: (err as Error).message }, 'user notifications purge failed')); };
    worker.first = setTimeout(pass, 60_000);
    worker.first.unref?.();
    worker.timer = setInterval(pass, 3600_000);
    worker.timer.unref?.();
  },
  stop(): void {
    if (worker.first) clearTimeout(worker.first);
    if (worker.timer) clearInterval(worker.timer);
    worker.first = null;
    worker.timer = null;
  },
};

// ── API (the signed-in user, current tenant) ─────────────────────────────────

export interface InboxQuery {
  unread?: boolean;
  family?: NotificationFamily | null;
  /** Items older than this id. */
  before?: number | null;
  limit?: number;
  /** API keys: only the notifications about this account. */
  accountId?: number | null;
}

function scope(userId: number, tenantId: number) {
  if (!Number.isInteger(userId) || userId <= 0) throw new AppError(401, 'Authentication required');
  if (!Number.isInteger(tenantId) || tenantId <= 0) throw new AppError(400, 'No tenant selected');
  return db('user_notifications').where({ user_id: userId, tenant_id: tenantId, in_app: true });
}

async function unreadCount(userId: number, tenantId: number, accountId?: number | null): Promise<number> {
  const q = scope(userId, tenantId).whereNull('read_at');
  if (accountId) q.where('account_id', accountId);
  const row = await q.count<{ n: string }[]>({ n: '*' }).first();
  return Number(row?.n ?? 0);
}

export function parseIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) throw new AppError(400, 'ids must be an array of notification ids', 'validation');
  const ids = [...new Set(raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0 || ids.length > 500) throw new AppError(400, 'ids must hold 1 to 500 notification ids', 'validation');
  return ids;
}

export const userNotificationService = {
  async list(userId: number, tenantId: number, q: InboxQuery = {}): Promise<UserNotificationPage> {
    const limit = Math.min(Math.max(Number.isInteger(q.limit) ? Number(q.limit) : 30, 1), USER_NOTIFICATION_PAGE_MAX);
    const query = scope(userId, tenantId);
    if (q.unread) query.whereNull('read_at');
    if (q.family && NOTIFICATION_FAMILIES.includes(q.family)) query.where('family', q.family);
    if (q.before && Number.isInteger(q.before) && q.before > 0) query.where('id', '<', q.before);
    if (q.accountId) query.where('account_id', q.accountId);
    const rows = await query.orderBy('id', 'desc').limit(limit + 1) as Row[];
    return {
      items: rows.slice(0, limit).map(toNotification),
      unreadCount: await unreadCount(userId, tenantId, q.accountId ?? null),
      hasMore: rows.length > limit,
    };
  },

  unreadCount,

  async markRead(userId: number, tenantId: number, ids: number[]): Promise<{ updated: number; unreadCount: number }> {
    const updated = Number(await scope(userId, tenantId).whereIn('id', ids).whereNull('read_at').update({ read_at: db.fn.now() })) || 0;
    if (updated) emitToUser(userId, UserNotificationSocketEvents.READ, { tenantId, ids });
    return { updated, unreadCount: await unreadCount(userId, tenantId) };
  },

  async markUnread(userId: number, tenantId: number, ids: number[]): Promise<{ updated: number; unreadCount: number }> {
    const updated = Number(await scope(userId, tenantId).whereIn('id', ids).whereNotNull('read_at').update({ read_at: null })) || 0;
    if (updated) emitToUser(userId, UserNotificationSocketEvents.READ, { tenantId, ids: null });
    return { updated, unreadCount: await unreadCount(userId, tenantId) };
  },

  async markAllRead(userId: number, tenantId: number): Promise<{ updated: number; unreadCount: number }> {
    const updated = Number(await scope(userId, tenantId).whereNull('read_at').update({ read_at: db.fn.now() })) || 0;
    if (updated) emitToUser(userId, UserNotificationSocketEvents.READ, { tenantId, ids: 'all' });
    return { updated, unreadCount: 0 };
  },

  /** Dismiss (delete) some of the user's notifications. */
  async remove(userId: number, tenantId: number, ids: number[]): Promise<{ deleted: number; unreadCount: number }> {
    const deleted = Number(await scope(userId, tenantId).whereIn('id', ids).delete()) || 0;
    if (deleted) emitToUser(userId, UserNotificationSocketEvents.READ, { tenantId, ids, deleted: true });
    return { deleted, unreadCount: await unreadCount(userId, tenantId) };
  },

  async settings(userId: number): Promise<UserNotificationSettings> {
    const user = await db('users').where({ id: userId }).first('kind', 'email') as { kind: string; email: string | null } | undefined;
    if (!user) throw new AppError(401, 'Authentication required');
    const prefs = (await prefsOf([userId])).get(userId) ?? normalizePrefs(null);
    return {
      prefs,
      families: [...(user.kind === 'client' ? CLIENT_NOTIFICATION_FAMILIES : NOTIFICATION_FAMILIES)],
      emailAddress: user.email || null,
      emailAvailable: await transactionalMailReady(),
    };
  },

  async updatePrefs(_req: Request, userId: number, input: UserNotificationPrefsInput): Promise<UserNotificationSettings> {
    const raw = input?.prefs;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(400, 'prefs must be an object', 'validation');
    for (const [k, v] of Object.entries(raw)) {
      if (!NOTIFICATION_FAMILIES.includes(k as NotificationFamily)) throw new AppError(400, `Unknown notification family: ${k}`, 'validation', { field: `prefs.${k}` });
      if (!v || typeof v !== 'object') throw new AppError(400, `Invalid preference for ${k}`, 'validation', { field: `prefs.${k}` });
      for (const [ck, cv] of Object.entries(v)) {
        if ((ck !== 'inApp' && ck !== 'email') || typeof cv !== 'boolean') throw new AppError(400, `Invalid preference ${k}.${ck}`, 'validation', { field: `prefs.${k}.${ck}` });
      }
    }
    const current = (await prefsOf([userId])).get(userId) ?? normalizePrefs(null);
    for (const [k, v] of Object.entries(raw) as Array<[NotificationFamily, Partial<{ inApp: boolean; email: boolean }>]>) {
      current[k] = { ...current[k], ...v };
    }
    await db('user_notification_prefs').insert({ user_id: userId, prefs: JSON.stringify(current), updated_at: db.fn.now() })
      .onConflict('user_id').merge(['prefs', 'updated_at']);
    return this.settings(userId);
  },
};
