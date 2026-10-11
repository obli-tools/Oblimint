import type { DbEngine, DbFamily, DbTuningProfile } from '@oblimint/shared';
import { DB_PROFILE_MEMORY_MB, DB_SOCKET_PATHS, dbFamilyOf } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Database engines (module databases, docs/P2-PLAN.md §9.3) — PURE data and
// renderers (unit-tested in engines.test.ts): container paths of the official
// images, client binaries, and the S/M/L tuning passed as server
// COMMAND-LINE FLAGS (no generated config file to mount: nothing to write in
// an account tree, nothing the account uid could swap — B1/R5). The official
// entrypoints prepend the server binary when the command starts with "-".
// ─────────────────────────────────────────────────────────────────────────────

/** Paths INSIDE the instance container. */
export interface DbContainerPaths {
  /** Data directory (bind of accounts/<id>/databases/<iid>). */
  data: string;
  /** Socket directory (bind of accounts/<id>/dbsock/i-<iid>). */
  socketDir: string;
  /** Socket file. */
  socket: string;
}

/**
 * MySQL family: /run/mysqld (mysqld.sock). PostgreSQL: the official image's
 * default is /var/run/postgresql, a symlink to /run/postgresql in the Debian
 * images; the bind targets the real path /run/postgresql and the server is
 * told so (unix_socket_directories), so the mount never depends on a
 * symlink of the image root resolved under the /run tmpfs.
 */
export const DB_CONTAINER_PATHS: Record<DbFamily, DbContainerPaths> = {
  mysql: { data: '/var/lib/mysql', socketDir: DB_SOCKET_PATHS.mysqlDir, socket: DB_SOCKET_PATHS.mysqlSocket },
  postgresql: { data: '/var/lib/postgresql/data', socketDir: DB_SOCKET_PATHS.postgresqlDir, socket: DB_SOCKET_PATHS.postgresqlSocket },
};

/** TCP port of the engine inside its container (and on the account network). */
export const DB_CONTAINER_PORT: Record<DbFamily, number> = { mysql: 3306, postgresql: 5432 };

/** Socket file name of a family (inside the instance socket dir). */
export const DB_SOCKET_FILE: Record<DbFamily, string> = { mysql: 'mysqld.sock', postgresql: '.s.PGSQL.5432' };

/** Client binaries of each engine image (MariaDB ≥ 11 no longer ships the mysql* names). */
export interface DbClientBinaries {
  /** Interactive / batch client. */
  client: string;
  /** Logical dump. */
  dump: string;
  /** Liveness probe. */
  admin: string;
}

export const DB_CLIENTS: Record<DbEngine, DbClientBinaries> = {
  mariadb: { client: 'mariadb', dump: 'mariadb-dump', admin: 'mariadb-admin' },
  mysql: { client: 'mysql', dump: 'mysqldump', admin: 'mysqladmin' },
  postgresql: { client: 'psql', dump: 'pg_dump', admin: 'pg_isready' },
};

/** Superuser of the instance (password = sealed root_secret). */
export const DB_SUPERUSER: Record<DbFamily, string> = { mysql: 'root', postgresql: 'postgres' };

/** Maintenance database PostgreSQL connects to when no database is named. */
export const PG_MAINTENANCE_DB = 'postgres';

/** Tuning profile of a size: memory limit, connections, derived engine settings. */
export interface DbTuning {
  memoryMb: number;
  maxConnections: number;
  /** MySQL family: innodb_buffer_pool_size ≈ 50 % of the memory limit. */
  innodbBufferPoolMb: number;
  /** PostgreSQL: shared_buffers ≈ 25 %. */
  sharedBuffersMb: number;
  /** PostgreSQL: effective_cache_size ≈ 50 % (planner hint, allocates nothing). */
  effectiveCacheMb: number;
  workMemMb: number;
  maintenanceWorkMemMb: number;
  /** In-memory temporary tables (MySQL tmp_table_size / max_heap_table_size). */
  tmpTableMb: number;
  /** /tmp tmpfs of the container (charged to the same memory cgroup). */
  tmpfsMb: number;
  /** PidsLimit: one thread / process per connection + background workers. */
  pidsLimit: number;
}

const CONNECTIONS: Record<DbTuningProfile, number> = { S: 50, M: 100, L: 200 };

export function dbTuning(profile: DbTuningProfile): DbTuning {
  const memoryMb = DB_PROFILE_MEMORY_MB[profile];
  const maxConnections = CONNECTIONS[profile];
  return {
    memoryMb,
    maxConnections,
    // S: 25 % (64 MB) — the server, its per-connection buffers and the /tmp tmpfs share the same 256 MB cgroup.
    innodbBufferPoolMb: Math.floor(memoryMb * (profile === 'S' ? 0.25 : 0.5)),
    sharedBuffersMb: Math.floor(memoryMb * 0.25),
    effectiveCacheMb: Math.floor(memoryMb * 0.5),
    workMemMb: profile === 'S' ? 2 : profile === 'M' ? 4 : 8,
    maintenanceWorkMemMb: Math.floor(memoryMb / 16),
    tmpTableMb: profile === 'S' ? 16 : profile === 'M' ? 32 : 64,
    tmpfsMb: profile === 'S' ? 32 : profile === 'M' ? 128 : 256,
    pidsLimit: maxConnections + 128,
  };
}

/**
 * Server flags of an instance (container Cmd). Besides the tuning:
 *  - skip-name-resolve: no reverse DNS per connection (latency, and grants by
 *    host name are never used: users are '%');
 *  - authentication failures logged WITH the client address (hostd-firewall
 *    parses the container logs for bans): MariaDB log_warnings=2 ("Access
 *    denied for user 'x'@'ip'"), MySQL log_error_verbosity=3; PostgreSQL
 *    log_connections + log_line_prefix '%m [%p] %h ' ("password
 *    authentication failed" lines carry %h);
 *  - PostgreSQL: log_min_error_statement=panic so a failing statement (which
 *    may carry a PASSWORD literal) never lands in the log (B2).
 */
export function renderServerArgs(engine: DbEngine, profile: DbTuningProfile): string[] {
  const t = dbTuning(profile);
  if (dbFamilyOf(engine) === 'postgresql') {
    const c = (kv: string) => ['-c', kv];
    return [
      ...c(`listen_addresses=*`),
      ...c(`port=${DB_CONTAINER_PORT.postgresql}`),
      ...c(`unix_socket_directories=${DB_CONTAINER_PATHS.postgresql.socketDir}`),
      ...c(`max_connections=${t.maxConnections}`),
      ...c(`shared_buffers=${t.sharedBuffersMb}MB`),
      ...c(`effective_cache_size=${t.effectiveCacheMb}MB`),
      ...c(`work_mem=${t.workMemMb}MB`),
      ...c(`maintenance_work_mem=${t.maintenanceWorkMemMb}MB`),
      ...c('password_encryption=scram-sha-256'),
      ...c('log_connections=on'),
      ...c(`log_line_prefix=%m [%p] %h `),
      ...c('log_min_error_statement=panic'),
    ];
  }
  const args = [
    '--skip-name-resolve',
    `--socket=${DB_CONTAINER_PATHS.mysql.socket}`,
    `--port=${DB_CONTAINER_PORT.mysql}`,
    `--max-connections=${t.maxConnections}`,
    `--innodb-buffer-pool-size=${t.innodbBufferPoolMb}M`,
    `--tmp-table-size=${t.tmpTableMb}M`,
    `--max-heap-table-size=${t.tmpTableMb}M`,
    '--key-buffer-size=8M',
    `--table-open-cache=${t.maxConnections * 8}`,
    '--character-set-server=utf8mb4',
  ];
  if (engine === 'mysql') {
    // MySQL 8 writes binary logs by default (30 days kept): no replication
    // here, and they would eat the account quota unmeasured.
    args.push('--disable-log-bin');
    args.push('--log-error-verbosity=3');
    // performance_schema alone costs ~100+ MB on MySQL 8: off for the small profile.
    if (profile === 'S') args.push('--performance-schema=OFF');
  } else {
    args.push('--log-warnings=2');
  }
  return args;
}

/**
 * First-run environment of the official image (superuser password from the
 * sealed root_secret). The superuser only exists on the socket:
 *  - MariaDB / MySQL: *_ROOT_HOST=localhost → no root@'%' (root never
 *    reachable over TCP, even with external access on);
 *  - PostgreSQL: password auth on the socket too (initdb defaults `local` to
 *    TRUST: every site of the account mounts that socket and could otherwise
 *    log in as postgres without a password).
 */
export function renderFirstRunEnv(engine: DbEngine, rootPassword: string): string[] {
  switch (engine) {
    case 'mariadb':
      return [`MARIADB_ROOT_PASSWORD=${rootPassword}`, 'MARIADB_ROOT_HOST=localhost', 'MARIADB_INITDB_SKIP_TZINFO=1', 'MARIADB_AUTO_UPGRADE=1'];
    case 'mysql':
      return [`MYSQL_ROOT_PASSWORD=${rootPassword}`, 'MYSQL_ROOT_HOST=localhost'];
    case 'postgresql':
      return [
        `POSTGRES_PASSWORD=${rootPassword}`,
        'POSTGRES_INITDB_ARGS=--auth-local=scram-sha-256 --auth-host=scram-sha-256',
        'POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
        `PGDATA=${DB_CONTAINER_PATHS.postgresql.data}`,
      ];
    default:
      return [];
  }
}

/** Environment of an exec that authenticates as `user` with `password` (never on the command line). */
export function passwordEnv(family: DbFamily, password: string): string {
  return family === 'postgresql' ? `PGPASSWORD=${password}` : `MYSQL_PWD=${password}`;
}

export interface ClientCommandOptions {
  /** Database to connect to (validated identifier). */
  database?: string | null;
  /** User (default: the superuser). */
  user?: string;
  /** Batch output: tab separated, no headers (queries whose output is parsed). */
  batch?: boolean;
}

/** Argv of the SQL client through the instance socket (statements on stdin). */
export function clientArgv(engine: DbEngine, opts: ClientCommandOptions = {}): string[] {
  const family = dbFamilyOf(engine);
  const bin = DB_CLIENTS[engine];
  const user = opts.user ?? DB_SUPERUSER[family];
  if (family === 'postgresql') {
    return [
      bin.client, '-X', '-q', '-v', 'ON_ERROR_STOP=1',
      '-h', DB_CONTAINER_PATHS.postgresql.socketDir, '-p', String(DB_CONTAINER_PORT.postgresql),
      '-U', user, `--dbname=${opts.database ?? PG_MAINTENANCE_DB}`,
      ...(opts.batch ? ['-A', '-t', '-F', '\t'] : []),
    ];
  }
  return [
    bin.client, '--no-defaults', `--socket=${DB_CONTAINER_PATHS.mysql.socket}`, `--user=${user}`,
    '--default-character-set=utf8mb4',
    ...(opts.batch ? ['--batch', '--skip-column-names', '--raw'] : []),
    ...(opts.database ? [`--database=${opts.database}`] : []),
  ];
}

/**
 * Argv of the client fed a RESTORE (tenant content on stdin), as the
 * ephemeral non-superuser `user`. The client-side commands that reach the
 * container are off: MariaDB --sandbox (no system / source / tee / pager
 * file), MySQL --system-command=OFF (8.0.40+ / 8.4.3+), no LOAD DATA LOCAL;
 * psql has no such flag: the stream starts with \restrict (restoreStream).
 */
export function restoreArgv(engine: DbEngine, database: string, user: string): string[] {
  if (dbFamilyOf(engine) === 'postgresql') return clientArgv(engine, { database, user });
  return [
    DB_CLIENTS[engine].client, '--no-defaults', `--socket=${DB_CONTAINER_PATHS.mysql.socket}`, `--user=${user}`,
    '--default-character-set=utf8mb4', '--local-infile=0',
    engine === 'mariadb' ? '--sandbox' : '--system-command=OFF',
    `--database=${database}`,
  ];
}

/** Argv of a logical dump of one database (plain SQL on stdout). */
export function dumpArgv(engine: DbEngine, database: string): string[] {
  const bin = DB_CLIENTS[engine];
  if (dbFamilyOf(engine) === 'postgresql') {
    return [
      bin.dump, '-h', DB_CONTAINER_PATHS.postgresql.socketDir, '-p', String(DB_CONTAINER_PORT.postgresql),
      '-U', DB_SUPERUSER.postgresql, '--no-owner', '--no-privileges', '--encoding=UTF8', `--dbname=${database}`,
    ];
  }
  // The database name is a whitelisted identifier ([A-Za-z0-9_], never starting with "-").
  return [
    bin.dump, '--no-defaults', `--socket=${DB_CONTAINER_PATHS.mysql.socket}`, `--user=${DB_SUPERUSER.mysql}`,
    '--single-transaction', '--routines', '--triggers', '--events', '--no-tablespaces', '--default-character-set=utf8mb4',
    database,
  ];
}

/**
 * Liveness probe over TCP INSIDE the container: the official entrypoints
 * run a temporary server on the SOCKET only (skip-networking /
 * listen_addresses='') during the first initialisation, so "answers on
 * 127.0.0.1" means the final server is up. mysqladmin ping exits 0 even on
 * "Access denied" (no password needed).
 */
export function pingArgv(engine: DbEngine): string[] {
  const bin = DB_CLIENTS[engine];
  if (dbFamilyOf(engine) === 'postgresql') {
    // -U is mandatory: the container runs as the account uid, which has no
    // /etc/passwd entry, so libpq cannot derive a default user name and
    // pg_isready exits 3 ("no attempt") forever (P2 Linux validation).
    return [bin.admin, '-q', '-h', '127.0.0.1', '-p', String(DB_CONTAINER_PORT.postgresql), '-U', DB_SUPERUSER.postgresql, '-d', PG_MAINTENANCE_DB, '-t', '3'];
  }
  return [bin.admin, '--no-defaults', '--protocol=TCP', '-h', '127.0.0.1', `-P${DB_CONTAINER_PORT.mysql}`, '--connect-timeout=3', 'ping'];
}

/** Socket path of an instance as seen by the SITE containers. */
export function siteSocketPath(family: DbFamily, instanceId: number, isDefault: boolean): string {
  if (isDefault) return family === 'postgresql' ? DB_SOCKET_PATHS.postgresqlSocket : DB_SOCKET_PATHS.mysqlSocket;
  return `${DB_SOCKET_PATHS.instancesDir}/i-${instanceId}/${DB_SOCKET_FILE[family]}`;
}

/** Profiles ordered by size (S < M < L). */
export function profileRank(p: DbTuningProfile): number {
  return p === 'S' ? 0 : p === 'M' ? 1 : 2;
}
