import type { Knex } from 'knex';
import type { PublicIp, PublicIpKind, PublicIpManagement, PublicIpStatus } from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Public IPs of the nodes (migration 032): rows, the shared IP of a node and
// the central list of the node's own addresses (shared + dedicated + their
// local addresses), used everywhere the panel must recognise the node itself:
// anti-SSRF of the monitors (monitoring/nodeAddresses.ts), never banning the
// node (security/bans.service.ts, mail security), proxy external targets,
// the key surface guard. Cached 60 s; never throws.
// ─────────────────────────────────────────────────────────────────────────────

export interface PublicIpRow {
  id: number;
  node_id: number;
  address: string;
  local_address: string | null;
  prefix_len: number;
  interface: string | null;
  kind: PublicIpKind;
  management: PublicIpManagement;
  tenant_id: number | null;
  account_id: number | null;
  takeover_web: boolean;
  snat_outbound: boolean;
  status: PublicIpStatus;
  status_message: string | null;
  checked_at: Date | string | null;
  description: string | null;
  created_by: number | null;
  created_at: Date | string;
  updated_at: Date | string;
  account_username?: string | null;
  binding_count?: number | string | null;
}

const iso = (d: Date | string | null | undefined): string | null => (d == null ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString());

export function toPublicIp(r: PublicIpRow): PublicIp {
  const assigned = r.account_id !== null && r.account_id !== undefined;
  return {
    id: Number(r.id),
    nodeId: Number(r.node_id),
    address: r.address,
    localAddress: r.local_address ?? null,
    prefixLen: Number(r.prefix_len),
    interface: r.interface ?? null,
    kind: r.kind,
    management: r.management,
    tenantId: r.tenant_id === null || r.tenant_id === undefined ? null : Number(r.tenant_id),
    accountId: assigned ? Number(r.account_id) : null,
    accountUsername: r.account_username ?? null,
    takeoverWeb: assigned && !!r.takeover_web,
    snatOutbound: assigned && !!r.snat_outbound,
    status: r.status,
    statusMessage: r.status_message ?? null,
    checkedAt: iso(r.checked_at),
    description: r.description ?? null,
    bindings: Number(r.binding_count ?? 0),
    createdAt: iso(r.created_at) ?? '',
    updatedAt: iso(r.updated_at) ?? '',
  };
}

/** Local address of an IP (what is on the interface): local_address, else the public one. */
export const localOf = (r: Pick<PublicIpRow, 'address' | 'local_address'>): string => (r.local_address || r.address);

type Conn = Knex | Knex.Transaction;

/** The shared IP row of a node (null when public_ipv4 was never set). */
export async function sharedIpOf(nodeId: number, conn: Conn = db): Promise<PublicIpRow | null> {
  return (await conn('public_ips').where({ node_id: nodeId, kind: 'shared' }).first() as PublicIpRow | undefined) ?? null;
}

/** The dedicated IP of an account (null = none). */
export async function dedicatedIpOf(accountId: number, conn: Conn = db): Promise<PublicIpRow | null> {
  return (await conn('public_ips').where({ account_id: accountId, kind: 'dedicated' }).first() as PublicIpRow | undefined) ?? null;
}

/**
 * Keeps the shared row of the local node in step with app_config public_ipv4 (settings route, setup).
 * The row keeps its id (allocations / bindings reference it): only its address changes. null / invalid
 * address → nothing (the row, if any, stays: removing it would orphan the blocks).
 */
export async function syncSharedIp(address: string | null): Promise<void> {
  const v4 = (address ?? '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return;
  try {
    const node = await db('nodes').where({ is_local: true }).first('id') as { id: number } | undefined;
    if (!node) return;
    await db.transaction(async (trx) => {
      const shared = await sharedIpOf(Number(node.id), trx);
      const clash = await trx('public_ips').where({ node_id: node.id }).whereNot('kind', 'shared')
        .andWhere((q) => { q.where('address', v4).orWhere('local_address', v4); }).first('id');
      if (clash) {
        logger.warn({ address: v4 }, 'public_ipv4 is also declared as a dedicated IP: the shared IP row is left as it is');
        return;
      }
      if (shared) {
        if (shared.address !== v4) await trx('public_ips').where({ id: shared.id }).update({ address: v4, updated_at: trx.fn.now() });
      } else {
        await trx('public_ips').insert({ node_id: node.id, address: v4, kind: 'shared', management: 'external', status: 'active' });
      }
    });
    invalidateNodeAddresses();
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'shared public IP not synchronised with public_ipv4');
  }
}

// ── the node's own addresses ─────────────────────────────────────────────────

const CACHE_MS = 60_000;
let cache: { at: number; addresses: string[] } | null = null;
let override: string[] | null = null;

/**
 * Every public address of the node: app_config public_ipv4 / public_ipv6, the shared and dedicated IPs and
 * their local addresses. Cached 60 s, never throws (the last known list on a DB error).
 */
export async function nodeAddresses(): Promise<string[]> {
  if (override) return override;
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.addresses;
  try {
    const cfg = await db('app_config').whereIn('key', ['public_ipv4', 'public_ipv6']).orderBy('key').select('value') as Array<{ value: string | null }>;
    let ips: Array<{ address: string; local_address: string | null }> = [];
    try {
      ips = await db('public_ips').select('address', 'local_address') as typeof ips;
    } catch { /* before migration 032 */ }
    const set = new Set<string>();
    for (const r of cfg) { const v = (r.value ?? '').trim(); if (v) set.add(v); }
    for (const r of ips) { set.add(r.address); if (r.local_address) set.add(r.local_address); }
    const addresses = [...set];
    cache = { at: Date.now(), addresses };
    return addresses;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, 'Node addresses unreadable (the last known ones are kept)');
    return cache?.addresses ?? [];
  }
}

export function invalidateNodeAddresses(): void {
  cache = null;
}

/** Tests: fixed addresses (null = read again). */
export function setNodeAddressListForTests(list: string[] | null): void {
  override = list;
  cache = null;
}
