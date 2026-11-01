import type Docker from 'dockerode';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import type { NetworkCreateOptions } from '../docker/dockerOps';
import { AUTH_NETWORK, MAIL_NETWORK, PANEL_NETWORK } from '../hosting/naming';
import { errText } from '../setup/docker';
import { defaultIpRange } from './addressLayout';
import { allocateSubnet, listDockerSubnets, poolConfig } from './allocator';
import { formatCidr4, gatewayOf, parseCidr4, pickFreeSubnet } from './ipv4';

// ─────────────────────────────────────────────────────────────────────────────
// Creation options of the platform networks (migration 031): a subnet from the
// platform pool (config.hosting.platformPool, registered in network_subnets
// pool 'platform'), gateway .1, Docker's dynamic range on the last /28 and an
// explicit bridge name — a network whose subnet the panel chose accepts static
// addresses on every Docker version (Docker ≤ 28 refuses them on a subnet it
// chose itself). Used when the network does NOT exist yet (new installation,
// first deployment of a component); existing platform networks keep theirs.
// Never throws: without the database (wizard) the subnet is picked against the
// Docker networks only (registered at the first normal boot); when even that
// fails, Docker's defaults are used and logged (the network is then reported
// by the address status if Docker refuses static addresses there).
// ─────────────────────────────────────────────────────────────────────────────

const MAIL_CORE_NETWORK_NAME = 'oblimint-mail-core';

/** Explicit bridge interface names of the platform networks (≤ 15 chars). */
export const PLATFORM_BRIDGES: Readonly<Record<string, string>> = {
  [PANEL_NETWORK]: 'omp-panel',
  [MAIL_NETWORK]: 'omp-mail',
  [MAIL_CORE_NETWORK_NAME]: 'omp-mcore',
  [AUTH_NETWORK]: 'omp-auth',
};

/** Creation options of platform network `name` on `cidr` (also the setup wizard's). */
export function platformOptionsFor(name: string, cidr: string): NetworkCreateOptions {
  const c = parseCidr4(cidr);
  if (!c) throw new Error(`invalid subnet ${cidr}`);
  return {
    subnet: formatCidr4(c),
    gateway: gatewayOf(c),
    ipRange: defaultIpRange(cidr),
    bridgeName: PLATFORM_BRIDGES[name] ?? null,
  };
}
const optionsFor = platformOptionsFor;

/** A free platform subnet against the Docker networks only (no database: setup wizard). */
export async function pickPlatformSubnetWithoutDb(docker: Pick<Docker, 'listNetworks'>): Promise<string | null> {
  const { cidr: pool, prefix } = poolConfig('platform');
  const taken = (await listDockerSubnets(docker)).flatMap((n) => n.subnets);
  const pick = pickFreeSubnet(pool, prefix, taken);
  return pick ? formatCidr4(pick) : null;
}

/** Options of a NEW platform network `name` (see the header). Never throws. */
export async function platformNetworkOptions(name: string, docker: Docker): Promise<NetworkCreateOptions> {
  try {
    if (config.databaseUrl) {
      try {
        const subnets = await listDockerSubnets(docker);
        const { cidr } = await allocateSubnet(name, { pool: 'platform', purpose: 'platform', accountId: null }, subnets);
        return optionsFor(name, cidr);
      } catch (err) {
        logger.warn({ network: name, err: errText(err) }, 'platform network: no subnet from the platform pool (database), picked against Docker only');
      }
    }
    const cidr = await pickPlatformSubnetWithoutDb(docker);
    if (cidr) return optionsFor(name, cidr);
    logger.warn({ network: name }, 'platform network: platform pool full, Docker defaults used');
  } catch (err) {
    logger.warn({ network: name, err: errText(err) }, 'platform network: subnet unavailable, Docker defaults used');
  }
  return {};
}
