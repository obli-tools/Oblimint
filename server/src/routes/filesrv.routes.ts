import { Router, type Request } from 'express';
import { z } from 'zod';
import { auditService } from '../services/audit.service';
import { idParam, loadAccount, resolveActor, type HostingNeed } from '../services/hosting/access';
import type { AccountRow } from '../services/hosting/rows';
import { ACTIVATE_MAX_MINUTES, ACTIVATE_MIN_MINUTES, fileServerService } from '../services/docker/filesrv.service';
import { parseBody } from '../services/docker/parseBody';

// /api/accounts/:id/filesrv* — module orchestration (docs/P1-PLAN.md §6, §10).
// Mounted on /accounts after accounts.routes.ts (no catch-all here).
//   GET  /:id/filesrv            → FileServerStatus (read)
//   POST /:id/filesrv/activate   FileServerActivateRequest → FileServerStatus (files.manage; 409 fileServerOff)
//   POST /:id/filesrv/deactivate → FileServerStatus (files.manage)

const router = Router();

export const activateSchema = z.object({
  minutes: z.number().int().min(ACTIVATE_MIN_MINUTES).max(ACTIVATE_MAX_MINUTES).default(120),
}).strict();

export const FILESRV_NEEDS = {
  status: 'read',
  activate: 'files.manage',
  deactivate: 'files.manage',
} as const satisfies Record<string, HostingNeed>;

async function account(req: Request, need: HostingNeed): Promise<AccountRow> {
  const actor = await resolveActor(req);
  return loadAccount(actor, idParam(req), need);
}

router.get('/:id/filesrv', async (req, res, next) => {
  try {
    const row = await account(req, FILESRV_NEEDS.status);
    res.json({ success: true, data: await fileServerService.status(row.id) });
  } catch (err) { next(err); }
});

router.post('/:id/filesrv/activate', async (req, res, next) => {
  try {
    const row = await account(req, FILESRV_NEEDS.activate);
    const { minutes } = parseBody(activateSchema, req.body);
    const data = await fileServerService.activate(row.id, minutes);
    await auditService.logReqAs(req, row.tenant_id, 'filesrv.activate', {
      resourceType: 'account', resourcePath: String(row.id), details: { username: row.username, minutes, mode: row.filesrv_mode, activeUntil: data.activeUntil },
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/:id/filesrv/deactivate', async (req, res, next) => {
  try {
    const row = await account(req, FILESRV_NEEDS.deactivate);
    const data = await fileServerService.deactivate(row.id);
    await auditService.logReqAs(req, row.tenant_id, 'filesrv.deactivate', {
      resourceType: 'account', resourcePath: String(row.id), details: { username: row.username, mode: row.filesrv_mode },
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

export default router;
