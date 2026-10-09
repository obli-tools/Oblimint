import type Docker from 'dockerode';
import type { DbFamily, DbInstanceStatus } from '@oblimint/shared';
import { dbFamilyOf, HostingSocketEvents } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { open, SecretBoxError } from '../../utils/secretBox';
import { errText } from '../setup/docker';
import { hostd } from '../docker/backends';
import { HostdError } from '../hostd/client';
import {
  ensureImage, inspectContainer, inspectNetwork, isUnreachable, labelHash, recreateContainer, removeContainer, startContainer, stopContainer,
} from '../docker/dockerOps';
import { engineFor } from '../docker/engine';
import { withAccountLock } from '../docker/locks';
import { specHashLabel } from '../docker/specs';
import { emitHosting } from '../hosting/events';
import { accountDbNetwork, dbInstanceContainer } from '../hosting/naming';
import { hostPaths } from '../hosting/paths';
import { clientArgv, DB_CONTAINER_PATHS, passwordEnv, pingArgv, type ClientCommandOptions } from './engines';
import { dbExec, type DbExecResult } from './exec';
import type { DbInstanceRow } from './rows';
import { DB_STOP_TIMEOUT_SEC, dbInstanceContainerSpec, dbInstanceImage } from './spec';
import { pgHbaLockdownSql, type SqlScript } from './sql';

// ─────────────────────────────────────────────────────────────────────────────
// Runtime of the database instances (module databases, docs/P2-PLAN.md §9.3):
//  - runSql(): statements through the client of the image, INSIDE the
//    instance container, over the socket, as the superuser. The statements
//    travel in the exec ENVIRONMENT and reach the client's stdin through a
//    constant `sh -c` script (no tenant value is ever part of a shell word,
//    D2); the password is MYSQL_PWD / PGPASSWORD of the exec (B2).
//  - runConverge(): image pull (no lock) → under the ACCOUNT lock
//    (docker/locks.ts, shared with the reconcile passes): hostd dirs →
//    container (spec-hash drift = recreate; data and socket are binds, a
//    recreate loses nothing; never while a dump / restore runs) → lock
//    released → readiness → status (only if no newer converge ran).
//    requestConverge() queues it (the reconcile hook, which already holds
//    the lock, only queues).
// ─────────────────────────────────────────────────────────────────────────────

/** Account columns the instance runtime needs. */
export interface InstanceAccount {
  id: number;
  tenant_id: number;
  node_id: number;
  uid: number;
  gid: number;
  status: string;
}

/** Account statuses whose containers run (a suspended account keeps its instances stopped). */
export function accountRuns(status: string): boolean {
  return status === 'active' || status === 'provisioning' || status === 'error';
}

/** Should the instance container run? (account runs and the user did not stop it). */
export function instanceWanted(row: Pick<DbInstanceRow, 'status'>, account: Pick<InstanceAccount, 'status'>): boolean {
  return accountRuns(account.status) && row.status !== 'stopped' && row.status !== 'deleting';
}

export class SqlError extends Error {
  constructor(message: string, public readonly output: string, public readonly exitCode: number) {
    super(message);
    this.name = 'SqlError';
  }
}

/** Superuser password of an instance (sealed root_secret). */
export function rootPassword(row: Pick<DbInstanceRow, 'root_secret' | 'id'>): string {
  try {
    return open('db-root', row.root_secret);
  } catch (err) {
    if (err instanceof SecretBoxError) {
      throw new AppError(502, `Instance ${row.id}: the superuser secret cannot be opened (SESSION_SECRET changed?)`, 'backendUnavailable');
    }
    throw err;
  }
}

const SQL_SCRIPT = 'printf "%s" "$OBLIMINT_SQL" | "$@"';

/** Runs a statement batch as the superuser through the socket. Throws SqlError on a non-zero exit. */
export async function runSql(
  docker: Docker,
  row: Pick<DbInstanceRow, 'id' | 'engine' | 'root_secret'>,
  script: SqlScript,
  opts: Pick<ClientCommandOptions, 'batch'> & { timeoutMs?: number; password?: string } = {},
): Promise<DbExecResult> {
  const family = dbFamilyOf(row.engine);
  const password = opts.password ?? rootPassword(row);
  const argv = clientArgv(row.engine, { database: script.database ?? null, batch: opts.batch });
  const result = await dbExec(docker, dbInstanceContainer(row.id), ['sh', '-c', SQL_SCRIPT, 'sh', ...argv], {
    env: [`OBLIMINT_SQL=${script.sql}`, passwordEnv(family, password)],
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
  if (result.exitCode !== 0) {
    throw new SqlError(`SQL client exited with ${result.exitCode}`, `${result.stderr}${result.stdout ? `\n${result.stdout}` : ''}`.trim().slice(0, 4000), result.exitCode);
  }
  return result;
}

export interface ReadyOptions {
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Waits until the FINAL server answers: TCP probe inside the container (the
 * first-run temporary server listens on the socket only), then a SELECT 1
 * as the superuser over the socket (the sealed password is the right one).
 */
export async function waitReady(docker: Docker, row: Pick<DbInstanceRow, 'id' | 'engine' | 'root_secret'>, opts: ReadyOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollMs = opts.pollMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  const name = dbInstanceContainer(row.id);
  let last = 'no answer yet';
  let deniedStreak = 0;
  for (;;) {
    const info = await inspectContainer(docker, name);
    if (!info) throw new Error('le conteneur a disparu');
    if (!info.State?.Running && !info.State?.Restarting) {
      throw new Error(`le conteneur s'est arrêté (code ${info.State?.ExitCode ?? '?'})`);
    }
    try {
      const ping = await dbExec(docker, name, pingArgv(row.engine), { timeoutMs: 10_000 });
      if (ping.exitCode === 0) {
        try {
          await runSql(docker, row, { sql: 'SELECT 1;\n' }, { timeoutMs: 15_000 });
          return;
        } catch (err) {
          const text = err instanceof SqlError ? err.output : errText(err);
          last = text;
          if (/access denied|authentication failed/i.test(text) && ++deniedStreak >= 3) {
            throw new Error('mot de passe du superutilisateur refusé par le serveur');
          }
        }
      } else {
        last = (ping.stderr || ping.stdout || `exit ${ping.exitCode}`).trim();
      }
    } catch (err) {
      if (err instanceof Error && /superutilisateur/.test(err.message)) throw err;
      last = errText(err);
    }
    if (Date.now() + pollMs > deadline) throw new Error(`le serveur ne répond pas après ${Math.round(timeoutMs / 1000)} s (${last.slice(0, 200)})`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Desired container spec of an instance. */
export function instanceSpec(row: DbInstanceRow, account: Pick<InstanceAccount, 'id' | 'uid' | 'gid'>, password: string): Docker.ContainerCreateOptions {
  return dbInstanceContainerSpec({
    instanceId: row.id,
    accountId: account.id,
    uid: account.uid,
    gid: account.gid,
    engine: row.engine,
    version: row.version,
    profile: row.profile,
    rootPassword: password,
    externalPort: row.external_enabled ? row.external_port : null,
    dataDir: hostPaths.dbData(account.id, row.id),
    socketDir: hostPaths.dbSocketInstance(account.id, row.id),
  });
}

// ── rows / events ────────────────────────────────────────────────────────────

export async function loadInstanceRow(id: number): Promise<DbInstanceRow | null> {
  return (await db('db_instances').where({ id }).first()) as DbInstanceRow | undefined ?? null;
}

export async function loadInstanceAccount(accountId: number): Promise<InstanceAccount | null> {
  return (await db('hosting_accounts').where({ id: accountId }).first('id', 'tenant_id', 'node_id', 'uid', 'gid', 'status')) as InstanceAccount | undefined ?? null;
}

export function emitInstance(row: Pick<DbInstanceRow, 'id' | 'account_id' | 'tenant_id'>, status: DbInstanceStatus | 'deleted'): void {
  emitHosting(HostingSocketEvents.DB_INSTANCE_UPDATED, { instanceId: row.id, accountId: row.account_id, status }, { tenantId: row.tenant_id, accountId: row.account_id });
}

/** Writes a status unless the row was deleted / is being deleted meanwhile (compare-and-set). */
export async function setInstanceStatus(row: DbInstanceRow, status: DbInstanceStatus, message: string | null): Promise<boolean> {
  const n = await db('db_instances')
    .where({ id: row.id })
    .whereNot({ status: 'deleting' })
    .update({ status, status_message: message, updated_at: new Date() });
  if (n && (row.status !== status || row.status_message !== message)) emitInstance(row, status);
  return n > 0;
}

function notifyFailure(row: DbInstanceRow, message: string): void {
  void import('../usage/notifications.service')
    .then((m) => m.notify('db.instanceFailed', {
      tenantId: row.tenant_id,
      accountId: row.account_id,
      key: `db:instance:${row.id}:failed`,
      title: `Instance de base de données « ${row.name} » en erreur`,
      message,
      severity: 'critical',
      link: `/databases/${row.id}`,
    }))
    .catch((err) => logger.warn({ err: errText(err), instanceId: row.id }, 'notify db.instanceFailed failed'));
}

/** hostd: the default-socket link of `family` → the account's default instance of that family (or none). */
export async function syncDefaultSocket(nodeId: number, accountId: number, family: DbFamily): Promise<void> {
  const rows = await db('db_instances').where({ account_id: accountId, is_default: true }).whereNot({ status: 'deleting' })
    .select('id', 'engine') as Array<{ id: number; engine: DbInstanceRow['engine'] }>;
  const def = rows.find((r) => dbFamilyOf(r.engine) === family) ?? null;
  await (await hostd(nodeId)).setDefaultDbSocket(accountId, family, def ? def.id : null);
}

// ── converge ─────────────────────────────────────────────────────────────────

export interface ConvergeOptions {
  /** Restart a running container (POST …/restart). */
  restart?: boolean;
  ready?: ReadyOptions;
}

const networkPassRequested = new Map<number, number>();

export type ConvergeResult = 'running' | 'stopped' | 'error' | 'gone' | 'unreachable' | 'deferred';

// ── heavy-operation lock (dump / restore / delete), shared with the converge ──

const busy = new Set<number>();
/** Converges deferred because the instance was busy: re-queued on release. */
const deferredWhileBusy = new Map<number, number>();

export function isInstanceBusy(instanceId: number): boolean {
  return busy.has(instanceId);
}

/** One heavy operation per instance at a time (409 instanceBusy). Returns the release function (idempotent). */
export function acquireBusy(instanceId: number): () => void {
  if (busy.has(instanceId)) throw new AppError(409, 'Another operation is running on this instance', 'instanceBusy');
  busy.add(instanceId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    busy.delete(instanceId);
    const accountId = deferredWhileBusy.get(instanceId);
    if (accountId !== undefined) {
      deferredWhileBusy.delete(instanceId);
      requestConverge(instanceId, accountId, 'after-busy');
    }
  };
}

/** Every converge of an instance bumps it: a readiness wait only writes the status if no newer converge ran meanwhile. */
const generation = new Map<number, number>();

interface ReadyJob {
  docker: Docker;
  row: DbInstanceRow;
  accountId: number;
  gen: number;
  changed: boolean;
  opts: ConvergeOptions;
}

interface LockedOutcome {
  result: ConvergeResult;
  /** Readiness still to wait for (outside the account lock). */
  ready?: ReadyJob;
}

/**
 * Brings ONE instance to its desired state. MUST run under the account lock
 * (waits for the readiness inline: use runConverge to wait outside the lock).
 * Never throws for a container / engine failure: the instance goes `error`
 * (+ message, notification); Docker unreachable leaves the status untouched.
 */
export async function convergeInstance(instanceId: number, opts: ConvergeOptions = {}): Promise<ConvergeResult> {
  const out = await convergeLocked(instanceId, opts);
  return out.ready ? finishReady(out.ready) : out.result;
}

/**
 * Converge with the slow parts OUTSIDE the account lock: the image pull
 * before taking it (hundreds of MB), the readiness wait (first initdb, up to
 * minutes) after releasing it. Only inspect / create / start runs locked.
 */
export async function runConverge(instanceId: number, accountId: number, opts: ConvergeOptions = {}): Promise<ConvergeResult> {
  await prefetchImage(instanceId);
  const out = await withAccountLock(accountId, () => convergeLocked(instanceId, opts));
  return out.ready ? finishReady(out.ready) : out.result;
}

/** Pulls the instance image if missing (no lock). Never throws: the locked phase reports a failure. */
async function prefetchImage(instanceId: number): Promise<void> {
  try {
    const row = await loadInstanceRow(instanceId);
    if (!row || row.status === 'deleting') return;
    const docker = await engineFor(row.node_id);
    await ensureImage(docker, dbInstanceImage(row.engine, row.version));
  } catch (err) {
    logger.debug({ instanceId, err: errText(err) }, 'DB image prefetch failed (the converge reports it)');
  }
}

/** Waits for the server, then writes the status if this converge is still the latest one. */
async function finishReady(job: ReadyJob): Promise<ConvergeResult> {
  const { docker, row } = job;
  const current = () => generation.get(row.id) === job.gen;
  try {
    await waitReady(docker, row, job.opts.ready);
  } catch (err) {
    if (!current()) return 'deferred'; // a newer converge owns the instance now
    if (isUnreachable(err)) {
      logger.warn({ instanceId: row.id, err: errText(err) }, 'DB instance readiness: Docker unreachable');
      return 'unreachable';
    }
    const message = `Démarrage du serveur : ${errText(err)}`.slice(0, 1000);
    logger.warn({ instanceId: row.id, accountId: job.accountId, err: message }, 'DB instance converge failed');
    const wasError = row.status === 'error';
    if (await setInstanceStatus(row, 'error', message) && !wasError) notifyFailure(row, message);
    return 'error';
  }
  if (dbFamilyOf(row.engine) === 'postgresql') await lockDownPgHba(docker, row);
  if (!current()) return 'deferred';
  await setInstanceStatus(row, 'running', null);
  if (job.changed) logger.info({ instanceId: row.id, accountId: job.accountId }, 'DB instance converged');
  return 'running';
}

/** PostgreSQL: the superuser never over TCP (pg_hba). Non-fatal: logged, retried at the next (re)start. */
async function lockDownPgHba(docker: Docker, row: DbInstanceRow): Promise<void> {
  try {
    await runSql(docker, row, pgHbaLockdownSql(`${DB_CONTAINER_PATHS.postgresql.data}/pg_hba.conf`), { batch: true, timeoutMs: 15_000 });
  } catch (err) {
    const detail = err instanceof SqlError ? err.output : errText(err);
    logger.warn({ instanceId: row.id, err: detail.slice(0, 500) }, 'PostgreSQL pg_hba lockdown failed (superuser still reachable over TCP)');
  }
}

async function convergeLocked(instanceId: number, opts: ConvergeOptions): Promise<LockedOutcome> {
  const gen = (generation.get(instanceId) ?? 0) + 1;
  generation.set(instanceId, gen);
  const row = await loadInstanceRow(instanceId);
  if (!row || row.status === 'deleting') {
    generation.delete(instanceId);
    return { result: 'gone' };
  }
  const account = await loadInstanceAccount(row.account_id);
  if (!account) return { result: 'gone' };
  const name = dbInstanceContainer(row.id);
  let docker: Docker;
  try {
    docker = await engineFor(row.node_id);
  } catch (err) {
    logger.warn({ instanceId, err: errText(err) }, 'DB instance converge: engine unavailable');
    return { result: 'unreachable' };
  }

  if (!instanceWanted(row, account)) {
    try {
      await stopContainer(docker, name, DB_STOP_TIMEOUT_SEC);
    } catch (err) {
      if (isUnreachable(err)) return { result: 'unreachable' };
      logger.warn({ instanceId, err: errText(err) }, 'DB instance stop failed');
    }
    return { result: 'stopped' };
  }

  const step = { label: 'Réseau des bases du compte' };
  try {
    // The account DATABASE network is the reconcile's (ARCHITECTURE §3.6: sites
    // + instances, never the edge): a fresh account may not have it yet.
    // Its pass creates it, then its hook queues this converge again.
    if (!(await inspectNetwork(docker, accountDbNetwork(account.id)))) {
      // At most one pass request per account and minute (a pass that cannot create the network must not loop).
      const last = networkPassRequested.get(account.id) ?? 0;
      if (Date.now() - last < 60_000) return { result: 'deferred' };
      networkPassRequested.set(account.id, Date.now());
      void import('../docker/reconcile.service')
        .then((m) => m.reconcileService.requestAccount(account.id, 'db-instance-network'))
        .catch((err) => logger.warn({ instanceId, err: errText(err) }, 'reconcile request failed'));
      return { result: 'deferred' };
    }
    step.label = 'Préparation des dossiers';
    await (await hostd(row.node_id)).ensureDbInstance({ accountId: account.id, instanceId: row.id, uid: account.uid, gid: account.gid });
    step.label = 'Secret du superutilisateur';
    const password = rootPassword(row);
    const spec = instanceSpec(row, account, password);
    step.label = 'Image';
    await ensureImage(docker, spec.Image!); // normally pulled already (runConverge prefetch)
    step.label = 'Conteneur';
    const info = await inspectContainer(docker, name);
    const drift = !info || labelHash(info.Config?.Labels) !== specHashLabel(spec);
    // A dump / restore in progress (up to hours) is never killed by a
    // recreation or a restart: done when the operation releases the instance.
    if (info && (drift || opts.restart) && busy.has(row.id)) {
      deferredWhileBusy.set(row.id, account.id);
      logger.info({ instanceId, drift }, 'DB instance busy: recreation / restart deferred');
      return { result: 'deferred' };
    }
    let changed = false;
    if (drift) {
      await recreateContainer(docker, spec, true);
      changed = true;
    } else if (!info!.State?.Running) {
      await startContainer(docker, name);
      changed = true;
    } else if (opts.restart) {
      await stopContainer(docker, name, DB_STOP_TIMEOUT_SEC);
      await startContainer(docker, name);
      changed = true;
    }
    if (row.is_default) {
      step.label = 'Socket par défaut';
      await syncDefaultSocket(row.node_id, account.id, dbFamilyOf(row.engine));
    }
    if (changed || row.status !== 'running') {
      return { result: 'running', ready: { docker, row, accountId: account.id, gen, changed, opts } };
    }
    await setInstanceStatus(row, 'running', null);
    return { result: 'running' };
  } catch (err) {
    if (isUnreachable(err)) {
      logger.warn({ instanceId, err: errText(err) }, 'DB instance converge: Docker / hostd unreachable');
      return { result: 'unreachable' };
    }
    if (isHostdTransient(err)) {
      // hostd busy with a long operation on the account (data seed, purge…) or
      // cancelled: not an instance failure (no 'error', no notification), retried.
      logger.info({ instanceId, err: errText(err) }, 'DB instance converge: hostd busy, retried');
      requestConverge(instanceId, account.id, 'hostd-busy', HOSTD_BUSY_RETRY_MS);
      return { result: 'deferred' };
    }
    const message = `${step.label} : ${errText(err)}`.slice(0, 1000);
    logger.warn({ instanceId, accountId: account.id, err: message }, 'DB instance converge failed');
    const wasError = row.status === 'error';
    await setInstanceStatus(row, 'error', message);
    if (!wasError) notifyFailure(row, message);
    return { result: 'error' };
  }
}

/** Delay before re-converging an instance after a hostd 409 busy / 503 cancelled. */
export const HOSTD_BUSY_RETRY_MS = 30_000;

/** hostd 409 busy / 503 cancelled: transient (same rule as the account reconcile). */
export function isHostdTransient(err: unknown): boolean {
  return err instanceof HostdError && (err.code === 'busy' || err.code === 'cancelled');
}

/** Removes the container of an instance (delete). Under the account lock. */
export async function removeInstanceContainer(nodeId: number, instanceId: number): Promise<void> {
  const docker = await engineFor(nodeId);
  await removeContainer(docker, dbInstanceContainer(instanceId));
}

// ── queue (debounced, per instance, under the account lock) ──────────────────

const pending = new Map<number, { accountId: number; timer: NodeJS.Timeout | null; opts: ConvergeOptions }>();
const running = new Set<Promise<unknown>>();
const QUEUE_DEBOUNCE_MS = 500;

/** Queues a converge of `instanceId` (never throws, never blocks). */
export function requestConverge(instanceId: number, accountId: number, reason: string, delayMs = QUEUE_DEBOUNCE_MS): void {
  const existing = pending.get(instanceId);
  if (existing) return;
  const entry = { accountId, timer: null as NodeJS.Timeout | null, opts: {} };
  pending.set(instanceId, entry);
  entry.timer = setTimeout(() => {
    pending.delete(instanceId);
    const p = runConverge(instanceId, accountId, entry.opts)
      .catch((err) => logger.error({ instanceId, reason, err: errText(err) }, 'DB instance converge crashed'));
    running.add(p);
    void p.finally(() => running.delete(p));
  }, delayMs);
  entry.timer.unref?.();
}

/** Tests / shutdown: waits for the queued and running converges. */
export async function settleConverges(): Promise<void> {
  for (let i = 0; i < 50 && (pending.size || running.size); i++) {
    for (const e of pending.values()) {
      if (e.timer) { clearTimeout(e.timer); e.timer = null; }
    }
    const ids = [...pending.entries()];
    pending.clear();
    for (const [id, e] of ids) {
      const p = runConverge(id, e.accountId, e.opts).catch(() => undefined);
      running.add(p);
      void p.finally(() => running.delete(p));
    }
    await Promise.all([...running]);
  }
}

/** Drops the queued (not yet started) converges (worker stop). */
export function cancelQueuedConverges(): void {
  for (const e of pending.values()) if (e.timer) clearTimeout(e.timer);
  pending.clear();
}
