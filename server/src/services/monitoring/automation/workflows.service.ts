import fs from 'fs';
import path from 'path';
import type { Request } from 'express';
import type {
  Workflow, WorkflowAction, WorkflowInput, WorkflowRun, WorkflowRunStatus, WorkflowTrigger, WorkflowUpdate,
} from '@oblimint/shared';
import { MASTER_TENANT_ID } from '@oblimint/shared';
import { db } from '../../../db';
import { AppError } from '../../../middleware/errorHandler';
import { logger } from '../../../utils/logger';
import { open } from '../../../utils/secretBox';
import { auditService } from '../../audit.service';
import { loadStack } from '../../apps/access';
import { appsService } from '../../apps/apps.service';
import type { HostingActor } from '../../hosting/access';
import { assertOwnedAccess, loadOwned, type OwnedRow } from '../../hosting/p4bAccess';
import { localPaths } from '../../hosting/paths';
import { platformSettings } from '../../platformSettings';
import { notify } from '../../usage/notifications.service';
import { assertPlanRoom, isPlatformAdmin, jsonValue, ownerForCreate, ownerOf, sameOwner, scopeList, toIso, type ListFilter, type RowOwner } from '../common';
import { emitMonitoring } from '../events';
import { TargetRefusedError } from '../targetGuard';
import { openTargetSession, type SftpTargetRow } from './credentials.service';
import { HostKeyMismatchError, remotePathUnder, sftpErrorText, SftpError } from './sftp';
import { certificateMatches, nextRunAt, normalizeTrigger, triggerProblem } from './triggers';

// ─────────────────────────────────────────────────────────────────────────────
// Workflows (docs/P4b-PLAN.md §11.1, invariant MO4):
//   triggers  interval (≥ 5 min) / cron (5 fields, time zone) — the worker
//             scheduler; cert-renewal — edge contributor
//             onCertificateInstalled (names filter, SAME owner as the
//             certificate); manual — POST /run;
//   actions   export-certificate (SFTP: fullchain.pem + privkey.pem, or one
//             bundle.pem, mode 0600, under the target's base path) and
//             restart-app (appsService.restartForWorkflow);
//   never two runs at once: running_since is claimed atomically (stale after
//             1 h: a panel killed mid-run does not lock the workflow forever);
//   every id of an action belongs to the workflow's owner (checked at save
//             time AND at run time); restart-app also needs apps.manage on
//             the stack at save time; export-certificate needs proxy.manage
//             on the certificate's account, and a PLATFORM certificate (panel
//             / preview wildcard: no domain, no site) is exportable only by a
//             platform admin (also required to edit an SFTP target such a
//             workflow uses: credentials.service.ts);
//   export-certificate never sends a key to an UNPINNED host: the target
//             must have been tested (host key pinned) first;
//   the single-run slot is released only by the run that claimed it
//             (running_since = its own claim), and runs interrupted by a panel
//             restart are closed as failed at the worker start;
//   run log capped (lines and size), runs kept per workflow, failure ⇒
//             notify('workflow.failed').
// ─────────────────────────────────────────────────────────────────────────────

export const STALE_RUN_MS = 3_600_000;
export const MAX_LOG_LINES = 500;
const MAX_LOG_LINE = 1_000;
export const RUNS_KEPT = 100;
export const SCHEDULER_TICK_MS = 30_000;
const MAX_ACTIONS = 10;
/** restart-app: how long a run waits for the outcome of the restart deployment, and how often it looks. */
const RESTART_WAIT_MS = 10 * 60_000;
const RESTART_POLL_MS = 1_000;

export interface WorkflowRow extends OwnedRow {
  name: string;
  enabled: boolean;
  trigger: unknown;
  actions: unknown;
  last_run_at: Date | string | null;
  last_status: WorkflowRunStatus | null;
  next_run_at: Date | string | null;
  running_since: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RunRow {
  id: number;
  workflow_id: number;
  trigger: string;
  status: WorkflowRunStatus;
  log: unknown;
  started_at: Date | string;
  finished_at: Date | string | null;
}

function toWorkflow(r: WorkflowRow): Workflow {
  return {
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    accountId: r.account_id === null ? null : Number(r.account_id),
    name: r.name,
    enabled: !!r.enabled,
    trigger: jsonValue<WorkflowTrigger>(r.trigger, { kind: 'manual' }),
    actions: jsonValue<WorkflowAction[]>(r.actions, []),
    lastRunAt: toIso(r.last_run_at),
    lastStatus: r.last_status,
    nextRunAt: toIso(r.next_run_at),
    createdAt: toIso(r.created_at)!,
    updatedAt: toIso(r.updated_at)!,
  };
}

function toRun(r: RunRow): WorkflowRun {
  return {
    id: Number(r.id),
    workflowId: Number(r.workflow_id),
    trigger: r.trigger,
    status: r.status,
    log: jsonValue<string[]>(r.log, []),
    startedAt: toIso(r.started_at)!,
    finishedAt: toIso(r.finished_at),
  };
}

const invalid = (message: string, code = 'validation') => new AppError(400, message, code);

/** Bounded run log (lines + length); the last line says when lines were dropped. */
export class RunLog {
  readonly lines: string[] = [];
  private dropped = 0;

  add(line: string): void {
    const text = `${new Date().toISOString()} ${line}`.replace(/[\r\n]+/g, ' ').slice(0, MAX_LOG_LINE);
    if (this.lines.length >= MAX_LOG_LINES - 1) {
      this.dropped++;
      return;
    }
    this.lines.push(text);
  }

  toJSON(): string[] {
    return this.dropped > 0 ? [...this.lines, `… ${this.dropped} line(s) dropped`] : [...this.lines];
  }
}

// ── certificates of the export action ───────────────────────────────────────

/** Owner of a certificate (ACME row: its domain / site account; platform row: master tenant, no account). null = missing. */
export async function certificateOwner(cert: { kind: 'acme' | 'imported'; id: number }): Promise<(RowOwner & { names: string[]; label: string }) | null> {
  if (cert.kind === 'imported') {
    const r = await db('imported_certificates').where({ id: cert.id }).first('tenant_id', 'account_id', 'name', 'names') as
      { tenant_id: number; account_id: number; name: string; names: unknown } | undefined;
    if (!r) return null;
    return { tenantId: Number(r.tenant_id), accountId: Number(r.account_id), names: jsonValue<string[]>(r.names, []), label: r.name };
  }
  const r = await db('certificates as c').leftJoin('domains as d', 'd.id', 'c.domain_id').leftJoin('sites as s', 's.id', 'c.site_id').where('c.id', cert.id)
    .first('c.primary_name', 'c.names', 'd.tenant_id as d_tenant', 'd.account_id as d_account', 's.tenant_id as s_tenant', 's.account_id as s_account') as
    { primary_name: string; names: unknown; d_tenant: number | null; d_account: number | null; s_tenant: number | null; s_account: number | null } | undefined;
  if (!r) return null;
  const account = r.d_account ?? r.s_account;
  return {
    tenantId: Number(r.d_tenant ?? r.s_tenant ?? MASTER_TENANT_ID),
    accountId: account === null || account === undefined ? null : Number(account),
    names: jsonValue<string[]>(r.names, [r.primary_name]),
    label: r.primary_name,
  };
}

function readRegularFile(file: string): string {
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new SftpError('certificate files missing');
  return fs.readFileSync(file, 'utf8');
}

/** PEM material of a certificate (fullchain + private key). */
export async function certificateMaterial(cert: { kind: 'acme' | 'imported'; id: number }): Promise<{ fullchain: string; privkey: string; label: string }> {
  if (cert.kind === 'imported') {
    const r = await db('imported_certificates').where({ id: cert.id }).first('name', 'certificate_pem', 'chain_pem', 'private_key_sealed') as
      { name: string; certificate_pem: string; chain_pem: string | null; private_key_sealed: string } | undefined;
    if (!r) throw new SftpError('certificate missing');
    const fullchain = `${r.certificate_pem.trim()}\n${r.chain_pem ? `${r.chain_pem.trim()}\n` : ''}`;
    return { fullchain, privkey: open('proxy-cert', r.private_key_sealed), label: r.name };
  }
  const r = await db('certificates').where({ id: cert.id }).first('primary_name', 'status') as { primary_name: string; status: string } | undefined;
  if (!r) throw new SftpError('certificate missing');
  if (!/^[a-z0-9*][a-z0-9.*-]{0,252}$/i.test(r.primary_name) || r.primary_name.includes('..')) throw new SftpError('certificate missing');
  const dir = path.join(localPaths.edgeCerts(), r.primary_name);
  try {
    return { fullchain: readRegularFile(path.join(dir, 'fullchain.pem')), privkey: readRegularFile(path.join(dir, 'privkey.pem')), label: r.primary_name };
  } catch {
    throw new SftpError('certificate files missing (not issued yet?)');
  }
}

// ── validation of a workflow ─────────────────────────────────────────────────

const SERVICE_RE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;

async function checkActions(actor: HostingActor, owner: RowOwner, actions: WorkflowAction[]): Promise<WorkflowAction[]> {
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > MAX_ACTIONS) throw invalid(`A workflow has 1 … ${MAX_ACTIONS} actions`);
  const out: WorkflowAction[] = [];
  for (const a of actions) {
    if (a.kind === 'export-certificate') {
      if (!a.certificate || !a.sftpTargetId) throw invalid('export-certificate needs a certificate and an SFTP target');
      const certOwner = await certificateOwner(a.certificate);
      if (!certOwner || !sameOwner(certOwner, owner)) throw invalid('Certificate not found in this account');
      if (certOwner.accountId === null) {
        // Panel / preview wildcard keys: serving every tenant's preview hosts — platform admins only.
        if (!isPlatformAdmin(actor)) throw new AppError(403, 'Only a platform administrator may export a platform certificate', 'platformCertificateAdminOnly');
      } else {
        // Exporting a private key is a certificate right, not only a monitoring one (frozen contract).
        assertOwnedAccess(actor, certOwner, 'proxy.manage', 'Certificate');
      }
      const target = await loadOwned<SftpTargetRow>(actor, 'sftp_targets', a.sftpTargetId, 'read', 'SFTP target');
      if (!sameOwner(ownerOf(target), owner)) throw invalid('The SFTP target belongs to another account');
      try {
        remotePathUnder('.', a.remotePath ?? '');
      } catch {
        throw invalid('Invalid remote path (relative, without "..")');
      }
      out.push({
        kind: 'export-certificate', certificate: { kind: a.certificate.kind, id: a.certificate.id }, sftpTargetId: a.sftpTargetId,
        remotePath: a.remotePath ?? null, format: a.format === 'pem-bundle' ? 'pem-bundle' : 'pem-split',
      });
    } else if (a.kind === 'restart-app') {
      if (owner.accountId === null) throw invalid('restart-app needs a workflow of an account');
      if (!a.stackId) throw invalid('restart-app needs an application');
      const stack = await loadStack(actor, a.stackId, 'apps.manage');
      if (Number(stack.account_id) !== owner.accountId || Number(stack.tenant_id) !== owner.tenantId) throw invalid('The application belongs to another account');
      const services = [...new Set(a.services ?? [])];
      if (services.length > 50 || services.some((s) => typeof s !== 'string' || !SERVICE_RE.test(s))) throw invalid('Invalid service names');
      out.push({ kind: 'restart-app', stackId: a.stackId, services });
    } else {
      throw invalid('Unknown action');
    }
  }
  return out;
}

function checkTrigger(t: WorkflowTrigger): WorkflowTrigger {
  const problem = triggerProblem(t);
  if (problem) throw invalid(problem.message, problem.code);
  return normalizeTrigger(t);
}

async function assertWorkflowsEnabled(): Promise<void> {
  if (!(await platformSettings.section('monitoring')).workflowsEnabled) throw new AppError(409, 'Workflows are disabled on this platform', 'workflowsDisabled');
}

// ── runner ───────────────────────────────────────────────────────────────────

const running = new Set<Promise<void>>();

/** Claims the single-run slot. null when a (non-stale) run holds it. */
export async function claimWorkflow(id: number, now: Date = new Date()): Promise<WorkflowRow | null> {
  const rows = await db('workflows').where({ id })
    .andWhere((q) => q.whereNull('running_since').orWhere('running_since', '<', new Date(now.getTime() - STALE_RUN_MS)))
    .update({ running_since: now }).returning('*') as WorkflowRow[];
  return rows[0] ?? null;
}

/**
 * Releases the single-run slot ONLY if it still holds this run's claim: a run
 * whose claim went stale and was taken over never frees the newer run's slot.
 */
async function releaseClaim(w: WorkflowRow): Promise<void> {
  const q = db('workflows').where({ id: w.id });
  if (w.running_since !== null) q.andWhere('running_since', w.running_since instanceof Date ? w.running_since : new Date(w.running_since));
  await q.update({ running_since: null });
}

/** Module load = this panel process's start: anything claimed / running before it was cut by a restart. */
const bootAt = new Date();

/**
 * Worker start (single panel process): runs left 'running' by a restart are
 * closed as failed and their workflows released. Returns the runs closed. Never throws.
 */
export async function recoverInterruptedRuns(): Promise<number> {
  try {
    const line = JSON.stringify([`${new Date().toISOString()} Interrupted by a panel restart`]);
    const runs = await db('workflow_runs').where({ status: 'running' }).andWhere('started_at', '<', bootAt)
      .update({ status: 'failed', finished_at: new Date(), log: db.raw(`COALESCE(log, '[]'::jsonb) || ?::jsonb`, [line]) })
      .returning(['id', 'workflow_id']) as Array<{ id: number; workflow_id: number }>;
    const ids = [...new Set(runs.map((r) => Number(r.workflow_id)))];
    if (ids.length > 0) await db('workflows').whereIn('id', ids).update({ last_status: 'failed' });
    await db('workflows').whereNotNull('running_since').andWhere('running_since', '<', bootAt).update({ running_since: null });
    if (runs.length > 0) logger.warn({ runs: runs.length }, 'Workflow runs interrupted by a restart closed as failed');
    return runs.length;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'Interrupted workflow runs not recovered');
    return 0;
  }
}

async function exportCertificate(w: WorkflowRow, a: WorkflowAction, log: RunLog): Promise<void> {
  const owner = ownerOf(w);
  const certOwner = await certificateOwner(a.certificate!);
  if (!certOwner || !sameOwner(certOwner, owner)) throw new SftpError('certificate not found in this account');
  const target = await db('sftp_targets').where({ id: a.sftpTargetId }).first() as SftpTargetRow | undefined;
  if (!target || !sameOwner(ownerOf(target), owner)) throw new SftpError('SFTP target not found in this account');
  if (!target.host_key_fingerprint) throw new SftpError('SFTP target never tested: test it first to pin its host key');
  const material = await certificateMaterial(a.certificate!);
  const dir = remotePathUnder(target.base_path, a.remotePath ?? '');
  log.add(`Export of ${material.label} to ${target.name} (${dir}, ${a.format ?? 'pem-split'})`);
  let opened;
  try {
    opened = await openTargetSession(target);
  } catch (err) {
    if (err instanceof TargetRefusedError) throw new SftpError('destination refused');
    throw err;
  }
  const { session } = opened;
  try {
    await session.mkdirp(dir);
    const files = a.format === 'pem-bundle'
      ? [{ name: 'bundle.pem', data: `${material.privkey.trim()}\n${material.fullchain.trim()}\n` }]
      : [{ name: 'fullchain.pem', data: material.fullchain }, { name: 'privkey.pem', data: material.privkey }];
    for (const f of files) {
      await session.writeFile(remotePathUnder(target.base_path, a.remotePath ?? '', f.name), f.data, 0o600);
      log.add(`Written ${f.name} (0600)`);
    }
  } finally {
    session.close();
  }
}

async function restartApp(w: WorkflowRow, a: WorkflowAction, log: RunLog): Promise<void> {
  const stack = await db('app_stacks').where({ id: a.stackId }).first('id', 'tenant_id', 'account_id', 'name') as
    { id: number; tenant_id: number; account_id: number; name: string } | undefined;
  if (!stack || w.account_id === null || Number(stack.account_id) !== Number(w.account_id) || Number(stack.tenant_id) !== Number(w.tenant_id)) {
    throw new AppError(404, 'Application not found in this account', 'notFound');
  }
  const services = a.services && a.services.length > 0 ? a.services : null;
  log.add(`Restart of ${stack.name}${services ? ` (${services.join(', ')})` : ''}`);
  const { deploymentId } = await appsService.restartForWorkflow(Number(stack.id), services);
  log.add(`Restart requested (deployment ${deploymentId})`);
  // The run reports the outcome of the restart, not only its request (a failed restart = a failed run,
  // workflow.failed notified). Bounded: the deployment keeps running past the wait, the run then fails.
  const deadline = Date.now() + RESTART_WAIT_MS;
  for (;;) {
    const dep = await db('app_deployments').where({ id: deploymentId }).first('status', 'error') as
      { status: string; error: string | null } | undefined;
    if (!dep) throw new AppError(404, 'The restart deployment disappeared', 'notFound');
    if (dep.status === 'succeeded') { log.add(`Restart done (deployment ${deploymentId})`); return; }
    if (dep.status === 'failed' || dep.status === 'cancelled') {
      throw new AppError(409, `The restart failed (deployment ${deploymentId}, ${dep.status})`, 'restartFailed');
    }
    if (Date.now() > deadline) throw new AppError(409, `The restart is still running after ${Math.round(RESTART_WAIT_MS / 60_000)} min (deployment ${deploymentId})`, 'restartTimeout');
    await new Promise((r) => setTimeout(r, RESTART_POLL_MS));
  }
}

const SSH_NETWORK_CODES = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 2, 3]);

/**
 * Client-visible text of an action failure (run log + workflow.failed
 * notification, A6): only texts made for clients (AppError messages, the
 * generic SFTP texts); anything else is "action failed" (detail in the
 * server log only).
 */
export function actionErrorText(kind: WorkflowAction['kind'], err: unknown): string {
  if (err instanceof AppError) return err.statusCode === 501 ? 'not available yet' : err.statusCode >= 500 ? 'action failed' : err.message;
  if (kind === 'export-certificate') {
    const e = err as { level?: string; code?: string | number };
    if (err instanceof SftpError || err instanceof HostKeyMismatchError || err instanceof TargetRefusedError) return err instanceof TargetRefusedError ? 'destination refused' : sftpErrorText(err);
    if (typeof e?.level === 'string' && e.level.startsWith('client-')) return sftpErrorText(err);
    if (e?.code !== undefined && SSH_NETWORK_CODES.has(e.code)) return sftpErrorText(err);
  }
  return 'action failed';
}

async function execute(w: WorkflowRow, runId: number, log: RunLog): Promise<void> {
  const owner = ownerOf(w);
  let status: WorkflowRunStatus = 'succeeded';
  let failure: string | null = null;
  const actions = jsonValue<WorkflowAction[]>(w.actions, []);
  try {
    for (const [i, a] of actions.entries()) {
      try {
        if (a.kind === 'export-certificate') await exportCertificate(w, a, log);
        else if (a.kind === 'restart-app') await restartApp(w, a, log);
        else throw new Error('unknown action');
      } catch (err) {
        logger.warn({ err: (err as Error)?.message, workflowId: w.id, action: i + 1, kind: a.kind }, 'Workflow action failed');
        failure = `Action ${i + 1} (${a.kind}) failed: ${actionErrorText(a.kind, err)}`;
        log.add(failure);
        status = 'failed';
        break;
      }
    }
    if (status === 'succeeded') log.add('Done');
  } finally {
    const now = new Date();
    const trigger = jsonValue<WorkflowTrigger>(w.trigger, { kind: 'manual' });
    try {
      await db('workflow_runs').where({ id: runId }).update({ status, log: JSON.stringify(log.toJSON()), finished_at: now });
      await db('workflows').where({ id: w.id }).update({
        last_run_at: now, last_status: status,
        ...(trigger.kind === 'interval' || trigger.kind === 'cron' ? { next_run_at: nextRunAt(trigger, now) } : {}),
      });
      await releaseClaim(w);
      const old = await db('workflow_runs').where({ workflow_id: w.id }).orderBy('started_at', 'desc').offset(RUNS_KEPT).pluck('id') as number[];
      if (old.length > 0) await db('workflow_runs').whereIn('id', old).delete();
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, workflowId: w.id }, 'Workflow run not finalized');
    }
    emitMonitoring({ entity: 'workflowRun', id: runId, accountId: owner.accountId, action: 'updated' }, owner);
    emitMonitoring({ entity: 'workflow', id: Number(w.id), accountId: owner.accountId, action: 'status' }, owner);
    if (status === 'failed') {
      notify('workflow.failed', {
        tenantId: owner.tenantId,
        accountId: owner.accountId,
        key: `workflow:${w.id}:${runId}`,
        title: `Workflow « ${w.name} » en échec`,
        message: failure ?? 'Le workflow a échoué.',
        severity: 'warning',
        link: `/automation?tab=workflows&workflow=${w.id}`,
      });
    }
  }
}

/**
 * Starts a run of a claimed workflow (running_since set by claimWorkflow).
 * Returns the run row at once; the actions execute in the background.
 */
async function startRun(w: WorkflowRow, trigger: string): Promise<WorkflowRun> {
  const owner = ownerOf(w);
  const log = new RunLog();
  log.add(`Run started (${trigger})`);
  let run: RunRow;
  try {
    [run] = await db('workflow_runs').insert({ workflow_id: w.id, trigger: trigger.slice(0, 64), status: 'running', log: JSON.stringify(log.toJSON()) })
      .returning('*') as RunRow[];
  } catch (err) {
    await releaseClaim(w).catch(() => undefined);
    throw err;
  }
  emitMonitoring({ entity: 'workflowRun', id: Number(run.id), accountId: owner.accountId, action: 'created' }, owner);
  const p = execute(w, Number(run.id), log).catch((err) => logger.warn({ err: (err as Error)?.message, workflowId: w.id }, 'Workflow run crashed'));
  running.add(p);
  void p.finally(() => running.delete(p));
  return toRun(run);
}

/** Claims and runs (scheduler / cert-renewal). false when already running. Never throws. */
async function runIfFree(id: number, trigger: string): Promise<boolean> {
  try {
    const w = await claimWorkflow(id);
    if (!w) return false;
    await startRun(w, trigger);
    return true;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, workflowId: id }, 'Workflow run not started');
    return false;
  }
}

// ── scheduler + cert-renewal ─────────────────────────────────────────────────

/** One scheduler pass (interval / cron). Exported for tests. */
export async function workflowSchedulerTick(now: Date = new Date()): Promise<number> {
  if (!(await platformSettings.section('monitoring')).workflowsEnabled) return 0;
  const rows = await db('workflows').where({ enabled: true }).whereRaw(`trigger->>'kind' IN ('interval', 'cron')`)
    .andWhere((q) => q.whereNull('next_run_at').orWhere('next_run_at', '<=', now)).limit(200) as WorkflowRow[];
  let started = 0;
  for (const w of rows) {
    const trigger = jsonValue<WorkflowTrigger>(w.trigger, { kind: 'manual' });
    if (w.next_run_at === null) {
      // Never scheduled (created while the worker was off, settings restored…): schedule, do not run at once.
      await db('workflows').where({ id: w.id }).update({ next_run_at: nextRunAt(trigger, now) });
      continue;
    }
    // Next run set BEFORE the run: a long run is never re-triggered by the next pass.
    await db('workflows').where({ id: w.id }).update({ next_run_at: nextRunAt(trigger, now) });
    if (await runIfFree(Number(w.id), trigger.kind)) started++;
  }
  return started;
}

/** cert-renewal trigger: workflows of the certificate's owner whose names filter matches. Returns the runs started. */
export async function handleCertificateInstalled(primaryName: string, names: string[]): Promise<number> {
  if (!(await platformSettings.section('monitoring')).workflowsEnabled) return 0;
  const row = await db('certificates').where({ primary_name: primaryName }).first('id') as { id: number } | undefined;
  const owner = row ? await certificateOwner({ kind: 'acme', id: Number(row.id) }) : { tenantId: MASTER_TENANT_ID, accountId: null };
  if (!owner) return 0;
  const q = db('workflows').where({ enabled: true, tenant_id: owner.tenantId }).whereRaw(`trigger->>'kind' = 'cert-renewal'`);
  if (owner.accountId === null) q.whereNull('account_id');
  else q.where({ account_id: owner.accountId });
  const rows = await q as WorkflowRow[];
  const all = [...new Set([primaryName, ...names])];
  let started = 0;
  for (const w of rows) {
    const t = jsonValue<WorkflowTrigger>(w.trigger, { kind: 'manual' });
    if (!certificateMatches(t.certificateNames, all)) continue;
    if (await runIfFree(Number(w.id), `cert-renewal:${primaryName}`)) started++;
  }
  return started;
}

/** Tests / shutdown: resolves when every background run finished. */
export async function workflowRunsIdle(): Promise<void> {
  while (running.size > 0) await Promise.all([...running]);
}

// ── REST ─────────────────────────────────────────────────────────────────────

async function loadWorkflow(actor: HostingActor, id: number, need: 'read' | 'monitoring.manage'): Promise<WorkflowRow> {
  return loadOwned<WorkflowRow>(actor, 'workflows', id, need, 'Workflow');
}

export const workflowService = {
  async list(actor: HostingActor, filter: ListFilter): Promise<Workflow[]> {
    const rows = await scopeList(actor, db('workflows as w'), 'w', filter).select('w.*').orderBy('w.name') as WorkflowRow[];
    return rows.map(toWorkflow);
  },

  async get(actor: HostingActor, id: number): Promise<Workflow> {
    return toWorkflow(await loadWorkflow(actor, id, 'read'));
  },

  async create(req: Request, actor: HostingActor, body: WorkflowInput): Promise<Workflow> {
    await assertWorkflowsEnabled();
    const owner = await ownerForCreate(actor, body.accountId);
    const trigger = checkTrigger(body.trigger);
    const actions = await checkActions(actor, owner, body.actions);
    const row = await db.transaction(async (trx) => {
      await assertPlanRoom(trx, owner.accountId, 'maxWorkflows', 'workflows');
      const [r] = await trx('workflows').insert({
        tenant_id: owner.tenantId,
        account_id: owner.accountId,
        name: body.name,
        enabled: body.enabled ?? true,
        trigger: JSON.stringify(trigger),
        actions: JSON.stringify(actions),
        next_run_at: nextRunAt(trigger, new Date()),
      }).returning('*') as WorkflowRow[];
      return r;
    });
    emitMonitoring({ entity: 'workflow', id: Number(row.id), accountId: owner.accountId, action: 'created' }, owner);
    await auditService.logReqAs(req, owner.tenantId, 'automation.workflow.create', {
      resourceType: 'workflow', resourcePath: String(row.id), details: { name: body.name, accountId: owner.accountId, trigger: trigger.kind, actions: actions.map((a) => a.kind) },
    });
    return toWorkflow(row);
  },

  async update(req: Request, actor: HostingActor, id: number, body: WorkflowUpdate): Promise<Workflow> {
    const current = await loadWorkflow(actor, id, 'monitoring.manage');
    await assertWorkflowsEnabled();
    const owner = ownerOf(current);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.trigger !== undefined) {
      const trigger = checkTrigger(body.trigger);
      patch.trigger = JSON.stringify(trigger);
      patch.next_run_at = nextRunAt(trigger, new Date());
    }
    if (body.actions !== undefined) patch.actions = JSON.stringify(await checkActions(actor, owner, body.actions));
    const [row] = await db('workflows').where({ id: current.id }).update(patch).returning('*') as WorkflowRow[];
    emitMonitoring({ entity: 'workflow', id: Number(row.id), accountId: owner.accountId, action: 'updated' }, owner);
    await auditService.logReqAs(req, owner.tenantId, 'automation.workflow.update', {
      resourceType: 'workflow', resourcePath: String(row.id), details: { fields: Object.keys(body) },
    });
    return toWorkflow(row);
  },

  async remove(req: Request, actor: HostingActor, id: number): Promise<void> {
    const current = await loadWorkflow(actor, id, 'monitoring.manage');
    const owner = ownerOf(current);
    await db('workflows').where({ id: current.id }).delete();
    emitMonitoring({ entity: 'workflow', id: Number(current.id), accountId: owner.accountId, action: 'deleted' }, owner);
    await auditService.logReqAs(req, owner.tenantId, 'automation.workflow.delete', {
      resourceType: 'workflow', resourcePath: String(current.id), details: { name: current.name },
    });
  },

  async run(req: Request, actor: HostingActor, id: number): Promise<WorkflowRun> {
    const current = await loadWorkflow(actor, id, 'monitoring.manage');
    await assertWorkflowsEnabled();
    const w = await claimWorkflow(Number(current.id));
    if (!w) throw new AppError(409, 'This workflow is already running', 'workflowRunning');
    const run = await startRun(w, 'manual');
    await auditService.logReqAs(req, Number(current.tenant_id), 'automation.workflow.run', {
      resourceType: 'workflow', resourcePath: String(current.id), details: { runId: run.id },
    });
    return run;
  },

  async runs(actor: HostingActor, id: number, limit: number, offset: number): Promise<{ items: WorkflowRun[]; total: number }> {
    const w = await loadWorkflow(actor, id, 'read');
    const [items, total] = await Promise.all([
      db('workflow_runs').where({ workflow_id: w.id }).orderBy('started_at', 'desc').orderBy('id', 'desc').limit(limit).offset(offset) as Promise<RunRow[]>,
      db('workflow_runs').where({ workflow_id: w.id }).count<{ count: string }[]>('* as count').first(),
    ]);
    return { items: items.map(toRun), total: Number(total?.count ?? 0) };
  },
};
