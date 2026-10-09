import { Router } from 'express';
import { MASTER_TENANT_ID } from '@oblimint/shared';
import { AppError } from '../middleware/errorHandler';
import { auditService } from '../services/audit.service';
import { infraService } from '../services/docker/infra.service';
import { reconcileService } from '../services/docker/reconcile.service';
import { errText } from '../services/setup/docker';

// /api/system/infra — module orchestration (docs/P1-PLAN.md §6).
// Platform admin only (mounted behind requireAuth + requireRole('admin')).
//   GET  /                  → InfraStatus
//   POST /reconcile         → { queued: true }
//   POST /:component/deploy component = edge | hostd | dns | dbadmin (P2) → InfraStatus

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await infraService.status() });
  } catch (err) { next(err); }
});

router.post('/reconcile', async (req, res, next) => {
  try {
    reconcileService.requestAll('admin');
    await auditService.logReqAs(req, MASTER_TENANT_ID, 'infra.reconcile', { resourceType: 'infra', resourcePath: 'reconcile' });
    res.json({ success: true, data: { queued: true } });
  } catch (err) { next(err); }
});

router.post('/:component/deploy', async (req, res, next) => {
  try {
    const component = req.params.component;
    const { extraInfraComponents } = await import('../services/docker/extensions');
    const extra = (await extraInfraComponents()).find((c) => c.id === component);
    if (component !== 'edge' && component !== 'hostd' && !extra) throw new AppError(404, 'Unknown infrastructure component', 'notFound');
    const log: string[] = [];
    try {
      if (component === 'edge') await infraService.ensureEdge((l) => log.push(l));
      else if (component === 'hostd') await infraService.ensureHostd((l) => log.push(l));
      else await extra!.ensure((l) => log.push(l));
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(502, `${component}: ${errText(err)}`, 'backendUnavailable', { log: log.slice(-50) });
    }
    await auditService.logReqAs(req, MASTER_TENANT_ID, 'infra.deploy', { resourceType: 'infra', resourcePath: component, details: { log: log.slice(-20) } });
    reconcileService.requestAll(`${component}-deployed`);
    res.json({ success: true, data: await infraService.status() });
  } catch (err) { next(err); }
});

export default router;
