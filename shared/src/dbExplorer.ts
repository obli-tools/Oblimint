// ─────────────────────────────────────────────────────────────────────────────
// Integrated database explorer (« Explorateur SQL », replaces phpMyAdmin /
// Adminer for everyday work): tables, structure, data grid with editing, SQL
// console. Every request runs as an EPHEMERAL SQL user of the panel with
// rights on the opened database only (never the instance superuser), over the
// instance's local socket; statements are time-limited and results capped.
// ─────────────────────────────────────────────────────────────────────────────

import type { DbFamily } from './databases';

/** A value of a result cell. Binary values come as hex (first bytes only). */
export type DbxCell = null | string | number | boolean | DbxBinary | DbxLongText;

export interface DbxBinary {
  binary: true;
  /** Hex of the first DBX_BINARY_PREVIEW bytes. */
  hex: string;
  size: number;
  truncated: boolean;
}

/**
 * A text value cut: longer than DBX_TEXT_MAX (its first DBX_TEXT_PREVIEW characters), or cut further to
 * fit the byte budget of a response (API keys: past DBX_TEXT_PREVIEW). Read-only in the grid.
 */
export interface DbxLongText {
  long: true;
  text: string;
  size: number;
}

export const DBX_BINARY_PREVIEW = 64;
export const DBX_TEXT_MAX = 65_536;
export const DBX_TEXT_PREVIEW = 4096;
/** Rows kept per statement of the SQL console. */
export const DBX_MAX_QUERY_ROWS = 1000;
/** Rows per page of the data grid (max). */
export const DBX_MAX_PAGE = 500;
/** Statement time limit (seconds). */
export const DBX_STATEMENT_TIMEOUT_S = 30;
/**
 * Bytes of rows (JSON, approximate) one response may hold, whatever the row
 * counts: the SQL console (every statement and result set of a run), a page
 * of the grid, a database search. Rows past it are not kept (truncated); a
 * first row larger than what is left comes back with its values cut.
 */
export const DBX_QUERY_MAX_BYTES = 8 * 1024 * 1024;
export const DBX_PAGE_MAX_BYTES = 8 * 1024 * 1024;
export const DBX_SEARCH_MAX_BYTES = 2 * 1024 * 1024;

/** MySQL-family storage engines that roll back (any other one keeps the rows written before an error). PostgreSQL: always. */
const TRANSACTIONAL_ENGINES = new Set(['innodb', 'xtradb', 'tokudb', 'rocksdb', 'ndb', 'ndbcluster']);
export function dbxTransactionalEngine(engine: string | null | undefined): boolean {
  return !engine || TRANSACTIONAL_ENGINES.has(engine.toLowerCase());
}

export interface DbxTable {
  /** Identifier used in the API: the table name (PostgreSQL: "schema.table" outside public). */
  id: string;
  name: string;
  schema: string | null;
  kind: 'table' | 'view';
  /** PostgreSQL: a materialized view. */
  materialized?: boolean;
  /** Estimated row count (engine statistics). */
  rows: number | null;
  bytes: number | null;
  engine: string | null;
  comment: string | null;
}

export interface DbxColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  primary: boolean;
  autoIncrement: boolean;
  comment: string | null;
  /** Binary column: shown as hex, never edited in the grid. */
  binary: boolean;
  /** PostgreSQL: an identity column (GENERATED … AS IDENTITY), not a serial default. */
  identity?: boolean;
  /** MySQL family: collation of a text column. */
  collation?: string | null;
  /** MySQL family: EXTRA (auto_increment, on update …). */
  extra?: string | null;
}

export interface DbxIndex {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  definition: string | null;
  /** PostgreSQL: backs a constraint (dropped with ALTER TABLE … DROP CONSTRAINT). */
  constraint?: boolean;
}

export interface DbxForeignKey {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string | null;
  onUpdate: string | null;
}

export interface DbxTableInfo {
  table: DbxTable;
  columns: DbxColumn[];
  indexes: DbxIndex[];
  foreignKeys: DbxForeignKey[];
  /** Columns of the primary key (empty: the grid is read-only). */
  primaryKey: string[];
  /** CREATE statement (MySQL family). */
  ddl: string | null;
  /** Foreign keys of other tables pointing at this one. */
  incoming?: DbxIncomingKey[];
}

export type DbxFilterOp = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'like' | 'not like' | 'null' | 'not null';

export interface DbxFilter {
  column: string;
  op: DbxFilterOp;
  value?: string;
}

export interface DbxRowsRequest {
  offset: number;
  limit: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  filters?: DbxFilter[];
}

export interface DbxRows {
  columns: string[];
  rows: DbxCell[][];
  /** Exact when filtered or small, otherwise the engine estimate (approximate: true). */
  total: number | null;
  approximate: boolean;
  offset: number;
  limit: number;
  /** Fewer rows than the page holds: the page is larger than DBX_PAGE_MAX_BYTES (smaller pages show them). */
  truncated?: boolean;
}

/** Primary key values of a row (column → value as text). */
export type DbxRowKey = Record<string, string | number | null>;

export interface DbxRowUpdate {
  key: DbxRowKey;
  /** Column → new value as text (null = SQL NULL). */
  values: Record<string, string | null>;
}

export interface DbxQueryResult {
  statement: string;
  /** 2nd, 3rd… result set of the same statement (MySQL CALL). */
  resultSet?: number;
  columns?: string[];
  rows?: DbxCell[][];
  truncated?: boolean;
  affectedRows?: number | null;
  insertId?: string | null;
  durationMs: number;
  error?: string;
}

export interface DbxQueryResponse {
  results: DbxQueryResult[];
  /** The console stops at the first failing statement. */
  stopped: boolean;
}

export interface DbxInfo {
  engine: string;
  version: string | null;
  database: string;
  /** SQL user of the session (ephemeral). */
  user: string;
  /** Maintenance operations of the engine. */
  maintenance: DbxMaintenanceOp[];
  /** Upload cap of an import (bytes). */
  importMaxBytes: number;
}

/** A foreign key of another table pointing at this one (rows referencing a row). */
export interface DbxIncomingKey {
  name: string;
  /** Referencing table id. */
  table: string;
  columns: string[];
  /** Columns of this table. */
  refColumns: string[];
}

// ── Structure editing (DDL) ──────────────────────────────────────────────────
// The client sends a STRUCTURED request; the server regenerates the DDL from it
// (identifiers quoted, types checked against a grammar, literals quoted) for the
// preview AND for the execution. A DDL edited by hand runs as a console statement.

export type DbxFkAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';
export const DBX_FK_ACTIONS: DbxFkAction[] = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'];

/** Default of a column: NULL, a literal (quoted) or one of the allowed expressions (CURRENT_TIMESTAMP…). */
export type DbxDefault = { kind: 'null' } | { kind: 'literal'; value: string } | { kind: 'expression'; value: string };

export interface DbxColumnDef {
  name: string;
  /** e.g. varchar(255), int unsigned, numeric(10,2), timestamp with time zone, enum('a','b'), text[]. */
  type: string;
  nullable: boolean;
  /** null / absent: no default. */
  default?: DbxDefault | null;
  /** MySQL AUTO_INCREMENT, PostgreSQL GENERATED BY DEFAULT AS IDENTITY. */
  autoIncrement?: boolean;
  comment?: string | null;
}

export type DbxObjectKind = 'view' | 'procedure' | 'function' | 'trigger' | 'event';

export type DbxDdlRequest =
  | { op: 'createTable'; name: string; columns: DbxColumnDef[]; primaryKey?: string[]; comment?: string | null }
  | { op: 'renameTable'; table: string; newName: string }
  | { op: 'dropTable'; table: string; confirm: string }
  | { op: 'truncateTable'; table: string; confirm: string }
  /** MySQL: after = column name, '' = FIRST, absent = last. */
  | { op: 'addColumn'; table: string; column: DbxColumnDef; after?: string | null }
  /** def.name ≠ column renames it. */
  | { op: 'modifyColumn'; table: string; column: string; def: DbxColumnDef }
  | { op: 'dropColumn'; table: string; column: string }
  | { op: 'createIndex'; table: string; name: string; columns: string[]; unique: boolean }
  | { op: 'dropIndex'; table: string; name: string }
  /** Empty columns: drops the primary key. */
  | { op: 'setPrimaryKey'; table: string; columns: string[] }
  | { op: 'addForeignKey'; table: string; name: string; columns: string[]; refTable: string; refColumns: string[]; onDelete: DbxFkAction; onUpdate: DbxFkAction }
  | { op: 'dropForeignKey'; table: string; name: string }
  /** id = DbxObject.id (catalog); confirm = its name. */
  | { op: 'dropObject'; kind: DbxObjectKind; id: string; confirm: string };

export type DbxDdlOp = DbxDdlRequest['op'];

export interface DbxDdlWarning {
  key: string;
  text: string;
}

export interface DbxDdlPreview {
  statements: string[];
  /** Notes on the generated DDL (data loss, table rewrite…): i18n key + English text. */
  warnings: DbxDdlWarning[];
}

// ── Views, routines, triggers, events ────────────────────────────────────────

export interface DbxObject {
  kind: DbxObjectKind;
  /** Identifier used in the API (PostgreSQL routines: with their argument types). */
  id: string;
  name: string;
  schema: string | null;
  /** Trigger: its table. */
  table: string | null;
  /** Routine: arguments / return type; trigger: timing + event; event: schedule + status. */
  detail: string | null;
  /** PostgreSQL routine: identity argument types (DROP FUNCTION f(args)). */
  args?: string | null;
  /** MySQL family: DEFINER of the object. */
  definer: string | null;
  /** The definer is an ephemeral session user of the panel: the object stops working when that user is dropped. */
  ephemeralDefiner: boolean;
}

export interface DbxObjectDefinition {
  object: DbxObject;
  ddl: string;
}

// ── Console ──────────────────────────────────────────────────────────────────

export const DBX_MIN_TIMEOUT_S = 1;
export const DBX_MAX_TIMEOUT_S = 300;

export interface DbxQueryRequest {
  sql: string;
  /** Statement time limit of this run (DBX_MIN_TIMEOUT_S…DBX_MAX_TIMEOUT_S, default DBX_STATEMENT_TIMEOUT_S). */
  timeoutS?: number;
}

/** Tables → columns, for the autocomplete of the console (bounded). */
export interface DbxSchema {
  tables: Record<string, string[]>;
  truncated: boolean;
}

export interface DbxSavedQuery {
  id: number;
  name: string;
  sql: string;
  createdAt: string;
  updatedAt: string;
}

export const DBX_MAX_SAVED_QUERIES = 200;

// ── Export / import ──────────────────────────────────────────────────────────

export type DbxExportFormat = 'sql' | 'csv' | 'json';

export interface DbxExportRequest {
  format: DbxExportFormat;
  /** sql: tables (ids) to dump, none = the whole database; csv / json: exactly one table, or `sql`. */
  tables?: string[];
  /** csv / json: one SELECT statement (run read-only) instead of a table. */
  sql?: string;
  /** sql: CREATE statements (default true). */
  structure?: boolean;
  /** sql: rows (default true). */
  data?: boolean;
  /** sql, whole database: routines, triggers (and events, MySQL family) — default true. */
  routines?: boolean;
  gzip?: boolean;
  csvDelimiter?: ',' | ';' | '\t';
  /** csv: first line = column names (default true). */
  csvHeader?: boolean;
}

/** One-shot download ticket: GET `url` within DBX_EXPORT_TICKET_S. */
export interface DbxExportTicket {
  token: string;
  filename: string;
  url: string;
}

export const DBX_EXPORT_TICKET_S = 120;

export type DbxImportFormat = 'sql' | 'csv';

export interface DbxImportOptions {
  format: DbxImportFormat;
  /** sql: keep going after a failing statement (errors listed). */
  continueOnError?: boolean;
  /** csv: target table (id). */
  table?: string;
  csvDelimiter?: ',' | ';' | '\t';
  /** csv: first line = column names (skipped). Default true. */
  csvHeader?: boolean;
  /** csv: table column of each column of the file (null = skipped). Default: the table columns in order. */
  columns?: Array<string | null>;
  /** csv: an empty field is SQL NULL (default: an empty string). */
  csvEmptyNull?: boolean;
}

export interface DbxImportError {
  /** 1-based line of the statement start (CSV: of the record). */
  line: number;
  statement: string;
  error: string;
}

export interface DbxImportStatus {
  id: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  format: DbxImportFormat;
  table: string | null;
  bytesRead: number;
  totalBytes: number | null;
  statements: number;
  rows: number;
  errorCount: number;
  /** The first errors (at most DBX_IMPORT_MAX_ERRORS). */
  errors: DbxImportError[];
  startedAt: string;
  finishedAt: string | null;
  message: string | null;
}

export const DBX_IMPORT_MAX_ERRORS = 50;
/** Default upload cap of an import (MiB): setting dbAdmin.explorerImportMaxMb. */
export const DBX_IMPORT_DEFAULT_MAX_MB = 256;
/** Default cap of an export (MiB written): setting dbAdmin.explorerExportMaxMb. */
export const DBX_EXPORT_DEFAULT_MAX_MB = 4096;

// ── Search, maintenance ──────────────────────────────────────────────────────

export interface DbxSearchRequest {
  term: string;
  mode: 'contains' | 'exact';
  /** Only these tables (ids); default every table. */
  tables?: string[];
}

export interface DbxSearchHit {
  table: string;
  /** Text columns searched in this table. */
  searchedColumns: string[];
  columns: string[];
  rows: DbxCell[][];
  /** More matching rows than shown. */
  more: boolean;
}

export interface DbxSearchResponse {
  hits: DbxSearchHit[];
  tablesSearched: number;
  /** Tables skipped: no text column, table limit, time budget. */
  tablesSkipped: number;
  timedOut: boolean;
}

export const DBX_SEARCH_MAX_TABLES = 200;
export const DBX_SEARCH_ROWS_PER_TABLE = 20;
export const DBX_SEARCH_BUDGET_S = 20;

export type DbxMaintenanceOp = 'optimize' | 'analyze' | 'check' | 'repair' | 'vacuum' | 'vacuumAnalyze' | 'reindex';
export const DBX_MAINTENANCE_OPS: Record<DbFamily, DbxMaintenanceOp[]> = {
  mysql: ['optimize', 'analyze', 'check', 'repair'],
  postgresql: ['vacuum', 'vacuumAnalyze', 'analyze', 'reindex'],
};

// ── API keys (MCP / REST v1) ─────────────────────────────────────────────────

export const DBX_KEY_MAX_ROWS = 500;
export const DBX_KEY_MAX_BYTES = 256 * 1024;
export const DBX_KEY_DEFAULT_TIMEOUT_S = 15;
export const DBX_KEY_MAX_TIMEOUT_S = 60;

/** query_database / POST …/query of a key. */
export interface ApiV1DbQueryResult {
  readOnly: boolean;
  columns: string[] | null;
  rows: DbxCell[][] | null;
  rowCount: number;
  /** More rows than returned (max_rows or the byte cap). */
  truncated: boolean;
  affectedRows: number | null;
  durationMs: number;
}
