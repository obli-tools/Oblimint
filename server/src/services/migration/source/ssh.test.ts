import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { utils as ssh2Utils, type ConnectConfig } from 'ssh2';
import { SourceConnectionError } from '../contracts/source';
import { fingerprintOf } from '../../monitoring/automation/sshKeys';
import {
  HostKeyRejectedError, connectSsh, decideHostKey, mapSshError, setSsh2ClientFactoryForTests, sshFingerprint, sshKeyAlgorithm,
  type Ssh2ClientLike,
} from './ssh';

// ─────────────────────────────────────────────────────────────────────────────
// source-executor: host key fingerprint / algorithm on real key blobs built
// from node:crypto, hostVerifier decisions (MG3), connectSsh against a fake
// ssh2 client (no network).
// ─────────────────────────────────────────────────────────────────────────────

function sshString(b: Buffer | string): Buffer {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}

function ed25519Blob(): Buffer {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  return Buffer.concat([sshString('ssh-ed25519'), sshString(raw)]);
}

test('fingerprint + algorithm of an ed25519 blob (cross-checked with ssh2 and the P4b helper)', () => {
  const blob = ed25519Blob();
  const fp = sshFingerprint(blob);
  assert.match(fp, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(fp, `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`);
  assert.equal(fp, fingerprintOf(blob));
  assert.equal(sshKeyAlgorithm(blob), 'ssh-ed25519');
  // ssh2 parses the OpenSSH line built from the blob back to the same wire blob.
  const parsed = ssh2Utils.parseKey(`ssh-ed25519 ${blob.toString('base64')} test`);
  assert.ok(!(parsed instanceof Error));
  const k = (Array.isArray(parsed) ? parsed[0] : parsed) as { getPublicSSH(): Buffer; type: string };
  assert.equal(k.type, 'ssh-ed25519');
  assert.ok(k.getPublicSSH().equals(blob));
  // Known vector: 32 zero bytes.
  const zero = Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(32))]);
  assert.equal(sshFingerprint(zero), `SHA256:${crypto.createHash('sha256').update(zero).digest('base64').replace(/=+$/, '')}`);
});

test('algorithm of other blobs; garbage → unknown', () => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { e: string; n: string };
  const mpint = (b64: string) => { let b = Buffer.from(b64, 'base64url'); if (b[0] & 0x80) b = Buffer.concat([Buffer.alloc(1), b]); return sshString(b); };
  const rsa = Buffer.concat([sshString('ssh-rsa'), mpint(jwk.e), mpint(jwk.n)]);
  assert.equal(sshKeyAlgorithm(rsa), 'ssh-rsa');
  assert.equal(sshKeyAlgorithm(Buffer.concat([sshString('ecdsa-sha2-nistp256'), sshString('nistp256'), sshString(Buffer.alloc(65, 4))])), 'ecdsa-sha2-nistp256');
  assert.equal(sshKeyAlgorithm(Buffer.from([0, 0])), 'unknown');
  assert.equal(sshKeyAlgorithm(Buffer.from([0, 0, 1, 0, 65])), 'unknown');
  assert.equal(sshKeyAlgorithm(Buffer.concat([sshString('bad name\n')])), 'unknown');
});

test('hostVerifier decision: unpinned / match / mismatch', () => {
  const blob = ed25519Blob();
  const other = ed25519Blob();
  const fp = sshFingerprint(blob);
  assert.equal(decideHostKey(blob, null).state, 'unpinned');
  assert.equal(decideHostKey(blob, '').state, 'unpinned');
  assert.equal(decideHostKey(blob, fp).state, 'match');
  assert.equal(decideHostKey(other, fp).state, 'mismatch');
  assert.equal(decideHostKey(blob, fp.slice(0, -1)).state, 'mismatch');
  assert.deepEqual(decideHostKey(blob, null).hostKey, { algorithm: 'ssh-ed25519', fingerprint: fp });
});

/** Fake ssh2 client: runs hostVerifier like ssh2 does, then ready / error. */
class FakeSsh2 extends EventEmitter implements Ssh2ClientLike {
  cfg: ConnectConfig | null = null;
  ended = false;
  execArgs: unknown[][] = [];
  constructor(private readonly blob: Buffer, private readonly authOk = true, private readonly kbd = false) { super(); }
  connect(cfg: ConnectConfig): this {
    this.cfg = cfg;
    setImmediate(() => {
      const verifier = cfg.hostVerifier as (k: Buffer) => boolean;
      if (!verifier(this.blob)) {
        this.emit('error', Object.assign(new Error('Host denied (verification failed)'), { level: 'client-socket' }));
        this.emit('close');
        return;
      }
      if (this.kbd) {
        this.emit('keyboard-interactive', '', '', '', [{ prompt: 'Password: ', echo: false }], (answers: string[]) => {
          if (answers[0] !== 'pw') this.emit('error', Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' }));
          else this.emit('ready');
        });
        return;
      }
      if (!this.authOk) {
        this.emit('error', Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' }));
        this.emit('close');
        return;
      }
      this.emit('ready');
    });
    return this;
  }
  exec(...args: unknown[]): this {
    this.execArgs.push(args);
    const cb = args[args.length - 1] as (e: Error | undefined, ch: unknown) => void;
    const ch = Object.assign(new PassThrough(), { stderr: new PassThrough(), signal: () => undefined, close: () => undefined });
    cb(undefined, ch);
    setImmediate(() => { ch.emit('exit', 0); ch.end(); ch.emit('close'); });
    return this;
  }
  end(): this { this.ended = true; return this; }
}

test('connectSsh: unpinned → refused with the presented key, nothing authenticated', async (t) => {
  const blob = ed25519Blob();
  const fake = new FakeSsh2(blob);
  setSsh2ClientFactoryForTests(() => fake);
  t.after(() => setSsh2ClientFactoryForTests(null));
  await assert.rejects(connectSsh({
    host: '203.0.113.10', port: 22, username: 'root', authMethod: 'password', secret: { password: 'pw' }, pinnedFingerprint: null,
  }), (err: unknown) => {
    assert.ok(err instanceof HostKeyRejectedError);
    assert.equal(err.code, 'hostKeyUnpinned');
    assert.deepEqual(err.hostKey, { algorithm: 'ssh-ed25519', fingerprint: sshFingerprint(blob) });
    assert.ok(!err.message.includes('pw'));
    return true;
  });
  assert.equal(fake.cfg?.readyTimeout, 20_000);
  assert.equal(fake.cfg?.keepaliveInterval, 15_000);
});

test('connectSsh: mismatch refused; match → ready, exec without PTY', async (t) => {
  const blob = ed25519Blob();
  const pinned = sshFingerprint(ed25519Blob());
  setSsh2ClientFactoryForTests(() => new FakeSsh2(blob));
  t.after(() => setSsh2ClientFactoryForTests(null));
  await assert.rejects(connectSsh({
    host: 'cwp.example.tld', port: 2222, username: 'root', authMethod: 'key', secret: { privateKey: 'KEY' }, pinnedFingerprint: pinned,
  }), (err: unknown) => err instanceof HostKeyRejectedError && err.code === 'hostKeyMismatch' && err.hostKey.fingerprint === sshFingerprint(blob));

  const fake = new FakeSsh2(blob);
  setSsh2ClientFactoryForTests(() => fake);
  const { conn, hostKey } = await connectSsh({
    host: 'cwp.example.tld', port: 2222, username: 'root', authMethod: 'key', secret: { privateKey: 'KEY', passphrase: 'pp' },
    pinnedFingerprint: sshFingerprint(blob),
  });
  assert.equal(hostKey.fingerprint, sshFingerprint(blob));
  assert.equal((fake.cfg as { privateKey?: string }).privateKey, 'KEY');
  assert.equal((fake.cfg as { passphrase?: string }).passphrase, 'pp');
  assert.equal((fake.cfg as { password?: string }).password, undefined);
  const h = await conn.exec('LC_ALL=C id -un');
  assert.equal(fake.execArgs[0].length, 2, 'exec(command, cb): no options object, hence no PTY');
  assert.equal((await h.done).code, 0);
  conn.close();
  assert.equal(conn.closed, true);
  assert.equal(fake.ended, true);
});

test('connectSsh: no secret → noSecret before any network; auth failure → authFailed; keyboard-interactive', async (t) => {
  const blob = ed25519Blob();
  let created = 0;
  setSsh2ClientFactoryForTests(() => { created++; return new FakeSsh2(blob, false); });
  t.after(() => setSsh2ClientFactoryForTests(null));
  await assert.rejects(connectSsh({ host: 'h', port: 22, username: 'root', authMethod: 'password', secret: {}, pinnedFingerprint: 'x' }),
    (err: unknown) => err instanceof SourceConnectionError && err.code === 'noSecret');
  await assert.rejects(connectSsh({ host: 'h', port: 22, username: 'root', authMethod: 'key', secret: { password: 'pw' }, pinnedFingerprint: 'x' }),
    (err: unknown) => err instanceof SourceConnectionError && err.code === 'noSecret');
  assert.equal(created, 0);
  await assert.rejects(connectSsh({
    host: 'h', port: 22, username: 'root', authMethod: 'password', secret: { password: 'wrong' }, pinnedFingerprint: sshFingerprint(blob),
  }), (err: unknown) => err instanceof SourceConnectionError && err.code === 'authFailed' && !err.message.includes('wrong'));
  setSsh2ClientFactoryForTests(() => new FakeSsh2(blob, true, true));
  const ok = await connectSsh({ host: 'h', port: 22, username: 'root', authMethod: 'password', secret: { password: 'pw' }, pinnedFingerprint: sshFingerprint(blob) });
  ok.conn.close();
});

test('mapSshError: generic codes', () => {
  assert.equal(mapSshError(Object.assign(new Error('x'), { level: 'client-timeout' })).code, 'timeout');
  assert.equal(mapSshError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).code, 'connectFailed');
  assert.equal(mapSshError(new Error('Cannot parse privateKey: Malformed OpenSSH private key')).code, 'authFailed');
  assert.equal(mapSshError(new Error('Timed out while waiting for handshake')).code, 'timeout');
  assert.equal(mapSshError(new Error('weird')).message, 'SSH connection failed');
});
