import type { Request } from 'express';
import ipaddr from 'ipaddr.js';
import type { DedicatedIpAssign, NetInterface, PublicIp, PublicIpCreate, PublicIpUpdate } from '@oblimint/shared';
import { MASTER_TENANT_ID } from '@oblimint/shared';
import { config } from '../../config';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import type { HostingActor } from '../hosting/access';
import { loadAccount } from '../hosting/access';
import { errText } from '../setup/docker';
import { segmentBackends } from './deps';
import { cidrsOverlap, parseCidr4 } from './ipv4';
import { assertPlatformAdmin } from './ports.service';
import { invalidateNodeAddresses, localOf, sharedIpOf, toPublicIp, type PublicIpRow } from './publicIps';

// ─────────────────────────────────────────────────────────────────────────────
// Dedicated public IPs (migration 032), platform admin only: declaration
// (address, interface, prefix, local address of a 1:1 NAT, managed /
// external), check, deletion, assignment to ONE account with its options
// (takeover of 80 / 443, outbound SNAT). hostd puts a managed address on its
// interface at the next publish push (PUT /v1/publish) and reports its state
// (public_ips.status). Changing the assignment while bindings use the IP is
// refused (ipInUse): the stacks must drop those ports first (redeploy).
// ─────────────────────────────────────────────────────────────────────────────

export function publicIpsQuery() {
  return db('public_ips as i').leftJoin('hosting_accounts as a', 'a.id', 'i.account_id')
    .select('i.*', 'a.username as account_username',
      db.raw('(SELECT COUNT(*) FROM port_bindings b WHERE b.public_ip_id = i.id) AS binding_count'));
}

async function rowById(id: number): Promise<PublicIpRow> {
  const row = await publicIpsQuery().where('i.id', id).first() as PublicIpRow | undefined;
  if (!row) throw new AppError(404, 'Public IP not found', 'notFound');
  return row;
}

function requestPush(reason: string): void {
  void import('./sync').then((m) => m.requestPolicySync(reason)).catch(() => undefined);
}

function dnsAccount(accountId: number, reason: string): void {
  void import('../dns/dns.service').then((m) => m.dnsService.accountChanged(accountId, reason)).catch((err) => logger.warn({ err: errText(err), accountId }, 'DNS of the account not regenerated'));
}

/** Refusal reason of an address for a dedicated IP (null = acceptable). */
export function addressProblem(address: string, opts: { pools: string[]; dockerSubnets: string[]; shared: string | null }): string | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address) || !ipaddr.IPv4.isValidFourPartDecimal(address)) return 'invalidAddress';
  const host = parseCidr4(`${address}/32`);
  // 0/8, loopback, link-local, multicast, 240/4 (+ broadcast): never a public address of the node.
  for (const r of NOT_UNICAST) {
    const c = parseCidr4(r);
    if (c && host && cidrsOverlap(c, host)) return 'addressNotUnicast';
  }
  if (opts.shared && opts.shared === address) return 'addressIsShared';
  for (const p of [...opts.pools, ...opts.dockerSubnets]) {
    const c = parseCidr4(p);
    if (c && host && cidrsOverlap(c, host)) return 'addressInDockerRange';
  }
  return null;
}

async function dockerSubnets(): Promise<string[]> {
  try {
    const b = segmentBackends();
    const { listDockerSubnets } = await import('./allocator');
    return (await listDockerSubnets(await b.docker(await b.localNode()))).flatMap((n) => n.subnets);
  } catch {
    return [];
  }
}

async function validateAddress(address: string, nodeId: number, label: string): Promise<void> {
  const shared = await sharedIpOf(nodeId);
  const problem = addressProblem(address, {
    pools: [config.hosting.fabricPool, config.hosting.appNetworkPool, config.hosting.platformPool].filter(Boolean),
    dockerSubnets: await dockerSubnets(),
    shared: shared ? localOf(shared) : null,
  });
  if (problem) throw new AppError(400, `${label}: ${problem}`, problem, { field: label });
  if (shared?.address === address) throw new AppError(400, `${label}: the shared IP of the node`, 'addressIsShared', { field: label });
}

const IFACE_RE = /^[a-zA-Z0-9_.@:-]{1,15}$/;
/** Interfaces of the node's containers / loopback: never the interface of a public address (hostd refuses them too). */
const INTERNAL_IFACE_RE = /^(lo|docker\d*|br-.*|omf\d+|omb\d+|omp-.*|veth.*)$/;

function checkIface(iface: string | null): void {
  if (!iface) return;
  if (!IFACE_RE.test(iface)) throw new AppError(400, 'Invalid interface name', 'validation');
  if (INTERNAL_IFACE_RE.test(iface)) throw new AppError(400, iface + ' is an internal interface (loopback, container bridge or veth)', 'interfaceInternal', { interface: iface });
}

/** 409 addressExists when an address is already declared on the node (as an address or a local address), except aside. */
async function assertAddressFree(nodeId: number, address: string, except: number | null): Promise<void> {
  const q = db('public_ips').where({ node_id: nodeId }).andWhere((w) => { w.where('address', address).orWhere('local_address', address); });
  if (except !== null) q.whereNot('id', except);
  if (await q.first('id')) throw new AppError(409, 'This address is already declared', 'addressExists', { address });
}
const NOT_UNICAST = ['0.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4', '240.0.0.0/4'];

export const publicIpsService = {
  async list(): Promise<PublicIp[]> {
    return (await publicIpsQuery().orderBy(['i.kind', 'i.address']) as PublicIpRow[]).map(toPublicIp);
  },

  async create(req: Request, actor: HostingActor, body: PublicIpCreate): Promise<PublicIp> {
    assertPlatformAdmin(actor);
    const node = await db('nodes').where({ is_local: true }).first('id') as { id: number } | undefined;
    if (!node) throw new AppError(500, 'No local node');
    const address = body.address.trim();
    await validateAddress(address, Number(node.id), 'address');
    const local = body.localAddress?.trim() || null;
    if (local) await validateAddress(local, Number(node.id), 'localAddress');
    const iface = body.interface?.trim() || null;
    checkIface(iface);
    const management = body.management ?? 'external';
    if (management === 'managed' && !iface) throw new AppError(400, 'A managed address needs an interface', 'interfaceRequired');
    if (await db('public_ips').where({ node_id: node.id }).andWhere((q) => { q.where('address', address).orWhere('local_address', address); if (local) q.orWhere('address', local).orWhere('local_address', local); }).first('id')) {
      throw new AppError(409, 'This address is already declared', 'addressExists');
    }
    const [row] = await db('public_ips').insert({
      node_id: node.id, address, local_address: local, prefix_len: body.prefixLen ?? 32, interface: iface, kind: 'dedicated', management,
      status: 'pending', description: body.description ?? null, created_by: actor.userId,
    }).returning('id') as Array<{ id: number }>;
    await auditService.logReqAs(req, MASTER_TENANT_ID, 'public_ip.create', { resourceType: 'public_ip', resourcePath: String(row.id), details: { address, localAddress: local, interface: iface, management } });
    invalidateNodeAddresses();
    requestPush('public-ip');
    return toPublicIp(await rowById(row.id));
  },

  async update(req: Request, actor: HostingActor, id: number, body: PublicIpUpdate): Promise<PublicIp> {
    assertPlatformAdmin(actor);
    const row = await rowById(id);
    if (row.kind !== 'dedicated') throw new AppError(409, 'The shared IP follows the platform settings (public IPv4)', 'sharedIpReadOnly');
    const patch: Record<string, unknown> = {};
    if (body.localAddress !== undefined) {
      const local = body.localAddress?.trim() || null;
      if (local) {
        await validateAddress(local, Number(row.node_id), 'localAddress');
        // Two rows with one local address: hostd would refuse the whole publication state of the node.
        if (local !== row.address) await assertAddressFree(Number(row.node_id), local, id);
      }
      patch.local_address = local;
    }
    if (body.interface !== undefined) {
      const iface = body.interface?.trim() || null;
      checkIface(iface);
      patch.interface = iface;
    }
    if (body.prefixLen !== undefined) patch.prefix_len = body.prefixLen;
    if (body.management !== undefined) patch.management = body.management;
    if (body.description !== undefined) patch.description = body.description;
    const next = { ...row, ...patch } as PublicIpRow;
    if (next.management === 'managed' && !next.interface) throw new AppError(400, 'A managed address needs an interface', 'interfaceRequired');
    if (Object.keys(patch).length) {
      await db('public_ips').where({ id }).update({ ...patch, status: 'pending', updated_at: db.fn.now() });
      await auditService.logReqAs(req, MASTER_TENANT_ID, 'public_ip.update', { resourceType: 'public_ip', resourcePath: String(id), details: { address: row.address, changes: patch } });
      invalidateNodeAddresses();
      requestPush('public-ip');
    }
    return toPublicIp(await rowById(id));
  },

  async remove(req: Request, actor: HostingActor, id: number): Promise<void> {
    assertPlatformAdmin(actor);
    const row = await rowById(id);
    if (row.kind !== 'dedicated') throw new AppError(409, 'The shared IP cannot be deleted', 'sharedIpReadOnly');
    if (row.account_id !== null) throw new AppError(409, 'Unassign the IP from its account first', 'ipAssigned', { accountId: row.account_id });
    if (Number(row.binding_count ?? 0) > 0) throw new AppError(409, 'Bindings still use this IP', 'ipInUse');
    await db('public_ips').where({ id }).delete();
    await auditService.logReqAs(req, MASTER_TENANT_ID, 'public_ip.delete', { resourceType: 'public_ip', resourcePath: String(id), details: { address: row.address } });
    invalidateNodeAddresses();
    // hostd removes a managed address it added at the next push (no longer in the state).
    requestPush('public-ip');
  },

  /** POST /system/network/public-ips/:id/check — push now, the status comes back from hostd. */
  async check(actor: HostingActor, id: number): Promise<PublicIp> {
    assertPlatformAdmin(actor);
    await rowById(id);
    const { syncPolicyNow } = await import('./sync');
    await syncPolicyNow('public-ip-check');
    return toPublicIp(await rowById(id));
  },

  async interfaces(): Promise<NetInterface[]> {
    const b = segmentBackends();
    const client = b.hostd(await b.localNode()) as { netInterfaces?: () => Promise<NetInterface[]> };
    if (typeof client.netInterfaces !== 'function') return [];
    try {
      return (await client.netInterfaces()).filter((i) => !INTERNAL_IFACE_RE.test(i.name));
    } catch (err) {
      throw new AppError(502, `hostd: ${errText(err)}`, 'hostdUnavailable');
    }
  },

  /**
   * PUT /accounts/:id/network/dedicated-ip. publicIpId null = unassign. Refused (409 ipInUse) while
   * bindings of the account use the IP that would leave it (or its 80 / 443 when the takeover goes).
   */
  async assign(req: Request, actor: HostingActor, accountId: number, body: DedicatedIpAssign): Promise<PublicIp | null> {
    assertPlatformAdmin(actor);
    const account = await loadAccount(actor, accountId, 'accounts.manage');
    if (account.status === 'deleting') throw new AppError(409, 'The account is being deleted', 'accountDeleting');
    const changes: Array<{ action: string; details: Record<string, unknown> }> = [];
    const result = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`publicip:account:${account.id}`]);
      const current = await trx('public_ips').where({ account_id: account.id }).forUpdate().first() as PublicIpRow | undefined;
      const bindingsOn = async (ipId: number, ports?: number[]) => {
        const q = trx('port_bindings').where({ public_ip_id: ipId, account_id: account.id });
        if (ports) q.whereIn('public_port', ports);
        return Number((await q.count({ n: '*' }).first() as { n: string | number } | undefined)?.n ?? 0);
      };
      if (body.publicIpId === null) {
        if (!current) return null;
        if (await bindingsOn(current.id)) throw new AppError(409, 'Bindings of the account use this IP: remove those ports from its applications first', 'ipInUse');
        await trx('public_ips').where({ id: current.id }).update({ account_id: null, tenant_id: null, takeover_web: false, snat_outbound: false, updated_at: trx.fn.now() });
        changes.push({ action: 'account.dedicated_ip_unassign', details: { address: current.address } });
        return null;
      }
      const target = await trx('public_ips').where({ id: body.publicIpId }).forUpdate().first() as PublicIpRow | undefined;
      if (!target || target.kind !== 'dedicated' || Number(target.node_id) !== Number(account.node_id)) throw new AppError(404, 'Public IP not found', 'notFound');
      if (target.account_id !== null && Number(target.account_id) !== account.id) throw new AppError(409, 'This IP is assigned to another account', 'ipTaken');
      if (current && current.id !== target.id) {
        if (await bindingsOn(current.id)) throw new AppError(409, 'Bindings of the account use its current IP: remove those ports first', 'ipInUse');
        await trx('public_ips').where({ id: current.id }).update({ account_id: null, tenant_id: null, takeover_web: false, snat_outbound: false, updated_at: trx.fn.now() });
        changes.push({ action: 'account.dedicated_ip_unassign', details: { address: current.address } });
      }
      const takeover = body.takeoverWeb ?? (current?.id === target.id ? !!target.takeover_web : false);
      const snat = body.snatOutbound ?? (current?.id === target.id ? !!target.snat_outbound : false);
      if (!takeover && target.takeover_web && Number(target.account_id) === account.id && await bindingsOn(target.id, [80, 443])) {
        throw new AppError(409, 'Bindings of the account use 80 / 443 of this IP: remove them first', 'ipInUse');
      }
      if (Number(target.account_id) !== account.id) changes.push({ action: 'account.dedicated_ip_assign', details: { address: target.address } });
      if (takeover !== !!target.takeover_web) changes.push({ action: 'account.ip_takeover_change', details: { address: target.address, takeoverWeb: takeover } });
      if (snat !== !!target.snat_outbound) changes.push({ action: 'account.ip_snat_change', details: { address: target.address, snatOutbound: snat } });
      await trx('public_ips').where({ id: target.id }).update({
        account_id: account.id, tenant_id: account.tenant_id, takeover_web: takeover, snat_outbound: snat, updated_at: trx.fn.now(),
      });
      return target.id;
    });
    for (const c of changes) {
      await auditService.logReqAs(req, account.tenant_id, c.action, { resourceType: 'account', resourcePath: String(account.id), details: { username: account.username, ...c.details } });
    }
    if (changes.length) {
      dnsAccount(account.id, 'dedicated-ip');
      requestPush(`dedicated-ip:${account.id}`);
      void import('../edge/edge.service').then((m) => m.edgeService.scheduleSync('dedicated ip')).catch(() => undefined);
    }
    return result === null ? null : toPublicIp(await rowById(result));
  },
};
