import type Docker from 'dockerode';
import { errText, withTimeout } from '../setup/docker';
import { isNotFound } from '../docker/dockerOps';

// Docker primitives of the apps module that dockerOps.ts does not have (authenticated / cancellable
// pulls, volumes, builds, health waits, pause). Bounded calls, idempotent "already" answers.

const CALL_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 15 * 60_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export interface PullAuth {
  username: string;
  password: string;
  serveraddress: string;
}

export function serverAddress(registry: string): string {
  return registry === 'docker.io' ? 'https://index.docker.io/v1/' : registry;
}

/** Pulls `ref` with optional credentials; aborting the signal destroys the stream (CancelledError). */
export async function pullWithAuth(docker: Docker, ref: string, auth: PullAuth | null, log: (line: string) => void, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new CancelledError();
  const opts = auth ? { authconfig: auth } : {};
  const stream = await withTimeout(docker.pull(ref, opts) as Promise<NodeJS.ReadableStream>, 60_000, `pull ${ref}`);
  if (signal?.aborted) {
    (stream as unknown as { destroy?: () => void }).destroy?.();
    throw new CancelledError();
  }
  const lastStatus = new Map<string, string>();
  let streamError: string | null = null;
  await withTimeout(new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      (stream as unknown as { destroy?: () => void }).destroy?.();
      reject(new CancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    docker.modem.followProgress(
      stream,
      (err: Error | null) => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) { reject(new CancelledError()); return; }
        if (err) reject(err); else if (streamError) reject(new Error(streamError)); else resolve();
      },
      (ev: { id?: string; status?: string; error?: string }) => {
        if (ev.error) { streamError = ev.error; return; }
        if (!ev.status || /Downloading|Extracting|Waiting|Verifying/.test(ev.status)) return;
        const key = ev.id ?? '';
        if (lastStatus.get(key) === ev.status) return;
        lastStatus.set(key, ev.status);
        log(ev.id ? `  ${ev.id}: ${ev.status}` : `  ${ev.status}`);
      },
    );
  }), PULL_TIMEOUT_MS, `pull ${ref}`);
}

export async function inspectImage(docker: Docker, ref: string): Promise<Docker.ImageInspectInfo | null> {
  try {
    return await withTimeout(docker.getImage(ref).inspect(), CALL_TIMEOUT_MS, `inspect image ${ref}`);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function createVolume(docker: Docker, spec: Docker.VolumeCreateOptions): Promise<void> {
  try {
    const existing = await withTimeout(docker.getVolume(spec.Name!).inspect(), CALL_TIMEOUT_MS, `inspect volume ${spec.Name}`) as { Options?: Record<string, string> | null };
    const want = spec.DriverOpts ?? {};
    const have = existing?.Options ?? {};
    if (Object.keys(want).every((k) => have[k] === want[k])) return;
    // Same name, other options (never expected): recreated (the data lives in the bound directory).
    await removeVolume(docker, spec.Name!);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await withTimeout(docker.createVolume(spec), CALL_TIMEOUT_MS, `create volume ${spec.Name}`);
}

export async function removeVolume(docker: Docker, name: string): Promise<void> {
  try {
    await withTimeout(docker.getVolume(name).remove(), CALL_TIMEOUT_MS, `remove volume ${name}`);
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
}

export async function pauseContainer(docker: Docker, name: string): Promise<void> {
  try {
    await withTimeout(docker.getContainer(name).pause(), CALL_TIMEOUT_MS, `pause ${name}`);
  } catch (err) {
    if (/already paused|is not running/i.test(errText(err))) return;
    throw err;
  }
}

export async function unpauseContainer(docker: Docker, name: string): Promise<void> {
  try {
    await withTimeout(docker.getContainer(name).unpause(), CALL_TIMEOUT_MS, `unpause ${name}`);
  } catch (err) {
    if (/is not paused/i.test(errText(err))) return;
    throw err;
  }
}

/** Builds an image from a tar context stream (classic builder); progress lines to `log`. */
export async function buildImage(docker: Docker, context: NodeJS.ReadableStream, opts: Record<string, unknown>, log: (line: string) => void, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new CancelledError();
  const stream = await withTimeout(docker.buildImage(context, opts) as Promise<NodeJS.ReadableStream>, 120_000, 'build');
  if (signal?.aborted) {
    (stream as unknown as { destroy?: () => void }).destroy?.();
    throw new CancelledError();
  }
  let streamError: string | null = null;
  await withTimeout(new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      (stream as unknown as { destroy?: () => void }).destroy?.();
      reject(new CancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    docker.modem.followProgress(
      stream,
      (err: Error | null) => {
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) { reject(new CancelledError()); return; }
        if (err) reject(err); else if (streamError) reject(new Error(streamError)); else resolve();
      },
      (ev: { stream?: string; error?: string; status?: string }) => {
        if (ev.error) { streamError = ev.error; log(`  ${ev.error}`); return; }
        if (ev.stream) log(`  ${ev.stream.replace(/\n$/, '')}`);
      },
    );
  }), BUILD_TIMEOUT_MS, 'build');
}

export type WaitOutcome = 'healthy' | 'running' | 'completed';

/**
 * Waits for a container: 'healthy' (healthcheck), 'started' (running), or
 * 'completed' (exited 0). Throws on unhealthy / exited / timeout.
 */
export async function waitContainer(
  docker: Docker, name: string, condition: 'healthy' | 'started' | 'completed', timeoutMs: number,
  sleep: (ms: number) => Promise<void>, now: () => number, checkpoint: () => void,
): Promise<WaitOutcome> {
  const deadline = now() + timeoutMs;
  for (;;) {
    checkpoint();
    const info = await withTimeout(docker.getContainer(name).inspect(), CALL_TIMEOUT_MS, `inspect ${name}`);
    const st = info.State as Docker.ContainerInspectInfo['State'] & { Health?: { Status?: string } };
    if (condition === 'completed') {
      if (st.Status === 'exited') {
        if (st.ExitCode === 0) return 'completed';
        throw new Error(`${name} exited with code ${st.ExitCode}`);
      }
    } else if (st.Status === 'exited' || st.Status === 'dead') {
      throw new Error(`${name} stopped (exit code ${st.ExitCode})`);
    } else if (condition === 'healthy') {
      const h = st.Health?.Status;
      if (h === 'healthy') return 'healthy';
      if (h === 'unhealthy') throw new Error(`${name} is unhealthy`);
      if (!h && st.Running) return 'running';
    } else if (st.Running) return 'running';
    if (now() >= deadline) throw new Error(`${name}: not ${condition === 'completed' ? 'completed' : condition} after ${Math.round(timeoutMs / 1000)} s`);
    await sleep(1000);
  }
}
