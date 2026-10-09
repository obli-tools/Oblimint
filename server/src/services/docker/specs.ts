import crypto from 'crypto';
import path from 'path';
import type Docker from 'dockerode';
import type { PlanLimits, RuntimeRole, SiteBaseId } from '@oblimint/shared';
import {
  accountNetwork, EDGE_CONTAINER, edgeImage, fileServerContainer, fileServerImage, HOSTD_CONTAINER, hostdImage,
  LABELS, PANEL_NETWORK, previewContainer, secondaryContainer, siteContainer, siteImage, type ContainerRole,
} from '../hosting/naming';
import { CONTAINER_PATHS, hostingLayout, runtimeConfigFile } from '../hosting/paths';
import { TENANT_SECCOMP_OPT } from './seccomp';

// ─────────────────────────────────────────────────────────────────────────────
// PURE container spec builders (no I/O → unit-tested in specs.test.ts).
// Hardening invariants (docs/P1-PLAN.md §14 H1–H4), after Oblihub's runOneShot:
// CapDrop ALL, no-new-privileges, ReadonlyRootfs, tmpfs /tmp /run
// (noexec,nosuid,nodev), PidsLimit, Memory (no swap) / NanoCpus from the plan,
// User = account uid:gid, release dir mounted READ-ONLY, data RW, labels
// oblimint.*, never the Docker socket, never /srv/oblimint/run or
// /srv/oblimint/config nor the staging in a site container, no published port
// except the file server's SFTP port (and 80/443 of the edge).
//
// Every spec carries the label oblimint.spec-hash = specHash(spec): the
// reconcile recreates a container whose label differs from the desired hash
// (image, limits, mounts, env… changed).
// ─────────────────────────────────────────────────────────────────────────────

export interface SiteContainerInput {
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
}

export interface InfraContainerInput {
  /** Host data root (config.hostDataDir, POSIX). */
  hostDataDir: string;
}

/** Default PidsLimit of a site container when the plan leaves it empty. */
export const DEFAULT_SITE_PIDS_LIMIT = 256;
export const FILESRV_MEMORY_BYTES = 256 * 1048576;
export const FILESRV_PIDS_LIMIT = 128;
/** SFTP port inside the file server container (images/filesrv contract). */
export const FILESRV_CONTAINER_PORT = 2022;
export const EDGE_PIDS_LIMIT = 1024;

/** Tenant containers (site, file server) also get the seccomp profile of seccomp.ts (XFS project id, user namespaces…). */
const NO_NEW_PRIVILEGES = 'no-new-privileges:true';
const TMPFS_FLAGS = 'rw,noexec,nosuid,nodev';

const LOG_CONFIG: Docker.HostConfig['LogConfig'] = {
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

/** Adds the oblimint.spec-hash label (computed on the spec without it). */
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
      { Type: 'bind', Source: posix(input.releasesDir), Target: CONTAINER_PATHS.releases, ReadOnly: true },
      { Type: 'bind', Source: posix(input.dataDir), Target: CONTAINER_PATHS.data, ReadOnly: false },
      { Type: 'bind', Source: path.posix.dirname(posix(input.runtimeConfigFile)), Target: CONTAINER_PATHS.siteConfigDir, ReadOnly: true },
    ],
    Tmpfs: {
      '/tmp': `${TMPFS_FLAGS},size=256m`,
      '/run': `${TMPFS_FLAGS},size=16m`,
    },
    ReadonlyRootfs: true,
    CapDrop: ['ALL'],
    SecurityOpt: [NO_NEW_PRIVILEGES, TENANT_SECCOMP_OPT],
    PidsLimit: input.limits.pidsLimit ?? DEFAULT_SITE_PIDS_LIMIT,
    RestartPolicy: { Name: 'unless-stopped' },
    NetworkMode: net,
    LogConfig: LOG_CONFIG,
  };
  if (input.limits.memoryMb && input.limits.memoryMb > 0) {
    hostConfig.Memory = Math.round(input.limits.memoryMb * 1048576);
    hostConfig.MemorySwap = hostConfig.Memory; // = Memory → no swap
  }
  if (input.limits.cpuCores && input.limits.cpuCores > 0) {
    hostConfig.NanoCpus = Math.round(input.limits.cpuCores * 1e9);
  }

  return withHash({
    name,
    Image: siteImage(input.base),
    User: `${input.uid}:${input.gid}`,
    Env: [`OBLIMINT_SITE_CONFIG=${CONTAINER_PATHS.siteConfigDir}/${runtimeConfigFile(input.role, input.runtimeId)}`],
    Labels: labels,
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
      PortBindings: { [portKey]: [{ HostPort: String(input.port) }] },
      Tmpfs: { '/tmp': `${TMPFS_FLAGS},size=64m` },
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: [NO_NEW_PRIVILEGES, TENANT_SECCOMP_OPT],
      Memory: FILESRV_MEMORY_BYTES,
      MemorySwap: FILESRV_MEMORY_BYTES,
      PidsLimit: FILESRV_PIDS_LIMIT,
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: net,
      LogConfig: LOG_CONFIG,
    },
    NetworkingConfig: { EndpointsConfig: { [net]: { Aliases: [name] } } },
  });
}

/** oblimint-edge: host ports 80/443, conf.d + certs + acme RO, joins every account network (reconcile). */
export function edgeContainerSpec(input: InfraContainerInput): Docker.ContainerCreateOptions {
  const layout = hostingLayout(input.hostDataDir);
  return withHash({
    name: EDGE_CONTAINER,
    Image: edgeImage(),
    Labels: { [LABELS.internal]: 'true', [LABELS.role]: 'edge' },
    ExposedPorts: { '80/tcp': {}, '443/tcp': {} },
    HostConfig: {
      // No HostIp: published on every IPv4 and IPv6 address of the host.
      PortBindings: { '80/tcp': [{ HostPort: '80' }], '443/tcp': [{ HostPort: '443' }] },
      Mounts: [
        { Type: 'bind', Source: layout.edgeConfD(), Target: '/etc/nginx/oblimint/conf.d', ReadOnly: true },
        { Type: 'bind', Source: layout.edgeCerts(), Target: '/etc/nginx/oblimint/certs', ReadOnly: true },
        { Type: 'bind', Source: layout.edgeAcme(), Target: '/var/www/acme', ReadOnly: true },
      ],
      Tmpfs: {
        '/var/cache/nginx': 'rw,nosuid,nodev,size=128m',
        '/run': `${TMPFS_FLAGS},size=16m`,
        '/tmp': `${TMPFS_FLAGS},size=64m`,
      },
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      // nginx master: bind 80/443, chown its cache dirs, drop to the worker user.
      CapAdd: ['CHOWN', 'NET_BIND_SERVICE', 'SETGID', 'SETUID'],
      SecurityOpt: [NO_NEW_PRIVILEGES],
      PidsLimit: EDGE_PIDS_LIMIT,
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
