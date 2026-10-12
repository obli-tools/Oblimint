import type { NextFunction, Request, Response } from 'express';
import type { IncomingMessage } from 'http';
import { config } from '../config';

// ── Cross-site / same-site request forgery guard ─────────────────────────────
//
// SameSite=Lax is NOT a CSRF defence here: SameSite works per registrable
// domain, and tenant-controlled code is served on hosts of the panel's own
// domain (blue/green previews `<slug>-<id>.preview.<panel>`, tenant domains of
// the operator's zone). A page there can send `fetch(panel, {method:'POST',
// mode:'no-cors', credentials:'include'})` or auto-submit a form: the Lax
// cookie goes along, CORS only hides the RESPONSE, and express.json leaves
// req.body = {} for a text/plain body — every POST that needs no body would
// run with the victim's rights.
//
// Every state-changing request (not GET / HEAD / OPTIONS) must therefore:
//   1. come from the panel's own origin: `Origin` (sent by every browser on
//      such requests) must name the Host the request was sent to, the
//      configured client origin (Vite dev server) or ALLOWED_ORIGINS; without
//      Origin, `Sec-Fetch-Site` must not be same-site / cross-site, and a
//      Referer, when present, must be same-origin. No Origin, no
//      Sec-Fetch-Site and no Referer = not a browser (curl, Obligate's
//      server-to-server sync): allowed, it carries no ambient cookie;
//   2. carry its body as application/json: a form or no-cors request cannot
//      set that type without a CORS preflight, which the panel never grants
//      to a foreign origin.
// Socket.io applies (1) at the handshake (socket.ts allowRequest).

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOfUrl(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Is `origin` (an Origin header or a URL) the panel itself? Its host[:port]
 * must equal the Host header the browser addressed (the edge forwards `Host
 * $host`), or the origin must be configured (clientOrigin, ALLOWED_ORIGINS).
 * 'null' (sandboxed frame, file:, data:) is never allowed.
 */
export function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return false;
  const normalized = originOfUrl(origin);
  if (!normalized) return false;
  const configured = [config.clientOrigin, ...config.allowedOrigins].map((o) => originOfUrl(o)).filter(Boolean);
  if (configured.includes(normalized)) return true;
  const h = (host ?? '').trim().toLowerCase();
  if (!h) return false;
  const originHost = normalized.replace(/^https?:\/\//, '');
  if (originHost === h) return true;
  // Host may carry the scheme's default port explicitly.
  const stripDefault = (s: string) => s.replace(/:(?:443|80)$/, '');
  return stripDefault(originHost) === stripDefault(h);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Browser request coming from somewhere else than the panel? (shared by Express and Socket.io) */
export function isForeignBrowserRequest(req: IncomingMessage): boolean {
  const host = header(req, 'host');
  const origin = header(req, 'origin');
  if (origin !== undefined) return !isAllowedOrigin(origin, host);
  const site = header(req, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return true;
  const referer = header(req, 'referer');
  if (referer !== undefined && referer !== '') {
    const refOrigin = originOfUrl(referer);
    if (!refOrigin || !isAllowedOrigin(refOrigin, host)) return true;
  }
  return false;
}

function hasBody(req: Request): boolean {
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const len = Number(req.headers['content-length']);
  return Number.isFinite(len) && len > 0;
}

/**
 * P2 — raw upload endpoints (database restore): the body is a dump, not JSON.
 * Still origin-checked (1); the type must be one of RAW_UPLOAD_TYPES, which a
 * form / no-cors request cannot send without a CORS preflight either
 * (application/octet-stream / application/sql / application/gzip are not
 * CORS-safelisted types).
 */
export const RAW_UPLOAD_PATHS: readonly RegExp[] = [
  /^\/api\/databases\/instances\/\d+\/databases\/\d+\/restore$/,
  // P4b (docs/P4b-PLAN.md §5.3): ZIP source of an app stack (streamed by yauzl).
  /^\/api\/apps\/stacks\/\d+\/source\/zip$/,
  // Web file explorer: one chunk of a chunked upload (application/octet-stream).
  /^\/api\/accounts\/\d+\/files\/uploads\/[0-9a-f]{32}\/\d+$/,
];
const RAW_UPLOAD_TYPES = [
  'application/octet-stream', 'application/sql', 'application/gzip', 'application/x-gzip',
  'application/zip', 'application/x-zip-compressed',
];

/**
 * P4 (docs/P4-PLAN.md §6.4): Outlook autodiscover POSTs an XML body from a
 * mail client (no browser, no cookie, read-only answer computed from the
 * Host / e-mail address). Public, never session-authenticated: exempt from
 * the origin and JSON rules (the route reads the body itself, ≤ 16 KiB).
 */
export const PUBLIC_XML_PATHS: readonly RegExp[] = [
  /^\/autodiscover\/autodiscover\.xml$/i,
];

export function originGuard(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) { next(); return; }
  if (req.method === 'POST' && PUBLIC_XML_PATHS.some((re) => re.test(req.path))) { next(); return; }
  if (isForeignBrowserRequest(req)) {
    res.status(403).json({ success: false, error: 'Cross-origin request refused', code: 'crossOriginRefused' });
    return;
  }
  if (hasBody(req) && RAW_UPLOAD_PATHS.some((re) => re.test(req.path)) && req.is(RAW_UPLOAD_TYPES)) {
    next();
    return;
  }
  if (hasBody(req) && !req.is('application/json')) {
    res.status(415).json({ success: false, error: 'Request bodies must be sent as application/json', code: 'unsupportedMediaType' });
    return;
  }
  next();
}
