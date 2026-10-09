import { Router } from 'express';
import { validate } from '../middleware/validate';
import { heavyOpLimiter } from '../middleware/rateLimiter';
import { idParam, resolveActor } from '../services/hosting/access';
import { domainsService } from '../services/hosting/domains.service';
import {
  domainCreateSchema, domainUpdateSchema, routeInputSchema,
  type DomainCreateBody, type DomainUpdateBody, type RouteInputBody,
} from '../validators/hosting.schema';

// /api/domains — OWNED BY MODULE `edge-ownership` in P2 (docs/P1-PLAN.md §API, P2-PLAN §6.2).
// The ownership routes (/claims, /:id/verification*) are in domainOwnership.routes.ts,
// mounted BEFORE this router.
// NO catch-all middleware: /api/domains/:id/certificate* is served by
// certificates.routes.ts (module edge), mounted after this router.
//   GET    /                    ?accountId=&search= → Domain[]
//   POST   /                    DomainCreate → Domain (domains.manage on the account)
//        409 domainTaken { name, claimable } (claimable: held by another account, never named — A2),
//        409 wildcardNeedsHostedZone, 400 domainReserved (panel / preview domain / DB admin / probe hosts)
//   GET    /:id                 → Domain
//   PUT    /:id                 DomainUpdate → Domain (domains.manage)
//   DELETE /:id                 → { deleted: true } (domains.manage)
//   POST   /:id/routes          SiteRouteInput → SiteRoute (domains.manage)
//   PUT    /:id/routes/:routeId SiteRouteInput → SiteRoute (domains.manage)
//   DELETE /:id/routes/:routeId → { deleted: true } (domains.manage)
const router = Router();

const optionalId = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

router.get('/', async (req, res, next) => {
  try {
    const data = await domainsService.list(await resolveActor(req), {
      accountId: optionalId(req.query.accountId),
      search: typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : undefined,
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/', validate(domainCreateSchema), async (req, res, next) => {
  try {
    const domain = await domainsService.create(req, await resolveActor(req), req.body as DomainCreateBody);
    res.status(201).json({ success: true, data: domain });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await domainsService.get(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.put('/:id', validate(domainUpdateSchema), async (req, res, next) => {
  try {
    res.json({ success: true, data: await domainsService.update(req, await resolveActor(req), idParam(req), req.body as DomainUpdateBody) });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await domainsService.remove(req, await resolveActor(req), idParam(req));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

router.post('/:id/routes', heavyOpLimiter, validate(routeInputSchema), async (req, res, next) => {
  try {
    const route = await domainsService.addRoute(req, await resolveActor(req), idParam(req), req.body as RouteInputBody);
    res.status(201).json({ success: true, data: route });
  } catch (err) { next(err); }
});

router.put('/:id/routes/:routeId', validate(routeInputSchema), async (req, res, next) => {
  try {
    const route = await domainsService.updateRoute(req, await resolveActor(req), idParam(req), idParam(req, 'routeId'), req.body as RouteInputBody);
    res.json({ success: true, data: route });
  } catch (err) { next(err); }
});

router.delete('/:id/routes/:routeId', async (req, res, next) => {
  try {
    await domainsService.deleteRoute(req, await resolveActor(req), idParam(req), idParam(req, 'routeId'));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

export default router;
