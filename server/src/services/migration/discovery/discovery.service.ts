import type { Request } from 'express';
import type { CwpInventory, CwpInventoryCounts, MigrationDiscovery, MigrationDiscoveryPhase, MigrationDiscoveryStatus } from '@oblimint/shared';
import { db } from '../../../db';
import { AppError } from '../../../middleware/errorHandler';
import { auditService } from '../../audit.service';
import { logger } from '../../../utils/logger';
import { SourceConnectionError, type SourceSession } from '../contracts/source';
import { emitMigration } from '../events';
import { sourceExecutor } from '../source/executor';
import { collectInventory, DISCOVERY_PHASES } from './collect';
import { defaultPublicDnsLookup } from './publicDns';
import { DiscoveryAbortedError, errorText } from './collect/context';
import { VitalReadError } from './collect/accounts';

// ─────────────────────────────────────────────────────────────────────────────
// Discovery of a CWP source (docs/P5-PLAN.md §7). OWNED BY MODULE `discovery`.
// Runs in the background (session phase 'discovery': no secret, no data
// dump), persists progress (≤ 1 write / 2 s) + the CwpInventory (no secret
// inside) in migration_discoveries, emits MIGRATION_UPDATED { entity:
// 'discovery' } to role:admin. One running discovery per source (partial
// unique index → 409 discoveryRunning). Rows left 'running' by a previous
// process are failed at boot (start()).
// ─────────────────────────────────────────────────────────────────────────────

export const INTERRUPTED_MESSAGE = 'Interrompue par un redémarrage du panel';
const PROGRESS_PERSIST_MS = 2000;
const MASTER_TENANT_ID = 1;

export type DiscoverySessionFactory = (sourceId: number, discoveryId: number, signal: AbortSignal) => Promise<SourceSession>;

const defaultFactory: DiscoverySessionFactory = (sourceId, discoveryId, signal) =>
  sourceExecutor.session(sourceId, { phase: 'discovery', discoveryId, signal });
let sessionFactory: DiscoverySessionFactory = defaultFactory;

/** Test seam: inject a fake session (contracts/testing.ts createFakeSession); null restores the executor. */
export function setDiscoverySessionFactoryForTests(fn: DiscoverySessionFactory | null): void {
  sessionFactory = fn ?? defaultFactory;
}

interface InFlight {
  sourceId: number;
  controller: AbortController;
  done: Promise<void>;
}

/** Max wait in launch() for a cancelled runner of the same source to close its SSH session. */
const CANCEL_DRAIN_MS = 30_000;

/**
 * cancel() marks the row at once (which frees the one-running-discovery index) while the aborted runner may still be
 * inside a remote command: a new launch on that source first waits for such runners to close their session, so two
 * discovery sessions never run against the same CWP server (409 discoveryRunning when one does not stop in time).
 */
async function drainCancelled(sourceId: number): Promise<void> {
  const pending = [...inflight.values()].filter((f) => f.sourceId === sourceId && f.controller.signal.aborted);
  if (pending.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), CANCEL_DRAIN_MS); });
  try {
    const r = await Promise.race([Promise.all(pending.map((f) => f.done)).then(() => 'done' as const), timeout]);
    if (r === 'timeout') throw new AppError(409, "La découverte annulée n'est pas encore arrêtée : réessayez dans un instant", 'discoveryRunning');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const inflight = new Map<number, InFlight>();

/** Resolves when the background run of a discovery is over (tests). */
export async function waitForDiscoveryForTests(id: number): Promise<void> {
  await inflight.get(id)?.done;
}

const COLUMNS = ['id', 'source_id', 'status', 'phase', 'progress', 'counts', 'error', 'started_at', 'finished_at', 'created_by'];

function json<T>(v: unknown): T | null {
  if (v === null || v === undefined) return null;
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

function rowToDiscovery(r: Record<string, unknown>): MigrationDiscovery {
  const progress = json<{ done: number; total: number }>(r.progress) ?? { done: 0, total: 0 };
  return {
    id: Number(r.id),
    sourceId: Number(r.source_id),
    status: r.status as MigrationDiscoveryStatus,
    phase: (r.phase as MigrationDiscoveryPhase | null) ?? null,
    progress: { done: Number(progress.done) || 0, total: Number(progress.total) || 0 },
    counts: json<CwpInventoryCounts>(r.counts),
    error: (r.error as string | null) ?? null,
    startedAt: iso(r.started_at) as string,
    finishedAt: iso(r.finished_at),
    createdBy: r.created_by === null || r.created_by === undefined ? null : Number(r.created_by),
  };
}

async function load(id: number): Promise<MigrationDiscovery> {
  const r = await db('migration_discoveries').where({ id }).first(COLUMNS);
  if (!r) throw new AppError(404, 'Découverte introuvable', 'notFound');
  return rowToDiscovery(r);
}

function emit(d: Pick<MigrationDiscovery, 'id' | 'sourceId' | 'status' | 'progress'>, throttle = false): void {
  emitMigration({ entity: 'discovery', id: d.id, sourceId: d.sourceId, status: d.status, progress: d.progress }, { throttle });
}

const CONNECTION_MESSAGES: Record<string, string> = {
  hostKeyUnpinned: "Empreinte d'hôte non épinglée : testez la source puis épinglez sa clé",
  hostKeyMismatch: "L'empreinte d'hôte présentée ne correspond pas à l'empreinte épinglée",
  authFailed: 'Authentification SSH refusée',
  connectFailed: 'Connexion SSH impossible',
  timeout: 'Délai de connexion SSH dépassé',
  noSecret: 'Aucun identifiant enregistré pour cette source',
  sudoFailed: 'sudo -n refusé sur la source',
};

/** French failure message, never any command output nor secret. */
export function failureMessage(err: unknown): string {
  if (err instanceof SourceConnectionError) return CONNECTION_MESSAGES[err.code] ?? 'Connexion à la source impossible';
  if (err instanceof VitalReadError) return err.message;
  if (err instanceof AppError && err.statusCode === 501) return 'Exécuteur de la source indisponible';
  return `Échec de la découverte : ${errorText(err)}`;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

async function finish(id: number, patch: Record<string, unknown>): Promise<MigrationDiscovery | null> {
  const n = await db('migration_discoveries').where({ id, status: 'running' }).update({ ...patch, finished_at: db.fn.now() });
  if (n === 0) return null;
  const d = await load(id);
  emit(d);
  return d;
}

async function runInBackground(id: number, sourceId: number, controller: AbortController): Promise<void> {
  const total = DISCOVERY_PHASES.length;
  let lastPersist = 0;
  let pending: Promise<unknown> = Promise.resolve();
  let session: SourceSession | null = null;
  const onPhase = (phase: MigrationDiscoveryPhase, done: number) => {
    const progress = { done, total };
    emit({ id, sourceId, status: 'running', progress }, true);
    const now = Date.now();
    if (now - lastPersist < PROGRESS_PERSIST_MS && done < total) return;
    lastPersist = now;
    pending = pending.then(() => db('migration_discoveries').where({ id, status: 'running' })
      .update({ phase, progress: JSON.stringify(progress) })).catch((err) => logger.debug({ err, id }, 'discovery progress not persisted'));
  };
  try {
    session = await sessionFactory(sourceId, id, controller.signal);
    // Public DNS of the domains (D1 proof for a forced verification); fake sessions (tests) never look up.
    const inventory: CwpInventory = await collectInventory(session, {
      signal: controller.signal, onPhase, publicDns: sessionFactory === defaultFactory ? defaultPublicDnsLookup() : undefined,
    });
    if (controller.signal.aborted) throw new DiscoveryAbortedError();
    await pending;
    await finish(id, {
      status: 'done', phase: 'finalize', progress: JSON.stringify({ done: total, total }),
      counts: JSON.stringify(inventory.counts), inventory: JSON.stringify(inventory), error: null,
    });
    try {
      await db('migration_sources').where({ id: sourceId }).update({
        ...(inventory.server.cwpVersion ? { cwp_version: inventory.server.cwpVersion.slice(0, 64) } : {}),
        ...(inventory.server.osRelease ? { os_release: inventory.server.osRelease.slice(0, 255) } : {}),
      });
    } catch (err) {
      logger.debug({ err, sourceId }, 'source facts not updated');
    }
  } catch (err) {
    await pending;
    if (controller.signal.aborted || err instanceof DiscoveryAbortedError) {
      await finish(id, { status: 'cancelled' });
    } else {
      logger.warn({ id, sourceId, error: errorText(err) }, 'CWP discovery failed');
      await finish(id, { status: 'failed', error: failureMessage(err).slice(0, 1000) });
    }
  } finally {
    if (session) {
      try { await session.close(); } catch (err) { logger.debug({ err, id }, 'discovery session close failed'); }
    }
  }
}

export const discoveryService = {
  /** Starts a discovery (202). 409 discoveryRunning when one runs for this source; 409 hostKeyUnpinned. */
  async launch(req: Request, sourceId: number): Promise<MigrationDiscovery> {
    const src = await db('migration_sources').where({ id: sourceId }).first('id', 'host_key_fingerprint');
    if (!src) throw new AppError(404, 'Source introuvable', 'notFound');
    if (!src.host_key_fingerprint) {
      throw new AppError(409, "Empreinte d'hôte non épinglée : testez la source puis épinglez sa clé", 'hostKeyUnpinned');
    }
    await drainCancelled(sourceId);
    let row: Record<string, unknown>;
    try {
      [row] = await db('migration_discoveries').insert({
        source_id: sourceId, status: 'running', phase: 'connect',
        progress: JSON.stringify({ done: 0, total: DISCOVERY_PHASES.length }), created_by: req.session?.userId ?? null,
      }).returning(COLUMNS);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, 'Une découverte est déjà en cours pour cette source', 'discoveryRunning');
      throw err;
    }
    const discovery = rowToDiscovery(row);
    await auditService.logReqAs(req, MASTER_TENANT_ID, 'migration.discovery.start', {
      resourceType: 'migration_discovery', resourcePath: String(discovery.id), details: { sourceId },
    });
    emit(discovery);
    const controller = new AbortController();
    const done = runInBackground(discovery.id, sourceId, controller)
      .catch((err) => logger.error({ err, id: discovery.id }, 'discovery runner crashed'))
      .finally(() => inflight.delete(discovery.id));
    inflight.set(discovery.id, { sourceId, controller, done });
    return discovery;
  },

  /** Newest first. */
  async list(sourceId: number): Promise<MigrationDiscovery[]> {
    const src = await db('migration_sources').where({ id: sourceId }).first('id');
    if (!src) throw new AppError(404, 'Source introuvable', 'notFound');
    const rows = await db('migration_discoveries').where({ source_id: sourceId }).orderBy([{ column: 'started_at', order: 'desc' }, { column: 'id', order: 'desc' }]).select(COLUMNS);
    return rows.map(rowToDiscovery);
  },

  async get(id: number): Promise<MigrationDiscovery> {
    return load(id);
  },

  /** 409 discoveryNotDone while running / failed / cancelled. */
  async inventory(id: number): Promise<CwpInventory> {
    const r = await db('migration_discoveries').where({ id }).first('status', 'inventory');
    if (!r) throw new AppError(404, 'Découverte introuvable', 'notFound');
    if (r.status !== 'done' || !r.inventory) throw new AppError(409, "La découverte n'est pas terminée", 'discoveryNotDone');
    return json<CwpInventory>(r.inventory) as CwpInventory;
  },

  async cancel(req: Request, id: number): Promise<MigrationDiscovery> {
    const d = await load(id);
    if (d.status !== 'running') return d;
    inflight.get(id)?.controller.abort();
    // Marked at once (the runner may be blocked in a long remote command); the runner's own finish is then a no-op.
    // launch() waits for this runner to close its session before opening another one on the source (drainCancelled).
    const updated = (await finish(id, { status: 'cancelled' })) ?? (await load(id));
    await auditService.logReqAs(req, MASTER_TENANT_ID, 'migration.discovery.cancel', {
      resourceType: 'migration_discovery', resourcePath: String(id), details: { sourceId: d.sourceId },
    });
    return updated;
  },

  /** 409 discoveryInUse when a plan references it. */
  async remove(req: Request, id: number): Promise<void> {
    const d = await load(id);
    if (d.status === 'running') throw new AppError(409, 'La découverte est en cours : annulez-la d\'abord', 'discoveryRunning');
    const used = await db('migration_plans').where({ discovery_id: id }).first('id');
    if (used) throw new AppError(409, 'Un plan utilise cette découverte', 'discoveryInUse');
    try {
      await db('migration_discoveries').where({ id }).del();
    } catch (err) {
      if ((err as { code?: string } | null)?.code === '23503') throw new AppError(409, 'Un plan utilise cette découverte', 'discoveryInUse');
      throw err;
    }
    await auditService.logReqAs(req, MASTER_TENANT_ID, 'migration.discovery.delete', {
      resourceType: 'migration_discovery', resourcePath: String(id), details: { sourceId: d.sourceId, counts: d.counts },
    });
    emitMigration({ entity: 'discovery', id, sourceId: d.sourceId, status: 'deleted' });
  },

  /** Worker: marks discoveries left 'running' by a previous process as failed ('interrupted'). Never throws. */
  start(): void {
    void (async () => {
      const mine = [...inflight.keys()];
      const q = db('migration_discoveries').where({ status: 'running' });
      if (mine.length > 0) q.whereNotIn('id', mine);
      const rows = await q.update({ status: 'failed', error: INTERRUPTED_MESSAGE, finished_at: db.fn.now() }).returning(['id', 'source_id']);
      for (const r of rows as Array<{ id: number; source_id: number }>) {
        emitMigration({ entity: 'discovery', id: Number(r.id), sourceId: Number(r.source_id), status: 'failed' });
      }
      if (rows.length > 0) logger.info({ count: rows.length }, 'interrupted CWP discoveries marked failed');
    })().catch((err) => logger.warn({ err }, 'discovery recovery failed'));
  },

  /** Aborts the discoveries running in this process (their rows end 'cancelled'). */
  stop(): void {
    for (const f of inflight.values()) f.controller.abort();
  },

  /** start() as a promise (tests). */
  async recoverInterrupted(): Promise<number> {
    const mine = [...inflight.keys()];
    const q = db('migration_discoveries').where({ status: 'running' });
    if (mine.length > 0) q.whereNotIn('id', mine);
    return q.update({ status: 'failed', error: INTERRUPTED_MESSAGE, finished_at: db.fn.now() });
  },
};
