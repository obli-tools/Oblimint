import type { NetworkSettings, PortRange, ReservedPortRange } from '@oblimint/shared';
import { PLATFORM_RESERVED_PORTS } from '@oblimint/shared';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { mergeRanges } from './portAllocator';

// ─────────────────────────────────────────────────────────────────────────────
// Ports never handed out / published (migration 032). PURE core
// (reservedRanges) + a reader of the current inputs (config, settings, the
// listening sockets of the node through hostd, cached 60 s).
//   fixed      PLATFORM_RESERVED_PORTS (SSH, SMTP, DNS, HTTP(S), mail, panel listeners), every IP;
//   panel      config.port, config.hosting.pdnsPort / internalPort / webmailPort;
//   sftp, sql  the SFTP gateway / external SQL ranges: Docker and the hostd gateway listen on EVERY
//              address of the node, a DNAT at -110 would hijack them;
//   stream     the edge stream ports (settings edge.streamPorts);
//   extra      settings network.reservedPorts;
//   host       the sockets of the node (hostd GET /v1/net/listeners: an sshd on a custom port, the
//              Docker API on 2375…): hostd refuses them at DNAT time anyway (portInUseOnHost).
// A dedicated IP: 80 / 443 are the edge's, unless the account took them over
// (takeover_web) — then they are its own. Reserved numbers hold for TCP AND UDP.
// ─────────────────────────────────────────────────────────────────────────────

export type PublicIpKindArg = 'shared' | 'dedicated';

export interface ReservedInputs {
  panelPort: number;
  pdnsPort: number;
  internalPort: number;
  webmailPort: number;
  filesrv: PortRange;
  db: PortRange;
  streamPorts: ReadonlyArray<{ port: number; protocol: 'tcp' | 'udp' }>;
  extra: ReadonlyArray<number | PortRange>;
  /** Listening sockets of the node on a wildcard / the address of the IP considered (hostd), any address otherwise. */
  hostPorts: ReadonlyArray<number>;
}

const single = (p: number, reason: string): ReservedPortRange => ({ from: p, to: p, reason });

/** Reserved ranges with their reason (sorted by start, NOT merged: the reasons stay visible). */
export function reservedRanges(input: ReservedInputs, kind: PublicIpKindArg, opts: { takeoverWeb?: boolean } = {}): ReservedPortRange[] {
  const out: ReservedPortRange[] = [];
  const takeover = kind === 'dedicated' && !!opts.takeoverWeb;
  for (const p of PLATFORM_RESERVED_PORTS) {
    if (takeover && (p === 80 || p === 443)) continue;
    out.push(single(p, 'fixed'));
  }
  for (const p of [input.panelPort, input.pdnsPort, input.internalPort, input.webmailPort]) {
    if (Number.isInteger(p) && p >= 1 && p <= 65535) out.push(single(p, 'panel'));
  }
  const range = (r: PortRange, reason: string) => {
    if (Number.isInteger(r.from) && Number.isInteger(r.to) && r.from >= 1 && r.to <= 65535 && r.from <= r.to) out.push({ from: r.from, to: r.to, reason });
  };
  range(input.filesrv, 'sftp');
  range(input.db, 'sql');
  for (const s of input.streamPorts) out.push(single(s.port, 'stream'));
  for (const e of input.extra) {
    if (typeof e === 'number') out.push(single(e, 'extra'));
    else range(e, 'extra');
  }
  for (const p of input.hostPorts) {
    if (takeover && (p === 80 || p === 443)) continue;
    out.push(single(p, 'host'));
  }
  // Dedup identical (from, to, reason).
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.from}-${r.to}-${r.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Reason a port is reserved (null = free to use). */
export function reservedReason(list: readonly ReservedPortRange[], port: number): string | null {
  return list.find((r) => port >= r.from && port <= r.to)?.reason ?? null;
}

export const reservedMerged = (list: readonly ReservedPortRange[]): PortRange[] => mergeRanges(list);

// ── reader ───────────────────────────────────────────────────────────────────

const LISTENER_CACHE_MS = 60_000;
let listenerCache: { at: number; ports: Array<{ protocol: string; address: string; port: number }> } | null = null;
let listenerOverride: Array<{ protocol: string; address: string; port: number }> | null = null;

/** Listening sockets of the local node (hostd), cached 60 s; [] when hostd cannot tell (older hostd, unreachable). */
export async function hostListeners(): Promise<Array<{ protocol: string; address: string; port: number }>> {
  if (listenerOverride) return listenerOverride;
  if (listenerCache && Date.now() - listenerCache.at < LISTENER_CACHE_MS) return listenerCache.ports;
  try {
    const { segmentBackends } = await import('./deps');
    const b = segmentBackends();
    const client = b.hostd(await b.localNode()) as { netListeners?: () => Promise<Array<{ protocol: string; address: string; port: number }>> };
    const ports = typeof client.netListeners === 'function' ? await client.netListeners() : [];
    listenerCache = { at: Date.now(), ports };
    return ports;
  } catch (err) {
    logger.debug({ err: (err as Error)?.message }, 'publish: host listeners unavailable');
    listenerCache = { at: Date.now(), ports: listenerCache?.ports ?? [] };
    return listenerCache.ports;
  }
}

/** Tests: fixed listeners (null = hostd again). */
export function setHostListenersForTests(list: Array<{ protocol: string; address: string; port: number }> | null): void {
  listenerOverride = list;
  listenerCache = null;
}

/** Ports of the node's sockets reachable on `address` (wildcard, or bound to it; loopback never). */
export function hostPortsOn(listeners: ReadonlyArray<{ protocol: string; address: string; port: number }>, address: string | null): number[] {
  const out = new Set<number>();
  for (const l of listeners) {
    if (l.address === '127.0.0.1' || l.address === '::1' || l.address.startsWith('127.')) continue;
    if (l.address === '0.0.0.0' || l.address === '::' || !address || l.address === address) out.add(l.port);
  }
  return [...out].sort((a, b) => a - b);
}

/** Inputs from the config and the given settings (listeners passed by the caller). */
export function reservedInputs(settings: { edge: { streamPorts: ReadonlyArray<{ port: number; protocol: 'tcp' | 'udp' }> }; network: Pick<NetworkSettings, 'reservedPorts'> }, hostPorts: number[] = []): ReservedInputs {
  return {
    panelPort: Number(config.port) || 0,
    pdnsPort: Number(config.hosting.pdnsPort) || 0,
    internalPort: Number(config.hosting.internalPort) || 0,
    webmailPort: Number(config.hosting.webmailPort) || 0,
    filesrv: { from: Number(config.hosting.filesrvPortMin), to: Number(config.hosting.filesrvPortMax) },
    db: { from: Number(config.hosting.dbPortMin), to: Number(config.hosting.dbPortMax) },
    streamPorts: settings.edge.streamPorts ?? [],
    extra: settings.network.reservedPorts ?? [],
    hostPorts,
  };
}
