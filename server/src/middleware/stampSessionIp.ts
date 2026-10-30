import type { NextFunction, Request, Response } from 'express';
import { clientAddress } from '../utils/clientIp';

// Spec §5.4-4: the address of a signed-in session is kept in the session
// (req.session.ip), so that the key surfaces' guard never bans the address an
// open platform-administrator session works from (keySurfaceGuard
// loadAdminSessionIps). Mounted in app.ts after sessionUserGuard. Written only
// when it changes (express-session saves a modified session); a relay
// address (one of our proxies, a forwarder shared by many clients) is never
// stamped. Grants nothing: a valid key is still required on the key surfaces.

declare module 'express-session' {
  interface SessionData {
    /** Last client address of the signed-in session (stampSessionIp). */
    ip?: string;
  }
}

export function stampSessionIp(req: Request, _res: Response, next: NextFunction): void {
  try {
    if (req.session?.userId) {
      const addr = clientAddress(req);
      if (addr.ip && !addr.relay && req.session.ip !== addr.ip) req.session.ip = addr.ip.slice(0, 64);
    }
  } catch { /* never blocks a request */ }
  next();
}
