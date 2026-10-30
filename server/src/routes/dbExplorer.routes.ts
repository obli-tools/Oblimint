import { Router, type Request } from 'express';
import { z } from 'zod';
import type { DbFamily, DbxDdlRequest, DbxImportOptions } from '@oblimint/shared';
import { DBX_FK_ACTIONS, DBX_MAX_PAGE, DBX_MAX_TIMEOUT_S, DBX_MIN_TIMEOUT_S, dbFamilyOf } from '@oblimint/shared';
import { AppError } from '../middleware/errorHandler';
import { auditService } from '../services/audit.service';
import { loadDatabaseRow, loadInstance } from '../services/databases/databases.service';
import { auditSql, explorerService } from '../services/databases/explorer/explorer.service';
import { savedQueries } from '../services/databases/explorer/savedQueries';
import type { DbDatabaseRow, DbInstanceRow } from '../services/databases/rows';
import { parseBody } from '../services/docker/parseBody';
import { idParam, resolveActor } from '../services/hosting/access';
import { splitStatements } from '../services/databases/explorer/sqlStream';
import { actionLevel, gateAction, gateStrictest } from '../services/restrictions/gate';
import { classifySql } from '../services/restrictions/sqlClass';
import { spoolHashed } from '../services/restrictions/content';
import { canonicalJson } from '../services/restrictions/canonical';
import crypto from 'crypto';

// /api/databases/instances/:id/databases/:dbId/explorer* — integrated database
// explorer (shared/src/dbExplorer.ts). Every route needs databases.manage on
// the instance (the same right as phpMyAdmin / Adminer SSO) and a database of
// that instance. Mounted on /databases.
//   GET    …/explorer                       → DbxInfo (opens the session)
//   DELETE …/explorer                       → closes the session (drops its SQL user)
//   GET    …/explorer/tables?refresh=1      → DbxTable[]
//   GET    …/explorer/table?t=              → DbxTableInfo
//   GET    …/explorer/schema                → DbxSchema (autocomplete)
//   POST   …/explorer/rows   {table, …DbxRowsRequest} → DbxRows
//   POST   …/explorer/insert {table, values}           → { inserted: true }
//   POST   …/explorer/update {table, key, values}      → { affected }
//   POST   …/explorer/delete {table, keys}             → { affected }
//   POST   …/explorer/query  {sql, timeoutS?}          → DbxQueryResponse
//   POST   …/explorer/cancel                           → { cancelled }
//   POST   …/explorer/ddl/preview {request}            → DbxDdlPreview (generated server-side)
//   POST   …/explorer/ddl/apply   {request}            → { statements, results, stopped } (regenerated, never the client text)
//   GET    …/explorer/objects                          → DbxObject[]
//   GET    …/explorer/objects/definition?kind=&id=     → DbxObjectDefinition
//   POST   …/explorer/search {term, mode, tables?}     → DbxSearchResponse
//   POST   …/explorer/maintenance {op, tables}         → { results, stopped }
//   POST   …/explorer/export {DbxExportRequest}        → DbxExportTicket
//   GET    …/explorer/export/:token                    → the file (stream)
//   POST   …/explorer/import?options=<json>  raw body  → DbxImportStatus (when done)
//   GET    …/explorer/import                           → DbxImportStatus | null (progress)
//   POST   …/explorer/import/cancel                    → { cancelled }
//   GET|POST …/explorer/queries · PUT|DELETE …/explorer/queries/:qid → saved queries (own, this database)

const router = Router();

const tableField = z.string().min(1).max(512);
const cellValue = z.union([z.string().max(16 * 1024 * 1024), z.null()]);
const keyValue = z.union([z.string().max(4096), z.number(), z.null()]);
const timeoutS = z.number().int().min(DBX_MIN_TIMEOUT_S).max(DBX_MAX_TIMEOUT_S).optional();
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
const querySchema = z.object({ sql: z.string().min(1).max(1024 * 1024), timeoutS }).strict();

const ident = z.string().min(1).max(128);
const fkAction = z.enum(DBX_FK_ACTIONS as [string, ...string[]]);
const columnDef = z.object({
  name: ident,
  type: z.string().min(1).max(512),
  nullable: z.boolean(),
  default: z.union([
    z.object({ kind: z.literal('null') }).strict(),
    z.object({ kind: z.literal('literal'), value: z.string().max(65_535) }).strict(),
    z.object({ kind: z.literal('expression'), value: z.string().max(64) }).strict(),
  ]).nullable().optional(),
  autoIncrement: z.boolean().optional(),
  comment: z.string().max(1024).nullable().optional(),
}).strict();
const ddlRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('createTable'), name: ident, columns: z.array(columnDef).min(1).max(1000), primaryKey: z.array(ident).max(64).optional(), comment: z.string().max(1024).nullable().optional() }).strict(),
  z.object({ op: z.literal('renameTable'), table: tableField, newName: ident }).strict(),
  z.object({ op: z.literal('dropTable'), table: tableField, confirm: z.string().max(512) }).strict(),
  z.object({ op: z.literal('truncateTable'), table: tableField, confirm: z.string().max(512) }).strict(),
  z.object({ op: z.literal('addColumn'), table: tableField, column: columnDef, after: z.string().max(128).nullable().optional() }).strict(),
  z.object({ op: z.literal('modifyColumn'), table: tableField, column: ident, def: columnDef }).strict(),
  z.object({ op: z.literal('dropColumn'), table: tableField, column: ident }).strict(),
  z.object({ op: z.literal('createIndex'), table: tableField, name: ident, columns: z.array(ident).min(1).max(64), unique: z.boolean() }).strict(),
  z.object({ op: z.literal('dropIndex'), table: tableField, name: ident }).strict(),
  z.object({ op: z.literal('setPrimaryKey'), table: tableField, columns: z.array(ident).max(64) }).strict(),
  z.object({
    op: z.literal('addForeignKey'), table: tableField, name: ident, columns: z.array(ident).min(1).max(64), refTable: tableField,
    refColumns: z.array(ident).min(1).max(64), onDelete: fkAction, onUpdate: fkAction,
  }).strict(),
  z.object({ op: z.literal('dropForeignKey'), table: tableField, name: ident }).strict(),
  z.object({ op: z.literal('dropObject'), kind: z.enum(['view', 'procedure', 'function', 'trigger', 'event']), id: z.string().min(1).max(4096), confirm: z.string().max(512) }).strict(),
]);
const ddlSchema = z.object({ request: ddlRequest }).strict();
const searchSchema = z.object({ term: z.string().min(1).max(200), mode: z.enum(['contains', 'exact']), tables: z.array(tableField).max(2000).optional() }).strict();
const maintenanceSchema = z.object({ op: z.enum(['optimize', 'analyze', 'check', 'repair', 'vacuum', 'vacuumAnalyze', 'reindex']), tables: z.array(tableField).min(1).max(500) }).strict();
const delimiter = z.enum([',', ';', '\t']).optional();
const exportSchema = z.object({
  format: z.enum(['sql', 'csv', 'json']),
  tables: z.array(tableField).max(2000).optional(),
  sql: z.string().min(1).max(256 * 1024).optional(),
  structure: z.boolean().optional(),
  data: z.boolean().optional(),
  routines: z.boolean().optional(),
  gzip: z.boolean().optional(),
  csvDelimiter: delimiter,
  csvHeader: z.boolean().optional(),
}).strict();
const importSchema = z.object({
  format: z.enum(['sql', 'csv']),
  continueOnError: z.boolean().optional(),
  table: tableField.optional(),
  csvDelimiter: delimiter,
  csvHeader: z.boolean().optional(),
  columns: z.array(z.string().min(1).max(256).nullable()).max(4096).optional(),
  csvEmptyNull: z.boolean().optional(),
}).strict();
const savedSchema = z.object({ name: z.string().trim().min(1).max(120), sql: z.string().min(1).max(256 * 1024) }).strict();
const savedUpdateSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), sql: z.string().min(1).max(256 * 1024).optional() }).strict();

interface Target { instance: DbInstanceRow; database: DbDatabaseRow; userId: number }

async function target(req: Request): Promise<Target> {
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

/**
 * Statements as audited, each cut (never the results). family: literals masked (strings, numbers → ?) —
 * typed statements (console); without it, as is (DDL generated by the panel from a structured request).
 */
export function auditStatements(statements: string[], family?: DbFamily, max = 20, each = 300): string[] {
  return statements.slice(0, max).map((s) => (family ? auditSql(family, s, each) : s.length > each ? `${s.slice(0, each)}…` : s));
}

/** Does the batch write (any doubt = a write: data-modifying CTE, EXPLAIN ANALYZE, SELECT … INTO…)? */
const isWrite = (family: DbFamily, statements: string[]) => classifySql(statements, family).write;

const h = (fn: (req: Request, res: import('express').Response) => Promise<void>) =>
  (req: Request, res: import('express').Response, next: import('express').NextFunction) => { fn(req, res).catch(next); };

const base = '/instances/:id/databases/:dbId/explorer';

/** The database's account as a restriction target. */
const dbTarget = (t: Target) => ({ tenantId: Number(t.instance.tenant_id), accountId: Number(t.instance.account_id), siteId: null });
const dbParams = (t: Target) => ({ database: t.database.name, databaseId: t.database.id, instanceId: t.instance.id });
/** Row data / statement bound to an approval by its digest: never shown to the decider nor kept in the audit. */
const digest = (v: unknown) => crypto.createHash('sha256').update(canonicalJson(v)).digest('hex');

router.get(base, h(async (req, res) => {
  const t = await target(req);
  res.json({ success: true, data: await explorerService.info(t.instance, t.database, t.userId) });
}));

router.delete(base, h(async (req, res) => {
  const t = await target(req);
  await explorerService.close(t.instance, t.database, t.userId);
  res.json({ success: true, data: null });
}));

router.get(`${base}/tables`, h(async (req, res) => {
  const t = await target(req);
  res.json({ success: true, data: await explorerService.tables(t.instance, t.database, t.userId, req.query.refresh === '1') });
}));

router.get(`${base}/table`, h(async (req, res) => {
  const t = await target(req);
  const table = tableField.parse(req.query.t);
  res.json({ success: true, data: await explorerService.table(t.instance, t.database, t.userId, table) });
}));

router.get(`${base}/schema`, h(async (req, res) => {
  const t = await target(req);
  res.json({ success: true, data: await explorerService.schema(t.instance, t.database, t.userId) });
}));

router.post(`${base}/rows`, h(async (req, res) => {
  const t = await target(req);
  const { table, ...q } = parseBody(rowsSchema, req.body);
  res.json({ success: true, data: await explorerService.rows(t.instance, t.database, t.userId, table, q) });
}));

router.post(`${base}/insert`, h(async (req, res) => {
  const t = await target(req);
  const { table, values } = parseBody(insertSchema, req.body);
  await gateAction(req, { action: 'db.rows_write', target: dbTarget(t), params: { ...dbParams(t), op: 'insert', table, columns: Object.keys(values), dataSha256: digest({ values }) } });
  await explorerService.insert(t.instance, t.database, t.userId, table, values);
  await audit(req, t, 'db.explorer.insert', { table, columns: Object.keys(values) });
  res.json({ success: true, data: { inserted: true } });
}));

router.post(`${base}/update`, h(async (req, res) => {
  const t = await target(req);
  const { table, key, values } = parseBody(updateSchema, req.body);
  await gateAction(req, { action: 'db.rows_write', target: dbTarget(t), params: { ...dbParams(t), op: 'update', table, columns: Object.keys(values), dataSha256: digest({ key, values }) } });
  const affected = await explorerService.update(t.instance, t.database, t.userId, table, key, values);
  // Never the key values (they identify the row's data): the edited columns and the count.
  await audit(req, t, 'db.explorer.update', { table, columns: Object.keys(values), affected });
  res.json({ success: true, data: { affected } });
}));

router.post(`${base}/delete`, h(async (req, res) => {
  const t = await target(req);
  const { table, keys } = parseBody(deleteSchema, req.body);
  await gateAction(req, { action: 'db.rows_write', target: dbTarget(t), params: { ...dbParams(t), op: 'delete', table, rows: keys.length, dataSha256: digest({ keys }) } });
  const affected = await explorerService.remove(t.instance, t.database, t.userId, table, keys);
  await audit(req, t, 'db.explorer.delete', { table, rows: keys.length, affected });
  res.json({ success: true, data: { affected } });
}));

router.post(`${base}/query`, h(async (req, res) => {
  const t = await target(req);
  const { sql, timeoutS: limit } = parseBody(querySchema, req.body);
  // Free SQL that writes: db.query_write (default: keys only), and what it amounts to — a DROP /
  // TRUNCATE is db.ddl, an INSERT / UPDATE / DELETE db.rows_write, a pasted dump db.import — gated
  // ONCE on the strictest: the console never does for free what the explorer's buttons protect.
  // The decider reads the statements with their literals masked (as the audit); the exact text is
  // bound by its digest.
  const family = dbFamilyOf(t.instance.engine);
  const typed = splitStatements(sql, family).map((s) => s.sql);
  const cls = classifySql(typed, family);
  if (cls.write) {
    const params = { ...dbParams(t), sql: auditStatements(typed, family), sqlSha256: digest(sql) };
    await gateStrictest(req, cls.actions.map((action) => ({ action, target: dbTarget(t), params })));
  }
  const data = await explorerService.query(t.instance, t.database, t.userId, sql, limit);
  // The statements themselves (cut), never their results.
  const statements = [...new Set(data.results.map((r) => r.statement))];
  await audit(req, t, 'db.explorer.query', {
    statements: statements.length, failed: data.stopped, write: isWrite(dbFamilyOf(t.instance.engine), statements), sql: auditStatements(statements, dbFamilyOf(t.instance.engine)),
  });
  res.json({ success: true, data });
}));

router.post(`${base}/cancel`, h(async (req, res) => {
  const t = await target(req);
  const data = await explorerService.cancel(t.instance, t.database, t.userId);
  if (data.cancelled) await audit(req, t, 'db.explorer.cancel', {});
  res.json({ success: true, data });
}));

router.post(`${base}/ddl/preview`, h(async (req, res) => {
  const t = await target(req);
  const { request } = parseBody(ddlSchema, req.body);
  res.json({ success: true, data: await explorerService.ddlPreview(t.instance, t.database, t.userId, request as DbxDdlRequest) });
}));

router.post(`${base}/ddl/apply`, h(async (req, res) => {
  const t = await target(req);
  const { request } = parseBody(ddlSchema, req.body);
  // Dropping / emptying a table or an object: db.ddl.
  if (request.op === 'dropTable' || request.op === 'truncateTable' || request.op === 'dropObject') {
    await gateAction(req, { action: 'db.ddl', target: dbTarget(t), params: { ...dbParams(t), request } });
  }
  const data = await explorerService.ddlApply(t.instance, t.database, t.userId, request as DbxDdlRequest);
  await audit(req, t, 'db.explorer.ddl', {
    op: request.op, table: 'table' in request ? request.table : 'name' in request ? request.name : null, failed: data.stopped, sql: auditStatements(data.statements),
  });
  res.json({ success: true, data });
}));

router.get(`${base}/objects`, h(async (req, res) => {
  const t = await target(req);
  res.json({ success: true, data: await explorerService.objects(t.instance, t.database, t.userId) });
}));

router.get(`${base}/objects/definition`, h(async (req, res) => {
  const t = await target(req);
  const kind = z.enum(['view', 'procedure', 'function', 'trigger', 'event']).parse(req.query.kind);
  const id = z.string().min(1).max(4096).parse(req.query.id);
  res.json({ success: true, data: await explorerService.objectDefinition(t.instance, t.database, t.userId, kind, id) });
}));

router.post(`${base}/search`, h(async (req, res) => {
  const t = await target(req);
  res.json({ success: true, data: await explorerService.search(t.instance, t.database, t.userId, parseBody(searchSchema, req.body)) });
}));

router.post(`${base}/maintenance`, h(async (req, res) => {
  const t = await target(req);
  const { op, tables } = parseBody(maintenanceSchema, req.body);
  const data = await explorerService.maintenance(t.instance, t.database, t.userId, op, tables);
  await audit(req, t, 'db.explorer.maintenance', { op, tables: tables.slice(0, 50), failed: data.stopped });
  res.json({ success: true, data });
}));

router.post(`${base}/export`, h(async (req, res) => {
  const t = await target(req);
  const body = parseBody(exportSchema, req.body);
  const urlBase = `/api/databases/instances/${t.instance.id}/databases/${t.database.id}/explorer/export`;
  res.json({ success: true, data: await explorerService.prepareExport(t.instance, t.database, t.userId, body, urlBase) });
}));

router.get(`${base}/export/:token`, h(async (req, res) => {
  const t = await target(req);
  const token = z.string().regex(/^[0-9a-f]{48}$/).parse(req.params.token);
  const what = await explorerService.runExport(t.instance, t.database, t.userId, token, res);
  await audit(req, t, 'db.explorer.export', what);
}));

router.post(`${base}/import`, h(async (req, res) => {
  const t = await target(req);
  let options: DbxImportOptions;
  try {
    options = importSchema.parse(JSON.parse(String(req.query.options ?? '{}')));
  } catch {
    throw new AppError(400, 'Invalid import options', 'validation', { field: 'options' });
  }
  if (options.format === 'csv' && !options.table) throw new AppError(400, 'CSV: choose the table', 'validation', { field: 'table' });
  const length = Number(req.headers['content-length']);
  // db.import: none → streamed; sensitive → the user's own code; restricted → the content enters the
  // fingerprint of the approval (sha256 + size) and is imported from that copy.
  const params = { ...dbParams(t), from: 'explorer upload', options };
  const level = await actionLevel(req, 'db.import', dbTarget(t));
  let status: Awaited<ReturnType<typeof explorerService.startImport>>;
  if (level !== 'restricted') {
    if (level === 'sensitive') {
      // Refused (code asked): the upload is drained, the connection stays usable.
      try { await gateAction(req, { action: 'db.import', target: dbTarget(t), params }); } catch (err) { req.resume(); throw err; }
    }
    status = await explorerService.startImport(t.instance, t.database, t.userId, req, req.headers['content-type'], Number.isFinite(length) ? length : null, options);
  } else {
    const copy = await spoolHashed(req, `user:${t.userId}`);
    try {
      await gateAction(req, { action: 'db.import', target: dbTarget(t), params: { ...params, size: copy.size, contentSha256: copy.sha256 } });
      status = await explorerService.startImport(t.instance, t.database, t.userId, copy.open(), req.headers['content-type'], copy.size, options);
    } finally {
      await copy.cleanup();
    }
  }
  await audit(req, t, 'db.explorer.import', {
    format: status.format, table: status.table, bytes: status.bytesRead, statements: status.statements, rows: status.rows, errors: status.errorCount, state: status.state,
  });
  res.json({ success: true, data: status });
}));

router.get(`${base}/import`, h(async (req, res) => {
  const t = await target(req);
  res.json({ success: true, data: await explorerService.importStatus(t.instance, t.database, t.userId) });
}));

router.post(`${base}/import/cancel`, h(async (req, res) => {
  const t = await target(req);
  res.json({ success: true, data: { cancelled: await explorerService.cancelImport(t.instance, t.database, t.userId) } });
}));

// ── saved queries (own, on this database) ──
const scope = (t: Target) => ({ tenantId: t.instance.tenant_id, userId: t.userId, databaseId: t.database.id });
const qid = (req: Request) => {
  const n = Number(req.params.qid);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(404, 'Saved query not found', 'notFound');
  return n;
};

router.get(`${base}/queries`, h(async (req, res) => {
  const t = await target(req);
  res.json({ success: true, data: await savedQueries.list(scope(t)) });
}));

router.post(`${base}/queries`, h(async (req, res) => {
  const t = await target(req);
  res.json({ success: true, data: await savedQueries.create(scope(t), parseBody(savedSchema, req.body)) });
}));

router.put(`${base}/queries/:qid`, h(async (req, res) => {
  const t = await target(req);
  res.json({ success: true, data: await savedQueries.update(scope(t), qid(req), parseBody(savedUpdateSchema, req.body)) });
}));

router.delete(`${base}/queries/:qid`, h(async (req, res) => {
  const t = await target(req);
  await savedQueries.remove(scope(t), qid(req));
  res.json({ success: true, data: null });
}));

export default router;
