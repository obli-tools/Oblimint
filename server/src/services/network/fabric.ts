import type Docker from 'dockerode';
import { db } from '../../db';
import type { NetworkCreateOptions } from '../docker/dockerOps';
import { accountDbNetwork, accountNetwork, P4B_LABELS } from '../hosting/naming';
import { allocateSubnet, listDockerSubnets } from './allocator';
import { segmentBackends } from './deps';

// Account fabrics (docs/P4b-PLAN.md §4.2). OWNED BY MODULE `segmentation`.
// Called by reconcile.service.ts when it creates oblimint-acct-<id> (front) / oblimint-acct-<id>-db (back)
// (and by segmentService.ensureAccountFabrics): a subnet allocated from config.hosting.fabricPool
// (network_subnets), the bridge name omf<id> / omb<id> (≤ 15 chars, the name hostd filters on) and the label
// oblimint.fabric=front|back. Throws on failure (pool exhausted, Docker / DB unreachable): reconcile then
// falls back to Docker's defaults (P1–P4 behaviour), the account works unfiltered by bridge name until the
// policy push observes the real bridge (br-<12 hex>).

/** Docker network name of an account fabric. */
export function fabricNetworkName(accountId: number, which: 'front' | 'back'): string {
  return which === 'front' ? accountNetwork(accountId) : accountDbNetwork(accountId);
}

/** Bridge interface name of an account fabric created by P4b (legacy networks keep br-<12 hex of the id>). */
export function fabricBridgeName(accountId: number, which: 'front' | 'back'): string {
  return `om${which === 'front' ? 'f' : 'b'}${accountId}`;
}

/** Bridge interface of an observed Docker network (explicit name option, else Docker's br-<12 hex of the id>). */
export function observedBridgeName(net: { Id?: string; Options?: Record<string, string> | null }): string | null {
  const explicit = net.Options?.['com.docker.network.bridge.name'];
  if (explicit) return explicit;
  return net.Id && net.Id.length >= 12 ? `br-${net.Id.slice(0, 12)}` : null;
}

async function dockerForAccount(accountId: number): Promise<Docker> {
  const row = await db('hosting_accounts').where({ id: accountId }).first('node_id') as { node_id: number } | undefined;
  const b = segmentBackends();
  return b.docker(row ? Number(row.node_id) : await b.localNode());
}

export async function fabricNetworkOptions(accountId: number, which: 'front' | 'back', docker?: Docker): Promise<NetworkCreateOptions> {
  if (!Number.isInteger(accountId) || accountId <= 0) throw new Error(`invalid account id ${accountId}`);
  const engine = docker ?? await dockerForAccount(accountId);
  const subnets = await listDockerSubnets(engine);
  const { cidr, gateway } = await allocateSubnet(fabricNetworkName(accountId, which), { pool: 'fabric', purpose: which, accountId }, subnets);
  return {
    subnet: cidr,
    gateway,
    bridgeName: fabricBridgeName(accountId, which),
    labels: { [P4B_LABELS.fabric]: which },
  };
}
