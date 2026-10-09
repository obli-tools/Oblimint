import { Router } from 'express';
import { dashboardService } from '../services/dashboard.service';
import { resolveActor } from '../services/hosting/access';

// GET /api/dashboard/summary → DashboardSummary (tenant router), scoped to
// the caller: god view, tenant staff, or a client's own accounts.
const router = Router();

router.get('/summary', async (req, res, next) => {
  try {
    res.json({ success: true, data: await dashboardService.summary(await resolveActor(req)) });
  } catch (err) { next(err); }
});

export default router;
