import type { Request } from 'express';
import type {
  DbAttachGrant, DbAttachmentResult, DbDatabaseListItem, DbFamily, DbPrivilegeLevel, DbSetOwnerRequest, DbShareRequest, DbSiteRole,
  SiteDatabase, SiteDatabaseCreate,
} from '@oblimint/shared';
import { dbFamilyOf } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { loadAccount, loadSite, assertNeedSomewhere, scopeToActor, type HostingActor } from '../hosting/access';
import { isUniqueViolation } from '../hosting/hostingValidation.service';
import { databaseListItem, databaseListQuery, databasesOfSites, sitesOfDatabases, toListItems, type DbSites } from './attachments';
import {
  assertInstanceRunning, auditInstance, databaseService, loadDatabaseRow, loadInstance, loadUserRow, ownerSiteFor,
} from './databases.service';
import { engineFor } from '../docker/engine';
import { platformSettings } from '../platformSettings';
import { dbAdminRunning } from './dbadminInfra';
import { emitInstance } from './instances';
import { adminKindOf } from './sso';
import { syncDatabaseLinks } from './linkSync';
import type { DbDatabaseRow, DbInstanceRow } from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// Databases ↔ sites, write side (migration 030). A database of a shared
// instance gets ONE optional owner site and may be shared with other sites
// of its account. Nothing here touches SQL rights: attaching / sharing never
// revokes a grant; `grantUser` only ADDS a right for an existing user of the
// same instance (never lowers an 'all' to 'readonly'). Every change follows
// with the default site → instance links (linkSync.ts) and is audited in the
// instance's tenant (db.database.attach / share / detach).
//
// Access: databases.manage on the instance (its account), the site(s) seen by
// the actor in the same account. The routes gate db.attach / db.share (and
// db.user_grants with grantUser) on the sites concerned BEFORE calling here
// (share: the receiving site AND the owner site; a database created owned by
// a site: db.attach), and pass the owner their gate saw (expectedOwnerId).
// The SQL grant runs only once the attachment is written.
// ─────────────────────────────────────────────────────────────────────────────

export interface AttachmentTarget {
  instance: DbInstanceRow;
  database: DbDatabaseRow;
  sites: DbSites;
}

/** The instance (databases.manage) and the database, with its current sites. */
export async function loadAttachmentTarget(actor: HostingActor, instanceId: number, dbId: number): Promise<AttachmentTarget> {
  const instance = await loadInstance(actor, instanceId, 'databases.manage');
  if (instance.status === 'deleting') throw new AppError(404, 'Database instance not found', 'notFound');
  const database = await loadDatabaseRow(instance, dbId);
  const sites = (await sitesOfDatabases([database.id])).get(database.id) ?? { owner: null, shared: [] };
  return { instance, database, sites };
}

/** Checked BEFORE anything changes: an existing user of the same instance, the instance running. */
async function checkGrant(t: AttachmentTarget, grant: DbAttachGrant | null | undefined): Promise<void> {
  if (!grant) return;
  if (grant.level !== 'all' && grant.level !== 'readonly') throw new AppError(400, 'Grant level: all or readonly', 'validation', { field: 'grantUser' });
  await loadUserRow(t.instance, Number(grant.userId));
  await assertInstanceRunning(t.instance);
}

/** Adds the right on the database to the user's grants (an 'all' already there is kept). */
async function applyGrant(req: Request, actor: HostingActor, t: AttachmentTarget, grant: DbAttachGrant | null | undefined) {
  if (!grant) return null;
  const current = await db('db_grants').where({ user_id: grant.userId, instance_id: t.instance.id })
    .select('database_id', 'level') as Array<{ database_id: number; level: DbPrivilegeLevel }>;
  const had = current.find((g) => Number(g.database_id) === t.database.id);
  const level: DbPrivilegeLevel = had?.level === 'all' ? 'all' : grant.level;
  const grants = [
    ...current.filter((g) => Number(g.database_id) !== t.database.id).map((g) => ({ databaseId: Number(g.database_id), level: g.level })),
    { databaseId: t.database.id, level },
  ];
  return databaseService.updateUser(req, actor, t.instance.id, Number(grant.userId), { grants });
}

/**
 * applyGrant AFTER the attachment is written. The grant failing (SQL error,
 * instance stopped meanwhile) leaves the attachment in place: the links still
 * follow it, then the error goes to the caller (a retry only re-grants).
 */
async function grantOrSync(req: Request, actor: HostingActor, t: AttachmentTarget, grant: DbAttachGrant | null | undefined, reason: string) {
  try {
    return await applyGrant(req, actor, t, grant);
  } catch (err) {
    // The attachment is written: the views showing it are told, as on success.
    emitInstance(t.instance, t.instance.status);
    await syncDatabaseLinks(t.instance.account_id, `${reason}-grant-failed`);
    throw err;
  }
}

/**
 * adminUiAvailable of panel list items, as the instance detail computes it
 * (dbAdmin host name set, the admin UI container of the engine running on the
 * instance's node): one check per (node, kind), never throws (false).
 */
async function withAdminUi<T extends DbDatabaseListItem>(items: T[]): Promise<T[]> {
  if (!items.length) return items;
  let hostname: string | null = null;
  try { hostname = (await platformSettings.section('dbAdmin')).hostname; } catch { /* settings unreadable: unavailable */ }
  if (!hostname) return items.map((i) => ({ ...i, adminUiAvailable: false }));
  const rows = await db('db_instances').whereIn('id', [...new Set(items.map((i) => i.instanceId))])
    .select('id', 'node_id', 'engine') as Array<Pick<DbInstanceRow, 'id' | 'node_id' | 'engine'>>;
  const checks = new Map<string, Promise<boolean>>();
  const byInstance = new Map<number, Promise<boolean>>();
  for (const r of rows) {
    const kind = adminKindOf(r.engine);
    const key = `${r.node_id ?? ''}:${kind}`;
    if (!checks.has(key)) checks.set(key, engineFor(r.node_id).then((docker) => dbAdminRunning(docker, kind)).catch(() => false));
    byInstance.set(Number(r.id), checks.get(key)!);
  }
  const available = new Map<number, boolean>();
  await Promise.all([...byInstance].map(async ([id, check]) => { available.set(id, await check); }));
  return items.map((i) => ({ ...i, adminUiAvailable: available.get(i.instanceId) ?? false }));
}

export interface AttachOptions {
  /**
   * The owner site the caller's gate saw (null: none). Given, the change
   * happens only while that is still the owner (409 databaseOwnerConflict
   * otherwise): a gate never covers an owner other than the one it named.
   */
  expectedOwnerId?: number | null;
}

const ownerConflict = () => new AppError(409, 'The owner of this database changed meanwhile', 'databaseOwnerConflict');

function assertExpectedOwner(t: AttachmentTarget, opts: AttachOptions): void {
  if (opts.expectedOwnerId === undefined) return;
  if ((t.sites.owner?.id ?? null) !== (opts.expectedOwnerId ?? null)) throw ownerConflict();
}

async function result(t: AttachmentTarget, reason: string, grantedUser: DbAttachmentResult['grantedUser']): Promise<DbAttachmentResult> {
  emitInstance(t.instance, t.instance.status);
  const network = await syncDatabaseLinks(t.instance.account_id, reason);
  const database = await databaseListItem(t.database.id);
  if (!database) throw new AppError(404, 'Database not found', 'notFound');
  return { database, network, grantedUser };
}

const rowOf = (t: AttachmentTarget, siteId: number, role: DbSiteRole, actor: HostingActor) => ({
  tenant_id: t.instance.tenant_id, account_id: t.instance.account_id, site_id: siteId, database_id: t.database.id, role, created_by: actor.userId ?? null,
});

function queryId(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, 'Invalid id', 'validation');
  return n;
}

/**
 * Where a database created for a site lands: the site (read) and the instance
 * — `instanceId` (databases.manage, same account, same family) or the
 * account's default instance of the family (409 noDefaultInstance).
 */
export async function siteCreateTarget(actor: HostingActor, siteId: number, body: Pick<SiteDatabaseCreate, 'family' | 'instanceId'>): Promise<{
  site: { id: number; name: string; tenant_id: number; account_id: number }; instance: DbInstanceRow;
}> {
  const site = await loadSite(actor, siteId, 'read');
  const family: DbFamily = body.family === 'postgresql' ? 'postgresql' : 'mysql';
  let instanceId: number;
  if (body.instanceId) {
    instanceId = Number(body.instanceId);
  } else {
    const candidates = await db('db_instances').where({ account_id: site.account_id, is_default: true }).whereNot({ status: 'deleting' })
      .select('id', 'engine') as Array<{ id: number; engine: DbInstanceRow['engine'] }>;
    const def = candidates.find((c) => dbFamilyOf(c.engine) === family);
    if (!def) {
      throw new AppError(409, `The account has no ${family === 'postgresql' ? 'PostgreSQL' : 'MySQL / MariaDB'} database server yet`, 'noDefaultInstance', { family });
    }
    instanceId = Number(def.id);
  }
  const instance = await loadInstance(actor, instanceId, 'databases.manage');
  if (Number(instance.account_id) !== Number(site.account_id)) throw new AppError(400, 'The instance belongs to another account than the site', 'validation', { field: 'instanceId' });
  if (dbFamilyOf(instance.engine) !== family) throw new AppError(400, `The instance is not of the ${family} family`, 'validation', { field: 'instanceId' });
  return {
    site: { id: Number(site.id), name: site.name, tenant_id: Number(site.tenant_id), account_id: Number(site.account_id) },
    instance,
  };
}

/** db.attach of a database created directly owned by a site (panel and key surfaces). */
export function createAttachParams(instance: Pick<DbInstanceRow, 'id'>, siteId: number, name: string): Record<string, unknown> {
  return { database: name, instanceId: instance.id, ownerSiteId: siteId, create: true };
}

export const siteDatabaseService = {
  /** GET /databases/databases?accountId&siteId&tenantId — every database the actor reads, with its sites. */
  async list(actor: HostingActor, filters: { accountId?: number | null; siteId?: number | null; tenantId?: number | null }): Promise<DbDatabaseListItem[]> {
    assertNeedSomewhere(actor, 'read');
    const q = databaseListQuery();
    const accountId = queryId(filters.accountId);
    const siteId = queryId(filters.siteId);
    if (accountId) {
      await loadAccount(actor, accountId, 'read');
      q.where('i.account_id', accountId);
    }
    if (siteId) {
      const site = await loadSite(actor, siteId, 'read');
      q.whereExists(db('site_databases as sd').whereRaw('sd.database_id = d.id').andWhere('sd.site_id', site.id));
    }
    scopeToActor(actor, q, { tenant: 'i.tenant_id', account: 'i.account_id' }, filters.tenantId);
    const rows = await q.orderBy([{ column: 'i.account_id' }, { column: 'i.name' }, { column: 'd.name' }]);
    return withAdminUi(await toListItems(rows));
  },

  /** The databases of a site (owned, then shared with it). */
  async ofSite(actor: HostingActor, siteId: number): Promise<SiteDatabase[]> {
    const site = await loadSite(actor, siteId, 'read');
    return withAdminUi((await databasesOfSites([site.id])).get(site.id) ?? []);
  },

  /**
   * A new database owned by the site, on the account's default instance of
   * `family` (or `instanceId`). The caller gates db.attach on the site first
   * (siteCreateTarget gives the instance it lands on).
   */
  async createForSite(req: Request, actor: HostingActor, siteId: number, body: SiteDatabaseCreate): Promise<SiteDatabase> {
    const { site, instance } = await siteCreateTarget(actor, siteId, body);
    const created = await databaseService.createDatabase(req, actor, instance.id, {
      name: body.name, charset: body.charset ?? null, collation: body.collation ?? null, siteId: site.id,
    });
    const item = await databaseListItem(created.id);
    if (!item) throw new AppError(404, 'Database not found', 'notFound');
    return { ...item, role: 'owner' };
  },

  /**
   * Sets (siteId) or removes (null) the owner site. The previous owner stays
   * attached as a SHARED site (nothing it used is taken away silently);
   * removing the owner makes the database shared across the account again.
   */
  async setOwner(req: Request, actor: HostingActor, instanceId: number, dbId: number, body: DbSetOwnerRequest, opts: AttachOptions = {}): Promise<DbAttachmentResult> {
    const t = await loadAttachmentTarget(actor, instanceId, dbId);
    const site = body.siteId ? await ownerSiteFor(actor, t.instance, Number(body.siteId)) : null;
    const previous = t.sites.owner;
    assertExpectedOwner(t, opts);
    await checkGrant(t, body.grantUser);
    if ((site?.id ?? null) === (previous?.id ?? null)) return result(t, 'owner-unchanged', await grantOrSync(req, actor, t, body.grantUser, 'owner-unchanged'));
    try {
      await db.transaction(async (trx) => {
        // Conditional on the owner the caller (and its gate) saw: another change meanwhile → 409, nothing changed.
        if (previous) {
          const n = await trx('site_databases').where({ database_id: t.database.id, site_id: previous.id, role: 'owner' }).update({ role: 'shared' });
          if (n !== 1) throw ownerConflict();
        } else {
          const other = await trx('site_databases').where({ database_id: t.database.id, role: 'owner' }).forUpdate().first('site_id');
          if (other) throw ownerConflict();
        }
        if (site) {
          await trx('site_databases').insert(rowOf(t, site.id, 'owner', actor))
            .onConflict(['site_id', 'database_id']).merge({ role: 'owner' });
        }
      });
    } catch (err) {
      // Another owner set meanwhile (uq_site_databases_owner): nothing changed, the caller retries on fresh data.
      if (isUniqueViolation(err)) throw ownerConflict();
      throw err;
    }
    await auditInstance(req, t.instance, site ? 'db.database.attach' : 'db.database.detach', {
      database: t.database.name, databaseId: t.database.id,
      ...(site ? { siteId: site.id, site: site.name, role: 'owner' } : { siteId: previous!.id, site: previous!.name, role: 'owner', keptAsShared: true }),
      previousOwnerSiteId: previous?.id ?? null, ...(previous && site ? { previousOwnerKeptAsShared: true } : {}),
      ...(body.grantUser ? { grantUserId: body.grantUser.userId, grantLevel: body.grantUser.level } : {}),
    });
    // The SQL grant only once the attachment is written (it audits itself, db.user.update).
    const reason = site ? 'owner-set' : 'owner-removed';
    return result(t, reason, await grantOrSync(req, actor, t, body.grantUser, reason));
  },

  /** Shares the database with a site (not its owner). Already shared: nothing changes. */
  async share(req: Request, actor: HostingActor, instanceId: number, dbId: number, body: DbShareRequest, opts: AttachOptions = {}): Promise<DbAttachmentResult> {
    const t = await loadAttachmentTarget(actor, instanceId, dbId);
    const site = await ownerSiteFor(actor, t.instance, Number(body.siteId));
    assertExpectedOwner(t, opts);
    if (t.sites.owner?.id === site.id) throw new AppError(409, 'This site already owns the database', 'siteOwnsDatabase', { siteId: site.id });
    await checkGrant(t, body.grantUser);
    if (t.sites.shared.some((s) => s.id === site.id)) return result(t, 'share-unchanged', await grantOrSync(req, actor, t, body.grantUser, 'share-unchanged'));
    await db('site_databases').insert(rowOf(t, site.id, 'shared', actor)).onConflict(['site_id', 'database_id']).ignore();
    await auditInstance(req, t.instance, 'db.database.share', {
      database: t.database.name, databaseId: t.database.id, siteId: site.id, site: site.name,
      ...(body.grantUser ? { grantUserId: body.grantUser.userId, grantLevel: body.grantUser.level } : {}),
    });
    return result(t, 'shared', await grantOrSync(req, actor, t, body.grantUser, 'shared'));
  },

  /**
   * Detaches the database from a site (its owner or a site it is shared with).
   * The SQL rights stay as they are. No owner left = shared across the account.
   */
  async detach(req: Request, actor: HostingActor, instanceId: number, dbId: number, siteId: number): Promise<DbAttachmentResult> {
    const t = await loadAttachmentTarget(actor, instanceId, dbId);
    const site = await ownerSiteFor(actor, t.instance, siteId);
    const role: DbSiteRole | null = t.sites.owner?.id === site.id ? 'owner' : t.sites.shared.some((s) => s.id === site.id) ? 'shared' : null;
    if (!role) throw new AppError(404, 'The database is not attached to this site', 'notFound');
    await db('site_databases').where({ database_id: t.database.id, site_id: site.id }).del();
    await auditInstance(req, t.instance, 'db.database.detach', { database: t.database.name, databaseId: t.database.id, siteId: site.id, site: site.name, role });
    return result(t, 'detached', null);
  },
};
