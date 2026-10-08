import type { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';

// Extend express-session types
declare module 'express-session' {
  interface SessionData {
    userId: number;
    username: string;
    role: string;
    currentTenantId: number;
    oauthState: string;
    /** Exact redirect_uri of the pending Obligate authorize request. */
    oauthRedirectUri?: string;
    /** Cross-app tenant handoff (?tenant=<slug> on /auth/sso-redirect). */
    requestedTenantSlug?: string;
    // Sign-in second factor / TOTP setup (twoFactor.controller.ts)
    pendingMfaUserId?: number;
    pendingTotpSecret?: string;
    pendingTotpExpiresAt?: number;
    pendingTotpReplaces?: boolean;
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    next(new AppError(401, 'Authentication required'));
    return;
  }
  next();
}
