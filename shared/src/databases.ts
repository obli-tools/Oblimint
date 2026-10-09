// =============================================================================
// Oblimint — P2 databases per account (docs/P2-PLAN.md §Bases de données,
// ARCHITECTURE §3.2). Instances are hardened containers of the account
// (data under the account tree, counted in its quota), reached by the sites
// through a UNIX socket mounted in every site container of the account.
// =============================================================================

export type DbEngine = 'mariadb' | 'mysql' | 'postgresql';
/** Socket family: where the default instance's socket appears in the sites. */
export type DbFamily = 'mysql' | 'postgresql';

export interface DbEngineVersionDef {
  engine: DbEngine;
  version: string;
  /** Docker image (official) WITHOUT registry override: `mariadb:11.4`. */
  image: string;
  family: DbFamily;
  /** Shown as « version non maintenue » when true. */
  eol: boolean;
}

export const DB_ENGINE_VERSIONS: readonly DbEngineVersionDef[] = [
  { engine: 'mariadb', version: '11.4', image: 'mariadb:11.4', family: 'mysql', eol: false },
  { engine: 'mariadb', version: '10.11', image: 'mariadb:10.11', family: 'mysql', eol: false },
  { engine: 'mariadb', version: '10.6', image: 'mariadb:10.6', family: 'mysql', eol: false },
  { engine: 'mysql', version: '8.4', image: 'mysql:8.4', family: 'mysql', eol: false },
  { engine: 'mysql', version: '8.0', image: 'mysql:8.0', family: 'mysql', eol: false },
  { engine: 'postgresql', version: '17', image: 'postgres:17', family: 'postgresql', eol: false },
  { engine: 'postgresql', version: '16', image: 'postgres:16', family: 'postgresql', eol: false },
  { engine: 'postgresql', version: '15', image: 'postgres:15', family: 'postgresql', eol: false },
];

export function dbFamilyOf(engine: DbEngine): DbFamily {
  return engine === 'postgresql' ? 'postgresql' : 'mysql';
}

export function dbEngineVersionDef(engine: DbEngine, version: string): DbEngineVersionDef | null {
  return DB_ENGINE_VERSIONS.find((d) => d.engine === engine && d.version === version) ?? null;
}

/**
 * Socket paths seen by the SITE containers (images contract):
 *   default MySQL-family instance  /run/mysqld/mysqld.sock   (DB_HOST=localhost)
 *   default PostgreSQL instance    /run/postgresql/.s.PGSQL.5432
 *   any instance                   /run/oblimint-db/i-<instanceId>/(mysqld.sock|.s.PGSQL.5432)
 */
export const DB_SOCKET_PATHS = {
  mysqlDir: '/run/mysqld',
  mysqlSocket: '/run/mysqld/mysqld.sock',
  postgresqlDir: '/run/postgresql',
  postgresqlSocket: '/run/postgresql/.s.PGSQL.5432',
  instancesDir: '/run/oblimint-db',
} as const;

/** Tuning profile derived from the plan (memory cgroup limit + engine settings). */
export type DbTuningProfile = 'S' | 'M' | 'L';

export const DB_PROFILE_MEMORY_MB: Record<DbTuningProfile, number> = { S: 256, M: 768, L: 2048 };

export type DbInstanceStatus = 'provisioning' | 'running' | 'stopped' | 'error' | 'deleting';

export interface DbInstance {
  id: number;
  tenantId: number;
  accountId: number;
  accountUsername: string;
  nodeId: number;
  /** Label chosen by the user, unique per account: ^[a-z0-9][a-z0-9-]{0,31}$ */
  name: string;
  engine: DbEngine;
  version: string;
  family: DbFamily;
  profile: DbTuningProfile;
  memoryLimitMb: number;
  status: DbInstanceStatus;
  statusMessage: string | null;
  /** This instance's socket is the account default for its family (/run/mysqld or /run/postgresql in the sites). */
  isDefault: boolean;
  /** Socket path inside the site containers. */
  socketPath: string;
  /** TCP host name on the account network (sites may also use it). */
  internalHost: string;
  internalPort: number;
  externalEnabled: boolean;
  /** Host port when external access is on (protected by the account allow-list). */
  externalPort: number | null;
  databaseCount: number;
  userCount: number;
  /** Sum of the database sizes (last measure). */
  sizeBytes: number | null;
  sizeCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DbInstanceCreate {
  accountId: number;
  name: string;
  engine: DbEngine;
  version: string;
  /** Default: the plan's dbProfile. Only the platform admin may pick a larger one than the plan (tenant memory envelope). */
  profile?: DbTuningProfile;
}

export interface DbInstanceUpdate {
  name?: string;
  profile?: DbTuningProfile;
  /** Make this instance the account default of its family. */
  isDefault?: boolean;
}

export interface DbExternalAccessUpdate {
  enabled: boolean;
}

export interface DbDatabase {
  id: number;
  instanceId: number;
  /** ^[A-Za-z0-9_]{1,64}$ (PostgreSQL: lower-cased), reserved names refused. */
  name: string;
  charset: string | null;
  collation: string | null;
  sizeBytes: number | null;
  sizeCheckedAt: string | null;
  createdAt: string;
}

export interface DbDatabaseCreate {
  name: string;
  /** MySQL family: utf8mb4 (default); PostgreSQL: UTF8 (default). */
  charset?: string | null;
  collation?: string | null;
}

/** 'all' = every privilege on the database; 'readonly' = SELECT (+ SHOW VIEW / USAGE). */
export type DbPrivilegeLevel = 'all' | 'readonly';

export interface DbGrant {
  databaseId: number;
  databaseName: string;
  level: DbPrivilegeLevel;
}

export interface DbGrantInput {
  databaseId: number;
  level: DbPrivilegeLevel;
}

export interface DbUser {
  id: number;
  instanceId: number;
  /** ^[A-Za-z0-9_]{1,32}$, reserved names refused (root, mysql, postgres, oblimint_*, mariadb.sys…). */
  username: string;
  grants: DbGrant[];
  passwordSetAt: string | null;
  createdAt: string;
}

export interface DbUserCreate {
  username: string;
  /** Omitted → generated (24 chars), returned once. Else ≥ 12 chars. */
  password?: string | null;
  grants?: DbGrantInput[];
}

export interface DbUserUpdate {
  grants: DbGrantInput[];
}

/** POST …/users and …/users/:uid/password → the password, shown ONCE. */
export interface DbPasswordResult {
  user: DbUser;
  password: string;
}

export interface DbConnectionInfo {
  /** For the sites: DB_HOST=localhost (default instance) or the socket path. */
  socketPath: string;
  internalHost: string;
  internalPort: number;
  externalHost: string | null;
  externalPort: number | null;
}

/** GET /api/databases/instances/:id */
export interface DbInstanceDetail extends DbInstance {
  databases: DbDatabase[];
  users: DbUser[];
  connection: DbConnectionInfo;
  /** Admin UI available (phpMyAdmin for the MySQL family, Adminer for PostgreSQL). */
  adminUi: 'phpmyadmin' | 'adminer';
  adminUiAvailable: boolean;
}

/** POST /api/databases/instances/:id/admin-session → open this URL in a new tab (single use, 60 s). */
export interface DbAdminSession {
  url: string;
  expiresAt: string;
}

export interface DbAdminSessionRequest {
  databaseId?: number | null;
}

/** GET /api/databases/catalog — engines/versions the account may use + plan limits. */
export interface DbCatalog {
  versions: DbEngineVersionDef[];
  /** Engines allowed by the plan of `accountId` (all when no accountId). */
  allowedEngines: DbEngine[];
  maxInstances: number | null;
  maxDatabases: number | null;
  dbMaxSizeMb: number | null;
  externalAccessAllowed: boolean;
  defaultProfile: DbTuningProfile;
}
