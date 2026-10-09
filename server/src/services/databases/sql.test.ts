import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../middleware/errorHandler';
import {
  createDatabaseSql, createUserSql, dropDatabaseSql, dropUserSql, isReservedName, listSsoUsersSql, mysqlGrantTarget, parseSizeOutput,
  pgOwnerRole, quoteIdent, quoteString, setPasswordSql, updateGrantsSql, validateCharset, validateCollation, validateDatabaseName,
  validatePassword, validateUserName, mysqlRestoreUserUnlockSql, mysqlRestoreUserLockSql, pgHbaLockdownSql, PG_HBA_LINES, SYSTEM_SCHEMAS,
} from './sql';

// SQL builders and identifier validation (D2): table-driven, injection attempts included.

function code(fn: () => unknown): string | undefined {
  try { fn(); return undefined; } catch (err) { return err instanceof AppError ? (err.code ?? 'AppError') : 'other'; }
}

test('database names: whitelist, reserved, PostgreSQL lower-cased', () => {
  const cases: Array<[string, unknown, string | null, string | undefined]> = [
    ['mysql', 'wp_blog', 'wp_blog', undefined],
    ['mysql', 'Shop2', 'Shop2', undefined],
    ['postgresql', 'Shop2', 'shop2', undefined],
    ['mysql', 'a'.repeat(64), 'a'.repeat(64), undefined],
    ['mysql', 'a'.repeat(65), null, 'validation'],
    ['mysql', '', null, 'validation'],
    ['mysql', 'x`; DROP DATABASE mysql; --', null, 'validation'],
    ['mysql', "x'or'1'='1", null, 'validation'],
    ['postgresql', 'x"; DROP ROLE postgres; --', null, 'validation'],
    ['mysql', 'café', null, 'validation'],
    ['mysql', 'a b', null, 'validation'],
    ['mysql', 'a-b', null, 'validation'],
    ['mysql', 'a.b', null, 'validation'],
    ['mysql', 'a\nb', null, 'validation'],
    ['mysql', '-opt', null, 'validation'],
    ['mysql', 42, null, 'validation'],
    ['mysql', null, null, 'validation'],
    ['mysql', 'mysql', null, 'reservedName'],
    ['mysql', 'MySQL', null, 'reservedName'],
    ['mysql', 'information_schema', null, 'reservedName'],
    ['mysql', 'performance_schema', null, 'reservedName'],
    ['mysql', 'sys', null, 'reservedName'],
    ['postgresql', 'postgres', null, 'reservedName'],
    ['postgresql', 'template0', null, 'reservedName'],
    ['postgresql', 'Template1', null, 'reservedName'],
    ['mysql', 'oblimint_x', null, 'reservedName'],
    ['mysql', 'OBLIMINT', null, 'reservedName'],
    ['mysql', 'oblsso_deadbeef', null, 'reservedName'],
    ['postgresql', 'pg_stuff', null, 'reservedName'],
  ];
  for (const [family, input, out, err] of cases) {
    const label = `${family} ${JSON.stringify(input)}`;
    assert.equal(code(() => validateDatabaseName(family as 'mysql', input)), err, label);
    if (out !== null) assert.equal(validateDatabaseName(family as 'mysql', input), out, label);
  }
});

test('user names: whitelist ≤ 32, reserved (root, postgres, mariadb.sys, oblimint*, oblsso_*)', () => {
  const ok = ['app', 'WP_user_1', 'a'.repeat(32)];
  for (const u of ok) assert.equal(code(() => validateUserName('mysql', u)), undefined, u);
  const bad: Array<[unknown, string]> = [
    ['a'.repeat(33), 'validation'], ["root'@'%", 'validation'], ['mariadb.sys', 'validation'], ['us er', 'validation'],
    ['root', 'reservedName'], ['ROOT', 'reservedName'], ['postgres', 'reservedName'], ['mysql', 'reservedName'],
    ['oblimint_admin', 'reservedName'], ['oblsso_12345678', 'reservedName'], ['healthcheck', 'reservedName'],
  ];
  for (const [u, c] of bad) assert.equal(code(() => validateUserName('mysql', u)), c, String(u));
  assert.equal(validateUserName('postgresql', 'App'), 'app');
  assert.ok(isReservedName('mariadb.sys'));
});

test('passwords, charsets, collations', () => {
  assert.equal(code(() => validatePassword('short')), 'validation');
  assert.equal(code(() => validatePassword('x'.repeat(129))), 'validation');
  assert.equal(code(() => validatePassword('twelve chars')), undefined);
  assert.equal(code(() => validatePassword("quote'and\\back")), undefined, 'escaped later, not refused');
  assert.equal(code(() => validatePassword('line\nbreak-123456')), 'validation');
  assert.equal(code(() => validatePassword('nul\0character-1234')), 'validation');
  assert.equal(code(() => validatePassword('unicodé-password')), 'validation');
  assert.equal(code(() => validateCharset('utf8mb4')), undefined);
  assert.equal(code(() => validateCharset("utf8'; DROP")), 'validation');
  assert.equal(code(() => validateCollation('utf8mb4_unicode_ci')), undefined);
  assert.equal(code(() => validateCollation('fr_FR.UTF-8')), undefined);
  assert.equal(code(() => validateCollation("C' OR 1=1")), 'validation');
  assert.equal(code(() => validateCollation('-x')), 'validation');
});

test('quoting escapes the delimiters', () => {
  assert.equal(quoteIdent('mysql', 'a`b'), '`a``b`');
  assert.equal(quoteIdent('postgresql', 'a"b'), '"a""b"');
  assert.equal(quoteString('mysql', "it's"), "'it\\'s'");
  assert.equal(quoteString('mysql', 'back\\slash'), "'back\\\\slash'");
  assert.equal(quoteString('mysql', "\\'; DROP USER root; --"), "'\\\\\\'; DROP USER root; --'");
  assert.equal(quoteString('postgresql', "it's"), "'it''s'");
  assert.equal(quoteString('postgresql', 'back\\slash'), "'back\\slash'");
  assert.throws(() => quoteString('mysql', 'a\0b'));
  assert.throws(() => quoteIdent('mysql', 'a\0b'));
  // LIKE wildcards of GRANT targets are escaped
  assert.equal(mysqlGrantTarget('my_db'), '`my\\_db`.*');
  assert.equal(pgOwnerRole(12), 'oblimint_o12');
  assert.throws(() => pgOwnerRole(0));
});

test('MySQL statements', () => {
  assert.equal(createDatabaseSql('mysql', { id: 1, name: 'shop', charset: 'utf8mb4' }).sql, "CREATE DATABASE `shop` CHARACTER SET 'utf8mb4';\n");
  assert.equal(createDatabaseSql('mysql', { id: 1, name: 'shop', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' }).sql,
    "CREATE DATABASE `shop` CHARACTER SET 'utf8mb4' COLLATE 'utf8mb4_unicode_ci';\n");
  const drop = dropDatabaseSql('mysql', { id: 1, name: 'my_db' }).sql;
  assert.match(drop, /DROP DATABASE IF EXISTS `my_db`;/);
  assert.match(drop, /DELETE FROM mysql\.db WHERE Db IN \('my_db', 'my\\\\_db'\);/);
  assert.match(drop, /DROP USER IF EXISTS 'oblimint_o1'@'%';\n$/, 'its restore account goes with it');
  const pw = "pa'ss\\word-123";
  const user = createUserSql('mysql', 'app', pw, [
    { databaseId: 1, databaseName: 'my_db', level: 'all' },
    { databaseId: 2, databaseName: 'stats', level: 'readonly' },
  ]).sql;
  assert.equal(user, [
    "CREATE USER 'app'@'%' IDENTIFIED BY 'pa\\'ss\\\\word-123';",
    "GRANT ALL PRIVILEGES ON `my\\_db`.* TO 'app'@'%';",
    "GRANT SELECT, SHOW VIEW ON `stats`.* TO 'app'@'%';",
    '',
  ].join('\n'));
  assert.equal(setPasswordSql('mysql', 'app', 'x'.repeat(12)).sql, `ALTER USER 'app'@'%' IDENTIFIED BY '${'x'.repeat(12)}';\n`);
  assert.equal(dropUserSql('mysql', 'app', []).sql, "DROP USER IF EXISTS 'app'@'%';\n");
  assert.match(listSsoUsersSql('mysql').sql, /LIKE 'oblsso\\_%'/);
});

test('grant diff: revoke what disappears or changes, grant what is new or changes', () => {
  const cur = [
    { databaseId: 1, databaseName: 'a', level: 'all' as const },
    { databaseId: 2, databaseName: 'b', level: 'readonly' as const },
    { databaseId: 3, databaseName: 'c', level: 'all' as const },
  ];
  const next = [
    { databaseId: 1, databaseName: 'a', level: 'all' as const },
    { databaseId: 2, databaseName: 'b', level: 'all' as const },
    { databaseId: 4, databaseName: 'd', level: 'readonly' as const },
  ];
  assert.equal(updateGrantsSql('mysql', 'u', cur, cur), null, 'no change → no SQL');
  assert.equal(updateGrantsSql('mysql', 'u', cur, next)!.sql, [
    "REVOKE ALL PRIVILEGES ON `b`.* FROM 'u'@'%';",
    "REVOKE ALL PRIVILEGES ON `c`.* FROM 'u'@'%';",
    "GRANT ALL PRIVILEGES ON `b`.* TO 'u'@'%';",
    "GRANT SELECT, SHOW VIEW ON `d`.* TO 'u'@'%';",
    '',
  ].join('\n'));
});

test('PostgreSQL statements: owner role, PUBLIC revoked, per-database \\connect', () => {
  const create = createDatabaseSql('postgresql', { id: 5, name: 'shop' }).sql;
  assert.match(create, /CREATE ROLE "oblimint_o5" NOLOGIN/);
  assert.match(create, /CREATE DATABASE "shop" OWNER "oblimint_o5" ENCODING 'UTF8' TEMPLATE template0;/);
  assert.match(create, /REVOKE ALL ON DATABASE "shop" FROM PUBLIC;/);
  const drop = dropDatabaseSql('postgresql', { id: 5, name: 'shop' }).sql;
  assert.equal(drop, 'DROP DATABASE IF EXISTS "shop" WITH (FORCE);\nDROP ROLE IF EXISTS "oblimint_o5";\n');
  const until = new Date('2026-01-01T00:00:00.000Z');
  const user = createUserSql('postgresql', 'app', "p'w-123456789", [
    { databaseId: 5, databaseName: 'shop', level: 'all' },
    { databaseId: 6, databaseName: 'stats', level: 'readonly' },
  ], { validUntil: until }).sql;
  const lines = user.trim().split('\n');
  assert.equal(lines[0], `CREATE ROLE "app" LOGIN PASSWORD 'p''w-123456789' VALID UNTIL '2026-01-01T00:00:00.000Z';`);
  assert.ok(lines.includes('GRANT "oblimint_o5" TO "app";'));
  assert.ok(lines.includes(`ALTER ROLE "app" IN DATABASE "shop" SET role = 'oblimint_o5';`));
  const connectAt = lines.indexOf('\\connect "stats"');
  assert.ok(connectAt > 0, 'readonly grants run inside the database');
  assert.ok(lines.slice(connectAt).includes('GRANT SELECT ON ALL TABLES IN SCHEMA public TO "app";'));
  assert.ok(lines.slice(connectAt).includes('ALTER DEFAULT PRIVILEGES FOR ROLE "oblimint_o6" IN SCHEMA public GRANT SELECT ON TABLES TO "app";'));
  const dropUser = dropUserSql('postgresql', 'app', [{ id: 5, name: 'shop' }]).sql.trim().split('\n');
  assert.deepEqual(dropUser, [
    '\\connect "shop"',
    'REASSIGN OWNED BY "app" TO "oblimint_o5";',
    'DROP OWNED BY "app";',
    '\\connect "postgres"',
    'DROP ROLE IF EXISTS "app";',
  ]);
  assert.equal(dropUserSql('postgresql', 'app', []).sql, 'DROP ROLE IF EXISTS "app";\n');
});

test('MySQL restore account: ALL on its database only, locked between restores', () => {
  const unlock = mysqlRestoreUserUnlockSql({ id: 7, name: 'my_db' }, "pw'x").sql;
  assert.equal(unlock, [
    "CREATE USER IF NOT EXISTS 'oblimint_o7'@'%' IDENTIFIED BY 'pw\\'x' ACCOUNT LOCK;",
    "ALTER USER 'oblimint_o7'@'%' IDENTIFIED BY 'pw\\'x' ACCOUNT UNLOCK;",
    "GRANT ALL PRIVILEGES ON `my\\_db`.* TO 'oblimint_o7'@'%';",
  ].join('\n') + '\n');
  assert.doesNotMatch(unlock, /\*\.\*|WITH GRANT OPTION/, 'never global, never re-grantable');
  assert.equal(mysqlRestoreUserLockSql(7, 'z').sql, "ALTER USER IF EXISTS 'oblimint_o7'@'%' IDENTIFIED BY 'z' ACCOUNT LOCK;\n");
  assert.ok(isReservedName('oblimint_o7'), 'a client can never create or take it');
});

test('PostgreSQL pg_hba lockdown: superuser refused over TCP, ordered lines, reload', () => {
  assert.deepEqual([...PG_HBA_LINES], ['local all all scram-sha-256', 'host all postgres all reject', 'host all all all scram-sha-256']);
  const s = pgHbaLockdownSql('/var/lib/postgresql/data/pg_hba.conf').sql;
  assert.equal(s, "COPY (SELECT line FROM (VALUES (1, 'local all all scram-sha-256'), (2, 'host all postgres all reject'), "
    + "(3, 'host all all all scram-sha-256')) AS hba(n, line) ORDER BY n) TO '/var/lib/postgresql/data/pg_hba.conf';\nSELECT pg_reload_conf();\n");
  assert.ok(SYSTEM_SCHEMAS.mysql.has('performance_schema') && SYSTEM_SCHEMAS.postgresql.has('postgres'));
  assert.ok(!SYSTEM_SCHEMAS.mysql.has('shop'));
});

test('size output parsing', () => {
  const m = parseSizeOutput('shop\t1048576\nmysql\t123\r\nbroken\nneg\t-1\nnan\tabc\n\n');
  assert.deepEqual([...m.entries()], [['shop', 1048576], ['mysql', 123]]);
});
