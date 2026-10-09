import type { Request } from 'express';

/**
 * Issues a NEW session id before a session gains privileges (login, 2FA
 * completion, SSO callback), so an id planted in the victim's browser before
 * sign-in (session fixation) never becomes authenticated. [keep] lists the
 * pre-login fields to carry over (e.g. a pending MFA user, a requested tenant).
 */
export function regenerateSession(req: Request, keep: string[] = []): Promise<void> {
  const session = req.session as unknown as Record<string, unknown>;
  const carried: Record<string, unknown> = {};
  for (const key of keep) {
    if (session[key] !== undefined) carried[key] = session[key];
  }
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) { reject(err); return; }
      Object.assign(req.session as unknown as Record<string, unknown>, carried);
      resolve();
    });
  });
}

/**
 * Stamps users.credential_version on a session that just signed in (password,
 * password + TOTP, SSO) or whose own user just changed a credential:
 * sessionUserGuard ends every session whose stamp differs from the database —
 * a password / TOTP change, an admin 2FA reset or a disable revokes the
 * OTHER sessions (stolen cookie, session opened with a phished password).
 */
export async function stampCredentialVersion(req: Request): Promise<void> {
  const userId = Number(req.session?.userId);
  if (!Number.isInteger(userId) || userId <= 0) return;
  const { db } = await import('../db');
  const { forgetSessionUser } = await import('../middleware/sessionUserGuard');
  forgetSessionUser(userId);
  const row = await db('users').where({ id: userId }).first('credential_version') as { credential_version: number | string | null } | undefined;
  if (row) req.session.credVersion = Number(row.credential_version ?? 0);
}
