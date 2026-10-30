import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { transactionalMailService } from '../services/mail/transactional';

// /api/system/transactional-mail — platform admin on the master tenant (index.ts).
// The platform's transactional e-mail sender (services/mail/transactional.ts).
//   GET  /        → TransactionalMailSettings (passwords: passwordSet only)
//   PUT  /        TransactionalMailSettingsInput → TransactionalMailSettings
//   POST /test    { to } → TransactionalMailTestResult (502 mailTestFailed when it fails; 6 / min)
//   GET  /log?limit= → TransactionalMailLogEntry[] (newest first, ≤ 200)
const router = Router();

const testLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `tmail-test:${req.session?.userId ?? 0}`,
  message: { success: false, error: 'Too many tests, please try again in a minute', code: 'rateLimited' },
});

router.get('/', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await transactionalMailService.get() });
  } catch (err) { next(err); }
});

router.put('/', async (req, res, next) => {
  try {
    res.json({ success: true, data: await transactionalMailService.update(req, req.body) });
  } catch (err) { next(err); }
});

router.post('/test', testLimiter, async (req, res, next) => {
  try {
    const result = await transactionalMailService.test(req, req.body?.to);
    if (!result.ok) {
      res.status(502).json({ success: false, error: result.error ?? 'The e-mail could not be sent', code: 'mailTestFailed', details: result });
      return;
    }
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

router.get('/log', async (req, res, next) => {
  try {
    res.json({ success: true, data: await transactionalMailService.log(req.query.limit ? Number(req.query.limit) : 50) });
  } catch (err) { next(err); }
});

export default router;
