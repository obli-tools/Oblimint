import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EdgeLogEntry } from './edgeLog';
import { TrafficAggregator, countsAsTraffic, utcDayOf } from './traffic';
import { cpuPercent, cpuReading, memoryBytes, resetCpuReadingsForTests, sampleOf } from './resources';
import { daysBetween, fillTraffic, gaugeOf, humanBytes, levelOf, monthDays, monthRange, parseMonth } from './gauges';
import { accountGauges, breachedDimensions, decideEnforcement, type EnforcementInput } from './enforcement';
import { DEFAULT_PLAN_LIMITS } from '@oblimint/shared';

// Pure computations of the usage module: traffic aggregation, docker stats →
// CPU / memory, gauges and threshold levels, months, the enforcement state
// machine.

const entry = (o: Partial<EdgeLogEntry>): EdgeLogEntry => ({
  time: '2026-10-09T10:00:00+00:00', host: 'h', remoteAddr: '1.1.1.1', method: 'GET', uri: '/', status: 200, bytes: 0, bytesOut: 100,
  bytesIn: 10, requestTime: 0, upstream: null, upstreamStatus: null, userAgent: '', referer: null, siteId: 5, accountId: 2, tenantId: 1, kind: 'site', ...o,
});

test('traffic aggregator: per (UTC day, account, site), lines without account ignored', () => {
  const a = new TrafficAggregator();
  a.add(entry({}));
  a.add(entry({ status: 404, bytesOut: 50, bytesIn: 5 }));
  a.add(entry({ siteId: null, kind: 'redirect', bytesOut: 7 }));
  a.add(entry({ accountId: null, bytesOut: 1_000_000 }));
  // 01:30 at +02:00 is the previous UTC day.
  a.add(entry({ time: '2026-10-10T01:30:00+02:00', bytesOut: 3 }));
  const b = a.drain().sort((x, y) => (x.day + x.siteId).localeCompare(y.day + y.siteId));
  assert.equal(a.size, 0);
  assert.equal(b.length, 2);
  const [site0, site5] = b;
  assert.deepEqual({ ...site0 }, { day: '2026-10-09', accountId: 2, siteId: 0, tenantId: 1, requests: 1, bytesOut: 7, bytesIn: 10, statusCodes: { 200: 1 } });
  assert.deepEqual({ ...site5 }, { day: '2026-10-09', accountId: 2, siteId: 5, tenantId: 1, requests: 3, bytesOut: 153, bytesIn: 25, statusCodes: { 200: 2, 404: 1 } });
});

test('traffic aggregator: placeholder, suspension page, ACME and 404 fallback are not account traffic', () => {
  const a = new TrafficAggregator();
  a.add(entry({ siteId: null, kind: 'placeholder', bytesOut: 1_000 }));
  a.add(entry({ siteId: null, kind: 'site', status: 503, bytesOut: 2_000 }));
  a.add(entry({ siteId: null, kind: 'preview', status: 404, bytesOut: 3_000 }));
  a.add(entry({ siteId: null, kind: 'suspended', status: 503, bytesOut: 4_000 }));
  assert.equal(a.size, 0);
  assert.equal(countsAsTraffic({ accountId: 2, siteId: 5, kind: 'secondary' }), true);
  assert.equal(countsAsTraffic({ accountId: 2, siteId: null, kind: 'redirect' }), true);
  assert.equal(countsAsTraffic({ accountId: 2, siteId: null, kind: 'secondary' }), false);
  assert.equal(countsAsTraffic({ accountId: null, siteId: 5, kind: 'site' }), false);
});

test('traffic aggregator: restore merges a failed flush back', () => {
  const a = new TrafficAggregator();
  a.add(entry({}));
  const drained = a.drain();
  a.add(entry({ status: 500, bytesOut: 1 }));
  a.restore(drained);
  const [b] = a.drain();
  assert.equal(b.requests, 2);
  assert.equal(b.bytesOut, 101);
  assert.deepEqual(b.statusCodes, { 200: 1, 500: 1 });
  assert.equal(drained[0].statusCodes['200'], 1, 'restore does not alias the drained objects');
});

test('utcDayOf: offsets and garbage', () => {
  assert.equal(utcDayOf('2026-10-31T23:30:00-02:00'), '2026-11-01');
  assert.equal(utcDayOf('garbage', new Date('2026-01-02T00:00:00Z')), '2026-01-02');
});

// ── docker stats ────────────────────────────────────────────────────────────

const STATS_V2 = {
  cpu_stats: { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 100_000_000_000, online_cpus: 4 },
  precpu_stats: { cpu_usage: { total_usage: 1_000_000_000 }, system_cpu_usage: 98_000_000_000, online_cpus: 4 },
  memory_stats: { usage: 300 * 1024 * 1024, stats: { inactive_file: 100 * 1024 * 1024, anon: 1 } },
};

test('CPU %: two readings, online cpus, as docker stats', () => {
  // 1e9 / 2e9 × 4 × 100 = 200 %
  assert.equal(cpuPercent(cpuReading(STATS_V2.cpu_stats), cpuReading(STATS_V2.precpu_stats)), 200);
  assert.equal(cpuPercent(cpuReading(STATS_V2.cpu_stats), null), 0);
  assert.equal(cpuPercent(cpuReading(STATS_V2.precpu_stats), cpuReading(STATS_V2.cpu_stats)), 0, 'counter going back');
  assert.equal(cpuReading({ cpu_usage: { total_usage: 5, percpu_usage: [1, 2] }, system_cpu_usage: 10 })!.online, 2);
  assert.equal(cpuReading({ cpu_usage: { total_usage: 5 }, system_cpu_usage: 0 }), null);
});

test('memory: usage − page cache (cgroup v2 / v1), never negative', () => {
  assert.equal(memoryBytes(STATS_V2.memory_stats), 200 * 1024 * 1024);
  assert.equal(memoryBytes({ usage: 1000, stats: { total_inactive_file: 300, cache: 900 } }), 700);
  assert.equal(memoryBytes({ usage: 1000, stats: { cache: 400 } }), 600);
  assert.equal(memoryBytes({ usage: 100, stats: { inactive_file: 400 } }), 0);
  assert.equal(memoryBytes(undefined), 0);
});

test('sampleOf: empty precpu_stats falls back to the previous reading of the container', () => {
  resetCpuReadingsForTests();
  const first = sampleOf('c1', { cpu_stats: STATS_V2.precpu_stats, precpu_stats: {}, memory_stats: { usage: 10 } });
  assert.equal(first.cpuPct, 0);
  const second = sampleOf('c1', { cpu_stats: STATS_V2.cpu_stats, precpu_stats: { cpu_usage: {}, system_cpu_usage: 0 }, memory_stats: { usage: 10 } });
  assert.equal(second.cpuPct, 200);
  assert.equal(sampleOf('c1', STATS_V2).cpuPct, 200, 'precpu_stats preferred when present');
});

// ── gauges / months ─────────────────────────────────────────────────────────

test('levels and gauges', () => {
  assert.equal(levelOf(79.9, [80, 100]), null);
  assert.equal(levelOf(80, [80, 100]), 80);
  assert.equal(levelOf(150, [100, 80]), 100);
  assert.equal(levelOf(null, [80]), null);
  assert.deepEqual(gaugeOf('disk', 900, 1000, [80, 100]), { dimension: 'disk', used: 900, limit: 1000, pct: 90, level: 80 });
  assert.deepEqual(gaugeOf('traffic', 5, null, [80, 100]), { dimension: 'traffic', used: 5, limit: null, pct: null, level: null });
  assert.equal(gaugeOf('databases', 1, 0, [80, 100]).level, 100, 'limit 0 reached by any use');
  assert.equal(gaugeOf('databases', 0, 0, [80, 100]).level, null);
  assert.equal(gaugeOf('disk', 1, 3, [80]).pct, 33.3);
});

test('months and day series', () => {
  assert.deepEqual(monthRange('2026-12'), { start: '2026-12-01', end: '2027-01-01' });
  assert.equal(parseMonth(undefined, new Date('2026-02-03T00:00:00Z')), '2026-02');
  assert.throws(() => parseMonth('2026-13'), /month/);
  assert.throws(() => parseMonth('26-01'), /month/);
  assert.equal(monthDays('2026-02', new Date('2026-10-09T12:00:00Z')).length, 28);
  assert.equal(monthDays('2026-10', new Date('2026-10-09T12:00:00Z')).length, 9);
  assert.equal(monthDays('2026-11', new Date('2026-10-09T12:00:00Z')).length, 0);
  assert.deepEqual(daysBetween('2026-02-27', '2026-03-01'), ['2026-02-27', '2026-02-28', '2026-03-01']);
  assert.deepEqual(fillTraffic(['2026-10-01', '2026-10-02'], [{ day: '2026-10-02', requests: 1, bytesOut: 2, bytesIn: 3 }]),
    [{ day: '2026-10-01', requests: 0, bytesOut: 0, bytesIn: 0 }, { day: '2026-10-02', requests: 1, bytesOut: 2, bytesIn: 3 }]);
  assert.equal(humanBytes(1536), '1,5 Kio');
  assert.equal(humanBytes(5), '5 o');
});

test('account gauges: plan limits in MiB, databases only when known', () => {
  const limits = { ...DEFAULT_PLAN_LIMITS, diskMb: 100, trafficMbPerMonth: 10, maxDatabases: 2, dbMaxSizeMb: null };
  const g = accountGauges(limits, { diskUsedBytes: 100 * 1048576, trafficBytes: 9 * 1048576, dbUsage: { databases: 1, sizeBytes: 5 } }, [80, 100]);
  assert.deepEqual(g.map((x) => [x.dimension, x.pct, x.level]), [['disk', 100, 100], ['traffic', 90, 80], ['databases', 50, null], ['dbSize', null, null]]);
  assert.deepEqual(breachedDimensions(g), ['disk']);
  assert.equal(accountGauges(limits, { diskUsedBytes: null, trafficBytes: 0, dbUsage: null }, [80]).length, 2);
});

// ── enforcement state machine ───────────────────────────────────────────────

const base: EnforcementInput = { status: 'active', state: 'ok', action: 'warn', breached: [], periodChanged: false };
const d = (o: Partial<EnforcementInput>) => decideEnforcement({ ...base, ...o });

test('enforcement: action at 100 % per plan', () => {
  assert.deepEqual(d({ breached: ['traffic'] }), { kind: 'setState', state: 'warn', reason: 'overQuota' });
  assert.deepEqual(d({ breached: ['disk'], action: 'block-uploads' }), { kind: 'setState', state: 'blocked', reason: 'overQuota' });
  assert.deepEqual(d({ breached: ['disk', 'traffic'], action: 'suspend' }), { kind: 'suspend', dimension: 'disk' });
  assert.deepEqual(d({ breached: [] }), { kind: 'none' });
});

test('enforcement: once per period (already applied → nothing)', () => {
  assert.deepEqual(d({ breached: ['traffic'], state: 'warn' }), { kind: 'none' });
  assert.deepEqual(d({ breached: ['disk'], state: 'blocked', action: 'block-uploads' }), { kind: 'none' });
  assert.deepEqual(d({ breached: ['traffic'], state: 'suspended', status: 'suspended', action: 'suspend' }), { kind: 'none' });
});

test('enforcement: a staff unsuspension is respected until the next period', () => {
  // staff reactivated: status active, state still 'suspended'
  assert.deepEqual(d({ breached: ['traffic'], state: 'suspended', status: 'active', action: 'suspend' }), { kind: 'none' });
  // new month, still over the traffic (unlikely but possible): re-armed
  assert.deepEqual(d({ breached: ['traffic'], state: 'suspended', status: 'active', action: 'suspend', periodChanged: true }), { kind: 'suspend', dimension: 'traffic' });
  // the disk has no monthly period: still respected
  assert.deepEqual(d({ breached: ['disk'], state: 'suspended', status: 'active', action: 'suspend', periodChanged: true }), { kind: 'none' });
  // back under: the state is cleared, the account stays active
  assert.deepEqual(d({ state: 'suspended', status: 'active' }), { kind: 'setState', state: 'ok', reason: 'underQuota' });
});

test('enforcement: a staff suspension is never taken over', () => {
  assert.deepEqual(d({ breached: ['traffic'], status: 'suspended', action: 'suspend' }), { kind: 'none' });
  assert.deepEqual(d({ breached: ['traffic'], status: 'provisioning', action: 'suspend' }), { kind: 'none' });
  assert.deepEqual(d({ status: 'deleting', breached: ['disk'], action: 'block-uploads' }), { kind: 'none' });
});

test('enforcement: lifting and the monthly reset', () => {
  assert.deepEqual(d({ state: 'blocked' }), { kind: 'setState', state: 'ok', reason: 'underQuota' });
  assert.deepEqual(d({ state: 'warn' }), { kind: 'setState', state: 'ok', reason: 'underQuota' });
  assert.deepEqual(d({ state: 'suspended', status: 'suspended', periodChanged: true }), { kind: 'reactivate', reason: 'monthlyReset' });
  assert.deepEqual(d({ state: 'suspended', status: 'suspended' }), { kind: 'reactivate', reason: 'underQuota' });
});

test('enforcement: plan action changed while over quota', () => {
  assert.deepEqual(d({ breached: ['disk'], state: 'warn', action: 'block-uploads' }), { kind: 'setState', state: 'blocked', reason: 'overQuota' });
  assert.deepEqual(d({ breached: ['disk'], state: 'blocked', action: 'warn' }), { kind: 'setState', state: 'warn', reason: 'overQuota' });
  assert.deepEqual(d({ breached: ['disk'], state: 'blocked', action: 'suspend' }), { kind: 'suspend', dimension: 'disk' });
});
