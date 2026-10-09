import type Docker from 'dockerode';
import type { Socket } from 'socket.io';
import {
  LogSocketEvents, isMasterTenant, type ClientCapability, type LogLine, type LogLinesPayload, type LogSource,
} from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { engineFor } from '../docker/engine';
import { loadSite, type HostingActor } from '../hosting/access';
import { clientCapabilities, type SiteRow } from '../hosting/rows';
import { permissionService } from '../permission.service';
import { subscribeEdgeLog, type EdgeLogListener } from '../usage/edgeLog';
import { accessLineFromRecord, recordOf } from './accessLog';
import { LogDemuxer, listSiteContainers, logLineOf, streamOfSource, type SiteLogContainer } from './dockerLogs';
import { LOG_SOURCES } from './logs.service';

// ─────────────────────────────────────────────────────────────────────────────
// Live log tail over Socket.io (module cron-logs, docs/P2-PLAN.md §6.7, §9.7,
// invariant L1). Called by socket.ts for every authenticated connection
// (socket.data: userId, tenantId, role, kind, accountIds).
//   client → 'logs:subscribe' LogSubscribeRequest, ack { ok: boolean; error?: string; code?: string }
//   client → 'logs:unsubscribe' LogSubscribeRequest
//   server → 'LOG_LINES' LogLinesPayload, to THIS socket only (socket.emit, never a room).
// Access: the same rule as GET /api/sites/:id/logs (read on the site),
// checked at subscribe time with an actor rebuilt from the database for
// socket.data's user and tenant (identical to access.ts resolveActor: an
// inactive user, a revoked membership or a removed account link is seen
// now, not at connection time). At most 4 subscriptions per socket; lines
// batched every 250 ms, 200 per emit; streams closed on unsubscribe /
// disconnect. Docker absent ⇒ ack error, never a crash.
// ─────────────────────────────────────────────────────────────────────────────

type Ack = (r: AckResult) => void;

export interface SocketIdentity {
  userId?: unknown;
  tenantId?: unknown;
}

export interface LogTailDeps {
  /** Actor of the socket's user in its current tenant, null when the user may no longer act. */
  buildActor(data: SocketIdentity): Promise<HostingActor | null>;
  /** loadSite(actor, id, 'read'): 404 / 403 AppError. */
  loadSite(actor: HostingActor, siteId: number): Promise<SiteRow>;
  subscribeEdge(listener: EdgeLogListener): () => void;
  /** dockerode client of the site's node. */
  docker(site: SiteRow): Promise<Docker>;
  batchMs: number;
  maxLinesPerEmit: number;
  maxSubscriptions: number;
  /** Lines kept per subscription between two emits (oldest dropped beyond). */
  maxBuffered: number;
  /** Re-attach delay after a container log stream ended (container restarted…). */
  reattachMs: number;
}

/** Same actor as access.ts resolveActor, from a socket's user / tenant. */
export async function actorFromSocket(data: SocketIdentity): Promise<HostingActor | null> {
  const userId = Number(data.userId);
  const tenantId = Number(data.tenantId);
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(tenantId) || tenantId <= 0) return null;
  const user = await db('users').where({ id: userId }).first('kind', 'role', 'is_active') as
    { kind: string; role: string; is_active: boolean } | undefined;
  if (!user || !user.is_active) return null;
  if (user.kind === 'client') {
    const rows = await db('account_users as au')
      .join('hosting_accounts as a', 'a.id', 'au.account_id')
      .where('au.user_id', userId)
      .andWhere('a.tenant_id', tenantId)
      .select('au.account_id', 'au.capabilities') as Array<{ account_id: number; capabilities: unknown }>;
    const accounts = new Map<number, ReadonlySet<ClientCapability>>();
    for (const r of rows) accounts.set(Number(r.account_id), new Set(clientCapabilities(r.capabilities)));
    return { kind: 'client', userId, tenantId, accounts };
  }
  if (user.role === 'admin') return { kind: 'staff', userId, tenantId, globalView: isMasterTenant(tenantId), caps: '*' };
  const caps = new Set(await permissionService.listUserTenantCapabilities(userId, tenantId));
  return { kind: 'staff', userId, tenantId, globalView: false, caps };
}

const defaultDeps: LogTailDeps = {
  buildActor: actorFromSocket,
  loadSite: (actor, siteId) => loadSite(actor, siteId, 'read'),
  subscribeEdge: subscribeEdgeLog,
  async docker(site) {
    const a = await db('hosting_accounts').where({ id: site.account_id }).first('node_id') as { node_id: number } | undefined;
    if (!a) throw new AppError(404, 'Site not found', 'notFound');
    return engineFor(Number(a.node_id));
  },
  batchMs: 250,
  maxLinesPerEmit: 200,
  maxSubscriptions: 4,
  maxBuffered: 1000,
  reattachMs: 5000,
};

interface Subscription {
  siteId: number;
  source: LogSource;
  buffer: LogLine[];
  closers: Array<() => void>;
  closed: boolean;
  timer: NodeJS.Timeout | null;
}

type AckResult = { ok: boolean; error?: string; code?: string };

/** A subscribe being set up (awaits on the database / Docker), one per key at most. */
interface PendingSubscribe {
  result: Promise<AckResult>;
  /** An unsubscribe arrived meanwhile: the subscription is closed instead of registered. */
  cancelled: boolean;
}

/** Where a container stream (re)starts. */
interface FollowCursor {
  /** Docker `since` (unix seconds). */
  sinceSec: number;
  /** tsKey of the last line emitted for this container: lines at or before it are dropped (replay overlap). */
  afterKey: string | null;
  /** Docker `tail`: 0 on the first attach (live only), REATTACH_TAIL when catching up after an end. */
  tail: number;
}

/**
 * Lines replayed (at most) per container when its stream is re-attached
 * (container restarted / recreated): with tail 0 Docker returns no history
 * whatever `since` is, so the lines written while detached (boot errors of
 * the new container…) would be lost.
 */
export const REATTACH_TAIL = 1000;

/**
 * Sortable key of a Docker RFC 3339 nano timestamp ('' when unparsable):
 * epoch seconds, then the fraction padded to 9 digits (Docker trims trailing
 * zeros, so the raw strings do not sort).
 */
export function tsKey(at: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(at);
  if (!m) return '';
  const sec = Date.parse(`${m[1]}${m[3]}`) / 1000;
  if (!Number.isFinite(sec)) return '';
  return `${String(sec).padStart(12, '0')}.${(m[2] ?? '').padEnd(9, '0').slice(0, 9)}`;
}

function parseRequest(req: unknown): { siteId: number; source: LogSource } | { code: string; error: string } {
  const r = req as { siteId?: unknown; source?: unknown } | null;
  const siteId = Number(r?.siteId);
  if (!r || typeof r !== 'object' || !Number.isInteger(siteId) || siteId <= 0) return { code: 'notFound', error: 'Site not found' };
  if (typeof r.source !== 'string' || !(LOG_SOURCES as readonly string[]).includes(r.source)) {
    return { code: 'logSourceInvalid', error: 'Unknown log source (access, error or app)' };
  }
  return { siteId, source: r.source as LogSource };
}

export function registerLogSocketHandlers(socket: Socket, overrides: Partial<LogTailDeps> = {}): void {
  const deps: LogTailDeps = { ...defaultDeps, ...overrides };
  const subs = new Map<string, Subscription>();
  /**
   * Subscribes in flight, by key. A second subscribe of the same key joins
   * the first one (same ack) instead of opening its own streams, and counts
   * against the cap from the start: two back-to-back subscribes can never
   * open two sets of streams nor bypass maxSubscriptions.
   */
  const inflight = new Map<string, PendingSubscribe>();
  let gone = false;

  const keyOf = (siteId: number, source: LogSource) => `${siteId}:${source}`;

  /** Stops a subscription (registered or not). */
  const shut = (sub: Subscription) => {
    sub.closed = true;
    if (sub.timer) clearInterval(sub.timer);
    sub.timer = null;
    for (const c of sub.closers) {
      try { c(); } catch { /* already closed */ }
    }
    sub.closers = [];
    sub.buffer = [];
  };

  const close = (key: string) => {
    const sub = subs.get(key);
    if (!sub) return;
    subs.delete(key);
    shut(sub);
  };

  const push = (sub: Subscription, line: LogLine) => {
    if (sub.closed) return;
    sub.buffer.push(line);
    if (sub.buffer.length > deps.maxBuffered) sub.buffer.splice(0, sub.buffer.length - deps.maxBuffered);
  };

  const flush = (sub: Subscription) => {
    if (sub.closed || sub.buffer.length === 0) return;
    const lines = sub.buffer.splice(0, deps.maxLinesPerEmit);
    const payload: LogLinesPayload = { siteId: sub.siteId, source: sub.source, lines };
    socket.emit(LogSocketEvents.LINES, payload); // THIS socket only (L1)
  };

  /** Re-attaches a container stream after `delay` ms (backoff while it keeps failing), replaying from `cursor`. */
  const reattach = (sub: Subscription, docker: Docker, c: SiteLogContainer, cursor: FollowCursor, delay: number) => {
    if (sub.closed) return;
    const next: FollowCursor = { ...cursor, tail: REATTACH_TAIL };
    const cancel = () => clearTimeout(t);
    const t = setTimeout(() => {
      sub.closers = sub.closers.filter((f) => f !== cancel);
      follow(sub, docker, c, next, delay).catch((err) => {
        logger.debug({ err, container: c.name }, 'Log tail: re-attach failed');
        // Same cursor: the catch-up still starts after the last line emitted.
        reattach(sub, docker, c, next, Math.min(delay * 2, 60_000));
      });
    }, delay);
    sub.closers.push(cancel);
  };

  /**
   * Follows one container's stream (docker logs --follow --since --tail,
   * demuxed). Rejects when the stream cannot be opened; once open, an end
   * (container stopped / recreated) re-attaches while the subscription lives,
   * replaying from the last line emitted (lines already sent are dropped).
   */
  const follow = async (sub: Subscription, docker: Docker, c: SiteLogContainer, cursor: FollowCursor, delay = deps.reattachMs): Promise<void> => {
    const stream = streamOfSource(sub.source as 'error' | 'app');
    const res = await docker.getContainer(c.name).logs({
      follow: true, stdout: stream === 'stdout', stderr: stream === 'stderr', timestamps: true, since: cursor.sinceSec, tail: cursor.tail,
    } as never) as unknown as NodeJS.ReadableStream & { destroy?: () => void };
    if (sub.closed) {
      res.destroy?.();
      return;
    }
    let lastKey = cursor.afterKey;
    let lastSec = cursor.sinceSec;
    let sawData = false;
    const demux = new LogDemuxer((raw) => {
      if (raw.stream !== stream) return;
      const key = tsKey(raw.at);
      if (key) {
        if (lastKey && key <= lastKey) return; // already emitted (replay overlap)
        lastKey = key;
        const t = Date.parse(raw.at);
        if (!Number.isNaN(t)) lastSec = Math.floor(t / 1000);
      }
      push(sub, logLineOf(raw, c.role));
    }, c.tty);
    const destroy = () => res.destroy?.();
    sub.closers.push(destroy);
    res.on('data', (chunk: Buffer) => {
      sawData = true;
      demux.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    let ended = false;
    const onEnd = () => {
      if (ended) return;
      ended = true;
      demux.end();
      sub.closers = sub.closers.filter((f) => f !== destroy);
      // since = the second of the last line emitted (Docker's since is in whole seconds):
      // the lines of that second already sent are dropped thanks to afterKey.
      reattach(sub, docker, c, { sinceSec: lastSec, afterKey: lastKey, tail: REATTACH_TAIL },
        sawData ? deps.reattachMs : Math.min(delay * 2, 60_000));
    };
    res.on('end', onEnd);
    res.on('close', onEnd);
    res.on('error', onEnd);
  };

  /** Sets up one subscription; registers it unless the socket left or an unsubscribe arrived meanwhile. */
  const setUp = async (key: string, parsed: { siteId: number; source: LogSource }, pending: PendingSubscribe): Promise<AckResult> => {
    const disconnected: AckResult = { ok: false, error: 'Disconnected', code: 'disconnected' };
    const cancelled: AckResult = { ok: false, error: 'Unsubscribed meanwhile', code: 'cancelled' };
    let sub: Subscription | null = null;
    try {
      const actor = await deps.buildActor(socket.data as SocketIdentity);
      if (!actor) return { ok: false, error: 'Insufficient permissions', code: 'forbidden' };
      let site: SiteRow;
      try {
        site = await deps.loadSite(actor, parsed.siteId);
      } catch (err) {
        if (err instanceof AppError && err.statusCode === 403) return { ok: false, error: 'Insufficient permissions', code: 'forbidden' };
        if (err instanceof AppError && err.statusCode === 404) return { ok: false, error: 'Site not found', code: 'notFound' };
        throw err;
      }
      if (gone) return disconnected;
      if (pending.cancelled) return cancelled;

      sub = { siteId: site.id, source: parsed.source, buffer: [], closers: [], closed: false, timer: null };
      const s = sub;
      if (parsed.source === 'access') {
        const siteId = Number(site.id);
        const accountId = Number(site.account_id);
        const unsubscribe = deps.subscribeEdge((e) => {
          if (e.siteId !== siteId || e.accountId !== accountId) return;
          const rec = recordOf(e);
          if (rec) push(s, accessLineFromRecord(rec));
        });
        s.closers.push(unsubscribe);
      } else {
        let docker: Docker;
        let containers: SiteLogContainer[];
        try {
          docker = await deps.docker(site);
          containers = await listSiteContainers(docker, site.id, site.account_id);
        } catch (err) {
          logger.warn({ err, siteId: site.id }, 'Log tail: Docker unreachable');
          shut(s);
          return { ok: false, error: 'The container engine is unreachable', code: 'backendUnavailable' };
        }
        if (containers.length === 0) {
          shut(s);
          return { ok: false, error: 'The site has no container', code: 'siteNotRunning' };
        }
        const first: FollowCursor = { sinceSec: Math.floor(Date.now() / 1000), afterKey: null, tail: 0 };
        const results = await Promise.allSettled(containers.map((c) => follow(s, docker, c, first)));
        if (results.every((r) => r.status === 'rejected')) {
          shut(s);
          logger.warn({ siteId: site.id, err: (results[0] as PromiseRejectedResult).reason }, 'Log tail: cannot follow any container');
          return { ok: false, error: 'The container engine is unreachable', code: 'backendUnavailable' };
        }
        // Some containers followed: keep retrying the others (recreated meanwhile…).
        results.forEach((r, i) => { if (r.status === 'rejected') reattach(s, docker, containers[i], first, deps.reattachMs); });
      }
      // Re-checked after the awaits above: never register (nor leak) a subscription for a
      // socket that left, a key unsubscribed meanwhile, or a key already registered.
      if (gone || pending.cancelled || subs.has(key)) {
        shut(s);
        sub = null;
        if (gone) return disconnected;
        return pending.cancelled ? cancelled : { ok: true };
      }
      s.timer = setInterval(() => flush(s), deps.batchMs);
      s.timer.unref?.();
      subs.set(key, s);
      sub = null;
      return { ok: true };
    } catch (err) {
      logger.error({ err }, 'Log tail: subscribe failed');
      if (sub) shut(sub);
      return { ok: false, error: 'Internal error', code: 'internal' };
    }
  };

  socket.on(LogSocketEvents.SUBSCRIBE, (req: unknown, ack?: Ack) => {
    const reply: Ack = typeof ack === 'function' ? ack : () => undefined;
    const parsed = parseRequest(req);
    if ('code' in parsed) return reply({ ok: false, error: parsed.error, code: parsed.code });
    const key = keyOf(parsed.siteId, parsed.source);
    if (subs.has(key)) return reply({ ok: true });
    const joined = inflight.get(key);
    if (joined) {
      // The latest intent wins: a subscribe after an unsubscribe of a pending key revives it.
      if (!gone) joined.cancelled = false;
      void joined.result.then(reply);
      return undefined;
    }
    if (gone) return reply({ ok: false, error: 'Disconnected', code: 'disconnected' });
    if (subs.size + inflight.size >= deps.maxSubscriptions) {
      return reply({ ok: false, error: `At most ${deps.maxSubscriptions} live log subscriptions per connection`, code: 'tooManySubscriptions' });
    }
    const pending: PendingSubscribe = { result: Promise.resolve({ ok: false }), cancelled: false };
    inflight.set(key, pending);
    pending.result = setUp(key, parsed, pending).finally(() => { inflight.delete(key); });
    void pending.result.then(reply);
    return undefined;
  });

  socket.on(LogSocketEvents.UNSUBSCRIBE, (req: unknown, ack?: Ack) => {
    const parsed = parseRequest(req);
    if (!('code' in parsed)) {
      const key = keyOf(parsed.siteId, parsed.source);
      close(key);
      const p = inflight.get(key);
      if (p) p.cancelled = true; // honoured by setUp before it registers anything
    }
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('disconnect', () => {
    gone = true;
    for (const p of inflight.values()) p.cancelled = true;
    for (const key of [...subs.keys()]) close(key);
  });
  // socket.ts registers these handlers asynchronously: the socket may already be gone.
  if (socket.disconnected) gone = true;
}
