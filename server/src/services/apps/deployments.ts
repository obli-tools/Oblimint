import crypto from 'crypto';
import type Docker from 'dockerode';
import type { AppDeploymentAction, AppDeploymentStatus, AppDeploymentTrigger, AppStackStatus, ComposeValidationResult, EffectiveStackConfig } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { errText } from '../setup/docker';
import { canonicalJson } from '../docker/specs';
import { pauseContainer, CancelledError, unpauseContainer } from './appDocker';
import { removeContainer, removeNetwork, restartContainer, startContainer, stopContainer } from '../docker/dockerOps';
import { appContainer, appServiceAlias, P4B_LABELS } from '../hosting/naming';
import { hostPaths, localPaths } from '../hosting/paths';
import { json } from '../hosting/rows';
import { platformSettings } from '../platformSettings';
import { appsDeps } from './deps';
import { DeployLog } from './deployLog';
import { checkServiceHealth, converge, unstableServices, withUnstable, DeployFailure, stackContainersOf, unsafeBindSources, type ConvergeResult, type ImageStore, type StackRef } from './engine';
import { accountPlan, buildLimitsOf, composeContext, envMap, openEnv, otherStacksUsage, sourceDirs } from './context';
import { stackInspector } from './fsSafe';
import { createSourceSnapshot, pruneSnapshots, removeSnapshot, snapshotExists, snapshotRel, SourceTreeError } from './snapshots';
import { secretValues, validateCompose, type ResolvedStack } from './compose/validate';
import { emitAppUpdated, emitDeployOutput, ERROR_LINE_PREFIX } from './events';
import { stackRegistryAuths } from './registry.service';
import { isSourceBusy } from './sources';
import { effectiveOf, sleepPolicyOf, type DeploymentRow, type EffectiveSnapshot, type ServiceRow, type StackRow } from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// Deployments of a stack (docs/P4b-PLAN.md §5.1, §5.5, §5.7): one action at a
// time per stack (409 stackBusy), each recorded in app_deployments (action,
// trigger, user, compose + effective snapshot, digests, capped redacted log),
// live output on Socket.io, cancellation between steps, notifications
// (app.deployFailed / app.updated / app.updateFailed). Never holds the
// account lock: app containers are EXTERNALLY_MANAGED_ROLES for the P1
// planner, the account reconcile only queues actions here.
// ─────────────────────────────────────────────────────────────────────────────

export const HEALTH_TIMEOUT_MS = 120_000;
export const UPDATE_STABLE_MS = 10_000;
/** (Re)deploy: window during which the long-running services must stay up (no restart) — crash loops. */
export const DEPLOY_STABLE_MS = 10_000;
const FLUSH_MS = 1_000;
const PERSIST_MS = 5_000;

interface Job {
  deploymentId: number;
  stackId: number;
  action: AppDeploymentAction;
  ctrl: AbortController;
  log: DeployLog;
  done: Promise<void>;
}

const jobs = new Map<number, Job>();
const reserved = new Set<number>();
const byDeployment = new Map<number, Job>();
/** Wake durations (s) per stack, for the waking page ETA. */
const wakeDurations = new Map<number, number[]>();
/** Tests: health stabilization delay override. */
let stableMsOverride: number | null = null;

export interface ActionOptions {
  userId: number | null;
  /** restart / update subset. */
  services?: string[] | null;
  /** Rebuild the `build:` services. */
  build?: boolean;
  /** rollback: the deployment to return to. */
  rollbackOf?: DeploymentRow | null;
  /** update action with trigger 'rollback': service returned to its previous digest. */
  imageRollback?: string | null;
  commitSha?: string | null;
  /** stop / sleep issued by the system (account suspended): desired_state unchanged. */
  keepDesired?: boolean;
  /** Message stored on the stack after a system stop (e.g. suspension). */
  statusMessage?: string | null;
}

export function isStackBusy(stackId: number): boolean {
  return jobs.has(stackId) || reserved.has(stackId);
}

export function runningDeploymentLog(deploymentId: number): string[] | null {
  return byDeployment.get(deploymentId)?.log.snapshot() ?? null;
}

/** Tests / shutdown: resolves when the stack has no running action. */
export async function whenStackIdle(stackId: number): Promise<void> {
  await jobs.get(stackId)?.done.catch(() => undefined);
}

export async function whenAllIdle(): Promise<void> {
  await Promise.all([...jobs.values()].map((j) => j.done.catch(() => undefined)));
}

export function setUpdateStableMsForTests(ms: number | null): void {
  stableMsOverride = ms;
}

export function wakeEtaSec(stackId: number): number | null {
  const d = wakeDurations.get(stackId);
  if (!d?.length) return null;
  return Math.max(1, Math.round(d.reduce((a, b) => a + b, 0) / d.length));
}

export async function loadStackRow(stackId: number): Promise<StackRow | null> {
  return await db('app_stacks').where({ id: stackId }).first() as StackRow | undefined ?? null;
}

/** Last successful deployment that carries a compose snapshot (the deployed state). */
export async function lastDeployed(stackId: number): Promise<DeploymentRow | null> {
  return await db('app_deployments').where({ stack_id: stackId, status: 'succeeded' })
    .whereIn('action', ['deploy', 'redeploy', 'recreate', 'rollback', 'update', 'start'])
    .whereNotNull('compose_snapshot').orderBy('id', 'desc').first() as DeploymentRow | undefined ?? null;
}

export function effectiveHash(eff: EffectiveStackConfig): string {
  return crypto.createHash('sha256').update(canonicalJson(eff)).digest('hex');
}

/** Status of a stack from its containers (one-shot services that exited 0 count as fine). */
export function statusFromContainers(
  effective: EffectiveStackConfig | null, containers: Map<string, Docker.ContainerInfo>, desired: 'running' | 'stopped',
): { status: AppStackStatus; message: string | null; running: number } {
  const services = effective?.services ?? [];
  let running = 0;
  let up = 0;
  for (const s of services) {
    const c = containers.get(s.name);
    if (!c) continue;
    if (c.State === 'running') { running++; up++; continue; }
    const exit = /Exited \((\d+)\)/.exec(c.Status ?? '');
    if (c.State === 'exited' && s.restart === 'no' && exit && exit[1] === '0') up++;
  }
  if (services.length === 0) return { status: containers.size ? 'partial' : 'draft', message: null, running };
  if (desired === 'stopped') return { status: running === 0 ? 'stopped' : 'partial', message: null, running };
  if (up === services.length) return { status: 'running', message: null, running };
  if (up > 0) return { status: 'partial', message: `${services.length - up} service(s) arrêté(s) sur ${services.length}`, running };
  return { status: 'error', message: 'Aucun conteneur de l\'application ne fonctionne', running };
}

function imageStoreOf(accountId: number): ImageStore {
  return {
    async pulledByAccount(image) {
      return !!(await db('app_image_pulls').where({ account_id: accountId, image }).first('account_id'));
    },
    async recordPull(image, digest, authenticated) {
      await db('app_image_pulls').insert({ account_id: accountId, image, digest, authenticated, pulled_at: db.fn.now() })
        .onConflict(['account_id', 'image']).merge(['digest', 'authenticated', 'pulled_at']);
    },
  };
}

async function setStack(stackId: number, patch: Record<string, unknown>): Promise<void> {
  await db('app_stacks').where({ id: stackId }).update({ ...patch, updated_at: db.fn.now() });
}

/**
 * Validates `composeYaml` with the stack's current .env, paths checked on disk (deploy time) — in the
 * deployment's source snapshot when given (`sourceLocalDir`: the tree its binds / builds will use).
 */
export async function prepare(stack: StackRow, composeYaml: string, sourceLocalDir?: string): Promise<{ resolved: ResolvedStack; result: ComposeValidationResult; secrets: string[]; plan: Awaited<ReturnType<typeof composeContext>>['plan'] }> {
  const envText = openEnv(stack.env_sealed);
  const env = envMap(envText);
  const { ctx, plan } = await composeContext({
    stackId: stack.id, accountId: stack.account_id, sourceType: stack.source_type, gitComposePath: stack.git_compose_path, env, inspect: true,
    ...(sourceLocalDir ? { inspector: stackInspector(sourceLocalDir) } : {}),
  });
  const out = validateCompose(composeYaml, ctx);
  if (!out.resolved) {
    const first = out.result.issues.find((i) => i.severity === 'error');
    throw new DeployFailure('Le compose n\'est pas valide', first ? `${first.path || '<racine>'}${first.line ? ` (ligne ${first.line})` : ''}: ${first.message}` : null);
  }
  return { resolved: out.resolved, result: out.result, secrets: secretValues(env), plan };
}

/** Does the stack mount source files or build images (then it runs from a source snapshot)? */
export function usesSource(resolved: ResolvedStack): boolean {
  return resolved.services.some((s) => !!s.buildSpec || s.volumes.some((v) => v.kind === 'bind'));
}

/**
 * Source snapshot recorded by a deployment: its id, null (the deployment mounted no source file), undefined
 * (a deployment made before the snapshots existed).
 */
export function sourceSnapshotOf(dep: Pick<DeploymentRow, 'effective_snapshot'> | null): number | null | undefined {
  const snap = json<EffectiveSnapshot | null>(dep?.effective_snapshot ?? null, null);
  if (!snap || !Object.prototype.hasOwnProperty.call(snap, 'sourceSnapshot')) return undefined;
  const id = snap.sourceSnapshot;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
}

/** StackRef of a stack, its binds / build contexts resolving in snapshot `snapshotId` (null = the stack dir). */
export function stackRefWith(stack: Pick<StackRow, 'id' | 'account_id' | 'tenant_id'>, snapshotId: number | null): StackRef {
  const localDir = localPaths.appStack(stack.account_id, stack.id);
  const hostDir = hostPaths.appStack(stack.account_id, stack.id);
  const ref: StackRef = { id: stack.id, accountId: stack.account_id, tenantId: stack.tenant_id, localDir, hostDir };
  if (snapshotId !== null) {
    const rel = snapshotRel(snapshotId);
    ref.sourceLocalDir = `${localDir.replace(/[\\/]+$/, '')}/${rel}`;
    ref.sourceHostDir = `${hostDir.replace(/\\/g, '/').replace(/\/+$/, '')}/${rel}`;
  }
  return ref;
}

interface SourceChoice {
  /** Snapshot the deployment runs from (null: none). */
  id: number | null;
  /** Created by this action (removed when the stack turns out to use no source). */
  created: boolean;
  /** The wanted deployment's own files were not kept (a strict rollback then fails if the stack uses them). */
  missing: boolean;
}

/**
 * Source tree of an action: a NEW snapshot of the current source (deploy / redeploy / recreate), or the
 * snapshot of a previous deployment (rollback, start, update, restart). A previous deployment without a
 * kept snapshot (made before the snapshots, or pruned) falls back to a new snapshot of the current source,
 * logged; `strict` (rollback) marks it missing instead.
 */
async function chooseSource(stack: StackRow, deploymentId: number, log: DeployLog, from: DeploymentRow | null | 'fresh', strict = false): Promise<SourceChoice> {
  const localDir = localPaths.appStack(stack.account_id, stack.id);
  let missing = false;
  if (from !== 'fresh') {
    const id = sourceSnapshotOf(from);
    if (id === null) return { id: null, created: false, missing: false };
    if (id !== undefined && snapshotExists(localDir, id)) return { id, created: false, missing: false };
    missing = true;
    if (!strict) log.add(`Fichiers sources du déploiement #${from?.id ?? '?'} non conservés : copie des fichiers actuels`);
  }
  try {
    createSourceSnapshot(localDir, sourceDirs(stack.source_type, stack.git_compose_path).rootDir, deploymentId);
  } catch (err) {
    if (err instanceof SourceTreeError) throw new DeployFailure('Un lien symbolique ou un fichier spécial est présent dans les fichiers sources', err.rel || null);
    throw new DeployFailure('Copie des fichiers sources impossible', errText(err));
  }
  return { id: deploymentId, created: true, missing: strict && missing };
}

/** Drops a snapshot created for nothing (the stack mounts no source and builds nothing). */
function settleSource(stack: StackRow, choice: SourceChoice, resolved: ResolvedStack): number | null {
  if (choice.id !== null && choice.created && !usesSource(resolved)) {
    try { removeSnapshot(localPaths.appStack(stack.account_id, stack.id), choice.id); } catch { /* pruned later */ }
    return null;
  }
  return choice.id;
}

/**
 * Upper bound of what can run while (and after, on failure) converging from `prev` to `next`: one container
 * per service of either config, each with the larger of its two limits (a failed converge leaves a mix of
 * old-spec and new-spec containers, and leftovers of services `next` no longer declares).
 */
export function reservationTotals(prev: EffectiveStackConfig | null, next: EffectiveStackConfig): EffectiveStackConfig['totals'] {
  const by = new Map<string, { cpus: number; memoryMb: number }>();
  for (const s of prev?.services ?? []) by.set(s.name, { cpus: s.limits.cpus, memoryMb: s.limits.memoryMb });
  for (const s of next.services) {
    const o = by.get(s.name);
    by.set(s.name, { cpus: Math.max(o?.cpus ?? 0, s.limits.cpus), memoryMb: Math.max(o?.memoryMb ?? 0, s.limits.memoryMb) });
  }
  let cpus = 0;
  let memoryMb = 0;
  for (const v of by.values()) { cpus += v.cpus; memoryMb += v.memoryMb; }
  return {
    cpus: Math.max(Math.round(cpus * 100) / 100, prev?.totals.cpus ?? 0, next.totals.cpus),
    memoryMb: Math.max(memoryMb, prev?.totals.memoryMb ?? 0, next.totals.memoryMb),
    containers: Math.max(by.size, prev?.totals.containers ?? 0, next.totals.containers),
  };
}

/**
 * AP2 (sum per account ≤ plan, security audit P4b): before any container is created, re-checks the account
 * sums under the account row lock and persists the reservation in app_stacks.effective (its totals are what
 * otherStacksUsage() sums). Two concurrent deploys of the same account are serialized here: the second one
 * sees the first one's reservation. The reservation keeps the previous services (reconcile reference) with
 * the merged upper-bound totals; a successful deploy replaces it with the exact effective config, a failed
 * or cancelled one leaves it, so containers left running by the failure stay counted.
 */
export async function reserveResources(stack: Pick<StackRow, 'id' | 'account_id'>, next: EffectiveStackConfig): Promise<void> {
  await db.transaction(async (trx) => {
    await trx.raw('SELECT id FROM hosting_accounts WHERE id = ? FOR UPDATE', [stack.account_id]);
    const plan = await accountPlan(stack.account_id, trx);
    const row = await trx('app_stacks').where({ id: stack.id }).first('effective') as { effective: unknown } | undefined;
    if (!row) throw new DeployFailure('Application introuvable');
    const prev = json<EffectiveStackConfig | null>(row.effective, null);
    const prevEff = prev && Array.isArray(prev.services) ? prev : null;
    const others = await otherStacksUsage(stack.account_id, stack.id, trx);
    const l = plan.limits;
    const over: string[] = [];
    if (l.appsCpuCores != null && others.cpus + next.totals.cpus > l.appsCpuCores + 1e-9) over.push(`CPU ${Math.round((others.cpus + next.totals.cpus) * 100) / 100} / ${l.appsCpuCores}`);
    if (l.appsMemoryMb != null && others.memoryMb + next.totals.memoryMb > l.appsMemoryMb) over.push(`mémoire ${others.memoryMb + next.totals.memoryMb} / ${l.appsMemoryMb} Mio`);
    if (l.maxAppContainers != null && others.containers + next.totals.containers > l.maxAppContainers) over.push(`conteneurs ${others.containers + next.totals.containers} / ${l.maxAppContainers}`);
    if (over.length) throw new DeployFailure('Limites du plan dépassées pour les applications du compte', over.join(', '));
    const reserved: EffectiveStackConfig = { ...(prevEff ?? next), totals: reservationTotals(prevEff, next) };
    await trx('app_stacks').where({ id: stack.id }).update({ effective: JSON.stringify(reserved) });
  });
}

async function serviceRows(stackId: number): Promise<ServiceRow[]> {
  return await db('app_services').where({ stack_id: stackId }) as ServiceRow[];
}

/** Persists the services after a converge (digest history: previous ← old current when it changed). */
async function recordServices(stack: StackRow, resolved: ResolvedStack, res: ConvergeResult, only: ReadonlySet<string> | null): Promise<void> {
  const existing = new Map((await serviceRows(stack.id)).map((r) => [r.name, r]));
  for (const svc of resolved.services) {
    if (only && !only.has(svc.name)) continue;
    const current = res.images[svc.name];
    if (!current) continue;
    const old = existing.get(svc.name);
    const image = svc.buildSpec ? current : svc.imageRef;
    if (old) {
      const changed = old.current_digest !== current;
      await db('app_services').where({ id: old.id }).update({
        image,
        current_digest: current,
        ...(changed && old.current_digest && old.image === image ? { previous_digest: old.current_digest } : {}),
        ...(old.image !== image ? { previous_digest: null, latest_digest: null, notified_digest: null } : {}),
        updated_at: db.fn.now(),
      });
    } else {
      await db('app_services').insert({ stack_id: stack.id, account_id: stack.account_id, name: svc.name, image, current_digest: current });
    }
  }
  if (!only) {
    const keep = resolved.services.map((s) => s.name);
    await db('app_services').where({ stack_id: stack.id }).whereNotIn('name', keep.length ? keep : ['']).delete();
  }
}

/** Actions that create, start or restart containers (refused while the account is suspended). */
const STARTING_ACTIONS: ReadonlySet<AppDeploymentAction> = new Set<AppDeploymentAction>(['deploy', 'redeploy', 'recreate', 'rollback', 'start', 'wake', 'restart', 'update']);

/** 409 networkNotSegmented when apps cannot run filtered on this account (legacy network, migration failed, policy off). */
export async function assertAccountSegmented(accountId: number): Promise<void> {
  const acct = await db('hosting_accounts').where({ id: accountId }).first('network_model', 'network_error') as { network_model: string | null; network_error: string | null } | undefined;
  await assertSegmented(acct ?? { network_model: null, network_error: null });
}

async function assertSegmented(acct: { network_model: string | null; network_error: string | null }): Promise<void> {
  if (acct.network_model !== 'segmented') {
    throw new AppError(409, acct.network_error
      ? 'The network of this hosting account could not be segmented: applications cannot run until it is'
      : 'The network of this hosting account is not segmented yet (migration pending): try again in a few minutes', 'networkNotSegmented',
    { migrationFailed: !!acct.network_error });
  }
  const mode = (await platformSettings.section('network')).mode;
  if (mode === 'off') throw new AppError(409, 'Network segmentation is switched off on this platform: applications cannot run', 'networkNotSegmented', { policyOff: true });
}

/**
 * Reserves a stack for a non-job operation (deletion): no action may start meanwhile. Synchronous: false
 * when an action / source operation runs or another reservation holds it. Released by releaseStack().
 */
export function reserveStack(stackId: number): boolean {
  if (jobs.has(stackId) || reserved.has(stackId) || isSourceBusy(stackId)) return false;
  reserved.add(stackId);
  return true;
}

export function releaseStack(stackId: number): void {
  reserved.delete(stackId);
}

/** Cancels the running action of a stack (if any) and waits until it is over (account teardown). */
export async function cancelAndWaitStack(stackId: number): Promise<void> {
  const job = jobs.get(stackId);
  if (!job) return;
  job.log.add('Annulation : suppression en cours');
  job.ctrl.abort();
  await job.done.catch(() => undefined);
}

/** Starts an action on a stack: 409 stackBusy when one is running. Returns the queued deployment. */
export async function startAction(stack: StackRow, action: AppDeploymentAction, trigger: AppDeploymentTrigger, opts: ActionOptions): Promise<DeploymentRow> {
  // Reserved synchronously: two requests never both pass the busy check.
  if (jobs.has(stack.id) || reserved.has(stack.id) || isSourceBusy(stack.id)) throw new AppError(409, 'An action is already running on this application', 'stackBusy');
  reserved.add(stack.id);
  let row: DeploymentRow;
  try {
    const current = await db('app_stacks').where({ id: stack.id }).first('status') as { status: AppStackStatus } | undefined;
    if (!current) throw new AppError(404, 'Application not found', 'notFound');
    if (current.status === 'deleting') throw new AppError(409, 'The application is being deleted', 'stackBusy');
    // Never (re)start containers of a suspended / deleted account, whatever the trigger (wake, workflow,
    // git, auto-update, reconcile): the REST routes check it too, internal callers rely on this guard.
    if (STARTING_ACTIONS.has(action)) {
      const acct = await db('hosting_accounts').where({ id: stack.account_id }).first('status', 'network_model', 'network_error') as
        { status: string; network_model: string | null; network_error: string | null } | undefined;
      if (!acct || acct.status === 'suspended' || acct.status === 'deleting') throw new AppError(409, 'The hosting account is suspended', 'accountSuspended');
      // SG1 / deliverable #4: an app container only ever runs where the segment policy filters its traffic
      // (account fabrics registered = network_model 'segmented', policy not switched off). Otherwise a root
      // container with exposed ports would reach the sites, the file server and the panel of the account.
      await assertSegmented(acct);
    }
    // A rollback / an image update runs the source of an earlier deployment: it carries that deployment's
    // commit (git stacks), so the history says which commit is running (never null for a git rollback).
    const commitSha = opts.commitSha !== undefined ? opts.commitSha
      : action === 'rollback' ? opts.rollbackOf?.commit_sha ?? null
        : action === 'update' ? (await lastDeployed(stack.id))?.commit_sha ?? null
          : null;
    [row] = await db('app_deployments').insert({
      stack_id: stack.id, account_id: stack.account_id, tenant_id: stack.tenant_id, action, trigger, status: 'queued',
      commit_sha: commitSha, user_id: opts.userId,
    }).returning('*') as DeploymentRow[];
  } finally {
    reserved.delete(stack.id);
  }
  const job: Job = {
    deploymentId: row.id, stackId: stack.id, action, ctrl: new AbortController(),
    log: new DeployLog((lines) => emitDeployOutput(row.id, stack.id, lines, 'running')),
    done: Promise.resolve(),
  };
  jobs.set(stack.id, job);
  byDeployment.set(row.id, job);
  job.done = (async () => {
    await setStack(stack.id, { status: 'deploying' });
    emitAppUpdated({ entity: 'deployment', id: row.id, stackId: stack.id, accountId: stack.account_id, action: 'created' }, { tenantId: stack.tenant_id, accountId: stack.account_id });
    await runJob(job, stack, trigger, opts);
  })().catch((err) => logger.error({ err, stackId: stack.id }, 'app deployment crashed')).finally(() => {
    jobs.delete(stack.id);
    byDeployment.delete(row.id);
  });
  return row;
}

/** Cancels a running deployment (between two steps; a pull / build in progress is interrupted). */
export async function cancelDeployment(deploymentId: number): Promise<boolean> {
  const job = byDeployment.get(deploymentId);
  if (job) {
    job.log.add('Annulation demandée…');
    job.ctrl.abort();
    return true;
  }
  const n = await db('app_deployments').where({ id: deploymentId }).whereIn('status', ['queued', 'running'])
    .update({ status: 'cancelled', finished_at: db.fn.now(), error: 'Annulé' });
  return n > 0;
}

async function runJob(job: Job, stack: StackRow, trigger: AppDeploymentTrigger, opts: ActionOptions): Promise<void> {
  const deps = appsDeps();
  const { log } = job;
  const checkpoint = () => { if (job.ctrl.signal.aborted) throw new CancelledError(); };
  const flushTimer = setInterval(() => log.flush(), FLUSH_MS);
  let lastPersist = 0;
  const persistLog = async (force = false) => {
    if (!force && Date.now() - lastPersist < PERSIST_MS) return;
    lastPersist = Date.now();
    await db('app_deployments').where({ id: job.deploymentId }).update({ log: JSON.stringify(log.snapshot()) }).catch(() => undefined);
  };
  const persistTimer = setInterval(() => { void persistLog(); }, PERSIST_MS);
  let status: AppDeploymentStatus = 'succeeded';
  let error: string | null = null;
  const finalPatch: Record<string, unknown> = {};
  const depPatch: Record<string, unknown> = {};
  let desired = stack.desired_state;
  let forcedStatus: AppStackStatus | null = null;
  let statusMessage: string | null = opts.statusMessage ?? null;
  /** Services that did not stay up during the post-deploy window (crash loop, unhealthy). */
  let unstable: string[] = [];
  try {
    await db('app_deployments').where({ id: job.deploymentId }).update({ status: 'running', started_at: db.fn.now() });
    log.add(`Action ${job.action} (${trigger}) sur ${stack.display_name}`);
    let docker: Docker;
    try {
      docker = await deps.docker(stack.node_id);
    } catch (err) {
      throw new DeployFailure('Moteur de conteneurs injoignable', errText(err));
    }
    const stackRef = stackRefWith(stack, null);
    const servicesNow = await serviceRows(stack.id);
    const currentPins = (resolved: ResolvedStack): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const svc of resolved.services) {
        const r = servicesNow.find((x) => x.name === svc.name);
        if (r?.current_digest?.startsWith('sha256:') && r.image === svc.imageRef) out[svc.name] = r.current_digest;
      }
      return out;
    };
    const builtTags = Object.fromEntries(servicesNow.filter((r) => r.image?.startsWith('oblimint-build/')).map((r) => [r.name, r.image!]));

    const fullConverge = async (composeYaml: string, mode: {
      alwaysPull: 'all' | null; pins: (r: ResolvedStack) => Record<string, string>; force: 'all' | ReadonlySet<string> | null; rebuild: boolean; tags?: Record<string, string>;
      /** 'fresh': new snapshot of the current source; else the snapshot of that deployment (strict: rollback). */
      source: 'fresh' | { from: DeploymentRow | null; strict?: boolean };
    }) => {
      const choice = await chooseSource(stack, job.deploymentId, log, mode.source === 'fresh' ? 'fresh' : mode.source.from, mode.source !== 'fresh' && !!mode.source.strict);
      const prep = await prepare(stack, composeYaml, stackRefWith(stack, choice.id).sourceLocalDir);
      if (choice.missing && usesSource(prep.resolved)) {
        throw new DeployFailure('Les fichiers sources de ce déploiement ne sont plus conservés : retour arrière impossible (redéployez)');
      }
      const snapshotId = settleSource(stack, choice, prep.resolved);
      const ref = stackRefWith(stack, snapshotId);
      log.addSecrets(prep.secrets);
      const auths = await stackRegistryAuths(stack.id);
      log.addSecrets([...auths.values()].map((a) => a.password));
      for (const i of prep.result.issues) if (i.severity === 'warning') log.add(`Avertissement ${i.path || ''} — ${i.message}`);
      checkpoint();
      await reserveResources(stack, prep.resolved.effective);
      const res = await converge({
        docker, deps, stack: ref, resolved: prep.resolved, log, checkpoint, signal: job.ctrl.signal, deploymentId: job.deploymentId,
        auths, images: imageStoreOf(stack.account_id), alwaysPull: mode.alwaysPull, pins: mode.pins(prep.resolved), builtTags: mode.tags ?? builtTags,
        rebuild: mode.rebuild, force: mode.force, only: null, buildLimits: buildLimitsOf(prep.plan),
      });
      await recordServices(stack, prep.resolved, res, null);
      const eff: EffectiveStackConfig = {
        ...prep.resolved.effective,
        services: prep.resolved.effective.services.map((s) => ({ ...s, fabric: { ...s.fabric, back: res.backServices.includes(s.name) } })),
      };
      const snapshot: EffectiveSnapshot = { effective: eff, effectiveYaml: prep.result.effectiveYaml, specHashes: res.specHashes, sourceSnapshot: snapshotId };
      depPatch.compose_snapshot = composeYaml;
      depPatch.effective_snapshot = JSON.stringify(snapshot);
      depPatch.images = JSON.stringify(res.images);
      Object.assign(finalPatch, {
        effective: JSON.stringify(eff), effective_hash: effectiveHash(eff), validation: JSON.stringify(prep.result), last_deployed_at: db.fn.now(),
      });
      desired = 'running';
      return { prep, res };
    };
    /** Post-deploy window: a service that crash-loops makes the stack 'partial' right away (logged). */
    const observe = async (resolved: ResolvedStack) => {
      const watched = resolved.services.filter((s) => s.restart !== 'no');
      if (!watched.length) return;
      const ms = stableMsOverride ?? DEPLOY_STABLE_MS;
      log.add(`Vérification de la stabilité des services (${Math.round(ms / 1000)} s)…`);
      unstable = await unstableServices(docker, deps, stack.id, watched, ms, checkpoint);
      for (const name of unstable) log.add(`Avertissement — ${name} ne reste pas démarré (redémarrages en boucle ou état non sain) : consultez ses journaux`);
    };

    switch (job.action) {
      case 'deploy':
      case 'redeploy':
      case 'recreate': {
        const redeploy = job.action === 'redeploy';
        const { prep } = await fullConverge(stack.compose_yaml, {
          alwaysPull: redeploy ? 'all' : null, pins: redeploy ? () => ({}) : currentPins, force: job.action === 'recreate' ? 'all' : null, rebuild: !!opts.build,
          source: 'fresh',
        });
        await observe(prep.resolved);
        break;
      }
      case 'rollback': {
        const target = opts.rollbackOf!;
        log.add(`Retour au déploiement #${target.id}`);
        const images = json<Record<string, string>>(target.images, {});
        const pins = Object.fromEntries(Object.entries(images).filter(([, v]) => v.startsWith('sha256:')));
        const tags = Object.fromEntries(Object.entries(images).filter(([, v]) => v.startsWith('oblimint-build/')));
        // The binds point back at the files that deployment mounted (its snapshot), not at the current source.
        const { prep } = await fullConverge(target.compose_snapshot!, { alwaysPull: null, pins: () => pins, force: null, rebuild: false, tags, source: { from: target, strict: true } });
        await observe(prep.resolved);
        if (target.compose_snapshot !== stack.compose_yaml) finalPatch.compose_yaml = target.compose_snapshot;
        break;
      }
      case 'start':
      case 'wake': {
        const started = Date.now();
        const eff = effectiveOf(stack);
        const containers = await stackContainersOf(docker, stack.id);
        const last = await lastDeployed(stack.id);
        const hashes = json<EffectiveSnapshot | null>(last?.effective_snapshot ?? null, null)?.specHashes ?? {};
        // Complete = every service has its container, as deployed (same spec hash), its binds coming from an
        // immutable deployment snapshot (else Docker would re-resolve a live source path at start): then a
        // plain start. Otherwise the containers are recreated from the deployed snapshot.
        const unsafe = [...containers.entries()].filter(([, c]) => unsafeBindSources(stackRef, c.Mounts).length > 0).map(([n]) => n);
        if (unsafe.length) log.add(`Fichiers montés par ${unsafe.join(', ')} à resynchroniser : recréation`);
        const complete = !!eff && unsafe.length === 0 && eff.services.every((s) => containers.has(s.name)
          && (!hashes[s.name] || containers.get(s.name)!.Labels?.['oblimint.spec-hash'] === hashes[s.name]));
        if (complete) {
          for (const s of eff!.services) {
            checkpoint();
            const c = containers.get(s.name)!;
            if (c.State === 'paused') { log.add(`Reprise de ${s.name}`); await unpauseContainer(docker, appContainer(stack.id, s.name)); }
            else if (c.State !== 'running') { log.add(`Démarrage de ${s.name}`); await startContainer(docker, appContainer(stack.id, s.name)); }
          }
        } else {
          await fullConverge(last?.compose_snapshot ?? stack.compose_yaml, {
            alwaysPull: null, pins: currentPins, force: unsafe.length ? new Set(unsafe) : null, rebuild: false, source: last ? { from: last } : 'fresh',
          });
        }
        desired = 'running';
        if (job.action === 'wake') {
          await waitReady(docker, stack, eff, log, checkpoint);
          const d = wakeDurations.get(stack.id) ?? [];
          d.push((Date.now() - started) / 1000);
          wakeDurations.set(stack.id, d.slice(-10));
          finalPatch.last_activity_at = db.fn.now();
        }
        break;
      }
      case 'stop':
      case 'sleep': {
        const sleepMode = job.action === 'sleep' ? sleepPolicyOf(stack).mode : 'stop';
        const containers = await stackContainersOf(docker, stack.id);
        const eff = effectiveOf(stack);
        const order = [...(eff?.services.map((s) => s.name) ?? [])].reverse();
        for (const name of [...order, ...[...containers.keys()].filter((n) => !order.includes(n))]) {
          if (!containers.has(name)) continue;
          checkpoint();
          if (sleepMode === 'pause') { log.add(`Pause de ${name}`); await pauseContainer(docker, appContainer(stack.id, name)); }
          else { log.add(`Arrêt de ${name}`); await stopContainer(docker, appContainer(stack.id, name), 30); }
        }
        if (job.action === 'sleep') forcedStatus = 'sleeping';
        else if (!opts.keepDesired) desired = 'stopped';
        else forcedStatus = 'stopped';
        break;
      }
      case 'restart': {
        const containers = await stackContainersOf(docker, stack.id);
        const wanted = opts.services?.length ? opts.services : [...containers.keys()];
        // A container whose binds are not an immutable deployment snapshot is never restarted as is (Docker
        // re-resolves the bind sources at every start): recreated from the deployed snapshot instead.
        const unsafe = wanted.filter((n) => containers.has(n) && unsafeBindSources(stackRef, containers.get(n)!.Mounts).length > 0);
        if (unsafe.length) {
          const last = await lastDeployed(stack.id);
          if (!last?.compose_snapshot) throw new DeployFailure('Les fichiers montés de cette application doivent être resynchronisés : redéployez-la');
          log.add(`Fichiers montés par ${unsafe.join(', ')} à resynchroniser : recréation depuis le déploiement #${last.id}`);
          await fullConverge(last.compose_snapshot, { alwaysPull: null, pins: currentPins, force: new Set(unsafe), rebuild: false, source: { from: last } });
        }
        for (const name of wanted) {
          checkpoint();
          if (unsafe.includes(name)) continue;
          if (!containers.has(name)) { log.add(`${name} : aucun conteneur (déployez d'abord)`); continue; }
          log.add(`Redémarrage de ${name}`);
          await restartContainer(docker, appContainer(stack.id, name), 30);
        }
        break;
      }
      case 'down': {
        const containers = await stackContainersOf(docker, stack.id);
        for (const name of containers.keys()) {
          checkpoint();
          log.add(`Suppression du conteneur ${name}`);
          await removeContainer(docker, appContainer(stack.id, name));
        }
        const nets = await docker.listNetworks({ filters: { label: [`${P4B_LABELS.appNetwork}=${stack.id}`] } }) as Array<{ Name: string }>;
        for (const n of nets) await removeNetwork(docker, n.Name).catch((err) => { log.add(`Réseau ${n.Name} non supprimé`); logger.warn({ err: errText(err), stackId: stack.id }, 'apps: network not removed'); });
        desired = 'stopped';
        break;
      }
      case 'pull': {
        // Builds read their context from a snapshot too (never the live tree); nothing runs from it afterwards.
        const choice = await chooseSource(stack, job.deploymentId, log, 'fresh');
        try {
          const prep = await prepare(stack, stack.compose_yaml, stackRefWith(stack, choice.id).sourceLocalDir);
          log.addSecrets(prep.secrets);
          const auths = await stackRegistryAuths(stack.id);
          log.addSecrets([...auths.values()].map((a) => a.password));
          await converge({
            docker, deps, stack: stackRefWith(stack, choice.id), resolved: prep.resolved, log, checkpoint, signal: job.ctrl.signal, deploymentId: job.deploymentId, auths,
            images: imageStoreOf(stack.account_id), alwaysPull: 'all', pins: {}, builtTags, rebuild: false, force: null, only: null,
            buildLimits: buildLimitsOf(prep.plan), imagesOnly: true,
          });
        } finally {
          if (choice.id !== null) { try { removeSnapshot(stackRef.localDir, choice.id); } catch { /* pruned later */ } }
        }
        break;
      }
      case 'update': {
        await runUpdate(job, stack, docker, servicesNow, builtTags, opts, depPatch, checkpoint);
        break;
      }
      default:
        throw new DeployFailure(`Action ${job.action} non prise en charge`);
    }
    log.add('Terminé');
  } catch (err) {
    if (err instanceof CancelledError) {
      status = 'cancelled';
      error = 'Annulé';
      log.add('Action annulée');
    } else {
      status = 'failed';
      error = err instanceof DeployFailure ? err.message : `Erreur interne : ${errText(err)}`;
      log.add(`${ERROR_LINE_PREFIX}${error}`);
      if (!(err instanceof DeployFailure)) logger.error({ err, stackId: stack.id, deploymentId: job.deploymentId }, 'app deployment failed');
      statusMessage = err instanceof DeployFailure ? err.message : 'Échec de l\'action : erreur interne';
      if (['deploy', 'redeploy', 'recreate', 'rollback', 'start'].includes(job.action)) {
        appsDeps().notify('app.deployFailed', {
          tenantId: stack.tenant_id, accountId: stack.account_id, key: `app.deployFailed:${stack.id}:${job.deploymentId}`,
          title: `Échec du déploiement de ${stack.display_name}`,
          message: `L'action « ${job.action} » de l'application ${stack.display_name} a échoué.\n${err instanceof DeployFailure ? err.label : 'Erreur interne.'}`,
          severity: 'warning', link: `/apps/${stack.id}`,
        });
      }
    }
  } finally {
    clearInterval(flushTimer);
    clearInterval(persistTimer);
    log.flush();
    try {
      // Stack status from the containers (Docker unreachable: error).
      let stackStatus: AppStackStatus;
      let message = statusMessage;
      if (status === 'failed' && job.action !== 'update') {
        stackStatus = 'error';
      } else {
        try {
          const docker = await appsDeps().docker(stack.node_id);
          const fresh = await loadStackRow(stack.id);
          const eff = finalPatch.effective ? json<EffectiveStackConfig>(finalPatch.effective, null as never) : effectiveOf(fresh ?? stack);
          const computed = statusFromContainers(eff, await stackContainersOf(docker, stack.id), desired);
          const final = withUnstable(computed, unstable, eff?.services.length ?? 0);
          stackStatus = forcedStatus ?? final.status;
          if (!forcedStatus && !message) message = final.message;
          if (status === 'failed') message = statusMessage;
        } catch (err) {
          stackStatus = 'error';
          message = `Moteur de conteneurs injoignable : ${errText(err)}`;
        }
      }
      await setStack(stack.id, { ...finalPatch, desired_state: desired, status: stackStatus, status_message: message });
      await db('app_deployments').where({ id: job.deploymentId }).update({
        ...depPatch, status, error, finished_at: db.fn.now(), log: JSON.stringify(log.snapshot()),
      });
    } catch (err) {
      logger.error({ err, stackId: stack.id }, 'app deployment: final persistence failed');
    }
    // Only now: the policy push and the edge pass read app_stacks.effective (exposed ports, F3 / F4 flows,
    // proxy targets), which holds the new config from this point on (security / robustness audit P4b).
    try {
      appsDeps().segments.requestPolicySync('apps');
      appsDeps().edgeSync('apps');
    } catch { /* never throws by contract */ }
    emitDeployOutput(job.deploymentId, stack.id, [], status);
    emitAppUpdated({ entity: 'deployment', id: job.deploymentId, stackId: stack.id, accountId: stack.account_id, action: 'updated' }, { tenantId: stack.tenant_id, accountId: stack.account_id });
    emitAppUpdated({ entity: 'stack', id: stack.id, stackId: stack.id, accountId: stack.account_id, action: 'updated' }, { tenantId: stack.tenant_id, accountId: stack.account_id });
  }
}

/** Image update (§5.5) of some services, or the return of one service to its previous digest. */
async function runUpdate(
  job: Job, stack: StackRow, docker: Docker,
  servicesNow: ServiceRow[], builtTags: Record<string, string>, opts: ActionOptions, depPatch: Record<string, unknown>, checkpoint: () => void,
): Promise<void> {
  const deps = appsDeps();
  const { log } = job;
  const last = await lastDeployed(stack.id);
  if (!last?.compose_snapshot) throw new DeployFailure('Aucun déploiement réussi : rien à mettre à jour');
  // Same source files as the deployment being updated (its snapshot): only the images change.
  const choice = await chooseSource(stack, job.deploymentId, log, last);
  const prep = await prepare(stack, last.compose_snapshot, stackRefWith(stack, choice.id).sourceLocalDir);
  const snapshotId = settleSource(stack, choice, prep.resolved);
  const stackRef = stackRefWith(stack, snapshotId);
  log.addSecrets(prep.secrets);
  const auths = await stackRegistryAuths(stack.id);
  log.addSecrets([...auths.values()].map((a) => a.password));
  const pins: Record<string, string> = {};
  for (const r of servicesNow) if (r.current_digest?.startsWith('sha256:')) pins[r.name] = r.current_digest;
  const targets: string[] = [];
  const before: Record<string, string | null> = {};
  if (opts.imageRollback) {
    const r = servicesNow.find((x) => x.name === opts.imageRollback);
    if (!r?.previous_digest) throw new DeployFailure(`Aucune image précédente pour ${opts.imageRollback}`);
    log.add(`Retour de ${r.name} à l'image précédente ${r.previous_digest.slice(0, 19)}…`);
    before[r.name] = r.current_digest;
    pins[r.name] = r.previous_digest;
    targets.push(r.name);
  } else {
    const wanted = opts.services?.length ? new Set(opts.services) : null;
    for (const r of servicesNow) {
      if (wanted && !wanted.has(r.name)) continue;
      if (!wanted && r.excluded_from_updates) continue;
      if (!r.latest_digest || r.latest_digest === r.current_digest || !prep.resolved.services.some((s) => s.name === r.name && s.imageRef)) continue;
      before[r.name] = r.current_digest;
      pins[r.name] = r.latest_digest;
      targets.push(r.name);
    }
  }
  if (!targets.length) {
    log.add('Aucune mise à jour à appliquer');
    return;
  }
  const only = new Set(targets);
  const run = (p: Record<string, string>) => converge({
    docker, deps, stack: stackRef, resolved: prep.resolved, log, checkpoint, signal: job.ctrl.signal, deploymentId: job.deploymentId, auths,
    images: imageStoreOf(stack.account_id), alwaysPull: null, pins: p, builtTags, rebuild: false, force: null, only, buildLimits: buildLimitsOf(prep.plan),
  });
  log.add(`Mise à jour de ${targets.join(', ')}`);
  let res = await run(pins);
  try {
    for (const name of targets) {
      log.add(`Contrôle de santé de ${name} (120 s max)…`);
      await checkServiceHealth(docker, deps, stack.id, prep.resolved.services.find((s) => s.name === name)!, HEALTH_TIMEOUT_MS, stableMsOverride ?? UPDATE_STABLE_MS, checkpoint);
    }
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    log.add(`${ERROR_LINE_PREFIX}Contrôle de santé en échec : ${errText(err)}`);
    const back = { ...pins };
    for (const name of targets) if (before[name]?.startsWith('sha256:')) back[name] = before[name]!;
    log.add('Retour à l\'image précédente…');
    res = await run(back);
    await recordServices(stack, prep.resolved, res, only);
    deps.notify('app.updateFailed', {
      tenantId: stack.tenant_id, accountId: stack.account_id, key: `app.updateFailed:${stack.id}:${job.deploymentId}`,
      title: `Mise à jour de ${stack.display_name} annulée`,
      message: `La nouvelle image de ${targets.join(', ')} n'a pas passé le contrôle de santé : l'image précédente a été remise en service.`,
      severity: 'warning', link: `/apps/${stack.id}`,
    });
    throw new DeployFailure('Mise à jour échouée : retour à l\'image précédente', errText(err));
  }
  await recordServices(stack, prep.resolved, res, only);
  // previous_digest follows the change (recordServices); an image rollback swaps the pair.
  if (opts.imageRollback) {
    await db('app_services').where({ stack_id: stack.id, name: opts.imageRollback }).update({ previous_digest: before[opts.imageRollback] ?? null });
  }
  const images = { ...json<Record<string, string>>(last.images, {}), ...res.images };
  depPatch.compose_snapshot = last.compose_snapshot;
  const snap = json<EffectiveSnapshot | null>(last.effective_snapshot, null);
  depPatch.effective_snapshot = snap ? JSON.stringify({ ...snap, specHashes: { ...snap.specHashes, ...res.specHashes }, sourceSnapshot: snapshotId }) : null;
  depPatch.images = JSON.stringify(images);
  if (!opts.imageRollback) {
    deps.notify('app.updated', {
      tenantId: stack.tenant_id, accountId: stack.account_id, key: `app.updated:${stack.id}:${job.deploymentId}`,
      title: `${stack.display_name} mise à jour`,
      message: `Nouvelle image appliquée à ${targets.join(', ')}.`, severity: 'info', link: `/apps/${stack.id}`,
    });
  }
}

/** Readiness of a woken stack (§5.7): readyPath over HTTP from the panel, else a TCP connect, on the first exposed service. */
async function waitReady(docker: Docker, stack: StackRow, eff: EffectiveStackConfig | null, log: DeployLog, checkpoint: () => void): Promise<void> {
  void docker;
  const deps = appsDeps();
  const policy = sleepPolicyOf(stack);
  const target = eff?.services.find((s) => s.exposedPorts.some((p) => p.protocol === 'tcp'));
  if (!target) return;
  const port = target.exposedPorts.find((p) => p.protocol === 'tcp')!.port;
  const host = appServiceAlias(stack.id, target.name);
  const deadline = deps.now() + policy.wakeTimeoutSec * 1000;
  log.add(`Attente de ${target.name}${policy.readyPath ? ` (${policy.readyPath})` : ''}…`);
  for (;;) {
    checkpoint();
    const ok = policy.readyPath
      ? await deps.probeHttp(`http://${host}:${port}${policy.readyPath.startsWith('/') ? '' : '/'}${policy.readyPath}`, 3000)
      : await deps.probeTcp(host, port, 3000);
    if (ok) { log.add(`${target.name} prêt`); return; }
    if (deps.now() >= deadline) throw new DeployFailure(`${target.name} ne répond pas après le réveil`);
    await deps.sleep(1000);
  }
}

/** Status message of a stack whose action was cut by a panel restart (the reconcile repairs it). */
export const INTERRUPTED_MESSAGE = 'Action interrompue par un redémarrage du panel : remise en état automatique';

/**
 * Boot: deployments left running by a panel restart are failed. Their stacks are NOT put in 'error' (that
 * status waits for the user): they become 'partial' with INTERRUPTED_MESSAGE, so the reconcile recreates
 * missing / drifted containers from the deployed snapshot when the stack should run. An interrupted
 * stop / down by the user keeps its intent (desired 'stopped'). Never throws.
 */
export async function recoverInterruptedDeployments(): Promise<void> {
  try {
    const rows = await db('app_deployments').whereIn('status', ['queued', 'running']).select('id', 'stack_id', 'action', 'trigger') as
      Array<{ id: number; stack_id: number; action: AppDeploymentAction; trigger: AppDeploymentTrigger }>;
    const live = new Set([...byDeployment.keys()]);
    for (const r of rows) {
      if (live.has(r.id)) continue;
      await db('app_deployments').where({ id: r.id }).update({ status: 'failed', error: 'Interrompu par un redémarrage du panel', finished_at: db.fn.now() });
      if (jobs.has(r.stack_id)) continue;
      const stopIntent = (r.action === 'stop' || r.action === 'down') && r.trigger !== 'system';
      await db('app_stacks').where({ id: r.stack_id, status: 'deploying' }).update({
        status: 'partial', status_message: INTERRUPTED_MESSAGE, ...(stopIntent ? { desired_state: 'stopped' } : {}), updated_at: db.fn.now(),
      });
    }
  } catch (err) {
    logger.warn({ err: errText(err) }, 'apps: interrupted deployments not recovered');
  }
}

/** Retention (settings deploymentRetention / Days); the last successful deployment is always kept. Never throws. */
export async function pruneDeployments(): Promise<void> {
  try {
    const s = await platformSettings.section('apps');
    const stacks = await db('app_deployments').distinct('stack_id') as Array<{ stack_id: number }>;
    const cutoff = new Date(Date.now() - s.deploymentRetentionDays * 86_400_000);
    for (const { stack_id: stackId } of stacks) {
      const keep = await lastDeployed(stackId);
      const ids = await db('app_deployments').where({ stack_id: stackId }).whereNotIn('status', ['queued', 'running']).orderBy('id', 'desc').pluck('id') as number[];
      const excess = ids.slice(s.deploymentRetention);
      const q = db('app_deployments').where({ stack_id: stackId }).whereNotIn('status', ['queued', 'running'])
        .andWhere((w) => { w.whereIn('id', excess.length ? excess : [0]).orWhere('created_at', '<', cutoff); });
      if (keep) q.whereNot({ id: keep.id });
      await q.delete();
      await pruneStackSnapshots(stackId, keep);
    }
  } catch (err) {
    logger.warn({ err: errText(err) }, 'apps: deployment retention failed');
  }
}

/**
 * Source snapshots follow the deployment retention: kept while a remaining deployment references one, and
 * every snapshot newer than the last successful deployment (an action running now, or a failed one whose
 * containers may still use it). Never while an action runs on the stack. Never throws.
 */
async function pruneStackSnapshots(stackId: number, last: DeploymentRow | null): Promise<void> {
  try {
    if (jobs.has(stackId) || reserved.has(stackId)) return;
    const stack = await db('app_stacks').where({ id: stackId }).first('id', 'account_id') as { id: number; account_id: number } | undefined;
    if (!stack) return;
    const rows = await db('app_deployments').where({ stack_id: stackId }).select('effective_snapshot') as Array<Pick<DeploymentRow, 'effective_snapshot'>>;
    const keep = new Set<number>();
    for (const r of rows) { const id = sourceSnapshotOf(r); if (typeof id === 'number') keep.add(id); }
    pruneSnapshots(localPaths.appStack(stack.account_id, stackId), keep, last?.id ?? null);
  } catch (err) {
    logger.warn({ err: errText(err), stackId }, 'apps: source snapshots not pruned');
  }
}
