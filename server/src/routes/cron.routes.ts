import { Router } from 'express';
import { z } from 'zod';
import { CRON_MAX_TIMEOUT_SEC, type CronJobInput } from '@oblimint/shared';
import { validate } from '../middleware/validate';
import { idParam, resolveActor } from '../services/hosting/access';
import { cronService } from '../services/cron/cron.service';

// /api/sites/:id/cron — OWNED BY MODULE `cron-logs` (docs/P2-PLAN.md §6.6). Mounted on /api/sites
// after the P1 site routers. NO catch-all.
//   GET    /:id/cron                     → CronJob[]                                 (read)
//   POST   /:id/cron                     CronJobInput → CronJob (201)                (sites.manage; plan maxCronJobs / cronMinIntervalMin)
//   PUT    /:id/cron/:jobId              Partial<CronJobInput> → CronJob             (sites.manage)
//   DELETE /:id/cron/:jobId              → { deleted: true }                         (sites.manage)
//   POST   /:id/cron/:jobId/run          → CronRun (202, manual run)                 (sites.manage; 409 cronRunning)
//   GET    /:id/cron/:jobId/runs         ?limit=&offset= → { items: CronRun[], total } (read)
//   GET    /:id/cron/runs/:runId         → CronRunDetail                              (read)
// Access: the service loads the site with loadSite(actor, id, need) (404 invisible / 403 no right);
// a :jobId / :runId must belong to that site (404 otherwise). Codes: cronInvalidSchedule (400),
// commandTooLong (400), cronTooFrequent (409, details.minIntervalMin), planLimit (409), cronNameTaken (409),
// cronRunning (409), siteNotRunning (409).
const router = Router();

// Shape only: lengths / schedule / plan limits are checked by the service (precise error codes).
const jobFields = {
  name: z.string().min(1).max(100),
  schedule: z.string().min(1).max(100),
  command: z.string().min(1).max(100_000),
  timeoutSec: z.number().int().min(10).max(CRON_MAX_TIMEOUT_SEC).optional(),
  enabled: z.boolean().optional(),
};
const createBody = z.object(jobFields).strict();
const updateBody = z.object(jobFields).partial().strict();

const runsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get('/:id/cron', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await cronService.list(actor, idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/:id/cron', validate(createBody), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const job = await cronService.create(req, actor, idParam(req), req.body as CronJobInput);
    res.status(201).json({ success: true, data: job });
  } catch (err) { next(err); }
});

// Before /:id/cron/:jobId/* so that "runs" is never read as a job id.
router.get('/:id/cron/runs/:runId', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await cronService.run(actor, idParam(req), idParam(req, 'runId')) });
  } catch (err) { next(err); }
});

router.put('/:id/cron/:jobId', validate(updateBody), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const job = await cronService.update(req, actor, idParam(req), idParam(req, 'jobId'), req.body as Partial<CronJobInput>);
    res.json({ success: true, data: job });
  } catch (err) { next(err); }
});

router.delete('/:id/cron/:jobId', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    await cronService.remove(req, actor, idParam(req), idParam(req, 'jobId'));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

router.post('/:id/cron/:jobId/run', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const run = await cronService.runNow(req, actor, idParam(req), idParam(req, 'jobId'));
    res.status(202).json({ success: true, data: run });
  } catch (err) { next(err); }
});

router.get('/:id/cron/:jobId/runs', validate(runsQuery, 'query'), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const q = req.query as unknown as z.infer<typeof runsQuery>;
    res.json({ success: true, data: await cronService.runs(actor, idParam(req), idParam(req, 'jobId'), q) });
  } catch (err) { next(err); }
});

export default router;
