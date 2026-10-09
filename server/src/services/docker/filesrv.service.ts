import type { FileServerMode, FileServerStatus, HostingAccount } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { emitHosting } from '../hosting/events';
import { fileServerContainer } from '../hosting/naming';
import { iso, type AccountRow } from '../hosting/rows';
import { errText } from '../setup/docker';
import { inspectContainer } from './dockerOps';
import { engineFor } from './engine';
import { reconcileService, type ReconcileReport } from './reconcile.service';

// ─────────────────────────────────────────────────────────────────────────────
// Per-account file server (SFTPGo container, ARCHITECTURE §3.3, P1-PLAN §10).
// Modes: always (kept running by the reconcile), on-demand (started by
// activate(), stopped by the expiry worker at filesrv_active_until; socket
// activation by hostd = P2), off (never runs, container removed).
// The container itself is converged by the reconcile (planner.ts decides
// from mode / active_until); this service changes the rows and runs a pass.
// ─────────────────────────────────────────────────────────────────────────────

export const ACTIVATE_MIN_MINUTES = 15;
export const ACTIVATE_MAX_MINUTES = 1440;
const EXPIRY_INTERVAL_MS = 30_000;

type ActivationAccount = { status: HostingAccount['status']; filesrv_mode: FileServerMode; filesrv_port: number | null };

/**
 * Pure activation rules: validates the request and returns the new
 * filesrv_active_until (undefined = unchanged, mode always).
 */
export function activationDeadline(account: ActivationAccount, minutes: number, now: Date): Date | undefined {
  if (!Number.isInteger(minutes) || minutes < ACTIVATE_MIN_MINUTES || minutes > ACTIVATE_MAX_MINUTES) {
    throw new AppError(400, `minutes must be an integer between ${ACTIVATE_MIN_MINUTES} and ${ACTIVATE_MAX_MINUTES}`, 'validation');
  }
  if (account.filesrv_mode === 'off') throw new AppError(409, 'The file server of this account is disabled', 'fileServerOff');
  if (account.status === 'suspended' || account.status === 'deleting') throw new AppError(409, 'This account is suspended', 'accountSuspended');
  if (account.filesrv_port === null || account.filesrv_port === undefined) {
    throw new AppError(409, 'No SFTP port is allocated to this account', 'fileServerNoPort');
  }
  if (account.filesrv_mode === 'always') return undefined;
  return new Date(now.getTime() + minutes * 60_000);
}

/** The errors of a pass that concern the file server (its own, or the account level that blocks it). */
export function fileServerErrors(report: ReconcileReport): string[] {
  return (report.issues ?? []).filter((i) => i.scope === 'filesrv' || i.scope === 'account').map((i) => i.message);
}

async function loadRow(accountId: number): Promise<AccountRow> {
  const row = await db('hosting_accounts').where({ id: accountId }).first() as AccountRow | undefined;
  if (!row) throw new AppError(404, 'Account not found', 'notFound');
  return row;
}

async function converge(accountId: number): Promise<void> {
  const report = await reconcileService.reconcileAccountNow(accountId);
  const errors = fileServerErrors(report);
  if (errors.length) throw new AppError(502, `File server: ${errors.join(' · ').slice(0, 500)}`, 'backendUnavailable');
}

let expiryTimer: NodeJS.Timeout | null = null;
let expiryRunning = false;

/** Clears the expired on-demand activations and queues their reconcile (the planner then stops the containers). */
export async function expireActivations(now = new Date()): Promise<number[]> {
  const rows = await db('hosting_accounts')
    .where({ filesrv_mode: 'on-demand' })
    .whereNotNull('filesrv_active_until')
    .andWhere('filesrv_active_until', '<=', now)
    .select('id', 'tenant_id') as Array<{ id: number; tenant_id: number }>;
  const expired: number[] = [];
  for (const r of rows) {
    const n = await db('hosting_accounts')
      .where({ id: r.id })
      .andWhere('filesrv_active_until', '<=', now)
      .update({ filesrv_active_until: null, updated_at: new Date() });
    if (!n) continue;
    expired.push(r.id);
    logger.info({ accountId: r.id }, 'File server activation expired');
    reconcileService.requestAccount(r.id, 'filesrv-expired');
  }
  return expired;
}

export const fileServerService = {
  async status(accountId: number): Promise<FileServerStatus> {
    const row = await loadRow(accountId);
    let running = false;
    try {
      const docker = await engineFor(row.node_id);
      const info = await inspectContainer(docker, fileServerContainer(accountId));
      running = !!info?.State?.Running;
    } catch (err) {
      logger.debug({ accountId, err: errText(err) }, 'File server status: Docker unreachable');
    }
    return {
      accountId,
      mode: row.filesrv_mode,
      running,
      port: row.filesrv_port,
      activeUntil: row.filesrv_mode === 'on-demand' ? iso(row.filesrv_active_until) : null,
    };
  },

  /** on-demand: filesrv_active_until = now + minutes, start the container. 409 when mode = off. */
  async activate(accountId: number, minutes: number): Promise<FileServerStatus> {
    const row = await loadRow(accountId);
    const until = activationDeadline(row, minutes, new Date());
    if (until !== undefined) {
      await db('hosting_accounts').where({ id: accountId }).update({ filesrv_active_until: until, updated_at: new Date() });
    }
    await converge(accountId);
    const status = await fileServerService.status(accountId);
    emitHosting(HostingSocketEvents.FILESRV_UPDATED, { accountId, running: status.running }, { tenantId: row.tenant_id, accountId });
    return status;
  },

  /** Ends an on-demand activation now (the container is stopped). Mode always: the server keeps running. */
  async deactivate(accountId: number): Promise<FileServerStatus> {
    const row = await loadRow(accountId);
    await db('hosting_accounts').where({ id: accountId }).update({ filesrv_active_until: null, updated_at: new Date() });
    await converge(accountId);
    const status = await fileServerService.status(accountId);
    emitHosting(HostingSocketEvents.FILESRV_UPDATED, { accountId, running: status.running }, { tenantId: row.tenant_id, accountId });
    return status;
  },

  /** Applies hosting_accounts.filesrv_mode now (called after a mode change). */
  async applyMode(accountId: number): Promise<void> {
    const row = await loadRow(accountId);
    if (row.filesrv_mode !== 'on-demand' && row.filesrv_active_until) {
      await db('hosting_accounts').where({ id: accountId }).update({ filesrv_active_until: null, updated_at: new Date() });
    }
    await converge(accountId);
  },

  /** Expiry worker (every 30 s). */
  start(): void {
    if (expiryTimer) return;
    expiryTimer = setInterval(() => {
      if (expiryRunning) return;
      expiryRunning = true;
      expireActivations()
        .catch((err) => logger.error({ err: errText(err) }, 'File server expiry pass failed'))
        .finally(() => { expiryRunning = false; });
    }, EXPIRY_INTERVAL_MS);
    expiryTimer.unref?.();
  },

  stop(): void {
    if (expiryTimer) clearInterval(expiryTimer);
    expiryTimer = null;
  },
};
