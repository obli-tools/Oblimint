import { useEffect, useRef } from 'react';
import { getSocket } from '@/socket/socketClient';
import { useSocketStore } from '@/store/socketStore';
import type { HostingSocketEventName } from '@oblimint/shared';

/**
 * Subscribes to a hosting Socket.io event (payloads carry ids only: the
 * handler refetches). The listener is removed on unmount and re-attached when
 * the socket (re)connects; the latest handler is always called.
 */
export function useHostingEvent<T>(event: HostingSocketEventName, handler: (payload: T) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  const status = useSocketStore((s) => s.status);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const fn = (payload: T) => ref.current(payload);
    socket.on(event, fn);
    return () => { socket.off(event, fn); };
  }, [event, status]);
}
