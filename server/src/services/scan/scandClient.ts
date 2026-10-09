import http from 'http';
import https from 'https';
import { cleanRuleName, cleanSignature, cleanText } from './scoring';

// ─────────────────────────────────────────────────────────────────────────────
// HTTP client of scand (container oblimint-scanner, images/scanner/scand,
// docs/P3-PLAN.md §9.1). Panel network only; every request carries the shared
// key (X-Oblimint-Scanner-Key, M10). Keep-alive agent, per-request timeout,
// bounded response bodies. Responses are VALIDATED and reduced to the fields
// the panel uses (rule names, signature names, versions): raw scand text never
// reaches a client (A6) — errors are summarized as a ScandError kind.
// ─────────────────────────────────────────────────────────────────────────────

export const SCANNER_KEY_HEADER = 'x-oblimint-scanner-key';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_MATCHES = 64;
const MAX_NAME_PARAM = 255;

export type ScandErrorKind = 'unreachable' | 'timeout' | 'unauthorized' | 'tooLarge' | 'protocol' | 'aborted';

export class ScandError extends Error {
  constructor(public readonly kind: ScandErrorKind, message: string, public readonly status: number | null = null) {
    super(message);
    this.name = 'ScandError';
  }
  /** The scanner cannot serve anything (stop sending the rest of a change set). */
  get fatal(): boolean {
    return this.kind === 'unreachable' || this.kind === 'timeout' || this.kind === 'unauthorized';
  }
}

export interface ScandClamavResult {
  status: 'ok' | 'found' | 'error' | 'disabled';
  signature: string | null;
}

export interface ScandYaraMatch {
  rule: string;
  tags: string[];
  meta: Record<string, string | number | boolean>;
}

export interface ScandYaraResult {
  matches: ScandYaraMatch[];
  /** The engine failed on this file. */
  error: boolean;
  disabled: boolean;
}

export interface ScandScanResult {
  clamav: ScandClamavResult;
  yara: ScandYaraResult;
}

export interface ScandEngineStatus {
  enabled: boolean;
  available: boolean;
  version: string | null;
  signatureVersion: string | null;
  signaturesUpdatedAt: string | null;
  ruleCount: number | null;
  error: string | null;
}

export interface ScandStatus {
  version: string | null;
  clamav: ScandEngineStatus;
  yara: ScandEngineStatus;
}

export interface ScandClient {
  scan(name: string, data: Buffer, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ScandScanResult>;
  status(opts?: { timeoutMs?: number }): Promise<ScandStatus>;
  /** freshclam now + clamd reload (long: minutes). */
  update(opts?: { timeoutMs?: number }): Promise<void>;
}

export interface ScandClientOptions {
  baseUrl: string;
  key: string;
  /** Per-file scan timeout (default 90 s: clamd INSTREAM + YARA 30 s). */
  scanTimeoutMs?: number;
}

const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

function toScandError(err: unknown): ScandError {
  if (err instanceof ScandError) return err;
  const e = err as { code?: string; name?: string; message?: string } | null;
  if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR') return new ScandError('aborted', 'scan aborted');
  if (e?.code && UNREACHABLE_CODES.has(e.code)) return new ScandError('unreachable', `scanner unreachable (${e.code})`);
  return new ScandError('protocol', `scanner request failed (${cleanText(e?.code ?? e?.message ?? 'error', 60)})`);
}

const agents = new Map<string, http.Agent>();
function agentFor(url: URL): http.Agent {
  const k = url.protocol;
  let a = agents.get(k);
  if (!a) {
    a = url.protocol === 'https:'
      ? new https.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 10_000 })
      : new http.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 10_000 });
    agents.set(k, a);
  }
  return a;
}

function request(
  base: string, key: string, method: 'GET' | 'POST', pathAndQuery: string,
  body: Buffer | null, timeoutMs: number, signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(pathAndQuery, base.endsWith('/') ? base : `${base}/`);
    } catch {
      reject(new ScandError('protocol', 'invalid scanner URL'));
      return;
    }
    if (signal?.aborted) {
      reject(new ScandError('aborted', 'scan aborted'));
      return;
    }
    const mod = url.protocol === 'https:' ? https : http;
    const headers: Record<string, string | number> = { [SCANNER_KEY_HEADER]: key, accept: 'application/json' };
    if (body) {
      headers['content-type'] = 'application/octet-stream';
      headers['content-length'] = body.length;
    } else if (method === 'POST') {
      headers['content-length'] = 0;
    }
    let settled = false;
    const done = (err: ScandError | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(value);
    };
    const req = mod.request(url, { method, headers, agent: agentFor(url) }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy();
          done(new ScandError('protocol', 'scanner response too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('error', (err) => done(toScandError(err)));
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status === 401 || status === 403) return done(new ScandError('unauthorized', 'scanner refused the shared key', status));
        if (status === 413) return done(new ScandError('tooLarge', 'file larger than the scanner limit', status));
        if (status < 200 || status >= 300) return done(new ScandError('protocol', `scanner answered HTTP ${status}`, status));
        if (method === 'POST' && pathAndQuery.startsWith('v1/update')) return done(null, null);
        try {
          done(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          done(new ScandError('protocol', 'scanner sent invalid JSON', status));
        }
      });
    });
    const timer = setTimeout(() => {
      req.destroy();
      done(new ScandError('timeout', `scanner did not answer within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    const onAbort = () => {
      req.destroy();
      done(new ScandError('aborted', 'scan aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (err) => done(toScandError(err)));
    if (body) req.end(body);
    else req.end();
  });
}

// ── response validation ──────────────────────────────────────────────────────

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

export function parseScanResult(raw: unknown): ScandScanResult {
  const root = obj(raw);
  const c = obj(root.clamav);
  const status = (['ok', 'found', 'error', 'disabled'] as const).find((s) => s === c.status);
  if (!status) throw new ScandError('protocol', 'scanner sent an unexpected ClamAV status');
  const signature = status === 'found' ? cleanSignature(c.signature) ?? 'Unknown.Signature' : null;

  const y = obj(root.yara);
  const matches: ScandYaraMatch[] = [];
  if (Array.isArray(y.matches)) {
    for (const m of y.matches.slice(0, MAX_MATCHES)) {
      const mo = obj(m);
      const rule = cleanRuleName(mo.rule);
      if (!rule) continue;
      const tags = Array.isArray(mo.tags) ? mo.tags.map((t) => cleanRuleName(t)).filter((t): t is string => !!t).slice(0, 16) : [];
      const meta: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(obj(mo.meta)).slice(0, 32)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) continue;
        if (typeof v === 'number' && Number.isFinite(v)) meta[k] = v;
        else if (typeof v === 'boolean') meta[k] = v;
        else if (typeof v === 'string') meta[k] = cleanText(v, 300);
      }
      matches.push({ rule, tags, meta });
    }
  }
  return {
    clamav: { status, signature },
    yara: { matches, error: typeof y.error === 'string' && y.error.length > 0, disabled: y.disabled === true },
  };
}

function engineStatus(raw: unknown): ScandEngineStatus {
  const o = obj(raw);
  const str = (v: unknown, max = 80): string | null => (typeof v === 'string' && v.trim() ? cleanText(v, max) : null);
  const date = str(o.signaturesUpdatedAt, 40);
  return {
    enabled: o.enabled === true,
    available: o.available === true,
    version: str(o.version, 40),
    signatureVersion: str(o.signatureVersion, 80),
    signaturesUpdatedAt: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null,
    ruleCount: typeof o.ruleCount === 'number' && Number.isInteger(o.ruleCount) && o.ruleCount >= 0 ? o.ruleCount : null,
    // scand already reduces its errors to short codes ('clamd unreachable', 'loading'…).
    error: str(o.error, 120),
  };
}

export function parseStatus(raw: unknown): ScandStatus {
  const root = obj(raw);
  return {
    version: typeof root.version === 'string' ? cleanText(root.version, 40) || null : null,
    clamav: engineStatus(root.clamav),
    yara: engineStatus(root.yara),
  };
}

/** Informational file name for scand's logs: relative path, URL-encoded, length-capped (never trusted by scand). */
export function nameParam(rel: string): string {
  return encodeURIComponent(cleanText(rel, MAX_NAME_PARAM));
}

export function createScandClient(opts: ScandClientOptions): ScandClient {
  const scanTimeout = opts.scanTimeoutMs ?? 90_000;
  return {
    async scan(name, data, o) {
      try {
        const raw = await request(opts.baseUrl, opts.key, 'POST', `v1/scan?name=${nameParam(name)}`, data, o?.timeoutMs ?? scanTimeout, o?.signal);
        return parseScanResult(raw);
      } catch (err) {
        throw toScandError(err);
      }
    },
    async status(o) {
      try {
        return parseStatus(await request(opts.baseUrl, opts.key, 'GET', 'v1/status', null, o?.timeoutMs ?? 5_000));
      } catch (err) {
        throw toScandError(err);
      }
    },
    async update(o) {
      try {
        await request(opts.baseUrl, opts.key, 'POST', 'v1/update', null, o?.timeoutMs ?? 10 * 60_000);
      } catch (err) {
        throw toScandError(err);
      }
    },
  };
}
