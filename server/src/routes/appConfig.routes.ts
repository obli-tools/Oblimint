import { Router } from 'express';
import { requireRole } from '../middleware/rbac';
import { AppError } from '../middleware/errorHandler';
import { appConfigService, obligatePatch, WRITABLE_CONFIG_KEYS } from '../services/appConfig.service';
import { obligateService } from '../services/obligate.service';
import { auditService } from '../services/audit.service';
import { checkFactorManagement, sendStepUpFailure } from '../services/stepUp';
import { forgetTwoFactorPolicy } from '../middleware/sessionUserGuard';
import type { AppConfigData } from '@oblimint/shared';

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
