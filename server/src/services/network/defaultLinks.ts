import { db } from '../../db';
import { dbEnginePort } from './policy';

// ─────────────────────────────────────────────────────────────────────────────
// Default site → DB instance links (docs/P4b-PLAN.md §4.6). OWNED BY MODULE
// `segmentation`.
//
// P2 sites reached every DB instance of their account by TCP `db-<id>` (the
// databases UI still shows that host). The segment policy denies it unless a
// link allows it, so EVERY (site, instance) pair of a segmented account gets
// one link (origin 'migration', TCP engine port): at the migration of a P1–P4
// account, and later for each new site / new instance (reconcile hook, policy
// push). Idempotent per pair: a pair that already has ANY site → instance link
// (enabled or not, another port, a user link) is left alone, so a default
// link the user disabled or re-ported is never re-created. Deleting a default
// link disables it (segments.service deleteLink): the row is what remembers
// the user's choice.
// ─────────────────────────────────────────────────────────────────────────────

export const MIGRATION_LINK_DESCRIPTION = 'Migration P1–P4 : accès TCP du site à l\'instance de base de données';
export const DEFAULT_DB_LINK_DESCRIPTION = 'Accès TCP par défaut du site à l\'instance de base de données (db-<id>)';

export interface DefaultLinkAccount {
  accountId: number;
  tenantId: number;
}

/**
 * Inserts the missing default site → DB instance links of the given accounts.
 * Returns how many rows were inserted. Throws on a DB error (callers decide).
 */
export async function ensureDefaultDbLinks(accounts: readonly DefaultLinkAccount[], description = DEFAULT_DB_LINK_DESCRIPTION): Promise<number> {
  const tenants = new Map<number, number>();
  for (const a of accounts) {
    if (Number.isInteger(a.accountId) && a.accountId > 0) tenants.set(Number(a.accountId), Number(a.tenantId));
  }
  if (!tenants.size) return 0;
  const ids = [...tenants.keys()];
  const [sites, instances, existing] = await Promise.all([
    db('sites').whereIn('account_id', ids).orderBy('id').select('id', 'account_id') as Promise<Array<{ id: number; account_id: number }>>,
    db('db_instances').whereIn('account_id', ids).orderBy('id').select('id', 'account_id', 'engine') as Promise<Array<{ id: number; account_id: number; engine: string }>>,
    db('network_links').whereIn('account_id', ids).andWhere({ source_kind: 'site', target_kind: 'db' })
      .select('account_id', 'source_id', 'target_id') as Promise<Array<{ account_id: number; source_id: number; target_id: number }>>,
  ]);
  if (!sites.length || !instances.length) return 0;
  const have = new Set(existing.map((l) => `${Number(l.account_id)}|${Number(l.source_id)}|${Number(l.target_id)}`));
  const instancesOf = new Map<number, Array<{ id: number; engine: string }>>();
  for (const i of instances) {
    const list = instancesOf.get(Number(i.account_id)) ?? [];
    list.push({ id: Number(i.id), engine: i.engine });
    instancesOf.set(Number(i.account_id), list);
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const s of sites) {
    const accountId = Number(s.account_id);
    for (const inst of instancesOf.get(accountId) ?? []) {
      if (have.has(`${accountId}|${Number(s.id)}|${inst.id}`)) continue;
      const port = dbEnginePort(inst.engine);
      if (port === null) continue;
      rows.push({
        tenant_id: tenants.get(accountId), account_id: accountId,
        source_kind: 'site', source_id: Number(s.id), source_service: null,
        target_kind: 'db', target_id: inst.id, target_service: null,
        protocol: 'tcp', port, origin: 'migration', enabled: true, description, status: 'pending',
      });
    }
  }
  if (!rows.length) return 0;
  // The unique index (account, ends, protocol, port) makes a concurrent run a no-op.
  const inserted = await db('network_links').insert(rows).onConflict().ignore().returning('id');
  return inserted.length;
}

/** The segmented accounts (any status but 'deleting') of a node, for ensureDefaultDbLinks. */
export async function segmentedAccountsOfNode(nodeId: number): Promise<DefaultLinkAccount[]> {
  const rows = await db('hosting_accounts').where({ node_id: nodeId, network_model: 'segmented' }).whereNot('status', 'deleting')
    .select('id', 'tenant_id') as Array<{ id: number; tenant_id: number }>;
  return rows.map((r) => ({ accountId: Number(r.id), tenantId: Number(r.tenant_id) }));
}
