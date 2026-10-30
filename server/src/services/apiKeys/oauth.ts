import crypto from 'crypto';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { connectorRedirectAllowed, type ApiKeyScope, type OAuthAuthorizeInfo } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { ipKey } from '../../middleware/rateLimiter';
import { clientIp } from '../../utils/clientIp';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { publicPanelOrigin } from '../panelHosts';
import { gateAction } from '../restrictions/gate';
import { clientSecretMatches, hashKey, scopesHeldBy } from './apiKeys.service';

// ─────────────────────────────────────────────────────────────────────────────
// OAuth 2.1 authorization server of the « Connecteurs Claude » (api_keys of
// kind 'connector'), as the MCP authorization spec expects it (2025-06-18):
//
//   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728 (resource /mcp)
//   GET  /.well-known/oauth-authorization-server[/mcp] RFC 8414
//   GET  /oauth/authorize    the SPA consent page (client/src/pages/OAuthAuthorizePage)
//   GET  /api/oauth/authorize   (session) what the consent page shows
//   POST /api/oauth/authorize   (session) approve / deny → { redirectUrl }
//   POST /oauth/token        authorization_code (PKCE S256) | refresh_token
//
// Confidential pre-registered clients only (the client id / secret the panel
// shows when the connector is created; claude.ai « Advanced settings »): no
// dynamic registration. Redirect URIs: Claude's callbacks and loopback
// (CONNECTOR_REDIRECT_URIS). Codes live 5 min and are single use, access
// tokens 1 h, refresh tokens 60 days and rotate at each use — a refresh token
// presented twice revokes everything of its authorization (stolen copy).
// The tokens act for the panel user who approved (his CURRENT rights, within
// the connector's scopes and sites): apiKeysService.verifyAccessToken().
// ─────────────────────────────────────────────────────────────────────────────

const CODE_TTL_MS = 5 * 60_000;
export const ACCESS_TTL_SEC = 3600;
const REFRESH_TTL_MS = 60 * 86_400_000;

interface ConnectorRow {
  id: number; tenant_id: number; account_id: number; name: string; scopes: unknown; site_scope: 'all' | 'selected';
  oauth_secret_hash: string | null; expires_at: Date | string | null; account_status: string; username: string; primary_domain: string | null;
}

/** Origin the OAuth URLs are built on: the panel host the request came through. */
export async function oauthOrigin(req: Request): Promise<string> {
  return (await publicPanelOrigin(req)) ?? `${req.protocol}://${req.get('host') ?? 'localhost'}`;
}

export async function resourceMetadataUrl(req: Request): Promise<string> {
  return `${await oauthOrigin(req)}/.well-known/oauth-protected-resource`;
}

async function loadConnector(clientId: unknown): Promise<ConnectorRow | null> {
  if (typeof clientId !== 'string' || !/^oblimint-[A-Za-z0-9_-]{16}$/.test(clientId)) return null;
  const row = await db('api_keys as k')
    .join('hosting_accounts as a', function joinAccount() { this.on('a.id', '=', 'k.account_id').andOn('a.tenant_id', '=', 'k.tenant_id'); })
    .where({ 'k.oauth_client_id': clientId, 'k.kind': 'connector' })
    .first('k.id', 'k.tenant_id', 'k.account_id', 'k.name', 'k.scopes', 'k.site_scope', 'k.oauth_secret_hash', 'k.expires_at',
      'a.status as account_status', 'a.username',
      db.raw("(SELECT d.name FROM domains d WHERE d.account_id = a.id AND d.kind = 'primary' ORDER BY d.id LIMIT 1) AS primary_domain")) as ConnectorRow | undefined;
  if (!row) return null;
  if (row.account_status === 'deleting') return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row;
}

const str = (v: unknown, max = 2048): string => (typeof v === 'string' ? v.slice(0, max) : '');

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

/**
 * Checks an authorization request. Errors about the client or the redirect URI
 * are shown on the page (never redirected: RFC 6749 §4.1.2.1); the others too,
 * the page offers no way on.
 */
async function checkAuthorize(q: Record<string, unknown>): Promise<{ p: AuthorizeParams; connector: ConnectorRow }> {
  const connector = await loadConnector(q.client_id);
  if (!connector) throw new AppError(400, 'Unknown, expired or disabled connector (client_id)', 'oauthInvalidClient');
  const redirectUri = str(q.redirect_uri);
  if (!redirectUri || !connectorRedirectAllowed(redirectUri)) throw new AppError(400, 'This redirect address is not allowed for a connector', 'oauthInvalidRedirect');
  if (str(q.response_type) !== 'code') throw new AppError(400, 'Only response_type=code is supported', 'oauthInvalidRequest');
  const codeChallenge = str(q.code_challenge, 256);
  if (str(q.code_challenge_method) !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
    throw new AppError(400, 'PKCE is required (code_challenge_method=S256)', 'oauthInvalidRequest');
  }
  return { p: { clientId: str(q.client_id), redirectUri, state: str(q.state, 1024), codeChallenge }, connector };
}

function withParams(uri: string, params: Record<string, string>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.toString();
}

const newToken = (prefix: 'obc' | 'oba' | 'obr') => `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = Buffer.from(crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && crypto.timingSafeEqual(computed, expected);
}

export const oauthService = {
  /** GET /api/oauth/authorize: the consent page. */
  async authorizeInfo(userId: number, q: Record<string, unknown>): Promise<OAuthAuthorizeInfo> {
    const { p, connector } = await checkAuthorize(q);
    const held = await scopesHeldBy(userId, connector);
    if (!held) throw new AppError(403, 'Your account has no access to the hosting account of this connector', 'oauthNoAccess');
    const sites = connector.site_scope === 'all'
      ? await db('sites').where({ account_id: connector.account_id }).orderBy('name').select('id', 'name')
      : await db('api_key_sites as ks').join('sites as s', 's.id', 'ks.site_id').where('ks.key_id', connector.id).orderBy('s.name').select('s.id', 's.name');
    return {
      connector: { id: connector.id, name: connector.name, accountId: connector.account_id, accountUsername: connector.username, primaryDomain: connector.primary_domain },
      redirectHost: new URL(p.redirectUri).host,
      scopes: held.held, missingScopes: held.missing, siteScope: connector.site_scope,
      sites: (sites as Array<{ id: number; name: string }>).map((s) => ({ id: Number(s.id), name: s.name })),
    };
  },

  /** POST /api/oauth/authorize: approve (code) or deny; the page then goes to redirectUrl. */
  async authorize(req: Request, userId: number, body: Record<string, unknown>): Promise<{ redirectUrl: string }> {
    const { p, connector } = await checkAuthorize(body);
    const iss = await oauthOrigin(req);
    if (body.approve !== true) {
      return { redirectUrl: withParams(p.redirectUri, { error: 'access_denied', state: p.state, iss }) };
    }
    const held = await scopesHeldBy(userId, connector);
    if (!held) throw new AppError(403, 'Your account has no access to the hosting account of this connector', 'oauthNoAccess');
    // connector.authorize (spec §2): the consent itself is protected. The fingerprint holds the
    // connector, the client and the scopes — not the PKCE challenge / state, new at each attempt,
    // so an approved consent is found again when the human retries from claude.ai.
    await gateAction(req, {
      action: 'connector.authorize',
      target: { tenantId: Number(connector.tenant_id), accountId: Number(connector.account_id), siteId: null },
      params: { connectorId: connector.id, name: connector.name, client: new URL(p.redirectUri).host, scopes: [...held.held].sort(), siteScope: connector.site_scope },
    });
    const code = newToken('obc');
    await db('api_key_oauth_tokens').insert({
      key_id: connector.id, kind: 'code', token_hash: hashKey(code), family: crypto.randomUUID(), user_id: userId,
      code_challenge: p.codeChallenge, redirect_uri: p.redirectUri, expires_at: new Date(Date.now() + CODE_TTL_MS),
    });
    await auditService.logReqAs(req, connector.tenant_id, 'apiKey.authorize', {
      resourceType: 'account', resourcePath: String(connector.account_id),
      details: { keyId: connector.id, name: connector.name, client: new URL(p.redirectUri).host, scopes: held.held },
    });
    return { redirectUrl: withParams(p.redirectUri, { code, state: p.state, iss }) };
  },

  /** POST /oauth/token → token response, or an OAuth error (RFC 6749 §5.2). */
  async token(body: Record<string, unknown>, authorization: string | undefined): Promise<{ status: number; body: Record<string, unknown> }> {
    const fail = (status: number, error: string, description: string) => ({ status, body: { error, error_description: description } });
    // Client authentication: client_secret_basic or client_secret_post.
    let clientId = str(body.client_id, 128);
    let secret = str(body.client_secret, 256);
    const basic = typeof authorization === 'string' && /^Basic\s+/i.test(authorization) ? authorization.replace(/^Basic\s+/i, '') : '';
    if (basic) {
      const decoded = Buffer.from(basic, 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i > 0) {
        try { clientId = decodeURIComponent(decoded.slice(0, i)); secret = decodeURIComponent(decoded.slice(i + 1)); } catch { /* invalid client below */ }
      }
    }
    const connector = await loadConnector(clientId);
    const secretOk = clientSecretMatches(secret, connector?.oauth_secret_hash ?? null); // same work whatever the client
    if (!connector || !secretOk) return fail(401, 'invalid_client', 'Unknown client or wrong client secret');

    const grant = str(body.grant_type, 64);
    // Housekeeping: expired rows of this connector.
    db('api_key_oauth_tokens').where({ key_id: connector.id }).where('expires_at', '<', new Date(Date.now() - 86_400_000)).del()
      .catch((err: unknown) => logger.warn({ err }, 'oauth: cleanup failed'));

    if (grant === 'authorization_code') {
      const code = str(body.code, 128);
      const row = code ? await db('api_key_oauth_tokens').where({ token_hash: hashKey(code), kind: 'code', key_id: connector.id }).first() as TokenRow | undefined : undefined;
      if (!row) return fail(400, 'invalid_grant', 'Unknown authorization code');
      if (row.used_at) {
        await db('api_key_oauth_tokens').where({ family: row.family }).del(); // code replayed: revoke what it produced
        return fail(400, 'invalid_grant', 'Authorization code already used');
      }
      if (new Date(row.expires_at).getTime() <= Date.now()) return fail(400, 'invalid_grant', 'Authorization code expired');
      if (str(body.redirect_uri) !== row.redirect_uri) return fail(400, 'invalid_grant', 'redirect_uri does not match the authorization request');
      if (!pkceMatches(str(body.code_verifier, 256), row.code_challenge ?? '')) return fail(400, 'invalid_grant', 'PKCE verification failed');
      const used = await db('api_key_oauth_tokens').where({ id: row.id }).whereNull('used_at').update({ used_at: db.fn.now() });
      if (!used) return fail(400, 'invalid_grant', 'Authorization code already used');
      return issue(connector, row.user_id, row.family);
    }

    if (grant === 'refresh_token') {
      const raw = str(body.refresh_token, 128);
      const row = raw ? await db('api_key_oauth_tokens').where({ token_hash: hashKey(raw), kind: 'refresh', key_id: connector.id }).first() as TokenRow | undefined : undefined;
      if (!row) return fail(400, 'invalid_grant', 'Unknown or revoked refresh token');
      if (row.used_at) {
        await db('api_key_oauth_tokens').where({ family: row.family }).del(); // rotated token replayed: revoke the authorization
        logger.warn({ keyId: connector.id }, 'oauth: refresh token reused, authorization revoked');
        return fail(400, 'invalid_grant', 'Refresh token already used: the authorization is revoked');
      }
      if (new Date(row.expires_at).getTime() <= Date.now()) return fail(400, 'invalid_grant', 'Refresh token expired');
      const used = await db('api_key_oauth_tokens').where({ id: row.id }).whereNull('used_at').update({ used_at: db.fn.now() });
      if (!used) return fail(400, 'invalid_grant', 'Refresh token already used');
      return issue(connector, row.user_id, row.family);
    }

    return fail(400, 'unsupported_grant_type', 'grant_type is authorization_code or refresh_token');
  },
};

interface TokenRow {
  id: number; key_id: number; kind: string; family: string; user_id: number; code_challenge: string | null;
  redirect_uri: string | null; expires_at: Date | string; used_at: Date | string | null;
}

async function issue(connector: ConnectorRow, userId: number, family: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const held = await scopesHeldBy(userId, connector);
  if (!held) {
    await db('api_key_oauth_tokens').where({ family }).del();
    return { status: 400, body: { error: 'invalid_grant', error_description: 'The user who authorized this connector no longer has access to its account' } };
  }
  const access = newToken('oba');
  const refresh = newToken('obr');
  await db.transaction(async (trx) => {
    // Older access tokens of the authorization stop with the rotation.
    await trx('api_key_oauth_tokens').where({ family, kind: 'access' }).del();
    await trx('api_key_oauth_tokens').insert([
      { key_id: connector.id, kind: 'access', token_hash: hashKey(access), family, user_id: userId, expires_at: new Date(Date.now() + ACCESS_TTL_SEC * 1000) },
      { key_id: connector.id, kind: 'refresh', token_hash: hashKey(refresh), family, user_id: userId, expires_at: new Date(Date.now() + REFRESH_TTL_MS) },
    ]);
  });
  return {
    status: 200,
    body: { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_SEC, refresh_token: refresh, scope: held.held.join(' ') as string },
  };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/** Failed client authentications / grants: 30 per 15 min per address, successes not counted. */
const tokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `oauth-token:${ipKey(clientIp(req))}`,
  message: { error: 'temporarily_unavailable', error_description: 'Too many failed requests, try again later' },
});

/** Public part, mounted at the root before the SPA fallback (no session). */
export const oauthPublicRouter = Router({ caseSensitive: true });

const publicJson = (res: Response, body: unknown) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(body);
};

oauthPublicRouter.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], async (req, res, next) => {
  try {
    const origin = await oauthOrigin(req);
    publicJson(res, { resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ['header'], resource_name: 'Oblimint' });
  } catch (err) { next(err); }
});

oauthPublicRouter.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'], async (req, res, next) => {
  try {
    const origin = await oauthOrigin(req);
    publicJson(res, {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      authorization_response_iss_parameter_supported: true,
      scopes_supported: [] as ApiKeyScope[],
    });
  } catch (err) { next(err); }
});

// Form bodies (RFC 6749) or JSON; exempt from the origin / JSON-only guard
// (originGuard PUBLIC_OAUTH_PATHS): no cookie is involved, the client secret,
// the single-use code and PKCE authenticate the request.
oauthPublicRouter.post('/oauth/token', tokenLimiter, express.urlencoded({ extended: false, limit: '16kb' }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const out = await oauthService.token(body, req.headers.authorization);
    if (out.status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="oblimint"');
    res.status(out.status).json(out.body);
  } catch (err) { next(err); }
});

/** Session part: /api/oauth (requireAuth). */
export const oauthApiRouter = Router({ caseSensitive: true });

oauthApiRouter.get('/authorize', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: await oauthService.authorizeInfo(req.session.userId!, req.query as Record<string, unknown>) });
  } catch (err) { next(err); }
});

oauthApiRouter.post('/authorize', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: await oauthService.authorize(req, req.session.userId!, (req.body ?? {}) as Record<string, unknown>) });
  } catch (err) { next(err); }
});
