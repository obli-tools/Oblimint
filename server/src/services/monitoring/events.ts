import { HostingSocketEvents, MASTER_TENANT_ID, type MonitoringUpdatedPayload } from '@oblimint/shared';
import { emitHosting } from '../hosting/events';

// MONITORING_UPDATED socket event (ids only, clients refetch through the API,
// which applies the access rules). Rooms: tenant staff + platform admins + the
// account's clients (hosting/events.ts); platform rows (accountId null) reach
// the staff of the tenant only.

export function emitMonitoring(payload: MonitoringUpdatedPayload, scope: { tenantId: number | null; accountId: number | null }): void {
  emitHosting(HostingSocketEvents.MONITORING_UPDATED, { ...payload }, {
    tenantId: scope.tenantId ?? MASTER_TENANT_ID,
    accountId: scope.accountId,
  });
}
