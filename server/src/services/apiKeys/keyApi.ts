import type { Request } from 'express';
import type { Readable } from 'stream';
import type {
  ApiV1Me, ApiV1Site, FileExtractResult, FileListing, FileOpResult, FileText, FileUploadChunkResult, FileUploadSession, LogQueryResult, Release,
  SiteCreate, StagingStatus,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { auditService } from '../audit.service';
import { filesService, joinVirtual, splitVirtual } from '../files/files.service';
import type { HostdFileStream } from '../hostd/files';
import { loadAccount, loadSite } from '../hosting/access';
import type { AccountRow, SiteRow } from '../hosting/rows';
import { sitesService } from '../hosting/sites.service';
import { releaseForActor } from '../hosting/statusMessage';
import { assertSource, logsService } from '../logs/logs.service';
import { releaseService } from '../releases/release.service';
import { apiKeysService, keyAllowsSite, requireScope, type ApiKeyContext } from './apiKeys.service';

// ─────────────────────────────────────────────────────────────────────────────
// What an API key can do (routes/v1.routes.ts and the MCP server share it).
// Every operation: the key's scope, then the site restriction (a site outside
// the key's selection is a 404, as if it did not exist), then the services'
// own checks with the key's actor (its account only, the creator's current
// rights). File paths are relative to the site's area (staging = the code,
// data = the files the site writes) and never leave it.
// ─────────────────────────────────────────────────────────────────────────────

export type SiteArea = 'staging' | 'data';

async function accountRow(ctx: ApiKeyContext): Promise<AccountRow> {
  return loadAccount(ctx.actor, ctx.accountId, 'read');
}

/** A site of the key (404 outside its selection or its account). */
export async function keySite(ctx: ApiKeyContext, siteId: number): Promise<SiteRow> {
  if (!Number.isInteger(siteId) || siteId <= 0 || !keyAllowsSite(ctx, siteId)) throw new AppError(404, 'Site not found', 'notFound');
  const site = await loadSite(ctx.actor, siteId, 'read');
  if (site.account_id !== ctx.accountId) throw new AppError(404, 'Site not found', 'notFound');
  return site;
}

/** Virtual explorer path of `rel` inside the site's area. */
export function areaPath(site: Pick<SiteRow, 'slug'>, area: unknown, rel: unknown): string {
  const a = area === undefined || area === null || area === '' ? 'staging' : area;
  if (a !== 'staging' && a !== 'data') throw new AppError(400, 'area is staging or data', 'invalidPath');
  const r = typeof rel === 'string' ? rel : '';
  return joinVirtual(splitVirtual(`/${a}/${site.slug}/${r.replace(/^\/+/, '')}`));
}

/** Back from a virtual path to the site-relative one ("/" for the area root). */
function relOf(site: Pick<SiteRow, 'slug'>, area: SiteArea, virtual: string): string {
  const root = `/${area}/${site.slug}`;
  return virtual === root ? '/' : virtual.startsWith(`${root}/`) ? virtual.slice(root.length) : virtual;
}

async function filesAccount(ctx: ApiKeyContext, write: boolean): Promise<AccountRow> {
  requireScope(ctx, write ? 'files.write' : 'files.read');
  return loadAccount(ctx.actor, ctx.accountId, 'files.manage');
}

async function siteViews(ctx: ApiKeyContext, ids: number[] | null): Promise<ApiV1Site[]> {
  const q = db('sites as s')
    .leftJoin('releases as r', 'r.id', 's.current_release_id')
    .where('s.account_id', ctx.accountId)
    .select('s.id', 's.name', 's.slug', 's.status', 's.base', 's.docroot', 's.publish_mode', 'r.number as release_number')
    .orderBy('s.id');
  if (ids) q.whereIn('s.id', ids);
  const rows = (await q as Array<{ id: number; name: string; slug: string; status: string; base: string; docroot: string; publish_mode: string; release_number: number | null }>)
    .filter((r) => keyAllowsSite(ctx, r.id));
  if (!rows.length) return [];
  const doms = await db('site_routes as sr').join('domains as d', 'd.id', 'sr.domain_id').whereIn('sr.site_id', rows.map((r) => r.id))
    .select('sr.site_id', 'd.name', 'sr.path_prefix', 'd.kind').orderBy([{ column: 'sr.path_prefix' }, { column: 'd.id' }]) as
    Array<{ site_id: number; name: string; path_prefix: string; kind: string }>;
  const created = new Set(await db('api_key_sites').where({ key_id: ctx.id, created_by_key: true }).pluck('site_id') as number[]);
  return rows.map((r) => {
    const mine = doms.filter((d) => d.site_id === r.id);
    const primary = mine.find((d) => d.path_prefix === '/') ?? mine[0];
    return {
      id: r.id, name: r.name, slug: r.slug, status: r.status, base: r.base, docroot: r.docroot, publishMode: r.publish_mode,
      primaryDomain: primary?.name ?? null, domains: [...new Set(mine.map((d) => d.name))], currentRelease: r.release_number ?? null,
      createdByKey: created.has(r.id),
    };
  });
}

export const keyApi = {
  async me(ctx: ApiKeyContext): Promise<ApiV1Me> {
    const a = await db('hosting_accounts').where({ id: ctx.accountId }).first('id', 'username',
      db.raw("(SELECT d.name FROM domains d WHERE d.account_id = hosting_accounts.id AND d.kind = 'primary' ORDER BY d.id LIMIT 1) AS primary_domain")) as
      { id: number; username: string; primary_domain: string | null };
    const expires = await db('api_keys').where({ id: ctx.id }).first('expires_at') as { expires_at: Date | string | null } | undefined;
    return {
      key: { id: ctx.id, name: ctx.name, scopes: [...ctx.scopes], siteScope: ctx.siteScope, expiresAt: expires?.expires_at ? new Date(expires.expires_at).toISOString() : null },
      account: { id: a.id, username: a.username, primaryDomain: a.primary_domain },
    };
  },

  listSites: (ctx: ApiKeyContext) => siteViews(ctx, null),

  async getSite(ctx: ApiKeyContext, siteId: number): Promise<ApiV1Site> {
    await keySite(ctx, siteId);
    const [v] = await siteViews(ctx, [siteId]);
    if (!v) throw new AppError(404, 'Site not found', 'notFound');
    return v;
  },

  async createSite(ctx: ApiKeyContext, req: Request, body: Omit<SiteCreate, 'accountId'>): Promise<ApiV1Site> {
    requireScope(ctx, 'sites.create');
    const site = await sitesService.create(req, ctx.actor, { ...body, accountId: ctx.accountId } as SiteCreate & { accountId: number });
    await apiKeysService.recordCreatedSite(ctx, site.id);
    const self = { ...ctx, siteIds: new Set([...ctx.siteIds, site.id]) };
    const [v] = await siteViews(self, [site.id]);
    return v;
  },

  // ── files ──
  async listFiles(ctx: ApiKeyContext, siteId: number, area: SiteArea, path: string): Promise<FileListing> {
    const a = await filesAccount(ctx, false);
    const site = await keySite(ctx, siteId);
    const l = await filesService.list(a, areaPath(site, area, path));
    return { ...l, path: relOf(site, area, l.path) };
  },

  async readText(ctx: ApiKeyContext, siteId: number, area: SiteArea, path: string): Promise<FileText> {
    const a = await filesAccount(ctx, false);
    const site = await keySite(ctx, siteId);
    const t = await filesService.readText(a, areaPath(site, area, path));
    return { ...t, path: relOf(site, area, t.path) };
  },

  async open(ctx: ApiKeyContext, siteId: number, area: SiteArea, path: string, range?: string): Promise<{ stream: HostdFileStream; name: string }> {
    const a = await filesAccount(ctx, false);
    const site = await keySite(ctx, siteId);
    return filesService.open(a, areaPath(site, area, path), range);
  },

  async stagingStatus(ctx: ApiKeyContext, siteId: number): Promise<StagingStatus> {
    requireScope(ctx, 'files.read');
    const site = await keySite(ctx, siteId);
    return releaseService.stagingStatus(site.id);
  },

  async putFile(ctx: ApiKeyContext, siteId: number, area: SiteArea, path: string, size: number, body: Readable, overwrite: boolean): Promise<string> {
    const a = await filesAccount(ctx, true);
    const site = await keySite(ctx, siteId);
    const p = await filesService.putSmall(a, { path: areaPath(site, area, path), size, overwrite }, body);
    return relOf(site, area, p);
  },

  async uploadStart(ctx: ApiKeyContext, siteId: number, area: SiteArea, path: string, size: number, overwrite: boolean): Promise<FileUploadSession> {
    const a = await filesAccount(ctx, true);
    const site = await keySite(ctx, siteId);
    return filesService.uploadStart(a, ctx.creatorId, { path: areaPath(site, area, path), size, overwrite });
  },

  async uploadChunk(ctx: ApiKeyContext, uploadId: string, index: number, length: number, body: Readable): Promise<FileUploadChunkResult> {
    const a = await filesAccount(ctx, true);
    return filesService.uploadChunk(a, ctx.creatorId, uploadId, index, length, body);
  },

  async mkdir(ctx: ApiKeyContext, siteId: number, area: SiteArea, path: string): Promise<string> {
    const a = await filesAccount(ctx, true);
    const site = await keySite(ctx, siteId);
    return relOf(site, area, await filesService.mkdir(a, areaPath(site, area, path)));
  },

  async remove(ctx: ApiKeyContext, siteId: number, area: SiteArea, paths: string[]): Promise<FileOpResult[]> {
    const a = await filesAccount(ctx, true);
    const site = await keySite(ctx, siteId);
    const res = await filesService.remove(a, paths.map((p) => areaPath(site, area, p)));
    return res.map((r) => ({ ...r, path: relOf(site, area, r.path) }));
  },

  async move(ctx: ApiKeyContext, siteId: number, area: SiteArea, items: Array<{ from: string; to: string }>, overwrite: boolean, copy = false): Promise<FileOpResult[]> {
    const a = await filesAccount(ctx, true);
    const site = await keySite(ctx, siteId);
    const mapped = items.map((i) => ({ from: areaPath(site, area, i.from), to: areaPath(site, area, i.to) }));
    const res = copy ? await filesService.copy(a, mapped) : await filesService.move(a, mapped, overwrite);
    return res.map((r) => ({ ...r, path: relOf(site, area, r.path) }));
  },

  async extract(ctx: ApiKeyContext, siteId: number, area: SiteArea, path: string, to: string | undefined, overwrite: boolean): Promise<FileExtractResult> {
    const a = await filesAccount(ctx, true);
    const site = await keySite(ctx, siteId);
    return filesService.extract(a, areaPath(site, area, path), to === undefined ? undefined : areaPath(site, area, to), overwrite);
  },

  // ── releases ──
  async publish(ctx: ApiKeyContext, req: Request, siteId: number, message: string | null): Promise<Release> {
    requireScope(ctx, 'releases.publish');
    const site = await keySite(ctx, siteId);
    await loadSite(ctx.actor, site.id, 'releases.publish');
    const release = await releaseService.publish(site.id, { trigger: 'manual', userId: ctx.creatorId, message });
    await auditService.logReqAs(req, site.tenant_id, 'release.publish', {
      resourceType: 'release', resourcePath: String(release.id), details: { siteId: site.id, number: release.number },
    });
    return release;
  },

  async releases(ctx: ApiKeyContext, siteId: number, limit: number, offset: number): Promise<{ items: Release[]; total: number }> {
    const site = await keySite(ctx, siteId);
    const page = await releaseService.list(site.id, { limit, offset } as Parameters<typeof releaseService.list>[1]);
    return { ...page, items: page.items.map((r) => releaseForActor(ctx.actor, r)) };
  },

  async rollback(ctx: ApiKeyContext, req: Request, siteId: number, releaseId: number): Promise<void> {
    requireScope(ctx, 'releases.publish');
    const site = await keySite(ctx, siteId);
    await loadSite(ctx.actor, site.id, 'releases.publish');
    await releaseService.rollback(site.id, releaseId, ctx.creatorId);
    await auditService.logReqAs(req, site.tenant_id, 'release.rollback', { resourceType: 'release', resourcePath: String(releaseId), details: { siteId: site.id } });
  },

  // ── logs ──
  async logs(ctx: ApiKeyContext, siteId: number, q: { source: string; q?: string | null; limit?: number | null; since?: string | null; until?: string | null; status?: string | null }): Promise<LogQueryResult> {
    requireScope(ctx, 'logs.read');
    const site = await keySite(ctx, siteId);
    return logsService.query(ctx.actor, site.id, {
      source: assertSource(q.source), q: q.q ?? null, limit: q.limit ?? null, since: q.since ?? null, until: q.until ?? null, status: q.status ?? null,
    } as Parameters<typeof logsService.query>[2]);
  },

  accountRow,
};
