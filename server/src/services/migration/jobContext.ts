import type { Request } from 'express';
import { MASTER_TENANT_ID } from '@oblimint/shared';
import { AppError } from '../../middleware/errorHandler';
import { resolveActor, type HostingActor } from '../hosting/access';

// ─────────────────────────────────────────────────────────────────────────────
// Identity of background migration work (docs/P5-PLAN.md §9.1). ARCHITECT
// FILE, implemented, frozen. Runs and discoveries execute in a worker, after
// the HTTP request that started them (and after a panel restart): they call
// the P1–P4b services with a SYNTHETIC request carrying the id of the admin
// who started them, and the actor RE-RESOLVED from the database at each run
// start — an admin who lost the platform-admin role cannot keep migrating.
//
// The services create plans / accounts in actor.tenantId: a run therefore
// resolves its actor ON THE TARGET TENANT (platform admin = caps '*' there;
// globalView only on the master tenant).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal Express request: what resolveActor / audit (logReq, logReqAs, clientIp)
 * read. `tenantId` = the tenant the services act in and the audit lines go to
 * (target tenant of a run, master tenant otherwise). A FRESH object per call:
 * resolveActor caches per request object.
 */
export function migrationRequest(userId: number, tenantId: number = MASTER_TENANT_ID): Request {
  return {
    session: { userId, currentTenantId: tenantId, role: 'admin' },
    tenantId,
    headers: { 'user-agent': 'oblimint-migration' },
    socket: { remoteAddress: '127.0.0.1' },
    ip: '127.0.0.1',
    query: {},
    params: {},
    body: {},
    method: 'POST',
    path: '/migration',
    baseUrl: '/api/system/migration',
  } as unknown as Request;
}

/**
 * Platform-admin actor of `userId` acting in `tenantId` (default master).
 * 403 migrationAdminRequired when the user is not (or no longer) an active platform admin.
 */
export async function migrationActor(userId: number, tenantId: number = MASTER_TENANT_ID): Promise<HostingActor> {
  let actor: HostingActor;
  try {
    actor = await resolveActor(migrationRequest(userId, tenantId));
  } catch {
    throw new AppError(403, 'The migration runs with the rights of a platform administrator', 'migrationAdminRequired');
  }
  if (actor.kind !== 'staff' || actor.caps !== '*') {
    throw new AppError(403, 'The migration runs with the rights of a platform administrator', 'migrationAdminRequired');
  }
  return actor;
}
