import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { logger } from '../../../utils/logger';
import { safeEqualSecret } from '../../../utils/safeCompare';
import { normalizeIp } from '../../docker/hookSource';
import { WEBMAIL_CONTAINER } from '../../hosting/naming';
import { mailNetworkAddresses } from '../network';
import { WEBMAIL_KEY_HEADER, webmailKey, type WebmailCredentials } from './ssoTokens';

// ─────────────────────────────────────────────────────────────────────────────
// Internal listener routes /internal/mail/* (port 8081, never published;
// mounted by internal/internalServer.ts) — module webmail, docs/P4-PLAN.md
// §6.7 / §9.7, invariants MA4 / MA13 (same pattern as the DB admin SSO, B3).
//
//   POST /internal/mail/webmail/redeem  { token }              → 200 { username, password, expiresAt } | 404
//   POST /internal/mail/webmail/logout  { username, password } → 200 { revoked } | 404
//
// Both checks are mandatory, any failure = the same bare 404 (no oracle):
//  - header X-Oblimint-Webmail-Key = HMAC-SHA256(sessionSecret,
//    'oblimint-webmail'), compared in constant time (the container gets it
//    as env);
//  - source address = an address of the oblimint-webmail container on the
//    mail network (mailNetworkAddresses, cached; loopback NOT accepted: the
//    webmail never shares the panel's network namespace). Other members of
//    the mail network (engine, relay, scanner) cannot take that address
//    (CapDrop ALL: no NET_RAW / NET_ADMIN; the bridge assigns addresses).
// Rate-limited per peer (R-WEBMAIL-BRUTE: tokens are 256-bit, the limit
// mostly caps the work of a hostile peer). The credential is never logged.
// ─────────────────────────────────────────────────────────────────────────────

export interface WebmailSourceCheckOptions {
  /** Addresses of the webmail container on the mail network (default mailNetworkAddresses). */
  addresses?: () => Promise<string[]>;
  /** How long a resolved address set is trusted (a recreated container gets a new address). */
  ttlMs?: number;
  /** Minimum delay between two lookups on a mismatch (no Docker API flood from a hostile peer). */
  retryMs?: number;
  now?: () => number;
}

/** (remote address) → is it the webmail container? Never throws. */
export function createWebmailSourceCheck(opts: WebmailSourceCheckOptions = {}) {
  const addresses = opts.addresses ?? (() => mailNetworkAddresses(WEBMAIL_CONTAINER));
  const ttlMs = opts.ttlMs ?? 30_000;
  const retryMs = opts.retryMs ?? 2_000;
  const now = opts.now ?? Date.now;
  let cache: { at: number; ips: Set<string> } | null = null;
  const warned = new Map<string, number>();

  const lookup = async (): Promise<Set<string>> => {
    let ips = new Set<string>();
    try {
      ips = new Set((await addresses()).map((a) => normalizeIp(a)).filter((x): x is string => !!x));
    } catch { /* container absent / network missing: nobody */ }
    cache = { at: now(), ips };
    return ips;
  };

  return async (remoteAddress: string | null | undefined): Promise<boolean> => {
    const ip = normalizeIp(remoteAddress);
    if (!ip) return false;
    const t = now();
    if (cache && t - cache.at < ttlMs && cache.ips.has(ip)) return true;
    const ips = cache && t - cache.at < retryMs ? cache.ips : await lookup();
    if (ips.has(ip)) return true;
    if ((warned.get(ip) ?? 0) < t - 60_000) {
      if (warned.size > 1000) warned.clear();
      warned.set(ip, t);
      logger.warn({ peer: ip }, 'Webmail SSO endpoint called from an address that is not the webmail container: refused');
    }
    return false;
  };
}

export interface MailInternalRouterDeps {
  /** Expected key (default webmailKey()). */
  key: () => string;
  /** Peer address → is it the webmail container? */
  isWebmailSource: (remoteAddress: string | undefined) => Promise<boolean>;
  redeem: (token: unknown) => Promise<WebmailCredentials | null>;
  logout: (username: unknown, password: unknown) => Promise<boolean>;
  /** Requests per minute and peer. */
  ratePerMinute?: number;
}

async function defaultDeps(): Promise<MailInternalRouterDeps> {
  const { webmailService } = await import('./webmail.service');
  return {
    key: () => webmailKey(),
    isWebmailSource: createWebmailSourceCheck(),
    redeem: (token) => webmailService.redeem(token),
    logout: (username, password) => webmailService.logout(username, password),
  };
}

export function createMailInternalRouter(deps: MailInternalRouterDeps): Router {
  const router = Router();
  router.use(rateLimit({
    windowMs: 60_000,
    limit: deps.ratePerMinute ?? 120,
    standardHeaders: false,
    legacyHeaders: false,
    // The internal app does not trust proxies: req.ip = the peer address.
    handler: (_req, res) => { res.status(429).end(); },
  }));

  const refuse = (res: Response) => { res.status(404).json({ ok: false }); };
  /** Key first (cheap, constant time), then the source address. */
  const allowed = async (req: Request): Promise<boolean> =>
    safeEqualSecret(req.get(WEBMAIL_KEY_HEADER), deps.key()) && await deps.isWebmailSource(req.socket.remoteAddress);

  router.post('/webmail/redeem', async (req: Request, res: Response) => {
    try {
      if (!(await allowed(req))) return refuse(res);
      const creds = await deps.redeem((req.body as { token?: unknown } | undefined)?.token);
      if (!creds) return refuse(res);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ username: creds.username, password: creds.password, expiresAt: creds.expiresAt });
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, 'webmail redeem failed');
      refuse(res);
    }
  });

  router.post('/webmail/logout', async (req: Request, res: Response) => {
    try {
      if (!(await allowed(req))) return refuse(res);
      const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
      const revoked = await deps.logout(body.username, body.password);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ revoked });
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, 'webmail logout failed');
      refuse(res);
    }
  });

  router.use((_req, res) => { res.status(404).end(); });
  return router;
}

/** The router mounted by internalServer.ts (created on first use). */
let instance: Promise<Router> | null = null;
export const mailInternalRouter = ((req: Request, res: Response, next: (err?: unknown) => void) => {
  if (!instance) instance = defaultDeps().then(createMailInternalRouter);
  instance.then((r) => r(req, res, next)).catch(() => {
    instance = null;
    if (!res.headersSent) res.status(404).end();
  });
}) as unknown as Router;
