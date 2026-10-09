import type { DashboardSummary } from '@oblimint/shared';
import { db } from '../db';
import { actorHasNeedSomewhere, scopeToActor, type HostingActor } from './hosting/access';

const count = async (q: any): Promise<number> => Number(((await q.count('* as c').first()) as { c?: unknown } | undefined)?.c ?? 0);

export const dashboardService = {
  /**
   * DashboardSummary scoped to the caller (services/hosting/access.ts):
   *   - platform admin on the master tenant (god view): every tenant;
   *   - tenant staff: the tenant's objects, 1 tenant, its members, the nodes;
   *   - client: its own accounts / sites / domains only (tenants, users,
   *     nodes are not theirs to know: 0).
   * databases = database instances visible to the caller (P2, module usage);
   * mailboxes arrive with P4: 0.
   */
  async summary(actor: HostingActor): Promise<DashboardSummary> {
    // Staff without 'read' (no hosting capability, no overview.read — §8)
    // see no hosting object: 0, like the lists answer 403.
    const canRead = actor.kind === 'client' || actorHasNeedSomewhere(actor, 'read');
    const scoped = (table: string, alias: string, accountCol: string) => !canRead ? Promise.resolve(0) :
      count(scopeToActor(actor, db(`${table} as ${alias}`), { tenant: `${alias}.tenant_id`, account: `${alias}.${accountCol}` }));
    const [accounts, sites, domains, databases] = await Promise.all([
      scoped('hosting_accounts', 'a', 'id'),
      scoped('sites', 's', 'account_id'),
      scoped('domains', 'd', 'account_id'),
      scoped('db_instances', 'i', 'account_id'),
    ]);
    if (actor.kind === 'client') {
      return { accounts, sites, domains, mailboxes: 0, databases, tenants: 0, users: 0, nodes: 0 };
    }
    const god = actor.globalView;
    const [tenants, users, nodes] = await Promise.all([
      god ? count(db('tenants')) : Promise.resolve(1),
      god ? count(db('users')) : count(db('user_tenants').where({ tenant_id: actor.tenantId })),
      count(db('nodes')),
    ]);
    return { accounts, sites, domains, mailboxes: 0, databases, tenants, users, nodes };
  },

  /** Platform-wide counters (Obligate dashboard-stats). */
  async platformCounters(): Promise<{ accounts: number; sites: number; tenants: number }> {
    const [accounts, sites, tenants] = await Promise.all([count(db('hosting_accounts')), count(db('sites')), count(db('tenants'))]);
    return { accounts, sites, tenants };
  },
};
