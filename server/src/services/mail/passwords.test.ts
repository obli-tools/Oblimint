import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import {
  assertMailPasswordAcceptable, generateMailPassword, hashMailPassword, md5Crypt, normalizeImportedHash, sha256Crypt, sha512Crypt,
  verifyMailPassword,
} from './passwords';

// Vectors: glibc crypt-sha512 / crypt-sha256 test suite, passlib md5_crypt documentation.

test('sha512Crypt matches the glibc vectors', () => {
  assert.equal(sha512Crypt('Hello world!', 'saltstring'),
    '$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1');
  assert.equal(sha512Crypt('Hello world!', 'saltstringsaltstring', 10000),
    '$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.');
});

test('sha256Crypt and md5Crypt match their reference vectors', () => {
  assert.equal(sha256Crypt('Hello world!', 'saltstring'), '$5$saltstring$5B8vYYiY.CVt1RlTTf8KbXBH3hsxY/GNooZaBBGWEc5');
  assert.equal(md5Crypt('password', '3azHgidD'), '$1$3azHgidD$SrJPt7B.9rekpmwJwtON31');
});

test('hashMailPassword produces a verifiable {SHA512-CRYPT} hash with a random salt', () => {
  const a = hashMailPassword('correct horse battery');
  const b = hashMailPassword('correct horse battery');
  assert.equal(a.scheme, 'SHA512-CRYPT');
  assert.match(a.hash, /^\{SHA512-CRYPT\}\$6\$rounds=5000\$[./0-9A-Za-z]{16}\$[./0-9A-Za-z]{86}$/);
  assert.notEqual(a.hash, b.hash);
  assert.ok(verifyMailPassword('correct horse battery', a.hash));
  assert.ok(!verifyMailPassword('correct horse batterY', a.hash));
});

test('imported hashes keep working: MD5-CRYPT, SHA512-CRYPT, BLF-CRYPT (with and without prefix)', () => {
  const md5 = normalizeImportedHash('$1$3azHgidD$SrJPt7B.9rekpmwJwtON31');
  assert.deepEqual(md5, { hash: '{MD5-CRYPT}$1$3azHgidD$SrJPt7B.9rekpmwJwtON31', scheme: 'MD5-CRYPT' });
  assert.ok(verifyMailPassword('password', md5.hash));

  const sha = normalizeImportedHash(`{SHA512-CRYPT}${sha512Crypt('cwp-secret-1', 'abcdefgh')}`);
  assert.equal(sha.scheme, 'SHA512-CRYPT');
  assert.ok(verifyMailPassword('cwp-secret-1', sha.hash));

  const blf = bcrypt.hashSync('roundcube-pass', 4).replace(/^\$2b\$/, '$2y$');
  const n = normalizeImportedHash(`{BLF-CRYPT}${blf}`);
  assert.equal(n.scheme, 'BLF-CRYPT');
  assert.ok(verifyMailPassword('roundcube-pass', n.hash));
});

test('normalizeImportedHash refuses clear text, unknown schemes and malformed hashes', () => {
  for (const bad of ['{PLAIN}secret', '{CLEARTEXT}x', 'secret', '$6$salt$short', '{SHA512-CRYPT}$1$x$y', '', '{MD5-CRYPT}$1$a b$c']) {
    assert.throws(() => normalizeImportedHash(bad), (err: { code?: string }) => err.code === 'invalidPasswordHash', bad);
  }
});

test('password acceptance rules', () => {
  assert.throws(() => assertMailPasswordAcceptable('short'), (e: { code?: string }) => e.code === 'weakPassword');
  assert.throws(() => assertMailPasswordAcceptable('abcdefghij\n'), (e: { code?: string }) => e.code === 'invalidPassword');
  assert.throws(() => assertMailPasswordAcceptable('x'.repeat(300)), (e: { code?: string }) => e.code === 'passwordTooLong');
  assert.doesNotThrow(() => assertMailPasswordAcceptable('a long enough pässword'));
  assert.ok(generateMailPassword().length >= 24);
});

test('Dovecot {CRYPT} prefix: the scheme is inferred from the crypt(3) id', () => {
  const md5 = normalizeImportedHash('{CRYPT}$1$3azHgidD$SrJPt7B.9rekpmwJwtON31');
  assert.deepEqual(md5, { hash: '{MD5-CRYPT}$1$3azHgidD$SrJPt7B.9rekpmwJwtON31', scheme: 'MD5-CRYPT' });
  assert.ok(verifyMailPassword('password', md5.hash));
  assert.throws(() => normalizeImportedHash('{CRYPT}$9$nope'), (e: { code?: string }) => e.code === 'invalidPasswordHash');
});
