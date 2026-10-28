import type { WebmailErrorCode, WebmailSessionInfo, WebmailSsoTarget, WebmailVacation } from '@oblimint/shared';
import { WEBMAIL_API_PREFIX, WEBMAIL_BACKGROUND_HEADER, WEBMAIL_CSRF_HEADER } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Client of the webmail host's own API (shared/src/webmail.ts). Same origin
// only, the session cookie is HttpOnly (never readable here); every
// state-changing call carries the CSRF token received from /session, /login
// or /sso. A 401 sends the app back to the login screen.
// JMAP calls: at most JMAP_PARALLEL in flight (the proxy refuses more per
// session), a refusal for concurrency retried after a short wait.
// ─────────────────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: WebmailErrorCode | 'network', message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

let csrf = '';
let onUnauthenticated: (() => void) | null = null;

export function setCsrf(token: string): void {
  csrf = token;
}

export function setUnauthenticatedHandler(fn: () => void): void {
  onUnauthenticated = fn;
}

interface Options {
  background?: boolean;
  /** 401 is expected (login screen): do not trigger the handler. */
  quiet401?: boolean;
}

async function call<T>(method: string, path: string, body?: unknown, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers[WEBMAIL_CSRF_HEADER] = csrf;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.background) headers[WEBMAIL_BACKGROUND_HEADER] = '1';
  let res: Response;
  try {
    res = await fetch(`${WEBMAIL_API_PREFIX}${path}`, {
      method, headers, credentials: 'same-origin', cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Network error');
  }
  let json: unknown = null;
  try { json = await res.json(); } catch { json = null; }
  if (!res.ok) {
    const e = (json ?? {}) as { error?: WebmailErrorCode; message?: string };
    if (res.status === 401 && !opts.quiet401 && onUnauthenticated) onUnauthenticated();
    throw new ApiError(res.status, e.error ?? 'upstream', e.message ?? `HTTP ${res.status}`);
  }
  return json as T;
}

export type JmapInvocation = [string, Record<string, unknown>, string];

/** JMAP calls in flight from this page (the proxy allows 4 per session: one left for another tab). */
const JMAP_PARALLEL = 3;
let jmapActive = 0;
const jmapWaiting: Array<() => void> = [];

async function jmapSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (jmapActive >= JMAP_PARALLEL) await new Promise<void>((r) => { jmapWaiting.push(r); });
  jmapActive++;
  try {
    return await fn();
  } finally {
    jmapActive--;
    jmapWaiting.shift()?.();
  }
}

const sleep = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

export const wmApi = {
  async session(): Promise<WebmailSessionInfo> {
    const s = await call<WebmailSessionInfo>('GET', '/session', undefined, { quiet401: true });
    setCsrf(s.csrf);
    return s;
  },
  async login(address: string, password: string): Promise<WebmailSessionInfo> {
    const s = await call<WebmailSessionInfo>('POST', '/login', { address, password }, { quiet401: true });
    setCsrf(s.csrf);
    return s;
  },
  /** Mailbox an SSO link opens (the token is NOT used: shown for confirmation first). */
  ssoTarget(token: string): Promise<WebmailSsoTarget> {
    return call<WebmailSsoTarget>('POST', '/sso/target', { token }, { quiet401: true });
  },
  async sso(token: string): Promise<WebmailSessionInfo> {
    const s = await call<WebmailSessionInfo>('POST', '/sso', { token }, { quiet401: true });
    setCsrf(s.csrf);
    return s;
  },
  async logout(): Promise<void> {
    await call('POST', '/logout').catch(() => undefined);
    setCsrf('');
  },
  async jmap(methodCalls: JmapInvocation[], background = false): Promise<JmapInvocation[]> {
    const r = await jmapSlot(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await call<{ methodResponses: JmapInvocation[] }>('POST', '/jmap', { methodCalls }, { background });
        } catch (err) {
          // Too many simultaneous calls (other tabs): wait and retry a few times.
          if (!(err instanceof ApiError) || err.status !== 429 || attempt >= 3) throw err;
          await sleep(500 * (attempt + 1));
        }
      }
    });
    for (const m of r.methodResponses) {
      if (m[0] === 'error') throw new ApiError(400, 'upstream', String((m[1] as { type?: string }).type ?? 'JMAP error'));
    }
    return r.methodResponses;
  },
  vacation(): Promise<WebmailVacation> {
    return call<WebmailVacation>('GET', '/vacation');
  },
  saveVacation(v: WebmailVacation): Promise<WebmailVacation> {
    return call<WebmailVacation>('PUT', '/vacation', v);
  },
  /** Upload with progress (XHR: fetch has no upload progress). */
  upload(file: Blob, onProgress?: (fraction: number) => void): Promise<{ blobId: string; type: string; size: number }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${WEBMAIL_API_PREFIX}/upload`);
      xhr.withCredentials = true;
      xhr.setRequestHeader(WEBMAIL_CSRF_HEADER, csrf);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let j: { blobId?: string; type?: string; size?: number; error?: WebmailErrorCode; message?: string } = {};
        try { j = JSON.parse(xhr.responseText); } catch { /* empty */ }
        if (xhr.status === 200 && j.blobId) resolve({ blobId: j.blobId, type: j.type ?? file.type, size: j.size ?? file.size });
        else {
          if (xhr.status === 401 && onUnauthenticated) onUnauthenticated();
          reject(new ApiError(xhr.status, j.error ?? 'upstream', j.message ?? `HTTP ${xhr.status}`));
        }
      };
      xhr.onerror = () => reject(new ApiError(0, 'network', 'Network error'));
      xhr.send(file);
    });
  },
  /** Download URL of an attachment (served as an attachment, never rendered). */
  blobUrl(blobId: string, name: string): string {
    return `${WEBMAIL_API_PREFIX}/blob/${encodeURIComponent(blobId)}?name=${encodeURIComponent(name || 'attachment')}`;
  },
  /** Raw bytes of a blob (inline cid images). */
  async fetchBlob(blobId: string): Promise<Blob> {
    const res = await fetch(`${WEBMAIL_API_PREFIX}/blob/${encodeURIComponent(blobId)}`, {
      credentials: 'same-origin', headers: { [WEBMAIL_BACKGROUND_HEADER]: '1' },
    });
    if (!res.ok) throw new ApiError(res.status, 'notFound', 'blob');
    return res.blob();
  },
  events(): EventSource {
    return new EventSource(`${WEBMAIL_API_PREFIX}/events`, { withCredentials: true });
  },
};
