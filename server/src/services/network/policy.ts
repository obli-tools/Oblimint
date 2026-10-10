import type { NetworkFlowReason, NetworkLinkProtocol, NetworkPolicyMode, SegmentKind } from '@oblimint/shared';
import { SITE_CONTAINER_PORT } from '@oblimint/shared';
import type { HostdSegmentState } from '../hostd/client';
import {
  ADMINER_CONTAINER, EDGE_CONTAINER, fileServerContainer, LABELS, MAIL_RELAY_CONTAINER, MAIL_RELAY_PORT, P2_LABELS, P3_LABELS, P4B_LABELS,
  PHPMYADMIN_CONTAINER,
} from '../hosting/naming';
import { endpointIpv4 } from './ipv4';
import { buildPlatformSegments, PLATFORM_HOST_PORTS, type ModelPlatformNetwork } from './platform';

// ─────────────────────────────────────────────────────────────────────────────
// Segment policy (docs/P4b-PLAN.md §4.3, invariants SG1–SG4) — PURE.
//
// Input: the observed account fabrics (bridge name + the containers on it,
// with their IPv4 and labels), the ownership of sites / DB instances / stacks,
// the enabled declared links and the proxy targets. Output: the hostd state
// (bridges + allowed (bridge, src, dst, proto, port) tuples) and the same flows
// annotated for the troubleshooting view.
//
// Default deny: a frame bridged between two containers of a listed fabric
// passes only when its tuple is one of:
//   F1 edge  → site web containers (primary, secondaries, preview)   front tcp 8080
//   F2 panel → site web containers                                   front tcp 8080
//   F3 edge  → proxy target of the account (app service / site)      front port of the target
//   F4 panel → exposed ports of the app services on the front        front
//   F5 site web containers → mail relay                              front tcp 2525
//   F6 file server of the account → panel                            front tcp internalPort
//   F7 edge  → panel (its upstream oblimint-panel)                   front tcp panelPort
//   L1 declared link source → target                                 any fabric both ends sit on
//   L2 phpMyAdmin (MariaDB / MySQL) / Adminer (PostgreSQL) → DB inst. back  3306 / 5432
// and NOTHING else. Fail-safe: a container whose labels do not resolve to a
// segment OF THE FABRIC'S ACCOUNT (unknown, another account, a row that does
// not exist) gets no flow at all. Only fabrics of 'segmented' accounts are
// listed (legacy accounts are not filtered until migrated).
// ─────────────────────────────────────────────────────────────────────────────

export type FabricWhich = 'front' | 'back';

export interface ModelEndpoint {
  /** Docker container id (full or short). */
  id: string;
  name: string;
  /** IPv4 on this fabric ('a.b.c.d' or Docker's 'a.b.c.d/n'); null = no address (no flow). */
  ip: string | null;
  /** Container labels (null = unknown container: no flow). */
  labels: Record<string, string> | null;
}

export interface ModelFabric {
  fabric: FabricWhich;
  /** Docker network name (oblimint-acct-<id> / oblimint-acct-<id>-db). */
  network: string;
  /** Linux bridge interface (omf<id> / omb<id>, legacy br-<12 hex>). */
  bridge: string;
  endpoints: ModelEndpoint[];
}

export interface ModelAccount {
  id: number;
  fabrics: ModelFabric[];
}

export interface ModelLink {
  id: number;
  accountId: number;
  source: { kind: SegmentKind; id: number; service: string | null };
  target: { kind: SegmentKind; id: number; service: string | null };
  protocol: NetworkLinkProtocol;
  port: number;
}

export interface ModelProxyTarget {
  accountId: number;
  kind: 'app' | 'site';
  stackId: number | null;
  service: string | null;
  siteId: number | null;
  port: number;
  protocol: NetworkLinkProtocol;
}

export interface SegmentModel {
  mode: NetworkPolicyMode;
  /** Segmented accounts of the node (only their fabrics are filtered). */
  accounts: ModelAccount[];
  /** site id → account id. */
  sites: ReadonlyMap<number, number>;
  /** DB instance id → owner + engine. */
  dbInstances: ReadonlyMap<number, { accountId: number; engine: string }>;
  /** stack id → owner + exposed ports per service (EffectiveStackConfig). */
  stacks: ReadonlyMap<number, { accountId: number; exposed: Record<string, Array<{ port: number; protocol: NetworkLinkProtocol }>> }>;
  /** adapter_runs.id → site id (tools containers). */
  adapterRuns: ReadonlyMap<number, number>;
  /** Names / id prefixes identifying the panel container (selfContainerRef, its inspected name / id). */
  panelRefs: readonly string[];
  links: readonly ModelLink[];
  proxyTargets: readonly ModelProxyTarget[];
  /** config.hosting.internalPort (F6; 0 = file-server hooks disabled → no F6). */
  internalPort: number;
  /** config.port: the panel's HTTP(S) port, the edge's panel upstream (F7; 0/absent = no F7). */
  panelPort?: number;
  /** Platform networks of the node (network/platform.ts; absent = not filtered). */
  platform?: readonly ModelPlatformNetwork[];
}

/** What a container of a fabric is, for the policy. */
export type EndpointRole =
  | { kind: 'edge' }
  | { kind: 'panel' }
  | { kind: 'relay' }
  | { kind: 'filesrv' }
  | { kind: 'dbadmin'; admin: 'phpmyadmin' | 'adminer' }
  | { kind: 'site'; siteId: number; web: boolean }
  | { kind: 'db'; instanceId: number }
  | { kind: 'app'; stackId: number; service: string }
  | { kind: 'unknown' };

export interface AnnotatedFlow {
  accountId: number;
  bridge: string;
  src: { container: string; ip: string; segment: string };
  dst: { container: string; ip: string; segment: string };
  protocol: NetworkLinkProtocol;
  port: number;
  reason: NetworkFlowReason;
  linkId: number | null;
}

export interface BuiltPolicy {
  state: HostdSegmentState;
  flows: AnnotatedFlow[];
  /** Enabled links that produced at least one flow (status active). */
  activeLinks: Set<number>;
}

const MYSQL_PORT = 3306;
const POSTGRES_PORT = 5432;

/** Engine port of a DB instance (mariadb / mysql 3306, postgresql 5432), null for an unknown engine. */
export function dbEnginePort(engine: string): number | null {
  if (engine === 'mariadb' || engine === 'mysql') return MYSQL_PORT;
  if (engine === 'postgresql') return POSTGRES_PORT;
  return null;
}

function positiveId(v: string | undefined): number | null {
  if (v === undefined || !/^[1-9]\d{0,9}$/.test(v)) return null;
  return Number(v);
}

function isPanel(ep: ModelEndpoint, refs: readonly string[]): boolean {
  return refs.some((r) => r && (ep.name === r || (r.length >= 12 && /^[0-9a-f]+$/.test(r) && (ep.id.startsWith(r) || r.startsWith(ep.id)))));
}

/**
 * Role of one container on a fabric of `accountId`. Infra containers are
 * recognised by their fixed name AND their role label; tenant containers by
 * their labels, checked against the owner rows (a container labelled for
 * another account, or for an id that does not belong to the account, is
 * 'unknown': no flow).
 */
export function classifyEndpoint(model: SegmentModel, accountId: number, fabric: FabricWhich, ep: ModelEndpoint): EndpointRole {
  if (isPanel(ep, model.panelRefs)) return { kind: 'panel' };
  const labels = ep.labels;
  if (!labels) return { kind: 'unknown' };
  const role = labels[LABELS.role];
  switch (role) {
    case 'edge':
      return ep.name === EDGE_CONTAINER ? { kind: 'edge' } : { kind: 'unknown' };
    case 'mail-relay':
      return ep.name === MAIL_RELAY_CONTAINER ? { kind: 'relay' } : { kind: 'unknown' };
    case 'filesrv':
      return ep.name === fileServerContainer(accountId) && positiveId(labels[LABELS.account]) === accountId ? { kind: 'filesrv' } : { kind: 'unknown' };
    case 'dbadmin':
      if (ep.name === PHPMYADMIN_CONTAINER) return { kind: 'dbadmin', admin: 'phpmyadmin' };
      if (ep.name === ADMINER_CONTAINER) return { kind: 'dbadmin', admin: 'adminer' };
      return { kind: 'unknown' };
    default:
      break;
  }
  // Tenant containers: the account label must be the fabric's account.
  if (positiveId(labels[LABELS.account]) !== accountId) return { kind: 'unknown' };
  switch (role) {
    case 'site':
    case 'site-secondary':
    case 'site-preview': {
      const siteId = positiveId(labels[LABELS.site]);
      return siteId !== null && model.sites.get(siteId) === accountId ? { kind: 'site', siteId, web: true } : { kind: 'unknown' };
    }
    case 'tools': {
      const runId = positiveId(labels[P3_LABELS.adapterRun]);
      const siteId = runId === null ? undefined : model.adapterRuns.get(runId);
      return siteId !== undefined && model.sites.get(siteId) === accountId ? { kind: 'site', siteId, web: false } : { kind: 'unknown' };
    }
    case 'db': {
      const instanceId = positiveId(labels[P2_LABELS.dbInstance]);
      // A database instance only ever belongs on the BACK fabric.
      return instanceId !== null && fabric === 'back' && model.dbInstances.get(instanceId)?.accountId === accountId
        ? { kind: 'db', instanceId } : { kind: 'unknown' };
    }
    case 'app': {
      const stackId = positiveId(labels[P4B_LABELS.app]);
      const service = labels[P4B_LABELS.appService];
      return stackId !== null && typeof service === 'string' && service.length > 0 && model.stacks.get(stackId)?.accountId === accountId
        ? { kind: 'app', stackId, service } : { kind: 'unknown' };
    }
    default:
      return { kind: 'unknown' };
  }
}

/** Segment label of a role ('site:12', 'db:3', 'app:5/web', 'edge', …). */
export function segmentLabel(r: EndpointRole): string {
  switch (r.kind) {
    case 'site': return `site:${r.siteId}`;
    case 'db': return `db:${r.instanceId}`;
    case 'app': return `app:${r.stackId}/${r.service}`;
    default: return r.kind;
  }
}

interface Classified {
  ep: ModelEndpoint;
  ip: string;
  role: EndpointRole;
}

/** Does a container belong to the segment a link end designates? */
function inSegment(role: EndpointRole, ref: ModelLink['source']): boolean {
  switch (ref.kind) {
    case 'site': return role.kind === 'site' && role.siteId === ref.id;
    case 'db': return role.kind === 'db' && role.instanceId === ref.id;
    case 'app': return role.kind === 'app' && role.stackId === ref.id && (ref.service === null || role.service === ref.service);
    default: return false;
  }
}

/** Every allowed flow, annotated (deterministic order, deduplicated per (bridge, src, dst, proto, port)). */
export function buildSegmentFlows(model: SegmentModel): { flows: AnnotatedFlow[]; activeLinks: Set<number>; bridges: HostdSegmentState['bridges'] } {
  const flows: AnnotatedFlow[] = [];
  const seen = new Set<string>();
  const activeLinks = new Set<number>();
  const bridges: HostdSegmentState['bridges'] = [];
  const bridgeNames = new Set<string>();

  const accounts = model.accounts.slice().sort((a, b) => a.id - b.id);
  for (const account of accounts) {
    for (const fabric of account.fabrics) {
      if (!fabric.bridge || bridgeNames.has(fabric.bridge)) continue; // a bridge belongs to ONE account fabric
      bridgeNames.add(fabric.bridge);
      bridges.push({ name: fabric.bridge, accountId: account.id, fabric: fabric.fabric });

      // No address, or an address seen twice on the bridge (inconsistent observation): no flow at all.
      const ipCount = new Map<string, number>();
      for (const ep of fabric.endpoints) {
        const ip = endpointIpv4(ep.ip);
        if (ip) ipCount.set(ip, (ipCount.get(ip) ?? 0) + 1);
      }
      const members: Classified[] = [];
      for (const ep of fabric.endpoints) {
        const ip = endpointIpv4(ep.ip);
        if (!ip || ipCount.get(ip) !== 1) continue;
        members.push({ ep, ip, role: classifyEndpoint(model, account.id, fabric.fabric, ep) });
      }
      const of = (pred: (r: EndpointRole) => boolean) => members.filter((m) => pred(m.role));
      const add = (src: Classified, dst: Classified, protocol: NetworkLinkProtocol, port: number, reason: NetworkFlowReason, linkId: number | null = null) => {
        if (src.ip === dst.ip || !Number.isInteger(port) || port < 1 || port > 65535) return;
        if (linkId !== null) activeLinks.add(linkId);
        const key = `${fabric.bridge}|${src.ip}|${dst.ip}|${protocol}|${port}`;
        if (seen.has(key)) return;
        seen.add(key);
        flows.push({
          accountId: account.id,
          bridge: fabric.bridge,
          src: { container: src.ep.name, ip: src.ip, segment: segmentLabel(src.role) },
          dst: { container: dst.ep.name, ip: dst.ip, segment: segmentLabel(dst.role) },
          protocol, port, reason, linkId,
        });
      };

      const edge = of((r) => r.kind === 'edge');
      const panel = of((r) => r.kind === 'panel');
      const relay = of((r) => r.kind === 'relay');
      const filesrv = of((r) => r.kind === 'filesrv');
      const webSites = of((r) => r.kind === 'site' && r.web);

      if (fabric.fabric === 'front') {
        // F1 / F2: web port of every site container.
        for (const s of webSites) {
          for (const e of edge) add(e, s, 'tcp', SITE_CONTAINER_PORT, 'edge');
          for (const p of panel) add(p, s, 'tcp', SITE_CONTAINER_PORT, 'panel');
        }
        // F3: enabled internal targets of the account's proxy hosts / routes / streams.
        for (const t of model.proxyTargets) {
          if (t.accountId !== account.id) continue;
          const dsts = t.kind === 'app'
            ? of((r) => r.kind === 'app' && r.stackId === t.stackId && r.service === t.service)
            : of((r) => r.kind === 'site' && r.web && r.siteId === t.siteId);
          for (const d of dsts) for (const e of edge) add(e, d, t.protocol === 'udp' ? 'udp' : 'tcp', t.port, 'edge');
        }
        // F4: panel → exposed ports of the app services on the front (wake-up, probes).
        for (const a of of((r) => r.kind === 'app')) {
          const role = a.role as Extract<EndpointRole, { kind: 'app' }>;
          const ports = model.stacks.get(role.stackId)?.exposed[role.service] ?? [];
          for (const p of ports) for (const pn of panel) add(pn, a, p.protocol === 'udp' ? 'udp' : 'tcp', p.port, 'panel');
        }
        // F5: site web containers → mail relay (SMTP AUTH).
        for (const s of webSites) for (const r of relay) add(s, r, 'tcp', MAIL_RELAY_PORT, 'relay');
        // F6: the account's file server → the panel's internal hook listener.
        if (model.internalPort > 0) for (const f of filesrv) for (const p of panel) add(f, p, 'tcp', model.internalPort, 'filesrv');
        // F7: edge → panel. The panel carries the alias oblimint-panel on every front fabric too, and Docker's
        // DNS may answer the edge with that address: two platform containers, never a tenant.
        const panelPort = Number(model.panelPort) || 0;
        if (panelPort > 0) for (const e of edge) for (const p of panel) add(e, p, 'tcp', panelPort, 'edge');
      } else {
        // L2: phpMyAdmin → MariaDB / MySQL instances, Adminer → PostgreSQL instances (SSO sessions).
        for (const d of of((r) => r.kind === 'db')) {
          const inst = model.dbInstances.get((d.role as Extract<EndpointRole, { kind: 'db' }>).instanceId);
          const port = inst ? dbEnginePort(inst.engine) : null;
          if (port === null) continue;
          const admin = port === POSTGRES_PORT ? 'adminer' : 'phpmyadmin';
          for (const a of of((r) => r.kind === 'dbadmin' && r.admin === admin)) add(a, d, 'tcp', port, 'dbadmin');
        }
      }

      // L1: declared links, on every fabric where both ends sit.
      for (const link of model.links) {
        if (link.accountId !== account.id) continue;
        if (link.target.kind === 'app' && !link.target.service) continue; // a target service is required
        const srcs = members.filter((m) => inSegment(m.role, link.source));
        const dsts = members.filter((m) => inSegment(m.role, link.target));
        for (const s of srcs) {
          for (const d of dsts) {
            if (segmentLabel(s.role) === segmentLabel(d.role)) continue;
            add(s, d, link.protocol === 'udp' ? 'udp' : 'tcp', link.port, 'link', link.id);
          }
        }
      }
    }
  }
  return { flows, activeLinks, bridges };
}

/** The hostd state (PUT /v1/segments) of a model. mode off → nothing listed (hostd deletes its table). */
export function buildSegmentPolicy(model: SegmentModel): HostdSegmentState {
  return buildPolicy(model).state;
}

export function buildPolicy(model: SegmentModel): BuiltPolicy {
  if (model.mode === 'off') return { state: { mode: 'off', bridges: [], allow: [] }, flows: [], activeLinks: new Set() };
  const built = buildSegmentFlows(model);
  const { activeLinks } = built;
  let { flows, bridges } = built;
  const state: HostdSegmentState = { mode: model.mode, bridges, allow: [] };
  if (model.platform !== undefined) {
    const p = buildPlatformSegments({
      networks: model.platform, panelRefs: model.panelRefs, panelPort: Number(model.panelPort) || 0, internalPort: model.internalPort,
    }, new Set(bridges.map((b) => b.name)));
    bridges = [...bridges, ...p.bridges];
    flows = [...flows, ...p.flows];
    state.bridges = bridges;
    // The edge also sits on every account FRONT fabric: its addresses there are restricted too, so hostd
    // filters its connections to the node itself from those gateways as well (web ports only).
    const restricted = new Set(p.restricted);
    const host = [...p.host];
    for (const account of model.accounts) {
      for (const fabric of account.fabrics) {
        if (!fabric.bridge || !bridges.some((b) => b.name === fabric.bridge && b.accountId === account.id)) continue;
        for (const ep of fabric.endpoints) {
          const ip = endpointIpv4(ep.ip);
          if (!ip || classifyEndpoint(model, account.id, fabric.fabric, ep).kind !== 'edge') continue;
          if (restricted.has(ip)) continue;
          restricted.add(ip);
          for (const h of PLATFORM_HOST_PORTS) host.push({ bridge: fabric.bridge, src: ip, protocol: h.protocol, port: h.port });
        }
      }
    }
    if (restricted.size) state.restricted = [...restricted].sort();
    if (host.length) state.host = host;
  }
  state.allow = flows.map((f) => ({ bridge: f.bridge, src: f.src.ip, dst: f.dst.ip, protocol: f.protocol, port: f.port }));
  return { state, flows, activeLinks };
}

/**
 * Would hostd let a NEW flow src → dst (proto, port) through? Mirrors the
 * rendered table: frames between two ports of a listed bridge pass only when
 * the tuple is allowed (enforce); monitor / off never block. Frames between
 * containers that share no listed bridge are not filtered by this table at
 * all (routed through the host: P2 firewall + Docker isolation) — the caller
 * gives the bridge both containers sit on, or null when they share none.
 */
export function evaluateFlow(
  policy: HostdSegmentState,
  src: string,
  dst: string,
  protocol: NetworkLinkProtocol,
  port: number,
  bridge?: string | null,
): boolean {
  if (policy.mode !== 'enforce') return true;
  if (policy.allow.some((a) => a.src === src && a.dst === dst && a.protocol === protocol && a.port === port && (bridge == null || a.bridge === bridge))) return true;
  // A 'listed' platform bridge lets frames between two non-restricted containers through.
  if (bridge == null) return false;
  const b = policy.bridges.find((x) => x.name === bridge);
  const restricted = new Set(policy.restricted ?? []);
  return b?.fabric === 'platform' && b.isolation === 'listed' && !restricted.has(src) && !restricted.has(dst);
}
