import type { ProxyTrafficPoint, ProxyTrafficSample, ProxyTrafficTopEntry } from '@oblimint/shared';
import type { EdgeLogEntry } from '../../usage/edgeLog';

// ─────────────────────────────────────────────────────────────────────────────
// Traffic of the proxy hosts (docs/P4b-PLAN.md §10.1) — PURE part:
//   - edge log entries of kind 'proxy' with a proxyHostId → in-memory
//     buckets per (host, UTC minute): requests, status classes, upstream
//     errors (502 / 503 / 504 produced by the edge), bytes in / out, latency
//     sum + fixed histogram (LATENCY_BOUNDS_MS + overflow) ⇒ percentiles;
//   - per (host, UTC hour) bounded heavy hitters (Space-Saving) of client
//     IPs and URI paths (query string dropped);
//   - error (status ≥ 500) and slow (≥ 1 s) samples, bounded per host.
// The other proxy kinds are NOT counted here: proxy-redirect / dead carry the
// id of a redirection / dead host in the same log field (different tables).
// drain() hands everything to the flush; restore() puts it back on failure.
// ─────────────────────────────────────────────────────────────────────────────

/** Upper bounds (ms) of the latency buckets; one more bucket = overflow (> 10 s). */
export const LATENCY_BOUNDS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;
export const HISTOGRAM_SIZE = LATENCY_BOUNDS_MS.length + 1;

export const SLOW_REQUEST_MS = 1000;
export const ERROR_SAMPLE_STATUS = 500;
/** Samples kept per host and kind (memory per flush AND database). */
export const SAMPLES_PER_HOST = 200;
/** Entries kept per hourly top list (IPs, URIs, countries). */
export const TOP_SIZE = 50;
/** Counters of one Space-Saving sketch (≥ 4 × TOP_SIZE keeps the top 50 accurate on skewed traffic). */
export const HEAVY_HITTERS_CAPACITY = 200;
/** Bounded memory: past this many keys new ones are dropped (counted in `dropped`). */
export const MAX_MINUTE_BUCKETS = 50_000;
export const MAX_TOP_BUCKETS = 5_000;
const MAX_URI = 256;

export function emptyHistogram(): number[] {
  return new Array<number>(HISTOGRAM_SIZE).fill(0);
}

export function bucketIndex(ms: number): number {
  for (let i = 0; i < LATENCY_BOUNDS_MS.length; i++) if (ms <= LATENCY_BOUNDS_MS[i]) return i;
  return LATENCY_BOUNDS_MS.length;
}

/** Element-wise sum (tolerates short / garbage arrays from the database). */
export function addHistograms(into: number[], other: unknown): number[] {
  if (!Array.isArray(other)) return into;
  for (let i = 0; i < HISTOGRAM_SIZE; i++) {
    const v = Number(other[i]);
    if (Number.isFinite(v) && v > 0) into[i] += v;
  }
  return into;
}

/**
 * Percentile `p` (0 … 1) from a histogram, linearly interpolated inside the
 * bucket (lower bound of the first bucket = 0). The overflow bucket answers
 * its lower bound (10 000 ms). null when the histogram is empty.
 */
export function percentileFromHistogram(h: readonly number[], p: number): number | null {
  const total = h.reduce((a, b) => a + (Number(b) || 0), 0);
  if (total <= 0) return null;
  const rank = Math.max(1, Math.ceil(Math.min(1, Math.max(0, p)) * total));
  let cum = 0;
  for (let i = 0; i < HISTOGRAM_SIZE; i++) {
    const n = Number(h[i]) || 0;
    if (n <= 0) continue;
    if (cum + n >= rank) {
      if (i >= LATENCY_BOUNDS_MS.length) return LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1];
      const lower = i === 0 ? 0 : LATENCY_BOUNDS_MS[i - 1];
      const upper = LATENCY_BOUNDS_MS[i];
      return Math.round((lower + ((rank - cum) / n) * (upper - lower)) * 10) / 10;
    }
    cum += n;
  }
  return LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1];
}

// ── Heavy hitters (Space-Saving, Metwally et al.) ─────────────────────────────

interface HitCounter { key: string; requests: number; bytes: number; errors: number }

/**
 * Bounded top-k sketch: at most `capacity` counters; a new key when full
 * replaces the smallest counter and inherits its count (over-estimate bounded
 * by the smallest count). Exact while the number of distinct keys ≤ capacity.
 */
export class HeavyHitters {
  private counters = new Map<string, HitCounter>();

  constructor(readonly capacity: number = HEAVY_HITTERS_CAPACITY) {}

  get size(): number {
    return this.counters.size;
  }

  add(key: string, requests: number, bytes: number, errors: number): void {
    let c = this.counters.get(key);
    if (!c) {
      if (this.counters.size >= this.capacity) {
        let min: HitCounter | null = null;
        for (const x of this.counters.values()) if (!min || x.requests < min.requests) min = x;
        this.counters.delete(min!.key);
        c = { key, requests: min!.requests, bytes: 0, errors: 0 };
      } else {
        c = { key, requests: 0, bytes: 0, errors: 0 };
      }
      this.counters.set(key, c);
    }
    c.requests += requests;
    c.bytes += bytes;
    c.errors += errors;
  }

  merge(other: HeavyHitters): void {
    for (const c of other.entries()) this.add(c.key, c.requests, c.bytes, c.errors);
  }

  entries(): ProxyTrafficTopEntry[] {
    return [...this.counters.values()].map((c) => ({ key: c.key, requests: c.requests, bytes: c.bytes, errors: c.errors }));
  }

  top(n: number = TOP_SIZE): ProxyTrafficTopEntry[] {
    return this.entries().sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key)).slice(0, n);
  }
}

/** Sums top lists by key and keeps the `n` largest (stored hourly rows + a flush, or a report range). */
export function mergeTopEntries(lists: ReadonlyArray<readonly ProxyTrafficTopEntry[] | null | undefined>, n: number = TOP_SIZE): ProxyTrafficTopEntry[] {
  const by = new Map<string, ProxyTrafficTopEntry>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!e || typeof e.key !== 'string') continue;
      const cur = by.get(e.key);
      if (!cur) by.set(e.key, { key: e.key, requests: Number(e.requests) || 0, bytes: Number(e.bytes) || 0, errors: Number(e.errors) || 0, ...(e.geo !== undefined ? { geo: e.geo } : {}) });
      else {
        cur.requests += Number(e.requests) || 0;
        cur.bytes += Number(e.bytes) || 0;
        cur.errors += Number(e.errors) || 0;
        if (cur.geo === undefined && e.geo !== undefined) cur.geo = e.geo;
      }
    }
  }
  return [...by.values()].sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key)).slice(0, n);
}

// ── Buckets ──────────────────────────────────────────────────────────────────

export interface TrafficCounters {
  requests: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  upstreamErrors: number;
  bytesIn: number;
  bytesOut: number;
  latencySumMs: number;
  latency: number[];
}

export interface MinuteBucket extends TrafficCounters {
  proxyHostId: number;
  /** From the log line; the flush uses the host's account from the database. */
  accountId: number | null;
  /** ISO, start of the UTC minute. */
  minute: string;
}

export interface TopBucket {
  proxyHostId: number;
  /** ISO, start of the UTC hour. */
  hour: string;
  ips: HeavyHitters;
  uris: HeavyHitters;
}

export interface SampleRecord extends ProxyTrafficSample {
  proxyHostId: number;
  kind: 'error' | 'slow';
}

export interface DrainedTraffic {
  minutes: MinuteBucket[];
  tops: TopBucket[];
  samples: SampleRecord[];
}

export function emptyCounters(): TrafficCounters {
  return { requests: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, upstreamErrors: 0, bytesIn: 0, bytesOut: 0, latencySumMs: 0, latency: emptyHistogram() };
}

export function addCounters(into: TrafficCounters, c: TrafficCounters): TrafficCounters {
  into.requests += c.requests;
  into.s2xx += c.s2xx;
  into.s3xx += c.s3xx;
  into.s4xx += c.s4xx;
  into.s5xx += c.s5xx;
  into.upstreamErrors += c.upstreamErrors;
  into.bytesIn += c.bytesIn;
  into.bytesOut += c.bytesOut;
  into.latencySumMs += c.latencySumMs;
  addHistograms(into.latency, c.latency);
  return into;
}

/** Only `kind === 'proxy'` lines with a host id are proxy-host traffic. */
export function isProxyHostEntry(e: Pick<EdgeLogEntry, 'kind' | 'proxyHostId'>): boolean {
  return e.kind === 'proxy' && typeof e.proxyHostId === 'number' && e.proxyHostId > 0;
}

export function minuteOf(time: string, fallback: Date): Date {
  const ms = Date.parse(time);
  const t = Number.isFinite(ms) ? ms : fallback.getTime();
  return new Date(Math.floor(t / 60_000) * 60_000);
}

export function hourOf(d: Date): Date {
  return new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000);
}

/** URI path without the query string (cardinality + privacy: tokens in query strings), bounded. */
export function uriKey(uri: string): string {
  const q = uri.search(/[?#]/);
  const path = (q >= 0 ? uri.slice(0, q) : uri) || '/';
  return path.length > MAX_URI ? path.slice(0, MAX_URI) : path;
}

export class ProxyTrafficAggregator {
  private minutes = new Map<string, MinuteBucket>();
  private tops = new Map<string, TopBucket>();
  private samples = new Map<string, SampleRecord[]>();
  dropped = 0;

  get size(): number {
    return this.minutes.size;
  }

  add(e: EdgeLogEntry, now: Date = new Date()): void {
    if (!isProxyHostEntry(e)) return;
    const hostId = e.proxyHostId as number;
    const minute = minuteOf(e.time, now);
    const minuteIso = minute.toISOString();
    const key = `${hostId}|${minuteIso}`;
    let b = this.minutes.get(key);
    if (!b) {
      if (this.minutes.size >= MAX_MINUTE_BUCKETS) { this.dropped++; return; }
      b = { proxyHostId: hostId, accountId: e.accountId, minute: minuteIso, ...emptyCounters() };
      this.minutes.set(key, b);
    }
    const ms = Math.max(0, e.requestTime * 1000);
    const cls = Math.floor(e.status / 100);
    b.requests += 1;
    if (cls === 2) b.s2xx += 1;
    else if (cls === 3) b.s3xx += 1;
    else if (cls === 4) b.s4xx += 1;
    else if (cls === 5) b.s5xx += 1;
    if (e.status === 502 || e.status === 503 || e.status === 504) b.upstreamErrors += 1;
    b.bytesIn += e.bytesIn;
    b.bytesOut += e.bytesOut;
    b.latencySumMs += ms;
    b.latency[bucketIndex(ms)] += 1;

    const hourIso = hourOf(minute).toISOString();
    const tkey = `${hostId}|${hourIso}`;
    let t = this.tops.get(tkey);
    if (!t && this.tops.size < MAX_TOP_BUCKETS) {
      t = { proxyHostId: hostId, hour: hourIso, ips: new HeavyHitters(), uris: new HeavyHitters() };
      this.tops.set(tkey, t);
    }
    if (t) {
      const err = e.status >= 400 ? 1 : 0;
      if (e.remoteAddr) t.ips.add(e.remoteAddr, 1, e.bytesOut, err);
      t.uris.add(uriKey(e.uri), 1, e.bytesOut, err);
    }

    if (e.status >= ERROR_SAMPLE_STATUS) this.sample(hostId, 'error', e, ms);
    if (ms >= SLOW_REQUEST_MS) this.sample(hostId, 'slow', e, ms);
  }

  private sample(hostId: number, kind: 'error' | 'slow', e: EdgeLogEntry, ms: number): void {
    const key = `${hostId}|${kind}`;
    let list = this.samples.get(key);
    if (!list) {
      list = [];
      this.samples.set(key, list);
    }
    const rec: SampleRecord = {
      proxyHostId: hostId,
      kind,
      at: Number.isFinite(Date.parse(e.time)) ? new Date(Date.parse(e.time)).toISOString() : new Date().toISOString(),
      ip: e.remoteAddr.slice(0, 64),
      method: e.method.slice(0, 16),
      uri: e.uri.slice(0, 1024),
      status: e.status,
      requestTimeMs: Math.round(ms),
      upstreamStatus: e.upstreamStatus ? e.upstreamStatus.slice(0, 64) : null,
      userAgent: e.userAgent ? e.userAgent.slice(0, 512) : null,
    };
    // Newest kept: the oldest of the flush interval goes first.
    if (list.length >= SAMPLES_PER_HOST) list.shift();
    list.push(rec);
  }

  drain(): DrainedTraffic {
    const out: DrainedTraffic = {
      minutes: [...this.minutes.values()],
      tops: [...this.tops.values()],
      samples: [...this.samples.values()].flat(),
    };
    this.minutes = new Map();
    this.tops = new Map();
    this.samples = new Map();
    return out;
  }

  /** Puts a failed flush back, merged with what arrived meanwhile (bounded like add()). */
  restore(d: DrainedTraffic): void {
    for (const m of d.minutes) {
      const key = `${m.proxyHostId}|${m.minute}`;
      const cur = this.minutes.get(key);
      if (cur) addCounters(cur, m);
      else if (this.minutes.size < MAX_MINUTE_BUCKETS) this.minutes.set(key, { ...m, latency: [...m.latency] });
      else this.dropped++;
    }
    for (const t of d.tops) {
      const key = `${t.proxyHostId}|${t.hour}`;
      const cur = this.tops.get(key);
      if (cur) {
        cur.ips.merge(t.ips);
        cur.uris.merge(t.uris);
      } else if (this.tops.size < MAX_TOP_BUCKETS) this.tops.set(key, t);
    }
    for (const s of d.samples) {
      const key = `${s.proxyHostId}|${s.kind}`;
      const list = this.samples.get(key) ?? [];
      if (list.length < SAMPLES_PER_HOST) list.unshift(s);
      this.samples.set(key, list);
    }
  }
}

// ── Roll-up and report helpers ───────────────────────────────────────────────

export interface StoredTrafficRow extends TrafficCounters {
  proxyHostId: number;
  accountId: number;
  /** Bucket start (minute or hour). */
  at: Date;
}

/** Hourly roll-up of minute rows (pure): one row per (host, UTC hour). */
export function rollupToHours(rows: readonly StoredTrafficRow[]): StoredTrafficRow[] {
  const by = new Map<string, StoredTrafficRow>();
  for (const r of rows) {
    const hour = hourOf(r.at);
    const key = `${r.proxyHostId}|${hour.getTime()}`;
    let h = by.get(key);
    if (!h) {
      h = { proxyHostId: r.proxyHostId, accountId: r.accountId, at: hour, ...emptyCounters() };
      by.set(key, h);
    }
    addCounters(h, r);
  }
  return [...by.values()].sort((a, b) => a.at.getTime() - b.at.getTime() || a.proxyHostId - b.proxyHostId);
}

export function toPoint(at: Date, c: TrafficCounters): ProxyTrafficPoint {
  return {
    at: at.toISOString(),
    requests: c.requests,
    s2xx: c.s2xx,
    s3xx: c.s3xx,
    s4xx: c.s4xx,
    s5xx: c.s5xx,
    bytesIn: c.bytesIn,
    bytesOut: c.bytesOut,
    p50Ms: percentileFromHistogram(c.latency, 0.5),
    p95Ms: percentileFromHistogram(c.latency, 0.95),
    p99Ms: percentileFromHistogram(c.latency, 0.99),
    upstreamErrors: c.upstreamErrors,
  };
}

/** (4xx + 5xx) / requests, 0 … 1 (0 without requests). */
export function errorRate(c: Pick<TrafficCounters, 'requests' | 's4xx' | 's5xx'>): number {
  return c.requests > 0 ? Math.round(((c.s4xx + c.s5xx) / c.requests) * 10_000) / 10_000 : 0;
}

/**
 * Countries of a top IP list: each IP's requests / bytes / errors summed by
 * country code (unknown geo = skipped). Pure: `geo` comes from geoipService.
 */
export function countriesOf(ips: readonly ProxyTrafficTopEntry[], geo: ReadonlyMap<string, { countryCode: string | null; countryName: string | null } | null>): ProxyTrafficTopEntry[] {
  const by = new Map<string, ProxyTrafficTopEntry>();
  for (const ip of ips) {
    const g = geo.get(ip.key);
    if (!g || !g.countryCode) continue;
    const code = g.countryCode.toUpperCase().slice(0, 2);
    const cur = by.get(code);
    if (!cur) {
      by.set(code, {
        key: code, requests: ip.requests, bytes: ip.bytes, errors: ip.errors,
        geo: { countryCode: code, countryName: g.countryName, city: null, latitude: null, longitude: null, org: null },
      });
    } else {
      cur.requests += ip.requests;
      cur.bytes += ip.bytes;
      cur.errors += ip.errors;
    }
  }
  return [...by.values()].sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key)).slice(0, TOP_SIZE);
}
