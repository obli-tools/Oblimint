import type { Server as HttpServer } from 'http';
import type { Server as HttpsServer } from 'https';
import { Server as SocketIOServer } from 'socket.io';
import { db } from './db';
import { logger } from './utils/logger';
import { getSessionMiddleware } from './app';
import { config } from './config';
import { isForeignBrowserRequest } from './middleware/originGuard';
import { sessionPolicyRefusal } from './middleware/sessionUserGuard';
import { sessionRoom } from './utils/sessionHash';

let io: SocketIOServer | null = null;

/**
 * Socket.io, authenticated by the express session (httpOnly cookie) ONLY —
 * never by identifiers the client puts in `handshake.auth`. Rooms:
 * user:<id>, sess:<sha256(sid)>, tenant:<id>, tenant:<id>:admin, role:admin,
 * and for the P1 hosting events (services/hosting/events.ts):
 * tenant:<id>:staff (staff sessions) / account:<id> (client sessions of the
 * accounts they belong to — clients never join tenant-wide hosting rooms).
 */
export function createSocketServer(server: HttpServer | HttpsServer): SocketIOServer {
  io = new SocketIOServer(server, {
    // Same-origin in production. A foreign origin must never open a socket
    // with the victim's cookie: SameSite=Lax does not stop a same-SITE page
    // (previews and tenant domains under the panel's domain), so the Origin
    // of every handshake (polling and WebSocket upgrade) is checked against
    // the panel origin — the same rule as originGuard for the REST API.
    cors: { origin: config.clientOrigin, credentials: true },
    allowRequest: (req, callback) => {
      callback(null, !isForeignBrowserRequest(req));
    },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 1e6,
  });

  const sessionMw = getSessionMiddleware();
  if (sessionMw) io.engine.use(sessionMw as any);

  io.use(async (socket, next) => {
    try {
      const sess = (socket.request as any).session as { userId?: number; currentTenantId?: number; credVersion?: number } | undefined;
      const userId = sess?.userId;
      if (!userId) return next(new Error('Unauthorized'));
      // Credentials changed since sign-in, or force_2fa pending: no socket.
      const refusal = await sessionPolicyRefusal(sess);
      if (refusal) return next(new Error(refusal));
      const user = await db('users').where({ id: userId, is_active: true }).first('id', 'role', 'kind');
      if (!user) return next(new Error('Unauthorized'));
      const tenantId = sess?.currentTenantId ?? null;
      if (tenantId && user.role !== 'admin') {
        const member = await db('user_tenants').where({ user_id: user.id, tenant_id: tenantId }).first('user_id');
        if (!member) return next(new Error('Unauthorized — not a member of this tenant'));
      }
      socket.data.userId = Number(user.id);
      socket.data.role = String(user.role);
      socket.data.tenantId = tenantId ? Number(tenantId) : null;
      socket.data.kind = user.kind === 'client' ? 'client' : 'staff';
      socket.data.accountIds = [];
      if (socket.data.kind === 'client' && tenantId) {
        const rows = await db('account_users as au')
          .join('hosting_accounts as a', 'a.id', 'au.account_id')
          .where({ 'au.user_id': user.id, 'a.tenant_id': tenantId })
          .select('au.account_id') as Array<{ account_id: number }>;
        socket.data.accountIds = rows.map((r) => Number(r.account_id));
      }
      next();
    } catch (err) {
      logger.error(err, 'Socket auth error');
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    const { userId, tenantId, role, kind, accountIds } = socket.data as {
      userId: number; tenantId: number | null; role: string; kind: 'staff' | 'client'; accountIds: number[];
    };
    socket.join(`user:${userId}`);
    const sid = (socket.request as any).sessionID;
    if (typeof sid === 'string' && sid) socket.join(sessionRoom(sid));
    if (tenantId) {
      socket.join(`tenant:${tenantId}`);
      if (role === 'admin') socket.join(`tenant:${tenantId}:admin`);
      if (kind === 'staff') socket.join(`tenant:${tenantId}:staff`);
    }
    if (kind === 'client') for (const id of accountIds) socket.join(`account:${id}`);
    if (role === 'admin') socket.join('role:admin');
    // P2: per-socket handlers of the modules (cron-logs: live log tail).
    void import('./services/logs/socketHandlers')
      .then((m) => m.registerLogSocketHandlers(socket))
      .catch((err) => logger.error({ err }, 'Log socket handlers failed to register'));
    logger.debug({ userId, tenantId }, 'Socket connected');
  });

  return io;
}

/** The Socket.io server, or null before createSocketServer (setup mode, CLI). */
export function getIO(): SocketIOServer | null {
  return io;
}
