import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'stream';
import Docker from 'dockerode';
import { CRON_OUTPUT_CAP } from '@oblimint/shared';
import { MIN_INTERVAL_SAMPLE, ScheduleError, assertValidSchedule, minGapMinutes, nextOccurrences, nextRunAt, validateSchedule } from './schedule';
import { KILL_SWEEP_SCRIPT, RUN_MARKER_VAR, containerState, cronArgv, execCron, killSweepArgv, statusFromExit } from './executor';
import { failureStreak, summaryOf, toCronRun } from './cron.service';

// ─────────────────────────────────────────────────────────────────────────────
// Cron (docs/P2-PLAN.md §9.6, C1'): schedule validation, minimum interval,
// next run, exit code → status, output capping / interleaving, the exec
// request (uid:gid, workdir, argv, timeout) against a fake Docker exec.
// ─────────────────────────────────────────────────────────────────────────────

const FROM = new Date('2026-03-10T10:02:30.000Z'); // a Tuesday

test('schedule: accepted / refused expressions', () => {
  for (const ok of ['*/5 * * * *', '0 3 * * *', '15,45 8-18 * * 1-5', '0 0 1 * *', '@hourly', '@daily', '@weekly', '@monthly', '@DAILY', '  0   4 * * sun  ', '0 0 * jan *']) {
    assert.doesNotThrow(() => assertValidSchedule(ok), ok);
  }
  for (const bad of [
    '', '*', '* * * *', '0 */5 * * * *' /* seconds field */, '* * * * * *', '@reboot', '@yearly', '@annually', '@every 5m',
    '61 * * * *', '* 25 * * *', '* * 32 * *', 'a b c d e', '0 0 * * * ; rm -rf /', '$(id) * * * *', '* * * * 8',
  ]) {
    assert.throws(() => assertValidSchedule(bad), (e: unknown) => e instanceof ScheduleError && e.reason === 'invalid', bad);
  }
  assert.equal(assertValidSchedule('  0   4 * * sun  '), '0 4 * * sun');
  assert.equal(assertValidSchedule('@DAILY'), '@daily');
});

test('schedule: minimum interval of the plan (next occurrences)', () => {
  const table: Array<[string, number, boolean]> = [
    ['* * * * *', 1, true],
    ['* * * * *', 5, false],
    ['*/5 * * * *', 5, true],
    ['*/5 * * * *', 10, false],
    ['*/10 * * * *', 5, true],
    ['0,2 * * * *', 5, false],        // two runs 2 min apart, then 58 min
    ['0-4 3 * * *', 5, false],        // burst at 03:00…03:04
    ['0 * * * *', 60, true],
    ['@hourly', 61, false],
    ['@daily', 1440, true],
    ['0 3,4 * * *', 60, true],
    ['30 3,4 * * *', 61, false],
  ];
  for (const [expr, min, ok] of table) {
    if (ok) assert.doesNotThrow(() => validateSchedule(expr, min, FROM), `${expr} @ ${min}`);
    else assert.throws(() => validateSchedule(expr, min, FROM), (e: unknown) => e instanceof ScheduleError && e.reason === 'tooFrequent', `${expr} @ ${min}`);
  }
  assert.equal(minGapMinutes('*/15 * * * *', FROM), 15);
  assert.equal(nextOccurrences('*/15 * * * *', FROM, MIN_INTERVAL_SAMPLE).length, MIN_INTERVAL_SAMPLE);
  // A never-firing expression (30 February) is refused as invalid.
  assert.throws(() => validateSchedule('0 0 30 2 *', 5, FROM), (e: unknown) => e instanceof ScheduleError);
});

test('schedule: next run in UTC, strictly after the reference', () => {
  assert.equal(nextRunAt('*/5 * * * *', FROM)?.toISOString(), '2026-03-10T10:05:00.000Z');
  assert.equal(nextRunAt('0 3 * * *', FROM)?.toISOString(), '2026-03-11T03:00:00.000Z');
  assert.equal(nextRunAt('@hourly', FROM)?.toISOString(), '2026-03-10T11:00:00.000Z');
  assert.equal(nextRunAt('@weekly', FROM)?.toISOString(), '2026-03-15T00:00:00.000Z');
  assert.equal(nextRunAt('@monthly', FROM)?.toISOString(), '2026-04-01T00:00:00.000Z');
  assert.equal(nextRunAt('0 10 * * *', new Date('2026-03-10T10:00:00.000Z'))?.toISOString(), '2026-03-11T10:00:00.000Z');
  assert.equal(nextRunAt('not a cron', FROM), null);
});

test('exit code → status', () => {
  assert.equal(statusFromExit(0, 10, 300), 'success');
  assert.equal(statusFromExit(1, 10, 300), 'failed');
  assert.equal(statusFromExit(127, 10, 300), 'failed');
  assert.equal(statusFromExit(124, 10, 300), 'timeout');
  assert.equal(statusFromExit(137, 300_000, 300), 'timeout');   // killed by timeout -s KILL at the deadline
  assert.equal(statusFromExit(137, 2_000, 300), 'failed');      // killed early (OOM…)
  assert.equal(statusFromExit(null, 10, 300), 'failed');
  assert.equal(statusFromExit(-1, 10, 300), 'failed');
});

test('consecutive failure streak and run mapping', () => {
  assert.equal(failureStreak(['failed', 'timeout', 'failed', 'success']), 3);
  assert.equal(failureStreak(['success', 'failed', 'failed']), 0);
  assert.equal(failureStreak([]), 0);
  assert.equal(summaryOf('\n\n  hello world \nsecond'), 'hello world');
  assert.equal(summaryOf(''), null);
  assert.equal(summaryOf('x'.repeat(500))?.length, 200);
  const run = toCronRun({
    id: 1, job_id: 2, site_id: 3, status: 'success', trigger: 'manual', exit_code: 0, output: 'ok\n', output_truncated: false,
    started_at: '2026-03-10T10:00:00.000Z', finished_at: '2026-03-10T10:00:02.500Z',
  });
  assert.equal(run.durationMs, 2500);
  assert.equal(run.summary, 'ok');
  assert.equal(toCronRun({ ...{ id: 1, job_id: 2, site_id: 3, status: 'running', trigger: 'schedule', exit_code: null, output: null, output_truncated: false, started_at: new Date(), finished_at: null } }).durationMs, null);
});

// ── fake Docker exec ─────────────────────────────────────────────────────────

function frame(stream: 1 | 2, payload: string | Buffer): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const h = Buffer.alloc(8);
  h.writeUInt8(stream, 0);
  h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
}

interface FakeRun { frames?: Buffer[]; exitCode: number | null; hang?: boolean; delayMs?: number }

function fakeDocker(state: 'running' | 'exited' | 'missing', run: FakeRun) {
  const real = new Docker({ socketPath: '/nonexistent/docker.sock' });
  const created: Array<Record<string, unknown>> = [];
  const docker = {
    modem: { demuxStream: real.modem.demuxStream.bind(real.modem) },
    getContainer(name: string) {
      return {
        async inspect() {
          if (state === 'missing') throw Object.assign(new Error(`No such container: ${name}`), { statusCode: 404 });
          return { State: { Running: state === 'running' } };
        },
        async exec(opts: Record<string, unknown>) {
          created.push({ container: name, ...opts });
          return {
            async start() {
              const s = new PassThrough();
              if (!run.hang) {
                setTimeout(() => {
                  for (const f of run.frames ?? []) s.write(f);
                  s.end();
                }, run.delayMs ?? 0);
              }
              return s;
            },
            async inspect() { return { ExitCode: run.exitCode, Running: false }; },
          };
        },
      };
    },
  };
  return { docker: docker as unknown as Docker, created };
}

test('exec: argv, uid:gid, workdir; interleaved output; success', async () => {
  const { docker, created } = fakeDocker('running', {
    exitCode: 0,
    frames: [frame(1, 'one\n'), frame(2, 'err\n'), frame(1, 'two\n')],
  });
  const out = await execCron(docker, { container: 'oblimint-site-7', user: '20001:20001', command: 'php artisan schedule:run; echo "$HOME"', timeoutSec: 120 });
  assert.equal(out.status, 'success');
  assert.equal(out.exitCode, 0);
  assert.equal(out.output, 'one\nerr\ntwo\n');
  assert.equal(out.outputTruncated, false);
  assert.equal(created.length, 1);
  const c = created[0];
  assert.equal(c.container, 'oblimint-site-7');
  assert.equal(c.User, '20001:20001');
  assert.equal(c.WorkingDir, '/srv/releases/current');
  assert.equal(c.Tty, false);
  // The command is ONE argv element of the container's sh: never interpolated panel-side.
  assert.deepEqual(c.Cmd, ['timeout', '-s', 'KILL', '120', 'sh', '-c', 'php artisan schedule:run; echo "$HOME"']);
  assert.deepEqual(cronArgv('x', 10.7), ['timeout', '-s', 'KILL', '10', 'sh', '-c', 'x']);
});

test('exec: output capped at CRON_OUTPUT_CAP, failures and timeouts', async () => {
  const big = 'x'.repeat(40 * 1024);
  const { docker } = fakeDocker('running', { exitCode: 3, frames: [frame(1, big), frame(2, big), frame(1, big)] });
  const out = await execCron(docker, { container: 'c', user: '1:1', command: 'yes', timeoutSec: 60 });
  assert.equal(out.status, 'failed');
  assert.equal(out.exitCode, 3);
  assert.equal(out.outputTruncated, true);
  assert.ok(Buffer.byteLength(out.output) <= CRON_OUTPUT_CAP + 64, `output ${Buffer.byteLength(out.output)} bytes`);

  const t = fakeDocker('running', { exitCode: 124, frames: [frame(1, 'slow\n')] });
  const timedOut = await execCron(t.docker, { container: 'c', user: '1:1', command: 'sleep 999', timeoutSec: 10 });
  assert.equal(timedOut.status, 'timeout');
  assert.match(timedOut.output, /^slow\n/);
  assert.match(timedOut.output, /10 s/);
});

test('exec: panel-side safety timer when the stream never ends, then a kill sweep as the same uid', async () => {
  const { docker, created } = fakeDocker('running', { exitCode: null, hang: true });
  const started = Date.now();
  const out = await execCron(docker, { container: 'c', user: '1:1', command: 'sleep 999', timeoutSec: 0 }, { safetyMarginMs: 50, killWaitMs: 50 });
  assert.equal(out.status, 'timeout');
  assert.equal(out.exitCode, null);
  assert.match(out.output, /interrompue par le panel/);
  assert.ok(Date.now() - started < 2000);
  // The run carries a random marker; the sweep kills the processes holding it, as the job's uid.
  assert.equal(created.length, 2);
  const env = created[0].Env as string[];
  const markerEnv = env.find((e) => e.startsWith(`${RUN_MARKER_VAR}=`));
  assert.match(markerEnv ?? '', /^OBLIMINT_CRON_RUN=[0-9a-f]{24}$/);
  const marker = markerEnv!.split('=')[1];
  assert.equal(created[1].User, '1:1');
  assert.deepEqual(created[1].Cmd, killSweepArgv(marker));
  assert.equal((created[1].Cmd as string[])[2], KILL_SWEEP_SCRIPT);
  assert.ok(!KILL_SWEEP_SCRIPT.includes(marker), 'the marker is an argv element, not part of the script');
  // A normal run never sweeps.
  const ok = fakeDocker('running', { exitCode: 0, frames: [frame(1, 'x\n')] });
  await execCron(ok.docker, { container: 'c', user: '1:1', command: 'true', timeoutSec: 10 });
  assert.equal(ok.created.length, 1);
});

test('container state: running / stopped / missing / Docker down', async () => {
  assert.equal(await containerState(fakeDocker('running', { exitCode: 0 }).docker, 'c'), 'running');
  assert.equal(await containerState(fakeDocker('exited', { exitCode: 0 }).docker, 'c'), 'stopped');
  assert.equal(await containerState(fakeDocker('missing', { exitCode: 0 }).docker, 'c'), 'missing');
  const down = { getContainer: () => ({ inspect: async () => { throw Object.assign(new Error('connect ENOENT /var/run/docker.sock'), { code: 'ENOENT' }); } }) };
  await assert.rejects(containerState(down as unknown as Docker, 'c'), /ENOENT/);
});
