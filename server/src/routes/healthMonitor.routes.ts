import { Router } from 'express';
import { z } from 'zod';
import { HEARTBEAT_URL_MAX } from '@oblimint/shared';
import { parseBody } from '../services/docker/parseBody';
import { healthMonitorService } from '../services/healthMonitor/healthMonitor.service';

// /api/system/health-monitor — platform admin on the master tenant:
//   GET  /            settings (token set?, heartbeat origin, last beat, last report)
//   PUT  /            { heartbeatUrl: string | null }
//   POST /token       new deep health token (shown once, replaces the previous)
//   DELETE /token     disables GET /health/deep
//   POST /test        runs the checks and sends a beat now
const router = Router();
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

const updateSchema = z.object({ heartbeatUrl: z.string().max(HEARTBEAT_URL_MAX).nullable() }).strict();

router.get('/', async (_req, res, next) => {
  try { res.json({ success: true, data: await healthMonitorService.getSettings() }); } catch (err) { next(err); }
});

router.put('/', async (req, res, next) => {
  try { res.json({ success: true, data: await healthMonitorService.updateSettings(req, parseBody(updateSchema, req.body)) }); } catch (err) { next(err); }
});

router.post('/token', async (req, res, next) => {
  try { res.status(201).json({ success: true, data: await healthMonitorService.createToken(req) }); } catch (err) { next(err); }
});

router.delete('/token', async (req, res, next) => {
  try { res.json({ success: true, data: await healthMonitorService.revokeToken(req) }); } catch (err) { next(err); }
});

router.post('/test', async (_req, res, next) => {
  try { res.json({ success: true, data: await healthMonitorService.testHeartbeat() }); } catch (err) { next(err); }
});

export default router;
