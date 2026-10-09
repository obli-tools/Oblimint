import crypto from 'crypto';
import type Docker from 'dockerode';
import { CRON_OUTPUT_CAP, type CronRunStatus } from '@oblimint/shared';
import { CappedCollector } from '../docker/engine';
import { CONTAINER_PATHS } from '../hosting/paths';

// ─────────────────────────────────────────────────────────────────────────────
// One cron execution in the site's PRIMARY container (docs/P2-PLAN.md §9.6,
// invariant C1'):
//   docker exec --user <uid>:<gid> --workdir /srv/releases/current
//     timeout -s KILL <timeoutSec> sh -c <command>
// The command is ONLY interpreted by the container's sh (argv element, never
// interpolated in a panel-side shell). `timeout` is BusyBox's applet (the
// site images are Alpine: php:*-fpm-alpine, nginx:*-alpine). A panel-side
// safety timer (timeoutSec + 15 s) destroys the attached stream if the
// container-side timeout does not fire (exec stuck, Docker hung); the run's
// processes (marked by OBLIMINT_CRON_RUN=<random> in their environment) are
// then SIGKILLed by a sweep exec as the same uid, and the exec is awaited
// (bounded) until it reports stopped, so the next run does not overlap it.
// stdout + stderr are demultiplexed into ONE collector (interleaved, in
// arrival order), capped at CRON_OUTPUT_CAP.
//
// Not engine.execWith: it has no WorkingDir and keeps the two streams apart.
// ─────────────────────────────────────────────────────────────────────────────

/** Margin of the panel-side safety timer over the container-side timeout. */
export const SAFETY_MARGIN_MS = 15_000;

export interface CronExecRequest {
  container: string;
  /** "uid:gid" of the account. */
  user: string;
  command: string;
  timeoutSec: number;
  /**
   * OBLIMINT_CRON_RUN of the run (newRunMarker), persisted with the run
   * (cron_runs.run_marker) so that a later process can kill it
   * (sweepInterruptedRun). Random when absent.
   */
  marker?: string;
}

/** A fresh per-run marker (24 hex chars). */
export function newRunMarker(): string {
  return crypto.randomBytes(12).toString('hex');
}

const MARKER_RE = /^[0-9a-f]{16,64}$/;

export interface CronExecOutcome {
  status: Exclude<CronRunStatus, 'running'>;
  exitCode: number | null;
  output: string;
  outputTruncated: boolean;
}

/** The argv run in the container (exported for tests / documentation). */
export function cronArgv(command: string, timeoutSec: number): string[] {
  return ['timeout', '-s', 'KILL', String(Math.floor(timeoutSec)), 'sh', '-c', command];
}

/**
 * Status of a finished exec. 0 → success; 124 (coreutils timeout) → timeout;
 * 137 (SIGKILL: BusyBox timeout -s KILL) → timeout when the run lasted about
 * the configured delay, otherwise failed (killed by something else, e.g. the
 * OOM killer); anything else (or unknown) → failed.
 */
export function statusFromExit(exitCode: number | null, elapsedMs: number, timeoutSec: number): Exclude<CronRunStatus, 'running' | 'skipped'> {
  if (exitCode === 0) return 'success';
  if (exitCode === 124) return 'timeout';
  if (exitCode === 137) return elapsedMs >= timeoutSec * 1000 - 1500 ? 'timeout' : 'failed';
  return 'failed';
}

/** Environment variable carrying the per-run marker (inherited by every process of the run). */
export const RUN_MARKER_VAR = 'OBLIMINT_CRON_RUN';
/** Bound of the kill sweep, then of the wait for the exec to report it stopped (safety-timer path). */
export const KILL_WAIT_MS = 10_000;

/**
 * Kill sweep run after the safety timer (the container-side `timeout` did
 * not fire): SIGKILL to every process of the container whose environment
 * holds the run's marker. Runs as the SAME uid:gid as the job (it can only
 * read /proc/<pid>/environ of, and signal, that account's processes). The
 * marker is $1 (argv), never interpolated in the script. BusyBox sh/tr/grep.
 */
export const KILL_SWEEP_SCRIPT = [
  'for d in /proc/[0-9]*; do',
  '  if tr "\\000" "\\n" < "$d/environ" 2>/dev/null | grep -qxF "' + RUN_MARKER_VAR + '=$1"; then',
  '    kill -9 "${d#/proc/}" 2>/dev/null',
  '  fi',
  'done',
  'exit 0',
].join('\n');

/** argv of the kill sweep (exported for tests). */
export function killSweepArgv(marker: string): string[] {
  return ['sh', '-c', KILL_SWEEP_SCRIPT, 'oblimint-cron-kill', marker];
}

/**
 * Boot recovery (C1'): kills what is left of a run started by a PREVIOUS
 * panel process (its exec outlives the process: closing the attach stream
 * does not kill it). 'none' when nothing can run any more (container
 * missing / stopped), 'killed' when the sweep completed, 'unknown' when it
 * could not be confirmed (Docker unreachable, sweep stuck, no marker).
 */
export async function sweepInterruptedRun(
  docker: Docker, target: { container: string; user: string; marker: string | null }, waitMs = KILL_WAIT_MS,
): Promise<'none' | 'killed' | 'unknown'> {
  try {
    const state = await containerState(docker, target.container);
    if (state !== 'running') return 'none';
    if (!target.marker || !MARKER_RE.test(target.marker)) return 'unknown';
    const req: CronExecRequest = { container: target.container, user: target.user, command: '', timeoutSec: 0 };
    return (await killRun(docker, req, target.marker, waitMs)) ? 'killed' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Runs the kill sweep; true when it completed within `waitMs`. */
async function killRun(docker: Docker, req: CronExecRequest, marker: string, waitMs: number): Promise<boolean> {
  const exec = await docker.getContainer(req.container).exec({
    Cmd: killSweepArgv(marker),
    User: req.user,
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await exec.start({ Detach: false, Tty: false }) as unknown as NodeJS.ReadableStream & { destroy?: () => void; resume?: () => void };
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) { try { stream.destroy?.(); } catch { /* already closed */ } }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), waitMs);
    stream.on('end', () => finish(true));
    stream.on('close', () => finish(true));
    stream.on('error', () => finish(false));
    stream.resume?.();
  });
}

/** Polls the run's exec until it reports Running=false (bounded by `waitMs`). */
async function waitExecStopped(exec: Docker.Exec, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const info = await exec.inspect();
      if (info.Running !== true) return true;
    } catch {
      return false;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, Math.min(250, Math.max(10, waitMs / 10))));
  }
}

/** Is the container there and running? 'missing' | 'stopped' | 'running'. */
export async function containerState(docker: Docker, name: string): Promise<'missing' | 'stopped' | 'running'> {
  try {
    const info = await docker.getContainer(name).inspect();
    return info?.State?.Running ? 'running' : 'stopped';
  } catch (err) {
    if ((err as { statusCode?: number })?.statusCode === 404) return 'missing';
    throw err;
  }
}

/**
 * Runs the job. Never throws for a job-side problem (non-zero exit, timeout):
 * the outcome says it. Throws only when the exec could not be created /
 * started at all (the caller records the run as failed with the reason).
 */
export async function execCron(
  docker: Docker, req: CronExecRequest, opts: { safetyMarginMs?: number; killWaitMs?: number } = {},
): Promise<CronExecOutcome> {
  const collector = new CappedCollector(CRON_OUTPUT_CAP);
  const started = Date.now();
  const marker = req.marker && MARKER_RE.test(req.marker) ? req.marker : newRunMarker();
  const exec = await docker.getContainer(req.container).exec({
    Cmd: cronArgv(req.command, req.timeoutSec),
    User: req.user,
    WorkingDir: `${CONTAINER_PATHS.releases}/current`,
    Env: ['OBLIMINT_CRON=1', `${RUN_MARKER_VAR}=${marker}`],
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await exec.start({ Detach: false, Tty: false }) as unknown as NodeJS.ReadableStream & { destroy?: () => void };

  const safetyMs = req.timeoutSec * 1000 + (opts.safetyMarginMs ?? SAFETY_MARGIN_MS);
  let safetyFired = false;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      safetyFired = true;
      try { stream.destroy?.(); } catch { /* already closed */ }
      done();
    }, safetyMs);
    stream.on('end', done);
    stream.on('close', done);
    stream.on('error', done);
    docker.modem.demuxStream(stream, collector, collector);
  });

  const elapsed = Date.now() - started;
  if (safetyFired) {
    // The container-side `timeout` did not fire: the job's processes may still run. Kill
    // them (marker sweep), then wait — bounded — for the exec to report it stopped, so
    // that the next run (claimed once this one is finalized) does not overlap it (C1').
    const waitMs = opts.killWaitMs ?? KILL_WAIT_MS;
    await killRun(docker, req, marker, waitMs).catch(() => false);
    const stopped = await waitExecStopped(exec, waitMs);
    const note = stopped
      ? '[oblimint] délai dépassé : exécution interrompue par le panel'
      : '[oblimint] délai dépassé : exécution interrompue par le panel (arrêt du processus non confirmé)';
    return {
      status: 'timeout',
      exitCode: null,
      output: `${collector.text()}\n${note}`.replace(/^\n/, ''),
      outputTruncated: collector.truncated,
    };
  }

  // ExitCode may still be null right after the stream closed: poll briefly.
  let exitCode: number | null = null;
  for (let i = 0; i < 20; i++) {
    try {
      const info = await exec.inspect();
      if (info.ExitCode !== null && info.ExitCode !== undefined && info.Running !== true) {
        exitCode = info.ExitCode;
        break;
      }
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const status = statusFromExit(exitCode, elapsed, req.timeoutSec);
  let output = collector.text();
  if (status === 'timeout') output = `${output}\n[oblimint] délai de ${req.timeoutSec} s dépassé : processus tué`.replace(/^\n/, '');
  return { status, exitCode, output, outputTruncated: collector.truncated };
}
