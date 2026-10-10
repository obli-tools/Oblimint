import { Router } from 'express';
import { z } from 'zod';
import type { MigrationRunRequest, MigrationRunStatus } from '@oblimint/shared';
import { validate } from '../middleware/validate';
import { idParam } from '../services/hosting/access';
import { migrationRunsService } from '../services/migration/execution/runs.service';

// /api/system/migration — runs, events, reports. OWNED BY MODULE `executor-web-db` (docs/P5-PLAN.md §6.4).
// Mounted behind requireAuth + requirePlatformAdminOnMaster on a SHARED prefix: no catch-all here.
//
//   POST   /plans/:id/runs        MigrationRunRequest      → MigrationRun[] (202)        audit migration.run.start
//   GET    /plans/:id/accounts                             → MigrationAccountStatus[]
//   GET    /plans/:id/report                               → MigrationReport
//   GET    /plans/:id/report.md                            → text/markdown (attachment migration-<plan>.md)
//   GET    /runs?planId&status&account                     → MigrationRun[]
//   GET    /runs/:id                                       → MigrationRunDetail
//   GET    /runs/:id/events?after&limit&stepKey            → MigrationRunEvent[]          (limit ≤ 500)
//   GET    /runs/:id/report                                → MigrationAccountReport
//   POST   /runs/:id/pause                                 → MigrationRun                 audit migration.run.pause
//   POST   /runs/:id/resume                                → MigrationRun                 audit migration.run.resume
//   POST   /runs/:id/cancel                                → MigrationRun                 audit migration.run.cancel
//   POST   /runs/:id/retry                                 → MigrationRun                 audit migration.run.retry
//
// Validation: accounts 1..500 CWP usernames ([a-z0-9][a-z0-9_.-]{0,63}), kind initial|resync|final-sync, parts ⊆
// files|data|databases|maildirs (default all for resync / final-sync, ignored for initial), mirrorDeletes boolean.
// Codes: notFound (404), planStale / planBlocked / planArchived / runActive / initialRequired / switchedNoMirror (409),
// runNotPausable / runNotResumable / runNotRetryable / runNotCancellable (409), migrationAdminRequired (403).
// Socket: MIGRATION_UPDATED { entity: 'run' | 'step', id, runId, planId, status, progress } (role:admin).

const router = Router();

const CWP_USERNAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const PARTS = ['files', 'data', 'databases', 'maildirs'] as const;
const STATUSES = ['queued', 'running', 'paused', 'failed', 'done', 'cancelled'] as const;

const runRequestSchema = z.object({
  accounts: z.array(z.string().regex(CWP_USERNAME, 'CWP user name')).min(1).max(500),
  kind: z.enum(['initial', 'resync', 'final-sync']),
  parts: z.array(z.enum(PARTS)).max(PARTS.length).optional(),
  mirrorDeletes: z.boolean().optional(),
}).strict();

const listQuery = z.object({
  planId: z.coerce.number().int().positive().optional(),
  status: z.enum(STATUSES).optional(),
  account: z.string().regex(CWP_USERNAME).optional(),
}).strict();

const eventsQuery = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  stepKey: z.string().min(1).max(200).optional(),
}).strict();

router.post('/plans/:id/runs', validate(runRequestSchema), async (req, res, next) => {
  try {
    const runs = await migrationRunsService.startRuns(req, idParam(req), req.body as MigrationRunRequest);
    res.status(202).json({ success: true, data: runs });
  } catch (err) { next(err); }
});

router.get('/plans/:id/accounts', async (req, res, next) => {
  try {
    res.json({ success: true, data: await migrationRunsService.accountStatuses(idParam(req)) });
  } catch (err) { next(err); }
});

router.get('/plans/:id/report', async (req, res, next) => {
  try {
    res.json({ success: true, data: await migrationRunsService.planReport(idParam(req)) });
  } catch (err) { next(err); }
});

router.get('/plans/:id/report.md', async (req, res, next) => {
  try {
    const planId = idParam(req);
    const text = await migrationRunsService.planReportMarkdown(planId);
    res.type('text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="migration-${planId}.md"`);
    res.send(text);
  } catch (err) { next(err); }
});

router.get('/runs', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const q = req.query as { planId?: number; status?: MigrationRunStatus; account?: string };
    res.json({ success: true, data: await migrationRunsService.list({ planId: q.planId ?? null, status: q.status ?? null, account: q.account ?? null }) });
  } catch (err) { next(err); }
});

router.get('/runs/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await migrationRunsService.get(idParam(req)) });
  } catch (err) { next(err); }
});

router.get('/runs/:id/events', validate(eventsQuery, 'query'), async (req, res, next) => {
  try {
    const q = req.query as unknown as { after?: number; limit: number; stepKey?: string };
    res.json({ success: true, data: await migrationRunsService.events(idParam(req), { after: q.after ?? null, limit: q.limit, stepKey: q.stepKey ?? null }) });
  } catch (err) { next(err); }
});

router.get('/runs/:id/report', async (req, res, next) => {
  try {
    res.json({ success: true, data: await migrationRunsService.runReport(idParam(req)) });
  } catch (err) { next(err); }
});

for (const action of ['pause', 'resume', 'cancel', 'retry'] as const) {
  router.post(`/runs/:id/${action}`, async (req, res, next) => {
    try {
      res.json({ success: true, data: await migrationRunsService[action](req, idParam(req)) });
    } catch (err) { next(err); }
  });
}

export default router;
