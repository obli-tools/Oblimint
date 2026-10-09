import type { HostdEvent } from '../hostd/client';
import { logger } from '../../utils/logger';
import { errText } from '../setup/docker';
import { deps } from './deps';
import { ingestAccount, resyncAll } from './ingest';
import { forgetWatch, queueWatchSyncAll } from './watch';

// ─────────────────────────────────────────────────────────────────────────────
// hostd event consumer (P3-PLAN §12): long poll of hostd's event queue on the
// local node, like the gateway events of services/firewall.
//   quarantined → ingestAccount(accountId) (lists the account's store once per
//                 batch: the full entry, plus whatever else changed);
//   watchError  → logged; the site's pushed spec is forgotten so that the next
//                 sync (reconcile pass, settings change) re-pushes it;
//   windowLost  → logged only: the overlay belongs to the windows module,
//                 whose recovery (boot, periodic check) repairs it and owns
//                 the 'window.failed' notification — a second alert from
//                 here would duplicate it.
// hostd restarted (seq starts again at 1: next < since, or an event at or
// below the cursor) → cursor back to 0, full resync of the quarantine rows
// and forced re-push of every watch (hostd's watches live in memory).
// The seq test alone misses a restart when the cursor is 0 (no event ever
// emitted) or low (the new process already emitted past it before the next
// poll), so any poll that FAILED (hostd down, socket gone: what a restart
// looks like from here) makes the next successful poll handle it as a restart
// too. A transient error costs one forced re-push + resync, nothing more
// (both are idempotent).
// ─────────────────────────────────────────────────────────────────────────────

export const EVENTS_WAIT_SEC = 50;

let since = 0;

export function eventCursor(): number { return since; }
export function resetEventCursor(): void { since = 0; unreachable = false; }

/** Set when a poll failed: hostd may have restarted (its watches are gone). */
let unreachable = false;
/** The event loop saw hostd fail; the next successful poll is handled as a restart. */
export function markHostdUnreachable(): void { unreachable = true; }

/** Called when hostd restarted; replaced by the service (full resync scheduling). */
let onHostdRestart: (() => void) | null = null;
export function setHostdRestartHandler(fn: (() => void) | null): void { onHostdRestart = fn; }

export async function handleEvents(events: HostdEvent[]): Promise<{ accounts: number }> {
  const accounts = new Set<number>();
  for (const e of events) {
    if (!e || !Number.isInteger(e.accountId) || e.accountId <= 0) continue;
    switch (e.kind) {
      case 'quarantined':
        accounts.add(e.accountId);
        break;
      case 'watchError':
        logger.warn({ accountId: e.accountId, siteId: e.siteId, message: e.message }, 'hostd: typed-path watch error');
        forgetWatch(e.accountId, e.siteId);
        break;
      case 'windowLost':
        logger.warn({ accountId: e.accountId, siteId: e.siteId, windowId: e.windowId, message: e.message }, 'hostd: window overlay lost (windows module repairs it)');
        break;
      default:
        logger.debug({ kind: (e as { kind?: unknown }).kind }, 'hostd: unknown event ignored');
    }
  }
  for (const id of accounts) {
    try {
      await ingestAccount(id);
    } catch (err) {
      // The 10-min resync catches it up.
      logger.warn({ accountId: id, err: errText(err) }, 'quarantine: entries of the account not ingested');
    }
  }
  return { accounts: accounts.size };
}

/** One long poll + handling. Throws when hostd is unreachable (the loop backs off). Exported for tests. */
export async function pollEventsOnce(waitSec = EVENTS_WAIT_SEC): Promise<{ events: number; restarted: boolean }> {
  const hostd = deps.hostd(await deps.localNode());
  const r = await hostd.events(since, waitSec);
  const seqReset = r.next < since || (since > 0 && r.events.some((e) => e.seq <= since));
  const restarted = seqReset || unreachable;
  if (restarted) {
    logger.info({ cursor: since, next: r.next, seqReset, afterError: unreachable }, 'hostd restarted or back after an error: quarantine resync');
    unreachable = false;
    since = 0;
    onHostdRestart?.();
    // The events of the new process are fetched again from 0 at the next poll (ingestion is idempotent).
    return { events: 0, restarted: true };
  }
  if (r.events.length) await handleEvents(r.events);
  since = Math.max(since, r.next, ...r.events.map((e) => e.seq));
  return { events: r.events.length, restarted: false };
}

let loopRunning = false;

/** The worker loop: runs while isRunning(), backs off (5 s … 60 s) when hostd is unreachable. */
export async function eventLoop(isRunning: () => boolean): Promise<void> {
  if (loopRunning) return;
  loopRunning = true;
  let backoff = 0;
  try {
    while (isRunning()) {
      try {
        await pollEventsOnce();
        backoff = 0;
      } catch (err) {
        markHostdUnreachable();
        backoff = Math.min(60_000, Math.max(5_000, backoff * 2));
        logger.debug({ err: errText(err), retryInMs: backoff }, 'hostd events unavailable');
        await new Promise((r) => { const t = setTimeout(r, backoff); t.unref?.(); });
      }
    }
  } finally {
    loopRunning = false;
  }
}

/** Default restart handler: full resync + forced watch re-push. */
export function defaultHostdRestart(): void {
  queueWatchSyncAll('hostd-restart', true);
  void resyncAll().catch((err) => logger.warn({ err: errText(err) }, 'quarantine resync failed'));
}
