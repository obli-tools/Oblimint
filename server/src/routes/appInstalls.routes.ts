import { Router } from 'express';
import { APP_INSTALL_STATUSES, type AppInstallStatus } from '@oblimint/shared';
import { heavyOpLimiter } from '../middleware/rateLimiter';
import { appInstallService } from '../services/appInstall/appInstall.service';
import { parseBody } from '../services/docker/parseBody';
import { idParam, resolveActor } from '../services/hosting/access';
import { gateStrictest } from '../services/restrictions/gate';
import { appInstallStartSchema } from '../validators/appInstall.schema';

// /api/app-installs — immutable application installer (shared/src/appInstall.ts).
//   GET  /                ?accountId=&status=a,b → AppInstall[]                 sites.manage on each
//   GET  /:id                                    → AppInstall (never the password)
//   POST /                AppInstallStartRequest → 201 AppInstallStartResult (the admin password, once)
//   POST /:id/retry                              → AppInstallRetryResult (resumes at the failed step)
//   POST /:id/publish                            → AppInstall (after a preview)
//   POST /:id/cleanup                            → AppInstall (removes what the operation created)
// Order of every route: rights and refusals (404 / 403 / 409), then the gate, then the effect.

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const accountId = Number(req.query.accountId) || null;
    const statuses = String(req.query.status ?? '').split(',').filter((s): s is AppInstallStatus => (APP_INSTALL_STATUSES as readonly string[]).includes(s));
    res.json({ success: true, data: await appInstallService.list(actor, { accountId, statuses }) });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await appInstallService.get(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/', heavyOpLimiter, async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const body = parseBody(appInstallStartSchema, req.body);
    const pre = await appInstallService.preflight(actor, body);
    await gateStrictest(req, appInstallService.startGates(pre, body));
    const data = await appInstallService.start(req, actor, body, pre);
    // The admin password must never rest in a cache.
    res.set('Cache-Control', 'no-store').status(201).json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/:id/retry', heavyOpLimiter, async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const row = await appInstallService.loadRow(actor, idParam(req));
    await gateStrictest(req, appInstallService.retryGates(row));
    const data = await appInstallService.retry(req, actor, Number(row.id));
    res.set('Cache-Control', 'no-store').json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/:id/publish', heavyOpLimiter, async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const row = await appInstallService.loadRow(actor, idParam(req));
    await gateStrictest(req, appInstallService.publishGates(row));
    res.json({ success: true, data: await appInstallService.publishAfterPreview(req, actor, Number(row.id)) });
  } catch (err) { next(err); }
});

router.post('/:id/cleanup', heavyOpLimiter, async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const row = await appInstallService.loadRow(actor, idParam(req));
    await gateStrictest(req, appInstallService.cleanupGates(row));
    res.json({ success: true, data: await appInstallService.cleanup(req, actor, Number(row.id)) });
  } catch (err) { next(err); }
});

export default router;
