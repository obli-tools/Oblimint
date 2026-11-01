import type { Knex } from 'knex';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import {
  addressAt, allocationOffsets, fabricAccountId, isEphemeralContainer, layoutOf, offsetOf, sameIdentity, slotFor, slotUsable, type AddressLayout,
} from './addressLayout';
import { segmentBackends } from './deps';
import { endpointIpv4 } from './ipv4';

// ─────────────────────────────────────────────────────────────────────────────
// Address allocation of the managed networks (migration 031, table
// network_addresses; layout: addressLayout.ts). One live row per (node,
// network, container NAME): a recreation (remove + create under the same
// name) gets the same address back. The table is the truth: the panel imposes
// it on Docker (dockerOps resolver), the policy narrows an endpoint whose
// observed address is not its allocation (model.ts / policy.ts).
//
// Concurrency: one allocation at a time in the process per (node, network)
// AND a transaction-scoped advisory lock (another panel process / a script),
// the partial unique indexes being the last barrier (violation → re-read,
// retry). Deterministic: the fixed slot when free, else the smallest free pool
// offset — on a network without IPRange (adopted) no fixed slot and the pool
// from the top (away from Docker's dynamic allocations). A RELEASED address is reusable only once a policy push succeeded
// after its release (no rule persisted by hostd can still name it); before the
// first push of the process, no released address is reused.
//
// Releases: account teardown, network removal, GC (container absent from
// Docker for 30 min, network gone) — NEVER removeContainer (a recreation is
// remove + create under the same name).
// ─────────────────────────────────────────────────────────────────────────────

export type AddressOrigin = 'slot' | 'pool' | 'adopted' | 'observed';

export interface AddressRow {
  id: number;
  node_id: number;
  network_name: string;
  ip: string;
  container_name: string;
  origin: AddressOrigin;
  slot: string | null;
  account_id: number | null;
  allocated_at: Date | string;
  last_seen_at: Date | string;
  released_at: Date | string | null;
}

/** GC grace: a row whose container Docker no longer has is released after this long. */
export const ADDRESS_GC_GRACE_MS = 30 * 60_000;
/** Released rows are purged after this long (history only). */
const RELEASED_PURGE_MS = 7 * 24 * 3600_000;

// ── reuse gate (sync.ts registers the last successful push) ─────────────────

let lastPushProvider: () => Date | null = () => null;

/** sync.ts: time of the last successful policy push (released addresses older than it are reusable). */
export function setLastPushProvider(fn: () => Date | null): void {
  lastPushProvider = fn;
}

// ── serialization ────────────────────────────────────────────────────────────

const chains = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  chains.set(key, tail);
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}

async function lockNetwork(trx: Knex.Transaction, nodeId: number, network: string): Promise<void> {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`netaddr:${nodeId}:${network}`]);
}

function liveRows(conn: Knex | Knex.Transaction, nodeId: number, network: string): Knex.QueryBuilder {
  return conn('network_addresses').where({ node_id: nodeId, network_name: network }).whereNull('released_at');
}

export interface AddressForOptions {
  /** IPv4 subnet of the Docker network (inspect), its IPRange / gateway. */
  cidr: string;
  ipRange?: string | null;
  gateway?: string | null;
  /** Inspected name of the panel container (fixed slot 2). */
  panelName?: string | null;
  /** IPs seen on this Docker network → container name holding them (another container's are never allocated). */
  inUse?: ReadonlyMap<string, string>;
}

/** Addresses of the network that a NEW allocation must avoid (live rows, released ones not reusable yet, Docker). */
async function takenAddresses(conn: Knex.Transaction, nodeId: number, network: string, container: string, inUse: ReadonlyMap<string, string>): Promise<Set<string>> {
  const taken = new Set<string>();
  for (const r of await liveRows(conn, nodeId, network).select('ip', 'container_name') as Array<{ ip: string; container_name: string }>) {
    if (r.container_name !== container) taken.add(r.ip);
  }
  const lastPush = lastPushProvider();
  const releasedQb = conn('network_addresses').where({ node_id: nodeId, network_name: network }).whereNotNull('released_at');
  if (lastPush) releasedQb.andWhere('released_at', '>=', lastPush);
  for (const ip of await releasedQb.pluck('ip') as string[]) taken.add(ip);
  // Its own stopped copy (<name>-oblimint-prev / <panel>-old-<ts>) holds the address it gets back: not taken.
  for (const [ip, holder] of inUse) if (!sameIdentity(holder, container)) taken.add(ip);
  return taken;
}

/**
 * The address of `container` on `network` (allocated when it has none).
 * Idempotent per container name. 507 addressPoolExhausted when the pool is
 * full; throws on a DB error (the creation / connection then fails: never a
 * silent dynamic address).
 */
export function addressFor(nodeId: number, network: string, container: string, opts: AddressForOptions): Promise<string> {
  if (isEphemeralContainer(container)) return Promise.reject(new Error(`${container} never gets a fixed address`));
  return serialized(`${nodeId}:${network}`, () => addressForInner(nodeId, network, container, opts));
}

async function addressForInner(nodeId: number, network: string, container: string, opts: AddressForOptions): Promise<string> {
  const layout = layoutOf(opts.cidr, opts.ipRange ?? null, opts.gateway ?? null);
  const inUse = normalizeInUse(opts.inUse);
  const now = segmentBackends().now();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await db.transaction(async (trx) => {
        await lockNetwork(trx, nodeId, network);
        const row = await liveRows(trx, nodeId, network).andWhere({ container_name: container }).first() as AddressRow | undefined;
        if (row) {
          const off = offsetOf(layout, row.ip);
          const holder = inUse.get(row.ip);
          // Held by its own stopped copy (platform update / self-update: renamed, stopped, same static address): kept.
          if (off !== null && (!holder || sameIdentity(holder, container))) {
            await trx('network_addresses').where({ id: row.id }).update({ last_seen_at: now });
            return row.ip;
          }
          // Network recreated with another subnet, or the address now held by an intruder: a new one.
          logger.warn({ network, container, ip: row.ip, holder: holder ?? null }, 'addresses: allocation outside the subnet or held by another container: reallocated');
          await trx('network_addresses').where({ id: row.id }).update({ released_at: now });
        }
        const taken = await takenAddresses(trx, nodeId, network, container, inUse);
        const slot = slotFor(container, opts.panelName);
        let ip: string | null = null;
        let origin: AddressOrigin = 'pool';
        // A network without IPRange (adopted): Docker's allocator restarts from the bottom of the subnet after a
        // daemon restart and would give a low fixed slot to a container still dynamic — the owner then never
        // starts (verified on Docker 29). No fixed slot there, the pool is taken from the top.
        if (slot && layout.dynamic && slotUsable(layout, slot.offset)) {
          const candidate = addressAt(layout, slot.offset);
          if (!taken.has(candidate)) { ip = candidate; origin = 'slot'; }
        }
        if (!ip) {
          for (const off of allocationOffsets(layout)) {
            const candidate = addressAt(layout, off);
            if (!taken.has(candidate)) { ip = candidate; break; }
          }
        }
        if (!ip) {
          throw new AppError(507, `No free address left on ${network} for ${container}`, 'addressPoolExhausted', { network });
        }
        await trx('network_addresses').insert({
          node_id: nodeId, network_name: network, ip, container_name: container, origin, slot: origin === 'slot' ? slot!.name : null,
          account_id: fabricAccountId(network), allocated_at: now, last_seen_at: now, released_at: null,
        });
        return ip;
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      logger.debug({ network, container, attempt }, 'addresses: concurrent allocation, retrying');
    }
  }
  throw new AppError(409, `Could not allocate an address for ${container} on ${network} (concurrent allocations)`, 'allocationConflict');
}

function normalizeInUse(m: ReadonlyMap<string, string> | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const [ip, name] of m ?? []) {
    const a = endpointIpv4(ip);
    if (a) out.set(a, name);
  }
  return out;
}

export type AdoptOutcome =
  | { status: 'kept' | 'created' | 'moved'; ip: string }
  /** The address is allocated to another container: nothing changed. */
  | { status: 'conflict'; ip: string; holder: string; allocated: string | null };

/**
 * Records the CURRENT address of a container (migration of the existing
 * endpoints, networks where Docker refuses static addresses). A row with
 * another address is moved to the current one when that one is free;
 * `origin` 'observed' marks a row that follows the observation.
 */
export function adoptAddress(nodeId: number, network: string, container: string, ip: string, origin: 'adopted' | 'observed' = 'adopted'): Promise<AdoptOutcome> {
  const addr = endpointIpv4(ip);
  if (!addr) return Promise.reject(new Error(`invalid address ${ip}`));
  if (isEphemeralContainer(container)) return Promise.reject(new Error(`${container} never gets a fixed address`));
  return serialized(`${nodeId}:${network}`, async () => {
    const now = segmentBackends().now();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await db.transaction(async (trx): Promise<AdoptOutcome> => {
          await lockNetwork(trx, nodeId, network);
          const rows = await liveRows(trx, nodeId, network).andWhere((w) => w.where({ container_name: container }).orWhere({ ip: addr })).select('*') as AddressRow[];
          const mine = rows.find((r) => r.container_name === container) ?? null;
          const holder = rows.find((r) => r.ip === addr && r.container_name !== container) ?? null;
          if (mine && mine.ip === addr) {
            const patch: Record<string, unknown> = { last_seen_at: now };
            if (origin === 'observed' && mine.origin !== 'observed') patch.origin = 'observed';
            await trx('network_addresses').where({ id: mine.id }).update(patch);
            return { status: 'kept', ip: addr };
          }
          if (holder) return { status: 'conflict', ip: addr, holder: holder.container_name, allocated: mine?.ip ?? null };
          if (mine) {
            await trx('network_addresses').where({ id: mine.id }).update({ ip: addr, origin, slot: null, last_seen_at: now });
            return { status: 'moved', ip: addr };
          }
          await trx('network_addresses').insert({
            node_id: nodeId, network_name: network, ip: addr, container_name: container, origin, slot: null,
            account_id: fabricAccountId(network), allocated_at: now, last_seen_at: now, released_at: null,
          });
          return { status: 'created', ip: addr };
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    throw new AppError(409, `Could not adopt ${addr} for ${container} on ${network} (concurrent allocations)`, 'allocationConflict');
  });
}

/** Releases rows (account teardown, network removed, ephemeral container ended). Idempotent; returns how many. */
export async function releaseAddresses(where: { nodeId?: number; network?: string; container?: string; accountId?: number }): Promise<number> {
  if (where.network === undefined && where.container === undefined && where.accountId === undefined) return 0;
  const qb = db('network_addresses').whereNull('released_at');
  if (where.nodeId !== undefined) qb.andWhere('node_id', where.nodeId);
  if (where.network !== undefined) qb.andWhere('network_name', where.network);
  if (where.container !== undefined) qb.andWhere('container_name', where.container);
  if (where.accountId !== undefined) qb.andWhere('account_id', where.accountId);
  return Number(await qb.update({ released_at: segmentBackends().now() }));
}

export interface GcInput {
  /** Every container name Docker has (all states). */
  containers: ReadonlySet<string>;
  /** Every Docker network name. */
  networks: ReadonlySet<string>;
}

/**
 * Seen rows get last_seen_at = now; rows of a network Docker no longer has are
 * released at once, rows of a container absent for ADDRESS_GC_GRACE_MS too.
 * Released rows older than a week are purged.
 */
export async function gcAddresses(nodeId: number, observed: GcInput): Promise<{ released: number; purged: number }> {
  const now = segmentBackends().now();
  const rows = await db('network_addresses').where({ node_id: nodeId }).whereNull('released_at').select('id', 'network_name', 'container_name', 'last_seen_at') as
    Array<{ id: number; network_name: string; container_name: string; last_seen_at: Date | string }>;
  const seen: number[] = [];
  const release: number[] = [];
  for (const r of rows) {
    if (!observed.networks.has(r.network_name)) { release.push(r.id); continue; }
    if (observed.containers.has(r.container_name)) { seen.push(r.id); continue; }
    if (now.getTime() - new Date(r.last_seen_at).getTime() >= ADDRESS_GC_GRACE_MS) release.push(r.id);
  }
  for (let i = 0; i < seen.length; i += 500) await db('network_addresses').whereIn('id', seen.slice(i, i + 500)).update({ last_seen_at: now });
  for (let i = 0; i < release.length; i += 500) await db('network_addresses').whereIn('id', release.slice(i, i + 500)).update({ released_at: now });
  const purged = Number(await db('network_addresses').where({ node_id: nodeId }).whereNotNull('released_at')
    .andWhere('released_at', '<', new Date(now.getTime() - RELEASED_PURGE_MS)).del());
  if (release.length) logger.info({ released: release.length }, 'addresses: allocations of vanished containers / networks released');
  return { released: release.length, purged };
}

/** Live rows of a node (optionally one network). */
export async function liveAddresses(nodeId: number, network?: string): Promise<AddressRow[]> {
  const qb = db('network_addresses').where({ node_id: nodeId }).whereNull('released_at');
  if (network) qb.andWhere('network_name', network);
  return await qb.orderBy(['network_name', 'ip']).select('*') as AddressRow[];
}

/** (network → container name → address) of the live rows of a node. */
export async function addressIndex(nodeId: number): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  for (const r of await liveAddresses(nodeId)) {
    let m = out.get(r.network_name);
    if (!m) { m = new Map(); out.set(r.network_name, m); }
    m.set(r.container_name, r.ip);
  }
  return out;
}

/** Layout of a network from its Docker inspection (null when it has no IPv4 subnet or is too small to manage). */
export function layoutFromInspect(net: { IPAM?: { Config?: Array<{ Subnet?: string; IPRange?: string; Gateway?: string }> | null } | null } | null | undefined): AddressLayout | null {
  const cfg = (net?.IPAM?.Config ?? []).find((c) => typeof c?.Subnet === 'string' && /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(c.Subnet));
  if (!cfg?.Subnet) return null;
  try {
    return layoutOf(cfg.Subnet, cfg.IPRange || null, cfg.Gateway || null);
  } catch {
    return null;
  }
}
