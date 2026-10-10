import { db } from '../../db';
import { logger } from '../../utils/logger';
import { isNodeAddress } from './targetGuard';

// ─────────────────────────────────────────────────────────────────────────────
// The node's own public addresses (app_config public_ipv4 / public_ipv6) for
// the anti-SSRF guard (MO1): a client monitor / SFTP target must not reach
// them (from the panel container they go through the host INPUT chain, where
// services hidden by the external firewall answer), except an HTTP / keyword
// check on 80 / 443 — the auto monitors of the proxy hosts and any client
// monitor of its own site legitimately reach the node through the edge.
// Platform rows of the master tenant with allowPrivateTargets are exempt
// (staff choice, like private ranges). Cached 60 s; never throws.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_MS = 60_000;
let cache: { at: number; addresses: string[] } | null = null;
let override: string[] | null = null;

export async function nodePublicAddresses(): Promise<string[]> {
  if (override) return override;
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.addresses;
  try {
    const rows = await db('app_config').whereIn('key', ['public_ipv4', 'public_ipv6']).select('value') as Array<{ value: string | null }>;
    const addresses = rows.map((r) => (r.value ?? '').trim()).filter(Boolean);
    cache = { at: Date.now(), addresses };
    return addresses;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'Node public addresses unreadable (anti-SSRF keeps the last known ones)');
    return cache?.addresses ?? [];
  }
}

/** Ports on which an HTTP / keyword check may reach the node (through the edge). */
export const NODE_WEB_PORTS: ReadonlySet<number> = new Set([80, 443]);

/**
 * Refusal callback of the guard for a row: null = no node refusal (exempt
 * row, or an HTTP check on 80 / 443).
 */
export async function nodeRefusal(opts: { exempt: boolean; httpPort?: number | null }): Promise<((ip: string) => boolean) | undefined> {
  if (opts.exempt) return undefined;
  if (opts.httpPort !== undefined && opts.httpPort !== null && NODE_WEB_PORTS.has(opts.httpPort)) return undefined;
  const addresses = await nodePublicAddresses();
  if (addresses.length === 0) return undefined;
  return (ip: string) => isNodeAddress(ip, addresses);
}

/** Tests: fixed node addresses (null = read app_config again). */
export function setNodeAddressesForTests(addresses: string[] | null): void {
  override = addresses;
  cache = null;
}
