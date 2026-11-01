import type Docker from 'dockerode';
import type { NetworkAddressStatus } from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { cleanName, inspectContainer, isAddressInUse, pinEndpoint, startContainer, userAliases } from '../docker/dockerOps';
import { withAccountLock } from '../docker/locks';
import { LABELS } from '../hosting/naming';
import { platformSettings } from '../platformSettings';
import { errText, withTimeout } from '../setup/docker';
import {
  addressAt, fabricAccountId, isEphemeralContainer, isManagedNetwork, MANAGED_PLATFORM_NETWORKS, slotFor,
} from './addressLayout';
import { addressFor, addressIndex, adoptAddress, gcAddresses, layoutFromInspect, liveAddresses, releaseAddresses } from './addresses';
import {
  addressesInUse, inspectNetworkCached, invalidateNetworkCache, isProbeInFlight, panelContainerName, staticSupportOf, type StaticSupport,
} from './addressResolver';
import { listDockerSubnets, registerSubnet } from './allocator';
import { segmentBackends } from './deps';
import { endpointIpv4 } from './ipv4';
import { writeAddressSnapshot } from './snapshot';
import { requestPolicySync, withPolicyHold } from './sync';

// ─────────────────────────────────────────────────────────────────────────────
// Fixed addresses of the EXISTING containers (migration 031, docs: incident
// 2026-11-01). Idempotent, replayable, run by the segments worker at boot
// (before the first policy push) and every 5 min, and by the staff action
// « Pin the addresses now » (POST /system/network/pin):
//
//   1. adoption (DB only, no network effect): every endpoint of every managed
//      network gets a row with its CURRENT address (a stopped container: its
//      static address, else one from the pool) — the addresses do not change,
//      the rules in force stay valid: no open window;
//   2. support of static addresses per network (addressResolver: explicit
//      subnet / Docker ≥ 29 / probe) → network_subnets.static_ip; the platform
//      networks are registered there (pool 'platform');
//   3. pinning: an endpoint whose static address in Docker (IPAMConfig) is not
//      its allocation, on a 'supported' network, is re-pinned with the SAME
//      address (disconnect + connect --ip, ≈ 250 ms blip, TCP survives),
//      paced (one every 500 ms), the pushes held meanwhile, a tenant container
//      under its account lock. Order: PostgreSQL, edge, relay, dbadmin, pdns,
//      scanner, mail, webmail, auth, the panel, then the tenants. Settings →
//      Network addressPinning 'auto' (default): everything. 'manual' only
//      defers the RUNNING tenant containers of a fabric that has an IPRange:
//      a network without one is always pinned whole (a fixed address next to
//      dynamic ones is taken at the next daemon restart — alwaysPinned);
//   (2b) stolen addresses: a running managed container that holds the static
//      address of a stopped one is moved to its own allocation and the owner
//      started again (relocateIntruders);
//   4. GC of the rows of vanished containers / networks, snapshot rewritten.
//
// Networks where Docker refuses static addresses (Docker ≤ 28 + subnet chosen
// by Docker): rows 'observed' (they follow the observation: today's
// behaviour and its risk), reported in the status — update Docker to ≥ 29 or
// recreate the network (explicit subnet, same bridge name).
// ─────────────────────────────────────────────────────────────────────────────

const PIN_PACE_MS = 500;
const CALL_TIMEOUT_MS = 30_000;
const POSTGRES = 'oblimint-postgres';

/** Pin order of the platform containers (the panel after them, the tenants last). */
const PLATFORM_ORDER = [
  POSTGRES, 'oblimint-edge', 'oblimint-mail-relay', 'oblimint-phpmyadmin', 'oblimint-adminer', 'oblimint-pdns', 'oblimint-scanner',
  'oblimint-mail', 'oblimint-mail-rspamd', 'oblimint-mail-redis', 'oblimint-webmail', 'oblimint-auth-redis',
];

export interface ObservedEndpoint {
  network: string;
  container: string;
  id: string;
  running: boolean;
  /** Address now (running: Docker's; stopped: its static one, if any). */
  ip: string | null;
  /** Static address Docker holds for it (IPAMConfig). */
  staticIp: string | null;
  aliases: string[];
  /** An Oblimint container (label oblimint.internal, a platform slot or the panel): moved when it took another's address. */
  managed: boolean;
}

export interface ManagedObservation {
  networks: Map<string, Docker.NetworkInspectInfo>;
  support: Map<string, StaticSupport>;
  endpoints: ObservedEndpoint[];
  containerNames: Set<string>;
  networkNames: Set<string>;
  panelName: string | null;
  /** Probe containers (oblimint-ipprobe-*) present: the ones no probe of this process runs are leftovers. */
  probes: string[];
}

interface SweepState {
  lastSweepAt: Date | null;
  lastSweepError: string | null;
  conflicts: number;
}
const state: SweepState = { lastSweepAt: null, lastSweepError: null, conflicts: 0 };
let sweeping: Promise<SweepResult> | null = null;

/** Observes the managed networks (one network list, one container list, the support of each network). */
export async function observeManaged(docker: Docker, opts: { probe?: boolean } = {}): Promise<ManagedObservation> {
  const nets = await withTimeout(docker.listNetworks(), CALL_TIMEOUT_MS, 'list networks') as unknown as Docker.NetworkInspectInfo[];
  const all = await withTimeout(docker.listContainers({ all: true }), CALL_TIMEOUT_MS, 'list containers');
  const networks = new Map<string, Docker.NetworkInspectInfo>();
  const support = new Map<string, StaticSupport>();
  for (const n of nets) {
    if (!isManagedNetwork(n.Name) || (n.Driver && n.Driver !== 'bridge')) continue;
    networks.set(n.Name, n);
    try {
      support.set(n.Name, await staticSupportOf(docker, n, { probe: opts.probe ?? true }));
    } catch (err) {
      logger.debug({ network: n.Name, err: errText(err) }, 'addresses: support unknown');
      support.set(n.Name, 'unknown');
    }
  }
  const endpoints: ObservedEndpoint[] = [];
  const containerNames = new Set<string>();
  const probes: string[] = [];
  const panelName = await panelContainerName(docker);
  for (const c of all) {
    const name = cleanName(c.Names?.[0]);
    if (!name) continue;
    containerNames.add(name);
    if (name.startsWith('oblimint-ipprobe-')) probes.push(name);
    const running = String(c.State ?? '').toLowerCase() === 'running';
    const managed = Object.prototype.hasOwnProperty.call(c.Labels ?? {}, LABELS.internal) || slotFor(name, panelName) !== null;
    for (const [network, ep] of Object.entries(c.NetworkSettings?.Networks ?? {})) {
      if (!networks.has(network)) continue;
      const e = ep as { IPAddress?: string; IPAMConfig?: { IPv4Address?: string } | null; Aliases?: string[] | null };
      const staticIp = endpointIpv4(e.IPAMConfig?.IPv4Address);
      endpoints.push({
        network, container: name, id: c.Id, running,
        ip: running ? endpointIpv4(e.IPAddress) : staticIp,
        staticIp,
        aliases: userAliases(e.Aliases, c.Id, name),
        managed,
      });
    }
  }
  return {
    networks, support, endpoints, containerNames,
    networkNames: new Set(nets.map((n) => n.Name)),
    panelName,
    probes,
  };
}

/** IPRange of the IPv4 IPAM config of a network (null when none). */
function ipRangeOf(net: Docker.NetworkInspectInfo): string | null {
  const cfg = (net.IPAM?.Config ?? []).find((c) => typeof c?.Subnet === 'string' && c.Subnet.includes('.')) as { IPRange?: string } | undefined;
  return cfg?.IPRange || null;
}

/** Probe containers a crashed process left behind (never started; their static address would look owned). */
async function removeLeftoverProbes(docker: Docker, obs: ManagedObservation): Promise<void> {
  for (const name of obs.probes) {
    if (isProbeInFlight(name)) continue;
    try {
      await withTimeout(docker.getContainer(name).remove({ force: true }), CALL_TIMEOUT_MS, `remove ${name}`);
      logger.info({ container: name }, 'addresses: leftover probe container removed');
    } catch (err) {
      logger.debug({ container: name, err: errText(err) }, 'addresses: leftover probe not removed');
    }
  }
}

/** Platform networks in network_subnets (pool 'platform') + ip_range / bridge_name / static_ip of every managed network. */
async function recordNetworks(docker: Docker, obs: ManagedObservation): Promise<void> {
  let dockerSubnets: Awaited<ReturnType<typeof listDockerSubnets>> | null = null;
  for (const [name, net] of obs.networks) {
    const cfg = (net.IPAM?.Config ?? []).find((c) => typeof c?.Subnet === 'string' && c.Subnet.includes('.')) as { Subnet?: string; IPRange?: string } | undefined;
    const options = (net.Options ?? {}) as Record<string, string>;
    const bridge = options['com.docker.network.bridge.name'] || (net.Id.length >= 12 ? `br-${net.Id.slice(0, 12)}` : null);
    try {
      if (MANAGED_PLATFORM_NETWORKS.includes(name) && cfg?.Subnet) {
        dockerSubnets ??= await listDockerSubnets(docker);
        await registerSubnet(name, cfg.Subnet, { pool: 'platform', purpose: 'platform', accountId: null }, dockerSubnets);
      }
      const patch: Record<string, unknown> = { ip_range: cfg?.IPRange || null, bridge_name: bridge };
      const support = obs.support.get(name);
      if (support && support !== 'unknown') patch.static_ip = support;
      await db('network_subnets').where({ network_name: name }).update(patch);
    } catch (err) {
      logger.warn({ network: name, err: errText(err) }, 'addresses: network not recorded in network_subnets');
    }
  }
}

export interface AdoptionResult {
  adopted: number;
  conflicts: Array<{ network: string; container: string; ip: string; holder: string }>;
}

/** Step 1: rows for every endpoint with its current address (no network effect). */
export async function adoptExisting(nodeId: number, docker: Docker, obs: ManagedObservation): Promise<AdoptionResult> {
  const out: AdoptionResult = { adopted: 0, conflicts: [] };
  const byNetwork = new Map<string, ObservedEndpoint[]>();
  for (const e of obs.endpoints) {
    if (isEphemeralContainer(e.container)) continue;
    const list = byNetwork.get(e.network) ?? [];
    list.push(e);
    byNetwork.set(e.network, list);
  }
  for (const [network, net] of obs.networks) {
    const eps = byNetwork.get(network) ?? [];
    const supported = obs.support.get(network) === 'supported';
    // Stale rows first (the observation wins for a RUNNING container: its address is what the rules in force
    // name): a row whose container now has another address, a row of a stopped dynamic container whose address a
    // running one holds, and on a network without static addresses any row of a stopped dynamic container.
    const byName = new Map(eps.map((e) => [e.container, e]));
    const runningIps = new Map<string, string>();
    for (const e of eps) if (e.running && e.ip) runningIps.set(e.ip, e.container);
    try {
      for (const row of await liveAddresses(nodeId, network)) {
        const e = byName.get(row.container_name);
        if (!e) continue; // absent: the GC decides (grace period)
        const holder = runningIps.get(row.ip);
        const stale = (e.running && e.ip && e.ip !== row.ip)
          || (!e.running && e.staticIp && e.staticIp !== row.ip)
          || (!e.running && !e.staticIp && ((holder && holder !== e.container) || !supported));
        if (stale) await releaseAddresses({ nodeId, network, container: e.container });
      }
    } catch (err) {
      logger.warn({ network, err: errText(err) }, 'addresses: stale allocations not released');
    }
    // Static addresses first (running or stopped: the container can only ever start on it, a running dynamic one
    // that holds it is the intruder — relocateIntruders), then the running dynamic ones (facts the rules in force
    // name), the stopped dynamic ones adapt around them.
    const rank = (e: ObservedEndpoint) => (e.staticIp ? 0 : e.running ? 1 : 2);
    const ordered = [...eps].sort((a, b) => rank(a) - rank(b));
    let inUse: Map<string, string> | null = null;
    for (const e of ordered) {
      try {
        if (e.ip) {
          const r = await adoptAddress(nodeId, network, e.container, e.ip, supported ? 'adopted' : 'observed');
          if (r.status === 'conflict') out.conflicts.push({ network, container: e.container, ip: e.ip, holder: r.holder });
          else if (r.status !== 'kept') out.adopted++;
        } else if (supported && !e.running) {
          // Stopped, dynamic: an allocation (pinned below, it starts with it).
          const layout = layoutFromInspect(net);
          if (!layout) continue;
          inUse ??= await addressesInUse(docker, (await inspectNetworkCached(docker, network)) ?? net);
          await addressFor(nodeId, network, e.container, {
            cidr: `${addressAt(layout, 0)}/${layout.cidr.bits}`,
            ipRange: ipRangeOf(net),
            gateway: layout.gateway, panelName: obs.panelName, inUse,
          });
          out.adopted++;
        }
      } catch (err) {
        logger.warn({ network, container: e.container, err: errText(err) }, 'addresses: endpoint not adopted');
      }
    }
  }
  if (out.adopted) logger.info({ adopted: out.adopted }, 'addresses: current container addresses adopted');
  for (const c of out.conflicts) logger.warn(c, 'addresses: an address is allocated to another container (conflict)');
  return out;
}

interface PinTask {
  ep: ObservedEndpoint;
  ip: string;
  priority: number;
  accountId: number | null;
}

function priorityOf(name: string, panelName: string | null): number {
  const i = PLATFORM_ORDER.indexOf(name);
  if (i >= 0) return i;
  if (/^oblimint-oauth2-\d+$/.test(name)) return PLATFORM_ORDER.length;
  if (name === (panelName || 'oblimint')) return PLATFORM_ORDER.length + 1;
  return PLATFORM_ORDER.length + 2;
}

/**
 * Is a container pinned at every sweep whatever the setting? Stopped ones (no blip); EVERY endpoint of a network
 * without IPRange — a fixed address next to dynamic ones there is taken at the next daemon restart by a dynamic
 * container that starts first, and the owner then never starts (verified on Docker 29: 2 restarts out of 4), so
 * such a network is pinned whole, never mixed; every endpoint of a platform network (platform containers only);
 * PostgreSQL and the panel. 'manual' therefore only defers the running containers of a fabric that has an IPRange
 * (a dynamic endpoint stays inside it there and never takes a fixed address).
 */
function alwaysPinned(ep: ObservedEndpoint, panelName: string | null, networkHasRange: boolean): boolean {
  if (!ep.running || !networkHasRange || MANAGED_PLATFORM_NETWORKS.includes(ep.network)) return true;
  return ep.container === POSTGRES || ep.container === (panelName || 'oblimint');
}

/** A tenant container (pinned / moved under its account lock)? */
function isTenantContainer(name: string, panelName: string | null): boolean {
  return priorityOf(name, panelName) > PLATFORM_ORDER.length + 1;
}

/**
 * Stolen fixed addresses: a running managed container holds the STATIC address of a stopped one (a dynamic
 * container started first after a daemon restart; Docker does not reserve the address of a stopped container).
 * The intruder is moved to its own allocation (re-pinned, ≈ 250 ms blip, under the policy hold), then the owner is
 * started again when it failed on its address. Returns the conflicts resolved. An unmanaged intruder is left to
 * the operator (reported as a conflict).
 */
async function relocateIntruders(nodeId: number, docker: Docker, obs: ManagedObservation, adoption: AdoptionResult, log: (l: string) => void): Promise<number> {
  const byKey = new Map(obs.endpoints.map((e) => [`${e.network}\n${e.container}`, e]));
  const owners = new Map<string, string>();
  let resolved = 0;
  for (const c of adoption.conflicts) {
    if (obs.support.get(c.network) !== 'supported') continue;
    const intruder = byKey.get(`${c.network}\n${c.container}`);
    const owner = byKey.get(`${c.network}\n${c.holder}`);
    if (!intruder?.running || !intruder.managed) continue;
    if (!owner || owner.running || owner.staticIp !== c.ip) continue; // only a stolen STATIC address of a stopped owner
    const net = obs.networks.get(c.network);
    const layout = net ? layoutFromInspect(net) : null;
    if (!net || !layout) continue;
    try {
      invalidateNetworkCache(docker, c.network);
      const ip = await addressFor(nodeId, c.network, intruder.container, {
        cidr: `${addressAt(layout, 0)}/${layout.cidr.bits}`,
        ipRange: ipRangeOf(net),
        gateway: layout.gateway, panelName: obs.panelName, inUse: await addressesInUse(docker, (await inspectNetworkCached(docker, c.network)) ?? net),
      });
      if (ip === c.ip) continue;
      const accountId = fabricAccountId(c.network) ?? accountOfContainer(intruder.container);
      const run = () => withPolicyHold(() => pinEndpoint(docker, c.network, intruder.id, ip, { aliases: intruder.aliases, log }));
      if (accountId !== null && isTenantContainer(intruder.container, obs.panelName)) await withAccountLock(accountId, run);
      else await run();
      resolved++;
      owners.set(owner.id, owner.container);
      log(`${intruder.container} moved from ${c.ip} (fixed address of ${owner.container}) to ${ip} on ${c.network}`);
      logger.warn({ network: c.network, intruder: intruder.container, owner: owner.container, from: c.ip, to: ip }, 'addresses: stolen fixed address given back to its owner');
    } catch (err) {
      log(`moving ${intruder.container} away from ${c.ip} on ${c.network} failed: ${errText(err)}`);
    }
    invalidateNetworkCache(docker, c.network);
    await new Promise((r) => setTimeout(r, PIN_PACE_MS));
  }
  // The owner failed to start on its address (daemon restart): started again — not one stopped on purpose.
  for (const [id, name] of owners) {
    try {
      const info = await inspectContainer(docker, id);
      if (info && !info.State?.Running && isAddressInUse(String(info.State?.Error ?? ''))) {
        await startContainer(docker, id);
        log(`${name} started again on its fixed address`);
      }
    } catch (err) {
      log(`${name} not started again: ${errText(err)}`);
    }
  }
  if (resolved) requestPolicySync('pinning');
  return resolved;
}

export interface SweepResult {
  pinned: number;
  failed: number;
  skipped: number;
  conflicts: number;
  /** Containers moved away from the fixed address of a stopped one. */
  relocated: number;
}

export interface SweepOptions {
  /** Pin the running containers too (staff action), whatever the setting. */
  force?: boolean;
  reason?: string;
  log?: (line: string) => void;
}

/** Steps 1–4 (see the header). One at a time; never throws (the error lands in the status). */
export function pinningSweep(opts: SweepOptions = {}): Promise<SweepResult> {
  if (sweeping) {
    // A forced sweep (staff action) never gets the answer of a non-forced one running: it runs right after it.
    if (!opts.force) return sweeping;
    const again = () => pinningSweep(opts);
    return sweeping.then(again, again);
  }
  sweeping = runSweep(opts).finally(() => { sweeping = null; });
  return sweeping;
}

async function runSweep(opts: SweepOptions): Promise<SweepResult> {
  const result: SweepResult = { pinned: 0, failed: 0, skipped: 0, conflicts: 0, relocated: 0 };
  const log = opts.log ?? ((line: string) => logger.info(line));
  try {
    const b = segmentBackends();
    const nodeId = await b.localNode();
    const docker = await b.docker(nodeId);
    const mode = await platformSettings.section('network').then((s) => s.addressPinning).catch(() => 'auto' as const);
    const auto = opts.force === true || mode === 'auto';

    let obs = await observeManaged(docker);
    await removeLeftoverProbes(docker, obs);
    await recordNetworks(docker, obs);
    let adoption = await adoptExisting(nodeId, docker, obs);
    await gcAddresses(nodeId, { containers: obs.containerNames, networks: obs.networkNames });
    const relocated = await relocateIntruders(nodeId, docker, obs, adoption, log);
    result.relocated = relocated;
    if (relocated) {
      // Moved containers: observed again (their new address is now their allocation).
      obs = await observeManaged(docker, { probe: false });
      adoption = await adoptExisting(nodeId, docker, obs);
    }
    let index = await addressIndex(nodeId);
    const hasRange = new Map([...obs.networks].map(([n, net]) => [n, !!layoutFromInspect(net)?.dynamic]));

    const tasks: PinTask[] = [];
    let conflicts = adoption.conflicts.length;
    for (const ep of obs.endpoints) {
      if (isEphemeralContainer(ep.container) || obs.support.get(ep.network) !== 'supported') continue;
      const alloc = index.get(ep.network)?.get(ep.container);
      if (!alloc || ep.staticIp === alloc) continue;
      if (ep.running && ep.ip !== alloc) { conflicts++; continue; } // its address is not its allocation: never moved here
      if (!auto && !alwaysPinned(ep, obs.panelName, hasRange.get(ep.network) ?? false)) { result.skipped++; continue; }
      tasks.push({ ep, ip: alloc, priority: priorityOf(ep.container, obs.panelName), accountId: fabricAccountId(ep.network) ?? accountOfContainer(ep.container) });
    }
    tasks.sort((a, b) => a.priority - b.priority || a.ep.network.localeCompare(b.ep.network) || a.ep.container.localeCompare(b.ep.container));
    for (const task of tasks) {
      const run = () => withPolicyHold(() => pinEndpoint(docker, task.ep.network, task.ep.id, task.ip, { aliases: task.ep.aliases, log }));
      try {
        const outcome = task.accountId !== null && isTenantContainer(task.ep.container, obs.panelName)
          ? await withAccountLock(task.accountId, run)
          : await run();
        if (outcome !== 'already') result.pinned++;
      } catch (err) {
        result.failed++;
        log(`pin ${task.ep.container} on ${task.ep.network} (${task.ip}) failed: ${errText(err)}`);
      }
      invalidateNetworkCache(docker, task.ep.network);
      if (task.ep.running) await new Promise((r) => setTimeout(r, PIN_PACE_MS));
    }
    if (tasks.length) {
      obs = await observeManaged(docker, { probe: false });
      index = await addressIndex(nodeId);
      requestPolicySync('pinning');
    }
    await writeAddressSnapshot(docker, index);
    result.conflicts = conflicts;
    state.conflicts = conflicts;
    state.lastSweepAt = b.now();
    state.lastSweepError = null;
    if (result.pinned || result.failed || result.relocated) logger.info({ ...result, reason: opts.reason ?? null }, 'addresses: pinning sweep');
  } catch (err) {
    state.lastSweepError = errText(err).slice(0, 500);
    logger.warn({ err: state.lastSweepError }, 'addresses: pinning sweep failed (retried at the next one)');
  }
  return result;
}

/** Account of a tenant container from its name (oblimint-files-<id>; the others are on a fabric of their account). */
function accountOfContainer(name: string): number | null {
  const m = /^oblimint-files-(\d{1,10})$/.exec(name);
  return m ? Number(m[1]) : null;
}

/** Counters for the status (GET /system/network). Null when Docker cannot be read. */
export async function addressStatus(): Promise<NetworkAddressStatus | null> {
  const mode = await platformSettings.section('network').then((s) => s.addressPinning).catch(() => 'auto' as const);
  try {
    const b = segmentBackends();
    const nodeId = await b.localNode();
    const docker = await b.docker(nodeId);
    const obs = await observeManaged(docker, { probe: false });
    const index = await addressIndex(nodeId);
    let pinned = 0;
    let unpinned = 0;
    let conflicts = 0;
    for (const ep of obs.endpoints) {
      if (isEphemeralContainer(ep.container)) continue;
      const support = obs.support.get(ep.network);
      const alloc = index.get(ep.network)?.get(ep.container) ?? null;
      if (support === 'supported' && alloc && ep.running && ep.ip && ep.ip !== alloc) { conflicts++; continue; }
      if (support !== 'supported') continue;
      if (alloc && ep.staticIp === alloc) pinned++;
      else unpinned++;
    }
    const refused = [...obs.support].filter(([, s]) => s === 'refused').map(([n]) => n).sort();
    const unknown = [...obs.support].filter(([, s]) => s === 'unknown').map(([n]) => n).sort();
    return {
      pinned, unpinned, conflicts: Math.max(conflicts, state.conflicts), refusedNetworks: refused, unknownNetworks: unknown,
      lastSweepAt: state.lastSweepAt ? state.lastSweepAt.toISOString() : null, lastSweepError: state.lastSweepError, pinning: mode,
    };
  } catch (err) {
    logger.debug({ err: errText(err) }, 'addresses: status unavailable');
    return null;
  }
}

/** Tests: forget the sweep state. */
export function resetPinningForTests(): void {
  state.lastSweepAt = null;
  state.lastSweepError = null;
  state.conflicts = 0;
  sweeping = null;
}
