import dns from 'dns/promises';
import net from 'net';
import { logger } from '../../utils/logger';
import { fileServerContainer } from '../hosting/naming';

// ─────────────────────────────────────────────────────────────────────────────
// Who may call the file-server hooks of account N (internal listener, 8081).
//
// The panel joins every account network (alias oblimint-panel: file-server
// hooks, site healthchecks), and the account network also carries the
// account's SITE containers — tenant code. The per-account hook token alone
// would leave the hook routes one secret away from any compromised site of
// the platform. A hook call for account N is therefore accepted only from the
// address Docker's embedded DNS gives for oblimint-files-<N> (the file server
// of THAT account, on the only network it shares with the panel), or from
// loopback (the panel's own network namespace). A site container cannot take
// that address: no CAP_NET_RAW / NET_ADMIN (CapDrop ALL), and the bridge
// assigns it its own address.
// ─────────────────────────────────────────────────────────────────────────────

export type HostResolver = (name: string) => Promise<string[]>;

const defaultResolver: HostResolver = async (name) => (await dns.lookup(name, { all: true, verbatim: true })).map((a) => a.address);

/** Socket address → plain IP (IPv4-mapped IPv6 unwrapped, zone id dropped); null when unusable. */
export function normalizeIp(address: string | null | undefined): string | null {
  if (!address) return null;
  let a = address.trim().toLowerCase();
  const pct = a.indexOf('%');
  if (pct >= 0) a = a.slice(0, pct);
  if (a.startsWith('::ffff:') && net.isIPv4(a.slice(7))) a = a.slice(7);
  return net.isIP(a) ? a : null;
}

export function isLoopback(ip: string): boolean {
  return ip === '::1' || (net.isIPv4(ip) && ip.startsWith('127.'));
}

export interface SourceCheckOptions {
  resolve?: HostResolver;
  /** How long a resolved address set is trusted (a recreated file server gets a new address). */
  ttlMs?: number;
  /** Minimum delay between two lookups of the same name on a mismatch (no DNS flood from a hostile peer). */
  retryMs?: number;
  now?: () => number;
}

/** (accountId, socket remote address) → may this peer call the account's hooks? Never throws. */
export function createFileServerSourceCheck(opts: SourceCheckOptions = {}) {
  const resolve = opts.resolve ?? defaultResolver;
  const ttlMs = opts.ttlMs ?? 30_000;
  const retryMs = opts.retryMs ?? 2_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<number, { at: number; ips: Set<string> }>();
  const warned = new Map<string, number>();

  const lookup = async (accountId: number): Promise<Set<string>> => {
    let ips = new Set<string>();
    try {
      ips = new Set((await resolve(fileServerContainer(accountId))).map(normalizeIp).filter((x): x is string => !!x));
    } catch { /* unknown name (file server stopped / not on a shared network): nobody */ }
    if (cache.size > 5000) cache.clear();
    cache.set(accountId, { at: now(), ips });
    return ips;
  };

  return async (accountId: number, remoteAddress: string | null | undefined): Promise<boolean> => {
    const ip = normalizeIp(remoteAddress);
    if (!ip || !Number.isInteger(accountId) || accountId <= 0) return false;
    if (isLoopback(ip)) return true;
    const hit = cache.get(accountId);
    const t = now();
    if (hit && t - hit.at < ttlMs && hit.ips.has(ip)) return true;
    // Miss or mismatch: resolve again (the file server may have been recreated), but not more than every retryMs.
    const ips = hit && t - hit.at < retryMs ? hit.ips : await lookup(accountId);
    if (ips.has(ip)) return true;
    const key = `${accountId}/${ip}`;
    if ((warned.get(key) ?? 0) < t - 60_000) {
      if (warned.size > 1000) warned.clear();
      warned.set(key, t);
      logger.warn({ accountId, peer: ip }, 'File-server hook called from an address that is not the account\'s file server: refused');
    }
    return false;
  };
}
