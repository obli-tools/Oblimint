import { Router } from 'express';
import { MASTER_TENANT_ID, type HostingSettingsUpdate } from '@oblimint/shared';
import { validate } from '../middleware/validate';
import { auditService } from '../services/audit.service';
import { hostingSettingsUpdateSchema, platformSettings } from '../services/platformSettings';
import { logger } from '../utils/logger';

// /api/system/hosting-settings — P2 platform settings (docs/P2-PLAN.md §Réglages).
// ARCHITECT FILE. Platform admin only (mounted behind requireAuth + requireRole('admin')).
//   GET /  → HostingSettings
//   PUT /  HostingSettingsUpdate → HostingSettings
// A change of dns / preview / dbAdmin / access settings is announced to the
// owning modules through settingsChanged() (lazy imports, never throws).

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await platformSettings.get() });
  } catch (err) { next(err); }
});

router.put('/', validate(hostingSettingsUpdateSchema), async (req, res, next) => {
  try {
    const patch = req.body as HostingSettingsUpdate;
    const data = await platformSettings.update(patch);
    await auditService.logReqAs(req, MASTER_TENANT_ID, 'settings.hosting', {
      resourceType: 'settings', resourcePath: 'hosting', details: { sections: Object.keys(patch) },
    });
    void settingsChanged(Object.keys(patch));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

/** Lets the modules react to a settings change (edge resync, DNS resync, firewall resync). */
async function settingsChanged(sections: string[]): Promise<void> {
  try {
    if (sections.some((s) => s === 'preview' || s === 'dbAdmin' || s === 'access')) {
      const { edgeService } = await import('../services/edge/edge.service');
      edgeService.scheduleSync('hosting-settings');
    }
    // preview / dbAdmin / access carry platform host names (preview domain, DB admin host, probe hosts)
    // whose A / AAAA records a hosted platform zone publishes: pushed now, not at the hourly resync —
    // their certificate is requested as soon as the edge serves them (and waits for this push).
    if (sections.some((s) => s === 'dns' || s === 'preview' || s === 'dbAdmin' || s === 'access')) {
      const { dnsService } = await import('../services/dns/dns.service');
      dnsService.requestSyncAll('hosting-settings');
    }
    if (sections.includes('access')) {
      const { firewallService } = await import('../services/firewall/firewall.service');
      firewallService.requestSyncAll('hosting-settings');
    }
    // P3: scanner (deploy / reconfigure the container), maintenance (typed watcher on/off → watch specs).
    if (sections.includes('scanner')) {
      const { scanService } = await import('../services/scan/scan.service');
      scanService.settingsChanged();
    }
    if (sections.includes('maintenance')) {
      const { quarantineService } = await import('../services/quarantine/quarantine.service');
      quarantineService.requestWatchSyncAll('hosting-settings');
    }
    // P4: mail (engine config, DNS records of every mail domain, edge vhosts / certificates,
    // relay, webmail container). Each hook never throws.
    if (sections.includes('mail')) {
      const { notifyMailSettingsChanged } = await import('../services/mail/contracts');
      await notifyMailSettingsChanged();
    }
    // P4b (docs/P4b-PLAN.md §Réglages): each settingsChanged() never throws.
    if (sections.includes('apps')) (await import('../services/apps/apps.service')).appsService.settingsChanged();
    if (sections.includes('edge')) (await import('../services/edge/edgeUnits.service')).edgeUnitsService.settingsChanged();
    if (sections.includes('bans')) (await import('../services/security/bans.service')).webBanService.settingsChanged();
    if (sections.includes('monitoring')) (await import('../services/monitoring/uptime.service')).uptimeService.settingsChanged();
    if (sections.includes('network')) (await import('../services/network/segments.service')).segmentService.settingsChanged();
  } catch (err) {
    logger.warn({ err }, 'hosting settings change hooks failed');
  }
}

export default router;
