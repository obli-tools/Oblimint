import type { NetworkFlowReason, NetworkLinkProtocol } from '@oblimint/shared';
import type { HostdSegmentState } from '../hostd/client';
import {
  ADMINER_CONTAINER, AUTH_NETWORK, AUTH_SIDECAR_PORT, EDGE_CONTAINER, LABELS, MAIL_NETWORK, PANEL_NETWORK, PHPMYADMIN_CONTAINER,
  WEBMAIL_CONTAINER, WEBMAIL_PORT,
} from '../hosting/naming';
import { endpointIpv4 } from './ipv4';
import type { AnnotatedFlow, ModelEndpoint } from './policy';

// ─────────────────────────────────────────────────────────────────────────────
// Platform networks under the segment policy (docs/P4b-PLAN.md §4, SG4,
// "edge → web ports only") — PURE.
//
// The edge (internet-facing nginx, advancedConfig) and phpMyAdmin / Adminer
// (PHP exposed through the edge) share Docker networks with PostgreSQL,
// PowerDNS, the mail engine, the panel's internal listener… Those networks
// ('oblimint', 'oblimint-mail', 'oblimint-mail-core', 'oblimint-auth', bridge
// br-<12 hex>: never recreated) are pushed to hostd as `platform` bridges
// (accountId 0) with isolation "listed":
//
//   - the RESTRICTED containers (edge, phpMyAdmin, Adminer) only get the
//     tuples below (both directions, replies stateless as on the fabrics);
//   - frames between two other platform containers pass (trusted components;
//     a per-component inventory of their flows is a later hardening step);
//   - NEW connections from any platform bridge to the node itself (bridge
//     gateway, LAN / public addresses, Docker-published ports: Docker API,
//     SSH, the panel's published port…) are dropped except HOST ports below.
//
//   P1 edge   → panel (oblimint-panel)            tcp panelPort      (panel + mail public paths)
//   P2 edge   → phpMyAdmin / Adminer              tcp DBADMIN_PORT
//   P3 edge   → webmail                           tcp WEBMAIL_PORT
//   P4 edge   → oauth2-proxy sidecars             tcp AUTH_SIDECAR_PORT
//   P5 panel  → edge                              tcp 80 / 443       (ACME HTTP-01 self-test)
//   P6 phpMyAdmin / Adminer → panel               tcp internalPort   (SSO redeem)
//   host: every platform container tcp 80 / 443 (the node's own public web
//   ports); the non-restricted ones also DNS 53 and SMTP 25 / 465 / 587
//   (DNS checks of the node's PowerDNS, notification mail to the local MX).
// ─────────────────────────────────────────────────────────────────────────────

/** postfix-dovecot internal network (mail/engines/postfixDovecot/layout.ts MAIL_CORE_NETWORK; not imported: keeps this module pure). */
export const MAIL_CORE_NETWORK_NAME = 'oblimint-mail-core';

/** Platform networks pushed as `platform` bridges (absent ones are skipped). */
export const PLATFORM_NETWORKS: readonly string[] = [PANEL_NETWORK, MAIL_NETWORK, MAIL_CORE_NETWORK_NAME, AUTH_NETWORK];

/** phpMyAdmin / Adminer web port (services/edge/vhostPlan.ts DBADMIN_PORT; not imported: pure module). */
export const PLATFORM_DBADMIN_PORT = 8080;

/** Node ports every platform container may open (the edge's own public ports). */
export const PLATFORM_HOST_PORTS: ReadonlyArray<{ protocol: NetworkLinkProtocol; port: number }> = [
  { protocol: 'tcp', port: 80 }, { protocol: 'tcp', port: 443 },
];
/** Extra node ports of the non-restricted platform containers (public services of the node). */
export const PLATFORM_TRUSTED_HOST_PORTS: ReadonlyArray<{ protocol: NetworkLinkProtocol; port: number }> = [
  { protocol: 'udp', port: 53 }, { protocol: 'tcp', port: 53 },
  { protocol: 'tcp', port: 25 }, { protocol: 'tcp', port: 465 }, { protocol: 'tcp', port: 587 },
];

const OAUTH2_SIDECAR_RE = /^oblimint-oauth2-\d{1,10}$/;

export interface ModelPlatformNetwork {
  /** Docker network name ('oblimint', 'oblimint-mail'…). */
  network: string;
  /** Linux bridge interface (br-<12 hex>, or the explicit bridge name option). */
  bridge: string;
  endpoints: ModelEndpoint[];
}

export type PlatformRole = 'edge' | 'panel' | 'dbadmin' | 'webmail' | 'oauth2' | 'other';

export interface PlatformInput {
  networks: readonly ModelPlatformNetwork[];
  panelRefs: readonly string[];
  panelPort: number;
  internalPort: number;
}

export interface PlatformSegments {
  bridges: HostdSegmentState['bridges'];
  flows: AnnotatedFlow[];
  restricted: string[];
  host: NonNullable<HostdSegmentState['host']>;
}

function isPanelEndpoint(ep: ModelEndpoint, refs: readonly string[]): boolean {
  return refs.some((r) => r && (ep.name === r || (r.length >= 12 && /^[0-9a-f]+$/.test(r) && (ep.id.startsWith(r) || r.startsWith(ep.id)))));
}

/** Role of a container on a platform network (fixed names; the edge also by its role label). */
export function classifyPlatformEndpoint(ep: ModelEndpoint, panelRefs: readonly string[]): PlatformRole {
  if (isPanelEndpoint(ep, panelRefs)) return 'panel';
  // The edge is restricted by NAME (a mislabelled oblimint-edge stays restricted).
  if (ep.name === EDGE_CONTAINER || ep.labels?.[LABELS.role] === 'edge') return 'edge';
  if (ep.name === PHPMYADMIN_CONTAINER || ep.name === ADMINER_CONTAINER) return 'dbadmin';
  if (ep.name === WEBMAIL_CONTAINER) return 'webmail';
  if (OAUTH2_SIDECAR_RE.test(ep.name)) return 'oauth2';
  return 'other';
}

const RESTRICTED: ReadonlySet<PlatformRole> = new Set<PlatformRole>(['edge', 'dbadmin']);

/** Bridges, flows, restricted addresses and host access of the platform networks. */
export function buildPlatformSegments(input: PlatformInput, reservedBridges: ReadonlySet<string> = new Set()): PlatformSegments {
  const out: PlatformSegments = { bridges: [], flows: [], restricted: [], host: [] };
  const seenBridge = new Set<string>(reservedBridges);
  const seenFlow = new Set<string>();
  const restricted = new Set<string>();
  const nets = input.networks.slice().sort((a, b) => a.network.localeCompare(b.network));
  for (const net of nets) {
    if (!net.bridge || seenBridge.has(net.bridge)) continue;
    seenBridge.add(net.bridge);
    out.bridges.push({ name: net.bridge, accountId: 0, fabric: 'platform', isolation: 'listed' });

    const ipCount = new Map<string, number>();
    for (const ep of net.endpoints) {
      const ip = endpointIpv4(ep.ip);
      if (ip) ipCount.set(ip, (ipCount.get(ip) ?? 0) + 1);
    }
    const members: Array<{ ep: ModelEndpoint; ip: string; role: PlatformRole }> = [];
    for (const ep of net.endpoints) {
      const ip = endpointIpv4(ep.ip);
      if (!ip) continue;
      const role = classifyPlatformEndpoint(ep, input.panelRefs);
      // Restricted even when the observation is inconsistent (an address seen twice): never widened.
      if (RESTRICTED.has(role)) restricted.add(ip);
      if (ipCount.get(ip) !== 1) continue;
      members.push({ ep, ip, role });
    }
    const of = (role: PlatformRole) => members.filter((m) => m.role === role);
    const add = (src: typeof members[number], dst: typeof members[number], port: number, reason: NetworkFlowReason) => {
      if (src.ip === dst.ip || !Number.isInteger(port) || port < 1 || port > 65535) return;
      const key = `${net.bridge}|${src.ip}|${dst.ip}|tcp|${port}`;
      if (seenFlow.has(key)) return;
      seenFlow.add(key);
      out.flows.push({
        accountId: 0,
        bridge: net.bridge,
        src: { container: src.ep.name, ip: src.ip, segment: `platform:${src.role}` },
        dst: { container: dst.ep.name, ip: dst.ip, segment: `platform:${dst.role}` },
        protocol: 'tcp', port, reason, linkId: null,
      });
    };
    const edge = of('edge');
    const panel = of('panel');
    const dbadmin = of('dbadmin');
    for (const e of edge) {
      for (const p of panel) add(e, p, input.panelPort, 'edge');
      for (const d of dbadmin) add(e, d, PLATFORM_DBADMIN_PORT, 'edge');
      for (const w of of('webmail')) add(e, w, WEBMAIL_PORT, 'edge');
      for (const o of of('oauth2')) add(e, o, AUTH_SIDECAR_PORT, 'edge');
      for (const p of panel) { add(p, e, 80, 'panel'); add(p, e, 443, 'panel'); }
    }
    for (const d of dbadmin) for (const p of panel) add(d, p, input.internalPort, 'dbadmin');

    for (const h of PLATFORM_HOST_PORTS) out.host.push({ bridge: net.bridge, protocol: h.protocol, port: h.port });
    for (const m of members) {
      if (RESTRICTED.has(m.role)) continue;
      for (const h of PLATFORM_TRUSTED_HOST_PORTS) out.host.push({ bridge: net.bridge, src: m.ip, protocol: h.protocol, port: h.port });
    }
  }
  // A restricted address never gets a trusted host entry (same address on two observations).
  out.host = out.host.filter((h) => !h.src || !restricted.has(h.src));
  out.restricted = [...restricted].sort();
  return out;
}
