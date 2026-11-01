import { logger } from '../../utils/logger';
import type { AccountTeardownHook } from '../docker/extensions';
import { errText } from '../setup/docker';
import { releaseAddresses } from './addresses';
import { releaseSubnets } from './allocator';
import { releaseAccountPorts } from './ports.service';
import { requestPolicySync, syncPolicyNow } from './sync';

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
    // Migration 031: the fixed addresses on its fabrics (reusable once a policy push followed the release).
    try {
      await releaseAddresses({ accountId });
    } catch (err) {
      logger.warn({ accountId, err: errText(err) }, 'segments: addresses of the deleted account not released (GC later)');
    }
    // Migration 032: its port blocks released, its dedicated IP detached (kept declared), its bindings gone; the
    // publish push runs now (bounded wait) so no DNAT outlives the account.
    await releaseAccountPorts(accountId);
    try {
      await Promise.race([syncPolicyNow(`teardown:${accountId}`), new Promise((r) => setTimeout(r, 15_000).unref?.())]);
    } catch (err) {
      logger.warn({ accountId, err: errText(err) }, 'segments: push after the teardown failed (retried)');
      requestPolicySync(`teardown:${accountId}`);
    }
  },
};
