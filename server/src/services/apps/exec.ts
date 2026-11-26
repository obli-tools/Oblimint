import crypto from 'crypto';
import { StringDecoder } from 'string_decoder';
import { Writable, type Duplex } from 'stream';
import type Docker from 'dockerode';
import { KILL_WAIT_MS, killSweepArgv, runKillSweep, waitExecStopped } from '../cron/executor';

// ─────────────────────────────────────────────────────────────────────────────
// One command run in an application's container, NOT interactive (the
// commands of an access key: keyStacks.exec, scope apps.exec; the panel's
// console is the interactive TTY of socketHandlers.ts):
//   docker exec [-i] [-w <workdir>] -e … <container> <argv…>
// without a TTY, as the image's user (no User: the same user as the panel's
// console), stdout and stderr demultiplexed apart (docker-modem's real
// demuxStream), each kept up to its cap (+ a margin, so that a secret
// straddling the cap is masked whole before the cut). stdin, when given, is
// written on the hijacked connection, then half-closed (EOF to the command).
//
// Timeout: the image is anything (Alpine, Debian, distroless…), `timeout`
// may not exist and wrapping an argv in a shell would change it, so the
// panel keeps the time: every process of the run inherits
// OBLIMINT_EXEC_RUN=<random marker>; past the timeout the attached stream is
// destroyed, a kill sweep exec (the cron's, as the same image user: it reads
// /proc/<pid>/environ and SIGKILLs every process carrying the marker, the
// command's children included) runs, then the exec is awaited — bounded —
// until Docker reports it stopped (killed: true). An image without sh / tr /
// grep, or a process that cleared its environment or changed its user,
// escapes the sweep: killed false (« not confirmed »).
// ─────────────────────────────────────────────────────────────────────────────

/** Environment variable carrying the per-run marker (inherited by every process of the command). */
export const EXEC_MARKER_VAR = 'OBLIMINT_EXEC_RUN';
/** Bytes kept past the cap of a stream: a secret straddling the cap is masked whole before the cut. */
export const EXEC_MASK_MARGIN = 8 * 1024;
const MASK = '********';

/** Keeps the first `keep` bytes written, counts them all. */
export class ByteCollector extends Writable {
  private chunks: Buffer[] = [];
  private kept = 0;
  total = 0;

  constructor(private readonly keep: number) {
    super();
  }

  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.total += buf.length;
    const room = this.keep - this.kept;
    if (room > 0) {
      const part = buf.length > room ? buf.subarray(0, room) : buf;
      this.chunks.push(part);
      this.kept += part.length;
    }
    cb();
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** Every value of `secrets` replaced by ********, the longest first (a secret inside another one). */
export function maskValues(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const v of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    if (out.includes(v)) out = out.split(v).join(MASK);
  }
  return out;
}

/** The text cut before the start of a secret it ends with (the rest of that secret was dropped). */
export function trimPartialSecret(text: string, secrets: readonly string[]): string {
  let cut = text.length;
  for (const s of secrets) {
    for (let k = Math.min(s.length - 1, text.length); k > 0; k--) {
      if (text.endsWith(s.slice(0, k))) { cut = Math.min(cut, text.length - k); break; }
    }
  }
  return text.slice(0, cut);
}

/**
 * The text of a stream as a key reads it: UTF-8 (an incomplete last character dropped), the secrets masked, then
 * cut at `cap` bytes. `total` is what the stream sent; `bytes` what was kept of it (≤ cap + EXEC_MASK_MARGIN).
 */
export function execOutputText(bytes: Buffer, total: number, cap: number, secrets: readonly string[]): { text: string; truncated: boolean } {
  const dropped = total > bytes.length;
  const decoder = new StringDecoder('utf8');
  let text = decoder.write(bytes) + (dropped ? '' : decoder.end());
  text = maskValues(text, secrets);
  // Bytes were dropped: a secret may start at the very end of what was kept, never shown in part.
  if (dropped) text = trimPartialSecret(text, secrets);
  const buf = Buffer.from(text, 'utf8');
  if (buf.length > cap) return { text: new StringDecoder('utf8').write(buf.subarray(0, cap)), truncated: true };
  return { text, truncated: dropped };
}

export interface AppExecSpec {
  container: string;
  argv: string[];
  /** Written to the command's stdin, then EOF (null: no stdin attached). */
  stdin: Buffer | null;
  /** KEY=VALUE (the marker is added last). */
  env: string[];
  workdir: string | null;
  timeoutMs: number;
  /** Bytes returned of each stream (EXEC_MASK_MARGIN more are kept for the masking). */
  outputMax: number;
  /** Bound of the kill sweep, then of the wait for the exec to report it stopped. */
  killWaitMs?: number;
}

export interface AppExecRaw {
  exitCode: number | null;
  stdout: Buffer;
  stdoutTotal: number;
  stderr: Buffer;
  stderrTotal: number;
  durationMs: number;
  timedOut: boolean;
  /** timedOut only: the exec reported stopped after the kill sweep. */
  killed: boolean | null;
}

/** A fresh per-run marker (24 hex chars). */
export function newExecMarker(): string {
  return crypto.randomBytes(12).toString('hex');
}

/** argv of the kill sweep of one command (exported for tests). */
export function execKillArgv(marker: string): string[] {
  return killSweepArgv(marker, EXEC_MARKER_VAR, 'oblimint-exec-kill');
}

/**
 * Runs the command. Never throws for a command-side problem (non-zero exit, timeout): the outcome says it. Throws
 * only when Docker could not create / start the exec (container gone or stopped: statusCode 404 / 409).
 */
export async function runAppExec(docker: Docker, spec: AppExecSpec): Promise<AppExecRaw> {
  const marker = newExecMarker();
  const keep = spec.outputMax + EXEC_MASK_MARGIN;
  const out = new ByteCollector(keep);
  const err = new ByteCollector(keep);
  const withStdin = spec.stdin !== null;
  const started = Date.now();
  const exec = await docker.getContainer(spec.container).exec({
    Cmd: spec.argv,
    Env: [...spec.env, `${EXEC_MARKER_VAR}=${marker}`],
    ...(spec.workdir ? { WorkingDir: spec.workdir } : {}),
    AttachStdin: withStdin,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = (withStdin
    ? await exec.start({ hijack: true, stdin: true, Tty: false })
    : await exec.start({ Detach: false, Tty: false })) as unknown as Duplex;

  let timedOut = false;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { stream.destroy(); } catch { /* already closed */ }
      done();
    }, spec.timeoutMs);
    stream.on('end', done);
    stream.on('close', done);
    stream.on('error', done);
    docker.modem.demuxStream(stream, out, err);
    if (withStdin) {
      // The whole stdin, then a half-close: the command reads EOF, its output keeps coming.
      try {
        stream.write(spec.stdin as Buffer);
        stream.end();
      } catch { /* the command exited before reading it */ }
    }
  });

  let killed: boolean | null = null;
  if (timedOut) {
    const waitMs = spec.killWaitMs ?? KILL_WAIT_MS;
    await runKillSweep(docker, spec.container, undefined, execKillArgv(marker), waitMs).catch(() => false);
    killed = await waitExecStopped(exec, waitMs);
  }

  // ExitCode may still be null right after the stream closed: poll briefly.
  let exitCode: number | null = null;
  for (let i = 0; i < 20; i++) {
    try {
      const info = await exec.inspect();
      if (info.Running !== true && info.ExitCode !== null && info.ExitCode !== undefined) {
        exitCode = info.ExitCode;
        break;
      }
      if (timedOut && info.Running === true) break;
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    exitCode,
    stdout: out.bytes(), stdoutTotal: out.total,
    stderr: err.bytes(), stderrTotal: err.total,
    durationMs: Date.now() - started,
    timedOut,
    killed,
  };
}
