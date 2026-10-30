import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySql, PASTED_DUMP_STATEMENTS } from './sqlClass';

// Free SQL as catalogue actions: a read only when it surely reads; a write is
// db.query_write plus what it amounts to (DDL, rows, a pasted dump).

const pg = (s: string | string[]) => classifySql(Array.isArray(s) ? s : [s], 'postgresql');
const my = (s: string | string[]) => classifySql(Array.isArray(s) ? s : [s], 'mysql');

test('reads stay free of any action', () => {
  for (const s of ['SELECT * FROM t', 'WITH x AS (SELECT 1) SELECT * FROM x', 'SHOW TABLES', 'EXPLAIN SELECT 1', 'TABLE t', "SELECT 'DELETE FROM t'", '/* DROP TABLE t */ SELECT 1']) {
    assert.deepEqual(pg(s), { write: false, actions: [] }, s);
  }
  assert.deepEqual(my('DESCRIBE t'), { write: false, actions: [] });
});

test('destructive DDL typed in the console is db.ddl too (never only the query_write of the panel)', () => {
  assert.deepEqual(pg('DROP TABLE wp_users').actions, ['db.query_write', 'db.ddl']);
  assert.deepEqual(pg('TRUNCATE orders').actions, ['db.query_write', 'db.ddl']);
  assert.deepEqual(pg('ALTER TABLE t DROP COLUMN c').actions, ['db.query_write', 'db.ddl']);
  assert.deepEqual(pg('ALTER TABLE t ADD COLUMN c int').actions, ['db.query_write'], 'adding is no deletion');
  assert.deepEqual(pg('CREATE TABLE t (a int)').actions, ['db.query_write']);
});

test('row changes are db.rows_write too', () => {
  for (const s of ['INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM orders', 'MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE']) {
    assert.deepEqual(pg(s).actions, ['db.query_write', 'db.rows_write'], s);
  }
  assert.deepEqual(my('REPLACE INTO t VALUES (1)').actions, ['db.query_write', 'db.rows_write']);
});

test('writes hidden behind a reading keyword are writes', () => {
  const cte = pg('WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d');
  assert.ok(cte.write && cte.actions.includes('db.rows_write'), 'data-modifying CTE');
  assert.ok(pg('EXPLAIN (ANALYZE) DELETE FROM orders').write, 'EXPLAIN (ANALYZE) runs it');
  assert.ok(pg('EXPLAIN (ANALYZE, BUFFERS) DELETE FROM orders').actions.includes('db.rows_write'));
  assert.ok(pg('EXPLAIN ANALYZE DELETE FROM orders').write);
  assert.ok(my('EXPLAIN ANALYZE SELECT * FROM t').write, 'MySQL 8 EXPLAIN ANALYZE executes too');
  assert.ok(pg('SELECT * INTO new_table FROM t').write, 'SELECT … INTO creates a table');
  assert.ok(my("SELECT * FROM t INTO OUTFILE '/tmp/x'").write);
  assert.ok(pg('SELECT * FROM t FOR UPDATE').write, 'a locking read');
  assert.ok(my('/*!50000 DROP TABLE t */').actions.includes('db.ddl'), 'MySQL executable comment: the strictest');
  assert.ok(pg('  (SELECT 1)').write === false);
});

test('a dump pasted in the console is db.import too', () => {
  const dump = Array.from({ length: PASTED_DUMP_STATEMENTS + 1 }, (_, i) => `INSERT INTO t VALUES (${i})`);
  assert.ok(pg(dump).actions.includes('db.import'));
  assert.ok(!pg(dump.slice(0, 3)).actions.includes('db.import'));
  assert.ok(pg('COPY t FROM stdin').actions.includes('db.import'));
  assert.ok(my("LOAD DATA INFILE 'x' INTO TABLE t").actions.includes('db.import'));
  // A batch mixing reads and one write: a write.
  assert.deepEqual(pg(['SELECT 1', 'DROP TABLE t']).actions, ['db.query_write', 'db.ddl']);
});
