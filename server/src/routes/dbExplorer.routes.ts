import { Router, type Request } from 'express';
import { z } from 'zod';
import { DBX_MAX_PAGE } from '@oblimint/shared';
import { auditService } from '../services/audit.service';
import { loadDatabaseRow, loadInstance } from '../services/databases/databases.service';
import { explorerService } from '../services/databases/explorer/explorer.service';
import type { DbDatabaseRow, DbInstanceRow } from '../services/databases/rows';
import { parseBody } from '../services/docker/parseBody';
import { idParam, resolveActor } from '../services/hosting/access';

// /api/databases/instances/:id/databases/:dbId/explorer* — integrated database
// explorer (shared/src/dbExplorer.ts). Every route needs databases.manage on
// the instance (the same right as phpMyAdmin / Adminer SSO). Mounted on /databases.
//   GET    …/explorer                       → DbxInfo (opens the session)
//   DELETE …/explorer                       → closes the session (drops its SQL user)
//   GET    …/explorer/tables?refresh=1      → DbxTable[]
//   GET    …/explorer/table?t=              → DbxTableInfo
//   POST   …/explorer/rows   {table, …DbxRowsRequest} → DbxRows
//   POST   …/explorer/insert {table, values}           → { inserted: true }
//   POST   …/explorer/update {table, key, values}      → { affected }
//   POST   …/explorer/delete {table, keys}             → { affected }
//   POST   …/explorer/query  {sql}                     → DbxQueryResponse

const router = Router();

const tableField = z.string().min(1).max(512);
const cellValue = z.union([z.string().max(16 * 1024 * 1024), z.null()]);
const keyValue = z.union([z.string().max(4096), z.number(), z.null()]);
const rowsSchema = z.object({
  table: tableField,
  offset: z.number().int().min(0).max(1e12),
  limit: z.number().int().min(1).max(DBX_MAX_PAGE),
  sort: z.string().max(256).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  filters: z.array(z.object({
    column: z.string().min(1).max(256),
    op: z.enum(['=', '!=', '<', '<=', '>', '>=', 'like', 'not like', 'null', 'not null']),
    value: z.string().max(4096).optional(),
  }).strict()).max(20).optional(),
}).strict();
const insertSchema = z.object({ table: tableField, values: z.record(cellValue) }).strict();
const updateSchema = z.object({ table: tableField, key: z.record(keyValue), values: z.record(cellValue) }).strict();
const deleteSchema = z.object({ table: tableField, keys: z.array(z.record(keyValue)).min(1).max(1000) }).strict();
const querySchema = z.object({ sql: z.string().min(1).max(1024 * 1024) }).strict();

async function target(req: Request): Promise<{ instance: DbInstanceRow; database: DbDatabaseRow; userId: number }> {
  const actor = await resolveActor(req);
  const instance = await loadInstance(actor, idParam(req), 'databases.manage');
  const database = await loadDatabaseRow(instance, Number(req.params.dbId));
  return { instance, database, userId: actor.userId };
}

function audit(req: Request, t: { instance: DbInstanceRow; database: DbDatabaseRow }, action: string, details: Record<string, unknown>) {
  return auditService.logReqAs(req, t.instance.tenant_id, action, {
    resourceType: 'database', resourcePath: `${t.instance.id}/${t.database.id}`, details: { database: t.database.name, ...details },
  });
}

const base = '/instances/:id/databases/:dbId/explorer';

router.get(base, async (req, res, next) => {
  try {
    const t = await target(req);
    res.json({ success: true, data: await explorerService.info(t.instance, t.database, t.userId) });
  } catch (err) { next(err); }
});

router.delete(base, async (req, res, next) => {
  try {
    const t = await target(req);
    await explorerService.close(t.instance, t.database, t.userId);
    res.json({ success: true, data: null });
  } catch (err) { next(err); }
});

router.get(`${base}/tables`, async (req, res, next) => {
  try {
    const t = await target(req);
    res.json({ success: true, data: await explorerService.tables(t.instance, t.database, t.userId, req.query.refresh === '1') });
  } catch (err) { next(err); }
});

router.get(`${base}/table`, async (req, res, next) => {
  try {
    const t = await target(req);
    const table = tableField.parse(req.query.t);
    res.json({ success: true, data: await explorerService.table(t.instance, t.database, t.userId, table) });
  } catch (err) { next(err); }
});

router.post(`${base}/rows`, async (req, res, next) => {
  try {
    const t = await target(req);
    const { table, ...q } = parseBody(rowsSchema, req.body);
    res.json({ success: true, data: await explorerService.rows(t.instance, t.database, t.userId, table, q) });
  } catch (err) { next(err); }
});

router.post(`${base}/insert`, async (req, res, next) => {
  try {
    const t = await target(req);
    const { table, values } = parseBody(insertSchema, req.body);
    await explorerService.insert(t.instance, t.database, t.userId, table, values);
    await audit(req, t, 'db.explorer.insert', { table, columns: Object.keys(values) });
    res.json({ success: true, data: { inserted: true } });
  } catch (err) { next(err); }
});

router.post(`${base}/update`, async (req, res, next) => {
  try {
    const t = await target(req);
    const { table, key, values } = parseBody(updateSchema, req.body);
    const affected = await explorerService.update(t.instance, t.database, t.userId, table, key, values);
    await audit(req, t, 'db.explorer.update', { table, key, columns: Object.keys(values), affected });
    res.json({ success: true, data: { affected } });
  } catch (err) { next(err); }
});

router.post(`${base}/delete`, async (req, res, next) => {
  try {
    const t = await target(req);
    const { table, keys } = parseBody(deleteSchema, req.body);
    const affected = await explorerService.remove(t.instance, t.database, t.userId, table, keys);
    await audit(req, t, 'db.explorer.delete', { table, rows: keys.length, affected });
    res.json({ success: true, data: { affected } });
  } catch (err) { next(err); }
});

router.post(`${base}/query`, async (req, res, next) => {
  try {
    const t = await target(req);
    const { sql } = parseBody(querySchema, req.body);
    const data = await explorerService.query(t.instance, t.database, t.userId, sql);
    // The statements themselves (not their results) are audited, cut.
    await audit(req, t, 'db.explorer.query', {
      statements: data.results.length, failed: data.stopped, sql: sql.length > 2000 ? `${sql.slice(0, 2000)}…` : sql,
    });
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

export default router;
