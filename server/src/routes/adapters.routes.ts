import { Router } from 'express';
import { z } from 'zod';
import { ADAPTER_IDS, type AdapterId, type AdapterRunRequest, type AdapterScheduleInput } from '@oblimint/shared';
import { validate } from '../middleware/validate';
import { AppError } from '../middleware/errorHandler';
import { idParam, resolveActor } from '../services/hosting/access';
import { adapterService } from '../services/adapters/adapter.service';

// /api/sites/:id/adapters — OWNED BY MODULE `adapters` (docs/P3-PLAN.md §6.5). NO catch-all.
//   GET    /:id/adapters                         → SiteAdaptersInfo                        (read)
//   POST   /:id/adapters/runs                    AdapterRunRequest → AdapterRun (202)      (releases.publish)
//   GET    /:id/adapters/runs?limit&offset       → { items: AdapterRun[], total }          (read)
//   GET    /:id/adapters/runs/:runId             → AdapterRunDetail                        (read)
//   PUT    /:id/adapters/schedules/:adapter      AdapterScheduleInput → AdapterSchedule    (releases.publish + sites.manage; fires only while its author still may publish)
//   DELETE /:id/adapters/schedules/:adapter      → { deleted: true }                       (sites.manage)
// Codes: adaptersDisabled (409), adapterNotDetected (409), adapterBusy (409), windowActive (409),
// publishInProgress (409), noRelease (409), siteStopped (409), accountSuspended (409), toolsImageMissing (502),
// invalidSchedule (400), backendUnavailable (502).
const router = Router();

const optionsSchema = z.object({
  core: z.boolean().optional(),
  plugins: z.union([z.literal('all'), z.literal(false), z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/)).max(200)]).optional(),
  themes: z.union([z.literal('all'), z.literal(false), z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/)).max(200)]).optional(),
  translations: z.boolean().optional(),
  minorOnly: z.boolean().optional(),
  composerCommand: z.enum(['install', 'update']).optional(),
  packages: z.array(z.string().regex(/^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]?|-{0,2})[a-z0-9]+)*$/)).max(100).optional(),
  noDev: z.boolean().optional(),
  runMigrations: z.boolean().optional(),
}).strict();

const runBody = z.object({
  adapter: z.enum(ADAPTER_IDS as unknown as [AdapterId, ...AdapterId[]]),
  action: z.enum(['check', 'update']),
  options: optionsSchema.optional(),
}).strict();

const scheduleBody = z.object({
  cron: z.string().min(1).max(100),
  timezone: z.string().min(1).max(64).optional(),
  options: optionsSchema,
  enabled: z.boolean(),
}).strict();

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

function adapterParam(raw: string): AdapterId {
  if (!(ADAPTER_IDS as readonly string[]).includes(raw)) throw new AppError(404, 'Unknown adapter', 'notFound');
  return raw as AdapterId;
}

router.get('/:id/adapters', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await adapterService.info(actor, idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/:id/adapters/runs', validate(runBody), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.status(202).json({ success: true, data: await adapterService.run(req, actor, idParam(req), req.body as AdapterRunRequest) });
  } catch (err) { next(err); }
});

router.get('/:id/adapters/runs', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const q = req.query as unknown as z.infer<typeof listQuery>;
    res.json({ success: true, data: await adapterService.runs(actor, idParam(req), { limit: q.limit, offset: q.offset }) });
  } catch (err) { next(err); }
});

router.get('/:id/adapters/runs/:runId', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await adapterService.getRun(actor, idParam(req), idParam(req, 'runId')) });
  } catch (err) { next(err); }
});

router.put('/:id/adapters/schedules/:adapter', validate(scheduleBody), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({
      success: true,
      data: await adapterService.putSchedule(req, actor, idParam(req), adapterParam(req.params.adapter), req.body as AdapterScheduleInput),
    });
  } catch (err) { next(err); }
});

router.delete('/:id/adapters/schedules/:adapter', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    await adapterService.deleteSchedule(req, actor, idParam(req), adapterParam(req.params.adapter));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

export default router;
