import type { HostingSocketEventName } from '@oblimint/shared';
import { getIO } from '../../socket';
import { logger } from '../../utils/logger';

/**
 * Emits a hosting event (payloads carry ids only: clients refetch through
 * the API, which applies the access rules). Rooms (socket.ts):
 *   tenant:<id>:staff  staff sessions of the tenant
 *   account:<id>       client sessions of the account
 *   role:admin         platform admins (god view)
 * Client users never join tenant-wide hosting rooms: they only hear about
 * their own accounts.
 */
export function emitHosting(
  event: HostingSocketEventName,
  payload: Record<string, unknown>,
  scope: { tenantId: number; accountId?: number | null },
): void {
  const io = getIO();
  if (!io) return;
  try {
    let target = io.to(`tenant:${scope.tenantId}:staff`).to('role:admin');
    if (scope.accountId) target = target.to(`account:${scope.accountId}`);
    target.emit(event, payload);
  } catch (err) {
    logger.debug({ err, event }, 'emitHosting failed');
  }
}
