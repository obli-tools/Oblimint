import fs from 'fs';
import path from 'path';
import type Docker from 'dockerode';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { errText } from '../setup/docker';
import { LABELS } from '../hosting/naming';
import { localPaths } from '../hosting/paths';
import { json } from '../hosting/rows';
import { platformSettings } from '../platformSettings';
import { appsDeps } from './deps';
import {
  INTERRUPTED_MESSAGE, isStackBusy, lastDeployed, loadStackRow, pruneDeployments, recoverInterruptedDeployments, stackRefWith, startAction, statusFromContainers,
} from './deployments';
import { stackContainersOf, unsafeBindSources } from './engine';
import { remappedInspector } from './fsSafe';
import { composeContext, envMap, openEnv } from './context';
import { validateCompose } from './compose/validate';
import { removeTreeNoFollow } from './fsSafe';
import { effectiveOf, updatePolicyOf, type EffectiveSnapshot, type StackRow } from './rows';
import { sleepManager } from './sleep';
import { isSourceBusy, pullGitSource, remoteCommit } from './sources';
import { runUpdatePass } from './updates';

// ─────────────────────────────────────────────────────────────────────────────
// Worker of the apps module (docs/P4b-PLAN.md §5.5, §5.7, §5.8, §17):
//   reconcile    every 2 min (and after each P1 account pass, queued by the
//                hook): suspended / deleting account → containers stopped;
//                desired running → missing / drifted containers re-created
//                from the DEPLOYED snapshot (never from an unreviewed edit),
//                stopped ones (after a suspension) started;
//   git poll     every 30 s, per stack interval (≥ settings gitPollMinSec):
//                new commit → source fetched, auto-deploy inside the window;
//   updates      every 5 min: digest checks due, auto-updates in the window;
//   sleep        every minute: activity flushed, idle stacks put to sleep;
//   housekeeping hourly: deployment retention, volume tombstones purged.
// start() returns at once, never throws, survives an absent Docker / DB.
// ─────────────────────────────────────────────────────────────────────────────

const RECONCILE_MS = 2 * 60_000;
const GIT_POLL_MS = 30_000;
const UPDATE_MS = 5 * 60_000;
const SLEEP_MS = 60_000;
const HOUSEKEEPING_MS = 60 * 60_000;
export const SUSPENDED_MESSAGE = 'Compte suspendu : application arrêtée';

export type ReconcileDecision = { action: 'none' } | { action: 'stop'; message: string } | { action: 'start'; reason: string };

/** Pure decision for one stack (tested): what the reconcile queues. */
export function reconcileDecision(
  stack: Pick<StackRow, 'status' | 'desired_state' | 'status_message'> & { effective: unknown; validation?: unknown },
  accountStatus: string, containers: Map<string, Docker.ContainerInfo>, deployedHashes: Record<string, string> | null,
  /** Services whose container binds a live source path (not an immutable snapshot): recreated. */
  unsafeBinds: readonly string[] = [],
): ReconcileDecision {
  if (['draft', 'deploying', 'deleting'].includes(stack.status)) return { action: 'none' };
  const running = [...containers.values()].some((c) => c.State === 'running' || c.State === 'paused' || c.State === 'restarting');
  if (accountStatus === 'suspended' || accountStatus === 'deleting') {
    return running ? { action: 'stop', message: SUSPENDED_MESSAGE } : { action: 'none' };
  }
  if (accountStatus === 'provisioning') return { action: 'none' };
  // A failed stack waits for its user (no retry loop, no notification storm); a sleeping one for a request.
  if (stack.desired_state !== 'running' || stack.status === 'sleeping' || stack.status === 'error' || !deployedHashes) return { action: 'none' };
  const eff = effectiveOf(stack);
  if (!eff) return { action: 'none' };
  for (const s of eff.services) {
    const c = containers.get(s.name);
    if (!c) return { action: 'start', reason: `${s.name} missing` };
    const want = deployedHashes[s.name];
    if (want && c.Labels?.[LABELS.specHash] !== want) return { action: 'start', reason: `${s.name} drifted` };
  }
  if (unsafeBinds.length) return { action: 'start', reason: `${unsafeBinds.join(', ')}: binds not from a deployment snapshot` };
  // An action cut by a panel restart (recoverInterruptedDeployments): brought back to the deployed state.
  if (stack.status === 'partial' && stack.status_message === INTERRUPTED_MESSAGE && statusFromContainers(eff, containers, 'running').status !== 'running') {
    return { action: 'start', reason: 'interrupted action' };
  }
  if (stack.status === 'stopped' && stack.status_message === SUSPENDED_MESSAGE) return { action: 'start', reason: 'account resumed' };
  return { action: 'none' };
}

async function reconcileStack(stack: StackRow, accountStatus: string): Promise<void> {
  if (isStackBusy(stack.id)) return;
  let docker: Docker;
  try {
    docker = await appsDeps().docker(stack.node_id);
  } catch {
    return; // Docker unreachable: next pass.
  }
  const containers = await stackContainersOf(docker, stack.id);
  const last = await lastDeployed(stack.id);
  const hashes = last ? json<EffectiveSnapshot | null>(last.effective_snapshot, null)?.specHashes ?? {} : null;
  const ref = stackRefWith(stack, null);
  const unsafe = [...containers.entries()].filter(([, c]) => unsafeBindSources(ref, c.Mounts).length > 0).map(([n]) => n);
  const d = reconcileDecision(stack, accountStatus, containers, hashes, unsafe);
  if (d.action === 'stop') await startAction(stack, 'stop', 'system', { userId: null, keepDesired: true, statusMessage: d.message });
  else if (d.action === 'start') {
    logger.info({ stackId: stack.id, reason: d.reason }, 'apps: reconcile restarts the stack');
    await startAction(stack, 'start', 'system', { userId: null });
  } else if ((stack.status === 'running' || stack.status === 'partial') && accountStatus === 'active') {
    // Status follows the containers (a crashed service, a host reboot with restart: no).
    const s = statusFromContainers(effectiveOf(stack), containers, stack.desired_state);
    if (s.status !== stack.status && !isStackBusy(stack.id)) {
      await db('app_stacks').where({ id: stack.id, status: stack.status }).update({ status: s.status, status_message: s.message, updated_at: db.fn.now() });
    }
  }
}

/** Reconciles the stacks of one account (or every account). Never throws. */
export async function reconcileStacks(accountId: number | null): Promise<void> {
  try {
    const qb = db('app_stacks as s').join('hosting_accounts as a', 'a.id', 's.account_id').select('s.*', 'a.status as account_status');
    if (accountId) qb.where('s.account_id', accountId);
    const rows = await qb as Array<StackRow & { account_status: string }>;
    for (const r of rows) {
      try {
        await reconcileStack(r, r.account_status);
      } catch (err) {
        logger.warn({ err: errText(err), stackId: r.id }, 'apps: stack reconcile failed');
      }
    }
  } catch (err) {
    logger.warn({ err: errText(err) }, 'apps: reconcile pass failed');
  }
}

async function gitPollPass(): Promise<void> {
  const deps = appsDeps();
  const settings = await platformSettings.section('apps');
  const rows = await db('app_stacks as s').join('hosting_accounts as a', 'a.id', 's.account_id')
    .where('a.status', 'active').where('s.source_type', 'git').whereNotNull('s.git_poll_interval_sec').whereNot('s.status', 'deleting').select('s.*') as StackRow[];
  const now = deps.now();
  for (const stack of rows) {
    if (isStackBusy(stack.id)) continue;
    const every = Math.max(settings.gitPollMinSec, stack.git_poll_interval_sec ?? 0) * 1000;
    const last = stack.git_last_checked_at ? new Date(stack.git_last_checked_at).getTime() : 0;
    if (now - last < every) continue;
    if (isSourceBusy(stack.id) || isStackBusy(stack.id)) continue; // a pull / upload / deployment is running: next pass
    try {
      const sha = await remoteCommit(stack);
      if (sha === stack.git_last_commit) {
        await db('app_stacks').where({ id: stack.id }).update({ git_last_checked_at: db.fn.now(), git_last_error: null });
        continue;
      }
      if (!stack.git_auto_deploy) {
        await db('app_stacks').where({ id: stack.id }).update({ git_last_checked_at: db.fn.now(), git_last_error: null });
        continue;
      }
      const open = await deps.maintenanceOpen({ tenantId: stack.tenant_id, accountId: stack.account_id, windowId: updatePolicyOf(stack).maintenanceWindowId });
      if (!open) {
        await db('app_stacks').where({ id: stack.id }).update({ git_last_checked_at: db.fn.now() });
        continue;
      }
      // The new tree is validated BEFORE it replaces src/ (a refused tree is never swapped in).
      const res = await pullGitSource(stack, false, { validate: (yaml, inspector) => validateStagedCompose(stack, yaml, inspector) });
      if (res.changed) {
        const fresh = await loadStackRow(stack.id);
        if (fresh) await startAction(fresh, 'deploy', 'git', { userId: null, commitSha: res.commit, build: fresh.git_build });
      }
    } catch (err) {
      await db('app_stacks').where({ id: stack.id }).update({ git_last_checked_at: db.fn.now(), git_last_error: (err as Error).message.slice(0, 500) }).catch(() => undefined);
      logger.info({ stackId: stack.id, err: (err as Error).message }, 'apps: git poll failed');
    }
  }
}

/** Validation of a staged git tree by the poll worker: any error refuses the swap. */
async function validateStagedCompose(stack: StackRow, composeYaml: string, inspector: ReturnType<typeof remappedInspector>): Promise<void> {
  const env = envMap(openEnv(stack.env_sealed));
  const { ctx } = await composeContext({
    stackId: stack.id, accountId: stack.account_id, sourceType: stack.source_type, gitComposePath: stack.git_compose_path, env, inspect: true, inspector,
  });
  const out = validateCompose(composeYaml, ctx);
  const first = out.result.issues.find((i) => i.severity === 'error');
  if (first) throw new Error(`Compose refusé : ${first.message}`.slice(0, 500));
}

/** Purges volume directories whose grace period ended (never through a link, only under accounts/<id>/apps/). */
export async function purgeTombstones(): Promise<number> {
  let purged = 0;
  const rows = await db('app_volume_tombstones').whereNull('purged_at').where('purge_after', '<', new Date()).limit(100) as
    Array<{ id: number; account_id: number; path: string }>;
  for (const r of rows) {
    try {
      const root = path.resolve(localPaths.apps(r.account_id));
      const target = path.resolve(r.path);
      if (!target.startsWith(root + path.sep)) throw new Error('tombstone outside the account apps directory');
      if (fs.existsSync(target) || (() => { try { fs.lstatSync(target); return true; } catch { return false; } })()) removeTreeNoFollow(target, root);
      // The stack directory itself (empty once its volumes are gone).
      const stackDir = path.dirname(target);
      try { if (stackDir.startsWith(root + path.sep) && fs.readdirSync(stackDir).length === 0) fs.rmdirSync(stackDir); } catch { /* kept */ }
      await db('app_volume_tombstones').where({ id: r.id }).update({ purged_at: db.fn.now(), error: null });
      purged++;
    } catch (err) {
      await db('app_volume_tombstones').where({ id: r.id }).update({ error: errText(err) }).catch(() => undefined);
    }
  }
  return purged;
}

class AppsWorker {
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  private busy = new Set<string>();

  start(): void {
    if (this.running) return;
    this.running = true;
    const every = (name: string, ms: number, fn: () => Promise<unknown>, firstDelayMs = 5_000) => {
      const run = () => {
        if (this.busy.has(name)) return;
        this.busy.add(name);
        fn().catch((err) => logger.warn({ err: errText(err), task: name }, 'apps worker task failed')).finally(() => this.busy.delete(name));
      };
      this.timers.push(setTimeout(run, firstDelayMs));
      this.timers.push(setInterval(run, ms));
    };
    void (async () => {
      try {
        await recoverInterruptedDeployments();
        (await import('./catalog.service')).catalogService.seedBuiltins().catch(() => undefined);
      } catch { /* the loops retry */ }
    })();
    sleepManager.start();
    every('reconcile', RECONCILE_MS, () => reconcileStacks(null), 20_000);
    every('git', GIT_POLL_MS, gitPollPass);
    every('updates', UPDATE_MS, async () => runUpdatePass((await platformSettings.section('apps')).updateCheckMinMinutes), 60_000);
    every('sleep', SLEEP_MS, async () => { await sleepManager.flush(); await sleepManager.sleepIdle(); });
    every('housekeeping', HOUSEKEEPING_MS, async () => { await pruneDeployments(); await purgeTombstones(); }, 120_000);
    for (const t of this.timers) t.unref?.();
  }

  stop(): void {
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    this.timers = [];
    sleepManager.stop();
    this.running = false;
  }

  /** A P1 pass of the account finished (hook): queue its reconcile outside the account lock. */
  requestAccount(accountId: number): void {
    setImmediate(() => { void reconcileStacks(accountId); });
  }

  settingsChanged(): void {
    logger.debug('apps: settings changed (read again at the next pass)');
  }
}

export const appsWorker = new AppsWorker();
