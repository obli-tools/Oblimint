import dns from 'dns/promises';
import { logger } from '../../utils/logger';
import { normalizeIp, type HostResolver } from '../docker/hookSource';
import { ADMINER_CONTAINER, PHPMYADMIN_CONTAINER } from '../hosting/naming';

// ─────────────────────────────────────────────────────────────────────────────
// Who may redeem a DB admin SSO token on the internal listener (B3): only
// the phpMyAdmin / Adminer containers, i.e. the addresses Docker's embedded
// DNS gives for oblimint-phpmyadmin / oblimint-adminer (same pattern as
// docker/hookSource.ts for the file servers). Loopback is NOT accepted: the
// admin containers never share the panel's network namespace, and the key
// alone must not be enough. A site container shares an account network
// with the panel (and, during a session, with the admin container) but
// cannot take the admin container's address (CapDrop ALL: no NET_RAW /
// NET_ADMIN; the bridge assigns addresses).
// ─────────────────────────────────────────────────────────────────────────────

const defaultResolver: HostResolver = async (name) => (await dns.lookup(name, { all: true, verbatim: true })).map((a) => a.address);

export interface DbAdminSourceCheckOptions {
  resolve?: HostResolver;
  /** How long a resolved address set is trusted (a recreated container gets a new address). */
  ttlMs?: number;
  /** Minimum delay between two lookups on a mismatch (no DNS flood from a hostile peer). */
  retryMs?: number;
  now?: () => number;
}

export type DbAdminKindName = 'phpmyadmin' | 'adminer';

/** (remote address) → the admin container it belongs to, or null. Never throws. */
export function createDbAdminSourceCheck(opts: DbAdminSourceCheckOptions = {}) {
  const resolve = opts.resolve ?? defaultResolver;
  const ttlMs = opts.ttlMs ?? 30_000;
  const retryMs = opts.retryMs ?? 2_000;
  const now = opts.now ?? Date.now;
  const names: Record<DbAdminKindName, string> = { phpmyadmin: PHPMYADMIN_CONTAINER, adminer: ADMINER_CONTAINER };
  const cache = new Map<DbAdminKindName, { at: number; ips: Set<string> }>();
  const warned = new Map<string, number>();

  const lookup = async (kind: DbAdminKindName): Promise<Set<string>> => {
    let ips = new Set<string>();
    try {
      ips = new Set((await resolve(names[kind])).map(normalizeIp).filter((x): x is string => !!x));
    } catch { /* container absent / not on a shared network: nobody */ }
    cache.set(kind, { at: now(), ips });
    return ips;
  };

  return async (remoteAddress: string | null | undefined): Promise<DbAdminKindName | null> => {
    const ip = normalizeIp(remoteAddress);
    if (!ip) return null;
    const t = now();
    for (const kind of Object.keys(names) as DbAdminKindName[]) {
      const hit = cache.get(kind);
      if (hit && t - hit.at < ttlMs && hit.ips.has(ip)) return kind;
    }
    for (const kind of Object.keys(names) as DbAdminKindName[]) {
      const hit = cache.get(kind);
      const ips = hit && t - hit.at < retryMs ? hit.ips : await lookup(kind);
      if (ips.has(ip)) return kind;
    }
    if ((warned.get(ip) ?? 0) < t - 60_000) {
      if (warned.size > 1000) warned.clear();
      warned.set(ip, t);
      logger.warn({ peer: ip }, 'DB admin token redeemed from an address that is not an admin container: refused');
    }
    return null;
  };
}
