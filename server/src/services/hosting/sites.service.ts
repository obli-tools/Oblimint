import type { Request } from 'express';
import type { AppProfileId, PhpSettings, PlanLimits, Site, SiteBaseId, SiteDataPath, SiteRoute, SiteRuntime } from '@oblimint/shared';
import { APP_PROFILES, HostingSocketEvents, appProfileDef, isSiteBaseId, normalizePathPrefix, normalizeRelPath } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import type { DataPathInputBody, DataPathUpdateBody, SiteCreateBody, SiteUpdateBody } from '../../validators/hosting.schema';
import { appConfigService } from '../appConfig.service';
import { auditService } from '../audit.service';
import { reconcileService } from '../docker/reconcile.service';
import { edgeService } from '../edge/edge.service';
import { releaseService } from '../releases/release.service';
import { actorCan, assertNeedSomewhere, loadAccount, loadSite, scopeToActor, type HostingActor } from './access';
import { DELETION_FAILED_MESSAGE, accountDeleting, backendUnavailable, siteSnapshots } from './accounts.service';
import { envelopeService, withTenantLock } from './envelope.service';
import { siteDeletions } from './deletions';
import { forActor } from './statusMessage';
import { emitHosting } from './events';
import {
  MAX_DATA_PATHS_PER_SITE, MAX_RUNTIMES_PER_SITE, customNginxError, dataPathContainsDocroot, dataPathForbiddenError, findDataPathOverlap, isUniqueViolation, phpSettingsError,
} from './hostingValidation.service';
import { previewHost } from './naming';
import { platformSettings } from '../platformSettings';
import {
  json, planLimits, toSite, toSiteDataPath, toSiteRoute,
  type AccountRow, type DataPathRow, type RouteRow, type SiteRow, type SiteRuntimeRow,
} from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// Sites of a hosting account: catalog base + app profile, data paths (the
// only writable parts of a release, ARCHITECTURE §2.1), secondary runtimes
// (another engine on a path prefix of the SAME release, §3.1 bis), and the
// routes that target the site. Data-path changes reach the container config
// through the reconcile. An ADDED path gets its release link at the next
// publish (its rules are stricter meanwhile); a DELETED path, or one becoming
// typed, first rebuilds the live release (releaseService.applyDataPathChange):
// the old rules stay until the live tree matches the new ones.
// ─────────────────────────────────────────────────────────────────────────────

/** Sites with the joins toSite needs (account username, current release number, primary domain). */
export function selectSites() {
  return db('sites as s')
    .join('hosting_accounts as a', 'a.id', 's.account_id')
    .leftJoin('releases as r', 'r.id', 's.current_release_id')
    .leftJoin('releases as rf', 'rf.id', 's.rolled_back_from_release_id')
    .leftJoin('users as cu', 'cu.id', 's.current_release_by')
    .select('s.*', 'a.username as account_username', 'r.number as current_release_number', 'rf.number as rolled_back_from_number',
      db.raw('COALESCE(cu.display_name, cu.username) as current_release_by_name'),
      db.raw(`(SELECT d.name FROM site_routes sr JOIN domains d ON d.id = sr.domain_id
               WHERE sr.site_id = s.id ORDER BY (sr.path_prefix = '/') DESC, sr.id ASC LIMIT 1) AS primary_domain`));
}

export function selectRoutes() {
  return db('site_routes as sr')
    .join('domains as d', 'd.id', 'sr.domain_id')
    .join('sites as s', 's.id', 'sr.site_id')
    .leftJoin('site_runtimes as rt', 'rt.id', 'sr.runtime_id')
    .select('sr.*', 'd.name as domain_name', 's.name as site_name', 'rt.base as runtime_base');
}

/** P2: previews live on the dedicated preview domain (settings preview.previewDomain), never under the panel host. */
async function panelHostname(): Promise<string | null> {
  try { return (await platformSettings.section('preview')).previewDomain; } catch { return null; }
}

function mapSite(row: SiteRow, previewDomain: string | null): Site {
  const previewUrl = row.preview_base && previewDomain ? `https://${previewHost(row, previewDomain)}` : null;
  return toSite(row, { previewUrl });
}

export async function fetchSite(siteId: number): Promise<Site> {
  const [row, panel] = await Promise.all([selectSites().where('s.id', siteId).first() as Promise<SiteRow | undefined>, panelHostname()]);
  if (!row) throw new AppError(404, 'Site not found', 'notFound');
  return mapSite(row, panel);
}

function emitSite(site: { id: number; tenant_id: number; account_id: number }, action: 'created' | 'updated' | 'deleted'): void {
  emitHosting(HostingSocketEvents.HOSTING_CHANGED, { entity: 'site', id: site.id, accountId: site.account_id, action },
    { tenantId: site.tenant_id, accountId: site.account_id });
}

function requestSite(siteId: number, reason: string): void {
  try { reconcileService.requestSite(siteId, reason); } catch (err) { logger.warn({ err, siteId, reason }, 'reconcileService.requestSite failed'); }
}

function requestAccount(accountId: number, reason: string): void {
  try { reconcileService.requestAccount(accountId, reason); } catch (err) { logger.warn({ err, accountId, reason }, 'reconcileService.requestAccount failed'); }
}

function scheduleEdgeSync(reason: string): void {
  try { edgeService.scheduleSync(reason); } catch (err) { logger.warn({ err, reason }, 'edgeService.scheduleSync failed'); }
}

async function planOf(account: Pick<AccountRow, 'plan_id'>): Promise<PlanLimits> {
  const plan = await db('plans').where({ id: account.plan_id }).first('limits') as { limits: unknown } | undefined;
  return planLimits(plan?.limits);
}

function assertBaseAllowed(plan: PlanLimits, base: SiteBaseId): void {
  if (plan.allowedBases && !plan.allowedBases.includes(base)) {
    throw new AppError(409, `The plan does not allow the base ${base}`, 'baseNotAllowed', { base, allowedBases: plan.allowedBases });
  }
}

/**
 * The fields of a site creation / update the services rely on, checked again
 * here whatever the caller validated (routes, /api/v1, MCP, migrations): an
 * unknown base or profile would leave a site stuck in 'provisioning', a
 * docroot such as "./public" would slip past dataPathContainsDocroot.
 * Returns the normalized docroot / basePath (undefined when not given).
 */
function checkedSiteFields(body: { base?: unknown; appProfile?: unknown; docroot?: unknown; basePath?: unknown; publishMode?: unknown }): { docroot?: string; basePath?: string } {
  const invalid = (field: string, message: string) => new AppError(400, `Validation failed — ${field}: ${message}`, 'validation', { [field]: [message] });
  if (body.base !== undefined && !isSiteBaseId(body.base)) throw invalid('base', 'Unknown site base');
  if (body.appProfile !== undefined && body.appProfile !== null && !APP_PROFILES.some((p) => p.id === body.appProfile)) {
    throw invalid('appProfile', 'Unknown application profile');
  }
  if (body.publishMode !== undefined && !['auto', 'manual', 'approval'].includes(String(body.publishMode))) throw invalid('publishMode', 'auto, manual or approval');
  const out: { docroot?: string; basePath?: string } = {};
  if (body.docroot !== undefined) {
    const n = typeof body.docroot === 'string' ? normalizeRelPath(body.docroot, true) : null;
    if (n === null) throw invalid('docroot', 'Relative path of [A-Za-z0-9._@+-] segments, without "..", "." or empty segments');
    out.docroot = n;
  }
  if (body.basePath !== undefined) {
    const n = typeof body.basePath === 'string' ? normalizePathPrefix(body.basePath) : null;
    if (n === null) throw invalid('basePath', 'Path prefix such as / or /shop/');
    out.basePath = n;
  }
  return out;
}

/** M6: 'auto' publishes every staging change without anyone clicking: it takes releases.publish (a key: its scope). */
function publishRequired(): AppError {
  return new AppError(403, 'Automatic publication requires the right to publish releases', 'publishRequired');
}

async function audit(req: Request, site: { id: number; tenant_id: number; slug: string; account_id: number }, action: string, details: Record<string, unknown> = {}): Promise<void> {
  await auditService.logReqAs(req, site.tenant_id, action, {
    resourceType: 'site', resourcePath: String(site.id), details: { slug: site.slug, accountId: site.account_id, ...details },
  });
}

async function dataPathRows(siteId: number): Promise<DataPathRow[]> {
  return await db('site_data_paths').where({ site_id: siteId }).orderBy('path') as DataPathRow[];
}

/**
 * Why `path` may not be a data path of a site served from `docroot`: a
 * per-directory config name (dataPathForbiddenError), or the docroot itself /
 * one of its ancestors (the code would live in writable data). null = fine.
 */
function dataPathRefusal(path: string, docroot: string): string | null {
  const error = dataPathForbiddenError(path);
  if (error) return error;
  if (dataPathContainsDocroot(path, docroot)) return 'A data path may not be the document root or contain it';
  return null;
}

function dataPathForbidden(path: string, message: string): AppError {
  return new AppError(400, message, 'dataPathForbidden', { path });
}

/** Inserts the data paths of a profile missing from the site (skips overlapping / refused ones). */
async function insertProfileDataPaths(siteId: number, profile: AppProfileId, existing: string[], docroot: string): Promise<{ added: string[]; skipped: string[] }> {
  const added: string[] = [];
  const skipped: string[] = [];
  const paths = [...existing];
  for (const tpl of appProfileDef(profile).dataPaths) {
    if (paths.length >= MAX_DATA_PATHS_PER_SITE || findDataPathOverlap(paths, tpl.path) !== null || dataPathRefusal(tpl.path, docroot) !== null) {
      skipped.push(tpl.path);
      continue;
    }
    await db('site_data_paths').insert({
      site_id: siteId,
      path: tpl.path,
      policy: tpl.policy,
      allowed_extensions: tpl.policy === 'typed' && tpl.allowedExtensions ? JSON.stringify(tpl.allowedExtensions) : null,
      source: 'profile',
    });
    paths.push(tpl.path);
    added.push(tpl.path);
  }
  return { added, skipped };
}

/**
 * Site deletions running in THIS process: a second DELETE of the same site
 * while one runs → 409 siteDeleting (the sites table has no deleting state;
 * a failed deletion leaves the site in 'error' and can be retried).
 */
const siteDeletionsInFlight = siteDeletions;

async function removeSite(req: Request, actor: HostingActor, row: SiteRow): Promise<void> {
  const account = await db('hosting_accounts').where({ id: row.account_id, tenant_id: row.tenant_id })
    .first('id', 'node_id', 'uid', 'gid') as Pick<AccountRow, 'id' | 'node_id' | 'uid' | 'gid'>;
  const [snapshot] = await siteSnapshots(account, [row.id]);
  try {
    await reconcileService.destroySite(snapshot, { purge: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db('sites').where({ id: row.id, tenant_id: row.tenant_id })
      .update({ status: 'error', status_message: DELETION_FAILED_MESSAGE, updated_at: db.fn.now() });
    await audit(req, row, 'site.delete_failed', { error: message.slice(0, 500) });
    emitSite(row, 'updated');
    throw backendUnavailable(err, 'The site could not be removed from the host', actor);
  }
  const routes = await db('site_routes').where({ site_id: row.id }).count('* as c').first() as { c: string | number };
  await db('sites').where({ id: row.id, tenant_id: row.tenant_id }).del();
  scheduleEdgeSync(`site ${row.id} deleted`);
  await audit(req, row, 'site.delete', { name: row.name, routes: Number(routes.c) });
  emitSite(row, 'deleted');
}

/**
 * Feature B (A6): after lockForTeardown, the preview builds of these sites are
 * cancelled and awaited (≤ 30 s), their previews stopped and cleaned
 * (siteDeleted). Never throws: the purge removes previews/ anyway.
 */
async function previewTeardown(siteIds: number[]): Promise<void> {
  try {
    const { previewService } = await import('../previews/previews.service');
    for (const id of siteIds) await previewService.teardownSite(id);
  } catch (err) {
    logger.warn({ err: (err as Error).message, siteIds }, 'previews: teardown failed (the purge removes them)');
  }
}

export const sitesService = {
  async list(actor: HostingActor, filters: { accountId?: number | null; search?: string }): Promise<Site[]> {
    // Staff: 'read' needs a hosting capability or overview.read (§8).
    if (actor.kind === 'staff') assertNeedSomewhere(actor, 'read');
    const q = selectSites();
    scopeToActor(actor, q, { tenant: 's.tenant_id', account: 's.account_id' });
    if (filters.accountId) q.where('s.account_id', filters.accountId);
    const search = filters.search?.trim();
    if (search) {
      const like = `%${search.replace(/[%_\\]/g, '\\$&')}%`;
      q.where((b) => { b.where('s.name', 'ilike', like).orWhere('s.slug', 'ilike', like).orWhere('a.username', 'ilike', like); });
    }
    const [rows, panel] = await Promise.all([q.orderBy([{ column: 'a.username' }, { column: 's.name' }]) as Promise<SiteRow[]>, panelHostname()]);
    return rows.map((r) => forActor(actor, mapSite(r, panel)));
  },

  async get(actor: HostingActor, siteId: number): Promise<Site> {
    await loadSite(actor, siteId, 'read');
    return forActor(actor, await fetchSite(siteId));
  },

  /** POST /sites — sites.manage on the ACCOUNT (a client with the capability may create). */
  async create(req: Request, actor: HostingActor, body: SiteCreateBody): Promise<Site> {
    const account = await loadAccount(actor, body.accountId, 'sites.manage');
    const fields = checkedSiteFields(body);
    // Without releases.publish the site starts in manual (an explicit 'auto' is refused).
    const canPublish = actorCan(actor, 'releases.publish', { tenantId: account.tenant_id, accountId: account.id });
    if (body.publishMode === 'auto' && !canPublish) throw publishRequired();
    const publishMode = body.publishMode ?? (canPublish ? 'auto' : 'manual');
    if (account.status === 'deleting') throw accountDeleting();
    if (await db('sites').where({ account_id: account.id, slug: body.slug }).first('id')) {
      throw new AppError(409, 'This slug is already used by another site of the account', 'slugTaken');
    }
    const plan = await planOf(account);
    assertBaseAllowed(plan, body.base);
    await envelopeService.assertRoomFor('sites', account); // early answer, re-checked under the lock

    const profile = body.appProfile ?? null;
    const docroot = fields.docroot ?? (profile ? appProfileDef(profile).docroot : '');
    const basePath = fields.basePath ?? '/';
    let siteId: number;
    try {
      // Limits re-checked and the row inserted under the tenant lock: two
      // concurrent creations cannot both pass maxSites; an account deletion
      // that started meanwhile is seen.
      siteId = await withTenantLock(account.tenant_id, async (trx) => {
        const current = await trx('hosting_accounts').where({ id: account.id }).first('status', 'plan_id') as Pick<AccountRow, 'status' | 'plan_id'> | undefined;
        if (!current || current.status === 'deleting') throw accountDeleting();
        await envelopeService.assertRoomFor('sites', { id: account.id, tenant_id: account.tenant_id, plan_id: current.plan_id }, trx);
        const [row] = await trx('sites').insert({
          tenant_id: account.tenant_id,
          account_id: account.id,
          name: body.name,
          slug: body.slug,
          base: body.base,
          app_profile: profile,
          docroot,
          base_path: basePath,
          publish_mode: publishMode,
          publish_debounce_sec: body.publishDebounceSec ?? 30,
          healthcheck_path: body.healthcheckPath ?? basePath,
          status: 'provisioning',
          php_settings: JSON.stringify({}),
        }).returning('id') as Array<{ id: number }>;
        return row.id;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'This slug is already used by another site of the account', 'slugTaken');
      throw err;
    }
    let profilePaths: string[] = [];
    if (profile && body.applyProfileDataPaths !== false) profilePaths = (await insertProfileDataPaths(siteId, profile, [], docroot)).added;

    const site = { id: siteId, tenant_id: account.tenant_id, account_id: account.id, slug: body.slug };
    await audit(req, site, 'site.create', { name: body.name, base: body.base, appProfile: profile, dataPaths: profilePaths });
    emitSite(site, 'created');
    requestAccount(account.id, `site ${siteId} created`);
    return fetchSite(siteId);
  },

  async update(req: Request, actor: HostingActor, siteId: number, body: SiteUpdateBody): Promise<Site> {
    const row = await loadSite(actor, siteId, 'sites.manage');
    const fields = checkedSiteFields({ appProfile: body.appProfile, docroot: body.docroot, basePath: body.basePath, publishMode: body.publishMode });
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined && body.name !== row.name) patch.name = body.name;
    if (body.appProfile !== undefined && body.appProfile !== row.app_profile) patch.app_profile = body.appProfile;
    if (fields.docroot !== undefined && fields.docroot !== row.docroot) {
      const docroot = fields.docroot;
      const clash = (await dataPathRows(row.id)).find((p) => dataPathContainsDocroot(p.path, docroot));
      if (clash) {
        throw new AppError(400, `The document root may not be inside the data path ${clash.path}`, 'docrootInDataPath', { path: clash.path });
      }
      patch.docroot = docroot;
    }
    if (fields.basePath !== undefined && fields.basePath !== row.base_path) patch.base_path = fields.basePath;
    if (body.publishMode !== undefined && body.publishMode !== row.publish_mode) {
      // The approval gate is the approvers' control: leaving 'approval' takes
      // releases.approve (a client given sites.manage + releases.publish but
      // not releases.approve must not switch its own reviews off).
      if (row.publish_mode === 'approval' && !actorCan(actor, 'releases.approve', { tenantId: row.tenant_id, accountId: row.account_id })) {
        throw new AppError(403, 'Leaving approval mode requires the right to approve releases', 'approvalRequired');
      }
      if (body.publishMode === 'auto' && !actorCan(actor, 'releases.publish', { tenantId: row.tenant_id, accountId: row.account_id })) throw publishRequired();
      patch.publish_mode = body.publishMode;
    }
    if (body.publishDebounceSec !== undefined && body.publishDebounceSec !== row.publish_debounce_sec) patch.publish_debounce_sec = body.publishDebounceSec;
    if (body.healthcheckPath !== undefined && body.healthcheckPath !== row.healthcheck_path) patch.healthcheck_path = body.healthcheckPath;
    if (body.php !== undefined) {
      const account = await db('hosting_accounts').where({ id: row.account_id }).first('plan_id') as Pick<AccountRow, 'plan_id'>;
      const merged: PhpSettings = { ...json<PhpSettings>(row.php_settings, {}), ...body.php };
      const error = phpSettingsError(merged, (await planOf(account)).memoryMb);
      if (error) throw new AppError(400, error, 'invalidPhpSettings');
      if (JSON.stringify(merged) !== JSON.stringify(json<PhpSettings>(row.php_settings, {}))) patch.php_settings = JSON.stringify(merged);
    }
    if (body.customNginx !== undefined) {
      // Only rendered for nginx bases (inside the site container, never in the
      // edge — H5), stored whatever the base so a base switch keeps them.
      const text = body.customNginx === null || body.customNginx.trim() === '' ? null : body.customNginx.replace(/\r\n/g, '\n');
      if (text !== null) {
        const error = customNginxError(text);
        if (error) throw new AppError(400, error, 'invalidCustomNginx');
      }
      if (text !== row.custom_nginx) patch.custom_nginx = text;
    }
    // Leak guard: tightening is free; relaxing it (block → warn, a new allowlisted path) is the
    // approvers' control, like leaving approval mode (a client must not wave its own leaks through).
    const curPolicy = row.leak_policy === 'warn' ? 'warn' : 'block';
    const curList = json<unknown[]>(row.leak_allowlist, []).filter((x): x is string => typeof x === 'string');
    const relaxes = (body.leakPolicy === 'warn' && curPolicy === 'block')
      || (body.leakAllowlist !== undefined && body.leakAllowlist.some((e) => !curList.includes(e)));
    if (relaxes && !actorCan(actor, 'releases.approve', { tenantId: row.tenant_id, accountId: row.account_id })) {
      throw new AppError(403, 'Relaxing the leak guard requires the right to approve releases', 'approvalRequired');
    }
    if (body.leakPolicy !== undefined && body.leakPolicy !== curPolicy) patch.leak_policy = body.leakPolicy;
    if (body.leakAllowlist !== undefined && JSON.stringify(body.leakAllowlist) !== JSON.stringify(curList)) patch.leak_allowlist = JSON.stringify(body.leakAllowlist);
    if (Object.keys(patch).length > 0) {
      patch.updated_at = db.fn.now();
      await db('sites').where({ id: row.id, tenant_id: row.tenant_id }).update(patch);
      await audit(req, row, 'site.update', { fields: Object.keys(patch).filter((k) => k !== 'updated_at') });
      emitSite(row, 'updated');
      requestSite(row.id, 'updated');
      // basePath / docroot do not change the edge, a name does not either; the
      // primary domain shown in the edge comes from the routes.
    }
    return forActor(actor, await fetchSite(row.id));
  },

  /** Feature B: see previewTeardown (exported for accounts.service). */
  previewTeardown: (siteIds: number[]) => previewTeardown(siteIds),

  /** DELETE /sites/:id {confirm: slug}: containers + storage first (purge), rows kept on failure. */
  async remove(req: Request, actor: HostingActor, siteId: number, confirm: unknown): Promise<void> {
    const row = await loadSite(actor, siteId, 'sites.manage');
    if (confirm !== row.slug) throw new AppError(400, 'Type the site slug to confirm the deletion', 'confirmMismatch');
    if (siteDeletionsInFlight.has(row.id)) throw new AppError(409, 'The site is being deleted', 'siteDeleting');
    siteDeletionsInFlight.add(row.id);
    let unlock: (() => void) | null = null;
    try {
      // No publication / rollback may run during the teardown (it would
      // recreate repo.git / releases/ behind it): 409 publishInProgress.
      unlock = await releaseService.lockForTeardown([row.id]);
      // Feature B: preview builds cancelled and awaited, previews stopped (siteDeleted) before the purge.
      await previewTeardown([row.id]);
      await removeSite(req, actor, row);
    } finally {
      unlock?.();
      siteDeletionsInFlight.delete(row.id);
    }
  },

  async setStopped(req: Request, actor: HostingActor, siteId: number, stopped: boolean): Promise<Site> {
    const row = await loadSite(actor, siteId, 'sites.manage');
    if (!stopped) {
      const account = await db('hosting_accounts').where({ id: row.account_id }).first('status') as { status: string };
      if (account.status === 'suspended') throw new AppError(409, 'The account is suspended', 'accountSuspended');
    }
    const target = stopped ? 'stopped' : 'active';
    if (row.status !== target) {
      await db('sites').where({ id: row.id, tenant_id: row.tenant_id }).update({ status: target, status_message: null, updated_at: db.fn.now() });
      await audit(req, row, stopped ? 'site.stop' : 'site.start');
      emitSite(row, 'updated');
      requestSite(row.id, stopped ? 'stopped' : 'started');
      scheduleEdgeSync(`site ${row.id} ${stopped ? 'stopped' : 'started'}`);
    }
    return forActor(actor, await fetchSite(row.id));
  },

  // ── Data paths ─────────────────────────────────────────────────────────────

  async listDataPaths(actor: HostingActor, siteId: number): Promise<SiteDataPath[]> {
    await loadSite(actor, siteId, 'read');
    return (await dataPathRows(siteId)).map(toSiteDataPath);
  },

  async addDataPath(req: Request, actor: HostingActor, siteId: number, body: DataPathInputBody): Promise<SiteDataPath> {
    const site = await loadSite(actor, siteId, 'sites.manage');
    const refusal = dataPathRefusal(body.path, site.docroot);
    if (refusal) throw dataPathForbidden(body.path, refusal);
    const existing = await dataPathRows(site.id);
    // images/siteconf refuses the whole runtime config beyond this limit.
    if (existing.length >= MAX_DATA_PATHS_PER_SITE) {
      throw new AppError(409, `A site has at most ${MAX_DATA_PATHS_PER_SITE} data paths`, 'dataPathLimit', { max: MAX_DATA_PATHS_PER_SITE });
    }
    const overlap = findDataPathOverlap(existing.map((p) => p.path), body.path);
    if (overlap !== null) {
      throw new AppError(409, `The data path overlaps ${overlap}`, 'dataPathOverlap', { path: body.path, overlaps: overlap });
    }
    let row: DataPathRow;
    try {
      [row] = await db('site_data_paths').insert({
        site_id: site.id,
        path: body.path,
        policy: body.policy,
        allowed_extensions: body.policy === 'typed' ? JSON.stringify(body.allowedExtensions) : null,
        source: 'manual',
      }).returning('*') as DataPathRow[];
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'The data path already exists', 'dataPathOverlap', { path: body.path, overlaps: body.path });
      throw err;
    }
    await audit(req, site, 'site.data_path_add', { path: row.path, policy: row.policy });
    emitSite(site, 'updated');
    requestSite(site.id, 'data-paths');
    return toSiteDataPath(row);
  },

  async updateDataPath(req: Request, actor: HostingActor, siteId: number, pathId: number, body: DataPathUpdateBody): Promise<SiteDataPath> {
    const site = await loadSite(actor, siteId, 'sites.manage');
    const row = await db('site_data_paths').where({ id: pathId, site_id: site.id }).first() as DataPathRow | undefined;
    if (!row) throw new AppError(404, 'Data path not found', 'notFound');
    const policy = body.policy ?? row.policy;
    let extensions: string[] | null = null;
    if (policy === 'typed') {
      const current = json<string[] | null>(row.allowed_extensions, null);
      extensions = body.allowedExtensions ?? (Array.isArray(current) && current.length > 0 ? current : null);
      if (!extensions) throw new AppError(400, 'A typed data path needs its allowed extensions', 'extensionsRequired');
    }
    // Becoming typed: code symlinks of the live tree into the path would bypass
    // the whitelist → the live release is rebuilt first (applyDataPathChange).
    const next = (await dataPathRows(site.id)).map((p) => (p.id === row.id ? { path: p.path, policy } : { path: p.path, policy: p.policy }));
    const { rebuiltReleaseId } = await releaseService.applyDataPathChange(site.id, {
      next,
      userId: actor.userId,
      apply: async () => {
        await db('site_data_paths').where({ id: row.id, site_id: site.id })
          .update({ policy, allowed_extensions: extensions ? JSON.stringify(extensions) : null });
      },
    });
    await audit(req, site, 'site.data_path_update', { path: row.path, policy, from: row.policy, rebuiltReleaseId });
    emitSite(site, 'updated');
    requestSite(site.id, 'data-paths');
    return toSiteDataPath({ ...row, policy, allowed_extensions: extensions });
  },

  async deleteDataPath(req: Request, actor: HostingActor, siteId: number, pathId: number): Promise<void> {
    const site = await loadSite(actor, siteId, 'sites.manage');
    const row = await db('site_data_paths').where({ id: pathId, site_id: site.id }).first() as DataPathRow | undefined;
    if (!row) throw new AppError(404, 'Data path not found', 'notFound');
    // The live tree keeps `<path> → /srv/data/<path>`: without its data rules
    // that directory would be served as code (.htaccess, PHP) → the live
    // release is rebuilt without the link BEFORE the row (and its rules) go.
    const next = (await dataPathRows(site.id)).filter((p) => p.id !== row.id).map((p) => ({ path: p.path, policy: p.policy }));
    const { rebuiltReleaseId } = await releaseService.applyDataPathChange(site.id, {
      next,
      userId: actor.userId,
      apply: async () => { await db('site_data_paths').where({ id: row.id, site_id: site.id }).del(); },
    });
    await audit(req, site, 'site.data_path_delete', { path: row.path, rebuiltReleaseId });
    emitSite(site, 'updated');
    requestSite(site.id, 'data-paths');
  },

  /** Adds the profile's data paths the site does not have yet (overlapping ones are skipped). */
  async applyProfile(req: Request, actor: HostingActor, siteId: number, profile: AppProfileId): Promise<SiteDataPath[]> {
    const site = await loadSite(actor, siteId, 'sites.manage');
    const existing = (await dataPathRows(site.id)).map((p) => p.path);
    const { added, skipped } = await insertProfileDataPaths(site.id, profile, existing, site.docroot);
    if (added.length > 0) {
      await audit(req, site, 'site.data_paths_profile', { profile, added, skipped });
      emitSite(site, 'updated');
      requestSite(site.id, 'data-paths');
    }
    return (await dataPathRows(site.id)).map(toSiteDataPath);
  },

  // ── Secondary runtimes ─────────────────────────────────────────────────────

  async listRuntimes(actor: HostingActor, siteId: number): Promise<SiteRuntime[]> {
    await loadSite(actor, siteId, 'read');
    return runtimesOf(siteId);
  },

  async addRuntime(req: Request, actor: HostingActor, siteId: number, base: SiteBaseId): Promise<SiteRuntime> {
    const site = await loadSite(actor, siteId, 'sites.manage');
    const account = await db('hosting_accounts').where({ id: site.account_id }).first('plan_id') as Pick<AccountRow, 'plan_id'>;
    assertBaseAllowed(await planOf(account), base);
    // Every runtime is one more container with the plan's whole memory / CPU /
    // pids (siteContainerSpec): their number per site is capped, counted
    // under a lock on the site row (two concurrent adds cannot both pass).
    const row = await db.transaction(async (trx) => {
      await trx('sites').where({ id: site.id }).forUpdate().first('id');
      const count = await trx('site_runtimes').where({ site_id: site.id }).count('* as c').first() as { c: string | number };
      if (Number(count.c) >= MAX_RUNTIMES_PER_SITE) {
        throw new AppError(409, `A site has at most ${MAX_RUNTIMES_PER_SITE} secondary runtimes`, 'runtimeLimit', { max: MAX_RUNTIMES_PER_SITE });
      }
      const [inserted] = await trx('site_runtimes').insert({ site_id: site.id, base }).returning('*') as SiteRuntimeRow[];
      return inserted;
    });
    await audit(req, site, 'site.runtime_add', { runtimeId: row.id, base });
    emitSite(site, 'updated');
    requestSite(site.id, 'runtime-added');
    const all = await runtimesOf(site.id);
    return all.find((r) => r.id === row.id) as SiteRuntime;
  },

  async deleteRuntime(req: Request, actor: HostingActor, siteId: number, runtimeId: number): Promise<void> {
    const site = await loadSite(actor, siteId, 'sites.manage');
    const row = await db('site_runtimes').where({ id: runtimeId, site_id: site.id }).first() as SiteRuntimeRow | undefined;
    if (!row) throw new AppError(404, 'Runtime not found', 'notFound');
    const used = await db('site_routes').where({ runtime_id: row.id }).count('* as c').first() as { c: string | number };
    if (Number(used.c) > 0) {
      throw new AppError(409, 'Routes still target this runtime', 'runtimeInUse', { routeCount: Number(used.c) });
    }
    await db('site_runtimes').where({ id: row.id, site_id: site.id }).del();
    await audit(req, site, 'site.runtime_delete', { runtimeId: row.id, base: row.base });
    emitSite(site, 'updated');
    requestSite(site.id, 'runtime-removed');
  },

  // ── Routes targeting the site ──────────────────────────────────────────────

  async listRoutes(actor: HostingActor, siteId: number): Promise<SiteRoute[]> {
    await loadSite(actor, siteId, 'read');
    const rows = await selectRoutes().where('sr.site_id', siteId).orderBy([{ column: 'd.name' }, { column: 'sr.path_prefix' }]) as RouteRow[];
    return rows.map(toSiteRoute);
  },
};

async function runtimesOf(siteId: number): Promise<SiteRuntime[]> {
  const [rows, routes] = await Promise.all([
    db('site_runtimes').where({ site_id: siteId }).orderBy('id') as Promise<SiteRuntimeRow[]>,
    db('site_routes as sr').join('domains as d', 'd.id', 'sr.domain_id')
      .where('sr.site_id', siteId).whereNotNull('sr.runtime_id')
      .orderBy([{ column: 'd.name' }, { column: 'sr.path_prefix' }])
      .select('sr.id', 'sr.runtime_id', 'sr.path_prefix', 'd.name as domain_name') as Promise<Array<{ id: number; runtime_id: number; path_prefix: string; domain_name: string }>>,
  ]);
  return rows.map((r) => ({
    id: r.id,
    siteId: r.site_id,
    base: r.base,
    routes: routes.filter((x) => x.runtime_id === r.id).map((x) => ({ routeId: x.id, domainName: x.domain_name, pathPrefix: x.path_prefix })),
    createdAt: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at)).toISOString(),
  }));
}
