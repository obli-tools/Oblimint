import type { Request } from 'express';
import { db } from '../db';
import { getIO } from '../socket';
import { logger } from '../utils/logger';
import { forgetSessionUser } from '../middleware/sessionUserGuard';
import { forgetTenantMemberships } from '../middleware/tenant';
import { sessionRoom } from '../utils/sessionHash';
import { stampCredentialVersion } from '../utils/session';

/**
 * Session kill-switch for one user (Obliance P6): deletes the user's rows of
 * the connect-pg-simple `session` table (signed-in AND pending 2FA), drops the
 * guard caches and disconnects the user's sockets. sessionUserGuard kills a
 * row resurrected by a request in flight on its next use.
 */
export async function killSessionsForUser(userId: number, reason: string): Promise<number> {
  if (!Number.isInteger(userId) || userId <= 0) return 0;
  const uid = String(userId);
  const res = await db.raw(
    `DELETE FROM session
      WHERE (sess::jsonb ->> 'userId') = ?
         OR (sess::jsonb ->> 'pendingMfaUserId') = ?`,
    [uid, uid],
  ) as { rowCount?: number } | undefined;
  const count = Number(res?.rowCount ?? 0);
  forgetSessionUser(userId);
  forgetTenantMemberships(userId);
  try {
    getIO()?.in(`user:${userId}`).disconnectSockets(true);
  } catch { /* Socket.io not initialised */ }
  logger.info({ userId, reason, count }, 'user sessions killed');
  return count;
}

/**
 * After a user changed one of its OWN credentials (password, TOTP): ends
 * every other session of that user (rows + sockets) and re-stamps the
 * current one with the new credential_version, so it stays signed in while
 * a stolen cookie or a session opened with the old password does not.
 */
export async function revokeOtherSessions(req: Request, reason: string): Promise<number> {
  const userId = Number(req.session?.userId);
  if (!Number.isInteger(userId) || userId <= 0) return 0;
  const uid = String(userId);
  const res = await db.raw(
    `DELETE FROM session
      WHERE sid <> ?
        AND ((sess::jsonb ->> 'userId') = ? OR (sess::jsonb ->> 'pendingMfaUserId') = ?)`,
    [req.sessionID, uid, uid],
  ) as { rowCount?: number } | undefined;
  const count = Number(res?.rowCount ?? 0);
  await stampCredentialVersion(req);
  try {
    const keep = typeof req.sessionID === 'string' && req.sessionID ? sessionRoom(req.sessionID) : null;
    const target = getIO()?.in(`user:${userId}`);
    if (target) (keep ? target.except(keep) : target).disconnectSockets(true);
  } catch { /* Socket.io not initialised */ }
  logger.info({ userId, reason, count }, 'other sessions of the user revoked');
  return count;
}
