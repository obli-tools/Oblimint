import express, { type Request, type Response } from 'express';
import { isValidPreviewPath, PREVIEW_CLAIM_PATH, previewCookieName } from '@oblimint/shared';
import { previewClaimLimiter } from '../middleware/rateLimiter';
import { auditService } from '../services/audit.service';
import { isPreviewClaimHost } from '../services/previews/previewClaimHost';
import { previewService } from '../services/previews/previews.service';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Feature B — claim of a preview link, served on the PREVIEW host through the
// edge (location = PREVIEW_CLAIM_PATH → panel, access_log off). No session.
//   GET  ?t=<43>[&p=<path>]  'open' link (panel "Open", 60 s): consumed, cookie, 302;
//                            'share' link or unknown token: constant interstitial
//                            page (a link unfurler / mail scanner burns nothing);
//   POST t, p (form)         'share' link: consumed, cookie, 302.
// Failure: constant 404 "expired or already used". The token never appears in
// a log line of the panel (no access log here, nothing logged with it).
// ─────────────────────────────────────────────────────────────────────────────

const router = express.Router({ caseSensitive: true });
const urlencoded = express.urlencoded({ extended: false, limit: '1kb', parameterLimit: 4 });

const NO_STORE = (res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const PAGE_STYLE = 'font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1f2937';

/** Interstitial page (constant but for the hidden fields), bilingual, no script. */
export function interstitialPage(token: string, path: string): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview</title></head>'
    + `<body style="${PAGE_STYLE}"><h1 style="font-size:1.25rem">Open the preview / Ouvrir l'aperçu</h1>`
    + '<p>This link opens a private preview of a website. It works once.</p>'
    + '<p lang="fr">Ce lien ouvre un aperçu privé d\'un site web. Il ne fonctionne qu\'une fois.</p>'
    + `<form method="post" action="${PREVIEW_CLAIM_PATH}">`
    + `<input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="p" value="${esc(path)}">`
    + '<button type="submit" style="padding:.5rem 1rem;font-size:1rem">Open the preview / Ouvrir l\'aperçu</button></form></body></html>';
}

const EXPIRED_PAGE = '<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Link expired</title></head>'
  + `<body style="${PAGE_STYLE}"><h1 style="font-size:1.25rem">Link expired or already used</h1>`
  + '<p lang="fr">Lien expiré ou déjà utilisé.</p></body></html>';

function hostOf(req: Request): string | null {
  const h = (req.hostname || '').toLowerCase();
  return isPreviewClaimHost(h) ? h : null;
}

function pathParam(v: unknown): string {
  return typeof v === 'string' && isValidPreviewPath(v) ? v : '/';
}

function expired(res: Response): void {
  NO_STORE(res);
  res.status(404).type('html').send(EXPIRED_PAGE);
}

function grant(req: Request, res: Response, c: { previewId: number; secret: string; tenantId: number; siteId: number }, kind: 'open' | 'share', to: string): void {
  void auditService.log({
    tenantId: c.tenantId, userId: undefined, action: 'preview.claim', resourceType: 'site', resourcePath: String(c.siteId),
    details: { siteId: c.siteId, previewId: c.previewId, kind }, ipAddress: req.ip,
  });
  NO_STORE(res);
  res.setHeader('Set-Cookie', `${previewCookieName(c.previewId)}=${c.secret}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=86400`);
  res.redirect(302, to);
}

router.get(PREVIEW_CLAIM_PATH, previewClaimLimiter, async (req, res) => {
  const host = hostOf(req);
  const token = typeof req.query.t === 'string' ? req.query.t : '';
  const to = pathParam(req.query.p);
  if (!host) return expired(res);
  try {
    const kind = await previewService.linkKind(token, host);
    if (kind === 'open') {
      const c = await previewService.consumeClaim('open', token, host);
      return c ? grant(req, res, c, 'open', to) : expired(res);
    }
    // 'share' or unknown: the same page, nothing consumed (no oracle on a GET).
    NO_STORE(res);
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    return res.status(200).type('html').send(interstitialPage(/^[A-Za-z0-9_-]{43}$/.test(token) ? token : '', to));
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'preview claim (GET) failed');
    return expired(res);
  }
});

router.post(PREVIEW_CLAIM_PATH, previewClaimLimiter, urlencoded, async (req, res) => {
  const host = hostOf(req);
  const body = (req.body ?? {}) as { t?: unknown; p?: unknown };
  const token = typeof body.t === 'string' ? body.t : '';
  if (!host) return expired(res);
  try {
    const c = await previewService.consumeClaim('share', token, host);
    return c ? grant(req, res, c, 'share', pathParam(body.p)) : expired(res);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'preview claim (POST) failed');
    return expired(res);
  }
});

export default router;
