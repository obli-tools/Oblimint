import { config } from '../../config';
import { db } from '../../db';
import { logger } from '../../utils/logger';
import { engineFor, localNodeId } from '../docker/engine';
import { EDGE_CONTAINER } from '../hosting/naming';
import {
  STREAM_STDOUT, createDockerDemuxer, createLineSplitter, parseSinceParam, sinceParam, splitTimestamp,
} from './dockerStream';

// ─────────────────────────────────────────────────────────────────────────────
// Edge access log follower (module usage, docs/P2-PLAN.md §6.8 / §9.5).
// ONE follower of `docker logs --follow --timestamps` of oblimint-edge (JSON
// lines, contract §6.8), fanned out to subscribers: the traffic aggregator
// (usage) and the per-site access log writer / live tail (cron-logs).
//
//   - started with the first subscriber, stopped with the last one (and only
//     when the workers run: OBLIMINT_WORKERS=off = dev box without Docker);
//   - reconnects with backoff when the edge restarts / is missing;
//   - resumes after a panel restart from a checkpoint (app_config
//     `usage.edge_log_since`, Docker `since` format). The traffic collector
//     commits the checkpoint after each successful flush (commitEdgeLogCheckpoint):
//     a crash replays at most the unflushed minute instead of losing it. With
//     no collector (OBLIMINT_USAGE_COLLECTOR=off) the follower commits itself.
//   - a listener that throws is logged (rate-limited) and kept: listeners must
//     never break the follower; they must also be fast (buffer internally).
// ─────────────────────────────────────────────────────────────────────────────

/** One parsed edge access log line (fields of the edge log_format, plan §6.8). */
export interface EdgeLogEntry {
  /** ISO 8601. */
  time: string;
  host: string;
  remoteAddr: string;
  method: string;
  uri: string;
  status: number;
  /** body_bytes_sent */
  bytes: number;
  /** bytes_sent (headers included) — traffic out. */
  bytesOut: number;
  /** request_length — traffic in. */
  bytesIn: number;
  requestTime: number;
  upstream: string | null;
  upstreamStatus: string | null;
  userAgent: string;
  referer: string | null;
  /** $oblimint_site / $oblimint_account / $oblimint_tenant (null when the vhost has none: panel, default server). */
  siteId: number | null;
  accountId: number | null;
  tenantId: number | null;
  /** $oblimint_kind: site | secondary | preview | panel | placeholder | suspended | dbadmin | probe | redirect | default
   *  | mail | webmail (P4) | proxy | proxy-redirect | dead | stub | stream (P4b, docs/P4b-PLAN.md §8.7). */
  kind: string;
  // ── P4b (docs/P4b-PLAN.md §8.7) — null / '' with an older edge image ──
  /** $oblimint_host: proxy_hosts.id (kind proxy), proxy_redirections.id (proxy-redirect), proxy_dead_hosts.id (dead). */
  proxyHostId?: number | null;
  /** $oblimint_app: app_stacks.id of the location's target (sleep / wake activity, traffic per stack). */
  appStackId?: number | null;
  /** $oblimint_hp: 'path' (bait path hit) | 'acl' (refused by an IP access rule, ACL trap armed) | null. */
  honeypot?: 'path' | 'acl' | null;
  /** $upstream_response_time / $upstream_connect_time (s; the last value when several upstreams were tried). */
  upstreamResponseTime?: number | null;
  upstreamConnectTime?: number | null;
  /** $scheme */
  scheme?: 'http' | 'https' | null;
}

export type EdgeLogListener = (entry: EdgeLogEntry) => void;

// ── Parser (pure) ────────────────────────────────────────────────────────────

const MAX_FIELD = 4096;

function str(v: unknown, max = MAX_FIELD): string {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/** nginx writes '-' or '' for an absent value. */
function optStr(v: unknown, max = MAX_FIELD): string | null {
  const s = str(v, max);
  return s === '' || s === '-' ? null : s;
}

/** Non-negative integer from a JSON number or a numeric string, else 0. */
function count(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function seconds(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Last value of an nginx upstream timing list ("0.004, 0.120" or "0.004 : 0.120"
 * when several upstreams were tried); null for '-' / '' / garbage.
 */
function lastSeconds(v: unknown): number | null {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '';
  const parts = s.split(/[,:]/).map((p) => p.trim()).filter((p) => p && p !== '-');
  if (parts.length === 0) return null;
  const n = Number(parts[parts.length - 1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Positive integer id from a number or numeric string ($oblimint_* are strings, '' by default). */
function id(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,10}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 2_147_483_647 ? n : null;
}

/**
 * Parses one raw edge log line (pure; null when not a JSON access line).
 * Accepts an optional Docker `--timestamps` prefix. Tolerates an edge image
 * older than the P2 contract (no bytes_sent / request_length / site /
 * account / tenant / kind): bytesOut falls back to bytes, ids to null.
 */
export function parseEdgeLogLine(line: string): EdgeLogEntry | null {
  if (typeof line !== 'string') return null;
  let s = line.trim();
  if (!s) return null;
  if (s[0] !== '{') {
    s = splitTimestamp(s).rest.trim();
    if (s[0] !== '{') return null;
  }
  let o: unknown;
  try {
    o = JSON.parse(s);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const time = str(r.time, 64);
  const status = count(r.status);
  if (!time || status < 100 || status > 999) return null;
  const bytes = count(r.bytes);
  const siteId = id(r.site);
  const kindRaw = str(r.kind, 32);
  return {
    time,
    host: str(r.host, 255).toLowerCase(),
    remoteAddr: str(r.remote_addr, 64),
    method: str(r.method, 16),
    uri: str(r.uri),
    status,
    bytes,
    bytesOut: r.bytes_sent === undefined ? bytes : count(r.bytes_sent),
    bytesIn: count(r.request_length),
    requestTime: seconds(r.request_time),
    upstream: optStr(r.upstream, 255),
    upstreamStatus: optStr(r.upstream_status, 64),
    userAgent: str(r.user_agent, 1024),
    referer: optStr(r.referer, 2048),
    siteId,
    accountId: id(r.account),
    tenantId: id(r.tenant),
    kind: kindRaw || (siteId ? 'site' : 'default'),
    proxyHostId: id(r.ph),
    appStackId: id(r.app),
    honeypot: r.hp === 'path' || r.hp === 'acl' ? r.hp : null,
    upstreamResponseTime: lastSeconds(r.urt),
    upstreamConnectTime: lastSeconds(r.uct),
    scheme: r.scheme === 'http' || r.scheme === 'https' ? r.scheme : null,
  };
}

// ── Follower ─────────────────────────────────────────────────────────────────

export const EDGE_LOG_CHECKPOINT_KEY = 'usage.edge_log_since';
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_MISSING_MAX_MS = 60_000;
/** A connection that lived this long resets the backoff. */
const STABLE_MS = 60_000;
/** Self-commit of the checkpoint when nobody committed for this long (collector off). */
const SELF_COMMIT_AFTER_MS = 5 * 60_000;
const SELF_COMMIT_TICK_MS = 60_000;

const listeners = new Set<EdgeLogListener>();
let active = false;
let stream: (NodeJS.ReadableStream & { destroy?: () => void }) | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let commitTimer: NodeJS.Timeout | null = null;
let backoffMs = BACKOFF_MIN_MS;
/**
 * Follower generation, bumped by every start / stop. A connect() of an older
 * generation (still parked in an await, or whose stream ends after a restart)
 * never publishes its stream, never clears the current one and never
 * reconnects: at most ONE stream delivers lines (no double counting).
 */
let generation = 0;
/** Docker timestamp (ns) of the last line delivered. */
let position: bigint | null = null;
let lastCommitAt = Date.now();
let lastListenerErrorLog = 0;
let missingLogged = false;

/** Delivers one parsed entry to every listener (errors isolated). */
function deliver(entry: EdgeLogEntry): void {
  for (const l of [...listeners]) {
    try {
      l(entry);
    } catch (err) {
      const now = Date.now();
      if (now - lastListenerErrorLog > 60_000) {
        lastListenerErrorLog = now;
        logger.warn({ err }, 'Edge log listener failed (kept subscribed)');
      }
    }
  }
}

/**
 * Line handler of one connection: skips lines at or before the resume point
 * (Docker `since` is inclusive), advances the position, parses, delivers.
 */
export function createEdgeLineHandler(resumeAfter: bigint | null, onEntry: EdgeLogListener, onPosition: (ns: bigint) => void): (line: string) => void {
  return (line: string) => {
    const { ts, rest } = splitTimestamp(line);
    if (ts !== null) {
      if (resumeAfter !== null && ts <= resumeAfter) return;
      onPosition(ts);
    }
    const entry = parseEdgeLogLine(rest);
    if (entry) onEntry(entry);
  };
}

async function loadCheckpoint(): Promise<bigint | null> {
  try {
    const row = await db('app_config').where({ key: EDGE_LOG_CHECKPOINT_KEY }).first('value') as { value: string } | undefined;
    return parseSinceParam(row?.value);
  } catch (err) {
    logger.debug({ err }, 'Edge log checkpoint unreadable');
    return null;
  }
}

async function saveCheckpoint(ns: bigint): Promise<void> {
  await db('app_config').insert({ key: EDGE_LOG_CHECKPOINT_KEY, value: sinceParam(ns) }).onConflict('key').merge();
}

/** Current follower position (opaque, pass back to commitEdgeLogCheckpoint), null before the first line. */
export function edgeLogPosition(): bigint | null {
  return position;
}

/**
 * Persists a position as the resume point (traffic collector, after a
 * successful flush of everything delivered up to it). Never throws.
 */
export async function commitEdgeLogCheckpoint(pos: bigint | null): Promise<void> {
  lastCommitAt = Date.now();
  if (pos === null) return;
  try {
    await saveCheckpoint(pos);
  } catch (err) {
    logger.debug({ err }, 'Edge log checkpoint not saved');
  }
}

function scheduleReconnect(gen: number, stableFor: number, missing: boolean): void {
  if (!active || gen !== generation || retryTimer) return;
  if (stableFor >= STABLE_MS) backoffMs = BACKOFF_MIN_MS;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, missing ? BACKOFF_MISSING_MAX_MS : BACKOFF_MAX_MS);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect(gen);
  }, delay);
  retryTimer.unref?.();
}

async function connect(gen: number): Promise<void> {
  if (!active || gen !== generation || stream) return;
  const startedAt = Date.now();
  let missing = false;
  let s: (NodeJS.ReadableStream & { destroy?: () => void }) | null = null;
  try {
    const docker = await engineFor(await localNodeId());
    const container = docker.getContainer(EDGE_CONTAINER);
    const info = await container.inspect();
    const resumeAfter = position ?? await loadCheckpoint();
    // First start ever: from now (the edge's whole history is not this panel's traffic to replay).
    const since = resumeAfter !== null ? sinceParam(resumeAfter) : String(Math.floor(Date.now() / 1000));
    const opened = await container.logs({ follow: true, stdout: true, stderr: false, timestamps: true, since } as never) as unknown as
      NodeJS.ReadableStream & { destroy?: () => void };
    if (!active || gen !== generation || stream) {
      // Stopped / restarted while connecting: this connection is stale.
      try { opened.destroy?.(); } catch { /* closed */ }
      return;
    }
    s = opened;
    stream = s;
    missingLogged = false;
    const onLine = createEdgeLineHandler(resumeAfter, deliver, (ns) => { position = ns; });
    const lines = createLineSplitter(onLine);
    const demux = createDockerDemuxer((type, payload) => { if (type === STREAM_STDOUT) lines.push(payload); }, { tty: !!info?.Config?.Tty });
    logger.info({ since }, 'Following the edge access log');
    const live = s;
    await new Promise<void>((resolve) => {
      let done = false;
      const end = () => { if (!done) { done = true; resolve(); } };
      live.on('data', (chunk: Buffer | string) => {
        if (gen !== generation) return; // stale stream (destroy pending): never delivered twice
        try { demux.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); } catch (err) { logger.warn({ err }, 'Edge log chunk dropped'); }
      });
      live.on('end', end);
      live.on('close', end);
      live.on('error', (err) => { logger.debug({ err }, 'Edge log stream error'); end(); });
    });
    if (gen === generation) lines.flush();
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    missing = status === 404;
    if (gen === generation && !missingLogged) {
      logger.warn({ err: (err as Error)?.message ?? err }, missing ? 'Edge container not found: access log follower waiting' : 'Edge access log follower failed: retrying');
      missingLogged = true;
    }
  } finally {
    if (s !== null && stream === s) stream = null;
  }
  scheduleReconnect(gen, Date.now() - startedAt, missing);
}

function startFollower(): void {
  if (active) return;
  active = true;
  generation++;
  backoffMs = BACKOFF_MIN_MS;
  lastCommitAt = Date.now();
  commitTimer = setInterval(() => {
    if (Date.now() - lastCommitAt >= SELF_COMMIT_AFTER_MS) void commitEdgeLogCheckpoint(position);
  }, SELF_COMMIT_TICK_MS);
  commitTimer.unref?.();
  void connect(generation);
}

function stopFollower(): void {
  if (!active) return;
  active = false;
  generation++;
  if (retryTimer) clearTimeout(retryTimer);
  if (commitTimer) clearInterval(commitTimer);
  retryTimer = null;
  commitTimer = null;
  const s = stream;
  stream = null;
  try { s?.destroy?.(); } catch { /* closed */ }
  if (Date.now() - lastCommitAt >= SELF_COMMIT_AFTER_MS) void commitEdgeLogCheckpoint(position);
}

/** Subscribe to the parsed edge access log. Returns the unsubscribe function. Never throws. */
export function subscribeEdgeLog(listener: EdgeLogListener): () => void {
  listeners.add(listener);
  try {
    if (config.hosting.workersEnabled && !testMode) startFollower();
  } catch (err) {
    logger.warn({ err }, 'Edge log follower failed to start');
  }
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    listeners.delete(listener);
    if (listeners.size === 0) stopFollower();
  };
}

// ── Test seam ────────────────────────────────────────────────────────────────

let testMode = false;

/** Tests: no Docker follower; `emit` delivers raw lines (with or without a timestamp prefix) to the subscribers. */
export const edgeLogForTests = {
  enable(on: boolean): void {
    testMode = on;
    if (on) stopFollower();
  },
  emit(line: string): void {
    const { rest } = splitTimestamp(line);
    const entry = parseEdgeLogLine(rest);
    if (entry) deliver(entry);
  },
  listenerCount: (): number => listeners.size,
};
