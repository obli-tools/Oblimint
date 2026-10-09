import { logger } from '../../utils/logger';
import type { AccountPassContext, AccountPassHook } from '../docker/extensions';
import { errText } from '../setup/docker';
import type { AccountWatchTarget } from './logic';
import { queueWatchSync } from './watch';

// ─────────────────────────────────────────────────────────────────────────────
// afterAccountPass hook (services/docker/extensions.ts): pushes the typed-path
// watch spec of every site of the account to hostd (setWatch), removes the
// watch of sites without typed paths, honours settings maintenance.typedWatcher.
// Runs INSIDE the account lock: never calls withAccountLock /
// reconcileAccountNow, never queries nor calls hostd here — it only hands the
// pass's account state to the debounced watch queue (watch.ts), which skips
// sites whose spec did not change since the last push.
// OWNED BY MODULE `supervised-quarantine`.
// ─────────────────────────────────────────────────────────────────────────────

/** The watch target of a reconcile pass's account state (pure). */
export function watchTargetFromState(state: AccountPassContext['state']): AccountWatchTarget {
  const a = state.account;
  return {
    accountId: Number(a.id),
    nodeId: Number(a.node_id),
    uid: Number(a.uid),
    gid: Number(a.gid),
    status: a.status,
    sites: state.sites.map((s) => ({
      siteId: Number(s.site.id),
      slug: s.site.slug,
      dataPaths: s.dataPaths.map((d) => ({ path: d.path, policy: d.policy, allowedExtensions: d.allowed_extensions })),
    })),
  };
}

export const quarantineReconcileHook: AccountPassHook = {
  async afterAccountPass(ctx: AccountPassContext): Promise<void> {
    try {
      queueWatchSync(ctx.state.account.id, 'reconcile', watchTargetFromState(ctx.state));
    } catch (err) {
      logger.warn({ accountId: ctx.state.account.id, err: errText(err) }, 'quarantine: watch sync not queued');
    }
  },
};
