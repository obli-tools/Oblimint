import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { parseSshPublicKey, sshFingerprint, tryFingerprint } from './sshKeys.service';

// OpenSSH public key lines are built here from node:crypto key pairs (wire
// format of RFC 4253 §6.6, RFC 5656 §3.1, RFC 8709), then parsed back.

const sshString = (b: Buffer | string): Buffer => {
  const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
};

/** mpint: big-endian, leading 0x00 when the high bit is set. */
const mpint = (b: Buffer): Buffer => {
  let v = b;
  while (v.length > 1 && v[0] === 0) v = v.subarray(1);
  return sshString(v[0] & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
};

const b64u = (s: string): Buffer => Buffer.from(s, 'base64url');

function ed25519Line(comment = 'me@laptop'): { line: string; blob: Buffer } {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(b64u(jwk.x))]);
  return { line: `ssh-ed25519 ${blob.toString('base64')} ${comment}`, blob };
}

function rsaLine(bits: number): { line: string; blob: Buffer } {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const blob = Buffer.concat([sshString('ssh-rsa'), mpint(b64u(jwk.e)), mpint(b64u(jwk.n))]);
  return { line: `ssh-rsa ${blob.toString('base64')} rsa-${bits}`, blob };
}

function ecdsaLine(curve: 'P-256' | 'P-384' | 'P-521'): { line: string; blob: Buffer } {
  const name = { 'P-256': 'nistp256', 'P-384': 'nistp384', 'P-521': 'nistp521' }[curve];
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: curve });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const q = Buffer.concat([Buffer.from([4]), b64u(jwk.x), b64u(jwk.y)]);
  const blob = Buffer.concat([sshString(`ecdsa-sha2-${name}`), sshString(name), sshString(q)]);
  return { line: `ecdsa-sha2-${name} ${blob.toString('base64')}`, blob };
}

test('ed25519: parsed, fingerprint in OpenSSH format, comment kept', () => {
  const { line, blob } = ed25519Line();
  const k = parseSshPublicKey(`  ${line}\t`);
  assert.equal(k.algorithm, 'ssh-ed25519');
  assert.equal(k.comment, 'me@laptop');
  assert.equal(k.line, line);
  assert.match(k.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(k.fingerprint, `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`);
  assert.equal(k.fingerprint, sshFingerprint(blob));
  assert.equal(tryFingerprint(line), k.fingerprint);
});

test('RSA: 2048 bits refused, 3072 accepted', () => {
  assert.throws(() => parseSshPublicKey(rsaLine(2048).line), /at least 3072 bits \(got 2048\)/);
  const k = parseSshPublicKey(rsaLine(3072).line);
  assert.equal(k.algorithm, 'ssh-rsa');
  assert.equal(k.bits, 3072);
});

test('ECDSA nistp256 / 384 / 521 accepted', () => {
  for (const curve of ['P-256', 'P-384', 'P-521'] as const) {
    const k = parseSshPublicKey(ecdsaLine(curve).line);
    assert.match(k.algorithm, /^ecdsa-sha2-nistp(256|384|521)$/);
    assert.equal(k.comment, null);
  }
});

test('the declared algorithm must match the blob', () => {
  const { blob } = ed25519Line();
  assert.throws(() => parseSshPublicKey(`ssh-rsa ${blob.toString('base64')}`), /does not match/);
  const ec = ecdsaLine('P-256');
  assert.throws(() => parseSshPublicKey(`ecdsa-sha2-nistp384 ${ec.blob.toString('base64')}`), /does not match/);
});

test('malformed keys are refused', () => {
  const { blob } = ed25519Line();
  const b64 = blob.toString('base64');
  assert.throws(() => parseSshPublicKey(''), /Empty/);
  assert.throws(() => parseSshPublicKey('ssh-ed25519'), /Expected/);
  assert.throws(() => parseSshPublicKey(`ssh-dss ${b64}`), /Unsupported/);
  assert.throws(() => parseSshPublicKey(`ssh-ed25519 ${b64.slice(0, -4)}`), /Truncated|Invalid/);
  assert.throws(() => parseSshPublicKey(`ssh-ed25519 ${b64}!`), /base64/);
  assert.throws(() => parseSshPublicKey(`ssh-ed25519 ${Buffer.concat([blob, Buffer.from([0, 0, 0, 0])]).toString('base64')}`), /Trailing/);
  assert.throws(() => parseSshPublicKey(`ssh-ed25519 ${b64}\nssh-ed25519 ${b64}`), /One key/);
  assert.throws(() => parseSshPublicKey(`command="x" ssh-ed25519 ${b64}`), /Unsupported/);
  const short = Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(31))]);
  assert.throws(() => parseSshPublicKey(`ssh-ed25519 ${short.toString('base64')}`), /Invalid ed25519/);
  assert.equal(tryFingerprint('garbage'), null);
});
