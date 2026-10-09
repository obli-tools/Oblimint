import type Docker from 'dockerode';
import { LABELS } from '../hosting/naming';
import { errText, withTimeout } from '../setup/docker';
import { logger } from '../../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Small idempotent Docker primitives shared by the reconcile, runtime, file
// server and infra services. Every call is bounded (a hung socket never hangs
// a pass) and "already in that state" answers (304 / 404 on remove / network
// already attached) are success.
// ─────────────────────────────────────────────────────────────────────────────

export type Log = (line: string) => void;

const CALL_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 15 * 60_000;

function statusOf(err: unknown): number | undefined {
  return (err as { statusCode?: number } | null)?.statusCode;
}

export function isNotFound(err: unknown): boolean {
  return statusOf(err) === 404 || /no such (container|image|network)|not found/i.test(errText(err));
}

/** Docker / hostd cannot be reached at all (socket missing, refused, timed out…). */
export function isUnreachable(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code && ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EACCES', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH'].includes(code)) return true;
  return /timed out|ECONNREFUSED|ENOENT|socket hang up/i.test(errText(err));
}

/** Leading slash removed (listContainers returns "/name"). */
export function cleanName(name: string | undefined): string {
  return (name ?? '').replace(/^\//, '');
}

export async function inspectContainer(docker: Docker, name: string): Promise<Docker.ContainerInspectInfo | null> {
  try {
    return await withTimeout(docker.getContainer(name).inspect(), CALL_TIMEOUT_MS, `inspect ${name}`);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function imageExists(docker: Docker, ref: string): Promise<boolean> {
  try {
    await withTimeout(docker.getImage(ref).inspect(), CALL_TIMEOUT_MS, `inspect image ${ref}`);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/** Pulls `ref` (one log line per layer status change, never the byte counters). */
export async function pullImage(docker: Docker, ref: string, log?: Log): Promise<void> {
  log?.(`Pulling ${ref}…`);
  const stream = await withTimeout(docker.pull(ref), 60_000, `pull ${ref}`) as NodeJS.ReadableStream;
  const lastStatus = new Map<string, string>();
  let streamError: string | null = null;
  await withTimeout(new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null) => (err ? reject(err) : streamError ? reject(new Error(streamError)) : resolve()),
      (ev: { id?: string; status?: string; error?: string }) => {
        if (ev.error) { streamError = ev.error; log?.(`pull: ${ev.error}`); return; }
        if (!ev.status || !log) return;
        const key = ev.id ?? '';
        if (lastStatus.get(key) === ev.status) return;
        lastStatus.set(key, ev.status);
        log(ev.id ? `${ev.id}: ${ev.status}` : ev.status);
      },
    );
  }), PULL_TIMEOUT_MS, `pull ${ref}`);
  log?.(`${ref} pulled`);
}

/** Pulls `ref` when it is not present locally. Returns true when a pull happened. */
export async function ensureImage(docker: Docker, ref: string, log?: Log): Promise<boolean> {
  if (await imageExists(docker, ref)) return false;
  await pullImage(docker, ref, log);
  return true;
}

export async function startContainer(docker: Docker, name: string): Promise<void> {
  try {
    await withTimeout(docker.getContainer(name).start(), CALL_TIMEOUT_MS, `start ${name}`);
  } catch (err) {
    if (statusOf(err) === 304) return; // already started
    throw err;
  }
}

export async function stopContainer(docker: Docker, name: string, graceSec = 10): Promise<void> {
  try {
    await withTimeout(docker.getContainer(name).stop({ t: graceSec }), CALL_TIMEOUT_MS + graceSec * 1000, `stop ${name}`);
  } catch (err) {
    if (statusOf(err) === 304 || isNotFound(err)) return; // already stopped / gone
    throw err;
  }
}

export async function removeContainer(docker: Docker, name: string): Promise<void> {
  try {
    await withTimeout(docker.getContainer(name).remove({ force: true }), 60_000, `remove ${name}`);
  } catch (err) {
    if (isNotFound(err) || /removal of container .* is already in progress/i.test(errText(err))) return;
    throw err;
  }
}

export async function createContainer(docker: Docker, spec: Docker.ContainerCreateOptions): Promise<void> {
  await withTimeout(docker.createContainer(spec), CALL_TIMEOUT_MS, `create ${spec.name ?? spec.Image}`);
}

/** Removes any container of that name, creates it from `spec`, starts it when asked. */
export async function recreateContainer(docker: Docker, spec: Docker.ContainerCreateOptions, start: boolean): Promise<void> {
  const name = spec.name!;
  await removeContainer(docker, name);
  await createContainer(docker, spec);
  if (start) await startContainer(docker, name);
}

/** Containers carrying a label (all states). */
export async function listByLabel(docker: Docker, label: string): Promise<Docker.ContainerInfo[]> {
  return withTimeout(docker.listContainers({ all: true, filters: { label: [label] } }), CALL_TIMEOUT_MS, `list containers ${label}`);
}

export async function inspectNetwork(docker: Docker, name: string): Promise<Docker.NetworkInspectInfo | null> {
  try {
    return await withTimeout(docker.getNetwork(name).inspect(), CALL_TIMEOUT_MS, `inspect network ${name}`) as Docker.NetworkInspectInfo;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function createNetwork(docker: Docker, name: string, labels: Record<string, string>): Promise<void> {
  try {
    await withTimeout(docker.createNetwork({ Name: name, Driver: 'bridge', CheckDuplicate: true, Labels: labels }), CALL_TIMEOUT_MS, `create network ${name}`);
  } catch (err) {
    if (statusOf(err) === 409 || /already exists/i.test(errText(err))) return;
    throw err;
  }
}

/** Connects a container to a network (idempotent: "already attached" is success). */
export async function connectNetwork(docker: Docker, network: string, container: string, aliases?: string[]): Promise<boolean> {
  try {
    await withTimeout(docker.getNetwork(network).connect({
      Container: container,
      ...(aliases?.length ? { EndpointConfig: { Aliases: aliases } } : {}),
    }), CALL_TIMEOUT_MS, `connect ${container} to ${network}`);
    return true;
  } catch (err) {
    if (/already exists|already attached|endpoint with name .* already exists/i.test(errText(err))) return false;
    throw err;
  }
}

export async function disconnectNetwork(docker: Docker, network: string, container: string): Promise<void> {
  try {
    await withTimeout(docker.getNetwork(network).disconnect({ Container: container, Force: true }), CALL_TIMEOUT_MS, `disconnect ${container} from ${network}`);
  } catch (err) {
    if (isNotFound(err) || /is not connected/i.test(errText(err))) return;
    throw err;
  }
}

export async function removeNetwork(docker: Docker, name: string): Promise<void> {
  try {
    await withTimeout(docker.getNetwork(name).remove(), CALL_TIMEOUT_MS, `remove network ${name}`);
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
}

/** The hash label of an existing container. */
export function labelHash(labels: Record<string, string> | undefined): string | null {
  return labels?.[LABELS.specHash] ?? null;
}

/** Docker container state → our ContainerState vocabulary. */
export function containerState(state: string | undefined): 'running' | 'stopped' | 'restarting' | 'error' | 'unknown' {
  switch ((state ?? '').toLowerCase()) {
    case 'running': return 'running';
    case 'restarting': return 'restarting';
    case 'created':
    case 'exited':
    case 'paused':
      return 'stopped';
    case 'dead':
    case 'removing':
      return 'error';
    default: return 'unknown';
  }
}

/** Is this container endpoint carrying `alias` on the network (Aliases or DNSNames, Docker ≥ 25)? */
export function endpointHasAlias(endpoint: { Aliases?: string[] | null; DNSNames?: string[] | null } | undefined, alias: string): boolean {
  if (!endpoint) return false;
  return [...(endpoint.Aliases ?? []), ...(endpoint.DNSNames ?? [])].includes(alias);
}

export interface ReconnectOptions {
  /** Base delay between connect retries (ms, multiplied by the attempt number). */
  retryDelayMs?: number;
}

const RECONNECT_ATTEMPTS = 3;

/**
 * Disconnect + reconnect with `aliases`, never leaving the container
 * detached: the connect is retried, then (still failing) the container is
 * reconnected WITHOUT aliases so it at least keeps its network (the panel
 * on PANEL_NETWORK = PostgreSQL + edge; a detached panel would not even
 * boot far enough to repair itself). Throws the alias error afterwards.
 */
export async function reconnectWithAlias(
  docker: Docker, network: string, container: string, aliases: string[], log: Log, opts: ReconnectOptions = {},
): Promise<void> {
  const delay = opts.retryDelayMs ?? 1_000;
  await disconnectNetwork(docker, network, container);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt++) {
    try {
      await connectNetwork(docker, network, container, aliases);
      return;
    } catch (err) {
      lastErr = err;
      log(`reconnect ${container} to ${network} (alias ${aliases.join(',')}) failed, attempt ${attempt}/${RECONNECT_ATTEMPTS}: ${errText(err)}`);
      if (attempt < RECONNECT_ATTEMPTS && delay > 0) await new Promise((r) => setTimeout(r, delay * attempt));
    }
  }
  try {
    await connectNetwork(docker, network, container);
    logger.error({ network, container, err: errText(lastErr) }, `${container} reconnected to ${network} WITHOUT the alias ${aliases.join(',')}: the alias will be retried at the next boot / pass`);
    log(`${container} reconnected to ${network} without the alias (fallback)`);
  } catch (err) {
    logger.fatal({ network, container, err: errText(err) }, `${container} is DETACHED from ${network}: run \`docker network connect --alias ${aliases[0] ?? ''} ${network} ${container}\` by hand`);
    log(`${container} could not be reconnected to ${network}: ${errText(err)}`);
  }
  throw lastErr;
}

/** Restarts a container (bounded: grace period + call timeout). */
export async function restartContainer(docker: Docker, name: string, graceSec = 10): Promise<void> {
  await withTimeout(docker.getContainer(name).restart({ t: graceSec }), CALL_TIMEOUT_MS + graceSec * 1000, `restart ${name}`);
}

/**
 * Connects `container` to `network` with `alias`; when it is already there
 * without the alias, disconnects and reconnects it. Shared with the setup
 * wizard (attach step).
 */
export async function attachWithAlias(
  docker: Docker, network: string, container: string, alias: string, log: Log, opts: ReconnectOptions = {},
): Promise<'connected' | 'already' | 'reattached'> {
  const info = await inspectContainer(docker, container);
  const endpoint = info?.NetworkSettings?.Networks?.[network] as { Aliases?: string[] | null; DNSNames?: string[] | null } | undefined;
  if (endpoint && endpointHasAlias(endpoint, alias)) {
    log(`${cleanName(info?.Name) || container} already on ${network} (alias ${alias})`);
    return 'already';
  }
  if (endpoint) {
    log(`${cleanName(info?.Name) || container} is on ${network} without the alias ${alias}: reconnecting it`);
    await reconnectWithAlias(docker, network, container, [alias], log, opts);
    return 'reattached';
  }
  await connectNetwork(docker, network, container, [alias]);
  log(`${cleanName(info?.Name) || container} connected to ${network} (alias ${alias})`);
  return 'connected';
}
