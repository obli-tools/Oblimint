import { Router } from 'express';
import { requireRole, requirePlatformAdminOnMaster } from '../middleware/rbac';
import net from 'node:net';
import { edgeService } from '../services/edge/edge.service';
import { certificateService } from '../services/edge/certificate.service';
import { dnsService } from '../services/dns/dns.service';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import { appConfigService, obligatePatch, WRITABLE_CONFIG_KEYS } from '../services/appConfig.service';
import { obligateService } from '../services/obligate.service';
import { auditService } from '../services/audit.service';
import { checkFactorManagement, sendStepUpFailure } from '../services/stepUp';
import { forgetTwoFactorPolicy } from '../middleware/sessionUserGuard';
import type { AppConfigData } from '@oblimint/shared';
import { forgetPanelHosts } from '../services/panelHosts';

/**
 * What a non-administrator may read: the UI flags, and what a customer needs
 * to point its DNS at the platform. Never the ACME e-mail, the mail engine or
 * the Obligate URL (operator infrastructure).
 */
export function appConfigForRole(cfg: AppConfigData, platformAdmin: boolean): AppConfigData {
  if (platformAdmin) return cfg;
  return { ...cfg, obligate_url: null, acme_email: null, mail_engine: null };
}

// /api/admin/config (tenant router) — same paths as the Obliance appConfig routes.

const router = Router();

// GET: every signed-in user (the profile page reads allow_2fa).
router.get('/', async (req, res, next) => {
  try {
    res.json({ success: true, data: appConfigForRole(await appConfigService.getAll(), req.session.role === 'admin') });
  } catch (err) { next(err); }
});

router.get('/obligate', requireRole('admin'), async (_req, res, next) => {
  try { res.json({ success: true, data: await appConfigService.getObligateConfig() }); } catch (err) { next(err); }
});

router.put('/obligate', requireRole('admin'), async (req, res, next) => {
  try {
    const patch = obligatePatch((req.body ?? {}) as Record<string, unknown>);
    // The SSO trust anchor decides who becomes platform admin: a hijacked
    // admin session alone must not repoint it. Changing the URL, the API key
    // or the inbound secret needs a step-up (current TOTP code, else the
    // current password). An SSO admin without a local TOTP cannot prove one.
    const stored = await appConfigService.readObligateStored();
    const touchesTrust = ('url' in patch && (patch.url ?? null) !== stored.url) || !!patch.apiKey || 'inboundSecret' in patch;
    if (touchesTrust) {
      const step = await checkFactorManagement(req, 'settings.obligate');
      if (!step.ok) {
        if (step.status === 403) {
          throw new AppError(403, 'Changing the Obligate connection needs a local account confirmation (password or local TOTP)', 'localConfirmationRequired');
        }
        sendStepUpFailure(res, step);
        return;
      }
    }
    const updated = await appConfigService.patchObligateConfig(patch);
    obligateService.announceSelfInfo().catch(() => {});
    const details: Record<string, unknown> = {};
    if ('url' in patch) details.url = patch.url;
    if ('enabled' in patch) details.enabled = patch.enabled;
    if (patch.apiKey) details.apiKey = 'changed';
    if ('inboundSecret' in patch) details.inboundSecret = patch.inboundSecret ? 'changed' : 'cleared';
    await auditService.logReq(req, 'settings.obligate_changed', { resourceType: 'settings', details });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

// Panel identity (host name, public IPs, ACME e-mail) after the setup wizard:
// platform admin on the master tenant. Re-syncs the edge (panel vhost), the
// platform certificates and the DNS zones that publish these values.
export const PANEL_HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const ACME_EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
/** Lower case, trailing dot of an absolute name removed (only a DOT: the name itself is kept whole). */
export const normalizePanelHost = (v: string): string => v.toLowerCase().replace(/\.$/, '');
router.put('/platform', requirePlatformAdminOnMaster, async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? '' : null);
    const rawHost = str(b.panelHostname);
    const host = rawHost === null ? null : normalizePanelHost(rawHost);
    // Optional client space host (same panel, clients only): absent = unchanged, "" = none.
    const rawClient = 'clientPanelHostname' in b ? str(b.clientPanelHostname) : undefined;
    const clientHost = rawClient === undefined || rawClient === null ? rawClient : normalizePanelHost(rawClient);
    const v4 = str(b.publicIpv4); const v6 = str(b.publicIpv6); const email = str(b.acmeEmail);
    if (host === null || !PANEL_HOST_RE.test(host)) throw new AppError(400, 'Invalid panel host name', 'invalidPanelHostname');
    if (clientHost === null || (clientHost && !PANEL_HOST_RE.test(clientHost))) throw new AppError(400, 'Invalid client space host name', 'invalidClientPanelHostname');
    if (clientHost && clientHost === host) throw new AppError(400, 'The client space needs its own host name, not the panel one', 'clientPanelHostnameSame');
    if (v4 === null || (v4 && !net.isIPv4(v4))) throw new AppError(400, 'Invalid IPv4 address', 'invalidIpv4');
    if (v6 === null || (v6 && !net.isIPv6(v6))) throw new AppError(400, 'Invalid IPv6 address', 'invalidIpv6');
    if (email === null || !ACME_EMAIL_RE.test(email)) throw new AppError(400, 'Invalid e-mail address', 'invalidEmail');
    const before = { panel_hostname: await appConfigService.get('panel_hostname'), client_panel_hostname: await appConfigService.get('client_panel_hostname') || null, public_ipv4: await appConfigService.get('public_ipv4'), public_ipv6: await appConfigService.get('public_ipv6'), acme_email: await appConfigService.get('acme_email') };
    await appConfigService.set('panel_hostname', host);
    if (clientHost !== undefined) await appConfigService.set('client_panel_hostname', clientHost);
    await appConfigService.set('public_ipv4', v4);
    await appConfigService.set('public_ipv6', v6);
    await appConfigService.set('acme_email', email);
    forgetPanelHosts();
    await auditService.logReq(req, 'settings.platform_changed', { resourceType: 'settings', details: { from: before, to: { panel_hostname: host, client_panel_hostname: clientHost === undefined ? before.client_panel_hostname : clientHost || null, public_ipv4: v4, public_ipv6: v6, acme_email: email } } });
    try { edgeService.scheduleSync('panel identity changed'); } catch (err) { logger.warn({ err }, 'edge sync after panel identity change failed'); }
    // DNS push queued first: the platform certificates requested right after wait for it (the A / AAAA
    // record of a new host name in a hosted platform zone), certificate.service runIssuance.
    dnsService.syncAllNow('panel identity changed').catch((err) => logger.warn({ err }, 'DNS sync after panel identity change failed'));
    try { certificateService.ensureAuxiliary(); } catch (err) { logger.warn({ err }, 'platform certificates after panel identity change failed'); }
    res.json({ success: true, data: await appConfigService.getAll() });
  } catch (err) { next(err); }
});

// Generic key setter — whitelisted keys only, MUST stay last.
router.put('/:key', requireRole('admin'), async (req, res, next) => {
  try {
    const key = req.params.key;
    const check = Object.prototype.hasOwnProperty.call(WRITABLE_CONFIG_KEYS, key) ? WRITABLE_CONFIG_KEYS[key] : undefined;
    if (!check) throw new AppError(400, `Unknown or read-only setting: ${key}`);
    const raw = (req.body ?? {}).value;
    const value = typeof raw === 'boolean' ? String(raw) : typeof raw === 'string' ? raw.trim() : null;
    if (value === null || !check(value)) throw new AppError(400, `Invalid value for ${key}`);
    const before = await appConfigService.get(key);
    await appConfigService.set(key, value);
    if (key === 'force_2fa') forgetTwoFactorPolicy();
    await auditService.logReq(req, 'settings.changed', { resourceType: 'settings', resourcePath: key, details: { from: before, to: value } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
