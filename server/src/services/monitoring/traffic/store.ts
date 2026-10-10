import type { Knex } from 'knex';
import type { GeoInfo, ProxyTrafficTopEntry } from '@oblimint/shared';
import { db } from '../../../db';
import {
  HISTOGRAM_SIZE, SAMPLES_PER_HOST, TOP_SIZE, countriesOf, emptyHistogram, mergeTopEntries, rollupToHours,
  type DrainedTraffic, type StoredTrafficRow,
} from './aggregate';

// ─────────────────────────────────────────────────────────────────────────────
// Traffic of the proxy hosts — database side (docs/P4b-PLAN.md §10.1):
// additive flush of the minute buckets (ONE transaction: a partial write
// followed by the worker's restore() would count twice), merge of the hourly
// tops, bounded samples, hourly roll-up (idempotent), retention.
// Rows of hosts deleted meanwhile are dropped (FK); the account is always the
// host's (database), never the log line's.
// ─────────────────────────────────────────────────────────────────────────────

const CHUNK = 500;
/** GeoIP budget of one flush (top IPs of every host-hour together). */
export const GEO_LOOKUPS_PER_FLUSH = 500;

export type GeoLookupMany = (ips: string[]) => Promise<Map<string, GeoInfo | null>>;

const HISTOGRAM_SUM_SQL = (table: string) => `(
  SELECT COALESCE(jsonb_agg(COALESCE(a.v, 0) + COALESCE(b.v, 0) ORDER BY COALESCE(a.i, b.i)), '[]'::jsonb)
  FROM (SELECT t.value::bigint AS v, t.ord AS i FROM jsonb_array_elements_text(${table}.latency_buckets) WITH ORDINALITY AS t(value, ord)) a
  FULL JOIN (SELECT t.value::bigint AS v, t.ord AS i FROM jsonb_array_elements_text(excluded.latency_buckets) WITH ORDINALITY AS t(value, ord)) b
  ON a.i = b.i
)`;

/** Host id → account id of the hosts that still exist. */
async function hostAccounts(ids: number[], conn: Knex | Knex.Transaction): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await conn('proxy_hosts').whereIn('id', ids.slice(i, i + CHUNK)).select('id', 'account_id') as Array<{ id: number; account_id: number }>;
    for (const r of rows) out.set(Number(r.id), Number(r.account_id));
  }
  return out;
}

/** GeoIP of the top IPs (budgeted, never throws). */
async function geoOfTops(d: DrainedTraffic, lookupMany: GeoLookupMany | null): Promise<Map<string, GeoInfo | null>> {
  if (!lookupMany) return new Map();
  const ips = new Set<string>();
  for (const t of d.tops) {
    for (const e of t.ips.top(TOP_SIZE)) {
      if (ips.size >= GEO_LOOKUPS_PER_FLUSH) break;
      ips.add(e.key);
    }
  }
  if (ips.size === 0) return new Map();
  try {
    return await lookupMany([...ips]);
  } catch {
    return new Map();
  }
}

/** Writes one drained batch. Returns the number of minute rows written. Throws on a database error (caller restores). */
export async function flushProxyTraffic(d: DrainedTraffic, opts: { lookupMany?: GeoLookupMany | null; conn?: Knex } = {}): Promise<number> {
  if (d.minutes.length === 0 && d.tops.length === 0 && d.samples.length === 0) return 0;
  const conn = opts.conn ?? db;
  const geo = await geoOfTops(d, opts.lookupMany ?? null);
  return conn.transaction(async (trx) => {
    const ids = [...new Set([...d.minutes.map((m) => m.proxyHostId), ...d.tops.map((t) => t.proxyHostId), ...d.samples.map((s) => s.proxyHostId)])];
    const accounts = await hostAccounts(ids, trx);

    const minuteRows = d.minutes.filter((m) => accounts.has(m.proxyHostId)).map((m) => ({
      minute: new Date(m.minute),
      proxy_host_id: m.proxyHostId,
      account_id: accounts.get(m.proxyHostId)!,
      requests: m.requests,
      s2xx: m.s2xx,
      s3xx: m.s3xx,
      s4xx: m.s4xx,
      s5xx: m.s5xx,
      upstream_errors: m.upstreamErrors,
      bytes_in: m.bytesIn,
      bytes_out: m.bytesOut,
      latency_sum_ms: m.latencySumMs,
      latency_buckets: JSON.stringify(m.latency),
    }));
    for (let i = 0; i < minuteRows.length; i += CHUNK) {
      const add = (c: string) => trx.raw(`proxy_traffic_minute.${c} + excluded.${c}`);
      await trx('proxy_traffic_minute').insert(minuteRows.slice(i, i + CHUNK)).onConflict(['proxy_host_id', 'minute']).merge({
        account_id: trx.raw('excluded.account_id'),
        requests: add('requests'),
        s2xx: add('s2xx'),
        s3xx: add('s3xx'),
        s4xx: add('s4xx'),
        s5xx: add('s5xx'),
        upstream_errors: add('upstream_errors'),
        bytes_in: add('bytes_in'),
        bytes_out: add('bytes_out'),
        latency_sum_ms: add('latency_sum_ms'),
        latency_buckets: trx.raw(HISTOGRAM_SUM_SQL('proxy_traffic_minute')),
      } as never);
    }

    for (const t of d.tops) {
      if (!accounts.has(t.proxyHostId)) continue;
      const hour = new Date(t.hour);
      const ips = t.ips.top(TOP_SIZE).map((e) => ({ ...e, geo: geo.get(e.key) ?? null }));
      const uris = t.uris.top(TOP_SIZE);
      const countries = countriesOf(ips, geo);
      const existing = await trx('proxy_traffic_top').where({ proxy_host_id: t.proxyHostId, hour }).forUpdate().first() as
        { ips: unknown; uris: unknown; countries: unknown } | undefined;
      const row = {
        proxy_host_id: t.proxyHostId,
        hour,
        ips: JSON.stringify(mergeTopEntries([parseTop(existing?.ips), ips])),
        uris: JSON.stringify(mergeTopEntries([parseTop(existing?.uris), uris])),
        countries: JSON.stringify(mergeTopEntries([parseTop(existing?.countries), countries])),
      };
      await trx('proxy_traffic_top').insert(row).onConflict(['proxy_host_id', 'hour']).merge(['ips', 'uris', 'countries']);
    }

    const sampleRows = d.samples.filter((s) => accounts.has(s.proxyHostId)).map((s) => ({
      proxy_host_id: s.proxyHostId,
      kind: s.kind,
      at: new Date(s.at),
      ip: s.ip,
      method: s.method,
      uri: s.uri,
      status: s.status,
      request_time_ms: Math.min(2_147_483_647, s.requestTimeMs),
      upstream_status: s.upstreamStatus,
      user_agent: s.userAgent,
    }));
    for (let i = 0; i < sampleRows.length; i += CHUNK) await trx('proxy_traffic_samples').insert(sampleRows.slice(i, i + CHUNK));
    const sampledHosts = [...new Set(sampleRows.map((s) => s.proxy_host_id))];
    if (sampledHosts.length > 0) await trimSamples(sampledHosts, trx);
    return minuteRows.length;
  });
}

/** Keeps the newest SAMPLES_PER_HOST samples per (host, kind). */
export async function trimSamples(hostIds: number[], conn: Knex | Knex.Transaction = db): Promise<void> {
  await conn.raw(`
    DELETE FROM proxy_traffic_samples WHERE id IN (
      SELECT id FROM (
        SELECT id, row_number() OVER (PARTITION BY proxy_host_id, kind ORDER BY at DESC, id DESC) AS rn
        FROM proxy_traffic_samples WHERE proxy_host_id = ANY(?::int[])
      ) x WHERE x.rn > ?
    )`, [hostIds, SAMPLES_PER_HOST]);
}

export function parseTop(v: unknown): ProxyTrafficTopEntry[] {
  const arr = typeof v === 'string' ? (() => { try { return JSON.parse(v) as unknown; } catch { return []; } })() : v;
  return Array.isArray(arr) ? arr.filter((e): e is ProxyTrafficTopEntry => !!e && typeof (e as ProxyTrafficTopEntry).key === 'string') : [];
}

export interface TrafficRowDb {
  proxy_host_id: number;
  account_id: number;
  at: Date | string;
  requests: number | string;
  s2xx: number | string;
  s3xx: number | string;
  s4xx: number | string;
  s5xx: number | string;
  upstream_errors: number | string;
  bytes_in: number | string;
  bytes_out: number | string;
  latency_sum_ms: number | string;
  latency_buckets: unknown;
}

export function fromDbRow(r: TrafficRowDb): StoredTrafficRow {
  const raw = typeof r.latency_buckets === 'string' ? (() => { try { return JSON.parse(r.latency_buckets as string) as unknown; } catch { return []; } })() : r.latency_buckets;
  const latency = emptyHistogram();
  if (Array.isArray(raw)) for (let i = 0; i < HISTOGRAM_SIZE; i++) latency[i] = Number(raw[i]) || 0;
  return {
    proxyHostId: Number(r.proxy_host_id),
    accountId: Number(r.account_id),
    at: r.at instanceof Date ? r.at : new Date(r.at),
    requests: Number(r.requests) || 0,
    s2xx: Number(r.s2xx) || 0,
    s3xx: Number(r.s3xx) || 0,
    s4xx: Number(r.s4xx) || 0,
    s5xx: Number(r.s5xx) || 0,
    upstreamErrors: Number(r.upstream_errors) || 0,
    bytesIn: Number(r.bytes_in) || 0,
    bytesOut: Number(r.bytes_out) || 0,
    latencySumMs: Number(r.latency_sum_ms) || 0,
    latency,
  };
}

/** Hourly roll-up of [from, to) (idempotent: each hour row is REPLACED by the sum of its minutes). */
export async function rollupTrafficHours(from: Date, to: Date, conn: Knex = db): Promise<number> {
  const rows = await conn('proxy_traffic_minute').where('minute', '>=', from).andWhere('minute', '<', to)
    .select('proxy_host_id', 'account_id', 'minute as at', 'requests', 's2xx', 's3xx', 's4xx', 's5xx', 'upstream_errors', 'bytes_in', 'bytes_out',
      'latency_sum_ms', 'latency_buckets') as TrafficRowDb[];
  const hours = rollupToHours(rows.map(fromDbRow));
  for (let i = 0; i < hours.length; i += CHUNK) {
    const chunk = hours.slice(i, i + CHUNK).map((h) => ({
      hour: h.at,
      proxy_host_id: h.proxyHostId,
      account_id: h.accountId,
      requests: h.requests,
      s2xx: h.s2xx,
      s3xx: h.s3xx,
      s4xx: h.s4xx,
      s5xx: h.s5xx,
      upstream_errors: h.upstreamErrors,
      bytes_in: h.bytesIn,
      bytes_out: h.bytesOut,
      latency_sum_ms: h.latencySumMs,
      latency_buckets: JSON.stringify(h.latency),
    }));
    await conn('proxy_traffic_hour').insert(chunk).onConflict(['proxy_host_id', 'hour'])
      .merge(['account_id', 'requests', 's2xx', 's3xx', 's4xx', 's5xx', 'upstream_errors', 'bytes_in', 'bytes_out', 'latency_sum_ms', 'latency_buckets']);
  }
  return hours.length;
}

/** Retention (settings.monitoring.trafficMinuteDays / trafficHourDays). */
export async function purgeTraffic(minuteDays: number, hourDays: number, now: Date = new Date(), conn: Knex = db): Promise<void> {
  const m = Math.max(1, Math.min(90, Math.floor(minuteDays) || 7));
  const h = Math.max(m, Math.min(800, Math.floor(hourDays) || 90));
  const minuteCut = new Date(now.getTime() - m * 86_400_000);
  const hourCut = new Date(now.getTime() - h * 86_400_000);
  await conn('proxy_traffic_minute').where('minute', '<', minuteCut).delete();
  await conn('proxy_traffic_hour').where('hour', '<', hourCut).delete();
  await conn('proxy_traffic_top').where('hour', '<', hourCut).delete();
  await conn('proxy_traffic_samples').where('at', '<', hourCut).delete();
}
