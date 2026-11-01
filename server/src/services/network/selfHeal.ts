import fs from 'fs';
import path from 'path';
import type Docker from 'dockerode';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import {
  cleanName, connectNetwork, createNetwork, inspectContainer, inspectNetwork, isAddressInUse, pinEndpoint, startContainer, userAliases,
} from '../docker/dockerOps';
import { PANEL_ALIAS, PANEL_NETWORK } from '../hosting/naming';
import { docker as socketDocker, errText, selfContainerRef, withTimeout } from '../setup/docker';
import { addressAt, poolOffsetsFromTop } from './addressLayout';
import { layoutFromInspect } from './addresses';
import { createdWithExplicitSubnet, dockerMajorVersion } from './addressResolver';
import { observedBridgeName } from './fabric';
import { endpointIpv4 } from './ipv4';
import { readAddressSnapshot } from './snapshot';

// ─────────────────────────────────────────────────────────────────────────────
// Self-heal of the panel network BEFORE the database (index.ts, normal mode,
// before waitForDatabase; migration 031). Works from Docker, the policy hostd
// restored and the address snapshot only, and never throws:
//
//   - the network 'oblimint' is missing → recreated from the snapshot (same
//     subnet, gateway, IPRange and bridge name: the rules hostd restored stay
//     valid), then the panel and PostgreSQL are reconnected (a stopped
//     PostgreSQL too: a member not reconnected never starts again);
//   - the EXPECTED addresses of the panel and PostgreSQL are those of the
//     panel → PostgreSQL tcp 5432 tuple of the policy hostd enforces
//     (<run>/hostd-segments.json, mode enforce: the rules in force), else the
//     snapshot. A container already pinned (static address) and running keeps
//     its address (the policy was pushed from it); a pinned STOPPED one wants
//     its static address;
//   - an expected address held by another running container (a dynamic one
//     started first after a reboot — Docker does not reserve the address of a
//     stopped container) → that container is moved to a free address (top of
//     the subnet), then the panel / PostgreSQL is put back on it and a
//     PostgreSQL that could not start is started.
//
// That breaks the deadlock of the 2026-11-01 incident (stale rules block
// panel → PostgreSQL, the panel cannot boot to push fresh ones), also on the
// first boot of this version (no snapshot yet: the hostd policy says which
// addresses the rules name). Where Docker refuses static addresses (Docker
// ≤ 28 + subnet chosen by Docker) nothing is moved — a disconnect would only
// reconnect dynamic — and an explicit error says what to do.
// ─────────────────────────────────────────────────────────────────────────────

const POSTGRES = 'oblimint-postgres';
const POSTGRES_PORT = 5432;
const HEAL_TIMEOUT_MS = 90_000;

export interface SelfHealReport {
  networkRecreated: boolean;
  repinned: string[];
  /** Containers moved away from an expected address ("name: from → to"). */
  relocated: string[];
  started: string[];
  skipped: string[];
  /** Where the expected addresses came from. */
  source: 'hostd' | 'snapshot' | null;
}

export async function selfHealPanelNetwork(opts: { docker?: Docker; hostdStatePath?: string } = {}): Promise<SelfHealReport> {
  const report: SelfHealReport = { networkRecreated: false, repinned: [], relocated: [], started: [], skipped: [], source: null };
  try {
    await withTimeout(heal(opts.docker ?? socketDocker(), report, opts.hostdStatePath ?? hostdSegmentsPath()), HEAL_TIMEOUT_MS, 'self-heal of the panel network');
  } catch (err) {
    logger.warn({ err: errText(err) }, 'addresses: self-heal of the panel network failed (boot goes on)');
  }
  return report;
}

/** Policy hostd persists and restores at boot (hostd/segments.go, <root>/run/hostd-segments.json, next to its socket). */
export function hostdSegmentsPath(): string {
  return path.join(path.dirname(config.hosting.hostdSocket), 'hostd-segments.json');
}

/**
 * Panel / PostgreSQL addresses named by the panel → PostgreSQL rule hostd enforces on `bridge` (null when the
 * file is absent / unreadable, the mode is not enforce — nothing is blocked then — or the tuple is not unique).
 */
export function expectedFromHostdState(bridge: string, file: string): { panel: string; postgres: string } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      mode?: string; allow?: Array<{ bridge?: string; src?: string; dst?: string; protocol?: string; port?: number }>;
    };
    if (!raw || raw.mode !== 'enforce' || !Array.isArray(raw.allow)) return null;
    const tuples = raw.allow.filter((f) => f?.bridge === bridge && f.port === POSTGRES_PORT && f.protocol === 'tcp');
    const pairs = new Set(tuples.map((f) => `${f.src}>${f.dst}`));
    if (pairs.size !== 1) return null;
    const panel = endpointIpv4(tuples[0].src);
    const postgres = endpointIpv4(tuples[0].dst);
    return panel && postgres ? { panel, postgres } : null;
  } catch {
    return null;
  }
}

interface Target { name: string; ip: string | null; aliases: string[] }

async function heal(docker: Docker, report: SelfHealReport, hostdState: string): Promise<void> {
  const snap = readAddressSnapshot();
  const entry = snap?.networks[PANEL_NETWORK] ?? null;
  const ref = selfContainerRef();
  const selfInfo = ref ? await inspectContainer(docker, ref).catch(() => null) : null;
  const panelName = selfInfo ? cleanName(selfInfo.Name) : snap?.panel ?? null;

  let net = await inspectNetwork(docker, PANEL_NETWORK);
  if (!net) {
    if (!entry?.subnet) { report.skipped.push(`${PANEL_NETWORK}: missing, no subnet recorded`); return; }
    await createNetwork(docker, PANEL_NETWORK, entry.labels ?? { 'oblimint.internal': 'true' }, {
      subnet: entry.subnet, gateway: entry.gateway, ipRange: entry.ipRange, bridgeName: entry.bridgeName, internal: entry.internal,
    });
    report.networkRecreated = true;
    logger.warn({ subnet: entry.subnet, bridge: entry.bridgeName }, `addresses: network ${PANEL_NETWORK} was missing: recreated from the snapshot`);
    net = await inspectNetwork(docker, PANEL_NETWORK);
    if (!net) return;
  }

  const bridge = observedBridgeName(net as unknown as { Id?: string; Options?: Record<string, string> });
  const fromHostd = bridge ? expectedFromHostdState(bridge, hostdState) : null;
  const snapPanel = (panelName ? entry?.containers[panelName] : undefined) ?? (snap?.panel ? entry?.containers[snap.panel] : undefined) ?? null;
  const targets: Target[] = [
    { name: POSTGRES, ip: fromHostd?.postgres ?? entry?.containers[POSTGRES] ?? null, aliases: entry?.aliases?.[POSTGRES] ?? [] },
  ];
  if (panelName) {
    targets.push({ name: panelName, ip: fromHostd?.panel ?? snapPanel, aliases: [...new Set([PANEL_ALIAS, ...(entry?.aliases?.[panelName] ?? [])])] });
  }
  if (!targets.some((t) => t.ip)) return;
  report.source = fromHostd ? 'hostd' : 'snapshot';
  // Addresses never handed to a moved container: the expected ones and every one the snapshot records.
  const reserved = new Set<string>([...targets.map((t) => t.ip).filter((ip): ip is string => !!ip), ...Object.values(entry?.containers ?? {})]);

  let supported: boolean | null = null;
  const staticSupported = async (): Promise<boolean> => {
    // Recreated just above with the recorded subnet (explicit): every Docker version accepts static addresses.
    supported ??= report.networkRecreated || createdWithExplicitSubnet(net!) || ((await dockerMajorVersion(docker)) ?? 0) >= 29;
    return supported;
  };

  for (const t of targets) {
    if (!t.ip) continue;
    const info = await inspectContainer(docker, t.name).catch(() => null);
    if (!info) continue;
    const ep = info.NetworkSettings?.Networks?.[PANEL_NETWORK] as { IPAMConfig?: { IPv4Address?: string } | null; IPAddress?: string; Aliases?: string[] | null } | undefined;
    const running = Boolean(info.State?.Running);
    const staticIp = endpointIpv4(ep?.IPAMConfig?.IPv4Address);
    let want = t.ip;
    if (ep && staticIp) {
      // Pinned and running with it: the policy in force was pushed from that address — never moved.
      if (running) {
        if (staticIp !== t.ip) report.skipped.push(`${t.name}: pinned on ${staticIp}, kept (expected ${t.ip})`);
        continue;
      }
      want = staticIp; // pinned, stopped: it can only start on its static address
    }
    const current = staticIp ?? (running ? endpointIpv4(ep?.IPAddress) : null);
    const holder = await runningHolder(docker, want, info.Id);
    const failedOnAddress = !running && isAddressInUse(String(info.State?.Error ?? ''));
    if (ep && current === want && !holder) {
      if (t.name === POSTGRES && failedOnAddress) await startTarget(docker, t.name, info.Id, report);
      continue; // right address (pinned by the sweep if still dynamic)
    }
    if (!(await staticSupported())) {
      report.skipped.push(`${t.name}: Docker refuses fixed addresses on ${PANEL_NETWORK}`);
      logger.error(
        { container: t.name, expected: want, current, holder: holder?.name ?? null },
        `addresses: ${t.name} is not on the address the restored policy expects (${want}) and Docker refuses fixed addresses on ${PANEL_NETWORK} `
        + '(Docker ≤ 28, subnet chosen by Docker): nothing moved. If the panel cannot reach its PostgreSQL, update Docker to 29 or later, '
        + 'or remove the restored policy by hand (nft delete table bridge oblimint_seg) and restart the panel.',
      );
      continue;
    }
    try {
      if (holder) {
        const free = await freeAddress(docker, net, reserved);
        if (!free) { report.skipped.push(`${t.name}: ${want} held by ${holder.name}, no free address to move it to`); continue; }
        await pinEndpoint(docker, PANEL_NETWORK, holder.id, free, {});
        reserved.add(free);
        report.relocated.push(`${holder.name}: ${want} → ${free}`);
        logger.warn({ container: holder.name, from: want, to: free, owner: t.name }, `addresses: ${holder.name} held the address of ${t.name} on ${PANEL_NETWORK}: moved`);
      }
      if (!ep) {
        const aliases = [...new Set(t.aliases)];
        await connectNetwork(docker, PANEL_NETWORK, info.Id, aliases.length ? aliases : undefined, { ipv4: want });
        report.repinned.push(t.name);
      } else if (staticIp !== want || current !== want) {
        const aliases = [...new Set([...t.aliases, ...userAliases(ep.Aliases, info.Id, t.name)])];
        await pinEndpoint(docker, PANEL_NETWORK, info.Id, want, { aliases });
        report.repinned.push(t.name);
      }
      if (report.repinned.includes(t.name)) {
        logger.warn({ container: t.name, ip: want, was: current }, `addresses: ${t.name} put back on ${want} on ${PANEL_NETWORK} (${report.source})`);
      }
      if (t.name === POSTGRES && !running && (holder || failedOnAddress)) await startTarget(docker, t.name, info.Id, report);
    } catch (err) {
      report.skipped.push(`${t.name}: ${errText(err)}`);
      logger.warn({ container: t.name, ip: want, err: errText(err) }, 'addresses: re-pin before the database failed');
    }
  }
}

async function startTarget(docker: Docker, name: string, id: string, report: SelfHealReport): Promise<void> {
  try {
    await startContainer(docker, id);
    report.started.push(name);
    logger.warn({ container: name }, `addresses: ${name} started again on its address`);
  } catch (err) {
    report.skipped.push(`${name}: not started (${errText(err)})`);
  }
}

/** Running container (other than `exceptId`) holding `ip` on the panel network. */
async function runningHolder(docker: Docker, ip: string, exceptId: string): Promise<{ id: string; name: string } | null> {
  const net = await inspectNetwork(docker, PANEL_NETWORK);
  for (const [id, c] of Object.entries(net?.Containers ?? {})) {
    if (id === exceptId) continue;
    if (endpointIpv4((c as { IPv4Address?: string }).IPv4Address) === ip) return { id, name: String((c as { Name?: string }).Name ?? id) };
  }
  return null;
}

/** Highest address of the subnet held by nobody (running endpoints, static addresses of every container, `reserved`). */
async function freeAddress(docker: Docker, net: Docker.NetworkInspectInfo, reserved: ReadonlySet<string>): Promise<string | null> {
  const layout = layoutFromInspect(net);
  if (!layout) return null;
  const taken = new Set<string>(reserved);
  const fresh = await inspectNetwork(docker, PANEL_NETWORK);
  for (const c of Object.values(fresh?.Containers ?? {})) {
    const ip = endpointIpv4((c as { IPv4Address?: string }).IPv4Address);
    if (ip) taken.add(ip);
  }
  const all = await withTimeout(docker.listContainers({ all: true }), 30_000, 'list containers');
  for (const c of all) {
    const ep = c.NetworkSettings?.Networks?.[PANEL_NETWORK] as { IPAMConfig?: { IPv4Address?: string } | null } | undefined;
    const ip = endpointIpv4(ep?.IPAMConfig?.IPv4Address);
    if (ip) taken.add(ip);
  }
  for (const off of poolOffsetsFromTop(layout)) {
    const ip = addressAt(layout, off);
    if (!taken.has(ip)) return ip;
  }
  return null;
}
