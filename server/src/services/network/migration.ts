import type Docker from 'dockerode';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { inspectNetwork } from '../docker/dockerOps';
import { errText } from '../setup/docker';
import { listDockerSubnets, registerSubnet } from './allocator';
import { fabricNetworkName } from './fabric';
import { parseCidr4 } from './ipv4';
import { ensureDefaultDbLinks, MIGRATION_LINK_DESCRIPTION } from './defaultLinks';
import { requestPolicySync } from './sync';

// ─────────────────────────────────────────────────────────────────────────────
// Migration of the P1–P4 topologies (docs/P4b-PLAN.md §4.6). Per account,
// idempotent, NO network recreation:
//   1. the existing fabrics are registered in network_subnets (pool fabric,
//      purpose front / back, their current Docker subnet as is);
//   2. one 'migration' link site → DB instance (TCP engine port) for EVERY
//      (site, instance) pair of the account: P2 sites reached every instance
//      by db-<id> (the sockets stay mounted, unchanged);
//   3. network_model = 'segmented', policy push requested.
// Sites / instances created afterwards get the same default link
// (defaultLinks.ts: reconcile hook + every policy push).
// On failure: network_error set, the account stays 'legacy' (unfiltered) and
// is retried at the next pass. Runs inside the account lock when called by the
// reconcile hook (never takes it itself); the admin route takes it.
// ─────────────────────────────────────────────────────────────────────────────

export type MigrationOutcome = 'segmented' | 'already' | 'skipped' | 'failed';

export { MIGRATION_LINK_DESCRIPTION };

/** Creates the missing 'migration' links of an account (site × DB instance). Returns how many were inserted. */
export async function createMigrationLinks(accountId: number, tenantId: number): Promise<number> {
  return ensureDefaultDbLinks([{ accountId, tenantId }], MIGRATION_LINK_DESCRIPTION);
}

/**
 * Migrates one legacy account. `docker` = the engine of the account's node.
 * Never throws (the outcome says what happened; failures land in network_error).
 */
export async function migrateAccount(docker: Docker, accountId: number): Promise<MigrationOutcome> {
  const row = await db('hosting_accounts').where({ id: accountId }).first('id', 'tenant_id', 'status', 'network_model') as
    { id: number; tenant_id: number; status: string; network_model: string } | undefined;
  if (!row || row.status === 'deleting') return 'skipped';
  if (row.network_model === 'segmented') return 'already';
  try {
    const front = await inspectNetwork(docker, fabricNetworkName(accountId, 'front'));
    const back = await inspectNetwork(docker, fabricNetworkName(accountId, 'back'));
    // Fabrics not created yet (new account: the reconcile pass creates them first).
    if (!front || !back) return 'skipped';
    const subnets = await listDockerSubnets(docker);
    for (const [net, which] of [[front, 'front'], [back, 'back']] as const) {
      const cidr = (net.IPAM?.Config ?? []).map((c) => c?.Subnet).find((s): s is string => typeof s === 'string' && parseCidr4(s) !== null);
      if (!cidr) throw new Error(`le réseau ${net.Name} n'a pas de sous-réseau IPv4`);
      await registerSubnet(net.Name, cidr, { pool: 'fabric', purpose: which, accountId }, subnets);
    }
    const links = await createMigrationLinks(accountId, Number(row.tenant_id));
    await db('hosting_accounts').where({ id: accountId, network_model: 'legacy' }).update({ network_model: 'segmented', network_error: null });
    logger.info({ accountId, links }, 'segments: account network migrated (segmented)');
    requestPolicySync(`migration:${accountId}`);
    return 'segmented';
  } catch (err) {
    const message = `Migration réseau impossible : ${errText(err)}`.slice(0, 1000);
    logger.warn({ accountId, err: errText(err) }, 'segments: account network migration failed (left legacy)');
    try {
      await db('hosting_accounts').where({ id: accountId }).update({ network_error: message });
    } catch { /* DB down: retried at the next pass */ }
    return 'failed';
  }
}
