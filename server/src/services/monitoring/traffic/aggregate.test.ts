import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EdgeLogEntry } from '../../usage/edgeLog';
import {
  HEAVY_HITTERS_CAPACITY, HISTOGRAM_SIZE, HeavyHitters, MAX_MINUTE_BUCKETS, ProxyTrafficAggregator, SAMPLES_PER_HOST, TOP_SIZE,
  bucketIndex, countriesOf, emptyHistogram, errorRate, isProxyHostEntry, mergeTopEntries, percentileFromHistogram, rollupToHours, uriKey,
  type StoredTrafficRow,
} from './aggregate';
import { buildSeries, isMinuteRange } from './traffic.service';

const entry = (over: Partial<EdgeLogEntry> = {}): EdgeLogEntry => ({
  time: '2026-10-10T12:00:30+00:00',
  host: 'vault.example.fr',
  remoteAddr: '203.0.113.7',
  method: 'GET',
  uri: '/index.html?token=secret',
  status: 200,
  bytes: 100,
  bytesOut: 300,
  bytesIn: 50,
  requestTime: 0.02,
  upstream: '10.240.0.5:80',
  upstreamStatus: '200',
  userAgent: 'curl/8',
  referer: null,
  siteId: null,
  accountId: 7,
  tenantId: 1,
  kind: 'proxy',
  proxyHostId: 3,
  ...over,
});

test('histogram buckets and percentiles (interpolated, overflow, empty)', () => {
  assert.equal(HISTOGRAM_SIZE, 12);
  assert.equal(bucketIndex(0), 0);
  assert.equal(bucketIndex(5), 0);
  assert.equal(bucketIndex(5.1), 1);
  assert.equal(bucketIndex(10_000), 10);
  assert.equal(bucketIndex(10_001), 11);
  assert.equal(percentileFromHistogram(emptyHistogram(), 0.5), null);

  const h = emptyHistogram();
  h[bucketIndex(20)] = 100; // (10, 25]
  assert.equal(percentileFromHistogram(h, 0.5), 17.5);
  assert.equal(percentileFromHistogram(h, 1), 25);

  const mixed = emptyHistogram();
  mixed[0] = 90; // ≤ 5 ms
  mixed[bucketIndex(900)] = 9; // (500, 1000]
  mixed[11] = 1; // > 10 s
  assert.ok((percentileFromHistogram(mixed, 0.5) as number) <= 5);
  const p95 = percentileFromHistogram(mixed, 0.95) as number;
  assert.ok(p95 > 500 && p95 <= 1000, `p95 ${p95}`);
  assert.equal(percentileFromHistogram(mixed, 0.995), 10_000, 'overflow bucket answers its lower bound');
});

test('aggregator: only kind proxy with a host id, per (host, minute), status classes, upstream errors, bytes, latency', () => {
  const a = new ProxyTrafficAggregator();
  const now = new Date('2026-10-10T12:05:00Z');
  a.add(entry(), now);
  a.add(entry({ status: 502, requestTime: 1.5 }), now);
  a.add(entry({ status: 404, time: '2026-10-10T12:01:10Z' }), now);
  a.add(entry({ kind: 'proxy-redirect', proxyHostId: 3 }), now); // a redirection id: not a proxy host
  a.add(entry({ kind: 'site', proxyHostId: null }), now);
  a.add(entry({ kind: 'proxy', proxyHostId: null }), now);
  a.add(entry({ proxyHostId: 4, time: 'garbage' }), now); // unparsable time → now's minute
  assert.equal(isProxyHostEntry({ kind: 'dead', proxyHostId: 9 }), false);

  const d = a.drain();
  assert.equal(a.size, 0, 'drained');
  const m0 = d.minutes.find((m) => m.proxyHostId === 3 && m.minute === '2026-10-10T12:00:00.000Z')!;
  assert.equal(m0.requests, 2);
  assert.equal(m0.s2xx, 1);
  assert.equal(m0.s5xx, 1);
  assert.equal(m0.upstreamErrors, 1);
  assert.equal(m0.bytesOut, 600);
  assert.equal(m0.bytesIn, 100);
  assert.equal(m0.latencySumMs, 1520);
  assert.equal(m0.latency.reduce((x, y) => x + y, 0), 2);
  const m1 = d.minutes.find((m) => m.minute === '2026-10-10T12:01:00.000Z')!;
  assert.equal(m1.s4xx, 1);
  assert.ok(d.minutes.some((m) => m.proxyHostId === 4 && m.minute === '2026-10-10T12:05:00.000Z'));
  assert.equal(d.minutes.length, 3);

  const top = d.tops.find((t) => t.proxyHostId === 3)!;
  assert.equal(top.hour, '2026-10-10T12:00:00.000Z');
  assert.deepEqual(top.uris.top().map((u) => u.key), ['/index.html'], 'query string dropped');
  assert.equal(top.ips.top()[0].requests, 3);
  assert.equal(top.ips.top()[0].errors, 2, '404 + 502');

  assert.deepEqual(d.samples.filter((s) => s.proxyHostId === 3).map((s) => s.kind).sort(), ['error', 'slow']);
  const slow = d.samples.find((s) => s.kind === 'slow')!;
  assert.equal(slow.requestTimeMs, 1500);
  assert.equal(slow.status, 502);
});

test('aggregator restore merges a failed flush with newer lines', () => {
  const a = new ProxyTrafficAggregator();
  const now = new Date('2026-10-10T12:05:00Z');
  a.add(entry(), now);
  const d = a.drain();
  a.add(entry(), now);
  a.restore(d);
  const again = a.drain();
  assert.equal(again.minutes.length, 1);
  assert.equal(again.minutes[0].requests, 2);
  assert.equal(again.minutes[0].latency.reduce((x, y) => x + y, 0), 2);
  assert.equal(again.tops[0].ips.top()[0].requests, 2);
});

test('memory bounds: minute buckets capped, samples capped per host and kind', () => {
  const a = new ProxyTrafficAggregator();
  const now = new Date('2026-10-10T12:05:00Z');
  for (let i = 0; i < SAMPLES_PER_HOST + 50; i++) a.add(entry({ status: 500, uri: `/e${i}` }), now);
  const d = a.drain();
  const errors = d.samples.filter((s) => s.kind === 'error');
  assert.equal(errors.length, SAMPLES_PER_HOST);
  assert.equal(errors[errors.length - 1].uri, `/e${SAMPLES_PER_HOST + 49}`, 'newest kept');

  const b = new ProxyTrafficAggregator();
  for (let i = 0; i < MAX_MINUTE_BUCKETS + 5; i++) b.add(entry({ proxyHostId: i + 1 }), now);
  assert.equal(b.size, MAX_MINUTE_BUCKETS);
  assert.equal(b.dropped, 5);
});

test('heavy hitters: exact under capacity, bounded beyond, top kept on skewed traffic', () => {
  const h = new HeavyHitters(10);
  for (let i = 0; i < 5; i++) h.add(`k${i}`, i + 1, 10, 0);
  assert.deepEqual(h.top(3).map((e) => [e.key, e.requests]), [['k4', 5], ['k3', 4], ['k2', 3]]);

  const big = new HeavyHitters();
  for (let i = 0; i < 10_000; i++) big.add(`noise-${i}`, 1, 1, 0);
  for (let i = 0; i < 5_000; i++) big.add('heavy', 1, 1, 1);
  for (let i = 0; i < 10_000; i++) big.add(`noise2-${i}`, 1, 1, 0);
  assert.equal(big.size, HEAVY_HITTERS_CAPACITY);
  const top = big.top(TOP_SIZE);
  assert.equal(top.length, TOP_SIZE);
  assert.equal(top[0].key, 'heavy');
  assert.ok(top[0].requests >= 5_000);
});

test('uriKey strips the query and bounds the length', () => {
  assert.equal(uriKey('/a/b?x=1'), '/a/b');
  assert.equal(uriKey('?x=1'), '/');
  assert.equal(uriKey(`/${'x'.repeat(500)}`).length, 256);
});

test('mergeTopEntries sums by key and keeps the top n; countriesOf groups the IPs by country', () => {
  const merged = mergeTopEntries([[{ key: 'a', requests: 5, bytes: 1, errors: 0 }, { key: 'b', requests: 1, bytes: 1, errors: 1 }], [{ key: 'b', requests: 10, bytes: 2, errors: 0 }]], 1);
  assert.deepEqual(merged, [{ key: 'b', requests: 11, bytes: 3, errors: 1 }]);
  const geo = new Map([
    ['1.1.1.1', { countryCode: 'fr', countryName: 'France' }],
    ['2.2.2.2', { countryCode: 'FR', countryName: 'France' }],
    ['3.3.3.3', null],
  ]);
  const c = countriesOf([{ key: '1.1.1.1', requests: 2, bytes: 1, errors: 0 }, { key: '2.2.2.2', requests: 3, bytes: 1, errors: 1 }, { key: '3.3.3.3', requests: 9, bytes: 1, errors: 0 }], geo);
  assert.equal(c.length, 1);
  assert.equal(c[0].key, 'FR');
  assert.equal(c[0].requests, 5);
  assert.equal(c[0].geo?.countryName, 'France');
});

function row(hostId: number, at: string, requests: number, latencyBucket = 3): StoredTrafficRow {
  const latency = emptyHistogram();
  latency[latencyBucket] = requests;
  return { proxyHostId: hostId, accountId: 1, at: new Date(at), requests, s2xx: requests, s3xx: 0, s4xx: 0, s5xx: 0, upstreamErrors: 0, bytesIn: 1, bytesOut: 2, latencySumMs: 10, latency };
}

test('hourly roll-up sums the minutes of each (host, hour)', () => {
  const hours = rollupToHours([
    row(1, '2026-10-10T12:00:00Z', 2), row(1, '2026-10-10T12:59:00Z', 3), row(1, '2026-10-10T13:00:00Z', 4), row(2, '2026-10-10T12:30:00Z', 1, 11),
  ]);
  assert.equal(hours.length, 3);
  const h12 = hours.find((h) => h.proxyHostId === 1 && h.at.toISOString() === '2026-10-10T12:00:00.000Z')!;
  assert.equal(h12.requests, 5);
  assert.equal(h12.latency[3], 5);
  assert.equal(h12.bytesOut, 4);
  assert.equal(hours.find((h) => h.proxyHostId === 2)!.latency[11], 1);
});

test('series are zero-filled per minute (≤ 24 h) or per hour, percentiles per point, error rate', () => {
  const now = new Date('2026-10-10T12:10:30Z');
  assert.equal(isMinuteRange('24h'), true);
  assert.equal(isMinuteRange('7d'), false);
  const s = buildSeries([row(1, '2026-10-10T12:05:00Z', 4)], '1h', now);
  assert.equal(s.length, 60);
  assert.equal(s[s.length - 1].at, '2026-10-10T12:10:00.000Z');
  const p = s.find((x) => x.at === '2026-10-10T12:05:00.000Z')!;
  assert.equal(p.requests, 4);
  assert.ok(p.p50Ms !== null && p.p50Ms > 25 && p.p50Ms <= 50);
  assert.equal(s.filter((x) => x.requests === 0).length, 59);
  assert.equal(s[0].p95Ms, null);
  const week = buildSeries([row(1, '2026-10-09T08:00:00Z', 1)], '7d', now);
  assert.equal(week.length, 168);
  assert.equal(errorRate({ requests: 4, s4xx: 1, s5xx: 1 }), 0.5);
  assert.equal(errorRate({ requests: 0, s4xx: 0, s5xx: 0 }), 0);
});
