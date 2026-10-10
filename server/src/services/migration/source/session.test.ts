import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'stream';
import {
  SourceCommandError, SourceCommandRefusedError, SourceConnectionError, type SessionContext,
} from '../contracts/source';
import { MemoryCommandLogSink } from './commandLog';
import { SourceSessionImpl, parseCatManyFrames } from './session';
import type { ExecHandle, SshConnection } from './ssh';
import { CAT_MANY_MARKER } from './templates';

// ─────────────────────────────────────────────────────────────────────────────
// source-executor: SourceSession over a FAKE SSH connection (no network):
// phase rule, refusals logged, sensitive output never logged / never in an
// error, timeouts / caps / abort, MG10 guard outcome, sudo failure, stream,
// readFiles framing + batching + order mapping, ≤ 4 concurrent channels.
// ─────────────────────────────────────────────────────────────────────────────

interface Reply { stdout?: string | Buffer; stderr?: string; code?: number | null; delayMs?: number; hang?: boolean; chunks?: number }
type Handler = (command: string) => Reply;

class FakeConn implements SshConnection {
  commands: string[] = [];
  killed = 0;
  concurrent = 0;
  maxConcurrent = 0;
  closed = false;
  constructor(private readonly handler: Handler) {}

  async exec(command: string): Promise<ExecHandle> {
    this.commands.push(command);
    const spec = this.handler(command);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    let resolveDone!: (v: { code: number | null; signal: string | null }) => void;
    const done = new Promise<{ code: number | null; signal: string | null }>((r) => { resolveDone = r; });
    let finished = false;
    this.concurrent++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      this.concurrent--;
      stdout.end();
      stderr.end();
      setImmediate(() => resolveDone({ code, signal: null }));
    };
    setImmediate(() => {
      if (spec.stderr) stderr.write(spec.stderr);
      if (spec.stdout) {
        const buf = Buffer.isBuffer(spec.stdout) ? spec.stdout : Buffer.from(spec.stdout);
        const n = spec.chunks ?? 1;
        const size = Math.ceil(buf.length / n);
        for (let i = 0; i < buf.length; i += size) if (!finished) stdout.write(buf.subarray(i, i + size));
      }
      if (!spec.hang) setTimeout(() => finish(spec.code === undefined ? 0 : spec.code), spec.delayMs ?? 0);
    });
    return {
      stdout, stderr, stdin, done,
      kill: () => { if (!finished) { this.killed++; finish(null); } },
    };
  }

  close(): void { this.closed = true; }
}

function make(handler: Handler, ctx: Partial<SessionContext> = {}, useSudo = false) {
  const conn = new FakeConn(handler);
  const log = new MemoryCommandLogSink();
  const session = new SourceSessionImpl({
    sourceId: 7, useSudo, conn, log, ctx: { phase: 'discovery', discoveryId: 3, ...ctx } as SessionContext,
  });
  return { conn, log, session };
}

test('run: ok → one log row with the rendered command, never the output', async () => {
  const { session, log, conn } = make(() => ({ stdout: 'root\n' }));
  const r = await session.run('sys.whoami', {} as Record<string, never>);
  assert.equal(r.stdout, 'root\n');
  assert.equal(r.exitCode, 0);
  assert.deepEqual(conn.commands, ['LC_ALL=C id -un']);
  assert.equal(log.rows.length, 1);
  const row = log.rows[0];
  assert.deepEqual({ ...row, durationMs: 0 }, {
    sourceId: 7, discoveryId: 3, runId: null, template: 'sys.whoami', command: 'LC_ALL=C id -un', phase: 'discovery',
    sensitive: false, status: 'ok', exitCode: 0, bytesOut: 5, durationMs: 0, error: null,
  });
  assert.ok(!JSON.stringify(log.rows).includes('root\\n'));
});

test('refusals are logged (status refused, command <invalid>) and nothing runs', async () => {
  const { session, log, conn } = make(() => ({ stdout: 'x' }));
  const attempts: Array<[string, unknown]> = [
    ['sys.exec', { cmd: 'rm -rf /' }],
    ['secret.mailboxHashes', { domain: 'example.tld' }],
    ['mysql.dumpData', { database: 'db', charset: 'utf8mb4', gzip: false }],
    ['fs.realpath', { path: '/home/a/b' }],
    ['rsync.sender', { options: ['-ltre.'], path: '/home/a/b/' }],
    ['fs.cat', { path: '/etc/shadow' }],
    ['fs.cat', { path: '/home/acct1/public_html/wp-config.php' }],
    ['mysql.query', { sql: 'SELECT Password FROM mysql.user' }],
  ];
  for (const [t, a] of attempts) {
    await assert.rejects(session.run(t as 'sys.whoami', a as Record<string, never>), (err: unknown) => {
      assert.ok(err instanceof SourceCommandRefusedError);
      assert.equal(err.code, 'commandRefused');
      return true;
    });
  }
  assert.equal(conn.commands.length, 0);
  assert.equal(log.rows.length, attempts.length);
  for (const row of log.rows) {
    assert.equal(row.status, 'refused');
    assert.equal(row.command, '<invalid>');
    assert.ok(row.error);
  }
  assert.equal(log.rows[1].sensitive, true);
  assert.match(log.rows[1].error!, /transfer-only/);
  assert.equal(log.rows[3].error, 'internal template');
  assert.match(log.rows[7].error!, /^sql: /);
  // stream(): only the streamable templates
  await assert.rejects(session.stream('sys.whoami' as 'fs.cat', {} as { path: string }, { stdout: new PassThrough() }), SourceCommandRefusedError);
  // rsyncPull in a discovery session
  await assert.rejects(session.rsyncPull({ binding: { kind: 'account', cwpUsername: 'a', targetAccountId: 1 }, remotePath: '/home/a/x', localPath: '/srv/oblimint/x', uid: 1000, gid: 1000, preset: 'site-files' }), SourceCommandRefusedError);
  assert.equal(log.rows.at(-1)!.template, 'rsync.sender');
  assert.equal(log.rows.at(-1)!.status, 'refused');
});

test('sensitive output never reaches the log nor an error message', async () => {
  const HASH = '{SHA512-CRYPT}$6$saltsalt$VERYSECRETHASHVALUE';
  const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEv-SECRET\n-----END PRIVATE KEY-----\n';
  let reply: Reply = { stdout: `username\tpassword\nbob@example.tld\t${HASH}\n` };
  const { session, log } = make(() => reply, { phase: 'transfer', runId: 9, discoveryId: null });
  const ok = await session.run('secret.mailboxHashes', { domain: 'example.tld' });
  assert.ok(ok.stdout.includes(HASH), 'the caller gets the value');
  reply = { stdout: KEY };
  await session.run('secret.dkimPrivateKey', { domain: 'example.tld', selector: 'default' });
  // Failure whose stderr / stdout carry the secret.
  reply = { stdout: HASH, stderr: `error near ${HASH}`, code: 1 };
  await assert.rejects(session.run('secret.mailboxHashes', { domain: 'example.tld' }), (err: unknown) => {
    assert.ok(err instanceof SourceCommandError);
    assert.equal(err.message, 'command failed (exit 1)');
    assert.ok(!err.message.includes('SECRET'));
    return true;
  });
  reply = { stdout: KEY, code: 0, hang: true };
  await assert.rejects(session.run('secret.certificateKey', { fqdn: 'example.tld' }, { timeoutMs: 30 }), (err: unknown) => {
    assert.ok(err instanceof SourceCommandError);
    assert.ok(!err.message.includes('SECRET'));
    return true;
  });
  reply = { stdout: KEY + KEY, code: 0 };
  await assert.rejects(session.run('secret.certificateKey', { fqdn: 'example.tld' }, { maxBytes: 10 }), (err: unknown) => {
    assert.ok(!(err as Error).message.includes('SECRET'));
    return true;
  });
  const dump = JSON.stringify(log.rows);
  assert.ok(!dump.includes('SECRET'), dump);
  assert.ok(!dump.includes('VERYSECRETHASH'));
  assert.ok(log.rows.every((r) => r.sensitive && r.runId === 9 && r.discoveryId === null && r.phase === 'transfer'));
  assert.deepEqual(log.rows.map((r) => r.status), ['ok', 'ok', 'error', 'timeout', 'error']);
});

test('errors: non-zero exit (allowNonZeroExit), stderr excerpt for non-sensitive only, connection lost', async () => {
  let reply: Reply = { stdout: '', stderr: 'cat: /etc/nginx/x: No such file or directory\n', code: 1 };
  const { session, log } = make(() => reply);
  await assert.rejects(session.run('fs.cat', { path: '/etc/nginx/x' }), (err: unknown) => {
    assert.ok(err instanceof SourceCommandError);
    assert.equal(err.exitCode, 1);
    assert.match(err.message, /^exit 1: cat: /);
    return true;
  });
  const r = await session.run('fs.cat', { path: '/etc/nginx/x' }, { allowNonZeroExit: true });
  assert.equal(r.exitCode, 1);
  assert.equal(log.rows[0].error, 'exit 1', 'stderr is never stored');
  reply = { stdout: 'partial', code: null };
  await assert.rejects(session.run('sys.hostname', {} as Record<string, never>, { allowNonZeroExit: true }), /connection lost/);
});

test('timeout kills the channel; output cap truncates (allowNonZeroExit keeps the head)', async () => {
  const big = 'a'.repeat(10_000);
  let reply: Reply = { hang: true };
  const { session, log, conn } = make(() => reply);
  await assert.rejects(session.run('sys.passwd', {} as Record<string, never>, { timeoutMs: 20 }), /timed out/);
  assert.equal(conn.killed, 1);
  assert.equal(log.rows[0].status, 'timeout');
  reply = { stdout: big, chunks: 10, hang: true };
  await assert.rejects(session.run('sys.passwd', {} as Record<string, never>, { maxBytes: 2500 }), /output larger than 2500/);
  const r = await session.run('sys.passwd', {} as Record<string, never>, { maxBytes: 2500, allowNonZeroExit: true });
  assert.equal(r.truncated, true);
  assert.equal(r.stdout.length, 2500);
  assert.equal(log.rows[1].status, 'error');
});

test('MG10: guard exit → refused symlinkPath (logged with the real command)', async () => {
  const { session, log } = make(() => ({ stderr: 'oblimint: path crosses a symbolic link\n', code: 86 }));
  await assert.rejects(session.run('fs.cat', { path: '/home/acct1/public_html/.htaccess' }), (err: unknown) => {
    assert.ok(err instanceof SourceCommandRefusedError);
    assert.equal(err.reason, 'symlinkPath');
    return true;
  });
  assert.equal(log.rows[0].status, 'refused');
  assert.equal(log.rows[0].error, 'symlinkPath');
  assert.match(log.rows[0].command, /realpath -e/);
});

test('sudo: commands wrapped, a password prompt is sudoFailed', async () => {
  const { session, conn } = make(() => ({ stderr: 'sudo: a password is required\n', code: 1 }), {}, true);
  await assert.rejects(session.run('sys.whoami', {} as Record<string, never>), (err: unknown) => {
    assert.ok(err instanceof SourceConnectionError);
    assert.equal(err.code, 'sudoFailed');
    return true;
  });
  assert.equal(conn.commands[0], "sudo -n -- sh -c 'LC_ALL=C id -un'");
});

test('stream: bytes go to the writable, nothing buffered; failure throws', async () => {
  const payload = Buffer.alloc(300_000, 7);
  let reply: Reply = { stdout: payload, chunks: 30 };
  const { session, log } = make(() => reply, { phase: 'transfer', runId: 1, discoveryId: null });
  const got: Buffer[] = [];
  const sink = new Writable({ write(c, _e, cb) { got.push(c); setImmediate(cb); }, highWaterMark: 1024 });
  const ticks: number[] = [];
  const r = await session.stream('mysql.dumpData', { database: 'acct1_wp', charset: 'utf8mb4', gzip: true }, { stdout: sink, onBytes: (n) => ticks.push(n) });
  assert.equal(r.stdout, '');
  assert.equal(r.bytesOut, payload.length);
  assert.equal(Buffer.concat(got).length, payload.length);
  assert.equal(ticks.at(-1), payload.length);
  assert.equal(log.rows[0].bytesOut, payload.length);
  reply = { stdout: 'x', code: 2 };
  await assert.rejects(session.stream('dns.axfr', { zone: 'example.tld' }, { stdout: new PassThrough() }), /exit 2/);
});

function frame(path: string, content: Buffer | null, max: number): Buffer {
  if (!content) return Buffer.from(`${CAT_MANY_MARKER} -1 ${path}\n\n`);
  const n = Math.min(content.length, max);
  return Buffer.concat([Buffer.from(`${CAT_MANY_MARKER} ${content.length} ${path}\n`), content.subarray(0, n), Buffer.from('\n')]);
}

test('parseCatManyFrames: binary-safe, sizes, missing, truncated tail', () => {
  const bin = Buffer.from([0x40, 0x40, 0x0a, 0x00, 0xff, 0x0a]);
  const buf = Buffer.concat([
    frame('/a', Buffer.from('hello\n'), 100), frame('/b', null, 100), frame('/c', bin, 100), frame('/d', Buffer.from('0123456789'), 4),
  ]);
  const out = parseCatManyFrames(buf, 4, 100);
  assert.equal(out[0]?.toString(), 'hello\n');
  assert.equal(out[1], null);
  assert.deepEqual(out[2], bin);
  // size 10 but max 4 for this frame: parsed with the same max as rendered
  const out2 = parseCatManyFrames(frame('/d', Buffer.from('0123456789'), 4), 1, 4);
  assert.equal(out2[0]?.toString(), '0123');
  // truncated output → tail null
  const cut = parseCatManyFrames(buf.subarray(0, buf.length - 5), 4, 100);
  assert.equal(cut[0]?.toString(), 'hello\n');
  assert.equal(cut[3], null);
  assert.deepEqual(parseCatManyFrames(Buffer.from('garbage'), 2, 10), [null, null]);
});

test('readFiles: order mapping, missing, denied → null + refused row, batching by size', async () => {
  const files: Record<string, string> = {
    '/etc/nginx/a.conf': 'A', '/etc/nginx/b.conf': 'Bé', '/home/acct1/public_html/.htaccess': 'AddHandler x',
  };
  const batches: number[] = [];
  const { session, log, conn } = make((command) => {
    // Paths are the trailing single-quoted args after the max bytes.
    const m = /oblimint (\d+) (.*)$/.exec(command)!;
    const max = Number(m[1]);
    const paths = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    batches.push(paths.length);
    // Header path deliberately differs (mapping is BY ORDER).
    return { stdout: Buffer.concat(paths.map((p) => frame(`X${p}`, p in files ? Buffer.from(files[p]) : null, max))) };
  });
  const req = ['/etc/nginx/b.conf', '/etc/nginx/missing.conf', '/etc/shadow', '/home/acct1/public_html/.htaccess', '/etc/nginx/a.conf', '/etc/nginx/a.conf'];
  const out = await session.readFiles(req);
  assert.equal(out.get('/etc/nginx/b.conf'), 'Bé');
  assert.equal(out.get('/etc/nginx/missing.conf'), null);
  assert.equal(out.get('/etc/shadow'), null);
  assert.equal(out.get('/home/acct1/public_html/.htaccess'), 'AddHandler x');
  assert.equal(out.get('/etc/nginx/a.conf'), 'A');
  assert.equal(conn.commands.length, 1);
  assert.deepEqual(batches, [4]);
  const refusedRows = log.rows.filter((r) => r.status === 'refused');
  assert.equal(refusedRows.length, 1);
  assert.match(refusedRows[0].error!, /outside the read roots/);
  assert.equal(refusedRows[0].template, 'fs.catMany');

  // 2 MiB per file → 2 paths per batch (≤ 4 MiB expected); 250 small paths → 200 + 50.
  batches.length = 0;
  await session.readFiles(['/etc/nginx/1', '/etc/nginx/2', '/etc/nginx/3', '/etc/nginx/4', '/etc/nginx/5'], { maxBytesPerFile: 2 * 1024 * 1024 });
  assert.deepEqual(batches, [2, 2, 1]);
  batches.length = 0;
  await session.readFiles(Array.from({ length: 250 }, (_, i) => `/etc/nginx/f${i}`), { maxBytesPerFile: 100 });
  assert.deepEqual(batches, [200, 50]);
});

test('at most 4 channels at once per session (queued)', async () => {
  const { session, conn } = make(() => ({ stdout: 'x', delayMs: 15 }));
  await Promise.all(Array.from({ length: 10 }, () => session.run('sys.hostname', {} as Record<string, never>)));
  assert.equal(conn.maxConcurrent, 4);
  assert.equal(conn.commands.length, 10);
});

test('abort: the context signal kills running channels and closes the session', async () => {
  const ac = new AbortController();
  const { session, conn, log } = make(() => ({ hang: true }), { signal: ac.signal });
  const p = session.run('sys.passwd', {} as Record<string, never>);
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(p, /cancelled/);
  assert.equal(conn.closed, true);
  assert.equal(log.rows[0].error, 'cancelled');
  await assert.rejects(session.run('sys.hostname', {} as Record<string, never>), SourceConnectionError);
});
