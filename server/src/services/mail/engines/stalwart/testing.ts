import type { FetchLike } from './api';

// ─────────────────────────────────────────────────────────────────────────────
// Test support of the stalwart engine (not used at run time):
//  - FakeStalwart: in-memory model of the admin API (principals, queue, reload,
//    JMAP sieve) served through an injected fetch, with the constraints of the
//    real server that matter to the sync (unique emails across principals,
//    emails only on existing domains, unique names) and a call journal;
//  - recorded response shapes (fixtures) of the pinned version as documented
//    (api.ts hypotheses H3 / H9 — to be re-recorded on the Linux test host);
//  - parseTomlLite: a strict reader of the TOML subset config.ts emits
//    (tables, dotted keys, basic strings, numbers, booleans, arrays, inline
//    tables) that rejects duplicate tables / keys and bad escapes.
// ─────────────────────────────────────────────────────────────────────────────

export interface FakePrincipal {
  id: number;
  type: string;
  name: string;
  description?: string;
  emails: string[];
  secrets: string[];
  quota: number;
  usedQuota?: number;
  roles: string[];
  members: string[];
  externalMembers: string[];
  disabledPermissions: string[];
}

export interface FakeCall { method: string; path: string; body: unknown; auth: string | null }

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export class FakeStalwart {
  principals = new Map<string, FakePrincipal>();
  calls: FakeCall[] = [];
  /** H3 variant: the listing does not return secrets. */
  returnSecrets = true;
  /** Recorded queue messages (fixtures). */
  queue: Array<Record<string, unknown>> = [];
  /** account → name → script. */
  sieve = new Map<string, Map<string, { id: string; content: string; active: boolean }>>();
  /** Fails a call: return an error code (Stalwart envelope) or null. */
  failOn: ((c: FakeCall) => string | null) | null = null;
  down = false;
  /** Configuration errors the next /api/reload answers with (H8), null = none. */
  reloadErrors: Record<string, string> | null = null;
  /** Successful-or-not /api/reload calls that reached the handler. */
  reloads = 0;
  /** Engine restarts (the driver applies config.toml by restarting: Stalwart 0.12 reads it at start only). */
  restarts = 0;
  /** Fails the next restart with this message (null = succeeds). */
  restartError: string | null = null;
  /** For StalwartDriverDeps.restartEngine. */
  restart = async (): Promise<void> => {
    if (this.restartError) throw new Error(this.restartError);
    this.restarts++;
  };
  private nextId = 1;
  private blobs = new Map<string, string>();

  constructor(readonly adminAuth: string, readonly masterSuffix = '%oblimint-master') {}

  /** Write calls (anything but GET, plus the reload). */
  writes(): FakeCall[] {
    return this.calls.filter((c) => c.method !== 'GET' || c.path.startsWith('/api/reload'));
  }

  seed(p: Partial<FakePrincipal> & { name: string; type: string }): FakePrincipal {
    const full: FakePrincipal = {
      id: this.nextId++, description: '', emails: [], secrets: [], quota: 0, roles: [], members: [], externalMembers: [], disabledPermissions: [], ...p,
    };
    this.principals.set(full.name, full);
    return full;
  }

  private emailOwner(email: string): FakePrincipal | undefined {
    return [...this.principals.values()].find((p) => p.emails.includes(email));
  }

  private checkEmail(email: string, self: string | null): string | null {
    const domain = email.slice(email.lastIndexOf('@') + 1);
    const d = this.principals.get(domain);
    if (!d || d.type !== 'domain') return 'notFound';
    const owner = this.emailOwner(email);
    if (owner && owner.name !== self) return 'fieldAlreadyExists';
    return null;
  }

  private view(p: FakePrincipal): Record<string, unknown> {
    const { secrets, ...rest } = p;
    return {
      ...rest,
      // A single email comes back as a string (H3).
      emails: p.emails.length === 1 ? p.emails[0] : p.emails,
      ...(this.returnSecrets ? { secrets } : {}),
    };
  }

  fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.Authorization ?? null;
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const call: FakeCall = { method, path: url.pathname + url.search, body, auth };
    this.calls.push(call);
    if (this.down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const injected = this.failOn?.(call);
    if (injected) return json(injected === 'notFound' ? 404 : 400, { error: injected, details: `injected failure ${injected}` });

    const p = url.pathname;
    if (p === '/healthz/ready') return new Response('', { status: 200 });
    if (p.startsWith('/jmap') || p === '/.well-known/jmap') return this.jmap(method, p, body, auth);
    if (auth !== this.adminAuth) return json(401, { error: 'unauthorized' });

    if (p === '/api/principal' && method === 'GET') {
      const type = url.searchParams.get('types');
      const page = Number(url.searchParams.get('page') ?? 1);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const all = [...this.principals.values()].filter((x) => !type || x.type === type).sort((a, b) => a.id - b.id);
      return json(200, { data: { items: all.slice((page - 1) * limit, page * limit).map((x) => this.view(x)), total: all.length } });
    }
    if (p === '/api/principal' && method === 'POST') {
      const b = body as FakePrincipal;
      if (this.principals.has(b.name)) return json(200, { error: 'fieldAlreadyExists', field: 'name', value: b.name });
      for (const e of b.emails ?? []) {
        const err = this.checkEmail(e.startsWith('@') ? `x${e}` : e, null);
        if (err) return json(200, { error: err, details: `email ${e}` });
      }
      const created = this.seed({ ...b, emails: [...(b.emails ?? [])], secrets: [...(b.secrets ?? [])] });
      return json(200, { data: created.id });
    }
    const m = /^\/api\/principal\/(.+)$/.exec(p);
    if (m) {
      const name = decodeURIComponent(m[1]);
      const pr = this.principals.get(name);
      if (!pr) return json(404, { error: 'notFound', details: name });
      if (method === 'GET') return json(200, { data: this.view(pr) });
      if (method === 'DELETE') {
        // Modelled constraint: a domain still used by an address cannot go.
        if (pr.type === 'domain' && [...this.principals.values()].some((x) => x.emails.some((e) => e.endsWith(`@${name}`)))) {
          return json(200, { error: 'fieldAlreadyExists', details: `domain ${name} in use` });
        }
        this.principals.delete(name);
        return json(200, { data: null });
      }
      if (method === 'PATCH') {
        for (const op of body as Array<{ action: string; field: keyof FakePrincipal; value: unknown }>) {
          const cur = pr[op.field];
          if (op.action === 'set') (pr as unknown as Record<string, unknown>)[op.field] = Array.isArray(op.value) ? [...op.value] : op.value;
          else if (op.action === 'addItem') {
            if (op.field === 'emails') {
              const e = String(op.value);
              const err = this.checkEmail(e.startsWith('@') ? `x${e}` : e, pr.name);
              if (err) return json(200, { error: err, details: `email ${e}` });
            }
            if (Array.isArray(cur) && !cur.includes(op.value as never)) (cur as unknown[]).push(op.value);
          } else if (op.action === 'removeItem') {
            if (Array.isArray(cur)) (pr as unknown as Record<string, unknown>)[op.field] = (cur as unknown[]).filter((x) => x !== op.value);
          } else return json(400, { error: 'invalidAction' });
        }
        return json(200, { data: null });
      }
    }
    if (p === '/api/reload' && method === 'GET') {
      this.reloads++;
      return json(200, { data: { warnings: {}, errors: this.reloadErrors ?? {} } });
    }
    if (p === '/api/queue/messages' && method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? 50);
      return json(200, { data: { items: this.queue.slice(0, limit), total: this.queue.length } });
    }
    const q = /^\/api\/queue\/messages\/(.+)$/.exec(p);
    if (q) {
      const idx = this.queue.findIndex((x) => String(x.id) === q[1]);
      if (idx < 0) return json(404, { error: 'notFound' });
      if (method === 'DELETE') this.queue.splice(idx, 1);
      return json(200, { data: true });
    }
    return json(404, { error: 'notFound', details: `no route ${method} ${p}` });
  };

  private jmap(method: string, p: string, body: unknown, auth: string | null): Response {
    const decoded = auth?.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString('utf8') : '';
    const user = decoded.slice(0, decoded.indexOf(':'));
    const adminSecret = Buffer.from(this.adminAuth.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':');
    if (!user.endsWith(this.masterSuffix) || decoded.slice(decoded.indexOf(':') + 1) !== adminSecret) return json(401, { error: 'unauthorized' });
    const account = user.slice(0, -this.masterSuffix.length);
    const pr = this.principals.get(account);
    if (!pr) return json(401, { error: 'unauthorized' });
    // H10b: impersonating a principal whose login is disabled is refused (0.12.4: 403).
    if (pr.disabledPermissions.includes('authenticate')) return json(403, { title: 'Forbidden' });
    const accountId = `a${pr.id}`;
    const scripts = this.sieve.get(account) ?? new Map();
    this.sieve.set(account, scripts);
    // 0.12.4 (the Linux test host): the session is at /.well-known/jmap, /jmap/session is a 404;
    // apiUrl / uploadUrl carry the server's own host name.
    if (p === '/.well-known/jmap' && method === 'GET') {
      return json(200, {
        primaryAccounts: { 'urn:ietf:params:jmap:sieve': accountId, 'urn:ietf:params:jmap:mail': accountId },
        apiUrl: 'http://mail.example:8080/jmap/',
        uploadUrl: 'http://mail.example:8080/jmap/upload/{accountId}/',
      });
    }
    if (p === `/jmap/upload/${accountId}/` && method === 'POST') {
      const blobId = `b${this.nextId++}`;
      this.blobs.set(blobId, String(body));
      return json(200, { blobId, type: 'application/sieve', size: String(body).length });
    }
    if ((p === '/jmap/' || p === '/jmap') && method === 'POST') {
      const req = body as { methodCalls: Array<[string, Record<string, unknown>, string]> };
      const responses = req.methodCalls.map(([name, args, tag]) => {
        if (name === 'SieveScript/get') {
          return [name, { accountId, list: [...scripts.entries()].map(([n, s]) => ({ id: s.id, name: n, isActive: s.active })) }, tag];
        }
        if (name === 'SieveScript/set') {
          const res: Record<string, unknown> = { accountId };
          let createdId: string | null = null;
          for (const [, c] of Object.entries((args.create ?? {}) as Record<string, { name: string; blobId: string }>)) {
            createdId = `s${this.nextId++}`;
            scripts.set(c.name, { id: createdId, content: this.blobs.get(c.blobId) ?? '', active: false });
          }
          for (const [id, u] of Object.entries((args.update ?? {}) as Record<string, { blobId: string }>)) {
            const entry = [...scripts.values()].find((s) => s.id === id);
            if (entry) entry.content = this.blobs.get(u.blobId) ?? '';
          }
          const activate = args.onSuccessActivateScript === '#c' ? createdId : (args.onSuccessActivateScript as string | undefined);
          if (activate) for (const s of scripts.values()) s.active = s.id === activate;
          if (args.onSuccessDeactivateScript) for (const s of scripts.values()) s.active = false;
          for (const id of (args.destroy ?? []) as string[]) {
            for (const [n, s] of scripts) if (s.id === id) scripts.delete(n);
          }
          return [name, res, tag];
        }
        return ['error', { type: 'unknownMethod' }, tag];
      });
      return json(200, { methodResponses: responses });
    }
    return json(404, { error: 'notFound' });
  }
}

// ── recorded shapes (api.ts H9) ──────────────────────────────────────────────

/** 0.11-style queue message (domains[].recipients[]). */
export const QUEUE_FIXTURE_V011: Record<string, unknown> = {
  id: 217863412,
  return_path: 'Contact@Exemple.fr',
  domains: [{
    name: 'gmail.com',
    status: { temp_fail: { response: { hostname: 'gmail-smtp-in.l.google.com', response: { code: 421, esc: [4, 7, 0], message: 'Try again later' } } } },
    recipients: [{ address: 'a@gmail.com', status: 'scheduled' }, { address: 'b@gmail.com', status: 'completed' }],
    retry_num: 3,
    next_retry: '2026-10-09T12:30:00Z',
    next_notify: '2026-10-10T10:00:00Z',
    expires: '2026-10-14T10:00:00Z',
  }],
  created: '2026-10-09T10:00:00Z',
  size: 5120,
  priority: 0,
  env_id: null,
};

/** 0.12-style queue message (flat recipients with their own retry state). */
export const QUEUE_FIXTURE_V012: Record<string, unknown> = {
  id: '99',
  return_path: 'site@exemple.fr',
  recipients: [{ address: 'x@outlook.com', status: 'scheduled', retry_num: 0, next_retry: '2026-10-09T10:05:00Z' }],
  created: '2026-10-09T10:04:00Z',
  size: 900,
};

// ── TOML subset reader ───────────────────────────────────────────────────────

export type TomlValue = string | number | boolean | TomlValue[] | { [k: string]: TomlValue };

export function parseTomlLite(src: string): Record<string, TomlValue> {
  const root: Record<string, TomlValue> = {};
  const definedTables = new Set<string>();
  let cur = root;
  let i = 0;
  const n = src.length;
  const err = (msg: string) => new Error(`TOML: ${msg} at offset ${i}: ${JSON.stringify(src.slice(i, i + 40))}`);
  const ws = (nl: boolean) => {
    for (;;) {
      while (i < n && (src[i] === ' ' || src[i] === '\t' || (nl && (src[i] === '\n' || src[i] === '\r')))) i++;
      if (nl && src[i] === '#') { while (i < n && src[i] !== '\n') i++; continue; }
      break;
    }
  };
  const key = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      ws(false);
      if (src[i] === '"') parts.push(str());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i));
        if (!m) throw err('bad key');
        parts.push(m[0]);
        i += m[0].length;
      }
      ws(false);
      if (src[i] === '.') { i++; continue; }
      return parts;
    }
  };
  const str = (): string => {
    i++;
    let s = '';
    while (i < n && src[i] !== '"') {
      const c = src[i];
      if (c === '\n') throw err('newline in basic string');
      if (c === '\\') {
        const e = src[i + 1];
        if (e === 'u') { s += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; continue; }
        const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"' };
        if (!(e in map)) throw err('bad escape');
        s += map[e];
        i += 2;
        continue;
      }
      if (c.charCodeAt(0) < 0x20 && c !== '\t') throw err('control character in string');
      s += c;
      i++;
    }
    if (src[i] !== '"') throw err('unterminated string');
    i++;
    return s;
  };
  const value = (): TomlValue => {
    ws(false);
    const c = src[i];
    if (c === '"') return str();
    if (c === '[') {
      i++;
      const arr: TomlValue[] = [];
      for (;;) {
        ws(true);
        if (src[i] === ']') { i++; return arr; }
        arr.push(value());
        ws(true);
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; return arr; }
        throw err('bad array');
      }
    }
    if (c === '{') {
      i++;
      const obj: Record<string, TomlValue> = {};
      ws(false);
      if (src[i] === '}') { i++; return obj; }
      for (;;) {
        const k = key();
        if (src[i] !== '=') throw err('expected = in inline table');
        i++;
        setPath(obj, k, value());
        ws(false);
        if (src[i] === ',') { i++; ws(false); continue; }
        if (src[i] === '}') { i++; return obj; }
        throw err('bad inline table');
      }
    }
    const m = /^(true|false|-?\d+(?:\.\d+)?)/.exec(src.slice(i));
    if (!m) throw err('bad value');
    i += m[0].length;
    return m[1] === 'true' ? true : m[1] === 'false' ? false : Number(m[1]);
  };
  const setPath = (obj: Record<string, TomlValue>, parts: string[], v: TomlValue) => {
    let o = obj;
    for (const p of parts.slice(0, -1)) {
      if (!(p in o)) o[p] = {};
      const next = o[p];
      if (typeof next !== 'object' || Array.isArray(next)) throw err(`key ${p} is not a table`);
      o = next as Record<string, TomlValue>;
    }
    const last = parts[parts.length - 1];
    if (last in o) throw err(`duplicate key ${parts.join('.')}`);
    o[last] = v;
  };
  for (;;) {
    ws(true);
    if (i >= n) break;
    if (src[i] === '[') {
      i++;
      const parts = key();
      if (src[i] !== ']') throw err('bad table header');
      i++;
      const full = parts.join('\u0000');
      if (definedTables.has(full)) throw err(`duplicate table [${parts.join('.')}]`);
      definedTables.add(full);
      let o = root;
      for (const p of parts) {
        if (!(p in o)) o[p] = {};
        const next = o[p];
        if (typeof next !== 'object' || Array.isArray(next)) throw err(`table ${p} redefined`);
        o = next as Record<string, TomlValue>;
      }
      cur = o;
      continue;
    }
    const k = key();
    if (src[i] !== '=') throw err('expected =');
    i++;
    setPath(cur, k, value());
    ws(false);
    if (i < n && src[i] !== '\n' && src[i] !== '\r' && src[i] !== '#') throw err('garbage after value');
  }
  return root;
}

/** Navigates a parsed TOML document. */
export function tomlGet(doc: Record<string, TomlValue>, ...path: string[]): TomlValue | undefined {
  let o: TomlValue | undefined = doc;
  for (const p of path) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
    o = (o as Record<string, TomlValue>)[p];
  }
  return o;
}
