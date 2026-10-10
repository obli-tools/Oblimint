import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import selfsigned from 'selfsigned';
import { SourceCommandRefusedError } from '../contracts/source';
import { createFakeSession, type FakeHandlers } from '../contracts/testing';
import { cwpSecrets, CwpSecretError, nativeHashOf, privateKeyPem } from './secrets';
import { caPem } from './fixtures/certs';

// ─────────────────────────────────────────────────────────────────────────────
// cwpSecrets (MG2, D-SECRETS-JIT): parsed values in a TRANSFER session,
// refused in a DISCOVERY session (phase rule), formats validated, invalid
// values dropped, errors never carry the value.
// ─────────────────────────────────────────────────────────────────────────────

const SHA512 = `{SHA512-CRYPT}$6$abcdefghijklmnop$${'A'.repeat(86)}`;
const MD5 = '$1$saltsalt$qwertyuiopasdfghjklzx.';
const NATIVE = `*${'0123456789ABCDEF'.repeat(2)}01234567`;
const BCRYPT = `$2a$10$${'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0'}`;

function certAndKey(cn: string) {
  const pems = selfsigned.generate([{ name: 'commonName', value: cn }], {
    days: 30, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: cn }] }],
  });
  return { cert: pems.cert.replace(/\r\n/g, '\n'), key: pems.private.replace(/\r\n/g, '\n') };
}

function handlers(): FakeHandlers {
  const shop = certAndKey('shop.example.tld');
  const other = certAndKey('other.example.tld');
  const dkim = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  return {
    'secret.mailboxHashes': ({ domain }) => `username\tpassword\ncontact@${domain}\t${SHA512}\nlegacy@${domain}\t${MD5}\nempty@${domain}\t\nevil@other.test\t${SHA512}\nspace@${domain}\tbad hash\n`,
    'secret.mysqlUserHashes': () => [
      'User\tHost\tplugin\tPassword\tauthentication_string',
      `acct1\tlocalhost\t\t${NATIVE.toLowerCase()}\t`,
      `acct1_wp\tlocalhost\tmysql_native_password\t\t${NATIVE}`,
      `acct1_sock\tlocalhost\tunix_socket\t\t${NATIVE}`,
      'acct1_none\tlocalhost\t\t\t',
      `intruder\tlocalhost\t\t${NATIVE}\t`, '',
    ].join('\n'),
    'secret.dkimPrivateKey': ({ domain }) => (domain === 'example.tld' ? dkim : domain === 'broken.test' ? 'not a key' : { stdout: '', exitCode: 1 }),
    'fs.cat': ({ path }) => {
      if (path === '/etc/pki/tls/certs/shop.example.tld.cert') return shop.cert;
      if (path === '/etc/pki/tls/certs/shop.example.tld.bundle') return `${shop.cert}${caPem}`;
      if (path === '/etc/pki/tls/certs/mismatch.example.tld.cert') return other.cert;
      return { stdout: '', exitCode: 1 };
    },
    'secret.certificateKey': ({ fqdn }) => (fqdn === 'shop.example.tld' || fqdn === 'mismatch.example.tld' ? shop.key : { stdout: '', exitCode: 1 }),
    'secret.ftpUserHash': ({ login }) => (login === 'ftpuser@example.tld' ? `${BCRYPT}\n` : login === 'sha@example.tld' ? '$6$salt$hash\n' : login === 'odd@example.tld' ? 'plaintext\n' : ''),
  };
}

test('phase rule: every secret reader is refused in a discovery session', async () => {
  const s = createFakeSession({ phase: 'discovery', handlers: handlers() });
  await assert.rejects(cwpSecrets.mailboxHashes(s, 'example.tld'), SourceCommandRefusedError);
  await assert.rejects(cwpSecrets.mysqlUserHashes(s, ['acct1']), SourceCommandRefusedError);
  await assert.rejects(cwpSecrets.dkimPrivateKey(s, 'example.tld', 'default'), SourceCommandRefusedError);
  await assert.rejects(cwpSecrets.certificateBundle(s, 'shop.example.tld'), SourceCommandRefusedError);
  await assert.rejects(cwpSecrets.ftpUserHash(s, 'ftpuser@example.tld'), SourceCommandRefusedError);
});

test('transfer session: mailbox hashes kept as stored, invalid / foreign rows dropped', async () => {
  const s = createFakeSession({ phase: 'transfer', handlers: handlers() });
  assert.deepEqual(await cwpSecrets.mailboxHashes(s, 'Example.TLD'), [
    { address: 'contact@example.tld', hash: SHA512 }, { address: 'legacy@example.tld', hash: MD5 },
  ]);
  await assert.rejects(cwpSecrets.mailboxHashes(s, "x'; DROP"), CwpSecretError);
});

test('transfer session: MySQL native hashes from Password or authentication_string', async () => {
  const s = createFakeSession({ phase: 'transfer', handlers: handlers() });
  const r = await cwpSecrets.mysqlUserHashes(s, ['acct1', 'acct1_wp', 'acct1_sock', 'acct1_none', "bad'user"]);
  assert.deepEqual(r, [
    { user: 'acct1', host: 'localhost', plugin: '', nativeHash: NATIVE },
    { user: 'acct1_wp', host: 'localhost', plugin: 'mysql_native_password', nativeHash: NATIVE },
    { user: 'acct1_sock', host: 'localhost', plugin: 'unix_socket', nativeHash: null },
    { user: 'acct1_none', host: 'localhost', plugin: '', nativeHash: null },
  ]);
  const call = s.calls.find((c) => c.template === 'secret.mysqlUserHashes');
  assert.deepEqual((call?.args as { users: string[] }).users, ['acct1', 'acct1_wp', 'acct1_sock', 'acct1_none']);
  assert.deepEqual(await cwpSecrets.mysqlUserHashes(s, []), []);
  assert.equal(nativeHashOf(null, 'mysql_native_password', '*BAD'), null);
});

test('transfer session: DKIM key, certificate bundle, FTP hash', async () => {
  const s = createFakeSession({ phase: 'transfer', handlers: handlers() });
  const dkim = await cwpSecrets.dkimPrivateKey(s, 'example.tld', 'default');
  assert.match(dkim ?? '', /^-----BEGIN RSA PRIVATE KEY-----\n[\s\S]+-----END RSA PRIVATE KEY-----\n$/);
  assert.equal(await cwpSecrets.dkimPrivateKey(s, 'missing.test', 'default'), null);
  await assert.rejects(cwpSecrets.dkimPrivateKey(s, 'broken.test', 'default'), (err: Error) => err instanceof CwpSecretError && !err.message.includes('not a key'));
  await assert.rejects(cwpSecrets.dkimPrivateKey(s, 'example.tld', '../x'), CwpSecretError);

  const b = await cwpSecrets.certificateBundle(s, 'shop.example.tld');
  assert.ok(b);
  assert.match(b.certificatePem, /^-----BEGIN CERTIFICATE-----/);
  assert.equal(b.chainPem, `${caPem.trim()}\n`);
  assert.match(b.privateKeyPem, /PRIVATE KEY-----\n$/);
  assert.equal(await cwpSecrets.certificateBundle(s, 'nothing.example.tld'), null);
  await assert.rejects(cwpSecrets.certificateBundle(s, 'mismatch.example.tld'), (err: Error) => err instanceof CwpSecretError && !err.message.includes('PRIVATE'));
  await assert.rejects(cwpSecrets.certificateBundle(s, '../../etc/shadow'), CwpSecretError);

  assert.equal(await cwpSecrets.ftpUserHash(s, 'ftpuser@example.tld'), BCRYPT);
  assert.equal(await cwpSecrets.ftpUserHash(s, 'sha@example.tld'), '$6$salt$hash');
  assert.equal(await cwpSecrets.ftpUserHash(s, 'odd@example.tld'), null);
  assert.equal(await cwpSecrets.ftpUserHash(s, 'unknown@example.tld'), null);
  await assert.rejects(cwpSecrets.ftpUserHash(s, 'a:b'), CwpSecretError);
});

test('privateKeyPem: encrypted / garbage keys are refused', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.equal(privateKeyPem(`junk\n${pkcs8}junk`), pkcs8);
  const enc = privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'x' }).toString();
  assert.equal(privateKeyPem(enc), null);
  assert.equal(privateKeyPem('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'), null);
});
