import type { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// OWNED BY MODULE `hostd-firewall` (docs/P2-PLAN.md §9.4, auto-2fa, W2).
// Registered by app.ts after twoFactorPolicyGuard: on every authenticated
// request of a session that passed 2FA (req.session.mfaVerifiedAt set), hands
// the request to firewallService.onSessionActivity, which throttles (once per
// 5 min per (session, addresses)) and creates / refreshes the auto-2fa grants
// of the CLIENT's accounts in the background. Never awaited, never fails nor
// delays the request. The service is loaded lazily (app.ts stays light and
// free of import cycles with the orchestration).
// ─────────────────────────────────────────────────────────────────────────────

type FirewallHooks = { onSessionActivity(req: Request): void };
let hooks: FirewallHooks | null = null;
let loading: Promise<FirewallHooks | null> | null = null;

function load(): Promise<FirewallHooks | null> {
  if (!loading) {
    loading = import('../services/firewall/firewall.service')
      .then((m) => (hooks = m.firewallService))
      .catch((err) => {
        logger.warn({ err }, 'accessGrantTouch: firewall service unavailable');
        loading = null;
        return null;
      });
  }
  return loading;
}

export function accessGrantTouch(req: Request, _res: Response, next: NextFunction): void {
  try {
    if (req.session?.userId && req.session.mfaVerifiedAt) {
      if (hooks) hooks.onSessionActivity(req);
      else void load().then((h) => h?.onSessionActivity(req));
    }
  } catch {
    /* never fails the request */
  }
  next();
}
