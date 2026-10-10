import type Docker from 'dockerode';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { engineFor, localNodeId } from '../docker/engine';
import { P4B_LABELS } from '../hosting/naming';
import { platformSettings } from '../platformSettings';
import { commitEdgeLogCheckpoint, edgeLogPosition, subscribeEdgeLog } from './edgeLog';
import { collectSamples, insertSamples, purgeResources, rollupHours, type SampleRow } from './resources';
import { TrafficAggregator, flushTraffic } from './traffic';

// ─────────────────────────────────────────────────────────────────────────────
// Usage collector workers (module usage, docs/P2-PLAN.md §9.5), started by
// workers/index.ts unless OBLIMINT_USAGE_COLLECTOR=off:
//   - traffic: subscribed to the edge log follower, aggregated in memory,
//     flushed every 60 s (additive upsert); the follower checkpoint is
//     committed only after a successful flush (exact resume after a restart);
//   - resources: one-shot docker stats of the tenant containers every 60 s,
//     hourly roll-up, retention purge (hourly); P4b: a sample of an app
//     container (label oblimint.app) carries its stack (app_stack_id,
//     docs/P4b-PLAN.md §10.4 — module monitoring-automation);
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

/** Container name → app_stacks.id of the running app containers (label oblimint.app). Empty when Docker fails. */
async function appContainerStacks(docker: Docker): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const list = await docker.listContainers({ all: false, filters: { label: [P4B_LABELS.app] } } as never) as unknown as
      Array<{ Id: string; Names?: string[]; Labels?: Record<string, string> }>;
    for (const c of list) {
      const id = Number(c.Labels?.[P4B_LABELS.app]);
      if (!Number.isInteger(id) || id <= 0) continue;
      out.set((c.Names?.[0] ?? c.Id).replace(/^\//, '').slice(0, 128), id);
    }
  } catch (err) {
    logger.debug({ err: (err as Error)?.message }, 'App containers not listed: samples without app_stack_id');
  }
  return out;
}

/** Sets app_stack_id on the samples of app containers (pure; same container naming as collectSamples). */
export function attributeAppStacks(rows: SampleRow[], stacks: ReadonlyMap<string, number>): Array<SampleRow & { app_stack_id: number | null }> {
  return rows.map((r) => ({ ...r, app_stack_id: stacks.get(r.container) ?? null }));
}

async function samplePass(now: Date = new Date()): Promise<void> {
  if (sampling) return;
  sampling = true;
  try {
    const at = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    try {
      const docker = await engineFor(await localNodeId());
      const rows = await collectSamples(docker, at);
      const stacks = rows.length > 0 ? await appContainerStacks(docker) : new Map<string, number>();
      await insertSamples(attributeAppStacks(rows, stacks));
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
