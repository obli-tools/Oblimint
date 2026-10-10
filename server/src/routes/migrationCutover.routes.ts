import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { heavyOpLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { idParam } from '../services/hosting/access';
import { migrationCutoverService } from '../services/migration/cutover/cutover.service';

// /api/system/migration — cutover checklist. OWNED BY MODULE `executor-mail-dns` (docs/P5-PLAN.md §6.5).
// Mounted behind requireAuth + requirePlatformAdminOnMaster on a SHARED prefix: no catch-all here.
//
//   GET    /plans/:id/cutover                                → MigrationCutoverDomain[]
//   POST   /plans/:id/cutover/refresh                        → MigrationCutoverDomain[]   (live DNS checks, heavyOpLimiter)
//   PUT    /cutover/:id           MigrationCutoverUpdate      → MigrationCutoverDomain     audit migration.cutover.update
//   POST   /cutover/:id/check                                → MigrationCutoverDomain     (live DNS checks of that domain)
//   POST   /cutover/:id/final-sync                           → MigrationRun (202)         audit migration.cutover.final_sync
//   POST   /cutover/:id/switch    MigrationCutoverSwitch      → MigrationCutoverDomain     audit migration.cutover.switch
//   POST   /cutover/:id/rollback                             → MigrationCutoverDomain     audit migration.cutover.rollback
//
// Codes: notFound (404), confirmMismatch (400), cutoverNotReady (409), runActive (409, from the engine).
// Also: cutoverItemAuto (400: an automatic item cannot be ticked by hand), cutoverNoteRequired (400: forcing
// ttlLowered needs a note), cutoverNotSwitched (409: rollback of a domain that is not switched), cutoverSwitched
// (409 on final-sync: a domain of the account is switched now — a final sync would overwrite its live data).
// Socket: MIGRATION_UPDATED { entity: 'cutover', id, planId, status }.
// Importing the service registers the run-finished hook (checklist rows refreshed after every run).

const router = Router();

const ITEM_CODES = [
  'ttlLowered', 'targetReady', 'finalSync', 'nsChanged', 'aRecordsChanged', 'mxChanged', 'verified', 'certificateIssued', 'sourceDisabled',
] as const;

const updateBody = z.object({
  items: z.object(Object.fromEntries(ITEM_CODES.map((c) => [c, z.boolean().optional()])) as Record<(typeof ITEM_CODES)[number], z.ZodOptional<z.ZodBoolean>>)
    .strict().optional(),
  notes: z.string().max(4000).nullable().optional(),
}).strict();

const switchBody = z.object({ confirm: z.string().trim().min(1).max(253) }).strict();

type Handler = (req: Request) => Promise<unknown>;

function handle(fn: Handler, status = 200) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json({ success: true, data: await fn(req) });
    } catch (err) { next(err); }
  };
}

router.get('/plans/:id/cutover', handle((req) => migrationCutoverService.list(idParam(req))));
router.post('/plans/:id/cutover/refresh', heavyOpLimiter, handle((req) => migrationCutoverService.refresh(req, idParam(req))));
router.put('/cutover/:id', validate(updateBody), handle((req) => migrationCutoverService.update(req, idParam(req), req.body)));
router.post('/cutover/:id/check', heavyOpLimiter, handle((req) => migrationCutoverService.check(req, idParam(req))));
router.post('/cutover/:id/final-sync', handle((req) => migrationCutoverService.finalSync(req, idParam(req)), 202));
router.post('/cutover/:id/switch', validate(switchBody), handle((req) => migrationCutoverService.switchOver(req, idParam(req), req.body)));
router.post('/cutover/:id/rollback', handle((req) => migrationCutoverService.rollback(req, idParam(req))));

export default router;
