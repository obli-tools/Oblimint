import { Router } from 'express';
import { MASTER_TENANT_ID, type PlatformUpdateRequest } from '@oblimint/shared';
import { AppError } from '../middleware/errorHandler';
import { auditService } from '../services/audit.service';
import { platformUpdatesService } from '../services/platformUpdates/platformUpdates.service';

// /api/system/updates — platform updates of a node (Nodes > Updates).
// Platform administrator on the master tenant only (requirePlatformAdminOnMaster, routes/index.ts).
//   GET  /?nodeId=        → PlatformUpdatesState
//   GET  /summary         → PlatformUpdatesSummary (no Docker call: Nodes list badge, Settings > About)
//   POST /check           { images? }                       → PlatformUpdatesState
//   POST /apply           { images?, redeploySites?, force? } → PlatformUpdateRun (202)
//   PUT  /policy          PlatformUpdatePolicy (partial)    → PlatformUpdatePolicy

const router = Router();

const nodeParam = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, 'Invalid node id', 'validation');
  return n;
};

const imageList = (v: unknown): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 200 || v.some((x) => typeof x !== 'string' || x.length > 512)) throw new AppError(400, 'Invalid image list', 'validation');
  return v as string[];
};

router.get('/', async (req, res, next) => {
  try {
    res.json({ success: true, data: await platformUpdatesService.state(nodeParam(req.query.nodeId)) });
  } catch (err) { next(err); }
});

router.get('/summary', async (req, res, next) => {
  try {
    res.json({ success: true, data: await platformUpdatesService.summary(nodeParam(req.query.nodeId)) });
  } catch (err) { next(err); }
});

router.post('/check', async (req, res, next) => {
  try {
    const nodeId = nodeParam(req.body?.nodeId);
    const images = imageList(req.body?.images);
    await platformUpdatesService.check(nodeId, images);
    await auditService.logReqAs(req, MASTER_TENANT_ID, 'platform.update.check', { resourceType: 'node', resourcePath: String(nodeId ?? 'local'), details: { images } });
    res.json({ success: true, data: await platformUpdatesService.state(nodeId) });
  } catch (err) { next(err); }
});

router.post('/apply', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as PlatformUpdateRequest & { nodeId?: unknown; force?: unknown };
    const nodeId = nodeParam(body.nodeId);
    const images = imageList(body.images);
    const run = await platformUpdatesService.start(
      { nodeId, images, redeploySites: body.redeploySites === true },
      body.force === true ? 'forced' : 'manual',
      req.session?.userId ?? null,
    );
    await auditService.logReqAs(req, MASTER_TENANT_ID, 'platform.update.start', {
      resourceType: 'node', resourcePath: String(run.nodeId), details: { runId: run.id, images: run.images, redeploySites: run.redeploySites, trigger: run.trigger },
    });
    res.status(202).json({ success: true, data: run });
  } catch (err) { next(err); }
});

router.put('/policy', async (req, res, next) => {
  try {
    const policy = await platformUpdatesService.setPolicy(req.body);
    await auditService.logReqAs(req, MASTER_TENANT_ID, 'platform.update.policy', { resourceType: 'node', resourcePath: 'policy', details: { ...policy } });
    res.json({ success: true, data: policy });
  } catch (err) { next(err); }
});

export default router;
