import fs from 'fs';
import path from 'path';
import type Docker from 'dockerode';
import { dataDir } from '../../config';
import { logger } from '../../utils/logger';
import { cleanName, inspectNetwork } from '../docker/dockerOps';
import { errText, selfContainerRef, withTimeout } from '../setup/docker';
import { writeFileAtomic0600 } from '../setup/configFile';
import { MANAGED_PLATFORM_NETWORKS, slotFor } from './addressLayout';
import { endpointIpv4 } from './ipv4';

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot of the platform addresses OUTSIDE the database (migration 031):
// <dataDir>/config/network-addresses.json (0600, atomic) — for each platform
// network its subnet, gateway, IPRange, bridge name and id, and the address of
// each platform container on it (panel, PostgreSQL, edge…: the allocation,
// else the static address Docker holds, else the observed one). Its sibling
// panel-addresses.env ("network=ip", the panel only) is read by install.sh
// --upgrade. Read at boot BEFORE the database (selfHeal.ts): a panel whose
// network or address changed (recreated by hand, network removed) gets them
// back, so the rules hostd restored are right again and the panel can reach
// its PostgreSQL. Written by the wizard and every pinning sweep. Never throws
// to its callers' detriment: a write failure is a warning.
// ─────────────────────────────────────────────────────────────────────────────

export interface SnapshotNetwork {
  id: string;
  subnet: string | null;
  gateway: string | null;
  ipRange: string | null;
  bridgeName: string | null;
  /** Explicit com.docker.network.bridge.name option (absent = Docker's br-<12 hex>). */
  explicitBridge: boolean;
  internal: boolean;
  labels: Record<string, string>;
  /** Platform container name → address. */
  containers: Record<string, string>;
  /** Platform container name → aliases on this network. */
  aliases: Record<string, string[]>;
}

export interface AddressSnapshot {
  version: 1;
  writtenAt: string;
  panel: string | null;
  networks: Record<string, SnapshotNetwork>;
}

export function snapshotPaths(): { json: string; env: string } {
  const dir = path.join(dataDir, 'config');
  return { json: path.join(dir, 'network-addresses.json'), env: path.join(dir, 'panel-addresses.env') };
}

export function readAddressSnapshot(): AddressSnapshot | null {
  try {
    const raw = JSON.parse(fs.readFileSync(snapshotPaths().json, 'utf8')) as AddressSnapshot;
    if (raw?.version !== 1 || typeof raw.networks !== 'object' || !raw.networks) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Is `name` a platform container (fixed slot, or the panel)? */
function isPlatformContainer(name: string, panel: string | null): boolean {
  return slotFor(name, panel) !== null && !/^oblimint-files-/.test(name);
}

/**
 * Builds and writes the snapshot from Docker (+ the allocations when known:
 * network → container → ip). Returns the snapshot, null when it could not be written.
 */
export async function writeAddressSnapshot(docker: Docker, allocations?: ReadonlyMap<string, ReadonlyMap<string, string>>): Promise<AddressSnapshot | null> {
  try {
    let panel: string | null = null;
    const ref = selfContainerRef();
    if (ref) {
      const info = await withTimeout(docker.getContainer(ref).inspect(), 15_000, 'inspect panel').catch(() => null);
      panel = info ? cleanName(info.Name) : null;
    }
    const all = await withTimeout(docker.listContainers({ all: true }), 30_000, 'list containers');
    const snap: AddressSnapshot = { version: 1, writtenAt: new Date().toISOString(), panel, networks: {} };
    for (const name of MANAGED_PLATFORM_NETWORKS) {
      const net = await inspectNetwork(docker, name);
      if (!net) continue;
      const cfg = (net.IPAM?.Config ?? []).find((c) => typeof c?.Subnet === 'string' && c.Subnet.includes('.')) as
        { Subnet?: string; Gateway?: string; IPRange?: string } | undefined;
      const options = (net.Options ?? {}) as Record<string, string>;
      const entry: SnapshotNetwork = {
        id: net.Id,
        subnet: cfg?.Subnet ?? null,
        gateway: cfg?.Gateway ?? null,
        ipRange: cfg?.IPRange || null,
        bridgeName: options['com.docker.network.bridge.name'] || (net.Id && net.Id.length >= 12 ? `br-${net.Id.slice(0, 12)}` : null),
        explicitBridge: Boolean(options['com.docker.network.bridge.name']),
        internal: Boolean(net.Internal),
        labels: { ...(net.Labels ?? {}) },
        containers: {},
        aliases: {},
      };
      for (const c of all) {
        const cname = cleanName(c.Names?.[0]);
        if (!isPlatformContainer(cname, panel)) continue;
        const ep = c.NetworkSettings?.Networks?.[name] as { IPAMConfig?: { IPv4Address?: string } | null; IPAddress?: string; Aliases?: string[] | null } | undefined;
        if (!ep) continue;
        const ip = allocations?.get(name)?.get(cname) ?? endpointIpv4(ep.IPAMConfig?.IPv4Address) ?? endpointIpv4(ep.IPAddress);
        if (ip) entry.containers[cname] = ip;
        const aliases = (ep.Aliases ?? []).filter((a) => a && a !== cname && !c.Id.startsWith(a));
        if (aliases.length) entry.aliases[cname] = [...new Set(aliases)];
      }
      snap.networks[name] = entry;
    }
    const { json, env } = snapshotPaths();
    await fs.promises.mkdir(path.dirname(json), { recursive: true, mode: 0o700 });
    await writeFileAtomic0600(json, `${JSON.stringify(snap, null, 2)}\n`);
    const lines = Object.entries(snap.networks)
      .map(([n, e]) => (panel && e.containers[panel] ? `${n}=${e.containers[panel]}` : null))
      .filter((l): l is string => l !== null);
    await writeFileAtomic0600(env, `# Oblimint: fixed addresses of the panel container (install.sh --upgrade). Generated, do not edit.\n${lines.join('\n')}\n`);
    return snap;
  } catch (err) {
    logger.warn({ err: errText(err) }, 'addresses: snapshot not written (non blocking)');
    return null;
  }
}
