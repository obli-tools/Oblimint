import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import type { SetupApplyRequest } from '@oblimint/shared';
import { safeEqualSecret } from '../utils/safeCompare';
import { AppError } from '../middleware/errorHandler';
import { runHostChecks } from '../services/setup/hostChecks';
import { canStart, getProgress, setupApplySchema, startApply } from '../services/setup/applySetup';

// /api/setup/* (docs/P0-PLAN.md §Mode setup).
//   GET  /status    → { mode }            public, in both modes
//   POST /auth      { token } → { ok }    token checked (constant time)
//   GET  /checks    → HostCheck[]         X-Setup-Token
//   POST /apply     SetupApplyRequest → { started: true } (409 when running / done)
//   GET  /progress  → SetupProgress       X-Setup-Token
// Every token-guarded route: 10 WRONG tokens / 5 min / IP (failures only —
// the progress is polled every 1.5 s).

/** Normal mode: only /status answers ({ mode: 'normal' }); everything else 404. */
export function normalModeSetupRouter(): Router {
  const router = Router();
  router.get('/status', (_req, res) => { res.json({ success: true, data: { mode: 'normal' } }); });
  router.use((_req, res) => { res.status(404).json({ success: false, error: 'Not found' }); });
  return router;
}

export function setupModeRouter(token: string): Router {
  const router = Router();

  const tokenLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    // Only failed attempts count: a request with the right token is skipped.
    skip: (req) => safeEqualSecret(req.get('x-setup-token'), token) || safeEqualSecret((req.body as { token?: unknown })?.token, token),
    message: { success: false, error: 'Too many attempts, please try again later' },
  });

  const requireToken = (req: Request, _res: Response, next: NextFunction): void => {
    if (!safeEqualSecret(req.get('x-setup-token'), token)) {
      next(new AppError(401, 'Invalid setup token', 'invalidSetupToken'));
      return;
    }
    next();
  };

  router.get('/status', (_req, res) => { res.json({ success: true, data: { mode: 'setup' } }); });

  router.post('/auth', tokenLimiter, (req, res, next) => {
    if (!safeEqualSecret((req.body as { token?: unknown })?.token, token)) {
      next(new AppError(401, 'Invalid setup token', 'invalidSetupToken'));
      return;
    }
    res.json({ success: true, data: { ok: true } });
  });

  router.get('/checks', tokenLimiter, requireToken, async (_req, res, next) => {
    try {
      res.json({ success: true, data: await runHostChecks() });
    } catch (err) { next(err); }
  });

  router.post('/apply', tokenLimiter, requireToken, (req, res, next) => {
    try {
      if (!canStart()) throw new AppError(409, getProgress().done ? 'Setup already completed' : 'Setup already running', 'setupAlreadyStarted');
      const parsed = setupApplySchema.safeParse(req.body);
      if (!parsed.success) {
        const issues = parsed.error.errors.map((e) => `${e.path.join('.') || '<root>'}: ${e.message}`);
        res.status(400).json({ success: false, error: `Validation failed — ${issues.join('; ')}`, details: parsed.error.flatten().fieldErrors });
        return;
      }
      startApply(parsed.data as SetupApplyRequest);
      res.json({ success: true, data: { started: true } });
    } catch (err) { next(err); }
  });

  router.get('/progress', tokenLimiter, requireToken, (_req, res) => {
    res.json({ success: true, data: getProgress() });
  });

  router.use((_req, res) => { res.status(404).json({ success: false, error: 'Not found' }); });
  return router;
}
