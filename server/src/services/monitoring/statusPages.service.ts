import type { Request } from 'express';
import type { PublicStatusPage, StatusPage, StatusPageInput, StatusPageUpdate, UptimeStatus } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { auditService } from '../audit.service';
import type { HostingActor } from '../hosting/access';
import { loadOwned, type OwnedRow } from '../hosting/p4bAccess';
import { platformSettings } from '../platformSettings';
import { jsonValue, ownerForCreate, ownerOf, scopeList, toIso, type ListFilter, type RowOwner } from './common';
import { emitMonitoring } from './events';
import { cssProblem, projectStatusPage, type PublicMonitorInput } from './uptime/state';
import { uptimeRatios } from './uptime.service';

// ─────────────────────────────────────────────────────────────────────────────
// Status pages (docs/P4b-PLAN.md §10.3): CRUD for the account (or platform
// staff) + the PUBLIC projection served without a session by
// routes/publicStatus.routes.ts (invariant MO2: monitor names, statuses,
// uptime and latency only; 404 when unknown / unpublished / disabled by
// settings.monitoring.statusPagesEnabled; cached 30 s per slug).
// A page lists monitors of its OWN account (platform page: platform
// monitors of its tenant) — checked at save time and again at render time.
// ─────────────────────────────────────────────────────────────────────────────

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;
export const PUBLIC_CACHE_MS = 30_000;
const PUBLIC_CACHE_MAX = 1_000;

interface PageRow extends OwnedRow {
  slug: string;
  title: string;
  description: string | null;
  monitor_ids: unknown;
  custom_css: string | null;
  published: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

function toStatusPage(r: PageRow): StatusPage {
  return {
    id: Number(r.id),
    tenantId: Number(r.tenant_id),
    accountId: r.account_id === null ? null : Number(r.account_id),
    slug: r.slug,
    title: r.title,
    description: r.description,
    monitorIds: jsonValue<number[]>(r.monitor_ids, []).filter((n) => Number.isInteger(n)),
    customCss: r.custom_css,
    published: !!r.published,
    createdAt: toIso(r.created_at)!,
    updatedAt: toIso(r.updated_at)!,
  };
}

const slugTaken = () => new AppError(409, 'This address is already used by another status page', 'slugTaken');

function assertCss(css: string | null | undefined): string | null {
  if (css === undefined || css === null || css.trim() === '') return null;
  const problem = cssProblem(css);
  if (problem) throw new AppError(400, `Validation failed — customCss: ${problem}`, 'validation', { customCss: [problem] });
  return css;
}

/** Every id must be a monitor of the page's owner (same tenant AND same account, platform = null). */
async function assertMonitors(owner: RowOwner, ids: number[]): Promise<number[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const q = db('uptime_monitors').whereIn('id', unique).where({ tenant_id: owner.tenantId });
  if (owner.accountId === null) q.whereNull('account_id');
  else q.where({ account_id: owner.accountId });
  const found = new Set((await q.pluck('id') as number[]).map(Number));
  if (found.size !== unique.length) throw new AppError(400, 'A status page lists monitors of its own account only', 'monitorNotInAccount');
  return unique;
}

async function slugFree(slug: string, exceptId: number | null): Promise<boolean> {
  const q = db('status_pages').where({ slug });
  if (exceptId !== null) q.whereNot({ id: exceptId });
  return !(await q.first('id'));
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}

// ── public projection ────────────────────────────────────────────────────────

const cache = new Map<string, { at: number; page: PublicStatusPage | null }>();

async function buildPublic(slug: string, now: Date): Promise<PublicStatusPage | null> {
  if (!(await platformSettings.section('monitoring')).statusPagesEnabled) return null;
  const row = await db('status_pages').where({ slug, published: true }).first() as PageRow | undefined;
  if (!row) return null;
  const ids = jsonValue<number[]>(row.monitor_ids, []).filter((n) => Number.isInteger(n));
  let monitors: Array<{ id: number; name: string; status: UptimeStatus; enabled: boolean; last_latency_ms: number | null }> = [];
  if (ids.length > 0) {
    const q = db('uptime_monitors').whereIn('id', ids).where({ tenant_id: row.tenant_id });
    if (row.account_id === null) q.whereNull('account_id');
    else q.where({ account_id: row.account_id });
    monitors = await q.select('id', 'name', 'status', 'enabled', 'last_latency_ms');
  }
  const order = new Map(ids.map((id, i) => [id, i]));
  monitors.sort((a, b) => (order.get(Number(a.id)) ?? 0) - (order.get(Number(b.id)) ?? 0));
  const monitorIds = monitors.map((m) => Number(m.id));
  const ratios = await uptimeRatios(monitorIds, now);
  const from = new Date(now.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
  const daily = monitorIds.length === 0 ? [] : await db('uptime_daily').whereIn('monitor_id', monitorIds).andWhere('day', '>=', from)
    .select('monitor_id', 'day', 'checks', 'up') as Array<{ monitor_id: number; day: Date | string; checks: number; up: number }>;
  const byMonitor = new Map<number, Map<string, number>>();
  for (const d of daily) {
    const day = d.day instanceof Date ? `${d.day.getFullYear()}-${String(d.day.getMonth() + 1).padStart(2, '0')}-${String(d.day.getDate()).padStart(2, '0')}` : String(d.day).slice(0, 10);
    if (!(Number(d.checks) > 0)) continue;
    let m = byMonitor.get(Number(d.monitor_id));
    if (!m) byMonitor.set(Number(d.monitor_id), (m = new Map()));
    m.set(day, Math.round((Number(d.up) / Number(d.checks)) * 10_000) / 10_000);
  }
  const inputs: PublicMonitorInput[] = monitors.map((m) => ({
    name: m.name,
    status: m.status,
    enabled: !!m.enabled,
    uptime24h: ratios.get(Number(m.id))?.uptime24h ?? null,
    uptime30d: ratios.get(Number(m.id))?.uptime30d ?? null,
    lastLatencyMs: m.last_latency_ms === null ? null : Number(m.last_latency_ms),
    daily: byMonitor.get(Number(m.id)) ?? new Map(),
  }));
  return projectStatusPage({ slug: row.slug, title: row.title, description: row.description, customCss: row.custom_css }, inputs, now);
}

function invalidate(slug: string | null | undefined): void {
  if (slug) cache.delete(slug);
}

export const statusPageService = {
  /** Public page, cached PUBLIC_CACHE_MS (null = 404). */
  async publicPage(slug: string, now: Date = new Date()): Promise<PublicStatusPage | null> {
    if (!SLUG_RE.test(slug)) return null;
    const hit = cache.get(slug);
    if (hit && now.getTime() - hit.at < PUBLIC_CACHE_MS) return hit.page;
    const page = await buildPublic(slug, now);
    if (cache.size >= PUBLIC_CACHE_MAX) cache.clear();
    cache.set(slug, { at: now.getTime(), page });
    return page;
  },

  async list(actor: HostingActor, filter: ListFilter): Promise<StatusPage[]> {
    const rows = await scopeList(actor, db('status_pages as p'), 'p', filter).select('p.*').orderBy('p.title') as PageRow[];
    return rows.map(toStatusPage);
  },

  async get(actor: HostingActor, id: number): Promise<StatusPage> {
    return toStatusPage(await loadOwned<PageRow>(actor, 'status_pages', id, 'read', 'Status page'));
  },

  async create(req: Request, actor: HostingActor, body: StatusPageInput): Promise<StatusPage> {
    const owner = await ownerForCreate(actor, body.accountId);
    const monitorIds = await assertMonitors(owner, body.monitorIds ?? []);
    const customCss = assertCss(body.customCss);
    if (!(await slugFree(body.slug, null))) throw slugTaken();
    let row: PageRow;
    try {
      [row] = await db('status_pages').insert({
        tenant_id: owner.tenantId,
        account_id: owner.accountId,
        slug: body.slug,
        title: body.title,
        description: body.description ?? null,
        monitor_ids: JSON.stringify(monitorIds),
        custom_css: customCss,
        published: body.published ?? false,
      }).returning('*') as PageRow[];
    } catch (err) {
      if (isUniqueViolation(err)) throw slugTaken();
      throw err;
    }
    invalidate(row.slug);
    emitMonitoring({ entity: 'statusPage', id: Number(row.id), accountId: owner.accountId, action: 'created' }, owner);
    await auditService.logReqAs(req, owner.tenantId, 'uptime.statusPage.create', {
      resourceType: 'status_page', resourcePath: String(row.id), details: { slug: row.slug, accountId: owner.accountId, published: !!row.published },
    });
    return toStatusPage(row);
  },

  async update(req: Request, actor: HostingActor, id: number, body: StatusPageUpdate): Promise<StatusPage> {
    const current = await loadOwned<PageRow>(actor, 'status_pages', id, 'monitoring.manage', 'Status page');
    const owner = ownerOf(current);
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (body.slug !== undefined && body.slug !== current.slug) {
      if (!(await slugFree(body.slug, Number(current.id)))) throw slugTaken();
      patch.slug = body.slug;
    }
    if (body.title !== undefined) patch.title = body.title;
    if (body.description !== undefined) patch.description = body.description;
    if (body.monitorIds !== undefined) patch.monitor_ids = JSON.stringify(await assertMonitors(owner, body.monitorIds));
    if (body.customCss !== undefined) patch.custom_css = assertCss(body.customCss);
    if (body.published !== undefined) patch.published = body.published;
    let row: PageRow;
    try {
      [row] = await db('status_pages').where({ id: current.id }).update(patch).returning('*') as PageRow[];
    } catch (err) {
      if (isUniqueViolation(err)) throw slugTaken();
      throw err;
    }
    invalidate(current.slug);
    invalidate(row.slug);
    emitMonitoring({ entity: 'statusPage', id: Number(row.id), accountId: owner.accountId, action: 'updated' }, owner);
    await auditService.logReqAs(req, owner.tenantId, 'uptime.statusPage.update', {
      resourceType: 'status_page', resourcePath: String(row.id), details: { fields: Object.keys(body) },
    });
    return toStatusPage(row);
  },

  async remove(req: Request, actor: HostingActor, id: number): Promise<void> {
    const current = await loadOwned<PageRow>(actor, 'status_pages', id, 'monitoring.manage', 'Status page');
    const owner = ownerOf(current);
    await db('status_pages').where({ id: current.id }).delete();
    invalidate(current.slug);
    emitMonitoring({ entity: 'statusPage', id: Number(current.id), accountId: owner.accountId, action: 'deleted' }, owner);
    await auditService.logReqAs(req, owner.tenantId, 'uptime.statusPage.delete', {
      resourceType: 'status_page', resourcePath: String(current.id), details: { slug: current.slug },
    });
  },
};

/** Tests: drop the public cache. */
export function clearStatusPageCacheForTests(): void {
  cache.clear();
}
