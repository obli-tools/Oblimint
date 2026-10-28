import { Router } from 'express';
import { z } from 'zod';
import { PREVIEW_FETCH_MAX_BYTES, PREVIEW_FETCH_MIN_BYTES, PREVIEW_PATH_MAX } from '@oblimint/shared';
import { heavyOpLimiter } from '../middleware/rateLimiter';
import { idParam, loadSite, resolveActor } from '../services/hosting/access';
import { parseBody } from '../services/docker/parseBody';
import { previewService } from '../services/previews/previews.service';

// /api/sites/:id/preview* — feature B (release / staging previews).
//   GET    /:id/preview                  → SitePreview | null              (read)
//   GET    /:id/previews?limit=          → SitePreview[] (≤ 50)            (read)
//   POST   /:id/preview                  { target, releaseId?, ttlMinutes?, options? } → 202 PreviewStartResult
//   GET    /:id/preview/open             → 302 https://<host>/__oblimint_preview/claim?t=<60 s token> (code.read)
//   POST   /:id/preview/link             → PreviewLink (share, one-shot, 10 min; clients: sites.manage)
//   POST   /:id/preview/extend           { ttlMinutes } → SitePreview      (code.read)
//   DELETE /:id/preview                  → { stopped: true }               (code.read or staff sites.manage)
//   GET    /:id/preview/fetch?path=&compare=1&host=&maxBytes=&method= → PreviewFetchResult (code.read; compare: sites.manage)
// Access (the site, read) is checked BEFORE the body is parsed; the service checks the rest.

const router = Router();

export const startSchema = z.object({
  target: z.enum(['release', 'staging']),
  releaseId: z.number().int().positive().nullable().optional(),
  ttlMinutes: z.number().int().min(1).max(1440).nullable().optional(),
  options: z.object({
    env: z.enum(['public', 'all']).optional(),
    allowBlockedScan: z.boolean().optional(),
  }).strict().nullable().optional(),
}).strict();

export const extendSchema = z.object({ ttlMinutes: z.number().int().min(1).max(1440) }).strict();

export const fetchQuerySchema = z.object({
  path: z.string().min(1).max(PREVIEW_PATH_MAX),
  compare: z.enum(['0', '1', 'true', 'false']).optional(),
  host: z.enum(['preview', 'live']).optional(),
  maxBytes: z.coerce.number().int().min(PREVIEW_FETCH_MIN_BYTES).max(PREVIEW_FETCH_MAX_BYTES).optional(),
  method: z.enum(['GET', 'HEAD']).optional(),
}).strict();

async function visibleSite(req: Parameters<typeof resolveActor>[0]) {
  const actor = await resolveActor(req);
  const site = await loadSite(actor, idParam(req), 'read');
  return { actor, site };
}

router.get('/:id/preview', async (req, res, next) => {
  try {
    const { actor, site } = await visibleSite(req);
    res.json({ success: true, data: await previewService.get(actor, site.id) });
  } catch (err) { next(err); }
});

router.get('/:id/previews', async (req, res, next) => {
  try {
    const { actor, site } = await visibleSite(req);
    res.json({ success: true, data: await previewService.history(actor, site.id, Number(req.query.limit) || 20) });
  } catch (err) { next(err); }
});

router.post('/:id/preview', heavyOpLimiter, async (req, res, next) => {
  try {
    const { actor, site } = await visibleSite(req);
    const body = parseBody(startSchema, req.body);
    const result = await previewService.start(req, actor, site.id, {
      target: body.target, releaseId: body.releaseId ?? null, ttlMinutes: body.ttlMinutes ?? null, options: body.options ?? null,
    });
    res.status(202).json({ success: true, data: result });
  } catch (err) { next(err); }
});

router.get('/:id/preview/open', async (req, res, next) => {
  try {
    const { actor, site } = await visibleSite(req);
    const url = await previewService.openLink(req, actor, site.id);
    // The token only travels in Location (never in a URI the panel logs).
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, url);
  } catch (err) { next(err); }
});

router.post('/:id/preview/link', async (req, res, next) => {
  try {
    const { actor, site } = await visibleSite(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: await previewService.shareLink(req, actor, site.id) });
  } catch (err) { next(err); }
});

router.post('/:id/preview/extend', async (req, res, next) => {
  try {
    const { actor, site } = await visibleSite(req);
    const { ttlMinutes } = parseBody(extendSchema, req.body);
    res.json({ success: true, data: await previewService.extend(req, actor, site.id, ttlMinutes) });
  } catch (err) { next(err); }
});

router.delete('/:id/preview', async (req, res, next) => {
  try {
    const { actor, site } = await visibleSite(req);
    res.json({ success: true, data: await previewService.stop(req, actor, site.id) });
  } catch (err) { next(err); }
});

router.get('/:id/preview/fetch', heavyOpLimiter, async (req, res, next) => {
  try {
    const { actor, site } = await visibleSite(req);
    const q = parseBody(fetchQuerySchema, req.query);
    res.json({
      success: true,
      data: await previewService.fetch(actor, site.id, {
        path: q.path, compare: q.compare === '1' || q.compare === 'true', host: q.host ?? null, maxBytes: q.maxBytes ?? null, method: q.method ?? null,
      }),
    });
  } catch (err) { next(err); }
});

export default router;
