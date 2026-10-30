import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { AppError } from '../middleware/errorHandler';
import { permissionSetService } from '../services/permissionSet.service';
import { auditService } from '../services/audit.service';
import { gatePlatform } from '../services/restrictions/targets';

// /api/permission-sets (tenant router). Read: any signed-in user; write:
// platform admin. Permission sets are platform-wide (as in Obliance).

const router = Router();

const createSchema = z.object({
  name: z.string().trim().min(1).max(64),
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'lowercase letters, digits, _ and -'),
  capabilities: z.array(z.string().max(64)).max(200),
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  capabilities: z.array(z.string().max(64)).max(200).optional(),
});

const idParam = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(400, 'Invalid id');
  return id;
};

router.get('/', async (_req, res, next) => {
  try { res.json({ success: true, data: await permissionSetService.getAll() }); } catch (err) { next(err); }
});

router.get('/capabilities', (_req, res) => {
  res.json({ success: true, data: permissionSetService.getAvailableCapabilities() });
});

router.post('/', requireRole('admin'), validate(createSchema), async (req, res, next) => {
  try {
    await gatePlatform(req, 'platform.permission_sets', { op: 'create', ...req.body });
    const created = await permissionSetService.create(req.body);
    await auditService.logReq(req, 'permission_set.created', {
      resourceType: 'permission_set', resourcePath: String(created.id), details: { slug: created.slug, capabilities: created.capabilities },
    });
    res.status(201).json({ success: true, data: created });
  } catch (err: any) {
    if (err?.code === '23505') { res.status(409).json({ success: false, error: 'A permission set with this slug already exists' }); return; }
    next(err);
  }
});

router.put('/:id', requireRole('admin'), validate(updateSchema), async (req, res, next) => {
  try {
    const id = idParam(req.params.id);
    await gatePlatform(req, 'platform.permission_sets', { op: 'update', id, ...req.body });
    const updated = await permissionSetService.update(id, req.body);
    if (!updated) throw new AppError(404, 'Permission set not found');
    await auditService.logReq(req, 'permission_set.updated', {
      resourceType: 'permission_set', resourcePath: String(id), details: { name: updated.name, capabilities: updated.capabilities },
    });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = idParam(req.params.id);
    await gatePlatform(req, 'platform.permission_sets', { op: 'delete', id });
    const result = await permissionSetService.delete(id);
    if (!result.success) throw new AppError(400, result.error ?? 'Cannot delete');
    await auditService.logReq(req, 'permission_set.deleted', { resourceType: 'permission_set', resourcePath: String(id) });
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
