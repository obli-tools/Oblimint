import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { heavyOpLimiter } from '../middleware/rateLimiter';
import { idParam, resolveActor } from '../services/hosting/access';
import { loadOwned, type P4bTable } from '../services/hosting/p4bAccess';
import { sftpTargetService, sshKeyService } from '../services/monitoring/automation/credentials.service';
import { workflowService } from '../services/monitoring/automation/workflows.service';
import { appMaintenanceWindowService } from '../services/monitoring/maintenanceWindows.service';

// /api/automation — OWNED BY MODULE `monitoring-automation` (docs/P4b-PLAN.md §6.6). Tenant router.
// read = member / staff read; changes = monitoring.manage (restart-app actions also need apps.manage on the stack;
// export-certificate needs proxy.manage on the certificate's account; a platform certificate (panel / preview wildcard): platform admin only). accountId null rows: staff.
//   GET    /workflows?accountId&tenantId                           → Workflow[]
//   POST   /workflows              WorkflowInput                   → Workflow (201)
//   GET    /workflows/:id                                          → Workflow
//   PUT    /workflows/:id          WorkflowUpdate                  → Workflow
//   DELETE /workflows/:id                                          → { deleted: true }
//   POST   /workflows/:id/run                                      → WorkflowRun (202)  (409 workflowRunning)
//   GET    /workflows/:id/runs?limit&offset                        → { items: WorkflowRun[], total }
//   GET    /ssh-keys?accountId&tenantId                            → AutomationSshKey[]
//   POST   /ssh-keys               AutomationSshKeyCreate          → AutomationSshKey (201)
//   DELETE /ssh-keys/:id                                           → { deleted: true }  (409 sshKeyInUse)
//   GET    /sftp-targets?accountId&tenantId                        → SftpTarget[]
//   POST   /sftp-targets           SftpTargetInput                 → SftpTarget (201)
//   PUT    /sftp-targets/:id       SftpTargetUpdate                → SftpTarget
//   DELETE /sftp-targets/:id                                       → { deleted: true }  (409 sftpTargetInUse)
//   POST   /sftp-targets/:id/test                                  → SftpTargetTestResult (pins the host key the first time)
//   GET    /maintenance-windows?accountId&tenantId                 → AppMaintenanceWindow[]
//   POST   /maintenance-windows    AppMaintenanceWindowInput       → AppMaintenanceWindow (201)
//   PUT    /maintenance-windows/:id AppMaintenanceWindowUpdate     → AppMaintenanceWindow
//   DELETE /maintenance-windows/:id                                → { deleted: true }
// Codes: planLimit (409, dimension workflows), workflowsDisabled (409), invalidCron (400), targetNotAllowed (403),
// hostKeyMismatch (409: pinned fingerprint changed), sftpFailed (502), invalidSchedule (400), invalidTimezone (400).
// Notes: the export-certificate certificate must belong to the workflow's own account (platform workflow: platform
// certificate); a failed SFTP test answers 200 { ok: false, error } with a generic error text (A6) — sftpFailed is
// not used by these routes; access is checked BEFORE a body is validated.

const router = Router();

const optId = z.coerce.number().int().positive().optional();
const listQuery = z.object({ accountId: optId, tenantId: optId });
const accountId = z.number().int().positive().nullable();
const name = z.string().trim().min(1).max(128);

function guard(table: P4bTable, what: string) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      await loadOwned(await resolveActor(req), table, idParam(req), 'monitoring.manage', what);
      next();
    } catch (err) { next(err); }
  };
}

function list<T>(fn: (actor: Awaited<ReturnType<typeof resolveActor>>, q: z.infer<typeof listQuery>) => Promise<T>) {
  return [validate(listQuery, 'query'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await fn(await resolveActor(req), req.query as unknown as z.infer<typeof listQuery>) });
    } catch (err) { next(err); }
  }] as const;
}

// ── workflows ────────────────────────────────────────────────────────────────

const trigger = z.object({
  kind: z.enum(['cert-renewal', 'interval', 'cron', 'manual']),
  intervalMinutes: z.number().int().nullable().optional(),
  cron: z.string().max(120).nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
  certificateNames: z.array(z.string().trim().max(253)).max(50).optional(),
}).strict();

const action = z.object({
  kind: z.enum(['export-certificate', 'restart-app']),
  certificate: z.object({ kind: z.enum(['acme', 'imported']), id: z.number().int().positive() }).strict().nullable().optional(),
  sftpTargetId: z.number().int().positive().nullable().optional(),
  remotePath: z.string().max(1024).nullable().optional(),
  format: z.enum(['pem-split', 'pem-bundle']).optional(),
  stackId: z.number().int().positive().nullable().optional(),
  services: z.array(z.string().max(64)).max(50).optional(),
}).strict();

const workflowInput = z.object({ accountId, name, enabled: z.boolean().optional(), trigger, actions: z.array(action).min(1).max(10) }).strict();
const workflowUpdate = z.object({ name: name.optional(), enabled: z.boolean().optional(), trigger: trigger.optional(), actions: z.array(action).min(1).max(10).optional() }).strict();
const runsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).default(0) });

router.get('/workflows', ...list((actor, q) => workflowService.list(actor, q)));

router.post('/workflows', validate(workflowInput), async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await workflowService.create(req, await resolveActor(req), req.body) });
  } catch (err) { next(err); }
});

router.get('/workflows/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await workflowService.get(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.put('/workflows/:id', guard('workflows', 'Workflow'), validate(workflowUpdate), async (req, res, next) => {
  try {
    res.json({ success: true, data: await workflowService.update(req, await resolveActor(req), idParam(req), req.body) });
  } catch (err) { next(err); }
});

router.delete('/workflows/:id', async (req, res, next) => {
  try {
    await workflowService.remove(req, await resolveActor(req), idParam(req));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

router.post('/workflows/:id/run', heavyOpLimiter, async (req, res, next) => {
  try {
    res.status(202).json({ success: true, data: await workflowService.run(req, await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.get('/workflows/:id/runs', validate(runsQuery, 'query'), async (req, res, next) => {
  try {
    const q = req.query as unknown as z.infer<typeof runsQuery>;
    res.json({ success: true, data: await workflowService.runs(await resolveActor(req), idParam(req), q.limit, q.offset) });
  } catch (err) { next(err); }
});

// ── SSH keys ─────────────────────────────────────────────────────────────────

const sshKeyCreate = z.object({ accountId, name, privateKey: z.string().max(16 * 1024).nullable().optional() }).strict();

router.get('/ssh-keys', ...list((actor, q) => sshKeyService.list(actor, q)));

router.post('/ssh-keys', validate(sshKeyCreate), async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await sshKeyService.create(req, await resolveActor(req), req.body) });
  } catch (err) { next(err); }
});

router.delete('/ssh-keys/:id', async (req, res, next) => {
  try {
    await sshKeyService.remove(req, await resolveActor(req), idParam(req));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

// ── SFTP targets ─────────────────────────────────────────────────────────────

const targetFields = {
  name,
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().min(1).max(128).regex(/^[^\0-\x1f\x7f]+$/, 'no control characters'),
  authMethod: z.enum(['key', 'password']),
  sshKeyId: z.number().int().positive().nullable().optional(),
  password: z.string().min(1).max(1024).optional(),
  basePath: z.string().min(1).max(1024).optional(),
  resetHostKey: z.boolean().optional(),
};
const targetInput = z.object({ accountId, ...targetFields }).strict();
const targetUpdate = z.object({
  ...targetFields, name: name.optional(), host: targetFields.host.optional(), username: targetFields.username.optional(), authMethod: targetFields.authMethod.optional(),
}).strict();

router.get('/sftp-targets', ...list((actor, q) => sftpTargetService.list(actor, q)));

router.post('/sftp-targets', validate(targetInput), async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await sftpTargetService.create(req, await resolveActor(req), req.body) });
  } catch (err) { next(err); }
});

router.put('/sftp-targets/:id', guard('sftp_targets', 'SFTP target'), validate(targetUpdate), async (req, res, next) => {
  try {
    res.json({ success: true, data: await sftpTargetService.update(req, await resolveActor(req), idParam(req), req.body) });
  } catch (err) { next(err); }
});

router.delete('/sftp-targets/:id', async (req, res, next) => {
  try {
    await sftpTargetService.remove(req, await resolveActor(req), idParam(req));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

router.post('/sftp-targets/:id/test', heavyOpLimiter, async (req, res, next) => {
  try {
    res.json({ success: true, data: await sftpTargetService.test(req, await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

// ── maintenance windows ──────────────────────────────────────────────────────

// Shapes only: the service answers invalidSchedule / invalidTimezone for the semantics.
const schedule = z.object({
  days: z.array(z.number().int()).max(7),
  start: z.string().max(5),
  durationMinutes: z.number().int(),
  timezone: z.string().max(64),
}).strict();
const windowInput = z.object({ accountId, name, schedule, enabled: z.boolean().optional(), isDefault: z.boolean().optional() }).strict();
const windowUpdate = z.object({ name: name.optional(), schedule: schedule.optional(), enabled: z.boolean().optional(), isDefault: z.boolean().optional() }).strict();

router.get('/maintenance-windows', ...list((actor, q) => appMaintenanceWindowService.list(actor, q)));

router.post('/maintenance-windows', validate(windowInput), async (req, res, next) => {
  try {
    res.status(201).json({ success: true, data: await appMaintenanceWindowService.create(req, await resolveActor(req), req.body) });
  } catch (err) { next(err); }
});

router.put('/maintenance-windows/:id', guard('app_maintenance_windows', 'Maintenance window'), validate(windowUpdate), async (req, res, next) => {
  try {
    res.json({ success: true, data: await appMaintenanceWindowService.update(req, await resolveActor(req), idParam(req), req.body) });
  } catch (err) { next(err); }
});

router.delete('/maintenance-windows/:id', async (req, res, next) => {
  try {
    await appMaintenanceWindowService.remove(req, await resolveActor(req), idParam(req));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

export default router;
