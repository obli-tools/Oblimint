import crypto from 'crypto';
import type Docker from 'dockerode';
import type {
  PlatformComponentKind, PlatformImageStatus, PlatformUpdatePolicy, PlatformUpdateRequest, PlatformUpdateRun, PlatformUpdatesState,
  PlatformUpdatesSummary, PlatformUpdateTrigger,
} from '@oblimint/shared';
import { HostingSocketEvents, MASTER_TENANT_ID } from '@oblimint/shared';
import { config } from '../../config';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { appConfigService } from '../appConfig.service';
import { parseImageRef } from '../apps/compose/image';
import { remoteDigest, RegistryCheckError } from '../apps/registryClient';
import { auditService } from '../audit.service';
import { inspectContainer, isNotFound, pullImage, startContainer, stopContainer } from '../docker/dockerOps';
import { engineFor, localNodeId } from '../docker/engine';
import { LABELS } from '../hosting/naming';
import { nextWindowOpening, windowIsOpen } from '../monitoring/schedule';
import { errText, selfContainerRef, withTimeout } from '../setup/docker';
import {
  autoRunImages, autoUpdateAllowed, buildImageList, checkDue, needsConfigImage, normalizePolicy, planRun,
  type LocalImage, type ObservedContainer, type RememberedImage, type UpdateStep,
} from './catalog';
import {
  demuxDockerLogs, dockerSocketBind, helperCreateOptions, OLD_PANEL_RE, parseHelperResult, UPDATER_ROLE, UPDATER_RUN_LABEL,
} from './selfUpdateSpec';

// ─────────────────────────────────────────────────────────────────────────────
// Platform updates (Nodes > Updates). Checks the registry digest of the
// configured tag for every platform image of the local node (registry client
// of the P4b app updates: Docker Hub token + HEAD manifest) and runs updates:
// pulls first, then recreates the managed containers through their own
// ensure() (infra.service / extensions: the specs, never a hand-built
// container), the account containers through the reconcile, the panel last
// through the self-update helper. The containers being replaced are kept
// (renamed, stopped) until their successor runs, and restored otherwise.
// State: app_config (remembered digests, last run, policy); progress on the
// role:admin socket room (PLATFORM_UPDATES).
// ─────────────────────────────────────────────────────────────────────────────

const POLICY_KEY = 'platform_updates.policy';
const stateKey = (nodeId: number) => `platform_updates.state.${nodeId}`;
const TICK_MS = 60_000;
const LOG_MAX = 300;
const SELF_HEALTH_TIMEOUT_SEC = 240;

interface StoredImage extends RememberedImage {
  /** Remote digest already notified (once per digest). */
  notifiedDigest?: string | null;
  /** Remote digest the failed run targeted (a newer digest clears the failure). */
  failedDigest?: string | null;
  /** The last check saw a remote digest other than the local one (summary without Docker). */
  available?: boolean;
}

interface StoredState {
  images: Record<string, StoredImage>;
  checkedAt: string | null;
  run: PlatformUpdateRun | null;
  lastRun: PlatformUpdateRun | null;
}

export interface PlatformUpdatesDeps {
  docker(nodeId: number): Promise<Docker>;
  localNodeId(): Promise<number>;
  fetch: typeof fetch;
  now(): Date;
  notify(event: 'platform.updateAvailable' | 'platform.updated' | 'platform.updateFailed', title: string, message: string, severity: 'info' | 'warning' | 'critical', key: string): void;
  /** Recreates the containers of an infra component through its ensure(). */
  ensureInfra(kind: PlatformComponentKind, log: (l: string) => void): Promise<void>;
  reconcileAccount(accountId: number): Promise<{ ok: boolean; errors: string[] }>;
  emit(payload: Record<string, unknown>): void;
}

const defaultDeps: PlatformUpdatesDeps = {
  docker: (nodeId) => engineFor(nodeId),
  localNodeId: () => localNodeId(),
  fetch: (...args) => fetch(...args),
  now: () => new Date(),
  notify(event, title, message, severity, key) {
    void import('../usage/notifications.service')
      .then((m) => m.notify(event, { tenantId: MASTER_TENANT_ID, platform: true, key, title, message, severity, link: '/manage/nodes?tab=updates' }))
      .catch(() => undefined);
  },
  async ensureInfra(kind, log) {
    const { infraService } = await import('../docker/infra.service');
    if (kind === 'edge') return infraService.ensureEdge(log);
    if (kind === 'hostd') return infraService.ensureHostd(log);
    const id = kind === 'dns' ? 'dns' : kind;
    const { extraInfraComponents } = await import('../docker/extensions');
    const c = (await extraInfraComponents()).find((x) => x.id === id);
    if (!c) throw new Error(`${kind}: no deployment path for this component`);
    await c.ensure(log);
  },
  async reconcileAccount(accountId) {
    const { reconcileService } = await import('../docker/reconcile.service');
    const r = await reconcileService.reconcileAccountNow(accountId);
    return { ok: r.ok, errors: r.errors };
  },
  emit(payload) {
    void import('../../socket').then((m) => m.getIO()?.to('role:admin').emit(HostingSocketEvents.PLATFORM_UPDATES, payload)).catch(() => undefined);
  },
};

let deps: PlatformUpdatesDeps = defaultDeps;
export function setPlatformUpdatesDepsForTests(d: Partial<PlatformUpdatesDeps> | null): void {
  deps = d ? { ...defaultDeps, ...d } : defaultDeps;
}

// ── persistence ─────────────────────────────────────────────────────────────

async function readJson<T>(key: string): Promise<T | null> {
  const raw = await appConfigService.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

async function loadState(nodeId: number): Promise<StoredState> {
  const s = await readJson<Partial<StoredState>>(stateKey(nodeId));
  return { images: s?.images && typeof s.images === 'object' ? s.images : {}, checkedAt: s?.checkedAt ?? null, run: s?.run ?? null, lastRun: s?.lastRun ?? null };
}

async function saveState(nodeId: number, s: StoredState): Promise<void> {
  await appConfigService.set(stateKey(nodeId), JSON.stringify(s));
}

async function loadPolicy(): Promise<PlatformUpdatePolicy> {
  return normalizePolicy(await readJson<unknown>(POLICY_KEY));
}

// ── observation ─────────────────────────────────────────────────────────────

interface Observation {
  docker: Docker;
  containers: ObservedContainer[];
  panelName: string | null;
  panelInfo: Docker.ContainerInspectInfo | null;
  extraRefs: Array<{ ref: string; kind: PlatformComponentKind }>;
  locals: Map<string, LocalImage | null>;
}

async function localImage(docker: Docker, ref: string): Promise<LocalImage | null> {
  try {
    const img = await withTimeout(docker.getImage(ref).inspect(), 15_000, `inspect ${ref}`);
    return { id: img.Id, repoDigests: img.RepoDigests ?? [], version: img.Config?.Labels?.['org.opencontainers.image.version'] ?? null };
  } catch {
    return null;
  }
}

async function observe(nodeId: number): Promise<Observation> {
  const docker = await deps.docker(nodeId);
  const list = await withTimeout(docker.listContainers({ all: true }), 30_000, 'list containers');
  const containers: ObservedContainer[] = list.map((c) => ({
    name: (c.Names?.[0] ?? '').replace(/^\//, ''),
    image: c.Image,
    imageId: c.ImageID,
    role: c.Labels?.[LABELS.role] ?? null,
  }));
  let panelInfo: Docker.ContainerInspectInfo | null = null;
  const self = selfContainerRef();
  if (self && nodeId === await deps.localNodeId()) panelInfo = await inspectContainer(docker, self).catch(() => null);
  const panelName = panelInfo ? panelInfo.Name.replace(/^\//, '') : null;
  // The panel's own reference (docker ps shows the id when the tag moved): Config.Image.
  if (panelInfo) {
    const own = containers.find((c) => c.name === panelName);
    if (own) own.image = panelInfo.Config.Image;
  }
  // A component whose tag moved to a newer image shows its image id in docker ps: its reference comes from Config.Image.
  for (const c of containers) {
    if (!c.role || c.name === panelName || !needsConfigImage(c.image)) continue;
    const info = await inspectContainer(docker, c.name).catch(() => null);
    if (info?.Config?.Image) c.image = info.Config.Image;
  }
  // Tools images present locally (ephemeral containers: followed by image).
  const extraRefs: Array<{ ref: string; kind: PlatformComponentKind }> = [];
  try {
    const imgs = await withTimeout(docker.listImages({ filters: { reference: [`${config.hosting.toolsImagePrefix}*:${config.hosting.imageTag}`] } }), 15_000, 'list images');
    for (const i of imgs) for (const t of i.RepoTags ?? []) if (t.startsWith(config.hosting.toolsImagePrefix)) extraRefs.push({ ref: t, kind: 'tools' });
  } catch (err) {
    logger.debug({ err: errText(err) }, 'platform updates: tools images not listed');
  }
  const refs = new Set([...containers.map((c) => c.image), ...extraRefs.map((x) => x.ref)]);
  const locals = new Map<string, LocalImage | null>();
  for (const ref of refs) {
    // Only references of followed containers are inspected (buildImageList filters the others out).
    if (ref.includes(':') || ref.includes('@')) locals.set(ref, await localImage(docker, ref));
  }
  return { docker, containers, panelName, panelInfo, extraRefs, locals };
}

function remembered(s: StoredState): Map<string, RememberedImage> {
  return new Map(Object.entries(s.images).map(([k, v]) => [k, { remoteDigest: v.remoteDigest ?? null, checkedAt: v.checkedAt ?? null, error: v.error ?? null, failed: !!v.failed }]));
}

// ── in-memory run state ─────────────────────────────────────────────────────

let current: PlatformUpdateRun | null = null;
let checking = false;
let timer: NodeJS.Timeout | null = null;
let tickBusy = false;

function updatingRefs(): Set<string> {
  return new Set(current && current.status === 'running' ? current.images : []);
}

function images(obs: Observation, s: StoredState): PlatformImageStatus[] {
  return buildImageList({
    containers: obs.containers, extraRefs: obs.extraRefs, tag: config.hosting.imageTag, panelName: obs.panelName,
    locals: obs.locals, remembered: remembered(s), updating: updatingRefs(),
  });
}

function summaryOf(nodeId: number, list: PlatformImageStatus[], s: StoredState, run: PlatformUpdateRun | null): PlatformUpdatesSummary {
  return {
    nodeId,
    available: list.filter((i) => i.status === 'updateAvailable' || i.status === 'pendingRecreate').length,
    failed: list.filter((i) => i.status === 'failed').length,
    updating: run?.status === 'running',
    checkedAt: s.checkedAt,
  };
}

function emitState(nodeId: number): void {
  deps.emit({ nodeId, kind: 'state', runId: current?.id ?? null });
}

async function resolveNode(nodeId?: number | null): Promise<number> {
  const local = await deps.localNodeId();
  if (nodeId === undefined || nodeId === null || nodeId === local) return local;
  throw new AppError(404, 'Platform updates are only managed on the local node', 'notFound');
}

// ── checks ──────────────────────────────────────────────────────────────────

async function checkImages(nodeId: number, only: string[] | null, opts: { notify: boolean }): Promise<void> {
  const obs = await observe(nodeId);
  const s = await loadState(nodeId);
  const policy = await loadPolicy();
  const list = images(obs, s).filter((i) => !only || only.includes(i.image));
  const nowIso = deps.now().toISOString();
  for (const img of list) {
    const ref = parseImageRef(img.image);
    const prev: StoredImage = s.images[img.image] ?? { remoteDigest: null, checkedAt: null, error: null };
    const next: StoredImage = { ...prev, checkedAt: nowIso };
    if (!ref || !ref.tag) {
      next.error = 'référence d’image sans tag';
    } else {
      try {
        next.remoteDigest = await remoteDigest({ ref, auth: null, fetch: deps.fetch });
        next.error = null;
      } catch (err) {
        next.error = err instanceof RegistryCheckError ? (err.auth ? 'accès refusé par le registre' : err.message) : `registre injoignable (${errText(err).slice(0, 120)})`;
      }
    }
    // A newer digest than the one a failed run targeted: retry allowed.
    if (next.failed && next.remoteDigest && next.failedDigest && next.remoteDigest !== next.failedDigest) next.failed = false;
    s.images[img.image] = next;
    const localDigest = img.localDigest;
    next.available = !!next.remoteDigest && (!localDigest || next.remoteDigest !== localDigest || img.outdatedContainers.length > 0);
    if (opts.notify && policy.notify && next.remoteDigest && localDigest && next.remoteDigest !== localDigest && next.notifiedDigest !== next.remoteDigest) {
      next.notifiedDigest = next.remoteDigest;
      deps.notify('platform.updateAvailable', `Mise à jour disponible : ${img.image}`,
        `Une nouvelle image est disponible pour ${img.image} (${img.kind}). Nodes > Mises à jour.`, 'info',
        `platform.updateAvailable:${nodeId}:${img.image}:${next.remoteDigest}`);
    }
  }
  if (!only) s.checkedAt = nowIso;
  else s.checkedAt = s.checkedAt ?? nowIso;
  await saveState(nodeId, s);
}

// ── run execution ───────────────────────────────────────────────────────────

const PREV_SUFFIX = '-oblimint-prev';

/**
 * Replaces `targets` through `apply` (an ensure / a reconcile): each one is
 * renamed <name>-oblimint-prev and stopped first, so `apply` creates its
 * successor from the spec; kept until the successor exists (and runs when the
 * old one ran), removed then — restored (renamed back, restarted) otherwise.
 */
async function swapContainers(docker: Docker, targets: Array<{ name: string; running: boolean }>, apply: () => Promise<void>, log: (l: string) => void): Promise<void> {
  const kept: Array<{ name: string; running: boolean; id: string }> = [];
  try {
    for (const t of targets) {
      const info = await inspectContainer(docker, t.name);
      if (!info) continue;
      const prev = `${t.name}${PREV_SUFFIX}`;
      const stale = await inspectContainer(docker, prev);
      if (stale) await docker.getContainer(stale.Id).remove({ force: true });
      await docker.getContainer(info.Id).rename({ name: prev });
      kept.push({ name: t.name, running: !!info.State?.Running, id: info.Id });
      await stopContainer(docker, info.Id, 20);
    }
    await apply();
    const missing: string[] = [];
    for (const k of kept) {
      const info = await inspectContainer(docker, k.name);
      if (!info || (k.running && !info.State?.Running)) missing.push(k.name);
    }
    if (missing.length) throw new Error(`not recreated / not running: ${missing.join(', ')}`);
  } catch (err) {
    log(`Échec, restauration des conteneurs précédents : ${errText(err)}`);
    for (const k of kept) {
      try {
        const fresh = await inspectContainer(docker, k.name);
        if (fresh && fresh.Id !== k.id) await docker.getContainer(fresh.Id).remove({ force: true });
        await docker.getContainer(k.id).rename({ name: k.name });
        if (k.running) await startContainer(docker, k.id);
      } catch (e) {
        log(`${k.name} : restauration impossible (${errText(e)})`);
      }
    }
    throw err;
  }
  for (const k of kept) {
    try { await docker.getContainer(k.id).remove({ force: true }); } catch (e) {
      // Already gone: the account reconcile removed the stray container itself. Nothing to clean.
      if (!isNotFound(e)) log(`${k.name}${PREV_SUFFIX} : suppression impossible (${errText(e)})`);
    }
  }
}

async function persistRun(nodeId: number, run: PlatformUpdateRun): Promise<void> {
  const s = await loadState(nodeId);
  if (run.status === 'running') s.run = run;
  else {
    s.run = null;
    s.lastRun = run;
  }
  await saveState(nodeId, s);
}

async function markImages(nodeId: number, refs: string[], failed: boolean): Promise<void> {
  const s = await loadState(nodeId);
  for (const ref of refs) {
    const e: StoredImage = s.images[ref] ?? { remoteDigest: null, checkedAt: null, error: null };
    e.failed = failed;
    e.failedDigest = failed ? e.remoteDigest ?? null : null;
    if (!failed) e.available = false;
    s.images[ref] = e;
  }
  await saveState(nodeId, s);
}

async function finishRun(nodeId: number, run: PlatformUpdateRun, status: PlatformUpdateRun['status'], error: string | null, refs: string[]): Promise<void> {
  run.status = status;
  run.error = error;
  run.step = null;
  run.finishedAt = deps.now().toISOString();
  await persistRun(nodeId, run);
  await markImages(nodeId, refs, status !== 'succeeded');
  if (current?.id === run.id) current = null;
  const policy = await loadPolicy();
  if (policy.notify) {
    if (status === 'succeeded') deps.notify('platform.updated', 'Plateforme mise à jour', `Mise à jour appliquée : ${refs.join(', ') || '—'}.`, 'info', `platform.updated:${run.id}`);
    else deps.notify('platform.updateFailed', 'Échec de la mise à jour de la plateforme', `${error ?? 'échec'}\nImages : ${refs.join(', ') || '—'}.`, 'warning', `platform.updateFailed:${run.id}`);
  }
  await auditService.log({
    tenantId: MASTER_TENANT_ID, userId: run.userId ?? undefined, action: status === 'succeeded' ? 'platform.update.succeeded' : 'platform.update.failed',
    resourceType: 'node', resourcePath: String(nodeId), details: { runId: run.id, trigger: run.trigger, images: refs, status, error },
  });
  emitState(nodeId);
}

async function executeRun(nodeId: number, run: PlatformUpdateRun, steps: UpdateStep[]): Promise<void> {
  const log = (line: string) => {
    run.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    if (run.log.length > LOG_MAX) run.log.splice(0, run.log.length - LOG_MAX);
    deps.emit({ nodeId, kind: 'log', line, runId: run.id });
  };
  const docker = await deps.docker(nodeId);
  const refs = run.images;
  try {
    for (const step of steps) {
      if (step.type === 'pull') {
        run.step = `Téléchargement de ${step.image}`;
        emitState(nodeId);
        log(`Pull ${step.image}`);
        await pullImage(docker, step.image, (l) => log(l));
      } else if (step.type === 'recreate') {
        run.step = `Recréation : ${step.kind}`;
        emitState(nodeId);
        const obs = await observe(nodeId);
        const targets = obs.containers.filter((c) => step.images.includes(c.image) && obs.locals.get(c.image) && c.imageId !== obs.locals.get(c.image)!.id);
        if (!targets.length) { log(`${step.kind} : déjà sur l’image locale`); continue; }
        log(`${step.kind} : recréation de ${targets.map((t) => t.name).join(', ')}`);
        const running = new Map((await docker.listContainers({ all: true })).map((c) => [(c.Names?.[0] ?? '').replace(/^\//, ''), c.State === 'running']));
        await swapContainers(docker, targets.map((t) => ({ name: t.name, running: running.get(t.name) ?? false })), () => deps.ensureInfra(step.kind, log), log);
        log(`${step.kind} : à jour`);
      } else if (step.type === 'accounts') {
        run.step = step.sites ? 'Redéploiement des sites' : 'Serveurs de fichiers';
        emitState(nodeId);
        const list = await docker.listContainers({ all: true });
        const byAccount = new Map<number, Array<{ name: string; running: boolean }>>();
        const localIds = new Map<string, string | null>();
        for (const ref of step.images) localIds.set(ref, (await localImage(docker, ref))?.id ?? null);
        for (const c of list) {
          // Tag moved to the pulled image: docker ps shows the old image id, the reference is in Config.Image.
          let ref = c.Image;
          if (needsConfigImage(ref) && c.Labels?.[LABELS.role]) {
            ref = (await inspectContainer(docker, (c.Names?.[0] ?? '').replace(/^\//, '')).catch(() => null))?.Config?.Image ?? ref;
          }
          const id = localIds.get(ref);
          const account = Number(c.Labels?.[LABELS.account]);
          if (!id || c.ImageID === id || !Number.isInteger(account) || account <= 0) continue;
          const role = c.Labels?.[LABELS.role];
          if (role !== 'filesrv' && !(step.sites && (role === 'site' || role === 'site-secondary' || role === 'site-preview'))) continue;
          const arr = byAccount.get(account) ?? [];
          arr.push({ name: (c.Names?.[0] ?? '').replace(/^\//, ''), running: c.State === 'running' });
          byAccount.set(account, arr);
        }
        if (!byAccount.size) log('Aucun conteneur de compte à recréer');
        for (const [accountId, targets] of byAccount) {
          log(`Compte ${accountId} : ${targets.map((t) => t.name).join(', ')}`);
          await swapContainers(docker, targets, async () => {
            const r = await deps.reconcileAccount(accountId);
            if (!r.ok) throw new Error(r.errors.slice(0, 3).join(' ; ') || 'reconcile failed');
          }, log);
        }
      } else if (step.type === 'panel') {
        run.step = 'Mise à jour du panel';
        emitState(nodeId);
        await persistRun(nodeId, run);
        await launchSelfUpdate(docker, run, step.image, log);
        // This process is replaced by the helper: the run is finalized by the panel that runs afterwards.
        return;
      }
    }
    log('Mise à jour terminée');
    await finishRun(nodeId, run, 'succeeded', null, refs);
  } catch (err) {
    log(`Échec : ${errText(err)}`);
    await finishRun(nodeId, run, 'failed', errText(err), refs);
  }
}

/** Starts the helper that recreates the panel container on `image` (pulled already). */
async function launchSelfUpdate(docker: Docker, run: PlatformUpdateRun, image: string, log: (l: string) => void, healthTimeoutSec = SELF_HEALTH_TIMEOUT_SEC): Promise<void> {
  const ref = selfContainerRef();
  const self = ref ? await inspectContainer(docker, ref) : null;
  if (!self) throw new Error('the panel does not run in a container of this node: update it by hand (install.sh --upgrade)');
  const socket = dockerSocketBind(self);
  if (!socket) throw new Error('the Docker socket of the panel container is not a bind mount');
  const target = await docker.getImage(image).inspect().catch(() => null);
  if (!target) throw new Error(`${image} is not present locally`);
  if (target.Id === self.Image) {
    log('Le panel tourne déjà sur cette image');
    return finishSelfNoop(run);
  }
  const plan = { runId: run.id, target: self.Name.replace(/^\//, ''), newImage: image, healthTimeoutSec };
  const spec = helperCreateOptions(self, plan, socket);
  const helper = await docker.createContainer(spec);
  await helper.start();
  log(`Assistant de mise à jour démarré (${spec.name}) : le panel va redémarrer sur ${image}`);
}

async function finishSelfNoop(run: PlatformUpdateRun): Promise<void> {
  await finishRun(run.nodeId, run, 'succeeded', null, run.images);
}

/**
 * Results of the self-update helpers (boot + every tick): an exited helper's
 * result closes the run it carries (notification, audit), the helper is
 * removed; with no helper running, the stopped <panel>-old-<ts> containers
 * left by an interrupted update are removed. Never throws.
 */
export async function finalizeSelfUpdates(): Promise<void> {
  try {
    const nodeId = await deps.localNodeId();
    const docker = await deps.docker(nodeId);
    const helpers = await docker.listContainers({ all: true, filters: { label: [`${LABELS.role}=${UPDATER_ROLE}`] } });
    let helperRunning = false;
    for (const h of helpers) {
      if (h.State === 'running' || h.State === 'created' || h.State === 'restarting') { helperRunning = h.State !== 'created'; continue; }
      const runId = h.Labels?.[UPDATER_RUN_LABEL] ?? '';
      let logs = '';
      try { logs = demuxDockerLogs(await docker.getContainer(h.Id).logs({ stdout: true, stderr: true, tail: 400 }) as unknown as Buffer); } catch { /* none */ }
      const result = parseHelperResult(logs);
      const s = await loadState(nodeId);
      const run = s.run && s.run.id === runId ? s.run : null;
      if (run) {
        for (const l of logs.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(-40)) run.log.push(l);
        if (result?.outcome === 'succeeded') await finishRun(nodeId, run, 'succeeded', null, run.images);
        else await finishRun(nodeId, run, result?.outcome === 'rolledBack' ? 'rolledBack' : 'failed', result?.error ?? `l’assistant de mise à jour s’est arrêté (exit ${h.Status})`, run.images);
      }
      try { await docker.getContainer(h.Id).remove({ force: true }); } catch { /* gone */ }
    }
    if (helperRunning) return;
    const ref = selfContainerRef();
    const self = ref ? await inspectContainer(docker, ref) : null;
    if (!self) return;
    const re = OLD_PANEL_RE(self.Name.replace(/^\//, ''));
    for (const c of await docker.listContainers({ all: true })) {
      const name = (c.Names?.[0] ?? '').replace(/^\//, '');
      if (!re.test(name) || c.State === 'running' || c.Id === self.Id) continue;
      try {
        await docker.getContainer(c.Id).remove({ force: true });
        logger.info({ name }, 'platform updates: previous panel container removed');
      } catch (err) {
        logger.warn({ name, err: errText(err) }, 'platform updates: previous panel container not removed');
      }
    }
  } catch (err) {
    logger.debug({ err: errText(err) }, 'platform updates: self-update finalization skipped');
  }
}

/**
 * Boot of the panel (whatever OBLIMINT_WORKERS says): the panel started by a
 * self-update (or restored by its rollback) closes the run as soon as the
 * helper exits — every 15 s for up to 15 minutes. Never throws.
 */
export function scheduleSelfUpdateFinalization(): void {
  const until = Date.now() + 15 * 60_000;
  const pass = async () => {
    await finalizeSelfUpdates();
    if (Date.now() > until) return;
    try {
      const docker = await deps.docker(await deps.localNodeId());
      const left = await docker.listContainers({ all: true, filters: { label: [`${LABELS.role}=${UPDATER_ROLE}`] } });
      if (!left.length) return;
    } catch {
      return;
    }
    setTimeout(() => { void pass(); }, 15_000).unref?.();
  };
  setTimeout(() => { void pass(); }, 3_000).unref?.();
}

// ── public API ──────────────────────────────────────────────────────────────

export const platformUpdatesService = {
  async state(nodeId?: number | null): Promise<PlatformUpdatesState> {
    const node = await resolveNode(nodeId);
    const [obs, s, policy] = await Promise.all([observe(node), loadState(node), loadPolicy()]);
    const list = images(obs, s);
    const run = current ?? s.run;
    const now = deps.now();
    return {
      nodeId: node,
      tag: config.hosting.imageTag,
      images: list,
      checkedAt: s.checkedAt,
      checking,
      run,
      lastRun: s.lastRun,
      policy,
      windowOpen: !!policy.window && windowIsOpen(policy.window, now),
      nextWindowAt: policy.window ? nextWindowOpening(policy.window, now)?.toISOString() ?? null : null,
      summary: summaryOf(node, list, s, run),
    };
  },

  /** Cheap summary (no Docker call): from the remembered state. */
  async summary(nodeId?: number | null): Promise<PlatformUpdatesSummary> {
    const node = await resolveNode(nodeId);
    const s = await loadState(node);
    const vals = Object.values(s.images);
    return {
      nodeId: node,
      available: vals.filter((v) => !v.failed && !!v.available).length,
      failed: vals.filter((v) => v.failed).length,
      updating: (current ?? s.run)?.status === 'running',
      checkedAt: s.checkedAt,
    };
  },

  async check(nodeId?: number | null, only?: string[] | null): Promise<void> {
    const node = await resolveNode(nodeId);
    if (checking) throw new AppError(409, 'A check is already running', 'conflict');
    checking = true;
    emitState(node);
    try {
      await checkImages(node, only && only.length ? only : null, { notify: true });
    } finally {
      checking = false;
      emitState(node);
    }
  },

  async start(req: PlatformUpdateRequest & { nodeId?: number | null }, trigger: PlatformUpdateTrigger, userId: number | null): Promise<PlatformUpdateRun> {
    const node = await resolveNode(req.nodeId);
    const s = await loadState(node);
    if (current || s.run?.status === 'running') throw new AppError(409, 'An update is already running', 'conflict');
    const obs = await observe(node);
    const list = images(obs, s);
    const known = new Set(list.map((i) => i.image));
    const wanted = (req.images ?? []).filter((r) => typeof r === 'string');
    const unknown = wanted.filter((r) => !known.has(r));
    if (unknown.length) throw new AppError(400, `Unknown image(s): ${unknown.join(', ')}`, 'validation');
    const steps = planRun(list, { images: wanted, redeploySites: !!req.redeploySites });
    if (!steps.length) throw new AppError(409, 'Nothing to update', 'nothingToUpdate');
    const refs = [...new Set(steps.flatMap((st) => (st.type === 'pull' || st.type === 'panel' ? [st.image] : st.images)))];
    const run: PlatformUpdateRun = {
      id: `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
      nodeId: node, trigger, images: refs, redeploySites: !!req.redeploySites, status: 'running', step: null, log: [], error: null,
      startedAt: deps.now().toISOString(), finishedAt: null, userId,
    };
    current = run;
    await persistRun(node, run);
    emitState(node);
    void executeRun(node, run, steps).catch((err) => logger.error({ err: errText(err) }, 'platform updates: run crashed'));
    return run;
  },

  async setPolicy(input: unknown): Promise<PlatformUpdatePolicy> {
    const policy = normalizePolicy({ ...(await loadPolicy()), ...(input && typeof input === 'object' ? input : {}) });
    await appConfigService.set(POLICY_KEY, JSON.stringify(policy));
    emitState(await deps.localNodeId());
    return policy;
  },

  /** Periodic work: helper results, checks, automatic updates inside the window. Never throws. */
  async tick(): Promise<void> {
    if (tickBusy) return;
    tickBusy = true;
    try {
      await finalizeSelfUpdates();
      const node = await deps.localNodeId();
      const policy = await loadPolicy();
      const s = await loadState(node);
      const now = deps.now();
      if (!checking && checkDue(policy, s.checkedAt, now)) {
        checking = true;
        try { await checkImages(node, null, { notify: true }); } finally { checking = false; }
        emitState(node);
      }
      if (current || s.run?.status === 'running' || !autoUpdateAllowed(policy, now)) return;
      const fresh = await loadState(node);
      const list = images(await observe(node), fresh);
      const refs = autoRunImages(list);
      if (refs.length) await this.start({ images: refs, redeploySites: false }, 'auto', null);
    } catch (err) {
      logger.warn({ err: errText(err) }, 'platform updates: periodic pass failed');
    } finally {
      tickBusy = false;
    }
  },

  start_worker(): void {
    if (timer) return;
    // A run 'running' in the stored state without this process running it: the panel restarted mid-run
    // (not through the helper) — closed as failed by the first tick unless a helper result closes it.
    void (async () => {
      await finalizeSelfUpdates();
      try {
        const node = await deps.localNodeId();
        const s = await loadState(node);
        if (s.run?.status === 'running' && !current) {
          const docker = await deps.docker(node);
          const helpers = await docker.listContainers({ all: true, filters: { label: [`${LABELS.role}=${UPDATER_ROLE}`] } });
          if (!helpers.length) await finishRun(node, s.run, 'failed', 'le panel a redémarré pendant la mise à jour', s.run.images);
        }
      } catch (err) {
        logger.debug({ err: errText(err) }, 'platform updates: interrupted run check skipped');
      }
    })();
    timer = setInterval(() => { void this.tick(); }, TICK_MS);
    timer.unref?.();
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },
};

/** Worker contract of workers/index.ts. */
export const platformUpdatesWorker = {
  start: () => platformUpdatesService.start_worker(),
  stop: () => platformUpdatesService.stop(),
};

/** Tests / the Linux test host check: launches the helper directly (no pull, no plan). */
export async function launchSelfUpdateForTests(image: string, healthTimeoutSec = 90): Promise<string> {
  const node = await deps.localNodeId();
  const docker = await deps.docker(node);
  const run: PlatformUpdateRun = {
    id: `t${Date.now().toString(36)}`, nodeId: node, trigger: 'manual', images: [image], redeploySites: false, status: 'running',
    step: 'Mise à jour du panel', log: [], error: null, startedAt: new Date().toISOString(), finishedAt: null, userId: null,
  };
  await persistRun(node, run);
  await launchSelfUpdate(docker, run, image, (l) => logger.info(l), healthTimeoutSec);
  return run.id;
}
