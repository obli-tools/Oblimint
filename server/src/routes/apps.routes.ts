import { Router, type Request } from 'express';
import { z } from 'zod';
import { APP_TEMPLATE_CATEGORIES, type AppStackStatus, type AppTemplateCategory } from '@oblimint/shared';
import { heavyOpLimiter } from '../middleware/rateLimiter';
import { AppError } from '../middleware/errorHandler';
import { appsService } from '../services/apps/apps.service';
import { catalogService } from '../services/apps/catalog.service';
import { appPolicyService } from '../services/apps/policy.service';
import { registryCredentialService } from '../services/apps/registry.service';
import { parseBody } from '../services/docker/parseBody';
import { idParam, resolveActor } from '../services/hosting/access';

// /api/apps — OWNED BY MODULE `apps-core` (docs/P4b-PLAN.md §6.1). Contract below FROZEN (validation zod +
// access in the module). Tenant router (requireAuth + requireTenant). Needs: read = account member / staff
// read; changes = apps.manage on the stack's account; console = apps.console (socket); policy = platform admin.
//
//   GET    /stacks?accountId&tenantId&status&search            → AppStack[]                      (read, scoped)
//   POST   /stacks                     AppStackCreate          → AppStackDetail (201)            (apps.manage on accountId)
//   GET    /stacks/:id                                         → AppStackDetail                  (read)
//   PUT    /stacks/:id                 AppStackUpdate          → AppStackDetail                  (apps.manage)
//   DELETE /stacks/:id                 AppStackDeleteRequest   → { deleted: true }               (apps.manage; confirm = name)
//   GET    /stacks/:id/env                                     → AppEnvResponse                  (apps.manage, audited)
//   POST   /stacks/:id/source/zip      application/zip body    → AppStackDetail                  (apps.manage; source zip)
//   POST   /stacks/:id/source/pull     { deploy?: boolean }    → { commit, changed, deployment } (apps.manage; source git)
//   POST   /stacks/:id/actions         AppActionRequest        → AppDeployment (202)             (apps.manage)
//   GET    /stacks/:id/deployments?limit&offset                → { items: AppDeployment[], total } (read)
//   GET    /stacks/:id/deployments/:depId                      → AppDeploymentDetail             (read)
//   POST   /stacks/:id/deployments/:depId/cancel               → { cancelled }                   (apps.manage)
//   POST   /stacks/:id/rollback        AppRollbackRequest      → AppDeployment (202)             (apps.manage)
//   POST   /stacks/:id/updates/check                           → AppUpdateCheck                  (apps.manage; 1 / min / stack)
//   POST   /stacks/:id/updates/apply   AppUpdateApplyRequest   → AppDeployment (202)             (apps.manage)
//   POST   /stacks/:id/updates/rollback AppImageRollbackRequest → AppDeployment (202)            (apps.manage)
//   PUT    /stacks/:id/services/:service AppServiceUpdate      → AppServiceInfo                  (apps.manage)
//   POST   /stacks/:id/sleep                                   → AppDeployment (202)             (apps.manage)
//   POST   /stacks/:id/wake                                    → AppDeployment (202)             (apps.manage)
//   POST   /stacks/:id/containers/:service/:action  (start|stop|restart) → AppServiceInfo       (apps.manage)
//   GET    /stacks/:id/containers/:service/logs?tail&since     → AppLogsResponse                 (read)
//   GET    /stacks/:id/containers/:service/inspect             → AppContainerInspect             (read; env values: apps.manage, secrets masked)
//   POST   /validate                   ComposeValidateRequest  → ComposeValidationResult         (apps.manage on accountId; heavyOpLimiter)
//   GET    /resources?accountId                                → AppResourceSummary              (read)
//   GET    /catalog?category&search                            → AppTemplate[]                   (read: any member)
//   GET    /catalog/:slug                                      → AppTemplateDetail               (read)
//   POST   /catalog                    AppTemplateInput        → AppTemplateDetail (201)         (staff apps.manage; tenantId null: platform admin)
//   PUT    /catalog/:id                Partial<AppTemplateInput> → AppTemplateDetail             (same; builtins read-only → 409 templateBuiltin)
//   DELETE /catalog/:id                                        → { deleted: true }               (same)
//   GET    /registries?accountId&tenantId                      → AppRegistryCredential[]         (read)
//   POST   /registries                 AppRegistryCredentialInput → AppRegistryCredential (201)  (apps.manage)
//   PUT    /registries/:id             AppRegistryCredentialUpdate → AppRegistryCredential       (apps.manage)
//   DELETE /registries/:id                                     → { deleted: true }               (apps.manage)
//   GET    /policy/tenants/:tenantId                           → TenantAppPolicy                 (platform admin)
//   PUT    /policy/tenants/:tenantId   TenantAppPolicyUpdate   → TenantAppPolicy                 (platform admin, audited)
//
// Codes: planLimit (409, details.dimension ∈ appStacks | appContainers | appsCpu | appsMemory), appsDisabled (409),
// stackNameTaken (409), composeInvalid (400, details.issues: ComposeIssue[]), imageNotAllowed (400), buildNotAllowed (403),
// sourceTypeMismatch (409), stackBusy (409: an action is running), zipTooLarge (413), zipInvalid (400), gitUnreachable (502),
// gitAuthFailed (502), gitTokenRequired (400: new repository URL without its token), registryAuthFailed (502), deploymentNotFound (404), nothingToRollback (409), serviceNotFound (404),
// consoleDisabled (403), accountSuspended (409), confirmMismatch (400), templateNotFound (404), templateBuiltin (409),
// backendUnavailable (502, A6: Docker / hostd errors never detailed to a client).
//
// Access checks happen in the service (row loaded, 404 invisible / 403 without the need) BEFORE the
// semantic checks of the body; bodies are shape-validated here (zod, strict).

const router = Router();

const COMPOSE_MAX = 256 * 1024;
const ENV_MAX = 64 * 1024;
const STATUSES = ['draft', 'deploying', 'running', 'partial', 'stopped', 'sleeping', 'error', 'deleting'] as const;
const scalar = z.union([z.string().max(2048), z.number(), z.boolean()]);

const updatePolicySchema = z.object({
  autoUpdate: z.boolean().optional(),
  checkIntervalMin: z.number().int().min(1).max(10080).optional(),
  maintenanceWindowId: z.number().int().positive().nullable().optional(),
  notify: z.boolean().optional(),
}).strict();

const sleepPolicySchema = z.object({
  enabled: z.boolean().optional(),
  idleMinutes: z.number().int().min(1).max(10080).optional(),
  mode: z.enum(['stop', 'pause']).optional(),
  wakeTimeoutSec: z.number().int().min(1).max(3600).optional(),
  readyPath: z.string().max(256).nullable().optional(),
  wakingPageId: z.number().int().positive().nullable().optional(),
}).strict();

const gitSchema = z.object({
  repoUrl: z.string().min(1).max(512),
  branch: z.string().min(1).max(200).optional(),
  composePath: z.string().max(255).optional(),
  token: z.string().max(4096).nullable().optional(),
  build: z.boolean().optional(),
  pollIntervalSec: z.number().int().min(1).max(86400 * 7).nullable().optional(),
  autoDeploy: z.boolean().optional(),
}).strict();

const createSchema = z.object({
  accountId: z.number().int().positive(),
  name: z.string().min(1).max(31),
  displayName: z.string().max(128).optional(),
  description: z.string().max(2000).nullable().optional(),
  sourceType: z.enum(['editor', 'git', 'zip', 'catalog']),
  composeYaml: z.string().max(COMPOSE_MAX).optional(),
  env: z.string().max(ENV_MAX).optional(),
  git: gitSchema.optional(),
  catalog: z.object({ templateSlug: z.string().min(1).max(64), values: z.record(scalar).default({}) }).strict().optional(),
  registryCredentialIds: z.array(z.number().int().positive()).max(50).optional(),
  updatePolicy: updatePolicySchema.optional(),
  sleepPolicy: sleepPolicySchema.optional(),
  deploy: z.boolean().optional(),
}).strict();

const updateSchema = z.object({
  displayName: z.string().max(128).optional(),
  description: z.string().max(2000).nullable().optional(),
  composeYaml: z.string().max(COMPOSE_MAX).optional(),
  env: z.string().max(ENV_MAX).optional(),
  git: gitSchema.optional(),
  catalogValues: z.record(scalar).optional(),
  registryCredentialIds: z.array(z.number().int().positive()).max(50).optional(),
  updatePolicy: updatePolicySchema.optional(),
  sleepPolicy: sleepPolicySchema.optional(),
}).strict();

const deleteSchema = z.object({ confirm: z.string().max(64), removeVolumes: z.boolean().optional() }).strict();
const pullSchema = z.object({ deploy: z.boolean().optional() }).strict();
const actionSchema = z.object({
  action: z.enum(['deploy', 'redeploy', 'recreate', 'pull', 'start', 'stop', 'restart', 'down']),
  build: z.boolean().optional(),
}).strict();
const rollbackSchema = z.object({ deploymentId: z.number().int().positive() }).strict();
const applySchema = z.object({ services: z.array(z.string().max(64)).max(50).optional() }).strict();
const imageRollbackSchema = z.object({ service: z.string().min(1).max(64) }).strict();
const serviceUpdateSchema = z.object({ excludedFromUpdates: z.boolean().optional() }).strict();
const validateSchema = z.object({
  accountId: z.number().int().positive(),
  composeYaml: z.string().max(COMPOSE_MAX),
  env: z.string().max(ENV_MAX).optional(),
  stackId: z.number().int().positive().nullable().optional(),
}).strict();

const fieldSchema = z.object({
  key: z.string().min(1).max(128),
  labelKey: z.string().max(128).nullable(),
  label: z.string().min(1).max(128),
  description: z.string().max(1000).nullable(),
  type: z.enum(['string', 'password', 'number', 'boolean', 'select', 'email', 'url', 'domain']),
  required: z.boolean(),
  default: z.union([z.string().max(2048), z.number(), z.boolean()]).nullable(),
  options: z.array(z.string().max(256)).max(100).nullable(),
  generate: z.enum(['password', 'hex32', 'base64-32', 'uuid']).nullable(),
  secret: z.boolean(),
  pattern: z.string().max(512).nullable(),
}).strict();

const templateSchema = z.object({
  slug: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  icon: z.string().max(255).optional(),
  category: z.enum(APP_TEMPLATE_CATEGORIES as unknown as [AppTemplateCategory, ...AppTemplateCategory[]]),
  description: z.string().max(4000),
  docsUrl: z.string().url().max(512).nullable().optional(),
  version: z.string().min(1).max(32),
  composeYaml: z.string().min(1).max(COMPOSE_MAX),
  fields: z.array(fieldSchema).max(50),
  defaultProxy: z.object({ service: z.string().min(1).max(64), port: z.number().int().min(1).max(65535) }).strict().nullable().optional(),
  minMemoryMb: z.number().int().min(0).max(1_048_576).nullable().optional(),
  enabled: z.boolean().optional(),
  tenantId: z.number().int().positive().nullable().optional(),
}).strict();

const registryCreateSchema = z.object({
  accountId: z.number().int().positive(),
  registry: z.string().min(1).max(253),
  username: z.string().min(1).max(255),
  password: z.string().min(1).max(4096),
}).strict();
const registryUpdateSchema = z.object({ username: z.string().min(1).max(255).optional(), password: z.string().min(1).max(4096).optional() }).strict();

const policySchema = z.object({
  allowedRegistries: z.array(z.string().min(1).max(253)).max(100).nullable().optional(),
  deniedImages: z.array(z.string().min(1).max(255)).max(500).optional(),
  allowBuild: z.boolean().nullable().optional(),
  allowConsole: z.boolean().nullable().optional(),
  allowExternalProxyTargets: z.boolean().nullable().optional(),
}).strict();

/** Optional positive integer query parameter (absent → null, invalid → 400). */
function queryId(req: Request, name: string): number | null {
  const raw = req.query[name];
  if (raw === undefined || raw === '') return null;
  const v = Number(raw);
  if (typeof raw !== 'string' || !Number.isInteger(v) || v <= 0) throw new AppError(400, `${name} must be a positive integer`, 'validation');
  return v;
}

function queryInt(req: Request, name: string, fallback: number): number {
  const raw = req.query[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (typeof raw !== 'string' || !Number.isInteger(v) || v < 0) throw new AppError(400, `${name} must be a non-negative integer`, 'validation');
  return v;
}

function queryText(req: Request, name: string, max = 128): string | null {
  const raw = req.query[name];
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > max) throw new AppError(400, `Invalid ${name}`, 'validation');
  return raw;
}

function serviceParam(req: Request): string {
  const s = req.params.service;
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(s ?? '')) throw new AppError(404, 'Service not found', 'serviceNotFound');
  return s;
}

/** Platform admin only (staff '*' with the god view). */
async function requirePlatformAdmin(req: Request): Promise<void> {
  const actor = await resolveActor(req);
  if (actor.kind !== 'staff' || actor.caps !== '*' || !actor.globalView) throw new AppError(403, 'Platform administrators only');
}

// ── stacks ──

router.get('/stacks', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const status = queryText(req, 'status', 16);
    if (status && !(STATUSES as readonly string[]).includes(status)) throw new AppError(400, 'Invalid status', 'validation');
    const data = await appsService.list(actor, {
      accountId: queryId(req, 'accountId'), tenantId: queryId(req, 'tenantId'), status: status as AppStackStatus | null, search: queryText(req, 'search'),
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/stacks', heavyOpLimiter, async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const data = await appsService.create(req, actor, parseBody(createSchema, req.body));
    res.status(201).json({ success: true, data });
  } catch (err) { next(err); }
});

router.get('/stacks/:id', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await appsService.get(actor, idParam(req)) });
  } catch (err) { next(err); }
});

router.put('/stacks/:id', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const id = idParam(req);
    res.json({ success: true, data: await appsService.update(req, actor, id, parseBody(updateSchema, req.body)) });
  } catch (err) { next(err); }
});

router.delete('/stacks/:id', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await appsService.remove(req, actor, idParam(req), parseBody(deleteSchema, req.body)) });
  } catch (err) { next(err); }
});

router.get('/stacks/:id/env', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await appsService.getEnv(req, actor, idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/stacks/:id/source/zip', heavyOpLimiter, async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    if (!req.is(['application/zip', 'application/x-zip-compressed', 'application/octet-stream'])) {
      throw new AppError(415, 'The archive must be sent as application/zip', 'unsupportedMediaType');
    }
    res.json({ success: true, data: await appsService.uploadZip(req, actor, idParam(req), req) });
  } catch (err) {
    // Never leave an unread upload behind (the connection would stall).
    if (!req.readableEnded) req.resume();
    next(err);
  }
});

router.post('/stacks/:id/source/pull', heavyOpLimiter, async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const body = parseBody(pullSchema, req.body);
    res.json({ success: true, data: await appsService.gitPull(req, actor, idParam(req), { deploy: !!body.deploy }) });
  } catch (err) { next(err); }
});

router.post('/stacks/:id/actions', heavyOpLimiter, async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const id = idParam(req);
    const body = parseBody(actionSchema, req.body);
    res.status(202).json({ success: true, data: await appsService.action(req, actor, id, body) });
  } catch (err) { next(err); }
});

router.get('/stacks/:id/deployments', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const data = await appsService.listDeployments(actor, idParam(req), { limit: Math.min(200, queryInt(req, 'limit', 50) || 50), offset: queryInt(req, 'offset', 0) });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.get('/stacks/:id/deployments/:depId', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await appsService.getDeployment(actor, idParam(req), idParam(req, 'depId')) });
  } catch (err) { next(err); }
});

router.post('/stacks/:id/deployments/:depId/cancel', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await appsService.cancelDeployment(req, actor, idParam(req), idParam(req, 'depId')) });
  } catch (err) { next(err); }
});

router.post('/stacks/:id/rollback', heavyOpLimiter, async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.status(202).json({ success: true, data: await appsService.rollback(req, actor, idParam(req), parseBody(rollbackSchema, req.body)) });
  } catch (err) { next(err); }
});

router.post('/stacks/:id/updates/check', heavyOpLimiter, async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await appsService.checkUpdates(req, actor, idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/stacks/:id/updates/apply', heavyOpLimiter, async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.status(202).json({ success: true, data: await appsService.applyUpdates(req, actor, idParam(req), parseBody(applySchema, req.body)) });
  } catch (err) { next(err); }
});

router.post('/stacks/:id/updates/rollback', heavyOpLimiter, async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.status(202).json({ success: true, data: await appsService.rollbackImage(req, actor, idParam(req), parseBody(imageRollbackSchema, req.body)) });
  } catch (err) { next(err); }
});

router.put('/stacks/:id/services/:service', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const data = await appsService.updateService(req, actor, idParam(req), serviceParam(req), parseBody(serviceUpdateSchema, req.body));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/stacks/:id/sleep', heavyOpLimiter, async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.status(202).json({ success: true, data: await appsService.sleep(req, actor, idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/stacks/:id/wake', heavyOpLimiter, async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.status(202).json({ success: true, data: await appsService.wake(req, actor, idParam(req)) });
  } catch (err) { next(err); }
});

router.get('/stacks/:id/containers/:service/logs', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const data = await appsService.containerLogs(actor, idParam(req), serviceParam(req), {
      tail: queryInt(req, 'tail', 200), since: queryText(req, 'since', 64),
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.get('/stacks/:id/containers/:service/inspect', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await appsService.containerInspect(actor, idParam(req), serviceParam(req)) });
  } catch (err) { next(err); }
});

router.post('/stacks/:id/containers/:service/:action', heavyOpLimiter, async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const action = req.params.action;
    if (action !== 'start' && action !== 'stop' && action !== 'restart') throw new AppError(404, 'Not found', 'notFound');
    res.json({ success: true, data: await appsService.containerAction(req, actor, idParam(req), serviceParam(req), action) });
  } catch (err) { next(err); }
});

// ── validation / resources ──

router.post('/validate', heavyOpLimiter, async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await appsService.validate(actor, parseBody(validateSchema, req.body)) });
  } catch (err) { next(err); }
});

router.get('/resources', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const accountId = queryId(req, 'accountId');
    if (!accountId) throw new AppError(400, 'accountId is required', 'validation');
    res.json({ success: true, data: await appsService.resources(actor, accountId) });
  } catch (err) { next(err); }
});

// ── catalog ──

router.get('/catalog', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const category = queryText(req, 'category', 24);
    if (category && !(APP_TEMPLATE_CATEGORIES as readonly string[]).includes(category)) throw new AppError(400, 'Invalid category', 'validation');
    res.json({ success: true, data: await catalogService.list(actor, { category: category as AppTemplateCategory | null, search: queryText(req, 'search') }) });
  } catch (err) { next(err); }
});

router.get('/catalog/:slug', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await catalogService.get(actor, String(req.params.slug)) });
  } catch (err) { next(err); }
});

router.post('/catalog', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    if (actor.kind !== 'staff') throw new AppError(403, 'Insufficient permissions');
    res.status(201).json({ success: true, data: await catalogService.create(req, actor, parseBody(templateSchema, req.body)) });
  } catch (err) { next(err); }
});

router.put('/catalog/:id', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await catalogService.update(req, actor, idParam(req), parseBody(templateSchema.partial(), req.body)) });
  } catch (err) { next(err); }
});

router.delete('/catalog/:id', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await catalogService.remove(req, actor, idParam(req)) });
  } catch (err) { next(err); }
});

// ── registries ──

router.get('/registries', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await registryCredentialService.list(actor, { accountId: queryId(req, 'accountId'), tenantId: queryId(req, 'tenantId') }) });
  } catch (err) { next(err); }
});

router.post('/registries', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.status(201).json({ success: true, data: await registryCredentialService.create(req, actor, parseBody(registryCreateSchema, req.body)) });
  } catch (err) { next(err); }
});

router.put('/registries/:id', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await registryCredentialService.update(req, actor, idParam(req), parseBody(registryUpdateSchema, req.body)) });
  } catch (err) { next(err); }
});

router.delete('/registries/:id', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await registryCredentialService.remove(req, actor, idParam(req)) });
  } catch (err) { next(err); }
});

// ── per-tenant policy (platform admin) ──

router.get('/policy/tenants/:tenantId', async (req, res, next) => {
  try {
    await requirePlatformAdmin(req);
    res.json({ success: true, data: await appPolicyService.get(idParam(req, 'tenantId')) });
  } catch (err) { next(err); }
});

router.put('/policy/tenants/:tenantId', async (req, res, next) => {
  try {
    await requirePlatformAdmin(req);
    res.json({ success: true, data: await appPolicyService.set(req, idParam(req, 'tenantId'), parseBody(policySchema, req.body)) });
  } catch (err) { next(err); }
});

export default router;
