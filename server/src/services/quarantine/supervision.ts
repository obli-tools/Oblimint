import { DEFAULT_SITE_MAINTENANCE_SETTINGS, WINDOW_ACTIVE_STATUSES, type RiskLevel, type SiteMaintenanceSettings, type SupervisionInfo, type WindowChangeCounts, type WindowStatus } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { iso } from '../hosting/rows';
import { errText } from '../setup/docker';
import { deps } from './deps';
import { DIGEST_RETRY_MS, digestDue, digestNotification, digestShouldNotify, nextDigestAt, type DigestFacts } from './logic';

// ─────────────────────────────────────────────────────────────────────────────
// Supervised mode (P3-PLAN §12): info of a site and the periodic digest.
// The mode itself (permanent window, quarantineExecutables) belongs to the
// windows module; this file reads site_maintenance.settings (defaults merged)
// and the supervised window READ-ONLY, and owns site_maintenance.last_digest_at
// / next_digest_at. The digest calls windowService.digestSupervised (export +
// analysis without closing) and notifies 'supervision.digest' when something
// new appeared since the previous digest.
// ─────────────────────────────────────────────────────────────────────────────

interface MaintenanceRow { site_id: number; settings: unknown; last_digest_at: Date | string | null; next_digest_at: Date | string | null }

interface SupervisedWindowRow {
  id: number; status: WindowStatus; counts: unknown; risk_score: number | null; risk_level: RiskLevel | null;
  opened_at: Date | string | null; created_at: Date | string; exec_allowed_until: Date | string | null;
}

function jsonOf(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}

/** site_maintenance.settings with the defaults merged (the jsonb belongs to the windows module). */
export function settingsFrom(raw: unknown): SiteMaintenanceSettings {
  const v = jsonOf(raw);
  const s = v && typeof v === 'object' && !Array.isArray(v) ? v as Partial<SiteMaintenanceSettings> : {};
  return { ...DEFAULT_SITE_MAINTENANCE_SETTINGS, ...s };
}

function countsFrom(raw: unknown): WindowChangeCounts | null {
  const v = jsonOf(raw);
  return v && typeof v === 'object' && typeof (v as WindowChangeCounts).total === 'number' ? v as WindowChangeCounts : null;
}

async function maintenanceRow(siteId: number): Promise<MaintenanceRow | null> {
  return (await db('site_maintenance').where({ site_id: siteId }).first('site_id', 'settings', 'last_digest_at', 'next_digest_at') as MaintenanceRow | undefined) ?? null;
}

/** The non-final window of the supervised mode (read-only). */
async function supervisedWindow(siteId: number): Promise<SupervisedWindowRow | null> {
  return (await db('maintenance_windows')
    .where({ site_id: siteId, trigger: 'supervised' })
    .whereIn('status', WINDOW_ACTIVE_STATUSES as WindowStatus[])
    .orderBy('id', 'desc')
    .first('id', 'status', 'counts', 'risk_score', 'risk_level', 'opened_at', 'created_at', 'exec_allowed_until') as SupervisedWindowRow | undefined) ?? null;
}

async function supervisedQuarantined(siteId: number, since: Date | string | null): Promise<number> {
  const q = db('quarantine_items').where({ site_id: siteId, source: 'supervised' });
  if (since) q.where('detected_at', '>', since);
  const row = await q.count<{ n: string | number }[]>('id as n').first();
  return Number(row?.n ?? 0);
}

/** SupervisionInfo of a site the caller already checked. */
export async function supervisionInfo(siteId: number): Promise<SupervisionInfo> {
  const m = await maintenanceRow(siteId);
  const settings = settingsFrom(m?.settings);
  const w = await supervisedWindow(siteId);
  const opened = w ? (w.opened_at ?? w.created_at) : null;
  return {
    siteId,
    enabled: settings.supervised === true,
    windowId: w ? Number(w.id) : null,
    windowStatus: w?.status ?? null,
    pendingChanges: w ? countsFrom(w.counts)?.total ?? null : null,
    risk: w && w.risk_score !== null && w.risk_level ? { score: Number(w.risk_score), level: w.risk_level } : null,
    quarantined: w ? await supervisedQuarantined(siteId, opened) : 0,
    lastDigestAt: iso(m?.last_digest_at ?? null),
    nextDigestAt: settings.supervised ? iso(m?.next_digest_at ?? null) : null,
    execAllowedUntil: w ? iso(w.exec_allowed_until) : null,
  };
}

async function setDigestDates(siteId: number, patch: { last_digest_at?: Date; next_digest_at: Date | null }): Promise<void> {
  const now = deps.now();
  await db('site_maintenance')
    .insert({ site_id: siteId, settings: JSON.stringify({}), ...patch, created_at: now, updated_at: now })
    .onConflict('site_id')
    .merge({ ...patch, updated_at: now });
}

export type DigestOutcome = 'notSupervised' | 'notified' | 'quiet';

const inFlight = new Map<number, Promise<DigestOutcome>>();

/**
 * Runs the digest of one site now (worker or POST …/supervision/digest).
 * Throws the windows module's error (the worker reschedules a retry). One
 * digest per site at a time: a concurrent call joins the running one.
 */
export function runDigest(siteId: number): Promise<DigestOutcome> {
  let p = inFlight.get(siteId);
  if (!p) {
    p = doDigest(siteId).finally(() => inFlight.delete(siteId));
    inFlight.set(siteId, p);
  }
  return p;
}

async function doDigest(siteId: number): Promise<DigestOutcome> {
  const site = await db('sites as s').join('hosting_accounts as a', 'a.id', 's.account_id')
    .where('s.id', siteId).first('s.id', 's.name', 's.tenant_id', 's.account_id', 'a.username') as
    { id: number; name: string; tenant_id: number; account_id: number; username: string } | undefined;
  if (!site) return 'notSupervised';
  const m = await maintenanceRow(siteId);
  const settings = settingsFrom(m?.settings);
  if (!settings.supervised) return 'notSupervised';

  const before = await supervisedWindow(siteId);
  const previousTotal = before ? countsFrom(before.counts)?.total ?? null : null;
  const detail = await deps.digestSupervised(siteId);
  if (!detail) return 'notSupervised';

  const now = deps.now();
  const lastDigestAt = m?.last_digest_at ?? null;
  const facts: DigestFacts = {
    siteName: site.name,
    accountUsername: site.username,
    counts: detail.counts,
    previousTotal,
    firstDigest: lastDigestAt === null,
    risk: detail.risk,
    newQuarantined: await supervisedQuarantined(siteId, lastDigestAt ?? detail.openedAt ?? null),
  };
  const notified = digestShouldNotify(facts);
  if (notified) {
    const text = digestNotification(facts);
    deps.notify('supervision.digest', {
      tenantId: site.tenant_id,
      accountId: site.account_id,
      // One per digest (the minute stamp keeps a manual digest from being swallowed by the 1-h dedup).
      key: `supervision:digest:site:${siteId}:${now.toISOString().slice(0, 16)}`,
      title: text.title,
      message: text.message,
      severity: text.severity,
      link: `/sites/${siteId}?tab=maintenance`,
    });
  }
  await setDigestDates(siteId, { last_digest_at: now, next_digest_at: nextDigestAt(now, settings.digestIntervalHours) });
  return notified ? 'notified' : 'quiet';
}

/**
 * One tick of the digest worker: every supervised site whose next digest is
 * due. A site without a next date gets one (first digest one interval after
 * the mode was switched on); a failing digest is retried after 15 min
 * (last_digest_at untouched). Sites no longer supervised lose their next
 * date. Never throws.
 */
export async function digestTick(): Promise<{ ran: number; failed: number; scheduled: number }> {
  const out = { ran: 0, failed: 0, scheduled: 0 };
  try {
    const now = deps.now();
    // Stale schedules of sites that left the supervised mode.
    await db('site_maintenance').whereNotNull('next_digest_at')
      .whereRaw(`COALESCE(settings->>'supervised', 'false') <> 'true'`)
      .update({ next_digest_at: null, updated_at: now });
    const rows = await db('site_maintenance as m').join('sites as s', 's.id', 'm.site_id')
      .join('hosting_accounts as a', 'a.id', 's.account_id')
      .whereRaw(`m.settings->>'supervised' = 'true'`)
      .whereNot('a.status', 'deleting')
      .select('m.site_id', 'm.settings', 'm.next_digest_at') as Array<{ site_id: number; settings: unknown; next_digest_at: Date | string | null }>;
    for (const r of rows) {
      const siteId = Number(r.site_id);
      const due = digestDue(r.next_digest_at, now);
      if (due === 'wait') continue;
      if (due === 'schedule') {
        await setDigestDates(siteId, { next_digest_at: nextDigestAt(now, settingsFrom(r.settings).digestIntervalHours) });
        out.scheduled++;
        continue;
      }
      try {
        const outcome = await runDigest(siteId);
        if (outcome === 'notSupervised') await setDigestDates(siteId, { next_digest_at: null });
        out.ran++;
      } catch (err) {
        out.failed++;
        logger.warn({ siteId, err: errText(err) }, 'supervision digest failed (retried later)');
        await setDigestDates(siteId, { next_digest_at: new Date(now.getTime() + DIGEST_RETRY_MS) }).catch(() => {});
      }
    }
  } catch (err) {
    logger.warn({ err: errText(err) }, 'supervision digest tick failed');
  }
  return out;
}

/** digestNow: the windows module's error as an API error (AppError kept, anything else 502, A6). */
export async function digestForRequest(siteId: number): Promise<void> {
  let outcome: DigestOutcome;
  try {
    outcome = await runDigest(siteId);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(502, `Supervision digest: ${errText(err)}`, 'backendUnavailable');
  }
  if (outcome === 'notSupervised') throw new AppError(409, 'The site is not in supervised mode', 'notSupervised');
}
