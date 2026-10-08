import { Router } from 'express';
import { dashboardService } from '../services/dashboard.service';

// GET /api/dashboard/summary → DashboardSummary (tenant router).
const router = Router();

router.get('/summary', async (req, res, next) => {
  try {
    res.json({ success: true, data: await dashboardService.summary(req.tenantId, req.session.role === 'admin') });
  } catch (err) { next(err); }
});

export default router;
