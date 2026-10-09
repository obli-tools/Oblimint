import type { Knex } from 'knex';
import { db } from '../../db';
import type { EdgeLogEntry } from './edgeLog';

// ─────────────────────────────────────────────────────────────────────────────
// Traffic aggregation (module usage, docs/P2-PLAN.md §9.5): edge log entries
// → in-memory buckets per (UTC day, account, site) → additive upsert into
// usage_traffic_daily every 60 s. Lines without an account (panel, default
// server, probes, dbadmin) are ignored. bytesOut = bytes_sent (headers
// included), bytesIn = request_length. site 0 = traffic of the account that
// matched no site (redirects).
//
// Not counted (countsAsTraffic): what the edge serves INSTEAD of the account's
// sites — the unverified-domain placeholder, the suspension page, the ACME
// challenge and the 404 fallback (site-scoped kinds without a site). Otherwise
// an account suspended for traffic would keep accruing quota while serving
// nothing, and never be reactivated by the monthly reset.
// ─────────────────────────────────────────────────────────────────────────────

export interface TrafficBucket {
  day: string;
  accountId: number;
  siteId: number;
  /** From the log line ($oblimint_tenant); the flush uses the account's tenant from the database. */
  tenantId: number | null;
  requests: number;
  bytesOut: number;
  bytesIn: number;
  statusCodes: Record<string, number>;
}

/** Location kinds whose lines without a site are the edge's own responses (suspension page, ACME, 404). */
const SITE_SCOPED_KINDS = new Set(['site', 'secondary', 'preview']);
/** Kinds never counted: the pending-verification placeholder and the suspension page. */
const NON_BILLABLE_KINDS = new Set(['placeholder', 'suspended']);

/** True when an edge entry is account traffic (pure). */
export function countsAsTraffic(e: Pick<EdgeLogEntry, 'accountId' | 'siteId' | 'kind'>): boolean {
  if (!e.accountId) return false;
  if (NON_BILLABLE_KINDS.has(e.kind)) return false;
  if (e.siteId === null && SITE_SCOPED_KINDS.has(e.kind)) return false;
  return true;
}

/** Bounded memory: past this many buckets new keys are dropped (logged by the collector). */
export const MAX_BUCKETS = 100_000;

/** UTC day of an edge `time` ($time_iso8601, with its offset); `fallback` when unparsable. */
export function utcDayOf(time: string, fallback: Date = new Date()): string {
  const ms = Date.parse(time);
  return (Number.isFinite(ms) ? new Date(ms) : fallback).toISOString().slice(0, 10);
}

export class TrafficAggregator {
  private buckets = new Map<string, TrafficBucket>();
  dropped = 0;

  get size(): number {
    return this.buckets.size;
  }

  /** Adds one entry (ignored without an account, or when it is not account traffic: countsAsTraffic). */
  add(e: EdgeLogEntry, now: Date = new Date()): void {
    if (!e.accountId || !countsAsTraffic(e)) return;
    const day = utcDayOf(e.time, now);
    const siteId = e.siteId ?? 0;
    const key = `${day}|${e.accountId}|${siteId}`;
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= MAX_BUCKETS) { this.dropped++; return; }
      b = { day, accountId: e.accountId, siteId, tenantId: e.tenantId, requests: 0, bytesOut: 0, bytesIn: 0, statusCodes: {} };
      this.buckets.set(key, b);
    }
    b.requests += 1;
    b.bytesOut += e.bytesOut;
    b.bytesIn += e.bytesIn;
    const code = String(e.status);
    b.statusCodes[code] = (b.statusCodes[code] ?? 0) + 1;
  }

  /** Takes every bucket (the aggregator starts empty again). */
  drain(): TrafficBucket[] {
    const out = [...this.buckets.values()];
    this.buckets = new Map();
    return out;
  }

  /** Puts drained buckets back (failed flush): merged with what arrived meanwhile. */
  restore(buckets: TrafficBucket[]): void {
    for (const r of buckets) {
      const key = `${r.day}|${r.accountId}|${r.siteId}`;
      const b = this.buckets.get(key);
      if (!b) { this.buckets.set(key, { ...r, statusCodes: { ...r.statusCodes } }); continue; }
      b.requests += r.requests;
      b.bytesOut += r.bytesOut;
      b.bytesIn += r.bytesIn;
      for (const [k, v] of Object.entries(r.statusCodes)) b.statusCodes[k] = (b.statusCodes[k] ?? 0) + v;
    }
  }
}

const CHUNK = 500;

/**
 * Additive upsert of buckets. The tenant is the account's (database), never
 * the log line's; buckets of accounts that no longer exist are dropped (FK).
 * ATOMIC (one transaction): the upsert is additive, so a partial write
 * followed by the collector's restore() would count the written chunks twice.
 * Returns the number of rows written.
 */
export async function flushTraffic(buckets: TrafficBucket[], conn: Knex = db): Promise<number> {
  if (buckets.length === 0) return 0;
  return conn.transaction((trx) => flushTrafficIn(buckets, trx));
}

async function flushTrafficIn(buckets: TrafficBucket[], conn: Knex.Transaction): Promise<number> {
  const ids = [...new Set(buckets.map((b) => b.accountId))];
  const tenants = new Map<number, number>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await conn('hosting_accounts').whereIn('id', ids.slice(i, i + CHUNK)).select('id', 'tenant_id') as Array<{ id: number; tenant_id: number }>;
    for (const r of rows) tenants.set(Number(r.id), Number(r.tenant_id));
  }
  const rows = buckets
    .filter((b) => tenants.has(b.accountId))
    .map((b) => ({
      day: b.day,
      tenant_id: tenants.get(b.accountId)!,
      account_id: b.accountId,
      site_id: b.siteId,
      requests: b.requests,
      bytes_out: b.bytesOut,
      bytes_in: b.bytesIn,
      status_codes: JSON.stringify(b.statusCodes),
    }));
  for (let i = 0; i < rows.length; i += CHUNK) {
    await conn('usage_traffic_daily')
      .insert(rows.slice(i, i + CHUNK))
      .onConflict(['day', 'account_id', 'site_id'])
      .merge({
        requests: conn.raw('usage_traffic_daily.requests + excluded.requests'),
        bytes_out: conn.raw('usage_traffic_daily.bytes_out + excluded.bytes_out'),
        bytes_in: conn.raw('usage_traffic_daily.bytes_in + excluded.bytes_in'),
        status_codes: conn.raw(`(
          SELECT COALESCE(jsonb_object_agg(m.k, m.v), '{}'::jsonb)
          FROM (
            SELECT s.key AS k, SUM(s.value::bigint) AS v
            FROM (
              SELECT key, value FROM jsonb_each_text(usage_traffic_daily.status_codes)
              UNION ALL
              SELECT key, value FROM jsonb_each_text(excluded.status_codes)
            ) s
            GROUP BY s.key
          ) m
        )`),
      } as never);
  }
  return rows.length;
}
