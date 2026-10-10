import path from 'path';
import type Docker from 'dockerode';
import type { AppStackStatus } from '@oblimint/shared';
import { pack } from 'tar-fs';
import { config } from '../../config';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { errText } from '../setup/docker';
import {
  cleanName, connectNetwork, createContainer, createNetwork, inspectContainer, labelHash, listByLabel, removeContainer, removeNetwork, startContainer,
} from '../docker/dockerOps';
import { appBuildImage, appContainer, P4B_LABELS, LABELS } from '../hosting/naming';
import type { AppsDeps } from './deps';
import type { DeployLog } from './deployLog';
import { digestFromRepoDigests, formatImageRef, parseImageRef, pinnedRef } from './compose/image';
import type { ResolvedService, ResolvedStack } from './compose/validate';
import { kindNoFollow, mkdirNoFollow } from './fsSafe';
import { appContainerPlan, appNetworkLabels, appVolumeSpec } from './specs';
import { buildImage, CancelledError, createVolume, inspectImage, pullWithAuth, serverAddress, unpauseContainer, waitContainer } from './appDocker';
import { SNAPSHOTS_DIR } from './snapshots';
import type { RegistryAuth } from './registry.service';

// ─────────────────────────────────────────────────────────────────────────────
// Native deployment of a stack (docs/P4b-PLAN.md §5.1) — NO `docker compose`.
// Steps: account fabrics (segmentation) → images (authenticated pull with
// the AP6 cache rule / build) → private networks (panel-allocated subnets)
// → volumes (directories + local o=bind named volumes) → specs → diff by
// spec hash → create / recreate in depends_on order, waiting for
// service_healthy / service_completed_successfully (≤ 120 s) → start →
// orphan containers / stale networks removed. The policy + edge syncs are
// requested by the caller AFTER the new effective config is saved
// (deployments.ts runJob), never from here: the policy push reads it.
// Binds and build contexts come from the deployment's immutable source
// snapshot (StackRef.sourceLocalDir / sourceHostDir, snapshots.ts). Builds run
// on a dedicated per-stack network that never carries a platform container
// (raw sockets of a RUN step cannot reach the account fabrics), under the
// plan's memory / CPU and the configured cgroup parent (pids). Each container's
// writable layer is bounded (StorageOpt size, config appRootfsMaxMb) and every
// image is capped in size (appImageMaxMb).
// Cancellation: checkpoint() between steps, the running pull / build stream
// is destroyed through the AbortSignal. No DB access here (deployments.ts
// persists): unit-tested with a fake Docker.
// ─────────────────────────────────────────────────────────────────────────────

export const DEPENDENCY_WAIT_MS = 120_000;

/** A failure shown to the user: French label (+ raw cause for the staff). */
export class DeployFailure extends Error {
  constructor(readonly label: string, readonly cause_: string | null = null) {
    super(cause_ ? `${label} : ${cause_}` : label);
    this.name = 'DeployFailure';
  }
}

export interface StackRef {
  id: number;
  accountId: number;
  tenantId: number;
  /** Stack directory as seen by the panel (localPaths.appStack). */
  localDir: string;
  /** Stack directory on the Docker host (hostPaths.appStack): volume sources. */
  hostDir: string;
  /**
   * Where the relative source paths of the compose (src/… or files/…: binds, build contexts) resolve: the
   * deployment's snapshot (<stack>/snapshots/<id>), as seen by the panel and by the Docker host. Default:
   * the stack directory itself (no snapshot: the stack mounts no source file and builds nothing).
   */
  sourceLocalDir?: string;
  sourceHostDir?: string;
}

/** Name (invalid in a compose: leading '-') of the per-stack build network. */
export const BUILD_NETWORK_NAME = '-build';

/** app_image_pulls of the account (AP6). */
export interface ImageStore {
  pulledByAccount(image: string): Promise<boolean>;
  recordPull(image: string, digest: string | null, authenticated: boolean): Promise<void>;
}

export interface ConvergeInput {
  docker: Docker;
  deps: AppsDeps;
  stack: StackRef;
  resolved: ResolvedStack;
  log: DeployLog;
  checkpoint(): void;
  signal: AbortSignal;
  deploymentId: number;
  auths: ReadonlyMap<string, RegistryAuth>;
  images: ImageStore;
  /** Services whose image is pulled even when present ('all' = redeploy / pull). */
  alwaysPull: 'all' | ReadonlySet<string> | null;
  /** Digest pins per service (current digest, rollback / update target). Ignored for a service pulled 'always'. */
  pins: Readonly<Record<string, string>>;
  /** Built tags of the previous deployment per service (reused unless rebuild). */
  builtTags: Readonly<Record<string, string>>;
  rebuild: boolean;
  /** Recreate these containers even when their spec did not change ('all' = recreate action). */
  force: 'all' | ReadonlySet<string> | null;
  /** Converge only these services (update / image rollback); others are left untouched, orphans kept. */
  only: ReadonlySet<string> | null;
  /** Build resources (plan of the account). */
  buildLimits: { memoryMb: number; cpus: number };
  /** Skip the container phase (pull action). */
  imagesOnly?: boolean;
}

export interface ConvergeResult {
  /** service → digest (sha256:…) or built tag. */
  images: Record<string, string>;
  /** service → reference actually run. */
  refs: Record<string, string>;
  specHashes: Record<string, string>;
  backServices: string[];
}

const has = (set: 'all' | ReadonlySet<string> | null, name: string) => set === 'all' || (!!set && set.has(name));

/** Calls a segmentation contract; its stub (501) or failure becomes a French deployment failure. */
async function segmentation<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError && err.code === 'notImplemented') {
      throw new DeployFailure('La segmentation réseau n\'est pas encore disponible sur ce serveur : déploiement impossible', what);
    }
    throw new DeployFailure('Préparation du réseau de l\'application impossible', `${what}: ${errText(err)}`);
  }
}

/** Refuses an image above config appImageMaxMb (built ones are removed). */
async function assertImageSize(docker: Docker, ref: string, svcName: string, built: boolean): Promise<void> {
  const maxMb = config.hosting.appImageMaxMb;
  if (!maxMb) return;
  const info = await inspectImage(docker, ref);
  const size = Number((info as { Size?: number } | null)?.Size ?? 0);
  if (size > maxMb * 1048576) {
    if (built) await docker.getImage(ref).remove({ force: true }).catch(() => undefined);
    throw new DeployFailure(`L'image de ${svcName} dépasse la taille maximale autorisée (${Math.round(size / 1048576)} Mio > ${maxMb} Mio)`, ref);
  }
}

async function resolveImage(input: ConvergeInput, svc: ResolvedService, buildNetwork: () => Promise<string>): Promise<{ run: string; image: string }> {
  const { docker, log, stack } = input;
  const sourceDir = stack.sourceLocalDir ?? stack.localDir;
  if (svc.buildSpec) {
    const prev = input.builtTags[svc.name];
    if (!input.rebuild && prev && await inspectImage(docker, prev)) {
      log.add(`Image construite réutilisée pour ${svc.name} (${prev})`);
      return { run: prev, image: prev };
    }
    const tag = appBuildImage(stack.id, svc.name, String(input.deploymentId));
    const contextDir = path.join(sourceDir, ...svc.buildSpec.context.split('/'));
    if (kindNoFollow(sourceDir, svc.buildSpec.context) !== 'dir') throw new DeployFailure(`Contexte de construction introuvable pour ${svc.name}`, svc.buildSpec.context);
    const network = await buildNetwork();
    log.add(`Construction de l'image de ${svc.name}…`);
    const tar = pack(contextDir, { dereference: false, ignore: (name: string) => /(^|[\\/])\.git([\\/]|$)/.test(path.relative(contextDir, name)) });
    const registryconfig: Record<string, { username: string; password: string }> = {};
    for (const a of input.auths.values()) registryconfig[serverAddress(a.registry)] = { username: a.username, password: a.password };
    try {
      await buildImage(docker, tar, {
        t: tag,
        dockerfile: svc.buildSpec.dockerfile,
        buildargs: JSON.stringify(svc.buildSpec.args),
        ...(svc.buildSpec.target ? { target: svc.buildSpec.target } : {}),
        // Never the account fabric (SG3: a RUN step has NET_RAW): the stack's own build network.
        networkmode: network,
        ...(config.hosting.appBuildCgroupParent ? { cgroupparent: config.hosting.appBuildCgroupParent } : {}),
        memory: Math.round(input.buildLimits.memoryMb * 1048576),
        memswap: Math.round(input.buildLimits.memoryMb * 1048576),
        cpuperiod: 100000,
        cpuquota: Math.max(1000, Math.round(input.buildLimits.cpus * 100000)),
        rm: true,
        forcerm: true,
        pull: true,
        labels: JSON.stringify({ [LABELS.internal]: 'true', [LABELS.account]: String(stack.accountId), [P4B_LABELS.app]: String(stack.id) }),
        ...(Object.keys(registryconfig).length ? { registryconfig } : {}),
      }, (l) => log.add(l), input.signal);
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      throw new DeployFailure(`Construction de l'image de ${svc.name} échouée`, errText(err));
    }
    await assertImageSize(docker, tag, svc.name, true);
    log.add(`Image ${tag} construite`);
    return { run: tag, image: tag };
  }

  const ref = parseImageRef(svc.imageRef ?? '');
  if (!ref) throw new DeployFailure(`Référence d'image invalide pour ${svc.name}`);
  const key = formatImageRef(ref);
  const auth = input.auths.get(ref.registry) ?? null;
  const always = has(input.alwaysPull, svc.name);
  const pin = ref.digest && !ref.tag ? ref.digest : always ? null : input.pins[svc.name] ?? null;
  const pinned = pin ? pinnedRef(ref, pin) : null;
  const pulledBefore = await input.images.pulledByAccount(key);
  let local = await inspectImage(docker, pinned ?? key);
  // AP6: an image this account never pulled successfully is never taken from the cache.
  const mustPull = always || !local || !pulledBefore;
  if (mustPull) {
    const target = pinned ?? key;
    log.add(`Tirage de ${target}${auth ? ' (authentifié)' : ''}…`);
    try {
      await pullWithAuth(docker, target, auth ? { username: auth.username, password: auth.password, serveraddress: serverAddress(auth.registry) } : null,
        (l) => log.add(l), input.signal);
      local = await inspectImage(docker, target);
      const digest = local ? digestFromRepoDigests(ref, local.RepoDigests) : null;
      await input.images.recordPull(key, digest ?? pin, !!auth);
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      if (local && pulledBefore) {
        logger.info({ stackId: stack.id, image: key, err: errText(err) }, 'apps: pull failed, cached image used');
        log.add('Tirage impossible — image en cache utilisée (déjà tirée par ce compte)');
      } else {
        const authFail = /unauthorized|denied|authentication required|401|403/i.test(errText(err));
        throw new DeployFailure(authFail ? `Accès refusé par le registre pour ${key}` : `Image ${key} indisponible`, errText(err));
      }
    }
  }
  if (!local) throw new DeployFailure(`Image ${key} introuvable après le tirage`);
  if (mustPull) await assertImageSize(docker, pinned ?? key, svc.name, false);
  const digest = pin ?? digestFromRepoDigests(ref, local.RepoDigests);
  return { run: digest ? pinnedRef(ref, digest) : key, image: digest ?? key };
}

export async function converge(input: ConvergeInput): Promise<ConvergeResult> {
  const { docker, deps, stack, resolved, log } = input;
  const result: ConvergeResult = { images: {}, refs: {}, specHashes: {}, backServices: [] };
  const targets = resolved.services.filter((s) => !input.only || input.only.has(s.name));

  input.checkpoint();
  log.add('Réseaux du compte…');
  const fabrics = await segmentation('ensureAccountFabrics', () => deps.segments.ensureAccountFabrics(stack.accountId));
  const fabricPlan = await segmentation('stackFabricPlan', () => deps.segments.stackFabricPlan(stack.id));
  const back = new Set(fabricPlan.backServices);
  result.backServices = resolved.services.filter((s) => back.has(s.name)).map((s) => s.name);

  // ── images (builds on the stack's own network, removed afterwards) ──
  let buildNet: string | null = null;
  const buildNetwork = async (): Promise<string> => {
    if (buildNet) return buildNet;
    const [a] = await segmentation('allocateAppNetworks', () => deps.segments.allocateAppNetworks(stack.id, stack.accountId, [BUILD_NETWORK_NAME]));
    if (!a) throw new DeployFailure('Réseau de construction indisponible');
    await createNetwork(docker, a.dockerName, appNetworkLabels(stack.id), { subnet: a.subnet, gateway: a.gateway, internal: false });
    buildNet = a.dockerName;
    return buildNet;
  };
  try {
    for (const svc of targets) {
      input.checkpoint();
      const img = await resolveImage(input, svc, buildNetwork);
      result.images[svc.name] = img.image;
      result.refs[svc.name] = img.run;
    }
  } finally {
    if (buildNet) await removeNetwork(docker, buildNet).catch((err) => logger.warn({ stackId: stack.id, err: errText(err) }, 'apps: build network not removed'));
  }
  if (input.imagesOnly) return result;
  const rootfsBytes = await rootfsLimit(docker, log);

  // ── private networks ──
  input.checkpoint();
  const names = resolved.effective.networks.map((n) => n.name);
  const allocated = names.length ? await segmentation('allocateAppNetworks', () => deps.segments.allocateAppNetworks(stack.id, stack.accountId, names)) : [];
  const privateNetworks = new Map<string, string>();
  for (const a of allocated) {
    const internal = resolved.effective.networks.find((n) => n.name === a.name)?.internal ?? false;
    await createNetwork(docker, a.dockerName, appNetworkLabels(stack.id), { subnet: a.subnet, gateway: a.gateway, internal });
    privateNetworks.set(a.name, a.dockerName);
  }
  if (allocated.length) log.add(`Réseaux privés prêts (${allocated.map((a) => a.name).join(', ')})`);

  // ── volumes + bind sources (R1: never through a link) ──
  input.checkpoint();
  const sourceLocalDir = stack.sourceLocalDir ?? stack.localDir;
  try {
    for (const v of resolved.effective.volumes) {
      mkdirNoFollow(stack.localDir, `volumes/${v}`);
      await createVolume(docker, appVolumeSpec(stack.id, stack.accountId, v, path.posix.join(stack.hostDir.replace(/\\/g, '/'), 'volumes', v)));
    }
    for (const svc of targets) {
      for (const v of svc.volumes) {
        if (v.kind !== 'bind') continue;
        const k = kindNoFollow(sourceLocalDir, v.source);
        if (k === 'symlink') throw new DeployFailure(`Un lien symbolique est présent dans le chemin monté par ${svc.name}`, v.source);
        if (k === 'missing') mkdirNoFollow(sourceLocalDir, v.source);
      }
    }
  } catch (err) {
    if (err instanceof DeployFailure) throw err;
    throw new DeployFailure('Préparation des volumes impossible', errText(err));
  }
  if (resolved.effective.volumes.length) log.add(`Volumes prêts (${resolved.effective.volumes.join(', ')})`);

  // ── containers, in depends_on order ──
  const byName = new Map(resolved.services.map((s) => [s.name, s]));
  for (const svc of resolved.services) {
    const plan = appContainerPlan({
      stackId: stack.id, accountId: stack.accountId, service: svc, image: result.refs[svc.name] ?? '',
      privateNetworks, front: svc.exposedPorts.length && !svc.networkNone ? fabrics.front : null,
      back: back.has(svc.name) && !svc.networkNone ? fabrics.back : null, hostStackDir: stack.sourceHostDir ?? stack.hostDir, rootfsBytes,
    });
    if (!input.only || input.only.has(svc.name)) result.specHashes[svc.name] = plan.hash;
    if (input.only && !input.only.has(svc.name)) continue;
    input.checkpoint();
    for (const dep of svc.dependsOn) {
      if (dep.condition === 'started' || !byName.has(dep.service)) continue;
      log.add(`${svc.name} attend ${dep.service} (${dep.condition === 'healthy' ? 'sain' : 'terminé'})…`);
      try {
        await waitContainer(docker, appContainer(stack.id, dep.service), dep.condition, DEPENDENCY_WAIT_MS, deps.sleep, deps.now, input.checkpoint);
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        throw new DeployFailure(`Dépendance ${dep.service} de ${svc.name} non prête`, errText(err));
      }
    }
    const info = await inspectContainer(docker, plan.name);
    const recreate = !info || has(input.force, svc.name) || labelHash(info.Config?.Labels) !== plan.hash;
    try {
      if (recreate) {
        log.add(info ? `Recréation de ${svc.name}…` : `Création de ${svc.name}…`);
        await removeContainer(docker, plan.name);
        await createContainer(docker, plan.create);
        for (const extra of plan.extraNetworks) await connectNetwork(docker, extra.network, plan.name, extra.aliases);
        await startContainer(docker, plan.name);
      } else {
        const nets = info.NetworkSettings?.Networks ?? {};
        for (const extra of plan.extraNetworks) if (!nets[extra.network]) await connectNetwork(docker, extra.network, plan.name, extra.aliases);
        if (info.State?.Paused) await unpauseContainer(docker, plan.name);
        if (!info.State?.Running) {
          log.add(`Démarrage de ${svc.name}…`);
          await startContainer(docker, plan.name);
        } else log.add(`${svc.name} à jour`);
      }
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      if (/storage-?opt/i.test(errText(err))) throw new DeployFailure(ROOTFS_UNSUPPORTED, errText(err));
      throw new DeployFailure(`Le conteneur ${svc.name} n'a pas pu démarrer`, errText(err));
    }
  }

  // ── orphans + stale private networks (full converges only) ──
  if (!input.only) {
    const wanted = new Set(resolved.services.map((s) => appContainer(stack.id, s.name)));
    for (const c of await listByLabel(docker, `${P4B_LABELS.app}=${stack.id}`)) {
      const name = cleanName(c.Names?.[0]);
      if (name && !wanted.has(name) && c.Labels?.[LABELS.role] === 'app') {
        log.add(`Suppression du conteneur orphelin ${name}`);
        await removeContainer(docker, name);
      }
    }
    const keep = new Set(allocated.map((a) => a.dockerName));
    try {
      const nets = await docker.listNetworks({ filters: { label: [`${P4B_LABELS.appNetwork}=${stack.id}`] } }) as Array<{ Name: string }>;
      for (const n of nets) if (!keep.has(n.Name)) await removeNetwork(docker, n.Name).catch(() => undefined);
    } catch { /* best effort */ }
  }
  return result;
}

const ROOTFS_UNSUPPORTED = "Le stockage Docker de ce serveur ne permet pas de borner l'espace disque des conteneurs (overlay2 sur XFS avec pquota requis)";

/** Docker daemons whose storage driver was checked (StorageOpt size support), by Docker object. */
const rootfsSupport = new WeakMap<object, Promise<boolean>>();

/**
 * Bound of the writable layer of the app containers (bytes), null when unbounded by configuration. The
 * daemon must run overlay2 on XFS (pquota checked by Docker itself at create time); otherwise the
 * deployment is refused unless allowUnboundedAppRootfs (then logged).
 */
async function rootfsLimit(docker: Docker, log: DeployLog): Promise<number | null> {
  const maxMb = config.hosting.appRootfsMaxMb;
  if (!maxMb) return null;
  let probe = rootfsSupport.get(docker);
  if (!probe) {
    probe = (async () => {
      try {
        const info = await (docker as unknown as { info(): Promise<{ Driver?: string; DriverStatus?: Array<[string, string]> | null }> }).info();
        const backing = (info.DriverStatus ?? []).find((e) => Array.isArray(e) && /backing filesystem/i.test(String(e[0])))?.[1];
        return info.Driver === 'overlay2' && String(backing ?? '').toLowerCase() === 'xfs';
      } catch {
        return false;
      }
    })();
    rootfsSupport.set(docker, probe);
  }
  if (await probe) return maxMb * 1048576;
  if (config.hosting.allowUnboundedAppRootfs) {
    log.add("Avertissement : l'espace disque des conteneurs n'est pas borné sur ce serveur (overlay2 sur XFS requis)");
    return null;
  }
  throw new DeployFailure(ROOTFS_UNSUPPORTED);
}

/**
 * Bind mounts of an existing app container that do NOT come from an immutable deployment snapshot of its
 * stack (a container created before the snapshots, or a source path that is now a link / missing). Such a
 * container must be recreated, never started as is: Docker re-resolves a bind source at every start and
 * follows symbolic links on the host. Returns the offending sources (empty = safe to start).
 */
export function unsafeBindSources(stack: Pick<StackRef, 'localDir' | 'hostDir'>, mounts: ReadonlyArray<{ Type?: string; Source?: string }> | undefined | null): string[] {
  const host = stack.hostDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const prefix = `${host}/${SNAPSHOTS_DIR}/`;
  const out: string[] = [];
  for (const m of mounts ?? []) {
    if (m.Type !== 'bind') continue;
    const src = String(m.Source ?? '').replace(/\\/g, '/');
    if (!src.startsWith(prefix)) { out.push(src); continue; }
    const rel = src.slice(host.length + 1);
    let kind: ReturnType<typeof kindNoFollow>;
    try { kind = kindNoFollow(stack.localDir, rel); } catch { kind = 'missing'; }
    if (kind !== 'dir' && kind !== 'file') out.push(src);
  }
  return out;
}

/** Verifies an updated service stays up: healthy (healthcheck) or running without restart for `stableMs`. */
export async function checkServiceHealth(docker: Docker, deps: AppsDeps, stackId: number, svc: ResolvedService, timeoutMs: number, stableMs: number, checkpoint: () => void): Promise<void> {
  const name = appContainer(stackId, svc.name);
  if (svc.healthcheck) {
    await waitContainer(docker, name, 'healthy', timeoutMs, deps.sleep, deps.now, checkpoint);
    return;
  }
  await waitContainer(docker, name, 'started', timeoutMs, deps.sleep, deps.now, checkpoint);
  const before = (await docker.getContainer(name).inspect()).RestartCount ?? 0;
  if (stableMs > 0) await deps.sleep(stableMs);
  const after = await docker.getContainer(name).inspect();
  if (!after.State?.Running || (after.RestartCount ?? 0) !== before) throw new Error(`${name} did not stay up`);
}

/**
 * After a (re)deploy: watches the long-running services (restart policy other than 'no') for one shared
 * `stableMs` window and returns those that did not stay up — restarted (RestartCount moved), not running
 * (exited / restarting / gone) or reported unhealthy. A crash-looping service without a healthcheck is
 * 'running' for a moment after each restart: without this window the deployment would publish the stack as
 * 'running' and only the next reconcile pass would see it 'partial'. One-shot services (restart 'no') are
 * judged by statusFromContainers (exit code), not here.
 */
export async function unstableServices(
  docker: Docker, deps: AppsDeps, stackId: number, services: ReadonlyArray<Pick<ResolvedService, 'name' | 'restart'>>, stableMs: number, checkpoint: () => void,
): Promise<string[]> {
  const watched = services.filter((s) => s.restart !== 'no');
  if (!watched.length) return [];
  const inspect = async (name: string): Promise<Docker.ContainerInspectInfo | null> => {
    try { return await docker.getContainer(appContainer(stackId, name)).inspect(); } catch { return null; }
  };
  const before = new Map<string, number>();
  for (const s of watched) before.set(s.name, (await inspect(s.name))?.RestartCount ?? 0);
  checkpoint();
  if (stableMs > 0) await deps.sleep(stableMs);
  checkpoint();
  const out: string[] = [];
  for (const s of watched) {
    const info = await inspect(s.name);
    const st = info?.State;
    const unhealthy = (st as { Health?: { Status?: string } } | undefined)?.Health?.Status === 'unhealthy';
    if (!info || !st?.Running || st.Restarting || unhealthy || (info.RestartCount ?? 0) !== before.get(s.name)) out.push(s.name);
  }
  return out;
}

/**
 * Final stack status of a (re)deploy once the post-deploy window flagged crash-looping services: a stack the
 * containers alone would call 'running' is 'partial' (some services up) or 'error' (none), with a message
 * naming them.
 */
export function withUnstable(
  computed: { status: AppStackStatus; message: string | null }, unstable: readonly string[], total: number,
): { status: AppStackStatus; message: string | null } {
  if (!unstable.length || (computed.status !== 'running' && computed.status !== 'partial')) return computed;
  const names = unstable.join(', ');
  if (total > 0 && unstable.length >= total) return { status: 'error', message: `Service(s) en échec répété : ${names}` };
  return { status: 'partial', message: `Service(s) en échec répété : ${names} (${unstable.length} sur ${total})` };
}

/** Every container of a stack (label oblimint.app), by service. */
export async function stackContainersOf(docker: Docker, stackId: number): Promise<Map<string, Docker.ContainerInfo>> {
  const out = new Map<string, Docker.ContainerInfo>();
  for (const c of await listByLabel(docker, `${P4B_LABELS.app}=${stackId}`)) {
    const svc = c.Labels?.[P4B_LABELS.appService];
    if (svc && c.Labels?.[LABELS.role] === 'app') out.set(svc, c);
  }
  return out;
}
