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
  /**
   * Default site → DB link (origin 'migration') the panel no longer manages: the user
   * edited / disabled it (or the 030 backfill kept it as it was). An unpinned default
   * link follows the database attachments (enabled while the site has a reason to
   * reach the instance, disabled otherwise). Always false for the other links.
   */
  pinned?: boolean;
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
  name: 'fabric' | 'app' | 'platform';
  cidr: string;
  prefix: number;
  used: number;
  total: number;
  /** The pool setting is invalid (e.g. a managed prefix longer than /26): nothing can be allocated from it. */
  error?: string;
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
  /** Fixed container addresses (migration 031, network/addresses.ts); null when Docker could not be read. */
  addresses: NetworkAddressStatus | null;
}

/** Docker accepts a static IPv4 on this network? (probe / Docker ≥ 29 / subnet chosen by the panel). */
export type NetworkStaticIpSupport = 'unknown' | 'supported' | 'refused';

/**
 * Fixed addresses of the managed networks (account fabrics + platform networks). An endpoint is
 * "pinned" when Docker holds its allocated address as a static one (IPAMConfig): it survives reboots,
 * restarts and recreation order, so the rules hostd persisted stay right. Unpinned endpoints keep
 * their dynamic address until the next pinning sweep (Settings → Network, or the staff action).
 */
export interface NetworkAddressStatus {
  /** Endpoints whose static address in Docker is their allocation. */
  pinned: number;
  /** Endpoints with a dynamic address (or a static one that is not their allocation) on a network that supports static addresses. */
  unpinned: number;
  /** Endpoints whose observed address is not their allocation (no flow for them on a fabric) or whose allocation is held by another container. */
  conflicts: number;
  /** Managed networks where Docker refuses static addresses (Docker ≤ 28 + subnet chosen by Docker): to recreate, or Docker to update. */
  refusedNetworks: string[];
  /** Managed networks whose support is not known yet (probe pending). */
  unknownNetworks: string[];
  /** Last pinning sweep (ISO) and its error, if any. */
  lastSweepAt: string | null;
  lastSweepError: string | null;
  /** Settings → Network: 'auto' pins the running containers at every sweep, 'manual' only on the staff action. */
  pinning: 'auto' | 'manual';
}

/** POST /system/network/pin */
export interface NetworkPinResult {
  pinned: number;
  failed: number;
  skipped: number;
  status: NetworkSystemStatus;
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
