import crypto from 'crypto';
import fs from 'fs/promises';
import net from 'net';
import path from 'path';
import type { Duplex } from 'stream';

// ─────────────────────────────────────────────────────────────────────────────
// Tunnel of an rsync pull (docs/P5-PLAN.md §5.6, MG6): a unix socket in a
// per-transfer directory `<migration/tunnels>/<random>/` (0700, owned by the
// transfer's uid:gid: only that uid — and root — can reach it), ONE accepted
// connection, a one-time random token checked in constant time. The first
// line is the shim's handshake `{token, argv}\n` (≤ 64 KiB, 10 s); the bytes
// that follow belong to rsync and are pushed back into the stream untouched.
// ─────────────────────────────────────────────────────────────────────────────

export const HANDSHAKE_MAX_BYTES = 64 * 1024;
export const HANDSHAKE_TIMEOUT_MS = 10_000;

export class TunnelError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'TunnelError';
  }
}

export function newTunnelToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Reads and checks the handshake on `stream`. On success the stream is
 * paused, positioned right after the handshake line (extra bytes unshifted),
 * and the forwarded argv is returned (NOT validated here: rsyncArgv.ts).
 */
export function readHandshake(stream: Duplex, token: string, timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<{ argv: unknown }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (err: TunnelError | null, argv?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onEnd);
      if (err) reject(err);
      else resolve({ argv });
    };
    const timer = setTimeout(() => finish(new TunnelError('handshake timeout')), timeoutMs);
    timer.unref?.();
    const onEnd = () => finish(new TunnelError('connection closed before the handshake'));
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.length > HANDSHAKE_MAX_BYTES) finish(new TunnelError('handshake too large'));
        return;
      }
      if (nl > HANDSHAKE_MAX_BYTES) { finish(new TunnelError('handshake too large')); return; }
      stream.pause();
      const rest = buf.subarray(nl + 1);
      let msg: { token?: unknown; argv?: unknown };
      try {
        msg = JSON.parse(buf.subarray(0, nl).toString('utf8'));
      } catch {
        finish(new TunnelError('malformed handshake'));
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.token !== 'string' || !tokensEqual(msg.token, token)) {
        finish(new TunnelError('bad tunnel token'));
        return;
      }
      if (rest.length) stream.unshift(rest);
      finish(null, msg.argv);
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onEnd);
  });
}

export interface TunnelOptions {
  /** localPaths.migrationTunnels() */
  root: string;
  uid: number;
  gid: number;
  /** chown the directory / socket to uid:gid (production: the panel runs as root). */
  chown: boolean;
  /** Called once with the authenticated connection (stream paused after the handshake). */
  onConnection(argv: unknown, socket: Duplex): void;
  /** Called on a failed handshake (logged by the caller). */
  onRejected(reason: string): void;
}

export interface Tunnel {
  dir: string;
  socketPath: string;
  token: string;
  close(): Promise<void>;
}

/**
 * Removes every entry of the tunnels root (directories + stale sockets left by a
 * panel killed during a pull — the MG9 resume scenario). Only safe while no
 * tunnel of this process is open: rsync.ts runs it once, before its first tunnel.
 * fs.rm never follows a symlink entry (the link itself is removed).
 */
export async function purgeStaleTunnels(root: string): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return 0; // missing root: nothing to purge
  }
  let removed = 0;
  for (const name of names) {
    try {
      await fs.rm(path.join(root, name), { recursive: true, force: true });
      removed++;
    } catch { /* best effort */ }
  }
  return removed;
}

/** Creates the per-transfer directory + socket. One connection is accepted, then the server stops listening. */
export async function openTunnel(o: TunnelOptions): Promise<Tunnel> {
  await fs.mkdir(o.root, { recursive: true, mode: 0o711 });
  await fs.chmod(o.root, 0o711).catch(() => undefined);
  const id = crypto.randomBytes(16).toString('hex');
  const dir = path.join(o.root, id);
  await fs.mkdir(dir, { mode: 0o700 });
  const token = newTunnelToken();
  // Production is Linux (unix socket in the 0700 dir). win32 = dev / tests only: named pipe (no dir permission).
  const isWin = process.platform === 'win32';
  const socketPath = isWin ? `\\\\.\\pipe\\oblimint-tunnel-${id}` : path.join(dir, 's');
  const sockets = new Set<net.Socket>();
  let accepted = false;

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    if (accepted) { socket.destroy(); return; }
    accepted = true;
    server.close();
    readHandshake(socket, token).then(
      ({ argv }) => o.onConnection(argv, socket),
      (err: TunnelError) => { o.onRejected(err.reason); socket.destroy(); },
    );
  });

  try {
    if (o.chown) await fs.chown(dir, o.uid, o.gid);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
    });
    if (!isWin) {
      await fs.chmod(socketPath, 0o600);
      if (o.chown) await fs.chown(socketPath, o.uid, o.gid);
    }
  } catch (err) {
    server.close();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  return {
    dir,
    socketPath,
    token,
    async close() {
      server.close();
      for (const s of sockets) s.destroy();
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
