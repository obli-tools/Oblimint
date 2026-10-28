// ─────────────────────────────────────────────────────────────────────────────
// Request guards and response headers of the webmail host — PURE parts
// (guards.test.ts).
//
// CSRF (state-changing methods): the Origin header must be the webmail host's
// own origin (Sec-Fetch-Site, when sent, must say same-origin) AND the header
// X-Oblimint-CSRF must carry the expected token (session token, or the
// pre-login double-submit cookie). A cross-site form cannot set that header;
// a cross-site fetch with it triggers a CORS preflight this host never
// answers. The session cookie is SameSite=Strict on top of that.
// ─────────────────────────────────────────────────────────────────────────────

export const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Content-Security-Policy of the whole webmail host. The message iframe
 * (srcdoc) INHERITS this policy: inline styles and https: images must be
 * allowed here for a mail to render — the iframe adds its own stricter
 * <meta> policy (no https: images until "show images"), and has no script
 * at all (sandbox without allow-scripts). The SPA itself renders no
 * untrusted markup.
 */
export const WEBMAIL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' about:",
  "child-src 'self' about:",
  "manifest-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** API responses: nothing is ever rendered from them. */
export const WEBMAIL_API_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

export const WEBMAIL_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'X-Robots-Tag': 'noindex, nofollow',
};

/** Host of the request (lower case, without port), null when absent / malformed. */
export function requestHost(hostHeader: string | undefined): string | null {
  const h = String(hostHeader ?? '').trim().toLowerCase();
  if (!h || h.length > 260) return null;
  const m = /^([a-z0-9.-]+|\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/.exec(h);
  return m ? m[0] : null;
}

/**
 * Same-origin check of a state-changing request. `secure`: the host is served
 * over HTTPS (production); in development (plain HTTP) the http origin is accepted.
 */
export function sameOrigin(
  headers: { origin?: string; host?: string; 'sec-fetch-site'?: string },
  secure: boolean,
): boolean {
  const host = requestHost(headers.host);
  if (!host) return false;
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return false;
  const origin = String(headers.origin ?? '').trim().toLowerCase();
  if (!origin) return false;
  if (origin === `https://${host}`) return true;
  return !secure && origin === `http://${host}`;
}

/** Cookie header → value of `name` (first occurrence), null when absent. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      try { return decodeURIComponent(v); } catch { return null; }
    }
  }
  return null;
}

export interface CookieOptions {
  secure: boolean;
  maxAgeSec?: number;
  /** Clears the cookie. */
  clear?: boolean;
}

/** Set-Cookie value: host-only (no Domain), Path=/, HttpOnly, SameSite=Strict, Secure in production. */
export function cookieHeader(name: string, value: string, opts: CookieOptions): string {
  const parts = [`${name}=${opts.clear ? '' : encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (opts.secure) parts.push('Secure');
  if (opts.clear) parts.push('Max-Age=0');
  else if (opts.maxAgeSec !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAgeSec))}`);
  return parts.join('; ');
}

/** Key of the per-address login throttle: the IPv4 address, or the /64 of an IPv6 one. */
export function throttleKey(ip: string): string {
  const v = ip.trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  if (!v.includes(':')) return v;
  // Expand to 8 groups, keep the first 4.
  const [head, tail = ''] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = v.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '') || '0').join(':')}::/64`;
}

/** Sliding-window failure counter (login throttle, per key). Memory only, bounded. */
export class FailureCounter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly windowMs: number, private readonly max: number, private readonly maxKeys = 50_000) {}

  /** Failures of `key` inside the window. */
  count(key: string, now: number): number {
    const list = this.hits.get(key);
    if (!list) return 0;
    const live = list.filter((t) => now - t < this.windowMs);
    if (live.length) this.hits.set(key, live); else this.hits.delete(key);
    return live.length;
  }

  blocked(key: string, now: number): boolean {
    return this.count(key, now) >= this.max;
  }

  /** Seconds until `key` may try again (0 = now). */
  retryAfterSec(key: string, now: number): number {
    const list = this.hits.get(key);
    if (!list || this.count(key, now) < this.max) return 0;
    const oldest = Math.min(...(this.hits.get(key) ?? [now]));
    return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
  }

  record(key: string, now: number): number {
    if (this.hits.size >= this.maxKeys && !this.hits.has(key)) {
      const first = this.hits.keys().next().value;
      if (first !== undefined) this.hits.delete(first);
    }
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.hits.set(key, list.slice(-Math.max(this.max * 2, 1)));
    return list.length;
  }

  clear(key: string): void {
    this.hits.delete(key);
  }
}
