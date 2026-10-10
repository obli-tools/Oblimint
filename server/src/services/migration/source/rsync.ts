import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import fs from 'fs/promises';
import path from 'path';
import type { Duplex } from 'stream';
import {
  SourceCommandError, SourceCommandRefusedError, type RsyncPullRequest, type RsyncPullResult,
} from '../contracts/source';
import { config } from '../../../config';
import { localPaths } from '../../hosting/paths';
import { logger } from '../../../utils/logger';
import type { ExecHandle } from './ssh';
import {
  MAX_DRY_RUN_DELETIONS, RsyncRequestError, buildLocalRsyncArgv, parseDeletionLine, parseItemized, parseOutFormatLine, parseRsyncStats, parseUnsafeLinks, rshCommandLine,
  validateRsyncRequest, validateRsyncServerArgv,
} from './rsyncArgv';
import { openTunnel, purgeStaleTunnels, type Tunnel, type TunnelOptions } from './tunnel';
import { RSYNC_TIMEOUT_MS } from './templates';

// ─────────────────────────────────────────────────────────────────────────────
// rsync pull through the tunnel (docs/P5-PLAN.md §5.6, MG6, MG10).
//
//   1. validate the request (rsyncArgv.ts) — refused → command log 'refused';
//   2. local destination must be an existing directory (not a symlink);
//   3. MG10: internal `fs.realpath` on the source — must equal remotePath;
//   4. tunnel dir + socket + one-time token (tunnel.ts), owned by uid:gid;
//   5. spawn the LOCAL rsync as uid:gid (never root) with a minimal env and
//      `--rsh=<node> [--import <tsx loader>] <rsyncShim>`, its cwd being the
//      destination and its destination argument `.` (see buildLocalRsyncArgv:
//      rsync ≥ 3.5.0 opens every component of an absolute destination, which
//      fails on the root:root 0711 ancestors of hostd's layout);
//   6. the shim connects: argv validated → `rsync.sender` channel opened and
//      linked to the socket (anything else: refused, logged, socket closed);
//   7. exit 0 → ok, 24 → partial (files vanished), else SourceCommandError;
//      --stats parsed, unsafe links (dropped by --safe-links) reported;
//      the tunnel dir is removed in every case.
// ─────────────────────────────────────────────────────────────────────────────

/** What rsync.ts needs from the session (internal templates, logging). */
export interface RsyncSessionPort {
  sourceId: number;
  refuse(template: string, reason: string, command?: string): Promise<SourceCommandRefusedError>;
  /** Internal fs.realpath (logged): resolved path, null when missing. */
  realpath(path: string, signal?: AbortSignal): Promise<string | null>;
  /** Internal rsync.sender: logs + opens the channel; `finished` resolves with the exit code once logged. */
  openSender(options: string[], path: string, runAs: string | null): Promise<{ handle: ExecHandle; finished: Promise<number | null> }>;
}

export interface RsyncDeps {
  dataRoot: string;
  tunnelsRoot: string;
  rsyncBinary: string;
  defaultBwLimitKbps: number;
  /** chown tunnel dir / socket (production: running as root). */
  chown: boolean;
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  /** argv of the remote-shell command (node + shim). */
  shimCommand: () => string[];
  /** Tunnel factory (tests: named pipe on Windows). */
  openTunnel: (o: TunnelOptions) => Promise<Tunnel>;
}

/**
 * node + compiled shim next to this file (dist), or tsx + the .ts source (dev).
 * Under tsx the loader is given as an absolute file URL: the local rsync (and
 * so the shim) runs with the transfer destination as its cwd, where a bare
 * `--import tsx` would not resolve.
 */
export function defaultShimCommand(): string[] {
  const ext = path.extname(__filename);
  const shim = path.join(__dirname, `rsyncShim${ext === '.ts' ? '.ts' : '.js'}`);
  if (ext !== '.ts') return [process.execPath, shim];
  let loader = 'tsx';
  try { loader = pathToFileURL(createRequire(__filename).resolve('tsx')).href; } catch { /* keep the bare name */ }
  return [process.execPath, '--import', loader, shim];
}

function defaultDeps(): RsyncDeps {
  return {
    dataRoot: localPaths.root,
    tunnelsRoot: localPaths.migrationTunnels(),
    rsyncBinary: config.hosting.rsyncBinary,
    defaultBwLimitKbps: config.hosting.migrationRsyncBwLimitKbps,
    chown: typeof process.getuid === 'function' && process.getuid() === 0,
    spawn: (cmd, args, opts) => nodeSpawn(cmd, args, opts),
    shimCommand: defaultShimCommand,
    openTunnel,
  };
}

/** One purge of stale tunnel directories per process and root, awaited before any tunnel is opened. */
const purgeOnce = new Map<string, Promise<void>>();
function ensureTunnelsPurged(root: string): Promise<void> {
  let p = purgeOnce.get(root);
  if (!p) {
    p = purgeStaleTunnels(root).then((n) => {
      if (n > 0) logger.info({ removed: n }, 'migration: stale rsync tunnel directories removed');
    }, () => undefined);
    purgeOnce.set(root, p);
  }
  return p;
}

const STDOUT_TAIL = 64 * 1024;
const STDERR_CAP = 64 * 1024;
const KILL_GRACE_MS = 5_000;

export async function runRsyncPull(port: RsyncSessionPort, req: RsyncPullRequest, overrides: Partial<RsyncDeps> = {}): Promise<RsyncPullResult> {
  const deps: RsyncDeps = { ...defaultDeps(), ...overrides };
  const t0 = Date.now();

  // 1. request
  let v;
  try {
    v = validateRsyncRequest(req, deps.dataRoot, deps.defaultBwLimitKbps);
  } catch (err) {
    if (err instanceof RsyncRequestError) throw await port.refuse('rsync.sender', err.reason);
    throw err;
  }

  // 2. local destination
  const st = await fs.lstat(v.localPath).catch(() => null);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) throw await port.refuse('rsync.sender', 'localPath: not an existing directory');

  // 3. MG10 on the source
  const real = await port.realpath(v.remotePath, req.signal);
  if (real === null) throw await port.refuse('rsync.sender', 'remotePath: missing on the source');
  if (real !== v.remotePath) throw await port.refuse('rsync.sender', 'symlinkPath');

  // 4–6. tunnel + local rsync
  let refusal: string | null = null;
  const pendingLogs: Array<Promise<unknown>> = [];
  let sender: { handle: ExecHandle; finished: Promise<number | null> } | null = null;
  let tunnel: Tunnel | null = null;
  let child: ChildProcess | null = null;

  const onConnection = (argv: unknown, socket: Duplex) => {
    socket.on('error', () => undefined); // a shim gone early must not crash the panel
    let validated: { options: string[]; path: string };
    try {
      validated = validateRsyncServerArgv(argv, v.remotePath);
    } catch (err) {
      refusal = err instanceof RsyncRequestError ? err.reason : 'argv: invalid';
      const shown = Array.isArray(argv) ? argv.slice(1).map((a) => String(a)).join(' ') : '<invalid>';
      pendingLogs.push(port.refuse('rsync.sender', refusal, shown.slice(0, 2000)));
      socket.destroy();
      return;
    }
    port.openSender(validated.options, validated.path, v.runAs).then((s) => {
      sender = s;
      const h = s.handle;
      h.stdin.on('error', () => h.kill());
      socket.pipe(h.stdin);
      h.stdout.pipe(socket);
      h.stderr.resume(); // remote sender stderr: not kept (never logged)
      socket.on('error', () => h.kill());
      socket.on('close', () => h.kill());
      void s.finished.then(() => socket.end());
      socket.resume();
    }, (err: Error) => {
      if (err instanceof SourceCommandRefusedError) refusal = err.reason;
      socket.destroy();
    });
  };

  try {
    await ensureTunnelsPurged(deps.tunnelsRoot);
    tunnel = await deps.openTunnel({
      root: deps.tunnelsRoot, uid: v.uid, gid: v.gid, chown: deps.chown,
      onConnection,
      onRejected: (reason) => {
        refusal = `tunnel: ${reason}`;
        pendingLogs.push(port.refuse('rsync.sender', refusal));
      },
    });

    const rsh = rshCommandLine(deps.shimCommand());
    const argv = buildLocalRsyncArgv(v, rsh);
    const env: Record<string, string> = {
      PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      OBLIMINT_TUNNEL: tunnel.socketPath,
      OBLIMINT_TUNNEL_TOKEN: tunnel.token,
    };

    const deletions: string[] = [];
    const result = await new Promise<{ code: number | null; stdoutTail: string; stderr: string; files: number; bytes: number; timedOut: boolean; aborted: boolean }>((resolve, reject) => {
      let stdoutTail = '';
      let partialLine = '';
      let stderr = '';
      let files = 0;
      let bytes = 0;
      let lastProgress = 0;
      let timedOut = false;
      let aborted = false;
      let killTimer: NodeJS.Timeout | null = null;

      try {
        child = deps.spawn(deps.rsyncBinary, argv, {
          uid: v.uid, gid: v.gid, env, cwd: v.localPath, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        });
      } catch (err) {
        reject(err);
        return;
      }
      const c = child;
      const kill = () => {
        try { c.kill('SIGTERM'); } catch { /* gone */ }
        (sender as { handle: ExecHandle } | null)?.handle.kill();
        killTimer = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, KILL_GRACE_MS);
        killTimer.unref?.();
      };
      const timer = setTimeout(() => { timedOut = true; kill(); }, req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : RSYNC_TIMEOUT_MS);
      timer.unref?.();
      const onAbort = () => { aborted = true; kill(); };
      if (req.signal?.aborted) onAbort();
      else req.signal?.addEventListener('abort', onAbort, { once: true });

      c.stdout?.on('data', (d: Buffer) => {
        const text = partialLine + d.toString('utf8');
        const lines = text.split('\n');
        partialLine = lines.pop() ?? '';
        for (const line of lines) {
          if (v.dryRun) {
            // Every line, not the bounded tail: the caller decides what --delete may remove (maildir target-only mail).
            const del = v.deleteExtraneous ? parseDeletionLine(line) : null;
            if (del && deletions.length < MAX_DRY_RUN_DELETIONS) deletions.push(del);
            continue;
          }
          const entry = parseOutFormatLine(line);
          if (entry) { files++; bytes += entry.bytes; }
        }
        stdoutTail = (stdoutTail + d.toString('utf8')).slice(-STDOUT_TAIL);
        const now = Date.now();
        if (req.onProgress && now - lastProgress >= 1000) {
          lastProgress = now;
          try { req.onProgress({ bytes, files }); } catch { /* caller's problem */ }
        }
      });
      c.stderr?.on('data', (d: Buffer) => {
        if (stderr.length < STDERR_CAP) stderr = (stderr + d.toString('utf8')).slice(0, STDERR_CAP);
      });
      c.once('error', (err) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        req.signal?.removeEventListener('abort', onAbort);
        reject(err);
      });
      c.once('close', (code: number | null) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        req.signal?.removeEventListener('abort', onAbort);
        resolve({ code, stdoutTail, stderr, files, bytes, timedOut, aborted });
      });
    }).catch((err: NodeJS.ErrnoException) => {
      logger.warn({ code: err?.code, sourceId: port.sourceId }, 'migration rsync spawn failed');
      throw new SourceCommandError('rsync.sender', null, err?.code === 'ENOENT' ? 'rsync binary not found on the panel' : 'rsync could not be started');
    });

    // Let the remote side finish its log row (bounded).
    const s = sender as { finished: Promise<number | null>; handle: ExecHandle } | null;
    if (s) {
      s.handle.kill();
      await Promise.race([s.finished, new Promise((r) => setTimeout(r, 5_000).unref?.())]);
    }

    await Promise.allSettled(pendingLogs);
    if (refusal) throw new SourceCommandRefusedError('rsync.sender', refusal);
    if (result.aborted) throw new SourceCommandError('rsync.sender', result.code, 'cancelled');
    if (result.timedOut) throw new SourceCommandError('rsync.sender', null, 'rsync timed out');
    const code = result.code ?? -1;
    if (code !== 0 && code !== 24) {
      const first = result.stderr.split('\n').find((l) => l.trim() && !/ignoring unsafe symlink/.test(l))?.trim().slice(0, 200);
      throw new SourceCommandError('rsync.sender', code, `rsync exited with ${code}${first ? `: ${first}` : ''}`);
    }
    const stats = parseRsyncStats(result.stdoutTail);
    const itemized = v.dryRun ? parseItemized(result.stdoutTail) : null;
    const out: RsyncPullResult = {
      exitCode: code,
      files: stats.files || itemized?.files || result.files,
      bytes: stats.bytes || result.bytes,
      deleted: stats.deleted || itemized?.deleted || 0,
      unsafeLinks: parseUnsafeLinks(result.stderr),
      partial: code === 24,
      durationMs: Date.now() - t0,
      ...(v.dryRun && v.deleteExtraneous ? { deletions } : {}),
    };
    try { req.onProgress?.({ bytes: out.bytes, files: out.files }); } catch { /* ignore */ }
    return out;
  } finally {
    if (child && (child as ChildProcess).exitCode === null) {
      try { (child as ChildProcess).kill('SIGKILL'); } catch { /* gone */ }
    }
    if (tunnel) await (tunnel as Tunnel).close();
  }
}
