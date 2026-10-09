import { Router } from 'express';
import { MASTER_TENANT_ID } from '@oblimint/shared';
import { auditService } from '../services/audit.service';
import { scanService } from '../services/scan/scan.service';

// /api/system/scanner — OWNED BY MODULE `scanners` (docs/P3-PLAN.md §6.7). Platform admin only
// (mounted behind requireAuth + requireRole('admin')). Settings: section `scanner` of
// /api/system/hosting-settings; deployment: POST /api/system/infra/scanner/deploy.
//   GET  /         → ScannerStatus
//   POST /update   → ScannerStatus (freshclam now)
//   POST /test     → ScanTestResult (EICAR + a known webshell pattern)
// Codes: scannerNotDeployed (409), backendUnavailable (502).
const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await scanService.status() });
  } catch (err) { next(err); }
});

router.post('/update', async (req, res, next) => {
  try {
    const data = await scanService.updateSignatures();
    await auditService.logReqAs(req, MASTER_TENANT_ID, 'scanner.update', { resourceType: 'infra', resourcePath: 'scanner' });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/test', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await scanService.test() });
  } catch (err) { next(err); }
});

export default router;
