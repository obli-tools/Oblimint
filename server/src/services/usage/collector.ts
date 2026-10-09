import { db } from '../../db';
import { logger } from '../../utils/logger';
import { engineFor, localNodeId } from '../docker/engine';
import { platformSettings } from '../platformSettings';
import { commitEdgeLogCheckpoint, edgeLogPosition, subscribeEdgeLog } from './edgeLog';
import { collectSamples, insertSamples, purgeResources, rollupHours } from './resources';
import { TrafficAggregator, flushTraffic } from './traffic';

// ─────────────────────────────────────────────────────────────────────────────
// Usage collector workers (module usage, docs/P2-PLAN.md §9.5), started by
// workers/index.ts unless OBLIMINT_USAGE_COLLECTOR=off:
//   - traffic: subscribed to the edge log follower, aggregated in memory,
//     flushed every 60 s (additive upsert); the follower checkpoint is
//     committed only after a successful flush (exact resume after a restart);
//   - resources: one-shot docker stats of the tenant containers every 60 s,
//     hourly roll-up, retention purge (hourly);
//   - disk: hosting/usage.service.ts measures every 10 min and writes the
//     daily point (usage_disk_daily) — nothing to do here.
// start() returns at once and never throws; every pass survives an absent
// Docker / database (logged, retried at the next tick).
// ─────────────────────────────────────────────────────────────────────────────

export const FLUSH_INTERVAL_MS = 60 * 1000;
export const SAMPLE_INTERVAL_MS = 60 * 1000;
const HOUR_MS = 3600 * 1000;

const aggregator = new TrafficAggregator();
let unsubscribe: (() => void) | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let sampleTimer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;
let sampling = false;
let lastRolledHour = 0;
let lastPurge = 0;
let dockerWarned = false;
let lastDroppedLogged = 0;

/** Flushes the aggregated traffic; on failure the buckets go back to the aggregator. */
export function flushNow(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    // Position and buckets taken at the same instant: every line delivered up
    // to `mark` is in `buckets` (listeners run synchronously).
    const mark = edgeLogPosition();
    const buckets = aggregator.drain();
    if (aggregator.dropped !== lastDroppedLogged) {
      logger.warn({ dropped: aggregator.dropped }, 'Traffic aggregator full: lines dropped');
      lastDroppedLogged = aggregator.dropped;
    }
    if (buckets.length === 0) {
      await commitEdgeLogCheckpoint(mark);
      return;
    }
    try {
      await flushTraffic(buckets);
      await commitEdgeLogCheckpoint(mark);
    } catch (err) {
      aggregator.restore(buckets);
      logger.warn({ err, buckets: buckets.length }, 'Traffic flush failed (kept for the next one)');
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

async function samplePass(now: Date = new Date()): Promise<void> {
  if (sampling) return;
  sampling = true;
  try {
    const at = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    try {
      const docker = await engineFor(await localNodeId());
      const rows = await collectSamples(docker, at);
      await insertSamples(rows);
      dockerWarned = false;
    } catch (err) {
      if (!dockerWarned) logger.warn({ err: (err as Error)?.message ?? err }, 'Resource sampling failed (Docker unavailable?)');
      dockerWarned = true;
    }
    const hour = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
    if (hour !== lastRolledHour) {
      // Previous hours again (idempotent): late samples and a panel restart are covered.
      await rollupHours(new Date(hour - 3 * HOUR_MS), new Date(hour));
      lastRolledHour = hour;
    }
    if (now.getTime() - lastPurge >= HOUR_MS) {
      const { resourceRetentionDays } = await platformSettings.section('usage');
      await purgeResources(resourceRetentionDays, db, now);
      lastPurge = now.getTime();
    }
  } catch (err) {
    logger.warn({ err }, 'Resource roll-up / retention failed');
  } finally {
    sampling = false;
  }
}

export const usageCollector = {
  start(): void {
    if (flushTimer) return;
    try {
      unsubscribe = subscribeEdgeLog((entry) => aggregator.add(entry));
    } catch (err) {
      logger.warn({ err }, 'Edge log subscription failed');
    }
    flushTimer = setInterval(() => { void flushNow(); }, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
    sampleTimer = setInterval(() => { void samplePass(); }, SAMPLE_INTERVAL_MS);
    sampleTimer.unref?.();
  },

  stop(): void {
    if (flushTimer) clearInterval(flushTimer);
    if (sampleTimer) clearInterval(sampleTimer);
    flushTimer = null;
    sampleTimer = null;
    try { unsubscribe?.(); } catch { /* stopping */ }
    unsubscribe = null;
    // Last flush of what was aggregated (best effort while exiting).
    void flushNow();
  },
};

/** Tests: the aggregator fed by the subscription. */
export const collectorForTests = { aggregator, samplePass };
