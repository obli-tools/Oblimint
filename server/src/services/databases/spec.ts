import type Docker from 'dockerode';
import type { DbEngine, DbTuningProfile } from '@oblimint/shared';
import { dbEngineVersionDef, dbFamilyOf } from '@oblimint/shared';
import { config } from '../../config';
import {
  accountDbNetwork, ADMINER_CONTAINER, dbInstanceAlias, dbInstanceContainer, LABELS, P2_LABELS, PANEL_NETWORK, PHPMYADMIN_CONTAINER,
  previewDbContainer, previewDbNetwork,
} from '../hosting/naming';
import { TENANT_SECCOMP_OPT } from '../docker/seccomp';
import { LOG_CONFIG, NO_NEW_PRIVILEGES, TENANT_OOM_SCORE_ADJ, TMPFS_FLAGS, TMPFS_SHARED_FLAGS, withSpecHash } from '../docker/specs';
import { DB_CONTAINER_PATHS, DB_CONTAINER_PORT, dbTuning, renderFirstRunEnv, renderServerArgs } from './engines';

// ─────────────────────────────────────────────────────────────────────────────
// PURE container specs of the databases module (spec.test.ts):
//  - one instance of an account (official image, hardened: docs/P2-PLAN.md
//    §4 "Durcissement des conteneurs BDD", invariant B1);
//  - the shared phpMyAdmin / Adminer containers (SSO only, §9.3, B3).
//
// Instance hardening, and why each exception exists:
//  - User uid:gid of the account: the official entrypoints only chown / gosu
//    when started as root; as any other uid they run the server directly →
//    no capability is needed at all (CapDrop ALL, no CapAdd).
//  - ReadonlyRootfs: the servers only write their data dir (bind), their
//    socket dir (bind), /tmp and /run (tmpfs). The PostgreSQL entrypoint
//    writes its nss_wrapper passwd files under /tmp (arbitrary uid).
//  - TENANT_SECCOMP_OPT like every tenant container (the data files are in
//    the account's XFS project: the owner must not move them out of it).
//  - Memory = MemorySwap = profile (never unlimited), PidsLimit = connections
//    + background threads, OomScoreAdj of a tenant.
//  - Port published ONLY with external access (host port → 3306 / 5432),
//    filtered by the account allow-list (hostd nftables).
//  - StopTimeout 60 s: a database needs more than Docker's 10 s to shut down
//    cleanly (daemon restarts, `docker stop` without -t).
// ─────────────────────────────────────────────────────────────────────────────

export const DB_STOP_TIMEOUT_SEC = 60;
export const DBADMIN_PORT = 8080;
export const DBADMIN_MEMORY_BYTES = 256 * 1048576;
export const DBADMIN_PIDS_LIMIT = 256;

export interface DbInstanceContainerInput {
  instanceId: number;
  accountId: number;
  uid: number;
  gid: number;
  engine: DbEngine;
  version: string;
  profile: DbTuningProfile;
  /** Superuser password (opened root_secret): first-run env of the image. */
  rootPassword: string;
  /** Host port when external access is on, else null (nothing published). */
  externalPort: number | null;
  /** Host paths (hostPaths.dbData / dbSocketInstance). */
  dataDir: string;
  socketDir: string;
}

function posix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Image of an engine version: OBLIMINT_DB_IMAGE_PREFIX + official image. */
export function dbInstanceImage(engine: DbEngine, version: string, prefix = config.hosting.dbImagePrefix): string {
  const def = dbEngineVersionDef(engine, version);
  if (!def) throw new Error(`unknown engine version ${engine} ${version}`);
  return `${prefix}${def.image}`;
}

export function dbInstanceContainerSpec(input: DbInstanceContainerInput): Docker.ContainerCreateOptions {
  const family = dbFamilyOf(input.engine);
  const paths = DB_CONTAINER_PATHS[family];
  const tuning = dbTuning(input.profile);
  const name = dbInstanceContainer(input.instanceId);
  const alias = dbInstanceAlias(input.instanceId);
  // Account DATABASE network (sites + instances + admin UI during SSO), never
  // the account network the edge joins (ARCHITECTURE §3.6).
  const net = accountDbNetwork(input.accountId);
  const portKey = `${DB_CONTAINER_PORT[family]}/tcp`;
  const memory = tuning.memoryMb * 1048576;
  const published = input.externalPort !== null && Number.isInteger(input.externalPort) && input.externalPort > 0;

  return withSpecHash({
    name,
    Image: dbInstanceImage(input.engine, input.version),
    User: `${input.uid}:${input.gid}`,
    Cmd: renderServerArgs(input.engine, input.profile),
    Env: renderFirstRunEnv(input.engine, input.rootPassword),
    Labels: {
      [LABELS.internal]: 'true',
      [LABELS.account]: String(input.accountId),
      [P2_LABELS.dbInstance]: String(input.instanceId),
      [LABELS.role]: 'db',
    },
    StopTimeout: DB_STOP_TIMEOUT_SEC,
    ...(published ? { ExposedPorts: { [portKey]: {} } } : {}),
    HostConfig: {
      Mounts: [
        { Type: 'bind', Source: posix(input.dataDir), Target: paths.data, ReadOnly: false },
        { Type: 'bind', Source: posix(input.socketDir), Target: paths.socketDir, ReadOnly: false },
      ],
      // No HostIp: published on every IPv4 and IPv6 address (source address kept for the bans).
      ...(published ? { PortBindings: { [portKey]: [{ HostPort: String(input.externalPort) }] } } : {}),
      Tmpfs: {
        '/tmp': `${TMPFS_SHARED_FLAGS},size=${tuning.tmpfsMb}m`,
        '/run': `${TMPFS_SHARED_FLAGS},size=16m`,
      },
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: [NO_NEW_PRIVILEGES, TENANT_SECCOMP_OPT],
      Memory: memory,
      MemorySwap: memory,
      PidsLimit: tuning.pidsLimit,
      OomScoreAdj: TENANT_OOM_SCORE_ADJ,
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: net,
      LogConfig: LOG_CONFIG,
    },
    NetworkingConfig: { EndpointsConfig: { [net]: { Aliases: [name, alias] } } },
  });
}

// ── feature B: disposable database clone of a preview ───────────────────────

export interface PreviewDbContainerInput {
  siteId: number;
  previewId: number;
  accountId: number;
  /** The LIVE instance cloned: its names become the clone's aliases on the private network. */
  instanceId: number;
  uid: number;
  gid: number;
  engine: DbEngine;
  version: string;
  /** Random superuser password of the clone (never the live one). */
  rootPassword: string;
  /** Host path of previews/<pid>/dbsock/i-<instanceId> (socket dir, rw). */
  socketDir: string;
  /** Size of the data tmpfs (MiB): charged to the container's memory limit. */
  dataMb: number;
  cpus: number;
}

/** Profile of every clone: the small one (the preview is a check, not a load test). */
export const PREVIEW_DB_PROFILE: DbTuningProfile = 'S';
export const PREVIEW_DB_STOP_TIMEOUT_SEC = 10;

/**
 * Server flags of a clone: the instance's (profile S) plus durability off — a
 * clone is thrown away, nothing is worth an fsync (tmpfs anyway) and the
 * restore runs faster; PostgreSQL keeps its WAL small (it lives in RAM too).
 */
export function previewDbServerArgs(engine: DbEngine): string[] {
  const base = renderServerArgs(engine, PREVIEW_DB_PROFILE);
  if (dbFamilyOf(engine) === 'postgresql') {
    return [...base, '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'max_wal_size=128MB', '-c', 'min_wal_size=32MB'];
  }
  return [...base, '--innodb-flush-log-at-trx-commit=0'];
}

/**
 * Docker create options of a preview's database clone (role preview-db): the
 * official image of the live instance's engine / version, hardened like an
 * instance (account uid, CapDrop ALL, read-only root, seccomp, no port), with:
 *  - the data directory on a TMPFS owned by the account uid (mode 0700, size
 *    dataMb): nothing of the production copy ever lands on a disk, it dies
 *    with the container; tmpfs pages count in the container's memory limit
 *    (profile S + dataMb);
 *  - ONLY the preview's private network (Internal, no host address), under the
 *    live instance's names (db-<id>, oblimint-db-<id>): the preview's
 *    unmodified configuration reaches the clone, never the live server;
 *  - never restarted (a dead clone fails the preview), short stop timeout.
 */
export function previewDbContainerSpec(input: PreviewDbContainerInput): Docker.ContainerCreateOptions {
  const family = dbFamilyOf(input.engine);
  const paths = DB_CONTAINER_PATHS[family];
  const tuning = dbTuning(PREVIEW_DB_PROFILE);
  const name = previewDbContainer(input.siteId, input.previewId, input.instanceId);
  const net = previewDbNetwork(input.previewId);
  const dataMb = Math.max(64, Math.ceil(input.dataMb));
  const memory = (tuning.memoryMb + dataMb) * 1048576;
  return withSpecHash({
    name,
    Image: dbInstanceImage(input.engine, input.version),
    User: `${input.uid}:${input.gid}`,
    Cmd: previewDbServerArgs(input.engine),
    Env: renderFirstRunEnv(input.engine, input.rootPassword),
    Labels: {
      [LABELS.internal]: 'true',
      [LABELS.account]: String(input.accountId),
      [LABELS.site]: String(input.siteId),
      [LABELS.role]: 'preview-db',
      [LABELS.preview]: String(input.previewId),
    },
    StopTimeout: PREVIEW_DB_STOP_TIMEOUT_SEC,
    HostConfig: {
      Mounts: [
        { Type: 'bind', Source: posix(input.socketDir), Target: paths.socketDir, ReadOnly: false },
      ],
      Tmpfs: {
        [paths.data]: `${TMPFS_FLAGS},size=${dataMb}m,mode=0700,uid=${input.uid},gid=${input.gid}`,
        '/tmp': `${TMPFS_SHARED_FLAGS},size=${tuning.tmpfsMb}m`,
        '/run': `${TMPFS_SHARED_FLAGS},size=16m`,
      },
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: [NO_NEW_PRIVILEGES, TENANT_SECCOMP_OPT],
      Memory: memory,
      MemorySwap: memory,
      NanoCpus: Math.round(Math.max(0.25, input.cpus) * 1e9),
      PidsLimit: tuning.pidsLimit,
      OomScoreAdj: TENANT_OOM_SCORE_ADJ,
      RestartPolicy: { Name: 'no' },
      NetworkMode: net,
      LogConfig: LOG_CONFIG,
    },
    NetworkingConfig: { EndpointsConfig: { [net]: { Aliases: [name, dbInstanceAlias(input.instanceId), dbInstanceContainer(input.instanceId)] } } },
  });
}

// ── phpMyAdmin / Adminer ─────────────────────────────────────────────────────

export type DbAdminKind = 'phpmyadmin' | 'adminer';

export interface DbAdminContainerInput {
  /** HMAC(sessionSecret, 'oblimint-dbadmin'): sent with every redeem call. */
  key: string;
  /** http://oblimint-panel:<internalPort>/internal/dbadmin/redeem */
  redeemUrl: string;
  /** phpMyAdmin cookie encryption secret (64 hex chars), derived from the session secret. */
  blowfishSecret?: string;
}

export function dbAdminContainerName(kind: DbAdminKind): string {
  return kind === 'phpmyadmin' ? PHPMYADMIN_CONTAINER : ADMINER_CONTAINER;
}

export function dbAdminImage(kind: DbAdminKind): string {
  return `${kind === 'phpmyadmin' ? config.hosting.phpMyAdminImage : config.hosting.adminerImage}:${config.hosting.imageTag}`;
}

/**
 * Shared admin UI: panel network only (the edge reaches it there; it is
 * attached to an account network only during an SSO session), no published
 * port, non-root (image USER), read-only root, no capability.
 */
export function dbAdminContainerSpec(kind: DbAdminKind, input: DbAdminContainerInput): Docker.ContainerCreateOptions {
  const name = dbAdminContainerName(kind);
  const env = [`OBLIMINT_DBADMIN_KEY=${input.key}`, `OBLIMINT_REDEEM_URL=${input.redeemUrl}`];
  if (kind === 'phpmyadmin' && input.blowfishSecret) env.push(`OBLIMINT_PMA_SECRET=${input.blowfishSecret}`);
  return withSpecHash({
    name,
    Image: dbAdminImage(kind),
    Env: env,
    Labels: { [LABELS.internal]: 'true', [LABELS.role]: 'dbadmin' },
    HostConfig: {
      Tmpfs: {
        '/tmp': `${TMPFS_SHARED_FLAGS},size=64m`,
        '/run': `${TMPFS_SHARED_FLAGS},size=16m`,
      },
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: [NO_NEW_PRIVILEGES],
      Memory: DBADMIN_MEMORY_BYTES,
      MemorySwap: DBADMIN_MEMORY_BYTES,
      PidsLimit: DBADMIN_PIDS_LIMIT,
      OomScoreAdj: TENANT_OOM_SCORE_ADJ,
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: PANEL_NETWORK,
      LogConfig: LOG_CONFIG,
    },
    NetworkingConfig: { EndpointsConfig: { [PANEL_NETWORK]: { Aliases: [name] } } },
  });
}
