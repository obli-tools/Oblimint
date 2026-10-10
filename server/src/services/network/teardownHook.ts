import { logger } from '../../utils/logger';
import type { AccountTeardownHook } from '../docker/extensions';
import { errText } from '../setup/docker';
import { releaseSubnets } from './allocator';
import { requestPolicySync } from './sync';

// Account teardown (docs/P4b-PLAN.md §4.6): releases the account's subnets (fabrics + stacks, kept an hour
// before reuse) and requests a policy push — the next observation no longer finds the account's fabrics, so
// its bridges and flows leave the hostd policy. Inside the account lock (never withAccountLock).
// A release failure never fails the destroy: a subnet left allocated only stays reserved (no flow, no
// access), and its row is dropped when the subnet is registered again (allocator). Logged instead.
// OWNED BY MODULE `segmentation`.

export const segmentTeardownHook: AccountTeardownHook = {
  async beforeNetworksRemoved({ accountId }): Promise<void> {
    try {
      await releaseSubnets({ accountId });
    } catch (err) {
      logger.warn({ accountId, err: errText(err) }, 'segments: subnets of the deleted account not released (kept reserved)');
    }
    requestPolicySync(`teardown:${accountId}`);
  },
};
