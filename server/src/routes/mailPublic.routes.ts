import express, { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { autoconfigService, type PublicAnswer } from '../services/mail/autoconfig/autoconfig.service';
import { logger } from '../utils/logger';

// Public mail endpoints (NOT under /api, no session) — OWNED BY MODULE
// `mail-dns-tls` (docs/P4-PLAN.md §6.4). Reached through the edge on
// autoconfig.<d> / autodiscover.<d> / mta-sts.<d> (kind 'mail' vhosts → panel).
//   GET       /mail/config-v1.1.xml?emailaddress=                  Thunderbird autoconfig
//   GET       /.well-known/autoconfig/mail/config-v1.1.xml          (same)
//   GET|POST  /autodiscover/autodiscover.xml   (case-insensitive)   Outlook autodiscover (POST: XML ≤ 16 KiB;
//                                                                   originGuard.PUBLIC_XML_PATHS exempts it)
//   GET       /.well-known/mta-sts.txt                              MTA-STS policy
// Anything the service does not recognise (unknown Host, inactive domain,
// feature off) → 404 with an empty body (no information about the platform).
const router = Router();

const limiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });

function hostOf(req: Request): string {
  return String(req.hostname || '').trim().toLowerCase().replace(/\.$/, '');
}

function send(res: Response, answer: PublicAnswer | null): void {
  if (!answer) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', answer.contentType);
  res.setHeader('Cache-Control', `public, max-age=${Math.max(0, Math.floor(answer.maxAge))}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send(answer.body);
}

function handle(fn: (req: Request) => Promise<PublicAnswer | null>) {
  return async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    try {
      send(res, await fn(req));
    } catch (err) {
      // Never a stack trace nor a JSON envelope to an anonymous mail client.
      logger.warn({ err: (err as Error)?.message, path: req.path }, 'public mail endpoint failed');
      res.status(404).end();
    }
  };
}

const thunderbird = handle((req) => autoconfigService.thunderbird(hostOf(req),
  typeof req.query.emailaddress === 'string' ? req.query.emailaddress.slice(0, 254) : null));

router.get('/mail/config-v1.1.xml', limiter, thunderbird);
router.get('/.well-known/autoconfig/mail/config-v1.1.xml', limiter, thunderbird);

const textParser = express.text({ type: () => true, limit: '16kb' });
/** Body ≤ 16 KiB; a parser failure (too large, bad charset) is a bare 404 too, never the JSON error envelope. */
function xmlBody(req: Request, res: Response, next: NextFunction): void {
  textParser(req, res, (err?: unknown) => {
    if (err) {
      res.status(404).end();
      return;
    }
    next();
  });
}
const autodiscover = handle((req) => autoconfigService.autodiscover(hostOf(req), typeof req.body === 'string' ? req.body : null));
router.get(/^\/autodiscover\/autodiscover\.xml$/i, limiter, autodiscover);
router.post(/^\/autodiscover\/autodiscover\.xml$/i, limiter, xmlBody, autodiscover);

router.get('/.well-known/mta-sts.txt', limiter, handle((req) => autoconfigService.mtaStsPolicy(hostOf(req))));

export default router;
