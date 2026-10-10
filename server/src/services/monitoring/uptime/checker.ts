import http from 'http';
import https from 'https';
import net, { type LookupFunction } from 'net';
import type { UptimeMonitorKind } from '@oblimint/shared';
import { TargetRefusedError, type PinnedAddress } from '../targetGuard';

// ─────────────────────────────────────────────────────────────────────────────
// One uptime check (docs/P4b-PLAN.md §10.2):
//   http / keyword — GET or HEAD, every hop (≤ MAX_REDIRECTS redirects)
//     resolved through the anti-SSRF guard and connected to the PINNED
//     address (custom lookup: no DNS rebinding), TLS verified against the
//     URL's host, whole check bounded by timeoutMs, body read only for a
//     keyword (≤ MAX_BODY, cut beyond), expected statuses (empty = 2xx / 3xx);
//   tcp — net.connect to the pinned address.
// Error texts are GENERIC (they are shown to the client and on nothing
// public): never the resolved address nor a server message.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_REDIRECTS = 5;
export const MAX_BODY = 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface CheckTarget {
  kind: UptimeMonitorKind;
  url: string | null;
  host: string | null;
  port: number | null;
  keyword: string | null;
  keywordInvert: boolean;
  method: 'GET' | 'HEAD';
  /** Empty = any 2xx / 3xx. */
  expectedStatus: number[];
  timeoutMs: number;
}

export interface CheckResult {
  ok: boolean;
  latencyMs: number | null;
  statusCode: number | null;
  error: string | null;
}

export interface CheckerDeps {
  /**
   * Anti-SSRF resolution of a host (throws TargetRefusedError). `port` = the
   * port of THIS connection (every redirect hop included): the node's own
   * public addresses are only reachable on 80 / 443 by an HTTP check.
   */
  resolve: (host: string, port: number) => Promise<PinnedAddress>;
}

class CheckError extends Error {
  constructor(message: string, readonly statusCode: number | null = null) {
    super(message);
  }
}

export function statusExpected(status: number, expected: readonly number[]): boolean {
  if (expected.length === 0) return status >= 200 && status < 400;
  return expected.includes(status);
}

/** Generic text of a network error (no address, no server message). */
export function networkErrorText(err: unknown): string {
  if (err instanceof CheckError) return err.message;
  if (err instanceof TargetRefusedError) return 'destination refused';
  const code = String((err as NodeJS.ErrnoException)?.code ?? '');
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'connection reset';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timed out';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'host unreachable';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS resolution failed';
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME|ALTNAME/i.test(code)) return 'TLS certificate error';
  if (code === 'HPE_HEADER_OVERFLOW' || code.startsWith('HPE_')) return 'invalid HTTP response';
  return 'connection failed';
}

/** Rejects with 'timed out' when the signal aborts first (a slow DNS answer is bounded too). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new CheckError('timed out'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CheckError('timed out'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

function pinnedLookup(pin: PinnedAddress): LookupFunction {
  return (_hostname, options, cb) => {
    const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
    if (all) (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address: pin.address, family: pin.family }]);
    else cb(null, pin.address, pin.family);
  };
}

interface HopResult {
  status: number;
  location: string | null;
  body: string | null;
}

function oneHop(url: URL, pin: PinnedAddress, method: 'GET' | 'HEAD', readBody: boolean, signal: AbortSignal): Promise<HopResult> {
  const mod = url.protocol === 'http:' ? http : https;
  return new Promise<HopResult>((resolve, reject) => {
    let settled = false;
    const finish = (err: unknown, r?: HopResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(r!);
    };
    const req = mod.request({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: `${url.pathname}${url.search}`,
      method,
      lookup: pinnedLookup(pin),
      agent: false,
      headers: { 'User-Agent': 'Oblimint-Uptime/1', Accept: '*/*', Connection: 'close' },
    }, (res) => {
      const status = res.statusCode ?? 0;
      const location = typeof res.headers.location === 'string' ? res.headers.location : null;
      if (!readBody || method === 'HEAD' || REDIRECT_STATUSES.has(status)) {
        res.destroy();
        finish(null, { status, location, body: null });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      const done = () => finish(null, { status, location, body: Buffer.concat(chunks).toString('utf8') });
      res.on('data', (c: Buffer) => {
        if (settled) return;
        const room = MAX_BODY - size;
        if (c.length >= room) {
          chunks.push(c.subarray(0, room));
          size = MAX_BODY;
          done();
          res.destroy();
          return;
        }
        chunks.push(c);
        size += c.length;
      });
      res.on('end', done);
      res.on('error', (err) => finish(err));
      res.on('close', () => { if (!settled) done(); });
    });
    const onAbort = () => {
      const err = new CheckError('timed out');
      finish(err);
      req.destroy(err);
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort);
    req.on('error', (err) => finish(err));
    req.end();
  });
}

async function httpCheck(t: CheckTarget, deps: CheckerDeps, signal: AbortSignal, started: number): Promise<CheckResult> {
  if (!t.url) throw new CheckError('no URL');
  let url: URL;
  try {
    url = new URL(t.url);
  } catch {
    throw new CheckError('invalid URL');
  }
  const wantBody = t.kind === 'keyword' && !!t.keyword;
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CheckError('unsupported redirect');
    if (url.username || url.password) throw new CheckError('credentials in the URL are not allowed');
    const pin = await raceAbort(deps.resolve(url.hostname, Number(url.port) || (url.protocol === 'http:' ? 80 : 443)), signal);
    const res = await oneHop(url, pin, wantBody ? 'GET' : t.method, wantBody, signal);
    if (REDIRECT_STATUSES.has(res.status) && res.location) {
      if (hop >= MAX_REDIRECTS) throw new CheckError('too many redirects', res.status);
      try {
        url = new URL(res.location, url);
      } catch {
        throw new CheckError('invalid redirect', res.status);
      }
      continue;
    }
    const latencyMs = Date.now() - started;
    if (!statusExpected(res.status, t.expectedStatus)) return { ok: false, latencyMs, statusCode: res.status, error: `unexpected status ${res.status}` };
    if (wantBody) {
      const found = (res.body ?? '').includes(t.keyword as string);
      if (found === t.keywordInvert) {
        return { ok: false, latencyMs, statusCode: res.status, error: t.keywordInvert ? 'keyword found' : 'keyword not found' };
      }
    }
    return { ok: true, latencyMs, statusCode: res.status, error: null };
  }
}

async function tcpCheck(t: CheckTarget, deps: CheckerDeps, signal: AbortSignal, started: number): Promise<CheckResult> {
  if (!t.host || !t.port) throw new CheckError('no host / port');
  const pin = await raceAbort(deps.resolve(t.host, t.port), signal);
  await new Promise<void>((resolve, reject) => {
    const sock = net.connect({ host: pin.address, port: t.port as number, family: pin.family });
    const onAbort = () => { sock.destroy(); reject(new CheckError('timed out')); };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    sock.once('connect', () => {
      signal.removeEventListener('abort', onAbort);
      sock.destroy();
      resolve();
    });
    sock.once('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      sock.destroy();
      reject(err);
    });
  });
  return { ok: true, latencyMs: Date.now() - started, statusCode: null, error: null };
}

/** Runs one check. Never throws. */
export async function runCheck(t: CheckTarget, deps: CheckerDeps): Promise<CheckResult> {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(500, t.timeoutMs));
  timer.unref?.();
  try {
    return t.kind === 'tcp' ? await tcpCheck(t, deps, ctl.signal, started) : await httpCheck(t, deps, ctl.signal, started);
  } catch (err) {
    return { ok: false, latencyMs: null, statusCode: err instanceof CheckError ? err.statusCode : null, error: networkErrorText(err) };
  } finally {
    clearTimeout(timer);
  }
}
