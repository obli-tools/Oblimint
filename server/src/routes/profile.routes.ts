import { Router, type Request, type Response, type NextFunction } from 'express';
import { db } from '../db';
import { attachSessionTenant } from '../middleware/tenant';
import { validate } from '../middleware/validate';
import { stepUpLimiter } from '../middleware/rateLimiter';
import { AppError } from '../middleware/errorHandler';
import { comparePassword, hashPassword } from '../utils/crypto';
import { auditService } from '../services/audit.service';
import { updateProfileSchema, changePasswordSchema, type UpdateProfileInput, type ChangePasswordInput } from '../validators/profile.schema';

// /api/profile — mounted behind requireAuth (routes/index.ts). Same shapes as
// Obliance's profile.controller.ts.

const router = Router();
router.use(attachSessionTenant);

const PROFILE_COLUMNS = ['id', 'username', 'display_name', 'role', 'kind', 'is_active', 'created_at', 'updated_at',
  'preferences', 'email', 'preferred_language', 'password_hash', 'avatar', 'totp_enabled', 'foreign_source'] as const;

const normEmail = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

function buildUserResponse(row: Record<string, any>) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    kind: row.kind,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    preferences: (typeof row.preferences === 'string' ? JSON.parse(row.preferences) : row.preferences) ?? null,
    email: row.email ?? null,
    preferredLanguage: row.preferred_language ?? 'en',
    hasPassword: !!row.password_hash,
    totpEnabled: !!row.totp_enabled,
    foreignSource: row.foreign_source ?? null,
    avatar: row.avatar ?? null,
  };
}

/** Strip prototype-mutating keys before a merge. */
function sanitise(obj: unknown): Record<string, unknown> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '__proto__' || k === 'prototype' || k === 'constructor') continue;
    out[k] = v;
  }
  return out;
}

router.get('/', async (req, res, next) => {
  try {
    const row = await db('users').select(...PROFILE_COLUMNS).where({ id: req.session.userId }).first();
    if (!row) throw new AppError(404, 'User not found');
    res.json({ success: true, data: buildUserResponse(row) });
  } catch (err) { next(err); }
});

router.put('/', validate(updateProfileSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.session.userId!;
    const data = req.body as UpdateProfileInput;
    const current = await db('users').where({ id: userId }).first('email', 'foreign_source', 'preferences') as
      { email: string | null; foreign_source: string | null; preferences: unknown } | undefined;
    if (!current) throw new AppError(404, 'User not found');
    // The e-mail of an SSO account is Obligate's (resent unchanged = accepted).
    if ('email' in data && current.foreign_source === 'obligate') {
      if (normEmail(data.email) !== normEmail(current.email)) {
        res.status(403).json({
          success: false, error: 'The e-mail address of an SSO account is managed in Obligate.', code: 'ssoEmailManaged', ssoEmailManaged: true,
        });
        return;
      }
      delete data.email;
    }
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if ('displayName' in data) patch.display_name = data.displayName;
    if ('email' in data) patch.email = data.email || null;
    if ('preferredLanguage' in data) patch.preferred_language = data.preferredLanguage;
    if ('preferences' in data) {
      if (data.preferences == null) {
        patch.preferences = '{}';
      } else {
        const existing = typeof current.preferences === 'string' ? JSON.parse(current.preferences) : current.preferences;
        const json = JSON.stringify({ ...sanitise(existing), ...sanitise(data.preferences) });
        if (json.length > 100_000) throw new AppError(400, 'Preferences payload exceeds 100 KB limit');
        patch.preferences = json;
      }
    }
    let row: Record<string, unknown> | undefined;
    try {
      [row] = await db('users').where({ id: userId }).update(patch).returning([...PROFILE_COLUMNS]);
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') throw new AppError(409, 'This e-mail address is already used');
      throw err;
    }
    if ('email' in data && normEmail(data.email) !== normEmail(current.email)) {
      await auditService.logReq(req, 'user.email_changed', { resourceType: 'user', resourcePath: String(userId) });
    }
    res.json({ success: true, data: buildUserResponse(row!) });
  } catch (err) { next(err); }
});

router.put('/password', stepUpLimiter, validate(changePasswordSchema), async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body as ChangePasswordInput;
    const userId = req.session.userId!;
    const user = await db('users').where({ id: userId }).first('password_hash', 'foreign_source') as
      { password_hash: string | null; foreign_source: string | null } | undefined;
    if (!user) throw new AppError(404, 'User not found');
    if (user.foreign_source === 'obligate' || !user.password_hash) {
      throw new AppError(400, 'The password of an SSO account is managed in Obligate');
    }
    if (!(await comparePassword(currentPassword, user.password_hash))) throw new AppError(400, 'Current password is incorrect');
    await db('users').where({ id: userId }).update({ password_hash: await hashPassword(newPassword), updated_at: new Date() });
    // Every OTHER session ends (stolen cookie, session opened with the old password).
    const { revokeOtherSessions } = await import('../services/userSessions.service');
    await revokeOtherSessions(req, 'password_changed');
    await auditService.logReq(req, 'user.password_changed', { resourceType: 'user', resourcePath: String(userId) });
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) { next(err); }
});

router.put('/avatar', async (req, res, next) => {
  try {
    const avatar = (req.body as { avatar?: unknown })?.avatar;
    if (typeof avatar !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)) {
      throw new AppError(400, 'Invalid image data — must be a base64 data URI');
    }
    if (avatar.length > 500_000) throw new AppError(400, 'Image too large — max 375KB');
    await db('users').where({ id: req.session.userId }).update({ avatar, updated_at: new Date() });
    res.json({ success: true, avatar });
  } catch (err) { next(err); }
});

router.delete('/avatar', async (req, res, next) => {
  try {
    await db('users').where({ id: req.session.userId }).update({ avatar: null, updated_at: new Date() });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// "Trust this IP" does not exist in Oblimint P0: empty list, deletes are no-ops
// (kept so the Obliance profile page module works unchanged).
router.get('/trusted-ips', (_req, res) => { res.json({ data: [] }); });
router.delete('/trusted-ips', (_req, res) => { res.status(204).send(); });
router.delete('/trusted-ips/:ip', (_req, res) => { res.status(204).send(); });

export default router;
