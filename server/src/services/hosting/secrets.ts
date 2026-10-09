import crypto from 'crypto';
import { config } from '../../config';

/**
 * Per-account token of the file-server hooks (SFTPGo external auth + action
 * hooks call http://oblimint-panel:<internalPort>/internal/filesrv/<accountId>/<token>/…).
 * Derived, never stored: HMAC-SHA256(sessionSecret, 'oblimint-filesrv-hook:<accountId>'),
 * base64url. Rotating SESSION_SECRET rotates every token (the reconcile then
 * recreates the file servers: the token is part of their spec).
 */
export function fileServerHookToken(accountId: number): string {
  return crypto.createHmac('sha256', config.sessionSecret || 'oblimint-dev').update(`oblimint-filesrv-hook:${accountId}`).digest('base64url');
}

/** Constant-time check of a hook token. */
export function verifyFileServerHookToken(accountId: number, token: unknown): boolean {
  if (typeof token !== 'string' || !Number.isInteger(accountId) || accountId <= 0) return false;
  const expected = Buffer.from(fileServerHookToken(accountId));
  const given = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
