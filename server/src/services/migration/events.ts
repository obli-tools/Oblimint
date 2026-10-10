import { HostingSocketEvents, type MigrationUpdatedPayload } from '@oblimint/shared';
import { getIO } from '../../socket';
import { logger } from '../../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Socket events of the migration (docs/P5-PLAN.md §6.6). ARCHITECT FILE,
// implemented, frozen. Room role:admin ONLY (platform admins): the migration
// never talks to tenant staff or clients. Payloads carry ids / status /
// coarse progress; clients refetch through the API.
// ─────────────────────────────────────────────────────────────────────────────

const lastEmit = new Map<string, number>();
const THROTTLE_MS = 500;

/** Emits MIGRATION_UPDATED to the platform admins. progress-only updates are throttled (500 ms per entity). */
export function emitMigration(payload: MigrationUpdatedPayload, opts: { throttle?: boolean } = {}): void {
  const io = getIO();
  if (!io) return;
  if (opts.throttle) {
    const k = `${payload.entity}:${payload.id}`;
    const now = Date.now();
    const last = lastEmit.get(k) ?? 0;
    if (now - last < THROTTLE_MS) return;
    lastEmit.set(k, now);
    if (lastEmit.size > 5000) lastEmit.clear();
  }
  try {
    io.to('role:admin').emit(HostingSocketEvents.MIGRATION_UPDATED, payload);
  } catch (err) {
    logger.debug({ err }, 'emitMigration failed');
  }
}
