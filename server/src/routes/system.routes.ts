import { Router } from 'express';
import { existsSync } from 'fs';
import os from 'os';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { db } from '../db';
import { clientVersion, serverVersion } from '../utils/version';
import { hostMetrics } from '../services/hostMetrics';

// GET /api/system — About section (platform admin). Raw JSON, no envelope:
// same shape as Obliance (the client module reads it with fetch). agentVersion
// and oblireachVersion are kept for shape compatibility ('n/a').
const router = Router();

router.get('/', requireAuth, requireRole('admin'), async (_req, res) => {
  const mem = process.memoryUsage();
  const [load1, load5, load15] = os.loadavg();
  let dbStatus: 'ok' | 'error' = 'error';
  try { await db.raw('SELECT 1'); dbStatus = 'ok'; } catch { /* error */ }
  res.json({
    appVersion: serverVersion,
    nodeVersion: process.version,
    agentVersion: 'n/a',
    oblireachVersion: 'n/a',
    clientVersion: clientVersion(),
    uptimeSeconds: Math.floor(process.uptime()),
    memory: {
      processRssMb: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
      processHeapMb: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
      systemTotalMb: Math.round(os.totalmem() / 1024 / 1024),
      systemFreeMb: Math.round(os.freemem() / 1024 / 1024),
    },
    cpu: {
      loadAvg1: Math.round(load1 * 100) / 100,
      loadAvg5: Math.round(load5 * 100) / 100,
      loadAvg15: Math.round(load15 * 100) / 100,
      cores: os.cpus().length,
    },
    environment: { isDocker: existsSync('/.dockerenv'), platform: os.platform(), dbStatus },
  });
});

// GET /api/system/host-metrics — CPU / RAM / disk of the local node (platform admin): HostMetrics.
router.get('/host-metrics', requireAuth, requireRole('admin'), async (_req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: await hostMetrics() });
  } catch (err) { next(err); }
});

export default router;
