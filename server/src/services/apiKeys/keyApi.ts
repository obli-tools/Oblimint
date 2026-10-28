import type { Request } from 'express';
import type { Readable } from 'stream';
import type {
  ApiV1Me, ApiV1ParentDomain, ApiV1Site, ApiV1SiteUpdate, ApiV1Subdomain, FileExtractResult, FileListing, FileOpResult, FileText, FileUploadChunkResult, FileUploadSession, LogQueryResult, Release,
  PreviewFetchResult, PreviewLink, PreviewStartResult, SitePreview,
  ReleaseFileContent, ReleaseFileList, SiteCreate, StagingRestoreResult, StagingRestoreRunning, StagingStatus, ApiGuideLang, ApiV1Route, ApiV1RouteDomain, SiteBaseId, SiteRuntime, CronJob, CronJobInput, CronRun, CronRunDetail, SiteDataPath,
} from '@oblimint/shared';
import { apiKeyGuide } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { auditService } from '../audit.service';
import { filesService, joinVirtual, splitVirtual } from '../files/files.service';
import type { HostdFileStream } from '../hostd/files';
import { assertReadsCode, loadAccount, loadSite } from '../hosting/access';
import type { AccountRow, SiteRow } from '../hosting/rows';
import { domainsService } from '../hosting/domains.service';
import { sitesService } from '../hosting/sites.service';
import { clientStatusMessage, releaseForActor } from '../hosting/statusMessage';
import { appConfigService } from '../appConfig.service';
import { publicPanelOrigin } from '../panelHosts';
import { cronService } from '../cron/cron.service';
import type { DataPathInputBody, DataPathUpdateBody } from '../../validators/hosting.schema';
import { assertSource, logsService } from '../logs/logs.service';
import { releaseService } from '../releases/release.service';
import { liveStates } from '../releases/liveState';
import { previewService } from '../previews/previews.service';
import { apiKeysService, keyAllowsDomain, keyAllowsSite, requireScope, type ApiKeyContext } from './apiKeys.service';

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

/** previews.manage, and files.read (a preview runs and shows the code): 403 codeReadForbidden with a hint otherwise. */
function previewScopes(ctx: ApiKeyContext): void {
  requireScope(ctx, 'previews.manage');
  try {
    requireScope(ctx, 'files.read');
  } catch {
    throw new AppError(403, 'Previews need the files.read scope too (the preview runs and shows the code)', 'codeReadForbidden', { hint: 'needs files.read too' });
  }
}

/** A site of the key (404 outside its selection or its account). */
export async function keySite(ctx: ApiKeyContext, siteId: number): Promise<SiteRow> {
  if (!Number.isInteger(siteId) || siteId <= 0 || !keyAllowsSite(ctx, siteId)) throw new AppError(404, 'Site not found', 'notFound');
  const site = await loadSite(ctx.actor, siteId, 'read');
  if (site.account_id !== ctx.accountId) throw new AppError(404, 'Site not found', 'notFound');
  return site;
}

interface RouteDomain { id: number; name: string; manageable: boolean; routes: ApiV1Route[] }

const NOT_MANAGEABLE = 'This domain is not given to this key and serves other sites (or none yet): give it to the key in the panel (Access keys › Domains), or route it there';
const ROUTE_OUTSIDE = 'This route leads to a site outside this key: only the panel changes or removes it';

/**
 * A domain the key works on without it being given (L20): every route of it
 * leads to a site of a key limited to some sites. A key on every site gets
 * no domain this way: its domains are the ones given to it (domainScope).
 */
function servesOnlyKeySites(ctx: ApiKeyContext, routes: Array<{ site_id: number }>): boolean {
  return ctx.siteScope === 'selected' && routes.length > 0 && routes.every((r) => keyAllowsSite(ctx, r.site_id));
}

/**
 * Domains of the account with their path routes. A key manages the routes of
 * a domain given to it (Domains of the key: one, several or all), and of a
 * domain whose routes all lead to its sites (servesOnlyKeySites) — never a
 * path of another domain serving a site it cannot see. The routes always
 * lead to its own sites (keySite), and a route of a given domain towards a
 * site outside the key stays as it is (keyRoute, L20).
 */
async function routeDomains(ctx: ApiKeyContext): Promise<RouteDomain[]> {
  const doms = await db('domains').where({ account_id: ctx.accountId }).select('id', 'name').orderBy('name') as Array<{ id: number; name: string }>;
  if (!doms.length) return [];
  const rows = await db('site_routes').whereIn('domain_id', doms.map((d) => d.id)).select('id', 'domain_id', 'path_prefix', 'site_id', 'runtime_id').orderBy('path_prefix') as
    Array<{ id: number; domain_id: number; path_prefix: string; site_id: number; runtime_id: number | null }>;
  return doms.map((d) => {
    const mine = rows.filter((r) => r.domain_id === d.id);
    const manageable = keyAllowsDomain(ctx, d.id) || servesOnlyKeySites(ctx, mine);
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
  if (!d.manageable) throw new AppError(403, NOT_MANAGEABLE, 'keyDomainNotManageable');
  return d;
}

/** A route the key may change or remove: on a manageable domain, and towards one of its sites (L20). */
async function keyRoute(ctx: ApiKeyContext, routeId: number): Promise<{ domain: RouteDomain; route: ApiV1Route }> {
  for (const d of await routeDomains(ctx)) {
    const route = d.routes.find((r) => r.id === routeId);
    if (!route) continue;
    if (!d.manageable) throw new AppError(403, NOT_MANAGEABLE, 'keyDomainNotManageable');
    if (route.siteId === 0) throw new AppError(403, ROUTE_OUTSIDE, 'keyRouteOutside');
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

/**
 * Domains a subdomain can be created under (L19): the ones given to the key
 * (and the subdomains it created), or serving only its sites — the same rule
 * as the routes. A key on every site gets parents only by being given them.
 */
async function parentIds(ctx: ApiKeyContext): Promise<Set<number>> {
  const doms = await db('domains').where({ account_id: ctx.accountId }).pluck('id') as number[];
  if (!doms.length) return new Set();
  const routes = await db('site_routes').whereIn('domain_id', doms).select('domain_id', 'site_id') as Array<{ domain_id: number; site_id: number }>;
  return new Set(doms.map(Number).filter((id) => keyAllowsDomain(ctx, id) || servesOnlyKeySites(ctx, routes.filter((r) => Number(r.domain_id) === id))));
}

async function filesAccount(ctx: ApiKeyContext, write: boolean): Promise<AccountRow> {
  requireScope(ctx, write ? 'files.write' : 'files.read');
  return loadAccount(ctx.actor, ctx.accountId, 'files.manage');
}

/**
 * Audit of a file write through the key (M13): the same actions and details
 * as the panel's explorer (files.routes.ts: virtual paths), plus the site;
 * logReqAs files it under the key's user with the key (apiKey {id, name}).
 */
function fileAudit(req: Request, a: AccountRow, siteId: number | null, action: string, details: Record<string, unknown>): Promise<void> {
  return auditService.logReqAs(req, a.tenant_id, action, {
    resourceType: 'account', resourcePath: String(a.id), details: { username: a.username, ...(siteId ? { siteId } : {}), ...details },
  });
}

/** A release id given by the caller: a positive integer, else 404 (never a 500 on NaN). */
export function releaseIdOf(n: unknown): number {
  const v = typeof n === 'string' && /^\d+$/.test(n) ? Number(n) : n;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new AppError(404, 'Release not found', 'notFound');
  return v;
}

/** Users who are not members of the account (platform staff): their name is never shown to a key. */
async function nonMembers(accountId: number, userIds: Array<number | null | undefined>): Promise<Set<number>> {
  const ids = [...new Set(userIds.filter((v): v is number => typeof v === 'number' && v > 0))];
  if (!ids.length) return new Set();
  const rows = await db('users as u').leftJoin('account_users as au', function joinMember() { this.on('au.user_id', '=', 'u.id').andOnVal('au.account_id', '=', accountId); })
    .whereIn('u.id', ids).select('u.id', 'u.kind', 'au.user_id as member') as Array<{ id: number; kind: string; member: number | null }>;
  return new Set(rows.filter((r) => r.kind === 'staff' || r.member === null).map((r) => Number(r.id)));
}

/** Paths in an audit entry: the first 50 of a batch. */
const sample = (paths: string[]) => (paths.length > 50 ? [...paths.slice(0, 50), `… +${paths.length - 50}`] : paths);

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
  const states = await liveStates(rows.map((r) => r.id));
  const client = ctx.actor.kind === 'client';
  return rows.map((r) => {
    const mine = doms.filter((d) => d.site_id === r.id);
    const primary = mine.find((d) => d.path_prefix === '/') ?? mine[0];
    const st = states.get(r.id);
    const revert = st?.via === 'revert';
    return {
      id: r.id, name: r.name, slug: r.slug, status: r.status, base: r.base, docroot: r.docroot, publishMode: r.publish_mode,
      primaryDomain: primary?.name ?? null, domains: [...new Set(mine.map((d) => d.name))], currentRelease: r.release_number ?? null,
      createdByKey: created.has(r.id),
      liveRelease: st?.live ? {
        id: st.live.id, number: st.live.number, since: st.since, via: st.via,
        by: st.byStaff || revert ? null : st.byName,
        byKind: revert ? 'system' : st.byStaff ? 'staff' : st.byUserId ? 'user' : null,
        byThisKey: st.keyId === ctx.id,
        reason: revert ? (client ? clientStatusMessage(st.reason) : st.reason) : null,
      } : null,
      latestRelease: st?.latest ? { id: st.latest.id, number: st.latest.number, publishedAt: st.latest.publishedAt } : null,
      rolledBack: st?.rolledBack ?? false,
      rolledBackFrom: st?.rolledBackFrom ? { id: st.rolledBackFrom.id, number: st.rolledBackFrom.number } : null,
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
    return apiKeyGuide(lang, (await publicPanelOrigin(req)) ?? `${req.protocol}://${req.get('host') ?? 'localhost'}`);
  },

  listSites: (ctx: ApiKeyContext) => siteViews(ctx, null),

  async getSite(ctx: ApiKeyContext, siteId: number): Promise<ApiV1Site> {
    await keySite(ctx, siteId);
    const [v] = await siteViews(ctx, [siteId]);
    if (!v) throw new AppError(404, 'Site not found', 'notFound');
    return v;
  },

  /** Without the releases.publish scope the site starts in manual (sitesService: 'auto' takes releases.publish). */
  async createSite(ctx: ApiKeyContext, req: Request, body: Omit<SiteCreate, 'accountId'>): Promise<ApiV1Site> {
    requireScope(ctx, 'sites.create');
    if (body.publishMode === 'auto') requireScope(ctx, 'releases.publish');
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
    // Switching to 'auto' publishes every later write: the releases.publish scope too.
    if (body.publishMode === 'auto' && site.publish_mode !== 'auto') requireScope(ctx, 'releases.publish');
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

  async putFile(ctx: ApiKeyContext, req: Request, siteId: number, area: SiteArea, path: string, size: number, body: Readable, overwrite: boolean): Promise<string> {
    const a = await filesAccount(ctx, true);
    const site = await keySite(ctx, siteId);
    const p = await filesService.putSmall(a, { path: areaPath(site, area, path), size, overwrite }, body);
    await fileAudit(req, a, site.id, 'files.upload', { path: p, size });
    return relOf(site, area, p);
  },

  async uploadStart(ctx: ApiKeyContext, siteId: number, area: SiteArea, path: string, size: number, overwrite: boolean): Promise<FileUploadSession> {
    const a = await filesAccount(ctx, true);
    const site = await keySite(ctx, siteId);
    return filesService.uploadStart(a, ctx.creatorId, { path: areaPath(site, area, path), size, overwrite });
  },

  async uploadChunk(ctx: ApiKeyContext, req: Request, uploadId: string, index: number, length: number, body: Readable): Promise<FileUploadChunkResult> {
    const a = await filesAccount(ctx, true);
    const info = filesService.uploadInfo(uploadId);
    const res = await filesService.uploadChunk(a, ctx.creatorId, uploadId, index, length, body);
    // One entry per uploaded file (the chunk that completed it), as in the panel.
    if (res.done && info) await fileAudit(req, a, null, 'files.upload', info);
    return res;
  },

  async mkdir(ctx: ApiKeyContext, req: Request, siteId: number, area: SiteArea, path: string): Promise<string> {
    const a = await filesAccount(ctx, true);
    const site = await keySite(ctx, siteId);
    const created = await filesService.mkdir(a, areaPath(site, area, path));
    await fileAudit(req, a, site.id, 'files.mkdir', { path: created });
    return relOf(site, area, created);
  },

  async remove(ctx: ApiKeyContext, req: Request, siteId: number, area: SiteArea, paths: string[]): Promise<FileOpResult[]> {
    const a = await filesAccount(ctx, true);
    const site = await keySite(ctx, siteId);
    const res = await filesService.remove(a, paths.map((p) => areaPath(site, area, p)));
    const done = res.filter((r) => r.ok).map((r) => r.path);
    if (done.length) await fileAudit(req, a, site.id, 'files.delete', { paths: sample(done) });
    return res.map((r) => ({ ...r, path: relOf(site, area, r.path) }));
  },

  async move(ctx: ApiKeyContext, req: Request, siteId: number, area: SiteArea, items: Array<{ from: string; to: string }>, overwrite: boolean, copy = false): Promise<FileOpResult[]> {
    const a = await filesAccount(ctx, true);
    const site = await keySite(ctx, siteId);
    const mapped = items.map((i) => ({ from: areaPath(site, area, i.from), to: areaPath(site, area, i.to) }));
    const res = copy ? await filesService.copy(a, mapped) : await filesService.move(a, mapped, overwrite);
    const done = mapped.filter((_, i) => res[i]?.ok).map((i) => `${i.from} → ${i.to}`);
    if (done.length) await fileAudit(req, a, site.id, copy ? 'files.copy' : 'files.move', { items: sample(done), ...(copy ? {} : { overwrite }) });
    return res.map((r) => ({ ...r, path: relOf(site, area, r.path) }));
  },

  async extract(ctx: ApiKeyContext, req: Request, siteId: number, area: SiteArea, path: string, to: string | undefined, overwrite: boolean): Promise<FileExtractResult> {
    const a = await filesAccount(ctx, true);
    const site = await keySite(ctx, siteId);
    const archive = areaPath(site, area, path);
    const target = to === undefined ? undefined : areaPath(site, area, to);
    const res = await filesService.extract(a, archive, target, overwrite);
    await fileAudit(req, a, site.id, 'files.extract', { path: archive, to: target ?? null, overwrite, files: res.files, bytes: res.bytes });
    return res;
  },

  // ── releases ──
  /**
   * Publishes the staging. Refused (409 liveRolledBack) while it still holds
   * files of a release a human rolled back from, unless overrideRollback (the
   * human asked for it): audited.
   */
  async publish(ctx: ApiKeyContext, req: Request, siteId: number, message: string | null, opts: { overrideRollback?: boolean } = {}): Promise<Release> {
    requireScope(ctx, 'releases.publish');
    const site = await keySite(ctx, siteId);
    await loadSite(ctx.actor, site.id, 'releases.publish');
    const release = await releaseService.publish(site.id, {
      trigger: 'manual', userId: ctx.creatorId, message, apiKeyId: ctx.id, rollbackGuard: opts.overrideRollback ? 'off' : 'refuse',
    });
    await auditService.logReqAs(req, site.tenant_id, 'release.publish', {
      resourceType: 'release', resourcePath: String(release.id),
      details: { siteId: site.id, number: release.number, ...(opts.overrideRollback ? { overrideRollback: true } : {}) },
    });
    return release;
  },

  /** Releases, newest first; the name of a platform staff member is never shown (author, approver). */
  async releases(ctx: ApiKeyContext, siteId: number, limit: number, offset: number): Promise<{ items: Release[]; total: number }> {
    const site = await keySite(ctx, siteId);
    const page = await releaseService.list(site.id, { limit, offset } as Parameters<typeof releaseService.list>[1]);
    const ids = page.items.map((r) => r.id);
    const approvers = ids.length ? await db('releases').whereIn('id', ids).select('id', 'approved_by') as Array<{ id: number; approved_by: number | null }> : [];
    const approverOf = new Map(approvers.map((a) => [Number(a.id), a.approved_by]));
    const hidden = await nonMembers(site.account_id, [...page.items.map((r) => r.authorUserId), ...approvers.map((a) => a.approved_by)]);
    return {
      ...page,
      items: page.items.map((r) => {
        const out = releaseForActor(ctx.actor, r);
        const approver = approverOf.get(r.id);
        return {
          ...out,
          ...(r.authorUserId && hidden.has(r.authorUserId) ? { authorName: null } : {}),
          ...(approver && hidden.has(Number(approver)) ? { approvedBy: null } : {}),
        };
      }),
    };
  },

  async rollback(ctx: ApiKeyContext, req: Request, siteId: number, releaseId: unknown): Promise<void> {
    requireScope(ctx, 'releases.publish');
    const site = await keySite(ctx, siteId);
    const rid = releaseIdOf(releaseId);
    await loadSite(ctx.actor, site.id, 'releases.publish');
    await releaseService.rollback(site.id, rid, ctx.creatorId, { apiKeyId: ctx.id });
    await auditService.logReqAs(req, site.tenant_id, 'release.rollback', { resourceType: 'release', resourcePath: String(rid), details: { siteId: site.id } });
  },

  // ── files of a release (read from git; files.read + the code right) ──
  async releaseFiles(ctx: ApiKeyContext, siteId: number, releaseId: unknown, path: unknown, limit: number, offset: number, maxChars?: number): Promise<ReleaseFileList> {
    await filesAccount(ctx, false);
    const site = await keySite(ctx, siteId);
    assertReadsCode(ctx.actor, site);
    return releaseService.releaseFiles(site.id, releaseIdOf(releaseId), { path, limit, offset, maxChars });
  },

  async releaseFile(ctx: ApiKeyContext, siteId: number, releaseId: unknown, path: unknown, opts: { encoding?: 'utf8' | 'base64'; offset?: number; maxBytes?: number } = {}): Promise<ReleaseFileContent> {
    await filesAccount(ctx, false);
    const site = await keySite(ctx, siteId);
    assertReadsCode(ctx.actor, site);
    return releaseService.releaseFile(site.id, releaseIdOf(releaseId), { path, ...opts });
  },

  async releaseFileStream(ctx: ApiKeyContext, siteId: number, releaseId: unknown, path: unknown): ReturnType<typeof releaseService.releaseFileStream> {
    await filesAccount(ctx, false);
    const site = await keySite(ctx, siteId);
    assertReadsCode(ctx.actor, site);
    return releaseService.releaseFileStream(site.id, releaseIdOf(releaseId), path);
  },

  /** Copies a published release into the staging (files.write; never publishes). Audited, also when it goes on in the background. */
  async restoreReleaseToStaging(ctx: ApiKeyContext, req: Request, siteId: number, releaseId: unknown, opts: { discardPending?: boolean } = {}): Promise<StagingRestoreResult | StagingRestoreRunning> {
    await filesAccount(ctx, true);
    const site = await keySite(ctx, siteId);
    assertReadsCode(ctx.actor, site);
    const rid = releaseIdOf(releaseId);
    const discardPending = opts.discardPending === true;
    const r = await releaseService.restoreToStaging(site.id, rid, { userId: ctx.creatorId, apiKeyId: ctx.id, discardPending });
    await auditService.logReqAs(req, site.tenant_id, 'release.restoreToStaging', {
      resourceType: 'release', resourcePath: String(rid),
      details: r.status === 'done'
        ? { siteId: site.id, number: r.releaseNumber, written: r.written, deleted: r.deleted, conflicts: sample(r.conflicts), remaining: r.remaining, modeLost: r.modeLostCount, discardPending, previousStagingCommit: r.previousStagingCommit, status: r.status }
        : { siteId: site.id, number: r.releaseNumber, discardPending, previousStagingCommit: r.previousStagingCommit, status: r.status },
    });
    return r;
  },

  // ── live previews (feature B: scope previews.manage + files.read; staging: + releases.publish) ──
  /**
   * Starts a preview of a release (releaseId) or of a scanned snapshot of the
   * staging. wait: polls until running / failed (≤ 25 s). include_key: the gate
   * header (audited preview.key). Never options that weaken the isolation, never
   * unapproved code on a site in approval mode (a key has no releases.approve).
   */
  async previewStart(ctx: ApiKeyContext, req: Request, siteId: number, body: {
    releaseId?: number | null; staging?: boolean; ttlMinutes?: number | null; wait?: boolean; includeKey?: boolean;
  }): Promise<PreviewStartResult> {
    previewScopes(ctx);
    const site = await keySite(ctx, siteId);
    const staging = body.staging === true;
    if (staging === (body.releaseId !== undefined && body.releaseId !== null)) {
      throw new AppError(400, 'Give either release_id or staging: true', 'validation');
    }
    if (staging) requireScope(ctx, 'releases.publish');
    const r = await previewService.start(req, ctx.actor, site.id, {
      target: staging ? 'staging' : 'release', releaseId: body.releaseId ?? null, ttlMinutes: body.ttlMinutes ?? null, options: null,
    }, { keyId: ctx.id, includeKey: body.includeKey === true, withLink: true });
    if (body.wait === false) return r;
    for (let waited = 0; waited < 25_000; waited += 500) {
      const p = await previewService.get(ctx.actor, site.id);
      if (!p || p.id !== r.preview.id) break;
      r.preview = p;
      if (p.status !== 'building' && p.status !== 'starting') break;
      await new Promise((ok) => setTimeout(ok, 500));
    }
    return r;
  },

  async previewGet(ctx: ApiKeyContext, siteId: number): Promise<SitePreview | null> {
    requireScope(ctx, 'previews.manage');
    const site = await keySite(ctx, siteId);
    return previewService.get(ctx.actor, site.id);
  },

  async previewStop(ctx: ApiKeyContext, req: Request, siteId: number): Promise<{ stopped: true }> {
    previewScopes(ctx);
    const site = await keySite(ctx, siteId);
    return previewService.stop(req, ctx.actor, site.id);
  },

  /** One-shot share link (interstitial page): the key's creator needs sites.manage on the account (decision 9). */
  async previewLink(ctx: ApiKeyContext, req: Request, siteId: number): Promise<PreviewLink> {
    previewScopes(ctx);
    const site = await keySite(ctx, siteId);
    return previewService.shareLink(req, ctx.actor, site.id, ctx.id);
  },

  async previewFetch(ctx: ApiKeyContext, siteId: number, q: {
    path: unknown; compare?: boolean; host?: 'preview' | 'live' | null; maxBytes?: number | null; method?: 'GET' | 'HEAD' | null;
  }): Promise<PreviewFetchResult> {
    previewScopes(ctx);
    if (q.compare) requireScope(ctx, 'sites.manage');
    const site = await keySite(ctx, siteId);
    return previewService.fetch(ctx.actor, site.id, q);
  },

  // ── subdomains (scope domains.subdomain) ──
  /** Domains of the account a subdomain can be created under (parentIds: given to the key, or serving only its sites). */
  async parentDomains(ctx: ApiKeyContext): Promise<ApiV1ParentDomain[]> {
    requireScope(ctx, 'domains.subdomain');
    const allowed = await parentIds(ctx);
    const rows = await db('domains as d')
      .leftJoin('dns_zones as z', function joinZone() { this.on('z.domain_id', '=', 'd.id').andOn('z.account_id', '=', 'd.account_id'); })
      .where('d.account_id', ctx.accountId)
      .select('d.id', 'd.name', 'd.verification_status', 'z.kind as zone_kind')
      .orderBy('d.name') as Array<{ id: number; name: string; verification_status: string | null; zone_kind: string | null }>;
    return rows.filter((r) => allowed.has(Number(r.id))).map((r) => ({ name: r.name, verified: r.verification_status === 'verified', hostedZone: r.zone_kind === 'hosted' }));
  },

  /** Subdomains this key created. */
  async subdomains(ctx: ApiKeyContext): Promise<ApiV1Subdomain[]> {
    requireScope(ctx, 'domains.subdomain');
    const rows = await db('api_key_domains as k').join('domains as d', 'd.id', 'k.domain_id')
      .leftJoin('site_routes as r', function joinRoute() { this.on('r.domain_id', '=', 'd.id').andOnVal('r.path_prefix', '=', '/'); })
      .where({ 'k.key_id': ctx.id, 'k.created_by_key': true, 'd.account_id': ctx.accountId })
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
    const allowed = await parentIds(ctx);
    const doms = await db('domains').where({ account_id: ctx.accountId }).select('id', 'name') as Array<{ id: number; name: string }>;
    const parents = doms.filter((d) => allowed.has(Number(d.id))).map((d) => d.name).sort();
    // The closest domain of the account above the name: it must be one of the key's parents (L19).
    const parent = doms.filter((d) => name.endsWith(`.${d.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
    if (!parent) {
      throw new AppError(400, `Only a subdomain of a domain of the account can be attached (${parents.join(', ') || 'no domain for this key'}): add new domains from the panel`, 'notASubdomain', { parents });
    }
    if (!allowed.has(Number(parent.id))) {
      throw new AppError(403, `${parent.name} is not given to this key and serves other sites (or none yet): give it to the key in the panel (Access keys › Domains), or use one of ${parents.join(', ') || 'its domains (none yet)'}`, 'keyDomainNotManageable', { parents });
    }
    const domain = await domainsService.create(req, ctx.actor, {
      accountId: ctx.accountId, name, kind: 'subdomain', siteId: site.id, tlsMode: 'letsencrypt', forceHttps: true, includeWww: false,
    } as Parameters<typeof domainsService.create>[2]);
    await db('api_key_domains').insert({ key_id: ctx.id, domain_id: domain.id, account_id: ctx.accountId, created_by_key: true }).onConflict(['key_id', 'domain_id']).merge({ created_by_key: true });
    return { id: domain.id, name: domain.name, siteId: site.id, verified: domain.verification?.status === 'verified', url: `https://${domain.name}/` };
  },

  /**
   * Removes a subdomain THIS key created (by name). Its routes go with it: one
   * the panel pointed since at a site outside the key keeps the whole domain
   * (L20, as keyRoute does for a single route).
   */
  async removeSubdomain(ctx: ApiKeyContext, req: Request, rawName: string): Promise<void> {
    requireScope(ctx, 'domains.subdomain');
    const name = normalizeName(rawName);
    const row = await db('api_key_domains as k').join('domains as d', 'd.id', 'k.domain_id')
      .where({ 'k.key_id': ctx.id, 'k.created_by_key': true, 'd.account_id': ctx.accountId, 'd.name': name }).first('d.id') as { id: number } | undefined;
    if (!row) throw new AppError(404, 'Subdomain not found among the ones this key created', 'notFound');
    const routes = await db('site_routes').where({ domain_id: row.id }).select('site_id') as Array<{ site_id: number }>;
    if (routes.some((r) => !keyAllowsSite(ctx, Number(r.site_id)))) throw new AppError(403, ROUTE_OUTSIDE, 'keyRouteOutside');
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
