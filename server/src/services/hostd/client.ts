import http from 'http';
import type { AccessMode, QuotaMode } from '@oblimint/shared';
import { config } from '../../config';

// ─────────────────────────────────────────────────────────────────────────────
// Typed client of the hostd API (unix socket, docs/P1-PLAN.md §4/§7).
// OWNED BY MODULE `hostd`. Talks JSON over HTTP on config.hosting.hostdSocket
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

export interface HostdFirewallStatus {
  backend: 'nftables' | 'none';
  accounts: number;
  lastApplyAt: string | null;
  lastApplyError: string | null;
  gatewayListeners: number;
  /** Accounts hostd holds a firewall / gateway state for (hostd ≥ 0.3.0): the panel drops those of deleted accounts. */
  accountIds?: number[];
  gatewayAccountIds?: number[];
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
} as const;

export interface HostdClientOptions {
  /** Unix socket (or Windows named pipe in tests). */
  socketPath: string;
  /** Overrides of HOSTD_TIMEOUTS (tests). */
  timeouts?: Partial<Record<keyof typeof HOSTD_TIMEOUTS, number>>;
}

/** Hard cap on a response body: every hostd answer is a small JSON object. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

type Method = 'GET' | 'PUT' | 'POST' | 'DELETE';

function request<T>(socketPath: string, method: Method, path: string, body: unknown, timeoutMs: number): Promise<T> {
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
        if (size > MAX_RESPONSE_BYTES) {
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

/** Client bound to one socket (no database access: usable in tests). */
export function createHostdClient(opts: HostdClientOptions): HostdClient {
  const t = { ...HOSTD_TIMEOUTS, ...opts.timeouts };
  const call = <T>(method: Method, path: string, body?: unknown, timeout: number = t.default) =>
    request<T>(opts.socketPath, method, path, body, timeout);

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
    setGateway: async (spec) => (await target()).setGateway(spec),
    removeGateway: async (accountId) => (await target()).removeGateway(accountId),
    gatewayEvents: async (waitSec) => (await target()).gatewayEvents(waitSec),
  };
}
