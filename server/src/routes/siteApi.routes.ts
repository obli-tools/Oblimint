import { Router, type Request } from 'express';
import { z } from 'zod';
import type { MaintenanceWindow, SiteApiWindowStatus } from '@oblimint/shared';
import { validate } from '../middleware/validate';
import { AppError } from '../middleware/errorHandler';
import { clientIp } from '../utils/clientIp';
import { siteApiAuthLimiter, siteApiLimiter, siteTokenAuth, type SiteTokenIdentity } from '../services/windows/siteTokens';
import { windowService } from '../services/windows/window.service';
import { maskDetail } from '../services/windows/rows';

// /api/site-api — PUBLIC router authenticated by a site API token (Authorization: Bearer obt_…),
// OWNED BY MODULE `windows` (docs/P3-PLAN.md §6.2). Mounted BEFORE the tenant router, outside
// requireAuth (no session, no cookie: originGuard accepts non-browser clients). Scope 'windows' only:
// a token can open / extend / close the window of ITS site, never validate or reject it (M6).
//   GET  /window                              → SiteApiWindowStatus
//   POST /window          WindowOpenRequest  → SiteApiWindowStatus (201)
//   POST /window/extend   WindowExtendRequest → SiteApiWindowStatus
//   POST /window/close                        → SiteApiWindowStatus
// Codes: invalidToken (401), tokenScope (403), + the window codes of windows.routes.ts.
// A supervised site: POST /window answers 403 tokenScope (only a session user lifts the quarantine), and a
// token works only while its creator still holds releases.publish + sites.manage on the account (verify()).
// Rate limits: 120 requests / min / IP, 20 refused tokens / 15 min / IP. Audit: the token's name.
const router = Router();

router.use(siteApiLimiter, siteApiAuthLimiter, siteTokenAuth);

const openBody = z.object({
  durationMinutes: z.number().int().min(5).max(10080).optional(),
  note: z.string().max(500).nullable().optional(),
}).strict();
const extendBody = z.object({ minutes: z.number().int().min(5).max(10080) }).strict();

const tokenOf = (req: Request): SiteTokenIdentity => {
  if (!req.siteToken) throw new AppError(401, 'Invalid or expired site API token', 'invalidToken');
  return req.siteToken;
};
const auditOf = (req: Request, t: SiteTokenIdentity) => ({ userId: null, ip: clientIp(req) || null, tokenName: t.name });

/** A token holder is not staff: backend causes masked (A6). */
function forToken(w: MaintenanceWindow | null): MaintenanceWindow | null {
  return w ? { ...w, error: maskDetail(w.error) } : null;
}

async function status(siteId: number): Promise<SiteApiWindowStatus> {
  return { siteId, window: forToken(await windowService.activeWindow(siteId)) };
}

/** The active window of the token's site (404 windowNotOpen-like when none). */
async function activeOrRefuse(siteId: number): Promise<MaintenanceWindow> {
  const w = await windowService.activeWindow(siteId);
  if (!w || w.status !== 'open') throw new AppError(409, 'No open window on this site', 'windowNotOpen');
  return w;
}

router.get('/window', async (req, res, next) => {
  try {
    const t = tokenOf(req);
    res.json({ success: true, data: await status(t.siteId) });
  } catch (err) { next(err); }
});

router.post('/window', validate(openBody), async (req, res, next) => {
  try {
    const t = tokenOf(req);
    const body = req.body as z.infer<typeof openBody>;
    const settings = await windowService.settingsOf(t.siteId);
    await windowService.openInternal(t.siteId, {
      trigger: 'api', userId: null, tokenId: t.tokenId, tokenName: t.name,
      durationMinutes: body.durationMinutes ?? settings.defaultDurationMinutes, note: body.note ?? null,
    }, auditOf(req, t));
    res.status(201).json({ success: true, data: await status(t.siteId) });
  } catch (err) { next(err); }
});

router.post('/window/extend', validate(extendBody), async (req, res, next) => {
  try {
    const t = tokenOf(req);
    const w = await activeOrRefuse(t.siteId);
    await windowService.extendInternal(t.siteId, w.id, (req.body as z.infer<typeof extendBody>).minutes, auditOf(req, t));
    res.json({ success: true, data: await status(t.siteId) });
  } catch (err) { next(err); }
});

router.post('/window/close', async (req, res, next) => {
  try {
    const t = tokenOf(req);
    const w = await activeOrRefuse(t.siteId);
    // The permanent window of the supervised mode is reviewed from the panel, never closed by a token.
    if (w.trigger === 'supervised') throw new AppError(403, 'A site API token cannot close the supervised window', 'tokenScope');
    await windowService.closeInternal(t.siteId, w.id, 'api', auditOf(req, t));
    res.json({ success: true, data: await status(t.siteId) });
  } catch (err) { next(err); }
});

export default router;
