import { HostingSocketEvents, type AppDeployOutputPayload, type AppDeploymentStatus, type AppUpdatedPayload } from '@oblimint/shared';
import { getIO } from '../../socket';
import { logger } from '../../utils/logger';
import { emitHosting } from '../hosting/events';
import { clientStatusMessage } from '../hosting/statusMessage';

// Socket.io events of the apps module (docs/P4b-PLAN.md §5.9). APP_UPDATED: ids only, to the tenant staff /
// admins / account rooms (emitHosting). APP_DEPLOY_OUTPUT: lines of a running deployment, to the sockets
// that joined its room after an access check (socketHandlers.ts): `app-deploy:<id>` (staff: raw lines)
// and `app-deploy:<id>:client` (clients: error causes reduced to their French label, A6).

/** Error lines of a deployment log start with this marker ("✗ <label> : <cause>"). */
export const ERROR_LINE_PREFIX = '✗ ';

export const deployRoom = (deploymentId: number, client: boolean): string => `app-deploy:${deploymentId}${client ? ':client' : ''}`;

/** A log line as a client may read it (A6). */
export function clientLine(line: string): string {
  return line.startsWith(ERROR_LINE_PREFIX) ? `${ERROR_LINE_PREFIX}${clientStatusMessage(line.slice(ERROR_LINE_PREFIX.length)) ?? ''}` : line;
}

export function emitAppUpdated(payload: AppUpdatedPayload, scope: { tenantId: number; accountId: number | null }): void {
  emitHosting(HostingSocketEvents.APP_UPDATED, payload as unknown as Record<string, unknown>, scope);
}

export function emitDeployOutput(deploymentId: number, stackId: number, lines: string[], status: AppDeploymentStatus): void {
  const io = getIO();
  if (!io) return;
  try {
    const raw: AppDeployOutputPayload = { deploymentId, stackId, lines, status };
    io.to(deployRoom(deploymentId, false)).emit(HostingSocketEvents.APP_DEPLOY_OUTPUT, raw);
    const redacted: AppDeployOutputPayload = { deploymentId, stackId, lines: lines.map(clientLine), status };
    io.to(deployRoom(deploymentId, true)).emit(HostingSocketEvents.APP_DEPLOY_OUTPUT, redacted);
  } catch (err) {
    logger.debug({ err }, 'emitDeployOutput failed');
  }
}
