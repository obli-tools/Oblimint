import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { resolveActor } from '../services/hosting/access';
import { windowService } from '../services/windows/window.service';

// /api/maintenance — OWNED BY MODULE `windows` (docs/P3-PLAN.md §6.1). Overview across the sites the actor sees.
//   GET /windows?status=active|pending_review|…&accountId&tenantId&limit&offset → { items: MaintenanceWindowListItem[], total } (read, scoped)
const router = Router();

const listQuery = z.object({
  status: z.string().max(20).optional(),
  accountId: z.coerce.number().int().positive().optional(),
  tenantId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

router.get('/windows', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const q = req.query as unknown as z.infer<typeof listQuery>;
    res.json({
      success: true,
      data: await windowService.listAll(actor, {
        status: (q.status as never) ?? null, accountId: q.accountId ?? null, tenantId: q.tenantId ?? null, limit: q.limit, offset: q.offset,
      }),
    });
  } catch (err) { next(err); }
});

export default router;
