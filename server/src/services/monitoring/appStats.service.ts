import type Docker from 'dockerode';
import type { AppStatsResponse, ContainerStatsPoint } from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { loadStack } from '../apps/access';
import { appsService } from '../apps/apps.service';
import { engineFor } from '../docker/engine';
import type { HostingActor } from '../hosting/access';
import { cpuPercent, cpuReading, memoryBytes, type DockerStatsLike } from '../usage/resources';

// ─────────────────────────────────────────────────────────────────────────────
// Container stats of an app stack (docs/P4b-PLAN.md §10.4): a live one-shot
// `docker stats` of each container of the stack (apps-core
// stackContainers) + the history of usage_resource_samples attributed to
// the stack (app_stack_id, set by the P2 collector from the container label
// oblimint.app). Docker absent / a container stopped ⇒ current null (the
// history still answers). Range 7d is averaged per hour.
// ─────────────────────────────────────────────────────────────────────────────

export type AppStatsRange = '1h' | '6h' | '24h' | '7d';
const RANGE_MS: Record<AppStatsRange, number> = { '1h': 3_600_000, '6h': 6 * 3_600_000, '24h': 24 * 3_600_000, '7d': 7 * 86_400_000 };
const STATS_TIMEOUT_MS = 5_000;

interface LiveStats extends DockerStatsLike {
  memory_stats?: DockerStatsLike['memory_stats'] & { limit?: number };
  pids_stats?: { current?: number };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error('stats timed out')), ms); })]).finally(() => clearTimeout(t));
}

/** Current figures of one stats answer (pure). */
export function currentOf(s: LiveStats): { cpuPct: number; memBytes: number; memLimitBytes: number | null; pids: number | null } {
  const limit = Number(s.memory_stats?.limit);
  const pids = Number(s.pids_stats?.current);
  return {
    cpuPct: cpuPercent(cpuReading(s.cpu_stats), cpuReading(s.precpu_stats)),
    memBytes: memoryBytes(s.memory_stats),
    // cgroup "no limit" reads as a huge number (PAGE_COUNTER_MAX): reported as null.
    memLimitBytes: Number.isFinite(limit) && limit > 0 && limit < 2 ** 60 ? limit : null,
    pids: Number.isFinite(pids) && pids >= 0 ? pids : null,
  };
}

let engineOverride: ((nodeId: number) => Promise<Docker>) | null = null;

export function setAppStatsEngineForTests(f: ((nodeId: number) => Promise<Docker>) | null): void {
  engineOverride = f;
}

export const appStatsService = {
  async stats(actor: HostingActor, stackId: number, range: AppStatsRange, now: Date = new Date()): Promise<AppStatsResponse> {
    const stack = await loadStack(actor, stackId, 'read');
    let containers: Array<{ service: string; container: string }> = [];
    try {
      containers = await appsService.stackContainers(Number(stack.id));
    } catch (err) {
      logger.debug({ err: (err as Error)?.message, stackId }, 'stackContainers unavailable: history only');
    }

    const live = new Map<string, ReturnType<typeof currentOf> | null>();
    if (containers.length > 0) {
      try {
        const docker = await (engineOverride ?? engineFor)(Number(stack.node_id));
        await Promise.all(containers.map(async (c) => {
          try {
            const s = await withTimeout(docker.getContainer(c.container).stats({ stream: false }) as unknown as Promise<LiveStats>, STATS_TIMEOUT_MS);
            live.set(c.container, currentOf(s));
          } catch {
            live.set(c.container, null);
          }
        }));
      } catch (err) {
        logger.debug({ err: (err as Error)?.message, stackId }, 'Docker unavailable: no live stats');
      }
    }

    const from = new Date(now.getTime() - RANGE_MS[range]);
    const hourly = range === '7d';
    const rows = await (hourly
      ? db('usage_resource_samples').where({ app_stack_id: stack.id }).andWhere('at', '>=', from)
        .groupByRaw(`container, date_trunc('hour', at)`).orderByRaw(`date_trunc('hour', at)`)
        .select('container', db.raw(`date_trunc('hour', at) AS at`), db.raw('AVG(cpu_pct) AS cpu_pct'), db.raw('ROUND(AVG(mem_bytes))::bigint AS mem_bytes'))
      : db('usage_resource_samples').where({ app_stack_id: stack.id }).andWhere('at', '>=', from).orderBy('at')
        .select('container', 'at', 'cpu_pct', 'mem_bytes')) as Array<{ container: string; at: Date | string; cpu_pct: number | string; mem_bytes: number | string }>;
    const series = new Map<string, ContainerStatsPoint[]>();
    for (const r of rows) {
      let list = series.get(r.container);
      if (!list) series.set(r.container, (list = []));
      list.push({ at: new Date(r.at).toISOString(), cpuPct: Math.round(Number(r.cpu_pct) * 100) / 100, memBytes: Number(r.mem_bytes) });
    }

    const services: AppStatsResponse['services'] = containers.map((c) => ({
      service: c.service,
      container: c.container,
      current: live.get(c.container) ?? null,
      series: series.get(c.container) ?? [],
    }));
    // Containers with history but gone from the stack (recreated, service removed): history only.
    const known = new Set(containers.map((c) => c.container));
    for (const [container, points] of series) {
      if (known.has(container)) continue;
      services.push({ service: container, container, current: null, series: points });
    }
    return { stackId: Number(stack.id), services };
  },
};
