import type { Knex } from 'knex';
import type { DbDatabase, DbDatabaseListItem, DbSiteRef, DbSiteRole, SiteDatabase } from '@oblimint/shared';
import { dbFamilyOf } from '@oblimint/shared';
import { db } from '../../db';
import type { DbDatabaseRow, DbInstanceRow } from './rows';
import { toDbDatabase } from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// Databases ↔ sites, read side (migration 030 site_databases). Light module
// (db + mappers only): used by the databases service, the sites service (site
// detail), the access keys and the backfill. The writes and their checks live
// in siteDatabases.service.ts.
//
// A database has at most one OWNER site and may be SHARED with other sites of
// its account; no owner = shared across the account (every site reaches its
// instance, the behaviour before 030).
// ─────────────────────────────────────────────────────────────────────────────

export interface SiteDatabaseRow {
  tenant_id: number;
  account_id: number;
  site_id: number;
  database_id: number;
  role: DbSiteRole;
  created_by: number | null;
  created_at: Date | string;
}

export interface DbSites {
  owner: DbSiteRef | null;
  shared: DbSiteRef[];
}

const EMPTY: DbSites = Object.freeze({ owner: null, shared: [] }) as DbSites;

/** Owner and shared sites of each database (ids absent from the map: none). */
export async function sitesOfDatabases(databaseIds: readonly number[], conn: Knex = db): Promise<Map<number, DbSites>> {
  const out = new Map<number, DbSites>();
  const ids = [...new Set(databaseIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return out;
  const rows = await conn('site_databases as sd').join('sites as s', 's.id', 'sd.site_id').whereIn('sd.database_id', ids)
    .orderBy([{ column: 's.name' }, { column: 's.id' }])
    .select('sd.database_id', 'sd.role', 's.id', 's.name', 's.slug') as Array<{ database_id: number; role: DbSiteRole; id: number; name: string; slug: string }>;
  for (const r of rows) {
    const entry = out.get(Number(r.database_id)) ?? { owner: null, shared: [] };
    const ref: DbSiteRef = { id: Number(r.id), name: r.name, slug: r.slug };
    if (r.role === 'owner') entry.owner = ref;
    else entry.shared.push(ref);
    out.set(Number(r.database_id), entry);
  }
  return out;
}

/** The databases with their ownerSite / sharedSites filled. */
export async function withSites<T extends DbDatabase>(list: T[]): Promise<Array<T & { ownerSite: DbSiteRef | null; sharedSites: DbSiteRef[] }>> {
  const sites = await sitesOfDatabases(list.map((d) => d.id));
  return list.map((d) => {
    const s = sites.get(d.id) ?? EMPTY;
    return { ...d, ownerSite: s.owner, sharedSites: [...s.shared] };
  });
}

type ListRow = DbDatabaseRow & Pick<DbInstanceRow, 'tenant_id' | 'engine'> & {
  instance_name: string; instance_status: DbInstanceRow['status']; instance_is_default: boolean; account_username: string;
};

/** db_databases joined with their instance and account (alias d / i / a): filter before running. */
export function databaseListQuery(conn: Knex = db): Knex.QueryBuilder {
  return conn('db_databases as d')
    .join('db_instances as i', 'i.id', 'd.instance_id')
    .join('hosting_accounts as a', 'a.id', 'i.account_id')
    .whereNot('i.status', 'deleting')
    .select('d.*', 'i.tenant_id', 'i.engine', 'i.name as instance_name', 'i.status as instance_status', 'i.is_default as instance_is_default',
      'a.username as account_username');
}

/** Rows of databaseListQuery → list items (sites filled). */
export async function toListItems(rows: ListRow[]): Promise<DbDatabaseListItem[]> {
  const sites = await sitesOfDatabases(rows.map((r) => r.id));
  return rows.map((r): DbDatabaseListItem => {
    const s = sites.get(Number(r.id)) ?? EMPTY;
    return {
      ...toDbDatabase(r),
      tenantId: Number(r.tenant_id),
      accountId: Number(r.account_id),
      accountUsername: r.account_username ?? '',
      instanceName: r.instance_name,
      engine: r.engine,
      family: dbFamilyOf(r.engine),
      instanceStatus: r.instance_status,
      instanceIsDefault: !!r.instance_is_default,
      ownerSite: s.owner,
      sharedSites: [...s.shared],
    };
  });
}

/** One database as a list item (null when gone). */
export async function databaseListItem(databaseId: number): Promise<DbDatabaseListItem | null> {
  const rows = await databaseListQuery().where('d.id', databaseId) as ListRow[];
  return (await toListItems(rows))[0] ?? null;
}

/** The databases of some sites (owned first, then shared; by name): siteId → SiteDatabase[]. */
export async function databasesOfSites(siteIds: readonly number[]): Promise<Map<number, SiteDatabase[]>> {
  const out = new Map<number, SiteDatabase[]>();
  const ids = [...new Set(siteIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return out;
  const links = await db('site_databases').whereIn('site_id', ids).select('site_id', 'database_id', 'role') as Array<{ site_id: number; database_id: number; role: DbSiteRole }>;
  if (!links.length) return out;
  const rows = await databaseListQuery().whereIn('d.id', [...new Set(links.map((l) => Number(l.database_id)))]) as ListRow[];
  const items = new Map((await toListItems(rows)).map((i) => [i.id, i]));
  for (const l of links) {
    const item = items.get(Number(l.database_id));
    if (!item) continue;
    const list = out.get(Number(l.site_id)) ?? [];
    list.push({ ...item, role: l.role });
    out.set(Number(l.site_id), list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) || a.id - b.id : a.role === 'owner' ? -1 : 1));
  }
  return out;
}

/** Ids of the databases owned by / shared with any of `siteIds` (access keys limited to some sites). */
export async function databasesAttachedTo(siteIds: Iterable<number>, accountId?: number): Promise<Set<number>> {
  const ids = [...new Set([...siteIds].map(Number))];
  if (!ids.length) return new Set();
  const q = db('site_databases').whereIn('site_id', ids);
  if (accountId) q.andWhere('account_id', accountId);
  return new Set((await q.pluck('database_id') as number[]).map(Number));
}
