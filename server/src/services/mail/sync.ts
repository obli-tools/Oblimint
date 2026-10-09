import { MASTER_TENANT_ID, mailEngineHasMailboxes, type MailEngine } from '@oblimint/shared';
import { db } from '../../db';
import { appConfigService } from '../appConfig.service';
import { logger } from '../../utils/logger';
import { notify } from '../usage/notifications.service';
import { errText } from '../setup/docker';
import { loadDesiredState } from './desiredState';
import { MailDriverError, type MailDesiredState, type MailDriver, type MailSyncResult } from './driver';
import { emitMail } from './events';
import { ensureMailNetwork } from './network';
import { runPurgeQueue } from './purge';
import { activeMailDriver } from './registry';
import { pollMailUsage } from './usage';

// ─────────────────────────────────────────────────────────────────────────────
// Engine synchronisation loop of mail-core (docs/P4-PLAN.md §9.1, §17).
//
//  - requestSync(reason): debounced 500 ms, runs serialized (one sync at a
//    time; a request during a sync runs once more after it). Before start()
//    (workers off, tests) requests are remembered and run at start.
//  - full pass every 10 min (drift repair) re-checking ensureMailNetwork
//    (engines with mailboxes: catches up when Docker was missing);
//  - usage every 15 min, purge queue every hour;
//  - per-domain errors ⇒ mail_domains.sync_error; global result in memory
//    (lastSyncAt / lastSyncError for MailSystemStatus);
//  - failure ⇒ notify('mail.serviceFailed') (platform, deduplicated 1 h);
//  - MailDriverError 'massRemoval': the sync is retried ONCE with
//    allowMassRemoval when every mailbox about to disappear is explained by a
//    tombstone (mail_purge_queue) written since the last applied sync (an
//    account / domain / mailboxes deleted on purpose, also by P1/P2 CASCADE).
//    Anything unexplained (a transient empty state) stays refused until
//    syncNow({ force: true }) (audited route). The last applied sync is kept
//    in app_config `mail_sync_applied` ({ at (DB clock), count, engine });
//  - a watcher (1 min) re-syncs when mail_purge_queue grows or the
//    verification of a mail domain's domain changes (P1/P2 code deleting an
//    account / a domain, D1 verification: no mail hook there);
//  - runMailExclusive(): a job alone on the same serialized chain (engine
//    change), with an inline sync that does not re-enter the chain.
// Nothing here ever throws to a hook caller.
// ─────────────────────────────────────────────────────────────────────────────

export const SYNC_DEBOUNCE_MS = 500;
const BOOT_DELAY_MS = 15_000;
const FULL_SYNC_MS = 10 * 60_000;
const USAGE_MS = 15 * 60_000;
const PURGE_MS = 60 * 60_000;
const NOTIFY_DEDUP_MS = 60 * 60_000;
const WATCH_MS = 60_000;
export const MAIL_SYNC_APPLIED_KEY = 'mail_sync_applied';

interface SyncRuntime {
  active: boolean;
  timers: NodeJS.Timeout[];
  debounce: NodeJS.Timeout | null;
  pendingReasons: Set<string>;
  chain: Promise<void>;
  running: number;
  idleWaiters: Array<() => void>;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  lastResult: MailSyncResult | null;
  lastNotifiedAt: number;
  watchFingerprint: string | null;
}

const rt: SyncRuntime = {
  active: false,
  timers: [],
  debounce: null,
  pendingReasons: new Set(),
  chain: Promise.resolve(),
  running: 0,
  idleWaiters: [],
  lastSyncAt: null,
  lastSyncError: null,
  lastResult: null,
  lastNotifiedAt: 0,
  watchFingerprint: null,
};

export function mailSyncInfo(): { lastSyncAt: string | null; lastSyncError: string | null; lastResult: MailSyncResult | null } {
  return { lastSyncAt: rt.lastSyncAt, lastSyncError: rt.lastSyncError, lastResult: rt.lastResult };
}

/** Recorded by changeEngine / infra ensure when a deployment fails (shown as lastSyncError). */
export function recordMailSyncError(message: string): void {
  rt.lastSyncError = message.slice(0, 1000);
}

function notifyFailure(message: string): void {
  const now = Date.now();
  if (now - rt.lastNotifiedAt < NOTIFY_DEDUP_MS) return;
  rt.lastNotifiedAt = now;
  notify('mail.serviceFailed', {
    tenantId: MASTER_TENANT_ID,
    key: 'mail:service',
    title: 'Service mail en échec',
    message: `La synchronisation du moteur mail a échoué : ${message}`,
    severity: 'critical',
    platform: true,
    link: '/settings?tab=mail',
  });
}

/** mail_domains.sync_error from the per-domain errors of the last sync (only rows that change). */
async function storeDomainErrors(errors: Record<string, string>): Promise<void> {
  const failing = Object.keys(errors);
  await db('mail_domains').whereNotNull('sync_error').modify((q) => { if (failing.length) q.whereNotIn('name', failing); })
    .update({ sync_error: null });
  for (const name of failing) {
    await db('mail_domains').where({ name }).update({ sync_error: String(errors[name]).slice(0, 1000) });
  }
}

interface AppliedMarker { at: string; count: number; engine: MailEngine }

async function dbNow(): Promise<string> {
  const r = await db.raw('SELECT now() AS t') as { rows?: Array<{ t: Date | string }> };
  const t = r.rows?.[0]?.t;
  return t instanceof Date ? t.toISOString() : t ? new Date(t).toISOString() : new Date().toISOString();
}

async function readApplied(): Promise<AppliedMarker | null> {
  try {
    const raw = await appConfigService.get(MAIL_SYNC_APPLIED_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<AppliedMarker>;
    if (typeof v.at !== 'string' || !Number.isFinite(Date.parse(v.at)) || typeof v.count !== 'number' || typeof v.engine !== 'string') return null;
    return { at: v.at, count: v.count, engine: v.engine as MailEngine };
  } catch {
    return null;
  }
}

async function saveApplied(marker: AppliedMarker): Promise<void> {
  try {
    await appConfigService.set(MAIL_SYNC_APPLIED_KEY, JSON.stringify(marker));
  } catch (err) {
    logger.warn({ err: errText(err) }, 'mail sync: last applied marker not saved');
  }
}

/** Forgets the marker (engine change: the new engine starts from nothing). */
export async function clearMailSyncApplied(): Promise<void> {
  try { await db('app_config').where({ key: MAIL_SYNC_APPLIED_KEY }).del(); } catch { /* the next sync rewrites it */ }
}

/**
 * Are ALL the mailboxes this state removes from the engine (vs the last
 * applied sync) explained by tombstones written since? removed = last count −
 * (mailboxes of the state that already existed then); explained = distinct
 * tombstoned addresses since then that are not back in the state. No marker /
 * another engine / nothing removed / any doubt ⇒ false (the guard stays).
 */
export async function removalsExplained(state: Pick<MailDesiredState, 'mailboxes'>, engine: MailEngine): Promise<boolean> {
  try {
    const marker = await readApplied();
    if (!marker || marker.engine !== engine) return false;
    const inState = new Set(state.mailboxes.map((m) => m.address.toLowerCase()));
    const created = await db('mailboxes').where('created_at', '>', marker.at).select('address') as Array<{ address: string }>;
    const fresh = created.filter((r) => inState.has(r.address.toLowerCase())).length;
    const removed = marker.count - (inState.size - fresh);
    if (removed <= 0) return false;
    const tombs = await db('mail_purge_queue').where({ kind: 'mailbox' }).where('created_at', '>', marker.at).distinct('name') as Array<{ name: string }>;
    const explained = new Set(tombs.map((t) => t.name.toLowerCase()).filter((n) => !inState.has(n)));
    return removed <= explained.size;
  } catch (err) {
    logger.warn({ err: errText(err) }, 'mail sync: removal explanation failed (guard kept)');
    return false;
  }
}

/** One synchronisation (serialized by the caller): its result, null when it failed. Never throws. */
async function performSync(opts: { reason: string; force: boolean; ensureNetwork: boolean }): Promise<MailSyncResult | null> {
  let driver: MailDriver;
  try {
    driver = await activeMailDriver();
  } catch (err) {
    rt.lastSyncError = `Mail driver unavailable: ${errText(err)}`;
    notifyFailure(rt.lastSyncError);
    return null;
  }
  if (!driver.capabilities.supported) {
    rt.lastSyncError = `The ${driver.engine} mail engine is not supported yet`;
    return null;
  }
  try {
    if (opts.ensureNetwork && mailEngineHasMailboxes(driver.engine)) {
      await ensureMailNetwork((line) => logger.debug({ line }, 'mail network'));
    }
    const loadedAt = await dbNow();
    const state = await loadDesiredState();
    let result: MailSyncResult;
    try {
      result = await driver.sync(state, { reason: opts.reason, allowMassRemoval: opts.force });
    } catch (err) {
      const massRemoval = err instanceof MailDriverError && err.code === 'massRemoval';
      if (opts.force || !massRemoval || !(await removalsExplained(state, driver.engine))) throw err;
      logger.info({ reason: opts.reason }, 'mail sync: mass removal explained by deletions (tombstones): applied');
      result = await driver.sync(state, { reason: `${opts.reason} (deletions)`, allowMassRemoval: true });
    }
    // The engine accepted a configuration built from this state: certificate
    // copies it no longer references can go (never before: a configuration
    // still using them would fail to compile at the next engine start).
    try {
      (await import('./tls/mailTls.service')).purgeUnusedCertificateCopies(state.tls);
    } catch (err) {
      logger.warn({ err: errText(err) }, 'mail sync: certificate copy purge failed');
    }
    await saveApplied({ at: loadedAt, count: state.mailboxes.length, engine: driver.engine });
    rt.lastResult = result;
    rt.lastSyncAt = new Date().toISOString();
    await storeDomainErrors(result.domainErrors ?? {});
    const failing = Object.keys(result.domainErrors ?? {});
    rt.lastSyncError = result.ok && failing.length === 0 ? null
      : failing.length ? `Synchronisation partielle : ${failing.length} domaine(s) en échec (${failing.slice(0, 5).join(', ')})`
        : 'Synchronisation partielle';
    if (rt.lastSyncError) notifyFailure(rt.lastSyncError);
    if (result.changed || failing.length) emitMail({ entity: 'engine', id: 0, accountId: null, action: 'updated' }, { tenantId: null, accountId: null });
    logger.info({ reason: opts.reason, changed: result.changed, domains: result.domains, mailboxes: result.mailboxes, aliases: result.aliases,
      failing: failing.length, ms: result.durationMs }, 'mail engine synchronised');
    return result;
  } catch (err) {
    const massRemoval = err instanceof MailDriverError && err.code === 'massRemoval';
    const text = err instanceof MailDriverError ? [err.message, err.detail].filter(Boolean).join(' : ') : errText(err);
    rt.lastSyncError = massRemoval
      ? `${text} (garde contre la suppression de masse : forcer la synchronisation depuis les réglages si c'est voulu)`
      : text.slice(0, 1000);
    logger.error({ reason: opts.reason, err: text, code: err instanceof MailDriverError ? err.code : undefined }, 'mail engine synchronisation failed');
    notifyFailure(rt.lastSyncError);
    emitMail({ entity: 'engine', id: 0, accountId: null, action: 'updated' }, { tenantId: null, accountId: null });
    return null;
  }
}

function enqueue(job: () => Promise<void>): Promise<void> {
  rt.running++;
  const run = rt.chain.then(job, job).finally(() => {
    rt.running--;
    if (rt.running === 0 && !rt.debounce) for (const w of rt.idleWaiters.splice(0)) w();
  });
  rt.chain = run.catch(() => undefined);
  return run;
}

/**
 * Runs `job` alone on the sync chain (no sync, purge or other job meanwhile).
 * `syncInline` performs a sync INSIDE the job (runSyncNow there would wait for
 * the job itself). Rejects with the job's error.
 */
export function runMailExclusive<T>(job: (syncInline: (reason: string) => Promise<void>) => Promise<T>): Promise<T> {
  let out: T;
  const inline = async (reason: string) => { await performSync({ reason, force: false, ensureNetwork: false }); };
  return enqueue(async () => { out = await job(inline); }).then(() => out);
}

/** Runs one sync now (serialized after the running one). Never throws. */
export function runSyncNow(opts: { reason: string; force?: boolean; ensureNetwork?: boolean }): Promise<void> {
  return enqueue(async () => { await performSync({ reason: opts.reason, force: !!opts.force, ensureNetwork: !!opts.ensureNetwork }); });
}

/** The queued (not yet started) shared sync of runCoalescedSync, if any. */
let sharedSync: { promise: Promise<MailSyncResult | null>; started: boolean } | null = null;

/**
 * A sync whose desired state is read AFTER this call, shared by every caller
 * arriving before it starts (webmail SSO: N logins at once wait for ONE sync
 * after the running one, not N full engine reloads in a row). Resolves with
 * that sync's result, null when it failed. Never throws.
 */
export function runCoalescedSync(reason: string): Promise<MailSyncResult | null> {
  if (sharedSync && !sharedSync.started) return sharedSync.promise;
  const entry = { started: false } as { promise: Promise<MailSyncResult | null>; started: boolean };
  let out: MailSyncResult | null = null;
  entry.promise = enqueue(async () => {
    entry.started = true;
    if (sharedSync === entry) sharedSync = null;
    out = await performSync({ reason, force: false, ensureNetwork: false });
  }).then(() => out, () => null);
  sharedSync = entry;
  return entry.promise;
}

function flushDebounced(): void {
  rt.debounce = null;
  if (rt.pendingReasons.size === 0) return;
  const reason = [...rt.pendingReasons].slice(0, 5).join(', ');
  rt.pendingReasons.clear();
  void runSyncNow({ reason });
}

/** Debounced (500 ms), serialized sync request. Never throws. */
export function requestMailSync(reason: string): void {
  try {
    // Bounded: with the workers off nothing ever drains the set (one sync covers every reason anyway).
    if (rt.pendingReasons.size < 20) rt.pendingReasons.add(String(reason || 'change').slice(0, 100));
    else rt.pendingReasons.add('…');
    if (!rt.active) return;
    if (rt.debounce) clearTimeout(rt.debounce);
    rt.debounce = setTimeout(flushDebounced, SYNC_DEBOUNCE_MS);
    rt.debounce.unref?.();
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'mail requestSync failed');
  }
}

/** Resolves once no sync is pending / running, or after timeoutMs (false). */
export function whenMailSyncIdle(timeoutMs = 10_000): Promise<boolean> {
  if (rt.running === 0 && !rt.debounce) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    rt.idleWaiters.push(() => { clearTimeout(timer); resolve(true); });
  });
}

async function safeDriverTask(what: string, task: (driver: MailDriver) => Promise<unknown>): Promise<void> {
  try {
    const driver = await activeMailDriver();
    if (!driver.capabilities.supported) return;
    await task(driver);
  } catch (err) {
    logger.warn({ err: errText(err), task: what }, 'mail worker task failed');
  }
}

export function pollUsageNow(): Promise<void> {
  return safeDriverTask('usage', (d) => pollMailUsage(d));
}

/** On the sync chain: never runs during an engine change (old driver) nor during a sync. */
export function purgeNow(): Promise<void> {
  return enqueue(() => safeDriverTask('purge', (d) => runPurgeQueue(d)));
}

/** Fingerprint of what P1/P2 code changes without a mail hook (tombstones, D1 verification of the mail domains). */
async function watchFingerprint(): Promise<string> {
  const q = await db('mail_purge_queue').first(db.raw('COALESCE(MAX(id), 0) AS m'), db.raw('COUNT(*) AS n')) as { m: unknown; n: unknown } | undefined;
  const v = await db('mail_domains as md').leftJoin('domains as d', 'd.id', 'md.domain_id')
    .first(db.raw("COALESCE(md5(string_agg(md.id || ':' || COALESCE(d.verification_status, '-'), ',' ORDER BY md.id)), '') AS h")) as
    { h: unknown } | undefined;
  return `${String(q?.m ?? 0)}/${String(q?.n ?? 0)}/${String(v?.h ?? '')}`;
}

/** Requests a sync when the fingerprint moved since the last check (the first check only records it). Never throws. */
export async function checkMailWatch(): Promise<boolean> {
  try {
    const fp = await watchFingerprint();
    const before = rt.watchFingerprint;
    rt.watchFingerprint = fp;
    if (before === null || before === fp) return false;
    requestMailSync('deletions / domain verification changed');
    return true;
  } catch (err) {
    logger.warn({ err: errText(err) }, 'mail watch failed');
    return false;
  }
}

/** Starts the timers; returns at once, never throws, survives a missing Docker (every task catches). */
export function startMailSync(): void {
  try {
    if (rt.active) return;
    rt.active = true;
    const boot = setTimeout(() => {
      void runSyncNow({ reason: 'boot', ensureNetwork: true });
      void pollUsageNow();
    }, BOOT_DELAY_MS);
    const full = setInterval(() => { void runSyncNow({ reason: 'periodic', ensureNetwork: true }); }, FULL_SYNC_MS);
    const usage = setInterval(() => { void pollUsageNow(); }, USAGE_MS);
    const purge = setInterval(() => { void purgeNow(); }, PURGE_MS);
    const watch = setInterval(() => { void checkMailWatch(); }, WATCH_MS);
    void checkMailWatch();
    rt.timers = [boot, full, usage, purge, watch];
    for (const t of rt.timers) t.unref?.();
    // Requests made before the start (boot hooks) run now (debounced).
    if (rt.pendingReasons.size) {
      rt.debounce = setTimeout(flushDebounced, SYNC_DEBOUNCE_MS);
      rt.debounce.unref?.();
    }
  } catch (err) {
    logger.error({ err: (err as Error)?.message }, 'mail worker failed to start');
  }
}

export function stopMailSync(): void {
  rt.active = false;
  for (const t of rt.timers) { clearTimeout(t); clearInterval(t); }
  rt.timers = [];
  if (rt.debounce) clearTimeout(rt.debounce);
  rt.debounce = null;
  for (const w of rt.idleWaiters.splice(0)) w();
}

/** Tests: forget the in-memory state. */
export function resetMailSyncForTests(): void {
  stopMailSync();
  rt.pendingReasons.clear();
  rt.lastSyncAt = null;
  rt.lastSyncError = null;
  rt.lastResult = null;
  rt.lastNotifiedAt = 0;
  rt.watchFingerprint = null;
  sharedSync = null;
}
