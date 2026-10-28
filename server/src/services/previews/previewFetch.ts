import crypto from 'crypto';
import http from 'http';
import {
  isValidPreviewPath, PREVIEW_FETCH_CLIENT_IP, PREVIEW_FETCH_MAX_BYTES, SITE_CONTAINER_PORT, type PreviewFetchSide,
} from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Feature B — server-side fetch of ONE path of a preview container (or of the
// live primary container for a compare). Fixed target (a container name the
// caller derived from ids, never a user value), origin-form path validated,
// GET / HEAD only, no redirect followed, no header of the caller forwarded.
// X-Forwarded-For is ALWAYS 192.0.2.1 (TEST-NET-1, A4): never private nor
// loopback, so `Require local` / `allow 127.0.0.1` guards of the site stay
// closed (the images trust XFF from the private ranges). Errors become a
// field, never an exception, and never name the container nor an address.
// ─────────────────────────────────────────────────────────────────────────────

export const FETCH_IDLE_TIMEOUT_MS = 5_000;
export const FETCH_TOTAL_TIMEOUT_MS = 10_000;
export const FETCH_USER_AGENT = 'Oblimint-Preview-Fetch/1';

/** Response headers passed back (lower case). Set-Cookie: names only (setCookieNames). */
export const FETCH_HEADER_ALLOWLIST: readonly string[] = [
  'content-type', 'content-length', 'content-language', 'cache-control', 'expires', 'last-modified', 'etag', 'vary',
  'location', 'x-powered-by', 'server', 'x-robots-tag', 'content-security-policy', 'x-frame-options', 'strict-transport-security',
  'referrer-policy', 'link', 'retry-after', 'www-authenticate', 'x-content-type-options',
];

export function validatePreviewPath(p: unknown): string | null {
  return isValidPreviewPath(p) ? p : null;
}

export interface FetchContainerOptions {
  host: string;
  method?: 'GET' | 'HEAD';
  maxBytes?: number;
  /** Tests: another port / request implementation. */
  port?: number;
  request?: typeof http.request;
}

/** Headers sent to the container: nothing of the caller. Exported for the tests (A4). */
export function fetchRequestHeaders(host: string): Record<string, string> {
  return {
    Host: host,
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-Host': host,
    'X-Forwarded-For': PREVIEW_FETCH_CLIENT_IP,
    'X-Real-IP': PREVIEW_FETCH_CLIENT_IP,
    'Accept-Encoding': 'identity',
    'User-Agent': FETCH_USER_AGENT,
    Accept: '*/*',
    Connection: 'close',
  };
}

/** Binary when it holds a NUL byte or is not valid UTF-8 (first bytes are enough for a verdict). */
export function looksBinary(buf: Buffer): boolean {
  if (buf.includes(0)) return true;
  const s = buf.toString('utf8');
  // A truncated multi-byte sequence at the very end is not binary.
  const replacement = (s.match(/�/g) ?? []).length;
  return replacement > 2;
}

function cookieNames(v: string | string[] | undefined): string[] {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return [...new Set(list.map((c) => c.split('=')[0]?.trim()).filter((n): n is string => !!n && /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(n)))].slice(0, 50);
}

/**
 * GET / HEAD of `path` on http://<container>:8080 (never throws). `container`
 * must come from naming.ts (siteContainer / releasePreviewContainer).
 */
export function fetchContainer(container: string, path: string, opts: FetchContainerOptions): Promise<PreviewFetchSide> {
  const started = Date.now();
  const maxBytes = Math.max(1, Math.min(opts.maxBytes ?? PREVIEW_FETCH_MAX_BYTES, PREVIEW_FETCH_MAX_BYTES));
  const empty = (error: PreviewFetchSide['error']): PreviewFetchSide => ({
    status: null, error, headers: {}, location: null, setCookieNames: [], contentType: null, bytes: 0, truncated: false,
    binary: false, body: null, sha256: null, ms: Date.now() - started,
  });
  if (!isValidPreviewPath(path) || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(container)) return Promise.resolve(empty('protocol'));
  return new Promise<PreviewFetchSide>((resolve) => {
    let settled = false;
    const done = (v: PreviewFetchSide) => {
      if (settled) return;
      settled = true;
      clearTimeout(total);
      resolve(v);
    };
    const ac = new AbortController();
    const total = setTimeout(() => { ac.abort(); done(empty('timeout')); }, FETCH_TOTAL_TIMEOUT_MS);
    total.unref?.();
    let req: http.ClientRequest;
    try {
      req = (opts.request ?? http.request)({
        host: container,
        port: opts.port ?? SITE_CONTAINER_PORT,
        path,
        method: opts.method ?? 'GET',
        headers: fetchRequestHeaders(opts.host),
        agent: false,
        signal: ac.signal,
        timeout: FETCH_IDLE_TIMEOUT_MS,
      }, (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        let truncated = false;
        const hash = crypto.createHash('sha256');
        res.on('data', (c: Buffer) => {
          if (truncated) return;
          const room = maxBytes - bytes;
          if (c.length > room) {
            if (room > 0) { chunks.push(c.subarray(0, room)); hash.update(c.subarray(0, room)); bytes += room; }
            truncated = true;
            res.destroy();
            finish();
            return;
          }
          chunks.push(c);
          hash.update(c);
          bytes += c.length;
        });
        let finished = false;
        const finish = () => {
          // Once: a truncated body ends here, then 'end' / 'close' may still fire.
          if (finished) return;
          finished = true;
          const body = Buffer.concat(chunks);
          const headers: Record<string, string> = {};
          for (const name of FETCH_HEADER_ALLOWLIST) {
            const v = res.headers[name];
            if (v === undefined) continue;
            headers[name] = (Array.isArray(v) ? v.join(', ') : String(v)).slice(0, 1024);
          }
          const binary = looksBinary(body.subarray(0, 8192));
          done({
            status: res.statusCode ?? null,
            error: null,
            headers,
            location: typeof res.headers.location === 'string' ? res.headers.location.slice(0, 2048) : null,
            setCookieNames: cookieNames(res.headers['set-cookie']),
            contentType: typeof res.headers['content-type'] === 'string' ? res.headers['content-type'].slice(0, 256) : null,
            bytes,
            truncated,
            binary,
            body: binary ? null : body.toString('utf8'),
            sha256: hash.digest('hex'),
            ms: Date.now() - started,
          });
        };
        res.on('end', finish);
        res.on('error', () => (truncated ? undefined : done(empty('protocol'))));
      });
    } catch {
      done(empty('protocol'));
      return;
    }
    req.on('timeout', () => { req.destroy(); done(empty('timeout')); });
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err?.name === 'AbortError') return done(empty('timeout'));
      const code = err?.code ?? '';
      done(empty(code === 'HPE_HEADER_OVERFLOW' || code.startsWith('HPE_') ? 'protocol' : 'unreachable'));
    });
    req.end();
  });
}
