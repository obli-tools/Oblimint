import type Docker from 'dockerode';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import {
  cleanName, inspectContainer, inspectNetwork, isStaticIpRefused, setEndpointAddressResolver, type EndpointAddressRequest,
} from '../docker/dockerOps';
import { localNodeId, nodeOfEngine } from '../docker/engine';
import { errText, selfContainerRef, withTimeout } from '../setup/docker';
import { addressAt, isEphemeralContainer, isManagedNetwork, poolOffsets, sameIdentity, slotFor, slotUsable } from './addressLayout';
import { addressFor, adoptAddress, layoutFromInspect } from './addresses';
import { endpointIpv4 } from './ipv4';

// ─────────────────────────────────────────────────────────────────────────────
// Address resolver of dockerOps (migration 031): every creation / connection
// of a container on a MANAGED network (account fabrics, platform networks) is
// given its allocated address (network/addresses.ts) as a static one
// (IPAMConfig), so the rules hostd persists stay right across reboots.
//
//   - normal mode: the allocation table (DB); an allocation failure fails the
//     creation / connection (the caller's next pass retries);
//   - setup wizard before the database exists: the fixed slot computed from
//     the network's subnet (panel .2, PostgreSQL .3…); the rows are adopted at
//     the first normal boot (pinning.ts).
//
// Docker ≤ 28 refuses static addresses on a network whose subnet it chose
// itself (verified on 24 – 28; 29 accepts): support is known from the network
// (created by the panel with an explicit subnet: omf<id> / omb<id> / omp-*
// bridges), the Docker version (≥ 29), a probe (a never-started container
// connected with an address, then removed) or the last answer, cached per
// network id and stored in network_subnets.static_ip. A creation only gets an
// address on a 'supported' network (Docker 24 accepts the create and refuses
// the START); a connection also on an 'unknown' one (a refusal there is
// retried without address by connectNetwork, and marks the network refused).
// ─────────────────────────────────────────────────────────────────────────────

export type StaticSupport = 'supported' | 'refused' | 'unknown';

const CACHE_MS = 2_000;
const CALL_TIMEOUT_MS = 30_000;

interface Cached<T> { at: number; value: Promise<T> }

const netCache = new WeakMap<object, Map<string, Cached<Docker.NetworkInspectInfo | null>>>();
const holdersCache = new WeakMap<object, Cached<Map<string, Map<string, string>>>>();
const versionCache = new WeakMap<object, Promise<number | null>>();
const panelNameCache = new WeakMap<object, Promise<string | null>>();
/** Support by Docker network id (a recreated network gets a new id → asked again). */
const supportCache = new Map<string, StaticSupport>();

function cached<T>(entry: Cached<T> | undefined, load: () => Promise<T>, set: (c: Cached<T>) => void): Promise<T> {
  if (entry && Date.now() - entry.at < CACHE_MS) return entry.value;
  const value = load();
  set({ at: Date.now(), value });
  value.catch(() => set({ at: 0, value }));
  return value;
}

/** Network inspection cached 2 s (several containers created in a row). */
export function inspectNetworkCached(docker: Docker, network: string): Promise<Docker.NetworkInspectInfo | null> {
  let m = netCache.get(docker);
  if (!m) { m = new Map(); netCache.set(docker, m); }
  const map = m;
  return cached(map.get(network), () => inspectNetwork(docker, network), (c) => map.set(network, c));
}

/** Drops the cached inspections (after a network change made by the panel). */
export function invalidateNetworkCache(docker: Docker, network?: string): void {
  if (network) netCache.get(docker)?.delete(network);
  else netCache.delete(docker);
  holdersCache.delete(docker);
}

/**
 * Static addresses (IPAMConfig) of every container, stopped ones included, by
 * network → ip → container name: Docker does not reserve the static address of
 * a STOPPED container, the panel must not hand it out again.
 */
export function staticHolders(docker: Docker): Promise<Map<string, Map<string, string>>> {
  return cached(holdersCache.get(docker), async () => {
    const list = await withTimeout(docker.listContainers({ all: true }), CALL_TIMEOUT_MS, 'list containers');
    const out = new Map<string, Map<string, string>>();
    for (const c of list) {
      const name = cleanName(c.Names?.[0]);
      for (const [net, ep] of Object.entries(c.NetworkSettings?.Networks ?? {})) {
        const ip = endpointIpv4((ep as { IPAMConfig?: { IPv4Address?: string } | null }).IPAMConfig?.IPv4Address);
        if (!ip) continue;
        let m = out.get(net);
        if (!m) { m = new Map(); out.set(net, m); }
        m.set(ip, name);
      }
    }
    return out;
  }, (c) => holdersCache.set(docker, c));
}

/** Major version of the Docker Engine (null when unknown). */
export function dockerMajorVersion(docker: Docker): Promise<number | null> {
  let p = versionCache.get(docker);
  if (!p) {
    p = withTimeout(docker.version(), CALL_TIMEOUT_MS, 'docker version')
      .then((v) => { const m = /^(\d+)\./.exec(String((v as { Version?: string }).Version ?? '')); return m ? Number(m[1]) : null; })
      .catch((err) => { logger.debug({ err: errText(err) }, 'addresses: Docker version unknown'); versionCache.delete(docker); return null; });
    versionCache.set(docker, p);
  }
  return p;
}

/** Inspected name of the panel container (null outside a container). */
export function panelContainerName(docker: Docker): Promise<string | null> {
  let p = panelNameCache.get(docker);
  if (!p) {
    const ref = selfContainerRef();
    p = ref
      ? inspectContainer(docker, ref).then((i) => (i ? cleanName(i.Name) : null)).catch(() => { panelNameCache.delete(docker); return null; })
      : Promise.resolve(null);
    panelNameCache.set(docker, p);
  }
  return p;
}

/** Bridges of the networks the panel creates with an explicit subnet (fabric.ts, platformNet.ts). */
const PANEL_BRIDGE_RE = /^om[fb]\d{1,10}$|^omp-[a-z0-9-]{1,11}$/;

/** Created by the panel with an explicit subnet (static addresses accepted by every Docker version)? */
export function createdWithExplicitSubnet(net: Docker.NetworkInspectInfo): boolean {
  const layout = layoutFromInspect(net);
  if (!layout) return false;
  // An IPRange can only be set together with an explicit subnet (docker network create --ip-range needs --subnet).
  if (layout.dynamic) return true;
  const bridge = (net.Options as Record<string, string> | undefined)?.['com.docker.network.bridge.name'];
  return !!bridge && PANEL_BRIDGE_RE.test(bridge);
}

function dbAvailable(): boolean {
  return Boolean(config.databaseUrl);
}

async function storedSupport(network: string): Promise<StaticSupport> {
  if (!dbAvailable()) return 'unknown';
  try {
    const { db } = await import('../../db');
    const row = await db('network_subnets').where({ network_name: network }).first('static_ip') as { static_ip?: StaticSupport } | undefined;
    return row?.static_ip ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Persists the support of a network (network_subnets row, when it has one). Never throws. */
export async function recordSupport(network: string, support: StaticSupport, netId?: string): Promise<void> {
  if (netId) supportCache.set(netId, support);
  if (!dbAvailable() || support === 'unknown') return;
  try {
    const { db } = await import('../../db');
    await db('network_subnets').where({ network_name: network }).whereNot('static_ip', support).update({ static_ip: support });
  } catch (err) {
    logger.debug({ err: errText(err), network }, 'addresses: static address support not recorded');
  }
}

let probeSeq = 0;
/** Probe containers in flight in this process (a leftover of a crashed process is removed by the sweep). */
const probesInFlight = new Set<string>();

/** Is a probe container one this process is running now? */
export function isProbeInFlight(name: string): boolean {
  return probesInFlight.has(name);
}

/** Image of the probe container: the panel's own (always present). null outside a container. */
async function probeImage(docker: Docker): Promise<string | null> {
  const ref = selfContainerRef();
  if (!ref) return null;
  const info = await inspectContainer(docker, ref).catch(() => null);
  return info?.Image ?? null;
}

/**
 * Does Docker accept a static address on `net`? A container is created on it
 * (never started), reconnected with an address, removed. No effect on the
 * traffic. 'unknown' when it cannot run (no image, Docker error).
 */
export async function probeStaticIp(docker: Docker, net: Docker.NetworkInspectInfo): Promise<StaticSupport> {
  const layout = layoutFromInspect(net);
  const image = await probeImage(docker);
  if (!layout || !image) return 'unknown';
  const running = new Set(Object.values(net.Containers ?? {}).map((c) => endpointIpv4((c as { IPv4Address?: string }).IPv4Address)).filter(Boolean));
  let candidate: string | null = null;
  for (const off of poolOffsets(layout)) {
    const ip = addressAt(layout, off);
    if (!running.has(ip)) candidate = ip; // the highest free one (never started: nothing is allocated anyway)
  }
  if (!candidate) return 'unknown';
  const name = `oblimint-ipprobe-${process.pid}-${++probeSeq}`;
  probesInFlight.add(name);
  try {
    const c = await withTimeout(docker.createContainer({
      name, Image: image, Entrypoint: ['true'], Cmd: [], Labels: { 'oblimint.internal': 'true', 'oblimint.role': 'ipprobe' },
      HostConfig: { NetworkMode: net.Name, RestartPolicy: { Name: 'no' } },
    }), CALL_TIMEOUT_MS, `create ${name}`);
    const n = docker.getNetwork(net.Name);
    await withTimeout(n.disconnect({ Container: c.id, Force: true }), CALL_TIMEOUT_MS, `disconnect ${name}`);
    try {
      await withTimeout(n.connect({ Container: c.id, EndpointConfig: { IPAMConfig: { IPv4Address: candidate } } }), CALL_TIMEOUT_MS, `connect ${name}`);
      return 'supported';
    } catch (err) {
      if (isStaticIpRefused(err)) return 'refused';
      logger.warn({ network: net.Name, err: errText(err) }, 'addresses: static address probe inconclusive');
      return 'unknown';
    }
  } catch (err) {
    logger.warn({ network: net.Name, err: errText(err) }, 'addresses: static address probe failed');
    return 'unknown';
  } finally {
    await withTimeout(docker.getContainer(name).remove({ force: true }), CALL_TIMEOUT_MS, `remove ${name}`).catch(() => undefined);
    probesInFlight.delete(name);
  }
}

/** Static address support of a network (cached per network id). `probe` runs the probe when nothing else tells. */
export async function staticSupportOf(docker: Docker, net: Docker.NetworkInspectInfo, opts: { probe?: boolean } = {}): Promise<StaticSupport> {
  const known = supportCache.get(net.Id);
  if (known && known !== 'unknown') return known;
  let support: StaticSupport = 'unknown';
  if (createdWithExplicitSubnet(net)) support = 'supported';
  else if (((await dockerMajorVersion(docker)) ?? 0) >= 29) support = 'supported';
  else {
    support = await storedSupport(net.Name);
    // A stored 'refused' is asked again once per process (Docker may have been updated since).
    if ((support === 'unknown' || (support === 'refused' && !known)) && opts.probe) support = await probeStaticIp(docker, net);
  }
  if (support !== 'unknown') await recordSupport(net.Name, support, net.Id);
  return support;
}

/** Docker refused a static address on that network (connectNetwork / pinEndpoint). */
export function markRefused(docker: Docker, network: string): void {
  void inspectNetworkCached(docker, network)
    .then((net) => recordSupport(network, 'refused', net?.Id))
    .catch(() => undefined);
}

/** IPs held on `network` → container name: running endpoints + static addresses of stopped containers. */
export async function addressesInUse(docker: Docker, net: Docker.NetworkInspectInfo): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [ip, name] of (await staticHolders(docker)).get(net.Name) ?? []) out.set(ip, name);
  for (const c of Object.values(net.Containers ?? {})) {
    const ip = endpointIpv4((c as { IPv4Address?: string }).IPv4Address);
    if (ip) out.set(ip, String((c as { Name?: string }).Name ?? ''));
  }
  return out;
}

/** The resolver of dockerOps (see the header). */
export async function resolveEndpointAddress(req: EndpointAddressRequest): Promise<string | null> {
  const { docker, network } = req;
  if (!isManagedNetwork(network)) return null;
  let name = req.container;
  /** Address the container has now on that network (a reconnection keeps it). */
  let current: string | null = null;
  if (req.phase === 'connect') {
    const info = await inspectContainer(docker, req.container);
    if (!info) return null; // the connection answers 404 itself
    name = cleanName(info.Name) || req.container;
    const ep = info.NetworkSettings?.Networks?.[network] as { IPAMConfig?: { IPv4Address?: string } | null; IPAddress?: string } | undefined;
    // Already there: connectNetwork answers "already attached" (no allocation for nothing).
    if (ep && !req.reconnect) return null;
    if (ep) current = endpointIpv4(ep.IPAMConfig?.IPv4Address) ?? (info.State?.Running ? endpointIpv4(ep.IPAddress) : null);
  }
  if (!name || isEphemeralContainer(name)) return null;
  const net = await inspectNetworkCached(docker, network);
  if (!net) return null; // the creation / connection answers 404 itself
  const layout = layoutFromInspect(net);
  if (!layout) return null; // no IPv4 subnet, or too small to manage (> /26)
  const support = await staticSupportOf(docker, net, { probe: true });
  if (support === 'refused' || (support === 'unknown' && req.phase === 'create')) return null;
  const [inUse, panelName] = await Promise.all([addressesInUse(docker, net), panelContainerName(docker)]);
  const cfg = (net.IPAM?.Config ?? []).find((c) => c?.Subnet === `${addressAt(layout, 0)}/${layout.cidr.bits}`) ?? net.IPAM?.Config?.[0];
  const setupSlot = (): string | null => {
    // No fixed low slot on a network without IPRange (addresses.ts: Docker's allocator restarts from the bottom).
    const slot = layout.dynamic ? slotFor(name, panelName) : null;
    if (!slot || !slotUsable(layout, slot.offset)) return null;
    const ip = addressAt(layout, slot.offset);
    const holder = inUse.get(ip);
    return !holder || sameIdentity(holder, name) ? ip : null;
  };
  if (!dbAvailable()) return current ?? setupSlot();
  try {
    const nodeId = nodeOfEngine(docker) ?? await localNodeId();
    if (current) {
      // Reconnection: the address the rules in force name is kept (recorded as the allocation) unless it is another's.
      let kept: Awaited<ReturnType<typeof adoptAddress>>;
      try {
        kept = await adoptAddress(nodeId, network, name, current, 'adopted');
      } catch (err) {
        // DB down for a moment: the container keeps the address it has (never reconnected dynamic: the rules in
        // force name that address — losing it is what the 2026-11-01 incident was). Recorded at the next sweep.
        logger.warn({ network, container: name, ip: current, err: errText(err) }, 'addresses: allocation table unreachable, current address kept');
        return current;
      }
      if (kept.status !== 'conflict') return kept.ip;
    }
    return await addressFor(nodeId, network, name, {
      cidr: `${addressAt(layout, 0)}/${layout.cidr.bits}`,
      ipRange: (cfg as { IPRange?: string } | undefined)?.IPRange || null,
      gateway: layout.gateway,
      panelName,
      inUse,
    });
  } catch (err) {
    // The wizard runs before the panel database is fully there: the fixed slots still apply.
    if (config.mode === 'setup') return setupSlot();
    throw err;
  }
}

let installed = false;

/** Registers the resolver in dockerOps (index.ts, both modes). */
export function installAddressResolver(): void {
  if (installed) return;
  installed = true;
  setEndpointAddressResolver({ resolve: resolveEndpointAddress, refused: markRefused });
}

/** Tests: forget the caches. */
export function resetAddressResolverForTests(): void {
  supportCache.clear();
  installed = false;
  setEndpointAddressResolver(null);
}
