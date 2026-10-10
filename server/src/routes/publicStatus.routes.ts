import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { ipKey } from '../middleware/rateLimiter';
import { statusPageService } from '../services/monitoring/statusPages.service';

// /api/public — OWNED BY MODULE `monitoring-automation` (docs/P4b-PLAN.md §6.6).
// NO session, NO tenant: mounted in routes/index.ts BEFORE the tenant router, outside requireAuth.
//   GET /status-pages/:slug   → PublicStatusPage   (404 when unknown / unpublished / settings statusPagesEnabled off;
//                                                   60 requests / min / IP; cached 30 s; never an internal detail:
//                                                   monitor names + statuses + uptime only, no URL / host / error text)
// The SPA renders it at /status/:slug (client route outside ProtectedRoute).

const router = Router();

const publicStatusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `status-page:${ipKey(req.ip)}`,
  message: { success: false, error: 'Too many requests, please try again in a minute', code: 'rateLimited' },
});

router.get('/status-pages/:slug', publicStatusLimiter, async (req, res, next) => {
  try {
    const page = await statusPageService.publicPage(String(req.params.slug ?? '').toLowerCase());
    res.setHeader('Cache-Control', 'public, max-age=30');
    if (!page) {
      res.status(404).json({ success: false, error: 'Status page not found', code: 'notFound' });
      return;
    }
    res.json({ success: true, data: page });
  } catch (err) { next(err); }
});

export default router;
