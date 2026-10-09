import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { hostdFor } from '../hostd/client';
import { planLimits, type AccountRow } from './rows';

// ─────────────────────────────────────────────────────────────────────────────
// Disk usage worker: every 10 min, hostdFor(node).usage(accountId) for each
// active account → hosting_accounts.disk_used_bytes / quota_mode /
// usage_checked_at; over quota in `measured` mode (no XFS project quota to
// enforce it) → audit `account.quota_exceeded` + logger.warn, once per
// crossing (the previous measurement was under the quota).
// P2: owned by module `usage`. Each measurement also writes the daily point
// usage_disk_daily (largest value of the UTC day) and asks the quota
// enforcement to re-evaluate the account (alerts, over-quota action).
// ─────────────────────────────────────────────────────────────────────────────

export const USAGE_INTERVAL_MS = 10 * 60 * 1000;
/** First pass shortly after boot (the reconcile has created the trees by then). */
const FIRST_RUN_DELAY_MS = 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let firstRun: NodeJS.Timeout | null = null;
let running = false;

const MIB = 1024 * 1024;

/** True when `used` crosses the quota (null quota = unlimited). Pure. */
export function isOverQuota(usedBytes: number | null, quotaBytes: number | null): boolean {
  return usedBytes !== null && quotaBytes !== null && usedBytes > quotaBytes;
}

/** API refreshes of one account closer than this reuse the last measurement. */
export const USAGE_REFRESH_COOLDOWN_MS = 30 * 1000;
const onDemandInFlight = new Map<number, Promise<void>>();
const lastOnDemand = new Map<number, number>();

/** usage_disk_daily point of today (UTC): the largest measurement of the day. Never throws. */
export async function recordDailyDisk(accountId: number, usedBytes: number, now: Date = new Date()): Promise<void> {
  try {
    await db('usage_disk_daily')
      .insert({ day: now.toISOString().slice(0, 10), account_id: accountId, used_bytes: usedBytes })
      .onConflict(['day', 'account_id'])
      .merge({ used_bytes: db.raw('GREATEST(usage_disk_daily.used_bytes, excluded.used_bytes)') } as never);
  } catch (err) {
    logger.debug({ err, accountId }, 'Daily disk point not recorded');
  }
}

/** Quota enforcement after a measurement (lazy import: the usage module pulls the notification plugins). */
function requestEvaluate(accountId: number): void {
  import('../usage/usage.service')
    .then((m) => m.enforcementService.requestEvaluate(accountId, 'disk-measured'))
    .catch((err) => logger.debug({ err, accountId }, 'Quota evaluation request failed'));
}

export const usageService = {
  /**
   * POST /accounts/:id/usage/refresh: any member may ask (read), and in
   * measured mode hostd walks the whole account tree. Concurrent asks for one
   * account share ONE measurement, and a measurement less than 30 s old is
   * reused: a loop of requests cannot keep hostd walking trees.
   */
  async refreshOnDemand(accountId: number): Promise<void> {
    const running = onDemandInFlight.get(accountId);
    if (running) return running;
    const last = lastOnDemand.get(accountId);
    if (last !== undefined && Date.now() - last < USAGE_REFRESH_COOLDOWN_MS) return;
    const p = (async () => {
      await this.refresh(accountId);
      if (lastOnDemand.size > 100_000) lastOnDemand.clear();
      lastOnDemand.set(accountId, Date.now());
    })().finally(() => { onDemandInFlight.delete(accountId); });
    onDemandInFlight.set(accountId, p);
    return p;
  },

  /** Refresh one account now (API "refresh usage"). Throws when hostd fails. */
  async refresh(accountId: number): Promise<void> {
    const row = await db('hosting_accounts as a')
      .join('plans as p', 'p.id', 'a.plan_id')
      .where('a.id', accountId)
      .first('a.id', 'a.tenant_id', 'a.node_id', 'a.username', 'a.disk_used_bytes', 'p.limits as plan_limits') as
      (Pick<AccountRow, 'id' | 'tenant_id' | 'node_id' | 'username' | 'disk_used_bytes' | 'plan_limits'>) | undefined;
    if (!row) throw new AppError(404, 'Account not found', 'notFound');

    const usage = await hostdFor(row.node_id).usage(row.id);
    const usedBytes = Math.max(0, Math.round(Number(usage.usedBytes) || 0));
    await db('hosting_accounts').where({ id: row.id, tenant_id: row.tenant_id }).update({
      disk_used_bytes: usedBytes,
      quota_mode: usage.mode,
      usage_checked_at: db.fn.now(),
    });

    await recordDailyDisk(row.id, usedBytes);
    requestEvaluate(row.id);

    if (usage.mode !== 'measured') return;
    const diskMb = planLimits(row.plan_limits).diskMb;
    const quotaBytes = usage.quotaBytes ?? (diskMb === null ? null : diskMb * MIB);
    const previous = row.disk_used_bytes === null || row.disk_used_bytes === undefined ? null : Number(row.disk_used_bytes);
    if (isOverQuota(usedBytes, quotaBytes) && !isOverQuota(previous, quotaBytes)) {
      logger.warn({ accountId: row.id, username: row.username, usedBytes, quotaBytes }, 'Hosting account over its disk quota (measured mode)');
      await auditService.log({
        tenantId: row.tenant_id,
        action: 'account.quota_exceeded',
        resourceType: 'account',
        resourcePath: String(row.id),
        details: { username: row.username, usedMb: Math.round(usedBytes / MIB), quotaMb: Math.round((quotaBytes ?? 0) / MIB) },
      });
    }
  },

  /** One pass over the active accounts, sequential (hostd runs du), errors logged. */
  async refreshAll(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const ids = await db('hosting_accounts').where({ status: 'active' }).orderBy('id').pluck('id') as number[];
      for (const id of ids) {
        try {
          await this.refresh(id);
        } catch (err) {
          logger.warn({ err, accountId: id }, 'Disk usage refresh failed');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Disk usage pass failed');
    } finally {
      running = false;
    }
  },

  start(): void {
    if (timer) return;
    const tick = () => { void this.refreshAll(); };
    firstRun = setTimeout(tick, FIRST_RUN_DELAY_MS);
    firstRun.unref?.();
    timer = setInterval(tick, USAGE_INTERVAL_MS);
    timer.unref?.();
  },

  stop(): void {
    if (firstRun) clearTimeout(firstRun);
    if (timer) clearInterval(timer);
    firstRun = null;
    timer = null;
  },
};
