import { db } from '../../db';
import { logger } from '../../utils/logger';
import { errText } from '../setup/docker';
import { deps } from './deps';
import { NO_WATCH, planWatchOps, type AccountWatchTarget } from './logic';

// ─────────────────────────────────────────────────────────────────────────────
// Typed-path watch specs → hostd (P3-PLAN §12). Debounced queue: the reconcile
// hook hands the account state it already has (no query inside the account
// lock), requestWatchSync / requestWatchSyncAll load it from the database.
// Each site's last pushed spec is remembered (signature) so that a reconcile
// pass does not make hostd rescan unchanged trees; `force` re-pushes
// everything (boot, hostd restarted: its in-memory watches are gone).
// Never throws.
// ─────────────────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 500;

interface Pending { reason: string; force: boolean; target: AccountWatchTarget | null }

const queue = new Map<number, Pending>();
let allPending: { reason: string; force: boolean } | null = null;
/** accountId → siteId → signature last applied by hostd. */
const known = new Map<number, Map<number, string>>();
let timer: NodeJS.Timeout | null = null;
let running = false;
let idleWaiters: Array<() => void> = [];

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void flush(); }, DEBOUNCE_MS);
  timer.unref?.();
}

export function queueWatchSync(accountId: number, reason: string, target: AccountWatchTarget | null = null, force = false): void {
  try {
    if (!Number.isInteger(accountId) || accountId <= 0) return;
    const prev = queue.get(accountId);
    // force is sticky. The target follows the LATEST call: a reconcile pass hands
    // its account state, a later call without one (data paths / settings changed
    // since) means "reload from the database" and must not flush the older state.
    queue.set(accountId, { reason, force: force || prev?.force === true, target: target ?? null });
    schedule();
  } catch (err) {
    logger.warn({ err: errText(err) }, 'quarantine: watch sync not queued');
  }
}

export function queueWatchSyncAll(reason: string, force = false): void {
  allPending = { reason, force: force || allPending?.force === true };
  schedule();
}

/** Watch targets of some accounts (all when ids is null), from the database. */
export async function loadWatchTargets(ids: number[] | null): Promise<AccountWatchTarget[]> {
  const aq = db('hosting_accounts').select('id', 'node_id', 'uid', 'gid', 'status').orderBy('id');
  if (ids) aq.whereIn('id', ids);
  const accounts = await aq as Array<{ id: number; node_id: number; uid: number; gid: number; status: string }>;
  if (accounts.length === 0) return [];
  const accountIds = accounts.map((a) => a.id);
  const sites = await db('sites').whereIn('account_id', accountIds).select('id', 'account_id', 'slug').orderBy('id') as Array<{ id: number; account_id: number; slug: string }>;
  const paths = sites.length
    ? await db('site_data_paths').whereIn('site_id', sites.map((s) => s.id)).where({ policy: 'typed' })
      .select('site_id', 'path', 'policy', 'allowed_extensions') as Array<{ site_id: number; path: string; policy: string; allowed_extensions: unknown }>
    : [];
  return accounts.map((a) => ({
    accountId: Number(a.id), nodeId: Number(a.node_id), uid: Number(a.uid), gid: Number(a.gid), status: a.status,
    sites: sites.filter((s) => s.account_id === a.id).map((s) => ({
      siteId: Number(s.id),
      slug: s.slug,
      dataPaths: paths.filter((p) => p.site_id === s.id).map((p) => ({ path: p.path, policy: p.policy, allowedExtensions: p.allowed_extensions })),
    })),
  }));
}

/** Applies the watch state of one account. Never throws; a failed site is retried at the next sync. */
export async function applyWatchTarget(target: AccountWatchTarget, typedWatcher: boolean, force: boolean, reason: string): Promise<number> {
  if (target.status === 'deleting') {
    known.delete(target.accountId);
    return 0;
  }
  let siteMap = known.get(target.accountId);
  const ops = planWatchOps(target, typedWatcher, siteMap, force);
  if (ops.length === 0) return 0;
  if (!siteMap) { siteMap = new Map(); known.set(target.accountId, siteMap); }
  let hostd: ReturnType<typeof deps.hostd>;
  try {
    hostd = deps.hostd(target.nodeId);
  } catch (err) {
    logger.warn({ accountId: target.accountId, reason, err: errText(err) }, 'quarantine: hostd unavailable, watch specs not applied');
    return 0;
  }
  let applied = 0;
  for (const op of ops) {
    try {
      if (op.kind === 'set') {
        const r = await hostd.setWatch(op.spec);
        if (r.quarantined > 0) logger.info({ accountId: target.accountId, siteId: op.siteId, quarantined: r.quarantined }, 'quarantine: initial scan of the typed paths quarantined files');
      } else {
        await hostd.removeWatch(target.accountId, op.siteId);
      }
      siteMap.set(op.siteId, op.signature);
      applied++;
    } catch (err) {
      siteMap.delete(op.siteId);
      logger.warn({ accountId: target.accountId, siteId: op.siteId, op: op.kind, reason, err: errText(err) }, 'quarantine: watch spec not applied');
    }
  }
  // Sites gone from the account and now unwatched are forgotten.
  const present = new Set(target.sites.map((s) => s.siteId));
  for (const [siteId, sig] of siteMap) if (!present.has(siteId) && sig === NO_WATCH) siteMap.delete(siteId);
  return applied;
}

async function flush(): Promise<void> {
  if (running) { schedule(); return; }
  running = true;
  try {
    const typedWatcher = await deps.typedWatcher().catch(() => true);
    if (allPending) {
      const all = allPending;
      allPending = null;
      // Accounts queued individually are covered by this pass (their own force is kept).
      const forced = new Set([...queue].filter(([, p]) => p.force).map(([id]) => id));
      queue.clear();
      for (const t of await loadWatchTargets(null)) await applyWatchTarget(t, typedWatcher, all.force || forced.has(t.accountId), all.reason);
    }
    const batch = [...queue];
    queue.clear();
    const toLoad = batch.filter(([, p]) => !p.target).map(([id]) => id);
    const loaded = new Map((toLoad.length ? await loadWatchTargets(toLoad) : []).map((t) => [t.accountId, t]));
    for (const [id, p] of batch) {
      const target = p.target ?? loaded.get(id);
      if (!target) { known.delete(id); continue; } // account deleted
      await applyWatchTarget(target, typedWatcher, p.force, p.reason);
    }
  } catch (err) {
    logger.warn({ err: errText(err) }, 'quarantine: watch sync failed');
  } finally {
    running = false;
    if (queue.size > 0 || allPending) schedule();
    else if (!timer) { const w = idleWaiters; idleWaiters = []; for (const r of w) r(); }
  }
}

/** Forget the pushed signature of a site (watchError from hostd: the next sync re-pushes it). */
export function forgetWatch(accountId: number, siteId: number | null): void {
  const m = known.get(accountId);
  if (!m) return;
  if (siteId === null) known.delete(accountId);
  else m.delete(siteId);
}

/** Tests: resolves once nothing is queued or running. */
export function watchSyncIdle(): Promise<void> {
  if (!timer && !running && queue.size === 0 && !allPending) return Promise.resolve();
  return new Promise((r) => idleWaiters.push(r));
}

/** Tests / stop: drop the queue and the cache. */
export function resetWatchState(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  queue.clear();
  allPending = null;
  known.clear();
  const w = idleWaiters; idleWaiters = []; for (const r of w) r();
}

/** Tests: the signature cache of an account. */
export function knownWatches(accountId: number): ReadonlyMap<number, string> | undefined {
  return known.get(accountId);
}
