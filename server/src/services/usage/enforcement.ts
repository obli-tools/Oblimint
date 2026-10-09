import type { Knex } from 'knex';
import type {
  HostingAccountStatus, OverQuotaAction, OverQuotaState, PlanLimits, QuotaDimension, QuotaGauge, UsageAlertScope,
} from '@oblimint/shared';
import { HostingSocketEvents } from '@oblimint/shared';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { loadTenantLimits } from '../hosting/envelope.service';
import { emitHosting } from '../hosting/events';
import { planLimits } from '../hosting/rows';
import { platformSettings } from '../platformSettings';
import {
  DIMENSION_LABELS_FR, alertPeriod, gaugeOf, humanValue, mbToBytes, monthOf, monthRange,
} from './gauges';
import { notify } from './notifications.service';

// ─────────────────────────────────────────────────────────────────────────────
// Quota evaluation and enforcement (module usage, docs/P2-PLAN.md §9.5).
//
// Every 10 min (and on requestEvaluate: disk measured, plan changed…): gauges
// of each account (disk, monthly traffic, databases, database size) and of
// each tenant envelope (disk, traffic) against `usage.alertThresholds` →
// usage_alerts (one per scope / dimension / period / threshold; period = the
// month for traffic, 'current' otherwise) + notify('quota.warning' below
// 100 %, 'quota.exceeded' from 100 %) + USAGE_ALERT. An alert whose level is
// no longer reached is cleared (cleared_at); reached again → reopened and
// notified again.
//
// At 100 % of the DISK or the TRAFFIC the plan's overQuotaAction applies ONCE
// per period (decideEnforcement, pure):
//   warn          over_quota_state 'warn';
//   block-uploads 'blocked' (uploadsBlocked → SFTP read + delete only;
//                 publishing unaffected);
//   suspend       compare-and-set status active → suspended, state
//                 'suspended', same side effects as a staff suspension
//                 (reconcile, edge, file server, HOSTING_CHANGED, audit
//                 'account.suspend' {reason: 'overQuota', dimension}).
// The 'suspended' state outlives a staff unsuspension: a staff member who
// reactivates an auto-suspended account is not overruled before the next
// period. Back under 100 % → 'warn' / 'blocked' lifted; an auto-suspended
// account is reactivated (monthly reset on the 1st, UTC: the traffic of the
// new month starts at 0 → audit 'account.unsuspend' {reason: 'monthlyReset'}).
// ─────────────────────────────────────────────────────────────────────────────

/** Dimensions whose 100 % triggers the plan's over-quota action. */
export const ACTION_DIMENSIONS: readonly QuotaDimension[] = ['disk', 'traffic'];

export type EnforcementStep =
  | { kind: 'none' }
  | { kind: 'setState'; state: OverQuotaState; reason: 'overQuota' | 'underQuota' }
  | { kind: 'suspend'; dimension: QuotaDimension }
  | { kind: 'reactivate'; reason: 'monthlyReset' | 'underQuota' };

export interface EnforcementInput {
  status: HostingAccountStatus;
  state: OverQuotaState;
  action: OverQuotaAction;
  /** Action dimensions at ≥ 100 % (disk first). */
  breached: QuotaDimension[];
  /** over_quota_since is before the current month (a new traffic period began). */
  periodChanged: boolean;
}

const TARGET_STATE: Record<OverQuotaAction, OverQuotaState> = { warn: 'warn', 'block-uploads': 'blocked', suspend: 'suspended' };

/** What to do with one account (pure). */
export function decideEnforcement(i: EnforcementInput): EnforcementStep {
  if (i.status === 'deleting') return { kind: 'none' };
  const target = TARGET_STATE[i.action] ?? 'warn';
  if (i.breached.length > 0) {
    if (i.state === 'suspended') {
      // Applied once this period: still suspended, or a staff member reactivated it.
      // A new traffic period (disk not involved) re-arms the action for an active account.
      const newPeriod = i.periodChanged && !i.breached.includes('disk');
      if (newPeriod && i.status === 'active' && target === 'suspended') return { kind: 'suspend', dimension: i.breached[0] };
      if (newPeriod && i.status === 'active') return { kind: 'setState', state: target, reason: 'overQuota' };
      return { kind: 'none' };
    }
    if (target === 'suspended') {
      // Only an active account is auto-suspended (a staff suspension is never taken over:
      // the monthly reset would otherwise reactivate it).
      return i.status === 'active' ? { kind: 'suspend', dimension: i.breached[0] } : { kind: 'none' };
    }
    return i.state === target ? { kind: 'none' } : { kind: 'setState', state: target, reason: 'overQuota' };
  }
  if (i.state === 'ok') return { kind: 'none' };
  if (i.state === 'suspended' && i.status === 'suspended') return { kind: 'reactivate', reason: i.periodChanged ? 'monthlyReset' : 'underQuota' };
  return { kind: 'setState', state: 'ok', reason: 'underQuota' };
}

/** Account gauges (pure). dbUsage null = unknown (no database gauges). */
export function accountGauges(
  limits: PlanLimits,
  usage: { diskUsedBytes: number | null; trafficBytes: number; dbUsage: { databases: number; sizeBytes: number | null } | null },
  thresholds: readonly number[],
): QuotaGauge[] {
  const out: QuotaGauge[] = [
    gaugeOf('disk', usage.diskUsedBytes ?? 0, mbToBytes(limits.diskMb), thresholds),
    gaugeOf('traffic', usage.trafficBytes, mbToBytes(limits.trafficMbPerMonth), thresholds),
  ];
  if (usage.dbUsage) {
    out.push(gaugeOf('databases', usage.dbUsage.databases, limits.maxDatabases ?? null, thresholds));
    out.push(gaugeOf('dbSize', usage.dbUsage.sizeBytes ?? 0, mbToBytes(limits.dbMaxSizeMb ?? null), thresholds));
  }
  return out;
}

/** Action dimensions at ≥ 100 % (pure). */
export function breachedDimensions(gauges: QuotaGauge[]): QuotaDimension[] {
  return gauges.filter((g) => ACTION_DIMENSIONS.includes(g.dimension) && g.pct !== null && g.pct >= 100).map((g) => g.dimension);
}

// ── Side effects (injectable) ────────────────────────────────────────────────

export interface EnforcementEffects {
  /** Status changed (suspended / reactivated): reconcile, edge, file server. Never throws. */
  statusChanged(accountId: number, suspended: boolean): Promise<void>;
  /**
   * Entered 'blocked' (block-uploads): the reduced SFTP permissions are only
   * computed at login (SFTPGo auth hook), so the open sessions are dropped
   * (file server restarted) and the clients log in again read + delete only.
   * Never throws. Optional (tests).
   */
  uploadsBlocked?(accountId: number): Promise<void>;
}

const defaultEffects: EnforcementEffects = {
  async statusChanged(accountId, suspended) {
    const reason = suspended ? 'suspended' : 'unsuspended';
    try {
      const { reconcileService } = await import('../docker/reconcile.service');
      reconcileService.requestAccount(accountId, reason);
    } catch (err) { logger.warn({ err, accountId }, 'reconcileService.requestAccount failed'); }
    try {
      const { edgeService } = await import('../edge/edge.service');
      edgeService.scheduleSync(`account ${accountId} ${reason} (quota)`);
    } catch (err) { logger.warn({ err, accountId }, 'edgeService.scheduleSync failed'); }
    try {
      const { fileServerService } = await import('../docker/filesrv.service');
      await fileServerService.applyMode(accountId);
    } catch (err) { logger.warn({ err, accountId }, 'fileServerService.applyMode failed (the reconcile will retry)'); }
    try {
      const { dnsService } = await import('../dns/dns.service');
      dnsService.accountChanged(accountId, `${reason} (quota)`);
    } catch (err) { logger.warn({ err, accountId }, 'dnsService.accountChanged failed'); }
  },
  async uploadsBlocked(accountId) {
    try {
      const { fileServerService } = await import('../docker/filesrv.service');
      await fileServerService.dropSessions(accountId);
    } catch (err) { logger.warn({ err, accountId }, 'fileServerService.dropSessions failed (open SFTP sessions keep write access until they reconnect)'); }
  },
};

let effects: EnforcementEffects = defaultEffects;

/** Tests: replace the side effects (null restores). */
export function setEnforcementEffectsForTests(e: EnforcementEffects | null): void {
  effects = e ?? defaultEffects;
}

/** Tests: replace the database usage source (null restores databaseService.accountDbUsage). */
let dbUsageOverride: ((accountId: number) => Promise<{ instances: number; databases: number; sizeBytes: number | null }>) | null = null;
export function setDbUsageSourceForTests(fn: typeof dbUsageOverride): void {
  dbUsageOverride = fn;
}

export async function accountDbUsage(accountId: number): Promise<{ instances: number; databases: number; sizeBytes: number | null } | null> {
  try {
    if (dbUsageOverride) return await dbUsageOverride(accountId);
    const { databaseService } = await import('../databases/databases.service');
    return await databaseService.accountDbUsage(accountId);
  } catch (err) {
    logger.debug({ err, accountId }, 'accountDbUsage unavailable');
    return null;
  }
}

// ── Alerts ───────────────────────────────────────────────────────────────────

interface AlertRow {
  id: number; tenant_id: number; account_id: number | null; scope: UsageAlertScope; dimension: QuotaDimension; level: number;
  period: string; used: number | string; limit_value: number | string; notified_at: Date | null; cleared_at: Date | null; created_at: Date;
}

export interface AlertSubject {
  scope: UsageAlertScope;
  tenantId: number;
  accountId: number | null;
  /** Account username or tenant name (notification text). */
  name: string;
  action?: OverQuotaAction;
}

const ACTION_LABELS_FR: Record<OverQuotaAction, string> = {
  warn: 'avertissement seulement',
  'block-uploads': 'blocage des envois de fichiers (SFTP en lecture et suppression seulement)',
  suspend: 'suspension du compte',
};

function alertText(s: AlertSubject, g: QuotaGauge, level: number): { title: string; message: string } {
  const label = DIMENSION_LABELS_FR[g.dimension];
  const pct = `${Math.round(g.pct ?? 0)} %`;
  const used = humanValue(g.dimension, g.used);
  const limit = humanValue(g.dimension, g.limit ?? 0);
  const who = s.scope === 'account' ? `Compte ${s.name}` : `Revendeur ${s.name}`;
  const title = level >= 100 ? `${who} : quota de ${label} dépassé (${pct})` : `${who} : ${label} à ${pct} du quota`;
  const lines = [
    s.scope === 'account'
      ? `Le compte « ${s.name} » utilise ${used} sur ${limit} (${pct}) de son quota de ${label}.`
      : `Les comptes du revendeur « ${s.name} » utilisent ${used} sur ${limit} (${pct}) de son enveloppe de ${label}.`,
  ];
  if (g.dimension === 'traffic') lines.push('Le compteur de trafic repart à zéro le 1er du mois (UTC).');
  if (level >= 100 && s.scope === 'account' && s.action && ACTION_DIMENSIONS.includes(g.dimension)) {
    lines.push(`Action prévue par le plan : ${ACTION_LABELS_FR[s.action]}.`);
  }
  return { title, message: lines.join('\n') };
}

/**
 * Creates / reopens / clears the alerts of one subject from its gauges and
 * notifies new ones. Returns the ids of the alerts notified.
 */
export async function syncAlerts(subject: AlertSubject, gauges: QuotaGauge[], month: string, conn: Knex = db): Promise<number[]> {
  const notified: number[] = [];
  for (const g of gauges) {
    const period = alertPeriod(g.dimension, month);
    const existing = await conn('usage_alerts')
      .where({ scope: subject.scope, tenant_id: subject.tenantId, dimension: g.dimension, period })
      .andWhere((qb) => { if (subject.accountId === null) qb.whereNull('account_id'); else qb.where('account_id', subject.accountId); })
      .select('*') as AlertRow[];
    const reached = g.limit === null ? null : g.level;
    const toClear = existing.filter((a) => a.cleared_at === null && (reached === null || a.level > reached)).map((a) => a.id);
    if (toClear.length) await conn('usage_alerts').whereIn('id', toClear).update({ cleared_at: conn.fn.now() });
    if (reached === null || g.limit === null) continue;

    const current = existing.find((a) => a.level === reached);
    let alertId: number | null = null;
    if (!current) {
      const ins = await conn.raw(`
        INSERT INTO usage_alerts (tenant_id, account_id, scope, dimension, level, period, used, limit_value, notified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, now())
        ON CONFLICT (scope, tenant_id, (COALESCE(account_id, 0)), dimension, period, level) DO NOTHING
        RETURNING id`, [subject.tenantId, subject.accountId, subject.scope, g.dimension, reached, period, Math.round(g.used), Math.round(g.limit)]);
      const row = (ins as { rows?: Array<{ id: number }> }).rows?.[0];
      if (row) alertId = Number(row.id);
    } else if (current.cleared_at !== null) {
      await conn('usage_alerts').where({ id: current.id }).update({ cleared_at: null, used: Math.round(g.used), limit_value: Math.round(g.limit), notified_at: conn.fn.now() });
      alertId = current.id;
    } else if (Number(current.used) !== Math.round(g.used) || Number(current.limit_value) !== Math.round(g.limit)) {
      await conn('usage_alerts').where({ id: current.id }).update({ used: Math.round(g.used), limit_value: Math.round(g.limit) });
    }
    if (alertId === null) continue;

    notified.push(alertId);
    const text = alertText(subject, g, reached);
    notify(reached >= 100 ? 'quota.exceeded' : 'quota.warning', {
      tenantId: subject.tenantId,
      accountId: subject.accountId,
      key: `quota:${subject.scope}:${subject.tenantId}:${subject.accountId ?? 0}:${g.dimension}:${period}:${reached}`,
      title: text.title,
      message: text.message,
      severity: reached >= 100 ? 'critical' : 'warning',
      platform: subject.scope === 'tenant',
      link: subject.scope === 'account' ? `/accounts/${subject.accountId}?tab=usage` : '/usage',
    });
    emitHosting(HostingSocketEvents.USAGE_ALERT, { alertId, accountId: subject.accountId, tenantId: subject.tenantId, level: reached },
      { tenantId: subject.tenantId, accountId: subject.accountId });
  }
  return notified;
}

/** Traffic alerts of past months are closed (the monthly reset). */
export async function clearPastTrafficAlerts(month: string, conn: Knex = db): Promise<void> {
  await conn('usage_alerts').where({ dimension: 'traffic' }).whereNull('cleared_at').andWhere('period', '<', month).update({ cleared_at: conn.fn.now() });
}

// ── Evaluation ───────────────────────────────────────────────────────────────

interface EvalAccountRow {
  id: number; tenant_id: number; username: string; status: HostingAccountStatus;
  over_quota_state: OverQuotaState | null; over_quota_since: Date | string | null;
  disk_used_bytes: number | string | null; plan_limits: unknown;
}

const selectEvalAccounts = (conn: Knex) => conn('hosting_accounts as a')
  .join('plans as p', 'p.id', 'a.plan_id')
  .select('a.id', 'a.tenant_id', 'a.username', 'a.status', 'a.over_quota_state', 'a.over_quota_since', 'a.disk_used_bytes', 'p.limits as plan_limits');

/** Month traffic (bytes out) per account. */
async function trafficByAccount(month: string, accountIds: number[] | null, conn: Knex): Promise<Map<number, number>> {
  const { start, end } = monthRange(month);
  const q = conn('usage_traffic_daily').where('day', '>=', start).andWhere('day', '<', end)
    .groupBy('account_id').select('account_id', conn.raw('COALESCE(SUM(bytes_out), 0) AS b'));
  if (accountIds) q.whereIn('account_id', accountIds);
  const rows = await q as Array<{ account_id: number; b: string | number }>;
  return new Map(rows.map((r) => [Number(r.account_id), Number(r.b)]));
}

async function thresholds(): Promise<number[]> {
  try {
    return (await platformSettings.section('usage')).alertThresholds;
  } catch {
    return [80, 100];
  }
}

const SUSPEND_MESSAGE: Record<string, string> = {
  disk: 'Compte suspendu automatiquement : quota disque dépassé.',
  traffic: 'Compte suspendu automatiquement : quota de trafic mensuel dépassé. Réactivation automatique le 1er du mois.',
};

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

function emitAccount(accountId: number, tenantId: number): void {
  emitHosting(HostingSocketEvents.HOSTING_CHANGED, { entity: 'account', id: accountId, accountId, action: 'updated' }, { tenantId, accountId });
}

/** Applies one decided step (compare-and-set on the observed state / status). */
async function applyStep(row: EvalAccountRow, step: EnforcementStep, breached: QuotaDimension[], conn: Knex): Promise<void> {
  const from = row.over_quota_state ?? 'ok';
  const base = { username: row.username };
  const link = `/accounts/${row.id}?tab=usage`;
  if (step.kind === 'setState') {
    const n = await conn('hosting_accounts').where({ id: row.id, tenant_id: row.tenant_id, over_quota_state: from })
      .update({ over_quota_state: step.state, over_quota_since: step.state === 'ok' ? null : conn.fn.now(), updated_at: conn.fn.now() });
    if (!n) return;
    await auditService.log({
      tenantId: row.tenant_id, action: 'account.over_quota', resourceType: 'account', resourcePath: String(row.id),
      details: { ...base, from, to: step.state, reason: step.reason, ...(breached[0] ? { dimension: breached[0] } : {}) },
    });
    emitAccount(row.id, row.tenant_id);
    if (step.state === 'blocked') {
      // Open SFTP sessions keep the permissions of their login: dropped now.
      if (effects.uploadsBlocked) await effects.uploadsBlocked(row.id);
      notify('quota.action', {
        tenantId: row.tenant_id, accountId: row.id, key: `quota-action:${row.id}:blocked:${Date.now()}`,
        title: `Compte ${row.username} : envois de fichiers bloqués`,
        message: `Le compte « ${row.username} » a atteint 100 % de son quota (${breached.map((d) => DIMENSION_LABELS_FR[d]).join(', ')}). `
          + 'Le SFTP ne permet plus que la lecture et la suppression ; la publication des sites continue de fonctionner.',
        severity: 'critical', link,
      });
    } else if (from === 'blocked' && step.state === 'ok') {
      notify('quota.action', {
        tenantId: row.tenant_id, accountId: row.id, key: `quota-action:${row.id}:unblocked:${Date.now()}`,
        title: `Compte ${row.username} : envois de fichiers réautorisés`,
        message: `Le compte « ${row.username} » est repassé sous son quota : les envois SFTP sont de nouveau autorisés.`,
        severity: 'info', link,
      });
    }
    return;
  }
  if (step.kind === 'suspend') {
    const n = await conn('hosting_accounts').where({ id: row.id, tenant_id: row.tenant_id, status: 'active' })
      .update({
        status: 'suspended', status_message: SUSPEND_MESSAGE[step.dimension] ?? SUSPEND_MESSAGE.disk,
        over_quota_state: 'suspended', over_quota_since: conn.fn.now(), updated_at: conn.fn.now(),
      });
    if (!n) return;
    await auditService.log({
      tenantId: row.tenant_id, action: 'account.suspend', resourceType: 'account', resourcePath: String(row.id),
      details: { ...base, reason: 'overQuota', dimension: step.dimension },
    });
    emitAccount(row.id, row.tenant_id);
    await effects.statusChanged(row.id, true);
    notify('quota.action', {
      tenantId: row.tenant_id, accountId: row.id, key: `quota-action:${row.id}:suspended:${Date.now()}`,
      title: `Compte ${row.username} suspendu (quota de ${DIMENSION_LABELS_FR[step.dimension]} dépassé)`,
      message: `Le compte « ${row.username} » a atteint 100 % de son quota de ${DIMENSION_LABELS_FR[step.dimension]} : il a été suspendu automatiquement, conformément à son plan.`
        + (step.dimension === 'traffic' ? '\nIl sera réactivé automatiquement le 1er du mois (UTC).' : '\nUn membre de l\'équipe peut le réactiver depuis sa fiche.'),
      severity: 'critical', link,
    });
    return;
  }
  if (step.kind === 'reactivate') {
    // Only OUR suspension is lifted: a staff member who suspended the account again
    // after reactivating it keeps it suspended (the state just returns to 'ok').
    const lastSuspend = await conn('audit_logs')
      .where({ tenant_id: row.tenant_id, action: 'account.suspend', resource_type: 'account', resource_path: String(row.id) })
      .orderBy('id', 'desc').first('details') as { details: unknown } | undefined;
    const details = typeof lastSuspend?.details === 'string' ? safeJson(lastSuspend.details) : lastSuspend?.details;
    if ((details as { reason?: unknown } | null)?.reason !== 'overQuota') {
      await applyStep(row, { kind: 'setState', state: 'ok', reason: 'underQuota' }, breached, conn);
      return;
    }
    // 'monthlyReset' only when the suspension was for the traffic: a disk suspension
    // lifted in a new month (plan raised, files deleted) is an 'underQuota' one.
    const suspendedFor = (details as { dimension?: unknown } | null)?.dimension;
    const reason: 'monthlyReset' | 'underQuota' = step.reason === 'monthlyReset' && suspendedFor === 'traffic' ? 'monthlyReset' : 'underQuota';
    const n = await conn('hosting_accounts').where({ id: row.id, tenant_id: row.tenant_id, status: 'suspended', over_quota_state: 'suspended' })
      .update({ status: 'active', status_message: null, over_quota_state: 'ok', over_quota_since: null, updated_at: conn.fn.now() });
    if (!n) return;
    await auditService.log({
      tenantId: row.tenant_id, action: 'account.unsuspend', resourceType: 'account', resourcePath: String(row.id),
      details: { ...base, reason },
    });
    emitAccount(row.id, row.tenant_id);
    await effects.statusChanged(row.id, false);
    notify('quota.action', {
      tenantId: row.tenant_id, accountId: row.id, key: `quota-action:${row.id}:reactivated:${Date.now()}`,
      title: `Compte ${row.username} réactivé`,
      message: reason === 'monthlyReset'
        ? `Nouveau mois : le compteur de trafic du compte « ${row.username} » est remis à zéro, le compte a été réactivé.`
        : `Le compte « ${row.username} » est repassé sous ses quotas : il a été réactivé.`,
      severity: 'info', link,
    });
  }
}

async function evaluateRow(row: EvalAccountRow, ctx: { month: string; thresholds: number[]; traffic: number }, conn: Knex): Promise<void> {
  if (row.status === 'deleting') return;
  const limits = planLimits(row.plan_limits);
  const dbUsage = await accountDbUsage(row.id);
  const gauges = accountGauges(limits, {
    diskUsedBytes: row.disk_used_bytes === null || row.disk_used_bytes === undefined ? null : Number(row.disk_used_bytes),
    trafficBytes: ctx.traffic,
    dbUsage,
  }, ctx.thresholds);
  await syncAlerts({ scope: 'account', tenantId: row.tenant_id, accountId: row.id, name: row.username, action: limits.overQuotaAction }, gauges, ctx.month, conn);
  const breached = breachedDimensions(gauges);
  const since = row.over_quota_since ? new Date(row.over_quota_since) : null;
  const monthStart = new Date(`${monthRange(ctx.month).start}T00:00:00Z`);
  const step = decideEnforcement({
    status: row.status,
    state: row.over_quota_state ?? 'ok',
    action: limits.overQuotaAction ?? 'warn',
    breached,
    periodChanged: since !== null && since.getTime() < monthStart.getTime(),
  });
  if (step.kind !== 'none') await applyStep(row, step, breached, conn);
}

/** Evaluates one account now (thresholds, alerts, action). Throws on database errors. */
export async function evaluateAccount(accountId: number, conn: Knex = db, now: Date = new Date()): Promise<void> {
  const row = await selectEvalAccounts(conn).where('a.id', accountId).first() as EvalAccountRow | undefined;
  if (!row) return;
  const month = monthOf(now);
  const traffic = (await trafficByAccount(month, [accountId], conn)).get(accountId) ?? 0;
  await evaluateRow(row, { month, thresholds: await thresholds(), traffic }, conn);
}

/** Tenant envelope gauges (disk = sum of the accounts' disk, traffic = month sum). */
export async function tenantEnvelopeGauges(tenantId: number, month: string, th: readonly number[], conn: Knex = db): Promise<QuotaGauge[]> {
  const limits = await loadTenantLimits(tenantId, conn);
  const { start, end } = monthRange(month);
  const disk = await conn('hosting_accounts').where({ tenant_id: tenantId }).whereNot('status', 'deleting')
    .first(conn.raw('COALESCE(SUM(disk_used_bytes), 0) AS b')) as { b: string | number } | undefined;
  const traffic = await conn('usage_traffic_daily').where({ tenant_id: tenantId }).andWhere('day', '>=', start).andWhere('day', '<', end)
    .first(conn.raw('COALESCE(SUM(bytes_out), 0) AS b')) as { b: string | number } | undefined;
  return [
    gaugeOf('disk', Number(disk?.b ?? 0), mbToBytes(limits.diskMb), th),
    gaugeOf('traffic', Number(traffic?.b ?? 0), mbToBytes(limits.trafficMbPerMonth), th),
  ];
}

/** Full pass: every account, then every tenant envelope; closes past traffic alerts. */
export async function evaluateAll(conn: Knex = db, now: Date = new Date()): Promise<void> {
  const month = monthOf(now);
  const th = await thresholds();
  await clearPastTrafficAlerts(month, conn);
  const rows = await selectEvalAccounts(conn).whereNot('a.status', 'deleting').orderBy('a.id') as EvalAccountRow[];
  const traffic = await trafficByAccount(month, null, conn);
  for (const row of rows) {
    try {
      await evaluateRow(row, { month, thresholds: th, traffic: traffic.get(row.id) ?? 0 }, conn);
    } catch (err) {
      logger.warn({ err, accountId: row.id }, 'Quota evaluation failed');
    }
  }
  const tenants = await conn('tenants').select('id', 'name') as Array<{ id: number; name: string }>;
  for (const t of tenants) {
    try {
      const gauges = await tenantEnvelopeGauges(t.id, month, th, conn);
      await syncAlerts({ scope: 'tenant', tenantId: t.id, accountId: null, name: t.name }, gauges, month, conn);
    } catch (err) {
      logger.warn({ err, tenantId: t.id }, 'Tenant envelope evaluation failed');
    }
  }
}

// ── Worker ───────────────────────────────────────────────────────────────────

export const EVALUATE_INTERVAL_MS = 10 * 60 * 1000;
const TICK_MS = 60 * 1000;
const FIRST_PASS_DELAY_MS = 90 * 1000;
const REQUEST_DEBOUNCE_MS = 2_000;

let chain: Promise<void> = Promise.resolve();
/** Serializes evaluations (one account is never evaluated twice concurrently). */
function exclusive(fn: () => Promise<void>): Promise<void> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

let tickTimer: NodeJS.Timeout | null = null;
let firstTimer: NodeJS.Timeout | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
const pending = new Set<number>();
let lastFullPass = 0;
let lastMonth: string | null = null;

async function runFullPass(reason: string): Promise<void> {
  lastFullPass = Date.now();
  await exclusive(async () => {
    try {
      await evaluateAll();
    } catch (err) {
      logger.warn({ err, reason }, 'Quota evaluation pass failed');
    }
  });
}

function tick(): void {
  const month = monthOf();
  if (lastMonth !== null && month !== lastMonth) {
    lastMonth = month;
    logger.info({ month }, 'New month: monthly traffic reset');
    void runFullPass('monthly-reset');
    return;
  }
  lastMonth = month;
  if (Date.now() - lastFullPass >= EVALUATE_INTERVAL_MS) void runFullPass('interval');
}

export const enforcementService = {
  /** Re-evaluates the quotas of one account soon (debounced). Never throws. */
  requestEvaluate(accountId: number, reason: string): void {
    try {
      if (!Number.isInteger(accountId) || accountId <= 0) return;
      pending.add(accountId);
      if (debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        const ids = [...pending];
        pending.clear();
        for (const id of ids) {
          void exclusive(() => evaluateAccount(id)).catch((err) => logger.warn({ err, accountId: id, reason }, 'Quota evaluation failed'));
        }
      }, REQUEST_DEBOUNCE_MS);
      debounceTimer.unref?.();
    } catch (err) {
      logger.warn({ err, accountId }, 'requestEvaluate failed');
    }
  },

  /**
   * CROSS-MODULE (internalServer SFTP auth hook): true when the account's
   * over_quota_state is 'blocked' → the SFTP user gets read + delete only.
   * Never throws (false on error).
   */
  async uploadsBlocked(accountId: number): Promise<boolean> {
    try {
      if (!Number.isInteger(accountId) || accountId <= 0) return false;
      const row = await db('hosting_accounts').where({ id: accountId }).first('over_quota_state') as { over_quota_state: OverQuotaState | null } | undefined;
      return row?.over_quota_state === 'blocked';
    } catch (err) {
      logger.warn({ err, accountId }, 'uploadsBlocked lookup failed');
      return false;
    }
  },

  /** Evaluation loop (10 min) + monthly traffic reset (1st of the month, UTC). Returns at once. */
  start(): void {
    if (tickTimer) return;
    lastMonth = monthOf();
    firstTimer = setTimeout(() => { void runFullPass('boot'); }, FIRST_PASS_DELAY_MS);
    firstTimer.unref?.();
    lastFullPass = Date.now(); // the boot pass above stands for the first interval
    tickTimer = setInterval(tick, TICK_MS);
    tickTimer.unref?.();
  },

  stop(): void {
    if (tickTimer) clearInterval(tickTimer);
    if (firstTimer) clearTimeout(firstTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
    tickTimer = null;
    firstTimer = null;
    debounceTimer = null;
    pending.clear();
  },
};
