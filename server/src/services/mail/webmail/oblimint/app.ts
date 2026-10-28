import fs from 'fs';
import path from 'path';
import { Readable, Transform } from 'stream';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { MailAutoresponder, WebmailErrorCode } from '@oblimint/shared';
import { WEBMAIL_BACKGROUND_HEADER, WEBMAIL_CSRF_HEADER } from '@oblimint/shared';
import { logger } from '../../../../utils/logger';
import { WebmailAuthError, type LoadedSession, type WebmailAuth } from './auth';
import { WebmailEngineError, type WebmailEngine } from './engine';
import {
  cookieHeader, readCookie, sameOrigin, STATE_CHANGING_METHODS, WEBMAIL_API_CSP, WEBMAIL_CSP, WEBMAIL_SECURITY_HEADERS,
} from './guards';
import { attachmentDisposition, isValidBlobId, JmapPolicyError, uploadContentType, validateJmapRequest } from './policy';
import {
  newCsrfToken, PRELOGIN_COOKIE_DEV, PRELOGIN_COOKIE_SECURE, SESSION_COOKIE_DEV, SESSION_COOKIE_SECURE, SESSION_ID_RE, tokensEqual,
  WEBMAIL_ABSOLUTE_MS, type WebmailSession,
} from './session';
import { parseVacationInput, VacationInputError } from './vacation';

// ─────────────────────────────────────────────────────────────────────────────
// HTTP application of the webmail host (its own listener, server.ts — never
// mounted on the panel app: no panel route, no panel cookie, no panel
// middleware is reachable through the webmail host).
//
//   /wm-api/*      API (shared/src/webmail.ts), JSON, Cache-Control no-store
//   /assets/*      built client bundle (immutable)
//   /favicon.svg, /logo.svg, /logo-daylight.svg
//   anything else  webmail.html (the SPA)
// Every response carries the security headers of guards.ts; the page carries
// the strict CSP of the host, the API a sandbox CSP.
// ─────────────────────────────────────────────────────────────────────────────

export interface WebmailAppDeps {
  auth: WebmailAuth;
  engine: WebmailEngine;
  /** settings mail.webmail = 'oblimint' and the engine speaks JMAP. Never throws. */
  enabled(): Promise<boolean>;
  /** HTTPS in front (production): __Host- cookies, Secure, https origin only. */
  secure: boolean;
  clientIp(req: Request): string;
  maxUploadBytes(mailboxId: number): Promise<number>;
  vacation: {
    get(mailboxId: number): Promise<MailAutoresponder | null>;
    set(mailboxId: number, value: MailAutoresponder, ip: string | null): Promise<MailAutoresponder | null>;
  };
  /** Directory holding webmail.html + assets/ (null: API only). */
  clientDist: string | null;
  now(): number;
  /** Requests per minute (API, per session or address). */
  apiRatePerMinute?: number;
  maxStreamsPerSession?: number;
  maxStreams?: number;
}

type Locals = { wm: LoadedSession | null; ip: string };

const ROOT_FILES = new Set(['favicon.svg', 'logo.svg', 'logo-daylight.svg']);

function sendError(res: Response, status: number, error: WebmailErrorCode, message: string): void {
  if (res.headersSent) { res.end(); return; }
  res.status(status).json({ error, message });
}

export function createWebmailApp(deps: WebmailAppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('case sensitive routing', true);
  app.set('etag', false);
  const sessionCookie = deps.secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_DEV;
  const preCookie = deps.secure ? PRELOGIN_COOKIE_SECURE : PRELOGIN_COOKIE_DEV;
  /** Live event streams per session hash (logout aborts them). */
  const streams = new Map<string, Set<AbortController>>();
  let streamCount = 0;

  app.use((_req, res, next) => {
    for (const [k, v] of Object.entries(WEBMAIL_SECURITY_HEADERS)) res.setHeader(k, v);
    if (deps.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  // ── API ──
  const api = express.Router({ caseSensitive: true, strict: false });
  api.use(rateLimit({
    windowMs: 60_000,
    limit: deps.apiRatePerMinute ?? 900,
    standardHeaders: false,
    legacyHeaders: false,
    validate: false,
    keyGenerator: (req) => {
      const sid = readCookie(req.headers.cookie, sessionCookie);
      return sid && SESSION_ID_RE.test(sid) ? `s:${sid}` : `ip:${deps.clientIp(req)}`;
    },
    handler: (_req, res) => sendError(res, 429, 'tooManyAttempts', 'Too many requests'),
  }));
  api.use(async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', WEBMAIL_API_CSP);
    try {
      if (!(await deps.enabled())) return sendError(res, 404, 'unavailable', 'The webmail is not enabled');
      if (STATE_CHANGING_METHODS.has(req.method) && !sameOrigin(req.headers as Record<string, string>, deps.secure)) {
        return sendError(res, 403, 'csrf', 'Cross-site request refused');
      }
      // EventSource cannot set a header: the event stream is always a background call.
      const background = req.get(WEBMAIL_BACKGROUND_HEADER) === '1' || req.path === '/events';
      const locals = res.locals as Locals;
      locals.ip = deps.clientIp(req);
      locals.wm = await deps.auth.load(readCookie(req.headers.cookie, sessionCookie), background);
      next();
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, 'webmail: request setup failed');
      sendError(res, 503, 'unavailable', 'The webmail is not available');
    }
  });

  const setSessionCookie = (res: Response, sid: string) => {
    res.append('Set-Cookie', cookieHeader(sessionCookie, sid, { secure: deps.secure, maxAgeSec: WEBMAIL_ABSOLUTE_MS / 1000 }));
    res.append('Set-Cookie', cookieHeader(preCookie, '', { secure: deps.secure, clear: true }));
  };
  const clearSessionCookie = (res: Response) => {
    res.append('Set-Cookie', cookieHeader(sessionCookie, '', { secure: deps.secure, clear: true }));
  };

  /** The session of the request, else 401 (and the stale cookie cleared). */
  const needSession = (req: Request, res: Response): WebmailSession | null => {
    const wm = (res.locals as Locals).wm;
    if (wm) return wm.session;
    if (readCookie(req.headers.cookie, sessionCookie)) clearSessionCookie(res);
    sendError(res, 401, 'notAuthenticated', 'Not logged in');
    return null;
  };
  /** Session + its CSRF token (state-changing calls). */
  const needCsrfSession = (req: Request, res: Response): WebmailSession | null => {
    const s = needSession(req, res);
    if (!s) return null;
    if (!tokensEqual(req.get(WEBMAIL_CSRF_HEADER), s.csrf)) {
      sendError(res, 403, 'csrf', 'Missing or invalid CSRF token');
      return null;
    }
    return s;
  };
  /** Before login: double submit of the pre-login cookie (or the open session's token). */
  const preLoginCsrfOk = (req: Request, res: Response): boolean => {
    const header = req.get(WEBMAIL_CSRF_HEADER);
    const wm = (res.locals as Locals).wm;
    if (wm && tokensEqual(header, wm.session.csrf)) return true;
    return tokensEqual(header, readCookie(req.headers.cookie, preCookie));
  };

  const authError = (res: Response, err: unknown) => {
    if (err instanceof WebmailAuthError) {
      if (err.retryAfterSec) res.setHeader('Retry-After', String(err.retryAfterSec));
      return sendError(res, err.status, err.code, err.message);
    }
    logger.warn({ err: (err as Error)?.message }, 'webmail: authentication failed');
    return sendError(res, 503, 'unavailable', 'The webmail is not available');
  };

  /** Upstream / policy error of an authenticated call. */
  const callError = async (res: Response, err: unknown, wm: LoadedSession | null) => {
    if (err instanceof JmapPolicyError) return sendError(res, err.status, err.status === 403 ? 'forbidden' : 'invalidRequest', err.message);
    if (err instanceof WebmailAuthError) {
      if (err.status === 401 && wm) { await deps.auth.logout(wm.sidHash).catch(() => undefined); clearSessionCookie(res); }
      return sendError(res, err.status, err.code, err.message);
    }
    if (err instanceof WebmailEngineError) {
      if (err.status === 401 && wm) {
        // The engine refuses the mailbox now (login disabled, principal gone): the session ends.
        await deps.auth.logout(wm.sidHash).catch(() => undefined);
        clearSessionCookie(res);
        return sendError(res, 401, 'notAuthenticated', 'This mailbox cannot be used any more');
      }
      if (err.status === 404) return sendError(res, 404, 'notFound', 'Not found');
      if (err.status === 413) return sendError(res, 413, 'tooLarge', 'Too large');
      return sendError(res, 502, 'upstream', 'The mail engine did not answer correctly');
    }
    logger.warn({ err: (err as Error)?.message }, 'webmail: call failed');
    return sendError(res, 502, 'upstream', 'The mail engine did not answer correctly');
  };

  const smallJson = express.json({ limit: '16kb', strict: true });
  const bigJson = express.json({ limit: '4mb', strict: true });
  const jsonOnly = (req: Request, res: Response, next: NextFunction) => {
    if (!req.is('application/json')) return sendError(res, 415, 'invalidRequest', 'JSON expected');
    next();
  };

  api.get('/session', async (req, res) => {
    const locals = res.locals as Locals;
    try {
      if (locals.wm) return res.json(await deps.auth.info(locals.wm.session, ''));
      if (readCookie(req.headers.cookie, sessionCookie)) clearSessionCookie(res);
      let pre = readCookie(req.headers.cookie, preCookie);
      if (!pre || !SESSION_ID_RE.test(pre)) {
        pre = newCsrfToken();
        res.append('Set-Cookie', cookieHeader(preCookie, pre, { secure: deps.secure, maxAgeSec: 3600 }));
      }
      return res.json(await deps.auth.info(null, pre));
    } catch (err) {
      return authError(res, err);
    }
  });

  const loginLimiter = rateLimit({
    windowMs: 60_000, limit: 30, standardHeaders: false, legacyHeaders: false, validate: false,
    keyGenerator: (req) => `l:${deps.clientIp(req)}`,
    handler: (_req, res) => sendError(res, 429, 'tooManyAttempts', 'Too many attempts'),
  });

  api.post('/login', loginLimiter, jsonOnly, smallJson, async (req, res) => {
    if (!preLoginCsrfOk(req, res)) return sendError(res, 403, 'csrf', 'Missing or invalid CSRF token');
    const locals = res.locals as Locals;
    const body = (req.body ?? {}) as { address?: unknown; password?: unknown };
    try {
      const { sid, session } = await deps.auth.login(body.address, body.password, locals.ip, req.get('user-agent') ?? null);
      if (locals.wm) await deps.auth.logout(locals.wm.sidHash).catch(() => undefined);
      setSessionCookie(res, sid);
      return res.json(await deps.auth.info(session, ''));
    } catch (err) {
      return authError(res, err);
    }
  });

  api.post('/sso', loginLimiter, jsonOnly, smallJson, async (req, res) => {
    if (!preLoginCsrfOk(req, res)) return sendError(res, 403, 'csrf', 'Missing or invalid CSRF token');
    const locals = res.locals as Locals;
    try {
      const { sid, session } = await deps.auth.sso((req.body as { token?: unknown } | undefined)?.token, locals.ip, req.get('user-agent') ?? null);
      if (locals.wm) await deps.auth.logout(locals.wm.sidHash).catch(() => undefined);
      setSessionCookie(res, sid);
      return res.json(await deps.auth.info(session, ''));
    } catch (err) {
      return authError(res, err);
    }
  });

  api.post('/logout', async (req, res) => {
    const s = needCsrfSession(req, res);
    if (!s) return;
    const wm = (res.locals as Locals).wm!;
    await deps.auth.logout(wm.sidHash).catch(() => undefined);
    for (const c of streams.get(wm.sidHash) ?? []) c.abort();
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  api.post('/jmap', jsonOnly, bigJson, async (req, res) => {
    const s = needCsrfSession(req, res);
    if (!s) return;
    const wm = (res.locals as Locals).wm;
    try {
      const identities = await deps.auth.identities(s);
      const calls = validateJmapRequest(req.body, {
        accountId: s.jmapAccountId,
        identityIds: new Set(identities.map((i) => i.id)),
        identityEmails: new Set(identities.map((i) => i.email.toLowerCase())),
      });
      await deps.auth.assertOwnAccount(s);
      const out = await deps.engine.call(s.address, calls);
      res.json({ methodResponses: out.methodResponses, sessionState: out.sessionState ?? null });
    } catch (err) {
      await callError(res, err, wm);
    }
  });

  api.post('/upload', async (req, res) => {
    const s = needCsrfSession(req, res);
    if (!s) return;
    const wm = (res.locals as Locals).wm;
    const ctrl = new AbortController();
    try {
      const max = await deps.maxUploadBytes(s.mailboxId);
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > max) return sendError(res, 413, 'tooLarge', 'The file is larger than the allowed message size');
      await deps.auth.assertOwnAccount(s);
      let seen = 0;
      let tooLarge = false;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          seen += chunk.length;
          if (seen > max) { tooLarge = true; ctrl.abort(); cb(new Error('too large')); return; }
          cb(null, chunk);
        },
      });
      req.on('aborted', () => ctrl.abort());
      const body = Readable.toWeb(req.pipe(counter)) as unknown as ReadableStream<Uint8Array>;
      try {
        const out = await deps.engine.upload(s.address, s.jmapAccountId, uploadContentType(req.headers['content-type']), body, ctrl.signal);
        if (tooLarge) return sendError(res, 413, 'tooLarge', 'The file is larger than the allowed message size');
        res.json(out);
      } catch (err) {
        if (tooLarge) return sendError(res, 413, 'tooLarge', 'The file is larger than the allowed message size');
        throw err;
      }
    } catch (err) {
      await callError(res, err, wm);
    }
  });

  api.get('/blob/:blobId', async (req, res) => {
    const s = needSession(req, res);
    if (!s) return;
    const wm = (res.locals as Locals).wm;
    if (!isValidBlobId(req.params.blobId)) return sendError(res, 400, 'invalidRequest', 'Invalid blob id');
    const ctrl = new AbortController();
    req.on('close', () => ctrl.abort());
    try {
      await deps.auth.assertOwnAccount(s);
      const up = await deps.engine.download(s.address, s.jmapAccountId, req.params.blobId, ctrl.signal);
      // Never rendered by the browser: always a download, never sniffed, sandboxed if opened anyway.
      res.status(200);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', attachmentDisposition(String(req.query.name ?? '')));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      const len = up.headers.get('content-length');
      if (len && /^\d{1,15}$/.test(len)) res.setHeader('Content-Length', len);
      if (!up.body) return res.end();
      const src = Readable.fromWeb(up.body as unknown as import('stream/web').ReadableStream<Uint8Array>);
      src.on('error', () => res.destroy());
      src.pipe(res);
    } catch (err) {
      await callError(res, err, wm);
    }
  });

  api.get('/events', async (req, res) => {
    const s = needSession(req, res);
    if (!s) return;
    const wm = (res.locals as Locals).wm!;
    const own = streams.get(wm.sidHash) ?? new Set<AbortController>();
    if (own.size >= (deps.maxStreamsPerSession ?? 3) || streamCount >= (deps.maxStreams ?? 500)) {
      return sendError(res, 429, 'tooManyAttempts', 'Too many event streams');
    }
    const ctrl = new AbortController();
    own.add(ctrl);
    streams.set(wm.sidHash, own);
    streamCount++;
    const sid = readCookie(req.headers.cookie, sessionCookie);
    let recheck: NodeJS.Timeout | null = null;
    req.on('close', () => ctrl.abort());
    try {
      const up = await deps.engine.eventSource(s.address, ctrl.signal);
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      res.write(': connected\n\n');
      // The session may end while the stream is open (logout elsewhere, idle, mailbox disabled).
      recheck = setInterval(() => {
        void deps.auth.load(sid, true).then((l) => { if (!l) ctrl.abort(); }, () => ctrl.abort());
      }, 60_000);
      recheck.unref?.();
      const reader = (up.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buf = '';
      ctrl.signal.addEventListener('abort', () => { void reader.cancel().catch(() => undefined); }, { once: true });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.length > 1_000_000) break;
        let i: number;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
          const out = relayEvent(block, s.jmapAccountId);
          if (out) res.write(out);
        }
      }
    } catch (err) {
      if (!res.headersSent) await callError(res, err, wm);
    } finally {
      if (recheck) clearInterval(recheck);
      own.delete(ctrl);
      if (own.size === 0) streams.delete(wm.sidHash);
      streamCount--;
      if (!res.writableEnded) res.end();
    }
  });

  api.get('/vacation', async (req, res) => {
    const s = needSession(req, res);
    if (!s) return;
    try {
      res.json(await deps.vacation.get(s.mailboxId) ?? { enabled: false, subject: '', body: '', startsAt: null, endsAt: null, intervalDays: 7 });
    } catch (err) {
      await callError(res, err, (res.locals as Locals).wm);
    }
  });

  api.put('/vacation', jsonOnly, smallJson, async (req, res) => {
    const s = needCsrfSession(req, res);
    if (!s) return;
    try {
      const v = parseVacationInput(req.body);
      res.json(await deps.vacation.set(s.mailboxId, v, (res.locals as Locals).ip || null));
    } catch (err) {
      if (err instanceof VacationInputError) return sendError(res, 400, 'invalidRequest', err.message);
      await callError(res, err, (res.locals as Locals).wm);
    }
  });

  api.use((_req, res) => sendError(res, 404, 'notFound', 'Not found'));
  // Body parser errors (too large / malformed JSON).
  api.use((err: { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === 'entity.too.large') return sendError(res, 413, 'tooLarge', 'Request too large');
    sendError(res, err?.status && err.status >= 400 && err.status < 500 ? err.status : 400, 'invalidRequest', 'Invalid request');
  });
  app.use('/wm-api', api);

  // ── static client ──
  const dist = deps.clientDist;
  const page = dist ? path.join(dist, 'webmail.html') : null;
  if (dist) {
    app.use('/assets', express.static(path.join(dist, 'assets'), { index: false, immutable: true, maxAge: '365d', fallthrough: false, redirect: false }));
  }
  app.get('/:file', (req, res, next) => {
    if (!dist || !ROOT_FILES.has(req.params.file)) return next();
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(dist, req.params.file), (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });
  app.use(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();
    res.setHeader('Cache-Control', 'no-cache');
    if (!(await deps.enabled().catch(() => false))) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
      return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Webmail</title><p style="font-family:sans-serif">Webmail not enabled.</p>');
    }
    if (!page || !fs.existsSync(page)) return res.status(503).type('text').send('The webmail client is not built.');
    res.setHeader('Content-Security-Policy', WEBMAIL_CSP);
    res.type('html').sendFile(page);
  });
  return app;
}

/**
 * One server-sent event of the engine → what the browser gets: StateChange
 * events restricted to the session's own account, pings as comments,
 * anything else dropped. Pure (app.test.ts).
 */
export function relayEvent(block: string, accountId: string): string | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (event === 'ping') return ': ping\n\n';
  if (event !== 'state' && event !== 'message') return null;
  let j: unknown;
  try { j = JSON.parse(data.join('\n')); } catch { return null; }
  const changed = (j as { changed?: Record<string, unknown> } | null)?.changed;
  if (!changed || typeof changed !== 'object') return null;
  const mine = changed[accountId];
  if (!mine || typeof mine !== 'object') return null;
  const types: Record<string, string> = {};
  for (const [k, v] of Object.entries(mine as Record<string, unknown>)) {
    if (/^[A-Za-z]{1,40}$/.test(k) && typeof v === 'string' && v.length <= 255) types[k] = v;
  }
  return `event: state\ndata: ${JSON.stringify({ '@type': 'StateChange', changed: { [accountId]: types } })}\n\n`;
}
