import type { FileServerMode, FileServerStatus, HostingAccount } from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { emitHosting } from '../hosting/events';
import { fileServerContainer } from '../hosting/naming';
import { iso, type AccountRow } from '../hosting/rows';
import { errText } from '../setup/docker';
import { inspectContainer, restartContainer } from './dockerOps';
import { engineFor } from './engine';
import { reconcileService, type ReconcileReport } from './reconcile.service';

// ─────────────────────────────────────────────────────────────────────────────
// Per-account file server (SFTPGo container, ARCHITECTURE §3.3, P1-PLAN §10).
// Modes: always (kept running by the reconcile), on-demand (started by
// activate(), stopped by the expiry worker at filesrv_active_until, or by
// the hostd port gateway on connection — P2, see activateFromGateway), off
// (never runs, container removed).
// The container itself is converged by the reconcile (planner.ts decides
// from mode / active_until); this service changes the rows and runs a pass.
// ─────────────────────────────────────────────────────────────────────────────

export const ACTIVATE_MIN_MINUTES = 15;
export const ACTIVATE_MAX_MINUTES = 1440;
const EXPIRY_INTERVAL_MS = 30_000;
/** P2: window opened by a gateway activation, kept extended while hostd reports activity (until its 'idle'). */
export const GATEWAY_ACTIVATION_MINUTES = 15;
/** Extend a gateway window when less than this is left. */
const GATEWAY_EXTEND_BEFORE_MS = 5 * 60_000;

/**
 * Activations made by the hostd port gateway (socket activation) are
 * PERSISTED: hosting_accounts.filesrv_gateway_until = the filesrv_active_until
 * the gateway set. The window is the gateway's while both columns are equal:
 * a manual activation, a manual stop or an expiry changes filesrv_active_until
 * (and clears the marker), the gateway then neither extends nor stops it. It
 * survives a panel restart: the windows keep being extended while sessions
 * last (in memory, a restart let them expire under active transfers).
 */
const sameInstant = (a: Date | string | null | undefined, b: Date | string | null | undefined): boolean => {
  const x = tsOf(a);
  return x !== null && x === tsOf(b);
};

const tsOf = (v: Date | string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const t = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * Pure rule of a gateway activation (on-demand mode): the new deadline, or
 * null when a LONGER window is already open (a manual "2 h" activation is
 * never shortened, and stays manual).
 */
export function gatewayDeadline(current: Date | string | null, now: Date): Date | null {
  const until = new Date(now.getTime() + GATEWAY_ACTIVATION_MINUTES * 60_000);
  const cur = tsOf(current);
  return cur !== null && cur > until.getTime() ? null : until;
}

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
      .update({ filesrv_active_until: null, filesrv_gateway_until: null, updated_at: new Date() });
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
    // A manual window is never stopped by the gateway: its marker is cleared.
    await db('hosting_accounts').where({ id: accountId })
      .update({ ...(until !== undefined ? { filesrv_active_until: until } : {}), filesrv_gateway_until: null, updated_at: new Date() });
    await converge(accountId);
    const status = await fileServerService.status(accountId);
    emitHosting(HostingSocketEvents.FILESRV_UPDATED, { accountId, running: status.running }, { tenantId: row.tenant_id, accountId });
    return status;
  },

  /** Ends an on-demand activation now (the container is stopped). Mode always: the server keeps running. */
  async deactivate(accountId: number): Promise<FileServerStatus> {
    const row = await loadRow(accountId);
    await db('hosting_accounts').where({ id: accountId }).update({ filesrv_active_until: null, filesrv_gateway_until: null, updated_at: new Date() });
    await converge(accountId);
    const status = await fileServerService.status(accountId);
    emitHosting(HostingSocketEvents.FILESRV_UPDATED, { accountId, running: status.running }, { tenantId: row.tenant_id, accountId });
    return status;
  },

  /**
   * P2 — a client connected to the hostd port gateway while the server was
   * stopped. Same checks as activate() (409 fileServerOff / accountSuspended /
   * fileServerNoPort); on-demand: opens a GATEWAY_ACTIVATION_MINUTES window
   * (kept extended until the gateway reports 'idle') unless a longer manual
   * window is open; always: just converges. Starts the container.
   */
  async activateFromGateway(accountId: number): Promise<FileServerStatus> {
    const row = await loadRow(accountId);
    const now = new Date();
    activationDeadline(row, ACTIVATE_MIN_MINUTES, now); // validation only (mode, status, port)
    if (row.filesrv_mode === 'on-demand') {
      const until = gatewayDeadline(row.filesrv_active_until, now);
      if (until) {
        await db('hosting_accounts').where({ id: accountId })
          .update({ filesrv_active_until: until, filesrv_gateway_until: until, updated_at: new Date() });
        logger.info({ accountId, until: until.toISOString() }, 'File server activated by a connection (port gateway)');
      }
    }
    await converge(accountId);
    const status = await fileServerService.status(accountId);
    emitHosting(HostingSocketEvents.FILESRV_UPDATED, { accountId, running: status.running }, { tenantId: row.tenant_id, accountId });
    return status;
  },

  /** Is the current window of this account the gateway's (not a manual one)? */
  async isGatewayActivation(accountId: number): Promise<boolean> {
    const row = await db('hosting_accounts').where({ id: accountId }).first('filesrv_mode', 'filesrv_active_until', 'filesrv_gateway_until') as
      (Pick<AccountRow, 'filesrv_mode' | 'filesrv_active_until'> & { filesrv_gateway_until: Date | string | null }) | undefined;
    return !!row && row.filesrv_mode === 'on-demand' && sameInstant(row.filesrv_active_until, row.filesrv_gateway_until);
  },

  /**
   * The gateway saw no connection for its idle timeout: stops the server
   * when the window is the gateway's (a manual window runs to its end).
   * Returns whether it stopped.
   */
  async endGatewayActivation(accountId: number): Promise<boolean> {
    if (!(await fileServerService.isGatewayActivation(accountId))) return false;
    await fileServerService.deactivate(accountId);
    logger.info({ accountId }, 'File server stopped after inactivity (port gateway)');
    return true;
  },

  /**
   * Keeps the gateway windows open while connections last (the gateway
   * emits 'idle' after its idle timeout without any connection, and REPEATS
   * it every 5 min while still idle — a lost event, long poll cut or queue
   * overflow, therefore never keeps the server running forever; the repeats
   * are cheap no-ops once the window is closed): extends those ending
   * within 5 min. Called by the firewall worker.
   */
  async extendGatewayActivations(now = new Date()): Promise<number[]> {
    const extended: number[] = [];
    // Gateway windows (both columns equal) ending within 5 min — from the DB,
    // so a panel restart never lets them lapse under active sessions.
    const rows = await db('hosting_accounts')
      .where({ filesrv_mode: 'on-demand' })
      .whereNotNull('filesrv_gateway_until')
      .whereRaw('filesrv_gateway_until = filesrv_active_until')
      .andWhere('filesrv_active_until', '<=', new Date(now.getTime() + GATEWAY_EXTEND_BEFORE_MS))
      .select('id', 'filesrv_active_until') as Array<{ id: number; filesrv_active_until: Date | string }>;
    for (const r of rows) {
      const mine = tsOf(r.filesrv_active_until);
      if (mine === null) continue;
      const until = new Date(now.getTime() + GATEWAY_ACTIVATION_MINUTES * 60_000);
      // Compare-and-set: a manual activation / stop / expiry meanwhile wins.
      const n = await db('hosting_accounts')
        .where({ id: r.id, filesrv_mode: 'on-demand', filesrv_active_until: new Date(mine), filesrv_gateway_until: new Date(mine) })
        .update({ filesrv_active_until: until, filesrv_gateway_until: until, updated_at: new Date() });
      if (n) extended.push(Number(r.id));
    }
    return extended;
  },

  /**
   * Drops every open SFTP session of the account (restart of its running
   * file server; nothing when it is stopped). Used when the permissions
   * change mid-session (block-uploads): SFTPGo applies the permissions of
   * the login (auth hook), so the clients must log in again. Returns whether
   * the container was restarted. Throws when Docker fails.
   */
  async dropSessions(accountId: number): Promise<boolean> {
    const row = await loadRow(accountId);
    const docker = await engineFor(row.node_id);
    const name = fileServerContainer(accountId);
    const info = await inspectContainer(docker, name);
    if (!info?.State?.Running) return false;
    await restartContainer(docker, name);
    logger.info({ accountId }, 'File server restarted: open SFTP sessions dropped (permissions changed)');
    return true;
  },

  /** Applies hosting_accounts.filesrv_mode now (called after a mode change). */
  async applyMode(accountId: number): Promise<void> {
    const row = await loadRow(accountId);
    if (row.filesrv_mode !== 'on-demand' && row.filesrv_active_until) {
      await db('hosting_accounts').where({ id: accountId }).update({ filesrv_active_until: null, filesrv_gateway_until: null, updated_at: new Date() });
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
