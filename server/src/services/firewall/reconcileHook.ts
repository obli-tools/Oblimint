import { config } from '../../config';
import { logger } from '../../utils/logger';
import type { AccountPassContext, AccountPassHook } from '../docker/extensions';
import { inspectContainer, inspectNetwork } from '../docker/dockerOps';
import { hostdFor, type HostdClient } from '../hostd/client';
import { accountDbNetwork, accountNetwork, fileServerContainer } from '../hosting/naming';
import { errText } from '../setup/docker';
import { firewallService, requestSyncAllIfUncovered } from './firewall.service';
import { gatewaySpecFor } from './gatewaySpec';

// ─────────────────────────────────────────────────────────────────────────────
// Firewall ↔ account reconcile (module hostd-firewall, docs/P2-PLAN.md §7).
// Called once per reconcile pass, INSIDE the account lock (never call
// withAccountLock / reconcileAccountNow from here). Pushes the account's
// gateway (file server container IP on the account network, or null when
// stopped: hostd holds and asks for activation) and queues the nftables
// state (firewallService.requestSync). Returns quickly: one inspect, one
// hostd call.
// ─────────────────────────────────────────────────────────────────────────────

let hostdOf: (nodeId: number) => HostdClient = hostdFor;

/** Tests: replace the hostd client factory (null restores it). */
export function setReconcileHookHostdForTests(f: ((nodeId: number) => HostdClient) | null): void {
  hostdOf = f ?? hostdFor;
}

export const firewallReconcileHook: AccountPassHook = {
  async afterAccountPass(ctx: AccountPassContext): Promise<void> {
    const account = ctx.state.account;
    try {
      if (config.hosting.portGateway) {
        const info = account.filesrv_mode === 'off' ? null : await inspectContainer(ctx.docker, fileServerContainer(account.id));
        const spec = gatewaySpecFor(account, info);
        const hostd = hostdOf(account.node_id);
        if (spec) await hostd.setGateway(spec);
        else await hostd.removeGateway(account.id);
      }
    } catch (err) {
      // hostd down / port taken: the next pass retries; the account keeps its other services.
      logger.warn({ accountId: account.id, err: errText(err) }, 'firewall: gateway not pushed');
    }
    try {
      // A network this pass just created (account / account DB network) is
      // put under the egress filter right away (R-EGRESS), not at the next
      // periodic global push.
      const subnets: string[] = [];
      for (const name of [accountNetwork(account.id), accountDbNetwork(account.id)]) {
        const net = await inspectNetwork(ctx.docker, name);
        for (const c of net?.IPAM?.Config ?? []) if (c.Subnet) subnets.push(c.Subnet);
      }
      requestSyncAllIfUncovered(subnets);
    } catch (err) {
      logger.warn({ accountId: account.id, err: errText(err) }, 'firewall: account networks not inspected');
    }
    firewallService.requestSync(account.id, 'reconcile');
  },
};
