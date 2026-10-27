import type { Request, Response, NextFunction } from 'express';
import { performance } from 'node:perf_hooks';
import { db } from '../db';
import { config } from '../config';
import { panelHostRefusal, requestPanelRole } from '../services/panelHosts';

// P6 (docs/mobile/device-bound-2fa.md §6.0) — the session's user is re-read.
//
// killSessionsForUser (services/userSessions.service.ts) deletes the session
// rows of a disabled / deleted / demoted user, but a request of that user
// already in flight loaded its session BEFORE the delete; when it ends,
// express-session saves it again (connect-pg-simple `set` is an upsert) and
// the row is back with `userId` and `role` intact. Deleting rows is therefore
// not enough on its own.
//
// Mounted in app.ts after the session middleware, before every router: for a
// signed-in session, the user's `is_active`, `role`, `credential_version` and
// second factor are read (cached a few seconds, dropped by
// killSessionsForUser / forgetSessionUser):
//   - missing or inactive user → the session is regenerated (old row deleted,
//     the request continues anonymous: requireAuth answers 401);
//   - credential_version differs from the one stamped at sign-in
//     (utils/session.ts stampCredentialVersion) → same: a password / TOTP
//     change, an admin 2FA reset or a disable ends every OTHER session, even
//     one resurrected by a request in flight (migration 001 trigger bumps the
//     version);
//   - role changed → session.role follows the database (a demoted admin loses
//     the admin bypasses on the next request, whatever resurrected the row);
//   - client space (services/panelHosts.ts): a session of a user the host
//     refuses (a client on the panel host, staff on the client space) is
//     regenerated the same way — the login page then explains where to go.
//
// twoFactorPolicyGuard (same file) enforces force_2fa SERVER-side: a local
// account without TOTP only reaches the 2FA setup routes until it enrolls.

const TTL_MS = 5_000;
const MAX_ENTRIES = 10_000;

type UserState = {
  active: boolean;
  role: string;
  credVersion: number;
  /** A local TOTP is enabled. */
  totp: boolean;
  /** Obligate (SSO) account: its second factor is Obligate's. */
  sso: boolean;
  /** users.kind: 'client' | 'staff'. */
  kind: string;
} | null;
const cache = new Map<number, { at: number; state: UserState }>();

/** Drops the cached state of a user (called by killSessionsForUser and after a credential change). */
export function forgetSessionUser(userId: number): void {
  cache.delete(userId);
}

async function stateOf(userId: number): Promise<UserState> {
  const now = performance.now();
  const hit = cache.get(userId);
  if (hit && now - hit.at < TTL_MS) return hit.state;
  const row = await db('users').where({ id: userId })
    .first('is_active', 'role', 'credential_version', 'totp_enabled', 'totp_secret', 'foreign_source', 'kind') as {
      is_active: boolean; role: string; credential_version: number | string | null; totp_enabled: boolean;
      totp_secret: string | null; foreign_source: string | null; kind: string | null;
    } | undefined;
  const state: UserState = row
    ? {
        active: row.is_active !== false,
        role: String(row.role),
        credVersion: Number(row.credential_version ?? 0),
        totp: !!(row.totp_enabled && row.totp_secret),
        sso: row.foreign_source === 'obligate',
        kind: row.kind === 'client' ? 'client' : 'staff',
      }
    : null;
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(userId, { at: now, state });
  return state;
}

/** Current credential_version of a user (uncached: stamped at sign-in / after a change). */
export async function currentCredentialVersion(userId: number): Promise<number | null> {
  const row = await db('users').where({ id: userId }).first('credential_version') as { credential_version: number | string | null } | undefined;
  return row ? Number(row.credential_version ?? 0) : null;
}

type SessionLike = { userId?: number; credVersion?: number } | undefined | null;

/** True when a stamped session predates a credential change of its user. */
function staleCredentials(sess: SessionLike, state: NonNullable<UserState>): boolean {
  return typeof sess?.credVersion === 'number' && sess.credVersion !== state.credVersion;
}

export async function sessionUserGuard(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const userId = Number(req.session?.userId);
  if (!Number.isInteger(userId) || userId <= 0) { next(); return; }
  try {
    const state = await stateOf(userId);
    if (!state || !state.active || staleCredentials(req.session, state)) {
      await new Promise<void>((resolve) => req.session.regenerate(() => resolve()));
      next();
      return;
    }
    const { role: hostRole, hosts } = await requestPanelRole(req);
    if (panelHostRefusal(hostRole, state.kind, hosts)) {
      await new Promise<void>((resolve) => req.session.regenerate(() => resolve()));
      next();
      return;
    }
    // Session signed in before credential_version was stamped (upgrade): adopt it.
    if (typeof req.session.credVersion !== 'number') req.session.credVersion = state.credVersion;
    if (req.session.role !== state.role) req.session.role = state.role;
    next();
  } catch (err) {
    next(err);
  }
}

// ── force_2fa (server-side) ──────────────────────────────────────────────────

let forcePolicy: { at: number; value: boolean } | null = null;

/** Drops the cached force_2fa value (PUT /admin/config/force_2fa). */
export function forgetTwoFactorPolicy(): void {
  forcePolicy = null;
}

async function force2faEnabled(): Promise<boolean> {
  if (config.disable2faForce) return false;
  const now = performance.now();
  if (forcePolicy && now - forcePolicy.at < TTL_MS) return forcePolicy.value;
  const row = await db('app_config').where({ key: 'force_2fa' }).first('value') as { value: string } | undefined;
  forcePolicy = { at: now, value: row?.value === 'true' };
  return forcePolicy.value;
}

/** force_2fa is on and this local account has no TOTP yet (SSO accounts: Obligate's policy). */
export async function twoFactorSetupRequired(userId: number): Promise<boolean> {
  const state = await stateOf(userId);
  if (!state || state.sso || state.totp) return false;
  return force2faEnabled();
}

/**
 * What a session that must enroll a TOTP may still call: the SPA shell and
 * sign-in flows (non-API paths), /api/auth/* (me, logout, SSO helpers), the
 * TOTP setup (/api/profile/2fa/*), its own profile and password, the tenant
 * list. Everything else answers 403 twoFactorSetupRequired.
 */
export function allowedDuringTwoFactorSetup(method: string, path: string): boolean {
  if (!path.startsWith('/api/')) return true;
  if (path.startsWith('/api/auth/') || path.startsWith('/api/profile/2fa/') || path.startsWith('/api/setup/')) return true;
  if (method === 'GET' && (path === '/api/profile' || path === '/api/tenants')) return true;
  if (method === 'PUT' && path === '/api/profile/password') return true;
  return false;
}

export async function twoFactorPolicyGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = Number(req.session?.userId);
  if (!Number.isInteger(userId) || userId <= 0) { next(); return; }
  try {
    if (allowedDuringTwoFactorSetup(req.method, req.path) || !(await twoFactorSetupRequired(userId))) { next(); return; }
    res.status(403).json({
      success: false,
      error: 'Two-factor authentication must be set up before using the panel',
      code: 'twoFactorSetupRequired',
      requires2faSetup: true,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * The same checks for a Socket.io handshake (no Express middleware there):
 * a refusal reason, or null when the session may open a socket.
 */
export async function sessionPolicyRefusal(sess: SessionLike): Promise<string | null> {
  const userId = Number(sess?.userId);
  if (!Number.isInteger(userId) || userId <= 0) return 'Unauthorized';
  const state = await stateOf(userId);
  if (!state || !state.active || staleCredentials(sess, state)) return 'Unauthorized';
  if (await twoFactorSetupRequired(userId)) return 'Two-factor authentication must be set up first';
  return null;
}
