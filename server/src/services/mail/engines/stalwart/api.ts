import { STALWART_API_URL } from './constants';

// ─────────────────────────────────────────────────────────────────────────────
// Typed client of the Stalwart admin API (module engine-stalwart). The API
// listens on oblimint-mail:8080 on the MAIL network only (never published,
// MA7); the panel authenticates as the fallback administrator whose secret is
// sealed with secretBox('mail-admin') (secret.ts). `fetch` is injectable
// (tests: api.test.ts / sync.test.ts with recorded shapes in fixtures.ts).
//
// Nothing of a request body is ever logged or put in an error (hashes, MA4):
// errors carry the method, the path WITHOUT its query, the status and the
// server message passed through redactSecrets().
//
// ── API HYPOTHESES TO CONFIRM ON the Linux test host (docs/P4-PLAN.md §15 item 14) ─────
// Written against the documentation of Stalwart v0.12 (pinned 0.12.4, see
// constants.ts / images/mail-stalwart/Dockerfile); no real server was reachable
// from the development box. Each line is checked by the the Linux test host stage:
//
//  H1  Basic authentication "oblimint-admin:<secret>" of the fallback admin is
//      accepted by /api/* (authentication.fallback-admin, secret given as a
//      SHA512-CRYPT hash through %{env:…}% in config.toml).
//  H2  Envelopes: success = {"data": …}; failure = HTTP 4xx/5xx and/or a body
//      {"error": "<code>", "details"?: …, "reason"?: …} (also tolerated with
//      HTTP 200). Codes notFound → 404, fieldAlreadyExists → 409.
//  H3  GET /api/principal?types=<individual|domain|list>&page=<1..>&limit=<n>
//      → {"data": {"items": [Principal…], "total": n}}; items are full
//      principals (name, type, emails, secrets?, quota, usedQuota,
//      description, roles, members, externalMembers, disabledPermissions).
//      `emails` may be a string when single. `secrets` may be omitted: the
//      sync then compares fingerprints kept in oblimint-sync.json.
//  H4  POST /api/principal {type, name, …} creates; PATCH /api/principal/<name>
//      takes [{action: "set"|"addItem"|"removeItem", field, value}];
//      DELETE /api/principal/<name> deletes the principal AND its data
//      (used by purge() only).
//  H5  `secrets` hold crypt(3) / {SCHEME} hashes AS GIVEN (no re-hashing of a
//      value that already is a hash) and every secret of a principal is
//      accepted at login — app passwords are extra secrets (risk
//      R-STALWART-APPPW: no source-network restriction possible).
//      Verified formats: $6$ (rounds=), $5$, $1$, $2y$/$2b$, {SSHA512},
//      {SSHA256}, {SSHA} (pwhash crate + Stalwart's {SCHEME} prefixes).
//  H6  Permissions "authenticate", "email-send", "email-receive" exist and a
//      name in `disabledPermissions` revokes it from the "user" role.
//  H7  An email "@domain" on a list principal is the domain catch-all
//      (session.rcpt.catch-all = true); list principals deliver to `members`
//      (local principal names) and `externalMembers` (any address).
//  H8  REFUTED on the Linux test host for 0.12.4: GET /api/reload rebuilds the
//      configuration from the copy of config.toml loaded at START (changes of
//      the file are ignored until a restart). It answers {"data": {"errors":
//      {key: message}, "warnings": {key: message}, …}}: the driver restarts the
//      container to apply a new file, then calls it to collect the errors of
//      what was loaded (a non-empty `errors` = rejected, retried next sync).
//      DELETE /api/principal/<domain> of a domain principal holding no
//      address any more is accepted (domain leaving the active set, MA10).
//  H10b The master impersonation is refused for a principal whose
//      `authenticate` permission is disabled: the driver lifts it around the
//      sieve update of a login-disabled mailbox (its secrets are empty then).
//  H9  GET /api/queue/messages?limit=<n>&values=1 → {"data": {"items":
//      [Message…], "total"}}; Message = {id, return_path, created, size,
//      domains?: [{name, status, retry_num, next_retry, recipients: [{address,
//      status}]}], recipients?: […]} (both 0.11 and 0.12 shapes are parsed);
//      PATCH /api/queue/messages/<id> = retry now; DELETE = cancel.
//  H10 JMAP on the same listener — checked on the Linux test host (0.12.4): the session
//      is served at GET /.well-known/jmap (GET /jmap/session = 404); its
//      apiUrl / uploadUrl carry the server host name, so only their PATH is
//      used (/jmap/, /jmap/upload/{accountId}/); SieveScript/get|set
//      (urn:ietf:params:jmap:sieve) work with Basic
//      "<address>%oblimint-master:<secret>" (authentication.master).
//  H11 GET /healthz/ready answers 200 once the server is up (no auth).
//  H12 The configuration keys of config.ts (listed in its header) are the
//      ones of the pinned version.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 500;
const MAX_PAGES = 400;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type PrincipalType = 'individual' | 'domain' | 'list';

/** A principal as the API returns it (normalized: arrays always arrays). */
export interface StalwartPrincipal {
  id: number | null;
  type: PrincipalType | string;
  name: string;
  description: string;
  emails: string[];
  /** undefined = not returned by the API (H3). */
  secrets: string[] | undefined;
  quota: number;
  usedQuota: number | null;
  roles: string[];
  members: string[];
  externalMembers: string[];
  disabledPermissions: string[];
}

/** Body of POST /api/principal. */
export interface PrincipalCreate {
  type: PrincipalType;
  name: string;
  description?: string;
  emails?: string[];
  secrets?: string[];
  quota?: number;
  roles?: string[];
  members?: string[];
  externalMembers?: string[];
  disabledPermissions?: string[];
}

export interface PrincipalPatchOp {
  action: 'set' | 'addItem' | 'removeItem';
  field: string;
  value: unknown;
}

/** status 0 = unreachable / timeout. */
export class StalwartApiError extends Error {
  constructor(message: string, public status: number, public code: string | null = null) {
    super(message);
    this.name = 'StalwartApiError';
  }
}

/** Masks anything shaped like a password hash in a server message (MA4). */
export function redactSecrets(text: string): string {
  return text
    .replace(/\{[A-Z0-9-]{2,20}\}[^\s"',;\]}]+/g, '{…}[redacted]')
    .replace(/\$(?:1|2[abxy]|5|6|argon2(?:id|i|d)?|pbkdf2[^$]*|scrypt|7)\$[^\s"',;\]}]+/g, '$…[redacted]');
}

/**
 * JSON text with every integer literal outside the safe range (|n| > 2^53-1)
 * turned into a string, so JSON.parse keeps it exactly. Stalwart returns its
 * u64 ids as JSON numbers (queue ids such as 334056230605558876 became
 * 334056230605558850 through a double and retry / delete answered 404).
 * Characters inside JSON strings are never touched.
 */
export function quoteBigInts(text: string): string {
  let out = '';
  let last = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c !== '-' && (c < '0' || c > '9')) continue;
    let j = c === '-' ? i + 1 : i;
    const digitsStart = j;
    while (j < text.length && text[j] >= '0' && text[j] <= '9') j++;
    const isFraction = j < text.length && (text[j] === '.' || text[j] === 'e' || text[j] === 'E');
    if (j - digitsStart > 15 && !isFraction && !Number.isSafeInteger(Number(text.slice(i, j)))) {
      out += `${text.slice(last, i)}"${text.slice(i, j)}"`;
      last = j;
    }
    // skip the rest of the number (fraction / exponent)
    while (j < text.length && /[0-9.eE+-]/.test(text[j])) j++;
    i = j - 1;
  }
  return last === 0 ? text : out + text.slice(last);
}

const toArray = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String);
  if (typeof v === 'string' && v) return [v];
  return [];
};

const numOr = (v: unknown, dflt: number): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : dflt;
};

/** Tolerant mapping of one API principal (H3). */
export function principalFromApi(j: Record<string, unknown>): StalwartPrincipal {
  return {
    id: j.id === undefined || j.id === null ? null : numOr(j.id, 0),
    type: String(j.type ?? ''),
    name: String(j.name ?? ''),
    description: typeof j.description === 'string' ? j.description : '',
    emails: toArray(j.emails).map((e) => e.toLowerCase()),
    secrets: j.secrets === undefined || j.secrets === null ? undefined : toArray(j.secrets),
    quota: numOr(j.quota, 0),
    usedQuota: j.usedQuota === undefined || j.usedQuota === null ? null : numOr(j.usedQuota, 0),
    roles: toArray(j.roles),
    members: toArray(j.members),
    externalMembers: toArray(j.externalMembers),
    disabledPermissions: toArray(j.disabledPermissions),
  };
}

export interface StalwartApiOptions {
  baseUrl?: string;
  user: string;
  secret: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

function basic(user: string, secret: string): string {
  return `Basic ${Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')}`;
}

export class StalwartApi {
  readonly base: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly opts: StalwartApiOptions) {
    this.base = (opts.baseUrl ?? STALWART_API_URL).replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Raw call: returns the parsed JSON body (null when empty). */
  async request(
    method: string,
    path: string,
    body?: { json?: unknown; raw?: string; contentType?: string },
    auth: string | null = basic(this.opts.user, this.opts.secret),
  ): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const where = `${method} ${path.split('?')[0]}`;
    let res: Response;
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (auth) headers.Authorization = auth;
      let payload: string | undefined;
      if (body?.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body.json);
      } else if (body?.raw !== undefined) {
        headers['Content-Type'] = body.contentType ?? 'application/octet-stream';
        payload = body.raw;
      }
      res = await this.fetchFn(`${this.base}${path}`, { method, headers, body: payload, signal: ctrl.signal });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      const why = e.name === 'AbortError' ? `timeout after ${this.timeoutMs} ms` : (e.cause?.code ?? e.message);
      throw new StalwartApiError(`Stalwart API unreachable (${why})`, 0);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    if (text) {
      try { json = JSON.parse(quoteBigInts(text)); } catch { json = null; }
    }
    const errObj = json && typeof json === 'object' && !Array.isArray(json) && typeof (json as { error?: unknown }).error === 'string'
      ? json as { error: string; details?: unknown; reason?: unknown }
      : null;
    if (!res.ok || errObj) {
      const code = errObj?.error ?? null;
      const status = !res.ok ? res.status : code === 'notFound' ? 404 : code === 'fieldAlreadyExists' ? 409 : 400;
      const parts = [code, typeof errObj?.details === 'string' ? errObj.details : null, typeof errObj?.reason === 'string' ? errObj.reason : null]
        .filter(Boolean).join(': ');
      const msg = redactSecrets((parts || (json === null ? text : '')).replace(/\s+/g, ' ').slice(0, 300));
      throw new StalwartApiError(`Stalwart API ${where}: HTTP ${status}${msg ? ` ${msg}` : ''}`, status, code);
    }
    if (text && json === null) throw new StalwartApiError(`Stalwart API ${where}: invalid JSON`, res.status);
    return json;
  }

  private async data<T>(method: string, path: string, json?: unknown): Promise<T> {
    const j = await this.request(method, path, json === undefined ? undefined : { json }) as { data?: T } | null;
    return (j && typeof j === 'object' && 'data' in j ? j.data : undefined) as T;
  }

  // ── health ──
  async ready(): Promise<boolean> {
    try {
      await this.request('GET', '/healthz/ready', undefined, null);
      return true;
    } catch {
      return false;
    }
  }

  // ── principals (H3, H4) ──
  async listPrincipals(type: PrincipalType): Promise<StalwartPrincipal[]> {
    const out: StalwartPrincipal[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const d = await this.data<{ items?: unknown[]; total?: number }>('GET', `/api/principal?types=${type}&page=${page}&limit=${PAGE_SIZE}`);
      const items = Array.isArray(d?.items) ? d!.items : [];
      for (const it of items) {
        if (it && typeof it === 'object') {
          const p = principalFromApi(it as Record<string, unknown>);
          if (p.name) out.push(p);
        }
      }
      const total = numOr(d?.total, out.length);
      if (items.length < PAGE_SIZE || out.length >= total) break;
    }
    return out;
  }

  /** null when it does not exist. */
  async getPrincipal(name: string): Promise<StalwartPrincipal | null> {
    try {
      const d = await this.data<Record<string, unknown> | null>('GET', `/api/principal/${encodeURIComponent(name)}`);
      return d && typeof d === 'object' ? principalFromApi(d) : null;
    } catch (err) {
      if (err instanceof StalwartApiError && err.status === 404) return null;
      throw err;
    }
  }

  async createPrincipal(p: PrincipalCreate): Promise<void> {
    await this.data('POST', '/api/principal', p);
  }

  async updatePrincipal(name: string, ops: PrincipalPatchOp[]): Promise<void> {
    if (ops.length === 0) return;
    await this.data('PATCH', `/api/principal/${encodeURIComponent(name)}`, ops);
  }

  /** Idempotent: false when it did not exist. */
  async deletePrincipal(name: string): Promise<boolean> {
    try {
      await this.data('DELETE', `/api/principal/${encodeURIComponent(name)}`);
      return true;
    } catch (err) {
      if (err instanceof StalwartApiError && err.status === 404) return false;
      throw err;
    }
  }

  // ── configuration (H8) ──
  /**
   * Re-reads the configuration. The answer lists configuration errors and
   * warnings (H8): any error means the new configuration was NOT (fully)
   * applied → StalwartApiError (status 400, code 'configError'); warnings are
   * returned (redacted) for the log.
   */
  async reload(): Promise<{ warnings: string[] }> {
    const d = await this.data<{ errors?: unknown; warnings?: unknown } | null>('GET', '/api/reload');
    const entries = (v: unknown): string[] => {
      if (!v || typeof v !== 'object') return typeof v === 'string' && v ? [v] : [];
      const list = Array.isArray(v) ? v.map((x) => ['', x] as const) : Object.entries(v as Record<string, unknown>);
      return list.map(([k, x]) => {
        const msg = typeof x === 'string' ? x : JSON.stringify(x);
        return redactSecrets(`${k ? `${k}: ` : ''}${msg}`.replace(/\s+/g, ' ').slice(0, 300));
      });
    };
    const errors = entries(d && typeof d === 'object' ? d.errors : undefined);
    if (errors.length) {
      throw new StalwartApiError(`Stalwart API GET /api/reload: configuration rejected (${errors.length} error(s)): ${errors.slice(0, 5).join('; ')}`, 400, 'configError');
    }
    return { warnings: entries(d && typeof d === 'object' ? d.warnings : undefined) };
  }

  // ── queue (H9) ──
  async listQueue(limit: number): Promise<Array<Record<string, unknown>>> {
    const n = Math.max(1, Math.min(1000, Math.floor(limit)));
    const d = await this.data<{ items?: unknown[] }>('GET', `/api/queue/messages?limit=${n}&values=1`);
    return (Array.isArray(d?.items) ? d!.items : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  }

  async retryQueued(id: string): Promise<void> {
    await this.data('PATCH', `/api/queue/messages/${encodeURIComponent(id)}`);
  }

  /** false when the message is not (any more) in the queue. */
  async deleteQueued(id: string): Promise<boolean> {
    try {
      await this.data('DELETE', `/api/queue/messages/${encodeURIComponent(id)}`);
      return true;
    } catch (err) {
      if (err instanceof StalwartApiError && err.status === 404) return false;
      throw err;
    }
  }

  // ── sieve through JMAP, impersonating the mailbox (H10) ──
  /**
   * Installs (script) or removes (null) the managed sieve script of `address`
   * and (de)activates it. `masterUser` / `secret`: authentication.master.
   */
  async setSieveScript(address: string, masterUser: string, secret: string, name: string, script: string | null): Promise<void> {
    const auth = basic(`${address}%${masterUser}`, secret);
    const session = await this.request('GET', JMAP_SESSION_PATH, undefined, auth) as JmapSession | null;
    const accountId = session?.primaryAccounts?.['urn:ietf:params:jmap:sieve'] ?? session?.primaryAccounts?.['urn:ietf:params:jmap:mail'];
    if (!accountId || !/^[A-Za-z0-9_-]{1,64}$/.test(accountId)) throw new StalwartApiError('Stalwart JMAP: no sieve account for the mailbox', 404);
    const apiPath = jmapPath(session?.apiUrl, '/jmap/');
    const uploadPath = jmapPath(session?.uploadUrl, '/jmap/upload/{accountId}/').replace('{accountId}', encodeURIComponent(accountId));
    const using = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:sieve'];
    const call = async (methodCalls: unknown[]): Promise<Array<[string, Record<string, unknown>, string]>> => {
      const r = await this.request('POST', apiPath, { json: { using, methodCalls } }, auth) as { methodResponses?: unknown[] } | null;
      const out = (Array.isArray(r?.methodResponses) ? r!.methodResponses : []) as Array<[string, Record<string, unknown>, string]>;
      const failed = out.find((m) => m[0] === 'error');
      if (failed) throw new StalwartApiError(`Stalwart JMAP: ${String(failed[1]?.type ?? 'error')}`, 400);
      return out;
    };
    const got = await call([['SieveScript/get', { accountId, ids: null, properties: ['id', 'name', 'isActive'] }, 'g']]);
    const list = ((got[0]?.[1]?.list ?? []) as Array<{ id?: string; name?: string }>);
    const existing = list.find((s) => s.name === name)?.id ?? null;

    if (script === null) {
      if (!existing) return;
      const res = await call([['SieveScript/set', { accountId, onSuccessDeactivateScript: true, destroy: [existing] }, 's']]);
      assertSetOk(res[0]?.[1], 'destroy');
      return;
    }
    const up = await this.request('POST', uploadPath, { raw: script, contentType: 'application/sieve' }, auth) as { blobId?: string } | null;
    const blobId = up?.blobId;
    if (!blobId) throw new StalwartApiError('Stalwart JMAP: upload returned no blobId', 400);
    const args = existing
      ? { accountId, update: { [existing]: { blobId } }, onSuccessActivateScript: existing }
      : { accountId, create: { c: { name, blobId } }, onSuccessActivateScript: '#c' };
    const res = await call([['SieveScript/set', args, 's']]);
    assertSetOk(res[0]?.[1], existing ? 'update' : 'create');
  }
}

/** JMAP session resource (RFC 8620 §2): GET /.well-known/jmap on Stalwart 0.12. */
export const JMAP_SESSION_PATH = '/.well-known/jmap';

interface JmapSession {
  primaryAccounts?: Record<string, string>;
  apiUrl?: string;
  uploadUrl?: string;
}

/**
 * Path of a session URL. Stalwart builds apiUrl / uploadUrl from its
 * own host name (http://mail.example.org:8080/jmap/), not reachable as such
 * from the panel: the request goes to the API base with this path only. Any
 * unexpected value falls back to the documented path.
 */
export function jmapPath(url: unknown, fallback: string): string {
  if (typeof url !== 'string' || !url) return fallback;
  let p: string;
  try {
    const u = new URL(url, 'http://placeholder.invalid');
    p = decodeURI(u.pathname);
  } catch {
    return fallback;
  }
  return /^\/jmap(?:\/[A-Za-z0-9_{}./-]*)?$/.test(p) && !p.includes('..') ? p : fallback;
}

function assertSetOk(resp: Record<string, unknown> | undefined, what: 'create' | 'update' | 'destroy'): void {
  const key = what === 'create' ? 'notCreated' : what === 'update' ? 'notUpdated' : 'notDestroyed';
  const failed = resp?.[key] as Record<string, { type?: string; description?: string }> | undefined;
  if (failed && Object.keys(failed).length > 0) {
    const first = Object.values(failed)[0];
    throw new StalwartApiError(`Stalwart JMAP SieveScript/set ${what}: ${redactSecrets(String(first?.type ?? 'failed'))}${first?.description ? ` (${redactSecrets(String(first.description)).slice(0, 200)})` : ''}`, 400);
  }
}
