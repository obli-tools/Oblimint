import type { AccountPassContext, AccountPassHook } from '../docker/extensions';
import { logger } from '../../utils/logger';

// Account reconcile hook of the apps module (docs/P4b-PLAN.md §5.8): runs INSIDE the account lock after
// each P1 reconcile pass; must return quickly (queue work), never call withAccountLock. Converges the
// account's stacks with the account status (suspended / deleting → containers stopped; active → desired
// state). OWNED BY MODULE `apps-core`.
//
// Nothing is awaited here: the worker reconciles the account's stacks right after the pass (setImmediate),
// outside the account lock — app containers are EXTERNALLY_MANAGED_ROLES, the P1 planner never touches them.

export const appsReconcileHook: AccountPassHook = {
  async afterAccountPass(ctx: AccountPassContext): Promise<void> {
    try {
      const { appsWorker } = await import('./worker');
      appsWorker.requestAccount(ctx.state.account.id);
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, accountId: ctx.state.account.id }, 'apps: account reconcile not queued');
    }
  },
};
