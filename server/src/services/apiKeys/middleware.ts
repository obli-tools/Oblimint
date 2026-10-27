import type { NextFunction, Request, Response } from 'express';
import rateLimit, { MemoryStore } from 'express-rate-limit';
import { AppError } from '../../middleware/errorHandler';
import { ipKey } from '../../middleware/rateLimiter';
import { clientIp } from '../../utils/clientIp';
import { setRequestActor } from '../hosting/access';
import { apiKeysService } from './apiKeys.service';
import { resourceMetadataUrl } from './oauth';

// Bearer authentication of /api/v1 and /mcp (API keys, shared/src/apiKeys.ts):
// obk_… keys, and oba_… OAuth access tokens of the connectors (oauth.ts),
// accepted on /mcp only: a connector is an MCP client (L17).
// No session, no cookie: originGuard lets non-browser clients through (no
// Origin header); a browser cannot send the Authorization header cross-site
// without a CORS preflight the panel never grants.

/**
 * Refused keys: 20 / 15 min per address (/64 in IPv6), successes not counted.
 * A request without credentials is not a guess: an OAuth client (claude.ai)
 * starts every connection with one to discover the authorization server.
 */
export const apiKeyAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  skip: (req) => !req.headers.authorization,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `apikey-auth:${ipKey(clientIp(req))}`,
  message: { success: false, error: 'Too many invalid API keys, try again later', code: 'rateLimited' },
});

const API_KEY_MAX_PER_MIN = 1200;
const apiKeyStore = new MemoryStore();
const limiterKey = (req: Request) => `apikey:${req.apiKey?.id ?? ipKey(clientIp(req))}`;

/** Per key, after authentication: 1 200 requests / min (uploads included; each tools/call of an MCP batch too). */
export const apiKeyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: API_KEY_MAX_PER_MIN,
  store: apiKeyStore,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: limiterKey,
  message: { success: false, error: 'Too many requests for this API key, slow down', code: 'rateLimited' },
});

/**
 * Counts one more request of the authenticated key in apiKeyLimiter's window
 * (a tools/call inside an MCP batch: one HTTP request, many operations, M5).
 * false: the key is over its limit, the operation must be refused.
 */
export async function countKeyRequest(req: Request): Promise<boolean> {
  const hit = await apiKeyStore.increment(limiterKey(req));
  return hit.totalHits <= API_KEY_MAX_PER_MIN;
}

/** Bearer authentication of /api/v1 (keys only). */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  return authenticate(req, res, next, false);
}

/** Bearer authentication of /mcp (keys and connector access tokens). */
export function mcpAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  return authenticate(req, res, next, true);
}

async function authenticate(req: Request, res: Response, next: NextFunction, connectors: boolean): Promise<void> {
  try {
    const h = req.headers.authorization;
    const raw = typeof h === 'string' && /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : '';
    // An OAuth access token (oba_) is never a REST credential: refused like an unknown key.
    const ctx = !raw ? null
      : raw.startsWith('oba_') ? (connectors ? await apiKeysService.verifyAccessToken(raw, clientIp(req)) : null)
        : await apiKeysService.verify(raw, clientIp(req));
    if (!ctx) {
      // RFC 9728 on /mcp only: where an OAuth client (connector) finds the
      // authorization server. /api/v1 never takes its tokens: no invitation (L17).
      const meta = connectors ? `, resource_metadata="${await resourceMetadataUrl(req)}"` : '';
      res.setHeader('WWW-Authenticate', `Bearer realm="oblimint"${meta}${raw ? ', error="invalid_token"' : ''}`);
      next(new AppError(401, 'Invalid, expired or revoked API key (Authorization: Bearer obk_…)', 'invalidKey'));
      return;
    }
    req.apiKey = ctx;
    req.tenantId = ctx.tenantId;
    setRequestActor(req, ctx.actor);
    next();
  } catch (err) {
    next(err);
  }
}
