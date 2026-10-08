import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';

import authRoutes from './auth.routes';
import twoFactorRoutes from './twoFactor.routes';
import obligateCallbackRoutes from './obligateCallback.routes';
import profileRoutes from './profile.routes';
import tenantRoutes from './tenant.routes';
import usersRoutes from './users.routes';
import permissionSetsRoutes from './permissionSets.routes';
import appConfigRoutes from './appConfig.routes';
import systemRoutes from './system.routes';
import auditRoutes from './audit.routes';
import dashboardRoutes from './dashboard.routes';
import nodesRoutes from './nodes.routes';
import { normalModeSetupRouter } from './setup.routes';

const router = Router();

// ── Public / auth ────────────────────────────────────────────────────────────
router.use('/setup', normalModeSetupRouter());     // { mode: 'normal' }, the rest 404
router.use('/auth', authRoutes);
router.use('/auth', obligateCallbackRoutes);       // sso-config, connected-apps, app-info, sso-user-sync…
router.use('/system', systemRoutes);               // platform admin, no tenant required

// ── Authenticated, no tenant required ───────────────────────────────────────
router.use('/profile/2fa', twoFactorRoutes);       // before /profile (auth handled inside)
router.use('/profile', requireAuth, profileRoutes);
router.use('/tenants', requireAuth, tenantRoutes);
router.use('/tenant', requireAuth, tenantRoutes);

// ── Authenticated + tenant scoped ────────────────────────────────────────────
const tenantRouter = Router();
tenantRouter.use(requireAuth, requireTenant);
tenantRouter.use('/users', usersRoutes);
tenantRouter.use('/permission-sets', permissionSetsRoutes);
tenantRouter.use('/admin/config', appConfigRoutes);
tenantRouter.use('/audit-log', auditRoutes);
tenantRouter.use('/audit', auditRoutes);
tenantRouter.use('/dashboard', dashboardRoutes);
tenantRouter.use('/nodes', nodesRoutes);

router.use('/', tenantRouter);

// Unknown /api path → JSON 404 (never the SPA fallback).
router.use((_req, res) => { res.status(404).json({ success: false, error: 'Not found' }); });

export { router as routes };
