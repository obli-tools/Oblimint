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
// P2 — hosting complete (docs/P2-PLAN.md §6). One router file per owning module.
import hostingSettingsRoutes from './hostingSettings.routes'; // architect (platform settings)
import dnsRoutes from './dns.routes';                          // dns
import systemDnsRoutes from './systemDns.routes';              // dns
import domainOwnershipRoutes from './domainOwnership.routes';  // edge-ownership
import databasesRoutes from './databases.routes';              // databases
import { accountAccessRoutes, accessRoutes, systemFirewallRoutes } from './firewall.routes'; // hostd-firewall
import ipProbeRoutes from './ipProbe.routes';                  // hostd-firewall (public)
import usageRoutes from './usage.routes';                      // usage
import notificationsRoutes from './notifications.routes';      // usage
import cronRoutes from './cron.routes';                        // cron-logs
import logsRoutes from './logs.routes';                        // cron-logs
// P3 — updates and modification windows (docs/P3-PLAN.md §6). One router file per owning module.
import windowsRoutes from './windows.routes';                  // windows (/sites/:id/maintenance|windows|tokens)
import maintenanceRoutes from './maintenance.routes';          // windows (/maintenance/windows overview)
import siteApiRoutes from './siteApi.routes';                  // windows (public, Bearer site token)
import snapshotsRoutes from './snapshots.routes';              // checksums-snapshots
import adaptersRoutes from './adapters.routes';                // adapters
import quarantineRoutes from './quarantine.routes';            // supervised-quarantine
import supervisionRoutes from './supervision.routes';          // supervised-quarantine
import scannerRoutes from './scanner.routes';                  // scanners (platform admin)

const router = Router();

// ── Public / auth ────────────────────────────────────────────────────────────
router.use('/setup', normalModeSetupRouter());     // { mode: 'normal' }, the rest 404
router.use('/auth', authRoutes);
router.use('/auth', obligateCallbackRoutes);       // sso-config, connected-apps, app-info, sso-user-sync…
router.use('/ip-probe', ipProbeRoutes);            // P2 hostd-firewall: public IP probe (v4-only / v6-only hosts)
router.use('/system/infra', requireAuth, requireRole('admin'), infraRoutes); // P1 orchestration
router.use('/system/edge', requireAuth, requireRole('admin'), edgeRoutes);   // P1 edge
router.use('/system/hosting-settings', requireAuth, requireRole('admin'), hostingSettingsRoutes); // P2 architect
router.use('/system/dns', requireAuth, requireRole('admin'), systemDnsRoutes);           // P2 dns
router.use('/system/firewall', requireAuth, requireRole('admin'), systemFirewallRoutes); // P2 hostd-firewall
router.use('/system/scanner', requireAuth, requireRole('admin'), scannerRoutes);         // P3 scanners
router.use('/site-api', siteApiRoutes);            // P3 windows: Bearer site token (no session)
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
tenantRouter.use('/domains', domainOwnershipRoutes);  // P2: BEFORE domainsRoutes (/claims vs /:id)
tenantRouter.use('/domains', domainsRoutes);
tenantRouter.use('/domains', certificatesRoutes);
// P2 hosting complete. Shared prefixes: no catch-all in any of these routers.
tenantRouter.use('/accounts', accountAccessRoutes);     // /:id/access…
tenantRouter.use('/access', accessRoutes);
tenantRouter.use('/sites', cronRoutes);                 // /:id/cron…
tenantRouter.use('/sites', logsRoutes);                 // /:id/logs…
tenantRouter.use('/dns', dnsRoutes);
tenantRouter.use('/databases', databasesRoutes);
tenantRouter.use('/usage', usageRoutes);
tenantRouter.use('/notifications', notificationsRoutes);
// P3 updates / windows. Shared /sites prefix: no catch-all in any of these routers.
tenantRouter.use('/sites', windowsRoutes);              // /:id/maintenance, /:id/windows…, /:id/tokens…
tenantRouter.use('/sites', snapshotsRoutes);            // /:id/snapshots…
tenantRouter.use('/sites', adaptersRoutes);             // /:id/adapters…
tenantRouter.use('/sites', supervisionRoutes);          // /:id/supervision…
tenantRouter.use('/maintenance', maintenanceRoutes);
tenantRouter.use('/quarantine', quarantineRoutes);

router.use('/', tenantRouter);

// Unknown /api path → JSON 404 (never the SPA fallback).
router.use((_req, res) => { res.status(404).json({ success: false, error: 'Not found' }); });

export { router as routes };
