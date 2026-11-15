import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { AppError } from '../middleware/errorHandler';
import { ipKey } from '../middleware/rateLimiter';
import { devicesService, parseBasic, type DeviceAuth } from '../services/mail/devices/devices.service';
import { clientIp } from '../utils/clientIp';

// ─────────────────────────────────────────────────────────────────────────────
// « Se connecter à Mint » — API of the desktop mail clients, mounted on
// /api/v1/mail BEFORE the access-key router (routes/index.ts): the key
// surfaces' barrier (keySurfaceGate('key-api'), v1.routes.ts) must never see
// these requests — in its strict regime any address outside the key lists
// that touches a key surface is banned for good from the web ports, which
// would cut an office from the panel, the webmail and its sites (§3.4, §6,
// review R1). Own limiters, 429 + Retry-After, NEVER a ban (256-bit secrets
// make brute force pointless; the limiters only bound the load):
//   - per public id: 60 requests / hour;
//   - per address: 600 requests / hour, and 30 failures (401) / 15 min.
// Lot 1 (L1c): the device API.
//   GET    /device/self    Basic omd_<id>:<secret> → MailDeviceSelf (200 even when revoked / expired:
//                          status + reason; check-in at most once per 24 h)
//   DELETE /device/self    Basic omd_<id>:<secret> → 204 (revoked, reason 'device'; idempotent)
// Lot 2 adds /client/* (Bearer oma_). Any other path under /client and
// /device answers 404 here: nothing of MailForge falls through to the key router.
// Errors: Oblimint envelope { success:false, error, code }: 401 invalidCredential, 429 rateLimited.
// Cache-Control: no-store, Pragma: no-cache on every answer.
// ─────────────────────────────────────────────────────────────────────────────

const router = Router({ caseSensitive: true });

function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

const tooMany = (_req: Request, res: Response): void => {
  res.status(429).json({ success: false, error: 'Too many requests, retry later', code: 'rateLimited' });
};

const addressKey = (req: Request): string => ipKey(req.ip);

/** Per address: every request (600 / hour). */
const perAddress = rateLimit({
  windowMs: 60 * 60_000, limit: 600, standardHeaders: true, legacyHeaders: false, keyGenerator: addressKey, handler: tooMany,
});
/** Per address: failed authentications only (30 / 15 min). */
const failuresPerAddress = rateLimit({
  windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: addressKey, handler: tooMany,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401,
});
/** Per credential (public id read from the Basic header, the address when there is none): 60 / hour. */
const perCredential = rateLimit({
  windowMs: 60 * 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, handler: tooMany,
  keyGenerator: (req) => {
    const creds = parseBasic(req.headers.authorization);
    return creds ? `omd:${creds.id}` : `ip:${addressKey(req)}`;
  },
});

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by deviceAuth: the authenticated device password row (any status). */
    mailDevice?: DeviceAuth;
  }
}

/** Basic omd_<id>:<secret> → req.mailDevice, else 401 invalidCredential (a revoked credential still authenticates: it learns its status). */
async function deviceAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const row = await devicesService.authenticate(req.headers.authorization);
    if (!row) throw new AppError(401, 'Unknown or invalid device credential', 'invalidCredential');
    req.mailDevice = row;
    next();
  } catch (err) {
    next(err);
  }
}

const device = Router({ caseSensitive: true });
device.use(noStore, perAddress, failuresPerAddress, perCredential);

device.get('/self', deviceAuth, async (req, res, next) => {
  try {
    res.json({ success: true, data: await devicesService.self(req.mailDevice!, clientIp(req) || null) });
  } catch (err) { next(err); }
});

device.delete('/self', deviceAuth, async (req, res, next) => {
  try {
    await devicesService.selfRevoke(req.mailDevice!, clientIp(req) || null);
    res.status(204).end();
  } catch (err) { next(err); }
});

router.use('/device', device);

// Nothing under /client (lot 2) or /device falls through to the access-key router.
router.use(['/client', '/device'], noStore, (_req: Request, res: Response) => {
  res.status(404).json({ success: false, error: 'Not found', code: 'notFound' });
});

export default router;
