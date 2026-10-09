import type Docker from 'dockerode';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { errText, withTimeout } from '../setup/docker';
import { CappedCollector } from '../docker/engine';
import {
  connectNetwork, createContainer, imageExists, inspectNetwork, isNotFound, listByLabel, pullImage, removeContainer, startContainer,
} from '../docker/dockerOps';
import { LABELS, P3_LABELS } from '../hosting/naming';
import type { ToolsStepResult } from './common';

// ─────────────────────────────────────────────────────────────────────────────
// Runs ONE tools step (docs/P3-PLAN.md §4.2, M8), after Oblihub's runOneShot:
//   image present? (pull, 502 toolsImageMissing on failure) → leftover of the
//   same name removed → create → connect the account DB network (when it
//   exists) → start → wait (timeoutMs, then SIGKILL; timedOut) → logs
//   (demultiplexed, stdout / stderr kept apart for the parsers, combined
//   output in arrival order, each capped) → ALWAYS removed.
// Never a shell: the argv of the spec is the container's Cmd.
// ─────────────────────────────────────────────────────────────────────────────

/** Combined output kept per step (adapter_runs.output is ≤ 64 KiB in all). */
export const STEP_OUTPUT_CAP = 64 * 1024;
/** stdout kept for the parsers (a JSON listing of a few hundred plugins). */
export const STEP_STDOUT_CAP = 2 * 1024 * 1024;
const KILL_WAIT_MS = 30_000;
const LOGS_TIMEOUT_MS = 60_000;

export interface ToolsRunOptions {
  timeoutMs: number;
  /** Network to connect before start (account database network); skipped when it does not exist. */
  extraNetwork?: string | null;
  log?: (line: string) => void;
}

/**
 * Splits a non-TTY Docker log buffer (8-byte frame headers: stream, 0, 0, 0,
 * size BE) into stdout / stderr / combined collectors. A buffer that does not
 * look multiplexed is taken as stdout.
 */
export function demuxLogs(buf: Buffer, sinks: { stdout: CappedCollector; stderr: CappedCollector; combined: CappedCollector }): void {
  const looksMuxed = buf.length >= 8 && (buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!looksMuxed) {
    if (buf.length) {
      sinks.stdout.write(buf);
      sinks.combined.write(buf);
    }
    return;
  }
  let off = 0;
  while (off + 8 <= buf.length) {
    const stream = buf[off];
    const size = buf.readUInt32BE(off + 4);
    const start = off + 8;
    const end = Math.min(buf.length, start + size);
    const chunk = buf.subarray(start, end);
    if (stream === 2) sinks.stderr.write(chunk);
    else sinks.stdout.write(chunk);
    sinks.combined.write(chunk);
    off = end;
  }
}

function collectorText(c: CappedCollector): string {
  // CappedCollector appends a "[truncated]" marker; the parsers want the raw head.
  return c.truncated ? c.text().replace(/\n…\[truncated\]$/, '') : c.text();
}

async function readLogs(container: Docker.Container): Promise<{ stdout: string; stderr: string; output: string; truncated: boolean }> {
  const stdout = new CappedCollector(STEP_STDOUT_CAP);
  const stderr = new CappedCollector(STEP_OUTPUT_CAP);
  const combined = new CappedCollector(STEP_OUTPUT_CAP);
  const raw = await withTimeout(container.logs({ stdout: true, stderr: true, follow: false }) as unknown as Promise<Buffer | string>, LOGS_TIMEOUT_MS, 'tools logs');
  demuxLogs(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8'), { stdout, stderr, combined });
  return { stdout: collectorText(stdout), stderr: collectorText(stderr), output: collectorText(combined), truncated: combined.truncated };
}

/** Image of the step present locally, pulled otherwise (502 toolsImageMissing). */
export async function ensureToolsImage(docker: Docker, image: string, log?: (line: string) => void): Promise<void> {
  if (await imageExists(docker, image)) return;
  try {
    await pullImage(docker, image);
    log?.(`image ${image} téléchargée`);
  } catch (err) {
    logger.warn({ image, err: errText(err) }, 'Adapters: tools image pull failed');
    throw new AppError(502, `Image d'outils indisponible : ${image} (${errText(err)})`, 'toolsImageMissing', { image });
  }
}

/** Runs one step: create → start → wait (timeout → kill) → logs → remove. */
export async function runToolsContainer(docker: Docker, spec: Docker.ContainerCreateOptions, opts: ToolsRunOptions): Promise<ToolsStepResult> {
  const name = spec.name!;
  await ensureToolsImage(docker, spec.Image!, opts.log);
  await removeContainer(docker, name); // leftover of an interrupted run with the same name
  try {
    await createContainer(docker, spec);
    if (opts.extraNetwork) {
      try {
        if (await inspectNetwork(docker, opts.extraNetwork)) await connectNetwork(docker, opts.extraNetwork, name);
      } catch (err) {
        // No database network (no instance yet): the CLI still reaches the sockets.
        opts.log?.(`réseau ${opts.extraNetwork} non rattaché : ${errText(err)}`);
      }
    }
    const container = docker.getContainer(name);
    await startContainer(docker, name);

    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;
    const waited = container.wait() as Promise<{ StatusCode?: number }>;
    let status: { StatusCode?: number } | null = await new Promise<{ StatusCode?: number } | null>((resolve, reject) => {
      timer = setTimeout(() => resolve(null), Math.max(1000, opts.timeoutMs));
      waited.then(resolve, reject);
    }).finally(() => { if (timer) clearTimeout(timer); });

    if (status === null) {
      timedOut = true;
      opts.log?.(`délai de ${Math.round(opts.timeoutMs / 60_000)} min dépassé : arrêt forcé`);
      try {
        await withTimeout(container.kill({ signal: 'SIGKILL' }), KILL_WAIT_MS, `kill ${name}`);
      } catch (err) {
        if (!isNotFound(err) && !/is not running/i.test(errText(err))) logger.warn({ name, err: errText(err) }, 'Adapters: kill failed');
      }
      status = await withTimeout(waited, KILL_WAIT_MS, `wait ${name}`).catch(() => null);
    }

    const exitCode = typeof status?.StatusCode === 'number' ? status.StatusCode : null;
    let logs = { stdout: '', stderr: '', output: '', truncated: false };
    try {
      logs = await readLogs(container);
    } catch (err) {
      // `output` is shown to client users (A6): the daemon's message stays in the server log.
      logger.warn({ name, err: errText(err) }, 'Adapters: tools container logs unreadable');
      logs.output = '(journal du conteneur illisible)';
    }
    return {
      ok: !timedOut && exitCode === 0,
      exitCode,
      output: logs.output,
      outputTruncated: logs.truncated,
      timedOut,
      stdout: logs.stdout,
      stderr: logs.stderr,
    };
  } finally {
    try {
      await removeContainer(docker, name);
    } catch (err) {
      logger.warn({ name, err: errText(err) }, 'Adapters: tools container not removed (removed at the next recovery)');
    }
  }
}

/** Removes every tools container (label oblimint.role=tools), except the runs in `keep`. Returns the number removed. */
export async function removeToolsContainers(docker: Docker, keep: ReadonlySet<number> = new Set(), onlyRun?: number): Promise<number> {
  const label = onlyRun !== undefined ? `${P3_LABELS.adapterRun}=${onlyRun}` : `${LABELS.role}=tools`;
  const list = await listByLabel(docker, label);
  let removed = 0;
  for (const c of list) {
    if (c.Labels?.[LABELS.role] !== 'tools') continue;
    const runId = Number(c.Labels?.[P3_LABELS.adapterRun]);
    if (Number.isInteger(runId) && keep.has(runId)) continue;
    const name = (c.Names?.[0] ?? c.Id).replace(/^\//, '');
    await removeContainer(docker, name);
    removed++;
  }
  return removed;
}
