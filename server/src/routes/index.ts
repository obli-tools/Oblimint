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
import { requireRole } from '../middleware/rbac';
// P1 — hosting core (docs/P1-PLAN.md §API). One router file per owning module.
import hostingMeRoutes from './hostingMe.routes';        // hosting-api
import plansRoutes from './plans.routes';                // hosting-api
import accountsRoutes from './accounts.routes';          // hosting-api
import sitesRoutes from './sites.routes';                // hosting-api
import domainsRoutes from './domains.routes';            // hosting-api
import releasesRoutes from './releases.routes';          // releases
import runtimeRoutes from './runtime.routes';            // orchestration
import fileServerRoutes from './filesrv.routes';         // orchestration
import infraRoutes from './infra.routes';                // orchestration
import edgeRoutes from './edge.routes';                  // edge
import certificatesRoutes from './certificates.routes';  // edge

const router = Router();

// ── Public / auth ────────────────────────────────────────────────────────────
router.use('/setup', normalModeSetupRouter());     // { mode: 'normal' }, the rest 404
router.use('/auth', authRoutes);
router.use('/auth', obligateCallbackRoutes);       // sso-config, connected-apps, app-info, sso-user-sync…
router.use('/system/infra', requireAuth, requireRole('admin'), infraRoutes); // P1 orchestration
router.use('/system/edge', requireAuth, requireRole('admin'), edgeRoutes);   // P1 edge
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
// P1 hosting core. Several routers share a prefix: the first ones must not
// end with a catch-all (unmatched paths fall through to the next router).
tenantRouter.use('/hosting', hostingMeRoutes);
tenantRouter.use('/plans', plansRoutes);
tenantRouter.use('/accounts', accountsRoutes);
tenantRouter.use('/accounts', fileServerRoutes);
tenantRouter.use('/sites', sitesRoutes);
tenantRouter.use('/sites', releasesRoutes);
tenantRouter.use('/sites', runtimeRoutes);
tenantRouter.use('/domains', domainsRoutes);
tenantRouter.use('/domains', certificatesRoutes);

router.use('/', tenantRouter);

// Unknown /api path → JSON 404 (never the SPA fallback).
router.use((_req, res) => { res.status(404).json({ success: false, error: 'Not found' }); });

export { router as routes };
