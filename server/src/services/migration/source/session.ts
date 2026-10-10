import type { Writable } from 'stream';
import type { MigrationCommandPhase } from '@oblimint/shared';
import {
  SourceCommandError, SourceCommandRefusedError, SourceConnectionError,
  type CommandResult, type CommandTemplateArgs, type CommandTemplateId, type RsyncPullRequest, type RsyncPullResult,
  type RunOptions, type SessionContext, type SourceSession, type StreamOptions, type StreamTemplateId,
} from '../contracts/source';
import { capCommand, commandLogSink, type CommandLogSink } from './commandLog';
import { PathPolicyError, checkReadPath } from './pathPolicy';
import type { ExecHandle, SshConnection } from './ssh';
import {
  CAT_MANY_MARKER, DEFAULT_MAX_BYTES_PER_FILE, MAX_MAX_BYTES_PER_FILE, MAX_PATHS_PER_CALL, STREAM_TEMPLATES, SYMLINK_EXIT,
  renderCommand, type TemplateSpec,
} from './templates';
import { runRsyncPull, type RsyncSessionPort } from './rsync';

// ─────────────────────────────────────────────────────────────────────────────
// SourceSession implementation (docs/P5-PLAN.md §5, contracts/source.ts).
//
// Every call: closed template → phase rule → validation + rendering
// (templates.ts) → exec channel (≤ 4 concurrent per session, no PTY) with a
// timeout, an output cap and abort → ONE command-log row (refusals included)
// → typed outcome. The output of a template is returned to the caller and
// NEVER logged / stored here; errors of sensitive templates are generic.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_MAX_STDOUT = 16 * 1024 * 1024;
export const MAX_STDERR = 64 * 1024;
export const READ_FILES_BATCH_BYTES = 4 * 1024 * 1024;
export const MAX_CONCURRENT_CHANNELS = 4;
const HEADER_OVERHEAD = 1100;

/** FIFO semaphore (exec channels per session). */
export class ChannelLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
  get inUse(): number { return this.active; }
}

export interface SessionDeps {
  sourceId: number;
  useSudo: boolean;
  conn: SshConnection;
  ctx: SessionContext;
  log?: CommandLogSink;
  /** Overrides for tests (rsync binary, data root, spawn…). */
  rsync?: Partial<import('./rsync').RsyncDeps>;
}

interface ExecOptions {
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  /** Streams stdout there instead of buffering. */
  sink?: Writable;
  onBytes?: (bytes: number) => void;
}

interface ExecOutcome {
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
  truncated: boolean;
  bytesOut: number;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
}

/** Parses fs.catMany framing (§5.4 bis), mapping BY ORDER. Malformed / truncated tail → null. Binary-safe. */
export function parseCatManyFrames(buf: Buffer, count: number, maxBytesPerFile: number): Array<Buffer | null> {
  const out: Array<Buffer | null> = [];
  let pos = 0;
  const marker = Buffer.from(`${CAT_MANY_MARKER} `);
  for (let i = 0; i < count; i++) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0 || !buf.subarray(pos, pos + marker.length).equals(marker)) break;
    const header = buf.subarray(pos + marker.length, nl).toString('utf8');
    const m = /^(-1|\d+) /.exec(header);
    if (!m) break;
    const size = Number(m[1]);
    if (size < 0) {
      if (buf[nl + 1] !== 0x0a) break;
      out.push(null);
      pos = nl + 2;
      continue;
    }
    const n = Math.min(size, maxBytesPerFile);
    const start = nl + 1;
    // min(size, max) raw bytes then the closing '\n' (a truncated output leaves the tail null).
    if (start + n >= buf.length || buf[start + n] !== 0x0a) break;
    out.push(Buffer.from(buf.subarray(start, start + n)));
    pos = start + n + 1;
  }
  while (out.length < count) out.push(null);
  return out;
}

function firstLine(s: string): string {
  const l = s.split('\n').find((x) => x.trim()) ?? '';
  return l.trim().slice(0, 200);
}

function safeTemplateName(t: unknown): string {
  const s = typeof t === 'string' ? t : String(t);
  return s.replace(/[^A-Za-z0-9._-]/g, '?').slice(0, 64) || '?';
}

export class SourceSessionImpl implements SourceSession {
  readonly sourceId: number;
  readonly phase: MigrationCommandPhase;
  private readonly limiter = new ChannelLimiter(MAX_CONCURRENT_CHANNELS);
  private readonly active = new Set<ExecHandle>();
  private closed = false;
  private readonly onSessionAbort = () => { void this.close(); };

  constructor(private readonly deps: SessionDeps) {
    this.sourceId = deps.sourceId;
    this.phase = deps.ctx.phase;
    deps.ctx.signal?.addEventListener('abort', this.onSessionAbort, { once: true });
  }

  /** The session is usable: not closed, SSH connection still up (keepalive / sshd restart / NAT drop close it). */
  alive(): boolean {
    return !this.closed && !this.deps.conn.closed;
  }

  private get log(): CommandLogSink {
    return this.deps.log ?? commandLogSink();
  }

  // ── logging ──

  private async writeLog(row: {
    template: string; command: string; sensitive: boolean; status: 'ok' | 'error' | 'refused' | 'timeout';
    exitCode?: number | null; bytesOut?: number; durationMs?: number | null; error?: string | null;
  }): Promise<void> {
    await this.log.write({
      sourceId: this.sourceId,
      discoveryId: this.deps.ctx.discoveryId ?? null,
      runId: this.deps.ctx.runId ?? null,
      template: row.template,
      command: capCommand(row.command),
      phase: this.phase,
      sensitive: row.sensitive,
      status: row.status,
      exitCode: row.exitCode ?? null,
      bytesOut: row.bytesOut ?? 0,
      durationMs: row.durationMs ?? null,
      error: row.error ?? null,
    });
  }

  /** Logs a refusal and returns the error to throw. */
  async refuse(template: unknown, spec: TemplateSpec | null, reason: string, command = '<invalid>', t0 = Date.now()): Promise<SourceCommandRefusedError> {
    const name = safeTemplateName(template);
    await this.writeLog({ template: name, command, sensitive: spec?.sensitive ?? false, status: 'refused', durationMs: Date.now() - t0, error: reason });
    return new SourceCommandRefusedError(name, reason);
  }

  // ── exec ──

  private async exec(command: string, o: ExecOptions): Promise<ExecOutcome> {
    if (this.closed) throw new SourceConnectionError('connectFailed', 'The session is closed');
    const release = await this.limiter.acquire();
    const t0 = Date.now();
    let handle: ExecHandle | null = null;
    try {
      if (this.closed) throw new SourceConnectionError('connectFailed', 'The session is closed');
      handle = await this.deps.conn.exec(command);
      this.active.add(handle);
      const h = handle;
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      let aborted = false;
      let stderr = '';
      let stderrBytes = 0;
      let lastTick = 0;

      // Channel errors surface as the exit status / connection loss: never as an unhandled 'error'.
      for (const s of [h.stdin, h.stdout, h.stderr]) s.on('error', () => undefined);
      h.stdin.end();
      h.stderr.on('data', (d: Buffer) => {
        if (stderrBytes >= MAX_STDERR) return;
        const part = d.subarray(0, MAX_STDERR - stderrBytes);
        stderrBytes += part.length;
        stderr += part.toString('utf8');
      });
      h.stdout.on('data', (d: Buffer) => {
        bytes += d.length;
        if (o.sink) {
          if (!o.sink.write(d)) {
            h.stdout.pause();
            o.sink.once('drain', () => h.stdout.resume());
          }
          const now = Date.now();
          if (o.onBytes && now - lastTick >= 500) { lastTick = now; o.onBytes(bytes); }
          return;
        }
        if (truncated) return;
        const kept = bytes - d.length;
        if (bytes > o.maxBytes) {
          chunks.push(d.subarray(0, Math.max(0, o.maxBytes - kept)));
          truncated = true;
          h.kill();
          return;
        }
        chunks.push(d);
      });

      let interrupt!: () => void;
      const interrupted = new Promise<void>((resolve) => { interrupt = resolve; });
      const stop = () => { h.kill(); h.stdout.resume(); interrupt(); };
      const timer = setTimeout(() => { timedOut = true; stop(); }, o.timeoutMs);
      timer.unref?.();
      const onAbort = () => { aborted = true; stop(); };
      const signals = [o.signal, this.deps.ctx.signal].filter((s): s is AbortSignal => !!s);
      for (const s of signals) {
        if (s.aborted) onAbort();
        else s.addEventListener('abort', onAbort, { once: true });
      }
      const stdoutEnded = new Promise<void>((resolve) => {
        h.stdout.once('end', resolve);
        h.stdout.once('close', resolve);
        h.stdout.once('error', () => resolve());
      });
      let res: { code: number | null };
      try {
        res = await h.done;
        if (timedOut || aborted || truncated) h.stdout.resume(); // nothing more is wanted: drain
        // Everything read (a paused stdout may still hold data after the channel closed).
        await Promise.race([stdoutEnded, interrupted]);
        if (o.sink) await Promise.race([new Promise<void>((resolve) => o.sink!.write(Buffer.alloc(0), () => resolve())), interrupted]);
      } finally {
        clearTimeout(timer);
        for (const s of signals) s.removeEventListener('abort', onAbort);
      }
      if (o.sink && o.onBytes) o.onBytes(bytes);
      return {
        exitCode: res.code, stdout: Buffer.concat(chunks), stderr, truncated, bytesOut: bytes, durationMs: Date.now() - t0,
        timedOut, aborted,
      };
    } finally {
      if (handle) this.active.delete(handle);
      release();
    }
  }

  /** Runs an already validated rendering, logs it, maps the outcome. Returns the raw stdout too. */
  private async execLogged(
    spec: TemplateSpec, command: string, opts: RunOptions & { sink?: Writable; onBytes?: (n: number) => void },
  ): Promise<{ result: CommandResult; raw: Buffer }> {
    const t0 = Date.now();
    const tpl = spec.id;
    const base = { template: tpl, command, sensitive: spec.sensitive };
    let out: ExecOutcome;
    try {
      out = await this.exec(command, {
        timeoutMs: opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : spec.timeoutMs,
        maxBytes: opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_STDOUT,
        signal: opts.signal,
        sink: opts.sink,
        onBytes: opts.onBytes,
      });
    } catch (err) {
      const e = err instanceof SourceConnectionError ? err : new SourceConnectionError('connectFailed', 'The command channel could not be opened');
      await this.writeLog({ ...base, status: 'error', durationMs: Date.now() - t0, error: e.message });
      throw e;
    }
    const logged = { ...base, exitCode: out.exitCode, bytesOut: out.bytesOut, durationMs: out.durationMs };
    if (out.aborted) {
      await this.writeLog({ ...logged, status: 'error', error: 'cancelled' });
      throw new SourceCommandError(tpl, out.exitCode, 'cancelled');
    }
    if (out.timedOut) {
      const s = Math.round((opts.timeoutMs || spec.timeoutMs) / 1000);
      await this.writeLog({ ...logged, status: 'timeout', error: `timed out after ${s} s` });
      throw new SourceCommandError(tpl, null, `timed out after ${s} s`);
    }
    if (out.exitCode === SYMLINK_EXIT && out.stderr.includes('oblimint: path crosses a symbolic link')) {
      await this.writeLog({ ...logged, status: 'refused', error: 'symlinkPath' });
      throw new SourceCommandRefusedError(tpl, 'symlinkPath');
    }
    if (this.deps.useSudo && out.exitCode === 1 && /^sudo: /m.test(out.stderr)) {
      await this.writeLog({ ...logged, status: 'error', error: 'sudoFailed' });
      throw new SourceConnectionError('sudoFailed', 'sudo -n refused the command (a password is required or the command is not allowed)');
    }
    const result: CommandResult = {
      exitCode: out.exitCode ?? -1,
      stdout: opts.sink ? '' : out.stdout.toString('utf8'),
      stderr: out.stderr,
      truncated: out.truncated,
      bytesOut: out.bytesOut,
      durationMs: out.durationMs,
    };
    if (out.truncated) {
      const cap = opts.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_STDOUT;
      await this.writeLog({ ...logged, status: 'error', error: `output larger than ${cap} bytes (truncated)` });
      if (!opts.allowNonZeroExit) throw new SourceCommandError(tpl, out.exitCode, `output larger than ${cap} bytes`);
      return { result, raw: out.stdout };
    }
    if (out.exitCode === null) {
      await this.writeLog({ ...logged, status: 'error', error: 'no exit status (connection lost)' });
      throw new SourceCommandError(tpl, null, 'no exit status (connection lost)');
    }
    if (out.exitCode !== 0) {
      await this.writeLog({ ...logged, status: 'error', error: `exit ${out.exitCode}` });
      if (!opts.allowNonZeroExit || opts.sink) {
        const msg = spec.sensitive
          ? `command failed (exit ${out.exitCode})`
          : `exit ${out.exitCode}${firstLine(out.stderr) ? `: ${firstLine(out.stderr)}` : ''}`;
        throw new SourceCommandError(tpl, out.exitCode, msg);
      }
      return { result, raw: out.stdout };
    }
    await this.writeLog({ ...logged, status: 'ok' });
    return { result, raw: out.stdout };
  }

  // ── SourceSession ──

  async run<T extends CommandTemplateId>(template: T, args: CommandTemplateArgs[T], opts: RunOptions = {}): Promise<CommandResult> {
    const t0 = Date.now();
    const r = renderCommand(template, args, this.phase, this.deps.useSudo);
    if (!r.ok) throw await this.refuse(template, r.spec, r.reason, '<invalid>', t0);
    return (await this.execLogged(r.spec, r.command, opts)).result;
  }

  async stream<T extends StreamTemplateId>(template: T, args: CommandTemplateArgs[T], opts: StreamOptions): Promise<CommandResult> {
    const t0 = Date.now();
    if (!STREAM_TEMPLATES.has(template as string)) {
      throw await this.refuse(template, null, 'not a streamable template', '<invalid>', t0);
    }
    if (!opts?.stdout || typeof opts.stdout.write !== 'function') {
      throw await this.refuse(template, null, 'stream target missing', '<invalid>', t0);
    }
    const r = renderCommand(template, args, this.phase, this.deps.useSudo);
    if (!r.ok) throw await this.refuse(template, r.spec, r.reason, '<invalid>', t0);
    return (await this.execLogged(r.spec, r.command, {
      timeoutMs: opts.timeoutMs, signal: opts.signal, sink: opts.stdout, onBytes: opts.onBytes,
    })).result;
  }

  async readFiles(paths: string[], opts: { maxBytesPerFile?: number } = {}): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    let max = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
    if (!Number.isInteger(max) || max < 0) max = DEFAULT_MAX_BYTES_PER_FILE;
    max = Math.min(max, MAX_MAX_BYTES_PER_FILE);

    const valid: string[] = [];
    const seen = new Set<string>();
    for (const p of Array.isArray(paths) ? paths : []) {
      if (seen.has(p)) continue;
      seen.add(p);
      try {
        checkReadPath(p, 'content');
        valid.push(p);
      } catch (err) {
        out.set(String(p), null);
        const reason = err instanceof PathPolicyError ? err.reason : 'invalid path';
        await this.refuse('fs.catMany', null, `paths: ${reason}`);
      }
    }

    const perBatch = Math.max(1, Math.min(MAX_PATHS_PER_CALL, Math.floor(READ_FILES_BATCH_BYTES / Math.max(1, max))));
    for (let i = 0; i < valid.length; i += perBatch) {
      const batch = valid.slice(i, i + perBatch);
      const r = renderCommand('fs.catMany', { paths: batch, maxBytesPerFile: max }, this.phase, this.deps.useSudo);
      if (!r.ok) throw await this.refuse('fs.catMany', r.spec, r.reason);
      const expected = batch.reduce((n, p) => n + max + Buffer.byteLength(p) + HEADER_OVERHEAD, 0);
      const { raw } = await this.execLogged(r.spec, r.command, { maxBytes: expected, allowNonZeroExit: true });
      const frames = parseCatManyFrames(raw, batch.length, max);
      batch.forEach((p, k) => out.set(p, frames[k] ? frames[k]!.toString('utf8') : null));
    }
    return out;
  }

  async rsyncPull(req: RsyncPullRequest): Promise<RsyncPullResult> {
    if (this.phase !== 'transfer') {
      throw await this.refuse('rsync.sender', null, 'transfer-only template in a discovery session');
    }
    return runRsyncPull(this.rsyncPort(), req, this.deps.rsync);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.deps.ctx.signal?.removeEventListener('abort', this.onSessionAbort);
    for (const h of this.active) h.kill();
    this.active.clear();
    this.deps.conn.close();
  }

  // ── internal port for rsync.ts (internal templates) ──

  private rsyncPort(): RsyncSessionPort {
    return {
      sourceId: this.sourceId,
      refuse: (template, reason, command) => this.refuse(template, null, reason, command),
      realpath: async (path: string, signal?: AbortSignal) => {
        const r = renderCommand('fs.realpath', { path }, this.phase, this.deps.useSudo, true);
        if (!r.ok) throw await this.refuse('fs.realpath', r.spec, r.reason);
        const { result } = await this.execLogged(r.spec, r.command, { signal, allowNonZeroExit: true, maxBytes: 8192 });
        return result.exitCode === 0 ? result.stdout.replace(/\n$/, '') : null;
      },
      openSender: async (options: string[], path: string, runAs: string | null) => {
        const r = renderCommand('rsync.sender', { options, path, runAs }, this.phase, this.deps.useSudo, true);
        if (!r.ok) throw await this.refuse('rsync.sender', r.spec, r.reason);
        if (this.closed) throw new SourceConnectionError('connectFailed', 'The session is closed');
        const release = await this.limiter.acquire();
        const t0 = Date.now();
        let handle: ExecHandle;
        try {
          handle = await this.deps.conn.exec(r.command);
        } catch (err) {
          release();
          await this.writeLog({ template: 'rsync.sender', command: r.command, sensitive: false, status: 'error', durationMs: Date.now() - t0, error: 'channel could not be opened' });
          throw err instanceof SourceConnectionError ? err : new SourceConnectionError('connectFailed', 'The command channel could not be opened');
        }
        this.active.add(handle);
        let bytes = 0;
        handle.stdout.on('data', (d: Buffer) => { bytes += d.length; });
        const finished = handle.done.then(async ({ code }) => {
          this.active.delete(handle);
          release();
          await this.writeLog({
            template: 'rsync.sender', command: r.command, sensitive: false,
            status: code === 0 || code === 24 ? 'ok' : 'error', exitCode: code, bytesOut: bytes, durationMs: Date.now() - t0,
            error: code === 0 || code === 24 ? null : code === null ? 'no exit status' : `exit ${code}`,
          });
          return code;
        });
        return { handle, finished };
      },
    };
  }
}

export function createSourceSession(deps: SessionDeps): SourceSession {
  return new SourceSessionImpl(deps);
}
