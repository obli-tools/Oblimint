import type { Request, Response } from 'express';
import type { LogFileInfo, LogLine, LogQueryResult, LogSource } from '@oblimint/shared';
import { config } from '../../config';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { engineFor } from '../docker/engine';
import { actorReadsCode, loadSite, type HostingActor } from '../hosting/access';
import type { SiteRow } from '../hosting/rows';
import { platformSettings } from '../platformSettings';
import { subscribeEdgeLog } from '../usage/edgeLog';
import {
  existingSiteLogDir, isValidDay, parseStatusFilter, recordOf, utcDay, type AccessFilter,
} from './accessLog';
import { MAX_QUERY_LINES, filesInfo, listDayFiles, openDayStream, queryAccess } from './accessLogReader';
import { AccessLogWriter } from './accessLogWriter';
import { fetchContainerLogs, listSiteContainers, mergeByTime, streamOfSource, type SiteLogContainer } from './dockerLogs';

// ─────────────────────────────────────────────────────────────────────────────
// Site logs (module cron-logs, docs/P2-PLAN.md §6.7, §9.7, invariant L1).
//   access  edge access log, persisted per site and per UTC day by the writer
//           (subscribed to usage/edgeLog.ts at start), gzip of past days,
//           purge beyond usage.accessLogRetentionDays;
//   error   stderr of the site containers (primary, secondaries, preview);
//   app     stdout of the same containers.
// Every entry point loads the site with loadSite(actor, id, 'read') first
// (404 invisible / 403), then only touches THAT site's directory
// (<logsDir>/<site.account_id>/<site.id>) or containers (labels site AND
// account): no data of another site can come out.
// ─────────────────────────────────────────────────────────────────────────────

export interface LogQuery {
  source: LogSource;
  since?: string | null;
  until?: string | null;
  /** Substring filter (case-insensitive). */
  q?: string | null;
  /** Access log: status class or code ('5xx', '404'). */
  status?: string | null;
  /** 1 … 2000 (default 500). */
  limit?: number | null;
}

export const LOG_SOURCES: readonly LogSource[] = ['access', 'error', 'app'];
const DEFAULT_LIMIT = 500;
/** docker logs tail per container when a text filter is applied (lines examined). */
const FILTERED_TAIL = 5000;
/** Download of error / app (last 24 h): docker logs tail per container (memory bound of one download). */
export const DOWNLOAD_TAIL_PER_CONTAINER = 50_000;
const MAINTENANCE_EVERY_MS = 60 * 60_000;
const MAINTENANCE_FIRST_DELAY_MS = 30_000;

export function assertSource(s: unknown): LogSource {
  if (typeof s !== 'string' || !(LOG_SOURCES as readonly string[]).includes(s)) {
    throw new AppError(400, 'Unknown log source (access, error or app)', 'logSourceInvalid');
  }
  return s as LogSource;
}

/** ISO date / date-time → epoch ms (null when empty); 400 logDateInvalid otherwise. */
export function parseInstant(v: string | null | undefined, field: string): number | null {
  if (v === null || v === undefined || v === '') return null;
  const t = Date.parse(String(v));
  if (Number.isNaN(t)) throw new AppError(400, `Invalid date: ${field}`, 'logDateInvalid', { field });
  return t;
}

function backendUnavailable(err: unknown, siteId: number): AppError {
  logger.warn({ err, siteId }, 'Logs: Docker unreachable');
  return new AppError(502, 'The container engine is unreachable', 'backendUnavailable');
}

async function nodeOf(site: SiteRow): Promise<number> {
  const a = await db('hosting_accounts').where({ id: site.account_id }).first('node_id') as { node_id: number } | undefined;
  if (!a) throw new AppError(404, 'Site not found', 'notFound');
  return Number(a.node_id);
}

/** Root of the persisted access logs (config.hosting.logsDir). */
export function logsRoot(): string {
  return config.hosting.logsDir;
}

function siteDir(site: SiteRow): string | null {
  return existingSiteLogDir(logsRoot(), Number(site.account_id), Number(site.id));
}

/** Header-safe slug for the attachment name. */
function fileSlug(site: SiteRow): string {
  return String(site.slug || `site-${site.id}`).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 60) || String(site.id);
}

/** Docker client of the site's node and the site's containers (409 siteNotRunning when none, 502 when Docker is down). */
async function siteContainers(site: SiteRow, includePreview = false): Promise<{ docker: Awaited<ReturnType<typeof engineFor>>; containers: SiteLogContainer[] }> {
  let containers: SiteLogContainer[];
  let docker: Awaited<ReturnType<typeof engineFor>>;
  try {
    docker = await engineFor(await nodeOf(site));
    // Feature B (B12): the release preview container only for whoever reads the code.
    containers = await listSiteContainers(docker, site.id, site.account_id, includePreview);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw backendUnavailable(err, site.id);
  }
  if (containers.length === 0) throw new AppError(409, 'The site has no container', 'siteNotRunning');
  return { docker, containers };
}

/** Container logs of a site (error / app), filtered, merged by time, last `limit`. */
async function containerQuery(
  site: SiteRow, source: 'error' | 'app', o: { sinceMs: number | null; untilMs: number | null; q: string | null; limit: number; includePreview?: boolean },
): Promise<{ lines: LogLine[]; truncated: boolean }> {
  const { docker, containers } = await siteContainers(site, o.includePreview === true);
  const tail = o.q ? FILTERED_TAIL : o.limit;
  const stream = streamOfSource(source);
  let truncated = false;
  const groups: LogLine[][] = [];
  for (const c of containers) {
    let lines: LogLine[];
    try {
      lines = await fetchContainerLogs(docker, c, {
        stream,
        tail,
        ...(o.sinceMs !== null ? { since: Math.floor(o.sinceMs / 1000) } : {}),
        ...(o.untilMs !== null ? { until: Math.ceil(o.untilMs / 1000) } : {}),
      });
    } catch (err) {
      if ((err as { statusCode?: number })?.statusCode === 404) continue; // removed meanwhile
      throw backendUnavailable(err, site.id);
    }
    if (lines.length >= tail) truncated = true;
    const q = o.q;
    groups.push(lines.filter((l) => {
      if (q && !l.text.toLowerCase().includes(q)) return false;
      if (l.at) {
        const t = Date.parse(l.at);
        if (o.sinceMs !== null && t < o.sinceMs) return false;
        if (o.untilMs !== null && t > o.untilMs) return false;
      }
      return true;
    }));
  }
  const merged = mergeByTime(groups);
  if (merged.length > o.limit) truncated = true;
  return { lines: merged.slice(-o.limit), truncated };
}

// ── writer (worker) ──────────────────────────────────────────────────────────

let writer: AccessLogWriter | null = null;
let unsubscribe: (() => void) | null = null;
let maintenanceTimer: NodeJS.Timeout | null = null;
let firstMaintenance: NodeJS.Timeout | null = null;

async function runMaintenance(): Promise<void> {
  if (!writer) return;
  try {
    const { accessLogRetentionDays } = await platformSettings.section('usage');
    const r = await writer.maintenance(accessLogRetentionDays);
    if (r.gzipped || r.purged) logger.info(r, 'Access logs: maintenance');
  } catch (err) {
    logger.warn({ err }, 'Access logs: maintenance failed');
  }
}

export const logsService = {
  async query(actor: HostingActor, siteId: number, q: LogQuery): Promise<LogQueryResult> {
    const site = await loadSite(actor, siteId, 'read');
    const source = assertSource(q.source);
    const sinceMs = parseInstant(q.since, 'since');
    const untilMs = parseInstant(q.until, 'until');
    const limit = Math.min(MAX_QUERY_LINES, Math.max(1, Math.floor(Number(q.limit ?? DEFAULT_LIMIT)) || DEFAULT_LIMIT));
    const text = q.q ? String(q.q).toLowerCase().slice(0, 200) : null;

    if (source === 'access') {
      const status = parseStatusFilter(q.status);
      if (status === 'invalid') throw new AppError(400, 'Invalid status filter (e.g. 5xx, 404)', 'validation', { status: ['invalid'] });
      const filter: AccessFilter = { sinceMs, untilMs, q: text, status };
      const r = await queryAccess(siteDir(site), filter, limit);
      return { siteId: site.id, source, lines: r.lines, truncated: r.truncated };
    }
    const r = await containerQuery(site, source, { sinceMs, untilMs, q: text, limit, includePreview: actorReadsCode(actor, site) });
    return { siteId: site.id, source, lines: r.lines, truncated: r.truncated };
  },

  async files(actor: HostingActor, siteId: number): Promise<LogFileInfo[]> {
    const site = await loadSite(actor, siteId, 'read');
    return filesInfo(siteDir(site));
  },

  async download(_req: Request, res: Response, actor: HostingActor, siteId: number, source: LogSource, date: string | null): Promise<void> {
    const site = await loadSite(actor, siteId, 'read');
    const src = assertSource(source);
    const send = (name: string) => {
      res.status(200);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
    };

    if (src === 'access') {
      if (!isValidDay(date)) throw new AppError(400, 'A date YYYY-MM-DD is required', 'logDateInvalid', { field: 'date' });
      // Older (gzipped) part first, then today's plain file.
      const files = listDayFiles(siteDir(site)).filter((f) => f.day === date).sort((a, b) => Number(b.gz) - Number(a.gz));
      if (files.length === 0) throw new AppError(404, 'No access log for this day', 'notFound');
      send(`site-${fileSlug(site)}-access-${date}.log`);
      for (const f of files) {
        const stream = await openDayStream(f);
        await new Promise<void>((resolve, reject) => {
          // Client gone: stop reading (res 'close' = response finished or connection lost).
          const onClose = () => { stream.destroy(); resolve(); };
          res.once('close', onClose);
          stream.on('error', (err) => { res.off('close', onClose); reject(err); });
          stream.on('end', () => { res.off('close', onClose); resolve(); });
          stream.pipe(res, { end: false });
        }).catch((err) => {
          logger.warn({ err, siteId: site.id }, 'Access log download interrupted');
          res.destroy();
          throw err;
        });
        if (res.destroyed) return;
      }
      res.end();
      return;
    }

    if (date !== null && date !== undefined && date !== '' && !isValidDay(date)) {
      throw new AppError(400, 'Invalid date', 'logDateInvalid', { field: 'date' });
    }
    // Last 24 h, ONE container at a time (at most DOWNLOAD_TAIL_PER_CONTAINER lines each):
    // the memory held is one container's bounded tail, never every container at once.
    const now = Date.now();
    const sinceMs = now - 86_400_000;
    const { docker, containers } = await siteContainers(site, actorReadsCode(actor, site));
    const stream = streamOfSource(src);
    const write = async (s: string): Promise<boolean> => {
      if (res.destroyed) return false;
      if (!res.write(s)) {
        await new Promise<void>((resolve) => {
          const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
          res.once('drain', done);
          res.once('close', done);
        });
      }
      return !res.destroyed;
    };
    send(`site-${fileSlug(site)}-${src}-${utcDay(new Date(now))}.log`);
    for (const c of containers) {
      let lines: LogLine[];
      try {
        lines = await fetchContainerLogs(docker, c, { stream, since: Math.floor(sinceMs / 1000), tail: DOWNLOAD_TAIL_PER_CONTAINER });
      } catch (err) {
        if ((err as { statusCode?: number })?.statusCode === 404) continue; // removed meanwhile
        throw backendUnavailable(err, site.id);
      }
      if (lines.length >= DOWNLOAD_TAIL_PER_CONTAINER) {
        if (!(await write(`# [${c.role}] older lines omitted: last ${DOWNLOAD_TAIL_PER_CONTAINER} lines only\n`))) return;
      }
      for (const l of lines) {
        if (l.at && Date.parse(l.at) < sinceMs) continue; // Docker's since is in whole seconds
        if (!(await write(`${l.at} [${l.container ?? '?'}] ${l.text}\n`))) return;
      }
    }
    res.end();
  },

  /** Access log writer (subscribes to usage/edgeLog.ts) + daily retention purge. Never throws. */
  start(): void {
    if (writer) return;
    try {
      writer = new AccessLogWriter({ root: logsRoot() });
      writer.start();
      const w = writer;
      unsubscribe = subscribeEdgeLog((e) => {
        const rec = recordOf(e);
        if (rec) w.append(e.accountId as number, e.siteId as number, rec);
      });
      firstMaintenance = setTimeout(() => { void runMaintenance(); }, MAINTENANCE_FIRST_DELAY_MS);
      firstMaintenance.unref?.();
      maintenanceTimer = setInterval(() => { void runMaintenance(); }, MAINTENANCE_EVERY_MS);
      maintenanceTimer.unref?.();
    } catch (err) {
      logger.error({ err }, 'Access log writer failed to start');
    }
  },

  stop(): void {
    try { unsubscribe?.(); } catch { /* ignore */ }
    unsubscribe = null;
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    if (firstMaintenance) clearTimeout(firstMaintenance);
    maintenanceTimer = null;
    firstMaintenance = null;
    const w = writer;
    writer = null;
    if (w) void w.stop().catch((err) => logger.warn({ err }, 'Access log writer: stop failed'));
  },
};
