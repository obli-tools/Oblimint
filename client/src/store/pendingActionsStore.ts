import { useEffect } from 'react';
import { create } from 'zustand';
import type { PendingActionStatus, UserNotification } from '@oblimint/shared';
import { PendingActionSocketEvents, UserNotificationSocketEvents } from '@oblimint/shared';
import { pendingActionsApi } from '@/api/pendingActions.api';
import { getSocket } from '@/socket/socketClient';
import { dropReplay, hasReplay, takeReplay } from '@/utils/pendingApprovalGate';
import { useAuthStore } from './authStore';
import { useSocketStore } from './socketStore';
import { useTenantStore } from './tenantStore';

/**
 * Sensitive-action requests of the signed-in user: the « to handle » count
 * (sidebar badge) and a version bumped on every live change (the Approvals
 * page and the waiting modal reload on it). Fed by the API and the socket:
 * PENDING_ACTION_UPDATED (requester and decider) and the notifications of
 * the `approvals` family (a new request reaches its approvers that way).
 */

export interface PendingActionEvent {
  id: number;
  status: PendingActionStatus;
}

interface PendingActionsState {
  key: string | null;
  todo: number;
  version: number;
  lastEvent: PendingActionEvent | null;
  refresh: () => Promise<void>;
  reset: () => void;
}

export const usePendingActionsStore = create<PendingActionsState>((set, get) => ({
  key: null,
  todo: 0,
  version: 0,
  lastEvent: null,

  async refresh() {
    const key = get().key;
    if (!key) return;
    try {
      const todo = await pendingActionsApi.count();
      if (get().key === key) set({ todo });
    } catch { /* badge only */ }
  },

  reset() {
    set({ key: null, todo: 0, lastEvent: null });
  },
}));

/** A request this tab filed and kept for a later replay changed: offer it, or say why not. */
async function offerReplay(ev: PendingActionEvent): Promise<void> {
  if (!hasReplay(ev.id)) return;
  const toasts = await import('@/components/approvals/restrictionToast');
  if (ev.status === 'approved') {
    const run = takeReplay(ev.id);
    if (run) toasts.showApprovedReplay(ev.id, run);
  } else if (ev.status === 'denied' || ev.status === 'expired' || ev.status === 'cancelled' || ev.status === 'consumed') {
    dropReplay(ev.id);
    if (ev.status !== 'consumed') toasts.showRequestClosed(ev.id, ev.status);
  }
}

/** Keeps the store in sync with the user, the workspace and the socket. Mounted once (AppLayout). */
export function usePendingActionsLive(): void {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const tenantId = useTenantStore((s) => s.currentTenantId);
  const status = useSocketStore((s) => s.status);

  useEffect(() => {
    const key = userId && tenantId ? `${userId}:${tenantId}` : null;
    const st = usePendingActionsStore.getState();
    if (st.key !== key) {
      st.reset();
      usePendingActionsStore.setState({ key });
    }
    if (key) void usePendingActionsStore.getState().refresh();
  }, [userId, tenantId]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket || !userId || !tenantId) return;
    if (status === 'connected') void usePendingActionsStore.getState().refresh();
    let timer: number | undefined;
    const bump = () => {
      usePendingActionsStore.setState((s) => ({ version: s.version + 1 }));
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void usePendingActionsStore.getState().refresh(); }, 250);
    };
    const onUpdated = (payload: { pendingAction?: { id?: unknown; status?: unknown } }) => {
      const id = Number(payload?.pendingAction?.id);
      const st = payload?.pendingAction?.status;
      if (!Number.isInteger(id) || typeof st !== 'string') return;
      const ev: PendingActionEvent = { id, status: st as PendingActionStatus };
      usePendingActionsStore.setState({ lastEvent: ev });
      bump();
      void offerReplay(ev);
    };
    const onNotification = (payload: { notification?: UserNotification }) => {
      if (payload?.notification?.family === 'approvals') bump();
    };
    socket.on(PendingActionSocketEvents.UPDATED, onUpdated);
    socket.on(UserNotificationSocketEvents.NEW, onNotification);
    return () => {
      window.clearTimeout(timer);
      socket.off(PendingActionSocketEvents.UPDATED, onUpdated);
      socket.off(UserNotificationSocketEvents.NEW, onNotification);
    };
  }, [userId, tenantId, status]);
}
