import { Router } from 'express';
import { requireRole } from '../middleware/rbac';
import { AppError } from '../middleware/errorHandler';
import { appConfigService, obligatePatch, WRITABLE_CONFIG_KEYS } from '../services/appConfig.service';
import { obligateService } from '../services/obligate.service';
import { auditService } from '../services/audit.service';

// /api/admin/config (tenant router) — same paths as the Obliance appConfig routes.

const router = Router();

// GET: every signed-in user (the profile page reads allow_2fa).
router.get('/', async (_req, res, next) => {
  try { res.json({ success: true, data: await appConfigService.getAll() }); } catch (err) { next(err); }
});

router.get('/obligate', requireRole('admin'), async (_req, res, next) => {
  try { res.json({ success: true, data: await appConfigService.getObligateConfig() }); } catch (err) { next(err); }
});

router.put('/obligate', requireRole('admin'), async (req, res, next) => {
  try {
    const patch = obligatePatch((req.body ?? {}) as Record<string, unknown>);
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
    await auditService.logReq(req, 'settings.changed', { resourceType: 'settings', resourcePath: key, details: { from: before, to: value } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
