import { Router, type Request } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { AppError } from '../middleware/errorHandler';
import { validate } from '../middleware/validate';
import { heavyOpLimiter } from '../middleware/rateLimiter';
import { auditService } from '../services/audit.service';
import { idParam, loadSite, resolveActor } from '../services/hosting/access';
import { toSite, type SiteRow } from '../services/hosting/rows';
import { forActor, releaseForActor } from '../services/hosting/statusMessage';
import { releaseService } from '../services/releases/release.service';

// /api/sites/:id/releases*, /api/sites/:id/staging* — OWNED BY MODULE `releases`
// (docs/P1-PLAN.md §API). Mounted on /sites after sites.routes.ts (no catch-all here).
//   GET  /:id/releases               ?limit=&offset= → { items: Release[]; total: number } (read)
//   POST /:id/releases               PublishRequest → Release (releases.publish; 409 publishInProgress | stagingEmpty | noChanges)
//   GET  /:id/releases/:rid          → ReleaseDetail (read)
//   GET  /:id/releases/:rid/diff     ?against=<rid>|previous|empty &file=<path> → ReleaseDiff (read)
//   POST /:id/releases/:rid/rollback → Site (releases.publish)
//   POST /:id/releases/:rid/approve  ApproveRequest { override?, reason? } → Release (releases.approve;
//                                    P3: a BLOCKED scan → 409 riskBlocked {score, level} unless override by a STAFF
//                                    member holding releases.approve, 403 overrideForbidden for anyone else; audited
//                                    'release.approve.override')
//   POST /:id/releases/:rid/reject   { reason? } → Release (releases.approve)
//   GET  /:id/staging                → StagingStatus (read)
//   GET  /:id/staging/detect         → ProfileDetection (read)
// Access: resolveActor + loadSite(actor, id, need) (404 invisible / 403 no right);
// a :rid must belong to that site (the service filters on site_id → 404).
const router = Router();

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const publishBody = z.object({
  message: z.string().max(2000).nullable().optional(),
}).strict();

const diffQuery = z.object({
  against: z.union([z.literal('previous'), z.literal('empty'), z.coerce.number().int().positive()]).default('previous'),
  file: z.string().min(1).max(4096).optional(),
});

const approveBody = z.object({
  override: z.boolean().optional(),
  reason: z.string().max(500).nullable().optional(),
}).strict();

const rejectBody = z.object({
  reason: z.string().max(500).nullable().optional(),
}).strict();

async function siteFor(req: Request, need: Parameters<typeof loadSite>[2]): Promise<SiteRow> {
  const actor = await resolveActor(req);
  return loadSite(actor, idParam(req), need);
}

const userIdOf = (req: Request): number => Number(req.session.userId);

/** Site row as GET /sites/:id returns it (joins of toSite: current release number, primary domain). */
async function siteView(siteId: number): Promise<SiteRow> {
  const row = await db('sites as s')
    .join('hosting_accounts as a', 'a.id', 's.account_id')
    .leftJoin('releases as r', 'r.id', 's.current_release_id')
    .where('s.id', siteId)
    .first(
      's.*', 'a.username as account_username', 'r.number as current_release_number',
      db.raw(`(SELECT d.name FROM site_routes sr JOIN domains d ON d.id = sr.domain_id
               WHERE sr.site_id = s.id ORDER BY (sr.path_prefix = '/') DESC, (d.kind = 'primary') DESC, d.id ASC LIMIT 1) as primary_domain`),
    ) as SiteRow | undefined;
  if (!row) throw new AppError(404, 'Site not found', 'notFound');
  return row;
}

router.get('/:id/releases', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const site = await loadSite(actor, idParam(req), 'read');
    const q = req.query as unknown as z.infer<typeof listQuery>;
    const page = await releaseService.list(site.id, q);
    res.json({ success: true, data: { ...page, items: page.items.map((r) => releaseForActor(actor, r)) } });
  } catch (err) { next(err); }
});

router.post('/:id/releases', validate(publishBody), async (req, res, next) => {
  try {
    const site = await siteFor(req, 'releases.publish');
    const body = req.body as z.infer<typeof publishBody>;
    const release = await releaseService.publish(site.id, { trigger: 'manual', userId: userIdOf(req), message: body.message ?? null });
    await auditService.logReqAs(req, site.tenant_id, 'release.publish', {
      resourceType: 'release', resourcePath: String(release.id), details: { siteId: site.id, number: release.number },
    });
    res.status(201).json({ success: true, data: release });
  } catch (err) { next(err); }
});

router.get('/:id/releases/:rid', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const site = await loadSite(actor, idParam(req), 'read');
    res.json({ success: true, data: releaseForActor(actor, await releaseService.get(site.id, idParam(req, 'rid'))) });
  } catch (err) { next(err); }
});

router.get('/:id/releases/:rid/diff', heavyOpLimiter, validate(diffQuery, 'query'), async (req, res, next) => {
  try {
    const site = await siteFor(req, 'read');
    const q = req.query as unknown as z.infer<typeof diffQuery>;
    res.json({ success: true, data: await releaseService.diff(site.id, idParam(req, 'rid'), q.against, q.file ?? null) });
  } catch (err) { next(err); }
});

router.post('/:id/releases/:rid/rollback', async (req, res, next) => {
  try {
    const site = await siteFor(req, 'releases.publish');
    const rid = idParam(req, 'rid');
    await releaseService.rollback(site.id, rid, userIdOf(req));
    await auditService.logReqAs(req, site.tenant_id, 'release.rollback', {
      resourceType: 'release', resourcePath: String(rid), details: { siteId: site.id },
    });
    res.json({ success: true, data: forActor(await resolveActor(req), toSite(await siteView(site.id))) });
  } catch (err) { next(err); }
});

router.post('/:id/releases/:rid/approve', validate(approveBody), async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    const site = await loadSite(actor, idParam(req), 'releases.approve');
    const body = req.body as z.infer<typeof approveBody>;
    // M5: a client never overrides a blocked scan (loadSite already proved releases.approve for staff).
    if (body.override && actor.kind !== 'staff') {
      throw new AppError(403, 'Only staff can override a blocked scan', 'overrideForbidden');
    }
    const reason = body.reason?.trim() ? body.reason.trim().slice(0, 500) : null;
    const release = await releaseService.approve(site.id, idParam(req, 'rid'), userIdOf(req), {
      override: body.override ? { reason } : null,
    });
    await auditService.logReqAs(req, site.tenant_id, 'release.approve', {
      resourceType: 'release', resourcePath: String(release.id), details: { siteId: site.id, number: release.number },
    });
    if (release.scan?.override) {
      await auditService.logReqAs(req, site.tenant_id, 'release.approve.override', {
        resourceType: 'release', resourcePath: String(release.id),
        details: { siteId: site.id, number: release.number, risk: release.scan.risk ?? null, reason },
      });
    }
    res.json({ success: true, data: releaseForActor(actor, release) });
  } catch (err) { next(err); }
});

router.post('/:id/releases/:rid/reject', validate(rejectBody), async (req, res, next) => {
  try {
    const site = await siteFor(req, 'releases.approve');
    const body = req.body as z.infer<typeof rejectBody>;
    const release = await releaseService.reject(site.id, idParam(req, 'rid'), userIdOf(req), body.reason ?? null);
    await auditService.logReqAs(req, site.tenant_id, 'release.reject', {
      resourceType: 'release', resourcePath: String(release.id), details: { siteId: site.id, number: release.number, reason: body.reason ?? null },
    });
    res.json({ success: true, data: release });
  } catch (err) { next(err); }
});

router.get('/:id/staging', heavyOpLimiter, async (req, res, next) => {
  try {
    const site = await siteFor(req, 'read');
    res.json({ success: true, data: await releaseService.stagingStatus(site.id) });
  } catch (err) { next(err); }
});

router.get('/:id/staging/detect', heavyOpLimiter, async (req, res, next) => {
  try {
    const site = await siteFor(req, 'read');
    res.json({ success: true, data: await releaseService.detectProfile(site.id) });
  } catch (err) { next(err); }
});

export default router;
