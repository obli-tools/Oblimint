import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { AppError } from '../middleware/errorHandler';
import { ipKey } from '../middleware/rateLimiter';
import { appConfigService } from '../services/appConfig.service';
import { firewallService } from '../services/firewall/firewall.service';
import { clientAddress } from '../utils/clientIp';
import { logger } from '../utils/logger';

// /api/ip-probe — OWNED BY MODULE `hostd-firewall` (docs/P2-PLAN.md §6.4, W3). PUBLIC (no session:
// the probe hosts are other host names, the __Host- cookie never reaches them; this route never
// reads req.session).
//   GET  /?nonce=<nonce>   → IpProbeResult (404 probeExpired for an unknown / expired nonce).
//                            CORS: Access-Control-Allow-Origin = the request Origin when it is the
//                            panel origin (https://<panel_hostname>, CLIENT_ORIGIN, ALLOWED_ORIGINS),
//                            never credentials. Records the caller address — clientAddress(req),
//                            resolved by the trusted edge only (S4) — for the session that requested
//                            the nonce (POST /api/access/probe). 422 probeNotPublic for a relay or a
//                            non-public address (Docker gateway, LAN proxy), 422 probeFamilyMismatch
//                            when the v4-only (v6-only) host sees an IPv6 (IPv4). Rate-limited per
//                            address (30 / min).
const router = Router();

const PANEL_ORIGIN_TTL_MS = 30_000;
let panelOrigins: { at: number; set: Set<string> } | null = null;

const normOrigin = (o: string) => o.trim().replace(/\/+$/, '').toLowerCase();

/** The panel origins allowed to read the probe answer (cached 30 s). */
export async function allowedProbeOrigins(): Promise<Set<string>> {
  if (panelOrigins && Date.now() - panelOrigins.at < PANEL_ORIGIN_TTL_MS) return panelOrigins.set;
  const set = new Set<string>([config.clientOrigin, ...config.allowedOrigins].filter(Boolean).map(normOrigin));
  try {
    const host = (await appConfigService.get('panel_hostname'))?.trim();
    if (host) set.add(normOrigin(`https://${host}`));
  } catch (err) {
    logger.debug({ err }, 'ip-probe: panel_hostname unavailable');
  }
  panelOrigins = { at: Date.now(), set };
  return set;
}

/** Tests: set (or with null, forget) the cached panel origins. */
export function setProbeOriginsForTests(origins: string[] | null): void {
  panelOrigins = origins ? { at: Date.now() + 3_600_000, set: new Set(origins.map(normOrigin)) } : null;
}

async function cors(req: Request, res: Response): Promise<void> {
  res.vary('Origin');
  const origin = typeof req.headers.origin === 'string' ? normOrigin(req.headers.origin) : null;
  if (origin && (await allowedProbeOrigins()).has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin as string);
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  // Never Access-Control-Allow-Credentials: the probe is fetched without cookies.
}

const probeLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `ip-probe:${ipKey(req.ip)}`,
  message: { success: false, error: 'Too many requests, please try again later', code: 'rateLimited' },
});

router.options('/', async (req, res) => {
  await cors(req, res);
  res.status(204).end();
});

router.get('/', probeLimiter, async (req, res, next) => {
  try {
    await cors(req, res);
    res.setHeader('Cache-Control', 'no-store');
    const nonce = typeof req.query.nonce === 'string' ? req.query.nonce : '';
    // The resolved client, and whether it is a relay (an untrusted proxy, or
    // the Docker bridge gateway when IPv6 reaches the edge through
    // docker-proxy): a relay is never recorded as "my address".
    const seen = clientAddress(req);
    if (seen.relay) {
      throw new AppError(422, 'The probe saw a relay or private address, not your public address', 'probeNotPublic');
    }
    const result = seen.ip ? await firewallService.recordProbe(nonce, seen.ip, req.hostname) : null;
    if (!result) {
      res.status(404).json({ success: false, error: 'Unknown or expired probe', code: 'probeExpired' });
      return;
    }
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

export default router;
