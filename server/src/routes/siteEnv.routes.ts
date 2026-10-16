import { Router } from 'express';
import { z } from 'zod';
import { SITE_ENV_MAX_VALUE, SITE_ENV_MAX_VARS } from '@oblimint/shared';
import { parseBody } from '../services/docker/parseBody';
import { idParam, resolveActor } from '../services/hosting/access';
import { siteEnvService } from '../services/hosting/siteEnv.service';

// /api/sites/:id/env — environment variables of a site (shared/src/siteEnv.ts). sites.manage.
// Mounted on /sites (no catch-all).
//   GET /:id/env                 → SiteEnvVar[] (secrets: value null)
//   PUT /:id/env  { vars }       → { vars: SiteEnvVar[]; changed } (the whole set; a change restarts the site)

const router = Router();

const putSchema = z.object({
  vars: z.array(z.object({
    name: z.string().min(1).max(128),
    value: z.string().max(SITE_ENV_MAX_VALUE).nullable().optional(),
    secret: z.boolean().optional(),
  }).strict()).max(SITE_ENV_MAX_VARS),
}).strict();

router.get('/:id/env', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: await siteEnvService.list(await resolveActor(req), idParam(req)) });
  } catch (err) { next(err); }
});

router.put('/:id/env', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const siteId = idParam(req);
    const { vars } = parseBody(putSchema, req.body);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: await siteEnvService.replace(req, actor, siteId, vars) });
  } catch (err) { next(err); }
});

export default router;
