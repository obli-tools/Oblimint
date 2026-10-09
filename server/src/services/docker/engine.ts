import { Writable } from 'stream';
import Docker from 'dockerode';
import { config } from '../../config';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { errText } from '../setup/docker';

// ─────────────────────────────────────────────────────────────────────────────
// Node engine abstraction (ARCHITECTURE §3.7, ported from Oblihub
// engine.service.ts). P1: the local node (nodes.is_local, Docker socket
// config.dockerSocket); ssh / tls engines answer 501 nodeNotSupported until
// multi-node lands, but the per-node structure (row → client, cache) is here.
//
// No global dockerode `timeout`: it would also abort hijacked exec streams
// (see Oblihub). Callers bound each call (withTimeout / execInContainer).
// ─────────────────────────────────────────────────────────────────────────────

interface NodeRow {
  id: number;
  name: string;
  engine_type: 'local' | 'ssh' | 'tls';
  is_local: boolean;
  config: unknown;
}

type EngineFactory = (nodeId: number) => Docker | Promise<Docker>;

const clientCache = new Map<number, Docker>();
let localIdCache: number | null = null;
let factoryOverride: EngineFactory | null = null;
let localIdOverride: number | null = null;

function buildEngine(row: NodeRow): Docker {
  if (row.is_local || row.engine_type === 'local') {
    return new Docker({ socketPath: config.dockerSocket });
  }
  // ssh (ssh://user@host, key in nodes.config) and tls (ca/cert/key) follow
  // Oblihub's buildDockerClient once remote nodes exist.
  throw new AppError(501, `Node ${row.name} (${row.engine_type}): remote nodes are not supported yet`, 'nodeNotSupported');
}

/** dockerode client of a node (cached per node id). */
export async function engineFor(nodeId: number): Promise<Docker> {
  if (factoryOverride) return factoryOverride(nodeId);
  const cached = clientCache.get(nodeId);
  if (cached) return cached;
  const row = await db('nodes').where({ id: nodeId }).first('id', 'name', 'engine_type', 'is_local', 'config') as NodeRow | undefined;
  if (!row) throw new AppError(404, `Node ${nodeId} not found`, 'notFound');
  const client = buildEngine(row);
  clientCache.set(nodeId, client);
  return client;
}

/** Id of the local node (nodes.is_local = true), cached. */
export async function localNodeId(): Promise<number> {
  if (localIdOverride !== null) return localIdOverride;
  if (localIdCache !== null) return localIdCache;
  const row = await db('nodes').where({ is_local: true }).first('id') as { id: number } | undefined;
  if (!row) throw new AppError(500, 'No local node is registered (nodes.is_local)');
  localIdCache = Number(row.id);
  return localIdCache;
}

/** Drops the cached client(s) (node edited / deleted). */
export function invalidateEngine(nodeId?: number): void {
  if (nodeId === undefined) clientCache.clear();
  else clientCache.delete(nodeId);
}

/** Test seam: replace dockerode by a fake (null restores the real engines). */
export function setEngineFactoryForTests(factory: EngineFactory | null, localId: number | null = factory ? 1 : null): void {
  factoryOverride = factory;
  localIdOverride = localId;
  clientCache.clear();
  localIdCache = null;
}

// ── exec ─────────────────────────────────────────────────────────────────────

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Max bytes kept per output stream of an exec. */
export const EXEC_OUTPUT_CAP = 64 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

/** Writable keeping the first `cap` bytes (the rest is counted, then dropped). */
export class CappedCollector extends Writable {
  private chunks: Buffer[] = [];
  private kept = 0;
  truncated = false;

  constructor(private readonly cap: number) {
    super();
  }

  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const room = this.cap - this.kept;
    if (room > 0) {
      const part = buf.length > room ? buf.subarray(0, room) : buf;
      this.chunks.push(part);
      this.kept += part.length;
    }
    if (buf.length > room) this.truncated = true;
    cb();
  }

  text(): string {
    const s = Buffer.concat(this.chunks).toString('utf8');
    return this.truncated ? `${s}\n…[truncated]` : s;
  }
}

/**
 * Runs a command in a running container (docker exec, no TTY, demuxed
 * output capped at 64 KiB per stream, timeout → rejects). Used by edge
 * (nginx -t / reload) and runtime (oblimint-reload).
 */
export async function execInContainer(
  nodeId: number,
  container: string,
  cmd: string[],
  opts: { timeoutMs?: number; user?: string } = {},
): Promise<ExecResult> {
  const docker = await engineFor(nodeId);
  return execWith(docker, container, cmd, opts);
}

/** execInContainer on a given client (tests, callers already holding one). */
export async function execWith(
  docker: Docker,
  container: string,
  cmd: string[],
  opts: { timeoutMs?: number; user?: string } = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const stdout = new CappedCollector(EXEC_OUTPUT_CAP);
  const stderr = new CappedCollector(EXEC_OUTPUT_CAP);
  let stream: NodeJS.ReadableStream | null = null;
  let timer: NodeJS.Timeout | null = null;

  const run = async (): Promise<ExecResult> => {
    const exec = await docker.getContainer(container).exec({
      Cmd: cmd,
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      ...(opts.user ? { User: opts.user } : {}),
    });
    // Plain attached start (no hijack), as Oblihub's nginx exec: the response body is the multiplexed stream.
    stream = await exec.start({ Detach: false, Tty: false }) as unknown as NodeJS.ReadableStream;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (err?: unknown) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve();
      };
      stream!.on('end', () => done());
      stream!.on('close', () => done());
      stream!.on('error', (err) => done(err));
      docker.modem.demuxStream(stream!, stdout, stderr);
    });
    const info = await exec.inspect();
    // ExitCode may still be null right after the stream closed: poll briefly.
    let exitCode = info.ExitCode;
    for (let i = 0; (exitCode === null || exitCode === undefined) && i < 20 && Date.now() < deadline; i++) {
      await new Promise((r) => setTimeout(r, 50));
      exitCode = (await exec.inspect()).ExitCode;
    }
    return { exitCode: exitCode ?? -1, stdout: stdout.text(), stderr: stderr.text() };
  };

  try {
    return await new Promise<ExecResult>((resolve, reject) => {
      timer = setTimeout(() => {
        const s = stream as unknown as { destroy?: () => void } | null;
        try { s?.destroy?.(); } catch { /* already closed */ }
        reject(new Error(`exec ${cmd[0] ?? ''} in ${container}: timed out after ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      run().then(resolve, (err) => reject(new Error(`exec ${cmd[0] ?? ''} in ${container}: ${errText(err)}`)));
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
