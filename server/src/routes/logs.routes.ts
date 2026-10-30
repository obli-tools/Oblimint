import { Router } from 'express';
import { z } from 'zod';
import { heavyOpLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { idParam, resolveActor } from '../services/hosting/access';
import { assertSource, logsService, type LogQuery } from '../services/logs/logs.service';
import { errorListQuery, errorListShape, siteErrorsService, type ErrorListShape } from '../services/siteErrors/siteErrors.service';

// /api/sites/:id/logs — OWNED BY MODULE `cron-logs` (docs/P2-PLAN.md §6.7). NO catch-all.
//   GET  /:id/logs            ?source=access|error|app&since=&until=&q=&status=&limit= → LogQueryResult (read; heavyOpLimiter)
//   GET  /:id/logs/files      → LogFileInfo[]                                                       (read)
//   GET  /:id/logs/download   ?source=access&date=YYYY-MM-DD | source=error|app (last 24 h, one container after the other, ≤ 50 000 lines each) → text/plain attachment (read; heavyOpLimiter)
//   GET  /:id/errors          ?release_id=&since_release_id=&new_only=1&level=fatal,parse&limit= → SiteErrorList (read)
//   GET  /:id/errors/:gid     → SiteErrorGroupDetail (sample with stack, same fingerprint in other releases)  (read)
// Live tail: Socket.io 'logs:subscribe' / 'logs:unsubscribe' (services/logs/socketHandlers.ts).
// Lines are in chronological order (the newest last), at most `limit` (1 … 2000, default 500).
// Codes: logSourceInvalid (400), logDateInvalid (400), siteNotRunning (409: no container),
// backendUnavailable (502: Docker unreachable).
const router = Router();

// Shape only (the service answers the precise codes: logSourceInvalid, logDateInvalid).
const queryShape = z.object({
  source: z.string().max(16).default('access'),
  since: z.string().max(64).optional(),
  until: z.string().max(64).optional(),
  q: z.string().max(200).optional(),
  status: z.string().max(8).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

const downloadShape = z.object({
  source: z.string().max(16),
  date: z.string().max(16).optional(),
});

router.get('/:id/logs', heavyOpLimiter, validate(queryShape, 'query'), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const q = req.query as unknown as z.infer<typeof queryShape>;
    const query: LogQuery = {
      source: assertSource(q.source),
      since: q.since ?? null,
      until: q.until ?? null,
      q: q.q ?? null,
      status: q.status ?? null,
      limit: q.limit ?? null,
    };
    res.json({ success: true, data: await logsService.query(actor, idParam(req), query) });
  } catch (err) { next(err); }
});

// PHP errors grouped by release (services/siteErrors): same right as the error log (read).
router.get('/:id/errors', validate(errorListShape, 'query'), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await siteErrorsService.list(actor, idParam(req), errorListQuery(req.query as unknown as ErrorListShape)) });
  } catch (err) { next(err); }
});

router.get('/:id/errors/:gid', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await siteErrorsService.get(actor, idParam(req), Number(req.params.gid)) });
  } catch (err) { next(err); }
});

router.get('/:id/logs/files', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await logsService.files(actor, idParam(req)) });
  } catch (err) { next(err); }
});

router.get('/:id/logs/download', heavyOpLimiter, validate(downloadShape, 'query'), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const q = req.query as unknown as z.infer<typeof downloadShape>;
    await logsService.download(req, res, actor, idParam(req), assertSource(q.source), q.date ?? null);
  } catch (err) {
    if (res.headersSent) { res.destroy(); return; }
    next(err);
  }
});

export default router;
