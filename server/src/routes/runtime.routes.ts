import { Router, type Request } from 'express';
import { z } from 'zod';
import { isSiteBaseId, type SiteBaseId } from '@oblimint/shared';
import { heavyOpLimiter } from '../middleware/rateLimiter';
import { auditService } from '../services/audit.service';
import { idParam, loadSite, resolveActor, type HostingNeed } from '../services/hosting/access';
import type { SiteRow } from '../services/hosting/rows';
import { parseBody } from '../services/docker/parseBody';
import { runtimeService } from '../services/docker/runtime.service';

// /api/sites/:id/runtime* — module orchestration (docs/P1-PLAN.md §6).
// Mounted on /sites after sites.routes.ts (no catch-all here).
//   GET    /:id/runtime                 → SiteRuntimeStatus (read)
//   POST   /:id/runtime/check           { base } → RuntimeSwitchCheck (read)
//   POST   /:id/runtime/switch          RuntimeSwitchRequest → SiteRuntimeStatus (sites.manage; plan allowedBases)
//   POST   /:id/runtime/preview/promote → SiteRuntimeStatus (sites.manage)
//   DELETE /:id/runtime/preview         → SiteRuntimeStatus (sites.manage)
//   POST   /:id/runtime/restart         → SiteRuntimeStatus (sites.manage)
// Access is checked BEFORE the body is parsed (an invisible site is a 404
// whatever the body).

const router = Router();

const baseSchema = z.string().refine((v): v is SiteBaseId => isSiteBaseId(v), 'unknown site base');
export const checkSchema = z.object({ base: baseSchema }).strict();
export const switchSchema = z.object({
  base: baseSchema,
  mode: z.enum(['direct', 'preview']).default('direct'),
}).strict();

/** Needs of each runtime route (A1: every route goes through access.ts). */
export const RUNTIME_NEEDS = {
  status: 'read',
  check: 'read',
  switch: 'sites.manage',
  promote: 'sites.manage',
  stopPreview: 'sites.manage',
  restart: 'sites.manage',
} as const satisfies Record<string, HostingNeed>;

async function site(req: Request, need: HostingNeed): Promise<SiteRow> {
  const actor = await resolveActor(req);
  return loadSite(actor, idParam(req), need);
}

function audit(req: Request, row: SiteRow, action: string, details: Record<string, unknown>): Promise<void> {
  return auditService.logReqAs(req, row.tenant_id, action, { resourceType: 'site', resourcePath: String(row.id), details: { siteName: row.name, ...details } });
}

router.get('/:id/runtime', async (req, res, next) => {
  try {
    const row = await site(req, RUNTIME_NEEDS.status);
    res.json({ success: true, data: await runtimeService.status(row.id) });
  } catch (err) { next(err); }
});

router.post('/:id/runtime/check', heavyOpLimiter, async (req, res, next) => {
  try {
    const row = await site(req, RUNTIME_NEEDS.check);
    const { base } = parseBody(checkSchema, req.body);
    res.json({ success: true, data: await runtimeService.checkSwitch(row.id, base) });
  } catch (err) { next(err); }
});

router.post('/:id/runtime/switch', heavyOpLimiter, async (req, res, next) => {
  try {
    const row = await site(req, RUNTIME_NEEDS.switch);
    const { base, mode } = parseBody(switchSchema, req.body);
    if (mode === 'preview') {
      await runtimeService.startPreview(row.id, base);
      await audit(req, row, 'runtime.preview', { action: 'start', base, currentBase: row.base });
    } else {
      await runtimeService.switchBase(row.id, base);
      await audit(req, row, 'runtime.switch', { from: row.base, to: base });
    }
    res.json({ success: true, data: await runtimeService.status(row.id) });
  } catch (err) { next(err); }
});

router.post('/:id/runtime/preview/promote', async (req, res, next) => {
  try {
    const row = await site(req, RUNTIME_NEEDS.promote);
    await runtimeService.promotePreview(row.id);
    await audit(req, row, 'runtime.promote', { from: row.base, to: row.preview_base });
    res.json({ success: true, data: await runtimeService.status(row.id) });
  } catch (err) { next(err); }
});

router.delete('/:id/runtime/preview', async (req, res, next) => {
  try {
    const row = await site(req, RUNTIME_NEEDS.stopPreview);
    if (row.preview_base) {
      await runtimeService.stopPreview(row.id);
      await audit(req, row, 'runtime.preview', { action: 'stop', base: row.preview_base });
    }
    res.json({ success: true, data: await runtimeService.status(row.id) });
  } catch (err) { next(err); }
});

router.post('/:id/runtime/restart', async (req, res, next) => {
  try {
    const row = await site(req, RUNTIME_NEEDS.restart);
    await runtimeService.restartSite(row.id);
    res.json({ success: true, data: await runtimeService.status(row.id) });
  } catch (err) { next(err); }
});

export default router;
