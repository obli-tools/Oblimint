import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { AppError } from '../../middleware/errorHandler';
import { ipKey } from '../../middleware/rateLimiter';
import { clientIp } from '../../utils/clientIp';
import { setRequestActor } from '../hosting/access';
import { apiKeysService } from './apiKeys.service';
import { resourceMetadataUrl } from './oauth';

// Bearer authentication of /api/v1 and /mcp (API keys, shared/src/apiKeys.ts):
// obk_… keys, and oba_… OAuth access tokens of the connectors (oauth.ts).
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

/** Per key, after authentication: 1 200 requests / min (uploads included). */
export const apiKeyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `apikey:${req.apiKey?.id ?? ipKey(clientIp(req))}`,
  message: { success: false, error: 'Too many requests for this API key, slow down', code: 'rateLimited' },
});

export async function apiKeyAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const h = req.headers.authorization;
    const raw = typeof h === 'string' && /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : '';
    const ctx = !raw ? null
      : raw.startsWith('oba_') ? await apiKeysService.verifyAccessToken(raw, clientIp(req))
        : await apiKeysService.verify(raw, clientIp(req));
    if (!ctx) {
      // RFC 9728: where an OAuth client (connector) finds the authorization server.
      res.setHeader('WWW-Authenticate', `Bearer realm="oblimint", resource_metadata="${await resourceMetadataUrl(req)}"${raw ? ', error="invalid_token"' : ''}`);
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
