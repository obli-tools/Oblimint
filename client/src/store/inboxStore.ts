import { useEffect } from 'react';
import { create } from 'zustand';
import type { UserNotification } from '@oblimint/shared';
import { UserNotificationSocketEvents } from '@oblimint/shared';
import { inboxApi } from '@/api/inbox.api';
import { getSocket } from '@/socket/socketClient';
import { useAuthStore } from './authStore';
import { useSocketStore } from './socketStore';
import { useTenantStore } from './tenantStore';

/**
 * Notification center of the signed-in user, current tenant: the latest
 * notifications (bell dropdown) and the unread count. Fed by the API and,
 * live, by the socket (room user:<id>: every tab of the user, whatever its
 * tenant — the events of another tenant are ignored here). Pages that list
 * more (NotificationsPage) refresh it after their own actions.
 */
const DROPDOWN_SIZE = 20;

interface InboxState {
  key: string | null;
  items: UserNotification[];
  unreadCount: number;
  loaded: boolean;
  /** Bumped on every change (socket / action): the full page refetches. */
  version: number;
  refresh: () => Promise<void>;
  markRead: (ids: number[]) => Promise<void>;
  markAllRead: () => Promise<void>;
  remove: (ids: number[]) => Promise<void>;
  reset: () => void;
}

export const useInboxStore = create<InboxState>((set, get) => ({
  key: null,
  items: [],
  unreadCount: 0,
  loaded: false,
  version: 0,

  async refresh() {
    try {
      const page = await inboxApi.list({ limit: DROPDOWN_SIZE });
      set((s) => ({ items: page.items, unreadCount: page.unreadCount, loaded: true, version: s.version + 1 }));
    } catch {
      set({ loaded: true });
    }
  },

  async markRead(ids) {
    const unread = ids.filter((id) => get().items.some((n) => n.id === id && !n.readAt));
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    set((s) => ({
      items: s.items.map((n) => (ids.includes(n.id) && !n.readAt ? { ...n, readAt: now } : n)),
      unreadCount: Math.max(0, s.unreadCount - unread.length),
    }));
    try {
      const r = await inboxApi.markRead(ids);
      set((s) => ({ unreadCount: r.unreadCount, version: s.version + 1 }));
    } catch {
      void get().refresh();
    }
  },

  async markAllRead() {
    const now = new Date().toISOString();
    set((s) => ({ items: s.items.map((n) => (n.readAt ? n : { ...n, readAt: now })), unreadCount: 0 }));
    try {
      await inboxApi.markAllRead();
      set((s) => ({ version: s.version + 1 }));
    } catch {
      void get().refresh();
    }
  },

  async remove(ids) {
    set((s) => ({ items: s.items.filter((n) => !ids.includes(n.id)) }));
    try {
      const r = await inboxApi.remove(ids);
      set((s) => ({ unreadCount: r.unreadCount, version: s.version + 1 }));
    } catch {
      void get().refresh();
    }
  },

  reset() {
    set({ key: null, items: [], unreadCount: 0, loaded: false });
  },
}));

/**
 * Keeps the store in sync with the current user + tenant and the socket.
 * Mounted once (the bell, in the header).
 */
export function useInboxLive(): void {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const tenantId = useTenantStore((s) => s.currentTenantId);
  const status = useSocketStore((s) => s.status);

  useEffect(() => {
    const key = userId && tenantId ? `${userId}:${tenantId}` : null;
    const st = useInboxStore.getState();
    if (st.key !== key) {
      st.reset();
      useInboxStore.setState({ key });
    }
    if (key) void useInboxStore.getState().refresh();
  }, [userId, tenantId]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket || !userId || !tenantId) return;
    // Reconnected: what was missed meanwhile.
    if (status === 'connected') void useInboxStore.getState().refresh();
    const onNew = (payload: { tenantId?: number; notification?: UserNotification }) => {
      if (payload?.tenantId !== tenantId || !payload.notification) return;
      const n = payload.notification;
      useInboxStore.setState((s) => (s.items.some((x) => x.id === n.id) ? s : {
        items: [n, ...s.items].slice(0, DROPDOWN_SIZE),
        unreadCount: s.unreadCount + (n.readAt ? 0 : 1),
        version: s.version + 1,
      }));
    };
    let timer: number | undefined;
    const onRead = (payload: { tenantId?: number }) => {
      if (payload?.tenantId !== tenantId) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void useInboxStore.getState().refresh(); }, 300);
    };
    socket.on(UserNotificationSocketEvents.NEW, onNew);
    socket.on(UserNotificationSocketEvents.READ, onRead);
    return () => {
      window.clearTimeout(timer);
      socket.off(UserNotificationSocketEvents.NEW, onNew);
      socket.off(UserNotificationSocketEvents.READ, onRead);
    };
  }, [userId, tenantId, status]);
}
