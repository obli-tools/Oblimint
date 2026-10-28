import type { DbxSavedQuery } from '@oblimint/shared';
import { DBX_MAX_SAVED_QUERIES } from '@oblimint/shared';
import { db } from '../../../db';
import { AppError } from '../../../middleware/errorHandler';

// Saved queries of the SQL explorer: rows of ONE panel user on ONE database,
// always filtered by tenant, user and database (the routes resolved the
// database with databases.manage on its instance first).

export interface SavedQueryScope {
  tenantId: number;
  userId: number;
  databaseId: number;
}

interface Row { id: number; name: string; sql: string; created_at: Date | string; updated_at: Date | string }

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const view = (r: Row): DbxSavedQuery => ({ id: r.id, name: r.name, sql: r.sql, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) });
const scoped = (s: SavedQueryScope) => db('db_explorer_queries').where({ tenant_id: s.tenantId, user_id: s.userId, database_id: s.databaseId });

export const savedQueries = {
  async list(s: SavedQueryScope): Promise<DbxSavedQuery[]> {
    return (await scoped(s).orderBy('name').select('id', 'name', 'sql', 'created_at', 'updated_at') as Row[]).map(view);
  },

  async create(s: SavedQueryScope, body: { name: string; sql: string }): Promise<DbxSavedQuery> {
    const [{ n }] = await scoped(s).count<{ n: string }[]>({ n: '*' });
    if (Number(n) >= DBX_MAX_SAVED_QUERIES) throw new AppError(409, `At most ${DBX_MAX_SAVED_QUERIES} saved queries per database`, 'planLimit');
    const [row] = await db('db_explorer_queries').insert({
      tenant_id: s.tenantId, user_id: s.userId, database_id: s.databaseId, name: body.name.trim(), sql: body.sql,
    }).returning(['id', 'name', 'sql', 'created_at', 'updated_at']) as Row[];
    return view(row);
  },

  async update(s: SavedQueryScope, id: number, body: { name?: string; sql?: string }): Promise<DbxSavedQuery> {
    const patch: Record<string, unknown> = { updated_at: db.fn.now() };
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.sql !== undefined) patch.sql = body.sql;
    const [row] = await scoped(s).andWhere({ id }).update(patch).returning(['id', 'name', 'sql', 'created_at', 'updated_at']) as Row[];
    if (!row) throw new AppError(404, 'Saved query not found', 'notFound');
    return view(row);
  },

  async remove(s: SavedQueryScope, id: number): Promise<void> {
    const n = await scoped(s).andWhere({ id }).del();
    if (!n) throw new AppError(404, 'Saved query not found', 'notFound');
  },
};
