import crypto from 'crypto';
import type { Readable, Writable } from 'stream';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import type { MigrationHostKey, MigrationSourceAuth } from '@oblimint/shared';
import { SourceConnectionError } from '../contracts/source';

// ─────────────────────────────────────────────────────────────────────────────
// SSH transport of the read-only executor (docs/P5-PLAN.md §5.1, MG3).
//
// One ssh2 connection per session; the host key presented by the server is
// checked IN hostVerifier, before any authentication: nothing pinned →
// refused `hostKeyUnpinned`, other key → refused `hostKeyMismatch` — the
// presented key travels with the error (HostKeyRejectedError) so the caller
// stores it as *pending* for the admin to confirm. Commands run on exec
// channels WITHOUT a PTY (no echo, no tty-driven behaviour, binary-safe
// stdout). This module exports no "run a string" helper to the rest of the
// panel: SshConnection is only handed to session.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const SSH_READY_TIMEOUT_MS = 20_000;
export const SSH_KEEPALIVE_MS = 15_000;

/** Sealed credentials (secretBox 'migration-source'). */
export interface SourceSecret {
  password?: string | null;
  privateKey?: string | null;
  passphrase?: string | null;
}

export interface ExecHandle {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  /** Resolves once the channel is closed: exit code (null when killed / connection lost / no status). */
  done: Promise<{ code: number | null; signal: string | null }>;
  /** Kills the remote command (signal when supported) and closes the channel. */
  kill(): void;
}

export interface SshConnection {
  exec(command: string): Promise<ExecHandle>;
  close(): void;
  readonly closed: boolean;
}

export interface SshConnectParams {
  host: string;
  port: number;
  username: string;
  authMethod: MigrationSourceAuth;
  secret: SourceSecret;
  /** Pinned fingerprint (null = nothing pinned: the connection is refused after capturing the key). */
  pinnedFingerprint: string | null;
  readyTimeoutMs?: number;
}

export interface SshConnectResult {
  conn: SshConnection;
  hostKey: MigrationHostKey;
}

/** The server presented a key that is not pinned (or another one). Carries it for the pending slot. */
export class HostKeyRejectedError extends SourceConnectionError {
  constructor(code: 'hostKeyUnpinned' | 'hostKeyMismatch', public readonly hostKey: MigrationHostKey) {
    super(code, code === 'hostKeyUnpinned'
      ? 'The host key of the source is not pinned yet'
      : 'The host key presented by the source differs from the pinned key');
  }
}

// ── host key (pure) ─────────────────────────────────────────────────────────

/** 'SHA256:' + base64(sha256(blob)) without padding, as OpenSSH prints it. */
export function sshFingerprint(blob: Buffer): string {
  return `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** Key type = first SSH-wire string of the public key blob (ssh-ed25519, ecdsa-sha2-nistp256, ssh-rsa…). */
export function sshKeyAlgorithm(blob: Buffer): string {
  if (blob.length < 4) return 'unknown';
  const len = blob.readUInt32BE(0);
  if (len < 1 || len > 64 || 4 + len > blob.length) return 'unknown';
  const name = blob.subarray(4, 4 + len).toString('latin1');
  return /^[A-Za-z0-9@._-]+$/.test(name) ? name : 'unknown';
}

export type HostKeyDecision = { hostKey: MigrationHostKey; state: 'unpinned' | 'match' | 'mismatch' };

/** hostVerifier decision: accept only the pinned key. */
export function decideHostKey(blob: Buffer, pinnedFingerprint: string | null | undefined): HostKeyDecision {
  const hostKey = { algorithm: sshKeyAlgorithm(blob), fingerprint: sshFingerprint(blob) };
  if (!pinnedFingerprint) return { hostKey, state: 'unpinned' };
  const a = Buffer.from(hostKey.fingerprint);
  const b = Buffer.from(pinnedFingerprint);
  const same = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { hostKey, state: same ? 'match' : 'mismatch' };
}

// ── errors ──────────────────────────────────────────────────────────────────

/** Generic, secret-free connection error (never echoes the key / password). */
export function mapSshError(err: unknown): SourceConnectionError {
  if (err instanceof SourceConnectionError) return err;
  const e = err as { level?: string; code?: string | number; message?: string };
  const msg = String(e?.message ?? '');
  if (e?.level === 'client-authentication' || /authentication methods failed/i.test(msg)) {
    return new SourceConnectionError('authFailed', 'Authentication failed');
  }
  if (/cannot parse privatekey|encrypted private key|bad passphrase|no passphrase/i.test(msg)) {
    return new SourceConnectionError('authFailed', 'The private key cannot be used (format or passphrase)');
  }
  if (e?.level === 'client-timeout' || e?.code === 'ETIMEDOUT' || /timed out/i.test(msg)) {
    return new SourceConnectionError('timeout', 'Connection timed out');
  }
  if (e?.code === 'ECONNREFUSED') return new SourceConnectionError('connectFailed', 'Connection refused');
  if (e?.code === 'EHOSTUNREACH' || e?.code === 'ENETUNREACH') return new SourceConnectionError('connectFailed', 'Host unreachable');
  if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN') return new SourceConnectionError('connectFailed', 'Host name cannot be resolved');
  if (e?.code === 'ECONNRESET') return new SourceConnectionError('connectFailed', 'Connection reset');
  return new SourceConnectionError('connectFailed', 'SSH connection failed');
}

// ── ssh2 implementation ─────────────────────────────────────────────────────

/** Minimal ssh2 Client surface (tests inject a fake). */
export interface Ssh2ClientLike {
  on(event: string, cb: (...args: any[]) => void): this;
  connect(cfg: ConnectConfig): this;
  exec(command: string, cb: (err: Error | undefined, channel: ClientChannel) => void): this;
  end(): this;
}

let clientFactory: () => Ssh2ClientLike = () => new Client() as unknown as Ssh2ClientLike;

export function setSsh2ClientFactoryForTests(f: (() => Ssh2ClientLike) | null): void {
  clientFactory = f ?? (() => new Client() as unknown as Ssh2ClientLike);
}

function wrapChannel(ch: ClientChannel): ExecHandle {
  let code: number | null = null;
  let signal: string | null = null;
  const done = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    ch.on('exit', (c: number | null, s?: string) => {
      if (typeof c === 'number') code = c;
      if (s) signal = s;
    });
    ch.on('close', () => resolve({ code, signal }));
  });
  return {
    stdout: ch,
    stderr: ch.stderr,
    stdin: ch,
    done,
    kill() {
      try { ch.signal('KILL'); } catch { /* not supported by every sshd */ }
      try { ch.close(); } catch { /* already closed */ }
    },
  };
}

/** Opens an SSH connection to a source. Throws SourceConnectionError (HostKeyRejectedError for the key). */
export function connectSsh(p: SshConnectParams): Promise<SshConnectResult> {
  const secret = p.secret;
  if (p.authMethod === 'password' ? !secret.password : !secret.privateKey) {
    return Promise.reject(new SourceConnectionError('noSecret', 'No credentials are stored for this source'));
  }
  return new Promise<SshConnectResult>((resolve, reject) => {
    const client = clientFactory();
    let presented: MigrationHostKey | null = null;
    let rejectedKey: HostKeyRejectedError | null = null;
    let settled = false;
    let closed = false;

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      try { client.end(); } catch { /* ignore */ }
      reject(rejectedKey ?? mapSshError(err));
    };

    client.on('ready', () => {
      if (settled) return;
      settled = true;
      const conn: SshConnection = {
        get closed() { return closed; },
        exec(command: string): Promise<ExecHandle> {
          return new Promise<ExecHandle>((res, rej) => {
            if (closed) { rej(new SourceConnectionError('connectFailed', 'SSH connection closed')); return; }
            try {
              // No PTY, ever: plain exec channel.
              client.exec(command, (err, ch) => (err ? rej(mapSshError(err)) : res(wrapChannel(ch))));
            } catch (err) {
              rej(mapSshError(err));
            }
          });
        },
        close() {
          if (closed) return;
          closed = true;
          try { client.end(); } catch { /* ignore */ }
        },
      };
      resolve({ conn, hostKey: presented ?? { algorithm: 'unknown', fingerprint: '' } });
    });
    client.on('error', (err: Error) => fail(err));
    client.on('close', () => {
      closed = true;
      fail(new SourceConnectionError('connectFailed', 'Connection closed'));
    });
    if (p.authMethod === 'password') {
      // Some sshd only offer keyboard-interactive for passwords.
      client.on('keyboard-interactive', (_name: string, _instr: string, _lang: string, prompts: unknown[], finish: (r: string[]) => void) => {
        finish(prompts.map(() => secret.password ?? ''));
      });
    }

    const cfg: ConnectConfig = {
      host: p.host,
      port: p.port,
      username: p.username,
      readyTimeout: p.readyTimeoutMs ?? SSH_READY_TIMEOUT_MS,
      keepaliveInterval: SSH_KEEPALIVE_MS,
      keepaliveCountMax: 4,
      tryKeyboard: p.authMethod === 'password',
      hostVerifier: (key: Buffer | string) => {
        const blob = Buffer.isBuffer(key) ? key : Buffer.from(key, 'hex');
        const d = decideHostKey(blob, p.pinnedFingerprint);
        presented = d.hostKey;
        if (d.state === 'match') return true;
        rejectedKey = new HostKeyRejectedError(d.state === 'unpinned' ? 'hostKeyUnpinned' : 'hostKeyMismatch', d.hostKey);
        return false;
      },
      ...(p.authMethod === 'password'
        ? { password: secret.password ?? undefined }
        : { privateKey: secret.privateKey ?? undefined, ...(secret.passphrase ? { passphrase: secret.passphrase } : {}) }),
    };
    try {
      client.connect(cfg);
    } catch (err) {
      fail(err);
    }
  });
}
