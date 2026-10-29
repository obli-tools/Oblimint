import http from 'http';
import https from 'https';
import type { LookupFunction } from 'net';
import { HEARTBEAT_URL_MAX } from '@oblimint/shared';
import { assertTargetAllowed, resolveTarget, type PinnedAddress, type TargetPolicy } from '../monitoring/targetGuard';

// ─────────────────────────────────────────────────────────────────────────────
// Outbound heartbeat ("push" monitor: Healthchecks, Uptime Kuma, Obliview…):
// a GET on the operator's URL, sent only while every deep check is green.
// The URL goes through the monitoring anti-SSRF guard (targetGuard, MO1):
// syntax at save time, resolution + PINNED address at every call (no DNS
// rebinding), redirects never followed, whole call bounded, body discarded.
// ─────────────────────────────────────────────────────────────────────────────

export const HEARTBEAT_TIMEOUT_MS = 10_000;
const MAX_BODY = 64 * 1024;

export class HeartbeatUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeartbeatUrlError';
  }
}

/** Parsed URL or HeartbeatUrlError (format only: http(s), no credentials, bounded). */
export function parseHeartbeatUrl(raw: string): URL {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > HEARTBEAT_URL_MAX) throw new HeartbeatUrlError('invalid URL');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HeartbeatUrlError('invalid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HeartbeatUrlError('only http:// and https:// URLs are allowed');
  if (url.username || url.password) throw new HeartbeatUrlError('credentials in the URL are not allowed');
  if (!url.hostname) throw new HeartbeatUrlError('invalid URL');
  return url;
}

export function urlPort(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443;
}

/** scheme://host[:port] — what the settings show back (the path / query often carry the secret). */
export function heartbeatOrigin(raw: string): string | null {
  try {
    return parseHeartbeatUrl(raw).origin;
  } catch {
    return null;
  }
}

/** Save-time check: format + anti-SSRF guard (a DNS failure is not a refusal yet). */
export async function assertHeartbeatUrl(raw: string, policy: TargetPolicy): Promise<URL> {
  const url = parseHeartbeatUrl(raw);
  await assertTargetAllowed(url.hostname, policy);
  return url;
}

function pinnedLookup(pin: PinnedAddress): LookupFunction {
  return (_hostname, options, cb) => {
    const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
    if (all) (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address: pin.address, family: pin.family }]);
    else cb(null, pin.address, pin.family);
  };
}

export interface HeartbeatDeps {
  policy: TargetPolicy;
  /** Tests: replaces the guard's resolution (the real one refuses loopback). */
  resolve?: (host: string, policy: TargetPolicy) => Promise<PinnedAddress>;
  timeoutMs?: number;
}

/** Sends one heartbeat; resolves the HTTP status (2xx), throws otherwise. */
export async function sendHeartbeat(raw: string, deps: HeartbeatDeps): Promise<number> {
  const url = parseHeartbeatUrl(raw);
  const pin = await (deps.resolve ?? resolveTarget)(url.hostname, deps.policy);
  const mod = url.protocol === 'http:' ? http : https;
  const timeoutMs = deps.timeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  const status = await new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, s?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(s!);
    };
    const req = mod.request({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: urlPort(url),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      lookup: pinnedLookup(pin),
      agent: false,
      headers: { 'User-Agent': 'Oblimint-Heartbeat/1', Accept: '*/*', Connection: 'close' },
    }, (res) => {
      let size = 0;
      const code = res.statusCode ?? 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) { res.destroy(); finish(null, code); }
      });
      res.on('end', () => finish(null, code));
      res.on('error', (e) => finish(e));
      res.on('close', () => finish(null, code));
    });
    const timer = setTimeout(() => {
      const err = new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`);
      finish(err);
      req.destroy(err);
    }, timeoutMs);
    req.on('error', (e) => finish(new Error(`connection failed (${(e as NodeJS.ErrnoException).code ?? 'error'})`)));
    req.end();
  });
  if (status < 200 || status > 299) throw new Error(`HTTP ${status}`);
  return status;
}
