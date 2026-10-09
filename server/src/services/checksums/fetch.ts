import https from 'https';
import type { IncomingMessage } from 'http';
import type { ChecksumFetchJson } from '../maintenance/contracts';

// ─────────────────────────────────────────────────────────────────────────────
// Fetcher of the official checksum lists (docs/P3-PLAN.md §10.1, M11 / N1).
//
//   - HTTPS GET only, to a FIXED allow-list of hosts (api.wordpress.org,
//     downloads.wordpress.org): providers build the URL from validated
//     parameters, this layer refuses anything else (no tenant-controlled URL);
//   - a redirect is followed only to the SAME host, over HTTPS (3 hops max);
//   - 15 s for the whole exchange, 20 MiB body cap, JSON parsed here;
//   - 404 / 410 ⇒ null (no such distribution / version); any other failure
//     throws (the provider maps it to a component 'error');
//   - in-memory cache, 24 h, bounded (LRU), shared by every verification;
//     concurrent requests of one URL share the same exchange. Failures are
//     not cached.
// ─────────────────────────────────────────────────────────────────────────────

export const CHECKSUM_HOSTS: ReadonlySet<string> = new Set(['api.wordpress.org', 'downloads.wordpress.org']);
export const CHECKSUM_FETCH_TIMEOUT_MS = 15_000;
export const CHECKSUM_FETCH_MAX_BYTES = 20 * 1024 * 1024;
export const CHECKSUM_CACHE_TTL_MS = 24 * 60 * 60_000;
export const CHECKSUM_CACHE_MAX_ENTRIES = 256;
const MAX_REDIRECTS = 3;

export class ChecksumFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChecksumFetchError';
  }
}

/** The URL is an HTTPS URL of an allowed host, without credentials nor explicit port. */
export function allowedChecksumUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  if (!CHECKSUM_HOSTS.has(u.hostname.toLowerCase())) return null;
  return u;
}

/** One GET (no redirect handling): status, location, body (capped). */
type GetFn = (url: URL, opts: { timeoutMs: number; maxBytes: number }) => Promise<{ status: number; location: string | null; body: Buffer }>;

const httpsGet: GetFn = (url, opts) => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (err: Error | null, value?: { status: number; location: string | null; body: Buffer }) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (err) reject(err); else resolve(value!);
  };
  const req = https.get(url, {
    headers: { accept: 'application/json', 'user-agent': 'Oblimint checksum verifier' },
    // Never a proxy / agent of the environment: a direct TLS connection, certificates verified.
    agent: false,
  }, (res: IncomingMessage) => {
    const status = res.statusCode ?? 0;
    const location = typeof res.headers.location === 'string' ? res.headers.location : null;
    if (status !== 200) {
      res.resume();
      finish(null, { status, location, body: Buffer.alloc(0) });
      return;
    }
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      res.destroy();
      finish(new ChecksumFetchError(`response too large (${declared} bytes)`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (c: Buffer) => {
      size += c.length;
      if (size > opts.maxBytes) {
        res.destroy();
        finish(new ChecksumFetchError(`response larger than ${opts.maxBytes} bytes`));
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => finish(null, { status, location, body: Buffer.concat(chunks) }));
    res.on('error', (err) => finish(new ChecksumFetchError(err.message)));
  });
  const timer = setTimeout(() => {
    req.destroy();
    finish(new ChecksumFetchError(`timed out after ${Math.round(opts.timeoutMs / 1000)} s`));
  }, opts.timeoutMs);
  req.on('error', (err) => finish(new ChecksumFetchError(err.message)));
});

let getImpl: GetFn = httpsGet;

/** Test seam of the raw GET (null restores the real HTTPS client). */
export function setChecksumHttpGetForTests(fn: GetFn | null): void {
  getImpl = fn ?? httpsGet;
}

/** Production fetcher (no cache): allow-listed HTTPS GET, same-host redirects, JSON. */
export const fetchChecksumJson: ChecksumFetchJson = async (raw, opts = {}) => {
  const timeoutMs = Math.min(opts.timeoutMs ?? CHECKSUM_FETCH_TIMEOUT_MS, CHECKSUM_FETCH_TIMEOUT_MS);
  const maxBytes = Math.min(opts.maxBytes ?? CHECKSUM_FETCH_MAX_BYTES, CHECKSUM_FETCH_MAX_BYTES);
  let url = allowedChecksumUrl(raw);
  if (!url) throw new ChecksumFetchError('URL outside the official checksum hosts');
  const deadline = Date.now() + timeoutMs;
  for (let hop = 0; ; hop++) {
    const left = deadline - Date.now();
    if (left <= 0) throw new ChecksumFetchError(`timed out after ${Math.round(timeoutMs / 1000)} s`);
    const res = await getImpl(url, { timeoutMs: left, maxBytes });
    if (res.status === 200) {
      try {
        return JSON.parse(res.body.toString('utf8')) as unknown;
      } catch {
        throw new ChecksumFetchError('invalid JSON');
      }
    }
    if (res.status === 404 || res.status === 410) return null;
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (hop >= MAX_REDIRECTS || !res.location) throw new ChecksumFetchError(`HTTP ${res.status}: redirect refused`);
      let next: URL | null = null;
      try {
        next = allowedChecksumUrl(new URL(res.location, url).toString());
      } catch {
        next = null;
      }
      if (!next || next.hostname.toLowerCase() !== url.hostname.toLowerCase()) {
        throw new ChecksumFetchError(`HTTP ${res.status}: redirect to another host refused`);
      }
      url = next;
      continue;
    }
    throw new ChecksumFetchError(`HTTP ${res.status}`);
  }
};

/**
 * Bounded LRU cache (TTL) in front of a fetcher. Successful answers (JSON or
 * null = not found) are kept `ttlMs`; failures are not cached. Concurrent
 * calls of one URL share the same promise.
 */
export function createCachedFetch(
  inner: ChecksumFetchJson,
  opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
): ChecksumFetchJson & { clear(): void; size(): number } {
  const ttl = opts.ttlMs ?? CHECKSUM_CACHE_TTL_MS;
  const max = Math.max(1, opts.maxEntries ?? CHECKSUM_CACHE_MAX_ENTRIES);
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; value: unknown | null }>();
  const inflight = new Map<string, Promise<unknown | null>>();

  const fn = (async (url: string, fetchOpts?: { timeoutMs?: number; maxBytes?: number }) => {
    const hit = cache.get(url);
    if (hit) {
      cache.delete(url);
      if (now() - hit.at < ttl) {
        cache.set(url, hit); // most recently used last
        return hit.value;
      }
    }
    const running = inflight.get(url);
    if (running) return running;
    const p = inner(url, fetchOpts).then((value) => {
      cache.set(url, { at: now(), value });
      while (cache.size > max) cache.delete(cache.keys().next().value as string);
      return value;
    }).finally(() => inflight.delete(url));
    inflight.set(url, p);
    return p;
  }) as ChecksumFetchJson & { clear(): void; size(): number };
  fn.clear = () => { cache.clear(); inflight.clear(); };
  fn.size = () => cache.size;
  return fn;
}
