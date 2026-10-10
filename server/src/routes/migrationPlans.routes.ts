import { Router } from 'express';
import { z } from 'zod';
import type { MigrationAccountChoice, MigrationPlanChoices, MigrationPlanCreate } from '@oblimint/shared';
import { validate } from '../middleware/validate';
import { idParam } from '../services/hosting/access';
import { migrationPlansService } from '../services/migration/plan/plans.service';
import { accountChoiceSchema, planChoicesSchema, planCreateSchema, planRebaseSchema } from '../services/migration/plan/schema';

// /api/system/migration — plans (choices + dry-run). OWNED BY MODULE `planner` (docs/P5-PLAN.md §6.3). Mounted
// behind requireAuth + requirePlatformAdminOnMaster on a SHARED prefix: no catch-all here.
//
//   GET    /targets                                       → MigrationTargetCatalog
//   GET    /plans?sourceId                                → MigrationPlanSummary[]
//   POST   /plans                MigrationPlanCreate       → MigrationPlan (201)        audit migration.plan.create
//   GET    /plans/:id                                     → MigrationPlan
//   PUT    /plans/:id/choices    MigrationPlanChoices      → MigrationPlan (recomputed) audit migration.plan.update
//   PUT    /plans/:id/accounts/:username  MigrationAccountChoice → MigrationPlan (recomputed) audit migration.plan.update
//   POST   /plans/:id/compute                             → MigrationPlan (dry-run against the current target state)
//   POST   /plans/:id/rebase     { discoveryId }           → MigrationPlan              audit migration.plan.rebase
//   DELETE /plans/:id                                     → { deleted, archived }      audit migration.plan.delete
//
// Validation: the choices are validated by a zod schema mirroring MigrationPlanChoices (.strict() objects, ids
// positive ints, base ∈ SITE_BASE_IDS, profile ∈ APP_PROFILES, dbEngine/version ∈ DB_ENGINE_VERSIONS, IPs parsed,
// path prefixes normalizePathPrefix, rel paths normalizeRelPath, excludes [A-Za-z0-9._*?/@+-], body ≤ 1 MiB = global limit).
// Unknown accounts / domains / databases… in the choices are ignored and dropped (never an error).
// Codes: notFound (404), discoveryNotDone (409), discoveryOtherSource (409: rebase onto another source),
// nameTaken (409), validation (400). Socket: MIGRATION_UPDATED { entity: 'plan', id, sourceId }.

const router = Router();

const listQuery = z.object({ sourceId: z.coerce.number().int().positive().optional() });
const usernameParam = /^[A-Za-z0-9._-]{1,64}$/;

router.get('/targets', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await migrationPlansService.targets() });
  } catch (err) { next(err); }
});

router.get('/plans', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const q = req.query as unknown as z.infer<typeof listQuery>;
    res.json({ success: true, data: await migrationPlansService.list({ sourceId: q.sourceId ?? null }) });
  } catch (err) { next(err); }
});

router.post('/plans', validate(planCreateSchema), async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await migrationPlansService.create(req, req.body as MigrationPlanCreate) });
  } catch (err) { next(err); }
});

router.get('/plans/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await migrationPlansService.get(idParam(req)) });
  } catch (err) { next(err); }
});

router.put('/plans/:id/choices', validate(planChoicesSchema), async (req, res, next) => {
  try {
    res.json({ success: true, data: await migrationPlansService.setChoices(req, idParam(req), req.body as MigrationPlanChoices) });
  } catch (err) { next(err); }
});

router.put('/plans/:id/accounts/:username', validate(accountChoiceSchema), async (req, res, next) => {
  try {
    const id = idParam(req);
    const username = String(req.params.username ?? '');
    if (!usernameParam.test(username)) {
      res.status(404).json({ success: false, error: 'Account not found', code: 'notFound' });
      return;
    }
    res.json({ success: true, data: await migrationPlansService.setAccountChoice(req, id, username, req.body as MigrationAccountChoice) });
  } catch (err) { next(err); }
});

router.post('/plans/:id/compute', async (req, res, next) => {
  try {
    res.json({ success: true, data: await migrationPlansService.compute(req, idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/plans/:id/rebase', validate(planRebaseSchema), async (req, res, next) => {
  try {
    res.json({ success: true, data: await migrationPlansService.rebase(req, idParam(req), (req.body as { discoveryId: number }).discoveryId) });
  } catch (err) { next(err); }
});

router.delete('/plans/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await migrationPlansService.remove(req, idParam(req)) });
  } catch (err) { next(err); }
});

export default router;
