import { logger } from '../../utils/logger';
import { connectNetwork, attachWithAlias, createNetwork, inspectContainer, inspectNetwork, isNotFound } from '../docker/dockerOps';
import { engineFor, localNodeId } from '../docker/engine';
import { EDGE_CONTAINER, LABELS, MAIL_NETWORK, PANEL_ALIAS } from '../hosting/naming';
import { errText, selfContainerRef } from '../setup/docker';

// ─────────────────────────────────────────────────────────────────────────────
// Mail network (docs/P4-PLAN.md §4) — module mail-core. Engines, relay and
// webmail call ensureMailNetwork from their ensure(); the sync loop re-checks
// it at every full pass.
//
// ensureMailNetwork: creates MAIL_NETWORK ('oblimint-mail', label
// oblimint.internal, NEVER oblimint.account: the edge attaches itself to
// account networks by label), then attaches the panel container (alias
// PANEL_ALIAS, internal hooks of the webmail) and the edge container (webmail
// vhosts) to it. Idempotent; serialized in-process (engine, relay and webmail
// may call it at the same time); throws when Docker is unreachable. A panel
// not running in a container (dev) or an edge not deployed yet is logged and
// skipped (infraService.ensureEdge attaches the edge when it is deployed).
// ─────────────────────────────────────────────────────────────────────────────

let chain: Promise<unknown> = Promise.resolve();

export function ensureMailNetwork(log: (line: string) => void): Promise<void> {
  const run = chain.then(() => doEnsure(log), () => doEnsure(log));
  chain = run.catch(() => undefined);
  return run;
}

async function doEnsure(log: (line: string) => void): Promise<void> {
  const docker = await engineFor(await localNodeId());
  const existing = await inspectNetwork(docker, MAIL_NETWORK);
  if (!existing) {
    await createNetwork(docker, MAIL_NETWORK, { [LABELS.internal]: 'true' });
    log(`Network ${MAIL_NETWORK} created`);
  } else if (existing.Labels?.[LABELS.account] !== undefined) {
    // Never an account network: refuse to put the panel / mail containers on it.
    throw new Error(`Network ${MAIL_NETWORK} carries the ${LABELS.account} label: remove it by hand (docker network rm ${MAIL_NETWORK})`);
  }

  const self = selfContainerRef();
  if (self) {
    try {
      await attachWithAlias(docker, MAIL_NETWORK, self, PANEL_ALIAS, log);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      log(`Panel container ${self} not found: not attached to ${MAIL_NETWORK} (panel outside Docker?)`);
    }
  }

  try {
    if (await connectNetwork(docker, MAIL_NETWORK, EDGE_CONTAINER)) log(`${EDGE_CONTAINER} attached to ${MAIL_NETWORK}`);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    log(`${EDGE_CONTAINER} not deployed yet: attached when it is`);
  }
}

/** IPv4 / IPv6 subnets of MAIL_NETWORK (allowNets of the webmail app passwords, relay trust). [] when missing or unreachable. */
export async function mailNetworkSubnets(): Promise<string[]> {
  try {
    const docker = await engineFor(await localNodeId());
    const net = await inspectNetwork(docker, MAIL_NETWORK);
    const configs = (net?.IPAM?.Config ?? []) as Array<{ Subnet?: string }>;
    return configs.map((c) => (c.Subnet ?? '').trim()).filter((s) => s.length > 0);
  } catch (err) {
    logger.warn({ err: errText(err) }, 'mail network subnets unavailable');
    return [];
  }
}

/** Addresses of a container on MAIL_NETWORK ([] when not attached / not running / unreachable). */
export async function mailNetworkAddresses(container: string): Promise<string[]> {
  try {
    const docker = await engineFor(await localNodeId());
    const info = await inspectContainer(docker, container);
    if (!info?.State?.Running) return [];
    const ep = info.NetworkSettings?.Networks?.[MAIL_NETWORK] as { IPAddress?: string; GlobalIPv6Address?: string } | undefined;
    if (!ep) return [];
    return [ep.IPAddress, ep.GlobalIPv6Address].map((a) => (a ?? '').trim()).filter((a) => a.length > 0);
  } catch (err) {
    logger.warn({ err: errText(err), container }, 'mail network addresses unavailable');
    return [];
  }
}
