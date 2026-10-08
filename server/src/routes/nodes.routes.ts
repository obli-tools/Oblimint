import { Router } from 'express';
import type { PanelNode } from '@oblimint/shared';
import { requireRole } from '../middleware/rbac';
import { db } from '../db';

// GET /api/nodes → PanelNode[] (platform admin, read-only in P0: the local node).
const router = Router();

router.get('/', requireRole('admin'), async (_req, res, next) => {
  try {
    const rows = await db('nodes').orderBy('id').select('id', 'name', 'engine_type', 'is_local', 'created_at');
    const data: PanelNode[] = rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      engineType: r.engine_type,
      isLocal: r.is_local,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

export default router;
