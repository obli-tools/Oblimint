import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocker } from '../docker/testing/fakeDocker';
import { EXEC_MARKER_VAR, EXEC_MASK_MARGIN, ByteCollector, execKillArgv, execOutputText, maskValues, runAppExec, trimPartialSecret } from './exec';
import { execCommandText, execInput } from '../apiKeys/keyStacks';
import { APP_EXEC_STDIN_MAX, APP_EXEC_TIMEOUT_DEFAULT } from '@oblimint/shared';

// ─────────────────────────────────────────────────────────────────────────────
// A command of an access key in an application's container (apps/exec.ts,
// keyStacks.execInput / execCommandText), without a database: stdout and
// stderr demultiplexed apart (docker-modem's real demuxStream on the fake),
// the caps and the truncated flags, the masking of the .env secrets (a secret
// straddling the cap included), stdin on the hijacked stream then EOF, the
// timeout (stream destroyed, kill sweep of the marker, exec awaited stopped),
// the checks of the arguments and the audited text of the command.
// ─────────────────────────────────────────────────────────────────────────────

const spec = (over: Partial<Parameters<typeof runAppExec>[1]> = {}) => ({
  container: 'oblimint-app-7-web', argv: ['sh', '-c', 'echo hi'], stdin: null, env: [], workdir: null, timeoutMs: 5_000, outputMax: 64, ...over,
});

test('stdout and stderr apart, the exit code, the marker and the options of the exec', async () => {
  const d = new FakeDocker();
  d.addContainer({ name: 'oblimint-app-7-web' });
  d.execResults.set('oblimint-app-7-web', { exitCode: 3, stdout: 'out line\n', stderr: 'err line\n' });
  const r = await runAppExec(d.asDocker(), spec({ env: ['A=1'], workdir: '/srv/app' }));
  assert.equal(r.stdout.toString(), 'out line\n');
  assert.equal(r.stderr.toString(), 'err line\n');
  assert.equal(r.exitCode, 3);
  assert.deepEqual([r.timedOut, r.killed], [false, null]);
  const opts = d.execRuns[0].opts;
  assert.deepEqual(opts.Cmd, ['sh', '-c', 'echo hi']);
  assert.equal(opts.Tty, false);
  assert.equal(opts.AttachStdin, false);
  assert.equal(opts.User, undefined, 'the image\'s user, as the console');
  assert.equal(opts.WorkingDir, '/srv/app');
  assert.equal(opts.Env?.[0], 'A=1');
  assert.match(String(opts.Env?.[1]), new RegExp(`^${EXEC_MARKER_VAR}=[0-9a-f]{24}$`), 'the marker last: the caller cannot override it');
});

test('stdin is written on the hijacked stream, then EOF', async () => {
  const d = new FakeDocker();
  d.addContainer({ name: 'oblimint-app-7-web' });
  d.execResults.set('oblimint-app-7-web', { exitCode: 0, echoStdin: true });
  const r = await runAppExec(d.asDocker(), spec({ argv: ['cat'], stdin: Buffer.from('admin@example.com\nS3cret-pass\n') }));
  assert.equal(d.execRuns[0].opts.AttachStdin, true);
  assert.equal(d.execRuns[0].stdin.toString(), 'admin@example.com\nS3cret-pass\n');
  assert.equal(r.stdout.toString(), 'admin@example.com\nS3cret-pass\n');
});

test('the caps: a collector keeps cap + margin and counts everything; the text is cut at the cap with truncated', () => {
  const c = new ByteCollector(10);
  c.write(Buffer.from('0123456789abcdef'));
  assert.equal(c.bytes().toString(), '0123456789');
  assert.equal(c.total, 16);
  const full = execOutputText(Buffer.from('short'), 5, 64, []);
  assert.deepEqual(full, { text: 'short', truncated: false });
  const big = Buffer.from('x'.repeat(100));
  const cut = execOutputText(big, 100, 64, []);
  assert.equal(cut.text.length, 64);
  assert.equal(cut.truncated, true);
  // UTF-8: never half a character at the cut.
  const e = execOutputText(Buffer.from('é'.repeat(40)), 80, 63, []);
  assert.equal(e.text, 'é'.repeat(31));
  assert.equal(e.truncated, true);
});

test('masking: the .env secrets masked (the longest first), a secret straddling the cap never shown in part', () => {
  assert.equal(maskValues('token=abcd1234 and abcd1234-more', ['abcd1234', 'abcd1234-more']), 'token=******** and ********');
  assert.equal(trimPartialSecret('hello wor', ['world-secret']), 'hello ');
  assert.equal(trimPartialSecret('hello', ['world-secret']), 'hello');
  const secret = 'Sup3r-Secret-Value';
  // Whole output under the cap: masked.
  assert.equal(execOutputText(Buffer.from(`pw=${secret}\n`), 22, 64, [secret]).text, 'pw=********\n');
  // The secret straddles the cap: masked whole before the cut (the margin holds its end).
  const before = 'a'.repeat(60);
  const t = execOutputText(Buffer.from(`${before}${secret}tail`), before.length + secret.length + 4, 64, [secret]);
  assert.ok(!t.text.includes('Sup3r'), t.text);
  assert.equal(t.truncated, true);
  // Bytes dropped past cap + margin, the kept part ending on the start of a secret: that start is dropped too.
  const kept = Buffer.from(`${'b'.repeat(10)}Sup3r-Se`);
  const p = execOutputText(kept, kept.length + 1000, 64, [secret]);
  assert.equal(p.text, 'b'.repeat(10));
  assert.equal(p.truncated, true);
});

test('runAppExec keeps cap + margin of each stream and counts the rest', async () => {
  const d = new FakeDocker();
  d.addContainer({ name: 'oblimint-app-7-web' });
  d.execResults.set('oblimint-app-7-web', { exitCode: 0, stdout: 'y'.repeat(64 + EXEC_MASK_MARGIN + 500), stderr: 'e' });
  const r = await runAppExec(d.asDocker(), spec());
  assert.equal(r.stdout.length, 64 + EXEC_MASK_MARGIN);
  assert.equal(r.stdoutTotal, 64 + EXEC_MASK_MARGIN + 500);
  assert.equal(r.stderrTotal, 1);
  const out = execOutputText(r.stdout, r.stdoutTotal, 64, []);
  assert.deepEqual([out.text.length, out.truncated], [64, true]);
});

test('timeout: the stream destroyed, the processes of the marker killed by a sweep, the exec awaited stopped', async () => {
  const d = new FakeDocker();
  d.addContainer({ name: 'oblimint-app-7-web' });
  const sweeps: string[][] = [];
  d.execHandler = (_c, opts) => {
    const cmd = opts.Cmd ?? [];
    if (cmd[3] === 'oblimint-exec-kill') {
      sweeps.push(cmd);
      d.killExecsWithMarker(cmd[4]);
      return { exitCode: 0 };
    }
    return { exitCode: 0, hangUntilKilled: true };
  };
  const started = Date.now();
  const r = await runAppExec(d.asDocker(), spec({ argv: ['sleep', '1000'], timeoutMs: 150, killWaitMs: 2_000 }));
  assert.ok(Date.now() - started < 3_000);
  assert.equal(r.timedOut, true);
  assert.equal(r.killed, true, 'confirmed stopped');
  assert.equal(r.exitCode, 137);
  const marker = String(d.execRuns[0].opts.Env?.find((e) => e.startsWith(`${EXEC_MARKER_VAR}=`))).split('=')[1];
  assert.deepEqual(sweeps, [execKillArgv(marker)]);
  assert.equal(sweeps[0][4], marker, 'the marker is an argv element, never in the script');
  assert.ok(!sweeps[0][2].includes(marker));
  assert.match(sweeps[0][2], new RegExp(`${EXEC_MARKER_VAR}=\\$1`));
  assert.equal(d.execRuns[1].opts.User, undefined, 'the sweep runs as the same image user');
});

test('timeout: a sweep that cannot kill (no sh in the image…) is reported, never hidden', async () => {
  const d = new FakeDocker();
  d.addContainer({ name: 'oblimint-app-7-web' });
  d.execHandler = (_c, opts) => ((opts.Cmd ?? [])[3] === 'oblimint-exec-kill' ? { exitCode: 127, stderr: 'sh: not found' } : { exitCode: 0, hangUntilKilled: true });
  const r = await runAppExec(d.asDocker(), spec({ argv: ['sleep', '1000'], timeoutMs: 100, killWaitMs: 200 }));
  assert.deepEqual([r.timedOut, r.killed, r.exitCode], [true, false, null]);
});

test('a container that is not running: Docker\'s 409 is thrown (keyStacks: containerNotRunning)', async () => {
  const d = new FakeDocker();
  d.addContainer({ name: 'oblimint-app-7-web', state: 'exited' });
  await assert.rejects(runAppExec(d.asDocker(), spec()), (e: { statusCode?: number }) => e.statusCode === 409);
});

test('execInput: argv or sh -c, stdin bounded in bytes, env names, workdir, timeout', () => {
  assert.deepEqual(execInput({ command: 'php artisan migrate' }).argv, ['sh', '-c', 'php artisan migrate']);
  assert.equal(execInput({ command: 'x' }).shell, true);
  assert.deepEqual(execInput({ command: ['php', 'artisan'] }).argv, ['php', 'artisan']);
  assert.equal(execInput({ command: ['id'] }).timeoutSeconds, APP_EXEC_TIMEOUT_DEFAULT);
  const bad = (body: Parameters<typeof execInput>[0], field: string) => assert.throws(() => execInput(body),
    (e: { statusCode: number; code: string; details: { field: string } }) => e.statusCode === 400 && e.code === 'validation' && e.details.field === field, field);
  bad({ command: '  ' }, 'command');
  bad({ command: [] }, 'command');
  bad({ command: [''] }, 'command');
  bad({ command: ['a\u0000b'] }, 'command');
  bad({ command: ['id'], stdin: 'é'.repeat(APP_EXEC_STDIN_MAX / 2 + 1) }, 'stdin');
  bad({ command: ['id'], env: { 'BAD-NAME': 'x' } }, 'env');
  bad({ command: ['id'], env: { OBLIMINT_EXEC_RUN: 'x' } }, 'env');
  bad({ command: ['id'], workdir: 'relative/path' }, 'workdir');
  bad({ command: ['id'], timeoutSeconds: 0 }, 'timeoutSeconds');
  bad({ command: ['id'], timeoutSeconds: 301 }, 'timeoutSeconds');
  assert.equal(execInput({ command: ['id'], stdin: 'x' }).stdin?.toString(), 'x');
});

test('execCommandText: the .env secrets and the command\'s own env values masked, the argv quoted, 1000 characters at most', () => {
  const input = execInput({ command: ['create-admin', '--password', 'Sup3r-Secret', 'it\'s'], env: { ADMIN_PW: 'Env-Value-9' } });
  assert.equal(execCommandText(input, ['Sup3r-Secret']), 'create-admin --password ******** \'it\'\\\'\'s\'');
  const sh = execInput({ command: 'echo Env-Value-9 Sup3r-Secret', env: { ADMIN_PW: 'Env-Value-9' } });
  assert.equal(execCommandText(sh, ['Sup3r-Secret']), 'echo ******** ********');
  const long = execCommandText(execInput({ command: 'x'.repeat(5000) }), []);
  assert.equal(long.length, 1000);
  assert.ok(long.endsWith('…'));
});
