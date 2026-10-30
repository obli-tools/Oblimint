import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Auto-publish debounce (publish modes 'auto' and 'approval'). OWNED BY MODULE `releases`.
// Every upload/delete/rename event of the file server on /staging/<slug>/…
// pushes the deadline of the site to now + publish_debounce_sec (capped at
// 10 min after the FIRST pending event); at the deadline: releaseService.publish
// (trigger 'auto'; mode 'approval' stops at awaiting_approval, 'manual' does
// nothing). In-memory (lost on restart: the next event re-arms it).
// ─────────────────────────────────────────────────────────────────────────────

/** A burst of uploads never delays the publication more than this after its first event. */
export const MAX_DEBOUNCE_MS = 10 * 60_000;
/** Retry delay when a publication of the site is already running. */
export const BUSY_RETRY_MS = 30_000;
/** Retry delay of an auto publication that failed on a transient backend state (hostd busy with another site). */
export const TRANSIENT_RETRY_MS = 60_000;
/** At most this many transient retries in a row (reset by the next staging change). */
export const MAX_TRANSIENT_RETRIES = 5;
const SETTINGS_TTL_MS = 30_000;

interface Pending {
  first: number;
  deadline: number;
  timer: NodeJS.Timeout;
}

interface SiteSettings { mode: 'auto' | 'manual' | 'approval'; debounceSec: number; loadedAt: number }

export interface SchedulerDeps {
  loadSettings(siteId: number): Promise<{ mode: 'auto' | 'manual' | 'approval'; debounceSec: number } | null>;
  publish(siteId: number): Promise<unknown>;
  now(): number;
}

const defaultDeps: SchedulerDeps = {
  async loadSettings(siteId) {
    const row = await db('sites').where({ id: siteId }).first('publish_mode', 'publish_debounce_sec') as
      { publish_mode: SiteSettings['mode']; publish_debounce_sec: number } | undefined;
    return row ? { mode: row.publish_mode, debounceSec: Number(row.publish_debounce_sec) } : null;
  },
  async publish(siteId) {
    // release.publish protected (actions sensibles): no automatic publication — a human publishes
    // through the gated route. Mode 'approval' stops at awaiting_approval (a human decides) anyway.
    const site = await db('sites').where({ id: siteId }).first('tenant_id', 'account_id', 'publish_mode') as
      { tenant_id: number; account_id: number; publish_mode: string } | undefined;
    if (site?.publish_mode === 'auto') {
      const { publicationProtected } = await import('../restrictions/restriction.service');
      if (await publicationProtected({ ...site, id: siteId })) {
        throw new AppError(409, 'The publication of this site is a protected action: publish it by hand', 'publicationProtected');
      }
    }
    const { releaseService } = await import('./release.service');
    // A rollback by a human is never undone by an automatic publication (409 liveRolledBack: held).
    return releaseService.publish(siteId, { trigger: 'auto', userId: null, rollbackGuard: 'refuse' });
  },
  now: () => Date.now(),
};

let deps: SchedulerDeps = defaultDeps;
const pending = new Map<number, Pending>();
const lastChanges = new Map<number, number>();
const settingsCache = new Map<number, SiteSettings>();
/** Transient-failure retries armed in a row, per site. */
const transientRetries = new Map<number, number>();
/** Each notifyChange chains on the previous one of the site (settings load is async). */
const chains = new Map<number, Promise<void>>();
/** Auto publications held because the staging still holds code of a release a human rolled back from. */
const held = new Map<number, { at: string; releaseNumber: number; count: number }>();
/** Off until start() (workers disabled = no auto-publish). */
let running = false;

async function settings(siteId: number): Promise<SiteSettings | null> {
  const cached = settingsCache.get(siteId);
  if (cached && deps.now() - cached.loadedAt < SETTINGS_TTL_MS) return cached;
  const s = await deps.loadSettings(siteId);
  if (!s) { settingsCache.delete(siteId); return null; }
  const v: SiteSettings = { ...s, loadedAt: deps.now() };
  settingsCache.set(siteId, v);
  return v;
}

function arm(siteId: number, first: number, deadline: number): void {
  const prev = pending.get(siteId);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => { void fire(siteId); }, Math.max(0, deadline - deps.now()));
  timer.unref?.();
  pending.set(siteId, { first, deadline, timer });
}

async function fire(siteId: number): Promise<void> {
  pending.delete(siteId);
  if (!running) return;
  try {
    settingsCache.delete(siteId); // the mode may have changed since the first event
    const s = await settings(siteId);
    // Only the latest outcome holds the site: manual mode, noChanges, a publication… clear it.
    held.delete(siteId);
    if (!s || s.mode === 'manual') return;
    await deps.publish(siteId);
  } catch (err) {
    // adapterBusy (P3): an adapter run is past its publication / deferred; retried like a busy pipeline.
    if (err instanceof AppError && (err.code === 'publishInProgress' || err.code === 'adapterBusy')) {
      const now = deps.now();
      arm(siteId, now, now + BUSY_RETRY_MS);
      return;
    }
    // Not re-armed: the next staging change replays the guard (restoring the live release lets it pass).
    if (err instanceof AppError && err.code === 'liveRolledBack') {
      const d = (err.details ?? {}) as { rolledBackFrom?: number; count?: number };
      held.set(siteId, { at: new Date(deps.now()).toISOString(), releaseNumber: Number(d.rolledBackFrom ?? 0), count: Number(d.count ?? 0) });
      logger.warn({ siteId, rolledBackFrom: d.rolledBackFrom, count: d.count }, 'Auto-publish held: the staging would undo a rollback');
      return;
    }
    if (err instanceof AppError && err.code === 'publicationProtected') {
      logger.info({ siteId }, 'Auto-publish skipped: release.publish is protected, a human publishes');
      return;
    }
    if (err instanceof AppError && (err.code === 'stagingEmpty' || err.code === 'noChanges' || err.code === 'accountSuspended' || err.statusCode === 404)) return;
    logger.warn({ err, siteId }, 'Auto-publish failed');
  }
}

async function handleChange(siteId: number, at: number): Promise<void> {
  const s = await settings(siteId);
  if (!s || s.mode === 'manual' || !running) return;
  const p = pending.get(siteId);
  const first = p ? p.first : at;
  const wanted = at + Math.max(0, s.debounceSec) * 1000;
  const deadline = Math.min(wanted, first + MAX_DEBOUNCE_MS);
  if (p && p.deadline === deadline) return;
  arm(siteId, first, deadline);
}

/** Chains a handleChange of the site after the previous one (settings load is async). */
function enqueue(siteId: number, t: number): void {
  const prev = chains.get(siteId) ?? Promise.resolve();
  const next = prev
    .then(() => handleChange(siteId, t))
    .catch((err) => logger.warn({ err, siteId }, 'Auto-publish scheduling failed'));
  chains.set(siteId, next);
  void next.finally(() => { if (chains.get(siteId) === next) chains.delete(siteId); });
}

export const publishScheduler = {
  /** A staging change of the site (file-server event). Never throws. */
  notifyChange(siteId: number, at: Date = new Date()): void {
    if (!Number.isInteger(siteId) || siteId <= 0) return;
    const t = at.getTime();
    lastChanges.set(siteId, Math.max(lastChanges.get(siteId) ?? 0, t));
    transientRetries.delete(siteId);
    enqueue(siteId, t);
  },

  /** Pending deadline of a site, null when none. */
  deadline(siteId: number): Date | null {
    const p = pending.get(siteId);
    return p ? new Date(p.deadline) : null;
  },

  /** Last staging change seen for a site (in-memory). */
  lastChange(siteId: number): Date | null {
    const t = lastChanges.get(siteId);
    return t ? new Date(t) : null;
  },

  /**
   * An AUTO publication failed on a transient backend state (hostd busy:
   * another site of the account is seeding): re-arm it after
   * TRANSIENT_RETRY_MS, at most MAX_TRANSIENT_RETRIES times in a row. Returns
   * true when armed. Never throws.
   */
  retryAfterTransientFailure(siteId: number): boolean {
    if (!running || !Number.isInteger(siteId) || siteId <= 0) return false;
    const n = (transientRetries.get(siteId) ?? 0) + 1;
    if (n > MAX_TRANSIENT_RETRIES) {
      logger.warn({ siteId, retries: n - 1 }, 'Auto-publish: transient failures persist, giving up until the next change');
      return false;
    }
    transientRetries.set(siteId, n);
    if (pending.has(siteId)) return true; // a newer change already re-armed it
    const now = deps.now();
    arm(siteId, now, now + TRANSIENT_RETRY_MS);
    return true;
  },

  /** The auto publication of a site is held (liveRolledBack), null when not. */
  heldInfo(siteId: number): { at: string; releaseNumber: number; count: number } | null {
    return held.get(siteId) ?? null;
  },

  /** A publication succeeded or the staging was restored: nothing held any more. */
  clearHeld(siteId: number): void {
    held.delete(siteId);
  },

  /**
   * The rollback a held auto-publication protected is over (a human went
   * forward again): cleared and, when it was held, re-armed (as a staging
   * change would, without recording one) so the pending staging changes are
   * published. Never throws.
   */
  releaseHeld(siteId: number): void {
    if (!held.delete(siteId) || !running) return;
    enqueue(siteId, deps.now());
  },

  cancel(siteId: number): void {
    const p = pending.get(siteId);
    if (p) clearTimeout(p.timer);
    pending.delete(siteId);
    settingsCache.delete(siteId);
  },

  start(): void {
    running = true;
  },

  stop(): void {
    running = false;
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
  },

  /** Tests: waits for queued notifyChange handling. */
  async idle(): Promise<void> {
    await Promise.all([...chains.values()]);
  },
};

/** Tests only: the real publish step of the scheduler (its protection check first). */
export function schedulerDefaultPublishForTests(siteId: number): Promise<unknown> {
  return defaultDeps.publish(siteId);
}

/** Tests only: replaces the collaborators (null restores the defaults) and clears the state. */
export function setSchedulerDeps(over: Partial<SchedulerDeps> | null): void {
  deps = over ? { ...defaultDeps, ...over } : defaultDeps;
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  lastChanges.clear();
  settingsCache.clear();
  transientRetries.clear();
  chains.clear();
  held.clear();
  running = true;
}
