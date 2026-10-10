import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GeoInfo } from '@oblimint/shared';
import { geoFromIpApi, geoFromMmdb, geoipService, geoLookupAddress, IP_API_PER_MINUTE, setGeoBackendsForTests, type GeoBackends } from './geoip.service';

// GeoIP providers with fakes (docs/P4b-PLAN.md §9.6).

const PARIS: GeoInfo = { countryCode: 'FR', countryName: 'France', city: 'Paris', latitude: 48.85, longitude: 2.35, org: 'Example SAS' };

function fakes(provider: 'off' | 'ip-api' | 'mmdb', over: Partial<GeoBackends> = {}) {
  const fetched: string[] = [];
  const cache = new Map<string, { info: GeoInfo; fetchedAt: Date }>();
  let clock = Date.parse('2026-10-10T12:00:00Z');
  setGeoBackendsForTests({
    provider: async () => ({ provider, mmdbPath: '/data/GeoLite2-City.mmdb' }),
    cacheGet: async (keys) => new Map(keys.filter((k) => cache.has(k)).map((k) => [k, cache.get(k)!])),
    cachePut: async (k, info, at) => { cache.set(k, { info, fetchedAt: at }); },
    fetch: async (url) => {
      fetched.push(url);
      return Response.json({ status: 'success', country: 'France', countryCode: 'FR', city: 'Paris', lat: 48.85, lon: 2.35, org: 'Example SAS' });
    },
    now: () => clock,
    ...over,
  });
  return { fetched, cache, advance: (ms: number) => { clock += ms; } };
}

test('off: nothing resolved, nothing sent', async (t) => {
  t.after(() => setGeoBackendsForTests(null));
  const f = fakes('off');
  assert.equal(await geoipService.lookup('8.8.8.8'), null);
  assert.deepEqual([...(await geoipService.lookupMany(['8.8.8.8', '1.1.1.1'])).values()], [null, null]);
  assert.deepEqual(f.fetched, []);
});

test('ip-api: cached 30 days, private never sent, /64 keys looked up by their network address', async (t) => {
  t.after(() => setGeoBackendsForTests(null));
  const f = fakes('ip-api');
  assert.deepEqual(await geoipService.lookup('8.8.8.8'), PARIS);
  assert.deepEqual(await geoipService.lookup('8.8.8.8'), PARIS);
  assert.equal(f.fetched.length, 1, 'second lookup from the cache');
  assert.match(f.fetched[0], /^http:\/\/ip-api\.com\/json\/8\.8\.8\.8\?fields=/);
  for (const ip of ['10.0.0.1', '192.168.1.1', '100.64.0.1', '127.0.0.1', 'fd00::1', 'fe80::1', '::1', 'garbage']) {
    assert.equal(await geoipService.lookup(ip), null, ip);
  }
  assert.equal(f.fetched.length, 1, 'R-GEOIP-PRIVACY: no private address sent out');
  const m = await geoipService.lookupMany(['2a00:1450:4007:80e::/64', '10.1.1.1']);
  assert.deepEqual(m.get('2a00:1450:4007:80e::/64'), PARIS);
  assert.equal(m.get('10.1.1.1'), null);
  assert.equal(f.fetched[1], 'http://ip-api.com/json/2a00%3A1450%3A4007%3A80e%3A%3A?fields=status,message,country,countryCode,city,lat,lon,org,isp');
  assert.ok(f.cache.has('2a00:1450:4007:80e::/64'), 'cached under the key');
  f.advance(31 * 86_400_000);
  await geoipService.lookup('8.8.8.8');
  assert.equal(f.fetched.length, 3, 'stale after 30 days: resolved again');
});

test('ip-api: ≤ 40 requests a minute, the rest null (or the stale row); failures never throw', async (t) => {
  t.after(() => setGeoBackendsForTests(null));
  const f = fakes('ip-api');
  const ips = Array.from({ length: 50 }, (_, i) => `8.8.${Math.floor(i / 250)}.${(i % 250) + 1}`);
  const m = await geoipService.lookupMany(ips);
  assert.equal(f.fetched.length, IP_API_PER_MINUTE);
  assert.equal([...m.values()].filter((v) => v !== null).length, IP_API_PER_MINUTE);
  assert.equal(m.size, 50);
  f.advance(61_000);
  await geoipService.lookupMany(ips);
  assert.equal(f.fetched.length, 50, 'next minute: the remaining 10');

  // Stale row kept when the service fails.
  const g = fakes('ip-api', { fetch: async () => { throw new Error('network down'); } });
  g.cache.set('9.9.9.9', { info: PARIS, fetchedAt: new Date('2026-01-01T00:00:00Z') });
  assert.deepEqual(await geoipService.lookup('9.9.9.9'), PARIS);
  assert.equal(await geoipService.lookup('9.9.9.10'), null);
  fakes('ip-api', { cacheGet: async () => { throw new Error('db down'); } });
  assert.equal(await geoipService.lookup('8.8.8.8'), null);
  assert.deepEqual([...(await geoipService.lookupMany(['8.8.8.8'])).entries()], [['8.8.8.8', null]]);
});

test('mmdb: local reader, opened once per path, unreadable file = null', async (t) => {
  t.after(() => setGeoBackendsForTests(null));
  let opens = 0;
  const f = fakes('mmdb', {
    openMmdb: async () => {
      opens++;
      return {
        get: (ip: string) => (ip === '8.8.8.8'
          ? { country: { iso_code: 'US', names: { en: 'United States' } }, city: { names: { en: 'Mountain View', fr: 'Mountain View' } }, location: { latitude: 37.4, longitude: -122.1 }, traits: { organization: 'Google' } }
          : null),
      };
    },
  });
  assert.deepEqual(await geoipService.lookup('8.8.8.8'), { countryCode: 'US', countryName: 'United States', city: 'Mountain View', latitude: 37.4, longitude: -122.1, org: 'Google' });
  assert.equal(await geoipService.lookup('1.1.1.1'), null);
  assert.equal(opens, 1);
  assert.deepEqual(f.fetched, [], 'never online');
  fakes('mmdb', { openMmdb: async () => { throw new Error('ENOENT'); } });
  assert.equal(await geoipService.lookup('8.8.8.8'), null);
});

test('parsers and lookup addresses', () => {
  assert.equal(geoFromIpApi({ status: 'fail', message: 'reserved range' }), null);
  assert.equal(geoFromIpApi(null), null);
  assert.deepEqual(geoFromIpApi({ status: 'success', countryCode: 'fr', country: 'France', isp: 'ISP' }), {
    countryCode: null, countryName: 'France', city: null, latitude: null, longitude: null, org: 'ISP',
  });
  assert.equal(geoFromMmdb({}), null);
  assert.equal(geoFromMmdb('x'), null);
  assert.deepEqual(geoFromMmdb({ registered_country: { iso_code: 'DE', names: { fr: 'Allemagne' } } }), {
    countryCode: 'DE', countryName: 'Allemagne', city: null, latitude: null, longitude: null, org: null,
  });
  assert.equal(geoLookupAddress('2a00:1450:4007:80e::/64'), '2a00:1450:4007:80e::');
  assert.equal(geoLookupAddress('100.64.1.1'), null);
});
