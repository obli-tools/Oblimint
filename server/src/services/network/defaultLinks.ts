import type { DbSiteLinkChange } from '@oblimint/shared';
import { db } from '../../db';
import { dbEnginePort } from './policy';

// ─────────────────────────────────────────────────────────────────────────────
// Default site → DB instance links (docs/P4b-PLAN.md §4.6). OWNED BY MODULE
// `segmentation`.
//
// P2 sites reached every DB instance of their account by TCP `db-<id>` (the
// databases UI still shows that host). The segment policy denies it unless a
// link allows it. Since migration 030 the databases may belong to a site
// (site_databases: one owner, shared with others); the default links follow:
//
//   a site has a REASON to reach an instance iff that instance holds a
//   database owned by / shared with the site, or a database shared across
//   the account (no owner). An empty instance gives no reason to anyone.
//
// One default link (origin 'migration', TCP engine port) per (site, instance)
// pair with a reason, created at the migration of a P1–P4 account (there,
// every pair: the ones without a reason pinned, preserveAll) and later by
// every policy push (new site / instance / database, attachment change).
// Migration 030 pins the default links that exist to an empty instance, so
// nothing reachable before 030 is cut.
// A pair that already has ANY site → instance link (enabled or not, another
// port, a user link) gets no new one. A default link whose site loses its
// last reason is DISABLED (never deleted), and enabled again when a reason
// comes back — unless it is PINNED: the user edited or disabled it
// (segments.service updateLink / deleteLink), or the 030 backfill kept it as
// it was. A pinned link, and every user / catalog link, is never touched.
// ─────────────────────────────────────────────────────────────────────────────

export const MIGRATION_LINK_DESCRIPTION = 'Migration P1–P4 : accès TCP du site à l\'instance de base de données';
export const DEFAULT_DB_LINK_DESCRIPTION = 'Accès TCP par défaut du site à l\'instance de base de données (db-<id>)';

export interface DefaultLinkAccount {
  accountId: number;
  tenantId: number;
}

// ── pure planner ─────────────────────────────────────────────────────────────

export interface DefaultLinkPlanInput {
  sites: ReadonlyArray<{ id: number; accountId: number }>;
  instances: ReadonlyArray<{ id: number; accountId: number; engine: string }>;
  databases: ReadonlyArray<{ id: number; instanceId: number }>;
  attachments: ReadonlyArray<{ siteId: number; databaseId: number; role: 'owner' | 'shared' }>;
  /** Existing site → db links of these accounts. */
  links: ReadonlyArray<{ id: number; accountId: number; siteId: number; instanceId: number; origin: string; enabled: boolean; pinned: boolean }>;
}

export interface DefaultLinkPlan {
  insert: Array<{ accountId: number; siteId: number; instanceId: number; port: number; pinned: boolean }>;
  enable: Array<{ linkId: number; siteId: number; instanceId: number }>;
  disable: Array<{ linkId: number; siteId: number; instanceId: number }>;
}

export interface DefaultLinkOptions {
  /**
   * The legacy → segmented migration: every site reached every instance
   * before — a missing pair WITHOUT a reason still gets its link, pinned (the
   * access of the account is kept as it was).
   */
  preserveAll?: boolean;
}

/** Reason of each (site, instance) pair: `reason(siteId, instanceId)`. */
export function siteInstanceReasons(input: Pick<DefaultLinkPlanInput, 'databases' | 'attachments'>): (siteId: number, instanceId: number) => boolean {
  const dbsOf = new Map<number, number[]>();
  for (const d of input.databases) {
    const list = dbsOf.get(Number(d.instanceId)) ?? [];
    list.push(Number(d.id));
    dbsOf.set(Number(d.instanceId), list);
  }
  const owned = new Set<number>();
  const ofSite = new Map<number, Set<number>>();
  for (const a of input.attachments) {
    if (a.role === 'owner') owned.add(Number(a.databaseId));
    const set = ofSite.get(Number(a.siteId)) ?? new Set<number>();
    set.add(Number(a.databaseId));
    ofSite.set(Number(a.siteId), set);
  }
  return (siteId, instanceId) => {
    const dbs = dbsOf.get(Number(instanceId)) ?? [];
    // An empty instance gives no reason: its first database brings them (account-wide: every site; owned: its sites).
    if (dbs.some((d) => !owned.has(d))) return true; // a database shared across the account
    const mine = ofSite.get(Number(siteId));
    return !!mine && dbs.some((d) => mine.has(d));
  };
}

/** What to insert / enable / disable so the default links follow the attachments (pure). */
export function planDefaultDbLinks(input: DefaultLinkPlanInput, opts: DefaultLinkOptions = {}): DefaultLinkPlan {
  const reason = siteInstanceReasons(input);
  const pairs = new Map<string, DefaultLinkPlanInput['links'][number][]>();
  for (const l of input.links) {
    const k = `${Number(l.accountId)}|${Number(l.siteId)}|${Number(l.instanceId)}`;
    const list = pairs.get(k) ?? [];
    list.push(l);
    pairs.set(k, list);
  }
  const instancesOf = new Map<number, Array<{ id: number; engine: string }>>();
  for (const i of input.instances) {
    const list = instancesOf.get(Number(i.accountId)) ?? [];
    list.push({ id: Number(i.id), engine: i.engine });
    instancesOf.set(Number(i.accountId), list);
  }
  const plan: DefaultLinkPlan = { insert: [], enable: [], disable: [] };
  for (const s of input.sites) {
    const accountId = Number(s.accountId);
    const siteId = Number(s.id);
    for (const inst of instancesOf.get(accountId) ?? []) {
      const port = dbEnginePort(inst.engine);
      if (port === null) continue;
      const wanted = reason(siteId, inst.id);
      const existing = pairs.get(`${accountId}|${siteId}|${inst.id}`) ?? [];
      if (!existing.length) {
        if (wanted || opts.preserveAll) plan.insert.push({ accountId, siteId, instanceId: inst.id, port, pinned: !wanted });
        continue;
      }
      for (const l of existing) {
        if (l.origin !== 'migration' || l.pinned) continue;
        if (wanted && !l.enabled) plan.enable.push({ linkId: Number(l.id), siteId, instanceId: inst.id });
        if (!wanted && l.enabled) plan.disable.push({ linkId: Number(l.id), siteId, instanceId: inst.id });
      }
    }
  }
  return plan;
}

// ── database side ────────────────────────────────────────────────────────────

/** The planner's input for these accounts, read now. */
export async function defaultLinkInput(accountIds: readonly number[]): Promise<DefaultLinkPlanInput> {
  const ids = [...new Set(accountIds.map(Number))];
  const [sites, instances, databases, attachments, links] = await Promise.all([
    db('sites').whereIn('account_id', ids).orderBy('id').select('id', 'account_id') as Promise<Array<{ id: number; account_id: number }>>,
    db('db_instances').whereIn('account_id', ids).orderBy('id').select('id', 'account_id', 'engine') as Promise<Array<{ id: number; account_id: number; engine: string }>>,
    db('db_databases').whereIn('account_id', ids).select('id', 'instance_id') as Promise<Array<{ id: number; instance_id: number }>>,
    db('site_databases').whereIn('account_id', ids).select('site_id', 'database_id', 'role') as Promise<Array<{ site_id: number; database_id: number; role: 'owner' | 'shared' }>>,
    db('network_links').whereIn('account_id', ids).andWhere({ source_kind: 'site', target_kind: 'db' })
      .select('id', 'account_id', 'source_id', 'target_id', 'origin', 'enabled', 'pinned') as
      Promise<Array<{ id: number; account_id: number; source_id: number; target_id: number; origin: string; enabled: boolean; pinned: boolean }>>,
  ]);
  return {
    sites: sites.map((s) => ({ id: Number(s.id), accountId: Number(s.account_id) })),
    instances: instances.map((i) => ({ id: Number(i.id), accountId: Number(i.account_id), engine: i.engine })),
    databases: databases.map((d) => ({ id: Number(d.id), instanceId: Number(d.instance_id) })),
    attachments: attachments.map((a) => ({ siteId: Number(a.site_id), databaseId: Number(a.database_id), role: a.role })),
    links: links.map((l) => ({
      id: Number(l.id), accountId: Number(l.account_id), siteId: Number(l.source_id), instanceId: Number(l.target_id),
      origin: l.origin, enabled: !!l.enabled, pinned: !!l.pinned,
    })),
  };
}

/**
 * Brings the default site → DB links of the given accounts in line with the
 * attachments (insert / enable / disable, see above). Returns what changed.
 * Throws on a DB error (callers decide).
 */
export async function reconcileDefaultDbLinks(
  accounts: readonly DefaultLinkAccount[], description = DEFAULT_DB_LINK_DESCRIPTION, opts: DefaultLinkOptions = {},
): Promise<DbSiteLinkChange[]> {
  const tenants = new Map<number, number>();
  for (const a of accounts) {
    if (Number.isInteger(a.accountId) && a.accountId > 0) tenants.set(Number(a.accountId), Number(a.tenantId));
  }
  if (!tenants.size) return [];
  const plan = planDefaultDbLinks(await defaultLinkInput([...tenants.keys()]), opts);
  const changes: DbSiteLinkChange[] = [];
  if (plan.insert.length) {
    const rows = plan.insert.map((p) => ({
      tenant_id: tenants.get(p.accountId), account_id: p.accountId,
      source_kind: 'site', source_id: p.siteId, source_service: null,
      target_kind: 'db', target_id: p.instanceId, target_service: null,
      protocol: 'tcp', port: p.port, origin: 'migration', enabled: true, pinned: p.pinned, description, status: 'pending',
    }));
    // The unique index (account, ends, protocol, port) makes a concurrent run a no-op.
    const inserted = await db('network_links').insert(rows).onConflict().ignore().returning(['id', 'source_id', 'target_id']) as
      Array<{ id: number; source_id: number; target_id: number }>;
    for (const r of inserted) changes.push({ siteId: Number(r.source_id), instanceId: Number(r.target_id), linkId: Number(r.id), change: 'created' });
  }
  // Conditional updates: a link the user pinned meanwhile is left alone.
  for (const [list, enabled] of [[plan.enable, true], [plan.disable, false]] as const) {
    for (const p of list) {
      const n = await db('network_links').where({ id: p.linkId, origin: 'migration', pinned: false, enabled: !enabled })
        .update({ enabled, status: 'pending', status_message: null, updated_at: db.fn.now() });
      if (n) changes.push({ siteId: p.siteId, instanceId: p.instanceId, linkId: p.linkId, change: enabled ? 'enabled' : 'disabled' });
    }
  }
  return changes;
}

/**
 * Policy push / account migration entry point: reconcileDefaultDbLinks,
 * returning how many links were created, enabled or disabled.
 */
export async function ensureDefaultDbLinks(
  accounts: readonly DefaultLinkAccount[], description = DEFAULT_DB_LINK_DESCRIPTION, opts: DefaultLinkOptions = {},
): Promise<number> {
  return (await reconcileDefaultDbLinks(accounts, description, opts)).length;
}

/** The segmented accounts (any status but 'deleting') of a node, for ensureDefaultDbLinks. */
export async function segmentedAccountsOfNode(nodeId: number): Promise<DefaultLinkAccount[]> {
  const rows = await db('hosting_accounts').where({ node_id: nodeId, network_model: 'segmented' }).whereNot('status', 'deleting')
    .select('id', 'tenant_id') as Array<{ id: number; tenant_id: number }>;
  return rows.map((r) => ({ accountId: Number(r.id), tenantId: Number(r.tenant_id) }));
}
