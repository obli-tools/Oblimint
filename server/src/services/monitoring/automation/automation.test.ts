import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import { certificateMatches, nextRunAt, normalizeTrigger, triggerProblem } from './triggers';
import { connectSftp, HostKeyMismatchError, remotePathUnder, setSsh2ClientFactoryForTests, sftpErrorText, SftpError, type Ssh2ClientLike } from './sftp';
import { fingerprintOf, generateEd25519 } from './sshKeys';
import { actionErrorText, RunLog, MAX_LOG_LINES } from './workflows.service';
import { AppError } from '../../../middleware/errorHandler';
import { isNodeAddress, resolveTarget, TargetRefusedError } from '../targetGuard';
import { dueNotifications, prunedMarks, RENOTIFY_MS, type ExpiringCertificate } from '../certExpiry';

// ── triggers ─────────────────────────────────────────────────────────────────

test('interval trigger: ≥ 5 minutes, next run = from + interval', () => {
  assert.equal(triggerProblem({ kind: 'interval', intervalMinutes: 4 })?.code, 'validation');
  assert.equal(triggerProblem({ kind: 'interval', intervalMinutes: 5 }), null);
  assert.equal(triggerProblem({ kind: 'interval', intervalMinutes: 5.5 })?.code, 'validation');
  const from = new Date('2026-10-10T12:00:00Z');
  assert.equal(nextRunAt({ kind: 'interval', intervalMinutes: 30 }, from)!.toISOString(), '2026-10-10T12:30:00.000Z');
  assert.equal(nextRunAt({ kind: 'manual' }, from), null);
  assert.equal(nextRunAt({ kind: 'cert-renewal' }, from), null);
});

test('cron trigger: 5 fields, time zone, minimum period, next run', () => {
  assert.equal(triggerProblem({ kind: 'cron', cron: '0 3 * * *' }), null);
  assert.equal(triggerProblem({ kind: 'cron', cron: '0 3 * *' })?.code, 'invalidCron');
  assert.equal(triggerProblem({ kind: 'cron', cron: '* * * * *' })?.code, 'invalidCron', 'every minute refused');
  assert.equal(triggerProblem({ kind: 'cron', cron: '*/5 * * * *' }), null);
  assert.equal(triggerProblem({ kind: 'cron', cron: '0,1 3 * * *' })?.code, 'invalidCron', 'two runs one minute apart');
  assert.equal(triggerProblem({ kind: 'cron', cron: '0 0 * * * *' })?.code, 'invalidCron', 'seconds field refused');
  assert.equal(triggerProblem({ kind: 'cron', cron: 'nope nope * * *' })?.code, 'invalidCron');
  assert.equal(triggerProblem({ kind: 'cron', cron: '0 3 * * *', timezone: 'Nowhere/X' })?.code, 'invalidTimezone');
  const from = new Date('2026-10-10T12:00:00Z');
  assert.equal(nextRunAt({ kind: 'cron', cron: '0 3 * * *' }, from)!.toISOString(), '2026-10-11T03:00:00.000Z', 'UTC by default');
  assert.equal(nextRunAt({ kind: 'cron', cron: '0 3 * * *', timezone: 'Europe/Paris' }, from)!.toISOString(), '2026-10-11T01:00:00.000Z');
  // Across the fall-back change (25 October 2026): 03:00 Paris is 02:00 UTC after it.
  assert.equal(nextRunAt({ kind: 'cron', cron: '0 3 * * *', timezone: 'Europe/Paris' }, new Date('2026-10-25T00:00:00Z'))!.toISOString(), '2026-10-25T02:00:00.000Z');
  assert.deepEqual(normalizeTrigger({ kind: 'cron', cron: ' 0  3 * * * ', intervalMinutes: 9 }), { kind: 'cron', cron: '0 3 * * *', timezone: 'UTC' });
});

test('cert-renewal trigger: names validated, wildcard matching, empty = any', () => {
  assert.equal(triggerProblem({ kind: 'cert-renewal', certificateNames: ['vault.example.fr', '*.example.fr'] }), null);
  assert.equal(triggerProblem({ kind: 'cert-renewal', certificateNames: ['bad name'] })?.code, 'validation');
  assert.equal(certificateMatches([], ['a.example.fr']), true);
  assert.equal(certificateMatches(undefined, ['a.example.fr']), true);
  assert.equal(certificateMatches(['A.example.fr'], ['a.example.fr']), true);
  assert.equal(certificateMatches(['*.example.fr'], ['vault.example.fr']), true);
  assert.equal(certificateMatches(['*.example.fr'], ['a.b.example.fr']), false, 'one label only');
  assert.equal(certificateMatches(['*.example.fr'], ['example.fr']), false);
  assert.equal(certificateMatches(['*.example.fr'], ['*.example.fr']), true, 'same wildcard certificate');
  assert.equal(certificateMatches(['other.fr'], ['vault.example.fr', 'www.example.fr']), false);
});

// ── run log ──────────────────────────────────────────────────────────────────

test('run log: lines capped, long lines cut, newlines flattened', () => {
  const log = new RunLog();
  for (let i = 0; i < MAX_LOG_LINES + 100; i++) log.add(`line ${i}`);
  const out = log.toJSON();
  assert.equal(out.length, MAX_LOG_LINES);
  assert.match(out[out.length - 1], /101 line\(s\) dropped/);
  const one = new RunLog();
  one.add(`a\nb${'x'.repeat(5000)}`);
  assert.equal(one.toJSON()[0].includes('\n'), false);
  assert.ok(one.toJSON()[0].length <= 1000);
});

// ── SFTP ─────────────────────────────────────────────────────────────────────

test('remote paths stay under the base path', () => {
  assert.equal(remotePathUnder('/srv/certs', 'vault', 'fullchain.pem'), '/srv/certs/vault/fullchain.pem');
  assert.equal(remotePathUnder('.', null, 'privkey.pem'), 'privkey.pem');
  assert.equal(remotePathUnder('certs/', ''), 'certs');
  assert.equal(remotePathUnder('.', ''), '.');
  assert.throws(() => remotePathUnder('/srv', '../etc'), SftpError);
  assert.throws(() => remotePathUnder('/srv', 'a/../../etc'), SftpError);
  assert.throws(() => remotePathUnder('/srv', '/etc'), SftpError);
  assert.throws(() => remotePathUnder('/srv/../etc', ''), SftpError);
  assert.throws(() => remotePathUnder('/srv', 'a\nb'), SftpError);
  assert.throws(() => remotePathUnder('/srv', 'x', '../y'), SftpError);
  assert.throws(() => remotePathUnder('/srv', 'x', 'a/b'), SftpError);
});

/** Fake ssh2 client: presents a host key, records the files written. */
class FakeSsh2 extends EventEmitter {
  static files = new Map<string, { data: string; mode: number }>();
  static dirs = new Set<string>(['/srv']);
  static lastConfig: Record<string, unknown> | null = null;
  constructor(private hostKey: Buffer, private authOk = true) { super(); }
  connect(cfg: Record<string, unknown>) {
    FakeSsh2.lastConfig = cfg;
    setImmediate(() => {
      const ok = (cfg.hostVerifier as (k: Buffer) => boolean)(this.hostKey);
      if (!ok) { this.emit('error', Object.assign(new Error('Host denied (verification failed)'), { level: 'client-verification' })); return; }
      if (!this.authOk) { this.emit('error', Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' })); return; }
      this.emit('ready');
    });
    return this;
  }
  sftp(cb: (err: Error | undefined, sftp: unknown) => void) {
    const sftp = {
      readdir: (_d: string, done: (e: Error | null, l?: unknown[]) => void) => done(null, [{ filename: 'x' }]),
      stat: (p: string, done: (e: Error | null) => void) => done(FakeSsh2.dirs.has(p) ? null : Object.assign(new Error('No such file'), { code: 2 })),
      mkdir: (p: string, done: (e: Error | null) => void) => { FakeSsh2.dirs.add(p); done(null); },
      writeFile: (p: string, data: string, opts: { mode: number }, done: (e: Error | null) => void) => { FakeSsh2.files.set(p, { data: String(data), mode: opts.mode }); done(null); },
      chmod: (p: string, mode: number, done: (e: Error | null) => void) => { const f = FakeSsh2.files.get(p); if (f) f.mode = mode; done(null); },
      end: () => undefined,
    };
    cb(undefined, sftp);
    return this;
  }
  end() { return this; }
}

test('SFTP: TOFU fingerprint reported, pinned key accepted, mismatch refused, files written 0600', async (t) => {
  const hostKey = crypto.randomBytes(51);
  const otherKey = crypto.randomBytes(51);
  const fp = fingerprintOf(hostKey);
  t.after(() => setSsh2ClientFactoryForTests(null));

  setSsh2ClientFactoryForTests(() => new FakeSsh2(hostKey) as unknown as Ssh2ClientLike);
  const key = generateEd25519('oblimint/test');
  const first = await connectSftp({ address: '203.0.113.9', port: 22, username: 'deploy', privateKey: key.privateKey, expectedFingerprint: null });
  assert.equal(first.fingerprint, fp, 'TOFU: what the server presented');
  assert.equal(FakeSsh2.lastConfig?.host, '203.0.113.9', 'connects to the pinned address');
  assert.equal(FakeSsh2.lastConfig?.privateKey, key.privateKey);
  await first.mkdirp('/srv/certs/vault');
  assert.ok(FakeSsh2.dirs.has('/srv/certs') && FakeSsh2.dirs.has('/srv/certs/vault'));
  await first.writeFile('/srv/certs/vault/privkey.pem', 'KEY', 0o600);
  assert.equal(FakeSsh2.files.get('/srv/certs/vault/privkey.pem')?.mode, 0o600);
  first.close();

  const pinned = await connectSftp({ address: '203.0.113.9', port: 22, username: 'deploy', password: 'pw', expectedFingerprint: fp });
  assert.equal(pinned.fingerprint, fp);
  pinned.close();

  setSsh2ClientFactoryForTests(() => new FakeSsh2(otherKey) as unknown as Ssh2ClientLike);
  await assert.rejects(
    connectSftp({ address: '203.0.113.9', port: 22, username: 'deploy', password: 'pw', expectedFingerprint: fp }),
    (err: unknown) => err instanceof HostKeyMismatchError && err.fingerprint === fingerprintOf(otherKey),
  );
  assert.equal(sftpErrorText(new HostKeyMismatchError('x')), 'host key mismatch');

  setSsh2ClientFactoryForTests(() => new FakeSsh2(hostKey, false) as unknown as Ssh2ClientLike);
  await assert.rejects(connectSftp({ address: '203.0.113.9', port: 22, username: 'deploy', password: 'bad', expectedFingerprint: fp }),
    (err: unknown) => sftpErrorText(err) === 'authentication failed');

  // A server that never answers: bounded.
  setSsh2ClientFactoryForTests(() => ({ on() { return this; }, connect() { return this; }, sftp() { return this; }, end() { return this; } }) as unknown as Ssh2ClientLike);
  await assert.rejects(connectSftp({ address: '203.0.113.9', port: 22, username: 'u', password: 'p', expectedFingerprint: null, timeoutMs: 200 }),
    (err: unknown) => sftpErrorText(err) === 'timed out');
});

// ── certificate expiry dedup ─────────────────────────────────────────────────

test('certificate expiry: at most one notification per certificate per 7 days, marks pruned', () => {
  const now = new Date('2026-10-10T08:00:00Z');
  const certs: ExpiringCertificate[] = [
    { ref: 'acme:1', name: 'a.fr', notAfter: new Date('2026-10-15T00:00:00Z'), tenantId: 2, accountId: 5 },
    { ref: 'imported:3', name: 'b.fr', notAfter: new Date('2026-10-12T00:00:00Z'), tenantId: 2, accountId: 5 },
  ];
  assert.deepEqual(dueNotifications(certs, {}, now).map((c) => c.ref), ['acme:1', 'imported:3']);
  const marks = { 'acme:1': new Date(now.getTime() - 86_400_000).toISOString(), 'imported:3': new Date(now.getTime() - RENOTIFY_MS).toISOString() };
  assert.deepEqual(dueNotifications(certs, marks, now).map((c) => c.ref), ['imported:3'], 'acme:1 notified yesterday');
  assert.deepEqual(dueNotifications(certs, { 'acme:1': 'garbage' }, now).map((c) => c.ref), ['acme:1', 'imported:3']);
  const pruned = prunedMarks({ ...marks, 'acme:99': now.toISOString(), 'acme:1b': new Date(now.getTime() - 40 * 86_400_000).toISOString() }, new Set(['acme:1', 'imported:3', 'acme:1b']), now);
  assert.deepEqual(Object.keys(pruned).sort(), ['acme:1', 'imported:3'], 'renewed (gone) and stale marks dropped');
});

// ── SFTP: a session that stalls after 'ready' is bounded ────────────────────

/** Fake whose SFTP operations never answer (the server authenticated, then stalls). */
class StallingSsh2 extends EventEmitter {
  ended = false;
  connect(cfg: Record<string, unknown>) {
    setImmediate(() => { (cfg.hostVerifier as (k: Buffer) => boolean)(Buffer.from('k')); this.emit('ready'); });
    return this;
  }
  sftp(cb: (err: Error | undefined, sftp: unknown) => void) {
    const never = () => undefined;
    cb(undefined, { readdir: never, stat: never, mkdir: never, writeFile: never, chmod: never, end: never });
    return this;
  }
  end() { this.ended = true; return this; }
}

test('SFTP: stalled operations time out, a dropped connection rejects pending operations, the session deadline ends it', async (t) => {
  t.after(() => setSsh2ClientFactoryForTests(null));
  let last: StallingSsh2 | null = null;
  setSsh2ClientFactoryForTests(() => (last = new StallingSsh2()) as unknown as Ssh2ClientLike);
  const opts = { address: '203.0.113.9', port: 22, username: 'u', password: 'p', expectedFingerprint: null };

  // Per-operation timeout: the stalled readdir rejects, the session is unusable afterwards.
  const s1 = await connectSftp({ ...opts, timeoutMs: 100, sessionTimeoutMs: 60_000 });
  await assert.rejects(s1.readdir('.'), (err: unknown) => sftpErrorText(err) === 'timed out');
  assert.equal(last!.ended, true, 'connection ended');
  await assert.rejects(s1.writeFile('x', 'y', 0o600), (err: unknown) => sftpErrorText(err) === 'timed out');
  s1.close();

  // Connection closed while an operation is pending: rejected at once.
  const s2 = await connectSftp({ ...opts, timeoutMs: 60_000, sessionTimeoutMs: 60_000 });
  const pending = s2.mkdirp('/srv/a/b');
  setImmediate(() => last!.emit('close'));
  await assert.rejects(pending, (err: unknown) => err instanceof SftpError && err.message === 'connection closed');
  s2.close();

  // Session deadline: bounds the whole session even with generous per-operation timeouts.
  const s3 = await connectSftp({ ...opts, timeoutMs: 60_000, sessionTimeoutMs: 100 });
  const started = Date.now();
  await assert.rejects(s3.readdir('.'), (err: unknown) => sftpErrorText(err) === 'timed out');
  assert.ok(Date.now() - started < 5_000);
  s3.close();
});

// ── client-visible action errors (A6) ───────────────────────────────────────

test('action error texts: client-made texts only, raw library errors hidden', () => {
  assert.equal(actionErrorText('restart-app', new AppError(404, 'Application not found in this account', 'notFound')), 'Application not found in this account');
  assert.equal(actionErrorText('restart-app', new AppError(501, 'stub')), 'not available yet');
  assert.equal(actionErrorText('restart-app', new AppError(500, 'internal detail')), 'action failed');
  assert.equal(actionErrorText('restart-app', Object.assign(new Error('(HTTP code 500) server error - /var/lib/docker/x'), { statusCode: 500 })), 'action failed');
  assert.equal(actionErrorText('restart-app', Object.assign(new Error('connect ECONNREFUSED /var/run/docker.sock'), { code: 'ECONNREFUSED' })), 'action failed');
  assert.equal(actionErrorText('export-certificate', new SftpError('certificate missing')), 'certificate missing');
  assert.equal(actionErrorText('export-certificate', new HostKeyMismatchError('SHA256:x')), 'host key mismatch');
  assert.equal(actionErrorText('export-certificate', Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' })), 'authentication failed');
  assert.equal(actionErrorText('export-certificate', Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:22'), { code: 'ECONNREFUSED' })), 'connection refused');
  assert.equal(actionErrorText('export-certificate', Object.assign(new Error('duplicate key value violates unique constraint "x"'), { code: '23505' })), 'action failed');
  assert.equal(actionErrorText('export-certificate', new TargetRefusedError('destination refused (address not allowed)')), 'destination refused');
});

// ── anti-SSRF: the node's own public addresses ──────────────────────────────

test('anti-SSRF: the node public addresses (and its IPv6 /64) are refused through the refuse hook', async () => {
  const node = ['51.15.20.7', '2a01:e0a:5:6::1'];
  assert.equal(isNodeAddress('51.15.20.7', node), true);
  assert.equal(isNodeAddress('51.15.20.8', node), false);
  assert.equal(isNodeAddress('2a01:e0a:5:6::abcd', node), true, 'same /64');
  assert.equal(isNodeAddress('2a01:e0a:5:7::1', node), false);
  assert.equal(isNodeAddress('nope', node), false);
  const refuse = (ip: string) => isNodeAddress(ip, node);
  await assert.rejects(resolveTarget('51.15.20.7', { allowPrivate: false, refuse }), TargetRefusedError);
  await assert.rejects(resolveTarget('node.example.org', { allowPrivate: false, refuse, lookup: async () => [{ address: '51.15.20.7', family: 4 }] }), TargetRefusedError);
  assert.deepEqual(await resolveTarget('other.example.org', { allowPrivate: false, refuse, lookup: async () => [{ address: '51.15.20.9', family: 4 }] }), { address: '51.15.20.9', family: 4 });
});
