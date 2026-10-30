import { Router } from 'express';
import { z } from 'zod';
import { KEY_STRICT_MODES, MASTER_TENANT_ID, type KeySecuritySettings, type KeySecuritySettingsUpdate } from '@oblimint/shared';
import { AppError } from '../middleware/errorHandler';
import { validate } from '../middleware/validate';
import { auditService } from '../services/audit.service';
import { banKey, normalizeCidr } from '../services/firewall/addresses';
import { platformSettings } from '../services/platformSettings';
import { gatePlatform } from '../services/restrictions/targets';
import { liftPlatformBans } from '../services/security/bans.service';
import { keySurfaceGuard } from '../services/security/keySurfaceGuard';
import { clientIp } from '../utils/clientIp';

// /api/system/key-security — IP security of the access keys / MCP (spec §5.9, §6.3).
// Platform admin on the master workspace (mounted behind requirePlatformAdminOnMaster).
//   GET  /         → KeySecuritySettings
//   PUT  /         KeySecuritySettingsUpdate → KeySecuritySettings   (action platform.key_security)
//   GET  /status   → KeySecurityStatus (regime, open keys, allow-list size, current IP covered…)
//   POST /trust    {ip} → KeySecuritySettings: the address joins the trusted IPs and its platform
//                  bans are lifted in one go ("add to the trusted IPs" of the Bans page) (platform.key_security)
// Out of the panel: docker exec … node dist/src/cli/keySecurity.js unban|trust|status.

const router = Router({ caseSensitive: true });

/** Address / CIDR list, normalized (a v4 prefix of /8 at least, v6 /16). 400 invalidCidr otherwise. */
function cidrList(list: readonly string[]): string[] {
  return [...new Set(list.map((e) => normalizeCidr(String(e).trim(), { 4: 8, 6: 16 }).cidr))];
}

const updateSchema = z.object({
  requireIp: z.boolean().optional(),
  strictMode: z.enum(KEY_STRICT_MODES as unknown as ['auto', 'off', 'log', 'on']).optional(),
  maxFailures: z.number().int().min(1).max(100).optional(),
  failureWindowMinutes: z.number().int().min(1).max(1440).optional(),
  trustedIps: z.array(z.string().trim().min(2).max(64)).max(256).optional(),
  connectorSourceRanges: z.array(z.string().trim().min(2).max(64)).max(64).optional(),
}).strict();

router.get('/', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await keySurfaceGuard.settings() });
  } catch (err) { next(err); }
});

router.get('/status', async (req, res, next) => {
  try {
    res.json({ success: true, data: await keySurfaceGuard.status(clientIp(req) || null) });
  } catch (err) { next(err); }
});

router.put('/', validate(updateSchema), async (req, res, next) => {
  try {
    const body = req.body as KeySecuritySettingsUpdate;
    const patch: Partial<KeySecuritySettings> = { ...body };
    if (body.trustedIps) patch.trustedIps = cidrList(body.trustedIps);
    if (body.connectorSourceRanges) patch.connectorSourceRanges = cidrList(body.connectorSourceRanges);
    const before = await keySurfaceGuard.settings();
    // Back to 'auto': a new 48 h log-only period starts (the guard stores it at its next run).
    if (body.strictMode === 'auto' && before.strictMode !== 'auto') patch.autoStrictAt = null;
    await gatePlatform(req, 'platform.key_security', { patch: patch as Record<string, unknown> });
    const saved = (await platformSettings.update({ keySecurity: patch })).keySecurity;
    keySurfaceGuard.invalidate();
    await auditService.logReqAs(req, MASTER_TENANT_ID, 'settings.keySecurity', {
      resourceType: 'settings', resourcePath: 'keySecurity',
      details: Object.fromEntries(Object.keys(patch).map((k) => [k, { from: (before as unknown as Record<string, unknown>)[k], to: (patch as Record<string, unknown>)[k] }])),
    });
    res.json({ success: true, data: await keySurfaceGuard.settings().catch(() => saved) });
  } catch (err) { next(err); }
});

router.post('/trust', validate(z.object({ ip: z.string().trim().min(2).max(64) }).strict()), async (req, res, next) => {
  try {
    const raw = (req.body as { ip: string }).ip;
    // An IPv6 address is trusted with its /64 (its ban key), like the bans.
    const key = raw.includes('/') ? null : banKey(raw);
    const entry = key ? cidrList([key])[0] : cidrList([raw])[0];
    if (!entry) throw new AppError(400, 'Invalid IP address or CIDR range', 'invalidCidr');
    await gatePlatform(req, 'platform.key_security', { trust: entry });
    const s = await keySurfaceGuard.settings();
    const trustedIps = s.trustedIps.includes(entry) ? s.trustedIps : [...s.trustedIps, entry];
    if (trustedIps.length > 256) throw new AppError(400, 'At most 256 trusted addresses', 'validation');
    await platformSettings.update({ keySecurity: { trustedIps } });
    const lifted = await liftPlatformBans(key ?? raw.split('/')[0], { req });
    keySurfaceGuard.invalidate();
    keySurfaceGuard.banLifted(key ?? raw);
    await auditService.logReqAs(req, MASTER_TENANT_ID, 'settings.keySecurity.trust', {
      resourceType: 'settings', resourcePath: 'keySecurity', details: { ip: entry, liftedBans: lifted },
    });
    res.json({ success: true, data: { settings: await keySurfaceGuard.settings(), liftedBans: lifted } });
  } catch (err) { next(err); }
});

export default router;
