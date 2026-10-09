import { HostingSocketEvents, MASTER_TENANT_ID, type MailUpdatedPayload } from '@oblimint/shared';
import { emitHosting } from '../hosting/events';

// ─────────────────────────────────────────────────────────────────────────────
// MAIL_UPDATED socket event (ids only, clients refetch) — ARCHITECT FILE
// (frozen). Rooms: tenant staff + platform admins + the account's clients
// (hosting/events.ts). Engine-wide events (entity 'engine', accountId null)
// go to the platform admins only.
// ─────────────────────────────────────────────────────────────────────────────

export function emitMail(payload: MailUpdatedPayload, scope: { tenantId: number | null; accountId: number | null }): void {
  emitHosting(HostingSocketEvents.MAIL_UPDATED, { ...payload }, {
    tenantId: scope.tenantId ?? MASTER_TENANT_ID,
    accountId: scope.accountId,
  });
}
