import path from 'path';
import type Docker from 'dockerode';
import { appContainer, appServiceAlias, appVolume, LABELS, P4B_LABELS } from '../hosting/naming';
import { LOG_CONFIG, NO_NEW_PRIVILEGES, TENANT_OOM_SCORE_ADJ, withSpecHash } from '../docker/specs';
import { TENANT_SECCOMP_OPT } from '../docker/seccomp';
import type { ResolvedService } from './compose/validate';

// ─────────────────────────────────────────────────────────────────────────────
// PURE Docker specs of the app containers / volumes / private networks
// (docs/P4b-PLAN.md §5.2 "Imposé", invariants AP1, AP2, SG3, SG5).
// Every app container: CapDrop ALL + the validated cap_add, SecurityOpt
// [no-new-privileges, tenant seccomp], NO PortBindings (nothing published,
// ever), PidsLimit, Memory = MemorySwap (no swap), NanoCpus, OomScoreAdj of
// the tenants, the P1 log driver, labels oblimint.internal / account / app /
// app-service / role=app + spec-hash; never the Docker socket (the validator
// refuses it), binds only under the stack directory. Networks: the stack's
// private networks (service name + compose aliases), the account FRONT
// fabric for services with exposed ports (alias app-<stackId>-<service>,
// the edge upstream), the BACK fabric for link participants (same alias).
// The writable layer is bounded (StorageOpt size) when the caller gives a limit.
// ─────────────────────────────────────────────────────────────────────────────

export interface AppContainerInput {
  stackId: number;
  accountId: number;
  service: ResolvedService;
  /** Image actually run: digest-pinned reference, or the built tag. */
  image: string;
  /** compose network name → Docker network name (private networks of the stack). */
  privateNetworks: ReadonlyMap<string, string>;
  /** Account fabrics to join (null = not joined). */
  front: string | null;
  back: string | null;
  /** Host directory bind sources are relative to: the deployment's source snapshot (or the stack directory). */
  hostStackDir: string;
  /** Bound of the container's writable layer (Docker StorageOpt size, overlay2 on XFS pquota); null / absent = none. */
  rootfsBytes?: number | null;
}

export interface AppContainerPlan {
  name: string;
  /** Create options (NetworkingConfig carries the primary network only; the hash covers every network). */
  create: Docker.ContainerCreateOptions;
  hash: string;
  /** Networks connected after creation, with their aliases. */
  extraNetworks: Array<{ network: string; aliases: string[] }>;
}

const MIN_MEMORY_BYTES = 6 * 1048576;

function healthConfig(s: ResolvedService): Docker.HealthConfig | undefined {
  if (!s.health) return undefined;
  if (s.health.test[0] === 'NONE') return { Test: ['NONE'] };
  const ns = (ms: number | null) => (ms === null ? undefined : Math.round(ms * 1e6));
  return {
    Test: s.health.test,
    Interval: ns(s.health.intervalMs),
    Timeout: ns(s.health.timeoutMs),
    Retries: s.health.retries ?? undefined,
    StartPeriod: ns(s.health.startPeriodMs),
    ...(s.health.startIntervalMs !== null ? { StartInterval: ns(s.health.startIntervalMs) } : {}),
  } as Docker.HealthConfig;
}

function tmpfsOptions(t: { sizeBytes: number; mode: string | null }): string {
  return `rw,nosuid,nodev,size=${t.sizeBytes}${t.mode ? `,mode=${t.mode}` : ''}`;
}

export function appContainerPlan(input: AppContainerInput): AppContainerPlan {
  const s = input.service;
  const name = appContainer(input.stackId, s.name);
  const alias = appServiceAlias(input.stackId, s.name);
  const labels: Record<string, string> = {
    ...s.labels,
    [LABELS.internal]: 'true',
    [LABELS.account]: String(input.accountId),
    [P4B_LABELS.app]: String(input.stackId),
    [P4B_LABELS.appService]: s.name,
    [LABELS.role]: 'app',
  };

  // Endpoints: private networks first (in the service's order), then the fabrics.
  const endpoints: Array<{ network: string; aliases: string[] }> = [];
  if (!s.networkNone) {
    for (const n of s.networks) {
      const docker = input.privateNetworks.get(n);
      if (!docker) continue;
      endpoints.push({ network: docker, aliases: [...new Set([s.name, ...(s.networkAliases[n] ?? [])])] });
    }
    if (input.front) endpoints.push({ network: input.front, aliases: [alias] });
    if (input.back && input.back !== input.front) endpoints.push({ network: input.back, aliases: [alias] });
  }

  const mounts: Docker.MountSettings[] = s.volumes.map((v) => (v.kind === 'volume'
    ? { Type: 'volume' as const, Source: appVolume(input.stackId, v.source), Target: v.target, ReadOnly: v.readOnly }
    : { Type: 'bind' as const, Source: path.posix.join(input.hostStackDir.replace(/\\/g, '/'), v.source), Target: v.target, ReadOnly: true /* never writable: AP1/R1, see compose/validate.ts */, BindOptions: { Propagation: 'rprivate' } }));

  const memory = Math.max(MIN_MEMORY_BYTES, Math.round(s.limits.memoryMb * 1048576));
  const hostConfig: Docker.HostConfig = {
    Mounts: mounts,
    Tmpfs: Object.fromEntries(s.tmpfs.map((t) => [t.target, tmpfsOptions(t)])),
    ReadonlyRootfs: s.readOnlyRootfs,
    // The writable layer lives in /var/lib/docker, outside the account's XFS quota: bounded (security audit P4b).
    ...(input.rootfsBytes ? { StorageOpt: { size: `${Math.max(1, Math.round(input.rootfsBytes / 1048576))}M` } } : {}),
    Privileged: false,
    PublishAllPorts: false,
    CapDrop: ['ALL'],
    CapAdd: [...s.capAdd],
    SecurityOpt: [NO_NEW_PRIVILEGES, TENANT_SECCOMP_OPT],
    PidsLimit: Math.max(1, s.limits.pids),
    Memory: memory,
    MemorySwap: memory,
    NanoCpus: Math.max(1e7, Math.round(s.limits.cpus * 1e9)),
    OomScoreAdj: TENANT_OOM_SCORE_ADJ,
    LogConfig: LOG_CONFIG,
    RestartPolicy: { Name: s.restart, ...(s.restart === 'on-failure' && s.restartMaxRetries !== null ? { MaximumRetryCount: s.restartMaxRetries } : {}) },
    NetworkMode: s.networkNone ? 'none' : endpoints[0]?.network ?? 'none',
    ...(s.shmSizeBytes !== null ? { ShmSize: s.shmSizeBytes } : {}),
    ...(s.ulimits.length ? { Ulimits: s.ulimits.map((u) => ({ Name: u.name, Soft: u.soft, Hard: u.hard })) } : {}),
    ...(s.extraHosts.length ? { ExtraHosts: [...s.extraHosts] } : {}),
    ...(s.init !== null ? { Init: s.init } : {}),
    ...(s.groupAdd.length ? { GroupAdd: [...s.groupAdd] } : {}),
  };

  const full: Docker.ContainerCreateOptions = {
    name,
    Image: input.image,
    Env: s.environment.map(([k, v]) => `${k}=${v}`),
    Labels: labels,
    ...(s.command ? { Cmd: s.command } : {}),
    ...(s.entrypoint ? { Entrypoint: s.entrypoint } : {}),
    ...(s.user ? { User: s.user } : {}),
    ...(s.workingDir ? { WorkingDir: s.workingDir } : {}),
    ...(s.stopSignal ? { StopSignal: s.stopSignal } : {}),
    ...(s.stopGraceSec !== null ? { StopTimeout: s.stopGraceSec } : {}),
    ...(s.tty ? { Tty: true } : {}),
    ...(s.stdinOpen ? { OpenStdin: true } : {}),
    ExposedPorts: Object.fromEntries(s.exposedPorts.map((p) => [`${p.port}/${p.protocol}`, {}])),
    ...(healthConfig(s) ? { Healthcheck: healthConfig(s) } : {}),
    HostConfig: hostConfig,
    NetworkingConfig: { EndpointsConfig: Object.fromEntries(endpoints.map((e) => [e.network, { Aliases: e.aliases }])) },
  };
  const hashed = withSpecHash(full);
  const hash = hashed.Labels![LABELS.specHash];
  const primary = endpoints[0];
  const create: Docker.ContainerCreateOptions = {
    ...hashed,
    NetworkingConfig: { EndpointsConfig: primary && !s.networkNone ? { [primary.network]: { Aliases: primary.aliases } } : {} },
  };
  return { name, create, hash, extraNetworks: s.networkNone ? [] : endpoints.slice(1) };
}

/** Named volume of a stack: local driver bound to the stack's volume directory (XFS quota of the account). */
export function appVolumeSpec(stackId: number, accountId: number, name: string, hostDir: string): Docker.VolumeCreateOptions {
  return {
    Name: appVolume(stackId, name),
    Driver: 'local',
    DriverOpts: { type: 'none', o: 'bind', device: hostDir.replace(/\\/g, '/') },
    Labels: { [LABELS.internal]: 'true', [LABELS.account]: String(accountId), [P4B_LABELS.app]: String(stackId) },
  };
}

/** Labels of a private network of a stack (SG5: NEVER oblimint.account — the edge joins those). */
export function appNetworkLabels(stackId: number): Record<string, string> {
  return { [LABELS.internal]: 'true', [P4B_LABELS.appNetwork]: String(stackId) };
}
