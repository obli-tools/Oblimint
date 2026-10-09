import http from 'http';
import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { db } from '../db';
import { logger } from '../utils/logger';
import { verifyFileServerHookToken } from '../services/hosting/secrets';
import { CONTAINER_PATHS } from '../services/hosting/paths';
import { fileAccessService, type FileServerLoginAttempt, type FileServerLoginResult } from '../services/hosting/fileAccess.service';
import { publishScheduler } from '../services/releases/publishScheduler';

// ─────────────────────────────────────────────────────────────────────────────
// Internal HTTP listener (config.hosting.internalPort, default 8081) for the
// per-account file servers. NEVER published on the host, never mounted under
// the public app (H4): a separate express app on its own port. OWNED BY MODULE `releases`.
//
//   GET  /internal/health
//   POST /internal/filesrv/:accountId/:token/auth    SFTPGo external auth hook
//   POST /internal/filesrv/:accountId/:token/event   SFTPGo action hook (upload, delete, rename…)
//
// :token = fileServerHookToken(accountId) (services/hosting/secrets.ts),
// checked in constant time (wrong token → 404, no oracle); rate-limited;
// JSON body ≤ 64 KiB.
//
// SFTPGo formats (docs.sftpgo.com, "External authentication" + "Custom
// actions", legacy HTTP hooks):
//   auth request  { username, ip, protocol, password?, public_key?, keyboard_interactive?, tls_cert?, user? }
//   auth answer   200 + user JSON = allowed; any other status = denied.
//                 (an EMPTY 200 body means "keep the existing user" since 2.1
//                 — never sent here: a refusal is always a 401.)
//   action body   { action, username, path, target_path?, virtual_path,
//                   virtual_target_path?, protocol, status, ip, timestamp… }
//                 virtual paths are relative to the user's home (/srv/files):
//                 "/staging/<slug>/wp-config.php".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rights of a file-server user. Never create_symlinks nor chown (F1).
 * 'chmod' (and 'chtimes') are granted ONLY because the file server runs with
 * setstat_mode 1 (images/filesrv/oblimint-filesrv): SFTPGo 2.6 checks the
 * permission BEFORE consulting setstat_mode (connection.go handleChmod), so
 * without it every OpenSSH `sftp put -r` (final setstat of each created directory)
 * printed 'remote setstat … Permission denied'; with it the request is
 * accepted and IGNORED — a client can never change a mode on disk.
 */
const SETSTAT_ACCEPTED = ['chmod', 'chtimes'] as const;
const RW_PERMS = ['list', 'download', 'upload', 'overwrite', 'delete', 'rename', 'create_dirs', ...SETSTAT_ACCEPTED] as const;

export function sftpgoUser(username: string): Record<string, unknown> {
  return {
    status: 1,
    username,
    home_dir: CONTAINER_PATHS.filesRoot,
    uid: 0,
    gid: 0,
    max_sessions: 10,
    permissions: {
      // chmod also on / : `put -r . /staging` ends with a setstat of /staging itself (checked against /).
      '/': ['list', 'download', 'chmod'],
      '/staging': [...RW_PERMS],
      '/data': [...RW_PERMS],
    },
    filters: { denied_protocols: ['FTP', 'DAV', 'HTTP'] },
  };
}

export interface InternalDeps {
  verifyToken(accountId: number, token: unknown): boolean;
  verifyLogin(accountId: number, attempt: FileServerLoginAttempt): Promise<FileServerLoginResult>;
  accountUsername(accountId: number): Promise<string | null>;
  siteIdBySlug(accountId: number, slug: string): Promise<number | null>;
  notifyChange(siteId: number): void;
}

const defaultDeps: InternalDeps = {
  verifyToken: verifyFileServerHookToken,
  verifyLogin: (accountId, attempt) => fileAccessService.verifyLogin(accountId, attempt),
  async accountUsername(accountId) {
    const row = await db('hosting_accounts').where({ id: accountId }).first('username') as { username: string } | undefined;
    return row?.username ?? null;
  },
  async siteIdBySlug(accountId, slug) {
    const row = await db('sites').where({ account_id: accountId, slug }).first('id') as { id: number } | undefined;
    return row ? row.id : null;
  },
  notifyChange: (siteId) => publishScheduler.notifyChange(siteId),
};

const SITE_CACHE_TTL_MS = 5_000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Site slug touched by a virtual path ("/staging/<slug>/…" or "/staging/<slug>"), null otherwise. */
export function stagingSlugOf(virtualPath: unknown): string | null {
  if (typeof virtualPath !== 'string' || !virtualPath) return null;
  const parts = virtualPath.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
  if (parts.length < 2 || parts[0] !== 'staging') return null;
  return SLUG_RE.test(parts[1]) ? parts[1] : null;
}

/** Virtual path of an action: virtual_path, else `path` relative to /srv/files. */
function virtualOf(v: unknown, fsPath: unknown): string | null {
  if (typeof v === 'string' && v) return v;
  if (typeof fsPath === 'string' && fsPath.startsWith(`${CONTAINER_PATHS.filesRoot}/`)) return fsPath.slice(CONTAINER_PATHS.filesRoot.length);
  return null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** The internal app (exported for tests: listen on port 0 with fake deps). */
export function createInternalApp(over: Partial<InternalDeps> = {}): Express {
  const deps: InternalDeps = { ...defaultDeps, ...over };
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  // Two budgets (one filesrv container per account = one source IP): the auth hook is the
  // brute-force surface (strict); action events arrive one per uploaded file (a WordPress
  // tree ≈ 3000) and dropping them would let the debounce fire mid-upload, so their
  // ceiling is only a DoS guard (token-gated, cheap handler).
  const authLimiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false });
  const eventLimiter = rateLimit({ windowMs: 60_000, limit: 60_000, standardHeaders: true, legacyHeaders: false });
  app.use('/internal/filesrv/:accountId/:token/auth', authLimiter);
  app.use('/internal/filesrv/:accountId/:token/event', eventLimiter);
  app.use(express.json({ limit: '64kb' }));

  app.get('/internal/health', (_req, res) => { res.json({ ok: true }); });

  // Bulk uploads send one event per file: the slug → site lookup is coalesced (short TTL, in-flight shared).
  const siteCache = new Map<string, { at: number; value: Promise<number | null> }>();
  const lookupSite = (accountId: number, slug: string): Promise<number | null> => {
    const key = `${accountId}/${slug}`;
    const now = Date.now();
    const hit = siteCache.get(key);
    if (hit && now - hit.at < SITE_CACHE_TTL_MS) return hit.value;
    if (siteCache.size > 1000) siteCache.clear();
    const value = deps.siteIdBySlug(accountId, slug);
    siteCache.set(key, { at: now, value });
    value.catch(() => { if (siteCache.get(key)?.value === value) siteCache.delete(key); });
    return value;
  };

  const accountOf = (req: Request): number | null => {
    const id = Number(req.params.accountId);
    if (!Number.isInteger(id) || id <= 0 || !deps.verifyToken(id, req.params.token)) return null;
    return id;
  };

  app.post('/internal/filesrv/:accountId/:token/auth', async (req: Request, res: Response) => {
    const accountId = accountOf(req);
    if (!accountId) { res.status(404).end(); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const username = str(b.username);
    try {
      if (!username) { res.status(401).end(); return; }
      // keyboard-interactive and TLS certificates are not offered: only password / public key.
      const attempt: FileServerLoginAttempt = {
        username,
        password: str(b.password),
        publicKey: str(b.public_key),
        ip: str(b.ip),
        protocol: str(b.protocol),
      };
      if (!attempt.password && !attempt.publicKey) { res.status(401).end(); return; }
      const result = await deps.verifyLogin(accountId, attempt);
      if (!result.ok) { res.status(401).end(); return; }
      const accountUsername = await deps.accountUsername(accountId);
      // verifyLogin already enforces it; checked again so a stub can never widen access (F1).
      if (!accountUsername || accountUsername !== username) { res.status(401).end(); return; }
      res.status(200).json(sftpgoUser(accountUsername));
    } catch (err) {
      logger.warn({ err, accountId }, 'File-server auth hook failed');
      res.status(401).end();
    }
  });

  app.post('/internal/filesrv/:accountId/:token/event', (req: Request, res: Response) => {
    const accountId = accountOf(req);
    if (!accountId) { res.status(404).end(); return; }
    res.status(200).json({ ok: true }); // answer first: SFTPGo waits on the hook
    const b = (req.body ?? {}) as Record<string, unknown>;
    const slugs = new Set<string>();
    for (const vp of [virtualOf(b.virtual_path, b.path), virtualOf(b.virtual_target_path, b.target_path)]) {
      const slug = stagingSlugOf(vp);
      if (slug) slugs.add(slug);
    }
    // /data events are ignored in P1 (activation-on-change is P2).
    for (const slug of slugs) {
      lookupSite(accountId, slug)
        .then((siteId) => { if (siteId) deps.notifyChange(siteId); })
        .catch((err) => logger.warn({ err, accountId, slug }, 'File-server event hook: site lookup failed'));
    }
  });

  app.use((_req, res) => { res.status(404).end(); });
  // Malformed JSON / oversized body → 400 without a stack trace.
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: express.NextFunction) => {
    res.status(err.status && err.status >= 400 && err.status < 500 ? err.status : 500).end();
  });
  return app;
}

let server: http.Server | null = null;

/** Starts the listener (no-op when internalPort = 0). Returns null when not started. */
export function startInternalServer(): http.Server | null {
  if (server) return server;
  const port = config.hosting.internalPort;
  if (!port) {
    logger.info('Internal hook listener disabled (OBLIMINT_INTERNAL_PORT=0)');
    return null;
  }
  const s = http.createServer(createInternalApp());
  s.requestTimeout = 30_000;
  s.headersTimeout = 10_000;
  s.on('error', (err) => logger.error({ err, port }, 'Internal hook listener error'));
  s.listen(port, '0.0.0.0', () => logger.info({ port }, 'Internal hook listener started'));
  server = s;
  return s;
}

export function stopInternalServer(): void {
  if (!server) return;
  server.close();
  server.closeAllConnections?.();
  server = null;
}
