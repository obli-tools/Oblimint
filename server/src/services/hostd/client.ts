import http from 'http';
import type { AccessMode, QuotaMode } from '@oblimint/shared';
import { config } from '../../config';

// ─────────────────────────────────────────────────────────────────────────────
// Typed client of the hostd API (unix socket, docs/P1-PLAN.md §4/§7).
// OWNED BY MODULE `hostd` (P1), `hostd-firewall` (P2), `overlay-hostd` (P3: signatures of the
// P3 methods are frozen — docs/P3-PLAN.md §5). Talks JSON over HTTP on config.hosting.hostdSocket
// (http.request({ socketPath })).
//
// hostd never takes arbitrary paths from the panel: it computes every path
// from its own root (/srv/oblimint) and the ids / slugs it receives, and
// validates them (slug ^[a-z0-9][a-z0-9-]{0,39}$, data path = normalizeRelPath).
// Only fsInfo() and du() send an absolute path, which must lie inside the root.
//
// Errors: non-2xx → HostdError(status, body.error, body.code) with hostd codes
// `invalid` (400), `notFound` (404), `unsafePath` (409: a symlink / non
// directory on the path), `busy` (409: a long seed / clear / purge holds the
// account for more than 20 s, retry later), `cancelled` (503: hostd stopped
// because this client went away), `unsupported` (501), `internal` (500); socket
// unreachable → HostdError(503, …, 'hostdUnavailable'); timeout →
// HostdError(504, …, 'hostdTimeout'); remote node → HostdError(501, …, 'nodeNotSupported').
// ─────────────────────────────────────────────────────────────────────────────

export interface HostdHealth { ok: boolean; version: string }

export interface HostdFsInfo {
  path: string;
  fsType: string;
  mountPoint: string;
  options: string[];
  projectQuota: boolean;
}

export interface HostdAccountSpec {
  accountId: number;
  uid: number;
  gid: number;
  /** Hard limit in MiB, null = no limit. */
  quotaMb: number | null;
}

export interface HostdSiteSpec {
  accountId: number;
  siteId: number;
  slug: string;
  uid: number;
  gid: number;
}

export interface HostdUsage {
  accountId: number;
  usedBytes: number;
  /** null = no limit set. */
  quotaBytes: number | null;
  mode: QuotaMode;
  measuredAt: string;
}

// ─── P2 (docs/P2-PLAN.md §hostd) ─────────────────────────────────────────────

/** Database instance dirs: dbsock/i-<id> (uid:gid 0750) + databases/<id> (uid:gid 0700) under the account tree. */
export interface HostdDbInstanceSpec {
  accountId: number;
  instanceId: number;
  uid: number;
  gid: number;
}

/**
 * Full allow-list state of ONE account, rendered by hostd into the nftables
 * table `inet oblimint` (atomic `nft -f`) and used by the gateway listeners.
 * Addresses are validated by hostd again (IP / CIDR, v4 or v6).
 */
export interface HostdFirewallAccountState {
  accountId: number;
  mode: AccessMode;
  /** Host ports owned by the hostd gateway (file server): filtered on the INPUT hook. */
  gatewayPorts: number[];
  /** Host ports published by Docker (external SQL): filtered on FORWARD with `ct original proto-dst`. */
  publishedPorts: number[];
  /** Manual rules + auto-2fa grants (allowlist / auto-2fa modes; ignored in open mode). */
  allow: Array<{ cidr: string; expiresAt: string | null }>;
  /** Active bans (every mode). */
  bans: Array<{ ip: string; expiresAt: string }>;
}

/** Platform-wide part: egress filter of the account networks (audit R-EGRESS). */
export interface HostdFirewallGlobal {
  egress: 'off' | 'metadata' | 'strict';
  /** Subnets of every account network (from Docker): sources the egress rules apply to. */
  accountSubnets: string[];
  /** Destinations always allowed from the account networks (panel network, DNS resolvers…). */
  egressAllow: string[];
}

/**
 * P4 — bans on the SHARED mail ports (docs/P4-PLAN.md §8). hostd renders them
 * as an nftables set (timeouts) in table inet oblimint: drops only, before
 * Docker, on the forward path of the published mail ports (ct original
 * proto-dst) and on input for the same ports. Replaces the whole state.
 */
export interface HostdMailFirewallState {
  /** Host ports of the mail service (25, 465, 587, 143, 993, 110, 995, 4190). Empty = no rule. */
  ports: number[];
  /** Banned addresses / prefixes (IPv4 address, IPv6 address or /64), with expiry. */
  bans: Array<{ cidr: string; expiresAt: string }>;
}

/**
 * P4b — segment policy of the account fabrics (docs/P4b-PLAN.md §4.4; module
 * segmentation implements the Go side, hostd/segments.go). hostd renders ONE
 * nftables table `bridge oblimint_seg` (replaced atomically with nft -f):
 * frames bridged between two ports of a listed bridge are dropped (enforce)
 * or counted + logged (monitor) unless (src, dst, proto, dport) is allowed;
 * replies are matched statelessly (src/dst swapped, sport = port, TCP without
 * a bare SYN). Frames to / from the bridge itself (gateway: Internet, host)
 * are never touched (egress stays the P2 firewall's job).
 */
export interface HostdSegmentState {
  mode: 'enforce' | 'monitor' | 'off';
  /**
   * Bridge interface names of the managed fabrics (≤ 15 chars, [a-zA-Z0-9_.-]).
   * 'platform' (accountId 0): a platform network ('oblimint', 'oblimint-mail'…,
   * network/platform.ts); isolation 'listed' lets frames between two
   * NON-restricted containers through (account fabrics: always 'all').
   */
  bridges: Array<{ name: string; accountId: number; fabric: 'front' | 'back' | 'platform'; isolation?: 'all' | 'listed' }>;
  /** Allowed flows; src / dst are IPv4 addresses of containers on that bridge. */
  allow: Array<{ bridge: string; src: string; dst: string; protocol: 'tcp' | 'udp'; port: number }>;
  /** IPv4 of the containers a 'listed' platform bridge filters (edge, phpMyAdmin / Adminer). */
  restricted?: string[];
  /**
   * Node ports reachable from the platform bridges (table inet oblimint_seghost:
   * any other NEW connection from a platform bridge to a local address of the
   * node is dropped). src: one container only (absent: every container of the bridge).
   */
  host?: Array<{ bridge: string; src?: string; protocol: 'tcp' | 'udp'; port: number }>;
}

export interface HostdSegmentStatus {
  backend: 'nftables' | 'none';
  mode: 'enforce' | 'monitor' | 'off';
  bridges: number;
  rules: number;
  /** Frames dropped (enforce) / that would have been dropped (monitor) since the last apply. */
  dropped: number | null;
  /** Platform bridges filtered (hostd ≥ 0.6.1; absent on older builds). */
  platformBridges?: number;
  /** New connections from platform bridges to the node itself dropped (logged in monitor). */
  hostDropped?: number | null;
  lastApplyAt: string | null;
  lastApplyError: string | null;
}

/**
 * P4b — platform web bans on the edge ports (docs/P4b-PLAN.md §9.4; module
 * honeypot-bans implements the Go side, hostd/webbans.go): table
 * `inet oblimint_web`, drops only, before Docker (forward on ct original
 * proto-dst ∈ ports, input for the same ports), sets with timeouts (no
 * timeout = permanent). Replaces the whole state.
 */
export interface HostdWebFirewallState {
  /** 80 and 443 (+ approved stream ports when wanted). */
  ports: number[];
  /** IPv4 address or IPv6 /64; expiresAt null = permanent. */
  bans: Array<{ cidr: string; expiresAt: string | null }>;
}

export interface HostdFirewallStatus {
  backend: 'nftables' | 'none';
  accounts: number;
  lastApplyAt: string | null;
  lastApplyError: string | null;
  gatewayListeners: number;
  /** Accounts hostd holds a firewall / gateway state for (hostd ≥ 0.3.0): the panel drops those of deleted accounts. */
  accountIds?: number[];
  gatewayAccountIds?: number[];
  /** P4: bans currently applied on the mail ports (hostd ≥ 0.5.0). */
  mailBans?: number;
}

/** Port gateway of an account's file server (socket activation + PROXY protocol v2). */
export interface HostdGatewaySpec {
  accountId: number;
  /** Host port hostd listens on (IPv4 + IPv6). */
  port: number;
  /** Current backend (file server container IP on the account network : 2022), null = stopped (hold + activate). */
  target: { ip: string; port: number } | null;
  /** Send a PROXY protocol v2 header to the backend (SFTPGo proxy_protocol). */
  proxyProtocol: boolean;
  /** No connection for this long → 'idle' event, repeated every 5 min while still idle (0 = never). */
  idleTimeoutSec: number;
  /** How long an accepted connection waits for a target after an 'activate' event (s). */
  activationWaitSec: number;
}

export type HostdGatewayEventKind = 'activate' | 'idle' | 'refused';

export interface HostdGatewayEvent {
  accountId: number;
  kind: HostdGatewayEventKind;
  at: string;
  /** activate / refused: the client address. */
  remoteIp: string | null;
}

// ─── P3 (docs/P3-PLAN.md §5 hostd) ───────────────────────────────────────────

/**
 * Modification window of a site: overlay mounted by hostd OVER
 * sites/<siteId>/releases/<releaseNumber> in the host mount namespace
 * (lowerdir = RO bind windows/<w>/lower of that release, upperdir/workdir =
 * windows/<w>/{upper,work}, options metacopy=on,redirect_dir=on, nosuid,nodev),
 * propagated (rslave) into every container of the site. rw: the merged view is
 * made writable by the account uid (metadata-only chown walk); ro: frozen view
 * (lowerdir = upper:lower, no upper) — same content, no write possible.
 * quarantineExecutables (supervised mode): every executable file written in the
 * upper layer is moved to the quarantine store and reverted at once.
 */
export interface HostdWindowSpec extends HostdSiteSpec {
  windowId: number;
  releaseNumber: number;
  mode: 'rw' | 'ro';
  quarantineExecutables: boolean;
}

export interface HostdWindowStatus {
  accountId: number;
  siteId: number;
  windowId: number;
  mounted: boolean;
  mode: 'rw' | 'ro' | null;
  releaseNumber: number | null;
  quarantineExecutables: boolean;
  /** Size / entries of the upper layer (metadata-only copies excluded). */
  upperBytes: number;
  upperEntries: number;
  /** export/manifest.json exists (exportWindow done since the last write). */
  exportReady: boolean;
}

export type HostdChangeKind = 'added' | 'modified' | 'deleted' | 'typechange';

/** One entry of export/manifest.json (diff lower ↔ merged, restricted to the paths the upper layer touches). */
export interface HostdDiffEntry {
  /** Relative POSIX path in the release. */
  path: string;
  change: HostdChangeKind;
  type: 'file' | 'symlink' | 'dir';
  /** New size (file), null for deletions / dirs. */
  size: number | null;
  /** New permission bits (e.g. 420 = 0644). */
  mode: number | null;
  sha256: string | null;
  /** symlink target (never resolved). */
  linkTarget: string | null;
  /** Content copied to export/files/<path> (regular files and symlinks). */
  exported: boolean;
  skipped: 'tooLarge' | 'special' | null;
}

/** export/manifest.json (read by the panel from localPaths.windowManifest). */
export interface HostdWindowManifest {
  version: 1;
  windowId: number;
  releaseNumber: number;
  createdAt: string;
  entries: HostdDiffEntry[];
  truncated: boolean;
}

export interface HostdExportOptions {
  /** Larger files are listed (sha256 + size) but not copied (skipped: 'tooLarge'). */
  maxFileBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
}

export interface HostdWindowExportResult {
  entries: number;
  added: number;
  modified: number;
  deleted: number;
  bytes: number;
  truncated: boolean;
}

export interface HostdPropagationResult {
  pid: number;
  /** The overlay is visible at /srv/releases/<n> in that process' mount namespace. */
  visible: boolean;
  mode: 'rw' | 'ro' | null;
  error: string | null;
}

export interface HostdMountedWindow {
  accountId: number;
  siteId: number;
  windowId: number;
  mode: 'rw' | 'ro';
  releaseNumber: number;
}

export type HostdChangeSource = { kind: 'window'; windowId: number } | { kind: 'workspace'; workspaceId: number };

export interface HostdStagingChange {
  path: string;
  op: 'write' | 'delete';
}

export interface HostdStagingApplyResult {
  written: number;
  deleted: number;
  /** Paths not applied: a symlink / file in the way (R1), missing source, invalid path. */
  conflicts: Array<{ path: string; reason: 'symlink' | 'notDirectory' | 'missingSource' | 'invalid' }>;
}

export interface HostdWorkspaceSpec extends HostdSiteSpec {
  workspaceId: number;
  /** Release copied into work/<workspaceId>/tree (owned by uid:gid, files 0644 / dirs 0755, symlinks kept). */
  releaseNumber: number;
}

/** Typed data paths hostd watches (inotify) for one site: extension whitelist + content sniffing → quarantine. */
export interface HostdWatchSpec extends HostdSiteSpec {
  typed: Array<{ path: string; allowedExtensions: string[] }>;
}

export type HostdQuarantineReason = 'extension' | 'php-content' | 'polyglot' | 'magic-mismatch' | 'executable-write' | 'special';

export interface HostdQuarantineEntry {
  /** Opaque id (^[0-9a-z-]{8,64}$), directory name in accounts/<id>/quarantine/. */
  id: string;
  accountId: number;
  siteId: number | null;
  slug: string | null;
  source: 'typed' | 'supervised';
  /** data: under data/<slug>/ ; code: in the window overlay of the site. */
  area: 'data' | 'code';
  /** Relative to data/<slug>/ (area data) or to the release root (area code). */
  path: string;
  dataPath: string | null;
  reason: HostdQuarantineReason;
  detail: string | null;
  size: number;
  sha256: string;
  detectedType: string | null;
  quarantinedAt: string;
  /** Present once restored (the entry is kept until deleted). */
  restoredAt: string | null;
}

export type HostdEventKind = 'quarantined' | 'watchError' | 'windowLost';

export interface HostdEvent {
  /** Monotonic within one hostd process (restarts at 1 when hostd restarts: the panel resyncs). */
  seq: number;
  at: string;
  kind: HostdEventKind;
  accountId: number;
  siteId: number | null;
  windowId: number | null;
  entryId: string | null;
  message: string | null;
}

export class HostdError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = 'HostdError';
  }
}

export interface HostdClient {
  health(): Promise<HostdHealth>;
  fsInfo(path?: string): Promise<HostdFsInfo>;
  /** Idempotent: account tree with ownership + project quota. */
  ensureAccount(spec: HostdAccountSpec): Promise<{ quotaMode: QuotaMode }>;
  setQuota(accountId: number, quotaMb: number | null): Promise<{ quotaMode: QuotaMode }>;
  usage(accountId: number): Promise<HostdUsage>;
  /** purge=false: keep the files (only the quota project is released). */
  removeAccount(accountId: number, opts: { purge: boolean }): Promise<void>;
  /** Idempotent: staging/<slug>, data/<slug> (uid:gid) + sites/<siteId>/{releases,runtime} (root). */
  ensureSite(spec: HostdSiteSpec): Promise<void>;
  removeSite(accountId: number, siteId: number, slug: string, opts: { purge: boolean }): Promise<void>;
  /** Creates data/<slug>/<path> for each path (uid:gid 0750), idempotent. */
  ensureDataPaths(spec: HostdSiteSpec, paths: string[]): Promise<void>;
  /** Copies staging/<slug>/<path> into data/<slug>/<path> when the data dir is empty (no symlink followed). */
  seedDataPath(spec: HostdSiteSpec, path: string): Promise<{ copied: boolean; files: number }>;
  /** Empties data/<slug>/<path> (ephemeral policy), keeps the directory. */
  clearDataPaths(spec: HostdSiteSpec, paths: string[]): Promise<void>;
  /** Bytes used under an absolute path INSIDE hostd's root. */
  du(path: string): Promise<number>;

  // ── P2 — databases (module databases consumes, hostd-firewall implements in Go) ──
  /** Idempotent: dbsock/i-<id> (uid:gid 0750) and databases/<id> (uid:gid 0700); ensureAccount creates dbsock/{mysql,postgresql} (root:gid 0750). */
  ensureDbInstance(spec: HostdDbInstanceSpec): Promise<void>;
  /** purge=false keeps databases/<id> (data) — only the socket dir and its default symlinks go. */
  removeDbInstance(accountId: number, instanceId: number, opts: { purge: boolean }): Promise<void>;
  /** (Re)points dbsock/<family>/<socket name> to /run/oblimint-db/i-<id>/<socket name>; null removes the symlink. */
  setDefaultDbSocket(accountId: number, family: 'mysql' | 'postgresql', instanceId: number | null): Promise<void>;

  // ── P2 — firewall + port gateway (module hostd-firewall) ──
  applyFirewall(state: HostdFirewallAccountState): Promise<void>;
  removeFirewall(accountId: number): Promise<void>;
  setFirewallGlobal(global: HostdFirewallGlobal): Promise<void>;
  firewallStatus(): Promise<HostdFirewallStatus>;
  setGateway(spec: HostdGatewaySpec): Promise<void>;
  removeGateway(accountId: number): Promise<void>;
  /** Long poll: returns as soon as events exist, or [] after waitSec (≤ 55). */
  gatewayEvents(waitSec: number): Promise<HostdGatewayEvent[]>;

  // ── P4 — bans on the shared mail ports (module outbound-security implements the Go side) ──
  /** PUT /v1/firewall/mail — replaces the mail ports + bans state (idempotent). */
  setMailFirewall(state: HostdMailFirewallState): Promise<void>;

  // ── P4b — segment policy (module segmentation) + web bans (module honeypot-bans), hostd ≥ 0.6.0 ──
  /** PUT /v1/segments — replaces the whole segment policy (idempotent). */
  setSegments(state: HostdSegmentState): Promise<void>;
  /** GET /v1/segments */
  segmentsStatus(): Promise<HostdSegmentStatus>;
  /** PUT /v1/firewall/web — replaces the platform web bans (idempotent). */
  setWebFirewall(state: HostdWebFirewallState): Promise<void>;

  // ── P3 — windows, workspaces, staging reflection, typed watcher, quarantine (module overlay-hostd) ──
  /** Idempotent: mounts (or switches the mode of) the window overlay over releases/<releaseNumber>. 409 conflict: another window / release mounted. */
  ensureWindow(spec: HostdWindowSpec): Promise<HostdWindowStatus>;
  windowStatus(accountId: number, siteId: number, windowId: number): Promise<HostdWindowStatus>;
  /** Diff lower ↔ merged into windows/<w>/export/{manifest.json,files/} (replaces a previous export). */
  exportWindow(spec: HostdSiteSpec & { windowId: number }, opts: HostdExportOptions): Promise<HostdWindowExportResult>;
  /** Unmounts the overlay + lower bind, removes upper/work (and export unless keepExport). Idempotent. */
  removeWindow(spec: HostdSiteSpec & { windowId: number }, opts: { keepExport: boolean }): Promise<void>;
  /** Checks /proc/<pid>/mountinfo of container init processes (docker inspect State.Pid). */
  verifyWindowPropagation(accountId: number, siteId: number, windowId: number, pids: number[]): Promise<HostdPropagationResult[]>;
  /** Every window overlay currently mounted (boot recovery). */
  listWindows(): Promise<HostdMountedWindow[]>;
  /** Writes / deletes paths of staging/<slug> from a window export or a workspace, as uid:gid, never through a symlink (R1). */
  applyToStaging(spec: HostdSiteSpec, source: HostdChangeSource, changes: HostdStagingChange[]): Promise<HostdStagingApplyResult>;
  /** Copy of releases/<n> into work/<id>/tree owned by uid:gid (reflink when possible). */
  ensureWorkspace(spec: HostdWorkspaceSpec): Promise<{ files: number; bytes: number }>;
  removeWorkspace(spec: HostdSiteSpec & { workspaceId: number }): Promise<void>;
  /** Replaces the typed-path watch of a site (empty typed list = no watch). Existing non-conforming files are quarantined at once. */
  setWatch(spec: HostdWatchSpec): Promise<{ watching: number; quarantined: number }>;
  removeWatch(accountId: number, siteId: number): Promise<void>;
  listQuarantine(accountId: number): Promise<HostdQuarantineEntry[]>;
  /** Moves the file back (as uid:gid, no symlink followed) and allow-lists its sha256 at that path for the watcher. */
  restoreQuarantine(accountId: number, entryId: string, opts: { uid: number; gid: number; overwrite: boolean }): Promise<{ restored: boolean; path: string }>;
  /** Deletes the entry (content + meta) for good. */
  deleteQuarantine(accountId: number, entryId: string): Promise<void>;
  quarantinePreview(accountId: number, entryId: string, maxBytes: number): Promise<{ base64: string; truncated: boolean; size: number }>;
  /** Long poll of hostd events with seq > since (≤ 55 s). */
  events(since: number, waitSec: number): Promise<{ events: HostdEvent[]; next: number }>;
}

// ─── Transport ───────────────────────────────────────────────────────────────

/** Per-call timeouts (ms). Walking a big tree (usage in measured mode, du) or
 *  copying a seed can be long. */
export const HOSTD_TIMEOUTS = {
  default: 30_000,
  usage: 120_000,
  du: 120_000,
  seed: 10 * 60_000,
  /** P2: long poll of the gateway events (waitSec + margin). */
  events: 70_000,
  /** P3: mount + chown walk of a big release, export of a big change set, workspace copy, staging apply. */
  window: 10 * 60_000,
} as const;

export interface HostdClientOptions {
  /** Unix socket (or Windows named pipe in tests). */
  socketPath: string;
  /** Overrides of HOSTD_TIMEOUTS (tests). */
  timeouts?: Partial<Record<keyof typeof HOSTD_TIMEOUTS, number>>;
}

/** Hard cap on a response body: every hostd answer is a small JSON object… */
const MAX_RESPONSE_BYTES = 1024 * 1024;
/** …except the quarantine list of an account (P3), which grows with every entry kept as evidence. */
const MAX_LIST_RESPONSE_BYTES = 64 * 1024 * 1024;

type Method = 'GET' | 'PUT' | 'POST' | 'DELETE';

function request<T>(socketPath: string, method: Method, path: string, body: unknown, timeoutMs: number, maxResponseBytes = MAX_RESPONSE_BYTES): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    let settled = false;
    const fail = (err: HostdError) => {
      if (!settled) { settled = true; reject(err); }
    };

    const req = http.request({
      socketPath,
      method,
      path,
      headers: {
        Host: 'hostd',
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxResponseBytes) {
          fail(new HostdError(502, `hostd ${method} ${path}: response too large`, 'hostdBadResponse'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('error', (err) => fail(new HostdError(503, `hostd ${method} ${path}: ${err.message}`, 'hostdUnavailable')));
      res.on('end', () => {
        if (settled) return;
        const status = res.statusCode ?? 0;
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = undefined;
        try { json = text ? JSON.parse(text) : undefined; } catch { /* handled below */ }
        if (status < 200 || status >= 300) {
          const msg = typeof json?.error === 'string' ? json.error : (text.trim() || `HTTP ${status}`);
          fail(new HostdError(status, `hostd ${method} ${path}: ${msg}`, typeof json?.code === 'string' ? json.code : undefined));
          return;
        }
        if (json === undefined) {
          fail(new HostdError(502, `hostd ${method} ${path}: invalid JSON response`, 'hostdBadResponse'));
          return;
        }
        settled = true;
        resolve(json as T);
      });
    });

    req.setTimeout(timeoutMs, () => {
      fail(new HostdError(504, `hostd ${method} ${path}: no answer after ${Math.round(timeoutMs / 1000)} s`, 'hostdTimeout'));
      req.destroy();
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      fail(new HostdError(503, `hostd unreachable (${socketPath}): ${err.code ?? err.message}`, 'hostdUnavailable'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function id(n: number, what: string): number {
  if (!Number.isSafeInteger(n) || n <= 0) throw new HostdError(400, `hostd: invalid ${what} ${n}`, 'invalid');
  return n;
}

const siteBody = (s: HostdSiteSpec) => ({ slug: s.slug, uid: s.uid, gid: s.gid });
const sitePath = (s: HostdSiteSpec) => `/v1/accounts/${id(s.accountId, 'account id')}/sites/${id(s.siteId, 'site id')}`;
const siteIdsPath = (accountId: number, siteId: number) => `/v1/accounts/${id(accountId, 'account id')}/sites/${id(siteId, 'site id')}`;
const windowPath = (s: HostdSiteSpec, windowId: number) => `${sitePath(s)}/windows/${id(windowId, 'window id')}`;

/** Quarantine entry ids are opaque but never a path (R2). */
function entry(entryId: string): string {
  if (typeof entryId !== 'string' || !/^[0-9a-z-]{8,64}$/.test(entryId)) throw new HostdError(400, `hostd: invalid quarantine entry ${String(entryId)}`, 'invalid');
  return entryId;
}

/** Client bound to one socket (no database access: usable in tests). */
export function createHostdClient(opts: HostdClientOptions): HostdClient {
  const t = { ...HOSTD_TIMEOUTS, ...opts.timeouts };
  const call = <T>(method: Method, path: string, body?: unknown, timeout: number = t.default, maxResponseBytes?: number) =>
    request<T>(opts.socketPath, method, path, body, timeout, maxResponseBytes);

  return {
    health: () => call<HostdHealth>('GET', '/v1/health'),

    fsInfo: (path) => call<HostdFsInfo>('GET', path ? `/v1/fs?path=${encodeURIComponent(path)}` : '/v1/fs'),

    ensureAccount: async (spec) => {
      const r = await call<{ quotaMode: QuotaMode }>('PUT', `/v1/accounts/${id(spec.accountId, 'account id')}`,
        { uid: spec.uid, gid: spec.gid, quotaMb: spec.quotaMb });
      return { quotaMode: r.quotaMode };
    },

    setQuota: async (accountId, quotaMb) => {
      const r = await call<{ quotaMode: QuotaMode }>('PUT', `/v1/accounts/${id(accountId, 'account id')}/quota`, { quotaMb });
      return { quotaMode: r.quotaMode };
    },

    usage: async (accountId) => call<HostdUsage>('GET', `/v1/accounts/${id(accountId, 'account id')}/usage`, undefined, t.usage),

    removeAccount: async (accountId, { purge }) => {
      await call('DELETE', `/v1/accounts/${id(accountId, 'account id')}?purge=${purge ? 1 : 0}`, undefined, purge ? t.seed : t.default);
    },

    ensureSite: async (spec) => {
      await call('PUT', sitePath(spec), siteBody(spec));
    },

    removeSite: async (accountId, siteId, slug, { purge }) => {
      const q = new URLSearchParams({ slug, purge: purge ? '1' : '0' });
      await call('DELETE', `/v1/accounts/${id(accountId, 'account id')}/sites/${id(siteId, 'site id')}?${q}`,
        undefined, purge ? t.seed : t.default);
    },

    ensureDataPaths: async (spec, paths) => {
      await call('PUT', `${sitePath(spec)}/data-paths`, { ...siteBody(spec), paths });
    },

    seedDataPath: async (spec, path) => {
      const r = await call<{ copied: boolean; files: number }>('POST', `${sitePath(spec)}/data-paths/seed`,
        { ...siteBody(spec), path }, t.seed);
      return { copied: r.copied, files: r.files };
    },

    clearDataPaths: async (spec, paths) => {
      await call('POST', `${sitePath(spec)}/data-paths/clear`, { ...siteBody(spec), paths }, t.seed);
    },

    du: async (path) => {
      const r = await call<{ path: string; bytes: number }>('GET', `/v1/du?path=${encodeURIComponent(path)}`, undefined, t.du);
      return r.bytes;
    },

    // ── P2 ──
    ensureDbInstance: async (spec) => {
      await call('PUT', `/v1/accounts/${id(spec.accountId, 'account id')}/db-instances/${id(spec.instanceId, 'instance id')}`,
        { uid: spec.uid, gid: spec.gid });
    },

    removeDbInstance: async (accountId, instanceId, { purge }) => {
      await call('DELETE', `/v1/accounts/${id(accountId, 'account id')}/db-instances/${id(instanceId, 'instance id')}?purge=${purge ? 1 : 0}`,
        undefined, purge ? t.seed : t.default);
    },

    setDefaultDbSocket: async (accountId, family, instanceId) => {
      if (family !== 'mysql' && family !== 'postgresql') throw new HostdError(400, `hostd: invalid socket family ${String(family)}`, 'invalid');
      await call('PUT', `/v1/accounts/${id(accountId, 'account id')}/db-default/${family}`,
        { instanceId: instanceId === null ? null : id(instanceId, 'instance id') });
    },

    applyFirewall: async (state) => {
      await call('PUT', `/v1/firewall/accounts/${id(state.accountId, 'account id')}`, state);
    },

    removeFirewall: async (accountId) => {
      await call('DELETE', `/v1/firewall/accounts/${id(accountId, 'account id')}`);
    },

    setFirewallGlobal: async (global) => {
      await call('PUT', '/v1/firewall/global', global);
    },

    firewallStatus: () => call<HostdFirewallStatus>('GET', '/v1/firewall'),

    setMailFirewall: async (state) => {
      await call('PUT', '/v1/firewall/mail', state);
    },

    // P4b
    setSegments: async (state) => {
      await call('PUT', '/v1/segments', state);
    },
    segmentsStatus: () => call<HostdSegmentStatus>('GET', '/v1/segments'),
    setWebFirewall: async (state) => {
      await call('PUT', '/v1/firewall/web', state);
    },

    setGateway: async (spec) => {
      await call('PUT', `/v1/gateway/accounts/${id(spec.accountId, 'account id')}`, spec);
    },

    removeGateway: async (accountId) => {
      await call('DELETE', `/v1/gateway/accounts/${id(accountId, 'account id')}`);
    },

    gatewayEvents: async (waitSec) => {
      const w = Math.max(0, Math.min(55, Math.floor(waitSec)));
      const r = await call<{ events: HostdGatewayEvent[] }>('GET', `/v1/gateway/events?wait=${w}`, undefined, t.events);
      return Array.isArray(r.events) ? r.events : [];
    },

    // ── P3 (async: an invalid id rejects, it never throws synchronously) ──
    ensureWindow: async (spec) => call<HostdWindowStatus>('PUT', windowPath(spec, spec.windowId), {
      ...siteBody(spec),
      releaseNumber: id(spec.releaseNumber, 'release number'),
      mode: spec.mode === 'ro' ? 'ro' : 'rw',
      quarantineExecutables: spec.quarantineExecutables === true,
    }, t.window),

    windowStatus: async (accountId, siteId, windowId) =>
      call<HostdWindowStatus>('GET', `${siteIdsPath(accountId, siteId)}/windows/${id(windowId, 'window id')}`),

    exportWindow: async (spec, opts) => call<HostdWindowExportResult>('POST', `${windowPath(spec, spec.windowId)}/export`, {
      ...siteBody(spec), maxFileBytes: opts.maxFileBytes, maxTotalBytes: opts.maxTotalBytes, maxEntries: opts.maxEntries,
    }, t.window),

    removeWindow: async (spec, { keepExport }) => {
      const q = new URLSearchParams({ slug: spec.slug, keepExport: keepExport ? '1' : '0' });
      await call('DELETE', `${windowPath(spec, spec.windowId)}?${q}`, undefined, t.window);
    },

    verifyWindowPropagation: async (accountId, siteId, windowId, pids) => {
      const r = await call<{ results: HostdPropagationResult[] }>('POST',
        `${siteIdsPath(accountId, siteId)}/windows/${id(windowId, 'window id')}/verify`, { pids: pids.map((p) => id(p, 'pid')) });
      return Array.isArray(r.results) ? r.results : [];
    },

    listWindows: async () => {
      const r = await call<{ windows: HostdMountedWindow[] }>('GET', '/v1/windows');
      return Array.isArray(r.windows) ? r.windows : [];
    },

    applyToStaging: async (spec, source, changes) => call<HostdStagingApplyResult>('POST', `${sitePath(spec)}/staging/apply`, {
      ...siteBody(spec),
      source: source.kind === 'window'
        ? { kind: 'window', id: id(source.windowId, 'window id') }
        : { kind: 'workspace', id: id(source.workspaceId, 'workspace id') },
      changes,
    }, t.window),

    ensureWorkspace: async (spec) => {
      const r = await call<{ files: number; bytes: number }>('PUT', `${sitePath(spec)}/workspaces/${id(spec.workspaceId, 'workspace id')}`,
        { ...siteBody(spec), releaseNumber: id(spec.releaseNumber, 'release number') }, t.window);
      return { files: r.files, bytes: r.bytes };
    },

    removeWorkspace: async (spec) => {
      const q = new URLSearchParams({ slug: spec.slug });
      await call('DELETE', `${sitePath(spec)}/workspaces/${id(spec.workspaceId, 'workspace id')}?${q}`, undefined, t.window);
    },

    setWatch: async (spec) => {
      const r = await call<{ watching: number; quarantined: number }>('PUT', `${sitePath(spec)}/watch`, { ...siteBody(spec), typed: spec.typed }, t.seed);
      return { watching: r.watching, quarantined: r.quarantined };
    },

    removeWatch: async (accountId, siteId) => {
      await call('DELETE', `${siteIdsPath(accountId, siteId)}/watch`);
    },

    listQuarantine: async (accountId) => {
      const r = await call<{ entries: HostdQuarantineEntry[] }>('GET', `/v1/accounts/${id(accountId, 'account id')}/quarantine`, undefined, t.default, MAX_LIST_RESPONSE_BYTES);
      if (r?.entries == null) return [];
      // A malformed answer must not look like "nothing in quarantine" (the ingest would close rows as missing).
      if (!Array.isArray(r.entries)) throw new HostdError(502, `hostd GET /v1/accounts/${accountId}/quarantine: malformed entries`, 'hostdBadResponse');
      return r.entries;
    },

    restoreQuarantine: async (accountId, entryId, opts) => {
      const r = await call<{ restored: boolean; path: string }>('POST',
        `/v1/accounts/${id(accountId, 'account id')}/quarantine/${entry(entryId)}/restore`,
        { uid: opts.uid, gid: opts.gid, overwrite: opts.overwrite === true });
      return { restored: r.restored, path: r.path };
    },

    deleteQuarantine: async (accountId, entryId) => {
      await call('DELETE', `/v1/accounts/${id(accountId, 'account id')}/quarantine/${entry(entryId)}`);
    },

    quarantinePreview: async (accountId, entryId, maxBytes) => call<{ base64: string; truncated: boolean; size: number }>('GET',
      `/v1/accounts/${id(accountId, 'account id')}/quarantine/${entry(entryId)}/preview?max=${Math.max(1, Math.min(256 * 1024, Math.floor(maxBytes)))}`),

    events: async (since, waitSec) => {
      const w = Math.max(0, Math.min(55, Math.floor(waitSec)));
      const s = Math.max(0, Math.floor(since));
      const r = await call<{ events: HostdEvent[]; next: number }>('GET', `/v1/events?since=${s}&wait=${w}`, undefined, t.events);
      return { events: Array.isArray(r.events) ? r.events : [], next: typeof r.next === 'number' ? r.next : s };
    },
  };
}

// ─── Node resolution ─────────────────────────────────────────────────────────

/** Resolves whether a node is the local one (P1: hostd only on the local node). */
export type LocalNodeResolver = (nodeId: number) => Promise<boolean>;

async function dbIsLocal(nodeId: number): Promise<boolean> {
  // Lazy import: importing this module must not touch the database (tests, setup mode).
  const { db } = await import('../../db');
  const row = await db('nodes').where({ id: nodeId }).first('is_local');
  if (!row) throw new HostdError(404, `node ${nodeId} not found`, 'nodeNotFound');
  return row.is_local === true;
}

let resolveLocal: LocalNodeResolver = dbIsLocal;
const localCache = new Map<number, Promise<boolean>>();
let localClient: HostdClient | null = null;

/** Tests: replace the node resolver (null restores the database one) and clear caches. */
export function setLocalNodeResolver(resolver: LocalNodeResolver | null): void {
  resolveLocal = resolver ?? dbIsLocal;
  localCache.clear();
  localClient = null;
}

function isLocal(nodeId: number): Promise<boolean> {
  let p = localCache.get(nodeId);
  if (!p) {
    p = resolveLocal(nodeId);
    localCache.set(nodeId, p);
    p.catch(() => localCache.delete(nodeId)); // do not cache failures
  }
  return p;
}

function client(): HostdClient {
  if (!localClient) localClient = createHostdClient({ socketPath: config.hosting.hostdSocket });
  return localClient;
}

/**
 * hostd client of a node (P1: the local node only; other ids → HostdError 501
 * `nodeNotSupported`). The node lookup is done once per node and cached; it
 * happens on the first call, so hostdFor() itself never throws.
 */
export function hostdFor(nodeId: number): HostdClient {
  const target = async (): Promise<HostdClient> => {
    if (!(await isLocal(nodeId))) {
      throw new HostdError(501, `hostd: node ${nodeId} is not the local node (multi-node is not supported yet)`, 'nodeNotSupported');
    }
    return client();
  };
  return {
    health: async () => (await target()).health(),
    fsInfo: async (path) => (await target()).fsInfo(path),
    ensureAccount: async (spec) => (await target()).ensureAccount(spec),
    setQuota: async (accountId, quotaMb) => (await target()).setQuota(accountId, quotaMb),
    usage: async (accountId) => (await target()).usage(accountId),
    removeAccount: async (accountId, opts) => (await target()).removeAccount(accountId, opts),
    ensureSite: async (spec) => (await target()).ensureSite(spec),
    removeSite: async (accountId, siteId, slug, opts) => (await target()).removeSite(accountId, siteId, slug, opts),
    ensureDataPaths: async (spec, paths) => (await target()).ensureDataPaths(spec, paths),
    seedDataPath: async (spec, path) => (await target()).seedDataPath(spec, path),
    clearDataPaths: async (spec, paths) => (await target()).clearDataPaths(spec, paths),
    du: async (path) => (await target()).du(path),
    ensureDbInstance: async (spec) => (await target()).ensureDbInstance(spec),
    removeDbInstance: async (accountId, instanceId, opts) => (await target()).removeDbInstance(accountId, instanceId, opts),
    setDefaultDbSocket: async (accountId, family, instanceId) => (await target()).setDefaultDbSocket(accountId, family, instanceId),
    applyFirewall: async (state) => (await target()).applyFirewall(state),
    removeFirewall: async (accountId) => (await target()).removeFirewall(accountId),
    setFirewallGlobal: async (global) => (await target()).setFirewallGlobal(global),
    firewallStatus: async () => (await target()).firewallStatus(),
    setMailFirewall: async (state) => (await target()).setMailFirewall(state),
    setSegments: async (state) => (await target()).setSegments(state),
    segmentsStatus: async () => (await target()).segmentsStatus(),
    setWebFirewall: async (state) => (await target()).setWebFirewall(state),
    setGateway: async (spec) => (await target()).setGateway(spec),
    removeGateway: async (accountId) => (await target()).removeGateway(accountId),
    gatewayEvents: async (waitSec) => (await target()).gatewayEvents(waitSec),
    // P3
    ensureWindow: async (spec) => (await target()).ensureWindow(spec),
    windowStatus: async (accountId, siteId, windowId) => (await target()).windowStatus(accountId, siteId, windowId),
    exportWindow: async (spec, opts) => (await target()).exportWindow(spec, opts),
    removeWindow: async (spec, opts) => (await target()).removeWindow(spec, opts),
    verifyWindowPropagation: async (accountId, siteId, windowId, pids) => (await target()).verifyWindowPropagation(accountId, siteId, windowId, pids),
    listWindows: async () => (await target()).listWindows(),
    applyToStaging: async (spec, source, changes) => (await target()).applyToStaging(spec, source, changes),
    ensureWorkspace: async (spec) => (await target()).ensureWorkspace(spec),
    removeWorkspace: async (spec) => (await target()).removeWorkspace(spec),
    setWatch: async (spec) => (await target()).setWatch(spec),
    removeWatch: async (accountId, siteId) => (await target()).removeWatch(accountId, siteId),
    listQuarantine: async (accountId) => (await target()).listQuarantine(accountId),
    restoreQuarantine: async (accountId, entryId, opts) => (await target()).restoreQuarantine(accountId, entryId, opts),
    deleteQuarantine: async (accountId, entryId) => (await target()).deleteQuarantine(accountId, entryId),
    quarantinePreview: async (accountId, entryId, maxBytes) => (await target()).quarantinePreview(accountId, entryId, maxBytes),
    events: async (since, waitSec) => (await target()).events(since, waitSec),
  };
}
