import type { KeySurfaceRegime } from '@oblimint/shared';
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

/** Addresses a key is reachable from: its list (a connector: + the connectors' ranges); null = open. */
export function effectiveKeyList(kind: 'key' | 'connector', allowedIps: readonly string[], connectorRanges: readonly string[]): string[] | null {
  const list = kind === 'connector' ? [...allowedIps, ...connectorRanges] : [...allowedIps];
  return list.length ? [...new Set(list)] : null;
}

export interface RegimeResult {
  regime: KeySurfaceRegime;
  /** Union of the lists of the active keys (strict regime's allow-list). */
  allowList: string[];
  openKeys: ActiveKeyRow[];
  activeKeys: number;
}

/** strict when there is at least one active key and none is open; watch otherwise. */
export function computeRegime(keys: readonly ActiveKeyRow[], connectorRanges: readonly string[]): RegimeResult {
  const allow = new Set<string>();
  const open: ActiveKeyRow[] = [];
  for (const k of keys) {
    const list = effectiveKeyList(k.kind, k.allowedIps, connectorRanges);
    if (!list) open.push(k);
    else for (const c of list) allow.add(c);
  }
  return { regime: keys.length > 0 && open.length === 0 ? 'strict' : 'watch', allowList: [...allow], openKeys: open, activeKeys: keys.length };
}

/** "An IP is mandatory on the keys" for a tenant (its own value, else the platform's). */
export function requireIpFor(tenantValue: boolean | null | undefined, platformValue: boolean): boolean {
  return typeof tenantValue === 'boolean' ? tenantValue : platformValue;
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
