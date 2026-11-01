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

export type NetworkFlowReason = 'edge' | 'panel' | 'link' | 'relay' | 'filesrv' | 'dbadmin' | 'intra'
  /** Public port DNAT-ed by hostd to the container (port_bindings, network/publish.ts): troubleshooting view only. */
  | 'published';

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

// =============================================================================
// Public ports + dedicated IPs (migration 032, network foundation of the game
// servers). A BINDING = (account, public IP, public port, protocol) → (target,
// container port): hostd DNATs it (nftables, table ip oblimint_pub) to the
// FIXED IPv4 of the container on the account FRONT fabric, the source address
// preserved. Shared IP: a port POOL (platform setting network.publicPortPool),
// handed out to the accounts in BLOCKS (port_allocations) by the platform
// admin (plan limit publicPorts, per-account override). Dedicated IP: every
// port of it except the platform-reserved ones. Docker publishes nothing more.
// =============================================================================

/** Ports a published binding may never take, on every IP of the node (edge, SSH, DNS, mail, panel listeners). */
export const PLATFORM_RESERVED_PORTS: readonly number[] = [22, 25, 53, 80, 110, 143, 443, 465, 587, 993, 995, 4190, 8081, 8082, 8443];

/** Default public port pool of the shared IP (TCP and UDP). */
export const DEFAULT_PUBLIC_PORT_POOL = { from: 20000, to: 40000 } as const;

export interface PortRange {
  from: number;
  to: number;
}

export type PublicIpKind = 'shared' | 'dedicated';
/** managed: hostd adds the address to the interface (and removes it); external: configured in the OS, hostd only checks it. */
export type PublicIpManagement = 'managed' | 'external';
export type PublicIpStatus = 'pending' | 'active' | 'missing' | 'error';

/** GET /system/network/public-ips (platform admin). */
export interface PublicIp {
  id: number;
  nodeId: number;
  /** Public IPv4 (the one of the DNS records). */
  address: string;
  /** Address actually on the interface (1:1 NAT of a cloud), null = address. */
  localAddress: string | null;
  prefixLen: number;
  interface: string | null;
  kind: PublicIpKind;
  management: PublicIpManagement;
  tenantId: number | null;
  accountId: number | null;
  accountUsername: string | null;
  /** The account serves 80 / 443 of this IP itself (its sites then go through the edge on the shared IP). */
  takeoverWeb: boolean;
  /** Outbound traffic of the account's containers leaves through this IP (SNAT). */
  snatOutbound: boolean;
  status: PublicIpStatus;
  statusMessage: string | null;
  checkedAt: string | null;
  description: string | null;
  /** Bindings using it. */
  bindings: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublicIpCreate {
  address: string;
  localAddress?: string | null;
  prefixLen?: number;
  interface?: string | null;
  management?: PublicIpManagement;
  description?: string | null;
}

export type PublicIpUpdate = Partial<Omit<PublicIpCreate, 'address'>>;

/** PUT /accounts/:id/network/dedicated-ip (platform admin). */
export interface DedicatedIpAssign {
  publicIpId: number | null;
  takeoverWeb?: boolean;
  snatOutbound?: boolean;
}

export type PortBlockOrigin = 'plan' | 'manual';

export interface PortBlock extends PortRange {
  id: number;
  origin: PortBlockOrigin;
  createdAt: string;
}

export type PortBindingStatus = 'pending' | 'active' | 'inactive' | 'error';
/** Kind of target of a binding ('game' comes with the game servers). */
export type PortBindingTarget = 'app';

export interface PortBinding {
  id: number;
  accountId: number;
  targetKind: PortBindingTarget;
  stackId: number | null;
  stackName: string | null;
  service: string | null;
  publicIpId: number;
  /** Public address of the IP (never an internal address). */
  address: string;
  dedicated: boolean;
  protocol: 'tcp' | 'udp';
  publicPort: number;
  containerPort: number;
  status: PortBindingStatus;
  statusMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * ok: the blocks match the target; shortfall: fewer ports than the target (pool too small / fragmented);
 * excess: more (a shrink is blocked by ports in use); none: no target, no block.
 */
export type AccountPortsState = 'ok' | 'shortfall' | 'excess' | 'none';

/** GET /accounts/:id/network/ports */
export interface AccountPortsInfo {
  accountId: number;
  /** override ?? plan value. */
  target: number;
  source: 'plan' | 'override';
  planValue: number;
  override: number | null;
  allocated: number;
  /** Allocated ports that carry at least one binding (tcp or udp). */
  used: number;
  blocks: PortBlock[];
  state: AccountPortsState;
  sharedIp: { id: number; address: string } | null;
  dedicatedIp: {
    id: number; address: string; takeoverWeb: boolean; snatOutbound: boolean; status: PublicIpStatus; statusMessage: string | null;
  } | null;
  bindings: PortBinding[];
  /** The caller may change the allocation / the dedicated IP (platform admin). */
  canManage: boolean;
}

/** PUT /accounts/:id/network/ports and POST …/ports/preview. count null = back to the plan value. */
export interface PortAllocationRequest {
  count?: number | null;
  /** Explicit block (manual): added to the account's blocks; the override becomes the new total. */
  range?: PortRange | null;
  /** prefer (default): one block when possible, else the lowest free ports in several blocks; require: one block or a refusal. */
  contiguous?: 'prefer' | 'require';
}

export interface PortAllocationPreview {
  /** Blocks after the change. */
  blocks: PortRange[];
  added: PortRange[];
  removed: PortRange[];
  total: number;
  /** Refusal the same PUT would answer (code: portPoolExhausted, portPoolNoContiguousBlock, portsInUse, portRangeUnavailable…). */
  error: { code: string; message: string; details?: unknown } | null;
}

export interface ReservedPortRange extends PortRange {
  /** fixed, panel, sftp, sql, dns, stream, extra, host (a socket of the node). */
  reason: string;
}

/** GET /system/network/ports (platform admin). */
export interface PortPoolStatus {
  pool: PortRange;
  extra: Array<number | PortRange>;
  /** Reserved ranges inside the pool (automatic + extra). */
  reserved: ReservedPortRange[];
  /** Usable numbers of the pool (each for tcp AND udp). */
  capacity: number;
  allocated: number;
  free: number;
  largestFreeBlock: number;
  sharedIp: { id: number; address: string } | null;
  accounts: Array<{ accountId: number; username: string; tenantId: number; blocks: PortRange[]; total: number; target: number }>;
}

/** Publication state of hostd (GET /v1/publish) + the last push of the panel. */
export interface PublishStatus {
  /** iptables-nft / iptables-legacy: Docker's iptables backend (rule in DOCKER-USER); docker-nftables: Docker 29 nftables backend (bridge-accept-fwmark); none: no Docker firewall found. */
  backend: 'iptables-nft' | 'iptables-legacy' | 'docker-nftables' | 'none' | 'unknown';
  dockerAccept: 'ok' | 'missing' | 'fwmarkMissing' | 'unknown';
  remediation: string | null;
  rules: number;
  published: number | null;
  lastApplyAt: string | null;
  lastApplyError: string | null;
  lastPushAt: string | null;
  lastPushError: string | null;
  /** hostd answered (false: older hostd or unreachable). */
  available: boolean;
}

/** GET /system/network/interfaces */
export interface NetInterface {
  name: string;
  addresses: string[];
  up: boolean;
  /** Carries the default route (SNAT possible). */
  defaultRoute: boolean;
}
