import { useEffect } from 'react';
import { create } from 'zustand';
import { HostingSocketEvents, type ClientCapability, type HostingMe } from '@oblimint/shared';
import { hostingApi } from '@/api/hosting.api';
import { getSocket } from '@/socket/socketClient';
import { useAuthStore } from './authStore';
import { useSocketStore } from './socketStore';
import { useTenantStore } from './tenantStore';

/**
 * What the caller may do in the hosting area (GET /api/hosting/me), shared
 * by the hosting and sites UI modules. Mirrors server/src/services/hosting/
 * access.ts — the SERVER stays the authority: this only hides buttons.
 */
export type HostingNeed =
  | 'read' | 'plans.manage' | 'accounts.manage' | 'sites.manage' | 'domains.manage' | 'files.manage'
  | 'releases.publish' | 'releases.approve'
  // P2: cron → sites.manage, allow-list → files.manage, logs / usage → read.
  | 'databases.manage' | 'dns.manage'
  // P4: mail (domains, mailboxes, aliases, DKIM, relay, webmail SSO).
  | 'mail.manage';

const STAFF_CAPS: Record<HostingNeed, string[]> = {
  read: ['overview.read', 'accounts.manage', 'sites.manage', 'domains.manage', 'files.manage', 'plans.manage', 'databases.manage', 'dns.manage', 'mail.manage'],
  'plans.manage': ['plans.manage'],
  'accounts.manage': ['accounts.manage'],
  'sites.manage': ['sites.manage'],
  'domains.manage': ['domains.manage'],
  'files.manage': ['files.manage'],
  'releases.publish': ['sites.manage'],
  'releases.approve': ['sites.manage'],
  'databases.manage': ['databases.manage'],
  'dns.manage': ['dns.manage'],
  'mail.manage': ['mail.manage'],
};

const CLIENT_CAP: Record<HostingNeed, ClientCapability | 'member' | null> = {
  read: 'member',
  'plans.manage': null,
  'accounts.manage': null,
  'sites.manage': 'sites.manage',
  'domains.manage': 'domains.manage',
  'files.manage': 'files.manage',
  'releases.publish': 'releases.publish',
  'releases.approve': 'releases.approve',
  'databases.manage': 'databases.manage',
  'dns.manage': 'dns.manage',
  'mail.manage': 'mail.manage',
};

/** Pure check (exported for tests / non-hook callers). accountId omitted = "on some account". */
export function hostingCan(me: HostingMe | null, need: HostingNeed, accountId?: number | null): boolean {
  if (!me) return false;
  if (me.kind === 'staff') {
    if (me.staffCapabilities === '*') return true;
    const caps = me.staffCapabilities;
    return STAFF_CAPS[need].some((c) => caps.includes(c));
  }
  const required = CLIENT_CAP[need];
  if (required === null) return false;
  const entries = accountId != null ? [me.accounts[accountId]].filter(Boolean) : Object.values(me.accounts);
  return entries.some((caps) => required === 'member' || caps!.includes(required));
}

interface HostingState {
  me: HostingMe | null;
  /** User the `me` was fetched for (a logout / another login drops it). */
  userId: number | null;
  /** Tenant the `me` was fetched for (refetched on a tenant switch). */
  tenantId: number | null;
  loading: boolean;
  /** Time of the last successful fetch (focus refetch throttle). */
  fetchedAt: number;
  fetchMe: (force?: boolean) => Promise<void>;
  reset: () => void;
}

/**
 * Bumped by reset(): an answer of a request started before a reset (logout,
 * another user, tenant switch) is dropped instead of installing the previous
 * user's capabilities.
 */
let generation = 0;
/** User + tenant of the request in flight (a request for another key supersedes it). */
let pendingKey: string | null = null;

/** Pure: is the cached `me` usable for this user + tenant? (exported for tests). */
export function hostingMeFresh(
  state: { me: HostingMe | null; userId: number | null; tenantId: number | null },
  userId: number | null,
  tenantId: number | null,
): boolean {
  return state.me !== null && userId !== null && state.userId === userId && state.tenantId === tenantId;
}

export const useHostingStore = create<HostingState>((set, get) => ({
  me: null,
  userId: null,
  tenantId: null,
  loading: false,
  fetchedAt: 0,

  fetchMe: async (force = false) => {
    const userId = useAuthStore.getState().user?.id ?? null;
    const tenantId = useTenantStore.getState().currentTenantId;
    if (userId === null) return;
    if (!force && hostingMeFresh(get(), userId, tenantId)) return;
    const key = `${userId}:${tenantId}`;
    if (get().loading && pendingKey === key) return;
    // A request for another user / tenant still running is superseded: its
    // answer is dropped (generation) so it cannot overwrite this one.
    const gen = ++generation;
    pendingKey = key;
    set({ loading: true });
    try {
      const me = await hostingApi.me();
      if (gen !== generation) return;
      set({ me, userId, tenantId, loading: false, fetchedAt: Date.now() });
    } catch {
      if (gen !== generation) return;
      // A failed background refresh keeps the current answer of this same
      // user + tenant; otherwise nothing is known: no capability.
      if (hostingMeFresh(get(), userId, tenantId)) set({ loading: false });
      else set({ me: null, userId, tenantId, loading: false });
    } finally {
      if (gen === generation) pendingKey = null;
    }
  },

  reset: () => {
    generation += 1;
    pendingKey = null;
    set({ me: null, userId: null, tenantId: null, loading: false, fetchedAt: 0 });
  },
}));

// Another user on this tab (logout, then a login without a page reload): the
// previous user's capabilities must never be reused, even for a render.
useAuthStore.subscribe((s, prev) => {
  if ((s.user?.id ?? null) !== (prev.user?.id ?? null)) useHostingStore.getState().reset();
});

/** Min. delay between two focus-triggered refetches of /hosting/me. */
const FOCUS_REFETCH_MS = 30_000;

/**
 * Membership / capability changes (staff attaches the client to another
 * account, edits its capabilities): refetched on window focus (a client is
 * not in the room of an account it just joined) and on HOSTING_CHANGED for
 * an account. One listener set for the whole app, whatever the hook count.
 */
let refreshListeners = 0;
let detachRefresh: (() => void) | null = null;

function attachRefresh(): () => void {
  const onFocus = () => {
    const st = useHostingStore.getState();
    if (st.me && Date.now() - st.fetchedAt >= FOCUS_REFETCH_MS) void st.fetchMe(true);
  };
  window.addEventListener('focus', onFocus);
  let timer: number | undefined;
  const onChanged = (payload: unknown) => {
    if ((payload as { entity?: string } | null)?.entity !== 'account') return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { void useHostingStore.getState().fetchMe(true); }, 1000);
  };
  let socket: ReturnType<typeof getSocket> = null;
  const bindSocket = () => {
    const next = getSocket();
    if (next === socket) return;
    socket?.off(HostingSocketEvents.HOSTING_CHANGED, onChanged);
    socket = next;
    socket?.on(HostingSocketEvents.HOSTING_CHANGED, onChanged);
  };
  bindSocket();
  const unsubSocket = useSocketStore.subscribe(bindSocket);
  return () => {
    window.removeEventListener('focus', onFocus);
    window.clearTimeout(timer);
    unsubSocket();
    socket?.off(HostingSocketEvents.HOSTING_CHANGED, onChanged);
    socket = null;
  };
}

/** Hook: fetches /hosting/me once per user + tenant; returns it and a `can` helper. */
export function useHostingMe(): { me: HostingMe | null; loading: boolean; can: (need: HostingNeed, accountId?: number | null) => boolean } {
  const storedMe = useHostingStore((s) => s.me);
  const loading = useHostingStore((s) => s.loading);
  const fetchedFor = useHostingStore((s) => s.tenantId);
  const fetchedUser = useHostingStore((s) => s.userId);
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const fresh = hostingMeFresh({ me: storedMe, userId: fetchedUser, tenantId: fetchedFor }, userId, currentTenantId);
  // A `me` of another user / tenant is never exposed while the refetch runs.
  const me = fresh ? storedMe : null;

  useEffect(() => {
    if (userId !== null && !fresh) void useHostingStore.getState().fetchMe(true);
  }, [fresh, userId, currentTenantId]);

  useEffect(() => {
    if (refreshListeners++ === 0) detachRefresh = attachRefresh();
    return () => {
      if (--refreshListeners === 0) { detachRefresh?.(); detachRefresh = null; }
    };
  }, []);

  return { me, loading, can: (need, accountId) => hostingCan(me, need, accountId) };
}
