import type { Request } from 'express';
import { z } from 'zod';
import type {
  NotificationChannel, NotificationChannelConfig, NotificationChannelInput, NotificationChannelType, NotificationEvent, NotificationTestResult,
} from '@oblimint/shared';
import { MASTER_TENANT_ID, NOTIFICATION_EVENTS } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { SecretBoxError, openJson, sealJson } from '../../utils/secretBox';
import { auditService } from '../audit.service';
import type { HostingActor } from '../hosting/access';
import { iso, json } from '../hosting/rows';
import { DeliveryError } from './notifications/http';
import {
  EVENT_LABELS_FR, defaultPluginDeps, sendToChannel, type ChannelSecrets, type PluginDeps, type RenderedNotification,
} from './notifications/plugins';
import { SsrfError, resolveSmtpHost } from './notifications/ssrf';

// ─────────────────────────────────────────────────────────────────────────────
// Notification channels (module usage, docs/P2-PLAN.md §6.5 / §9.5). Plugins
// ported from Obliance: smtp (nodemailer), webhook, discord, telegram.
//
// `notify()` is the CROSS-MODULE contract: every P2 module calls it for its
// events. It never throws and never blocks: the notification is deduplicated
// per (event, tenant, key) for 1 h, queued, rendered once and delivered to
// the enabled channels of the tenant subscribed to the event, plus the
// channels of the master tenant (1) for platform-wide events (tenantId 1 or
// `platform: true`); 3 attempts with backoff per channel; last_sent_at /
// last_error recorded on the channel.
//
// Channels are managed by staff of the tenant holding the 'settings'
// capability, or the platform admin; every query filters id AND tenant_id
// (god view: id only). Secrets (SMTP password, webhook header value, Discord
// webhook URL, Telegram bot token) are sealed (secretBox 'notification'),
// write-only: returned masked (null + secretsSet), kept when the client sends
// null / omits them, cleared with ''. Invariant N1: no SSRF (ssrf.ts).
// ─────────────────────────────────────────────────────────────────────────────

export interface NotificationPayload {
  tenantId: number;
  accountId?: number | null;
  /** Deduplication key (e.g. 'quota:disk:acct:12:100'). */
  key: string;
  /** French, short (subject / title). */
  title: string;
  /** French, plain text (may contain line breaks). */
  message: string;
  severity: 'info' | 'warning' | 'critical';
  /** Also deliver to the master tenant channels. */
  platform?: boolean;
  /** Panel path to open (e.g. /accounts/12?tab=usage). */
  link?: string | null;
}

interface ChannelRow {
  id: number;
  tenant_id: number;
  name: string;
  type: NotificationChannelType;
  config: unknown;
  secrets: string | null;
  events: unknown;
  enabled: boolean;
  last_sent_at: Date | string | null;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/** The one secret field of each channel type. */
const SECRET_FIELD: Record<NotificationChannelType, keyof ChannelSecrets> = {
  smtp: 'password',
  webhook: 'headerValue',
  discord: 'webhookUrl',
  telegram: 'botToken',
};

export const DEDUP_WINDOW_MS = 60 * 60 * 1000;
const MAX_QUEUE = 1000;
const CONCURRENCY = 8;
/**
 * Jobs of one tenant delivered at the same time. Each attempt has a hard
 * deadline (plugins), but a tenant whose endpoints are slow / trickling still
 * holds its jobs for up to 3 deadlines + the retry sleeps: capped per tenant,
 * it can never occupy every slot (other tenants' and platform alerts go on).
 */
const PER_TENANT_CONCURRENCY = 2;
const MAX_ERROR_LEN = 500;

// ── Validation ───────────────────────────────────────────────────────────────

function invalid(message: string, field?: string): AppError {
  return new AppError(400, message, 'channelInvalid', field ? { field } : undefined);
}

function forbidden(message: string): AppError {
  return new AppError(400, message, 'webhookForbidden');
}

const host = z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.:[\]-]+$/, 'a host name or an IP address');
const email = z.string().trim().min(3).max(254).regex(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/, 'an e-mail address');
/** "Name <a@b.c>" or "a@b.c" (no CR / LF: header injection). */
const fromAddr = z.string().trim().min(3).max(254).regex(/^[^\r\n]*<?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/, 'an e-mail address');
/** Secret input: undefined / null = keep, '' = clear, else the new value. */
const secret = (max: number) => z.string().max(max).regex(/^[^\r\n]*$/, 'no line breaks').nullable().optional();
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'user-agent', 'cookie', 'te', 'upgrade', 'expect', 'keep-alive', 'proxy-authorization']);

const configSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('smtp'),
    host,
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    username: z.string().trim().max(200).regex(/^[^\r\n]*$/).nullable().optional().transform((v) => v || null),
    password: secret(500),
    from: fromAddr,
    to: z.array(email).min(1).max(10),
  }).strict(),
  z.object({
    type: z.literal('webhook'),
    url: z.string().trim().min(9).max(2000),
    method: z.enum(['POST', 'PUT']).default('POST'),
    headerName: z.string().trim().max(64).regex(/^[A-Za-z0-9-]*$/, 'a header name').nullable().optional().transform((v) => v || null),
    headerValue: secret(1000),
  }).strict(),
  z.object({
    type: z.literal('discord'),
    webhookUrl: secret(500),
  }).strict(),
  z.object({
    type: z.literal('telegram'),
    botToken: secret(200),
    chatId: z.string().trim().regex(/^(-?\d{1,20}|@[A-Za-z0-9_]{5,64})$/, 'a chat id or @channel'),
  }).strict(),
]);

const eventsSchema = z.array(z.enum(NOTIFICATION_EVENTS as unknown as [NotificationEvent, ...NotificationEvent[]])).max(NOTIFICATION_EVENTS.length)
  .transform((v) => [...new Set(v)]);

const inputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  config: configSchema,
  events: eventsSchema,
  enabled: z.boolean().optional(),
}).strict();

type ParsedConfig = z.infer<typeof configSchema>;

function parse<S extends z.ZodTypeAny>(schema: S, v: unknown): z.infer<S> {
  const r = schema.safeParse(v);
  if (!r.success) {
    const first = r.error.errors[0];
    const field = first?.path.join('.') || undefined;
    throw invalid(`Invalid channel — ${r.error.errors.map((e) => `${e.path.join('.') || '<root>'}: ${e.message}`).join('; ')}`, field);
  }
  return r.data;
}

const DISCORD_HOST_RE = /^(?:(?:ptb|canary)\.)?discord(?:app)?\.com$/i;

// ── Test seam / dependencies ─────────────────────────────────────────────────

let deps: PluginDeps = defaultPluginDeps;
let retryDelaysMs: number[] = [2_000, 10_000];

/** Tests: replace the plugin dependencies (resolver, SMTP transport, Telegram base) and the retry delays. null restores. */
export function setNotificationDepsForTests(override: (Partial<PluginDeps> & { retryDelaysMs?: number[] }) | null): void {
  deps = override ? { ...defaultPluginDeps, ...override } : defaultPluginDeps;
  retryDelaysMs = override?.retryDelaysMs ?? [2_000, 10_000];
  dedup.clear();
}

// ── Access ───────────────────────────────────────────────────────────────────

function assertChannelAdmin(actor: HostingActor): asserts actor is Extract<HostingActor, { kind: 'staff' }> {
  if (actor.kind !== 'staff') throw new AppError(403, 'Insufficient permissions');
  if (actor.caps !== '*' && !actor.caps.has('settings')) throw new AppError(403, 'Insufficient permissions');
}

const isPlatformAdmin = (actor: HostingActor) => actor.kind === 'staff' && actor.caps === '*' && actor.globalView;

/** One channel the actor may manage: id AND tenant_id (god view: id only). 404 otherwise. */
async function loadChannel(actor: Extract<HostingActor, { kind: 'staff' }>, id: number): Promise<ChannelRow> {
  if (!Number.isInteger(id) || id <= 0) throw new AppError(404, 'Channel not found', 'notFound');
  const q = db('notification_channels').where({ id });
  if (!actor.globalView) q.andWhere({ tenant_id: actor.tenantId });
  const row = await q.first() as ChannelRow | undefined;
  if (!row) throw new AppError(404, 'Channel not found', 'notFound');
  return row;
}

// ── Mapping / secrets ────────────────────────────────────────────────────────

function openSecrets(row: Pick<ChannelRow, 'secrets'>): ChannelSecrets {
  if (!row.secrets) return {};
  return openJson<ChannelSecrets>('notification', row.secrets);
}

/** Stored secret names without opening them (a rotated SESSION_SECRET still lists them). */
function storedSecretNames(row: Pick<ChannelRow, 'type' | 'config'>): string[] {
  const cfg = json<Record<string, unknown>>(row.config, {});
  return Array.isArray(cfg.__secretsSet) ? (cfg.__secretsSet as unknown[]).filter((s): s is string => typeof s === 'string') : [];
}

export function toChannel(row: ChannelRow): NotificationChannel {
  const stored = json<Record<string, unknown>>(row.config, {});
  const { __secretsSet: _ignored, ...publicCfg } = stored;
  const field = SECRET_FIELD[row.type];
  const config = { ...publicCfg, type: row.type, [field]: null } as unknown as NotificationChannelConfig;
  const events = json<unknown[]>(row.events, []).filter((e): e is NotificationEvent => (NOTIFICATION_EVENTS as readonly unknown[]).includes(e));
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    type: row.type,
    config,
    secretsSet: storedSecretNames(row),
    events,
    enabled: !!row.enabled,
    lastSentAt: iso(row.last_sent_at),
    lastError: row.last_error,
    createdAt: iso(row.created_at) ?? '',
    updatedAt: iso(row.updated_at) ?? '',
  };
}

/**
 * Destination of a channel whose secret is not the destination itself (SMTP
 * host / port, webhook URL): a stored secret only goes where it was given (L8).
 */
function destinationChanged(cfg: ParsedConfig, previous: Record<string, unknown>): boolean {
  if (cfg.type === 'smtp') return String(previous.host ?? '').toLowerCase() !== cfg.host.toLowerCase() || Number(previous.port) !== cfg.port;
  if (cfg.type === 'webhook') return String(previous.url ?? '') !== cfg.url;
  return false;
}

/**
 * Splits a validated config into its stored (non-secret) part and its
 * secrets, merging the secret with the stored one (same type only). A kept
 * secret with a new destination (SMTP host / port, webhook URL) is refused:
 * the secret is given again with it, or cleared ('').
 */
async function prepareConfig(
  cfg: ParsedConfig,
  previous: { type: NotificationChannelType; secrets: ChannelSecrets; config: Record<string, unknown> } | null,
  policy: { allowPrivate: boolean; allowLoopback: boolean },
): Promise<{ config: Record<string, unknown>; secrets: ChannelSecrets }> {
  const field = SECRET_FIELD[cfg.type];
  const { [field]: secretInput, ...rest } = cfg as Record<string, unknown>;
  let value: string | null = previous && previous.type === cfg.type ? (previous.secrets[field] ?? null) : null;
  const kept = value !== null && typeof secretInput !== 'string';
  if (typeof secretInput === 'string') value = secretInput.trim() === '' ? null : secretInput.trim();

  switch (cfg.type) {
    case 'smtp': {
      try {
        await resolveSmtpHost(cfg.host, { ...policy, lookup: deps.lookup });
      } catch (err) {
        throw forbidden(`SMTP host refused: ${(err as Error).message}`);
      }
      break;
    }
    case 'webhook': {
      await assertPublicUrl(cfg.url);
      if (cfg.headerName && FORBIDDEN_HEADERS.has(cfg.headerName.toLowerCase())) throw invalid(`Header ${cfg.headerName} cannot be set`, 'config.headerName');
      if (cfg.headerName && !value) throw invalid('A header value is required with a header name', 'config.headerValue');
      if (!cfg.headerName) value = null;
      break;
    }
    case 'discord': {
      if (!value) throw invalid('The Discord webhook URL is required', 'config.webhookUrl');
      let u: URL;
      try { u = new URL(value); } catch { throw invalid('Invalid Discord webhook URL', 'config.webhookUrl'); }
      if (!DISCORD_HOST_RE.test(u.hostname) || !u.pathname.startsWith('/api/webhooks/')) {
        throw invalid('Expected a Discord webhook URL (https://discord.com/api/webhooks/…)', 'config.webhookUrl');
      }
      await assertPublicUrl(value);
      break;
    }
    case 'telegram': {
      if (!value) throw invalid('The Telegram bot token is required', 'config.botToken');
      if (!/^\d{3,20}:[A-Za-z0-9_-]{20,100}$/.test(value)) throw invalid('Invalid Telegram bot token', 'config.botToken');
      break;
    }
  }
  if (kept && value && previous && destinationChanged(cfg, previous.config)) {
    throw invalid('The destination changed: enter the secret again (or clear it)', `config.${field}`);
  }
  const secrets: ChannelSecrets = value ? { [field]: value } : {};
  return { config: { ...rest, type: cfg.type, __secretsSet: value ? [field] : [] }, secrets };
}

async function assertPublicUrl(url: string): Promise<void> {
  try {
    await deps.resolveTarget(url);
  } catch (err) {
    if (err instanceof SsrfError) throw forbidden(`URL refused: ${err.message}`);
    throw forbidden(`URL refused: ${(err as Error).message}`);
  }
}

function smtpPolicyFor(actor: Extract<HostingActor, { kind: 'staff' }>, tenantId: number): { allowPrivate: boolean; allowLoopback: boolean } {
  const admin = isPlatformAdmin(actor);
  return { allowPrivate: admin || tenantId === MASTER_TENANT_ID, allowLoopback: admin };
}

async function nameTaken(tenantId: number, name: string, exceptId?: number): Promise<boolean> {
  const q = db('notification_channels').where({ tenant_id: tenantId }).whereRaw('lower(name) = lower(?)', [name]);
  if (exceptId) q.whereNot({ id: exceptId });
  return !!(await q.first('id'));
}

const nameTakenError = () => new AppError(409, 'A channel with this name already exists', 'channelNameTaken');

// ── Rendering ────────────────────────────────────────────────────────────────

let panelHostCache: { at: number; value: string | null } | null = null;

async function panelBaseUrl(): Promise<string | null> {
  const now = Date.now();
  if (!panelHostCache || now - panelHostCache.at > 60_000) {
    try {
      const row = await db('app_config').where({ key: 'panel_hostname' }).first('value') as { value: string } | undefined;
      panelHostCache = { at: now, value: row?.value?.trim() || null };
    } catch {
      panelHostCache = { at: now, value: null };
    }
  }
  return panelHostCache.value ? `https://${panelHostCache.value}` : null;
}

async function render(event: NotificationEvent | 'test', p: NotificationPayload): Promise<RenderedNotification> {
  const base = await panelBaseUrl();
  const link = typeof p.link === 'string' && p.link.startsWith('/') && !p.link.startsWith('//') ? p.link : null;
  return {
    event,
    eventLabel: EVENT_LABELS_FR[event] ?? event,
    title: String(p.title ?? '').slice(0, 200) || EVENT_LABELS_FR[event] || 'Oblimint',
    message: String(p.message ?? '').slice(0, 4000),
    severity: p.severity === 'critical' || p.severity === 'warning' ? p.severity : 'info',
    url: base && link ? `${base}${link}` : null,
    tenantId: p.tenantId,
    accountId: p.accountId ?? null,
    key: String(p.key ?? '').slice(0, 200),
    timestamp: new Date().toISOString(),
  };
}

/** Error text stored in last_error / returned by the test (never a secret: URLs are not in the messages). */
export function deliveryErrorText(err: unknown): string {
  if (err instanceof SecretBoxError) return 'Secrets illisibles (clé du panel changée) : ressaisissez-les';
  if (err instanceof SsrfError) return `Destination refusée : ${err.message}`;
  if (err instanceof DeliveryError) return err.message;
  const e = err as { code?: string; responseCode?: number; message?: string };
  const msg = e?.message ? String(e.message) : String(err);
  return (e?.responseCode ? `SMTP ${e.responseCode}: ${msg}` : msg).replace(/\s+/g, ' ').slice(0, MAX_ERROR_LEN);
}

async function sendOnce(row: ChannelRow, n: RenderedNotification): Promise<void> {
  const cfg = { ...json<Record<string, unknown>>(row.config, {}), type: row.type } as unknown as NotificationChannelConfig;
  const secrets = openSecrets(row);
  const master = row.tenant_id === MASTER_TENANT_ID;
  await sendToChannel(cfg, secrets, n, deps, { allowPrivate: master, allowLoopback: master });
}

async function recordResult(row: Pick<ChannelRow, 'id' | 'tenant_id'>, error: string | null): Promise<void> {
  try {
    await db('notification_channels').where({ id: row.id, tenant_id: row.tenant_id })
      .update(error === null ? { last_sent_at: db.fn.now(), last_error: null } : { last_error: error.slice(0, MAX_ERROR_LEN) });
  } catch (err) {
    logger.debug({ err, channelId: row.id }, 'Notification channel status not recorded');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function deliverWithRetry(row: ChannelRow, n: RenderedNotification): Promise<boolean> {
  let lastError = '';
  for (let attempt = 0; attempt <= retryDelaysMs.length && attempt < 3; attempt++) {
    try {
      await sendOnce(row, n);
      await recordResult(row, null);
      return true;
    } catch (err) {
      lastError = deliveryErrorText(err);
      // A refused destination or unreadable secrets will not get better with a retry.
      if (err instanceof SsrfError || err instanceof SecretBoxError) break;
      if (attempt < Math.min(2, retryDelaysMs.length)) await sleep(retryDelaysMs[attempt]);
    }
  }
  logger.warn({ channelId: row.id, tenantId: row.tenant_id, event: n.event, error: lastError }, 'Notification delivery failed');
  await recordResult(row, lastError);
  return false;
}

// ── Queue ────────────────────────────────────────────────────────────────────

interface Job { event: NotificationEvent; payload: NotificationPayload }

const queue: Job[] = [];
const dedup = new Map<string, number>();
let busy = 0;
const busyByTenant = new Map<number, number>();
let idleWaiters: Array<() => void> = [];

function pruneDedup(now: number): void {
  if (dedup.size < 5_000) return;
  for (const [k, at] of dedup) if (now - at >= DEDUP_WINDOW_MS) dedup.delete(k);
  if (dedup.size >= 20_000) dedup.clear();
}

async function targetsFor(event: NotificationEvent, p: NotificationPayload): Promise<ChannelRow[]> {
  const withPlatform = p.platform === true && p.tenantId !== MASTER_TENANT_ID;
  return db('notification_channels')
    .where('enabled', true)
    .whereRaw('events @> ?::jsonb', [JSON.stringify([event])])
    .where((qb) => {
      qb.where('tenant_id', p.tenantId);
      if (withPlatform) qb.orWhere('tenant_id', MASTER_TENANT_ID);
    })
    .orderBy('id') as Promise<ChannelRow[]>;
}

async function processJob(job: Job): Promise<void> {
  const rows = await targetsFor(job.event, job.payload);
  if (rows.length === 0) return;
  const n = await render(job.event, job.payload);
  await Promise.all(rows.map((r) => deliverWithRetry(r, n)));
}

/** Index of the first queued job whose tenant is under its concurrency cap, -1 if none. */
function nextJobIndex(): number {
  for (let i = 0; i < queue.length; i++) {
    if ((busyByTenant.get(queue[i].payload.tenantId) ?? 0) < PER_TENANT_CONCURRENCY) return i;
  }
  return -1;
}

function pump(): void {
  while (busy < CONCURRENCY && queue.length > 0) {
    const i = nextJobIndex();
    if (i < 0) return; // every queued job waits for its tenant's running ones
    const [job] = queue.splice(i, 1);
    const tenantId = job.payload.tenantId;
    busy++;
    busyByTenant.set(tenantId, (busyByTenant.get(tenantId) ?? 0) + 1);
    processJob(job)
      .catch((err) => logger.warn({ err, event: job.event }, 'Notification job failed'))
      .finally(() => {
        busy--;
        const left = (busyByTenant.get(tenantId) ?? 1) - 1;
        if (left > 0) busyByTenant.set(tenantId, left);
        else busyByTenant.delete(tenantId);
        pump();
        if (busy === 0 && queue.length === 0) {
          const w = idleWaiters;
          idleWaiters = [];
          for (const f of w) f();
        }
      });
  }
}

/** CROSS-MODULE: queue a notification. Never throws, never blocks. */
export function notify(event: NotificationEvent, payload: NotificationPayload): void {
  try {
    if (!(NOTIFICATION_EVENTS as readonly string[]).includes(event)) return;
    if (!payload || !Number.isInteger(payload.tenantId) || payload.tenantId <= 0) return;
    const now = Date.now();
    const key = `${event}|${payload.tenantId}|${payload.key ?? ''}`;
    const last = dedup.get(key);
    if (last !== undefined && now - last < DEDUP_WINDOW_MS) return;
    dedup.set(key, now);
    pruneDedup(now);
    if (queue.length >= MAX_QUEUE) {
      queue.shift();
      logger.warn('Notification queue full: oldest notification dropped');
    }
    queue.push({ event, payload: { ...payload } });
    setImmediate(pump);
  } catch (err) {
    logger.warn({ err, event }, 'notify failed');
  }
}

/** Tests / shutdown: resolves once the queue is empty and nothing is being delivered. */
export function notificationQueueIdle(): Promise<void> {
  if (busy === 0 && queue.length === 0) return new Promise((r) => setImmediate(() => (busy === 0 && queue.length === 0 ? r() : idleWaiters.push(r))));
  return new Promise((r) => idleWaiters.push(r));
}

// ── Channel CRUD (staff 'settings' or platform admin) ───────────────────────

export const notificationService = {
  async list(actor: HostingActor): Promise<NotificationChannel[]> {
    assertChannelAdmin(actor);
    const rows = await db('notification_channels').where({ tenant_id: actor.tenantId }).orderBy('name') as ChannelRow[];
    return rows.map(toChannel);
  },

  async create(req: Request, actor: HostingActor, input: NotificationChannelInput): Promise<NotificationChannel> {
    assertChannelAdmin(actor);
    const body = parse(inputSchema, input);
    const tenantId = actor.tenantId;
    if (await nameTaken(tenantId, body.name)) throw nameTakenError();
    const prepared = await prepareConfig(body.config, null, smtpPolicyFor(actor, tenantId));
    const [row] = await db('notification_channels').insert({
      tenant_id: tenantId,
      name: body.name,
      type: body.config.type,
      config: JSON.stringify(prepared.config),
      secrets: Object.keys(prepared.secrets).length ? sealJson('notification', prepared.secrets) : null,
      events: JSON.stringify(body.events),
      enabled: body.enabled ?? true,
    }).returning('*') as ChannelRow[];
    await auditService.logReqAs(req, tenantId, 'notification.channel.create', {
      resourceType: 'notification_channel', resourcePath: String(row.id), details: { name: row.name, type: row.type, events: body.events },
    });
    return toChannel(row);
  },

  async update(req: Request, actor: HostingActor, id: number, input: Partial<NotificationChannelInput>): Promise<NotificationChannel> {
    assertChannelAdmin(actor);
    const row = await loadChannel(actor, id);
    const body = parse(inputSchema.partial(), input ?? {});
    const patch: Record<string, unknown> = { updated_at: db.fn.now() };
    const changed: string[] = [];
    if (body.name !== undefined && body.name !== row.name) {
      if (await nameTaken(row.tenant_id, body.name, row.id)) throw nameTakenError();
      patch.name = body.name;
      changed.push('name');
    }
    if (body.config !== undefined) {
      let previous: ChannelSecrets = {};
      if (body.config.type === row.type) {
        try {
          previous = openSecrets(row);
        } catch (err) {
          // Rotated SESSION_SECRET: the stored secret is lost, the new config must carry one.
          if (!(err instanceof SecretBoxError)) throw err;
        }
      }
      const prepared = await prepareConfig(body.config, { type: row.type, secrets: previous, config: json<Record<string, unknown>>(row.config, {}) },
        smtpPolicyFor(actor, row.tenant_id));
      patch.type = body.config.type;
      patch.config = JSON.stringify(prepared.config);
      patch.secrets = Object.keys(prepared.secrets).length ? sealJson('notification', prepared.secrets) : null;
      changed.push('config');
    }
    if (body.events !== undefined) { patch.events = JSON.stringify(body.events); changed.push('events'); }
    if (body.enabled !== undefined && body.enabled !== row.enabled) { patch.enabled = body.enabled; changed.push('enabled'); }
    const [updated] = await db('notification_channels').where({ id: row.id, tenant_id: row.tenant_id }).update(patch).returning('*') as ChannelRow[];
    if (!updated) throw new AppError(404, 'Channel not found', 'notFound');
    if (changed.length) {
      await auditService.logReqAs(req, row.tenant_id, 'notification.channel.update', {
        resourceType: 'notification_channel', resourcePath: String(row.id), details: { name: updated.name, type: updated.type, changed },
      });
    }
    return toChannel(updated);
  },

  async remove(req: Request, actor: HostingActor, id: number): Promise<void> {
    assertChannelAdmin(actor);
    const row = await loadChannel(actor, id);
    await db('notification_channels').where({ id: row.id, tenant_id: row.tenant_id }).delete();
    await auditService.logReqAs(req, row.tenant_id, 'notification.channel.delete', {
      resourceType: 'notification_channel', resourcePath: String(row.id), details: { name: row.name, type: row.type },
    });
  },

  /** Sends a test message now (one attempt, no deduplication). */
  async test(req: Request, actor: HostingActor, id: number): Promise<NotificationTestResult> {
    assertChannelAdmin(actor);
    const row = await loadChannel(actor, id);
    const n = await render('test', {
      tenantId: row.tenant_id,
      key: `test:${row.id}:${Date.now()}`,
      title: 'Notification de test',
      message: `Ceci est un message de test du canal « ${row.name} ». Si vous le lisez, le canal fonctionne.`,
      severity: 'info',
      link: '/settings',
    });
    let error: string | null = null;
    try {
      await sendOnce(row, n);
    } catch (err) {
      error = deliveryErrorText(err);
    }
    await recordResult(row, error);
    await auditService.logReqAs(req, row.tenant_id, 'notification.channel.test', {
      resourceType: 'notification_channel', resourcePath: String(row.id), details: { name: row.name, type: row.type, ok: error === null, ...(error ? { error } : {}) },
    });
    return { ok: error === null, error };
  },
};
