import type Docker from 'dockerode';
import type { Knex } from 'knex';
import type { NetworkPoolStatus } from '@oblimint/shared';
import { config } from '../../config';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { withTimeout } from '../setup/docker';
import { segmentBackends } from './deps';
import { cidrContainsCidr, cidrsOverlap, formatCidr4, gatewayOf, parseCidr4, pickFreeSubnet, poolCapacity, type Cidr4 } from './ipv4';

// ─────────────────────────────────────────────────────────────────────────────
// Subnet allocator (docs/P4b-PLAN.md §4.1, table network_subnets).
//   fabric pool (config.hosting.fabricPool, /fabricPrefix): account FRONT / BACK bridges;
//   app pool    (config.hosting.appNetworkPool, /appNetworkPrefix): private networks of the stacks.
// A new subnet overlaps no subnet of an existing Docker network (any name)
// and no subnet allocated or released less than an hour ago (stale rules /
// ARP caches). Idempotent per network name: an allocated network keeps its
// subnet; a Docker network that already exists keeps its own (registered).
// One allocation at a time in the process (the unique cidr index guards the rest).
// ─────────────────────────────────────────────────────────────────────────────

export type SubnetPool = 'fabric' | 'app';
export type SubnetPurpose = 'front' | 'back' | 'app';

export const RELEASE_COOLDOWN_MS = 60 * 60_000;
const DOCKER_TIMEOUT_MS = 30_000;

export interface SubnetRow {
  id: number;
  cidr: string;
  pool: SubnetPool;
  network_name: string;
  account_id: number | null;
  stack_id: number | null;
  purpose: SubnetPurpose;
  allocated_at: Date | string;
  released_at: Date | string | null;
}

export interface SubnetOwner {
  pool: SubnetPool;
  purpose: SubnetPurpose;
  accountId: number | null;
  stackId?: number | null;
}

export interface AllocatedSubnet {
  cidr: string;
  gateway: string;
}

/** Subnets of every Docker network (IPv4 only), by network name. */
export interface DockerNetworkSubnets {
  name: string;
  subnets: string[];
}

export function poolConfig(pool: SubnetPool): { cidr: Cidr4; prefix: number } {
  const text = pool === 'fabric' ? config.hosting.fabricPool : config.hosting.appNetworkPool;
  const prefix = pool === 'fabric' ? config.hosting.fabricPrefix : config.hosting.appNetworkPrefix;
  const cidr = parseCidr4(text);
  if (!cidr || !Number.isInteger(prefix) || poolCapacity(cidr, prefix) === 0 || prefix > 30) {
    throw new AppError(500, `Invalid ${pool} subnet pool ${text} /${prefix}`, 'poolInvalid');
  }
  return { cidr, prefix };
}

export async function listDockerSubnets(docker: Pick<Docker, 'listNetworks'>): Promise<DockerNetworkSubnets[]> {
  const nets = await withTimeout(docker.listNetworks(), DOCKER_TIMEOUT_MS, 'list networks') as Array<{ Name?: string; IPAM?: { Config?: Array<{ Subnet?: string }> | null } }>;
  return nets.map((n) => ({
    name: String(n.Name ?? ''),
    subnets: (n.IPAM?.Config ?? []).map((c) => c?.Subnet).filter((s): s is string => typeof s === 'string' && parseCidr4(s) !== null),
  }));
}

// ── serialization ────────────────────────────────────────────────────────────

let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}

function canonical(cidr: string): string {
  const c = parseCidr4(cidr);
  return c ? formatCidr4(c) : cidr;
}

async function rowByName(conn: Knex | Knex.Transaction, name: string): Promise<SubnetRow | undefined> {
  return conn('network_subnets').where({ network_name: name }).first() as Promise<SubnetRow | undefined>;
}

/** Subnets that a NEW allocation must avoid (live + cooling down), except the rows of `exceptName`. */
async function reservedCidrs(conn: Knex | Knex.Transaction, now: Date, exceptName: string | null): Promise<string[]> {
  const since = new Date(now.getTime() - RELEASE_COOLDOWN_MS);
  const qb = conn('network_subnets').where((w) => w.whereNull('released_at').orWhere('released_at', '>', since));
  if (exceptName) qb.andWhereNot('network_name', exceptName);
  return (await qb.pluck('cidr')) as string[];
}

function conflictsWithDocker(cidr: string, name: string, docker: readonly DockerNetworkSubnets[]): boolean {
  const c = parseCidr4(cidr);
  if (!c) return true;
  return docker.some((n) => n.name !== name && n.subnets.some((s) => {
    const o = parseCidr4(s);
    return o !== null && cidrsOverlap(o, c);
  }));
}

/**
 * The subnet of a network (allocating one from the pool when needed).
 * `docker` = the subnets of the node's Docker networks (listDockerSubnets).
 * 507 poolExhausted when the pool is full.
 */
export function allocateSubnet(name: string, owner: SubnetOwner, docker: readonly DockerNetworkSubnets[]): Promise<AllocatedSubnet> {
  return serialized(() => allocateInner(name, owner, docker));
}

async function allocateInner(name: string, owner: SubnetOwner, docker: readonly DockerNetworkSubnets[]): Promise<AllocatedSubnet> {
  const now = segmentBackends().now();
  const ownerCols = { pool: owner.pool, purpose: owner.purpose, account_id: owner.accountId, stack_id: owner.stackId ?? null };

  // 1. The Docker network exists already: its subnet is the truth (registered as is).
  const existingNet = docker.find((n) => n.name === name && n.subnets.length > 0);
  if (existingNet) {
    const cidr = canonical(existingNet.subnets[0]);
    await registerSubnetInner(name, cidr, owner, docker);
    return { cidr, gateway: gatewayOf(parseCidr4(cidr)!) };
  }

  // 2. Already allocated (live, or ours and released): kept unless Docker now uses it elsewhere.
  const row = await rowByName(db, name);
  if (row) {
    const others = await reservedCidrs(db, now, name);
    const mine = parseCidr4(row.cidr);
    const taken = !mine || others.some((o) => { const a = parseCidr4(o); return !!a && cidrsOverlap(a, mine); });
    if (!taken && !conflictsWithDocker(row.cidr, name, docker)) {
      if (row.released_at !== null || row.account_id !== owner.accountId || row.stack_id !== (owner.stackId ?? null)) {
        await db('network_subnets').where({ id: row.id }).update({ ...ownerCols, released_at: null, allocated_at: now });
      }
      return { cidr: row.cidr, gateway: gatewayOf(parseCidr4(row.cidr)!) };
    }
    logger.warn({ network: name, cidr: row.cidr }, 'segments: allocated subnet now used elsewhere: reallocating');
    await db('network_subnets').where({ id: row.id }).del();
  }

  // 3. New subnet.
  const { cidr: pool, prefix } = poolConfig(owner.pool);
  for (let attempt = 0; attempt < 5; attempt++) {
    const taken = [...await reservedCidrs(db, now, null), ...docker.flatMap((n) => n.subnets)];
    const pick = pickFreeSubnet(pool, prefix, taken);
    if (!pick) {
      throw new AppError(507, `The ${owner.pool} subnet pool ${formatCidr4(pool)} is exhausted (/${prefix})`, 'poolExhausted', { pool: owner.pool });
    }
    const cidr = formatCidr4(pick);
    try {
      await db.transaction(async (trx) => {
        // A row still holding this cidr can only be a released one past its cool-down.
        await trx('network_subnets').where({ cidr }).whereNotNull('released_at').del();
        await trx('network_subnets').insert({ cidr, network_name: name, ...ownerCols, allocated_at: now, released_at: null });
      });
      return { cidr, gateway: gatewayOf(pick) };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await rowByName(db, name);
      if (raced && raced.released_at === null) return { cidr: raced.cidr, gateway: gatewayOf(parseCidr4(raced.cidr)!) };
    }
  }
  throw new AppError(409, `Could not allocate a subnet for ${name} (concurrent allocations)`, 'allocationConflict');
}

/**
 * Records the subnet a Docker network already has (legacy fabrics, networks
 * created with Docker defaults). A stale row holding the same cidr (released,
 * or naming a network Docker no longer has) is dropped; a live row of a
 * network that still exists with that subnet is a real conflict (throws).
 */
export function registerSubnet(name: string, cidr: string, owner: SubnetOwner, docker: readonly DockerNetworkSubnets[]): Promise<void> {
  return serialized(() => registerSubnetInner(name, canonical(cidr), owner, docker));
}

async function registerSubnetInner(name: string, cidr: string, owner: SubnetOwner, docker: readonly DockerNetworkSubnets[]): Promise<void> {
  const now = segmentBackends().now();
  const ownerCols = { pool: owner.pool, purpose: owner.purpose, account_id: owner.accountId, stack_id: owner.stackId ?? null };
  await db.transaction(async (trx) => {
    const holder = await trx('network_subnets').where({ cidr }).first() as SubnetRow | undefined;
    if (holder && holder.network_name !== name) {
      const live = holder.released_at === null && docker.some((n) => n.name === holder.network_name && n.subnets.some((s) => canonical(s) === cidr));
      if (live) throw new AppError(409, `Subnet ${cidr} of ${name} is registered for ${holder.network_name}`, 'subnetConflict');
      await trx('network_subnets').where({ id: holder.id }).del();
    }
    const row = await trx('network_subnets').where({ network_name: name }).first() as SubnetRow | undefined;
    if (row) {
      if (row.cidr !== cidr || row.released_at !== null || row.purpose !== owner.purpose || row.account_id !== owner.accountId || row.pool !== owner.pool) {
        await trx('network_subnets').where({ id: row.id }).update({ cidr, ...ownerCols, released_at: null });
      }
    } else {
      await trx('network_subnets').insert({ cidr, network_name: name, ...ownerCols, allocated_at: now, released_at: null });
    }
  });
}

/** Releases subnets (kept RELEASE_COOLDOWN_MS before reuse). Idempotent. */
export async function releaseSubnets(where: { accountId?: number; stackId?: number; networkName?: string }): Promise<number> {
  const qb = db('network_subnets').whereNull('released_at');
  if (where.accountId !== undefined) qb.andWhere('account_id', where.accountId);
  if (where.stackId !== undefined) qb.andWhere('stack_id', where.stackId);
  if (where.networkName !== undefined) qb.andWhere('network_name', where.networkName);
  if (where.accountId === undefined && where.stackId === undefined && where.networkName === undefined) return 0;
  return Number(await qb.update({ released_at: segmentBackends().now() }));
}

/** Usage of both pools (live allocations inside each pool). */
export async function poolStatus(): Promise<NetworkPoolStatus[]> {
  const rows = await db('network_subnets').whereNull('released_at').select('cidr', 'pool') as Array<{ cidr: string; pool: SubnetPool }>;
  const out: NetworkPoolStatus[] = [];
  for (const name of ['fabric', 'app'] as const) {
    try {
      const { cidr, prefix } = poolConfig(name);
      const used = rows.filter((r) => r.pool === name).filter((r) => { const c = parseCidr4(r.cidr); return !!c && cidrContainsCidr(cidr, c); }).length;
      out.push({ name, cidr: formatCidr4(cidr), prefix, used, total: poolCapacity(cidr, prefix) });
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, pool: name }, 'segments: invalid subnet pool');
    }
  }
  return out;
}
