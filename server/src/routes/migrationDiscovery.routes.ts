import { Router } from 'express';
import { idParam } from '../services/hosting/access';
import { discoveryService } from '../services/migration/discovery/discovery.service';

// /api/system/migration — discoveries. OWNED BY MODULE `discovery` (docs/P5-PLAN.md §6.2). Mounted behind
// requireAuth + requirePlatformAdminOnMaster on a SHARED prefix: no catch-all here.
//
//   POST   /sources/:id/discoveries                → MigrationDiscovery (202)   audit migration.discovery.start
//   GET    /sources/:id/discoveries                → MigrationDiscovery[]       (newest first)
//   GET    /discoveries/:id                        → MigrationDiscovery
//   GET    /discoveries/:id/inventory              → CwpInventory               (409 discoveryNotDone)
//   POST   /discoveries/:id/cancel                 → MigrationDiscovery         audit migration.discovery.cancel
//   DELETE /discoveries/:id                        → { deleted: true }          (409 discoveryInUse) audit migration.discovery.delete
//
// Codes: notFound (404), discoveryRunning (409), hostKeyUnpinned (409, pin first), discoveryNotDone (409),
// discoveryInUse (409). Socket: MIGRATION_UPDATED { entity: 'discovery', id, sourceId, status, progress }.

const router = Router();

router.post('/sources/:id/discoveries', async (req, res, next) => {
  try {
    res.status(202).json({ success: true, data: await discoveryService.launch(req, idParam(req)) });
  } catch (err) { next(err); }
});

router.get('/sources/:id/discoveries', async (req, res, next) => {
  try {
    res.json({ success: true, data: await discoveryService.list(idParam(req)) });
  } catch (err) { next(err); }
});

router.get('/discoveries/:id', async (req, res, next) => {
  try {
    res.json({ success: true, data: await discoveryService.get(idParam(req)) });
  } catch (err) { next(err); }
});

router.get('/discoveries/:id/inventory', async (req, res, next) => {
  try {
    res.json({ success: true, data: await discoveryService.inventory(idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/discoveries/:id/cancel', async (req, res, next) => {
  try {
    res.json({ success: true, data: await discoveryService.cancel(req, idParam(req)) });
  } catch (err) { next(err); }
});

router.delete('/discoveries/:id', async (req, res, next) => {
  try {
    await discoveryService.remove(req, idParam(req));
    res.json({ success: true, data: { deleted: true } });
  } catch (err) { next(err); }
});

export default router;
