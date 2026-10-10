import type { CwpDatabase, CwpDbGrant, CwpDbHashKind, CwpDbObject, CwpDbUser } from '@oblimint/shared';
import { cellInt, cellStr, parseMysqlBatch, type BatchCell } from '../parsers/mysqlBatch';
import { DiscoveryContext } from './context';

// ─────────────────────────────────────────────────────────────────────────────
// Phase databases (P5-PLAN §7.4, CWP-MAP §7). No CWP registry: databases are
// owned by prefix (SUBSTRING_INDEX(name,'_',1) = account, + the extra prefixes
// of mysql_user_prefix.conf); information_schema gives sizes, engines,
// collations and the DEFINER objects; users come from mysql.userMeta (hash
// KIND only) and grants from mysql.db (Db pattern kept ESCAPED as stored).
// Every SQL here passes the guard: SELECT only, no comment, never the
// password / authentication_string / token columns.
// ─────────────────────────────────────────────────────────────────────────────

export const SYSTEM_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys', 'root_cwp', 'postfix', 'postfix_policyd', 'roundcube', 'oauthv2', 'root_cpmigrations'];
/** MySQL users of the system / CWP itself (never client users). */
export const SYSTEM_DB_USERS = new Set([
  'root', 'postfix', 'roundcube', 'mysql.sys', 'mysql.session', 'mysql.infoschema', 'mariadb.sys', 'debian-sys-maint', 'cwp',
  'oauthv2', 'policyd', 'cbpolicyd', 'postfix_policyd', 'root_cwp', 'pma', 'phpmyadmin', 'cwp_pma', 'mysql',
]);

const NOT_SYSTEM = `NOT IN (${SYSTEM_SCHEMAS.map((s) => `'${s}'`).join(', ')})`;

export const DB_SQL = {
  schemata: `SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME ${NOT_SYSTEM}`,
  tables: 'SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_COLLATION, COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS SIZE_BYTES '
    + `FROM information_schema.TABLES WHERE TABLE_SCHEMA ${NOT_SYSTEM}`,
  triggers: `SELECT TRIGGER_SCHEMA, TRIGGER_NAME, DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA ${NOT_SYSTEM}`,
  views: `SELECT TABLE_SCHEMA, TABLE_NAME, DEFINER, SECURITY_TYPE FROM information_schema.VIEWS WHERE TABLE_SCHEMA ${NOT_SYSTEM}`,
  routines: `SELECT ROUTINE_SCHEMA, ROUTINE_NAME, DEFINER, SECURITY_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA ${NOT_SYSTEM}`,
  events: `SELECT EVENT_SCHEMA, EVENT_NAME, DEFINER FROM information_schema.EVENTS WHERE EVENT_SCHEMA ${NOT_SYSTEM}`,
  grants: 'SELECT Host, Db, User, Select_priv, Insert_priv, Update_priv, Delete_priv, Create_priv, Drop_priv, Grant_priv, '
    + 'References_priv, Index_priv, Alter_priv, Create_tmp_table_priv, Lock_tables_priv, Create_view_priv, Show_view_priv, '
    + 'Create_routine_priv, Alter_routine_priv, Execute_priv, Event_priv, Trigger_priv FROM mysql.db',
} as const;

const PRIV_COLUMNS: Array<[string, string]> = [
  ['Select_priv', 'SELECT'], ['Insert_priv', 'INSERT'], ['Update_priv', 'UPDATE'], ['Delete_priv', 'DELETE'],
  ['Create_priv', 'CREATE'], ['Drop_priv', 'DROP'], ['References_priv', 'REFERENCES'], ['Index_priv', 'INDEX'],
  ['Alter_priv', 'ALTER'], ['Create_tmp_table_priv', 'CREATE TEMPORARY TABLES'], ['Lock_tables_priv', 'LOCK TABLES'],
  ['Create_view_priv', 'CREATE VIEW'], ['Show_view_priv', 'SHOW VIEW'], ['Create_routine_priv', 'CREATE ROUTINE'],
  ['Alter_routine_priv', 'ALTER ROUTINE'], ['Execute_priv', 'EXECUTE'], ['Event_priv', 'EVENT'], ['Trigger_priv', 'TRIGGER'],
];

/** mysql.db pattern has an unescaped LIKE wildcard. */
export function hasLikeWildcard(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === '\\') { i += 1; continue; }
    if (pattern[i] === '%' || pattern[i] === '_') return true;
  }
  return false;
}

/** LIKE semantics of a mysql.db Db pattern (`\_` / `\%` literal, `_` one char, `%` any). Case-sensitive (lower_case_table_names=0). */
export function likeMatches(pattern: string, name: string): boolean {
  let re = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) { re += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i += 1; continue; }
    if (c === '%') re += '[\\s\\S]*';
    else if (c === '_') re += '[\\s\\S]';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${re}$`).test(name);
}

/** Owner account of a database / user name by prefix (extra prefixes: the account whose name starts the prefix). */
export function ownerByPrefix(name: string, accounts: Set<string>, extraPrefixes: string[]): string | null {
  const prefix = name.split('_')[0];
  if (accounts.has(prefix)) return prefix;
  if (extraPrefixes.includes(prefix)) {
    const owner = [...accounts].filter((a) => prefix.startsWith(a)).sort((a, b) => b.length - a.length)[0];
    return owner ?? null;
  }
  return null;
}

function hashKind(v: BatchCell | undefined): CwpDbHashKind {
  const k = (v ?? '').trim();
  return k === 'native' || k === 'old-password' || k === 'none' ? k : 'other';
}

const isLocalHost = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '::1';

export async function phaseDatabases(ctx: DiscoveryContext): Promise<void> {
  const st = ctx.state;
  if (!st.mysqlOk) return;
  const accounts = new Set(st.accounts.map((a) => a.username));
  const extra = st.server.extraDbPrefixes;

  let schemata; let tables;
  try {
    schemata = await ctx.query(DB_SQL.schemata);
    tables = await ctx.query(DB_SQL.tables);
  } catch (err) {
    ctx.checkAbort();
    ctx.warn('mysqlUnavailable', 'warning', { kind: 'server', key: 'mysql' }, { what: 'information_schema' });
    return;
  }

  const dbs = new Map<string, CwpDatabase>();
  for (const r of schemata) {
    const name = cellStr(r.SCHEMA_NAME);
    if (!name || SYSTEM_SCHEMAS.includes(name)) continue;
    dbs.set(name, {
      name, account: ownerByPrefix(name, accounts, extra), charset: cellStr(r.DEFAULT_CHARACTER_SET_NAME), collation: cellStr(r.DEFAULT_COLLATION_NAME),
      sizeBytes: 0, tables: 0, engines: {}, memoryTables: [], tableCollations: {}, latin1Tables: 0, objects: [],
    });
  }
  for (const r of tables) {
    const db = dbs.get(cellStr(r.TABLE_SCHEMA) ?? '');
    if (!db) continue;
    db.sizeBytes += cellInt(r.SIZE_BYTES) ?? 0;
    if ((cellStr(r.TABLE_TYPE) ?? '') !== 'BASE TABLE') continue;
    db.tables += 1;
    const engine = cellStr(r.ENGINE);
    if (engine) db.engines[engine] = (db.engines[engine] ?? 0) + 1;
    if (engine && engine.toUpperCase() === 'MEMORY') db.memoryTables.push(cellStr(r.TABLE_NAME) ?? '');
    const coll = cellStr(r.TABLE_COLLATION);
    if (coll) {
      db.tableCollations[coll] = (db.tableCollations[coll] ?? 0) + 1;
      if (coll.startsWith('latin1')) db.latin1Tables += 1;
    }
  }

  const objects: Array<[keyof typeof DB_SQL, CwpDbObject['kind'], string, string]> = [
    ['triggers', 'trigger', 'TRIGGER_SCHEMA', 'TRIGGER_NAME'],
    ['views', 'view', 'TABLE_SCHEMA', 'TABLE_NAME'],
    ['routines', 'routine', 'ROUTINE_SCHEMA', 'ROUTINE_NAME'],
    ['events', 'event', 'EVENT_SCHEMA', 'EVENT_NAME'],
  ];
  for (const [sqlKey, kind, schemaCol, nameCol] of objects) {
    try {
      for (const r of await ctx.query(DB_SQL[sqlKey])) {
        const db = dbs.get(cellStr(r[schemaCol]) ?? '');
        if (!db) continue;
        const sec = (cellStr(r.SECURITY_TYPE) ?? '').toUpperCase();
        db.objects.push({
          schema: db.name, name: cellStr(r[nameCol]) ?? '', kind, definer: cellStr(r.DEFINER) ?? '',
          securityType: sec === 'DEFINER' || sec === 'INVOKER' ? sec : null,
        });
      }
    } catch (err) {
      ctx.checkAbort();
      ctx.readFailed(`information_schema ${sqlKey}`, err);
    }
  }
  for (const db of dbs.values()) {
    db.memoryTables.sort();
    db.objects.sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));
    if (!db.account) {
      ctx.warn('dbOrphan', 'info', { kind: 'database', key: db.name });
    }
  }
  st.databases = [...dbs.values()].sort((a, b) => a.name.localeCompare(b.name));

  // Users (hash kind only) + mysql.db grants.
  let users: Array<Record<string, BatchCell>> = [];
  try {
    const r = await ctx.run('mysql.userMeta', {});
    users = parseMysqlBatch(r.stdout, { header: true });
  } catch (err) {
    ctx.checkAbort();
    ctx.readFailed('mysql.userMeta', err);
  }
  let grantRows: Array<Record<string, BatchCell>> = [];
  try {
    grantRows = await ctx.query(DB_SQL.grants);
  } catch (err) {
    ctx.checkAbort();
    ctx.readFailed('mysql.db', err);
  }
  const dbNames = st.databases.map((d) => d.name);
  const grantsOf = new Map<string, CwpDbGrant[]>();
  for (const g of grantRows) {
    const user = cellStr(g.User) ?? '';
    const host = cellStr(g.Host) ?? '';
    const pattern = cellStr(g.Db) ?? '';
    const grant: CwpDbGrant = {
      dbPattern: pattern,
      wildcard: hasLikeWildcard(pattern),
      privileges: PRIV_COLUMNS.filter(([col]) => (cellStr(g[col]) ?? '').toUpperCase() === 'Y').map(([, p]) => p),
      withGrantOption: (cellStr(g.Grant_priv) ?? '').toUpperCase() === 'Y',
      matches: dbNames.filter((n) => likeMatches(pattern, n)),
    };
    const k = `${user}@${host}`;
    grantsOf.set(k, [...(grantsOf.get(k) ?? []), grant]);
  }

  for (const r of users) {
    const user = cellStr(r.User) ?? '';
    const host = cellStr(r.Host) ?? '';
    if (!user || SYSTEM_DB_USERS.has(user)) continue;
    const account = accounts.has(user) ? user : ownerByPrefix(user, accounts, extra);
    const orphan = account === null && user.includes('_');
    const remote = !isLocalHost(host);
    const max = cellInt(r.max_user_connections);
    const u: CwpDbUser = {
      user, host, account, plugin: cellStr(r.plugin) ?? '', hashKind: hashKind(r.hash_kind), remote,
      grants: (grantsOf.get(`${user}@${host}`) ?? []).sort((a, b) => a.dbPattern.localeCompare(b.dbPattern)),
      orphan, maxUserConnections: max && max > 0 ? max : null,
    };
    st.dbUsers.push(u);
    if (remote) {
      ctx.addOutside({
        kind: 'mysql-remote-user', key: `${user}@${host}`, account, code: 'mysqlRemoteClients', suggestion: 'manual',
        params: { user, host }, details: { user, host },
      });
    }
    if (orphan) {
      ctx.warn('dbUserOrphan', 'info', { kind: 'dbUser', key: `${user}@${host}` });
      ctx.addOutside({
        kind: 'mysql-orphan', key: `${user}@${host}`, account: null, code: 'dbUserOrphan', suggestion: 'manual',
        params: { user, host }, details: { user, host },
      });
    }
  }
  st.dbUsers.sort((a, b) => `${a.user}@${a.host}`.localeCompare(`${b.user}@${b.host}`));
}
