import type Docker from 'dockerode';
import type { HostdGatewaySpec } from '../hostd/client';
import { FILESRV_CONTAINER_PORT } from '../docker/specs';
import { accountNetwork } from '../hosting/naming';
import type { AccountRow } from '../hosting/rows';

// Gateway spec of an account's file server (pure: unit-tested).

/** No connection for this long → hostd emits 'idle' (on-demand: the gateway window ends). */
export const GATEWAY_IDLE_TIMEOUT_SEC = 15 * 60;
/** A connection to a stopped server waits this long for it to start (plan §13: ≤ 30 s). */
export const GATEWAY_ACTIVATION_WAIT_SEC = 30;

/**
 * What hostd must do on the account's SFTP port: null = no listener (mode
 * off, no port, account being deleted). target = the running container's IP
 * on the account network (:2022), null when it is stopped (hold + activate).
 * A suspended account keeps a listener that refuses at once (no hold, no
 * activation); mode always never goes idle.
 */
export function gatewaySpecFor(
  account: Pick<AccountRow, 'id' | 'status' | 'filesrv_mode' | 'filesrv_port'>,
  info: Docker.ContainerInspectInfo | null,
): HostdGatewaySpec | null {
  const port = account.filesrv_port;
  if (account.filesrv_mode === 'off' || account.status === 'deleting' || !Number.isInteger(port) || port! < 1 || port! > 65535) return null;
  const running = !!info?.State?.Running && !info?.State?.Restarting;
  const ip = info?.NetworkSettings?.Networks?.[accountNetwork(account.id)]?.IPAddress;
  return {
    accountId: account.id,
    port: port!,
    target: running && ip ? { ip, port: FILESRV_CONTAINER_PORT } : null,
    proxyProtocol: true,
    idleTimeoutSec: account.filesrv_mode === 'always' ? 0 : GATEWAY_IDLE_TIMEOUT_SEC,
    activationWaitSec: account.status === 'active' ? GATEWAY_ACTIVATION_WAIT_SEC : 0,
  };
}
