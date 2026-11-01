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

// ── fixed addresses of the managed networks (network/addresses.ts, migration 031) ──

export interface EndpointAddressRequest {
  docker: Docker;
  network: string;
  /** Container name (create) or reference (connect: name or id, the resolver inspects it). */
  container: string;
  phase: 'create' | 'connect';
  /** connect: the container is disconnected first (reconnectWithAlias): its CURRENT address is kept when possible. */
  reconnect?: boolean;
}

/**
 * Decides the IPv4 a container gets on a network (network/addressResolver.ts):
 * null = not a managed network / Docker would refuse it / an ephemeral
 * container (Docker chooses). Throws when the address cannot be allocated
 * (DB down, pool exhausted): the creation / connection then FAILS (retried by
 * the caller's next pass), never silently dynamic.
 */
export interface EndpointAddressResolver {
  resolve(req: EndpointAddressRequest): Promise<string | null>;
  /** Docker refused a static address on that network (Docker ≤ 28 + subnet chosen by Docker). */
  refused?(docker: Docker, network: string): void;
}

let addressResolver: EndpointAddressResolver | null = null;

/** Registered at boot by the network module (both modes); null in the unit tests (Docker chooses). */
export function setEndpointAddressResolver(r: EndpointAddressResolver | null): void {
  addressResolver = r;
}

export function endpointAddressResolver(): EndpointAddressResolver | null {
  return addressResolver;
}

/** Docker ≤ 28 refuses a static address on a network whose subnet it chose itself. */
export function isStaticIpRefused(err: unknown): boolean {
  return /user specified IP address is supported only|user specified IP address is supported on user defined networks only/i.test(errText(err));
}

/** The requested static address is held by another endpoint. */
export function isAddressInUse(err: unknown): boolean {
  return /address already in use|already allocated|Address in use/i.test(errText(err));
}

const NON_NETWORK_MODES = new Set(['', 'default', 'bridge', 'host', 'none']);

/** Networks a creation spec joins (NetworkMode + EndpointsConfig keys), container:<x> / host / none excluded. */
export function specNetworks(spec: Docker.ContainerCreateOptions): string[] {
  const out: string[] = [];
  const mode = String(spec.HostConfig?.NetworkMode ?? '');
  if (!NON_NETWORK_MODES.has(mode) && !mode.startsWith('container:')) out.push(mode);
  for (const n of Object.keys(spec.NetworkingConfig?.EndpointsConfig ?? {})) if (!out.includes(n) && !NON_NETWORK_MODES.has(n)) out.push(n);
  return out;
}

/**
 * `spec` with IPAMConfig.IPv4Address set on every network the resolver manages
 * (a copy: the caller's spec — and its spec hash, computed before — is left
 * untouched). An address already given by the caller wins.
 */
export async function withEndpointAddresses(docker: Docker, spec: Docker.ContainerCreateOptions): Promise<Docker.ContainerCreateOptions> {
  const r = addressResolver;
  if (!r || !spec.name) return spec;
  let out: Docker.ContainerCreateOptions | null = null;
  for (const network of specNetworks(spec)) {
    const current = spec.NetworkingConfig?.EndpointsConfig?.[network];
    if (current?.IPAMConfig?.IPv4Address) continue;
    const ip = await r.resolve({ docker, network, container: spec.name, phase: 'create' });
    if (!ip) continue;
    out ??= { ...spec, NetworkingConfig: { ...(spec.NetworkingConfig ?? {}), EndpointsConfig: { ...(spec.NetworkingConfig?.EndpointsConfig ?? {}) } } };
    const eps = out.NetworkingConfig!.EndpointsConfig!;
    eps[network] = { ...(current ?? {}), IPAMConfig: { ...(current?.IPAMConfig ?? {}), IPv4Address: ip } };
  }
  return out ?? spec;
}

export async function createContainer(docker: Docker, spec: Docker.ContainerCreateOptions): Promise<void> {
  const prepared = await withEndpointAddresses(docker, spec);
  await withTimeout(docker.createContainer(prepared), CALL_TIMEOUT_MS, `create ${spec.name ?? spec.Image}`);
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

/**
 * P4b (docs/P4b-PLAN.md §4): explicit IPv4 subnet (panel pools — Docker's
 * default pools hold ~30 networks only), bridge interface name (hostd filters
 * the frames bridged inside the account fabrics by bridge name), internal flag.
 */
export interface NetworkCreateOptions {
  subnet?: string | null;
  gateway?: string | null;
  /** com.docker.network.bridge.name (≤ 15 chars). */
  bridgeName?: string | null;
  internal?: boolean;
  /** Extra bridge driver options (feature B: com.docker.network.bridge.inhibit_ipv4 on a preview's private network). */
  driverOptions?: Record<string, string>;
  /** Extra labels merged over `labels`. */
  labels?: Record<string, string>;
  /** Docker's dynamic range inside `subnet` (IPAM IPRange): connections without an address stay there. */
  ipRange?: string | null;
}

export async function createNetwork(docker: Docker, name: string, labels: Record<string, string>, opts: NetworkCreateOptions = {}): Promise<void> {
  try {
    const spec: Docker.NetworkCreateOptions = { Name: name, Driver: 'bridge', CheckDuplicate: true, Labels: { ...labels, ...(opts.labels ?? {}) } };
    if (opts.subnet) {
      spec.IPAM = {
        Driver: 'default',
        Config: [{ Subnet: opts.subnet, ...(opts.gateway ? { Gateway: opts.gateway } : {}), ...(opts.ipRange ? { IPRange: opts.ipRange } : {}) }],
      };
    }
    if (opts.bridgeName || opts.driverOptions) {
      spec.Options = { ...(opts.driverOptions ?? {}), ...(opts.bridgeName ? { 'com.docker.network.bridge.name': opts.bridgeName } : {}) };
    }
    if (opts.internal) spec.Internal = true;
    await withTimeout(docker.createNetwork(spec), CALL_TIMEOUT_MS, `create network ${name}`);
  } catch (err) {
    if (statusOf(err) === 409 || /already exists/i.test(errText(err))) return;
    throw err;
  }
}

export interface ConnectOptions {
  /** Static IPv4 to request (null = none); absent = the address resolver decides. */
  ipv4?: string | null;
}

function isAlreadyConnected(err: unknown): boolean {
  return /already exists|already attached|endpoint with name .* already exists/i.test(errText(err));
}

async function rawConnect(docker: Docker, network: string, container: string, aliases: string[] | undefined, ipv4: string | null): Promise<void> {
  const ep: Docker.EndpointSettings = {};
  if (aliases?.length) ep.Aliases = aliases;
  if (ipv4) ep.IPAMConfig = { IPv4Address: ipv4 };
  await withTimeout(docker.getNetwork(network).connect({
    Container: container,
    ...(Object.keys(ep).length ? { EndpointConfig: ep } : {}),
  }), CALL_TIMEOUT_MS, `connect ${container} to ${network}`);
}

/**
 * Connects a container to a network (idempotent: "already attached" is
 * success). On a managed network the resolver's address is requested; when
 * Docker refuses static addresses there (Docker ≤ 28, subnet chosen by
 * Docker) the connection is retried without one (the network is reported).
 */
export async function connectNetwork(docker: Docker, network: string, container: string, aliases?: string[], opts: ConnectOptions = {}): Promise<boolean> {
  const ipv4 = opts.ipv4 !== undefined ? opts.ipv4 : addressResolver ? await addressResolver.resolve({ docker, network, container, phase: 'connect' }) : null;
  try {
    await rawConnect(docker, network, container, aliases, ipv4);
    return true;
  } catch (err) {
    if (isAlreadyConnected(err)) return false;
    if (ipv4 && isStaticIpRefused(err)) {
      addressResolver?.refused?.(docker, network);
      logger.warn({ network, container, ip: ipv4 }, `Docker refuses static addresses on ${network}: ${container} connected with a dynamic one`);
      try {
        await rawConnect(docker, network, container, aliases, null);
        return true;
      } catch (err2) {
        if (isAlreadyConnected(err2)) return false;
        throw err2;
      }
    }
    if (ipv4 && isAddressInUse(err)) {
      throw Object.assign(
        new Error(`L'adresse ${ipv4} attribuée à ${container} sur ${network} est occupée par un autre conteneur (conflit d'adresse : Système → Réseau)`),
        { statusCode: 409 },
      );
    }
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
  /** Static IPv4 to request (null = none); absent = the address resolver decides. */
  ipv4?: string | null;
}

const RECONNECT_ATTEMPTS = 3;

/** IPv4 a container has on a network now: its static one (IPAMConfig), else the one it runs with. Null when none. */
export async function currentEndpointIpv4(docker: Docker, network: string, container: string): Promise<string | null> {
  const info = await inspectContainer(docker, container);
  const ep = info?.NetworkSettings?.Networks?.[network] as { IPAMConfig?: { IPv4Address?: string } | null; IPAddress?: string } | undefined;
  if (!ep) return null;
  const pick = (v: string | undefined | null) => (v && /^\d{1,3}(\.\d{1,3}){3}$/.test(v.split('/')[0]) ? v.split('/')[0] : null);
  return pick(ep.IPAMConfig?.IPv4Address) ?? (info?.State?.Running ? pick(ep.IPAddress) : null);
}

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
  // The address is resolved BEFORE the disconnection (the resolver may need the DB / Docker).
  let ipv4: string | null = null;
  if (opts.ipv4 !== undefined) ipv4 = opts.ipv4;
  else if (addressResolver) {
    try {
      ipv4 = await addressResolver.resolve({ docker, network, container, phase: 'connect', reconnect: true });
    } catch (err) {
      // Resolver down (DB, Docker timeout): the endpoint keeps the address it has now — its static one, else the
      // one it runs with. Reconnecting it dynamic would move it away from the address the rules in force name.
      ipv4 = await currentEndpointIpv4(docker, network, container).catch(() => null);
      log(`no fixed address for ${container} on ${network} (${errText(err)}): ${ipv4 ? `current address ${ipv4} kept` : 'reconnected with a dynamic one'}`);
    }
  }
  await disconnectNetwork(docker, network, container);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt++) {
    try {
      await connectNetwork(docker, network, container, aliases, { ipv4 });
      return;
    } catch (err) {
      lastErr = err;
      log(`reconnect ${container} to ${network} (alias ${aliases.join(',')}${ipv4 ? `, address ${ipv4}` : ''}) failed, attempt ${attempt}/${RECONNECT_ATTEMPTS}: ${errText(err)}`);
      if (attempt < RECONNECT_ATTEMPTS && delay > 0) await new Promise((r) => setTimeout(r, delay * attempt));
    }
  }
  // Fallbacks, never detached: the address without the alias, then neither.
  const fallbacks: Array<{ ipv4: string | null; what: string }> = [
    ...(ipv4 ? [{ ipv4, what: `WITHOUT the alias ${aliases.join(',')} (address ${ipv4} kept)` }] : []),
    { ipv4: null, what: `WITHOUT the alias ${aliases.join(',')}${ipv4 ? ' nor its fixed address' : ''}` },
  ];
  for (const fb of fallbacks) {
    let connected = false;
    try {
      await connectNetwork(docker, network, container, undefined, { ipv4: fb.ipv4 });
      connected = true;
    } catch (err) {
      log(`fallback reconnection of ${container} to ${network} failed: ${errText(err)}`);
    }
    if (connected) {
      logger.error({ network, container, err: errText(lastErr) }, `${container} reconnected to ${network} ${fb.what}: retried at the next boot / pass`);
      log(`${container} reconnected to ${network} ${fb.what} (fallback)`);
      throw lastErr;
    }
  }
  logger.fatal({ network, container }, `${container} is DETACHED from ${network}: run \`docker network connect --alias ${aliases[0] ?? ''} ${network} ${container}\` by hand`);
  log(`${container} could not be reconnected to ${network}`);
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

/** Aliases worth keeping on an endpoint: not the container id / name Docker adds by itself. */
export function userAliases(aliases: readonly string[] | null | undefined, id: string, name: string): string[] {
  const shortId = id.slice(0, 12);
  return [...new Set((aliases ?? []).filter((a) => a && a !== shortId && !id.startsWith(a) && a !== name))];
}

export type PinOutcome = 'already' | 'pinned' | 'connected';

/**
 * Gives a container the static address `ip` on `network` without recreating
 * it: disconnect, then connect with IPAMConfig (≈ 250 ms blip on a running
 * container, its TCP connections survive; nothing for a stopped one). The
 * aliases are read from the endpoint (or given). Never leaves the container
 * detached: when the static connect keeps failing (3 attempts; at once when
 * Docker refuses static addresses or the address is taken) it is reconnected
 * WITHOUT the address (Docker ≤ 28 leaves a refused connect detached), then
 * the error is thrown.
 */
export async function pinEndpoint(
  docker: Docker, network: string, container: string, ip: string, opts: { aliases?: string[]; retryDelayMs?: number; log?: Log } = {},
): Promise<PinOutcome> {
  const log = opts.log ?? (() => undefined);
  const info = await inspectContainer(docker, container);
  if (!info) throw Object.assign(new Error(`No such container: ${container}`), { statusCode: 404 });
  const name = cleanName(info.Name) || container;
  const ep = info.NetworkSettings?.Networks?.[network] as { Aliases?: string[] | null; IPAMConfig?: { IPv4Address?: string } | null } | undefined;
  if (ep?.IPAMConfig?.IPv4Address === ip) return 'already';
  const aliases = opts.aliases ?? userAliases(ep?.Aliases, info.Id, name);
  const delay = opts.retryDelayMs ?? 500;
  if (ep) await disconnectNetwork(docker, network, info.Id);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt++) {
    try {
      await rawConnect(docker, network, info.Id, aliases, ip);
      log(`${name} pinned to ${ip} on ${network}`);
      return ep ? 'pinned' : 'connected';
    } catch (err) {
      // Raced with another connection: the next sweep checks which address it holds.
      if (isAlreadyConnected(err)) return 'connected';
      lastErr = err;
      log(`pin ${name} to ${ip} on ${network} failed, attempt ${attempt}/${RECONNECT_ATTEMPTS}: ${errText(err)}`);
      if (isStaticIpRefused(err)) { addressResolver?.refused?.(docker, network); break; }
      if (isAddressInUse(err)) break;
      if (attempt < RECONNECT_ATTEMPTS && delay > 0) await new Promise((r) => setTimeout(r, delay * attempt));
    }
  }
  if (ep) {
    for (const a of [aliases, undefined]) {
      let connected = false;
      try {
        await rawConnect(docker, network, info.Id, a, null);
        connected = true;
      } catch (err) {
        if (isAlreadyConnected(err)) connected = true;
      }
      if (connected) {
        logger.warn({ network, container: name, ip, err: errText(lastErr) }, `${name} reconnected to ${network} WITHOUT its fixed address ${ip}`);
        throw lastErr;
      }
    }
    logger.fatal({ network, container: name }, `${name} is DETACHED from ${network}: run \`docker network connect ${network} ${name}\` by hand`);
  }
  throw lastErr;
}
