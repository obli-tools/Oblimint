import type { DbSiteLinkChange } from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { errText } from '../setup/docker';
import { reconcileDefaultDbLinks } from '../network/defaultLinks';

/**
 * After a change of the databases of an account (created, deleted, attached,
 * shared, detached): its default site → instance links follow at once when the
 * account is segmented (network/defaultLinks.ts), then a policy push is
 * requested. Never throws: the next push reconciles anyway. Returns what
 * changed (shown to the caller), [] for a legacy account or on error.
 */
export async function syncDatabaseLinks(accountId: number, reason: string): Promise<DbSiteLinkChange[]> {
  try {
    const account = await db('hosting_accounts').where({ id: accountId }).first('id', 'tenant_id', 'network_model', 'status') as
      { id: number; tenant_id: number; network_model: string; status: string } | undefined;
    if (!account || account.network_model !== 'segmented' || account.status === 'deleting') return [];
    const changes = await reconcileDefaultDbLinks([{ accountId: Number(account.id), tenantId: Number(account.tenant_id) }]);
    const { requestPolicySync } = await import('../network/sync');
    requestPolicySync(`databases:${reason}:${accountId}`);
    if (changes.length) logger.info({ accountId, reason, changes }, 'databases: default site → DB links follow the attachments');
    return changes;
  } catch (err) {
    logger.warn({ accountId, reason, err: errText(err) }, 'databases: default links not reconciled now (next policy push)');
    return [];
  }
}
