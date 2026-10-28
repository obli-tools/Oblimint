import type { WebmailIdentity } from '@oblimint/shared';
import { STALWART_API_URL, MASTER_USER } from '../../engines/stalwart/constants';
import { JMAP_SESSION_PATH, quoteBigInts } from '../../engines/stalwart/api';
import { JMAP_USING, type JmapCall } from './policy';

// ─────────────────────────────────────────────────────────────────────────────
// JMAP side of the Oblimint webmail: the panel talks to Stalwart's HTTP
// listener (mail network only, MA7) on behalf of ONE mailbox, always
// impersonating it: Basic "<address>%oblimint-master:<master secret>"
// (authentication.master, the same mechanism the sieve sync uses, api.ts
// H10) — the engine then only exposes that principal; the proxy additionally
// pins the account id. A mailbox password is NEVER presented to the engine
// (oblimint/auth.ts: the panel's hash is the authority), so nothing the
// webmail receives can make the engine's auto-ban block the panel's address.
// JSON answers are read with a hard byte cap (maxResponseBytes): an answer
// over it is dropped (413) instead of being buffered.
// The master secret never leaves this module; nothing of a request body,
// a password or a secret is logged or put into an error.
// ─────────────────────────────────────────────────────────────────────────────

export type FetchLike = (input: string, init?: RequestInit & { duplex?: 'half' }) => Promise<Response>;

export class WebmailEngineError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'WebmailEngineError';
  }
}

export interface JmapEndpoints {
  /** Primary account of urn:ietf:params:jmap:mail. */
  accountId: string;
  apiPath: string;
  /** Templates keep {accountId} / {blobId} / {name} / {type} / {types} / {closeafter} / {ping}. */
  uploadPath: string;
  downloadPath: string;
  eventSourcePath: string;
  capabilities: string[];
}

export interface JmapResponse {
  methodResponses: JmapCall[];
  sessionState?: string;
  createdIds?: Record<string, string>;
}

export interface WebmailEngine {
  endpoints(address: string, fresh?: boolean): Promise<JmapEndpoints>;
  call(address: string, methodCalls: JmapCall[]): Promise<JmapResponse>;
  identities(address: string, accountId: string, displayName: string | null): Promise<WebmailIdentity[]>;
  upload(address: string, accountId: string, contentType: string, body: ReadableStream<Uint8Array> | Uint8Array, signal?: AbortSignal): Promise<{ blobId: string; type: string; size: number }>;
  download(address: string, accountId: string, blobId: string, signal?: AbortSignal): Promise<Response>;
  eventSource(address: string, signal: AbortSignal): Promise<Response>;
}

export interface StalwartWebmailEngineOptions {
  baseUrl?: string;
  /** Secret of authentication.master (the Stalwart admin secret, sealed in app_config). */
  masterSecret: () => Promise<string>;
  masterUser?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  uploadTimeoutMs?: number;
  /** Largest JSON answer read from the engine (bytes); beyond: WebmailEngineError 413, nothing buffered further. */
  maxResponseBytes?: number;
  /** How long a JMAP session resource is reused per address. */
  sessionTtlMs?: number;
  now?: () => number;
}

const ADDRESS_RE = /^[^\s@%:]{1,64}@[a-z0-9.-]{1,253}$/;
const ACCOUNT_RE = /^[A-Za-z0-9_-]{1,255}$/;

/** Default cap of a JMAP answer (bodies are bounded by policy.ts well below it). */
export const MAX_ENGINE_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Body of an engine answer as text, reading at most `max` bytes: over it,
 * the stream is cancelled and WebmailEngineError 413 thrown (a declared
 * Content-Length over the cap is refused before reading anything).
 */
export async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new WebmailEngineError('the answer of the mail engine is too large', 413);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      throw new WebmailEngineError('the answer of the mail engine is too large', 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, n).toString('utf8');
}

function basic(user: string, secret: string): string {
  return `Basic ${Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')}`;
}

/**
 * Path (+ query) of a session URL template. Stalwart builds its URLs from its
 * own host name, not reachable as such: only the path is used, against the
 * API base. Anything unexpected falls back to the documented path.
 */
export function templatePath(url: unknown, fallback: string): string {
  if (typeof url !== 'string' || !url) return fallback;
  let p: string;
  try {
    const u = new URL(url.replace(/[{}]/g, (c) => (c === '{' ? '%7B' : '%7D')), 'http://placeholder.invalid');
    p = decodeURIComponent(u.pathname) + decodeURIComponent(u.search);
  } catch {
    return fallback;
  }
  return /^\/jmap\/[A-Za-z0-9_{}./?&=-]*$/.test(p) && !p.includes('..') ? p : fallback;
}

/** Fills a URL template ({name} → encoded value). Unknown placeholders are left out (empty). */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (_m, k: string) => encodeURIComponent(values[k] ?? ''));
}

function mailAddress(address: string): string {
  const a = String(address ?? '').trim().toLowerCase();
  if (a.length > 254 || !ADDRESS_RE.test(a)) throw new WebmailEngineError('invalid mailbox address', 400);
  return a;
}

export function createStalwartWebmailEngine(opts: StalwartWebmailEngineOptions): WebmailEngine {
  const base = (opts.baseUrl ?? STALWART_API_URL).replace(/\/+$/, '');
  const fetchFn: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init as RequestInit));
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const uploadTimeoutMs = opts.uploadTimeoutMs ?? 300_000;
  const maxResponseBytes = opts.maxResponseBytes ?? MAX_ENGINE_RESPONSE_BYTES;
  const sessionTtlMs = opts.sessionTtlMs ?? 5 * 60_000;
  const masterUser = opts.masterUser ?? MASTER_USER;
  const now = opts.now ?? Date.now;
  const sessions = new Map<string, { at: number; ep: JmapEndpoints }>();

  const asMailbox = async (address: string): Promise<string> => basic(`${mailAddress(address)}%${masterUser}`, await opts.masterSecret());

  /**
   * fetch with a timeout (headers only) and / or the caller's signal, which
   * stays linked to the answer's BODY too (a cancelled caller or the deadline
   * of call() stops the transfer); network errors → 502.
   */
  async function send(path: string, init: RequestInit & { duplex?: 'half' }, ms: number | null, signal?: AbortSignal): Promise<Response> {
    const ctrl = new AbortController();
    const timer = ms ? setTimeout(() => ctrl.abort(), ms) : null;
    if (signal?.aborted) ctrl.abort();
    else signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
    try {
      return await fetchFn(`${base}${path}`, { ...init, signal: ctrl.signal, redirect: 'manual' });
    } catch (err) {
      const e = err as Error;
      throw new WebmailEngineError(e.name === 'AbortError' ? 'the mail engine did not answer in time' : 'the mail engine is unreachable', 502);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function json(res: Response, what: string): Promise<unknown> {
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 401 || res.status === 403) throw new WebmailEngineError(`${what}: refused by the mail engine`, 401);
      throw new WebmailEngineError(`${what}: mail engine error (HTTP ${res.status})`, res.status === 413 ? 413 : 502);
    }
    let text: string;
    try {
      text = await readCapped(res, maxResponseBytes);
    } catch (err) {
      if (err instanceof WebmailEngineError) throw err;
      throw new WebmailEngineError(`${what}: the mail engine answer was interrupted`, 502);
    }
    try {
      return text ? JSON.parse(quoteBigInts(text)) : null;
    } catch {
      throw new WebmailEngineError(`${what}: invalid answer of the mail engine`, 502);
    }
  }

  async function endpoints(address: string, fresh = false): Promise<JmapEndpoints> {
    const a = mailAddress(address);
    const hit = sessions.get(a);
    if (!fresh && hit && now() - hit.at < sessionTtlMs) return hit.ep;
    const res = await send(JMAP_SESSION_PATH, { method: 'GET', headers: { Accept: 'application/json', Authorization: await asMailbox(a) } }, timeoutMs);
    const s = await json(res, 'JMAP session') as {
      primaryAccounts?: Record<string, string>; apiUrl?: string; uploadUrl?: string; downloadUrl?: string; eventSourceUrl?: string;
      capabilities?: Record<string, unknown>;
    } | null;
    const accountId = s?.primaryAccounts?.['urn:ietf:params:jmap:mail'];
    if (typeof accountId !== 'string' || !ACCOUNT_RE.test(accountId)) throw new WebmailEngineError('the mailbox has no JMAP mail account', 401);
    const ep: JmapEndpoints = {
      accountId,
      apiPath: templatePath(s?.apiUrl, '/jmap/'),
      uploadPath: templatePath(s?.uploadUrl, '/jmap/upload/{accountId}/'),
      downloadPath: templatePath(s?.downloadUrl, '/jmap/download/{accountId}/{blobId}/{name}?accept={type}'),
      eventSourcePath: templatePath(s?.eventSourceUrl, '/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}'),
      capabilities: Object.keys(s?.capabilities ?? {}),
    };
    if (sessions.size > 5000) sessions.clear();
    sessions.set(a, { at: now(), ep });
    return ep;
  }

  async function call(address: string, methodCalls: JmapCall[]): Promise<JmapResponse> {
    const ep = await endpoints(address);
    // One deadline for the answer AND its body (a slow body never holds the buffer forever).
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await send(ep.apiPath, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: await asMailbox(address) },
        body: JSON.stringify({ using: [...JMAP_USING], methodCalls }),
      }, null, ctrl.signal);
      const out = await json(res, 'JMAP call') as JmapResponse | null;
      if (!out || !Array.isArray(out.methodResponses)) throw new WebmailEngineError('JMAP call: invalid answer of the mail engine', 502);
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    endpoints,
    call,

    async identities(address, accountId, displayName) {
      const read = async (): Promise<WebmailIdentity[]> => {
        const r = await call(address, [['Identity/get', { accountId, ids: null }, 'i']]);
        const list = (r.methodResponses[0]?.[0] === 'Identity/get' ? (r.methodResponses[0][1].list as unknown[]) : []) ?? [];
        return list
          .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
          .map((x) => ({ id: String(x.id ?? ''), name: typeof x.name === 'string' ? x.name : '', email: String(x.email ?? '').toLowerCase() }))
          .filter((x) => ACCOUNT_RE.test(x.id) && ADDRESS_RE.test(x.email));
      };
      let ids = await read();
      if (ids.length === 0) {
        // No identity yet: one for the mailbox address, created by the PANEL (the browser never calls Identity/set).
        await call(address, [['Identity/set', { accountId, create: { me: { name: displayName ?? '', email: mailAddress(address) } } }, 's']]);
        ids = await read();
      }
      return ids;
    },

    async upload(address, accountId, contentType, body, signal) {
      const ep = await endpoints(address);
      const res = await send(fillTemplate(ep.uploadPath, { accountId }), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': contentType, Authorization: await asMailbox(address) },
        body: body as NonNullable<RequestInit['body']>,
        duplex: 'half',
      }, uploadTimeoutMs, signal);
      const j = await json(res, 'upload') as { blobId?: unknown; type?: unknown; size?: unknown } | null;
      if (typeof j?.blobId !== 'string') throw new WebmailEngineError('upload: no blob id', 502);
      return { blobId: j.blobId, type: typeof j.type === 'string' ? j.type : contentType, size: Number(j.size) || 0 };
    },

    async download(address, accountId, blobId, signal) {
      const ep = await endpoints(address);
      const res = await send(fillTemplate(ep.downloadPath, { accountId, blobId, name: 'blob', type: 'application/octet-stream' }), {
        method: 'GET', headers: { Authorization: await asMailbox(address) },
      }, null, signal);
      if (!res.ok) {
        await res.arrayBuffer().catch(() => undefined);
        throw new WebmailEngineError('download: not found', res.status === 404 ? 404 : 502);
      }
      return res;
    },

    async eventSource(address, signal) {
      const ep = await endpoints(address);
      const res = await send(fillTemplate(ep.eventSourcePath, { types: '*', closeafter: 'no', ping: '60' }), {
        method: 'GET', headers: { Accept: 'text/event-stream', Authorization: await asMailbox(address) },
      }, null, signal);
      if (!res.ok || !res.body) {
        await res.arrayBuffer().catch(() => undefined);
        throw new WebmailEngineError('event stream unavailable', 502);
      }
      return res;
    },
  };
}
