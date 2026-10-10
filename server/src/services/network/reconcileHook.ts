import { logger } from '../../utils/logger';
import type { AccountPassHook } from '../docker/extensions';
import { errText } from '../setup/docker';
import { db } from '../../db';
import { ensureDefaultDbLinks } from './defaultLinks';
import { migrateAccount } from './migration';
import { requestPolicySync } from './sync';

// Account reconcile hook of the segmentation module (docs/P4b-PLAN.md §4.6): INSIDE the account lock after
// each P1 pass (never withAccountLock, returns quickly: a few Docker inspects + DB rows, no wait). A legacy
// account is migrated ('legacy' → 'segmented': fabrics registered, 'migration' links site → DB of P2); a
// segmented one gets the default site → DB links of its new sites / instances (defaultLinks.ts) and a
// (debounced) policy push — the pass may have created / recreated containers.
// OWNED BY MODULE `segmentation`.

export const segmentReconcileHook: AccountPassHook = {
  async afterAccountPass({ state, docker }): Promise<void> {
    const accountId = state.account.id;
    try {
      const row = await db('hosting_accounts').where({ id: accountId }).first('network_model', 'status', 'tenant_id') as
        { network_model: string; status: string; tenant_id: number } | undefined;
      if (!row || row.status === 'deleting') return;
      if (row.network_model === 'segmented') {
        // New sites / instances keep the P2 TCP db-<id> access (default links, idempotent per pair).
        try {
          await ensureDefaultDbLinks([{ accountId, tenantId: Number(row.tenant_id) }]);
        } catch (err) {
          logger.warn({ accountId, err: errText(err) }, 'segments: default site → DB links not created (next push / pass)');
        }
        requestPolicySync(`reconcile:${accountId}`);
        return;
      }
      await migrateAccount(docker, accountId);
    } catch (err) {
      logger.warn({ accountId, err: errText(err) }, 'segments: reconcile hook failed');
    }
  },
};
