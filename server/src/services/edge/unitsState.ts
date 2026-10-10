import type {
  EdgeApplyRecord, EdgeApplyResult, EdgeUnitOwnerKind, EdgeUnitState, EdgeUnitStatusKind, EdgeUnitUpstreamState,
} from '@oblimint/shared';
import { db } from '../../db';
import { json } from '../hosting/rows';
import type { PriorUnitState, UnitResult } from './pipeline';
import { EDGE_UNIT_STATUSES } from './unitTypes';

// ─────────────────────────────────────────────────────────────────────────────
// Persistence of the edge units (edge_units) and of every apply
// (edge_applies) — docs/P4b-PLAN.md §3, §8.3. Module edge-robustness.
// ─────────────────────────────────────────────────────────────────────────────

export interface EdgeUnitRow {
  unit_id: string;
  owner_kind: EdgeUnitOwnerKind;
  owner_id: number | null;
  account_id: number | null;
  tenant_id: number | null;
  status: EdgeUnitStatusKind;
  error: string | null;
  upstreams: unknown;
  desired_hash: string | null;
  active_hash: string | null;
  checked_at: Date | string | null;
  applied_at: Date | string | null;
  notified_at: Date | string | null;
}

const BAD_STATUSES: ReadonlySet<EdgeUnitStatusKind> = new Set(['quarantined', 'stub', 'upstreamUnreachable']);

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const toDate = (d: Date | string | null | undefined): Date | null => (d ? new Date(d) : null);

function upstreamsOf(raw: unknown): EdgeUnitUpstreamState[] {
  const list = json<unknown>(raw, []);
  if (!Array.isArray(list)) return [];
  return list.filter((x): x is EdgeUnitUpstreamState => !!x && typeof x === 'object' && typeof (x as EdgeUnitUpstreamState).target === 'string')
    .map((x) => ({ where: String(x.where ?? ''), target: String(x.target), reachable: typeof x.reachable === 'boolean' ? x.reachable : null, error: x.error ? String(x.error) : null }));
}

export function rowToUnitState(r: EdgeUnitRow): EdgeUnitState {
  return {
    unitId: r.unit_id,
    ownerKind: r.owner_kind,
    ownerId: r.owner_id === null ? null : Number(r.owner_id),
    accountId: r.account_id === null ? null : Number(r.account_id),
    status: EDGE_UNIT_STATUSES.includes(r.status) ? r.status : 'pending',
    error: r.error,
    upstreams: upstreamsOf(r.upstreams),
    desiredHash: r.desired_hash,
    activeHash: r.active_hash,
    checkedAt: iso(r.checked_at),
    appliedAt: iso(r.applied_at),
  };
}

/** Generic labels for a client user (A6): never the nginx / probe output. */
const CLIENT_LABELS: Partial<Record<EdgeUnitStatusKind, string>> = {
  quarantined: 'Configuration refused by the edge: the last valid version is served',
  stub: 'Configuration refused by the edge: a maintenance page is served',
  upstreamUnreachable: 'The target is unreachable from the edge: the previous version is kept',
  pending: 'Waiting to be applied',
};

/** The same state with the A6 rules of a client: generic error label, no probe output. */
export function edgeUnitStateForClient(s: EdgeUnitState): EdgeUnitState {
  return {
    ...s,
    error: s.error ? (CLIENT_LABELS[s.status] ?? 'Configuration not applied') : null,
    upstreams: s.upstreams.map((u) => ({ ...u, error: u.error ? (u.reachable === false ? 'unreachable' : null) : null })),
  };
}

/** Previous state of every unit (pipeline input). */
export async function loadPriorStates(): Promise<Map<string, PriorUnitState>> {
  const rows = await db('edge_units').select('unit_id', 'status', 'error', 'desired_hash', 'active_hash', 'upstreams', 'checked_at') as EdgeUnitRow[];
  return new Map(rows.map((r) => [r.unit_id, {
    status: r.status, error: r.error, desiredHash: r.desired_hash, activeHash: r.active_hash,
    upstreams: upstreamsOf(r.upstreams), checkedAt: toDate(r.checked_at),
  }]));
}

export interface UnitStateChange {
  unitId: string;
  ownerKind: EdgeUnitOwnerKind;
  ownerId: number | null;
  accountId: number | null;
  tenantId: number | null;
  label: string;
  status: EdgeUnitStatusKind;
  previous: EdgeUnitStatusKind | null;
  error: string | null;
  /** Newly refused (not notified yet for this desired version). */
  notify: boolean;
}

const CHUNK = 500;

const sameTime = (a: Date | string | null | undefined, b: Date | string | null | undefined) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

function sameRow(prev: EdgeUnitRow | undefined, next: {
  owner_kind: string; owner_id: number | null; account_id: number | null; tenant_id: number | null; status: string; error: string | null;
  upstreams: string; desired_hash: string; active_hash: string | null; checked_at: Date | string | null; applied_at: Date | string | null;
  notified_at: Date | string | null;
}): boolean {
  if (!prev) return false;
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return prev.owner_kind === next.owner_kind && num(prev.owner_id) === next.owner_id && num(prev.account_id) === next.account_id
    && num(prev.tenant_id) === next.tenant_id && prev.status === next.status && (prev.error ?? null) === next.error
    && JSON.stringify(upstreamsOf(prev.upstreams)) === JSON.stringify(upstreamsOf(next.upstreams)) && prev.desired_hash === next.desired_hash
    && (prev.active_hash ?? null) === next.active_hash && sameTime(prev.checked_at, next.checked_at) && sameTime(prev.applied_at, next.applied_at)
    && sameTime(prev.notified_at, next.notified_at);
}

/**
 * Upserts the state of every unit of a pass; deletes the rows of units that
 * no longer exist (unless `keepMissing`: a provider failed, its units are
 * unknown this pass). Returns the status changes (socket events) and the
 * units to notify (edge.unitQuarantined, deduplicated on notified_at).
 */
export async function persistUnitResults(results: UnitResult[], opts: { now: Date; keepMissing: boolean }): Promise<UnitStateChange[]> {
  const existing = new Map((await db('edge_units').select('*') as EdgeUnitRow[])
    .map((r) => [r.unit_id, r]));
  const changes: UnitStateChange[] = [];
  const rows = results.map((r) => {
    const prev = existing.get(r.unitId);
    const bad = BAD_STATUSES.has(r.status);
    let notifiedAt = prev?.notified_at ?? null;
    let notify = false;
    if (!bad) notifiedAt = null;
    else if (!notifiedAt || prev?.desired_hash !== r.desiredHash || !BAD_STATUSES.has(prev.status)) {
      notifiedAt = opts.now;
      notify = true;
    }
    const owner = r.unit.owner;
    if (!prev || prev.status !== r.status || notify) {
      changes.push({
        unitId: r.unitId, ownerKind: owner.kind, ownerId: owner.id ?? null, accountId: owner.accountId ?? null, tenantId: owner.tenantId ?? null,
        label: String(owner.label ?? r.unitId).slice(0, 200), status: r.status, previous: prev?.status ?? null, error: r.error, notify,
      });
    }
    return {
      unit_id: r.unitId,
      owner_kind: owner.kind,
      owner_id: owner.id ?? null,
      account_id: owner.accountId ?? null,
      tenant_id: owner.tenantId ?? null,
      status: r.status,
      error: r.error ? r.error.slice(0, 4000) : null,
      upstreams: JSON.stringify(r.upstreams),
      desired_hash: r.desiredHash,
      active_hash: r.activeHash,
      checked_at: r.checked ? opts.now : (prev?.checked_at ?? null),
      applied_at: r.applied ? opts.now : (prev?.applied_at ?? null),
      notified_at: notifiedAt,
    };
  });
  await db.transaction(async (trx) => {
    // Only the rows that change (a pass touches every unit; most are unchanged).
    const dirty = rows.filter((row) => !sameRow(existing.get(row.unit_id), row));
    for (let i = 0; i < dirty.length; i += CHUNK) {
      await trx('edge_units').insert(dirty.slice(i, i + CHUNK)).onConflict('unit_id').merge();
    }
    if (!opts.keepMissing) {
      const keep = new Set(results.map((r) => r.unitId));
      const gone = [...existing.keys()].filter((id) => !keep.has(id));
      for (let i = 0; i < gone.length; i += CHUNK) await trx('edge_units').whereIn('unit_id', gone.slice(i, i + CHUNK)).del();
    }
  });
  return changes;
}

/** Holds the units restored by an admin rollback (kept until they change or are retried). */
export async function holdUnits(units: Array<{ id: string; status: EdgeUnitStatusKind; activeHash: string | null }>, error: string, now: Date): Promise<UnitStateChange[]> {
  if (units.length === 0) return [];
  const rows = await db('edge_units').whereIn('unit_id', units.map((u) => u.id)) as EdgeUnitRow[];
  const byId = new Map(rows.map((r) => [r.unit_id, r]));
  const changes: UnitStateChange[] = [];
  for (const u of units) {
    const r = byId.get(u.id);
    if (!r) continue;
    await db('edge_units').where({ unit_id: u.id }).update({ status: u.status, error, active_hash: u.activeHash, checked_at: now });
    changes.push({
      unitId: u.id, ownerKind: r.owner_kind, ownerId: r.owner_id, accountId: r.account_id, tenantId: r.tenant_id, label: u.id,
      status: u.status, previous: r.status, error, notify: false,
    });
  }
  return changes;
}

interface ApplyRow {
  id: number;
  trigger: string;
  result: EdgeApplyResult;
  units_total: number;
  units_changed: number;
  units_quarantined: number;
  canary: unknown;
  error: string | null;
  started_at: Date | string;
  finished_at: Date | string | null;
}

function applyRowToRecord(r: ApplyRow): EdgeApplyRecord {
  return {
    id: Number(r.id),
    trigger: r.trigger,
    result: r.result,
    unitsTotal: Number(r.units_total),
    unitsChanged: Number(r.units_changed),
    unitsQuarantined: Number(r.units_quarantined),
    canary: json<EdgeApplyRecord['canary']>(r.canary, null),
    error: r.error,
    startedAt: new Date(r.started_at).toISOString(),
    finishedAt: iso(r.finished_at),
  };
}

export interface ApplyInput {
  trigger: string;
  result: EdgeApplyResult;
  unitsTotal: number;
  unitsChanged: number;
  unitsQuarantined: number;
  canary: EdgeApplyRecord['canary'];
  error: string | null;
  startedAt: Date;
  finishedAt: Date;
}

/** Applies kept (most recent first). */
export const APPLIES_RETENTION = 2000;

export async function recordApply(a: ApplyInput): Promise<EdgeApplyRecord> {
  const [row] = await db('edge_applies').insert({
    trigger: a.trigger.slice(0, 64),
    result: a.result,
    units_total: a.unitsTotal,
    units_changed: a.unitsChanged,
    units_quarantined: a.unitsQuarantined,
    canary: a.canary ? JSON.stringify(a.canary) : null,
    error: a.error ? a.error.slice(0, 4000) : null,
    started_at: a.startedAt,
    finished_at: a.finishedAt,
  }).returning('*') as ApplyRow[];
  // Retention: the newest APPLIES_RETENTION rows.
  const cutoff = await db('edge_applies').orderBy('id', 'desc').offset(APPLIES_RETENTION).first('id') as { id: number } | undefined;
  if (cutoff) await db('edge_applies').where('id', '<=', cutoff.id).del();
  return applyRowToRecord(row);
}

export async function listApplyRecords(limit: number): Promise<EdgeApplyRecord[]> {
  const n = Math.min(200, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50));
  const rows = await db('edge_applies').orderBy('id', 'desc').limit(n) as ApplyRow[];
  return rows.map(applyRowToRecord);
}

export async function lastApplyRecord(): Promise<EdgeApplyRecord | null> {
  const row = await db('edge_applies').orderBy('id', 'desc').first() as ApplyRow | undefined;
  return row ? applyRowToRecord(row) : null;
}

export async function unitStatusCounts(): Promise<NonNullable<import('@oblimint/shared').EdgeStatus['units']>> {
  const rows = await db('edge_units').select('status').count<Array<{ status: EdgeUnitStatusKind; count: string | number }>>('* as count').groupBy('status');
  const out = { total: 0, active: 0, quarantined: 0, stub: 0, pending: 0, upstreamUnreachable: 0 };
  for (const r of rows) {
    const n = Number(r.count);
    out.total += n;
    if (r.status in out && r.status !== 'disabled') (out as Record<string, number>)[r.status] += n;
  }
  return out;
}
