import http from 'http';
import https from 'https';
import type { LookupFunction } from 'net';
import type { PinnedTarget } from './ssrf';

// ─────────────────────────────────────────────────────────────────────────────
// Outgoing JSON request of the notification plugins, connected to the PINNED
// address checked by the SSRF guard (custom `lookup`), TLS verified against
// the URL's host name (SNI + certificate), no redirect followed, bounded
// response size (the response is cut once MAX_BODY is read) and bounded time:
// an idle timeout AND a hard wall-clock deadline (a tenant endpoint trickling
// one byte every few seconds must not hold a delivery slot forever). Errors never carry the URL (it may hold a
// secret: Discord webhook, Telegram bot token).
// ─────────────────────────────────────────────────────────────────────────────

export interface HttpResult {
  status: number;
  /** First KiB of the body (diagnostics). */
  body: string;
}

const MAX_BODY = 1024;
/** Default wall-clock deadline of one request (connect + send + response). */
export const DEFAULT_DEADLINE_MS = 15_000;

export class DeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliveryError';
  }
}

export function requestJson(
  target: PinnedTarget,
  opts: { method: 'POST' | 'PUT'; headers?: Record<string, string>; body: unknown; timeoutMs?: number; deadlineMs?: number },
): Promise<HttpResult> {
  const payload = Buffer.from(JSON.stringify(opts.body), 'utf8');
  const { url } = target;
  const lookup: LookupFunction = (_hostname, options, cb) => {
    const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
    if (all) (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address: target.address, family: target.family }]);
    else cb(null, target.address, target.family);
  };
  const mod = url.protocol === 'http:' ? http : https;
  return new Promise<HttpResult>((resolve, reject) => {
    let settled = false;
    let deadline: NodeJS.Timeout | null = null;
    const finish = (err: Error | null, result?: HttpResult) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (err) reject(err);
      else resolve(result!);
    };
    const req = mod.request({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: `${url.pathname}${url.search}`,
      method: opts.method,
      lookup,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(payload.length),
        'User-Agent': 'Oblimint-Notifier/1',
        ...(opts.headers ?? {}),
      },
      timeout: opts.timeoutMs ?? 10_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const done = () => finish(null, { status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8').slice(0, MAX_BODY) });
      res.on('data', (c: Buffer) => {
        if (settled) return;
        chunks.push(c);
        size += c.length;
        if (size >= MAX_BODY) {
          // Enough for the diagnostics: answer now and drop the rest of the body.
          done();
          res.destroy();
        }
      });
      res.on('end', done);
      res.on('close', () => { if (!settled) finish(new DeliveryError('response aborted')); });
      res.on('error', (err) => finish(new DeliveryError(`response error (${(err as NodeJS.ErrnoException).code ?? err.message})`)));
    });
    deadline = setTimeout(() => {
      const err = new DeliveryError('timed out');
      finish(err);
      req.destroy(err);
    }, opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
    deadline.unref?.();
    req.on('timeout', () => req.destroy(new DeliveryError('timed out')));
    req.on('error', (err) => {
      finish(err instanceof DeliveryError ? err : new DeliveryError(`connection failed (${(err as NodeJS.ErrnoException).code ?? err.message})`));
    });
    req.end(payload);
  });
}
