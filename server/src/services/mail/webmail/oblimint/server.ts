import http from 'http';
import type { Request } from 'express';
import { config } from '../../../../config';
import { db } from '../../../../db';
import { logger } from '../../../../utils/logger';
import { resolveClient } from '../../../../utils/clientIp';
import { banKey } from '../../../firewall/addresses';
import { platformSettings } from '../../../platformSettings';
import { errText } from '../../../setup/docker';
import { readAdminSecret } from '../../engines/stalwart/secret';
import { activeMailDriver } from '../../registry';
import { parseAutoresponder } from '../../rows';
import { createWebmailApp } from './app';
import { createWebmailAuth, type MailboxAuthRow } from './auth';
import { createStalwartWebmailEngine } from './engine';
import { dbWebmailSessionStore } from './session';

// ─────────────────────────────────────────────────────────────────────────────
// Listener of the Oblimint webmail (config.hosting.webmailPort, default 8082):
// plain HTTP, never published on the host; the edge proxies the webmail
// hosts to http://oblimint-panel:<port> when settings mail.webmail =
// 'oblimint' (edgeContributor.ts). A separate express app (app.ts): nothing
// of the panel's API, cookies or middleware is reachable through it.
// Started with the workers (normal mode); answers "not enabled" while the
// setting is another webmail.
// ─────────────────────────────────────────────────────────────────────────────

const ENABLED_TTL_MS = 5_000;
let enabledCache: { at: number; value: boolean } | null = null;

/** settings mail.webmail = 'oblimint' AND the active engine is Stalwart with mailboxes. Cached 5 s, never throws. */
export async function oblimintWebmailEnabled(): Promise<boolean> {
  const now = Date.now();
  if (enabledCache && now - enabledCache.at < ENABLED_TTL_MS) return enabledCache.value;
  let value = false;
  try {
    const s = await platformSettings.section('mail');
    if (s.webmail === 'oblimint') {
      const d = await activeMailDriver();
      value = d.engine === 'stalwart' && !!d.capabilities.supported && !!d.capabilities.mailboxes;
    }
  } catch (err) {
    logger.warn({ err: errText(err) }, 'webmail: settings / engine unreadable');
  }
  enabledCache = { at: now, value };
  return value;
}

export function resetOblimintWebmailCache(): void {
  enabledCache = null;
}

async function findMailbox(where: { address?: string; id?: number }): Promise<MailboxAuthRow | null> {
  const q = db('mailboxes as m')
    .join('mail_domains as md', 'md.id', 'm.mail_domain_id')
    .join('domains as d', 'd.id', 'md.domain_id')
    .join('hosting_accounts as a', 'a.id', 'm.account_id');
  if (where.address !== undefined) q.where('m.address', where.address);
  else q.where('m.id', where.id!);
  const r = await q.first(
    'm.id', 'm.account_id', 'm.tenant_id', 'm.address', 'm.display_name', 'm.password_hash', 'm.enabled',
    'md.enabled as domain_enabled', 'd.verification_status', 'a.status as account_status',
  ) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: Number(r.id),
    accountId: Number(r.account_id),
    tenantId: Number(r.tenant_id),
    address: String(r.address).toLowerCase(),
    displayName: (r.display_name as string | null) ?? null,
    passwordHash: String(r.password_hash ?? ''),
    mailboxEnabled: !!r.enabled,
    domainEnabled: !!r.domain_enabled,
    domainVerified: r.verification_status === 'verified',
    accountStatus: (r.account_status as string | null) ?? null,
  };
}

/** Largest upload: the mail domain's message size, else the platform's (MiB → bytes). */
async function maxUploadBytes(mailboxId: number): Promise<number> {
  const row = await db('mailboxes as m').join('mail_domains as md', 'md.id', 'm.mail_domain_id').where('m.id', mailboxId)
    .first('md.max_message_size_mb') as { max_message_size_mb: number | null } | undefined;
  const s = await platformSettings.section('mail');
  const mb = Math.min(Number(row?.max_message_size_mb) || s.maxMessageSizeMb, s.maxMessageSizeMb) || 25;
  return Math.max(1, mb) * 1048576;
}

function clientIp(req: Request): string {
  return resolveClient(req.socket.remoteAddress, req.headers['x-forwarded-for']).ip;
}

export const webmailEngine = createStalwartWebmailEngine({
  masterSecret: async () => {
    const creds = await readAdminSecret();
    if (!creds) throw new Error('the mail engine credentials are not available');
    return creds.secret;
  },
});

export function createDefaultWebmailApp() {
  const auth = createWebmailAuth({
    store: dbWebmailSessionStore,
    engine: webmailEngine,
    now: Date.now,
    findMailboxByAddress: (address) => findMailbox({ address }),
    findMailboxById: (id) => findMailbox({ id }),
    redeemSso: async (token) => (await import('../webmail.service')).webmailService.redeemOblimint(token),
    isBanned: async (ip) => {
      try {
        const key = banKey(ip);
        if (!key) return false;
        return !!(await db('mail_bans').where({ ip: key }).andWhere('expires_at', '>', new Date()).first('id'));
      } catch {
        return false;
      }
    },
    recordFailure: (ip, username) => {
      void import('../../security/mailSecurity.service')
        .then((m) => m.mailSecurityService.recordAuthFailure({ ip, service: 'webmail', username }))
        .catch(() => undefined);
    },
    maxUploadBytes,
  });
  return createWebmailApp({
    auth,
    engine: webmailEngine,
    enabled: oblimintWebmailEnabled,
    secure: config.nodeEnv === 'production' || config.forceHttps,
    clientIp,
    maxUploadBytes,
    vacation: {
      async get(mailboxId) {
        const r = await db('mailboxes').where({ id: mailboxId }).first('autoresponder') as { autoresponder: unknown } | undefined;
        return r ? parseAutoresponder(r.autoresponder) : null;
      },
      async set(mailboxId, value, ip) {
        const { mailService } = await import('../../mail.service');
        return mailService.setAutoresponderAsMailbox(mailboxId, value, ip);
      },
    },
    clientDist: config.clientDist,
    now: Date.now,
  });
}

let server: http.Server | null = null;
let sweeper: NodeJS.Timeout | null = null;

/** Is the listener up (SSO possible)? */
export function oblimintWebmailListening(): boolean {
  return !!server?.listening;
}

/** Starts the listener (no-op when webmailPort = 0). */
export function startOblimintWebmail(): http.Server | null {
  if (server) return server;
  const port = config.hosting.webmailPort;
  if (!port) {
    logger.info('Oblimint webmail listener disabled (OBLIMINT_WEBMAIL_PORT=0)');
    return null;
  }
  const s = http.createServer(createDefaultWebmailApp());
  s.requestTimeout = 0; // uploads and the event stream are long; headers stay bounded below.
  s.headersTimeout = 15_000;
  s.keepAliveTimeout = 65_000;
  s.on('error', (err) => logger.error({ err, port }, 'Oblimint webmail listener error'));
  s.listen(port, '0.0.0.0', () => logger.info({ port }, 'Oblimint webmail listener started'));
  server = s;
  sweeper = setInterval(() => {
    void dbWebmailSessionStore.sweep(Date.now()).catch((err) => logger.warn({ err: errText(err) }, 'webmail: session sweep failed'));
  }, 10 * 60_000);
  sweeper.unref?.();
  return s;
}

export function stopOblimintWebmail(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
  if (!server) return;
  server.close();
  server.closeAllConnections?.();
  server = null;
}
