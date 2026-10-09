import type {
  AccountUsage, AccountUsageRow, OverQuotaState, PlatformUsage, ResourcePoint, SiteTraffic, SiteUsage, TenantUsage, UsageAlert,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { assertNeedSomewhere, assertStaff, loadAccount, loadSite, scopeToActor, type HostingActor } from '../hosting/access';
import { loadTenantLimits } from '../hosting/envelope.service';
import { iso, planLimits } from '../hosting/rows';
import { accountDbUsage, accountGauges } from './enforcement';
import { dayOf, daysBetween, fillTraffic, gaugeOf, mbToBytes, monthDays, monthRange, parseMonth } from './gauges';
import { platformSettings } from '../platformSettings';

// ─────────────────────────────────────────────────────────────────────────────
// Usage read API (module usage, docs/P2-PLAN.md §6.5). Access through
// access.ts: account / site → read on the object (404 invisible, 403 without
// the need); tenant → staff with 'read' (god view may pick ?tenantId=);
// platform → platform admin; alerts → scoped to the actor (a client sees the
// alerts of its own accounts only, never tenant envelope alerts).
// Month = calendar month UTC; resources = last 24 h in 5-min buckets.
// ─────────────────────────────────────────────────────────────────────────────

const RESOURCE_WINDOW_MS = 24 * 3600 * 1000;
const BUCKET_SEC = 300;

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

async function thresholds(): Promise<number[]> {
  try { return (await platformSettings.section('usage')).alertThresholds; } catch { return [80, 100]; }
}

interface DayRow { day: string | Date; requests: string | number; bytes_out: string | number; bytes_in: string | number }

const dayStr = (d: string | Date): string => (d instanceof Date ? dayOf(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))) : String(d).slice(0, 10));

function toPoints(rows: DayRow[]): Array<{ day: string; requests: number; bytesOut: number; bytesIn: number }> {
  return rows.map((r) => ({ day: dayStr(r.day), requests: n(r.requests), bytesOut: n(r.bytes_out), bytesIn: n(r.bytes_in) }));
}

/** Daily traffic sums (filtered by the caller's where). */
function dailyTraffic(where: (q: ReturnType<typeof db>) => void, from: string, toExclusive: string) {
  const q = db('usage_traffic_daily')
    .where('day', '>=', from).andWhere('day', '<', toExclusive)
    .groupBy('day').orderBy('day')
    .select(db.raw("to_char(day, 'YYYY-MM-DD') AS day"), db.raw('SUM(requests) AS requests'), db.raw('SUM(bytes_out) AS bytes_out'), db.raw('SUM(bytes_in) AS bytes_in'));
  where(q);
  return q as unknown as Promise<DayRow[]>;
}

/** 5-min buckets of the last 24 h: per-minute sums over the containers, then avg / max per bucket. */
async function resourceSeries(where: { accountId?: number; siteId?: number } = {}, now: Date = new Date()): Promise<ResourcePoint[]> {
  const since = new Date(now.getTime() - RESOURCE_WINDOW_MS);
  const params: Array<Date | number> = [since];
  let filter = '';
  if (where.accountId) { filter += ' AND account_id = ?'; params.push(where.accountId); }
  if (where.siteId) { filter += ' AND site_id = ?'; params.push(where.siteId); }
  const res = await db.raw(`
    SELECT to_timestamp(floor(extract(epoch FROM m.at) / ${BUCKET_SEC}) * ${BUCKET_SEC}) AS bucket,
           AVG(m.cpu) AS cpu, MAX(m.cpu) AS cpu_max, AVG(m.mem) AS mem, MAX(m.mem) AS mem_max
    FROM (
      SELECT at, SUM(cpu_pct) AS cpu, SUM(mem_bytes) AS mem
      FROM usage_resource_samples
      WHERE at >= ?${filter}
      GROUP BY at
    ) m
    GROUP BY 1
    ORDER BY 1`, params) as { rows: Array<{ bucket: Date | string; cpu: unknown; cpu_max: unknown; mem: unknown; mem_max: unknown }> };
  return res.rows.map((r) => ({
    at: iso(r.bucket) ?? '',
    cpuPct: Math.round(n(r.cpu) * 100) / 100,
    memBytes: Math.round(n(r.mem)),
    cpuPctMax: Math.round(n(r.cpu_max) * 100) / 100,
    memBytesMax: Math.round(n(r.mem_max)),
  }));
}

async function sumTraffic(where: (q: ReturnType<typeof db>) => void, month: string): Promise<number> {
  const { start, end } = monthRange(month);
  const q = db('usage_traffic_daily').where('day', '>=', start).andWhere('day', '<', end).first(db.raw('COALESCE(SUM(bytes_out), 0) AS b'));
  where(q);
  return n(((await q) as { b?: unknown } | undefined)?.b);
}

function toAlert(r: Record<string, unknown>): UsageAlert {
  return {
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    accountId: r.account_id === null || r.account_id === undefined ? null : Number(r.account_id),
    scope: r.scope as UsageAlert['scope'],
    dimension: r.dimension as UsageAlert['dimension'],
    level: Number(r.level),
    period: String(r.period),
    used: n(r.used),
    limit: n(r.limit_value),
    notifiedAt: iso(r.notified_at as Date | null),
    clearedAt: iso(r.cleared_at as Date | null),
    createdAt: iso(r.created_at as Date) ?? '',
  };
}

function assertPlatformAdmin(actor: HostingActor): void {
  if (actor.kind !== 'staff' || actor.caps !== '*' || !actor.globalView) throw new AppError(403, 'Insufficient permissions');
}

export const usageQueryService = {
  async account(actor: HostingActor, accountId: number, month?: string | null): Promise<AccountUsage> {
    const row = await loadAccount(actor, accountId, 'read');
    const m = parseMonth(month);
    const { start, end } = monthRange(m);
    const plan = await db('plans').where({ id: row.plan_id, tenant_id: row.tenant_id }).first('limits') as { limits: unknown } | undefined;
    const limits = planLimits(plan?.limits);
    const byAccount = (q: ReturnType<typeof db>) => { q.where({ account_id: row.id, tenant_id: row.tenant_id }); };

    const [days, siteRows, sites, diskRows, dbUsage, resources, th] = await Promise.all([
      dailyTraffic(byAccount, start, end),
      db('usage_traffic_daily').where({ account_id: row.id, tenant_id: row.tenant_id }).andWhere('day', '>=', start).andWhere('day', '<', end)
        .groupBy('site_id').select('site_id', db.raw('SUM(requests) AS requests'), db.raw('SUM(bytes_out) AS bytes_out')) as
        Promise<Array<{ site_id: number; requests: unknown; bytes_out: unknown }>>,
      db('sites').where({ account_id: row.id, tenant_id: row.tenant_id }).orderBy('name').select('id', 'name') as Promise<Array<{ id: number; name: string }>>,
      db('usage_disk_daily').where({ account_id: row.id }).andWhere('day', '>=', start).andWhere('day', '<', end).orderBy('day')
        .select(db.raw("to_char(day, 'YYYY-MM-DD') AS day"), 'used_bytes') as Promise<Array<{ day: string | Date; used_bytes: unknown }>>,
      accountDbUsage(row.id),
      resourceSeries({ accountId: row.id }),
      thresholds(),
    ]);
    const traffic = fillTraffic(monthDays(m), toPoints(days));
    const trafficBytes = traffic.reduce((s, p) => s + p.bytesOut, 0);
    const diskUsed = row.disk_used_bytes === null || row.disk_used_bytes === undefined ? null : n(row.disk_used_bytes);
    const perSite = new Map(siteRows.map((r) => [Number(r.site_id), r]));
    const siteTraffic: SiteTraffic[] = sites.map((s) => ({
      siteId: s.id, siteName: s.name, requests: n(perSite.get(s.id)?.requests), bytesOut: n(perSite.get(s.id)?.bytes_out),
    }));
    // site 0 = traffic of the account that matched no site (placeholder, redirects); deleted sites likewise.
    const known = new Set(sites.map((s) => s.id));
    const other = siteRows.filter((r) => !known.has(Number(r.site_id)));
    if (other.length) {
      siteTraffic.push({ siteId: 0, siteName: '', requests: other.reduce((s, r) => s + n(r.requests), 0), bytesOut: other.reduce((s, r) => s + n(r.bytes_out), 0) });
    }
    return {
      accountId: row.id,
      month: m,
      overQuota: (row.over_quota_state ?? 'ok') as OverQuotaState,
      gauges: accountGauges(limits, { diskUsedBytes: diskUsed, trafficBytes, dbUsage }, th),
      traffic,
      sites: siteTraffic,
      disk: {
        usedBytes: diskUsed,
        quotaBytes: mbToBytes(limits.diskMb),
        checkedAt: iso(row.usage_checked_at),
        history: diskRows.map((r) => ({ day: dayStr(r.day), usedBytes: n(r.used_bytes) })),
      },
      databases: { instances: dbUsage?.instances ?? 0, databases: dbUsage?.databases ?? 0, sizeBytes: dbUsage?.sizeBytes ?? null },
      resources,
    };
  },

  async site(actor: HostingActor, siteId: number, days?: number | null): Promise<SiteUsage> {
    const site = await loadSite(actor, siteId, 'read');
    const d = Math.min(90, Math.max(1, Math.floor(Number(days) || 30)));
    const today = dayOf();
    const from = dayOf(new Date(Date.now() - (d - 1) * 86_400_000));
    const tomorrow = dayOf(new Date(Date.now() + 86_400_000));
    const where = (q: ReturnType<typeof db>) => { q.where({ account_id: site.account_id, site_id: site.id, tenant_id: site.tenant_id }); };
    const [rows, codes, resources] = await Promise.all([
      dailyTraffic(where, from, tomorrow),
      db('usage_traffic_daily').where({ account_id: site.account_id, site_id: site.id, tenant_id: site.tenant_id })
        .andWhere('day', '>=', from).andWhere('day', '<', tomorrow).select('status_codes') as Promise<Array<{ status_codes: unknown }>>,
      resourceSeries({ accountId: site.account_id, siteId: site.id }),
    ]);
    const statusCodes: Record<string, number> = {};
    for (const r of codes) {
      const obj = typeof r.status_codes === 'string' ? JSON.parse(r.status_codes) : r.status_codes;
      for (const [k, v] of Object.entries((obj ?? {}) as Record<string, unknown>)) statusCodes[k] = (statusCodes[k] ?? 0) + n(v);
    }
    return { siteId: site.id, traffic: fillTraffic(daysBetween(from, today), toPoints(rows)), resources, statusCodes };
  },

  async tenant(actor: HostingActor, tenantId?: number | null, month?: string | null): Promise<TenantUsage> {
    assertStaff(actor);
    assertNeedSomewhere(actor, 'read');
    const target = actor.globalView && tenantId && Number.isInteger(tenantId) && tenantId > 0 ? tenantId : actor.tenantId;
    const exists = await db('tenants').where({ id: target }).first('id');
    if (!exists) throw new AppError(404, 'Tenant not found', 'notFound');
    const m = parseMonth(month);
    const { start, end } = monthRange(m);
    const byTenant = (q: ReturnType<typeof db>) => { q.where({ tenant_id: target }); };
    const [days, accounts, sites, dbInstances, limits, th, top] = await Promise.all([
      dailyTraffic(byTenant, start, end),
      db('hosting_accounts').where({ tenant_id: target }).whereNot('status', 'deleting')
        .first(db.raw('COUNT(*) AS c'), db.raw('COALESCE(SUM(disk_used_bytes), 0) AS disk')) as Promise<{ c: unknown; disk: unknown } | undefined>,
      db('sites').where({ tenant_id: target }).first(db.raw('COUNT(*) AS c')) as Promise<{ c: unknown } | undefined>,
      db('db_instances').where({ tenant_id: target }).first(db.raw('COUNT(*) AS c')) as Promise<{ c: unknown } | undefined>,
      loadTenantLimits(target),
      thresholds(),
      topAccounts(target, start, end),
    ]);
    const traffic = fillTraffic(monthDays(m), toPoints(days));
    const trafficBytes = traffic.reduce((s, p) => s + p.bytesOut, 0);
    const diskUsedBytes = n(accounts?.disk);
    return {
      tenantId: target,
      month: m,
      traffic,
      totals: { trafficBytes, diskUsedBytes, accounts: n(accounts?.c), sites: n(sites?.c), dbInstances: n(dbInstances?.c) },
      envelope: { trafficMbPerMonth: limits.trafficMbPerMonth, diskMb: limits.diskMb },
      gauges: [
        gaugeOf('disk', diskUsedBytes, mbToBytes(limits.diskMb), th),
        gaugeOf('traffic', trafficBytes, mbToBytes(limits.trafficMbPerMonth), th),
      ],
      topAccounts: top,
    };
  },

  async platform(actor: HostingActor, month?: string | null): Promise<PlatformUsage> {
    assertPlatformAdmin(actor);
    const m = parseMonth(month);
    const { start, end } = monthRange(m);
    const [days, perTenantTraffic, perTenantAccounts, tenants, sites, dbInstances, resources] = await Promise.all([
      dailyTraffic(() => { /* every tenant */ }, start, end),
      db('usage_traffic_daily').where('day', '>=', start).andWhere('day', '<', end).groupBy('tenant_id')
        .select('tenant_id', db.raw('SUM(bytes_out) AS b')) as Promise<Array<{ tenant_id: number; b: unknown }>>,
      db('hosting_accounts').whereNot('status', 'deleting').groupBy('tenant_id')
        .select('tenant_id', db.raw('COUNT(*) AS c'), db.raw('COALESCE(SUM(disk_used_bytes), 0) AS disk')) as Promise<Array<{ tenant_id: number; c: unknown; disk: unknown }>>,
      db('tenants').orderBy('name').select('id', 'name') as Promise<Array<{ id: number; name: string }>>,
      db('sites').first(db.raw('COUNT(*) AS c')) as Promise<{ c: unknown } | undefined>,
      db('db_instances').first(db.raw('COUNT(*) AS c')) as Promise<{ c: unknown } | undefined>,
      resourceSeries(),
    ]);
    const traffic = fillTraffic(monthDays(m), toPoints(days));
    const tByTenant = new Map(perTenantTraffic.map((r) => [Number(r.tenant_id), n(r.b)]));
    const aByTenant = new Map(perTenantAccounts.map((r) => [Number(r.tenant_id), r]));
    const rows = tenants.map((t) => ({
      tenantId: t.id,
      name: t.name,
      trafficBytes: tByTenant.get(t.id) ?? 0,
      diskUsedBytes: n(aByTenant.get(t.id)?.disk),
      accounts: n(aByTenant.get(t.id)?.c),
    }));
    return {
      month: m,
      traffic,
      totals: {
        trafficBytes: traffic.reduce((s, p) => s + p.bytesOut, 0),
        diskUsedBytes: rows.reduce((s, r) => s + r.diskUsedBytes, 0),
        tenants: tenants.length,
        accounts: rows.reduce((s, r) => s + r.accounts, 0),
        sites: n(sites?.c),
        dbInstances: n(dbInstances?.c),
      },
      tenants: rows.sort((a, b) => b.trafficBytes - a.trafficBytes || b.diskUsedBytes - a.diskUsedBytes),
      resources,
    };
  },

  async alerts(actor: HostingActor, filters: { accountId?: number | null; open?: boolean }): Promise<UsageAlert[]> {
    if (actor.kind === 'staff') assertNeedSomewhere(actor, 'read');
    const q = db('usage_alerts as al').orderBy('al.created_at', 'desc').orderBy('al.id', 'desc').limit(200).select('al.*');
    if (filters.accountId) {
      const account = await loadAccount(actor, filters.accountId, 'read');
      q.where({ 'al.account_id': account.id, 'al.tenant_id': account.tenant_id });
    } else if (actor.kind === 'client') {
      q.where('al.scope', 'account');
      scopeToActor(actor, q, { tenant: 'al.tenant_id', account: 'al.account_id' });
    } else {
      scopeToActor(actor, q, { tenant: 'al.tenant_id', account: 'al.account_id' });
    }
    if (filters.open) q.whereNull('al.cleared_at');
    const rows = await q as Array<Record<string, unknown>>;
    return rows.map(toAlert);
  },
};

/** Top 10 accounts of a tenant by month traffic, then disk. */
async function topAccounts(tenantId: number, start: string, end: string): Promise<AccountUsageRow[]> {
  const rows = await db('hosting_accounts as a')
    .join('plans as p', 'p.id', 'a.plan_id')
    .leftJoin(
      db('usage_traffic_daily').where('day', '>=', start).andWhere('day', '<', end).andWhere({ tenant_id: tenantId })
        .groupBy('account_id').select('account_id', db.raw('SUM(bytes_out) AS b')).as('t'),
      't.account_id', 'a.id',
    )
    .where('a.tenant_id', tenantId)
    .whereNot('a.status', 'deleting')
    .orderByRaw('COALESCE(t.b, 0) DESC, COALESCE(a.disk_used_bytes, 0) DESC, a.id')
    .limit(10)
    .select('a.id', 'a.username', 'a.tenant_id', 'a.disk_used_bytes', 'a.over_quota_state', 'p.limits', db.raw('COALESCE(t.b, 0) AS traffic')) as
    Array<{ id: number; username: string; tenant_id: number; disk_used_bytes: unknown; over_quota_state: OverQuotaState | null; limits: unknown; traffic: unknown }>;
  return rows.map((r) => {
    const l = planLimits(r.limits);
    return {
      accountId: r.id,
      username: r.username,
      tenantId: r.tenant_id,
      diskUsedBytes: r.disk_used_bytes === null || r.disk_used_bytes === undefined ? null : n(r.disk_used_bytes),
      diskQuotaBytes: mbToBytes(l.diskMb),
      trafficBytes: n(r.traffic),
      trafficQuotaBytes: mbToBytes(l.trafficMbPerMonth),
      overQuota: r.over_quota_state ?? 'ok',
    };
  });
}

