import type { RestrictionFloor, RestrictionMap } from '@oblimint/shared';
import { MASTER_TENANT_ID } from '@oblimint/shared';
import { db } from '../../db';
import { auditService } from '../audit.service';
import { platformSettings } from '../platformSettings';
import { parseStoredMap, restrictionService } from './restriction.service';

// ─────────────────────────────────────────────────────────────────────────────
// Out-of-panel escape of the sensitive actions (owner rule "never lock the
// owner out"): run by the operator through `docker exec` (cli/restrictions.ts),
// never reachable over HTTP. Lowers 'restrictions.manage' — the action that
// gates every change of the matrix and of the floor — so the panel can be
// used again; resets the platform floor when asked. Audited.
// ─────────────────────────────────────────────────────────────────────────────

const MANAGE = 'restrictions.manage';

export interface UnlockResult {
  tenants: number[];
  floorChanged: boolean;
}

/**
 * Removes 'restrictions.manage' from the floor and from the map of `tenantId`
 * (null: every tenant). The other entries are kept.
 */
export async function unlockRestrictionsManage(tenantId: number | null): Promise<UnlockResult> {
  const rows = await (tenantId === null ? db('tenants') : db('tenants').where({ id: tenantId }))
    .select('id', 'action_restrictions') as Array<{ id: number; action_restrictions: unknown }>;
  const tenants: number[] = [];
  for (const r of rows) {
    const map: RestrictionMap = parseStoredMap(r.action_restrictions);
    if (!map[MANAGE]) continue;
    delete map[MANAGE];
    await restrictionService.setMap(Number(r.id), map);
    tenants.push(Number(r.id));
    await auditService.log({
      tenantId: Number(r.id), action: 'restrictions.cli_unlock', resourceType: 'restrictions', resourcePath: MANAGE,
      details: { via: 'cli' },
    });
  }
  const floor = await restrictionService.floor();
  let floorChanged = false;
  if (floor[MANAGE]) {
    const next: RestrictionFloor = { ...floor };
    delete next[MANAGE];
    await writeFloor(next, { removed: [MANAGE] });
    floorChanged = true;
  }
  return { tenants, floorChanged };
}

/** Empties the platform floor. */
export async function resetRestrictionsFloor(): Promise<{ removed: string[] }> {
  const floor = await restrictionService.floor();
  const removed = Object.keys(floor).sort();
  if (removed.length) await writeFloor({}, { removed });
  return { removed };
}

async function writeFloor(floor: RestrictionFloor, details: Record<string, unknown>): Promise<void> {
  await platformSettings.update({ restrictions: { floor } });
  platformSettings.invalidate();
  await auditService.log({
    tenantId: MASTER_TENANT_ID, action: 'restrictions.cli_floor', resourceType: 'restrictions', resourcePath: 'floor',
    details: { via: 'cli', ...details },
  });
}
