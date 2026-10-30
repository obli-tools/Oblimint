import { KEY_REGIME_MAX_WIDTH, type KeySurfaceRegime } from '@oblimint/shared';
import { normalizeIp } from '../../utils/clientIp';
import { cidrContains, normalizeCidr } from '../firewall/addresses';

// Pure rules of the key surfaces' IP security (spec §5.3) — keySurfaceGuard.ts
// applies them, apiKeys.service.ts checks a key with the same matcher.
// Import-light on purpose (no database, no service): keySurfaceGuard.test.ts.

const MAX_TRACKED = 20_000;

/** Matcher of addresses / CIDR (invalid entries ignored). */
export function ipMatcher(entries: readonly string[]): (ip: string) => boolean {
  const nets: string[] = [];
  for (const e of entries) {
    try { nets.push(normalizeCidr(String(e).trim(), { 4: 0, 6: 0 }).cidr); } catch { /* ignored */ }
  }
  return (ip: string) => {
    const addr = normalizeIp(ip);
    return !!addr && nets.some((n) => cidrContains(n, addr));
  };
}

export interface ActiveKeyRow {
  id: number;
  name: string;
  kind: 'key' | 'connector';
  allowedIps: string[];
  tenantId: number;
  tenantName: string | null;
  accountId: number;
  accountUsername: string | null;
  owner: string | null;
}

/**
 * Addresses a key is reachable from: its list (a connector with a list: + the
 * connectors' ranges, where its calls come from); null = open. No address =
 * every address, for a connector as for a key (owner rule: each account
 * secures its own keys).
 */
export function effectiveKeyList(kind: 'key' | 'connector', allowedIps: readonly string[], connectorRanges: readonly string[]): string[] | null {
  if (!allowedIps.length) return null;
  const list = kind === 'connector' ? [...allowedIps, ...connectorRanges] : [...allowedIps];
  return [...new Set(list)];
}

export type OpenKeyRow = ActiveKeyRow & { why: 'noIp' | 'tooWide' };

export interface RegimeResult {
  regime: KeySurfaceRegime;
  /** Union of the lists of the closed active keys (strict regime's allow-list). */
  allowList: string[];
  openKeys: OpenKeyRow[];
  activeKeys: number;
}

/** An entry wider than KEY_REGIME_MAX_WIDTH (an IPv4 /16, an IPv6 /48); invalid entries are not "wide". */
export function tooWideEntry(entry: string): boolean {
  try {
    const n = normalizeCidr(String(entry).trim(), { 4: 0, 6: 0 });
    return n.bits < KEY_REGIME_MAX_WIDTH[n.family];
  } catch {
    return false;
  }
}

/**
 * strict when there is at least one active key and none is open; watch
 * otherwise. A key's own entry wider than KEY_REGIME_MAX_WIDTH makes it
 * count as open (the connectors' ranges, set by the platform admin, never do).
 */
export function computeRegime(keys: readonly ActiveKeyRow[], connectorRanges: readonly string[]): RegimeResult {
  const allow = new Set<string>();
  const open: OpenKeyRow[] = [];
  for (const k of keys) {
    const list = effectiveKeyList(k.kind, k.allowedIps, connectorRanges);
    if (!list) open.push({ ...k, why: 'noIp' });
    else if (k.allowedIps.some(tooWideEntry)) open.push({ ...k, why: 'tooWide' });
    else for (const c of list) allow.add(c);
  }
  return { regime: keys.length > 0 && open.length === 0 ? 'strict' : 'watch', allowList: [...allow], openKeys: open, activeKeys: keys.length };
}

/** "An IP is mandatory on the keys" for a tenant (its own value, else the platform's). */
export function requireIpFor(tenantValue: boolean | null | undefined, platformValue: boolean): boolean {
  return typeof tenantValue === 'boolean' ? tenantValue : platformValue;
}

/**
 * Aggregation of the IPv6 bans (spec §5, review): an attacker holding a /48
 * (65 536 /64s) must not mint unlimited permanent bans for free. Once `max`
 * active platform bans fall inside the same wider network, the whole network
 * is refused on the key surfaces without a new ban row.
 */
export const BAN_SATURATION: ReadonlyArray<{ bits: number; max: number }> = [{ bits: 48, max: 8 }, { bits: 32, max: 32 }];

/** Wider networks (BAN_SATURATION order) of an IPv6 ban key; [] for IPv4. */
export function widerNetworks(key: string): string[] {
  const slash = key.indexOf('/');
  const addr = slash === -1 ? key : key.slice(0, slash);
  if (!addr.includes(':')) return [];
  const out: string[] = [];
  for (const { bits } of BAN_SATURATION) {
    try { out.push(normalizeCidr(`${addr}/${bits}`, { 4: 0, 6: 0 }).cidr); } catch { return []; }
  }
  return out;
}

/** Counts the banned keys per wider network. */
export class SaturationIndex {
  private readonly counts = new Map<string, number>();
  private readonly keys = new Set<string>();

  constructor(keys: Iterable<string> = []) {
    for (const k of keys) this.add(k);
  }

  add(key: string): void {
    if (this.keys.has(key)) return;
    this.keys.add(key);
    for (const net of widerNetworks(key)) this.counts.set(net, (this.counts.get(net) ?? 0) + 1);
  }

  /** The saturated wider network the key falls in, or null. */
  saturated(key: string): string | null {
    const nets = widerNetworks(key);
    for (let i = 0; i < nets.length; i++) {
      if ((this.counts.get(nets[i]) ?? 0) >= BAN_SATURATION[i].max) return nets[i];
    }
    return null;
  }
}

/** Sliding window of failures per address. */
export class FailureWindow {
  private readonly hits = new Map<string, number[]>();

  /** Records one failure at `now`, returns the failures within the window. */
  record(key: string, now: number, windowMs: number): number {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    list.push(now);
    if (!this.hits.has(key) && this.hits.size >= MAX_TRACKED) this.hits.clear();
    this.hits.set(key, list);
    return list.length;
  }

  count(key: string, now: number, windowMs: number): number {
    return (this.hits.get(key) ?? []).filter((t) => now - t < windowMs).length;
  }

  clear(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }
}
