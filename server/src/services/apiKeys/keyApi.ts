import type { Request } from 'express';
import type { Readable } from 'stream';
import type {
  ApiV1Me, ApiV1ParentDomain, ApiV1Site, ApiV1SiteUpdate, ApiV1Subdomain, FileExtractResult, FileListing, FileOpResult, FileText, FileUploadChunkResult, FileUploadSession, LogQueryResult, Release,
  SiteCreate, StagingStatus, ApiGuideLang, ApiV1Route, ApiV1RouteDomain, SiteBaseId, SiteRuntime, CronJob, CronJobInput, CronRun, CronRunDetail, SiteDataPath,
} from '@oblimint/shared';
import { apiKeyGuide } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { auditService } from '../audit.service';
import { filesService, joinVirtual, splitVirtual } from '../files/files.service';
import type { HostdFileStream } from '../hostd/files';
import { loadAccount, loadSite } from '../hosting/access';
import type { AccountRow, SiteRow } from '../hosting/rows';
import { domainsService } from '../hosting/domains.service';
import { sitesService } from '../hosting/sites.service';
import { releaseForActor } from '../hosting/statusMessage';
import { appConfigService } from '../appConfig.service';
import { cronService } from '../cron/cron.service';
import type { DataPathInputBody, DataPathUpdateBody } from '../../validators/hosting.schema';
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

/** "Blog.Example.com." → "blog.example.com" */
const normalizeName = (raw: unknown) => String(raw ?? '').trim().toLowerCase().replace(/\.$/, '');

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

interface RouteDomain { id: number; name: string; manageable: boolean; routes: ApiV1Route[] }

/**
 * Domains of the account with their path routes. A key manages the routes of
 * a domain only when every route of it leads to one of its sites (a key on
 * every site: any domain of the account) — it never takes a path of a domain
 * serving a site it cannot see.
 */
async function routeDomains(ctx: ApiKeyContext): Promise<RouteDomain[]> {
  const doms = await db('domains').where({ account_id: ctx.accountId }).select('id', 'name').orderBy('name') as Array<{ id: number; name: string }>;
  if (!doms.length) return [];
  const rows = await db('site_routes').whereIn('domain_id', doms.map((d) => d.id)).select('id', 'domain_id', 'path_prefix', 'site_id', 'runtime_id').orderBy('path_prefix') as
    Array<{ id: number; domain_id: number; path_prefix: string; site_id: number; runtime_id: number | null }>;
  return doms.map((d) => {
    const mine = rows.filter((r) => r.domain_id === d.id);
    const manageable = ctx.siteScope === 'all' || (mine.length > 0 && mine.every((r) => keyAllowsSite(ctx, r.site_id)));
    return {
      id: d.id, name: d.name, manageable,
      // A route to a site the key cannot see is shown without its site.
      routes: mine.map((r) => (keyAllowsSite(ctx, r.site_id)
        ? { id: r.id, domain: d.name, pathPrefix: r.path_prefix, siteId: r.site_id, runtimeId: r.runtime_id }
        : { id: r.id, domain: d.name, pathPrefix: r.path_prefix, siteId: 0, runtimeId: null })),
    };
  });
}

async function manageableDomain(ctx: ApiKeyContext, name: string): Promise<RouteDomain> {
  const d = (await routeDomains(ctx)).find((x) => x.name === String(name).trim().toLowerCase().replace(/\.$/, ''));
  if (!d) throw new AppError(404, 'Domain not found', 'notFound');
  if (!d.manageable) throw new AppError(403, 'This domain also serves sites outside this key: its routes are managed in the panel', 'keyDomainNotManageable');
  return d;
}

async function keyRoute(ctx: ApiKeyContext, routeId: number): Promise<{ domain: RouteDomain; route: ApiV1Route }> {
  for (const d of await routeDomains(ctx)) {
    const route = d.routes.find((r) => r.id === routeId);
    if (!route) continue;
    if (!d.manageable) throw new AppError(403, 'This domain also serves sites outside this key: its routes are managed in the panel', 'keyDomainNotManageable');
    return { domain: d, route };
  }
  throw new AppError(404, 'Route not found', 'notFound');
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

  /** The API / agent guide (shared/src/apiGuide.ts), with this panel's address in the commands. */
  async guide(req: Request, lang: ApiGuideLang): Promise<string> {
    const host = (await appConfigService.get('panel_hostname'))?.trim();
    return apiKeyGuide(lang, host ? `https://${host}` : `${req.protocol}://${req.get('host') ?? 'localhost'}`);
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

  /** Settings of a site (name, docroot, publication…): the panel's own checks (sites.update). */
  async updateSite(ctx: ApiKeyContext, req: Request, siteId: number, body: ApiV1SiteUpdate): Promise<ApiV1Site> {
    requireScope(ctx, 'sites.manage');
    const site = await keySite(ctx, siteId);
    await sitesService.update(req, ctx.actor, site.id, body);
    const [v] = await siteViews(ctx, [site.id]);
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

  // ── subdomains (scope domains.subdomain) ──
  /** Domains of the account a subdomain can be created under. */
  async parentDomains(ctx: ApiKeyContext): Promise<ApiV1ParentDomain[]> {
    requireScope(ctx, 'domains.subdomain');
    const rows = await db('domains as d')
      .leftJoin('dns_zones as z', function joinZone() { this.on('z.domain_id', '=', 'd.id').andOn('z.account_id', '=', 'd.account_id'); })
      .where('d.account_id', ctx.accountId)
      .select('d.name', 'd.verification_status', 'z.kind as zone_kind')
      .orderBy('d.name') as Array<{ name: string; verification_status: string | null; zone_kind: string | null }>;
    return rows.map((r) => ({ name: r.name, verified: r.verification_status === 'verified', hostedZone: r.zone_kind === 'hosted' }));
  },

  /** Subdomains this key created. */
  async subdomains(ctx: ApiKeyContext): Promise<ApiV1Subdomain[]> {
    requireScope(ctx, 'domains.subdomain');
    const rows = await db('api_key_domains as k').join('domains as d', 'd.id', 'k.domain_id')
      .leftJoin('site_routes as r', function joinRoute() { this.on('r.domain_id', '=', 'd.id').andOnVal('r.path_prefix', '=', '/'); })
      .where({ 'k.key_id': ctx.id, 'd.account_id': ctx.accountId })
      .select('d.id', 'd.name', 'd.verification_status', 'r.site_id') as Array<{ id: number; name: string; verification_status: string | null; site_id: number | null }>;
    return rows.map((r) => ({ id: r.id, name: r.name, siteId: r.site_id ?? 0, verified: r.verification_status === 'verified', url: `https://${r.name}/` }));
  },

  /**
   * Attaches a SUBDOMAIN of a domain already in the account to one of the
   * key's sites: never a new root domain (its DNS zone could not be set up
   * from here). The records go into the parent's hosted zone; a verified
   * parent makes it verified (certificate issued at once).
   */
  async addSubdomain(ctx: ApiKeyContext, req: Request, siteId: number, rawName: string): Promise<ApiV1Subdomain> {
    requireScope(ctx, 'domains.subdomain');
    const site = await keySite(ctx, siteId);
    const name = normalizeName(rawName);
    if (!/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(name)) {
      throw new AppError(400, 'Invalid domain name', 'invalidDomain');
    }
    const parents = await db('domains').where({ account_id: ctx.accountId }).pluck('name') as string[];
    const parent = parents.filter((p) => name.endsWith(`.${p}`)).sort((a, b) => b.length - a.length)[0];
    if (!parent) {
      throw new AppError(400, `Only a subdomain of a domain of the account can be attached (${parents.join(', ') || 'no domain yet'}): add new domains from the panel`, 'notASubdomain', { parents });
    }
    const domain = await domainsService.create(req, ctx.actor, {
      accountId: ctx.accountId, name, kind: 'subdomain', siteId: site.id, tlsMode: 'letsencrypt', forceHttps: true, includeWww: false,
    } as Parameters<typeof domainsService.create>[2]);
    await db('api_key_domains').insert({ key_id: ctx.id, domain_id: domain.id, account_id: ctx.accountId }).onConflict(['key_id', 'domain_id']).ignore();
    return { id: domain.id, name: domain.name, siteId: site.id, verified: domain.verification?.status === 'verified', url: `https://${domain.name}/` };
  },

  /** Removes a subdomain THIS key created (by name). */
  async removeSubdomain(ctx: ApiKeyContext, req: Request, rawName: string): Promise<void> {
    requireScope(ctx, 'domains.subdomain');
    const name = normalizeName(rawName);
    const row = await db('api_key_domains as k').join('domains as d', 'd.id', 'k.domain_id')
      .where({ 'k.key_id': ctx.id, 'd.account_id': ctx.accountId, 'd.name': name }).first('d.id') as { id: number } | undefined;
    if (!row) throw new AppError(404, 'Subdomain not found among the ones this key created', 'notFound');
    await domainsService.remove(req, ctx.actor, row.id);
  },

  // ── path routes of the domains (routes.manage) ──
  async routes(ctx: ApiKeyContext): Promise<ApiV1RouteDomain[]> {
    requireScope(ctx, 'routes.manage');
    const doms = await routeDomains(ctx);
    return doms.map((d) => ({ domain: d.name, manageable: d.manageable, routes: d.routes }));
  },

  async addRoute(ctx: ApiKeyContext, req: Request, domainName: string, pathPrefix: string, siteId: number, runtimeId: number | null = null): Promise<ApiV1Route> {
    requireScope(ctx, 'routes.manage');
    const d = await manageableDomain(ctx, domainName);
    await keySite(ctx, siteId);
    const r = await domainsService.addRoute(req, ctx.actor, d.id, { pathPrefix, siteId, runtimeId } as Parameters<typeof domainsService.addRoute>[3]);
    return { id: r.id, domain: d.name, pathPrefix: r.pathPrefix, siteId: r.siteId, runtimeId: r.runtimeId };
  },

  /** runtimeId: undefined keeps it when the site does not change, null = the site's main runtime. */
  async updateRoute(ctx: ApiKeyContext, req: Request, routeId: number, body: { pathPrefix?: string; siteId?: number; runtimeId?: number | null }): Promise<ApiV1Route> {
    requireScope(ctx, 'routes.manage');
    const { domain, route } = await keyRoute(ctx, routeId);
    const siteId = body.siteId ?? route.siteId;
    await keySite(ctx, siteId);
    const runtimeId = body.runtimeId !== undefined ? body.runtimeId : (siteId === route.siteId ? route.runtimeId : null);
    const r = await domainsService.updateRoute(req, ctx.actor, domain.id, route.id, { pathPrefix: body.pathPrefix ?? route.pathPrefix, siteId, runtimeId } as Parameters<typeof domainsService.updateRoute>[4]);
    return { id: r.id, domain: domain.name, pathPrefix: r.pathPrefix, siteId: r.siteId, runtimeId: r.runtimeId };
  },

  // ── secondary runtimes (sites.manage): another container / engine serving path prefixes of the same code ──
  async runtimes(ctx: ApiKeyContext, siteId: number): Promise<SiteRuntime[]> {
    const site = await keySite(ctx, siteId);
    return sitesService.listRuntimes(ctx.actor, site.id);
  },

  async addRuntime(ctx: ApiKeyContext, req: Request, siteId: number, base: SiteBaseId): Promise<SiteRuntime> {
    requireScope(ctx, 'sites.manage');
    const site = await keySite(ctx, siteId);
    return sitesService.addRuntime(req, ctx.actor, site.id, base);
  },

  async deleteRuntime(ctx: ApiKeyContext, req: Request, siteId: number, runtimeId: number): Promise<void> {
    requireScope(ctx, 'sites.manage');
    const site = await keySite(ctx, siteId);
    await sitesService.deleteRuntime(req, ctx.actor, site.id, runtimeId);
  },

  async deleteRoute(ctx: ApiKeyContext, req: Request, routeId: number): Promise<void> {
    requireScope(ctx, 'routes.manage');
    const { domain, route } = await keyRoute(ctx, routeId);
    await domainsService.deleteRoute(req, ctx.actor, domain.id, route.id);
  },

  // ── data paths (folders of the code the site writes to, kept in its data area) ──
  async dataPaths(ctx: ApiKeyContext, siteId: number): Promise<SiteDataPath[]> {
    const site = await keySite(ctx, siteId);
    return sitesService.listDataPaths(ctx.actor, site.id);
  },

  async addDataPath(ctx: ApiKeyContext, req: Request, siteId: number, body: DataPathInputBody): Promise<SiteDataPath> {
    requireScope(ctx, 'sites.manage');
    const site = await keySite(ctx, siteId);
    return sitesService.addDataPath(req, ctx.actor, site.id, body);
  },

  async updateDataPath(ctx: ApiKeyContext, req: Request, siteId: number, pathId: number, body: DataPathUpdateBody): Promise<SiteDataPath> {
    requireScope(ctx, 'sites.manage');
    const site = await keySite(ctx, siteId);
    return sitesService.updateDataPath(req, ctx.actor, site.id, pathId, body);
  },

  async deleteDataPath(ctx: ApiKeyContext, req: Request, siteId: number, pathId: number): Promise<void> {
    requireScope(ctx, 'sites.manage');
    const site = await keySite(ctx, siteId);
    await sitesService.deleteDataPath(req, ctx.actor, site.id, pathId);
  },

  // ── cron ──
  async cronJobs(ctx: ApiKeyContext, siteId: number): Promise<CronJob[]> {
    requireScope(ctx, 'cron.manage');
    const site = await keySite(ctx, siteId);
    return cronService.list(ctx.actor, site.id);
  },

  async createCronJob(ctx: ApiKeyContext, req: Request, siteId: number, body: CronJobInput): Promise<CronJob> {
    requireScope(ctx, 'cron.manage');
    const site = await keySite(ctx, siteId);
    return cronService.create(req, ctx.actor, site.id, body);
  },

  async updateCronJob(ctx: ApiKeyContext, req: Request, siteId: number, jobId: number, body: Partial<CronJobInput>): Promise<CronJob> {
    requireScope(ctx, 'cron.manage');
    const site = await keySite(ctx, siteId);
    return cronService.update(req, ctx.actor, site.id, jobId, body);
  },

  async deleteCronJob(ctx: ApiKeyContext, req: Request, siteId: number, jobId: number): Promise<void> {
    requireScope(ctx, 'cron.manage');
    const site = await keySite(ctx, siteId);
    await cronService.remove(req, ctx.actor, site.id, jobId);
  },

  async runCronJob(ctx: ApiKeyContext, req: Request, siteId: number, jobId: number): Promise<CronRun> {
    requireScope(ctx, 'cron.manage');
    const site = await keySite(ctx, siteId);
    return cronService.runNow(req, ctx.actor, site.id, jobId);
  },

  async cronRuns(ctx: ApiKeyContext, siteId: number, jobId: number, limit: number, offset: number): Promise<{ items: CronRun[]; total: number }> {
    requireScope(ctx, 'cron.manage');
    const site = await keySite(ctx, siteId);
    return cronService.runs(ctx.actor, site.id, jobId, { limit, offset });
  },

  /** One run with its output. */
  async cronRun(ctx: ApiKeyContext, siteId: number, runId: number): Promise<CronRunDetail> {
    requireScope(ctx, 'cron.manage');
    const site = await keySite(ctx, siteId);
    return cronService.run(ctx.actor, site.id, runId);
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
