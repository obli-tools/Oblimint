// =============================================================================
// Oblimint — P4b network segmentation (docs/P4b-PLAN.md §4, §6.2). ARCHITECT
// FILE (frozen during the phase). Module segmentation implements the server
// side + hostd, ui-apps the "Network links" page.
//
// Model ("account fabrics + segment policy", decision D-SEG):
//   - every account keeps two Docker bridges (fabrics): FRONT oblimint-acct-<id>
//     (edge, panel, mail relay, file server, sites, app services exposed to the
//     edge) and BACK oblimint-acct-<id>-db (database instances, sites, phpMyAdmin
//     during an SSO session, app services taking part in a declared link);
//   - hostd filters every frame bridged INSIDE a fabric (nftables bridge
//     family, table bridge oblimint_seg): default DENY between containers,
//     except the flows of the policy computed by the panel (edge → web port of
//     a segment, declared links, a few infrastructure flows);
//   - a segment = one site (its primary / secondary / preview / tools
//     containers), one app stack, or one database instance; the services of a
//     stack talk freely on the stack's PRIVATE networks (panel-allocated subnets).
// =============================================================================

export type SegmentKind = 'site' | 'app' | 'db';

export interface SegmentRef {
  kind: SegmentKind;
  id: number;
  /** app only: the service (source: null = every service of the stack; target: required). */
  service?: string | null;
}

export type NetworkLinkOrigin = 'user' | 'migration' | 'catalog';
export type NetworkLinkProtocol = 'tcp' | 'udp';

export interface NetworkLink {
  id: number;
  tenantId: number;
  accountId: number;
  source: SegmentRef & { label: string };
  target: SegmentRef & { label: string };
  protocol: NetworkLinkProtocol;
  port: number;
  origin: NetworkLinkOrigin;
  enabled: boolean;
  description: string | null;
  /** active = in the pushed policy; pending = waiting for the next push / a container; error = see statusMessage. */
  status: 'active' | 'pending' | 'error';
  statusMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NetworkLinkCreate {
  accountId: number;
  source: SegmentRef;
  target: SegmentRef;
  protocol?: NetworkLinkProtocol;
  /** Default: the target's natural port (MariaDB / MySQL 3306, PostgreSQL 5432, the single exposed port of an app service). */
  port?: number;
  description?: string | null;
}

export interface NetworkLinkUpdate {
  enabled?: boolean;
  description?: string | null;
  port?: number;
}

/** GET /network/segments?accountId — picker of the Network links page. */
export interface NetworkSegmentInfo {
  ref: SegmentRef;
  label: string;
  /** Fabric(s) the segment's containers sit on. */
  fabric: 'front' | 'back' | 'both' | 'none';
  containers: Array<{ name: string; network: string; ip: string | null }>;
  /** Ports a link may target (db: engine port; app service: exposed ports; site: none). */
  linkablePorts: number[];
}

export type NetworkPolicyMode = 'enforce' | 'monitor' | 'off';

export interface NetworkPoolStatus {
  name: 'fabric' | 'app';
  cidr: string;
  prefix: number;
  used: number;
  total: number;
}

/** GET /system/network (platform admin). */
export interface NetworkSystemStatus {
  mode: NetworkPolicyMode;
  pools: NetworkPoolStatus[];
  accounts: { segmented: number; legacy: number; failed: number };
  /** Last push to hostd PUT /v1/segments. */
  lastPushAt: string | null;
  lastPushError: string | null;
  bridges: number;
  rules: number;
  /** hostd counters of dropped frames (monitor / enforce), when available. */
  dropped: number | null;
}

export type NetworkFlowReason = 'edge' | 'panel' | 'link' | 'relay' | 'filesrv' | 'dbadmin' | 'intra';

/** GET /system/network/flows?accountId (platform admin, troubleshooting). */
export interface NetworkFlowView {
  bridge: string;
  src: { container: string; ip: string; segment: string };
  dst: { container: string; ip: string; segment: string };
  protocol: NetworkLinkProtocol;
  port: number;
  reason: NetworkFlowReason;
  linkId: number | null;
}

/** POST /system/network/migrate */
export interface NetworkMigrateRequest {
  /** One account, or every legacy account when absent. */
  accountId?: number;
}
