import { getSocket } from '@/socket/socketClient';

/** Answer of the apps socket handlers (server: services/apps/socketHandlers.ts). */
export interface SocketAck {
  ok: boolean;
  code?: string;
  error?: string;
  [k: string]: unknown;
}

/**
 * Emit an apps socket event and wait for its ack (rejects when the socket is
 * down or the server does not answer in time). OWNED BY MODULE `ui-apps`.
 */
export function emitWithAck<T extends SocketAck = SocketAck>(event: string, payload: unknown, timeoutMs = 10_000): Promise<T> {
  const socket = getSocket();
  if (!socket || !socket.connected) return Promise.reject(new Error('socketDisconnected'));
  return new Promise<T>((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (err: Error | null, res: T) => {
      if (err) reject(err);
      else resolve(res ?? ({ ok: false } as T));
    });
  });
}

/** Fire-and-forget emit (no-op when the socket is down). */
export function emitQuiet(event: string, payload: unknown): void {
  getSocket()?.emit(event, payload);
}
