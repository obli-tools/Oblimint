import { Router, type Request } from 'express';
import { validate } from '../middleware/validate';
import { idParam, resolveActor } from '../services/hosting/access';
import { sitesService } from '../services/hosting/sites.service';
import {
  applyProfileSchema, dataPathInputSchema, dataPathUpdateSchema, runtimeInputSchema, siteCreateSchema, siteUpdateSchema,
  type DataPathInputBody, type DataPathUpdateBody, type SiteCreateBody, type SiteUpdateBody,
} from '../validators/hosting.schema';

// /api/sites — OWNED BY MODULE `hosting-api` (docs/P1-PLAN.md §API).
// NO catch-all middleware here: /api/sites/:id/releases*, /staging* (module
// releases) and /runtime* (module orchestration) are mounted after this router.
//   GET    /                       ?accountId=&search= → Site[]
//   POST   /                       SiteCreate → Site (sites.manage on the account)
//   GET    /:id                    → Site
//   PUT    /:id                    SiteUpdate → Site (sites.manage)
//   DELETE /:id                    { confirm: slug } → { deleted: true } (sites.manage)
//   POST   /:id/stop | /:id/start  → Site (sites.manage)
//   GET    /:id/data-paths         → SiteDataPath[]
//   POST   /:id/data-paths         SiteDataPathInput → SiteDataPath (sites.manage)
//   POST   /:id/data-paths/apply-profile { profile } → SiteDataPath[] (sites.manage)
//   PUT    /:id/data-paths/:pid    { policy?, allowedExtensions? } → SiteDataPath (sites.manage)
//   DELETE /:id/data-paths/:pid    → { deleted: true } (sites.manage)
//   GET    /:id/runtimes           → SiteRuntime[]
//   POST   /:id/runtimes           SiteRuntimeInput → SiteRuntime (sites.manage)
//   DELETE /:id/runtimes/:rid      → { deleted: true } (sites.manage; 409 runtimeInUse)
//   GET    /:id/routes             → SiteRoute[] (routes targeting this site)
//
// Data paths: the container configuration follows at once (reconcile), but the
// release symlinks (<path> → /srv/data/<path>) only change at the NEXT publish.
const router = Router();

const optionalId = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const confirmOf = (req: Request): unknown => (req.body && typeof req.body === 'object' && 'confirm' in req.body ? req.body.confirm : req.query.confirm);

// ── Sites ────────────────────────────────────────────────────────────────────

router.get('/', async (req, res, next) => {
  try {
    const data = await sitesService.list(await resolveActor(req), {
      accountId: optionalId(req.query.accountId),
      search: typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : undefined,
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/', validate(siteCreateSchema), async (req, res, next) => {
  try {
    const site = await sitesService.create(req, await resolveActor(req), req.body as SiteCreateBody);
    res.status(201).json({ success: true, data: site });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await sitesService.get(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.put('/:id', validate(siteUpdateSchema), async (req, res, next) => {
  try {
    res.json({ success: true, data: await sitesService.update(req, await resolveActor(req), idParam(req), req.body as SiteUpdateBody) });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await sitesService.remove(req, await resolveActor(req), idParam(req), confirmOf(req));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

router.post('/:id/stop', async (req, res, next) => {
  try {
    res.json({ success: true, data: await sitesService.setStopped(req, await resolveActor(req), idParam(req), true) });
  } catch (err) { next(err); }
});

router.post('/:id/start', async (req, res, next) => {
  try {
    res.json({ success: true, data: await sitesService.setStopped(req, await resolveActor(req), idParam(req), false) });
  } catch (err) { next(err); }
});

// ── Data paths ───────────────────────────────────────────────────────────────

router.get('/:id/data-paths', async (req, res, next) => {
  try {
    res.json({ success: true, data: await sitesService.listDataPaths(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/:id/data-paths', validate(dataPathInputSchema), async (req, res, next) => {
  try {
    const path = await sitesService.addDataPath(req, await resolveActor(req), idParam(req), req.body as DataPathInputBody);
    res.status(201).json({ success: true, data: path });
  } catch (err) { next(err); }
});

// Before /:id/data-paths/:pid (a literal segment, not an id).
router.post('/:id/data-paths/apply-profile', validate(applyProfileSchema), async (req, res, next) => {
  try {
    res.json({ success: true, data: await sitesService.applyProfile(req, await resolveActor(req), idParam(req), req.body.profile) });
  } catch (err) { next(err); }
});

router.put('/:id/data-paths/:pid', validate(dataPathUpdateSchema), async (req, res, next) => {
  try {
    const data = await sitesService.updateDataPath(req, await resolveActor(req), idParam(req), idParam(req, 'pid'), req.body as DataPathUpdateBody);
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.delete('/:id/data-paths/:pid', async (req, res, next) => {
  try {
    await sitesService.deleteDataPath(req, await resolveActor(req), idParam(req), idParam(req, 'pid'));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

// ── Secondary runtimes ───────────────────────────────────────────────────────

router.get('/:id/runtimes', async (req, res, next) => {
  try {
    res.json({ success: true, data: await sitesService.listRuntimes(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/:id/runtimes', validate(runtimeInputSchema), async (req, res, next) => {
  try {
    const runtime = await sitesService.addRuntime(req, await resolveActor(req), idParam(req), req.body.base);
    res.status(201).json({ success: true, data: runtime });
  } catch (err) { next(err); }
});

router.delete('/:id/runtimes/:rid', async (req, res, next) => {
  try {
    await sitesService.deleteRuntime(req, await resolveActor(req), idParam(req), idParam(req, 'rid'));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

// ── Routes targeting the site ────────────────────────────────────────────────

router.get('/:id/routes', async (req, res, next) => {
  try {
    res.json({ success: true, data: await sitesService.listRoutes(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

export default router;
