import type { Knex } from 'knex';
import type { EffectivePublishedPort, EffectiveStackConfig, PortBinding, PortRange } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import type { HostdClient, HostdPublishReply, HostdPublishState } from '../hostd/client';
import type { HostingActor } from '../hosting/access';
import { platformSettings } from '../platformSettings';
import { errText } from '../setup/docker';
import { mergeRanges } from './portAllocator';
import { bindingsQuery, reservedForIp, toBinding, withPortPool, type BindingRowJoined } from './ports.service';
import { localOf, type PublicIpRow } from './publicIps';
import { buildPublishState, type BuiltPublish, type PublishIpInput } from './publish';
import { reservedReason } from './reservedPorts';
import type { SegmentModel } from './policy';

// ─────────────────────────────────────────────────────────────────────────────
// Publishing of app ports (migration 032):
//   - publishContextFor: what the compose validation needs to honour a
//     published host port (the account's blocks of the shared IP, its
//     dedicated IP, the reserved ports, the ports other stacks hold);
//   - reserveBindings: at deploy, before the containers are (re)created, the
//     stack's bindings become what its validated compose wants (under the
//     pool lock; UNIQUE (ip, proto, port) arbitrates two stacks), the
//     previous set restored when the deploy fails;
//   - publishPush: the hostd state built in the same pass as the segment
//     policy (sync.ts), the statuses of the bindings / public IPs written back.
// ─────────────────────────────────────────────────────────────────────────────

type Conn = Knex | Knex.Transaction;

export const PUBLISH_MARK = (() => {
  const raw = (process.env.OBLIMINT_PUBLISH_MARK ?? '').trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 0xffffffff ? n : 0x01000000;
})();

/** Validation input of a published port (compose/validate.ts ValidationInput.publishing). */
export interface PublishingContext {
  shared: { id: number; address: string; local: string; blocks: PortRange[] } | null;
  dedicated: { id: number; address: string; local: string; takeoverWeb: boolean } | null;
  /** Reason the port is reserved on that IP (null = free). */
  reserved: (kind: 'shared' | 'dedicated', port: number) => string | null;
  /** `${ipId}/${proto}/${port}` → holder (another stack). */
  taken: ReadonlyMap<string, { stackId: number; stackName: string; service: string }>;
}

export const takenKey = (ipId: number, protocol: string, port: number): string => `${ipId}/${protocol}/${port}`;

/** null = the account has neither blocks nor a dedicated IP (published ports keep being ignored). */
export async function publishContextFor(accountId: number, stackId: number | null, conn: Conn = db): Promise<PublishingContext | null> {
  let ips: PublicIpRow[];
  try {
    const acct = await conn('hosting_accounts').where({ id: accountId }).first('node_id') as { node_id: number } | undefined;
    if (!acct) return null;
    ips = await conn('public_ips').where({ node_id: acct.node_id }).andWhere((q) => { q.where('kind', 'shared').orWhere('account_id', accountId); }).select('*') as PublicIpRow[];
  } catch {
    return null; // before migration 032
  }
  const sharedRow = ips.find((i) => i.kind === 'shared') ?? null;
  const dedRow = ips.find((i) => i.kind === 'dedicated' && Number(i.account_id) === accountId) ?? null;
  const blocks = sharedRow
    ? mergeRanges((await conn('port_allocations').where({ public_ip_id: sharedRow.id, account_id: accountId }).whereNull('released_at')
      .select('port_from', 'port_to') as Array<{ port_from: number; port_to: number }>).map((r) => ({ from: Number(r.port_from), to: Number(r.port_to) })))
    : [];
  if (!blocks.length && !dedRow) return null;
  const settings = await platformSettings.getWith(conn);
  const resShared = sharedRow ? await reservedForIp(sharedRow, settings) : [];
  const resDed = dedRow ? await reservedForIp(dedRow, settings) : [];
  const ipIds = [sharedRow?.id, dedRow?.id].filter((x): x is number => typeof x === 'number');
  const takenRows = await conn('port_bindings as b').leftJoin('app_stacks as s', 's.id', 'b.stack_id').whereIn('b.public_ip_id', ipIds)
    .modify((q) => { if (stackId) q.whereNot('b.stack_id', stackId); })
    .select('b.public_ip_id', 'b.protocol', 'b.public_port', 'b.stack_id', 'b.service', 's.display_name') as Array<{ public_ip_id: number; protocol: string; public_port: number; stack_id: number | null; service: string | null; display_name: string | null }>;
  const taken = new Map<string, { stackId: number; stackName: string; service: string }>();
  for (const r of takenRows) taken.set(takenKey(Number(r.public_ip_id), r.protocol, Number(r.public_port)), { stackId: Number(r.stack_id ?? 0), stackName: r.display_name ?? `#${r.stack_id}`, service: r.service ?? '' });
  return {
    shared: sharedRow && blocks.length ? { id: sharedRow.id, address: sharedRow.address, local: localOf(sharedRow), blocks } : null,
    dedicated: dedRow ? { id: dedRow.id, address: dedRow.address, local: localOf(dedRow), takeoverWeb: !!dedRow.takeover_web } : null,
    reserved: (kind, port) => reservedReason(kind === 'shared' ? resShared : resDed, port),
    taken,
  };
}

interface DesiredBinding {
  service: string;
  publicIpId: number;
  protocol: 'tcp' | 'udp';
  port: number;
  targetPort: number;
}

export function desiredBindings(eff: Pick<EffectiveStackConfig, 'services'> | null): DesiredBinding[] {
  const out: DesiredBinding[] = [];
  for (const s of eff?.services ?? []) {
    for (const p of (s.publishedPorts ?? []) as EffectivePublishedPort[]) {
      out.push({ service: s.name, publicIpId: Number(p.publicIpId), protocol: p.protocol === 'udp' ? 'udp' : 'tcp', port: Number(p.port), targetPort: Number(p.targetPort) });
    }
  }
  return out;
}

const bkey = (b: { publicIpId: number; protocol: string; port: number }) => takenKey(b.publicIpId, b.protocol, b.port);

export interface BindingSnapshot {
  rows: Array<Record<string, unknown>>;
}

export interface ReserveResult {
  previous: BindingSnapshot;
  added: string[];
  removed: string[];
}

/**
 * Makes the stack's bindings what `eff` publishes (deploy, before the containers). Revalidated under the pool
 * lock: the port must still be in the account's blocks (shared) / the IP still the account's (dedicated); a port
 * another stack holds → 409 hostPortTaken. Bindings of the stack no longer wanted are deleted.
 */
export async function reserveBindings(stack: { id: number; account_id: number; tenant_id: number; node_id: number }, eff: Pick<EffectiveStackConfig, 'services'> | null): Promise<ReserveResult> {
  const desired = desiredBindings(eff);
  const existing = await db('port_bindings').where({ stack_id: stack.id }).select('*') as Array<Record<string, unknown>>;
  const result: ReserveResult = { previous: { rows: existing }, added: [], removed: [] };
  if (!desired.length && !existing.length) return result;
  const shared = await db('public_ips').where({ node_id: stack.node_id, kind: 'shared' }).first('id') as { id: number } | undefined;
  const run = async (trx: Knex.Transaction) => {
    // withPortPool replays run on a race: the lists describe the attempt that commits.
    result.added = [];
    result.removed = [];
    const cur = await trx('port_bindings').where({ stack_id: stack.id }).select('*') as Array<{ id: number; public_ip_id: number; protocol: string; public_port: number; service: string; container_port: number }>;
    const want = new Map(desired.map((d) => [bkey(d), d]));
    const have = new Map(cur.map((c) => [takenKey(Number(c.public_ip_id), c.protocol, Number(c.public_port)), c]));
    for (const [k, c] of have) {
      const d = want.get(k);
      if (!d) {
        await trx('port_bindings').where({ id: c.id }).delete();
        result.removed.push(k);
      } else if (d.service !== c.service || d.targetPort !== Number(c.container_port)) {
        await trx('port_bindings').where({ id: c.id }).update({ service: d.service, container_port: d.targetPort, status: 'pending', status_message: null, updated_at: trx.fn.now() });
      }
    }
    // FOR SHARE: serialized with the FOR UPDATE of the (un)assignment of a dedicated IP (publicIps.service
    // assign): an unassign never counts 0 binding while this deploy inserts one on the IP that leaves.
    const ips = new Map((await trx('public_ips').whereIn('id', [...new Set(desired.map((d) => d.publicIpId))]).forShare().select('*') as PublicIpRow[]).map((r) => [Number(r.id), r]));
    const blocks = shared
      ? (await trx('port_allocations').where({ public_ip_id: shared.id, account_id: stack.account_id }).whereNull('released_at').select('port_from', 'port_to') as Array<{ port_from: number; port_to: number }>)
      : [];
    for (const [k, d] of want) {
      if (have.has(k)) continue;
      const ip = ips.get(d.publicIpId);
      if (!ip) throw new AppError(409, `Port ${d.port}/${d.protocol}: unknown public IP`, 'hostIpNotAvailable', { port: d.port });
      if (ip.kind === 'shared' && !blocks.some((b) => d.port >= Number(b.port_from) && d.port <= Number(b.port_to))) {
        throw new AppError(409, `Port ${d.port}/${d.protocol} is no longer allocated to the account`, 'hostPortNotAllocated', { port: d.port, protocol: d.protocol });
      }
      if (ip.kind === 'dedicated' && Number(ip.account_id) !== stack.account_id) {
        throw new AppError(409, `The IP ${ip.address} is no longer assigned to the account`, 'hostIpNotAvailable', { port: d.port });
      }
      const holder = await trx('port_bindings').where({ public_ip_id: d.publicIpId, protocol: d.protocol, public_port: d.port }).first('stack_id') as { stack_id: number } | undefined;
      if (holder) throw new AppError(409, `Port ${d.port}/${d.protocol} is already published by another application`, 'hostPortTaken', { port: d.port, stackId: holder.stack_id });
      await trx('port_bindings').insert({
        tenant_id: stack.tenant_id, account_id: stack.account_id, node_id: stack.node_id, public_ip_id: d.publicIpId, protocol: d.protocol,
        public_port: d.port, target_kind: 'app', stack_id: stack.id, service: d.service, container_port: d.targetPort, status: 'pending',
      });
      result.added.push(k);
    }
  };
  if (shared) await withPortPool(Number(stack.node_id), Number(shared.id), run);
  else await db.transaction(run);
  return result;
}

/**
 * Puts the stack's bindings back as they were (a failed deploy), under the pool lock, revalidated: a row whose
 * dedicated IP left the account, or whose shared port left the account's blocks meanwhile, is not put back
 * (it follows the next deploy). Never throws.
 */
export async function restoreBindings(stackId: number, snap: BindingSnapshot): Promise<void> {
  try {
    const run = async (trx: Knex.Transaction) => {
      await trx('port_bindings').where({ stack_id: stackId }).delete();
      if (!snap.rows.length) return;
      const ipIds = [...new Set(snap.rows.map((r) => Number(r.public_ip_id)))];
      const ips = new Map((await trx('public_ips').whereIn('id', ipIds).forShare().select('*') as PublicIpRow[]).map((r) => [Number(r.id), r]));
      const blocksOf = new Map<string, Array<{ port_from: number; port_to: number }>>();
      for (const r of snap.rows) {
        const { id: _id, ...rest } = r as Record<string, unknown> & { id: number };
        const ip = ips.get(Number(r.public_ip_id));
        const accountId = Number(r.account_id);
        const port = Number(r.public_port);
        if (!ip) continue;
        if (ip.kind === 'dedicated' && Number(ip.account_id) !== accountId) continue;
        if (ip.kind === 'shared') {
          const k = `${ip.id}:${accountId}`;
          let blocks = blocksOf.get(k);
          if (!blocks) {
            blocks = await trx('port_allocations').where({ public_ip_id: ip.id, account_id: accountId }).whereNull('released_at').select('port_from', 'port_to') as Array<{ port_from: number; port_to: number }>;
            blocksOf.set(k, blocks);
          }
          if (!blocks.some((b) => port >= Number(b.port_from) && port <= Number(b.port_to))) continue;
        }
        await trx('port_bindings').insert(rest).onConflict(['public_ip_id', 'protocol', 'public_port']).ignore();
      }
    };
    const first = snap.rows[0] as { node_id?: number } | undefined;
    const shared = first ? await db('public_ips').where({ node_id: Number(first.node_id), kind: 'shared' }).first('id') as { id: number } | undefined : undefined;
    if (first && shared) await withPortPool(Number(first.node_id), Number(shared.id), run);
    else await db.transaction(run);
  } catch (err) {
    logger.warn({ stackId, err: errText(err) }, 'publish: bindings of the failed deploy not restored (they follow the next deploy)');
  }
}

/** Bindings of a stack for the actor (GET /apps/stacks/:id/bindings; the caller checked the stack). */
export async function stackBindings(stackId: number): Promise<PortBinding[]> {
  return (await bindingsQuery().where('b.stack_id', stackId).orderBy(['b.service', 'b.public_port', 'b.protocol']) as BindingRowJoined[]).map(toBinding);
}

/** Read-only view of the account's ports for an access key / MCP (no internal address). */
export async function keyNetworkView(actor: HostingActor, accountId: number) {
  const { accountPortsInfo } = await import('./ports.service');
  const info = await accountPortsInfo(actor, accountId);
  return {
    accountId: info.accountId,
    target: info.target,
    allocated: info.allocated,
    blocks: info.blocks.map((b) => ({ from: b.from, to: b.to })),
    sharedIp: info.sharedIp?.address ?? null,
    dedicatedIp: info.dedicatedIp ? { address: info.dedicatedIp.address, takeoverWeb: info.dedicatedIp.takeoverWeb } : null,
    bindings: info.bindings.map((b) => ({
      stackId: b.stackId, stack: b.stackName, service: b.service, address: b.address, port: b.publicPort, protocol: b.protocol,
      containerPort: b.containerPort, status: b.status,
    })),
  };
}

// ── push (sync.ts) ───────────────────────────────────────────────────────────

interface PublishPushStatus {
  lastPushAt: Date | null;
  lastPushError: string | null;
  lastState: HostdPublishState | null;
  lastReply: HostdPublishReply | null;
}

const pushState: PublishPushStatus = { lastPushAt: null, lastPushError: null, lastState: null, lastReply: null };

export function publishPushStatus(): Readonly<PublishPushStatus> {
  return pushState;
}

export function resetPublishPushForTests(): void {
  pushState.lastPushAt = null;
  pushState.lastPushError = null;
  pushState.lastState = null;
  pushState.lastReply = null;
}

/**
 * Is there anything to publish / any IP to manage on the node? A node without either skips the push, but only
 * once a push succeeded since this process started: hostd re-applies its persisted state at boot, so after a
 * panel restart the (possibly empty) state is pushed once — a binding / IP removed while hostd was unreachable
 * never stays in force, and the reuse barrier of released ports gets its push time.
 */
export async function publishNeeded(nodeId: number): Promise<boolean> {
  try {
    const ip = await db('public_ips').where({ node_id: nodeId, kind: 'dedicated' }).first('id');
    const b = await db('port_bindings').where({ node_id: nodeId }).first('id');
    if (ip || b || pushState.lastPushAt === null) return true;
    const last = pushState.lastState;
    return last !== null && (last.rules.length > 0 || last.addresses.length > 0 || last.snat.length > 0);
  } catch {
    return false;
  }
}

/** An empty state refused by a hostd without /v1/publish (older image): nothing is published there, a success. */
function olderHostdWithNothingToPublish(err: unknown, state: HostdPublishState): boolean {
  const st = Number((err as { status?: number })?.status);
  return (st === 404 || st === 405 || st === 501) && !state.rules.length && !state.addresses.length && !state.snat.length && !state.dedicated.length;
}

/** Inputs of buildPublishState for the observed model. */
export async function loadPublishInputs(nodeId: number, model: SegmentModel | null): Promise<Parameters<typeof buildPublishState>[0]> {
  const ipRows = await db('public_ips').where({ node_id: nodeId }).select('*') as PublicIpRow[];
  const bindings = await db('port_bindings').where({ node_id: nodeId }).select('*') as Array<{
    id: number; account_id: number; public_ip_id: number; protocol: 'tcp' | 'udp'; public_port: number; target_kind: string; stack_id: number | null; service: string | null; container_port: number;
  }>;
  const accountIds = [...new Set([...bindings.map((b) => Number(b.account_id)), ...ipRows.filter((i) => i.account_id !== null).map((i) => Number(i.account_id))])];
  const accounts = accountIds.length
    ? await db('hosting_accounts').whereIn('id', accountIds).select('id', 'status', 'network_model') as Array<{ id: number; status: string; network_model: string }>
    : [];
  const shared = ipRows.find((i) => i.kind === 'shared');
  const blocks = new Map<number, PortRange[]>();
  if (shared) {
    for (const r of await db('port_allocations').where({ public_ip_id: shared.id }).whereNull('released_at').select('account_id', 'port_from', 'port_to') as Array<{ account_id: number; port_from: number; port_to: number }>) {
      const l = blocks.get(Number(r.account_id)) ?? [];
      l.push({ from: Number(r.port_from), to: Number(r.port_to) });
      blocks.set(Number(r.account_id), l);
    }
  }
  const allocated = new Map<string, Map<string, string>>();
  for (const r of await db('network_addresses').where({ node_id: nodeId }).whereNull('released_at').select('network_name', 'container_name', 'ip') as Array<{ network_name: string; container_name: string; ip: string }>) {
    let m = allocated.get(r.network_name);
    if (!m) { m = new Map(); allocated.set(r.network_name, m); }
    m.set(r.container_name, r.ip);
  }
  const snatAccounts = ipRows.filter((i) => i.kind === 'dedicated' && i.account_id !== null && i.snat_outbound).map((i) => Number(i.account_id));
  const subnets = new Map<number, string[]>();
  if (snatAccounts.length) {
    const rows = await db('network_subnets').whereIn('account_id', snatAccounts).whereNull('released_at').select('account_id', 'cidr') as Array<{ account_id: number; cidr: string }>;
    for (const r of rows) {
      const l = subnets.get(Number(r.account_id)) ?? [];
      l.push(r.cidr);
      subnets.set(Number(r.account_id), l);
    }
  }
  const settings = await platformSettings.get();
  const reservedCache = new Map<number, Awaited<ReturnType<typeof reservedForIp>>>();
  for (const ip of ipRows) reservedCache.set(Number(ip.id), await reservedForIp(ip, settings));
  let defaultIface: string | null = null;
  try {
    const { segmentBackends } = await import('./deps');
    const c = segmentBackends().hostd(nodeId) as Partial<HostdClient>;
    if (typeof c.netInterfaces === 'function') defaultIface = (await c.netInterfaces()).find((i) => i.defaultRoute)?.name ?? null;
  } catch { /* unknown: SNAT on the declared interface */ }
  const ips: PublishIpInput[] = ipRows.map((r) => ({
    id: Number(r.id), kind: r.kind, address: r.address, localAddress: r.local_address ?? null, prefixLen: Number(r.prefix_len) || 32,
    iface: r.interface ?? null, management: r.management, accountId: r.account_id === null ? null : Number(r.account_id),
    takeoverWeb: r.account_id !== null && !!r.takeover_web, snatOutbound: r.account_id !== null && !!r.snat_outbound,
  }));
  return {
    model,
    allocated,
    bindings: bindings.map((b) => ({
      id: Number(b.id), accountId: Number(b.account_id), publicIpId: Number(b.public_ip_id), protocol: b.protocol, publicPort: Number(b.public_port),
      targetKind: b.target_kind, stackId: b.stack_id === null ? null : Number(b.stack_id), service: b.service, containerPort: Number(b.container_port),
    })),
    publicIps: ips,
    accounts: new Map(accounts.map((a) => [Number(a.id), { id: Number(a.id), status: a.status, networkModel: a.network_model }])),
    blocks,
    reserved: (ip, port) => reservedReason(reservedCache.get(ip.id) ?? [], port),
    subnets,
    defaultIface,
    mark: PUBLISH_MARK,
  };
}

const SKIP_MESSAGES: Record<string, string> = { targetOutsideFront: 'targetOutsideFront', portInUseOnHost: 'portInUseOnHost' };

/**
 * Builds and pushes the publication state of the node (called by sync.ts after the segment push, same
 * observation). Returns the accounts whose bindings changed status. Throws on a hostd / DB error (the caller
 * records it; hostd keeps its last tables).
 */
export async function pushPublish(nodeId: number, hostd: Partial<HostdClient>, model: SegmentModel | null, now: Date): Promise<{ built: BuiltPublish; changedAccounts: Map<number, number> }> {
  const inputs = await loadPublishInputs(nodeId, model);
  const built = buildPublishState(inputs);
  if (typeof hostd.setPublish !== 'function') throw new Error('hostd client without publish support');
  let reply: HostdPublishReply;
  try {
    reply = await hostd.setPublish(built.state);
  } catch (err) {
    if (!olderHostdWithNothingToPublish(err, built.state)) {
      pushState.lastPushError = errText(err).slice(0, 500);
      throw err;
    }
    reply = { ok: true, addresses: [], skipped: [] };
  }
  pushState.lastPushAt = now;
  pushState.lastPushError = null;
  pushState.lastState = built.state;
  pushState.lastReply = reply;
  for (const s of reply?.skipped ?? []) {
    if (built.results.has(Number(s.id))) built.results.set(Number(s.id), { status: 'error', message: SKIP_MESSAGES[s.reason] ?? s.reason });
  }
  const changedAccounts = await writeStatuses(inputs, built, reply);
  return { built, changedAccounts };
}

async function writeStatuses(inputs: Parameters<typeof buildPublishState>[0], built: BuiltPublish, reply: HostdPublishReply): Promise<Map<number, number>> {
  const changed = new Map<number, number>();
  const rows = await db('port_bindings').whereIn('id', [...built.results.keys()]).select('id', 'account_id', 'tenant_id', 'status', 'status_message') as Array<{ id: number; account_id: number; tenant_id: number; status: string; status_message: string | null }>;
  for (const r of rows) {
    const next = built.results.get(Number(r.id));
    if (!next || (r.status === next.status && (r.status_message ?? null) === next.message)) continue;
    await db('port_bindings').where({ id: r.id }).update({ status: next.status, status_message: next.message, updated_at: db.fn.now() });
    changed.set(Number(r.account_id), Number(r.tenant_id));
  }
  // Public IP statuses from hostd (dedicated ones; the shared IP may sit behind a 1:1 NAT).
  const byLocal = new Map((reply?.addresses ?? []).map((a) => [a.address, a]));
  for (const ip of inputs.publicIps) {
    if (ip.kind !== 'dedicated') continue;
    const a = byLocal.get(ip.localAddress || ip.address);
    const warning = built.ipWarnings.get(ip.id) ?? null;
    let status: 'active' | 'missing' | 'error' | 'pending' = 'pending';
    let message: string | null = warning;
    if (a) {
      if (a.state === 'present' || a.state === 'added') status = 'active';
      else if (a.state === 'missing') status = 'missing';
      else { status = 'error'; message = a.message ? `${a.state}: ${a.message}`.slice(0, 500) : a.state; }
    }
    await db('public_ips').where({ id: ip.id }).andWhere((q) => { q.whereNot('status', status).orWhereRaw('status_message IS DISTINCT FROM ?', [message]); })
      .update({ status, status_message: message, checked_at: db.fn.now() });
    await db('public_ips').where({ id: ip.id }).update({ checked_at: db.fn.now() });
  }
  return changed;
}
