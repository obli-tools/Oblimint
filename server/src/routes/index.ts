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
import { requirePlatformAdminOnMaster, requireRole } from '../middleware/rbac';
// P1 — hosting core (docs/P1-PLAN.md §API). One router file per owning module.
import hostingMeRoutes from './hostingMe.routes';        // hosting-api
import plansRoutes from './plans.routes';                // hosting-api
import accountsRoutes from './accounts.routes';          // hosting-api
import sitesRoutes from './sites.routes';                // hosting-api
import domainsRoutes from './domains.routes';            // hosting-api
import releasesRoutes from './releases.routes';          // releases
import runtimeRoutes from './runtime.routes';            // orchestration
import fileServerRoutes from './filesrv.routes';         // orchestration
import filesRoutes from './files.routes';                // web file explorer
import v1Routes from './v1.routes';                      // API access keys (/api/v1)
import siteEnvRoutes from './siteEnv.routes';            // site environment variables
import previewsRoutes from './previews.routes';          // release / staging previews (feature B)
import { accountBackupsRouter, systemBackupsRouter } from './backups.routes'; // external backups
import apiKeysRoutes from './apiKeys.routes';            // API access keys (management)
import { oauthApiRouter } from '../services/apiKeys/oauth'; // Claude connectors: OAuth consent
import infraRoutes from './infra.routes';                // orchestration
import platformUpdatesRoutes from './platformUpdates.routes';  // platform updates (Nodes > Updates)
import edgeRoutes from './edge.routes';                  // edge
import certificatesRoutes from './certificates.routes';  // edge
// P2 — hosting complete (docs/P2-PLAN.md §6). One router file per owning module.
import hostingSettingsRoutes from './hostingSettings.routes'; // architect (platform settings)
import dnsRoutes from './dns.routes';                          // dns
import systemDnsRoutes from './systemDns.routes';              // dns
import domainOwnershipRoutes from './domainOwnership.routes';  // edge-ownership
import databasesRoutes from './databases.routes';              // databases
import dbExplorerRoutes from './dbExplorer.routes';            // integrated database explorer
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
// P4 — mail (docs/P4-PLAN.md §6). One router file per owning module.
import mailRoutes from './mail.routes';                        // mail-core (/mail: overview, domains, mailboxes, aliases)
import systemMailRoutes from './systemMail.routes';            // mail-core (platform admin: engine status / sync / change)
import mailDnsRoutes from './mailDns.routes';                  // mail-dns-tls (/mail/domains/:id/dns|dns-settings|dkim)
import mailOutboundRoutes, { siteMailRelayRoutes } from './mailOutbound.routes'; // outbound-security
import systemMailSecurityRoutes from './systemMailSecurity.routes'; // outbound-security (platform admin: bans, relay test)
import systemTransactionalMailRoutes from './systemTransactionalMail.routes'; // transactional e-mail sender (platform admin)
import webmailRoutes from './webmail.routes';                  // webmail (/mail/mailboxes/:id/webmail-session)
// P4b — apps + proxy (docs/P4b-PLAN.md §6). One router file per owning module.
import appsRoutes from './apps.routes';                         // apps-core (/apps: stacks, catalog, registries, policy)
import networkRoutes, { systemNetworkRoutes } from './network.routes'; // segmentation (/network, /system/network)
import proxyRoutes from './proxy.routes';                       // proxy-hosts (/proxy)
import edgeUnitsRoutes, { systemEdgeUnitsRoutes } from './edgeUnits.routes'; // edge-robustness (/edge, /system/edge)
import bansRoutes from './bans.routes';                         // honeypot-bans (/bans)
import monitoringRoutes from './monitoring.routes';             // monitoring-automation (/monitoring)
import uptimeRoutes from './uptime.routes';                     // monitoring-automation (/uptime)
import automationRoutes from './automation.routes';             // monitoring-automation (/automation)
import publicStatusRoutes from './publicStatus.routes';         // monitoring-automation (/public, no session)
// P5 — CWP migration (docs/P5-PLAN.md §6). Platform admin on the master tenant; one router file per owning module,
// all on the shared prefix /system/migration (no catch-all in any of them).
import migrationSourcesRoutes from './migrationSources.routes';     // source-executor (sources, host key, command log, allow-list)
import migrationDiscoveryRoutes from './migrationDiscovery.routes'; // discovery
import migrationPlansRoutes from './migrationPlans.routes';         // planner (targets, plans, choices, dry-run)
import migrationRunsRoutes from './migrationRuns.routes';           // executor-web-db (runs, events, reports)
import migrationCutoverRoutes from './migrationCutover.routes';     // executor-mail-dns (cutover checklist)

// Case-sensitive (H1, app.ts): /api/SITES is not /api/sites.
const router = Router({ caseSensitive: true });

// ── Public / auth ────────────────────────────────────────────────────────────
router.use('/setup', normalModeSetupRouter());     // { mode: 'normal' }, the rest 404
router.use('/auth', authRoutes);
router.use('/auth', obligateCallbackRoutes);       // sso-config, connected-apps, app-info, sso-user-sync…
router.use('/ip-probe', ipProbeRoutes);            // P2 hostd-firewall: public IP probe (v4-only / v6-only hosts)
router.use('/system/infra', requireAuth, requireRole('admin'), infraRoutes); // P1 orchestration
router.use('/system/updates', requireAuth, requirePlatformAdminOnMaster, platformUpdatesRoutes); // platform updates
router.use('/system/edge', requireAuth, requireRole('admin'), edgeRoutes);   // P1 edge
router.use('/system/edge', requireAuth, requireRole('admin'), systemEdgeUnitsRoutes); // P4b edge-robustness (units, applies, rollback)
router.use('/system/network', requireAuth, requireRole('admin'), systemNetworkRoutes); // P4b segmentation
router.use('/system/hosting-settings', requireAuth, requireRole('admin'), hostingSettingsRoutes); // P2 architect
router.use('/system/backups', requireAuth, requireRole('admin'), systemBackupsRouter);  // external backups
router.use('/system/dns', requireAuth, requireRole('admin'), systemDnsRoutes);           // P2 dns
router.use('/system/firewall', requireAuth, requireRole('admin'), systemFirewallRoutes); // P2 hostd-firewall
router.use('/system/scanner', requireAuth, requireRole('admin'), scannerRoutes);         // P3 scanners
router.use('/system/mail', requireAuth, requireRole('admin'), systemMailRoutes);         // P4 mail-core (no catch-all)
router.use('/system/mail', requireAuth, requireRole('admin'), systemMailSecurityRoutes); // P4 outbound-security
router.use('/system/transactional-mail', requireAuth, requirePlatformAdminOnMaster, systemTransactionalMailRoutes); // transactional e-mail sender
for (const migrationRouter of [migrationSourcesRoutes, migrationDiscoveryRoutes, migrationPlansRoutes, migrationRunsRoutes, migrationCutoverRoutes]) {
  router.use('/system/migration', requireAuth, requirePlatformAdminOnMaster, migrationRouter); // P5
}
router.use('/site-api', siteApiRoutes);            // P3 windows: Bearer site token (no session)
router.use('/v1', v1Routes);                        // API access keys: Bearer obk_ (no session)
router.use('/public', publicStatusRoutes);         // P4b monitoring-automation: public status pages (no session)
router.use('/system', systemRoutes);               // platform admin, no tenant required

// ── Authenticated, no tenant required ───────────────────────────────────────
router.use('/profile/2fa', twoFactorRoutes);       // before /profile (auth handled inside)
router.use('/profile', requireAuth, profileRoutes);
router.use('/oauth', requireAuth, oauthApiRouter);  // consent page of the Claude connectors (services/apiKeys/oauth.ts)
router.use('/tenants', requireAuth, tenantRoutes);
router.use('/tenant', requireAuth, tenantRoutes);

// ── Authenticated + tenant scoped ────────────────────────────────────────────
const tenantRouter = Router({ caseSensitive: true });
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
tenantRouter.use('/accounts', filesRoutes);              // web file explorer
tenantRouter.use('/accounts', apiKeysRoutes);            // API access keys
tenantRouter.use('/accounts', accountBackupsRouter);      // /:id/backups…
tenantRouter.use('/sites', sitesRoutes);
tenantRouter.use('/sites', releasesRoutes);
tenantRouter.use('/sites', runtimeRoutes);
tenantRouter.use('/sites', siteEnvRoutes);              // /:id/env
tenantRouter.use('/sites', previewsRoutes);             // /:id/preview… (feature B: release / staging previews)
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
tenantRouter.use('/databases', dbExplorerRoutes);          // integrated database explorer
tenantRouter.use('/usage', usageRoutes);
tenantRouter.use('/notifications', notificationsRoutes);
// P3 updates / windows. Shared /sites prefix: no catch-all in any of these routers.
tenantRouter.use('/sites', windowsRoutes);              // /:id/maintenance, /:id/windows…, /:id/tokens…
tenantRouter.use('/sites', snapshotsRoutes);            // /:id/snapshots…
tenantRouter.use('/sites', adaptersRoutes);             // /:id/adapters…
tenantRouter.use('/sites', supervisionRoutes);          // /:id/supervision…
tenantRouter.use('/maintenance', maintenanceRoutes);
tenantRouter.use('/quarantine', quarantineRoutes);
// P4 mail. Shared /mail and /sites prefixes: no catch-all in any of these routers.
tenantRouter.use('/mail', mailRoutes);
tenantRouter.use('/mail', mailDnsRoutes);
tenantRouter.use('/mail', mailOutboundRoutes);
tenantRouter.use('/mail', webmailRoutes);
tenantRouter.use('/sites', siteMailRelayRoutes);        // /:id/mail-relay…
// P4b apps + proxy. Each prefix has a single router (no shared prefix).
tenantRouter.use('/apps', appsRoutes);
tenantRouter.use('/network', networkRoutes);
tenantRouter.use('/proxy', proxyRoutes);
tenantRouter.use('/edge', edgeUnitsRoutes);
tenantRouter.use('/bans', bansRoutes);
tenantRouter.use('/monitoring', monitoringRoutes);
tenantRouter.use('/uptime', uptimeRoutes);
tenantRouter.use('/automation', automationRoutes);

router.use('/', tenantRouter);

// Unknown /api path → JSON 404 (never the SPA fallback).
router.use((_req, res) => { res.status(404).json({ success: false, error: 'Not found' }); });

export { router as routes };
