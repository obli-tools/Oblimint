import { logger } from '../../utils/logger';
import { registerEdgeContributor, unregisterEdgeContributor } from '../edge/contributors';
import { platformSettings } from '../platformSettings';
import { geoipService } from '../security/geoip.service';
import { subscribeEdgeLog } from '../usage/edgeLog';
import { handleCertificateInstalled, recoverInterruptedRuns, SCHEDULER_TICK_MS, workflowSchedulerTick } from './automation/workflows.service';
import { ProxyTrafficAggregator } from './traffic/aggregate';
import { flushProxyTraffic, purgeTraffic, rollupTrafficHours } from './traffic/store';

// ─────────────────────────────────────────────────────────────────────────────
// Workers of the monitoring-automation module (docs/P4b-PLAN.md §17), started
// by workers/index.ts unless OBLIMINT_P4B_WORKERS=off. start() returns at once
// and never throws; every pass survives an absent Docker / database (logged,
// retried at the next tick).
//   traffic   — edge log subscription (the P2 follower: nothing runs without
//               Docker) → per-minute buckets, flushed every 60 s (restored on
//               failure), hourly roll-up of the last hours (idempotent) AND
//               of every older hour a flush wrote minutes into (late lines,
//               buckets kept through a long database outage), retention
//               hourly;
//   workflows — runs cut by a restart closed at start, interval / cron
//               scheduler every 30 s + the cert-renewal trigger (edge
//               contributor 'workflows', onCertificateInstalled).
// The uptime worker is uptimeService.start().
// ─────────────────────────────────────────────────────────────────────────────

export const TRAFFIC_FLUSH_MS = 60_000;
const HOUR_MS = 3_600_000;

const aggregator = new ProxyTrafficAggregator();
let unsubscribe: (() => void) | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;
let lastRolledHour = 0;
/** Start of the oldest hour a successful flush wrote minutes into since the last roll-up (null = none). */
let dirtyFromHour: number | null = null;
let lastPurge = 0;
let lastDroppedLogged = 0;

/** Flushes the aggregated traffic (restored on failure), then roll-up / retention when due. */
export function flushTrafficNow(now: Date = new Date()): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    const drained = aggregator.drain();
    if (aggregator.dropped !== lastDroppedLogged) {
      logger.warn({ dropped: aggregator.dropped }, 'Proxy traffic aggregator full: lines dropped');
      lastDroppedLogged = aggregator.dropped;
    }
    try {
      await flushProxyTraffic(drained, { lookupMany: (ips) => geoipService.lookupMany(ips) });
      for (const m of drained.minutes) {
        const t = Date.parse(m.minute);
        if (!Number.isFinite(t)) continue;
        const h = Math.floor(t / HOUR_MS) * HOUR_MS;
        if (dirtyFromHour === null || h < dirtyFromHour) dirtyFromHour = h;
      }
    } catch (err) {
      aggregator.restore(drained);
      logger.warn({ err: (err as Error)?.message, minutes: drained.minutes.length }, 'Proxy traffic flush failed (kept for the next one)');
      return;
    }
    try {
      const hour = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
      const dirty = dirtyFromHour;
      if (hour !== lastRolledHour || (dirty !== null && dirty < hour)) {
        // The previous hours again (idempotent): late lines and a panel restart are covered — and every older
        // hour a flush touched since the last roll-up (otherwise its minutes never reach proxy_traffic_hour).
        const from = Math.min(hour - 3 * HOUR_MS, dirty ?? Infinity);
        await rollupTrafficHours(new Date(from), new Date(hour));
        lastRolledHour = hour;
        // Only the hours rolled are clean: minutes of the current hour stay dirty for the next roll-up.
        if (dirtyFromHour === dirty) dirtyFromHour = dirty !== null && dirty >= hour ? dirty : null;
      }
      if (now.getTime() - lastPurge >= HOUR_MS) {
        const s = await platformSettings.section('monitoring');
        await purgeTraffic(s.trafficMinuteDays, s.trafficHourDays, now);
        lastPurge = now.getTime();
      }
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, 'Proxy traffic roll-up / retention failed');
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

export const trafficWorker = {
  start(): void {
    if (flushTimer) return;
    try {
      unsubscribe = subscribeEdgeLog((entry) => aggregator.add(entry));
    } catch (err) {
      logger.warn({ err }, 'Edge log subscription failed (proxy traffic)');
    }
    flushTimer = setInterval(() => { void flushTrafficNow(); }, TRAFFIC_FLUSH_MS);
    flushTimer.unref?.();
  },

  stop(): void {
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = null;
    try { unsubscribe?.(); } catch { /* stopping */ }
    unsubscribe = null;
    void flushTrafficNow();
  },
};

// ── workflows ────────────────────────────────────────────────────────────────

let workflowTimer: NodeJS.Timeout | null = null;
let workflowTicking = false;
const certQueue = new Map<string, string[]>();
let certTimer: NodeJS.Timeout | null = null;

function drainCertQueue(): void {
  certTimer = null;
  const items = [...certQueue.entries()];
  certQueue.clear();
  void (async () => {
    for (const [primary, names] of items) {
      try {
        const n = await handleCertificateInstalled(primary, names);
        if (n > 0) logger.info({ certificate: primary, runs: n }, 'cert-renewal workflows started');
      } catch (err) {
        logger.warn({ err: (err as Error)?.message, certificate: primary }, 'cert-renewal trigger failed');
      }
    }
  })();
}

export const workflowWorker = {
  start(): void {
    if (workflowTimer) return;
    // Runs of a previous process (single panel process): closed as failed, workflows released.
    void recoverInterruptedRuns();
    try {
      registerEdgeContributor({
        id: 'workflows',
        onCertificateInstalled(primaryName: string, names: string[]) {
          // Synchronous and fast (contract): queued, handled a moment later.
          certQueue.set(primaryName, Array.isArray(names) ? names.slice(0, 100) : []);
          if (!certTimer) {
            certTimer = setTimeout(drainCertQueue, 2_000);
            certTimer.unref?.();
          }
        },
      });
    } catch (err) {
      logger.warn({ err }, 'Workflow cert-renewal trigger not registered');
    }
    workflowTimer = setInterval(() => {
      if (workflowTicking) return;
      workflowTicking = true;
      void workflowSchedulerTick()
        .catch((err) => logger.warn({ err: (err as Error)?.message }, 'Workflow scheduler pass failed'))
        .finally(() => { workflowTicking = false; });
    }, SCHEDULER_TICK_MS);
    workflowTimer.unref?.();
  },

  stop(): void {
    if (workflowTimer) clearInterval(workflowTimer);
    workflowTimer = null;
    if (certTimer) clearTimeout(certTimer);
    certTimer = null;
    try { unregisterEdgeContributor('workflows'); } catch { /* stopping */ }
  },
};

/** Tests: the aggregator fed by the subscription. */
export const trafficWorkerForTests = { aggregator };
