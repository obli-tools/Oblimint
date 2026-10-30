import type { Request } from 'express';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import type {
  TransactionalMailKind, TransactionalMailLogEntry, TransactionalMailMode, TransactionalMailSettings, TransactionalMailSettingsInput,
  TransactionalMailTestResult,
} from '@oblimint/shared';
import { TRANSACTIONAL_MAIL_MODES } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { SecretBoxError, openJson, sealJson } from '../../utils/secretBox';
import { auditService } from '../audit.service';
import type { MailTransport } from '../usage/notifications/plugins';
import { resolveSmtpHost, SsrfError, type LookupFn } from '../usage/notifications/ssrf';
import type { MailEndpoint } from './driver';

// ─────────────────────────────────────────────────────────────────────────────
// Transactional e-mail sender of the platform: what the panel itself sends to
// a person (notification center e-mails, test, later password reset /
// activation). Configured by the platform admin (Settings > E-mail sender):
//
//   off       nothing leaves (send() records 'skipped');
//   platform  authenticated submission (587, STARTTLS) on the ACTIVE mail
//             engine, as a mailbox hosted on the platform (the panel is
//             attached to the mail network; the sender is the mailbox itself:
//             the engine refuses any other From). The engine's certificate is
//             for its public name, the connection is internal: not verified;
//   smtp      an external SMTP server (provider, relay): the host is resolved
//             and pinned (resolveSmtpHost; private / loopback allowed, the
//             platform admin configures it), certificate checked on its name.
//
// Stored in app_config `mail.transactional` (JSON); the two passwords are
// sealed (secretBox 'transactional-mail'), write-only through the API.
// send() never throws: every attempt is journaled (transactional_mail_log,
// 90 days), the error text never contains a secret.
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_KEY = 'mail.transactional';
const MAX_ERROR = 500;
export const TRANSACTIONAL_LOG_RETENTION_DAYS = 90;

interface Secrets { platformPassword?: string | null; smtpPassword?: string | null }

interface Stored {
  mode: TransactionalMailMode;
  fromName: string | null;
  platform: { mailbox: string | null };
  smtp: { host: string | null; port: number; secure: boolean; username: string | null; from: string | null };
  /** sealJson('transactional-mail', Secrets) */
  secrets: string | null;
  secretsSet: string[];
}

const DEFAULT_STORED: Stored = {
  mode: 'off',
  fromName: null,
  platform: { mailbox: null },
  smtp: { host: null, port: 587, secure: false, username: null, from: null },
  secrets: null,
  secretsSet: [],
};

export interface TransactionalDeps {
  transport: (options: Record<string, unknown>) => MailTransport;
  lookup?: LookupFn;
  /** Submission endpoint of the active engine (null: none / external engine). */
  submissionEndpoint: () => Promise<MailEndpoint | null>;
  timeoutMs: number;
  deadlineMs: number;
}

const defaultDeps: TransactionalDeps = {
  transport: (options) => nodemailer.createTransport(options as never) as unknown as MailTransport,
  submissionEndpoint: async () => {
    try {
      const { activeMailDriver } = await import('./registry');
      const driver = await activeMailDriver();
      return driver.capabilities.mailboxes ? driver.submissionEndpoint() : null;
    } catch {
      return null;
    }
  },
  timeoutMs: 10_000,
  deadlineMs: 30_000,
};
let deps: TransactionalDeps = defaultDeps;

/** Tests: replace the transport / engine lookup. null restores. */
export function setTransactionalDepsForTests(override: Partial<TransactionalDeps> | null): void {
  deps = override ? { ...defaultDeps, ...override } : defaultDeps;
  cache = null;
}

// ── storage ──────────────────────────────────────────────────────────────────

let cache: { at: number; value: Stored } | null = null;
const CACHE_MS = 10_000;

async function loadStored(): Promise<Stored> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value: Stored = { ...DEFAULT_STORED, platform: { ...DEFAULT_STORED.platform }, smtp: { ...DEFAULT_STORED.smtp } };
  try {
    const row = await db('app_config').where({ key: CONFIG_KEY }).first('value') as { value: string } | undefined;
    if (row?.value) {
      const raw = JSON.parse(row.value) as Partial<Stored>;
      value = {
        mode: (TRANSACTIONAL_MAIL_MODES as readonly string[]).includes(String(raw.mode)) ? raw.mode as TransactionalMailMode : 'off',
        fromName: typeof raw.fromName === 'string' && raw.fromName ? raw.fromName : null,
        platform: { mailbox: typeof raw.platform?.mailbox === 'string' ? raw.platform.mailbox : null },
        smtp: {
          host: typeof raw.smtp?.host === 'string' ? raw.smtp.host : null,
          port: Number.isInteger(raw.smtp?.port) ? Number(raw.smtp?.port) : 587,
          secure: raw.smtp?.secure === true,
          username: typeof raw.smtp?.username === 'string' && raw.smtp.username ? raw.smtp.username : null,
          from: typeof raw.smtp?.from === 'string' && raw.smtp.from ? raw.smtp.from : null,
        },
        secrets: typeof raw.secrets === 'string' ? raw.secrets : null,
        secretsSet: Array.isArray(raw.secretsSet) ? raw.secretsSet.filter((s): s is string => typeof s === 'string') : [],
      };
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'transactional mail: settings unreadable, sender off');
  }
  cache = { at: Date.now(), value };
  return value;
}

function openSecrets(s: Stored): Secrets {
  if (!s.secrets) return {};
  return openJson<Secrets>('transactional-mail', s.secrets);
}

async function saveStored(s: Stored): Promise<void> {
  await db('app_config').insert({ key: CONFIG_KEY, value: JSON.stringify(s) }).onConflict('key').merge();
  cache = null;
}

// ── validation ───────────────────────────────────────────────────────────────

const email = z.string().trim().toLowerCase().min(3).max(254).regex(/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/, 'an e-mail address');
const noBreak = /^[^\r\n]*$/;
const secretIn = z.string().max(500).regex(noBreak, 'no line breaks').nullable().optional();
const host = z.string().trim().toLowerCase().min(1).max(253).regex(/^[a-z0-9.:[\]-]+$/, 'a host name or an IP address');

const inputSchema = z.object({
  mode: z.enum(TRANSACTIONAL_MAIL_MODES as unknown as [TransactionalMailMode, ...TransactionalMailMode[]]).optional(),
  fromName: z.string().trim().max(100).regex(/^[^\r\n"<>]*$/, 'no quotes, angle brackets or line breaks').nullable().optional(),
  platform: z.object({ mailbox: email.nullable().optional(), password: secretIn }).strict().optional(),
  smtp: z.object({
    host: host.nullable().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    secure: z.boolean().optional(),
    username: z.string().trim().max(200).regex(noBreak).nullable().optional(),
    from: email.nullable().optional(),
    password: secretIn,
  }).strict().optional(),
}).strict();

function invalid(message: string, field?: string): AppError {
  return new AppError(400, message, 'validation', field ? { field } : undefined);
}

/** Display form of the sender: "Name" <address> (name quoted, never a header injection). */
export function formatFrom(name: string | null, address: string): string {
  const n = (name ?? 'Oblimint').replace(/["\\\r\n<>]/g, '').trim() || 'Oblimint';
  return `"${n}" <${address}>`;
}

function readyOf(s: Stored, platformAvailable: boolean): boolean {
  if (s.mode === 'platform') return platformAvailable && !!s.platform.mailbox && s.secretsSet.includes('platformPassword');
  if (s.mode === 'smtp') return !!s.smtp.host && !!s.smtp.from && (!s.smtp.username || s.secretsSet.includes('smtpPassword'));
  return false;
}

async function toSettings(s: Stored): Promise<TransactionalMailSettings> {
  const platformAvailable = (await deps.submissionEndpoint()) !== null;
  return {
    mode: s.mode,
    fromName: s.fromName,
    platform: { mailbox: s.platform.mailbox, passwordSet: s.secretsSet.includes('platformPassword') },
    smtp: { ...s.smtp, passwordSet: s.secretsSet.includes('smtpPassword') },
    platformAvailable,
    ready: readyOf(s, platformAvailable),
  };
}

// ── sending ──────────────────────────────────────────────────────────────────

export interface TransactionalMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  kind: TransactionalMailKind;
  userId?: number | null;
}

export interface TransactionalSendResult {
  ok: boolean;
  status: 'sent' | 'failed' | 'skipped';
  error: string | null;
}

function errorText(err: unknown): string {
  if (err instanceof SecretBoxError) return 'Mot de passe illisible (clé du panel changée) : ressaisissez-le';
  if (err instanceof SsrfError) return `Destination refusée : ${err.message}`;
  const e = err as { responseCode?: number; message?: string };
  const msg = e?.message ? String(e.message) : String(err);
  return (e?.responseCode ? `SMTP ${e.responseCode}: ${msg}` : msg).replace(/\s+/g, ' ').slice(0, MAX_ERROR);
}

function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout(); } catch { /* closed */ }
      reject(new Error('timed out'));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([p, expired]).finally(() => { if (timer) clearTimeout(timer); });
}

async function journal(m: TransactionalMessage, status: TransactionalSendResult['status'], transport: 'platform' | 'smtp' | null, error: string | null): Promise<void> {
  try {
    await db('transactional_mail_log').insert({
      kind: m.kind,
      to_address: m.to.slice(0, 254),
      subject: m.subject.slice(0, 300),
      status,
      transport,
      error: error ? error.slice(0, MAX_ERROR) : null,
      user_id: m.userId ?? null,
    });
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'transactional mail: journal failed');
  }
}

/** Transport options + sender for the current settings, or the reason nothing can leave. */
async function prepare(s: Stored): Promise<{ options: Record<string, unknown>; from: string; transport: 'platform' | 'smtp' } | { skip: string }> {
  if (s.mode === 'off') return { skip: 'Expéditeur désactivé' };
  const secrets = openSecrets(s);
  const common = { name: 'oblimint', connectionTimeout: deps.timeoutMs, greetingTimeout: deps.timeoutMs, socketTimeout: deps.timeoutMs * 2 };
  if (s.mode === 'platform') {
    const ep = await deps.submissionEndpoint();
    if (!ep) return { skip: 'Le moteur mail de la plateforme n’est pas actif' };
    if (!s.platform.mailbox || !secrets.platformPassword) return { skip: 'Boîte d’envoi de la plateforme non configurée' };
    return {
      transport: 'platform',
      from: formatFrom(s.fromName, s.platform.mailbox),
      options: {
        ...common,
        host: ep.host,
        port: ep.port,
        secure: ep.tls === 'tls',
        requireTLS: ep.tls === 'starttls',
        ignoreTLS: ep.tls === 'none',
        // Internal mail network: the engine's certificate names its public host.
        tls: { rejectUnauthorized: false },
        auth: { user: s.platform.mailbox, pass: secrets.platformPassword },
      },
    };
  }
  if (!s.smtp.host || !s.smtp.from) return { skip: 'Serveur SMTP non configuré' };
  const pinned = await resolveSmtpHost(s.smtp.host, { allowPrivate: true, allowLoopback: true, lookup: deps.lookup });
  return {
    transport: 'smtp',
    from: formatFrom(s.fromName, s.smtp.from),
    options: {
      ...common,
      host: pinned.address,
      port: s.smtp.port,
      secure: s.smtp.secure,
      tls: { servername: s.smtp.host.replace(/^\[|\]$/g, '') },
      ...(s.smtp.username ? { auth: { user: s.smtp.username, pass: secrets.smtpPassword ?? '' } } : {}),
    },
  };
}

const toOk = (to: string) => email.safeParse(to).success;

/** Error of a refused recipient address (not a transport failure). */
export const INVALID_ADDRESS = 'Adresse invalide';

function cleanMessage(m: TransactionalMessage): TransactionalMessage {
  return {
    ...m,
    to: String(m.to ?? '').trim().toLowerCase(),
    subject: String(m.subject ?? '').replace(/[\r\n]+/g, ' ').slice(0, 250),
  };
}

/** Journals an e-mail not attempted (e.g. sender suspended after repeated failures). */
export async function recordSkippedTransactional(m: TransactionalMessage, reason: string): Promise<void> {
  await journal(cleanMessage(m), 'skipped', null, reason);
}

/** Sends one e-mail now. Never throws; journaled. */
export async function sendTransactional(m: TransactionalMessage): Promise<TransactionalSendResult> {
  const msg = cleanMessage(m);
  if (!toOk(msg.to)) {
    await journal(msg, 'failed', null, INVALID_ADDRESS);
    return { ok: false, status: 'failed', error: INVALID_ADDRESS };
  }
  let transportKind: 'platform' | 'smtp' | null = null;
  try {
    const s = await loadStored();
    const prepared = await prepare(s);
    if ('skip' in prepared) {
      await journal(msg, 'skipped', null, prepared.skip);
      return { ok: false, status: 'skipped', error: prepared.skip };
    }
    transportKind = prepared.transport;
    const transport = deps.transport(prepared.options);
    const sending = transport.sendMail({
      from: prepared.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
    });
    sending.catch(() => undefined);
    try {
      await withDeadline(sending, deps.deadlineMs, () => transport.close?.());
    } finally {
      try { transport.close?.(); } catch { /* closed */ }
    }
    await journal(msg, 'sent', transportKind, null);
    return { ok: true, status: 'sent', error: null };
  } catch (err) {
    const error = errorText(err);
    logger.warn({ kind: msg.kind, transport: transportKind, error }, 'transactional mail failed');
    await journal(msg, 'failed', transportKind, error);
    return { ok: false, status: 'failed', error };
  }
}

/** Is a transactional e-mail possible now (cached settings + engine check)? */
export async function transactionalMailReady(): Promise<boolean> {
  try {
    const s = await loadStored();
    if (s.mode === 'off') return false;
    return readyOf(s, s.mode === 'platform' ? (await deps.submissionEndpoint()) !== null : false);
  } catch {
    return false;
  }
}

export async function purgeTransactionalLog(now = Date.now()): Promise<number> {
  const cutoff = new Date(now - TRANSACTIONAL_LOG_RETENTION_DAYS * 86_400_000);
  return Number(await db('transactional_mail_log').where('created_at', '<', cutoff).delete()) || 0;
}

// ── settings API (platform admin; the routes check the role) ─────────────────

export const transactionalMailService = {
  async get(): Promise<TransactionalMailSettings> {
    return toSettings(await loadStored());
  },

  async update(req: Request, input: TransactionalMailSettingsInput): Promise<TransactionalMailSettings> {
    const parsed = inputSchema.safeParse(input ?? {});
    if (!parsed.success) {
      const first = parsed.error.errors[0];
      throw invalid(`Validation failed — ${parsed.error.errors.map((e) => `${e.path.join('.') || '<root>'}: ${e.message}`).join('; ')}`, first?.path.join('.') || undefined);
    }
    const body = parsed.data;
    cache = null;
    const current = await loadStored();
    let secrets: Secrets = {};
    try {
      secrets = openSecrets(current);
    } catch (err) {
      if (!(err instanceof SecretBoxError)) throw err;
      // Rotated SESSION_SECRET: the stored passwords are lost, the input must carry them again.
    }
    const next: Stored = {
      ...current,
      platform: { ...current.platform },
      smtp: { ...current.smtp },
    };
    const changed: string[] = [];
    if (body.mode !== undefined && body.mode !== current.mode) { next.mode = body.mode; changed.push('mode'); }
    if (body.fromName !== undefined) { next.fromName = body.fromName || null; changed.push('fromName'); }
    if (body.platform) {
      if (body.platform.mailbox !== undefined) {
        const mb = body.platform.mailbox || null;
        // A kept password only goes with the mailbox it was given for (L8, as the SMTP server):
        // refused rather than silently dropped (the sender would quietly stop being ready).
        if (mb !== current.platform.mailbox && secrets.platformPassword && typeof body.platform.password !== 'string') {
          if (mb !== null) throw invalid('The mailbox changed: enter the password again (or clear it)', 'platform.password');
          secrets.platformPassword = null; // mailbox removed: its password goes with it
        }
        next.platform.mailbox = mb;
        changed.push('platform.mailbox');
      }
      if (typeof body.platform.password === 'string') { secrets.platformPassword = body.platform.password || null; changed.push('platform.password'); }
    }
    if (body.smtp) {
      const sm = body.smtp;
      const hostChanged = (sm.host !== undefined && (sm.host || null) !== current.smtp.host) || (sm.port !== undefined && sm.port !== current.smtp.port);
      if (sm.host !== undefined) next.smtp.host = sm.host || null;
      if (sm.port !== undefined) next.smtp.port = sm.port;
      if (sm.secure !== undefined) next.smtp.secure = sm.secure;
      if (sm.username !== undefined) next.smtp.username = sm.username || null;
      if (sm.from !== undefined) next.smtp.from = sm.from || null;
      if (typeof sm.password === 'string') secrets.smtpPassword = sm.password || null;
      else if (hostChanged && secrets.smtpPassword) {
        // L8: a stored secret only goes where it was given.
        throw invalid('The SMTP server changed: enter the password again (or clear it)', 'smtp.password');
      }
      changed.push('smtp');
    }
    if (next.smtp.host) {
      try {
        await resolveSmtpHost(next.smtp.host, { allowPrivate: true, allowLoopback: true, lookup: deps.lookup });
      } catch (err) {
        throw invalid(`SMTP host refused: ${(err as Error).message}`, 'smtp.host');
      }
    }
    const set = Object.entries(secrets).filter(([, v]) => typeof v === 'string' && v).map(([k]) => k);
    next.secretsSet = set;
    next.secrets = set.length ? sealJson('transactional-mail', Object.fromEntries(Object.entries(secrets).filter(([, v]) => typeof v === 'string' && v))) : null;
    await saveStored(next);
    await auditService.logReqAs(req, 1, 'mail.transactional.update', {
      resourceType: 'app_config', resourcePath: CONFIG_KEY, details: { mode: next.mode, changed },
    });
    return toSettings(next);
  },

  async test(req: Request, to: unknown): Promise<TransactionalMailTestResult> {
    const addr = typeof to === 'string' ? to.trim().toLowerCase() : '';
    if (!toOk(addr)) throw invalid('A valid e-mail address is required', 'to');
    const r = await sendTransactional({
      to: addr,
      kind: 'test',
      userId: Number(req.session?.userId) || null,
      subject: '[Oblimint] E-mail de test',
      text: 'Ceci est un e-mail de test de l’expéditeur transactionnel d’Oblimint. Si vous le lisez, l’envoi fonctionne.\n\n— Oblimint',
    });
    await auditService.logReqAs(req, 1, 'mail.transactional.test', {
      resourceType: 'app_config', resourcePath: CONFIG_KEY, details: { ok: r.ok, status: r.status, ...(r.error ? { error: r.error } : {}) },
    });
    return { ok: r.ok, error: r.error };
  },

  async log(limit = 50): Promise<TransactionalMailLogEntry[]> {
    const n = Math.min(Math.max(Number.isInteger(limit) ? limit : 50, 1), 200);
    const rows = await db('transactional_mail_log').orderBy('id', 'desc').limit(n) as Array<{
      id: number | string; created_at: Date | string; kind: TransactionalMailKind; to_address: string; subject: string;
      status: 'sent' | 'failed' | 'skipped'; transport: 'platform' | 'smtp' | null; error: string | null;
    }>;
    return rows.map((r) => ({
      id: Number(r.id),
      createdAt: new Date(r.created_at).toISOString(),
      kind: r.kind,
      to: r.to_address,
      subject: r.subject,
      status: r.status,
      transport: r.transport,
      error: r.error,
    }));
  },
};
