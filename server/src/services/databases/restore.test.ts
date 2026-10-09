import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'stream';
import zlib from 'zlib';
import { AppError } from '../../middleware/errorHandler';
import { assertRestoreContentType, createRestoreRewriter, detectRestoreEncoding, mediaType, psqlRestrictKey, restoreSqlStream } from './restore';

// Restore body handling: declared type, gzip sniffing, streaming limits.

async function collect(s: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

async function failure(s: Readable): Promise<AppError> {
  try {
    await collect(s);
  } catch (err) {
    return err as AppError;
  }
  throw new Error('expected a failure');
}

/** A readable delivering `buf` in small chunks (exercise the 2-byte sniffing across chunks). */
function chunked(buf: Buffer, size = 1): Readable {
  const parts: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) parts.push(buf.subarray(i, i + size));
  return Readable.from(parts);
}

test('content types', () => {
  assert.equal(mediaType('Application/SQL; charset=utf-8'), 'application/sql');
  for (const t of ['application/sql', 'application/gzip', 'application/x-gzip', 'application/octet-stream', 'application/gzip; foo=bar']) {
    assert.doesNotThrow(() => assertRestoreContentType(t), t);
  }
  for (const t of [undefined, '', 'application/json', 'text/plain', 'multipart/form-data; boundary=x']) {
    assert.throws(() => assertRestoreContentType(t), (e: AppError) => e.statusCode === 415, String(t));
  }
});

test('gzip detection: magic bytes win, a declared gzip without magic is refused', () => {
  const gz = zlib.gzipSync('SELECT 1;');
  assert.equal(detectRestoreEncoding('application/sql', gz), 'gzip');
  assert.equal(detectRestoreEncoding('application/octet-stream', gz), 'gzip');
  assert.equal(detectRestoreEncoding('application/gzip', gz), 'gzip');
  assert.equal(detectRestoreEncoding('application/octet-stream', Buffer.from('SELECT 1;')), 'plain');
  assert.throws(() => detectRestoreEncoding('application/x-gzip', Buffer.from('SELECT 1;')), (e: AppError) => e.statusCode === 400);
});

test('plain and gzip bodies stream through (chunk boundaries included)', async () => {
  const sql = "CREATE TABLE t (id int);\nINSERT INTO t VALUES (1),(2);\n".repeat(200);
  assert.equal(await collect(restoreSqlStream(chunked(Buffer.from(sql), 7), 'application/sql')), sql);
  assert.equal(await collect(restoreSqlStream(chunked(zlib.gzipSync(sql), 1), 'application/octet-stream')), sql);
  assert.equal(await collect(restoreSqlStream(Readable.from([zlib.gzipSync(sql)]), 'application/gzip')), sql);
  assert.equal(await collect(restoreSqlStream(Readable.from([Buffer.from('X')]), 'application/sql')), 'X', 'a 1-byte body');
});

test('limits and corrupt input', async () => {
  const big = Buffer.alloc(5000, 0x41);
  let err = await failure(restoreSqlStream(chunked(big, 1000), 'application/sql', { maxBytes: 4096 }));
  assert.equal(err.statusCode, 413);
  const bomb = zlib.gzipSync(Buffer.alloc(200_000, 0x41));
  err = await failure(restoreSqlStream(Readable.from([bomb]), 'application/gzip', { maxInflatedBytes: 100_000 }));
  assert.equal(err.statusCode, 413);
  const corrupt = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('not really gzip at all')]);
  err = await failure(restoreSqlStream(Readable.from([corrupt]), 'application/octet-stream'));
  assert.equal(err.statusCode, 400);
  err = await failure(restoreSqlStream(Readable.from([]), 'application/sql'));
  assert.equal(err.statusCode, 400, 'empty body');
  err = await failure(restoreSqlStream(Readable.from([Buffer.from('plain')]), 'application/gzip'));
  assert.equal(err.statusCode, 400, 'declared gzip, not gzip');
});

/** Runs `input` through the rewriter in chunks of `size` bytes. */
async function rewriteIn(family: 'mysql' | 'postgresql', input: string, size: number, key = 'K3y'): Promise<string> {
  const buf = Buffer.from(input, 'utf8');
  const parts: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) parts.push(buf.subarray(i, i + size));
  return collect(Readable.from(parts).pipe(createRestoreRewriter(family, family === 'postgresql' ? { restrictKey: key } : {})));
}

test('psql rewriter: our \\restrict first, the dump\'s own (un)restrict lines removed, whatever the chunking', async () => {
  const dump = [
    '\\restrict AbC123dumpkey',
    'SET client_encoding = \'UTF8\';',
    'CREATE TABLE t (v text);',
    'COPY t (v) FROM stdin;',
    'a\\\\restrict b',
    '\\.',
    '\\! cat /proc/1/environ',
    'SELECT \'é\';',
    '\\unrestrict AbC123dumpkey',
    '',
  ].join('\n');
  const expected = [
    '\\restrict K3y',
    'SET client_encoding = \'UTF8\';',
    'CREATE TABLE t (v text);',
    'COPY t (v) FROM stdin;',
    'a\\\\restrict b',
    '\\.',
    '\\! cat /proc/1/environ', // left in place: psql refuses it (restricted) and stops (ON_ERROR_STOP)
    'SELECT \'é\';',
    '',
  ].join('\n');
  for (const size of [1, 2, 3, 7, 64, 100_000]) assert.equal(await rewriteIn('postgresql', dump, size), expected, `chunks of ${size}`);
  // no trailing newline after the last \unrestrict
  assert.equal(await rewriteIn('postgresql', 'SELECT 1;\n\\unrestrict x', 4), '\\restrict K3y\nSELECT 1;');
  // the very first line, and CRLF line breaks
  assert.equal(await rewriteIn('postgresql', '\\restrict abc\r\nSELECT 1;\r\n\\unrestrict abc\r\n', 2), '\\restrict K3y\n\r\nSELECT 1;\r\n');
  // an unterminated "\restrict" line split across chunks is never cut in half
  assert.equal(await rewriteIn('postgresql', 'SELECT 1;\n\\restrictX\n', 3), '\\restrict K3y\nSELECT 1;\n\\restrictX\n');
  assert.match(psqlRestrictKey(), /^[0-9a-f]{48}$/);
  assert.throws(() => createRestoreRewriter('postgresql'), /restrictKey/);
});

test('MySQL rewriter: DEFINER clauses removed (every quoting), the rest byte-identical', async () => {
  const dump = [
    '/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER trg BEFORE INSERT ON t FOR EACH ROW SET NEW.a = 1 */;;',
    'CREATE DEFINER=`app``x`@`%` PROCEDURE p() SELECT 1;',
    "/*!50013 DEFINER='admin'@'10.0.0.%' SQL SECURITY DEFINER */",
    'CREATE definer = root@localhost VIEW v AS SELECT 1;',
    'CREATE DEFINER=CURRENT_USER FUNCTION f() RETURNS INT RETURN 1;',
    "INSERT INTO t VALUES ('héllo','x');",
    '',
  ].join('\n');
  const expected = [
    '/*!50003 CREATE*/ /*!50017 */ /*!50003 TRIGGER trg BEFORE INSERT ON t FOR EACH ROW SET NEW.a = 1 */;;',
    'CREATE  PROCEDURE p() SELECT 1;',
    '/*!50013  SQL SECURITY DEFINER */',
    'CREATE  VIEW v AS SELECT 1;',
    'CREATE DEFINER=CURRENT_USER FUNCTION f() RETURNS INT RETURN 1;',
    "INSERT INTO t VALUES ('héllo','x');",
    '',
  ].join('\n');
  for (const size of [1, 5, 13, 4096, 100_000]) assert.equal(await rewriteIn('mysql', dump, size), expected, `chunks of ${size}`);
});

test('rewriter: very long lines and big streams pass through unchanged, memory bounded', async () => {
  const long = `INSERT INTO t VALUES ('${'x'.repeat(300_000)}');\n`;
  const big = `${long}${'SELECT 1;\n'.repeat(20_000)}`;
  assert.equal(await rewriteIn('mysql', big, 65_536), big);
  assert.equal(await rewriteIn('postgresql', big, 65_536), `\\restrict K3y\n${big}`);
  // a DEFINER straddling a 64 KiB chunk boundary inside a long line
  const pad = 'y'.repeat(65_536 - 20);
  const straddle = `/* ${pad} */ CREATE DEFINER=\`root\`@\`localhost\` VIEW v AS SELECT 1;\n`;
  assert.equal(await rewriteIn('mysql', straddle, 65_536), `/* ${pad} */ CREATE  VIEW v AS SELECT 1;\n`);
});
