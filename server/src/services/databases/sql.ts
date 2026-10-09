import type { DbFamily, DbPrivilegeLevel } from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';

// ─────────────────────────────────────────────────────────────────────────────
// SQL of the databases module — PURE (sql.test.ts, table-driven with
// injection attempts). Invariant D2 (docs/P2-PLAN.md §11): no tenant value
// reaches a SQL client without a whitelist check; identifiers are then
// quoted (`…` / "…") and string literals escaped. The statements are fed to
// the client on stdin (never on its command line, never through a shell
// interpolation): see exec.ts.
//
// Model:
//  - MySQL family: users 'name'@'%' (socket and account network); grants on
//    `db`.* with "_" escaped (a bare "_" is a LIKE wildcard in a GRANT).
//  - PostgreSQL: each database is owned by a NOLOGIN role oblimint_o<dbId>;
//    an 'all' user is a member of it and its sessions in that database run as
//    that role (ALTER ROLE … IN DATABASE … SET role), so whatever any 'all'
//    user creates is shared; a 'readonly' user gets CONNECT + USAGE + SELECT
//    (and default privileges for future tables). PUBLIC loses CONNECT.
// ─────────────────────────────────────────────────────────────────────────────

export const DB_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;
export const DB_USER_RE = /^[A-Za-z0-9_]{1,32}$/;
/** Instance label (also enforced by a CHECK). */
export const INSTANCE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const CHARSET_RE = /^[A-Za-z0-9_]{1,32}$/;
export const COLLATION_RE = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,63}$/;

/** Ephemeral SSO users (dropped at expiry). */
export const SSO_USER_PREFIX = 'oblsso_';
export const SSO_USER_RE = /^oblsso_[0-9a-f]{8}$/;

const RESERVED_EXACT = new Set([
  'mysql', 'information_schema', 'performance_schema', 'sys', 'mariadb.sys', 'root', 'postgres',
  'template0', 'template1', 'pg_catalog', 'pg_toast', 'public', 'mysql.sys', 'mysql.session', 'mysql.infoschema',
  'healthcheck', 'pg_signal_backend', 'pg_monitor',
]);

/** Reserved names (case-insensitive): engine internals, superusers, our own prefixes. */
export function isReservedName(name: string): boolean {
  const n = name.toLowerCase();
  return RESERVED_EXACT.has(n) || n.startsWith('oblimint') || n.startsWith(SSO_USER_PREFIX) || n.startsWith('pg_');
}

/**
 * Normalises and validates a database name: whitelist, reserved names,
 * PostgreSQL lower-cased (unquoted identifiers fold to lower case: the name
 * the user types in a connection string is the stored one).
 */
export function validateDatabaseName(family: DbFamily, raw: unknown): string {
  if (typeof raw !== 'string' || !DB_NAME_RE.test(raw)) {
    throw new AppError(400, 'Database name: 1 to 64 characters among letters, digits and _', 'validation', { field: 'name' });
  }
  const name = family === 'postgresql' ? raw.toLowerCase() : raw;
  if (isReservedName(name)) throw new AppError(400, `"${name}" is a reserved name`, 'reservedName', { field: 'name' });
  return name;
}

export function validateUserName(family: DbFamily, raw: unknown): string {
  if (typeof raw !== 'string' || !DB_USER_RE.test(raw)) {
    throw new AppError(400, 'User name: 1 to 32 characters among letters, digits and _', 'validation', { field: 'username' });
  }
  const name = family === 'postgresql' ? raw.toLowerCase() : raw;
  if (isReservedName(name)) throw new AppError(400, `"${name}" is a reserved name`, 'reservedName', { field: 'username' });
  return name;
}

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
export const GENERATED_PASSWORD_LENGTH = 24;

/** A user-chosen password: 12–128 printable ASCII characters (escaped as a literal afterwards). */
export function validatePassword(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < PASSWORD_MIN || raw.length > PASSWORD_MAX || !/^[\x20-\x7e]+$/.test(raw)) {
    throw new AppError(400, `Password: ${PASSWORD_MIN} to ${PASSWORD_MAX} printable ASCII characters`, 'validation', { field: 'password' });
  }
  return raw;
}

export function validateCharset(raw: unknown): string {
  if (typeof raw !== 'string' || !CHARSET_RE.test(raw)) throw new AppError(400, 'Invalid character set', 'validation', { field: 'charset' });
  return raw;
}

export function validateCollation(raw: unknown): string {
  if (typeof raw !== 'string' || !COLLATION_RE.test(raw)) throw new AppError(400, 'Invalid collation', 'validation', { field: 'collation' });
  return raw;
}

// ── quoting (callers validated first; the quoting still escapes) ─────────────

/** Identifier: `x` (MySQL family) / "x" (PostgreSQL). */
export function quoteIdent(family: DbFamily, name: string): string {
  if (name.includes('\0')) throw new Error('NUL in identifier');
  return family === 'postgresql' ? `"${name.replace(/"/g, '""')}"` : `\`${name.replace(/`/g, '``')}\``;
}

/** String literal: MySQL escapes \ and ' (backslash escapes are on by default); PostgreSQL doubles ' (standard_conforming_strings). */
export function quoteString(family: DbFamily, value: string): string {
  if (value.includes('\0')) throw new Error('NUL in literal');
  if (family === 'postgresql') return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** MySQL account 'user'@'%'. */
export function mysqlAccount(user: string): string {
  return `${quoteString('mysql', user)}@'%'`;
}

/** MySQL grant target `db`.* with the LIKE wildcards of the database part escaped. */
export function mysqlGrantTarget(database: string): string {
  return `${quoteIdent('mysql', database.replace(/([_%\\])/g, '\\$1'))}.*`;
}

/** PostgreSQL owner role of a database. */
export function pgOwnerRole(databaseId: number): string {
  if (!Number.isInteger(databaseId) || databaseId <= 0) throw new Error('invalid database id');
  return `oblimint_o${databaseId}`;
}

/** psql meta-command switching database (name validated: [a-z0-9_]). */
function pgConnect(database: string): string {
  return `\\connect ${quoteIdent('postgresql', database)}`;
}

/** Statement batch fed to the client; `database` = the database the client connects to first (PostgreSQL). */
export interface SqlScript {
  sql: string;
  database?: string | null;
}

const join = (lines: string[]): string => `${lines.join('\n')}\n`;

// ── databases ────────────────────────────────────────────────────────────────

export interface DatabaseSpec {
  id: number;
  name: string;
  charset?: string | null;
  collation?: string | null;
}

export function createDatabaseSql(family: DbFamily, d: DatabaseSpec): SqlScript {
  if (family === 'postgresql') {
    const owner = quoteIdent('postgresql', pgOwnerRole(d.id));
    const db = quoteIdent('postgresql', d.name);
    const opts = [`OWNER ${owner}`, `ENCODING ${quoteString('postgresql', d.charset ?? 'UTF8')}`, 'TEMPLATE template0'];
    if (d.collation) opts.push(`LC_COLLATE ${quoteString('postgresql', d.collation)}`, `LC_CTYPE ${quoteString('postgresql', d.collation)}`);
    return {
      sql: join([
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteString('postgresql', pgOwnerRole(d.id))}) THEN CREATE ROLE ${owner} NOLOGIN; END IF; END $$;`,
        `CREATE DATABASE ${db} ${opts.join(' ')};`,
        `REVOKE ALL ON DATABASE ${db} FROM PUBLIC;`,
      ]),
    };
  }
  const parts = [`CREATE DATABASE ${quoteIdent('mysql', d.name)}`, `CHARACTER SET ${quoteString('mysql', d.charset ?? 'utf8mb4')}`];
  if (d.collation) parts.push(`COLLATE ${quoteString('mysql', d.collation)}`);
  return { sql: join([`${parts.join(' ')};`]) };
}

/**
 * Drops a database. MySQL: its rows of mysql.db go too (a database created
 * later under the same name must not inherit the grants of the old one).
 */
export function dropDatabaseSql(family: DbFamily, d: { id: number; name: string }): SqlScript {
  if (family === 'postgresql') {
    return {
      sql: join([
        `DROP DATABASE IF EXISTS ${quoteIdent('postgresql', d.name)} WITH (FORCE);`,
        `DROP ROLE IF EXISTS ${quoteIdent('postgresql', pgOwnerRole(d.id))};`,
      ]),
    };
  }
  const escaped = d.name.replace(/([_%\\])/g, '\\$1');
  return {
    sql: join([
      `DROP DATABASE IF EXISTS ${quoteIdent('mysql', d.name)};`,
      `DELETE FROM mysql.db WHERE Db IN (${quoteString('mysql', d.name)}, ${quoteString('mysql', escaped)});`,
      'FLUSH PRIVILEGES;',
      `DROP USER IF EXISTS ${mysqlAccount(pgOwnerRole(d.id))};`,
    ]),
  };
}

// ── users and grants ─────────────────────────────────────────────────────────

export interface GrantSpec {
  databaseId: number;
  databaseName: string;
  level: DbPrivilegeLevel;
}

function mysqlGrant(user: string, g: GrantSpec): string {
  const privs = g.level === 'all' ? 'ALL PRIVILEGES' : 'SELECT, SHOW VIEW';
  return `GRANT ${privs} ON ${mysqlGrantTarget(g.databaseName)} TO ${mysqlAccount(user)};`;
}

function mysqlRevoke(user: string, g: Pick<GrantSpec, 'databaseName'>): string {
  return `REVOKE ALL PRIVILEGES ON ${mysqlGrantTarget(g.databaseName)} FROM ${mysqlAccount(user)};`;
}

/** PostgreSQL grant statements, grouped by the database they must run in (null = any). */
function pgGrantLines(user: string, g: GrantSpec): Array<{ db: string | null; line: string }> {
  const u = quoteIdent('postgresql', user);
  const db = quoteIdent('postgresql', g.databaseName);
  const owner = quoteIdent('postgresql', pgOwnerRole(g.databaseId));
  if (g.level === 'all') {
    return [
      { db: null, line: `GRANT CONNECT, TEMPORARY ON DATABASE ${db} TO ${u};` },
      { db: null, line: `GRANT ${owner} TO ${u};` },
      { db: null, line: `ALTER ROLE ${u} IN DATABASE ${db} SET role = ${quoteString('postgresql', pgOwnerRole(g.databaseId))};` },
    ];
  }
  return [
    { db: null, line: `GRANT CONNECT ON DATABASE ${db} TO ${u};` },
    { db: g.databaseName, line: `GRANT USAGE ON SCHEMA public TO ${u};` },
    { db: g.databaseName, line: `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${u};` },
    { db: g.databaseName, line: `GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${u};` },
    { db: g.databaseName, line: `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT SELECT ON TABLES TO ${u};` },
    { db: g.databaseName, line: `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT SELECT ON SEQUENCES TO ${u};` },
  ];
}

function pgRevokeLines(user: string, g: GrantSpec): Array<{ db: string | null; line: string }> {
  const u = quoteIdent('postgresql', user);
  const db = quoteIdent('postgresql', g.databaseName);
  const owner = quoteIdent('postgresql', pgOwnerRole(g.databaseId));
  if (g.level === 'all') {
    return [
      { db: null, line: `ALTER ROLE ${u} IN DATABASE ${db} RESET role;` },
      { db: null, line: `REVOKE ${owner} FROM ${u};` },
      { db: null, line: `REVOKE ALL ON DATABASE ${db} FROM ${u};` },
    ];
  }
  return [
    { db: g.databaseName, line: `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public REVOKE ALL ON TABLES FROM ${u};` },
    { db: g.databaseName, line: `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${u};` },
    { db: g.databaseName, line: `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${u};` },
    { db: g.databaseName, line: `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${u};` },
    { db: g.databaseName, line: `REVOKE ALL ON SCHEMA public FROM ${u};` },
    { db: null, line: `REVOKE ALL ON DATABASE ${db} FROM ${u};` },
  ];
}

/** Orders PostgreSQL lines: the maintenance-db ones first, then one \connect per database. */
function pgScript(lines: Array<{ db: string | null; line: string }>, head: string[] = [], tail: string[] = []): SqlScript {
  const global = lines.filter((l) => l.db === null).map((l) => l.line);
  const perDb = new Map<string, string[]>();
  for (const l of lines) if (l.db !== null) perDb.set(l.db, [...(perDb.get(l.db) ?? []), l.line]);
  const out = [...head, ...global];
  for (const [db, ls] of perDb) out.push(pgConnect(db), ...ls);
  if (tail.length) {
    if (perDb.size) out.push(pgConnect('postgres'));
    out.push(...tail);
  }
  return { sql: join(out) };
}

export function createUserSql(family: DbFamily, user: string, password: string, grants: GrantSpec[], opts: { validUntil?: Date } = {}): SqlScript {
  if (family === 'postgresql') {
    const valid = opts.validUntil ? ` VALID UNTIL ${quoteString('postgresql', opts.validUntil.toISOString())}` : '';
    const head = [`CREATE ROLE ${quoteIdent('postgresql', user)} LOGIN PASSWORD ${quoteString('postgresql', password)}${valid};`];
    return pgScript(grants.flatMap((g) => pgGrantLines(user, g)), head);
  }
  return {
    sql: join([
      `CREATE USER ${mysqlAccount(user)} IDENTIFIED BY ${quoteString('mysql', password)};`,
      ...grants.map((g) => mysqlGrant(user, g)),
    ]),
  };
}

export function setPasswordSql(family: DbFamily, user: string, password: string): SqlScript {
  if (family === 'postgresql') {
    return { sql: join([`ALTER ROLE ${quoteIdent('postgresql', user)} PASSWORD ${quoteString('postgresql', password)};`]) };
  }
  return { sql: join([`ALTER USER ${mysqlAccount(user)} IDENTIFIED BY ${quoteString('mysql', password)};`]) };
}

/** Grant diff of a user: revokes what disappears or changes level, grants what is new or changed. */
export function updateGrantsSql(family: DbFamily, user: string, current: GrantSpec[], wanted: GrantSpec[]): SqlScript | null {
  const cur = new Map(current.map((g) => [g.databaseId, g]));
  const next = new Map(wanted.map((g) => [g.databaseId, g]));
  const revoke = current.filter((g) => next.get(g.databaseId)?.level !== g.level);
  const grant = wanted.filter((g) => cur.get(g.databaseId)?.level !== g.level);
  if (!revoke.length && !grant.length) return null;
  if (family === 'postgresql') {
    return pgScript([...revoke.flatMap((g) => pgRevokeLines(user, g)), ...grant.flatMap((g) => pgGrantLines(user, g))]);
  }
  return { sql: join([...revoke.map((g) => mysqlRevoke(user, g)), ...grant.map((g) => mysqlGrant(user, g))]) };
}

/**
 * Drops a user. PostgreSQL: what it owns in each database of the instance
 * is handed to the database owner role, its privileges there are dropped,
 * then the role.
 */
export function dropUserSql(family: DbFamily, user: string, databases: Array<{ id: number; name: string }>): SqlScript {
  if (family === 'postgresql') {
    const u = quoteIdent('postgresql', user);
    const lines = databases.flatMap((d) => [
      { db: d.name, line: `REASSIGN OWNED BY ${u} TO ${quoteIdent('postgresql', pgOwnerRole(d.id))};` },
      { db: d.name, line: `DROP OWNED BY ${u};` },
    ]);
    return pgScript(lines, [], [`DROP ROLE IF EXISTS ${u};`]);
  }
  return { sql: join([`DROP USER IF EXISTS ${mysqlAccount(user)};`]) };
}

// ── measurements / maintenance ───────────────────────────────────────────────

/** Size of every database: lines "<name>\t<bytes>". */
export function sizeQuerySql(family: DbFamily): SqlScript {
  if (family === 'postgresql') {
    return { sql: join(['SELECT datname, pg_database_size(datname) FROM pg_database WHERE NOT datistemplate;']) };
  }
  return {
    sql: join([
      'SELECT table_schema, COALESCE(SUM(data_length + index_length), 0) FROM information_schema.TABLES GROUP BY table_schema;',
    ]),
  };
}

/** Lists the SSO users present in the instance (one name per line). */
export function listSsoUsersSql(family: DbFamily): SqlScript {
  if (family === 'postgresql') {
    return { sql: join([`SELECT rolname FROM pg_roles WHERE rolname LIKE 'oblsso\\_%';`]) };
  }
  return { sql: join([`SELECT DISTINCT User FROM mysql.user WHERE User LIKE 'oblsso\\_%';`]) };
}

/** Parses "<name>\t<number>" lines (batch output) into a map. */
export function parseSizeOutput(stdout: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of stdout.split(/\r?\n/)) {
    const [name, bytes] = line.split('\t');
    if (!name || bytes === undefined) continue;
    const n = Number(bytes.trim());
    if (Number.isFinite(n) && n >= 0) out.set(name.trim(), Math.round(n));
  }
  return out;
}

/** Engine-internal schemas / databases: never counted in a measured size. */
export const SYSTEM_SCHEMAS: Record<DbFamily, ReadonlySet<string>> = {
  mysql: new Set(['mysql', 'information_schema', 'performance_schema', 'sys']),
  postgresql: new Set(['postgres', 'template0', 'template1']),
};

/**
 * PostgreSQL pg_hba.conf of an instance: password (SCRAM) everywhere, and
 * the superuser `postgres` refused over TCP (account network, external
 * port) — like root@localhost of the MySQL family, it only exists on the
 * socket. Written by the server itself (COPY … TO, superuser over the
 * socket) then reloaded. `path` = data directory file inside the container.
 */
export const PG_HBA_LINES = [
  'local all all scram-sha-256',
  'host all postgres all reject',
  'host all all all scram-sha-256',
] as const;

export function pgHbaLockdownSql(path: string): SqlScript {
  // Order matters (first matching line wins): explicit ordinal, ORDER BY.
  const rows = PG_HBA_LINES.map((l, i) => `(${i + 1}, ${quoteString('postgresql', l)})`).join(', ');
  return {
    sql: join([
      `COPY (SELECT line FROM (VALUES ${rows}) AS hba(n, line) ORDER BY n) TO ${quoteString('postgresql', path)};`,
      'SELECT pg_reload_conf();',
    ]),
  };
}

/**
 * MySQL family: restore account of a database, 'oblimint_o<dbId>'@'%' (the
 * counterpart of the PostgreSQL owner role). A restore runs as it — never
 * as root — and it is the DEFINER of the views / triggers / routines the
 * dump creates (restore.ts strips the dump's DEFINER clauses), so it is
 * never dropped while the database lives: between restores it is LOCKED
 * with a random password nobody knows (a locked definer still runs).
 */
export function mysqlRestoreUser(databaseId: number): string {
  return pgOwnerRole(databaseId); // same name scheme: oblimint_o<dbId> (reserved prefix)
}

export function mysqlRestoreUserUnlockSql(d: { id: number; name: string }, password: string): SqlScript {
  const acct = mysqlAccount(mysqlRestoreUser(d.id));
  const pw = quoteString('mysql', password);
  return {
    sql: join([
      `CREATE USER IF NOT EXISTS ${acct} IDENTIFIED BY ${pw} ACCOUNT LOCK;`,
      `ALTER USER ${acct} IDENTIFIED BY ${pw} ACCOUNT UNLOCK;`,
      `GRANT ALL PRIVILEGES ON ${mysqlGrantTarget(d.name)} TO ${acct};`,
    ]),
  };
}

export function mysqlRestoreUserLockSql(databaseId: number, password: string): SqlScript {
  return { sql: join([`ALTER USER IF EXISTS ${mysqlAccount(mysqlRestoreUser(databaseId))} IDENTIFIED BY ${quoteString('mysql', password)} ACCOUNT LOCK;`]) };
}

/** Restore preamble (PostgreSQL runs the dump as the database owner role: objects belong to it). */
export function pgRestoreOptions(databaseId: number): string {
  return `-c role=${pgOwnerRole(databaseId)}`;
}
