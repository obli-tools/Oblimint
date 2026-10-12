// ─────────────────────────────────────────────────────────────────────────────
// Integrated database explorer (« Explorateur SQL », replaces phpMyAdmin /
// Adminer for everyday work): tables, structure, data grid with editing, SQL
// console. Every request runs as an EPHEMERAL SQL user of the panel with
// rights on the opened database only (never the instance superuser), over the
// instance's local socket; statements are time-limited and results capped.
// ─────────────────────────────────────────────────────────────────────────────

/** A value of a result cell. Binary values come as hex (first bytes only). */
export type DbxCell = null | string | number | boolean | DbxBinary | DbxLongText;

export interface DbxBinary {
  binary: true;
  /** Hex of the first DBX_BINARY_PREVIEW bytes. */
  hex: string;
  size: number;
  truncated: boolean;
}

/** A text value longer than DBX_TEXT_MAX: its first DBX_TEXT_PREVIEW characters only (read-only in the grid). */
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

export interface DbxTable {
  /** Identifier used in the API: the table name (PostgreSQL: "schema.table" outside public). */
  id: string;
  name: string;
  schema: string | null;
  kind: 'table' | 'view';
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
}

export interface DbxIndex {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  definition: string | null;
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
}
