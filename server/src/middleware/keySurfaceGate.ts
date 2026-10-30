import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ApiKeyVerifyFailure, KeySurface } from '@oblimint/shared';
import { AppError } from './errorHandler';
import { clientAddress } from '../utils/clientIp';
import { logger } from '../utils/logger';
import { keySurfaceGuard } from '../services/security/keySurfaceGuard';

// ─────────────────────────────────────────────────────────────────────────────
// Gate of the key surfaces (spec §5.5): mounted FIRST on /api/v1, /mcp and
// POST /oauth/token — before apiKeyAuthLimiter and any credential check —
// and never on /.well-known (public metadata read by claude.ai). Every
// request counts, with or without Authorization. The client address is
// clientAddress() (X-Forwarded-For only through the trusted proxies, the
// same rule as the audit / web bans); a relay address is never banned.
// A guard failure never locks anyone out: logged, the request goes on (the
// credential check still applies).
// ─────────────────────────────────────────────────────────────────────────────

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by keySurfaceGate: which surface the request reached (failures are counted on it). */
    keySurface?: KeySurface;
  }
}

export const ADDRESS_BANNED_MESSAGE = 'This address is banned';

export function keySurfaceGate(surface: KeySurface): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    req.keySurface = surface;
    let verdict;
    try {
      const addr = clientAddress(req);
      verdict = await keySurfaceGuard.gate(addr.ip, surface, { relay: addr.relay });
    } catch (err) {
      logger.warn({ err, surface }, 'key surfaces: gate unavailable, request let through to the credential check');
      next();
      return;
    }
    if (verdict.allowed) { next(); return; }
    refuseBanned(res, next, surface);
  };
}

function refuseBanned(res: Response, next: NextFunction, surface: KeySurface): void {
  if (surface === 'oauth-token') {
    res.setHeader('Cache-Control', 'no-store');
    res.status(403).json({ error: 'access_denied', error_description: ADDRESS_BANNED_MESSAGE });
    return;
  }
  next(new AppError(403, ADDRESS_BANNED_MESSAGE, 'addressBanned'));
}

/**
 * A request carrying credentials was refused on a key surface: counted
 * (keySurfaceGuard.recordFailure). true when the address is now banned —
 * the caller answers 403 addressBanned instead of its 401. Never throws.
 */
export async function recordKeySurfaceFailure(req: Request, fallback: KeySurface, reason: ApiKeyVerifyFailure | string): Promise<boolean> {
  try {
    const addr = clientAddress(req);
    const r = await keySurfaceGuard.recordFailure(addr.ip, req.keySurface ?? fallback, reason, { relay: addr.relay });
    return r.banned;
  } catch (err) {
    logger.warn({ err }, 'key surfaces: failure not recorded');
    return false;
  }
}

/** next() with the 403 addressBanned (or the OAuth form on /oauth/token). */
export function answerBanned(res: Response, next: NextFunction, surface: KeySurface): void {
  refuseBanned(res, next, surface);
}
