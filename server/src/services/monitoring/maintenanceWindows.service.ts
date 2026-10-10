import type { Knex } from 'knex';
import type { Request } from 'express';
import type {
  AppMaintenanceSchedule, AppMaintenanceWindow, AppMaintenanceWindowInput, AppMaintenanceWindowUpdate,
} from '@oblimint/shared';
import { MASTER_TENANT_ID } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import type { HostingActor } from '../hosting/access';
import { loadOwned, type OwnedRow } from '../hosting/p4bAccess';
import { jsonValue, lockOwnerScope, ownerForCreate, ownerOf, scopeList, toIso, type ListFilter, type RowOwner } from './common';
import { emitMonitoring } from './events';
import { nextWindowOpening, scheduleProblem, windowIsOpen } from './schedule';

// ─────────────────────────────────────────────────────────────────────────────
// Maintenance windows of the app auto-updates (docs/P4b-PLAN.md §11.4).
// OWNED BY MODULE `monitoring-automation` (isOpen / nextOpening consumed by
// apps-core: signatures FROZEN).
// Resolution: the stack's window (update_policy.maintenanceWindowId) when it
// exists, is usable by the stack's account (same account, or a platform
// window of its tenant / of the master tenant) and is enabled; else the
// account's default window; else the tenant's default window (account_id
// null, is_default); else NO window = any time. An unreadable window
// (database down, corrupt schedule) → isOpen false (logged): an automatic
// update never runs on a guess.
// ─────────────────────────────────────────────────────────────────────────────

export interface MaintenanceScope {
  tenantId: number;
  accountId: number;
  /** update_policy.maintenanceWindowId of the stack (null = defaults). */
  windowId: number | null;
}

interface WindowRow extends OwnedRow {
  name: string;
  schedule: unknown;
  enabled: boolean;
  is_default: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

class UnreadableWindowError extends Error {}

function scheduleOf(row: WindowRow): AppMaintenanceSchedule {
  const s = jsonValue<AppMaintenanceSchedule | null>(row.schedule, null);
  if (!s || scheduleProblem(s)) throw new UnreadableWindowError(`maintenance window ${row.id}: invalid schedule`);
  return s;
}

/** Schedule applying to a stack: null = no window (any time). Throws when unreadable. */
export async function resolveSchedule(scope: MaintenanceScope): Promise<AppMaintenanceSchedule | null> {
  if (scope.windowId !== null && Number.isInteger(scope.windowId) && scope.windowId > 0) {
    const row = await db('app_maintenance_windows').where({ id: scope.windowId }).first() as WindowRow | undefined;
    const usable = row && (
      (row.account_id !== null && Number(row.account_id) === scope.accountId && Number(row.tenant_id) === scope.tenantId)
      || (row.account_id === null && (Number(row.tenant_id) === scope.tenantId || Number(row.tenant_id) === MASTER_TENANT_ID)));
    if (row && usable && row.enabled) return scheduleOf(row);
  }
  const accountDefault = await db('app_maintenance_windows')
    .where({ tenant_id: scope.tenantId, account_id: scope.accountId, is_default: true, enabled: true }).first() as WindowRow | undefined;
  if (accountDefault) return scheduleOf(accountDefault);
  const tenantDefault = await db('app_maintenance_windows')
    .where({ tenant_id: scope.tenantId, is_default: true, enabled: true }).whereNull('account_id').first() as WindowRow | undefined;
  if (tenantDefault) return scheduleOf(tenantDefault);
  return null;
}

function toWindow(row: WindowRow, now: Date): AppMaintenanceWindow {
  const schedule = jsonValue<AppMaintenanceSchedule>(row.schedule, { days: [], start: '00:00', durationMinutes: 60, timezone: 'UTC' });
  const valid = !scheduleProblem(schedule);
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    accountId: row.account_id === null ? null : Number(row.account_id),
    name: row.name,
    schedule,
    enabled: !!row.enabled,
    isDefault: !!row.is_default,
    openNow: !!row.enabled && valid && windowIsOpen(schedule, now),
    nextOpenAt: row.enabled && valid ? toIso(nextWindowOpening(schedule, now)) : null,
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  };
}

function assertSchedule(s: unknown): AppMaintenanceSchedule {
  const problem = scheduleProblem(s);
  if (problem) throw new AppError(400, problem.message, problem.code);
  const v = s as AppMaintenanceSchedule;
  return { days: [...v.days].sort((a, b) => a - b), start: v.start, durationMinutes: v.durationMinutes, timezone: v.timezone };
}

/**
 * Clears the other default window of the same (tenant, account) inside `trx`.
 * The scope (account / tenant row) is locked first: two concurrent "default"
 * saves serialize instead of both clearing then colliding on the partial
 * unique index.
 */
async function clearDefault(trx: Knex.Transaction, owner: RowOwner, exceptId: number | null): Promise<void> {
  await lockOwnerScope(trx, owner);
  const q = trx('app_maintenance_windows').where({ tenant_id: owner.tenantId, is_default: true });
  if (owner.accountId === null) q.whereNull('account_id');
  else q.where({ account_id: owner.accountId });
  if (exceptId !== null) q.whereNot({ id: exceptId });
  await q.update({ is_default: false, updated_at: new Date() });
}

/** A unique violation left (the default index raced anyway): a clean 409, never a 500. */
function mapDefaultConflict(err: unknown): never {
  if ((err as { code?: string })?.code === '23505') {
    throw new AppError(409, 'Another default maintenance window was saved at the same time: retry', 'conflict');
  }
  throw err;
}

export const appMaintenanceWindowService = {
  /** Is an automatic update allowed at `at`? Never throws (an unreadable window → false, logged). */
  async isOpen(scope: MaintenanceScope, at: Date = new Date()): Promise<boolean> {
    try {
      const s = await resolveSchedule(scope);
      return s === null ? true : windowIsOpen(s, at);
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, scope }, 'Maintenance window unreadable: automatic update held');
      return false;
    }
  },

  /** Next opening after `from` (`from` itself when open; null = no window: any time, or unreadable). */
  async nextOpening(scope: MaintenanceScope, from: Date = new Date()): Promise<Date | null> {
    try {
      const s = await resolveSchedule(scope);
      return s === null ? null : nextWindowOpening(s, from);
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, scope }, 'Maintenance window unreadable');
      return null;
    }
  },

  // ── REST (§6.6) ────────────────────────────────────────────────────────────

  async list(actor: HostingActor, filter: ListFilter, now: Date = new Date()): Promise<AppMaintenanceWindow[]> {
    const rows = await scopeList(actor, db('app_maintenance_windows as w'), 'w', filter).select('w.*').orderBy('w.name') as WindowRow[];
    return rows.map((r) => toWindow(r, now));
  },

  async create(req: Request, actor: HostingActor, body: AppMaintenanceWindowInput): Promise<AppMaintenanceWindow> {
    const owner = await ownerForCreate(actor, body.accountId);
    const schedule = assertSchedule(body.schedule);
    const isDefault = body.isDefault ?? false;
    const row = await db.transaction(async (trx) => {
      if (isDefault) await clearDefault(trx, owner, null);
      const [r] = await trx('app_maintenance_windows').insert({
        tenant_id: owner.tenantId,
        account_id: owner.accountId,
        name: body.name,
        schedule: JSON.stringify(schedule),
        enabled: body.enabled ?? true,
        is_default: isDefault,
      }).returning('*') as WindowRow[];
      return r;
    }).catch(mapDefaultConflict);
    emitMonitoring({ entity: 'maintenanceWindow', id: Number(row.id), accountId: owner.accountId, action: 'created' }, owner);
    await auditService.logReqAs(req, owner.tenantId, 'automation.window.create', {
      resourceType: 'maintenance_window', resourcePath: String(row.id), details: { name: body.name, accountId: owner.accountId, isDefault, schedule },
    });
    return toWindow(row, new Date());
  },

  async update(req: Request, actor: HostingActor, id: number, body: AppMaintenanceWindowUpdate): Promise<AppMaintenanceWindow> {
    const current = await loadOwned<WindowRow>(actor, 'app_maintenance_windows', id, 'monitoring.manage', 'Maintenance window');
    const owner = ownerOf(current);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.schedule !== undefined) patch.schedule = JSON.stringify(assertSchedule(body.schedule));
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.isDefault !== undefined) patch.is_default = body.isDefault;
    const row = await db.transaction(async (trx) => {
      if (body.isDefault) await clearDefault(trx, owner, Number(current.id));
      const [r] = await trx('app_maintenance_windows').where({ id: current.id }).update(patch).returning('*') as WindowRow[];
      return r;
    }).catch(mapDefaultConflict);
    emitMonitoring({ entity: 'maintenanceWindow', id: Number(row.id), accountId: owner.accountId, action: 'updated' }, owner);
    await auditService.logReqAs(req, owner.tenantId, 'automation.window.update', {
      resourceType: 'maintenance_window', resourcePath: String(row.id), details: { fields: Object.keys(body) },
    });
    return toWindow(row, new Date());
  },

  async remove(req: Request, actor: HostingActor, id: number): Promise<void> {
    const current = await loadOwned<WindowRow>(actor, 'app_maintenance_windows', id, 'monitoring.manage', 'Maintenance window');
    const owner = ownerOf(current);
    await db('app_maintenance_windows').where({ id: current.id }).delete();
    emitMonitoring({ entity: 'maintenanceWindow', id: Number(current.id), accountId: owner.accountId, action: 'deleted' }, owner);
    await auditService.logReqAs(req, owner.tenantId, 'automation.window.delete', {
      resourceType: 'maintenance_window', resourcePath: String(current.id), details: { name: current.name },
    });
  },
};
