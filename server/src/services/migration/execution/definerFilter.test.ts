import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { createDefinerFilter, dangerousStatement, DumpRefusedError, unquoteMysqlName } from './definerFilter';
import { scrubSecrets } from './errors';

// DEFINER filter of the CWP dumps (docs/P5-PLAN.md D-DB, MG7): pure, every quoting style,
// versioned comments, chunk boundaries, hostile names, refused statements.

const RESTORE = 'oblimint_o42';

async function run(input: string | Buffer[], migrated: string[] = ['acct1_wp', 'acct1'], chunk = 0): Promise<{ out: string; stats: ReturnType<typeof createDefinerFilter>['stats'] }> {
  const filter = createDefinerFilter({ migratedUsers: migrated, restoreUser: RESTORE });
  const parts: Buffer[] = [];
  let chunks: Buffer[];
  if (Array.isArray(input)) chunks = input;
  else if (chunk > 0) {
    const buf = Buffer.from(input, 'latin1');
    chunks = [];
    for (let i = 0; i < buf.length; i += chunk) chunks.push(buf.subarray(i, i + chunk));
  } else chunks = [Buffer.from(input, 'latin1')];
  await pipeline(Readable.from(chunks), filter, new Writable({ write(c, _e, cb) { parts.push(c as Buffer); cb(); } }));
  return { out: Buffer.concat(parts).toString('latin1'), stats: filter.stats };
}

const TRIGGER = [
  'DELIMITER ;;',
  "/*!50003 CREATE*/ /*!50017 DEFINER=`acct1_wp`@`localhost`*/ /*!50003 TRIGGER trg BEFORE INSERT ON t FOR EACH ROW SET NEW.a = 1 */;;",
  'DELIMITER ;',
].join('\n');

test('kept definer of a migrated user: host rewritten to %', async () => {
  const { out, stats } = await run(`${TRIGGER}\n`);
  assert.match(out, /\/\*!50017 DEFINER='acct1_wp'@'%'\*\//);
  assert.equal(stats.kept, 1);
  assert.equal(stats.foreign, 0);
});

test('view definer inside /*!50013 … */ and every quoting style', async () => {
  const lines = [
    "/*!50001 CREATE ALGORITHM=UNDEFINED */",
    "/*!50013 DEFINER=`acct1`@`%` SQL SECURITY DEFINER */",
    "/*!50001 VIEW `v` AS select 1 AS `a` */;",
    "CREATE DEFINER='acct1_wp'@'10.0.0.1' PROCEDURE p() BEGIN END;",
    'CREATE DEFINER="acct1"@"localhost" FUNCTION f() RETURNS INT RETURN 1;',
    'CREATE DEFINER=acct1_wp@localhost EVENT e ON SCHEDULE EVERY 1 DAY DO SELECT 1;',
    'CREATE DEFINER = `acct1` @ `localhost` PROCEDURE q() BEGIN END;',
    'CREATE DEFINER=CURRENT_USER PROCEDURE r() BEGIN END;',
    'CREATE DEFINER=CURRENT_USER() PROCEDURE s() BEGIN END;',
  ].join('\n');
  const { out, stats } = await run(`${lines}\n`);
  assert.equal(stats.kept, 5);
  assert.equal(stats.foreign, 0);
  assert.equal((out.match(/DEFINER='acct1(_wp)?'@'%'/g) ?? []).length, 5);
  assert.match(out, /DEFINER=CURRENT_USER PROCEDURE r/);
  assert.match(out, /DEFINER=CURRENT_USER\(\) PROCEDURE s/);
  assert.doesNotMatch(out, /localhost|10\.0\.0\.1/);
});

test('foreign definers become the restore user and are counted', async () => {
  const input = [
    'DELIMITER ;;',
    "/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER a BEFORE INSERT ON t FOR EACH ROW SET NEW.a=1 */;;",
    "/*!50003 CREATE*/ /*!50017 DEFINER=`acct2_other`@`localhost`*/ /*!50003 TRIGGER b BEFORE INSERT ON t FOR EACH ROW SET NEW.a=1 */;;",
    "/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`%`*/ /*!50003 TRIGGER c BEFORE INSERT ON t FOR EACH ROW SET NEW.a=1 */;;",
    'DELIMITER ;',
    '',
  ].join('\n');
  const { out, stats } = await run(input);
  assert.equal(stats.foreign, 3);
  assert.deepEqual(stats.foreignUsers.sort(), ['acct2_other', 'root']);
  assert.equal((out.match(/DEFINER='oblimint_o42'@'%'/g) ?? []).length, 3);
  assert.doesNotMatch(out, /`root`/);
});

test('hostile names: escaped backticks / quotes never escape the rewrite', async () => {
  const input = [
    "CREATE DEFINER=`ro``ot`@`h` PROCEDURE a() BEGIN END;",
    "CREATE DEFINER='acct1\\'x'@'h' PROCEDURE b() BEGIN END;",
    "CREATE DEFINER='acct1''y'@'h' PROCEDURE c() BEGIN END;",
    "CREATE DEFINER=`acct1_wp`@`h*/ GRANT ALL ON *.* TO x; /*` PROCEDURE d() BEGIN END;",
    '',
  ].join('\n');
  const { out, stats } = await run(input, ['acct1_wp', "acct1'x"]);
  // ro`ot / acct1'y are foreign; acct1'x is migrated (re-quoted safely); the hostile host is dropped entirely.
  assert.equal(stats.foreign, 2);
  assert.equal(stats.kept, 2);
  assert.match(out, /DEFINER='acct1\\'x'@'%' PROCEDURE b/);
  assert.match(out, /DEFINER='acct1_wp'@'%' PROCEDURE d/);
  assert.doesNotMatch(out, /GRANT ALL/);
  assert.equal(unquoteMysqlName('`a``b`'), 'a`b');
  assert.equal(unquoteMysqlName("'a\\'b'"), "a'b");
  assert.equal(unquoteMysqlName("'a''b'"), "a'b");
  assert.equal(unquoteMysqlName('"a""b"'), 'a"b');
});

test('data lines pass through untouched (a DEFINER text in a row is data)', async () => {
  const row = "INSERT INTO `posts` VALUES (1,'how to use DEFINER=`root`@`localhost` in MySQL\\n','GRANT ALL');";
  const { out, stats } = await run(`${row}\n`);
  assert.equal(out, `${row}\n`);
  assert.equal(stats.foreign, 0);
});

test('inside a DELIMITER ;; block every line is filtered, even one starting with INSERT', async () => {
  const input = [
    'DELIMITER ;;',
    'CREATE DEFINER=`acct1`@`localhost` PROCEDURE p()',
    'BEGIN',
    "INSERT INTO log VALUES (1); /* DEFINER=`root`@`localhost` */",
    'END ;;',
    'DELIMITER ;',
    "INSERT INTO t VALUES ('DEFINER=`root`@`localhost`');",
    '',
  ].join('\n');
  const { out, stats } = await run(input);
  assert.equal(stats.kept, 1);
  assert.equal(stats.foreign, 1); // the one inside the body
  assert.match(out, /INSERT INTO t VALUES \('DEFINER=`root`@`localhost`'\);/);
});

test('chunk boundaries: same output whatever the chunk size', async () => {
  const big = [
    '-- MariaDB dump',
    '/*!40101 SET NAMES utf8mb4 */;',
    'DROP TABLE IF EXISTS `t`;',
    'CREATE TABLE `t` (`a` int) ENGINE=InnoDB DEFAULT CHARSET=latin1;',
    `INSERT INTO \`t\` VALUES ${Array.from({ length: 400 }, (_, i) => `(${i})`).join(',')};`,
    TRIGGER,
    "/*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */",
    "caf\xe9 \xff\xfe binary-ish latin1 bytes",
    '',
  ].join('\n');
  const reference = await run(big);
  for (const size of [1, 2, 3, 7, 13, 63, 64, 65, 100, 4096]) {
    const r = await run(big, undefined, size);
    assert.equal(r.out, reference.out, `chunk ${size}`);
    assert.equal(r.stats.kept, 1);
    assert.equal(r.stats.foreign, 1);
  }
  assert.match(reference.out, /caf\xe9 \xff\xfe/);
});

test('last line without a newline is filtered too', async () => {
  const { out, stats } = await run('CREATE DEFINER=`root`@`h` PROCEDURE p() BEGIN END;');
  assert.equal(stats.foreign, 1);
  assert.equal(out, "CREATE DEFINER='oblimint_o42'@'%' PROCEDURE p() BEGIN END;");
});

test('dangerous statements fail the import', async () => {
  for (const line of [
    "CREATE USER 'x'@'%' IDENTIFIED BY 'p';",
    "GRANT ALL PRIVILEGES ON *.* TO 'x'@'%';",
    "/*!50003 GRANT ALL ON *.* TO 'x'@'%' */;",
    "DROP USER 'acct1'@'%';",
    'USE `mysql`;',
    'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `other`;',
    "SET PASSWORD FOR 'root'@'localhost' = PASSWORD('x');",
    'SET GLOBAL event_scheduler = ON;',
    "ALTER USER 'root'@'localhost' IDENTIFIED BY 'x';",
    "LOAD DATA INFILE '/etc/passwd' INTO TABLE t;",
    '\\! sh -c id',
    '  revoke all on *.* from x;',
  ]) {
    await assert.rejects(run(`SELECT 1;\n${line}\n`), (err: unknown) => err instanceof DumpRefusedError && err.line === 2, line);
  }
  // mysqldump's own session lines stay allowed.
  for (const ok of [
    '/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;',
    "/*!40103 SET TIME_ZONE='+00:00' */;",
    '/*!40000 ALTER TABLE `t` DISABLE KEYS */;',
    'LOCK TABLES `t` WRITE;',
    'UNLOCK TABLES;',
    '-- GRANT in a comment line',
    'SET NEW.a = 1;',
  ]) assert.equal(dangerousStatement(ok), null, ok);
});

test('a data line hiding a statement is still refused when it does not start with INSERT', async () => {
  await assert.rejects(run("CREATE TABLE t (a int);\nGRANT SELECT ON t TO x;\n"), DumpRefusedError);
});

test('a definer smuggled after the end of a data statement is still rewritten', async () => {
  const input = [
    "INSERT INTO t VALUES (1,'a;b'); CREATE DEFINER=`root`@`localhost` PROCEDURE p() SQL SECURITY DEFINER SELECT 1;",
    "INSERT INTO t VALUES ('it\\'s; x'),('y');INSERT INTO t VALUES (2);CREATE DEFINER=root@localhost PROCEDURE q() SELECT 1;",
    '',
  ].join('\n');
  for (const size of [0, 1, 5, 17]) {
    const { out, stats } = await run(input, undefined, size);
    assert.equal(stats.foreign, 2, `chunk ${size}`);
    assert.doesNotMatch(out, /root/);
    // The data part is untouched (the ';' inside the literal never ends the statement).
    assert.match(out, /^INSERT INTO t VALUES \(1,'a;b'\); CREATE DEFINER='oblimint_o42'@'%' PROCEDURE p\(\) SQL SECURITY DEFINER/);
    assert.match(out, /INSERT INTO t VALUES \('it\\'s; x'\),\('y'\);INSERT INTO t VALUES \(2\);CREATE DEFINER='oblimint_o42'@'%' PROCEDURE q/);
  }
  // A statement hidden after a data statement is checked like any other.
  await assert.rejects(run("INSERT INTO t VALUES (1); GRANT ALL ON *.* TO x;\n"), DumpRefusedError);
  await assert.rejects(run("SELECT 1; GRANT ALL ON *.* TO x;\n"), DumpRefusedError);
});

test('a literal spanning lines never makes a new data statement', async () => {
  // The client is still inside the literal of line 1: line 2 is not an INSERT, its CREATE runs.
  const { out, stats } = await run("INSERT INTO t VALUES ('abc\nINSERT'); CREATE DEFINER=`root`@`h` PROCEDURE p() SELECT 1;\n");
  assert.equal(stats.foreign, 1);
  assert.doesNotMatch(out, /`root`/);
  // CREATE OR / REPLACE DEFINER=… : a line starting with REPLACE inside an open statement is filtered.
  const r2 = await run('CREATE OR\nREPLACE DEFINER=`root`@`h` PROCEDURE p() SELECT 1;\n');
  assert.equal(r2.stats.foreign, 1);
  assert.doesNotMatch(r2.out, /`root`/);
});

test('host-less, role and CURRENT_ROLE definers are rewritten; unreadable ones refused', async () => {
  const { out, stats } = await run([
    'CREATE DEFINER=someuser PROCEDURE a() SELECT 1;',
    'CREATE DEFINER=`acct1` PROCEDURE b() SELECT 1;',
    'CREATE DEFINER=CURRENT_ROLE PROCEDURE c() SELECT 1;',
    'CREATE DEFINER /* x */ = `root` /**/ @ /*!50017 `localhost` */ PROCEDURE d() SELECT 1;',
    '',
  ].join('\n'));
  assert.equal(stats.kept, 1);
  assert.equal(stats.foreign, 3);
  assert.match(out, /DEFINER='acct1'@'%' PROCEDURE b/);
  assert.equal((out.match(/DEFINER='oblimint_o42'@'%'/g) ?? []).length, 3);
  assert.doesNotMatch(out, /someuser|CURRENT_ROLE|`root`/);
  for (const bad of [
    'CREATE DEFINER=(SELECT 1) PROCEDURE p() SELECT 1;\n',
    'CREATE DEFINER\n= `root`@`localhost` PROCEDURE p() SELECT 1;\n',
    'CREATE DEFINER /*\n*/ = `root`@`localhost` PROCEDURE p() SELECT 1;\n',
  ]) await assert.rejects(run(bad), DumpRefusedError, bad);
});

test('data statements: no comment, client command or variable outside the literals', async () => {
  for (const bad of [
    "INSERT INTO t VALUES (1) /*M!100000 ; CREATE DEFINER=root@x PROCEDURE p() SELECT 1 */;\n",
    "INSERT INTO t VALUES (1) \\g CREATE DEFINER=root@x PROCEDURE p() SELECT 1;\n",
    'INSERT INTO t VALUES (@x := 1);\n',
    'INSERT INTO t VALUES (1) # comment\n;\n',
  ]) await assert.rejects(run(bad), DumpRefusedError, bad);
  // Arithmetic is not a comment ('--' needs a blank after it).
  const { out } = await run('INSERT INTO t VALUES (1--1);\n');
  assert.equal(out, 'INSERT INTO t VALUES (1--1);\n');
});

test('session changes that would desynchronise the splitting are refused', async () => {
  for (const bad of [
    "SET sql_mode = 'NO_BACKSLASH_ESCAPES';\n",
    "SET @@session.sql_mode = CONCAT('NO_BACKSLASH', '_ESCAPES');\n",
    "SET @x = 'a'; SET sql_mode = @x;\n",
    "SET @OLD_SQL_MODE = CONCAT('x', 'y');\n",
    'SET sql_mode = 33554432;\n',
    "SET NAMES 'gbk';\n",
    'SET character_set_client = sjis;\n',
    "SELECT 'x' INTO @saved_sql_mode;\n",
  ]) await assert.rejects(run(bad), DumpRefusedError, bad);
  // mysqldump's own session lines stay allowed.
  const ok = [
    "/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;",
    '/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;',
    '/*!40101 SET character_set_client = utf8mb4 */;',
    '/*!50003 SET @saved_cs_client      = @@character_set_client */ ;',
    '/*!50003 SET character_set_client  = @saved_cs_client */ ;',
    "/*!50003 SET sql_mode              = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO' */ ;",
    '/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;',
    '/*!50003 SET sql_mode              = @saved_sql_mode */ ;',
    '/*M!999999\\- enable the sandbox mode */',
    'CREATE TABLE `j` (`a` varchar(10) CHARACTER SET sjis) ENGINE=InnoDB;',
    '',
  ].join('\n');
  const { out } = await run(ok);
  assert.equal(out, ok);
});

test('scrubSecrets masks hashes, keys and passwords', () => {
  const text = [
    "ERROR 1064 near 'IDENTIFIED BY PASSWORD '*6BB4837EB74329105EE4568DDA7DC67ED2CA2AD9''",
    'hash $2y$10$abcdefghijklmnopqrstuuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012',
    '{SHA512-CRYPT}$6$saltsalt$abcdefghijklmnop',
    '-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----',
    'MYSQL_PWD=hunter2',
  ].join('\n');
  const out = scrubSecrets(text);
  assert.doesNotMatch(out, /\*[0-9A-F]{40}/);
  assert.doesNotMatch(out, /\$2y\$/);
  assert.doesNotMatch(out, /\$6\$/);
  assert.doesNotMatch(out, /PRIVATE KEY/);
  assert.doesNotMatch(out, /hunter2/);
});
