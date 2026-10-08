import type { Server as HttpServer } from 'http';
import type { Server as HttpsServer } from 'https';
import { Server as SocketIOServer } from 'socket.io';
import { db } from './db';
import { logger } from './utils/logger';
import { getSessionMiddleware } from './app';
import { sessionRoom } from './utils/sessionHash';

let io: SocketIOServer | null = null;

/**
 * Socket.io, authenticated by the express session (httpOnly cookie) ONLY —
 * never by identifiers the client puts in `handshake.auth`. Rooms:
 * user:<id>, sess:<sha256(sid)>, tenant:<id>, tenant:<id>:admin, role:admin.
 * Used in P0 for the header connection status; events come in P1+.
 */
export function createSocketServer(server: HttpServer | HttpsServer): SocketIOServer {
  io = new SocketIOServer(server, {
    // Same-origin in production; WebSocket upgrades always send Origin —
    // auth is enforced by the session check below, not by CORS.
    cors: { origin: true, credentials: true },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 1e6,
  });

  const sessionMw = getSessionMiddleware();
  if (sessionMw) io.engine.use(sessionMw as any);

  io.use(async (socket, next) => {
    try {
      const sess = (socket.request as any).session as { userId?: number; currentTenantId?: number } | undefined;
      const userId = sess?.userId;
      if (!userId) return next(new Error('Unauthorized'));
      const user = await db('users').where({ id: userId, is_active: true }).first('id', 'role');
      if (!user) return next(new Error('Unauthorized'));
      const tenantId = sess?.currentTenantId ?? null;
      if (tenantId && user.role !== 'admin') {
        const member = await db('user_tenants').where({ user_id: user.id, tenant_id: tenantId }).first('user_id');
        if (!member) return next(new Error('Unauthorized — not a member of this tenant'));
      }
      socket.data.userId = Number(user.id);
      socket.data.role = String(user.role);
      socket.data.tenantId = tenantId ? Number(tenantId) : null;
      next();
    } catch (err) {
      logger.error(err, 'Socket auth error');
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    const { userId, tenantId, role } = socket.data as { userId: number; tenantId: number | null; role: string };
    socket.join(`user:${userId}`);
    const sid = (socket.request as any).sessionID;
    if (typeof sid === 'string' && sid) socket.join(sessionRoom(sid));
    if (tenantId) {
      socket.join(`tenant:${tenantId}`);
      if (role === 'admin') socket.join(`tenant:${tenantId}:admin`);
    }
    if (role === 'admin') socket.join('role:admin');
    logger.debug({ userId, tenantId }, 'Socket connected');
  });

  return io;
}

/** The Socket.io server, or null before createSocketServer (setup mode, CLI). */
export function getIO(): SocketIOServer | null {
  return io;
}
