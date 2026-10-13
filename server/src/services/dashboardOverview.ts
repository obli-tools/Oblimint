import type { DashboardOverview } from '@oblimint/shared';
import type { Knex } from 'knex';
import { db } from '../db';
import { auditService } from './audit.service';
import { actorHasNeedSomewhere, scopeToActor, type HostingActor } from './hosting/access';

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard health and activity (GET /api/dashboard/overview). Every list goes
// through scopeToActor: the god view sees every workspace, tenant staff its
// workspace, a client only the accounts it belongs to. The audit activity is
// for administrators only (a client never sees who did what in the workspace).
// ─────────────────────────────────────────────────────────────────────────────

const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);
const num = (v: unknown) => Number(v ?? 0);
const countOf = async (q: Knex.QueryBuilder): Promise<number> => num(((await q.count('* as c').first()) as { c?: unknown } | undefined)?.c);

const EMPTY: DashboardOverview = {
  sites: { total: 0, byStatus: { active: 0, stopped: 0, error: 0, provisioning: 0 }, problems: [] },
  pending: { approvals: 0, windowsToReview: 0, quarantined: 0, failedReleases: 0, domainsUnverified: 0 },
  releases: [],
  certificates: { expiring: [], failed: [] },
  uptime: { up: 0, down: 0, paused: 0, pending: 0, downList: [] },
  activity: [],
};

const PRIMARY_DOMAIN = `(SELECT d.name FROM site_routes sr JOIN domains d ON d.id = sr.domain_id
  WHERE sr.site_id = s.id ORDER BY (sr.path_prefix = '/') DESC, sr.id ASC LIMIT 1)`;

export async function dashboardOverview(actor: HostingActor): Promise<DashboardOverview> {
  const canRead = actor.kind === 'client' || actorHasNeedSomewhere(actor, 'read');
  if (!canRead) return EMPTY;
  const scope = (qb: Knex.QueryBuilder, alias: string, accountCol = 'account_id') =>
    scopeToActor(actor, qb, { tenant: `${alias}.tenant_id`, account: `${alias}.${accountCol}` });
  const sites = () => scope(db('sites as s'), 's');
  const releasesQ = () => scope(db('releases as r').join('sites as s', 's.id', 'r.site_id'), 's');
  const certs = () => scope(db('certificates as c').join('domains as d', 'd.id', 'c.domain_id'), 'd');
  const monitors = () => scope(db('uptime_monitors as m'), 'm').where('m.enabled', true);
  const soon = new Date(Date.now() + 14 * 86_400_000);
  const dayAgo = new Date(Date.now() - 86_400_000);

  const [statusRows, problems, approvals, windows, quarantined, failed, unverified, releases, expiring, certFailed, monitorRows, down] = await Promise.all([
    sites().select('s.status').count('* as c').groupBy('s.status') as Promise<Array<{ status: string; c: unknown }>>,
    sites().where('s.status', 'error').orderBy('s.updated_at', 'desc').limit(8)
      .select('s.id', 's.name', 's.status_message', db.raw(`${PRIMARY_DOMAIN} as primary_domain`)) as
      Promise<Array<{ id: number; name: string; status_message: string | null; primary_domain: string | null }>>,
    countOf(releasesQ().where('r.status', 'awaiting_approval')),
    countOf(scope(db('maintenance_windows as w'), 'w').where('w.status', 'pending_review')),
    countOf(scope(db('quarantine_items as q'), 'q').where('q.status', 'quarantined')),
    countOf(releasesQ().where('r.status', 'failed').andWhere('r.created_at', '>=', dayAgo)),
    countOf(scope(db('domains as d'), 'd').whereNot('d.verification_status', 'verified')),
    releasesQ().orderBy('r.created_at', 'desc').limit(8)
      .select('r.id', 'r.site_id', 's.name as site_name', 'r.number', 'r.status', 'r.trigger', 'r.message', 'r.created_at', 'r.published_at') as
      Promise<Array<{ id: number; site_id: number; site_name: string; number: number; status: string; trigger: string; message: string | null; created_at: Date; published_at: Date | null }>>,
    certs().where('c.status', 'valid').andWhere('c.not_after', '<', soon).orderBy('c.not_after').limit(8)
      .select('c.primary_name', 'c.not_after') as Promise<Array<{ primary_name: string; not_after: Date }>>,
    certs().where('c.status', 'failed').orderBy('c.updated_at', 'desc').limit(8)
      .select('c.primary_name', 'c.last_error') as Promise<Array<{ primary_name: string; last_error: string | null }>>,
    monitors().select('m.status').count('* as c').groupBy('m.status') as Promise<Array<{ status: string; c: unknown }>>,
    monitors().where('m.status', 'down').orderBy('m.last_checked_at', 'desc').limit(8)
      .select('m.id', 'm.name', 'm.last_error', 'm.last_checked_at') as Promise<Array<{ id: number; name: string; last_error: string | null; last_checked_at: Date | null }>>,
  ]);

  const byStatus = { active: 0, stopped: 0, error: 0, provisioning: 0 };
  for (const r of statusRows) if (r.status in byStatus) byStatus[r.status as keyof typeof byStatus] = num(r.c);
  const uptime = { up: 0, down: 0, paused: 0, pending: 0 };
  for (const r of monitorRows) if (r.status in uptime) uptime[r.status as keyof typeof uptime] = num(r.c);

  let activity: DashboardOverview['activity'] = [];
  // Audit log: the same audience as its page (platform / workspace administrators).
  if (actor.kind === 'staff' && actor.caps === '*') {
    try {
      const { items } = await auditService.list({ tenantId: actor.tenantId, globalView: actor.globalView, limit: 10 });
      activity = items.map((a) => ({
        id: a.id, action: a.action, username: a.username, resourceType: a.resourceType, resourceName: a.resourceName,
        createdAt: a.createdAt, tenantName: a.tenantName,
      }));
    } catch { /* the activity is optional */ }
  }

  return {
    sites: {
      total: Object.values(byStatus).reduce((a, b) => a + b, 0),
      byStatus,
      problems: problems.map((p) => ({ id: p.id, name: p.name, primaryDomain: p.primary_domain, statusMessage: p.status_message })),
    },
    pending: { approvals, windowsToReview: windows, quarantined, failedReleases: failed, domainsUnverified: unverified },
    releases: releases.map((r) => ({
      id: r.id, siteId: r.site_id, siteName: r.site_name, number: r.number, status: r.status, trigger: r.trigger, message: r.message,
      createdAt: iso(r.created_at) as string, publishedAt: iso(r.published_at),
    })),
    certificates: {
      expiring: expiring.map((c) => ({ name: c.primary_name, notAfter: iso(c.not_after) as string })),
      failed: certFailed.map((c) => ({ name: c.primary_name, error: c.last_error })),
    },
    uptime: { ...uptime, downList: down.map((m) => ({ id: m.id, name: m.name, lastError: m.last_error, lastCheckedAt: iso(m.last_checked_at) })) },
    activity,
  };
}
