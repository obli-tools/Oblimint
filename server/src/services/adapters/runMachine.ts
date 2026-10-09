import type {
  AdapterAction, AdapterId, AdapterRunOptions, AdapterRunStatus, AdapterUpdate, AppProfileId, DbSnapshot, PlanLimits, Release, ReleaseLogLine, ReleaseStatus,
} from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { errText } from '../setup/docker';
import {
  localContentTree, type AnalysisDataPath, type CandidateCommit, type ChangedPath, type ChangeAnalysis, type ChecksumVerification, type ContentTree,
} from '../maintenance/contracts';
import { AdapterStepError, safeDocroot, type ToolsAdapter, type ToolsAdapterContext, type ToolsStepResult } from './common';
import type { AdapterDeps } from './deps';
import { adapterFor } from './registry';
import { toolsContainerSpec, toolsDbNetwork } from './toolsSpec';

// ─────────────────────────────────────────────────────────────────────────────
// The state machine of one adapter run (docs/P3-PLAN.md §11), in the
// background, every external effect through AdapterDeps:
//
//   queued → preparing   (update: DB snapshots; hostd.ensureWorkspace(current release))
//          → running     (detection on the COPY; listUpdates; update: apply in the copy)
//          → analyzing   (commitWorkTree → candidate; nothing ⇒ no_changes;
//                         scan.analyze + checksums.verify; blocked ⇒ failed riskBlocked + scan.threat)
//          → publishing  (publishCommit trigger adapter → wait until the release settles;
//                         awaiting_approval ⇒ final awaiting_approval, DEFERRED: workspace,
//                         candidate ref and snapshots kept, continueApprovedRun() runs
//                         post_deploy + healthcheck + staging reflection once approved)
//          → post_deploy (postDeploy, workspace read-only, unless runMigrations === false)
//          → healthcheck → succeeded (staging reflected)
//   failure before publication ⇒ failed (code untouched; the databases restored
//     from the snapshots when apply() wrote them — Nextcloud `occ app:update`);
//   failure after publication  ⇒ revertTo(base) — only while the run's release
//     is still the live one — + snapshot restore when a migration ran ⇒ rolled_back.
// Always: tools containers removed; workspace removed, snapshots released and
// candidate ref dropped unless the run is deferred; one ADAPTER_RUN_UPDATED per
// status, French log lines (raw causes flagged for A6), output ≤ 64 KiB.
// ─────────────────────────────────────────────────────────────────────────────

/** adapter_runs.output cap (bytes). */
export const RUN_OUTPUT_CAP = 64 * 1024;
const LOG_CAP = 500;
export const INTERRUPTED_ERROR = 'interrompu par un redémarrage';
/** Release statuses of a pipeline still at work. */
const RELEASE_IN_FLIGHT: readonly ReleaseStatus[] = ['queued', 'scanning', 'publishing'];
/** publishWaitMs rounds a run waits for its release before giving up (the pipeline always settles; 8 × 45 min by default). */
export const MAX_RELEASE_WAIT_ROUNDS = 8;
const WAIT_ERRORS_MAX = 5;

/** Everything a run needs, loaded by the service before it starts (no DB access in the machine). */
export interface RunJob {
  runId: number;
  adapter: AdapterId;
  action: AdapterAction;
  trigger: 'manual' | 'scheduled';
  options: AdapterRunOptions;
  createdBy: number | null;
  site: {
    id: number; tenantId: number; accountId: number; name: string; slug: string; docroot: string;
    appProfile: AppProfileId | null; healthcheckPath: string; php: string;
  };
  account: { id: number; nodeId: number; uid: number; gid: number; limits: Pick<PlanLimits, 'memoryMb' | 'cpuCores'> };
  base: { releaseId: number; number: number; commit: string };
  dataPaths: AnalysisDataPath[];
  /** workspaceLocal: as this process sees it (ContentTree, git); the others: Docker host paths. */
  paths: { workspaceLocal: string; workspaceHost: string; dataHost: string; dbSockets: { root: string; mysql: string; postgresql: string } };
  settings: { stepTimeoutMs: number; memoryMb: number };
}

export interface RunOutcome {
  status: AdapterRunStatus;
  error: string | null;
  resultReleaseId: number | null;
}

/** French label of an expected refusal / failure; the raw cause stays after " : " (staff only, A6). */
const CODE_LABELS: Record<string, string> = {
  publishInProgress: 'une publication est déjà en cours',
  windowActive: 'une fenêtre de modification est active',
  windowBaseChanged: 'la release de base n\'est plus en ligne',
  releaseSuperseded: 'la release de base n\'est plus en ligne',
  toolsImageMissing: 'image d\'outils indisponible',
  adapterNotDetected: 'application non détectée',
  riskBlocked: 'risque trop élevé : publication bloquée',
  notImplemented: 'fonction pas encore disponible',
  hostdUnavailable: 'hôte injoignable',
  nodeNotSupported: 'nœud non pris en charge',
  siteDeleting: 'site en cours de suppression',
  accountDeleting: 'compte en cours de suppression',
  adapterBusy: 'un autre run de l\'adaptateur est en cours ou attend l\'approbation de sa release',
  scheduleAuthorRevoked: 'l\'auteur de la planification n\'a plus le droit de publier sur ce site',
};

/** Text of a failure: "<label> : <cause>" (the label alone for an AppError with a known code). */
export function failureText(prefix: string, err: unknown): string {
  if (err instanceof AdapterStepError) return `${prefix} : ${err.message}`;
  const code = (err as { code?: string } | null)?.code;
  if (code && CODE_LABELS[code]) {
    const label = CODE_LABELS[code];
    return err instanceof AppError && err.statusCode < 500 ? `${prefix} : ${label}` : `${prefix} : ${label} : ${errText(err)}`;
  }
  return `${prefix} : erreur interne : ${errText(err)}`;
}

function shellQuote(a: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

/**
 * A run log line. `raw`: the message carries a raw cause after " : " (Docker,
 * hostd, CLI tail, host paths) — a client gets its labels only (A6, rows.ts).
 * Lines without it are the machine's own French text, shown as written.
 */
export interface RunLogLine extends ReleaseLogLine {
  raw?: true;
}

/** Changed paths kept in adapter_runs.analysis while a release awaits approval (staging reflection of the continuation). */
export const PENDING_REFLECT_KEY = 'pendingReflect';
type PendingReflect = Array<[string, ChangedPath['change'], ChangedPath['type']]>;

export function encodePendingReflect(changes: ChangedPath[]): PendingReflect {
  return changes.filter((c) => !c.ignored).map((c) => [c.path, c.change, c.type]);
}

export function decodePendingReflect(v: unknown): ChangedPath[] {
  if (!Array.isArray(v)) return [];
  const out: ChangedPath[] = [];
  for (const e of v) {
    if (!Array.isArray(e) || typeof e[0] !== 'string') continue;
    const change = e[1] === 'added' || e[1] === 'deleted' ? e[1] : 'modified';
    const type = e[2] === 'symlink' || e[2] === 'dir' ? e[2] : 'file';
    out.push({ path: e[0], change, type, size: null });
  }
  return out;
}

/** Log, output and status of a run, persisted through deps.saveRun. */
class RunRecord {
  readonly log: RunLogLine[];
  output: string;
  outputTruncated: boolean;
  status: AdapterRunStatus = 'queued';

  constructor(private readonly job: RunJob, private readonly deps: AdapterDeps, resume?: { log: RunLogLine[]; output: string | null; outputTruncated: boolean }) {
    this.log = resume ? [...resume.log] : [];
    this.output = resume?.output ?? '';
    this.outputTruncated = resume?.outputTruncated ?? false;
  }

  line(level: ReleaseLogLine['level'], message: string, raw = false): void {
    if (this.log.length >= LOG_CAP) return;
    this.log.push({ at: new Date().toISOString(), level, message: message.slice(0, 2000), ...(raw ? { raw: true as const } : {}) });
  }

  addOutput(argv: string[], r: ToolsStepResult): void {
    if (this.outputTruncated) return;
    const block = `$ ${argv.map(shellQuote).join(' ')}\n${r.output}${r.output.endsWith('\n') || !r.output ? '' : '\n'}${r.outputTruncated ? '…[sortie tronquée]\n' : ''}`
      + (r.timedOut ? '[délai dépassé]\n' : r.exitCode !== 0 ? `[code de sortie ${r.exitCode ?? '?'}]\n` : '');
    const room = RUN_OUTPUT_CAP - Buffer.byteLength(this.output);
    if (Buffer.byteLength(block) <= room) {
      this.output += block;
    } else {
      this.output += Buffer.from(block).subarray(0, Math.max(0, room)).toString('utf8').replace(/�+$/, '');
      this.outputTruncated = true;
    }
  }

  async save(patch: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.deps.saveRun(this.job.runId, {
        ...patch, log: JSON.stringify(this.log), output: this.output || null, output_truncated: this.outputTruncated,
      });
    } catch (err) {
      logger.warn({ err, runId: this.job.runId }, 'Adapters: cannot save the run');
    }
  }

  async setStatus(status: AdapterRunStatus, patch: Record<string, unknown> = {}): Promise<void> {
    this.status = status;
    await this.save({ status, ...patch });
    this.deps.emitRun({ tenantId: this.job.site.tenantId, accountId: this.job.site.accountId }, { siteId: this.job.site.id, runId: this.job.runId, status });
  }
}

/** ChangedPath list of a candidate commit, typed from the workspace (R1: ContentTree, never a followed link). */
export async function changedPathsOf(tree: ContentTree, cand: CandidateCommit): Promise<ChangedPath[]> {
  const out: ChangedPath[] = [];
  for (const f of cand.files) {
    if (f.change === 'deleted') {
      out.push({ path: f.path, change: 'deleted', type: 'file', size: null });
      continue;
    }
    const st = await tree.stat(f.path);
    const type = st?.type === 'symlink' ? 'symlink' : st?.type === 'dir' ? 'dir' : 'file';
    out.push({ path: f.path, change: f.change, type, size: st?.type === 'file' ? st.size : null, mode: st?.mode ?? null });
  }
  for (const i of cand.ignored) out.push({ path: i.path, change: 'modified', type: 'file', size: null, ignored: i.reason });
  return out;
}

/** "WordPress 6.6.2, akismet 5.3.3, …" (≤ 400 characters). */
export function updatesSummary(updates: AdapterUpdate[]): string {
  const parts = updates.map((u) => (u.newVersion ? `${u.name} ${u.newVersion}` : u.name));
  let s = parts.join(', ');
  if (s.length > 400) s = `${s.slice(0, 397)}…`;
  return s;
}

function snapshotIdsReady(snaps: DbSnapshot[]): number[] {
  return snaps.filter((s) => s.status === 'ready').map((s) => s.id);
}

// ── shared run environment ───────────────────────────────────────────────────

interface RunEnv {
  job: RunJob;
  deps: AdapterDeps;
  rec: RunRecord;
  adapter: ToolsAdapter;
  ctx: ToolsAdapterContext;
  phase: { postDeploy: boolean };
  /** Ready snapshots of the run (restore targets). */
  snapshotIds: number[];
  /** The live databases may differ from the snapshots because of this run (apply wrote them, or a migration ran). */
  dbTouched: boolean;
}

function createEnv(job: RunJob, deps: AdapterDeps, rec: RunRecord): RunEnv {
  const phase = { postDeploy: false };
  const ctx: ToolsAdapterContext = {
    siteId: job.site.id,
    accountId: job.account.id,
    runId: job.runId,
    action: job.action,
    options: job.options,
    workspace: localContentTree(job.paths.workspaceLocal),
    docroot: safeDocroot(job.site.docroot),
    log: (level, message) => rec.line(level, message),
    exec: async (step, argv, opts) => {
      const readOnly = job.action === 'check' || phase.postDeploy || opts?.workspaceReadOnly === true;
      const spec = toolsContainerSpec({
        runId: job.runId, step: step.toLowerCase(), accountId: job.account.id, siteId: job.site.id, uid: job.account.uid, gid: job.account.gid,
        php: job.site.php, workspaceDir: job.paths.workspaceHost, dataDir: job.paths.dataHost, dbSockets: job.paths.dbSockets,
        workspaceReadOnly: readOnly, argv, env: opts?.env, memoryMb: job.settings.memoryMb, limits: job.account.limits,
      });
      const timeoutMs = Math.min(job.settings.stepTimeoutMs, opts?.timeoutMs ?? job.settings.stepTimeoutMs);
      const started = Date.now();
      const r = await deps.runTools(job.account.nodeId, spec, {
        // Runner lines may carry a raw Docker message (network not attached…): flagged for A6.
        timeoutMs, extraNetwork: toolsDbNetwork(job.account.id), log: (line) => rec.line('info', line, true),
      });
      rec.addOutput(argv, r);
      const secs = Math.round((Date.now() - started) / 1000);
      rec.line(r.ok ? 'info' : 'warn', `${argv.slice(0, 3).join(' ')} : ${r.timedOut ? 'délai dépassé' : `code ${r.exitCode ?? '?'}`} (${secs} s)`);
      await rec.save();
      return r;
    },
  };
  return { job, deps, rec, adapter: adapterFor(job.adapter), ctx, phase, snapshotIds: [], dbTouched: false };
}

/** Restores the run's ready snapshots (logged). */
async function restoreDatabases(env: RunEnv, why: string): Promise<{ restored: number; failed: number }> {
  const { job, deps, rec } = env;
  const ids = env.snapshotIds;
  if (ids.length === 0) {
    rec.line('info', 'aucun cliché de base à restaurer');
    return { restored: 0, failed: 0 };
  }
  try {
    const r = await deps.restoreSnapshots(ids, { userId: job.createdBy, reason: `adaptateur ${job.adapter} #${job.runId} : ${why}` });
    for (const f of r.failed) rec.line('error', `restauration du cliché ${f.id} en échec : ${f.error}`, true);
    if (r.restored > 0) rec.line('info', `${r.restored} base(s) restaurée(s) depuis les clichés`);
    if (r.failed.length === 0) env.dbTouched = false;
    return { restored: r.restored, failed: r.failed.length };
  } catch (err) {
    rec.line('error', failureText('restauration des bases impossible', err), true);
    return { restored: 0, failed: ids.length };
  }
}

/**
 * After publication: code back to the base release — only while the run's
 * release is still the live one (a newer release published meanwhile is
 * never reverted) — then the databases from the snapshots when the run
 * touched them (a migration ran, or apply wrote them).
 */
async function rollback(env: RunEnv, published: Release, reason: string): Promise<RunOutcome> {
  const { job, deps, rec } = env;
  rec.line('error', reason, true);
  let current: number | null | undefined;
  try {
    current = await deps.currentReleaseId(job.site.id);
  } catch (err) {
    current = undefined; // unknown: revert as before (the run's release was live a moment ago)
    rec.line('warn', failureText('release en ligne illisible', err), true);
  }
  const auditBase = {
    siteId: job.site.id, accountId: job.account.id, runId: job.runId, adapter: job.adapter, reason,
    baseReleaseId: job.base.releaseId, failedReleaseId: published.id,
  };
  if (current !== undefined && current !== published.id) {
    rec.line('warn', `retour arrière non effectué : la release #${published.number} n'est plus en ligne (une autre release a été publiée depuis)`);
    if (env.dbTouched && env.snapshotIds.length) {
      rec.line('warn', `bases non restaurées : clichés ${env.snapshotIds.join(', ')} disponibles pour une restauration manuelle`);
    }
    await deps.audit({
      tenantId: job.site.tenantId, userId: job.createdBy, action: 'adapter.rollback', resourceType: 'site', resourcePath: String(job.site.id),
      details: { ...auditBase, skipped: 'releaseSuperseded', currentReleaseId: current, codeRestored: false, databasesRestored: 0, databasesFailed: 0 },
    }).catch(() => {});
    return { status: 'failed', error: `${reason} — retour arrière non effectué : une release plus récente est en ligne`, resultReleaseId: published.id };
  }

  rec.line('info', `retour arrière : release #${job.base.number}`);
  let codeOk = true;
  try {
    await deps.revertTo(job.site.id, job.base.releaseId, `adaptateur ${job.adapter} #${job.runId} : ${reason}`);
    rec.line('info', `release #${job.base.number} remise en ligne`);
  } catch (err) {
    codeOk = false;
    rec.line('error', failureText(`retour à la release #${job.base.number} impossible`, err), true);
  }
  let db = { restored: 0, failed: 0 };
  if (env.dbTouched) {
    db = await restoreDatabases(env, 'retour arrière');
  } else {
    // Restoring would drop every live write since the snapshot for nothing.
    rec.line('info', 'bases non restaurées : la mise à jour ne les a pas modifiées');
  }
  await deps.audit({
    tenantId: job.site.tenantId, userId: job.createdBy, action: 'adapter.rollback', resourceType: 'site', resourcePath: String(job.site.id),
    details: { ...auditBase, codeRestored: codeOk, databasesRestored: db.restored, databasesFailed: db.failed },
  }).catch(() => {});
  return {
    status: codeOk ? 'rolled_back' : 'failed',
    error: codeOk && db.failed === 0 ? reason : `${reason} — retour arrière incomplet`,
    resultReleaseId: published.id,
  };
}

/** The run's release is live: migrations, healthcheck, staging reflection (or the rollback). */
async function afterPublication(env: RunEnv, published: Release, changes: ChangedPath[]): Promise<RunOutcome> {
  const { job, deps, rec, adapter, ctx } = env;
  rec.line('info', `release #${published.number} en ligne`);

  // ── post_deploy ──────────────────────────────────────────────────────────
  if (adapter.postDeploy && job.options.runMigrations !== false) {
    await rec.setStatus('post_deploy');
    env.phase.postDeploy = true;
    env.dbTouched = true;
    let r;
    try {
      r = await adapter.postDeploy(ctx);
    } catch (err) {
      return rollback(env, published, failureText('migrations de base en échec', err));
    }
    if (!r.ok) return rollback(env, published, failureText('migrations de base en échec', new AdapterStepError('migrations', r)));
    rec.line('info', 'migrations de base terminées');
  } else if (adapter.postDeploy) {
    rec.line('warn', 'migrations de base non lancées (option)');
  }

  // ── healthcheck ──────────────────────────────────────────────────────────
  const hc = await deps.healthcheck({ id: job.site.id, healthcheck_path: job.site.healthcheckPath }).catch((err) => `contrôle impossible : ${errText(err)}`);
  if (hc) return rollback(env, published, `contrôle HTTP en échec après la mise à jour : ${hc}`);
  rec.line('info', 'contrôle HTTP OK');

  // Staging reflects the release (the client sees the new files in SFTP;
  // an automatic publication of the staging would otherwise revert the update).
  const current = await deps.currentReleaseId(job.site.id).catch(() => published.id);
  if (current !== published.id) rec.line('warn', `une autre release a été publiée pendant la mise à jour : la release #${published.number} n'est plus en ligne`);
  try {
    const r = await deps.reflectToStaging(job.site.id, { kind: 'workspace', workspaceId: job.runId }, changes.filter((c) => !c.ignored));
    rec.line(r.conflicts.length ? 'warn' : 'info', `staging : ${r.written} écrit(s), ${r.deleted} supprimé(s)`
      + (r.conflicts.length ? `, ${r.conflicts.length} conflit(s) : ${r.conflicts.slice(0, 10).join(', ')}` : ''));
  } catch (err) {
    rec.line('warn', failureText('reflet dans le staging en échec (la release en ligne est à jour)', err), true);
  }
  return { status: 'succeeded', error: null, resultReleaseId: published.id };
}

/** Waits until the release leaves the pipeline (several publishWaitMs rounds; null: still in flight at the end). */
async function waitSettled(env: RunEnv, release: Release): Promise<Release | null> {
  const { job, deps, rec } = env;
  let errors = 0;
  for (let round = 1; round <= MAX_RELEASE_WAIT_ROUNDS; round++) {
    let r: Release;
    try {
      r = await deps.waitForRelease(job.site.id, release.id, deps.publishWaitMs);
    } catch (err) {
      if (++errors >= WAIT_ERRORS_MAX) throw err;
      rec.line('warn', failureText('suivi de la publication impossible (nouvel essai)', err), true);
      await new Promise((res) => setTimeout(res, Math.min(30_000, deps.publishWaitMs)));
      continue;
    }
    if (!RELEASE_IN_FLIGHT.includes(r.status)) return r;
    if (round < MAX_RELEASE_WAIT_ROUNDS) {
      rec.line('warn', `release #${r.number} toujours en cours de publication (${r.status}) : attente prolongée`);
      await rec.save();
    }
  }
  return null;
}

// ── a run ────────────────────────────────────────────────────────────────────

/**
 * Runs the whole machine. Never throws: every failure ends in a final
 * status, persisted and announced. Returns the outcome (tests, logs).
 */
export async function executeRun(job: RunJob, deps: AdapterDeps): Promise<RunOutcome> {
  const rec = new RunRecord(job, deps);
  const env = createEnv(job, deps, rec);
  const { adapter, ctx } = env;
  const workspace = ctx.workspace;
  const isUpdate = job.action === 'update';
  const hostdSpec = hostdSpecOf(job);
  const refName = candidateRefName(job.runId);

  // Assigned inside steps(): declared with assertions so that no narrowing survives the closure.
  let workspaceAttempted = false as boolean;
  let candidate = null as CandidateCommit | null;
  let changes: ChangedPath[] = [];
  let published = null as Release | null;
  /** Release still in the pipeline when the run gave up: its ref stays. */
  let releaseUnsettled = false as boolean;
  /** The release awaits approval: workspace, ref and snapshots kept for continueApprovedRun. */
  let deferred = false as boolean;
  let summaryForDefer = null as Record<string, unknown> | null;
  let outcome: RunOutcome = { status: 'failed', error: null, resultReleaseId: null };
  const fail = (error: string): RunOutcome => ({ status: 'failed', error, resultReleaseId: published?.id ?? null });

  const steps = async (): Promise<RunOutcome> => {
    // ── preparing ────────────────────────────────────────────────────────────
    await rec.setStatus('preparing', { started_at: new Date() });
    rec.line('info', `${adapter.label} : ${isUpdate ? 'mise à jour' : 'vérification'} sur une copie de la release #${job.base.number}`);
    if (isUpdate) {
      let snapshots: DbSnapshot[];
      try {
        snapshots = await deps.createSnapshots(job.site.id, { reason: 'adapter', adapterRunId: job.runId, userId: job.createdBy });
      } catch (err) {
        return fail(failureText('clichés des bases impossibles : mise à jour annulée', err));
      }
      const failedSnaps = snapshots.filter((s) => s.status !== 'ready');
      if (failedSnaps.length > 0) {
        // The run promises a database rollback: without every snapshot it does not start.
        return fail(`clichés des bases en échec (${failedSnaps.map((s) => s.databaseName).join(', ')}) : mise à jour annulée`);
      }
      env.snapshotIds = snapshotIdsReady(snapshots);
      rec.line('info', snapshots.length ? `${snapshots.length} cliché(s) de base pris` : 'aucune base à protéger');
    }
    try {
      // Attempted ⇒ always removed (hostd may have started copying before a failure / timeout).
      workspaceAttempted = true;
      const ws = await deps.ensureWorkspace(job.account.nodeId, { ...hostdSpec, workspaceId: job.runId, releaseNumber: job.base.number });
      rec.line('info', `copie de travail prête (${ws.files} fichiers)`);
    } catch (err) {
      return fail(failureText('copie de la release impossible', err));
    }

    // ── running ──────────────────────────────────────────────────────────────
    await rec.setStatus('running');
    const detected = await adapter.detectIn(workspace, ctx.docroot);
    if (!detected.detected) return fail(`application non détectée${detected.detail ? ` : ${detected.detail}` : ''}`);
    let available: AdapterUpdate[];
    try {
      available = await adapter.listUpdates(ctx);
    } catch (err) {
      return fail(failureText('liste des mises à jour impossible', err));
    }
    rec.line('info', available.length ? `${available.length} mise(s) à jour disponible(s)` : 'aucune mise à jour disponible');

    if (!isUpdate) {
      await rec.save({ updates: JSON.stringify(available) });
      return { status: 'succeeded', error: null, resultReleaseId: null };
    }
    if (available.length === 0 && !adapter.applyWithoutUpdates?.(job.options)) {
      await rec.save({ updates: JSON.stringify([]) });
      return { status: 'no_changes', error: null, resultReleaseId: null };
    }
    let applied: AdapterUpdate[];
    // Nextcloud: `occ app:update` migrates the live database as it goes (even when it fails half-way).
    env.dbTouched = adapter.applyTouchesDatabase === true;
    try {
      applied = await adapter.apply(ctx, available);
    } catch (err) {
      return fail(failureText('mise à jour en échec', err));
    }
    if (applied.length === 0) env.dbTouched = false; // nothing ran against the database
    await rec.save({ updates: JSON.stringify(applied) });
    if (applied.length === 0 && available.length > 0) rec.line('info', 'aucune mise à jour ne correspond aux options');

    // ── analyzing ────────────────────────────────────────────────────────────
    await rec.setStatus('analyzing');
    try {
      candidate = await deps.commitWorkTree({
        siteId: job.site.id,
        baseCommit: job.base.commit,
        workTree: job.paths.workspaceLocal,
        message: `Adaptateur ${adapter.label} #${job.runId}${applied.length ? ` : ${updatesSummary(applied)}` : ''}`,
        author: { name: `adapter ${job.adapter} #${job.runId}`, email: `adapter-${job.runId}@oblimint.local` },
        refName,
      });
    } catch (err) {
      return fail(failureText('commit candidat impossible', err));
    }
    await rec.save({ candidate_commit: candidate.commit });
    if (candidate.files.length === 0) {
      rec.line('info', 'aucun fichier modifié');
      return { status: 'no_changes', error: null, resultReleaseId: null };
    }
    rec.line('info', `candidat ${candidate.commit.slice(0, 12)} : +${candidate.added} ~${candidate.modified} -${candidate.deleted}`
      + (candidate.ignored.length ? ` (${candidate.ignored.length} chemin(s) ignoré(s))` : ''));
    changes = await changedPathsOf(workspace, candidate);

    let analysis: ChangeAnalysis;
    try {
      analysis = await deps.analyze({
        origin: 'adapter', siteId: job.site.id, accountId: job.account.id, appProfile: job.site.appProfile, tree: workspace, files: changes, dataPaths: job.dataPaths,
      });
    } catch (err) {
      return fail(failureText('analyse des changements impossible', err));
    }
    let checksums: ChecksumVerification | null = null;
    try {
      checksums = await deps.verifyChecksums({ siteId: job.site.id, appProfile: job.site.appProfile, tree: workspace, files: changes });
    } catch (err) {
      rec.line('warn', failureText('sommes de contrôle indisponibles', err), true);
    }
    const sum = analysis.summary;
    summaryForDefer = sum as unknown as Record<string, unknown>;
    await rec.save({
      counts: JSON.stringify(sum.counts), risk_score: sum.risk.score, risk_level: sum.risk.level,
      analysis: JSON.stringify(sum), checksums: checksums ? JSON.stringify(checksums.report) : null,
    });
    rec.line(sum.blocked ? 'error' : 'info', `analyse : ${sum.verdict}, risque ${sum.risk.score} (${sum.risk.level}), ${sum.findings} détection(s)`
      + (sum.scannerUnavailable ? ', scanner indisponible' : ''));
    if (checksums && checksums.report.filesMismatched > 0) rec.line('warn', `${checksums.report.filesMismatched} fichier(s) différent(s) des sommes officielles`);
    if (sum.blocked) {
      deps.notify('scan.threat', {
        tenantId: job.site.tenantId, accountId: job.account.id, key: `adapter:${job.runId}`, severity: 'critical',
        title: `Menace détectée : ${job.site.name}`,
        message: `La mise à jour ${adapter.label} #${job.runId} du site ${job.site.name} présente un risque ${sum.risk.score}/100 : elle n'est pas publiée.`,
        link: `/sites/${job.site.id}?tab=maintenance`,
      });
      return fail(`risque trop élevé (${sum.risk.score}/100) : publication bloquée`);
    }

    // ── publishing ───────────────────────────────────────────────────────────
    await rec.setStatus('publishing');
    // Fails closed: an unreadable window state never lets the publication through (§5.3).
    if (await deps.blocksPublish(job.site.id).catch(() => true)) return fail('une fenêtre de modification est active : publication annulée');
    let release: Release;
    try {
      release = await deps.publishCommit(job.site.id, {
        commitSha: candidate.commit, baseReleaseId: job.base.releaseId, trigger: 'adapter', adapterRunId: job.runId,
        userId: job.createdBy, message: `Adaptateur ${adapter.label} #${job.runId} : ${updatesSummary(applied) || 'mise à jour'}`,
        scan: analysis.scan, approvedBy: null,
      });
    } catch (err) {
      return fail(failureText('publication refusée', err));
    }
    await rec.save({ result_release_id: release.id });
    rec.line('info', `release #${release.number} en cours de publication`);
    const final = await waitSettled(env, release);
    if (final === null) {
      // The release may still go live: its ref stays; the staff checks it (no migration, staging not reflected).
      releaseUnsettled = true;
      return {
        status: 'failed',
        error: `la release #${release.number} est toujours en cours de publication après ${Math.round((MAX_RELEASE_WAIT_ROUNDS * deps.publishWaitMs) / 60_000)} min : à vérifier (migrations de base non lancées)`,
        resultReleaseId: release.id,
      };
    }
    if (final.status === 'awaiting_approval') {
      deferred = true;
      rec.line('warn', `release #${final.number} en attente d'approbation : migrations de base et reflet dans le staging après l'approbation`);
      return { status: 'awaiting_approval', error: null, resultReleaseId: final.id };
    }
    if (final.status !== 'ready') {
      // The pipeline already rolled the code back (healthcheck) or never switched; no migration ran.
      return fail(`la publication de la release #${final.number} a échoué${final.error ? ` : ${final.error}` : ''}`);
    }
    published = final;
    return afterPublication(env, final, changes);
  };

  try {
    outcome = await steps();
  } catch (err) {
    // Unexpected (a dependency threw where nothing else caught it).
    logger.error({ err, runId: job.runId }, 'Adapters: run failed');
    outcome = published ? await rollback(env, published, failureText('erreur inattendue', err)) : fail(failureText('erreur inattendue', err));
  }

  // Exit before publication after apply() wrote the live databases (Nextcloud):
  // the live code is still the base release, the databases go back to match it.
  if (!published && env.dbTouched && (outcome.status === 'failed' || outcome.status === 'awaiting_approval')) {
    rec.line('warn', 'la mise à jour a modifié les bases en ligne avant publication : restauration des clichés');
    const r = await restoreDatabases(env, outcome.status === 'awaiting_approval' ? 'release en attente d\'approbation' : 'échec avant publication');
    if (r.failed > 0) {
      const note = 'bases non restaurées après une mise à jour non publiée';
      outcome = { ...outcome, error: outcome.error ? `${outcome.error} — ${note}` : note };
    }
  }

  if (deferred && summaryForDefer) {
    await rec.save({ analysis: JSON.stringify({ ...summaryForDefer, [PENDING_REFLECT_KEY]: encodePendingReflect(changes) }) });
  }
  await finish(env, outcome, {
    removeWorkspace: workspaceAttempted && !deferred,
    hostdSpec,
    refName,
    keepRef: deferred || releaseUnsettled || !candidate,
    keepSnapshots: deferred,
  });
  return outcome;
}

// ── continuation of a run whose release was approved ─────────────────────────

export interface ApprovedRunState {
  /** The run's release, now ready. */
  release: Release;
  log: RunLogLine[];
  output: string | null;
  outputTruncated: boolean;
  /** adapter_runs.analysis as stored at the deferral (summary + pendingReflect). */
  analysis: Record<string, unknown> | null;
}

/**
 * A deferred run (release awaiting approval) whose release became ready:
 * post_deploy (migrations) + healthcheck + staging reflection from the kept
 * workspace, rollback on failure; then the usual cleanup. The caller has
 * moved the row to post_deploy (claim). Never throws.
 */
export async function continueApprovedRun(job: RunJob, deps: AdapterDeps, st: ApprovedRunState): Promise<RunOutcome> {
  const rec = new RunRecord(job, deps, { log: st.log, output: st.output, outputTruncated: st.outputTruncated });
  rec.status = 'post_deploy';
  const env = createEnv(job, deps, rec);
  const changes = decodePendingReflect(st.analysis?.[PENDING_REFLECT_KEY]);
  let outcome: RunOutcome = { status: 'failed', error: null, resultReleaseId: st.release.id };
  rec.line('info', `release #${st.release.number} approuvée : reprise de la mise à jour`);
  try {
    env.snapshotIds = snapshotIdsReady(await deps.listRunSnapshots(job.runId).catch(() => []));
    const current = await deps.currentReleaseId(job.site.id);
    outcome = current !== st.release.id
      ? { status: 'failed', error: `la release #${st.release.number} n'est plus en ligne : migrations de base non lancées`, resultReleaseId: st.release.id }
      : await afterPublication(env, st.release, changes);
  } catch (err) {
    logger.error({ err, runId: job.runId }, 'Adapters: continuation failed');
    outcome = await rollback(env, st.release, failureText('erreur inattendue', err));
  }
  const analysis = st.analysis ? { ...st.analysis } : null;
  if (analysis) delete analysis[PENDING_REFLECT_KEY];
  await rec.save({ analysis: analysis ? JSON.stringify(analysis) : null });
  await finish(env, outcome, { removeWorkspace: true, hostdSpec: hostdSpecOf(job), refName: candidateRefName(job.runId), keepRef: false, keepSnapshots: false });
  return outcome;
}

// ── cleanup ──────────────────────────────────────────────────────────────────

export function candidateRefName(runId: number): string {
  return `refs/oblimint/candidates/adapter-${runId}`;
}

function hostdSpecOf(job: RunJob) {
  return { accountId: job.account.id, siteId: job.site.id, slug: job.site.slug, uid: job.account.uid, gid: job.account.gid };
}

async function finish(
  env: RunEnv,
  outcome: RunOutcome,
  st: {
    removeWorkspace: boolean; hostdSpec: ReturnType<typeof hostdSpecOf>; refName: string; keepRef: boolean; keepSnapshots: boolean;
  },
): Promise<void> {
  const { job, deps, rec, adapter } = env;
  // Cleanup first (never fails the run): containers, workspace, candidate ref, snapshots retention.
  try { await deps.removeRunContainers(job.account.nodeId, job.runId); } catch (err) { rec.line('warn', failureText('conteneurs d\'outils non supprimés', err), true); }
  if (st.removeWorkspace) {
    try { await deps.removeWorkspace(job.account.nodeId, { ...st.hostdSpec, workspaceId: job.runId }); } catch (err) { rec.line('warn', failureText('copie de travail non supprimée', err), true); }
  }
  if (!st.keepRef) await deps.deleteCandidateRef(job.site.id, st.refName).catch(() => {});
  if (job.action === 'update' && !st.keepSnapshots) await deps.releaseSnapshots({ adapterRunId: job.runId }).catch(() => {});

  if (outcome.error) {
    if (!rec.log.some((l) => l.message === outcome.error)) rec.line('error', outcome.error, true);
  } else if (outcome.status === 'succeeded') rec.line('info', job.action === 'check' ? 'vérification terminée' : 'mise à jour terminée');
  else if (outcome.status === 'no_changes') rec.line('info', 'rien à publier');
  await rec.setStatus(outcome.status, {
    error: outcome.error, result_release_id: outcome.resultReleaseId, finished_at: new Date(),
  });

  const base = { tenantId: job.site.tenantId, accountId: job.account.id, key: `adapter:${job.runId}`, link: `/sites/${job.site.id}?tab=maintenance` };
  if (job.action === 'update' && (outcome.status === 'succeeded' || outcome.status === 'awaiting_approval')) {
    deps.notify('adapter.completed', {
      ...base, severity: 'info',
      title: `Mise à jour appliquée : ${job.site.name}`,
      message: outcome.status === 'succeeded'
        ? `${adapter.label} : la mise à jour #${job.runId} du site ${job.site.name} est en ligne.`
        : `${adapter.label} : la mise à jour #${job.runId} du site ${job.site.name} attend une approbation (migrations de base lancées après l'approbation).`,
    });
  } else if (outcome.status === 'failed' || outcome.status === 'rolled_back') {
    if (job.action === 'update' || job.trigger === 'scheduled') {
      deps.notify('adapter.failed', {
        ...base, severity: outcome.status === 'rolled_back' ? 'critical' : 'warning',
        title: outcome.status === 'rolled_back' ? `Mise à jour annulée : ${job.site.name}` : `Mise à jour en échec : ${job.site.name}`,
        message: `${adapter.label} #${job.runId} (${job.site.name}) : ${outcome.error ?? 'échec'}.`,
      });
    }
  }
}
