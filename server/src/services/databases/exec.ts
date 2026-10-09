import type { Readable, Writable } from 'stream';
import type Docker from 'dockerode';
import { CappedCollector, EXEC_OUTPUT_CAP } from '../docker/engine';
import { errText } from '../setup/docker';

// ─────────────────────────────────────────────────────────────────────────────
// docker exec for the database clients (module databases). Unlike
// engine.execWith it carries an ENVIRONMENT (passwords: MYSQL_PWD /
// PGPASSWORD — never on the command line, D2/B2) and can stream:
//   - stdin  : SQL statements or a dump to restore (hijacked exec stream,
//              half-closed at the end so the client sees EOF);
//   - stdout : a dump, piped to the HTTP response (never buffered on disk).
// Without a stdout sink, stdout and stderr are collected (64 KiB caps).
//
// Test seam: setDbExecForTests() replaces the whole function (the fake
// Docker of services/docker/testing cannot model a hijacked stream).
// ─────────────────────────────────────────────────────────────────────────────

export interface DbExecOptions {
  /** KEY=value entries added to the exec environment. */
  env?: string[];
  /** Fed to the process stdin, then EOF. A string is sent as UTF-8. */
  stdin?: string | Readable | null;
  /** Receives stdout instead of the collector (stdout of the result is then ''). */
  stdout?: Writable | null;
  timeoutMs?: number;
  /** Abort (client gone): rejects and closes the stream. */
  signal?: AbortSignal;
}

export interface DbExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type DbExecFn = (docker: Docker, container: string, cmd: string[], opts?: DbExecOptions) => Promise<DbExecResult>;

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Splits Docker's multiplexed stream (8-byte header: type, 3 × 0, size BE)
 * into stdout / stderr, PAUSING the source while stdout is saturated
 * (docker-modem's demuxStream ignores backpressure: a multi-GB dump to a
 * slow client would pile up in memory). Frames of another type are dropped.
 */
export function demuxWithBackpressure(source: Readable, stdout: Writable, stderr: Writable): void {
  let pending: Buffer = Buffer.alloc(0);
  let waiting = false;
  source.on('data', (chunk: Buffer | string) => {
    const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    pending = pending.length ? Buffer.concat([pending, c]) : c;
    while (pending.length >= 8) {
      const type = pending[0];
      const size = pending.readUInt32BE(4);
      if (pending.length < 8 + size) break;
      const payload = pending.subarray(8, 8 + size);
      pending = pending.subarray(8 + size);
      if (type === 2) {
        stderr.write(payload);
      } else if (type === 1 && !stdout.write(payload) && !waiting) {
        waiting = true;
        source.pause();
        stdout.once('drain', () => { waiting = false; source.resume(); });
      }
    }
  });
}

async function realDbExec(docker: Docker, container: string, cmd: string[], opts: DbExecOptions = {}): Promise<DbExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const withStdin = opts.stdin !== undefined && opts.stdin !== null;
  const stdoutSink: Writable = opts.stdout ?? new CappedCollector(EXEC_OUTPUT_CAP);
  const stderr = new CappedCollector(EXEC_OUTPUT_CAP);
  let stream: (NodeJS.ReadWriteStream & { destroy?: (err?: Error) => void }) | null = null;
  let timer: NodeJS.Timeout | null = null;
  let onAbort: (() => void) | null = null;

  const run = async (): Promise<DbExecResult> => {
    const exec = await docker.getContainer(container).exec({
      Cmd: cmd,
      Env: opts.env ?? [],
      AttachStdin: withStdin,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    type ExecStream = NodeJS.ReadWriteStream & { destroy?: (err?: Error) => void };
    const s = await exec.start(withStdin ? { hijack: true, stdin: true, Detach: false, Tty: false } : { Detach: false, Tty: false }) as unknown as ExecStream;
    stream = s;
    const ended = new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: unknown) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve();
      };
      s.on('end', () => done());
      s.on('close', () => done());
      s.on('error', (err) => done(err));
    });
    demuxWithBackpressure(s as unknown as Readable, stdoutSink, stderr);
    if (withStdin) {
      const input = opts.stdin!;
      if (typeof input === 'string') {
        s.end(Buffer.from(input, 'utf8'));
      } else {
        input.on('error', (err) => s.destroy?.(err));
        // end: true → half-close of the hijacked socket = EOF on the process stdin.
        input.pipe(s as unknown as Writable, { end: true });
      }
    }
    await ended;
    const info = await exec.inspect();
    let exitCode = info.ExitCode;
    for (let i = 0; (exitCode === null || exitCode === undefined) && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 50));
      exitCode = (await exec.inspect()).ExitCode;
    }
    return {
      exitCode: exitCode ?? -1,
      stdout: stdoutSink instanceof CappedCollector ? stdoutSink.text() : '',
      stderr: stderr.text(),
    };
  };

  try {
    return await new Promise<DbExecResult>((resolve, reject) => {
      const abort = (why: string) => {
        try { stream?.destroy?.(); } catch { /* already closed */ }
        reject(new Error(`exec ${cmd[0] ?? ''} in ${container}: ${why}`));
      };
      if (timeoutMs > 0) timer = setTimeout(() => abort(`timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
      if (opts.signal) {
        if (opts.signal.aborted) { abort('aborted'); return; }
        onAbort = () => abort('aborted');
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      run().then(resolve, (err) => reject(new Error(`exec ${cmd[0] ?? ''} in ${container}: ${errText(err)}`)));
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort && opts.signal) opts.signal.removeEventListener('abort', onAbort);
  }
}

let override: DbExecFn | null = null;

/** docker exec with env / stdin / stdout streaming (see the file header). */
export const dbExec: DbExecFn = (docker, container, cmd, opts) => (override ?? realDbExec)(docker, container, cmd, opts);

/** Test seam (null restores the real exec). */
export function setDbExecForTests(fn: DbExecFn | null): void {
  override = fn;
}
