import path from 'path';
import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import { fingerprintOf } from './sshKeys';

// ─────────────────────────────────────────────────────────────────────────────
// SFTP of the automation (docs/P4b-PLAN.md §11.3, invariant MO3) — ssh2
// client connected to the address PINNED by the anti-SSRF guard, host key
// checked against the pinned SHA256 fingerprint (TOFU: the caller pins the
// fingerprint of the first successful connection), bounded in time: connect
// + each operation (timeoutMs) AND the whole session (sessionTimeoutMs).
// Errors are reduced to GENERIC texts (shown to clients: A6).
// ─────────────────────────────────────────────────────────────────────────────

export const SFTP_TIMEOUT_MS = 20_000;
/** Whole-session deadline (a test, an export run): far below the 1 h stale claim of a workflow. */
export const SFTP_SESSION_MS = 5 * 60_000;

export class HostKeyMismatchError extends Error {
  constructor(readonly fingerprint: string) {
    super('host key mismatch');
    this.name = 'HostKeyMismatchError';
  }
}

export class SftpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SftpError';
  }
}

export interface SftpConnectOptions {
  /** Pinned address (never re-resolved here). */
  address: string;
  port: number;
  username: string;
  privateKey?: string;
  password?: string;
  /** Pinned fingerprint; null = accept and report (TOFU). */
  expectedFingerprint: string | null;
  /** Connection + per-operation timeout. */
  timeoutMs?: number;
  /** Deadline of the whole session once open (default SFTP_SESSION_MS). */
  sessionTimeoutMs?: number;
}

export interface SftpSession {
  /** Fingerprint of the server's host key. */
  fingerprint: string;
  readdir(dir: string): Promise<string[]>;
  mkdirp(dir: string): Promise<void>;
  /** Writes a file then forces its mode (an existing file keeps its mode otherwise). */
  writeFile(file: string, data: Buffer | string, mode: number): Promise<void>;
  close(): void;
}

/** Minimal ssh2 client surface (a test injects a fake). */
export interface Ssh2ClientLike {
  on(event: 'ready', cb: () => void): this;
  on(event: 'error', cb: (err: Error & { level?: string }) => void): this;
  on(event: 'close', cb: () => void): this;
  connect(cfg: ConnectConfig): this;
  sftp(cb: (err: Error | undefined, sftp: SFTPWrapper) => void): this;
  end(): this;
}

let clientFactory: () => Ssh2ClientLike = () => new Client() as unknown as Ssh2ClientLike;

export function setSsh2ClientFactoryForTests(f: (() => Ssh2ClientLike) | null): void {
  clientFactory = f ?? (() => new Client() as unknown as Ssh2ClientLike);
}

/** Generic text of an ssh / sftp error. */
export function sftpErrorText(err: unknown): string {
  if (err instanceof HostKeyMismatchError) return 'host key mismatch';
  if (err instanceof SftpError) return err.message;
  const e = err as { level?: string; code?: string | number; message?: string };
  if (e?.level === 'client-authentication') return 'authentication failed';
  if (e?.level === 'client-timeout' || e?.code === 'ETIMEDOUT') return 'timed out';
  if (e?.code === 'ECONNREFUSED') return 'connection refused';
  if (e?.code === 'EHOSTUNREACH' || e?.code === 'ENETUNREACH') return 'host unreachable';
  if (e?.code === 'ECONNRESET') return 'connection reset';
  if (e?.code === 2) return 'no such file or directory';
  if (e?.code === 3) return 'permission denied';
  return 'SFTP failed';
}

/**
 * Remote path of a file under the target's base path: `rel` must be
 * relative, without '..' nor control characters (throws SftpError).
 */
export function remotePathUnder(basePath: string, rel: string | null | undefined, file?: string): string {
  const bad = (s: string) => /[\0-\x1f\x7f]/.test(s) || s.split('/').includes('..');
  const base = (basePath || '.').replace(/\\/g, '/');
  const r = (rel ?? '').replace(/\\/g, '/');
  if (bad(base)) throw new SftpError('invalid base path');
  if (r.startsWith('/') || bad(r)) throw new SftpError('invalid remote path');
  if (file !== undefined && (file.includes('/') || bad(file) || !file)) throw new SftpError('invalid file name');
  const joined = path.posix.normalize(path.posix.join(base, r, file ?? ''));
  if (joined.split('/').includes('..')) throw new SftpError('invalid remote path');
  return joined.replace(/\/$/, '') || '.';
}


/**
 * State of an open session: every operation is bounded (per-operation
 * timeout AND the session deadline) and rejected at once when the connection
 * closes / errors / the deadline passes — a server that authenticates then
 * stalls its SFTP replies never keeps a request or a run alive.
 */
class SessionGuard {
  private readonly pending = new Set<(err: Error) => void>();
  private broken: Error | null = null;
  private readonly deadline: NodeJS.Timeout;

  constructor(private readonly conn: Ssh2ClientLike, private readonly opTimeoutMs: number, sessionMs: number) {
    this.deadline = setTimeout(() => this.breakWith(new SftpError('timed out')), sessionMs);
    this.deadline.unref?.();
  }

  breakWith(err: Error): void {
    if (this.broken) return;
    this.broken = err;
    clearTimeout(this.deadline);
    for (const reject of [...this.pending]) reject(err);
    this.pending.clear();
    try { this.conn.end(); } catch { /* closed */ }
  }

  close(): void {
    this.breakWith(new SftpError('session closed'));
  }

  run<T = void>(f: (done: (err: Error | null | undefined, v?: T) => void) => void): Promise<T> {
    if (this.broken) return Promise.reject(this.broken);
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = (err: Error | null | undefined, v?: T) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.pending.delete(onBreak);
        if (err) reject(err);
        else resolve(v as T);
      };
      const onBreak = (err: Error) => finish(err);
      const timer = setTimeout(() => {
        // A stalled operation: the whole session is unusable (its replies may still arrive out of order).
        const err = new SftpError('timed out');
        finish(err);
        this.breakWith(err);
      }, this.opTimeoutMs);
      timer.unref?.();
      this.pending.add(onBreak);
      try {
        f(finish);
      } catch (err) {
        finish(err as Error);
      }
    });
  }
}

function session(guard: SessionGuard, sftp: SFTPWrapper, fingerprint: string): SftpSession {
  return {
    fingerprint,
    async readdir(dir) {
      const list = await guard.run<Array<{ filename: string }>>((d) => sftp.readdir(dir, d as never));
      return list.map((e) => e.filename);
    },
    async mkdirp(dir) {
      const parts = dir.split('/').filter((p) => p && p !== '.');
      let cur = dir.startsWith('/') ? '' : '.';
      for (const p of parts) {
        cur = cur === '' ? `/${p}` : `${cur}/${p}`;
        try {
          await guard.run((d) => sftp.stat(cur, d as never));
        } catch (err) {
          if (err instanceof SftpError) throw err; // timed out / closed: not "missing"
          await guard.run((d) => sftp.mkdir(cur, d as never));
        }
      }
    },
    async writeFile(file, data, mode) {
      await guard.run((d) => sftp.writeFile(file, data, { mode }, d as never));
      await guard.run((d) => sftp.chmod(file, mode, d as never));
    },
    close() {
      try { sftp.end(); } catch { /* closed */ }
      guard.close();
    },
  };
}

/** Opens an SFTP session. Throws HostKeyMismatchError / ssh errors (map them with sftpErrorText). */
export function connectSftp(opts: SftpConnectOptions): Promise<SftpSession> {
  return new Promise<SftpSession>((resolve, reject) => {
    const conn = clientFactory();
    const opTimeout = opts.timeoutMs ?? SFTP_TIMEOUT_MS;
    let seen: string | null = null;
    let mismatch = false;
    let settled = false;
    let guard: SessionGuard | null = null;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.end(); } catch { /* closed */ }
      reject(mismatch && seen ? new HostKeyMismatchError(seen) : err);
    };
    const timer = setTimeout(() => fail(new SftpError('timed out')), opTimeout);
    timer.unref?.();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { fail(err); return; }
        if (settled) { try { sftp.end(); } catch { /* closed */ } return; }
        settled = true;
        clearTimeout(timer);
        guard = new SessionGuard(conn, opTimeout, opts.sessionTimeoutMs ?? SFTP_SESSION_MS);
        resolve(session(guard, sftp, seen as string));
      });
    });
    // After the session opened, a dropped connection rejects every pending operation at once.
    conn.on('error', (err) => (guard ? guard.breakWith(err) : fail(err)));
    conn.on('close', () => (guard ? guard.breakWith(new SftpError('connection closed')) : fail(new SftpError('connection closed'))));
    try {
      conn.connect({
        host: opts.address,
        port: opts.port,
        username: opts.username,
        ...(opts.privateKey ? { privateKey: opts.privateKey } : {}),
        ...(opts.password ? { password: opts.password } : {}),
        tryKeyboard: false,
        readyTimeout: opTimeout,
        hostVerifier: (key: Buffer | string) => {
          const blob = Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex');
          seen = fingerprintOf(blob);
          if (opts.expectedFingerprint && seen !== opts.expectedFingerprint) {
            mismatch = true;
            return false;
          }
          return true;
        },
      } as ConnectConfig);
    } catch (err) {
      fail(err);
    }
  });
}
