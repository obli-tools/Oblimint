import type { DashboardSummary } from '@oblimint/shared';
import { isMasterTenant } from '@oblimint/shared';
import { db } from '../db';

const count = async (q: any): Promise<number> => Number(((await q.count('* as c').first()) as { c?: unknown } | undefined)?.c ?? 0);

export const dashboardService = {
  /**
   * DashboardSummary for the caller's tenant. The hosting objects (accounts,
   * sites, domains, mailboxes, databases) arrive in P1+: 0 for now.
   * `tenants` / `nodes`: platform-wide in the god view (platform admin on the
   * master tenant), else 1 / the local node. `users`: every account in the
   * god view, else the members of the tenant.
   */
  async summary(tenantId: number, globalView: boolean): Promise<DashboardSummary> {
    const god = globalView && isMasterTenant(tenantId);
    const [tenants, users, nodes] = await Promise.all([
      god ? count(db('tenants')) : Promise.resolve(1),
      god ? count(db('users')) : count(db('user_tenants').where({ tenant_id: tenantId })),
      count(db('nodes')),
    ]);
    return { accounts: 0, sites: 0, domains: 0, mailboxes: 0, databases: 0, tenants, users, nodes };
  },

  /** Platform-wide counters (Obligate dashboard-stats). */
  async platformCounters(): Promise<{ accounts: number; sites: number; tenants: number }> {
    return { accounts: 0, sites: 0, tenants: await count(db('tenants')) };
  },
};
