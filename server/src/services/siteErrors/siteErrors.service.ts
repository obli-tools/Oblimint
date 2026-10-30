import type Docker from 'dockerode';
import type { Knex } from 'knex';
import { z } from 'zod';
import {
  SITE_ERROR_LIST_MAX, SITE_ERROR_MAX_GROUPS, SITE_ERROR_RETENTION_DAYS,
  type SiteErrorClass, type SiteErrorGroup, type SiteErrorGroupDetail, type SiteErrorLevel, type SiteErrorList, type SiteErrorReleaseSummary,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { engineFor } from '../docker/engine';
import { loadSite, type HostingActor } from '../hosting/access';
import { LABELS } from '../hosting/naming';
import type { Readable } from 'stream';
import { withTimeout } from '../setup/docker';
import { containerRoleOf } from '../logs/dockerLogs';
import { fingerprintOf, hintOf, parseLines, sampleOf, tsKey, type ErrorEvent } from './parse';
import { readStderrAfter, sinceParam, type ByteBudget, type StderrRead } from './readLogs';

// ─────────────────────────────────────────────────────────────────────────────
// PHP errors grouped by release (migration 025, shared/siteErrors.ts).
//
// Collector (worker 'php-errors', every minute): for each LIVE site container
// (primary, secondaries — never a preview, whose code is not live), an
// incremental `docker logs --since <cursor>` of stderr, STREAMED (readLogs.ts)
// under byte budgets — CONTAINER_BYTES per container, PASS_BYTES per pass —
// and a timeout that aborts the request (at most FETCH_TAIL lines per pass
// and container: a burst beyond is lost, bounded), parse (parse.ts),
// attribution to a release — the number in the /srv/releases/<n>/ path,
// otherwise the release live at that time (site_release_switches, kept by a
// trigger), otherwise 0 (unknown) — then an additive upsert per (site,
// release number, fingerprint) and the cursors, in ONE transaction per site
// (batches in savepoints, a refused row skipped: the cursors always move).
// Bounds: SITE_ERROR_MAX_GROUPS per site (least recently seen out),
// SITE_ERROR_RETENTION_DAYS (hourly purge), one masked sample per group.
//
// Readers (panel, /api/v1, MCP): loadSite(actor, id, 'read') first — the
// same right as the error log the groups come from — then site_id AND
// tenant_id of THAT site.
// ─────────────────────────────────────────────────────────────────────────────

export const COLLECT_INTERVAL_MS = 60_000;
const FIRST_COLLECT_DELAY_MS = 20_000;
const MAINTENANCE_EVERY_MS = 60 * 60_000;
/** Lines read per container and pass (docker logs tail). */
export const FETCH_TAIL = 20_000;
/** First read of a container: this far back at most. */
const FIRST_LOOKBACK_MS = 60 * 60_000;
const LOGS_TIMEOUT_MS = 20_000;
/** Bytes of `docker logs` read per container and pass (the rest waits for the next pass). */
export const CONTAINER_BYTES = 4 * 1024 * 1024;
/** Bytes read per pass, all containers together (containers beyond wait for the next pass). */
export const PASS_BYTES = 64 * 1024 * 1024;
const CONCURRENCY = 4;
const DAY_MS = 86_400_000;

interface CollectSite { id: number; tenant_id: number; account_id: number; node_id: number }
interface LiveContainer { site: CollectSite; name: string; role: string }

interface GroupRow {
  id: number | string; tenant_id: number; site_id: number; release_id: number | null; release_number: number; fingerprint: string;
  level: SiteErrorLevel; error_class: SiteErrorClass | null; message: string; file: string | null; line: number | null;
  count: number | string; first_seen: Date | string; last_seen: Date | string; container: string | null; sample: string; sample_at: Date | string;
  is_new?: boolean;
}

const iso = (v: Date | string): string => new Date(v).toISOString();

function groupOf(r: GroupRow): SiteErrorGroup {
  return {
    id: Number(r.id),
    siteId: Number(r.site_id),
    releaseId: r.release_id !== null ? Number(r.release_id) : null,
    releaseNumber: Number(r.release_number),
    fingerprint: r.fingerprint,
    level: r.level,
    errorClass: r.error_class,
    message: r.message,
    file: r.file,
    line: r.line !== null ? Number(r.line) : null,
    count: Number(r.count),
    firstSeen: iso(r.first_seen),
    lastSeen: iso(r.last_seen),
    container: r.container,
    newInRelease: r.is_new === true,
    hint: hintOf(r.error_class),
  };
}

/** SQL of "first time in a known release of the site" (alias g). */
const IS_NEW_SQL = `(g.release_number > 0 AND NOT EXISTS (
  SELECT 1 FROM site_error_groups o WHERE o.site_id = g.site_id AND o.fingerprint = g.fingerprint
    AND o.release_number > 0 AND o.release_number < g.release_number))`;

// ── attribution ──────────────────────────────────────────────────────────────

interface Switch { at: number; releaseId: number | null; releaseNumber: number | null }

/** Release live at `t` (the last switch at or before it), or null. */
export function liveAt(switches: readonly Switch[], t: number): Switch | null {
  let found: Switch | null = null;
  for (const s of switches) {
    if (s.at <= t) found = s;
    else break;
  }
  return found;
}

export interface Attributed { releaseId: number | null; releaseNumber: number }

/** Release of one event: the number of its path first, otherwise the release live at its time, otherwise unknown (0). */
export function attribute(e: ErrorEvent, at: number, numbers: ReadonlyMap<number, number>, switches: readonly Switch[]): Attributed {
  if (e.releaseNumber !== null && e.releaseNumber > 0) return { releaseId: numbers.get(e.releaseNumber) ?? null, releaseNumber: e.releaseNumber };
  const s = liveAt(switches, at);
  if (s && s.releaseNumber !== null && s.releaseNumber > 0) return { releaseId: s.releaseId, releaseNumber: s.releaseNumber };
  return { releaseId: null, releaseNumber: 0 };
}

interface Aggregate {
  releaseId: number | null; releaseNumber: number; fingerprint: string; event: ErrorEvent;
  count: number; first: number; last: number; container: string;
}

/** Events of one site → one aggregate per (release number, fingerprint), the newest event as sample. */
export function aggregate(
  events: Array<{ e: ErrorEvent; container: string }>, numbers: ReadonlyMap<number, number>, switches: readonly Switch[], now: number,
): Aggregate[] {
  const map = new Map<string, Aggregate>();
  for (const { e, container } of events) {
    const t = Date.parse(e.at);
    const at = Number.isNaN(t) ? now : t;
    const r = attribute(e, at, numbers, switches);
    const fingerprint = fingerprintOf(e);
    const key = `${r.releaseNumber}:${fingerprint}`;
    const cur = map.get(key);
    if (!cur) {
      map.set(key, { ...r, fingerprint, event: e, count: 1, first: at, last: at, container });
      continue;
    }
    cur.count += 1;
    if (at < cur.first) cur.first = at;
    if (at >= cur.last) { cur.last = at; cur.event = e; cur.container = container; }
  }
  return [...map.values()];
}

// ── collector ────────────────────────────────────────────────────────────────

async function liveContainers(docker: Docker, sites: Map<number, CollectSite>): Promise<LiveContainer[]> {
  const list = await withTimeout(docker.listContainers({ all: true, filters: { label: [LABELS.site] } }), LOGS_TIMEOUT_MS, 'list site containers');
  const out: LiveContainer[] = [];
  for (const c of list) {
    const role = containerRoleOf(c.Labels);
    if (role !== 'primary' && !role?.startsWith('secondary-')) continue;
    const site = sites.get(Number(c.Labels?.[LABELS.site]));
    if (!site || c.Labels?.[LABELS.account] !== String(site.account_id)) continue;
    out.push({ site, role, name: (c.Names?.[0] ?? c.Id).replace(/^\//, '').slice(0, 128) });
  }
  return out;
}

/** `docker logs` (no follow) as a STREAM — dockerode only streams with follow, so the request is dialed directly. */
function openLogStream(docker: Docker, name: string, opts: Record<string, unknown>, signal: AbortSignal): Promise<Readable> {
  const c = docker.getContainer(name) as unknown as { id: string; modem: { dial(o: unknown, cb: (err: unknown, data: unknown) => void): void } };
  return new Promise((resolve, reject) => {
    c.modem.dial({
      path: `/containers/${encodeURIComponent(c.id)}/logs?`,
      method: 'GET',
      abortSignal: signal,
      isStream: true,
      statusCodes: { 200: true, 404: 'no such container', 500: 'server error' },
      options: opts,
    }, (err, data) => (err ? reject(err) : resolve(data as Readable)));
  });
}

/**
 * stderr lines of a container after the cursor (Docker timestamps, nano
 * precision kept), streamed under a byte budget (CONTAINER_BYTES, and what
 * is left of the pass budget) and a timeout that really stops the request.
 */
async function readAfter(docker: Docker, c: LiveContainer, cursor: string | null, now: number, pass: ByteBudget): Promise<StderrRead> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), LOGS_TIMEOUT_MS);
  try {
    const stream = await openLogStream(docker, c.name, {
      follow: false, stdout: false, stderr: true, timestamps: true, tail: FETCH_TAIL,
      since: sinceParam(cursor, now - FIRST_LOOKBACK_MS),
    }, ac.signal);
    return await readStderrAfter(stream, cursor, { maxBytes: CONTAINER_BYTES, pass, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function siteReleaseContext(trx: Knex | Knex.Transaction, siteId: number): Promise<{ numbers: Map<number, number>; switches: Switch[] }> {
  const rels = await trx('releases').where({ site_id: siteId }).select('id', 'number') as Array<{ id: number; number: number }>;
  const sw = await trx('site_release_switches').where({ site_id: siteId }).orderBy([{ column: 'switched_at', order: 'asc' }, { column: 'id', order: 'asc' }])
    .select('release_id', 'release_number', 'switched_at') as Array<{ release_id: number | null; release_number: number | null; switched_at: Date | string }>;
  return {
    numbers: new Map(rels.map((r) => [Number(r.number), Number(r.id)])),
    switches: sw.map((s) => ({ at: new Date(s.switched_at).getTime(), releaseId: s.release_id !== null ? Number(s.release_id) : null, releaseNumber: s.release_number !== null ? Number(s.release_number) : null })),
  };
}

/**
 * Writes the aggregates of one site and its cursors (one transaction), then
 * keeps the newest SITE_ERROR_MAX_GROUPS groups. Each batch runs in a
 * savepoint; a batch PostgreSQL refuses is retried row by row and the
 * refused row is skipped (logged): one poison line never blocks the cursors,
 * so the same lines are not re-read and refused on every pass.
 */
async function storeSite(
  site: CollectSite, events: Array<{ e: ErrorEvent; container: string }>, cursors: Array<{ container: string; last: string }>, now: number,
): Promise<{ written: number; skipped: number }> {
  return db.transaction(async (trx) => {
    let written = 0;
    let skipped = 0;
    if (events.length) {
      const ctx = await siteReleaseContext(trx, site.id);
      const aggs = aggregate(events, ctx.numbers, ctx.switches, now);
      const rows = aggs.map((a) => ({
        tenant_id: site.tenant_id, site_id: site.id, release_id: a.releaseId, release_number: a.releaseNumber, fingerprint: a.fingerprint,
        level: a.event.level, error_class: a.event.errorClass, message: a.event.message, file: a.event.file, line: a.event.line,
        count: a.count, first_seen: new Date(a.first), last_seen: new Date(a.last), container: a.container.slice(0, 64),
        sample: sampleOf(a.event), sample_at: new Date(a.last),
      }));
      const upsert = (t: Knex.Transaction, batch: typeof rows) => t('site_error_groups').insert(batch)
        .onConflict(['site_id', 'release_number', 'fingerprint'])
        .merge({
          count: t.raw('site_error_groups.count + excluded.count'),
          first_seen: t.raw('LEAST(site_error_groups.first_seen, excluded.first_seen)'),
          last_seen: t.raw('GREATEST(site_error_groups.last_seen, excluded.last_seen)'),
          release_id: t.raw('COALESCE(site_error_groups.release_id, excluded.release_id)'),
          message: t.raw('CASE WHEN excluded.sample_at >= site_error_groups.sample_at THEN excluded.message ELSE site_error_groups.message END'),
          container: t.raw('CASE WHEN excluded.sample_at >= site_error_groups.sample_at THEN excluded.container ELSE site_error_groups.container END'),
          sample: t.raw('CASE WHEN excluded.sample_at >= site_error_groups.sample_at THEN excluded.sample ELSE site_error_groups.sample END'),
          sample_at: t.raw('GREATEST(site_error_groups.sample_at, excluded.sample_at)'),
        });
      for (let i = 0; i < rows.length; i += 200) {
        const batch = rows.slice(i, i + 200);
        try {
          await trx.transaction(async (sp) => { await upsert(sp, batch); });
          written += batch.length;
        } catch {
          for (const row of batch) {
            try {
              await trx.transaction(async (sp) => { await upsert(sp, [row]); });
              written += 1;
            } catch (err) {
              skipped += 1;
              logger.warn({ err: (err as Error)?.message, siteId: site.id, fingerprint: row.fingerprint }, 'PHP errors: group refused by the database, skipped');
            }
          }
        }
      }
      await trx.raw(`DELETE FROM site_error_groups WHERE id IN (
        SELECT id FROM site_error_groups WHERE site_id = ? ORDER BY last_seen DESC, id DESC OFFSET ?)`, [site.id, SITE_ERROR_MAX_GROUPS]);
    }
    for (const c of cursors) {
      await trx('site_error_cursors').insert({ site_id: site.id, container: c.container, last_ts: c.last, updated_at: new Date(now) })
        .onConflict(['site_id', 'container']).merge(['last_ts', 'updated_at']);
    }
    return { written, skipped };
  });
}

export interface CollectResult {
  containers: number; events: number; groups: number; failed: number;
  /** Containers whose read was cut by the byte budget / left for the next pass (pass budget spent). */
  truncated: number; deferred: number;
  /** Groups not stored (a row PostgreSQL refused: skipped, the rest and the cursors still written). */
  skipped: number;
}

let collecting = false;

/** One pass over every live site container of every node. Never throws. */
export async function collectOnce(now: Date = new Date()): Promise<CollectResult> {
  const result: CollectResult = { containers: 0, events: 0, groups: 0, failed: 0, truncated: 0, deferred: 0, skipped: 0 };
  if (collecting) return result;
  collecting = true;
  const pass: ByteBudget = { left: PASS_BYTES };
  try {
    const rows = await db('sites as s').join('hosting_accounts as a', 'a.id', 's.account_id')
      .select('s.id', 's.tenant_id', 's.account_id', 'a.node_id') as CollectSite[];
    const sites = new Map(rows.map((r) => [Number(r.id), { id: Number(r.id), tenant_id: Number(r.tenant_id), account_id: Number(r.account_id), node_id: Number(r.node_id) }]));
    const nodes = [...new Set([...sites.values()].map((s) => s.node_id))];
    for (const nodeId of nodes) {
      let docker: Docker;
      let containers: LiveContainer[];
      try {
        docker = await engineFor(nodeId);
        const nodeSites = new Map([...sites].filter(([, s]) => s.node_id === nodeId));
        containers = await liveContainers(docker, nodeSites);
      } catch (err) {
        logger.debug({ err: (err as Error)?.message, nodeId }, 'PHP errors: node skipped (Docker unavailable?)');
        result.failed += 1;
        continue;
      }
      const ids = [...new Set(containers.map((c) => c.site.id))];
      const cursorRows = ids.length
        ? await db('site_error_cursors').whereIn('site_id', ids).select('site_id', 'container', 'last_ts') as Array<{ site_id: number; container: string; last_ts: string }>
        : [];
      const cursors = new Map(cursorRows.map((c) => [`${c.site_id}:${c.container}`, c.last_ts]));
      const bySite = new Map<number, LiveContainer[]>();
      for (const c of containers) bySite.set(c.site.id, [...(bySite.get(c.site.id) ?? []), c]);
      const queue = [...bySite.values()];
      const worker = async () => {
        for (let list = queue.shift(); list; list = queue.shift()) {
          const site = list[0].site;
          const events: Array<{ e: ErrorEvent; container: string }> = [];
          const moved: Array<{ container: string; last: string }> = [];
          for (const c of list) {
            const cursor = cursors.get(`${site.id}:${c.name}`) ?? null;
            // Pass budget spent: this container waits for the next pass (cursor unchanged).
            if (pass.left <= 0) { result.deferred += 1; continue; }
            try {
              const r = await readAfter(docker, c, cursor, now.getTime(), pass);
              result.containers += 1;
              if (r.truncated) result.truncated += 1;
              for (const e of parseLines(r.lines)) events.push({ e, container: c.role });
              // Always written: updated_at says the container was read (collectedAt, stale cursor purge).
              // Cut by the budget: up to the last complete line only, never "now".
              const last = r.last ?? (r.truncated ? cursor : tsKey(now.toISOString()));
              if (last) moved.push({ container: c.name, last });
            } catch (err) {
              if ((err as { statusCode?: number })?.statusCode !== 404) {
                logger.debug({ err: (err as Error)?.message, container: c.name }, 'PHP errors: container logs not read');
                result.failed += 1;
              }
            }
          }
          if (!events.length && !moved.length) continue;
          try {
            const s = await storeSite(site, events, moved, now.getTime());
            result.groups += s.written;
            result.skipped += s.skipped;
            result.events += events.length;
          } catch (err) {
            logger.warn({ err, siteId: site.id }, 'PHP errors: store failed (lines read again next pass)');
            result.failed += 1;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    }
  } catch (err) {
    logger.warn({ err }, 'PHP errors: collection pass failed');
    result.failed += 1;
  } finally {
    collecting = false;
  }
  return result;
}

/** Retention: groups unseen for SITE_ERROR_RETENTION_DAYS, old switches (the newest per site kept), stale cursors. */
export async function maintenance(now: Date = new Date()): Promise<{ groups: number; switches: number; cursors: number }> {
  const cutoff = new Date(now.getTime() - SITE_ERROR_RETENTION_DAYS * DAY_MS);
  const groups = await db('site_error_groups').where('last_seen', '<', cutoff).del();
  const sw = await db.raw(`DELETE FROM site_release_switches w WHERE w.switched_at < ?
    AND EXISTS (SELECT 1 FROM site_release_switches n WHERE n.site_id = w.site_id AND n.switched_at < ? AND (n.switched_at, n.id) > (w.switched_at, w.id))`, [cutoff, cutoff]) as { rowCount?: number };
  const cursors = await db('site_error_cursors').where('updated_at', '<', new Date(now.getTime() - 7 * DAY_MS)).del();
  return { groups, switches: Number(sw.rowCount ?? 0), cursors };
}

// ── readers ──────────────────────────────────────────────────────────────────

export interface ErrorListQuery {
  releaseId?: number | null;
  sinceReleaseId?: number | null;
  newOnly?: boolean | null;
  level?: string | null;
  limit?: number | null;
}

const LEVELS: readonly SiteErrorLevel[] = ['fatal', 'parse', 'warning', 'notice', 'deprecated'];

/** Query string of the panel and /api/v1 lists (snake_case). */
export const errorListShape = z.object({
  release_id: z.coerce.number().int().positive().optional(),
  since_release_id: z.coerce.number().int().positive().optional(),
  new_only: z.enum(['1', 'true', '0', 'false']).optional(),
  level: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(SITE_ERROR_LIST_MAX).optional(),
});
export type ErrorListShape = z.infer<typeof errorListShape>;

export function errorListQuery(q: ErrorListShape): ErrorListQuery {
  return {
    releaseId: q.release_id ?? null,
    sinceReleaseId: q.since_release_id ?? null,
    newOnly: q.new_only === '1' || q.new_only === 'true',
    level: q.level ?? null,
    limit: q.limit ?? null,
  };
}

async function releaseNumberOf(siteId: number, releaseId: number): Promise<number> {
  const r = await db('releases').where({ id: releaseId, site_id: siteId }).first('number') as { number: number } | undefined;
  if (!r) throw new AppError(404, 'Release not found', 'notFound');
  return Number(r.number);
}

export const siteErrorsService = {
  async list(actor: HostingActor, siteId: number, q: ErrorListQuery = {}): Promise<SiteErrorList> {
    const site = await loadSite(actor, siteId, 'read');
    const limit = Math.min(SITE_ERROR_LIST_MAX, Math.max(1, Math.floor(Number(q.limit ?? 50)) || 50));
    let levels: SiteErrorLevel[] | null = null;
    if (q.level) {
      levels = String(q.level).split(',').map((s) => s.trim()).filter(Boolean) as SiteErrorLevel[];
      if (!levels.length || levels.some((l) => !LEVELS.includes(l))) {
        throw new AppError(400, 'Unknown level (fatal, parse, warning, notice, deprecated)', 'validation', { level: ['invalid'] });
      }
    }
    const exact = q.releaseId ? await releaseNumberOf(site.id, Number(q.releaseId)) : null;
    const from = q.sinceReleaseId ? await releaseNumberOf(site.id, Number(q.sinceReleaseId)) : null;

    const base = () => {
      const b = db('site_error_groups as g').where({ 'g.site_id': site.id, 'g.tenant_id': site.tenant_id });
      if (exact !== null) b.where('g.release_number', exact);
      if (from !== null) b.where('g.release_number', '>=', from);
      if (levels) b.whereIn('g.level', levels);
      if (q.newOnly) b.whereRaw(IS_NEW_SQL);
      return b;
    };
    const totalRow = await base().count({ n: '*' }).first() as { n: string | number } | undefined;
    const rows = await base().select('g.*', db.raw(`${IS_NEW_SQL} AS is_new`))
      .orderBy([{ column: 'g.last_seen', order: 'desc' }, { column: 'g.id', order: 'desc' }]).limit(limit) as GroupRow[];

    const live = site.current_release_id
      ? await db('releases').where({ id: site.current_release_id }).first('id', 'number') as { id: number; number: number } | undefined
      : undefined;
    const sums = await db.raw(`
      SELECT g.release_number, MAX(g.release_id) AS release_id, COUNT(*) AS groups, COALESCE(SUM(g.count), 0) AS occurrences,
        COUNT(*) FILTER (WHERE g.level IN ('fatal', 'parse')) AS fatals, COUNT(*) FILTER (WHERE ${IS_NEW_SQL}) AS new_groups,
        MAX(g.last_seen) AS last_seen
      FROM site_error_groups g WHERE g.site_id = ? AND g.tenant_id = ?
      GROUP BY g.release_number ORDER BY g.release_number = 0, g.release_number DESC LIMIT 20`, [site.id, site.tenant_id]) as {
      rows: Array<{ release_number: number; release_id: number | null; groups: string | number; occurrences: string | number; fatals: string | number; new_groups: string | number; last_seen: Date | string }>;
    };
    const releases: SiteErrorReleaseSummary[] = sums.rows.map((r) => ({
      releaseId: r.release_id !== null ? Number(r.release_id) : null,
      releaseNumber: Number(r.release_number),
      groups: Number(r.groups),
      occurrences: Number(r.occurrences),
      fatals: Number(r.fatals),
      newGroups: Number(r.new_groups),
      lastSeen: iso(r.last_seen),
      live: !!live && Number(r.release_number) === Number(live.number),
    }));
    const collected = await db('site_error_cursors').where({ site_id: site.id }).max({ at: 'updated_at' }).first() as { at: Date | string | null } | undefined;
    return {
      siteId: site.id,
      liveReleaseId: live ? Number(live.id) : null,
      liveReleaseNumber: live ? Number(live.number) : null,
      releases,
      groups: rows.map(groupOf),
      total: Number(totalRow?.n ?? 0),
      collectedAt: collected?.at ? iso(collected.at) : null,
    };
  },

  async get(actor: HostingActor, siteId: number, groupId: number): Promise<SiteErrorGroupDetail> {
    const site = await loadSite(actor, siteId, 'read');
    if (!Number.isInteger(groupId) || groupId <= 0) throw new AppError(404, 'Error group not found', 'notFound');
    const row = await db('site_error_groups as g').where({ 'g.id': groupId, 'g.site_id': site.id, 'g.tenant_id': site.tenant_id })
      .first('g.*', db.raw(`${IS_NEW_SQL} AS is_new`)) as GroupRow | undefined;
    if (!row) throw new AppError(404, 'Error group not found', 'notFound');
    const others = await db('site_error_groups').where({ site_id: site.id, tenant_id: site.tenant_id, fingerprint: row.fingerprint })
      .whereNot({ id: row.id }).orderBy('release_number', 'desc').limit(20)
      .select('id', 'release_id', 'release_number', 'count', 'last_seen') as Array<{ id: number; release_id: number | null; release_number: number; count: number | string; last_seen: Date | string }>;
    return {
      ...groupOf(row),
      sample: row.sample,
      sampleAt: iso(row.sample_at),
      otherReleases: others.map((o) => ({
        groupId: Number(o.id), releaseId: o.release_id !== null ? Number(o.release_id) : null, releaseNumber: Number(o.release_number), count: Number(o.count), lastSeen: iso(o.last_seen),
      })),
    };
  },

  collectOnce,
  maintenance,

  /** Worker 'php-errors': collection every minute, retention every hour. Never throws. */
  start(): void {
    if (timer) return;
    const run = async () => {
      await collectOnce();
      if (Date.now() - lastMaintenance >= MAINTENANCE_EVERY_MS) {
        lastMaintenance = Date.now();
        try {
          const r = await maintenance();
          if (r.groups || r.switches || r.cursors) logger.info(r, 'PHP errors: retention');
        } catch (err) {
          logger.warn({ err }, 'PHP errors: retention failed');
        }
      }
    };
    first = setTimeout(() => { void run(); }, FIRST_COLLECT_DELAY_MS);
    first.unref?.();
    timer = setInterval(() => { void run(); }, COLLECT_INTERVAL_MS);
    timer.unref?.();
  },

  stop(): void {
    if (timer) clearInterval(timer);
    if (first) clearTimeout(first);
    timer = null;
    first = null;
  },
};

let timer: NodeJS.Timeout | null = null;
let first: NodeJS.Timeout | null = null;
let lastMaintenance = 0;
