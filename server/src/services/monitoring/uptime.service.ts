import type { Knex } from 'knex';
import type { Request } from 'express';
import type {
  UptimeCheckPoint, UptimeMonitor, UptimeMonitorInput, UptimeMonitorKind, UptimeMonitorUpdate, UptimeStatus,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { loadAccount, type HostingActor } from '../hosting/access';
import { loadOwned, type OwnedRow } from '../hosting/p4bAccess';
import { platformSettings } from '../platformSettings';
import { proxyContracts } from '../proxy/contracts';
import { loadProxyHost } from '../proxy/access';
import { notify } from '../usage/notifications.service';
import {
  accountPlanLimits, assertPlanRoom, isPlatformAdmin, jsonValue, lockOwnerScope, MAX_PLATFORM_MONITORS_PER_TENANT, mayUsePrivateTargets, ownerForCreate, ownerOf,
  planLimitError, sameOwner, scopeList, toIso, type ListFilter, type RowOwner,
} from './common';
import { emitMonitoring } from './events';
import { runCheck, type CheckResult, type CheckTarget } from './uptime/checker';
import { nextState } from './uptime/state';
import { assertTargetAllowed, isNodeAddress, resolveTarget, TargetRefusedError, type PinnedAddress } from './targetGuard';
import { NODE_WEB_PORTS, nodePublicAddresses, nodeRefusal } from './nodeAddresses';
import { runCertExpiryPass } from './certExpiry';

// ─────────────────────────────────────────────────────────────────────────────
// Uptime monitors (docs/P4b-PLAN.md §10.2). OWNED BY MODULE
// `monitoring-automation`. Frozen members: syncAutoMonitor (proxy-hosts),
// settingsChanged (hostingSettings.routes), start / stop (workers/index.ts).
//
//   - REST: CRUD, checks history, check-now (1 / 10 s / monitor), sync of the
//     auto monitors of an account's proxy hosts;
//   - scheduler: every TICK_MS the due monitors (interval elapsed + per
//     monitor jitter) are queued; the queue is drained at most
//     MAX_CONCURRENCY at once, a finished check launching the next one at
//     once (throughput is bound by the check latency, not by the tick);
//     auto monitors of a DISABLED proxy host are not checked (paused);
//     `retries` consecutive failures ⇒ down + notify('uptime.down') once per
//     outage, recovery ⇒ notify('uptime.up');
//   - raw points (uptime_checks, retention settings.uptimeRetentionDays) +
//     daily aggregates (uptime_daily, kept 400 days: the public pages show 90);
//   - daily: certificate expiry notifications (certExpiry.ts);
//   - anti-SSRF (MO1): public addresses only; private ones only for a
//     platform monitor of the master tenant with allowPrivateTargets; the
//     node's own public addresses only on 80 / 443 by an HTTP check;
//   - interval >= settings.uptimeMinIntervalSec for every row (only a platform
//     admin may go down to PLATFORM_MIN_INTERVAL_SEC on a platform row);
//     platform rows capped per tenant (MAX_PLATFORM_MONITORS_PER_TENANT).
// ─────────────────────────────────────────────────────────────────────────────

export const TICK_MS = 5_000;
export const MAX_CONCURRENCY = 32;
const DUE_BATCH = 500;
const CHECK_NOW_MIN_MS = 10_000;
const DAILY_KEEP_DAYS = 400;
const HOUR_MS = 3_600_000;
const AUTO_INTERVAL_SEC = 60;
const AUTO_TIMEOUT_MS = 5_000;
const PLATFORM_MIN_INTERVAL_SEC = 10;

export interface MonitorRow extends OwnedRow {
  name: string;
  kind: UptimeMonitorKind;
  url: string | null;
  host: string | null;
  port: number | null;
  keyword: string | null;
  keyword_invert: boolean;
  method: 'GET' | 'HEAD';
  expected_status: unknown;
  interval_sec: number;
  timeout_ms: number;
  retries: number;
  proxy_host_id: number | null;
  auto: boolean;
  notify: boolean;
  enabled: boolean;
  status: UptimeStatus;
  consecutive_failures: number;
  last_checked_at: Date | string | null;
  last_latency_ms: number | null;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

// ── test seams ───────────────────────────────────────────────────────────────

type Resolver = (host: string, allowPrivate: boolean) => Promise<PinnedAddress>;
let resolver: Resolver = (host, allowPrivate) => resolveTarget(host, { allowPrivate });
let saveLookup: ((host: string) => Promise<Array<{ address: string; family: number }>>) | undefined;

export function setUptimeResolverForTests(r: Resolver | null, lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>): void {
  resolver = r ?? ((host, allowPrivate) => resolveTarget(host, { allowPrivate }));
  saveLookup = lookup;
}

// ── mapping ──────────────────────────────────────────────────────────────────

export interface UptimeRatios { uptime24h: number | null; uptime30d: number | null }

export function toMonitor(r: MonitorRow, ratios?: UptimeRatios): UptimeMonitor {
  return {
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    accountId: r.account_id === null ? null : Number(r.account_id),
    name: r.name,
    kind: r.kind,
    url: r.url,
    host: r.host,
    port: r.port === null ? null : Number(r.port),
    keyword: r.keyword,
    keywordInvert: !!r.keyword_invert,
    method: r.method === 'HEAD' ? 'HEAD' : 'GET',
    expectedStatus: jsonValue<number[]>(r.expected_status, []).filter((n) => Number.isInteger(n)),
    intervalSec: Number(r.interval_sec),
    timeoutMs: Number(r.timeout_ms),
    retries: Number(r.retries),
    proxyHostId: r.proxy_host_id === null ? null : Number(r.proxy_host_id),
    auto: !!r.auto,
    notify: !!r.notify,
    enabled: !!r.enabled,
    status: r.status,
    consecutiveFailures: Number(r.consecutive_failures),
    lastCheckedAt: toIso(r.last_checked_at),
    lastLatencyMs: r.last_latency_ms === null ? null : Number(r.last_latency_ms),
    lastError: r.last_error,
    uptime24h: ratios?.uptime24h ?? null,
    uptime30d: ratios?.uptime30d ?? null,
    createdAt: toIso(r.created_at)!,
    updatedAt: toIso(r.updated_at)!,
  };
}

function ratio(up: number, total: number): number | null {
  return total > 0 ? Math.round((up / total) * 10_000) / 10_000 : null;
}

/** uptime24h (raw points) and uptime30d (daily aggregates) of monitors. */
export async function uptimeRatios(ids: number[], now: Date = new Date(), conn: Knex = db): Promise<Map<number, UptimeRatios>> {
  const out = new Map<number, UptimeRatios>();
  if (ids.length === 0) return out;
  const day = await conn('uptime_checks').whereIn('monitor_id', ids).andWhere('at', '>=', new Date(now.getTime() - 24 * HOUR_MS))
    .groupBy('monitor_id').select('monitor_id', conn.raw('COUNT(*) AS total'), conn.raw('COUNT(*) FILTER (WHERE ok) AS up')) as
    Array<{ monitor_id: number; total: string; up: string }>;
  const month = await conn('uptime_daily').whereIn('monitor_id', ids).andWhere('day', '>=', new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10))
    .groupBy('monitor_id').select('monitor_id', conn.raw('SUM(checks) AS total'), conn.raw('SUM(up) AS up')) as
    Array<{ monitor_id: number; total: string; up: string }>;
  for (const id of ids) out.set(id, { uptime24h: null, uptime30d: null });
  for (const r of day) out.get(Number(r.monitor_id))!.uptime24h = ratio(Number(r.up), Number(r.total));
  for (const r of month) out.get(Number(r.monitor_id))!.uptime30d = ratio(Number(r.up), Number(r.total));
  return out;
}

// ── validation ───────────────────────────────────────────────────────────────

function invalid(message: string): AppError {
  return new AppError(400, message, 'validation');
}

function targetNotAllowed(): AppError {
  return new AppError(403, 'This destination is not allowed (private or internal address)', 'targetNotAllowed');
}

interface MonitorFields {
  name: string;
  kind: UptimeMonitorKind;
  url: string | null;
  host: string | null;
  port: number | null;
  keyword: string | null;
  keywordInvert: boolean;
  method: 'GET' | 'HEAD';
  expectedStatus: number[];
  intervalSec: number;
  timeoutMs: number;
  retries: number;
  proxyHostId: number | null;
  notify: boolean;
  enabled: boolean;
}

/** Semantic checks of a full field set (zod checked the shapes). */
async function checkFields(actor: HostingActor, owner: RowOwner, f: MonitorFields, opts: { checkInterval: boolean } = { checkInterval: true }): Promise<MonitorFields> {
  const settings = await platformSettings.section('monitoring');
  const out = { ...f };
  if (f.kind === 'tcp') {
    if (!f.host || !f.port) throw invalid('A TCP monitor needs a host and a port');
    out.url = null;
    out.keyword = null;
  } else {
    if (!f.url) throw invalid('An HTTP monitor needs a URL');
    let u: URL;
    try {
      u = new URL(f.url);
    } catch {
      throw invalid('Invalid URL');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw invalid('Only http:// and https:// URLs are allowed');
    if (u.username || u.password) throw invalid('Credentials in the URL are not allowed');
    if (f.kind === 'keyword' && !f.keyword) throw invalid('A keyword monitor needs a keyword');
    if (f.kind !== 'keyword') out.keyword = null;
    out.host = null;
    out.port = null;
  }
  const minInterval = owner.accountId === null && isPlatformAdmin(actor)
    ? PLATFORM_MIN_INTERVAL_SEC
    : Math.max(PLATFORM_MIN_INTERVAL_SEC, settings.uptimeMinIntervalSec);
  if (opts.checkInterval && f.intervalSec < minInterval) throw new AppError(400, `The check interval must be at least ${minInterval} s`, 'intervalTooShort', { min: minInterval });
  if (f.timeoutMs > f.intervalSec * 1000) throw invalid('The timeout must be shorter than the interval');
  if (f.proxyHostId !== null) {
    const host = await loadProxyHost(actor, f.proxyHostId, 'read');
    if (!sameOwner(ownerOf(host), owner)) throw new AppError(400, 'The proxy host belongs to another account', 'validation');
  }
  const allowPrivate = mayUsePrivateTargets(owner) && settings.allowPrivateTargets;
  const url = f.kind === 'tcp' ? null : new URL(f.url as string);
  const host = url ? url.hostname : (f.host as string);
  const httpPort = url ? (Number(url.port) || (url.protocol === 'http:' ? 80 : 443)) : null;
  try {
    await assertTargetAllowed(host, { allowPrivate, lookup: saveLookup, refuse: await nodeRefusal({ exempt: allowPrivate, httpPort }) });
  } catch (err) {
    if (err instanceof TargetRefusedError) throw targetNotAllowed();
    throw err;
  }
  return out;
}

function fieldsToRow(f: MonitorFields): Record<string, unknown> {
  return {
    name: f.name,
    kind: f.kind,
    url: f.url,
    host: f.host,
    port: f.port,
    keyword: f.keyword,
    keyword_invert: f.keywordInvert,
    method: f.method,
    expected_status: JSON.stringify(f.expectedStatus),
    interval_sec: f.intervalSec,
    timeout_ms: f.timeoutMs,
    retries: f.retries,
    proxy_host_id: f.proxyHostId,
    notify: f.notify,
    enabled: f.enabled,
  };
}

function rowToFields(r: MonitorRow): MonitorFields {
  const m = toMonitor(r);
  return {
    name: m.name, kind: m.kind, url: m.url, host: m.host, port: m.port, keyword: m.keyword, keywordInvert: m.keywordInvert, method: m.method,
    expectedStatus: m.expectedStatus, intervalSec: m.intervalSec, timeoutMs: m.timeoutMs, retries: m.retries, proxyHostId: m.proxyHostId,
    notify: m.notify, enabled: m.enabled,
  };
}

// ── checks ───────────────────────────────────────────────────────────────────

function checkTargetOf(r: MonitorRow): CheckTarget {
  const m = toMonitor(r);
  return {
    kind: m.kind, url: m.url, host: m.host, port: m.port, keyword: m.keyword, keywordInvert: m.keywordInvert, method: m.method,
    expectedStatus: m.expectedStatus, timeoutMs: m.timeoutMs,
  };
}

async function performCheck(r: MonitorRow): Promise<CheckResult> {
  const settings = await platformSettings.section('monitoring');
  const allowPrivate = mayUsePrivateTargets(ownerOf(r)) && settings.allowPrivateTargets;
  const node = allowPrivate ? [] : await nodePublicAddresses();
  const http = r.kind !== 'tcp';
  return runCheck(checkTargetOf(r), {
    resolve: async (host, port) => {
      const pin = await resolver(host, allowPrivate);
      // The node itself: only an HTTP check on 80 / 443 (every redirect hop judged on its own port).
      if (node.length > 0 && !(http && NODE_WEB_PORTS.has(port)) && isNodeAddress(pin.address, node)) {
        throw new TargetRefusedError('destination refused (address not allowed)');
      }
      return pin;
    },
  });
}

function notifyTransition(r: MonitorRow, event: 'down' | 'up', at: Date, error: string | null): void {
  if (!r.notify) return;
  const name = r.name;
  notify(event === 'down' ? 'uptime.down' : 'uptime.up', {
    tenantId: Number(r.tenant_id),
    accountId: r.account_id === null ? null : Number(r.account_id),
    key: `uptime:${r.id}:${event}:${at.getTime()}`,
    title: event === 'down' ? `Sonde « ${name} » en panne` : `Sonde « ${name} » rétablie`,
    message: event === 'down'
      ? `La sonde « ${name} » échoue${error ? ` (${error})` : ''} depuis ${Number(r.consecutive_failures) + 1} vérification(s).`
      : `La sonde « ${name} » répond de nouveau.`,
    severity: event === 'down' ? 'critical' : 'info',
    link: `/uptime?monitor=${r.id}`,
  });
}

/** Records one check result (raw point, daily aggregate, monitor state) and fires the transition events. */
export async function recordCheck(monitorId: number, result: CheckResult, at: Date = new Date()): Promise<UptimeCheckPoint | null> {
  const outcome = await db.transaction(async (trx) => {
    const r = await trx('uptime_monitors').where({ id: monitorId }).forUpdate().first() as MonitorRow | undefined;
    if (!r) return null;
    const t = nextState({ status: r.status, consecutiveFailures: Number(r.consecutive_failures) }, result.ok, Number(r.retries));
    await trx('uptime_checks').insert({
      monitor_id: monitorId, at, ok: result.ok, latency_ms: result.latencyMs, status_code: result.statusCode, error: result.error?.slice(0, 512) ?? null,
    }).onConflict(['monitor_id', 'at']).ignore();
    const latency = result.ok && result.latencyMs !== null ? result.latencyMs : null;
    await trx('uptime_daily').insert({ monitor_id: monitorId, day: at.toISOString().slice(0, 10), checks: 1, up: result.ok ? 1 : 0, avg_latency_ms: latency })
      .onConflict(['monitor_id', 'day']).merge({
        checks: trx.raw('uptime_daily.checks + 1'),
        up: trx.raw('uptime_daily.up + excluded.up'),
        avg_latency_ms: trx.raw(`CASE
          WHEN excluded.avg_latency_ms IS NULL THEN uptime_daily.avg_latency_ms
          WHEN uptime_daily.avg_latency_ms IS NULL OR uptime_daily.up = 0 THEN excluded.avg_latency_ms
          ELSE (uptime_daily.avg_latency_ms * uptime_daily.up + excluded.avg_latency_ms) / (uptime_daily.up + 1) END`),
      } as never);
    await trx('uptime_monitors').where({ id: monitorId }).update({
      status: r.enabled ? t.status : 'paused',
      consecutive_failures: t.consecutiveFailures,
      last_checked_at: at,
      last_latency_ms: result.latencyMs,
      last_error: result.ok ? null : result.error?.slice(0, 512) ?? null,
    });
    return { r, t };
  });
  if (!outcome) return null;
  const { r, t } = outcome;
  if (t.event && r.enabled) notifyTransition(r, t.event, at, result.error);
  if (t.status !== r.status) emitMonitoring({ entity: 'monitor', id: monitorId, accountId: r.account_id === null ? null : Number(r.account_id), action: 'status' }, ownerOf(r));
  return { at: at.toISOString(), ok: result.ok, latencyMs: result.latencyMs, statusCode: result.statusCode, error: result.ok ? null : result.error };
}

// ── scheduler ────────────────────────────────────────────────────────────────

const inFlight = new Set<number>();
/** Due monitors waiting for a slot (refilled by each tick, drained as checks finish). */
let queue: MonitorRow[] = [];
/** Per monitor: not before this instant (jitter spreads monitors created / restarted together). */
const notBefore = new Map<number, number>();
const lastCheckNow = new Map<number, number>();
let tickTimer: NodeJS.Timeout | null = null;
let ticking = false;
let lastDaily = 0;
let lastRetention = 0;
let started = false;

function jitterMs(intervalSec: number): number {
  return Math.floor(Math.random() * Math.min(intervalSec * 100, 10_000));
}

async function checkOne(r: MonitorRow): Promise<void> {
  const id = Number(r.id);
  inFlight.add(id);
  try {
    const result = await performCheck(r);
    await recordCheck(id, result);
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, monitorId: id }, 'Uptime check not recorded');
  } finally {
    inFlight.delete(id);
    notBefore.set(id, Date.now() + Number(r.interval_sec) * 1000 + jitterMs(Number(r.interval_sec)) - 1000);
    // A slot is free: the next queued monitor starts now, not at the next tick.
    if (started) pump(Date.now());
  }
}

/** Launches queued monitors while a slot is free. Returns the checks started. */
function pump(nowMs: number): number {
  let launched = 0;
  while (inFlight.size < MAX_CONCURRENCY && queue.length > 0) {
    const r = queue.shift() as MonitorRow;
    const id = Number(r.id);
    if (inFlight.has(id)) continue;
    const nb = notBefore.get(id);
    if (nb !== undefined && nb > nowMs) continue;
    launched++;
    void checkOne(r);
  }
  return launched;
}

/** One scheduler pass: starts the due checks (bounded concurrency). Exported for tests. */
export async function schedulerTick(now: Date = new Date()): Promise<number> {
  if (ticking) return 0;
  ticking = true;
  let launched = 0;
  try {
    const due = await db('uptime_monitors').where({ enabled: true })
      .andWhere((q) => q.whereNull('last_checked_at').orWhereRaw(`last_checked_at <= ?::timestamptz - make_interval(secs => interval_sec)`, [now]))
      // Auto monitor of a disabled proxy host: paused while the host is.
      .andWhereRaw(`NOT (auto AND EXISTS (SELECT 1 FROM proxy_hosts ph WHERE ph.id = uptime_monitors.proxy_host_id AND ph.enabled = false))`)
      .orderByRaw('last_checked_at ASC NULLS FIRST').limit(DUE_BATCH) as MonitorRow[];
    const next: MonitorRow[] = [];
    for (const r of due) {
      const id = Number(r.id);
      if (inFlight.has(id)) continue;
      const nb = notBefore.get(id);
      if (nb === undefined && r.last_checked_at === null) {
        // First sight of a never-checked monitor: spread the first checks.
        notBefore.set(id, now.getTime() + jitterMs(Number(r.interval_sec)));
        continue;
      }
      if (nb !== undefined && nb > now.getTime()) continue;
      next.push(r);
    }
    // Replaced, not appended: a row is never queued twice and never older than one tick.
    queue = next;
    launched = pump(now.getTime());
    if (now.getTime() - lastRetention >= HOUR_MS) {
      lastRetention = now.getTime();
      await purgeUptime(now);
      await sweepOrphanAutoMonitors();
    }
    if (now.getTime() - lastDaily >= 24 * HOUR_MS) {
      lastDaily = now.getTime();
      void runCertExpiryPass(now).catch((err) => logger.warn({ err: (err as Error)?.message }, 'Certificate expiry pass failed'));
    }
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'Uptime scheduler pass failed');
  } finally {
    ticking = false;
  }
  return launched;
}

export async function purgeUptime(now: Date = new Date(), conn: Knex = db): Promise<void> {
  const { uptimeRetentionDays } = await platformSettings.section('monitoring');
  const days = Math.max(1, Math.min(400, Math.floor(uptimeRetentionDays) || 30));
  await conn('uptime_checks').where('at', '<', new Date(now.getTime() - days * 86_400_000)).delete();
  await conn('uptime_daily').where('day', '<', new Date(now.getTime() - DAILY_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10)).delete();
}

/** Auto monitors whose proxy host disappeared (FK ON DELETE SET NULL). */
async function sweepOrphanAutoMonitors(): Promise<number> {
  const rows = await db('uptime_monitors').where({ auto: true }).whereNull('proxy_host_id').delete().returning(['id', 'tenant_id', 'account_id']) as OwnedRow[];
  for (const r of rows) emitMonitoring({ entity: 'monitor', id: Number(r.id), accountId: r.account_id === null ? null : Number(r.account_id), action: 'deleted' }, ownerOf(r));
  return rows.length;
}

// ── auto monitors of the proxy hosts ─────────────────────────────────────────

interface ProxyHostLite { id: number; tenant_id: number; account_id: number; name: string; enabled: boolean; auto_monitor: boolean; ssl: unknown }

async function firstDomainOf(hostId: number): Promise<string | null> {
  try {
    const s = await proxyContracts.hostSummary(hostId);
    if (s && s.domains.length > 0) return s.domains[0];
  } catch {
    // proxy-hosts not answering (stub / error): the bindings say the same.
  }
  const row = await db('edge_domain_bindings as b').join('domains as d', 'd.id', 'b.domain_id')
    .where({ 'b.kind': 'proxy', 'b.ref_id': hostId }).orderBy('d.name').first('d.name') as { name: string } | undefined;
  return row?.name ?? null;
}

type AutoSyncResult = 'created' | 'updated' | 'removed' | 'unchanged' | 'limit';

/** Brings the auto monitor of one proxy host in line with it. Throws on database errors only. */
export async function syncAutoMonitorNow(hostId: number): Promise<AutoSyncResult> {
  const host = await db('proxy_hosts').where({ id: hostId }).first('id', 'tenant_id', 'account_id', 'name', 'enabled', 'auto_monitor', 'ssl') as ProxyHostLite | undefined;
  const existing = await db('uptime_monitors').where({ proxy_host_id: hostId, auto: true }).first() as MonitorRow | undefined;
  const domain = host && host.auto_monitor ? await firstDomainOf(hostId) : null;
  if (!host || !host.auto_monitor || !domain) {
    // A deleted host already nulled proxy_host_id (FK SET NULL): its monitor is an orphan now.
    if (!host && !existing) return (await sweepOrphanAutoMonitors()) > 0 ? 'removed' : 'unchanged';
    if (!existing) return 'unchanged';
    await db('uptime_monitors').where({ id: existing.id }).delete();
    emitMonitoring({ entity: 'monitor', id: Number(existing.id), accountId: existing.account_id === null ? null : Number(existing.account_id), action: 'deleted' }, ownerOf(existing));
    return 'removed';
  }
  const ssl = jsonValue<{ mode?: string }>(host.ssl, {});
  const url = `${ssl.mode === 'none' ? 'http' : 'https'}://${domain}/`;
  const owner: RowOwner = { tenantId: Number(host.tenant_id), accountId: Number(host.account_id) };
  const fields = {
    name: host.name.slice(0, 128), kind: 'http', url, host: null, port: null, keyword: null, keyword_invert: false, method: 'GET',
    expected_status: JSON.stringify([]), interval_sec: AUTO_INTERVAL_SEC, timeout_ms: AUTO_TIMEOUT_MS,
  };
  if (existing) {
    // 'enabled' is the OWNER's switch (a pause survives every host save); the host's own state only drives the
    // status: disabled host => paused (not checked by the scheduler), re-enabled host => pending again.
    let status: UptimeStatus = existing.status;
    if (!host.enabled) status = 'paused';
    else if (existing.enabled && existing.status === 'paused') status = 'pending';
    const same = existing.url === url && existing.name === fields.name && existing.kind === 'http' && Number(existing.interval_sec) === AUTO_INTERVAL_SEC
      && status === existing.status;
    if (same) return 'unchanged';
    await db('uptime_monitors').where({ id: existing.id }).update({
      ...fields, status, ...(status === 'pending' ? { consecutive_failures: 0 } : {}), updated_at: new Date(),
    });
    emitMonitoring({ entity: 'monitor', id: Number(existing.id), accountId: owner.accountId, action: 'updated' }, owner);
    return 'updated';
  }
  try {
    const id = await db.transaction(async (trx) => {
      await assertPlanRoom(trx, owner.accountId, 'maxUptimeMonitors', 'uptime_monitors');
      const [row] = await trx('uptime_monitors').insert({
        tenant_id: owner.tenantId, account_id: owner.accountId, ...fields, retries: 2, proxy_host_id: hostId, auto: true, notify: true,
        enabled: true, status: host.enabled ? 'pending' : 'paused',
      }).returning('id');
      return Number((row as { id: number }).id ?? row);
    });
    emitMonitoring({ entity: 'monitor', id, accountId: owner.accountId, action: 'created' }, owner);
    return 'created';
  } catch (err) {
    if (err instanceof AppError && err.code === 'planLimit') return 'limit';
    throw err;
  }
}

const autoQueue = new Set<number>();
let autoTimer: NodeJS.Timeout | null = null;

function scheduleAutoSync(): void {
  if (autoTimer) return;
  autoTimer = setTimeout(() => {
    autoTimer = null;
    const ids = [...autoQueue];
    autoQueue.clear();
    void (async () => {
      for (const id of ids) {
        try {
          const r = await syncAutoMonitorNow(id);
          if (r === 'limit') logger.info({ proxyHostId: id }, 'Auto monitor not created: plan limit of uptime monitors reached');
        } catch (err) {
          logger.warn({ err: (err as Error)?.message, proxyHostId: id }, 'Auto monitor sync failed');
        }
      }
    })();
  }, 1_000);
  autoTimer.unref?.();
}

// ── REST ─────────────────────────────────────────────────────────────────────

/** Platform rows have no plan: at most MAX_PLATFORM_MONITORS_PER_TENANT per tenant (tenant row locked). */
async function assertPlatformRoom(trx: Knex.Transaction, tenantId: number): Promise<void> {
  await lockOwnerScope(trx, { tenantId, accountId: null });
  const row = await trx('uptime_monitors').where({ tenant_id: tenantId }).whereNull('account_id').count<{ count: string }[]>('* as count').first();
  if (Number(row?.count ?? 0) >= MAX_PLATFORM_MONITORS_PER_TENANT) {
    throw planLimitError('uptimeMonitors', MAX_PLATFORM_MONITORS_PER_TENANT, `At most ${MAX_PLATFORM_MONITORS_PER_TENANT} platform uptime monitors per tenant`);
  }
}

export interface MonitorListQuery extends ListFilter {
  status?: UptimeStatus;
}

const RANGE_HOURS = { '24h': 24, '7d': 7 * 24, '30d': 30 * 24 } as const;

async function loadMonitor(actor: HostingActor, id: number, need: 'read' | 'monitoring.manage'): Promise<MonitorRow> {
  return loadOwned<MonitorRow>(actor, 'uptime_monitors', id, need, 'Monitor');
}

async function withRatios(rows: MonitorRow[]): Promise<UptimeMonitor[]> {
  const ratios = await uptimeRatios(rows.map((r) => Number(r.id)));
  return rows.map((r) => toMonitor(r, ratios.get(Number(r.id))));
}

export const uptimeService = {
  /**
   * proxy-hosts, after a create / update / delete of a proxy host: creates / updates / removes its auto
   * monitor (autoMonitor flag; https://<first domain>/ every 60 s, timeout 5 s, expect 2xx/3xx). Never throws.
   */
  syncAutoMonitor(proxyHostId: number): void {
    try {
      if (!Number.isInteger(proxyHostId) || proxyHostId <= 0) return;
      autoQueue.add(proxyHostId);
      scheduleAutoSync();
    } catch (err) {
      logger.warn({ err, proxyHostId }, 'syncAutoMonitor failed');
    }
  },

  /** Settings section `monitoring` changed. Never throws. */
  settingsChanged(): void {
    try {
      // Retention / certificate thresholds are read at each pass; run the hourly jobs at the next tick.
      lastRetention = 0;
    } catch { /* never throws */ }
  },

  /** Worker: check scheduler, daily aggregation, retention, certificate expiry notifications. */
  start(): void {
    if (started) return;
    started = true;
    try {
      // First daily pass one minute after the start (not in the boot rush).
      lastDaily = Date.now() - 24 * HOUR_MS + 60_000;
      lastRetention = Date.now() - HOUR_MS + 120_000;
      tickTimer = setInterval(() => { void schedulerTick(); }, TICK_MS);
      tickTimer.unref?.();
    } catch (err) {
      logger.warn({ err }, 'Uptime worker failed to start');
    }
  },

  stop(): void {
    started = false;
    queue = [];
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = null;
  },

  async list(actor: HostingActor, q: MonitorListQuery): Promise<UptimeMonitor[]> {
    const qb = scopeList(actor, db('uptime_monitors as m'), 'm', q).select('m.*').orderBy('m.name');
    if (q.status) qb.where('m.status', q.status);
    return withRatios(await qb as MonitorRow[]);
  },

  async get(actor: HostingActor, id: number): Promise<UptimeMonitor> {
    const [m] = await withRatios([await loadMonitor(actor, id, 'read')]);
    return m;
  },

  async create(req: Request, actor: HostingActor, body: UptimeMonitorInput): Promise<UptimeMonitor> {
    const owner = await ownerForCreate(actor, body.accountId);
    const settings = await platformSettings.section('monitoring');
    const fields = await checkFields(actor, owner, {
      name: body.name,
      kind: body.kind,
      url: body.url ?? null,
      host: body.host ?? null,
      port: body.port ?? null,
      keyword: body.keyword ?? null,
      keywordInvert: body.keywordInvert ?? false,
      method: body.method ?? 'GET',
      expectedStatus: body.expectedStatus ?? [200],
      intervalSec: body.intervalSec ?? Math.max(60, settings.uptimeMinIntervalSec),
      timeoutMs: body.timeoutMs ?? 5000,
      retries: body.retries ?? 2,
      proxyHostId: body.proxyHostId ?? null,
      notify: body.notify ?? true,
      enabled: body.enabled ?? true,
    });
    const row = await db.transaction(async (trx) => {
      await assertPlanRoom(trx, owner.accountId, 'maxUptimeMonitors', 'uptime_monitors');
      if (owner.accountId === null) await assertPlatformRoom(trx, owner.tenantId);
      const [r] = await trx('uptime_monitors').insert({
        tenant_id: owner.tenantId, account_id: owner.accountId, ...fieldsToRow(fields), auto: false, status: fields.enabled ? 'pending' : 'paused',
      }).returning('*') as MonitorRow[];
      return r;
    });
    emitMonitoring({ entity: 'monitor', id: Number(row.id), accountId: owner.accountId, action: 'created' }, owner);
    await auditService.logReqAs(req, owner.tenantId, 'uptime.monitor.create', {
      resourceType: 'uptime_monitor', resourcePath: String(row.id), details: { name: fields.name, kind: fields.kind, accountId: owner.accountId },
    });
    return toMonitor(row);
  },

  async update(req: Request, actor: HostingActor, id: number, body: UptimeMonitorUpdate): Promise<UptimeMonitor> {
    const current = await loadMonitor(actor, id, 'monitoring.manage');
    const owner = ownerOf(current);
    if (current.auto) {
      const managed = (['kind', 'url', 'host', 'port', 'keyword', 'keywordInvert', 'method', 'expectedStatus', 'intervalSec', 'timeoutMs', 'proxyHostId'] as const)
        .filter((k) => body[k] !== undefined);
      if (managed.length > 0) throw new AppError(409, 'This monitor follows its proxy host: only its name, retries, notifications and state can change', 'autoMonitor', { fields: managed });
    }
    const merged: MonitorFields = { ...rowToFields(current) };
    for (const [k, v] of Object.entries(body)) if (v !== undefined) (merged as unknown as Record<string, unknown>)[k] = v;
    const fields = current.auto ? merged : await checkFields(actor, owner, merged, { checkInterval: body.intervalSec !== undefined });
    const patch: Record<string, unknown> = { ...fieldsToRow(fields), updated_at: new Date() };
    if (body.enabled === false) patch.status = 'paused';
    else if (body.enabled === true && !current.enabled) {
      patch.status = 'pending';
      patch.consecutive_failures = 0;
    }
    const [row] = await db('uptime_monitors').where({ id: current.id }).update(patch).returning('*') as MonitorRow[];
    notBefore.delete(Number(row.id));
    emitMonitoring({ entity: 'monitor', id: Number(row.id), accountId: owner.accountId, action: 'updated' }, owner);
    await auditService.logReqAs(req, owner.tenantId, 'uptime.monitor.update', {
      resourceType: 'uptime_monitor', resourcePath: String(row.id), details: { fields: Object.keys(body) },
    });
    const [m] = await withRatios([row]);
    return m;
  },

  async remove(req: Request, actor: HostingActor, id: number): Promise<void> {
    const current = await loadMonitor(actor, id, 'monitoring.manage');
    const owner = ownerOf(current);
    await db('uptime_monitors').where({ id: current.id }).delete();
    notBefore.delete(Number(current.id));
    emitMonitoring({ entity: 'monitor', id: Number(current.id), accountId: owner.accountId, action: 'deleted' }, owner);
    await auditService.logReqAs(req, owner.tenantId, 'uptime.monitor.delete', {
      resourceType: 'uptime_monitor', resourcePath: String(current.id), details: { name: current.name, auto: !!current.auto },
    });
  },

  async checks(actor: HostingActor, id: number, range: keyof typeof RANGE_HOURS, now: Date = new Date()): Promise<UptimeCheckPoint[]> {
    const m = await loadMonitor(actor, id, 'read');
    const from = new Date(now.getTime() - RANGE_HOURS[range] * HOUR_MS);
    if (range === '24h') {
      const rows = await db('uptime_checks').where({ monitor_id: m.id }).andWhere('at', '>=', from).orderBy('at')
        .select('at', 'ok', 'latency_ms', 'status_code', 'error') as Array<{ at: Date; ok: boolean; latency_ms: number | null; status_code: number | null; error: string | null }>;
      return rows.map((r) => ({ at: toIso(r.at)!, ok: !!r.ok, latencyMs: r.latency_ms, statusCode: r.status_code, error: r.error }));
    }
    // Longer ranges: one point per hour (all checks ok ⇒ ok; mean latency; last error of the hour).
    const rows = await db('uptime_checks').where({ monitor_id: m.id }).andWhere('at', '>=', from)
      .groupByRaw(`date_trunc('hour', at)`).orderByRaw(`date_trunc('hour', at)`)
      .select(db.raw(`date_trunc('hour', at) AS at`), db.raw('bool_and(ok) AS ok'), db.raw('ROUND(AVG(latency_ms))::int AS latency_ms'),
        db.raw('MAX(status_code) AS status_code'), db.raw('MAX(error) AS error')) as
      Array<{ at: Date; ok: boolean; latency_ms: number | null; status_code: number | null; error: string | null }>;
    return rows.map((r) => ({ at: toIso(r.at)!, ok: !!r.ok, latencyMs: r.latency_ms === null ? null : Number(r.latency_ms), statusCode: r.status_code === null ? null : Number(r.status_code), error: r.ok ? null : r.error }));
  },

  async checkNow(req: Request, actor: HostingActor, id: number): Promise<UptimeCheckPoint> {
    const m = await loadMonitor(actor, id, 'monitoring.manage');
    const key = Number(m.id);
    const last = lastCheckNow.get(key) ?? 0;
    if (Date.now() - last < CHECK_NOW_MIN_MS || inFlight.has(key)) throw new AppError(429, 'A check of this monitor ran less than 10 s ago', 'rateLimited');
    lastCheckNow.set(key, Date.now());
    if (lastCheckNow.size > 10_000) for (const [k, t] of lastCheckNow) if (Date.now() - t > CHECK_NOW_MIN_MS) lastCheckNow.delete(k);
    inFlight.add(key);
    try {
      const result = await performCheck(m);
      const point = await recordCheck(key, result);
      notBefore.set(key, Date.now() + Number(m.interval_sec) * 1000);
      await auditService.logReqAs(req, Number(m.tenant_id), 'uptime.monitor.checkNow', { resourceType: 'uptime_monitor', resourcePath: String(m.id) });
      return point ?? { at: new Date().toISOString(), ok: result.ok, latencyMs: result.latencyMs, statusCode: result.statusCode, error: result.error };
    } finally {
      inFlight.delete(key);
    }
  },

  async syncProxyHosts(req: Request, actor: HostingActor, accountId: number): Promise<{ created: number; removed: number }> {
    const account = await loadAccount(actor, accountId, 'monitoring.manage');
    const hosts = await db('proxy_hosts').where({ account_id: account.id }).pluck('id') as number[];
    let created = 0;
    let removed = 0;
    let limited = 0;
    for (const id of hosts) {
      const r = await syncAutoMonitorNow(Number(id));
      if (r === 'created') created++;
      else if (r === 'removed') removed++;
      else if (r === 'limit') limited++;
    }
    removed += await sweepOrphanAutoMonitors();
    await auditService.logReqAs(req, Number(account.tenant_id), 'uptime.monitor.syncProxyHosts', {
      resourceType: 'account', resourcePath: String(account.id), details: { created, removed, limited },
    });
    if (limited > 0) {
      const limits = await accountPlanLimits(Number(account.id));
      throw new AppError(409, `The plan allows at most ${limits.maxUptimeMonitors} uptime monitors (${limited} proxy host(s) left without a monitor)`, 'planLimit',
        { dimension: 'uptimeMonitors', limit: limits.maxUptimeMonitors, created, removed });
    }
    return { created, removed };
  },
};

/** Tests: scheduler state reset. */
export function resetUptimeForTests(): void {
  inFlight.clear();
  queue = [];
  notBefore.clear();
  lastCheckNow.clear();
  autoQueue.clear();
  lastDaily = Date.now();
  lastRetention = Date.now();
}
