import type { AccountPassContext, AccountPassHook } from '../../docker/extensions';
import { logger } from '../../../utils/logger';
import { errText } from '../../setup/docker';
import { attachRelayToAccount, requestAccountRelay, requestRelayFiles } from './relaySync';

// ─────────────────────────────────────────────────────────────────────────────
// afterAccountPass hook 'mailRelay' (docs/P4-PLAN.md §7) — module
// outbound-security. Runs INSIDE the account lock: never calls
// withAccountLock / reconcileAccountNow, returns at once. The work (relay
// rows, msmtprc of the account's sites, relay files, attachment of the relay
// to the account network) is queued (relaySync). An account being deleted
// gets the relay DETACHED right away, so the teardown can remove its network,
// and the relay files rewritten (its site users disabled, account suspended).
// Rows gone afterwards (CASCADE) are dropped by the periodic rewrite of the
// outbound worker (outboundService.start, RELAY_FILES_MS).
// ─────────────────────────────────────────────────────────────────────────────

export const mailRelayReconcileHook: AccountPassHook = {
  async afterAccountPass(ctx: AccountPassContext): Promise<void> {
    const account = ctx.state.account;
    try {
      if (account.status === 'deleting') {
        requestRelayFiles();
        await attachRelayToAccount(ctx.docker, account.id, 'deleting');
        return;
      }
    } catch (err) {
      logger.warn({ err: errText(err), accountId: account.id }, 'relay not detached from the account network');
      return;
    }
    requestAccountRelay(account.id, 'reconcile');
  },
};
