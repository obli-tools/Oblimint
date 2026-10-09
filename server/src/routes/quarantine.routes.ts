import { Router } from 'express';
import { z } from 'zod';
import type { QuarantineRestoreRequest } from '@oblimint/shared';
import { validate } from '../middleware/validate';
import { idParam, resolveActor } from '../services/hosting/access';
import { quarantineService } from '../services/quarantine/quarantine.service';

// /api/quarantine — OWNED BY MODULE `supervised-quarantine` (docs/P3-PLAN.md §6.6).
//   GET    /?accountId&siteId&status&tenantId&limit&offset → { items: QuarantineItem[], total } (read, scoped to the actor)
//   GET    /summary?accountId                → QuarantineSummary                     (read)
//   GET    /:id                              → QuarantineItemDetail (preview: staff only) (read)
//   POST   /:id/restore   QuarantineRestoreRequest → QuarantineItem                 (STAFF files.manage, audited)
//   DELETE /:id                              → QuarantineItem (status deleted)       (STAFF files.manage, audited)
// Codes: quarantineResolved (409: already restored / deleted), restoreConflict (409: a file exists, details.path),
// staffOnly (403), backendUnavailable (502).
const router = Router();

const listQuery = z.object({
  accountId: z.coerce.number().int().positive().optional(),
  siteId: z.coerce.number().int().positive().optional(),
  status: z.enum(['quarantined', 'restored', 'deleted']).optional(),
  tenantId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
const summaryQuery = z.object({ accountId: z.coerce.number().int().positive().optional() });
const restoreBody = z.object({
  reason: z.string().max(500).nullable().optional(),
  overwrite: z.boolean().optional(),
}).strict();

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const q = req.query as unknown as z.infer<typeof listQuery>;
    res.json({
      success: true,
      data: await quarantineService.list(actor, {
        accountId: q.accountId ?? null, siteId: q.siteId ?? null, status: q.status ?? null, tenantId: q.tenantId ?? null, limit: q.limit, offset: q.offset,
      }),
    });
  } catch (err) { next(err); }
});

// Before /:id so that "summary" is never read as an id.
router.get('/summary', validate(summaryQuery, 'query'), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const q = req.query as unknown as z.infer<typeof summaryQuery>;
    res.json({ success: true, data: await quarantineService.summary(actor, q.accountId ?? null) });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await quarantineService.get(actor, idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/:id/restore', validate(restoreBody), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await quarantineService.restore(req, actor, idParam(req), req.body as QuarantineRestoreRequest) });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await quarantineService.remove(req, actor, idParam(req)) });
  } catch (err) { next(err); }
});

export default router;
