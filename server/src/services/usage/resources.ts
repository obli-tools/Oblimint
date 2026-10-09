import type Docker from 'dockerode';
import type { Knex } from 'knex';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { LABELS, P2_LABELS } from '../hosting/naming';

// ─────────────────────────────────────────────────────────────────────────────
// Resource samples (module usage, docs/P2-PLAN.md §9.5): one-shot
// `docker stats` (no stream) of every oblimint.internal=true container that
// carries an account label (sites, file servers, database instances) every
// 60 s → usage_resource_samples; hourly roll-up into usage_resource_hourly;
// retention. CPU % from two readings (precpu_stats of the one-shot answer, or
// our previous reading of the container), memory = usage − page cache
// (inactive_file on cgroup v2, total_inactive_file / cache on v1), as the
// docker CLI computes them.
// ─────────────────────────────────────────────────────────────────────────────

/** Subset of the Docker stats answer used here. */
export interface DockerStatsLike {
  read?: string;
  cpu_stats?: { cpu_usage?: { total_usage?: number; percpu_usage?: number[] }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number; percpu_usage?: number[] }; system_cpu_usage?: number; online_cpus?: number };
  memory_stats?: { usage?: number; stats?: Record<string, number | undefined> };
}

export interface CpuReading { total: number; system: number; online: number }

export function cpuReading(s: DockerStatsLike['cpu_stats']): CpuReading | null {
  const total = Number(s?.cpu_usage?.total_usage);
  const system = Number(s?.system_cpu_usage);
  if (!Number.isFinite(total) || !Number.isFinite(system) || system <= 0) return null;
  const online = Number(s?.online_cpus) || s?.cpu_usage?.percpu_usage?.length || 1;
  return { total, system, online };
}

/**
 * CPU % (100 = one full core, as `docker stats`) between two readings. 0 when
 * the readings cannot be compared (first sample, counter reset).
 */
export function cpuPercent(cur: CpuReading | null, prev: CpuReading | null): number {
  if (!cur || !prev) return 0;
  const cpuDelta = cur.total - prev.total;
  const sysDelta = cur.system - prev.system;
  if (cpuDelta <= 0 || sysDelta <= 0) return 0;
  const pct = (cpuDelta / sysDelta) * cur.online * 100;
  return Number.isFinite(pct) ? Math.round(pct * 100) / 100 : 0;
}

/** Memory in use without the page cache (never negative). */
export function memoryBytes(m: DockerStatsLike['memory_stats']): number {
  const usage = Number(m?.usage);
  if (!Number.isFinite(usage) || usage <= 0) return 0;
  const st = m?.stats ?? {};
  const cache = st.inactive_file ?? st.total_inactive_file ?? st.cache ?? 0;
  return Math.max(0, Math.round(usage - (Number(cache) || 0)));
}

/** Previous CPU reading per container (fallback when precpu_stats is empty). */
const previous = new Map<string, CpuReading>();

/** CPU % + memory of one stats answer; remembers the reading for the next call. */
export function sampleOf(container: string, stats: DockerStatsLike): { cpuPct: number; memBytes: number } {
  const cur = cpuReading(stats.cpu_stats);
  const pre = cpuReading(stats.precpu_stats) ?? previous.get(container) ?? null;
  if (cur) previous.set(container, cur);
  return { cpuPct: cpuPercent(cur, pre), memBytes: memoryBytes(stats.memory_stats) };
}

export interface SampleRow {
  at: Date;
  account_id: number;
  site_id: number | null;
  db_instance_id: number | null;
  container: string;
  role: string;
  cpu_pct: number;
  mem_bytes: number;
}

const posInt = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const STATS_TIMEOUT_MS = 10_000;
const CONCURRENCY = 6;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error('stats timed out')), ms); })])
    .finally(() => clearTimeout(t));
}

/** One sampling pass on an engine: rows for every running internal container with an account label. */
export async function collectSamples(docker: Docker, at: Date): Promise<SampleRow[]> {
  const list = await docker.listContainers({ all: false, filters: { label: [`${LABELS.internal}=true`, LABELS.account] } } as never) as unknown as
    Array<{ Id: string; Names?: string[]; Labels?: Record<string, string> }>;
  const rows: SampleRow[] = [];
  const queue = [...list];
  const seen = new Set<string>();
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const labels = c.Labels ?? {};
      const accountId = posInt(labels[LABELS.account]);
      if (!accountId) continue;
      const name = (c.Names?.[0] ?? c.Id).replace(/^\//, '').slice(0, 128);
      seen.add(name);
      try {
        const stats = await withTimeout(docker.getContainer(c.Id).stats({ stream: false }) as unknown as Promise<DockerStatsLike>, STATS_TIMEOUT_MS);
        const s = sampleOf(name, stats);
        rows.push({
          at,
          account_id: accountId,
          site_id: posInt(labels[LABELS.site]),
          db_instance_id: posInt(labels[P2_LABELS.dbInstance]),
          container: name,
          role: String(labels[LABELS.role] ?? 'unknown').slice(0, 24),
          cpu_pct: s.cpuPct,
          mem_bytes: s.memBytes,
        });
      } catch (err) {
        logger.debug({ err, container: name }, 'docker stats failed');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
  for (const k of previous.keys()) if (!seen.has(k)) previous.delete(k);
  return rows;
}

/** Inserts samples (accounts deleted meanwhile are dropped: FK). */
export async function insertSamples(rows: SampleRow[], conn: Knex = db): Promise<number> {
  if (rows.length === 0) return 0;
  const ids = [...new Set(rows.map((r) => r.account_id))];
  const existing = new Set((await conn('hosting_accounts').whereIn('id', ids).pluck('id') as number[]).map(Number));
  const keep = rows.filter((r) => existing.has(r.account_id));
  for (let i = 0; i < keep.length; i += 500) {
    await conn('usage_resource_samples').insert(keep.slice(i, i + 500)).onConflict(['at', 'container']).ignore();
  }
  return keep.length;
}

/**
 * Hourly roll-up of [from, to) (idempotent upsert): per (hour, account, site)
 * the per-minute sums of the containers (site 0 = file server, databases),
 * then avg / max over the hour.
 */
export async function rollupHours(from: Date, to: Date, conn: Knex = db): Promise<void> {
  await conn.raw(`
    INSERT INTO usage_resource_hourly (hour, account_id, site_id, cpu_avg, cpu_max, mem_avg, mem_max)
    SELECT date_trunc('hour', m.at) AS hour, m.account_id, m.site_id,
           AVG(m.cpu), MAX(m.cpu), ROUND(AVG(m.mem))::bigint, MAX(m.mem)
    FROM (
      SELECT at, account_id, COALESCE(site_id, 0) AS site_id, SUM(cpu_pct) AS cpu, SUM(mem_bytes) AS mem
      FROM usage_resource_samples
      WHERE at >= ? AND at < ?
      GROUP BY at, account_id, COALESCE(site_id, 0)
    ) m
    GROUP BY 1, 2, 3
    ON CONFLICT (hour, account_id, site_id) DO UPDATE SET
      cpu_avg = EXCLUDED.cpu_avg, cpu_max = EXCLUDED.cpu_max, mem_avg = EXCLUDED.mem_avg, mem_max = EXCLUDED.mem_max
  `, [from, to]);
}

/** Retention: samples older than `sampleDays`, hourly aggregates older than 90 days. */
export async function purgeResources(sampleDays: number, conn: Knex = db, now: Date = new Date()): Promise<void> {
  const days = Math.max(1, Math.min(90, Math.floor(sampleDays) || 7));
  await conn('usage_resource_samples').where('at', '<', new Date(now.getTime() - days * 86_400_000)).delete();
  await conn('usage_resource_hourly').where('hour', '<', new Date(now.getTime() - 90 * 86_400_000)).delete();
}

/** Test seam: forget the remembered CPU readings. */
export function resetCpuReadingsForTests(): void {
  previous.clear();
}
