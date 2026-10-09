import type Docker from 'dockerode';
import type { PlanLimits } from '@oblimint/shared';
import { accountDbNetwork, accountNetwork, LABELS, P3_LABELS, toolsContainer, toolsImage } from '../hosting/naming';
import { CONTAINER_PATHS } from '../hosting/paths';
import {
  effectiveSiteLimits, LOG_CONFIG, NO_NEW_PRIVILEGES, TENANT_OOM_SCORE_ADJ, TMPFS_SHARED_FLAGS, withSpecHash,
} from '../docker/specs';
import { TENANT_SECCOMP_OPT } from '../docker/seccomp';

// ─────────────────────────────────────────────────────────────────────────────
// PURE spec of an adapter tools container (docs/P3-PLAN.md §4.2, M3 / M8).
// One container per CLI step: oblimint-tools-<run>-<step>, image
// meejay/oblimint-tools-php<v> (the PHP branch of the site base).
//
// Hardening = H1 of the site containers, adapted:
//   User uid:gid of the account, CapDrop ALL, no-new-privileges,
//   TENANT_SECCOMP_OPT, read-only root, tmpfs /tmp (1 GiB: Composer / WP-CLI
//   caches, downloads) and /run, PidsLimit 512, Memory = MemorySwap =
//   maintenance.adapterMemoryMb (no swap), NanoCpus = the plan's CPUs capped by
//   the node ceiling, OomScoreAdj tenant, LogConfig, NO restart policy, NO
//   published port, account network (+ its database network, connected
//   before start: the egress filter of the account applies).
// Mounts — and nothing else (never the Docker socket, the staging, the live
// release, windows/, snapshots/, quarantine/):
//   work/<runId>/tree → /srv/app   (rw; ro for 'check' and post-deploy)
//   data/<slug>       → /srv/data  (rw: the release's data links point there)
//   DB socket dirs    → /run/oblimint-db, /run/mysqld, /run/postgresql (ro, as the sites)
// ─────────────────────────────────────────────────────────────────────────────

export const TOOLS_PIDS_LIMIT = 512;
export const TOOLS_TMP_SIZE = '1g';
export const TOOLS_RUN_SIZE = '16m';

/** Fixed environment of every step (overrides of the caller cannot replace these). */
export const TOOLS_ENV: Readonly<Record<string, string>> = {
  HOME: '/tmp',
  COMPOSER_HOME: '/tmp/composer',
  COMPOSER_CACHE_DIR: '/tmp/composer/cache',
  COMPOSER_NO_INTERACTION: '1',
  WP_CLI_CACHE_DIR: '/tmp/wp-cli',
  WP_CLI_DISABLE_AUTO_CHECK_UPDATE: '1',
  PGHOST: CONTAINER_PATHS.dbSocketPostgresql,
};

const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface ToolsSpecInput {
  runId: number;
  step: string;
  accountId: number;
  siteId: number;
  uid: number;
  gid: number;
  /** PHP branch of the site base ('8.3'). */
  php: string;
  /** Host paths (hostPaths). */
  workspaceDir: string;
  dataDir: string;
  dbSockets: { root: string; mysql: string; postgresql: string };
  workspaceReadOnly: boolean;
  argv: string[];
  /** Extra variables (validated names, no NUL); the fixed TOOLS_ENV wins. */
  env?: Record<string, string>;
  /** settings maintenance.adapterMemoryMb */
  memoryMb: number;
  /** Plan limits of the account (CPUs). */
  limits: Pick<PlanLimits, 'memoryMb' | 'cpuCores'>;
  /** Node ceiling (tests); default config.hosting. */
  ceiling?: { memoryMb: number; cpus: number };
}

function posix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** The database network the container joins before it starts (DB instances by TCP alias). */
export function toolsDbNetwork(accountId: number): string {
  return accountDbNetwork(accountId);
}

/** Docker create options of one tools step (pure). */
export function toolsContainerSpec(input: ToolsSpecInput): Docker.ContainerCreateOptions {
  if (!Array.isArray(input.argv) || input.argv.length === 0 || input.argv.some((a) => typeof a !== 'string' || a.includes('\0'))) {
    throw new Error('tools container: invalid argv');
  }
  if (!/^\d+\.\d+$/.test(input.php)) throw new Error(`tools container: invalid PHP version ${JSON.stringify(input.php)}`);
  const name = toolsContainer(input.runId, input.step);
  const net = accountNetwork(input.accountId);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.env ?? {})) {
    if (ENV_KEY_RE.test(k) && typeof v === 'string' && !v.includes('\0')) env[k] = v;
  }
  Object.assign(env, TOOLS_ENV);

  const memoryBytes = Math.max(64, Math.floor(input.memoryMb)) * 1048576;
  const cpus = effectiveSiteLimits({ memoryMb: input.limits.memoryMb, cpuCores: input.limits.cpuCores }, input.ceiling).cpus;

  const hostConfig: Docker.HostConfig = {
    Mounts: [
      { Type: 'bind', Source: posix(input.workspaceDir), Target: CONTAINER_PATHS.toolsApp, ReadOnly: input.workspaceReadOnly },
      { Type: 'bind', Source: posix(input.dataDir), Target: CONTAINER_PATHS.data, ReadOnly: false },
      { Type: 'bind', Source: posix(input.dbSockets.root), Target: CONTAINER_PATHS.dbSocketsAll, ReadOnly: true },
      { Type: 'bind', Source: posix(input.dbSockets.mysql), Target: CONTAINER_PATHS.dbSocketMysql, ReadOnly: true },
      { Type: 'bind', Source: posix(input.dbSockets.postgresql), Target: CONTAINER_PATHS.dbSocketPostgresql, ReadOnly: true },
    ],
    Tmpfs: {
      '/tmp': `${TMPFS_SHARED_FLAGS},size=${TOOLS_TMP_SIZE}`,
      '/run': `${TMPFS_SHARED_FLAGS},size=${TOOLS_RUN_SIZE}`,
    },
    ReadonlyRootfs: true,
    CapDrop: ['ALL'],
    SecurityOpt: [NO_NEW_PRIVILEGES, TENANT_SECCOMP_OPT],
    PidsLimit: TOOLS_PIDS_LIMIT,
    Memory: memoryBytes,
    MemorySwap: memoryBytes,
    OomScoreAdj: TENANT_OOM_SCORE_ADJ,
    RestartPolicy: { Name: 'no' },
    NetworkMode: net,
    LogConfig: LOG_CONFIG,
    // Explicitly nothing published, no privileged mode, no devices.
    PortBindings: {},
    Privileged: false,
  };
  if (cpus !== null) hostConfig.NanoCpus = Math.round(cpus * 1e9);

  return withSpecHash({
    name,
    Image: toolsImage(input.php),
    Cmd: [...input.argv],
    User: `${input.uid}:${input.gid}`,
    WorkingDir: CONTAINER_PATHS.toolsApp,
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    Labels: {
      [LABELS.internal]: 'true',
      [LABELS.account]: String(input.accountId),
      [LABELS.site]: String(input.siteId),
      [LABELS.role]: 'tools',
      [P3_LABELS.adapterRun]: String(input.runId),
    },
    AttachStdin: false,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    OpenStdin: false,
    ExposedPorts: {},
    HostConfig: hostConfig,
    NetworkingConfig: { EndpointsConfig: { [net]: {} } },
  });
}
