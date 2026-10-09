import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { safeEqualSecret } from '../../utils/safeCompare';
import { createDbAdminSourceCheck, type DbAdminKindName } from './sourceCheck';
import { dbAdminKey, ssoTokens, type SsoTokenStore } from './ssoTokens';

// ─────────────────────────────────────────────────────────────────────────────
// Internal listener routes of the DB admin SSO (module databases,
// docs/P2-PLAN.md §6.10 / §9.3, invariant B3). Mounted by
// internal/internalServer.ts on /internal/dbadmin (port 8081, never published).
//   POST /internal/dbadmin/redeem  { token } + header X-Oblimint-Dbadmin-Key
//        → 200 { engine, host, port, user, password, database|null, expiresAt } | 404
// Accepted only from the phpMyAdmin / Adminer containers (source address
// resolved by Docker DNS, sourceCheck.ts) AND with the shared key (HMAC of
// the session secret, env of the containers), compared in constant time.
// Every refusal is the same bare 404 (no oracle). A token is single use and
// lives 60 s (ssoTokens.ts); a token issued for phpMyAdmin is not
// redeemable by Adminer and vice versa. Rate-limited per peer.
// ─────────────────────────────────────────────────────────────────────────────

export const DBADMIN_KEY_HEADER = 'x-oblimint-dbadmin-key';

export interface DbAdminRouterDeps {
  /** Expected key (default dbAdminKey()). */
  key: () => string;
  /** Peer address → admin container kind, null = refused. */
  sourceKind: (remoteAddress: string | undefined) => Promise<DbAdminKindName | null | 'any'>;
  store: SsoTokenStore;
  /** Requests per minute and peer. */
  ratePerMinute?: number;
}

function defaultDeps(): DbAdminRouterDeps {
  const check = createDbAdminSourceCheck();
  return {
    key: () => dbAdminKey(),
    // OBLIMINT_HOOK_SOURCE_CHECK=off (dev without Docker DNS): key + token only.
    sourceKind: config.hosting.hookSourceCheck ? (addr) => check(addr) : async () => 'any',
    store: ssoTokens,
  };
}

export function createDbAdminInternalRouter(deps: DbAdminRouterDeps = defaultDeps()): Router {
  const router = Router();
  router.use(rateLimit({
    windowMs: 60_000,
    limit: deps.ratePerMinute ?? 60,
    standardHeaders: false,
    legacyHeaders: false,
    // The internal app does not trust proxies: req.ip = the peer address.
    handler: (_req, res) => { res.status(429).end(); },
  }));

  const refuse = (res: Response) => { res.status(404).json({ ok: false }); };

  router.post('/redeem', async (req: Request, res: Response) => {
    try {
      if (!safeEqualSecret(req.get(DBADMIN_KEY_HEADER), deps.key())) return refuse(res);
      const kind = await deps.sourceKind(req.socket.remoteAddress);
      if (!kind) return refuse(res);
      const token = (req.body as { token?: unknown } | undefined)?.token;
      const ticket = deps.store.redeem(token, kind === 'any' ? undefined : kind);
      if (!ticket) return refuse(res);
      logger.info({ instanceId: ticket.instanceId, accountId: ticket.accountId, user: ticket.credentials.user, ui: ticket.kind }, 'DB admin SSO token redeemed');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(ticket.credentials);
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, 'DB admin redeem failed');
      refuse(res);
    }
  });

  router.use((_req, res) => { res.status(404).end(); });
  return router;
}

/** The router mounted by internalServer.ts (created on first use: config is read then). */
let instance: Router | null = null;
export const dbAdminInternalRouter = ((req: Request, res: Response, next: (err?: unknown) => void) => {
  if (!instance) instance = createDbAdminInternalRouter();
  return instance(req, res, next);
}) as unknown as Router;
