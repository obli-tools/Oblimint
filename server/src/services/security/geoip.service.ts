import type { GeoInfo } from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { isPublicAddress, normalizeAddress } from '../firewall/addresses';
import { platformSettings } from '../platformSettings';

// ─────────────────────────────────────────────────────────────────────────────
// GeoIP of the bans and of the traffic (docs/P4b-PLAN.md §9.6) — module
// honeypot-bans (geoip.test.ts, injectable backends). Consumed by the bans
// list and by monitoring-automation (lookupMany, traffic countries).
//
// Providers (settings bans.geoipProvider):
//   off     nothing resolved;
//   ip-api  ip-api.com free tier (no key; HTTP only on the free tier): at most
//           40 requests per minute (the free limit is 45), every answer cached
//           in ip_geo_cache for 30 days, a stale row still served when the
//           budget is spent or the service fails (R-GEOIP-PRIVACY: the
//           looked-up addresses leave the node — documented in the settings);
//   mmdb    a local MaxMind GeoLite2-City file (bans.geoipMmdbPath), opened
//           once per path, never cached in the DB (local reads are cheap).
// Keys: an address, or an IPv6 ban key 'x::/64' (its network address is
// looked up, the row cached under the key). Private / reserved addresses:
// null, never sent out. lookup / lookupMany NEVER throw.
// ─────────────────────────────────────────────────────────────────────────────

export const GEO_CACHE_TTL_MS = 30 * 86_400_000;
export const IP_API_PER_MINUTE = 40;
const IP_API_TIMEOUT_MS = 5_000;

export interface MmdbReaderLike {
  get(ip: string): unknown;
}

export interface GeoBackends {
  provider(): Promise<{ provider: 'off' | 'ip-api' | 'mmdb'; mmdbPath: string | null }>;
  cacheGet(keys: string[]): Promise<Map<string, { info: GeoInfo; fetchedAt: Date }>>;
  cachePut(key: string, info: GeoInfo, at: Date): Promise<void>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  openMmdb(path: string): Promise<MmdbReaderLike>;
  now(): number;
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

type GeoRow = {
  ip: string; country_code: string | null; country_name: string | null; city: string | null;
  latitude: number | string | null; longitude: number | string | null; org: string | null; fetched_at: Date | string;
};

export function geoFromRow(r: GeoRow): GeoInfo {
  return {
    countryCode: r.country_code,
    countryName: r.country_name,
    city: r.city,
    latitude: r.latitude === null ? null : Number(r.latitude),
    longitude: r.longitude === null ? null : Number(r.longitude),
    org: r.org,
  };
}

const defaultBackends: GeoBackends = {
  async provider() {
    const s = await platformSettings.section('bans');
    return { provider: s.geoipProvider, mmdbPath: s.geoipMmdbPath };
  },
  async cacheGet(keys) {
    const out = new Map<string, { info: GeoInfo; fetchedAt: Date }>();
    if (keys.length === 0) return out;
    for (let i = 0; i < keys.length; i += 500) {
      const rows = await db('ip_geo_cache').whereIn('ip', keys.slice(i, i + 500)).select('*') as GeoRow[];
      for (const r of rows) out.set(r.ip, { info: geoFromRow(r), fetchedAt: new Date(r.fetched_at) });
    }
    return out;
  },
  async cachePut(key, info, at) {
    const row = {
      country_code: info.countryCode, country_name: info.countryName, city: info.city,
      latitude: info.latitude, longitude: info.longitude, org: info.org, fetched_at: at,
    };
    await db('ip_geo_cache').insert({ ip: key, ...row }).onConflict('ip').merge(row);
  },
  fetch: (url, init) => fetch(url, init),
  async openMmdb(path) {
    const maxmind = await import('maxmind');
    return maxmind.open(path, { cache: { max: 10_000 } });
  },
  now: () => Date.now(),
};

let backends: GeoBackends = defaultBackends;
let budget = { windowStart: 0, used: 0 };
let mmdb: { path: string; reader: Promise<MmdbReaderLike> } | null = null;
let mmdbErrorLoggedAt = 0;

export function setGeoBackendsForTests(b: Partial<GeoBackends> | null): void {
  backends = b ? { ...defaultBackends, ...b } : defaultBackends;
  budget = { windowStart: 0, used: 0 };
  mmdb = null;
}

/** The address to look up for a key, or null when it is not a public address. */
export function geoLookupAddress(key: string): string | null {
  if (typeof key !== 'string') return null;
  const slash = key.indexOf('/');
  const a = normalizeAddress(slash === -1 ? key : key.slice(0, slash));
  if (!a || !isPublicAddress(a.ip)) return null;
  return a.ip;
}

function takeBudget(): boolean {
  const now = backends.now();
  if (now - budget.windowStart >= 60_000) budget = { windowStart: now, used: 0 };
  if (budget.used >= IP_API_PER_MINUTE) return false;
  budget.used++;
  return true;
}

/** ip-api.com answer → GeoInfo (null when the service says fail). Pure. */
export function geoFromIpApi(data: unknown): GeoInfo | null {
  const d = data as Record<string, unknown> | null;
  if (!d || d.status !== 'success') return null;
  const cc = str(d.countryCode, 2);
  return {
    countryCode: cc && /^[A-Z]{2}$/.test(cc) ? cc : null,
    countryName: str(d.country, 128),
    city: str(d.city, 128),
    latitude: num(d.lat),
    longitude: num(d.lon),
    org: str(d.org, 255) ?? str(d.isp, 255),
  };
}

/** MaxMind City record → GeoInfo (null when nothing useful). Pure. */
export function geoFromMmdb(rec: unknown): GeoInfo | null {
  const r = rec as {
    country?: { iso_code?: unknown; names?: Record<string, unknown> };
    registered_country?: { iso_code?: unknown; names?: Record<string, unknown> };
    city?: { names?: Record<string, unknown> };
    location?: { latitude?: unknown; longitude?: unknown };
    traits?: { organization?: unknown; isp?: unknown };
  } | null;
  if (!r || typeof r !== 'object') return null;
  const country = r.country ?? r.registered_country;
  const cc = str(country?.iso_code, 2);
  const info: GeoInfo = {
    countryCode: cc && /^[A-Z]{2}$/.test(cc) ? cc : null,
    countryName: str(country?.names?.fr, 128) ?? str(country?.names?.en, 128),
    city: str(r.city?.names?.fr, 128) ?? str(r.city?.names?.en, 128),
    latitude: num(r.location?.latitude),
    longitude: num(r.location?.longitude),
    org: str(r.traits?.organization, 255) ?? str(r.traits?.isp, 255),
  };
  return info.countryCode || info.city || info.latitude !== null ? info : null;
}

async function mmdbReader(path: string): Promise<MmdbReaderLike | null> {
  if (!mmdb || mmdb.path !== path) mmdb = { path, reader: backends.openMmdb(path) };
  try {
    return await mmdb.reader;
  } catch (err) {
    mmdb = null;
    const now = backends.now();
    if (now - mmdbErrorLoggedAt > 10 * 60_000) {
      mmdbErrorLoggedAt = now;
      logger.warn({ err: (err as Error)?.message, path }, 'GeoIP: the MaxMind database could not be opened');
    }
    return null;
  }
}

async function ipApi(addr: string): Promise<GeoInfo | null> {
  const res = await backends.fetch(`http://ip-api.com/json/${encodeURIComponent(addr)}?fields=status,message,country,countryCode,city,lat,lon,org,isp`, {
    signal: AbortSignal.timeout(IP_API_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  return geoFromIpApi(await res.json());
}

async function resolveMany(keys: string[]): Promise<Map<string, GeoInfo | null>> {
  const out = new Map<string, GeoInfo | null>();
  const wanted = new Map<string, string>();
  for (const k of keys) {
    if (out.has(k) || wanted.has(k)) continue;
    const addr = geoLookupAddress(k);
    if (addr) wanted.set(k, addr);
    else out.set(k, null);
  }
  if (wanted.size === 0) return out;
  const { provider, mmdbPath } = await backends.provider();
  if (provider === 'off') {
    for (const k of wanted.keys()) out.set(k, null);
    return out;
  }
  if (provider === 'mmdb') {
    const reader = mmdbPath ? await mmdbReader(mmdbPath) : null;
    for (const [k, addr] of wanted) {
      let info: GeoInfo | null = null;
      try {
        info = reader ? geoFromMmdb(reader.get(addr)) : null;
      } catch { /* malformed record */ }
      out.set(k, info);
    }
    return out;
  }
  // ip-api: cache first, then the misses within the minute budget.
  const cached = await backends.cacheGet([...wanted.keys()]);
  const now = backends.now();
  for (const [k, addr] of wanted) {
    const hit = cached.get(k);
    if (hit && now - hit.fetchedAt.getTime() < GEO_CACHE_TTL_MS) {
      out.set(k, hit.info);
      continue;
    }
    let fresh: GeoInfo | null = null;
    if (takeBudget()) {
      try {
        fresh = await ipApi(addr);
        if (fresh) await backends.cachePut(k, fresh, new Date(backends.now()));
      } catch (err) {
        logger.debug({ err: (err as Error)?.message }, 'GeoIP: ip-api lookup failed');
      }
    }
    // Rate limited / failed: a stale row is better than nothing.
    out.set(k, fresh ?? hit?.info ?? null);
  }
  return out;
}

export const geoipService = {
  /** Never throws: null when unknown / disabled / rate limited / not a public address. */
  async lookup(ip: string): Promise<GeoInfo | null> {
    try {
      return (await resolveMany([ip])).get(ip) ?? null;
    } catch (err) {
      logger.debug({ err: (err as Error)?.message }, 'GeoIP lookup failed');
      return null;
    }
  },

  /** Never throws; cache-first; missing entries resolved within the provider's rate budget, the rest null. */
  async lookupMany(ips: string[]): Promise<Map<string, GeoInfo | null>> {
    const keys = (Array.isArray(ips) ? ips : []).filter((ip): ip is string => typeof ip === 'string');
    try {
      return await resolveMany(keys);
    } catch (err) {
      logger.debug({ err: (err as Error)?.message }, 'GeoIP lookup failed');
      return new Map(keys.map((ip) => [ip, null]));
    }
  },

  /** Rows older than the TTL (retention, called by the bans worker). Never throws. */
  async purgeStale(): Promise<number> {
    try {
      return await db('ip_geo_cache').where('fetched_at', '<', new Date(backends.now() - GEO_CACHE_TTL_MS)).delete();
    } catch {
      return 0;
    }
  },
};
