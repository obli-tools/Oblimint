import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { PassThrough, Duplex } from 'stream';
import { SourceCommandError, SourceCommandRefusedError, type RsyncPullRequest } from '../contracts/source';
import { MemoryCommandLogSink } from './commandLog';
import {
  RsyncRequestError, buildLocalRsyncArgv, parseDeletionLine, parseItemized, parseOutFormatLine, parseRsyncStats, parseUnsafeLinks, rshCommandLine,
  validateRsyncRequest, validateRsyncServerArgv,
} from './rsyncArgv';
import { defaultShimCommand, runRsyncPull, type RsyncDeps, type RsyncSessionPort } from './rsync';
import type { ExecHandle } from './ssh';
import { openTunnel, purgeStaleTunnels, readHandshake } from './tunnel';

// ─────────────────────────────────────────────────────────────────────────────
// source-executor: rsync pulls (docs/P5-PLAN.md §5.6, MG6, MG10) — request
// validation, local argv per preset, SERVER argv validation (what the shim
// forwards), stats parsing, tunnel handshake (in-memory and through the real
// tunnel: unix socket on Linux, named pipe on win32), the real shim script,
// and the whole pull with a fake local rsync + fake remote channel.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = '/srv/oblimint';
const REMOTE = '/home/acct1/public_html';
const H = 'oblimint-source';

test('server argv: accepted forms (3.1 / 3.2 / dry-run / bwlimit / harmless long options)', () => {
  const ok: string[][] = [
    [H, 'rsync', '--server', '--sender', '-ltre.iLsfxC', '.', `${REMOTE}/`],
    [H, 'rsync', '--server', '--sender', '-ltre.iLsfxCIvu', '.', `${REMOTE}/`],
    [H, 'rsync', '--server', '--sender', '-nltre.iLsfxCIvu', '.', `${REMOTE}/`],
    [H, 'rsync', '--server', '--sender', '-vltre.iLsfxCIvu', '--bwlimit=500', '.', `${REMOTE}/`],
    [H, 'rsync', '--server', '--sender', '-ltr', '--safe-links', '--numeric-ids', '--log-format=%n', '.', `${REMOTE}/`],
  ];
  for (const a of ok) {
    const v = validateRsyncServerArgv(a, REMOTE);
    assert.deepEqual(v, { options: a.slice(4, -2), path: `${REMOTE}/` });
  }
});

test('server argv: refusals', () => {
  const base = (opts: string[], p = `${REMOTE}/`, head = [H, 'rsync', '--server', '--sender']) => [...head, ...opts, '.', p];
  const bad: Array<[unknown, RegExp]> = [
    [base(['-ltre.iLsfxC'], `${REMOTE}/`, [H, 'rsync', '--server']), /--sender|unexpected/],
    [[H, 'rsync', '--server', '-ltre.iLsfxC', '.', `${REMOTE}/`], /--sender/],
    [base(['-ltre.iLsfxC', '--remove-source-files']), /refused/],
    [base(['-ltre.iLsfxC', '--remove-sent-files']), /refused/],
    [base(['-ltre.iLsfxC', '--delete']), /refused/],
    [base(['-ltre.iLsfxC', '--delete-after']), /refused/],
    [base(['-ltre.iLsfxC', '--files-from=/etc/passwd']), /refused/],
    [base(['-ltre.iLsfxC', '--rsync-path=sh -c id']), /refused/],
    [base(['-ltre.iLsfxC', '--log-file=/tmp/x']), /refused/],
    [base(['-ltre.iLsfxC', '--write-batch=x']), /refused/],
    [base(['-ltre.iLsfxC', '--only-write-batch=x']), /refused/],
    [base(['-ltre.iLsfxC', '--temp-dir=/tmp']), /refused/],
    [base(['-ltre.iLsfxC', '--backup']), /refused/],
    [base(['-ltre.iLsfxC', '--backup-dir=/tmp']), /refused/],
    [base(['-ltre.iLsfxC', '-e', 'sh']), /-e|length/],
    [base(['-ltre.iLsfxC', '-e']), /-e/],
    [base(['-ltre.iLsfxC', '--rsh=sh']), /-e|refused/],
    [base(['-ltre.iLsfxC', '--compress']), /not allowed/],
    [base(['-ltre.iLsfxC', '--from0']), /not allowed/],
    [base(['-logDtpre.iLsfxC']), /not allowed/],
    [base(['-ltrze.iLsfxC']), /not allowed/],
    [base(['-lte.iLsfxC']), /recursive/],
    [base(['-ltre.iLsfxC', '-ltr']), /exactly one/],
    [base([]), /exactly one/],
    [base(['-ltre.iLsfxC'], '/home/acct2/public_html/'), /path is not/],
    [base(['-ltre.iLsfxC'], REMOTE), /path is not/],
    [base(['-ltre.iLsfxC'], '/'), /path is not/],
    [[H, 'rsync', '--server', '--sender', '-ltre.iLsfxC', `${REMOTE}/`, '.'], /path|\./],
    [['evil-host', 'rsync', '--server', '--sender', '-ltre.iLsfxC', '.', `${REMOTE}/`], /host/],
    [[H, 'sh', '--server', '--sender', '-ltre.iLsfxC', '.', `${REMOTE}/`], /rsync --server/],
    [[H, 'rsync', '--server', '--sender', '-ltre.iLsfxC', '.', `${REMOTE}/`, 'extra'], /path is not/],
    ['rsync --server --sender', /array/],
    [[H, 'rsync', '--server', '--sender', 1, '.', `${REMOTE}/`], /array/],
  ];
  for (const [argv, re] of bad) {
    assert.throws(() => validateRsyncServerArgv(argv, REMOTE), (err: unknown) => err instanceof RsyncRequestError && re.test(err.reason), JSON.stringify(argv));
  }
});

const req = (o: Partial<RsyncPullRequest> = {}): RsyncPullRequest => ({
  binding: { kind: 'account', cwpUsername: 'acct1', targetAccountId: 4 }, remotePath: REMOTE, localPath: `${ROOT}/accounts/4/staging/www`, uid: 1004, gid: 1004, preset: 'site-files', ...o,
});

test('request validation: uid / gid, remote roots, local root, excludes, presets', () => {
  assert.equal(validateRsyncRequest(req(), ROOT, 0).remotePath, REMOTE);
  const box = { binding: { kind: 'mailbox' as const, address: 'info@example.tld' }, preset: 'maildir' as const, uid: 5000, gid: 5000, localPath: `${ROOT}/mail/data/postfix-dovecot/vmail/example.tld/info/Maildir` };
  assert.equal(validateRsyncRequest(req({ ...box, remotePath: '/var/vmail/example.tld/info' }), ROOT, 0).uid, 5000);
  assert.equal(validateRsyncRequest(req({ ...box, remotePath: '/var/vmail/example.tld/info' }), ROOT, 0).runAs, null);
  assert.equal(validateRsyncRequest(req({ ...box, remotePath: '/var/vmail/example.tld/info/sieve', localPath: `${ROOT}/mail/data/postfix-dovecot/vmail/example.tld/info/sieve` }), ROOT, 0).uid, 5000);
  assert.equal(validateRsyncRequest(req(), ROOT, 0).runAs, 'acct1');
  assert.equal(validateRsyncRequest(req(), ROOT, 2048).bwLimitKbps, 2048);
  assert.equal(validateRsyncRequest(req({ bwLimitKbps: 100 }), ROOT, 2048).bwLimitKbps, 100);
  const bad: Array<[Partial<RsyncPullRequest>, RegExp]> = [
    [{ uid: 0 }, /uid/], [{ gid: 0 }, /gid/], [{ uid: 999 }, /uid/], [{ uid: -1 }, /uid/], [{ uid: 1.5 }, /uid/],
    [{ remotePath: '/etc' }, /remotePath/], [{ remotePath: '/root/x' }, /remotePath/], [{ remotePath: '/home/acct1' }, /remotePath/],
    [{ remotePath: '/home/acct1/../acct2/x' }, /remotePath/], [{ remotePath: '/home/acct1/.ssh' }, /\.ssh/],
    [{ remotePath: '/home/acct1/my dir' }, /characters/], [{ remotePath: "/home/acct1/it's" }, /characters/],
    [{ remotePath: '/home/acct1/public_html/' }, /trailing/], [{ remotePath: 'home/acct1/x' }, /absolute/],
    [{ remotePath: '/var/vmail/example.tld', preset: 'maildir' }, /remotePath/],
    [{ remotePath: '/var/vmail/EXAMPLE..tld/info', preset: 'maildir' }, /remotePath|domain/],
    [{ remotePath: '/var/vmail/example.tld/info' }, /preset/], [{ preset: 'maildir' }, /preset maildir/],
    // §5.3 / MG6: the executor binds both paths to the transfer's account / mailbox.
    [{ binding: undefined as never }, /binding/], [{ remotePath: '/home/acct2/public_html' }, /transfer account/],
    [{ localPath: `${ROOT}/accounts/5/staging/www` }, /target account/], [{ preset: 'site-data' }, /account's data/],
    [{ binding: { kind: 'mailbox', address: 'info@example.tld' } }, /binding/],
    [{ ...box, remotePath: '/var/vmail/victim.tld/ceo' }, /mailbox's maildir/],
    [{ ...box, remotePath: '/var/vmail/example.tld/info2' }, /mailbox's maildir/],
    [{ ...box, remotePath: '/var/vmail/example.tld/info', localPath: `${ROOT}/mail/data/postfix-dovecot/vmail/victim.tld/ceo/Maildir` }, /mailbox's directory/],
    [{ ...box, remotePath: '/var/vmail/example.tld/info', localPath: `${ROOT}/accounts/4/staging/www` }, /mailbox's directory/],
    [{ ...box, binding: { kind: 'account', cwpUsername: 'acct1', targetAccountId: 4 }, remotePath: '/var/vmail/example.tld/info' }, /binding/],
    [{ preset: 'all' as never }, /preset/],
    [{ localPath: '/etc/x' }, /outside/], [{ localPath: '/srv/oblimintx/a' }, /outside/], [{ localPath: ROOT }, /outside/],
    [{ localPath: `${ROOT}/accounts/../../etc` }, /normalized/], [{ localPath: 'accounts/4' }, /absolute/],
    [{ localPath: `${ROOT}/a\nb` }, /control/],
    [{ excludes: ['../etc'] }, /excludes/], [{ excludes: ['a b'] }, /excludes/], [{ excludes: ['x;rm'] }, /excludes/],
    [{ excludes: Array.from({ length: 101 }, () => 'x') }, /excludes/], [{ bwLimitKbps: 1.5 }, /bwLimit/],
  ];
  for (const [o, re] of bad) {
    assert.throws(() => validateRsyncRequest(req(o), ROOT, 0), (err: unknown) => err instanceof RsyncRequestError && re.test(err.reason), JSON.stringify(o));
  }
});

test('local argv per preset (MG6: --safe-links, never owner / devices; --delete only on request)', () => {
  const rsh = rshCommandLine(['/usr/local/bin/node', '/app/dist/src/services/migration/source/rsyncShim.js']);
  assert.deepEqual(buildLocalRsyncArgv(validateRsyncRequest(req({ excludes: ['wp-content/cache/*'] }), ROOT, 0), rsh), [
    '-rlt', '--safe-links', '--no-protect-args', '--no-owner', '--no-group', '--chmod=D0755,F0644', '--partial-dir=.oblimint-partial',
    '--exclude=wp-content/cache/*', '--out-format=oblimint:%l:%n', '--stats',
    '--rsh=/usr/local/bin/node /app/dist/src/services/migration/source/rsyncShim.js',
    `oblimint-source:${REMOTE}/`, '.',
  ]);
  assert.deepEqual(buildLocalRsyncArgv(validateRsyncRequest(req({
    binding: { kind: 'mailbox', address: 'info@example.tld' },
    remotePath: '/var/vmail/example.tld/info', localPath: `${ROOT}/mail/data/postfix-dovecot/vmail/example.tld/info/Maildir`, preset: 'maildir',
    uid: 5000, gid: 5000, deleteExtraneous: true, bwLimitKbps: 1000, dryRun: true,
  }), ROOT, 0), rsh), [
    '-rlt', '--safe-links', '--no-protect-args', '--chmod=D0700,F0600', '--exclude=dovecot.index*', '--exclude=dovecot.list.index*',
    '--delete', '--bwlimit=1000', '--dry-run', '--itemize-changes', '--stats',
    '--rsh=/usr/local/bin/node /app/dist/src/services/migration/source/rsyncShim.js',
    'oblimint-source:/var/vmail/example.tld/info/', '.',
  ]);
  assert.equal(rshCommandLine(['C:/Program Files/node.exe', '--import', 'tsx', '/x/rsyncShim.ts']), "'C:/Program Files/node.exe' --import tsx /x/rsyncShim.ts");
  assert.throws(() => rshCommandLine(["/it's/node"]), RsyncRequestError);
  const shim = defaultShimCommand();
  assert.equal(shim[0], process.execPath);
  assert.ok(shim.at(-1)!.endsWith('rsyncShim.ts'), 'under tsx the .ts shim is used');
  assert.equal(shim[1], '--import');
  assert.match(shim[2], /^file:\/\/.*\/tsx\/.*loader\.mjs$/, 'absolute tsx loader: the shim runs with the destination as cwd');
});

test('stats / itemized / unsafe links parsing', () => {
  const stats = [
    'Number of files: 1,234 (reg: 1,000, dir: 234)', 'Number of created files: 10', 'Number of deleted files: 3',
    'Number of regular files transferred: 1,001', 'Total file size: 99,999 bytes', 'Total transferred file size: 12,345,678 bytes',
  ].join('\n');
  assert.deepEqual(parseRsyncStats(stats), { files: 1001, bytes: 12345678, deleted: 3 });
  assert.deepEqual(parseRsyncStats(''), { files: 0, bytes: 0, deleted: 0 });
  assert.deepEqual(parseItemized('>f+++++++++ a.php\ncd+++++++++ dir/\n*deleting   old.txt\n>f.st...... b.css\n'), { files: 2, deleted: 1 });
  // Per-file lines of a real pull: only the tagged lines count, directories excluded.
  assert.deepEqual(parseOutFormatLine('oblimint:1234:public_html/index.php'), { bytes: 1234, name: 'public_html/index.php' });
  assert.deepEqual(parseOutFormatLine('oblimint:0:a b.txt\r'), { bytes: 0, name: 'a b.txt' });
  for (const l of ['oblimint:4096:wp-content/', 'Number of created files: 10', 'Number of regular files transferred: 3', 'Total bytes sent: 9',
    'rsync: [receiver] warning: x', 'index.php', '', 'oblimint:x:a', 'oblimint:12:']) {
    assert.equal(parseOutFormatLine(l), null, l);
  }
  assert.deepEqual(parseUnsafeLinks('ignoring unsafe symlink "public_html/etc" -> "/etc"\nrsync warning: x\nignoring unsafe symlink "a/b" -> "../../x"\n'), ['public_html/etc', 'a/b']);
});

/** In-memory duplex pair. */
function duplexPair(): [Duplex, Duplex] {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const mk = (readFrom: PassThrough, writeTo: PassThrough) => {
    const d = new Duplex({
      read() { /* driven below */ },
      write(chunk, _enc, cb) { writeTo.write(chunk, cb); },
      final(cb) { writeTo.end(); cb(); },
    });
    readFrom.on('data', (c) => d.push(c));
    readFrom.on('end', () => d.push(null));
    return d;
  };
  return [mk(bToA, aToB), mk(aToB, bToA)];
}

test('tunnel handshake: token checked, extra bytes kept for rsync, malformed / bad token / oversize refused', async () => {
  {
    const [panel, shim] = duplexPair();
    const p = readHandshake(panel, 'tok');
    shim.write(`${JSON.stringify({ token: 'tok', argv: ['a', 'b'] })}\nRSYNC-BYTES`);
    assert.deepEqual(await p, { argv: ['a', 'b'] });
    const restP = new Promise<Buffer>((r) => panel.once('data', r));
    panel.resume(); // explicitly paused by readHandshake (production: pipe() + resume())
    const rest = await restP;
    assert.equal(rest.toString(), 'RSYNC-BYTES');
  }
  for (const [payload, re] of [
    [`${JSON.stringify({ token: 'nope', argv: [] })}\n`, /bad tunnel token/],
    [`${JSON.stringify({ argv: [] })}\n`, /bad tunnel token/],
    ['{not json}\n', /malformed/],
    ['x'.repeat(70 * 1024), /too large/],
  ] as Array<[string, RegExp]>) {
    const [panel, shim] = duplexPair();
    const p = readHandshake(panel, 'tok');
    shim.write(payload);
    await assert.rejects(p, re);
  }
  const [panel, shim] = duplexPair();
  const p = readHandshake(panel, 'tok', 30);
  void shim;
  await assert.rejects(p, /timeout/);
});

/** Fake remote `rsync --server --sender`: echoes what it receives, prefixed. */
function fakeRemote(code: number | null = 0): { handle: ExecHandle; received: () => string } {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  let got = '';
  let resolveDone!: (v: { code: number | null; signal: string | null }) => void;
  const done = new Promise<{ code: number | null; signal: string | null }>((r) => { resolveDone = r; });
  stdin.on('data', (d) => { got += d.toString(); stdout.write(`REMOTE:${d.toString()}`); });
  stdin.on('end', () => { stdout.end(); setImmediate(() => resolveDone({ code, signal: null })); });
  return {
    handle: { stdout, stderr: new PassThrough(), stdin, done, kill: () => { stdout.end(); resolveDone({ code: null, signal: 'KILL' }); } },
    received: () => got,
  };
}

function makePort(log: MemoryCommandLogSink, opts: { realpath?: string | null; remoteCode?: number | null } = {}) {
  const opened: Array<{ options: string[]; path: string; runAs?: string | null }> = [];
  let remote: ReturnType<typeof fakeRemote> | null = null;
  const port: RsyncSessionPort = {
    sourceId: 1,
    async refuse(template, reason, command = '<invalid>') {
      await log.write({ sourceId: 1, discoveryId: null, runId: 5, template, command, phase: 'transfer', sensitive: false, status: 'refused', exitCode: null, bytesOut: 0, durationMs: 0, error: reason });
      return new SourceCommandRefusedError(template, reason);
    },
    async realpath(p) {
      await log.write({ sourceId: 1, discoveryId: null, runId: 5, template: 'fs.realpath', command: `realpath ${p}`, phase: 'transfer', sensitive: false, status: 'ok', exitCode: 0, bytesOut: 0, durationMs: 0, error: null });
      return opts.realpath === undefined ? p : opts.realpath;
    },
    async openSender(options, p, runAs) {
      opened.push({ options, path: p, runAs });
      remote = fakeRemote(opts.remoteCode ?? 0);
      return { handle: remote.handle, finished: remote.handle.done.then((d) => d.code) };
    },
  };
  return { port, opened, remote: () => remote };
}

function tmpRoot(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-rsync-')).replace(/\\/g, '/');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(`${dir}/accounts/4/staging/www`, { recursive: true });
  return dir;
}

/**
 * Fake local rsync: checks what it was spawned with, then behaves like the
 * shim (connects to the tunnel, sends {token, argv} + bytes) and exits.
 */
function fakeSpawn(record: { args?: string[]; opts?: Record<string, any> }, behaviour: { argv?: string[]; token?: string; exitCode?: number; stdout?: string; stderr?: string }) {
  return (_cmd: string, args: string[], opts: Record<string, any>) => {
    record.args = args;
    record.opts = opts;
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean; exitCode: number | null };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => true;
    const sock = net.connect({ path: opts.env.OBLIMINT_TUNNEL, allowHalfOpen: true });
    let echoed = '';
    sock.on('connect', () => {
      sock.write(`${JSON.stringify({ token: behaviour.token ?? opts.env.OBLIMINT_TUNNEL_TOKEN, argv: behaviour.argv })}\nHELLO`);
      sock.end();
    });
    sock.on('data', (d) => { echoed += d.toString(); });
    sock.on('error', () => undefined);
    sock.on('close', () => {
      if (behaviour.stdout) child.stdout.write(`${behaviour.stdout}\n`);
      child.stdout.write(`echo=${echoed}\n`);
      if (behaviour.stderr) child.stderr.write(behaviour.stderr);
      child.stdout.end();
      child.stderr.end();
      child.exitCode = behaviour.exitCode ?? 0;
      setImmediate(() => child.emit('close', behaviour.exitCode ?? 0));
    });
    return child as never;
  };
}

const goodArgv = (remote = REMOTE) => [H, 'rsync', '--server', '--sender', '-ltre.iLsfxCIvu', '.', `${remote}/`];

function deps(root: string, spawnFn: unknown): Partial<RsyncDeps> {
  return {
    dataRoot: root, tunnelsRoot: `${root}/migration/tunnels`, rsyncBinary: 'rsync', defaultBwLimitKbps: 0, chown: false,
    spawn: spawnFn as RsyncDeps['spawn'], shimCommand: () => ['/usr/bin/node', '/app/rsyncShim.js'],
  };
}

test('rsyncPull: full flow through the real tunnel (fake local rsync, fake remote sender)', async (t) => {
  const root = tmpRoot(t);
  const log = new MemoryCommandLogSink();
  const { port, opened, remote } = makePort(log);
  const rec: { args?: string[]; opts?: Record<string, any> } = {};
  const progress: Array<{ bytes: number; files: number }> = [];
  // Leftover of a panel killed during a pull (MG9): purged before the first tunnel of the process.
  fs.mkdirSync(`${root}/migration/tunnels/0123456789abcdef0123456789abcdef`, { recursive: true });
  fs.writeFileSync(`${root}/migration/tunnels/0123456789abcdef0123456789abcdef/s`, '');
  const res = await runRsyncPull(port, req({ localPath: `${root}/accounts/4/staging/www`, onProgress: (p) => progress.push(p) }), deps(root, fakeSpawn(rec, {
    argv: goodArgv(),
    stdout: 'oblimint:1000:index.php\noblimint:4096:wp-content/\nNumber of created files: 3\nNumber of deleted files: 0\nNumber of regular files transferred: 42\nTotal transferred file size: 4,096 bytes',
    stderr: 'ignoring unsafe symlink "public_html/etc" -> "/etc"\n',
  })));
  assert.equal(res.exitCode, 0);
  assert.equal(res.files, 42);
  assert.equal(res.bytes, 4096);
  assert.equal(res.partial, false);
  assert.deepEqual(res.unsafeLinks, ['public_html/etc']);
  assert.deepEqual(opened, [{ options: ['-ltre.iLsfxCIvu'], path: `${REMOTE}/`, runAs: 'acct1' }]);
  assert.equal(remote()!.received(), 'HELLO', 'bytes after the handshake reach the remote sender');
  assert.deepEqual(progress[0], { bytes: 1000, files: 1 }, 'live progress: tagged file lines only, bytes summed');
  assert.deepEqual(progress.at(-1), { bytes: 4096, files: 42 });
  // Spawned as the transfer uid with a minimal env.
  assert.equal(rec.opts!.uid, 1004);
  assert.equal(rec.opts!.gid, 1004);
  // rsync 3.5.0 cannot chdir into an absolute destination below root 0711 dirs: cwd = destination, dest = '.'.
  assert.equal(rec.opts!.cwd, `${root}/accounts/4/staging/www`);
  assert.equal(rec.args!.at(-1), '.');
  assert.deepEqual(Object.keys(rec.opts!.env).sort(), ['OBLIMINT_TUNNEL', 'OBLIMINT_TUNNEL_TOKEN', 'PATH']);
  assert.equal(rec.opts!.env.OBLIMINT_TUNNEL_TOKEN.length, 64);
  assert.ok(rec.args!.includes('--safe-links'));
  // The tunnel directory is gone.
  assert.deepEqual(fs.readdirSync(`${root}/migration/tunnels`), []);
  assert.deepEqual(log.rows.map((r) => r.status), ['ok']);
});

test('rsyncPull: exit 24 = partial; other exit = SourceCommandError', async (t) => {
  const root = tmpRoot(t);
  const { port } = makePort(new MemoryCommandLogSink());
  const r24 = await runRsyncPull(port, req({ localPath: `${root}/accounts/4/staging/www` }), deps(root, fakeSpawn({}, { argv: goodArgv(), exitCode: 24 })));
  assert.equal(r24.partial, true);
  await assert.rejects(runRsyncPull(port, req({ localPath: `${root}/accounts/4/staging/www` }), deps(root, fakeSpawn({}, { argv: goodArgv(), exitCode: 23, stderr: 'rsync error: some files could not be transferred (code 23)\n' }))),
    (err: unknown) => err instanceof SourceCommandError && err.exitCode === 23 && /rsync exited with 23/.test(err.message));
});

test('rsyncPull: without --stats lines, files / bytes come from the tagged per-file lines', async (t) => {
  const root = tmpRoot(t);
  const { port } = makePort(new MemoryCommandLogSink());
  const res = await runRsyncPull(port, req({ localPath: `${root}/accounts/4/staging/www` }), deps(root, fakeSpawn({}, {
    argv: goodArgv(), exitCode: 24, stdout: 'oblimint:10:a.php\noblimint:4096:dir/\nfile has vanished: "x"\noblimint:5:b.css',
  })));
  assert.equal(res.files, 2);
  assert.equal(res.bytes, 15);
});

test('purgeStaleTunnels: removes every leftover entry, tolerates a missing root', async (t) => {
  const root = tmpRoot(t);
  const tunnels = `${root}/migration/tunnels`;
  assert.equal(await purgeStaleTunnels(tunnels), 0);
  fs.mkdirSync(`${tunnels}/aa/sub`, { recursive: true });
  fs.writeFileSync(`${tunnels}/aa/s`, '');
  fs.writeFileSync(`${tunnels}/stray`, '');
  assert.equal(await purgeStaleTunnels(tunnels), 2);
  assert.deepEqual(fs.readdirSync(tunnels), []);
});

test('rsyncPull: invalid server argv / bad token → refused, logged, nothing opened', async (t) => {
  const root = tmpRoot(t);
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ argv: [H, 'rsync', '--server', '-ltre.iLsfxC', '.', `${REMOTE}/`] }, /--sender/],
    [{ argv: [H, 'rsync', '--server', '--sender', '-ltre.iLsfxC', '--remove-source-files', '.', `${REMOTE}/`] }, /refused/],
    [{ argv: [H, 'rsync', '--server', '--sender', '-ltre.iLsfxC', '--delete', '.', `${REMOTE}/`] }, /refused/],
    [{ argv: [H, 'rsync', '--server', '--sender', '-ltre.iLsfxC', '--frobnicate', '.', `${REMOTE}/`] }, /not allowed/],
    [{ argv: goodArgv('/home/acct2/public_html') }, /path/],
    [{ argv: [H, 'rsync', '--server', '--sender', '-ltre.iLsfxC', '.', REMOTE] }, /path/],
    [{ argv: goodArgv(), token: 'f'.repeat(64) }, /token/],
  ];
  for (const [behaviour, re] of cases) {
    const log = new MemoryCommandLogSink();
    const { port, opened } = makePort(log);
    await assert.rejects(runRsyncPull(port, req({ localPath: `${root}/accounts/4/staging/www` }), deps(root, fakeSpawn({}, { ...behaviour, exitCode: 12 }))),
      (err: unknown) => err instanceof SourceCommandRefusedError && re.test(err.reason), JSON.stringify(behaviour));
    assert.equal(opened.length, 0);
    const refusedRows = log.rows.filter((r) => r.status === 'refused');
    assert.equal(refusedRows.length, 1);
    assert.equal(refusedRows[0].template, 'rsync.sender');
  }
});

test('rsyncPull: request refusals (uid 0, outside roots, local outside the data dir, .. excludes, MG10 symlink) are logged', async (t) => {
  const root = tmpRoot(t);
  const local = `${root}/accounts/4/staging/www`;
  const bad: Array<[Partial<RsyncPullRequest>, RegExp, { realpath?: string | null }?]> = [
    [{ uid: 0 }, /uid/], [{ gid: 0 }, /gid/], [{ remotePath: '/etc' }, /remotePath/], [{ remotePath: '/root/.ssh' }, /remotePath/],
    [{ localPath: '/etc/cron.d' }, /outside/], [{ excludes: ['../../etc'] }, /excludes/],
    [{ localPath: `${root}/accounts/4/staging/missing` }, /not an existing directory/],
    [{}, /symlinkPath/, { realpath: '/etc' }], [{}, /missing/, { realpath: null }],
  ];
  for (const [o, re, popts] of bad) {
    const log = new MemoryCommandLogSink();
    const { port, opened } = makePort(log, popts);
    let spawned = false;
    await assert.rejects(runRsyncPull(port, req({ localPath: local, ...o }), deps(root, () => { spawned = true; throw new Error('no'); })),
      (err: unknown) => err instanceof SourceCommandRefusedError && re.test(err.reason), JSON.stringify(o));
    assert.equal(spawned, false);
    assert.equal(opened.length, 0);
    assert.equal(log.rows.filter((r) => r.status === 'refused').length, 1);
  }
});

test('the real shim script: handshake + byte piping through a real socket / pipe', async (t) => {
  const token = 'a'.repeat(64);
  const sockPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\oblimint-shim-test-${process.pid}`
    : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oblimint-shim-')), 's');
  let seenArgv: unknown = null;
  let payload = '';
  const server = net.createServer({ allowHalfOpen: true }, (sock) => {
    sock.on('error', () => undefined);
    readHandshake(sock, token).then(({ argv }) => {
      seenArgv = argv;
      // Reply as soon as the payload is in (win32 named pipes have no half-close; unix sockets do).
      sock.on('data', (d) => { payload += d.toString(); if (payload === 'TO-REMOTE') sock.end('FROM-REMOTE'); });
      sock.resume();
    }, () => sock.destroy());
  });
  await new Promise<void>((r) => server.listen(sockPath, r));
  t.after(() => server.close());
  const [node, ...rest] = defaultShimCommand();
  const child = spawn(node, [...rest, H, 'rsync', '--server', '--sender', '-ltre.iLsfxCIvu', '.', `${REMOTE}/`], {
    env: { PATH: process.env.PATH ?? '', OBLIMINT_TUNNEL: sockPath, OBLIMINT_TUNNEL_TOKEN: token },
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });
  child.stdin.on('error', () => undefined);
  child.stdin.write('TO-REMOTE');
  const code = await new Promise<number | null>((r) => child.on('close', r));
  assert.equal(code, 0, err);
  assert.deepEqual(seenArgv, goodArgv());
  assert.equal(payload, 'TO-REMOTE');
  assert.equal(out, 'FROM-REMOTE');
});

test('openTunnel: one connection only, tunnel dir removed on close', async (t) => {
  const root = tmpRoot(t);
  const accepted: unknown[] = [];
  const rejected: string[] = [];
  const tunnel = await openTunnel({
    root: `${root}/migration/tunnels`, uid: 1004, gid: 1004, chown: false,
    onConnection: (argv, sock) => { accepted.push(argv); sock.end(); },
    onRejected: (r) => rejected.push(r),
  });
  assert.equal(fs.readdirSync(`${root}/migration/tunnels`).length, 1);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(tunnel.dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(tunnel.socketPath).mode & 0o777, 0o600);
  }
  const c1 = net.connect({ path: tunnel.socketPath });
  await new Promise((r) => c1.on('connect', r));
  c1.write(`${JSON.stringify({ token: tunnel.token, argv: ['x'] })}\n`);
  await new Promise((r) => c1.on('close', r));
  const c2 = net.connect({ path: tunnel.socketPath });
  const second = await new Promise<string>((r) => { c2.on('error', () => r('error')); c2.on('close', () => r('closed')); });
  assert.ok(second === 'error' || second === 'closed');
  assert.deepEqual(accepted, [['x']]);
  await tunnel.close();
  assert.deepEqual(fs.readdirSync(`${root}/migration/tunnels`), []);
});

test('dry-run deletion lines: receiver paths --delete would remove (maildir target-only protection)', () => {
  assert.equal(parseDeletionLine('*deleting   new/1700.M1P2.host,S=10:2,'), 'new/1700.M1P2.host,S=10:2,');
  assert.equal(parseDeletionLine('*deleting   cur/1600.x:2,S\r'), 'cur/1600.x:2,S');
  assert.equal(parseDeletionLine('*deleting   .Old/'), null, 'directories are not message files');
  assert.equal(parseDeletionLine('>f+++++++++ cur/new-one:2,'), null);
  assert.equal(parseDeletionLine('Number of deleted files: 2'), null);
});
