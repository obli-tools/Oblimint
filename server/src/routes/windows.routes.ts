import { Router } from 'express';
import { z } from 'zod';
import type {
  SiteApiTokenCreate, SiteMaintenanceSettingsUpdate, WindowExtendRequest, WindowOpenRequest, WindowRejectRequest, WindowValidateRequest,
} from '@oblimint/shared';
import { validate } from '../middleware/validate';
import { heavyOpLimiter } from '../middleware/rateLimiter';
import { idParam, loadSite, resolveActor } from '../services/hosting/access';
import { gateStrictest } from '../services/restrictions/gate';
import { gateSite, siteTarget } from '../services/restrictions/targets';
import { windowService } from '../services/windows/window.service';
import { siteTokenService } from '../services/windows/siteTokens';

// /api/sites/:id/{maintenance,windows,tokens} — OWNED BY MODULE `windows` (docs/P3-PLAN.md §6.1–§6.2).
// Mounted on /api/sites after the P1/P2 site routers. NO catch-all.
//   GET    /:id/maintenance                   → SiteMaintenanceInfo                         (read)
//   PUT    /:id/maintenance                   SiteMaintenanceSettingsUpdate → SiteMaintenanceInfo (sites.manage; + releases.publish to change schedule / autoValidate / supervised)
//   GET    /:id/windows?limit&offset&status   → { items: MaintenanceWindow[], total }       (read)
//   POST   /:id/windows                       WindowOpenRequest → MaintenanceWindow (201)   (releases.publish)
//   GET    /:id/windows/:wid                  → MaintenanceWindowDetail                     (read)
//   POST   /:id/windows/:wid/extend           WindowExtendRequest → MaintenanceWindow       (releases.publish)
//   POST   /:id/windows/:wid/close            → MaintenanceWindow (analysis in background)  (releases.publish)
//   POST   /:id/windows/:wid/validate         WindowValidateRequest → MaintenanceWindow     (releases.publish; releases.approve in
//                                                                                            publish mode approval; override: staff releases.approve)
//   POST   /:id/windows/:wid/reject           WindowRejectRequest → MaintenanceWindow       (releases.publish; + databases.manage to restore DBs)
//   POST   /:id/windows/:wid/reanalyze        → MaintenanceWindow                           (releases.publish)
//   GET    /:id/windows/:wid/files?change&minRisk&q&limit&offset → { items: WindowFile[], total } (read)
//   GET    /:id/windows/:wid/diff?file=       → WindowFileDiff                              (code.read → 403 codeReadForbidden, heavyOpLimiter)
//   GET    /:id/tokens                        → SiteApiToken[]                              (releases.publish + sites.manage)
//   POST   /:id/tokens                        SiteApiTokenCreate → SiteApiTokenCreated (201, token shown once) (releases.publish + sites.manage; valid while its creator keeps both)
//   DELETE /:id/tokens/:tokenId               → { deleted: true }                           (sites.manage)
// Codes: windowsDisabled (409), windowActive (409), windowNotOpen (409), windowNotPending (409),
// windowMaxDuration (409, details.maxMinutes), noRelease (409), siteStopped (409), accountSuspended (409),
// siteDeleting (409), publishInProgress (409), riskBlocked (409, details {score, level}), overrideForbidden (403),
// stagingConflict (409, details.paths), windowBaseChanged (409), windowNotAnalyzed (409), invalidSchedule (400),
// tokenNameTaken (409), tokenLimit (409: 10 per site), backendUnavailable (502).
const router = Router();

const scheduleSchema = z.object({
  enabled: z.boolean(),
  cron: z.string().min(1).max(100),
  timezone: z.string().min(1).max(64),
  durationMinutes: z.number().int().min(5).max(10080),
  kickPath: z.string().max(255).nullable(),
}).strict();

const settingsBody = z.object({
  pendingPolicy: z.enum(['keep', 'revert']).optional(),
  schedule: scheduleSchema.nullable().optional(),
  autoValidate: z.enum(['off', 'scheduled', 'scheduled-api']).optional(),
  snapshot: z.object({ mode: z.enum(['all', 'selected', 'none']), databaseIds: z.array(z.number().int().positive()).max(100).optional() }).strict().optional(),
  supervised: z.boolean().optional(),
  digestIntervalHours: z.number().int().min(1).max(168).optional(),
  defaultDurationMinutes: z.number().int().min(5).max(10080).optional(),
}).strict();

const openBody = z.object({
  durationMinutes: z.number().int().min(5).max(10080).optional(),
  note: z.string().max(500).nullable().optional(),
}).strict();
const extendBody = z.object({ minutes: z.number().int().min(5).max(10080) }).strict();
const validateBody = z.object({
  message: z.string().max(2000).nullable().optional(),
  override: z.boolean().optional(),
  force: z.boolean().optional(),
}).strict();
const rejectBody = z.object({
  reason: z.string().max(500).nullable().optional(),
  restoreDatabases: z.boolean().optional(),
}).strict();
const tokenBody = z.object({
  name: z.string().trim().min(1).max(100),
  expiresAt: z.string().datetime().nullable().optional(),
}).strict();

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.string().max(20).optional(),
});
const filesQuery = z.object({
  change: z.enum(['added', 'modified', 'deleted', 'typechange']).optional(),
  minRisk: z.coerce.number().int().min(0).max(100).optional(),
  q: z.string().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const diffQuery = z.object({ file: z.string().min(1).max(4096) });

router.get('/:id/maintenance', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await windowService.info(actor, idParam(req)) });
  } catch (err) { next(err); }
});

router.put('/:id/maintenance', validate(settingsBody), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await windowService.updateSettings(req, actor, idParam(req), req.body as SiteMaintenanceSettingsUpdate) });
  } catch (err) { next(err); }
});

router.get('/:id/windows', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const q = req.query as unknown as z.infer<typeof listQuery>;
    res.json({ success: true, data: await windowService.list(actor, idParam(req), { limit: q.limit, offset: q.offset, status: (q.status as never) ?? null }) });
  } catch (err) { next(err); }
});

router.post('/:id/windows', validate(openBody), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.status(201).json({ success: true, data: await windowService.open(req, actor, idParam(req), req.body as WindowOpenRequest) });
  } catch (err) { next(err); }
});

router.get('/:id/windows/:wid', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await windowService.get(actor, idParam(req), idParam(req, 'wid')) });
  } catch (err) { next(err); }
});

router.post('/:id/windows/:wid/extend', validate(extendBody), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await windowService.extend(req, actor, idParam(req), idParam(req, 'wid'), req.body as WindowExtendRequest) });
  } catch (err) { next(err); }
});

router.post('/:id/windows/:wid/close', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await windowService.close(req, actor, idParam(req), idParam(req, 'wid')) });
  } catch (err) { next(err); }
});

router.post('/:id/windows/:wid/validate', validate(validateBody), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const body = req.body as WindowValidateRequest & { override?: boolean };
    // Validating a window publishes its changes: release.publish (and the scan override, staff only).
    // 'read' here: the service checks releases.publish, or releases.approve in publish mode approval.
    const site = await loadSite(actor, idParam(req), 'read');
    const params = { windowId: idParam(req, 'wid'), message: body.message ?? null, override: body.override === true };
    await gateStrictest(req, [
      { action: 'release.publish', target: siteTarget(site), params },
      ...(body.override ? [{ action: 'release.approve_override_scan', target: siteTarget(site), params }] : []),
    ]);
    res.json({ success: true, data: await windowService.validate(req, actor, site.id, idParam(req, 'wid'), body) });
  } catch (err) { next(err); }
});

router.post('/:id/windows/:wid/reject', validate(rejectBody), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const body = req.body as WindowRejectRequest & { restoreDatabases?: boolean };
    let siteId = idParam(req);
    // Rejecting while restoring the databases to their snapshot: window.reject_db_restore.
    if (body.restoreDatabases) {
      const site = await gateSite(req, 'window.reject_db_restore', siteId, 'databases.manage', {
        windowId: idParam(req, 'wid'), reason: body.reason ?? null, restoreDatabases: true,
      });
      siteId = site.id;
    }
    res.json({ success: true, data: await windowService.reject(req, actor, siteId, idParam(req, 'wid'), body) });
  } catch (err) { next(err); }
});

router.post('/:id/windows/:wid/reanalyze', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await windowService.reanalyze(req, actor, idParam(req), idParam(req, 'wid')) });
  } catch (err) { next(err); }
});

router.get('/:id/windows/:wid/files', validate(filesQuery, 'query'), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const q = req.query as unknown as z.infer<typeof filesQuery>;
    res.json({
      success: true,
      data: await windowService.files(actor, idParam(req), idParam(req, 'wid'), {
        change: q.change ?? null, minRisk: q.minRisk ?? null, q: q.q ?? null, limit: q.limit, offset: q.offset,
      }),
    });
  } catch (err) { next(err); }
});

router.get('/:id/windows/:wid/diff', heavyOpLimiter, validate(diffQuery, 'query'), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await windowService.fileDiff(actor, idParam(req), idParam(req, 'wid'), String(req.query.file)) });
  } catch (err) { next(err); }
});

router.get('/:id/tokens', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await siteTokenService.list(actor, idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/:id/tokens', validate(tokenBody), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.status(201).json({ success: true, data: await siteTokenService.create(req, actor, idParam(req), req.body as SiteApiTokenCreate) });
  } catch (err) { next(err); }
});

router.delete('/:id/tokens/:tokenId', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    await siteTokenService.remove(req, actor, idParam(req), idParam(req, 'tokenId'));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

export default router;
