import { Router } from 'express';
import { idParam, resolveActor } from '../services/hosting/access';
import { quarantineService } from '../services/quarantine/quarantine.service';

// /api/sites/:id/supervision — OWNED BY MODULE `supervised-quarantine` (docs/P3-PLAN.md §6.6). NO catch-all.
// The supervised mode itself is switched by PUT /sites/:id/maintenance { supervised } (module windows).
//   GET  /:id/supervision          → SupervisionInfo   (read)
//   POST /:id/supervision/digest   → SupervisionInfo   (releases.publish; runs the digest now)
// Codes: notSupervised (409), backendUnavailable (502).
const router = Router();

router.get('/:id/supervision', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await quarantineService.supervision(actor, idParam(req)) });
  } catch (err) { next(err); }
});

router.post('/:id/supervision/digest', async (req, res, next) => {
  try {
    const actor = await resolveActor(req);
    res.json({ success: true, data: await quarantineService.digestNow(req, actor, idParam(req)) });
  } catch (err) { next(err); }
});

export default router;
