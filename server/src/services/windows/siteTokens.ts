import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { SiteApiToken, SiteApiTokenCreate, SiteApiTokenCreated, SiteTokenScope } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { ipKey } from '../../middleware/rateLimiter';
import { clientIp } from '../../utils/clientIp';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { actorCan, loadSite, type HostingActor } from '../hosting/access';
import type { SiteRow } from '../hosting/rows';
import { userCanPublish } from './guarantor';

// ─────────────────────────────────────────────────────────────────────────────
// Site API tokens (window trigger "API / CLI", docs/P3-PLAN.md §6.2, M6).
// OWNED BY MODULE `windows`.
//
// Token format: obt_<tokenId>_<43 chars base64url (32 random bytes)>; only
// sha256(token) is stored (site_api_tokens.token_hash), compared in constant
// time; scope 'windows'; expiry (≥ now + 1 h); last_used_at/ip. siteTokenAuth()
// resolves the Bearer header into req.siteToken = { tokenId, siteId,
// accountId, tenantId, name } or answers 401 { code: 'invalidToken' } (rate
// limited per IP). A token is never logged; the audit names it.
//
// A token opens / closes windows (live code writable, auto-validated release
// with autoValidate 'scheduled-api'): creating or listing one needs what the
// panel needs to open a window (releases.publish) plus sites.manage, and the
// token only works while its CREATOR still holds both on the account
// (guarantor.ts): a user removed from the account, deactivated, deleted or
// stripped of a capability disarms every token he created.
// ─────────────────────────────────────────────────────────────────────────────

export interface SiteTokenIdentity {
  tokenId: number;
  siteId: number;
  accountId: number;
  tenantId: number;
  name: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by siteTokenAuth (routes /api/site-api/*). */
    siteToken?: SiteTokenIdentity;
  }
}

/** Tokens per site. */
export const MAX_TOKENS_PER_SITE = 10;
/** Shortest lifetime of an expiring token. */
export const MIN_TOKEN_TTL_MS = 60 * 60 * 1000;

const TOKEN_RE = /^obt_([1-9]\d{0,9})_([A-Za-z0-9_-]{43})$/;

/** sha256 hex of a raw token (what the table stores). */
export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** New token for row `id`: { token (shown once), hash, prefix }. */
export function generateToken(id: number): { token: string; hash: string; prefix: string } {
  const secret = crypto.randomBytes(32).toString('base64url');
  const token = `obt_${id}_${secret}`;
  return { token, hash: hashToken(token), prefix: `obt_${id}_${secret.slice(0, 6)}` };
}

/** Token id of a well-formed token, null otherwise. */
export function parseToken(raw: string): number | null {
  const m = TOKEN_RE.exec(typeof raw === 'string' ? raw : '');
  return m ? Number(m[1]) : null;
}

/** Constant-time comparison of the hash of `raw` with a stored hex hash. */
export function tokenMatches(raw: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(raw), 'hex');
  const b = Buffer.from(typeof storedHash === 'string' && /^[0-9a-f]{64}$/.test(storedHash) ? storedHash : '0'.repeat(64), 'hex');
  return crypto.timingSafeEqual(a, b) && /^[0-9a-f]{64}$/.test(storedHash);
}

interface TokenRow {
  id: number; tenant_id: number; account_id: number; site_id: number; name: string; token_hash: string; prefix: string;
  scopes: unknown; created_by: number | null; last_used_at: Date | string | null; last_used_ip: string | null;
  expires_at: Date | string | null; created_at: Date | string; updated_at: Date | string;
  /** joined */ created_by_name?: string | null;
}

const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

function scopesOf(raw: unknown): SiteTokenScope[] {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = []; } }
  return Array.isArray(v) ? v.filter((s): s is SiteTokenScope => s === 'windows') : [];
}

function toToken(r: TokenRow): SiteApiToken {
  return {
    id: r.id, siteId: r.site_id, name: r.name, prefix: r.prefix, scopes: scopesOf(r.scopes),
    createdByName: r.created_by_name ?? null, createdAt: iso(r.created_at) as string,
    lastUsedAt: iso(r.last_used_at), expiresAt: iso(r.expires_at),
  };
}

function tokenQuery() {
  return db('site_api_tokens as t')
    .leftJoin('users as u', 'u.id', 't.created_by')
    .select('t.*', db.raw('COALESCE(u.display_name, u.username) as created_by_name'));
}

/** Token management: releases.publish (a token publishes code) AND sites.manage. 404 / 403 like loadSite. */
async function loadSiteForTokens(actor: HostingActor, siteId: number): Promise<SiteRow> {
  const site = await loadSite(actor, siteId, 'releases.publish');
  if (!actorCan(actor, 'sites.manage', { tenantId: site.tenant_id, accountId: site.account_id })) throw new AppError(403, 'Insufficient permissions');
  return site;
}

export const siteTokenService = {
  async list(actor: HostingActor, siteId: number): Promise<SiteApiToken[]> {
    const site = await loadSiteForTokens(actor, siteId);
    const rows = await tokenQuery().where('t.site_id', site.id).andWhere('t.account_id', site.account_id).orderBy('t.id') as TokenRow[];
    return rows.map(toToken);
  },

  async create(req: Request, actor: HostingActor, siteId: number, body: SiteApiTokenCreate): Promise<SiteApiTokenCreated> {
    const site = await loadSiteForTokens(actor, siteId);
    const name = String(body.name ?? '').trim().slice(0, 100);
    if (!name) throw new AppError(400, 'A token needs a name', 'validation');
    let expiresAt: Date | null = null;
    if (body.expiresAt) {
      expiresAt = new Date(body.expiresAt);
      if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now() + MIN_TOKEN_TTL_MS) {
        throw new AppError(400, 'A token expires at least one hour from now', 'validation');
      }
    }
    const created = await db.transaction(async (trx) => {
      // Serializes the creations of a site (count + unique name).
      await trx('sites').where({ id: site.id }).forUpdate().first('id');
      const count = await trx('site_api_tokens').where({ site_id: site.id }).count<{ n: string }[]>('* as n');
      if (Number(count[0]?.n ?? 0) >= MAX_TOKENS_PER_SITE) {
        throw new AppError(409, `At most ${MAX_TOKENS_PER_SITE} API tokens per site`, 'tokenLimit', { max: MAX_TOKENS_PER_SITE });
      }
      if (await trx('site_api_tokens').where({ site_id: site.id, name }).first('id')) {
        throw new AppError(409, 'A token of this site already has this name', 'tokenNameTaken');
      }
      // The id is part of the token: insert with a throw-away hash, then the real one.
      const [row] = await trx('site_api_tokens').insert({
        tenant_id: site.tenant_id, account_id: site.account_id, site_id: site.id, name,
        token_hash: hashToken(crypto.randomBytes(32).toString('hex')), prefix: 'obt_',
        scopes: JSON.stringify(['windows']), created_by: actor.userId, expires_at: expiresAt,
      }).returning('id');
      const id = Number(typeof row === 'object' ? row.id : row);
      const g = generateToken(id);
      await trx('site_api_tokens').where({ id }).update({ token_hash: g.hash, prefix: g.prefix });
      return { id, token: g.token };
    });
    await auditService.logReqAs(req, site.tenant_id, 'siteToken.create', {
      resourceType: 'site', resourcePath: String(site.id),
      details: { siteId: site.id, tokenId: created.id, name, expiresAt: expiresAt?.toISOString() ?? null },
    });
    const row = await tokenQuery().where('t.id', created.id).first() as TokenRow;
    return { ...toToken(row), token: created.token };
  },

  async remove(req: Request, actor: HostingActor, siteId: number, tokenId: number): Promise<void> {
    const site = await loadSite(actor, siteId, 'sites.manage');
    const row = await db('site_api_tokens').where({ id: tokenId, site_id: site.id, account_id: site.account_id }).first('id', 'name') as
      { id: number; name: string } | undefined;
    if (!row) throw new AppError(404, 'Token not found', 'notFound');
    await db('site_api_tokens').where({ id: row.id, site_id: site.id }).del();
    await auditService.logReqAs(req, site.tenant_id, 'siteToken.delete', {
      resourceType: 'site', resourcePath: String(site.id), details: { siteId: site.id, tokenId: row.id, name: row.name },
    });
  },

  /** Resolves a raw Bearer token (null: unknown / expired / bad format / wrong scope / site gone / creator no longer allowed). */
  async verify(raw: string): Promise<SiteTokenIdentity | null> {
    const id = parseToken(raw);
    if (id === null) return null;
    const row = await db('site_api_tokens as t')
      .join('sites as s', function joinSite() { this.on('s.id', '=', 't.site_id').andOn('s.account_id', '=', 't.account_id'); })
      .join('hosting_accounts as a', function joinAccount() { this.on('a.id', '=', 't.account_id').andOn('a.tenant_id', '=', 't.tenant_id'); })
      .where('t.id', id)
      .first('t.id', 't.site_id', 't.account_id', 't.tenant_id', 't.name', 't.token_hash', 't.scopes', 't.expires_at', 't.created_by', 'a.status as account_status') as
      (Pick<TokenRow, 'id' | 'site_id' | 'account_id' | 'tenant_id' | 'name' | 'token_hash' | 'scopes' | 'expires_at' | 'created_by'> & { account_status: string }) | undefined;
    // Compare even when the row is missing: same work whatever the id.
    const ok = tokenMatches(raw, row?.token_hash ?? '');
    if (!row || !ok) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;
    if (!scopesOf(row.scopes).includes('windows')) return null;
    if (row.account_status === 'deleting') return null;
    // The creator vouches for the token: it dies with his rights on the account.
    if (!(await userCanPublish(row.created_by, { tenantId: row.tenant_id, accountId: row.account_id }))) return null;
    return { tokenId: row.id, siteId: row.site_id, accountId: row.account_id, tenantId: row.tenant_id, name: row.name };
  },
};

/** /api/site-api: 120 requests / min / IP (/64 for IPv6), whatever the outcome. */
export const siteApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `site-api:${ipKey(req.ip)}`,
  message: { success: false, error: 'Too many requests, please try again later', code: 'rateLimited' },
});

/** Bad tokens: 20 refused attempts / 15 min / IP (successful requests not counted). */
export const siteApiAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `site-api-auth:${ipKey(req.ip)}`,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401,
  skipSuccessfulRequests: true,
  message: { success: false, error: 'Too many invalid tokens, please try again later', code: 'rateLimited' },
});

/** Express middleware of /api/site-api: Bearer token → req.siteToken, else 401 invalidToken. */
export function siteTokenAuth(req: Request, res: Response, next: NextFunction): void {
  const header = String(req.headers.authorization ?? '');
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  const deny = (): void => {
    res.status(401).json({ success: false, error: 'Invalid or expired site API token', code: 'invalidToken' });
  };
  if (!m) { deny(); return; }
  siteTokenService.verify(m[1]).then((identity) => {
    if (!identity) { deny(); return; }
    req.siteToken = identity;
    const ip = clientIp(req).slice(0, 64) || null;
    void db('site_api_tokens').where({ id: identity.tokenId }).update({ last_used_at: db.fn.now(), last_used_ip: ip })
      .catch((err: unknown) => logger.debug({ err }, 'site token: last_used update failed'));
    next();
  }).catch(next);
}
