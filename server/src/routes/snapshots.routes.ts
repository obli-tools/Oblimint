import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { idParam, resolveActor } from '../services/hosting/access';
import { snapshotService } from '../services/snapshots/snapshot.service';
import { gateSite } from '../services/restrictions/targets';

// /api/sites/:id/snapshots — OWNED BY MODULE `checksums-snapshots` (docs/P3-PLAN.md §6.3). NO catch-all.
//   GET    /:id/snapshots?limit&offset           → { items: DbSnapshot[], total }   (read)
//   POST   /:id/snapshots/:snapshotId/restore    → { restored: true }               (databases.manage)
//   DELETE /:id/snapshots/:snapshotId            → { deleted: true }                (databases.manage)
// Codes: snapshotNotReady (409), instanceNotRunning (409), instanceBusy (409), restoreFailed (502), backendUnavailable (502).
const router = Router();

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get('/:id/snapshots', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const q = req.query as unknown as z.infer<typeof listQuery>;
    res.json({ success: true, data: await snapshotService.listForSite(actor, idParam(req), { limit: q.limit, offset: q.offset }) });
  } catch (err) { next(err); }
});

router.post('/:id/snapshots/:snapshotId/restore', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const site = await gateSite(req, 'snapshot.restore', idParam(req), 'databases.manage', { snapshotId: idParam(req, 'snapshotId') });
    res.json({ success: true, data: await snapshotService.restoreOne(req, actor, site.id, idParam(req, 'snapshotId')) });
  } catch (err) { next(err); }
});

router.delete('/:id/snapshots/:snapshotId', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const site = await gateSite(req, 'snapshot.delete', idParam(req), 'databases.manage', { snapshotId: idParam(req, 'snapshotId') });
    await snapshotService.remove(req, actor, site.id, idParam(req, 'snapshotId'));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

export default router;
