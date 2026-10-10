import crypto from 'crypto';
import type { Duplex } from 'stream';
import type Docker from 'dockerode';
import type { Socket } from 'socket.io';
import { AppSocketClientEvents, AppSocketServerEvents } from '@oblimint/shared';
import { db } from '../../db';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { appContainer } from '../hosting/naming';
import type { HostingActor } from '../hosting/access';
import { LogDemuxer, isoOfDockerTs } from '../logs/dockerLogs';
import { actorFromSocket, type SocketIdentity } from '../logs/socketHandlers';
import { platformSettings } from '../platformSettings';
import { loadStack } from './access';
import { accountPlan } from './context';
import { appsDeps } from './deps';
import { runningDeploymentLog } from './deployments';
import { clientLine, deployRoom } from './events';
import { appPolicyService } from './policy.service';
import { effectiveOf, type StackRow } from './rows';
import { json } from '../hosting/rows';

// ─────────────────────────────────────────────────────────────────────────────
// Socket.io handlers of the apps module (docs/P4b-PLAN.md §5.9). Every
// handler rebuilds the socket's actor from the database (inactive user,
// revoked membership seen now) and re-checks access on each event; refusals
// ack { ok: false, code }.
//   apps:deploy:subscribe   { deploymentId } → room app-deploy:<id> (staff)
//                            or app-deploy:<id>:client (A6-redacted), ack
//                            { ok, lines } with the backlog;
//   apps:logs:subscribe     { stackId, service, tail } → 'apps:logs:line'
//                            (follow, one stream per socket + service, 4 max);
//   apps:console:*          exec TTY in a service container: apps.console on
//                            the account ∧ settings consoleEnabled ∧ tenant
//                            allowConsole ∧ plan appsConsole (AP7); audited;
//                            30 min idle, 4 h at most; access re-checked
//                            every 30 s while open (revoked membership,
//                            suspended account, consoles disabled → closed);
//                            one console per user and service; only
//                            containers labelled with the stack.
// ─────────────────────────────────────────────────────────────────────────────

type Ack = (r: Record<string, unknown>) => void;

export const CONSOLE_IDLE_MS = 30 * 60_000;
/** Absolute lifetime of a console (typing never extends it). */
export const CONSOLE_MAX_MS = 4 * 60 * 60_000;
/** Access of an open console is re-validated this often (AP7, security audit P4b). */
export const CONSOLE_RECHECK_MS = 30_000;
const MAX_LOG_STREAMS = 4;
const MAX_LINES_PER_EMIT = 200;
const MAX_CONSOLE_INPUT = 64 * 1024;

export interface AppSocketDeps {
  buildActor(data: SocketIdentity): Promise<HostingActor | null>;
  loadStack(actor: HostingActor, id: number, need: 'read' | 'apps.console'): Promise<StackRow>;
  docker(stack: StackRow): Promise<Docker>;
  consoleAllowed(stack: StackRow): Promise<boolean>;
  audit(entry: { tenantId: number; userId: number; action: string; resourcePath: string; details: Record<string, unknown>; ip: string | null }): void;
}

const defaultDeps: AppSocketDeps = {
  buildActor: actorFromSocket,
  loadStack: async (actor, id, need) => await loadStack(actor, id, need) as StackRow,
  docker: (stack) => appsDeps().docker(stack.node_id),
  async consoleAllowed(stack) {
    const settings = await platformSettings.section('apps');
    const policy = await appPolicyService.effective(stack.tenant_id);
    const plan = await accountPlan(stack.account_id);
    return settings.consoleEnabled && policy.allowConsole && plan.limits.appsConsole === true && plan.status !== 'suspended' && plan.status !== 'deleting';
  },
  audit(e) {
    void auditService.log({ tenantId: e.tenantId, userId: e.userId, action: e.action, resourceType: 'app_stack', resourcePath: e.resourcePath, details: e.details, ipAddress: e.ip ?? undefined });
  },
};

let deps: AppSocketDeps = defaultDeps;

export function setAppSocketDepsForTests(d: Partial<AppSocketDeps> | null): void {
  deps = d ? { ...defaultDeps, ...d } : defaultDeps;
}

interface ConsoleSession {
  id: string;
  key: string;
  stream: Duplex;
  exec: Docker.Exec;
  socket: Socket;
  idle: NodeJS.Timeout | null;
  /** Re-validation of the access while open. */
  recheck: NodeJS.Timeout | null;
  identity: SocketIdentity;
  userId: number;
  stackId: number;
  accountId: number;
  openedAt: number;
  checking: boolean;
}

/** Consoles by session id, and by user + stack + service (one each). */
const consoles = new Map<string, ConsoleSession>();
const consoleByKey = new Map<string, string>();

function codeOf(err: unknown): string {
  if (err instanceof AppError) return err.code ?? (err.statusCode === 404 ? 'notFound' : err.statusCode === 403 ? 'forbidden' : 'error');
  return 'backendUnavailable';
}

function closeConsole(id: string, reason: string): void {
  const s = consoles.get(id);
  if (!s) return;
  consoles.delete(id);
  if (consoleByKey.get(s.key) === id) consoleByKey.delete(s.key);
  if (s.idle) clearTimeout(s.idle);
  if (s.recheck) clearInterval(s.recheck);
  try { s.stream.end(); s.stream.destroy(); } catch { /* closed */ }
  s.socket.emit(AppSocketServerEvents.CONSOLE_CLOSED, { sessionId: id, reason });
}

function touch(s: ConsoleSession): void {
  if (s.idle) clearTimeout(s.idle);
  s.idle = setTimeout(() => closeConsole(s.id, 'idle'), CONSOLE_IDLE_MS);
  s.idle.unref?.();
}

/**
 * Re-validates an open console with the same checks as apps:console:open (actor rebuilt from the database,
 * apps.console on the account, consoleEnabled ∧ allowConsole ∧ plan appsConsole ∧ account usable) and the
 * absolute lifetime. Fails closed: any refusal or error closes the session.
 */
export async function recheckConsole(id: string): Promise<boolean> {
  const s = consoles.get(id);
  if (!s) return false;
  if (s.checking) return true;
  if (Date.now() - s.openedAt >= CONSOLE_MAX_MS) { closeConsole(id, 'expired'); return false; }
  s.checking = true;
  try {
    const a = await deps.buildActor(s.identity);
    if (!a || a.userId !== s.userId) { closeConsole(id, 'revoked'); return false; }
    const stack = await deps.loadStack(a, s.stackId, 'apps.console');
    if (!(await deps.consoleAllowed(stack))) { closeConsole(id, 'revoked'); return false; }
    return consoles.has(id);
  } catch {
    closeConsole(id, 'revoked');
    return false;
  } finally {
    s.checking = false;
  }
}

/** Closes every open console of an account (suspension, deletion); returns how many were closed. */
export function closeAccountConsoles(accountId: number, reason = 'suspended'): number {
  let n = 0;
  for (const s of [...consoles.values()]) if (s.accountId === accountId) { closeConsole(s.id, reason); n++; }
  return n;
}

const positiveInt = (v: unknown): number | null => (Number.isInteger(v) && (v as number) > 0 ? v as number : null);
const serviceName = (v: unknown): string | null => (typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(v) ? v : null);

export function registerAppSocketHandlers(socket: Socket): void {
  const identity = (): SocketIdentity => ({ userId: socket.data.userId, tenantId: socket.data.tenantId });
  const actor = async (): Promise<HostingActor> => {
    const a = await deps.buildActor(identity());
    if (!a) throw new AppError(401, 'Authentication required', 'unauthorized');
    return a;
  };
  /**
   * Log follows of this socket, by stack:service. An entry is registered SYNCHRONOUSLY (placeholder, no
   * stream yet) before the first await of a subscribe, with a generation token: an unsubscribe, a newer
   * subscribe of the same key or the disconnect that lands during the awaits replaces / removes it, and the
   * subscribe then destroys the stream it obtained instead of registering it (no leaked Docker follow
   * connection nor interval). The placeholder also counts toward MAX_LOG_STREAMS.
   */
  const logStreams = new Map<string, { token: number; stream: NodeJS.ReadableStream | null; timer: NodeJS.Timeout | null }>();
  let logGeneration = 0;
  let disconnected = false;
  const joinedRooms = new Set<string>();

  // ── deploy output ──
  socket.on(AppSocketClientEvents.DEPLOY_SUBSCRIBE, async (payload: { deploymentId?: unknown }, ack?: Ack) => {
    const reply = typeof ack === 'function' ? ack : () => undefined;
    try {
      const deploymentId = positiveInt(payload?.deploymentId);
      if (!deploymentId) { reply({ ok: false, code: 'validation' }); return; }
      const a = await actor();
      const row = await db('app_deployments').where({ id: deploymentId }).first('id', 'stack_id', 'log') as { id: number; stack_id: number; log: unknown } | undefined;
      if (!row) { reply({ ok: false, code: 'deploymentNotFound' }); return; }
      await deps.loadStack(a, row.stack_id, 'read');
      const client = a.kind === 'client';
      const room = deployRoom(deploymentId, client);
      for (const r of [deployRoom(deploymentId, !client)]) socket.leave(r);
      socket.join(room);
      joinedRooms.add(room);
      const lines = runningDeploymentLog(deploymentId) ?? json<string[]>(row.log, []);
      reply({ ok: true, lines: client ? lines.map(clientLine) : lines });
    } catch (err) {
      reply({ ok: false, code: codeOf(err) });
    }
  });
  socket.on(AppSocketClientEvents.DEPLOY_UNSUBSCRIBE, (payload: { deploymentId?: unknown }) => {
    const id = positiveInt(payload?.deploymentId);
    if (!id) return;
    for (const room of [deployRoom(id, false), deployRoom(id, true)]) { socket.leave(room); joinedRooms.delete(room); }
  });

  // ── container log follow ──
  const destroyStream = (stream: NodeJS.ReadableStream | null) => {
    try { (stream as unknown as { destroy?: () => void } | null)?.destroy?.(); } catch { /* closed */ }
  };
  /** Stops the follow of `key` (only the generation `token` when given). */
  const stopLogs = (key: string, token?: number) => {
    const s = logStreams.get(key);
    if (!s || (token !== undefined && s.token !== token)) return;
    logStreams.delete(key);
    if (s.timer) clearInterval(s.timer);
    destroyStream(s.stream);
  };
  socket.on(AppSocketClientEvents.LOGS_SUBSCRIBE, async (payload: { stackId?: unknown; service?: unknown; tail?: unknown }, ack?: Ack) => {
    const reply = typeof ack === 'function' ? ack : () => undefined;
    let key: string | null = null;
    let token: number | null = null;
    try {
      const stackId = positiveInt(payload?.stackId);
      const service = serviceName(payload?.service);
      if (!stackId || !service) { reply({ ok: false, code: 'validation' }); return; }
      if (disconnected) return;
      key = `${stackId}:${service}`;
      stopLogs(key);
      if (logStreams.size >= MAX_LOG_STREAMS) { key = null; reply({ ok: false, code: 'tooManySubscriptions' }); return; }
      // Slot reserved before any await (see logStreams).
      token = ++logGeneration;
      logStreams.set(key, { token, stream: null, timer: null });
      const k = key;
      const t = token;
      const current = () => !disconnected && logStreams.get(k)?.token === t;
      const a = await actor();
      const stack = await deps.loadStack(a, stackId, 'read');
      if (!effectiveOf(stack)?.services.some((s) => s.name === service)) { stopLogs(k, t); reply({ ok: false, code: 'serviceNotFound' }); return; }
      if (!current()) { reply({ ok: false, code: 'cancelled' }); return; }
      const docker = await deps.docker(stack);
      const container = docker.getContainer(appContainer(stackId, service));
      const info = await container.inspect();
      if (!current()) { reply({ ok: false, code: 'cancelled' }); return; }
      // tail: 0 is honoured (the client already shows the REST backlog); absent / invalid → 100.
      const rawTail = Number(payload?.tail);
      const tail = Math.min(500, Math.max(0, payload?.tail !== undefined && Number.isFinite(rawTail) ? Math.floor(rawTail) : 100));
      const stream = await container.logs({ follow: true, stdout: true, stderr: true, timestamps: true, tail }) as unknown as NodeJS.ReadableStream;
      if (!current()) {
        // Unsubscribed, replaced or disconnected while Docker answered: never registered.
        destroyStream(stream);
        reply({ ok: false, code: 'cancelled' });
        return;
      }
      const buffer: Array<{ stackId: number; service: string; at: string | null; stream: 'stdout' | 'stderr'; text: string }> = [];
      const demux = new LogDemuxer((l) => {
        buffer.push({ stackId, service, at: isoOfDockerTs(l.at) || null, stream: l.stream, text: l.text });
        if (buffer.length > 1000) buffer.splice(0, buffer.length - 1000);
      }, !!info.Config?.Tty);
      const emitBuffered = () => {
        const batch = buffer.splice(0, MAX_LINES_PER_EMIT);
        for (const line of batch) socket.emit(AppSocketServerEvents.LOGS_LINE, line);
      };
      stream.on('data', (c: Buffer) => demux.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      // The container was stopped / recreated: last lines sent, then the follow is released.
      stream.on('end', () => {
        demux.end();
        if (logStreams.get(k)?.token === t) { while (buffer.length) emitBuffered(); }
        stopLogs(k, t);
      });
      stream.on('error', () => stopLogs(k, t));
      const timer = setInterval(emitBuffered, 250);
      timer.unref?.();
      logStreams.set(k, { token: t, stream, timer });
      reply({ ok: true });
    } catch (err) {
      if (key !== null && token !== null) stopLogs(key, token);
      reply({ ok: false, code: codeOf(err) });
    }
  });
  socket.on(AppSocketClientEvents.LOGS_UNSUBSCRIBE, (payload: { stackId?: unknown; service?: unknown }) => {
    const stackId = positiveInt(payload?.stackId);
    const service = serviceName(payload?.service);
    if (stackId && service) stopLogs(`${stackId}:${service}`);
  });

  // ── console ──
  socket.on(AppSocketClientEvents.CONSOLE_OPEN, async (payload: { stackId?: unknown; service?: unknown; cols?: unknown; rows?: unknown }, ack?: Ack) => {
    const reply = typeof ack === 'function' ? ack : () => undefined;
    try {
      const stackId = positiveInt(payload?.stackId);
      const service = serviceName(payload?.service);
      if (!stackId || !service) { reply({ ok: false, code: 'validation' }); return; }
      const a = await actor();
      const stack = await deps.loadStack(a, stackId, 'apps.console');
      if (!(await deps.consoleAllowed(stack))) { reply({ ok: false, code: 'consoleDisabled' }); return; }
      if (!effectiveOf(stack)?.services.some((s) => s.name === service)) { reply({ ok: false, code: 'serviceNotFound' }); return; }
      const docker = await deps.docker(stack);
      const name = appContainer(stackId, service);
      const container = docker.getContainer(name);
      const info = await container.inspect();
      // AP7: only a container of THIS stack (labels checked, never a platform / other account container).
      const labels = info.Config?.Labels ?? {};
      if (labels['oblimint.app'] !== String(stackId) || labels['oblimint.role'] !== 'app' || labels['oblimint.account'] !== String(stack.account_id)) {
        reply({ ok: false, code: 'serviceNotFound' });
        return;
      }
      if (!info.State?.Running) { reply({ ok: false, code: 'containerNotRunning' }); return; }
      const key = `${a.userId}:${stackId}:${service}`;
      const previous = consoleByKey.get(key);
      if (previous) closeConsole(previous, 'replaced');
      const exec = await container.exec({
        Cmd: ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'],
        AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true,
        Env: ['TERM=xterm-256color'],
      });
      const stream = await exec.start({ hijack: true, stdin: true, Tty: true }) as unknown as Duplex;
      const id = crypto.randomUUID();
      const session: ConsoleSession = {
        id, key, stream, exec, socket, idle: null, recheck: null, identity: identity(), userId: a.userId, stackId, accountId: stack.account_id,
        openedAt: Date.now(), checking: false,
      };
      consoles.set(id, session);
      consoleByKey.set(key, id);
      touch(session);
      session.recheck = setInterval(() => { void recheckConsole(id); }, CONSOLE_RECHECK_MS);
      session.recheck.unref?.();
      stream.on('data', (chunk: Buffer) => socket.emit(AppSocketServerEvents.CONSOLE_DATA, { sessionId: id, data: chunk.toString('utf8') }));
      stream.on('end', () => closeConsole(id, 'exited'));
      stream.on('error', () => closeConsole(id, 'error'));
      const cols = Math.min(500, Math.max(10, Number(payload?.cols) || 80));
      const rows = Math.min(200, Math.max(5, Number(payload?.rows) || 24));
      await exec.resize({ h: rows, w: cols }).catch(() => undefined);
      deps.audit({
        tenantId: stack.tenant_id, userId: a.userId, action: 'apps.console.open', resourcePath: String(stackId), details: { service },
        ip: (socket.handshake?.address as string | undefined) ?? null,
      });
      reply({ ok: true, sessionId: id });
    } catch (err) {
      if (!(err instanceof AppError)) logger.warn({ err: (err as Error)?.message }, 'apps: console open failed');
      reply({ ok: false, code: codeOf(err) });
    }
  });
  const own = (sessionId: unknown): ConsoleSession | null => {
    const s = typeof sessionId === 'string' ? consoles.get(sessionId) : undefined;
    return s && s.socket === socket ? s : null;
  };
  socket.on(AppSocketClientEvents.CONSOLE_INPUT, (payload: { sessionId?: unknown; data?: unknown }) => {
    const s = own(payload?.sessionId);
    if (!s || typeof payload?.data !== 'string' || payload.data.length > MAX_CONSOLE_INPUT) return;
    touch(s);
    try { s.stream.write(payload.data); } catch { closeConsole(s.id, 'error'); }
  });
  socket.on(AppSocketClientEvents.CONSOLE_RESIZE, (payload: { sessionId?: unknown; cols?: unknown; rows?: unknown }) => {
    const s = own(payload?.sessionId);
    if (!s) return;
    const cols = Math.min(500, Math.max(10, Number(payload?.cols) || 80));
    const rows = Math.min(200, Math.max(5, Number(payload?.rows) || 24));
    void s.exec.resize({ h: rows, w: cols }).catch(() => undefined);
  });
  socket.on(AppSocketClientEvents.CONSOLE_CLOSE, (payload: { sessionId?: unknown }) => {
    const s = own(payload?.sessionId);
    if (s) closeConsole(s.id, 'closed');
  });

  socket.on('disconnect', () => {
    disconnected = true;
    for (const key of [...logStreams.keys()]) stopLogs(key);
    for (const s of [...consoles.values()]) if (s.socket === socket) closeConsole(s.id, 'disconnected');
  });
}

/** Tests: open console sessions. */
export function openConsoleCount(): number {
  return consoles.size;
}
