import type { Knex } from 'knex';
import type {
  AccountPortsInfo, HostingSettings, PortAllocationPreview, PortAllocationRequest, PortBinding, PortBlock, PortPoolStatus, PortRange, ReservedPortRange,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import type { HostingActor } from '../hosting/access';
import { loadAccount } from '../hosting/access';
import { planLimits } from '../hosting/rows';
import { platformSettings } from '../platformSettings';
import { errText } from '../setup/docker';
import {
  checkExplicitRange, fmtRange, freeIntervals, intersectRanges, largestBlock, mergeRanges, planAllocation, planGrow, planShrink, portCount,
  PortAllocationError, subtractRanges, type BlockRow, type ContiguousMode,
} from './portAllocator';
import { dedicatedIpOf, localOf, sharedIpOf, type PublicIpRow } from './publicIps';
import { hostListeners, hostPortsOn, reservedInputs, reservedRanges } from './reservedPorts';

// ─────────────────────────────────────────────────────────────────────────────
// Port allocations of the shared IP (migration 032): reconcile of an account
// towards its target (public_ports_override ?? plan.publicPorts), explicit
// ranges of the platform admin, previews, the pool view, and the checks the
// settings make against the allocated ports. Concurrency like
// network/addresses.ts: serialized per (node, ip) in the process, then a
// transaction holding pg_advisory_xact_lock('portpool:<node>:<ip>'); the
// EXCLUDE gist constraint is the last guard (23P01 → read again, retry ×5).
// The same lock is taken by the deploys when they write bindings of the
// shared IP (network/publishing.service.ts). A released block stays out of
// the pool until a publish push succeeded after its release (sync.ts).
// A short pool / a blocked shrink never fails the caller of a reconcile: the
// account shows shortfall / excess to the admin.
// ─────────────────────────────────────────────────────────────────────────────

type Conn = Knex | Knex.Transaction;

const RELEASED_PURGE_MS = 7 * 24 * 3600_000;

// ── reuse gate (sync.ts registers the time of the last successful publish push) ──

let lastPublishPush: () => Date | null = () => null;

export function setLastPublishPushProvider(fn: () => Date | null): void {
  lastPublishPush = fn;
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

const RETRYABLE = new Set(['23P01', '23505', '40P01', '40001']);

/** Runs fn in a transaction holding the pool lock of (node, ip), retried on an overlap / unique / deadlock race. */
export function withPortPool<T>(nodeId: number, ipId: number, fn: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
  const key = `portpool:${nodeId}:${ipId}`;
  return serialized(key, async () => {
    let last: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await db.transaction(async (trx) => {
          await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [key]);
          return fn(trx);
        });
      } catch (err) {
        last = err;
        if (!RETRYABLE.has(String((err as { code?: string })?.code))) throw err;
      }
    }
    throw last;
  });
}

// ── reserved ports ───────────────────────────────────────────────────────────

/** Reserved ranges of an IP (shared, or dedicated with / without the takeover of 80 / 443). */
export async function reservedForIp(
  ip: Pick<PublicIpRow, 'kind' | 'address' | 'local_address' | 'takeover_web'>,
  settings?: HostingSettings,
  listeners?: Array<{ protocol: string; address: string; port: number }>,
): Promise<ReservedPortRange[]> {
  const s = settings ?? await platformSettings.get();
  const l = listeners ?? await hostListeners();
  // The shared scope is "every local address that is not dedicated": a socket bound to any of them counts.
  const hostPorts = hostPortsOn(l, ip.kind === 'shared' ? null : localOf(ip));
  return reservedRanges(reservedInputs(s, hostPorts), ip.kind, { takeoverWeb: ip.kind === 'dedicated' && !!ip.takeover_web });
}

export function poolOf(settings: HostingSettings): PortRange {
  const p = settings.network.publicPortPool ?? { from: 20000, to: 40000 };
  return { from: Number(p.from), to: Number(p.to) };
}

// ── rows ─────────────────────────────────────────────────────────────────────

interface AllocationRow {
  id: number;
  tenant_id: number;
  account_id: number;
  node_id: number;
  public_ip_id: number;
  port_from: number;
  port_to: number;
  origin: 'plan' | 'manual';
  created_at: Date | string;
  released_at: Date | string | null;
}

const toBlock = (r: AllocationRow): BlockRow => ({ id: Number(r.id), from: Number(r.port_from), to: Number(r.port_to), origin: r.origin });
const iso = (d: Date | string | null | undefined): string => (d instanceof Date ? d.toISOString() : d ? new Date(d).toISOString() : '');

async function liveBlocksOf(conn: Conn, ipId: number, accountId?: number): Promise<AllocationRow[]> {
  const qb = conn('port_allocations').where({ public_ip_id: ipId }).whereNull('released_at');
  if (accountId !== undefined) qb.andWhere('account_id', accountId);
  return await qb.orderBy('port_from').select('*') as AllocationRow[];
}

/** Released ranges still behind the reuse barrier (released after the last successful publish push, or no push yet). */
async function barrierRanges(conn: Conn, ipId: number): Promise<PortRange[]> {
  const qb = conn('port_allocations').where({ public_ip_id: ipId }).whereNotNull('released_at');
  const last = lastPublishPush();
  if (last) qb.andWhere('released_at', '>=', last);
  qb.andWhere('released_at', '>=', new Date(Date.now() - RELEASED_PURGE_MS));
  return (await qb.select('port_from', 'port_to') as Array<{ port_from: number; port_to: number }>).map((r) => ({ from: Number(r.port_from), to: Number(r.port_to) }));
}

/** Ports of the account's blocks on the ip that carry a binding (tcp or udp). */
async function usedPorts(conn: Conn, accountId: number, ipId: number): Promise<Set<number>> {
  const rows = await conn('port_bindings').where({ account_id: accountId, public_ip_id: ipId }).distinct('public_port') as Array<{ public_port: number }>;
  return new Set(rows.map((r) => Number(r.public_port)));
}

interface AccountRowLite {
  id: number;
  tenant_id: number;
  node_id: number;
  status: string;
  public_ports_override: number | null;
  limits: unknown;
}

async function accountLite(conn: Conn, accountId: number): Promise<AccountRowLite | null> {
  return (await conn('hosting_accounts as a').join('plans as p', 'p.id', 'a.plan_id').where('a.id', accountId)
    .first('a.id', 'a.tenant_id', 'a.node_id', 'a.status', 'a.public_ports_override', 'p.limits') as AccountRowLite | undefined) ?? null;
}

export function targetOf(a: Pick<AccountRowLite, 'public_ports_override' | 'limits'>): { target: number; source: 'plan' | 'override'; planValue: number } {
  const planValue = Math.max(0, Math.floor(Number(planLimits(a.limits).publicPorts ?? 0)) || 0);
  const ov = a.public_ports_override;
  if (ov !== null && ov !== undefined) return { target: Math.max(0, Number(ov)), source: 'override', planValue };
  return { target: planValue, source: 'plan', planValue };
}

// ── core change (inside the pool lock) ───────────────────────────────────────

interface ChangeResult {
  before: PortRange[];
  after: PortRange[];
  added: PortRange[];
  removed: PortRange[];
}

interface PoolInputs {
  settings: HostingSettings;
  reserved: ReservedPortRange[];
}

async function poolInputs(ip: PublicIpRow): Promise<PoolInputs> {
  const settings = await platformSettings.get();
  return { settings, reserved: await reservedForIp(ip, settings) };
}

/**
 * Brings the account's blocks on the shared ip to `target` (write = false: computes only). Throws
 * PortAllocationError on a short pool / a blocked shrink.
 */
async function changeInTrx(
  trx: Knex.Transaction, acct: AccountRowLite, ip: PublicIpRow, inputs: PoolInputs, target: number,
  opts: { mode: ContiguousMode; write: boolean; actorId?: number | null; range?: PortRange | null },
): Promise<ChangeResult> {
  const pool = poolOf(inputs.settings);
  const all = await liveBlocksOf(trx, ip.id);
  const mine = all.filter((r) => Number(r.account_id) === Number(acct.id));
  const others = all.filter((r) => Number(r.account_id) !== Number(acct.id));
  const blocks = mine.map(toBlock);
  const before = mergeRanges(blocks);
  const released = await barrierRanges(trx, ip.id);
  const free = freeIntervals(pool, inputs.reserved, all.map((r) => ({ from: Number(r.port_from), to: Number(r.port_to) })), released);
  const now = new Date();
  let added: PortRange[] = [];
  let removed: PortRange[] = [];
  let after = before;

  if (opts.range) {
    checkExplicitRange(opts.range, pool, inputs.reserved, [...others.map((r) => ({ from: Number(r.port_from), to: Number(r.port_to) })), ...before, ...released]);
    added = [opts.range];
    after = mergeRanges([...before, opts.range]);
    if (opts.write) {
      await trx('port_allocations').insert({
        tenant_id: acct.tenant_id, account_id: acct.id, node_id: acct.node_id, public_ip_id: ip.id,
        port_from: opts.range.from, port_to: opts.range.to, origin: 'manual', created_by: opts.actorId ?? null,
      });
    }
    return { before, after, added, removed };
  }

  const current = portCount(blocks);
  if (target > current) {
    const plan = planGrow(blocks, free, target - current, opts.mode);
    if (plan.extend) {
      const b = blocks.find((x) => x.id === plan.extend!.id)!;
      added.push({ from: b.to + 1, to: plan.extend.to });
      if (opts.write) await trx('port_allocations').where({ id: b.id }).update({ port_to: plan.extend.to });
    }
    for (const r of plan.add) {
      added.push(r);
      if (opts.write) {
        await trx('port_allocations').insert({
          tenant_id: acct.tenant_id, account_id: acct.id, node_id: acct.node_id, public_ip_id: ip.id,
          port_from: r.from, port_to: r.to, origin: 'plan', created_by: opts.actorId ?? null,
        });
      }
    }
  } else if (target < current) {
    const used = await usedPorts(trx, acct.id, ip.id);
    const plan = planShrink(blocks, used, target);
    removed = plan.released;
    if (opts.write) {
      for (const [id, remaining] of plan.changes) {
        const row = mine.find((r) => Number(r.id) === id)!;
        await trx('port_allocations').where({ id }).update({ released_at: now });
        for (const r of remaining) {
          await trx('port_allocations').insert({
            tenant_id: acct.tenant_id, account_id: acct.id, node_id: acct.node_id, public_ip_id: ip.id,
            port_from: r.from, port_to: r.to, origin: row.origin, created_by: opts.actorId ?? null,
          });
        }
      }
    }
  }
  after = mergeRanges(subtractRanges([...before, ...added], removed));
  return { before, after, added: mergeRanges(added), removed };
}

// ── reconcile ────────────────────────────────────────────────────────────────

export interface ReconcileOutcome {
  changed: boolean;
  added: PortRange[];
  removed: PortRange[];
  /** Why the target could not be reached (portPoolExhausted, portPoolNoContiguousBlock, portsInUse, noSharedIp). */
  problem: string | null;
}

/** Brings the account's blocks towards its target. Never throws (the problem is returned / logged). */
export async function reconcileAccountPorts(accountId: number, reason = 'reconcile'): Promise<ReconcileOutcome> {
  const none: ReconcileOutcome = { changed: false, added: [], removed: [], problem: null };
  try {
    const acct = await accountLite(db, accountId);
    if (!acct || acct.status === 'deleting') return none;
    const ip = await sharedIpOf(Number(acct.node_id));
    const { target } = targetOf(acct);
    if (!ip) return { ...none, problem: target > 0 ? 'noSharedIp' : null };
    const inputs = await poolInputs(ip);
    const res = await withPortPool(Number(acct.node_id), ip.id, async (trx) => {
      const fresh = await accountLite(trx, accountId);
      if (!fresh || fresh.status === 'deleting') return null;
      return changeInTrx(trx, fresh, ip, inputs, targetOf(fresh).target, { mode: 'prefer', write: true });
    });
    if (!res) return none;
    const changed = res.added.length > 0 || res.removed.length > 0;
    if (changed) {
      logger.info({ accountId, reason, added: res.added.map(fmtRange), removed: res.removed.map(fmtRange) }, 'ports: allocation reconciled');
      afterChange(accountId);
    }
    return { changed, added: res.added, removed: res.removed, problem: null };
  } catch (err) {
    if (err instanceof PortAllocationError) {
      logger.info({ accountId, reason, code: err.code }, 'ports: target not reached (shortfall / excess shown to the admin)');
      return { ...none, problem: err.code };
    }
    logger.warn({ accountId, reason, err: errText(err) }, 'ports: reconcile failed');
    return { ...none, problem: 'error' };
  }
}

function afterChange(accountId: number): void {
  void import('./sync').then((m) => m.requestPolicySync(`ports:${accountId}`)).catch(() => undefined);
  void import('../hosting/events').then(async (m) => {
    const { HostingSocketEvents } = await import('@oblimint/shared');
    const row = await db('hosting_accounts').where({ id: accountId }).first('tenant_id') as { tenant_id: number } | undefined;
    if (row) m.emitHosting(HostingSocketEvents.NETWORK_UPDATED, { accountId, linkId: null }, { tenantId: Number(row.tenant_id), accountId });
  }).catch(() => undefined);
}

// Bounded queue of accounts to reconcile (plan edits touch many accounts).
const queue = new Set<number>();
let queueTimer: NodeJS.Timeout | null = null;
let queueRunning = false;
const MAX_QUEUE = 100_000;

/** Reconcile soon (debounced, deduplicated, sequential). Never throws. */
export function requestAccountPorts(accountId: number, reason = 'request'): void {
  try {
    if (!Number.isInteger(accountId) || accountId <= 0 || queue.size >= MAX_QUEUE) return;
    queue.add(accountId);
    if (queueTimer || queueRunning) return;
    queueTimer = setTimeout(() => { queueTimer = null; void drain(reason); }, 500);
    queueTimer.unref?.();
  } catch (err) {
    logger.warn({ err: errText(err) }, 'requestAccountPorts failed');
  }
}

async function drain(reason: string): Promise<void> {
  queueRunning = true;
  try {
    while (queue.size) {
      const [id] = queue;
      queue.delete(id);
      await reconcileAccountPorts(id, reason);
    }
  } finally {
    queueRunning = false;
  }
}

/** Every account of a plan (its publicPorts changed). */
export async function requestPlanAccountsPorts(planId: number, reason = 'plan'): Promise<void> {
  try {
    const rows = await db('hosting_accounts').where({ plan_id: planId }).whereNot('status', 'deleting').pluck('id') as number[];
    for (const id of rows) requestAccountPorts(Number(id), reason);
  } catch (err) {
    logger.warn({ planId, err: errText(err) }, 'ports: accounts of the plan not queued');
  }
}

/**
 * Every account of the platform (the pool / reserved ports changed: shortfalls may now be served; at boot:
 * the in-memory queue of a previous process is lost). An account whose target fell to 0 but still holds
 * live blocks is queued too (its shrink was pending).
 */
export async function requestAllAccountsPorts(reason = 'settings'): Promise<void> {
  try {
    const rows = await db('hosting_accounts as a').join('plans as p', 'p.id', 'a.plan_id').whereNot('a.status', 'deleting')
      .select('a.id', 'a.public_ports_override', 'p.limits',
        db.raw('EXISTS (SELECT 1 FROM port_allocations pa WHERE pa.account_id = a.id AND pa.released_at IS NULL) AS has_blocks')) as
      Array<{ id: number; public_ports_override: number | null; limits: unknown; has_blocks: boolean }>;
    for (const r of rows) {
      if (targetOf(r).target > 0 || r.has_blocks) requestAccountPorts(Number(r.id), reason);
    }
  } catch (err) {
    logger.warn({ err: errText(err) }, 'ports: accounts not queued');
  }
}

/** Tests: wait for the queue. */
export async function whenPortsQueueIdle(): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (!queue.size && !queueTimer && !queueRunning) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ── account teardown ─────────────────────────────────────────────────────────

/** Releases the blocks, detaches the dedicated IP, removes the bindings (the publish push follows). Never throws. */
export async function releaseAccountPorts(accountId: number): Promise<void> {
  try {
    await db.transaction(async (trx) => {
      await trx('port_allocations').where({ account_id: accountId }).whereNull('released_at').update({ released_at: trx.fn.now() });
      await trx('port_bindings').where({ account_id: accountId }).delete();
      await trx('public_ips').where({ account_id: accountId }).update({ account_id: null, tenant_id: null, takeover_web: false, snat_outbound: false, updated_at: trx.fn.now() });
    });
  } catch (err) {
    logger.warn({ accountId, err: errText(err) }, 'ports: allocations of the deleted account not released');
  }
}

// ── views ────────────────────────────────────────────────────────────────────

export function isPlatformAdmin(actor: HostingActor): boolean {
  return actor.kind === 'staff' && actor.globalView && actor.caps === '*';
}

export function assertPlatformAdmin(actor: HostingActor): void {
  if (!isPlatformAdmin(actor)) throw new AppError(403, 'Only a platform administrator may change public ports and IPs', 'platformAdminOnly');
}

export interface BindingRowJoined {
  id: number;
  account_id: number;
  tenant_id: number;
  public_ip_id: number;
  protocol: 'tcp' | 'udp';
  public_port: number;
  target_kind: 'app';
  stack_id: number | null;
  service: string | null;
  container_port: number;
  status: PortBinding['status'];
  status_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  address: string;
  ip_kind: 'shared' | 'dedicated';
  stack_name: string | null;
}

export function bindingsQuery(conn: Conn = db): Knex.QueryBuilder {
  return conn('port_bindings as b').join('public_ips as i', 'i.id', 'b.public_ip_id').leftJoin('app_stacks as s', 's.id', 'b.stack_id')
    .select('b.*', 'i.address', 'i.kind as ip_kind', 's.display_name as stack_name');
}

export function toBinding(r: BindingRowJoined): PortBinding {
  return {
    id: Number(r.id), accountId: Number(r.account_id), targetKind: r.target_kind, stackId: r.stack_id === null ? null : Number(r.stack_id),
    stackName: r.stack_name ?? null, service: r.service ?? null, publicIpId: Number(r.public_ip_id), address: r.address,
    dedicated: r.ip_kind === 'dedicated', protocol: r.protocol, publicPort: Number(r.public_port), containerPort: Number(r.container_port),
    status: r.status, statusMessage: r.status_message ?? null, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

/** GET /accounts/:id/network/ports (read on the account; clients see their own account). */
export async function accountPortsInfo(actor: HostingActor, accountId: number): Promise<AccountPortsInfo> {
  const row = await loadAccount(actor, accountId, 'read');
  const acct = (await accountLite(db, row.id))!;
  const t = targetOf(acct);
  const shared = await sharedIpOf(Number(row.node_id));
  const blocks = shared ? await liveBlocksOf(db, shared.id, row.id) : [];
  const dedicated = await dedicatedIpOf(row.id);
  const bindings = (await bindingsQuery().where('b.account_id', row.id).orderBy(['b.public_ip_id', 'b.public_port', 'b.protocol']) as BindingRowJoined[]).map(toBinding);
  const allocated = portCount(blocks.map(toBlock));
  const used = new Set(bindings.filter((b) => !b.dedicated).map((b) => b.publicPort)).size;
  const state = t.target === 0 && allocated === 0 ? 'none' : allocated < t.target ? 'shortfall' : allocated > t.target ? 'excess' : 'ok';
  return {
    accountId: row.id,
    target: t.target,
    source: t.source,
    planValue: t.planValue,
    override: acct.public_ports_override === null || acct.public_ports_override === undefined ? null : Number(acct.public_ports_override),
    allocated,
    used,
    blocks: blocks.map((b): PortBlock => ({ id: Number(b.id), from: Number(b.port_from), to: Number(b.port_to), origin: b.origin, createdAt: iso(b.created_at) })),
    state,
    sharedIp: shared ? { id: shared.id, address: shared.address } : null,
    dedicatedIp: dedicated ? {
      id: dedicated.id, address: dedicated.address, takeoverWeb: !!dedicated.takeover_web, snatOutbound: !!dedicated.snat_outbound,
      status: dedicated.status, statusMessage: dedicated.status_message ?? null,
    } : null,
    bindings,
    canManage: isPlatformAdmin(actor),
  };
}

function allocationError(err: PortAllocationError): AppError {
  return new AppError(409, err.message, err.code, err.details);
}

async function preparedChange(accountId: number, body: PortAllocationRequest, write: boolean, actorId: number | null): Promise<{ res: ChangeResult; acct: AccountRowLite }> {
  const acct = await accountLite(db, accountId);
  if (!acct) throw new AppError(404, 'Account not found', 'notFound');
  if (acct.status === 'deleting') throw new AppError(409, 'The account is being deleted', 'accountDeleting');
  const ip = await sharedIpOf(Number(acct.node_id));
  if (!ip) throw new AppError(409, 'The node has no shared public IPv4 (Settings → Platform)', 'noSharedIp');
  const inputs = await poolInputs(ip);
  const mode: ContiguousMode = body.contiguous === 'require' ? 'require' : 'prefer';
  try {
    const res = await withPortPool(Number(acct.node_id), ip.id, async (trx) => {
      const fresh = (await accountLite(trx, accountId))!;
      let target: number;
      if (body.range) {
        target = 0; // explicit range: added as is
      } else if (body.count === null || body.count === undefined) {
        target = targetOf({ ...fresh, public_ports_override: null }).target;
      } else {
        target = Math.max(0, Math.floor(body.count));
      }
      const r = await changeInTrx(trx, fresh, ip, inputs, target, { mode, write, actorId, range: body.range ?? null });
      if (write) {
        const override = body.range ? portCount(r.after) : body.count === null || body.count === undefined ? null : target;
        await trx('hosting_accounts').where({ id: fresh.id, tenant_id: fresh.tenant_id }).update({ public_ports_override: override, updated_at: trx.fn.now() });
      }
      if (!write) throw new PreviewDone(r);
      return r;
    });
    return { res, acct };
  } catch (err) {
    if (err instanceof PreviewDone) return { res: err.result, acct };
    if (err instanceof PortAllocationError) throw allocationError(err);
    throw err;
  }
}

/** Rolls the preview transaction back while handing its result out. */
class PreviewDone extends Error {
  constructor(readonly result: ChangeResult) { super('preview'); }
}

/** POST /accounts/:id/network/ports/preview (platform admin). */
export async function previewAllocation(actor: HostingActor, accountId: number, body: PortAllocationRequest): Promise<PortAllocationPreview> {
  assertPlatformAdmin(actor);
  await loadAccount(actor, accountId, 'read');
  try {
    const { res } = await preparedChange(accountId, body, false, null);
    return { blocks: res.after, added: res.added, removed: res.removed, total: portCount(res.after), error: null };
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 409) {
      return { blocks: [], added: [], removed: [], total: 0, error: { code: err.code ?? 'conflict', message: err.message, details: err.details } };
    }
    throw err;
  }
}

/** PUT /accounts/:id/network/ports (platform admin; gated platform.port_allocation by the route). */
export async function setAllocation(actor: HostingActor, accountId: number, body: PortAllocationRequest): Promise<{ info: AccountPortsInfo; added: PortRange[]; removed: PortRange[]; overrideBefore: number | null }> {
  assertPlatformAdmin(actor);
  const row = await loadAccount(actor, accountId, 'accounts.manage');
  const before = await accountLite(db, row.id);
  const { res } = await preparedChange(row.id, body, true, actor.userId);
  if (res.added.length || res.removed.length) afterChange(row.id);
  return { info: await accountPortsInfo(actor, row.id), added: res.added, removed: res.removed, overrideBefore: before?.public_ports_override ?? null };
}

/** GET /system/network/ports (platform admin). */
export async function poolStatus(): Promise<PortPoolStatus> {
  const settings = await platformSettings.get();
  const pool = poolOf(settings);
  const node = await db('nodes').where({ is_local: true }).first('id') as { id: number } | undefined;
  const ip = node ? await sharedIpOf(Number(node.id)) : null;
  const reserved = ip ? await reservedForIp(ip, settings) : reservedRanges(reservedInputs(settings), 'shared');
  const inPool = reserved.map((r) => ({ ...r, from: Math.max(r.from, pool.from), to: Math.min(r.to, pool.to) })).filter((r) => r.from <= r.to);
  const usable = subtractRanges([pool], reserved);
  const live = ip ? await liveBlocksOf(db, ip.id) : [];
  const released = ip ? await barrierRanges(db, ip.id) : [];
  const free = freeIntervals(pool, reserved, live.map((r) => ({ from: Number(r.port_from), to: Number(r.port_to) })), released);
  const byAccount = new Map<number, PortRange[]>();
  for (const r of live) {
    const list = byAccount.get(Number(r.account_id)) ?? [];
    list.push({ from: Number(r.port_from), to: Number(r.port_to) });
    byAccount.set(Number(r.account_id), list);
  }
  const accounts = byAccount.size
    ? await db('hosting_accounts as a').join('plans as p', 'p.id', 'a.plan_id').whereIn('a.id', [...byAccount.keys()])
      .select('a.id', 'a.username', 'a.tenant_id', 'a.public_ports_override', 'p.limits') as Array<{ id: number; username: string; tenant_id: number; public_ports_override: number | null; limits: unknown }>
    : [];
  return {
    pool,
    extra: settings.network.reservedPorts ?? [],
    reserved: inPool,
    capacity: portCount(usable),
    allocated: portCount(intersectRanges(live.map((r) => ({ from: Number(r.port_from), to: Number(r.port_to) })), [pool])),
    free: portCount(free),
    largestFreeBlock: largestBlock(free),
    sharedIp: ip ? { id: ip.id, address: ip.address } : null,
    accounts: accounts.map((a) => {
      const blocks = mergeRanges(byAccount.get(Number(a.id)) ?? []);
      return { accountId: Number(a.id), username: a.username, tenantId: Number(a.tenant_id), blocks, total: portCount(blocks), target: targetOf(a).target };
    }).sort((x, y) => x.username.localeCompare(y.username)),
  };
}

// ── settings checks ──────────────────────────────────────────────────────────

/** 409 poolExcludesAllocations when the pool / extra reserved ports would exclude allocated ports. */
export async function assertPoolKeepsAllocations(pool: PortRange, extra: Array<number | PortRange>): Promise<void> {
  let live: Array<{ account_id: number; port_from: number; port_to: number; username: string }>;
  try {
    live = await db('port_allocations as p').join('hosting_accounts as a', 'a.id', 'p.account_id').whereNull('p.released_at')
      .select('p.account_id', 'p.port_from', 'p.port_to', 'a.username');
  } catch {
    return; // before migration 032
  }
  const holes = mergeRanges(extra.map((e) => (typeof e === 'number' ? { from: e, to: e } : e)));
  const bad = new Map<number, { username: string; ports: PortRange[] }>();
  for (const r of live) {
    const range = { from: Number(r.port_from), to: Number(r.port_to) };
    const outside = subtractRanges([range], [pool]);
    const reserved = intersectRanges([range], holes);
    const ports = mergeRanges([...outside, ...reserved]);
    if (!ports.length) continue;
    const e = bad.get(Number(r.account_id)) ?? { username: r.username, ports: [] };
    e.ports.push(...ports);
    bad.set(Number(r.account_id), e);
  }
  // Bindings on a dedicated IP (any port of it may be published): a new extra reserved port would unpublish them.
  if (holes.length) {
    const ded = await db('port_bindings as b').join('public_ips as i', 'i.id', 'b.public_ip_id').join('hosting_accounts as a', 'a.id', 'b.account_id')
      .where('i.kind', 'dedicated').select('b.account_id', 'b.public_port', 'a.username') as Array<{ account_id: number; public_port: number; username: string }>;
    for (const r of ded) {
      const port = Number(r.public_port);
      if (!holes.some((h) => port >= h.from && port <= h.to)) continue;
      const e = bad.get(Number(r.account_id)) ?? { username: r.username, ports: [] };
      e.ports.push({ from: port, to: port });
      bad.set(Number(r.account_id), e);
    }
  }
  if (bad.size) {
    const accounts = [...bad.entries()].map(([accountId, v]) => ({ accountId, username: v.username, ports: mergeRanges(v.ports).map(fmtRange) }));
    throw new AppError(409, `The new pool / reserved ports would exclude ports already allocated to ${accounts.map((a) => a.username).join(', ')}`, 'poolExcludesAllocations', { accounts });
  }
}

/** 400 when an edge stream port is allocated to an account or published. */
export async function assertStreamPortsFree(ports: number[]): Promise<void> {
  if (!ports.length) return;
  try {
    for (const p of ports) {
      const a = await db('port_allocations').whereNull('released_at').where('port_from', '<=', p).andWhere('port_to', '>=', p).first('id');
      const b = await db('port_bindings').where({ public_port: p }).first('id');
      if (a || b) throw new AppError(400, `Validation failed — edge: port ${p} is allocated to an account (public ports)`, 'validation');
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    // before migration 032
  }
}
