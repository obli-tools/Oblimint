import type {
  ProxyTrafficOverviewRow, ProxyTrafficRange, ProxyTrafficReport, ProxyTrafficSample,
} from '@oblimint/shared';
import { db } from '../../../db';
import type { HostingActor } from '../../hosting/access';
import { loadProxyHost } from '../../proxy/access';
import { scopeList, type ListFilter } from '../common';
import {
  HISTOGRAM_SIZE, addCounters, emptyCounters, emptyHistogram, errorRate, hourOf, mergeTopEntries, percentileFromHistogram,
  rollupToHours, toPoint, type StoredTrafficRow, type TrafficCounters,
} from './aggregate';
import { fromDbRow, parseTop, type TrafficRowDb } from './store';

// ─────────────────────────────────────────────────────────────────────────────
// Traffic API of the proxy hosts (docs/P4b-PLAN.md §6.6, §10.1):
//   overview — one row per visible proxy host (scoped like the hosts);
//   report   — one host (read on it): series (minute buckets up to 24 h,
//              hourly beyond), summary, percentiles from the histograms, tops,
//              error / slow samples.
// Beyond 24 h the hourly table answers for the hours already rolled up and
// the recent minutes are rolled up on the fly (no gap at the end of a range).
// ─────────────────────────────────────────────────────────────────────────────

export const RANGE_MS: Record<ProxyTrafficRange, number> = {
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000,
};

/** Hours newer than this many hours before the current one are read from the minute table (roll-up lag). */
const LIVE_HOURS = 3;
const ROW_COLUMNS = ['proxy_host_id', 'account_id', 'requests', 's2xx', 's3xx', 's4xx', 's5xx', 'upstream_errors', 'bytes_in', 'bytes_out',
  'latency_sum_ms', 'latency_buckets'];

export function isMinuteRange(range: ProxyTrafficRange): boolean {
  return RANGE_MS[range] <= RANGE_MS['24h'];
}

/** Stored rows of `hostIds` over [from, now): minute rows, or hourly rows + recent minutes rolled up. */
export async function loadTrafficRows(hostIds: number[], range: ProxyTrafficRange, now: Date): Promise<StoredTrafficRow[]> {
  if (hostIds.length === 0) return [];
  const from = new Date(now.getTime() - RANGE_MS[range]);
  if (isMinuteRange(range)) {
    const rows = await db('proxy_traffic_minute').whereIn('proxy_host_id', hostIds).andWhere('minute', '>=', from)
      .select([...ROW_COLUMNS, 'minute as at']).orderBy('minute') as TrafficRowDb[];
    return rows.map(fromDbRow);
  }
  const cutoff = new Date(hourOf(now).getTime() - LIVE_HOURS * 3_600_000);
  const hourRows = await db('proxy_traffic_hour').whereIn('proxy_host_id', hostIds).andWhere('hour', '>=', hourOf(from)).andWhere('hour', '<', cutoff)
    .select([...ROW_COLUMNS, 'hour as at']).orderBy('hour') as TrafficRowDb[];
  const minuteRows = await db('proxy_traffic_minute').whereIn('proxy_host_id', hostIds).andWhere('minute', '>=', cutoff)
    .select([...ROW_COLUMNS, 'minute as at']) as TrafficRowDb[];
  return [...hourRows.map(fromDbRow), ...rollupToHours(minuteRows.map(fromDbRow))];
}

/** Zero-filled series of one host (one point per minute / hour of the range). */
export function buildSeries(rows: readonly StoredTrafficRow[], range: ProxyTrafficRange, now: Date): ReturnType<typeof toPoint>[] {
  const step = isMinuteRange(range) ? 60_000 : 3_600_000;
  const end = Math.floor(now.getTime() / step) * step;
  const start = Math.floor((now.getTime() - RANGE_MS[range]) / step) * step + step;
  const by = new Map<number, TrafficCounters>();
  for (const r of rows) {
    const t = Math.floor(r.at.getTime() / step) * step;
    const cur = by.get(t);
    if (cur) addCounters(cur, r);
    else by.set(t, addCounters(emptyCounters(), r));
  }
  const out: ReturnType<typeof toPoint>[] = [];
  for (let t = start; t <= end; t += step) out.push(toPoint(new Date(t), by.get(t) ?? emptyCounters()));
  return out;
}

function sum(rows: readonly StoredTrafficRow[]): TrafficCounters {
  const c = emptyCounters();
  for (const r of rows) addCounters(c, r);
  return c;
}

function toSample(r: Record<string, unknown>): ProxyTrafficSample {
  return {
    at: (r.at instanceof Date ? r.at : new Date(String(r.at))).toISOString(),
    ip: String(r.ip),
    method: String(r.method),
    uri: String(r.uri),
    status: Number(r.status),
    requestTimeMs: Number(r.request_time_ms),
    upstreamStatus: (r.upstream_status as string | null) ?? null,
    userAgent: (r.user_agent as string | null) ?? null,
  };
}

export interface TrafficQuery extends ListFilter {
  range: ProxyTrafficRange;
}

export const trafficService = {
  async overview(actor: HostingActor, q: TrafficQuery, now: Date = new Date()): Promise<ProxyTrafficOverviewRow[]> {
    const hosts = await scopeList(actor, db('proxy_hosts as h'), 'h', q).select('h.id', 'h.name', 'h.account_id').orderBy('h.name') as
      Array<{ id: number; name: string; account_id: number }>;
    if (hosts.length === 0) return [];
    const rows = await loadTrafficRows(hosts.map((h) => Number(h.id)), q.range, now);
    const by = new Map<number, TrafficCounters>();
    for (const r of rows) {
      const cur = by.get(r.proxyHostId);
      if (cur) addCounters(cur, r);
      else by.set(r.proxyHostId, addCounters(emptyCounters(), r));
    }
    return hosts.map((h) => {
      const c = by.get(Number(h.id)) ?? emptyCounters();
      return {
        proxyHostId: Number(h.id),
        name: h.name,
        accountId: Number(h.account_id),
        requests: c.requests,
        errorRate: errorRate(c),
        bytesOut: c.bytesOut,
        p95Ms: percentileFromHistogram(c.latency, 0.95),
      };
    });
  },

  async report(actor: HostingActor, proxyHostId: number, range: ProxyTrafficRange, status: '4xx' | '5xx' | null, now: Date = new Date()): Promise<ProxyTrafficReport> {
    const host = await loadProxyHost(actor, proxyHostId, 'read');
    const id = Number(host.id);
    const rows = await loadTrafficRows([id], range, now);
    const total = sum(rows);
    const from = new Date(now.getTime() - RANGE_MS[range]);

    const tops = await db('proxy_traffic_top').where({ proxy_host_id: id }).andWhere('hour', '>=', hourOf(from))
      .select('ips', 'uris', 'countries') as Array<{ ips: unknown; uris: unknown; countries: unknown }>;

    const samples = (kind: 'error' | 'slow') => {
      const qb = db('proxy_traffic_samples').where({ proxy_host_id: id, kind }).andWhere('at', '>=', from);
      if (status === '4xx') qb.andWhere('status', '>=', 400).andWhere('status', '<', 500);
      if (status === '5xx') qb.andWhere('status', '>=', 500).andWhere('status', '<', 600);
      return qb.orderBy('at', 'desc').limit(200).select('*') as Promise<Array<Record<string, unknown>>>;
    };
    const [errorRows, slowRows] = await Promise.all([samples('error'), samples('slow')]);

    const latency = total.latency.length === HISTOGRAM_SIZE ? total.latency : emptyHistogram();
    return {
      summary: {
        proxyHostId: id,
        range,
        requests: total.requests,
        bytesIn: total.bytesIn,
        bytesOut: total.bytesOut,
        errorRate: errorRate(total),
        p50Ms: percentileFromHistogram(latency, 0.5),
        p95Ms: percentileFromHistogram(latency, 0.95),
        p99Ms: percentileFromHistogram(latency, 0.99),
        status: { s2xx: total.s2xx, s3xx: total.s3xx, s4xx: total.s4xx, s5xx: total.s5xx },
      },
      series: buildSeries(rows, range, now),
      topIps: mergeTopEntries(tops.map((t) => parseTop(t.ips))),
      topUris: mergeTopEntries(tops.map((t) => parseTop(t.uris))),
      countries: mergeTopEntries(tops.map((t) => parseTop(t.countries))),
      errorSamples: errorRows.map(toSample),
      slowSamples: slowRows.map(toSample),
    };
  },
};
