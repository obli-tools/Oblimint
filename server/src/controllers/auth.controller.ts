import type { Request, Response, NextFunction } from 'express';
import { MASTER_TENANT_ID } from '@oblimint/shared';
import { regenerateSession, stampCredentialVersion } from '../utils/session';
import { clientIp } from '../utils/clientIp';
import { authService } from '../services/auth.service';
import { appConfigService } from '../services/appConfig.service';
import { permissionService } from '../services/permission.service';
import { tenantService, noTenantAccessError, refuseSignInWithoutTenant } from '../services/tenant.service';
import { obligateService } from '../services/obligate.service';
import { auditService } from '../services/audit.service';
import { AppError } from '../middleware/errorHandler';
import { config, SESSION_COOKIE_NAME, sessionCookieSecure } from '../config';
import { db } from '../db';
import type { LoginInput } from '../validators/auth.schema';
import { panelHostRefusal, requestPanelRole } from '../services/panelHosts';

export const authController = {
  /** POST /api/auth/login → { user } or { requires2fa: true, methods: { totp, email:false } }. */
  async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { username, password } = req.body as LoginInput;
      const user = await authService.authenticate(username, password);
      if (!user) throw new AppError(401, 'Invalid username or password');

      // SSO account (og_): a local password alone never opens a session —
      // only with a LOCAL TOTP (then required). Checked once the password is
      // proven (no enumeration).
      if (user.foreignSource === 'obligate' && !user.totpEnabled) {
        const tenant = await tenantService.getFirstTenantForUser(user.id);
        await auditService.log({
          tenantId: tenant?.id ?? MASTER_TENANT_ID,
          userId: user.id,
          action: 'auth.login_refused',
          resourceType: 'user',
          resourcePath: String(user.id),
          details: { username: user.username, reason: 'sso_login_required', via: 'password' },
          ipAddress: clientIp(req) || undefined,
        });
        res.status(403).json({
          success: false,
          error: 'This account signs in through Obligate (SSO).',
          code: 'ssoLoginRequired',
          ssoLoginRequired: true,
        });
        return;
      }

      // Client space (client_panel_hostname): clients only there, and not on
      // the panel host. Checked once the password is proven (no enumeration).
      const { role: hostRole, hosts } = await requestPanelRole(req);
      const wrongHost = panelHostRefusal(hostRole, user.kind, hosts);
      if (wrongHost) {
        const tenant = await tenantService.getFirstTenantForUser(user.id);
        await auditService.log({
          tenantId: tenant?.id ?? MASTER_TENANT_ID,
          userId: user.id,
          action: 'auth.login_refused',
          resourceType: 'user',
          resourcePath: String(user.id),
          details: { username: user.username, reason: 'wrong_panel_host', via: 'password', host: hostRole },
          ipAddress: clientIp(req) || undefined,
        });
        res.status(403).json({
          success: false,
          error: wrongHost.expected === 'client' ? 'Clients sign in on the client space' : 'This address is the client space: sign in on the panel',
          code: 'wrongPanelHost',
          url: wrongHost.url,
          expected: wrongHost.expected,
        });
        return;
      }

      // New session id once the password is proven (session fixation).
      await regenerateSession(req);

      if (user.totpEnabled) {
        req.session.pendingMfaUserId = user.id;
        res.json({ success: true, data: { requires2fa: true, methods: { totp: true, email: false } } });
        return;
      }

      const sessionTenantId = await tenantService.sessionTenantFor(user.id, user.role);
      if (sessionTenantId === null) throw await refuseSignInWithoutTenant(req, user, 'password');
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role;
      req.session.currentTenantId = sessionTenantId;
      await stampCredentialVersion(req);

      await auditService.log({
        tenantId: sessionTenantId,
        userId: user.id,
        action: 'auth.login',
        resourceType: 'user',
        resourcePath: String(user.id),
        details: { username: user.username, via: 'password' },
        ipAddress: clientIp(req) || undefined,
      });
      res.json({ success: true, data: { user } });
    } catch (err) {
      next(err);
    }
  },

  async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId;
      const tenantId = req.session.currentTenantId;
      const ip = clientIp(req) || undefined;
      req.session.destroy(async (err) => {
        if (err) { next(new AppError(500, 'Failed to logout')); return; }
        // Same attributes as the cookie (a __Host- cookie is only replaced by a Secure one).
        res.clearCookie(SESSION_COOKIE_NAME, { path: '/', secure: sessionCookieSecure, httpOnly: true, sameSite: 'lax' });
        if (userId && tenantId) {
          await auditService.log({ tenantId, userId, action: 'auth.logout', resourceType: 'user', resourcePath: String(userId), ipAddress: ip });
        }
        res.json({ success: true, message: 'Logged out' });
      });
    } catch (err) {
      next(err);
    }
  },

  /** GET /api/auth/me → { user, permissions, requires2faSetup, currentTenantId }. */
  async me(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId!;
      const fRow = await db('users').where({ id: userId }).first('foreign_source', 'foreign_id') as
        { foreign_source: string | null; foreign_id: number | null } | undefined;
      if (fRow?.foreign_source === 'obligate' && fRow.foreign_id) {
        await obligateService.syncUserPreferences(userId, fRow.foreign_id).catch(() => {});
      }
      const user = await authService.getUserById(userId);
      if (!user) throw new AppError(401, 'User not found');

      // Repair a missing / stale session tenant (never the master tenant for
      // an account that is not a member of it — E3).
      const current = Number(req.session.currentTenantId);
      const stale = !Number.isInteger(current) || current <= 0
        || !(await db('tenants').where({ id: current }).first('id'))
        || (user.role !== 'admin' && !(await db('user_tenants').where({ user_id: user.id, tenant_id: current }).first('user_id')));
      if (stale) {
        const sessionTenantId = await tenantService.sessionTenantFor(user.id, user.role);
        if (sessionTenantId === null) {
          await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
          throw noTenantAccessError();
        }
        req.session.currentTenantId = sessionTenantId;
      }

      const permissions = await permissionService.getUserPermissions(user.id, user.role === 'admin', req.session.currentTenantId);
      let requires2faSetup = false;
      if (!config.disable2faForce && user.foreignSource !== 'obligate') {
        const cfg = await appConfigService.getAll();
        if (cfg.force_2fa === 'true' && !user.totpEnabled) requires2faSetup = true;
      }
      res.json({ success: true, data: { user, permissions, requires2faSetup, currentTenantId: req.session.currentTenantId } });
    } catch (err) {
      next(err);
    }
  },

  async permissions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await permissionService.getUserPermissions(req.session.userId!, req.session.role === 'admin', req.session.currentTenantId);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },
};
