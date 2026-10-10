import type { Request } from 'express';
import type { EdgeApplyRecord, EdgeUnitOwnerKind, EdgeUnitState, EdgeUnitStatusKind } from '@oblimint/shared';
import { MASTER_TENANT_ID } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { platformSettings } from '../platformSettings';
import type { HostingActor } from '../hosting/access';
import { scopeOwned } from '../hosting/p4bAccess';
import { edgeExec, edgeService } from './edge.service';
import { probeUpstreamWith } from './probe';
import { EDGE_UNIT_OWNER_KINDS, EDGE_UNIT_STATUSES } from './unitTypes';
import { edgeUnitStateForClient, listApplyRecords, rowToUnitState, type EdgeUnitRow } from './unitsState';
import type { EdgeUpstreamRef } from './units';

// Edge configuration units: state, applies, probes (docs/P4b-PLAN.md §8). OWNED BY MODULE
// `edge-robustness` (signatures FROZEN — proxy-hosts reads unit states for its objects, monitoring may
// read applies). The apply pipeline itself is triggered by edgeService.scheduleSync(reason) / syncNow()
// (edge.service.ts → pipeline.ts).
//
// A6: a client user only ever gets generic error labels (edgeUnitStateForClient); statesForOwners /
// stateForOwner return the full detail — a caller answering a client applies edgeUnitStateForClient.

export interface EdgeUnitQuery {
  accountId?: number | null;
  tenantId?: number | null;
  status?: EdgeUnitStatusKind | null;
  ownerKind?: EdgeUnitOwnerKind | null;
}

const LIST_LIMIT = 5000;

let lastStreamPortsKey: string | null = null;

export { edgeUnitStateForClient };

export const edgeUnitsService = {
  /** Tenant route: units of the visible accounts (client: generic error labels, A6); actor null = platform admin (full). */
  async listUnits(actor: HostingActor | null, q: EdgeUnitQuery): Promise<EdgeUnitState[]> {
    let qb = db('edge_units as u').select('u.*');
    if (actor) qb = scopeOwned(actor, qb, 'u', { filterTenantId: q.tenantId ?? null, includePlatform: false });
    else if (q.tenantId && Number.isInteger(q.tenantId)) qb = qb.where('u.tenant_id', q.tenantId);
    if (q.accountId && Number.isInteger(q.accountId)) qb = qb.where('u.account_id', q.accountId);
    if (q.status && EDGE_UNIT_STATUSES.includes(q.status)) qb = qb.where('u.status', q.status);
    if (q.ownerKind && EDGE_UNIT_OWNER_KINDS.includes(q.ownerKind)) qb = qb.where('u.owner_kind', q.ownerKind);
    const rows = await qb.orderBy('u.unit_id').limit(LIST_LIMIT) as EdgeUnitRow[];
    const states = rows.map(rowToUnitState);
    return actor?.kind === 'client' ? states.map(edgeUnitStateForClient) : states;
  },

  /** proxy-hosts: state of its objects' units (ownerKind proxy-host / redirection / dead-host / stream), by owner id. Never throws (empty map). */
  async statesForOwners(kind: EdgeUnitOwnerKind, ownerIds: number[]): Promise<Map<number, EdgeUnitState>> {
    const out = new Map<number, EdgeUnitState>();
    try {
      const ids = [...new Set(ownerIds.filter((n) => Number.isInteger(n) && n > 0))];
      if (ids.length === 0 || !EDGE_UNIT_OWNER_KINDS.includes(kind)) return out;
      for (let i = 0; i < ids.length; i += 1000) {
        const rows = await db('edge_units').where({ owner_kind: kind }).whereIn('owner_id', ids.slice(i, i + 1000)).orderBy('unit_id') as EdgeUnitRow[];
        for (const r of rows) if (r.owner_id !== null && !out.has(Number(r.owner_id))) out.set(Number(r.owner_id), rowToUnitState(r));
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'edge units: owner states unavailable');
    }
    return out;
  },

  async stateForOwner(kind: EdgeUnitOwnerKind, ownerId: number): Promise<EdgeUnitState | null> {
    return (await this.statesForOwners(kind, [ownerId])).get(ownerId) ?? null;
  },

  /** Re-validate + apply one unit now (proxy host "retry", admin). Audited (edge.unit.retry) when a request is given. */
  async retry(req: Request | null, unitId: string): Promise<EdgeUnitState> {
    const id = String(unitId ?? '');
    const before = await db('edge_units').where({ unit_id: id }).first() as EdgeUnitRow | undefined;
    if (!before) throw new AppError(404, 'Edge unit not found', 'notFound');
    const sync = await edgeService.retryUnits([id]);
    const after = await db('edge_units').where({ unit_id: id }).first() as EdgeUnitRow | undefined;
    if (req) {
      await auditService.logReqAs(req, before.tenant_id ?? MASTER_TENANT_ID, 'edge.unit.retry', {
        resourceType: 'edgeUnit', resourcePath: id,
        details: { from: before.status, to: after?.status ?? null, syncOk: sync.ok },
      });
    }
    if (!after) throw new AppError(404, 'Edge unit not found', 'notFound');
    return rowToUnitState(after);
  },

  async listApplies(limit: number): Promise<EdgeApplyRecord[]> {
    return listApplyRecords(limit);
  },

  /** Back to the previous good snapshot of the whole configuration (admin, audited). */
  async rollback(req: Request): Promise<EdgeApplyRecord> {
    const out = await edgeService.rollback();
    if (out.code === 'noPreviousConfiguration') throw new AppError(409, 'No previous good configuration to roll back to', 'noPreviousConfiguration');
    if (out.code === 'edgeNotRunning') throw new AppError(409, 'The edge is not running', 'edgeNotRunning');
    await auditService.logReq(req, 'edge.rollback', {
      resourceType: 'settings', resourcePath: 'edge',
      details: { ok: out.ok, applyId: out.record.id, units: out.record.unitsChanged, error: out.record.error },
    });
    return out.record;
  },

  /** TCP connect (UDP: skipped → reachable null) from INSIDE the edge container (docker exec, bounded 5 s). */
  async probeUpstream(ref: EdgeUpstreamRef): Promise<{ reachable: boolean | null; error: string | null }> {
    try {
      return await probeUpstreamWith(await edgeExec(), ref);
    } catch (err) {
      return { reachable: false, error: (err as Error).message };
    }
  },

  /**
   * Settings section `edge` changed. Stream ports changed → infraService.ensureEdge recreates the edge
   * (published ports: a few seconds without edge, R-STREAM-RECREATE); canary / probe flags are re-read by
   * every sync; a sync is scheduled. Never throws.
   */
  settingsChanged(): void {
    void (async () => {
      try {
        const settings = await platformSettings.section('edge');
        const key = JSON.stringify([...settings.streamPorts].sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol)));
        if (key !== lastStreamPortsKey) {
          const first = lastStreamPortsKey === null;
          lastStreamPortsKey = key;
          if (!first) logger.warn({ streamPorts: settings.streamPorts }, 'edge: stream ports changed, the edge container is recreated (short interruption)');
          const { infraService } = await import('../docker/infra.service');
          await infraService.ensureEdge((line) => logger.info({ line }, 'edge: ensure'));
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'edge: settings change not applied to the edge container');
      }
      edgeService.scheduleSync('settings');
    })();
  },
};
