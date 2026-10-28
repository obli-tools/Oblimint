import crypto from 'crypto';
import path from 'path';
import type Docker from 'dockerode';
import type { PlanLimits, RuntimeRole, SiteBaseId } from '@oblimint/shared';
import {
  accountNetwork, EDGE_CONTAINER, edgeImage, fileServerContainer, fileServerImage, HOSTD_CONTAINER, hostdImage,
  LABELS, PANEL_NETWORK, previewContainer, releasePreviewContainer, secondaryContainer, siteContainer, siteImage, type ContainerRole,
} from '../hosting/naming';
import { config } from '../../config';
import { CONTAINER_PATHS, hostingLayout, runtimeConfigFile } from '../hosting/paths';
import { TENANT_SECCOMP_OPT } from './seccomp';

// ─────────────────────────────────────────────────────────────────────────────
// PURE container spec builders (no I/O → unit-tested in specs.test.ts).
// Hardening invariants (docs/P1-PLAN.md §14 H1–H4), after Oblihub's runOneShot:
// CapDrop ALL, no-new-privileges, ReadonlyRootfs, tmpfs /tmp /run
// (noexec,nosuid,nodev), PidsLimit, Memory (no swap) / NanoCpus from the plan
// capped by the node ceiling (never unlimited), oom_score_adj (tenants first),
// User = account uid:gid, release dir mounted READ-ONLY, data RW, labels
// oblimint.*, never the Docker socket, never /srv/oblimint/run or
// /srv/oblimint/config nor the staging in a site container, no published port
// except the file server's SFTP port (and 80/443 of the edge).
// Feature B (release / staging preview, role site-rpreview): same hardening,
// plus data READ-ONLY (tmpfs on the ephemeral paths), no database socket nor
// network, releases bind WITHOUT propagation, RestartPolicy no, pids ≤ 128.
//
// Every spec carries the label oblimint.spec-hash = specHash(spec): the
// reconcile recreates a container whose label differs from the desired hash
// (image, limits, mounts, env… changed).
// ─────────────────────────────────────────────────────────────────────────────

export interface SiteContainerInput {
  /** Environment variables of the site (siteEnv.service): docker Env, read by PHP-FPM (clear_env = no). */
  env?: Array<[string, string]>;
  siteId: number;
  accountId: number;
  uid: number;
  gid: number;
  slug: string;
  role: RuntimeRole;
  /** Secondary runtime id (role 'secondary'). */
  runtimeId: number | null;
  base: SiteBaseId;
  limits: PlanLimits;
  /** Host paths (paths.ts hostPaths). */
  releasesDir: string;
  dataDir: string;
  /** Host path of the runtime config file (hostPaths.runtime(...)/<role>.json): its directory is mounted RO. */
  runtimeConfigFile: string;
  /**
   * P2 — host paths of the account's database socket dirs (hostPaths.dbSockets /
   * dbSocketDefault): mounted READ-ONLY at /run/oblimint-db, /run/mysqld and
   * /run/postgresql so DB_HOST=localhost reaches the default instance. Always
   * set by the planner (the dirs exist from hostd ensureAccount on), absent =
   * no database mounts (P1 behaviour, tests).
   */
  dbSockets?: { root: string; mysql: string; postgresql: string } | null;
}

export interface FileServerContainerInput {
  accountId: number;
  uid: number;
  gid: number;
  port: number;
  stagingDir: string;
  dataDir: string;
  stateDir: string;
  /** http://oblimint-panel:<internalPort>/internal/filesrv/<accountId>/<token> */
  hookBaseUrl: string;
  /**
   * P2 — publish the SFTP port on the host (P1 behaviour). false (port
   * gateway, config.hosting.portGateway): no host port, hostd listens on
   * `port`, filters (allow-list, bans), starts the server on demand and
   * proxies to <container ip>:2022 with the PROXY protocol v2
   * (env OBLIMINT_PROXY_PROTOCOL=1 → images/filesrv enables it). Default true.
   */
  publishPort?: boolean;
}

export interface InfraContainerInput {
  /** Host data root (config.hostDataDir, POSIX). */
  hostDataDir: string;
  /** hostd only: accept disk limits that are only measured when the data root
   *  has no XFS project quota (OBLIMINT_ALLOW_MEASURED_QUOTA). Default: hostd
   *  refuses them (the account is not provisioned). */
  allowMeasuredQuota?: boolean;
  /**
   * P4b edge only: platform-approved stream ports (settings edge.streamPorts),
   * published by oblimint-edge. Empty / absent = 80 and 443 only. (The P4b
   * mounts change the spec hash once: one edge recreation at the upgrade.)
   */
  streamPorts?: ReadonlyArray<{ port: number; protocol: 'tcp' | 'udp' }>;
}

/**
 * oom_score_adj: under host memory pressure the kernel kills tenant processes
 * (sites, file servers) before the platform's (edge; the panel's PostgreSQL
 * gets the same negative value in services/setup/applySetup.ts).
 */
export const TENANT_OOM_SCORE_ADJ = 500;
export const PLATFORM_OOM_SCORE_ADJ = -500;

/**
 * Memory (MiB) / CPUs a site container really gets: the plan value, capped by
 * the node ceiling (config.hosting.siteMaxMemoryMb / siteMaxCpus); an
 * unlimited plan value (null / 0) means the ceiling, never "the whole host".
 * A ceiling of 0 disables it (null stays unlimited).
 */
export function effectiveSiteLimits(
  limits: Pick<PlanLimits, 'memoryMb' | 'cpuCores'>,
  ceiling: { memoryMb: number; cpus: number } = { memoryMb: config.hosting.siteMaxMemoryMb, cpus: config.hosting.siteMaxCpus },
): { memoryMb: number | null; cpus: number | null } {
  const cap = (value: number | null | undefined, max: number): number | null => {
    const v = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
    if (!(max > 0)) return v;
    return v === null ? max : Math.min(v, max);
  };
  return { memoryMb: cap(limits.memoryMb, ceiling.memoryMb), cpus: cap(limits.cpuCores, ceiling.cpus) };
}

/** Default PidsLimit of a site container when the plan leaves it empty. */
export const DEFAULT_SITE_PIDS_LIMIT = 256;
export const FILESRV_MEMORY_BYTES = 256 * 1048576;
export const FILESRV_PIDS_LIMIT = 128;
/** SFTP port inside the file server container (images/filesrv contract). */
export const FILESRV_CONTAINER_PORT = 2022;
export const EDGE_PIDS_LIMIT = 1024;
/**
 * nofile (soft = hard) of oblimint-edge. Must stay >= worker_rlimit_nofile in
 * images/edge/nginx.conf, itself > 2 x worker_connections (a proxied request
 * holds a client and an upstream socket). Docker's default soft limit is 1024,
 * and the edge has no CAP_SYS_RESOURCE to raise its hard limit itself.
 */
export const EDGE_NOFILE_LIMIT = 65536;

/** Tenant containers (site, file server) also get the seccomp profile of seccomp.ts (XFS project id, user namespaces…). */
export const NO_NEW_PRIVILEGES = 'no-new-privileges:true';
export const TMPFS_FLAGS = 'rw,noexec,nosuid,nodev';
/**
 * Tmpfs flags of a directory a NON-ROOT container user must write to. Without
 * an explicit mode=, Docker gives the tmpfs the mode of the image directory it
 * covers: /run is root:root 0755 in the base images, so the account uid could
 * not create /run/oblimint (images/common/lib.sh) and every site crash-looped.
 * 1777 (sticky, world-writable) as for /tmp.
 */
export const TMPFS_SHARED_FLAGS = `${TMPFS_FLAGS},mode=1777`;

export const LOG_CONFIG: Docker.HostConfig['LogConfig'] = {
  Type: 'json-file',
  Config: { 'max-size': '10m', 'max-file': '3' },
};

function posix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Docker object name of one container of a site. */
export function siteContainerName(siteId: number, role: RuntimeRole, runtimeId: number | null): string {
  if (role === 'secondary') return secondaryContainer(siteId, Number(runtimeId));
  if (role === 'preview') return previewContainer(siteId);
  return siteContainer(siteId);
}

/** oblimint.role label of a site container. */
export function siteContainerRole(role: RuntimeRole): ContainerRole {
  return role === 'secondary' ? 'site-secondary' : role === 'preview' ? 'site-preview' : 'site';
}

/** Adds the oblimint.spec-hash label (computed on the spec without it). Exported for the P2 spec builders (databases, dns). */
export const withSpecHash = (spec: Docker.ContainerCreateOptions): Docker.ContainerCreateOptions => withHash(spec);

function withHash(spec: Docker.ContainerCreateOptions): Docker.ContainerCreateOptions {
  const hash = specHash(spec);
  return { ...spec, Labels: { ...(spec.Labels ?? {}), [LABELS.specHash]: hash } };
}

/** Docker create options of a site container (primary / secondary / preview). */
export function siteContainerSpec(input: SiteContainerInput): Docker.ContainerCreateOptions {
  const name = siteContainerName(input.siteId, input.role, input.runtimeId);
  const net = accountNetwork(input.accountId);
  const labels: Record<string, string> = {
    [LABELS.internal]: 'true',
    [LABELS.account]: String(input.accountId),
    [LABELS.site]: String(input.siteId),
    [LABELS.role]: siteContainerRole(input.role),
  };
  if (input.role === 'secondary') labels[LABELS.runtime] = String(input.runtimeId);

  const hostConfig: Docker.HostConfig = {
    Mounts: [
      // P3: rslave — the window overlay hostd mounts over releases/<n> on the host appears in the
      // RUNNING container (no recreation); outside a window nothing is mounted there (H2 unchanged).
      { Type: 'bind', Source: posix(input.releasesDir), Target: CONTAINER_PATHS.releases, ReadOnly: true, BindOptions: { Propagation: 'rslave' } },
      { Type: 'bind', Source: posix(input.dataDir), Target: CONTAINER_PATHS.data, ReadOnly: false },
      { Type: 'bind', Source: path.posix.dirname(posix(input.runtimeConfigFile)), Target: CONTAINER_PATHS.siteConfigDir, ReadOnly: true },
      // P2: database sockets (READ-ONLY binds: connect() on a socket works on a RO mount).
      ...(input.dbSockets ? [
        { Type: 'bind' as const, Source: posix(input.dbSockets.root), Target: CONTAINER_PATHS.dbSocketsAll, ReadOnly: true },
        { Type: 'bind' as const, Source: posix(input.dbSockets.mysql), Target: CONTAINER_PATHS.dbSocketMysql, ReadOnly: true },
        { Type: 'bind' as const, Source: posix(input.dbSockets.postgresql), Target: CONTAINER_PATHS.dbSocketPostgresql, ReadOnly: true },
      ] : []),
    ],
    Tmpfs: {
      '/tmp': `${TMPFS_SHARED_FLAGS},size=256m`,
      '/run': `${TMPFS_SHARED_FLAGS},size=16m`,
    },
    ReadonlyRootfs: true,
    CapDrop: ['ALL'],
    SecurityOpt: [NO_NEW_PRIVILEGES, TENANT_SECCOMP_OPT],
    PidsLimit: input.limits.pidsLimit ?? DEFAULT_SITE_PIDS_LIMIT,
    OomScoreAdj: TENANT_OOM_SCORE_ADJ,
    RestartPolicy: { Name: 'unless-stopped' },
    NetworkMode: net,
    LogConfig: LOG_CONFIG,
  };
  // Plan limits capped by the node ceiling: an "unlimited" plan (null) gets the
  // ceiling, so one site can never exhaust the host's RAM / CPUs.
  const eff = effectiveSiteLimits(input.limits);
  if (eff.memoryMb !== null) {
    hostConfig.Memory = Math.round(eff.memoryMb * 1048576);
    hostConfig.MemorySwap = hostConfig.Memory; // = Memory → no swap
  }
  if (eff.cpus !== null) {
    hostConfig.NanoCpus = Math.round(eff.cpus * 1e9);
  }

  return withHash({
    name,
    Image: siteImage(input.base),
    User: `${input.uid}:${input.gid}`,
    Env: [
      `OBLIMINT_SITE_CONFIG=${CONTAINER_PATHS.siteConfigDir}/${runtimeConfigFile(input.role, input.runtimeId)}`,
      ...(input.env ?? []).map(([k, v]) => `${k}=${v}`),
    ],
    Labels: labels,
    HostConfig: hostConfig,
    NetworkingConfig: { EndpointsConfig: { [net]: { Aliases: [name] } } },
  });
}

// ── Feature B: release / staging preview container ──────────────────────────

export interface ReleasePreviewContainerInput {
  siteId: number;
  previewId: number;
  accountId: number;
  uid: number;
  gid: number;
  base: SiteBaseId;
  limits: PlanLimits;
  /** Host path of previews/<id>/releases → /srv/releases (RO, NO propagation: never sees a window overlay). */
  previewReleasesDir: string;
  /** Host path of previews/<id>/runtime → /etc/oblimint/site (RO, preview.json only). */
  previewRuntimeDir: string;
  /** Host path of data/<slug> → /srv/data (READ-ONLY: a preview never writes the live data). */
  dataDir: string;
  /** Ephemeral data paths (pre-checked real directories by the builder, ≤ 8): one tmpfs each. */
  ephemeralPaths: string[];
  env?: Array<[string, string]>;
  /** Platform ceiling (settings releasePreviews.memoryMb / cpus). */
  caps: { memoryMb: number; cpus: number };
}

export const PREVIEW_PIDS_LIMIT = 128;
export const PREVIEW_EPHEMERAL_TMPFS_MB = 64;
export const PREVIEW_MAX_EPHEMERAL_TMPFS = 8;

/** A relative data path usable as a tmpfs target: normalized, no ',' nor ':' (Docker tmpfs option syntax). */
export function isPreviewTmpfsPath(p: string): boolean {
  if (typeof p !== 'string' || !p || p.length > 512 || p.includes(',') || p.includes(':') || p.includes('\0') || p.includes('\\')) return false;
  if (p.startsWith('/') || p.endsWith('/')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/**
 * Docker create options of a release / staging preview container (role
 * site-rpreview): the hardening of siteContainerSpec, plus — data READ-ONLY
 * (tmpfs on the ephemeral paths), NO database socket, releases without
 * propagation, never restarted (RestartPolicy no: the planner never starts it
 * again either, B1), limits = min(plan / node ceiling, preview caps), pids ≤ 128.
 */
export function releasePreviewContainerSpec(input: ReleasePreviewContainerInput): Docker.ContainerCreateOptions {
  const name = releasePreviewContainer(input.siteId, input.previewId);
  const net = accountNetwork(input.accountId);
  const tmpfs: Record<string, string> = {
    '/tmp': `${TMPFS_SHARED_FLAGS},size=128m`,
    '/run': `${TMPFS_SHARED_FLAGS},size=16m`,
  };
  for (const p of input.ephemeralPaths.filter(isPreviewTmpfsPath).slice(0, PREVIEW_MAX_EPHEMERAL_TMPFS).sort()) {
    tmpfs[`${CONTAINER_PATHS.data}/${p}`] = `${TMPFS_SHARED_FLAGS},size=${PREVIEW_EPHEMERAL_TMPFS_MB}m`;
  }
  const hostConfig: Docker.HostConfig = {
    Mounts: [
      { Type: 'bind', Source: posix(input.previewReleasesDir), Target: CONTAINER_PATHS.releases, ReadOnly: true },
      { Type: 'bind', Source: posix(input.dataDir), Target: CONTAINER_PATHS.data, ReadOnly: true },
      { Type: 'bind', Source: posix(input.previewRuntimeDir), Target: CONTAINER_PATHS.siteConfigDir, ReadOnly: true },
    ],
    Tmpfs: tmpfs,
    ReadonlyRootfs: true,
    CapDrop: ['ALL'],
    SecurityOpt: [NO_NEW_PRIVILEGES, TENANT_SECCOMP_OPT],
    PidsLimit: Math.min(input.limits.pidsLimit ?? DEFAULT_SITE_PIDS_LIMIT, PREVIEW_PIDS_LIMIT),
    OomScoreAdj: TENANT_OOM_SCORE_ADJ,
    RestartPolicy: { Name: 'no' },
    NetworkMode: net,
    LogConfig: LOG_CONFIG,
  };
  const eff = effectiveSiteLimits(input.limits);
  const memoryMb = Math.min(eff.memoryMb ?? input.caps.memoryMb, input.caps.memoryMb);
  const cpus = Math.min(eff.cpus ?? input.caps.cpus, input.caps.cpus);
  hostConfig.Memory = Math.round(memoryMb * 1048576);
  hostConfig.MemorySwap = hostConfig.Memory;
  hostConfig.NanoCpus = Math.round(cpus * 1e9);
  return withHash({
    name,
    Image: siteImage(input.base),
    User: `${input.uid}:${input.gid}`,
    Env: [
      `OBLIMINT_SITE_CONFIG=${CONTAINER_PATHS.siteConfigDir}/${runtimeConfigFile('preview', null)}`,
      ...(input.env ?? []).map(([k, v]) => `${k}=${v}`),
    ],
    Labels: {
      [LABELS.internal]: 'true',
      [LABELS.account]: String(input.accountId),
      [LABELS.site]: String(input.siteId),
      [LABELS.role]: 'site-rpreview',
      [LABELS.preview]: String(input.previewId),
    },
    HostConfig: hostConfig,
    NetworkingConfig: { EndpointsConfig: { [net]: { Aliases: [name] } } },
  });
}

/** Per-account SFTPGo container: staging + data + state, only its SFTP port published. */
export function fileServerContainerSpec(input: FileServerContainerInput): Docker.ContainerCreateOptions {
  const name = fileServerContainer(input.accountId);
  const net = accountNetwork(input.accountId);
  const portKey = `${FILESRV_CONTAINER_PORT}/tcp`;
  return withHash({
    name,
    Image: fileServerImage(),
    User: `${input.uid}:${input.gid}`,
    Env: [
      `OBLIMINT_HOOK_BASE=${input.hookBaseUrl}`,
      `OBLIMINT_ACCOUNT_ID=${input.accountId}`,
      // P2: behind the hostd port gateway, SFTPGo reads the client address from the PROXY protocol header.
      ...(input.publishPort === false ? ['OBLIMINT_PROXY_PROTOCOL=1'] : []),
    ],
    Labels: {
      [LABELS.internal]: 'true',
      [LABELS.account]: String(input.accountId),
      [LABELS.role]: 'filesrv',
    },
    ExposedPorts: { [portKey]: {} },
    HostConfig: {
      Mounts: [
        { Type: 'bind', Source: posix(input.stagingDir), Target: `${CONTAINER_PATHS.filesRoot}/staging`, ReadOnly: false },
        { Type: 'bind', Source: posix(input.dataDir), Target: `${CONTAINER_PATHS.filesRoot}/data`, ReadOnly: false },
        { Type: 'bind', Source: posix(input.stateDir), Target: CONTAINER_PATHS.filesrvState, ReadOnly: false },
      ],
      // No HostIp: Docker publishes on every IPv4 and IPv6 address of the host.
      // P2 port gateway: nothing published, hostd owns the host port.
      ...(input.publishPort === false ? {} : { PortBindings: { [portKey]: [{ HostPort: String(input.port) }] } }),
      Tmpfs: { '/tmp': `${TMPFS_SHARED_FLAGS},size=64m` },
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: [NO_NEW_PRIVILEGES, TENANT_SECCOMP_OPT],
      Memory: FILESRV_MEMORY_BYTES,
      MemorySwap: FILESRV_MEMORY_BYTES,
      PidsLimit: FILESRV_PIDS_LIMIT,
      OomScoreAdj: TENANT_OOM_SCORE_ADJ,
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: net,
      LogConfig: LOG_CONFIG,
    },
    NetworkingConfig: { EndpointsConfig: { [net]: { Aliases: [name] } } },
  });
}

/**
 * oblimint-edge: host ports 80/443 (+ P4b approved stream ports), conf.d +
 * certs + acme RO, joins every account network (reconcile). P4b (docs/P4b-PLAN.md
 * §8): + stream.d, global.d, aux, sandbox (candidate trees tested with
 * nginx -t -c) and good (last-known-good copy, fallback of the entrypoint) — all
 * READ-ONLY; proxy cache on the /var/cache/nginx tmpfs (512 MiB).
 */
export function edgeContainerSpec(input: InfraContainerInput): Docker.ContainerCreateOptions {
  const layout = hostingLayout(input.hostDataDir);
  const streams = [...(input.streamPorts ?? [])].sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
  const exposed: Record<string, Record<string, never>> = { '80/tcp': {}, '443/tcp': {} };
  const bindings: Record<string, Array<{ HostPort: string }>> = { '80/tcp': [{ HostPort: '80' }], '443/tcp': [{ HostPort: '443' }] };
  for (const s of streams) {
    const key = `${s.port}/${s.protocol}`;
    exposed[key] = {};
    bindings[key] = [{ HostPort: String(s.port) }];
  }
  return withHash({
    name: EDGE_CONTAINER,
    Image: edgeImage(),
    Labels: { [LABELS.internal]: 'true', [LABELS.role]: 'edge' },
    ExposedPorts: exposed,
    HostConfig: {
      // No HostIp: published on every IPv4 and IPv6 address of the host.
      PortBindings: bindings,
      Mounts: [
        { Type: 'bind', Source: layout.edgeConfD(), Target: '/etc/nginx/oblimint/conf.d', ReadOnly: true },
        { Type: 'bind', Source: layout.edgeCerts(), Target: '/etc/nginx/oblimint/certs', ReadOnly: true },
        { Type: 'bind', Source: layout.edgeAcme(), Target: '/var/www/acme', ReadOnly: true },
        // P4b
        { Type: 'bind', Source: layout.edgeStreamD(), Target: '/etc/nginx/oblimint/stream.d', ReadOnly: true },
        { Type: 'bind', Source: layout.edgeGlobalD(), Target: '/etc/nginx/oblimint/global.d', ReadOnly: true },
        { Type: 'bind', Source: layout.edgeAux(), Target: '/etc/nginx/oblimint/aux', ReadOnly: true },
        { Type: 'bind', Source: layout.edgeSandbox(), Target: '/etc/nginx/oblimint/sandbox', ReadOnly: true },
        { Type: 'bind', Source: layout.edgeGood(), Target: '/etc/nginx/oblimint/good', ReadOnly: true },
      ],
      Tmpfs: {
        '/var/cache/nginx': 'rw,nosuid,nodev,size=512m',
        '/run': `${TMPFS_FLAGS},size=16m`,
        '/tmp': `${TMPFS_FLAGS},size=64m`,
      },
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      // nginx master: bind 80/443, chown its cache dirs, drop to the worker user.
      CapAdd: ['CHOWN', 'NET_BIND_SERVICE', 'SETGID', 'SETUID'],
      SecurityOpt: [NO_NEW_PRIVILEGES],
      PidsLimit: EDGE_PIDS_LIMIT,
      Ulimits: [{ Name: 'nofile', Soft: EDGE_NOFILE_LIMIT, Hard: EDGE_NOFILE_LIMIT }],
      OomScoreAdj: PLATFORM_OOM_SCORE_ADJ,
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: PANEL_NETWORK,
      LogConfig: LOG_CONFIG,
    },
    NetworkingConfig: { EndpointsConfig: { [PANEL_NETWORK]: { Aliases: [EDGE_CONTAINER] } } },
  });
}

/** oblimint-hostd: privileged, pid/network host, /srv/oblimint rshared (mount propagation to site containers). */
export function hostdContainerSpec(input: InfraContainerInput): Docker.ContainerCreateOptions {
  const root = posix(input.hostDataDir).replace(/\/+$/, '') || '/';
  return withHash({
    name: HOSTD_CONTAINER,
    Image: hostdImage(),
    Env: [
      `OBLIMINT_HOSTD_SOCKET=${path.posix.join(root, 'run', 'hostd.sock')}`,
      `OBLIMINT_ROOT=${root}`,
      // Only when set: the default spec (and its hash) is unchanged.
      ...(input.allowMeasuredQuota ? ['OBLIMINT_ALLOW_MEASURED_QUOTA=1'] : []),
    ],
    Labels: { [LABELS.internal]: 'true', [LABELS.role]: 'hostd' },
    HostConfig: {
      Privileged: true,
      PidMode: 'host',
      NetworkMode: 'host',
      Mounts: [
        { Type: 'bind', Source: root, Target: root, ReadOnly: false, BindOptions: { Propagation: 'rshared' } },
      ],
      RestartPolicy: { Name: 'always' },
      LogConfig: LOG_CONFIG,
    },
  });
}

// ── spec hash ────────────────────────────────────────────────────────────────

/** JSON with object keys sorted recursively (arrays keep their order), undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** sha256 of a normalized spec (label oblimint.spec-hash excluded): drift → recreate. */
export function specHash(spec: Docker.ContainerCreateOptions): string {
  const labels = { ...(spec.Labels ?? {}) };
  delete labels[LABELS.specHash];
  const normalized = { ...spec, Labels: labels };
  return crypto.createHash('sha256').update(canonicalJson(normalized)).digest('hex');
}

/** The hash stored in a spec built by this file. */
export function specHashLabel(spec: Docker.ContainerCreateOptions): string {
  return spec.Labels?.[LABELS.specHash] ?? specHash(spec);
}
